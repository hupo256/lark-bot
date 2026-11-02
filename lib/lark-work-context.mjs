/**
 * Lark Worker 的任务路由层：把任务归一成安全项目号，并决定 worker 在哪个仓/目录干活
 * （命中已有 worktree / 临时 worktree / 主仓只读）。safeProject 是 path-injection 的安全边界。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { prdCacheRoot, repoRoot, tempWorktreeDir, worktreesDir } from './lark-worker-env.mjs'
import { DAILY_COMMAND_TYPE } from './lark-daily-schedule.mjs'
import { larkRuntimeDir } from './lark-paths.mjs'
import { isReadOnlyTask, resolveCommandType } from './lark-message.mjs'
import { OPS_COMMAND_TYPE } from './lark-ops-task.mjs'
import { isProjectId } from './lark-project-id.mjs'

// 归一并校验项目号：仅接受 PR-#### / PM-#### 形态（大写）。project 会拼进 worktree 路径与
// hotfix 分支名，恶意/异常值（如 bug 表「项目ID」列填 ../../x）必须被挡在外面，否则会越出 worktree 根目录。
// 复用 lark-project-id.mjs 的 isProjectId（整串校验的唯一正则来源），避免两条链路各自维护一份
// PROJECT_ID_RE 对同一字符串判出不同结果。
export const safeProject = (raw) => {
  const value = String(raw || '').trim().toUpperCase()
  return isProjectId(value) ? value : ''
}

// 项目文档只来自 PRD 缓存（prd-to-commit 落盘处）：fetch-prd 落盘为 <prdCacheRoot>/<ID>/r<rev>/prd.md，同一 PRD 改版会多出
// 新的 r<rev>，取 rev 数值最大且含 prd.md 的那份；用户直接贴正文的落在 manual/prd.md（没有 r<rev> 时才用）。
// 需求清单 checklist.md 与计划 plan.md 在 <ID>/ 根下，存在就一并列出。
const latestRevisionDir = (projectDir) => {
  let entries = []
  try {
    entries = readdirSync(projectDir, { withFileTypes: true })
  } catch {
    return null
  }
  const revisions = entries
    .filter((entry) => entry.isDirectory() && /^r\d+$/.test(entry.name) && existsSync(join(projectDir, entry.name, 'prd.md')))
    .map((entry) => ({ dir: join(projectDir, entry.name), rev: Number(entry.name.slice(1)) }))
    .sort((a, b) => b.rev - a.rev)
  return revisions[0]?.dir || null
}

export const prdCacheDocsFor = (projectId, { cacheRoot = prdCacheRoot } = {}) => {
  if (!projectId || !cacheRoot) return []
  const projectDir = join(cacheRoot, projectId)
  if (!existsSync(projectDir)) return []
  const revisionDir = latestRevisionDir(projectDir)
  const prd = revisionDir ? join(revisionDir, 'prd.md') : join(projectDir, 'manual/prd.md')
  return [prd, join(projectDir, 'checklist.md'), join(projectDir, 'plan.md')].filter((path) => existsSync(path))
}

// PRD 缓存是线索不是真相（《8 个卡点》§7）：给每个缓存文件标抓取时间，超过 maxAgeDays 提醒以现抓为准。
// 只标不拦——PRD 多数时候不常改，过期也比没有强；正文带 Lark 链接时 Worker 会现抓到「Lark 文档」那一节。
export const PRD_CACHE_MAX_AGE_DAYS = 7
export const describePrdCacheDoc = (path, { now = Date.now(), maxAgeDays = PRD_CACHE_MAX_AGE_DAYS, stat = statSync } = {}) => {
  let mtimeMs
  try {
    mtimeMs = stat(path).mtimeMs
  } catch {
    return path
  }
  const days = Math.max(0, Math.floor((now - mtimeMs) / 86_400_000))
  const age = days === 0 ? '今天' : `${days} 天前`
  return days > maxAgeDays
    ? `${path}（PRD 缓存，抓取于 ${age}，可能已过期：与 Worker 现抓的 Lark 文档或代码现状冲突时以现抓 / 现状为准）`
    : `${path}（PRD 缓存，抓取于 ${age}）`
}

// 业务仓根同时有 AGENTS.md 和不导入它的 CLAUDE.md（或 .claude/CLAUDE.md / CLAUDE.local.md）时，Claude Code 只读 CLAUDE.md，
// AGENTS.md 不进上下文（官方 memory 口径；11-01 fameex-web 探针实测）。返回 true = 被遮蔽，需要在提示里点名去读。
export const detectShadowedAgentsDoc = (dir = repoRoot, { exists = existsSync, read = (path) => readFileSync(path, 'utf8') } = {}) => {
  if (!dir || !exists(join(dir, 'AGENTS.md'))) return false
  const claudeFiles = ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md'].map((name) => join(dir, name)).filter((path) => exists(path))
  if (!claudeFiles.length) return false
  return !claudeFiles.some((path) => {
    try {
      return /(^|\s)@AGENTS\.md\b/m.test(read(path))
    } catch {
      return false
    }
  })
}

// 按 task.project 决定 worker 在哪个仓/目录干活：
//   · 有项目号且 /Users/aven/github/<项目号> 有 worktree → 就在该 worktree 改
//   · 有项目号但本地无 worktree → 一次性临时 worktree（默认基于 origin/online，见 prepareTempWorktree）
//   · 命中项目 worktree 但已有 WIP → 一次性临时 worktree，必须基于该项目分支当时的 HEAD，不能退回 online
//   · 无项目号（群 @ 且群名/正文都没编号）→ 同样临时 worktree，分支 hotfix/adhoc-<id>
// hotfixBranch 存在即表示走「临时 worktree」流程，cwd 就是该临时目录。
// ⚠ `hotfix/*` 是 lark-bot 专用的受认可前缀（隔离草稿分支，从不自动 push/merge），与人类 `fix/<ID>`
//   是两个不同概念，刻意不同名，禁止互相 rename 对齐。taxonomy 不变量见 docs_tdd@165b070 common/rules/git-branch-flow.md §1.1（已冻结）。
const tempWorktreeCtx = ({ projectId, projectName, projectDocs, branch, baseRef, sourceBranch, sourceWorktree }) => {
  const path = join(tempWorktreeDir, branch.replace(/\//g, '-'))
  return {
    cwd: path,
    projectId,
    projectName,
    projectDocs,
    hotfixBranch: branch,
    ...(baseRef ? { baseRef } : {}),
    ...(sourceBranch ? { sourceBranch } : {}),
    ...(sourceWorktree ? { sourceWorktree } : {}),
  }
}

// 取 id 尾部做分支后缀：同一群的 messageId 共享长前缀，取头部会导致所有任务算出同一分支名而撞车。
const branchSuffix = (task) => String(task.recordId || task.id || '').replace(/[^\w]/g, '').slice(-8) || 'x'

// 与项目本地是否已有 worktree 无关地算出该任务的**隔离临时 worktree** 上下文。两处会用到：
//   1. resolveWorkContext：项目本地没有 worktree 时的默认落点（baseRef 为空，git 层默认 origin/online）；
//   2. runTask：命中的已有 worktree 在任务开始前已有人类未提交 WIP 时，改路由到这里，
//      并传入该 worktree 分支当时的 HEAD 作为 baseRef。这样既完全不碰人类工作区，也不会把
//      正在开发、已远离 online 的项目错误降级到 online 代码面上。
// 分支命名对同一 task.id 恒定（复用 branchSuffix），故 retry / 补料 / QA 验退会复用同一临时 worktree。
export const tempWorktreeContextFor = (task, { baseRef, sourceBranch, sourceWorktree } = {}) => {
  const project = safeProject(task.project)
  if (project) {
    return tempWorktreeCtx({
      projectId: project,
      projectName: task.projectTitle || project,
      projectDocs: prdCacheDocsFor(project),
      branch: `hotfix/${project}-${branchSuffix(task)}`,
      baseRef,
      sourceBranch,
      sourceWorktree,
    })
  }
  return tempWorktreeCtx({ projectId: '(adhoc)', projectName: task.projectTitle || '临时修复', projectDocs: [], branch: `hotfix/adhoc-${branchSuffix(task)}`, baseRef, sourceBranch, sourceWorktree })
}

// 路由结果的纯校验：任务项目、目标目录和临时分支必须来自同一个任务事实。
// Worker 会在准备 worktree 后再用 git 校验实际 root/branch；这里先挡住错误项目号、串项目目录和
// 复用了别的任务 hotfix 分支等调度层错误。readOnly 无本地项目 worktree 时允许回落主仓只读。
export const validateWorkContextRoute = ({ task, workContext } = {}) => {
  const project = safeProject(task?.project)
  const contextProject = safeProject(workContext?.projectId)
  const problems = []

  if (project !== contextProject) {
    problems.push(`任务项目 ${project || '(adhoc)'} 与工作上下文项目 ${contextProject || '(adhoc)'} 不一致`)
  }

  if (workContext?.hotfixBranch) {
    const expected = tempWorktreeContextFor(task || {})
    if (workContext.hotfixBranch !== expected.hotfixBranch) {
      problems.push(`临时分支应为 ${expected.hotfixBranch}，实际为 ${workContext.hotfixBranch}`)
    }
    if (resolve(workContext.cwd || '') !== resolve(expected.cwd)) {
      problems.push(`临时 worktree 应为 ${expected.cwd}，实际为 ${workContext.cwd || '(missing)'}`)
    }
  } else if (project) {
    const projectWorktree = join(worktreesDir, project)
    const expectedCwd = workContext?.readOnly && !existsSync(projectWorktree) ? repoRoot : projectWorktree
    if (resolve(workContext?.cwd || '') !== resolve(expectedCwd)) {
      problems.push(`项目 ${project} 应路由到 ${expectedCwd}，实际为 ${workContext?.cwd || '(missing)'}`)
    }
  } else if (resolve(workContext?.cwd || '') !== resolve(repoRoot)) {
    problems.push(`adhoc 只读任务应路由到主仓 ${repoRoot}，实际为 ${workContext?.cwd || '(missing)'}`)
  }

  return { ok: problems.length === 0, projectId: project || '(adhoc)', problems }
}

export const resolveWorkContext = (workerConfig, task) => {
  // 日报（11-02，lib/lark-daily-report.mjs）：只读运行态 + git -C 业务仓，不进 worktree；调度键单独一条，不排在主仓只读任务后面。
  if (resolveCommandType(task).type === DAILY_COMMAND_TYPE) return { cwd: join(larkRuntimeDir, 'lark-daily-report'), projectId: '(daily)', projectName: '日报', projectDocs: [], readOnly: true, daily: true }
  // 运维指令（aven 11-01，lib/lark-ops-run.mjs）：固定动作，不建 worktree、不改代码；调度键 = 运维仓根（同仓的运维串行）
  if (resolveCommandType(task).type === OPS_COMMAND_TYPE) {
    const root = workerConfig?.localConfig?.opsActions?.repo || repoRoot
    return { cwd: root, projectId: '(ops)', projectName: '运维指令', projectDocs: [], readOnly: false, ops: { root } }
  }
  const project = safeProject(task.project)
  // 只读命令（状态/status）/ 代答（契约 answer）不改代码：命中已有 worktree 就地只读；无 worktree 也不新建临时 worktree
  // （git worktree add + origin/online 拉取很贵），直接在主仓只读回答，跳过提交闸。
  // 实测（契约 verification，11-01）：没配页面工具（config.verify）时只有 curl + 读代码，同样只读；配了页面工具要起 dev、落截图，
  // 走隔离临时 worktree，单趟跑、不进分析 / 实施两阶段、不提交。
  const verification = task?.contract?.deliverable === 'verification'
  if (verification && workerConfig?.localConfig?.verify) {
    return { ...tempWorktreeContextFor(task), readOnly: false, singlePass: true, verification: true }
  }
  const readOnly = verification || isReadOnlyTask(task)
  if (project) {
    const worktree = join(worktreesDir, project)
    if (existsSync(worktree)) {
      return { cwd: worktree, projectId: project, projectName: task.projectTitle || project, projectDocs: prdCacheDocsFor(project), readOnly }
    }
    if (readOnly) {
      return { cwd: repoRoot, projectId: project, projectName: task.projectTitle || project, projectDocs: prdCacheDocsFor(project), readOnly: true }
    }
    return tempWorktreeContextFor(task)
  }
  if (readOnly) {
    return { cwd: repoRoot, projectId: '(adhoc)', projectName: task.projectTitle || '临时修复', projectDocs: [], readOnly: true }
  }
  // 无项目号 → 临时 worktree（adhoc 分支）
  return tempWorktreeContextFor(task)
}
