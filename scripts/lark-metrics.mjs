#!/usr/bin/env node
/**
 * 审计度量（S6，见 lib/lark-audit-metrics.mjs）：
 *   node scripts/lark-metrics.mjs [--dir <审计根目录>] [--days N] [--json]
 * 默认读本仓 runtime/lark-audits（所有项目子目录），按 .log 修改时间取最近 N 天（默认 30）。只读，不写任何文件。
 *   node scripts/lark-metrics.mjs --latency [--days N] [--json]
 * 端到端时延（lib/lark-latency，读 runtime/lark-latency.jsonl）：发出 → 回「收到」/ 分类 / 领取 / 执行 / 交付 / 建文档 各段中位与慢的 1/10。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { formatAuditMetrics, parseAuditLog, summarizeAuditMetrics } from '../lib/lark-audit-metrics.mjs'
import { larkAuditsRoot, larkLatencyPath } from '../lib/lark-paths.mjs'
import { formatLatency, readLatency, summarizeLatency } from '../lib/lark-latency.mjs'

const argv = process.argv.slice(2)
const option = (name, fallback) => {
  const at = argv.indexOf(name)
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback
}
const root = option('--dir', larkAuditsRoot)
const days = Number(option('--days', '30'))
const since = Date.now() - days * 86_400_000
if (argv.includes('--latency')) {
  const summary = summarizeLatency(readLatency({ path: option('--file', larkLatencyPath), sinceMs: since }))
  console.log(argv.includes('--json') ? JSON.stringify(summary, null, 2) : formatLatency(summary))
  process.exit(0)
}
if (!existsSync(root)) {
  console.error(`审计目录不存在：${root}`)
  process.exit(1)
}
const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}
const entries = []
for (const project of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())) {
  const dir = join(root, project.name)
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.log'))) {
    const path = join(dir, name)
    if (statSync(path).mtimeMs < since) continue
    entries.push({ audit: readJson(path.replace(/\.log$/, '.json')), sessions: parseAuditLog(readFileSync(path, 'utf8')) })
  }
}
const metrics = summarizeAuditMetrics(entries)
console.log(argv.includes('--json') ? JSON.stringify(metrics, null, 2) : `${root}（近 ${days} 天）\n${formatAuditMetrics(metrics)}`)
