#!/usr/bin/env node
/**
 * 一轮的三项「更好」指标（docs/replay/falive-replay-design-v2.md §11：决断更准、反应更快、token 更省），lark-bot 对 falive 当时，逐 case 与汇总。
 *   node scripts/sim/round-metrics.mjs --round <轮> [--md out.md] [--json out.json] [--all]
 * 默认只算跑完（有 DONE）的事件组；--all 连没跑完的也算（数据不全，只看个大概）。JSON 默认写 sim/<轮>/metrics.json，给 acceptance.mjs --metrics 用。
 * 待办不计分（pending）与模拟局限不计分（acceptance.simLimitOf：裁判判 cause=sim_limit 或硬局限旗标）的 case 三项都不进，单列。不花 token、只读。
 *
 * 1 准：裁判结论分布（lark-bot / falive / same / both_wrong，pending 单列不进），再按风险标签、case 类型拆。
 * 2 快：虚拟时间，从人发消息（时间线 atMs）算起——
 *   首句：问话人看得到的第一句（群里的 case 看群里，负责人私聊的看私信）；结论：问话人看得到的第一句实质回复（不算 ack；全是 ack 取最后一句，
 *   lark-bot 任务没结论——running / failed 等——时不算），见 conclusionMs。
 *   lark-bot 的话按 judge-rules 的发件归属（computeSimRules，现算，不读旧 rules.jsonl）；
 *   falive 的话：事件组 faliveBotIds（episodes.json）里的 bot 话，按 falive-bot-owner.mjs 逐条归 case（群卡：审计完成时间 / 卡里 @ 了发话人；
 *   私信：引用 id / 回执 / 审计完成时间 / 开始卡），群卡对不上的退到同话题、再退到同群 2 小时内最近一条组内 case。
 *   两边都有值的 case 上比中位数 / P90，另给配对差（lark-bot − falive）。
 * 3 省：每 case 等价花费 = 这条任务审计日志（runtime/lark-audits/<项目>/<任务>-e<代>.log，含网关分类那一趟）里每次调用的 total_cost_usd。
 *   total_cost_usd 在同一会话里是累计的（--resume 接着记），按 session_id 取增量再归到写这份日志的任务。
 *   录放命中（ai-cache 命中，回放的是录时 stdout）实际花 0，「等价花费」照算录时的数；本轮实花 = 等价 − 命中。
 *   falive 侧同法读 ~/github/lark-bot-falive/runtime/lark-audits（10-27 起才有）；在 falive 审计覆盖期内、且至少一边花了钱的 case 上比中位数与合计。
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { collapseVerdicts, simLimitOf } from './acceptance.mjs'
import { isAck } from './case-context.mjs'
import { cacheRoot } from './claude-cache.mjs'
import { createFaliveBotOwners, loadFaliveAuditFiles } from './falive-bot-owner.mjs'
import { faliveLogDir, faliveRuntimeDir } from './falive-data.mjs'
import { WEBHOOK_CHAT_KEY, loadJudgeData } from './judge-data.mjs'
import { FOLLOW_MS, computeSimRules } from './judge-rules.mjs'
import { listSimDirs, loadSim, readJsonl, simRoot } from './sim-dir.mjs'

export const METRICS_VERSION = 'metrics-v2-1104' // v2：模拟局限单列不计分
const NOT_CONCLUDED = new Set(['received', 'queued', 'ready', 'running', 'verifying', 'failed', 'intake_failed'])
const VERDICTS = ['lark-bot', 'same', 'falive', 'both_wrong']

// —— 统计 ——
/** 最近秩分位（不插值）：p90 = 排好序后第 ceil(0.9n) 个。 */
export const quantile = (values, q) => {
  const s = [...values].sort((a, b) => a - b)
  return s.length ? s[Math.max(0, Math.ceil(q * s.length) - 1)] : null
}
export const median = (values) => {
  const s = [...values].sort((a, b) => a - b)
  if (!s.length) return null
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}
export const summarize = (values) => ({ n: values.length, median: median(values), p90: quantile(values, 0.9), total: values.reduce((a, b) => a + b, 0) })

