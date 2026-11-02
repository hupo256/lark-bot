/**
 * 群 / 私信消息的唯一出口（改写自 falive sendGroupCard，去 webhook；对话层 11-01）。
 * 每种消息（phase）适用哪些规则只看 lib/lark-group-phases.mjs 的表：超长转文档、出口闸去重、回复原消息还是直发、登记回执。
 *   · 表里没有的 phase 拒发；
 *   · 闸拦下（gated）返回 { ok: false, gated: true }——拦下就是没发，调用方不得当「群里已回」（falive 10-16 真机：拦下返回 ok:true，
 *     私信告诉负责人「群里已回」，群里其实没发）；
 *   · 发出去了记进发件簿（对着谁、哪个主题、哪个阶段、说了什么、message_id），receipt=task 的还登记成任务回执——回复 bot 任何一句都能锚回任务。
 * deps 可注入 replyMarkdown / sendMarkdown / publish（单测桩掉 lark-cli）。
 */

import { replyMarkdown as replyMarkdownCli, sendMarkdown as sendMarkdownCli } from './lark-cli.mjs'
import { keepGroupTextShort, publishMarkdownDoc } from './lark-docs.mjs'
import { groupPhasePolicy } from './lark-group-phases.mjs'
import { dedupeMentions, headline, mentionTag } from './lark-human-text.mjs'
import { recordOutbox, shouldSend } from './lark-outbox.mjs'
import { recordChatActivity } from './lark-chat-activity.mjs'

// 文案里的 `@名字` 换成 post-md 的 at 标签；mentions 里有、正文里没点到名的（没名字 / 文案没写）补在行首。
export const renderMentions = (text, mentions = []) => {
  let out = String(text || '')
  const missing = []
  for (const m of mentions) {
    if (!m?.openId) continue
    const tag = mentionTag(m.openId, m.name)
    if (m.name && out.includes(`@${m.name}`)) out = out.split(`@${m.name}`).join(tag)
    else if (!out.includes(`user_id="${m.openId}"`)) missing.push(tag)
  }
  return missing.length ? `${missing.join(' ')} ${out}` : out
}

// 幂等键：任务 + 代次 + 短码（≤ 50，代次不被截掉）。code ∈ ack / nt / done / fail / noop / blk / wait / ask / rm1 / rm2 / rel / sus / od / pn-xx。
export const replyKeyFor = (task, code, extra = '') => `${task?.id || 'na'}-e${task?.epoch || 0}-${code}${extra}`.slice(0, 50)

const safeRecord = (entry) => {
  try {
    recordOutbox(entry)
  } catch (error) {
    console.warn(`[lark-gateway] 发件簿记账失败（${entry.phase} ${entry.taskId || entry.chatId}）：${String(error?.message || error).slice(0, 120)}`)
  }
}

