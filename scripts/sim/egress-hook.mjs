/**
 * 回放出网审计预载（docs/replay/falive-replay-design-v2.md §8 前置 7）：run-sim 用 NODE_OPTIONS=--import 挂给 gateway / worker 及其派生的
 * 所有 node 子进程（bot 的 claude 会话里跑的 `node scripts/…`，如 falive-react 的 pre-client.mjs 直接用全局 fetch 登录 / 注册），
 * 包住 globalThis.fetch 与 http(s).request / get：每次请求记方法 + 主机 + 路径到 $SIM_DIR/egress.log（egress-log.mjs），然后原样放行。
 * 本机（127.0.0.1 / localhost：网关、vite、假端口）每个进程每个 host:port 只记一次，标 local。只记不拦。
 */
import http from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'

import { CODE_SEND_PATH_RE, codePurposeOf } from '../../lib/lark-egress-policy.mjs'
import { LOCAL_HOST_RE, TESTDATA_BLOCK_NOTE, blockedWrite, noteEgress, simBlockNote } from './egress-log.mjs'

if (process.env.SIM_DIR) {
  const seenLocal = new Set()
  // extra：'blocked' = 本预载拦下了、没发出去（同 curl 壳的记法；止损守卫 / 出网审计按它认「没写到真实环境」）。
  const note = (via, method, url, purpose = null, extra = null) => {
    try {
      const u = new URL(url)
      const host = u.hostname.replace(/^\[|\]$/g, '')
      if (LOCAL_HOST_RE.test(host)) {
        const key = `${host}:${u.port}`
        if (seenLocal.has(key)) return
        seenLocal.add(key)
      }
      noteEgress({ via, method, url: `${u.protocol}//${u.host}${u.pathname}`, purpose, extra })
    } catch {
      noteEgress({ via, method, url: String(url), extra })
    }
  }
  const origFetch = globalThis.fetch
  if (typeof origFetch === 'function') {
    globalThis.fetch = function fetch(input, init) {
      try {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url
        const method = init?.method || input?.method || 'GET'
        const body = init?.body
        const purpose = String(method).toUpperCase() !== 'GET' && CODE_SEND_PATH_RE.test(String(url))
          ? codePurposeOf({ bodies: body == null ? [] : typeof body === 'string' || body instanceof URLSearchParams ? [String(body)] : undefined, query: new URL(String(url)).search })
          : null
        const why = blockedWrite({ method, url, purpose })
        note('fetch', method, url, purpose, why ? 'blocked' : null)
        if (why) {
          const blockNote = simBlockNote({ method, url })
          return Promise.resolve(new Response(JSON.stringify({ code: 403, msg: `${blockNote}（${why}）`, sim_blocked: blockNote === TESTDATA_BLOCK_NOTE ? 'testdata' : true }), { status: 403, headers: { 'content-type': 'application/json' } }))
        }
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
          const method = fn === 'get' ? 'GET' : opts.method || 'GET'
          const why = blockedWrite({ method, url: href })
          note(proto.slice(0, -1), method, href, null, why ? 'blocked' : null)
          if (why) throw Object.assign(new Error(`${simBlockNote({ method, url: href })}（${why}）`), { code: 'SIM_BLOCKED_WRITE' })
        } catch (error) { if (error?.code === 'SIM_BLOCKED_WRITE') throw error /* 写拦截要抛出去；别的记不下也放行 */ }
        return orig.apply(this, a)
      }
    }
  }
  syncBuiltinESMExports()
}
