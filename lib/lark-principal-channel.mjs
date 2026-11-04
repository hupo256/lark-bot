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
import { closeReceiptText, handleResume } from './lark-control-channel.mjs'
import { deliverHeldGroupReply, deliverNoted, isDmOriginTask } from './lark-delivery.mjs'
import { linkMessageToTask } from './lark-directive-target.mjs'
import { sendPrincipalNote } from './lark-group-exit.mjs'
import { classifyClosureIntent, parseCommandType, parseResumeDirective, textForParse } from './lark-message.mjs'
import { isOpsOwner } from './lark-ops-task.mjs'
import { OVERDUE_AFTER_MS, getObligation, heldDraftFor } from './lark-reply-obligation.mjs'

export const DEFAULT_PRINCIPAL_REPLY_WINDOW_MS = 12 * 60 * 60 * 1000
// 「在问他」的私信通知：回这些的短句默认是对它说的。结果 / 开始类通知只在本条是短指代句时才锚（长的独立私信不粘旧通知）。
export const ASKING_RECEIPT_KINDS = new Set(['suspected', 'ask', 'ignored_after_ack', 'waiting_confirmation', 'blocked', 'held', 'wait', 'blk', 'sus'])
const PARKED = new Set(['waiting_confirmation', 'blocked'])
// 指代上一条通知的说法：含有这些词就算（11-02 真机收窄：原来「是的?|做|吗|呢|?」只要出现就算，
// 「现在 pre 环境跑的是哪个版本」因为带「是」被锚到群里一条实测任务当成指示、答案发去了群里）。
// 「是 / 做 / 可以 / 好了…」这类单字词只认整句就是它（加语气词 / 标点）。
const DEICTIC_RE = /(重跑|再跑|再试|再测|重测|再来|重新|这个|那个|这条|那条|上面|刚才|还是|不对|不行|搞定|继续|再看看|试一下|看一下|怎么样|不用|不做|拒绝|回他|回她|告诉他|就这样|照发|直接发|好的|收到)/
const DEICTIC_WHOLE_RE = /^(?:是|是的|对|对的|做|做吧|可以|好|好了|行|行了|嗯|ok|OK|不)[吧啊呀呢的了]?[。.!！~～]?$/

export const isPrincipal = (config, openId) => isOpsOwner(config, openId)

// bot 在这个私信会话里对该任务最后一次发通知的时刻与类型（回执由出口登记，带 chatId；老回执没有 chatId 不算私信）。
// 11-02 复核：私信通知按负责人 open_id（ou_）发、回执也记 ou_，而他回过来的 p2p 消息 chat_id 是 oc_（真机：p2p 任务 chatId 全是 oc_，
// 回执 oc_ / ou_ 各半），只比 msg.chatId 永远对不上——疑似 / 扣下 / 判不处理之后回一句「是」「继续」都落成了独立私信任务，
// 只有引用回复和显式「继续任务 <id>」能锚。回执的 chatId 等于本次私信的 chat_id、或等于负责人 open_id 的都算这个会话。
export const latestDmReceipt = (task, dmChatId, principalOpenId = null) => (task?.receipts || [])
  .filter((receipt) => [dmChatId, principalOpenId].filter(Boolean).includes(receipt?.chatId))
  .reduce((best, receipt) => {
    const at = Date.parse(receipt.createdAt || '') || 0
    return at > (best?.at || 0) ? { at, kind: receipt.kind || null } : best
  }, null)

const firstLine = (text) => String(text || '').split('\n').find((line) => line.trim())?.trim() || ''
export const anchorHead = (task, max = 50) => firstLine(task?.summary || task?.text).replace(/^【[^】]*】/, '').slice(0, max)

export const isShortDeictic = (text, { maxChars = 40 } = {}) => {
  const bare = String(text || '').replace(/@[^\s@]+/g, '').replace(/\s+/g, ' ').trim()
  return bare.length > 0 && bare.length <= maxChars && (DEICTIC_RE.test(bare) || DEICTIC_WHOLE_RE.test(bare))
}

