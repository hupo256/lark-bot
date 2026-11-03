#!/usr/bin/env node
/**
 * 一轮回放的止损守卫（docs/falive-replay-plan-2026-11-03.md 43）：run-round.sh 起跑后在后台跑，每 5 分钟看一次各段，
 * 出现「这轮结果已经不可信」的信号就整轮停掉并写明原因，不让它带病跑完（r9 撞额度后假失败一片、r10 第一次 worker 没起来都是跑了很久才发现）：
 *   worker / gateway 进程报错退出（日志里 Error:）、读取缺口（missing.log 有行）、分类失败 ≥ 3（intake_failed，排除额度暂停期）、
 *   25 分钟没喂新消息且不在额度暂停。
 *   node scripts/sim/round-guard.mjs --round r11 --pid <run-round 的 pid>
 */
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { replayRoot, roundsDir } from './falive-data.mjs'
import { pausedUntil } from './claude-quota.mjs'

const args = process.argv.slice(2)
const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const round = value('--round', null)
const pid = value('--pid', null)
const simRoot = join(replayRoot, 'sim')
const fed = new Map()
const stop = (why) => {
  const out = join(roundsDir, round)
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'STOPPED.md'), `# ${round} 止损停掉（${new Date().toISOString()}）\n\n${why.map((w) => `- ${w}`).join('\n')}\n`)
  console.log(`GUARD-STOP ${round}: ${why.join('；')}`)
  spawnSync('pkill', ['-f', `run-round.sh ${round} `])
  if (pid) spawnSync('kill', [pid])
  spawnSync('pkill', ['-f', `run-days.sh .* ${round}-`])
  spawnSync('pkill', ['-f', `run-sim.mjs --sim ${round}-`])
  spawnSync('pkill', ['-f', `sim/${round}-.*lark-bot.local.json`])
  process.exit(2)
}
for (;;) {
  await new Promise((r) => setTimeout(r, 5 * 60_000))
  if (!existsSync(simRoot)) continue
  const why = []
  const paused = Boolean(pausedUntil())
  for (const seg of readdirSync(simRoot).filter((d) => d.startsWith(`${round}-`))) {
    const dir = join(simRoot, seg)
    if (existsSync(join(dir, 'DONE'))) continue
    const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : '')
    const errs = [...read('worker.log').matchAll(/^.*Error: .*$/gm), ...read('gateway.log').matchAll(/^.*Error: .*$/gm)].map((m) => m[0].slice(0, 160))
    if (errs.length) why.push(`${seg} 进程报错：${errs[0]}`)
    const missing = read('missing.log').split('\n').filter(Boolean)
    if (missing.length) why.push(`${seg} 读取缺口 ${missing.length} 处：${missing[0].slice(0, 160)}`)
    const failedIntake = (read('gateway.log').match(/分类失败/g) || []).length
    if (failedIntake >= 3 && !paused) why.push(`${seg} 分类失败 ${failedIntake} 次`)
    if (existsSync(join(dir, 'fed.json'))) {
      const n = JSON.parse(read('fed.json')).length
      const prev = fed.get(seg)
      if (!prev || prev.n !== n || paused) fed.set(seg, { n, at: Date.now() })
      else if (Date.now() - prev.at > 25 * 60_000) why.push(`${seg} 25 分钟没喂新消息（停在 ${n} 条）`)
    }
  }
  if (why.length) stop(why)
  if (pid && spawnSync('kill', ['-0', pid]).status !== 0) process.exit(0)
}
