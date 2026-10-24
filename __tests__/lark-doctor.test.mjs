#!/usr/bin/env node
/**
 * 运行态体检（自愈环 3）：报告判定 + 每小时私信去重 + 日报自检行。
 *   node --test __tests__/lark-doctor.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { buildDailySelfCheckLine, buildDoctorReport, createDoctorMonitor, formatDoctorReport, pickNotifiable } from '../lib/lark-doctor.mjs'

// 2026-10-16 周五 20:30 本地
const now = new Date(2026, 9, 16, 20, 30).getTime()
const healthy = { ok: true, version: { codeStale: false, configStale: false }, worker: { pid: 1, heartbeatStale: false, inFlight: 0, readiness: { ok: true } }, warnings: [] }
const falive = { key: 'falive', isDefault: false, title: 'Falive Web', dailyReport: { at: '19:00' } }

describe('buildDoctorReport', () => {
  it('体检报告分级：正常 / 不可达 / 代码落后 / 日报未发 / 挂起与失败积压', () => {
    {
      const t1 = '一切正常 → ok'
      const report = buildDoctorReport({ health: healthy, tasks: [], profiles: [falive], failures: { total: 0, byClass: {}, recurring: [], healed: 0 }, dailyState: { falive: '2026-10-16' }, now })
      assert.equal(report.ok, true, t1)
      assert.equal(report.level, 'ok', t1)
      assert.ok(report.checks.every((check) => check.level === 'ok'), formatDoctorReport(report))
    }

    {
      const t2 = 'gateway 不可达 / worker 心跳停 → bad；代码落后磁盘且没排空 → warn，排空中 → info'
      assert.equal(buildDoctorReport({ health: null, now }).checks.find((c) => c.id === 'gateway').level, 'bad', t2)
      const dead = buildDoctorReport({ health: { ...healthy, worker: { pid: 9, heartbeatStale: true, heartbeatAgeMs: 10 * 60_000 } }, now })
      assert.match(dead.checks.find((c) => c.id === 'worker').text, /心跳已停 10 分钟/, t2)
      const stale = buildDoctorReport({ health: { ...healthy, version: { codeStale: true } }, now })
      assert.equal(stale.checks.find((c) => c.id === 'version').level, 'warn', t2)
      const draining = buildDoctorReport({ health: { ...healthy, version: { codeStale: true }, worker: { ...healthy.worker, draining: true } }, now })
      assert.equal(draining.checks.find((c) => c.id === 'version').level, 'info', t2)
      assert.match(draining.checks.find((c) => c.id === 'worker').text, /排空中/, t2)
    }

    {
      const t3 = '日报到点 1 小时后还没发 → warn；周末不查；发了 → ok'
      const late = buildDoctorReport({ health: healthy, profiles: [falive], dailyState: { falive: '2026-10-15' }, now })
      assert.match(late.checks.find((c) => c.id === 'daily-report:falive').text, /已过 2 小时还没发成功/, t3)
      const early = buildDoctorReport({ health: healthy, profiles: [falive], dailyState: {}, now: new Date(2026, 9, 16, 19, 30).getTime() })
      assert.equal(early.checks.find((c) => c.id === 'daily-report:falive'), undefined, t3)
      const weekend = buildDoctorReport({ health: healthy, profiles: [falive], dailyState: {}, now: new Date(2026, 9, 17, 20, 30).getTime() })
      assert.equal(weekend.checks.find((c) => c.id === 'daily-report:falive'), undefined, t3)
    }

    {
      const t4 = '挂起超 24 小时 / failed 积压 / 失败台账复发 → warn；gateway warnings 原样带上，夜间静默只算 info'
      const tasks = [
        { id: 'om_aaaaaaaa1', status: 'waiting_confirmation', summary: '等 Arthur 补料', parkedAt: new Date(now - 30 * 3600_000).toISOString() },
        { id: 'om_2', status: 'waiting_confirmation', summary: '新的', parkedAt: new Date(now - 3600_000).toISOString() },
        { id: 'om_3', status: 'failed' },
      ]
      const report = buildDoctorReport({
        health: { ...healthy, warnings: ['已 400min 无事件（夜间空闲属正常，持续整个工作日则需排查长连接）', '2 个 failed 任务待人工处置（lark-bot failed 查看）'] },
        tasks, failures: { total: 5, byClass: { result_missing: 3, timeout: 2 }, recurring: [{ fingerprint: 'result_missing:abc', count: 3 }], healed: 2 }, now,
      })
      const byId = Object.fromEntries(report.checks.map((check) => [check.id, check]))
      assert.match(byId.parked.text, /1 条任务挂起超过 24 小时[^\n]*aaaaaaa1/, t4)
      assert.equal(byId['failed-tasks'].level, 'warn', t4)
      assert.match(byId.failures.text, /7 天失败 5（result_missing 3、timeout 2），自动重跑 2 次，复发指纹 1 个：result_missing:abc×3/, t4)
      const gw = report.checks.filter((check) => check.id === 'gateway-warning')
      assert.deepEqual(gw.map((check) => check.level), ['info', 'warn'], t4)
      assert.equal(report.level, 'warn', t4)
    }
  })
})

describe('createDoctorMonitor（每小时私信，24 小时去重）', () => {
  it('私信去重：warn/bad 24 小时内同文案只报一次，pickNotifiable 只挑未去重的', async () => {
    const t1 = '第一次报 warn/bad，同样内容 24 小时内不再报，文案变了再报；ok/info 不报'
    const dir = mkdtempSync(join(tmpdir(), 'lark-doctor-'))
    try {
      let clock = now
      const notes = []
      let health = { ...healthy, version: { codeStale: true } }
      const monitor = createDoctorMonitor({
        fetchHealth: async () => health,
        listTasks: async () => [],
        profiles: () => [],
        failures: () => ({ total: 0, byClass: {}, recurring: [], healed: 0 }),
        dailyState: () => ({}),
        notify: async (text) => { notes.push(text) },
        statePath: join(dir, 'state.json'),
        now: () => clock,
        log: () => {},
        lidClosed: async () => false,
      })
      const first = await monitor.tick()
      assert.equal(first.notified.length, 1, t1)
      assert.match(notes[0], /🩺 bot 体检[\s\S]*⚠ 代码落后磁盘/, t1)
      clock += 3600_000
      assert.equal((await monitor.tick()).notified.length, 0, t1)
      health = { ...healthy, version: { codeStale: true, configStale: true } }
      assert.equal((await monitor.tick()).notified.length, 1, t1)
      clock += 25 * 3600_000
      assert.equal((await monitor.tick()).notified.length, 1, t1)
      health = healthy
      assert.equal((await monitor.tick()).notified.length, 0, t1)
      assert.equal(notes.length, 3, t1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }

    const t2 = 'pickNotifiable 纯函数：只挑 warn/bad 且没在去重窗内的'
    const report = { checks: [{ id: 'a', level: 'ok', text: 'x' }, { id: 'b', level: 'warn', text: 'y' }, { id: 'c', level: 'bad', text: 'z' }] }
    assert.deepEqual(pickNotifiable({ report, state: { notified: {} }, now }).map((c) => c.id), ['b', 'c'], t2)
  })
})

describe('体检私信发送失败不记已报（aven 2026-10-20 review）', () => {
  it('notify 返回 ok:false / 抛错 → 不写 state，下一轮照报；发成功后才进 24h 去重', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lark-doctor-fail-'))
    try {
      let result = { ok: false, reason: 'HTTP 400 {"code":19002}' }
      const notes = []
      const monitor = createDoctorMonitor({
        fetchHealth: async () => ({ ...healthy, version: { codeStale: true } }),
        listTasks: async () => [],
        profiles: () => [],
        failures: () => ({ total: 0, byClass: {}, recurring: [], healed: 0 }),
        dailyState: () => ({}),
        notify: async (text) => { notes.push(text); if (result instanceof Error) throw result; return result },
        statePath: join(dir, 'state.json'),
        now: () => now,
        log: () => {},
        lidClosed: async () => false,
      })
      const failed = await monitor.tick()
      assert.equal(failed.failed, true)
      assert.equal(failed.notified.length, 0)
      result = new Error('boom')
      assert.equal((await monitor.tick()).failed, true)
      result = { ok: true }
      assert.equal((await monitor.tick()).notified.length, 1, '前两次没报出去，这次照报')
      assert.equal((await monitor.tick()).notified.length, 0, '报出去之后才去重')
      assert.equal(notes.length, 3)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('buildDailySelfCheckLine', () => {
  it('心跳 + 失败台账拼一行', () => {
    const line = buildDailySelfCheckLine({ now, failures: { total: 3, healed: 1, recurring: [{ fingerprint: 'x', count: 2 }], byClass: {} }, heartbeat: { heartbeatStale: false, codeStale: false } })
    assert.equal(line, 'bot 自检：worker 正常；7 天失败 3、自动重跑 1、复发指纹 1')
    assert.equal(buildDailySelfCheckLine({ now, failures: { total: 0, healed: 0, recurring: [], byClass: {} }, heartbeat: { heartbeatStale: false, codeStale: true, draining: true } }), 'bot 自检：worker 排空中；7 天无失败')
  })
})

describe('合盖 = bot 下班（aven 10-17）', () => {
  it('合盖时体检不跑不私信，日报因合盖推迟只记 info', async () => {
    const t1 = '合盖时体检不跑、不私信'
    const notes = []
    const monitor = createDoctorMonitor({
      fetchHealth: async () => null,
      listTasks: async () => [],
      notify: async (text) => { notes.push(text) },
      statePath: join(tmpdir(), 'lark-doctor-lid-unused.json'),
      lidClosed: async () => true,
    })
    const result = await monitor.tick()
    assert.equal(result.skipped, 'lid-closed', t1)
    assert.deepEqual(notes, [], t1)

    const t2 = '日报因合盖推迟：info「开盖后补发」，不报 warn'
    const report = buildDoctorReport({ health: healthy, tasks: [], profiles: [falive], failures: { total: 0, byClass: {}, recurring: [], healed: 0 }, dailyState: { falive: '2026-10-15', 'falive:deferred': '2026-10-16' }, now })
    const check = report.checks.find((c) => c.id === 'daily-report:falive')
    assert.equal(check.level, 'info', t2)
    assert.match(check.text, /合盖推迟/, t2)
  })
})
