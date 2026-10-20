/**
 * 日报按日期记账（aven 2026-10-20 review C15）。
 *
 * 快照：feature-table.json / code-status.json 按本地日期存历史 { history: { [date]: … } }，基线只取「早于今天」的最近一份。
 *   以前每次跑都在发群之前覆盖成当天：失败 10 分钟后重试、或手动「重发日报」时拿当天第一次的快照当「昨天」，
 *   「今日 +N / 今日升级」清零。现在发出去之后才落快照，且当天的快照永远不当当天的基线。
 *
 * 投递：delivery.json { [date]: { doc: { url, documentId }, sent: { [key]: 'sent' | 'gated' } } }，key = 群 chat_id /
 *   `review:<owner>`（核对单）/ `private:<to>`（私信版）。自动重试（mode 'resume'）时已发成功的群 / 核对单 / 私信不再发，
 *   已建的云文档复用（以前每次重试都新建一份公开云文档）；群里「重发日报」（mode 'fresh'）清掉当天记账从头发。
 *   repo-only 实例只走 webhook，没有 lark-cli idempotency-key 帮着去重、也没有 message_id 可查，重发就是真重复，只能靠这里记账。
 *   mode 为 null（手动脚本 scripts/lark-daily-report-now.mjs）不读不写记账，行为同以前。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { writeJsonAtomic } from './lark-fs.mjs'
import { localDateOf } from './lark-local-date.mjs'
import { sendGroupCard } from './lark-repo-delivery.mjs'
import { resolveWebhookCredentials } from './lark-repo-profile.mjs'

export const FEATURE_TABLE_SNAPSHOT = 'feature-table.json'
export const CODE_STATUS_SNAPSHOT = 'code-status.json'
export const DELIVERY_FILE = 'delivery.json'
const KEEP_DAYS = 14
const DAY = /^\d{4}-\d{2}-\d{2}$/

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}
const keepRecent = (byDate) => Object.fromEntries(Object.keys(byDate).filter((day) => DAY.test(day)).sort().slice(-KEEP_DAYS).map((day) => [day, byDate[day]]))

// 读快照历史；旧格式（单份快照：code-status 带 date，feature-table 只有 UTC 的 savedAt）按本地日期归到一天。
export const readSnapshotHistory = (path) => {
  const raw = readJson(path)
  if (!raw || typeof raw !== 'object') return {}
  if (raw.history && typeof raw.history === 'object') return raw.history
  const date = DAY.test(String(raw.date || '')) ? raw.date : localDateOf(raw.savedAt)
  return date ? { [date]: raw } : {}
}

// 基线 = 早于 today 的最近一份（当天重试 / 重发不拿自己当昨天）。
export const pickBaselineSnapshot = (history, today) => {
  const day = Object.keys(history || {}).filter((item) => DAY.test(item) && item < today).sort().at(-1)
  return day ? { ...history[day], date: day } : null
}

export const loadBaselineSnapshot = ({ dir, file, today }) => (dir ? pickBaselineSnapshot(readSnapshotHistory(join(dir, file)), today) : null)

export const recordDailySnapshot = ({ dir, file, date, payload, now = new Date() }) => {
  if (!dir) return
  const path = join(dir, file)
  writeJsonAtomic(path, { history: keepRecent({ ...readSnapshotHistory(path), [date]: { ...payload, date, savedAt: now.toISOString() } }) })
}

const NO_LEDGER = { mode: null, doc: () => null, isSent: () => false, mark: () => {}, setDoc: () => {} }

export const openDailyDelivery = ({ dir, date, mode = null }) => {
  if (mode !== 'resume' && mode !== 'fresh') return NO_LEDGER
  const path = join(dir, DELIVERY_FILE)
  let record = mode === 'resume' ? { ...(readJson(path)?.[date] || {}) } : {}
  const save = () => writeJsonAtomic(path, keepRecent({ ...(readJson(path) || {}), [date]: record }))
  if (mode === 'fresh') save()
  return {
    mode,
    doc: () => record.doc || null,
    isSent: (key) => Boolean(record.sent?.[key]),
    mark: (key, value = 'sent') => {
      record = { ...record, sent: { ...record.sent, [key]: value } }
      save()
    },
    setDoc: (doc) => {
      record = { ...record, doc }
      save()
    },
  }
}

// 发群（卡片 = markdown 元素 + 灰色署名；webhook 的 post 富文本在真实群里报 19002，2026-10-14）。
// 记账里已发过的群跳过；出口闸 / 只私聊拦下的（gated）也记账、算终态不算失败——否则每次重试都让只私聊群的原话再私发负责人一遍。
export const sendDailyToGroups = async ({ profile, targets, text, delivery = NO_LEDGER, sendHook, sendCard = sendGroupCard, webhookFor = resolveWebhookCredentials }) => {
  const outcomes = []
  for (const chatId of targets) {
    if (delivery.isSent(chatId)) {
      outcomes.push({ chatId, ok: true, skipped: 'already sent' })
      continue
    }
    const webhook = webhookFor(profile, chatId)
    if (!webhook) {
      outcomes.push({ chatId, ok: false, reason: '该群没有配置 webhook（外部群只能靠自定义机器人发）' })
      continue
    }
    const sent = await sendCard({ webhook, chatId, phase: 'daily_report', body: text, logPrefix: `daily report ${profile.key} -> ${chatId}`, ...(sendHook ? { sendHook } : {}) })
    if (sent?.ok || sent?.gated) delivery.mark(chatId, sent.ok ? 'sent' : 'gated')
    outcomes.push({ chatId, ...sent, ok: Boolean(sent?.ok || sent?.gated) })
  }
  return outcomes
}
