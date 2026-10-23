#!/usr/bin/env node
/**
 * 页面验证工具：bot 改完页面后自己验证用（aven 2026-10-23「确保准确的基础上提速」）。
 *
 * 原来每个任务现写 Playwright 脚本（等加载 / 截图 / 找元素，写错再改，10-22 清扫改了 3 轮约 2 分钟），
 * 改完代码才冷启动本地服务（约 1 分钟）；查什么全看当时想没想到。这里固定成一条命令：
 *   start  在工作区后台起 `pnpm dev:pre`（连真实 pre 后端），立刻返回并预热首页——判断要看页面时先起，和改代码并行
 *   check  等服务就绪 → 逐页打开 → 固定检查下面几类问题 → 截图 → 最后一行给结论
 *   stop   停掉这个工作区的服务（任务结束前调）
 *   status 列出在跑的服务
 * 固定检查：回落 mock（浏览器 console + SSR 日志两边，出现即是假数据）、页面脚本报错、失败请求（网络失败 / HTTP ≥400 /
 * 业务码为负或 ±700 登录失效）、--expect 的文字是否出现、--wait 的元素是否出来。
 * 不往工作区写任何文件（状态 / 日志 / 截图都在 /tmp/lark-verify），不触发提交前的工作树指纹漂移。
 *
 * 用法：
 *   node verify-page.mjs start  --cwd <工作区>
 *   node verify-page.mjs check  --cwd <工作区> [--login] [--expect 文字]... [--wait CSS] [--viewport 1440x900] [--no-compare] <路径>...
 *     （默认同时打开已部署的 pre 同一页比对，问题标「本地新出现 / pre 上也有」；坏图另按同一路径直接请求 pre 判是不是数据问题）
 *   node verify-page.mjs check  --base https://falivepre.fdsser.com [--login] ... <路径>...   （已部署的直接查 pre 站点）
 *   node verify-page.mjs stop   --cwd <工作区>
 *   node verify-page.mjs status
 * 登录用 pre 测试号（VERIFY_MAIL / VERIFY_PWD 可覆盖），portal 登录拿 token 后写进 localStorage，与前端登录成功写的槽位一致。
 * 退出码：0 通过；1 有问题；2 工具本身出错（服务起不来、登录失败等）。
 */

import { spawn, spawnSync } from 'node:child_process'
import { createDecipheriv, createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'

const STATE_ROOT = process.env.VERIFY_STATE_DIR || '/tmp/lark-verify'
const TOOL_HOME = process.env.LARK_VERIFY_HOME || join(homedir(), '.lark-verify') // playwright-core 装在这里，装一次长期用
const MAX_AGE_MS = 3 * 3600_000 // 超过 3 小时的服务视为残留，下次 start 时回收
const READY_TIMEOUT_MS = 180_000
const FIRST_PAGE_TIMEOUT_MS = 180_000 // 新起的服务第一次打开页面要现编译
const PAGE_TIMEOUT_MS = 60_000
const IDLE_TIMEOUT_MS = 20_000
const PORTAL = process.env.VERIFY_PORTAL || 'http://falivego.fdsser.com'
const COMPARE_BASE = process.env.VERIFY_COMPARE_BASE || 'https://falivepre.fdsser.com'
const MAIL = process.env.VERIFY_MAIL || 'aven-pretest@probe.test'
const PWD = process.env.VERIFY_PWD || 'Probe12345'
// portal 响应 data 为空时在 sec 里：AES-ECB-Pkcs7，key 同 falive src/lib/x9/config DECRYPT_KEY；zlib 压缩先 inflate。
const DECRYPT_KEY = 'ckG8PDZedJWBOvi5'
// 登录态槽位，与 falive src/lib/x9/identity.ts、src/modules/auth/data/session.ts applyLoginSession（portal 链路）一致。
const SLOT = { visitor: 'falive__visitor', token: 'falive__token', uid: 'falive__uid', portalToken: 'falive__portal_token', portalExpiresAt: 'falive__portal_expires_at', hichatToken: 'falive__hiapp_jwt' }
// 算作「我方接口」的主机：本地服务同源 + pre 各后端。其余（字体、统计等第三方）失败只列出、不算问题。
const APP_HOSTS = /fdsser\.com|hai-liao|falive/i

/* ------------------------------ 参数 ------------------------------ */

export const parseArgs = (argv) => {
  const out = { cmd: argv[0], paths: [], expect: [], login: false }
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => argv[++i]
    if (arg === '--cwd') out.cwd = resolve(next())
    else if (arg === '--base') out.base = String(next()).replace(/\/+$/, '')
    else if (arg === '--login') out.login = true
    else if (arg === '--expect') out.expect.push(next())
    else if (arg === '--wait') out.wait = next()
    else if (arg === '--viewport') out.viewport = next()
    else if (arg === '--port') out.port = Number(next())
    else if (arg === '--no-compare') out.noCompare = true
    else if (arg.startsWith('--')) throw new Error(`不认识的参数 ${arg}`)
    else out.paths.push(arg.startsWith('/') ? arg : `/${arg}`)
  }
  return out
}

