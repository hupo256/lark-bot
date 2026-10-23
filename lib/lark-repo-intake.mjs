/**
 * 仓库 profile 群（外部群）的入口辅助：说给谁 / 分类快慢道 / 「收到」防重 / 话题补充并入 / 疑似单放行权。
 * 从 lark-ingest.mjs 拆出（aven 2026-10-20 review：ingest 已贴体量上限，修入口问题先腾地方）；ingest 仍转出口，旧引用不变。
 */

import { downloadAttachments } from './lark-cli.mjs'
import { hasDocAttachment } from './lark-message.mjs'
import { localHHMM } from './lark-outbox.mjs'
import { deliverRepoAck, mentionsBot } from './lark-repo-delivery.mjs'
import { repoProfileForTask } from './lark-repo-profile.mjs'

// 仓库群一条消息的「说给谁」：@ 机器人才算叫它（10-23 起外部群只有 @bot 的消息会建任务，见 lark-ingest）。
export const resolveRepoAddressing = ({ repo, msg }) => ({
  toBot: Boolean(repo && mentionsBot({ profile: repo, chatId: msg.chatId, mentions: msg.mentions })),
  fromPrincipal: Boolean(repo && (repo.ownership?.meOpenIds || []).includes(msg.senderOpenId)),
})

// 话题补充并入未分类任务时，补充这条若走显式通道（@ 机器人 / 带对接文档），目标任务跟着升级，不再只记台账
// （2026-10-15 真机：Ache 的预约改版答复只 @ 了 Aven.tong，aven 回复「@Aven.Bot 帮记录提醒下」被并成话题补充，
// 分类判 api_reply / forMe / high，仍因主消息的 passiveLedgerOnly 被丢成 ignored）。返回是否需要补发「收到」。
export const applySupplementAddressing = ({ target, addressing }) => {
  if (!addressing.toBot) return false
  delete target.passiveLedgerOnly // 10-23 前建的存量被动任务被 @bot 的补充接手：不再只记台账
  const firstAddress = !target.addressedToBot
  target.addressedToBot = true
  if (addressing.fromPrincipal) target.fromPrincipal = true
  return firstAddress && !target.ackedInGroup
}

// 分类去抖分道（2026-10-15）：显式通道（@ 机器人 / 回复 bot 的卡 / 负责人本人）走快道，不等——10-15 数据里 @ 机器人的 15 条
// 只有 1 条合并到过补充，180s 纯等；被动上下文消息走慢道，安静 quietGapMs 再分类、从首条起最多 maxWaitMs。
export const resolveIntakeLane = ({ addressing, quotedIsOurs = false }) =>
  (addressing?.toBot || addressing?.fromPrincipal || quotedIsOurs ? 'fast' : 'slow')
// 完整件（对接文档附件 / 长正文）本身就齐了，不用等人补充。
export const isCompleteMessage = ({ msg, minChars = 200 }) =>
  hasDocAttachment(msg?.attachments || []) || String(msg?.text || '').trim().length >= minChars
