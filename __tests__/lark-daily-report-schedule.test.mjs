import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import {
  DAILY_MAX_ATTEMPTS,
  dueDailyReport,
  markDailyReportSent,
  parseDailyReportDirective,
  readDailyReportState,
  startDailyReportScheduler,
  triggerDailyReportFromChat,
} from '../lib/lark-daily-schedule.mjs'
import { isDailyReportTask } from '../lib/lark-system-tasks.mjs'
import { registerRepoProfiles, resetRepoProfiles } from '../lib/lark-repo-profile.mjs'

const profiles = () => registerRepoProfiles({
  repos: { falive: { root: '/tmp/falive-react', baseRef: 'main', chatIds: ['oc_falive'], notifyChatId: 'ou_aven', title: 'Falive', dailyReport: { at: '19:00', to: 'ou_aven' } } },
})
// 2026-10-15 是星期四（工作日）。
const at = (hhmm) => new Date(`2026-10-15T${hhmm}:00`)

describe('parseDailyReportDirective', () => {
  it('认短祈使句，问话 / 闲聊 / 无关不算', () => {
    const t1 = '认短祈使句'
    for (const text of ['今天日报发一下 @Aven.Bot', '@Aven.Bot 补发日报', '发一下今天的日报', '今天的日报发一下吧', '日报发一下']) {
      assert.deepEqual(parseDailyReportDirective(text), { force: false }, text)
    }
    assert.deepEqual(parseDailyReportDirective('@Aven.Bot 重发今天的日报'), { force: true }, t1)

    // 问话 / 闲聊 / 无关不算
    for (const text of ['确认一下，为什么今天没按时发日报', '日报怎么没发？', '日报模板改了吗', '今天日报里 #26 写错了，帮我改一下再发', '发一下 pre', '']) {
      assert.equal(parseDailyReportDirective(text), null, text)
    }
  })
})

