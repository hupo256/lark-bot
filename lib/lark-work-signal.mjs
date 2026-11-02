/**
 * gateway → worker「有活了」信号（aven 11-02）。原来 worker 每 5 秒轮询一次 /lark/tasks，新消息平均白等 2.5 秒才开始分类，
 * 分类完重新入队后又要再等一轮才开工。现在：
 *   gateway：任务库每次把任务写成可领取（queued / received）就 bump()，序号 +1、唤醒挂着的等待；
 *   worker：主循环的「睡 pollMs」换成 waitForWork——带上次见过的序号去长轮询 GET /lark/work/wait，有新序号立刻返回；
 *           本地在飞任务跑完 / 自修结束也会 wake()（同 worktree 排队的下一条不用再等一轮）。
 * pollMs 仍是等待上限：intake 重试的 notBefore 到点、排空 tick、自修启动这些按时间走的事不受影响；gateway 旧版本 / 连不上时
 * 退回纯 sleep。纯 JS（无 IO），gateway 与 worker 共用。
 */

// gateway 侧：单调序号 + 挂起的等待者。since 与当前序号不同就立即返回（since 更大 = gateway 重启过，序号从 0 重来）。
export const createWorkSignal = () => {
  let seq = 0
  const waiters = new Set()
  const bump = () => {
    seq += 1
    for (const resolve of [...waiters]) resolve()
    waiters.clear()
    return seq
  }
  const wait = ({ since = null, timeoutMs = 0, onCancel = null } = {}) => {
    const sinceNum = since == null || since === '' ? NaN : Number(since)
    if (!Number.isFinite(sinceNum) || sinceNum !== seq || !(timeoutMs > 0)) return Promise.resolve({ seq, woke: sinceNum !== seq })
    return new Promise((resolve) => {
      let timer = null
      const done = (woke) => {
        clearTimeout(timer)
        waiters.delete(onWake)
        resolve({ seq, woke })
      }
      const onWake = () => done(true)
      timer = setTimeout(() => done(false), timeoutMs)
      timer.unref?.()
      waiters.add(onWake)
      // 客户端断开（worker 本地先被唤醒、abort 了长轮询）：摘掉等待者，不积压。
      onCancel?.(() => done(false))
    })
  }
  return { bump, wait, seq: () => seq, waiting: () => waiters.size }
}

// 长轮询单次上限：gateway 侧再夹一道，防止客户端传个超大值把连接挂住。
export const MAX_WORK_WAIT_MS = 60_000
export const clampWaitMs = (value, fallback = 5_000) => {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return Math.min(fallback, MAX_WORK_WAIT_MS)
  return Math.min(Math.round(n), MAX_WORK_WAIT_MS)
}

// worker 侧：本地唤醒器（在飞任务结束时 wake），和远端长轮询赛跑，谁先到算谁；输的一方被取消。
// remoteWait({ since, timeoutMs, signal }) → { seq }；抛错（旧 gateway 404 / 连不上）就只靠本地唤醒 + 超时。
export const createWorkWaiter = ({ remoteWait = null, sleepMs = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
}) } = {}) => {
  let lastSeq = null
  let localWake = null
  let pendingWake = false
  let remoteBroken = false
  const wake = () => {
    if (localWake) localWake()
    else pendingWake = true
  }
  const wait = async (timeoutMs) => {
    if (pendingWake) {
      pendingWake = false
      return 'local'
    }
    const controller = new AbortController()
    const local = new Promise((resolve) => { localWake = () => resolve('local') })
    const timeout = sleepMs(timeoutMs, controller.signal).then(() => 'timeout')
    const remote = remoteWait && !remoteBroken
      ? remoteWait({ since: lastSeq, timeoutMs, signal: controller.signal }).then(
        (out) => {
          const changed = lastSeq !== null && out?.seq !== lastSeq
          lastSeq = out?.seq ?? lastSeq
          // 首次（lastSeq 未知）只是对时，不算有活；继续等本地 / 超时。
          return changed ? 'remote' : new Promise(() => {})
        },
        (error) => {
          // 只有「没这个接口」（旧 gateway）才停用远端；连不上 / 重启中这类瞬时错误下一轮照样再试，本轮靠超时兜底。
          if (/\b404\b/.test(String(error?.message || error))) remoteBroken = true
          return new Promise(() => {})
        },
      )
      : new Promise(() => {})
    try {
      return await Promise.race([local, timeout, remote])
    } finally {
      localWake = null
      controller.abort()
    }
  }
  // 远端是旧 gateway（404）就不再长轮询，退回纯 sleep；worker 重启后重新探。
  return { wait, wake, lastSeq: () => lastSeq, remoteBroken: () => remoteBroken }
}
