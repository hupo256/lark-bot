/**
 * 代答 / 实测的出网范围（aven 11-04，docs/replay/falive-replay-design-v2.md §7「出网范围」）在命令层的口径。纯函数，不起进程。
 *
 * 为什么不靠 --allowedTools：b2 回放 ep-1031-f8065f 里代答会话的 permissionMode 是 auto（继承的默认档），白名单外的
 * `curl accounts.google.com/gsi/…` 由自动审批放行了；配了页面工具的实测又是 --dangerously-skip-permissions，白名单整个不看。
 * Bash(curl …) 前缀规则也表达不了「主机在范围里」（选项写在 URL 前面、-L 跳转、循环 / $(…) 里拼地址）。
 * 所以改在进程环境上拦（两种权限档都生效）：
 * - PATH 最前放 tools/egress-guard/bin：curl 壳先按方法 + 地址核对，再经一个只认范围内主机的本机代理跑真 curl（-L 跳出范围也拦）；wget 直接不给用。
 * - NODE_OPTIONS 预载 tools/egress-guard/preload.mjs：会话里跑的 node 脚本（如 falive-react 的 pre-client.mjs）的 fetch / http(s)
 *   按方法 + 地址核对，net / tls 建连按主机核对（跳转、WebSocket、第三方库都走这里）。
 * - claude 的 deny 规则摘掉 WebFetch / WebSearch、拦绝对路径的 curl / wget 与 `command -p`（绕过 PATH 的写法）。
 * 范围（三档，egressScopeOf）：代答 / 实测只许打 envSites 站点（去 www. 后的主机及其子域）+ 本机；改代码 / 自测（含只读查询）另许读包 / 源码源
 *（npm / GitHub / PyPI + 业务仓 origin 的 git 主机，SOURCE_HOSTS / sourceHosts）——b3 ep-1021-193c03 改码自测 curl 了上游 pre-hailiao.hai-liao-pre.com，
 * 「任何主机可读」本意只是装依赖，结果成了探上游环境（aven：上游 / 合作方只转述）。
 * 方法：代答只许 GET / HEAD / OPTIONS；实测、改代码 / 自测另许登录（含验证码登录：发登录码要看得出用途 = 登录），注册 / 上传 / 发帖 / 改数据一律拦。
 * 两个例外（aven 11-04，b3 ep-1024-9ebe13）：
 * - 登录工具 tools/env-login.mjs（进程入口就是它，预载认 argv[1]）在代答里也许发登录 POST（只登录：注册 / 发码 / 其它写照拦）；
 * - 对方明确要造测试数据（契约 testData）且配置 testData.envs 点名的环境：实测 / 改代码里许往这些环境发创建类 POST
 *   （发帖 / 评论 / 上传这类），删 / 改 / 点赞送礼 / 下单支付 / 绑定这类路径照拦（createBlockedPath）。
 * b2 ep-1023-9f0fd7（改代码任务 curl 在 pre 传头像 10 次）、ep-1020-17dd90（node 脚本 fetch 在 pre 发帖 25 / 上传 33）后，三档都挂。没覆盖的：python 等其它语言自己发请求、浏览器（页面工具）里页面自带的第三方资源。
 */

import { hostOf } from './lark-env-target.mjs'

export const EGRESS_SCOPES = Object.freeze(['answer', 'verification', 'change'])
export const EGRESS_GUARD_ENV = 'LARK_EGRESS_GUARD'
export const EGRESS_BLOCK_EXIT = 2

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
// 登录 / 注册 / 发验证码的路径口径（egress-audit 同一套）：发码看用途，登录码算登录（aven 11-04），注册码算注册。
export const REGISTER_PATH_RE = /regist|sign_?up|sign-up/i
export const CODE_SEND_PATH_RE = /sendVerificationCode|verif(?:y|ication)[\w-]*\/(?:[\w-]+\/)*send|send_?(?:sms_?|mail_?|email_?)?code|otp\/send/i
export const LOGIN_PATH_RE = /log_?in|sign_?in|sign-in/i
const PURPOSE_KEY_RE = /^(?:scene|type|purpose|usage|biz_?type|code_?type|action|event)$/i
const LOGIN_PURPOSES = ['login', 'signin', 'sign_in', 'sign-in']
const LOCAL_HOST_RE = /^(?:127(?:\.\d{1,3}){3}|localhost|::1|0\.0\.0\.0)$/i
const SCOPE_LABEL = { answer: '代答', verification: '实测', change: '改代码 / 自测' }