// —— 花费 ——
/** 审计日志里每次调用的结果行：{ at, order, session, total }。分段头「=== <ISO> <executor> <kind> ===」给时间。 */
export const parseCostLog = (text) => {
  const out = []
  let at = 0
  let kind = null
  let order = 0
  const seen = new Set()
  for (const line of String(text || '').split('\n')) {
    const head = line.match(/^=== (\S+) \S+ (\S+)/)
    if (head) { at = Date.parse(head[1]) || at; kind = head[2]; continue }
    if (!line.startsWith('{') || !line.includes('"total_cost_usd"')) continue
    let ev
    try { ev = JSON.parse(line) } catch { continue }
    if (typeof ev.total_cost_usd !== 'number') continue
    const session = ev.session_id || null
    const key = `${session}|${ev.total_cost_usd}`
    if (seen.has(key)) continue // 同一份日志里同一结果写了两遍
    seen.add(key)
    out.push({ at, order: order++, kind, session, total: ev.total_cost_usd })
  }
  return out
}

/** 按会话累计取增量：events 带 taskId，跨任务 / 跨代同一会话也接得上。返回带 usd（本次增量）的 events，按时间排好。 */
export const sessionIncrements = (events) => {
  const sorted = [...events].sort((a, b) => a.at - b.at || a.fileOrder - b.fileOrder || a.order - b.order)
  const last = new Map()
  return sorted.map((e) => {
    const prev = e.session ? last.get(e.session) : undefined
    const usd = prev != null && e.total >= prev ? e.total - prev : e.total
    if (e.session) last.set(e.session, Math.max(prev ?? 0, e.total))
    return { ...e, usd }
  })
}

const subdirs = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(dir, d.name)) : [])

/** 一个审计根目录下全部 .log 的调用（带 taskId），已按会话取增量。 */
export const auditCalls = (auditsRoot) => {
  const events = []
  let fileOrder = 0
  for (const projectDir of subdirs(auditsRoot)) {
    for (const f of readdirSync(projectDir).sort()) {
      const m = f.match(/^(.*)-e(\d+)\.log$/)
      if (!m) continue
      fileOrder += 1
      for (const e of parseCostLog(readFileSync(join(projectDir, f), 'utf8'))) events.push({ ...e, taskId: m[1], epoch: Number(m[2]), fileOrder })
    }
  }
  return sessionIncrements(events)
}

/**
 * 录放命中立刻回放（没设 SIM_AI_CACHE_HIT_DELAY=orig）省掉的录时耗时，按任务汇总：ai-cache.log 的命中行「耗时 Nms 原耗时 Mms」，
 * N 不到 M 的一半算立刻回放。这些 case 的虚拟时延比真跑偏快。返回 Map<taskId, ms>。
 */
export const instantHitSavedMs = (simDir) => {
  const taskOfKey = new Map(readJsonl(join(simDir, 'ai-cache-calls.jsonl')).filter((c) => c.outcome === 'hit' && c.key && c.taskId).map((c) => [c.key.slice(0, 12), c.taskId]))
  const out = new Map()
  const p = join(simDir, 'ai-cache.log')
  if (!existsSync(p)) return out
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\S+ hit \S+ ([0-9a-f]{12}) (\d+)ms 原耗时 (\d+)ms/)
    if (!m || Number(m[2]) * 2 >= Number(m[3])) continue
    const task = taskOfKey.get(m[1])
    if (task) out.set(task, (out.get(task) || 0) + Number(m[3]) - Number(m[2]))
  }
  return out
}

/** 本 sim 里录放命中的那些调用的结果（session|total），从缓存条目的 stdout 里读。 */
const hitResults = (simDir) => {
  const keys = readJsonl(join(simDir, 'ai-cache-calls.jsonl')).filter((c) => c.outcome === 'hit' && c.key).map((c) => c.key)
  const out = new Set()
  for (const key of keys) {
    const p = join(cacheRoot(), key, 'stdout.txt')
    if (!existsSync(p)) continue
    for (const e of parseCostLog(readFileSync(p, 'utf8'))) out.add(`${e.session}|${e.total}`)
  }
  return out
}

