/**
 * worker 侧执行系统任务（lib/lark-system-tasks.mjs）：不经意图分类 / 分析 / 规范闸，直接跑对应的确定性链路，
 * 结果以普通 status 回写（done 带 payload），发卡 / 回群 / 记状态由 gateway 的 handleStatusUpdate 按 source 分派。
 */

import { runDailyReport } from './lark-daily-report.mjs'
import { repoProfileForTask } from './lark-repo-profile.mjs'
import { isDailyReportTask } from './lark-system-tasks.mjs'

export const runSystemTask = async ({ task, client, workerConfig, reportStatus, deps = {} }) => {
  if (isDailyReportTask(task)) {
    const profile = repoProfileForTask(task)
    // 日报要看「疑似任务」等队列状态：worker 没有 store，拉一次任务列表做只读 shim（collectDailyFacts 只用 listSuspected）。
    const tasks = await client.listTasks().catch(() => [])
    const storeShim = {
      list: () => tasks,
      get: (id) => tasks.find((item) => item.id === id),
      listSuspected: () => tasks.filter((item) => item.status === 'waiting_confirmation' && item.suspected),
    }
    const reportNow = task.daily?.reportNow ? new Date(task.daily.reportNow) : new Date()
    console.log(`[lark-worker] ${task.id} 生成日报 ${task.daily?.date || ''}（第 ${task.daily?.attempt || 1} 次）`)
    let outcome
    try {
      outcome = await (deps.runDailyReport || runDailyReport)({ config: workerConfig.localConfig, store: storeShim, profile, now: reportNow })
    } catch (error) {
      outcome = { ok: false, reason: String(error?.message || error).slice(0, 200) }
    }
    if (outcome?.ok) {
      await reportStatus('done', `日报已发到 ${outcome.to}`, 'claude', undefined, undefined, {
        payload: { date: outcome.date, doc: outcome.doc || null, to: outcome.to, reportPath: outcome.reportPath || null },
      })
    } else {
      await reportStatus('failed', `日报没发出去：${outcome?.reason || '未知原因'}`, 'claude')
    }
    return outcome
  }
  await reportStatus('failed', `未知的系统任务类型：${task.source}`)
  return { ok: false, reason: `unknown system task ${task.source}` }
}
