/**
 * 运行态体检（自愈环 3，从 falive 移植，aven 2026-10-24；falive 原设计见其 docs/falive-self-healing.md §4）：
 * 把散在 /lark/health、worker 心跳、任务列表、失败台账、bug 表轮询状态里「bot 自己能看见的异常」收成一份带等级的报告。
 * 两个出口：
 *   · `lark-bot doctor [--json]`（scripts/lark-doctor.mjs）人工看，有 warn / bad 非零退出；
 *   · worker 启动 3 分钟后一次、之后每小时一次：warn / bad 私信 notifyOpenId（没配只写 worker.log），
 *     同一条（检查项 + 内容指纹）24 小时只报一次，状态在 runtime/lark-doctor-state.json。
 * 判定是纯函数（buildDoctorReport），取数与副作用由调用方注入。
 * falive 的日报到点 / 发件簿 / 外部群轮询 / 台账检查不搬（fameex 没有这些）。
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { summarizeFailures } from './lark-failure-ledger.mjs'
import { writeJsonAtomic } from './lark-fs.mjs'
import { larkRuntimeDir } from './lark-paths.mjs'
import { isLidClosed, lastSystemSleepAt } from './lark-power.mjs'
import { computeCodeHash, readWorkerHeartbeat } from './lark-runtime-version.mjs'

const HOUR_MS = 3600_000
export const STALE_PARKED_MS = 24 * HOUR_MS
export const DEDUPE_MS = 24 * HOUR_MS
// 开盖 / 唤醒后这么久内不体检：睡眠期间心跳、事件、轮询都停着，刚醒那一下看到的「停了」不是故障。
export const WAKE_GRACE_MS = 10 * 60_000
// 与 poller 自己的群告警阈值同一默认值（LARK_BUGTABLE_ERROR_ALERT_ROUNDS）。
const POLLER_ERROR_ROUNDS = 3
const POLLER_MIN_STALL_MS = 10 * 60_000

const LEVEL_ORDER = { ok: 0, info: 1, warn: 2, bad: 3 }
const ICON = { ok: '✓', info: 'ℹ', warn: '⚠', bad: '✖' }
const minutes = (ms) => Math.round(ms / 60_000)
const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 开关：配置 selfHeal.doctor=false 或环境 LARK_DOCTOR=0 只关 worker 里的定时体检 / 私信；
 * `lark-bot doctor` 手动命令始终可用。
 */
export const doctorSwitch = ({ selfHeal = {}, env = process.env } = {}) =>
  selfHeal?.doctor === false || env.LARK_DOCTOR === '0' ? { enabled: false, reason: '配置 / 环境关闭' } : { enabled: true, reason: '默认开' }

// ---- bug 表轮询状态（poller 每轮写，体检读；文件名以 -state.json 结尾，不算源码） ----
export const pollerStatePath = (runtimeDir = larkRuntimeDir) => join(runtimeDir, 'lark-bugtable-poller-state.json')
export const writePollerStatus = (status, { runtimeDir = larkRuntimeDir, log = console.warn } = {}) => {
  try {
    writeJsonAtomic(pollerStatePath(runtimeDir), status)
  } catch (error) {
    log(`[bugtable-poller] 轮询状态写入失败（忽略）：${String(error).slice(0, 120)}`)
  }
}
const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}
// null = 从没开过轮询；alive = 进程还在且没写过「已收工」。
export const readPollerStatus = ({ runtimeDir = larkRuntimeDir, isAlive = pidAlive } = {}) => {
  const raw = readJson(pollerStatePath(runtimeDir))
  if (!raw) return null
  return { ...raw, alive: !raw.stoppedAt && isAlive(raw.pid) }
}

// ---- 自修工单（lib/lark-self-fix.mjs 落盘；这里只看目录在不在，不 import 它的模块） ----
// 约定：runtime/lark-self-fix/<id>.json 一张工单，status === 'ready' = 验收通过、已本地提交，等人 apply；
// 转成 ready 时 updatedAt 被刷新，拿它当「就绪时间」。
export const readSelfFixQueue = ({ runtimeDir = larkRuntimeDir } = {}) => {
  const dir = join(runtimeDir, 'lark-self-fix')
  if (!existsSync(dir)) return null
  const ready = []
  for (const name of readdirSync(dir).filter((file) => file.endsWith('.json')).sort()) {
    const ticket = readJson(join(dir, name))
    if (ticket?.status === 'ready') ready.push({ id: ticket.id || name.slice(0, -'.json'.length), at: ticket.readyAt || ticket.updatedAt || ticket.createdAt || null })
  }
  return { ready }
}

