/**
 * 一条 @bot / 私信的上下文包（网关 IO；11-01 对话层，母本是 falive lark-ingest 的上下文段）：
 *   · 被引用消息 + 话题其它回复（原有）；
 *   · 【群里这条之前的消息】：本群紧挨着的最近 20 条，含 bot 自己说的（对方的短句常接 bot 上一句，falive #23），不按时间窗截（#74）；
 *   · 对话数据（lib/lark-conversation）：默认锚点、这个人正在进行的事、本群 7 天候选任务——落在 task.conversation，由分类提示渲染；
 *   · 别人贴 bot 以前说过的话来回复：按发件簿找回原消息（lib/lark-quote-lookup）；
 *   · 附件按来源标记（本条 / 被引用 / 话题回复 / 群里之前的消息），先发文档后单独 @bot 的把那份文档带上（#54 / #80）。
 * 任何一路拉取失败都退成空，绝不挡住建任务。
 */

import { buildConversationData } from './lark-conversation.mjs'
import { pickEarlierDoc, pickRecentAttachments, shortTime, applyRecentWindow, RECENT_CONTEXT_HOURS } from './lark-chat-context.mjs'
import { downloadAttachments, fetchRecentChatContext, fetchReferencedContext, fetchThreadContext } from './lark-cli.mjs'
import { hasDocAttachment, stripMentionNames } from './lark-message.mjs'
import { buildQuotedBotBlock } from './lark-quote-lookup.mjs'

const withOrigin = (list, origin) => (list || []).map((item) => ({ ...item, origin: item.origin || origin }))
const principalsOf = (config) => [config?.notifyOpenId, ...(Array.isArray(config?.allowedOpenIds) ? config.allowedOpenIds : [])].filter(Boolean)

