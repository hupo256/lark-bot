#!/usr/bin/env node
/**
 * 回放出网审计：记一条出网目标（docs/falive-replay-design-v2.md §8 前置 7）。两种用法：
 *   壳脚本 scripts/sim/egress/{curl,wget,lark-cli} 调：node egress-log.mjs <curl|wget|lark-cli> <原参数…>，从参数里解析方法与 URL
 *   egress-hook.mjs（NODE_OPTIONS 预载）import noteEgress 记 node fetch / http(s).request
 * 落 $SIM_DIR/egress.log，一行一个 JSON：{ at, via, pid, method, host, port, path }。只记方法 + 主机 + 路径：
 * query、请求头、正文都不记（里面可能有 token / 加密参数）。没有 SIM_DIR 就什么都不做。分类口径在 egress-audit.mjs。
 */
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'

import { CODE_SEND_PATH_RE, EGRESS_GUARD_ENV, LOGIN_PATH_RE, REGISTER_PATH_RE, checkEgressRequest, codePurposeOf, parseCurlArgs, parseEgressPolicy } from '../../lib/lark-egress-policy.mjs'

// 发码的登录用途值：scene=login 一类 + falive php 发码 type 3（falive-react VerificationCodeType.SignIn）；egress-audit 共用
export const LOGIN_PURPOSES = new Set(['login', 'signin', 'sign_in', 'sign-in', '3'])

const realNow = () => Math.round(performance.timeOrigin + performance.now()) // 不用 Date：gateway / worker 里 Date 是虚拟时钟
export const LOCAL_HOST_RE = /^(?:127(?:\.\d{1,3}){3}|localhost|::1|\[::1\]|0\.0\.0\.0)$/i

