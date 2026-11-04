#!/usr/bin/env node
/**
 * P1 模拟器校准（design-v2 §8）：用 falive 自己的代码（run-sim-falive.mjs）跑一批事件组，和 falive 当时的真实表现比，分清「模拟不像」和「bot 不行」。
 *   node scripts/sim/calibrate.mjs [--count 20] [--conc 3] [--port 3300] [--only ep-…,ep-…] [--pick-only]
 * 选组（可复现）：10-23 12:00Z 之后（falive 代码指纹能核对上）、窗口不跨本地 23:59（UTC 19:59，日报调度被挪到那儿）、2–8 条 case，按类型轮转取满 count 组；
 *   不够再放宽到 1 条和更早的日子。每组跑完把 calibration.{md,json} 拷进 replay/falive/calibration/，最后写 summary.md。
 * 断点：calibration/<组>.json 已有就跳过。
 */
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { casesDir, replayRoot } from './falive-data.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const value = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d)
const count = Number(value('--count', 20))
const conc = Number(value('--conc', 3))
const port0 = Number(value('--port', 3300))
const outDir = join(casesDir, 'calibration')
mkdirSync(outDir, { recursive: true })
const epsFile = JSON.parse(readFileSync(join(casesDir, 'episodes.json'), 'utf8'))
const eps = Array.isArray(epsFile) ? epsFile : epsFile.episodes || epsFile.groups
const t = (x) => Date.parse(x)
const crossesLocalMidnight = (e) => { const end = t(e.lastAt) + 60 * 60_000; const d = new Date(t(e.windowStart)); const cut = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 19, 59); return e.days?.length > 1 || (t(e.windowStart) < cut && end > cut) }
const pick = () => {
  if (args.includes('--only')) return value('--only', '').split(',').filter(Boolean).map((id) => eps.find((e) => e.id === id))
  const tiers = [
    (e) => t(e.firstAt) >= t('2026-10-23T12:00:00Z') && e.size >= 2 && e.size <= 8 && !crossesLocalMidnight(e),
    (e) => t(e.firstAt) >= t('2026-10-23T12:00:00Z') && e.size <= 8 && !crossesLocalMidnight(e),
    (e) => e.size <= 8 && !crossesLocalMidnight(e),
  ]
  const chosen = []
  for (const ok of tiers) {
    const pool = eps.filter((e) => ok(e) && !chosen.includes(e)).sort((a, b) => t(a.firstAt) - t(b.firstAt))
    const byKind = new Map()
    for (const e of pool) { const k = Object.keys(e.kinds || {}).sort().join('+') || '-'; (byKind.get(k) || byKind.set(k, []).get(k)).push(e) }
    const queues = [...byKind.values()]
    while (chosen.length < count && queues.some((q) => q.length)) for (const q of queues) if (q.length && chosen.length < count) chosen.push(q.shift())
    if (chosen.length >= count) break
  }
  return chosen
}
const list = pick()
console.log(`[calibrate] ${list.length} 组：${list.map((e) => `${e.id}(${e.size})`).join(' ')}`)
if (args.includes('--pick-only')) process.exit(0)
const run = (e, port) => new Promise((resolve) => {
  if (existsSync(join(outDir, `${e.id}.json`))) { console.log(`[calibrate] 跳过 ${e.id}（已有结果）`); return resolve(true) }
  const sim = `cal-${e.id}`
  const child = spawn('node', [join(here, 'run-sim-falive.mjs'), '--episode', e.id, '--sim', sim, '--reset', '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] })
  let tail = ''
  child.stdout.on('data', (c) => { tail = (tail + c).slice(-2000) })
  child.stderr.on('data', (c) => { tail = (tail + c).slice(-2000) })
  child.on('close', (code) => {
    const dir = join(replayRoot, 'sim', sim)
    for (const ext of ['md', 'json']) if (existsSync(join(dir, `calibration.${ext}`))) copyFileSync(join(dir, `calibration.${ext}`), join(outDir, `${e.id}.${ext}`))
    console.log(`[calibrate] ${e.id} 结束 code=${code}${code ? `：${tail.split('\n').slice(-3).join(' | ')}` : ''}`)
    resolve(code === 0)
  })
})
let i = 0
await Promise.all(Array.from({ length: conc }, (_, w) => (async () => { while (i < list.length) { const e = list[i++]; await run(e, port0 + w * 10) } })()))
const rows = list.map((e) => { const p = join(outDir, `${e.id}.json`); return existsSync(p) ? { e, c: JSON.parse(readFileSync(p, 'utf8')) } : { e, c: null } })
writeFileSync(join(outDir, 'summary.md'), [`# 模拟器校准（${new Date().toISOString().slice(0, 16)}）`, '', `${rows.filter((r) => r.c).length}/${rows.length} 组有结果；逐组见同目录 <组>.md`, '',
  ...rows.map(({ e, c }) => `- ${e.id}（${e.size} 条，${Object.keys(e.kinds || {}).join('/')}）：${c ? `路由 ${c.routing?.matched ?? '?'}/${c.routing?.total ?? '?'}；egress flagged ${c.egress?.flagged?.length ?? 0}；假 CLI 缺口 ${c.fakeCliGaps?.length ?? 0}` : '没出结果'}`)].join('\n') + '\n')
console.log('[calibrate] 汇总写到 replay/falive/calibration/summary.md')
