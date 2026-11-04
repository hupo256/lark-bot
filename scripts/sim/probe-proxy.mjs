/**
 * 回放实测转发（run-sim-falive.mjs 用；design-v2 §7「实测可发登录用的 POST，其余写操作仍禁止」）：
 * falive-react 的 scripts/lib/pre-client.mjs 读 PROBE_HOST，把它指到这里，原样转给 pre（streampre.fdsser.com）；
 * 注册 / 发验证码拦下——pre-client 登录失败会自动注册新账号（验证码 123456），回放里不许造号。每次请求记一行日志。
 *   node scripts/sim/probe-proxy.mjs --port 3299 --log /tmp/probe.log   （单独起来自测用）
 */
import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const PRE_HOST = 'https://streampre.fdsser.com'
export const BLOCKED_PROBE = /\/api\/user\/(NewRegisteredByMail|sendVerificationCode)\b/
// 逐跳头不能转（11-04：转了 transfer-encoding，fetch 直接 fetch failed，登录全挂、pre-client 转去注册）
const HOP = new Set(['host', 'connection', 'content-length', 'accept-encoding', 'transfer-encoding', 'keep-alive', 'upgrade', 'expect', 'te', 'trailer', 'proxy-connection', 'proxy-authorization'])

const readBody = (req) => new Promise((resolve) => { const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => resolve(Buffer.concat(chunks))) })

export const startProbeProxy = ({ port, logPath, upstream = PRE_HOST }) => new Promise((resolve) => {
  const log = (line) => appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`)
  const server = createServer(async (req, res) => {
    const raw = await readBody(req)
    const path = req.url || '/'
    if (BLOCKED_PROBE.test(path)) {
      log(`BLOCKED ${req.method} ${path}`)
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ code: -1, msg: '回放里不允许注册新账号 / 发验证码（用 508 测试号登录）', data: null }))
      return
    }
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !HOP.has(k.toLowerCase())))
    try {
      const response = await fetch(`${upstream}${path}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : raw, signal: AbortSignal.timeout(30_000) })
      const buf = Buffer.from(await response.arrayBuffer())
      log(`${response.status} ${req.method} ${path.slice(0, 160)}`)
      // 响应头照转（pre-client 从 b2b-visitor / b2b-visitor-token 取访客身份签后面的请求；11-04 只转 content-type 时登录全被验签打回 407）；
      // fetch 已解压，content-encoding / content-length 不转
      const out = {}
      response.headers.forEach((v, k) => { if (!HOP.has(k) && k !== 'content-encoding') out[k] = v })
      res.writeHead(response.status, out).end(buf)
    } catch (error) {
      log(`ERR ${req.method} ${path.slice(0, 160)} ${String(error?.cause?.code || error?.cause || error?.message || error).slice(0, 200)}`)
      res.writeHead(502).end()
    }
  })
  server.listen(port, '127.0.0.1', () => resolve(server))
})

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2)
  const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
  await startProbeProxy({ port: Number(value('--port', 3299)), logPath: value('--log', '/tmp/probe-proxy.log') })
  console.log(`probe proxy :${value('--port', 3299)} → ${PRE_HOST}`)
}