// 会话里绕过 PATH 壳 / 走 claude 自带联网工具的写法（deny 规则在 auto / 跳过权限两档下都生效，11-04 探针）。
export const EGRESS_DENY_RULES = Object.freeze(['WebFetch', 'WebSearch', 'Bash(*/curl *)', 'Bash(*/wget *)', 'Bash(command -p *)'])

// 任务 → 出网档：代答只读；实测、改代码 / 自测（含只读查询）只读 + 登录（b2 ep-1023-9f0fd7：改代码任务在 pre 上传了 10 次头像）。
export const egressScopeOf = (task) => (['answer', 'verification'].includes(task?.contract?.deliverable) ? task.contract.deliverable : 'change')

// 环境的站点域：envSites 主机去掉开头的 www.（www.falive.com → falive.com 及其子域；falivepre.fdsser.com 只认它自己及其子域，
// 同在 fdsser.com 下的 falivego 等别的站不算，要打就配进 envSites）。没配 envSites → 除本机外一律不打。
// loginCodeTypes：发验证码接口里表示「登录」的 type 值（如 falive php 的 3），config.egress.loginCodeTypes；scene=login 这类不用配。
// 改代码 / 自测可读的包 / 源码源（域及其子域）：装依赖、拉 GitHub 上的源码 / 发布包。pnpm install 与页面工具起 dev 服务另走 withoutEgressGuard，不靠这张表。
export const SOURCE_HOSTS = Object.freeze(['registry.npmjs.org', 'registry.npmmirror.com', 'registry.yarnpkg.com', 'github.com', 'githubusercontent.com', 'pypi.org', 'files.pythonhosted.org'])
// git 远端地址的主机：https://host/…、ssh://git@host:22/…、git@host:group/repo.git；本地路径 / 认不出返回 null。
export const gitRemoteHost = (url) => {
  const text = String(url || '').trim()
  const scp = /^[\w.-]+@([\w.-]+):(?!\/)/.exec(text)
  if (scp) return scp[1].toLowerCase()
  try {
    return /^[a-z][\w+.-]*:\/\//i.test(text) ? normHost(new URL(text).hostname) || null : null
  } catch {
    return null
  }
}
const siteDomainsOf = (urls) => [...new Set(urls.map((url) => (typeof url === 'string' ? hostOf(url.trim()) : null)).filter(Boolean).map((host) => host.replace(/^www\./, '')))]
// gitHosts：业务仓 origin 的 git 主机（改代码 / 自测可读）；testDataEnvs：本单放开建测试数据的环境（egressTestDataEnvsOf 算好；代答永远不放）。
export const egressPolicyFor = ({ scope, envSites = null, loginCodeTypes = [], gitHosts = [], testDataEnvs = [] } = {}) => {
  if (!EGRESS_SCOPES.includes(scope)) return null
  const domains = siteDomainsOf(Object.values(envSites || {}))
  const sourceHosts = scope === 'change' ? [...new Set([...SOURCE_HOSTS, ...gitHosts.filter(Boolean).map(normHost)])] : []
  const testDataDomains = scope === 'answer' ? [] : siteDomainsOf((testDataEnvs || []).map((env) => envSites?.[env]))
  return { scope, domains, sourceHosts, loginCodeTypes: (Array.isArray(loginCodeTypes) ? loginCodeTypes : []).map(String), ...(testDataDomains.length ? { testDataDomains } : {}) }
}

