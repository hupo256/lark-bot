/**
 * 端到端时延记账（aven 11-02「还能继续吗」：先能量）。任务做完的任务库 24 小时就清（pruneDoneAfterHours），时延要留得住，
 * 所以 gateway 每成功交付一条终态回执就往 runtime/lark-latency.jsonl 追加一行各段耗时（毫秒）：
 *   ingestMs   飞书消息发出 → 网关建好任务（含拉上下文、下附件）
 *   classifyMs 建任务 → 分类落地
 *   ackMs      飞书消息发出 → 回「收到」（用户真正等的第一句）
 *   waitMs     分类落地 / 入队 → worker 领到
 *   runMs      worker 领到 → 回写结果（AI 会话 + 收尾闸）
 *   deliverMs  回写结果 → 群里发出（含建细节文档 docMs）
 *   totalMs    飞书消息发出 → 结果发出
 * 读：scripts/lark-metrics.mjs --latency [--days N]。纯函数 + 一个追加写（同步、无子进程，gateway 纯度闸放行）。
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'

const ms = (from, to) => {
  const a = Date.parse(from || '')
  const b = Date.parse(to || '')
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? b - a : null
}

export const latencyRecordOf = ({ task, status, reportedAt, deliveredAt, docMs = null }) => {
  const origin = task?.messageCreatedAt || task?.createdAt
  const classifiedAt = task?.intake?.resolvedAt || null
  return {
    at: deliveredAt,
    id: task?.id || null,
    deliverable: task?.contract?.deliverable || null,
    status,
    epoch: task?.epoch || 0,
    ingestMs: ms(task?.messageCreatedAt, task?.createdAt),
    classifyMs: ms(task?.createdAt, classifiedAt),
    ackMs: ms(origin, task?.ackedAt),
    waitMs: ms(classifiedAt || task?.createdAt, task?.claimedAt),
    runMs: ms(task?.claimedAt, reportedAt),
    deliverMs: ms(reportedAt, deliveredAt),
    docMs: Number.isFinite(docMs) ? docMs : null,
    totalMs: ms(origin, deliveredAt),
  }
}

// 记账失败只记日志，绝不影响交付。
export const appendLatency = (record, { path, log = console.warn } = {}) => {
  if (!path || !record) return false
  try {
    appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 })
    return true
  } catch (error) {
    log(`[lark-gateway] 时延记账写失败（忽略）：${String(error?.message || error).slice(0, 120)}`)
    return false
  }
}

export const readLatency = ({ path, sinceMs = 0 } = {}) => {
  if (!path || !existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try {
      const record = JSON.parse(line)
      return Date.parse(record.at || '') >= sinceMs ? [record] : []
    } catch {
      return []
    }
  })
}

export const LATENCY_FIELDS = ['ackMs', 'ingestMs', 'classifyMs', 'waitMs', 'runMs', 'deliverMs', 'docMs', 'totalMs']

const quantile = (values, p) => {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (!sorted.length) return null
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1) + 0.5))]
}
const stats = (values) => {
  const finite = values.filter((v) => Number.isFinite(v))
  return { n: finite.length, p50: quantile(finite, 0.5), p90: quantile(finite, 0.9) }
}

export const summarizeLatency = (records = []) => {
  const fields = Object.fromEntries(LATENCY_FIELDS.map((field) => [field, stats(records.map((r) => r[field]))]))
  const byDeliverable = {}
  for (const record of records) (byDeliverable[record.deliverable || '(未分类)'] ||= []).push(record.totalMs)
  return { tasks: records.length, fields, totalByDeliverable: Object.fromEntries(Object.entries(byDeliverable).map(([key, values]) => [key, stats(values)])) }
}

const LABELS = { ackMs: '发出 → 回「收到」', ingestMs: '发出 → 建任务', classifyMs: '建任务 → 分类完', waitMs: '分类完 → 领到', runMs: '领到 → 回写结果', deliverMs: '回写 → 群里发出', docMs: '其中建细节文档', totalMs: '发出 → 结果发出' }
const sec = (value) => (value == null ? '—' : `${(value / 1000).toFixed(1)}s`)

export const formatLatency = (summary) => {
  const lines = [`时延（${summary.tasks} 条已交付任务；中位 / 慢的 1/10）`]
  for (const field of LATENCY_FIELDS) {
    const s = summary.fields[field]
    if (s.n) lines.push(`- ${LABELS[field]}：${sec(s.p50)} / ${sec(s.p90)}（${s.n} 条）`)
  }
  const kinds = Object.entries(summary.totalByDeliverable)
  if (kinds.length) lines.push(`- 按交付类型的「发出 → 结果发出」：${kinds.map(([kind, s]) => `${kind} ${sec(s.p50)} / ${sec(s.p90)}（${s.n}）`).join('；')}`)
  return lines.join('\n')
}
