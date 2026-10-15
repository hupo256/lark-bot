/**
 * lark-cli 子进程封装 + 依赖它的 IO（发消息、下载附件、群名缓存、拉引用消息）。
 * 事件源用长连接、bot 身份鉴权走 lark-cli 已登录态（keychain），无需 webhook secret / appSecret。
 */

import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { parseTextAndAttachments, toEpochMs } from './lark-message.mjs'
import { matchProjectId } from './lark-project-id.mjs'
import { attachmentsDirFor } from './lark-paths.mjs'
import { repoProfileForProjectKey, resolveRepoDelivery } from './lark-repo-profile.mjs'
import { sendWebhookMessage } from './lark-webhook.mjs'
import { sleep } from './lark-gateway-client.mjs'

export const larkCliBin = process.env.LARK_CLI_BIN || 'lark-cli'
// lark-cli 子进程超时兜底：卡网/卡登录时不让调用永久挂起（默认 60s）
const larkCliTimeoutMs = Number(process.env.LARK_CLI_TIMEOUT_MS || 60000)

// 把 lark-cli 命令包成 Promise，返回 { code, stdout, stderr }。带超时兜底：
// 到点先 SIGTERM，宽限 3s 仍未退再 SIGKILL，并立即以 code -1 结算，避免调用方永久挂起。
export const runLarkCli = (args, { timeoutMs = larkCliTimeoutMs, cwd, identity = 'bot' } = {}) =>
  new Promise((resolve) => {
    // 默认 bot 身份：lark-cli `defaultAs:auto` 在同时登录了 user + bot 时会解析成 user，
    // 导致发消息/读表报 missing_scope。只有外部群（bot 进不去）的读消息 / 下附件才显式走 user 身份。
    const child = spawn(larkCliBin, ['--as', identity === 'user' ? 'user' : 'bot', ...args], { stdio: ['ignore', 'pipe', 'pipe'], cwd })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // 进程可能已退出
        }
      }, 3000)
      finish({ code: -1, stdout, stderr: `${stderr}\n[lark-cli timeout after ${timeoutMs}ms]`.slice(-200) })
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => finish({ code: -1, stdout, stderr: String(error) }))
    child.on('exit', (code) => finish({ code, stdout, stderr }))
  })

// lark-cli 成功判定：进程 0 退出且 stdout 未含 "ok":false
export const larkCallFailed = (result) => result.code !== 0 || /"ok"\s*:\s*false/.test(result.stdout)

// 把 lark-cli 失败结果压成一行人类可读原因：优先解析结构化 error（type/subtype/message），
// 退回 stderr/stdout。给告警卡 / 日志用，避免把截断到半句的原始 JSON 塞给人看。
export const formatLarkCliError = (result) => {
  const raw = (result?.stdout || '').trim()
  try {
    const err = JSON.parse(raw)?.error
    if (err && (err.type || err.message)) {
      const kind = [err.type, err.subtype].filter(Boolean).join('/')
      const msg = String(err.message || '').replace(/\s+/g, ' ').trim()
      return [kind, msg].filter(Boolean).join(': ').slice(0, 200)
    }
  } catch {
    // 非 JSON（超时 / spawn error 等）：落到 stderr/stdout
  }
  return ((result?.stderr || raw || '未知错误').replace(/\s+/g, ' ').trim()).slice(0, 200)
}

// 判定失败是否为可重试的瞬时错误：网络层（DNS/拨号/连接抖动）或本地 spawn/超时（code=-1）。
// 权限 / scope / 参数类错误不可重试——重试也不会好，应尽快失败以触发告警，不拖延对上游的响应。
export const isTransientLarkError = (result) => {
  if (result?.code === -1) return true
  try {
    return JSON.parse(result?.stdout || '')?.error?.type === 'network'
  } catch {
    return false
  }
}

// 通用「调用 + 重试 + 退避」封装（发消息 / bug 表回写共用）。返回 { ok, reason }。
export const runLarkCliWithRetry = async (args, { logPrefix, retries = 3 } = {}) => {
  let reason = ''
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const result = await runLarkCli(args)
    if (!larkCallFailed(result)) {
      console.log(`[lark-gateway] ${logPrefix} ok${attempt > 1 ? ` (attempt ${attempt})` : ''}`)
      return { ok: true, result }
    }
    reason = (result.stderr || result.stdout || '').slice(0, 200)
    console.error(`[lark-gateway] ${logPrefix} attempt ${attempt}/${retries} failed: ${reason}`)
    if (attempt < retries) await sleep(attempt * 1500)
  }
  console.error(`[lark-gateway] ${logPrefix} gave up after ${retries} attempts`)
  return { ok: false, reason }
}