// 点名的那条已并进别的单（superseded + supersededBy）：认并入的那单（最多跟 5 层）。b3 ep-1021-d4e64d：aven「继续任务 <已并入的 id> 确认扩大范围」
// 锚在 superseded 那条上，走成了「指示任务」再并回去续跑，确认扩大范围没落成批准（handleResume 才认），续跑又按原契约拦。
const followMerged = (store, task) => {
  let current = task
  for (let hop = 0; hop < 5 && current?.status === 'superseded' && current.supersededBy; hop += 1) {
    const next = store.get?.(current.supersededBy) || null
    if (!next) break
    current = next
  }
  return current
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
    const named = followMerged(store, store.get?.(directive.taskId) || null)
    return named ? { task: named, via: 'explicit', directive } : null
  }
  const byReceipt = (id) => (id ? store.findTaskByAnyReceipt?.(id) || store.findByReceiptMessageId?.(id) || null : null)
  const replied = byReceipt(msg.replyToDirect) || byReceipt(msg.replyTo)
  if (replied) return isDmOriginTask(replied) ? null : { task: replied, via: 'reply' }
  let best = null
  for (const task of store.list()) {
    // 11-02 复核：私信通知的回执记的是 config.notifyOpenId（ou_），本条 p2p 消息的 chatId 是 oc_，两个都认（见 latestDmReceipt）。
    const receipt = latestDmReceipt(task, msg.chatId, config?.notifyOpenId)
    if (receipt && receipt.at > (best?.receipt.at || 0)) best = { task, receipt }
  }
  // 最近一条通知是私信任务的：短句多半是接着它说的（交给分类器），不越过它去粘更早的群任务。
  if (!best || isDmOriginTask(best.task) || now - best.receipt.at > windowMs) return null
  if (!ASKING_RECEIPT_KINDS.has(best.receipt.kind) && !isShortDeictic(msg.text)) return null
  return { task: best.task, via: 'recent' }
}

// 最近有扣下草稿的任务（窗口内给负责人发过私信的优先按回执时间，其次按草稿时间）；没有返回 null。
export const findHeldDraftTask = ({ store, config, msg, excludeId = null, now = Date.now(), windowMs = config?.principalReplyWindowMs || DEFAULT_PRINCIPAL_REPLY_WINDOW_MS }) => {
  let best = null
  for (const task of store.list?.() || []) {
    if (task.id === excludeId) continue
    const draft = heldDraftFor(task)
    if (!draft) continue
    const receipt = latestDmReceipt(task, msg?.chatId, config?.notifyOpenId)
    const at = receipt?.at || Date.parse(draft.at || '') || 0
    if (now - at > windowMs) continue
    if (at > (best?.at || 0)) best = { task, at }
  }
  return best?.task || null
}

export const decidePrincipalAction = (anchorTask) => (PARKED.has(anchorTask?.status) ? 'resume' : 'instruct')

