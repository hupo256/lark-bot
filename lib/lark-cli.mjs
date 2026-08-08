/**
 * lark-cli 子进程封装 + 依赖它的 IO（发消息、下载附件、群名缓存、拉引用消息）。
 * 事件源用长连接、bot 身份鉴权走 lark-cli 已登录态（keychain），无需 webhook secret / appSecret。
 */

import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { parseTextAndAttachments } from './lark-message.mjs'

const larkCliBin = process.env.LARK_CLI_BIN || 'lark-cli'
// lark-cli 子进程超时兜底：卡网/卡登录时不让调用永久挂起（默认 60s）
const larkCliTimeoutMs = Number(process.env.LARK_CLI_TIMEOUT_MS || 60000)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 把 lark-cli 命令包成 Promise，返回 { code, stdout, stderr }。带超时兜底：
// 到点先 SIGTERM，宽限 3s 仍未退再 SIGKILL，并立即以 code -1 结算，避免调用方永久挂起。
export const runLarkCli = (args, { timeoutMs = larkCliTimeoutMs, cwd } = {}) =>
  new Promise((resolve) => {
    // 强制 bot 身份：lark-cli `defaultAs:auto` 在同时登录了 user + bot 时会解析成 user，
    // 导致发消息/读表报 missing_scope（user 无 im:message 等 scope）。所有系统调用都应走 bot。
    const child = spawn(larkCliBin, ['--as', 'bot', ...args], { stdio: ['ignore', 'pipe', 'pipe'], cwd })
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
const larkCallFailed = (result) => result.code !== 0 || /"ok"\s*:\s*false/.test(result.stdout)

// 通用「调用 + 重试 + 退避」封装（发消息 / bug 表回写共用）。返回 { ok, reason }。
export const runLarkCliWithRetry = async (args, { logPrefix, retries = 3 } = {}) => {
  let reason = ''
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const result = await runLarkCli(args)
    if (!larkCallFailed(result)) {
      console.log(`[lark-gateway] ${logPrefix} ok${attempt > 1 ? ` (attempt ${attempt})` : ''}`)
      return { ok: true }
    }
    reason = (result.stderr || result.stdout || '').slice(0, 200)
    console.error(`[lark-gateway] ${logPrefix} attempt ${attempt}/${retries} failed: ${reason}`)
    if (attempt < retries) await sleep(attempt * 1500)
  }
  console.error(`[lark-gateway] ${logPrefix} gave up after ${retries} attempts`)
  return { ok: false, reason }
}

// 发群消息，带重试（网络/DNS 抖动时不丢消息）。idempotencyKey 让重试不会重复发（Lark 侧去重）。
// 传 card（interactive 卡片 content JSON）优先走卡片；否则回退纯文本 text。
export const sendChatMessage = async ({ chatId, text, card, logPrefix, idempotencyKey, retries = 3 }) => {
  if (!chatId) {
    console.warn(`[lark-gateway] ${logPrefix}: skipped, missing chatId`)
    return { ok: false, reason: 'missing chatId' }
  }
  const args = card
    ? ['im', '+messages-send', '--chat-id', chatId, '--msg-type', 'interactive', '--content', card]
    : ['im', '+messages-send', '--chat-id', chatId, '--msg-type', 'text', '--text', text]
  if (idempotencyKey) {
    args.push('--idempotency-key', String(idempotencyKey).slice(0, 50))
  }
  return runLarkCliWithRetry(args, { logPrefix: `${logPrefix} -> ${chatId}`, retries })
}

// 下载 post 图片到本地附件目录，写入 localPath。鉴权走 lark-cli 已登录的 bot 身份（keychain）。
export const downloadAttachments = async ({ repoRoot, project, messageId, attachments }) => {
  if (!attachments.length) return attachments
  const outDir = join(repoRoot, 'apps/web/docs_tdd', project, 'agent/lark-attachments', messageId)
  mkdirSync(outDir, { recursive: true })
  const resolved = []
  for (const [index, a] of attachments.entries()) {
    // imageKey 会拼进本地文件名，sanitize 掉路径分隔符等，避免越目录写入
    const safeKey = String(a.imageKey || 'img').replace(/[^\w.-]/g, '_').slice(0, 80)
    const fileName = `${index + 1}-${safeKey}.img`
    // lark-cli `messages-resources-download` 的 --output 拒绝绝对路径（invalid_argument），
    // 故传相对文件名 + 把子进程 cwd 设到 outDir，落地路径仍是 join(outDir, fileName)。
    const result = await runLarkCli([
      'im', '+messages-resources-download',
      '--message-id', messageId,
      '--file-key', a.imageKey,
      '--type', 'image',
      '--output', fileName,
    ], { cwd: outDir })
    resolved.push(larkCallFailed(result)
      ? { ...a, downloadError: (result.stdout || result.stderr).slice(0, 200) }
      : { ...a, localPath: join(outDir, fileName) })
  }
  return resolved
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

// bot 所在群判定（动态成员制白名单用）：chatNameCache 只写入 bot 所在群，故 has(chatId) 即成员。
// 同样带 TTL：新加入的群 miss 会触发刷新；已退出的群超 TTL 后失效。
export const isChatMember = async (chatId) => {
  if (!chatId) return false
  await ensureChatNamesFresh(chatId)
  return chatNameCache.has(chatId)
}

// 拉取被引用/被回复的父消息内容（`lark-cli im +messages-mget`）。用户常在 QA 的原始 bug 消息下
// 回复 + @bot，真正的 bug 正文/截图在父消息里；把它并进 task 才有可执行落点。
// text / merge_forward（合并转发）的 content 已是可读字符串直接用；post/image 解析出文本 + 图片 image_key。
export const fetchReferencedContext = async (messageId) => {
  if (!messageId) return null
  const result = await runLarkCli(['im', '+messages-mget', '--message-ids', messageId, '--format', 'json'])
  if (result.code !== 0) return null
  let msg
  try {
    msg = (JSON.parse(result.stdout).data?.messages || [])[0]
  } catch {
    return null
  }
  if (!msg) return null

  const content = msg.content
  if (typeof content === 'string' && !content.trim().startsWith('{')) {
    const parsed = parseTextAndAttachments({ messageType: msg.msg_type, rawContent: content, mentions: [] })
    return { text: parsed.text, attachments: parsed.attachments } // text / merge_forward（含图片占位恢复）
  }
  if (msg.msg_type === 'image') {
    try {
      const parsed = JSON.parse(content)
      return { text: '', attachments: parsed.image_key ? [{ type: 'image', imageKey: parsed.image_key }] : [] }
    } catch {
      return { text: '', attachments: [] }
    }
  }
  const parsed = parseTextAndAttachments({ messageType: msg.msg_type, rawContent: content, mentions: [] })
  return { text: parsed.text, attachments: parsed.attachments }
}