// messages-send 成功输出在不同 lark-cli 版本中可能是 data.message_id、顶层 message_id，
// 或 data.message.message_id。统一提取后持久化，用户回复机器人回执卡时才能关联回原任务。
export const parseSentMessageId = (stdout) => {
  try {
    const payload = JSON.parse(String(stdout || ''))
    return payload?.data?.message_id || payload?.data?.message?.message_id || payload?.message_id || null
  } catch {
    return null
  }
}

// Lark 用 id 前缀区分收信方：ou_ 是用户 open_id（私聊），其余（oc_ 群）走 chat_id。
// messages-send 的 --user-id / --chat-id 互斥，据此自动择一——让同一个 chatId 字段既能指群也能指人，
// bug 表兜底才能在找不到项目群时私聊负责人，而无需给整条发送链路（worker/status/writeback）另加收信方类型字段。
export const messageSendRecipientArgs = (recipientId) => {
  const id = String(recipientId || '')
  return id.startsWith('ou_') ? ['--user-id', id] : ['--chat-id', id]
}

// 发消息，带重试（网络/DNS 抖动时不丢消息）。idempotencyKey 让重试不会重复发（Lark 侧去重）。
// chatId 可为群 chat_id(oc_) 或用户 open_id(ou_)——见 messageSendRecipientArgs。
// 传 card（interactive 卡片 content JSON）优先走卡片；否则回退纯文本 text。
export const sendChatMessage = async ({ chatId, text, card, logPrefix, idempotencyKey, retries = 3 }) => {
  if (!chatId) {
    console.warn(`[lark-gateway] ${logPrefix}: skipped, missing chatId`)
    return { ok: false, reason: 'missing chatId' }
  }
  // 多仓 profile 的群：先用 bot 身份发（能进群就有 message_id、能被回复锚定）；外部群 bot 进不去时按
  // webhook（自定义机器人，无 message_id）→ notifyChatId（私发负责人）兜底。bot 失败记忆 1 小时，期间直接走兜底，
  // 不让每张卡都先白等三次重试。默认仓的群 delivery 为 null，行为不变。
  const delivery = resolveRepoDelivery(chatId)
  if (delivery?.forceRedirect) {
    console.log(`[lark-gateway] ${logPrefix}: repo ${delivery.repo} 试运行期卡片只发负责人，${chatId} → ${delivery.redirectTo}`)
    return sendViaBot({ chatId: delivery.redirectTo, text, card, logPrefix, idempotencyKey, retries })
  }
  if (delivery) {
    const botBlockedUntil = botSendBlockedChats.get(chatId) || 0
    if (Date.now() >= botBlockedUntil) {
      const viaBot = await sendViaBot({ chatId, text, card, logPrefix, idempotencyKey, retries: 1 })
      if (viaBot.ok) return viaBot
      botSendBlockedChats.set(chatId, Date.now() + botSendBlockMs)
      console.warn(`[lark-gateway] ${logPrefix}: bot 身份发不进 ${chatId}（repo ${delivery.repo}），${botSendBlockMs / 60000}min 内改走兜底：${viaBot.reason}`)
    }
    if (delivery.webhook) {
      return sendWebhookMessage({ ...delivery.webhook, card, text, logPrefix: `${logPrefix} -> ${chatId}`, retries })
    }
    console.log(`[lark-gateway] ${logPrefix}: 群 ${chatId} 属 repo ${delivery.repo} 且未配 webhook，改投 ${delivery.redirectTo}`)
    chatId = delivery.redirectTo
  }
  return sendViaBot({ chatId, text, card, logPrefix, idempotencyKey, retries })
}

// bot 身份发不进去的群（外部群）：记一小时，期间直接走 webhook / 改投。
const botSendBlockedChats = new Map()
const botSendBlockMs = Number(process.env.LARK_BOT_SEND_BLOCK_MS || 60 * 60 * 1000)

