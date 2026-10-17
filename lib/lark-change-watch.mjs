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

  const dispatch = (entry) => {
    const watcher = watched.get(entry.id)
    if (!watcher) return
    if (entry.status === 'superseded' || (entry.epoch ?? 0) !== (watcher.epoch ?? 0)) {
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