// 对挂起任务（疑似 / 追问 / blocked / waiting_confirmation）的否定回复（11-03 静态 review R1）：bot 私信「是 → 继续任务 id 做；不是 → 取消任务 id」，
// aven 回「不是」原先被当成补料放行开跑（群里控制通道有 classifyClosureIntent 分流，私信主通道没有）。
// 按逗号 / 句号切成子句：首句是否定头词才看后半句——
//   · 后半句每一句都是归属说法（「这是后端的」「归 App」「找运维」「后端在改」「不归我们」）或本身就是不做（「算了」）→ decline；没有后半句的整句否定也算；
//   · 否则头词是「不 / 不是 / 不对」（纠正的口头禅）且后半句带补料信号（应该是 / 这个是 / 用 / 改 / 要 / 找 X 要 / 数字字母…）→ null，补料续跑；
//   · 其余（「不做，先放着」「不是，没必要」「不归我们，找 William 要账号」）→ unclear：问一句不动，不当补料开跑。
// 11-03 合入前 review：「不对，应该是 508 账号」「不是，这个是 B 页面」「不，找 William 要账号」是补料，归属方必须整句就是（后端 / 服务端 / App…），
// 「找 William」「找后端要账号」不是归属。11-03 第二次 review：「不做，这是后端的」「先不做」「这个不归我们，找后端」「不用了，后端在改」原来返回 null 开跑。
// 首句不是否定头词的交给结单语族（classifyClosureIntent），在这里最多算 unclear（补料里常带「不用管验证码」「取消那个弹窗」「不用改了，复测一下」）。
// null：按补料续跑。
const DECLINE_OWNER = '(?:后端|服务端|app|客户端|原生|运维|ios|安卓|android)'
const PARTICLE = '[吧啊呀呢的了]*'
const THIS = '(?:(?:这|那)(?:个|条|事)?)?'
const OWNER_CLAUSE_RE = new RegExp(`^${THIS}(?:是|归|属于|应该是|应该归|得找|找|让|交给)?\\s*${DECLINE_OWNER}\\s*(?:的|那边|那边的)?(?:事|问题|活|bug|锅)?(?:(?:已经|正)?在(?:改|修|弄|处理|跟)|会(?:改|修)|来(?:改|修))?${PARTICLE}$`, 'i')
const NOT_MINE_HEAD_RE = new RegExp(`^${THIS}(?:不|不是|不对|不是我的|不是我们的|不归我们|不归我|取消|取消掉|撤销)${PARTICLE}$`)
const NO_NEED_HEAD_RE = new RegExp(`^${THIS}(?:不用|不用了|不用做|不用做了|不做|不做了|先不做|先不做了|先不用|不要|不搞了|不弄了|别做了|别弄了|算了|不管了)${PARTICLE}$`)
const CORRECTION_HEAD_RE = new RegExp(`^(?:不|不是|不对)${PARTICLE}$`)
const SUPPLEMENT_RE = /应该|是|用|换|改|找.+要|加|按|看|写|把|给|传|带|直接|页面|账号|[0-9a-z]/i
const isDeclineClause = (clause) => OWNER_CLAUSE_RE.test(clause) || (NOT_MINE_HEAD_RE.test(clause) && !CORRECTION_HEAD_RE.test(clause)) || NO_NEED_HEAD_RE.test(clause)
export const classifyPrincipalReply = (text) => {
  const value = String(text || '').replace(/@[^\s@]+/g, '').trim()
  if (!value) return null
  const [head, ...tail] = value.split(/[，,；;。.!！~～\n]+/).map((clause) => clause.trim()).filter(Boolean)
  const closureReason = NOT_MINE_HEAD_RE.test(head || '') ? 'cancelled' : NO_NEED_HEAD_RE.test(head || '') ? 'no_longer_needed' : null
  if (closureReason) {
    if (tail.every(isDeclineClause)) return { kind: 'decline', closureReason }
    if (CORRECTION_HEAD_RE.test(head) && tail.some((clause) => SUPPLEMENT_RE.test(clause))) return null
    return { kind: 'unclear', closureReason }
  }
  const verdict = classifyClosureIntent(value)
  return verdict.closureReason ? { kind: 'unclear', closureReason: verdict.closureReason } : null
}

// 负责人原话是拒绝 / 归属（不做、不归我们、这是后端的…）：私聊指示判 ignore 时据此结锚点（lark-routes-intake）。
export const isPrincipalDecline = (text) => classifyPrincipalReply(text)?.kind === 'decline'

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
    chatName: anchor.chatName || null,
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

