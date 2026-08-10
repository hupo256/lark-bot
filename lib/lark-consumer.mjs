/**
 * Lark 长连接事件消费的自愈封装：spawn `lark-cli event consume` 常驻，掉线后退避重连、
 * 稳定存活重置退避、滑窗内连续抖动发一次告警，并暴露健康观测快照供 /lark/health 用。
 */

import { spawn } from 'node:child_process'
import { larkCliBin } from './lark-cli.mjs'

// 长连接自愈参数：退避档位、稳定阈值、告警触发次数与统计窗口。
const RECONNECT_BACKOFFS_MS = [1000, 2000, 5000, 10000, 30000, 60000]
const STABLE_UPTIME_MS = 60000 // 连接存活超过此时长视为已稳定，下次掉线的退避延迟从最小重来
const ALERT_AFTER_RESTARTS = 3 // 滑动窗口内重连达到此次数 -> 发一次群告警
const RECONNECT_ALERT_WINDOW_MS = Number(process.env.LARK_RECONNECT_ALERT_WINDOW_MS || 10 * 60 * 1000) // 抖动统计窗口（默认 10min）

// 通用长连接消费（当前用于 im.message.receive_v1 收群 @）。
// onLine(raw) 处理逐行 JSON 事件；onDownAlert 可选（掉线告警）；maxRestarts 可选（未订阅类错误设上限免刷日志）。
export const startConsumer = ({ eventKey, onLine, onDownAlert, maxRestarts }) => {
  // backoffAttempts 只驱动退避延迟（稳定存活后归零）；restartWindow 是滑动窗口内的掉线时间戳，
  // 驱动告警——「每 61s 抖一次」这类稳定即归零 backoff 但仍在持续掉线的情况，靠窗口计数才能告警。
  const state = { child: null, stopped: false, backoffAttempts: 0, restartWindow: [], alerted: false, lastEventAt: 0 }

  const spawnOnce = () => {
    // `--as bot`：lark-cli defaultAs:auto 会解析成 user 身份，而 event consume 只支持 bot
    // （报 "only supports: bot, use --as bot"）。显式指定，避免 consumer 反复 exit 2。
    const child = spawn(larkCliBin, ['--as', 'bot', 'event', 'consume', eventKey], { stdio: ['pipe', 'pipe', 'pipe'] })
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
        state.lastEventAt = Date.now() // 观测：最近一次收到事件；health 据此判活
        Promise.resolve(onLine(raw)).catch((error) =>
          console.error(`[lark-gateway] ${eventKey} handler error:`, error.message),
        )
      }
    })
    child.stderr.on('data', (chunk) => process.stderr.write(`[lark-cli consume ${eventKey}] ${chunk}`))
    child.on('error', (error) => console.error(`[lark-gateway] ${eventKey} spawn error:`, error.message))
    child.on('exit', (code) => {
      state.child = null
      if (state.stopped) return

      const now = Date.now()
      // 连接曾稳定存活足够久 -> 退避延迟从头来（但不清空告警窗口：持续抖动仍需被统计到）
      if (now - spawnedAt >= STABLE_UPTIME_MS) state.backoffAttempts = 0

      // 滑动窗口：记录本次掉线、剔除窗口外的旧记录
      state.restartWindow.push(now)
      state.restartWindow = state.restartWindow.filter((ts) => now - ts <= RECONNECT_ALERT_WINDOW_MS)
      // 窗口内已恢复安静（仅剩本次）则允许下一轮再次告警
      if (state.restartWindow.length <= 1) state.alerted = false

      if (maxRestarts && state.backoffAttempts >= maxRestarts) {
        console.error(
          `[lark-gateway] ${eventKey} 连续 ${state.backoffAttempts} 次消费失败，已停止重试（多为后台未订阅该事件）；订阅后 lark-bot restart 生效`,
        )
        return
      }

      const delay = RECONNECT_BACKOFFS_MS[Math.min(state.backoffAttempts, RECONNECT_BACKOFFS_MS.length - 1)]
      state.backoffAttempts += 1
      console.error(
        `[lark-gateway] ${eventKey} consumer exited (code ${code}); reconnecting in ${delay}ms (窗口内第 ${state.restartWindow.length} 次抖动)`,
      )
      if (onDownAlert && state.restartWindow.length >= ALERT_AFTER_RESTARTS && !state.alerted) {
        state.alerted = true
        onDownAlert(state.restartWindow.length).catch((error) =>
          console.error(`[lark-gateway] ${eventKey} down alert failed:`, error.message),
        )
      }
      setTimeout(() => {
        if (!state.stopped) spawnOnce()
      }, delay)
    })
  }

  spawnOnce()

  return {
    isAlive: () => state.child != null && state.child.exitCode === null,
    // 观测快照：health 用来暴露长连接健康度（最近事件时间 / 抖动窗口计数 / 是否已告警 / 退避档位）
    observe: () => ({
      alive: state.child != null && state.child.exitCode === null,
      lastEventAt: state.lastEventAt || null,
      restartsInWindow: state.restartWindow.length,
      alerted: state.alerted,
      backoffAttempts: state.backoffAttempts,
    }),
    stop: () => {
      state.stopped = true
      state.child?.kill('SIGTERM')
    },
  }
}
