/**
 * fameex 日报的调度（gateway 侧，纯轻量，aven 11-02「fameex 日报的先私发我」）：到点 / 跨午夜补发 / 失败隔 10 分钟重试的判断，
 * 以及负责人私信「发日报 / 重发日报」——都只是把「生成并私发日报」建成一条系统任务（commandType=daily）交给 worker。
 * 生成本身（git / bug 表 / 任务库）在 lib/lark-daily-report.mjs，只有 worker import 它（gateway 纯度闸）。思路取自 falive
 * lark-daily-schedule.mjs，去掉功能总表 / 台账；定时的只私发 config.notifyOpenId，负责人在群里 @bot 要的才回那个群（11-05）。
 *
 * 发送记账 runtime/lark-daily-report-state.json：{ sent: { 'YYYY-MM-DD': { at, messageId } }, bugSnapshots: { 'YYYY-MM-DD': {...} } }，
 * 只由 worker 写（发出去之后才记），gateway 只读——同一天重试 / 重启不重发。
 * 合盖：Mac 睡着时定时器不走，开盖后第一次 tick 若上一个日报日到点不满 24h 且没发，就补发那天的（内容按那天算）。
 */

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { writeJsonAtomic } from './lark-fs.mjs'
import { sendPrincipalNote, sendReply } from './lark-group-exit.mjs'
import { mentionsBot } from './lark-message.mjs'
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

// 负责人说「暂停日报」（11-05 b3 ep-1102-326837「项目已经上线。暂停日报生成、发送，啥时候开再通知你」原先判 ignore、只口头答应）：
// 暂停记在单独的文件里（gateway 写；发送记账那份只归 worker 写，不抢同一个文件），定时那份跳过；手动「发日报」照发。
export const dailyPausePath = () => join(larkRuntimeDir, 'lark-daily-report-pause.json')
export const readDailyPause = (path = dailyPausePath()) => readDailyState(path).paused === true

// 这一分钟要不要建定时日报任务：没开 / 暂停了 / 没到点 / 那天已发 / 那天已有在跑或已了结的一次 / 失败满 3 次 / 上次失败不满 10 分钟 → null。
export const decideDailyRun = ({ config, state = {}, tasks = [], now = Date.now(), paused = false }) => {
  const settings = dailySettings(config)
  if (!settings.enabled || paused) return null
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
// 负责人在群里 @bot 要的（11-05 b3 ep-1015-9cb0e5「今天日报发一下 @Aven.Bot」原先判 ignore、回「发不了」）：daily.postTo 记那条群消息，
// worker 回到群里（只带这个群的任务，不带私人的「等你决定的」，lib/lark-daily-report）。
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
  daily: { date, mode, attempt, ...(msg?.chatType && msg.chatType !== 'p2p' ? { postTo: { chatId: msg.chatId, messageId: msg.messageId, inThread: Boolean(msg.threadId) } } : {}) },
  createdAt: new Date(now).toISOString(),
})

// 负责人的日报指令。发 / 重发只认整句（问「日报怎么没发」不算）：发日报 / 补发日报 / （今天）日报发一下 → manual；重发日报 / 再发日报 → force。
// 暂停 / 恢复认句中的说法（「项目已经上线。暂停日报生成、发送，啥时候开再通知你」），问句不算（「能不能暂停日报？」）。
const DAILY_PAUSE_RE = /(?:暂停|停掉|停止|先停|关掉|关闭)(?:发送?|生成)?(?:的)?日报|日报[^，,。；;]{0,6}?(?:暂停|停掉|停止|先停|先别发|别发|不用发了?|关掉)/
const DAILY_RESUME_RE = /(?:恢复|重新开|开启|打开|继续发)(?:发送?|生成)?(?:的)?日报|日报[^，,。；;]{0,6}?(?:恢复|重新开|继续发)/
export const parseDailyDirective = (text) => {
  const raw = String(text || '').replace(/<[^>]+>/g, '')
  const bare = raw.replace(/[\s。.!！~～]/g, '')
  if (/^(?:(?:今天|今日)的?)?(?:(?:补)?发(?:一?下)?(?:(?:今天|今日)的?)?日报|日报(?:补)?发(?:一?下)?)$/.test(bare)) return { mode: 'manual' }
  if (/^(?:重发|再发)日报$/.test(bare)) return { mode: 'force' }
  if (/[?？]|吗\s*$/.test(bare)) return null
  if (DAILY_PAUSE_RE.test(bare)) return { mode: 'pause' }
  if (DAILY_RESUME_RE.test(bare)) return { mode: 'resume' }
  return null
}

