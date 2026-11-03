#!/usr/bin/env node
/**
 * L2 / L3 裁判（docs/falive-replay-plan-2026-11-03.md §2）：模拟器跑完一个窗口后，对每条「触发了 bot」的真人消息
 * （@bot、回复 bot 的消息、aven 在 webhook 群说的 = 负责人私信），把消息 + 群里上下文 + 【A：falive 当时】（分类、bot 回复、人的反应、审计）
 * + 【B：lark-bot 这次模拟】（任务分类与终态、群里回复、私信 aven、审计结论）交给模型，以 aven 的利益为准判谁更合适。
 *   node scripts/sim/judge-sim.mjs --sim <name> [--conc 4] [--limit n] [--all]
 * 默认只判「有差异」的（一边回了一边没回、或分类决策不同）；--all 判全部触发消息。
 * 结果追加到 sim/<name>/judge.jsonl（可续跑，已判的跳过），最后打印 better 与 larkIssue 的分布。
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AVEN_OPEN_ID, datasetDir, replayRoot } from './falive-data.mjs'

const args = process.argv.slice(2)
const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const simName = value('--sim', null)
if (!simName) {
  console.error('用法：node scripts/sim/judge-sim.mjs --sim <name> [--conc 4] [--limit n] [--all]')
  process.exit(2)
}
const all = args.includes('--all')
const concurrency = Number(value('--conc', 4))
const limit = Number(value('--limit', 0))
const simDir = join(replayRoot, 'sim', simName)
if (!existsSync(join(simDir, 'fed.json'))) {
  console.error(`[judge-sim] 找不到 ${join(simDir, 'fed.json')}`)
  process.exit(2)
}

const FOLLOW_MS = 2 * 60 * 60_000
const CONTEXT_COUNT = 10
const readJsonl = (path) => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [])

// —— 数据集 ——
const timeline = JSON.parse(readFileSync(join(datasetDir, 'timeline.json'), 'utf8'))
const byId = new Map(timeline.map((m) => [m.id, m]))
const episodes = new Map(JSON.parse(readFileSync(join(datasetDir, 'episodes.json'), 'utf8')).map((e) => [e.id, e]))

// —— 模拟产物 ——
const fed = JSON.parse(readFileSync(join(simDir, 'fed.json'), 'utf8'))
const outbox = readJsonl(join(simDir, 'outbox.jsonl'))
const tasks = new Map()
const tasksDir = join(simDir, 'runtime', 'lark-tasks')
if (existsSync(tasksDir)) for (const f of readdirSync(tasksDir)) {
  if (!f.endsWith('.json')) continue
  try { const t = JSON.parse(readFileSync(join(tasksDir, f), 'utf8')); tasks.set(t.id, t) } catch { /* 坏文件跳过 */ }
}
// 并入别的任务的消息：对方 task.mergedFrom 里有它的 id。
const mergedInto = new Map()
for (const t of tasks.values()) for (const from of t.mergedFrom || []) mergedInto.set(from, t)
// 审计：每个任务取最后一代里带 final 的（最新一代常是 done 后的空壳，final 为 null），没有就取最新一代。
const audits = new Map()
const auditsDir = join(simDir, 'runtime', 'lark-audits')
if (existsSync(auditsDir)) for (const project of readdirSync(auditsDir)) {
  const dir = join(auditsDir, project)
  for (const f of readdirSync(dir)) {
    const m = f.match(/^(.*)-e(\d+)\.json$/)
    if (!m) continue
    try {
      const a = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      const epoch = Number(m[2])
      const prev = audits.get(m[1])
      const better = !prev || (a.final && !prev.final) || (Boolean(a.final) === Boolean(prev.final) && epoch > prev.epoch)
      if (better) audits.set(m[1], { epoch, status: a.status || null, final: a.final || null })
    } catch { /* 坏文件跳过 */ }
  }
}

const outPath = join(simDir, 'judge.jsonl')
const done = new Set(readJsonl(outPath).map((r) => r.id))

// —— 取数 ——
const fmt = (ms) => new Date(ms).toISOString().slice(5, 16).replace('T', ' ')
const one = (t, n) => String(t || '').replace(/<at user_id="[^"]*">([^<]*)<\/at>/g, '@$1').replace(/\s+/g, ' ').slice(0, n)
const isTrigger = (m) => Boolean(m) && !m.ownBot && !m.deleted && m.senderType !== 'system'
  && (m.atBot || Boolean(m.parentId && byId.get(m.parentId)?.ownBot) || (m.chatKey === 'webhook-group' && m.isAven))
const isPrincipalDm = (m) => m.chatKey === 'webhook-group' && m.isAven
const contextOf = (m) => timeline
  .filter((x) => x.chatId === m.chatId && x.atMs < m.atMs && !x.deleted && x.text && x.senderType !== 'system')
  .slice(-CONTEXT_COUNT)
  .map((x) => `${x.senderName}${x.ownBot ? '（bot）' : ''}（${fmt(x.atMs)}）：${one(x.text, 300)}`)
  .join('\n')