// 本单能不能建测试数据：契约 testData（原话明确要造，lark-task-contract）+ 配置 testData.envs ∩ envSites ∩ 配了测试号的环境。
export const egressTestDataEnvsOf = (task, localConfig = {}) => {
  if (!task?.contract?.testData || egressScopeOf(task) === 'answer') return []
  const envs = Array.isArray(localConfig?.testData?.envs) ? localConfig.testData.envs : []
  return envs.filter((env) => localConfig.envSites?.[env] && localConfig.testAccounts?.[localConfig.testData.account || env])
}

export const parseEgressPolicy = (text) => {
  try {
    const value = JSON.parse(text)
    return EGRESS_SCOPES.includes(value?.scope) && Array.isArray(value.domains) ? { loginCodeTypes: [], sourceHosts: [], ...value } : null
  } catch {
    return null
  }
}

// 建测试数据也不许的写：删 / 改 / 动别人的数据 / 钱 / 账号绑定（路径按 / _ - . 与驼峰切词，任一词命中就拦）。
const CREATE_BLOCKED_WORDS = new Set(('del delete remove rm destroy cancel clear drop reset update edit modify set change move ban kick block unblock report ' +
  'follow unfollow like unlike praise collect gift reward tip pay order buy recharge withdraw transfer bind unbind password pwd regist register signup').split(' '))
export const createBlockedPath = (pathname) => String(pathname || '').split(/[/_.-]+|(?<=[a-z0-9])(?=[A-Z])/).map((w) => w.toLowerCase()).find((w) => CREATE_BLOCKED_WORDS.has(w)) || null

