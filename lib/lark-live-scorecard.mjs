/**
 * 线上指标（aven 11-05，docs/plan/plan-iteration-2026-11-05.md 批 1.1）：离线回放停了，准 / 快 / 省改从线上运行态算，
 * 每天附在 19:00 日报末尾，也可 `node scripts/lark-metrics.mjs --live [--days N]` 看任意天数。不跑模型、只读本机文件。
 *
 * 口径（验收线见方案 §0）：
 *   准  漏回：群里直接 @bot、30 分钟一句没回、巡检私信了负责人（义务 settledAs=notified）——线 0；
 *       重复回：同一条消息（anchor，没有按任务）同一句结论发了不止一次（多出来的条数）——线 0；
 *       回错人：结论回的那条消息有义务记着提问人，结论却 @ 了别人——线 0；
 *       另报：回了「收到」却没给结论（owed / 4 小时逾期私信）、没做成（failed）占比。
 *   快  首句：消息发出 → 回「收到」/ 第一句（ackMs）——线 中位 ≤ 47 秒（falive 水平）；
 *       结论：消息发出 → 结果发出（totalMs），答疑 / 实测——线 P90 ≤ 7 分钟（b6 水平）；改码单列不设线。
 *   省  审计日志里每次调用的 total_cost_usd 按会话取增量、归到任务（lib/lark-audit-cost），日报 / 汇总类系统任务不算。
 *   反馈 纠错条数（lib/lark-feedback-log 纠错清单）；负责人拍板次数与直接采纳率（放行 ÷（放行 + 改了再发））。
 * 纯函数；取数（读 jsonl / 义务 / 发件簿 / 审计）在 collectLiveFacts。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { auditCalls } from './lark-audit-cost.mjs'
import { adoptionOf, readCorrections, readDecisions } from './lark-feedback-log.mjs'
import { readLatency } from './lark-latency.mjs'
import { larkAuditsRoot, larkLatencyPath, larkRuntimeDir } from './lark-paths.mjs'

export const LIVE_LINES = Object.freeze({ ackP50Ms: 47_000, answerP90Ms: 7 * 60_000 })
// 回给提问人的实质回复（不含「收到」/ 进度 / 私信通知）。
export const CONCLUSION_PHASES = new Set(['done', 'blocked_ask', 'self_answer', 'ask_back', 'held_release'])
// 答疑类结论：worker 代答 / 实测，加分类器一句自答（lark-routes-intake 记的 self_answer）；追问（ask_back）只算首句。
const ANSWER_LIKE = new Set(['answer', 'verification', 'self_answer'])
// 系统自己排的任务（日报 / 早报 / 运维固定动作）：不算进快 / 省。
const SYSTEM_DELIVERABLES = new Set(['daily', 'digest', 'ops'])
const isSystemTaskId = (id) => /^(?:daily|digest)-/.test(String(id || ''))

const quantile = (values, q) => {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  return sorted.length ? sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] : null
}
const stats = (values) => {
  const finite = values.filter((v) => Number.isFinite(v))
  return { n: finite.length, p50: quantile(finite, 0.5), p90: quantile(finite, 0.9) }
}

// range：{ fromMs, toMs }，左闭右开。
const within = (range, at) => {
  const ms = Date.parse(at || '')
  return Number.isFinite(ms) && ms >= range.fromMs && ms < range.toMs
}

export const summarizeAccuracy = ({ obligations = [], outbox = [], range }) => {
  const addressed = obligations.filter((item) => within(range, item.addressedAt))
  const unanswered = addressed.filter((item) => item.settledAs === 'notified')
  // 回了「收到」却没给结论：失败记 owed，或 4 小时逾期私信过；之后补发了结论（answered）的不算。
  const owed = obligations.filter((item) => item.state !== 'answered' && (within(range, item.owedAt) || within(range, item.overdueNotifiedAt)))
  const conclusions = outbox.filter((entry) => CONCLUSION_PHASES.has(entry.phase) && within(range, entry.at))
  const seen = new Map()
  for (const entry of conclusions) {
    const key = `${entry.chatId}|${entry.anchor || entry.taskId || ''}|${entry.hash}`
    seen.set(key, [...(seen.get(key) || []), entry])
  }
  const duplicates = [...seen.values()].filter((group) => group.length > 1).map((group) => ({ chatId: group[0].chatId, taskId: group[0].taskId, anchor: group[0].anchor || null, extra: group.length - 1 }))
  const askerOf = new Map(obligations.map((item) => [`${item.chatId}|${item.id}`, item.asker]))
  const wrongPerson = conclusions.filter((entry) => {
    const asker = entry.anchor ? askerOf.get(`${entry.chatId}|${entry.anchor}`) : null
    return Boolean(asker && entry.to && entry.to !== asker)
  }).map((entry) => ({ chatId: entry.chatId, taskId: entry.taskId, anchor: entry.anchor, to: entry.to }))
  return {
    addressed: addressed.length,
    unanswered: unanswered.map((item) => ({ chatId: item.chatId, id: item.id, text: item.text || null })),
    owed: owed.map((item) => ({ chatId: item.chatId, id: item.id })),
    duplicates,
    duplicateCount: duplicates.reduce((sum, d) => sum + d.extra, 0),
    wrongPerson,
  }
}

export const summarizeSpeed = ({ latency = [], range }) => {
  const records = latency.filter((r) => within(range, r.at) && !SYSTEM_DELIVERABLES.has(r.deliverable) && !isSystemTaskId(r.id))
  return {
    ack: stats(records.map((r) => r.ackMs)),
    answer: stats(records.filter((r) => ANSWER_LIKE.has(r.deliverable)).map((r) => r.totalMs)),
    change: stats(records.filter((r) => r.deliverable === 'change').map((r) => r.totalMs)),
  }
}

// calls：auditCalls 的输出（{ taskId, at(ms), usd }）。summaryOf：任务 id → 标题（取不到为 null）。
export const summarizeCost = ({ calls = [], range, summaryOf = () => null }) => {
  const byTask = new Map()
  for (const call of calls) {
    if (isSystemTaskId(call.taskId) || !(call.at >= range.fromMs && call.at < range.toMs)) continue
    byTask.set(call.taskId, (byTask.get(call.taskId) || 0) + (call.usd || 0))
  }
  const totals = [...byTask.entries()].map(([taskId, usd]) => ({ taskId, usd }))
  const top = totals.sort((a, b) => b.usd - a.usd)[0] || null
  return {
    tasks: totals.length,
    totalUsd: totals.reduce((sum, t) => sum + t.usd, 0),
    p50Usd: quantile(totals.map((t) => t.usd), 0.5),
    top: top ? { ...top, summary: summaryOf(top.taskId) } : null,
  }
}

export const summarizeFeedback = ({ corrections = [], decisions = [], range }) => {
  const today = decisions.filter((d) => within(range, d.at))
  const counts = Object.fromEntries(['release', 'revise', 'decline', 'resume', 'instruct'].map((kind) => [kind, today.filter((d) => d.kind === kind).length]))
  return {
    corrections: corrections.filter((c) => within(range, c.at)).length,
    openCorrections: corrections.filter((c) => c.status === 'open').length,
    decisions: today.length,
    counts,
    adoption: adoptionOf(today),
  }
}

// taskCounts：{ total, failed }（调用方按日报的任务口径算好传进来，避免两处口径分叉）。
export const buildScorecard = ({ range, latency, obligations, outbox, calls, corrections, decisions, taskCounts = null, summaryOf }) => ({
  range,
  accuracy: { ...summarizeAccuracy({ obligations, outbox, range }), taskCounts },
  speed: summarizeSpeed({ latency, range }),
  cost: summarizeCost({ calls, range, summaryOf }),
  feedback: summarizeFeedback({ corrections, decisions, range }),
})

// ── 渲染 ───────────────────────────────────────────────────

const EMPTY = '--'
export const formatDuration = (ms) => {
  if (!Number.isFinite(ms)) return EMPTY
  if (ms < 60_000) return `${Math.round(ms / 1000)} 秒`
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)} 分`
  return `${(ms / 3_600_000).toFixed(1)} 小时`
}
const usd = (value) => (Number.isFinite(value) ? `$${value.toFixed(2)}` : EMPTY)
const mark = (ok) => (ok === null ? '' : ok ? ' ✅' : ' ⚠️')
const pct = (rate) => (rate === null ? EMPTY : `${Math.round(rate * 100)}%`)

export const renderScorecard = (card, { title = '线上指标（今天）' } = {}) => {
  const { accuracy: a, speed: s, cost: c, feedback: f } = card
  const missOk = a.unanswered.length === 0 && a.duplicateCount === 0 && a.wrongPerson.length === 0
  const failed = a.taskCounts?.total ? `；没做成 ${a.taskCounts.failed}/${a.taskCounts.total}` : ''
  const lines = [
    `${title}`,
    `- 准：群里 @bot ${a.addressed} 条，漏回 ${a.unanswered.length}、重复回 ${a.duplicateCount}、回错人 ${a.wrongPerson.length}${a.addressed || a.duplicateCount || a.wrongPerson.length ? mark(missOk) : ''}；回了「收到」没给结论 ${a.owed.length}${failed}`,
  ]
  const ackOk = s.ack.n ? s.ack.p50 <= LIVE_LINES.ackP50Ms : null
  const answerOk = s.answer.n ? s.answer.p90 <= LIVE_LINES.answerP90Ms : null
  const speed = [
    `首句中位 ${formatDuration(s.ack.p50)}（线 ≤47 秒）${mark(ackOk)}`,
    `答疑 / 实测结论中位 ${formatDuration(s.answer.p50)}、P90 ${formatDuration(s.answer.p90)}（线 P90 ≤7 分）${mark(answerOk)}`,
    ...(s.change.n ? [`改码结论中位 ${formatDuration(s.change.p50)}`] : []),
  ]
  lines.push(s.ack.n || s.answer.n || s.change.n ? `- 快：${speed.join('；')}` : '- 快：没有交付记录')
  lines.push(c.tasks
    ? `- 省：${c.tasks} 单共 ${usd(c.totalUsd)}，每单中位 ${usd(c.p50Usd)}，最贵 ${usd(c.top.usd)}（${c.top.summary || c.top.taskId}）`
    : '- 省：没有模型花费')
  const decided = f.decisions
    ? `你拍板 ${f.decisions} 次（放行 ${f.counts.release}、改了再发 ${f.counts.revise}、不做 ${f.counts.decline}、续跑 ${f.counts.resume}、指示 ${f.counts.instruct}），直接采纳率 ${pct(f.adoption.rate)}`
    : '你没拍板过'
  lines.push(`- 反馈：纠错 ${f.corrections} 条（没处理的共 ${f.openCorrections}）；${decided}`)
  for (const item of a.unanswered.slice(0, 3)) lines.push(`  · 漏回：${item.text || item.id}`)
  for (const item of a.duplicates.slice(0, 3)) lines.push(`  · 重复回：任务 ${item.taskId || item.anchor}（多发 ${item.extra} 次）`)
  for (const item of a.wrongPerson.slice(0, 3)) lines.push(`  · 回错人：任务 ${item.taskId || item.anchor}`)
  return lines
}

// ── 取数 ───────────────────────────────────────────────────

const readJsonDir = (dir) => (existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.json')) : []).flatMap((name) => {
  try {
    return [JSON.parse(readFileSync(join(dir, name), 'utf8'))]
  } catch {
    return []
  }
})
const readJsonlDir = (dir) => (existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.jsonl')) : []).flatMap((name) => readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean).flatMap((line) => {
  try {
    return [JSON.parse(line)]
  } catch {
    return []
  }
}))

// 只读真实运行态（义务 / 发件簿各留 7 天，时延 / 反馈 jsonl 不清）。runtimeDir 可指到别处（测试 / 看别的实例）。
const EMPTY_FACTS = Object.freeze({ latency: [], obligations: [], outbox: [], calls: [], corrections: [], decisions: [] })
// node --test 下没指定目录：不读真实运行态（日报单测走 REAL_DEPS 时也不受本机数据影响）。
export const collectLiveFacts = ({ runtimeDir = null, sinceMs = 0 } = {}) => {
  if (!runtimeDir && process.env.NODE_TEST_CONTEXT && !process.env.LARK_RUNTIME_DIR) return { ...EMPTY_FACTS }
  return readLiveFacts({ runtimeDir: runtimeDir || larkRuntimeDir, sinceMs })
}
const readLiveFacts = ({ runtimeDir, sinceMs }) => ({
  latency: readLatency({ path: runtimeDir === larkRuntimeDir ? larkLatencyPath : join(runtimeDir, 'lark-latency.jsonl'), sinceMs }),
  obligations: readJsonDir(join(runtimeDir, 'lark-obligations')).flatMap((byId) => Object.values(byId || {})),
  outbox: readJsonlDir(join(runtimeDir, 'lark-outbox')),
  calls: auditCalls(runtimeDir === larkRuntimeDir ? larkAuditsRoot : join(runtimeDir, 'lark-audits')).filter((call) => call.at >= sinceMs),
  corrections: readCorrections({ path: runtimeDir === larkRuntimeDir ? null : join(runtimeDir, 'lark-corrections.jsonl') }),
  decisions: readDecisions({ path: runtimeDir === larkRuntimeDir ? null : join(runtimeDir, 'lark-decisions.jsonl'), sinceMs }),
})
