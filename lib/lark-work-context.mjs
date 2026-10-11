/**
 * Lark Worker 的任务路由层：把任务归一成安全项目号，并决定 worker 在哪个仓/目录干活
 * （命中已有 worktree / 临时 worktree / 主仓只读）。safeProject 是 path-injection 的安全边界。
 */

import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { prdCacheRoot, repoRoot, tempWorktreeDir, worktreesDir } from './lark-worker-env.mjs'
import { isReadOnlyTask } from './lark-message.mjs'
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
  const project = safeProject(task.project)
  // 只读命令（状态/status）不改代码：命中已有 worktree 就地只读；无 worktree 也不新建临时 worktree
  // （git worktree add + origin/online 拉取很贵），直接在主仓只读回答，跳过提交闸。
  const readOnly = isReadOnlyTask(task)
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
