/**
 * bug 发现的两档调度（aven 2026-11-01，docs/plan/plan-bug-workflow-2026-11-01.md B2）——纯函数，IO 在 lark-bug-watch-io.mjs。
 *
 * 发现 bug 不再整表轮询，而是：
 *   · 读新 bug 通知：表格自动化「你有一个新的Bug」私聊卡片（带需求ID + 问题标题），用负责人身份读该私聊会话，
 *     按消息序号 message_position 断点续读（时间只到分钟，序号单调），再按「项目号 + 标题 + 负责RD = 我」查表定位记录；
 *   · 对账：查「负责RD = 我，状态 ∈ 待处理 / 验退」，捞验退、漏掉的通知、状态变化（第一次只记基线不开工）。
 * 两档频率（全局一个开关，不按项目号——多项目并行，通知自带需求ID、按项目号分流）：
 *   平时：读通知 60 分钟、对账 120 分钟；读到新 bug 通知 → 自动转「测试中」
 *   测试中：读通知 工作时间 1 分钟 / 其他 10 分钟、对账 15 分钟；连续一个工作日没有新通知 → 自动回「平时」
 * 合盖：进程随系统睡眠暂停，醒来后到期的入口立刻补跑（读通知按断点补读）；睡眠空档不计入「一个工作日」。
 */

const DAY_MS = 24 * 60 * 60 * 1000
const MIN_MS = 60 * 1000

export const DEFAULT_WATCH = Object.freeze({
  enabled: false,
  notifyChatId: '',
  workHours: ['09:50', '19:10'],
  utcOffsetMin: null, // 不配 = 本机时区
  testing: { notifyWorkMin: 1, notifyOffMin: 10, reconcileMin: 15 },
  idle: { notifyMin: 60, reconcileMin: 120 },
  autoOffWorkDays: 1,
  tickMs: 60 * 1000,
})

const hhmm = (text, fallback) => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text || ''))
  return match ? Number(match[1]) * 60 + Number(match[2]) : fallback
}
const positive = (value, fallback) => (Number(value) > 0 ? Number(value) : fallback)

export const normalizeWatchConfig = (raw = {}, { localOffsetMin = -new Date().getTimezoneOffset() } = {}) => {
  const w = raw || {}
  return {
    enabled: w.enabled === true,
    notifyChatId: typeof w.notifyChatId === 'string' ? w.notifyChatId.trim() : '',
    workStartMin: hhmm(w.workHours?.[0], 9 * 60 + 50),
    workEndMin: hhmm(w.workHours?.[1], 19 * 60 + 10),
    utcOffsetMin: Number.isFinite(w.utcOffsetMin) ? w.utcOffsetMin : localOffsetMin,
    testing: {
      notifyWorkMs: positive(w.testing?.notifyWorkMin, DEFAULT_WATCH.testing.notifyWorkMin) * MIN_MS,
      notifyOffMs: positive(w.testing?.notifyOffMin, DEFAULT_WATCH.testing.notifyOffMin) * MIN_MS,
      reconcileMs: positive(w.testing?.reconcileMin, DEFAULT_WATCH.testing.reconcileMin) * MIN_MS,
    },
    idle: {
      notifyMs: positive(w.idle?.notifyMin, DEFAULT_WATCH.idle.notifyMin) * MIN_MS,
      reconcileMs: positive(w.idle?.reconcileMin, DEFAULT_WATCH.idle.reconcileMin) * MIN_MS,
    },
    autoOffWorkDays: positive(w.autoOffWorkDays, DEFAULT_WATCH.autoOffWorkDays),
    // 团队范围（aven 11-01 B4，默认关）：对账也捞名单里这些人头上的单（通知只覆盖「我」）
    team: {
      enabled: w.team?.enabled === true,
      assignees: Array.isArray(w.team?.assignees) ? w.team.assignees.filter((id) => typeof id === 'string' && id.startsWith('ou_')) : [],
    },
    tickMs: positive(w.tickMs, DEFAULT_WATCH.tickMs),
  }
}

// 工作时间：周一到周五 [workStart, workEnd)（按配置的时区）。
const localParts = (ms, cfg) => {
  const shifted = new Date(ms + cfg.utcOffsetMin * MIN_MS)
  return { day: shifted.getUTCDay(), minute: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(), dayStartMs: ms - (shifted.getTime() % DAY_MS) }
}
const isWeekday = (day) => day >= 1 && day <= 5

export const isWorkTime = (ms, cfg) => {
  const { day, minute } = localParts(ms, cfg)
  return isWeekday(day) && minute >= cfg.workStartMin && minute < cfg.workEndMin
}

export const workDayMs = (cfg) => Math.max(0, cfg.workEndMin - cfg.workStartMin) * MIN_MS

