/**
 * Lark 消息归一化 + 信任判定（纯函数层，零副作用，可 `node --test` 直测）。
 *
 * 两种信封需统一：
 *   · lark-cli event consume（本项目采用）吐「拍平顶层」结构——message_id / chat_id /
 *     sender_id 均在顶层，content 是已内联 mention 名的纯文本，mentions[].id 是字符串。
 *   · 官方 webhook im.message.receive_v1 是「嵌套」结构——event.message.* + content 为
 *     JSON 字符串，sender.sender_id.open_id，mentions[].id 为 { open_id }。
 * 实测 lark-cli 形态样例见 apps/web/docs_tdd/PR-01947/agent/lark-integration.md。
 */

export const parseLine = (line) => {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

// mention.id：官方是 { open_id }，lark-cli 拍平结构是字符串
const mentionOpenId = (mention) => (typeof mention?.id === 'string' ? mention.id : mention?.id?.open_id)

// 去掉正文里内联的 @mention 文本（lark-cli 把占位符 @_user_1 替换成了 mention.name）
const stripMentions = (text, mentions) => {
  let out = text || ''
  for (const mention of mentions) {
    if (mention.name) out = out.split(`@${mention.name}`).join(' ')
    if (mention.key) out = out.split(mention.key).join(' ')
  }
  return out.replace(/\s+/g, ' ').trim()
}

// lark-cli 拉取引用消息 / 合并转发时，图片有时不会保留 post 结构，而是降成
// `[Image: img_xxx]` 或 `![Image](img_xxx)` 占位文本。把 image_key 恢复成附件，
// 后续仍由带 messageId 的下载接口取真实二进制；仅接受 image_key 形态并去重。
export const extractInlineImageAttachments = (text) => {
  const input = String(text || '')
  const keys = []
  const patterns = [
    /\[Image:\s*(img_[\w-]+)\]/gi,
    /!\[Image\]\((img_[\w-]+)\)/gi,
  ]
  for (const pattern of patterns) {
    for (const match of input.matchAll(pattern)) keys.push(match[1])
  }
  return [...new Set(keys)].map((imageKey) => ({ type: 'image', imageKey }))
}

export const parseTextAndAttachments = ({ messageType, rawContent, mentions }) => {
  // lark-cli 拍平：content 已是纯文本；官方 webhook：content 是 JSON 字符串
  const looksJson = typeof rawContent === 'string' && rawContent.trim().startsWith('{')
  if (typeof rawContent === 'string' && !looksJson) {
    return { text: stripMentions(rawContent, mentions), attachments: extractInlineImageAttachments(rawContent) }
  }
  try {
    const content = typeof rawContent === 'string' ? JSON.parse(rawContent || '{}') : rawContent || {}
    if (messageType === 'post') {
      const blocks = Object.values(content).flatMap((locale) => locale?.content || [])
      const flat = blocks.flat()
      const text = flat
        .filter((el) => el.tag === 'text' || el.tag === 'a')
        .map((el) => el.text || el.href || '')
        .join(' ')
        .trim()
      const attachments = flat
        .filter((el) => el.tag === 'img')
        .map((el) => ({ type: 'image', imageKey: el.image_key, width: el.width, height: el.height }))
      return { text: stripMentions(text, mentions), attachments }
    }
    return {
      text: stripMentions(content.text || '', mentions),
      attachments: extractInlineImageAttachments(content.text || ''),
    }
  } catch {
    return { text: '', attachments: [] }
  }
}

// 把任意信封归一成 canonical message；非消息事件（无 message_id）返回 null
export const normalizeMessage = (raw) => {
  if (!raw || typeof raw !== 'object') return null
  const nested = raw.event || raw.data?.event
  const message = nested?.message ? nested.message : raw
  const messageId = message.message_id || raw.message_id
  if (!messageId) return null

  const mentions = (message.mentions || raw.mentions || []).map((mention) => ({
    id: mentionOpenId(mention),
    key: mention.key,
    name: mention.name,
  }))
  const messageType = message.message_type || raw.message_type
  const { text, attachments } = parseTextAndAttachments({
    messageType,
    rawContent: message.content ?? raw.content,
    mentions,
  })

  return {
    messageId,
    chatId: message.chat_id || raw.chat_id,
    chatType: message.chat_type || raw.chat_type,
    messageType,
    senderOpenId: nested?.sender?.sender_id?.open_id || raw.sender_id || raw.sender?.sender_id?.open_id || 'unknown',
    mentions,
    text,
    attachments,
    // 回复/引用上下文：用户常在 QA 的原始 bug 消息下回复 + @bug，真正 bug 正文在被引用消息里
    replyTo: message.reply_to || raw.reply_to || message.root_id || raw.root_id,
  }
}

// @机器人判定：p2p 直发始终算；群里需 mentions 命中 botOpenId（或 @所有人）
export const isForBot = ({ msg, config }) => {
  if (msg.chatType === 'p2p') return true
  const mentions = msg.mentions || []
  if (!config.botOpenId) return mentions.length > 0
  return mentions.some((mention) => mention.id === config.botOpenId || mention.key === '@_all')
}

// 白名单校验（纯同步）。信任边界是**白名单群**：群里 QA / PM / 后台 @ 都要能触发，故群消息只按群放行、
// 不再按发送人过滤。硬规则：完全没配任何白名单（群 + 用户皆空）时 fail-closed 拒绝所有事件，
// 避免配置漏填导致任何人 @ 都能触发无监督改代码（曾经是 fail-open）。
// p2p 直发没有群作信任锚点，只放行显式配置的白名单用户（auto 与静态模式一致）。
// 动态成员制（allowedChatIds:'auto'）：白名单 = bot 当前所在的群。「群成员资格」本身即信任边界，
// 由调用方用 lark-cli 解析后把结果作 isMember 注入进来（保持本函数纯同步、可单测）。
export const isWhitelisted = ({ msg, config, isMember = false }) => {
  const users = config.allowedOpenIds || []
  const chats = config.allowedChatIds
  // p2p 无群锚点：任何模式都只放行显式白名单用户（users 为空即 fail-closed）
  if (msg.chatType === 'p2p') return users.includes(msg.senderOpenId)
  if (chats === 'auto') return isMember
  const list = Array.isArray(chats) ? chats : []
  if (!list.length && !users.length) return false // fail-closed：未配置 = 拒绝
  return list.includes(msg.chatId)
}

export const summarize = (text) => (text || '').split('\n').find((line) => line.trim())?.trim().slice(0, 80) || '群内任务'

// 项目号词边界匹配：`\b(PR|PM)-\d{3,}\b`。词边界避免吞子串——`SUPR-01947` 里 `U`/`P` 同为词字符，
// `\bPR` 不会命中（否则会把 `SUPR-01947` 误路由成 `PR-01947`）。大写归一。整串校验与自由文本提取共用同一正则，
// 消除「poller 用锚定 `^…$`、parseProjectFromText 用无锚定」两链路对同一字符串解析出不同项目号的误路由。
export const PROJECT_ID_RE = /\b(PR|PM)-\d{3,}\b/i

// 从自由文本（群名 / 正文）提取首个项目号，无则 null。
export const matchProjectId = (text) => {
  const match = String(text || '').match(PROJECT_ID_RE)
  return match ? match[0].toUpperCase() : null
}

// 整串校验单个值是否恰为合法项目号（bug 表「项目ID」单元格用）：trim 后必须整串匹配，
// 不接受「值里夹带项目号」这类脏单元格（如 `../../PR-01947`），交 worker 走 adhoc。
export const isProjectId = (value) => {
  const trimmed = String(value || '').trim()
  return trimmed !== '' && new RegExp(`^${PROJECT_ID_RE.source}$`, 'i').test(trimmed)
}

// 群 @ 任务可在正文写项目号（PR-#### / PM-####）指定目标仓库，取首个匹配（大写归一）；
// 无则回落群绑定的 config.project。worker 的 resolveWorkContext 会据此路由到对应 worktree / 主仓 hotfix。
export const parseProjectFromText = (text) => matchProjectId(text)

// 命令类型：任务首行以「类型：…」（中/英前缀 + 冒号）开头时归一为规范命令类型。
// 首个命中规则胜出，都不命中则 null（普通 bug 修复正文）。Gateway 落 task.commandType，
// worker 据此对只读命令走轻量分流（跳过临时 worktree 准备与代码提交）。
const COMMAND_TYPE_RULES = [
  { type: 'status', re: /^\s*(?:状态|status)\s*[:：]/i },
  { type: 'docs', re: /^\s*(?:文档|docs)\s*[:：]/i },
  { type: 'fix', re: /^\s*(?:修复|fix)\s*[:：]/i },
  { type: 'test', re: /^\s*(?:自测|test)\s*[:：]/i },
  { type: 'api', re: /^\s*(?:api)\s*[:：]/i },
  { type: 'qa', re: /^\s*(?:qa)\s*[:：]/i },
]

// 只读命令：不改代码，worker 跳过临时 worktree 准备与代码提交闸，无本地 worktree 时就地在主仓只读回答。
export const READ_ONLY_COMMAND_TYPES = new Set(['status'])

export const parseCommandType = (text) => {
  const firstLine = String(text || '').split('\n').find((line) => line.trim()) || ''
  return COMMAND_TYPE_RULES.find(({ re }) => re.test(firstLine))?.type || null
}

export const isReadOnlyCommand = (commandType) => READ_ONLY_COMMAND_TYPES.has(commandType)
