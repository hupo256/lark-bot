/**
 * 代答 / 实测的出网范围（aven 11-04，docs/falive-replay-design-v2.md §7「出网范围」）在命令层的口径。纯函数，不起进程。
 *
 * 为什么不靠 --allowedTools：b2 回放 ep-1031-f8065f 里代答会话的 permissionMode 是 auto（继承的默认档），白名单外的
 * `curl accounts.google.com/gsi/…` 由自动审批放行了；配了页面工具的实测又是 --dangerously-skip-permissions，白名单整个不看。
 * Bash(curl …) 前缀规则也表达不了「主机在范围里」（选项写在 URL 前面、-L 跳转、循环 / $(…) 里拼地址）。
 * 所以改在进程环境上拦（两种权限档都生效）：
 * - PATH 最前放 tools/egress-guard/bin：curl 壳先按方法 + 地址核对，再经一个只认范围内主机的本机代理跑真 curl（-L 跳出范围也拦）；wget 直接不给用。
 * - NODE_OPTIONS 预载 tools/egress-guard/preload.mjs：会话里跑的 node 脚本（如 falive-react 的 pre-client.mjs）的 fetch / http(s)
 *   按方法 + 地址核对，net / tls 建连按主机核对（跳转、WebSocket、第三方库都走这里）。
 * - claude 的 deny 规则摘掉 WebFetch / WebSearch、拦绝对路径的 curl / wget 与 `command -p`（绕过 PATH 的写法）。
 * 范围：配置 envSites 的主机及同主域子站（与 lark-env-target 同一个主域口径）+ 本机。方法：代答只许 GET / HEAD / OPTIONS；
 * 实测另外许登录 POST（路径含 login，不含注册 / 验证码）。没覆盖的：python 等其它语言自己发请求、浏览器（页面工具）里页面自带的第三方资源。
 */

import { baseDomain, hostOf } from './lark-env-target.mjs'

export const EGRESS_SCOPES = Object.freeze(['answer', 'verification'])
export const EGRESS_GUARD_ENV = 'LARK_EGRESS_GUARD'
export const EGRESS_BLOCK_EXIT = 2

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const LOGIN_PATH_RE = /login/i
const REGISTER_PATH_RE = /regist|sendVerificationCode|verif(?:y|ication)_?code|signup|sign_up/i
const LOCAL_HOST_RE = /^(?:127(?:\.\d{1,3}){3}|localhost|::1|0\.0\.0\.0)$/i
const SCOPE_LABEL = { answer: '代答', verification: '实测' }

// 会话里绕过 PATH 壳 / 走 claude 自带联网工具的写法（deny 规则在 auto / 跳过权限两档下都生效，11-04 探针）。
export const EGRESS_DENY_RULES = Object.freeze(['WebFetch', 'WebSearch', 'Bash(*/curl *)', 'Bash(*/wget *)', 'Bash(command -p *)'])

// 任务 → 出网范围档：契约交付物是代答 / 实测才拦（与 resolveTaskMode 同一判据）。
export const egressScopeOf = (task) => (EGRESS_SCOPES.includes(task?.contract?.deliverable) ? task.contract.deliverable : null)

// scope 不在 answer / verification 里 → null（不拦）。没配 envSites → domains 为空：除本机外一律不打（与提示「不去打任何地址」一致）。
export const egressPolicyFor = ({ scope, envSites = null } = {}) => {
  if (!EGRESS_SCOPES.includes(scope)) return null
  const domains = [...new Set(Object.values(envSites || {}).map((url) => (typeof url === 'string' ? hostOf(url.trim()) : null)).filter(Boolean).map(baseDomain))]
  return { scope, domains }
}

export const parseEgressPolicy = (text) => {
  try {
    const value = JSON.parse(text)
    return EGRESS_SCOPES.includes(value?.scope) && Array.isArray(value.domains) ? value : null
  } catch {
    return null
  }
}

