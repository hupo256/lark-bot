/**
 * Lark Gateway 的任务控制通道：消息一旦锚定到 Bot 卡片 / 原任务消息（回复回执卡、回复原 @、同话题唯一活动任务），
 * 就只走 结单 / 重开 / 续跑补料 / 确认 / 幂等提示 这几条语义，由 decideControlAction 按任务状态分流。
 * 硬不变量：锚定到活动态任务的回复绝不 fall through 新建任务——补料落不进原任务会静默变成孤儿任务、原任务继续卡着。
 * 从 lark-ingest.mjs 搬出（11-01）：摄入层已顶到 600 行预算，对话层要在其上加分类与归并，控制通道整块独立成文件。
 */

import {
  classifyClosureIntent,
  classifyPauseIntent,
  classifyReopenIntent,
  isNonSupplementalReply,
  parseControlDirective,
  textForParse,
} from './lark-message.mjs'
import { downloadAttachments } from './lark-cli.mjs'
import { askBackText, linkMessageToTask, mappedLead, resolveDirectiveTarget } from './lark-directive-target.mjs'
import { sendReply } from './lark-group-exit.mjs'
import { headline, sayFailedNotice } from './lark-human-text.mjs'
import { listOutbox, localHHMM } from './lark-outbox.mjs'
import { isOpsOwner } from './lark-ops-task.mjs'
import { isControlActiveStatus, isReopenableClosedTask } from './lark-task-store.mjs'
import { sendQueuedReceipt } from './lark-status.mjs'

// 控制通道的回话（结单 / 续跑 / 找不到任务…，11-01 起人话、不发卡）：回复本条消息；锚到了任务就带上它（回这句还能锚回任务）。
// 锚到了任务也把本条消息记在任务上（linkMessageToTask）：之后有人拿这条消息的 id 下「继续任务 / 结单」能认回这条任务。
const talk = ({ msg, config, store, task = null, text, key }) => (task?.id && linkMessageToTask({ store, taskId: task.id, messageId: msg.messageId }), sendReply({
  config,
  store,
  task: { ...(task || {}), id: task?.id || null, chatId: msg.chatId, messageId: msg.messageId, operator: msg.senderOpenId, topic: task?.topic || null, epoch: task?.epoch || 0, replyTarget: { messageId: msg.messageId, inThread: Boolean(msg.threadId) } },
  phase: 'notice',
  text,
  idempotencyKey: `${msg.messageId}-${key}`.slice(0, 50),
}))
const head = (task) => headline(task) || task?.id || '那条'

