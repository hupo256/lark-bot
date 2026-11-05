#!/usr/bin/env node
/**
 * 实测类 case 的当时证据（docs/replay/falive-replay-design-v2.md §5「实测类 case」、§8 P0-c）：
 * 回放打到的是今天的 pre / OL，不是当时的环境，裁判看过程不看结论——所以先把 falive 当时实际看到了什么（打了哪些接口、
 * HTTP 码 / 关键字段、页面现象、环境通不通）抽出来，给裁判当参照。
 *   来源优先级：关联的 falive 审计（final.checks / 结论，只到 10-27 起）→ falive 当时在群里的实测回报（时间线里的 bot 卡片）。
 *   两样都没有的照样出一行，evidence=null，标「无证据」。
 *   node scripts/sim/verification-evidence.mjs   → replay/falive/verification-evidence.jsonl（读 case-tags.jsonl 里 kind=verification 的）
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { loadCaseContext, one, strip } from './case-context.mjs'
import { casesDir } from './falive-data.mjs'

const MAX = 300
const tags = readFileSync(join(casesDir, 'case-tags.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const { contextOf, cases } = loadCaseContext()
// match：audit（审计里关联到的）/ strong（群里回报，和原话词重合高，或在同一人下一条消息之前）/ weak（认领没把握）
const caseById = new Map(cases.map((c) => [c.id, c]))

const ENV_RE = { pre: /falivepre|\bpre\b|PRE/i, uat: /faliveuat|\buat\b/i, online: /\bOL\b|online|生产|线上|www\.falive\.com/i, local: /localhost|本地/ }
const envOf = (...texts) => {
  for (const t of texts) {
    const hit = Object.keys(ENV_RE).filter((k) => ENV_RE[k].test(t || ''))
    if (hit.length) return hit
  }
  return []
}
// 环境当时不通的迹象（网关 5xx、连不上、超时）；业务码（-1、-700）不算环境挂。
const DOWN_RE = /\b50[234]\b|连不上|超时|timeout|ECONNREFUSED|ETIMEDOUT|无法访问|打不开|握手.{0,6}(失败|回 ?50)|pre 连不上/i
// 像证据的行：带接口路径 / curl / HTTP 码 / code / 返回 / 页面现象。
const EVIDENCE_RE = /curl|HTTP|\bcode\b|返回|回 ?\d{3}|→|\/[a-zA-Z][\w-]*\/|wss?:|页面|显示|实测|复测|握手|拉到|通了|没通|不通/
const shorten = (lines) => {
  let out = ''
  for (const line of lines) {
    const next = out ? `${out}；${line}` : line
    if (next.length > MAX) return out || line.slice(0, MAX - 1) + '…'
    out = next
  }
  return out
}
const relHome = (p) => p.replace(homedir(), '~')

const rows = []
for (const t of tags.filter((x) => x.kind === 'verification')) {
  const x = contextOf(caseById.get(t.id))
  const { m, parent, substantive, audits } = x
  // 审计：有 checks 的优先，其次有结论的；同一任务取最后一代。
  const withChecks = audits.filter((a) => a.checks.length).sort((a, b) => (b.epoch ?? 0) - (a.epoch ?? 0))
  const withSummary = audits.filter((a) => a.finalSummary).sort((a, b) => (b.epoch ?? 0) - (a.epoch ?? 0))
  let evidence = null
  let source = null
  let sourceType = null
  let raw = ''
  let match = null
  if (withChecks[0]) {
    const a = withChecks[0]
    const picked = a.checks.map((c) => one(c, 200)).filter((c) => EVIDENCE_RE.test(c) && !/^已读(取)? ?Lark 文档/.test(c))
    evidence = shorten(picked.length ? picked : [one(a.finalSummary, MAX)])
    raw = [...a.checks, a.finalSummary].join('\n')
    source = relHome(a.file)
    sourceType = 'audit.checks'
    match = 'audit'
  } else if (withSummary[0]) {
    const a = withSummary[0]
    evidence = one(a.finalSummary, MAX)
    raw = a.finalSummary
    source = relHome(a.file)
    sourceType = 'audit.summary'
    match = 'audit'
  } else {
    // falive 群里的实测回报：带结论标记 / 接口 / 码的那条。
    // bot 的群消息没有 parent_id，只能按 @人 + 时间 + 词重合度认领（case-context.mjs）；重合度低的标 weak，裁判用前先核一眼。
    const hit = x.scored.find(({ r }) => /[✅❌⚠️]|通了|没通|实测|复测|返回|code|HTTP/.test(r.text))
    const report = hit?.r
    if (report) {
      match = hit.s >= 0.1 || (hit.beforeNext && hit.s >= 0.05) ? 'strong' : 'weak'
      const lines = strip(report.text).split(/(?<=[。；])|\s-\s/).map((l) => one(l, 200)).filter(Boolean)
      evidence = shorten(lines)
      raw = report.text
      source = `replay/falive/dataset/timeline.json#${report.id}`
      sourceType = 'bot-reply'
    }
  }
  const env = envOf(m.text, parent?.text, raw)
  rows.push({
    id: t.id, at: t.at, sender: t.sender, text: one(m.text, 120),
    env: env.length ? env : null,
    envDownThen: evidence ? DOWN_RE.test(raw) : null,
    evidence, sourceType, source, match,
    ...(evidence ? {} : { note: m.atMs < Date.parse('2026-10-27T12:30:00Z') ? '无证据：审计只从 10-27 起，群里也没有 falive 的实测回报' : '无证据：没有关联到审计，群里也没有 falive 的实测回报' }),
  })
}
writeFileSync(join(casesDir, 'verification-evidence.jsonl'), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`)
const count = (fn) => rows.filter(fn).length
console.log(`实测类 ${rows.length} 条：有证据 ${count((r) => r.evidence)}（审计 checks ${count((r) => r.sourceType === 'audit.checks')}、审计结论 ${count((r) => r.sourceType === 'audit.summary')}、群里回报 ${count((r) => r.sourceType === 'bot-reply')}，其中认领没把握 weak ${count((r) => r.match === 'weak')}），无证据 ${count((r) => !r.evidence)}；当时环境不通的迹象 ${count((r) => r.envDownThen)}`)
const envs = {}
for (const r of rows) for (const e of r.env || ['未知']) envs[e] = (envs[e] || 0) + 1
console.log(`环境：${Object.entries(envs).map(([k, v]) => `${k} ${v}`).join('、')}`)
