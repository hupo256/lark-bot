import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  dueActions,
  formatModeSwitch,
  initialWatchState,
  isWorkTime,
  maybeAutoOff,
  normalizeWatchConfig,
  notificationsAfter,
  onNewBugs,
  parseBugNotification,
  pickNotifiedRecord,
  reconcileAgainstBaseline,
  setWatchMode,
  tickClock,
  titleProbe,
  workDayMs,
  workMsBetween,
} from '../lib/lark-bug-watch.mjs'
import { listBugRecords, loadWatchState, readNotificationMessages, recordWatchFailure, saveWatchState } from '../lib/lark-bug-watch-io.mjs'
import { runWatchRound } from '../lib/lark-bug-watch-round.mjs'
import { validateConfig } from '../lib/lark-config.mjs'
import { runSteps } from './support/steps.mjs'

// aven 2026-11-01 B2：读新 bug 通知 + 对账替代整表轮询，平时 / 测试中两档
const MIN = 60_000
const HOUR = 60 * MIN
// 本地时间 = UTC+4（迪拜）；2026-11-02 是周一
const at = (local) => Date.parse(`${local}+04:00`)
const cfg = normalizeWatchConfig({ enabled: true, notifyChatId: 'oc_notify', utcOffsetMin: 240 })
const card = (position, project, title) => ({ message_id: `om_${position}`, message_position: String(position), create_time: '2026-11-02 10:00', content: `<card title="你有一个新的Bug，请注意查收">\n需求ID：${project}\n问题：${title}\n\n请及时修复\n` })
const BUG = { appToken: 'app', tableId: 'tbl', statusField: '处理状态', assigneeField: '负责RD', pendingValue: '待处理', rejectedValue: '验退', titleField: '问题标题', projectField: '项目ID', myOpenId: 'ou_me' }
const rec = (id, { title = 't', status = '待处理', mine = true, project = 'PR-02233' } = {}) => ({ record_id: id, fields: { 问题标题: title, 处理状态: status, 负责RD: mine ? [{ id: 'ou_me' }] : [{ id: 'ou_x' }], 项目ID: project } })

