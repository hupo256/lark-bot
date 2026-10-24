/**
 * 失败台账（自愈环 2，从 falive 移植，aven 2026-10-24）：runtime/lark-failures/<key>.jsonl，一行一次失败处置。
 * fameex 是单仓单实例、一个 worker 跨多个 PR 项目，复发要按整个 bot 数，所以台账只有一本：key 固定 'fameex'
 *（FAILURE_LEDGER_KEY），不按 config.project 分（那只是默认项目号）。参数名沿用 falive 的 `repo`，接口同形。
 * 记什么：任务 id、指纹与类别、原文（截断）、剧本动作（requeue / fail / ignore）、是否复发。
 * 用途：① 同一任务自愈重排队次数上限；② 同指纹 7 天内复发计数（按别的任务数）；③ 后续自修工单 / 体检读汇总。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { larkRuntimeDir } from './lark-paths.mjs'

export const failuresDir = join(larkRuntimeDir, 'lark-failures')
export const FAILURE_LEDGER_KEY = 'fameex'
const KEEP_MS = 30 * 24 * 60 * 60_000

const fileFor = (dir, repo) => join(dir, `${repo || FAILURE_LEDGER_KEY}.jsonl`)

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

export const recordFailure = ({ dir = failuresDir, repo = FAILURE_LEDGER_KEY, taskId, fingerprint, action, reason = '', message = '', recurring = false, epoch = null, now = Date.now() }) => {
  const entry = {
    at: new Date(now).toISOString(),
    repo: repo || FAILURE_LEDGER_KEY,
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

// repo 传 null 读目录下所有台账（与 falive 同形；fameex 平时只有 fameex.jsonl 一本）。
export const listFailures = ({ dir = failuresDir, repo = null, sinceMs = 0 } = {}) => {
  if (!existsSync(dir)) return []
  const files = repo ? [fileFor(dir, repo)] : readdirSync(dir).filter((name) => name.endsWith('.jsonl')).map((name) => join(dir, name))
  return files
    .flatMap(readEntries)
    .filter((entry) => (Date.parse(entry.at || '') || 0) >= sinceMs)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
}

// 本任务此前的自愈重排队记录（跨代）：决定还能不能再排一次、以及重领后给模型的提示。
export const selfHealAttemptsForTask = ({ dir = failuresDir, repo = FAILURE_LEDGER_KEY, taskId, now = Date.now() }) =>
  listFailures({ dir, repo, sinceMs: now - KEEP_MS }).filter((entry) => entry.taskId === taskId && entry.action === 'requeue')

// 一行算哪条任务：复发按任务数，同一任务的 requeue + fail（+ self_fix）只算一个。缺 taskId 的旧行各算各的。
const taskKey = (entry, index) => entry.taskId ?? `#${index}`

// 7 天内撞上同指纹的**别的**任务数（不含本任务）：≥1 即「复发」。只数真失败（fail / requeue），别的动作记录不算。
// 10-24 沙箱试跑：原来不排除本任务，任务自己第一次 requeue 那行把第二次失败算成「同一种错 7 天内第 2 次」、recurring:true。
const COUNTED_ACTIONS = new Set(['fail', 'requeue'])
export const countRecentFingerprint = ({ dir = failuresDir, repo = null, fingerprint, taskId = null, days = 7, now = Date.now() }) =>
  new Set(
    listFailures({ dir, repo, sinceMs: now - days * 24 * 60 * 60_000 })
      .map((entry, index) => [entry, taskKey(entry, index)])
      .filter(([entry, key]) => entry.fingerprint === fingerprint && COUNTED_ACTIONS.has(entry.action) && key !== taskId)
      .map(([, key]) => key),
  ).size

// 体检 / 汇总行用：近 N 天 fail 行按类别计数 + 复发指纹（不同任务 ≥2，count = 任务数）+ 自动重排队次数（requeue 单列，不算失败）。
// 10-24 沙箱试跑：原来只跳过 ignore，一条任务的 requeue + fail + self_fix 就报「7 天失败 3、复发指纹 ×3」，每次重排队后失败都 warn 私信。
export const summarizeFailures = ({ dir = failuresDir, repo = null, days = 7, now = Date.now() } = {}) => {
  const entries = listFailures({ dir, repo, sinceMs: now - days * 24 * 60 * 60_000 })
  const byClass = {}
  const tasksByFingerprint = new Map()
  let total = 0
  entries.forEach((entry, index) => {
    if (entry.action !== 'fail') return
    total += 1
    byClass[entry.cls] = (byClass[entry.cls] || 0) + 1
    if (!entry.fingerprint) return
    if (!tasksByFingerprint.has(entry.fingerprint)) tasksByFingerprint.set(entry.fingerprint, new Set())
    tasksByFingerprint.get(entry.fingerprint).add(taskKey(entry, index))
  })
  const recurring = [...tasksByFingerprint.entries()].filter(([, tasks]) => tasks.size >= 2).map(([fingerprint, tasks]) => ({ fingerprint, count: tasks.size }))
  const healed = entries.filter((entry) => entry.action === 'requeue').length
  return { total, byClass, recurring, healed }
}