describe('startDailyReportScheduler（第 1 批：只建系统任务，生成交给 worker）', () => {
  let dir
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'daily-sched-')); profiles() })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); resetRepoProfiles() })

  const fakeStore = () => {
    const map = new Map()
    return { list: () => [...map.values()], get: (id) => map.get(id), upsert: (task) => { map.set(task.id, { ...task }); return map.get(task.id) }, map }
  }
  const scheduler = ({ clock, store, dms = [] }) => startDailyReportScheduler({
    store,
    deps: {
      runtimeDir: dir,
      now: () => clock.now,
      isLidClosed: async () => Boolean(clock.lidClosed),
      setInterval: () => ({ unref() {} }),
      sendUserMarkdown: async (args) => { dms.push(args); return { ok: true } },
    },
  })
  const dailyTasks = (store) => store.list().filter(isDailyReportTask)

  it('到点建任务、不重复建；失败隔 10 分钟重建，一天最多 3 条', async () => {
    {
      const t1 = '整点前不建；错过 19:00 也建；同一天在队列 / 在跑时不重复建；记成功后不再建'
      const store = fakeStore()
      const clock = { now: at('18:59') }
      const s = scheduler({ clock, store })
      await s.tick()
      assert.equal(dailyTasks(store).length, 0, t1)
      clock.now = at('19:22')
      const created = await s.tick()
      assert.equal(created.length, 1, t1)
      const task = dailyTasks(store)[0]
      assert.equal(task.id, 'daily-falive-2026-10-15', t1)
      assert.equal(task.status, 'queued', t1)
      assert.equal(task.daily.date, '2026-10-15', t1)
      assert.equal(task.commandType, 'status', '走只读路径，不建 worktree')
      assert.ok(task.leaseMs >= 30 * 60_000, t1)
      clock.now = at('19:23')
      await s.tick()
      assert.equal(dailyTasks(store).length, 1, '在队列里不重复建')
      store.map.get(task.id).status = 'running'
      await s.tick()
      assert.equal(dailyTasks(store).length, 1, t1)
      markDailyReportSent({ key: 'falive', date: '2026-10-15', runtimeDir: dir })
      store.map.get(task.id).status = 'done'
      clock.now = at('20:00')
      await s.tick()
      assert.equal(dailyTasks(store).length, 1, t1)
    }

    // 每段独立目录与 profile 注册，等同原 beforeEach / afterEach
    rmSync(dir, { recursive: true, force: true })
    resetRepoProfiles()
    dir = mkdtempSync(join(tmpdir(), 'daily-sched-'))
    profiles()
    {
      const t2 = '失败后隔 10 分钟再建，一天最多 3 条，到上限私信负责人一次'
      const store = fakeStore()
      const dms = []
      const clock = { now: at('19:00') }
      const s = scheduler({ clock, store, dms })
      const fail = (hhmm) => { for (const task of dailyTasks(store)) if (task.status === 'queued') { task.status = 'failed'; task.result = 'boom'; task.updatedAt = at(hhmm).toISOString() } }
      await s.tick(); fail('19:01')
      clock.now = at('19:05'); await s.tick()
      assert.equal(dailyTasks(store).length, 1, '10 分钟内不重建')
      clock.now = at('19:12'); await s.tick(); fail('19:13')
      clock.now = at('19:24'); await s.tick(); fail('19:25')
      clock.now = at('19:40'); await s.tick()
      assert.deepEqual(dailyTasks(store).map((task) => task.id), ['daily-falive-2026-10-15', 'daily-falive-2026-10-15-r2', 'daily-falive-2026-10-15-r3'], t2)
      assert.equal(dms.length, 1, t2)
      assert.match(dms[0].markdown, /跑了 3 次都没发出去/, t2)
      clock.now = at('21:00'); await s.tick()
      assert.equal(dms.length, 1, '只私信一次')
    }
  })

  it('合盖推迟与补建、非推迟不补、dueDailyReport 窗口、周末不发', async () => {
    {
      const t1 = '合盖到点不建、记推迟；第二天开盖补建前一天的（reportNow 仍是前一天 19:00）'
      const store = fakeStore()
      const clock = { now: at('19:00'), lidClosed: true }
      const s = scheduler({ clock, store })
      await s.tick()
      clock.now = at('23:40'); await s.tick()
      assert.equal(dailyTasks(store).length, 0, t1)
      assert.equal(readDailyReportState(dir)['falive:deferred'], '2026-10-15', t1)
      clock.now = new Date('2026-10-16T06:30:00'); await s.tick()
      assert.equal(dailyTasks(store).length, 0, '还合着')
      clock.lidClosed = false
      clock.now = new Date('2026-10-16T06:44:00')
      await s.tick()
      const task = dailyTasks(store)[0]
      assert.equal(task.daily.date, '2026-10-15', t1)
      assert.equal(new Date(task.daily.reportNow).toTimeString().slice(0, 5), '19:00', t1)
    }

    // 每段独立目录与 profile 注册，等同原 beforeEach / afterEach
    rmSync(dir, { recursive: true, force: true })
    resetRepoProfiles()
    dir = mkdtempSync(join(tmpdir(), 'daily-sched-'))
    profiles()
    {
      const t2 = '不是合盖推迟的（当天失败 3 次）第二天不翻出来补'
      const store = fakeStore()
      const clock = { now: new Date('2026-10-16T06:44:00') }
      await scheduler({ clock, store }).tick()
      assert.equal(dailyTasks(store).length, 0, t2)
    }

    // 每段独立目录与 profile 注册，等同原 beforeEach / afterEach
    rmSync(dir, { recursive: true, force: true })
    resetRepoProfiles()
    dir = mkdtempSync(join(tmpdir(), 'daily-sched-'))
    profiles()
    {
      const t3 = 'dueDailyReport：推迟的超过 24 小时不补；周五推迟周六补'
      assert.equal(dueDailyReport({ now: new Date('2026-10-16T19:30:00'), at: '19:00', deferredDate: '2026-10-15' }).date, '2026-10-16', t3)
      assert.equal(dueDailyReport({ now: new Date('2026-10-16T18:59:00'), at: '19:00', deferredDate: '2026-10-15' }).date, '2026-10-15', t3)
      assert.equal(dueDailyReport({ now: new Date('2026-10-19T08:00:00'), at: '19:00', deferredDate: '2026-10-16' }), null, t3)
      assert.equal(dueDailyReport({ now: new Date('2026-10-17T09:00:00'), at: '19:00', deferredDate: '2026-10-16' }).date, '2026-10-16', t3)
    }

    // 每段独立目录与 profile 注册，等同原 beforeEach / afterEach
    rmSync(dir, { recursive: true, force: true })
    resetRepoProfiles()
    dir = mkdtempSync(join(tmpdir(), 'daily-sched-'))
    profiles()
    {
      const t4 = '周末不发'
      const store = fakeStore()
      const clock = { now: new Date('2026-10-17T19:00:00') }
      await scheduler({ clock, store }).tick()
      assert.equal(dailyTasks(store).length, 0, t4)
    }
  })
})