/**
 * 纯判定。输入都是快照：
 * @param health    GET /lark/health 的 JSON（null = gateway 不可达；503 也照样解析，ok=false = 长连接不在线）
 * @param tasks     GET /lark/tasks 的 tasks（null = 取不到，如缺 gateway 密钥）
 * @param failures  summarizeFailures() 的结果（7 天）
 * @param heartbeat readWorkerHeartbeat()（health 不可达时兜底看 worker）
 * @param poller    readPollerStatus()（null = 从没开过）
 * @param selfFix   readSelfFixQueue()（null = 没有自修工单目录，这项不出现）
 * 每项 { id, level: ok|info|warn|bad, text: 一句人话, action: 建议动作（ok 为空） }。
 */
export const buildDoctorReport = ({ health = null, tasks = null, failures = null, heartbeat = null, poller = null, selfFix = null, now = Date.now() }) => {
  const checks = []
  const push = (id, level, text, action = '') => checks.push({ id, level, text, action })

  // 1. gateway / worker 存活与版本
  if (!health) push('gateway', 'bad', 'gateway 不可达（/lark/health 没响应）', 'lark-bot status 看进程；停了就 lark-bot start，起不来看 ~/Library/Logs/fameex-lark/gateway.log')
  else if (!health.ok) push('gateway', 'bad', 'gateway 在，但飞书长连接不在线，群里 @bot 收不到', '看 gateway.log 里 event consume 的报错；lark-cli 登录态过期就重新登录再 lark-bot restart')
  else push('gateway', 'ok', 'gateway 在线')

  const worker = health?.worker || heartbeat
  if (!worker) push('worker', 'bad', '没有 worker 心跳（worker 没起来）', 'lark-bot status；没起来就 lark-bot restart，看 worker.log 末尾')
  else if (worker.heartbeatStale) push('worker', 'bad', `worker 心跳已停 ${minutes(worker.heartbeatAgeMs || 0)} 分钟（pid ${worker.pid} 可能已死）`, 'lark-bot restart，看 worker.log 末尾为什么停')
  else if (!worker.readiness?.ok) push('worker', 'bad', 'worker 的 AI 执行器就绪检查没过，新任务跑不了', 'worker.log 搜 readiness；Claude 鉴权问题用 lark-bot claude-auth local|proxy 切换')
  else push('worker', 'ok', `worker 在线（在飞 ${worker.inFlight ?? '?'}${worker.draining ? '，排空中' : ''}）`)

  const codeStale = Boolean(health?.version?.codeStale || worker?.codeStale)
  const configStale = Boolean(health?.version?.configStale)
  const staleWhat = [codeStale && '代码', configStale && '配置'].filter(Boolean).join('和')
  if (!staleWhat) push('version', 'ok', '运行版本与磁盘一致')
  else if (worker?.draining) push('version', 'info', `${staleWhat}落后磁盘，worker 正在排空，在飞任务跑完、自检绿会自动重启`)
  else push('version', 'warn', `${staleWhat}落后磁盘，排空重启没接手`, '看 worker.log「排空重启」：关着（selfHeal.drainRestart=false / LARK_DRAIN_RESTART=0 / 非 launchd 托管）就手动 lark-bot restart；自检红就先修红的测试')

  // 2. gateway 自己的 warnings（事件静默 / 意图分类失败 / 回写 / 回执 / 死信）原样带上；上面已归并的、下面单列的跳过
  for (const warning of health?.warnings || []) {
    if (/落后磁盘|旧代码|worker 版本心跳|worker 心跳已停|就绪检查|failed 任务待人工处置/.test(warning)) continue
    if (/夜间空闲属正常|正在重试/.test(warning)) push('gateway-warning', 'info', warning)
    else push('gateway-warning', 'warn', warning, 'lark-bot status 看明细')
  }

  // 3. bug 表轮询（QA 期手动 poll-on，空闲 4h 自动收工：没在跑是常态，只算 info）
  if (!poller?.alive) {
    push('poller', 'info', `bug 表轮询没在跑${poller?.stopReason === 'idle' ? '（空闲自动收工）' : ''}，新 bug 不会被自动捞；群里 @bot 不受影响`, 'QA 期要捞 bug 表就 lark-bot poll-on')
  } else {
    const lastRoundAt = Date.parse(poller.lastRoundAt || poller.startedAt || '') || 0
    const stallMs = Math.max(3 * (Number(poller.pollMs) || 0), POLLER_MIN_STALL_MS)
    const errors = Number(poller.consecutiveErrors) || 0
    if (now - lastRoundAt > stallMs) push('poller', 'warn', `bug 表轮询进程在（pid ${poller.pid}），但 ${minutes(now - lastRoundAt)} 分钟没跑完一轮`, '可能卡住了：lark-bot poll-off 再 lark-bot poll-on，看 poller.log')
    else if (errors >= POLLER_ERROR_ROUNDS) push('poller', 'warn', `bug 表轮询连续 ${errors} 次失败（${String(poller.lastError || '').slice(0, 80)}），期间新 bug 捞不到`, '看 poller.log：lark-cli 登录态 / 表格权限 / gateway 是否在跑')
    else if (errors > 0) push('poller', 'info', `bug 表轮询最近 ${errors} 次失败，还在重试`)
    else push('poller', 'ok', `bug 表轮询在跑（上一轮 ${minutes(now - lastRoundAt)} 分钟前）`)
  }

  // 4. 挂起超 24 小时 / failed 积压
  if (Array.isArray(tasks)) {
    const parked = tasks.filter((task) => task.status === 'waiting_confirmation' || task.status === 'blocked')
    const old = parked.filter((task) => now - (Date.parse(task.parkedAt || task.updatedAt || '') || 0) > STALE_PARKED_MS)
    if (old.length) {
      const sample = old.slice(0, 3).map((task) => `${task.id}「${(task.summary || '').slice(0, 24)}」`).join('、')
      push('parked', 'warn', `${old.length} 条任务挂起超过 24 小时等人补料 / 确认：${sample}${old.length > 3 ? '…' : ''}`, '补料 lark-bot resume <id> "<补充>"；不要了 lark-bot close <id>')
    } else push('parked', 'ok', parked.length ? `${parked.length} 条挂起，都不到 24 小时` : '没有挂起任务')
  }
  const failedCount = Array.isArray(tasks) ? tasks.filter((task) => task.status === 'failed').length : Number(health?.counts?.failed) || 0
  if (failedCount) push('failed-tasks', 'warn', `${failedCount} 条 failed 任务等人处置`, 'lark-bot failed 看明细；lark-bot retry <id> 重跑，或 lark-bot clean --failed 清掉')
  else push('failed-tasks', 'ok', '没有 failed 任务')

  // 5. 失败台账（7 天）
  if (failures) {
    const classes = Object.entries(failures.byClass).sort((a, b) => b[1] - a[1]).map(([cls, n]) => `${cls} ${n}`).join('、')
    const recurring = failures.recurring.map((item) => `${item.fingerprint}×${item.count}`).join('、')
    if (!failures.total) push('failures', 'ok', '7 天内没有 worker 层失败')
    else if (recurring) push('failures', 'warn', `7 天失败 ${failures.total}（${classes}），自动重跑 ${failures.healed} 次，复发指纹 ${failures.recurring.length} 个：${recurring}`, '同一种错在复发：runtime/lark-failures/fameex.jsonl 按指纹看原文，修根因')
    else push('failures', 'info', `7 天失败 ${failures.total}（${classes}），自动重跑 ${failures.healed} 次，没有复发`)
  }

  // 6. 自修工单（只有目录存在才查）
  if (selfFix) {
    const old = selfFix.ready.filter((ticket) => now - (Date.parse(ticket.at || '') || now) > STALE_PARKED_MS)
    if (!selfFix.ready.length) push('self-fix', 'ok', '没有待处理的自修工单')
    else push('self-fix', old.length ? 'warn' : 'info', `${selfFix.ready.length} 个自修工单已就绪等你看${old.length ? `，其中 ${old.length} 个超过 24 小时` : ''}：${selfFix.ready.slice(0, 3).map((ticket) => ticket.id).join('、')}`, 'lark-bot self-fix list 查看；要上线 lark-bot self-fix apply <id>，不要 lark-bot self-fix discard <id>')
  }

  const worst = Math.max(...checks.map((check) => LEVEL_ORDER[check.level]))
  const level = Object.keys(LEVEL_ORDER).find((key) => LEVEL_ORDER[key] === worst)
  return { checks, ok: worst < LEVEL_ORDER.warn, level, at: new Date(now).toISOString() }
}

