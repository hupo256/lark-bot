#!/usr/bin/env node
/**
 * runAI 编排单测（mock 执行器，不起真实 AI CLI、不读真实 git）：
 * 范围契约要求所有执行器在会改代码的任务上都先跑只读分析阶段、产出 scope，再实施；只读查询不受影响。
 *   node --test __tests__/lark-worker-run.test.mjs
 */

import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { describe, it } from 'node:test'

import { runAI } from '../lib/lark-worker-run.mjs'

const workContext = (extra = {}) => ({ projectId: 'PR-99999', projectName: '测试项目', projectDocs: [], cwd: tmpdir(), ...extra })
const scope = { targets: [{ path: 'apps/web/src/a.ts', symbols: ['amount'], reason: '首个出错位置' }], siblings: { searchQueries: ['amount'], items: [] } }
const readyAnalysis = (extra = {}) => ({ status: 'ready', summary: '定位到 a.ts', applicableRules: [], requirements: ['修正金额格式'], blockers: [], scope, ...extra })
const doneResult = { status: 'done', summary: '已修复', checks: ['biome'], changedFiles: ['apps/web/src/a.ts'], warnings: [] }

// mock 执行器：按 resultKind 返回预置结果，并记录每次调用的 resultKind 与 prompt。
const mockExec = ({ analysis = readyAnalysis(), result = doneResult } = {}) => {
  const calls = []
  const exec = async ({ executor, resultKind = 'task', promptText }) => {
    calls.push({ executor, resultKind, promptText })
    return { executor, result: resultKind === 'analysis' ? analysis : result }
  }
  return { exec, calls }
}
const stableSnapshot = () => ({ status: '', diff: '' })
const bugTask = (executor, extra = {}) => ({ id: `t-${executor}`, source: 'lark', text: '修复：提现页金额显示错误', aiExecutor: executor, attachments: [], ...extra })

describe('runAI：所有执行器在会改代码的任务上先跑只读分析', () => {
  for (const executor of ['claude']) {
    it(`${executor}：分析 → 实施两阶段，scope 随返回值带出，实施提示注入契约`, async () => {
      const { exec, calls } = mockExec()
      const run = await runAI({ localConfig: {} }, bugTask(executor), workContext(), null, undefined, { exec, snapshot: stableSnapshot })
      assert.deepEqual(calls.map((call) => call.resultKind), ['analysis', 'task'])
      assert.ok(calls.every((call) => call.executor === executor))
      assert.deepEqual(run.scope, scope)
      assert.equal(run.result.status, 'done')
      assert.match(calls[0].promptText, /修改范围契约（scope 字段/)
      assert.match(calls[0].promptText, /同因搜索/)
      assert.match(calls[1].promptText, /第一阶段只读分析已判定 ready/)
      assert.match(calls[1].promptText, /可改文件：\n {2}- apps\/web\/src\/a\.ts〔amount〕：首个出错位置/)
      assert.match(calls[1].promptText, /改动行数上限 120 行/)
      assert.match(calls[1].promptText, /实施中发现必须改契约外的文件 → 停止/)
    })
  }

  it('只读查询（claude）仍单趟，不跑分析、不带 scope', async () => {
    const { exec, calls } = mockExec()
    const run = await runAI({ localConfig: {} }, bugTask('claude', { text: '状态：项目进度如何' }), workContext({ readOnly: true }), null, undefined, { exec, snapshot: stableSnapshot })
    assert.deepEqual(calls.map((call) => call.resultKind), ['task'])
    assert.equal(run.scope, null)
  })

  it('自测类命令（不做收尾核对）：仍先分析，但不宣称越界不提交、实施不注入契约', async () => {
    const { exec, calls } = mockExec()
    await runAI({ localConfig: {} }, bugTask('claude', { text: '自测：跑一下提现页的单测' }), workContext(), null, undefined, { exec, snapshot: stableSnapshot })
    assert.deepEqual(calls.map((call) => call.resultKind), ['analysis', 'task'])
    assert.match(calls[0].promptText, /不做收尾范围核对/)
    assert.doesNotMatch(calls[1].promptText, /修改范围契约（第一阶段只读分析产出/)
  })

  it('分析 blocked → 不进入实施，返回 blocked 结果', async () => {
    const { exec, calls } = mockExec({ analysis: readyAnalysis({ status: 'blocked', blockers: ['无法定位目标页面'], scope: null }) })
    const run = await runAI({ localConfig: {} }, bugTask('claude'), workContext(), null, undefined, { exec, snapshot: stableSnapshot })
    assert.deepEqual(calls.map((call) => call.resultKind), ['analysis'])
    assert.equal(run.result.status, 'blocked')
    assert.deepEqual(run.result.blockers, ['无法定位目标页面'])
  })

  it('分析前后工作区变化 → 违反只读约束直接抛错，不实施', async () => {
    const { exec, calls } = mockExec()
    let n = 0
    const snapshot = () => ({ status: n++ ? ' M a.ts' : '', diff: '' })
    await assert.rejects(
      runAI({ localConfig: {} }, bugTask('claude'), workContext(), null, undefined, { exec, snapshot }),
      /claude 分析阶段违反只读约束/,
    )
    assert.deepEqual(calls.map((call) => call.resultKind), ['analysis'])
  })

  it('集合型任务：分析提示点名命中词并要求 siblings 非空', async () => {
    const { exec, calls } = mockExec()
    await runAI({ localConfig: {} }, bugTask('claude', { text: '「可用余额」统一改为「余额」，涉及申请/列表/流水' }), workContext(), null, undefined, { exec, snapshot: stableSnapshot })
    assert.match(calls[0].promptText, /这是集合型任务（命中词：「统一」）/)
    assert.match(calls[0].promptText, /siblings\.items 不能为空/)
  })

  it('非集合型任务不注入集合型要求', async () => {
    const { exec, calls } = mockExec()
    await runAI({ localConfig: {} }, bugTask('claude'), workContext(), null, undefined, { exec, snapshot: stableSnapshot })
    assert.doesNotMatch(calls[0].promptText, /这是集合型任务/)
  })

  it('人工已批准扩大的文件：分析提示列为可信额外目标，实施契约并入；本机 scopeBudgets 覆盖行数上限', async () => {
    const { exec, calls } = mockExec()
    const task = bugTask('claude', { scopeApprovals: [{ paths: ['apps/web/src/neighbor.ts'], approvedBy: 'ou_x', at: '2026-10-11T00:00:00Z' }] })
    await runAI({ localConfig: { scopeBudgets: { bugfix: 80 } } }, task, workContext(), null, undefined, { exec, snapshot: stableSnapshot })
    assert.match(calls[0].promptText, /人工已确认扩大范围的文件（可信输入，必须列入 targets[^\n]*`apps\/web\/src\/neighbor\.ts`/)
    assert.match(calls[0].promptText, /改动行数上限：80 行/)
    assert.match(calls[1].promptText, / {2}- apps\/web\/src\/neighbor\.ts：人工确认扩大范围/)
    assert.match(calls[1].promptText, /改动行数上限 80 行/)
  })
})
