/**
 * 负责人私聊 = 仓库控制通道（2026-10-14）。
 *
 * 仓库 profile 的所有私聊通知（疑似 / 开始 / 结果 / 判定不处理）都发到负责人和 bot 的 p2p 会话；
 * 负责人在那里回一句「是」「继续」「这个要礼貌拒绝」是对**上一条通知**说的，不是给 fameex 主仓下的 hotfix。
 * 真机事故：三句私聊回复各建了一条 fameex adhoc hotfix 任务，挂起 4h 后触发 fameex 催办卡。
 *
 * 机制（不是规则）：p2p 消息先锚定到「bot 最近一条私聊通知所属的仓库任务」，锚到了就只走仓库通道——
 *   · 任务还挂着（待确认 / 阻塞）→ 当补料续跑；
 *   · 其它状态（已判不处理 / 在跑 / 已完成）→ 建一条「负责人私聊指示」任务，带上原群消息做上下文，
 *     走和群里 @Aven.Bot 一样的分类 → 台账 → 派工 / 回群；回群对着原群消息的发送人说。
 * 锚不到（最近一条私聊是 fameex 任务的回执，或超时）→ 放行老路径，fameex 私聊 hotfix 行为不变。
 */

import { parseResumeDirective, textForParse } from './lark-message.mjs'

export const DEFAULT_PRINCIPAL_REPLY_WINDOW_MS = 12 * 60 * 60 * 1000

const PARKED = new Set(['waiting_confirmation', 'blocked'])

// 发送人是哪些仓的负责人。notifyChatId === senderOpenId 是旧 p2p 口径（notifyChatId 填负责人 open id）；repo-only 实例的
// notifyChatId 是 oc_ 控制台群、发送人是负责人 ou_，那一条恒不成立，只靠 ownership.meOpenIds 命中（aven 2026-10-20 review C12）。
export const resolvePrincipalProfiles = ({ senderOpenId, profiles = [] }) =>
  profiles.filter((profile) =>
    profile && !profile.isDefault && senderOpenId &&
    (profile.notifyChatId === senderOpenId || (profile.ownership?.meOpenIds || []).includes(senderOpenId)))
export const resolvePrincipalProfile = (args) => resolvePrincipalProfiles(args)[0] || null

export const latestReceiptAt = (task) =>
  (task?.receipts || []).reduce((max, receipt) => Math.max(max, Date.parse(receipt?.createdAt || '') || 0), 0)

const firstLine = (text) => String(text || '').split('\n').find((line) => line.trim())?.trim() || ''
export const anchorHead = (task, max = 50) => firstLine(task?.summary || task?.text).replace(/^【[^】]*】/, '').slice(0, max)

// 锚定：显式「继续任务 <id>」→ 那条任务本身（via explicit，带 directive）；回复了某条私聊通知 → 那条通知的任务；
// 没回复 → bot 最近一条私聊通知所属的仓库任务（窗口内，且比同一会话里最近的 fameex 任务回执更新）。
// 回复的是 fameex 任务的回执、或显式点名的任务不是本仓 / 不存在 → null（老路径处理）。
// 2026-10-16 真机：aven 私聊「继续任务 om_…d9673 确认扩大范围」被按 recent 锚到 William 刚 @bot 的一条，建成指示任务——
// 发送人 / 话题都成了 William 的，R6 复测结论对着 William 说、Ache 那条永远没下文。点名的任务 id 比「最近一条」强。
export const resolvePrincipalAnchor = ({ msg, store, profile, now = Date.now(), windowMs = DEFAULT_PRINCIPAL_REPLY_WINDOW_MS }) => {
  const directive = parseResumeDirective(textForParse(msg))
  if (directive) {
    const named = store.get?.(directive.taskId) || null
    return named && named.repo === profile.key ? { task: named, via: 'explicit', directive } : null
  }
  const byReceipt = (id) => (id ? store.findTaskByAnyReceipt?.(id) || store.findByReceiptMessageId?.(id) || null : null)
  const replied = byReceipt(msg.replyToDirect) || byReceipt(msg.replyTo)
  if (replied) return replied.repo === profile.key ? { task: replied, via: 'reply' } : null
  let repoTask = null
  let repoAt = 0
  let otherAt = 0
  for (const task of store.list()) {
    const at = latestReceiptAt(task)
    if (!at) continue
    if (task.repo === profile.key) {
      if (at > repoAt) { repoAt = at; repoTask = task }
    } else if (!task.repo && task.chatId === msg.chatId) {
      otherAt = Math.max(otherAt, at)
    }
  }
  if (!repoTask || now - repoAt > windowMs || repoAt <= otherAt) return null
  return { task: repoTask, via: 'recent' }
}

