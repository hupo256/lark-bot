/**
 * 负责人（aven）私信 = 控制通道（从 falive 搬来，去掉仓库 profile；11-01 对话层）。
 *
 * bot 的所有私信通知（疑似 / 开始 / 结果 / 判定不处理 / 扣下的草稿）都发到 aven 和 bot 的 p2p 会话；
 * aven 在那里回一句「是」「继续」「这个要礼貌拒绝」「就这样回」是对**上一条通知**说的，不是一条新的 hotfix 工单。
 * falive 真机事故：三句私聊回复各建了一条 adhoc hotfix 任务，挂起 4h 后触发催办卡。
 *
 * 机制：p2p 消息先锚定到「bot 最近一条私信通知所属的任务」——显式「继续任务 <id>」> 回复了某条私信 > 12h 内最近一条（只认
 * 「在问他」的通知，或本条是短指代句）；锚到了就只走本通道：挂着的续跑、「就这样回」放行草稿、其它建「私聊指示」任务
 *（身份是私信消息 id，群 / 发送人 / 话题沿用被指示的群消息，回群对着原发送人说）。锚不到 → 放行老路径，独立私信任务。
 * 锚错了回「取消任务 <id>」（显式控制指令先于本通道处理）。
 */

import { downloadAttachments } from './lark-cli.mjs'
import { handleResume } from './lark-control-channel.mjs'
import { deliverHeldGroupReply, deliverNoted, isDmOriginTask } from './lark-delivery.mjs'
import { sendPrincipalNote } from './lark-group-exit.mjs'
import { parseCommandType, parseResumeDirective, textForParse } from './lark-message.mjs'
import { isOpsOwner } from './lark-ops-task.mjs'
import { getObligation, heldDraftFor } from './lark-reply-obligation.mjs'

export const DEFAULT_PRINCIPAL_REPLY_WINDOW_MS = 12 * 60 * 60 * 1000
// 「在问他」的私信通知：回这些的短句默认是对它说的。结果 / 开始类通知只在本条是短指代句时才锚（长的独立私信不粘旧通知）。
export const ASKING_RECEIPT_KINDS = new Set(['suspected', 'ask', 'ignored_after_ack', 'waiting_confirmation', 'blocked', 'held', 'wait', 'blk', 'sus'])
const PARKED = new Set(['waiting_confirmation', 'blocked'])
const DEICTIC_RE = /(重跑|再跑|再试|再测|重测|再来|重新|这个|那个|这条|那条|上面|刚才|还是|不对|不行|可以|好了|行了|搞定|继续|再看看|试一下|看一下|怎么样|是的?|做|不用|不做|拒绝|回他|回她|告诉他|就这样|照发|直接发|呢|吗|ok|OK|好的|收到|\?|？)/

export const isPrincipal = (config, openId) => isOpsOwner(config, openId)

// bot 在这个私信会话里对该任务最后一次发通知的时刻与类型（回执由出口登记，带 chatId；老回执没有 chatId 不算私信）。
export const latestDmReceipt = (task, dmChatId) => (task?.receipts || [])
  .filter((receipt) => receipt?.chatId === dmChatId)
  .reduce((best, receipt) => {
    const at = Date.parse(receipt.createdAt || '') || 0
    return at > (best?.at || 0) ? { at, kind: receipt.kind || null } : best
  }, null)

const firstLine = (text) => String(text || '').split('\n').find((line) => line.trim())?.trim() || ''
export const anchorHead = (task, max = 50) => firstLine(task?.summary || task?.text).replace(/^【[^】]*】/, '').slice(0, max)

export const isShortDeictic = (text, { maxChars = 40 } = {}) => {
  const bare = String(text || '').replace(/@[^\s@]+/g, '').replace(/\s+/g, ' ').trim()
  return bare.length > 0 && bare.length <= maxChars && DEICTIC_RE.test(bare)
}

