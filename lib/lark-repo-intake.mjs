/**
 * 仓库 profile 群（外部群）的入口辅助：说给谁 / 分类快慢道 / 「收到」防重 / 话题补充并入 / 疑似单放行权。
 * 从 lark-ingest.mjs 拆出（aven 2026-10-20 review：ingest 已贴体量上限，修入口问题先腾地方）；ingest 仍转出口，旧引用不变。
 */

import { downloadAttachments } from './lark-cli.mjs'
import { hasDocAttachment } from './lark-message.mjs'
import { localHHMM } from './lark-outbox.mjs'
import { deliverRepoAck, mentionsBot } from './lark-repo-delivery.mjs'
import { repoProfileForTask } from './lark-repo-profile.mjs'

// 仓库群一条消息的「说给谁」：@ 机器人 = 显式通道；被动模式 ledger 下没 @ 机器人的一律只记台账——带文档也不建任务、不存仓库
// （aven 10-20：只处理 @bot 的消息；10-20 Adrian 的任务中心问询清单没 @ 也被存进 pending，教训 #53）。
export const resolveRepoAddressing = ({ repo, msg }) => {
  const toBot = Boolean(repo && mentionsBot({ profile: repo, chatId: msg.chatId, mentions: msg.mentions }))
  return {
    toBot,
    fromPrincipal: Boolean(repo && (repo.ownership?.meOpenIds || []).includes(msg.senderOpenId)),
    passiveLedgerOnly: Boolean(repo && repo.passiveMode === 'ledger' && !toBot),
  }
}

// 话题补充并入未分类任务时，补充这条若走显式通道（@ 机器人 / 带对接文档），目标任务跟着升级，不再只记台账
// （2026-10-15 真机：Ache 的预约改版答复只 @ 了 Aven.tong，aven 回复「@Aven.Bot 帮记录提醒下」被并成话题补充，
// 分类判 api_reply / forMe / high，仍因主消息的 passiveLedgerOnly 被丢成 ignored）。返回是否需要补发「收到」。
export const applySupplementAddressing = ({ target, addressing }) => {
  if (addressing.passiveLedgerOnly) return false
  delete target.passiveLedgerOnly
  if (!addressing.toBot) return false
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
// 「收到」防重（阶段 2 临时版，出口闸在阶段 5）：同一个人在同一个群 2 分钟内只回一次——快道不等去抖，一个人连发两行会成两条任务。
export const ackedRecently = ({ store, chatId, operator, now = Date.now(), windowMs = 120_000 }) =>
  store.list().some((task) => task.chatId === chatId && task.operator === operator && task.ackedAt && now - Date.parse(task.ackedAt) < windowMs)
export const ackInGroup = async ({ store, task }) => {
  if (ackedRecently({ store, chatId: task.chatId, operator: task.operator })) {
    store.upsert({ ...store.get(task.id), ackedInGroup: true, ackedAt: new Date().toISOString(), ackCoalesced: true })
    console.log(`[lark-gateway] ${task.id} 2 分钟内已对同一人回过「收到」，本条不再回`)
    return
  }
  const acked = await deliverRepoAck({ task })
  // 出口闸按人 2 分钟拦下的「收到」也算回过（刚回过同一个人）；只私聊的群（privateOnlyChats）拦下的不算——群里根本没回过（aven 2026-10-20 review）。
  if (acked.ok || (acked.gated && !acked.privateOnly)) store.upsert({ ...store.get(task.id), ackedInGroup: true, ackedAt: new Date().toISOString(), ...(acked.gated ? { ackCoalesced: true } : {}) })
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
