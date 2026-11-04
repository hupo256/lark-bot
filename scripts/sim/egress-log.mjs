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

const realNow = () => Math.round(performance.timeOrigin + performance.now()) // 不用 Date：gateway / worker 里 Date 是虚拟时钟
export const LOCAL_HOST_RE = /^(?:127(?:\.\d{1,3}){3}|localhost|::1|\[::1\]|0\.0\.0\.0)$/i

// dir：默认 SIM_DIR（壳 / 预载都在 bot 进程里，继承得到）；run-sim 自己的采样器不在那个环境里，显式传 simDir（P0-d 冒烟漏记的就是这个）。
export const noteEgress = ({ via, method = 'GET', url, extra = null, dir = process.env.SIM_DIR }) => {
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

const main = () => {
  const [tool, ...argv] = process.argv.slice(2)
  if (tool === 'lark-cli') {
    noteEgress({ via: 'lark-cli-shim', method: 'CLI', url: 'sim-fake-lark-cli.local/', extra: argv.filter((a) => !a.startsWith('--')).slice(0, 3).join(' ') })
    return
  }
  const { method, urls } = tool === 'wget' ? parseWget(argv) : parseCurl(argv)
  if (!urls.length && argv.some((a) => /^(?:-V|--version|-h|--help)$/.test(a))) return
  if (!urls.length) noteEgress({ via: tool, method, url: '', extra: '没解析出 URL（如 curl -K 配置文件）' })
  for (const url of urls) noteEgress({ via: tool, method, url })
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main()
