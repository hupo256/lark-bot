/**
 * createTaskRunner 的运行期控制流（11-02）：用 deps 假件驱动真实 runner——网关 client 只记回写，AI / git / 闸 / 审计 / 定时器全是假件，
 * 真跑的是 runner 自己的判断：空任务、intake、开工前出口、WIP 改路由、running 回写、记忆软链、群回复补写、规范闸 / 终检 / 规则扫描 /
 * 可信度 / 范围契约、契约映射、提交闸（先落盘再报喜）、异常与 finally 兜底，以及 lark-runner-steps 的收尾提交器。
 * 一个 it 合并全部段（测试棘轮）；每段钉一条分支给变异扫描用（原先 14 条「runner 主体没有注入点」的豁免由此清掉）。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { eachCase, runSteps } from './support/steps.mjs'
import { createTaskRunner } from '../lib/lark-task-runner.mjs'
import { tempWorktreeContextFor } from '../lib/lark-work-context.mjs'

const SHA = 'a'.repeat(40)
const DIFF = 'd'.repeat(40)
const baseTask = (extra = {}) => ({ id: 'T1', epoch: 1, text: '修复：登录按钮点不动', commandType: 'fix', project: 'PR-0001', ...extra })
const hotfixCtx = (task = baseTask(), extra = {}) => ({ ...tempWorktreeContextFor(task), repoRoot: '/repo', ...extra })
const existingCtx = (extra = {}) => ({ cwd: '/w/PR-0001', projectId: 'PR-0001', projectName: 'PR-0001', projectDocs: [], readOnly: false, repoRoot: '/repo', ...extra })
const readOnlyCtx = (extra = {}) => ({ cwd: '/repo', projectId: 'PR-0001', projectName: 'PR-0001', projectDocs: [], readOnly: true, repoRoot: '/repo', ...extra })
const identity = (branch = 'feat/PR-0001') => ({ ok: true, root: '/w', branch, headSha: SHA, problems: [] })
const badIdentity = (problem) => ({ ok: false, root: '/w', branch: '', headSha: '', problems: [problem] })
const aiResult = (extra = {}) => ({ status: 'done', summary: '修好了', checks: ['biome'], changedFiles: ['src/a.ts'], warnings: [], ...extra })
const aiRun = (result, extra = {}) => ({ executor: 'claude', sessionId: 's1', result, scope: { targets: [{ path: 'src/a.ts' }] }, ...extra })
const verification = (extra = {}) => ({ ok: true, status: 'passed', fingerprint: { headSha: SHA, diffHash: DIFF }, checks: [{ id: 'biome', ok: true }], ...extra })
const violation = (kind) => ({ kind, file: 'src/a.ts', token: kind === 'invalid-color-class' ? 'text-green' : 'w-[3px]', line: 'x' })
const pick = (obj, keys) => Object.fromEntries(keys.map((key) => [key, obj?.[key]]))
const DIRTY_ROUTE = () => ({ ok: false, projectId: 'PR-0001', problems: ['x'] })

// 假网关：updateTask 只记参数并更新一份状态；getTask 按第几次读定制（取消 / 换代 / 网关改写 / 读不到 / 抛错）。
const fakeClient = ({ getTaskAt = {}, intake = { actionable: true } } = {}) => {
  const reports = []
  const intakeCalls = []
  const stored = { id: 'T1', status: 'running', result: null, epoch: 1 }
  let reads = 0
  const client = {
    updateTask: async (id, status, result, executor, epoch, owner, branch, extra) => {
      reports.push({ id, status, result, executor, epoch, owner, branch, extra })
      Object.assign(stored, { status, result })
      return { ok: true }
    },
    getTask: async () => {
      reads += 1
      const custom = getTaskAt[reads]
      if (typeof custom === 'function') return custom(stored)
      return custom === undefined ? { ...stored } : custom
    },
    resolveIntake: async (...args) => {
      intakeCalls.push(args)
      return intake
    },
    releaseTask: async () => true,
  }
  return { client, reports, intakeCalls }
}

// 假外部副作用：每个都记调用参数（calls[name]），按缺省或 over 里给的实现返回。
const fakeDeps = (over = {}) => {
  const calls = {}
  const audit = { jsonPath: null, logPath: null, record: {} }
  const patches = []
  const defaults = {
    createTaskAudit: () => audit,
    updateTaskAudit: (ctx, patch) => {
      if (!ctx) return
      patches.push(patch)
      Object.assign(ctx.record, patch)
    },
    preflightAiExecutor: () => {},
    selfHealHintFor: () => null,
    classifyTaskIntent: async () => ({ decision: 'bug' }),
    runAI: async () => ({ executor: 'claude', result: null }),
    runGroupReplyPass: async () => false,
    runPreExecutionGates: async () => false,
    prefetchTaskReferences: () => ({ audit: {}, notes: [], block: null }),
    worktreeState: () => 'clean',
    inspectWorktreeIdentity: ({ expectedBranch }) => identity(expectedBranch || 'feat/PR-0001'),
    prepareTempWorktree: () => {},
    finalizeTempWorktree: () => ({ ok: true, committed: true, reason: null }),
    finalizeExistingWorktree: () => ({ ok: true, committed: true, reason: null }),
    gitAt: (cwd, args) => ({ status: 0, stdout: args[1] === '--name-only' ? 'src/a.ts\n' : args[1] === '--shortstat' ? ' 1 file changed, 3 insertions(+)\n' : '3\t0\tsrc/a.ts\n' }),
    revertLockfileDrift: () => [],
    validateWorkContextRoute: () => ({ ok: true, projectId: 'PR-0001', problems: [] }),
    inspectWorkingTreeFingerprint: () => ({ ok: true, problems: [] }),
    runFinalVerification: () => verification(),
    enforceCodeQuality: async () => ({ ok: true, remaining: [], hardRemaining: [], softRemaining: [] }),
    runCodeRulesScan: () => ({ ran: true, ok: true, errorFindings: [] }),
    prepareRootTools: () => {},
    stopVerifyServer: () => {},
    runEvidenceFor: () => null,
    ensureSharedClaudeMemory: () => ({ ok: true, linked: true }),
    defaultClaudeMemoryDir: () => null,
    monitorExecutionCancellation: () => () => {},
    startLeaseHeartbeat: () => () => {},
    handleTaskFailure: async ({ reportStatus, error, collectEvidence, onFail }) => {
      collectEvidence?.()
      await reportStatus('failed', `处理失败。\n1. ${error.message}`)
      await onFail?.({ fingerprint: { cls: 'x' }, playbook: { action: 'fail' } })
      return { action: 'fail' }
    },
    logTaskException: () => {},
    maybeOpenSelfFix: () => ({ opened: false }),
    readFailureEvidence: () => ({ lines: [] }),
  }
  const record = (name, impl) => (...args) => {
    ;(calls[name] ||= []).push(args)
    return impl(...args)
  }
  const deps = Object.fromEntries(Object.entries({ ...defaults, ...over }).map(([name, impl]) => [name, record(name, impl)]))
  return { deps, calls, audit, patches }
}

const logs = { log: [], warn: [], error: [] }
const realConsole = { log: console.log, warn: console.warn, error: console.error }
const captureConsole = () => {
  for (const level of Object.keys(logs)) {
    logs[level] = []
    console[level] = (...args) => logs[level].push(args.map(String).join(' '))
  }
}
const restoreConsole = () => Object.assign(console, realConsole)
const logged = (level, text) => logs[level].some((line) => line.includes(text))

// 跑一个任务：返回网关回写清单（reports / statuses / last）、各假件的调用参数（calls）、审计记录与补丁。
const run = async ({ task = baseTask(), workContext, client = {}, deps = {}, config = {}, signal } = {}) => {
  const ctx = workContext || hotfixCtx(task)
  const gateway = fakeClient(client)
  const fakes = fakeDeps(typeof deps === 'function' ? deps() : deps)
  const runTask = createTaskRunner({ client: gateway.client, workerConfig: { localConfig: config }, deps: fakes.deps })
  await runTask(task, ctx, signal ? { signal } : {})
  return { ...gateway, ...fakes, task, ctx, statuses: gateway.reports.map((item) => item.status), last: gateway.reports.at(-1) }
}
const doneRun = ({ deps = {}, ...rest } = {}) => run({ deps: { runAI: async () => aiRun(aiResult()), ...(typeof deps === 'function' ? deps() : deps) }, ...rest })
const commitOf = (r) => r.patches.findLast((patch) => patch.commit)?.commit
const COMMIT_FAILED_TAIL = (cwd, reason) => `\n\n⛔ 但改动未能提交到分支，故不按已完成处理。\n1. 任务：修复：登录按钮点不动；\n2. 原因：${reason}；\n3. 改动仍在 ${cwd} 的工作区里（现场已保留，未删除、未重置）；\n4. 请人工进入该目录检查并手动提交；确认无价值可直接丢弃。`

describe('createTaskRunner 运行期控制流（deps 注入）', () => {
  it('空任务 / intake / 开工前出口 / WIP 改路由 / running 回写 / 记忆软链 / 群回复补写 / 闸与终检 / 范围契约 / 契约映射与提交闸 / 异常与 finally 兜底', () => runSteps([
    ['空任务：没正文也没附件直接 failed、不建审计；只有附件或只有正文都照常开工（attachments 缺省当空数组）', async () => {
      const empty = await run({ task: baseTask({ text: '  ' }) })
      assert.deepEqual(empty.statuses, ['failed'])
      assert.equal(empty.last.result, '处理失败。\n1. 这条 Lark 任务内容为空；\n2. 请重新 @ 应用并写清需要处理的事项。')
      assert.equal(empty.calls.createTaskAudit, undefined)
      const withAttachment = await run({ task: baseTask({ text: '', attachments: [{ type: 'image' }] }) })
      assert.equal(withAttachment.calls.createTaskAudit.length, 1)
      assert.equal(withAttachment.statuses[0], 'running')
      const textOnly = await run()
      assert.equal(textOnly.statuses[0], 'running')
    }],
    ['preflight 失败：普通任务回 failed（技术失败文案），intake 任务改走 resolveIntake error；审计记 failed', async () => {
      const plain = await run({ deps: { preflightAiExecutor: () => { throw new Error('claude CLI 不可用：exit 1') } } })
      assert.deepEqual(plain.statuses, ['failed'])
      assert.match(plain.last.result, /claude CLI 不可用/)
      assert.equal(plain.patches[0].status, 'failed')
      assert.equal(plain.patches[0].error, 'claude CLI 不可用：exit 1')
      assert.equal(plain.calls.runAI, undefined)
      const intake = await run({ task: baseTask({ intake: { required: true } }), deps: { preflightAiExecutor: () => { throw new Error('坏了') } } })
      assert.deepEqual(intake.statuses, [])
      assert.deepEqual(intake.intakeCalls, [['T1', { epoch: 1, error: '坏了' }]])
    }],
    ['intake 分类：结果交 resolveIntake，actionable → queued_after_intake、否则 ignored；分类器拿到的是合成信号（退出信号中止它也中止）', async () => {
      let seenSignal = null
      const controller = new AbortController()
      const queued = await run({ task: baseTask({ intake: { required: true } }), signal: controller.signal, deps: { classifyTaskIntent: async (cfg, task, audit, signal) => { seenSignal = signal; return { decision: 'bug', confidence: 'high' } } } })
      assert.deepEqual(queued.intakeCalls, [['T1', { epoch: 1, classification: { decision: 'bug', confidence: 'high' } }]])
      assert.equal(queued.audit.record.status, 'queued_after_intake')
      assert.deepEqual(queued.audit.record.intake, { decision: 'bug', confidence: 'high' })
      assert.deepEqual(queued.statuses, [], '分类阶段不回写状态、不跑 AI')
      assert.equal(queued.calls.runAI, undefined)
      assert.ok(seenSignal instanceof AbortSignal && seenSignal !== controller.signal, '合成信号（截止 + 退出），不是原样透传')
      assert.equal(seenSignal.aborted, false)
      controller.abort(new Error('shutdown'))
      assert.equal(seenSignal.aborted, true, '退出信号 abort 时合成信号同步中止')
      const ignored = await run({ task: baseTask({ intake: { required: true } }), client: { intake: { actionable: false } } })
      assert.equal(ignored.audit.record.status, 'ignored')
      // 11-03 静态 review R7：分类中被并入补充，网关把这轮结果作废放回重分类（retried + reclassify）→ 审计记 intake_retry，不记 ignored
      const reclassify = await run({ task: baseTask({ intake: { required: true } }), client: { intake: { actionable: false, retried: true, reclassify: true } } })
      assert.equal(reclassify.audit.record.status, 'intake_retry')
    }],
    ['intake 分类失败：瞬时失败网关放回待分类（intake_retry + 告警），用完次数 intake_failed；退出中断不回写', async () => {
      const retried = await run({ task: baseTask({ intake: { required: true } }), client: { intake: { retried: true, task: { intake: { retries: 1, notBefore: '2026-11-02T10:00:00Z' } } } }, deps: { classifyTaskIntent: async () => { throw new Error('rate limited') } } })
      assert.deepEqual(retried.intakeCalls, [['T1', { epoch: 1, error: 'rate limited' }]])
      assert.equal(retried.audit.record.status, 'intake_retry')
      assert.equal(retried.audit.record.error, 'rate limited')
      assert.ok(logged('warn', '分类失败（rate limited），第 1 次自动重试排在 2026-11-02T10:00:00Z'), `告警：${logs.warn}`)
      captureConsole()
      const failed = await run({ task: baseTask({ intake: { required: true } }), client: { intake: { retried: false } }, deps: { classifyTaskIntent: async () => { throw new Error('bad') } } })
      assert.equal(failed.audit.record.status, 'intake_failed')
      assert.equal(logged('warn', '自动重试'), false)
      const shutdown = new AbortController()
      shutdown.abort(new Error('SIGTERM'))
      const aborted = await run({ task: baseTask({ intake: { required: true } }), signal: shutdown.signal, deps: { classifyTaskIntent: async () => { throw new Error('aborted') } } })
      assert.deepEqual(aborted.intakeCalls, [], '退出中断：任务已交还队列，不写 intake 结果')
    }],
    ['开工前出口：runPreExecutionGates 返回 true 就停，不看 worktree、不回写；返回 false 才继续', async () => {
      const stopped = await run({ deps: { runPreExecutionGates: async () => true } })
      assert.deepEqual(stopped.statuses, [])
      assert.equal(stopped.calls.worktreeState, undefined)
      assert.equal(stopped.calls.runPreExecutionGates[0][0].executor, 'claude')
      const continued = await run({ workContext: existingCtx() })
      assert.equal(continued.calls.worktreeState.length, 1)
    }],
    ['WIP 改路由：命中已有 worktree 且脏才改到隔离分支（基线 = 该分支 HEAD，审计留 reroutedFrom）；hotfix / 只读 / 干净都不改', () => eachCase([
      { name: '已有 worktree 脏 → 改路由', ctx: existingCtx(), state: 'dirty', rerouted: true },
      { name: 'hotfix 上下文脏也不改（本来就是隔离分支）', ctx: hotfixCtx(), state: 'dirty', rerouted: false },
      { name: '只读脏不改', ctx: readOnlyCtx(), state: 'dirty', rerouted: false },
      { name: '已有 worktree 干净不改', ctx: existingCtx(), state: 'clean', rerouted: false },
    ], async ({ ctx, state, rerouted }) => {
      const r = await run({ workContext: ctx, deps: { worktreeState: () => state } })
      const isolated = tempWorktreeContextFor(baseTask())
      const audited = r.audit.record.workContext
      if (rerouted) {
        assert.deepEqual(pick(audited, ['cwd', 'projectId', 'hotfixBranch', 'baseRef', 'sourceBranch', 'sourceWorktree', 'reroutedFrom', 'reroutedFromWorktree', 'reroutedFromBranch', 'reroutedFromHeadSha']), { cwd: isolated.cwd, projectId: 'PR-0001', hotfixBranch: isolated.hotfixBranch, baseRef: SHA, sourceBranch: 'feat/PR-0001', sourceWorktree: '/w/PR-0001', reroutedFrom: 'preexisting-wip', reroutedFromWorktree: '/w/PR-0001', reroutedFromBranch: 'feat/PR-0001', reroutedFromHeadSha: SHA })
        assert.deepEqual(r.calls.prepareTempWorktree, [[{ path: isolated.cwd, branch: isolated.hotfixBranch, baseRef: SHA }]])
        assert.deepEqual(r.calls.inspectWorktreeIdentity.map(([args]) => args), [{ cwd: '/w/PR-0001' }, { cwd: isolated.cwd, expectedBranch: isolated.hotfixBranch }])
        assert.equal(r.calls.runPreExecutionGates[0][0].workContext, ctx, '开工前出口看的还是原上下文')
        assert.ok(logged('warn', `有未提交 WIP，基于 feat/PR-0001@${SHA.slice(0, 12)} 改到隔离 worktree ${isolated.cwd}（分支 ${isolated.hotfixBranch}）`))
      } else {
        assert.equal(audited.reroutedFrom, undefined)
        assert.equal(audited.cwd, ctx.cwd)
        assert.equal(audited.hotfixBranch, ctx.hotfixBranch || null)
        assert.equal(r.calls.prepareTempWorktree?.length || 0, ctx.hotfixBranch ? 1 : 0)
      }
    })],
    ['WIP 改路由锁不住基线 → failed 说明未动 worktree；审计 failed；不准备隔离 worktree', async () => {
      const r = await run({ workContext: existingCtx(), deps: { worktreeState: () => 'dirty', inspectWorktreeIdentity: () => badIdentity('detached HEAD') } })
      assert.deepEqual(r.statuses, ['failed'])
      assert.equal(r.last.result, '处理失败。\n1. WIP 隔离前无法锁定项目分支基线：detached HEAD\n2. 为保护现有 WIP，Worker 未创建隔离分支、未触碰项目 worktree。')
      assert.equal(r.patches[0].status, 'failed')
      assert.equal(r.calls.prepareTempWorktree, undefined)
    }],
    ['WIP 改路由后完成：结果提醒改动落在隔离分支、要 cherry-pick 回原分支；原分支名读不到就说「你的工作分支」', async () => {
      const named = await doneRun({ workContext: existingCtx(), deps: { worktreeState: () => 'dirty' } })
      assert.deepEqual(named.statuses, ['running', 'done'])
      const isolated = tempWorktreeContextFor(baseTask())
      assert.ok(named.last.result.includes(`⚠ 任务开始时你的 worktree 有未提交改动，为不碰你的现场，本次从 feat/PR-0001@${SHA.slice(0, 12)} 创建隔离分支 \`${isolated.hotfixBranch}\`（完全没动你的工作区）；发布前需把它 cherry-pick / merge 回 feat/PR-0001`), named.last.result)
      assert.deepEqual(named.calls.finalizeTempWorktree[0][0], { path: isolated.cwd, branch: isolated.hotfixBranch, baseRef: SHA, task: named.task, allowCommit: true })
      // 运行配置 commitPrefix 透传到收尾提交（业务仓 commit-msg 钩子，11-03 falive 回放）；没配就不带这个键
      const prefixed = await doneRun({ workContext: existingCtx(), config: { commitPrefix: 'feat(bot)' }, deps: { worktreeState: () => 'dirty' } })
      assert.equal(prefixed.calls.finalizeTempWorktree[0][0].commitPrefix, 'feat(bot)')
      const unnamed = await doneRun({ workContext: existingCtx(), deps: { worktreeState: () => 'dirty', inspectWorktreeIdentity: ({ expectedBranch }) => identity(expectedBranch || '') } })
      assert.ok(unnamed.last.result.includes(`本次从 你的工作分支@${SHA.slice(0, 12)} 创建隔离分支`), unnamed.last.result)
      assert.ok(unnamed.last.result.includes('merge 回 你的工作分支'))
      const blocked = await run({ workContext: existingCtx(), deps: { worktreeState: () => 'dirty', runAI: async () => aiRun({ status: 'blocked', summary: '缺材料', blockers: ['要 PRD'] }) } })
      assert.equal(blocked.last.result.includes('隔离分支'), false, '非完成态不提示')
    }],
    ['隔离 worktree 准备失败 → failed 带项目号；finally 读不到最终状态时审计 unknown、仍以 allowCommit=false 收尾（收尾结果进审计）', async () => {
      const r = await run({ client: { getTaskAt: { 1: () => { throw new Error('网关挂了') } } }, deps: { prepareTempWorktree: () => { throw new Error('origin/online 拉不下来') }, finalizeTempWorktree: () => ({ ok: false, committed: false, reason: '删不掉' }) } })
      assert.deepEqual(r.statuses, ['failed'])
      assert.equal(r.last.result, '处理失败。\n1. 项目 PR-0001 需要准备隔离临时 worktree；\n2. origin/online 拉不下来')
      assert.ok(logged('error', '收尾时无法读取最终状态，按未完成保留可能的半成品：网关挂了'))
      assert.equal(r.audit.record.error, '读取最终状态失败：网关挂了')
      assert.equal(r.audit.record.status, 'unknown')
      assert.equal(r.audit.record.gateway, undefined)
      assert.deepEqual(r.calls.finalizeTempWorktree, [[{ path: r.ctx.cwd, branch: r.ctx.hotfixBranch, baseRef: undefined, task: r.task, allowCommit: false }]])
      assert.deepEqual(pick(commitOf(r), ['mode', 'ok', 'reason', 'committed', 'identity', 'fingerprint']), { mode: 'none', ok: false, reason: '删不掉', committed: false, identity: null, fingerprint: null })
      assert.equal(logged('error', '已置 done 但收尾提交失败'), false, '不是 done 的收尾失败不按「卡片已发出」告警')
    }],
    ['路由 / git 身份校验失败走异常路径：任务仍 running 且非退出中断才进失败剧本（带旁证闭包与自修开关）；已取消 / 退出中断只记审计', async () => {
      const route = await run({ deps: { validateWorkContextRoute: () => ({ ok: false, projectId: 'PR-0001', problems: ['项目不一致'] }) } })
      assert.deepEqual(route.statuses, ['failed'])
      assert.equal(route.last.result, '处理失败。\n1. 任务路由一致性校验失败：项目不一致')
      const failure = route.calls.handleTaskFailure[0][0]
      assert.equal(failure.enabled, true)
      assert.equal(failure.error.message, '任务路由一致性校验失败：项目不一致')
      assert.deepEqual(route.calls.readFailureEvidence[0][0], { cwd: route.ctx.cwd, sinceHeadSha: undefined, phase: undefined, readOnly: false })
      assert.deepEqual(pick(route.calls.maybeOpenSelfFix[0][0], ['enabled', 'fingerprint']), { enabled: true, fingerprint: { cls: 'x' } })
      assert.ok(route.patches.some((patch) => patch.status === 'failed' && patch.error === '任务路由一致性校验失败：项目不一致'))
      assert.deepEqual(route.calls.logTaskException[0][0].outcome, { action: 'fail' })
      assert.equal(route.calls.finalizeTempWorktree[0][0].allowCommit, false)
      assert.equal(route.audit.record.status, 'failed')
      const ident = await run({ config: { selfHeal: { playbook: false, selfFix: false } }, deps: { inspectWorktreeIdentity: () => badIdentity('分支不对') } })
      assert.equal(ident.calls.handleTaskFailure[0][0].error.message, 'worktree 身份校验失败：分支不对')
      assert.equal(ident.calls.handleTaskFailure[0][0].enabled, false)
      assert.equal(ident.calls.maybeOpenSelfFix[0][0].enabled, false)
      assert.equal(ident.calls.readFailureEvidence[0][0].sinceHeadSha, '')
      const readOnly = await run({ workContext: readOnlyCtx(), deps: { validateWorkContextRoute: DIRTY_ROUTE } })
      assert.equal(readOnly.calls.inspectWorktreeIdentity, undefined, '只读不校验 git 身份')
      assert.equal(readOnly.calls.readFailureEvidence[0][0].readOnly, true)
      const cancelled = await run({ client: { getTaskAt: { 1: { status: 'cancelled', epoch: 1 } } }, deps: { validateWorkContextRoute: DIRTY_ROUTE } })
      assert.equal(cancelled.calls.handleTaskFailure, undefined, '网关里已不是 running：不发失败卡')
      assert.ok(cancelled.patches.some((patch) => patch.status === 'cancelled' && patch.error === '任务路由一致性校验失败：x'))
      const shutdown = new AbortController()
      shutdown.abort(new Error('SIGTERM'))
      const aborted = await run({ signal: shutdown.signal, deps: { validateWorkContextRoute: DIRTY_ROUTE } })
      assert.equal(aborted.calls.handleTaskFailure, undefined, '退出中断：任务已交还队列，不写 failed')
      assert.ok(aborted.patches.some((patch) => patch.status === 'failed' && patch.error === '任务路由一致性校验失败：x'), '审计仍按 failed 记')
    }],
    ['预取阻塞：设计稿 / 文档读不到停在实施前，waiting_confirmation 带结构化 outcome；预取审计与备注照记；不跑 AI', async () => {
      const block = { summary: '设计稿读不到', blockers: ['figma.com/x 403'], nextStep: '补权限' }
      const r = await run({ deps: { prefetchTaskReferences: () => ({ audit: { figma: { ok: false } }, notes: ['Figma 设计稿 1 份没读到'], block }) } })
      assert.deepEqual(r.statuses, ['waiting_confirmation'])
      assert.equal(r.last.executor, 'claude')
      assert.deepEqual(pick(r.last.extra.outcome, ['kind', 'summary', 'blockers', 'nextStep']), { kind: 'worker', summary: '设计稿读不到', blockers: ['figma.com/x 403'], nextStep: '补权限' })
      assert.equal(r.last.result, '需人工确认 / 补充材料后才能继续。\n1. 设计稿读不到\n2. 待补充：figma.com/x 403')
      assert.deepEqual(r.audit.record.figma, { ok: false })
      assert.ok(logged('log', 'T1 Figma 设计稿 1 份没读到'))
      assert.equal(r.calls.runAI, undefined)
      assert.deepEqual(r.calls.prefetchTaskReferences[0][0], { task: r.task, readOnly: false, outDir: r.ctx.cwd }, '没有审计日志路径时预取落在任务目录')
      assert.equal(r.audit.record.gateway.result, r.last.result)
    }],
    ['running 回写带目标分支：隔离分支 / 已有 worktree 当前分支 / 只读 null；审计记路由校验与 git 身份；取消轮询参数；AI 前检出换代就不烧 AI', async () => {
      const hotfix = await run()
      const branch = hotfix.ctx.hotfixBranch
      assert.deepEqual(pick(hotfix.reports[0], ['status', 'executor', 'branch', 'epoch', 'result']), { status: 'running', executor: 'claude', branch, epoch: 1, result: undefined })
      assert.deepEqual(hotfix.calls.inspectWorktreeIdentity[0][0], { cwd: hotfix.ctx.cwd, expectedBranch: branch })
      const routed = hotfix.patches.find((patch) => patch.workContext?.routeValidation)
      assert.deepEqual(pick(routed.workContext, ['cwd', 'projectId', 'hotfixBranch', 'baseRef', 'sourceBranch', 'sourceWorktree']), { cwd: hotfix.ctx.cwd, projectId: 'PR-0001', hotfixBranch: branch, baseRef: null, sourceBranch: null, sourceWorktree: null })
      assert.deepEqual(pick(routed.workContext.gitIdentity, ['ok', 'branch']), { ok: true, branch })
      assert.equal(hotfix.task.aiExecutor, 'claude')
      assert.deepEqual(pick(hotfix.calls.monitorExecutionCancellation[0][0], ['taskId', 'claimedEpoch', 'intervalMs']), { taskId: 'T1', claimedEpoch: 1, intervalMs: 1000 })
      assert.equal(hotfix.calls.startLeaseHeartbeat[0][0].task, hotfix.task)
      assert.equal(hotfix.calls.runAI[0][2], hotfix.ctx)
      const existing = await run({ workContext: existingCtx() })
      assert.deepEqual(pick(existing.reports[0], ['status', 'branch']), { status: 'running', branch: 'feat/PR-0001' })
      assert.deepEqual(existing.calls.inspectWorktreeIdentity[0][0], { cwd: '/w/PR-0001', expectedBranch: undefined })
      const ro = await run({ workContext: readOnlyCtx() })
      assert.deepEqual(pick(ro.reports[0], ['status', 'branch']), { status: 'running', branch: null })
      assert.equal(ro.calls.inspectWorktreeIdentity, undefined)
      const superseded = await run({ client: { getTaskAt: { 1: { status: 'running', epoch: 2 } } } })
      assert.deepEqual(superseded.statuses, ['running'])
      assert.equal(superseded.calls.runAI, undefined)
      assert.ok(superseded.patches.some((patch) => patch.status === 'superseded_midrun' && patch.supersededPhase === 'AI 执行'))
      assert.equal(superseded.calls.finalizeTempWorktree[0][0].allowCommit, false)
      assert.ok(logged('log', '在「AI 执行」前检出已被取消/换代（status=running epoch=2 vs 领取时 1）'))
    }],
    ['项目记忆软链：配置 claudeMemoryDir（缺省按主仓推导）且 cwd 不是主仓才软链；linked 记日志、失败告警、没目录静默', () => eachCase([
      { name: '配置了目录 + 隔离 worktree → 软链', config: { claudeMemoryDir: '/m' }, ctx: hotfixCtx(), expect: '/m' },
      { name: '没配置 → 按主仓推导', config: {}, defaultDir: '/dm', ctx: hotfixCtx(), expect: '/dm' },
      { name: '推导不到 → 不软链', config: {}, ctx: hotfixCtx(), expect: null },
      { name: 'cwd 就是主仓 → 不软链', config: { claudeMemoryDir: '/m' }, ctx: readOnlyCtx(), expect: null },
      { name: '没 memory 目录静默', config: { claudeMemoryDir: '/m' }, ctx: hotfixCtx(), shared: { ok: false, reason: 'no memory dir' }, expect: '/m', warn: false },
      { name: '软链失败告警', config: { claudeMemoryDir: '/m' }, ctx: hotfixCtx(), shared: { ok: false, reason: 'EACCES' }, expect: '/m', warn: true },
    ], async ({ config, defaultDir = null, ctx, shared = { ok: true, linked: true }, expect, warn = false }) => {
      const r = await run({ workContext: ctx, config, deps: { defaultClaudeMemoryDir: () => defaultDir, ensureSharedClaudeMemory: () => shared } })
      assert.deepEqual(r.calls.ensureSharedClaudeMemory?.map(([args]) => args) || [], expect ? [{ cwd: ctx.cwd, memoryDir: expect }] : [])
      if (config.claudeMemoryDir) assert.equal(r.calls.defaultClaudeMemoryDir, undefined, '配置了就不推导')
      else assert.deepEqual(r.calls.defaultClaudeMemoryDir[0][0], { repoRoot: '/repo' })
      assert.equal(logged('warn', '项目记忆软链失败：'), warn)
      if (warn) assert.ok(logged('warn', '项目记忆软链失败：EACCES'))
      assert.equal(logged('log', '项目记忆已软链到主仓 memory'), Boolean(expect && shared.linked))
    }, { before: captureConsole })],
    ['群回复补写：result 在且群里回过「收到」才续会话补写（attachments 缺省空数组、带 readOnly 与审计日志路径）；没回过 / 没结果不补', async () => {
      const acked = await doneRun({ task: baseTask({ ackedInGroup: true }), config: { envSites: { pre: 'x' } } })
      const [args] = acked.calls.runGroupReplyPass[0]
      assert.deepEqual(pick(args, ['cwd', 'attachments', 'readOnly', 'auditLogPath', 'localConfig']), { cwd: acked.ctx.cwd, attachments: [], readOnly: false, auditLogPath: null, localConfig: { envSites: { pre: 'x' } } })
      assert.equal(args.task, acked.task)
      assert.equal(args.aiRun.result.status, 'done')
      assert.ok(args.signal instanceof AbortSignal)
      const notAcked = await doneRun()
      assert.equal(notAcked.calls.runGroupReplyPass, undefined)
      const noResult = await run({ task: baseTask({ ackedInGroup: true, attachments: [{ type: 'image' }] }) })
      assert.equal(noResult.calls.runGroupReplyPass, undefined)
    }],
    ['AI 退出没回写结果 → failed 待人工复核；网关已不是 running（取消 / 换代）就不再回写；网关已 done 的遗漏路径走兜底规范闸 + finally 收尾告警', async () => {
      const none = await run()
      assert.deepEqual(none.statuses, ['running', 'failed'])
      assert.equal(none.last.result, '处理失败。\n1. 任务：修复：登录按钮点不动；\n2. AI 已执行结束但未显式回写完成结果，无法确认改动是否成功或已验证；\n3. 需人工查看 Worker/AI 日志与分支改动后再定，禁止按已完成处理。')
      assert.equal(none.last.extra, undefined)
      assert.ok(none.patches.some((patch) => patch.status === 'failed' && patch.gateway?.result === none.last.result))
      assert.equal(none.calls.enforceCodeQuality, undefined)
      assert.equal(none.calls.finalizeTempWorktree[0][0].allowCommit, false)
      const cancelled = await run({ client: { getTaskAt: { 2: { status: 'cancelled', epoch: 1 } } } })
      assert.deepEqual(cancelled.statuses, ['running'])
      assert.equal(cancelled.calls.enforceCodeQuality, undefined)
      const orphanDone = await run({ client: { getTaskAt: { 2: { status: 'done', epoch: 1 }, 3: { status: 'done', epoch: 1, result: 'x' } } }, deps: { enforceCodeQuality: async () => ({ ok: false, remaining: [violation('arbitrary-value')], hardRemaining: [], softRemaining: [] }) } })
      assert.deepEqual(orphanDone.statuses, ['running'])
      assert.equal(orphanDone.calls.enforceCodeQuality.length, 1)
      assert.equal(orphanDone.task.qualityNote, '含 1 处未修正规范问题（arbitrary value / 失效色类），需人工处理')
      assert.ok(logged('error', '规范闸残留'))
      assert.ok(logged('error', '已置 done 但收尾提交失败（卡片已发出，无法降级）：提交前缺少已通过的 Worker 最终复验指纹'))
      assert.equal(orphanDone.calls.finalizeTempWorktree, undefined)
      assert.deepEqual(orphanDone.calls.inspectWorktreeIdentity.at(-1)[0], { cwd: orphanDone.ctx.cwd, expectedBranch: orphanDone.ctx.hotfixBranch, expectedHeadSha: SHA }, '按网关 done 收尾时先校验提交前身份')
      assert.deepEqual(pick(orphanDone.audit.record.gateway, ['status', 'result']), { status: 'done', result: 'x' })
    }],
    ['完成态主线（隔离分支）：规范闸 → 实测清单 → 终检 → 规则扫描 → 可信度 → 范围核对 → 提交前再查取消 → 收尾提交 → 才回写 done；实测栏 / 终检行 / 契约段 / 提醒都进结果', async () => {
      const soft = violation('arbitrary-value')
      const r = await run({
        config: { finalChecks: { typeCheck: true }, verify: { probeCommand: 'node p.mjs' } },
        client: { getTaskAt: { 4: { status: 'result_pending_receipt', epoch: 1, result: '网关改写' } } },
        deps: {
          runAI: async () => aiRun(aiResult({ changedFiles: [], owner: '前端' }), { ruleContext: { warnings: ['规则 X 章节缺失'] } }),
          enforceCodeQuality: async () => ({ ok: false, remaining: [soft], hardRemaining: [], softRemaining: [soft] }),
          revertLockfileDrift: () => ['pnpm-lock.yaml'],
          runCodeRulesScan: () => ({ ran: false, reason: '扫描器缺失' }),
        },
      })
      const { cwd, hotfixBranch: branch } = r.ctx
      assert.deepEqual(r.statuses, ['running', 'done'])
      assert.equal(r.calls.enforceCodeQuality.length, 1)
      assert.deepEqual(r.calls.gitAt.map(([dir, args]) => [dir, args.join(' ')]), [[cwd, 'diff --name-only HEAD'], [cwd, 'diff --shortstat HEAD'], [cwd, 'diff --numstat HEAD']])
      assert.deepEqual(r.calls.revertLockfileDrift, [[cwd], [cwd]])
      assert.deepEqual(r.audit.record.lockfileDriftReverted, ['pnpm-lock.yaml', 'pnpm-lock.yaml'])
      assert.equal(logs.warn.filter((line) => line.includes('只有锁文件变了（依赖安装的漂移），已还原 pnpm-lock.yaml')).length, 2)
      assert.deepEqual(r.calls.inspectWorktreeIdentity.map(([args]) => args), [
        { cwd, expectedBranch: branch },
        { cwd, expectedBranch: branch, expectedHeadSha: SHA },
        { cwd, expectedBranch: branch, expectedHeadSha: SHA },
      ])
      assert.deepEqual(r.calls.prepareRootTools, [[cwd]])
      assert.deepEqual(r.calls.runFinalVerification[0][0], { cwd, changedFiles: ['src/a.ts'], finalChecks: { typeCheck: true } })
      assert.deepEqual(pick(r.audit.record.finalVerification, ['ok', 'status']), { ok: true, status: 'passed' })
      assert.deepEqual(r.audit.record.finalVerification.identity, identity(branch))
      assert.deepEqual(r.calls.runCodeRulesScan, [[{ cwd, base: undefined }]])
      assert.ok(logged('warn', '规则扫描未跑成（不阻断）：扫描器缺失'))
      assert.deepEqual(r.audit.record.codeRules, { ran: false, reason: '扫描器缺失' })
      assert.deepEqual(r.audit.record.scopeApprovals, [])
      assert.equal(r.audit.record.scopeCheck.ok, true)
      assert.deepEqual(r.calls.inspectWorkingTreeFingerprint, [[{ cwd, expectedHeadSha: SHA, expectedDiffHash: DIFF }]])
      assert.deepEqual(r.calls.stopVerifyServer, [[cwd]])
      assert.deepEqual(r.calls.finalizeTempWorktree, [[{ path: cwd, branch, baseRef: undefined, task: r.task, allowCommit: true }]])
      assert.deepEqual(pick(commitOf(r), ['mode', 'ok', 'committed', 'fingerprint']), { mode: 'auto', ok: true, committed: true, fingerprint: { ok: true, problems: [] } })
      assert.deepEqual(pick(r.calls.runEvidenceFor[0][0], ['cwd', 'verify']), { cwd, verify: { probeCommand: 'node p.mjs' } })
      const done = r.last
      assert.deepEqual(pick(done, ['executor', 'owner', 'epoch', 'branch']), { executor: 'claude', owner: '前端', epoch: 1, branch: undefined })
      assert.deepEqual(pick(done.extra, ['noChangeReason', 'scopeRequest']), { noChangeReason: undefined, scopeRequest: null })
      assert.deepEqual(pick(done.extra.outcome, ['kind', 'summary', 'owner', 'change', 'changedFiles', 'aiStatus']), { kind: 'ai', summary: '修好了', owner: '前端', change: { committed: true, gate: null, reason: null }, changedFiles: ['src/a.ts'], aiStatus: 'done' })
      assert.deepEqual(done.extra.outcome.warnings, ['规则 X 章节缺失', 'AI 漏报改动文件：src/a.ts', '含 1 处未修正规范问题（arbitrary value 等），需人工确认'])
      assert.equal(r.task.qualityNote, '含 1 处未修正规范问题（arbitrary value 等），需人工确认')
      const lines = done.result.split('\n')
      assert.deepEqual(lines.slice(0, 3), ['已完成，待发布。', '1. 修好了', '⚠ 规则 X 章节缺失；AI 漏报改动文件：src/a.ts；含 1 处未修正规范问题（arbitrary value 等），需人工确认'])
      assert.ok(done.result.includes('修改范围契约：\n· 契约目标（1）：\n'), '契约段')
      assert.ok(done.result.includes('**系统实测**：实测改动 1 处（1 file changed, 3 insertions(+)） · Figma 核验 不涉及'))
      assert.ok(done.result.endsWith(`**Worker 终检**：biome ✓ · diff ${DIFF.slice(0, 12)}`))
      assert.deepEqual(r.patches.find((patch) => patch.gateway?.status === 'result_pending_receipt'), { status: 'result_pending_receipt', gateway: { status: 'result_pending_receipt', result: '网关改写' } }, '网关改写后的状态与结果进审计')
      assert.equal(r.audit.record.status, 'done')
      assert.equal(logged('error', '收尾提交失败'), false)
    }],
    ['完成态按上下文分派：命中已有 worktree 定向提交实测清单（scoped，失败不提交）；只读完成不进闸不提交不加实测栏；代答 / 实测契约（answerLike）不进闸不提交；契约 change 照常进闸', async () => {
      const scoped = await doneRun({ task: baseTask({ figmaSpec: { referencesFigma: true, specs: [1, 2] } }), workContext: existingCtx() })
      assert.deepEqual(scoped.statuses, ['running', 'done'])
      assert.deepEqual(scoped.calls.finalizeExistingWorktree, [[{ cwd: '/w/PR-0001', task: scoped.task, taskPaths: ['src/a.ts'] }]])
      assert.equal(scoped.calls.finalizeTempWorktree, undefined)
      assert.equal(scoped.calls.revertLockfileDrift, undefined, '不是隔离 worktree 不还原锁文件漂移')
      assert.deepEqual(pick(commitOf(scoped), ['mode', 'committed']), { mode: 'scoped', committed: true })
      assert.ok(scoped.last.result.includes('**系统实测**：实测改动 1 处（1 file changed, 3 insertions(+)） · Figma 核验 ✓ 已落盘设计稿 2 处'))
      assert.deepEqual(scoped.last.extra.outcome.change, { committed: true, gate: null, reason: null })
      assert.equal(scoped.calls.stopVerifyServer, undefined, '没配 verify 就没起过页面验证服务')
      const scopedFail = await doneRun({ workContext: existingCtx(), deps: { enforceCodeQuality: async () => ({ ok: false, remaining: [violation('invalid-color-class')], hardRemaining: [violation('invalid-color-class')], softRemaining: [] }) } })
      assert.deepEqual(scopedFail.statuses, ['running', 'failed'])
      assert.equal(scopedFail.calls.finalizeExistingWorktree, undefined, '失败不往人类分支写半成品')
      assert.deepEqual(pick(commitOf(scopedFail), ['mode', 'ok', 'committed', 'reason']), { mode: 'none', ok: true, committed: false, reason: '未完成，不往已有分支写半成品' })
      const ro = await doneRun({ workContext: readOnlyCtx() })
      assert.deepEqual(ro.statuses, ['running', 'done'])
      for (const name of ['gitAt', 'runCodeRulesScan', 'runFinalVerification', 'prepareRootTools', 'finalizeTempWorktree', 'finalizeExistingWorktree', 'inspectWorkingTreeFingerprint']) assert.equal(ro.calls[name], undefined, `${name} 只读不该调`)
      assert.equal(ro.calls.enforceCodeQuality, undefined, '只读完成不跑兜底规范闸（11-02：原来在主仓 git add -N）')
      assert.equal(ro.last.result, '查询完成。\n1. 修好了')
      assert.deepEqual(pick(ro.last.extra.outcome, ['change', 'changedFiles']), { change: null, changedFiles: null })
      assert.deepEqual(pick(commitOf(ro), ['mode', 'committed', 'reason']), { mode: 'none', committed: false, reason: '只读任务不提交' })
      assert.equal(ro.audit.record.scopeCheck, undefined, '只读不核契约')
      const answer = await doneRun({ task: baseTask({ contract: { deliverable: 'verification', expectsCode: false, readOnly: false } }), workContext: hotfixCtx(baseTask(), { singlePass: true }) })
      assert.deepEqual(answer.statuses, ['running', 'done'])
      // 点名 online、本轮只打了 pre（aven 11-02）：结论前明说测错了环境，自称通过的降成待验证
      const sites = { pre: 'https://www.azmgb.com', online: 'https://www.fameex.com' }
      const envReport = { subject: '登录', answer: null, items: [{ mark: 'ok', name: '登录', note: '200', evidence: 'pre' }] }
      const wrongEnv = await doneRun({
        task: baseTask({ contract: { deliverable: 'verification', expectsCode: false, readOnly: false }, envTargets: ['online'] }),
        workContext: hotfixCtx(baseTask(), { singlePass: true }),
        config: { envSites: sites },
        deps: { runAI: async () => aiRun(aiResult({ changedFiles: [], report: envReport })), runEvidenceFor: () => ({ probeCalls: 1, browserCalls: 0, hosts: ['www.azmgb.com'] }) },
      })
      assert.equal(wrongEnv.last.extra.outcome.report.answer, '⚠ 这次实际测的是 pre，不是你说的 online，下面的结论不代表 online。')
      assert.equal(wrongEnv.last.extra.outcome.report.items[0].mark, 'unverified')
      assert.equal(answer.calls.enforceCodeQuality, undefined, 'answerLike 不进闸，也不跑兜底闸')
      assert.equal(answer.calls.gitAt, undefined)
      assert.equal(answer.calls.inspectWorkingTreeFingerprint, undefined)
      assert.deepEqual(pick(answer.last.extra.outcome, ['change', 'changedFiles', 'report']), { change: null, changedFiles: null, report: { subject: null, answer: '修好了', items: [] } })
      assert.equal(answer.last.result.includes('**系统实测**'), false, '实测契约不附代码实测栏')
      // 11-02：answerLike 收尾不提交、只清临时 worktree，不再告警「缺终检指纹」
      assert.equal(logged('error', '已置 done 但收尾提交失败'), false)
      assert.deepEqual(answer.calls.finalizeTempWorktree.map(([args]) => args.allowCommit), [false])
      assert.equal(commitOf(answer).mode, 'none', '实测契约按「不提交」模式收尾（假件的返回值原样进审计）')
      const change = await doneRun({ task: baseTask({ contract: { deliverable: 'change', expectsCode: true, readOnly: false } }) })
      assert.equal(change.calls.enforceCodeQuality.length, 1, '契约 change 照常进闸')
      assert.deepEqual(change.last.extra.outcome.change, { committed: true, gate: null, reason: null })
      assert.equal(change.calls.finalizeTempWorktree[0][0].allowCommit, true)
    }],
    ['完成态被闸拦下各自 failed（summary 取第一句实质内容、隔离 worktree 以 allowCommit=false 收尾）：规范硬闸 / git 身份 / 终检 / 规则扫描 / 不可信', () => eachCase([
      { name: '失效裸色类硬闸', deps: { enforceCodeQuality: async () => ({ ok: false, remaining: [violation('invalid-color-class')], hardRemaining: [violation('invalid-color-class')], softRemaining: [] }) }, head: '处理失败。\n1. 任务：修复：登录按钮点不动；\n2. 改动引入 1 处失效裸色类（Tailwind 会静默丢弃、根本不生效），定向纠正后仍残留，不能按已完成处理；', summary: '1. 任务：修复：登录按钮点不动；', notCalled: ['gitAt', 'runFinalVerification'], log: '规范硬闸拦截（失效色类）：\n1. [invalid-color-class] src/a.ts：`text-green`' },
      { name: '终检前 git 身份变了', deps: { inspectWorktreeIdentity: ({ expectedBranch, expectedHeadSha }) => (expectedHeadSha ? badIdentity('HEAD 变了') : identity(expectedBranch)) }, head: '处理失败。\n1. 任务：修复：登录按钮点不动；\n2. Worker 对最终内容的独立终检未通过，未提交、未按完成处理；\n3. 失败项：git-identity: HEAD 变了；', summary: '1. 任务：修复：登录按钮点不动；', notCalled: ['runFinalVerification', 'prepareRootTools'], finalVerification: { status: 'failed', ok: false } },
      { name: '终检失败', deps: { runFinalVerification: () => verification({ ok: false, status: 'failed', checks: [{ id: 'tsc', ok: false, stderr: 'TS2322' }] }) }, head: '处理失败。\n1. 任务：修复：登录按钮点不动；\n2. Worker 对最终内容的独立终检未通过，未提交、未按完成处理；\n3. 失败项：tsc: TS2322；', summary: '1. 任务：修复：登录按钮点不动；', notCalled: ['runCodeRulesScan'], log: 'Worker 最终复验失败：tsc ✗ · diff dddddddddddd', finalVerification: { status: 'failed', ok: false } },
      { name: '规则扫描命中本次改动文件的 error', deps: { runCodeRulesScan: () => ({ ran: true, ok: false, errorFindings: [{ ruleId: 'R1', file: 'src/a.ts', line: 3 }, { ruleId: 'R2', file: 'src/z.ts', line: 1 }] }) }, head: '⛔ T1 规则扫描：本次改动文件命中 1 处 error 级违规，不判 done（改坏的代码不该静默进分支）。\n- R1 src/a.ts:3\n', summary: '⛔ T1 规则扫描：本次改动文件命中 1 处 error 级违规，不判 done（改坏的代码不该静默进分支）。', notCalled: [], log: '规则扫描硬闸拦截（本次改动命中 error）' },
      { name: 'done 但零改动不可信', deps: { gitAt: () => ({ status: 0, stdout: '' }) }, head: '处理失败。\n1. 任务：修复：登录按钮点不动；\n2. AI 已执行结束但未显式回写完成结果', summary: '1. 任务：修复：登录按钮点不动；', tail: '\n附：AI 报告 done 但工作区无任何改动（git diff HEAD 为空），无法确认已真正修复，需人工复核', notCalled: ['runCodeRulesScan', 'prepareRootTools'] },
    ], async ({ deps, head, summary, tail = null, notCalled, log = null, finalVerification = null }) => {
      const r = await doneRun({ deps })
      assert.deepEqual(r.statuses, ['running', 'failed'])
      assert.ok(r.last.result.startsWith(head), `结果头：${r.last.result}`)
      if (tail) assert.ok(r.last.result.endsWith(tail), `结果尾：${r.last.result}`)
      assert.deepEqual(pick(r.last, ['executor', 'owner']), { executor: 'claude', owner: undefined })
      assert.deepEqual(pick(r.last.extra.outcome, ['kind', 'summary', 'change']), { kind: 'worker', summary, change: null })
      for (const name of notCalled) assert.equal(r.calls[name], undefined, `${name} 不该调`)
      assert.ok(r.patches.some((patch) => patch.status === 'failed' && patch.gateway?.result === r.last.result))
      if (log) assert.ok(logged('error', log), `日志：${logs.error}`)
      if (finalVerification) assert.deepEqual(pick(r.audit.record.finalVerification, ['status', 'ok']), finalVerification)
      assert.deepEqual(r.calls.finalizeTempWorktree.map(([args]) => args.allowCommit), [false])
      assert.equal(r.calls.inspectWorkingTreeFingerprint, undefined)
      assert.equal(r.audit.record.status, 'failed')
    })],
    ['范围契约（只对会改代码的任务）：越界挂起 waiting_confirmation 带待批准请求、不提交；超行数按 numstat 口径只提醒不拦（11-04）；expectsCode=false 不核；实施阶段自停的 blockers 转待批准请求', async () => {
      const out = await run({ deps: { runAI: async () => aiRun(aiResult(), { scope: { targets: [{ path: 'src/b.ts' }] } }) } })
      assert.deepEqual(out.statuses, ['running', 'waiting_confirmation'])
      assert.deepEqual(pick(out.last, ['executor', 'owner']), { executor: 'claude', owner: null })
      assert.match(out.last.result, /^需人工复核：改动超出修改范围契约，未提交。/)
      assert.ok(out.last.result.includes('· 实测越界（1）：'))
      assert.deepEqual(out.last.extra.scopeRequest.paths, ['src/a.ts'])
      assert.deepEqual(pick(out.last.extra.outcome, ['kind', 'summary', 'blockers', 'nextStep']), { kind: 'worker', summary: '改动超出了分析阶段定下的范围，没提交', blockers: ['src/a.ts'], nextStep: '确认可以改这些文件就回「确认扩大范围」，我接着做' })
      assert.deepEqual(out.audit.record.scopeCheck.outOfScope, ['src/a.ts'])
      assert.ok(out.patches.some((patch) => patch.status === 'waiting_confirmation' && patch.gateway?.result === out.last.result))
      assert.equal(out.calls.finalizeTempWorktree[0][0].allowCommit, false)
      assert.equal(out.calls.inspectWorkingTreeFingerprint, undefined)
      assert.ok(logged('error', '范围契约核对不通过，未提交，挂起待人工确认扩大范围'))
      const over = await doneRun({ task: baseTask({ scopeApprovals: [{ paths: ['src/x.ts'] }] }), deps: { runAI: async () => aiRun(aiResult()), gitAt: (cwd, args) => ({ status: 0, stdout: args[1] === '--numstat' ? '500\t0\tsrc/a.ts\n' : args[1] === '--name-only' ? 'src/a.ts\n' : '' }) } })
      assert.deepEqual(over.statuses, ['running', 'done'])
      assert.deepEqual(over.audit.record.scopeCheck.overBudget, { limit: 120, actual: 500 })
      assert.match(over.last.result, /改动 500 行，超过缺陷修复参考规模 120 行（不含 lockfile 与文案 json），请重点复核/)
      assert.deepEqual(over.audit.record.scopeApprovals, [{ paths: ['src/x.ts'] }])
      const noCode = await doneRun({ task: baseTask({ contract: { deliverable: 'change', expectsCode: false, readOnly: false } }), deps: { runAI: async () => aiRun(aiResult(), { scope: null }) } })
      assert.deepEqual(noCode.statuses, ['running', 'done'])
      assert.equal(noCode.audit.record.scopeCheck, undefined)
      assert.equal(noCode.last.result.includes('修改范围契约'), false)
      const selfStop = await run({ deps: { runAI: async () => aiRun({ status: 'waiting_confirmation', summary: '要动契约外文件', blockers: ['需要改 src/c.ts 才能修'] }) } })
      assert.deepEqual(selfStop.statuses, ['running', 'waiting_confirmation'])
      assert.equal(selfStop.last.result, '需人工确认 / 补充材料后才能继续。\n1. 要动契约外文件\n2. 待补充：需要改 src/c.ts 才能修\n如确认可以改上述契约外文件（src/c.ts），回复本卡片「确认扩大范围」即并入修改范围续跑。')
      assert.deepEqual(pick(selfStop.last.extra.scopeRequest, ['paths', 'source']), { paths: ['src/c.ts'], source: 'implementation' })
      assert.equal(selfStop.calls.enforceCodeQuality, undefined, '非完成态不进闸')
      const roStop = await run({ workContext: readOnlyCtx(), deps: { runAI: async () => aiRun({ status: 'waiting_confirmation', summary: '要动契约外文件', blockers: ['需要改 src/c.ts 才能修'] }) } })
      assert.equal(roStop.last.extra.scopeRequest, null)
      assert.equal(roStop.last.result.includes('确认扩大范围'), false)
    }],
    ['契约映射：代答 blocked 按契约映射成 done（answer 兜底）；提交前检出换代：不提交、不回写、allowCommit=false 收尾', async () => {
      const answer = await run({ task: baseTask({ contract: { deliverable: 'answer', expectsCode: false, readOnly: true } }), workContext: readOnlyCtx(), deps: { runAI: async () => aiRun({ status: 'blocked', summary: '没这个 uid', blockers: ['查不到 uid'] }) } })
      assert.deepEqual(answer.statuses, ['running', 'done'])
      assert.equal(answer.last.result, '已阻塞，需外部材料 / 权限后才能继续。\n1. 没这个 uid\n2. 待补充：查不到 uid', '文本结果仍按 AI 状态渲染（审计 / 旧卡）')
      assert.deepEqual(pick(answer.last.extra.outcome, ['report', 'blockers', 'aiStatus']), { report: { subject: null, answer: '没这个 uid', items: [{ mark: 'not_done', name: '查不到 uid', note: '', evidence: 'none' }] }, blockers: [], aiStatus: 'blocked' })
      const superseded = await doneRun({ client: { getTaskAt: { 3: { status: 'superseded', epoch: 1 } } } })
      assert.deepEqual(superseded.statuses, ['running'])
      assert.ok(superseded.patches.some((patch) => patch.status === 'superseded_midrun' && patch.supersededPhase === '提交'))
      assert.deepEqual(superseded.calls.finalizeTempWorktree.map(([args]) => args.allowCommit), [false])
      assert.equal(superseded.calls.inspectWorkingTreeFingerprint, undefined)
      assert.ok(logged('log', '在「提交」前检出已被取消/换代（status=superseded epoch=1 vs 领取时 1）'))
    }],
    ['提交闸：收尾提交失败就地降级 failed，结果附提交失败说明，outcome.change 记 gate=commit 与原因（截 300 字）', () => eachCase([
      { name: '终检回执没指纹', deps: { runFinalVerification: () => verification({ fingerprint: { headSha: SHA } }) }, reason: '提交前缺少已通过的 Worker 最终复验指纹', finalized: 0 },
      { name: '提交前 git 身份变了', deps: () => { let n = 0; return { inspectWorktreeIdentity: ({ expectedBranch }) => (n++ === 2 ? badIdentity('有人提交了') : identity(expectedBranch)) } }, reason: '提交前 git 身份校验失败：有人提交了', finalized: 0 },
      { name: '工作树指纹漂移', deps: { inspectWorkingTreeFingerprint: () => ({ ok: false, problems: ['终检后工作树内容漂移'] }) }, reason: '提交前工作树指纹校验失败：终检后工作树内容漂移', finalized: 0 },
      { name: '隔离分支提交本身失败', deps: { finalizeTempWorktree: () => ({ ok: false, committed: false, reason: 'pre-commit 钩子红' }) }, reason: 'pre-commit 钩子红', finalized: 1 },
      { name: '提交失败没给原因', deps: { finalizeTempWorktree: () => ({ ok: false, committed: false }) }, reason: '', textReason: 'undefined', finalized: 1 },
      { name: '原因超长截 300 字', deps: { finalizeTempWorktree: () => ({ ok: false, committed: false, reason: 'x'.repeat(400) }) }, reason: 'x'.repeat(300), textReason: 'x'.repeat(400), finalized: 1 },
    ], async ({ deps, reason, textReason = reason, finalized }) => {
      const r = await doneRun({ deps })
      assert.deepEqual(r.statuses, ['running', 'failed'])
      assert.ok(r.last.result.startsWith('已完成，待发布。\n1. 修好了\n修改范围契约：\n· 契约目标（1）：\n  - src/a.ts\n· 同因搜索词：未给出\n· 兄弟位置：未给出\n**系统实测**：实测改动 1 处（1 file changed, 3 insertions(+)） · Figma 核验 不涉及\n**Worker 终检**：biome ✓ · diff '), `结果头：${r.last.result}`)
      assert.ok(r.last.result.endsWith(COMMIT_FAILED_TAIL(r.ctx.cwd, textReason)), `结果尾：${r.last.result}`)
      assert.deepEqual(pick(r.last.extra.outcome, ['kind', 'summary', 'change', 'changedFiles']), { kind: 'ai', summary: '修好了', change: { committed: false, gate: 'commit', reason }, changedFiles: ['src/a.ts'] })
      assert.ok(logged('error', `AI 判完成但收尾提交失败，降级为 failed：${textReason}`))
      assert.equal(commitOf(r).ok, false)
      assert.equal(commitOf(r).mode, 'auto')
      assert.deepEqual(r.calls.finalizeTempWorktree?.map(([args]) => args.allowCommit) || [], Array(finalized).fill(true), '收尾只发生一次，finally 不再收尾')
      assert.ok(r.patches.some((patch) => patch.gateway?.status === 'failed' && patch.gateway.result === r.last.result))
    })],
    ['非完成态直接回写：no_change_needed / blocked 不进闸、不提交，noChangeReason 随回写；网关改写后的状态与结果进审计；网关读不到就按本次回写记', async () => {
      const noChange = await run({ client: { getTaskAt: { 3: { status: 'result_pending_receipt', epoch: 1, result: '网关改写' } } }, deps: { runAI: async () => aiRun({ status: 'no_change_needed', summary: '后端问题', noChangeReason: 'not_frontend', nextStep: '转后端' }) } })
      assert.deepEqual(noChange.statuses, ['running', 'no_change_needed'])
      assert.equal(noChange.last.extra.noChangeReason, 'not_frontend')
      assert.equal(noChange.last.extra.outcome.aiStatus, 'no_change_needed')
      assert.equal(noChange.calls.enforceCodeQuality, undefined)
      assert.equal(noChange.calls.gitAt, undefined)
      assert.equal(noChange.calls.finalizeTempWorktree[0][0].allowCommit, false)
      assert.deepEqual(noChange.patches.find((patch) => patch.gateway?.result === '网关改写'), { status: 'result_pending_receipt', gateway: { status: 'result_pending_receipt', result: '网关改写' } })
      const gone = await run({ client: { getTaskAt: { 3: null, 4: null } }, deps: { runAI: async () => aiRun({ status: 'blocked', summary: '缺权限', blockers: ['要 Figma 权限'], owner: '设计' }) } })
      assert.deepEqual(gone.statuses, ['running', 'blocked'])
      assert.equal(gone.last.owner, '设计')
      assert.deepEqual(gone.patches.find((patch) => patch.gateway?.status === 'blocked'), { status: 'blocked', gateway: { status: 'blocked', result: gone.last.result } })
      assert.equal(gone.audit.record.status, 'blocked', 'finally 读不到网关状态就沿用审计里的')
      assert.equal(gone.audit.record.gateway.result, gone.last.result)
    }],
  ], { before: captureConsole, after: restoreConsole }))
})
