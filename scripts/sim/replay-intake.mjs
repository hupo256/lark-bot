#!/usr/bin/env node
/**
 * L1 分类 / 接单层回放（docs/falive-replay-plan-2026-11-03.md §2）：falive 群里每条触发 bot 的消息，用 lark-bot 现在的代码
 * 拼上下文包（buildConversationBundle，拉取函数改成从时间线取）→ 真跑分类器（classifyTaskIntent）→ 落地规则（applyIntakeClassification），
 * 与 falive 当时的分类 / 落地对照。不碰真实 Lark，不写任务仓；结果追加到 runtime/falive-replay/l1/<run>/results.jsonl（可续跑）。
 *   node scripts/sim/replay-intake.mjs --run base [--conc 6] [--limit n] [--only id,id] [--intent-model m] [--intent-effort e] [--dry] [--dump]
 * 先 node scripts/sim/build-dataset.mjs。对照汇总：node scripts/sim/compare-intake.mjs --run base
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { AVEN_OPEN_ID, BOT_APP_ID, BOT_MENTION_IDS, casesDir, datasetDir, rawDir, replayRoot, resolveRaw, toListItem, toSimEvent } from './falive-data.mjs'

// 运行目录指到主仓 runtime：persona、发件簿都在那；附件（raw/lark-im-resources）在它下面，执行器会 --add-dir 放行。
if (!process.env.LARK_RUNTIME_DIR) process.env.LARK_RUNTIME_DIR = join(homedir(), 'github', 'lark-bot', 'runtime')
// 发件簿 / 义务指到空目录：对话数据（buildConversationData）按 chatId 读发件簿，aven 的私信 chatId 就是他的 open_id，
// 会把现网 fameex 线最近 7 天对他说的话当成「正在进行的事」带进 falive 的回放（11-03 第一轮：回复里冒出 fameex 的「档位弹窗」）。
process.env.LARK_OUTBOX_DIR = join(replayRoot, 'l1', 'empty-outbox')
process.env.LARK_OBLIGATIONS_DIR = join(replayRoot, 'l1', 'empty-obligations')

const { parseFetchedMessage, pickRecentContext, pickThreadContext } = await import('../../lib/lark-chat-context.mjs')
const { buildConversationBundle } = await import('../../lib/lark-conversation-bundle.mjs')
const { applyIntakeClassification } = await import('../../lib/lark-intake-resolve.mjs')
const { mentionsBot, normalizeMessage, parseCommandType, parseControlDirective, parseResumeDirective, resolveMessageTrigger, summarize, textForParse } = await import('../../lib/lark-message.mjs')
const { OPS_COMMAND_TYPE, resolveOpsCommandType } = await import('../../lib/lark-ops-task.mjs')
const { parseDailyDirective } = await import('../../lib/lark-daily-schedule.mjs')
const { parseRetentionDirective } = await import('../../lib/lark-chat-retention.mjs')
const { isDeployNotice } = await import('../../lib/lark-principal-channel.mjs')
const { notForBotReason } = await import('../../lib/lark-control-channel.mjs')
const { classifyTaskIntent } = await import('../../lib/lark-worker-run.mjs')

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const runName = value('--run', 'base')
const concurrency = Number(value('--conc', 6))
const limit = Number(value('--limit', 0))
const only = value('--only', '') ? new Set(value('--only', '').split(',')) : null
const dry = flag('--dry')
const dump = flag('--dump') // 只拼任务（正文 + intake + 附件）落进 results.jsonl、不分类：拿真实上下文做定向 fixture

const mainConfigPath = join(process.env.LARK_RUNTIME_DIR, 'lark-bot.local.json')
const mainConfig = existsSync(mainConfigPath) ? JSON.parse(readFileSync(mainConfigPath, 'utf8')) : {}
const faliveConfig = JSON.parse(readFileSync(join(homedir(), 'github', 'lark-bot-falive', 'runtime', 'lark-bot.local.json'), 'utf8'))
const faliveRepo = faliveConfig.repos?.falive || {}
const BOT_OPEN_ID = 'ou_e331d79d4491e64b7bba89bb4e3b5e43'
export const config = {
  project: 'FALIVE',
  title: 'Falive Web',
  botOpenId: BOT_OPEN_ID,
  botAppId: BOT_APP_ID,
  allowedChatIds: 'auto',
  allowedOpenIds: [AVEN_OPEN_ID],
  notifyOpenId: AVEN_OPEN_ID,
  taskMentionOpenIds: [],
  ownerMap: faliveRepo.ownerMap || {},
  memberRoles: faliveRepo.memberRoles || {},
  aiExecutor: 'claude',
  claudeModel: mainConfig.claudeModel || 'claude-opus-5-5',
  claudeEffort: mainConfig.claudeEffort || 'high',
  claudeIntentModel: value('--intent-model', mainConfig.claudeIntentModel || mainConfig.claudeModel || 'claude-opus-5-5'),
  claudeIntentEffort: value('--intent-effort', mainConfig.claudeIntentEffort || 'low'),
  repoLabel: 'falive-react（Falive Web 前端仓）',
  intake: faliveRepo.intake || undefined,
}
const workerConfig = { projectId: 'FALIVE', projectName: 'Falive Web', aiExecutor: 'claude', localConfig: config }

const timeline = JSON.parse(readFileSync(join(datasetDir, 'timeline.json'), 'utf8'))
const episodes = JSON.parse(readFileSync(join(datasetDir, 'episodes.json'), 'utf8'))
const byId = new Map(timeline.map((m) => [m.id, m]))
const byChat = new Map()
for (const m of timeline) {
  if (!byChat.has(m.chatId)) byChat.set(m.chatId, [])
  byChat.get(m.chatId).push(m)
}
const botIds = [BOT_OPEN_ID, BOT_APP_ID, ...BOT_MENTION_IDS]

// 不同群里 @bot 的 open_id 不同：统一改写成配置的 botOpenId，resolveMessageTrigger 才认得出「叫的是机器人」。
const eventOf = (m) => toSimEvent(m, { botOpenId: BOT_OPEN_ID })

// 时间线供数的四个拉取桩（签名同 lib/lark-cli）。atMs = 本条的发出时刻：线上上下文包在收到时就拼好，话题里之后的回复还不存在。
// 11-04 修：话题回复原来不按时间截，285 条里 85 条看得到「未来」的回复（10-29 aven 叮嘱「Go 上 pre 后回复」被判成「Arthur 说已上 pre」
// 立刻复测，其实 Arthur 2.5 小时后才说；10-31「@Arthur 麻烦补信息」被判成「Arthur 已补」）——是回放漏了未来，不是分类器编的。
const depsFor = (atMs) => ({
  fetchReferencedContext: async (messageId) => {
    const ref = byId.get(messageId)
    if (!ref) return null
    return { ...parseFetchedMessage(ref.msgType, ref.text), sender: ref.senderName, senderOpenId: ref.senderType === 'app' ? BOT_APP_ID : ref.senderId, createTime: String(ref.atMs) }
  },
  fetchThreadContext: async (anchorId, { excludeIds = [], limit = 40 } = {}) => {
    const anchor = byId.get(anchorId)
    const threadId = anchor?.threadId || null
    if (!threadId) return []
    const items = (byChat.get(anchor.chatId) || []).filter((m) => m.threadId === threadId && !m.deleted && m.atMs < atMs).map(toListItem)
    return pickThreadContext(items, { excludeIds, botOpenIds: botIds, limit })
  },
  fetchRecentChatContext: async ({ chatId, beforeMs, excludeIds = [], limit = 20 }) => {
    const items = (byChat.get(chatId) || []).filter((m) => m.atMs < beforeMs && !m.deleted).slice(-200).map(toListItem)
    return pickRecentContext(items, { beforeMs, excludeIds, botOpenIds: botIds, limit })
  },
  // 时间线里的 localPath 已是绝对路径（11-03 发现：原来又拼到 raw/ 后面，L1 与模拟里的附件全部「下载失败」，分类器一张图都没看到）；
  // 补拉的附件查 raw/resources-extra.json（build-context-cache.mjs）。
  downloadAttachments: async ({ messageId, attachments }) => {
    const src = byId.get(messageId)
    return attachments.map((a) => {
      const key = a.type === 'file' ? a.fileKey : a.imageKey
      const fromTimeline = (src?.resources || []).find((r) => r.key === key && r.localPath)?.localPath || null
      const path = [fromTimeline, extraResources[`${messageId}/${key}`]].map(resolveRaw).find((p) => p && existsSync(p))
      return path ? { ...a, localPath: path } : { ...a, downloadError: '存档里没有这份附件' }
    })
  },
})
const extraResourcesPath = join(rawDir, 'resources-extra.json')
const extraResources = existsSync(extraResourcesPath) ? JSON.parse(readFileSync(extraResourcesPath, 'utf8')).resources || {} : {}
const emptyStore = { list: () => [], listRecentForChat: () => [], findTaskByAnyReceipt: () => null, findByReceiptMessageId: () => null, has: () => false }

// ingest 在分类之前按原话确定处理、不过模型的几条路（顺序同 lib/lark-ingest：控制指令 → 日报 / 退群 → 运维 → 部署知会 → 续跑指令）。
// 回放不建这些任务、也不分类，记 route（11-04：「继续任务 <id>」「结单 <id>」「推 pre」原来都送了分类器，判 ignore 算成 lark-bot 漏做，线上根本到不了分类器）。
// 只认不看任务库的；要看任务库的（私信锚到上一条通知、回复 bot 卡片的控制通道）回放没有库，照旧分类。
const deterministicRoute = (msg) => {
  const principalDm = msg.chatType === 'p2p' && msg.senderOpenId === AVEN_OPEN_ID
  const text = textForParse(msg)
  if (parseControlDirective(msg.text)) return 'control_directive'
  if (principalDm && parseDailyDirective(msg.text)) return 'daily_directive'
  if (principalDm && parseRetentionDirective(msg.text)) return 'retention_directive'
  if (resolveOpsCommandType({ config, msg, classified: { type: parseCommandType(text), source: 'explicit' } }).type === OPS_COMMAND_TYPE) return 'ops'
  if (principalDm && isDeployNotice(text)) return 'deploy_notice'
  if (parseResumeDirective(text)) return 'resume_directive'
  return null
}

const buildTask = async (m) => {
  const msg = normalizeMessage(eventOf(m))
  const replyTarget = m.parentId ? byId.get(m.parentId) : null
  const isBotReceiptReply = Boolean(replyTarget?.ownBot)
  const rawTrigger = resolveMessageTrigger({ msg, config, isBotReceiptReply })
  const trigger = rawTrigger === 'task_mention' ? null : rawTrigger
  if (!trigger) return { msg, trigger: null, task: null }
  const route = deterministicRoute(msg) || (trigger === 'bot_reply' && notForBotReason({ msg, config }) ? 'not_for_bot' : null) // 网关同口径（lib/lark-ingest.mjs）
  if (route) return { msg, trigger: rawTrigger, task: null, route }
  const bundle = await buildConversationBundle({ msg, config, store: emptyStore, project: 'FALIVE', deps: depsFor(m.atMs) })
  // 话题里在回上一条 @ 了他的同事（answeringColleague）：网关同口径静默、不分类（lib/lark-ingest.mjs，11-04 b3）。
  if (trigger === 'bot_reply' && bundle.answering) return { msg, trigger: rawTrigger, task: null, route: 'answering_colleague' }
  const fromPrincipal = msg.senderOpenId === AVEN_OPEN_ID
  const receivedAt = new Date(m.atMs).toISOString()
  const commandType = parseCommandType(textForParse(msg))
  const task = {
    id: msg.messageId,
    source: 'lark',
    chatId: msg.chatId,
    chatType: msg.chatType || 'group',
    messageId: msg.messageId,
    threadRootId: msg.threadRootId || msg.replyTo || null,
    operator: msg.senderOpenId,
    project: 'FALIVE',
    commandType,
    commandTypeSource: commandType ? 'explicit' : null,
    chatName: m.chatName,
    text: bundle.text,
    summary: summarize(msg.text?.trim() ? msg.text : bundle.refText || ''),
    attachments: bundle.attachments,
    conversation: bundle.conversation,
    addressedToBot: true,
    fromPrincipal,
    quotedOwnCard: bundle.quotedOwnCard,
    status: 'received',
    intake: { required: true, trigger: trigger === 'bot_reply' ? 'bot_reply' : msg.chatType === 'p2p' ? 'dm' : 'bot_mention', mentionedBot: mentionsBot({ msg, config }), receivedAt },
    createdAt: receivedAt,
  }
  return { msg, trigger, task }
}

const outDir = join(replayRoot, 'l1', runName)
mkdirSync(outDir, { recursive: true })
const resultsPath = join(outDir, 'results.jsonl')
const done = new Set(existsSync(resultsPath) ? readFileSync(resultsPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line).id) : [])

// 默认跑 falive-bot 做过的全部 case（replay/falive/cases.jsonl，285 条；design-v2 §8 前置 1b）；--episodes 退回旧口径（falive 网关基线里的 366 条）
const caseIds = readFileSync(join(casesDir, 'cases.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).id)
const pool = args.includes('--episodes') ? episodes.filter((e) => e.inTimeline) : caseIds.map((id) => episodes.find((e) => e.id === id) || { id, inTimeline: true, baseline: {} })
let queue = pool.filter((e) => !done.has(e.id) && (!only || only.has(e.id)))
if (limit) queue = queue.slice(0, limit)
console.log(`[l1] run=${runName} 待跑 ${queue.length} 条（已完成 ${done.size}）intent=${config.claudeIntentModel}/${config.claudeIntentEffort}${dry ? ' dry' : ''}`)

const record = (row) => appendFileSync(resultsPath, `${JSON.stringify(row)}\n`)
let index = 0
const worker = async () => {
  while (index < queue.length) {
    const episode = queue[index++]
    const m = byId.get(episode.id)
    const startedAt = Date.now()
    try {
      const { trigger, task, route } = await buildTask(m)
      if (route) {
        record({ id: m.id, run: runName, trigger, skipped: 'deterministic', route, ms: 0 })
        console.log(`[l1] ${m.id} 不过分类（${route}）：${String(m.text).slice(0, 40)}`)
        continue
      }
      if (!trigger) {
        record({ id: m.id, run: runName, trigger: null, skipped: 'no_trigger', ms: 0 })
        console.log(`[l1] ${m.id} 无触发（${m.senderName}：${String(m.text).slice(0, 40)}）`)
        continue
      }
      if (dump) {
        record({ id: m.id, run: runName, trigger, dump: true, task: { text: task.text, intake: task.intake, fromPrincipal: task.fromPrincipal, attachments: task.attachments.filter((a) => a.localPath).map((a) => ({ type: a.type, localPath: a.localPath })) }, ms: 0 })
        continue
      }
      if (dry) {
        record({ id: m.id, run: runName, trigger, dry: true, textChars: task.text.length, attachments: task.attachments.length, ms: 0 })
        continue
      }
      const classification = await classifyTaskIntent(workerConfig, task, null, undefined)
      const applied = applyIntakeClassification(structuredClone(task), { classification })
      record({
        id: m.id, run: runName, trigger, ms: Date.now() - startedAt,
        textChars: task.text.length, attachments: task.attachments.map((a) => ({ type: a.type, localPath: a.localPath || null, downloadError: a.downloadError || null })),
        classification, outcome: applied, status: applied.status || null,
      })
      console.log(`[l1] ${m.id} ${classification.decision}/${classification.confidence}${classification.deliverable ? `·${classification.deliverable}` : ''} ← falive ${episode.baseline.classified ? `${episode.baseline.classified.decision}/${episode.baseline.classified.confidence}` : '未记录'}（${Math.round((Date.now() - startedAt) / 1000)}s）`)
    } catch (error) {
      record({ id: m.id, run: runName, error: String(error?.message || error).slice(0, 500), ms: Date.now() - startedAt })
      console.error(`[l1] ${m.id} 失败：${String(error?.message || error).slice(0, 200)}`)
    }
  }
}
await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker))
console.log(`[l1] 完成，结果在 ${resultsPath}`)
