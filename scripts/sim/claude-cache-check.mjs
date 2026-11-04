#!/usr/bin/env node
/**
 * claude 调用录放（scripts/sim/claude-cache.mjs）的核对工具（docs/falive-replay-design-v2.md §4、§8 P0-f）。
 *
 *   node scripts/sim/claude-cache-check.mjs                 判定表 + 离线测试（不调模型，默认）
 *   node scripts/sim/claude-cache-check.mjs --only-table    只跑判定表
 *   node scripts/sim/claude-cache-check.mjs --live [--id om_…]  真调两次同一条分类（1 次真调用）：第一次 miss 落盘、第二次 hit、输出逐字节相同
 *   node scripts/sim/claude-cache-check.mjs --sim-a <dir> --sim-b <dir> [--min-hit 0.9] [--json]
 *       同一组跑两遍（A 冷跑录、B 带录放）后核对：B 的只读调用命中率（≥ 0.9 过）、B 每条 miss 跟 A 对应调用比哪一分项变了
 *       （flags / prompt / files / cwd / repo / session / rules，prompt 变了给第一处不同的行）、两遍的群回复（outbox.jsonl）与任务终态是否一致。
 *
 * 离线测试（零模型调用）：
 *   1. 同 5 条 case 在两套运行上下文（不同 SIM_DIR / 端口 / lark-bot 版本 / bot 回话时刻 / 假 lark-cli 发号 / 业务仓提交时间 / 临时结果目录）下，
 *      用 lib 的真实拼装函数（buildConversationBundle → classifyTaskIntent / buildAnalysisPrompt / buildTaskPromptParts → execAiExecutor，
 *      spawn 换成只记 argv 的桩）拼出 intent / analysis / task-ro / task-rw / resume-rw 五类 argv，核规范化后键相同、不规范化时键不同；
 *   2. 语义变了键必须变：消息原文、bot 那句的正文、人的消息时刻、模型 / 强度、附件内容、预取文档（simdoc）内容、业务仓工作区内容；
 *   3. 端到端：假 claude（不调模型）当下游，A 上下文依次跑 intent → analysis → resume-rw（续 analysis 的会话、改工作区）→ task-ro 全部 miss 落盘，
 *      B 上下文同样四步全部 hit、假 claude 一次没被调、改动打回 B 的工作区且内容树与 A 调用后一致、结果文件写到 B 的路径、会话续得上；
 *      失败 / is_error / 撞限额不落盘；下游接额度闸 claude-q 时不套娃。
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const codeRoot = join(here, '..', '..')
const args = process.argv.slice(2)
const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const sha = (data) => createHash('sha256').update(data).digest('hex')
const readJsonl = (path) => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } }) : [])
let failed = 0
const check = (label, ok, detail = '') => {
  if (!ok) failed += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `：${detail}` : ''}`)
}

// ———————————————————————————— 子进程：在一套运行上下文里用 lib 拼 argv（--emit <spec.json>） ————————————————————————————
// lib 的路径常量（运行目录、附件目录、--add-dir）在加载时按 env 定死，所以每套上下文单独起一个进程。
if (args[0] === '--emit') {
  const spec = JSON.parse(readFileSync(args[1], 'utf8'))
  const { BOT_APP_ID, BOT_MENTION_IDS, datasetDir, resolveRaw, toListItem, toSimEvent } = await import('./falive-data.mjs')
  const { parseFetchedMessage, pickRecentContext, pickThreadContext } = await import('../../lib/lark-chat-context.mjs')
  const { buildConversationBundle } = await import('../../lib/lark-conversation-bundle.mjs')
  const { normalizeMessage, resolveMessageTrigger, summarize } = await import('../../lib/lark-message.mjs')
  const { classifyTaskIntent } = await import('../../lib/lark-worker-run.mjs')
  const { execAiExecutor } = await import('../../lib/lark-ai-executor.mjs')
  const { buildAnalysisPrompt, buildTaskPrompt, buildTaskPromptParts, buildWorkerSystemPrompt } = await import('../../lib/lark-worker-prompts.mjs')
  const { buildFocusedRuleContext } = await import('../../lib/lark-rule-context.mjs')
  const timeline = JSON.parse(readFileSync(join(datasetDir, 'timeline.json'), 'utf8'))
  const byId = new Map(timeline.map((m) => [m.id, m]))
  const BOT_OPEN_ID = 'ou_e331d79d4491e64b7bba89bb4e3b5e43'
  const botIds = [BOT_OPEN_ID, BOT_APP_ID, ...BOT_MENTION_IDS]
  const localConfig = { project: 'FALIVE', aiExecutor: 'claude', botOpenId: BOT_OPEN_ID, botAppId: BOT_APP_ID, allowedChatIds: 'auto', allowedOpenIds: ['ou_91861d6da6cf6822e08045ba1868241e'], claudeModel: spec.model, claudeEffort: spec.effort, claudeIntentModel: spec.model, claudeIntentEffort: spec.intentEffort, repoLabel: 'falive-react（Falive Web 前端仓）' }
  const workerConfig = { projectId: 'FALIVE', projectName: 'Falive Web', aiExecutor: 'claude', localConfig }
  const pad = (n) => String(n).padStart(5, '0')
  const shift = (time, min) => {
    if (!min) return time
    const m = /^(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(time || '')
    if (!m) return time
    const t = new Date(2026, Number(m[1]) - 1, Number(m[2]), Number(m[3]), Number(m[4]) + min)
    return `${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
  }
  const deps = (mut) => ({
    fetchReferencedContext: async (messageId) => {
      const ref = byId.get(messageId)
      if (!ref) return null
      return { ...parseFetchedMessage(ref.msgType, ref.text), sender: ref.senderName, senderOpenId: ref.senderType === 'app' ? BOT_APP_ID : ref.senderId, createTime: String(ref.atMs) }
    },
    fetchThreadContext: async (anchorId, { excludeIds = [], limit = 40 } = {}) => {
      const anchor = byId.get(anchorId)
      if (!anchor?.threadId) return []
      return pickThreadContext(timeline.filter((m) => m.chatId === anchor.chatId && m.threadId === anchor.threadId && !m.deleted).map(toListItem), { excludeIds, botOpenIds: botIds, limit })
    },
    fetchRecentChatContext: async ({ chatId, beforeMs, excludeIds = [], limit = 20 }) => {
      const items = timeline.filter((m) => m.chatId === chatId && m.atMs < beforeMs && !m.deleted).slice(-200).map(toListItem)
      const picked = pickRecentContext(items, { beforeMs, excludeIds, botOpenIds: botIds, limit })
      // 本组里 bot 自己刚说的一句（模拟器里 bot 回话的时刻 = 收到 + 耗时，两遍跑不同；文档号 / 消息号是假 lark-cli 全局发号，并发下两遍不同）。
      const last = picked.at(-1)
      const botLine = {
        sender: 'Aven.Bot（bot，我们自己）', time: shift(last?.time || '10-21 10:00', 1 + spec.botShiftMin), bot: true, attachments: [],
        text: `${mut === 'bot-text' ? '好的，我改一下再发你。' : '好的，我查一下马上回你。'} 完整内容：https://sim.local/docx/simdoc${pad(spec.simdocN)}（接 om_sim${pad(spec.omsimN)}）`,
      }
      const out = picked.map((item) => (item.bot && /我们自己/.test(item.sender || '') ? { ...item, time: shift(item.time, spec.botShiftMin) } : item))
      if (mut === 'human-time') {
        const i = out.findIndex((item) => !item.bot && item.time)
        if (i >= 0) out[i] = { ...out[i], time: shift(out[i].time, 7) }
        else noop.add(mut) // 上下文里没有人的消息：这个变体对本 case 是空操作
      }
      return [...out, botLine]
    },
    downloadAttachments: async ({ messageId, attachments }) => {
      const src = byId.get(messageId)
      return attachments.map((a, i) => {
        const key = a.type === 'file' ? a.fileKey : a.imageKey
        const from = resolveRaw((src?.resources || []).find((r) => r.key === key && r.localPath)?.localPath)
        if (!from || !existsSync(from)) return { ...a, downloadError: '存档里没有这份附件' }
        // 同 worker：附件复制进运行目录（SIM_DIR/runtime/lark-attachments/<项目>/<消息>/），路径随运行变、内容不变。
        const dir = join(spec.simDir, 'runtime', 'lark-attachments', 'FALIVE', messageId)
        mkdirSync(dir, { recursive: true })
        const to = join(dir, `${i + 1}-${basename(from)}`)
        if (!existsSync(to)) copyFileSync(from, to)
        return { ...a, localPath: to }
      })
    },
  })
  const noop = new Set()
  const emptyStore = { list: () => [], listRecentForChat: () => [], findTaskByAnyReceipt: () => null, findByReceiptMessageId: () => null, has: () => false }
  const buildTask = async (m, mut) => {
    const msg = normalizeMessage(toSimEvent(mut === 'text' ? { ...m, text: `${m.text || ''} 另外顺便看下首页` } : m, { botOpenId: BOT_OPEN_ID }))
    const replyTarget = m.parentId ? byId.get(m.parentId) : null
    const trigger = resolveMessageTrigger({ msg, config: localConfig, isBotReceiptReply: Boolean(replyTarget?.ownBot) })
    const bundle = await buildConversationBundle({ msg, config: localConfig, store: emptyStore, project: 'FALIVE', deps: deps(mut) })
    const receivedAt = new Date(m.atMs).toISOString()
    return {
      id: msg.messageId, source: 'lark', chatId: msg.chatId, chatType: msg.chatType || 'group', messageId: msg.messageId, threadRootId: msg.threadRootId || msg.replyTo || null,
      operator: msg.senderOpenId, project: 'FALIVE', chatName: m.chatName, text: bundle.text, summary: summarize(msg.text?.trim() ? msg.text : bundle.refText || ''),
      attachments: bundle.attachments, conversation: bundle.conversation, addressedToBot: true, quotedOwnCard: bundle.quotedOwnCard, status: 'received',
      intake: { required: true, trigger: trigger === 'bot_reply' ? 'bot_reply' : msg.chatType === 'p2p' ? 'dm' : 'bot_mention', receivedAt }, createdAt: receivedAt,
      classification: { decision: 'requirement', confidence: 'high', reason: '负责人明确交办', deliverable: 'code' },
    }
  }
  // spawn 桩：只记 argv，起一个立即失败的 sh（execAiExecutor 照常走完自己的流程：mkdtemp 结果目录、拼结果文件指令）。
  const captured = []
  const capture = (tag) => (cmd, argv, options) => {
    if (!captured.some((c) => c.tag === tag)) captured.push({ tag, argv, cwd: options.cwd })
    return spawn('/bin/sh', ['-c', 'exit 3'], { ...options, stdio: 'ignore' })
  }
  const quiet = async (fn) => {
    const { warn, log, error } = console
    console.warn = () => {}
    console.log = () => {}
    console.error = () => {}
    try {
      await fn()
    } catch {
      // 桩子进程失败，预期
    } finally {
      Object.assign(console, { warn, log, error })
    }
  }
  const out = []
  for (const c of spec.cases) {
    const m = byId.get(c.id)
    const wt = join(spec.simDir, 'repos', '.lark-hotfix', `hotfix-adhoc-${c.id.slice(-8)}`)
    const mainRepo = join(spec.simDir, 'repos', 'falive-react')
    for (const mut of [null, 'text', 'bot-text', 'human-time', 'model']) {
      noop.clear()
      const task = await buildTask(m, mut)
      if (mut && noop.has(mut)) continue
      const lc = mut === 'model' ? { ...localConfig, claudeModel: 'claude-sonnet-5', claudeIntentModel: 'claude-sonnet-5', claudeIntentEffort: 'high' } : localConfig
      const wc = { ...workerConfig, localConfig: lc }
      const ruleContext = buildFocusedRuleContext({ taskText: task.text, hasImage: task.attachments.some((a) => a.type === 'image'), ruleRevisions: { aiRulesRevision: '62ea344', larkBotRevision: spec.larkBotRev } })
      const tag = (call) => `${c.id}|${call}|${mut || 'base'}`
      await quiet(() => classifyTaskIntent(wc, task, null, undefined, { exec: (o) => execAiExecutor({ ...o, spawnImpl: capture(tag('intent')) }) }))
      if (mut && mut !== 'model' && mut !== 'text') continue // 正文类变体只核 intent + 实施，够说明问题
      const exec = (call, o) => quiet(() => execAiExecutor({ executor: 'claude', localConfig: lc, attachments: task.attachments, ...o, spawnImpl: capture(tag(call)) }))
      await exec('analysis', { promptText: buildAnalysisPrompt({ projectId: 'FALIVE', projectName: 'Falive Web', cwd: wt }, task, ruleContext), cwd: wt, resultKind: 'analysis', systemPromptText: buildWorkerSystemPrompt({}) })
      await exec('task-ro', { promptText: buildTaskPrompt({ projectId: 'FALIVE', projectName: 'Falive Web', projectDocs: [], cwd: mainRepo }, { ...task, classification: { ...task.classification, decision: 'question', deliverable: 'answer' } }, 'claude', { ruleContext }), cwd: mainRepo, resultKind: 'task', readOnly: true })
      const parts = buildTaskPromptParts({ projectId: 'FALIVE', projectName: 'Falive Web', projectDocs: [], cwd: wt, hotfixBranch: `hotfix/adhoc-${c.id.slice(-8)}` }, task, 'claude', { ruleContext, analysis: { status: 'ready', summary: '改 src/a.ts 的文案', applicableRules: [{ source: 'AGENT.md', application: '不造假数据' }], requirements: ['只改 src/a.ts'], scope: { files: ['src/a.ts'] } } })
      await exec('task-rw', { promptText: parts.user, systemPromptText: parts.system, cwd: wt, resultKind: 'task', readOnly: false })
      await exec('resume-rw', { promptText: parts.user, systemPromptText: parts.system, cwd: wt, resultKind: 'task', readOnly: false, resumeSessionId: spec.sessionId })
    }
  }
  for (const c of captured) {
    const [caseId, call, variant] = c.tag.split('|')
    out.push({ caseId, call, variant, argv: c.argv, cwd: c.cwd })
  }
  writeFileSync(args[2], JSON.stringify(out))
  process.exit(0)
}

const cache = await import('./claude-cache.mjs')
const { classifyClaudeArgv, computeCacheKey, createNormalizer, repoState, encodeProjectDir, READONLY_KINDS, WRITE_KINDS } = cache

// ———————————————————————————— 1. 判定表 ————————————————————————————
const runTable = async () => {
  const { buildAiExecutorCommand, buildClaudeReadinessCommand } = await import('../../lib/lark-ai-executor.mjs')
  const base = { executor: 'claude', promptText: '任务正文\n\n结果文件路径：/tmp/lark-claude-result-AbC123/result.json\n', cwd: tmpdir(), resultPath: '/tmp/lark-claude-result-AbC123/result.json', model: 'claude-opus-5-5', reasoningEffort: 'high', settingSources: 'project', extraReadOnlyCommands: [`node ${join(codeRoot, 'tools', 'read-bug-record.mjs')}`, `node ${join(codeRoot, 'tools', 'env-version.mjs')}`] }
  const cases = [
    ['intent', { ...base, promptText: '分类', resultKind: 'intent', readOnly: true }, true, 'intent'],
    ['triage', { ...base, promptText: '分诊', resultKind: 'triage' }, true, 'triage'],
    ['analysis', { ...base, promptText: '分析', resultKind: 'analysis', systemPromptText: '驾驶规则' }, true, 'analysis'],
    ['只读任务（代答 / 实测）', { ...base, resultKind: 'task', readOnly: true }, true, 'task-ro'],
    ['可写任务（改码实施，要业务仓状态一致）', { ...base, resultKind: 'task', readOnly: false, systemPromptText: '驾驶规则' }, true, 'task-rw'],
    ['续会话实施', { ...base, resultKind: 'task', readOnly: false, resumeSessionId: 'abc-123' }, true, 'resume-rw'],
    ['只读任务续会话（补写结果 / 群回复）', { ...base, resultKind: 'task', readOnly: true, resumeSessionId: 'abc-123' }, true, 'resume-ro'],
    ['带页面工具的只读任务', { ...base, resultKind: 'task', readOnly: true, extraReadOnlyCommands: [...base.extraReadOnlyCommands, 'node /x/tools/verify-page.mjs'] }, false, 'task-page'],
  ]
  for (const [label, options, expectCache, expectKind] of cases) {
    const { args: argv } = buildAiExecutorCommand(options)
    const verdict = classifyClaudeArgv(argv)
    check(`判定 ${label} → ${verdict.cacheable ? 'cache' : 'bypass'}（${verdict.kind}；${verdict.reason}）`, verdict.cacheable === expectCache && verdict.kind === expectKind)
  }
  check('判定 --version → bypass', !classifyClaudeArgv(['--version']).cacheable)
  check('判定 --fork-session → bypass', !classifyClaudeArgv(['-p', '--resume', 'x', '--fork-session', '--dangerously-skip-permissions', '--output-format', 'stream-json', 'p']).cacheable)
  check('判定 就绪探针（text 输出）→ bypass', !classifyClaudeArgv(buildClaudeReadinessCommand({ model: 'm', effort: 'low' }).args).cacheable)
}

// ———————————————————————————— 2. 离线测试 ————————————————————————————
const sh = (cmd, cwd, env = {}) => {
  const r = spawnSync('/bin/sh', ['-c', cmd], { cwd, env: { ...process.env, ...env }, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`${cmd}：${r.stderr}`)
  return r.stdout.trim()
}
// 假 claude（不调模型）：按 argv 吐 lark-bot 认的结果；任务模式写结果文件；可写调用改工作区；不带 --no-session-persistence 就落会话文件。
// FAKE_FAIL=is_error / limit 演练失败；每次被调往 FAKE_COUNT 文件追加一行。
const FAKE_CLAUDE = `#!/usr/bin/env node
const { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync, existsSync } = require('node:fs')
const { createHash, randomUUID } = require('node:crypto')
const { dirname, join } = require('node:path')
const argv = process.argv.slice(2)
const prompt = argv.at(-1)
appendFileSync(process.env.FAKE_COUNT, argv.includes('--resume') ? 'resume\\n' : 'call\\n')
if (process.env.FAKE_FAIL === 'limit') { process.stdout.write('{"type":"result","subtype":"success","is_error":true,"result":"You\\'ve hit your session limit · resets 6:40pm"}\\n'); process.exit(1) }
const resumeAt = argv.indexOf('--resume')
const sid = resumeAt >= 0 ? argv[resumeAt + 1] : randomUUID()
const cwd = realpathSync(process.cwd())
const h = createHash('sha256').update(prompt).digest('hex').slice(0, 8)
const result = /结果文件路径：(\\S+)/.exec(prompt)?.[1]
if (result) { mkdirSync(dirname(result), { recursive: true }); writeFileSync(result, JSON.stringify({ status: 'done', summary: 'fake ' + h, checks: [], changedFiles: [], warnings: [] })) }
if (argv.includes('--dangerously-skip-permissions')) {
  appendFileSync(join(cwd, 'README.md'), 'fake change ' + h + ' in ' + cwd + '\\n')
  mkdirSync(join(cwd, 'src'), { recursive: true })
  writeFileSync(join(cwd, 'src', 'new-' + h + '.ts'), 'export const x = "' + h + '"\\n')
}
if (!argv.includes('--no-session-persistence')) {
  const dir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(dir, { recursive: true })
  appendFileSync(join(dir, sid + '.jsonl'), JSON.stringify({ type: 'user', cwd, sessionId: sid, message: { content: prompt.slice(0, 200) } }) + '\\n')
}
const isError = process.env.FAKE_FAIL === 'is_error'
const ev = { type: 'result', subtype: 'success', is_error: isError, session_id: sid, result: 'ok ' + h, ...(argv.includes('--json-schema') ? { structured_output: { decision: 'ignore', confidence: 'high', reason: 'fake ' + h } } : {}) }
if (argv[argv.indexOf('--output-format') + 1] === 'stream-json') process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', cwd, session_id: sid }) + '\\n' + JSON.stringify(ev) + '\\n')
else process.stdout.write(JSON.stringify(ev))
`

const runOffline = async () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'claude-cache-check-')))
  const claudeHome = join(scratch, 'claude-home')
  mkdirSync(join(claudeHome, 'projects'), { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = claudeHome // 会话文件、自动加载规则都看这里，不碰 ~/.claude
  const { datasetDir, casesDir } = await import('./falive-data.mjs')
  const timeline = JSON.parse(readFileSync(join(datasetDir, 'timeline.json'), 'utf8'))
  const byId = new Map(timeline.map((m) => [m.id, m]))
  const caseIds = readFileSync(join(casesDir, 'cases.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).id).filter((id) => byId.has(id))
  const ms = caseIds.map((id) => byId.get(id))
  const hasImg = (m) => (m.resources || []).some((r) => r.localPath && r.type === 'image')
  const isReply = (m) => m.parentId && byId.get(m.parentId)?.ownBot
  const picked = [...new Set([...ms.filter(hasImg).slice(0, 2), ...ms.filter((m) => isReply(m) && !hasImg(m)).slice(0, 2), ms.find((m) => m.chatType === 'p2p') || ms[10]].map((m) => m.id))].slice(0, 5)
  console.log(`\n—— 离线测试：5 条 case ${picked.join(' ')} ——`)

  // 两套运行上下文：凡是「同一份语义输入、两次运行写法不同」的都让它不同
  const SESSION_ID = '11111111-2222-4333-8444-555555555555'
  const ctxs = [
    { name: 'A', simDir: join(scratch, 'sim', 'r20-ep07'), port: 31801, larkBotRev: '33d9201', botShiftMin: 0, simdocN: 3, omsimN: 5, commitDate: '2026-11-01T10:00:00+04:00' },
    { name: 'B', simDir: join(scratch, 'sim', 'r21-ep07-cached'), port: 31977, larkBotRev: '3211d02', botShiftMin: 3, simdocN: 11, omsimN: 17, commitDate: '2026-11-04T18:30:00+04:00' },
  ]
  const DOC = '# 前端未处理事项清单\n\n- 只看预约：等 Ache 加参数\n- 分享卡片图：等定方案\n'
  for (const ctx of ctxs) {
    mkdirSync(join(ctx.simDir, 'runtime'), { recursive: true })
    mkdirSync(join(ctx.simDir, 'docs'), { recursive: true })
    writeFileSync(join(ctx.simDir, 'docs', `simdoc${String(ctx.simdocN).padStart(5, '0')}.md`), DOC)
    writeFileSync(join(ctx.simDir, 'sent.json'), JSON.stringify([{ message_id: `om_sim${String(ctx.omsimN).padStart(5, '0')}`, chat_id: 'oc_x', content: '收到，我先看下。' }]))
    // 业务仓：内容相同、提交时间不同（sha 不同）
    const repo = join(ctx.simDir, 'repos', 'falive-react')
    mkdirSync(join(repo, 'src'), { recursive: true })
    writeFileSync(join(repo, 'README.md'), '# falive-react\n')
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const title = "直播预告"\n')
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n')
    const gitEnv = { GIT_AUTHOR_NAME: 'sim', GIT_AUTHOR_EMAIL: 'sim@x', GIT_COMMITTER_NAME: 'sim', GIT_COMMITTER_EMAIL: 'sim@x', GIT_AUTHOR_DATE: ctx.commitDate, GIT_COMMITTER_DATE: ctx.commitDate }
    sh('git init -q -b main && git add -A && git commit -qm base', repo, gitEnv)
    ctx.head = sh('git rev-parse HEAD', repo)
    for (const id of picked) {
      const wt = join(ctx.simDir, 'repos', '.lark-hotfix', `hotfix-adhoc-${id.slice(-8)}`)
      sh(`git worktree add -q -b hotfix/adhoc-${id.slice(-8)} "${wt}" HEAD`, repo)
      // 被续的会话文件：内容相同、里面的路径是各自的运行目录（命中回放时就是这样）
      const pdir = join(claudeHome, 'projects', encodeProjectDir(realpathSync(wt)))
      mkdirSync(pdir, { recursive: true })
      writeFileSync(join(pdir, `${SESSION_ID}.jsonl`), `${JSON.stringify({ type: 'user', cwd: realpathSync(wt), message: { content: '分析 ……' } })}\n`)
    }
    const spec = { ...ctx, cases: picked.map((id) => ({ id })), sessionId: SESSION_ID, model: 'claude-opus-5-5', effort: 'high', intentEffort: 'low' }
    const specPath = join(scratch, `spec-${ctx.name}.json`)
    const outPath = join(scratch, `argv-${ctx.name}.json`)
    writeFileSync(specPath, JSON.stringify(spec))
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--emit', specPath, outPath], {
      encoding: 'utf8',
      env: { ...process.env, SIM_DIR: ctx.simDir, LARK_RUNTIME_DIR: join(ctx.simDir, 'runtime'), LARK_GATEWAY_PORT: String(ctx.port), LARK_OUTBOX_DIR: join(ctx.simDir, 'outbox'), LARK_OBLIGATIONS_DIR: join(ctx.simDir, 'obligations'), LARK_BOT_CONSUMER_ROOT: repo },
    })
    if (r.status !== 0) throw new Error(`拼 argv 失败（${ctx.name}）：${r.stderr.slice(-800)}`)
    ctx.entries = JSON.parse(readFileSync(outPath, 'utf8'))
  }

  const keyOf = (ctx, entry) => {
    const verdict = classifyClaudeArgv(entry.argv)
    const normalizer = createNormalizer({ simDir: ctx.simDir, port: ctx.port, larkBotRoot: codeRoot })
    for (const a of entry.argv) normalizer.collect(a)
    const repo = verdict.kind === 'intent' ? null : repoState(entry.cwd)?.key || null
    let session = null
    if (verdict.resumeId) {
      const file = join(claudeHome, 'projects', encodeProjectDir(realpathSync(entry.cwd)), `${verdict.resumeId}.jsonl`)
      session = { id: verdict.resumeId, content: sha(normalizer.normalize(readFileSync(file, 'utf8'))) }
    }
    const k = computeCacheKey({ argv: entry.argv, cwd: entry.cwd, kind: verdict.kind, normalizer, simDir: ctx.simDir, repo, session })
    return { ...k, verdict, placeholders: normalizer.pairs.map((p) => p.placeholder) }
  }
  const [A, B] = ctxs
  const find = (ctx, caseId, call, variant = 'base') => ctx.entries.find((e) => e.caseId === caseId && e.call === call && e.variant === variant)
  const CALLS = ['intent', 'analysis', 'task-ro', 'task-rw', 'resume-rw']
  const EXPECT_KIND = { intent: 'intent', analysis: 'analysis', 'task-ro': 'task-ro', 'task-rw': 'task-rw', 'resume-rw': 'resume-rw' }

  // 2.1 同一语义输入：两套上下文规范化后键相同；不规范化（原始 argv 直接 hash）键不同
  console.log('\n[2.1] 两套运行上下文，同 case 同调用：规范化后键必须相同')
  const firedRules = new Set()
  for (const call of CALLS) {
    let same = 0
    let rawDiff = 0
    const misses = []
    for (const id of picked) {
      const ea = find(A, id, call)
      const eb = find(B, id, call)
      if (!ea || !eb) { misses.push(`${id.slice(-8)} 没拼出来`); continue }
      const ka = keyOf(A, ea)
      const kb = keyOf(B, eb)
      if (ka.verdict.kind !== EXPECT_KIND[call] || !ka.verdict.cacheable) misses.push(`${id.slice(-8)} 判成 ${ka.verdict.kind}（${ka.verdict.reason}）`)
      if (ka.key === kb.key) same += 1
      else misses.push(`${id.slice(-8)} 分项不同：${Object.keys(ka.parts).filter((p) => ka.parts[p] !== kb.parts[p]).join(',')}`)
      if (sha(JSON.stringify(ea.argv)) !== sha(JSON.stringify(eb.argv))) rawDiff += 1
      for (const p of [...ka.placeholders, ...kb.placeholders]) firedRules.add(p.replace(/:[0-9a-f]+(#\d+)?>>/, '>>').replace(/\d+>>/, 'n>>'))
      for (const [re, rule] of [[/<<BOT_TIME>>/, '<<BOT_TIME>>(R7)'], [/<<RULES_FP>>/, '<<RULES_FP>>(R6)'], [/@<<REV>>/, '@<<REV>>(R6)']]) if (re.test(ka.material.argv.join('\n'))) firedRules.add(rule)
    }
    check(`${call}：${same}/${picked.length} 键相同（原始 argv ${rawDiff}/${picked.length} 不同）`, same === picked.length && rawDiff === picked.length && !misses.length, misses.join('；'))
  }
  console.log(`  生效的规范化：${[...firedRules].sort().join(' ')}`)

  // 2.2 语义变了键必须变
  console.log('\n[2.2] 语义输入变了：键必须不同')
  const baseKeys = new Map(B.entries.filter((e) => e.variant === 'base').map((e) => [`${e.caseId}|${e.call}`, keyOf(B, e).key]))
  for (const [variant, calls, label] of [['text', ['intent', 'task-rw'], '消息原文多一句'], ['bot-text', ['intent'], 'bot 上一句的正文'], ['human-time', ['intent'], '人的消息时刻'], ['model', ['intent', 'analysis', 'task-rw'], '模型 / 强度']]) {
    for (const call of calls) {
      const changed = picked.filter((id) => { const e = find(B, id, call, variant); return e && keyOf(B, e).key !== baseKeys.get(`${id}|${call}`) }).length
      const built = picked.filter((id) => find(B, id, call, variant)).length
      check(`${label} → ${call}：${changed}/${built} 键变了`, built > 0 && changed === built, built < picked.length ? `另 ${picked.length - built} 条 case 的上下文里没有可改的（空操作，不算）` : '')
    }
  }
  // 文件类：改了内容、路径不变
  const recompute = (call) => picked.map((id) => [id, keyOf(B, find(B, id, call)).key])
  const attRoot = join(B.simDir, 'runtime', 'lark-attachments', 'FALIVE')
  const attIds = existsSync(attRoot) ? picked.filter((id) => readdirSync(attRoot).includes(id)) : []
  check(`有附件的 case ≥ 1（${attIds.length}）`, attIds.length > 0)
  for (const id of attIds) {
    const dir = join(B.simDir, 'runtime', 'lark-attachments', 'FALIVE', id)
    const f = join(dir, readdirSync(dir)[0])
    const orig = readFileSync(f)
    writeFileSync(f, Buffer.concat([orig, Buffer.from('x')]))
    const changed = keyOf(B, find(B, id, 'intent')).key !== baseKeys.get(`${id}|intent`)
    writeFileSync(f, orig)
    check(`附件内容改 1 字节（路径不变）→ intent 键变了（${id.slice(-8)}）`, changed)
  }
  const docPath = join(B.simDir, 'docs', `simdoc${String(B.simdocN).padStart(5, '0')}.md`)
  writeFileSync(docPath, `${DOC}- 新加一条\n`)
  const docChanged = recompute('intent').filter(([id, k]) => k !== baseKeys.get(`${id}|intent`)).length
  writeFileSync(docPath, DOC)
  check(`bot 引用的 simdoc 内容变了（号不变）→ intent ${docChanged}/${picked.length} 键变了`, docChanged === picked.length)
  for (const id of picked.slice(0, 2)) {
    const wt = find(B, id, 'task-rw').cwd
    const f = join(wt, 'src', 'a.ts')
    const orig = readFileSync(f, 'utf8')
    writeFileSync(f, orig.replace('直播预告', '直播预告页'))
    const rwChanged = ['analysis', 'task-rw', 'resume-rw'].filter((call) => keyOf(B, find(B, id, call)).key !== baseKeys.get(`${id}|${call}`))
    const intentSame = keyOf(B, find(B, id, 'intent')).key === baseKeys.get(`${id}|intent`)
    writeFileSync(join(wt, 'tmp-untracked.txt'), 'x')
    const untrackedChanged = keyOf(B, find(B, id, 'task-rw')).key !== baseKeys.get(`${id}|task-rw`)
    rmSync(join(wt, 'tmp-untracked.txt'))
    writeFileSync(f, orig)
    check(`工作区改一行 → analysis / task-rw / resume-rw 键都变了、intent 不变；新增未跟踪文件也变（${id.slice(-8)}）`, rwChanged.length === 3 && intentSame && untrackedChanged, `变了：${rwChanged.join(',')}`)
  }
  {
    const e = find(B, picked[0], 'resume-rw')
    const file = join(claudeHome, 'projects', encodeProjectDir(realpathSync(e.cwd)), `${SESSION_ID}.jsonl`)
    const orig = readFileSync(file, 'utf8')
    appendFileSync(file, `${JSON.stringify({ type: 'assistant', message: { content: '多了一轮' } })}\n`)
    const changed = keyOf(B, e).key !== baseKeys.get(`${picked[0]}|resume-rw`)
    writeFileSync(file, orig)
    check('被续的会话文件多了一轮 → resume-rw 键变了', changed)
  }

  // 2.3 端到端：真跑包装壳，下游是假 claude
  console.log('\n[2.3] 端到端（包装壳 + 假 claude，不调模型）')
  const fake = join(scratch, 'fake-claude')
  writeFileSync(fake, FAKE_CLAUDE, { mode: 0o755 })
  const counter = join(scratch, 'fake-count')
  const cacheDir = join(scratch, 'cache')
  const wrap = (ctx, argv, cwd, extra = {}) => {
    const r = spawnSync(join(here, 'claude'), argv, {
      cwd, encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, SIM_DIR: ctx.simDir, LARK_GATEWAY_PORT: String(ctx.port), SIM_AI_CACHE_DIR: cacheDir, SIM_REAL_CLAUDE: fake, FAKE_COUNT: counter, CLAUDE_CONFIG_DIR: claudeHome, FALIVE_REPLAY_DIR: scratch, ...extra },
    })
    return r
  }
  const calls = () => (existsSync(counter) ? readFileSync(counter, 'utf8').split('\n').filter(Boolean).length : 0)
  const logOf = (ctx) => readJsonl(join(ctx.simDir, 'ai-cache-calls.jsonl'))
  const id0 = picked[0]
  const flow = (ctx) => {
    const out = {}
    const ia = find(ctx, id0, 'intent')
    out.intent = wrap(ctx, ia.argv, ia.cwd)
    const an = find(ctx, id0, 'analysis')
    out.analysis = wrap(ctx, an.argv, an.cwd)
    const sid = [...out.analysis.stdout.matchAll(/"session_id":"([^"]+)"/g)].at(-1)?.[1]
    const rw = find(ctx, id0, 'resume-rw')
    const rwArgv = rw.argv.map((a) => (a === SESSION_ID ? sid : a))
    out.sid = sid
    out.rw = wrap(ctx, rwArgv, rw.cwd)
    out.rwResult = /结果文件路径：(\S+)/.exec(rwArgv.at(-1))?.[1]
    const ro = find(ctx, id0, 'task-ro')
    out.ro = wrap(ctx, ro.argv, ro.cwd)
    out.wt = rw.cwd
    return out
  }
  const before = calls()
  const fa = flow(A)
  const aCalls = calls() - before
  const aLog = logOf(A)
  check('A（冷跑）：intent / analysis / resume-rw / task-ro 全部 miss 且落盘', aLog.length === 4 && aLog.every((r) => r.outcome === 'miss' && r.stored), aLog.map((r) => `${r.kind}:${r.outcome}${r.stored ? '' : `(${r.note})`}`).join(' '))
  check('A：假 claude 被调 4 次', aCalls === 4, String(aCalls))
  const aPost = repoState(fa.wt).key.wtTree
  check('A：resume-rw 改了工作区', aPost !== repoState(find(B, id0, 'resume-rw').cwd).key.wtTree)
  const mid = calls()
  const fb = flow(B)
  const bLog = logOf(B)
  check('B（带录放）：四步全部 hit', bLog.length === 4 && bLog.every((r) => r.outcome === 'hit'), bLog.map((r) => `${r.kind}:${r.outcome}${r.note ? `(${r.note})` : ''}`).join(' '))
  check('B：假 claude 一次没被调', calls() === mid, String(calls() - mid))
  check('B：analysis 回放的会话 id 与 A 相同（续会话的 argv 因此相同）', fb.sid && fb.sid === fa.sid, fb.sid)
  check('B：改动打回 B 的工作区，内容树与 A 调用后一致', repoState(fb.wt).key.wtTree === aPost)
  const bReadme = readFileSync(join(fb.wt, 'README.md'), 'utf8')
  check('B：回放的是 A 的原改动（字面回放，文件里写了 A 的路径也原样）', bReadme.includes(realpathSync(fa.wt)))
  check('B：结果文件写到 B 的路径', fb.rwResult && fb.rwResult !== fa.rwResult && existsSync(fb.rwResult), fb.rwResult)
  const bSession = join(claudeHome, 'projects', encodeProjectDir(realpathSync(fb.wt)), `${fb.sid}.jsonl`)
  check('B：会话文件写进 B 的项目目录、里面的路径换成了 B 的', existsSync(bSession) && readFileSync(bSession, 'utf8').includes(realpathSync(fb.wt)) && !readFileSync(bSession, 'utf8').includes(realpathSync(fa.wt)))
  check('B：stdout 与 A 只差运行目录（规范化后逐字相同）', ['intent', 'analysis', 'rw', 'ro'].every((k) => fa[k].stdout.split(realpathSync(A.simDir)).join('<S>') === fb[k].stdout.split(realpathSync(B.simDir)).join('<S>')))
  check('B 再跑一遍 resume-rw（工作区已是调用后状态）→ 不命中（业务仓状态不同）', (() => {
    const rw = find(B, id0, 'resume-rw')
    wrap(B, rw.argv.map((a) => (a === SESSION_ID ? fb.sid : a)), rw.cwd)
    return logOf(B).at(-1).outcome === 'miss'
  })())

  // 失败不落盘
  const C = { simDir: join(scratch, 'sim', 'fail'), port: 1 }
  mkdirSync(C.simDir, { recursive: true })
  const ia1 = find(A, picked[1], 'intent')
  for (const mode of ['is_error', 'limit']) {
    wrap(C, ia1.argv, ia1.cwd, { FAKE_FAIL: mode })
    const last = logOf(C).at(-1)
    check(`下游 ${mode} → 不落盘`, last?.outcome === 'miss' && last.stored === false, last?.note)
  }
  wrap(C, ia1.argv, ia1.cwd)
  check('失败之后同一调用再来 → 仍是 miss（没把失败录下来）、这次成功才落盘', logOf(C).at(-1)?.outcome === 'miss' && logOf(C).at(-1)?.stored === true)

  // 下游接额度闸：claude-q 自己也读 SIM_REAL_CLAUDE，包装壳得把它换成真二进制，不然套娃
  const D = { simDir: join(scratch, 'sim', 'quota'), port: 2 }
  mkdirSync(D.simDir, { recursive: true })
  const q0 = calls()
  const rq = wrap(D, find(A, picked[2], 'intent').argv, codeRoot, { SIM_REAL_CLAUDE: join(here, 'claude-q'), SIM_TRUE_CLAUDE: fake, SIM_AI_CACHE_DIR: join(scratch, 'cache-q') })
  check('下游 = 额度闸 claude-q → 经闸调到真 claude（假的）一次、正常落盘、不套娃', rq.status === 0 && calls() - q0 === 1 && logOf(D).at(-1)?.stored === true, `退出 ${rq.status}${rq.error ? ` ${rq.error.message}` : ''}`)

  // 一条真实 prompt 规范化前后（给人看）
  const sample = keyOf(B, find(B, picked[2], 'task-rw')).material.argv.at(-1)
  const lines = sample.split('\n').filter((l) => /<<|任务 ID/.test(l)).slice(0, 8)
  console.log(`\n  task-rw 规范化后的 prompt 里带占位符的行（${picked[2].slice(-8)}，节选）：\n${lines.map((l) => `    ${l.slice(0, 150)}`).join('\n')}`)
  if (!args.includes('--keep')) rmSync(scratch, { recursive: true, force: true })
  else console.log(`  现场留在 ${scratch}`)
}

// ———————————————————————————— 3. 真调两次（--live，1 次真调用） ————————————————————————————
const runLive = async () => {
  if (!process.env.LARK_RUNTIME_DIR) process.env.LARK_RUNTIME_DIR = join(homedir(), 'github', 'lark-bot', 'runtime')
  const scratch = mkdtempSync(join(tmpdir(), 'claude-cache-live-'))
  process.env.SIM_AI_CACHE_DIR = join(scratch, 'cache')
  process.env.SIM_DIR = join(scratch, 'sim')
  process.env.LARK_CLAUDE_BIN = join(here, 'claude')
  const { classifyTaskIntent } = await import('../../lib/lark-worker-run.mjs')
  const { execAiExecutor } = await import('../../lib/lark-ai-executor.mjs')
  const { datasetDir, resolveRaw } = await import('./falive-data.mjs')
  const timeline = JSON.parse(readFileSync(join(datasetDir, 'timeline.json'), 'utf8'))
  const wanted = value('--id', null)
  const m = wanted ? timeline.find((x) => x.id === wanted) : timeline.find((x) => x.atBot && !x.ownBot && x.text && (x.resources || []).some((r) => r.localPath && r.type === 'image'))
  if (!m) throw new Error('时间线里没找到带截图的 @bot 消息')
  const attachments = (m.resources || []).filter((r) => r.localPath).map((r) => ({ type: r.type === 'image' ? 'image' : 'file', imageKey: r.key, localPath: resolveRaw(r.localPath) }))
  const task = {
    id: m.id, source: 'lark', chatId: m.chatId, chatType: 'group', messageId: m.id, operator: m.senderId, project: 'FALIVE', chatName: m.chatName,
    text: m.text, summary: String(m.text).slice(0, 60), attachments, addressedToBot: true, status: 'received',
    intake: { required: true, trigger: 'bot_mention', receivedAt: new Date(m.atMs).toISOString() }, createdAt: new Date(m.atMs).toISOString(),
  }
  const localConfig = { project: 'FALIVE', aiExecutor: 'claude', claudeModel: 'claude-opus-5-5', claudeEffort: 'medium', claudeIntentModel: 'claude-opus-5-5', claudeIntentEffort: 'low', repoLabel: 'falive-react（Falive Web 前端仓）' }
  const workerConfig = { projectId: 'FALIVE', projectName: 'Falive Web', aiExecutor: 'claude', localConfig }
  const runOnce = async () => {
    const chunks = []
    const spawnImpl = (cmd, argv, options) => {
      const child = spawn(cmd, argv, options)
      child.stdout?.on('data', (chunk) => chunks.push(chunk))
      return child
    }
    const started = Date.now()
    const result = await classifyTaskIntent(workerConfig, task, null, undefined, { exec: (options) => execAiExecutor({ ...options, spawnImpl }) })
    return { result, stdout: Buffer.concat(chunks), ms: Date.now() - started }
  }
  console.log(`真调：${m.id}（${attachments.length} 个附件）${String(m.text).replace(/\s+/g, ' ').slice(0, 60)}`)
  const first = await runOnce()
  const second = await runOnce()
  const log = readFileSync(join(process.env.SIM_DIR, 'ai-cache.log'), 'utf8').trim().split('\n')
  console.log(log.map((line) => `  ai-cache.log | ${line}`).join('\n'))
  check('第一次 miss（真调并落盘）', /^\S+ miss intent \S+ \d+ms 已落盘/.test(log[0] || ''), `${first.ms}ms`)
  check('第二次 hit', /^\S+ hit intent /.test(log[1] || ''), `${second.ms}ms`)
  check('两次 stdout 逐字节相同', first.stdout.length > 0 && first.stdout.equals(second.stdout), `${first.stdout.length} / ${second.stdout.length} 字节`)
  check('两次分类结果相同', JSON.stringify(first.result) === JSON.stringify(second.result), `${first.result.decision}/${first.result.confidence}`)
  check('第二次 < 1 秒', second.ms < 1000, `${second.ms}ms`)
  rmSync(scratch, { recursive: true, force: true })
}

// ———————————————————————————— 4. 两遍 sim 核对（--sim-a / --sim-b） ————————————————————————————
// ai-cache-calls.jsonl 没有（旧版包装）就退回解析 ai-cache.log。
const loadCalls = (dir) => {
  const rows = readJsonl(join(dir, 'ai-cache-calls.jsonl'))
  if (rows.length) return rows
  const log = join(dir, 'ai-cache.log')
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => {
    const [at, outcome, kind, key, , ...rest] = line.split(' ')
    return { at, outcome, kind, key: key === '-' ? null : key, note: rest.join(' '), stored: /已落盘/.test(line) }
  }).filter((r) => ['hit', 'miss', 'bypass'].includes(r.outcome))
}
// 假 lark-cli 的号换成内容（同 claude-cache R5），运行目录换成占位符：两遍的发件逐条比正文。
const outputNormalizer = (dir) => {
  const sent = (() => { try { return JSON.parse(readFileSync(join(dir, 'sent.json'), 'utf8')) } catch { return [] } })()
  const byId = new Map(sent.map((m) => [m.message_id, m]))
  const real = (() => { try { return realpathSync(dir) } catch { return dir } })()
  return (text) => String(text ?? '')
    .split(real).join('<SIM>').split(dir).join('<SIM>')
    .replace(/simdoc\d{5,}/g, (id) => { const p = join(dir, 'docs', `${id}.md`); return existsSync(p) ? `<doc:${sha(readFileSync(p)).slice(0, 10)}>` : id })
    .replace(/om_sim\d{5,}/g, (id) => { const m = byId.get(id); return m ? `<msg:${sha(`${m.chat_id}\0${m.content}`).slice(0, 10)}>` : id })
}
const loadOutbox = (dir) => {
  const norm = outputNormalizer(dir)
  return readJsonl(join(dir, 'outbox.jsonl')).sort((a, b) => (a.at ?? 0) - (b.at ?? 0)).map((o) => ({ kind: o.kind, chatId: o.chatId || o.userId, parent: norm(o.parentId), text: norm(o.text) }))
}
const loadTasks = (dir) => {
  const tasksDir = [join(dir, 'runtime', 'lark-tasks'), join(dir, 'tasks')].find((d) => existsSync(d))
  const out = new Map()
  if (!tasksDir) return out
  for (const f of readdirSync(tasksDir).filter((x) => x.endsWith('.json'))) {
    try {
      const t = JSON.parse(readFileSync(join(tasksDir, f), 'utf8'))
      if (t?.id) out.set(t.id, { status: t.status, decision: t.classification?.decision ?? t.intake?.decision ?? null, mergedInto: t.mergedInto ?? null })
    } catch {
      // 坏文件跳过
    }
  }
  return out
}
const firstDiffLine = (a, b) => {
  const la = a.split('\n')
  const lb = b.split('\n')
  for (let i = 0; i < Math.max(la.length, lb.length); i += 1) if (la[i] !== lb[i]) return `第 ${i + 1} 行：A「${(la[i] ?? '（无）').slice(0, 120)}」 B「${(lb[i] ?? '（无）').slice(0, 120)}」`
  return '逐行相同'
}
const runCompare = (dirA, dirB) => {
  const minHit = Number(value('--min-hit', 0.9))
  const callsA = loadCalls(dirA)
  const callsB = loadCalls(dirB)
  const summary = (rows) => {
    const byKind = {}
    for (const r of rows) {
      byKind[r.kind] ??= { hit: 0, miss: 0, bypass: 0 }
      if (r.outcome in byKind[r.kind]) byKind[r.kind][r.outcome] += 1
    }
    return byKind
  }
  const sumOver = (byKind, kinds) => Object.entries(byKind).filter(([k]) => kinds.has(k)).reduce((acc, [, c]) => ({ hit: acc.hit + c.hit, miss: acc.miss + c.miss }), { hit: 0, miss: 0 })
  const sB = summary(callsB)
  const ro = sumOver(sB, READONLY_KINDS)
  const rw = sumOver(sB, WRITE_KINDS)
  const roRate = ro.hit + ro.miss ? ro.hit / (ro.hit + ro.miss) : 0
  console.log(`A：${callsA.length} 次调用；B：${callsB.length} 次调用`)
  console.log(`B 按类 hit/miss/bypass：${Object.entries(sB).map(([k, c]) => `${k} ${c.hit}/${c.miss}/${c.bypass}`).join('，') || '无'}`)
  check(`B 只读调用命中率 ${(roRate * 100).toFixed(1)}%（${ro.hit}/${ro.hit + ro.miss}，门槛 ${minHit * 100}%）`, ro.hit + ro.miss > 0 && roRate >= minHit)
  console.log(`B 可写调用命中 ${rw.hit}/${rw.hit + rw.miss}（参考，不设门槛：上游任何一次 miss 都会让业务仓状态分叉）`)
  const bypassReasons = {}
  for (const r of callsB.filter((x) => x.outcome === 'bypass')) bypassReasons[`${r.kind}：${String(r.note || '').slice(0, 50)}`] = (bypassReasons[`${r.kind}：${String(r.note || '').slice(0, 50)}`] || 0) + 1
  if (Object.keys(bypassReasons).length) console.log(`B 直通原因：\n${Object.entries(bypassReasons).map(([k, n]) => `  ${n} × ${k}`).join('\n')}`)

  // B 的每条 miss：在 A 里按（类、任务、第几次）找对应调用，比分项
  const seq = (rows) => {
    const n = new Map()
    return rows.filter((r) => r.outcome !== 'bypass').map((r) => {
      const k = `${r.kind}|${r.taskId || '-'}`
      n.set(k, (n.get(k) || 0) + 1)
      return { ...r, slot: `${k}|${n.get(k)}` }
    })
  }
  const aBySlot = new Map(seq(callsA).map((r) => [r.slot, r]))
  const missesB = seq(callsB).filter((r) => r.outcome === 'miss')
  if (missesB.length) console.log(`B 的 miss（${missesB.length} 条）：`)
  for (const r of missesB.slice(0, 40)) {
    const a = aBySlot.get(r.slot)
    let why = 'A 里没有对应调用（A 没走到这一步，或任务 id 认不出）'
    if (a && a.key === r.key) why = `A 里同键${a.stored === false ? '但 A 那次没落盘' : ''}（${a.note || ''}）`
    else if (a?.parts && r.parts) {
      const diff = Object.keys(r.parts).filter((p) => r.parts[p] !== a.parts[p])
      why = `分项不同：${diff.join(',') || '（全同？版本号 v 变了）'}`
      if (diff.includes('prompt') && a.key && r.key) {
        const pa = join(dirA, 'ai-cache-prompts', `${a.key.slice(0, 12)}.txt`)
        const pb = join(dirB, 'ai-cache-prompts', `${r.key.slice(0, 12)}.txt`)
        if (existsSync(pa) && existsSync(pb)) why += `；prompt ${firstDiffLine(readFileSync(pa, 'utf8'), readFileSync(pb, 'utf8'))}`
      }
    }
    console.log(`  ${r.kind} ${r.taskId || '-'}：${why}`)
  }

  // 输出一致：群回复（发件簿逐条）、任务终态
  const oa = loadOutbox(dirA)
  const ob = loadOutbox(dirB)
  let firstDiff = -1
  for (let i = 0; i < Math.max(oa.length, ob.length); i += 1) if (JSON.stringify(oa[i]) !== JSON.stringify(ob[i])) { firstDiff = i; break }
  check(`群回复一致（A ${oa.length} 条 / B ${ob.length} 条）`, firstDiff < 0, firstDiff < 0 ? '' : `第 ${firstDiff + 1} 条起不同：A「${String(oa[firstDiff]?.text ?? '（无）').slice(0, 80)}」 B「${String(ob[firstDiff]?.text ?? '（无）').slice(0, 80)}」`)
  const ta = loadTasks(dirA)
  const tb = loadTasks(dirB)
  const ids = [...new Set([...ta.keys(), ...tb.keys()])]
  const tDiff = ids.filter((id) => JSON.stringify(ta.get(id) || null) !== JSON.stringify(tb.get(id) || null))
  check(`任务终态一致（${ids.length} 个任务）`, tDiff.length === 0, tDiff.slice(0, 8).map((id) => `${id}: ${JSON.stringify(ta.get(id) || null)} → ${JSON.stringify(tb.get(id) || null)}`).join('；'))
  if (args.includes('--json')) console.log(JSON.stringify({ readOnly: { ...ro, rate: roRate }, write: rw, byKind: sB, outboxSame: firstDiff < 0, taskDiffs: tDiff.length, misses: missesB.length }))
}

// ———————————————————————————— 入口 ————————————————————————————
const simA = value('--sim-a', null)
const simB = value('--sim-b', null)
if (simA || simB) {
  if (!simA || !simB) throw new Error('--sim-a 与 --sim-b 要一起给')
  runCompare(simA, simB)
} else if (args.includes('--live')) {
  await runLive()
} else {
  console.log('—— 判定表 ——')
  await runTable()
  if (!args.includes('--only-table')) await runOffline()
}
console.log(failed ? `\n${failed} 项不过` : '\n全部通过')
process.exit(failed ? 1 : 0)
