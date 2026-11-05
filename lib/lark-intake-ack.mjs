/**
 * 入口辅助（从 falive lark-repo-intake 搬来，去掉仓库 profile；11-01 对话层）：「收到」挂起 / 到点兜底、分类快慢道、
 * 话题补充并入、疑似单放行权。
 *
 * 「收到」等分类结果再发（falive #57：固定句「收到，我查一下，稍后回复」跟上下文无关，分类器其实已写好一句贴合的 reply）：
 * @bot / 私信先挂 ackPending（带截止时间，持久化在任务上，bot 常自动重启、内存定时器会丢），分类回写时 flushPendingAck 用
 * reply 回；到点还没分类由网关每 15 秒的 sweepPendingAcks 发固定句。同一个人 2 分钟内连发两行只回一次（发件簿按人去重，
 * 拦下的也算回过）。
 */

import { downloadAttachments } from './lark-cli.mjs'
import { mentionNote } from './lark-conversation-bundle.mjs'
import { deliverAck } from './lark-delivery.mjs'
import { replyKeyFor, sendReply } from './lark-group-exit.mjs'
import { sayAck } from './lark-human-text.mjs'
import { hasDocAttachment, stripMentionNames } from './lark-message.mjs'
import { localHHMM } from './lark-outbox.mjs'
import { isPrincipal } from './lark-principal-channel.mjs'
import { isControlActiveStatus } from './lark-task-store.mjs'

export const DEFAULT_ACK_TIMEOUT_MS = Number(process.env.LARK_ACK_TIMEOUT_MS || 45_000)
export const ACK_SWEEP_EVERY_MS = 15_000
const DEFAULT_INTAKE = { fastLaneMs: 0, quietGapMs: 60_000, maxWaitMs: 180_000 }
export const intakeTiming = (config) => ({ ...DEFAULT_INTAKE, ...(config?.intake || {}) })

// 分道：直接 @bot / 私信 / 负责人本人 / 引用了 bot 自己的消息 → 快道，不等；只 @ 负责人的 → 慢道，等安静期再分类（连发的几条一起进分类）。
export const resolveIntakeLane = ({ task }) => (task?.addressedToBot || task?.fromPrincipal || task?.quotedOwnCard ? 'fast' : 'slow')
// 完整件（文档附件 / 长正文）本身就齐了，不用等人补充。
export const isCompleteMessage = ({ msg, minChars = 200 }) =>
  hasDocAttachment(msg?.attachments || []) || String(msg?.text || '').trim().length >= minChars
// 话没说完（11-04 b3 ep-1031-f8065f：aven 在 bot 卡片话题里发「如果不方便补信息,」，38 秒后才发完整句「…请给 @Adrian 打个电话」）：
// 以逗号 / 顿号 / 冒号 / 分号 / 省略号收尾、没附件、不长的，快道也先等安静期，同一人接着发的并进来一起分类（pickAwaitingRestTarget）。
const UNFINISHED_TAIL = /(?:[,，、:：;；]|\.{3}|…)$/
export const isUnfinishedMessage = ({ msg, maxChars = 200 }) => {
  if (msg?.attachments?.length) return false
  const text = stripMentionNames(String(msg?.text || '').replace(/<[^>]+>/g, ''), msg?.mentions).trim()
  return text.length < maxChars && UNFINISHED_TAIL.test(text)
}
export const resolveIntakeNotBefore = ({ lane, complete = false, unfinished = false, firstReceivedAt, now = Date.now(), intake = DEFAULT_INTAKE }) => {
  if ((lane === 'fast' || complete) && !unfinished) return new Date(now + (intake?.fastLaneMs || 0)).toISOString()
  const first = Date.parse(firstReceivedAt || '') || now
  const at = Math.min(now + (intake?.quietGapMs || 0), first + (intake?.maxWaitMs || 0))
  return new Date(Math.max(at, now)).toISOString()
}

export const markAckPending = ({ store, task, timeoutMs = DEFAULT_ACK_TIMEOUT_MS, now = Date.now() }) => {
  const live = store.get(task.id) || task
  if (live.ackedInGroup || live.ackPending) return live
  return store.upsert(Object.assign(live, { ackPending: { at: new Date(now).toISOString(), deadline: new Date(now + timeoutMs).toISOString() } }))
}

