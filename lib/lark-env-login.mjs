/**
 * 测试号登录（tools/env-login.mjs）与造测试数据开关的配置口径。纯函数，不发请求、不读盘（读密码文件由调用方注入）。
 *
 * 为什么有它（b3 回放 ep-1024-9ebe13，aven 11-04）：代答 / 实测要登录态时，会话自己写脚本 import 业务仓的 pre-client、
 * 再 `process.env.PROBE_ALLOW_WRITE = "1"` 去发登录 POST，被 Claude Code 自动审批判成「Safety Bypass」拦下，几条复测都没测成；
 * pre-client 的 login() 登录失败还会自动注册（越界）。改成一个只登录的固定工具：账号从配置读，密码不打印，token 存盘打码。
 *
 * 配置（runtime/lark-bot.local.json 顶层；不放 verify 下：verify 配了就等于开页面工具）：
 *   testAccounts: { <环境>: { mail, uid?, passwordFile? | passwordEnv?, apiBase?, loginModule? | request? } }
 *     loginModule：导出 async login({ base, env, mail, password, consumerRoot }) → { token, slots?, uid?, note? }，只许登录、不许注册；
 *       password 没配时传 null，模块可用业务仓自己的测试密码缺省（如 falive pre-client）。
 *     request：{ path, method = 'POST', body: { 字段: '{mail}' | '{password}' | 常量 }, form = false, tokenPath = 'data.token', uidPath? }
 *   testData: { envs: ['pre'], account? }：对方原话明确要造测试数据时，这些环境放开用测试号建测试内容（lib/lark-egress-policy）；
 *     account = testAccounts 的键，缺省同环境名。不配 = 一律不造。
 */

export const ENV_LOGIN_FRESH_MS = 20 * 60_000

const isObject = (value) => value != null && typeof value === 'object' && !Array.isArray(value)
const nonEmpty = (value) => typeof value === 'string' && value.trim() !== ''

export const validateTestAccess = (config = {}) => {
  const errors = []
  const accounts = config.testAccounts
  if (accounts != null && !isObject(accounts)) errors.push('testAccounts 必须是对象 { <环境>: { mail, passwordFile | passwordEnv, loginModule | request } }')
  for (const [env, account] of Object.entries(isObject(accounts) ? accounts : {})) {
    const at = `testAccounts.${env}`
    if (!isObject(account)) { errors.push(`${at} 必须是对象`); continue }
    if (!nonEmpty(account.mail)) errors.push(`${at}.mail 必填（测试号登录名）`)
    if (!nonEmpty(account.loginModule) && !isObject(account.request)) errors.push(`${at} 要配 loginModule（登录模块路径）或 request（登录请求）`)
    if (isObject(account.request) && !nonEmpty(account.request.path)) errors.push(`${at}.request.path 必填`)
    if (isObject(account.request) && !nonEmpty(account.passwordFile) && !nonEmpty(account.passwordEnv)) errors.push(`${at} 用 request 登录要配 passwordFile 或 passwordEnv`)
    for (const key of ['passwordFile', 'passwordEnv', 'apiBase']) if (account[key] != null && !nonEmpty(account[key])) errors.push(`${at}.${key} 必须是非空字符串`)
  }
  const testData = config.testData
  if (testData != null) {
    if (!isObject(testData) || !Array.isArray(testData.envs) || !testData.envs.every(nonEmpty)) errors.push('testData 必须是对象 { envs: ["pre"], account? }')
    else {
      for (const env of testData.envs) {
        if (!config.envSites?.[env]) errors.push(`testData.envs 的 ${env} 不在 envSites 里`)
        if (!config.testAccounts?.[testData.account || env]) errors.push(`testData 要用的测试号 testAccounts.${testData.account || env} 没配`)
      }
    }
  }
  return errors
}

// { env, base, account } 或 { error }：base = account.apiBase || envSites[env]。
export const resolveTestAccount = (config = {}, env) => {
  const configured = Object.keys(config.testAccounts || {})
  if (!nonEmpty(env)) return { error: `要指定环境：--env <${configured.join(' / ') || '环境'}>` }
  const account = config.testAccounts?.[env]
  if (!isObject(account)) return { error: `${env} 没有配测试号（runtime/lark-bot.local.json 的 testAccounts.${env}；已配：${configured.join(' / ') || '无'}）：登录不了就在结论里写明缺测试号、找谁要，不注册新号` }
  const base = String(account.apiBase || config.envSites?.[env] || '').replace(/\/+$/, '')
  if (!base) return { error: `${env} 没有站点地址（envSites.${env}）` }
  return { env, base, account }
}

// 密码：passwordEnv（进程环境变量名）> passwordFile（读第一行）> null（交给登录模块的缺省）。readFile 由调用方注入。
export const readTestPassword = (account, { env = process.env, readFile } = {}) => {
  if (nonEmpty(account?.passwordEnv) && nonEmpty(env[account.passwordEnv])) return env[account.passwordEnv]
  if (nonEmpty(account?.passwordFile) && readFile) {
    const text = String(readFile(account.passwordFile) || '').split('\n')[0].trim()
    if (text) return text
  }
  return null
}

export const pickPath = (value, path) => String(path || '').split('.').filter(Boolean).reduce((node, key) => (node == null ? undefined : node[key]), value)

// request 登录的请求体：'{mail}' / '{password}' 换成真值（只认整值，不做字符串内插）。
export const buildLoginRequest = ({ base, request, mail, password }) => {
  const fill = (value) => (value === '{mail}' ? mail : value === '{password}' ? password : value)
  const body = Object.fromEntries(Object.entries(request.body || { mail: '{mail}', password: '{password}' }).map(([key, value]) => [key, fill(value)]))
  const form = request.form === true
  return {
    url: `${base}${request.path.startsWith('/') ? '' : '/'}${request.path}`,
    method: String(request.method || 'POST').toUpperCase(),
    headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json', ...(request.headers || {}) },
    body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
  }
}

export const maskToken = (token) => {
  const text = String(token || '')
  return text.length <= 8 ? '****' : `${text.slice(0, 4)}…${text.slice(-2)}（${text.length} 位）`
}
// 报错 / 输出里出现的 token、密码一律换掉（模块抛的错可能带原文）。
export const redactSecrets = (text, secrets = []) => secrets.filter((s) => nonEmpty(s) && s.length >= 4).reduce((out, s) => out.split(s).join('****'), String(text ?? ''))

// 存盘的登录态还新鲜（同环境、同账号、ENV_LOGIN_FRESH_MS 内）就复用，免得每个命令都重登一次。
export const freshLogin = (saved, { env, mail, now = Date.now() }) => (
  saved?.env === env && saved?.mail === mail && saved?.token && now - Date.parse(saved.at || '') < ENV_LOGIN_FRESH_MS ? saved : null
)