// 锚定：显式「继续任务 <id>」→ 那条任务（via explicit，带 directive；点名的比「最近一条」强，falive 10-16 真机）；
// 回复了某条私信通知 → 那条通知的任务（via reply）；都没有 → 这个会话里 bot 最近一条通知所属的任务（via recent，窗口内，
// 且通知类型是「在问他」或本条是短指代句）。锚不到返回 null（老路径：独立私信任务）。
// 只有群里发起的任务才能被 reply / recent 锚（「指示」是告诉 bot 怎么答那条群消息）：私信里发起的任务（aven 11-02 真机：
// 「你能发邮件吗」自答后，「那你看看，现在 test、pre 两个环境运行的代码是不是一样的」被 recent 锚成对它的指示，回了一句
// 「收到，当作对「…」这条的指示处理」还把 chat id 当群名发了开始通知）不算锚，放行成独立私信任务——它的对话包本来就带最近
// 私信上下文，连不连上由分类器的 continues 判。显式「继续任务 <id>」对任何任务都认。
export const resolvePrincipalAnchor = ({ msg, store, config, now = Date.now(), windowMs = config?.principalReplyWindowMs || DEFAULT_PRINCIPAL_REPLY_WINDOW_MS }) => {
  const directive = parseResumeDirective(textForParse(msg))
  if (directive) {
    const named = store.get?.(directive.taskId) || null
    return named ? { task: named, via: 'explicit', directive } : null
  }
  const byReceipt = (id) => (id ? store.findTaskByAnyReceipt?.(id) || store.findByReceiptMessageId?.(id) || null : null)
  const replied = byReceipt(msg.replyToDirect) || byReceipt(msg.replyTo)
  if (replied) return isDmOriginTask(replied) ? null : { task: replied, via: 'reply' }
  let best = null
  for (const task of store.list()) {
    const receipt = latestDmReceipt(task, msg.chatId)
    if (receipt && receipt.at > (best?.receipt.at || 0)) best = { task, receipt }
  }
  // 最近一条通知是私信任务的：短句多半是接着它说的（交给分类器），不越过它去粘更早的群任务。
  if (!best || isDmOriginTask(best.task) || now - best.receipt.at > windowMs) return null
  if (!ASKING_RECEIPT_KINDS.has(best.receipt.kind) && !isShortDeictic(msg.text)) return null
  return { task: best.task, via: 'recent' }
}

export const decidePrincipalAction = (anchorTask) => (PARKED.has(anchorTask?.status) ? 'resume' : 'instruct')

// 放行被扣下的群回复（falive #56）：私聊「就这样回」原来被建成指示任务重跑一遍。只认以放行说法开头的短句（≤ 40 字）；
// 带了别的要求（「改成…再发」）的长句照旧走指示任务。
const RELEASE_HELD = /^就?(?:照着?|按)?(?:这样|这么|这个|原文|原样)?(?:直接|可以)?\s*(?:回|发)(?:吧|啊|呀|出去|群里|到群里)?(?=$|[，,。.!！\s]|哪|没|就|可以)/
export const isReleaseHeldReply = (text) => {
  const value = String(text || '').trim()
  return value.length > 0 && value.length <= 40 && RELEASE_HELD.test(value)
}

// 「负责人私聊指示」任务：身份是私聊消息 id，但群 / 发送人 / 话题沿用被指示的群消息，回群时对着原发送人说。
export const buildPrincipalInstructionTask = ({ msg, anchor, attachments = [], commandType = null, commandTypeSource = null, now = new Date() }) => {
  const cls = anchor.intake?.classification
  const verdict = cls ? `，之前判定 ${cls.decision}${cls.reason ? `：${cls.reason}` : ''}` : ''
  const head = anchorHead(anchor)
  const text = [
    `【aven 私聊指示】${(msg.text || '').trim() || '（附件）'}`,
    `【指示针对的群消息（任务 ${anchor.id}，当前 ${anchor.status}${verdict}）】\n${String(anchor.text || '').slice(0, 3000)}`,
  ].join('\n\n')
  return {
    id: msg.messageId,
    source: 'lark',
    chatId: anchor.chatId,
    messageId: msg.messageId,
    // 回群回复被锚的那条群消息（回复目标），而不是私信。
    replyTarget: anchor.replyTarget || { messageId: anchor.messageId, inThread: Boolean(anchor.threadRootId) },
    threadRootId: anchor.threadRootId || null,
    operator: anchor.operator,
    project: anchor.project || null,
    commandType,
    commandTypeSource,
    projectTitle: anchor.projectTitle || null,
    text,
    // 标题用被锚的群消息，不放私聊原话（falive review C1）：summary 会被出口当标题 / 回落正文，私聊原话只留在 text 里给执行器看。
    summary: head || '（附件）',
    attachments: [...attachments, ...(anchor.attachments || [])],
    aiExecutor: anchor.aiExecutor || 'claude',
    status: 'received',
    intake: { required: true, trigger: 'principal_private', mentionedOpenIds: [], lane: 'fast', notBefore: null, receivedAt: now.toISOString() },
    addressedToBot: true,
    fromPrincipal: true,
    privateOrigin: { chatId: msg.chatId, senderOpenId: msg.senderOpenId, anchorId: anchor.id, anchorHead: head },
    createdAt: now.toISOString(),
  }
}