// —— falive 侧 ——
let faliveCache = null
/** falive 当时：每 case 的可见 bot 话时刻、每任务花费、审计覆盖起点。 */
export const loadFaliveSide = (data = loadJudgeData()) => {
  if (faliveCache) return faliveCache
  const cases = data.cases.map((c) => ({ ...c, atMs: Date.parse(c.at), msg: data.byId.get(c.id) }))
    .sort((a, b) => a.atMs - b.atMs || a.id.localeCompare(b.id))
  const owners = createFaliveBotOwners({ timeline: data.timeline, cases, auditFiles: loadFaliveAuditFiles() })
  const msgsByCase = new Map()
  const how = {} // 组 id → { card, thread, nearest, dm, unattributed }
  for (const g of data.groups) {
    const inGroup = cases.filter((c) => g.caseIds.includes(c.id))
    for (const id of g.faliveBotIds || []) {
      const m = data.byId.get(id)
      if (!m) continue
      let owner = null
      let via = null
      if (m.chatKey === WEBHOOK_CHAT_KEY) { owner = owners.dmOwner(m); via = 'dm' } else {
        owner = owners.groupCardOwner(m)?.owner || null
        via = 'card'
        if (!owner || !g.caseIds.includes(owner)) {
          const before = inGroup.filter((c) => c.atMs <= m.atMs && c.msg?.chatId === m.chatId)
          owner = (m.threadId && before.filter((c) => c.msg?.threadId === m.threadId).at(-1)?.id) || null
          via = 'thread'
          if (!owner) { const near = before.at(-1); owner = near && m.atMs - near.atMs <= FOLLOW_MS ? near.id : null; via = 'nearest' }
        }
      }
      const h = (how[g.id] ||= {})
      if (!owner || !g.caseIds.includes(owner)) { h.unattributed = (h.unattributed || 0) + 1; continue }
      h[via] = (h[via] || 0) + 1
      if (!msgsByCase.has(owner)) msgsByCase.set(owner, [])
      msgsByCase.get(owner).push(m)
    }
  }
  const calls = auditCalls(join(faliveRuntimeDir, 'lark-audits'))
  const costByTask = new Map()
  for (const c of calls) costByTask.set(c.taskId, (costByTask.get(c.taskId) || 0) + c.usd)
  const coverageStartMs = calls.length ? Math.min(...calls.map((c) => c.at).filter(Boolean)) : Infinity
  faliveCache = { msgsByCase, attribution: how, costByTask, coverageStartMs, calls: calls.length }
  return faliveCache
}

/**
 * 结论时延：问话人看得到的第一句「实质」的话（不是「收到，我查一下」这类 ack，case-context.mjs isAck，两边同一把尺）；
 * 全是 ack 的（闲聊 / 记一笔，ack 本身就是结论）取最后一句——lark-bot 任务还没结论（running / failed 等）时这一档不算。
 * items：[{ afterMs, text }] 按时间排好。
 */
export const conclusionMs = (items, { concluded = true } = {}) => {
  if (!items.length) return null
  const real = items.find((x) => !isAck(x.text))
  if (real) return real.afterMs
  return concluded ? items.at(-1).afterMs : null
}

/** falive 一条 case：可见 bot 话的首句 / 结论时延、花费。 */
export const faliveCaseFacts = ({ m, side }) => {
  const visible = (side.msgsByCase.get(m.id) || [])
    .filter((x) => x.atMs >= m.atMs && (m.chatKey === WEBHOOK_CHAT_KEY ? x.chatKey === WEBHOOK_CHAT_KEY : x.chatId === m.chatId))
    .sort((a, b) => a.atMs - b.atMs)
    .map((x) => ({ afterMs: x.atMs - m.atMs, text: x.text }))
  const covered = m.atMs >= side.coverageStartMs
  return {
    firstMs: visible.length ? visible[0].afterMs : null,
    concludeMs: conclusionMs(visible),
    replies: visible.length,
    costUsd: covered ? side.costByTask.get(m.id) || 0 : null,
  }
}

