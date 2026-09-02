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

import { createTaskStore, isReopenableClosedTask } from '../lib/lark-task-store.mjs'

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

  it('前置分类判定 bug/需求后重新排队、清 required 并 bump epoch', () => {
    const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
    store.upsert({
      id: 'mentioned-bug',
      status: 'received',
      epoch: 2,
      summary: '原消息',
      intake: { required: true, trigger: 'task_mention' },
      createdAt: '2026-01-01T00:00:00Z',
    })
    const claimed = store.claimNext()
    const outcome = store.resolveIntake({
      id: claimed.id,
      epoch: claimed.epoch,
      classification: { decision: 'bug', confidence: 'medium', summary: '修复登录页报错', reason: '明确报告报错' },
    })
    assert.equal(outcome.ok, true)
    assert.equal(outcome.actionable, true)
    assert.equal(outcome.task.status, 'queued')
    assert.equal(outcome.task.epoch, 3)
    assert.equal(outcome.task.intake.required, false)
    assert.equal(outcome.task.summary, '修复登录页报错')
    assert.equal(store.claimNext().id, 'mentioned-bug')
  })

  it('普通消息/低置信度结果静默 ignored；分类异常单列 intake_failed', () => {
    const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
    const seedAndClaim = (id) => {
      store.upsert({ id, status: 'received', intake: { required: true }, createdAt: new Date().toISOString() })
      return store.claimById(id)
    }
    const ignored = seedAndClaim('chat')
    const ignoredOutcome = store.resolveIntake({
      id: ignored.id,
      epoch: ignored.epoch,
      classification: { decision: 'ignore', confidence: 'high', summary: '询问排期', reason: '没有软件变更动作' },
    })
    assert.equal(ignoredOutcome.actionable, false)
    assert.equal(ignoredOutcome.task.status, 'ignored')

    const low = seedAndClaim('low')
    const lowOutcome = store.resolveIntake({
      id: low.id,
      epoch: low.epoch,
      classification: { decision: 'requirement', confidence: 'low', summary: '可能要调整', reason: '语义有歧义' },
    })
    assert.equal(lowOutcome.task.status, 'ignored')

    const failed = seedAndClaim('failed')
    const failedOutcome = store.resolveIntake({ id: failed.id, epoch: failed.epoch, error: 'classifier timeout' })
    assert.equal(failedOutcome.task.status, 'intake_failed')
    assert.equal(failedOutcome.task.intake.error, 'classifier timeout')
  })

  it('前置分类拒绝 stale epoch 与非等待分类任务', () => {
    const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
    store.upsert({ id: 'stale', status: 'running', epoch: 3, intake: { required: true }, createdAt: '2026-01-01T00:00:00Z' })
    assert.equal(store.resolveIntake({ id: 'stale', epoch: 2, classification: {} }).code, 409)
    store.upsert({ id: 'direct', status: 'running', epoch: 0, createdAt: '2026-01-01T00:00:00Z' })
    assert.equal(store.resolveIntake({ id: 'direct', epoch: 0, classification: {} }).code, 409)
  })

  it('前置分类回写对同结果幂等，不允许二次覆盖分类', () => {
    const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
    const classification = {
      decision: 'bug',
      confidence: 'high',
      summary: '修复登录报错',
      reason: '正文明确报错',
    }
    store.upsert({ id: 'intent-retry', status: 'received', intake: { required: true }, createdAt: new Date().toISOString() })
    const claimed = store.claimById('intent-retry')
    const claimedEpoch = claimed.epoch
    const first = store.resolveIntake({ id: claimed.id, epoch: claimedEpoch, classification })
    const retry = store.resolveIntake({ id: claimed.id, epoch: claimedEpoch, classification })
    assert.equal(first.actionable, true)
    assert.equal(retry.ok, true)
    assert.equal(retry.actionable, true)
    assert.equal(retry.alreadyResolved, true)
    assert.equal(store.get(claimed.id).epoch, 1)
    assert.equal(
      store.resolveIntake({ id: claimed.id, epoch: claimedEpoch, classification: { ...classification, decision: 'ignore' } }).code,
      409,
    )
    assert.equal(store.resolveIntake({ id: claimed.id, epoch: claimedEpoch - 1, classification }).code, 409)
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

  it('QA 验退把旧终态作为新一轮重新排队，并完整保留上一轮执行历史', () => {
    const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
    store.upsert({
      id: 'rec-returned',
      source: 'lark-bugtable',
      recordId: 'rec-returned',
      project: 'PR-12345',
      status: 'done',
      result: '上一轮只调整了间距',
      branch: 'hotfix/PR-12345-returned',
      owner: '前端',
      aiExecutor: 'codex',
      epoch: 2,
      retryCount: 3,
      requeueCount: 2,
      createdAt: '2026-01-01T00:00:00Z',
    })

    const reopened = store.reopenFromQaReturn({
      id: 'rec-returned',
      text: '修复：Lark bug 表验退项 [按钮仍错位]',
      summary: '验退：按钮仍错位',
      project: 'PR-12345',
      recordId: 'rec-returned',
      chatId: 'oc_bug',
      aiExecutor: 'codex',
    })

    assert.equal(reopened.status, 'queued')
    assert.equal(reopened.epoch, 3)
    assert.equal(reopened.qaReturnCount, 1)
    assert.equal(reopened.result, null)
    assert.equal(reopened.retryCount, 0)
    assert.equal(reopened.requeueCount, 0)
    assert.equal(reopened.branch, 'hotfix/PR-12345-returned')
    assert.match(reopened.text, /当前进入第 2 轮修复/)
    assert.match(reopened.text, /上一轮只调整了间距/)
    assert.deepEqual(reopened.executionHistory, [
      {
        round: 1,
        epoch: 2,
        status: 'done',
        result: '上一轮只调整了间距',
        branch: 'hotfix/PR-12345-returned',
        owner: '前端',
        aiExecutor: 'codex',
        finishedAt: reopened.executionHistory[0].finishedAt,
      },
    ])
    assert.equal(store.claimNext().id, 'rec-returned')
  })

  it('QA 验退不覆盖正在执行或等待人工确认的任务', () => {
    const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
    store.upsert({ id: 'running', source: 'lark-bugtable', status: 'running', createdAt: '2026-01-01T00:00:00Z' })
    store.upsert({ id: 'waiting', source: 'lark-bugtable', status: 'waiting_confirmation', createdAt: '2026-01-01T00:00:00Z' })
    assert.equal(store.reopenFromQaReturn({ id: 'running', text: 'x' }), null)
    assert.equal(store.reopenFromQaReturn({ id: 'waiting', text: 'x' }), null)
  })

  it('releaseRunning 把在跑任务交还队列：running→queued、清租约、bump epoch、不计 retry/requeue（优雅退出用）', () => {
    const store = createTaskStore({ tasksDir: dir, leaseMs: 60_000 })
    store.upsert({ id: 'r', status: 'running', epoch: 1, claimedAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z' })
    const released = store.releaseRunning('r')
    assert.equal(released.status, 'queued')
    assert.equal(released.claimedAt, null)
    assert.equal(released.epoch, 2) // bump 后，被中断执行的迟到回写（带旧 epoch=1）会被 fencing 掉
    assert.equal(released.retryCount, undefined) // 运维重启不该推向死信，不占 retry/requeue 额度
    assert.equal(released.requeueCount, undefined)
    // 未过租约也能立刻被领走，无需等 40min 租约过期
    assert.equal(store.claimNext().id, 'r')
  })

  it('releaseRunning 对非 running（queued/done/failed/缺失）返回 null，不改状态', () => {
    const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
    store.upsert({ id: 'q', status: 'queued', createdAt: '2026-01-01T00:00:00Z' })
    store.upsert({ id: 'd', status: 'done', createdAt: '2026-01-01T00:00:00Z' })
    assert.equal(store.releaseRunning('q'), null)
    assert.equal(store.releaseRunning('d'), null)
    assert.equal(store.releaseRunning('missing'), null)
    assert.equal(store.get('q').status, 'queued')
  })

  it('retryReceipt 只重开发卡，不重跑任务或改变目标终态', () => {
    const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
    store.upsert({
      id: 'receipt',
      status: 'result_pending_receipt',
      pendingReceipt: { status: 'done', attempts: 12, gaveUp: true },
      createdAt: '2026-01-01T00:00:00Z',
    })
    const retried = store.retryReceipt('receipt')
    assert.equal(retried.status, 'result_pending_receipt')
    assert.equal(retried.pendingReceipt.status, 'done')
    assert.equal(retried.pendingReceipt.attempts, 0)
    assert.equal(retried.pendingReceipt.gaveUp, false)
    assert.equal(store.retryReceipt('missing'), null)
  })

  it('resumeWithSupplement 续 waiting_confirmation：append 补料、复用同 id、回 queued、bump epoch', () => {
    const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
    store.upsert({ id: 'w', status: 'waiting_confirmation', text: '修复：hover tips', result: '缺 tips 文案', owner: '产品', waitRound: 2, epoch: 2, pendingReceipt: { status: 'waiting_confirmation', attempts: 1 }, attachments: [{ type: 'image', localPath: '/a.png' }], createdAt: '2026-01-01T00:00:00Z' })
    const resumed = store.resumeWithSupplement({ id: 'w', supplementText: 'tips 文案：请稍候', supplementAttachments: [{ type: 'image', localPath: '/b.png' }] })
    assert.equal(resumed.id, 'w') // 复用原任务 → resolveWorkContext 会算出同一分支/worktree
    assert.equal(resumed.status, 'queued')
    assert.equal(resumed.claimedAt, null)
    assert.equal(resumed.resumeCount, 1)
    assert.equal(resumed.epoch, 3) // bump，挡旧 worker 迟到回写
    assert.match(resumed.text, /修复：hover tips/)
    assert.match(resumed.text, /【补料】\ntips 文案：请稍候/)
    assert.equal(resumed.attachments.length, 2)
    assert.equal(resumed.result, null)
    assert.equal(resumed.owner, null)
    assert.equal(resumed.pendingReceipt, undefined) // 换代后不得继续补发上一轮 waiting 卡
    assert.deepEqual(resumed.waitingHistory[0], {
      round: 2,
      epoch: 2,
      status: 'waiting_confirmation',
      result: '缺 tips 文案',
      owner: '产品',
      resumedAt: resumed.waitingHistory[0].resumedAt,
    })
    assert.equal(store.claimNext().id, 'w') // 真的回到 pending
  })

  it('机器人回执 message_id 可持久关联原任务，重启后仍可反查', () => {
    const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
    store.upsert({ id: 'w-card', status: 'waiting_confirmation', createdAt: '2026-01-01T00:00:00Z' })
    store.recordReceipt('w-card', { messageId: 'om_waiting_card', kind: 'waiting_confirmation' })
    assert.equal(store.findByReceiptMessageId('om_waiting_card').id, 'w-card')
    const restored = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
    assert.equal(restored.findByReceiptMessageId('om_waiting_card').id, 'w-card')
  })

  it('recordReceipt 可显式保留发送时 epoch，旧卡不会关联换代后的任务', () => {
    const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
    store.upsert({ id: 'receipt-epoch', status: 'waiting_confirmation', epoch: 2, createdAt: '2026-01-01T00:00:00Z' })
    store.recordReceipt('receipt-epoch', { messageId: 'om_old', kind: 'waiting_confirmation', epoch: 1 })
    assert.equal(store.get('receipt-epoch').receipts[0].epoch, 1)
    assert.equal(store.findByReceiptMessageId('om_old'), null)
  })

  it('空回复不触发无意义续跑', () => {
    const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
    store.upsert({ id: 'w-empty', status: 'waiting_confirmation', createdAt: '2026-01-01T00:00:00Z' })
    assert.equal(store.resumeWithSupplement({ id: 'w-empty' }), null)
    assert.equal(store.get('w-empty').status, 'waiting_confirmation')
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

  describe('同话题归并 / 收尾（listParkedByThread + supersede）', () => {
    it('listParkedByThread 只返回同 threadRootId 且仍挂起的任务，排除自身', () => {
      const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
      store.upsert({ id: 'a', status: 'waiting_confirmation', threadRootId: 'T', createdAt: '2026-01-01T00:00:00Z' })
      store.upsert({ id: 'b', status: 'blocked', threadRootId: 'T', createdAt: '2026-01-01T00:00:00Z' })
      store.upsert({ id: 'done', status: 'done', threadRootId: 'T', createdAt: '2026-01-01T00:00:00Z' }) // 已了结不算
      store.upsert({ id: 'other', status: 'waiting_confirmation', threadRootId: 'X', createdAt: '2026-01-01T00:00:00Z' }) // 别的话题
      const ids = store.listParkedByThread('T', { excludeId: 'a' }).map((t) => t.id).sort()
      assert.deepEqual(ids, ['b'])
    })

    it('listParkedByThread 空 threadRootId 一律返回 []（非话题 @ 不误并）', () => {
      const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
      store.upsert({ id: 'legacy', status: 'waiting_confirmation', createdAt: '2026-01-01T00:00:00Z' }) // 老任务无 threadRootId
      assert.deepEqual(store.listParkedByThread(null), [])
      assert.deepEqual(store.listParkedByThread(undefined), [])
    })

    it('supersede 把挂起任务置 superseded、清 parkedAt 与催办轮次、记 supersededBy', () => {
      const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
      store.upsert({ id: 'a', status: 'waiting_confirmation', threadRootId: 'T', parkedAt: '2026-01-01T00:00:00Z', parkedRemindedRound: 2, createdAt: '2026-01-01T00:00:00Z' })
      const out = store.supersede({ id: 'a', bySiblingId: 'b' })
      assert.equal(out.status, 'superseded')
      assert.equal(out.supersededBy, 'b')
      assert.equal(out.parkedAt, null)
      assert.equal(out.parkedRemindedRound, 0)
      assert.match(out.result, /任务 b 完成/)
    })

    it('supersede 对非挂起态返回 null（不覆盖 done/running）', () => {
      const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
      store.upsert({ id: 'd', status: 'done', threadRootId: 'T', createdAt: '2026-01-01T00:00:00Z' })
      assert.equal(store.supersede({ id: 'd', bySiblingId: 'b' }), null)
      assert.equal(store.supersede({ id: 'missing', bySiblingId: 'b' }), null)
    })

    it('人工确认外部已解决时直接结单，并换代拦截 running worker 迟到回写', () => {
      const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
      store.upsert({
        id: 'active',
        status: 'running',
        epoch: 3,
        claimedAt: '2026-09-01T10:00:00Z',
        parkedAt: '2026-09-01T09:00:00Z',
        parkedRemindedRound: 2,
        pendingReceipt: { status: 'waiting_confirmation' },
        createdAt: '2026-09-01T08:00:00Z',
      })
      const outcome = store.closeAsExternallyResolved({ id: 'active', operator: 'ou_user', messageId: 'om_close' })
      assert.equal(outcome.previousStatus, 'running')
      assert.equal(outcome.task.status, 'superseded')
      assert.equal(outcome.task.epoch, 4)
      assert.equal(outcome.task.claimedAt, null)
      assert.equal(outcome.task.parkedAt, null)
      assert.equal(outcome.task.parkedRemindedRound, 0)
      assert.equal(outcome.task.pendingReceipt, undefined)
      assert.deepEqual(outcome.task.externalResolution.operator, 'ou_user')
      assert.equal(outcome.task.externalResolution.messageId, 'om_close')
    })

    it('人工结单不覆盖已了结任务', () => {
      const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
      store.upsert({ id: 'done', status: 'done', createdAt: '2026-09-01T08:00:00Z' })
      assert.equal(store.closeAsExternallyResolved({ id: 'done' }), null)
      assert.equal(store.closeAsExternallyResolved({ id: 'missing' }), null)
    })

    it('closureReason 分流：取消/无需处理不记成外部完成，落态存档反映真实原因', () => {
      const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
      store.upsert({ id: 'c1', status: 'queued', createdAt: '2026-09-01T08:00:00Z' })
      const cancelled = store.closeAsExternallyResolved({ id: 'c1', closureReason: 'cancelled' })
      assert.equal(cancelled.closureReason, 'cancelled')
      assert.equal(cancelled.task.closureReason, 'cancelled')
      assert.equal(cancelled.task.externalResolution.closureReason, 'cancelled')
      assert.match(cancelled.task.result, /取消/)
      assert.doesNotMatch(cancelled.task.result, /已由其他/)

      store.upsert({ id: 'c2', status: 'blocked', createdAt: '2026-09-01T08:00:00Z' })
      const noNeed = store.closeAsExternallyResolved({ id: 'c2', closureReason: 'no_longer_needed' })
      assert.equal(noNeed.closureReason, 'no_longer_needed')

      // 缺省 / 非法 reason 回落 completed_elsewhere（向后兼容旧调用点）
      store.upsert({ id: 'c3', status: 'running', createdAt: '2026-09-01T08:00:00Z' })
      assert.equal(store.closeAsExternallyResolved({ id: 'c3' }).closureReason, 'completed_elsewhere')
    })

    it('findTaskByAnyReceipt 忽略代次命中；listActiveByThread 只返回未了结、可含 running', () => {
      const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
      store.upsert({ id: 'a', status: 'running', epoch: 2, threadRootId: 'th', createdAt: '2026-09-01T08:00:00Z' })
      store.recordReceipt('a', { messageId: 'om_gen0', kind: 'queued', epoch: 0 }) // 旧代次卡
      // epoch 严格版因代次不匹配漏掉，忽略代次版命中
      assert.equal(store.findByReceiptMessageId('om_gen0'), null)
      assert.equal(store.findTaskByAnyReceipt('om_gen0').id, 'a')

      store.upsert({ id: 'b', status: 'done', threadRootId: 'th', createdAt: '2026-09-01T08:00:00Z' })
      const active = store.listActiveByThread('th', { excludeId: 'x' })
      assert.deepEqual(active.map((t) => t.id).sort(), ['a']) // 只含未了结的 running，排除 done
    })

    it('reopenClosed 误结单可逆：人工结单的 superseded 复活回 queued+epoch++，存档留痕并清结单字段', () => {
      const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
      store.upsert({ id: 'r1', status: 'queued', epoch: 1, branch: 'hotfix/x', createdAt: '2026-09-01T08:00:00Z' })
      const closed = store.closeAsExternallyResolved({ id: 'r1', operator: 'ou_a', messageId: 'om_c', closureReason: 'cancelled' })
      assert.equal(closed.task.status, 'superseded')
      assert.equal(isReopenableClosedTask(closed.task), true)

      const reopened = store.reopenClosed({ id: 'r1', operator: 'ou_b', messageId: 'om_re' })
      assert.equal(reopened.status, 'queued')
      assert.equal(reopened.epoch, 3) // close(1→2) 后 reopen 再 ++ → 3
      assert.equal(reopened.closureReason, undefined)
      assert.equal(reopened.externalResolution, undefined)
      assert.equal(reopened.result, null)
      assert.equal(reopened.branch, 'hotfix/x') // 复用原分支
      assert.equal(reopened.closureHistory.length, 1)
      assert.equal(reopened.closureHistory[0].closureReason, 'cancelled')
      assert.equal(reopened.closureHistory[0].reopenedBy, 'ou_b')
      assert.equal(isReopenableClosedTask(reopened), false)
    })

    it('reopenClosed 只认「人工结单」：兄弟归并 supersede / 活动态 / 缺失 → null', () => {
      const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
      // 兄弟归并 supersede：无 externalResolution，不可重开（避免与已完成兄弟重复劳动）
      store.upsert({ id: 's1', status: 'waiting_confirmation', threadRootId: 'th', createdAt: '2026-09-01T08:00:00Z' })
      store.supersede({ id: 's1', bySiblingId: 's2' })
      assert.equal(store.reopenClosed({ id: 's1' }), null)
      // 活动态不是「已结单」
      store.upsert({ id: 's3', status: 'queued', createdAt: '2026-09-01T08:00:00Z' })
      assert.equal(store.reopenClosed({ id: 's3' }), null)
      assert.equal(store.reopenClosed({ id: 'missing' }), null)
    })
  })
})
