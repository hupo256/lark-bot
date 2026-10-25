#!/usr/bin/env node
/**
 * 失败指纹与确定性剧本（自愈环 2）：用 worker.log 10-13 ~ 10-15 真实出现过的错误形状回归。
 *   node --test __tests__/lark-failure-fingerprint.test.mjs
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
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
import { runSteps } from './support/steps.mjs'

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
  it('错误指纹：真实错误归类、实例差异归一、未知错误不重排队', () => runSteps([
    ['真实错误各归其类', () => {
      const expect = {
        resultMissing: 'result_missing', ruleContext: 'rule_context', exit1: 'exec_exit', aborted: 'aborted', timeout: 'timeout',
        cursorTransient: 'transient_api', staleEpoch: 'stale_epoch', resultInvalid: 'result_invalid', toolMissing: 'tool_missing', readonly: 'readonly_violation',
      }
      for (const [key, cls] of Object.entries(expect)) assert.equal(fingerprintFailure(new Error(REAL[key])).cls, cls, key)
    }],
    ['同一种错不同实例指纹相同：临时目录 / 任务 id / 数字都归一', () => {
      const a = fingerprintFailure(REAL.resultMissing)
      const b = fingerprintFailure(REAL.resultMissing.replace('wiD91Q', 'Ab12Cd').replace('07/f0k63', '99/zzz'))
      assert.equal(a.fingerprint, b.fingerprint)
      assert.match(a.fingerprint, /^result_missing:[0-9a-f]{8}$/)
      assert.equal(normalizeFailureText('timed out after 1800000ms on om_x100b62'), 'timed out after #ms on <id>')
      assert.notEqual(fingerprintFailure('claude exec timed out after 1800000ms').fingerprint, fingerprintFailure('pi exec timed out after 1800000ms').fingerprint)
    }],
    ['未知错误 → unknown，不重排队', () => {
      const fp = fingerprintFailure(new Error('something odd happened'))
      assert.equal(fp.cls, 'unknown')
      assert.equal(fp.requeue, false)
    }],
    ['异步 spawn 起不来执行器（spawn claude ENOENT / EACCES，含真实 spawn 报错）归 tool_missing、不重排队，不再落成 unknown 去开「未归类」自修（10-25 搬自 fameex 沙箱修复）', async () => {
      for (const text of ['spawn claude ENOENT', 'spawn /Users/aven/.local/bin/claude EACCES', 'spawnSync claude EACCES']) {
        const fp = fingerprintFailure(new Error(text))
        assert.deepEqual([fp.cls, fp.requeue], ['tool_missing', false], text)
      }
      const real = await new Promise((resolve) => spawn(join(tmpdir(), 'lark-no-such-dir', 'claude'), [], { stdio: 'ignore' }).on('error', resolve))
      assert.equal(real.code, 'ENOENT')
      assert.equal(fingerprintFailure(real).cls, 'tool_missing', real.message)
      assert.equal(fingerprintFailure(new Error('spawn claude')).cls, 'unknown', '没有错误码不算')
    }],
  ]))
})

describe('decideFailurePlaybook', () => {
  it('失败剧本：首次 requeue 再次 fail、换代 ignore，7 天同指纹算复发', () => runSteps([
    ['可重排队的类第一次 requeue、第二次 fail；不可重排队的直接 fail；换代 / 中断 ignore', () => {
      const rm = fingerprintFailure(REAL.resultMissing)
      assert.equal(decideFailurePlaybook({ fingerprint: rm, priorAttempts: 0 }).action, 'requeue')
      const second = decideFailurePlaybook({ fingerprint: rm, priorAttempts: 1 })
      assert.equal(second.action, 'fail')
      assert.match(second.reason, /已自动重跑 1 次仍失败/)
      assert.equal(decideFailurePlaybook({ fingerprint: fingerprintFailure(REAL.timeout), priorAttempts: 0 }).action, 'fail')
      assert.equal(decideFailurePlaybook({ fingerprint: fingerprintFailure(REAL.staleEpoch) }).action, 'ignore')
      assert.equal(decideFailurePlaybook({ fingerprint: fingerprintFailure(REAL.aborted) }).action, 'ignore')
    }],
    ['7 天内同指纹已出现 → recurring，失败卡写第几次', () => {
      const fp = fingerprintFailure(REAL.ruleContext)
      const playbook = decideFailurePlaybook({ fingerprint: fp, recentSameFingerprint: 15 })
      assert.equal(playbook.recurring, true)
      const line = formatFingerprintLine({ fingerprint: fp, playbook, recentSameFingerprint: 15 })
      assert.match(line, /^失败归类：规则文件缺失（bot 自己的环境），同一种错 7 天内第 16 次，指纹 rule_context:[0-9a-f]{8}$/)
      const result = buildFailureResult({ text: '修资料页' }, new Error(REAL.ruleContext), { fingerprintLine: line })
      assert.match(result, /\n2\. 失败类型：[^\n]+；\n3\. 失败归类：规则文件缺失/)
    }],
  ]))
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
  it('记录 → 本任务重排队次数 / 同指纹复发计数 / 汇总', () => runSteps([
    ['记录 → 本任务重排队次数 / 同指纹复发计数（按任务数）/ 汇总（只数 fail）', () => {
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
        // om_1 的 requeue + fail 只算 1 个任务（10-25 改口径：复发按不同任务数）
        assert.equal(countRecentFingerprint({ dir, repo: 'falive', fingerprint: fp.fingerprint, now: now + 200_000 }), 1)
        assert.equal(listFailures({ dir, repo: 'falive' }).length, 4)
        const summary = summarizeFailures({ dir, repo: 'falive', now: now + 200_000 })
        assert.deepEqual(summary.byClass, { result_missing: 1 })
        assert.deepEqual(summary.recurring, [])
        assert.equal(summary.total, 1)
        assert.equal(summary.healed, 1)
        assert.equal(listFailures({ dir: join(dir, 'nope') }).length, 0)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }],
    ['复发只数别的任务：传 taskId 时本任务自己的行不算、同一任务多行只算 1 个、缺 taskId 的旧行各算各的；汇总只数 fail（requeue 单列、自修 / ignore 不算），复发 = 不同任务 ≥2、count 是任务数（10-25 搬自 fameex 沙箱修复）', () => {
      const dir = mkdtempSync(join(tmpdir(), 'lark-failures-'))
      try {
        const fp = fingerprintFailure(REAL.resultMissing)
        const now = Date.parse('2026-10-16T08:00:00Z')
        const at = now + 200_000
        // 沙箱试跑原样：任务自己第一次 requeue，第二次失败时不能算「同一种错 7 天内第 2 次」
        recordFailure({ dir, repo: 'falive', taskId: 'om_1', epoch: 1, fingerprint: fp, action: 'requeue', now })
        assert.equal(countRecentFingerprint({ dir, repo: 'falive', fingerprint: fp.fingerprint, taskId: 'om_1', now: at }), 0)
        assert.equal(countRecentFingerprint({ dir, repo: 'falive', fingerprint: fp.fingerprint, taskId: 'om_9', now: at }), 1)
        recordFailure({ dir, repo: 'falive', taskId: 'om_1', epoch: 2, fingerprint: fp, action: 'fail', now: now + 60_000 })
        recordFailure({ dir, repo: 'falive', taskId: 'om_1', fingerprint: fp, action: 'self_fix_opened', now: now + 61_000 })
        assert.equal(countRecentFingerprint({ dir, repo: 'falive', fingerprint: fp.fingerprint, taskId: 'om_1', now: at }), 0)
        assert.equal(countRecentFingerprint({ dir, repo: 'falive', fingerprint: fp.fingerprint, taskId: 'om_9', now: at }), 1)
        assert.deepEqual(summarizeFailures({ dir, repo: 'falive', now: at }), { total: 1, byClass: { result_missing: 1 }, recurring: [], healed: 1 }, '一条任务 requeue + fail + 自修只算 1 次失败、不算复发')
        // 同一任务再失败一次：失败数 +1，复发仍按任务数（1 个任务不算复发）
        recordFailure({ dir, repo: 'falive', taskId: 'om_1', epoch: 3, fingerprint: fp, action: 'fail', now: now + 70_000 })
        assert.deepEqual(summarizeFailures({ dir, repo: 'falive', now: at }), { total: 2, byClass: { result_missing: 2 }, recurring: [], healed: 1 })
        // 别的任务只 requeue 过：复发计数算它（真失败），体检汇总的复发不算（那次已自愈）
        recordFailure({ dir, repo: 'falive', taskId: 'om_2', fingerprint: fp, action: 'requeue', now: now + 80_000 })
        assert.equal(countRecentFingerprint({ dir, repo: 'falive', fingerprint: fp.fingerprint, taskId: 'om_1', now: at }), 1)
        assert.deepEqual(summarizeFailures({ dir, repo: 'falive', now: at }).recurring, [])
        // 第二条任务也失败 → 复发，count = 2 个任务（om_1 的两次失败不多算）
        recordFailure({ dir, repo: 'falive', taskId: 'om_2', fingerprint: fp, action: 'fail', now: now + 90_000 })
        assert.deepEqual(summarizeFailures({ dir, repo: 'falive', now: at }), { total: 3, byClass: { result_missing: 3 }, recurring: [{ fingerprint: fp.fingerprint, count: 2 }], healed: 2 })
        assert.equal(countRecentFingerprint({ dir, repo: 'falive', fingerprint: fp.fingerprint, now: at }), 2)
        // 缺 taskId 的旧行各算各的；没有指纹的 fail 行只进失败数
        const legacy = 'legacy'
        recordFailure({ dir, repo: legacy, fingerprint: fp, action: 'fail', now })
        recordFailure({ dir, repo: legacy, fingerprint: fp, action: 'fail', now })
        recordFailure({ dir, repo: legacy, taskId: 'om_x', fingerprint: null, action: 'fail', now })
        assert.equal(countRecentFingerprint({ dir, repo: legacy, fingerprint: fp.fingerprint, now: at }), 2)
        assert.deepEqual(summarizeFailures({ dir, repo: legacy, now: at }), { total: 3, byClass: { result_missing: 2, unknown: 1 }, recurring: [{ fingerprint: fp.fingerprint, count: 2 }], healed: 0 })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }],
  ]))
})