describe('bug 发现两档调度（读通知 + 对账）', () => {
  let dir
  const hooks = { before: () => { dir = mkdtempSync(join(tmpdir(), 'bug-watch-')) }, after: () => rmSync(dir, { recursive: true, force: true }) }

  const roundDeps = ({ messages = [], records = [], fail = null, cursorInit = null } = {}) => {
    const calls = { dm: [], handled: [], saved: 0, filters: [], failures: [] }
    return {
      calls,
      deps: {
        readMessages: async () => {
          if (fail === 'notify') throw new Error('Unexpected token < in JSON at position 0')
          return cursorInit ? { messages: [], cursorInit } : { messages, readFrom: '2026-11-02T06:00:00.000Z' }
        },
        listRecords: async ({ filter }) => {
          if (fail === 'reconcile' && filter.conditions[0][0] === '处理状态') throw new Error('reconcile boom')
          calls.filters.push(filter)
          return typeof records === 'function' ? records(filter) : records
        },
        listTasks: async () => new Map(),
        handleRecords: async ({ records: list }) => { calls.handled.push(...list.map((r) => r.record_id)); return { enqueued: list.length } },
        save: () => { calls.saved += 1 },
        dm: async (text) => { calls.dm.push(text) },
        recordFailure: (args) => { calls.failures.push(args); return { external: false, selfFix: { opened: args.consecutive >= 3, id: 'sf-x' } } },
      },
    }
  }

  it('调度、时钟、通知解析、定位、对账、IO、整轮', () => runSteps([
    ['配置：默认值、时间窗、间隔换算；没开 / 没配通知会话', () => {
      const d = normalizeWatchConfig(undefined, { localOffsetMin: 0 })
      assert.equal(d.enabled, false)
      assert.deepEqual([d.workStartMin, d.workEndMin, d.utcOffsetMin], [590, 1150, 0])
      assert.deepEqual([d.testing.notifyWorkMs, d.testing.notifyOffMs, d.testing.reconcileMs, d.idle.notifyMs, d.idle.reconcileMs, d.autoOffWorkDays, d.tickMs], [MIN, 10 * MIN, 15 * MIN, 60 * MIN, 120 * MIN, 1, MIN])
      const custom = normalizeWatchConfig({ enabled: true, notifyChatId: ' oc_a ', workHours: ['9:00', '18:00'], testing: { notifyWorkMin: 2 }, idle: { reconcileMin: 30 }, autoOffWorkDays: 2, utcOffsetMin: 480, tickMs: 5000 })
      assert.deepEqual([custom.notifyChatId, custom.workStartMin, custom.workEndMin, custom.testing.notifyWorkMs, custom.testing.notifyOffMs, custom.idle.reconcileMs, custom.autoOffWorkDays, custom.utcOffsetMin, custom.tickMs], ['oc_a', 540, 1080, 2 * MIN, 10 * MIN, 30 * MIN, 2, 480, 5000])
      assert.equal(normalizeWatchConfig({ workHours: ['x', 'y'], testing: { notifyWorkMin: -1 } }).workStartMin, 590)
      assert.equal(normalizeWatchConfig({ testing: { notifyWorkMin: -1 } }).testing.notifyWorkMs, MIN)
      assert.equal(normalizeWatchConfig({ notifyChatId: 7 }).notifyChatId, '')
    }],
    ['工作时间：周一到周五 09:50–19:10（本地），边界与周末', () => {
      assert.equal(isWorkTime(at('2026-11-02T09:50:00'), cfg), true)
      assert.equal(isWorkTime(at('2026-11-02T09:49:00'), cfg), false)
      assert.equal(isWorkTime(at('2026-11-02T19:09:00'), cfg), true)
      assert.equal(isWorkTime(at('2026-11-02T19:10:00'), cfg), false)
      assert.equal(isWorkTime(at('2026-11-06T12:00:00'), cfg), true, '周五')
      assert.equal(isWorkTime(at('2026-11-07T12:00:00'), cfg), false, '周六')
      assert.equal(isWorkTime(at('2026-11-08T12:00:00'), cfg), false, '周日')
      assert.equal(workDayMs(cfg), (9 * 60 + 20) * MIN)
      assert.equal(workMsBetween(at('2026-11-02T08:00:00'), at('2026-11-02T10:50:00'), cfg), HOUR)
      assert.equal(workMsBetween(at('2026-11-06T18:10:00'), at('2026-11-09T10:50:00'), cfg), 2 * HOUR, '周五尾 1h + 周一头 1h，周末不算')
      assert.equal(workMsBetween(at('2026-11-02T12:00:00'), at('2026-11-02T12:00:00'), cfg), 0)
      assert.equal(workMsBetween(at('2026-11-02T12:00:00'), at('2026-11-03T12:00:00'), cfg), workDayMs(cfg))
    }],
    ['到期：平时 60 / 120 分钟；测试中工作时间 1、其他 10、对账 15；没配通知会话不读通知', () => {
      const idle = { ...initialWatchState(0), lastNotifyReadAt: at('2026-11-02T10:00:00'), lastReconcileAt: at('2026-11-02T10:00:00') }
      assert.deepEqual(dueActions(idle, at('2026-11-02T10:59:00'), cfg), { notify: false, reconcile: false })
      assert.deepEqual(dueActions(idle, at('2026-11-02T11:00:00'), cfg), { notify: true, reconcile: false })
      assert.deepEqual(dueActions(idle, at('2026-11-02T12:00:00'), cfg), { notify: true, reconcile: true })
      const testing = { ...idle, mode: 'testing' }
      assert.deepEqual(dueActions(testing, at('2026-11-02T10:01:00'), cfg), { notify: true, reconcile: false })
      assert.deepEqual(dueActions(testing, at('2026-11-02T10:15:00'), cfg), { notify: true, reconcile: true })
      const night = { ...testing, lastNotifyReadAt: at('2026-11-02T20:00:00'), lastReconcileAt: at('2026-11-02T20:00:00') }
      assert.equal(dueActions(night, at('2026-11-02T20:09:00'), cfg).notify, false)
      assert.equal(dueActions(night, at('2026-11-02T20:10:00'), cfg).notify, true)
      assert.equal(dueActions(testing, at('2026-11-02T10:01:00'), { ...cfg, notifyChatId: '' }).notify, false)
    }],
    ['时钟：只在测试中累计工作时间；间隔超过 5 个 tick（合盖 / 睡眠）这段不算', () => {
      const t0 = at('2026-11-02T10:00:00')
      const testing = { ...initialWatchState(t0), mode: 'testing' }
      const a = tickClock(testing, t0 + MIN, cfg)
      assert.equal(a.quietWorkMs, MIN)
      assert.equal(a.lastTickAt, t0 + MIN)
      assert.equal(tickClock(a, t0 + MIN + 2 * HOUR, cfg).quietWorkMs, MIN, '睡了 2 小时不计')
      assert.equal(tickClock(a, t0 + 6 * MIN, cfg).quietWorkMs, 6 * MIN, '正好 5 个 tick 仍计')
      assert.equal(tickClock({ ...testing, mode: 'idle' }, t0 + MIN, cfg).quietWorkMs, 0)
      assert.equal(tickClock({ ...testing, lastTickAt: undefined }, t0, cfg).quietWorkMs, 0)
    }],
    ['新通知转测试中（保留本轮已读时间）；测试中再来不重复转；一个工作日没新的自动回平时', () => {
      const t0 = at('2026-11-02T10:00:00')
      const idle = { ...initialWatchState(t0), lastNotifyReadAt: t0, lastReconcileAt: t0 - MIN, quietWorkMs: 5 }
      const on = onNewBugs(idle, 2, t0)
      assert.equal(on.switched, 'on')
      assert.equal(on.state.mode, 'testing')
      assert.deepEqual([on.state.lastNotifyReadAt, on.state.lastReconcileAt, on.state.quietWorkMs], [t0, t0 - MIN, 0])
      assert.equal(on.state.lastNewBugAt, new Date(t0).toISOString())
      assert.equal(onNewBugs(on.state, 1, t0 + MIN).switched, null)
      assert.equal(onNewBugs(idle, 0, t0).state, idle)
      const quiet = { ...on.state, quietWorkMs: workDayMs(cfg) - 1 }
      assert.equal(maybeAutoOff(quiet, cfg, t0).switched, null)
      const off = maybeAutoOff({ ...quiet, quietWorkMs: workDayMs(cfg) }, cfg, t0)
      assert.equal(off.switched, 'off')
      assert.equal(off.state.mode, 'idle')
      assert.equal(maybeAutoOff({ ...idle, quietWorkMs: workDayMs(cfg) * 9 }, cfg, t0).switched, null)
      const manual = setWatchMode(idle, 'testing', t0)
      assert.deepEqual([manual.mode, manual.lastNotifyReadAt, manual.lastReconcileAt], ['testing', 0, 0], '手动开测试中：两个入口立刻跑')
      assert.equal(setWatchMode(manual, 'testing', t0 + 1), manual)
      assert.equal(setWatchMode(manual, 'idle', t0).lastNotifyReadAt, 0)
    }],
    ['通知解析：只认新 bug 卡片；断点之后按序号升序；没断点全给（调用方首轮只建断点）', () => {
      const n = parseBugNotification(card(281, 'pr-02233', ' 邮箱 限频后报错 '))
      assert.deepEqual(n, { messageId: 'om_281', position: 281, project: 'PR-02233', title: '邮箱 限频后报错', createTime: '2026-11-02 10:00' })
      assert.equal(parseBugNotification({ content: '普通消息' }), null)
      assert.deepEqual(parseBugNotification({ content: '你有一个新的Bug', message_position: 'x' }), { messageId: '', position: null, project: '', title: '', createTime: '' })
      const list = notificationsAfter([card(283, 'PR-1001', 'b'), { content: 'hi', message_position: '284' }, card(281, 'PR-1001', 'a'), card(282, 'PR-1001', 'c')], { position: 281 })
      assert.deepEqual(list.map((x) => x.position), [282, 283])
      assert.equal(notificationsAfter([card(1, 'PR-1001', 'a')], null).length, 1)
      assert.equal(notificationsAfter([{ content: '你有一个新的Bug', message_position: 'x' }], null).length, 0)
    }],
    ['定位：标题去空白完全一致且分给我才算；0 / 多条不猜；粗筛关键词取最长一段', () => {
      const readTitle = (r) => r.fields.问题标题
      const isMine = (r, id) => r.fields.负责RD.some((p) => p.id === id)
      const records = [rec('r1', { title: 'web-邮箱 限频后报错' }), rec('r2', { title: 'pre-web-邮箱限频后报错' }), rec('r3', { title: 'pre-web-邮箱限频后报错', mine: false })]
      assert.equal(pickNotifiedRecord({ records, title: 'pre-web-邮箱 限频后报错', myOpenId: 'ou_me', readTitle, isMine }).record.record_id, 'r2')
      assert.deepEqual(pickNotifiedRecord({ records, title: '别的', myOpenId: 'ou_me', readTitle, isMine }), { reason: 'none', count: 0 })
      assert.deepEqual(pickNotifiedRecord({ records: [records[1], { ...records[1], record_id: 'r4' }], title: 'pre-web-邮箱限频后报错', myOpenId: 'ou_me', readTitle, isMine }), { reason: 'multiple', count: 2 })
      assert.equal(titleProbe('pre-web-邮箱触发风控-限频后，安全验证要求窗口'), 'pre-web-邮箱触发风控-限频后')
      assert.equal(titleProbe('短，题'), '短，题')
      assert.equal(titleProbe('a'.repeat(50)).length, 30)
    }],
    ['对账：第一次只建基线不开工；之后新记录、状态变了的才处理，同一变化只处理一次', () => {
      const readStatus = (r) => r.fields.处理状态
      const first = reconcileAgainstBaseline({ baseline: null, records: [rec('r1'), rec('r2', { status: '验退' })], readStatus, now: 1000 })
      assert.deepEqual([first.created, first.actionable, first.baseline.statuses], [true, [], { r1: '待处理', r2: '验退' }])
      const second = reconcileAgainstBaseline({ baseline: first.baseline, records: [rec('r1', { status: '验退' }), rec('r2', { status: '验退' }), rec('r3')], readStatus })
      assert.deepEqual(second.actionable.map((r) => r.record_id), ['r1', 'r3'])
      assert.equal(second.created, false)
      assert.equal(second.baseline.at, first.baseline.at)
      assert.deepEqual(reconcileAgainstBaseline({ baseline: second.baseline, records: [rec('r1', { status: '验退' })], readStatus }).actionable, [])
    }],
    ['文案：转测试中带项目和频率；回平时带怎么提前开', () => {
      assert.equal(formatModeSwitch({ switched: 'on', notification: { project: 'PR-1', title: 'x' }, cfg }), '读到新 bug 通知：PR-1「x」\nbug 发现转「测试中」：\n- 读通知：工作时间每 1 分钟，其他时间每 10 分钟\n- 对账：每 15 分钟')
      assert.equal(formatModeSwitch({ switched: 'off', cfg }), '连续 1 个工作日没有新 bug 通知，bug 发现回「平时」：\n- 读通知：每 60 分钟\n- 对账：每 120 分钟\n要提前开回：私信我「开始测试」，或 lark-bot poll-on。')
      assert.match(formatModeSwitch({ switched: 'on', cfg }), /\?「」/)
    }],
    ['状态落盘：没有文件给初始状态；损坏改名留证并标记要私信', () => {
      const path = join(dir, 'w.json')
      assert.equal(loadWatchState({ path, now: 5 }).mode, 'idle')
      saveWatchState({ ...initialWatchState(5), mode: 'testing' }, { path })
      assert.equal(loadWatchState({ path }).mode, 'testing')
      writeFileSync(path, '{bad')
      const recovered = loadWatchState({ path, now: 9 })
      assert.equal(recovered.recoveredFromCorrupt, true)
      assert.equal(recovered.mode, 'idle')
      assert.ok(readdirSync(dir).includes('w.json.corrupt-9'))
      assert.ok(!existsSync(path))
    }],
    ['读通知会话：没断点只取最新一条建断点；有断点从断点读起时间回退 2 分钟、翻页读到底；失败抛错', async () => {
      const calls = []
      const run = async (args) => {
        calls.push(args)
        if (args.includes('desc')) return { code: 0, stdout: JSON.stringify({ data: { messages: [{ message_position: '300' }] } }) }
        const page = args.includes('--page-token') ? 2 : 1
        return { code: 0, stdout: JSON.stringify({ data: { messages: [card(300 + page, 'PR-1', 'x')], has_more: page === 1, page_token: page === 1 ? 'tok' : '' } }) }
      }
      const init = await readNotificationMessages({ chatId: 'oc_n', cursor: null, now: 1000, run })
      assert.deepEqual(init, { messages: [], cursorInit: { position: 300, readFrom: new Date(1000).toISOString() } })
      assert.ok(calls[0].includes('--as') && calls[0].includes('user'), '用负责人身份读')
      const read = await readNotificationMessages({ chatId: 'oc_n', cursor: { position: 300, readFrom: '2026-11-02T06:00:00.000Z' }, now: 5000, run })
      assert.deepEqual(read.messages.map((m) => m.message_position), ['301', '302'])
      assert.equal(read.readFrom, new Date(5000).toISOString())
      assert.equal(calls[1][calls[1].indexOf('--start') + 1], '2026-11-02T05:58:00.000Z')
      assert.equal(calls[2][calls[2].indexOf('--page-token') + 1], 'tok')
      const empty = await readNotificationMessages({ chatId: 'oc_n', cursor: null, run: async () => ({ code: 0, stdout: '{"data":{"messages":[]}}' }) })
      assert.equal(empty.cursorInit.position, 0)
      await assert.rejects(readNotificationMessages({ chatId: 'oc_n', cursor: { position: 1, readFrom: 'x' }, run: async () => ({ code: 1, stderr: 'auth expired' }) }), /读通知会话 失败/)
      await assert.rejects(readNotificationMessages({ chatId: 'oc_n', cursor: null, run: async () => ({ code: 0, stdout: '<html>' }) }), /不是 JSON/)
      let capped = 0
      await readNotificationMessages({ chatId: 'oc_n', cursor: { position: 1, readFrom: '2026-11-02T06:00:00.000Z' }, maxPages: 2, run: async () => { capped += 1; return { code: 0, stdout: JSON.stringify({ data: { messages: [], has_more: true, page_token: 't' } }) } } })
      assert.equal(capped, 2, '单次最多读 maxPages 页')
    }],
    ['拉记录：带过滤与投影列，翻页拉全', async () => {
      const calls = []
      const run = async (args) => {
        calls.push(args)
        const offset = Number(args[args.indexOf('--offset') + 1])
        return { code: 0, stdout: JSON.stringify({ data: { fields: ['问题标题'], record_id_list: [`r${offset}`], data: [['t']], has_more: offset === 0 } }) }
      }
      const records = await listBugRecords({ bug: BUG, filter: { logic: 'and', conditions: [['项目ID', '==', 'PR-1']] }, defaults: { titleField: '问题标题' }, run, pageSize: 1 })
      assert.deepEqual(records.map((r) => r.record_id), ['r0', 'r1'])
      assert.equal(calls[0][calls[0].indexOf('--filter-json') + 1], '{"logic":"and","conditions":[["项目ID","==","PR-1"]]}')
      assert.ok(calls[0].includes('--field-id') && calls[0].includes('问题标题') && calls[0].includes('负责RD'))
    }],
    ['入口失败：都进失败台账；外部原因 / 不到 3 次不开自修；连续 3 次且非外部开「无任务」工单', () => {
      const ledgerDir = join(dir, 'failures')
      const opened = []
      const openSelfFix = (args) => { opened.push(args); return { opened: true, id: 'sf-1' } }
      const net = recordWatchFailure({ entry: 'notify', error: new Error('fetch failed ECONNRESET'), consecutive: 5, ledgerDir, openSelfFix, now: 1 })
      assert.deepEqual([net.external, net.selfFix], [true, null])
      assert.equal(recordWatchFailure({ entry: 'notify', error: new Error('Cannot read properties of undefined'), consecutive: 2, ledgerDir, openSelfFix, now: 2 }).selfFix, null)
      const code = recordWatchFailure({ entry: 'reconcile', error: new Error('Cannot read properties of undefined'), consecutive: 3, context: '模式 testing', ledgerDir, openSelfFix, now: 3, logPath: '/tmp/poller.log' })
      assert.equal(code.selfFix.id, 'sf-1')
      assert.equal(opened.length, 1)
      assert.equal(opened[0].task.source, 'bug-watch')
      assert.match(opened[0].task.text, /入口「reconcile」连续 3 次失败.*模式 testing/)
      assert.deepEqual([opened[0].priorAttempts, opened[0].playbook.action, opened[0].workerLogPath], [2, 'fail', '/tmp/poller.log'])
      assert.equal(opened[0].recentSameFingerprint, 1, '前一次同指纹（不同时间 = 不同任务）算复发')
      assert.equal(readdirSync(ledgerDir).length, 1)
    }],
    ['整轮·首轮：建断点、建对账基线并私信，不开工', async () => {
      const { calls, deps } = roundDeps({ cursorInit: { position: 300, readFrom: 'x' }, records: [rec('r1'), rec('r2', { status: '验退' }), rec('r3', { mine: false })] })
      const { state, report } = await runWatchRound({ config: { bugTable: BUG }, cfg, state: initialWatchState(0), now: at('2026-11-02T10:00:00'), deps })
      assert.deepEqual(report.notify, { init: true })
      assert.deepEqual(report.reconcile, { baseline: 2 })
      assert.deepEqual(state.cursor, { position: 300, readFrom: 'x' })
      assert.deepEqual(Object.keys(state.baseline.statuses), ['r1', 'r2'])
      assert.deepEqual(calls.handled, [])
      assert.equal(calls.dm[0], 'bug 对账基线已建：你头上现有 2 条未结。\n- 待处理 1 条\n- 验退 1 条\n这些不自动开工；之后新来的、状态变了的（如被验退）才处理。\n要修其中某条，回我记录链接。')
      assert.ok(calls.saved >= 2)
    }],
    ['整轮·新通知：按项目 + 标题定位到我的记录就开工、落断点、转测试中并私信；定位不到私信不猜也照样往前走', async () => {
      const now = at('2026-11-02T10:00:00')
      const records = (filter) => (filter.conditions[0][2] === 'PR-02233' ? [rec('r9', { title: 'pre-web-邮箱 限频后报错' })] : [])
      const { calls, deps } = roundDeps({ messages: [card(301, 'PR-02233', 'pre-web-邮箱 限频后报错'), card(302, 'PR-09999', '找不到的'), card(303, '', '没项目号')], records })
      const base = { ...initialWatchState(0), cursor: { position: 300, readFrom: '2026-11-02T05:00:00.000Z' }, baseline: { at: 'x', statuses: {} }, lastReconcileAt: now }
      const { state, report } = await runWatchRound({ config: { bugTable: BUG }, cfg, state: base, now, deps })
      assert.deepEqual(report.notify, { fresh: 3, outcomes: ['handled', 'unlocated', 'unlocated'] })
      assert.deepEqual(calls.handled, ['r9'])
      assert.deepEqual(calls.filters[0], { logic: 'and', conditions: [['项目ID', '==', 'PR-02233'], ['问题标题', 'intersects', 'pre-web-邮箱']] })
      assert.equal(state.cursor.position, 303)
      assert.equal(state.cursor.readFrom, '2026-11-02T06:00:00.000Z')
      assert.equal(state.mode, 'testing')
      assert.deepEqual(report.switched, ['on'])
      assert.ok(calls.dm.includes('新 bug 通知：PR-09999「找不到的」\n在表里没找到分给你的同名记录，没开工（不猜）。\n回我记录链接我再接。'))
      assert.ok(calls.dm.some((t) => /项目号或标题不完整/.test(t)))
      assert.ok(calls.dm.some((t) => /转「测试中」/.test(t)))
      assert.ok(calls.dm.some((t) => /补读了 3 条/.test(t)))
      const multi = roundDeps({ messages: [card(304, 'PR-02233', 'dup')], records: [rec('a', { title: 'dup' }), rec('b', { title: 'dup' })] })
      await runWatchRound({ config: { bugTable: BUG }, cfg, state: { ...state, lastNotifyReadAt: 0 }, now: now + MIN, deps: multi.deps })
      assert.ok(multi.calls.dm.some((t) => /找到 2 条同名、都分给你/.test(t)))
      assert.equal(multi.calls.dm.some((t) => /转「测试中」|补读/.test(t)), false, '已在测试中、只 1 条：不重复私信')
    }],
    ['整轮·失败：计数进台账，第 3 次私信（带自修工单），恢复后私信一次并清零；对账失败不挡读通知', async () => {
      const now = at('2026-11-02T10:00:00')
      let state = { ...initialWatchState(0), cursor: { position: 1, readFrom: 'x' }, baseline: { at: 'x', statuses: {} } }
      const dms = []
      for (let i = 1; i <= 3; i += 1) {
        const { calls, deps } = roundDeps({ fail: 'notify' })
        state = (await runWatchRound({ config: { bugTable: BUG }, cfg, state: { ...state, lastNotifyReadAt: 0, lastReconcileAt: now }, now: now + i, deps })).state
        dms.push(...calls.dm)
        assert.equal(calls.failures[0].consecutive, i)
      }
      assert.equal(state.failures.notify, 3)
      assert.equal(dms.length, 1)
      assert.equal(dms[0], '⚠ 读新 bug 通知已连续 3 次失败，期间新 bug 通知读不到。\n原因：Unexpected token < in JSON at position 0\n已开自修工单 sf-x。')
      const ok = roundDeps({})
      state = (await runWatchRound({ config: { bugTable: BUG }, cfg, state: { ...state, lastNotifyReadAt: 0, lastReconcileAt: now }, now: now + 10, deps: ok.deps })).state
      assert.equal(state.failures.notify, 0)
      assert.deepEqual(ok.calls.dm, ['读新 bug 通知恢复正常。'])
      const rc = roundDeps({ fail: 'reconcile' })
      const r = await runWatchRound({ config: { bugTable: BUG }, cfg, state: { ...state, lastNotifyReadAt: 0, lastReconcileAt: 0 }, now: now + 20, deps: rc.deps })
      assert.ok(r.report.reconcile.error)
      assert.deepEqual(r.report.notify, { fresh: 0, outcomes: [] })
      const ext = roundDeps({ fail: 'notify' })
      ext.deps.recordFailure = () => ({ external: true, selfFix: null })
      const extState = { ...state, failures: { notify: 2 }, lastNotifyReadAt: 0, lastReconcileAt: now }
      await runWatchRound({ config: { bugTable: BUG }, cfg, state: extState, now: now + 30, deps: ext.deps })
      assert.match(ext.calls.dm[0], /\n外部原因（网络 \/ 登录 \/ 权限），只告警。$/)
    }],
    ['整轮·对账：基线后状态变了的交给处理；一个工作日没新通知自动回平时并私信', async () => {
      const now = at('2026-11-03T10:00:00')
      const { calls, deps } = roundDeps({ records: [rec('r1', { status: '验退' }), rec('r2')] })
      const base = { ...initialWatchState(0), mode: 'testing', cursor: { position: 1, readFrom: 'x' }, lastNotifyReadAt: now, baseline: { at: 'x', statuses: { r1: '待处理', r2: '待处理' } }, quietWorkMs: workDayMs(cfg), lastTickAt: now }
      const { state, report } = await runWatchRound({ config: { bugTable: BUG }, cfg, state: base, now, deps })
      assert.deepEqual(calls.handled, ['r1'])
      assert.deepEqual(report.reconcile, { actionable: 1, counts: { enqueued: 1 } })
      assert.equal(state.mode, 'idle')
      assert.deepEqual(report.switched, ['off'])
      assert.ok(calls.dm.some((t) => /回「平时」/.test(t)))
      const none = roundDeps({ records: [rec('r1', { status: '验退' })] })
      const quiet = await runWatchRound({ config: { bugTable: { ...BUG, myOpenId: '' }, taskMentionOpenIds: ['ou_me'] }, cfg, state: { ...state, lastReconcileAt: 0, lastNotifyReadAt: now }, now: now + 1, deps: none.deps })
      assert.deepEqual(quiet.report.reconcile, { actionable: 0, counts: null })
    }],
    ['补边界：间隔 0 按默认；4 字段落入粗筛；has_more 但没 page_token 就停；翻页上限含端点；字段缺省用默认列名；非 Error 也进台账', async () => {
      assert.equal(normalizeWatchConfig({ testing: { notifyWorkMin: 0 } }).testing.notifyWorkMs, MIN)
      assert.equal(titleProbe('abcd，xy'), 'abcd')
      let pages = 0
      await readNotificationMessages({ chatId: 'oc_n', cursor: { position: 1, readFrom: '2026-11-02T06:00:00.000Z' }, run: async () => { pages += 1; return { code: 0, stdout: JSON.stringify({ data: { messages: [], has_more: true } }) } } })
      assert.equal(pages, 1)
      const seen = []
      const defaults = { projectField: 'P', titleField: 'T', descField: 'D', bugNoField: 'N', envField: 'E', portField: 'O', createdField: 'C', screenshotField: 'S' }
      await listBugRecords({ bug: { appToken: 'a', tableId: 't', statusField: 'st', assigneeField: 'as' }, filter: {}, defaults, pageSize: 1, maxOffset: 1, run: async (args) => { seen.push(args); return { code: 0, stdout: JSON.stringify({ data: { has_more: true } }) } } })
      assert.equal(seen.length, 2, 'offset 0 和 maxOffset 都读')
      const fieldIds = seen[0].filter((_, i) => seen[0][i - 1] === '--field-id')
      assert.deepEqual(fieldIds, ['st', 'as', 'P', 'T', 'D', 'N', 'E', 'O', 'C', 'S'])
      const ledgerDir = join(dir, 'ledger2')
      recordWatchFailure({ entry: 'notify', error: 'plain string boom', consecutive: 1, ledgerDir, now: 7 })
      const line = JSON.parse(readFileSync(join(ledgerDir, readdirSync(ledgerDir)[0]), 'utf8').trim())
      assert.equal(line.message, 'plain string boom')
    }],
    ['补整轮：自定义列名进过滤；对账失败的私信说验退捞不到、没开工单也不乱写；基线验退数按状态数', async () => {
      const now = at('2026-11-02T10:00:00')
      const custom = { ...BUG, titleField: 'TT', projectField: 'PP' }
      const { calls, deps } = roundDeps({ messages: [card(301, 'PR-02233', 'x')], records: [] })
      await runWatchRound({ config: { bugTable: custom }, cfg, state: { ...initialWatchState(0), cursor: { position: 300, readFrom: 'x' }, baseline: { at: 'x', statuses: {} }, lastReconcileAt: now }, now, deps })
      assert.deepEqual(calls.filters[0].conditions.map((c) => c[0]), ['PP', 'TT'])
      let st = { ...initialWatchState(0), cursor: { position: 1, readFrom: 'x' }, baseline: { at: 'x', statuses: {} }, lastNotifyReadAt: now }
      let last = null
      for (let i = 1; i <= 3; i += 1) {
        last = roundDeps({ fail: 'reconcile' })
        last.deps.recordFailure = () => ({ external: false, selfFix: { opened: false } })
        st = (await runWatchRound({ config: { bugTable: BUG }, cfg, state: { ...st, lastReconcileAt: 0, lastNotifyReadAt: now }, now: now + i, deps: last.deps })).state
      }
      assert.equal(last.calls.dm[0], '⚠ 对账已连续 3 次失败，期间验退 / 漏掉的 bug 捞不到。\n原因：reconcile boom')
      const b = roundDeps({ cursorInit: { position: 1, readFrom: 'x' }, records: [rec('r1'), rec('r2'), rec('r3', { status: '验退' })] })
      await runWatchRound({ config: { bugTable: BUG }, cfg, state: initialWatchState(0), now, deps: b.deps })
      assert.match(b.calls.dm[0], /现有 3 条未结。\n- 待处理 2 条\n- 验退 1 条/)
    }],
    ['配置校验：watch 必须是对象；开了没配通知会话只告警', () => {
      const base = { project: 'PR-01947', bugTable: { appToken: 'a', tableId: 't', statusField: 's', assigneeField: 'r', doneValue: 'd' } }
      assert.ok(validateConfig({ ...base, bugTable: { ...base.bugTable, watch: 'on' } }).errors.some((e) => /bugTable.watch 必须是对象/.test(e)))
      assert.ok(validateConfig({ ...base, bugTable: { ...base.bugTable, watch: [] } }).errors.some((e) => /bugTable.watch 必须是对象/.test(e)))
      const warn = (watch) => validateConfig({ ...base, bugTable: { ...base.bugTable, watch } }).warnings.some((w) => /notifyChatId 未配/.test(w))
      assert.equal(warn({ enabled: true }), true)
      assert.equal(warn({ enabled: true, notifyChatId: 'ou_x' }), true)
      assert.equal(warn({ enabled: true, notifyChatId: 'oc_x' }), false)
      assert.equal(warn({ enabled: false }), false)
      assert.equal(validateConfig({ ...base, bugTable: { ...base.bugTable, watch: { enabled: true, notifyChatId: 'oc_x' } } }).errors.length, 0)
    }],
  ], hooks))
})
