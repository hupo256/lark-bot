#!/usr/bin/env node
/**
 * 排空重启（自愈环 3）：决策纯函数 + 驱动器的副作用顺序。
 *   node --test __tests__/lark-drain-restart.test.mjs
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { DEFAULT_SETTLE_MS, RESTART_OVERDUE_MS, createDrainRestart, planDrainRestart } from '../lib/lark-drain-restart.mjs'

const fresh = { codeStale: false, configStale: false, codeHash: 'a', diskCodeHash: 'a', diskConfigHash: 'c', diskChangedAt: null }
const stale = (changedAgoMs = 10 * 60_000, now = 1_000_000_000) => ({
  codeStale: true, configStale: false, codeHash: 'a', diskCodeHash: 'b', diskConfigHash: 'c',
  diskChangedAt: new Date(now - changedAgoMs).toISOString(),
})

describe('planDrainRestart', () => {
  const now = 1_000_000_000
  it('排空重启决策：none / 排空 / 等待 / verify / skip-failed / 等 SIGTERM', () => {
    {
      const t1 = '关着 / 磁盘一致 → none；排空中又一致 → cancel-drain'
      assert.equal(planDrainRestart({ version: stale(), enabled: false }).action, 'none', t1)
      assert.equal(planDrainRestart({ version: fresh, now }).action, 'none', t1)
      const plan = planDrainRestart({ version: fresh, now, state: { draining: true, restartRequestedAt: 1 } })
      assert.equal(plan.action, 'cancel-drain', t1)
      assert.deepEqual(plan.patch, { draining: false, restartRequestedAt: null }, t1)
    }

    {
      const t2 = '磁盘变了 → 先进入排空；有在飞就等；刚改完不到 settleMs 也等；都满足才 verify'
      assert.equal(planDrainRestart({ version: stale(0, now), now }).action, 'start-drain', t2)
      const draining = { draining: true }
      assert.equal(planDrainRestart({ version: stale(0, now), now, state: draining, inFlight: 2 }).action, 'wait-inflight', t2)
      assert.equal(planDrainRestart({ version: stale(DEFAULT_SETTLE_MS - 1, now), now, state: draining }).action, 'wait-settle', t2)
      assert.equal(planDrainRestart({ version: stale(DEFAULT_SETTLE_MS + 1, now), now, state: draining }).action, 'verify', t2)
    }

    {
      const t3 = '这版磁盘代码测试红过 → skip-failed，直到磁盘再变'
      const state = { failedKey: 'b:c' }
      assert.equal(planDrainRestart({ version: stale(), now, state }).action, 'skip-failed', t3)
      assert.equal(planDrainRestart({ version: { ...stale(), diskCodeHash: 'd' }, now, state }).action, 'start-drain', t3)
    }

    {
      const t4 = '已发起重启 → 等 SIGTERM；逾期没死 → 再 verify 一次'
      const state = { draining: true, restartRequestedAt: now - 1000 }
      assert.equal(planDrainRestart({ version: stale(), now, state }).action, 'wait-restart', t4)
      const overdue = planDrainRestart({ version: stale(), now: now + RESTART_OVERDUE_MS + 1, state })
      assert.equal(overdue.action, 'verify', t4)
      assert.deepEqual(overdue.patch, { restartRequestedAt: null }, t4)
    }

    {
      const t5 = '只改配置（代码一致）也走排空'
      const version = { ...fresh, configStale: true, diskConfigHash: 'c2' }
      assert.equal(planDrainRestart({ version, now }).action, 'start-drain', t5)
    }
  })
})

describe('createDrainRestart（驱动器）', () => {
  const makeVersion = () => {
    let snapshot = { ...fresh }
    return { observe: () => snapshot, set: (next) => { snapshot = next } }
  }
  it('驱动器：排空后测试绿才重启、红则私信退出排空、只改配置直接重启、关闭时不排空', async () => {
    {
      const t1 = '磁盘变 → 排空 → 0 在飞且稳定 → 跑测试 → 绿则发起重启一次，之后只等'
      let clock = 1_000_000_000
      const version = makeVersion()
      const calls = { tests: 0, restarts: 0, notes: [] }
      const drain = createDrainRestart({
        version, now: () => clock, log: () => {},
        runTests: () => { calls.tests += 1; return { ok: true, summary: 'tests 640 pass 640 fail 0', failing: [] } },
        requestRestart: () => { calls.restarts += 1; return 4242 },
        notify: async (text) => { calls.notes.push(text) },
      })
      assert.equal((await drain.tick({ inFlight: 1 })).action, 'none', t1)
      version.set(stale(0, clock))
      assert.equal((await drain.tick({ inFlight: 1 })).action, 'start-drain', t1)
      assert.equal(drain.isDraining(), true, t1)
      assert.equal((await drain.tick({ inFlight: 1 })).action, 'wait-inflight', t1)
      assert.equal((await drain.tick({ inFlight: 0 })).action, 'wait-settle', t1)
      clock += DEFAULT_SETTLE_MS + 1
      assert.equal((await drain.tick({ inFlight: 0 })).action, 'verify', t1)
      assert.deepEqual([calls.tests, calls.restarts, calls.notes.length], [1, 1, 0], t1)
      assert.equal((await drain.tick({ inFlight: 0 })).action, 'wait-restart', t1)
      assert.equal(calls.restarts, 1, t1)
    }

    {
      const t2 = '测试红 → 不重启、私信一次、退出排空继续领任务；同一版磁盘不再重跑测试'
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
      assert.equal((await drain.tick({ inFlight: 0 })).action, 'verify', t2)
      assert.equal(drain.isDraining(), false, t2)
      assert.deepEqual([calls.tests, calls.restarts, calls.notes.length], [1, 0, 1], t2)
      assert.match(calls.notes[0], /没重启、还在跑旧代码[\s\S]*fail 1[\s\S]*✖ x 坏了/, t2)
      assert.equal((await drain.tick({ inFlight: 0 })).action, 'skip-failed', t2)
      assert.equal(calls.tests, 1, t2)
      // 再改一版 → 重新排空、重新测
      version.set({ ...stale(DEFAULT_SETTLE_MS + 5, clock), diskCodeHash: 'e' })
      assert.equal((await drain.tick({ inFlight: 0 })).action, 'start-drain', t2)
      assert.equal((await drain.tick({ inFlight: 0 })).action, 'verify', t2)
      assert.equal(calls.tests, 2, t2)
    }

    {
      const t3 = '只改配置不跑单测，直接重启'
      const clock = 1_000_000_000
      const version = makeVersion()
      const calls = { tests: 0, restarts: 0 }
      const drain = createDrainRestart({
        version, now: () => clock, log: () => {},
        runTests: () => { calls.tests += 1; return { ok: true, summary: '', failing: [] } },
        requestRestart: () => { calls.restarts += 1 },
      })
      version.set({ ...fresh, configStale: true, diskConfigHash: 'c2' })
      await drain.tick({ inFlight: 0 })
      assert.equal((await drain.tick({ inFlight: 0 })).action, 'verify', t3)
      assert.deepEqual([calls.tests, calls.restarts], [0, 1], t3)
    }

    {
      const t4 = '关闭时永远 none，不排空'
      const version = makeVersion()
      version.set(stale())
      const drain = createDrainRestart({ version, enabled: false, log: () => {} })
      assert.equal((await drain.tick({ inFlight: 0 })).action, 'none', t4)
      assert.equal(drain.isDraining(), false, t4)
    }
  })
})