const sendViaBot = async ({ chatId, text, card, logPrefix, idempotencyKey, retries = 3 }) => {
  const recipient = messageSendRecipientArgs(chatId)
  const args = card
    ? ['im', '+messages-send', ...recipient, '--msg-type', 'interactive', '--content', card]
    : ['im', '+messages-send', ...recipient, '--msg-type', 'text', '--text', text]
  if (idempotencyKey) {
    args.push('--idempotency-key', String(idempotencyKey).slice(0, 50))
  }
  const outcome = await runLarkCliWithRetry(args, { logPrefix: `${logPrefix} -> ${chatId}`, retries })
  if (!outcome.ok) return outcome
  return { ok: true, messageId: parseSentMessageId(outcome.result?.stdout) }
}

// bot 身份发 Markdown（lark-cli 自动转成 post 富文本）：给负责人私聊的人话消息用。chatId 为 ou_ 时走 --user-id。
// 返回 messageId，便于登记成回执锚点（人回复这条消息即可续跑 / 结单）。
export const sendBotMarkdown = async ({ chatId, markdown, logPrefix = 'markdown', retries = 3 }) => {
  const recipient = String(chatId).startsWith('ou_') ? ['--user-id', chatId] : ['--chat-id', chatId]
  let result
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    result = await runLarkCli(['im', '+messages-send', ...recipient, '--markdown', markdown, '--format', 'json'], { identity: 'bot' })
    if (!larkCallFailed(result)) return { ok: true, messageId: parseSentMessageId(result.stdout) }
    // 429（token 接口限流）/ 网络抖动：退避重试；参数类错误重试无意义。
    const reason = formatLarkCliError(result)
    if (!/429|transport|dns|timeout|ECONN/i.test(reason) || attempt === retries) {
      console.error(`[lark-gateway] ${logPrefix} -> ${chatId} 发送失败：${reason}`)
      return { ok: false, reason, messageId: null }
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 3000))
  }
  return { ok: false, reason: 'unreachable', messageId: null }
}

// 下载 post 图片到本地附件目录，写入 localPath。鉴权走 lark-cli 已登录的 bot 身份（keychain）。
// 落盘目录走 attachmentsDirFor（runtime/lark-attachments/<PR>/<messageId>/）：附件是 bot 运行态，
// 归 bot 自己的目录；清扫器 lark-retention.sweepAttachments 扫的是同一个根，两边口径必须一致。
// 读 / 下载身份：非默认仓（外部群，bot 不在群里）用用户身份；默认仓沿用 bot。
export const identityForProject = (project) => (repoProfileForProjectKey(project) ? 'user' : 'bot')

