/**
 * 运行态体检（自愈环 3，docs/falive-self-healing.md §4）：把散在 /lark/health、worker 心跳、失败台账、
 * 日报状态、挂起任务里的「bot 自己能看见的异常」收成一份报告。三个出口：
 *   · `lark-bot doctor [repo]`（scripts/lark-doctor.mjs）人工看；
 *   · worker 每小时一次 tick：warn / bad 私信 aven，同一条 24 小时只报一次（runtime/lark-doctor-state.json）；
 *   · 日报私信版末尾一行「bot 自检」。
 * 判定全是纯函数（buildDoctorReport），取数与副作用由调用方注入。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { deferredKey, readDailyReportState } from './lark-daily-schedule.mjs'
import { isLidClosed } from './lark-keep-awake.mjs'
import { summarizeFailures } from './lark-failure-ledger.mjs'
import { larkRuntimeDir } from './lark-paths.mjs'
import { listRepoProfiles } from './lark-repo-profile.mjs'
import { computeCodeHash, readWorkerHeartbeat } from './lark-runtime-version.mjs'

const LEVEL_ORDER = { ok: 0, info: 1, warn: 2, bad: 3 }
// 磁盘改动 → worker 进入排空之间的正常空档（10-25 搬自 fameex 沙箱试跑：体检正好落在这段里，误报「排空重启没动」并私信，
// 还被 24h 去重压住了后面真没接手的那次）。worker 每个主循环（LARK_WORKER_POLL_MS，默认 5s）调一次排空 tick，版本观测有
// 10s 缓存，进入排空立刻补写心跳；按 settleMs（默认 60s）+ 2 个轮询周期再留余量，取 2 分钟：diskChangedAt 之后 2 分钟内
// 还没排空只算 info（不私信、不进 24h 去重），超过才 warn。diskChangedAt 缺失 / 不合法（如只改配置）照旧 warn。
export const DRAIN_PICKUP_GRACE_MS = 2 * 60_000
const hours = (ms) => Math.round(ms / 3600_000)
const minutes = (ms) => Math.round(ms / 60_000)
const localDate = (ms) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * @param health   GET /lark/health 的 JSON（可为 null = gateway 不可达）
 * @param tasks    GET /lark/tasks 的 tasks（可为 null）
 * @param profiles listRepoProfiles() 的非默认仓（只看有日报 / 群的）
 * @param failures summarizeFailures() 的结果（7 天）
 * @param dailyState readDailyReportState()
 * @param heartbeat readWorkerHeartbeat()（worker 侧自检时 health 里也有；CLI 两者都给）
 */
