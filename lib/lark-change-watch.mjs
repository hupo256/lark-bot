/**
 * 任务变更监听（worker 侧，第 2 批）：一条长轮询 GET /lark/tasks/changes 盯全部在飞任务的取消 / 换代，
 * 替代每个任务每秒 getTask 一次。兜底：task-runner 仍每 30s getTask 一次（变更流断了也不会漏掉结单）。
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export const createChangeWatcher = ({ client, waitMs = 25_000, retryMs = 2_000, log = console } = {}) => {
  const watched = new Map() // taskId -> { epoch, onSuperseded }
  let seq = -1
  let stopped = false
  let loop = null

  // 变更流是追加日志（每次 persist 一条当时的 status / epoch）。worker 空闲时不轮询、游标停住，
  // 下个任务开盯后第一页会带回它自己更早的记录（入库 received / 分类 running 都是 epoch 0）——
  // epoch 只增不减，比领取时小的一律是历史，不算换代（教训 #39：10-19 两条带附件的对接答复开跑 3–10s 被误中止）。
  const isSuperseding = (entry, watcher) => {
    const epoch = entry.epoch ?? 0
    const claimed = watcher.epoch ?? 0
    if (epoch < claimed) return false
    return epoch > claimed || entry.status === 'superseded'
  }
  const dispatch = (entry) => {
    const watcher = watched.get(entry.id)
    if (!watcher) return
    if (isSuperseding(entry, watcher)) {
      watched.delete(entry.id)
      try {
        watcher.onSuperseded(entry)
      } catch (error) {
        log.error?.(`[lark-worker] 变更回调异常：${String(error).slice(0, 120)}`)
      }
    }
  }

  const run = async () => {
    while (!stopped) {
      if (!watched.size) {
        await sleep(500)
        continue
      }
      try {
        const page = await client.watchChanges({ since: seq, waitMs })
        if (typeof page?.seq === 'number') {
          for (const entry of page.changes || []) dispatch(entry)
          seq = page.seq
        }
      } catch (error) {
        log.warn?.(`[lark-worker] 变更流中断，${retryMs}ms 后重连：${String(error?.cause?.code || error?.message || error).slice(0, 120)}`)
        await sleep(retryMs)
      }
    }
  }

  return {
    watch(taskId, epoch, onSuperseded) {
      watched.set(taskId, { epoch: epoch ?? 0, onSuperseded })
      if (!loop) loop = run()
      return () => watched.delete(taskId)
    },
    size: () => watched.size,
    stop() {
      stopped = true
    },
  }
}
