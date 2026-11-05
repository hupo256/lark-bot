/**
 * 虚拟时钟（离线模拟器，docs/replay/falive-replay-plan-2026-11-03.md §2 L2）：`node --import <本文件>` 预载，
 * 让进程里的 Date.now() / new Date() 跟着 SIM_DIR/clock.json 走：{ virtualMs, realMs } 表示「真实时刻 realMs 对应虚拟时刻 virtualMs」，
 * 之后按真实时间等速推进；编排器每喂一条事件就改写一次（跳到事件时刻）。定时器（setInterval / setTimeout）仍按真实时间跑：
 * 它们大多是周期巡检，巡检里比较的是虚拟时间戳，跳表后下一次巡检自然命中。没有 SIM_DIR 或读不到文件就是真实时间。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const RealDate = Date
const clockPath = process.env.SIM_DIR ? join(process.env.SIM_DIR, 'clock.json') : null
let cache = { virtualMs: null, realMs: null, readAt: 0 }
const readClock = () => {
  const now = RealDate.now()
  if (clockPath && now - cache.readAt > 200) {
    try {
      const parsed = JSON.parse(readFileSync(clockPath, 'utf8'))
      cache = { virtualMs: Number(parsed.virtualMs), realMs: Number(parsed.realMs), readAt: now }
    } catch {
      cache.readAt = now
    }
  }
  return cache
}
const virtualNow = () => {
  const c = readClock()
  return Number.isFinite(c.virtualMs) && Number.isFinite(c.realMs) ? c.virtualMs + (RealDate.now() - c.realMs) : RealDate.now()
}

class SimDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(virtualNow())
    else super(...args)
  }
  static now() {
    return virtualNow()
  }
}
if (clockPath) globalThis.Date = SimDate
