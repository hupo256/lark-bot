#!/usr/bin/env node
/**
 * 入口指标（阶段 6）：从 runtime/lark-tasks + runtime/lark-outbox 算最近 N 天某仓的响应与识别情况，不碰 gateway、不发消息。
 * 用法：node scripts/lark-intake-stats.mjs [repoKey=falive] [days=1] [--json]
 *   响应 = 收到（intake.receivedAt）→ 第一条群里可见输出（发件簿里该任务最早一条非 gated）；分类 = 收到 → intake.resolvedAt；
 *   分道占比、补充合并数、默认锚点命中 / 分类器确认（continues）、出口闸拦截数（按原因）。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { listOutbox, outboxDir } from '../lib/lark-outbox.mjs'
import { larkTasksDir } from '../lib/lark-repo.mjs'

const args = process.argv.slice(2)
const positional = args.filter((item) => !item.startsWith('--'))
const key = positional[0] || 'falive'
const days = Number(positional[1] || 1)
const asJson = args.includes('--json')
const sinceMs = Date.now() - days * 24 * 60 * 60_000

const ms = (value) => Date.parse(value || '') || 0
const median = (list) => {
  if (!list.length) return null
  const sorted = [...list].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}
const sec = (value) => (value == null ? '-' : `${Math.round(value / 1000)}s`)

export const computeIntakeStats = ({ tasks, outboxByChat, sinceMs: since }) => {
  const scoped = tasks.filter((task) => task.intake && ms(task.intake.receivedAt || task.createdAt) >= since)
  const firstOutputMs = (task) => {
    const entries = (outboxByChat.get(task.chatId) || []).filter((entry) => entry.taskId === task.id && !entry.gated)
    return entries.length ? Math.min(...entries.map((entry) => ms(entry.at))) : 0
  }
  const lanes = { fast: 0, slow: 0, unknown: 0 }
  const respond = []
  const classify = []
  let supplements = 0
  let anchors = 0
  let continues = 0
  const decisions = {}
  for (const task of scoped) {
    const lane = task.intake.lane || 'unknown'
    lanes[lane] = (lanes[lane] || 0) + 1
    const received = ms(task.intake.receivedAt || task.createdAt)
    const resolved = ms(task.intake.resolvedAt)
    if (received && resolved) classify.push(resolved - received)
    const first = firstOutputMs(task)
    if (received && first) respond.push(first - received)
    supplements += (String(task.text || '').match(/【话题补充 /g) || []).length
    if (task.anchor) anchors += 1
    if (task.intake.classification?.continues) continues += 1
    const decision = task.intake.classification?.decision || (task.intake.error ? 'error' : 'pending')
    decisions[decision] = (decisions[decision] || 0) + 1
  }
  const gated = {}
  let sent = 0
  for (const entries of outboxByChat.values()) {
    for (const entry of entries) {
      if (ms(entry.at) < since) continue
      if (entry.gated) gated[entry.gated.replace(/\d{2}:\d{2}/g, 'HH:MM').replace(/new#\w+|[^\s]+#\w+/g, '<主题>')] = (gated[entry.gated.replace(/\d{2}:\d{2}/g, 'HH:MM').replace(/new#\w+|[^\s]+#\w+/g, '<主题>')] || 0) + 1
      else sent += 1
    }
  }
  return {
    tasks: scoped.length,
    lanes,
    decisions,
    respondMedianMs: median(respond),
    respondSamples: respond.length,
    classifyMedianMs: median(classify),
    classifySamples: classify.length,
    supplementsMerged: supplements,
    anchorHits: anchors,
    continuesConfirmed: continues,
    groupSent: sent,
    gated,
  }
}

const tasks = readdirSync(larkTasksDir).filter((name) => name.endsWith('.json'))
  .map((name) => { try { return JSON.parse(readFileSync(join(larkTasksDir, name), 'utf8')) } catch { return null } })
  .filter((task) => task && task.repo === key)
const chatIds = [...new Set(tasks.map((task) => task.chatId).filter(Boolean))]
const outboxByChat = new Map(chatIds.map((chatId) => [chatId, listOutbox({ chatId, sinceMs })]))
const stats = computeIntakeStats({ tasks, outboxByChat, sinceMs })

if (asJson) {
  console.log(JSON.stringify({ repo: key, days, ...stats }, null, 2))
} else {
  console.log(`入口指标 ${key} · 最近 ${days} 天（发件簿 ${outboxDir}）`)
  console.log(`- 任务 ${stats.tasks}：快道 ${stats.lanes.fast} / 慢道 ${stats.lanes.slow} / 未分道 ${stats.lanes.unknown}`)
  console.log(`- 分类结果：${Object.entries(stats.decisions).map(([k, v]) => `${k} ${v}`).join('、') || '-'}`)
  console.log(`- 收到 → 第一条群里可见输出：中位 ${sec(stats.respondMedianMs)}（${stats.respondSamples} 条有输出）`)
  console.log(`- 收到 → 分类完成：中位 ${sec(stats.classifyMedianMs)}（${stats.classifySamples} 条）`)
  console.log(`- 话题补充并入 ${stats.supplementsMerged} 条；默认锚点命中 ${stats.anchorHits}，分类器确认延续 ${stats.continuesConfirmed}`)
  console.log(`- 群里发出 ${stats.groupSent} 条；出口闸拦下 ${Object.values(stats.gated).reduce((a, b) => a + b, 0)} 条${Object.keys(stats.gated).length ? `：${Object.entries(stats.gated).map(([k, v]) => `${k} ×${v}`).join('；')}` : ''}`)
}