const formatCheck = (check) => `${ICON[check.level]} ${check.text}${check.action ? `\n    → ${check.action}` : ''}`
export const formatDoctorReport = (report) => report.checks.map(formatCheck).join('\n')

// ---- 取数（CLI 与 worker 共用） ----
// 503 也要解析：长连接掉线时 gateway 回 503 + ok:false，那是「在但长连接不在线」，不是不可达。
export const fetchHealth = async ({ gatewayUrl, fetchImpl = fetch, timeoutMs = 3000 }) => {
  try {
    const response = await fetchImpl(`${gatewayUrl}/lark/health`, { signal: AbortSignal.timeout(timeoutMs) })
    return await response.json()
  } catch {
    return null
  }
}

export const collectDoctorInputs = async ({ gatewayUrl, listTasks, runtimeDir = larkRuntimeDir, fetchImpl = fetch, now = Date.now() }) => {
  const health = await fetchHealth({ gatewayUrl, fetchImpl })
  let tasks = null
  try {
    tasks = await listTasks()
  } catch {
    tasks = null
  }
  // health 里已有 worker（gateway 代读心跳）；gateway 不可达时才自己读心跳兜底。
  const heartbeat = health?.worker ? null : readWorkerHeartbeat({ runtimeDir, expectedCodeHash: computeCodeHash().hash, now: () => now })
  return {
    health,
    tasks,
    heartbeat,
    failures: summarizeFailures({ dir: join(runtimeDir, 'lark-failures'), now }),
    poller: readPollerStatus({ runtimeDir }),
    selfFix: readSelfFixQueue({ runtimeDir }),
  }
}

