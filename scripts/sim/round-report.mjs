#!/usr/bin/env node
/**
 * 一轮回放的进度 + 总账（docs/replay/falive-replay-plan-2026-11-03.md 39）：
 *   node scripts/sim/round-report.mjs --round r8 [--md out.md] [--issues]
 * 段 = sim 目录（scripts/sim/sim-dir.mjs）：旧布局 sim/<轮>-<段>/（按天分段，run-round.sh），新布局 sim/<轮>/<事件组>/（run-episodes.mjs）都认。
 * 按组跑的：每组 case 数、喂了几条、任务状态、发件、进程树内存峰值（P0-e）、出网审计违规 / 待核（design-v2 §8 前置 7）、状态；
 *   表下列出全部出网违规与待核、内存汇总。按天分段的：每段时钟、喂、任务、裁判。
 * 都有裁判结果（judge.jsonl）就汇总：falive 好 / 一样 / lark-bot 好 / 都错 · 待办不计分（pending）；--issues 把 falive 更好的按 larkIssue 归类列出。
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { auditEgress } from './egress-audit.mjs'
import { replayRoot } from './falive-data.mjs'
import { listSimDirs, readJsonl } from './sim-dir.mjs'

const args = process.argv.slice(2)
const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const round = value('--round', null)
if (!round) throw new Error('--round 必填')
const readJson = (p, fallback = null) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return fallback } }
const taskDist = (dir) => {
  const tasksDir = join(dir, 'runtime', 'lark-tasks')
  const dist = {}
  if (existsSync(tasksDir)) for (const f of readdirSync(tasksDir)) if (f.endsWith('.json')) { const t = readJson(join(tasksDir, f)); if (t) dist[t.status] = (dist[t.status] || 0) + 1 }
  return Object.entries(dist).map(([k, v]) => `${k}=${v}`).join(' ')
}
const judgeCell = (judge) => {
  const c = (b) => judge.filter((j) => j.better === b).length
  return judge.length ? `${c('falive')}/${c('same')}/${c('lark-bot')}/${c('both_wrong')} · ${c('pending')}` : '-'
}
const all = listSimDirs({ round })
const episodes = all.filter((e) => e.episodeId)
const segments = all.filter((e) => !e.episodeId)
const allJudge = []
const lines = []

if (episodes.length) {
  const meta = readJson(join(replayRoot, 'sim', round, 'round.json'), {})
  lines.push(`# ${round} 按事件组回放（${episodes.length} 组；代码 ${meta.head || '-'}，指纹 ${meta.fingerprint || '-'}）`, '',
    '| 组 | case | 喂 | 任务 | 发件 | 内存峰值 MB | 出网 违规/待核 | 裁判 falive/一样/lark-bot/都错 · 待办 | 状态 |', '|---|---|---|---|---|---|---|---|---|')
  const violations = []
  const review = []
  const peaks = []
  for (const { dir, episodeId: ep } of episodes) {
    const m = readJson(join(dir, 'meta.json'), {})
    const fed = readJson(join(dir, 'fed.json'), []).length
    const outbox = readJsonl(join(dir, 'outbox.jsonl')).length
    const peak = readJson(join(dir, 'mem-peak.json'), {})
    if (peak.rssMb) peaks.push({ ep, ...peak })
    const eg = auditEgress(dir)
    for (const v of eg.violations) violations.push({ ep, ...v })
    for (const v of eg.review) review.push({ ep, ...v })
    const judge = readJsonl(join(dir, 'judge.jsonl'))
    allJudge.push(...judge)
    const done = readJson(join(dir, 'DONE'))
    const state = done ? `完成（${done.realMin} 分钟）` : existsSync(join(dir, 'FAILED')) ? `失败：${JSON.stringify(readJson(join(dir, 'FAILED'), {})).slice(0, 80)}` : '跑'
    lines.push(`| ${ep} | ${(m.caseIds || []).length} | ${fed} | ${taskDist(dir)} | ${outbox} | ${peak.rssMb ?? '-'} | ${eg.violations.length}/${eg.review.length} | ${judgeCell(judge)} | ${state} |`)
  }
  lines.push('', `## 出网审计：违规 ${violations.length}，待核 ${review.length}`, '')
  for (const v of violations) lines.push(`- **违规** ${v.ep} ${v.at || ''} ${v.via || ''} ${v.method || ''} ${v.host || ''}${v.path || ''}：${v.reason}`)
  for (const v of review) lines.push(`- 待核 ${v.ep} ${v.at || ''} ${v.via || ''} ${v.host || ''}${v.port ? `:${v.port}` : ''}${v.proc ? `（${v.proc}）` : ''}：${v.reason}`)
  if (peaks.length) {
    const max = peaks.reduce((a, b) => (b.rssMb > a.rssMb ? b : a))
    const sorted = peaks.map((p) => p.rssMb).sort((a, b) => a - b)
    lines.push('', `## 内存：${peaks.length} 组有采样，单组进程树峰值最高 ${max.rssMb}MB（${max.ep}，${max.at}：${Object.entries(max.byCommMb || {}).map(([k, v]) => `${k} ${v}`).join('、')}），中位 ${sorted[Math.floor(sorted.length / 2)]}MB`)
  }
  lines.push('')
}
if (segments.length) {
  lines.push(`# ${round} 分段回放`, '', '| 段 | 时钟 | 喂 | 任务 | 裁判 falive/一样/lark-bot/都错 · 待办 | 状态 |', '|---|---|---|---|---|---|')
  for (const { dir, label: seg } of segments) {
    const clock = readJson(join(dir, 'clock.json'))
    const now = clock ? clock.virtualMs + (Date.now() - clock.realMs) : null
    const fed = readJson(join(dir, 'fed.json'), []).length
    const judge = readJsonl(join(dir, 'judge.jsonl'))
    allJudge.push(...judge)
    const done = existsSync(join(dir, 'DONE')) ? `完成（${readFileSync(join(dir, 'DONE'), 'utf8').trim()}）` : existsSync(join(dir, 'judge.out')) ? '裁判中' : '跑'
    lines.push(`| ${seg} | ${now ? new Date(now).toISOString().slice(5, 16) : '-'} | ${fed} | ${taskDist(dir)} | ${judgeCell(judge)} | ${done} |`)
  }
  lines.push('')
}
const c = (b) => allJudge.filter((j) => j.better === b).length
lines.push(`**全轮裁判 ${allJudge.length - c('pending')} 条：falive 更好 ${c('falive')}，一样 ${c('same')}，lark-bot 更好 ${c('lark-bot')}，都不对 ${c('both_wrong')}；待办不计分 ${c('pending')}**`, '')
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
