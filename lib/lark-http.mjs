/**
 * Lark Gateway 的 HTTP 小工具（纯/近纯）：带上限的 body 读取、JSON 响应、aiExecutor 归一化。
 */

import { AI_EXECUTORS } from './lark-constants.mjs'

// POST body 上限，防止本地异常进程灌爆内存（默认 1MB）
const maxBodyBytes = Number(process.env.LARK_GATEWAY_MAX_BODY || 1024 * 1024)

// 超限 / 非法 JSON 一律 resolve null：以前返回 {}，/intake 会把空 body 当「分类结果缺失」把任务静默落成 ignored，
// /status 则 404。路由层对 null 统一回 400（见 readJsonBody）。空 body 仍是 {}（部分路由允许无参数）。
export const readBody = (req) =>
  new Promise((resolve) => {
    let data = ''
    let aborted = false
    req.on('data', (chunk) => {
      if (aborted) return
      data += chunk
      if (data.length > maxBodyBytes) {
        aborted = true
        req.destroy()
        resolve(null)
      }
    })
    req.on('end', () => {
      if (aborted) return
      try {
        const parsed = data ? JSON.parse(data) : {}
        resolve(parsed && typeof parsed === 'object' ? parsed : null)
      } catch {
        resolve(null)
      }
    })
  })

// 读 JSON body；坏 body 直接回 400 并返回 null，调用方 `if (!body) return`。
export const readJsonBody = async (req, res) => {
  const body = await readBody(req)
  if (body) return body
  sendJson(res, 400, { ok: false, error: 'invalid or oversized JSON body' })
  return null
}

export const sendJson = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

export const normalizeAiExecutor = (value) => {
  if (value == null || value === '') return undefined
  const normalized = String(value).trim().toLowerCase()
  if (!AI_EXECUTORS.has(normalized)) throw new Error(`invalid aiExecutor: ${value}`)
  return normalized
}
