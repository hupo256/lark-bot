/**
 * Lark Worker 的集中依赖层：把 roots/env 派生的常量收口到一处，供各 worker 子模块 import，
 * 避免每个函数改签名传 repoRoot/worktreesDir 等。行为与原 lark-worker.mjs 顶层常量一致。
 */

import { join } from 'node:path'
import { worktreesDir } from './lark-repo.mjs'

export { docsSystemRoot } from '../../engine/agent-scripts/lib/roots.mjs'
export { repoRoot, worktreesDir } from './lark-repo.mjs'
export { gatewaySecret } from './lark-config.mjs'

export const defaultGatewayUrl = process.env.LARK_GATEWAY_URL || 'http://127.0.0.1:3005'
export const defaultPollMs = Number(process.env.LARK_WORKER_POLL_MS || 5000)
// 并行执行上限：不同 worktree 的任务可同时跑，同一 worktree（cwd 相同）仍串行。
// 每个并发任务都会起一个 claude + 全套验证，很吃 CPU/内存，默认 3 是吞吐与机器负载的平衡点。
export const defaultConcurrency = Math.max(1, Number(process.env.LARK_WORKER_CONCURRENCY || 3))
export const defaultAiExecutor = 'claude'

// 临时 hotfix worktree 落盘目录（用完即删，不进 worktree 常驻区）
export const tempWorktreeDir = join(worktreesDir, '.lark-hotfix')

// 审计留存窗口（默认 7 天）：worker 每跑一个任务顺手清理超期审计文件，避免占满磁盘。
export const auditRetentionMs = Math.max(0, Number(process.env.LARK_AUDIT_RETENTION_MS || 7 * 24 * 60 * 60 * 1000))