/** lark-bot 一条 case（rules 行 + 本 sim 花费）。 */
export const larkCaseFacts = ({ row, cost }) => {
  const visible = row.lark.lines.filter((l) => l.channel === 'group' || row.principalDm)
  const status = row.lark.mergedInto ? row.lark.mergedTargetStatus : row.lark.status
  return {
    firstMs: visible.length ? visible[0].afterMs : null,
    concludeMs: conclusionMs(visible, { concluded: !NOT_CONCLUDED.has(status) }),
    replies: visible.length,
    status: row.lark.status,
    costUsd: cost?.usd || 0,
    actualUsd: cost?.actual || 0,
    calls: cost?.calls || 0,
    hits: cost?.hits || 0,
  }
}

// —— 一轮 ——
export const computeRoundMetrics = ({ round, all = false, data = loadJudgeData() }) => {
  const sims = listSimDirs({ round }).filter((s) => s.episodeId)
  const done = sims.filter((s) => existsSync(join(s.dir, 'DONE')))
  const used = all ? sims : done
  const side = loadFaliveSide(data)
  const rows = []
  const judgeLines = []
  const gaps = []
  const unattributed = { usd: 0, calls: 0, tasks: new Set() }
  let bypass = 0
  let cacheCalls = 0
  let cachedAuditEvents = 0
  let noCache = 0
  for (const entry of used) {
    const sim = loadSim(entry)
    const { rows: ruleRows } = computeSimRules({ sim, data })
    const caseIds = new Set(ruleRows.map((r) => r.id))
    const hits = hitResults(sim.dir)
    const saved = instantHitSavedMs(sim.dir)
    const costs = new Map()
    const calls = auditCalls(join(sim.dir, 'runtime', 'lark-audits'))
    if (existsSync(join(sim.dir, 'ai-cache-calls.jsonl'))) cachedAuditEvents += calls.length
    for (const c of calls) {
      const hit = hits.has(`${c.session}|${c.total}`)
      if (!caseIds.has(c.taskId)) { unattributed.usd += c.usd; unattributed.calls += 1; unattributed.tasks.add(c.taskId); continue }
      const x = costs.get(c.taskId) || { usd: 0, actual: 0, calls: 0, hits: 0 }
      x.usd += c.usd
      x.calls += 1
      if (hit) x.hits += 1
      else x.actual += c.usd
      costs.set(c.taskId, x)
    }
    if (!existsSync(join(sim.dir, 'ai-cache-calls.jsonl'))) noCache += 1
    const aiCalls = readJsonl(join(sim.dir, 'ai-cache-calls.jsonl'))
    bypass += aiCalls.filter((c) => c.outcome === 'bypass').length
    cacheCalls += aiCalls.filter((c) => c.outcome !== 'bypass').length
    judgeLines.push(...readJsonl(join(sim.dir, 'judge.jsonl')))
    for (const row of ruleRows) {
      const m = data.byId.get(row.id)
      rows.push({
        id: row.id, episode: entry.episodeId, at: row.at, chatKey: row.chatKey, kind: row.kind, risk: row.risk, pending: row.pending, flags: row.flags,
        text: String(data.cases.find((c) => c.id === row.id)?.text || '').replace(/\s+/g, ' ').slice(0, 60),
        lark: { ...larkCaseFacts({ row, cost: costs.get(row.id) }), instantHitSavedMs: saved.get(row.id) || 0 },
        falive: faliveCaseFacts({ m, side }),
      })
    }
  }
  const verdicts = collapseVerdicts(judgeLines)
  for (const r of rows) {
    const v = verdicts.get(r.id)
    r.better = v?.better || null
    r.reason = v?.reason ? String(v.reason).slice(0, 120) : null
    if (r.better === 'pending' || data.tags.get(r.id)?.pending) r.pending = true
    r.simLimit = r.pending ? null : simLimitOf({ verdict: v || {}, flags: r.flags })
  }
  const scored = rows.filter((r) => !r.pending && !r.simLimit)
  const simLimited = rows.filter((r) => r.simLimit)

  // 1 准
  const dist = (list) => {
    const d = Object.fromEntries(VERDICTS.map((k) => [k, 0]))
    let unjudged = 0
    for (const r of list) if (VERDICTS.includes(r.better)) d[r.better] += 1; else unjudged += 1
    return { ...d, judged: VERDICTS.reduce((a, k) => a + d[k], 0), unjudged }
  }
  const byKey = (keyOf) => {
    const groups = new Map()
    for (const r of scored) for (const k of keyOf(r)) { if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r) }
    return Object.fromEntries([...groups.entries()].sort().map(([k, list]) => [k, dist(list)]))
  }
  const accuracy = {
    overall: dist(scored),
    pending: rows.filter((r) => r.pending).length,
    simLimited: dist(simLimited),
    byRisk: byKey((r) => (r.risk?.length ? r.risk : ['（无风险标签）'])),
    byKind: byKey((r) => [r.kind || '（未标）']),
  }

  // 2 快
  const latency = {}
  for (const key of ['firstMs', 'concludeMs']) {
    const larkVals = scored.filter((r) => r.lark[key] != null)
    const faliveVals = scored.filter((r) => r.falive[key] != null)
    const paired = scored.filter((r) => r.lark[key] != null && r.falive[key] != null)
    const diffs = paired.map((r) => r.lark[key] - r.falive[key])
    latency[key] = {
      lark: summarize(larkVals.map((r) => r.lark[key])),
      falive: summarize(faliveVals.map((r) => r.falive[key])),
      paired: {
        n: paired.length,
        lark: summarize(paired.map((r) => r.lark[key])),
        falive: summarize(paired.map((r) => r.falive[key])),
        diff: summarize(diffs),
        larkFaster: diffs.filter((d) => d < 0).length,
        faliveFaster: diffs.filter((d) => d > 0).length,
      },
      larkOnly: scored.filter((r) => r.lark[key] != null && r.falive[key] == null).length,
      faliveOnly: scored.filter((r) => r.lark[key] == null && r.falive[key] != null).length,
    }
  }

  // 3 省
  const covered = scored.filter((r) => r.falive.costUsd != null)
  const pairedCost = covered.filter((r) => r.lark.costUsd > 0 || r.falive.costUsd > 0)
  const cost = {
    lark: { ...summarize(scored.map((r) => r.lark.costUsd)), actualTotal: scored.reduce((a, r) => a + r.lark.actualUsd, 0), calls: scored.reduce((a, r) => a + r.lark.calls, 0), hits: scored.reduce((a, r) => a + r.lark.hits, 0) },
    faliveCoverageFrom: Number.isFinite(side.coverageStartMs) ? new Date(side.coverageStartMs).toISOString() : null,
    paired: {
      n: pairedCost.length,
      covered: covered.length,
      lark: summarize(pairedCost.map((r) => r.lark.costUsd)),
      falive: summarize(pairedCost.map((r) => r.falive.costUsd)),
      diff: summarize(pairedCost.map((r) => r.lark.costUsd - r.falive.costUsd)),
      larkCheaper: pairedCost.filter((r) => r.lark.costUsd < r.falive.costUsd).length,
      faliveCheaper: pairedCost.filter((r) => r.lark.costUsd > r.falive.costUsd).length,
    },
    unattributed: { usd: unattributed.usd, calls: unattributed.calls, tasks: [...unattributed.tasks] },
  }

  if (bypass) gaps.push(`lark-bot 直通（bypass）调用 ${bypass} 次没有花费记录（text 输出，拿不到 result 事件；不在任务审计里，不计入任何 case）`)
  if (noCache) gaps.push(`${noCache} 个事件组没开录放（没有 ai-cache-calls.jsonl）：全是真调，实花 = 等价，直通调用数不知道`)
  if (cacheCalls !== cachedAuditEvents) gaps.push(`lark-bot 录放调用 ${cacheCalls} 次 ≠ 审计日志里的结果行 ${cachedAuditEvents} 条（有调用的花费没进审计，或审计里有不经录放的调用）`)
  if (unattributed.calls) gaps.push(`lark-bot 审计里不属于本组 case 的任务 ${unattributed.tasks.size} 个、${unattributed.calls} 次调用、$${unattributed.usd.toFixed(2)}，不计入 case`)
  const beforeCoverage = scored.filter((r) => r.falive.costUsd == null).length
  if (beforeCoverage) gaps.push(`falive 审计 ${cost.faliveCoverageFrom?.slice(0, 16)} 起才有：之前的 ${beforeCoverage} 条 case 没有 falive 花费，不进花费对比`)
  const coveredZero = covered.filter((r) => r.falive.costUsd === 0 && r.lark.costUsd > 0)
  if (coveredZero.length) {
    const gatewayLog = (() => { try { return readFileSync(join(faliveLogDir, 'gateway.log'), 'utf8') } catch { return '' } })()
    const seen = coveredZero.filter((r) => gatewayLog.includes(r.id))
    gaps.push(`覆盖期内 falive 花费为 0、lark-bot 有花费的 ${coveredZero.length} 条（按 0 计）：falive 网关日志里没有这条的 ${coveredZero.length - seen.length} 条（falive 没处理，lark-bot 多花的是真的），`
      + `日志里有、却没有审计的 ${seen.length} 条${seen.length ? `（${seen.map((r) => r.id.slice(-8)).join(' ')}：falive 可能花了、审计没留，这几条的对比偏向 falive）` : ''}`)
  }
  const attribution = {}
  for (const s of used) for (const [k, v] of Object.entries(side.attribution[s.episodeId] || {})) attribution[k] = (attribution[k] || 0) + v
  if (attribution.unattributed) gaps.push(`falive 组内 bot 话 ${attribution.unattributed} 条归不到具体 case（不进时延）`)
  const fastHit = scored.filter((r) => r.lark.instantHitSavedMs > 0)
  if (fastHit.length) gaps.push(`录放命中立刻回放的 case ${fastHit.length} 条（${fastHit.map((r) => r.id.slice(-8)).join(' ')}），共省掉录时耗时 ${fmtMs(fastHit.reduce((a, r) => a + r.lark.instantHitSavedMs, 0))}：这几条 lark-bot 的时延偏快（要真实时延用 SIM_AI_CACHE_HIT_DELAY=orig 跑）`)
  const unjudged = scored.filter((r) => !VERDICTS.includes(r.better)).length
  if (unjudged) gaps.push(`${unjudged} 条计分 case 还没有裁判结论`)

  return {
    version: METRICS_VERSION,
    round,
    generatedAt: new Date().toISOString(),
    episodes: { total: sims.length, done: done.length, used: used.length, ids: used.map((s) => s.episodeId) },
    cases: { total: rows.length, scored: scored.length, pending: rows.filter((r) => r.pending).length, simLimited: simLimited.length },
    accuracy,
    latency,
    cost,
    faliveAttribution: attribution,
    gaps,
    rows,
  }
}

