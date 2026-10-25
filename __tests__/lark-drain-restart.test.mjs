#!/usr/bin/env node
/**
 * 排空重启（从 falive 移植）：决策纯函数 + 驱动器的副作用顺序 + 默认副作用（自检 / 发起重启）。
 *   node --test __tests__/lark-drain-restart.test.mjs
 */
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  DEFAULT_SETTLE_MS,
  RESTART_OVERDUE_MS,
  checkConfigFile,
  createDrainRestart,
  drainRestartSwitch,
  hermeticTestEnv,
  pickFailingTests,
  planDrainRestart,
  requestRestartViaScript,
  runSelfTests,
} from '../lib/lark-drain-restart.mjs'

const fresh = { codeStale: false, configStale: false, codeHash: 'a', diskCodeHash: 'a', diskConfigHash: 'c', diskChangedAt: null }
const stale = (changedAgoMs = 10 * 60_000, now = 1_000_000_000) => ({
  codeStale: true, configStale: false, codeHash: 'a', diskCodeHash: 'b', diskConfigHash: 'c',
  diskChangedAt: new Date(now - changedAgoMs).toISOString(),
})
const withTmp = async (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'lark-drain-'))
  try {
    return await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('drainRestartSwitch（开关）', () => {
  it('配置 / 环境可关；只在 launchd 托管（有 LARK_LOG_FILE）时开', () => {
    const launchd = { LARK_LOG_FILE: '/tmp/worker.log' }
    const cases = [
      [{}, launchd, true, 'launchd 托管'],
      [{ drainRestart: true }, launchd, true, 'launchd 托管'],
      [{ drainRestart: false }, launchd, false, '配置 / 环境关闭'],
      [{}, { ...launchd, LARK_DRAIN_RESTART: '0' }, false, '配置 / 环境关闭'],
      [{}, { ...launchd, LARK_DRAIN_RESTART: '1' }, true, 'launchd 托管'],
      [{}, {}, false, '非 launchd 托管'],
      [undefined, launchd, true, 'launchd 托管'],
    ]
    for (const [selfHeal, env, enabled, reason] of cases) {
      assert.deepEqual(drainRestartSwitch({ selfHeal, env }), { enabled, reason }, JSON.stringify({ selfHeal, env }))
    }
  })
})

describe('planDrainRestart', () => {
  const now = 1_000_000_000
  it('关着 / 磁盘一致 → none；排空中又一致 → cancel-drain', () => {
    assert.equal(planDrainRestart({ version: stale(), enabled: false }).action, 'none')
    assert.equal(planDrainRestart({ version: null }).action, 'none')
    assert.equal(planDrainRestart({ version: fresh, now }).action, 'none')
    const plan = planDrainRestart({ version: fresh, now, state: { draining: true, restartRequestedAt: 1 } })
    assert.equal(plan.action, 'cancel-drain')
    assert.deepEqual(plan.patch, { draining: false, restartRequestedAt: null })
  })

  it('磁盘变了 → 先进入排空；有在飞就等；刚改完不到 settleMs 也等；都满足才 verify', () => {
    const start = planDrainRestart({ version: stale(0, now), now })
    assert.deepEqual([start.action, start.reason, start.patch], ['start-drain', '磁盘代码已更新', { draining: true }])
    const draining = { draining: true }
    assert.equal(planDrainRestart({ version: stale(0, now), now, state: draining, inFlight: 2 }).action, 'wait-inflight')
    assert.equal(planDrainRestart({ version: stale(DEFAULT_SETTLE_MS - 1, now), now, state: draining }).action, 'wait-settle')
    assert.equal(planDrainRestart({ version: stale(DEFAULT_SETTLE_MS, now), now, state: draining }).action, 'verify', '正好 settleMs 就算稳定')
    assert.equal(planDrainRestart({ version: stale(DEFAULT_SETTLE_MS + 1, now), now, state: draining }).action, 'verify')
    assert.equal(planDrainRestart({ version: { ...stale(), diskChangedAt: null }, now, state: draining }).action, 'verify', '没有改动时间就不等')
    assert.equal(planDrainRestart({ version: stale(1000, now), now, state: draining, settleMs: 500 }).action, 'verify', 'settleMs 可配')
  })

  it('这版磁盘自检红过 → skip-failed，直到磁盘（代码或配置）再变', () => {
    const state = { failedKey: 'b:c' }
    assert.equal(planDrainRestart({ version: stale(), now, state }).action, 'skip-failed')
    assert.equal(planDrainRestart({ version: { ...stale(), diskCodeHash: 'd' }, now, state }).action, 'start-drain')
    assert.equal(planDrainRestart({ version: { ...stale(), diskConfigHash: 'c2' }, now, state }).action, 'start-drain')
  })

  it('已发起重启 → 等 SIGTERM；逾期没死 → 再 verify 一次', () => {
    const state = { draining: true, restartRequestedAt: now - 1000 }
    assert.equal(planDrainRestart({ version: stale(), now, state }).action, 'wait-restart')
    assert.equal(planDrainRestart({ version: stale(), now: now - 1000 + RESTART_OVERDUE_MS - 1, state }).action, 'wait-restart')
    const overdue = planDrainRestart({ version: stale(), now: now - 1000 + RESTART_OVERDUE_MS, state })
    assert.equal(overdue.action, 'verify')
    assert.deepEqual(overdue.patch, { restartRequestedAt: null })
  })

  it('只改配置（代码一致）也走排空', () => {
    const plan = planDrainRestart({ version: { ...fresh, configStale: true, diskConfigHash: 'c2' }, now })
    assert.deepEqual([plan.action, plan.reason], ['start-drain', '磁盘配置已更新'])
  })
})

describe('createDrainRestart（驱动器）', () => {
  const makeVersion = () => {
    let snapshot = { ...fresh }
    return { observe: () => snapshot, set: (next) => { snapshot = next } }
  }
  const makeDrain = ({ clock, version, tests = { ok: true, summary: 'ℹ tests 9 ℹ pass 9 ℹ fail 0', failing: [] }, config = { ok: true, summary: '配置校验通过', failing: [] }, notify, ...rest }) => {
    const calls = { tests: 0, configs: [], restarts: 0, notes: [], logs: [] }
    const drain = createDrainRestart({
      version,
      configPath: '/cfg.json',
      now: () => clock.now,
      log: (line) => calls.logs.push(line),
      runTests: () => { calls.tests += 1; return tests },
      checkConfig: (path) => { calls.configs.push(path); return config },
      requestRestart: () => { calls.restarts += 1; return 4242 },
      notify: notify || (async (text, options) => { calls.notes.push({ text, ...options }) }),
      ...rest,
    })
    return { drain, calls }
  }

  it('磁盘变 → 排空 → 0 在飞且稳定 → 跑测试 → 绿则发起重启一次，之后只等', async () => {
    const clock = { now: 1_000_000_000 }
    const version = makeVersion()
    const { drain, calls } = makeDrain({ clock, version })
    assert.equal((await drain.tick({ inFlight: 1 })).action, 'none')
    version.set(stale(0, clock.now))
    assert.equal((await drain.tick({ inFlight: 1 })).action, 'start-drain')
    assert.equal(drain.isDraining(), true)
    assert.equal((await drain.tick({ inFlight: 1 })).action, 'wait-inflight')
    assert.equal((await drain.tick({ inFlight: 0 })).action, 'wait-settle')
    clock.now += DEFAULT_SETTLE_MS + 1
    assert.equal((await drain.tick({ inFlight: 0 })).action, 'verify')
    assert.deepEqual([calls.tests, calls.configs.length, calls.restarts, calls.notes.length], [1, 0, 1, 0])
    assert.equal(drain.state.restartRequestedAt, clock.now)
    assert.equal((await drain.tick({ inFlight: 0 })).action, 'wait-restart')
    assert.equal(calls.restarts, 1)
    assert.ok(calls.logs.some((line) => /自检绿.*pid 4242/.test(line)))
    assert.ok(calls.logs.some((line) => line.includes('磁盘代码已更新（代码 a → b）')), calls.logs.join('\n'))
    // 排空中磁盘又改回来 → 取消排空
    version.set({ ...fresh })
    assert.equal((await drain.tick({ inFlight: 0 })).action, 'cancel-drain')
    assert.equal(drain.isDraining(), false)
  })

  it('测试红 → 不重启、私信一次（带幂等键）、退出排空继续领任务；同一版磁盘不再重跑；再改一版重新测', async () => {
    const clock = { now: 1_000_000_000 }
    const version = makeVersion()
    const { drain, calls } = makeDrain({ clock, version, tests: { ok: false, summary: 'ℹ tests 9 ℹ pass 8 ℹ fail 1', failing: ['✖ x 坏了'] } })
    version.set(stale(DEFAULT_SETTLE_MS + 5, clock.now))
    await drain.tick({ inFlight: 0 })
    assert.equal((await drain.tick({ inFlight: 0 })).action, 'verify')
    assert.equal(drain.isDraining(), false)
    assert.deepEqual([calls.tests, calls.restarts, calls.notes.length], [1, 0, 1])
    assert.match(calls.notes[0].text, /没重启、还在跑旧代码（a）[\s\S]*fail 1\n✖ x 坏了\n修好再存盘/)
    assert.equal(calls.notes[0].idempotencyKey, 'drain-red-b:c')
    assert.ok(calls.logs.some((line) => line.includes('自检红') && line.includes('红：✖ x 坏了')), '红的项也进日志')
    assert.equal((await drain.tick({ inFlight: 0 })).action, 'skip-failed')
    assert.equal(calls.tests, 1)
    version.set({ ...stale(DEFAULT_SETTLE_MS + 5, clock.now), diskCodeHash: 'e' })
    assert.equal((await drain.tick({ inFlight: 0 })).action, 'start-drain')
    assert.equal((await drain.tick({ inFlight: 0 })).action, 'verify')
    assert.equal(calls.tests, 2)
  })

  it('私信失败只记日志不抛；红但没有失败明细时消息里不带空行', async () => {
    const clock = { now: 1_000_000_000 }
    const version = makeVersion()
    const { drain, calls } = makeDrain({
      clock, version,
      tests: { ok: false, summary: 'exit 1', failing: [] },
      notify: async () => { throw new Error('lark down') },
    })
    version.set(stale(DEFAULT_SETTLE_MS + 5, clock.now))
    await drain.tick({ inFlight: 0 })
    await drain.tick({ inFlight: 0 })
    assert.ok(calls.logs.some((line) => line.includes('私信失败（忽略）') && line.includes('lark down')))
    assert.ok(calls.logs.some((line) => line.endsWith('不重启。exit 1')))
    let text = ''
    const quiet = makeDrain({ clock, version, tests: { ok: false, summary: 'exit 1', failing: [] }, notify: async (t) => { text = t } })
    await quiet.drain.tick({ inFlight: 0 })
    await quiet.drain.tick({ inFlight: 0 })
    assert.match(text, /exit 1\n修好再存盘/)
  })

  it('只改配置：不跑单测、校验配置；绿直接重启，红不重启；代码配置都改两样都做', async () => {
    const clock = { now: 1_000_000_000 }
    const configOnly = { ...fresh, configStale: true, configHash: 'c', diskConfigHash: 'c2' }
    {
      const version = makeVersion()
      const { drain, calls } = makeDrain({ clock, version })
      version.set(configOnly)
      await drain.tick({ inFlight: 0 })
      assert.equal((await drain.tick({ inFlight: 0 })).action, 'verify')
      assert.deepEqual([calls.tests, calls.configs, calls.restarts], [0, ['/cfg.json'], 1])
      // 10-24 沙箱试跑：只改配置时日志打的是代码哈希（a → a），看不出改了什么。
      assert.ok(calls.logs.some((line) => line.includes('磁盘配置已更新（配置 c → c2）')), calls.logs.join('\n'))
    }
    {
      const version = makeVersion()
      const { drain, calls } = makeDrain({ clock, version, config: { ok: false, summary: '配置校验 1 条不过', failing: ['project 必填'] } })
      version.set(configOnly)
      await drain.tick({ inFlight: 0 })
      await drain.tick({ inFlight: 0 })
      assert.deepEqual([calls.restarts, calls.notes.length], [0, 1])
      assert.match(calls.notes[0].text, /配置校验 1 条不过\nproject 必填/)
    }
    {
      const version = makeVersion()
      const { drain, calls } = makeDrain({ clock, version, config: { ok: false, summary: '配置读不了', failing: [] } })
      version.set({ ...stale(DEFAULT_SETTLE_MS + 5, clock.now), configStale: true, configHash: 'c0' })
      await drain.tick({ inFlight: 0 })
      assert.ok(calls.logs.some((line) => line.includes('磁盘代码已更新（代码 a → b，配置 c0 → c）')), calls.logs.join('\n'))
      await drain.tick({ inFlight: 0 })
      assert.deepEqual([calls.tests, calls.configs.length, calls.restarts], [1, 1, 0], '测试绿但配置红也不重启')
      assert.match(calls.notes[0].text, /fail 0；配置读不了/)
    }
  })

  it('关闭时永远 none，不排空', async () => {
    const version = makeVersion()
    version.set(stale())
    const drain = createDrainRestart({ version, enabled: false, log: () => {} })
    assert.equal((await drain.tick({ inFlight: 0 })).action, 'none')
    assert.equal(drain.isDraining(), false)
  })
})

describe('pickFailingTests', () => {
  it('只摘「✖ failing tests:」那一节，合并用例带出「▶ 段标题 ◀」；没有那一节退回所有 ✖ 行', () => {
    const stdout = [
      '▶ 出口闸',
      '  ✖ 合并过的用例 (1.2ms)',
      '✖ 出口闸 (2.1ms)',
      '✖ __tests__/lark-x.test.mjs (30ms)',
      'ℹ tests 3',
      '',
      '✖ failing tests:',
      '',
      'test at __tests__/lark-x.test.mjs:10:3',
      '✖ 合并过的用例 (1.2ms)',
      '  AssertionError [ERR_ASSERTION]: 2 / 3 段失败：',
      '  ▶ 段一 ◀ Expected values to be strictly equal:',
      '      at file:///r/__tests__/lark-x.test.mjs:12:5',
      '  ▶ 段二 ◀ boom',
      '',
      'test at __tests__/lark-y.test.mjs:5:3',
      '✖ 普通用例 (0.3ms)',
      '      at TestContext.<anonymous> (file:///r/__tests__/lark-y.test.mjs:6:12)',
      '  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:',
      "  [ 'a' ]",
      '',
      'test at __tests__/lark-z.test.mjs:1:1',
      '✖ 没有说明的用例 (0.1ms)',
    ].join('\n')
    assert.deepEqual(pickFailingTests(stdout), [
      '✖ 合并过的用例 (1.2ms) → 段一 / 段二',
      '✖ 普通用例 (0.3ms) → AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:',
      '✖ 没有说明的用例 (0.1ms)',
    ])
    assert.deepEqual(pickFailingTests(stdout, { limit: 1 }), ['✖ 合并过的用例 (1.2ms) → 段一 / 段二'])
    assert.deepEqual(pickFailingTests(stdout, { stepLimit: 1 }).slice(0, 1), ['✖ 合并过的用例 (1.2ms) → 段一 / 另 1 段'])
    assert.deepEqual(pickFailingTests(stdout, { stepLimit: 2 }).slice(0, 1), ['✖ 合并过的用例 (1.2ms) → 段一 / 段二'], '正好摘满不带「另 0 段」')
    // 节标题在第一行（只有失败节的输出）也按节解析，不把节标题当失败项
    assert.deepEqual(pickFailingTests(['✖ failing tests:', '✖ 唯一 (1ms)', '  boom'].join('\n')), ['✖ 唯一 (1ms) → boom'])
    const noSection = ['✔ ok (1ms)', '✖ a (1ms)', '  ✖ nested (0.1ms)', "  [ 'a' ]", '✖ __tests__/lark-z.test.mjs (5ms)'].join('\n')
    assert.deepEqual(pickFailingTests(noSection), ['✖ a (1ms)', '✖ __tests__/lark-z.test.mjs (5ms)'])
    assert.deepEqual(pickFailingTests(noSection, { limit: 1 }), ['✖ a (1ms)'])
    assert.deepEqual(pickFailingTests(''), [])
  })
})

describe('默认副作用', () => {
  it('hermeticTestEnv 去掉全部 LARK_* 实例变量和 NODE_TEST_CONTEXT，其余保留', () => {
    assert.deepEqual(
      hermeticTestEnv({ PATH: '/bin', LARK_LOG_FILE: 'x', LARK_GATEWAY_SECRET: 's', LARK_RUNTIME_DIR: '/r', NODE_TEST_CONTEXT: 'child-v8', HOME: '/h', MY_LARK_X: '1' }),
      { PATH: '/bin', HOME: '/h', MY_LARK_X: '1' },
    )
  })

  it('runSelfTests：异步子进程（跑测试期间事件循环不卡、心跳照常）在 hermetic 环境里跑 __tests__ 全部 *.test.mjs，红的摘出用例名；超时算红', () => withTmp(async (root) => {
    mkdirSync(join(root, '__tests__'))
    writeFileSync(join(root, '__tests__', 'a.test.mjs'), "import { it } from 'node:test'\nit('看不到实例变量', async () => { await new Promise((r) => setTimeout(r, 200)); if (process.env.LARK_DRAIN_PROBE) throw new Error('leak') })\n")
    writeFileSync(join(root, '__tests__', 'helper.mjs'), 'throw new Error("非测试文件不该被跑")\n')
    process.env.LARK_DRAIN_PROBE = '1'
    try {
      // 10-24 沙箱试跑：spawnSync 跑全量单测卡住 worker 事件循环 8–11 秒，期间心跳不更新。
      let ticks = 0
      const beat = setInterval(() => { ticks += 1 }, 20)
      beat.unref()
      const pending = runSelfTests({ root })
      const green = await pending
      clearInterval(beat)
      assert.ok(pending instanceof Promise, '自检必须是异步的')
      assert.ok(ticks >= 5, `跑测试期间定时器只走了 ${ticks} 次`)
      assert.equal(green.ok, true, green.summary)
      assert.match(green.summary, /ℹ tests 1 ℹ pass 1 ℹ fail 0/)
      assert.deepEqual(green.failing, [])
      writeFileSync(join(root, '__tests__', 'b.test.mjs'), "import { it } from 'node:test'\nit('坏用例', () => { throw new Error('boom') })\n")
      const red = await runSelfTests({ root })
      assert.equal(red.ok, false)
      assert.match(red.summary, /fail 1/)
      assert.equal(red.failing.length, 1)
      assert.match(red.failing[0], /^✖ 坏用例 .*→ .*boom/)
      const slow = await runSelfTests({ root, timeoutMs: 50 })
      assert.deepEqual([slow.ok, slow.summary], [false, '超时（50ms）'])
    } finally {
      delete process.env.LARK_DRAIN_PROBE
    }
  }))

  it('checkConfigFile：读不了 / 结构不过 → 红并带原因；合法 → 绿', () => withTmp((dir) => {
    const path = join(dir, 'cfg.json')
    const missing = checkConfigFile(path)
    assert.equal(missing.ok, false)
    assert.match(missing.summary, /^配置读不了：Missing config/)
    writeFileSync(path, '{"project":')
    assert.match(checkConfigFile(path).summary, /^配置读不了：/)
    writeFileSync(path, JSON.stringify({ title: 1 }))
    const invalid = checkConfigFile(path)
    assert.equal(invalid.ok, false)
    assert.equal(invalid.summary, '配置校验 2 条不过')
    assert.ok(invalid.failing.some((line) => line.startsWith('project 必填')))
    writeFileSync(path, JSON.stringify({ project: 'PR-01947', notifyOpenId: 'ou_x' }))
    assert.deepEqual(checkConfigFile(path), { ok: true, summary: '配置校验通过', failing: [] })
  }))

  it('requestRestartViaScript：脱离进程组起 scripts/lark-bot restart，钉住 LARK_BOT_ROOT，输出追加进日志', async () => withTmp(async (root) => {
    mkdirSync(join(root, 'scripts'))
    const script = join(root, 'scripts', 'lark-bot')
    writeFileSync(script, '#!/bin/bash\necho "args=$* root=$LARK_BOT_ROOT"\n')
    chmodSync(script, 0o755)
    const logFile = join(root, 'worker.log')
    writeFileSync(logFile, 'before\n')
    const pid = requestRestartViaScript({ root, logFile })
    assert.ok(Number.isInteger(pid) && pid > 0)
    for (let i = 0; i < 100 && !readFileSync(logFile, 'utf8').includes('args='); i += 1) await new Promise((r) => setTimeout(r, 20))
    assert.equal(readFileSync(logFile, 'utf8'), `before\nargs=restart root=${root}\n`)
    // 日志打不开（目录不存在）就丢弃输出，照样发起
    assert.ok(requestRestartViaScript({ root, logFile: join(root, 'nope', 'x.log') }) > 0)
    assert.equal(existsSync(join(root, 'nope')), false)
  }))
})
