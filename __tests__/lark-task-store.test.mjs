#!/usr/bin/env node
/**
 * createTaskStore 单测：领取优先级 + 租约过期回收孤儿。拆分成独立 lib 后这段队列逻辑才可单测。
 *   node --test common/lark-bot/__tests__/lark-task-store.test.mjs
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { isTransientIntakeError } from '../lib/lark-intake-retry.mjs'
import { createTaskStore, isReopenableClosedTask } from '../lib/lark-task-store.mjs'
import { runSteps } from './support/steps.mjs'

describe('createTaskStore', () => {
  // 每段原用例各用一个空目录当 tasksDir（等价原来的 beforeEach / afterEach），段与段之间不共享落盘。
  let dir
  const hooks = {
    before: () => { dir = mkdtempSync(join(tmpdir(), 'lark-store-')) },
    after: () => rmSync(dir, { recursive: true, force: true }),
  }

  it('领取与孤儿回收：claimNext 按 createdAt 升序、租约过期孤儿回队（requeue / epoch 自增）、未过租约不动、requeue 达上限转死信', () => runSteps([
    ['claimNext 按 createdAt 升序领取最早的 pending，并置 running + 盖 claimedAt', () => {
      const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
      store.upsert({ id: 'b', status: 'queued', createdAt: '2026-01-02T00:00:00Z' })
      store.upsert({ id: 'a', status: 'queued', createdAt: '2026-01-01T00:00:00Z' })
      const claimed = store.claimNext()
      assert.equal(claimed.id, 'a')
      assert.equal(claimed.status, 'running')
      assert.ok(claimed.claimedAt)
      assert.equal(store.claimNext().id, 'b') // 下一个
      assert.equal(store.claimNext(), null) // 无 pending 剩余
    }],

    ['租约过期的孤儿 running 任务在下次 claim 时重新入队（requeueCount 自增）', () => {
      const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
      // claimedAt 远早于 now - leaseMs → 视为孤儿
      store.upsert({ id: 'orphan', status: 'running', claimedAt: '2000-01-01T00:00:00Z', createdAt: '2000-01-01T00:00:00Z' })
      const reclaimed = store.claimNext()
      assert.equal(reclaimed.id, 'orphan')
      assert.equal(reclaimed.status, 'running') // 回收后立即被本次 claim 领走
      assert.equal(reclaimed.requeueCount, 1)
    }],

    ['reclaimOrphans 可脱离 claim 单独调用：空队列下孤儿也回到 queued，未过租约的不动', () => {
      const store = createTaskStore({ tasksDir: dir, leaseMs: 60_000 })
      store.upsert({ id: 'orphan', status: 'running', epoch: 2, claimedAt: '2000-01-01T00:00:00Z', createdAt: '2000-01-01T00:00:00Z' })
      store.upsert({ id: 'busy', status: 'running', claimedAt: new Date().toISOString(), createdAt: '2026-01-01T00:00:00Z' })
      store.reclaimOrphans()
      assert.equal(store.get('orphan').status, 'queued')
      assert.equal(store.get('orphan').claimedAt, null)
      assert.equal(store.get('orphan').epoch, 3)
      assert.equal(store.get('orphan').requeueCount, 1)
      assert.equal(store.get('busy').status, 'running')
      assert.equal(store.stats().stuck.length, 0)
    }],

    ['未过租约的 running 任务不回收，claimNext 返回 null', () => {
      const store = createTaskStore({ tasksDir: dir, leaseMs: 60_000 })
      store.upsert({ id: 'busy', status: 'running', claimedAt: new Date().toISOString(), createdAt: '2026-01-01T00:00:00Z' })
      assert.equal(store.claimNext(), null)
      assert.equal(store.stats().stuck.length, 0)
    }],

    ['孤儿重投递增 epoch（fencing token），claim 返回带 epoch 基线', () => {
      const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
      store.upsert({ id: 'e', status: 'running', epoch: 3, claimedAt: '2000-01-01T00:00:00Z', createdAt: '2000-01-01T00:00:00Z' })
      const reclaimed = store.claimNext() // 回收→重投（epoch 4）→随即领走
      assert.equal(reclaimed.epoch, 4)
    }],

    ['孤儿 requeueCount 达上限（LARK_MAX_REQUEUE 默认 2）转 failed 死信，不再自动重投，并触发 onDeadLetter', () => {
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
    }],

    ['任务自带 leaseMs 非正（null / 0）回落默认租约：刚领取的不算孤儿、不被回收（变异补测 10-24）', () => {
      const store = createTaskStore({ tasksDir: dir, leaseMs: 60_000 })
      const claimedAt = new Date(Date.now() - 1000).toISOString()
      store.upsert({ id: 'null-lease', status: 'running', leaseMs: null, claimedAt, createdAt: '2026-01-01T00:00:00Z' })
      store.upsert({ id: 'zero-lease', status: 'running', leaseMs: 0, claimedAt, createdAt: '2026-01-01T00:00:00Z' })
      store.reclaimOrphans()
      assert.equal(store.get('null-lease').status, 'running')
      assert.equal(store.get('zero-lease').status, 'running')
      assert.deepEqual(store.stats().stuck, [])
    }],

    ['claimById 只领 queued / received：缺失与已了结返回 null 且不改状态；保留已有 epoch，未设过的基线为 0（变异补测 10-24）', () => {
      const store = createTaskStore({ tasksDir: dir, leaseMs: 60_000 })
      store.upsert({ id: 'done', status: 'done', createdAt: '2026-01-01T00:00:00Z' })
      assert.equal(store.claimById('missing'), null)
      assert.equal(store.claimById('done'), null)
      assert.equal(store.get('done').status, 'done')
      store.upsert({ id: 'gen2', status: 'queued', epoch: 2, createdAt: '2026-01-01T00:00:00Z' })
      assert.equal(store.claimById('gen2').epoch, 2, 'fencing token 不能在领取时被清零')
      store.upsert({ id: 'fresh', status: 'queued', createdAt: '2026-01-01T00:00:00Z' })
      assert.equal(store.claimById('fresh').epoch, 0)
    }],

    ['claimNext 领取去抖窗口（notBefore）已过的 received，未到的不领（变异补测 10-24）', () => {
      const store = createTaskStore({ tasksDir: dir, leaseMs: 60_000 })
      store.upsert({ id: 'later', status: 'received', intake: { required: true, notBefore: new Date(Date.now() + 60_000).toISOString() }, createdAt: '2026-01-01T00:00:00Z' })
      store.upsert({ id: 'due', status: 'received', intake: { required: true, notBefore: new Date(Date.now() - 1000).toISOString() }, createdAt: '2026-01-02T00:00:00Z' })
      assert.equal(store.claimNext()?.id, 'due')
      assert.equal(store.claimNext(), null)
    }],
  ], hooks))

  it('前置分类 resolveIntake：判 bug/需求回队、ignore / 低置信静默、异常 intake_failed、瞬时失败延后重分类 2 次、stale epoch 拒绝、同结果幂等', () => runSteps([
    ['前置分类判定 bug/需求后重新排队、清 required 并 bump epoch', () => {
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
    }],

    ['普通消息/低置信度结果静默 ignored；分类异常单列 intake_failed', () => {
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
      const failedOutcome = store.resolveIntake({ id: failed.id, epoch: failed.epoch, error: 'Claude 未返回合法结构化结果' })
      assert.equal(failedOutcome.task.status, 'intake_failed')
      assert.equal(failedOutcome.task.intake.error, 'Claude 未返回合法结构化结果')
    }],

    ['分类瞬时失败（超时）自动延后重分类 2 次，用完才落 intake_failed（10-19 三条 120s 超时）', () => {
      const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
      store.upsert({ id: 'slow', status: 'received', intake: { required: true }, createdAt: new Date().toISOString() })
      const timeout = 'claude exec timed out after 120000ms'
      for (const attempt of [1, 2]) {
        const claimed = store.claimById('slow')
        assert.ok(claimed, `第 ${attempt} 次可领取`)
        const outcome = store.resolveIntake({ id: 'slow', epoch: claimed.epoch, error: timeout })
        assert.equal(outcome.retried, true)
        assert.equal(outcome.task.status, 'received')
        assert.equal(outcome.task.intake.required, true)
        assert.equal(outcome.task.intake.retries, attempt)
        assert.equal(store.claimById('slow'), null, 'notBefore 未到不能领')
        assert.equal(store.claimNext(), null, 'claimNext 也守 notBefore')
        store.upsert({ ...store.get('slow'), intake: { ...store.get('slow').intake, notBefore: new Date(Date.now() - 1).toISOString() } })
      }
      const last = store.claimById('slow')
      const final = store.resolveIntake({ id: 'slow', epoch: last.epoch, error: timeout })
      assert.equal(final.retried, undefined)
      assert.equal(final.task.status, 'intake_failed')
      assert.equal(isTransientIntakeError('Claude 未返回合法结构化结果'), false)
      assert.equal(isTransientIntakeError('HTTP 529 overloaded'), true)
    }],

    ['前置分类拒绝 stale epoch 与非等待分类任务', () => {
      const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
      store.upsert({ id: 'stale', status: 'running', epoch: 3, intake: { required: true }, createdAt: '2026-01-01T00:00:00Z' })
      assert.equal(store.resolveIntake({ id: 'stale', epoch: 2, classification: {} }).code, 409)
      store.upsert({ id: 'direct', status: 'running', epoch: 0, createdAt: '2026-01-01T00:00:00Z' })
      assert.equal(store.resolveIntake({ id: 'direct', epoch: 0, classification: {} }).code, 409)
    }],

    ['前置分类回写对同结果幂等，不允许二次覆盖分类', () => {
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
    }],

    ['已成功落态的分类不被迟到的异常回报当幂等（409）；同一异常重放在非零代次下幂等成功、换个异常 409（变异补测 10-24）', () => {
      const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
      const classification = { decision: 'bug', confidence: 'high', summary: '修复登录报错', reason: '正文明确报错' }
      const error = 'Claude 未返回合法结构化结果'
      store.upsert({ id: 'ok', status: 'received', intake: { required: true }, createdAt: new Date().toISOString() })
      const claimed = store.claimById('ok')
      assert.equal(store.resolveIntake({ id: 'ok', epoch: claimed.epoch, classification }).actionable, true)
      assert.equal(store.resolveIntake({ id: 'ok', epoch: claimed.epoch, error }).code, 409, '分类已成功，迟到的异常回报不能当幂等重放')
      assert.equal(store.get('ok').status, 'queued')

      store.upsert({ id: 'bad', status: 'received', epoch: 2, intake: { required: true }, createdAt: new Date().toISOString() })
      const badClaim = store.claimById('bad')
      assert.equal(store.resolveIntake({ id: 'bad', epoch: badClaim.epoch, error }).task.status, 'intake_failed')
      const replay = store.resolveIntake({ id: 'bad', epoch: 2, error })
      assert.equal(replay.ok, true, '同一异常重放（非 actionable 不换代，按当前代次核对）幂等成功')
      assert.equal(replay.alreadyResolved, true)
      assert.equal(replay.actionable, false)
      assert.equal(store.resolveIntake({ id: 'bad', epoch: 2, error: '另一个异常' }).code, 409)
    }],

    ['resolveIntake 对缺失任务、尚未领取的 received 任务一律 409 不抛不改；stale epoch 报错带当前代次（变异补测 10-24）', () => {
      const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
      assert.equal(store.resolveIntake({ id: 'missing', classification: {} }).code, 409)
      store.upsert({ id: 'unclaimed', status: 'received', intake: { required: true }, createdAt: '2026-01-01T00:00:00Z' })
      assert.equal(store.resolveIntake({ id: 'unclaimed', epoch: 0, classification: { decision: 'bug', confidence: 'high', summary: 's' } }).code, 409)
      assert.equal(store.get('unclaimed').status, 'received')
      store.upsert({ id: 'stale', status: 'running', epoch: 3, intake: { required: true }, createdAt: '2026-01-01T00:00:00Z' })
      assert.equal(store.resolveIntake({ id: 'stale', epoch: 2, classification: {} }).error, 'stale epoch: got 2, current 3')
    }],
  ], hooks))

  it('人工重试与交还队列：retry 重置 failed/blocked 并 epoch++、非法态 / 达上限不重置；releaseRunning 交还不计额度；retryReceipt 只重开发卡', () => runSteps([
    ['retry 把 failed/blocked 任务重置为 queued 并清租约、自增 retryCount', () => {
      const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
      store.upsert({ id: 'f', status: 'failed', claimedAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z' })
      const retried = store.retry('f')
      assert.equal(retried.status, 'queued')
      assert.equal(retried.claimedAt, null)
      assert.equal(retried.retryCount, 1)
      assert.ok(retried.requeuedAt)
      // 重置后能被 claimNext 领走，说明真的回到了 pending
      assert.equal(store.claimNext().id, 'f')
    }],

    ['retry 对非 failed/blocked（如 done/running）任务返回 null，不改状态', () => {
      const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
      store.upsert({ id: 'd', status: 'done', createdAt: '2026-01-01T00:00:00Z' })
      assert.equal(store.retry('d'), null)
      assert.equal(store.retry('missing'), null)
      assert.equal(store.get('d').status, 'done')
    }],

    ['retry 达人工上限（LARK_MAX_RETRY 默认 5）返回 { task: null, reason }，不重置', () => {
      const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
      store.upsert({ id: 'maxed', status: 'failed', retryCount: 5, createdAt: '2026-01-01T00:00:00Z' })
      const outcome = store.retry('maxed')
      assert.equal(outcome.task, null)
      assert.match(outcome.reason, /人工重试上限/)
      assert.equal(store.get('maxed').status, 'failed') // 未被重置
    }],

    ['人工 retry 递增 epoch；首次 claim 未设过 epoch 时基线为 0', () => {
      const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
      store.upsert({ id: 'r', status: 'failed', createdAt: '2026-01-01T00:00:00Z' })
      assert.equal(store.retry('r').epoch, 1) // undefined → +1
      const claimed = store.claimNext()
      assert.equal(claimed.id, 'r')
      assert.equal(typeof claimed.epoch, 'number') // 已被 retry 设为 1
    }],

    ['releaseRunning 把在跑任务交还队列：running→queued、清租约、bump epoch、不计 retry/requeue（优雅退出用）', () => {
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
    }],

    ['releaseRunning 对非 running（queued/done/failed/缺失）返回 null，不改状态', () => {
      const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
      store.upsert({ id: 'q', status: 'queued', createdAt: '2026-01-01T00:00:00Z' })
      store.upsert({ id: 'd', status: 'done', createdAt: '2026-01-01T00:00:00Z' })
      assert.equal(store.releaseRunning('q'), null)
      assert.equal(store.releaseRunning('d'), null)
      assert.equal(store.releaseRunning('missing'), null)
      assert.equal(store.get('q').status, 'queued')
    }],

    ['retryReceipt 只重开发卡，不重跑任务或改变目标终态', () => {
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
    }],
  ], hooks))

  it('QA 验退把旧终态作为新一轮重新排队并完整保留上一轮执行历史；不覆盖正在执行或等待人工确认的任务', () => runSteps([
    ['QA 验退把旧终态作为新一轮重新排队，并完整保留上一轮执行历史', () => {
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
    }],

    ['QA 验退不覆盖正在执行或等待人工确认的任务', () => {
      const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
      store.upsert({ id: 'running', source: 'lark-bugtable', status: 'running', createdAt: '2026-01-01T00:00:00Z' })
      store.upsert({ id: 'waiting', source: 'lark-bugtable', status: 'waiting_confirmation', createdAt: '2026-01-01T00:00:00Z' })
      assert.equal(store.reopenFromQaReturn({ id: 'running', text: 'x' }), null)
      assert.equal(store.reopenFromQaReturn({ id: 'waiting', text: 'x' }), null)
    }],

    ['QA 验退只认 bug 表任务（群任务 / 缺失 → null）；新一轮正文以最新表格正文开头；摘要 / project 有新值才覆盖；历史记上一轮了结时间（变异补测 10-24）', () => {
      const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
      store.upsert({ id: 'chat-task', source: 'lark', status: 'done', createdAt: '2026-01-01T00:00:00Z' })
      assert.equal(store.reopenFromQaReturn({ id: 'chat-task', text: 'x' }), null)
      assert.equal(store.get('chat-task').status, 'done')
      assert.equal(store.reopenFromQaReturn({ id: 'missing', text: 'x' }), null)

      const finishedAt = store.upsert({ id: 'rec', source: 'lark-bugtable', status: 'done', summary: '旧摘要', project: 'PR-1', result: '旧结论', createdAt: '2026-01-01T00:00:00Z' }).updatedAt
      const first = store.reopenFromQaReturn({ id: 'rec', text: '  修复：按钮仍错位  ' })
      assert.ok(first.text.startsWith('修复：按钮仍错位\n\n【验退轮次】'), first.text)
      assert.equal(first.summary, '旧摘要')
      assert.equal(first.project, 'PR-1')
      assert.equal(first.executionHistory[0].finishedAt, finishedAt)

      store.upsert({ ...store.get('rec'), status: 'done' })
      const second = store.reopenFromQaReturn({ id: 'rec', text: 'y', summary: '新摘要', project: 'PR-2' })
      assert.equal(second.summary, '新摘要')
      assert.equal(second.project, 'PR-2')
    }],
  ], hooks))

  it('resumeWithSupplement 续 waiting_confirmation：append 补料、复用同 id、回 queued、bump epoch；空回复不续跑；非 waiting/blocked 返回 null', () => runSteps([
    ['resumeWithSupplement 续 waiting_confirmation：append 补料、复用同 id、回 queued、bump epoch', () => {
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
    }],

    ['空回复不触发无意义续跑', () => {
      const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
      store.upsert({ id: 'w-empty', status: 'waiting_confirmation', createdAt: '2026-01-01T00:00:00Z' })
      assert.equal(store.resumeWithSupplement({ id: 'w-empty' }), null)
      assert.equal(store.get('w-empty').status, 'waiting_confirmation')
    }],

    ['resumeWithSupplement 对非 waiting/blocked（done/failed/running）返回 null', () => {
      const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
      store.upsert({ id: 'done', status: 'done', text: 'x', createdAt: '2026-01-01T00:00:00Z' })
      assert.equal(store.resumeWithSupplement({ id: 'done', supplementText: 'y' }), null)
      assert.equal(store.resumeWithSupplement({ id: 'missing', supplementText: 'y' }), null)
      assert.equal(store.get('done').status, 'done')
    }],

    ['补料续跑保留已有摘要；无摘要时取补料开头 80 字（变异补测 10-24）', () => {
      const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
      store.upsert({ id: 'has', status: 'blocked', summary: '原摘要', createdAt: '2026-01-01T00:00:00Z' })
      assert.equal(store.resumeWithSupplement({ id: 'has', supplementText: '补料内容' }).summary, '原摘要')
      store.upsert({ id: 'none', status: 'waiting_confirmation', createdAt: '2026-01-01T00:00:00Z' })
      assert.equal(store.resumeWithSupplement({ id: 'none', supplementText: 'x'.repeat(100) }).summary, 'x'.repeat(80))
    }],
  ], hooks))

  it('落盘恢复与回执关联：重建 store 从磁盘恢复、损坏 JSON 改名 .corrupt 不丢单、回执 message_id 重启后可反查、旧 epoch 回执不关联换代任务', () => runSteps([
    ['重建 store 时从磁盘恢复已持久化的任务', () => {
      createTaskStore({ tasksDir: dir, leaseMs: 1000 }).upsert({ id: 'persisted', status: 'queued', createdAt: '2026-01-01T00:00:00Z' })
      const reopened = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
      assert.equal(reopened.has('persisted'), true)
    }],

    ['启动恢复遇损坏 JSON 文件改名为 .corrupt 并保留其余任务（不静默丢单）', () => {
      writeFileSync(join(dir, 'good.json'), JSON.stringify({ id: 'good', status: 'queued', createdAt: '2026-01-01T00:00:00Z' }))
      writeFileSync(join(dir, 'broken.json'), '{ this is not valid json')
      const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
      assert.equal(store.has('good'), true) // 其余任务不受影响
      assert.equal(existsSync(join(dir, 'broken.json')), false) // 原文件已被隔离
      assert.equal(existsSync(join(dir, 'broken.json.corrupt')), true)
    }],

    ['机器人回执 message_id 可持久关联原任务，重启后仍可反查', () => {
      const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
      store.upsert({ id: 'w-card', status: 'waiting_confirmation', createdAt: '2026-01-01T00:00:00Z' })
      store.recordReceipt('w-card', { messageId: 'om_waiting_card', kind: 'waiting_confirmation' })
      assert.equal(store.findByReceiptMessageId('om_waiting_card').id, 'w-card')
      const restored = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
      assert.equal(restored.findByReceiptMessageId('om_waiting_card').id, 'w-card')
    }],

    ['recordReceipt 可显式保留发送时 epoch，旧卡不会关联换代后的任务', () => {
      const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
      store.upsert({ id: 'receipt-epoch', status: 'waiting_confirmation', epoch: 2, createdAt: '2026-01-01T00:00:00Z' })
      store.recordReceipt('receipt-epoch', { messageId: 'om_old', kind: 'waiting_confirmation', epoch: 1 })
      assert.equal(store.get('receipt-epoch').receipts[0].epoch, 1)
      assert.equal(store.findByReceiptMessageId('om_old'), null)
    }],

    ['recordReceipt 同一 message_id 只留最新一条、不同卡并存；无 message_id 记 webhook 合成 id 且不互相去重，kind 缺省 receipt（变异补测 10-24）', () => {
      const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
      store.upsert({ id: 't', status: 'waiting_confirmation', epoch: 1, createdAt: '2026-01-01T00:00:00Z' })
      store.recordReceipt('t', { messageId: 'om_a', kind: 'queued' })
      store.recordReceipt('t', { messageId: 'om_b', kind: 'waiting_confirmation' })
      store.recordReceipt('t', { messageId: 'om_a', kind: 'done' })
      assert.deepEqual(store.get('t').receipts.map((r) => [r.messageId, r.kind, r.epoch]), [['om_b', 'waiting_confirmation', 1], ['om_a', 'done', 1]])
      store.recordReceipt('t', {})
      store.recordReceipt('t', { kind: 'blocked' })
      const receipts = store.get('t').receipts
      assert.equal(receipts.length, 4)
      assert.equal(receipts[2].kind, 'receipt')
      assert.match(receipts[2].messageId, /^webhook:receipt:\d+$/)
      assert.equal(receipts[3].kind, 'blocked')
      assert.match(receipts[3].messageId, /^webhook:blocked:\d+$/)
    }],

    ['变更流条目带任务的 epoch 与 updatedAt；无 epoch 记 0、无 updatedAt 记当前时刻（变异补测 10-24）', () => {
      writeFileSync(join(dir, 'legacy.json'), JSON.stringify({ id: 'legacy', status: 'waiting_confirmation', epoch: 2, updatedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00Z' }))
      writeFileSync(join(dir, 'bare.json'), JSON.stringify({ id: 'bare', status: 'queued', createdAt: '2026-01-01T00:00:00Z' }))
      const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
      store.recordReceipt('legacy', { messageId: 'om_1', kind: 'waiting_confirmation' })
      store.recordReceipt('bare', { messageId: 'om_2', kind: 'queued' })
      const [legacy, bare] = store.changesSince(0).changes
      assert.equal(legacy.id, 'legacy')
      assert.equal(legacy.epoch, 2)
      assert.equal(legacy.at, '2026-01-01T00:00:00.000Z')
      assert.equal(bare.epoch, 0)
      assert.ok(Number.isFinite(Date.parse(bare.at)), String(bare.at))
    }],
  ], hooks))

  it('清理与观测：pruneTerminal 默认只删陈旧 done、显式传 failed 才清陈旧 failed；stats 暴露队列年龄 / 租约余量 / 死信数 / requeue·retry Top', () => runSteps([
    ['pruneTerminal 默认只删陈旧 done，failed 与新鲜 done 均保留', () => {
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
    }],

    ['pruneTerminal 显式传 failed 时可清陈旧 failed（对应 clean --failed）', () => {
      writeFileSync(join(dir, 'old-failed.json'), JSON.stringify({ id: 'old-failed', status: 'failed', createdAt: '2000-01-01T00:00:00Z', updatedAt: '2000-01-01T00:00:00Z' }))
      const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
      const removed = store.pruneTerminal({ olderThanMs: 60_000, statuses: ['done', 'failed', 'blocked'] })
      assert.deepEqual(removed, ['old-failed'])
      assert.equal(store.has('old-failed'), false)
    }],

    ['stats 暴露队列年龄 / 租约余量 / 死信数 / requeue·retry Top（health 观测用）', () => {
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
    }],

    ['stats 按状态计数；只列有 requeue / retry 的任务且缺项记 0；排队年龄只看 queued / received 并取最老；租约余量只看在跑任务（变异补测 10-24）', () => {
      const store = createTaskStore({ tasksDir: dir, leaseMs: 60_000 })
      const hoursAgo = (hours) => new Date(Date.now() - hours * 3600_000).toISOString()
      // 插入顺序有意让最老的排在前面：取最大值而不是「最后一个」
      store.upsert({ id: 'q-old', status: 'queued', createdAt: hoursAgo(10) })
      store.upsert({ id: 'recv', status: 'received', createdAt: hoursAgo(5) })
      store.upsert({ id: 'q-new', status: 'queued', createdAt: hoursAgo(1) })
      store.upsert({ id: 'done-ancient', status: 'done', claimedAt: hoursAgo(100), createdAt: hoursAgo(100) })
      store.upsert({ id: 'only-retry', status: 'failed', retryCount: 2, createdAt: hoursAgo(1) })
      const stats = store.stats()
      assert.deepEqual(stats.counts, { queued: 2, received: 1, done: 1, failed: 1 })
      assert.deepEqual(stats.topRequeued, [{ id: 'only-retry', requeueCount: 0, retryCount: 2 }])
      assert.ok(stats.oldestQueuedAgeMs >= 10 * 3600_000 && stats.oldestQueuedAgeMs < 10 * 3600_000 + 60_000, String(stats.oldestQueuedAgeMs))
      assert.equal(stats.minLeaseRemainingMs, null, '已了结任务残留的 claimedAt 不算租约')
    }],
  ], hooks))

  describe('同话题归并 / 收尾（listParkedByThread + supersede）', () => {
    it('listParkedByThread 只返回同话题仍挂起的任务、空 threadRootId 返回 []；supersede 置 superseded 清催办、非挂起态返回 null', () => runSteps([
      ['listParkedByThread 只返回同 threadRootId 且仍挂起的任务，排除自身', () => {
        const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
        store.upsert({ id: 'a', status: 'waiting_confirmation', threadRootId: 'T', createdAt: '2026-01-01T00:00:00Z' })
        store.upsert({ id: 'b', status: 'blocked', threadRootId: 'T', createdAt: '2026-01-01T00:00:00Z' })
        store.upsert({ id: 'done', status: 'done', threadRootId: 'T', createdAt: '2026-01-01T00:00:00Z' }) // 已了结不算
        store.upsert({ id: 'other', status: 'waiting_confirmation', threadRootId: 'X', createdAt: '2026-01-01T00:00:00Z' }) // 别的话题
        const ids = store.listParkedByThread('T', { excludeId: 'a' }).map((t) => t.id).sort()
        assert.deepEqual(ids, ['b'])
      }],

      ['listParkedByThread 空 threadRootId 一律返回 []（非话题 @ 不误并）', () => {
        const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
        store.upsert({ id: 'legacy', status: 'waiting_confirmation', createdAt: '2026-01-01T00:00:00Z' }) // 老任务无 threadRootId
        assert.deepEqual(store.listParkedByThread(null), [])
        assert.deepEqual(store.listParkedByThread(undefined), [])
      }],

      ['supersede 把挂起任务置 superseded、清 parkedAt 与催办轮次、记 supersededBy', () => {
        const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
        store.upsert({ id: 'a', status: 'waiting_confirmation', threadRootId: 'T', parkedAt: '2026-01-01T00:00:00Z', parkedRemindedRound: 2, createdAt: '2026-01-01T00:00:00Z' })
        const out = store.supersede({ id: 'a', bySiblingId: 'b' })
        assert.equal(out.status, 'superseded')
        assert.equal(out.supersededBy, 'b')
        assert.equal(out.parkedAt, null)
        assert.equal(out.parkedRemindedRound, 0)
        assert.match(out.result, /任务 b 完成/)
      }],

      ['supersede 对非挂起态返回 null（不覆盖 done/running）', () => {
        const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
        store.upsert({ id: 'd', status: 'done', threadRootId: 'T', createdAt: '2026-01-01T00:00:00Z' })
        assert.equal(store.supersede({ id: 'd', bySiblingId: 'b' }), null)
        assert.equal(store.supersede({ id: 'missing', bySiblingId: 'b' }), null)
      }],

      ['requeueForSupplement 只对标了 rerunAfterDone 的任务换代回队（epoch++、rerunCount 计数），最多续跑 3 次（变异补测 10-24）', () => {
        const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
        store.upsert({ id: 'plain', status: 'done', epoch: 1, createdAt: '2026-01-01T00:00:00Z' })
        assert.equal(store.requeueForSupplement('plain'), null)
        assert.equal(store.get('plain').status, 'done')
        assert.equal(store.requeueForSupplement('missing'), null)
        store.upsert({ id: 'r', status: 'done', epoch: 2, rerunAfterDone: true, claimedAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z' })
        const first = store.requeueForSupplement('r')
        assert.equal(first.status, 'queued')
        assert.equal(first.epoch, 3)
        assert.equal(first.rerunCount, 1)
        assert.equal(first.claimedAt, null)
        assert.equal(first.rerunAfterDone, undefined)
        for (const round of [2, 3]) {
          store.upsert({ ...store.get('r'), status: 'done', rerunAfterDone: true })
          assert.equal(store.requeueForSupplement('r')?.rerunCount, round, `第 ${round} 次补充仍续跑`)
        }
        store.upsert({ ...store.get('r'), status: 'done', rerunAfterDone: true })
        assert.equal(store.requeueForSupplement('r'), null, '第 4 次不再续跑')
        assert.equal(store.get('r').status, 'done')
        assert.equal(store.get('r').rerunAfterDone, undefined)
      }],

      ['mergeIntoTask：目标缺失 / 并入自身返回 null 不动；目标原正文与附件保留、来源附件追加；来源换代落 superseded（变异补测 10-24）', () => {
        const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
        store.upsert({ id: 'into', status: 'queued', text: '目标正文', attachments: [{ path: '/a.png' }], createdAt: '2026-01-01T00:00:00Z' })
        store.upsert({ id: 'from', status: 'received', epoch: 2, text: '来源正文', attachments: [{ path: '/b.png' }], createdAt: '2026-01-01T00:00:00Z' })
        assert.equal(store.mergeIntoTask({ fromId: 'from', intoId: 'missing' }), null)
        assert.equal(store.mergeIntoTask({ fromId: 'into', intoId: 'into' }), null)
        assert.equal(store.get('into').mergedFrom, undefined, '并入自身不改任务')
        const out = store.mergeIntoTask({ fromId: 'from', intoId: 'into' })
        assert.equal(out.mode, 'appended')
        assert.match(out.into.text, /^目标正文\n\n【同主题补充 .*】来源正文$/)
        assert.deepEqual(out.into.attachments.map((a) => a.path), ['/a.png', '/b.png'])
        assert.equal(out.from.status, 'superseded')
        assert.equal(out.from.supersededBy, 'into')
        assert.equal(out.from.epoch, 3)
        store.upsert({ id: 'into2', status: 'queued', createdAt: '2026-01-01T00:00:00Z' })
        store.upsert({ id: 'from2', status: 'received', attachments: [{ path: '/c.png' }], createdAt: '2026-01-01T00:00:00Z' })
        assert.deepEqual(store.mergeIntoTask({ fromId: 'from2', intoId: 'into2' }).into.attachments.map((a) => a.path), ['/c.png'])
      }],

      ['mergeIntoTask 命令类型：目标没有才继承来源的（来源无标记记 explicit）；目标已有不覆盖；来源没有不动目标（变异补测 10-24）', () => {
        const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
        const pair = (name, into, from) => {
          store.upsert({ id: `into-${name}`, status: 'queued', createdAt: '2026-01-01T00:00:00Z', ...into })
          store.upsert({ id: `from-${name}`, status: 'received', createdAt: '2026-01-01T00:00:00Z', ...from })
          const merged = store.mergeIntoTask({ fromId: `from-${name}`, intoId: `into-${name}` }).into
          return [merged.commandType, merged.commandTypeSource]
        }
        assert.deepEqual(pair('a', {}, { commandType: 'api' }), ['api', 'explicit'])
        assert.deepEqual(pair('b', { commandType: 'bug', commandTypeSource: 'explicit' }, { commandType: 'api', commandTypeSource: 'inferred' }), ['bug', 'explicit'])
        assert.deepEqual(pair('c', {}, {}), [undefined, undefined])
        assert.deepEqual(pair('d', {}, { commandType: 'api', commandTypeSource: 'inferred' }), ['api', 'inferred'])
      }],

      ['mergeIntoTask 并入挂起任务：waitingHistory 记本轮轮次与换代前 epoch、resumeCount 累加（变异补测 10-24）', () => {
        const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
        store.upsert({ id: 'w', status: 'blocked', epoch: 2, waitRound: 3, resumeCount: 1, result: '缺文案', createdAt: '2026-01-01T00:00:00Z' })
        store.upsert({ id: 'f', status: 'received', text: '文案是 x', createdAt: '2026-01-01T00:00:00Z' })
        const out = store.mergeIntoTask({ fromId: 'f', intoId: 'w' })
        assert.equal(out.mode, 'resumed')
        assert.equal(out.into.epoch, 3)
        assert.equal(out.into.resumeCount, 2)
        const [entry] = out.into.waitingHistory
        assert.deepEqual([entry.round, entry.epoch, entry.status, entry.result], [3, 2, 'blocked', '缺文案'])
        store.upsert({ id: 'w0', status: 'waiting_confirmation', createdAt: '2026-01-01T00:00:00Z' })
        store.upsert({ id: 'f0', status: 'received', text: 'y', createdAt: '2026-01-01T00:00:00Z' })
        const fresh = store.mergeIntoTask({ fromId: 'f0', intoId: 'w0' }).into
        assert.deepEqual([fresh.waitingHistory[0].round, fresh.waitingHistory[0].epoch, fresh.resumeCount], [1, 0, 1])
      }],

      ['mergeIntoTask 并入已了结任务：threadHistory 记旧状态、旧结论与了结时间，无结论记 null（变异补测 10-24）', () => {
        const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
        const closedAt = store.upsert({ id: 'd', status: 'done', result: 'old', epoch: 4, createdAt: '2026-01-01T00:00:00Z' }).updatedAt
        store.upsert({ id: 'f', status: 'received', text: 'again', createdAt: '2026-01-01T00:00:00Z' })
        const out = store.mergeIntoTask({ fromId: 'f', intoId: 'd' })
        assert.equal(out.mode, 'reopened')
        assert.deepEqual(out.into.threadHistory, [{ status: 'done', result: 'old', closedAt }])
        store.upsert({ id: 'i', status: 'ignored', createdAt: '2026-01-01T00:00:00Z' })
        store.upsert({ id: 'f2', status: 'received', text: 'again', createdAt: '2026-01-01T00:00:00Z' })
        assert.equal(store.mergeIntoTask({ fromId: 'f2', intoId: 'i' }).into.threadHistory[0].result, null)
      }],

      ['listRecentForChat 只取本群、排除已忽略与 days 之外的；按最近更新时间算（旧任务近期有更新仍算），无 updatedAt 的旧数据按 createdAt（变异补测 10-24）', () => {
        const hoursAgo = (hours) => new Date(Date.now() - hours * 3600_000).toISOString()
        const seed = (task) => writeFileSync(join(dir, `${task.id}.json`), JSON.stringify(task))
        seed({ id: 'mine', chatId: 'oc_a', status: 'done', createdAt: hoursAgo(30 * 24), updatedAt: hoursAgo(1) })
        seed({ id: 'legacy', chatId: 'oc_a', status: 'done', createdAt: hoursAgo(1) })
        seed({ id: 'other-chat', chatId: 'oc_b', status: 'done', createdAt: hoursAgo(1), updatedAt: hoursAgo(1) })
        seed({ id: 'ignored', chatId: 'oc_a', status: 'ignored', createdAt: hoursAgo(1), updatedAt: hoursAgo(1) })
        seed({ id: 'stale', chatId: 'oc_a', status: 'done', createdAt: hoursAgo(30 * 24), updatedAt: hoursAgo(30 * 24) })
        const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
        assert.deepEqual(store.listRecentForChat('oc_a').map((t) => t.id).sort(), ['legacy', 'mine'])
      }],

      ['expireSuspected 只收疑似且待确认的；缺 parkedAt 用 updatedAt，无时刻 / 时刻非法不收；恰好满 maxAgeMs 即收；保留原结论再追加说明；listSuspected 只列疑似待确认（变异补测 10-24）', () => {
        const now = Date.parse('2026-10-24T12:00:00.000Z')
        const maxAgeMs = 48 * 3600_000
        const due = new Date(now - maxAgeMs).toISOString()
        const seed = (task) => writeFileSync(join(dir, `${task.id}.json`), JSON.stringify({ status: 'waiting_confirmation', suspected: true, createdAt: '2026-01-01T00:00:00Z', ...task }))
        seed({ id: 'exact', parkedAt: due, result: '疑似：录播接口' })
        seed({ id: 'by-updated', updatedAt: due })
        seed({ id: 'not-suspected', suspected: false, parkedAt: due })
        seed({ id: 'blocked', status: 'blocked', parkedAt: due })
        seed({ id: 'no-time' })
        seed({ id: 'bad-time', parkedAt: 'garbage' })
        seed({ id: 'young', parkedAt: new Date(now - maxAgeMs + 1).toISOString() })
        const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
        assert.deepEqual(store.listSuspected().map((t) => t.id).sort(), ['bad-time', 'by-updated', 'exact', 'no-time', 'young'])
        assert.deepEqual(store.expireSuspected({ now, maxAgeMs }).map((t) => t.id).sort(), ['by-updated', 'exact'])
        assert.equal(store.get('exact').result, '疑似：录播接口\n（疑似任务 48 小时无人放行，自动关闭）')
        assert.equal(store.get('not-suspected').status, 'waiting_confirmation')
        assert.equal(store.get('blocked').status, 'blocked')
      }],

      ['reopenForThread 保留原正文与附件、追加新消息与附件；threadHistory 记旧结论与了结时间；notBefore 透传、缺省 null（变异补测 10-24）', () => {
        const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
        const closedAt = store.upsert({ id: 't', status: 'done', text: '原始问题', result: '已修复', attachments: [{ path: '/a.png' }], epoch: 1, createdAt: '2026-01-01T00:00:00Z' }).updatedAt
        const notBefore = new Date(Date.now() + 60_000).toISOString()
        const task = store.reopenForThread({ id: 't', supplementText: '又坏了', supplementAttachments: [{ path: '/b.png' }], notBefore })
        assert.match(task.text, /^原始问题\n\n【话题新消息 .*】又坏了$/)
        assert.deepEqual(task.attachments.map((a) => a.path), ['/a.png', '/b.png'])
        assert.deepEqual(task.threadHistory, [{ status: 'done', result: '已修复', closedAt }])
        assert.equal(task.intake.notBefore, notBefore)
        store.upsert({ id: 'u', status: 'ignored', createdAt: '2026-01-01T00:00:00Z' })
        const bare = store.reopenForThread({ id: 'u', supplementText: 'x' })
        assert.equal(bare.intake.notBefore, null)
        assert.equal(bare.threadHistory[0].result, null)
      }],
    ], hooks))

    it('人工结单 closeAsExternallyResolved：结单并换代拦截 running 迟到回写、不覆盖已了结、closureReason 分流', () => runSteps([
      ['人工确认外部已解决时直接结单，并换代拦截 running worker 迟到回写', () => {
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
      }],

      ['人工结单不覆盖已了结任务', () => {
        const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
        store.upsert({ id: 'done', status: 'done', createdAt: '2026-09-01T08:00:00Z' })
        assert.equal(store.closeAsExternallyResolved({ id: 'done' }), null)
        assert.equal(store.closeAsExternallyResolved({ id: 'missing' }), null)
      }],

      ['closureReason 分流：取消/无需处理不记成外部完成，落态存档反映真实原因', () => {
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
      }],
    ], hooks))

    it('findTaskByAnyReceipt 忽略代次命中、listActiveByThread 只返回未了结；reopenClosed 误结单可逆且只认「人工结单」', () => runSteps([
      ['findTaskByAnyReceipt 忽略代次命中；listActiveByThread 只返回未了结、可含 running', () => {
        const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
        store.upsert({ id: 'a', status: 'running', epoch: 2, threadRootId: 'th', createdAt: '2026-09-01T08:00:00Z' })
        store.recordReceipt('a', { messageId: 'om_gen0', kind: 'queued', epoch: 0 }) // 旧代次卡
        // epoch 严格版因代次不匹配漏掉，忽略代次版命中
        assert.equal(store.findByReceiptMessageId('om_gen0'), null)
        assert.equal(store.findTaskByAnyReceipt('om_gen0').id, 'a')

        store.upsert({ id: 'b', status: 'done', threadRootId: 'th', createdAt: '2026-09-01T08:00:00Z' })
        const active = store.listActiveByThread('th', { excludeId: 'x' })
        assert.deepEqual(active.map((t) => t.id).sort(), ['a']) // 只含未了结的 running，排除 done
      }],

      ['reopenClosed 误结单可逆：人工结单的 superseded 复活回 queued+epoch++，存档留痕并清结单字段', () => {
        const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
        store.upsert({ id: 'r1', status: 'queued', epoch: 1, branch: 'hotfix/x', createdAt: '2026-09-01T08:00:00Z' })
        const closed = store.closeAsExternallyResolved({ id: 'r1', operator: 'ou_a', messageId: 'om_c', closureReason: 'cancelled' })
        assert.equal(closed.task.status, 'superseded')
        assert.equal(isReopenableClosedTask(closed.task), true)

        const reopened = store.reopenClosed({
          id: 'r1',
          operator: 'ou_b',
          messageId: 'om_re',
          supplementText: '按钮仍然是空的',
          supplementAttachments: [{ type: 'image', path: '/tmp/reopen.png' }],
        })
        assert.equal(reopened.status, 'queued')
        assert.equal(reopened.epoch, 3) // close(1→2) 后 reopen 再 ++ → 3
        assert.equal(reopened.closureReason, undefined)
        assert.equal(reopened.externalResolution, undefined)
        assert.equal(reopened.result, null)
        assert.equal(reopened.branch, 'hotfix/x') // 复用原分支
        assert.equal(reopened.closureHistory.length, 1)
        assert.equal(reopened.closureHistory[0].closureReason, 'cancelled')
        assert.equal(reopened.closureHistory[0].reopenedBy, 'ou_b')
        assert.match(reopened.text, /【重开补充】\n按钮仍然是空的/)
        assert.equal(reopened.attachments[0].path, '/tmp/reopen.png')
        assert.equal(reopened.reopenHistory[0].messageId, 'om_re')
        assert.equal(isReopenableClosedTask(reopened), false)
      }],

      ['reopenClosed 只认「人工结单」：兄弟归并 supersede / 活动态 / 缺失 → null', () => {
        const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
        // 兄弟归并 supersede：无 externalResolution，不可重开（避免与已完成兄弟重复劳动）
        store.upsert({ id: 's1', status: 'waiting_confirmation', threadRootId: 'th', createdAt: '2026-09-01T08:00:00Z' })
        store.supersede({ id: 's1', bySiblingId: 's2' })
        assert.equal(store.reopenClosed({ id: 's1' }), null)
        // 活动态不是「已结单」
        store.upsert({ id: 's3', status: 'queued', createdAt: '2026-09-01T08:00:00Z' })
        assert.equal(store.reopenClosed({ id: 's3' }), null)
        assert.equal(store.reopenClosed({ id: 'missing' }), null)
      }],

      ['reopenClosed 保留原正文与摘要、补充接在后面，无摘要时取补充开头；重开留痕记操作人 / 来源消息 / 补充原文，缺省记 null（变异补测 10-24）', () => {
        const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
        store.upsert({ id: 'k', status: 'queued', text: '原始需求正文', summary: '原摘要', createdAt: '2026-09-01T08:00:00Z' })
        store.closeAsExternallyResolved({ id: 'k', closureReason: 'cancelled' })
        const reopened = store.reopenClosed({ id: 'k', operator: 'ou_b', messageId: 'om_re', supplementText: '按钮仍然是空的' })
        assert.equal(reopened.text, '原始需求正文\n\n【重开补充】\n按钮仍然是空的')
        assert.equal(reopened.summary, '原摘要')
        assert.equal(reopened.closureHistory[0].reopenedFromMessageId, 'om_re')
        const [entry] = reopened.reopenHistory
        assert.deepEqual([entry.operator, entry.messageId, entry.supplementText], ['ou_b', 'om_re', '按钮仍然是空的'])

        store.upsert({ id: 'n', status: 'queued', createdAt: '2026-09-01T08:00:00Z' })
        store.closeAsExternallyResolved({ id: 'n' })
        const bare = store.reopenClosed({ id: 'n', supplementText: '补充说明' })
        assert.equal(bare.summary, '补充说明')
        assert.equal(bare.closureHistory[0].reopenedFromMessageId, null)
        assert.equal(bare.reopenHistory[0].operator, null)
        store.closeAsExternallyResolved({ id: 'n' })
        assert.equal(store.reopenClosed({ id: 'n' }).reopenHistory[1].supplementText, null)
      }],
    ], hooks))
  })

  // 范围契约越界挂起后，「确认扩大范围」走续跑出口：被拦文件记入 scopeApprovals，请求被消费。
  describe('resumeWithSupplement × 范围批准', () => {
    const parkScopeBlocked = (store) => store.upsert({
      id: 'scope-1',
      status: 'waiting_confirmation',
      text: '名称列显示错误',
      createdAt: '2026-10-11T00:00:00Z',
      scopeRequest: { paths: ['apps/web/src/neighbor.ts', 'package.json'], overBudget: false, siblingsRequired: false, missingScope: false },
    })

    it('确认话术 → 追加批准记录（含点名文件与操作人）、清请求回队；非确认话术（收窄范围）→ 只当补料续跑、不产出批准、请求同样被消费', () => runSteps([
      ['确认话术 → 追加批准记录（含回复里点名的文件与操作人），清空请求并回队', () => {
        const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
        parkScopeBlocked(store)
        const resumed = store.resumeWithSupplement({ id: 'scope-1', supplementText: '确认扩大范围，apps/web/src/extra.ts 也可以改', operator: 'ou_qa' })
        assert.equal(resumed.status, 'queued')
        assert.equal(resumed.scopeRequest, null)
        assert.equal(resumed.scopeApprovals.length, 1)
        assert.deepEqual(resumed.scopeApprovals[0].paths, ['apps/web/src/neighbor.ts', 'package.json', 'apps/web/src/extra.ts'])
        assert.equal(resumed.scopeApprovals[0].approvedBy, 'ou_qa')
        // 持久化后重载仍在
        assert.deepEqual(createTaskStore({ tasksDir: dir, leaseMs: 1000 }).get('scope-1').scopeApprovals[0].paths.length, 3)
      }],

      ['非确认话术（收窄范围）→ 只当补料续跑，不产出批准，请求同样被消费', () => {
        const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
        parkScopeBlocked(store)
        const resumed = store.resumeWithSupplement({ id: 'scope-1', supplementText: '不要改 neighbor，只改 a.ts' })
        assert.equal(resumed.status, 'queued')
        assert.equal(resumed.scopeApprovals, undefined)
        assert.equal(resumed.scopeRequest, null)
        assert.match(resumed.text, /【补料】\n不要改 neighbor/)
      }],
    ], hooks))
  })
})

describe('续租 touchLease（第 0 批：长任务不再被当孤儿回收）', () => {
  let dir
  const hooks = {
    before: () => { dir = mkdtempSync(join(tmpdir(), 'lark-store-lease-')) },
    after: () => rmSync(dir, { recursive: true, force: true }),
  }

  it('running 任务续租后 claimedAt 前移；epoch 不符 / 非 running 回 409；不存在 404', () => runSteps([
    ['running 任务续租后 claimedAt 前移；epoch 不符 / 非 running 回 409；不存在 404', () => {
      const store = createTaskStore({ tasksDir: dir, leaseMs: 60_000 })
      store.upsert({ id: 'a', status: 'queued', createdAt: '2026-01-01T00:00:00Z' })
      const claimed = store.claimNext()
      // 不靠真实 sleep（机器负载高时毫秒级等待不可靠）：把领取时刻拨到 50s 前，离租约到期只剩 10s
      const stale = new Date(Date.now() - 50_000).toISOString()
      store.upsert({ ...claimed, claimedAt: stale })
      const touched = store.touchLease('a', 0)
      assert.equal(touched.ok, true)
      assert.ok(touched.claimedAt > stale)
      // 若没续租，再过 10s 就是孤儿；续租后 claimedAt = 现在，claimNext 不会把它当孤儿重入队
      assert.equal(store.claimNext(), null)
      assert.equal(store.get('a').status, 'running')
      assert.deepEqual(store.touchLease('a', 1).code, 409)
      assert.deepEqual(store.touchLease('zzz', 0).code, 404)
      store.upsert({ id: 'b', status: 'queued', createdAt: '2026-01-01T00:00:00Z' })
      assert.deepEqual(store.touchLease('b', 0).code, 409)
    }],

    ['续租按任务当前代次核对：非 0 代次相符可续，不符 409 并报当前代次（变异补测 10-24）', () => {
      const store = createTaskStore({ tasksDir: dir, leaseMs: 60_000 })
      store.upsert({ id: 'g', status: 'running', epoch: 2, claimedAt: new Date().toISOString(), createdAt: '2026-01-01T00:00:00Z' })
      assert.equal(store.touchLease('g', 2).ok, true)
      const stale = store.touchLease('g', 1)
      assert.equal(stale.code, 409)
      assert.equal(stale.error, 'stale epoch: got 1, current 2')
    }],
  ], hooks))
})

describe('变更流与按状态查（第 2 批）', () => {
  let dir
  const hooks = {
    before: () => { dir = mkdtempSync(join(tmpdir(), 'lark-store-changes-')) },
    after: () => rmSync(dir, { recursive: true, force: true }),
  }

  it('每次落盘发一条变更；changesSince 按 seq 过滤；list 按状态 / repo 过滤；updateIfEpoch 做 CAS', () => runSteps([
    ['每次落盘发一条变更；changesSince 按 seq 过滤；list 按状态 / repo 过滤；updateIfEpoch 做 CAS', async () => {
      const store = createTaskStore({ tasksDir: dir, leaseMs: 60_000 })
      assert.deepEqual(store.changesSince(-1), { seq: 0, changes: [] })
      store.upsert({ id: 'a', status: 'queued', repo: 'falive', createdAt: '2026-01-01T00:00:00Z' })
      store.upsert({ id: 'b', status: 'done', repo: 'x', createdAt: '2026-01-01T00:00:00Z' })
      const page = store.changesSince(0)
      assert.equal(page.seq, 2)
      assert.deepEqual(page.changes.map((item) => [item.id, item.status]), [['a', 'queued'], ['b', 'done']])
      assert.deepEqual(store.list({ statuses: ['queued'] }).map((task) => task.id), ['a'])
      assert.deepEqual(store.list({ repo: 'x' }).map((task) => task.id), ['b'])
      assert.equal(store.list().length, 2)
      const waiting = store.waitForChange(1000)
      store.claimById('a')
      assert.equal(await waiting, true)
      assert.equal(await store.waitForChange(10), false)
      assert.equal(store.updateIfEpoch('a', 5, (task) => { task.note = 'x' }), null, 'epoch 不符不写')
      assert.equal(store.updateIfEpoch('a', 0, (task) => { task.note = 'x' }, { expectStatus: 'queued' }), null, 'status 不符不写')
      assert.equal(store.updateIfEpoch('a', 0, (task) => { task.note = 'ok' }).note, 'ok')
      assert.equal(store.get('a').note, 'ok')
    }],

    ['updateIfEpoch 按任务当前代次核对：非 0 代次相符照写、不符不写（变异补测 10-24）', () => {
      const store = createTaskStore({ tasksDir: dir, leaseMs: 60_000 })
      store.upsert({ id: 'g', status: 'queued', epoch: 3, createdAt: '2026-01-01T00:00:00Z' })
      assert.equal(store.updateIfEpoch('g', 3, (task) => { task.note = 'ok' })?.note, 'ok')
      assert.equal(store.updateIfEpoch('g', 2, (task) => { task.note = 'stale' }), null)
      assert.equal(store.get('g').note, 'ok')
    }],
  ], hooks))
})