export const buildDoctorReport = ({ health = null, tasks = null, profiles = [], failures = null, dailyState = {}, heartbeat = null, now = Date.now() }) => {
  const checks = []
  const push = (id, level, text) => checks.push({ id, level, text })

  // 1. gateway / worker 存活与版本
  if (!health) push('gateway', 'bad', 'gateway 不可达（/lark/health 没响应）')
  else if (!health.ok) push('gateway', 'bad', 'gateway 长连接不在线（health.ok=false）')
  else push('gateway', 'ok', 'gateway 在线')
  const worker = health?.worker || heartbeat
  if (!worker) push('worker', 'bad', '没有 worker 心跳（worker 没起来，或是不写心跳的旧版本）')
  else if (worker.heartbeatStale) push('worker', 'bad', `worker 心跳已停 ${Math.round((worker.heartbeatAgeMs || 0) / 60000)} 分钟（pid ${worker.pid} 可能已死）`)
  else if (worker.readiness && worker.readiness.ok === false) push('worker', 'bad', 'worker 的 AI 执行器就绪检查没过，新任务跑不了')
  else push('worker', 'ok', `worker 在线（在飞 ${worker.inFlight ?? '?'}${worker.draining ? '，排空中' : ''}）`)
  const codeStale = Boolean(health?.version?.codeStale || worker?.codeStale)
  const configStale = Boolean(health?.version?.configStale)
  const staleWhat = [codeStale && '代码', configStale && '配置'].filter(Boolean).join('和')
  const changedAgoMs = now - Date.parse(health?.version?.diskChangedAt || '')
  if (!staleWhat) push('version', 'ok', '运行版本与磁盘一致')
  else if (worker?.draining) push('version', 'info', `${staleWhat}落后磁盘，worker 已在排空，跑完在飞任务会自动重启`)
  else if (changedAgoMs < DRAIN_PICKUP_GRACE_MS) push('version', 'info', `${staleWhat}落后磁盘（磁盘 ${minutes(changedAgoMs)} 分钟前刚改），等排空重启接手（${minutes(DRAIN_PICKUP_GRACE_MS)} 分钟内接手属正常）`)
  else push('version', 'warn', `${staleWhat}落后磁盘，排空重启没动：看 selfHeal.drainRestart 是否关了、单测是否红了`)

  // 2. gateway 自己的 warnings（事件静默 / failed 积压 / 回执 / 轮询失败）原样带上
  for (const warning of health?.warnings || []) {
    if (/已落后磁盘|跑的是旧代码|未见 worker|心跳已停|就绪检查/.test(warning)) continue // 上面已归并
    push('gateway-warning', /夜间空闲属正常/.test(warning) ? 'info' : 'warn', warning)
  }

  // 3. 日报：到点后 1 小时还没记成功
  for (const profile of profiles.filter((item) => !item.isDefault && item.dailyReport?.at)) {
    const days = profile.dailyReport.days || [1, 2, 3, 4, 5]
    const d = new Date(now)
    if (!days.includes(d.getDay())) continue
    const [hh, mm] = String(profile.dailyReport.at).split(':').map(Number)
    const dueMs = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm || 0).getTime()
    const today = localDate(now)
    if (dailyState?.[profile.key] !== today && dailyState?.[deferredKey(profile.key)] === today) push(`daily-report:${profile.key}`, 'info', `${profile.title || profile.key} 今天的日报因合盖推迟，开盖后补发`)
    else if (now > dueMs + 3600_000 && dailyState?.[profile.key] !== today) push(`daily-report:${profile.key}`, 'warn', `${profile.title || profile.key} 今天的日报到点 ${profile.dailyReport.at} 已过 ${hours(now - dueMs)} 小时还没发成功（state=${dailyState?.[profile.key] || '无'}）`)
    else if (dailyState?.[profile.key] === today) push(`daily-report:${profile.key}`, 'ok', `${profile.title || profile.key} 今天的日报已发`)
  }

  // 4. 挂起超过 24 小时的任务
  if (Array.isArray(tasks)) {
    const parked = tasks.filter((task) => task.status === 'waiting_confirmation')
    const old = parked.filter((task) => now - Date.parse(task.parkedAt || task.updatedAt || 0) > 24 * 3600_000)
    if (old.length) push('parked', 'warn', `${old.length} 条任务挂起超过 24 小时等人补料：${old.slice(0, 3).map((task) => `${task.id.slice(-8)}「${(task.summary || '').slice(0, 24)}」`).join('、')}${old.length > 3 ? '…' : ''}`)
    else push('parked', 'ok', parked.length ? `${parked.length} 条挂起，都不到 24 小时` : '没有挂起任务')
    const failed = tasks.filter((task) => task.status === 'failed')
    if (failed.length) push('failed-tasks', 'warn', `${failed.length} 条 failed 任务等人处置（lark-bot failed）`)
  }

  // 5. 失败台账（7 天）
  if (failures) {
    const classes = Object.entries(failures.byClass).sort((a, b) => b[1] - a[1]).map(([cls, n]) => `${cls} ${n}`).join('、')
    const recurring = failures.recurring.length
    // total 只数 fail、recurring.count 是撞上该指纹的任务数（同一任务的 requeue + fail 只算一个），见 summarizeFailures（10-25）。
    if (!failures.total) push('failures', 'ok', `7 天内没有 worker 层失败${failures.healed ? `（自动重跑 ${failures.healed} 次）` : ''}`)
    else push('failures', recurring ? 'warn' : 'info', `7 天失败 ${failures.total}（${classes}），自动重跑 ${failures.healed} 次${recurring ? `，复发指纹 ${recurring} 个：${failures.recurring.map((item) => `${item.fingerprint}（${item.count} 个任务）`).join('、')}` : ''}`)
  }

  const worst = checks.reduce((max, check) => Math.max(max, LEVEL_ORDER[check.level] || 0), 0)
  return { checks, ok: worst < LEVEL_ORDER.warn, level: Object.keys(LEVEL_ORDER).find((key) => LEVEL_ORDER[key] === worst) || 'ok', at: new Date(now).toISOString() }
}

const ICON = { ok: '✓', info: 'ℹ', warn: '⚠', bad: '✖' }
export const formatDoctorReport = (report) => report.checks.map((check) => `${ICON[check.level] || '·'} ${check.text}`).join('\n')

