/**
 * fameex 日报（aven 11-02「fameex 日报的先私发我」）：gateway 侧调度（lib/lark-daily-schedule.mjs）+ worker 侧生成与私发（lib/lark-daily-report.mjs）。
 * 配置校验、到点 / 补发 / 重试判断、私信指令、系统任务形状、四节内容（任务 / bug 表 / git / 等你决定）逐字钉住一份真实形状的样例、
 * 发送记账（定时 / 手动 / 重发 / 发送失败 / bug 表读不到）、worker 开工前出口与出口静默。不碰真实 git / lark-cli / 网络：全部注入。
 * 一个 it 合并全部段（测试棘轮）。状态 / 义务目录先指到临时目录再动态 import。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { eachCase, runSteps } from './support/steps.mjs'

const dir = mkdtempSync(join(tmpdir(), 'lark-daily-report-'))
process.env.LARK_RUNTIME_DIR = join(dir, 'runtime')
process.env.LARK_OBLIGATIONS_DIR = join(dir, 'obligations')
const schedule = await import('../lib/lark-daily-schedule.mjs')
const report = await import('../lib/lark-daily-report.mjs')
const { validateConfig } = await import('../lib/lark-config.mjs')
const { runPreExecutionGates } = await import('../lib/lark-ops-run.mjs')
const { resolveWorkContext } = await import('../lib/lark-work-context.mjs')
const { deliverOutcome } = await import('../lib/lark-delivery.mjs')
const { envRef } = await import('../lib/lark-ops-task.mjs')

const { buildDailyTask, decideDailyRun, staleDailyFailures, dueReportDate, dailySettings, maybeHandleDailyDirective, parseDailyDirective, readDailyState, startDailyReport } = schedule
const { collectBugFacts, humanBugReadError, collectGitFacts, pickBaseline, readTaskFiles, renderBugSection, renderDailyReport, renderGitSection, renderTaskSection, runDailyReportTask, summarizeBugRecords, summarizeTasks, taskBucket } = report

const at = (d, h, m = 0) => new Date(2026, 10, d, h, m).getTime() // 2026-11-d 本地时间；11-02 是周一
const iso = (d, h, m = 0) => new Date(at(d, h, m)).toISOString()
const DATE = '2026-11-02'
const ME = 'ou_me'
const BUG = { appToken: 'app', tableId: 'tbl', statusField: '处理状态', assigneeField: '负责RD', myOpenId: ME, pendingValue: '待处理', rejectedValue: '验退', inProgressValue: '修复中', doneValue: '待推版', waitingValue: '暂缓处理', notIssueValue: '不是问题' }
const CONFIG = { notifyOpenId: ME, bugTable: BUG }
const quiet = async (fn) => {
  const { log } = console
  console.log = () => {}
  try {
    return await fn()
  } finally {
    console.log = log
  }
}

// 一天的任务库（真实形状）：A 群做完 2 / 没做成 2（一条回执没送达）/ 还在跑 1；B 群（老任务没记群名）答了 1 / 在等 1（昨天建、今天更新、挂了 24h+）；
// 私信答了 1；判不处理的、日报任务自己、昨天了结的都不算。
const TASKS = [
  { id: 't1', status: 'done', chatId: 'oc_a', chatType: 'group', chatName: 'PR-02306 交易页', summary: '下单按钮间距', contract: { deliverable: 'change' }, createdAt: iso(2, 10), updatedAt: iso(2, 10, 30) },
  { id: 't2', status: 'done', chatId: 'oc_a', chatType: 'group', chatName: 'PR-02306 交易页', summary: '深度图颜色', contract: { deliverable: 'change' }, createdAt: iso(2, 11), updatedAt: iso(2, 11, 20) },
  { id: 't3', status: 'failed', chatId: 'oc_a', chatType: 'group', chatName: 'PR-02306 交易页', summary: '合约下单按钮置灰', createdAt: iso(2, 13), updatedAt: iso(2, 14, 20) },
  { id: 't4', status: 'done', chatId: 'oc_b', chatType: 'group', summary: '活动接口字段含义', contract: { deliverable: 'answer' }, createdAt: iso(2, 15), updatedAt: iso(2, 15, 10) },
  { id: 't5', status: 'waiting_confirmation', chatId: 'oc_b', chatType: 'group', summary: '充值弹窗文案要不要改', contract: { deliverable: 'change' }, createdAt: iso(1, 18), parkedAt: iso(1, 18), updatedAt: iso(2, 9, 15) },
  { id: 't6', status: 'answered', chatId: 'oc_dm', chatType: 'p2p', summary: 'pre 现在是哪个版本', createdAt: iso(2, 16), updatedAt: iso(2, 16, 1) },
  { id: 't7', status: 'ignored', chatId: 'oc_a', chatType: 'group', chatName: 'PR-02306 交易页', summary: '闲聊', createdAt: iso(2, 12), updatedAt: iso(2, 12) },
  { id: 't8', status: 'done', commandType: 'daily', chatId: ME, chatType: 'p2p', summary: '日报', createdAt: iso(2, 8), updatedAt: iso(2, 8) },
  { id: 't9', status: 'done', chatId: 'oc_a', chatType: 'group', chatName: 'PR-02306 交易页', summary: '昨天的活', createdAt: iso(1, 10), updatedAt: iso(1, 11) },
  { id: 't10', status: 'result_pending_receipt', pendingReceipt: { status: 'failed' }, chatId: 'oc_a', chatType: 'group', chatName: 'PR-02306 交易页', summary: '登录页白屏', createdAt: iso(2, 16), updatedAt: iso(2, 17, 5) },
  { id: 't11', status: 'queued', chatId: 'oc_a', chatType: 'group', chatName: 'PR-02306 交易页', summary: '资产页对齐', createdAt: iso(2, 18, 50), updatedAt: iso(2, 18, 50) },
]
const CHAT_NAMES = { oc_b: '活动页群' }
const TASK_LINES = [
  '今天经手 8 件：做完 2、答了 2、没做成 2、在等 1、还在跑 1',
  '- PR-02306 交易页：做完 2、没做成 2、还在跑 1',
  '  · 没做成：合约下单按钮置灰（14:20）',
  '  · 没做成：登录页白屏（17:05）',
  '- 活动页群：答了 1、在等 1',
  '  · 在等：充值弹窗文案要不要改（09:15）',
  '- 私信：答了 1',
]

// bug 表（负责人 = 我）：列式返回 + 昨天的快照。
const sel = (status) => (status ? [status] : [])
const ROWS = [
  ['rec1', '修复中', 'BUG-1', '2026-10-20T10:00:00.000+04:00', 0],
  ['rec2', '待推版', 'BUG-2', '2026-10-21T10:00:00.000+04:00', 0],
  ['rec3', '不是问题', 'BUG-3', '2026-10-22T10:00:00.000+04:00', 0],
  ['rec4', '验退', 'BUG-4', '2026-10-23T10:00:00.000+04:00', 1],
  ['rec5', '修复中', 'BUG-5', '2026-10-24T10:00:00.000+04:00', 2],
  ['rec6', '已完成', 'BUG-6', '2026-10-25T10:00:00.000+04:00', 0],
  ['rec7', '验退', 'BUG-7', '2026-10-26T10:00:00.000+04:00', 1],
  ['rec8', '待处理', 'BUG-8', '2026-11-02T10:00:00.000+04:00', null],
  ['rec9', '', null, '2026-10-27T10:00:00.000+04:00', null],
  ['rec10', '暂缓处理', 'BUG-10', '2026-10-28T10:00:00.000+04:00', 0],
  ['rec11', '已推版', 'BUG-11', '2026-10-29T10:00:00.000+04:00', 0],
  ['rec12', '已完成', 'BUG-12', '2026-10-30T10:00:00.000+04:00', 0],
]
const RECORDS = ROWS.map(([id, status, no, created, reopen]) => ({ record_id: id, fields: { 处理状态: sel(status), bug编号: no, 创建时间: created, 重开次数: reopen } }))
const BASELINE = {
  rec1: { status: '待处理', reopen: 0 }, rec2: { status: '修复中', reopen: 0 }, rec3: { status: '待处理', reopen: 0 }, rec4: { status: '已推版', reopen: 1 },
  rec5: { status: '修复中', reopen: 1 }, rec6: { status: '已完成', reopen: 0 }, rec7: { status: '验退', reopen: 1 }, rec10: { status: '待处理', reopen: 0 },
  rec11: { status: '验退', reopen: 0 }, rec12: { status: '已完成', reopen: 0 },
}
const BUG_LINES = [
  'bug 表（我名下 12 个）',
  '- 还欠着：待处理 1、验退 2、修复中 2',
  '- 其余：已完成 2、待推版 1、不是问题 1、没填状态 1、暂缓处理 1、已推版 1',
  '- 今天：新分给我 1 个（BUG-8）；修好 2 个（BUG-2、BUG-11），被打回 2 个（BUG-4、BUG-5）',
]
const bugPage = (rows = ROWS) => ({ code: 0, stdout: JSON.stringify({ ok: true, data: { fields: ['处理状态', 'bug编号', '创建时间', '重开次数'], data: rows.map(([, status, no, created, reopen]) => [sel(status), no, created, reopen]), record_id_list: rows.map(([id]) => id), has_more: false } }), stderr: '' })
const fakeCli = (result = bugPage()) => {
  const calls = []
  return { calls, run: async (args) => (calls.push(args), result) }
}

// git：test 今天 2 个（1 个没进 pre、2 个没进 online），pre 1 个，online 没有；FETCH_HEAD 18:40。
const REPO = '/r/fameex-web'
const GIT_OUT = {
  'origin/test': 'b27\tKai.b\tfix: loading\nd5c\taven\t修复登录页白屏\n',
  'origin/pre': 'b27\tKai.b\tfix: loading\n',
  'origin/online': '',
  'origin/pre...origin/test': 'd5c\taven\t修复登录页白屏\n',
  'origin/online...origin/test': 'b27\tKai.b\tfix: loading\nd5c\taven\t修复登录页白屏\n',
}
const fakeGit = (table = GIT_OUT) => {
  const calls = []
  const run = (cmd, args) => {
    calls.push([cmd, ...args])
    if (args.includes('rev-parse')) return { status: 0, stdout: '.git/FETCH_HEAD\n', stderr: '' }
    const out = table[args.at(-1)]
    return out == null ? { status: 128, stdout: '', stderr: `fatal: bad revision '${args.at(-1)}'\nmore` } : { status: 0, stdout: out, stderr: '' }
  }
  return { run, calls }
}
const GIT_LINES = [
  'fameex-web 今天的提交（按 11-02 18:40 拉取的远端引用）',
  '- test 2 个，没进 pre 1 个、没进 online 2 个：',
  '  · fix: loading（Kai.b）',
  '  · 修复登录页白屏（aven）',
  '- pre 1 个：',
  '  · fix: loading（Kai.b）',
  '- online 没有',
]
const DIGEST_TEXT = '等你决定的 1 条\n等材料超 24h：\n- 充值弹窗文案要不要改（活动页群）· 18:00'
const REPORT = ['fameex 日报 · 11-02 周一', '', ...TASK_LINES, '', ...BUG_LINES, '', ...GIT_LINES, '', DIGEST_TEXT].join('\n')

// runDailyReportTask 的假件：记下发送 / 记账 / 回写。
const harness = ({ state = {}, now = at(2, 19, 5), sendResult = { ok: true, messageId: 'om_daily' }, cli = fakeCli(), git = fakeGit(), config = CONFIG } = {}) => {
  const sends = []
  const saves = []
  const statuses = []
  const deps = {
    readTasks: () => TASKS,
    repo: REPO,
    run: git.run,
    mtimeOf: (path) => (path === resolve(REPO, '.git/FETCH_HEAD') ? at(2, 18, 40) : 0),
    runCli: cli.run,
    chatName: async (chatId) => CHAT_NAMES[chatId] || '',
    send: async (args) => (sends.push(args), sendResult),
    sendGroup: async (args) => (sends.push({ ...args, group: true }), sendResult),
    readState: () => state,
    saveState: (next) => saves.push(next),
    now: () => now,
  }
  const run = (daily, id = 'daily-20261102-a1') => runDailyReportTask({ task: { id, daily }, workerConfig: { localConfig: config }, reportStatus: async (...args) => statuses.push(args), deps })
  return { run, sends, saves, statuses, deps }
}
const gitFacts = () => collectGitFacts({ repo: REPO, date: DATE, run: fakeGit().run, mtimeOf: () => at(2, 18, 40) })

describe('fameex 日报', () => {
  it('配置 / 调度 / 私信指令 / 四节内容 / 发送记账 / worker 出口', () => runSteps([
    ['validateConfig：dailyReport 可不配；形状不对拒绝启动', () => eachCase([
      { name: '不配', config: {}, bad: false },
      { name: '全配（0 和 6 都是合法的周几）', config: { dailyReport: { enabled: false, at: '19:00', days: [0, 6] } }, bad: false },
      { name: '只配 at', config: { dailyReport: { at: '09:30' } }, bad: false },
      { name: '数组', config: { dailyReport: [] }, bad: 'dailyReport' },
      { name: '字符串', config: { dailyReport: '19:00' }, bad: 'dailyReport' },
      { name: 'enabled 非布尔', config: { dailyReport: { enabled: 'yes' } }, bad: 'dailyReport.enabled' },
      { name: 'at 少一位', config: { dailyReport: { at: '7:00' } }, bad: 'dailyReport.at' },
      { name: 'at 24 点', config: { dailyReport: { at: '24:00' } }, bad: 'dailyReport.at' },
      { name: 'at 60 分', config: { dailyReport: { at: '19:60' } }, bad: 'dailyReport.at' },
      { name: 'days 空', config: { dailyReport: { days: [] } }, bad: 'dailyReport.days' },
      { name: 'days 7', config: { dailyReport: { days: [7] } }, bad: 'dailyReport.days' },
      { name: 'days -1', config: { dailyReport: { days: [-1] } }, bad: 'dailyReport.days' },
      { name: 'days 小数', config: { dailyReport: { days: [1.5] } }, bad: 'dailyReport.days' },
      { name: 'days 字符串', config: { dailyReport: { days: '1' } }, bad: 'dailyReport.days' },
    ], ({ config, bad }) => {
      const errors = validateConfig({ project: 'PR-1', notifyOpenId: ME, ...config }).errors.filter((error) => error.startsWith('dailyReport'))
      assert.deepEqual(errors.map((error) => error.split(' ')[0]), bad ? [bad] : [], errors.join('；'))
    })],
    ['dailySettings：缺省开、19:00、周一到周五；enabled=false 关', () => {
      assert.deepEqual(dailySettings({}), { enabled: true, at: '19:00', days: [1, 2, 3, 4, 5] })
      assert.deepEqual(dailySettings({ dailyReport: { enabled: false, at: '18:30', days: [6] } }), { enabled: false, at: '18:30', days: [6] })
    }],
    ['dueReportDate：今天到点 → 今天；没到点补昨天（不满 24h）；周末不是日报日', () => eachCase([
      { name: '周一 18:59 没到点，周日不是日报日', now: at(2, 18, 59), want: null },
      { name: '周一 19:00 恰好到点', now: at(2, 19), want: '2026-11-02' },
      { name: '周二 18:59 补周一', now: at(3, 18, 59), want: '2026-11-02' },
      { name: '周二 19:00 发周二', now: at(3, 19), want: '2026-11-03' },
      { name: '周六 18:59 补周五', now: new Date(2026, 9, 31, 18, 59).getTime(), want: '2026-10-30' },
      { name: '周六 19:00 周五恰好满 24h，不补', now: new Date(2026, 9, 31, 19).getTime(), want: null },
      { name: '周日 10:00 周六不是日报日', now: at(1, 10), want: null },
      { name: '配了周六、09:30', now: new Date(2026, 9, 31, 9, 30).getTime(), settings: { days: [6], at: '09:30' }, want: '2026-10-31' },
    ], ({ now, want, settings }) => assert.equal(dueReportDate({ settings: { days: [1, 2, 3, 4, 5], at: '19:00', ...settings }, now }), want))],
    ['decideDailyRun：已发 / 有在跑或已了结的一次 / 失败满 3 次 / 上次失败不满 10 分钟都不建；别的日期、手动的、非日报任务不算', () => {
      const now = at(2, 19, 30)
      const run = (extra) => ({ commandType: 'daily', daily: { date: DATE, mode: 'scheduled' }, status: 'failed', updatedAt: iso(2, 19, 1), ...extra })
      return eachCase([
        { name: '关了', config: { dailyReport: { enabled: false } }, want: null },
        { name: '暂停了', paused: true, want: null },
        { name: '没到点', now: at(2, 18), want: null },
        { name: '那天已发', state: { sent: { [DATE]: { at: iso(2, 19) } } }, want: null },
        { name: '第一次', want: { date: DATE, attempt: 1 } },
        { name: '无关任务不算', tasks: [run({ commandType: 'ops', status: 'queued' }), run({ daily: { date: DATE, mode: 'manual' }, status: 'queued' }), run({ daily: { date: '2026-10-30', mode: 'scheduled' }, status: 'queued' })], want: { date: DATE, attempt: 1 } },
        { name: '有一次在排队', tasks: [run({ status: 'queued' })], want: null },
        { name: '有一次已完成', tasks: [run({ status: 'done' })], want: null },
        { name: '失败 1 次、隔了 29 分钟', tasks: [run()], want: { date: DATE, attempt: 2 } },
        { name: '失败 2 次、隔了 10 分钟整', tasks: [run(), run({ updatedAt: iso(2, 19, 20) })], want: { date: DATE, attempt: 3 } },
        { name: '上次失败才 9 分钟', tasks: [run({ updatedAt: iso(2, 19, 21) })], want: null },
        { name: '失败满 3 次', tasks: [run(), run(), run()], want: null },
      ], ({ config = CONFIG, state = {}, tasks = [], want, paused = false, ...item }) => assert.deepEqual(decideDailyRun({ config, state, tasks, now: item.now || now, paused }), want))
    }],
    ['buildDailyTask：定时 / 私信触发两种形状', () => {
      assert.deepEqual(buildDailyTask({ config: CONFIG, date: DATE, mode: 'scheduled', attempt: 2, now: at(2, 19) }), {
        id: 'daily-20261102-a2', source: 'system', chatId: ME, chatType: 'p2p', messageId: null, operator: ME, project: null, commandType: 'daily', commandTypeSource: 'explicit',
        text: '日报 2026-11-02（scheduled）', summary: '日报 2026-11-02', attachments: [], addressedToBot: true, fromPrincipal: true, status: 'queued', intake: null,
        contract: { deliverable: 'daily', source: 'daily' }, daily: { date: DATE, mode: 'scheduled', attempt: 2 }, createdAt: iso(2, 19),
      })
      const task = buildDailyTask({ config: CONFIG, date: DATE, mode: 'force', msg: { messageId: 'om_1', chatId: 'oc_dm' }, now: at(2, 15) })
      assert.deepEqual([task.id, task.chatId, task.messageId, task.daily], ['om_1', 'oc_dm', 'om_1', { date: DATE, mode: 'force', attempt: null }])
    }],
    ['parseDailyDirective：只认整句', () => eachCase([
      ['发日报', { mode: 'manual' }], [' 发日报。', { mode: 'manual' }], ['补发日报!', { mode: 'manual' }], ['重发日报', { mode: 'force' }], ['再发日报～', { mode: 'force' }],
      ['日报怎么没发', null], ['发日报给我看看', null], ['帮我发日报', null], ['', null], [null, null],
      // 11-05 b3：群里 @bot「今天日报发一下」（@ 名字已剥）、「项目已经上线。暂停日报生成、发送，啥时候开再通知你」
      ['今天日报发一下', { mode: 'manual' }], ['日报发下', { mode: 'manual' }], ['发一下今天的日报', { mode: 'manual' }], ['今天的日报补发', { mode: 'manual' }],
      ['<p>项目已经上线。暂停日报生成、发送，啥时候开再通知你 </p>', { mode: 'pause' }], ['日报先别发了', { mode: 'pause' }], ['停掉日报', { mode: 'pause' }], ['关闭日报', { mode: 'pause' }],
      ['恢复日报', { mode: 'resume' }], ['日报重新开吧', { mode: 'resume' }], ['继续发日报', { mode: 'resume' }],
      ['能不能暂停日报？', null], ['日报要恢复吗', null], ['今天日报发了没', null], ['暂停', null],
    ].map(([text, want]) => ({ name: String(text), text, want })), ({ text, want }) => assert.deepEqual(parseDailyDirective(text), want))],
    ['maybeHandleDailyDirective：只认负责人本人（私信，或群里 @ 了机器人），排今天的日报任务；群里要的记 postTo 回群；暂停 / 恢复改暂停文件并回一句', () => quiet(() => eachCase([
      { name: '负责人私信', msg: { chatType: 'p2p', senderOpenId: ME, text: '重发日报', messageId: 'om_r', chatId: 'oc_dm' }, want: [['om_r', { date: DATE, mode: 'force', attempt: null }]] },
      { name: '负责人在群里没 @ 机器人', msg: { chatType: 'group', senderOpenId: ME, text: '发日报', messageId: 'om_g', chatId: 'oc_a' }, want: null },
      { name: '负责人在群里 @ 机器人', msg: { chatType: 'group', senderOpenId: ME, text: '今天日报发一下', messageId: 'om_g', chatId: 'oc_a', threadId: 'omt_1', mentions: [{ id: 'ou_bot' }] }, want: [['om_g', { date: DATE, mode: 'manual', attempt: null, postTo: { chatId: 'oc_a', messageId: 'om_g', inThread: true } }]] },
      { name: '别人在群里 @ 机器人', msg: { chatType: 'group', senderOpenId: 'ou_x', text: '发日报', messageId: 'om_g2', chatId: 'oc_a', mentions: [{ id: 'ou_bot' }] }, want: null },
      { name: '别人私信', msg: { chatType: 'p2p', senderOpenId: 'ou_x', text: '发日报', messageId: 'om_x', chatId: 'oc_x' }, want: null },
      { name: '负责人私信问话', msg: { chatType: 'p2p', senderOpenId: ME, text: '日报发了吗', messageId: 'om_q', chatId: 'oc_dm' }, want: null },
    ], async ({ msg, want }) => {
      const upserts = []
      const handled = await maybeHandleDailyDirective({ msg, config: { ...CONFIG, botOpenId: 'ou_bot' }, store: { upsert: (task) => (upserts.push(task), task) }, now: at(2, 15) })
      assert.equal(handled, Boolean(want))
      assert.deepEqual(upserts.map((task) => [task.id, task.daily]), want || [])
    }).then(async () => {
      const pausePath = join(dir, 'pause.json')
      const said = []
      const deps = { pausePath, sendReply: async (args) => (said.push(['group', args.task.chatId, args.task.replyTarget, args.phase, args.text, args.idempotencyKey]), { ok: true }), sendPrincipalNote: async (args) => (said.push(['dm', args.text, args.idempotencyKey]), { ok: true }) }
      const upserts = []
      const store = { upsert: (task) => (upserts.push(task), task) }
      const cfg = { ...CONFIG, botOpenId: 'ou_bot', dailyReport: { at: '18:30' } }
      assert.equal(await maybeHandleDailyDirective({ msg: { chatType: 'group', senderOpenId: ME, text: '项目已经上线。暂停日报生成、发送，啥时候开再通知你', messageId: 'om_p', chatId: 'oc_a', mentions: [{ id: 'ou_bot' }] }, config: cfg, store, now: at(2, 15), deps }), true)
      assert.equal(schedule.readDailyPause(pausePath), true)
      assert.deepEqual(readDailyState(pausePath), { paused: true, at: iso(2, 15), by: ME })
      assert.equal(await maybeHandleDailyDirective({ msg: { chatType: 'p2p', senderOpenId: ME, text: '恢复日报', messageId: 'om_u', chatId: 'oc_dm' }, config: cfg, store, now: at(3, 9), deps }), true)
      assert.equal(schedule.readDailyPause(pausePath), false)
      assert.equal(await maybeHandleDailyDirective({ msg: { chatType: 'p2p', senderOpenId: ME, text: '恢复日报', messageId: 'om_u2', chatId: 'oc_dm' }, config: cfg, store, now: at(3, 9), deps }), true, '没暂停也能说恢复')
      assert.deepEqual(said, [
        ['group', 'oc_a', { messageId: 'om_p', inThread: false }, 'notice', '好，日报停了：定时的不再生成、不再发。要恢复跟我说「恢复日报」；临时要一份就说「发日报」。', 'om_p-daily-pause'],
        ['dm', '好，日报恢复了，照常 18:30 发。', 'om_u-daily-resume'],
        ['dm', '好，日报恢复了，照常 18:30 发。', 'om_u2-daily-resume'],
      ])
      assert.deepEqual(upserts, [], '暂停 / 恢复不建任务')
    }))],
    ['startDailyReport：到点建一次定时任务，排着的时候不再建；状态文件读不到当空', () => quiet(() => {
      const tasks = []
      const store = { list: () => tasks, upsert: (task) => (tasks.push({ ...task, updatedAt: iso(2, 19) }), task) }
      const pausedTicker = startDailyReport({ config: CONFIG, store, readState: () => ({}), readPause: () => true, clock: () => at(2, 19) })
      try {
        assert.equal(pausedTicker.tick(), null, '暂停了不建')
      } finally {
        pausedTicker.stop()
      }
      const ticker = startDailyReport({ config: CONFIG, store, readState: () => ({}), readPause: () => false, clock: () => at(2, 19) })
      try {
        assert.equal(ticker.tick().id, 'daily-20261102-a1')
        assert.equal(ticker.tick(), null)
        assert.deepEqual(tasks.map((task) => task.daily), [{ date: DATE, mode: 'scheduled', attempt: 1 }])
      } finally {
        ticker.stop()
      }
      // 11-04 事故：同日前两次网络失败、第 3 次发出 → 下一分钟把前两次结单；发出后才失败的（重发失败）、别的日期、非日报不动。
      const failed = (id, date, failedAt, extra = {}) => ({ id, commandType: 'daily', status: 'failed', daily: { date, mode: 'scheduled' }, updatedAt: failedAt, ...extra })
      const stale = [
        failed('daily-20261104-a1', '2026-11-04', iso(4, 19, 7)),
        failed('daily-20261104-a2', '2026-11-04', iso(4, 19, 28)),
        failed('om_force', '2026-11-04', iso(4, 20)),
        failed('daily-20261103-a1', '2026-11-03', iso(3, 19, 7)),
        failed('other', '2026-11-04', iso(4, 19, 7), { commandType: 'fix' }),
        { ...failed('daily-20261104-a3', '2026-11-04', iso(4, 19, 39)), status: 'done' },
      ]
      const sentState = { sent: { '2026-11-04': { at: iso(4, 19, 39) } } }
      assert.deepEqual(staleDailyFailures({ state: sentState, tasks: stale }).map(({ task }) => task.id), ['daily-20261104-a1', 'daily-20261104-a2'])
      assert.deepEqual(staleDailyFailures({ state: {}, tasks: stale }), [])
      const closed = []
      const staleStore = { list: () => stale, upsert: () => assert.fail('已发不建'), closeAsExternallyResolved: (args) => (closed.push(args), { task: {} }) }
      const staleTicker = startDailyReport({ config: CONFIG, store: staleStore, readState: () => sentState, readPause: () => false, clock: () => at(5, 9) })
      try {
        assert.equal(staleTicker.tick(), null)
        assert.deepEqual(closed.map(({ id, closureReason, operator }) => [id, closureReason, operator]), [
          ['daily-20261104-a1', 'completed_elsewhere', 'daily-schedule'],
          ['daily-20261104-a2', 'completed_elsewhere', 'daily-schedule'],
        ])
        assert.match(closed[0].note, /^2026-11-04 的日报已在 \d\d:\d\d 由后续一次发出，本次失败作废。$/)
      } finally {
        staleTicker.stop()
      }
      assert.deepEqual(readDailyState(join(dir, 'missing.json')), {})
      const broken = join(dir, 'broken.json')
      writeFileSync(broken, '{')
      assert.deepEqual(readDailyState(broken), {})
      writeFileSync(broken, '{"sent":{"2026-11-02":{"at":"x"}}}')
      assert.deepEqual(readDailyState(broken), { sent: { [DATE]: { at: 'x' } } })
    })],
    ['taskBucket：状态 → 栏；回执没送达按要送的状态；代答 / 实测做完算答了', () => eachCase([
      [{ status: 'done' }, 'done'], [{ status: 'no_change_needed' }, 'done'], [{ status: 'done_pending_writeback' }, 'done'], [{ status: 'answered' }, 'answered'],
      [{ status: 'done', contract: { deliverable: 'answer' } }, 'answered'], [{ status: 'done', contract: { deliverable: 'verification' } }, 'answered'],
      [{ status: 'failed', contract: { deliverable: 'answer' } }, 'failed'], [{ status: 'intake_failed' }, 'failed'], [{ status: 'blocked' }, 'waiting'],
      [{ status: 'received' }, 'running'], [{ status: 'verifying' }, 'running'], [{ status: 'result_pending_receipt', pendingReceipt: { status: 'done' } }, 'done'],
      [{ status: 'ignored' }, null], [{ status: 'superseded' }, null],
    ].map(([task, want]) => ({ name: JSON.stringify(task), task, want })), ({ task, want }) => assert.equal(taskBucket(task), want))],
    ['summarizeTasks + renderTaskSection：样例一天逐字', () => {
      assert.deepEqual(renderTaskSection(summarizeTasks({ tasks: TASKS, date: DATE, chatNames: CHAT_NAMES })), TASK_LINES)
      assert.deepEqual(renderTaskSection([]), ['今天没经手任务'])
    }],
    ['renderTaskSection：每群最多列 5 条，多的说还有几条', () => {
      const group = (n) => ({ label: 'A', counts: { failed: n }, items: Array.from({ length: n }, (_, i) => `没做成：x${i}（10:00）`) })
      assert.equal(renderTaskSection([group(5)]).at(-1), '  · 没做成：x4（10:00）')
      assert.deepEqual(renderTaskSection([group(6)]).slice(-2), ['  · 没做成：x4（10:00）', '  · 还有 1 条'])
    }],
    ['summarizeBugRecords + renderBugSection：样例逐字；没有基线时说明', () => {
      const summary = summarizeBugRecords({ records: RECORDS, bug: BUG, date: DATE, baseline: BASELINE })
      assert.deepEqual(renderBugSection({ ok: true, ...summary }), BUG_LINES)
      assert.deepEqual(summary.snapshot.rec5, { status: '修复中', reopen: 2 })
      assert.deepEqual(summary.snapshot.rec9, { status: '没填状态', reopen: 0 })
      const first = renderBugSection({ ok: true, ...summarizeBugRecords({ records: RECORDS, bug: BUG, date: DATE, baseline: null }) })
      assert.equal(first.at(-1), '- 今天：新分给我 1 个（BUG-8）；修好 / 被打回从明天起才比得出来（今天第一次记）')
      assert.deepEqual(renderBugSection({ ok: false, reason: '没配 bugTable / 负责人 open_id' }), ['bug 表这次没读到：没配 bugTable / 负责人 open_id'])
      // 读不到的原因说人话，不贴 lark-cli 原始 JSON（11-02 真机）
      const flaky = '飞书接口这会儿不稳（限流 / 网络），重试了几次没读到；晚点私信我「重发日报」再看'
      for (const raw of ['读 bug 表 失败：{ "ok": false, "error": { "subtype": "invalid_response", "message": "SDK returned' , 'TAT response (HTTP 429)', 'HTTP 503', 'rate limit', 'Too Many Requests', 'network down', 'timeout', 'ETIMEDOUT', 'ECONNRESET']) assert.equal(humanBugReadError(raw), flaky, raw)
      for (const raw of ['missing_scope: base:record', 'permission denied', 'Forbidden', 'no permission']) assert.equal(humanBugReadError(raw), '没有读这张 bug 表的权限', raw)
      assert.equal(humanBugReadError('读 bug 表 失败：{ "ok": false }'), '读 bug 表 失败：')
      assert.equal(humanBugReadError(`字段不存在${'x'.repeat(100)}`), `字段不存在${'x'.repeat(75)}`)
      assert.equal(humanBugReadError('{ "a": 1 }'), '原因不明')
      assert.equal(humanBugReadError(null), '原因不明')
      const fresh = (n) => renderBugSection({ ok: true, total: n, open: [], rest: [], fresh: Array.from({ length: n }, (_, i) => `B${i}`), fixed: [], reopened: [], hasBaseline: true }).at(-1)
      assert.equal(fresh(8), '- 今天：新分给我 8 个（B0、B1、B2、B3、B4、B5、B6、B7）；修好 0 个，被打回 0 个')
      assert.equal(fresh(9), '- 今天：新分给我 9 个（B0、B1、B2、B3、B4、B5、B6、B7 等）；修好 0 个，被打回 0 个')
    }],
    ['summarizeBugRecords：配了自定义列名就用它；没 bug 编号用 record_id', () => {
      const records = [{ record_id: 'recX', fields: { 状态: ['待推版'], 编号: null, 建于: '2026-11-02T09:00:00+04:00', 重开: 0 } }]
      const summary = summarizeBugRecords({ records, bug: { ...BUG, statusField: '状态', bugNoField: '编号', createdField: '建于', reopenCountField: '重开' }, date: DATE, baseline: { recX: { status: '待处理', reopen: 0 } } })
      assert.deepEqual([summary.fresh, summary.fixed], [['recX'], ['recX']])
    }],
    ['collectBugFacts：按负责人列服务端过滤、只投影要用的列；myOpenId 缺省用 notifyOpenId；读不到 / 没配说原因', async () => {
      const cli = fakeCli()
      const facts = await collectBugFacts({ config: CONFIG, date: DATE, baseline: BASELINE, runCli: cli.run })
      assert.deepEqual(renderBugSection(facts), BUG_LINES)
      const args = cli.calls[0]
      assert.equal(args[args.indexOf('--filter-json') + 1], JSON.stringify({ logic: 'and', conditions: [['负责RD', 'intersects', [ME]]] }))
      assert.deepEqual(args.filter((_, i) => args[i - 1] === '--field-id'), ['处理状态', '负责RD', 'bug编号', '创建时间', '重开次数'])
      assert.deepEqual(args.slice(0, 6), ['base', '+record-list', '--base-token', 'app', '--table-id', 'tbl'])
      const fallback = fakeCli()
      await collectBugFacts({ config: { notifyOpenId: 'ou_n', bugTable: { ...BUG, myOpenId: undefined } }, date: DATE, baseline: null, runCli: fallback.run })
      assert.match(fallback.calls[0][fallback.calls[0].indexOf('--filter-json') + 1], /"ou_n"/)
      const denied = await collectBugFacts({ config: CONFIG, date: DATE, baseline: null, runCli: fakeCli({ code: 0, stdout: '{"ok":false,"error":{"type":"permission","message":"no access"}}', stderr: '' }).run })
      assert.deepEqual(denied, { ok: false, reason: '没有读这张 bug 表的权限' })
      // 抛出来的不是 Error 而是字符串也照样认
      assert.deepEqual(await collectBugFacts({ config: CONFIG, date: DATE, baseline: null, runCli: async () => { throw 'missing_scope' } }), { ok: false, reason: '没有读这张 bug 表的权限' })
      assert.deepEqual(await collectBugFacts({ config: { notifyOpenId: ME }, date: DATE, runCli: fakeCli().run }), { ok: false, reason: '没配 bugTable / 负责人 open_id' })
      assert.deepEqual(await collectBugFacts({ config: { bugTable: { ...BUG, myOpenId: undefined } }, date: DATE, runCli: fakeCli().run }), { ok: false, reason: '没配 bugTable / 负责人 open_id' })
    }],
    ['collectGitFacts + renderGitSection：只读那天的提交、补丁比没进 pre / online、FETCH_HEAD 时间', () => {
      const git = fakeGit()
      const facts = collectGitFacts({ repo: REPO, date: DATE, run: git.run, mtimeOf: (path) => (path === resolve(REPO, '.git/FETCH_HEAD') ? at(2, 18, 40) : 0) })
      assert.deepEqual(renderGitSection(facts), GIT_LINES)
      assert.deepEqual(git.calls[0], ['git', '-C', REPO, 'log', '--no-merges', '--since=2026-11-02 00:00', '--until=2026-11-03 00:00', '--format=%h%x09%an%x09%s', 'origin/test'])
      assert.deepEqual(git.calls[3].slice(-3), ['--cherry-pick', '--right-only', 'origin/pre...origin/test'])
      assert.equal(git.calls.some((call) => call.includes('fetch')), false)
      assert.equal(envRef('online'), 'origin/online')
    }],
    ['collectGitFacts：git 失败说原因（没 stderr 说退出码）；FETCH_HEAD 读不到就不写时间', () => {
      assert.deepEqual(collectGitFacts({ repo: REPO, date: DATE, run: fakeGit({ ...GIT_OUT, 'origin/pre': undefined }).run, mtimeOf: () => 0 }), { ok: false, reason: "fatal: bad revision 'origin/pre'" })
      assert.deepEqual(collectGitFacts({ repo: REPO, date: DATE, run: () => ({ status: 1, stdout: '', stderr: '' }) }), { ok: false, reason: 'git log 退出码 1' })
      const facts = collectGitFacts({ repo: REPO, date: DATE, run: fakeGit().run, mtimeOf: () => { throw new Error('ENOENT') } })
      assert.equal(renderGitSection(facts)[0], 'fameex-web 今天的提交')
      assert.deepEqual(renderGitSection({ ok: false, reason: 'x' }), ['fameex-web 提交这次没读到：x'])
    }],
    ['renderGitSection：每个环境最多列 8 个', () => {
      const commits = (n) => Array.from({ length: n }, (_, i) => ({ author: 'a', subject: `s${i}` }))
      const lines = (n) => renderGitSection({ ok: true, branches: [{ env: 'pre', commits: commits(n) }], notIn: {}, fetchedAt: null })
      assert.equal(lines(8).at(-1), '  · s7（a）')
      assert.deepEqual(lines(9).slice(-2), ['  · s7（a）', '  · 还有 1 个'])
    }],
    ['renderDailyReport：四节拼起来逐字；没有要决定的说没有', () => {
      const groups = summarizeTasks({ tasks: TASKS, date: DATE, chatNames: CHAT_NAMES })
      const bugs = { ok: true, ...summarizeBugRecords({ records: RECORDS, bug: BUG, date: DATE, baseline: BASELINE }) }
      assert.equal(renderDailyReport({ date: DATE, groups, bugs, git: gitFacts(), digestText: DIGEST_TEXT }), REPORT)
      assert.equal(renderDailyReport({ date: DATE, groups, bugs, git: gitFacts(), digestText: '' }).split('\n').at(-1), '等你决定的：没有')
    }],
    ['readTaskFiles / pickBaseline：坏文件跳过；基线只取早于当天的', () => {
      const tasksDir = join(dir, 'tasks')
      mkdirSync(tasksDir, { recursive: true })
      writeFileSync(join(tasksDir, 'a.json'), '{"id":"a"}')
      writeFileSync(join(tasksDir, 'b.json'), '{')
      writeFileSync(join(tasksDir, 'c.txt'), '{"id":"c"}')
      assert.deepEqual(readTaskFiles(tasksDir), [{ id: 'a' }])
      const snapshots = { '2026-10-30': { a: 1 }, '2026-11-01': { b: 1 }, '2026-11-02': { c: 1 } }
      assert.deepEqual(pickBaseline(snapshots, DATE), { b: 1 })
      assert.equal(pickBaseline(snapshots, '2026-10-30'), null)
      assert.equal(pickBaseline(undefined, DATE), null)
    }],
    ['runDailyReportTask 定时：生成逐字、键 daily-YYYYMMDD、发出去才记账（已发 + bug 快照，只留 7 天）、回写 done', async () => {
      const old = Object.fromEntries(['10-24', '10-25', '10-26', '10-27', '10-28', '10-29', '10-30'].map((day) => [`2026-${day}`, { at: 'x' }]))
      const h = harness({ state: { sent: old, bugSnapshots: { '2026-11-01': BASELINE } } })
      assert.deepEqual(await h.run({ date: DATE, mode: 'scheduled' }), { status: 'done' })
      assert.deepEqual(h.sends.map(({ text, kind, idempotencyKey, config }) => [text, kind, idempotencyKey, config]), [[REPORT, 'daily', 'daily-20261102', CONFIG]])
      const [saved] = h.saves
      assert.deepEqual(Object.keys(saved.sent), ['2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', DATE])
      assert.deepEqual(saved.sent[DATE], { at: iso(2, 19, 5), messageId: 'om_daily' })
      assert.deepEqual(Object.keys(saved.bugSnapshots), ['2026-11-01', DATE])
      assert.deepEqual(saved.bugSnapshots[DATE].rec2, { status: '待推版', reopen: 0 })
      assert.deepEqual(h.statuses.map((args) => [args[0], args[1], args[5].outcome.summary]), [['done', '日报已私发', '日报已私发']])
    }],
    ['runDailyReportTask 已发过：定时不发；「发日报」回一句发过了；「重发日报」照发（键带任务 id）', async () => {
      const state = { sent: { [DATE]: { at: iso(2, 19, 1), messageId: 'om_old' } }, bugSnapshots: { '2026-11-01': BASELINE } }
      const scheduled = harness({ state })
      await scheduled.run({ date: DATE, mode: 'scheduled' })
      assert.deepEqual([scheduled.sends.length, scheduled.saves.length, scheduled.statuses[0][1]], [0, 0, '那天的日报已经发过，没重发'])
      const manual = harness({ state })
      await manual.run({ date: DATE, mode: 'manual' }, 'om_0123456789abcdefghijklmnopqrstuvwxyz')
      assert.deepEqual(manual.sends.map(({ text, idempotencyKey }) => [text, idempotencyKey]), [['11-02 的日报 19:01 已经发过了。要再发一份就回我「重发日报」。', 'daily-dup-cdefghijklmnopqrstuvwxyz']])
      assert.deepEqual([manual.saves.length, manual.statuses[0][0]], [0, 'done'])
      const force = harness({ state })
      await force.run({ date: DATE, mode: 'force' }, 'om_0123456789abcdefghijklmnopqrstuvwxyz')
      assert.deepEqual(force.sends.map(({ text, idempotencyKey }) => [text, idempotencyKey]), [[REPORT, 'daily-20261102-cdefghijklmnopqrstuvwxyz']])
      assert.deepEqual(force.saves[0].sent[DATE].messageId, 'om_daily')
    }],
    ['runDailyReportTask 群里要的（postTo）：回那条群消息、只带这个群的任务、不带「等你决定的」；那天发过也照发；不记已发', async () => {
      const state = { sent: { [DATE]: { at: iso(2, 19, 1), messageId: 'om_old' } } }
      const h = harness({ state })
      assert.deepEqual(await h.run({ date: DATE, mode: 'manual', postTo: { chatId: 'oc_b', messageId: 'om_ask', inThread: true } }, 'om_ask'), { status: 'done' })
      const [sent] = h.sends
      assert.deepEqual([sent.group, sent.phase, sent.task.chatId, sent.task.replyTarget, sent.idempotencyKey], [true, 'done', 'oc_b', { messageId: 'om_ask', inThread: true }, 'daily-20261102-om_ask'])
      assert.match(sent.text, /^fameex 日报 · 11-02 周一\n\n今天经手 2 件[^\n]*\n- 活动页群：/)
      assert.doesNotMatch(sent.text, /PR-02306|等你决定的/)
      assert.deepEqual([h.saves[0].sent, h.statuses[0][1]], [state.sent, '日报已回群'])
    }],
    ['runDailyReportTask 手动：到点前只是预览不记已发（快照照记）；到点那一刻起算当天的日报', async () => {
      const prior = { sent: { '2026-10-30': { at: 'x' } } }
      const early = harness({ state: prior, now: at(2, 18, 59) })
      await early.run({ date: DATE, mode: 'manual' }, 'om_m')
      assert.deepEqual(early.saves[0].sent, prior.sent)
      assert.deepEqual(Object.keys(early.saves[0].bugSnapshots), [DATE])
      const onTime = harness({ state: prior, now: at(2, 19) })
      await onTime.run({ date: DATE, mode: 'manual' }, 'om_m')
      assert.deepEqual(Object.keys(onTime.saves[0].sent), ['2026-10-30', DATE])
      const fresh = harness({ now: at(2, 15) })
      await fresh.run({ date: DATE, mode: 'manual' }, 'om_m')
      assert.deepEqual(fresh.saves[0].sent, {})
    }],
    ['runDailyReportTask：发送失败回写 failed、不记账；bug 表读不到照发、旧快照留着；私信任务不查群名', async () => {
      const failed = harness({ sendResult: { ok: false, reason: 'lark-cli 超时' } })
      assert.deepEqual(await failed.run({ date: DATE, mode: 'scheduled' }), { status: 'failed' })
      assert.deepEqual([failed.saves.length, failed.statuses[0][0], failed.statuses[0][1]], [0, 'failed', '日报没发出去：lark-cli 超时'])
      const snapshots = { '2026-11-01': BASELINE }
      const noBug = harness({ state: { bugSnapshots: snapshots }, cli: fakeCli({ code: 1, stdout: '', stderr: 'network down' }) })
      await noBug.run({ date: DATE, mode: 'scheduled' })
      assert.match(noBug.sends[0].text, /\nbug 表这次没读到：飞书接口这会儿不稳（限流 \/ 网络），重试了几次没读到；晚点私信我「重发日报」再看\n/)
      assert.deepEqual(noBug.saves[0].bugSnapshots, snapshots)
      const empty = harness({ cli: fakeCli({ code: 1, stdout: '', stderr: 'x' }) })
      await empty.run({ date: DATE, mode: 'scheduled' })
      assert.deepEqual(empty.saves[0].bugSnapshots, {})
      const looked = []
      const named = harness()
      named.deps.chatName = async (chatId) => (looked.push(chatId), '别的名字')
      await named.run({ date: DATE, mode: 'scheduled' })
      assert.deepEqual(looked, ['oc_b'])
      assert.match(named.sends[0].text, /\n- 别的名字：答了 1、在等 1\n/)
    }],
    ['worker 出口：日报任务走开工前出口（不跑模型）；路由单独一条；网关出口对日报不说话', async () => {
      const h = harness()
      const handled = await runPreExecutionGates({ task: { id: 'daily-20261102-a1', daily: { date: DATE, mode: 'scheduled' } }, workContext: { daily: true }, workerConfig: { localConfig: CONFIG }, reportStatus: async () => {}, dailyDeps: h.deps })
      assert.deepEqual([handled, h.sends.length], [true, 1])
      const ctx = resolveWorkContext({ localConfig: CONFIG }, buildDailyTask({ config: CONFIG, date: DATE, mode: 'scheduled', attempt: 1 }))
      assert.deepEqual(ctx, { cwd: join(process.env.LARK_RUNTIME_DIR, 'lark-daily-report'), projectId: '(daily)', projectName: '日报', projectDocs: [], readOnly: true, daily: true })
      assert.equal(resolveWorkContext({ localConfig: CONFIG }, { commandType: 'status', text: '状态：x' }).daily, undefined)
      const sent = []
      const task = buildDailyTask({ config: CONFIG, date: DATE, mode: 'scheduled', attempt: 1 })
      const out = await deliverOutcome({ config: CONFIG, task: { ...task, status: 'done', outcome: { summary: '日报已私发' } }, status: 'done', deps: { sendMarkdown: async (args) => (sent.push(args), { ok: true }) } })
      assert.deepEqual([out, sent.length], [{ ok: true, messageId: null, reason: null }, 0])
    }],
  ]))
})