export const resolveIntakeNotBefore = ({ lane, complete = false, firstReceivedAt, now = Date.now(), intake }) => {
  if (lane === 'fast' || complete) return new Date(now + (intake?.fastLaneMs || 0)).toISOString()
  const first = Date.parse(firstReceivedAt || '') || now
  const at = Math.min(now + (intake?.quietGapMs || 0), first + (intake?.maxWaitMs || 0))
  return new Date(Math.max(at, now)).toISOString()
}
// 「收到」等分类结果再发（教训 #57：固定句「收到，我查一下，稍后回复」跟上下文无关，分类器其实已写好一句贴合的 reply）。
// 显式通道先挂 ackPending（带截止时间，持久化在任务上），分类回写时 flushPendingAck 用 reply 回；
// 到点还没分类由网关的定时巡检 sweepPendingAcks 照发固定句。截止时间落盘、不用内存定时器——bot 常自动重启，
// 10-20 版的 setTimeout 重启即丢（10-21 架构加固 P0）。
// 同一个人 2 分钟内连发两行（= 两条任务）只回一次「收到」：由发件簿的同人同阶段窗口挡（发出时拦下也算回过，见 flushPendingAck）；
// 原来这里另有一层 ackedRecently 做同一件事，10-21 P5 删掉。
export const DEFAULT_ACK_TIMEOUT_MS = 45_000
export const ACK_SWEEP_EVERY_MS = 15_000
export const ackInGroup = async ({ store, task, timeoutMs = DEFAULT_ACK_TIMEOUT_MS, now = Date.now() }) => {
  const live = store.get(task.id) || task
  if (live.ackedInGroup || live.ackPending) return
  store.upsert(Object.assign(live, { ackPending: { at: new Date(now).toISOString(), deadline: new Date(now + timeoutMs).toISOString() } }))
}
// 到点没分类的「收到」照发固定句；网关启动时跑一次（接上重启前挂着的），之后每 ACK_SWEEP_EVERY_MS 一次。
// 老格式（10-20 版，没有 deadline）按 at + 默认超时算。
export const sweepPendingAcks = async ({ store, now = Date.now(), deliver = deliverRepoAck }) => {
  const due = store.list().filter((task) => {
    if (!task.ackPending) return false
    const deadline = Date.parse(task.ackPending.deadline || '') || (Date.parse(task.ackPending.at || '') + DEFAULT_ACK_TIMEOUT_MS)
    return Number.isFinite(deadline) && deadline <= now
  })
  for (const task of due) await flushPendingAck({ store, task, reason: 'timeout', deliver })
  return due.length
}
// 发出挂着的「收到」：reply 有就用它，没有（分类失败 / 超时）用固定句；send=false 只撤掉不发（判不处理：@bot 的由「记下了」那句代替，
// 只 @ 负责人的不回群）。就地改任务对象再 upsert——分类路由拿的就是同一个对象，后面还会整体写回。返回 { sent, usedReply }。
export const flushPendingAck = async ({ store, task, reply = null, send = true, reason = 'classified', deliver = deliverRepoAck }) => {
  if (!task?.ackPending) return { sent: false, usedReply: false }
  task.ackPending = null
  store.upsert(task)
  if (!send) return { sent: false, usedReply: false }
  const text = String(reply || '').trim()
  const acked = await deliver({ task, reply: text || null })
  // 出口闸按人 2 分钟拦下的「收到」也算回过（刚回过同一个人）；只私聊的群（privateOnlyChats）拦下的不算——群里根本没回过（aven 2026-10-20 review）。
  if (acked.ok || (acked.gated && !acked.privateOnly)) {
    Object.assign(task, { ackedInGroup: true, ackedAt: new Date().toISOString(), ...(acked.gated ? { ackCoalesced: true } : {}), ...(acked.ok && text ? { ackReply: text } : {}) })
    store.upsert(task)
  }
  console.log(`[lark-gateway] ${task.id} 回「收到」（${reason}${text && acked.ok ? '，用分类 reply' : '，固定句'}）：${acked.ok ? 'ok' : acked.reason || acked.gated || 'skipped'}`)
  return { sent: Boolean(acked.ok), usedReply: Boolean(acked.ok && text) }
}

// 本机时区 HH:MM（aven 2026-10-20 review：以前 toISOString 截 UTC，写进正文的「话题补充 HH:MM」分类器看到的是 UTC 时刻）。
export { localHHMM } // 时刻按本机本地时区，与出口闸同一实现

const newestFirst = (tasks) => [...tasks].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0] || null

// 话题补充的并入目标（只认「还没分类」的任务）：同话题 / 回复同一条；或同一个人在同一个群、安静期内的连续**主楼**消息。
// aven 2026-10-20 review：「同人连发」以前不看话题——B 在一个旧话题里的回复被并进他刚在主楼发的 A。
// 现在本条带话题 / 回复时只按话题找；同人连发只在本条和目标都在主楼（都没有话题键）时成立。
export const pickSupplementTarget = ({ msg, store, repo, now = Date.now() }) => {
  const threadKey = msg.threadRootId || msg.replyTo
  const pending = (task) => task.status === 'received' && task.intake?.required && task.id !== msg.messageId
  if (threadKey) {
    // 直接回复原消息（replyTo = 那条任务的 id）也算同话题：主楼消息没有话题 id，只按 threadRootId 找会漏（2026-10-15 真机）。
    const byThread = [store.get(threadKey), ...store.listActiveByThread(threadKey, { excludeId: msg.messageId })]
      .filter((task, index, all) => task && all.indexOf(task) === index)
    return newestFirst(byThread.filter(pending))
  }
  return newestFirst(store.list().filter((task) => pending(task) && !task.threadRootId && task.repo === repo.key && task.chatId === msg.chatId &&
    task.operator === msg.senderOpenId && now - Date.parse(task.intake?.receivedAt || task.createdAt || 0) < repo.intake.quietGapMs))
}

