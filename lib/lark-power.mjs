/**
 * 机器电源态（合盖 / 睡眠）单采样点：ioreg / sysctl 各 30s 缓存，keep-awake、轮询器、开盖补拉、日报调度、
 * 体检共用一份，不再各自起子进程（第 1 批：每轮子进程数要降到 ≤ 6）。
 * 非 macOS / 命令失败：合盖按「开盖」、入睡时间按 null，宁可照常工作。
 */

import { execFile } from 'node:child_process'

const SAMPLE_TTL_MS = Number(process.env.LARK_POWER_SAMPLE_MS || 30_000)

// ioreg 的 AppleClamshellState：Yes = 合盖。
export const parseClamshellState = (text) => /"AppleClamshellState"\s*=\s*Yes/.test(String(text || ''))
// sysctl -n kern.sleeptime：`{ sec = 1792204239, usec = 128033 } Sat Oct 17 06:30:39 2026`；sec = 0 表示没睡过。
export const parseKernSleepTime = (text) => {
  const sec = Number(String(text || '').match(/sec\s*=\s*(\d+)/)?.[1] || 0)
  return sec > 0 ? sec * 1000 : null
}

const run = (cmd, args) =>
  new Promise((resolve) => execFile(cmd, args, { timeout: 2_000 }, (error, stdout) => resolve(error ? null : String(stdout))))

const cache = { lid: { at: 0, value: false, pending: null }, sleep: { at: 0, value: null, pending: null } }
const sample = async (slot, now, fetcher) => {
  if (now - cache[slot].at < SAMPLE_TTL_MS) return cache[slot].value
  if (!cache[slot].pending) {
    cache[slot].pending = fetcher().then((value) => {
      cache[slot] = { at: now, value, pending: null }
      return value
    })
  }
  return cache[slot].pending
}

export const isLidClosed = ({ platform = process.platform, now = Date.now } = {}) =>
  platform !== 'darwin' ? Promise.resolve(false) : sample('lid', now(), async () => parseClamshellState(await run('ioreg', ['-r', '-k', 'AppleClamshellState', '-d', '1'])))

export const lastSystemSleepAt = ({ platform = process.platform, now = Date.now } = {}) =>
  platform !== 'darwin' ? Promise.resolve(null) : sample('sleep', now(), async () => parseKernSleepTime(await run('sysctl', ['-n', 'kern.sleeptime'])))

// 测试 / 强制重采样用。
export const resetPowerCache = () => {
  cache.lid = { at: 0, value: false, pending: null }
  cache.sleep = { at: 0, value: null, pending: null }
}