// 群里 / 私信里对任务说一句。返回 { ok, messageId, gated, reason, via }。
export const sendReply = async ({ config = {}, store, task, phase, text, mentions = [], idempotencyKey, deps = {} }) => {
  const policy = groupPhasePolicy(phase)
  if (!policy) {
    const reason = `群消息类型 ${phase} 不在出口规则表（lib/lark-group-phases.mjs），拒发`
    console.error(`[lark-gateway] ${task?.id || '?'}：${reason}`)
    return { ok: false, messageId: null, gated: false, reason, via: null }
  }
  if (!task?.chatId) return { ok: false, messageId: null, gated: false, reason: 'missing chatId', via: null }
  const rendered = dedupeMentions(renderMentions(text, mentions))
  // overflow=to_doc：群消息只放结论（aven 2026-10-22），仍超长就整段转云文档、群里留第一行 + 链接；不截断，建不成原样发。
  const publish = deps.publish || ((args) => publishMarkdownDoc({ ...args, identity: config.docIdentity || 'user' }))
  const { text: body } = policy.overflow === 'to_doc'
    ? await keepGroupTextShort({ text: rendered, title: `${headline(task) || task.id}（完整内容）`, publish })
    : { text: rendered }
  // fullText：超长转文档前的原文。别人复制 bot 的话来回复时按它找原消息（lark-quote-lookup），被转进文档的那部分也得搜得到。
  const entry = { chatId: task.chatId, taskId: task.id || null, topic: task.topic || null, phase, to: task.operator || null, mentions: mentions.map((m) => m.openId).filter(Boolean), text: body, ...(rendered !== body ? { fullText: rendered } : {}) }
  let gate = { send: true }
  try {
    gate = shouldSend({ chatId: task.chatId, topic: task.topic || null, phase, to: task.operator || null, text: body })
  } catch {
    // 闸出错不拦
  }
  if (!gate.send) {
    console.log(`[lark-gateway] 出口闸拦下 ${phase} ${task.id || ''}：${gate.reason}`)
    safeRecord({ ...entry, gated: gate.reason })
    return { ok: false, messageId: null, gated: true, reason: `出口闸拦下：${gate.reason}`, via: null }
  }
  const logPrefix = `${phase} ${task.id || ''}`.trim()
  const anchorId = task.replyTarget?.messageId || task.messageId
  // 群里不是「回复那条 @bot 的消息」时（没有原消息可回 / 回复失败回落直发）就 @当事人，让人知道是对谁说的（aven 11-02）。
  const inGroup = String(task.chatId).startsWith('oc_') && task.chatType !== 'p2p' && task.intake?.trigger !== 'dm'
  const asker = inGroup && String(task.operator || '').startsWith('ou_') && !body.includes(`user_id="${task.operator}"`) ? task.operator : null
  const plainBody = asker ? `${mentionTag(asker)} ${body}` : body
  const sent = policy.anchor === 'reply_origin' && anchorId
    ? await (deps.replyMarkdown || replyMarkdownCli)({ messageId: anchorId, markdown: body, inThread: Boolean(task.replyTarget?.inThread), fallbackChatId: task.chatId, fallbackMarkdown: plainBody, logPrefix, ...(idempotencyKey ? { idempotencyKey } : {}) })
    : { ...(await (deps.sendMarkdown || sendMarkdownCli)({ chatId: task.chatId, markdown: plainBody, logPrefix, ...(idempotencyKey ? { idempotencyKey } : {}) })), via: 'send' }
  if (!sent.ok) return { ok: false, messageId: null, gated: false, reason: sent.reason || '发送失败', via: sent.via || null }
  safeRecord({ ...entry, messageId: sent.messageId })
  // bot 在群里回了任务（含 bug 表任务回到项目群）：这个群还在用，记一笔活跃（自动退闲置群，lib/lark-chat-retention.mjs）。
  if (inGroup) recordChatActivity({ chatId: task.chatId, chatType: task.chatType })
  if (policy.receipt === 'task' && sent.messageId) store?.recordReceipt?.(task.id, { messageId: sent.messageId, kind: phase, epoch: task.epoch || 0, chatId: task.chatId })
  return { ok: true, messageId: sent.messageId || null, gated: false, reason: null, via: sent.via || 'send' }
}

// 私信负责人一句（config.notifyOpenId）：发件簿按他的 open_id 记；带 taskId 的登记成任务回执（kind = 回执类型：suspected / held / ignored_after_ack …），
// 他回复这条私信就能锚回任务（主通道 §3.4）。没配 notifyOpenId 不发。
export const sendPrincipalNote = async ({ config = {}, store, text, taskId = null, kind = 'private', idempotencyKey, deps = {} }) => {
  const to = config.notifyOpenId
  if (!to) {
    console.warn(`[lark-gateway] 没配 notifyOpenId，${kind}${taskId ? ` ${taskId}` : ''} 私信不发`)
    return { ok: false, messageId: null, reason: 'no notifyOpenId' }
  }
  const task = taskId ? store?.get?.(taskId) : null
  const sent = await (deps.sendMarkdown || sendMarkdownCli)({ chatId: to, markdown: text, logPrefix: `${kind}${taskId ? ` ${taskId}` : ''}`, ...(idempotencyKey ? { idempotencyKey } : {}) })
  if (!sent.ok) return { ok: false, messageId: null, reason: sent.reason || '发送失败' }
  safeRecord({ chatId: to, taskId, topic: task?.topic || null, phase: kind, to, text, messageId: sent.messageId })
  // 11-02 复核：按 open_id 发的私信落在 p2p 会话里，他回过来的消息 chat_id 是 oc_；发送结果带 chatId（真实 p2p chat_id）就记它，没带仍记 open_id
  //（lark-principal-channel latestDmReceipt 两种都认）。发件簿照旧按 open_id 记。
  if (taskId && sent.messageId) store?.recordReceipt?.(taskId, { messageId: sent.messageId, kind, epoch: task?.epoch || 0, chatId: sent.chatId || to })
  return { ok: true, messageId: sent.messageId || null, reason: null }
}
