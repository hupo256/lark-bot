/**
 * 合回负责人工作分支的待办状态（aven 2026-10-27，取代集成分支）：纯文件读写，gateway（「推 pre」回复）和 worker 共用。
 *
 * runtime/lark-merge-back/<repo>.json：
 *   pending       做完了、还没合进 baseRef 的任务分支（主目录暂存区有内容 / 不在 baseRef / 未提交改动重叠时排队，worker 定时重试）
 *     [{ taskId, branch, summary, since, reason, notified }]
 *   syncConflict  上游（origin/pre）同步进 baseRef 有冲突：{ upstreamSha, reason, notified }；同一个上游提交只报一次
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { writeJsonAtomic } from './lark-fs.mjs'
import { larkRuntimeDir } from './lark-paths.mjs'

const statePath = (key, runtimeDir) => join(runtimeDir || larkRuntimeDir, 'lark-merge-back', `${key}.json`)

export const loadMergeBackState = (key, { runtimeDir } = {}) => {
  try {
    const state = JSON.parse(readFileSync(statePath(key, runtimeDir), 'utf8'))
    return { pending: Array.isArray(state.pending) ? state.pending : [], syncConflict: state.syncConflict || null }
  } catch {
    return { pending: [], syncConflict: null }
  }
}

export const saveMergeBackState = (key, state, { runtimeDir } = {}) => writeJsonAtomic(statePath(key, runtimeDir), state)

// 同一条分支只排一次（续跑 / 重跑同一任务会再来一次）。
export const queuePendingMerge = (key, item, deps = {}) => {
  const state = loadMergeBackState(key, deps)
  const rest = state.pending.filter((entry) => entry.branch !== item.branch)
  saveMergeBackState(key, { ...state, pending: [...rest, { ...item, notified: false }] }, deps)
}

// 上游同步结果：冲突按上游提交去重（同一个 origin/pre 头只提醒一次）；同步成功清掉旧冲突。
export const recordSyncResult = (key, { conflict = null, upstreamSha = null }, deps = {}) => {
  const state = loadMergeBackState(key, deps)
  if (!conflict) {
    if (state.syncConflict) saveMergeBackState(key, { ...state, syncConflict: null }, deps)
    return
  }
  if (state.syncConflict?.upstreamSha === upstreamSha) return
  saveMergeBackState(key, { ...state, syncConflict: { upstreamSha, reason: conflict, notified: false } }, deps)
}
