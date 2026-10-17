/**
 * 日报调度（gateway 侧，纯轻量）：到点 / 合盖推迟 / 跨午夜补发的判断 + 把「生成并发日报」建成系统任务交给 worker。
 * 生成本身（git / 探针 / 模型，含 spawnSync）在 lib/lark-daily-report.mjs，只有 worker import 它——
 * 以前日报在 gateway 进程里同步跑，最长能把 HTTP / 长连接 / 轮询冻住好几分钟（升级计划第 1 批）。
 * 发送状态 { [repo]: 'YYYY-MM-DD', [repo:deferred]: 'YYYY-MM-DD' } 仍在 runtime/lark-daily-report/state.json。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { sendBotMarkdown } from './lark-cli.mjs'
import { isReportDay } from './lark-daily-ledger.mjs'
import { writeJsonAtomic } from './lark-fs.mjs'
import { larkRuntimeDir } from './lark-paths.mjs'
import { isLidClosed } from './lark-power.mjs'
import { sendGroupCard } from './lark-repo-delivery.mjs'
import { listRepoProfiles, resolveWebhookCredentials } from './lark-repo-profile.mjs'
import { DAILY_TASK_ACTIVE_STATUSES, buildDailyReportTask, isDailyReportTask } from './lark-system-tasks.mjs'

const pad = (n) => String(n).padStart(2, '0')
export const localDateKey = (date = new Date()) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`

export const dailyReportStatePath = (runtimeDir = larkRuntimeDir) => join(runtimeDir, 'lark-daily-report', 'state.json')
export const readDailyReportState = (runtimeDir) => {
  try {
    const path = dailyReportStatePath(runtimeDir)
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
  } catch {
    return {}
  }
}
// 合盖推迟记在同一个状态文件的 `<repo>:deferred` 键（重启不丢）：调度器据此跨午夜补发，体检据此不报「到点没发」。
export const deferredKey = (key) => `${key}:deferred`
export const markDailyReportDeferred = ({ key, date, runtimeDir }) => {
  const state = readDailyReportState(runtimeDir)
  if (state[deferredKey(key)] === date) return
  writeJsonAtomic(dailyReportStatePath(runtimeDir), { ...state, [deferredKey(key)]: date })
}
export const markDailyReportSent = ({ key, date, runtimeDir }) => {
  const state = { ...readDailyReportState(runtimeDir), [key]: date }
  writeJsonAtomic(dailyReportStatePath(runtimeDir), state)
}

// 群里 @ 机器人要日报：「今天日报发一下」「补发日报」「重发今天的日报」（10-15：这句被当普通任务交给模型，跑挂了没发）。
// 只认短祈使句；「为什么没发日报」这类问话不算。返回 { force }（重发 / 再发 = 已发过也再发）或 null。
export const parseDailyReportDirective = (text) => {
  const t = String(text || '').replace(/@\S+/g, '').replace(/[\s，。,.!！~～]/g, '')
  if (!t || t.length > 20 || !t.includes('日报') || /为什么|怎么|是否|吗|没|？|\?/.test(t)) return null
  const ok = /^(请|帮我|麻烦)?(把)?(今天|今日)?的?(日报)?(发|补发|重发|再发)(一下|下|一份|出来)?(今天|今日)?的?(日报)?吧?$/.test(t)
  return ok ? { force: /重发|再发/.test(t) } : null
}

// 失败后隔多久再补跑（从上次失败结束算，生成本身要 10–25 分钟）、一天最多跑几次（10-15：19:00 那一分钟没跑成，当天日报就丢了）。
export const DAILY_RETRY_GAP_MS = 10 * 60_000
export const DAILY_MAX_ATTEMPTS = 3

// 当前该发哪天的日报。今天是日报日且已到点 → 今天；否则上一个日报日因合盖推迟过（deferredDate）且到点后 24 小时内 → 那天
// （下班合盖时 19:00 还没到，日报推迟到第二天开盖再补，aven 10-17「合盖 bot 下班」）。只补合盖推迟的那天：别的原因
// 失败的（已重试 3 次）第二天不再翻出来。返回 { date, reportNow }，reportNow 为那天的到点时刻（今天则为 now），
// 交给 runDailyReport 定「当天」窗口；都不满足返回 null。
export const dueDailyReport = ({ now, at, days = [1, 2, 3, 4, 5], deferredDate = null }) => {
  const [hour, minute] = at.split(':').map(Number)
  const hhmm = `${pad(now.getHours())}:${pad(now.getMinutes())}`
  if (isReportDay(now, days) && hhmm >= at) return { date: localDateKey(now), reportNow: now }
  for (let back = 1; back <= 7; back += 1) {
    const due = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back, hour, minute)
    if (!isReportDay(due, days)) continue
    const date = localDateKey(due)
    return date === deferredDate && now.getTime() - due.getTime() <= 24 * 60 * 60_000 ? { date, reportNow: due } : null
  }
  return null
}

const dailyTasksFor = (store, profile, date) =>
  (store.list?.() || []).filter((task) => isDailyReportTask(task) && task.repo === profile.key && task.daily?.date === date)
const byUpdated = (a, b) => (String(a.updatedAt || '') < String(b.updatedAt || '') ? -1 : 1)

// 调度：每分钟看一次本地时间，到点且该日还没发成功就建系统任务——错过整点（进程重启 / 合盖）也会补，跨午夜补上一个日报日；
// 合盖时不建（开盖后下一分钟补）；同一日报日同时只有一条在队列 / 在跑；失败后隔 DAILY_RETRY_GAP_MS 再建，每日报日最多
// DAILY_MAX_ATTEMPTS 条，到上限私信负责人一次。发送状态由 gateway 在任务 done 时写（lib/lark-status.mjs）。
export const startDailyReportScheduler = ({ store, deps = {} }) => {
  const targets = listRepoProfiles().filter((profile) => !profile.isDefault && profile.dailyReport?.at)
  const lidClosed = deps.isLidClosed || isLidClosed
  const notify = deps.sendUserMarkdown || sendBotMarkdown
  const warned = new Set()
  let pausedByLid = false
  const tick = async () => {
    const now = deps.now ? deps.now() : new Date()
    const state = readDailyReportState(deps.runtimeDir)
    const due = targets
      .map((profile) => ({ profile, slot: dueDailyReport({ now, at: profile.dailyReport.at, days: profile.dailyReport.days || [1, 2, 3, 4, 5], deferredDate: state[deferredKey(profile.key)] || null }) }))
      .filter(({ profile, slot }) => slot && state[profile.key] !== slot.date)
    if (!due.length) return []
    const closed = await lidClosed()
    if (closed !== pausedByLid) console.log(`[lark-gateway] 日报调度：${closed ? `合盖，${due.map(({ profile, slot }) => `${profile.key} ${slot.date}`).join('、')} 推迟到开盖再发` : '开盖，补发推迟的日报'}`)
    pausedByLid = closed
    if (closed) {
      for (const { profile, slot } of due) markDailyReportDeferred({ key: profile.key, date: slot.date, runtimeDir: deps.runtimeDir })
      return []
    }
    const created = []
    for (const { profile, slot } of due) {
      const existing = dailyTasksFor(store, profile, slot.date)
      if (existing.some((task) => DAILY_TASK_ACTIVE_STATUSES.has(task.status))) continue
      const failed = existing.filter((task) => task.status === 'failed').sort(byUpdated)
      if (failed.length >= DAILY_MAX_ATTEMPTS) {
        const key = `${profile.key}:${slot.date}`
        if (!warned.has(key)) {
          warned.add(key)
          const owner = profile.dailyReport?.to || profile.notifyChatId
          if (owner) await notify({ chatId: owner, markdown: `${slot.date} 的日报跑了 ${failed.length} 次都没发出去（最近一次：${String(failed.at(-1)?.result || '').slice(0, 160)}）。要再试就在群里说「重发日报」。` }).catch(() => null)
        }
        continue
      }
      const last = failed.at(-1)
      if (last && now.getTime() - Date.parse(last.updatedAt || 0) < DAILY_RETRY_GAP_MS) continue
      const task = store.upsert(buildDailyReportTask({ profile, date: slot.date, reportNow: slot.reportNow, attempt: existing.length + 1, now }))
      created.push(task)
      console.log(`[lark-gateway] 日报任务已建：${task.id}（${slot.date}${slot.reportNow === now ? '' : '，补发'}）`)
    }
    return created
  }
  const timer = (deps.setInterval || setInterval)(() => { tick().catch(() => {}) }, 60_000)
  timer.unref?.()
  for (const profile of targets) console.log(`[lark-gateway] 日报调度：${profile.key} ${(profile.dailyReport.days || [1, 2, 3, 4, 5]).join('') === '12345' ? '工作日' : `星期 ${(profile.dailyReport.days || []).join(',')}`} ${profile.dailyReport.at} 起（错过补发，由 worker 生成）→ ${profile.dailyReport.to || profile.notifyChatId || '群'}`)
  return { targets: targets.map((profile) => profile.key), tick, stop: () => clearInterval(timer) }
}

// 群里触发：先回一句，再建系统任务（同定时链路）；失败时 gateway 在任务 failed 回写里私信负责人。
export const triggerDailyReportFromChat = async ({ store, profile, chatId, operator = null, force = false, deps = {} }) => {
  const now = deps.now ? deps.now() : new Date()
  const today = localDateKey(now)
  const webhook = (deps.webhookFor || resolveWebhookCredentials)(profile, chatId)
  const say = (body) => (webhook
    ? (deps.sendGroupCard || sendGroupCard)({ webhook, chatId, phase: 'daily_report_request', body, to: operator, logPrefix: `daily report request ${profile.key}` })
    : Promise.resolve({ ok: false, skipped: true }))
  const existing = dailyTasksFor(store, profile, today)
  if (existing.some((task) => DAILY_TASK_ACTIVE_STATUSES.has(task.status))) {
    await say('今天的日报正在生成，好了直接发到群里。')
    return { started: false, reason: 'running' }
  }
  if (!force && readDailyReportState(deps.runtimeDir)[profile.key] === today) {
    await say('今天的日报已经发过了；要再发一份就说「重发日报」。')
    return { started: false, reason: 'sent' }
  }
  await say('收到，现在生成今天的日报，大约 20 分钟后发到群里。')
  const task = store.upsert(buildDailyReportTask({ profile, date: today, reportNow: now, attempt: existing.length + 1, force: true, requestChatId: chatId, requestedBy: operator, now }))
  return { started: true, reason: null, taskId: task.id }
}