// 附件本地文件名：图片按 imageKey，文件保留原文件名（对接文档要原样落到仓库里，名字有意义）。
const attachmentFileName = (a, index) => {
  if (a.type === 'file') {
    const base = String(a.fileName || a.fileKey || 'file').replace(/[\\/:*?"<>|]/g, '_').replace(/\.\.+/g, '.').slice(0, 120)
    return `${index + 1}-${base}`
  }
  const safeKey = String(a.imageKey || 'img').replace(/[^\w.-]/g, '_').slice(0, 80)
  return `${index + 1}-${safeKey}.img`
}

export const downloadAttachments = async ({ project, messageId, attachments, identity = identityForProject(project) }) => {
  if (!attachments.length) return attachments
  const outDir = attachmentsDirFor(project, messageId)
  mkdirSync(outDir, { recursive: true })
  const resolved = []
  for (const [index, a] of attachments.entries()) {
    const isFile = a.type === 'file'
    const key = isFile ? a.fileKey : a.imageKey
    if (!key) {
      resolved.push({ ...a, downloadError: 'missing resource key' })
      continue
    }
    // 文件名会拼进本地路径，sanitize 掉路径分隔符等，避免越目录写入
    const fileName = attachmentFileName(a, index)
    // lark-cli `messages-resources-download` 的 --output 拒绝绝对路径（invalid_argument），
    // 故传相对文件名 + 把子进程 cwd 设到 outDir，落地路径仍是 join(outDir, fileName)。
    const result = await runLarkCli([
      'im', '+messages-resources-download',
      '--message-id', messageId,
      '--file-key', key,
      '--type', isFile ? 'file' : 'image',
      '--output', fileName,
    ], { cwd: outDir, identity })
    resolved.push(larkCallFailed(result)
      ? { ...a, downloadError: (result.stdout || result.stderr).slice(0, 200) }
      : { ...a, localPath: join(outDir, fileName) })
  }
  return resolved
}

// 群名 → chat_id（用户身份 chat-search，精确匹配群名；需 im:chat:read）。返回 Map(name → chat_id)，查不到的不出现。
export const searchChatIdsByName = async (names, { identity = 'user' } = {}) => {
  const found = new Map()
  for (const name of names) {
    const result = await runLarkCli(['im', '+chat-search', '--query', name, '--format', 'json'], { identity })
    if (larkCallFailed(result)) {
      console.warn(`[lark-gateway] 群名解析失败「${name}」：${formatLarkCliError(result)}`)
      continue
    }
    try {
      const data = JSON.parse(result.stdout).data || {}
      const chats = data.chats || data.items || []
      const exact = chats.find((chat) => String(chat.name || '').trim() === name) || (chats.length === 1 ? chats[0] : null)
      if (exact?.chat_id) found.set(name, exact.chat_id)
      else console.warn(`[lark-gateway] 群名「${name}」未精确命中（候选 ${chats.map((chat) => chat.name).join(' / ') || '无'}）`)
    } catch {
      console.warn(`[lark-gateway] 群名解析输出无法解析「${name}」`)
    }
  }
  return found
}

// 用户身份拉一个话题（thread）的回复（外部群轮询补抓旧话题里的新回复用）。返回 { ok, messages, reason }。
export const listThreadMessages = async ({ threadId, order = 'desc', pageSize = 30, identity = 'user' }) => {
  const result = await runLarkCli(['im', '+threads-messages-list', '--thread', threadId, '--order', order, '--page-size', String(pageSize), '--no-reactions', '--format', 'json'], { identity })
  if (larkCallFailed(result)) return { ok: false, messages: [], reason: formatLarkCliError(result) }
  try {
    const data = JSON.parse(result.stdout).data || {}
    return { ok: true, messages: data.messages || data.items || [] }
  } catch (error) {
    return { ok: false, messages: [], reason: `解析失败：${error.message}` }
  }
}

// 用户身份拉一页群消息（外部群轮询用）。返回 { ok, messages, hasMore, pageToken, reason }。
export const listChatMessages = async ({ chatId, start, end, pageToken, pageSize = 50, identity = 'user' }) => {
  const args = ['im', '+chat-messages-list', '--chat-id', chatId, '--order', 'asc', '--page-size', String(pageSize), '--no-reactions', '--format', 'json']
  if (start) args.push('--start', start)
  if (end) args.push('--end', end)
  if (pageToken) args.push('--page-token', pageToken)
  const result = await runLarkCli(args, { identity })
  if (larkCallFailed(result)) return { ok: false, messages: [], hasMore: false, pageToken: null, reason: formatLarkCliError(result), transient: isTransientLarkError(result) }
  try {
    const data = JSON.parse(result.stdout).data || {}
    return { ok: true, messages: data.messages || data.items || [], hasMore: Boolean(data.has_more), pageToken: data.page_token || null }
  } catch (error) {
    return { ok: false, messages: [], hasMore: false, pageToken: null, reason: `解析失败：${error.message}`, transient: false }
  }
}

// chat_id → 群名 缓存：每个项目建一个群，群名形如 `[PR-02172]【…】…`，是项目号的权威来源。
// `+chat-list` 只列 bot 所在的群（数量小）。带 TTL：群随时可能改名/退群/新增，只在 miss 时刷会让
// 旧名永久 stale（踩过：群改名后仍路由到旧项目号）。@ 是人触发、频率低，过期重拉一次很便宜。
const chatNameCache = new Map()
let chatNamesRefreshedAt = 0
const chatNameTtlMs = Number(process.env.LARK_CHAT_NAME_TTL_MS || 60_000)
const refreshChatNames = async () => {
  const result = await runLarkCli(['im', '+chat-list', '--format', 'json'])
  if (result.code !== 0) return
  try {
    const data = JSON.parse(result.stdout).data || {}
    const items = data.chats || data.items || []
    // 先构建再整体替换：解析失败不清空旧缓存；成功则全量重建（改名覆盖、退群/移除的群失效）
    const next = new Map()
    for (const chat of items) {
      if (chat.chat_id) next.set(chat.chat_id, chat.name || '')
    }
    chatNameCache.clear()
    for (const [id, name] of next) chatNameCache.set(id, name)
    chatNamesRefreshedAt = Date.now()
  } catch {
    // 解析失败不阻塞，resolveProject 会回落正文 / config.project
  }
}
// miss 或超 TTL（群可能已改名/新增/退群）都刷新
const ensureChatNamesFresh = async (chatId) => {
  if (!chatNameCache.has(chatId) || Date.now() - chatNamesRefreshedAt > chatNameTtlMs) {
    await refreshChatNames()
  }
}
export const resolveChatName = async (chatId) => {
  if (!chatId) return ''
  await ensureChatNamesFresh(chatId)
  return chatNameCache.get(chatId) || ''
}

// 仅按 TTL 判新鲜（不针对某个具体 chatId）：反查项目群时手里只有项目号、没有 chatId，
// 不能用 has(chatId) 触发刷新（miss 必刷 = 每次都拉表）。空缓存或超 TTL 才整体重拉一次。
const ensureChatNamesFreshByTtl = async () => {
  if (chatNameCache.size === 0 || Date.now() - chatNamesRefreshedAt > chatNameTtlMs) {
    await refreshChatNames()
  }
}

// 从「chatId → 群名」映射里按项目号反查群（群名形如 `[PR-xxxxx]…`）。纯函数、可直测。
// 多个群命中同一项目号时取迭代序首个（Map 保插入序，稳定）；命中不到返回 ''。
export const pickChatIdByProject = (entries, project) => {
  if (!project) return ''
  const target = String(project).toUpperCase()
  for (const [chatId, name] of entries) {
    if (matchProjectId(name) === target) return chatId
  }
  return ''
}

// 项目号 → 项目群 chat_id（resolveChatName 的逆向）。bug 表任务没有「来源群」，
// 按 bug 的项目号找它自己的项目群，把回执/结果卡发到对的群，而不是固定通知群。
// 只在 bot 所在群里找（chatNameCache 只含 bot 所在群）；找不到返回 ''，由调用方回落到通知群。
export const resolveChatIdByProject = async (project) => {
  if (!project) return ''
  await ensureChatNamesFreshByTtl()
  return pickChatIdByProject(chatNameCache, project)
}

// 发送时按项目号改投项目群：命中项目群则用群 chat_id，否则回落到入队时冻结的 fallbackChatId
// （私聊 operator / 通知群）。修复「入队时 bot 未进群 → chatId 冻结成私聊，之后进了群仍私发」：
// 投递决策移到发送时，一进群下一张卡即改投群。resolve 可注入以便单测（默认走 resolveChatIdByProject）。
export const resolveDeliveryChatId = async ({ project, fallbackChatId, resolve = resolveChatIdByProject }) => {
  // 无项目号（adhoc / p2p）短路：不查 chat-list，保持 network-free，语义等同原冻结 chatId。
  if (!project) return fallbackChatId
  return (await resolve(project)) || fallbackChatId
}

// bot 所在群判定（动态成员制白名单用）：chatNameCache 只写入 bot 所在群，故 has(chatId) 即成员。
// 同样带 TTL：新加入的群 miss 会触发刷新；已退出的群超 TTL 后失效。
export const isChatMember = async (chatId) => {
  if (!chatId) return false
  await ensureChatNamesFresh(chatId)
  return chatNameCache.has(chatId)
}

// 把 mget / threads-messages-list 返回的单条消息解析为 { text, attachments }。
// text / merge_forward 的 content 已是可读字符串直接用；image 从 JSON 取 image_key；其余走 parseTextAndAttachments。
const parseFetchedMessage = (msgType, content) => {
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

// 拉取被引用/被回复的父消息内容（`lark-cli im +messages-mget`）。用户常在 QA 的原始 bug 消息下
// 回复 + @bot，真正的 bug 正文/截图在父消息里；把它并进 task 才有可执行落点。
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
    const { text } = parseFetchedMessage(m.msg_type, m.content)
    const trimmed = ownBot ? stripCardText(text) : String(text || '').trim()
    if (!trimmed) continue
    out.push({
      messageId: m.message_id,
      sender: ownBot ? `${m.sender?.name || 'bot'}（bot，我们自己）` : m.sender?.name || '',
      text: trimmed.slice(0, 300),
      ...(ownBot ? { bot: true } : {}),
    })
  }
  return out.slice(-limit)
}
export const fetchRecentChatContext = async ({ chatId, beforeMs, excludeIds = [], botOpenIds = [], limit = 10, windowMs = 3 * 60 * 60 * 1000, identity = 'user' }) => {
  if (!chatId || !beforeMs) return []
  const startSec = Math.floor((beforeMs - windowMs) / 1000)
  const endSec = Math.ceil(beforeMs / 1000)
  const page = await listChatMessages({ chatId, start: String(startSec), end: String(endSec), pageSize: 50, identity })
  if (!page.ok) return []
  return pickRecentContext(page.messages, { beforeMs, excludeIds, botOpenIds, limit })
}

// 合并转发消息（msg_type=merge_forward）：本体只有标题，子消息要用 mget 取（返回列表里 upper_message_id 指向本体）。
// 整改 #1：后端常把一段讨论「合并转发」丢过来，之前整条被当空消息丢掉。读不到子消息返回 null（调用方按空处理）。
// 群里没有 app_id 的机器人 = 自定义机器人（webhook bot）。返回 [{ name, openId }]。
export const listChatCustomBots = async (chatId, { identity = 'user' } = {}) => {
  const result = await runLarkCli(['im', '+chat-members-list', '--chat-id', chatId, '--format', 'json'], { identity })
  if (larkCallFailed(result)) return []
  try {
    const bots = JSON.parse(result.stdout).data?.bots || []
    return bots.filter((bot) => !bot.app_id && bot.member_id).map((bot) => ({ name: String(bot.name || '').trim(), openId: bot.member_id }))
  } catch {
    return []
  }
}

export const fetchMergeForwardContext = async (messageId, { identity = 'user', limit = 30 } = {}) => {
  if (!messageId) return null
  const result = await runLarkCli(['im', '+messages-mget', '--message-ids', messageId, '--format', 'json'], { identity })
  if (result.code !== 0) return null
  let items
  try {
    const data = JSON.parse(result.stdout).data
    items = data?.messages || data?.items || []
  } catch {
    return null
  }
  const children = items.filter((m) => m && m.message_id !== messageId && (m.upper_message_id === messageId || m.upper_message_id == null))
  const lines = []
  const attachments = []
  for (const m of children.slice(0, limit)) {
    const parsed = parseFetchedMessage(m.msg_type, m.content)
    const text = String(parsed.text || '').trim()
    if (text) lines.push(`${m.sender?.name || m.sender?.id || ''}：${text}`.replace(/^：/, ''))
    attachments.push(...parsed.attachments)
  }
  if (!lines.length && !attachments.length) return null
  return { text: `【合并转发的消息】\n${lines.join('\n')}`, attachments }
}

export const fetchReferencedContext = async (messageId, { identity = 'bot' } = {}) => {
  if (!messageId) return null
  const result = await runLarkCli(['im', '+messages-mget', '--message-ids', messageId, '--format', 'json'], { identity })
  if (result.code !== 0) return null
  let msg
  try {
    msg = (JSON.parse(result.stdout).data?.messages || [])[0]
  } catch {
    return null
  }
  if (!msg) return null
  return parseFetchedMessage(msg.msg_type, msg.content)
}

// 拉取消息所在「话题(thread)」的其它消息（`lark-cli im +threads-messages-list`，输入 om_/omt_ 自动解析 thread_id）。
// 群里在话题内补充的关键澄清（目标页面名、接口字段、样例）常散落在**兄弟回复**里，只并被引用父消息会漏掉，
// 导致 AI 缺料误判（不属本仓 / 待补充）。取**真人**消息的文本 + 图片（返回各条 messageId 供调用方按需逐条下载图片，
// 因同话题图片分散在不同消息里）；跳过 bot/app 自身消息（含机器人回执/状态卡，否则会把自己发的卡片又喂回去）。
// excludeIds：当前 @ 消息 + 已并入的被引用父消息，避免重复。需 bot 具备列消息历史 scope（im:message.group_msg）。
export const fetchThreadContext = async (threadAnchorId, { excludeIds = [], limit = 40, identity = 'bot' } = {}) => {
  if (!threadAnchorId) return []
  const result = await runLarkCli([
    'im', '+threads-messages-list', '--thread', threadAnchorId, '--order', 'asc', '--no-reactions', '--format', 'json',
  ], { identity })
  if (result.code !== 0) return []
  let items
  try {
    const data = JSON.parse(result.stdout).data
    items = data?.messages || data?.items || []
  } catch {
    return []
  }
  const exclude = new Set(excludeIds.filter(Boolean))
  const out = []
  for (const m of items) {
    if (!m || exclude.has(m.message_id)) continue
    if (m.sender?.sender_type && m.sender.sender_type !== 'user') continue
    const { text, attachments } = parseFetchedMessage(m.msg_type, m.content)
    const trimmed = String(text || '').trim()
    if (!trimmed && !attachments.length) continue
    out.push({ messageId: m.message_id, sender: m.sender?.name || '', text: trimmed, attachments })
    if (out.length >= limit) break
  }
  return out
}
