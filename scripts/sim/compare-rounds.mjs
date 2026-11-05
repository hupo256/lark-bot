#!/usr/bin/env node
/**
 * 两轮模拟并排（docs/replay/falive-replay-plan-2026-11-03.md C 阶段）：同一批真人消息，基线代码 vs 修复代码各自的下文。
 *   node scripts/sim/compare-rounds.mjs --base full-a --fix fix-a [--md out.md]
 * 每条触发 bot 的消息一行：两轮各回了几条、第一句、任务终态；末尾汇总回复条数 / 重复回复 / 私信条数 / 任务状态分布。
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { AVEN_OPEN_ID, datasetDir, replayRoot } from './falive-data.mjs'

const args = process.argv.slice(2)
const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const baseName = value('--base', null)
const fixName = value('--fix', null)
if (!baseName || !fixName) throw new Error('--base / --fix 必填')
const timeline = new Map(JSON.parse(readFileSync(join(datasetDir, 'timeline.json'), 'utf8')).map((m) => [m.id, m]))

const loadSim = (name) => {
  const dir = join(replayRoot, 'sim', name)
  const fed = existsSync(join(dir, 'fed.json')) ? JSON.parse(readFileSync(join(dir, 'fed.json'), 'utf8')) : []
  const outbox = existsSync(join(dir, 'outbox.jsonl')) ? readFileSync(join(dir, 'outbox.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
  const tasks = new Map()
  const tasksDir = join(dir, 'runtime', 'lark-tasks')
  if (existsSync(tasksDir)) for (const f of readdirSync(tasksDir)) if (f.endsWith('.json')) { try { const t = JSON.parse(readFileSync(join(tasksDir, f), 'utf8')); tasks.set(t.id, t) } catch { /* skip */ } }
  return { fed: new Set(fed), outbox, tasks }
}
const base = loadSim(baseName)
const fix = loadSim(fixName)
const ids = [...base.fed].filter((id) => fix.fed.has(id))
const one = (t, n = 100) => String(t || '').replace(/\s+/g, ' ').slice(0, n)
const repliesTo = (sim, id) => sim.outbox.filter((o) => o.parentId === id)
const dmCount = (sim) => sim.outbox.filter((o) => o.kind === 'send' && o.userId === AVEN_OPEN_ID).length
const dupes = (sim) => {
  const seen = new Map()
  let n = 0
  for (const o of sim.outbox) {
    if (!o.parentId) continue
    const key = `${o.parentId}|${o.text.slice(0, 60)}`
    if (seen.has(key)) n += 1
    seen.set(key, true)
  }
  return n
}
const statusDist = (sim) => {
  const d = {}
  for (const t of sim.tasks.values()) d[t.status] = (d[t.status] || 0) + 1
  return Object.entries(d).sort().map(([k, v]) => `${k}=${v}`).join(' ')
}

const lines = [`# 两轮对照：${baseName}（基线）vs ${fixName}（修复）——共同喂过 ${ids.length} 条`, '']
lines.push(`| 汇总 | 基线 | 修复 |`, `|---|---|---|`)
lines.push(`| 群里回复条数 | ${base.outbox.filter((o) => o.kind === 'reply').length} | ${fix.outbox.filter((o) => o.kind === 'reply').length} |`)
lines.push(`| 对同一条消息的重复回复 | ${dupes(base)} | ${dupes(fix)} |`)
lines.push(`| 私信 aven 条数 | ${dmCount(base)} | ${dmCount(fix)} |`)
lines.push(`| 任务状态 | ${statusDist(base)} | ${statusDist(fix)} |`, '')
for (const id of ids) {
  const m = timeline.get(id)
  const b = repliesTo(base, id)
  const f = repliesTo(fix, id)
  const bt = base.tasks.get(id)
  const ft = fix.tasks.get(id)
  if (!b.length && !f.length && !bt && !ft) continue
  const stamp = new Date(m.atMs).toISOString().slice(5, 16).replace('T', ' ')
  lines.push(`## ${stamp} ${m.chatKey} ${m.senderName}${m.atBot ? '（@bot）' : ''}：${one(m.text, 120)}`)
  lines.push(`- 基线：${b.length} 条回复${bt ? `，任务 ${bt.status}${bt.intake?.classification ? `（${bt.intake.classification.decision}/${bt.intake.classification.deliverable || '-'}）` : ''}` : ''}${b[0] ? `；首句「${one(b[0].text, 120)}」` : ''}${b[1] ? `；次句「${one(b[1].text, 80)}」` : ''}`)
  lines.push(`- 修复：${f.length} 条回复${ft ? `，任务 ${ft.status}${ft.intake?.classification ? `（${ft.intake.classification.decision}/${ft.intake.classification.deliverable || '-'}）` : ''}` : ''}${f[0] ? `；首句「${one(f[0].text, 120)}」` : ''}${f[1] ? `；次句「${one(f[1].text, 80)}」` : ''}`)
  lines.push('')
}
const text = lines.join('\n')
const out = value('--md', null)
if (out) {
  writeFileSync(out, text)
  console.log(`写到 ${out}`)
} else console.log(text)
