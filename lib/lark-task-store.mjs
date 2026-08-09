/**
 * 任务存储：文件队列 + 内存索引。启动恢复未完成任务、领取时回收租约过期的孤儿 running 任务。
 * 逻辑集中在此，便于单测（`node --test`）覆盖租约回收与优先级排序。
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// 孤儿自动重入队上限：crash 型毒任务（每次都让 worker/AI 崩）会绕过「failed 需人工 retry」闭环
// 被无限 reclaim→领取→再崩，无限烧钱。达上限即转 failed（死信），停止自动重投，交人工。
const maxRequeue = Number(process.env.LARK_MAX_REQUEUE || 2)
// 人工 retry 上限（人在环里，主要防误触发的连环重跑；给得比自动 requeue 宽松）。
const maxRetry = Number(process.env.LARK_MAX_RETRY || 5)

export const createTaskStore = ({ tasksDir, leaseMs, onDeadLetter } = {}) => {
  mkdirSync(tasksDir, { recursive: true })
  const tasks = new Map()

  // 启动时恢复未完成任务。解析失败的文件改名为 .corrupt 并告警，不静默跳过——
  // persist 崩溃中断会截断出非法 JSON，静默 continue 会让该任务从恢复集里彻底消失（静默丢单）。
  for (const file of readdirSync(tasksDir)) {
    if (!file.endsWith('.json')) continue
    const full = join(tasksDir, file)
    try {
      const task = JSON.parse(readFileSync(full, 'utf8'))
      tasks.set(task.id, task)
    } catch (error) {
      const corruptPath = `${full}.corrupt`
      try {
        renameSync(full, corruptPath)
      } catch {
        // 改名失败也不阻塞启动，但下面的告警仍会打
      }
      console.warn(`[lark-gateway] ⚠ 任务文件损坏，已隔离为 ${file}.corrupt（需人工排查是否丢单）：${String(error).slice(0, 120)}`)
    }
  }

  // 原子写：先写同目录 .tmp 再 rename（同文件系统 rename 是原子替换），
  // 避免进程在写一半时被 kill/断电，把唯一副本截断成非法 JSON。
  const persist = (task) => {
    const target = join(tasksDir, `${task.id}.json`)
    const tmp = `${target}.tmp`
    writeFileSync(tmp, JSON.stringify(task, null, 2))
    renameSync(tmp, target)
  }

  const removeFile = (id) => {
    try {
      unlinkSync(join(tasksDir, `${id}.json`))
    } catch {
      // 文件可能已被清理，忽略
    }
  }

  const isOrphan = (task, now) =>
    task.status === 'running' && task.claimedAt && now - new Date(task.claimedAt).getTime() > leaseMs

  // 把任务重置回可领取态（queued）并递增 epoch（fencing token）：挡掉被作废的旧执行
  //（租约回收 / 人工 retry / 补料续跑 / 优雅退出释放）迟到回写覆盖新一代执行的状态。
  // 只做「回队 + 换代」的公共部分；各调用方按需再叠加自己的计数（requeueCount/retryCount/resumeCount）与持久化。
  const requeueTask = (task, now = Date.now()) => {
    task.status = 'queued'
    task.claimedAt = null
    task.requeuedAt = new Date(now).toISOString()
    task.epoch = (task.epoch || 0) + 1
    task.updatedAt = task.requeuedAt
  }

  // 回收租约过期的孤儿 running 任务（worker 崩溃/被杀后任务不会永卡 running），重新入队待领取。
  // 达 maxRequeue 上限的任务判定为毒任务（每次都让 worker/AI 崩），转 failed 死信、停止自动重投，
  // 交人工 —— 否则会无限 reclaim→领取→再崩、无限烧钱。
  const reclaimOrphans = () => {
    const now = Date.now()
    for (const task of tasks.values()) {
      if (!isOrphan(task, now)) continue
      if ((task.requeueCount || 0) >= maxRequeue) {
        task.status = 'failed'
        task.claimedAt = null
        task.deadLetterReason = `孤儿重入队达上限（${maxRequeue} 次仍未跑完），判定为毒任务，停止自动重投，需人工排查后 retry`
        task.updatedAt = new Date(now).toISOString()
        persist(task)
        console.warn(`[lark-gateway] 孤儿任务 ${task.id} 达重投上限，转 failed 死信：${task.deadLetterReason}`)
        try {
          onDeadLetter?.(task)
        } catch (error) {
          console.error(`[lark-gateway] onDeadLetter 回调异常：${String(error).slice(0, 120)}`)
        }
        continue
      }
      requeueTask(task, now)
      task.requeueCount = (task.requeueCount || 0) + 1
      persist(task)
      console.warn(`[lark-gateway] 租约过期，重新入队孤儿任务 ${task.id}（第 ${task.requeueCount} 次，epoch=${task.epoch}）`)
    }
  }

  return {
    has: (id) => tasks.has(id),
    get: (id) => tasks.get(id),
    list: () => [...tasks.values()],
    upsert(task) {
      task.updatedAt = new Date().toISOString()
      tasks.set(task.id, task)
      persist(task)
      return task
    },
    // 人工重触发：把失败/阻塞的任务重置为待领取，worker 下一轮重新执行。
    // 群 @ 任务本可直接重新 @（新 messageId 天然是新任务）；bug 表任务 id=record_id 固定，
    // POST 幂等会命中旧 failed，只能靠这里显式重置，否则永远重跑不了。
    retry(id) {
      const task = tasks.get(id)
      if (!task || (task.status !== 'failed' && task.status !== 'blocked')) return null
      // 人工 retry 上限：主要防误触发的连环重跑。达上限返回带原因的信号，交调用方提示人工 clean。
      if ((task.retryCount || 0) >= maxRetry) {
        return { task: null, reason: `已达人工重试上限（${maxRetry} 次），请人工排查根因后 clean 再重建，或调高 LARK_MAX_RETRY` }
      }
      requeueTask(task)
      task.retryCount = (task.retryCount || 0) + 1
      persist(task)
      return task
    },
    // worker 优雅退出（收到 SIGTERM）时把它正在跑、尚未回写终态的 running 任务交还队列，
    // 让重启后的 worker 立刻重领，而不必空等 40min 租约过期。不计入 retry/requeue 上限
    //（正常运维重启不该把任务推向死信）；epoch++ 挡掉被中断执行的迟到回写。
    releaseRunning(id) {
      const task = tasks.get(id)
      if (!task || task.status !== 'running') return null
      requeueTask(task)
      persist(task)
      return task
    },
    // waiting_confirmation / blocked 续任务：用户补料后复用**原任务**继续跑（而非新建孤儿任务）。
    // 把补料 append 到原 task.text 并重置为 queued；因复用同一 task.id，resolveWorkContext 会算出
    // 同一 hotfix 分支/worktree，天然复用原执行现场。bump epoch 挡掉旧执行残留 worker 的迟到回写。
    resumeWithSupplement({ id, supplementText = '', supplementAttachments = [] } = {}) {
      const task = tasks.get(id)
      if (!task || (task.status !== 'waiting_confirmation' && task.status !== 'blocked')) return null
      const supplement = String(supplementText || '').trim()
      if (supplement) {
        task.text = `${task.text || ''}\n\n【补料】\n${supplement}`.trim()
        task.summary = task.summary || supplement.slice(0, 80)
      }
      if (supplementAttachments.length) {
        task.attachments = [...(task.attachments || []), ...supplementAttachments]
      }
      requeueTask(task)
      task.resumeCount = (task.resumeCount || 0) + 1
      persist(task)
      return task
    },
    // 让 /lark/health 计数不再单调增长。返回被删除的 id 列表。
    // 注意：清 failed 会让 bug 表对应记录（若仍待处理）在 poller 下一轮被当新任务重投，
    // 等于变相自动重试，故 failed 默认保留、交由人工 retry/clear 处置。
    pruneTerminal({ olderThanMs = 0, statuses = ['done'] } = {}) {
      const cutoff = Date.now() - olderThanMs
      const removed = []
      for (const task of [...tasks.values()]) {
        if (!statuses.includes(task.status)) continue
        const ts = new Date(task.updatedAt || task.createdAt).getTime()
        if (Number.isFinite(ts) && ts > cutoff) continue
        tasks.delete(task.id)
        removeFile(task.id)
        removed.push(task.id)
      }
      return removed
    },
    // 领取一个 pending 任务并置为 running（盖 claimedAt 作租约）。
    // 领取前先回收租约过期的孤儿 running 任务（worker 崩溃/被杀后任务不会永卡 running）。
    claimNext() {
      reclaimOrphans()
      const pending = [...tasks.values()]
        .filter((task) => task.status === 'queued' || task.status === 'received')
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))[0]
      if (!pending) return null
      pending.status = 'running'
      pending.claimedAt = new Date(Date.now()).toISOString()
      pending.epoch = pending.epoch || 0 // fencing token 基线，worker 回写时须带上
      persist(pending)
      return pending
    },
    // 按 id 原子领取（并行调度器用）：先回收孤儿，再仅当该任务处于可领取态时置 running。
    // 已被并发领走 / 状态已变 → 返回 null，调用方跳过。
    claimById(id) {
      reclaimOrphans()
      const task = tasks.get(id)
      if (!task || (task.status !== 'queued' && task.status !== 'received')) return null
      task.status = 'running'
      task.claimedAt = new Date(Date.now()).toISOString()
      task.epoch = task.epoch || 0 // fencing token 基线，worker 回写时须带上
      persist(task)
      return task
    },
    // 健康检查用：各状态计数 + 卡住任务 + 队列年龄 / 租约余量 / requeue·retry Top / 死信数
    stats() {
      const now = Date.now()
      const byStatus = {}
      const stuck = []
      let oldestQueuedAgeMs = 0 // 最老 pending 的排队时长（积压信号）
      let minLeaseRemainingMs = null // 所有 running 里离租约到期最近的余量（负=已超期=孤儿）
      let deadLetters = 0 // 已转 failed 的死信（deadLetterReason 存在）
      const requeued = [] // 有 requeueCount/retryCount 的任务，供暴露 Top
      for (const task of tasks.values()) {
        byStatus[task.status] = (byStatus[task.status] || 0) + 1
        if (isOrphan(task, now)) stuck.push(task.id)
        if (task.deadLetterReason) deadLetters += 1
        if (task.requeueCount || task.retryCount) {
          requeued.push({ id: task.id, requeueCount: task.requeueCount || 0, retryCount: task.retryCount || 0 })
        }
        if (task.status === 'queued' || task.status === 'received') {
          const age = now - new Date(task.createdAt || now).getTime()
          if (Number.isFinite(age) && age > oldestQueuedAgeMs) oldestQueuedAgeMs = age
        }
        if (task.status === 'running' && task.claimedAt) {
          const remaining = leaseMs - (now - new Date(task.claimedAt).getTime())
          if (minLeaseRemainingMs === null || remaining < minLeaseRemainingMs) minLeaseRemainingMs = remaining
        }
      }
      const topRequeued = requeued
        .sort((a, b) => b.requeueCount + b.retryCount - (a.requeueCount + a.retryCount))
        .slice(0, 5)
      return { counts: byStatus, stuck, oldestQueuedAgeMs, minLeaseRemainingMs, deadLetters, topRequeued }
    },
  }
}
