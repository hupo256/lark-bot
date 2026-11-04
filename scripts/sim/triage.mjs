#!/usr/bin/env node
/**
 * 分诊（design-v2 §11）：把一轮里已判的「falive 更好 / 都不对」汇成一张表，附 lark-bot 的分类 / 交付物 / 终态 / 首句时延 / 群里句数，
 * 供按根因归类、派修复分支。边跑边用：只读已跑完（有 judge.jsonl）的组。
 *   node scripts/sim/triage.mjs --round b2 [--md out.md]
 * 模拟局限（acceptance.simLimitOf：裁判判 cause=sim_limit 或硬局限旗标）不派修复，单列一节「模拟局限」，附旗标原因。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { simLimitOf } from './acceptance.mjs'
import { casesDir, replayRoot } from './falive-data.mjs'

const args = process.argv.slice(2)
const value = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d)
const round = value('--round', 'b2')
const root = join(replayRoot, 'sim', round)
const cases = new Map(readFileSync(join(casesDir, 'cases.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { const c = JSON.parse(l); return [c.id, c] }))
const tags = new Map(readFileSync(join(casesDir, 'case-tags.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { const t = JSON.parse(l); return [t.id, t] }))
const one = (t, n) => String(t || '').replace(/\s+/g, ' ').slice(0, n)
const rows = []
const tally = { done: 0, judged: 0, better: {}, simLimit: 0 }
for (const ep of readdirSync(root).filter((d) => d.startsWith('ep-'))) {
  const dir = join(root, ep)
  if (existsSync(join(dir, 'DONE'))) tally.done += 1
  const jp = join(dir, 'judge.jsonl')
  if (!existsSync(jp)) continue
  const rules = existsSync(join(dir, 'rules.jsonl')) ? new Map(readFileSync(join(dir, 'rules.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { const r = JSON.parse(l); return [r.id, r] })) : new Map()
  for (const l of readFileSync(jp, 'utf8').split('\n').filter(Boolean)) {
    const j = JSON.parse(l)
    tally.judged += 1
    tally.better[j.better] = (tally.better[j.better] || 0) + 1
    if (!['falive', 'both_wrong'].includes(j.better)) continue
    const rule = rules.get(j.id) || {}
    const simLimit = simLimitOf({ verdict: j, flags: rule.flags || j.flags || [] })
    if (simLimit) tally.simLimit += 1
    const limitWhy = (rule.simLimits || j.simLimits || []).map((x) => `${x.flag.replace('sim_limit_', '')}：${x.why}`).join('；')
    const tp = join(dir, 'runtime', 'lark-tasks', `${j.id}.json`)
    const t = existsSync(tp) ? JSON.parse(readFileSync(tp, 'utf8')) : null
    const r = rules.get(j.id) || {}
    const cls = t?.intake?.classification
    rows.push({ ep, id: j.id, better: j.better, issue: simLimit ? '模拟局限（不计分、不派修复）' : j.larkIssue || '-', limit: simLimit ? `${simLimit}${limitWhy ? `｜${one(limitWhy, 220)}` : ''}` : (limitWhy ? `（有软局限，裁判仍判 ${j.cause}）${one(limitWhy, 160)}` : ''), risk: (tags.get(j.id)?.risk || []).join('/'), kind: tags.get(j.id)?.kind || '-',
      text: one(cases.get(j.id)?.text, 70), lark: `${cls?.decision || '-'}·${cls?.deliverable || '-'} → ${t?.status || (t ? '?' : '无任务')}${t?.supersededBy ? `（并入 ${t.supersededBy.slice(-6)}）` : ''}`,
      latency: r.lark?.firstReplyMs != null ? Math.round(r.lark.firstReplyMs / 1000) : null, replies: r.lark?.replyCount ?? null, reason: one(j.reason, 160), ideal: one(j.idealBehavior, 90) })
  }
}
const by = {}
for (const r of rows) (by[r.issue] ||= []).push(r)
const md = [`# ${round} 分诊（${new Date().toISOString().slice(5, 16)}）：已完成 ${tally.done} 组，已判 ${tally.judged} 条 ${JSON.stringify(tally.better)}；其中 falive / 都不对里模拟局限 ${tally.simLimit} 条`, '',
  ...Object.entries(by).sort((a, b) => b[1].length - a[1].length).flatMap(([issue, list]) => [`## ${issue}（${list.length}）`, '',
    ...list.map((r) => `- **${r.better}** ${r.ep} \`${r.id.slice(-8)}\` [${r.kind}${r.risk ? ` ${r.risk}` : ''}] ${r.text}\n  - lark-bot：${r.lark}；首句 ${r.latency ?? '-'}s；群里 ${r.replies ?? '-'} 句\n  - ${r.reason}\n  - 应当：${r.ideal}${r.limit ? `\n  - 局限：${r.limit}` : ''}`), ''])]
const out = value('--md', join(replayRoot, 'sim', round, 'triage.md'))
writeFileSync(out, `${md.join('\n')}\n`)
console.log(md[0]); console.log(Object.entries(by).map(([k, v]) => `${k} ${v.length}`).join('，'))
