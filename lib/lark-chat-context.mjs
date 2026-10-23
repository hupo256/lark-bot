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
// 截断不留半截链接（10-22 Bug-4944：bot 发过的云文档链接被切成 docx/CfbhdAyS，worker 当成必读 PRD 去抓、失败、停任务）：
// 切点落在链接中间就把这段链接整个去掉，补「…」。群消息上下文与「正在进行的事」共用。
export const clipText = (text, max) => {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const partial = /\S/.test(text[max]) && cut.match(/\[?https?:\/\/\S*$/) // 链接正好在切点结束的是完整的，保留
  return `${partial ? cut.slice(0, partial.index).trimEnd() : cut}…`
}
// 消息时间 → 「10-23 13:28」：lark-cli 给的已是本地时间字符串，直接截；万一是时间戳按本地时间换。
const pad2 = (n) => String(n).padStart(2, '0')
export const shortTime = (value) => {
  const raw = String(value ?? '')
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(raw)) return raw.slice(5, 16)
  const ms = toEpochMs(value)
  if (!ms) return ''
  const d = new Date(ms)
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

// 群里 @bot 之前的消息（10-23 起外部群只响应 @bot，没 @ 的讨论只能靠这里带进 @bot 任务，要读全）：
// · 真人消息正文上限 2000 字（原 300），截断不切链接；纯图片 / 文件消息也留下，附件交调用方下载；
// · 本群我们自己的 bot 卡照旧（对方的短句常接 bot 上一句，教训 #23）；别家机器人（部署通知、工单机器人）也留，标「机器人」；
// · 系统消息（拉人进群等）不要。
const HUMAN_TEXT_MAX = 2000
const describeAttachments = (attachments = []) => {
  const images = attachments.filter((item) => item.type === 'image').length
  const files = attachments.filter((item) => item.type === 'file').map((item) => item.fileName || '文件')
  return [images ? `（发了 ${images} 张图）` : '', files.length ? `（发了文件：${files.join('、')}）` : ''].join('')
}
export const pickRecentContext = (messages, { beforeMs, excludeIds = [], botOpenIds = [], limit = 20 }) => {
  const exclude = new Set(excludeIds.filter(Boolean))
  const bots = new Set(botOpenIds.filter(Boolean))
  const out = []
  for (const m of messages || []) {
    if (!m || exclude.has(m.message_id) || m.msg_type === 'system' || m.deleted) continue
    const senderType = m.sender?.sender_type
    if (!senderType) continue // 没有发送人的是系统消息
    const at = toEpochMs(m.create_time)
    if (at && at >= beforeMs) continue
    const isBot = senderType !== 'user'
    const ownBot = isBot && bots.has(m.sender?.open_bot_id)
    const { text, attachments } = parseFetchedMessage(m.msg_type, m.content)
    const time = shortTime(m.create_time)
    if (isBot) {
      const trimmed = stripCardText(text)
      if (!trimmed) continue
      // bot 的话本来就短（写短 + 细节进文档），不截；附件不下（卡片里的图是我们自己发的）。
      out.push({ messageId: m.message_id, sender: `${m.sender?.name || 'bot'}（${ownBot ? 'bot，我们自己' : '机器人'}）`, time, text: trimmed, attachments: [], bot: true })
      continue
    }
    const docs = (attachments || []).filter((item) => hasDocAttachment([item]))
    const others = (attachments || []).filter((item) => !hasDocAttachment([item]))
    // 图片 / 文件的占位（[Image: img_x]、![Image](img_x)、<file key=… />）对模型没意义，统一由 describeAttachments 说「发了几张图 / 什么文件」。
    const body = String(text || '').replace(/\[Image:\s*[^\]]*\]|!\[Image\]\([^)]*\)|<file\b[^>]*\/>/g, '').replace(/[ \t]+\n/g, '\n').trim()
    const trimmed = [body ? clipText(body, HUMAN_TEXT_MAX) : '', describeAttachments(attachments)].filter(Boolean).join(' ')
    if (!trimmed) continue
    out.push({
      messageId: m.message_id,
      sender: m.sender?.name || '',
      senderOpenId: m.sender?.id || '',
      time,
      text: trimmed,
      attachments: others, // 图片 / 普通文件：调用方按 messageId 下载；对接文档另走 pickEarlierDoc（只取最近一份）
      ...(docs.length ? { docs } : {}),
    })
  }
  return out.slice(-limit)
}

// 群里之前的消息里要下载的附件：从新到旧挑，图片最多 maxImages 张、普通文件最多 maxFiles 个（离 @bot 越近越相关）。
// 返回按消息分组的 [{ item, attachments }]，调用方按各自 messageId 下载。纯函数。
export const pickRecentAttachments = (recent = [], { maxImages = 8, maxFiles = 4 } = {}) => {
  let images = 0
  let files = 0
  const out = []
  for (const item of [...recent].reverse()) {
    const picked = (item.attachments || []).filter((att) => {
      if (att.type === 'image' && images < maxImages) return (images += 1)
      if (att.type === 'file' && files < maxFiles) return (files += 1)
      return false
    })
    if (picked.length) out.push({ item, attachments: picked })
  }
  return out
}

// 单独 @bot、本条和被回复 / 话题里都没带文档时，取它之前最近一条发了文档的消息（只取一条，别把无关的旧文档一起带上）；
// 负责人本人发的是我方发出的对接文档，不算要接的（同 ingest 对 meOpenIds 发文档的口径）。
// 只有确实是本条在接的才并入（10-23 #80：Encone 只发截图问开播 500，被并进 Arthur 一小时前发的头像文档，任务被判成文档入库）：
//   · 同一个人发完文档紧接着 @bot（中间没有别人 / bot 的消息）；或
//   · 本条原话在说那份文档（提到文件名，或「文档 / 文件 / 附件 / 清单」这类指代）。
// 其它情况文档只留在「群里这条之前的消息」的文字里（「（发了文件：…）」），不当本条附件。纯函数。
const DOC_REF_RE = /文档|文件|附件|清单|\.(?:md|docx?|pdf|xlsx?)\b/i
const docStem = (name) => String(name || '').replace(/^\d+-/, '').replace(/\.[a-z0-9]+$/i, '').trim()
export const pickEarlierDoc = (recent = [], { excludeSenders = [], senderOpenId = null, ownText = '' } = {}) => {
  const index = recent.findLastIndex((item) => item.docs?.length && !excludeSenders.includes(item.senderOpenId))
  if (index < 0) return null
  const item = recent[index]
  const sameSenderRightBefore = Boolean(senderOpenId) && item.senderOpenId === senderOpenId && recent.slice(index + 1).every((later) => !later.bot && later.senderOpenId === senderOpenId)
  const text = String(ownText || '')
  const refersToDoc = DOC_REF_RE.test(text) || item.docs.some((doc) => docStem(doc.fileName).length >= 2 && text.includes(docStem(doc.fileName)))
  return sameSenderRightBefore || refersToDoc ? item : null
}

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
      if (trimmed) out.push({ messageId: m.message_id, sender: `${m.sender?.name || 'bot'}（bot，我们自己）`, senderOpenId: '', text: trimmed, attachments: [], bot: true }) // bot 自己的话本来就短（写短 + 细节进文档），不截
      continue
    }
    const trimmed = String(text || '').trim()
    if (!trimmed && !attachments.length) continue
    out.push({ messageId: m.message_id, sender: m.sender?.name || '', senderOpenId: m.sender?.id || '', text: trimmed, attachments })
  }
  return out.slice(-limit)
}
