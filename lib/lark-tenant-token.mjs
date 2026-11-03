/**
 * 应用令牌（tenant_access_token）跨进程缓存（aven 11-03「第一次撞 429 限流，给个好的解决方案」）。
 *
 * 根因：lark-cli 1.0.98 的 bot 令牌只缓存在进程内存里（上游 larksuite/cli#2863，未修）。lark-bot 每次调用都是一个新子进程，
 * 所以每次调用都先打一次令牌接口；令牌接口额度很小且整个应用共享（gateway / worker / poller / falive 都是同一个应用），
 * 连打十几次就 429「TAT endpoint rate limited」。关 DPoP 没用（隔离目录实测照样 429）。
 *
 * 做法：lark-bot 自己用 app_id + app_secret 铸一次令牌，落 0600 的 runtime/lark-tenant-token.local.json 给三个进程共用，
 * 剩余不足 REFRESH_AHEAD_MS 就续（铸的时候加目录锁，防三个进程同时铸）；runLarkCli 对 bot 身份的调用注入
 * LARKSUITE_CLI_APP_ID + LARKSUITE_CLI_TENANT_ACCESS_TOKEN，lark-cli 就直接用、不再铸（实测喂假令牌返回 99991663、DPoP 密钥文件不动）。
 * 这两个变量一设 lark-cli 就进「strict mode bot」，同进程的 --as user 会被拒，所以只能按子进程注入、只注 bot 身份、
 * 带 LARKSUITE_CLI_CONFIG_DIR（邮件转发拆出去的另一个应用）的不注。
 *
 * secret 来源：0600 的 ~/.config/fameex-lark/lark-app-secret（lark-paths.larkAppSecretPath），由本模块直接读，**不放进进程环境**——
 * worker 起 claude 时整份 process.env 都继承下去，而 AI 处理的是群里不可信的消息。app_id 取运行配置 botAppId（env LARK_APP_ID 可覆盖）。
 * 没 secret 整条链路保持原样（lark-cli 自己铸），功能不开；没开时每 SETTINGS_RECHECK_MS 重查一次文件，放好文件不用重启。
 * 铸失败（网络 / 令牌接口本身 429）也回落原样，MINT_FAIL_BACKOFF_MS 内不再试，免得每次调用都去撞。
 */

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { larkAppSecretPath, larkTenantTokenCachePath, readLocalPathConfig } from './lark-paths.mjs'

export const TENANT_TOKEN_HOSTS = { lark: 'https://open.larksuite.com', feishu: 'https://open.feishu.cn' }
export const TENANT_TOKEN_PATH = '/open-apis/auth/v3/tenant_access_token/internal'
// 剩余不足 10 分钟就续：飞书剩余 < 30 分钟时才发新令牌，提前太多只会拿回同一个。
export const TENANT_TOKEN_REFRESH_AHEAD_MS = 10 * 60_000
export const TENANT_TOKEN_DEFAULT_TTL_SEC = 7200
export const TENANT_TOKEN_LOCK_STALE_MS = 30_000
export const MINT_FAIL_BACKOFF_MS = 30_000
// 99991663：tenant access token 无效；99991661：没带 / 已失效的 access token。
export const TOKEN_INVALID_CODES = new Set([99991661, 99991663])
export const SETTINGS_RECHECK_MS = 60_000
export { larkTenantTokenCachePath }

const nonEmpty = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '')
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// secret 文件：去首尾空白；读不到 / 空 → ''。
export const readAppSecretFile = (path = larkAppSecretPath) => {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    return ''
  }
}

// env LARK_APP_SECRET（只给手动调试用，线上不设）> secret 文件；app_id：env > 运行配置。缺 secret 或 app_id 返回 null（= 功能不开）。
export const resolveTenantTokenSettings = ({ env = process.env, localConfig = readLocalPathConfig(), readSecret = readAppSecretFile } = {}) => {
  const appSecret = nonEmpty(env.LARK_APP_SECRET) || nonEmpty(readSecret())
  const appId = nonEmpty(env.LARK_APP_ID) || nonEmpty(localConfig?.botAppId)
  if (!appSecret || !appId) return null
  const host = nonEmpty(env.LARK_OPEN_API_HOST) || TENANT_TOKEN_HOSTS[nonEmpty(env.LARK_BRAND) || 'lark'] || TENANT_TOKEN_HOSTS.lark
  return { appId, appSecret, host: host.replace(/\/+$/, '') }
}