const larkSideOf = (m) => {
  const task = tasks.get(m.id) || null
  const merged = mergedInto.get(m.id) || null
  const replies = outbox.filter((o) => o.kind === 'reply' && o.parentId === m.id)
  const dms = outbox.filter((o) => o.kind === 'send' && o.userId === AVEN_OPEN_ID && o.at >= m.atMs && o.at <= m.atMs + FOLLOW_MS)
  const cls = task?.intake?.classification || null
  const audit = audits.get(m.id) || null
  const decision = cls?.decision || (merged ? 'merged' : task ? '(未分类)' : 'ignore')
  // 负责人私信（webhook 群映射）没有群里回复可言，bot 的回应就是私信本身。
  const replied = replies.length > 0 || (isPrincipalDm(m) && dms.length > 0)
  return { task, merged, replies, dms, cls, audit, decision, replied }
}
const faliveSideOf = (m) => {
  const e = episodes.get(m.id) || null
  const b = e?.baseline || {}
  return {
    episode: e,
    classified: b.classified || null,
    decision: b.classified?.decision || 'ignore',
    botReplies: b.botReplies || [],
    humanFollowups: b.humanFollowups || [],
    ledger: b.ledger || null,
    audit: b.audit || null,
    routing: b.routing || [],
    replied: (b.botReplies || []).length > 0,
  }
}
const differs = (lark, falive) => lark.replied !== falive.replied || lark.decision !== falive.decision

const describeTask = (lark) => {
  if (lark.merged) return `并入了另一条消息的任务（${lark.merged.id}，终态 ${lark.merged.status}）`
  if (!lark.task) return '没建任务（分类前就忽略，或根本没触发）'
  const { task, cls } = lark
  const parts = [`分类 ${cls ? `${cls.decision}/${cls.confidence}${cls.deliverable ? `·${cls.deliverable}` : ''}` : '（无）'}`, `终态 ${task.status}`]
  if (cls?.reply) parts.push(`分类时的接话「${one(cls.reply, 200)}」`)
  if (cls?.continues) parts.push(`续接任务 ${cls.continues}`)
  if (task.result) parts.push(`结果：${one(task.result, 400)}`)
  else if (task.summary) parts.push(`摘要：${one(task.summary, 200)}`)
  return parts.join('；')
}

const schema = JSON.stringify({
  type: 'object',
  additionalProperties: false,
  required: ['better', 'reason', 'larkIssue', 'idealBehavior'],
  properties: {
    better: { type: 'string', enum: ['lark-bot', 'falive', 'same', 'both_wrong'] },
    reason: { type: 'string' },
    larkIssue: { type: 'string', enum: ['none', 'missed', 'noisy', 'wrong_target', 'wrong_content', 'duplicate', 'stuck'] },
    idealBehavior: { type: 'string' },
  },
})

const buildPrompt = (m, lark, falive) => {
  const principalDm = isPrincipalDm(m)
  return `你是 aven（falive 前端负责人）的代理机器人的评审。下面是一条飞书消息，当时的机器人（falive）和现在的机器人（lark-bot，离线回放同一条输入）各给了一套反应。
请结合消息原文、群里前文、以及事后信息（当时人接下来的反应、审计结论），判断哪一套更合适。
判断标准：以 aven 的利益为准——该做的没做是漏（更差），不该做的去做了是扰民 / 浪费（更差），接话像不像一个正常同事、对不对得上前文，给出的结论 / 答案对不对。两边都合理就 same；都不对就 both_wrong。
注意：lark-bot 是离线回放，外网环境是「现在」的，结论里若带了环境状态（如 503）不要据此扣分；评的是判断和接话，不是环境。
${principalDm ? '这条是 aven 本人在 falive 控制台群说的话，回放里映射成了 aven 给 lark-bot 的私信——lark-bot 的回应就是「私信 aven」那一栏，没有群里回复是正常的。\n' : ''}
【消息】${fmt(m.atMs)} ${principalDm ? '负责人私信' : `群「${m.chatName}」`} ${m.senderName}${m.isAven ? '（aven 本人，负责人）' : ''}${m.atBot ? ' @了机器人' : ''}${m.parentId && byId.get(m.parentId)?.ownBot ? ' 回复了机器人的消息' : ''}：
${String(m.text).slice(0, 1500)}
${m.parentId && byId.get(m.parentId) ? `【被回复的消息】${byId.get(m.parentId).senderName}${byId.get(m.parentId).ownBot ? '（bot）' : ''}：${one(byId.get(m.parentId).text, 400)}\n` : ''}
【群里这条之前的消息】
${contextOf(m) || '（无）'}

【A：falive 当时】
- 分类：${falive.classified ? `${falive.classified.decision}/${falive.classified.confidence || '-'}` : '（网关没分类）'}
- bot 当时的回复（2 小时内，同群）：${falive.botReplies.length ? falive.botReplies.slice(0, 4).map((r) => `（${fmt(r.atMs)}）${one(r.text, 500)}`).join('\n  ') : '（没有）'}
- 人接下来的反应（2 小时内）：${falive.humanFollowups.length ? falive.humanFollowups.slice(0, 4).map((r) => `（${fmt(r.atMs)}）${r.sender}：${one(r.text, 200)}`).join('\n  ') : '（没有）'}
- 台账：${falive.ledger ? one(`${falive.ledger.decision}；${falive.ledger.excerpt || ''}`, 300) : '（无）'}
- 审计结论：${falive.audit ? one(`${falive.audit.status} / ${falive.audit.workKind || ''}；${falive.audit.finalSummary || ''}`, 400) : '（无）'}
- 网关路由：${falive.routing.length ? one(falive.routing.slice(0, 6).join(' | '), 500) : '（无）'}

【B：lark-bot 这次模拟】
- 任务：${describeTask(lark)}
- 群里对这条的回复：${lark.replies.length ? lark.replies.slice(0, 4).map((r) => `（${fmt(r.at)}）${one(r.text, 600)}`).join('\n  ') : '（没有）'}
- 私信 aven（2 小时内，可能含别的任务的）：${lark.dms.length ? lark.dms.slice(0, 4).map((r) => `（${fmt(r.at)}）${one(r.text, 300)}`).join('\n  ') : '（没有）'}
- 审计结论：${lark.audit?.final ? one(`${lark.audit.final.status || lark.audit.status}；${lark.audit.final.summary || ''}`, 400) : lark.audit ? `${lark.audit.status}（没有 final）` : '（无）'}

只输出 JSON：
- better：lark-bot / falive / same / both_wrong
- reason：一句话，≤60 字
- larkIssue：lark-bot 这边的问题类型——none（没问题）/ missed（该接没接、该做没做）/ noisy（不该回却回了、不该做却做了、扰民）/ wrong_target（回错人 / 回错消息 / 该私信却发群）/ wrong_content（接话或结论内容不对）/ duplicate（重复回复 / 重复做）/ stuck（卡住没出结果：running / failed / 只回了「收到」）
- idealBehavior：理想的做法，≤40 字`
}

