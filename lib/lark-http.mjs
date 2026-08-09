/**
 * Lark Gateway 的 HTTP 小工具（纯/近纯）：带上限的 body 读取、JSON 响应、aiExecutor 归一化。
 */

// POST body 上限，防止本地异常进程灌爆内存（默认 1MB）
const maxBodyBytes = Number(process.env.LARK_GATEWAY_MAX_BODY || 1024 * 1024)

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
        resolve({})
      }
    })
    req.on('end', () => {
      if (aborted) return
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch {
        resolve({})
      }
    })
  })

export const sendJson = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

const VALID_AI_EXECUTORS = new Set(['claude', 'codex'])

export const normalizeAiExecutor = (value) => {
  if (value == null || value === '') return undefined
  const normalized = String(value).trim().toLowerCase()
  if (!VALID_AI_EXECUTORS.has(normalized)) throw new Error(`invalid aiExecutor: ${value}`)
  return normalized
}