/* ---------------------------- 本地服务 ---------------------------- */

const keyOf = (cwd) => createHash('sha1').update(cwd).digest('hex').slice(0, 10)
const dirOf = (cwd) => join(STATE_ROOT, keyOf(cwd))
const readState = (dir) => {
  try {
    return JSON.parse(readFileSync(join(dir, 'server.json'), 'utf8'))
  } catch {
    return null
  }
}
const pidAlive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

const portFree = (port) =>
  new Promise((done) => {
    const server = createServer()
    server.once('error', () => done(false))
    server.listen(port, '0.0.0.0', () => server.close(() => done(true)))
  })
const pickPort = async (cwd) => {
  // 按工作区固定一个起点，三个任务并发时不挤同一个端口；被占就往后找。
  const start = 3300 + (parseInt(keyOf(cwd).slice(0, 4), 16) % 400)
  for (let port = start; port < start + 200; port += 1) if (await portFree(port)) return port
  throw new Error('3300 起 600 个端口都被占了')
}

// vite 的 /@vite/client 不走 SSR，服务一起来就能返回：用它判「就绪」，页面编译留给第一次打开。
const serverUp = async (port) => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/@vite/client`, { signal: AbortSignal.timeout(3000) })
    return res.ok
  } catch {
    return false
  }
}

const tail = (file, lines = 30) => {
  try {
    return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n')
  } catch {
    return '（没有日志）'
  }
}

const stopServer = async (dir, { reason = '' } = {}) => {
  const state = readState(dir)
  if (!state) return false
  if (pidAlive(state.pid)) {
    try {
      process.kill(-state.pid, 'SIGTERM') // detached 起的进程组：pnpm → vite 一起停
    } catch { /* 已退出 */ }
    for (let i = 0; i < 25 && pidAlive(state.pid); i += 1) await sleep(200)
    if (pidAlive(state.pid)) {
      try {
        process.kill(-state.pid, 'SIGKILL')
      } catch { /* 已退出 */ }
    }
  }
  try {
    unlinkSync(join(dir, 'server.json'))
  } catch { /* 已删 */ }
  if (reason) console.log(`已停掉 ${state.cwd} 的本地服务（端口 ${state.port}，${reason}）`)
  return true
}

const reapStale = async () => {
  if (!existsSync(STATE_ROOT)) return
  for (const name of readdirSync(STATE_ROOT)) {
    const dir = join(STATE_ROOT, name)
    const state = readState(dir)
    if (!state) continue
    if (!pidAlive(state.pid)) {
      try {
        unlinkSync(join(dir, 'server.json'))
      } catch { /* 已删 */ }
      continue
    }
    // 工作区删了、或删到一半（git 记录没了，服务还在往里写缓存）都算已删：边跑边删会删不干净，要先停服务。
    if (!existsSync(join(state.cwd, '.git')) || !existsSync(join(state.cwd, 'package.json'))) await stopServer(dir, { reason: '工作区已删' })
    else if (Date.now() - Date.parse(state.startedAt) > MAX_AGE_MS) await stopServer(dir, { reason: '超过 3 小时，视为残留' })
  }
}

// 起服务（已在跑就复用）。返回 { port, log, fresh }；wait=false 时不等就绪。
const ensureServer = async ({ cwd, wait, fixedPort = null }) => {
  if (!existsSync(join(cwd, 'package.json'))) throw new Error(`${cwd} 不是前端工作区（没有 package.json）`)
  await reapStale()
  const dir = dirOf(cwd)
  mkdirSync(dir, { recursive: true })
  const log = join(dir, 'dev.log')
  const state = readState(dir)
  if (state && pidAlive(state.pid)) {
    if (!wait) return { port: state.port, log, fresh: false }
    await waitReady({ state, log })
    return { port: state.port, log, fresh: !state.warmed }
  }
  if (!existsSync(join(cwd, 'node_modules'))) {
    console.log('工作区还没装依赖，先装（pnpm install --frozen-lockfile --prefer-offline）…')
    const installed = spawnSync('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], { cwd, encoding: 'utf8', timeout: 300_000 })
    if (installed.status !== 0) throw new Error(`装依赖失败：${(installed.stderr || installed.stdout || '').trim().slice(-600)}`)
  }
  const port = fixedPort || (await pickPort(cwd))
  writeFileSync(log, `--- ${new Date().toISOString()} pnpm dev:pre --port ${port}（${cwd}）\n`)
  const fd = openSync(log, 'a')
  const child = spawn('pnpm', ['dev:pre', '--port', String(port)], { cwd, detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, PORT: String(port) } })
  closeSync(fd)
  child.unref()
  const next = { pid: child.pid, port, cwd, startedAt: new Date().toISOString(), warmed: false }
  writeFileSync(join(dir, 'server.json'), JSON.stringify(next))
  if (!wait) {
    // 后台预热：就绪后打开一次首页，把首屏编译做掉，等真正 check 时省掉这段。
    const warm = spawn(process.execPath, [new URL(import.meta.url).pathname, '__warm', '--cwd', cwd], { detached: true, stdio: 'ignore' })
    warm.unref()
    return { port, log, fresh: true }
  }
  try {
    await waitReady({ state: next, log })
  } catch (error) {
    // 两个任务同时挑中同一个空闲端口，后起的那个会因端口被占退出：换一个端口重起一次，不把这种偶发冲突丢给模型。
    if (fixedPort || !/already in use|EADDRINUSE/i.test(tail(log, 60))) throw error
    console.log(`端口 ${port} 被占，换一个端口重起`)
    try {
      unlinkSync(join(dir, 'server.json'))
    } catch { /* 已删 */ }
    return ensureServer({ cwd, wait, fixedPort: await pickPort(cwd) })
  }
  return { port, log, fresh: true }
}

const waitReady = async ({ state, log }) => {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await serverUp(state.port)) return
    if (!pidAlive(state.pid)) throw new Error(`本地服务启动失败（端口 ${state.port}），日志最后几行：\n${tail(log)}`)
    await sleep(1000)
  }
  throw new Error(`本地服务 ${READY_TIMEOUT_MS / 1000} 秒还没就绪（端口 ${state.port}），日志最后几行：\n${tail(log)}`)
}

const warmUp = async (cwd) => {
  const dir = dirOf(cwd)
  const state = readState(dir)
  if (!state) return
  try {
    await waitReady({ state, log: join(dir, 'dev.log') })
    await fetch(`http://127.0.0.1:${state.port}/`, { signal: AbortSignal.timeout(FIRST_PAGE_TIMEOUT_MS) })
    const latest = readState(dir)
    if (latest && latest.pid === state.pid) writeFileSync(join(dir, 'server.json'), JSON.stringify({ ...latest, warmed: true }))
  } catch { /* 预热失败不影响，check 时照样会等 */ }
}

