/**
 * 系统任务（第 1 批）：gateway 不再在进程里跑重活，日报这类要 git / 探针 / 模型的活建成普通任务交给 worker。
 * 任务形状与群消息任务一致（走同一条领取 / 租约 / 回写链路），只是 source 不同、不经意图分类、不发卡不回群：
 *   · daily-report：worker 调 runDailyReport 生成并发群，done 时带 payload（date / doc），gateway 记状态并排清扫。
 * commandType 'status' 让 resolveWorkContext 走只读路径（cwd = 主仓，不建 worktree）。
 */

import { defaultTaskLeaseMs } from './lark-constants.mjs'

// 日报租约下限（生成 10–25 分钟）。worker 续租间隔 = 默认租约 / 3（lib/lark-task-runner.mjs startLeaseHeartbeat，不看任务自带的 leaseMs），
// 所以任务租约不能比默认租约短：原来写死 40min，生产默认 75min → 续租间隔 25min，一次续租失败就过期被判孤儿，
// 第二个 worker 并发生成、重复群发（aven 2026-10-20 review）。取 max(默认租约, 下限)，至少容忍连续两次续租失败。
export const DAILY_LEASE_FLOOR_MS = 40 * 60_000
export const dailyReportLeaseMs = (defaultLeaseMs = defaultTaskLeaseMs) => Math.max(Number(defaultLeaseMs) || 0, DAILY_LEASE_FLOOR_MS)

export const DAILY_REPORT_SOURCE = 'daily-report'
export const SYSTEM_SOURCES = new Set([DAILY_REPORT_SOURCE])
export const isSystemTask = (task) => SYSTEM_SOURCES.has(task?.source)
export const isDailyReportTask = (task) => task?.source === DAILY_REPORT_SOURCE
export const DAILY_TASK_ACTIVE_STATUSES = new Set(['queued', 'running'])

export const dailyReportTaskId = (repoKey, date, attempt = 1) => `daily-${repoKey}-${date}${attempt > 1 ? `-r${attempt}` : ''}`

export const buildDailyReportTask = ({ profile, date, reportNow, attempt = 1, force = false, requestChatId = null, requestedBy = null, now = new Date(), defaultLeaseMs = defaultTaskLeaseMs }) => {
  const createdAt = now.toISOString()
  return {
    id: dailyReportTaskId(profile.key, date, attempt),
    source: DAILY_REPORT_SOURCE,
    repo: profile.key,
    project: profile.projectKey || null,
    projectTitle: profile.title || profile.key,
    chatId: profile.notifyChatId || null,
    operator: requestedBy,
    status: 'queued',
    createdAt,
    updatedAt: createdAt,
    text: `生成 ${profile.title || profile.key} ${date} 的日报并发出（第 ${attempt} 次${force ? '，群里要求' : ''}）`,
    summary: `日报 ${date}`,
    commandType: 'status',
    commandTypeSource: 'system',
    aiExecutor: 'claude',
    attachments: [],
    // 生成 10–25 分钟：租约与预算都给足，不被孤儿回收（租约见 dailyReportLeaseMs）。
    leaseMs: dailyReportLeaseMs(defaultLeaseMs),
    taskBudgetMs: 45 * 60_000,
    daily: { date, reportNow: (reportNow instanceof Date ? reportNow : new Date(reportNow || now)).toISOString(), attempt, force, requestChatId, requestedBy },
  }
}
