#!/usr/bin/env node
/**
 * 自修工单（自愈环 2.2）：开不开的决策、预算、工单正文、enqueue 与台账；lark-bot 规则 profile 能构建。
 *   node --test __tests__/lark-self-fix.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { fingerprintFailure } from '../lib/lark-failure-fingerprint.mjs'
import { listFailures, recordFailure } from '../lib/lark-failure-ledger.mjs'
import { larkBotRoot } from '../lib/lark-paths.mjs'
import { registerRepoProfiles } from '../lib/lark-repo-profile.mjs'
import { buildFocusedRuleContext } from '../lib/lark-rule-context.mjs'
import {
  SELF_FIX_DAILY_CAP,
  SELF_FIX_REPO,
  buildSelfFixTaskText,
  maybeOpenSelfFix,
  selfFixBudget,
  selfFixTaskId,
  shouldOpenSelfFix,
} from '../lib/lark-self-fix.mjs'
import { runSteps } from './support/steps.mjs'

const task = { id: 'om_1', repo: 'falive', epoch: 1, text: '今天日报发一下 @Aven.Bot', operator: 'ou_aven' }
const resultMissing = fingerprintFailure("Claude 未返回合法结构化结果：ENOENT: no such file or directory, open '/tmp/x/result.json'")
const unknown = fingerprintFailure('something nobody has seen')
const timeout = fingerprintFailure('claude exec timed out after 1800000ms')
const fail = { action: 'fail', reason: 'x' }

describe('shouldOpenSelfFix', () => {
  it('开不开自修工单：复发 / 未归类才开，硬条件与预算拦下', () => runSteps([
    ['首次、已归类、没自动重跑 → 不开（先记台账）；复发 / 未归类 / 重跑也没救 → 开', () => {
      assert.equal(shouldOpenSelfFix({ task, fingerprint: resultMissing, playbook: fail }).open, false)
      assert.match(shouldOpenSelfFix({ task, fingerprint: resultMissing, playbook: fail, recentSameFingerprint: 1 }).reason, /第 2 次/)
      assert.equal(shouldOpenSelfFix({ task, fingerprint: resultMissing, playbook: fail, recentSameFingerprint: 1 }).open, true)
      assert.equal(shouldOpenSelfFix({ task, fingerprint: unknown, playbook: fail }).open, true)
      assert.equal(shouldOpenSelfFix({ task, fingerprint: resultMissing, playbook: fail, priorAttempts: 1 }).open, true)
    }],
    ['不开的硬条件：关闭 / 没 profile / 自修工单自己失败 / 剧本不是 fail / 不是代码能修的类 / 超时单次', () => {
      const base = { task, fingerprint: unknown, playbook: fail }
      assert.equal(shouldOpenSelfFix({ ...base, enabled: false }).open, false)
      assert.equal(shouldOpenSelfFix({ ...base, profileExists: false }).open, false)
      assert.equal(shouldOpenSelfFix({ ...base, task: { ...task, repo: SELF_FIX_REPO } }).open, false)
      assert.equal(shouldOpenSelfFix({ ...base, task: { ...task, source: 'self-heal' } }).open, false)
      assert.equal(shouldOpenSelfFix({ ...base, playbook: { action: 'requeue' } }).open, false)
      assert.equal(shouldOpenSelfFix({ ...base, fingerprint: fingerprintFailure('cursor-agent CLI 不可用：spawnSync cursor-agent ENOENT') }).open, false)
      assert.equal(shouldOpenSelfFix({ task, fingerprint: timeout, playbook: fail }).open, false)
      assert.equal(shouldOpenSelfFix({ task, fingerprint: timeout, playbook: fail, recentSameFingerprint: 2 }).open, true)
    }],
    ['预算：同指纹 7 天 1 条；每天最多 3 条', () => {
      const base = { task, fingerprint: unknown, playbook: fail }
      assert.match(shouldOpenSelfFix({ ...base, openedForFingerprint: 1 }).reason, /已开过/)
      assert.match(shouldOpenSelfFix({ ...base, openedToday: SELF_FIX_DAILY_CAP }).reason, /达上限/)
    }],
  ]))
})

describe('工单正文与 id', () => {
  it('首行「修复：」前缀（走 bugfix 快车道），带错误原文、证据路径、根因层要求与硬边界', () => {
    const text = buildSelfFixTaskText({
      task, error: new Error('boom at /tmp/x'), fingerprint: unknown, recentSameFingerprint: 1, priorAttempts: 1,
      auditContext: { jsonPath: '/a/om_1-e1.json', logPath: '/a/om_1-e1.log' }, workerLogPath: null, trigger: '同指纹 7 天内第 2 次',
    })
    assert.match(text, /^修复：lark-bot 自身缺陷——未归类的异常（指纹 unknown:[0-9a-f]{8}）\n/)
    assert.match(text, /boom at \/tmp\/x/)
    assert.match(text, /原任务审计 JSON：\/a\/om_1-e1\.json/)
    assert.match(text, /\[harness\][\s\S]*\[external\]/)
    assert.match(text, /不碰 runtime\/[\s\S]*不 push；不 restart/)
    assert.match(text, /自动重排队 1 次仍失败/)
    assert.equal(selfFixTaskId({ fingerprint: unknown, now: Date.parse('2026-10-16T03:00:00Z') }), `selffix-unknown-${unknown.fingerprint.split(':')[1]}-20261016`)
  })
})

describe('maybeOpenSelfFix（enqueue + 台账）', () => {
  const withProfiles = async (fn) => {
    registerRepoProfiles({ repos: { 'lark-bot': { root: larkBotRoot, baseRef: 'main', ruleProfile: 'lark-bot' }, falive: { root: '/tmp/falive', baseRef: 'main' } } })
    try {
      return await fn()
    } finally {
      registerRepoProfiles({})
    }
  }
  it('enqueue 与台账：复发开单且同指纹不再开，没 profile 不开，enqueue 失败不抛', () => runSteps([
    ['复发 → POST 任务到 lark-bot 仓并记 self_fix_opened；同指纹第二次不再开', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'lark-selffix-'))
      try {
        await withProfiles(async () => {
          const enqueued = []
          const client = { enqueueTask: async (body) => { enqueued.push(body); return { task: { id: body.id } } } }
          const now = Date.parse('2026-10-16T03:00:00Z')
          const first = await maybeOpenSelfFix({ client, task, error: new Error('x'), fingerprint: unknown, playbook: fail, auditContext: null, ledgerDir: dir, now, log: () => {} })
          assert.equal(first.opened, true)
          assert.equal(enqueued.length, 1)
          assert.equal(enqueued[0].repo, SELF_FIX_REPO)
          assert.equal(enqueued[0].source, 'self-heal')
          assert.match(enqueued[0].text, /^修复：/)
          assert.deepEqual(listFailures({ dir }).map((entry) => entry.action), ['self_fix_opened'])
          const again = await maybeOpenSelfFix({ client, task: { ...task, id: 'om_2' }, error: new Error('x'), fingerprint: unknown, playbook: fail, ledgerDir: dir, now: now + 3600_000, log: () => {} })
          assert.equal(again.opened, false)
          assert.match(again.reason, /已开过/)
          assert.equal(enqueued.length, 1)
          assert.deepEqual(selfFixBudget({ dir, fingerprint: unknown.fingerprint, now: now + 3600_000 }), { openedToday: 1, openedForFingerprint: 1 })
        })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }],
    ['没有 lark-bot profile → 不开，不 enqueue', async () => {
      registerRepoProfiles({})
      const client = { enqueueTask: async () => { throw new Error('should not be called') } }
      const out = await maybeOpenSelfFix({ client, task, error: new Error('x'), fingerprint: unknown, playbook: fail, ledgerDir: mkdtempSync(join(tmpdir(), 'lark-selffix-')), log: () => {} })
      assert.equal(out.opened, false)
      assert.match(out.reason, /没有 lark-bot/)
    }],
    ['enqueue 失败只记日志，不抛', async () => {
      await withProfiles(async () => {
        const client = { enqueueTask: async () => { throw new Error('gateway down') } }
        const out = await maybeOpenSelfFix({ client, task, error: new Error('x'), fingerprint: unknown, playbook: fail, ledgerDir: mkdtempSync(join(tmpdir(), 'lark-selffix-')), log: () => {} })
        assert.equal(out.opened, false)
        assert.match(out.reason, /gateway down/)
      })
    }],
  ]))
})

describe('lark-bot 规则 profile', () => {
  it('lark-bot 规则 profile：本仓常驻规则能构建，仓库根不对则 fail-closed', () => runSteps([
    ['用本仓 AGENTS.md + 自愈原则作常驻硬规则，能构建、不 fail-closed', () => {
      const ctx = buildFocusedRuleContext({ taskText: '修复：lark-bot 自身缺陷', ruleRevisions: {}, ruleProfile: 'lark-bot', repoRoot: larkBotRoot })
      assert.equal(ctx.ruleProfile, 'lark-bot')
      assert.ok(ctx.sources.some((source) => /AGENTS\.md/.test(source.path)), JSON.stringify(ctx.sources).slice(0, 200))
      assert.match(ctx.text || JSON.stringify(ctx), /不 push|只本地提交/)
    }],
    ['仓库根不对 → 常驻规则缺失即 fail-closed', () => {
      const dir = mkdtempSync(join(tmpdir(), 'lark-rules-'))
      writeFileSync(join(dir, 'AGENTS.md'), '# 别的\n')
      try {
        assert.throws(() => buildFocusedRuleContext({ taskText: 'x', ruleRevisions: {}, ruleProfile: 'lark-bot', repoRoot: dir }), /VERIFY-RULE-004/)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }],
  ]))
})