describe('triggerDailyReportFromChat（第 1 批：建系统任务）', () => {
  let dir
  let profile
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'daily-chat-')); profile = profiles().get('falive') })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); resetRepoProfiles() })

  const fakeStore = () => {
    const map = new Map()
    return { list: () => [...map.values()], get: (id) => map.get(id), upsert: (task) => { map.set(task.id, { ...task }); return map.get(task.id) }, map }
  }
  const deps = (said) => ({
    runtimeDir: dir,
    now: () => at('21:07'),
    webhookFor: () => ({ url: 'x' }),
    sendGroupCard: async ({ body }) => { said.push(body); return { ok: true } },
  })

  it('群里要日报：没发过建任务，已发过 / 在跑时提示，force 照建', async () => {
    {
      const t1 = '没发过：先回收到，再建任务（带群与要求人）'
      const said = []
      const store = fakeStore()
      const res = await triggerDailyReportFromChat({ store, profile, chatId: 'oc_falive', operator: 'ou_x', deps: deps(said) })
      assert.equal(res.started, true, t1)
      assert.match(said[0], /收到，现在生成今天的日报/, t1)
      const task = store.get(res.taskId)
      assert.equal(task.daily.force, true, t1)
      assert.equal(task.daily.requestChatId, 'oc_falive', t1)
      assert.equal(task.daily.requestedBy, 'ou_x', t1)
    }

    // 每段独立目录与 profile 注册，等同原 beforeEach / afterEach
    rmSync(dir, { recursive: true, force: true })
    resetRepoProfiles()
    dir = mkdtempSync(join(tmpdir(), 'daily-chat-'))
    profile = profiles().get('falive')
    {
      const t2 = '已发过：不建，提示可重发；force 照建；在跑时提示正在生成'
      markDailyReportSent({ key: 'falive', date: '2026-10-15', runtimeDir: dir })
      const said = []
      const store = fakeStore()
      const res = await triggerDailyReportFromChat({ store, profile, chatId: 'oc_falive', deps: deps(said) })
      assert.deepEqual([res.started, res.reason], [false, 'sent'], t2)
      assert.match(said[0], /已经发过了/, t2)
      const forced = await triggerDailyReportFromChat({ store, profile, chatId: 'oc_falive', force: true, deps: deps(said) })
      assert.equal(forced.started, true, t2)
      const again = await triggerDailyReportFromChat({ store, profile, chatId: 'oc_falive', force: true, deps: deps(said) })
      assert.deepEqual([again.started, again.reason], [false, 'running'], t2)
      assert.match(said.at(-1), /正在生成/, t2)
    }
  })
})
