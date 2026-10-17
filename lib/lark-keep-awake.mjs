/**
 * 开盖时不让系统空闲睡眠（aven 2026-10-17 定：合盖 = bot 下班，开盖 = bot 必须在线）。
 * `caffeinate -i` 挂一个 PreventUserIdleSystemSleep 断言：电池 / 电源都生效，合盖照样睡（Clamshell Sleep
 * 不受断言影响），正好是要的语义。`-w <pid>` 让它跟着 gateway 进程走，gateway 被 kill -9 也不会留孤儿。
 * 实测前情：10-16 19:32 开盖用电池、空闲 12 分钟系统自己睡了（pmset log 'Idle Sleep'）。
 * 关掉：LARK_KEEP_AWAKE=0。非 macOS 不做任何事。
 *
 * isLidClosed（见 lib/lark-power.mjs）：合盖期间 Power Nap 每 15–20 分钟半醒几十秒，这时轮询 / 领任务会跑到一半又睡过去。
 * 合盖就暂停（轮询游标不动、worker 不领新任务），开盖后一次补拉合盖期间的消息再统一处理。
 */

import { spawn } from 'node:child_process'

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

// 合盖判断搬到 lib/lark-power.mjs（单采样点，30s 缓存）；这里只做转出口，旧引用不变。
export { isLidClosed, parseClamshellState } from './lark-power.mjs'
