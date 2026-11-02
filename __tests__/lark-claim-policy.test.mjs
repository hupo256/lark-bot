/**
 * worker 领任务口径（lib/lark-claim-policy）与「有活了」等待（lib/lark-work-signal）：aven 11-02「排空 / 自修期间照样分类和答疑」
 * 「gateway 唤醒 worker」。gateway 路由那一侧（/lark/work/wait + 任务库 onClaimable）在 lark-routes.test。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { DRAIN_LIGHT_WINDOW_MS, claimAllowed, describeClaimMode, resolveClaimMode } from '../lib/lark-claim-policy.mjs'
import { deriveContract } from '../lib/lark-task-contract.mjs'
import { resolveWorkContext } from '../lib/lark-work-context.mjs'
import { MAX_WORK_WAIT_MS, clampWaitMs, createWorkSignal, createWorkWaiter } from '../lib/lark-work-signal.mjs'
import { eachCase, runSteps } from './support/steps.mjs'

const NOW = 1_800_000_000_000
// 分类落地后的正式任务：契约走真实 deriveContract，路由走真实 resolveWorkContext（只读口径两边必须对得上）。
const classified = (deliverable, decision = 'question') => {
  const task = { id: `t-${deliverable}`, source: 'lark', text: 'x', status: 'queued', intake: { required: false, classification: { decision, deliverable, confidence: 'high', selfAnswer: false } } }
  return { ...task, contract: deriveContract(task) }
}
const intake = { id: 't-intake', source: 'lark', text: 'x', status: 'received', intake: { required: true } }
const ctxOf = (task, localConfig = {}) => resolveWorkContext({ localConfig }, task)
// 手动可控的 sleep：返回的 promise 由 fire() 结束；被 abort 也结束。
const manualSleep = () => {
  const timers = []
  return { timers, sleepMs: (ms, signal) => new Promise((resolve) => { timers.push({ ms, resolve, signal }); signal?.addEventListener('abort', resolve, { once: true }) }) }
}

describe('worker 领任务口径与等待', () => {
  it('四档口径 × 任务类型；工作信号与等待器（本地唤醒 / 远端唤醒 / 旧 gateway 退回轮询）', () => runSteps([
    ['resolveClaimMode：已发起重启 none > 排空（窗口内 light、过窗口或没起点 intake）> 自修 light > 正常 all', () => eachCase([
      { name: '正常', input: {}, want: 'all' },
      { name: '自修中', input: { selfFixBusy: true }, want: 'light' },
      { name: '排空刚开始', input: { draining: true, drainingSince: NOW - 1000 }, want: 'light' },
      { name: '排空正好到窗口', input: { draining: true, drainingSince: NOW - DRAIN_LIGHT_WINDOW_MS }, want: 'intake' },
      { name: '排空没起点', input: { draining: true }, want: 'intake' },
      { name: '排空起点是 0（不是有效时间，哪怕「现在」离 0 不到窗口）', input: { draining: true, drainingSince: 0, now: 1000 }, want: 'intake' },
      { name: '排空 + 自修：排空优先', input: { draining: true, drainingSince: NOW - DRAIN_LIGHT_WINDOW_MS - 1, selfFixBusy: true }, want: 'intake' },
      { name: '已发起重启', input: { draining: true, drainingSince: NOW, restartRequested: true }, want: 'none' },
    ], ({ input, want }) => assert.equal(resolveClaimMode({ now: NOW, ...input }), want))],
    ['claimAllowed：分类除 none 都放行；答疑 / 无页面工具的实测是只读轻活；改代码、配了页面工具的实测、运维只在 all', () => {
      const answer = classified('answer')
      const verification = classified('verification')
      const change = classified('change', 'bug')
      const ops = { id: 'ops', source: 'lark', text: '运维：部署 pre', status: 'queued', commandType: 'ops', commandTypeSource: 'explicit' }
      const rows = [
        [intake, ctxOf(intake), { all: true, light: true, intake: true, none: false }],
        [answer, ctxOf(answer), { all: true, light: true, intake: false, none: false }],
        [verification, ctxOf(verification), { all: true, light: true, intake: false, none: false }],
        [verification, ctxOf(verification, { verify: { cmd: 'x' } }), { all: true, light: false, intake: false, none: false }],
        [change, ctxOf(change), { all: true, light: false, intake: false, none: false }],
        [ops, ctxOf(ops), { all: true, light: false, intake: false, none: false }],
      ]
      for (const [task, workContext, want] of rows) {
        const got = Object.fromEntries(Object.keys(want).map((mode) => [mode, claimAllowed(mode, { task, workContext })]))
        assert.deepEqual(got, want, `${task.id}（readOnly=${workContext.readOnly}）`)
      }
      assert.match(describeClaimMode('light'), /分类和只读答疑/)
      assert.equal(describeClaimMode('x'), 'x')
    }],
    ['createWorkSignal：since 缺省 / 不等 / timeout≤0 立即返回；bump 唤醒全部等待者；取消摘掉等待者；clampWaitMs 夹上限', async () => {
      const signal = createWorkSignal()
      assert.deepEqual(await signal.wait({ timeoutMs: 1000 }), { seq: 0, woke: true })
      const zero = signal.wait({ since: 0, timeoutMs: 0 })
      assert.equal(signal.waiting(), 0, 'timeout≤0 不挂起')
      assert.deepEqual(await zero, { seq: 0, woke: false })
      const a = signal.wait({ since: 0, timeoutMs: 5000 })
      const b = signal.wait({ since: '0', timeoutMs: 5000 })
      assert.equal(signal.waiting(), 2)
      assert.equal(signal.bump(), 1)
      assert.deepEqual([await a, await b], [{ seq: 1, woke: true }, { seq: 1, woke: true }])
      let cancel = null
      const c = signal.wait({ since: 1, timeoutMs: 5000, onCancel: (fn) => { cancel = fn } })
      cancel()
      assert.deepEqual([await c, signal.waiting()], [{ seq: 1, woke: false }, 0])
      assert.deepEqual([clampWaitMs('abc'), clampWaitMs(0, 7), clampWaitMs(123.4), clampWaitMs(10 ** 9)], [5000, 7, 123, MAX_WORK_WAIT_MS])
    }],
    ['createWorkWaiter：首轮只对时不算有活；序号变了 remote；本地 wake（含等之前就 wake）local 并取消长轮询；超时 timeout', async () => {
      const remoteCalls = []
      let respond = null
      const remoteWait = (opts) => { remoteCalls.push(opts); return new Promise((resolve) => { respond = resolve }) }
      const clock = manualSleep()
      const waiter = createWorkWaiter({ remoteWait, sleepMs: clock.sleepMs })
      const first = waiter.wait(5000)
      respond({ seq: 3 })
      await Promise.resolve()
      clock.timers[0].resolve()
      assert.equal(await first, 'timeout', '首轮拿到序号只是对时')
      assert.deepEqual([remoteCalls[0].since, remoteCalls[0].timeoutMs, remoteCalls[0].signal.aborted, waiter.lastSeq()], [null, 5000, true, 3])
      const second = waiter.wait(5000)
      assert.equal(remoteCalls[1].since, 3)
      respond({ seq: 4 })
      assert.equal(await second, 'remote')
      const third = waiter.wait(5000)
      waiter.wake()
      assert.equal(await third, 'local')
      assert.equal(remoteCalls[2].signal.aborted, true, '本地先醒：长轮询被取消，不在 gateway 积压')
      waiter.wake()
      assert.equal(await waiter.wait(5000), 'local', '等之前就 wake 过：立刻返回，不丢唤醒')
      assert.equal(remoteCalls.length, 3, '预存的唤醒不发长轮询')
    }],
    ['createWorkWaiter：远端 404（旧 gateway）停用长轮询；连不上之类不停用；都靠超时兜底；没有远端也能用', async () => {
      const clock = manualSleep()
      let calls = 0
      let failWith = 'GET /lark/work/wait failed: 404 {"ok":false}'
      const waiter = createWorkWaiter({ remoteWait: async () => { calls += 1; throw new Error(failWith) }, sleepMs: clock.sleepMs })
      failWith = 'fetch failed ECONNREFUSED'
      const p1 = waiter.wait(10)
      await new Promise((resolve) => setImmediate(resolve))
      clock.timers.at(-1).resolve()
      assert.deepEqual([await p1, waiter.remoteBroken()], ['timeout', false])
      failWith = 'GET /lark/work/wait failed: 404 {"ok":false}'
      const p2 = waiter.wait(10)
      await new Promise((resolve) => setImmediate(resolve))
      clock.timers.at(-1).resolve()
      assert.deepEqual([await p2, waiter.remoteBroken()], ['timeout', true])
      const p3 = waiter.wait(10)
      clock.timers.at(-1).resolve()
      assert.deepEqual([await p3, calls], ['timeout', 2], '停用后不再长轮询')
      const stringly = createWorkWaiter({ remoteWait: () => Promise.reject('GET /lark/work/wait failed: 404'), sleepMs: clock.sleepMs })
      const p5 = stringly.wait(10)
      await new Promise((resolve) => setImmediate(resolve))
      clock.timers.at(-1).resolve()
      assert.deepEqual([await p5, stringly.remoteBroken()], ['timeout', true], '抛的不是 Error 也认 404')
      const bare = createWorkWaiter({ sleepMs: clock.sleepMs })
      const p4 = bare.wait(10)
      bare.wake()
      assert.equal(await p4, 'local')
    }],
  ]))
})
