/**
 * Lark Gateway 的事件摄入层：把长连接事件归一为任务。
 *
 * 11-01 对话层：每条 @bot / aven 私信 / 回复 bot 消息都先建 `received` 任务、挂起「收到」，由 worker 的分类器
 *（只 @ 负责人 / @所有人 的消息 11-02 起不再处理，见 ingestWhitelistedEvent 开头）
 *（五类 + 交付物 + 接话）决定开跑 / 自答 / 追问 / 疑似 / 只记一笔 / 忽略（lib/lark-routes-intake.mjs）。只有显式控制指令
 *（取消 / 结单 / 重开 / 继续任务 <id>、绑定 PR-x）和负责人的运维指令不过模型。顺序：
 *   触发 / 白名单（记群活跃）→ 项目群指令 → 显式控制指令 → 日报指令 / 退群指令 / 运维指令（负责人私信）→ 负责人私信主通道（锚到上一条通知）
 *   → 控制通道（回复 bot 消息 = 结单 / 续跑 / 确认）→ 续跑指令 / 同话题挂起归并 → 话题补充并入未分类任务
 *   → 上下文包（引用 / 话题 / 最近 20 条 / 对话数据）→ 建任务 → 挂「收到」。
 * 控制通道等已拆到 lib/lark-control-channel.mjs；含并发占位防 TOCTOU 双跑。
 */

import { configTitleFor } from './lark-config.mjs'
import { resolveAiExecutor } from './lark-ai-executor-select.mjs'
import {
  isWhitelisted,
  mentionsBot,
  normalizeMessage,
  parseCommandType,
  parseResumeDirective,
  resolveMessageTrigger,
  summarize,
  textForParse,
} from './lark-message.mjs'
import { matchProjectId, matchProjectIds } from './lark-project-id.mjs'
import { loadProjectChats, projectForChat } from './lark-project-chats.mjs'
import { maybeHandleProjectChatDirective } from './lark-project-chat-sync.mjs'
import { OPS_COMMAND_TYPE, resolveOpsCommandType } from './lark-ops-task.mjs'
import { maybeHandleDailyDirective } from './lark-daily-schedule.mjs'
import { recordChatActivity } from './lark-chat-activity.mjs'
import { maybeHandleRetentionDirective } from './lark-chat-retention.mjs'
import { fetchThreadContext, isChatMember, resolveChatName } from './lark-cli.mjs'
import { handleResume, implicitResumeVerdict, maybeHandleControlChannel, maybeHandleControlDirective, notForBotReason, resolveResumeTarget } from './lark-control-channel.mjs'
import { buildConversationBundle } from './lark-conversation-bundle.mjs'
import { intakeTiming, isCompleteMessage, markAckPending, mergeThreadSupplement, pickSupplementTarget, resolveIntakeLane, resolveIntakeNotBefore } from './lark-intake-ack.mjs'
import { isPrincipal, maybeHandlePrincipalChannel } from './lark-principal-channel.mjs'
import { deriveContract } from './lark-task-contract.mjs'
import { buildResumeSupplement, findThreadPredecessor } from './lark-thread-link.mjs'

// 控制通道（结单 / 重开 / 续跑 / 确认）已搬到 lark-control-channel.mjs（11-01）；这里 re-export 兼容既有测试与调用点。
export { decideControlAction, resolveControlTarget, resolveManualCloseTarget, resolveResumeTarget } from './lark-control-channel.mjs'

// 群消息可用 `[claude]` / `[codex]` / `[pi]` / `[cursor]` 临时覆盖本机默认。Lark 会把消息开头的图片
// 归一成 Markdown / fallback 占位符，因此先跳过连续的前置图片，再识别首个文本指令。
// 正文已经开始后出现的同名标签仍不生效，避免把普通讨论误判为执行器切换。
export const parseAiExecutorDirective = (text) => {
  const match = String(text || '').match(
    /^\s*(?:(?:!\[[^\]\r\n]*\]\([^)]+\)|\[Image:\s*[^\]\r\n]+\])\s*)*\[(codex|claude|pi|cursor)\]/i,
  )
  return match ? match[1].toLowerCase() : undefined
}

// 排队卡必须展示任务最终会用的执行器，不能等 Worker 领取后才补写。
export const resolveGatewayAiExecutor = ({ requestedExecutor, config }) =>
  resolveAiExecutor({ localConfig: config }, { aiExecutor: requestedExecutor })

