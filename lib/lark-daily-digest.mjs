/**
 * 每日「等你决定的 n 条」私信（11-01 对话层，数字分身地基；不是 falive 的日报）+ 疑似 48h 过期的合并知会。
 *
 * 分组：疑似（回「继续任务 id 做」/「取消任务 id」）/ 扣下的群回复（回「就这样回」）/ 答应了没结论 / 等材料超 24h。
 * 每天本地时间 config.digest.at（默认 09:30）发一次；没有条目不发。断点 runtime/lark-digest-state.json（lastSentDate）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { sendPrincipalNote } from './lark-group-exit.mjs'
import { chatLabel, headline, sayDigest, saySuspectedExpired } from './lark-human-text.mjs'
import { localHHMM } from './lark-outbox.mjs'
import { larkRuntimeDir } from './lark-paths.mjs'
import { getObligation } from './lark-reply-obligation.mjs'
import { isControlActiveStatus } from './lark-task-store.mjs'

const PARKED = new Set(['waiting_confirmation', 'blocked'])
const OVERDUE_MS = 4 * 60 * 60_000
const PARKED_MS = 24 * 60 * 60_000
const DEFAULT_AT = '09:30'

const statePath = () => join(larkRuntimeDir, 'lark-digest-state.json')
const readState = (path = statePath()) => {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) || {} : {}
  } catch {
    return {}
  }
}
const writeState = (state, path = statePath()) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(`${path}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 })
  renameSync(`${path}.tmp`, path)
}

const item = (task, chatNames) => ({ headline: headline(task) || task.id, chatLabel: chatLabel(task, { chatNames }), time: localHHMM(task.parkedAt || task.ackedAt || task.createdAt) })

// 纯函数：从任务库挑四组。
export const collectDigest = ({ store, now = Date.now(), chatNames = {} }) => {
  const suspected = []
  const held = []
  const overdue = []
  const parked = []
  for (const task of store.list()) {
    if (task.suspected && task.status === 'waiting_confirmation') suspected.push(item(task, chatNames))
    else if (PARKED.has(task.status) && !task.askBack && (task.contract?.deliverable || 'change') === 'change' && now - (Date.parse(task.parkedAt || task.updatedAt || '') || now) > PARKED_MS) parked.push(item(task, chatNames))
    if (getObligation(task)?.state === 'held') held.push(item(task, chatNames))
    if (task.ackedInGroup && isControlActiveStatus(task.status) && !PARKED.has(task.status) && now - (Date.parse(task.ackedAt || '') || now) > OVERDUE_MS) overdue.push(item(task, chatNames))
  }
  return { suspected, held, overdue, parked }
}

export const renderDigest = (digest) => sayDigest(digest)

// 发一次（同一天只发一次；没有条目不发、也不记已发）。
export const runDailyDigest = async ({ config, store, now = Date.now(), send = sendPrincipalNote, state = readState(), save = writeState, chatNames = {} }) => {
  const today = new Date(now).toLocaleDateString('sv-SE')
  if (state.lastSentDate === today) return { sent: false, reason: 'already sent today' }
  const text = renderDigest(collectDigest({ store, now, chatNames }))
  if (!text) return { sent: false, reason: 'nothing to decide' }
  const sent = await send({ config, store, text, kind: 'digest', idempotencyKey: `digest-${today.replace(/-/g, '')}` })
  if (sent.ok) save({ ...state, lastSentDate: today })
  return { sent: Boolean(sent.ok), reason: sent.ok ? null : sent.reason }
}

// 每分钟看一眼本地时间到没到 config.digest.at；config.digest.enabled === false 关掉。
export const startDailyDigest = ({ config, store, run = runDailyDigest, intervalMs = 60_000 }) => {
  if (config?.digest?.enabled === false) return { stop: () => {} }
  const at = /^\d{2}:\d{2}$/.test(String(config?.digest?.at || '')) ? config.digest.at : DEFAULT_AT
  const tick = () => {
    const now = new Date()
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    if (hhmm < at) return
    run({ config, store, now: now.getTime() }).catch((error) => console.error(`[lark-gateway] 日汇总异常：${String(error?.message || error).slice(0, 160)}`))
  }
  const timer = setInterval(tick, intervalMs)
  timer.unref?.()
  return { stop: () => clearInterval(timer), tick }
}

// 疑似 48h 没人认领：自动关（store.expireSuspected）并合并私信负责人一条。没有过期的什么都不发。
export const expireSuspectedAndNotify = async ({ config, store, now = Date.now(), send = sendPrincipalNote, chatNames = {} }) => {
  const expired = store.expireSuspected?.({ now }) || []
  if (!expired.length) return { expired: 0 }
  const text = saySuspectedExpired({ tasks: expired, chatNames })
  await send({ config, store, text, kind: 'suspected_expired', idempotencyKey: `sus-exp-${new Date(now).toISOString().slice(0, 13)}` })
  console.log(`[lark-gateway] 疑似过期自动关 ${expired.length} 条：${expired.map((task) => task.id).join('、')}`)
  return { expired: expired.length }
}
