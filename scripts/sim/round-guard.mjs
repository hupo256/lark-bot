#!/usr/bin/env node
/**
 * 一轮回放的止损守卫（docs/falive-replay-plan-2026-11-03.md 43）：run-episodes.mjs（按事件组，sim/<轮>/<组>/）或旧的 run-round.sh
 * （按天分段，sim/<轮>-<段>/）起跑后在后台跑，每 5 分钟看一次各组 / 段，
 * 出现「这轮结果已经不可信」的信号就整轮停掉并写明原因，不让它带病跑完（r9 撞额度后假失败一片、r10 第一次 worker 没起来都是跑了很久才发现）：
 *   worker / gateway 进程报错退出（日志里 Error:）、读取缺口（missing.log 有行）、分类失败 ≥ 3（intake_failed，排除额度暂停期）、
 *   50 分钟没动静且不在额度暂停：按天跑看 fed.json 条数；按组跑看 sim.log / gateway.log / worker.log / cli-calls.log / outbox.jsonl
 *   最后写入时间（组里只喂几条 case，收尾等空闲也可能半小时不喂；单次 claude 调用最长 30 分钟，见 claude-quota SIM_ORIG_TOTAL_MS）。
 *   node scripts/sim/round-guard.mjs --round r11 --pid <run-episodes / run-round 的 pid> [--once]
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { replayRoot, roundsDir } from './falive-data.mjs'
import { pausedUntil } from './claude-quota.mjs'

const args = process.argv.slice(2)
const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const round = value('--round', null)
const pid = value('--pid', null)
const simRoot = join(replayRoot, 'sim')
const episodeRoot = join(simRoot, round)
// 按组跑：sim/<轮>/ 下每个有 meta.json 的子目录是一组；按天跑（旧）：sim/<轮>-<段>/
const units = () => existsSync(join(episodeRoot, 'round.json'))
  ? readdirSync(episodeRoot, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(episodeRoot, d.name, 'meta.json'))).map((d) => ({ name: d.name, dir: join(episodeRoot, d.name), episode: true }))
  : readdirSync(simRoot).filter((d) => d.startsWith(`${round}-`) && !d.includes('.')).map((d) => ({ name: d, dir: join(simRoot, d), episode: false })) // 存档点 <段>.ckpt / 日志 <段>.run-days.out 不算段
const PROGRESS_FILES = ['sim.log', 'gateway.log', 'worker.log', 'cli-calls.log', 'outbox.jsonl']
const lastProgress = (dir) => Math.max(0, ...PROGRESS_FILES.map((f) => (existsSync(join(dir, f)) ? statSync(join(dir, f)).mtimeMs : 0)))
const fed = new Map()
let lastPausedAt = 0
const stop = (why) => {
  const out = join(roundsDir, round)
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'STOPPED.md'), `# ${round} 止损停掉（${new Date().toISOString()}）\n\n${why.map((w) => `- ${w}`).join('\n')}\n`)
  console.log(`GUARD-STOP ${round}: ${why.join('；')}`)
  // 匹配串别和守卫自己的命令行重合（11-03 pkill 把自己的 shell 杀了）：守卫的命令行是 round-guard.mjs --round <轮> --pid <n>
  if (pid) spawnSync('kill', [pid])
  spawnSync('pkill', ['-f', `run-round.sh ${round} `])
  spawnSync('pkill', ['-f', `run-days.sh .* ${round}-`])
  spawnSync('pkill', ['-f', `run-sim.mjs --sim ${round}-`])
  spawnSync('pkill', ['-f', `run-sim.mjs --sim ${round}/`]) // run-sim 收到 SIGTERM 会带走自己的网关 / worker
  spawnSync('pkill', ['-f', `sim/${round}-.*lark-bot.local.json`])
  spawnSync('pkill', ['-f', `sim/${round}/.*lark-bot.local.json`])
  process.exit(2)
}
const once = args.includes('--once') // 只检查一次、只打印不停（验证规则用）
for (;;) {
  if (!once) await new Promise((r) => setTimeout(r, 5 * 60_000))
  if (!existsSync(simRoot)) continue
  const why = []
  const paused = Boolean(pausedUntil())
  if (paused) lastPausedAt = Date.now()
  for (const { name: seg, dir, episode } of units()) {
    if (existsSync(join(dir, 'DONE')) || existsSync(join(dir, 'FAILED'))) continue
    const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : '')
    // 只认进程级崩溃：日志行的正文直接以 XxxError: 开头（未捕获异常 / 启动自检失败，下一行是堆栈），或 sim.log 记了进程非 0 退出。
    // lark-bot 自己接住并重试的（「claude 命中瞬时错误，退避…重试」里带的 API Error: 500）不算——11-03 守卫第一版就因此误停了 r10。
    const crash = /^\d\d-\d\d \d\d:\d\d:\d\d\.\d+ (?:Uncaught )?[A-Za-z]*Error: .*$/gm
    const errs = [...read('worker.log').matchAll(crash), ...read('gateway.log').matchAll(crash), ...read('sim.log').matchAll(/^.*(?:gateway|worker) 退出 code=[1-9].*$/gm)].map((m) => m[0].slice(0, 160))
    if (errs.length) why.push(`${seg} 进程报错：${errs[0]}`)
    const missing = read('missing.log').split('\n').filter(Boolean)
    if (missing.length) why.push(`${seg} 读取缺口 ${missing.length} 处：${missing[0].slice(0, 160)}`)
    const failedIntake = (read('gateway.log').match(/分类失败/g) || []).length
    if (failedIntake >= 3 && !paused) why.push(`${seg} 分类失败 ${failedIntake} 次`)
    if (episode) {
      // 额度暂停期间日志自然不动：从最后一次看到暂停起重新计时
      const at = Math.max(lastProgress(dir), lastPausedAt)
      if (!paused && Date.now() - at > 50 * 60_000) why.push(`${seg} 50 分钟没动静（日志 / 发件最后写于 ${new Date(lastProgress(dir)).toISOString()}）`)
    } else if (existsSync(join(dir, 'fed.json'))) {
      const n = JSON.parse(read('fed.json')).length
      const prev = fed.get(seg)
      if (!prev || prev.n !== n || paused) fed.set(seg, { n, at: Date.now() })
      else if (Date.now() - prev.at > 50 * 60_000) why.push(`${seg} 50 分钟没喂新消息（停在 ${n} 条）`)
    }
  }
  if (once) { console.log(why.length ? why.join('\n') : '无异常'); process.exit(0) }
  if (why.length) stop(why)
  if (pid && spawnSync('kill', ['-0', pid]).status !== 0) process.exit(0)
}
