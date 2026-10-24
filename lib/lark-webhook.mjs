/**
 * Lark 自定义机器人 webhook 发送：外部群（跨租户）加不了应用机器人，只能加「自定义机器人」，
 * 它只有一条单向 webhook（无 message_id 返回、不能读群）。这里把 bot 既有的 interactive 卡片 JSON
 * 原样封进 webhook body，并按 Lark 规范做签名（secret 开启时）。
 *
 * 签名规范：timestamp(秒) + "\n" + secret 作为 HMAC-SHA256 的 key，对空串取 digest 后 base64。
 */

import { createHmac } from 'node:crypto'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export const signWebhook = ({ secret, timestamp }) =>
  createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64')

// Markdown → interactive 卡片的 markdown 元素。10-20 实测：自定义机器人的 post 富文本不认 text 的 style，
// 带一处加粗整条 19002「unknown content value」拒收（日报 / 私聊通知全军覆没）。卡片 markdown 认加粗 / 列表 / 链接，
// 不认 # 标题：首个 # 标题作卡片标题，其余标题改成加粗行。
export const markdownToCard = (markdown) => {
  let title = ''
  const lines = []
  for (const raw of String(markdown || '').split('\n')) {
    const h1 = raw.match(/^#\s+(.*)$/)
    if (h1 && !title) {
      title = h1[1].trim()
      continue
    }
    const heading = raw.match(/^#{1,6}\s+(.*)$/)
    lines.push(heading ? `**${heading[1].trim()}**` : raw.trimEnd())
  }
  return {
    config: { wide_screen_mode: true },
    ...(title ? { header: { title: { tag: 'plain_text', content: title } } } : {}),
    elements: [{ tag: 'markdown', content: lines.join('\n').trim() }],
  }
}

// 组 webhook body：card 为 bot 内部的 interactive 卡片 content（JSON 字符串），markdown 转卡片 markdown 元素，text 为纯文本兜底。
export const buildWebhookBody = ({ card, markdown, text, secret, now = Date.now() }) => {
  const body = card
    ? { msg_type: 'interactive', card: typeof card === 'string' ? JSON.parse(card) : card }
    : markdown
      ? { msg_type: 'interactive', card: markdownToCard(markdown) }
      : { msg_type: 'text', content: { text: String(text || '') } }
  if (secret) {
    const timestamp = String(Math.floor(now / 1000))
    body.timestamp = timestamp
    body.sign = signWebhook({ secret, timestamp })
  }
  return body
}

// Lark webhook 成功响应：新版 `{ code: 0, msg: 'success' }`，旧版 `{ StatusCode: 0, StatusMessage: 'success' }`。
export const isWebhookSuccess = (payload) =>
  Boolean(payload) && ((payload.code === 0) || (payload.StatusCode === 0 && payload.code == null))

// 只对「确定没送达」的失败重试（aven 2026-10-20 review）：自定义机器人没有幂等键，送达了再发一遍群里就是两条。
//   · 连接没建立（DNS 解析失败、拒绝连接、网络不可达、连接阶段超时、TLS 握手失败）：请求没出去，重试；
//   · HTTP 502 / 503：网关没把请求交给后端，重试；
//   · 其它一律不重试——请求整体超时（可能已送达、只是响应慢）、读响应失败、500 / 504、200 但响应解析不了、带错误码的 4xx（签名 / 参数错）。拿不准就不重试。
const CONNECT_ERROR_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT'])
const RETRY_STATUSES = new Set([502, 503])
// TLS 握手阶段的 OpenSSL 报错（ERR_SSL_*，如 TLSV1_ALERT_INTERNAL_ERROR）：连接还没建好、请求体没发出去，同样可以重试。
// 10-24 真机：PHP 后端群的「收到」撞上一次握手失败，被当成「可能已送达」不重试，群里一句没回。
const isTlsHandshakeError = (code) => typeof code === 'string' && code.startsWith('ERR_SSL_')
// Node fetch（undici）的网络错误是 TypeError('fetch failed')，真正的错误码在 cause 上。
export const isConnectError = (error) => {
  const code = error?.cause?.code || error?.code
  return CONNECT_ERROR_CODES.has(code) || isTlsHandshakeError(code)
}

export const sendWebhookMessage = async ({ url, secret, card, markdown, text, logPrefix = 'webhook', retries = 3, fetchImpl = fetch, sleepImpl = sleep }) => {
  if (!url) return { ok: false, reason: 'missing webhook url', messageId: null }
  let reason = ''
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    let retryable = false
    let response = null
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildWebhookBody({ card, markdown, text, secret })),
        signal: AbortSignal.timeout(15_000),
      })
    } catch (error) {
      retryable = isConnectError(error)
      reason = `${retryable ? '连接失败' : '请求失败（可能已送达，不重试）'}：${String(error?.cause?.code || error?.message || error).slice(0, 200)}`
    }
    if (response) {
      let raw = null
      try {
        raw = await response.text()
      } catch (error) {
        reason = `读响应失败（可能已送达，不重试）：${String(error?.message || error).slice(0, 200)}`
      }
      if (raw != null) {
        let payload = null
        try {
          payload = JSON.parse(raw)
        } catch {
          payload = null
        }
        if (response.ok && isWebhookSuccess(payload)) {
          console.log(`[lark-gateway] ${logPrefix} ok via webhook${attempt > 1 ? ` (attempt ${attempt})` : ''}`)
          // 自定义机器人不返回 message_id：回执无法登记为可回复锚点，控制通道靠「回复原任务消息 / 显式指令」。
          return { ok: true, messageId: null }
        }
        reason = `HTTP ${response.status} ${raw.slice(0, 200)}`
        retryable = RETRY_STATUSES.has(response.status)
      }
    }
    console.error(`[lark-gateway] ${logPrefix} webhook attempt ${attempt}/${retries} failed: ${reason}`)
    if (!retryable) break
    if (attempt < retries) await sleepImpl(attempt * 1500)
  }
  return { ok: false, reason, messageId: null }
}