/* ------------------------------ 登录 ------------------------------ */

const decryptSec = (sec) => {
  const decipher = createDecipheriv('aes-128-ecb', Buffer.from(DECRYPT_KEY, 'utf8'), null)
  const buf = Buffer.concat([decipher.update(Buffer.from(sec, 'base64')), decipher.final()])
  const zlib = buf.length > 1 && buf[0] === 0x78 && [0x01, 0x9c, 0xda].includes(buf[1])
  return JSON.parse((zlib ? inflateSync(buf) : buf).toString('utf8'))
}

// portal 登录（与前端、pre-token-probe 同一接口与平台编码），返回要写进 localStorage 的槽位；token 不打印。
const portalLogin = async () => {
  const res = await fetch(`${PORTAL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: MAIL, password: PWD, platform_code: 'hichat', device_type: 'pc' }),
    signal: AbortSignal.timeout(15_000),
  })
  const body = await res.json()
  const data = body.data && typeof body.data === 'object' && Object.keys(body.data).length ? body.data : typeof body.sec === 'string' && body.sec ? decryptSec(body.sec) : null
  if (body.code !== 0 || !data?.token || !data?.live_token) throw new Error(`测试号 ${MAIL} 登录失败：HTTP ${res.status} code ${body.code} ${body.msg || body.message || ''}`)
  const uid = data.user_info?.user_id ?? data.user_id
  const slots = { [SLOT.token]: data.live_token, [SLOT.uid]: String(uid ?? ''), [SLOT.portalToken]: data.token }
  if (Number(data.expires_in) > 0) slots[SLOT.portalExpiresAt] = String(Date.now() + Number(data.expires_in) * 1000)
  if (data.hichat_token) slots[SLOT.hichatToken] = data.hichat_token
  return { slots, uid }
}

/* ---------------------------- 页面检查 ---------------------------- */

const loadPlaywright = () => {
  try {
    return createRequire(join(TOOL_HOME, 'package.json'))('playwright-core')
  } catch {
    throw new Error(`没找到 playwright-core：在 ${TOOL_HOME} 下跑一次 npm i playwright-core@1.61.1（与本机缓存的 chromium 1243 配套）`)
  }
}

// 用本机缓存里的浏览器（playwright-core 1.61.1 默认找 1228 版，本机缓存是 1243）：优先无界面版，取版本号最大的。
const findChromium = () => {
  if (process.env.VERIFY_CHROMIUM) return process.env.VERIFY_CHROMIUM
  const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright')
  const dirs = existsSync(cache) ? readdirSync(cache) : []
  const newest = (prefix) => dirs.filter((name) => name.startsWith(prefix)).sort((a, b) => Number(b.split('-').pop()) - Number(a.split('-').pop()))
  for (const dir of newest('chromium_headless_shell-')) {
    const bin = join(cache, dir, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell')
    if (existsSync(bin)) return bin
  }
  for (const dir of newest('chromium-')) {
    const bin = join(cache, dir, 'chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium')
    if (existsSync(bin)) return bin
  }
  throw new Error(`${cache} 里没找到 chromium（可设 VERIFY_CHROMIUM 指定）`)
}

const shortUrl = (url) => {
  try {
    const u = new URL(url)
    return `${u.pathname}${u.search ? u.search.slice(0, 60) : ''}`
  } catch {
    return String(url).slice(0, 100)
  }
}
const pathOf = (url) => {
  try {
    return new URL(url).pathname
  } catch {
    return String(url).slice(0, 100)
  }
}
const MOCK_RE = /\[api\] (\S+) 接口不可用，回落 mock/
const AUTH_FAIL_RE = /登[录陆]状态失效|AuthError|无TOKEN|未授权|\b-?700\b/i
const API_TYPES = new Set(['xhr', 'fetch'])

// 一条问题：key 用来跟 pre 站点比对（接口按「方法 + 路径」、资源按路径、错误码按「接口 + 码」，不带查询串和域名），text 给人看。
export const problem = (kind, key, text, extra = {}) => ({ kind, key: `${kind}:${key}`, text, ...extra })

const checkPage = async ({ context, base, path, opts, log, firstLoad }) => {
  const page = await context.newPage()
  const found = new Map() // 同一个问题只记一次
  const add = (item) => {
    if (!found.has(item.key)) found.set(item.key, item)
  }
  const info = { consoleErrors: [], thirdParty: [], notes: [] }
  let apiCount = 0
  let memberInfoOk = false // 登录检查时用户信息接口成功返回 = 登录态真的生效
  const origin = new URL(base).origin
  const appUrl = (url) => {
    try {
      const u = new URL(url)
      return u.origin === origin || APP_HOSTS.test(u.host)
    } catch {
      return false
    }
  }
  page.on('console', (msg) => {
    const text = msg.text()
    const mock = text.match(MOCK_RE)
    if (mock) {
      // 带上回落原因（withApiFallback 把原始错误一起打在 warn 里），分得清是接口报错、请求写错还是没登录。
      const why = text.slice(mock.index + mock[0].length).replace(/^[:：\s]+/, '').replace(/\s+/g, ' ').slice(0, 160)
      add(problem('mock', mock[1], `回落 mock（假数据）：${mock[1]}${why ? `，原因 ${why}` : ''}`))
      return
    }
    if (msg.type() !== 'error') return
    const flat = text.replace(/\s+/g, ' ').slice(0, 200)
    // 水合不匹配只以 console error 出现，是真 bug；资源加载失败由请求监听统一记，这里不重复。
    if (/hydrat/i.test(flat)) add(problem('hydration', flat.slice(0, 60), `水合不匹配（服务端和客户端渲染不一致）：${flat}`))
    else if (!/^Failed to load resource/.test(flat)) info.consoleErrors.push(flat)
  })
  page.on('pageerror', (error) => {
    const message = String(error?.message || error).replace(/\s+/g, ' ').slice(0, 200)
    add(problem('pageError', message.slice(0, 80), `页面报错：${message}`))
  })
  // 本地和 pre 对同一个坏资源的表现不同（本地转发回非图片内容被浏览器拦成 ERR_BLOCKED_BY_ORB，pre 是 404），统一按路径记一类。
  const failRequest = (req, detail) => {
    const url = req.url()
    if (!appUrl(url)) {
      info.thirdParty.push(`${req.method()} ${shortUrl(url)} → ${detail}`)
      return
    }
    if (API_TYPES.has(req.resourceType())) add(problem('request', `${req.method()} ${pathOf(url)}`, `接口请求失败：${req.method()} ${shortUrl(url)} → ${detail}`))
    else add(problem('resource', pathOf(url), `资源加载失败（${req.resourceType()}）：${shortUrl(url)} → ${detail}`, { resourcePath: pathOf(url), resourceType: req.resourceType() }))
  }
  page.on('requestfailed', (req) => {
    const reason = req.failure()?.errorText || ''
    if (/ERR_ABORTED/.test(reason)) return // 跳转 / 组件卸载时取消的请求，不是故障
    failRequest(req, reason)
  })
  page.on('response', async (res) => {
    const req = res.request()
    const isApi = API_TYPES.has(req.resourceType()) && appUrl(res.url())
    if (isApi) apiCount += 1
    if (res.status() >= 400) {
      if (req.resourceType() !== 'document') failRequest(req, `HTTP ${res.status()}`)
      return
    }
    if (!isApi || !String(res.headers()['content-type'] || '').includes('json')) return
    try {
      const body = await res.json()
      const code = typeof body?.code === 'number' ? body.code : Number.NaN
      if (code === 0 && /\/Member\/info$/i.test(pathOf(res.url()))) memberInfoOk = true
      if (code < 0 || Math.abs(code) === 700) {
        const msg = String(body.msg ?? body.message ?? '').slice(0, 60)
        add(problem('biz', `${req.method()} ${pathOf(res.url())} ${code}`, `接口返回错误码：${req.method()} ${shortUrl(res.url())} → code ${code}${Math.abs(code) === 700 ? '（登录失效）' : ''}${msg ? ` ${msg}` : ''}`))
      }
    } catch { /* 读不了 body 的（流式 / 已释放）跳过 */ }
  })

  const logBefore = log && existsSync(log) ? statSync(log).size : 0
  const started = Date.now()
  let status = 0
  try {
    const res = await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded', timeout: firstLoad ? FIRST_PAGE_TIMEOUT_MS : PAGE_TIMEOUT_MS })
    status = res?.status() || 0
  } catch (error) {
    add(problem('open', path, `页面打不开：${String(error?.message || error).split('\n')[0].slice(0, 160)}`))
  }
  if (status) {
    await page.waitForLoadState('networkidle', { timeout: IDLE_TIMEOUT_MS }).catch(() => info.notes.push(`${IDLE_TIMEOUT_MS / 1000} 秒内请求没停（可能有轮询 / 长连接），按当时的状态检查`))
    await sleep(500) // 等水合后的首轮渲染
    if (status >= 400) add(problem('open', path, `页面本身返回 HTTP ${status}`))
    if (opts.wait) await page.waitForSelector(opts.wait, { timeout: 15_000 }).catch(() => add(problem('expect', opts.wait, `没等到元素 ${opts.wait}`)))
    const text = await page.locator('body').innerText().catch(() => '')
    for (const want of opts.expect) if (!text.includes(want)) add(problem('expect', want, `页面上没看到「${want}」`))
  }
  if (status && opts.login && !memberInfoOk) add(problem('login', path, '登录可能没生效：这一页没有用户信息接口（Member/info）成功返回，登录态下的检查结果不可信'))
  // SSR 侧的回落只在服务端日志里（console.warn 打在 dev 进程）：取本次打开期间新增的日志。
  if (log && existsSync(log)) {
    for (const line of readFileSync(log, 'utf8').slice(logBefore).split('\n')) {
      const mock = line.match(MOCK_RE)
      if (mock) add(problem('mock', mock[1], `回落 mock（假数据）：${mock[1]}（服务端渲染）`))
    }
  }
  const title = status ? await page.title().catch(() => '') : ''
  const shotDir = join(log ? join(log, '..') : join(STATE_ROOT, 'remote'), 'shots')
  mkdirSync(shotDir, { recursive: true })
  const shot = join(shotDir, `${origin.includes('127.0.0.1') ? 'local' : 'site'}-${path.replace(/[^\w-]+/g, '_').replace(/^_|_$/g, '') || 'home'}-${Date.now()}.png`)
  if (status) await page.screenshot({ path: shot, fullPage: true }).catch(() => info.notes.push('截图失败'))
  await page.close()
  return { path, status, title, ms: Date.now() - started, apiCount, shot: status ? shot : null, problems: [...found.values()], ...info }
}

// 期望类（--expect / --wait）和页面打不开只看本地：新功能在 pre 上本来就没有，比对没意义。
const COMPARABLE = new Set(['mock', 'hydration', 'pageError', 'request', 'resource', 'biz'])

// 图片等资源跟着内容走，两边打开时显示的帖子 / 直播可能不同，按「这次两边是否都失败」比会误判。
// 本地新出现的坏资源，直接拿同一路径去 pre 请求一次：pre 上也打不开 = 数据问题（图本身不存在）；pre 上正常才算本地新问题。
const probeOnSite = async ({ compareBase, item }) => {
  try {
    const res = await fetch(`${compareBase}${item.resourcePath}`, { signal: AbortSignal.timeout(10_000) })
    const type = String(res.headers.get('content-type') || '')
    const ok = res.ok && (item.resourceType !== 'image' || type.startsWith('image/'))
    return ok ? 'site-ok' : 'site-broken'
  } catch {
    return null
  }
}
const annotateResources = async ({ result, site, compareBase }) => {
  if (!site || !compareBase) return
  const siteKeys = new Set(site.problems.map((item) => item.key))
  await Promise.all(result.problems.filter((item) => item.kind === 'resource' && !siteKeys.has(item.key)).map(async (item) => {
    item.siteProbe = await probeOnSite({ compareBase, item })
  }))
}

// 给每条问题标来源（纯函数，单测钉住）：tag 为「pre 上也有」/「本地新出现」/ 空（期望类、页面打不开只看本地）。
export const classifyProblems = ({ result, site }) => {
  const siteKeys = site ? new Set(site.problems.map((item) => item.key)) : null
  // 没登录时调了要登录的接口：本地开发模式会把这个错误回落成 mock（线上不回落、显示为空），和 pre 上的登录失效是同一个根因。
  const siteAuthFail = Boolean(site?.problems.some((item) => item.kind === 'biz' && /登录失效/.test(item.text)))
  const preExisting = (item) => siteKeys.has(item.key) || item.siteProbe === 'site-broken' || (item.kind === 'mock' && siteAuthFail && AUTH_FAIL_RE.test(item.text))
  const items = result.problems.map((item) => {
    if (!siteKeys || !COMPARABLE.has(item.kind)) return { ...item, tag: '', note: '' }
    const pre = preExisting(item)
    let note = ''
    if (!siteKeys.has(item.key)) {
      if (item.kind === 'mock' && pre) note = '（没登录调了要登录的接口，pre 上同样报登录失效；本地开发模式会回落成 mock，线上显示为空）'
      else if (item.siteProbe === 'site-broken') note = '（pre 上同一地址也打不开，是数据问题：资源本身不存在）'
      else if (item.siteProbe === 'site-ok') note = '（pre 上同一地址正常：可能是本次改动把地址拼错了，或本地转发没覆盖这个路径）'
    }
    return { ...item, tag: pre ? '［pre 上也有］' : '［本地新出现］', note }
  })
  const localKeys = new Set(result.problems.map((item) => item.key))
  const fixedOnLocal = site ? site.problems.filter((item) => COMPARABLE.has(item.kind) && !localKeys.has(item.key)) : []
  return { items, fixedOnLocal, total: items.length, fresh: items.filter((item) => item.tag !== '［pre 上也有］').length }
}

const report = ({ result, site }) => {
  const { items, fixedOnLocal, total, fresh } = classifyProblems({ result, site })
  const lines = [`== ${result.path}  HTTP ${result.status || '-'}  ${(result.ms / 1000).toFixed(1)}s  接口请求 ${result.apiCount} 次${result.title ? `  标题「${result.title}」` : ''}`]
  if (!items.length) lines.push('  ✅ 没有回落 mock、页面报错、失败请求')
  for (const item of items.slice(0, 20)) lines.push(`  ⚠️ ${item.tag}${item.text}${item.note}`)
  if (items.length > 20) lines.push(`  ⚠️ 另有 ${items.length - 20} 条同类问题`)
  for (const item of fixedOnLocal.slice(0, 10)) lines.push(`  ✔ pre 上有、本地已没有：${item.text}`)
  if (site && !site.status) lines.push('  · pre 站点这一页没打开，没法比对')
  for (const item of result.consoleErrors.slice(0, 5)) lines.push(`  · console error：${item}`)
  for (const item of result.thirdParty.slice(0, 3)) lines.push(`  · 第三方请求失败（不算问题）：${item}`)
  for (const item of result.notes) lines.push(`  · ${item}`)
  if (result.shot) lines.push(`  截图：${result.shot}${site?.shot ? `（pre 同页：${site.shot}）` : ''}`)
  console.log(lines.join('\n'))
  return { total, fresh }
}

const newContext = async ({ browser, base, login, viewport, firstLoad }) => {
  const context = await browser.newContext({ viewport, locale: 'zh-CN' })
  if (!login) return { context, notes: [] }
  const page = await context.newPage()
  const notes = []
  try {
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: firstLoad ? FIRST_PAGE_TIMEOUT_MS : PAGE_TIMEOUT_MS })
    await page.waitForLoadState('networkidle', { timeout: IDLE_TIMEOUT_MS }).catch(() => {})
    const visitor = await page.evaluate(({ slots, visitorKey }) => {
      for (const [key, value] of Object.entries(slots)) localStorage.setItem(key, value)
      return localStorage.getItem(visitorKey)
    }, { slots: login.slots, visitorKey: SLOT.visitor })
    if (!visitor) notes.push('以游客身份打开首页后没拿到游客标识，登录后的 php 请求可能验签失败（407）')
  } catch (error) {
    notes.push(`登录前的游客首页没打开：${String(error?.message || error).split('\n')[0].slice(0, 120)}`)
  } finally {
    await page.close()
  }
  return { context, notes }
}

const runCheck = async (opts) => {
  if (!opts.paths.length) throw new Error('check 要给至少一个页面路径，如 / 或 /room/260')
  let base = opts.base
  let log = null
  let firstLoad = false
  if (!base) {
    if (!opts.cwd) throw new Error('check 要 --cwd <工作区>（本地起服务）或 --base <站点>（查已部署的）')
    const server = await ensureServer({ cwd: opts.cwd, wait: true, fixedPort: opts.port })
    base = `http://127.0.0.1:${server.port}`
    log = server.log
    firstLoad = server.fresh
  }
  // 本地检查默认同时打开 pre 站点同一页比对，标出哪些问题 pre 上本来就有（不是本次改动带来的）。
  const compareBase = opts.base || opts.noCompare ? null : COMPARE_BASE
  const { chromium } = loadPlaywright()
  const login = opts.login ? await portalLogin() : null
  const [width, height] = String(opts.viewport || '1440x900').split('x').map(Number)
  const viewport = { width: width || 1440, height: height || 900 }
  const browser = await chromium.launch({ headless: true, executablePath: findChromium() })
  let total = 0
  let fresh = 0
  try {
    const [local, site] = await Promise.all([
      newContext({ browser, base, login, viewport, firstLoad }),
      compareBase ? newContext({ browser, base: compareBase, login, viewport, firstLoad: false }) : null,
    ])
    if (login) firstLoad = false // 登录前的游客首页已经把首屏编译做掉
    for (const note of [...local.notes, ...(site?.notes || []).map((item) => `pre 站点：${item}`)]) console.log(`· ${note}`)
    console.log(`页面检查：${opts.base ? `已部署站点 ${base}` : `本地 dev:pre ${base}（${opts.cwd}）`}，${login ? `已登录测试号 ${MAIL}（uid ${login.uid}）` : '未登录'}${compareBase ? `，同时比对已部署的 ${compareBase}` : ''}`)
    for (const [index, path] of opts.paths.entries()) {
      const [result, siteResult] = await Promise.all([
        checkPage({ context: local.context, base, path, opts, log, firstLoad: firstLoad && index === 0 }),
        site ? checkPage({ context: site.context, base: compareBase, path, opts: { ...opts, expect: [], wait: null }, log: null, firstLoad: false }) : null,
      ])
      await annotateResources({ result, site: siteResult, compareBase })
      const counted = report({ result, site: siteResult })
      total += counted.total
      fresh += counted.fresh
    }
  } finally {
    await browser.close()
  }
  if (!total) console.log('结论：通过')
  else if (compareBase) console.log(`结论：有 ${total} 处问题，其中本地新出现 ${fresh} 处、pre 上本来就有 ${total - fresh} 处。本地新出现的要处理；pre 上也有的不是本次改动带来的，但这次要修的如果正是它，说明还没修好。`)
  else console.log(`结论：有 ${total} 处问题（见上）`)
  return total ? 1 : 0
}

