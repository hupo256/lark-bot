#!/usr/bin/env node
/**
 * runAI 编排单测（mock 执行器，不起真实 AI CLI、不读真实 git）：
 * 范围契约要求所有执行器在会改代码的任务上都先跑只读分析阶段、产出 scope，再实施；只读查询不受影响。
 *   node --test __tests__/lark-worker-run.test.mjs
 */

import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { describe, it } from 'node:test'

import { buildCredentialProbeBlock, hasLoginCredentials } from '../lib/lark-credential-cue.mjs'
import { buildAnalysisPrompt } from '../lib/lark-worker-prompts.mjs'
import { runAI, scopeFromAnalysisText } from '../lib/lark-worker-run.mjs'

const workContext = (extra = {}) => ({ projectId: 'PR-99999', projectName: '测试项目', projectDocs: [], cwd: tmpdir(), ...extra })
const scope = { targets: [{ path: 'apps/web/src/a.ts', symbols: ['amount'], reason: '首个出错位置' }], siblings: { searchQueries: ['amount'], items: [] } }
const readyAnalysis = (extra = {}) => ({ status: 'ready', summary: '定位到 a.ts', applicableRules: [], requirements: ['修正金额格式'], blockers: [], scope, ...extra })
const doneResult = { status: 'done', summary: '已修复', checks: ['biome'], changedFiles: ['apps/web/src/a.ts'], warnings: [] }

// mock 执行器：按 resultKind 返回预置结果，并记录每次调用的 resultKind 与 prompt。
const mockExec = ({ analysis = readyAnalysis(), result = doneResult } = {}) => {
  const calls = []
  const exec = async ({ executor, resultKind = 'task', promptText, systemPromptText = null }) => {
    calls.push({ executor, resultKind, promptText, systemPromptText })
    return { executor, result: resultKind === 'analysis' ? analysis : result }
  }
  return { exec, calls }
}
const stableSnapshot = () => ({ status: '', diff: '' })
const bugTask = (executor, extra = {}) => ({ id: `t-${executor}`, source: 'lark', text: '修复：提现页金额显示错误', aiExecutor: executor, attachments: [], ...extra })

