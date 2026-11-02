/**
 * fameex 日报的调度（gateway 侧，纯轻量，aven 11-02「fameex 日报的先私发我」）：到点 / 跨午夜补发 / 失败隔 10 分钟重试的判断，
 * 以及负责人私信「发日报 / 重发日报」——都只是把「生成并私发日报」建成一条系统任务（commandType=daily）交给 worker。
 * 生成本身（git / bug 表 / 任务库）在 lib/lark-daily-report.mjs，只有 worker import 它（gateway 纯度闸）。思路取自 falive
 * lark-daily-schedule.mjs，去掉功能总表 / 台账 / 群投递；现在只私发 config.notifyOpenId，不发任何群。
 *
 * 发送记账 runtime/lark-daily-report-state.json：{ sent: { 'YYYY-MM-DD': { at, messageId } }, bugSnapshots: { 'YYYY-MM-DD': {...} } }，
 * 只由 worker 写（发出去之后才记），gateway 只读——同一天重试 / 重启不重发。
 * 合盖：Mac 睡着时定时器不走，开盖后第一次 tick 若上一个日报日到点不满 24h 且没发，就补发那天的（内容按那天算）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { larkRuntimeDir } from './lark-paths.mjs'
import { isPrincipal } from './lark-principal-channel.mjs'

export const DAILY_COMMAND_TYPE = 'daily'
export const DAILY_MAX_ATTEMPTS = 3
export const DAILY_RETRY_GAP_MS = 10 * 60_000
const DAY_MS = 24 * 60 * 60_000
const DEFAULT_AT = '19:00'
const DEFAULT_DAYS = [1, 2, 3, 4, 5]

export const dailyStatePath = () => join(larkRuntimeDir, 'lark-daily-report-state.json')
export const readDailyState = (path = dailyStatePath()) => {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) || {} : {}
  } catch {
    return {}
  }
}

// 配置缺省：开、19:00、周一到周五（形状由 lark-config validateConfig 把关）。
export const dailySettings = (config) => {
  const raw = config?.dailyReport || {}
  return { enabled: raw.enabled !== false, at: raw.at || DEFAULT_AT, days: raw.days || DEFAULT_DAYS }
}

// 本地日期 YYYY-MM-DD；本地 HH:MM 落在某天的毫秒数；某天是周几。
export const localDateKey = (ms) => new Date(ms).toLocaleDateString('sv-SE')
const parts = (date) => date.split('-').map(Number)
export const localTimeOn = (date, hhmm) => {
  const [y, m, d] = parts(date)
  const [hh, mm] = hhmm.split(':').map(Number)
  return new Date(y, m - 1, d, hh, mm).getTime()
}
export const weekdayOf = (date) => {
  const [y, m, d] = parts(date)
  return new Date(y, m - 1, d).getDay()
}

// 现在该发哪天的日报：今天或昨天里「是日报日、已到点、到点不满 24h」的那天（今天 19:00 后 → 今天；开盖在第二天 19:00 前 → 补昨天）。
// 更早的日报日到点都已超过 24h（到点时刻每天相同），不再翻出来。没有返回 null。
export const dueReportDate = ({ settings, now }) => {
  for (const date of [localDateKey(now), localDateKey(now - DAY_MS)]) {
    const due = localTimeOn(date, settings.at)
    if (settings.days.includes(weekdayOf(date)) && due <= now && now - due < DAY_MS) return date
  }
  return null
}

// 这一分钟要不要建定时日报任务：没开 / 没到点 / 那天已发 / 那天已有在跑或已了结的一次 / 失败满 3 次 / 上次失败不满 10 分钟 → null。
export const decideDailyRun = ({ config, state = {}, tasks = [], now = Date.now() }) => {
  const settings = dailySettings(config)
  if (!settings.enabled) return null
  const date = dueReportDate({ settings, now })
  if (!date || state.sent?.[date]) return null
  const runs = tasks.filter((task) => task.commandType === DAILY_COMMAND_TYPE && task.daily?.mode === 'scheduled' && task.daily.date === date)
  if (runs.some((task) => task.status !== 'failed') || runs.length >= DAILY_MAX_ATTEMPTS) return null
  const lastTry = Math.max(0, ...runs.map((task) => Date.parse(task.updatedAt || '') || 0))
  if (now - lastTry < DAILY_RETRY_GAP_MS) return null
  return { date, attempt: runs.length + 1 }
}

// 日报系统任务：私信形态（chatType=p2p，开始 / 结论都不另发通知），契约 deliverable=daily（出口不说话，worker 自己发日报）。
// mode：scheduled 定时 / manual「发日报」/ force「重发日报」。私信触发的用消息 id 当任务 id（同一条事件投两次不建两条）。
export const buildDailyTask = ({ config, date, mode, attempt = null, msg = null, now = Date.now() }) => ({
  id: msg?.messageId || `daily-${date.replaceAll('-', '')}-a${attempt}`,
  source: 'system',
  chatId: msg?.chatId || config.notifyOpenId,
  chatType: 'p2p',
  messageId: msg?.messageId || null,
  operator: config.notifyOpenId,
  project: null,
  commandType: DAILY_COMMAND_TYPE,
  commandTypeSource: 'explicit',
  text: `日报 ${date}（${mode}）`,
  summary: `日报 ${date}`,
  attachments: [],
  addressedToBot: true,
  fromPrincipal: true,
  status: 'queued',
  intake: null,
  contract: { deliverable: DAILY_COMMAND_TYPE, source: DAILY_COMMAND_TYPE },
  daily: { date, mode, attempt },
  createdAt: new Date(now).toISOString(),
})

// 负责人私信里的短句，只认整句（问「日报怎么没发」不算）：发日报 / 补发日报 → manual；重发日报 / 再发日报 → force。
export const parseDailyDirective = (text) => {
  const bare = String(text || '').replace(/[\s。.!！~～]/g, '')
  if (/^(?:发|补发)日报$/.test(bare)) return { mode: 'manual' }
  if (/^(?:重发|再发)日报$/.test(bare)) return { mode: 'force' }
  return null
}

// ingest 在分类之前调：只认负责人本人私信。认出来就建今天的日报任务，返回 true（不再往下走分类）。
export const maybeHandleDailyDirective = async ({ msg, config, store, now = Date.now() }) => {
  if (msg.chatType !== 'p2p' || !isPrincipal(config, msg.senderOpenId)) return false
  const directive = parseDailyDirective(msg.text)
  if (!directive) return false
  const task = store.upsert(buildDailyTask({ config, date: localDateKey(now), mode: directive.mode, msg, now }))
  console.log(`[lark-gateway] 负责人要日报（${directive.mode}）：排队 ${task.id}`)
  return true
}

// 每分钟看一眼该不该建定时日报任务（建了就交给 worker）。dailyReport.enabled=false 时只关定时，私信「发日报」照样能要。
export const startDailyReport = ({ config, store, readState = readDailyState, intervalMs = 60_000, clock = Date.now }) => {
  const tick = () => {
    const run = decideDailyRun({ config, state: readState(), tasks: store.list(), now: clock() })
    if (!run) return null
    const task = store.upsert(buildDailyTask({ config, date: run.date, mode: 'scheduled', attempt: run.attempt, now: clock() }))
    console.log(`[lark-gateway] 到点建日报任务 ${task.id}（${run.date} 第 ${run.attempt} 次）`)
    return task
  }
  const timer = setInterval(tick, intervalMs)
  timer.unref?.()
  return { stop: () => clearInterval(timer), tick }
}