// 项目号解析优先级：**正文里恰好一个项目号**（最强，人在这条消息里明确指了项目）> 群名 `[PR-xxxxx]`
// > 正文首个项目号（兜底）。都无则返回 null，由调用方回落到「主仓临时 hotfix 分支」。
//
// 为什么正文优先于群名：跨项目群（一个群跟多个 PR）里群名带的项目号往往是群创建时那个，而人会在正文
// 明确写「PR-02306 这个页面…」。旧口径群名无条件权威，会把这条任务路由到错项目的 worktree/文档上。
// 反过来「正文常引用别的工单号」这个原始顾虑仍然成立，出口是**唯一性**：正文出现 ≥2 个不同项目号即
// 视为在引用（无从判断哪个是目标），回落群名。
// aven 2026-11-01：群 → 项目先查绑定表（按 chat_id，群改名不影响），绑定表没有才看群名线索。
const resolveProject = ({ chatId, text, chatName }) => {
  const fromText = matchProjectIds(text)
  if (fromText.length === 1) return fromText[0]
  const bound = projectForChat(loadProjectChats(), chatId)
  if (bound) return bound
  const fromChatName = matchProjectId(chatName || '')
  return fromChatName || fromText[0] || null
}

// auto 成员制白名单需查 bot 是否在该群（仅群消息且 auto 模式才查，避免无谓网络调用）
const resolveMembership = async ({ msg, config }) =>
  config.allowedChatIds === 'auto' && msg.chatType !== 'p2p' ? isChatMember(msg.chatId) : false

// 正在摄入中的 messageId（同步占位，防 TOCTOU 双跑）：lark-cli 可能把同一事件投递两次，
// 两个 onLine 并发进 ingest 会各自在 `store.has` 后、`store.upsert` 前的 await 窗口里都判为「新」。
// 此 Set 在任何 await 前同步占位，只有首个能进入；持久化后由 store.has 接管去重。
const ingestingMessageIds = new Set()

export const isRegisteredBotReceiptReply = ({ msg, store }) => Boolean(
  (msg.replyToDirect && (store.findTaskByAnyReceipt?.(msg.replyToDirect) || store.findByReceiptMessageId?.(msg.replyToDirect))) ||
  // 话题根就是 bot 的消息（话题内发言不带 reply_to）：也算在回 bot。
  (msg.threadRootId && (store.findTaskByAnyReceipt?.(msg.threadRootId) || store.findByReceiptMessageId?.(msg.threadRootId))),
)

export const ingestLarkEvent = async ({ raw, config, store }) => {
  const msg = normalizeMessage(raw)
  if (!msg || store.has(msg.messageId) || ingestingMessageIds.has(msg.messageId)) return // 非消息事件 / 幂等 / 并发占位
  ingestingMessageIds.add(msg.messageId)
  try {
    await ingestWhitelistedEvent({ msg, config, store })
  } finally {
    ingestingMessageIds.delete(msg.messageId)
  }
}

// 续跑补料带上「前一单之后话题里的消息」（11-04：Rou 在话题里没 @bot 的三条指示，续跑时只并了 aven 那句「obey order of ROU」）。
// 只拉一次话题；拉不到 / 没有新消息就原样续本条原话。
const withThreadSince = async ({ msg, config, task }) => {
  const anchor = msg.replyTo || msg.threadId
  if (!anchor || !task) return msg
  try {
    const items = await fetchThreadContext(anchor, { excludeIds: [msg.messageId, msg.replyTo].filter(Boolean), botOpenIds: [config.botOpenId, config.botAppId].filter(Boolean) })
    const text = buildResumeSupplement({ msg, task, items })
    return text === String(msg.text || '').trim() ? msg : { ...msg, text }
  } catch (error) {
    console.warn(`[lark-gateway] ${msg.messageId} 续跑前拉话题失败（只续本条）：${String(error?.message || error).slice(0, 120)}`)
    return msg
  }
}

// 触发 → 分类器眼里的入口类型：私信 / 直接 @bot / 回复 bot 消息 / 只 @ 负责人。
const intakeTriggerOf = ({ msg, trigger }) => {
  if (trigger === 'task_mention') return 'task_mention'
  if (trigger === 'bot_reply') return 'bot_reply'
  return msg.chatType === 'p2p' ? 'dm' : 'bot_mention'
}