/** [from, to) 之间落在工作时间里的毫秒数。 */
export const workMsBetween = (from, to, cfg) => {
  if (!(to > from)) return 0
  let total = 0
  let { dayStartMs } = localParts(from, cfg)
  for (; dayStartMs < to; dayStartMs += DAY_MS) {
    if (!isWeekday(localParts(dayStartMs + 12 * 60 * MIN_MS, cfg).day)) continue
    const open = dayStartMs + cfg.workStartMin * MIN_MS
    const close = dayStartMs + cfg.workEndMin * MIN_MS
    total += Math.max(0, Math.min(close, to) - Math.max(open, from))
  }
  return total
}

export const initialWatchState = (now = Date.now()) => ({
  version: 1,
  mode: 'idle',
  modeSince: new Date(now).toISOString(),
  lastNewBugAt: null,
  quietWorkMs: 0,
  lastTickAt: now,
  lastNotifyReadAt: 0,
  lastReconcileAt: 0,
  cursor: null, // { position, at }：已处理到的通知消息序号
  baseline: null, // { at, statuses: { recordId: 状态 } }：对账基线
})

export const notifyIntervalMs = (state, now, cfg) =>
  state.mode === 'testing' ? (isWorkTime(now, cfg) ? cfg.testing.notifyWorkMs : cfg.testing.notifyOffMs) : cfg.idle.notifyMs

export const reconcileIntervalMs = (state, cfg) => (state.mode === 'testing' ? cfg.testing.reconcileMs : cfg.idle.reconcileMs)

// 失败退避（aven 11-03：用户身份掉线时读通知每分钟重试一次）：第 n 次连续失败后等 tick × 2^(n-1)，最多 30 分钟；成功清零。
export const RETRY_CAP_MS = 30 * MIN_MS
export const retryDelayMs = (consecutive, cfg) => Math.min(cfg.tickMs * 2 ** Math.max(0, consecutive - 1), RETRY_CAP_MS)
const retryReady = (state, entry, now) => now >= (state.retryAt?.[entry] || 0)

export const dueActions = (state, now, cfg) => ({
  notify: Boolean(cfg.notifyChatId) && now - (state.lastNotifyReadAt || 0) >= notifyIntervalMs(state, now, cfg) && retryReady(state, 'notify', now),
  reconcile: now - (state.lastReconcileAt || 0) >= reconcileIntervalMs(state, cfg) && retryReady(state, 'reconcile', now),
})

/**
 * 时钟推进：测试中按工作时间累计「多久没有新通知」。两次 tick 间隔超过 maxGapMs（默认 5 个 tick）视为
 * 睡眠 / 合盖，这段不计入（合盖时长不算工作日）。
 */
export const tickClock = (state, now, cfg, { maxGapMs = cfg.tickMs * 5 } = {}) => {
  const last = Number(state.lastTickAt) || now
  const gap = now - last
  const counted = state.mode === 'testing' && gap > 0 && gap <= maxGapMs ? workMsBetween(last, now, cfg) : 0
  return { ...state, lastTickAt: now, quietWorkMs: (state.quietWorkMs || 0) + counted }
}

export const setWatchMode = (state, mode, now = Date.now()) =>
  state.mode === mode
    ? state
    : { ...state, mode, modeSince: new Date(now).toISOString(), quietWorkMs: 0, ...(mode === 'testing' ? { lastNotifyReadAt: 0, lastReconcileAt: 0 } : {}) }

/** 读到 count 条新 bug 通知：清零安静计时；平时 → 测试中（switched='on'）。 */
export const onNewBugs = (state, count, now = Date.now()) => {
  if (!(count > 0)) return { state, switched: null }
  const switched = state.mode === 'testing' ? null : 'on'
  const next = { ...setWatchMode(state, 'testing', now), lastNewBugAt: new Date(now).toISOString(), quietWorkMs: 0 }
  // 刚切到测试中：保留本轮已经读过 / 对过账的时间，不要立刻重复跑一遍
  return { state: { ...next, lastNotifyReadAt: state.lastNotifyReadAt, lastReconcileAt: state.lastReconcileAt }, switched }
}

/** 测试中且连续 autoOffWorkDays 个工作日没有新通知 → 回平时（switched='off'）。 */
export const maybeAutoOff = (state, cfg, now = Date.now()) => {
  if (state.mode !== 'testing' || (state.quietWorkMs || 0) < cfg.autoOffWorkDays * workDayMs(cfg)) return { state, switched: null }
  return { state: setWatchMode(state, 'idle', now), switched: 'off' }
}

// ── 通知解析与断点 ─────────────────────────────────────────

const NOTIFY_TITLE_RE = /你有一个新的\s*Bug/i

