/**
 * 常驻 lark-cli 长连接（mode=watch 时跑 `mail +watch`）：逐行 JSON 交给 onLine，掉线退避重连，稳定存活后退避归零。
 * 11-05 P1 拆分：独立运行用这一份；lark-bot 内置时注入它自己的 lib/lark-consumer.mjs（带掉线告警与健康观测）。
 */
import { spawn } from 'node:child_process'

import { larkCliBin } from './lark.mjs'

const RECONNECT_BACKOFFS_MS = [1000, 2000, 5000, 10000, 30000, 60000]
const STABLE_UPTIME_MS = 60000

// command：整条 lark-cli 参数；env：子进程额外环境变量；maxRestarts：连续失败上限；spawnChild 可注入（单测）。
export const startConsumer = ({ eventKey, onLine, command, env, maxRestarts, spawnChild = spawn }) => {
  const state = { child: null, stopped: false, backoffAttempts: 0, lastEventAt: 0 }
  const spawnOnce = () => {
    const child = spawnChild(larkCliBin, command, { stdio: ['pipe', 'pipe', 'pipe'], ...(env ? { env: { ...process.env, ...env } } : {}) })
    state.child = child
    const spawnedAt = Date.now()
    let buffer = ''
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString()
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
        if (!line) continue
        let raw
        try {
          raw = JSON.parse(line)
        } catch {
          continue
        }
        state.lastEventAt = Date.now()
        Promise.resolve(onLine(raw)).catch((error) => console.error(`[lark-mail-relay] ${eventKey} handler error:`, error.message))
      }
    })
    child.stderr.on('data', (chunk) => process.stderr.write(`[lark-cli ${eventKey}] ${chunk}`))
    child.on('error', (error) => console.error(`[lark-mail-relay] ${eventKey} spawn error:`, error.message))
    child.on('exit', (code) => {
      state.child = null
      if (state.stopped) return
      if (Date.now() - spawnedAt >= STABLE_UPTIME_MS) state.backoffAttempts = 0
      if (maxRestarts && state.backoffAttempts >= maxRestarts) {
        console.error(`[lark-mail-relay] ${eventKey} 连续 ${state.backoffAttempts} 次失败，停止重连`)
        return
      }
      const delay = RECONNECT_BACKOFFS_MS[Math.min(state.backoffAttempts, RECONNECT_BACKOFFS_MS.length - 1)]
      state.backoffAttempts += 1
      console.error(`[lark-mail-relay] ${eventKey} 退出（code ${code}），${delay}ms 后重连`)
      setTimeout(() => {
        if (!state.stopped) spawnOnce()
      }, delay)
    })
  }
  spawnOnce()
  return {
    observe: () => ({ alive: state.child != null && state.child.exitCode === null, lastEventAt: state.lastEventAt || null, backoffAttempts: state.backoffAttempts }),
    stop: () => {
      state.stopped = true
      state.child?.kill('SIGTERM')
    },
  }
}