const ingestWhitelistedEvent = async ({ msg, config, store }) => {
  const isBotReceiptReply = isRegisteredBotReceiptReply({ msg, store })
  const rawTrigger = resolveMessageTrigger({ msg, config, isBotReceiptReply })
  // aven 11-02：只处理 @bot / 私信 / 回复 bot 三种。只 @ 负责人本人或 @所有人（task_mention）的消息不再送分类——实践下来这条路
  // 判「是不是负责人的活」太复杂、准确性低，没有更好的办法之前先关掉；这些消息只作为后续 @bot 时的上下文（最近 20 条）。
  const trigger = rawTrigger === 'task_mention' ? null : rawTrigger
  // 没叫机器人的群消息：绝大多数直接丢（不查群成员、不拉上下文）；只有「同一人 / 同话题还有一条没分类的任务」时并进去一起分类（去抖）。
  if (!trigger) {
    if (msg.senderType === 'bot' || !pickSupplementTarget({ msg, store, quietGapMs: intakeTiming(config).quietGapMs })) return
    if (!isWhitelisted({ msg, config, isMember: await resolveMembership({ msg, config }) })) return
    await mergeThreadSupplement({ msg, config, store, addressedToBot: false })
    return
  }
  const isMember = await resolveMembership({ msg, config })
  if (!isWhitelisted({ msg, config, isMember })) return
  // 私信空消息丢掉；群里光一条「@bot」（没正文、没附件、没引用）照样进分类——人在自己上一条后面单独 @ 一下是常见的催 / 接话
  //（11-03 falive 回放 10-26：两条这样的 @ 直接被丢，falive 当时接上了前文）。上下文包会带最近 20 条。
  if (!msg.text && !msg.attachments.length && !msg.replyTo && msg.chatType === 'p2p') return
  // 群里有人 @bot / 回复 bot：记一笔群活跃（14 天没人找就自动退群，lib/lark-chat-retention.mjs）。后面不管走哪条路都算；私聊不记。
  recordChatActivity({ chatId: msg.chatId, chatType: msg.chatType })

  // 项目群绑定指令（绑定 / 解绑 / 项目群列表）：只认负责人，先于任务指令处理。
  if (await maybeHandleProjectChatDirective({ msg, config })) return

  // L3 显式控制指令（结单/取消任务/重开任务 <id>）：带显式 taskId，最强意图，先于回复锚定处理（锚错了回「取消任务 id」就靠它）。
  if (await maybeHandleControlDirective({ msg, config, store })) return

  // 负责人私信「发日报 / 重发日报」（整句才算）：直接排日报任务，不过分类（lib/lark-daily-schedule.mjs）。
  if (await maybeHandleDailyDirective({ msg, config, store })) return

  // 负责人私信「留下 关键字」/「退群列表」：闲置群自动退出的豁免与查看（lib/lark-chat-retention.mjs）。
  if (await maybeHandleRetentionDirective({ msg, config })) return

  // 运维指令（负责人私信，显式「运维：」或按原话推断）：固定动作、不过模型，直接排队（lib/lark-ops-task.mjs）。
  const ops = resolveOpsCommandType({ config, msg, classified: { type: parseCommandType(textForParse(msg)), source: 'explicit' } })
  if (ops.type === OPS_COMMAND_TYPE) return await createOpsTask({ msg, config, store, commandTypeSource: ops.source })

  // 负责人私信主通道：锚到 bot 上一条私信通知 → 续跑 / 放行草稿 / 建指示任务；锚不到放行（独立私信任务）。
  if (await maybeHandlePrincipalChannel({ msg, config, store })) return

  // 任务控制通道：这条消息一旦能锚定到一条 Bot 消息 / 原任务，就只能做「结单/重开/续跑补料/确认」，绝不 fall through 新建任务。
  // 放行时带回锚点任务 id：本条若被分类成改码 / 对接类，并入那条而不是开平行工单（lib/lark-routes-intake.mjs）。
  const { handled: controlHandled, anchorTaskId, supplement } = await maybeHandleControlChannel({ msg, config, store })
  if (controlHandled) return
  // 回 bot 消息却明显不是对机器人说的（寒暄 / 抄送、只 @ 了别的同事，notForBotReason）：不过分类、不建任务、不并进别的单、不回「收到」。
  // 放在控制通道之后：结单 / 重开 / 暂停这些不花模型的确定性动作照旧。
  const notForBot = trigger === 'bot_reply' ? notForBotReason({ msg, config }) : null
  if (notForBot) return console.log(`[lark-gateway] ${msg.messageId} 回 bot 消息但不是对机器人说的（${notForBot === 'social' ? '寒暄 / 抄送' : '@ 的是别的同事'}），静默、不分类`)
  // 回复了「收到」、原任务还没分类（11-02 复核）：当话题补充并进去一起分类，不回第二句、不走续跑（续跑会回「不在等材料，续不了」）。
  if (supplement && await mergeThreadSupplement({ msg, config, store, addressedToBot: true, target: store.get(anchorTaskId) })) return

  // waiting_confirmation / blocked 续任务：显式「继续任务 <id>」/ 回复原任务消息 / 话题根命中仍挂起的任务 → 补料续跑，不建孤儿任务。
  // 没写「继续任务」的隐式续跑过门槛（implicitResumeVerdict，11-04 falive 回放）：同事在挂起卡片的话题里互相说话不算补料——
  // 寒暄 / 抄送静默丢；@ 了别人 / 旁人搭话放行到下面的分类（是补料的分类器判 continues 照样并进去）。
  const resumeDirective = parseResumeDirective(textForParse(msg))
  const resumeTarget = resolveResumeTarget({ msg, store, resumeDirective })
  const resumeGate = resumeTarget && !resumeTarget.explicit ? implicitResumeVerdict({ msg, config, task: resumeTarget.task }) : 'resume'
  if (resumeTarget && resumeGate === 'resume') {
    const resumeMsg = resumeTarget.explicit ? msg : await withThreadSince({ msg, config, task: resumeTarget.task })
    return await handleResume({ msg: resumeMsg, config, store, resumeDirective, parentTask: resumeTarget })
  }
  if (resumeGate === 'ignore') return console.log(`[lark-gateway] ${msg.messageId} 回挂起任务 ${resumeTarget.taskId} 的寒暄 / 抄送 / 跟同事说的话，静默`)

  // 同话题归并：本条落在一个「仍挂起且唯一」的话题里，像是对机器人说的（同一道门槛）才当那条挂起任务在等的补料。
  const threadRoot = msg.threadRootId || msg.replyTo
  const parkedSiblings = resumeTarget ? [] : store.listParkedByThread(threadRoot, { excludeId: msg.messageId })
  const siblingGate = parkedSiblings.length === 1 ? implicitResumeVerdict({ msg, config, task: parkedSiblings[0] }) : null
  if (siblingGate === 'ignore') return console.log(`[lark-gateway] ${msg.messageId} 挂起任务 ${parkedSiblings[0].id} 话题里的寒暄 / 抄送，静默`)
  if (siblingGate === 'resume') {
    const sibling = parkedSiblings[0]
    console.log(`[lark-gateway] 同话题归并：本条 @ 并入挂起任务 ${sibling.id}（thread=${threadRoot}）`)
    return await handleResume({ msg: await withThreadSince({ msg, config, task: sibling }), config, store, parentTask: { taskId: sibling.id, task: sibling, explicit: false } })
  }

  // 还没分类的任务有后续（同话题 / 同人连发）：并进去一起分类。
  if (await mergeThreadSupplement({ msg, config, store, addressedToBot: true })) return

  // 群名只查一次（chat-list 缓存）：既给项目号线索，也记在任务上给私信通知当群的叫法；私信不查。
  const chatName = msg.chatType === 'p2p' ? null : (await resolveChatName(msg.chatId)) || null
  const project = resolveProject({ chatId: msg.chatId, text: msg.text, chatName })
  // 同话题前一单（任何状态，含已关 / blocked，11-04）：上下文包带上它和它之后话题里的消息；没有别的锚点时把它当锚点。
  const predecessor = findThreadPredecessor({ msg, store })
  if (predecessor) console.log(`[lark-gateway] 同话题前一单：${msg.messageId} 关联 ${predecessor.id}（${predecessor.status}）`)
  const bundle = await buildConversationBundle({ msg, config, store, project, predecessor })
  const addressedToBot = true // 三种触发都是对 bot 说的（task_mention 已在上面关掉）
  const fromPrincipal = isPrincipal(config, msg.senderOpenId)
  const receivedAt = new Date().toISOString()
  const draft = { addressedToBot, fromPrincipal, quotedOwnCard: bundle.quotedOwnCard, ...(bundle.quotedTaskId ? { quotedTaskId: bundle.quotedTaskId } : {}) }
  const lane = resolveIntakeLane({ task: draft })
  const commandType = parseCommandType(textForParse(msg)) // 只认本条原话里的显式前缀；要不要只读由分类器 + 契约决定
  const task = store.upsert({
    id: msg.messageId,
    source: 'lark',
    chatId: msg.chatId,
    chatType: msg.chatType || null,
    messageId: msg.messageId,
    // 回复目标：群里一律回复原消息；原消息在话题里才回话题流。
    replyTarget: { messageId: msg.messageId, inThread: Boolean(msg.threadId) },
    // 话题稳定身份：同话题的后续 @ 与「兄弟任务完成收尾」都靠它归并（见 listParkedByThread）。
    threadRootId: msg.threadRootId || msg.replyTo || null,
    operator: msg.senderOpenId,
    project: project || null,
    commandType,
    commandTypeSource: commandType ? 'explicit' : null,
    projectTitle: configTitleFor(project, config),
    chatName, // 私信通知里叫「（群名）」而不是 oc_ id（11-02 真机）
    text: bundle.text,
    summary: summarize(msg.text?.trim() ? msg.text : bundle.refText || ''),
    attachments: bundle.attachments,
    ...(bundle.threadSpeakers.length ? { threadSpeakers: bundle.threadSpeakers } : {}),
    ...(bundle.conversation?.anchor ? { anchor: bundle.conversation.anchor } : {}),
    ...(predecessor ? { threadPredecessorId: predecessor.id } : {}),
    conversation: bundle.conversation,
    ...draft,
    aiExecutor: resolveGatewayAiExecutor({ requestedExecutor: parseAiExecutorDirective(textForParse(msg)), config }),
    status: 'received',
    intake: {
      required: true,
      trigger: intakeTriggerOf({ msg, trigger }),
      mentionedBot: mentionsBot({ msg, config }), // 回复 bot 消息却没 @ 它：分类器先判是不是在跟同事说（lib/lark-classify-prompt addressedBlock）
      mentionedOpenIds: msg.mentions.map((mention) => mention.id).filter((id) => config.taskMentionOpenIds?.includes(id)),
      lane,
      notBefore: resolveIntakeNotBefore({ lane, complete: isCompleteMessage({ msg }), firstReceivedAt: receivedAt, intake: intakeTiming(config) }),
      receivedAt,
      anchorTaskId: anchorTaskId || predecessor?.id || null,
    },
    createdAt: receivedAt,
    messageCreatedAt: msg.createTimeMs ? new Date(msg.createTimeMs).toISOString() : null, // 飞书侧发出时间：端到端时延的起点（lib/lark-latency）
  })
  // 「收到」等分类器写的那句再发（到点没分类发固定句）；只 @ 负责人的不回，判 ignore 时群里零噪声。
  if (addressedToBot) markAckPending({ store, task })
  console.log(`[lark-gateway] received ${task.intake.trigger} ${task.id}（${project || 'adhoc'}，${lane}），等待意图分类: ${task.summary}`)
}