// 对在飞任务（还在分类 / 排队 / 在跑 / 在验）只说一句放行（「继续任务 <id> [做]」「继续」「做吧」「好」），没带新内容、没附件：
// 已经在做了，不另建「私聊指示」任务（falive 回放 b2 ep-1021-193c03：aven 回 falive 卡住卡片的「继续任务 X 做」到了 lark-bot 时 X 正在跑，
// 原先建指示任务 → 分类 continues → 并进在跑的 X（rerun_after_done）→ X 跑完发了结论又带着这句空补充重跑一轮，3 分钟后群里再发一遍几乎一样的结论）。
// 只认整句就是放行词；「重跑 / 再测一下」「用 508 号」这类带要求的照旧建指示任务（跑完带补充再跑一轮是对的）。
// 认领 / 更新超过 4 小时的不挡（sayOverdue 说「要重跑回『继续任务 id』」——可能是跑丢了，要的就是重跑）。
const BARE_GO_AHEAD_RE = /^(?:继续|继续做|继续跑|接着做|接着|做|做吧|开工|开始|开始做|是|是的|对|可以|好|好的|行|嗯|ok)?[吧啊呀呢的了]*[。.!！~～]*$/i
const IN_FLIGHT = new Set(['received', 'queued', 'running', 'verifying'])
export const isBareGoAhead = (text) => BARE_GO_AHEAD_RE.test(String(text || '').replace(/@[^\s@]+/g, '').replace(/\s+/g, '').trim())
export const isFreshInFlight = (task, now = Date.now(), staleMs = OVERDUE_AFTER_MS) => {
  if (!IN_FLIGHT.has(task?.status)) return false
  const since = Date.parse(task.claimedAt || task.updatedAt || task.createdAt || '')
  return Number.isFinite(since) && now - since < staleMs
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
  let anchor = (deps.resolveAnchor || resolvePrincipalAnchor)({ msg, store, config })
  if (!anchor) return false
  // 这句是对锚点任务说的：记在任务上，之后拿这条消息的 id 下「继续任务 / 结单」能认回来（lark-directive-target，11-04 ep-1021-193c03）。
  linkMessageToTask({ store, taskId: anchor.task.id, messageId: msg.messageId })
  let head = anchor.task.privateOrigin?.anchorHead || anchorHead(anchor.task)
  if (isReleaseHeldReply(textForParse(msg))) {
    // 「就这样回」说的是被扣下的那份草稿：最近一条通知的任务没有草稿时，改找最近有草稿的那条（11-03 falive 回放 10-20：aven 放行 13:00
    // lives 卡的草稿，锚到了刚私信过的 preload 任务，回「没有草稿」）。
    // 只在「最近一条」锚的、且锚点从没扣过草稿时改找（11-03 合入前 review）：引用回复 / 显式点名的就是说那条；锚点扣过草稿（heldAt：已放行 / 已清 /
    // 之后发了更新的结论），「没草稿」是对的——改找会把别的任务的草稿发进别的群，不可撤回。
    // 锚点正常答过（answered、没扣过）不挡（11-03 第二次 review）：13:00 Y 扣下草稿、13:05 私信 X「替你答了」、13:06「就这样回」说的是 Y。
    if (!heldDraftFor(anchor.task) && anchor.via === 'recent' && !getObligation(anchor.task)?.heldAt) {
      const alt = findHeldDraftTask({ store, config, msg, excludeId: anchor.task.id })
      if (alt) {
        anchor = { task: alt, via: 'held' }
        head = alt.privateOrigin?.anchorHead || anchorHead(alt)
      }
    }
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
    const explicit = anchor.via === 'explicit'
    // 否定 / 取消 → 关掉（显式「继续任务 id」看它后面的补充；单发「继续任务 id」是放行）；拿不准 → 问一句不动（R1）。
    const reply = classifyPrincipalReply(explicit ? anchor.directive?.supplementText : textForParse(msg))
    if (reply?.kind === 'decline') {
      const closed = store.closeAsExternallyResolved({ id: anchor.task.id, operator: msg.senderOpenId, messageId: msg.messageId, closureReason: reply.closureReason })
      console.log(`[lark-gateway] 负责人私聊（${anchor.via}）→ 关掉 ${anchor.task.id}（${closed ? `${closed.previousStatus} -> superseded，${closed.closureReason}` : '状态已变，没关上'}）：${(msg.text || '').slice(0, 60)}`)
      await note(closed ? closeReceiptText(closed.closureReason, head) : `「${head}」刚才状态变了，这次没关上；要关回「取消任务 ${anchor.task.id}」。`, anchor.task.id)
      return true
    }
    if (reply?.kind === 'unclear') {
      await note(`这句像是不做了，我拿不准，先没动「${head}」。不做回「取消任务 ${anchor.task.id}」；要做回「继续任务 ${anchor.task.id} 做」。`, anchor.task.id)
      return true
    }
    console.log(`[lark-gateway] 负责人私聊（${anchor.via}）→ 续跑 ${anchor.task.id}：${(msg.text || '').slice(0, 60)}`)
    await (deps.handleResume || handleResume)({ msg, config, store, resumeDirective: explicit ? anchor.directive : undefined, parentTask: { taskId: anchor.task.id, task: anchor.task, explicit } })
    return true
  }
  const goAheadText = anchor.via === 'explicit' ? anchor.directive?.supplementText : textForParse(msg)
  if (!msg.attachments?.length && isBareGoAhead(goAheadText) && isFreshInFlight(anchor.task, deps.now?.() ?? Date.now())) {
    const doing = anchor.task.status === 'running' || anchor.task.status === 'verifying' ? '正在做' : '已经排上了'
    console.log(`[lark-gateway] 负责人私聊（${anchor.via}）→ ${anchor.task.id} 在飞（${anchor.task.status}），只是放行没新内容，不建指示任务：${(msg.text || '').slice(0, 60)}`)
    await note(`「${head}」${doing}，跑完就发结论，不用再说一次；要改要求直接说具体内容。`, anchor.task.id)
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