// 负责人单独一句「已部署 / 部署好了」不是对上一条通知的指示（falive 10-28 真机）。只认整条就是这一句的短消息。
const DEPLOY_NOTICE = /^(?:pre\s*|uat\s*|online\s*|test\s*)?(?:已(?:经)?部署|部署(?:好|完)|已发部署|部署邮件已发)(?:了|啦|好了)?[。.!！~～]*$/i
export const isDeployNotice = (text) => DEPLOY_NOTICE.test(String(text || '').trim())

// 私信主通道入口（ingest 调）：返回 true = 已接管，调用方 return；false = 放行老路径（独立私信任务）。
export const maybeHandlePrincipalChannel = async ({ msg, config, store, deps = {} }) => {
  if (msg.chatType !== 'p2p' || !isPrincipal(config, msg.senderOpenId)) return false
  const note = (text, taskId = null, kind = 'private') => (deps.sendPrincipalNote || sendPrincipalNote)({ config, store, text, taskId, kind, idempotencyKey: `${msg.messageId}-pn`.slice(0, 50) })
  if (isDeployNotice(textForParse(msg))) {
    await note('好，知道了。')
    return true
  }
  const anchor = (deps.resolveAnchor || resolvePrincipalAnchor)({ msg, store, config })
  if (!anchor) return false
  const head = anchor.task.privateOrigin?.anchorHead || anchorHead(anchor.task)
  if (isReleaseHeldReply(textForParse(msg))) {
    if (!heldDraftFor(anchor.task)) {
      await note(getObligation(anchor.task)?.state === 'answered' ? `「${head}」这条已经发过更新的结论了，没有待放行的草稿。` : `「${head}」这条没有扣下的草稿，没什么可发的。`, anchor.task.id)
      return true
    }
    const sent = await (deps.deliverHeldGroupReply || deliverHeldGroupReply)({ config, store, task: anchor.task })
    console.log(`[lark-gateway] 负责人私聊（${anchor.via}）→ 放行 ${anchor.task.id} 扣下的群回复：${sent.ok ? '已发' : sent.reason}`)
    await note(sent.ok ? `已按原文回群（${head}）。` : `没发出去：${sent.reason || '找不到要发的群'}。`, anchor.task.id)
    return true
  }
  if (decidePrincipalAction(anchor.task) === 'resume') {
    console.log(`[lark-gateway] 负责人私聊（${anchor.via}）→ 续跑 ${anchor.task.id}：${(msg.text || '').slice(0, 60)}`)
    const explicit = anchor.via === 'explicit'
    await (deps.handleResume || handleResume)({ msg, config, store, resumeDirective: explicit ? anchor.directive : undefined, parentTask: { taskId: anchor.task.id, task: anchor.task, explicit } })
    return true
  }
  const attachments = await (deps.downloadAttachments || downloadAttachments)({ project: anchor.task.project || config.project, messageId: msg.messageId, attachments: msg.attachments || [] })
  const commandType = parseCommandType(textForParse(msg)) // 私聊指示只认显式前缀
  const task = store.upsert(buildPrincipalInstructionTask({ msg, anchor: anchor.task, attachments, commandType, commandTypeSource: commandType ? 'explicit' : null }))
  console.log(`[lark-gateway] 负责人私聊（${anchor.via}）→ 指示任务 ${task.id}，针对 ${anchor.task.id}（${anchor.task.status}）：${(msg.text || '').slice(0, 60)}`)
  await note(`收到，当作对「${head}」这条的指示处理；不是这条就回「取消任务 ${task.id}」。`, task.id, 'ack')
  void deliverNoted
  return true
}
