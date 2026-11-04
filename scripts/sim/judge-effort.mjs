#!/usr/bin/env node
/**
 * 分类强度对照裁判（design-v2 §8 前置 1b）：同一份代码、同 285 条 case，分类器 low 与 high 各跑一遍 L1（replay-intake --intent-effort），
 * 两档判得不一样的逐条交给模型（Opus、effort max）判哪档更对；参照 falive 当时的处理与事后信息（人的反应、审计）。
 *   node scripts/sim/judge-effort.mjs --low v3-low-<sha> --high v3-high-<sha> [--conc 4]
 * 结果：l1/<low>/effort-judge.jsonl（可续跑）+ effort-judge.md（汇总 + 逐条）。
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { datasetDir, replayRoot } from './falive-data.mjs'
import { baselineOutcome, replayOutcome } from './compare-intake.mjs'

const args = process.argv.slice(2)
const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const lowRun = value('--low', null)
const highRun = value('--high', null)
if (!lowRun || !highRun) throw new Error('--low / --high 必填')
const concurrency = Number(value('--conc', 4))
const effort = value('--effort', 'max')
const here = dirname(fileURLToPath(import.meta.url))
const timeline = JSON.parse(readFileSync(join(datasetDir, 'timeline.json'), 'utf8'))
const byId = new Map(timeline.map((m) => [m.id, m]))
const episodes = new Map(JSON.parse(readFileSync(join(datasetDir, 'episodes.json'), 'utf8')).map((e) => [e.id, e]))
const loadRun = (name) => new Map(readFileSync(join(replayRoot, 'l1', name, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((r) => [r.id, r]))
const low = loadRun(lowRun)
const high = loadRun(highRun)
const outPath = join(replayRoot, 'l1', lowRun, 'effort-judge.jsonl')
const done = new Set(existsSync(outPath) ? readFileSync(outPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).id) : [])

const fmt = (ms) => new Date(ms).toISOString().slice(5, 16).replace('T', ' ')
const one = (t, n) => String(t || '').replace(/\s+/g, ' ').slice(0, n)
const keyOf = (r) => { const c = r?.classification || {}; return [c.decision, c.deliverable || '-', replayOutcome(r), c.continues || '-'].join('|') }
const describe = (r) => { const c = r?.classification; return c ? `${c.decision}/${c.confidence}${c.deliverable ? `·${c.deliverable}` : ''}${c.continues ? `·接着 ${c.continues}` : ''} → 落地 ${replayOutcome(r)}${c.reply ? `；回复「${one(c.reply, 200)}」` : ''}${c.reason ? `（理由：${one(c.reason, 80)}）` : ''}` : `（${replayOutcome(r)}）` }
const contextOf = (m) => {
  const thread = m.threadId ? timeline.filter((x) => x.threadId === m.threadId && x.atMs < m.atMs) : []
  const recent = timeline.filter((x) => x.chatId === m.chatId && x.atMs < m.atMs && !x.threadId).slice(-12)
  return [...new Set([...recent, ...thread])].filter((x) => !x.deleted && x.text).sort((a, b) => a.atMs - b.atMs).slice(-20)
    .map((x) => `${x.senderName}${x.ownBot ? '（bot）' : ''}（${fmt(x.atMs)}）：${one(x.text, 300)}`).join('\n')
}
const schema = JSON.stringify({ type: 'object', additionalProperties: false, required: ['better', 'reason', 'ideal'],
  properties: { better: { type: 'string', enum: ['low', 'high', 'same', 'both_wrong'] }, reason: { type: 'string' }, ideal: { type: 'string' } } })
const OUTCOME_HELP = 'actionable=建任务去做；selfAnswer=一句答完；askBack=追问；suspected=私信负责人确认再做；recordOnly=只记一笔；ignored=不处理；merged=并入已有任务'

const judgeOne = async (id) => {
  const m = byId.get(id)
  const e = episodes.get(id)
  const prompt = `你是 aven（前端负责人）的代理机器人的评审。机器人收到一条飞书消息后，分类器要决定：这条是什么（bug / requirement / api_reply / question / ignore 等）、交付物是什么（答复 / 实测 / 改代码 / 只记一笔）、是不是接着之前某个任务、怎么先回一句。
同一套代码，分类器用两档思考强度（low / high）各判了一次，结论不同。请判哪一档更对。标准：以 aven 的利益为准——该做的没做是漏，不该做的做了是扰民 / 浪费，接错任务最糟；回的那句要像正常人、对得上前文。两档都可接受就 same，都不对就 both_wrong。
口径（aven 11-04）：改码只在需求边界内；「已部署」后的自动复测暂不做；「能不能先打包到 uat / OL」这类按回答处理。
落地含义：${OUTCOME_HELP}

【消息】${fmt(m.atMs)} 「${m.chatName}」 ${m.senderName}${m.isAven ? '（aven 本人）' : ''}${m.atBot ? ' @了机器人' : ''}：
${one(m.text, 1500)}

【这条之前的消息（同群 + 同话题）】
${contextOf(m) || '（无）'}

【low】${describe(low.get(id))}
【high】${describe(high.get(id))}

【参考：falive 当时】${e?.baseline?.classified ? `${e.baseline.classified.decision}/${e.baseline.classified.confidence} → ${baselineOutcome(e)}` : '（无记录）'}
- 当时机器人的回复：${e?.baseline?.botReplies?.length ? e.baseline.botReplies.slice(0, 3).map((r) => `（${fmt(r.atMs)}）${one(r.text, 300)}`).join('\n  ') : '（无）'}
- 人接下来的反应：${e?.baseline?.humanFollowups?.length ? e.baseline.humanFollowups.slice(0, 4).map((r) => `（${fmt(r.atMs)}）${r.sender}：${one(r.text, 200)}`).join('\n  ') : '（无）'}
- 审计：${e?.baseline?.audit ? `${e.baseline.audit.status}；${one(e.baseline.audit.finalSummary, 300)}` : '（无）'}
（falive 当时的做法只是参考，不一定对。）

只输出 JSON：better（low / high / same / both_wrong）、reason（一句话 ≤80 字）、ideal（理想的分类 + 落地 ≤40 字）。`
  const child = spawn(join(here, 'claude-q'), ['-p', '--permission-mode', 'plan', '--tools', '', '--model', 'claude-opus-5-5', '--effort', effort, '--strict-mcp-config', '--setting-sources', 'project', '--no-session-persistence', '--json-schema', schema, '--output-format', 'json', prompt], { cwd: replayRoot, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SIM_ORIG_INTENT_MS: '1800000' } }) // 裁判也是 plan 模式：额度闸别按分类调用的 120 秒超时掐（max 强度要更久）
  let out = ''
  let err = ''
  child.stdout.on('data', (c) => { out += c })
  child.stderr.on('data', (c) => { err += c })
  const code = await new Promise((resolve) => child.on('close', resolve))
  if (code !== 0) throw new Error(`claude exit ${code}: ${err.slice(0, 200)}`)
  const env = JSON.parse(out)
  return env.structured_output ?? (typeof env.result === 'string' ? JSON.parse(env.result) : env.result)
}

const both = [...low.keys()].filter((id) => high.has(id))
const differ = both.filter((id) => keyOf(low.get(id)) !== keyOf(high.get(id)))
const queue = differ.filter((id) => !done.has(id))
console.log(`[effort] 两档都有 ${both.length} 条，判得不一样 ${differ.length} 条，待判 ${queue.length}（effort ${effort}）`)
let i = 0
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (i < queue.length) {
    const id = queue[i++]
    try {
      const v = await judgeOne(id)
      appendFileSync(outPath, `${JSON.stringify({ id, ...v, low: describe(low.get(id)), high: describe(high.get(id)) })}\n`)
      console.log(`[effort] ${id} ${v.better}：${v.reason}`)
    } catch (error) { console.error(`[effort] ${id} 失败：${String(error.message).slice(0, 200)}`) }
  }
}))
const rows = existsSync(outPath) ? readFileSync(outPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
const c = (b) => rows.filter((r) => r.better === b).length
const ms = (run) => { const v = [...run.values()].map((r) => r.ms || r.elapsedMs).filter(Boolean).sort((a, b) => a - b); return v.length ? `${Math.round(v[v.length >> 1] / 100) / 10}s` : '-' }
const md = [`# 分类强度 low vs high（${lowRun} / ${highRun}）`, '', `两档都有 ${both.length} 条；判得一样 ${both.length - differ.length}（${Math.round(((both.length - differ.length) / both.length) * 100)}%），不一样 ${differ.length}；耗时中位 low ${ms(low)} / high ${ms(high)}`, '',
  `**分歧裁判（${rows.length} 条，effort ${effort}）：low 更对 ${c('low')}，high 更对 ${c('high')}，一样 ${c('same')}，都不对 ${c('both_wrong')}**`, '',
  ...rows.map((r) => { const m = byId.get(r.id); return `- **${r.better}** ${fmt(m.atMs)} ${m.senderName}：${one(m.text, 80)}\n  - low：${r.low}\n  - high：${r.high}\n  - ${r.reason}；理想：${r.ideal}` })]
writeFileSync(join(replayRoot, 'l1', lowRun, 'effort-judge.md'), `${md.join('\n')}\n`)
console.log(md.slice(0, 5).join('\n'))