// dir：默认 SIM_DIR（壳 / 预载都在 bot 进程里，继承得到）；run-sim 自己的采样器不在那个环境里，显式传 simDir（P0-d 冒烟漏记的就是这个）。
// purpose：发验证码请求的用途值（scene / type，如 login / 3），只记这一个值、不记请求体，供审计区分登录码与注册码（aven 11-04：验证码登录算登录）。
export const noteEgress = ({ via, method = 'GET', url, extra = null, purpose = null, dir = process.env.SIM_DIR }) => {
  if (!dir) return
  let u = null
  try { u = new URL(/^[a-z][\w+.-]*:\/\//i.test(url) ? url : `http://${url}`) } catch { u = null }
  const line = {
    at: new Date(realNow()).toISOString(),
    via,
    pid: process.pid,
    method: String(method || 'GET').toUpperCase(),
    host: u ? u.hostname.replace(/^\[|\]$/g, '') : null,
    port: u ? Number(u.port || (u.protocol === 'https:' ? 443 : 80)) : null,
    path: u ? u.pathname : null,
    ...(u ? {} : { raw: String(url).slice(0, 200) }),
    ...(extra ? { extra } : {}),
    ...(purpose != null ? { purpose: String(purpose).slice(0, 40) } : {}),
  }
  try { appendFileSync(join(dir, 'egress.log'), `${JSON.stringify(line)}\n`) } catch { /* 记不下也不挡调用 */ }
}

// curl：带值的选项（值不是 URL）；其余非选项参数都当 URL（curl 允许不写协议）。
const CURL_VALUE_OPTS = new Set(['-X', '--request', '-H', '--header', '-d', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--data-ascii', '--json',
  '-F', '--form', '--form-string', '-T', '--upload-file', '-o', '--output', '-u', '--user', '-A', '--user-agent', '-e', '--referer', '-b', '--cookie', '-c', '--cookie-jar',
  '-w', '--write-out', '-m', '--max-time', '--connect-timeout', '--retry', '--retry-delay', '--retry-max-time', '-x', '--proxy', '--resolve', '--connect-to', '-K', '--config',
  '--cacert', '--cert', '--key', '-E', '-r', '--range', '-Y', '--speed-limit', '-y', '--speed-time', '--limit-rate', '--max-redirs', '--url', '--interface', '-z', '--time-cond', '--output-dir', '--trace', '--trace-ascii', '--stderr', '-D', '--dump-header'])
const CURL_BODY_OPTS = new Set(['-d', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--data-ascii', '--json', '-F', '--form', '--form-string'])
export const parseCurl = (argv) => {
  let method = null
  let body = false
  let get = false
  const urls = []
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--') { urls.push(...argv.slice(i + 1)); break }
    const eq = a.startsWith('--') && a.includes('=') ? a.indexOf('=') : -1
    const name = eq > 0 ? a.slice(0, eq) : a
    const val = eq > 0 ? a.slice(eq + 1) : null
    if (CURL_VALUE_OPTS.has(name)) {
      const v = val ?? argv[(i += 1)]
      if (name === '-X' || name === '--request') method = String(v || '').toUpperCase()
      if (CURL_BODY_OPTS.has(name)) body = true
      if (name === '-T' || name === '--upload-file') method ||= 'PUT'
      if (name === '--url') urls.push(v)
      continue
    }
    if (/^-X[A-Z]+$/.test(a)) { method = a.slice(2); continue }
    if (/^-d./.test(a)) { body = true; continue }
    if (a === '-G' || a === '--get') { get = true; continue }
    if (a === '-I' || a === '--head') { method ||= 'HEAD'; continue }
    if (/^-[A-Za-z]{2,}$/.test(a)) { // 合写的短选项（-sI、-sSLG）
      if (a.includes('I')) method ||= 'HEAD'
      if (a.includes('G')) get = true
      continue
    }
    if (a.startsWith('-')) continue
    urls.push(a)
  }
  return { method: method || (get ? 'GET' : body ? 'POST' : 'GET'), urls }
}
const WGET_VALUE_OPTS = new Set(['-O', '--output-document', '-o', '--output-file', '-a', '--append-output', '-P', '--directory-prefix', '-U', '--user-agent', '--header', '-t', '--tries', '-T', '--timeout', '--method', '--body-data', '--body-file', '--post-data', '--post-file', '-e', '--execute', '--user', '--password', '-i', '--input-file'])
export const parseWget = (argv) => {
  let method = null
  const urls = []
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    const eq = a.startsWith('--') && a.includes('=') ? a.indexOf('=') : -1
    const name = eq > 0 ? a.slice(0, eq) : a
    const val = eq > 0 ? a.slice(eq + 1) : null
    if (WGET_VALUE_OPTS.has(name)) {
      const v = val ?? argv[(i += 1)]
      if (name === '--method') method = String(v || '').toUpperCase()
      if (name === '--post-data' || name === '--post-file') method ||= 'POST'
      continue
    }
    if (a.startsWith('-')) continue
    urls.push(a)
  }
  return { method: method || 'GET', urls }
}

// 回放写拦截（11-04 b2 事故：ep-1020 在真实 pre 上发了 25 个帖子、传了 33 张图；ep-1023 传了 10 次头像）：回放里对任何非本机主机的写请求一律拦下，
// 只放行登录（路径含 login）。验证码发送分不清是登录还是注册 → 也拦（回放宁可测不到，不许在真环境留数据）。线上 bot 的口径另由 lib 的出网工具管。
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
// purpose：发验证码的用途值（验证码登录算登录，aven 11-04）；注册路径先拦（lib/lark-egress-policy 同一套路径口径）。
export const blockedWrite = ({ method, url, purpose = null }) => {
  const m = String(method || 'GET').toUpperCase()
  if (READ_METHODS.has(m)) return null
  let u = null
  try { u = new URL(/^[a-z][\w+.-]*:\/\//i.test(url) ? url : `http://${url}`) } catch { return `${m} ${String(url).slice(0, 80)}（解析不了的地址）` }
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (LOCAL_HOST_RE.test(host)) return null
  if (REGISTER_PATH_RE.test(u.pathname)) return `${m} ${host}${u.pathname}（注册）`
  if (CODE_SEND_PATH_RE.test(u.pathname)) return purpose != null && LOGIN_PURPOSES.has(String(purpose).toLowerCase()) ? null : `${m} ${host}${u.pathname}（发码用途${purpose == null ? '不明' : ` ${purpose}`}）`
  if (LOGIN_PATH_RE.test(u.pathname)) return null
  return `${m} ${host}${u.pathname}`
}
export const BLOCK_NOTE = '回放环境禁止往真实环境写数据（只放行只读请求和登录）：这一步没有执行。'
// 本单放开了造测试数据（线上出网核对会放行这次创建，lib/lark-egress-policy testDataDomains），回放照样不写真实环境（11-04 事故）：
// 说清楚是回放拦的、线上会用测试号执行，bot 照实报「回放拦截」，不当成环境报错或权限不足。
export const TESTDATA_BLOCK_NOTE = '回放：真实写入已拦截（线上会用测试号执行）。这一步没有执行，结论里照实写「回放拦截、未创建」，不编 id。'
export const simBlockNote = ({ method, url, env = process.env }) => {
  const policy = env[EGRESS_GUARD_ENV] ? parseEgressPolicy(env[EGRESS_GUARD_ENV]) : null
  return policy?.testDataDomains?.length && checkEgressRequest(policy, { method, url }).ok ? TESTDATA_BLOCK_NOTE : BLOCK_NOTE
}

const main = () => {
  const [tool, ...argv] = process.argv.slice(2)
  if (tool === 'lark-cli') {
    noteEgress({ via: 'lark-cli-shim', method: 'CLI', url: 'sim-fake-lark-cli.local/', extra: argv.filter((a) => !a.startsWith('--')).slice(0, 3).join(' ') })
    return
  }
  const { method, urls } = tool === 'wget' ? parseWget(argv) : parseCurl(argv)
  if (!urls.length && argv.some((a) => /^(?:-V|--version|-h|--help)$/.test(a))) return
  if (!urls.length) noteEgress({ via: tool, method, url: '', extra: '没解析出 URL（如 curl -K 配置文件）' })
  const bodies = tool === 'curl' ? parseCurlArgs(argv).bodies : undefined
  let blocked = null
  for (const url of urls) {
    let query = ''
    try { query = new URL(/^[a-z][\w+.-]*:\/\//i.test(url) ? url : `http://${url}`).search } catch { query = '' }
    const purpose = method !== 'GET' && CODE_SEND_PATH_RE.test(url) ? codePurposeOf({ bodies, query }) : null
    const why = process.env.SIM_DIR ? blockedWrite({ method, url, purpose }) : null
    noteEgress({ via: tool, method, url, purpose, ...(why ? { extra: 'blocked' } : {}) })
    blocked ||= why
  }
  if (blocked) { process.stderr.write(`[sim] ${simBlockNote({ method, url: urls.find((url) => blockedWrite({ method, url })) || urls[0] })}（${blocked}）\n`); process.exitCode = 3 }
}
// 判是不是被直接执行：argv[1] 不一定是存在的文件（预载进每个 node 子进程，`node -e '…' 参数` 的 argv[1] 就是那个参数），realpath 失败按「不是」算——绝不能让预载把 bot 的子进程弄崩
const isMain = (() => { try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false } })()
if (isMain) main()

// claude 走的 API 网关（ANTHROPIC_BASE_URL，11-04 aven 切 apikey 线路后是 www.uniaix.com）：等同 Claude 接口放行；
// 采样器解析它的 IP，出网审计把这些 IP 的连接归 Claude 接口（否则 IP 级连接未归类、守卫当成打到真实环境停轮）。
export const claudeGatewayHost = (env = process.env) => {
  try { return env.ANTHROPIC_BASE_URL ? new URL(env.ANTHROPIC_BASE_URL).hostname.toLowerCase() : null } catch { return null }
}
