/**
 * bug 发现两档调度的 IO 层（aven 2026-11-01，B2）：状态落盘、用负责人身份读通知会话、按通知定位记录、入口失败进自修。
 * 纯逻辑在 lark-bug-watch.mjs。所有 lark-cli 调用都可注入（测试不碰真实 lark-cli）。
 */
import { runLarkCli, larkCallFailed, formatLarkCliError } from './lark-cli.mjs'
import { parseColumnarRecords } from './lark-bugtable-parse.mjs'
import { CURSOR_LOOKBACK_MS } from './lark-bug-watch.mjs'
import { fingerprintFailure } from './lark-failure-fingerprint.mjs'
import { countRecentFingerprint, failuresDir, recordFailure } from './lark-failure-ledger.mjs'
import { maybeOpenSelfFix } from './lark-self-fix.mjs'

export { loadWatchState, saveWatchState, watchStatePath } from './lark-bug-watch-state.mjs'

const parseJson = (result, what) => {
  if (larkCallFailed(result)) throw new Error(`${what} 失败：${formatLarkCliError(result)}`)
  try {
    return JSON.parse(result.stdout)
  } catch {
    throw new Error(`${what} 返回不是 JSON：${String(result.stdout || '').slice(0, 160)}`)
  }
}

// 负责人身份走 runLarkCli 的 identity 选项，不在 args 里写 --as user：runLarkCli 缺省按 bot 注入应用令牌（lark-cli 因此进 strict mode bot），
// args 里的 --as user 盖掉前置的 --as bot 后被拒「only bot-identity commands are available」（11-03 自修 sf-20261103-ed68bd0e）。
const AS_USER = { identity: 'user' }
const messagesArgs = ({ chatId, order, pageSize, start, pageToken }) => [
  'im', '+chat-messages-list', '--chat-id', chatId, '--order', order, '--page-size', String(pageSize), '--no-reactions', '--format', 'json',
  ...(start ? ['--start', start] : []),
  ...(pageToken ? ['--page-token', pageToken] : []),
]

/**
 * 读通知会话里断点之后的消息（用负责人身份）。没有断点：只取最新一条建断点（首次开启从此刻读起，不处理旧通知）。
 * 返回 { messages, cursorInit?, readFrom }。翻页读到底；单次最多 maxPages 页（防失控），读不完下轮接着读。
 */
export const readNotificationMessages = async ({ chatId, cursor, now = Date.now(), run = runLarkCli, maxPages = 20 }) => {
  if (!cursor) {
    const latest = parseJson(await run(messagesArgs({ chatId, order: 'desc', pageSize: 1 }), AS_USER), '读通知会话')
    const message = (latest.data?.messages || [])[0]
    const position = Number(message?.message_position)
    return { messages: [], cursorInit: { position: Number.isFinite(position) ? position : 0, readFrom: new Date(now).toISOString() } }
  }
  // 断点时间读不出（旧版 / 手改坏了）：往前读一天，靠序号去重，不漏不重
  const fromMs = Date.parse(cursor.readFrom || '')
  const start = new Date((Number.isFinite(fromMs) ? fromMs : now - 24 * 60 * 60 * 1000) - CURSOR_LOOKBACK_MS).toISOString()
  const messages = []
  let pageToken = ''
  for (let page = 0; page < maxPages; page += 1) {
    const data = parseJson(await run(messagesArgs({ chatId, order: 'asc', pageSize: 50, start, pageToken }), AS_USER), '读通知会话').data || {}
    messages.push(...(data.messages || []))
    if (!data.has_more || !data.page_token) break
    pageToken = data.page_token
  }
  return { messages, readFrom: new Date(now).toISOString() }
}

const recordFields = (bug, defaults) => [
  bug.statusField, bug.assigneeField,
  bug.projectField || defaults.projectField, bug.titleField || defaults.titleField, bug.descField || defaults.descField,
  bug.bugNoField || defaults.bugNoField, bug.envField || defaults.envField, bug.portField || defaults.portField,
  bug.createdField || defaults.createdField, bug.screenshotField || defaults.screenshotField,
  bug.testResultField || defaults.testResultField, bug.retestResultField || defaults.retestResultField,
  bug.reopenCountField || defaults.reopenCountField, bug.remarkField || defaults.remarkField,
].filter(Boolean)

/** 按 filter 拉记录（翻页拉全，只投影需要的列）。 */
export const listBugRecords = async ({ bug, filter, defaults, run = runLarkCli, pageSize = 200, maxOffset = 20000 }) => {
  const all = []
  for (let offset = 0; offset <= maxOffset; offset += pageSize) {
    const args = ['base', '+record-list', '--base-token', bug.appToken, '--table-id', bug.tableId, '--filter-json', JSON.stringify(filter), '--format', 'json', '--limit', String(pageSize), '--offset', String(offset)]
    for (const field of recordFields(bug, defaults)) args.push('--field-id', field)
    const data = parseJson(await run(args), '读 bug 表').data || {}
    all.push(...parseColumnarRecords(data))
    if (!data.has_more) break
  }
  return all
}

// ── 入口失败 → 失败台账 / 自修工单（plan 4.8）─────────────────────

// 外部原因只告警不开单：网络 / 限流 / 登录身份 / 权限 / 本机缺 CLI / 超时。
const EXTERNAL_CLASSES = new Set(['transient_api', 'permission', 'tool_missing', 'timeout', 'stale_epoch', 'aborted'])
export const WATCH_SELF_FIX_AFTER = 3

/**
 * 某个入口（notify / locate / reconcile）失败一次：进失败台账；连续失败到 WATCH_SELF_FIX_AFTER 次、且不是外部原因，
 * 开一张「无任务」自修工单（执行 / 验收 / apply 复用 worker 的自修流程）。返回 { fingerprint, external, selfFix }。
 */
export const recordWatchFailure = ({
  entry,
  error,
  consecutive,
  context = '',
  now = Date.now(),
  ledgerDir = failuresDir,
  openSelfFix = maybeOpenSelfFix,
  logPath = process.env.LARK_LOG_FILE || null,
  log = console.log,
}) => {
  const fingerprint = fingerprintFailure(error)
  const taskId = `bugwatch-${entry}-${now}`
  const external = EXTERNAL_CLASSES.has(fingerprint.cls)
  recordFailure({ dir: ledgerDir, taskId, fingerprint, action: 'fail', reason: `bug 发现入口 ${entry} 第 ${consecutive} 次连续失败`, message: String(error?.message || error), now })
  if (external || consecutive < WATCH_SELF_FIX_AFTER) return { fingerprint, external, selfFix: null }
  const selfFix = openSelfFix({
    task: { id: taskId, source: 'bug-watch', project: null, text: `bug 发现入口「${entry}」连续 ${consecutive} 次失败（lark-bugtable-poller 两档调度，lib/lark-bug-watch*.mjs）。${context}`.slice(0, 400) },
    error,
    fingerprint,
    playbook: { action: 'fail' },
    recentSameFingerprint: countRecentFingerprint({ dir: ledgerDir, fingerprint: fingerprint.fingerprint, taskId, now }),
    priorAttempts: consecutive - 1,
    ledgerDir,
    workerLogPath: logPath,
    now,
    log,
  })
  return { fingerprint, external, selfFix }
}
