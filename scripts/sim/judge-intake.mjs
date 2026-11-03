#!/usr/bin/env node
/**
 * L1 裁判（docs/falive-replay-plan-2026-11-03.md A5）：对 L1 回放里与 falive 当时不一致的条目（或 --all 全部可比条目），
 * 把消息 + 上下文 + 事后信息（falive 当时 bot 怎么回、人接下来怎么反应、台账 / 审计结论）交给模型，判两边谁更合适。
 *   node scripts/sim/judge-intake.mjs --run base-low [--run2 base-high] [--all] [--conc 4] [--limit n]
 * 结果追加到 l1/<run>/judge.jsonl（可续跑），最后打印汇总：lark-bot 更好 / falive 更好 / 一样 / 都不对。
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { datasetDir, replayRoot } from './falive-data.mjs'
import { baselineOutcome, replayOutcome } from './compare-intake.mjs'

const args = process.argv.slice(2)
const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const runName = value('--run', 'base-low')
const run2 = value('--run2', null)
const all = args.includes('--all')
const concurrency = Number(value('--conc', 4))
const limit = Number(value('--limit', 0))

const episodes = new Map(JSON.parse(readFileSync(join(datasetDir, 'episodes.json'), 'utf8')).map((e) => [e.id, e]))
const timeline = JSON.parse(readFileSync(join(datasetDir, 'timeline.json'), 'utf8'))
const byId = new Map(timeline.map((m) => [m.id, m]))
const loadRun = (name) => new Map(readFileSync(join(replayRoot, 'l1', name, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)).map((r) => [r.id, r]))
const rows = loadRun(runName)
const rows2 = run2 ? loadRun(run2) : null
const outPath = join(replayRoot, 'l1', runName, 'judge.jsonl')
const done = new Set(existsSync(outPath) ? readFileSync(outPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).id) : [])

const fmt = (ms) => new Date(ms).toISOString().slice(5, 16).replace('T', ' ')
const contextOf = (m) => timeline
  .filter((x) => x.chatId === m.chatId && x.atMs < m.atMs && !x.deleted && x.text && x.senderType !== 'system')
  .slice(-12)
  .map((x) => `${x.senderName}${x.ownBot ? '（bot）' : ''}（${fmt(x.atMs)}）：${String(x.text).replace(/\s+/g, ' ').slice(0, 300)}`)
  .join('\n')
const describe = (cls, outcome) => cls ? `${cls.decision}/${cls.confidence}${cls.deliverable ? `·${cls.deliverable}` : ''} → 落地 ${outcome}${cls.reply ? `；回复「${cls.reply}」` : ''}` : '（无）'

const schema = JSON.stringify({
  type: 'object',
  additionalProperties: false,
  required: ['better', 'reason', 'larkReplyQuality', 'idealDecision'],
  properties: {
    better: { type: 'string', enum: ['lark-bot', 'falive', 'same', 'both_wrong'] },
    reason: { type: 'string' },
    larkReplyQuality: { type: 'string', enum: ['good', 'awkward', 'wrong', 'none'] },
    idealDecision: { type: 'string' },
  },
})
const OUTCOME_HELP = 'actionable=建任务去做；selfAnswer=分类器一句答完；askBack=追问负责人；suspected=私信负责人确认再做；recordOnly=只记一笔回「记下了」；ignored=不处理；merged=并入已有任务'

const judgeOne = async (e, row) => {
  const m = byId.get(e.id)
  const prompt = `你是 aven（falive 前端负责人）的代理机器人的评审。下面是一条飞书群消息，机器人要决定：这条是什么（bug / requirement / api_reply / question / ignore）、要不要动手、怎么接话。
两套系统各给了一个判断。请结合「事后信息」（当时机器人真实的回复、人接下来的反应、台账 / 审计记录）判断哪一套更合适。
判断标准：以 aven 的利益为准——该做的没做是漏（更差），不该做的去做了是扰民 / 浪费（更差），接话是否像正常人、对得上前文。两边都合理就 same；都不对就 both_wrong。
落地含义：${OUTCOME_HELP}

【消息】${fmt(m.atMs)} 群「${m.chatName}」 ${m.senderName}${m.isAven ? '（aven 本人，负责人）' : ''}${m.atBot ? ' @了机器人' : ''}：
${String(m.text).slice(0, 1500)}

【群里这条之前的消息】
${contextOf(m) || '（无）'}

【A：falive 当时】${describe(e.baseline.classified ? { ...e.baseline.classified } : null, baselineOutcome(e))}
【B：lark-bot 现在（${runName}）】${describe(row.classification, replayOutcome(row))}${rows2?.get(e.id)?.classification ? `\n【B'：lark-bot 另一档强度（${run2}）】${describe(rows2.get(e.id).classification, replayOutcome(rows2.get(e.id)))}` : ''}

【事后信息】
- 当时机器人的回复：${e.baseline.botReplies?.length ? e.baseline.botReplies.map((r) => `（${fmt(r.atMs)}）${r.text.replace(/\s+/g, ' ').slice(0, 300)}`).join('\n  ') : '（2 小时内没有）'}
- 人接下来的反应：${e.baseline.humanFollowups?.length ? e.baseline.humanFollowups.map((r) => `（${fmt(r.atMs)}）${r.sender}：${r.text.replace(/\s+/g, ' ').slice(0, 200)}`).join('\n  ') : '（2 小时内没有）'}
- 台账：${e.baseline.ledger ? `${e.baseline.ledger.decision}；${e.baseline.ledger.excerpt || ''}`.slice(0, 300) : '（无）'}
- 审计：${e.baseline.audit ? `${e.baseline.audit.status} / ${e.baseline.audit.workKind || ''}；${(e.baseline.audit.finalSummary || '').slice(0, 300)}` : '（无）'}
- 网关路由：${(e.baseline.routing || []).slice(0, 6).join(' | ').slice(0, 500)}

只输出 JSON：better（lark-bot / falive / same / both_wrong）、reason（一句话，≤60 字）、larkReplyQuality（B 的那句回复：good / awkward / wrong / none）、idealDecision（你认为理想的分类 + 落地，≤30 字）。`
  const child = spawn('claude', ['-p', '--permission-mode', 'plan', '--tools', '', '--model', 'claude-opus-5-5', '--effort', 'high', '--strict-mcp-config', '--setting-sources', 'project', '--no-session-persistence', '--json-schema', schema, '--output-format', 'json', prompt], { cwd: replayRoot, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  child.stdout.on('data', (c) => { out += c })
  child.stderr.on('data', (c) => { err += c })
  const code = await new Promise((resolve) => child.on('close', resolve))
  if (code !== 0) throw new Error(`claude exit ${code}: ${err.slice(0, 200)}`)
  const envelope = JSON.parse(out)
  const structured = envelope.structured_output ?? (typeof envelope.result === 'string' ? JSON.parse(envelope.result) : envelope.result)
  return structured
}

let queue = [...rows.values()].filter((row) => {
  const e = episodes.get(row.id)
  if (!e || !e.inTimeline || !e.baseline.classified || row.skipped || row.error || done.has(row.id)) return false
  if (all) return true
  const bo = baselineOutcome(e)
  const ro = replayOutcome(row)
  return e.baseline.classified.decision !== row.classification?.decision || (bo !== ro && bo !== 'merged')
})
if (limit) queue = queue.slice(0, limit)
console.log(`[judge] run=${runName} 待判 ${queue.length} 条（已判 ${done.size}）`)
let index = 0
const results = []
const worker = async () => {
  while (index < queue.length) {
    const row = queue[index++]
    const e = episodes.get(row.id)
    try {
      const verdict = await judgeOne(e, row)
      const line = { id: row.id, run: runName, ...verdict, falive: `${e.baseline.classified.decision}/${e.baseline.classified.confidence} → ${baselineOutcome(e)}`, larkBot: `${row.classification.decision}/${row.classification.confidence} → ${replayOutcome(row)}` }
      appendFileSync(outPath, `${JSON.stringify(line)}\n`)
      results.push(line)
      console.log(`[judge] ${row.id} ${verdict.better}：${verdict.reason}`)
    } catch (error) {
      console.error(`[judge] ${row.id} 失败：${String(error.message).slice(0, 200)}`)
    }
  }
}
await Promise.all(Array.from({ length: concurrency }, worker))
const allRows = readFileSync(outPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const count = (key) => allRows.reduce((acc, r) => ({ ...acc, [r[key]]: (acc[r[key]] || 0) + 1 }), {})
console.log(`[judge] 汇总（${allRows.length} 条）：better=${JSON.stringify(count('better'))} replyQuality=${JSON.stringify(count('larkReplyQuality'))}`)
