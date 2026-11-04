#!/usr/bin/env node
/**
 * 验收（docs/falive-replay-design-v2.md §6，aven 11-04 同意）：合进运行分支的门槛，对照金标准判（先跑 gold.mjs compare 出 judge.jsonl）。
 *   node scripts/sim/acceptance.mjs --round <轮> | --sim <名> | --dir <路径> | --judge a.jsonl,b.jsonl
 *        [--prev <上一轮> | --prev-judge x.jsonl,…] [--explained replay/falive/explained.jsonl] [--total 285] [--metrics metrics.json] [--md out.md]
 * 检查（全部过才算过，退出码 0；否则 1，并列出违规 case）：
 *   硬线 1  带风险标签（钱 / 状态 / 权限 / 不可逆）的 case 不能有「falive 更好」（都不对的列警告）
 *   硬线 2  不能有重复回复、该回没回、回错人：裁判 larkIssue = duplicate / missed / wrong_target 且判 falive / 都不对；规则预判有完全重复的发件也算
 *   总体 1  「falive 更好」≤ 总 case 数的 5%（285 → 14）
 *   总体 2  每条「falive 更好」都有已知原因：explained.jsonl（{id, kind: sim_limit|todo|followup, why}）或金标准条目的 explained 字段里有
 *   不回退  上一轮判「一样 / lark-bot 更好」的，这一轮不能变成「falive 更好 / 都不对」（给了 --prev 才查）
 *   覆盖    规则预判里每条计分 case 都要有结论（有 rules.jsonl 才查）
 * 待办不计分（pending）单列，不进任何一项。同一 case 出现多次（旧布局热身重叠）取最差的结论。
 * --metrics <json>（round-metrics.mjs 出的 metrics.json，§11「更好」三项里的快 / 省）再加三项，在双方都有值的配对 case 上比：
 *   快 1  首句时延中位数与 P90 都不慢于 falive     快 2  结论时延中位数与 P90 都不慢于 falive
 *   省    等价花费中位数与合计都不高于 falive（没有配对数据算不过）
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { casesDir } from './falive-data.mjs'
import { listSimDirs, readJsonl, simSelectorFromArgs } from './sim-dir.mjs'

const WORST = { falive: 4, both_wrong: 3, same: 2, 'lark-bot': 1 }
export const FALIVE_SHARE = 0.05
const BAD = new Set(['falive', 'both_wrong'])
const GOOD = new Set(['same', 'lark-bot'])
const HARD_ISSUES = new Set(['duplicate', 'missed', 'wrong_target'])

/** 同一 case 多行取最差；pending 只在没有计分结论时保留。 */
export const collapseVerdicts = (lines) => {
  const out = new Map()
  for (const l of lines) {
    const prev = out.get(l.id)
    if (!prev || (prev.better === 'pending' && l.better !== 'pending') || (WORST[l.better] || 0) > (WORST[prev.better] || 0)) out.set(l.id, l)
  }
  return out
}

