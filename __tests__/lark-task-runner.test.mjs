import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { DEFAULT_TASK_BUDGET_MS, isShutdownAbort, remainingTaskBudgetMs, startLeaseHeartbeat } from '../lib/lark-task-runner.mjs'
import { runSteps } from './support/steps.mjs'

describe('任务截止时间与续租心跳（第 0 批）', () => {
  it('剩余预算从领取时刻起算，退出型中断不写 failed、截止超时要写', () => runSteps([
    ['剩余预算从领取时刻起算；任务自带 taskBudgetMs 优先；超预算也留 60s 写失败', () => {
      const now = Date.parse('2026-10-17T10:00:00Z')
      assert.equal(remainingTaskBudgetMs({ claimedAt: '2026-10-17T09:50:00Z' }, now), DEFAULT_TASK_BUDGET_MS - 10 * 60_000)
      assert.equal(remainingTaskBudgetMs({ claimedAt: '2026-10-17T09:00:00Z', taskBudgetMs: 30 * 60_000 }, now), 60_000)
      assert.equal(remainingTaskBudgetMs({}, now), DEFAULT_TASK_BUDGET_MS)
    }],
    ['退出型中断不写 failed，截止时间（TimeoutError）要写 failed', () => {
      const shutdown = new AbortController()
      shutdown.abort()
      assert.equal(isShutdownAbort(shutdown.signal), true)
      const timeout = AbortSignal.timeout(1)
      return new Promise((resolve) => setTimeout(() => {
        assert.equal(timeout.aborted, true)
        assert.equal(isShutdownAbort(timeout), false)
        assert.equal(isShutdownAbort(undefined), false)
        resolve()
      }, 20))
    }],
  ]))

  it('心跳每 leaseMs/3 续一次；gateway 回 ok:false（epoch 变了）就停；stop 后不再调', async () => {
    const calls = []
    let tick = null
    let cleared = 0
    const client = { heartbeatTask: async (id, epoch) => { calls.push([id, epoch]); return calls.length >= 2 ? { ok: false, code: 409 } : { ok: true } } }
    const stop = startLeaseHeartbeat({
      client,
      task: { id: 't1', epoch: 3 },
      leaseMs: 90_000,
      setIntervalImpl: (fn, ms) => { tick = fn; assert.equal(ms, 30_000); return { unref() {} } },
      clearIntervalImpl: () => { cleared += 1 },
    })
    await tick()
    assert.deepEqual(calls, [['t1', 3]])
    await tick()
    assert.equal(cleared, 1, '409 后停心跳')
    await tick()
    assert.equal(calls.length, 2, '停了就不再调')
    stop()
    assert.equal(startLeaseHeartbeat({ client: {}, task: { id: 'x' } })(), undefined, '没有 heartbeatTask 的 client 直接 no-op')
  })
})
