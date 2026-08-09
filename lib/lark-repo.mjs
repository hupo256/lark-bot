/**
 * Lark 组件共享的仓库路径基座：主仓根、worktree 同级目录、项目文档目录。
 * gateway / worker / poller 统一从这里取，避免各自重复 resolveRoots()。
 */

import { dirname } from 'node:path'
import { resolveProjectRoot, resolveRoots } from '../../engine/agent-scripts/lib/roots.mjs'

// worktree 约定：/Users/aven/github/<项目ID>（主仓同级目录）
export const { consumerRoot: repoRoot } = resolveRoots()
export const worktreesDir = dirname(repoRoot)
// 项目文档目录：三域重组后 PR-* 实例落在 docs 仓 prds/ 下，统一复用 resolveProjectRoot 收口，
// 不再自拼 apps/web/docs_tdd/<project>（会漏 prds/ 层，导致 tasksDir/notification-log 指向旧路径）。
export const docsDir = (project) => resolveProjectRoot(project)