// 运维指令任务：固定动作，直接排队给 worker（lib/lark-ops-run.mjs），不建上下文包、不过分类。
const createOpsTask = async ({ msg, config, store, commandTypeSource }) => {
  const base = {
    id: msg.messageId,
    source: 'lark',
    chatId: msg.chatId,
    chatType: msg.chatType || null,
    messageId: msg.messageId,
    replyTarget: { messageId: msg.messageId, inThread: false },
    threadRootId: msg.threadRootId || msg.replyTo || null,
    operator: msg.senderOpenId,
    project: null,
    commandType: OPS_COMMAND_TYPE,
    commandTypeSource,
    projectTitle: null,
    text: msg.text || '',
    summary: summarize(msg.text),
    attachments: [],
    addressedToBot: true,
    fromPrincipal: true,
    aiExecutor: resolveGatewayAiExecutor({ requestedExecutor: undefined, config }),
    status: 'queued',
    intake: null,
    createdAt: new Date().toISOString(),
    messageCreatedAt: msg.createTimeMs ? new Date(msg.createTimeMs).toISOString() : null,
  }
  const task = store.upsert({ ...base, contract: deriveContract(base) })
  console.log(`[lark-gateway] queued ops ${task.id}（${commandTypeSource}）: ${task.summary}`)
  return task
}
