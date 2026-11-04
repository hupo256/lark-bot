#!/usr/bin/env node
/**
 * 用配置的测试号登录环境，拿登录态（只登录：不注册、不发注册码、不改数据）。给 worker 里的 AI 在代答 / 实测 / 自测时用，也可以手动跑。
 *
 * 用法：node tools/env-login.mjs --env pre [--token [名]] [--fresh]
 *   默认：登录（20 分钟内登过就复用），登录态写 runtime/lark-env-login/<环境>.json（0600：token / 具名凭证 / localStorage 槽位 / uid），只打印打码摘要。
 *   --token：只打印 token 原文一行，给命令替换用：TOKEN=$(node tools/env-login.mjs --env pre --token)，token 不进对话。
 *   --token <名>：取同一次登录拿到的具名凭证（摘要里列的，如 hichat_token）：HC=$(node tools/env-login.mjs --env pre --token hichat_token)。
 *   --fresh：不复用，重登一次。
 * 账号与登录方式：runtime/lark-bot.local.json 的 testAccounts.<环境>（口径见 lib/lark-env-login.mjs）。密码永不打印。
 * 出网：代答 / 实测会话里照样过出网核对（tools/egress-guard/preload.mjs 认出本工具后只多放登录 POST；注册路径一律拦）。
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { buildLoginRequest, freshLogin, maskToken, namedTokensOf, pickPath, pickSessionToken, readTestPassword, redactSecrets, resolveTestAccount } from '../lib/lark-env-login.mjs'
import { consumerRoot, larkBotRoot, larkEnvLoginDir, larkLocalConfigPath } from '../lib/lark-paths.mjs'

const args = process.argv.slice(2)
const valueOf = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null }
const tokenOnly = args.includes('--token')
// --token 后面跟的不是选项就是凭证名（不当环境认）
const tokenName = tokenOnly && valueOf('--token') && !valueOf('--token').startsWith('--') ? valueOf('--token') : null
const env = valueOf('--env') || args.find((arg, i) => !arg.startsWith('--') && args[i - 1] !== '--env' && !(args[i - 1] === '--token' && arg === tokenName)) || null
const say = (line) => (tokenOnly ? process.stderr : process.stdout).write(`${line}\n`)
const fail = (line) => { process.stderr.write(`[env-login] ${line}\n`); process.exit(1) }
const expand = (path) => (path.startsWith('~/') ? join(homedir(), path.slice(2)) : isAbsolute(path) ? path : resolve(larkBotRoot, path))

let config = {}
try { config = JSON.parse(readFileSync(larkLocalConfigPath, 'utf8')) } catch { config = {} }
const target = resolveTestAccount(config, env)
if (target.error) fail(target.error)
const { base, account } = target
const outPath = join(larkEnvLoginDir, `${env}.json`)

let saved = null
try { saved = JSON.parse(readFileSync(outPath, 'utf8')) } catch { saved = null }
let session = args.includes('--fresh') ? null : freshLogin(saved, { env, mail: account.mail })

if (!session) {
  const password = readTestPassword(account, { readFile: (path) => readFileSync(expand(path), 'utf8') })
  const secrets = [password]
  try {
    let result
    if (account.loginModule) {
      const mod = await import(pathToFileURL(expand(account.loginModule)).href)
      if (typeof mod.login !== 'function') fail(`${account.loginModule} 没有导出 login()`)
      result = await mod.login({ base, env, mail: account.mail, password, consumerRoot })
    } else {
      const request = buildLoginRequest({ base, request: account.request, mail: account.mail, password })
      const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body, signal: AbortSignal.timeout(15_000) })
      const json = await response.json().catch(() => null)
      result = { token: pickPath(json, account.request.tokenPath || 'data.token'), uid: account.request.uidPath ? pickPath(json, account.request.uidPath) : null, note: json && !pickPath(json, account.request.tokenPath || 'data.token') ? `HTTP ${response.status} ${String(json.msg ?? json.message ?? '').slice(0, 80)}` : null }
    }
    const tokens = namedTokensOf(result)
    secrets.push(result?.token, ...Object.values(tokens))
    if (!result?.token && !Object.keys(result?.slots || {}).length) fail(redactSecrets(`${env} 测试号 ${account.mail} 没登上${result?.note ? `：${result.note}` : ''}。不注册新号、不换别的号；在结论里写明登录失败和返回信息`, secrets))
    session = { env, base, mail: account.mail, uid: result.uid ?? account.uid ?? null, token: result.token || null, tokens, slots: result.slots || {}, note: result.note || null, at: new Date().toISOString() }
    mkdirSync(larkEnvLoginDir, { recursive: true, mode: 0o700 })
    writeFileSync(outPath, JSON.stringify(session, null, 2), { mode: 0o600 })
    chmodSync(outPath, 0o600)
  } catch (error) {
    fail(redactSecrets(`${env} 登录出错：${String(error?.message || error).slice(0, 200)}`, secrets))
  }
}

if (tokenOnly) {
  const picked = pickSessionToken(session, tokenName)
  if (picked.error) fail(picked.error)
  process.stdout.write(`${picked.token}\n`)
} else {
  const named = Object.entries(session.tokens || {})
  say(`已登录 ${env} 测试号 ${session.mail}${session.uid != null ? `（uid ${session.uid}）` : ''}${session === saved ? '（复用 20 分钟内的登录态）' : ''}：token ${session.token ? maskToken(session.token) : '无'}${named.length ? `；另有凭证 ${named.map(([name, value]) => `${name} ${maskToken(value)}`).join('、')}` : ''}${Object.keys(session.slots || {}).length ? `，localStorage 槽位 ${Object.keys(session.slots).join(' / ')}` : ''}。`)
  say(`登录态文件：${outPath}（0600）。要 token：TOKEN=$(node ${join(larkBotRoot, 'tools', 'env-login.mjs')} --env ${env} --token${named.length ? ` [${named.map(([name]) => name).join(' | ')}]` : ''})，别打印出来。`)
  if (session.note) say(session.note)
}
