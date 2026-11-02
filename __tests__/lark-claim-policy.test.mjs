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
import { appendLatency, formatLatency, latencyRecordOf, readLatency, summarizeLatency } from '../lib/lark-latency.mjs'
import { formatLogTime, installLogTimestamps } from '../lib/lark-log-time.mjs'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

describe('worker 领任务口径、等待与可观测', () => {
  it('四档口径 × 任务类型；工作信号与等待器（本地唤醒 / 远端唤醒 / 旧 gateway 退回轮询）；时延记账与日志时间', () => runSteps([
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
    ['latencyRecordOf：起点优先飞书发出时间、没有退回建任务时间；时间缺 / 倒挂记 null；docMs 只收数字', () => {
      const task = { id: 'x', epoch: 2, contract: { deliverable: 'change' }, messageCreatedAt: '2026-11-02T10:00:00.000Z', createdAt: '2026-11-02T10:00:01.000Z', intake: { resolvedAt: '2026-11-02T10:00:06.000Z' }, ackedAt: '2026-11-02T10:00:07.000Z', claimedAt: '2026-11-02T10:00:06.500Z' }
      assert.deepEqual(latencyRecordOf({ task, status: 'done', reportedAt: '2026-11-02T10:01:00.000Z', deliveredAt: '2026-11-02T10:01:05.000Z', docMs: 3000 }), {
        at: '2026-11-02T10:01:05.000Z', id: 'x', deliverable: 'change', status: 'done', epoch: 2,
        ingestMs: 1000, classifyMs: 5000, ackMs: 7000, waitMs: 500, runMs: 53500, deliverMs: 5000, docMs: 3000, totalMs: 65000,
      })
      assert.equal(latencyRecordOf({ task: {}, reportedAt: '2026-11-02T10:00:00.000Z', deliveredAt: '2026-11-02T10:00:00.000Z' }).deliverMs, 0, '同一时刻是 0，不是缺')
      const bare = latencyRecordOf({ task: { createdAt: '2026-11-02T10:00:01.000Z', claimedAt: '2026-11-02T10:00:00.000Z' }, status: 'failed', reportedAt: null, deliveredAt: '2026-11-02T10:00:03.000Z', docMs: '9' })
      assert.deepEqual([bare.ingestMs, bare.ackMs, bare.waitMs, bare.runMs, bare.docMs, bare.totalMs, bare.deliverable, bare.epoch], [null, null, null, null, null, 2000, null, 0], '没有发出时间按建任务算总时长；领取早于建任务（倒挂）记 null')
    }],
    ['appendLatency / readLatency / summarizeLatency / formatLatency：追加、按时间窗读、坏行跳过、中位与慢的 1/10、按交付类型分', () => {
      const path = join(mkdtempSync(join(tmpdir(), 'lat-')), 'l.jsonl')
      assert.deepEqual([appendLatency(null, { path }), appendLatency({ at: 'x' }, {}), readLatency({ path })], [false, false, []])
      const warned = []
      assert.equal(appendLatency({ at: 'x' }, { path: join(path, 'no', 'such'), log: (line) => warned.push(line) }), false)
      assert.match(warned[0], /时延记账写失败/)
      for (const [at, deliverable, totalMs, ackMs] of [['2026-11-01T00:00:00Z', 'answer', 1000, 500], ['2026-11-02T00:00:00Z', 'answer', 3000, 700], ['2026-11-02T01:00:00Z', 'change', 9000, null], ['2026-11-02T02:00:00Z', null, 5000, 900]]) assert.equal(appendLatency({ at, deliverable, totalMs, ackMs }, { path }), true)
      writeFileSync(path, `${'{bad\n'}`, { flag: 'a' })
      const recent = readLatency({ path, sinceMs: Date.parse('2026-11-02T00:00:00Z') })
      assert.deepEqual(recent.map((r) => r.totalMs), [3000, 9000, 5000], '时间窗外与坏行都不算')
      const summary = summarizeLatency(recent)
      assert.deepEqual([summary.tasks, summary.fields.totalMs, summary.fields.ackMs, summary.fields.docMs.n], [3, { n: 3, p50: 5000, p90: 9000 }, { n: 2, p50: 900, p90: 900 }, 0])
      assert.deepEqual(summary.totalByDeliverable, { answer: { n: 1, p50: 3000, p90: 3000 }, change: { n: 1, p50: 9000, p90: 9000 }, '(未分类)': { n: 1, p50: 5000, p90: 5000 } })
      const text = formatLatency(summary)
      assert.match(text, /时延（3 条已交付任务/)
      assert.match(text, /发出 → 回「收到」：0\.9s \/ 0\.9s（2 条）/)
      assert.doesNotMatch(text, /建细节文档/, '没有数据的段不列')
      assert.match(text, /answer 3\.0s \/ 3\.0s（1）；change 9\.0s/)
    }],
    ['installLogTimestamps：每行前加本地时间、四个方法都装、不叠加、LARK_LOG_TIMESTAMPS=0 关', () => {
      assert.equal(formatLogTime(new Date(2026, 10, 2, 9, 5, 7, 42)), '11-02 09:05:07.042')
      const lines = []
      const fake = Object.fromEntries(['log', 'info', 'warn', 'error'].map((name) => [name, (...args) => lines.push([name, ...args])]))
      const now = () => new Date(2026, 0, 3, 4, 5, 6, 7)
      assert.equal(installLogTimestamps({ target: fake, env: { LARK_LOG_TIMESTAMPS: '0' }, now }), false)
      fake.log('a')
      assert.equal(installLogTimestamps({ target: fake, env: {}, now }), true)
      assert.equal(installLogTimestamps({ target: fake, env: {}, now }), false, '重复装不叠加')
      fake.log('b', 1)
      fake.info('c')
      fake.warn('d')
      fake.error('e')
      assert.deepEqual(lines, [['log', 'a'], ['log', '01-03 04:05:06.007', 'b', 1], ['info', '01-03 04:05:06.007', 'c'], ['warn', '01-03 04:05:06.007', 'd'], ['error', '01-03 04:05:06.007', 'e']])
    }],
  ]))
})
