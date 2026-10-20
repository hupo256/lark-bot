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

import { parseResumeDirective } from './lark-message.mjs'

export const DEFAULT_PRINCIPAL_REPLY_WINDOW_MS = 12 * 60 * 60 * 1000

const PARKED = new Set(['waiting_confirmation', 'blocked'])

export const resolvePrincipalProfile = ({ senderOpenId, profiles = [] }) =>
  profiles.find((profile) =>
    profile && !profile.isDefault && senderOpenId &&
    (profile.notifyChatId === senderOpenId || (profile.ownership?.meOpenIds || []).includes(senderOpenId))) || null

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
  const directive = parseResumeDirective(msg.text)
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

export const decidePrincipalAction = (anchorTask) => (PARKED.has(anchorTask?.status) ? 'resume' : 'instruct')

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