// 到点没分类的「收到」照发固定句；网关启动时跑一次（接上重启前挂着的），之后每 ACK_SWEEP_EVERY_MS 一次。
// 到点前任务已了结的（人工取消 / 判不处理 / 自答 / 分类失败，第二道防线，结单处也清）只撤不发：已关掉的事不能再说「稍后回你」。返回发了固定句的条数。
export const sweepPendingAcks = async ({ config, store, now = Date.now(), deliver }) => {
  const due = store.list().filter((task) => {
    if (!task.ackPending) return false
    const deadline = Date.parse(task.ackPending.deadline || '') || (Date.parse(task.ackPending.at || '') + DEFAULT_ACK_TIMEOUT_MS)
    return Number.isFinite(deadline) && deadline <= now
  })
  let sent = 0
  for (const task of due) {
    const live = isControlActiveStatus(task.status)
    await flushPendingAck({ config, store, task, send: live, reason: live ? 'timeout' : `settled:${task.status}`, deliver })
    if (live) sent += 1
  }
  return sent
}

// 发出挂着的「收到」：reply 有就用它，没有（分类失败 / 超时）用固定句；send=false 只撤掉不发（判不处理：由「记下了」那句代替）。
// 就地改任务对象再 upsert——分类路由拿的就是同一个对象。返回 { sent, usedReply }。
// 等分类期间单子已被关掉（负责人 close / 别处接手 = superseded，判不处理 = ignored）就只撤不发（aven 11-03 falive：关单后分类超时，
// 照发了固定句「收到，我查一下，稍后回复」，排在负责人已发的提问后面）。看库里的最新状态，手上的对象可能是旧的。
const ACK_WITHDRAWN = new Set(['superseded', 'ignored'])
export const flushPendingAck = async ({ config, store, task, reply = null, send = true, reason = 'classified', deliver = deliverAck }) => {
  if (!task?.ackPending) return { sent: false, usedReply: false }
  const live = store.get(task.id)
  // 并进别的任务（superseded + supersededBy、没有 closureReason：routes 先 mergeIntoTask 再 flush）不算关单——本条的「收到」照发（11-03 合并回放分支时发现：
  // 原先一律撤，追问 / 补充并入后发问的人一句都收不到）。兄弟收尾的 supersede 只作用于已分类的挂起单，不会还挂着「收到」。
  const merged = live?.status === 'superseded' && live.supersededBy && !live.closureReason
  if (live && !merged && (live.closureReason || ACK_WITHDRAWN.has(live.status))) {
    // 只改库里的最新对象：写回手上的旧对象会把已关的单改回原状态
    task.ackPending = null
    store.upsert(Object.assign(live, { ackPending: null }))
    console.log(`[lark-gateway] ${task.id} 单子已关，「收到」只撤不发（${reason}）`)
    return { sent: false, usedReply: false }
  }
  task.ackPending = null
  store.upsert(task)
  if (!send) return { sent: false, usedReply: false }
  const text = String(reply || '').trim()
  const acked = await deliver({ config, store, task, reply: text || null })
  // 出口闸按人 2 分钟拦下的「收到」也算回过（刚回过同一个人）。ackReply 只记真正发出去的那句（固定句也记）：worker 的「群里已先回了一句」
  // 只读它（11-03 第二次 review #4）。routes 先并入再 flush：本条已被并掉的，这句也写到承接的那条上——这次答应的是它。
  if (acked?.ok || acked?.gated) {
    const ackReply = acked.ok ? text || sayAck({ reply: null }) : null
    Object.assign(task, { ackedInGroup: true, ackedAt: new Date().toISOString(), ...(acked.gated ? { ackCoalesced: true } : {}), ...(ackReply ? { ackReply } : {}) })
    store.upsert(task)
    // supersededBy 只随 superseded 一起写（lark-task-merge / store 兄弟归并）。
    const into = ackReply && task.supersededBy ? store.get(task.supersededBy) : null
    if (into && into.status !== 'superseded') store.upsert(Object.assign(into, { ackReply }))
  }
  console.log(`[lark-gateway] ${task.id} 回「收到」（${reason}${text && acked?.ok ? '，用分类 reply' : '，固定句'}）：${acked?.ok ? 'ok' : acked?.reason || (acked?.gated ? 'gated' : 'skipped')}`)
  return { sent: Boolean(acked?.ok), usedReply: Boolean(acked?.ok && text) }
}

