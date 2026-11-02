/**
 * lark-cli 子进程封装 + 依赖它的 IO（发消息、下载附件、群名缓存、拉引用消息）。
 * 事件源用长连接、bot 身份鉴权走 lark-cli 已登录态（keychain），无需 webhook secret / appSecret。
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readSync, renameSync } from 'node:fs'
import { join } from 'node:path'

import { parseFetchedMessage, pickRecentContext, pickThreadContext } from './lark-chat-context.mjs'
import { matchProjectId } from './lark-project-id.mjs'
import { loadProjectChats, projectChatFor } from './lark-project-chats.mjs'
import { attachmentsDirFor } from './lark-paths.mjs'
import { sleep } from './lark-gateway-client.mjs'

// 单测进程里（node --test 设 NODE_TEST_CONTEXT）没显式指定就用 /usr/bin/false：测试绝不碰真实 Lark（falive 10-24 发现有测试每跑一次真访问 Lark 约 2 秒）。线上不受影响。
export const larkCliBin = process.env.LARK_CLI_BIN || (process.env.NODE_TEST_CONTEXT ? '/usr/bin/false' : 'lark-cli')
// lark-cli 子进程超时兜底：卡网/卡登录时不让调用永久挂起（默认 60s）
const larkCliTimeoutMs = Number(process.env.LARK_CLI_TIMEOUT_MS || 60000)

// 把 lark-cli 命令包成 Promise，返回 { code, stdout, stderr }。带超时兜底：
// 到点先 SIGTERM，宽限 3s 仍未退再 SIGKILL，并立即以 code -1 结算，避免调用方永久挂起。
// identity：显式指定身份（默认 bot）。lark-cli `defaultAs:auto` 在同时登录了 user + bot 时会解析成 user，
// 导致发消息/读表报 missing_scope（user 无 im:message 等 scope）；只有建云文档这类 bot 没 scope 的才传 'user'（对话层 11-01）。
export const runLarkCli = (args, { timeoutMs = larkCliTimeoutMs, cwd, identity = 'bot' } = {}) =>
  new Promise((resolve) => {
    const child = spawn(larkCliBin, ['--as', identity, ...args], { stdio: ['ignore', 'pipe', 'pipe'], cwd })
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
    // 10-24（falive 变异补测发现）：在 'close'（stdio 读完）上结算，不在 'exit'。机器有负载时进程已退出但 stdout 还没读完，
    // 'exit' 结算会拿到截断输出：发消息成功却解析不出 message_id（回执锚不到任务）、+chat-list 读成空（项目群解析失败）。
    child.on('close', (code) => finish({ code, stdout, stderr }))
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
// 飞书侧限流 / 网关偶发坏响应也是瞬时的（11-02 真机：取 tenant token 频繁 HTTP 429，报 invalid_response / token_missing，
// 原来不算瞬时，日报读 bug 表、查群名一次失败就放弃，回复失败还会回落成直发群）。
const TRANSIENT_MESSAGE_RE = /HTTP (?:429|5\d\d)|rate ?limit|too many requests|frequency limit/i
export const isTransientLarkError = (result) => {
  if (result?.code === -1) return true
  try {
    const error = JSON.parse(result?.stdout || '')?.error
    return error?.type === 'network' || TRANSIENT_MESSAGE_RE.test(String(error?.message || ''))
  } catch {
    return false
  }
}

// 读类调用的薄重试：瞬时错误退避重试，其余原样返回（调用方照旧按 code / stdout 判）。日报读 bug 表、查群名用。
export const runLarkCliRetrying = async (args, { run = runLarkCli, retries = 3, wait = sleep } = {}) => {
  let result
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    result = await run(args)
    if (!larkCallFailed(result) || !isTransientLarkError(result) || attempt === retries) return result
    await wait(attempt * 1500)
  }
  return result
}

// 通用「调用 + 重试 + 退避」封装（发消息 / bug 表回写共用）。返回 { ok, reason }。
// logTag：日志进程前缀，缺省 [lark-gateway]；worker 里发的传 [lark-worker]（10-24 沙箱试跑：worker.log 里满是 [lark-gateway]）。
export const runLarkCliWithRetry = async (args, { logPrefix, retries = 3, logTag = '[lark-gateway]', run = runLarkCli } = {}) => {
  let reason = ''
  let transient = false
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const result = await run(args)
    if (!larkCallFailed(result)) {
      console.log(`${logTag} ${logPrefix} ok${attempt > 1 ? ` (attempt ${attempt})` : ''}`)
      return { ok: true, result }
    }
    reason = (result.stderr || result.stdout || '').slice(0, 200)
    transient = isTransientLarkError(result)
    console.error(`${logTag} ${logPrefix} attempt ${attempt}/${retries} failed: ${reason}`)
    if (attempt < retries) await sleep(attempt * 1500)
  }
  console.error(`${logTag} ${logPrefix} gave up after ${retries} attempts`)
  // transient：最后一次失败是不是瞬时错误（网络 / 超时）。回复原消息失败时据此决定要不要回落直发群（replyMarkdown）；
  // 只在为真时带字段，老调用方的 deepEqual 不受影响。
  return transient ? { ok: false, reason, transient } : { ok: false, reason }
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

// 发送结果里的会话 id：按 --user-id 私信时 lark-cli 回 data.chat_id（oc_…），回执记它才能和对方回私信的 chat_id 对上（11-02 复核）。
export const parseSentChatId = (stdout) => {
  try {
    const payload = JSON.parse(String(stdout || ''))
    return payload?.data?.chat_id || payload?.data?.message?.chat_id || null
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
export const sendChatMessage = async ({ chatId, text, card, logPrefix, idempotencyKey, retries = 3, logTag = '[lark-gateway]' }) => {
  if (!chatId) {
    console.warn(`${logTag} ${logPrefix}: skipped, missing chatId`)
    return { ok: false, reason: 'missing chatId' }
  }
  const recipient = messageSendRecipientArgs(chatId)
  const args = card
    ? ['im', '+messages-send', ...recipient, '--msg-type', 'interactive', '--content', card]
    : ['im', '+messages-send', ...recipient, '--msg-type', 'text', '--text', text]
  if (idempotencyKey) {
    args.push('--idempotency-key', String(idempotencyKey).slice(0, 50))
  }
  const outcome = await runLarkCliWithRetry(args, { logPrefix: `${logPrefix} -> ${chatId}`, retries, logTag })
  if (!outcome.ok) return outcome
  return { ok: true, messageId: parseSentMessageId(outcome.result?.stdout) }
}

// Markdown 消息（lark-cli 自动转成 post 富文本；@ 人写 `<at user_id="ou_x">名</at>`）：对话层（11-01）群里的人话回复与负责人私信都走它，
// 卡片只剩网关告警（sendChatMessage）。idempotencyKey 缺省 = hash(收件人 + 正文)：超时重试不会把同一条发两遍（Lark 侧按 key 去重，50 字符上限）。
// run 可注入（单测桩掉子进程）。
export const markdownIdempotencyKey = (target, markdown) => `md-${createHash('sha1').update(`${target}\n${markdown}`).digest('hex').slice(0, 40)}`
export const sendMarkdown = async ({ chatId, markdown, logPrefix = 'markdown', idempotencyKey = markdownIdempotencyKey(chatId, markdown), retries = 3, logTag = '[lark-gateway]', run = runLarkCli }) => {
  if (!chatId) {
    console.warn(`${logTag} ${logPrefix}: skipped, missing chatId`)
    return { ok: false, messageId: null, reason: 'missing chatId' }
  }
  const args = ['im', '+messages-send', ...messageSendRecipientArgs(chatId), '--markdown', String(markdown || ''), '--idempotency-key', String(idempotencyKey).slice(0, 50), '--format', 'json']
  const outcome = await runLarkCliWithRetry(args, { logPrefix: `${logPrefix} -> ${chatId}`, retries, logTag, run })
  if (!outcome.ok) return { ok: false, messageId: null, reason: outcome.reason }
  return { ok: true, messageId: parseSentMessageId(outcome.result?.stdout), chatId: parseSentChatId(outcome.result?.stdout), reason: null }
}

// 回复原消息（群里一律回复原消息，原消息在话题里才 --reply-in-thread；对话层 §4.2 anchor=reply_origin）。
// 非瞬时失败（原消息被撤回、没权限回这条）且给了 fallbackChatId → 回落直发群，键加 `-s`（仍 ≤ 50）；返回 via 标明走的哪条路。
// 瞬时失败（网络 / 超时）不回落：直发多半也发不出去，交调用方的重试机制（pendingReceipt）。
export const replyMarkdown = async ({ messageId, markdown, inThread = false, fallbackChatId = null, fallbackMarkdown = null, logPrefix = 'reply', idempotencyKey = markdownIdempotencyKey(messageId, markdown), retries = 3, logTag = '[lark-gateway]', run = runLarkCli }) => {
  if (!messageId) {
    if (fallbackChatId) return { ...(await sendMarkdown({ chatId: fallbackChatId, markdown: fallbackMarkdown || markdown, logPrefix, idempotencyKey, retries, logTag, run })), via: 'send' }
    return { ok: false, messageId: null, via: 'reply', reason: 'missing messageId' }
  }
  const key = String(idempotencyKey).slice(0, 50)
  const args = ['im', '+messages-reply', '--message-id', messageId, '--markdown', String(markdown || ''), ...(inThread ? ['--reply-in-thread'] : []), '--idempotency-key', key, '--format', 'json']
  const outcome = await runLarkCliWithRetry(args, { logPrefix: `${logPrefix} -> ${messageId}`, retries, logTag, run })
  if (outcome.ok) return { ok: true, messageId: parseSentMessageId(outcome.result?.stdout), via: 'reply', reason: null }
  if (!fallbackChatId || outcome.transient) return { ok: false, messageId: null, via: 'reply', reason: outcome.reason }
  console.warn(`${logTag} ${logPrefix}：回复 ${messageId} 失败（${outcome.reason}），回落直发 ${fallbackChatId}`)
  // 回落直发不再是「回复那条」，群里看不出在对谁说：调用方给的 fallbackMarkdown 带着 @当事人（aven 11-02）。
  const sent = await sendMarkdown({ chatId: fallbackChatId, markdown: fallbackMarkdown || markdown, logPrefix: `${logPrefix} fallback`, idempotencyKey: `${key.slice(0, 48)}-s`, retries, logTag, run })
  return { ...sent, via: 'send', reason: sent.ok ? null : `回复失败（${outcome.reason}），直发也失败（${sent.reason}）` }
}

// 下载 post 图片到本地附件目录，写入 localPath。鉴权走 lark-cli 已登录的 bot 身份（keychain）。
// 落盘目录走 attachmentsDirFor（runtime/lark-attachments/<PR>/<messageId>/）：附件是 bot 运行态，
// 归 bot 自己的目录；清扫器 lark-retention.sweepAttachments 扫的是同一个根，两边口径必须一致。
export const downloadAttachments = async ({ project, messageId, attachments }) => {
  if (!attachments.length) return attachments
  const outDir = attachmentsDirFor(project, messageId)
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
      : { ...a, localPath: renameByImageMagic(join(outDir, fileName)) })
  }
  return resolved
}

// 图片按文件头改成真实扩展名：Claude 的 Read 按扩展名判类型，`.img` 会被当文本读成乱码（falive 教训 #27：
// 分类器称「截图内容也读不出来」）。认不出的保持原名。纯函数部分可直测。
export const imageExtFromBytes = (bytes) => {
  if (!bytes || bytes.length < 12) return null
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg'
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png'
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'gif'
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'webp'
  return null
}
const renameByImageMagic = (path) => {
  try {
    const fd = openSync(path, 'r')
    const head = Buffer.alloc(12)
    try {
      readSync(fd, head, 0, 12, 0)
    } finally {
      closeSync(fd)
    }
    const ext = imageExtFromBytes(head)
    if (!ext || path.endsWith(`.${ext}`)) return path
    const renamed = `${path.replace(/\.[A-Za-z0-9]+$/, '')}.${ext}`
    renameSync(path, renamed)
    return renamed
  } catch {
    return path
  }
}

// chat_id → 群名 缓存：每个项目建一个群，群名形如 `[PR-02172]【…】…`，是项目号的权威来源。
// `+chat-list` 只列 bot 所在的群（数量小）。带 TTL：群随时可能改名/退群/新增，只在 miss 时刷会让
// 旧名永久 stale（踩过：群改名后仍路由到旧项目号）。@ 是人触发、频率低，过期重拉一次很便宜。
const chatNameCache = new Map()
let chatNamesRefreshedAt = 0
const chatNameTtlMs = Number(process.env.LARK_CHAT_NAME_TTL_MS || 60_000)
const refreshChatNames = async (run = (args) => runLarkCliRetrying(args)) => {
  const result = await run(['im', '+chat-list', '--format', 'json'])
  if (result.code !== 0) return false
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
    return true
  } catch {
    // 解析失败不阻塞，resolveProject 会回落正文 / config.project
    return false
  }
}

// bot 当前所在群（chatId → 群名），强制现拉一次；拉失败返回 null（项目群同步据此跳过本轮，不把「读失败」当「退群」）。
export const listBotChats = async ({ run } = {}) => ((await refreshChatNames(run)) ? new Map(chatNameCache) : null)
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

// 项目号 → 项目群 chat_id。bug 表任务没有「来源群」，按 bug 的项目号找它自己的项目群，把回执/结果卡发到对的群。
// aven 2026-11-01：只查绑定表（lib/lark-project-chats.mjs，bot 入群时按 chat_id 绑定），不再按群名去 bot 所在群里搜
//（群名会改、不规范，改名后会投错群）。没绑定返回 ''，由调用方回落到私聊 / 通知群。pickChatIdByProject 只剩首次建表时用。
export const resolveChatIdByProject = async (project, { load = loadProjectChats } = {}) => {
  if (!project) return ''
  return projectChatFor(load(), project)
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

// 拉取被引用/被回复的父消息内容（`lark-cli im +messages-mget`）。用户常在 QA 的原始 bug 消息下
// 回复 + @bot，真正的 bug 正文/截图在父消息里；把它并进 task 才有可执行落点。
// 带上谁、什么时候说的（sender / senderOpenId / createTime）：被引用的往往是别人几小时前的原话，没有发送人就分不清是后端的答复还是测试的反馈。
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
  return { ...parseFetchedMessage(msg.msg_type, msg.content), sender: msg.sender?.name || '', senderOpenId: msg.sender?.id || '', createTime: msg.create_time || '' }
}

// 拉取消息所在「话题(thread)」的其它消息（`lark-cli im +threads-messages-list`，输入 om_/omt_ 自动解析 thread_id）。
// 群里在话题内补充的关键澄清（目标页面名、接口字段、样例）常散落在**兄弟回复**里，只并被引用父消息会漏掉，
// 导致 AI 缺料误判（不属本仓 / 待补充）。取真人消息的文本 + 图片（返回各条 messageId 供调用方按需逐条下载图片，
// 因同话题图片分散在不同消息里）；机器人消息只要本 bot 自己的（sender.id ∈ botOpenIds，剥卡片与署名、标「bot，我们自己」）——
// 对方在话题里的短句常接 bot 上一句（falive 教训 #23 / #48）；别家机器人 / 应用回执不要。挑选逻辑在 lark-chat-context.pickThreadContext。
// excludeIds：当前 @ 消息 + 已并入的被引用父消息，避免重复。需 bot 具备列消息历史 scope（im:message.group_msg）。
// 从新到旧拉一页（50 条）再翻回正序：按 asc 拉时话题超过 50 条只拿到最早那段，最新的讨论反而丢了。
export const fetchThreadContext = async (threadAnchorId, { excludeIds = [], limit = 40, botOpenIds = [] } = {}) => {
  if (!threadAnchorId) return []
  const result = await runLarkCli([
    'im', '+threads-messages-list', '--thread', threadAnchorId, '--order', 'desc', '--page-size', '50', '--no-reactions', '--format', 'json',
  ])
  if (result.code !== 0) return []
  let items
  try {
    const data = JSON.parse(result.stdout).data
    items = data?.messages || data?.items || []
  } catch {
    return []
  }
  return pickThreadContext([...items].reverse(), { excludeIds, botOpenIds, limit })
}

// bot 所在的群 id（chat-list 缓存，按 TTL 刷新）：开盖补拉用。
export const listBotChatIds = async () => {
  await ensureChatNamesFreshByTtl()
  return [...chatNameCache.keys()]
}

// 列群消息（bot 身份，需应用有读群消息权限）：开盖补拉合盖期间漏掉的 @。返回 { ok, messages, hasMore, pageToken, reason }。
export const listChatMessages = async ({ chatId, start, end, pageToken, pageSize = 50, order = 'asc' }) => {
  const args = ['im', '+chat-messages-list', '--chat-id', chatId, '--order', order, '--page-size', String(pageSize), '--no-reactions', '--format', 'json']
  if (start) args.push('--start', start)
  if (end) args.push('--end', end)
  if (pageToken) args.push('--page-token', pageToken)
  const result = await runLarkCli(args)
  if (larkCallFailed(result)) return { ok: false, messages: [], hasMore: false, pageToken: null, reason: formatLarkCliError(result), transient: isTransientLarkError(result) }
  try {
    const data = JSON.parse(result.stdout).data || {}
    return { ok: true, messages: data.messages || data.items || [], hasMore: Boolean(data.has_more), pageToken: data.page_token || null }
  } catch (error) {
    return { ok: false, messages: [], hasMore: false, pageToken: null, reason: `解析失败：${error.message}`, transient: false }
  }
}

// 群里这条消息之前紧挨着的最近 limit 条（挑选口径见 lark-chat-context.pickRecentContext）：真人 + 本 bot 自己的话，不管隔多久。
// falive 10-23 #74：原来按 3 小时（后改 6 小时）时间窗截——bot 22:46 在结果里 @Encone 要主播号，他第二天 10:36 @bot 说「已经将 uid 508 设成主播」，
// 那张卡出了窗口，分类器接不上，挂到了 2 小时内别的条目上。时间窗只是兜底拉取范围（lookbackMs，默认 7 天）：
// 从 @ 往前倒着一页页拉，凑够 limit 条或翻到 maxPages 页 / 没有更多为止。拉失败 / 抛错返回已拿到的（一页都没有就是 []）。list 可注入（单测）。
export const fetchRecentChatContext = async ({ chatId, beforeMs, excludeIds = [], botOpenIds = [], limit = 20, lookbackMs = 7 * 24 * 60 * 60_000, maxPages = 4, list = listChatMessages }) => {
  if (!chatId || !beforeMs) return []
  const start = String(Math.floor((beforeMs - lookbackMs) / 1000))
  const end = String(Math.ceil(beforeMs / 1000))
  const pick = (newestFirst) => pickRecentContext([...newestFirst].reverse(), { beforeMs, excludeIds, botOpenIds, limit })
  const newestFirst = []
  let pageToken = null
  for (let index = 0; index < maxPages; index += 1) {
    let page
    try {
      page = await list({ chatId, start, end, pageToken, pageSize: 50, order: 'desc' })
    } catch {
      break
    }
    if (!page?.ok) break
    newestFirst.push(...page.messages)
    if (!page.hasMore || !page.pageToken || pick(newestFirst).length >= limit) break
    pageToken = page.pageToken
  }
  return pick(newestFirst)
}

// bug 表「问题截图」下载到附件目录（与群消息图片同目录口径 runtime/lark-attachments/<项目>/<record_id>/），
// 按文件头改真实扩展名，返回与群消息附件同形的 { type:'image', imageKey, name, localPath | downloadError }。
// 逐张下载：lark-cli 单个 --file-token 时 --output 就是文件本身；失败只记 downloadError，不拦任务。
export const downloadBugScreenshots = async ({ project, recordId, bug, screenshots = [] }) => {
  if (!screenshots.length || !bug?.appToken || !bug?.tableId || !recordId) return []
  const outDir = attachmentsDirFor(project, recordId)
  mkdirSync(outDir, { recursive: true })
  const resolved = []
  for (const [index, shot] of screenshots.entries()) {
    const fileName = `${index + 1}-${String(shot.fileToken).replace(/[^\w.-]/g, '_').slice(0, 80)}.img`
    const result = await runLarkCli([
      'base', '+record-download-attachment',
      '--base-token', bug.appToken,
      '--table-id', bug.tableId,
      '--record-id', recordId,
      '--file-token', shot.fileToken,
      '--output', `./${fileName}`,
      '--overwrite',
    ], { cwd: outDir })
    const base = { type: 'image', imageKey: shot.fileToken, name: shot.name || null, source: 'bugtable' }
    resolved.push(larkCallFailed(result)
      ? { ...base, downloadError: formatLarkCliError(result).slice(0, 200) }
      : { ...base, localPath: renameByImageMagic(join(outDir, fileName)) })
  }
  return resolved
}
