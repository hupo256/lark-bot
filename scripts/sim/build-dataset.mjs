#!/usr/bin/env node
/**
 * 把 falive 实战数据拼成回放数据集（docs/replay/falive-replay-plan-2026-11-03.md §1）：
 *   runtime/falive-replay/dataset/timeline.json   三个群的全部消息（按时间）
 *   runtime/falive-replay/dataset/episodes.json   每条「falive 分类过 / @bot / aven 在通知群说的」消息 + 基线（网关分类、路由行、台账、审计、bot 的回复、人的后续）
 *   node scripts/sim/build-dataset.mjs [--stats]
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { AVEN_OPEN_ID, auditSummary, datasetDir, loadAudits, loadGatewayBaseline, loadLedger, loadTimeline, loadWorkerClaimedTexts } from './falive-data.mjs'

const timeline = loadTimeline()
const gateway = loadGatewayBaseline()
const claimed = loadWorkerClaimedTexts()
const ledger = loadLedger()
const audits = loadAudits()
const byId = new Map(timeline.map((m) => [m.id, m]))

const FOLLOW_MS = 2 * 60 * 60_000
const after = (m, pred, limit) => {
  const out = []
  for (const x of timeline) {
    if (x.chatId !== m.chatId || x.atMs <= m.atMs || x.id === m.id) continue
    if (x.atMs - m.atMs > FOLLOW_MS) break
    if (pred(x)) out.push(x)
    if (out.length >= limit) break
  }
  return out
}
// bot 的回复存全文（裁判要看 falive 当时完整回了什么；11-04 前截 400 字，1210 条里 245 条被截断）；人的后续仍截 400 字。
const brief = (x) => ({ id: x.id, atMs: x.atMs, sender: x.senderName, ownBot: x.ownBot, text: x.ownBot ? String(x.text || '') : String(x.text || '').slice(0, 400) })

// 哪些消息算一个 episode：网关分类过的；或 @bot 的；或 aven 在通知群说的（私聊指示走通知群）。
const episodeIds = new Set(gateway.classified.keys())
for (const m of timeline) {
  if (m.deleted || m.ownBot || m.senderType === 'system') continue
  if (m.atBot) episodeIds.add(m.id)
  if (m.chatKey === 'webhook-group' && m.senderId === AVEN_OPEN_ID) episodeIds.add(m.id)
}

const episodes = []
for (const id of episodeIds) {
  const m = byId.get(id) || null
  const audit = auditSummary(audits.get(id))
  const cls = gateway.classified.get(id) || null
  const ledgerEvent = ledger.byMessage.get(id) || null
  const claimedText = claimed.get(id) || null
  if (!m && !audit && !claimedText) {
    episodes.push({ id, inTimeline: false, chatId: ledgerEvent?.chatId || null, text: null, baseline: { classified: cls, ledger: ledgerEvent, routing: gateway.lines.get(id) || [] }, note: '无原文（融合群 / 已删除）' })
    continue
  }
  episodes.push({
    id,
    inTimeline: Boolean(m),
    chatId: m?.chatId || audit?.chatId || ledgerEvent?.chatId || null,
    chatKey: m?.chatKey || null,
    atMs: m?.atMs || (audit?.startedAt ? Date.parse(audit.startedAt) : null),
    sender: m ? { id: m.senderId, name: m.senderName, isAven: m.isAven } : null,
    atBot: m?.atBot ?? null,
    replyTo: m?.parentId || null,
    threadId: m?.threadId || null,
    text: m?.text ?? null,
    // 分类器当时看到的正文（优先审计，其次 worker 日志）：含被引用 / 话题 / 群里之前的消息块。
    seenText: audit?.text || claimedText || null,
    baseline: {
      classified: cls,
      routing: gateway.lines.get(id) || [],
      ledger: ledgerEvent ? { decision: ledgerEvent.decision, items: ledgerEvent.items, excerpt: ledgerEvent.excerpt } : null,
      audit,
      botReplies: m ? after(m, (x) => x.ownBot, 6).map(brief) : [],
      humanFollowups: m ? after(m, (x) => !x.ownBot && x.senderType === 'user' && (x.senderId === m.senderId || x.atBot || x.parentId === m.id), 6).map(brief) : [],
    },
  })
}
episodes.sort((a, b) => (a.atMs || 0) - (b.atMs || 0))

mkdirSync(datasetDir, { recursive: true })
writeFileSync(join(datasetDir, 'timeline.json'), JSON.stringify(timeline, null, 1))
writeFileSync(join(datasetDir, 'episodes.json'), JSON.stringify(episodes, null, 1))

const count = (list, fn) => list.reduce((n, x) => n + (fn(x) ? 1 : 0), 0)
console.log(`timeline ${timeline.length} 条（bot ${count(timeline, (m) => m.ownBot)}，@bot ${count(timeline, (m) => m.atBot && !m.ownBot)}，aven ${count(timeline, (m) => m.isAven)}）`)
console.log(`episodes ${episodes.length}：有原文 ${count(episodes, (e) => e.inTimeline)}，只有审计/worker 原文 ${count(episodes, (e) => !e.inTimeline && e.seenText)}，无原文 ${count(episodes, (e) => !e.inTimeline && !e.seenText)}`)
const dist = {}
for (const e of episodes) {
  const k = `${e.inTimeline ? 'timeline' : e.seenText ? 'text-only' : 'none'}/${e.baseline.classified?.decision || 'unlogged'}`
  dist[k] = (dist[k] || 0) + 1
}
console.log(Object.entries(dist).sort().map(([k, v]) => `${k}=${v}`).join('  '))
console.log(`台账覆盖 ${count(episodes, (e) => e.baseline.ledger)}，审计覆盖 ${count(episodes, (e) => e.baseline.audit)}，有 bot 回复 ${count(episodes, (e) => e.baseline.botReplies?.length)}`)