// 「收到」已经不挂着了（到点 45s 巡检发了固定句——分类常超 45s；或出口闸按人 2 分钟把它拦了）、分类器那句（自答 / 追问）
// 还没发出去：单独回一条到原消息（11-02 复核：原先 flush 空转、答案丢了，任务却记成 answered）。走 self_answer / ask_back 出口：
// 按消息去重（同一条消息同阶段 24h 只回一次）、不按内容、不按人 2 分钟拦——两个人问同样的问题各自要得到答复（11-03 R11：原来走 done 的
// content_24h，固定能力答复撞内容时第二条被拦、任务却落 answered）；回执仍登记到任务。返回出口结果（ok 才算答了，由调用方记义务）。
export const deliverFollowUpReply = async ({ config, store, task, text, kind = 'self_answer', send = sendReply }) => {
  const body = String(text || '').trim()
  if (!body) return { ok: false, gated: false, reason: 'empty follow-up' }
  const ask = kind === 'ask_back'
  return send({ config, store, task, phase: ask ? 'ask_back' : 'self_answer', text: body, idempotencyKey: replyKeyFor(task, ask ? 'askb' : 'ans') })
}

const newestFirst = (tasks) => [...tasks].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0] || null

// 话题补充的并入目标（只认「还没分类」的任务）：同话题 / 回复同一条；或同一个人在同一个群、安静期内的连续**主楼**消息
//（本条带话题 / 回复时只按话题找；同人连发只在本条和目标都在主楼时成立，falive review）。
export const pickSupplementTarget = ({ msg, store, now = Date.now(), quietGapMs = DEFAULT_INTAKE.quietGapMs }) => {
  const threadKey = msg.threadRootId || msg.replyTo
  // 等后半句的（awaitingRest）只收同一人的：别人在同话题里的话不能并进他的半句（各自分类）。
  const pending = (task) => task && task.status === 'received' && task.intake?.required && task.id !== msg.messageId && (!task.intake.awaitingRest || task.operator === msg.senderOpenId)
  if (threadKey) {
    const byThread = [store.get(threadKey), ...(store.listActiveByThread?.(threadKey, { excludeId: msg.messageId }) || [])]
      .filter((task, index, all) => task && all.indexOf(task) === index)
    return newestFirst(byThread.filter(pending))
  }
  return newestFirst(store.list().filter((task) => pending(task) && !task.threadRootId && task.chatId === msg.chatId &&
    task.operator === msg.senderOpenId && now - Date.parse(task.intake?.receivedAt || task.createdAt || 0) < quietGapMs))
}

// 同一人刚发了半句（awaitingRest、还没分类）：本条是后半句。同群、同话题（或直接回复那半句），在最长等待期内。纯函数。
export const pickAwaitingRestTarget = ({ msg, store, now = Date.now(), maxWaitMs = DEFAULT_INTAKE.maxWaitMs }) => {
  const threadKey = msg.threadRootId || msg.replyTo || null
  return newestFirst(store.list().filter((task) => task.status === 'received' && task.intake?.required && task.intake.awaitingRest === true &&
    task.id !== msg.messageId && task.chatId === msg.chatId && task.operator === msg.senderOpenId &&
    ((task.threadRootId || null) === threadKey || msg.replyTo === task.id) &&
    now - Date.parse(task.intake.receivedAt || task.createdAt || 0) < maxWaitMs))
}

