/**
 * 代答 / 实测会话里 node 进程的出网核对（NODE_OPTIONS=--import 预载，口径见 lib/lark-egress-policy.mjs）。
 * 只在环境里有 LARK_EGRESS_GUARD 时生效：
 * - fetch / http(s).request / get：按方法 + 地址核对（代答只许读，实测 / 改代码自测另许登录，含发登录验证码——看请求体里的用途）；
 * - net.connect / createConnection、tls.connect：按主机核对——fetch 跟跳转、WebSocket、第三方 http 库最后都走这里。
 * 拦下时 stderr 打一行「[lark-egress] 已拦截 …」（脚本自己吞了错误，会话也看得到），请求以普通网络错误失败，不让进程崩。
 */
import http from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
import { realpathSync } from 'node:fs'
import net from 'node:net'
import tls from 'node:tls'
import { fileURLToPath } from 'node:url'

import { EGRESS_GUARD_ENV, checkEgressRequest, hostInScope, blockedHostReason, parseEgressPolicy } from '../../lib/lark-egress-policy.mjs'

// 进程入口是登录工具 tools/env-login.mjs：代答里也许它发登录 POST（只登录，口径见 checkEgressRequest）。认 argv[1] 的真实路径，
// 会话自己写的脚本（/tmp/probe.mjs 再 import 业务仓客户端）不算。argv[1] 不是文件（node -e）按「不是」算。
const real = (path) => { try { return realpathSync(path) } catch { return null } }
const loginTool = Boolean(process.argv[1]) && real(process.argv[1]) === real(fileURLToPath(new URL('../env-login.mjs', import.meta.url)))
const parsed = process.env[EGRESS_GUARD_ENV] ? parseEgressPolicy(process.env[EGRESS_GUARD_ENV]) : null
const policy = parsed && loginTool ? { ...parsed, loginTool: true } : parsed

if (policy) {
  const said = new Set()
  const blockError = (what, reason) => {
    const line = `[lark-egress] 已拦截 ${what}：${reason}`
    if (!said.has(line)) {
      said.add(line)
      try { process.stderr.write(`${line}\n`) } catch { /* 写不了 stderr 也照拦 */ }
    }
    return Object.assign(new Error(line), { code: 'ELARKEGRESS' })
  }
  // 建连：拦下时给一个马上报错的空 socket（同步抛会让 http.get 这类调用直接崩进程）。
  const deadSocket = (error) => {
    const socket = new net.Socket()
    process.nextTick(() => socket.destroy(error))
    return socket
  }
  const connectHost = (args) => {
    const [first, second] = args
    if (first && typeof first === 'object') return first.path ? null : (first.host ?? first.hostname ?? first.servername ?? 'localhost')
    if (typeof first === 'string' && !/^\d+$/.test(first)) return null // unix socket 路径
    return typeof second === 'string' ? second : 'localhost'
  }
  for (const [mod, name] of [[net, 'connect'], [net, 'createConnection'], [tls, 'connect']]) {
    const orig = mod[name]
    mod[name] = function guardedConnect(...args) {
      const host = connectHost(args)
      if (host != null && !hostInScope(policy, host)) return deadSocket(blockError(`连接 ${host}`, blockedHostReason(policy, host)))
      return orig.apply(this, args)
    }
  }

  const origFetch = globalThis.fetch
  if (typeof origFetch === 'function') {
    globalThis.fetch = function fetch(input, init) {
      let url = null
      try { url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url } catch { url = null }
      const method = String(init?.method || (typeof input === 'object' && input?.method) || 'GET').toUpperCase()
      // 请求体只认字符串 / URLSearchParams（发码时看用途）；没有体 = []；FormData / 流 / Request 自带体读不到 = undefined
      const body = init?.body ?? (input instanceof Request ? input.body : null)
      const bodies = body == null ? [] : typeof body === 'string' || body instanceof URLSearchParams ? [String(body)] : undefined
      if (url) {
        const check = checkEgressRequest(policy, { method, url, bodies })
        if (!check.ok) return Promise.reject(new TypeError('fetch failed', { cause: blockError(`${method} ${url}`, check.reason) }))
      }
      return origFetch.apply(this, arguments)
    }
  }

  // http(s).request(url?, options?, cb?)：拼出方法与地址；不在范围就建好请求立刻 destroy（头还没写出去），以 error 事件失败。
  // 发验证码的 POST 要看请求体：write / end 先攒着，end 时按体核对，过了再一次写出去。
  const requestTarget = (proto, args) => {
    const [a, b] = args
    const opts = { ...(a && typeof a === 'object' && !(a instanceof URL) ? a : {}), ...(b && typeof b === 'object' ? b : {}) }
    const base = typeof a === 'string' || a instanceof URL ? new URL(String(a)) : null
    const method = String(opts.method || 'GET').toUpperCase()
    if (base) return { method, url: base.href }
    const host = opts.hostname || opts.host || 'localhost'
    return { method, url: `${opts.protocol || proto}//${String(host).includes(':') && !String(host).startsWith('[') ? `[${host}]` : host}${opts.port ? `:${opts.port}` : ''}${opts.path || '/'}` }
  }
  for (const [mod, proto] of [[http, 'http:'], [https, 'https:']]) {
    const origRequest = mod.request
    const guarded = function request(...args) {
      let target = null
      try { target = requestTarget(proto, args) } catch { target = null }
      const check = target ? checkEgressRequest(policy, target) : { ok: true }
      const req = origRequest.apply(this, args)
      const pendingBody = !check.ok && target && checkEgressRequest(policy, { ...target, bodies: ['scene=login'] }).ok
      if (pendingBody) {
        const chunks = []
        const [write, end] = [req.write, req.end]
        req.write = (chunk, ...rest) => { if (chunk != null && typeof chunk !== 'function') chunks.push(Buffer.from(chunk)); rest.find((a) => typeof a === 'function')?.(); return true }
        req.end = (chunk, ...rest) => {
          if (chunk != null && typeof chunk !== 'function') chunks.push(Buffer.from(chunk))
          const final = checkEgressRequest(policy, { ...target, bodies: [Buffer.concat(chunks).toString('utf8')] })
          if (!final.ok) return req.destroy(blockError(`${target.method} ${target.url}`, final.reason))
          for (const piece of chunks) write.call(req, piece)
          return end.call(req, ...rest.filter((a) => typeof a === 'function'))
        }
      } else if (!check.ok) req.destroy(blockError(`${target.method} ${target.url}`, check.reason))
      return req
    }
    mod.request = guarded
    mod.get = function get(...args) {
      const req = guarded.apply(this, args)
      req.end()
      return req
    }
  }
  syncBuiltinESMExports()
}
