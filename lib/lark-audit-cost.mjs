/**
 * 审计日志里的花费（11-05 从 scripts/sim/round-metrics.mjs 挪来，线上指标 lib/lark-live-scorecard 和回放指标共用）。
 * runtime/lark-audits/<项目>/<任务>-e<代>.log 里每次 claude 调用（含网关分类那一趟）的结果行带 total_cost_usd；
 * 同一会话里它是累计的（--resume 接着记），按 session_id 取增量再归到写这份日志的任务。只读。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** 审计日志里每次调用的结果行：{ at, order, kind, session, total }。分段头「=== <ISO> <executor> <kind> ===」给时间。 */
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

/** 一个审计根目录下全部 .log 的调用（带 taskId / epoch），已按会话取增量。 */
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