// 后续发言并进「还没分类」的任务一起分类（去抖）；在跑 / 已了结的一律不并。返回 true 表示已并入（调用方 return）。
// addressedToBot：本条有没有叫机器人（补充走显式通道就升级目标任务、转快道）。
// target：调用方已经锚到的目标（回复了「收到」的那条，控制通道给的，11-02 复核），不再按话题 / 同人连发去找。
// 目标正在分类（running + intake.required，worker 拿的是旧正文）：正文照并，标 intake.reclassify——网关收到这轮结果时作废、放回重分类一次
//（store.resolveIntake）；原先追加进去了，分类判 ignore / 疑似时补的内容无声丢失（11-03 静态 review R7）。一条 @bot 仍只有一个下文：
// 补充这条不回第二句，目标的「收到」等第二轮分类的 reply。
export const mergeThreadSupplement = async ({ msg, config, store, addressedToBot = false, target: anchored = null, download = downloadAttachments }) => {
  if (msg.senderType === 'bot' || !(msg.text?.trim() || msg.attachments?.length)) return false
  const timing = intakeTiming(config)
  const target = anchored || pickSupplementTarget({ msg, store, quietGapMs: timing.quietGapMs })
  if (!target) return false
  // 正文里的「@名字」归一时已剥掉（lark-message stripMentions）：补上 @ 了谁，不然「请给 @Adrian 打个电话」并进来只剩「请给 打个电话」。
  const atNote = mentionNote({ mentions: msg.mentions || [], botOpenIds: [config?.botOpenId, config?.botAppId].filter(Boolean) })
  target.text = `${target.text || ''}\n\n【话题补充 ${localHHMM()}】${(msg.text || '').trim() || '（附件）'}${atNote}`.trim()
  if (msg.attachments?.length) {
    const extra = await download({ project: target.project || config.project, messageId: msg.messageId, attachments: msg.attachments })
    target.attachments = [...(target.attachments || []), ...extra]
  }
  const firstAddress = addressedToBot && !target.addressedToBot
  if (addressedToBot) {
    // 记下这条并进了哪单：未回 @ 巡检（lark-delivery deliverUnansweredAddressed）按它认「并进去了、结论回给了同一个人」。
    if (!(target.linkedMessageIds || []).includes(msg.messageId)) target.linkedMessageIds = [...(target.linkedMessageIds || []), msg.messageId].slice(-30)
    target.addressedToBot = true
    if (isPrincipal(config, msg.senderOpenId)) target.fromPrincipal = true
    target.intake.lane = 'fast'
  }
  // 后半句到了就不再等（它自己又没说完的接着等）。
  const unfinished = isUnfinishedMessage({ msg })
  if (target.intake.awaitingRest) target.intake.awaitingRest = unfinished
  target.intake.notBefore = resolveIntakeNotBefore({ lane: target.intake.lane, complete: isCompleteMessage({ msg }), unfinished: unfinished && target.intake.awaitingRest, firstReceivedAt: target.intake.receivedAt, intake: timing })
  const classifying = target.status === 'running' && target.intake.required === true
  if (classifying) target.intake.reclassify = true
  store.upsert(target)
  if (firstAddress && !target.ackedInGroup) markAckPending({ store, task: target })
  console.log(`[lark-gateway] 话题补充：${msg.messageId} 并入任务 ${target.id}（${target.status}${classifying ? '，分类中：这轮结果作废、重分类' : ''}）：${(msg.text || '').slice(0, 60)}`)
  return true
}

// 疑似单（suspected，待负责人放行）的放行权只在负责人手里（falive review C3）：别人的回复只追加进正文，任务继续等。
export const holdsSuspectedForPrincipal = ({ task, operator, config }) =>
  Boolean(task?.suspected) && task.status === 'waiting_confirmation' && !isPrincipal(config, operator)
export const appendSuspectedSupplement = ({ store, task, supplementText = '', supplementAttachments = [], operator = null, now = new Date() }) => {
  const supplement = String(supplementText || '').trim()
  return store.upsert({
    ...task,
    text: `${task.text || ''}\n\n【补充 ${localHHMM(now)}，待负责人放行】${supplement || '（附件）'}`.trim(),
    attachments: [...(task.attachments || []), ...supplementAttachments],
    suspectedSupplements: [...(task.suspectedSupplements || []), { operator, at: now.toISOString() }].slice(-20),
  })
}