// 直连令牌接口铸一枚。返回 { appId, token, mintedAt, expiresAt }；失败抛错（调用方回落 lark-cli 自己铸）。
export const mintTenantToken = async ({ appId, appSecret, host, fetchImpl = fetch, now = Date.now }) => {
  const response = await fetchImpl(`${host}${TENANT_TOKEN_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  })
  const payload = await response.json().catch(() => null)
  const token = payload?.tenant_access_token
  if (!response.ok || payload?.code !== 0 || typeof token !== 'string' || !token) {
    throw new Error(`铸应用令牌失败：HTTP ${response.status} code=${payload?.code ?? '?'}${payload?.msg ? ` ${payload.msg}` : ''}`)
  }
  const expire = Number(payload.expire)
  const ttlSec = Number.isFinite(expire) && expire > 0 ? expire : TENANT_TOKEN_DEFAULT_TTL_SEC
  const mintedAt = now()
  return { appId, token, mintedAt, expiresAt: mintedAt + ttlSec * 1000 }
}

// 缓存条目还能用：同一个 app、有令牌、离到期还有 ahead 以上。
export const isTokenFresh = (entry, { appId, now = Date.now(), ahead = TENANT_TOKEN_REFRESH_AHEAD_MS }) =>
  Boolean(entry && typeof entry === 'object' && entry.appId === appId && typeof entry.token === 'string' && entry.token && Number.isFinite(entry.expiresAt) && entry.expiresAt - now > ahead)

export const readTokenCache = (path = larkTenantTokenCachePath) => {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

// 0600 + 先写临时文件再 rename：别的进程永远读不到半截。
export const writeTokenCache = (entry, path = larkTenantTokenCachePath) => {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 })
  renameSync(tmp, path)
}

// 只在缓存里还是这枚令牌时才删：别的进程可能刚续了新的，不能顺手删掉。
export const invalidateTenantToken = ({ token, path = larkTenantTokenCachePath }) => {
  const cached = readTokenCache(path)
  if (!cached || cached.token !== token) return false
  rmSync(path, { force: true })
  return true
}

// lark-cli 的失败结果是不是「令牌无效」（该作废缓存、换新令牌重试一次，而不是走 1.5s 退避）。
export const isTokenInvalidResult = (result) => {
  try {
    const code = JSON.parse(result?.stdout || '')?.error?.code
    return TOKEN_INVALID_CODES.has(Number(code))
  } catch {
    return false
  }
}

// 给 lark-cli 子进程的两个变量。
export const tenantTokenEnv = ({ appId, token }) => ({ LARKSUITE_CLI_APP_ID: appId, LARKSUITE_CLI_TENANT_ACCESS_TOKEN: token })

// 目录锁：mkdir 原子；拿不到就等；锁目录超过 staleMs 没动静（持锁进程死了）就清掉重来。
export const withTokenLock = async (path, fn, { wait = defaultSleep, now = Date.now, staleMs = TENANT_TOKEN_LOCK_STALE_MS, attempts = 40, intervalMs = 250 } = {}) => {
  const lockDir = `${path}.lock`
  mkdirSync(dirname(path), { recursive: true })
  for (let attempt = 1; ; attempt += 1) {
    try {
      mkdirSync(lockDir)
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      let mtimeMs
      try {
        mtimeMs = statSync(lockDir).mtimeMs
      } catch {
        continue // 刚被持锁方删掉，马上再抢
      }
      if (now() - mtimeMs > staleMs) {
        rmSync(lockDir, { recursive: true, force: true })
        continue
      }
      if (attempt >= attempts) throw new Error(`等应用令牌锁超时（${lockDir}）`)
      await wait(intervalMs)
    }
  }
  try {
    return await fn()
  } finally {
    rmSync(lockDir, { recursive: true, force: true })
  }
}

// 取一枚可用令牌：缓存新鲜直接用；否则加锁、再读一次（别的进程可能刚续）、铸、落盘。
// 铸失败返回 null 并在 backoffMs 内不再试（state 记在调用方传入的对象里，缺省模块级）。
const defaultState = { mintFailedUntil: 0 }
export const getTenantToken = async ({
  settings,
  cachePath = larkTenantTokenCachePath,
  now = Date.now,
  fetchImpl,
  wait,
  log = console,
  state = defaultState,
  backoffMs = MINT_FAIL_BACKOFF_MS,
} = {}) => {
  if (!settings) return null
  const { appId } = settings
  const cached = readTokenCache(cachePath)
  if (isTokenFresh(cached, { appId, now: now() })) return cached.token
  if (now() < state.mintFailedUntil) return null
  try {
    return await withTokenLock(cachePath, async () => {
      const again = readTokenCache(cachePath)
      if (isTokenFresh(again, { appId, now: now() })) return again.token
      const entry = await mintTenantToken({ ...settings, fetchImpl, now })
      writeTokenCache(entry, cachePath)
      log.log(`[lark-cli] 应用令牌已续，${Math.round((entry.expiresAt - now()) / 60_000)} 分钟后到期`)
      return entry.token
    }, { wait, now })
  } catch (error) {
    state.mintFailedUntil = now() + backoffMs
    log.error(`[lark-cli] 铸应用令牌失败，${Math.round(backoffMs / 1000)} 秒内回落 lark-cli 自己铸：${error?.message || error}`)
    return null
  }
}

// runLarkCli 用的提供者。settings 显式传了（含 null）就固定用它；没传就按需解析：解析出来了就一直用，
// 没解析出来（还没放 secret 文件）每 recheckMs 重查一次，放好文件不用重启进程。
export const createTenantTokenProvider = ({ settings, resolve = resolveTenantTokenSettings, recheckMs = SETTINGS_RECHECK_MS, cachePath, now = Date.now, fetchImpl, wait, log, state = { mintFailedUntil: 0 } } = {}) => {
  const fixed = settings !== undefined
  let resolved = settings ?? null
  let checkedAt = -Infinity
  const settingsOf = () => {
    if (fixed || resolved) return resolved
    if (now() - checkedAt < recheckMs) return null
    checkedAt = now()
    resolved = resolve()
    return resolved
  }
  return {
    enabled: () => Boolean(settingsOf()),
    // 返回 { appId, token, env } 或 null（功能没开 / 铸失败 → 原样跑）。
    acquire: async () => {
      const current = settingsOf()
      if (!current) return null
      const token = await getTenantToken({ settings: current, cachePath, now, fetchImpl, wait, log, state })
      return token ? { appId: current.appId, token, env: tenantTokenEnv({ appId: current.appId, token }) } : null
    },
    invalidate: (token) => invalidateTenantToken({ token, path: cachePath }),
  }
}