// 日报私信版末尾一行（不走网络：心跳 + 磁盘指纹 + 失败台账 + 日报状态）。
export const buildDailySelfCheckLine = ({ runtimeDir = larkRuntimeDir, now = Date.now(), failures = summarizeFailures({ now }), heartbeat = null } = {}) => {
  const hb = heartbeat || readWorkerHeartbeat({ runtimeDir, expectedCodeHash: computeCodeHash().hash, now: () => now })
  const parts = []
  parts.push(!hb ? 'worker 无心跳' : hb.heartbeatStale ? 'worker 心跳已停' : hb.codeStale ? (hb.draining ? 'worker 排空中' : 'worker 跑旧代码') : 'worker 正常')
  parts.push(failures.total ? `7 天失败 ${failures.total}、自动重跑 ${failures.healed}、复发指纹 ${failures.recurring.length}` : `7 天无失败${failures.healed ? `（自动重跑 ${failures.healed} 次）` : ''}`)
  return `bot 自检：${parts.join('；')}`
}

// worker 每小时体检：warn / bad 私信，同一条（id + 文案 hash）24 小时只报一次。
export const doctorStatePath = (runtimeDir = larkRuntimeDir) => join(runtimeDir, 'lark-doctor-state.json')
const readState = (path) => {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { notified: {} }
  } catch {
    return { notified: {} }
  }
}
const writeState = (path, state) => {
  try {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(`${path}.tmp`, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
    renameSync(`${path}.tmp`, path)
  } catch (error) {
    console.warn(`[lark-worker] 体检状态写入失败（忽略）：${String(error).slice(0, 120)}`)
  }
}
const keyOf = (check) => `${check.id}:${createHash('sha1').update(check.text).digest('hex').slice(0, 10)}`

export const pickNotifiable = ({ report, state, now = Date.now(), dedupeMs = 24 * 3600_000 }) =>
  report.checks.filter((check) => (check.level === 'warn' || check.level === 'bad') && !(state.notified?.[keyOf(check)] && now - state.notified[keyOf(check)] < dedupeMs))

export const createDoctorMonitor = ({
  fetchHealth,
  listTasks,
  profiles = () => listRepoProfiles(),
  failures = (now) => summarizeFailures({ now }),
  dailyState = () => readDailyReportState(),
  heartbeat = () => null,
  notify = async () => {},
  statePath = doctorStatePath(),
  now = Date.now,
  log = console.log,
  lidClosed = isLidClosed,
}) => {
  const tick = async () => {
    // 合盖 = bot 下班（aven 10-17）：Power Nap 半醒时网络 / 进程状态都不可信，体检也下班，开盖后下一轮照常。
    if (await lidClosed()) return { report: null, notified: [], skipped: 'lid-closed' }
    const at = now()
    let health = null
    let tasks = null
    try {
      health = await fetchHealth()
    } catch {
      health = null
    }
    try {
      tasks = await listTasks()
    } catch {
      tasks = null
    }
    const report = buildDoctorReport({ health, tasks, profiles: profiles(), failures: failures(at), dailyState: dailyState(), heartbeat: heartbeat(), now: at })
    const state = readState(statePath)
    const fresh = pickNotifiable({ report, state, now: at })
    if (fresh.length) {
      const text = `🩺 bot 体检（${new Date(at).toTimeString().slice(0, 5)}）：\n${fresh.map((check) => `${ICON[check.level]} ${check.text}`).join('\n')}`
      try {
        const sent = await notify(text)
        // 发送返回 ok:false（webhook 拒收 / 没配私聊目标）= 没报出去，不记已报，下一轮再报（aven 2026-10-20 review）。
        // 原来只认抛错，返回 ok:false 也写进 state，24 小时内同一条异常再不报。返回 undefined 的 notify 视为发出。
        if (sent && sent.ok === false) {
          log(`[lark-worker] 体检：私信失败（下次再报）：${String(sent.reason || 'ok:false').slice(0, 120)}`)
          return { report, notified: [], failed: true }
        }
        for (const check of fresh) state.notified = { ...(state.notified || {}), [keyOf(check)]: at }
        writeState(statePath, state)
        log(`[lark-worker] 体检：${fresh.length} 条异常已私信`)
      } catch (error) {
        log(`[lark-worker] 体检：私信失败（下次再报）：${String(error).slice(0, 120)}`)
        return { report, notified: [], failed: true }
      }
    }
    return { report, notified: fresh }
  }
  return { tick }
}
