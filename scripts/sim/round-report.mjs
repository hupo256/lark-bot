#!/usr/bin/env node
/**
 * 一轮回放的进度 + 总账（docs/falive-replay-plan-2026-11-03.md 39）：
 *   node scripts/sim/round-report.mjs --round r8 [--md out.md] [--issues]
 * 按组跑（run-episodes.mjs，sim/<轮>/<组>/）：每组 case 数、喂了几条、任务状态、发件、进程树内存峰值、出网审计（违规 / 待核）、状态；
 *   下面列全部出网违规与待核（design-v2 §8 前置 7）和内存汇总（P0-e）。
 * 按天分段（旧 run-round.sh，sim/<轮>-<段>/）：每段时钟、喂、任务、裁判。
 * 两种布局都有裁判结果（judge.jsonl）就汇总：falive 好 / 一样 / lark-bot 好，--issues 把 falive 更好的按 larkIssue 归类列出。
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { auditEgress } from './egress-audit.mjs'
import { replayRoot } from './falive-data.mjs'

const args = process.argv.slice(2)
const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const round = value('--round', null)
if (!round) throw new Error('--round 必填')
const simRoot = join(replayRoot, 'sim')
const readJsonl = (p) => (existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) : [])
const readJson = (p, fallback = null) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return fallback } }
const taskDist = (dir) => {
  const tasksDir = join(dir, 'runtime', 'lark-tasks')
  const dist = {}
  if (existsSync(tasksDir)) for (const f of readdirSync(tasksDir)) if (f.endsWith('.json')) { const t = readJson(join(tasksDir, f)); if (t) dist[t.status] = (dist[t.status] || 0) + 1 }
  return Object.entries(dist).map(([k, v]) => `${k}=${v}`).join(' ')
}
const episodeRoot = join(simRoot, round)
const allJudge = []
let lines
if (existsSync(join(episodeRoot, 'round.json'))) {
  const meta = readJson(join(episodeRoot, 'round.json'), {})
  const eps = readdirSync(episodeRoot, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(episodeRoot, d.name, 'meta.json'))).map((d) => d.name).sort()
  lines = [`# ${round} 按事件组回放（${eps.length} 组；代码 ${meta.head || '-'}，指纹 ${meta.fingerprint || '-'}）`, '',
    '| 组 | case | 喂 | 任务 | 发件 | 内存峰值 MB | 出网 违规/待核 | 裁判 falive/一样/lark-bot/都错 | 状态 |', '|---|---|---|---|---|---|---|---|---|']
  const violations = []
  const review = []
  const peaks = []
  for (const ep of eps) {
    const dir = join(episodeRoot, ep)
    const m = readJson(join(dir, 'meta.json'), {})
    const fed = readJson(join(dir, 'fed.json'), []).length
    const outbox = existsSync(join(dir, 'outbox.jsonl')) ? readFileSync(join(dir, 'outbox.jsonl'), 'utf8').split('\n').filter(Boolean).length : 0
    const peak = readJson(join(dir, 'mem-peak.json'), {})
    if (peak.rssMb) peaks.push({ ep, ...peak })
    const eg = existsSync(join(dir, 'egress.log')) || existsSync(join(dir, 'cli-calls.log')) ? auditEgress(dir) : null
    for (const v of eg?.violations || []) violations.push({ ep, ...v })
    for (const v of eg?.review || []) review.push({ ep, ...v })
    const judge = readJsonl(join(dir, 'judge.jsonl'))
    allJudge.push(...judge)
    const c = (b) => judge.filter((j) => j.better === b).length
    const done = readJson(join(dir, 'DONE'))
    const state = done ? `完成（${done.realMin} 分钟）` : existsSync(join(dir, 'FAILED')) ? `失败：${JSON.stringify(readJson(join(dir, 'FAILED'), {})).slice(0, 80)}` : '跑'
    lines.push(`| ${ep} | ${(m.caseIds || []).length} | ${fed} | ${taskDist(dir)} | ${outbox} | ${peak.rssMb ?? '-'} | ${eg ? `${eg.violations.length}/${eg.review.length}` : '-'} | ${judge.length ? `${c('falive')}/${c('same')}/${c('lark-bot')}/${c('both_wrong')}` : '-'} | ${state} |`)
  }
  lines.push('', `## 出网审计：违规 ${violations.length}，待核 ${review.length}`, '')
  for (const v of violations) lines.push(`- **违规** ${v.ep} ${v.at || ''} ${v.via || ''} ${v.method || ''} ${v.host || ''}${v.path || ''}：${v.reason}`)
  for (const v of review) lines.push(`- 待核 ${v.ep} ${v.at || ''} ${v.via || ''} ${v.host || ''}${v.port ? `:${v.port}` : ''}${v.proc ? `（${v.proc}）` : ''}：${v.reason}`)
  if (peaks.length) {
    const max = peaks.reduce((a, b) => (b.rssMb > a.rssMb ? b : a))
    lines.push('', `## 内存：${peaks.length} 组有采样，单组进程树峰值最高 ${max.rssMb}MB（${max.ep}，${max.at}：${Object.entries(max.byCommMb || {}).map(([k, v]) => `${k} ${v}`).join('、')}），中位 ${peaks.map((p) => p.rssMb).sort((a, b) => a - b)[Math.floor(peaks.length / 2)]}MB`)
  }
} else {
const segs = readdirSync(simRoot, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith(`${round}-`) && !d.name.includes('.')).map((d) => d.name).sort()
lines = [`# ${round} 分段回放`, '', '| 段 | 时钟 | 喂 | 任务 | 裁判 falive/一样/lark-bot/都错 | 状态 |', '|---|---|---|---|---|---|']
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
