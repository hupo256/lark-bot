/**
 * 邮件转发包自带的 lark-cli 调用层（11-05 P1 拆分，见 docs/plan/plan-mail-relay-standalone-2026-11-05.md）。
 * 只放转发用得到的：跑子进程、判失败、带退避重试、发 / 回 Markdown。不依赖 lark-bot 的任何模块，独立运行（Mac mini）就用这一份。
 *
 * lark-bot 内置使用时注入它自己的 runLarkCli（带应用令牌缓存、单测不碰真飞书），下面这些拼参数的函数只调注入的 run，
 * 所以内置时行为与 lark-bot 的 lib/lark-cli.mjs 逐字相同——__tests__/lark-mail-relay.test.mjs 有一段对照测试钉住两边参数一致。
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'

// 单测进程里没显式指定就用 /usr/bin/false：测试绝不碰真实飞书。
export const larkCliBin = process.env.MAIL_RELAY_LARK_CLI_BIN || process.env.LARK_CLI_BIN || (process.env.NODE_TEST_CONTEXT ? '/usr/bin/false' : 'lark-cli')
const timeoutMsDefault = Number(process.env.LARK_CLI_TIMEOUT_MS || 60000)

// 跑一次 lark-cli，返回 { code, stdout, stderr }。identity 默认 bot（邮箱读写传 user）；env 额外环境变量（LARKSUITE_CLI_CONFIG_DIR 换应用）。
// 超时先 SIGTERM，3 秒后 SIGKILL，以 code -1 结算；在 'close' 上结算（stdout 读完）。
export const runLarkCli = (args, { timeoutMs = timeoutMsDefault, cwd, identity = 'bot', env } = {}) =>
  new Promise((resolve) => {
    const child = spawn(larkCliBin, ['--as', identity, ...args], { stdio: ['ignore', 'pipe', 'pipe'], cwd, ...(env ? { env: { ...process.env, ...env } } : {}) })
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
    child.on('close', (code) => finish({ code, stdout, stderr }))
  })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 成功判定：进程 0 退出且 stdout 没有 "ok":false。
export const larkCallFailed = (result) => result.code !== 0 || /"ok"\s*:\s*false/.test(result.stdout)

// 瞬时错误（网络 / 超时 / 限流）：重试；权限 / 参数类不重试。
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

// 调用 + 重试 + 退避，返回 { ok, result } / { ok: false, reason, transient? }。
export const runLarkCliWithRetry = async (args, { logPrefix, retries = 3, logTag = '[lark-mail-relay]', run = runLarkCli, wait = sleep } = {}) => {
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
    if (attempt < retries) await wait(attempt * 1500)
  }
  console.error(`${logTag} ${logPrefix} gave up after ${retries} attempts`)
  return transient ? { ok: false, reason, transient } : { ok: false, reason }
}

const parseJson = (stdout) => {
  try {
    return JSON.parse(String(stdout || ''))
  } catch {
    return null
  }
}
export const parseSentMessageId = (stdout) => {
  const payload = parseJson(stdout)
  return payload?.data?.message_id || payload?.data?.message?.message_id || payload?.message_id || null
}
export const parseSentChatId = (stdout) => {
  const payload = parseJson(stdout)
  return payload?.data?.chat_id || payload?.data?.message?.chat_id || null
}

// ou_ 是用户 open_id（私信），其余按群 chat_id。
export const messageSendRecipientArgs = (recipientId) => {
  const id = String(recipientId || '')
  return id.startsWith('ou_') ? ['--user-id', id] : ['--chat-id', id]
}

// headline：第一行单独放成 post 的 text 段（加粗），话题收起时摘要能显示出来（11-03 审批群真机对照）。
export const headlinePostContent = (markdown) => {
  const [first, ...rest] = String(markdown || '').split('\n')
  const body = rest.join('\n').trim()
  const rows = [[{ tag: 'text', text: first.replace(/\*\*/g, ''), style: ['bold'] }], ...(body ? [[{ tag: 'md', text: body }]] : [])]
  return JSON.stringify({ zh_cn: { content: rows } })
}
const markdownArgs = (markdown, headline) => (headline ? ['--msg-type', 'post', '--content', headlinePostContent(markdown)] : ['--markdown', String(markdown || '')])

export const markdownIdempotencyKey = (target, markdown) => `md-${createHash('sha1').update(`${target}\n${markdown}`).digest('hex').slice(0, 40)}`

export const sendMarkdown = async ({ chatId, markdown, headline = false, logPrefix = 'markdown', idempotencyKey = markdownIdempotencyKey(chatId, markdown), retries = 3, logTag = '[lark-mail-relay]', run = runLarkCli }) => {
  if (!chatId) {
    console.warn(`${logTag} ${logPrefix}: skipped, missing chatId`)
    return { ok: false, messageId: null, reason: 'missing chatId' }
  }
  const args = ['im', '+messages-send', ...messageSendRecipientArgs(chatId), ...markdownArgs(markdown, headline), '--idempotency-key', String(idempotencyKey).slice(0, 50), '--format', 'json']
  const outcome = await runLarkCliWithRetry(args, { logPrefix: `${logPrefix} -> ${chatId}`, retries, logTag, run })
  if (!outcome.ok) return { ok: false, messageId: null, reason: outcome.reason }
  return { ok: true, messageId: parseSentMessageId(outcome.result?.stdout), chatId: parseSentChatId(outcome.result?.stdout), reason: null }
}

// 回复一条消息；非瞬时失败且给了 fallbackChatId → 回落直发（键加 -s）。
export const replyMarkdown = async ({ messageId, markdown, headline = false, inThread = false, fallbackChatId = null, fallbackMarkdown = null, logPrefix = 'reply', idempotencyKey = markdownIdempotencyKey(messageId, markdown), retries = 3, logTag = '[lark-mail-relay]', run = runLarkCli }) => {
  if (!messageId) {
    if (fallbackChatId) return { ...(await sendMarkdown({ chatId: fallbackChatId, markdown: fallbackMarkdown || markdown, headline, logPrefix, idempotencyKey, retries, logTag, run })), via: 'send' }
    return { ok: false, messageId: null, via: 'reply', reason: 'missing messageId' }
  }
  const key = String(idempotencyKey).slice(0, 50)
  const args = ['im', '+messages-reply', '--message-id', messageId, ...markdownArgs(markdown, headline), ...(inThread ? ['--reply-in-thread'] : []), '--idempotency-key', key, '--format', 'json']
  const outcome = await runLarkCliWithRetry(args, { logPrefix: `${logPrefix} -> ${messageId}`, retries, logTag, run })
  if (outcome.ok) return { ok: true, messageId: parseSentMessageId(outcome.result?.stdout), via: 'reply', reason: null }
  if (!fallbackChatId || outcome.transient) return { ok: false, messageId: null, via: 'reply', reason: outcome.reason }
  console.warn(`${logTag} ${logPrefix}：回复 ${messageId} 失败（${outcome.reason}），回落直发 ${fallbackChatId}`)
  const sent = await sendMarkdown({ chatId: fallbackChatId, markdown: fallbackMarkdown || markdown, headline, logPrefix: `${logPrefix} fallback`, idempotencyKey: `${key.slice(0, 48)}-s`, retries, logTag, run })
  return { ...sent, via: 'send', reason: sent.ok ? null : `回复失败（${outcome.reason}），直发也失败（${sent.reason}）` }
}