// `lark-bot doctor [--json]`：打印报告，返回退出码（有 warn / bad 为 1）。
export const runDoctorCli = async ({ argv = [], out = console.log, now = Date.now(), ...collect }) => {
  const report = buildDoctorReport({ ...(await collectDoctorInputs({ ...collect, now })), now })
  out(argv.includes('--json') ? JSON.stringify(report, null, 2) : formatDoctorReport(report))
  return report.ok ? 0 : 1
}

// ---- 定时体检 + 私信去重 ----
export const doctorStatePath = (runtimeDir = larkRuntimeDir) => join(runtimeDir, 'lark-doctor-state.json')
// 指纹去掉数字：「心跳已停 10 分钟」→「11 分钟」是同一件事，不该每小时重报。
export const doctorCheckKey = (check) => `${check.id}:${createHash('sha1').update(check.text.replace(/\d+/g, '#')).digest('hex').slice(0, 10)}`

export const pickNotifiable = ({ report, state, now = Date.now(), dedupeMs = DEDUPE_MS }) =>
  report.checks.filter((check) => {
    if (LEVEL_ORDER[check.level] < LEVEL_ORDER.warn) return false
    const last = state.notified?.[doctorCheckKey(check)]
    return !(last && now - last < dedupeMs)
  })

/**
 * deps：collect(at) → buildDoctorReport 的输入；notify(text, { idempotencyKey }) → { ok }（返回 ok:false 或抛错 = 没报出去，
 * 不记已报，下一轮再报）；lidClosed / lastSleepAt 取电源态（合盖跳过、刚醒 10 分钟内跳过）。
 */
