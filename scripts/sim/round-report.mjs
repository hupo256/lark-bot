#!/usr/bin/env node
/**
 * 一轮分段并行回放的进度 + 总账（docs/falive-replay-plan-2026-11-03.md 39）：
 *   node scripts/sim/round-report.mjs --round r8 [--md out.md] [--issues]
 * 每段：虚拟时钟到哪、喂了几条、任务状态、裁判分布；全轮：falive 好 / 一样 / lark-bot 好，falive 更好的按 larkIssue 归类列出。
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { replayRoot } from './falive-data.mjs'

const args = process.argv.slice(2)
const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const round = value('--round', null)
if (!round) throw new Error('--round 必填')
const simRoot = join(replayRoot, 'sim')
const readJsonl = (p) => (existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) : [])
const segs = readdirSync(simRoot).filter((d) => d.startsWith(`${round}-`)).sort()
const lines = [`# ${round} 分段回放`, '', '| 段 | 时钟 | 喂 | 任务 | 裁判 falive/一样/lark-bot/都错 | 状态 |', '|---|---|---|---|---|---|']
const allJudge = []
for (const seg of segs) {
  const dir = join(simRoot, seg)
  const clock = existsSync(join(dir, 'clock.json')) ? JSON.parse(readFileSync(join(dir, 'clock.json'), 'utf8')) : null
  const now = clock ? clock.virtualMs + (Date.now() - clock.realMs) : null
  const fed = existsSync(join(dir, 'fed.json')) ? JSON.parse(readFileSync(join(dir, 'fed.json'), 'utf8')).length : 0
  const tasksDir = join(dir, 'runtime', 'lark-tasks')
  const dist = {}
  if (existsSync(tasksDir)) for (const f of readdirSync(tasksDir)) if (f.endsWith('.json')) { try { const t = JSON.parse(readFileSync(join(tasksDir, f), 'utf8')); dist[t.status] = (dist[t.status] || 0) + 1 } catch { /* skip */ } }
  const judge = readJsonl(join(dir, 'judge.jsonl'))
  allJudge.push(...judge)
  const c = (b) => judge.filter((j) => j.better === b).length
  const done = existsSync(join(dir, 'DONE')) ? `完成（${readFileSync(join(dir, 'DONE'), 'utf8').trim()}）` : existsSync(join(dir, 'judge.out')) ? '裁判中' : '跑'
  lines.push(`| ${seg} | ${now ? new Date(now).toISOString().slice(5, 16) : '-'} | ${fed} | ${Object.entries(dist).map(([k, v]) => `${k}=${v}`).join(' ')} | ${c('falive')}/${c('same')}/${c('lark-bot')}/${c('both_wrong')} | ${done} |`)
}
const c = (b) => allJudge.filter((j) => j.better === b).length
lines.push('', `**全轮裁判 ${allJudge.length} 条：falive 更好 ${c('falive')}，一样 ${c('same')}，lark-bot 更好 ${c('lark-bot')}，都不对 ${c('both_wrong')}**`, '')
if (args.includes('--issues')) {
  const byIssue = {}
  for (const j of allJudge.filter((x) => x.better === 'falive' || x.better === 'both_wrong')) (byIssue[j.larkIssue || '-'] ||= []).push(j)
  for (const [issue, list] of Object.entries(byIssue).sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`## ${issue}（${list.length}）`)
    for (const j of list) lines.push(`- ${j.sim} ${String(j.at).slice(5, 16)} ${j.chatKey} ${j.sender}：${String(j.text).replace(/\s+/g, ' ').slice(0, 80)}\n  - ${j.reason}\n  - 应当：${j.idealBehavior || '-'}（${j.id}）`)
    lines.push('')
  }
}
const text = lines.join('\n')
const out = value('--md', null)
if (out) { writeFileSync(out, text); console.log(`写到 ${out}`) } else console.log(text)
