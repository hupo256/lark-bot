#!/usr/bin/env node
/**
 * 排空重启（自愈环 3）：决策纯函数 + 驱动器的副作用顺序。
 *   node --test __tests__/lark-drain-restart.test.mjs
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SETTLE_MS, RESTART_OVERDUE_MS, checkConfigFile, createDrainRestart, pickFailingTests, planDrainRestart } from '../lib/lark-drain-restart.mjs'
import { runSteps } from './support/steps.mjs'

const fresh = { codeStale: false, configStale: false, codeHash: 'a', diskCodeHash: 'a', diskConfigHash: 'c', diskChangedAt: null }
const stale = (changedAgoMs = 10 * 60_000, now = 1_000_000_000) => ({
  codeStale: true, configStale: false, codeHash: 'a', diskCodeHash: 'b', diskConfigHash: 'c',
  diskChangedAt: new Date(now - changedAgoMs).toISOString(),
})

describe('planDrainRestart', () => {
  const now = 1_000_000_000
  it('排空重启决策：none / 排空 / 等待 / verify / skip-failed / 等 SIGTERM', () => runSteps([
    ['关着 / 磁盘一致 → none；排空中又一致 → cancel-drain', () => {
      assert.equal(planDrainRestart({ version: stale(), enabled: false }).action, 'none')
      assert.equal(planDrainRestart({ version: fresh, now }).action, 'none')
      const plan = planDrainRestart({ version: fresh, now, state: { draining: true, restartRequestedAt: 1 } })
      assert.equal(plan.action, 'cancel-drain')
      assert.deepEqual(plan.patch, { draining: false, restartRequestedAt: null })
    }],
    ['磁盘变了 → 先进入排空；有在飞就等；刚改完不到 settleMs 也等；都满足才 verify', () => {
      assert.equal(planDrainRestart({ version: stale(0, now), now }).action, 'start-drain')
      const draining = { draining: true }
      assert.equal(planDrainRestart({ version: stale(0, now), now, state: draining, inFlight: 2 }).action, 'wait-inflight')
      assert.equal(planDrainRestart({ version: stale(DEFAULT_SETTLE_MS - 1, now), now, state: draining }).action, 'wait-settle')
      assert.equal(planDrainRestart({ version: stale(DEFAULT_SETTLE_MS + 1, now), now, state: draining }).action, 'verify')
    }],
    ['这版磁盘代码测试红过 → skip-failed，直到磁盘再变', () => {
      const state = { failedKey: 'b:c' }
      assert.equal(planDrainRestart({ version: stale(), now, state }).action, 'skip-failed')
      assert.equal(planDrainRestart({ version: { ...stale(), diskCodeHash: 'd' }, now, state }).action, 'start-drain')
    }],
    ['已发起重启 → 等 SIGTERM；逾期没死 → 再 verify 一次', () => {
      const state = { draining: true, restartRequestedAt: now - 1000 }
      assert.equal(planDrainRestart({ version: stale(), now, state }).action, 'wait-restart')
      const overdue = planDrainRestart({ version: stale(), now: now + RESTART_OVERDUE_MS + 1, state })
      assert.equal(overdue.action, 'verify')
      assert.deepEqual(overdue.patch, { restartRequestedAt: null })
    }],
    ['只改配置（代码一致）也走排空', () => {
      const version = { ...fresh, configStale: true, diskConfigHash: 'c2' }
      assert.equal(planDrainRestart({ version, now }).action, 'start-drain')
    }],
  ]))
})

describe('createDrainRestart（驱动器）', () => {
  const makeVersion = () => {
    let snapshot = { ...fresh }
    return { observe: () => snapshot, set: (next) => { snapshot = next } }
  }
  it('驱动器：排空后测试绿才重启、红则私信退出排空、只改配置做配置自检、关闭时不排空；失败摘要带段标题', () => runSteps([
    ['磁盘变 → 排空 → 0 在飞且稳定 → 跑测试 → 绿则发起重启一次，之后只等', async () => {
      let clock = 1_000_000_000
      const version = makeVersion()
      const calls = { tests: 0, restarts: 0, notes: [] }
      const drain = createDrainRestart({
        version, now: () => clock, log: () => {},
        runTests: () => { calls.tests += 1; return { ok: true, summary: 'tests 640 pass 640 fail 0', failing: [] } },
        requestRestart: () => { calls.restarts += 1; return 4242 },
        notify: async (text) => { calls.notes.push(text) },
      })
      assert.equal((await drain.tick({ inFlight: 1 })).action, 'none')
      version.set(stale(0, clock))
      assert.equal((await drain.tick({ inFlight: 1 })).action, 'start-drain')
      assert.equal(drain.isDraining(), true)
      assert.equal((await drain.tick({ inFlight: 1 })).action, 'wait-inflight')
      assert.equal((await drain.tick({ inFlight: 0 })).action, 'wait-settle')
      clock += DEFAULT_SETTLE_MS + 1
      assert.equal((await drain.tick({ inFlight: 0 })).action, 'verify')
      assert.deepEqual([calls.tests, calls.restarts, calls.notes.length], [1, 1, 0])
      assert.equal((await drain.tick({ inFlight: 0 })).action, 'wait-restart')
      assert.equal(calls.restarts, 1)
    }],
    ['测试红 → 不重启、私信一次、退出排空继续领任务；同一版磁盘不再重跑测试', async () => {
      let clock = 1_000_000_000
      const version = makeVersion()
      const calls = { tests: 0, restarts: 0, notes: [] }
      const drain = createDrainRestart({
        version, now: () => clock, log: () => {},
        runTests: () => { calls.tests += 1; return { ok: false, summary: 'tests 640 pass 639 fail 1', failing: ['✖ x 坏了'] } },
        requestRestart: () => { calls.restarts += 1 },
        notify: async (text) => { calls.notes.push(text) },
      })
      version.set(stale(DEFAULT_SETTLE_MS + 5, clock))
      await drain.tick({ inFlight: 0 })
      assert.equal((await drain.tick({ inFlight: 0 })).action, 'verify')
      assert.equal(drain.isDraining(), false)
      assert.deepEqual([calls.tests, calls.restarts, calls.notes.length], [1, 0, 1])
      assert.match(calls.notes[0], /没重启、还在跑旧代码[\s\S]*fail 1[\s\S]*✖ x 坏了/)
      assert.equal((await drain.tick({ inFlight: 0 })).action, 'skip-failed')
      assert.equal(calls.tests, 1)
      // 再改一版 → 重新排空、重新测
      version.set({ ...stale(DEFAULT_SETTLE_MS + 5, clock), diskCodeHash: 'e' })
      assert.equal((await drain.tick({ inFlight: 0 })).action, 'start-drain')
      assert.equal((await drain.tick({ inFlight: 0 })).action, 'verify')
      assert.equal(calls.tests, 2)
    }],
    ['只改配置不跑单测、做配置自检：绿则重启；红则不重启、私信一次、同一版不再重试（10-24：以前只改配置直接放行，坏配置会让 gateway 起不来）', async () => {
      for (const configOk of [true, false]) {
        const clock = 1_000_000_000
        const version = makeVersion()
        const calls = { tests: 0, checks: [], restarts: 0, notes: [] }
        const drain = createDrainRestart({
          version, now: () => clock, log: () => {}, configPath: '/tmp/x.json',
          runTests: () => { calls.tests += 1; return { ok: true, summary: '', failing: [] } },
          checkConfig: (path) => { calls.checks.push(path); return configOk ? { ok: true, summary: '配置校验通过', failing: [] } : { ok: false, summary: '配置校验 1 条不过', failing: ['project 必填'] } },
          requestRestart: () => { calls.restarts += 1 },
          notify: async (text) => { calls.notes.push(text) },
        })
        version.set({ ...fresh, configStale: true, diskConfigHash: 'c2' })
        await drain.tick({ inFlight: 0 })
        assert.equal((await drain.tick({ inFlight: 0 })).action, 'verify')
        assert.deepEqual([calls.tests, calls.checks, calls.restarts], [0, ['/tmp/x.json'], configOk ? 1 : 0], `configOk=${configOk}`)
        if (!configOk) {
          assert.equal(calls.notes.length, 1)
          assert.match(calls.notes[0], /自检没过[\s\S]*project 必填/)
          assert.equal((await drain.tick({ inFlight: 0 })).action, 'skip-failed', '同一版磁盘不再重试')
        }
      }
    }],
    ['checkConfigFile：读不了 / 结构校验不过（含仓库 profile 写错）都拦下，合法配置放行（10-24）', () => {
      const dir = mkdtempSync(join(tmpdir(), 'lark-drain-cfg-'))
      try {
        const write = (name, body) => { const path = join(dir, name); writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body)); return path }
        const base = { project: 'PR-02306', botOpenId: 'ou_bot', allowedChatIds: 'auto', bugTable: { appToken: 'app', tableId: 'tbl', statusField: '状态', assigneeField: '负责人', doneValue: '已处理' } }
        assert.match(checkConfigFile(write('bad.json', '{ not json')).summary, /^配置读不了：Expected property name/, '直接给解析报错原文，不带 Error 类型前缀')
        assert.match(checkConfigFile(write('invalid.json', { ...base, project: '  ' })).summary, /配置校验 \d+ 条不过/)
        assert.match(checkConfigFile(write('profile.json', { ...base, repos: { falive: { baseRef: 'main' } } })).failing.join('\n'), /repos\.falive\.root 必填/, '仓库 profile 写错也在结构校验里拦下')
        assert.deepEqual(checkConfigFile(write('ok.json', base)), { ok: true, summary: '配置校验通过', failing: [] })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }],
    ['关闭时永远 none，不排空', async () => {
      const version = makeVersion()
      version.set(stale())
      const drain = createDrainRestart({ version, enabled: false, log: () => {} })
      assert.equal((await drain.tick({ inFlight: 0 })).action, 'none')
      assert.equal(drain.isDraining(), false)
    }],
    ['红了私信里的失败摘要：只摘「✖ failing tests:」那一节，合并用例带出「▶ 段标题 ◀」；没有那一节退回所有 ✖ 行', () => {
      const stdout = [
        '▶ 出口闸',
        '  ✖ 合并过的用例 (1.2ms)',
        '    AssertionError [ERR_ASSERTION]: 2 / 3 段失败：',
        '    ▶ 段一 ◀ Expected values to be strictly equal:',
        '✖ 出口闸 (2.1ms)',
        '✖ __tests__/lark-x.test.mjs (30ms)',
        'ℹ tests 3',
        'ℹ fail 2',
        '',
        '✖ failing tests:',
        '',
        'test at __tests__/lark-x.test.mjs:10:3',
        '✖ 合并过的用例 (1.2ms)',
        '  AssertionError [ERR_ASSERTION]: 2 / 3 段失败：',
        '  ▶ 段一 ◀ Expected values to be strictly equal:',
        '      at file:///r/__tests__/lark-x.test.mjs:12:5',
        '  ▶ 段二 ◀ boom',
        '      at file:///r/__tests__/lark-x.test.mjs:15:5',
        '      at runSteps (file:///r/__tests__/support/steps.mjs:26:9)',
        '  {',
        "    code: 'ERR_ASSERTION',",
        '  }',
        '',
        'test at __tests__/lark-y.test.mjs:5:3',
        '✖ 普通用例 (0.3ms)',
        '  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:',
        '  + actual - expected',
        '',
        '  + [',
        "  +   'b'",
        '  + ]',
        "  - [ 'a' ]",
        "  [ 'a' ]",
        '',
        '      at TestContext.<anonymous> (file:///r/__tests__/lark-y.test.mjs:6:12)',
      ].join('\n')
      const picked = pickFailingTests(stdout)
      assert.deepEqual(picked, [
        '✖ 合并过的用例 (1.2ms) → 段一 / 段二',
        '✖ 普通用例 (0.3ms) → AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:',
      ])
      assert.ok(picked.every((line) => !line.includes("[ 'a' ]") && !line.includes('failing tests') && !line.includes('lark-x.test.mjs')), '方括号行、节标题、文件级 ✖ 都不进摘要')
      const noSection = ['✔ ok (1ms)', '✖ a (1ms)', '  ✖ nested (0.1ms)', "  [ 'a' ]", '✖ __tests__/lark-z.test.mjs (5ms)'].join('\n')
      assert.deepEqual(pickFailingTests(noSection), ['✖ a (1ms)', '✖ __tests__/lark-z.test.mjs (5ms)'])
      assert.deepEqual(pickFailingTests(''), [])
    }],
  ]))
})
