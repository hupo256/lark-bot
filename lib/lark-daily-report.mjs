/**
 * fameex 日报的生成与私发（只给 worker：要跑 git 子进程；aven 11-02「fameex 日报的先私发我」）。不跑模型，四节全由脚本算：
 *   1. 今天 bot 经手的事：任务库里今天建的 / 今天了结的，按群分组计数（做完 / 答了 / 没做成 / 在等 / 还在跑），没做成和在等的逐条列；
 *   2. bug 表：负责人 = 我的记录按状态计数；今天新分给我的、比上一份快照修好的 / 被打回的（快照记在状态文件里，只拿早于当天的当基线）；
 *   3. fameex-web 今天的提交：origin/test · pre · online 上今天的提交（只读本地远端引用，不 fetch），test 今天的提交还有几个没进 pre / online；
 *   4. 等你决定的：直接复用 09:30 汇总的 collectDigest（同一份数据）；
 *   5. 线上指标：准 / 快 / 省 / 反馈（lib/lark-live-scorecard，批 1.1），只在私发负责人那份里。
 * 读不到的节只说一句读不到，不挡日报。发送走负责人私信出口 sendPrincipalNote，定时那份幂等键 daily-YYYYMMDD；
 * 发出去之后才记账（runtime/lark-daily-report-state.json）。调度在 lib/lark-daily-schedule.mjs（gateway）。
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { BUGTABLE_FIELD_DEFAULTS, readStatusText } from './lark-bugtable-parse.mjs'
import { listBugRecords } from './lark-bug-watch-io.mjs'
import { collectDigest, renderDigest } from './lark-daily-digest.mjs'
import { dailySettings, dailyStatePath, localDateKey, localTimeOn, readDailyState, weekdayOf } from './lark-daily-schedule.mjs'
import { deliverableOf } from './lark-delivery.mjs'
import { writeJsonAtomic } from './lark-fs.mjs'
import { sendPrincipalNote, sendReply } from './lark-group-exit.mjs'
import { chatLabel, headline } from './lark-human-text.mjs'
import { resolveChatName, runLarkCli, runLarkCliRetrying } from './lark-cli.mjs'
import { envRef } from './lark-ops-task.mjs'
import { buildScorecard, collectLiveFacts, renderScorecard } from './lark-live-scorecard.mjs'
import { localHHMM } from './lark-outbox.mjs'
import { consumerRoot, larkTasksDir } from './lark-paths.mjs'

const MAX_COMMITS = 8
const MAX_ITEMS = 5
const MAX_BUG_IDS = 8
const KEEP_DAYS = 7
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const join2 = (items) => items.join('、')
const firstLine = (text) => String(text || '').trim().split('\n')[0].slice(0, 120)

// ── 1. 任务 ────────────────────────────────────────────────

const BUCKETS = [['done', '做完'], ['answered', '答了'], ['failed', '没做成'], ['waiting', '在等'], ['running', '还在跑']]
const STATUS_BUCKET = {
  done: 'done', done_with_warnings: 'done', done_pending_writeback: 'done', no_change_needed: 'done', answered: 'answered',
  failed: 'failed', intake_failed: 'failed', waiting_confirmation: 'waiting', blocked: 'waiting',
  received: 'running', queued: 'running', running: 'running', verifying: 'running',
}
// 归哪一栏；ignored / superseded（判不处理 / 结单）不算。回执没送达的按它要送的那个状态算；代答 / 实测做完算「答了」。
export const taskBucket = (task) => {
  const bucket = STATUS_BUCKET[task.status === 'result_pending_receipt' ? task.pendingReceipt?.status : task.status] || null
  return bucket === 'done' && ['answer', 'verification'].includes(deliverableOf(task)) ? 'answered' : bucket
}

// 今天建的或今天了结（最后更新在今天）的任务，日报任务自己不算；按群分组（chatLabel：任务记下的群名，老任务没记的按 chatNames 现查）。
export const summarizeTasks = ({ tasks, date, chatNames = {} }) => {
  const groups = new Map()
  for (const task of tasks) {
    const bucket = taskBucket(task)
    if (!bucket || task.commandType === 'daily') continue
    if (localDateKey(Date.parse(task.createdAt)) !== date && localDateKey(Date.parse(task.updatedAt)) !== date) continue
    const label = chatLabel(task, { chatNames })
    const group = groups.get(label) || { label, counts: {}, items: [] }
    group.counts[bucket] = (group.counts[bucket] || 0) + 1
    if (bucket === 'failed' || bucket === 'waiting') group.items.push(`${bucket === 'failed' ? '没做成' : '在等'}：${headline(task) || task.id}（${localHHMM(task.updatedAt || task.createdAt)}）`)
    groups.set(label, group)
  }
  return [...groups.values()]
}

const countText = (counts) => join2(BUCKETS.filter(([key]) => counts[key]).map(([key, label]) => `${label} ${counts[key]}`))

export const renderTaskSection = (groups) => {
  if (!groups.length) return ['今天没经手任务']
  const total = {}
  for (const group of groups) for (const [key, n] of Object.entries(group.counts)) total[key] = (total[key] || 0) + n
  const lines = [`今天经手 ${Object.values(total).reduce((sum, n) => sum + n, 0)} 件：${countText(total)}`]
  for (const group of groups) {
    lines.push(`- ${group.label}：${countText(group.counts)}`)
    lines.push(...group.items.slice(0, MAX_ITEMS).map((item) => `  · ${item}`))
    if (group.items.length > MAX_ITEMS) lines.push(`  · 还有 ${group.items.length - MAX_ITEMS} 条`)
  }
  return lines
}

// ── 2. bug 表 ──────────────────────────────────────────────

// 纯函数：records 是负责人 = 我的记录（parseColumnarRecords 形状）；baseline 是早于今天的最近一份快照（没有为 null）。
export const summarizeBugRecords = ({ records, bug, date, baseline }) => {
  const field = (key) => bug[key] || BUGTABLE_FIELD_DEFAULTS[key]
  const open = [bug.pendingValue, bug.rejectedValue, bug.inProgressValue].filter(Boolean)
  const notFixed = [...open, bug.waitingValue, bug.notIssueValue]
  const counts = new Map(open.map((status) => [status, 0]))
  const snapshot = {}
  const fresh = []
  const fixed = []
  const reopened = []
  for (const { record_id: id, fields } of records) {
    const status = readStatusText(fields[bug.statusField]).trim() || '没填状态'
    const no = readStatusText(fields[field('bugNoField')]) || id
    const reopen = Number(fields[field('reopenCountField')]) || 0
    counts.set(status, (counts.get(status) || 0) + 1)
    snapshot[id] = { status, reopen }
    if (String(fields[field('createdField')] || '').startsWith(date)) fresh.push(no)
    const prev = baseline?.[id]
    if (!prev) continue
    if (open.includes(prev.status) && !notFixed.includes(status)) fixed.push(no)
    if (reopen > prev.reopen || (status === bug.rejectedValue && prev.status !== status)) reopened.push(no)
  }
  const rest = [...counts].filter(([status]) => !open.includes(status)).sort((a, b) => b[1] - a[1])
  return { total: records.length, open: open.map((status) => [status, counts.get(status)]), rest, fresh, fixed, reopened, hasBaseline: Boolean(baseline), snapshot }
}

const idList = (ids) => (ids.length ? `（${join2(ids.slice(0, MAX_BUG_IDS))}${ids.length > MAX_BUG_IDS ? ' 等' : ''}）` : '')

export const renderBugSection = (bugs) => {
  if (!bugs.ok) return [`bug 表这次没读到：${bugs.reason}`]
  const lines = [`bug 表（我名下 ${bugs.total} 个）`, `- 还欠着：${join2(bugs.open.map(([status, n]) => `${status} ${n}`))}`]
  if (bugs.rest.length) lines.push(`- 其余：${join2(bugs.rest.map(([status, n]) => `${status} ${n}`))}`)
  const changes = bugs.hasBaseline
    ? `修好 ${bugs.fixed.length} 个${idList(bugs.fixed)}，被打回 ${bugs.reopened.length} 个${idList(bugs.reopened)}`
    : '修好 / 被打回从明天起才比得出来（今天第一次记）'
  lines.push(`- 今天：新分给我 ${bugs.fresh.length} 个${idList(bugs.fresh)}；${changes}`)
  return lines
}

// 读负责人 = 我的记录（复用 poller 的 listBugRecords，按人员列服务端过滤，只投影要用的列）。读不到返回 { ok: false, reason }。
export const collectBugFacts = async ({ config, date, baseline, runCli = runLarkCli }) => {
  const bug = config.bugTable
  const me = bug?.myOpenId || config.notifyOpenId
  if (!bug?.appToken || !me) return { ok: false, reason: '没配 bugTable / 负责人 open_id' }
  try {
    const records = await listBugRecords({
      bug: { appToken: bug.appToken, tableId: bug.tableId, statusField: bug.statusField, assigneeField: bug.assigneeField },
      filter: { logic: 'and', conditions: [[bug.assigneeField, 'intersects', [me]]] },
      defaults: { bugNoField: bug.bugNoField || BUGTABLE_FIELD_DEFAULTS.bugNoField, createdField: bug.createdField || BUGTABLE_FIELD_DEFAULTS.createdField, reopenCountField: bug.reopenCountField || BUGTABLE_FIELD_DEFAULTS.reopenCountField },
      run: runCli,
    })
    return { ok: true, ...summarizeBugRecords({ records, bug, date, baseline }) }
  } catch (error) {
    return { ok: false, reason: humanBugReadError(error?.message || error) }
  }
}

// 读不到 bug 表时给人看的原因：不贴 lark-cli 原始 JSON（11-02 真机日报里贴了半截报错）。
export const humanBugReadError = (raw) => {
  const text = String(raw || '')
  if (/HTTP (?:429|5\d\d)|rate ?limit|too many requests|invalid_response|network|timeout|ETIMEDOUT|ECONNRESET/i.test(text)) return '飞书接口这会儿不稳（限流 / 网络），重试了几次没读到；晚点私信我「重发日报」再看'
  if (/missing_scope|permission|forbidden|no permission/i.test(text)) return '没有读这张 bug 表的权限'
  const line = firstLine(text).replace(/\{.*$/, '').trim()
  return line ? line.slice(0, 80) : '原因不明'
}

// ── 3. fameex-web 提交 ─────────────────────────────────────

const defaultRun = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 60_000 })
const nextDate = (date) => localDateKey(localTimeOn(date, '00:00') + 36 * 60 * 60_000)
const ENVS = ['test', 'pre', 'online']

// 只读：本地远端引用上那天的非合并提交（提交时间落在那天），test 那天的提交按补丁比还有几个没进 pre / online。不 fetch。
export const collectGitFacts = ({ repo, date, run, mtimeOf }) => {
  const log = (extra) => {
    const out = run('git', ['-C', repo, 'log', '--no-merges', `--since=${date} 00:00`, `--until=${nextDate(date)} 00:00`, '--format=%h%x09%an%x09%s', ...extra])
    if (out.status !== 0) throw new Error(firstLine(out.stderr) || `git log 退出码 ${out.status}`)
    return String(out.stdout || '').split('\n').filter(Boolean).map((line) => line.split('\t'))
  }
  try {
    const branches = ENVS.map((env) => ({ env, commits: log([envRef(env)]).map(([, author, subject]) => ({ author, subject })) }))
    const notIn = Object.fromEntries(['pre', 'online'].map((env) => [env, log(['--cherry-pick', '--right-only', `${envRef(env)}...${envRef('test')}`]).length]))
    let fetchedAt = null
    try {
      fetchedAt = mtimeOf(resolve(repo, String(run('git', ['-C', repo, 'rev-parse', '--git-path', 'FETCH_HEAD']).stdout || '').trim()))
    } catch {
      // 没拉过 / 读不到时间就不写
    }
    return { ok: true, branches, notIn, fetchedAt }
  } catch (error) {
    return { ok: false, reason: firstLine(error?.message || error) }
  }
}

export const renderGitSection = (git) => {
  if (!git.ok) return [`fameex-web 提交这次没读到：${git.reason}`]
  const fetched = git.fetchedAt ? `（按 ${localDateKey(git.fetchedAt).slice(5)} ${localHHMM(git.fetchedAt)} 拉取的远端引用）` : ''
  const lines = [`fameex-web 今天的提交${fetched}`]
  for (const { env, commits } of git.branches) {
    if (!commits.length) {
      lines.push(`- ${env} 没有`)
      continue
    }
    lines.push(`- ${env} ${commits.length} 个${env === 'test' ? `，没进 pre ${git.notIn.pre} 个、没进 online ${git.notIn.online} 个` : ''}：`)
    lines.push(...commits.slice(0, MAX_COMMITS).map(({ author, subject }) => `  · ${subject}（${author}）`))
    if (commits.length > MAX_COMMITS) lines.push(`  · 还有 ${commits.length - MAX_COMMITS} 个`)
  }
  return lines
}

// ── 拼装 / 发送 ────────────────────────────────────────────

// withDigest=false：回到群里的那份不带「等你决定的」（那是给负责人一个人看的）。
export const renderDailyReport = ({ date, groups, bugs, git, digestText, withDigest = true, scorecardLines = null }) => [
  `fameex 日报 · ${date.slice(5)} ${WEEKDAYS[weekdayOf(date)]}`,
  '',
  ...renderTaskSection(groups),
  '',
  ...renderBugSection(bugs),
  '',
  ...renderGitSection(git),
  ...(withDigest ? ['', digestText || '等你决定的：没有'] : []),
  ...(withDigest && scorecardLines?.length ? ['', ...scorecardLines] : []),
].join('\n')

// 那天（本地时区）的线上指标节：读不到不挡日报，只说一句。taskCounts 用日报任务节同一口径。
export const scorecardSection = ({ date, groups, tasks, facts }) => {
  try {
    const range = { fromMs: localTimeOn(date, '00:00'), toMs: localTimeOn(nextDate(date), '00:00') }
    const counts = groups.reduce((acc, group) => {
      for (const [key, n] of Object.entries(group.counts)) acc[key] = (acc[key] || 0) + n
      return acc
    }, {})
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0)
    const summaries = new Map(tasks.map((task) => [task.id, headline(task) || null]))
    const card = buildScorecard({ range, ...facts(range.fromMs), taskCounts: { total, failed: counts.failed || 0 }, summaryOf: (id) => summaries.get(id) || null })
    return renderScorecard(card)
  } catch (error) {
    return [`线上指标这次没算出来：${firstLine(error?.message || error)}`]
  }
}

// 任务库只读：直接读 runtime/lark-tasks/*.json（不建 store——建 store 会把读坏的文件改名）。
export const readTaskFiles = (dir = larkTasksDir) => readdirSync(dir).filter((name) => name.endsWith('.json')).flatMap((name) => {
  try {
    return [JSON.parse(readFileSync(join(dir, name), 'utf8'))]
  } catch {
    return []
  }
})

// 只留最近几天（快照 / 已发记录按日期存）。
const keepRecent = (byDate = {}) => Object.fromEntries(Object.keys(byDate).sort().slice(-KEEP_DAYS).map((day) => [day, byDate[day]]))
// 基线 = 早于 date 的最近一份快照（当天重发 / 重试不拿自己当昨天）。
export const pickBaseline = (snapshots = {}, date) => snapshots[Object.keys(snapshots).filter((day) => day < date).sort().at(-1)] || null

const REAL_DEPS = { liveFacts: (sinceMs) => collectLiveFacts({ sinceMs }), readTasks: () => readTaskFiles(), repo: consumerRoot, run: defaultRun, mtimeOf: (path) => statSync(path).mtimeMs, runCli: (args) => runLarkCliRetrying(args), chatName: resolveChatName, send: sendPrincipalNote, sendGroup: sendReply, readState: () => readDailyState(), saveState: (state) => writeJsonAtomic(dailyStatePath(), state), now: () => Date.now() }

// worker 跑一条日报任务。scheduled：那天已发就不再发；manual：已发回一句「发过了」；force：照发。
// 手动的发在当天到点之后也算当天的日报（记账，19:00 那份不再发）；到点之前只是预览，不记账。返回 { status }。
// 负责人在群里要的（daily.postTo）：回到那条群消息，只带这个群经手的任务、不带「等你决定的」；群里没看过，不按「发过了」挡，也不记账。
export const runDailyReportTask = async ({ task, workerConfig, reportStatus, deps = {} }) => {
  const d = { ...REAL_DEPS, ...deps }
  const config = workerConfig?.localConfig || {}
  const { date, mode, postTo = null } = task.daily || {}
  const now = d.now()
  const state = d.readState()
  const done = (summary) => reportStatus('done', summary, undefined, undefined, undefined, { outcome: { kind: 'daily', summary, text: summary, blockers: [], warnings: [] } })
  const sentBefore = state.sent?.[date]
  if (sentBefore && mode !== 'force' && !postTo) {
    if (mode === 'manual') await d.send({ config, text: `${date.slice(5)} 的日报 ${localHHMM(sentBefore.at)} 已经发过了。要再发一份就回我「重发日报」。`, kind: 'daily', idempotencyKey: `daily-dup-${String(task.id).slice(-24)}` })
    await done('那天的日报已经发过，没重发')
    return { status: 'done' }
  }
  const bugs = await collectBugFacts({ config, date, baseline: pickBaseline(state.bugSnapshots, date), runCli: d.runCli })
  const tasks = postTo ? d.readTasks().filter((item) => item.chatId === postTo.chatId) : d.readTasks()
  // 11-02 之前的任务没记群名：群消息任务按 chat_id 现查一次（chat-list 有缓存），私信不查。
  const chatNames = {}
  for (const chatId of new Set(tasks.filter((item) => !item.chatName && item.chatType !== 'p2p').map((item) => item.chatId))) chatNames[chatId] = await d.chatName(chatId)
  const digestText = renderDigest(collectDigest({ store: { list: () => tasks }, now, chatNames }))
  const groups = summarizeTasks({ tasks, date, chatNames })
  const scorecardLines = postTo ? null : scorecardSection({ date, groups, tasks, facts: d.liveFacts })
  const text = renderDailyReport({ date, groups, bugs, git: collectGitFacts({ repo: d.repo, date, run: d.run, mtimeOf: d.mtimeOf }), digestText, withDigest: !postTo, scorecardLines })
  const ymd = date.replaceAll('-', '')
  const idempotencyKey = mode === 'scheduled' ? `daily-${ymd}` : `daily-${ymd}-${String(task.id).slice(-24)}`
  const sent = postTo
    ? await d.sendGroup({ config, task: { id: task.id, chatId: postTo.chatId, messageId: postTo.messageId, operator: task.operator, epoch: 0, summary: task.summary, replyTarget: { messageId: postTo.messageId, inThread: Boolean(postTo.inThread) } }, phase: 'done', text, idempotencyKey })
    : await d.send({ config, text, kind: 'daily', idempotencyKey })
  if (!sent.ok) {
    await reportStatus('failed', `日报没发出去：${sent.reason}`, undefined, undefined, undefined, { outcome: { kind: 'daily', summary: `日报没发出去：${sent.reason}`, blockers: [], warnings: [] } })
    return { status: 'failed' }
  }
  const official = !postTo && (mode === 'scheduled' || now >= localTimeOn(date, dailySettings(config).at))
  d.saveState({
    ...state,
    sent: official ? keepRecent({ ...state.sent, [date]: { at: new Date(now).toISOString(), messageId: sent.messageId || null } }) : state.sent || {},
    bugSnapshots: bugs.ok ? keepRecent({ ...state.bugSnapshots, [date]: bugs.snapshot }) : state.bugSnapshots || {},
  })
  await done(postTo ? '日报已回群' : '日报已私发')
  return { status: 'done' }
}
