#!/usr/bin/env node
/**
 * 失败指纹与确定性剧本（自愈环 2）：用 worker.log 10-13 ~ 10-15 真实出现过的错误形状回归。
 *   node --test __tests__/lark-failure-fingerprint.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  buildSelfHealHint,
  decideFailurePlaybook,
  fingerprintFailure,
  formatFingerprintLine,
  normalizeFailureText,
} from '../lib/lark-failure-fingerprint.mjs'
import { countRecentFingerprint, listFailures, recordFailure, selfHealAttemptsForTask, summarizeFailures } from '../lib/lark-failure-ledger.mjs'
import { buildFailureResult } from '../lib/lark-worker-results.mjs'

const REAL = {
  resultMissing: "Claude 未返回合法结构化结果：ENOENT: no such file or directory, open '/var/folders/07/f0k63_dx0yb54r7bk3dx0ddr0000gp/T/lark-claude-result-wiD91Q/result.json'",
  ruleContext: '[VERIFY-RULE-004] 规则上下文构建失败：缺失常驻硬规则 common/rules/rule-router.md### 2. 常驻硬规则，拒绝使用不完整规则执行',
  exit1: 'claude exec exited with code 1',
  aborted: 'claude exec aborted（worker 退出或任务已取消/换代）',
  timeout: 'pi exec timed out after 1800000ms',
  cursorTransient: 'cursor exec exited with code 1：pi5.cursor.sh (attempt 5)...',
  staleEpoch: 'POST /lark/tasks/om_x100b62/status failed: 409 {"ok":false,"code":409,"error":"stale epoch: got 2"}',
  resultInvalid: 'Cursor 根因在 cross-boundary（后端/跨层），不能标 taskState=completed 关单：请改用 awaiting_owner_fix，并在 blockers 列出已转交后端的缺陷项',
  toolMissing: 'cursor-agent CLI 不可用：spawnSync cursor-agent ENOENT',
  readonly: 'claude 分析阶段违反只读约束：git status/diff 在分析前后发生变化，已停止实施',
}

describe('fingerprintFailure', () => {
  it('真实错误各归其类', () => {
    const expect = {
      resultMissing: 'result_missing', ruleContext: 'rule_context', exit1: 'exec_exit', aborted: 'aborted', timeout: 'timeout',
      cursorTransient: 'transient_api', staleEpoch: 'stale_epoch', resultInvalid: 'result_invalid', toolMissing: 'tool_missing', readonly: 'readonly_violation',
    }
    for (const [key, cls] of Object.entries(expect)) assert.equal(fingerprintFailure(new Error(REAL[key])).cls, cls, key)
  })
  it('同一种错不同实例指纹相同：临时目录 / 任务 id / 数字都归一', () => {
    const a = fingerprintFailure(REAL.resultMissing)
    const b = fingerprintFailure(REAL.resultMissing.replace('wiD91Q', 'Ab12Cd').replace('07/f0k63', '99/zzz'))
    assert.equal(a.fingerprint, b.fingerprint)
    assert.match(a.fingerprint, /^result_missing:[0-9a-f]{8}$/)
    assert.equal(normalizeFailureText('timed out after 1800000ms on om_x100b62'), 'timed out after #ms on <id>')
    assert.notEqual(fingerprintFailure('claude exec timed out after 1800000ms').fingerprint, fingerprintFailure('pi exec timed out after 1800000ms').fingerprint)
  })
  it('未知错误 → unknown，不重排队', () => {
    const fp = fingerprintFailure(new Error('something odd happened'))
    assert.equal(fp.cls, 'unknown')
    assert.equal(fp.requeue, false)
  })
})

describe('decideFailurePlaybook', () => {
  it('可重排队的类第一次 requeue、第二次 fail；不可重排队的直接 fail；换代 / 中断 ignore', () => {
    const rm = fingerprintFailure(REAL.resultMissing)
    assert.equal(decideFailurePlaybook({ fingerprint: rm, priorAttempts: 0 }).action, 'requeue')
    const second = decideFailurePlaybook({ fingerprint: rm, priorAttempts: 1 })
    assert.equal(second.action, 'fail')
    assert.match(second.reason, /已自动重跑 1 次仍失败/)
    assert.equal(decideFailurePlaybook({ fingerprint: fingerprintFailure(REAL.timeout), priorAttempts: 0 }).action, 'fail')
    assert.equal(decideFailurePlaybook({ fingerprint: fingerprintFailure(REAL.staleEpoch) }).action, 'ignore')
    assert.equal(decideFailurePlaybook({ fingerprint: fingerprintFailure(REAL.aborted) }).action, 'ignore')
  })
  it('7 天内同指纹已出现 → recurring，失败卡写第几次', () => {
    const fp = fingerprintFailure(REAL.ruleContext)
    const playbook = decideFailurePlaybook({ fingerprint: fp, recentSameFingerprint: 15 })
    assert.equal(playbook.recurring, true)
    const line = formatFingerprintLine({ fingerprint: fp, playbook, recentSameFingerprint: 15 })
    assert.match(line, /^失败归类：规则文件缺失（bot 自己的环境），同一种错 7 天内第 16 次，指纹 rule_context:[0-9a-f]{8}$/)
    const result = buildFailureResult({ text: '修资料页' }, new Error(REAL.ruleContext), { fingerprintLine: line })
    assert.match(result, /\n2\. 失败类型：[^\n]+；\n3\. 失败归类：规则文件缺失/)
  })
})

describe('buildSelfHealHint', () => {
  it('按上次类别给一句针对性提示；没有记录返回 null', () => {
    assert.equal(buildSelfHealHint([]), null)
    const hint = buildSelfHealHint([{ cls: 'result_missing', label: '模型没写结果文件' }])
    assert.match(hint, /自动重跑[\s\S]*第 2 次执行[\s\S]*不要放后台/)
    assert.match(buildSelfHealHint([{ cls: 'result_invalid', message: 'checks 必须是字符串数组' }]), /checks 必须是字符串数组/)
  })
})

describe('失败台账', () => {
  it('记录 → 本任务重排队次数 / 同指纹复发计数 / 汇总', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lark-failures-'))
    try {
      const fp = fingerprintFailure(REAL.resultMissing)
      const now = Date.parse('2026-10-16T08:00:00Z')
      recordFailure({ dir, repo: 'falive', taskId: 'om_1', epoch: 1, fingerprint: fp, action: 'requeue', reason: 'r', message: REAL.resultMissing, now })
      recordFailure({ dir, repo: 'falive', taskId: 'om_1', epoch: 2, fingerprint: fp, action: 'fail', reason: 'f', now: now + 60_000 })
      recordFailure({ dir, repo: 'falive', taskId: 'om_2', fingerprint: fingerprintFailure(REAL.staleEpoch), action: 'ignore', now: now + 120_000 })
      recordFailure({ dir, repo: 'falive', taskId: 'om_3', fingerprint: fp, action: 'fail', now: now - 10 * 24 * 60 * 60_000 })
      assert.equal(selfHealAttemptsForTask({ dir, repo: 'falive', taskId: 'om_1' }).length, 1)
      assert.equal(selfHealAttemptsForTask({ dir, repo: 'falive', taskId: 'om_2' }).length, 0)
      assert.equal(countRecentFingerprint({ dir, repo: 'falive', fingerprint: fp.fingerprint, now: now + 200_000 }), 2)
      assert.equal(listFailures({ dir, repo: 'falive' }).length, 4)
      const summary = summarizeFailures({ dir, repo: 'falive', now: now + 200_000 })
      assert.deepEqual(summary.byClass, { result_missing: 2 })
      assert.deepEqual(summary.recurring, [{ fingerprint: fp.fingerprint, count: 2 }])
      assert.equal(summary.healed, 1)
      assert.equal(listFailures({ dir: join(dir, 'nope') }).length, 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
