#!/usr/bin/env node
/**
 * 代答 / 实测的 curl 壳本体（bin/curl 调；口径见 lib/lark-egress-policy.mjs）。
 * 1. 先按参数核对方法 + 地址（不在范围 / 写操作 / 绕开核对的选项 → stderr 说明，退出码 2，真 curl 不起）；
 * 2. 再起一个只认范围内主机的本机代理，真 curl 带 `-q --proxy` 走它：-L 跳到范围外、参数没认出来的地址，在建连时一样拦。
 * 没有 LARK_EGRESS_GUARD（不是代答 / 实测会话）就原样交给真 curl。真 curl = PATH 里本壳目录之后的第一个 curl（回放的审计壳也在那条链上）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { accessSync, constants, realpathSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { EGRESS_BLOCK_EXIT, EGRESS_GUARD_ENV, blockedHostReason, checkCurlInvocation, checkEgressRequest, hostInScope, parseEgressPolicy } from '../../lib/lark-egress-policy.mjs'

const binDir = join(dirname(fileURLToPath(import.meta.url)), 'bin')
const real = (path) => { try { return realpathSync(path) } catch { return path } }
const realCurl = () => {
  for (const dir of String(process.env.PATH || '').split(':')) {
    if (!dir || real(dir) === real(binDir)) continue
    try {
      accessSync(join(dir, 'curl'), constants.X_OK)
      return join(dir, 'curl')
    } catch { /* 下一个 */ }
  }
  return '/usr/bin/curl'
}
const childPath = () => String(process.env.PATH || '').split(':').filter((dir) => dir && real(dir) !== real(binDir)).join(':')
const argv = process.argv.slice(2)
const policy = process.env[EGRESS_GUARD_ENV] ? parseEgressPolicy(process.env[EGRESS_GUARD_ENV]) : null
const say = (line) => process.stderr.write(`[lark-egress] ${line}\n`)

if (!policy) {
  const run = spawnSync(realCurl(), argv, { stdio: 'inherit', env: { ...process.env, PATH: childPath() } })
  process.exit(run.status ?? 1)
}

const first = checkCurlInvocation(policy, argv)
if (!first.ok) {
  say(`已拦截 curl：${first.reason}`)
  process.exit(EGRESS_BLOCK_EXIT)
}

const deny = (where, reason) => say(`已拦截 ${where}：${reason}`)
const server = http.createServer((req, res) => {
  const check = checkEgressRequest(policy, { method: req.method, url: req.url })
  if (!check.ok) {
    deny(`${req.method} ${req.url}`, check.reason)
    res.writeHead(403, { 'X-Lark-Egress': 'blocked' }).end()
    return
  }
  const target = new URL(req.url)
  const upstream = http.request({ host: target.hostname, port: target.port || 80, method: req.method, path: `${target.pathname}${target.search}`, headers: req.headers }, (up) => {
    res.writeHead(up.statusCode || 502, up.headers)
    up.pipe(res)
  })
  upstream.on('error', () => res.writeHead(502).end())
  req.pipe(upstream)
})
const tunnel = (socket, host, port, head, preface = null) => {
  const upstream = net.connect(Number(port), host, () => {
    if (preface) upstream.write(preface)
    else socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head?.length) upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
  upstream.on('error', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
}
server.on('connect', (req, socket, head) => {
  const m = String(req.url).match(/^\[?([^\]]+?)\]?:(\d+)$/)
  const [host, port] = m ? [m[1], m[2]] : [String(req.url), '443']
  if (!hostInScope(policy, host)) {
    deny(`连接 ${host}`, blockedHostReason(policy, host))
    socket.end('HTTP/1.1 403 Forbidden\r\nX-Lark-Egress: blocked\r\n\r\n')
    return
  }
  tunnel(socket, host, port, head)
})
// ws:// 经代理是 upgrade：核对后把请求头原样转给目标
server.on('upgrade', (req, socket, head) => {
  const check = checkEgressRequest(policy, { method: req.method, url: req.url })
  if (!check.ok) {
    deny(`${req.method} ${req.url}`, check.reason)
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
    return
  }
  const target = new URL(req.url)
  const lines = [`${req.method} ${target.pathname}${target.search} HTTP/1.1`, ...Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`), '', '']
  tunnel(socket, target.hostname, target.port || 80, head, lines.join('\r\n'))
})

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address()
  const env = { ...process.env, PATH: childPath() }
  for (const key of ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY', 'no_proxy', 'NO_PROXY']) delete env[key]
  // -q 必须是第一个参数（不读 ~/.curlrc，那里可能配了代理 / noproxy）
  const child = spawn(realCurl(), ['-q', '--proxy', `http://127.0.0.1:${port}`, ...argv], { stdio: 'inherit', env })
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal))
  child.on('exit', (code, signal) => {
    server.close()
    process.exit(code ?? (signal ? 128 : 1))
  })
  child.on('error', (error) => {
    say(`真 curl 起不来：${error.message}`)
    process.exit(1)
  })
})
