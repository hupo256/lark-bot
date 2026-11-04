/**
 * falive pre 的测试号登录模块（回放配置 testAccounts.pre.loginModule 用，tools/env-login.mjs 调；口径见 lib/lark-env-login.mjs）。
 * 只做两步：GET /api/secret/getHot（拿访客态）+ POST /api/user/NewMailLogin。用业务仓 scripts/lib/pre-client.mjs 的签名 / 加密，
 * 但绝不调它的 login()：那个登录失败会自动发注册码再注册（b2 / falive 当时注册出 129172 / 129174 的越界）。
 * 密码：配置给了用配置的；没给用 PROBE_PWD，再没有用 pre-client 源码里 login() 的缺省测试密码（业务仓自带，不在本仓另存）。
 * 另登一次 portal（新登录服务 {站点}/go-api/api/auth/login，同一测试号同一密码，B2B 签名同前端）：嗨聊要的 hichat_token 只有它签发
 *（b4 ep-1014-d74f19「重跑一次」：只做了 live 登录，hichat_token 那条没测成；b3 会话自己写脚本登 portal 测成了）。
 * 拿到的进 tokens（hichat_token / portal_token / live_token），portal 登不上只记 note，不影响 live 登录结果。
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const repoDefaultPassword = (source) => source.match(/async function login\(\s*mail\s*,\s*pwd\s*=\s*process\.env\.PROBE_PWD\s*\|\|\s*"([^"]+)"/)?.[1] || null

// 签名常量从业务仓读（src/lib/x9/config.ts 的 SIGN_KEY / CLIENT_VERSION、pre-client 的渠道 CH），不在本仓另存。
const constOf = (source, name) => source.match(new RegExp(`const ${name} = "([^"]+)"`))?.[1] || null
const pathRev = (path) => path.split('/').filter(Boolean).map((seg) => seg.slice(-1)).reverse().join('')
export const portalSignHeaders = ({ path, body, signKey, version, channel, oaid, time }) => {
  const text = `${Object.keys(body).sort().map((key) => `${key}=${body[key]}`).join('&')}&key=${signKey}/${pathRev(path)}/${time}//${oaid}/${version}`
  return { 'Content-Type': 'application/json', 'X-Site-Platform': channel, 'b2b-version': version, 'b2b-channel': channel, 'b2b-time': time, 'b2b-oaid': oaid, 'b2b-sign': createHash('md5').update(text).digest('hex') }
}

// portal 登录（只登录：失败不注册）→ { tokens, note }
export const portalLogin = async ({ base, mail, pwd, consumerRoot, fetchImpl = fetch }) => {
  let config = ''
  let client = ''
  try {
    config = readFileSync(join(consumerRoot, 'src', 'lib', 'x9', 'config.ts'), 'utf8')
    client = readFileSync(join(consumerRoot, 'scripts', 'lib', 'pre-client.mjs'), 'utf8')
  } catch {
    return { tokens: {}, note: 'portal 没登：业务仓里找不到签名常量（src/lib/x9/config.ts）' }
  }
  const signKey = constOf(config, 'SIGN_KEY')
  const version = constOf(config, 'CLIENT_VERSION')
  const channel = constOf(client, 'CH')
  if (!signKey || !version || !channel) return { tokens: {}, note: 'portal 没登：业务仓签名常量认不出' }
  const path = '/api/auth/login'
  const body = { username: mail, password: pwd, platform_code: 'LIVE_WEB', device_type: 'pc' }
  const headers = portalSignHeaders({ path, body, signKey, version, channel, oaid: `lark-env-login-${Date.now()}`, time: String(Math.floor(Date.now() / 1000)) })
  try {
    const res = await fetchImpl(`${base}/go-api${path}`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) })
    const json = await res.json().catch(() => null)
    const data = json?.data && typeof json.data === 'object' ? json.data : {}
    const tokens = Object.fromEntries([['hichat_token', data.hichat_token], ['portal_token', data.token], ['live_token', data.live_token]].filter(([, value]) => typeof value === 'string' && value))
    if (tokens.hichat_token || tokens.portal_token) return { tokens, note: null }
    return { tokens: {}, note: `portal 登录没拿到凭证：HTTP ${res.status} code ${json?.code} ${String(json?.msg ?? json?.message ?? '').slice(0, 60)}` }
  } catch (error) {
    return { tokens: {}, note: `portal 登录出错：${String(error?.cause?.code || error?.message || error).slice(0, 80)}` }
  }
}

export const login = async ({ base, mail, password, consumerRoot }) => {
  const clientPath = join(consumerRoot, 'scripts', 'lib', 'pre-client.mjs')
  const pwd = password || process.env.PROBE_PWD || repoDefaultPassword(readFileSync(clientPath, 'utf8'))
  if (!pwd) return { token: null, note: 'pre-client 里找不到缺省测试密码，testAccounts.pre 要配 passwordFile' }
  process.env.PROBE_HOST = base // pre-client 在模块加载时读 HOST
  const { createPreClient, enc } = await import(pathToFileURL(clientPath).href)
  const client = createPreClient()
  await client.safeCall('/api/secret/getHot')
  const prev = process.env.PROBE_ALLOW_WRITE
  process.env.PROBE_ALLOW_WRITE = '1' // pre-client 的写开关，只包这一个登录调用
  let res
  try {
    // 冷启动第一次偶发 -5（Malformed UTF-8，11-04 实测 1/5）：重拿一次访客态再登一次，仍只是登录
    for (let i = 0; i < 2 && !res?.data?.token; i += 1) {
      if (i) await client.safeCall('/api/secret/getHot')
      res = await client.safeCall('/api/user/NewMailLogin', { mail: enc(mail), password: enc(pwd), device_type: 'web' }, 'POST')
    }
  } finally {
    if (prev === undefined) delete process.env.PROBE_ALLOW_WRITE
    else process.env.PROBE_ALLOW_WRITE = prev
  }
  const token = res?.data?.token || null
  const portal = await portalLogin({ base, mail, pwd, consumerRoot })
  const notes = [token ? '后续 php GET 用业务仓 createPreClient() 先 safeCall("/api/secret/getHot") 再 setToken(token)' : `NewMailLogin 返回 ${res?.code} ${String(res?.msg || '').slice(0, 80)}`,
    portal.tokens.hichat_token ? '嗨聊（/hc-api/…）带 hichat_token、portal（/go-api/…）带 portal_token，鉴权头与其它请求头照业务仓 src/lib/api-fetch.ts 的写法' : portal.note].filter(Boolean)
  return { token: token || portal.tokens.live_token || null, tokens: portal.tokens, uid: res?.data?.uid ?? res?.data?.id ?? null, note: notes.join('\n') }
}
