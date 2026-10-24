#!/usr/bin/env node
/**
 * 运行态体检（自愈环 3，从 falive 移植）：各检查项判定、私信 24 小时去重、合盖 / 刚醒跳过、取数与 CLI 退出码。
 *   node --test __tests__/lark-doctor.test.mjs
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import {
  DEDUPE_MS,
  STALE_PARKED_MS,
  WAKE_GRACE_MS,
  buildDoctorReport,
  collectDoctorInputs,
  createDoctorMonitor,
  doctorCheckKey,
  doctorNotifier,
  doctorSwitch,
  formatDoctorReport,
  pickNotifiable,
  pollerStatePath,
  readPollerStatus,
  readSelfFixQueue,
  runDoctorCli,
  startDoctorSchedule,
  writePollerStatus,
} from '../lib/lark-doctor.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const now = new Date(2026, 9, 24, 15, 0).getTime()
const iso = (agoMs) => new Date(now - agoMs).toISOString()
const healthy = { ok: true, version: { codeStale: false, configStale: false }, worker: { pid: 1, heartbeatStale: false, inFlight: 0, readiness: { ok: true } }, warnings: [], counts: {} }
const noFailures = { total: 0, byClass: {}, recurring: [], healed: 0 }
const pollerOk = { alive: true, pid: 7, pollMs: 120_000, startedAt: iso(3_600_000), lastRoundAt: iso(60_000), consecutiveErrors: 0 }
const report = (input) => buildDoctorReport({ health: healthy, tasks: [], failures: noFailures, poller: pollerOk, now, ...input })
const check = (input, id) => report(input).checks.find((item) => item.id === id)
const withTmp = async (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'lark-doctor-'))
  try {
    return await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('doctorSwitch（开关）', () => {
  it('selfHeal.doctor=false 或 LARK_DOCTOR=0 关，默认开', () => {
    const cases = [
      [{}, {}, true],
      [undefined, {}, true],
      [{ doctor: true }, { LARK_DOCTOR: '1' }, true],
      [{ doctor: false }, {}, false],
      [{}, { LARK_DOCTOR: '0' }, false],
    ]
    for (const [selfHeal, env, enabled] of cases) assert.equal(doctorSwitch({ selfHeal, env }).enabled, enabled, JSON.stringify({ selfHeal, env }))
  })
})

describe('buildDoctorReport（纯判定）', () => {
  it('一切正常 → 全 ok、报告 ok；格式化每项一行、ok 不带建议动作', () => {
    const result = report({ selfFix: { ready: [] } })
    assert.deepEqual(result.checks.map((item) => item.id), ['gateway', 'worker', 'version', 'poller', 'parked', 'failed-tasks', 'failures', 'self-fix'])
    assert.ok(result.checks.every((item) => item.level === 'ok'), formatDoctorReport(result))
    assert.equal(result.ok, true)
    assert.equal(result.level, 'ok')
    assert.equal(result.at, new Date(now).toISOString())
    assert.doesNotMatch(formatDoctorReport(result), /→/)
    assert.match(formatDoctorReport(result), /^✓ gateway 在线\n✓ worker 在线（在飞 0）/)
  })

  it('gateway / worker：不可达、长连接掉线、心跳缺失 / 停、就绪没过 → bad；gateway 不可达时看心跳兜底', () => {
    const cases = [
      [{ health: null }, 'gateway', 'bad', /不可达/],
      [{ health: { ...healthy, ok: false } }, 'gateway', 'bad', /长连接不在线/],
      [{ health: null }, 'worker', 'bad', /没有 worker 心跳/],
      [{ health: null, heartbeat: { pid: 3, heartbeatStale: false, inFlight: 2, readiness: { ok: true } } }, 'worker', 'ok', /在飞 2/],
      [{ health: { ...healthy, worker: { pid: 9, heartbeatStale: true, heartbeatAgeMs: 10 * 60_000 } } }, 'worker', 'bad', /心跳已停 10 分钟（pid 9/],
      [{ health: { ...healthy, worker: { pid: 9, heartbeatStale: false } } }, 'worker', 'bad', /就绪检查没过/],
      [{ health: { ...healthy, worker: { pid: 9, readiness: { ok: false } } } }, 'worker', 'bad', /就绪检查没过/],
      [{ health: { ...healthy, worker: { ...healthy.worker, inFlight: undefined, draining: true } } }, 'worker', 'ok', /在飞 \?，排空中/],
    ]
    for (const [input, id, level, text] of cases) {
      const item = check(input, id)
      assert.equal(item.level, level, `${id} ${JSON.stringify(input)}`)
      assert.match(item.text, text)
    }
    const bad = report({ health: null })
    assert.equal(bad.level, 'bad')
    assert.equal(bad.ok, false)
    assert.match(formatDoctorReport(bad), /✖ gateway 不可达[^\n]*\n {4}→ lark-bot status/)
  })

  it('版本落后磁盘：没排空 → warn 并提示看排空重启；排空中 → 只算 info，报告仍 ok', () => {
    const cases = [
      [{ codeStale: true }, {}, 'warn', '代码落后磁盘，排空重启没接手'],
      [{}, { codeStale: true }, 'warn', '代码落后磁盘，排空重启没接手'],
      [{ configStale: true }, {}, 'warn', '配置落后磁盘，排空重启没接手'],
      [{ codeStale: true, configStale: true }, {}, 'warn', '代码和配置落后磁盘，排空重启没接手'],
      [{ codeStale: true }, { draining: true }, 'info', '代码落后磁盘，worker 正在排空，在飞任务跑完、自检绿会自动重启'],
    ]
    for (const [version, workerExtra, level, text] of cases) {
      const result = report({ health: { ...healthy, version, worker: { ...healthy.worker, ...workerExtra } } })
      const item = result.checks.find((entry) => entry.id === 'version')
      assert.deepEqual([item.level, item.text], [level, text], JSON.stringify({ version, workerExtra }))
      assert.equal(result.ok, level === 'info')
      assert.equal(result.level, level)
    }
    assert.match(check({ health: { ...healthy, version: { codeStale: true } } }, 'version').action, /selfHeal\.drainRestart=false/)
  })

  it('gateway warnings：已归并的跳过，夜间静默 / 正在重试只算 info，其余 warn', () => {
    const warnings = [
      '已 400min 无事件（夜间空闲属正常，持续整个工作日则需排查长连接）',
      '2 个 failed 任务待人工处置（lark-bot failed 查看）',
      '运行中的代码已落后磁盘（进程加载版 a，磁盘 b）：需 `lark-bot restart`',
      'worker 跑的是旧代码（a，磁盘 b）：已在排空',
      '未见 worker 版本心跳（worker 未启动，或仍是不写心跳的旧版本）',
      'worker 心跳已停 5min（pid 1 可能已死）',
      'worker 尚未完成 AI executor/model 就绪检查，不能确认新任务可执行',
      '1 个任务回执尚未送达，正在重试',
      '1 个任务已完成但 bug 表状态回写挂起，其中 1 个已停止重试、需人工改表格',
      '3 个死信任务',
    ]
    const items = report({ health: { ...healthy, warnings } }).checks.filter((item) => item.id === 'gateway-warning')
    assert.deepEqual(items.map((item) => [item.level, item.text.slice(0, 8)]), [
      ['info', '已 400min'],
      ['info', '1 个任务回执尚'],
      ['warn', '1 个任务已完成'],
      ['warn', '3 个死信任务'],
    ])
  })

  it('bug 表轮询：没在跑只算 info；连续失败 3 次 / 卡住 → warn；1–2 次失败 info；还没跑完首轮看启动时间', () => {
    const cases = [
      [null, 'info', /没在跑，新 bug 不会被自动捞/],
      [{ ...pollerOk, alive: false, stopReason: 'idle' }, 'info', /没在跑（空闲自动收工）/],
      [{ ...pollerOk, consecutiveErrors: 2 }, 'info', /最近 2 次失败，还在重试/],
      [{ ...pollerOk, consecutiveErrors: 3, lastError: 'lark-cli 401' }, 'warn', /连续 3 次失败（lark-cli 401）/],
      [{ ...pollerOk, lastRoundAt: iso(10 * 60_000) }, 'ok', /上一轮 10 分钟前/],
      [{ ...pollerOk, lastRoundAt: iso(10 * 60_000 + 1) }, 'warn', /pid 7），但 10 分钟没跑完一轮/],
      [{ ...pollerOk, pollMs: 5 * 60_000, lastRoundAt: iso(14 * 60_000) }, 'ok', /上一轮 14 分钟前/],
      [{ ...pollerOk, pollMs: 5 * 60_000, lastRoundAt: iso(16 * 60_000) }, 'warn', /16 分钟没跑完一轮/],
      [{ ...pollerOk, lastRoundAt: null, startedAt: iso(2 * 60_000) }, 'ok', /上一轮 2 分钟前/],
    ]
    for (const [poller, level, text] of cases) {
      const item = check({ poller }, 'poller')
      assert.equal(item.level, level, JSON.stringify(poller))
      assert.match(item.text, text)
    }
  })

  it('挂起超 24 小时（含 blocked、updatedAt 兜底）→ warn；failed 任务按列表数，取不到列表看 health.counts', () => {
    const parked = (id, agoMs, status = 'waiting_confirmation', field = 'parkedAt') => ({ id, status, summary: `摘要${id}`, [field]: iso(agoMs) })
    const old = STALE_PARKED_MS + 1
    const four = [parked('a', old), parked('b', old, 'blocked'), parked('c', old, 'waiting_confirmation', 'updatedAt'), parked('d', old)]
    const item = check({ tasks: [...four, parked('e', STALE_PARKED_MS), { id: 'f', status: 'running', parkedAt: iso(old) }] }, 'parked')
    assert.equal(item.level, 'warn')
    assert.equal(item.text, '4 条任务挂起超过 24 小时等人补料 / 确认：a「摘要a」、b「摘要b」、c「摘要c」…')
    assert.doesNotMatch(check({ tasks: four.slice(0, 3) }, 'parked').text, /…/)
    assert.deepEqual(check({ tasks: [parked('e', STALE_PARKED_MS), parked('g', 60_000, 'blocked', 'updatedAt')] }, 'parked'), { id: 'parked', level: 'ok', text: '2 条挂起，都不到 24 小时', action: '' })
    assert.equal(check({ tasks: [] }, 'parked').text, '没有挂起任务')
    assert.equal(check({ tasks: null }, 'parked'), undefined)

    const failedCases = [
      [{ tasks: [{ id: 'x', status: 'failed' }, { id: 'y', status: 'done' }, { id: 'z', status: 'failed' }] }, 'warn', '2 条 failed 任务等人处置'],
      [{ tasks: null, health: { ...healthy, counts: { failed: 2 } } }, 'warn', '2 条 failed 任务等人处置'],
      [{ tasks: [], health: { ...healthy, counts: { failed: 2 } } }, 'ok', '没有 failed 任务'],
      [{ tasks: null, health: null }, 'ok', '没有 failed 任务'],
    ]
    for (const [input, level, text] of failedCases) assert.deepEqual([check(input, 'failed-tasks').level, check(input, 'failed-tasks').text], [level, text])
  })

  it('失败台账：无失败 ok、有失败无复发 info、有复发指纹 warn；自修工单目录不存在不出这项，超 24 小时未看 warn', () => {
    const failures = { total: 5, byClass: { timeout: 2, result_missing: 3 }, recurring: [{ fingerprint: 'result_missing:abc', count: 3 }], healed: 2 }
    const recurring = check({ failures }, 'failures')
    assert.equal(recurring.level, 'warn')
    assert.equal(recurring.text, '7 天失败 5（result_missing 3、timeout 2），自动重跑 2 次，复发指纹 1 个：result_missing:abc×3')
    const once = check({ failures: { ...failures, recurring: [] } }, 'failures')
    assert.deepEqual([once.level, once.text], ['info', '7 天失败 5（result_missing 3、timeout 2），自动重跑 2 次，没有复发'])
    assert.equal(check({ failures: null }, 'failures'), undefined)

    assert.equal(check({ selfFix: null }, 'self-fix'), undefined)
    const fresh = check({ selfFix: { ready: [{ id: 's1', at: iso(STALE_PARKED_MS) }, { id: 's2', at: null }] } }, 'self-fix')
    assert.deepEqual([fresh.level, fresh.text], ['info', '2 个自修工单已就绪等你看：s1、s2'])
    const stale = check({ selfFix: { ready: [{ id: 's1', at: iso(STALE_PARKED_MS + 1) }, { id: 's2', at: iso(0) }] } }, 'self-fix')
    assert.deepEqual([stale.level, stale.text], ['warn', '2 个自修工单已就绪等你看，其中 1 个超过 24 小时：s1、s2'])
  })
})

describe('状态文件读写（bug 表轮询 / 自修工单）', () => {
  it('轮询状态：没写过 = null；收工过或进程不在 = 没在跑；默认按 pid 探活（EPERM 也算活）', () =>
    withTmp(async (dir) => {
      assert.equal(readPollerStatus({ runtimeDir: dir }), null)
      writePollerStatus({ pid: process.pid, stoppedAt: null }, { runtimeDir: dir })
      assert.equal(JSON.parse(readFileSync(pollerStatePath(dir), 'utf8')).pid, process.pid)
      assert.equal(readPollerStatus({ runtimeDir: dir }).alive, true)
      writePollerStatus({ pid: process.pid, stoppedAt: iso(0), stopReason: 'idle' }, { runtimeDir: dir })
      assert.equal(readPollerStatus({ runtimeDir: dir, isAlive: () => true }).alive, false)
      const aliveOf = (pid) => {
        writePollerStatus({ pid }, { runtimeDir: dir })
        return readPollerStatus({ runtimeDir: dir }).alive
      }
      assert.deepEqual([1, 0, -1, 'x', 4_000_000].map(aliveOf), [true, false, false, false, false])
      // 写失败只告警不抛（runtime 目录被占成文件）
      const warned = []
      writePollerStatus({ pid: 1 }, { runtimeDir: join(pollerStatePath(dir), 'nested'), log: (line) => warned.push(line) })
      assert.match(warned[0], /轮询状态写入失败（忽略）/)
    }))

  it('自修工单：目录不存在 = null；只数 status=ready 的 .json，坏文件跳过，id 缺省取文件名', () =>
    withTmp(async (dir) => {
      assert.equal(readSelfFixQueue({ runtimeDir: dir }), null)
      const fixDir = join(dir, 'lark-self-fix')
      mkdirSync(fixDir)
      assert.deepEqual(readSelfFixQueue({ runtimeDir: dir }), { ready: [] })
      writeFileSync(join(fixDir, 'b.json'), JSON.stringify({ status: 'ready', createdAt: 'c1' }))
      writeFileSync(join(fixDir, 'a.json'), JSON.stringify({ id: 'fix-a', status: 'ready', readyAt: 'r1', updatedAt: 'u1' }))
      writeFileSync(join(fixDir, 'c.json'), JSON.stringify({ id: 'fix-c', status: 'done' }))
      writeFileSync(join(fixDir, 'd.json'), '{bad')
      writeFileSync(join(fixDir, 'e.md'), JSON.stringify({ status: 'ready' }))
      writeFileSync(join(fixDir, 'f.json'), JSON.stringify({ status: 'ready', updatedAt: 'u2', createdAt: 'c2' }))
      assert.deepEqual(readSelfFixQueue({ runtimeDir: dir }).ready, [{ id: 'fix-a', at: 'r1' }, { id: 'b', at: 'c1' }, { id: 'f', at: 'u2' }])
    }))
})

describe('createDoctorMonitor（定时体检：私信去重 24 小时）', () => {
  const makeMonitor = ({ dir, clock, input, notify, sleptAt = null, lid = false }) => {
    const logs = []
    const monitor = createDoctorMonitor({
      collect: async () => input(),
      notify,
      statePath: join(dir, 'lark-doctor-state.json'),
      now: () => clock.at,
      log: (line) => logs.push(line),
      lidClosed: async () => lid,
      lastSleepAt: async () => sleptAt,
    })
    return { monitor, logs }
  }
  const staleInput = { health: { ...healthy, version: { codeStale: true } }, tasks: [], failures: noFailures, poller: null }

  it('warn / bad 第一次报；同内容（数字变了也算同一条）24 小时内不再报，满 24 小时再报；内容变了再报；ok / info 不报', () =>
    withTmp(async (dir) => {
      const clock = { at: now }
      const notes = []
      let input = staleInput
      const { monitor, logs } = makeMonitor({ dir, clock, input: () => input, notify: async (text, opts) => { notes.push({ text, opts }); return { ok: true } } })
      const first = await monitor.tick()
      assert.deepEqual(first.notified.map((item) => item.id), ['version'])
      assert.match(notes[0].text, /^lark-bot 体检（15:00）发现 1 条异常：\n⚠ 代码落后磁盘，排空重启没接手\n {4}→ /)
      assert.match(notes[0].opts.idempotencyKey, /^doctor-[0-9a-f]{12}-\d+$/)
      assert.ok(notes[0].opts.idempotencyKey.length <= 50)
      assert.match(logs.at(-1), /1 条异常已报/)
      clock.at += DEDUPE_MS - 1
      assert.equal((await monitor.tick()).notified.length, 0, '24 小时内不重报')
      clock.at = now + DEDUPE_MS
      assert.equal((await monitor.tick()).notified.length, 1, '满 24 小时再报')
      input = { ...staleInput, health: { ...healthy, version: { codeStale: true, configStale: true } } }
      assert.equal((await monitor.tick()).notified.length, 1, '内容变了再报')
      input = { ...staleInput, health: { ...healthy, worker: { pid: 9, heartbeatStale: true, heartbeatAgeMs: 10 * 60_000, readiness: { ok: true } } } }
      assert.equal((await monitor.tick()).notified.length, 1)
      input = { ...staleInput, health: { ...healthy, worker: { pid: 9, heartbeatStale: true, heartbeatAgeMs: 70 * 60_000, readiness: { ok: true } } } }
      assert.equal((await monitor.tick()).notified.length, 0, '心跳停 10 分钟 → 70 分钟是同一件事')
      input = { ...staleInput, health: healthy }
      const quiet = await monitor.tick()
      assert.equal(quiet.notified.length, 0)
      assert.equal(quiet.report.level, 'info', '只剩轮询没在跑这条 info')
      assert.equal(notes.length, 4)
    }))

  it('去重状态只留 24 小时内的记录；pickNotifiable 只挑 warn / bad 且不在去重窗内的', () =>
    withTmp(async (dir) => {
      const statePath = join(dir, 'lark-doctor-state.json')
      writeFileSync(statePath, JSON.stringify({ notified: { 'old:x': now - DEDUPE_MS, 'recent:y': now - DEDUPE_MS + 1 } }))
      const { monitor } = makeMonitor({ dir, clock: { at: now }, input: () => staleInput, notify: async () => ({ ok: true }) })
      await monitor.tick()
      const saved = JSON.parse(readFileSync(statePath, 'utf8')).notified
      assert.deepEqual(Object.keys(saved).sort(), [doctorCheckKey({ id: 'version', text: '代码落后磁盘，排空重启没接手' }), 'recent:y'].sort())

      const checks = [{ id: 'a', level: 'ok', text: 'x' }, { id: 'b', level: 'info', text: 'x' }, { id: 'c', level: 'warn', text: 'y' }, { id: 'd', level: 'bad', text: 'z' }, { id: 'e', level: 'warn', text: 'w' }]
      const state = { notified: { [doctorCheckKey(checks[4])]: now - 1 } }
      assert.deepEqual(pickNotifiable({ report: { checks }, state, now }).map((item) => item.id), ['c', 'd'])
      assert.deepEqual(pickNotifiable({ report: { checks }, state: {}, now }).map((item) => item.id), ['c', 'd', 'e'])
      assert.equal(doctorCheckKey({ id: 'w', text: '停 10 分钟' }), doctorCheckKey({ id: 'w', text: '停 70 分钟' }))
      assert.notEqual(doctorCheckKey({ id: 'w', text: '停 10 分钟' }), doctorCheckKey({ id: 'v', text: '停 10 分钟' }))
    }))

  it('私信返回 ok:false 或抛错 → 不记已报，下一轮照报；状态写失败只记日志', () =>
    withTmp(async (dir) => {
      let result = { ok: false, reason: 'HTTP 400 {"code":230027}' }
      const notes = []
      const { monitor, logs } = makeMonitor({ dir, clock: { at: now }, input: () => staleInput, notify: async (text) => { notes.push(text); if (result instanceof Error) throw result; return result } })
      const failed = await monitor.tick()
      assert.deepEqual([failed.failed, failed.notified.length], [true, 0])
      assert.match(logs.at(-1), /私信失败（下次再报）：HTTP 400/)
      result = new Error('boom')
      assert.equal((await monitor.tick()).failed, true)
      assert.match(logs.at(-1), /Error: boom/)
      result = undefined
      assert.equal((await monitor.tick()).notified.length, 1, '前两次没报出去，这次照报；notify 返回 undefined 视为发出')
      assert.equal((await monitor.tick()).notified.length, 0, '报出去之后才去重')
      assert.equal(notes.length, 3)

      const blocked = join(dir, 'blocker')
      writeFileSync(blocked, 'x')
      const logs2 = []
      const monitor2 = createDoctorMonitor({ collect: async () => staleInput, notify: async () => ({ ok: true }), statePath: join(blocked, 'state.json'), now: () => now, log: (line) => logs2.push(line), lidClosed: async () => false, lastSleepAt: async () => null })
      assert.equal((await monitor2.tick()).notified.length, 1)
      assert.match(logs2.join('\n'), /体检状态写入失败/)
    }))

  it('合盖 / 刚醒 10 分钟内不体检、不私信；醒了满 10 分钟照常', () =>
    withTmp(async (dir) => {
      const notes = []
      const notify = async (text) => { notes.push(text) }
      const lid = makeMonitor({ dir, clock: { at: now }, input: () => staleInput, notify, lid: true })
      assert.deepEqual(await lid.monitor.tick(), { report: null, notified: [], skipped: 'lid-closed' })
      const woke = makeMonitor({ dir, clock: { at: now }, input: () => staleInput, notify, sleptAt: now - WAKE_GRACE_MS + 1 })
      assert.equal((await woke.monitor.tick()).skipped, 'just-woke')
      assert.deepEqual(notes, [])
      const awake = makeMonitor({ dir, clock: { at: now }, input: () => staleInput, notify, sleptAt: now - WAKE_GRACE_MS })
      const ran = await awake.monitor.tick()
      assert.equal(ran.skipped, undefined)
      assert.equal(ran.notified.length, 1)
    }))
})

describe('startDoctorSchedule / doctorNotifier（worker 装配）', () => {
  it('关着只打一行不起定时器；开着按 firstMs 首跑、tick 异常只记日志；私信走 notifyOpenId，没配只写日志', async () => {
    const logs = []
    const off = startDoctorSchedule({ selfHeal: { doctor: false }, env: {}, log: (line) => logs.push(line), monitor: { tick: async () => assert.fail('关着不该跑') } })
    assert.equal(off.enabled, false)
    off.stop()
    assert.match(logs[0], /体检：关（配置 \/ 环境关闭；lark-bot doctor 手动命令照常可用）/)

    let ticks = 0
    const on = startDoctorSchedule({
      selfHeal: {}, env: {}, notifyOpenId: 'ou_x', firstMs: 5, everyMs: 60 * 60_000,
      log: (line) => logs.push(line),
      monitor: { tick: async () => { ticks += 1; throw new Error('collect boom') } },
    })
    assert.equal(on.enabled, true)
    assert.match(logs[1], /体检：开（0 分钟后首次、之后每 60 分钟；异常私信 notifyOpenId/)
    await new Promise((resolve) => setTimeout(resolve, 30))
    on.stop()
    assert.equal(ticks, 1)
    assert.match(logs[2], /体检 tick 异常（忽略）：Error: collect boom/)
    const quiet = startDoctorSchedule({ selfHeal: {}, env: {}, log: (line) => logs.push(line), monitor: { tick: async () => {} } })
    quiet.stop()
    assert.match(logs[3], /3 分钟后首次、之后每 60 分钟；异常只写日志：未配 notifyOpenId/)

    const sent = []
    const dm = doctorNotifier({ notifyOpenId: 'ou_x', send: async (args) => { sent.push(args); return { ok: true } } })
    assert.deepEqual(await dm('hi', { idempotencyKey: 'k' }), { ok: true })
    assert.deepEqual(sent, [{ chatId: 'ou_x', text: 'hi', idempotencyKey: 'k', logPrefix: 'doctor' }])
    const logOnly = []
    await doctorNotifier({ notifyOpenId: null, send: () => assert.fail('没配不发'), log: (line) => logOnly.push(line) })('hi')
    assert.match(logOnly[0], /未配 notifyOpenId，只写日志）：\nhi/)
  })
})

describe('取数与 CLI', () => {
  it('collectDoctorInputs：health 不可达时自己读心跳、取不到任务列表记 null；runDoctorCli 有 warn / bad 返回 1，--json 输出报告', () =>
    withTmp(async (dir) => {
      writeFileSync(join(dir, 'lark-worker-state.json'), JSON.stringify({ pid: 5, codeHash: 'x', heartbeatAt: iso(0), readiness: { ok: true } }))
      const down = await collectDoctorInputs({ gatewayUrl: 'http://x', listTasks: async () => { throw new Error('401') }, runtimeDir: dir, fetchImpl: async () => { throw new Error('ECONNREFUSED') }, now })
      assert.deepEqual([down.health, down.tasks, down.heartbeat.pid, down.poller, down.selfFix, down.failures.total], [null, null, 5, null, null, 0])
      const up = await collectDoctorInputs({ gatewayUrl: 'http://x', listTasks: async () => [], runtimeDir: dir, fetchImpl: async () => ({ json: async () => healthy }), now })
      assert.deepEqual([up.health, up.tasks, up.heartbeat], [healthy, [], null])

      const out = []
      const code = await runDoctorCli({ argv: ['--json'], out: (text) => out.push(text), gatewayUrl: 'http://x', listTasks: async () => [], runtimeDir: dir, fetchImpl: async () => ({ json: async () => healthy }), now })
      assert.equal(code, 0)
      assert.equal(JSON.parse(out[0]).level, 'info', '只有轮询没在跑这一条 info')
      const text = []
      assert.equal(await runDoctorCli({ argv: [], out: (line) => text.push(line), gatewayUrl: 'http://x', listTasks: async () => [], runtimeDir: dir, fetchImpl: async () => { throw new Error('down') }, now }), 1)
      assert.match(text[0], /^✖ gateway 不可达/)
    }))

  it('lark-bot doctor [--json]：真走 scripts/lark-bot → scripts/lark-doctor.mjs，健康退出 0、长连接掉线退出 1、gateway 不在退出 1', () =>
    withTmp(async (dir) => {
      let health = healthy
      const server = createServer((req, res) => {
        res.writeHead(req.url === '/lark/health' && !health.ok ? 503 : 200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(req.url === '/lark/health' ? health : { tasks: [] }))
      })
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      const run = (args, gatewayUrl) =>
        new Promise((resolve) => {
          const env = { ...process.env, HOME: dir, LARK_BOT_ROOT: root, LARK_RUNTIME_DIR: join(dir, 'runtime'), LARK_GATEWAY_URL: gatewayUrl, LARK_GATEWAY_SECRET: 's' }
          execFile('bash', [join(root, 'scripts/lark-bot'), 'doctor', ...args], { env, encoding: 'utf8' }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }))
        })
      try {
        const url = `http://127.0.0.1:${server.address().port}`
        const ok = await run(['--json'], url)
        assert.equal(ok.code, 0, ok.stderr)
        assert.deepEqual(JSON.parse(ok.stdout).checks.map((item) => item.level), ['ok', 'ok', 'ok', 'info', 'ok', 'ok', 'ok'])
        health = { ...healthy, ok: false }
        const lost = await run([], url)
        assert.equal(lost.code, 1)
        assert.match(lost.stdout, /✖ gateway 在，但飞书长连接不在线/)
        server.close()
        const gone = await run([], url)
        assert.equal(gone.code, 1)
        assert.match(gone.stdout, /✖ gateway 不可达/)
      } finally {
        server.close()
      }
    }))
})
