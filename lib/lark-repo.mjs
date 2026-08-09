/**
 * Lark 组件共享的仓库路径基座：主仓根、worktree 同级目录、项目文档目录。
 * gateway / worker / poller 统一从这里取，避免各自重复 resolveRoots()。
 */

import { dirname, join } from 'node:path'
import { resolveRoots } from '../../engine/agent-scripts/lib/roots.mjs'

// worktree 约定：/Users/aven/github/<项目ID>（主仓同级目录）
export const { consumerRoot: repoRoot } = resolveRoots()
export const worktreesDir = dirname(repoRoot)
// 项目文档目录：docs_tdd 在主仓下（软链），按项目号定位
export const docsDir = (project) => join(repoRoot, 'apps/web/docs_tdd', project)