/* ------------------------------ 入口 ------------------------------ */

const main = async () => {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.cmd === '__warm') return warmUp(opts.cwd)
  if (opts.cmd === 'start') {
    if (!opts.cwd) throw new Error('start 要 --cwd <工作区>')
    const server = await ensureServer({ cwd: opts.cwd, wait: false, fixedPort: opts.port })
    console.log(`本地服务${server.fresh ? '已在后台启动' : '已在跑，直接复用'}：http://127.0.0.1:${server.port}（日志 ${server.log}）。改完代码直接 check，不用等。`)
    return 0
  }
  if (opts.cmd === 'check') return runCheck(opts)
  if (opts.cmd === 'stop') {
    if (!opts.cwd) throw new Error('stop 要 --cwd <工作区>')
    const stopped = await stopServer(dirOf(opts.cwd), { reason: '任务结束' })
    if (!stopped) console.log('这个工作区没有在跑的本地服务')
    return 0
  }
  if (opts.cmd === 'status') {
    await reapStale()
    const rows = existsSync(STATE_ROOT) ? readdirSync(STATE_ROOT).map((name) => readState(join(STATE_ROOT, name))).filter(Boolean) : []
    console.log(rows.length ? rows.map((row) => `端口 ${row.port}  pid ${row.pid}  起于 ${row.startedAt}  ${row.cwd}`).join('\n') : '没有在跑的本地服务')
    return 0
  }
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((line) => /^ \*   node /.test(line)).map((line) => line.slice(3)).join('\n'))
  return 2
}

// 直接运行才执行（单测 import 纯函数时不跑）。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code ?? 0), (error) => {
    console.error(`验证工具出错：${error?.message || error}`)
    process.exit(2)
  })
}