export const evaluateAcceptance = ({ current, rules = null, prev = null, explained = new Map(), riskOf = () => [], pendingOf = () => false, total }) => {
  const rows = [...current.values()]
  // 待办不计分：裁判行标了 pending，或 case-tags 里 pending=true（旧裁判结论没有这一栏，照样排除）
  // 模拟局限（judge-rules 旗标 sim_limit_ref：点名的任务是 falive 当时自己的，模拟里不存在）同待办：单列、不计分
  const simLimit = (r) => Boolean(rules?.get?.(r.id)?.flags?.includes('sim_limit_ref'))
  const isPending = (r) => r.better === 'pending' || pendingOf(r.id) || simLimit(r)
  const pending = rows.filter(isPending)
  const scored = rows.filter((r) => !isPending(r))
  const risk = (r) => (r.risk?.length ? r.risk : riskOf(r.id))
  const limit = Math.floor(total * FALIVE_SHARE)
  const faliveBetter = scored.filter((r) => r.better === 'falive')
  const ruleDup = rules ? [...rules.values()].filter((r) => !r.pending && !pendingOf(r.id) && r.lark?.duplicates > 0) : []
  const hard2 = new Map()
  for (const r of scored) if (HARD_ISSUES.has(r.larkIssue) && BAD.has(r.better)) hard2.set(r.id, { ...r, why: `裁判 ${r.better} / ${r.larkIssue}` })
  for (const r of ruleDup) if (!hard2.has(r.id)) hard2.set(r.id, { ...(current.get(r.id) || { id: r.id, at: r.at }), why: `规则：完全重复的发件 ${r.lark.duplicates} 条` })
  const checks = [
    { key: 'hard-risk', name: '硬线 1：风险 case 不能「falive 更好」', offending: scored.filter((r) => risk(r).length && r.better === 'falive') },
    { key: 'hard-reply', name: '硬线 2：不能重复回复 / 该回没回 / 回错人', offending: [...hard2.values()] },
    { key: 'share', name: `总体 1：「falive 更好」≤ ${limit}（${total} 的 5%），现 ${faliveBetter.length}`, offending: faliveBetter.length > limit ? faliveBetter : [] },
    { key: 'explained', name: '总体 2：每条「falive 更好」都有已知原因', offending: faliveBetter.filter((r) => !explained.has(r.id)) },
  ]
  if (prev) checks.push({ key: 'regress', name: '不回退：上一轮一样 / lark-bot 更好的没变差', offending: scored.filter((r) => BAD.has(r.better) && GOOD.has(prev.get(r.id)?.better)).map((r) => ({ ...r, why: `上一轮 ${prev.get(r.id).better} → ${r.better}` })) })
  if (rules) checks.push({ key: 'coverage', name: '覆盖：计分 case 都有结论', offending: [...rules.values()].filter((r) => !r.pending && !current.has(r.id)).map((r) => ({ id: r.id, at: r.at, why: '没有裁判结论' })) })
  for (const c of checks) c.pass = c.offending.length === 0
  const warnings = scored.filter((r) => risk(r).length && r.better === 'both_wrong').map((r) => ({ ...r, why: '风险 case 判都不对' }))
  const lowConfidence = scored.filter((r) => r.confidence === 'low')
  return { pass: checks.every((c) => c.pass), checks, pending, warnings, lowConfidence, scoredCount: scored.length, limit }
}

const fmtMs = (ms) => (ms == null ? '-' : Math.abs(ms) < 60_000 ? `${Math.round(ms / 1000)}s` : Math.abs(ms) < 3600_000 ? `${(ms / 60_000).toFixed(1)}min` : `${(ms / 3600_000).toFixed(1)}h`)
const fmtUsd = (v) => (v == null ? '-' : `$${v.toFixed(2)}`)

/** §11 快 / 省（round-metrics.mjs 的 metrics.json）：配对 case 上 lark-bot 不差于 falive。 */
export const metricsChecks = (metrics) => {
  const checks = []
  for (const [key, label] of [['firstMs', '首句'], ['concludeMs', '结论']]) {
    const p = metrics?.latency?.[key]?.paired
    const pass = Boolean(p?.n) && p.lark.median <= p.falive.median && p.lark.p90 <= p.falive.p90
    checks.push({ key: `metrics-${key}`, pass, offending: [],
      name: `快：${label}时延中位 / P90 不慢于 falive（配对 ${p?.n || 0} 条：lark-bot ${fmtMs(p?.lark?.median)} / ${fmtMs(p?.lark?.p90)}，falive ${fmtMs(p?.falive?.median)} / ${fmtMs(p?.falive?.p90)}）` })
  }
  const c = metrics?.cost?.paired
  checks.push({ key: 'metrics-cost', pass: Boolean(c?.n) && c.lark.median <= c.falive.median && c.lark.total <= c.falive.total, offending: [],
    name: `省：等价花费中位 / 合计不高于 falive（配对 ${c?.n || 0} 条：lark-bot ${fmtUsd(c?.lark?.median)} / ${fmtUsd(c?.lark?.total)}，falive ${fmtUsd(c?.falive?.median)} / ${fmtUsd(c?.falive?.total)}）` })
  return checks
}

