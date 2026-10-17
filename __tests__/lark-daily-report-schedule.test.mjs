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
} from '../lib/lark-daily-report.mjs'
import { registerRepoProfiles, resetRepoProfiles } from '../lib/lark-repo-profile.mjs'

const profiles = () => registerRepoProfiles({
  repos: { falive: { root: '/tmp/falive-react', baseRef: 'main', chatIds: ['oc_falive'], notifyChatId: 'ou_aven', title: 'Falive', dailyReport: { at: '19:00', to: 'ou_aven' } } },
})
// 2026-10-15 是星期四（工作日）。
const at = (hhmm) => new Date(`2026-10-15T${hhmm}:00`)

describe('parseDailyReportDirective', () => {
  it('认短祈使句', () => {
    for (const text of ['今天日报发一下 @Aven.Bot', '@Aven.Bot 补发日报', '发一下今天的日报', '今天的日报发一下吧', '日报发一下']) {
      assert.deepEqual(parseDailyReportDirective(text), { force: false }, text)
    }
    assert.deepEqual(parseDailyReportDirective('@Aven.Bot 重发今天的日报'), { force: true })
  })
  it('问话 / 闲聊 / 无关不算', () => {
    for (const text of ['确认一下，为什么今天没按时发日报', '日报怎么没发？', '日报模板改了吗', '今天日报里 #26 写错了，帮我改一下再发', '发一下 pre', '']) {
      assert.equal(parseDailyReportDirective(text), null, text)
    }
  })
})

describe('startDailyReportScheduler', () => {
  let dir
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'daily-sched-')); profiles() })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); resetRepoProfiles() })

  const scheduler = ({ clock, runs, ok = () => true }) => startDailyReportScheduler({
    config: {},
    store: {},
    deps: {
      runtimeDir: dir,
      now: () => clock.now,
      isLidClosed: async () => Boolean(clock.lidClosed),
      setInterval: () => ({ unref() {} }),
      enqueueDailySweep: () => ({ skipped: 'test' }),
      runDailyReport: async ({ now }) => { runs.push(now.toTimeString().slice(0, 5)); return ok() ? { ok: true, to: 'oc_falive' } : { ok: false, reason: 'boom' } },
    },
  })

  it('整点前不跑；错过 19:00 也补发，发成功写状态后不再跑', async () => {
    const runs = []
    const clock = { now: at('18:59') }
    const s = scheduler({ clock, runs })
    await s.tick()
    assert.deepEqual(runs, [])
    clock.now = at('19:22') // 19:00 那一分钟没 tick 到（进程重启 / 卡住）
    await s.tick()
    assert.deepEqual(runs, ['19:22'])
    assert.equal(readDailyReportState(dir).falive, '2026-10-15')
    clock.now = at('19:23')
    await s.tick()
    assert.deepEqual(runs, ['19:22'])
  })

  it('失败结束后隔 10 分钟再试，当天最多 3 次', async () => {
    const runs = []
    const clock = { now: at('19:00') }
    const s = scheduler({ clock, runs, ok: () => false })
    for (const hhmm of ['19:00', '19:01', '19:09', '19:10', '19:19', '19:20', '19:30', '21:00']) {
      clock.now = at(hhmm)
      await s.tick()
    }
    assert.deepEqual(runs, ['19:00', '19:10', '19:20'])
    assert.equal(runs.length, DAILY_MAX_ATTEMPTS)
    assert.equal(readDailyReportState(dir).falive, undefined)
  })

  it('间隔从失败结束算，不从开跑算（生成本身要跑 20 分钟）', async () => {
    const runs = []
    const clock = { now: at('19:00') }
    const s = startDailyReportScheduler({
      config: {},
      store: {},
      deps: {
        runtimeDir: dir,
        now: () => clock.now,
        isLidClosed: async () => false,
        setInterval: () => ({ unref() {} }),
        enqueueDailySweep: () => ({ skipped: 'test' }),
        runDailyReport: async ({ now }) => {
          runs.push(now.toTimeString().slice(0, 5))
          clock.now = new Date(now.getTime() + 20 * 60_000) // 跑了 20 分钟才失败
          return { ok: false, reason: 'timeout' }
        },
      },
    })
    await s.tick() // 19:00 开跑，19:20 失败
    for (const hhmm of ['19:21', '19:29']) {
      clock.now = at(hhmm)
      await s.tick()
    }
    assert.deepEqual(runs, ['19:00'])
    clock.now = at('19:30')
    await s.tick()
    assert.deepEqual(runs, ['19:00', '19:30'])
  })

  it('手动补发写的状态在下次 tick 生效（不重发）', async () => {
    const runs = []
    const clock = { now: at('20:00') }
    const s = scheduler({ clock, runs })
    markDailyReportSent({ key: 'falive', date: '2026-10-15', runtimeDir: dir })
    await s.tick()
    assert.deepEqual(runs, [])
  })

  it('合盖到点不跑、记推迟；第二天开盖补发前一天的（报告时刻仍是前一天 19:00），之后不重复', async () => {
    const runs = []
    const clock = { now: at('19:00'), lidClosed: true }
    const s = scheduler({ clock, runs })
    await s.tick()
    clock.now = at('23:40')
    await s.tick()
    assert.deepEqual(runs, [])
    assert.equal(readDailyReportState(dir)['falive:deferred'], '2026-10-15')
    clock.now = new Date('2026-10-16T06:30:00')
    await s.tick() // 还合着
    assert.deepEqual(runs, [])
    clock.lidClosed = false
    clock.now = new Date('2026-10-16T06:44:00')
    await s.tick()
    assert.deepEqual(runs, ['19:00'])
    assert.equal(readDailyReportState(dir).falive, '2026-10-15')
    clock.now = new Date('2026-10-16T06:45:00')
    await s.tick()
    assert.deepEqual(runs, ['19:00'])
  })

  it('不是合盖推迟的（当天失败 3 次）第二天不翻出来补', async () => {
    const runs = []
    const clock = { now: new Date('2026-10-16T06:44:00') }
    await scheduler({ clock, runs }).tick()
    assert.deepEqual(runs, [])
  })

  it('dueDailyReport：推迟的超过 24 小时不补；周五推迟周六补', () => {
    assert.equal(dueDailyReport({ now: new Date('2026-10-16T19:30:00'), at: '19:00', deferredDate: '2026-10-15' }).date, '2026-10-16')
    assert.equal(dueDailyReport({ now: new Date('2026-10-16T18:59:00'), at: '19:00', deferredDate: '2026-10-15' }).date, '2026-10-15')
    assert.equal(dueDailyReport({ now: new Date('2026-10-19T08:00:00'), at: '19:00', deferredDate: '2026-10-16' }), null)
    assert.equal(dueDailyReport({ now: new Date('2026-10-17T09:00:00'), at: '19:00', deferredDate: '2026-10-16' }).date, '2026-10-16')
  })

  it('周末不发', async () => {
    const runs = []
    const clock = { now: new Date('2026-10-17T19:00:00') }
    await scheduler({ clock, runs }).tick()
    assert.deepEqual(runs, [])
  })
})