/** 一条私聊消息 → { messageId, position, project, title }；不是新 bug 通知返回 null。 */
export const parseBugNotification = (message) => {
  const content = String(message?.content || '')
  if (!NOTIFY_TITLE_RE.test(content)) return null
  const project = /需求ID[：:]\s*([A-Za-z]{2}-\d{3,})/.exec(content)?.[1]?.toUpperCase() || ''
  const title = /问题[：:]\s*([^\n]+)/.exec(content)?.[1]?.trim() || ''
  const position = Number(message.message_position)
  return { messageId: message.message_id || '', position: Number.isFinite(position) ? position : null, project, title, createTime: message.create_time || '' }
}

/** 断点之后的新通知（按序号升序）；没有断点时全部返回（调用方第一次只建断点不处理）。 */
export const notificationsAfter = (messages, cursor) =>
  messages
    .map(parseBugNotification)
    .filter((n) => n && n.position !== null && (!cursor || n.position > cursor.position))
    .sort((a, b) => a.position - b.position)

// 读会话时往前多读的时间（create_time 只到分钟，start 按断点时间回退 2 分钟，靠序号去重）
export const CURSOR_LOOKBACK_MS = 2 * MIN_MS

// ── 定位记录 ─────────────────────────────────────────────

export const normalizeTitle = (text) => String(text || '').replace(/\s+/g, '').toLowerCase()

/**
 * 按通知的标题在候选记录里定位：标题去空白后完全一致、且负责RD 含我。唯一 → { record }；
 * 0 条 / 多条 → { reason }（不猜，私信负责人，aven 11-01 D3）。
 */
export const pickNotifiedRecord = ({ records, title, myOpenId, readTitle, isMine }) => {
  const want = normalizeTitle(title)
  const hits = records.filter((record) => normalizeTitle(readTitle(record)) === want && isMine(record, myOpenId))
  if (hits.length === 1) return { record: hits[0] }
  return { reason: hits.length ? 'multiple' : 'none', count: hits.length }
}

/** 标题里取一段做 intersects 过滤（服务端粗筛，再本地精确比对）。 */
export const titleProbe = (title) => {
  const clean = String(title || '').trim()
  const parts = clean.split(/[，,。；;\s]+/).filter((part) => part.length >= 4)
  return (parts.sort((a, b) => b.length - a.length)[0] || clean).slice(0, 30)
}

// ── 对账基线 ─────────────────────────────────────────────

/**
 * 对账：第一次只记基线（当时所有记录的状态），不开工——不把历史积压一下子全塞进队列；
 * 之后新出现的记录、或状态和基线不一样的（如被验退）才交给后续处理，并把基线更新成当前状态（同一变化只处理一次）。
 */
export const reconcileAgainstBaseline = ({ baseline, records, readStatus, now = Date.now() }) => {
  const statuses = Object.fromEntries(records.map((record) => [record.record_id, readStatus(record)]))
  if (!baseline) return { actionable: [], baseline: { at: new Date(now).toISOString(), statuses }, created: true }
  const actionable = records.filter((record) => baseline.statuses?.[record.record_id] !== statuses[record.record_id])
  return { actionable, baseline: { at: baseline.at, statuses }, created: false }
}

// ── 私信文案 ─────────────────────────────────────────────

// 私信是给人看的：一项一行（aven 11-01）。
export const formatModeSwitch = ({ switched, notification, cfg }) =>
  (switched === 'on'
    ? [
        `读到新 bug 通知：${notification?.project || '?'}「${String(notification?.title || '').slice(0, 40)}」`,
        'bug 发现转「测试中」：',
        `- 读通知：工作时间每 ${cfg.testing.notifyWorkMs / MIN_MS} 分钟，其他时间每 ${cfg.testing.notifyOffMs / MIN_MS} 分钟`,
        `- 对账：每 ${cfg.testing.reconcileMs / MIN_MS} 分钟`,
      ]
    : [
        `连续 ${cfg.autoOffWorkDays} 个工作日没有新 bug 通知，bug 发现回「平时」：`,
        `- 读通知：每 ${cfg.idle.notifyMs / MIN_MS} 分钟`,
        `- 对账：每 ${cfg.idle.reconcileMs / MIN_MS} 分钟`,
        '要提前开回：私信我「开始测试」，或 lark-bot poll-on。',
      ]
  ).join('\n')

// 负责人私信「开始测试 / 结束测试」切档（与 lark-bot poll-on / poll-off 同效）。
export const parseWatchDirective = (text) => {
  const input = String(text || '').trim()
  if (/^(?:开始测试|进入测试|poll-on)$/i.test(input)) return 'testing'
  if (/^(?:结束测试|退出测试|poll-off)$/i.test(input)) return 'idle'
  return null
}