// 续跑目标解析（带来源）。返回 { taskId, task, explicit } 表示识别出续跑意图；null 表示按新任务处理。
// 只在以下情形算续跑意图，避免把线程内的全新请求误当续跑而吞掉：
//   · 显式「继续任务 <id>」指令（强意图，即使目标不存在/不可续也要进 handleResume 明确回话）；
//   · 明确回复机器人回执卡（findByReceiptMessageId 命中）；
//   · 明确回复原任务消息且该任务仍待确认/阻塞；
//   · 无 reply_to、仅线程根 root_id 命中回执或原任务消息，且该任务仍待确认/阻塞。
// 11-02 复核：回复回执也只认仍挂起的任务——锚到活动 / 终态任务的回复已由控制通道按状态分流（补充并入 / 放行带锚点），
// 放行下来再按回执抓去 handleResume 只会回一句「现在是 queued，不在等材料，续不了」把补充吞掉。
export const resolveResumeTarget = ({ msg, store, resumeDirective }) => {
  const parked = (task) => Boolean(task) && (task.status === 'waiting_confirmation' || task.status === 'blocked')
  if (resumeDirective) {
    return { taskId: resumeDirective.taskId, task: store.get(resumeDirective.taskId), explicit: true }
  }
  const direct = msg.replyToDirect
  if (direct) {
    const byReceipt = store.findByReceiptMessageId(direct)
    if (parked(byReceipt)) return { taskId: byReceipt.id, task: byReceipt, explicit: false }
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

// 隐式续跑门槛（11-04 falive 回放 P4a）：挂起任务的卡片 / 话题在群里，同事在里面互相说话、回 bot 卡片却没 @ 它
//（aven「@Arthur 麻烦在这里补信息吧」「cc @HQUCEncone」）原先一律当补料、当场把挂起任务续跑，连分类器都不过。
// 没写「继续任务 <id>」的续跑（回复挂起卡 / 原消息、话题根命中、同话题唯一挂起）只在本条像是对机器人说的时候才续：
//   resume  私信；@ 了机器人；带附件 / 链接（材料）；没 @ 任何人且是提单人 / 负责人 / bot 为这条 @ 过要材料的人
//   ignore  没 @ 机器人的寒暄 / 抄送（cc / 收到 / 好的 / 谢谢 / 表情）→ 静默，不续跑、不回话、不建任务
//   pass    @ 了别人没 @ 机器人、或旁人没 @ 谁说的话 → 不续跑，放行给分类器（带锚点；是补料的分类器判 continues 照样并进挂起任务）
const SOCIAL_WORD = '(?:cc|抄送|\\+1|收到|好的?|好嘞|谢谢|多谢|感谢|辛苦|了解|明白|知道|ok|okay|嗯+|哦+|\\[[^\\]\\s]{1,6}\\]|[\\p{Extended_Pictographic}\\u200d\\ufe0f]+)'
const SOCIAL_CHATTER_RE = new RegExp(`^(?:${SOCIAL_WORD}[吧啊呀呢的了啦]*[\\s，,。.!！~～、]*)+$`, 'iu')
const MATERIAL_LINK_RE = /https?:\/\/\S+/i
export const isSocialChatter = (msg) => {
  if ((msg?.attachments || []).length) return false
  const bare = textForParse(msg).trim()
  return isNonSupplementalReply({ text: bare }) || SOCIAL_CHATTER_RE.test(bare)
}
// bot 为这条任务在群里 @ 过的人（发件簿，blocked_ask「需要你们帮忙」等）：就是任务在等的人。
const askedOpenIds = (task) => listOutbox({ chatId: task?.chatId }).filter((entry) => entry.taskId === task.id && !entry.gated).flatMap((entry) => entry.mentions || [])
export const implicitResumeVerdict = ({ msg, config, task }) => {
  if (msg.chatType === 'p2p') return 'resume'
  const botIds = [config?.botOpenId, config?.botAppId].filter(Boolean)
  const mentions = msg.mentions || []
  if (mentions.some((mention) => botIds.includes(mention?.id))) return 'resume'
  if ((msg.attachments || []).length || MATERIAL_LINK_RE.test(msg.text || '')) return 'resume'
  if (isSocialChatter(msg)) return 'ignore'
  if (mentions.length) return 'pass'
  const sender = msg.senderOpenId
  return sender === task?.operator || isOpsOwner(config, sender) || askedOpenIds(task).includes(sender) ? 'resume' : 'pass'
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

// 结单回群文案（按 closureReason 分流；取消类绝不写「已完成」）。负责人私信里关掉挂起任务（lark-principal-channel，R1）也用它。
const CLOSE_RECEIPT_COPY = {
  cancelled: (title) => `好，「${title}」取消了，不再做。`,
  no_longer_needed: (title) => `好，「${title}」不用做了，已关掉。`,
  completed_elsewhere: (title) => `好，「${title}」按已经处理掉结了。`,
}
export const closeReceiptText = (closureReason, title) => (CLOSE_RECEIPT_COPY[closureReason] || CLOSE_RECEIPT_COPY.completed_elsewhere)(title)

// 结单：把关联任务落终态并回执。已是终态则幂等回「已结束」，绝不重复操作、绝不新建任务。
const handleClose = async ({ msg, config, store, task, closureReason, lead = '' }) => {
  const outcome = store.closeAsExternallyResolved({
    id: task.id,
    operator: msg.senderOpenId,
    messageId: msg.messageId,
    closureReason,
  })
  if (!outcome) {
    await talk({ msg, config, store, task, key: 'close', text: `${lead}「${head(task)}」早就结束了，不用再结单；这句我没当成新任务。` })
    return null
  }
  const reason = outcome.closureReason
  console.log(`[lark-gateway] 人工结单：任务 ${task.id} 由 ${outcome.previousStatus} -> superseded（${reason}），本条不新建任务`)
  await talk({ msg, config, store, task, key: 'close', text: `${lead}${CLOSE_RECEIPT_COPY[reason](head(task))}` })
  return outcome
}

const confirmResidualRequest = async ({ msg, config, store, task, residualRequest }) => {
  await talk({ msg, config, store, task, key: 'residual', text: `「${head(task)}」结了。你后半段说的「${residualRequest}」我没单独开任务，要做的话另发一条 @我。` })
}

// 意图不明确（否定/暂停/部分范围/转折/弱结单信号）：不结单、不改任务、不新建，回一句让用户一键裁决。
// 轻量仲裁（不引 AI）：把猜测的 closureReason 与**带真实 taskId 的一键指令**摆出来，让人点一下即落态或补料续跑。
const CLOSURE_REASON_LABEL = {
  cancelled: '取消该任务',
  no_longer_needed: '不再需要处理',
  completed_elsewhere: '已在别处完成',
}
const confirmClosure = async ({ msg, config, store, task, verdict }) => {
  const guess = CLOSURE_REASON_LABEL[verdict?.closureReason] || '结束该任务'
  const text = verdict?.scope === 'partial'
    // 夹带「另一部分要继续」：先分清整单关还是只取消一部分，避免误伤未说结单的残余段。
    ? `你是要结束整个「${head(task)}」，还是只取消其中一部分？整个结束回「取消任务 ${task.id}」；只处理一部分直接补充说明就行。`
    // 弱信号/否定/暂停等：给出猜测方向 + 一键指令，人点一下即结单，或补充说明继续。
    : `这句像是想「${guess}」，我拿不准，先没动「${head(task)}」。确认结束回「取消任务 ${task.id}」；要继续直接补充说明。`
  await talk({ msg, config, store, task, key: 'close-confirm', text })
}

// 活动任务被回复、但既非结单也非补料续跑（如回复一条 running/queued 卡说了句无关话）：
// 记录并引导，绝不 fall through 新建任务（控制通道硬不变量）。
// failed 也在控制活动态（可结单、禁新建），但它不是「还在处理」（11-03 静态 review R13）：如实说没做成、已告诉负责人。
const noticeActiveTask = async ({ msg, config, store, task }) => {
  const text = task.status === 'failed'
    ? sayFailedNotice({ task })
    : `「${head(task)}」还在处理中，这句我记下了、没当成新任务。要停回「取消任务 ${task.id}」。`
  await talk({ msg, config, store, task, key: 'active', text })
}

const noticePausedTask = async ({ msg, config, store, task }) => {
  await talk({ msg, config, store, task, key: 'pause', text: `好，「${head(task)}」先搁着，我不动；要取消回「取消任务 ${task.id}」。` })
}

const noticeAmbiguousTarget = async ({ msg, config, store, tasks }) => {
  const text = [
    `这个话题里有 ${tasks.length} 条没结束的任务，我拿不准你说的是哪条，这句先没当成新任务：`,
    ...tasks.slice(0, 5).map((task) => `- ${task.id}：${head(task)}`),
    '回「取消任务 <id>」「重开任务 <id>」，或直接回复对应那条。',
  ].join('\n')
  await talk({ msg, config, store, key: 'ambiguous', text })
}

// 误结单可逆：把一条经人工结单(superseded + externalResolution)的任务复活重排。非可重开任务显式回话，
// 绝不 fall through 新建任务。复用原 task.id → 复用原分支/worktree。
const handleReopen = async ({ msg, config, store, task, supplementText = msg.text, lead = '' }) => {
  const notice = (text) => talk({ msg, config, store, task, key: 'reopen', text: `${lead}${text}` })
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
    await notice(`「${head(task)}」现在是「${task.status}」，不是我结掉的那种，重开不了；这句没当成新任务。`)
    return
  }
  console.log(`[lark-gateway] 人工重开：任务 ${task.id} 复活重排（epoch=${reopened.epoch}），复用原分支/worktree`)
  await notice(`好，「${head(task)}」重开了，接着原来的分支做。`)
  await sendQueuedReceipt({ config, store, task: reopened })
}

// L3 显式控制指令（@应用 结单/取消任务/重开任务 <id> [残余]）：带显式 taskId、不依赖回复锚定。
// 一旦解析出合法指令即接管——目标缺失也显式回话并 return，绝不 fall through 新建任务（与续跑指令对称）。
export const maybeHandleControlDirective = async ({ msg, config, store }) => {
  const directive = parseControlDirective(msg.text)
  if (!directive) return false
  // id 在本仓没有 / 已并进别的任务（照着 falive 卡片回的口令、抄错一位）：唯一对得上的按它做并说清认成了哪条，否则列候选问回去。
  const found = resolveDirectiveTarget({ msg, config, store, taskId: directive.taskId, action: directive.action, supplementText: directive.supplementText })
  const task = found.task
  if (!task) {
    await talk({ msg, config, store, key: 'ctl', text: askBackText({ taskId: directive.taskId, action: directive.action, candidates: found.candidates }) })
    return true
  }
  const lead = found.via === 'exact' ? '' : mappedLead({ taskId: directive.taskId, task, via: found.via })
  if (lead) console.log(`[lark-gateway] 控制指令点名 ${directive.taskId}，按 ${found.via} 认成 ${task.id}`)
  if (directive.action === 'reopen') {
    await handleReopen({ msg, config, store, task, supplementText: directive.supplementText, lead })
    return true
  }
  await handleClose({ msg, config, store, task, closureReason: directive.closureReason, lead })
  return true
}
//   close       落终态结单（含幂等：终态任务也走 close，由 store 挡回）
//   reopen      误结单可逆：回复一条「已人工结单」的任务且表达重开意图 → 复活原任务
//   confirm     意图不明（否定/暂停/部分范围），去确认，不改任务
//   resume      活动态(parked) + 无结单信号 → 补料续跑
//   supplement  目标还没分类（received，或分类中的 running、intake.required）→ 并进原任务一起分类，不回第二句（调用方并入；
//               分类中的并入后标 intake.reclassify，这轮结果作废重分类一次，R7）
//   notice      其它活动态 + 只是问进度 / 指代短句（「怎么样了」「这个也看下」）→ 回「还在处理中」（failed 回「上次没做成」，R13）
//   ignore      回复只有确认/寒暄/协调话术，没有补料事实 → 静默消费，不改变任务、不新建
//   passthrough 不接管，放行到新任务/续跑指令老路径：终态任务 + 有实质内容的非结单/非重开表达；
//               11-02 复核起也含 queued / running / verifying / failed + 有实质内容（substantive）——回复「收到」的人多半在补内容，
//               原先一律 notice「这句我记下了」其实把内容丢了。放行时带锚点，由分类器判 continues，并入在跑的那条（跑完再跑一轮）
//               或开新单（lib/lark-routes-intake.mjs）。
// 硬不变量：target 为活动态且本条没实质内容时，绝不返回 passthrough；活动态有实质内容的放行必带 anchorTaskId（不会变孤儿任务）。
export const decideControlAction = ({ target, verdict, reopen = false, pause = false, nonSupplemental = false, substantive = false }) => {
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
  if (target.status === 'received' || target.intake?.required === true) return 'supplement'
  return substantive ? 'passthrough' : 'notice'
}

// 只是问进度 / 指代一句（没附件、去掉 @ 和标点 ≤ 6 字、还带进度 / 指代词）：没有可并入的内容，回「还在处理中」就够了。
// 别的一律算有实质内容（substantive），放行给分类器——宁可多分类一次，不吞人家补的内容。
const PROGRESS_PING_RE = /(在吗|进度|怎么样|好了吗|完了吗|有进展|搞定|多久|这个|那个|这条|那条|看看|看下|看一下|再看|催)/
export const isProgressPing = ({ text, attachments = [] } = {}) => {
  if (attachments.length > 0) return false
  const bare = String(text || '').replace(/@[^\s@]+/g, '').replace(/[\s，,。.!！?？~～]+/g, '')
  return bare.length > 0 && bare.length <= 6 && PROGRESS_PING_RE.test(bare)
}

// 任务控制通道：消息一旦锚定到 Bot 卡片/原任务，就只走 结单 / 续跑补料 / 确认 / 幂等提示。
// 返回 { handled, anchorTaskId, supplement? }：handled=true 表示已接管（调用方必须 return，禁止 fall through 新建任务）；
// anchorTaskId 是解析到的锚点任务 id（没锚到为 null），passthrough 放行时也带回去，让后面的对话层知道本条落在哪条任务的话题里；
// supplement=true：锚到的任务还没分类，调用方把本条当话题补充并进去（lark-intake-ack mergeThreadSupplement，目标就是 anchorTaskId）。
export const maybeHandleControlChannel = async ({ msg, config, store }) => {
  const target = resolveControlTarget({ msg, store })
  if (!target) {
    const candidates = controlCandidates({ msg, store })
    if (candidates.length > 1) {
      await noticeAmbiguousTarget({ msg, config, store, tasks: candidates })
      return { handled: true, anchorTaskId: null }
    }
    return { handled: false, anchorTaskId: null }
  }
  const handled = { handled: true, anchorTaskId: target.id }
  const verdict = classifyClosureIntent(msg.text)
  const reopen = classifyReopenIntent(msg.text)
  const pause = classifyPauseIntent(msg.text)
  const nonSupplemental = isNonSupplementalReply(msg)
  const substantive = !isProgressPing(msg)
  switch (decideControlAction({ target, verdict, reopen, pause, nonSupplemental, substantive })) {
    case 'close':
      await handleClose({ msg, config, store, task: target, closureReason: verdict.closureReason })
      return handled
    case 'close_with_residual': {
      await handleClose({ msg, config, store, task: target, closureReason: verdict.closureReason })
      await confirmResidualRequest({ msg, config, store, task: target, residualRequest: verdict.residualRequest })
      return handled
    }
    case 'reopen':
      await handleReopen({ msg, config, store, task: target })
      return handled
    case 'confirm':
      await confirmClosure({ msg, config, store, task: target, verdict })
      return handled
    case 'pause':
      await noticePausedTask({ msg, config, store, task: target })
      return handled
    case 'resume': {
      const gate = implicitResumeVerdict({ msg, config, task: target })
      if (gate !== 'resume') {
        console.log(`[lark-gateway] ${msg.messageId} 回的是挂起任务 ${target.id} 但不像对机器人说的（${gate === 'ignore' ? '寒暄 / 抄送，静默' : '@ 了别人或旁人搭话，交给分类'}），不续跑`)
        return gate === 'ignore' ? handled : { handled: false, anchorTaskId: target.id }
      }
      await handleResume({ msg, config, store, parentTask: { taskId: target.id, task: target, explicit: false } })
      return handled
    }
    case 'notice':
      await noticeActiveTask({ msg, config, store, task: target })
      return handled
    case 'ignore':
      console.log(`[lark-gateway] ignored non-supplemental reply ${msg.messageId} for task ${target.id}: ${msg.text || '(empty)'}`)
      return handled
    case 'supplement':
      return { handled: false, anchorTaskId: target.id, supplement: true }
    default:
      return { handled: false, anchorTaskId: target.id } // passthrough：终态任务 / 在跑任务 + 有实质内容的非结单表达，放行老路径带锚点
  }
}

// 处理一次续跑：目标缺失 / 非待确认·阻塞 / 无补充内容都**显式回话并 return**，绝不 fall through 建新任务。
export const handleResume = async ({ msg, config, store, resumeDirective, parentTask, lead = '' }) => {
  const { taskId, task, explicit } = parentTask
  const notice = (text) => talk({ msg, config, store, task, key: 'resume', text: `${lead}${text}` })
  // 显式「继续任务 <id>」点名的 id 不在库里 / 已并走：按上下文认（lark-directive-target），认不出列候选问回去，不再只回「续不了」。
  if (explicit && !lead) {
    const found = resolveDirectiveTarget({ msg, config, store, taskId, action: 'resume', supplementText: resumeDirective?.supplementText || '' })
    if (!found.task) {
      await talk({ msg, config, store, key: 'resume', text: askBackText({ taskId, action: 'resume', candidates: found.candidates }) })
      return
    }
    if (found.via !== 'exact') {
      console.log(`[lark-gateway] 续跑指令点名 ${taskId}，按 ${found.via} 认成 ${found.task.id}`)
      return handleResume({ msg, config, store, resumeDirective, parentTask: { taskId: found.task.id, task: found.task, explicit }, lead: mappedLead({ taskId, task: found.task, via: found.via }) })
    }
  }
  if (!task) {
    await notice(`没找到任务 ${taskId}，续不了。看下 id，或直接 @我 重新发。`)
    return
  }
  // 负责人点名续一条没做成的任务（failed）= 重跑，补充一并带上（store.retry 有人工重试上限）。
  if (task.status === 'failed' && explicit && isOpsOwner(config, msg.senderOpenId)) return retryFailed({ msg, config, store, task, supplementText: resumeDirective?.supplementText || '', notice })
  if (task.status !== 'waiting_confirmation' && task.status !== 'blocked') {
    await notice(`「${head(task)}」现在是「${task.status}」，不在等材料，续不了；要新处理直接 @我 另说。`)
    return
  }
  const supplementAttachments = await downloadAttachments({
    project: task.project || config.project,
    messageId: msg.messageId,
    attachments: msg.attachments,
  })
  // 负责人单发「继续任务 <id>」= 放行（falive 10-21：疑似单回「继续任务 <id>」不带「做」被当成没补充内容）。
  const principal = isOpsOwner(config, msg.senderOpenId)
  const principalGoAhead = explicit && principal && !String(resumeDirective?.supplementText || '').trim()
  const supplementText = principalGoAhead ? '负责人放行：按原消息开工' : explicit ? resumeDirective.supplementText : msg.text
  if (!String(supplementText || '').trim() && !supplementAttachments.length) {
    await notice(`「${head(task)}」还在等材料，但这条没看到可用的补充。回我具体说明或截图就行。`)
    return
  }
  // 疑似单（分类拿不准、等负责人放行）只有负责人能放行（falive review C3）：别人的回复只追加正文，任务继续等。
  if (task.suspected && !principal) {
    store.upsert({
      ...task,
      text: `${task.text || ''}\n\n【补充 ${localHHMM()}，待负责人放行】${String(supplementText || '').trim() || '（附件）'}`.trim(),
      attachments: [...(task.attachments || []), ...supplementAttachments],
      suspectedSupplements: [...(task.suspectedSupplements || []), { operator: msg.senderOpenId, at: new Date().toISOString() }].slice(-20),
    })
    await notice('记下了，这条还得 aven 确认一下再做。')
    return
  }
  const approvalsBefore = (task.scopeApprovals || []).length
  const resumed = store.resumeWithSupplement({ id: task.id, supplementText, supplementAttachments, operator: msg.senderOpenId })
  if (!resumed) {
    // 前面已挡住 not-parked / empty；此处兜底并发竞态（状态刚被别的路径改掉）。
    await notice(`「${head(task)}」刚才状态变了，这次没续上；稍后再回我一句，或直接 @我 重新发。`)
    return
  }
  console.log(`[lark-gateway] resumed task ${resumed.id} with supplement（第 ${resumed.resumeCount} 次续跑）: ${msg.text?.slice(0, 60) || '(仅附件)'}`)
  const widened = (resumed.scopeApprovals || []).length > approvalsBefore
  await notice(widened
    ? `好，确认可以改 ${resumed.scopeApprovals.at(-1).paths.join('、') || '这些'}，接着做「${head(task)}」。`
    : `好，收到补充，接着做「${head(task)}」。`)
  await sendQueuedReceipt({ config, store, task: resumed })
}

const retryFailed = async ({ msg, config, store, task, supplementText, notice }) => {
  const retried = store.retry(task.id)
  if (!retried?.id) {
    // retry 只在到了人工重试上限时带 reason；null 是状态刚被别的路径改掉（前面刚判过 failed）
    await notice(`「${head(task)}」重跑不了：${retried ? retried.reason : '状态刚变了'}。`)
    return
  }
  const supplement = String(supplementText || '').trim()
  if (supplement) {
    retried.text = `${retried.text || ''}\n\n【补料】\n${supplement}`.trim()
    store.upsert(retried)
  }
  console.log(`[lark-gateway] 负责人点名续跑没做成的任务 ${task.id} → 重跑（第 ${retried.retryCount} 次人工重试）`)
  await notice(`好，「${head(task)}」上次没做成，${supplement ? '带上你这句' : ''}重跑一遍。`)
  await sendQueuedReceipt({ config, store, task: retried })
}