// —— markdown ——
export const fmtMs = (ms) => {
  if (ms == null) return '-'
  const neg = ms < 0
  const a = Math.abs(ms)
  const s = a < 60_000 ? `${Math.round(a / 1000)}s` : a < 3600_000 ? `${(a / 60_000).toFixed(1)}min` : `${(a / 3600_000).toFixed(1)}h`
  return neg ? `−${s}` : s
}
const fmtUsd = (v) => (v == null ? '-' : `${v < 0 ? '−' : ''}$${Math.abs(v).toFixed(2)}`)
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '-')

export const renderMarkdown = (m) => {
  const a = m.accuracy.overall
  const L = m.latency
  const C = m.cost
  const verdict = (ok) => (ok ? '不差于' : '**差于**')
  const lat = (k) => L[k].paired.n ? verdict(L[k].paired.lark.median <= L[k].paired.falive.median && L[k].paired.lark.p90 <= L[k].paired.falive.p90) : '无配对'
  const costOk = C.paired.n ? verdict(C.paired.lark.median <= C.paired.falive.median && C.paired.lark.total <= C.paired.falive.total) : '无配对'
  const distRow = (k, d) => `| ${k} | ${d.judged} | ${d['lark-bot']} | ${d.same} | ${d.falive} | ${d.both_wrong} | ${d.unjudged} |`
  const one = (r) => `\`${r.id.slice(-8)}\` ${r.episode} ${r.at.slice(5, 16)} [${r.kind || '-'}${r.risk?.length ? ` ${r.risk.join('/')}` : ''}] ${r.text}`
  const worst = (list, fmt) => (list.length ? list.slice(0, 10).map((r) => `- ${one(r)} —— ${fmt(r)}`) : ['- （无）'])
  const scored = m.rows.filter((r) => !r.pending && !r.simLimit)
  const latWorst = (k) => scored.filter((r) => r.lark[k] != null && r.falive[k] != null).sort((x, y) => (y.lark[k] - y.falive[k]) - (x.lark[k] - x.falive[k]))
    .filter((r) => r.lark[k] > r.falive[k])
  const missing = (k) => scored.filter((r) => r.lark[k] == null && r.falive[k] != null)
  const costWorst = scored.filter((r) => r.falive.costUsd != null && r.lark.costUsd > r.falive.costUsd).sort((x, y) => (y.lark.costUsd - y.falive.costUsd) - (x.lark.costUsd - x.falive.costUsd))
  const costTop = [...scored].sort((x, y) => y.lark.costUsd - x.lark.costUsd).filter((r) => r.lark.costUsd > 0)
  const badJudge = scored.filter((r) => r.better === 'falive' || r.better === 'both_wrong').sort((x, y) => (y.risk?.length || 0) - (x.risk?.length || 0) || (x.better === 'falive' ? -1 : 1))
  return [
    `# ${m.round} 三项指标（${m.version}，${m.generatedAt.slice(5, 16)}）`, '',
    `事件组 ${m.episodes.used} / ${m.episodes.total}（跑完 ${m.episodes.done}）；case ${m.cases.total}，计分 ${m.cases.scored}，待办不计分 ${m.cases.pending}，模拟局限不计分 ${m.cases.simLimited ?? 0}。时间均为虚拟时间、从人发消息算起；花费为等价花费（录放命中照算录时的数）。`, '',
    '| 指标 | lark-bot | falive | 配对 | 配对差中位（lark−falive） | 判定 |', '|---|---|---|---|---|---|',
    `| 准：lark-bot 更好 / falive 更好 | ${a['lark-bot']}（${pct(a['lark-bot'], a.judged)}） | ${a.falive}（${pct(a.falive, a.judged)}） | 已判 ${a.judged}（一样 ${a.same}、都不对 ${a.both_wrong}） | - | ${a['lark-bot'] > a.falive ? 'lark-bot 多' : '**不多于 falive**'} |`,
    ...['firstMs', 'concludeMs'].map((k) => `| 快：${k === 'firstMs' ? '首句' : '结论'} 中位 / P90 | ${fmtMs(L[k].paired.lark.median)} / ${fmtMs(L[k].paired.lark.p90)}（全部 n=${L[k].lark.n}：${fmtMs(L[k].lark.median)} / ${fmtMs(L[k].lark.p90)}） | ${fmtMs(L[k].paired.falive.median)} / ${fmtMs(L[k].paired.falive.p90)}（全部 n=${L[k].falive.n}：${fmtMs(L[k].falive.median)} / ${fmtMs(L[k].falive.p90)}） | ${L[k].paired.n}（lark 快 ${L[k].paired.larkFaster}、falive 快 ${L[k].paired.faliveFaster}；只 lark ${L[k].larkOnly}、只 falive ${L[k].faliveOnly}） | ${fmtMs(L[k].paired.diff.median)} | ${lat(k)} |`),
    `| 省：每 case 中位 / 合计 | ${fmtUsd(C.paired.lark.median)} / ${fmtUsd(C.paired.lark.total)}（全部 ${C.lark.n} 条合计 ${fmtUsd(C.lark.total)}，本轮实花 ${fmtUsd(C.lark.actualTotal)}，命中 ${C.lark.hits}/${C.lark.calls} 次） | ${fmtUsd(C.paired.falive.median)} / ${fmtUsd(C.paired.falive.total)} | ${C.paired.n}（覆盖期内 ${C.paired.covered}；lark 省 ${C.paired.larkCheaper}、falive 省 ${C.paired.faliveCheaper}） | ${fmtUsd(C.paired.diff.median)} | ${costOk} |`,
    '', '## 准：裁判分布', '', '| 范围 | 已判 | lark-bot 更好 | 一样 | falive 更好 | 都不对 | 未判 |', '|---|---|---|---|---|---|---|',
    distRow('全部', a), ...(m.accuracy.simLimited ? [distRow('（不计分）模拟局限', m.accuracy.simLimited)] : []), ...Object.entries(m.accuracy.byRisk).map(([k, d]) => distRow(`风险 ${k}`, d)), ...Object.entries(m.accuracy.byKind).map(([k, d]) => distRow(`类型 ${k}`, d)),
    '', '## 差的 10 条', '',
    '### 准：falive 更好 / 都不对（风险优先）', '', ...worst(badJudge, (r) => `${r.better}：${r.reason || ''}`), '',
    '### 快：首句比 falive 慢得最多', '', ...worst(latWorst('firstMs'), (r) => `lark ${fmtMs(r.lark.firstMs)} vs falive ${fmtMs(r.falive.firstMs)}`), '',
    `### 快：falive 回了、lark-bot 问话人看不到回复（${missing('firstMs').length}）`, '', ...worst(missing('firstMs'), (r) => `falive ${fmtMs(r.falive.firstMs)}；lark 终态 ${r.lark.status || '-'}`), '',
    '### 快：结论比 falive 慢得最多', '', ...worst(latWorst('concludeMs'), (r) => `lark ${fmtMs(r.lark.concludeMs)} vs falive ${fmtMs(r.falive.concludeMs)}`), '',
    '### 省：比 falive 多花得最多', '', ...worst(costWorst, (r) => `lark ${fmtUsd(r.lark.costUsd)} vs falive ${fmtUsd(r.falive.costUsd)}`), '',
    '### 省：lark-bot 花得最多', '', ...worst(costTop, (r) => `${fmtUsd(r.lark.costUsd)}（${r.lark.calls} 次调用，命中 ${r.lark.hits}）；falive ${fmtUsd(r.falive.costUsd)}`), '',
    '## 数据缺口', '', ...(m.gaps.length ? m.gaps.map((g) => `- ${g}`) : ['- （无）']), '',
    `falive 话的归属：${JSON.stringify(m.faliveAttribution)}`,
  ].join('\n')
}

const main = () => {
  const args = process.argv.slice(2)
  const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
  const round = value('--round', null)
  if (!round) { console.error('用法：node scripts/sim/round-metrics.mjs --round <轮> [--md out.md] [--json out.json] [--all]'); process.exit(2) }
  const metrics = computeRoundMetrics({ round, all: args.includes('--all') })
  if (!metrics.episodes.used) { console.error(`[round-metrics] ${round}：没有跑完的事件组（共 ${metrics.episodes.total}；--all 连没跑完的也算）`); process.exit(2) }
  const md = renderMarkdown(metrics)
  const jsonPath = value('--json', join(simRoot(), round, 'metrics.json'))
  writeFileSync(jsonPath, `${JSON.stringify(metrics, null, 1)}\n`)
  if (value('--md', null)) writeFileSync(value('--md', null), `${md}\n`)
  console.log(md)
  console.error(`[round-metrics] → ${jsonPath}`)
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main()
