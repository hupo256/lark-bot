import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { createTaskStore } from '../lib/lark-task-store.mjs'

const withStore = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'lark-thread-intake-'))
  try {
    return fn(createTaskStore({ tasksDir: dir, leaseMs: 60_000 }))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const received = (store, extra = {}) => store.upsert({
  id: 'omt_thread1',
  source: 'lark',
  repo: 'falive',
  project: 'FALIVE',
  chatId: 'oc_x',
  threadRootId: 'omt_thread1',
  text: 'x',
  status: 'received',
  intake: { required: true, trigger: 'task_mention', notBefore: null },
  createdAt: new Date().toISOString(),
  ...extra,
})

describe('外部群任务入口：准确优先', () => {
  it('仓库 profile 的任务只有 high 且 forMe≠false 才开跑；medium 挂疑似待确认且不催办；ignore 静默', () => withStore((store) => {
    received(store)
    assert.ok(store.claimById('omt_thread1'))
    let out = store.resolveIntake({ id: 'omt_thread1', epoch: 0, classification: { decision: 'api_reply', confidence: 'medium', forMe: true, summary: 's', reason: 'r' } })
    assert.equal(out.actionable, false)
    assert.equal(out.suspected, true)
    assert.equal(out.task.status, 'waiting_confirmation')
    assert.equal(out.task.parkedRemindedRound, 99)
    assert.match(out.task.result, /疑似需要处理/)

    received(store, { id: 'omt_thread2', threadRootId: 'omt_thread2' })
    store.claimById('omt_thread2')
    out = store.resolveIntake({ id: 'omt_thread2', epoch: 0, classification: { decision: 'bug', confidence: 'high', forMe: false, summary: 's', reason: 'r' } })
    assert.equal(out.actionable, false)
    assert.equal(out.suspected, false, '别人的功能（forMe=false）静默忽略，不算疑似')
    assert.equal(out.task.status, 'ignored')

    received(store, { id: 'omt_thread3', threadRootId: 'omt_thread3' })
    store.claimById('omt_thread3')
    out = store.resolveIntake({ id: 'omt_thread3', epoch: 0, classification: { decision: 'api_reply', confidence: 'high', forMe: true, summary: 's', reason: 'r' } })
    assert.equal(out.actionable, true)
    assert.equal(out.task.status, 'queued')
    assert.equal(out.task.commandType, 'api')

    received(store, { id: 'omt_thread4', threadRootId: 'omt_thread4' })
    store.claimById('omt_thread4')
    out = store.resolveIntake({ id: 'omt_thread4', epoch: 0, classification: { decision: 'ignore', confidence: 'high', forMe: false, summary: 's', reason: 'r' } })
    assert.equal(out.suspected, false)
    assert.equal(out.task.status, 'ignored')
  }))

  it('fameex（无 repo）沿用 medium 即可开跑', () => withStore((store) => {
    store.upsert({ id: 'om_f', source: 'lark', chatId: 'oc_f', text: 'x', status: 'received', intake: { required: true }, createdAt: new Date().toISOString() })
    store.claimById('om_f')
    const out = store.resolveIntake({ id: 'om_f', epoch: 0, classification: { decision: 'bug', confidence: 'medium', summary: 's', reason: 'r' } })
    assert.equal(out.actionable, true)
  }))

  it('分类去抖：notBefore 未到不可领取', () => withStore((store) => {
    received(store, { intake: { required: true, notBefore: new Date(Date.now() + 60_000).toISOString() } })
    assert.equal(store.claimById('omt_thread1'), null)
    received(store, { intake: { required: true, notBefore: new Date(Date.now() - 1000).toISOString() } })
    assert.ok(store.claimById('omt_thread1'))
  }))

  it('已了结的话题任务被新消息重开：同一 id、epoch++、重新分类、历史留痕', () => withStore((store) => {
    received(store, { status: 'ignored', intake: { required: false }, result: 'old', epoch: 2 })
    assert.equal(store.reopenForThread({ id: 'omt_thread1', supplementText: '运维更新好了' }).status, 'received')
    const task = store.get('omt_thread1')
    assert.equal(task.epoch, 3)
    assert.equal(task.intake.required, true)
    assert.equal(task.intake.trigger, 'thread_followup')
    assert.match(task.text, /【话题新消息 .*】运维更新好了/)
    assert.equal(task.threadHistory.length, 1)
    assert.equal(task.threadHistory[0].status, 'ignored')
    // 活动态不可重开
    assert.equal(store.reopenForThread({ id: 'omt_thread1', supplementText: 'again' }), null)
  }))

  it('主题归并：并入未开跑 / 在跑 / 挂起 / 已了结的目标，本条落 superseded；最近任务候选排除自身与已归并', () => withStore((store) => {
    const mk = (id, status, extra = {}) => store.upsert({ id, source: 'lark', repo: 'falive', chatId: 'oc_x', text: `t-${id}`, status, topic: 'live-2', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...extra })
    mk('into_q', 'queued'); mk('from1', 'received', { commandType: 'api' })
    let out = store.mergeIntoTask({ fromId: 'from1', intoId: 'into_q' })
    assert.equal(out.mode, 'appended'); assert.match(store.get('into_q').text, /【同主题补充 .*】t-from1/); assert.equal(store.get('from1').status, 'superseded'); assert.equal(store.get('into_q').commandType, 'api')
    mk('into_r', 'running'); mk('from2', 'received')
    assert.equal(store.mergeIntoTask({ fromId: 'from2', intoId: 'into_r' }).mode, 'rerun_after_done'); assert.equal(store.get('into_r').rerunAfterDone, true)
    mk('into_w', 'waiting_confirmation', { epoch: 1 }); mk('from3', 'received')
    assert.equal(store.mergeIntoTask({ fromId: 'from3', intoId: 'into_w' }).mode, 'resumed'); assert.equal(store.get('into_w').status, 'queued'); assert.equal(store.get('into_w').epoch, 2)
    mk('into_s', 'waiting_confirmation', { epoch: 1, suspected: true }); mk('from3b', 'received')
    assert.equal(store.mergeIntoTask({ fromId: 'from3b', intoId: 'into_s' }).mode, 'appended_suspected', '疑似任务不因新消息自动开跑'); assert.equal(store.get('into_s').status, 'waiting_confirmation')
    mk('into_d', 'done', { epoch: 4, result: 'old' }); mk('from4', 'received')
    assert.equal(store.mergeIntoTask({ fromId: 'from4', intoId: 'into_d' }).mode, 'reopened'); assert.equal(store.get('into_d').status, 'queued'); assert.equal(store.get('into_d').epoch, 5); assert.equal(store.get('into_d').threadHistory.length, 1)
    const recent = store.listRecentForChat('oc_x', { excludeId: 'into_q' })
    assert.ok(recent.every((task) => task.status !== 'superseded' && task.id !== 'into_q'))
    assert.equal(store.mergeIntoTask({ fromId: 'nope', intoId: 'into_q' }), null)
  }))
})
