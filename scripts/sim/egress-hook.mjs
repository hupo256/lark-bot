/**
 * 回放出网审计预载（docs/falive-replay-design-v2.md §8 前置 7）：run-sim 用 NODE_OPTIONS=--import 挂给 gateway / worker 及其派生的
 * 所有 node 子进程（bot 的 claude 会话里跑的 `node scripts/…`，如 falive-react 的 pre-client.mjs 直接用全局 fetch 登录 / 注册），
 * 包住 globalThis.fetch 与 http(s).request / get：每次请求记方法 + 主机 + 路径到 $SIM_DIR/egress.log（egress-log.mjs），然后原样放行。
 * 本机（127.0.0.1 / localhost：网关、vite、假端口）每个进程每个 host:port 只记一次，标 local。只记不拦。
 */
import http from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'

import { LOCAL_HOST_RE, noteEgress } from './egress-log.mjs'

if (process.env.SIM_DIR) {
  const seenLocal = new Set()
  const note = (via, method, url) => {
    try {
      const u = new URL(url)
      const host = u.hostname.replace(/^\[|\]$/g, '')
      if (LOCAL_HOST_RE.test(host)) {
        const key = `${host}:${u.port}`
        if (seenLocal.has(key)) return
        seenLocal.add(key)
      }
      noteEgress({ via, method, url: `${u.protocol}//${u.host}${u.pathname}` })
    } catch {
      noteEgress({ via, method, url: String(url) })
    }
  }
  const origFetch = globalThis.fetch
  if (typeof origFetch === 'function') {
    globalThis.fetch = function fetch(input, init) {
      try {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url
        note('fetch', init?.method || input?.method || 'GET', url)
      } catch { /* 记不下也放行 */ }
      return origFetch.apply(this, arguments)
    }
  }
  for (const [mod, proto] of [[http, 'http:'], [https, 'https:']]) {
    for (const fn of ['request', 'get']) {
      const orig = mod[fn]
      mod[fn] = function patched(...a) {
        try {
          let url
          let opts = {}
          if (typeof a[0] === 'string' || a[0] instanceof URL) {
            url = new URL(a[0])
            if (a[1] && typeof a[1] === 'object') opts = a[1]
          } else opts = a[0] || {}
          const host = opts.hostname || opts.host || url?.hostname || 'localhost'
          const port = opts.port || url?.port || ''
          const href = url && !opts.hostname && !opts.host ? url.href : `${opts.protocol || url?.protocol || proto}//${host}${port ? `:${port}` : ''}${opts.path || url?.pathname || '/'}`
          note(proto.slice(0, -1), fn === 'get' ? 'GET' : opts.method || 'GET', href)
        } catch { /* 记不下也放行 */ }
        return orig.apply(this, a)
      }
    }
  }
  syncBuiltinESMExports()
}
