#!/usr/bin/env node
/**
 * L1 对照：lark-bot 现在的分类 / 落地 vs falive 当时（网关日志 + 台账）。
 *   node scripts/sim/compare-intake.mjs --run base-low [--run2 base-high] [--md]
 * 打印：决策混淆矩阵、落地结果对照、逐条差异（给人看 / 给报告用）。--md 时把差异清单写到 l1/<run>/report.md。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { datasetDir, replayRoot } from './falive-data.mjs'

const args = process.argv.slice(2)
const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const runName = value('--run', 'base-low')
const run2 = value('--run2', null)
const asMd = args.includes('--md')

const episodes = new Map(JSON.parse(readFileSync(join(datasetDir, 'episodes.json'), 'utf8')).map((e) => [e.id, e]))
const timeline = new Map(JSON.parse(readFileSync(join(datasetDir, 'timeline.json'), 'utf8')).map((m) => [m.id, m]))
const loadRun = (name) => new Map(readFileSync(join(replayRoot, 'l1', name, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)).map((r) => [r.id, r]))
const rows = loadRun(runName)
const rows2 = run2 ? loadRun(run2) : null

// falive 当时的落地：从网关路由行推。
export const baselineOutcome = (episode) => {
  const routing = (episode.baseline.routing || []).join('\n')
  const cls = episode.baseline.classified
  if (/正式入队/.test(routing)) return 'actionable'
  if (/只记台账|被动模式/.test(routing)) return 'recordOnly'
  if (/suspected/.test(routing)) return 'suspected'
  if (/blocked ask/.test(routing)) return 'askBack'
  if (/指示任务|续跑|并入任务|同话题归并/.test(routing)) return 'merged'
  if (cls?.decision === 'ignore' || /静默忽略/.test(routing)) return 'ignored'
  return cls ? 'unknown' : 'unlogged'
}
// lark-bot 这次的落地（applyIntakeClassification 的返回）。
export const replayOutcome = (row) => {
  if (!row) return 'missing'
  if (row.skipped) return row.route ? `route:${row.route}` : 'no_trigger' // route：ingest 按原话确定处理、不过分类（replay-intake deterministicRoute）
  if (row.error) return 'error'
  const o = row.outcome || {}
  if (o.selfAnswer) return 'selfAnswer'
  if (o.actionable) return 'actionable'
  if (o.askBack) return 'askBack'
  if (o.suspected) return 'suspected'
  if (o.recordOnly) return 'recordOnly'
  return 'ignored'
}

const matrix = {}
const bump = (a, b) => { matrix[a] = matrix[a] || {}; matrix[a][b] = (matrix[a][b] || 0) + 1 }
const outcomeMatrix = {}
const bumpO = (a, b) => { outcomeMatrix[a] = outcomeMatrix[a] || {}; outcomeMatrix[a][b] = (outcomeMatrix[a][b] || 0) + 1 }
const diffs = []
let compared = 0
for (const [id, row] of rows) {
  const e = episodes.get(id)
  if (!e) continue
  const base = e.baseline.classified
  const got = row.classification || null
  if (row.skipped || !base) {
    bump(base?.decision || 'unlogged', row.skipped ? replayOutcome(row) : got?.decision || 'error')
    continue
  }
  compared += 1
  bump(base.decision, got?.decision || 'error')
  const bo = baselineOutcome(e)
  const ro = replayOutcome(row)
  bumpO(bo, ro)
  const decisionDiff = base.decision !== got?.decision
  const outcomeDiff = bo !== ro && !(bo === 'merged')
  if (decisionDiff || outcomeDiff) {
    const m = timeline.get(id)
    diffs.push({
      id, at: m ? new Date(m.atMs).toISOString().slice(5, 16).replace('T', ' ') : '', chat: m?.chatKey, sender: m?.senderName, text: String(m?.text || '').replace(/\s+/g, ' ').slice(0, 90),
      falive: `${base.decision}/${base.confidence || '?'} → ${bo}`, larkBot: `${got?.decision || 'error'}/${got?.confidence || '?'}${got?.deliverable ? `·${got.deliverable}` : ''} → ${ro}`,
      reply: got?.reply || null, reason: got?.reason || null, botReply: e.baseline.botReplies?.[0]?.text?.slice(0, 120) || null,
      run2: rows2?.get(id)?.classification ? `${rows2.get(id).classification.decision}/${rows2.get(id).classification.confidence} → ${replayOutcome(rows2.get(id))}` : null,
    })
  }
}

const printMatrix = (title, mat) => {
  const cols = [...new Set(Object.values(mat).flatMap((r) => Object.keys(r)))].sort()
  console.log(`\n== ${title}（行 = falive 当时，列 = lark-bot 现在）`)
  console.log(['falive \\ lark-bot', ...cols, '合计'].join('\t'))
  for (const [k, r] of Object.entries(mat).sort()) console.log([k, ...cols.map((c) => r[c] || 0), Object.values(r).reduce((a, b) => a + b, 0)].join('\t'))
}
printMatrix('决策', matrix)
printMatrix('落地', outcomeMatrix)
const agreeDecision = Object.entries(matrix).reduce((n, [k, r]) => n + (r[k] || 0), 0)
const agreeOutcome = Object.entries(outcomeMatrix).reduce((n, [k, r]) => n + (r[k] || 0), 0)
console.log(`\n可比 ${compared} 条：决策一致 ${agreeDecision}，落地一致 ${agreeOutcome}；差异 ${diffs.length} 条`)
const ms = [...rows.values()].map((r) => r.ms).filter((x) => x > 0).sort((a, b) => a - b)
if (ms.length) console.log(`分类耗时中位 ${ms[Math.floor(ms.length / 2)] / 1000}s，P90 ${ms[Math.floor(ms.length * 0.9)] / 1000}s`)

if (asMd) {
  const lines = [`# L1 分类回放差异（run=${runName}${run2 ? `，对照 ${run2}` : ''}，可比 ${compared}，差异 ${diffs.length}）`, '']
  for (const d of diffs) {
    lines.push(`## ${d.at} ${d.chat} ${d.sender}：${d.text}`)
    lines.push(`- id ${d.id}`)
    lines.push(`- falive：${d.falive}${d.botReply ? `；当时回复「${d.botReply.replace(/\n/g, ' ')}」` : ''}`)
    lines.push(`- lark-bot：${d.larkBot}${d.run2 ? `（${run2}：${d.run2}）` : ''}`)
    if (d.reply) lines.push(`- 这次 reply：${d.reply}`)
    if (d.reason) lines.push(`- 理由：${d.reason}`)
    lines.push('')
  }
  const out = join(replayRoot, 'l1', runName, 'report.md')
  writeFileSync(out, lines.join('\n'))
  console.log(`差异清单写到 ${out}`)
} else {
  for (const d of diffs) console.log(`- ${d.at} ${d.chat} ${d.sender}「${d.text}」\n    falive ${d.falive} | lark-bot ${d.larkBot}${d.run2 ? ` | ${run2} ${d.run2}` : ''}`)
}
