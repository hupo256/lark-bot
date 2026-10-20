/**
 * 失败台账（自愈环 2）：runtime/lark-failures/<repo>.jsonl，一行一次失败处置。
 * 记什么：任务 id、指纹与类别、原文（截断）、剧本动作（requeue / fail / ignore）、是否复发。
 * 用途：① 同一任务自愈重排队次数上限；② 同指纹 7 天内复发计数（自修工单触发条件）；③ doctor / 日报自检行。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { larkRuntimeDir } from './lark-paths.mjs'

export const failuresDir = join(larkRuntimeDir, 'lark-failures')
const KEEP_MS = 30 * 24 * 60 * 60_000

const fileFor = (dir, repo) => join(dir, `${repo || '_default'}.jsonl`)

const readEntries = (file) => {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

export const recordFailure = ({ dir = failuresDir, repo, taskId, fingerprint, action, reason = '', message = '', recurring = false, epoch = null, now = Date.now() }) => {
  const entry = {
    at: new Date(now).toISOString(),
    repo: repo || '_default',
    taskId,
    epoch,
    cls: fingerprint?.cls || 'unknown',
    fingerprint: fingerprint?.fingerprint || null,
    label: fingerprint?.label || null,
    action,
    reason,
    recurring,
    message: String(message || '').slice(0, 300),
  }
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    appendFileSync(fileFor(dir, repo), `${JSON.stringify(entry)}\n`, { mode: 0o600 })
  } catch (error) {
    console.warn(`[lark-worker] 失败台账写入失败（忽略）：${String(error).slice(0, 120)}`)
  }
  return entry
}

export const listFailures = ({ dir = failuresDir, repo = null, sinceMs = 0 } = {}) => {
  if (!existsSync(dir)) return []
  const files = repo ? [fileFor(dir, repo)] : readdirSync(dir).filter((name) => name.endsWith('.jsonl')).map((name) => join(dir, name))
  return files
    .flatMap(readEntries)
    .filter((entry) => (Date.parse(entry.at || '') || 0) >= sinceMs)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
}

// 本任务此前的自愈重排队记录（跨代）：决定还能不能再排一次、以及重领后给模型的提示。
export const selfHealAttemptsForTask = ({ dir = failuresDir, repo, taskId }) =>
  listFailures({ dir, repo, sinceMs: Date.now() - KEEP_MS }).filter((entry) => entry.taskId === taskId && entry.action === 'requeue')

// 7 天内同指纹次数（不含本次）：≥1 即「复发」。只数真失败（fail / requeue），别的动作记录不算（aven 2026-10-20 review A7）。
const COUNTED_ACTIONS = new Set(['fail', 'requeue'])
export const countRecentFingerprint = ({ dir = failuresDir, repo = null, fingerprint, days = 7, now = Date.now() }) =>
  listFailures({ dir, repo, sinceMs: now - days * 24 * 60 * 60_000 }).filter((entry) => entry.fingerprint === fingerprint && COUNTED_ACTIONS.has(entry.action)).length

// doctor / 日报自检行用：近 N 天按类别计数 + 复发指纹。
export const summarizeFailures = ({ dir = failuresDir, repo = null, days = 7, now = Date.now() } = {}) => {
  const entries = listFailures({ dir, repo, sinceMs: now - days * 24 * 60 * 60_000 })
  const byClass = {}
  const byFingerprint = new Map()
  for (const entry of entries) {
    if (entry.action === 'ignore') continue
    byClass[entry.cls] = (byClass[entry.cls] || 0) + 1
    if (entry.fingerprint) byFingerprint.set(entry.fingerprint, (byFingerprint.get(entry.fingerprint) || 0) + 1)
  }
  const recurring = [...byFingerprint.entries()].filter(([, count]) => count >= 2).map(([fingerprint, count]) => ({ fingerprint, count }))
  const healed = entries.filter((entry) => entry.action === 'requeue').length
  return { total: Object.values(byClass).reduce((sum, n) => sum + n, 0), byClass, recurring, healed }
}
