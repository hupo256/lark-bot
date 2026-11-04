/**
 * falive pre 的测试号登录模块（回放配置 testAccounts.pre.loginModule 用，tools/env-login.mjs 调；口径见 lib/lark-env-login.mjs）。
 * 只做两步：GET /api/secret/getHot（拿访客态）+ POST /api/user/NewMailLogin。用业务仓 scripts/lib/pre-client.mjs 的签名 / 加密，
 * 但绝不调它的 login()：那个登录失败会自动发注册码再注册（b2 / falive 当时注册出 129172 / 129174 的越界）。
 * 密码：配置给了用配置的；没给用 PROBE_PWD，再没有用 pre-client 源码里 login() 的缺省测试密码（业务仓自带，不在本仓另存）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const repoDefaultPassword = (source) => source.match(/async function login\(\s*mail\s*,\s*pwd\s*=\s*process\.env\.PROBE_PWD\s*\|\|\s*"([^"]+)"/)?.[1] || null

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
  return { token, uid: res?.data?.uid ?? res?.data?.id ?? null, note: token ? '后续 GET 用业务仓 createPreClient() 先 safeCall("/api/secret/getHot") 再 setToken(token)' : `NewMailLogin 返回 ${res?.code} ${String(res?.msg || '').slice(0, 80)}` }
}
