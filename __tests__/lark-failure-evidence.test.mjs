#!/usr/bin/env node
/**
 * 失败卡旁证（自愈环 1.6）：报「没做成」前看发件簿与工作区。
 *   node --test __tests__/lark-failure-evidence.test.mjs
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { collectFailureEvidence, formatFailureEvidence, isProbablyDoneResult } from '../lib/lark-failure-evidence.mjs'
import { buildFailureResult } from '../lib/lark-worker-results.mjs'
import { buildRepoNote } from '../lib/lark-repo-delivery.mjs'
import { runSteps } from './support/steps.mjs'

const task = { id: 'om_1', chatId: 'oc_1', text: '今天日报发一下 @Aven.Bot', claimedAt: '2026-10-15T17:07:00.000Z' }
const at = (min) => new Date(Date.parse(task.claimedAt) + min * 60_000).toISOString()

describe('collectFailureEvidence', () => {
  it('完成旁证：日报已发群 / 本任务 done 消息算强旁证，其余只列不判，没旁证明说无', () => runSteps([
    ['10-15 的形状：任务期间日报已发群 → 强旁证，收到 / ack 不算', () => {
      const outbox = [
        { at: at(0.5), taskId: 'om_1', phase: 'ack', text: '<at id=ou_x></at> 收到，我整理今天的日报后发到群里。' },
        { at: at(17), taskId: null, phase: 'daily_report', text: '# Falive Web 日报 2026-10-15\n\n总体进度 71.7%' },
      ]
      const evidence = collectFailureEvidence({ task, outbox, worktreeState: 'clean' })
      assert.equal(evidence.probablyDone, true)
      assert.equal(evidence.lines.length, 1)
      assert.match(evidence.lines[0], /群里已发日报「Falive Web 日报 2026-10-15」/)
      assert.match(formatFailureEvidence(evidence), /活可能已经干成，只是没拿到结果文件/)
    }],
    ['本任务的 done 消息是强旁证；别的任务的消息只列不判；任务开始前的不算；被闸拦的不算', () => {
      const outbox = [
        { at: at(-5), taskId: 'om_1', phase: 'done', text: '上一代的完成' },
        { at: at(3), taskId: 'om_9', phase: 'done', text: '<at id=ou_a></at> 别的任务做完了' },
        { at: at(4), taskId: 'om_1', phase: 'done', text: '本任务做完了', gated: 'duplicate' },
      ]
      const weak = collectFailureEvidence({ task: { ...task, text: '修一下资料页' }, outbox })
      assert.equal(weak.probablyDone, false)
      assert.deepEqual(weak.lines.map((line) => line.replace(/^\d\d:\d\d /, '')), ['群里已发另一条完成消息「别的任务做完了」'])
      const strong = collectFailureEvidence({ task: { ...task, text: '修一下资料页' }, outbox: [{ at: at(4), taskId: 'om_1', phase: 'done', text: '本任务做完了' }] })
      assert.equal(strong.probablyDone, true)
    }],
    ['没旁证 → 明说无；工作区脏 → 列出但不判完成', () => {
      assert.equal(formatFailureEvidence(collectFailureEvidence({ task, outbox: [] })), '旁证：无（期间群里没发过消息、工作区无改动）')
      const dirty = collectFailureEvidence({ task, outbox: [], worktreeState: 'dirty' })
      assert.equal(dirty.probablyDone, false)
      assert.deepEqual(dirty.lines, ['工作区有未提交改动（现场已保留）'])
    }],
  ]))
})

describe('失败卡与私信带旁证', () => {
  const error = new Error("Claude 未返回合法结构化结果：ENOENT: no such file or directory, open '/tmp/x/result.json'")
  it('失败卡旁证排在失败类型前，私信按有无旁证措辞', () => runSteps([
    ['buildFailureResult 旁证排在失败类型前；没有旁证时格式与原来一致', () => {
      const evidenceLine = formatFailureEvidence(collectFailureEvidence({ task, outbox: [{ at: at(17), taskId: null, phase: 'daily_report', text: '# 日报' }] }))
      const withEvidence = buildFailureResult(task, error, { evidenceLine })
      assert.match(withEvidence, /^处理失败。\n1\. 任务：[^\n]+；\n2\. 旁证：[^\n]+活可能已经干成[^\n]+；\n3\. 失败类型：环境失败；\n4\. 下一步：[^\n]+。\n5\. 错误：Claude 未返回/)
      const plain = buildFailureResult(task, error)
      assert.match(plain, /^处理失败。\n1\. 任务：[^\n]+；\n2\. 失败类型：环境失败；\n3\. 下一步：[^\n]+。\n4\. 错误：/)
      assert.equal(isProbablyDoneResult(withEvidence), true)
      assert.equal(isProbablyDoneResult(plain), false)
    }],
    ['私信：有完成旁证说「可能做成了」，没有才说「没做成」', () => {
      const profile = { key: 'falive', chatIds: ['oc_1'], notifyChatId: 'oc_p', chatNames: {} }
      const evidenceLine = formatFailureEvidence(collectFailureEvidence({ task, outbox: [{ at: at(17), taskId: null, phase: 'daily_report', text: '# 日报' }] }))
      const probably = buildRepoNote({ task, status: 'failed', profile, result: buildFailureResult(task, error, { evidenceLine }) })
      assert.match(probably, /^⚠ 可能做成了、但没拿到结果文件/)
      assert.match(probably, /旁证：.*群里已发日报/)
      const plain = buildRepoNote({ task, status: 'failed', profile, result: buildFailureResult(task, error) })
      assert.match(plain, /^⛔ 没做成/)
    }],
  ]))
})
