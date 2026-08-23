/**
 * Lark 组件共享的仓库路径基座：主仓根、worktree 同级目录、项目文档目录。
 * gateway / worker / poller 统一从这里取，避免各自重复 resolveRoots()。
 */

import { chmodSync, existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveProjectRoot, resolveRoots } from '../../engine/agent-scripts/lib/roots.mjs'

// worktree 约定：/Users/aven/github/<项目ID>（主仓同级目录）
export const { consumerRoot: repoRoot } = resolveRoots()
export const worktreesDir = dirname(repoRoot)
// 项目文档目录：三域重组后 PR-* 实例落在 docs 仓 prds/ 下，统一复用 resolveProjectRoot 收口，
// 不再自拼 apps/web/docs_tdd/<project>（会漏 prds/ 层，导致 tasksDir/notification-log 指向旧路径）。
export const docsDir = (project) => resolveProjectRoot(project)

// Lark 单例运行时目录（与 lark-bot.local.json 同级）。锚定到本模块位置，cwd/config 无关。
// 任务队列是跨项目的全局单例（网关按 task.project 派发，不按队列位置），故不能再寄生在某个业务
// PR 的 agent/ 下——那样会让别的项目任务混进该 PR 目录、且随该 PR 生命周期被误清。
const larkBotRoot = dirname(dirname(fileURLToPath(import.meta.url)))
export const larkRuntimeDir = join(larkBotRoot, 'runtime')
export const larkTasksDir = join(larkRuntimeDir, 'lark-tasks')

// runtime/*.json 里有本机配置（bug 表 appToken/URL）与任务运行态，本机其他用户/进程无需可读。
// 任务文件写入时已带 mode 0o600（lark-task-store），但配置与状态文件多是历史遗留的 0644，
// 且 mode 只在「创建」时生效——已存在的文件改不动权限，故启动时统一收紧一次。
export const hardenRuntimeFiles = (files) => {
  const tightened = []
  for (const file of files) {
    try {
      if (!existsSync(file)) continue
      // eslint-disable-next-line no-bitwise -- 只取权限位
      const mode = statSync(file).mode & 0o777
      if (mode & 0o077) {
        chmodSync(file, 0o600)
        tightened.push(`${file.split('/').pop()}(${mode.toString(8)}→600)`)
      }
    } catch {
      // 权限收紧是尽力而为：读不到/改不动不该拦住启动（真正的边界是共享密钥与白名单）。
    }
  }
  return tightened
}
