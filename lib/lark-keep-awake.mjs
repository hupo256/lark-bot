/**
 * 开盖时不让系统空闲睡眠（合盖 = bot 下班，开盖 = bot 必须在线）。
 * `caffeinate -i` 挂一个 PreventUserIdleSystemSleep 断言：电池 / 电源都生效，合盖照样睡（Clamshell Sleep
 * 不受断言影响），正好是要的语义。`-w <pid>` 让它跟着 gateway 进程走，gateway 被 kill -9 也不会留孤儿。
 * 实测前情（falive 10-16）：开盖用电池、空闲 12 分钟系统自己睡了，长连接断掉收不到 @。
 * 关掉：LARK_KEEP_AWAKE=0。非 macOS 不做任何事。
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
