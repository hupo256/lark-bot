#!/usr/bin/env node
/**
 * L2 / L3 裁判（docs/falive-replay-design-v2.md §5「裁判」）：对 sim 目录里每条 case，把消息 + 上下文 + 标签 + 实测类当时证据 +
 * 【A：falive 当时】+【B：lark-bot 这次】交给模型，以 aven 的利益为准判谁更合适。提示冻结在 scripts/sim/judge-prompt.mjs（带版本）。
 *   node scripts/sim/judge-sim.mjs --round <轮> | --sim <名> | --dir <路径> [--effort high] [--all] [--gold [gold.jsonl]]
 *        [--conc 4] [--limit n] [--ids a,b] [--score-from <ISO>] [--dry] [--print-prompt <case id>]
 * 先跑规则预判（judge-rules.mjs，同时落 rules.jsonl）；然后：
 *   - 待办不计分的（case-tags pending=true，「已部署」→ 自动复测链路）不判，better=pending 单列；
 *   - 按 case id + 输出指纹 + 提示版本查缓存（judge-cache.mjs），命中就沿用，不花 token；--all 无视缓存全部重判（定金标准那轮配 --effort max）；
 *   - --gold：对照金标准判（gold.mjs compare 就是它）——输出指纹等于 aven 审过的那版 → 直接沿用金标准结论；不等 → 模型判，带上金标准的理想做法作参照。
 * 产物：每个 sim 目录下 judge.jsonl（每条 case 一行，整文件重写；结论都在缓存里，断了重跑即可）。
 * 结论字段：better / confidence / reason / larkIssue / cause / idealBehavior（模型）+ risk / kind / promptVersion / effort / fingerprint / source（cache|model|gold）
 *   + flags / simLimits（judge-rules 的模拟局限旗标与原因，v3 起提示里也给裁判看；验收按 acceptance.simLimitOf 单列不计分）。
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { casesDir, replayRoot, roundsDir } from './falive-data.mjs'
import { goldRefOf, lookupVerdict, storeVerdict, withLimitsRef } from './judge-cache.mjs'
import { contextLinesOf, faliveRepliesOf, loadJudgeData } from './judge-data.mjs'
import { BETTER, CAUSES, CONFIDENCE, JUDGE_PROMPT_VERSION, JUDGE_SCHEMA, LARK_ISSUES, assertPromptFrozen, buildJudgePrompt } from './judge-prompt.mjs'
import { simLimitOf } from './acceptance.mjs'
import { computeSimRules } from './judge-rules.mjs'
import { listSimDirs, loadSim, readJsonl, simSelectorFromArgs } from './sim-dir.mjs'

const args = process.argv.slice(2)
const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const sims = listSimDirs(simSelectorFromArgs(args))
if (!sims.length) {
  console.error('用法：node scripts/sim/judge-sim.mjs --round <轮> | --sim <名> | --dir <路径> [--effort high] [--all] [--gold]（没找到 sim 目录）')
  process.exit(2)
}
const all = args.includes('--all')
const dry = args.includes('--dry')
const effort = value('--effort', 'high')
const model = value('--model', 'claude-opus-5-5')
const concurrency = Number(value('--conc', 4))
const limit = Number(value('--limit', 0))
const onlyIds = value('--ids', null) ? new Set(value('--ids', '').split(',').filter(Boolean)) : null
const printPrompt = value('--print-prompt', null)
const scoreFromMs = value('--score-from', null) ? Date.parse(value('--score-from', null)) : 0
const goldArg = args.includes('--gold') ? (args[args.indexOf('--gold') + 1] && !args[args.indexOf('--gold') + 1].startsWith('--') ? args[args.indexOf('--gold') + 1] : join(casesDir, 'gold.jsonl')) : null
const gold = goldArg ? new Map(readJsonl(goldArg).map((g) => [g.id, g])) : null
if (goldArg && !gold.size) console.warn(`[judge-sim] 金标准 ${goldArg} 是空的，按普通裁判跑`)

const promptHashNow = assertPromptFrozen()
const data = loadJudgeData()

// 本轮用的提示版本记进 rounds/<轮>/code.txt（design-v2 §5：裁判提示冻结、每轮记版本）
const roundName = value('--round', null)
if (roundName && !dry && existsSync(join(roundsDir, roundName))) {
  const codePath = join(roundsDir, roundName, 'code.txt')
  const line = `judge-prompt ${JUDGE_PROMPT_VERSION} ${promptHashNow}`
  if (!(existsSync(codePath) ? readFileSync(codePath, 'utf8') : '').includes(line)) appendFileSync(codePath, `${line}\n`)
}

const one = (t, n) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, n)

const buildJudgeContext = ({ m, sim, row }) => {
  const baseline = data.baselines.get(m.id)
  const b = baseline?.baseline || {}
  const parent = m.parentId ? data.byId.get(m.parentId) || null : null
  const task = sim.tasks.get(m.id) || null
  const audit = sim.audits.get(m.id) || null
  const cls = task?.intake?.classification || null
  return {
    m,
    parent,
    replyToBot: Boolean(parent?.ownBot),
    context: contextLinesOf(m, { data }).join('\n'),
    tag: data.tags.get(m.id) || null,
    evidence: data.evidence.get(m.id) || null,
    falive: { classified: b.classified || null, replies: faliveRepliesOf(m, { data }), humanFollowups: b.humanFollowups || [], ledger: b.ledger || null, audit: b.audit || null, routing: b.routing || [] },
    lark: {
      ...row.lark,
      classReply: cls?.reply || null,
      result: task?.result || task?.summary || null,
      auditFinal: audit?.final ? `${audit.final.status || audit.status}；${audit.final.summary || ''}` : audit ? `${audit.status}（没有 final）` : null,
    },
    gold: null,
    simLimits: row.simLimits || [],
  }
}

const callJudge = async (prompt, kind) => {
  const child = spawn(join(dirname(fileURLToPath(import.meta.url)), 'claude-q'), ['-p', '--permission-mode', 'plan', '--tools', '', '--model', model, '--effort', effort, '--strict-mcp-config', '--setting-sources', 'project', '--no-session-persistence', '--json-schema', JSON.stringify(JUDGE_SCHEMA), '--output-format', 'json', prompt], { cwd: replayRoot, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SIM_ORIG_INTENT_MS: '1800000' } }) // 裁判也是 plan 模式：额度闸别按分类调用的 120 秒超时掐（max 强度要更久）
  let out = ''
  let err = ''
  child.stdout.on('data', (c) => { out += c })
  child.stderr.on('data', (c) => { err += c })
  const code = await new Promise((resolve) => child.on('close', resolve))
  if (code !== 0) throw new Error(`claude exit ${code}: ${err.slice(0, 200)}`)
  const envelope = JSON.parse(out)
  const v = envelope.structured_output ?? (typeof envelope.result === 'string' ? JSON.parse(envelope.result) : envelope.result)
  if (!BETTER.includes(v?.better) || !LARK_ISSUES.includes(v?.larkIssue)) throw new Error(`结论不合结构：${JSON.stringify(v).slice(0, 200)}`)
  const verdict = { better: v.better, confidence: CONFIDENCE.includes(v.confidence) ? v.confidence : 'low', reason: v.reason || '', larkIssue: v.larkIssue, cause: CAUSES.includes(v.cause) ? v.cause : 'bot', idealBehavior: v.idealBehavior || '' }
  // 口径 4（11-04）：写真实环境越界只能 falive / both_wrong、归 bot；模型判了 same / lark-bot 的按 falive 收，原判记进 reason。
  // 改码类（change）的 over_scope 是口径 3 的需求边界，不在这条里，不改判。
  if (verdict.larkIssue === 'over_scope' && kind !== 'change') {
    if (!['falive', 'both_wrong'].includes(verdict.better)) { verdict.reason = `${verdict.reason}（越界，原判 ${verdict.better} 改 falive）`; verdict.better = 'falive' }
    verdict.cause = 'bot'
  }
  return verdict
}

// —— 规则预判 + 分流 ——
const perSim = []
const queue = []
const counts = { cases: 0, pending: 0, cache: 0, gold: 0, model: 0, failed: 0 }
for (const entry of sims) {
  const sim = loadSim(entry)
  const { rows } = computeSimRules({ sim, data, scoreFromMs })
  writeFileSync(join(sim.dir, 'rules.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''))
  // --ids / --limit 只判一部分时，别把这个目录里其余 case 的结论（同一提示版本、同一指纹）冲掉
  const rowFp = new Map(rows.map((r) => [r.id, r.fingerprint]))
  const kept = readJsonl(join(sim.dir, 'judge.jsonl')).filter((l) => rowFp.get(l.id) === l.fingerprint && l.promptVersion === JUDGE_PROMPT_VERSION)
  const slot = { sim, lines: new Map(onlyIds || limit ? kept.map((l) => [l.id, l]) : []) }
  perSim.push(slot)
  for (const row of rows) {
    if (onlyIds && !onlyIds.has(row.id)) continue
    counts.cases += 1
    const m = data.byId.get(row.id)
    const base = {
      id: row.id, sim: sim.label, episode: row.episode, at: row.at, chatKey: row.chatKey, sender: m.senderName, text: one(m.text, 120),
      risk: row.risk, kind: row.kind, pending: row.pending, promptVersion: JUDGE_PROMPT_VERSION, fingerprint: row.fingerprint,
      falive: `${row.falive.decision || '（没分类记录）'}${row.falive.replied ? '，回了' : '，没回'}`,
      larkBot: `${row.lark.decision}${row.lark.status ? `/${row.lark.status}` : ''}${row.lark.replied ? '，回了' : '，没回'}`,
      flags: row.flags,
      simLimits: row.simLimits || [],
    }
    if (printPrompt === row.id) { const ctx = buildJudgeContext({ m, sim, row }); ctx.gold = gold?.get(row.id) && gold.get(row.id).reviewedFingerprint !== row.fingerprint ? gold.get(row.id) : null; console.log(buildJudgePrompt(ctx)) }
    if (row.pending) { counts.pending += 1; slot.lines.set(row.id, { ...base, better: 'pending', reason: '「已部署」→ 自动复测链路，待办不计分（design-v2 §7）', source: 'rule' }); continue }
    const g = gold?.get(row.id) || null
    if (g && g.reviewedFingerprint === row.fingerprint) { // 金标准不是缓存，--all 也沿用
      counts.gold += 1
      slot.lines.set(row.id, { ...base, better: g.better, confidence: 'high', reason: `金标准（${g.by === 'aven' ? 'aven 审过' : '定稿裁判'}同一输出）`, larkIssue: g.larkIssue || 'none', cause: g.cause || 'n/a', idealBehavior: g.ideal || '', effort: g.effort || null, source: 'gold', ref: 'gold' })
      continue
    }
    const ref = withLimitsRef(g ? goldRefOf(g) : 'none', row.simLimits)
    const hit = all ? null : lookupVerdict({ id: row.id, fingerprint: row.fingerprint, promptVersion: JUDGE_PROMPT_VERSION, ref, effort })
    if (hit) { counts.cache += 1; slot.lines.set(row.id, { ...base, ...hit.verdict, effort: hit.effort, source: 'cache', ref }); continue }
    queue.push({ slot, m, row, base, gold: g, ref })
  }
}
const toJudge = limit ? queue.slice(0, limit) : queue
console.log(`[judge-sim] ${sims.length} 个 sim 目录，case ${counts.cases}：待办不计分 ${counts.pending}，沿用缓存 ${counts.cache}，沿用金标准 ${counts.gold}，要送模型 ${queue.length}${limit ? `（本次只判 ${toJudge.length}）` : ''}（提示 ${JUDGE_PROMPT_VERSION}/${promptHashNow}，effort ${effort}${all ? '，--all 无视缓存' : ''}${gold ? '，对照金标准' : ''}）`)
if (dry) {
  for (const j of toJudge) console.log(`  待判 ${j.base.sim} ${j.row.id} ${j.row.fingerprint} ${j.row.flags.join(',')} ${j.base.text.slice(0, 60)}`)
  process.exit(0)
}

let index = 0
await Promise.all(Array.from({ length: Math.max(1, concurrency) }, async () => {
  while (index < toJudge.length) {
    const job = toJudge[index++]
    try {
      const ctx = buildJudgeContext({ m: job.m, sim: job.slot.sim, row: job.row })
      ctx.gold = job.gold
      const verdict = await callJudge(buildJudgePrompt(ctx), job.row.kind)
      storeVerdict({ id: job.row.id, fingerprint: job.row.fingerprint, promptVersion: JUDGE_PROMPT_VERSION, ref: job.ref, effort, model, verdict, sim: job.base.sim })
      job.slot.lines.set(job.row.id, { ...job.base, ...verdict, effort, source: 'model', ref: job.ref })
      counts.model += 1
      console.log(`[judge-sim] ${job.row.id} ${verdict.better}/${verdict.confidence} ${verdict.larkIssue}·${verdict.cause}：${verdict.reason}`)
    } catch (error) {
      counts.failed += 1
      console.error(`[judge-sim] ${job.row.id} 失败：${String(error.message).slice(0, 200)}`)
    }
  }
}))

const allLines = []
for (const { sim, lines } of perSim) {
  const out = [...lines.values()].sort((a, b) => a.at.localeCompare(b.at))
  allLines.push(...out)
  writeFileSync(join(sim.dir, 'judge.jsonl'), out.map((l) => JSON.stringify(l)).join('\n') + (out.length ? '\n' : ''))
}
const count = (key, rows) => rows.reduce((acc, r) => ({ ...acc, [r[key]]: (acc[r[key]] || 0) + 1 }), {})
const limited = allLines.filter((l) => l.better !== 'pending' && simLimitOf({ verdict: l, flags: l.flags }))
const scored = allLines.filter((l) => l.better !== 'pending' && !limited.includes(l))
console.log(`[judge-sim] 汇总（计分 ${scored.length} 条，模拟局限不计分 ${limited.length} 条 ${JSON.stringify(count('better', limited))}；本次送模型 ${counts.model}、失败 ${counts.failed}）：better=${JSON.stringify(count('better', scored))} confidence=${JSON.stringify(count('confidence', scored))} larkIssue=${JSON.stringify(count('larkIssue', scored))} source=${JSON.stringify(count('source', allLines))}`)
const pending = allLines.filter((l) => l.better === 'pending')
if (pending.length) console.log(`[judge-sim] 待办不计分 ${pending.length} 条：${pending.map((l) => `${l.id.slice(-8)}「${l.text.slice(0, 20)}」`).join('；')}`)
if (counts.failed) process.exitCode = 1
