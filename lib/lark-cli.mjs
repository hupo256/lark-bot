/**
 * lark-cli 子进程封装 + 依赖它的 IO（发消息、下载附件、群名缓存、拉引用消息）。
 * 事件源用长连接、bot 身份鉴权走 lark-cli 已登录态（keychain），无需 webhook secret / appSecret。
 */

import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { parseTextAndAttachments } from './lark-message.mjs'
import { matchProjectId } from './lark-project-id.mjs'
import { docsDir } from './lark-repo.mjs'
import { sleep } from './lark-gateway-client.mjs'

export const larkCliBin = process.env.LARK_CLI_BIN || 'lark-cli'
// lark-cli 子进程超时兜底：卡网/卡登录时不让调用永久挂起（默认 60s）
const larkCliTimeoutMs = Number(process.env.LARK_CLI_TIMEOUT_MS || 60000)

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

// 下载 post 图片到本地附件目录，写入 localPath。鉴权走 lark-cli 已登录的 bot 身份（keychain）。
// 落盘目录走 docsDir（= resolveProjectRoot）：三域重组后项目实例在 docs 仓 prds/<PR> 下，
// 手拼 apps/web/docs_tdd/<PR> 会写到旧根目录，变成 AI 读不到的孤儿附件。
export const downloadAttachments = async ({ project, messageId, attachments }) => {
  if (!attachments.length) return attachments
  const outDir = join(docsDir(project), 'agent/lark-attachments', messageId)
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
