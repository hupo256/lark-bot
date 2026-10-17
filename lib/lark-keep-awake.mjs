/**
 * 开盖时不让系统空闲睡眠（aven 2026-10-17 定：合盖 = bot 下班，开盖 = bot 必须在线）。
 * `caffeinate -i` 挂一个 PreventUserIdleSystemSleep 断言：电池 / 电源都生效，合盖照样睡（Clamshell Sleep
 * 不受断言影响），正好是要的语义。`-w <pid>` 让它跟着 gateway 进程走，gateway 被 kill -9 也不会留孤儿。
 * 实测前情：10-16 19:32 开盖用电池、空闲 12 分钟系统自己睡了（pmset log 'Idle Sleep'）。
 * 关掉：LARK_KEEP_AWAKE=0。非 macOS 不做任何事。
 *
 * isLidClosed：合盖期间 Power Nap 每 15–20 分钟半醒几十秒，这时轮询 / 领任务会跑到一半又睡过去。
 * 合盖就暂停（轮询游标不动、worker 不领新任务），开盖后一次补拉合盖期间的消息再统一处理。
 */

import { execFile, spawn } from 'node:child_process'

export const startKeepAwake = ({ env = process.env, platform = process.platform, pid = process.pid, spawnFn = spawn } = {}) => {
  if (platform !== 'darwin' || env.LARK_KEEP_AWAKE === '0') return { stop() {} }
  const child = spawnFn('/usr/bin/caffeinate', ['-i', '-w', String(pid)], { stdio: 'ignore' })
  child.on?.('error', (error) => console.warn(`[lark-gateway] caffeinate 启动失败（开盖空闲时系统可能睡眠）：${String(error).slice(0, 120)}`))
  child.unref?.()
  console.log('[lark-gateway] keep-awake：开盖不空闲睡眠（caffeinate -i），合盖照常睡')
  return {
    stop() {
      try {
        child.kill()
      } catch {
        // 已退出
      }
    },
  }
}

// ioreg 的 AppleClamshellState：Yes = 合盖。取不到（非 macOS / 命令失败）按开盖算，宁可照常工作。
export const parseClamshellState = (text) => /"AppleClamshellState"\s*=\s*Yes/.test(String(text || ''))

let lidCache = { at: 0, closed: false }
const LID_CACHE_MS = 5_000
export const isLidClosed = ({ platform = process.platform, now = Date.now } = {}) =>
  new Promise((resolve) => {
    if (platform !== 'darwin') return resolve(false)
    if (now() - lidCache.at < LID_CACHE_MS) return resolve(lidCache.closed)
    execFile('ioreg', ['-r', '-k', 'AppleClamshellState', '-d', '1'], { timeout: 2_000 }, (error, stdout) => {
      const closed = error ? false : parseClamshellState(stdout)
      lidCache = { at: now(), closed }
      resolve(closed)
    })
  })