describe('runAI：所有执行器在会改代码的任务上先跑只读分析', () => {
  for (const executor of ['codex', 'claude', 'pi', 'cursor']) {
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
      assert.match(calls[1].promptText, /改动行数参考 120 行.*超出不拦/)
      assert.match(calls[1].promptText, /实施中发现必须改契约外的文件 → 停止/)
    })
  }

  it('配了页面验证工具（localConfig.verify）：实施提示带「自己验证」规则；只读单趟不带规则但视觉口径按页面工具说（从 falive 移植 11-01）', async () => {
    const verify = { localDev: ['pnpm', 'dev'], compareBase: 'https://test.example.com' }
    const { exec, calls } = mockExec()
    await runAI({ localConfig: { verify } }, bugTask('claude'), workContext(), null, undefined, { exec, snapshot: stableSnapshot })
    // claude：「自己验证」属驾驶规则，走系统层（分析与实施共用一份），user 只放本轮
    assert.match(calls[1].systemPromptText, /自己验证（硬规则）/)
    assert.equal(calls[0].systemPromptText, calls[1].systemPromptText, '分析与实施同一份系统层（续会话快照安全）')
    assert.doesNotMatch(calls[1].promptText, /自己验证（硬规则）/)
    assert.doesNotMatch(`${calls[1].systemPromptText}\n${calls[1].promptText}`, /禁止启动 dev server|不要启动 dev server/)
    calls.length = 0
    await runAI({ localConfig: { verify } }, bugTask('cursor'), workContext(), null, undefined, { exec, snapshot: stableSnapshot })
    assert.match(calls[1].promptText, /自己验证（硬规则）/, '没有系统层参数的执行器拼进同一份提示')
    assert.equal(calls[1].systemPromptText ?? null, null)
    calls.length = 0
    await runAI({ localConfig: { verify } }, bugTask('claude', { text: '状态：项目进度如何' }), workContext({ readOnly: true }), null, undefined, { exec, snapshot: stableSnapshot })
    assert.equal(calls.length, 1)
    assert.doesNotMatch(calls[0].promptText, /自己验证（硬规则）/, '只读查询不起 dev 服务')
    assert.doesNotMatch(calls[0].promptText, /禁止启动 dev server|不要启动 dev server/, '配了工具就不再说禁止起服务')
    calls.length = 0
    await runAI({ localConfig: {} }, bugTask('claude'), workContext(), null, undefined, { exec, snapshot: stableSnapshot })
    assert.doesNotMatch(`${calls[1].systemPromptText}\n${calls[1].promptText}`, /自己验证（硬规则）/, '没配 verify 不变')
  })

  it('只读查询（claude）仍单趟，不跑分析、不带 scope', async () => {
    const { exec, calls } = mockExec()
    const run = await runAI({ localConfig: {} }, bugTask('claude', { text: '状态：项目进度如何' }), workContext({ readOnly: true }), null, undefined, { exec, snapshot: stableSnapshot })
    assert.deepEqual(calls.map((call) => call.resultKind), ['task'])
    assert.equal(run.scope, null)
  })

  it('自测类命令（不做收尾核对）：仍先分析，但不宣称越界不提交、实施不注入契约', async () => {
    const { exec, calls } = mockExec()
    await runAI({ localConfig: {} }, bugTask('cursor', { text: '自测：跑一下提现页的单测' }), workContext(), null, undefined, { exec, snapshot: stableSnapshot })
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
      runAI({ localConfig: {} }, bugTask('pi'), workContext(), null, undefined, { exec, snapshot }),
      /pi 分析阶段违反只读约束/,
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
    const task = bugTask('codex', { scopeApprovals: [{ paths: ['apps/web/src/neighbor.ts'], approvedBy: 'ou_x', at: '2026-10-11T00:00:00Z' }] })
    await runAI({ localConfig: { scopeBudgets: { bugfix: 80 } } }, task, workContext(), null, undefined, { exec, snapshot: stableSnapshot })
    assert.match(calls[0].promptText, /人工已确认扩大范围的文件（可信输入，必须列入 targets[^\n]*`apps\/web\/src\/neighbor\.ts`/)
    assert.match(calls[0].promptText, /改动行数参考 80 行.*不因行数 blocked/)
    assert.match(calls[1].promptText, / {2}- apps\/web\/src\/neighbor\.ts：人工确认扩大范围/)
    assert.match(calls[1].promptText, /改动行数参考 80 行/)
    // 11-04 b3 stuck（并进本条，测试棘轮）：阻塞被放行（全是 decision / 归属 / 规模）且分析 scope=null → 用结论里点名的文件补契约；
    // 系统层归属只作知会；分析提示只在正文带账号时出现账号取证块。
    {
    const analysis = { status: 'blocked', summary: '缺开关字段', applicableRules: [], requirements: [], scope: null, blockers: ['入口有两种做法（直接隐藏 / 点了提示），先按直接隐藏做，只改 apps/web/src/gift.tsx', '个人中心归 henry 负责，仓库规则不允许改别人负责的功能'] }
    const { exec, calls } = mockExec({ analysis })
    const run = await runAI({ localConfig: { envSites: { pre: 'https://pre.example.com' } } }, bugTask('claude'), workContext(), null, undefined, { exec, snapshot: stableSnapshot })
    assert.deepEqual(calls.map((call) => call.resultKind), ['analysis', 'task'])
    assert.deepEqual(run.scope.targets.map((item) => item.path), ['apps/web/src/gift.tsx'])
    assert.match(calls[1].promptText, /可改文件：\n {2}- apps\/web\/src\/gift\.tsx/)
    assert.match(calls[1].promptText, /归属只作知会：个人中心归 henry/)
    // 系统层（分析 / 实施共用）：业务仓的负责人分工只作知会（aven 11-04）
    assert.match(calls[0].systemPromptText, /归属只作知会：业务仓文档（含 CLAUDE\.md「按负责人改代码」）写的负责人只进 owner \/ followUps，不是停下的理由；转来的单就是交给你的，需求定边界，归属不明按 aven 的做。/)
    assert.match(calls[0].promptText, /blocker.*前文已问过、已答的不再问.*「照现成实现迁移（如 x9）」或「按 UI 稿做」时，源实现 \/ 稿就是规格/)
    assert.match(calls[0].promptText, /blocked 时能定出要改的文件也照填 scope（阻塞可能被放行）/)
    assert.doesNotMatch(calls[0].promptText, /上下文给了登录账号/)
    const { exec: exec2, calls: calls2 } = mockExec()
    await runAI({ localConfig: { envSites: { pre: 'https://pre.example.com' } } }, bugTask('claude', { text: '状态不对\n\n【补料】\n自己登录进去看看，这个是账号： a@b.com Test1234' }), workContext(), null, undefined, { exec: exec2, snapshot: stableSnapshot })
    assert.match(calls2[0].promptText, /上下文给了登录账号.*打 pre https:\/\/pre\.example\.com/)
    // 真不放行（hard）时 scope 不补：照旧 blocked 返回
    const { exec: exec3, calls: calls3 } = mockExec({ analysis: { ...analysis, blockers: ['缺 pre 测试账号，没法复现 apps/web/src/gift.tsx'] } })
    const blocked = await runAI({ localConfig: {} }, bugTask('claude'), workContext(), null, undefined, { exec: exec3, snapshot: stableSnapshot })
    assert.deepEqual([calls3.length, blocked.scope, blocked.result.status], [1, null, 'blocked'])
    // 分析本来就 ready（没经放行）却没给 scope：不替它补（照旧按缺契约收尾）
    const { exec: exec4 } = mockExec({ analysis: readyAnalysis({ scope: null, summary: '只改 apps/web/src/x.ts' }) })
    assert.equal((await runAI({ localConfig: {} }, bugTask('claude'), workContext(), null, undefined, { exec: exec4, snapshot: stableSnapshot })).scope, null)
    assert.deepEqual(scopeFromAnalysisText({ status: 'blocked', summary: '暂停', blockers: ['只改 src/a/Chat.tsx'], requirements: ['同步 docs/x.md'] }).targets.map((item) => item.path), ['src/a/Chat.tsx', 'docs/x.md'])
    assert.deepEqual([scopeFromAnalysisText({ status: 'blocked', summary: '缺接口', blockers: ['后端没给字段'] }), scopeFromAnalysisText(null)], [null, null])
    for (const [text, want] of [
      ['自己登录进去看看，这个是账号： [734343862@qq.com](mailto:734343862@qq.com) Test1234', true],
      ['請嘗試郵箱登入 郵箱：kegocel106@airhemp.com 密碼：123qwe', true],
      ['手機號登入 Account：+86 15661234567 PWD：123qwe', true],
      ['联系 a@b.com 问一下进度', false],
      ['登录页报错', false],
      ['', false],
    ]) assert.equal(hasLoginCredentials(text), want, text)
    const probe = buildCredentialProbeBlock({ envSites: { pre: 'https://pre.example.com', online: 'https://www.example.com', test: '' } })
    assert.match(probe, /打 pre https:\/\/pre\.example\.com、online https:\/\/www\.example\.com（.*只发 GET，登录拿态的 POST（含验证码登录）除外；不注册、不发帖评论、不下单改数据/)
    assert.match(probe, /不再把「缺 Network 证据 \/ 缺账号 \/ 请对方抓包」写成 blocker.*账号密码不写进任何给人看的字段/)
    assert.match(buildCredentialProbeBlock(), /本仓没配环境地址，测不了就写明/)
    const withCreds = { id: 't', attachments: [], chatId: 'oc', text: '状态不对\n账号：a@b.com 密码：x1' }
    assert.doesNotMatch(buildAnalysisPrompt(workContext(), withCreds, null, { scopeEnforced: false }), /上下文给了登录账号/)
    }
  })
})
