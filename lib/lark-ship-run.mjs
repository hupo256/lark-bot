/**
 * 「部署 dev / test」的真实依赖（只给 worker）：业务主仓的 git、GitLab 客户端、PRD 缓存、Husky 工具准备、解冲突的模型、部署等待登记。
 * 流程本身在 lib/lark-ship.mjs（纯编排，deps 注入）。
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { execAiExecutor } from './lark-ai-executor.mjs'
import { writeWatch } from './lark-deploy-watch.mjs'
import { createGitlabClient, readGitlabToken, resolveGitlabSettings } from './lark-gitlab.mjs'
import { consumerRoot, larkDeployWatchDir, prdCacheRoot, worktreesDir } from './lark-paths.mjs'
import { buildConflictPrompt, readPrdText, runShipAction } from './lark-ship.mjs'
import { prepareRootTools } from './lark-worktree-deps.mjs'

const gitIn = (cwd) => (args) => spawnSync('git', ['-C', cwd, '-c', 'core.quotepath=off', ...args], { encoding: 'utf8', timeout: 5 * 60_000, maxBuffer: 32 * 1024 * 1024 })

// 分支挂在某个 worktree 上且有没提交的改动：返回那个 worktree 的路径（推送带不上，结果里提一句）。
const dirtyWorktreeOf = (git) => (branch) => {
  const list = String(git(['worktree', 'list', '--porcelain']).stdout || '')
  const block = list.split('\n\n').find((chunk) => chunk.includes(`branch refs/heads/${branch}\n`) || chunk.endsWith(`branch refs/heads/${branch}`))
  const path = /^worktree (.+)$/m.exec(block || '')?.[1]
  if (!path) return null
  return String(gitIn(path)(['status', '--porcelain']).stdout || '').trim() ? path : null
}

/** 组 deps。缺令牌 / 认不出 GitLab 地址返回 { error }。 */
export const buildShipDeps = ({ localConfig = {}, auditDir = null, repo = consumerRoot } = {}) => {
  const git = gitIn(repo)
  const remote = String(git(['remote', 'get-url', 'origin']).stdout || '').trim()
  const settings = resolveGitlabSettings({ gitlab: localConfig.gitlab || {}, remote })
  if (!settings) return { error: `认不出 GitLab 地址（origin = ${remote || '空'}），配置 gitlab.baseUrl / projectPath。` }
  const token = readGitlabToken(settings.tokenPath)
  if (!token) return { error: `读不到 GitLab 令牌 ${settings.tokenPath}。` }
  return {
    deps: {
      git,
      gitAt: (cwd, args) => gitIn(cwd)(args),
      gitlab: createGitlabClient({ apiBase: settings.apiBase, projectPath: settings.projectPath, token }),
      prdText: (projectId) => readPrdText({ prdCacheRoot, projectId }),
      prepareTools: prepareRootTools,
      readFile: (path) => {
        try {
          return readFileSync(path, 'utf8')
        } catch {
          return ''
        }
      },
      dirtyWorktreeOf: dirtyWorktreeOf(git),
      resolveConflicts: async ({ cwd, files, branch, env, task }) => {
        const run = await execAiExecutor({
          executor: 'claude',
          promptText: buildConflictPrompt({ branch, env, files, cwd, taskText: task?.text }),
          cwd,
          localConfig,
          resultKind: 'task',
          auditLogPath: auditDir ? join(auditDir, `${task.id}-merge.log`) : undefined,
          timeoutMs: 30 * 60_000,
        })
        return run?.result || { status: 'failed', summary: '执行器没给结果' }
      },
      writeWatch: (entry) => writeWatch({ dir: larkDeployWatchDir, entry }),
      worktreesDir,
      now: Date.now,
    },
  }
}

/** worker 入口：返回 { status, text }。 */
export const runShip = async ({ task, action, localConfig, auditDir, build = buildShipDeps }) => {
  const built = build({ localConfig, auditDir })
  if (built.error) return { status: 'failed', text: `没动手：${built.error}` }
  try {
    return await runShipAction({ task, action, deps: built.deps })
  } catch (error) {
    return { status: 'failed', text: `部署 ${action.env} 中途出错：${String(error?.message || error).slice(0, 300)}` }
  }
}