export const createDoctorMonitor = ({
  collect,
  notify,
  statePath = doctorStatePath(),
  now = Date.now,
  log = console.log,
  lidClosed = isLidClosed,
  lastSleepAt = lastSystemSleepAt,
}) => {
  const tick = async () => {
    // 合盖 = 下班：Power Nap 半醒时网络 / 进程状态都不可信，体检也不跑，开盖后下一轮照常。
    if (await lidClosed()) return { report: null, notified: [], skipped: 'lid-closed' }
    const at = now()
    const sleptAt = await lastSleepAt()
    if (sleptAt && at - sleptAt < WAKE_GRACE_MS) return { report: null, notified: [], skipped: 'just-woke' }
    const report = buildDoctorReport({ ...(await collect(at)), now: at })
    const state = readJson(statePath) || {}
    const fresh = pickNotifiable({ report, state, now: at })
    if (!fresh.length) return { report, notified: [] }
    const keys = fresh.map(doctorCheckKey)
    const text = `lark-bot 体检（${new Date(at).toTimeString().slice(0, 5)}）发现 ${fresh.length} 条异常：\n${fresh.map(formatCheck).join('\n')}`
    const idempotencyKey = `doctor-${createHash('sha1').update(keys.join(',')).digest('hex').slice(0, 12)}-${Math.floor(at / HOUR_MS)}`
    let sent
    try {
      sent = await notify(text, { idempotencyKey })
    } catch (error) {
      sent = { ok: false, reason: String(error) }
    }
    if (sent?.ok === false) {
      log(`[lark-worker] 体检：私信失败（下次再报）：${String(sent.reason || 'ok:false').slice(0, 120)}`)
      return { report, notified: [], failed: true }
    }
    // 只留去重窗内的记录，文件不无限长。
    const kept = Object.fromEntries(Object.entries(state.notified || {}).filter(([, last]) => at - last < DEDUPE_MS))
    try {
      writeJsonAtomic(statePath, { notified: { ...kept, ...Object.fromEntries(keys.map((key) => [key, at])) } })
    } catch (error) {
      log(`[lark-worker] 体检状态写入失败（下次可能重报）：${String(error).slice(0, 120)}`)
    }
    log(`[lark-worker] 体检：${fresh.length} 条异常已报`)
    return { report, notified: fresh }
  }
  return { tick }
}

// 私信出口：notifyOpenId 没配时异常只写日志（仍按 24h 去重）。send 由 worker 注入（sendChatMessage），本模块不直接依赖 lark-cli。
export const doctorNotifier = ({ notifyOpenId, send, log = console.log }) =>
  notifyOpenId
    ? (text, { idempotencyKey } = {}) => send({ chatId: notifyOpenId, text, idempotencyKey, logPrefix: 'doctor' })
    : async (text) => log(`[lark-worker] 体检（未配 notifyOpenId，只写日志）：\n${text}`)

// worker 装配入口：启动 firstMs 后一次、之后每 everyMs 一次。
export const startDoctorSchedule = ({
  selfHeal,
  env = process.env,
  notifyOpenId,
  send,
  gatewayUrl,
  listTasks,
  log = console.log,
  firstMs = Number(env.LARK_DOCTOR_FIRST_MS) || 3 * 60_000,
  everyMs = Number(env.LARK_DOCTOR_EVERY_MS) || HOUR_MS,
  monitor = createDoctorMonitor({
    collect: (at) => collectDoctorInputs({ gatewayUrl, listTasks, now: at }),
    notify: doctorNotifier({ notifyOpenId, send, log }),
    log,
  }),
}) => {
  const doctorSw = doctorSwitch({ selfHeal, env })
  if (!doctorSw.enabled) {
    log(`[lark-worker] 体检：关（${doctorSw.reason}；lark-bot doctor 手动命令照常可用）`)
    return { enabled: false, stop() {} }
  }
  const tick = () => monitor.tick().catch((error) => log(`[lark-worker] 体检 tick 异常（忽略）：${String(error).slice(0, 160)}`))
  const first = setTimeout(tick, firstMs)
  const every = setInterval(tick, everyMs)
  first.unref?.()
  every.unref?.()
  log(`[lark-worker] 体检：开（${minutes(firstMs)} 分钟后首次、之后每 ${minutes(everyMs)} 分钟；异常${notifyOpenId ? '私信 notifyOpenId' : '只写日志：未配 notifyOpenId'}，同一条 24h 只报一次）`)
  return {
    enabled: true,
    tick,
    stop() {
      clearTimeout(first)
      clearInterval(every)
    },
  }
}