// 多仓共用一个负责人 / 控制台（falive 与自修仓 lark-bot 的 notifyChatId 相同）：以前 find 取第一个仓，recent 只看那个仓的任务，
// 永远锚到 falive。现在每个匹配仓各锚一次：点名 / 回复锚到的任务只属一个仓，直接用；都是 recent 时取回执最新的那条（aven 2026-10-20 review C12）。
export const resolvePrincipalTarget = ({ msg, store, profiles = [], now = Date.now() }) => {
  let best = null
  for (const profile of resolvePrincipalProfiles({ senderOpenId: msg.senderOpenId, profiles })) {
    const anchor = resolvePrincipalAnchor({ msg, store, profile, now, windowMs: profile.principalReplyWindowMs })
    if (!anchor) continue
    if (anchor.via !== 'recent') return { profile, anchor }
    if (!best || latestReceiptAt(anchor.task) > latestReceiptAt(best.anchor.task)) best = { profile, anchor }
  }
  return best
}

export const decidePrincipalAction = (anchorTask) => (PARKED.has(anchorTask?.status) ? 'resume' : 'instruct')

// 放行被自检扣下的群回复（教训 #56）：私聊「就这样回，哪里拿不准了」原来被建成指示任务重跑一遍，又补一句「拿不准」。
// 只认以放行说法开头的短句（≤ 40 字）；带了别的要求（「改成…再发」）的长句照旧走指示任务。
const RELEASE_HELD = /^就?(?:照着?|按)?(?:这样|这么|这个|原文|原样)?(?:直接|可以)?\s*(?:回|发)(?:吧|啊|呀|出去|群里|到群里)?(?=$|[，,。.!！\s]|哪|没|就|可以)/
export const isReleaseHeldReply = (text) => {
  const value = String(text || '').trim()
  return value.length > 0 && value.length <= 40 && RELEASE_HELD.test(value)
}

// 「负责人私聊指示」任务：身份是私聊消息 id，但群 / 发送人 / 话题沿用被指示的群消息，回群时对着原发送人说。
export const buildPrincipalInstructionTask = ({ msg, anchor, profile, attachments = [], commandType = null, commandTypeSource = null, now = new Date() }) => {
  const me = profile.ownership?.me || '负责人'
  const cls = anchor.intake?.classification
  const verdict = cls ? `，之前判定 ${cls.decision}${cls.reason ? `：${cls.reason}` : ''}` : ''
  const head = anchorHead(anchor)
  const text = [
    `【${me} 私聊指示】${(msg.text || '').trim() || '（附件）'}`,
    `【指示针对的群消息（任务 ${anchor.id}，当前 ${anchor.status}${verdict}）】\n${String(anchor.text || '').slice(0, 3000)}`,
  ].join('\n\n')
  return {
    id: msg.messageId,
    source: 'lark',
    chatId: anchor.chatId,
    messageId: msg.messageId,
    threadRootId: anchor.threadRootId || null,
    operator: anchor.operator,
    project: profile.projectKey,
    repo: profile.key,
    commandType,
    commandTypeSource,
    projectTitle: profile.title || profile.key,
    text,
    // 标题用被锚的群消息，不放私聊原话（aven 2026-10-20 review C1）：summary 会被出口当群里引用的标题 / 回落正文，
    // 原来「aven 私聊指示：<原话>」会跟着阻塞要材料、done 回落进外部群。私聊原话只留在 text 里给执行器看。
    summary: head || '（附件）',
    attachments: [...attachments, ...(anchor.attachments || [])],
    aiExecutor: anchor.aiExecutor || 'claude',
    status: 'received',
    intake: { required: true, trigger: 'principal_private', mentionedOpenIds: [], notBefore: null, receivedAt: now.toISOString() },
    addressedToBot: true,
    fromPrincipal: true,
    privateOrigin: { chatId: msg.chatId, senderOpenId: msg.senderOpenId, anchorId: anchor.id, anchorHead: head },
    createdAt: now.toISOString(),
  }
}

// 负责人单独一句「已部署 / 部署好了」：部署已由 lark-deploy-watch 自动探测，不再当成对上一条通知的指示（10-28 真机：
// aven 在控制台说「已部署」，被锚到刚答完的 Arthur 那条，建成「回他已部署」的指示任务）。只认整条就是这一句的短消息。
const DEPLOY_NOTICE = /^(?:pre\s*)?(?:已(?:经)?部署|部署(?:好|完)|已发部署|部署邮件已发)(?:了|啦|好了)?[。.!！~～]*$/i
export const isDeployNotice = (text) => DEPLOY_NOTICE.test(String(text || '').trim())
