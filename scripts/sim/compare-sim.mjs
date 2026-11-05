#!/usr/bin/env node
/**
 * L2 / L3 对照（docs/replay/falive-replay-plan-2026-11-03.md §2）：模拟器跑完一个窗口后，把 lark-bot 在模拟里对每条真人消息的下文
 * （群里回了什么、私信负责人什么、任务最终状态 / 结论）和 falive 当时的下文（bot 当时的卡片、人的后续反应、审计结论）并排写成 md。
 *   node scripts/sim/compare-sim.mjs --sim smoke [--md]
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { AVEN_OPEN_ID, datasetDir, replayRoot } from './falive-data.mjs'

const args = process.argv.slice(2)
const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const simName = value('--sim', 'smoke')
const simDir = join(replayRoot, 'sim', simName)
const episodes = new Map(JSON.parse(readFileSync(join(datasetDir, 'episodes.json'), 'utf8')).map((e) => [e.id, e]))
const timeline = new Map(JSON.parse(readFileSync(join(datasetDir, 'timeline.json'), 'utf8')).map((m) => [m.id, m]))
const fed = JSON.parse(readFileSync(join(simDir, 'fed.json'), 'utf8'))
const outbox = existsSync(join(simDir, 'outbox.jsonl')) ? readFileSync(join(simDir, 'outbox.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
const tasksDir = join(simDir, 'runtime', 'lark-tasks')
const tasks = new Map()
if (existsSync(tasksDir)) for (const f of readdirSync(tasksDir)) if (f.endsWith('.json')) { try { const t = JSON.parse(readFileSync(join(tasksDir, f), 'utf8')); tasks.set(t.id, t) } catch { /* skip */ } }
const auditsDir = join(simDir, 'runtime', 'lark-audits')
const audits = new Map()
if (existsSync(auditsDir)) for (const project of readdirSync(auditsDir)) for (const f of readdirSync(join(auditsDir, project))) {
  const m = f.match(/^(.*)-e(\d+)\.json$/)
  if (!m) continue
  try {
    const a = JSON.parse(readFileSync(join(auditsDir, project, f), 'utf8'))
    if (!audits.has(m[1]) || audits.get(m[1]).epoch < Number(m[2])) audits.set(m[1], { epoch: Number(m[2]), ...a })
  } catch { /* skip */ }
}

const fmt = (ms) => new Date(ms).toISOString().slice(5, 16).replace('T', ' ')
const one = (t, n = 240) => String(t || '').replace(/\s+/g, ' ').slice(0, n)
// 模拟里对某条消息的下文：回复它的、它的任务 id 对应的发件（私信里带 taskId 的话 outbox 没记 taskId，按时间窗 + 文本兜底）。
const repliesTo = (id, atMs) => outbox.filter((o) => o.parentId === id || (o.kind === 'send' && o.at >= atMs && o.at <= atMs + 3 * 3600_000 && o.text.includes(id.slice(-6)) === false && false))
const dmsAround = (atMs) => outbox.filter((o) => o.kind === 'send' && o.userId === AVEN_OPEN_ID && o.at >= atMs && o.at <= atMs + 2 * 3600_000)

const lines = [`# 模拟 ${simName} 对照（${fed.length} 条真人消息，bot 发出 ${outbox.length} 条）`, '']
let counted = { replied: 0, silent: 0, tasks: 0 }
for (const id of fed) {
  const m = timeline.get(id)
  const e = episodes.get(id)
  const task = tasks.get(id)
  const replies = repliesTo(id, m.atMs)
  const interesting = m.atBot || m.chatKey === 'webhook-group' || e || task || replies.length
  if (!interesting) continue
  if (replies.length) counted.replied += 1
  else counted.silent += 1
  if (task) counted.tasks += 1
  lines.push(`## ${fmt(m.atMs)} ${m.chatKey} ${m.senderName}${m.atBot ? '（@bot）' : ''}：${one(m.text, 160)}`)
  lines.push(`- id ${id}`)
  if (e?.baseline.classified) lines.push(`- falive 当时：${e.baseline.classified.decision}/${e.baseline.classified.confidence}；${(e.baseline.routing || []).filter((l) => /入队|忽略|台账|suspected|outcome/.test(l)).slice(0, 2).map((l) => one(l, 100)).join(' | ')}`)
  if (e?.baseline.botReplies?.length) lines.push(`- falive 当时回复：${e.baseline.botReplies.slice(0, 2).map((r) => `（${fmt(r.atMs)}）${one(r.text, 200)}`).join('；')}`)
  if (e?.baseline.humanFollowups?.length) lines.push(`- 人的后续：${e.baseline.humanFollowups.slice(0, 2).map((r) => `（${fmt(r.atMs)}）${r.sender}：${one(r.text, 120)}`).join('；')}`)
  if (e?.baseline.audit) lines.push(`- falive 审计：${e.baseline.audit.status}；${one(e.baseline.audit.finalSummary, 200)}`)
  const cls = task?.intake?.classification
  if (task) lines.push(`- lark-bot 任务：${task.status}${cls ? `，分类 ${cls.decision}/${cls.confidence}${cls.deliverable ? `·${cls.deliverable}` : ''}` : ''}${task.result ? `；结果 ${one(task.result, 200)}` : ''}`)
  const audit = audits.get(id)
  if (audit?.final) lines.push(`- lark-bot 审计：${audit.status}；${one(audit.final.summary, 200)}`)
  lines.push(`- lark-bot 群里回复：${replies.length ? replies.map((r) => `（${fmt(r.at)}）${one(r.text, 240)}`).join('；') : '（没有）'}`)
  const dms = dmsAround(m.atMs)
  if (dms.length && (m.atBot || task)) lines.push(`- lark-bot 私信 aven（2h 内）：${dms.slice(0, 3).map((r) => one(r.text, 120)).join('；')}`)
  lines.push('')
}
lines.splice(1, 0, `回了 ${counted.replied}，没回 ${counted.silent}，建任务 ${counted.tasks}`, '')
const text = lines.join('\n')
if (args.includes('--md')) {
  writeFileSync(join(simDir, 'report.md'), text)
  console.log(`写到 ${join(simDir, 'report.md')}`)
} else console.log(text)
