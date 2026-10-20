/**
 * 群 / 话题上下文的纯挑选逻辑（从 lark-cli.mjs 拆出，体量预算）：拉取在 lark-cli.mjs，这里只解析与挑选，单测见 __tests__/lark-chat-poller.test.mjs。
 */

import { hasDocAttachment, parseTextAndAttachments, toEpochMs } from './lark-message.mjs'

// 把 mget / threads-messages-list 返回的单条消息解析为 { text, attachments }。
// text / merge_forward 的 content 已是可读字符串直接用；image 从 JSON 取 image_key；其余走 parseTextAndAttachments。
export const parseFetchedMessage = (msgType, content) => {
  if (typeof content === 'string' && !content.trim().startsWith('{')) {
    return parseTextAndAttachments({ messageType: msgType, rawContent: content, mentions: [] })
  }
  if (msgType === 'image') {
    try {
      const parsed = JSON.parse(content)
      return { text: '', attachments: parsed.image_key ? [{ type: 'image', imageKey: parsed.image_key }] : [] }
    } catch {
      return { text: '', attachments: [] }
    }
  }
  return parseTextAndAttachments({ messageType: msgType, rawContent: content, mentions: [] })
}

// 群里这条消息之前的最近几条消息（外部群的讨论常不在话题里、也不引用：「充值就不知道了」这种一句话
// 离开前后文根本判断不了是谁的事）。按时间窗拉一页、取最后 limit 条，排除已并入的消息。真人消息都要；
// 机器人消息只要本群自定义机器人自己发的卡（sender.open_bot_id ∈ botOpenIds）——对方的短句接的往往是 bot 上一张卡
// （2026-10-15 真机：bot 刚说「需要的话我重跑一次」，Arthur 回「@Aven.Bot 重跑一次」，分类器看不到自己那句就答「没看出是哪条」）。
const BOT_SIGNATURE_LINE = /^\s*(📝\s*)?由 .+ 的助手整理\s*$/
const stripCardText = (text) => String(text || '')
  .replace(/<\/?card>/g, '\n')
  .split('\n')
  .map((line) => line.trimEnd())
  .filter((line) => line.trim() && !BOT_SIGNATURE_LINE.test(line))
  .join('\n')
  .trim()
export const pickRecentContext = (messages, { beforeMs, excludeIds = [], botOpenIds = [], limit = 10 }) => {
  const exclude = new Set(excludeIds.filter(Boolean))
  const bots = new Set(botOpenIds.filter(Boolean))
  const out = []
  for (const m of messages || []) {
    if (!m || exclude.has(m.message_id)) continue
    const senderType = m.sender?.sender_type
    const ownBot = senderType === 'app' && bots.has(m.sender?.open_bot_id)
    if (senderType && senderType !== 'user' && !ownBot) continue
    const at = toEpochMs(m.create_time)
    if (at && at >= beforeMs) continue
    const { text, attachments } = parseFetchedMessage(m.msg_type, m.content)
    // 真人单独发的文档（文件消息没有正文）也留下：后续单独 @bot 叫处理时，文档就在这里（教训 #54）。
    const docs = ownBot ? [] : (attachments || []).filter((item) => hasDocAttachment([item]))
    const trimmed = ownBot ? stripCardText(text) : String(text || '').trim() || (docs.length ? `（发了文件：${docs.map((item) => item.fileName).join('、')}）` : '')
    if (!trimmed) continue
    out.push({
      messageId: m.message_id,
      sender: ownBot ? `${m.sender?.name || 'bot'}（bot，我们自己）` : m.sender?.name || '',
      text: trimmed.slice(0, 300),
      ...(ownBot ? { bot: true } : {}),
      ...(docs.length ? { docs, senderOpenId: m.sender?.id || '' } : {}),
    })
  }
  return out.slice(-limit)
}

// 单独 @bot、本条和被回复 / 话题里都没带文档时，取它之前最近一条发了文档的消息（只取一条，别把无关的旧文档一起带上）；
// 负责人本人发的是我方发出的对接文档，不算要接的（同 ingest 对 meOpenIds 发文档的口径）。
export const pickEarlierDoc = (recent = [], { excludeSenders = [] } = {}) =>
  [...recent].reverse().find((item) => item.docs?.length && !excludeSenders.includes(item.senderOpenId)) || null

// messages 须按时间正序；只留最近 limit 条。
export const pickThreadContext = (messages, { excludeIds = [], botOpenIds = [], limit = 40 } = {}) => {
  const exclude = new Set(excludeIds.filter(Boolean))
  const bots = new Set(botOpenIds.filter(Boolean))
  const out = []
  for (const m of messages || []) {
    if (!m || exclude.has(m.message_id)) continue
    const senderType = m.sender?.sender_type
    const ownBot = senderType === 'app' && bots.has(m.sender?.open_bot_id)
    if (senderType && senderType !== 'user' && !ownBot) continue
    const { text, attachments } = parseFetchedMessage(m.msg_type, m.content)
    if (ownBot) {
      const trimmed = stripCardText(text)
      if (trimmed) out.push({ messageId: m.message_id, sender: `${m.sender?.name || 'bot'}（bot，我们自己）`, senderOpenId: '', text: trimmed.slice(0, 600), attachments: [], bot: true })
      continue
    }
    const trimmed = String(text || '').trim()
    if (!trimmed && !attachments.length) continue
    out.push({ messageId: m.message_id, sender: m.sender?.name || '', senderOpenId: m.sender?.id || '', text: trimmed, attachments })
  }
  return out.slice(-limit)
}