const callJudge = async (prompt) => {
  const child = spawn(join(dirname(fileURLToPath(import.meta.url)), 'claude-q'), ['-p', '--permission-mode', 'plan', '--tools', '', '--model', 'claude-opus-5-5', '--effort', 'high', '--strict-mcp-config', '--setting-sources', 'project', '--no-session-persistence', '--json-schema', schema, '--output-format', 'json', prompt], { cwd: replayRoot, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  child.stdout.on('data', (c) => { out += c })
  child.stderr.on('data', (c) => { err += c })
  const code = await new Promise((resolve) => child.on('close', resolve))
  if (code !== 0) throw new Error(`claude exit ${code}: ${err.slice(0, 200)}`)
  const envelope = JSON.parse(out)
  return envelope.structured_output ?? (typeof envelope.result === 'string' ? JSON.parse(envelope.result) : envelope.result)
}

// —— 待判队列 ——
// --score-from：分段并行时热身那天只为留状态、不计分（docs/falive-replay-plan-2026-11-03.md 39）
const scoreFromMs = value('--score-from', null) ? Date.parse(value('--score-from', null)) : 0
const triggered = fed.map((id) => byId.get(id)).filter(isTrigger).filter((m) => m.atMs >= scoreFromMs)
let queue = triggered
  .map((m) => ({ m, lark: larkSideOf(m), falive: faliveSideOf(m) }))
  .filter(({ m, lark, falive }) => !done.has(m.id) && (all || differs(lark, falive)))
if (limit) queue = queue.slice(0, limit)
console.log(`[judge-sim] sim=${simName} 喂了 ${fed.length} 条，触发 bot ${triggered.length} 条，待判 ${queue.length} 条（已判 ${done.size}${all ? '' : '，只判有差异的'}）`)

let index = 0
const worker = async () => {
  while (index < queue.length) {
    const { m, lark, falive } = queue[index++]
    try {
      const verdict = await callJudge(buildPrompt(m, lark, falive))
      const line = {
        id: m.id,
        sim: simName,
        at: new Date(m.atMs).toISOString(),
        chatKey: m.chatKey,
        sender: m.senderName,
        text: one(m.text, 120),
        ...verdict,
        falive: `${falive.decision}${falive.replied ? '，回了' : '，没回'}`,
        larkBot: `${lark.decision}${lark.task ? `/${lark.task.status}` : ''}${lark.replied ? '，回了' : '，没回'}`,
      }
      appendFileSync(outPath, `${JSON.stringify(line)}\n`)
      console.log(`[judge-sim] ${m.id} ${verdict.better} / ${verdict.larkIssue}：${verdict.reason}`)
    } catch (error) {
      console.error(`[judge-sim] ${m.id} 失败：${String(error.message).slice(0, 200)}`)
    }
  }
}
await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker))

const allRows = readJsonl(outPath)
const count = (key) => allRows.reduce((acc, r) => ({ ...acc, [r[key]]: (acc[r[key]] || 0) + 1 }), {})
console.log(`[judge-sim] 汇总（${allRows.length} 条）：better=${JSON.stringify(count('better'))} larkIssue=${JSON.stringify(count('larkIssue'))}`)
