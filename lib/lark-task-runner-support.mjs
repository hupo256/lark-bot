/**
 * 单任务生命周期的辅助（从 lark-task-runner 拆出，10-21 架构加固 P0）：负责人名单、项目记忆软链、
 * 执行作废检测、任务预算、租约心跳。都不依赖 createTaskRunner 的闭包。
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { defaultTaskLeaseMs } from './lark-constants.mjs'
import { parseFeatureTable } from './lark-daily-report.mjs'

// 协作式取消检测（纯函数，可直测）：一次**已领取的 running 执行**是否已被作废——
//   · 人工结单落 superseded（控制通道 close）；
//   · 换代（epoch 变了：retry / resume / 孤儿回收 / 优雅退出释放都会 epoch++），本次执行已是旧代。
// 两种都意味着「本次执行的产物不该再落地」。current 读不到（网关瞬时不可达）时**不误判取消**——
// 返回 false 继续执行，最终仍有 epoch/409 回写兜底，宁可多跑一趟也不误弃一条正常任务。

// 功能总表上的前端负责人名单（名字 → 功能数），用于在结论文字里认人。
export const ownerTableFor = (profile) => {
  const table = profile?.ownership?.table
  if (!table) return {}
  try {
    const out = {}
    for (const row of parseFeatureTable(readFileSync(table, 'utf8'))) if (row.owner) out[row.owner] = (out[row.owner] || 0) + 1
    return out
  } catch {
    return {}
  }
}

// Claude Code 把 cwd 映射成 ~/.claude/projects/<cwd 里的 / 和 . 都换成 ->；把该目录下的 memory 软链到主仓的 memory，
// 让 bot 的 claude -p 和负责人交互会话读同一份项目记忆。已有真实目录（非软链）时不动。
export const claudeProjectKey = (cwd) => String(cwd).replace(/[/.]/g, '-')
export const ensureSharedClaudeMemory = ({ cwd, memoryDir, claudeHome = join(homedir(), '.claude') }) => {
  if (!cwd || !memoryDir || !existsSync(memoryDir)) return { ok: false, reason: 'no memory dir' }
  const projectDir = join(claudeHome, 'projects', claudeProjectKey(cwd))
  const target = join(projectDir, 'memory')
  try {
    mkdirSync(projectDir, { recursive: true })
    if (existsSync(target) || lstatSync(target, { throwIfNoEntry: false })) {
      const stat = lstatSync(target)
      if (stat.isSymbolicLink()) return { ok: true, linked: false, reason: 'already linked' }
      return { ok: false, reason: 'real memory dir exists' }
    }
    symlinkSync(memoryDir, target, 'dir')
    return { ok: true, linked: true }
  } catch (error) {
    return { ok: false, reason: String(error?.message || error).slice(0, 120) }
  }
}

export const isExecutionSuperseded = ({ current, claimedEpoch } = {}) => {
  if (!current) return false
  if (current.status === 'superseded') return true
  return (current.epoch ?? 0) !== (claimedEpoch ?? 0)
}

/** Poll the Gateway while AI is running and abort this execution as soon as its epoch is superseded. */
export const monitorExecutionCancellation = ({ getTask, taskId, claimedEpoch, controller, intervalMs = 1000, onSuperseded }) => {
  let checking = false
  const check = async () => {
    if (checking || controller.signal.aborted) return
    checking = true
    try {
      const current = await getTask(taskId).catch(() => null)
      if (isExecutionSuperseded({ current, claimedEpoch })) {
        onSuperseded?.(current)
        controller.abort(new Error(`task ${taskId} was superseded during AI execution`))
      }
    } finally {
      checking = false
    }
  }
  const timer = setInterval(check, Math.max(50, intervalMs))
  timer.unref?.()
  return () => clearInterval(timer)
}

export const DEFAULT_TASK_BUDGET_MS = Number(process.env.LARK_TASK_BUDGET_MS || 150 * 60_000)
export const LEASE_HEARTBEAT_DIVISOR = 3

// 剩余预算：从领取时刻起算，任务可自带 taskBudgetMs；已超预算也给 60s 把失败写回去。
export const remainingTaskBudgetMs = (task, now = Date.now()) => {
  const budget = Number(task?.taskBudgetMs) > 0 ? Number(task.taskBudgetMs) : DEFAULT_TASK_BUDGET_MS
  const claimedAt = task?.claimedAt ? Date.parse(task.claimedAt) : now
  const elapsed = Number.isFinite(claimedAt) ? Math.max(0, now - claimedAt) : 0
  return Math.max(60_000, budget - elapsed)
}

// 退出型中断（SIGTERM / 任务被取消）：任务已交还队列，不写 failed；截止时间到（TimeoutError）要写 failed。
export const isShutdownAbort = (signal) => Boolean(signal?.aborted) && signal.reason?.name !== 'TimeoutError'

// 每 leaseMs/3 续一次租约；gateway 回 409（epoch 变了）就停，不再替已作废的执行续命。
export const startLeaseHeartbeat = ({ client, task, leaseMs = defaultTaskLeaseMs, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval }) => {
  if (!client?.heartbeatTask || !task?.id) return () => {}
  const intervalMs = Math.max(30_000, Math.floor(leaseMs / LEASE_HEARTBEAT_DIVISOR))
  let stopped = false
  const timer = setIntervalImpl(async () => {
    if (stopped) return
    try {
      const outcome = await client.heartbeatTask(task.id, task.epoch)
      if (outcome && outcome.ok === false) {
        console.warn(`[lark-worker] ${task.id} 续租被拒（${outcome.error || outcome.code}），停止心跳`)
        stopped = true
        clearIntervalImpl(timer)
      }
    } catch (error) {
      console.warn(`[lark-worker] ${task.id} 续租失败（下次再试）：${String(error?.message || error).slice(0, 120)}`)
    }
  }, intervalMs)
  timer.unref?.()
  return () => {
    stopped = true
    clearIntervalImpl(timer)
  }
}
