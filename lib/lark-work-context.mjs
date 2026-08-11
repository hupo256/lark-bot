/**
 * Lark Worker 的任务路由层：把任务归一成安全项目号，并决定 worker 在哪个仓/目录干活
 * （命中已有 worktree / 临时 worktree / 主仓只读）。safeProject 是 path-injection 的安全边界。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot, tempWorktreeDir, worktreesDir } from './lark-worker-env.mjs'
import { isReadOnlyTask } from './lark-message.mjs'
import { isProjectId } from './lark-project-id.mjs'

export const DOCS_MOUNT = 'apps/web/docs_tdd'
const PROJECT_DOC_FILES = ['agent/lark-integration.md', 'agent/README.md']

// 归一并校验项目号：仅接受 PR-#### / PM-#### 形态（大写）。project 会拼进 worktree 路径与
// hotfix 分支名，恶意/异常值（如 bug 表「项目ID」列填 ../../x）必须被挡在外面，否则会越出 worktree 根目录。
// 复用 lark-project-id.mjs 的 isProjectId（整串校验的唯一正则来源），避免两条链路各自维护一份
// PROJECT_ID_RE 对同一字符串判出不同结果。
export const safeProject = (raw) => {
  const value = String(raw || '').trim().toUpperCase()
  return isProjectId(value) ? value : ''
}

// 项目文档：docs_tdd 在主仓下（软链到 ~/github/docs_tdd），按项目号取存在的文档
const projectDocsFor = (projectId) =>
  PROJECT_DOC_FILES
    .map((file) => `${DOCS_MOUNT}/prds/${projectId}/${file}`)
    .filter((rel) => existsSync(join(repoRoot, rel)))

// 按 task.project 决定 worker 在哪个仓/目录干活：
//   · 有项目号且 /Users/aven/github/<项目号> 有 worktree → 就在该 worktree 改
//   · 有项目号但本地无 worktree → 一次性临时 worktree（基于 origin/online 建 hotfix 分支，见 prepareTempWorktree）
//   · 无项目号（群 @ 且群名/正文都没编号）→ 同样临时 worktree，分支 hotfix/adhoc-<id>
// hotfixBranch 存在即表示走「临时 worktree」流程，cwd 就是该临时目录。
const tempWorktreeCtx = ({ projectId, projectName, projectDocs, branch }) => {
  const path = join(tempWorktreeDir, branch.replace(/\//g, '-'))
  return { cwd: path, projectId, projectName, projectDocs, hotfixBranch: branch }
}

// 取 id 尾部做分支后缀：同一群的 messageId 共享长前缀，取头部会导致所有任务算出同一分支名而撞车。
const branchSuffix = (task) => String(task.recordId || task.id || '').replace(/[^\w]/g, '').slice(-8) || 'x'

// 与项目本地是否已有 worktree 无关地算出该任务的**隔离临时 worktree** 上下文。两处会用到：
//   1. resolveWorkContext：项目本地没有 worktree 时的默认落点；
//   2. runTask：命中的已有 worktree 在任务开始前已有人类未提交 WIP 时，改路由到这里，
//      让 bot 的改动落隔离分支、完全不碰人类工作区（绝不自动提交人类 WIP）。
// 分支命名对同一 task.id 恒定（复用 branchSuffix），故 retry / 补料 / QA 验退会复用同一临时 worktree。
export const tempWorktreeContextFor = (task) => {
  const project = safeProject(task.project)
  if (project) {
    return tempWorktreeCtx({
      projectId: project,
      projectName: task.projectTitle || project,
      projectDocs: projectDocsFor(project),
      branch: `hotfix/${project}-${branchSuffix(task)}`,
    })
  }
  return tempWorktreeCtx({ projectId: '(adhoc)', projectName: task.projectTitle || '临时修复', projectDocs: [], branch: `hotfix/adhoc-${branchSuffix(task)}` })
}

export const resolveWorkContext = (workerConfig, task) => {
  const project = safeProject(task.project)
  // 只读命令（状态/status）不改代码：命中已有 worktree 就地只读；无 worktree 也不新建临时 worktree
  // （git worktree add + origin/online 拉取很贵），直接在主仓只读回答，跳过提交闸。
  const readOnly = isReadOnlyTask(task)
  if (project) {
    const worktree = join(worktreesDir, project)
    if (existsSync(worktree)) {
      return { cwd: worktree, projectId: project, projectName: task.projectTitle || project, projectDocs: projectDocsFor(project), readOnly }
    }
    if (readOnly) {
      return { cwd: repoRoot, projectId: project, projectName: task.projectTitle || project, projectDocs: projectDocsFor(project), readOnly: true }
    }
    return tempWorktreeContextFor(task)
  }
  if (readOnly) {
    return { cwd: repoRoot, projectId: '(adhoc)', projectName: task.projectTitle || '临时修复', projectDocs: [], readOnly: true }
  }
  // 无项目号 → 临时 worktree（adhoc 分支）
  return tempWorktreeContextFor(task)
}
