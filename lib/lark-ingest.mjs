/**
 * Lark Gateway 的事件摄入层：把长连接事件归一为任务——白名单/@bot 判定、waiting/blocked 续任务补料、
 * 引用消息合并、附件下载、项目号路由、建 task 并发排队卡与通知日志。含并发占位防 TOCTOU 双跑。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { worktreesDir } from './lark-repo.mjs'
import { resolveAiExecutor } from './lark-ai-executor.mjs'
import {
  classifyClosureIntent,
  classifyCommandType,
  classifyPauseIntent,
  classifyReopenIntent,
  isNonSupplementalReply,
  isWhitelisted,
  normalizeMessage,
  parseControlDirective,
  parseResumeDirective,
  resolveMessageTrigger,
  summarize,
} from './lark-message.mjs'
import { matchProjectId, matchProjectIds } from './lark-project-id.mjs'
import { buildCardContent, formatDisplayTime } from './lark-cards.mjs'
import {
  downloadAttachments,
  fetchReferencedContext,
  fetchThreadContext,
  isChatMember,
  resolveChatName,
  sendChatMessage,
} from './lark-cli.mjs'
import { appendNotificationLog } from './lark-bugtable-writeback.mjs'
import { isControlActiveStatus, isReopenableClosedTask } from './lark-task-store.mjs'
import { sendQueuedReceipt } from './lark-status.mjs'

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
const resolveProject = async ({ chatId, text }) => {
  const fromText = matchProjectIds(text)
  if (fromText.length === 1) return fromText[0]
  const fromChatName = matchProjectId(await resolveChatName(chatId))
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
  msg.replyToDirect &&
  (store.findTaskByAnyReceipt?.(msg.replyToDirect) || store.findByReceiptMessageId?.(msg.replyToDirect)),
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

// 续跑目标解析（带来源）。返回 { taskId, task, explicit } 表示识别出续跑意图；null 表示按新任务处理。
// 只在以下情形算续跑意图，避免把线程内的全新请求误当续跑而吞掉：
//   · 显式「继续任务 <id>」指令（强意图，即使目标不存在/不可续也要进 handleResume 明确回话）；
//   · 明确回复机器人回执卡（findByReceiptMessageId 命中）；
//   · 明确回复原任务消息且该任务仍待确认/阻塞；
//   · 无 reply_to、仅线程根 root_id 命中回执或原任务消息，且该任务仍待确认/阻塞。
export const resolveResumeTarget = ({ msg, store, resumeDirective }) => {
  const parked = (task) => Boolean(task) && (task.status === 'waiting_confirmation' || task.status === 'blocked')
  if (resumeDirective) {
    return { taskId: resumeDirective.taskId, task: store.get(resumeDirective.taskId), explicit: true }
  }
  const direct = msg.replyToDirect
  if (direct) {
    const byReceipt = store.findByReceiptMessageId(direct)
    if (byReceipt) return { taskId: byReceipt.id, task: byReceipt, explicit: false }
    const byId = store.get(direct)
    if (parked(byId)) return { taskId: byId.id, task: byId, explicit: false }
    return null
  }
  const root = msg.replyTo
  if (root) {
    const byReceipt = store.findByReceiptMessageId(root)
    if (parked(byReceipt)) return { taskId: byReceipt.id, task: byReceipt, explicit: false }
    // 线程根就是那条**原任务消息本身**且任务仍卡着（task.id 恒等于原 @ 消息的 messageId）：
    // 人在话题里直接发一句补料（Lark 话题内发言不带 reply_to）就是这个形状。原先只认回执卡，
    // 于是这条补料被当成全新任务建成孤儿，原任务继续挂着没人管（PR-01947 空转 3.5 小时的实际成因）。
    // 收窄点在 parked：命中的必须是一条仍待确认/阻塞的任务，已 done/failed 的话题根一律按新任务处理。
    const byId = store.get(root)
    if (parked(byId)) return { taskId: byId.id, task: byId, explicit: false }
  }
  return null
}

// 任务控制通道锚定：这条消息若明确回复了 Bot 卡片 / 原任务消息，或落在「恰好一条活动任务」的话题里，
// 就返回那条任务；否则 null（按新任务/续跑处理）。锚定用忽略代次的回执反查——续跑过(epoch++)后人回复旧卡
// 也要能定位回原任务。返回的任务可能是任意状态（含终态），由控制通道处理器按状态分流。
export const resolveControlTarget = ({ msg, store }) => {
  const byReceipt = (id) =>
    id ? (store.findTaskByAnyReceipt?.(id) || store.findByReceiptMessageId?.(id) || null) : null
  const direct = msg.replyToDirect
  if (direct) {
    const exact = byReceipt(direct) || store.get(direct) || null
    if (exact) return exact
  }
  const root = msg.replyTo
  const rooted = root ? byReceipt(root) || store.get(root) || null : null
  if (rooted) return rooted
  // 无直接锚点：同话题恰好一条活动任务才归并（0 条或 ≥2 条归属不明，退回新任务，绝不误关）。
  const threadRoot = msg.threadRootId || msg.replyTo
  const active = threadRoot ? store.listActiveByThread?.(threadRoot, { excludeId: msg.messageId }) || [] : []
  return active.length === 1 ? active[0] : null
}

const controlCandidates = ({ msg, store }) => {
  const threadRoot = msg.threadRootId || msg.replyTo
  return threadRoot ? store.listActiveByThread?.(threadRoot, { excludeId: msg.messageId }) || [] : []
}

// 兼容旧名（既有测试/调用点）：结单锚定即控制通道锚定。
export const resolveManualCloseTarget = resolveControlTarget

// 结单回群文案（按 closureReason 分流；取消类绝不写「已完成」）。
const CLOSE_RECEIPT_COPY = {
  cancelled: '已收到，原任务已取消并结单，不再继续执行。本条消息未创建新任务。',
  no_longer_needed: '已收到，原任务已按「无需处理」结单，不再继续执行。本条消息未创建新任务。',
  completed_elsewhere: '已收到，原任务已按「其他方式已完成」结单，不再继续执行。本条消息未创建新任务。',
}
const CLOSE_LOG_STATUS = { cancelled: '已取消', no_longer_needed: '已取消', completed_elsewhere: '外部完成' }

// 结单：把关联任务落终态并回执。已是终态则幂等回「已结束」，绝不重复操作、绝不新建任务。
const handleClose = async ({ msg, config, store, task, closureReason }) => {
  const notice = (lines) => sendChatMessage({
    chatId: msg.chatId,
    card: buildCardContent({ config, kind: 'notice', lines, project: task?.project }),
    logPrefix: 'task close notice',
    idempotencyKey: `${msg.messageId}-close`,
  })
  const outcome = store.closeAsExternallyResolved({
    id: task.id,
    operator: msg.senderOpenId,
    messageId: msg.messageId,
    closureReason,
  })
  if (!outcome) {
    await notice([`**任务**：${task.summary || task.id}`, `**说明**：原任务当前状态为「${task.status}」，已结束，无需重复结单，也未创建新任务。`])
    return null
  }
  const reason = outcome.closureReason
  console.log(`[lark-gateway] 人工结单：任务 ${task.id} 由 ${outcome.previousStatus} -> superseded（${reason}），本条不新建任务`)
  await notice([`**任务**：${task.summary || task.id}`, `**处理**：${CLOSE_RECEIPT_COPY[reason]}`])
  appendNotificationLog({
    config,
    project: task.project,
    row: `| ${formatDisplayTime()} | Lark Job | ${CLOSE_LOG_STATUS[reason]} | 人工结单(${reason})：${task.summary || task.id} | real | success |`,
  })
  return outcome
}

const confirmResidualRequest = async ({ msg, config, task, residualRequest }) => {
  await sendChatMessage({
    chatId: msg.chatId,
    card: buildCardContent({
      config,
      kind: 'notice',
      lines: [
        `**原任务**：${task.summary || task.id}（已结单）`,
        `**识别到后续请求**：${residualRequest}`,
        '**请确认**：后半段尚未创建任务。如需处理，请另发一条并 @应用。',
      ],
      project: task?.project,
    }),
    logPrefix: 'residual request confirm',
    idempotencyKey: `${msg.messageId}-residual-confirm`,
  })
}

// 意图不明确（否定/暂停/部分范围/转折/弱结单信号）：不结单、不改任务、不新建，回一句让用户一键裁决。
// 轻量仲裁（不引 AI）：把猜测的 closureReason 与**带真实 taskId 的一键指令**摆出来，让人点一下即落态或补料续跑。
const CLOSURE_REASON_LABEL = {
  cancelled: '取消该任务',
  no_longer_needed: '不再需要处理',
  completed_elsewhere: '已在别处完成',
}
const confirmClosure = async ({ msg, config, task, verdict }) => {
  const guess = CLOSURE_REASON_LABEL[verdict?.closureReason] || '结束该任务'
  const ask = verdict?.scope === 'partial'
    // 夹带「另一部分要继续」：先分清整单关还是只取消一部分，避免误伤未说结单的残余段。
    ? `**请确认**：你是要结束整个任务，还是只取消其中一部分？原任务暂未变更，也没有创建新任务。要结束整个任务回复「取消任务 ${task.id}」；只处理其中一部分请直接补充说明以继续。`
    // 弱信号/否定/暂停等：给出猜测方向 + 一键指令，人点一下即结单，或补充说明继续。
    : `**请确认**：这条像是想「${guess}」，但不够明确，原任务暂未变更、也没有创建新任务。确认结束请回复「取消任务 ${task.id}」（或「结单 ${task.id}」）；若要继续请直接补充具体说明。`
  await sendChatMessage({
    chatId: msg.chatId,
    card: buildCardContent({
      config,
      kind: 'notice',
      lines: [`**任务**：${task.summary || task.id}`, ask],
      project: task?.project,
    }),
    logPrefix: 'closure confirm notice',
    idempotencyKey: `${msg.messageId}-close-confirm`,
  })
}

// 活动任务被回复、但既非结单也非补料续跑（如回复一条 running/queued 卡说了句无关话）：
// 记录并引导，绝不 fall through 新建任务（控制通道硬不变量）。
const noticeActiveTask = async ({ msg, config, task }) => {
  await sendChatMessage({
    chatId: msg.chatId,
    card: buildCardContent({
      config,
      kind: 'notice',
      lines: [
        `**任务**：${task.summary || task.id}`,
        `**说明**：原任务当前为「${task.status}」，已收到你的回复但未新建任务。如需结束请回复「取消任务」；补充材料请在其进入待确认后回复。`,
      ],
      project: task?.project,
    }),
    logPrefix: 'active task notice',
    idempotencyKey: `${msg.messageId}-active-notice`,
  })
}

const noticePausedTask = async ({ msg, config, task }) => {
  await sendChatMessage({
    chatId: msg.chatId,
    card: buildCardContent({
      config,
      kind: 'notice',
      lines: [`**任务**：${task.summary || task.id}`, `**说明**：收到暂停表达；任务保持当前「${task.status}」状态，本条不会触发续跑，也不会创建新任务。如需取消请回复「取消任务」。`],
      project: task?.project,
    }),
    logPrefix: 'task pause notice',
    idempotencyKey: `${msg.messageId}-pause-notice`,
  })
}

const noticeAmbiguousTarget = async ({ msg, config, tasks }) => {
  await sendChatMessage({
    chatId: msg.chatId,
    card: buildCardContent({
      config,
      kind: 'notice',
      lines: [
        '**说明**：当前话题中有多条未结束任务，无法安全判断你要操作哪一条；本条未创建新任务。',
        ...tasks.slice(0, 5).map((task) => `- ${task.id}：${task.summary || task.status}`),
        '**下一步**：请回复「取消任务 <taskId>」「重开任务 <taskId>」，或直接回复目标任务的 Bot 卡片。',
      ],
    }),
    logPrefix: 'ambiguous control target notice',
    idempotencyKey: `${msg.messageId}-ambiguous-target`,
  })
}

// 误结单可逆：把一条经人工结单(superseded + externalResolution)的任务复活重排。非可重开任务显式回话，
// 绝不 fall through 新建任务。复用原 task.id → 复用原分支/worktree。
const handleReopen = async ({ msg, config, store, task, supplementText = msg.text }) => {
  const notice = (line) => sendChatMessage({
    chatId: msg.chatId,
    card: buildCardContent({ config, kind: 'notice', lines: [`**任务**：${task.summary || task.id}`, line], project: task?.project }),
    logPrefix: 'task reopen notice',
    idempotencyKey: `${msg.messageId}-reopen-notice`,
  })
  const supplementAttachments = await downloadAttachments({
    project: task.project || config.project,
    messageId: msg.messageId,
    attachments: msg.attachments,
  })
  const reopened = store.reopenClosed({
    id: task.id,
    operator: msg.senderOpenId,
    messageId: msg.messageId,
    supplementText,
    supplementAttachments,
  })
  if (!reopened) {
    await notice(`**说明**：任务当前状态为「${task.status}」，不是可重开的「人工结单」任务，未做变更，也未创建新任务。`)
    return
  }
  console.log(`[lark-gateway] 人工重开：任务 ${task.id} 复活重排（epoch=${reopened.epoch}），复用原分支/worktree`)
  await sendQueuedReceipt({
    config,
    store,
    task: reopened,
    note: '**说明**：已重开原任务，重新排队执行（复用原分支/worktree）。本条未创建新任务。',
    logPrefix: 'reopen receipt',
    idempotencyKey: `${reopened.id}-reopen-${reopened.epoch}`,
  })
  appendNotificationLog({
    config,
    project: task.project,
    row: `| ${formatDisplayTime()} | Lark Job | 进行中 | 人工重开任务：${task.summary || task.id} | real | success |`,
  })
}

// L3 显式控制指令（@应用 结单/取消任务/重开任务 <id> [残余]）：带显式 taskId、不依赖回复锚定。
// 一旦解析出合法指令即接管——目标缺失也显式回话并 return，绝不 fall through 新建任务（与续跑指令对称）。
const maybeHandleControlDirective = async ({ msg, config, store }) => {
  const directive = parseControlDirective(msg.text)
  if (!directive) return false
  const task = store.get(directive.taskId)
  if (!task) {
    await sendChatMessage({
      chatId: msg.chatId,
      card: buildCardContent({ config, kind: 'notice', lines: [`**说明**：找不到任务 ${directive.taskId}，无法${directive.action === 'reopen' ? '重开' : '结单'}。请确认任务 ID，或直接 @应用 发起新任务。`] }),
      logPrefix: 'control directive notice',
      idempotencyKey: `${msg.messageId}-ctl-directive`,
    })
    return true
  }
  if (directive.action === 'reopen') {
    await handleReopen({ msg, config, store, task, supplementText: directive.supplementText })
    return true
  }
  await handleClose({ msg, config, store, task, closureReason: directive.closureReason })
  return true
}
//   close       落终态结单（含幂等：终态任务也走 close，由 store 挡回）
//   reopen      误结单可逆：回复一条「已人工结单」的任务且表达重开意图 → 复活原任务
//   confirm     意图不明（否定/暂停/部分范围），去确认，不改任务
//   resume      活动态(parked) + 无结单信号 → 补料续跑
//   notice      其它活动态 + 无结单信号 → 记录并引导
//   ignore      回复只有确认/寒暄/协调话术，没有补料事实 → 静默消费，不改变任务、不新建
//   passthrough 不接管，放行到新任务/续跑指令老路径（仅「终态任务 + 有实质内容的非结单/非重开表达」）
// 硬不变量：target 为活动态时，绝不返回 passthrough —— 回复活动任务卡的消息永远不会 fall through 新建任务。
export const decideControlAction = ({ target, verdict, reopen = false, pause = false, nonSupplemental = false }) => {
  if (!target) return 'passthrough'
  if (pause) return 'pause'
  if (verdict.intent === 'close_with_residual') return 'close_with_residual'
  if (verdict.intent === 'close') return 'close'
  if (verdict.intent === 'unclear') return 'confirm'
  if (nonSupplemental) return 'ignore'
  if (!isControlActiveStatus(target.status)) {
    // 终态：仅「误结单可逆」——回复一条人工结单的任务并表达重开意图才复活；否则放行老路径发起新请求。
    if (reopen && isReopenableClosedTask(target)) return 'reopen'
    return 'passthrough'
  }
  if (target.status === 'waiting_confirmation' || target.status === 'blocked') return 'resume'
  return 'notice'
}

// 任务控制通道：消息一旦锚定到 Bot 卡片/原任务，就只走 结单 / 续跑补料 / 确认 / 幂等提示，
// 返回 true 表示已接管（调用方必须 return，禁止 fall through 新建任务）。
const maybeHandleControlChannel = async ({ msg, config, store }) => {
  const target = resolveControlTarget({ msg, store })
  if (!target) {
    const candidates = controlCandidates({ msg, store })
    if (candidates.length > 1) {
      await noticeAmbiguousTarget({ msg, config, tasks: candidates })
      return true
    }
    return false
  }
  const verdict = classifyClosureIntent(msg.text)
  const reopen = classifyReopenIntent(msg.text)
  const pause = classifyPauseIntent(msg.text)
  const nonSupplemental = isNonSupplementalReply(msg)
  switch (decideControlAction({ target, verdict, reopen, pause, nonSupplemental })) {
    case 'close':
      await handleClose({ msg, config, store, task: target, closureReason: verdict.closureReason })
      return true
    case 'close_with_residual': {
      await handleClose({ msg, config, store, task: target, closureReason: verdict.closureReason })
      await confirmResidualRequest({ msg, config, task: target, residualRequest: verdict.residualRequest })
      return true
    }
    case 'reopen':
      await handleReopen({ msg, config, store, task: target })
      return true
    case 'confirm':
      await confirmClosure({ msg, config, task: target, verdict })
      return true
    case 'pause':
      await noticePausedTask({ msg, config, task: target })
      return true
    case 'resume':
      await handleResume({ msg, config, store, parentTask: { taskId: target.id, task: target, explicit: false } })
      return true
    case 'notice':
      await noticeActiveTask({ msg, config, task: target })
      return true
    case 'ignore':
      console.log(`[lark-gateway] ignored non-supplemental reply ${msg.messageId} for task ${target.id}: ${msg.text || '(empty)'}`)
      return true
    default:
      return false // passthrough：终态任务 + 非结单表达，放行老路径（允许发起真正的新请求）
  }
}

// 处理一次续跑：目标缺失 / 非待确认·阻塞 / 无补充内容都**显式回话并 return**，绝不 fall through 建新任务。
const handleResume = async ({ msg, config, store, resumeDirective, parentTask }) => {
  const { taskId, task, explicit } = parentTask
  const notice = (text) =>
    sendChatMessage({
      chatId: msg.chatId,
      card: buildCardContent({ config, kind: 'notice', lines: [text] }),
      logPrefix: 'resume notice',
      idempotencyKey: `${msg.messageId}-resume-notice`,
    })
  if (!task) {
    await notice(`**说明**：找不到任务 ${taskId}，无法续跑。请确认任务 ID，或直接 @应用 发起新任务。`)
    return
  }
  if (task.status !== 'waiting_confirmation' && task.status !== 'blocked') {
    await notice(`**说明**：任务 ${task.id} 当前状态为「${task.status}」，不在待确认/阻塞状态，无法续跑。如需新处理请 @应用 单独发起。`)
    return
  }
  const supplementAttachments = await downloadAttachments({
    project: task.project || config.project,
    messageId: msg.messageId,
    attachments: msg.attachments,
  })
  const supplementText = explicit ? resumeDirective.supplementText : msg.text
  if (!String(supplementText || '').trim() && !supplementAttachments.length) {
    await notice(`**说明**：任务 ${task.id} 仍在等待补充材料，但本条没有可用的补充内容。请回复具体补充说明或附上截图。`)
    return
  }
  const resumed = store.resumeWithSupplement({ id: task.id, supplementText, supplementAttachments })
  if (!resumed) {
    // 前面已挡住 not-parked / empty；此处兜底并发竞态（状态刚被别的路径改掉）。
    await notice(`**说明**：任务 ${task.id} 续跑未生效（状态可能刚发生变化），请稍后重试或 @应用 重新发起。`)
    return
  }
  console.log(`[lark-gateway] resumed task ${resumed.id} with supplement（第 ${resumed.resumeCount} 次续跑）: ${msg.text?.slice(0, 60) || '(仅附件)'}`)
  await sendQueuedReceipt({
    config,
    store,
    task: resumed,
    note: '**说明**：已收到补充材料，续跑原任务（复用原分支/worktree）。',
    logPrefix: 'resume receipt',
    idempotencyKey: `${resumed.id}-resume-${resumed.resumeCount}`,
  })
}

const ingestWhitelistedEvent = async ({ msg, config, store }) => {
  const isBotReceiptReply = isRegisteredBotReceiptReply({ msg, store })
  const trigger = resolveMessageTrigger({ msg, config, isBotReceiptReply })
  // 开通群全量消息权限后，绝大多数消息都不含目标 mention；先做纯本地过滤，避免普通聊天触发
  // 群成员 API、引用读取、附件下载或 AI 调用。
  if (!trigger) return
  const isMember = await resolveMembership({ msg, config })
  if (!isWhitelisted({ msg, config, isMember })) return
  if (!msg.text && !msg.attachments.length && !msg.replyTo) return

  // L3 显式控制指令（结单/取消任务/重开任务 <id>）：带显式 taskId，最强意图，先于回复锚定处理。
  if (await maybeHandleControlDirective({ msg, config, store })) return

  // 任务控制通道：这条消息一旦能锚定到一条 Bot 卡片/原任务，就只能做「结单/重开/续跑补料/查状态/确认」，
  // 绝不 fall through 新建任务。结单语义（含取消/无需处理/外部完成）在通道内判定并落终态。
  // 仅「终态任务 + 非结单/非重开表达」放行到下方老路径（允许在已了结话题里发起真正的新请求）。
  if (await maybeHandleControlChannel({ msg, config, store })) return

  // waiting_confirmation / blocked 续任务：本条是对一条仍卡在待确认/阻塞的原任务的回复补料时，
  // 复用原任务续跑（append 补料 + 复用原分支/worktree），而不是新建一个孤儿任务。
  //
  // 续跑目标解析（带来源，避免误命中）：
  //   · 显式「继续任务 <id>」指令 → 按 taskId 取；
  //   · 明确回复某条消息（reply_to）→ 该消息可能是原任务消息，或机器人回执卡，两者都算；
  //   · 无 reply_to、只有会话线程根（root_id）→ 命中机器人回执或原任务消息，且任务仍待确认/阻塞才锚定
  //     （root_id 是线程根、可能是任意旧消息，故不放宽到「任意已存在的任务」）。
  const resumeDirective = parseResumeDirective(msg.text)
  const resumeTarget = resolveResumeTarget({ msg, store, resumeDirective })
  // 一旦识别出明确的续跑意图（显式指令 / 命中回执 / 命中原任务），本条就只走续跑分支并 return，
  // 绝不再 fall through 建新任务——否则「补料落不进原任务」会静默变成一条孤儿任务，原任务继续卡着。
  if (resumeTarget) {
    return await handleResume({ msg, config, store, resumeDirective, parentTask: resumeTarget })
  }

  // 同话题(thread)归并：上面的精确锚点（回执卡 / 原任务消息 / 显式指令）都没命中，但本条 @ 若落在
  // 一个「仍挂起且唯一」的话题里，它几乎必然是那条挂起任务在等的补料/结论——历史事故里正是同话题被
  // @ 两次生成平行任务、一条干完另一条僵尸催办。这里用对称存储的 threadRootId 归并：
  //   · 比既有 root_id 精确匹配更窄——不 store.get(root)（root 可能是任意旧消息，会误命中），
  //     而是要求两边 threadRootId 相等 + 目标仍 parked；
  //   · 仅当话题内恰好一条挂起任务时归并，0 条或 ≥2 条（归属不明确）一律退回新建，绝不误并。
  const threadRoot = msg.threadRootId || msg.replyTo
  const parkedSiblings = store.listParkedByThread(threadRoot, { excludeId: msg.messageId })
  if (parkedSiblings.length === 1) {
    const sibling = parkedSiblings[0]
    console.log(`[lark-gateway] 同话题归并：本条 @ 并入挂起任务 ${sibling.id}（thread=${threadRoot}）`)
    return await handleResume({ msg, config, store, parentTask: { taskId: sibling.id, task: sibling, explicit: false } })
  }

  // 合并被引用/被回复消息（真正的 bug 正文与截图多在父消息里）
  const refCtx = msg.replyTo ? await fetchReferencedContext(msg.replyTo) : null
  // 话题(thread)内的兄弟回复：@ 在话题里时，关键澄清（目标页面名 / 接口字段 / 样例）常散落在其它人的回复中，
  // 只并被引用父消息会漏掉，导致 AI 缺料误判。把同话题真人回复并进任务上下文（排除当前 @ 与已并入的父消息）。
  const threadCtx = msg.replyTo ? await fetchThreadContext(msg.replyTo, { excludeIds: [msg.messageId, msg.replyTo] }) : []
  const threadReplies = threadCtx.filter((item) => item.text).map((item) => `${item.sender ? `${item.sender}：` : ''}${item.text}`).join('\n')
  const quotedBlock = refCtx?.text
    ? `【被引用消息】\n${refCtx.text}\n\n【本条 @】${msg.text || '（无附言）'}`
    : msg.text || ''
  const mergedText = `${quotedBlock}${threadReplies ? `\n\n【话题其它回复】\n${threadReplies}` : ''}`.trim()
  const project = await resolveProject({ chatId: msg.chatId, text: mergedText })
  // 附件跟任务实际项目落盘；跨项目群任务不再错误写进 gateway 默认项目目录。
  const attachmentProject = project || config.project
  const resolvedAttachments = await downloadAttachments({
    project: attachmentProject,
    messageId: msg.messageId,
    attachments: msg.attachments,
  })
  const refAttachments = refCtx?.attachments?.length
    ? await downloadAttachments({ project: attachmentProject, messageId: msg.replyTo, attachments: refCtx.attachments })
    : []
  // 话题其它回复里的截图：同话题图片分散在不同消息，按各自 messageId 逐条下载后并入（如需求方把字段/样例只贴在图里）。
  const threadAttachments = (
    await Promise.all(
      threadCtx
        .filter((item) => item.attachments?.length)
        .map((item) => downloadAttachments({ project: attachmentProject, messageId: item.messageId, attachments: item.attachments })),
    )
  ).flat()
  const attachments = [...resolvedAttachments, ...refAttachments, ...threadAttachments]

  const worktreeExists = project ? existsSync(join(worktreesDir, project)) : false
  const requestedExecutor = parseAiExecutorDirective(msg.text)
  const aiExecutor = resolveGatewayAiExecutor({ requestedExecutor, config })

  const { type: commandType, source: commandTypeSource } = classifyCommandType(mergedText)
  const task = store.upsert({
    id: msg.messageId,
    source: 'lark',
    chatId: msg.chatId,
    messageId: msg.messageId,
    // 话题稳定身份：同话题的后续 @ 与「兄弟任务完成收尾」都靠它归并（见 listParkedByThread）。
    threadRootId: msg.threadRootId || msg.replyTo || null,
    operator: msg.senderOpenId,
    project: project || null,
    commandType,
    commandTypeSource,
    projectTitle: config.title,
    text: mergedText,
    // 卡片「任务」摘要优先展示用户本条附言，其次被引用消息首行
    summary: summarize(msg.text?.trim() ? msg.text : refCtx?.text || ''),
    attachments,
    aiExecutor,
    status: trigger === 'task_mention' ? 'received' : 'queued',
    intake: trigger === 'task_mention'
      ? {
          required: true,
          trigger: 'task_mention',
          mentionedOpenIds: msg.mentions
            .map((mention) => mention.id)
            .filter((id) => config.taskMentionOpenIds?.includes(id)),
          receivedAt: new Date().toISOString(),
        }
      : null,
    createdAt: new Date().toISOString(),
  })

  // 只 @ 负责人的消息先静默进入前置分类：确认是 bug / 明确需求后，Worker 才正式排队并发领取卡。
  // 这里不提前发卡，普通聊天被判 ignore 时群里不会出现机器人噪声。
  if (task.intake?.required) {
    console.log(`[lark-gateway] received task-mention ${task.id}，等待意图分类: ${task.summary}`)
    return
  }

  // 无 worktree（有项目号或 adhoc）统一走临时 hotfix worktree，不再发「请选择处理方式」卡片
  const note = worktreeExists
    ? undefined
    : project
      ? `**说明**：本地无 ${project} worktree，将用临时 hotfix 分支处理。`
      : '**说明**：未识别项目号（群名/正文均无），将用临时 hotfix 分支处理。'
  console.log(`[lark-gateway] queued task ${task.id} (${project || 'adhoc'})${worktreeExists ? '' : ' [temp-worktree]'}: ${task.summary}`)
  await sendQueuedReceipt({ config, store, task, note })
  appendNotificationLog({
    config,
    project: task.project,
    row: `| ${formatDisplayTime()} | Lark Job | 进行中 | 收到群任务(${project || 'adhoc'})：${task.summary} | real | success |`,
  })
}
