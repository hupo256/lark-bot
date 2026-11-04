#!/usr/bin/env node
/**
 * 回放用 claude 额度闸（docs/falive-replay-plan-2026-11-03.md 41）：run-sim 把 LARK_CLAUDE_BIN 指到 scripts/sim/claude-q（本文件的 sh 壳）。
 * 回放和线上 bot 共用一个 Claude 账号，8 段并行约 1 小时就撞「session limit」，之后的分类 / 执行全失败、留下假的 intake_failed / failed。
 * 这里：撞限额（结果里 hit your … limit / usage limit reached / api_error_status 429）就写全局暂停文件 runtime/falive-replay/quota-pause.json
 * （到重置时刻 + 1 分钟；解析不出就 10 分钟后再试），各 sim 的 run-sim 看到它就冻住虚拟时钟、不喂消息；本次调用等到点重试，不把失败交给 lark-bot。
 * lark-bot 那边的真实时间超时在 sim 里放大（run-sim 设），原来的超时由这里按真实耗时执行（不算等额度的时间）：
 * 无输出 SIM_ORIG_IDLE_MS（600s）杀掉；总时长分类调用（--permission-mode plan）SIM_ORIG_INTENT_MS（120s）、其余 SIM_ORIG_TOTAL_MS（1800s）。
 * 输出整段缓冲、结束后一次写出（要能丢掉撞限额那次的输出重来）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const replayRoot = process.env.FALIVE_REPLAY_DIR || join(homedir(), 'github', 'lark-bot', 'runtime', 'falive-replay')
export const pausePath = join(replayRoot, 'quota-pause.json')
const LIMIT_RE = /hit your (?:session |weekly |usage |daily )?limit|usage limit reached|"api_error_status":\s*429|rate_limit_error/i
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (line) => { try { appendFileSync(join(process.env.SIM_DIR || replayRoot, 'quota.log'), `${new Date().toISOString()} ${line}\n`) } catch { /* ignore */ } }

export const pausedUntil = () => {
  try { const p = JSON.parse(readFileSync(pausePath, 'utf8')); return p.until > Date.now() ? p.until : 0 } catch { return 0 }
}
// 「resets 6:40pm (Asia/Dubai)」「resets Nov 4, 6:40pm」→ 本机时区（与提示里的时区一致：本机就是 Asia/Dubai）的下一个该时刻。
export const parseReset = (text, now = Date.now()) => {
  const m = /resets\s+(?:([A-Z][a-z]{2})\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(text) // 周额度是「resets Nov 8 at 6pm」
  if (!m) return null
  let hour = Number(m[3]) % 12
  if (m[5].toLowerCase() === 'pm') hour += 12
  const d = new Date(now)
  if (m[1]) {
    const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[1].toLowerCase())
    if (month >= 0) d.setMonth(month, Number(m[2]))
  }
  d.setHours(hour, Number(m[4] || 0), 0, 0)
  if (!m[1] && d.getTime() <= now) d.setDate(d.getDate() + 1)
  // 会话窗口最长 5 小时：没写日期却算出 5.5 小时以后，多半是刚过重置点（日志落后几秒），2 分钟后再试
  if (!m[1] && d.getTime() - now > 5.5 * 3600_000) return now + 2 * 60_000
  return d.getTime()
}
const setPause = (text) => {
  const reset = parseReset(text)
  const until = Math.max(pausedUntil(), (reset || Date.now() + 9 * 60_000) + 60_000)
  writeFileSync(pausePath, JSON.stringify({ until, untilIso: new Date(until).toISOString(), since: new Date().toISOString(), reason: (LIMIT_RE.exec(text)?.[0] || '').slice(0, 80) }))
  return until
}
const resolveReal = () => {
  if (process.env.SIM_REAL_CLAUDE) return process.env.SIM_REAL_CLAUDE
  const self = realpathSync(join(here, 'claude-q'))
  const found = spawnSync('/bin/sh', ['-c', 'which -a claude'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean)
  return found.find((p) => { try { return realpathSync(p) !== self } catch { return false } }) || 'claude'
}

const runOnce = (bin, argv, input) => new Promise((resolve) => {
  const intent = argv.includes('--permission-mode') && argv[argv.indexOf('--permission-mode') + 1] === 'plan'
  const totalMs = Number(intent ? process.env.SIM_ORIG_INTENT_MS || 120000 : process.env.SIM_ORIG_TOTAL_MS || 1800000)
  const idleMs = Number(process.env.SIM_ORIG_IDLE_MS || 600000)
  const child = spawn(bin, argv, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env })
  const out = []
  const err = []
  let timer = null
  let killedFor = null
  const kill = (why) => { killedFor = why; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000).unref() }
  const bump = () => { clearTimeout(timer); if (idleMs > 0) timer = setTimeout(() => kill(`idle ${idleMs}ms`), idleMs) }
  const total = setTimeout(() => kill(`timeout ${totalMs}ms`), totalMs)
  bump()
  child.stdout.on('data', (b) => { out.push(b); bump() })
  child.stderr.on('data', (b) => { err.push(b); bump() })
  child.on('error', (e) => err.push(Buffer.from(String(e))))
  child.on('close', (code, signal) => {
    clearTimeout(timer); clearTimeout(total)
    resolve({ code: code ?? (signal ? 1 : 0), stdout: Buffer.concat(out), stderr: Buffer.concat(err), killedFor })
  })
  child.stdin.on('error', () => {})
  child.stdin.end(input)
})

const main = async () => {
  const argv = process.argv.slice(2)
  const input = process.stdin.isTTY ? Buffer.alloc(0) : readFileSync(0)
  const bin = resolveReal()
  for (let attempt = 1; ; attempt += 1) {
    for (let until = pausedUntil(); until; until = pausedUntil()) await sleep(Math.min(30_000, until - Date.now() + 500))
    const r = await runOnce(bin, argv, input)
    const text = `${r.stdout.toString('utf8').slice(-20000)}\n${r.stderr.toString('utf8').slice(-5000)}`
    if (!r.killedFor && r.code !== 0 && LIMIT_RE.test(text) && attempt < 50) {
      const until = setPause(text)
      log(`limit attempt=${attempt} pause→${new Date(until).toISOString()} ${(LIMIT_RE.exec(text)?.[0] || '')}`)
      continue
    }
    if (attempt > 1) log(`ok-after attempt=${attempt} code=${r.code}`)
    if (r.killedFor) r.stderr = Buffer.concat([r.stderr, Buffer.from(`\n[claude-quota] killed: ${r.killedFor}\n`)])
    process.stdout.write(r.stdout)
    process.stderr.write(r.stderr)
    process.exitCode = r.code
    return
  }
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await main()