// 外部群里的后续发言并进「还没分类」的任务一起分类（去抖）；在跑 / 已了结的一律不并、不重开（见 lark-routes 的台账派工）。
// 返回 true 表示已并入（调用方 return）。
export const mergeThreadSupplement = async ({ msg, repo, config, store }) => {
  if (!repo || msg.senderType !== 'user' || !(msg.text?.trim() || msg.attachments?.length)) return false
  const target = pickSupplementTarget({ msg, store, repo })
  if (!target) return false
  target.text = `${target.text || ''}\n\n【话题补充 ${localHHMM()}】${(msg.text || '').trim() || '（附件）'}`.trim()
  if (msg.attachments?.length) {
    const extra = await downloadAttachments({ project: target.project || config.project, messageId: msg.messageId, attachments: msg.attachments })
    target.attachments = [...(target.attachments || []), ...extra]
  }
  const addressing = resolveRepoAddressing({ repo, msg })
  const needsAck = applySupplementAddressing({ target, addressing })
  // 还没分类：按道重算分类时间——补充走显式通道就转快道；慢道只顺延到安静期，且不超过从首条起的封顶。
  if (resolveIntakeLane({ addressing }) === 'fast') target.intake.lane = 'fast'
  target.intake.notBefore = resolveIntakeNotBefore({ lane: target.intake.lane, complete: isCompleteMessage({ msg }), firstReceivedAt: target.intake.receivedAt, intake: repo.intake })
  store.upsert(target)
  if (needsAck) await ackInGroup({ store, task: target })
  console.log(`[lark-gateway] 话题补充：${msg.messageId} 并入任务 ${target.id}（${target.status}）：${(msg.text || '').slice(0, 60)}`)
  return true
}

// 疑似单（suspected，待负责人放行）的放行权只在负责人手里（aven 2026-10-20 review C3）：以前控制通道续跑 / 同话题归并
// 对谁的回复都直接 resumeWithSupplement，群里任何人一句话疑似单就开跑。别人的回复只追加进正文，任务继续等负责人。
export const isTaskPrincipal = ({ task, operator }) =>
  Boolean(operator) && (repoProfileForTask(task)?.ownership?.meOpenIds || []).includes(operator)
export const holdsSuspectedForPrincipal = ({ task, operator }) =>
  Boolean(task?.suspected) && task.status === 'waiting_confirmation' && !isTaskPrincipal({ task, operator })
export const appendSuspectedSupplement = ({ store, task, supplementText = '', supplementAttachments = [], operator = null, now = new Date() }) => {
  const supplement = String(supplementText || '').trim()
  return store.upsert({
    ...task,
    text: `${task.text || ''}\n\n【补充 ${localHHMM(now)}，待负责人放行】${supplement || '（附件）'}`.trim(),
    attachments: [...(task.attachments || []), ...supplementAttachments],
    suspectedSupplements: [...(task.suspectedSupplements || []), { operator, at: now.toISOString() }].slice(-20),
  })
}

// 私聊「推 pre」只认开了日报清扫的仓（同 lark-daily-sweep 的 sweepProfiles 口径）的负责人（aven 2026-10-20 review）。
export const isPushPrePrincipal = ({ senderOpenId, profiles = [] }) => Boolean(senderOpenId) &&
  profiles.some((profile) => profile && !profile.isDefault && profile.dailyReport?.sweep && (profile.ownership?.meOpenIds || []).includes(senderOpenId))