// ingest 在分类之前调：只认负责人本人，私信或群里 @ 了机器人。发 / 重发建今天的日报任务；暂停 / 恢复改暂停文件并回一句。返回 true（不再往下走分类）。
export const maybeHandleDailyDirective = async ({ msg, config, store, now = Date.now(), deps = {} }) => {
  if (!isPrincipal(config, msg.senderOpenId) || (msg.chatType !== 'p2p' && !mentionsBot({ msg, config }))) return false
  const directive = parseDailyDirective(msg.text)
  if (!directive) return false
  if (directive.mode === 'pause' || directive.mode === 'resume') {
    const path = deps.pausePath || dailyPausePath()
    if (directive.mode === 'pause') writeJsonAtomic(path, { paused: true, at: new Date(now).toISOString(), by: msg.senderOpenId })
    else rmSync(path, { force: true })
    const text = directive.mode === 'pause'
      ? '好，日报停了：定时的不再生成、不再发。要恢复跟我说「恢复日报」；临时要一份就说「发日报」。'
      : `好，日报恢复了，照常 ${dailySettings(config).at} 发。`
    const idempotencyKey = `${msg.messageId}-daily-${directive.mode}`.slice(0, 50)
    if (msg.chatType === 'p2p') await (deps.sendPrincipalNote || sendPrincipalNote)({ config, store, text, kind: 'private', idempotencyKey })
    else await (deps.sendReply || sendReply)({ config, store, task: { id: null, chatId: msg.chatId, messageId: msg.messageId, operator: msg.senderOpenId, epoch: 0, replyTarget: { messageId: msg.messageId, inThread: Boolean(msg.threadId) } }, phase: 'notice', text, idempotencyKey })
    console.log(`[lark-gateway] 负责人${directive.mode === 'pause' ? '暂停' : '恢复'}日报`)
    return true
  }
  const task = store.upsert(buildDailyTask({ config, date: localDateKey(now), mode: directive.mode, msg, now }))
  console.log(`[lark-gateway] 负责人要日报（${directive.mode}${task.daily.postTo ? '，回群' : ''}）：排队 ${task.id}`)
  return true
}

// 那天日报已经发出去了、之前没发成的几次（failed，失败时间早于发出时间）：返回 [{ task, sentAt }]，由 tick 结单。
// 11-04 事故：合盖断网，19:00 / 19:27 两次失败、19:39 第 3 次发出，前两次一直挂在 failed 里催人工。
// 发出之后才失败的（「重发日报」在已发后再失败）不算——那次是真的没发成。
export const staleDailyFailures = ({ state = {}, tasks = [] }) =>
  tasks.flatMap((task) => {
    if (task.commandType !== DAILY_COMMAND_TYPE || task.status !== 'failed') return []
    const sentAt = state.sent?.[task.daily?.date]?.at
    const failedAt = Date.parse(task.updatedAt || '')
    return sentAt && Date.parse(sentAt) >= failedAt ? [{ task, sentAt }] : []
  })

// 每分钟看一眼该不该建定时日报任务（建了就交给 worker）。dailyReport.enabled=false 时只关定时，私信「发日报」照样能要。
export const startDailyReport = ({ config, store, readState = readDailyState, readPause = readDailyPause, intervalMs = 60_000, clock = Date.now }) => {
  const tick = () => {
    const state = readState()
    for (const { task, sentAt } of staleDailyFailures({ state, tasks: store.list() })) {
      const note = `${task.daily.date} 的日报已在 ${new Date(sentAt).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })} 由后续一次发出，本次失败作废。`
      if (store.closeAsExternallyResolved?.({ id: task.id, operator: 'daily-schedule', closureReason: 'completed_elsewhere', note })) {
        console.log(`[lark-gateway] 日报失败作废 ${task.id}：${note}`)
      }
    }
    const run = decideDailyRun({ config, state, tasks: store.list(), now: clock(), paused: readPause() })
    if (!run) return null
    const task = store.upsert(buildDailyTask({ config, date: run.date, mode: 'scheduled', attempt: run.attempt, now: clock() }))
    console.log(`[lark-gateway] 到点建日报任务 ${task.id}（${run.date} 第 ${run.attempt} 次）`)
    return task
  }
  const timer = setInterval(tick, intervalMs)
  timer.unref?.()
  return { stop: () => clearInterval(timer), tick }
}