const loadLines = ({ selector, files }) => {
  const lines = []
  const rules = new Map()
  let hasRules = false
  if (files) for (const f of files.split(',').filter(Boolean)) lines.push(...readJsonl(f))
  else for (const s of listSimDirs(selector)) {
    lines.push(...readJsonl(join(s.dir, 'judge.jsonl')))
    if (existsSync(join(s.dir, 'rules.jsonl'))) { hasRules = true; for (const r of readJsonl(join(s.dir, 'rules.jsonl'))) if (!rules.has(r.id)) rules.set(r.id, r) }
  }
  return { lines, rules: hasRules ? rules : null }
}

const main = () => {
  const args = process.argv.slice(2)
  const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
  const { lines, rules } = loadLines({ selector: simSelectorFromArgs(args), files: value('--judge', null) })
  if (!lines.length) { console.error('[acceptance] 没有裁判结论（--round / --sim / --dir / --judge）'); process.exit(2) }
  const prevRound = value('--prev', null)
  const prevFiles = value('--prev-judge', null)
  const prev = prevRound || prevFiles ? collapseVerdicts(loadLines({ selector: { round: prevRound }, files: prevFiles }).lines) : null
  const tags = new Map(readJsonl(join(casesDir, 'case-tags.jsonl')).map((t) => [t.id, t]))
  const explained = new Map(readJsonl(value('--explained', join(casesDir, 'explained.jsonl'))).map((e) => [e.id, e]))
  for (const g of readJsonl(value('--gold', join(casesDir, 'gold.jsonl')))) if (g.explained && !explained.has(g.id)) explained.set(g.id, { id: g.id, why: g.explained })
  const total = Number(value('--total', 0)) || readJsonl(join(casesDir, 'cases.jsonl')).length
  const current = collapseVerdicts(lines)
  const result = evaluateAcceptance({ current, rules, prev, explained, riskOf: (id) => tags.get(id)?.risk || [], pendingOf: (id) => Boolean(tags.get(id)?.pending), total })
  if (value('--metrics', null)) {
    result.checks.push(...metricsChecks(JSON.parse(readFileSync(value('--metrics', null), 'utf8'))))
    result.pass = result.checks.every((c) => c.pass)
  }
  const row = (r) => `  - \`${String(r.id).slice(-8)}\` ${String(r.at || '').slice(5, 16)} ${r.sender || ''}：${String(r.text || '').replace(/\s+/g, ' ').slice(0, 50)}${r.why ? ` —— ${r.why}` : ''}${r.reason ? `（${String(r.reason).slice(0, 60)}）` : ''}${r.risk?.length ? ` [${r.risk.join('/')}]` : ''}`
  const out = [`# 验收（design-v2 §6）：${result.pass ? '通过' : '不通过'}`, '', `计分 ${result.scoredCount} 条（待办不计分 ${result.pending.length}），总数 ${total}；falive 更好上限 ${result.limit}`, '']
  for (const c of result.checks) { out.push(`- ${c.pass ? '过' : '**不过**'} ${c.name}${c.pass || !c.offending.length ? '' : `（${c.offending.length} 条）`}`); if (!c.pass) out.push(...c.offending.slice(0, 40).map(row)) }
  if (result.warnings.length) out.push('', `警告：风险 case 判都不对 ${result.warnings.length} 条`, ...result.warnings.map(row))
  if (result.lowConfidence.length) out.push('', `裁判拿不准（confidence=low）${result.lowConfidence.length} 条：应已进金标准评审`, ...result.lowConfidence.slice(0, 20).map(row))
  if (result.pending.length) out.push('', `待办不计分 ${result.pending.length} 条：${result.pending.map((r) => `\`${r.id.slice(-8)}\``).join(' ')}`)
  const text = out.join('\n')
  console.log(text)
  if (value('--md', null)) writeFileSync(value('--md', null), `${text}\n`)
  process.exit(result.pass ? 0 : 1)
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main()
