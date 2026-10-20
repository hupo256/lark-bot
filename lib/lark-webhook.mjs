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

export const sendWebhookMessage = async ({ url, secret, card, markdown, text, logPrefix = 'webhook', retries = 3, fetchImpl = fetch, sleepImpl = sleep }) => {
  if (!url) return { ok: false, reason: 'missing webhook url', messageId: null }
  let reason = ''
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildWebhookBody({ card, markdown, text, secret })),
        signal: AbortSignal.timeout(15_000),
      })
      const raw = await response.text()
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
      // 签名 / 参数类错误重试无意义（9499 签名错、19001 参数错等），只对 5xx / 网络抖动重试。
      if (response.status < 500 && payload && payload.code != null) break
    } catch (error) {
      reason = String(error?.message || error).slice(0, 200)
    }
    console.error(`[lark-gateway] ${logPrefix} webhook attempt ${attempt}/${retries} failed: ${reason}`)
    if (attempt < retries) await sleepImpl(attempt * 1500)
  }
  return { ok: false, reason, messageId: null }
}