const normHost = (host) => String(host || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
export const isLocalHost = (host) => LOCAL_HOST_RE.test(normHost(host))
export const hostInScope = (policy, host) => {
  const h = normHost(host)
  return isLocalHost(h) || policy.domains.some((domain) => h === domain || h.endsWith(`.${domain}`))
}

const scopeText = (policy) => `${SCOPE_LABEL[policy.scope]}只许打配置的环境（${policy.domains.length ? `${policy.domains.join('、')} 及其子域` : '本仓没配环境地址'}；本机不限）`
export const blockedHostReason = (policy, host) =>
  `${scopeText(policy)}，${normHost(host) || '(无主机)'} 不在范围里：上游 / 合作方 / 第三方地址不打，它们的状态只转述上下文并写明出处和日期；不要换 /usr/bin/curl、python、node 等写法绕过。`
const methodReason = (policy, method, path) => policy.scope === 'verification'
  ? `实测只许 GET / HEAD / OPTIONS 和拿登录态的登录 POST（路径含 login），${method} ${path} 不发：注册 / 发验证码 / 下单 / 改数据一律不做。`
  : `代答只许 GET / HEAD / OPTIONS，${method} ${path} 不发（登录 POST 只在实测里有）。`

// 一次请求（方法 + 地址）在不在范围：{ ok, reason }。地址可不带协议（curl 认 host/path）。
export const checkEgressRequest = (policy, { method = 'GET', url }) => {
  let u
  try {
    u = new URL(/^[a-z][\w+.-]*:\/\//i.test(String(url)) ? String(url) : `http://${url}`)
  } catch {
    return { ok: false, reason: `认不出地址 ${String(url).slice(0, 80)}（URL 通配 {a,b} / [1-3] 也不支持），写成完整的 http(s) 地址。` }
  }
  if (u.protocol === 'file:') return { ok: true }
  if (!/^(?:https?|wss?):$/.test(u.protocol)) return { ok: false, reason: `只许 http(s) / ws(s)，${u.protocol} 不打。` }
  if (!hostInScope(policy, u.hostname)) return { ok: false, reason: blockedHostReason(policy, u.hostname) }
  if (isLocalHost(u.hostname)) return { ok: true }
  const m = String(method || 'GET').toUpperCase()
  if (READ_METHODS.has(m)) return { ok: true }
  if (policy.scope === 'verification' && m === 'POST' && LOGIN_PATH_RE.test(u.pathname) && !REGISTER_PATH_RE.test(u.pathname)) return { ok: true }
  return { ok: false, reason: methodReason(policy, m, `${u.host}${u.pathname}`) }
}

// curl 带值的选项（curl 8.7 `--help all` 里带 <参数> 的全部，另加 -x/--proxy）；其余非 - 开头的参数都是 URL。
const CURL_VALUE_SHORT = new Set('EKCbcdDFPHmoUQreXYytzTuAwx'.split(''))
const CURL_VALUE_LONG = new Set(('abstract-unix-socket alt-svc aws-sigv4 cacert capath cert cert-type ciphers config connect-timeout connect-to continue-at cookie cookie-jar ' +
  'create-file-mode crlfile curves data data-ascii data-binary data-raw data-urlencode delegation dns-interface dns-ipv4-addr dns-ipv6-addr dns-servers doh-url ' +
  'dump-header egd-file engine etag-compare etag-save expect100-timeout form form-string ftp-account ftp-alternative-to-user ftp-method ftp-port ftp-ssl-ccc-mode ' +
  'happy-eyeballs-timeout-ms haproxy-clientip header hostpubmd5 hostpubsha256 hsts interface ipfs-gateway json keepalive-time key key-type krb libcurl limit-rate ' +
  'local-port login-options mail-auth mail-from mail-rcpt max-filesize max-redirs max-time netrc-file noproxy oauth2-bearer output output-dir parallel-max pass ' +
  'pinnedpubkey preproxy proto proto-default proto-redir proxy proxy-cacert proxy-capath proxy-cert proxy-cert-type proxy-ciphers proxy-crlfile proxy-header proxy-key ' +
  'proxy-key-type proxy-pass proxy-pinnedpubkey proxy-service-name proxy-tls13-ciphers proxy-tlsauthtype proxy-tlspassword proxy-tlsuser proxy-user pubkey quote ' +
  'random-file range rate referer request request-target resolve retry retry-delay retry-max-time sasl-authzid service-name socks4 socks4a socks5 ' +
  'socks5-gssapi-service socks5-hostname speed-limit speed-time stderr telnet-option tftp-blksize time-cond tls-max tls13-ciphers tlsauthtype tlspassword tlsuser ' +
  'trace trace-ascii trace-config unix-socket upload-file url url-query user user-agent variable write-out').split(' '))
// 会改走别的连接 / 读配置文件藏地址 / 换请求路径 / 分段重置代理的选项：拦（壳靠本机代理兜跳转，这些会让代理失效或让核对失真）。
const CURL_BANNED = new Set(['K', ':', 'x', 'config', 'next', 'proxy', 'preproxy', 'noproxy', 'socks4', 'socks4a', 'socks5', 'socks5-hostname', 'unix-socket',
  'abstract-unix-socket', 'doh-url', 'request-target', 'variable', 'haproxy-protocol', 'ipfs-gateway'])
const CURL_BODY = new Set(['d', 'F', 'data', 'data-ascii', 'data-binary', 'data-raw', 'data-urlencode', 'form', 'form-string', 'json'])

// { method, urls, banned }：banned 是用到的被拦选项（显示用原写法）。
export const parseCurlArgs = (argv) => {
  let method = null
  let body = false
  let get = false
  let head = false
  let upload = false
  const urls = []
  const banned = []
  const take = (name, value, raw) => {
    if (CURL_BANNED.has(name)) banned.push(raw)
    if (CURL_BODY.has(name)) body = true
    if (name === 'X' || name === 'request') method = String(value || '').toUpperCase()
    if (name === 'T' || name === 'upload-file') upload = true
    if (name === 'url') urls.push(value)
  }
  const flag = (name, raw) => {
    if (CURL_BANNED.has(name)) banned.push(raw)
    if (name === 'G' || name === 'get') get = true
    if (name === 'I' || name === 'head') head = true
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = String(argv[i])
    if (a.startsWith('--')) {
      const name = a.slice(2)
      if (CURL_VALUE_LONG.has(name)) take(name, argv[(i += 1)], a)
      else flag(name, a)
      continue
    }
    if (a.startsWith('-') && a.length > 1) {
      for (const [j, c] of [...a.slice(1)].entries()) {
        if (CURL_VALUE_SHORT.has(c)) {
          const rest = a.slice(j + 2)
          take(c, rest || argv[(i += 1)], `-${c}`)
          break
        }
        flag(c, `-${c}`)
      }
      continue
    }
    urls.push(a)
  }
  const resolved = method || (head ? 'HEAD' : get ? 'GET' : upload ? 'PUT' : body ? 'POST' : 'GET')
  return { method: resolved, urls: urls.filter((url) => url != null && url !== ''), banned }
}

// curl 壳的判定：{ ok, reason }。--version / --help 直接放。
export const checkCurlInvocation = (policy, argv) => {
  if (argv.some((a) => /^(?:-V|--version|-h|--help|--manual|-M)$/.test(a))) return { ok: true }
  const { method, urls, banned } = parseCurlArgs(argv)
  if (banned.length) return { ok: false, reason: `${scopeText(policy)}，curl 的 ${[...new Set(banned)].join(' / ')} 会绕开出网核对，不能用。` }
  for (const url of urls) {
    const check = checkEgressRequest(policy, { method, url })
    if (!check.ok) return check
  }
  return { ok: true }
}

// 给 claude 子进程的环境：PATH 最前放壳目录、NODE_OPTIONS 追加预载（保留原有的，回放的出网审计预载也在里面）、范围写进 LARK_EGRESS_GUARD。
export const egressGuardEnv = ({ policy, env = process.env, binDir, preloadPath }) => {
  if (!policy) return env
  return {
    ...env,
    PATH: `${binDir}:${env.PATH || ''}`,
    NODE_OPTIONS: `${env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ` : ''}--import ${preloadPath}`,
    [EGRESS_GUARD_ENV]: JSON.stringify(policy),
  }
}

// 去掉出网核对（页面工具起本地 dev 服务 / pnpm install 用：那是应用自己的流量，不是会话在探测）。
export const withoutEgressGuard = (env = process.env) => {
  if (!env[EGRESS_GUARD_ENV]) return env
  const { [EGRESS_GUARD_ENV]: _policy, ...rest } = env
  const opts = String(rest.NODE_OPTIONS || '').replace(/(?:^|\s)--import\s+\S*egress-guard\/preload\.mjs/g, '').trim()
  const path = String(rest.PATH || '').split(':').filter((dir) => !/egress-guard\/bin\/?$/.test(dir)).join(':')
  const next = { ...rest, PATH: path, NODE_OPTIONS: opts }
  if (!opts) delete next.NODE_OPTIONS
  return next
}