export const buildConversationBundle = async ({ msg, config, store, project = null, deps = {} }) => {
  const fetchRef = deps.fetchReferencedContext || fetchReferencedContext
  const fetchThread = deps.fetchThreadContext || fetchThreadContext
  const fetchRecent = deps.fetchRecentChatContext || fetchRecentChatContext
  const download = deps.downloadAttachments || downloadAttachments
  const botOpenIds = [config?.botOpenId, config?.botAppId].filter(Boolean)
  const safe = async (run, fallback) => {
    try {
      return await run()
    } catch (error) {
      console.warn(`[lark-gateway] ${msg.messageId} 上下文拉取失败（忽略）：${String(error?.message || error).slice(0, 120)}`)
      return fallback
    }
  }
  const refCtx = msg.replyTo ? await safe(() => fetchRef(msg.replyTo), null) : null
  const threadCtx = msg.replyTo ? await safe(() => fetchThread(msg.replyTo, { excludeIds: [msg.messageId, msg.replyTo], botOpenIds }), []) : []
  const fetchedRecent = msg.createTimeMs
    ? await safe(() => fetchRecent({ chatId: msg.chatId, beforeMs: msg.createTimeMs, excludeIds: [msg.messageId, msg.replyTo, ...threadCtx.map((item) => item.messageId)], botOpenIds }), [])
    : []
  // 近 recentContextHours 小时全留，更早的只留 bot 自己的话和本人的话（lark-chat-context.applyRecentWindow；配 0 = 不截）。
  const recentHours = Number(config?.recentContextHours ?? RECENT_CONTEXT_HOURS)
  const recentCtx = applyRecentWindow(fetchedRecent, { beforeMs: msg.createTimeMs, windowMs: recentHours * 3_600_000, senderOpenId: msg.senderOpenId })
  if (recentCtx.length < fetchedRecent.length) console.log(`[lark-gateway] ${msg.messageId} 群里之前的消息：${fetchedRecent.length} 条里去掉 ${fetchedRecent.length - recentCtx.length} 条 ${recentHours} 小时前的（bot 和本人的话留着）`)
  const threadReplies = threadCtx.filter((item) => item.text).map((item) => `${item.sender ? `${item.sender}：` : ''}${item.text}`).join('\n')
  const refLabel = [refCtx?.sender, shortTime(refCtx?.createTime)].filter(Boolean).join(' ')
  const quotedBlock = refCtx?.text
    ? `【被引用消息】${refLabel ? `（${refLabel}）` : ''}\n${refCtx.text}\n\n【本条 @】${msg.text || '（无附言）'}`
    : msg.text || (!msg.replyTo && !msg.attachments?.length ? '【本条 @】（无附言，只 @ 了机器人）' : '') // 光 @ 没正文：标出来给分类器（11-03）；引用拉不到的照旧空
  const recentBlock = recentCtx.map((item) => `${item.sender || ''}${item.time ? `（${item.time}）` : ''}${item.sender || item.time ? '：' : ''}${item.text}`).join('\n')
  const mergedText = `${quotedBlock}${threadReplies ? `\n\n【话题其它回复】\n${threadReplies}` : ''}${recentBlock ? `\n\n【群里这条之前的消息】\n${recentBlock}` : ''}`.trim()
  const quotedBotBlock = buildQuotedBotBlock({ ownText: msg.text, chatIds: [msg.chatId] })
  if (quotedBotBlock) console.log(`[lark-gateway] ${msg.messageId} 复制了 bot 之前的话，带上原消息`)
  const conversation = buildConversationData({ store, msg })
  if (conversation.anchor) console.log(`[lark-gateway] 默认锚点：${msg.messageId} 接 bot 对他说的（任务 ${conversation.anchor.taskId}）`)

  const attachmentProject = project || config?.project
  const own = await download({ project: attachmentProject, messageId: msg.messageId, attachments: withOrigin(msg.attachments, '本条') })
  const ref = refCtx?.attachments?.length
    ? await download({ project: attachmentProject, messageId: msg.replyTo, attachments: withOrigin(refCtx.attachments, `被引用消息${refLabel ? ` · ${refLabel}` : ''}`) })
    : []
  const thread = (await Promise.all(threadCtx
    .filter((item) => item.attachments?.length)
    .map((item) => download({ project: attachmentProject, messageId: item.messageId, attachments: withOrigin(item.attachments, `话题回复 · ${item.sender || ''}`.trim()) })))).flat()
  // 先发文档、后单独 @bot：从群里之前的消息补上最近那份文档，只认本条确实在接的（同一人紧接着 / 原话提到文档）。
  const hasOwnDoc = [msg.attachments, refCtx?.attachments, ...threadCtx.map((item) => item.attachments)].some((list) => hasDocAttachment(list || []))
  const earlierDoc = !hasOwnDoc && !msg.replyTo
    ? pickEarlierDoc(recentCtx, { excludeSenders: principalsOf(config), senderOpenId: msg.senderOpenId, ownText: stripMentionNames(msg.text || '', msg.mentions) })
    : null
  const earlier = earlierDoc
    ? await download({ project: attachmentProject, messageId: earlierDoc.messageId, attachments: withOrigin(earlierDoc.docs, `群里之前的消息 · ${earlierDoc.sender || ''} ${earlierDoc.time || ''}`.trim()) })
    : []
  const recentPicked = pickRecentAttachments(recentCtx, { maxImages: 8, maxFiles: 4 })
  const recent = (await Promise.all(recentPicked.map(({ item, attachments }) =>
    download({ project: attachmentProject, messageId: item.messageId, attachments: withOrigin(attachments, `群里之前的消息 · ${item.sender || ''} ${item.time || ''}`.trim()) })))).flat()

  return {
    text: [mergedText, quotedBotBlock].filter(Boolean).join('\n\n'),
    attachments: [...own, ...ref, ...thread, ...earlier, ...recent],
    threadSpeakers: threadCtx.map((item) => item.senderOpenId).filter(Boolean).slice(-10),
    conversation,
    refText: refCtx?.text || null,
    // 引用的是 bot 自己的消息（回执索引能查到）：分类走快道，上下文里也已带着那条。
    quotedOwnCard: Boolean(msg.replyTo && (store.findTaskByAnyReceipt?.(msg.replyTo) || store.findByReceiptMessageId?.(msg.replyTo))),
  }
}
