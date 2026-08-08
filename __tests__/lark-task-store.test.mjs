#!/usr/bin/env node
/**
 * createTaskStore 单测：领取优先级 + 租约过期回收孤儿。拆分成独立 lib 后这段队列逻辑才可单测。
 *   node --test common/lark-bot/__tests__/lark-task-store.test.mjs
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { createTaskStore } from '../lib/lark-task-store.mjs'

describe('createTaskStore', () => {
  let dir
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lark-store-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('claimNext 按 createdAt 升序领取最早的 pending，并置 running + 盖 claimedAt', () => {
    const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
    store.upsert({ id: 'b', status: 'queued', createdAt: '2026-01-02T00:00:00Z' })
    store.upsert({ id: 'a', status: 'queued', createdAt: '2026-01-01T00:00:00Z' })
    const claimed = store.claimNext()
    assert.equal(claimed.id, 'a')
    assert.equal(claimed.status, 'running')
    assert.ok(claimed.claimedAt)
    assert.equal(store.claimNext().id, 'b') // 下一个
    assert.equal(store.claimNext(), null) // 无 pending 剩余
  })

  it('租约过期的孤儿 running 任务在下次 claim 时重新入队（requeueCount 自增）', () => {
    const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
    // claimedAt 远早于 now - leaseMs → 视为孤儿
    store.upsert({ id: 'orphan', status: 'running', claimedAt: '2000-01-01T00:00:00Z', createdAt: '2000-01-01T00:00:00Z' })
    const reclaimed = store.claimNext()
    assert.equal(reclaimed.id, 'orphan')
    assert.equal(reclaimed.status, 'running') // 回收后立即被本次 claim 领走
    assert.equal(reclaimed.requeueCount, 1)
  })

  it('未过租约的 running 任务不回收，claimNext 返回 null', () => {
    const store = createTaskStore({ tasksDir: dir, leaseMs: 60_000 })
    store.upsert({ id: 'busy', status: 'running', claimedAt: new Date().toISOString(), createdAt: '2026-01-01T00:00:00Z' })
    assert.equal(store.claimNext(), null)
    assert.equal(store.stats().stuck.length, 0)
  })

  it('重建 store 时从磁盘恢复已持久化的任务', () => {
    createTaskStore({ tasksDir: dir, leaseMs: 1000 }).upsert({ id: 'persisted', status: 'queued', createdAt: '2026-01-01T00:00:00Z' })
    const reopened = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
    assert.equal(reopened.has('persisted'), true)
  })

  it('retry 把 failed/blocked 任务重置为 queued 并清租约、自增 retryCount', () => {
    const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
    store.upsert({ id: 'f', status: 'failed', claimedAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z' })
    const retried = store.retry('f')
    assert.equal(retried.status, 'queued')
    assert.equal(retried.claimedAt, null)
    assert.equal(retried.retryCount, 1)
    assert.ok(retried.requeuedAt)
    // 重置后能被 claimNext 领走，说明真的回到了 pending
    assert.equal(store.claimNext().id, 'f')
  })

  it('retry 对非 failed/blocked（如 done/running）任务返回 null，不改状态', () => {
    const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
    store.upsert({ id: 'd', status: 'done', createdAt: '2026-01-01T00:00:00Z' })
    assert.equal(store.retry('d'), null)
    assert.equal(store.retry('missing'), null)
    assert.equal(store.get('d').status, 'done')
  })

  it('resumeWithSupplement 续 waiting_confirmation：append 补料、复用同 id、回 queued、bump epoch', () => {
    const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
    store.upsert({ id: 'w', status: 'waiting_confirmation', text: '修复：hover tips', epoch: 2, attachments: [{ type: 'image', localPath: '/a.png' }], createdAt: '2026-01-01T00:00:00Z' })
    const resumed = store.resumeWithSupplement({ id: 'w', supplementText: 'tips 文案：请稍候', supplementAttachments: [{ type: 'image', localPath: '/b.png' }] })
    assert.equal(resumed.id, 'w') // 复用原任务 → resolveWorkContext 会算出同一分支/worktree
    assert.equal(resumed.status, 'queued')
    assert.equal(resumed.claimedAt, null)
    assert.equal(resumed.resumeCount, 1)
    assert.equal(resumed.epoch, 3) // bump，挡旧 worker 迟到回写
    assert.match(resumed.text, /修复：hover tips/)
    assert.match(resumed.text, /【补料】\ntips 文案：请稍候/)
    assert.equal(resumed.attachments.length, 2)
    assert.equal(store.claimNext().id, 'w') // 真的回到 pending
  })

  it('resumeWithSupplement 对非 waiting/blocked（done/failed/running）返回 null', () => {
    const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
    store.upsert({ id: 'done', status: 'done', text: 'x', createdAt: '2026-01-01T00:00:00Z' })
    assert.equal(store.resumeWithSupplement({ id: 'done', supplementText: 'y' }), null)
    assert.equal(store.resumeWithSupplement({ id: 'missing', supplementText: 'y' }), null)
    assert.equal(store.get('done').status, 'done')
  })

  it('pruneTerminal 默认只删陈旧 done，failed 与新鲜 done 均保留', () => {
    // upsert 会盖新鲜 updatedAt，故陈旧任务直接写盘再由构造函数恢复（恢复路径不盖时间戳）
    const seed = (task) => writeFileSync(join(dir, `${task.id}.json`), JSON.stringify(task))
    seed({ id: 'old-done', status: 'done', createdAt: '2000-01-01T00:00:00Z', updatedAt: '2000-01-01T00:00:00Z' })
    seed({ id: 'old-failed', status: 'failed', createdAt: '2000-01-01T00:00:00Z', updatedAt: '2000-01-01T00:00:00Z' })
    const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
    store.upsert({ id: 'fresh-done', status: 'done', createdAt: '2000-01-01T00:00:00Z' }) // upsert 盖新鲜 updatedAt
    const removed = store.pruneTerminal({ olderThanMs: 60_000, statuses: ['done'] })
    assert.deepEqual(removed, ['old-done'])
    assert.equal(store.has('old-done'), false)
    assert.equal(store.has('fresh-done'), true)
    assert.equal(store.has('old-failed'), true) // 默认不碰 failed
  })

  it('pruneTerminal 显式传 failed 时可清陈旧 failed（对应 clean --failed）', () => {
    writeFileSync(join(dir, 'old-failed.json'), JSON.stringify({ id: 'old-failed', status: 'failed', createdAt: '2000-01-01T00:00:00Z', updatedAt: '2000-01-01T00:00:00Z' }))
    const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
    const removed = store.pruneTerminal({ olderThanMs: 60_000, statuses: ['done', 'failed', 'blocked'] })
    assert.deepEqual(removed, ['old-failed'])
    assert.equal(store.has('old-failed'), false)
  })

  it('孤儿 requeueCount 达上限（LARK_MAX_REQUEUE 默认 2）转 failed 死信，不再自动重投，并触发 onDeadLetter', () => {
    const dead = []
    const store = createTaskStore({ tasksDir: dir, leaseMs: 1000, onDeadLetter: (t) => dead.push(t.id) })
    // 已重投 2 次仍孤儿 → 达上限
    store.upsert({ id: 'poison', status: 'running', requeueCount: 2, claimedAt: '2000-01-01T00:00:00Z', createdAt: '2000-01-01T00:00:00Z' })
    const claimed = store.claimNext()
    assert.equal(claimed, null) // 不再回队，无 pending 可领
    const task = store.get('poison')
    assert.equal(task.status, 'failed')
    assert.ok(task.deadLetterReason)
    assert.deepEqual(dead, ['poison'])
  })

  it('retry 达人工上限（LARK_MAX_RETRY 默认 5）返回 { task: null, reason }，不重置', () => {
    const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
    store.upsert({ id: 'maxed', status: 'failed', retryCount: 5, createdAt: '2026-01-01T00:00:00Z' })
    const outcome = store.retry('maxed')
    assert.equal(outcome.task, null)
    assert.match(outcome.reason, /人工重试上限/)
    assert.equal(store.get('maxed').status, 'failed') // 未被重置
  })

  it('启动恢复遇损坏 JSON 文件改名为 .corrupt 并保留其余任务（不静默丢单）', () => {
    writeFileSync(join(dir, 'good.json'), JSON.stringify({ id: 'good', status: 'queued', createdAt: '2026-01-01T00:00:00Z' }))
    writeFileSync(join(dir, 'broken.json'), '{ this is not valid json')
    const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
    assert.equal(store.has('good'), true) // 其余任务不受影响
    assert.equal(existsSync(join(dir, 'broken.json')), false) // 原文件已被隔离
    assert.equal(existsSync(join(dir, 'broken.json.corrupt')), true)
  })

  it('孤儿重投递增 epoch（fencing token），claim 返回带 epoch 基线', () => {
    const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
    store.upsert({ id: 'e', status: 'running', epoch: 3, claimedAt: '2000-01-01T00:00:00Z', createdAt: '2000-01-01T00:00:00Z' })
    const reclaimed = store.claimNext() // 回收→重投（epoch 4）→随即领走
    assert.equal(reclaimed.epoch, 4)
  })

  it('人工 retry 递增 epoch；首次 claim 未设过 epoch 时基线为 0', () => {
    const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
    store.upsert({ id: 'r', status: 'failed', createdAt: '2026-01-01T00:00:00Z' })
    assert.equal(store.retry('r').epoch, 1) // undefined → +1
    const claimed = store.claimNext()
    assert.equal(claimed.id, 'r')
    assert.equal(typeof claimed.epoch, 'number') // 已被 retry 设为 1
  })

  it('stats 暴露队列年龄 / 租约余量 / 死信数 / requeue·retry Top（health 观测用）', () => {
    const seed = (task) => writeFileSync(join(dir, `${task.id}.json`), JSON.stringify(task))
    seed({ id: 'old-queued', status: 'queued', createdAt: '2000-01-01T00:00:00Z' })
    seed({ id: 'dead', status: 'failed', deadLetterReason: '毒任务', createdAt: '2026-01-01T00:00:00Z' })
    seed({ id: 'hot', status: 'queued', requeueCount: 2, retryCount: 1, createdAt: '2026-01-01T00:00:00Z' })
    const store = createTaskStore({ tasksDir: dir, leaseMs: 60_000 })
    store.upsert({ id: 'busy', status: 'running', claimedAt: new Date().toISOString(), createdAt: '2026-01-01T00:00:00Z' })
    const stats = store.stats()
    assert.ok(stats.oldestQueuedAgeMs > 0) // old-queued 排队很久
    assert.equal(stats.deadLetters, 1)
    assert.equal(stats.topRequeued[0].id, 'hot')
    assert.ok(stats.minLeaseRemainingMs > 0 && stats.minLeaseRemainingMs <= 60_000) // busy 未超租约
  })
})