describe('triggerDailyReportFromChat', () => {
  let dir
  let profile
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'daily-chat-')); profile = profiles().get('falive') })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); resetRepoProfiles() })

  const deps = (said, extra = {}) => ({
    runtimeDir: dir,
    now: () => at('21:07'),
    webhookFor: () => ({ url: 'x' }),
    sendGroupCard: async ({ body }) => { said.push(body); return { ok: true } },
    enqueueDailySweep: () => ({ skipped: 'test' }),
    ...extra,
  })

  it('没发过：先回收到，后台跑完写状态', async () => {
    const said = []
    const res = await triggerDailyReportFromChat({ config: {}, store: {}, profile, chatId: 'oc_falive', deps: deps(said, { runDailyReport: async () => ({ ok: true, to: 'oc_falive' }) }) })
    assert.equal(res.started, true)
    assert.match(said[0], /收到，现在生成今天的日报/)
    assert.equal((await res.run).ok, true)
    assert.equal(readDailyReportState(dir).falive, '2026-10-15')
  })

  it('已发过：不跑，提示可重发；force 照跑', async () => {
    markDailyReportSent({ key: 'falive', date: '2026-10-15', runtimeDir: dir })
    const said = []
    let ran = 0
    const extra = { runDailyReport: async () => { ran += 1; return { ok: true, to: 'oc_falive' } } }
    const res = await triggerDailyReportFromChat({ config: {}, store: {}, profile, chatId: 'oc_falive', deps: deps(said, extra) })
    assert.deepEqual([res.started, res.reason, ran], [false, 'sent', 0])
    assert.match(said[0], /已经发过了/)
    const forced = await triggerDailyReportFromChat({ config: {}, store: {}, profile, chatId: 'oc_falive', force: true, deps: deps(said, extra) })
    await forced.run
    assert.equal(ran, 1)
  })

  it('失败私信负责人', async () => {
    const said = []
    const dms = []
    const res = await triggerDailyReportFromChat({
      config: {}, store: {}, profile, chatId: 'oc_falive',
      deps: deps(said, { runDailyReport: async () => ({ ok: false, reason: 'group send failed' }), sendUserMarkdown: async (args) => { dms.push(args); return { ok: true } } }),
    })
    await res.run
    assert.equal(dms[0].chatId, 'ou_aven')
    assert.match(dms[0].markdown, /没发出去：group send failed/)
  })
})