const normHost = (host) => String(host || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
export const isLocalHost = (host) => LOCAL_HOST_RE.test(normHost(host))
const underAny = (domains, h) => domains.some((domain) => h === domain || h.endsWith(`.${domain}`))
const isEnvHost = (policy, h) => underAny(policy.domains, h)
// 能不能建连：本机 + 环境；改代码 / 自测另加包 / 源码源（只读），写请求另按方法核。
export const hostInScope = (policy, host) => {
  const h = normHost(host)
  return isLocalHost(h) || isEnvHost(policy, h) || underAny(policy.sourceHosts || [], h)
}

// 发码请求的用途值：请求体（JSON / 表单，各段分别认）与 query 里 scene / type / purpose… 的值，取第一个。
// bodies 为 undefined = 请求体读不到（@文件、FormData、流），认不出。
export const codePurposeOf = ({ bodies, query = '' }) => {
  if (bodies === undefined) return null
  for (const text of [...bodies, query]) {
    const raw = String(text || '').trim()
    let entries = []
    try {
      const value = JSON.parse(raw)
      if (typeof value === 'object') entries = Object.entries(value ?? {})
    } catch {
      entries = [...new URLSearchParams(raw.replace(/^\?/, '')).entries()]
    }
    const hit = entries.find(([key, value]) => PURPOSE_KEY_RE.test(key) && ['string', 'number'].includes(typeof value))
    if (hit) return String(hit[1])
  }
  return null
}
const isLoginPurpose = (policy, value) => LOGIN_PURPOSES.includes(String(value).toLowerCase()) || policy.loginCodeTypes.includes(String(value))

const scopeText = (policy) => `${SCOPE_LABEL[policy.scope]}只许打配置的环境（${policy.domains.length ? `${policy.domains.join('、')} 及其子域` : '本仓没配环境地址'}；本机不限${policy.sourceHosts?.length ? '；另可读包 / 源码源' : ''}）`
export const blockedHostReason = (policy, host) =>
  `${scopeText(policy)}，${normHost(host) || '(无主机)'} 不在范围里：上游 / 合作方 / 第三方地址不打，它们的状态只转述上下文并写明出处和日期；不要换 /usr/bin/curl、python、node 等写法绕过。`
const WRITE_TAIL = '结论里写明卡在这一步、请对接人手动做或给只读的查法；不要换写法重试。'

// 一次请求（方法 + 地址 [+ 请求体]）在不在范围：{ ok, reason }。地址可不带协议（curl 认 host/path）。
// 写请求只放登录（含验证码登录：发登录码 + 用码登录），且只在实测 / 改代码自测里；代答只读。
export const checkEgressRequest = (policy, { method = 'GET', url, bodies = [] }) => {
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
  const where = `${m} ${u.host}${u.pathname}`
  // 改代码 / 自测：环境外的主机只许读（b2 ep-1020-17dd90 node 脚本在 pre 发了 25 帖、传了 33 张图；环境外写同样不做）
  if (!isEnvHost(policy, normHost(u.hostname))) return { ok: false, reason: `这一步要往环境外的 ${u.host} 写数据（${where}），bot 不做：${WRITE_TAIL}` }
  if (policy.scope === 'answer' && !policy.loginTool) return { ok: false, reason: `代答只许 GET / HEAD / OPTIONS，${where} 不发（要登录态用 node tools/env-login.mjs --env <环境>）；${WRITE_TAIL}` }
  if (m !== 'POST') return { ok: false, reason: `这一步要写数据（${where}），bot 不做（只读 + 登录）：${WRITE_TAIL}` }
  if (REGISTER_PATH_RE.test(u.pathname)) return { ok: false, reason: `注册一律不做（${where}）：要账号用配置的测试号登录，没有就在结论里写明找谁要。` }
  if (CODE_SEND_PATH_RE.test(u.pathname)) {
    const purpose = codePurposeOf({ bodies, query: u.search })
    if (purpose != null && isLoginPurpose(policy, purpose)) return { ok: true }
    const types = ['scene=login', ...policy.loginCodeTypes.map((t) => `type=${t}`)].join(' / ')
    return { ok: false, reason: purpose == null
      ? `看不出这次发验证码是登录用还是注册用（${where}）：只许发登录码，请求里写明 ${types}；拿不准就别发，在结论里问对接人。`
      : `发验证码的用途是 ${purpose}，不是登录（${where}）：只许发登录码（${types}），发注册码也算注册，不做。` }
  }
  if (LOGIN_PATH_RE.test(u.pathname)) return { ok: true }
  const testData = (policy.testDataDomains || []).some((domain) => normHost(u.hostname) === domain || normHost(u.hostname).endsWith(`.${domain}`))
  if (testData && !policy.loginTool) {
    const word = createBlockedPath(u.pathname)
    if (!word) return { ok: true }
    return { ok: false, reason: `本单只放开用测试号建测试内容，${where} 像是删 / 改 / 动别人的数据（路径里有 ${word}），不做：${WRITE_TAIL}` }
  }
  return { ok: false, reason: `这一步要写数据（${where}），bot 不做（只读 + 登录${policy.testDataDomains?.length ? `；建测试数据只放开 ${policy.testDataDomains.join('、')}` : ''}）：${WRITE_TAIL}` }
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

// { method, urls, banned, bodies }：banned 是用到的被拦选项（显示用原写法）；bodies 是 -d / --json / -F 的值（发码时认用途），
// 有 @文件 / @- 就是 undefined（读不到）。
export const parseCurlArgs = (argv) => {
  let method = null
  let body = false
  let get = false
  let head = false
  let upload = false
  const urls = []
  const banned = []
  let bodies = []
  const take = (name, value, raw) => {
    if (CURL_BANNED.has(name)) banned.push(raw)
    if (CURL_BODY.has(name)) {
      body = true
      const text = String(value ?? '')
      if (/^@|=@/.test(text) && name !== 'data-raw') bodies = undefined
      else bodies?.push(text)
    }
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
  return { method: resolved, urls: urls.filter((url) => url != null && url !== ''), banned, bodies }
}

// curl 壳的判定：{ ok, reason }。--version / --help 直接放。
export const checkCurlInvocation = (policy, argv) => {
  if (argv.some((a) => /^(?:-V|--version|-h|--help|--manual|-M)$/.test(a))) return { ok: true }
  const { method, urls, banned, bodies } = parseCurlArgs(argv)
  if (banned.length) return { ok: false, reason: `${scopeText(policy)}，curl 的 ${[...new Set(banned)].join(' / ')} 会绕开出网核对，不能用。` }
  for (const url of urls) {
    const check = checkEgressRequest(policy, { method, url, bodies })
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
