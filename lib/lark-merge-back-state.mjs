/**
 * 合回负责人工作分支的待办状态（aven 2026-10-27，取代集成分支）：纯文件读写，gateway（「推 pre」回复）和 worker 共用。
 *
 * runtime/lark-merge-back/<repo>.json：
 *   pending       做完了、还没合进 baseRef 的任务分支（主目录暂存区有内容 / 不在 baseRef / 未提交改动重叠时排队，worker 定时重试）
 *     [{ taskId, branch, summary, since, reason, notified }]
 *   syncConflict  上游（origin/pre）同步进 baseRef 有冲突：{ upstreamSha, reason, notified }；同一个上游提交只报一次
 *   conflicts     合回有冲突、等负责人处理的任务分支：[{ taskId, branch, summary, files, since }]；
 *                 冲突文件全在 docs/ 下的，负责人私信「帮我合」由 lib/lark-merge-resolve.mjs 建任务按语义合（aven 2026-10-29）
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { writeJsonAtomic } from './lark-fs.mjs'
import { larkRuntimeDir } from './lark-paths.mjs'

const statePath = (key, runtimeDir) => join(runtimeDir || larkRuntimeDir, 'lark-merge-back', `${key}.json`)

export const loadMergeBackState = (key, { runtimeDir } = {}) => {
  try {
    const state = JSON.parse(readFileSync(statePath(key, runtimeDir), 'utf8'))
    const list = (value) => (Array.isArray(value) ? value : [])
    return { pending: list(state.pending), syncConflict: state.syncConflict || null, conflicts: list(state.conflicts) }
  } catch {
    return { pending: [], syncConflict: null, conflicts: [] }
  }
}

export const saveMergeBackState = (key, state, { runtimeDir } = {}) => writeJsonAtomic(statePath(key, runtimeDir), state)

// 同一条分支只排一次（续跑 / 重跑同一任务会再来一次）。
export const queuePendingMerge = (key, item, deps = {}) => {
  const state = loadMergeBackState(key, deps)
  const rest = state.pending.filter((entry) => entry.branch !== item.branch)
  saveMergeBackState(key, { ...state, pending: [...rest, { ...item, notified: false }] }, deps)
}

// 冲突文件全在 docs/ 下才交给 bot 按语义合；代码冲突一律人合。
export const RESOLVE_HINT = '只冲突在文档，回「帮我合」我按意思合；不用我合就自己合'
export const isDocsOnlyConflict = (files = []) => files.length > 0 && files.every((file) => String(file).replace(/^"/, '').startsWith('docs/'))

// 合回冲突记账（同一条分支只记一次）；takeConflicts 取走全部「只冲突在文档」的，其余留给人。
export const recordConflict = (key, item, deps = {}) => {
  const state = loadMergeBackState(key, deps)
  const rest = state.conflicts.filter((entry) => entry.branch !== item.branch)
  saveMergeBackState(key, { ...state, conflicts: [...rest, item] }, deps)
}
export const takeDocsConflicts = (key, deps = {}) => {
  const state = loadMergeBackState(key, deps)
  const taken = state.conflicts.filter((item) => isDocsOnlyConflict(item.files))
  if (taken.length) saveMergeBackState(key, { ...state, conflicts: state.conflicts.filter((item) => !taken.includes(item)) }, deps)
  return { taken, left: state.conflicts.filter((item) => !taken.includes(item)) }
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
