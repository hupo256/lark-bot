#!/usr/bin/env node
/**
 * fameex 线 L1 对照（11-03）：falive 回放得出的改动（候选版 lark-bot-fix4）在 fameex 线自己的真实消息上会不会让分类 / 接话变坏。
 * 样本 = 运行目录的任务（runtime/lark-tasks，带上下文包）+ 审计里去重后剩下的 + 回归集 / 1101 回放集里 fameex 的条目（按消息 id 去重）。
 * 每条用两份代码各自的 buildIntentClassificationPrompt + classifyTaskIntent 真跑分类器、各自 applyIntakeClassification 落地，各跑 --rounds 次；
 * 两版落地签名（decision·deliverable·selfAnswer → 落地）不同的交给 claude 裁判（--judge-all 时一致的也判，主要看 reply）。
 *   node scripts/sim/fameex-l1.mjs [--run name] [--rounds 2] [--conc 8] [--only id,id] [--limit n] [--judge-all] [--no-judge] [--list]
 * 只读两个仓库；不碰飞书；结果写 /tmp/fameex-l1/<run>/（results.jsonl / judge.jsonl 可续跑）。
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const runName = value('--run', 'l1')
const rounds = Number(value('--rounds', 2))
const concurrency = Number(value('--conc', 8))
const limit = Number(value('--limit', 0))
const only = value('--only', '') ? new Set(value('--only', '').split(',')) : null

const RUNNING_ROOT = value('--running', join(homedir(), 'github', 'lark-bot'))
const CANDIDATE_ROOT = value('--candidate', join(homedir(), 'github', 'lark-bot-fix4'))
const RUNTIME = join(RUNNING_ROOT, 'runtime')
const outDir = join('/tmp', 'fameex-l1', runName)
mkdirSync(join(outDir, 'empty-outbox'), { recursive: true })
mkdirSync(join(outDir, 'empty-obligations'), { recursive: true })

// 运行目录指主仓 runtime（persona 在那）；发件簿 / 义务指空目录，免得读到现网的「正在进行的事」。须在 import lib 之前设。
process.env.LARK_RUNTIME_DIR = RUNTIME
process.env.LARK_OUTBOX_DIR = join(outDir, 'empty-outbox')
process.env.LARK_OBLIGATIONS_DIR = join(outDir, 'empty-obligations')

const loadVersion = async (root) => ({
  root,
  ...(await import(join(root, 'lib', 'lark-worker-run.mjs'))),
  ...(await import(join(root, 'lib', 'lark-intake-resolve.mjs'))),
  ...(await import(join(root, 'lib', 'lark-intake-replay.mjs'))),
  resolveMergeTarget: (await import(join(root, 'lib', 'lark-routes-intake.mjs'))).resolveMergeTarget,
})
const versions = { running: await loadVersion(RUNNING_ROOT), candidate: await loadVersion(CANDIDATE_ROOT) }

const localConfig = JSON.parse(readFileSync(join(RUNTIME, 'lark-bot.local.json'), 'utf8')) // worker 用的同一份运行配置
const PRINCIPAL = localConfig.notifyOpenId
const workerConfig = { projectId: localConfig.project || 'PR-01947', projectName: localConfig.title || 'FameEX Web', aiExecutor: localConfig.aiExecutor || 'claude', localConfig }
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

// ---------- 样本 ----------
const storedTasks = new Map(readdirSync(join(RUNTIME, 'lark-tasks')).filter((f) => f.endsWith('.json')).map((f) => readJson(join(RUNTIME, 'lark-tasks', f))).map((t) => [t.id, t]))
const audits = new Map() // messageId → [{ epoch, ...audit }]
for (const project of readdirSync(join(RUNTIME, 'lark-audits'))) {
  for (const f of readdirSync(join(RUNTIME, 'lark-audits', project)).filter((name) => /-e\d+\.json$/.test(name))) {
    const audit = readJson(join(RUNTIME, 'lark-audits', project, f))
    const id = audit.task?.messageId || audit.taskId
    if (!audits.has(id)) audits.set(id, [])
    audits.get(id).push({ epoch: Number(f.match(/-e(\d+)\.json$/)[1]), project, ...audit })
  }
}
for (const list of audits.values()) list.sort((a, b) => a.epoch - b.epoch)
const fixtureCases = [
  ...readJson(join(CANDIDATE_ROOT, '__tests__', 'fixtures', 'intake-regression-1102.json')).cases.filter((c) => /^fameex/.test(c.set || '')),
  ...readJson(join(RUNNING_ROOT, '__tests__', 'fixtures', 'intake-replay-1101.json')).cases.filter((c) => !c.ops && c.expected?.classified !== false).map((c) => ({ ...c, set: 'replay-1101' })),
]
const fixtureById = new Map(fixtureCases.map((c) => [c.id, c]))
const isDmChat = (chatId) => /^ou_/.test(chatId || '') || chatId === 'oc_a0ce203fdecb90ae817fcc83b88d34eb' // aven 私信

const fromStored = (t) => ({
  id: t.id, source: 'lark', chatId: t.chatId, chatType: t.chatType, messageId: t.messageId, replyTarget: t.replyTarget || null, threadRootId: t.threadRootId || null,
  operator: t.operator, project: t.project, commandType: null, commandTypeSource: null, chatName: t.chatName || null,
  text: t.text, summary: t.summary, attachments: (t.attachments || []).filter((a) => !a.localPath || existsSync(a.localPath)),
  threadSpeakers: t.threadSpeakers, conversation: t.conversation || null, addressedToBot: t.addressedToBot, fromPrincipal: t.fromPrincipal,
  quotedOwnCard: t.quotedOwnCard, privateOrigin: t.privateOrigin || null, aiExecutor: 'claude', status: 'received',
  intake: { required: true, trigger: t.intake?.trigger, receivedAt: t.intake?.receivedAt, anchorTaskId: t.intake?.anchorTaskId || null }, createdAt: t.createdAt,
})
const fromFixture = (c, regressionTaskOf) => {
  const base = regressionTaskOf(c, { principalOpenId: PRINCIPAL })
  return {
    ...base, chatId: c.trigger === 'dm' ? 'oc_a0ce203fdecb90ae817fcc83b88d34eb' : 'oc_da69155c32afd9b0b3efe679e638ce5e', messageId: c.id, project: workerConfig.projectId,
    fromPrincipal: Boolean(c.fromPrincipal), privateOrigin: c.privateOrigin ? { anchorHead: '', senderOpenId: PRINCIPAL } : null,
    attachments: base.attachments.filter((a) => !a.localPath || existsSync(a.localPath)), status: 'received', aiExecutor: 'claude',
  }
}
const fromAudit = (a) => {
  const dm = isDmChat(a.task.chatId)
  return {
    id: a.task.messageId, source: 'lark', chatId: a.task.chatId, chatType: dm ? 'p2p' : 'group', messageId: a.task.messageId, operator: PRINCIPAL, project: a.project,
    text: a.task.text, summary: a.task.summary, attachments: [], conversation: null, addressedToBot: true, fromPrincipal: true, status: 'received', aiExecutor: 'claude',
    intake: { required: true, trigger: dm ? 'dm' : 'bot_mention' },
  }
}

// 当时（运行版前身）实际怎么判、后来怎么样——给裁判当事后信息。
const historyOf = (id) => {
  const t = storedTasks.get(id)
  const list = audits.get(id) || []
  const cls = t?.intake?.classification || list.find((a) => a.intake)?.intake || null
  const final = [...list].reverse().find((a) => a.gateway?.result)?.gateway
  return {
    classified: cls ? { decision: cls.decision, confidence: cls.confidence, deliverable: cls.deliverable, selfAnswer: cls.selfAnswer, reply: cls.reply, continues: cls.continues } : null,
    status: t?.status || list.at(-1)?.status || null,
    result: String(t?.result || final?.result || '').replace(/\s+/g, ' ').slice(0, 300) || null,
  }
}

const samples = []
const seen = new Set()
const add = (id, kind, build) => {
  if (seen.has(id) || (only && !only.has(id))) return
  seen.add(id)
  samples.push({ id, kind, build, expected: fixtureById.get(id)?.expected || null, history: historyOf(id) })
}
for (const t of storedTasks.values()) {
  if (t.source !== 'lark' || !t.intake?.trigger) continue // 日报 / bug 表 / 系统任务不过分类
  const e0 = audits.get(t.id)?.find((a) => a.epoch === 0)
  const fx = fixtureById.get(t.id)
  // 任务被续跑并过补充（text 比分类那一刻长）：用回归集里分类那一刻的版本。
  if (e0 && e0.task.text !== t.text && fx) add(t.id, `task→fixture(${fx.set})`, (v) => fromFixture(fx, v.regressionTaskOf))
  else add(t.id, 'task', () => fromStored(t))
}
for (const c of fixtureCases) add(c.id, `fixture(${c.set})`, (v) => fromFixture(c, v.regressionTaskOf))
for (const [id, list] of audits) {
  const a = list[0]
  if (a.task?.source !== 'lark' || !a.task?.messageId) continue // system / bug 表 / 运维验证（不过分类）跳过
  add(id, 'audit', () => fromAudit(a))
}
if (limit) samples.splice(limit)

if (flag('--list')) {
  for (const s of samples) console.log(`${s.id} [${s.kind}] ${String(s.build(versions.running).text).split('\n')[0].slice(0, 70)}`)
  console.log(`共 ${samples.length} 条`)
  process.exit(0)
}

// ---------- 真跑分类 ----------
const outcomeOf = (o) => (o.selfAnswer ? 'selfAnswer' : o.actionable ? 'actionable' : o.askBack ? 'askBack' : o.suspected ? 'suspected' : o.recordOnly ? 'recordOnly' : 'ignored')
const fakeStore = { get: (id) => storedTasks.get(id) || null }
const lookup = (id) => storedTasks.get(id) || null
const resultsPath = join(outDir, 'results.jsonl')
const readLines = (path) => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [])
const keyOf = (r) => `${r.id}|${r.version}|${r.round}`
const done = new Map(readLines(resultsPath).filter((r) => !r.error).map((r) => [keyOf(r), r]))
const jobs = samples.flatMap((s) => Object.keys(versions).flatMap((version) => Array.from({ length: rounds }, (_, i) => ({ s, version, round: i + 1 }))))
  .filter((job) => !done.has(`${job.s.id}|${job.version}|${job.round}`))
console.log(`[fameex-l1] run=${runName} 样本 ${samples.length} 条，待跑 ${jobs.length} 次分类（已完成 ${done.size}）intent=${localConfig.claudeIntentModel || localConfig.claudeModel}/${localConfig.claudeIntentEffort || localConfig.claudeEffort}`)

const runJob = async ({ s, version, round }) => {
  const v = versions[version]
  const task = s.build(v)
  const t0 = Date.now()
  try {
    const classification = await v.classifyTaskIntent(workerConfig, task, null, undefined)
    const applied = structuredClone(task)
    const flags = v.applyIntakeClassification(applied, { classification, lookup })
    let mergeInto = null
    try { mergeInto = flags.actionable ? v.resolveMergeTarget({ task: applied, store: fakeStore })?.id || null : null } catch { mergeInto = null }
    const row = {
      id: s.id, version, round, ms: Date.now() - t0, classification, outcome: outcomeOf(flags), mergeInto,
      sentReply: applied.intake.classification?.replyDropped ? '（reply 被换成固定「收到」句）' : classification.reply || null,
      contract: applied.contract?.deliverable || null, priorConclusion: Boolean(applied.priorConclusion),
    }
    appendFileSync(resultsPath, `${JSON.stringify(row)}\n`)
    done.set(keyOf(row), row)
    console.log(`[fameex-l1] ${s.id} ${version}#${round} ${classification.decision}/${classification.confidence}·${classification.deliverable ?? '-'} → ${row.outcome}（${Math.round(row.ms / 1000)}s）`)
  } catch (error) {
    appendFileSync(resultsPath, `${JSON.stringify({ id: s.id, version, round, error: String(error?.message || error).slice(0, 400) })}\n`)
    console.error(`[fameex-l1] ${s.id} ${version}#${round} 失败：${String(error?.message || error).slice(0, 200)}`)
  }
}
const pool = async (items, fn, conc) => {
  let index = 0
  await Promise.all(Array.from({ length: Math.max(1, conc) }, async () => {
    while (index < items.length) await fn(items[index++])
  }))
}
await pool(jobs, runJob, concurrency)

// ---------- 对照 ----------
const sig = (r) => (r ? `${r.classification.decision}·${r.classification.deliverable ?? '-'}${r.classification.selfAnswer ? '·self' : ''}→${r.outcome}` : 'ERR')
const rowsOf = (id, version) => Array.from({ length: rounds }, (_, i) => done.get(`${id}|${version}|${i + 1}`) || null)
const compared = samples.map((s) => {
  const running = rowsOf(s.id, 'running')
  const candidate = rowsOf(s.id, 'candidate')
  const a = running.map(sig).sort().join(' | ')
  const b = candidate.map(sig).sort().join(' | ')
  return { s, running, candidate, same: a === b, stable: { running: new Set(running.map(sig)).size === 1, candidate: new Set(candidate.map(sig)).size === 1 } }
})

// ---------- 裁判 ----------
const judgePath = join(outDir, 'judge.jsonl')
const judged = new Map(readLines(judgePath).map((r) => [r.id, r]))
const OUTCOME_HELP = 'actionable=建任务去做（reply 当「收到」先发）；selfAnswer=分类器一句答完（reply 就是答案）；askBack=把 reply 当追问发给 aven、挂起；suspected=私信 aven 确认再做；recordOnly=回「记下了」；ignored=不处理（@bot 的回一句 reply）'
const describeRows = (rows) => rows.map((r, i) => (r
  ? `  第${i + 1}次：${r.classification.decision}/${r.classification.confidence}·交付 ${r.classification.deliverable ?? 'null'}${r.classification.selfAnswer ? '·selfAnswer' : ''}·continues=${r.classification.continues ?? 'null'} → 落地 ${r.outcome}${r.mergeInto ? `（并入 ${r.mergeInto}）` : ''}；发出的话「${r.sentReply ?? '（无）'}」`
  : `  第${i + 1}次：（失败）`)).join('\n')
const judgeSchema = JSON.stringify({
  type: 'object',
  additionalProperties: false,
  required: ['better', 'reason', 'runningReply', 'candidateReply', 'idealDecision'],
  properties: {
    better: { type: 'string', enum: ['candidate', 'running', 'same', 'both_wrong'] },
    reason: { type: 'string' },
    runningReply: { type: 'string', enum: ['good', 'awkward', 'wrong', 'none'] },
    candidateReply: { type: 'string', enum: ['good', 'awkward', 'wrong', 'none'] },
    idealDecision: { type: 'string' },
  },
})
const judgeOne = async (c) => {
  const task = c.s.build(versions.running)
  const h = c.s.history
  const prompt = `你是 aven（fameex-web 前端负责人）的代理机器人的评审。下面是一条飞书消息（含机器人拼好的上下文包），机器人要决定：这条是什么（bug / requirement / api_reply / question / ignore）、交付什么、要不要动手、怎么接话。
两版代码各真跑了 ${rounds} 次分类器。请判哪一版更合适。
判断标准：以 aven 的利益为准——该做的没做是漏（更差），不该做的去做了是扰民 / 浪费（更差）；接话是否像正常人说话、对得上前文、不乱承诺。不稳定（两次结果不同）本身也算缺点。两边都合理就 same；都不对就 both_wrong。
落地含义：${OUTCOME_HELP}

【消息】${task.chatType === 'p2p' ? '私信' : '群聊'}，发送人：${task.fromPrincipal ? 'aven 本人（负责人）' : (task.operator ? '同事' : '未知')}${task.privateOrigin ? '，是 aven 私聊里对一条群消息的指示' : ''}
<<<
${String(task.text).slice(0, 3500)}
>>>
附件：${(task.attachments || []).map((a) => `${a.type}${a.fileName ? `「${a.fileName}」` : ''}`).join('、') || '无'}

【运行版（现网）】
${describeRows(c.running)}
【候选版】
${describeRows(c.candidate)}

【事后信息】
- 当时现网分类：${h.classified ? `${h.classified.decision}/${h.classified.confidence}·${h.classified.deliverable ?? 'null'}${h.classified.selfAnswer ? '·selfAnswer' : ''}；回复「${h.classified.reply ?? ''}」` : '（未记录）'}
- 后来结果：${h.status || '（无）'}${h.result ? `；${h.result}` : ''}
- 回归集人工标注的可接受值：${c.s.expected ? JSON.stringify(c.s.expected) : '（无）'}

只输出 JSON：better（candidate / running / same / both_wrong）、reason（一句话，≤60 字）、runningReply / candidateReply（各自发出的那句话：good / awkward / wrong / none）、idealDecision（你认为理想的分类 + 落地，≤30 字）。`
  const child = spawn('claude', ['-p', '--permission-mode', 'plan', '--tools', '', '--model', 'claude-opus-5-5', '--effort', 'high', '--strict-mcp-config', '--setting-sources', 'project', '--no-session-persistence', '--json-schema', judgeSchema, '--output-format', 'json', prompt], { cwd: outDir, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  child.stdout.on('data', (chunk) => { out += chunk })
  child.stderr.on('data', (chunk) => { err += chunk })
  const code = await new Promise((resolve) => child.on('close', resolve))
  if (code !== 0) throw new Error(`claude exit ${code}: ${err.slice(0, 200)}`)
  const envelope = JSON.parse(out)
  return envelope.structured_output ?? (typeof envelope.result === 'string' ? JSON.parse(envelope.result) : envelope.result)
}
if (!flag('--no-judge')) {
  const toJudge = compared.filter((c) => (flag('--judge-all') || !c.same) && !judged.has(c.s.id) && c.running.every(Boolean) && c.candidate.every(Boolean))
  console.log(`[fameex-l1] 裁判 ${toJudge.length} 条（已判 ${judged.size}）`)
  await pool(toJudge, async (c) => {
    try {
      const verdict = await judgeOne(c)
      const line = { id: c.s.id, same: c.same, ...verdict }
      appendFileSync(judgePath, `${JSON.stringify(line)}\n`)
      judged.set(c.s.id, line)
      console.log(`[judge] ${c.s.id} ${verdict.better}：${verdict.reason}`)
    } catch (error) {
      console.error(`[judge] ${c.s.id} 失败：${String(error?.message || error).slice(0, 200)}`)
    }
  }, 4)
}

// ---------- 汇总 ----------
const head = (s) => String(s.build(versions.running).text).replace(/【[^】]*】\s*/g, '').replace(/<at[^>]*><\/at>\s*/g, '@bot ').split('\n').find((line) => line.trim())?.slice(0, 50) || ''
console.log('\n==== 逐条（运行版 ‖ 候选版；每版 ' + rounds + ' 次）====')
for (const c of compared) {
  const j = judged.get(c.s.id)
  console.log(`${c.same ? '  ' : '≠ '}${c.s.id} [${c.s.kind}] ${head(c.s)}`)
  console.log(`    运行版：${c.running.map(sig).join(' ; ')}${c.stable.running ? '' : '（不稳）'}  回：${c.running.map((r) => `「${r?.sentReply ?? ''}」`).join(' ')}`)
  console.log(`    候选版：${c.candidate.map(sig).join(' ; ')}${c.stable.candidate ? '' : '（不稳）'}  回：${c.candidate.map((r) => `「${r?.sentReply ?? ''}」`).join(' ')}`)
  if (j) console.log(`    裁判：${j.better}（回复 运行 ${j.runningReply} / 候选 ${j.candidateReply}）${j.reason}；理想：${j.idealDecision}`)
}
const diff = compared.filter((c) => !c.same)
const tally = (list) => list.reduce((acc, c) => {
  const b = judged.get(c.s.id)?.better || '未判'
  return { ...acc, [b]: (acc[b] || 0) + 1 }
}, {})
const label = { candidate: '候选更好', running: '运行版更好', same: '一样', both_wrong: '都不对', 未判: '未判' }
const show = (t) => Object.entries(t).map(([k, n]) => `${label[k] || k} ${n}`).join('，') || '无'
console.log('\n==== 汇总 ====')
console.log(`样本 ${compared.length} 条（每版 ${rounds} 次）；两版落地一致 ${compared.length - diff.length}，不同 ${diff.length}`)
console.log(`稳定性：运行版 ${compared.filter((c) => c.stable.running).length}/${compared.length}，候选版 ${compared.filter((c) => c.stable.candidate).length}/${compared.length}`)
console.log(`不同条目裁判：${show(tally(diff))}`)
if (flag('--judge-all')) console.log(`一致条目裁判（主要比 reply）：${show(tally(compared.filter((c) => c.same)))}`)
const worse = compared.filter((c) => judged.get(c.s.id)?.better === 'running')
console.log(`\n运行版更好的条目（${worse.length}）：`)
for (const c of worse) console.log(`- ${c.s.id}${c.same ? '（落地一致）' : ''} ${head(c.s)}\n    运行版 ${c.running.map(sig).join(' ; ')} ‖ 候选版 ${c.candidate.map(sig).join(' ; ')}\n    理由：${judged.get(c.s.id).reason}`)
console.log(`\n明细：${resultsPath}；裁判：${judgePath}`)
