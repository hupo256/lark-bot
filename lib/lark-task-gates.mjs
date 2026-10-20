/**
 * 完成态核验闸注册表（第 2 批）：runTask 里原来 120 行内联的 lint / git 身份 / 终检 / 规则扫描 / done 可信度 / 范围契约，
 * 收成一张按顺序跑的表。证据（改动文件 / diff 规模 / numstat）只采一次，各闸读同一份。
 * 每道闸：{ name, owner, addedAt, applies(ctx), check(ctx) }，check 返回 { ok:true, warnNotes?, audit? }
 * 或 { ok:false, status, text, reason, extra?, audit? }（第一道 hard 失败即短路）。
 * 防膨胀：__tests__/lark-task-gates.test.mjs 锁死注册表长度与元数据——新增一道闸必须合并或删一道旧的。
 */

import { buildCodeRulesBlockedResult, codeRuleErrorsInDiff, runCodeRulesScan } from './lark-code-rules.mjs'
import { runFinalVerification } from './lark-final-verification.mjs'
import { allowsDocsOnlyDone, assessDoneResult, buildQualityBlockedResult, enforceCodeQuality } from './lark-quality-gate.mjs'
import { docArchiveDirs } from './lark-doc-archive.mjs'
import { repoProfileForTask, resolveScopeBudgets } from './lark-repo-profile.mjs'
import { resolveScopeGate } from './lark-scope-contract.mjs'
import { buildNeedsReviewResult, buildVerificationFailedResult } from './lark-worker-results.mjs'
import { gitAt, inspectWorktreeIdentity } from './lark-worker-git.mjs'
import { resolveWorkKind } from './lark-work-policy.mjs'
import { prepareRootTools } from './lark-worktree-deps.mjs'

const defaultDeps = {
  enforceCodeQuality,
  inspectWorktreeIdentity,
  prepareRootTools,
  runFinalVerification,
  runCodeRulesScan,
  assessDoneResult,
  resolveScopeGate,
  gitAt,
}

// 证据一次采齐：lint 闸之后（enforceCodeQuality 已 `git add -A -N`，新增文件也进 diff）。
export const collectEvidence = ({ cwd, readOnly, git = gitAt }) => {
  if (readOnly) return { readOnly: true, changedFiles: [], changeStat: '', numstat: '' }
  const changedFiles = (git(cwd, ['diff', '--name-only', 'HEAD']).stdout || '').split('\n').map((line) => line.trim()).filter(Boolean)
  const changeStat = (git(cwd, ['diff', '--shortstat', 'HEAD']).stdout || '').trim()
  const numstat = git(cwd, ['diff', '--numstat', 'HEAD']).stdout || ''
  return { readOnly: false, changedFiles, changeStat, numstat }
}

const fail = (status, text, reason, extra = {}) => ({ ok: false, status, text, reason, ...extra })

export const VERIFY_GATES = [
  {
    name: 'lint',
    owner: 'worker',
    addedAt: '2026-10-05',
    // 状态查询是严格只读：不跑会 `git add -N` / 触发纠正 AI 的规范闸。
    applies: (ctx) => !ctx.workContext.readOnly,
    async check(ctx) {
      const gate = await ctx.deps.enforceCodeQuality(ctx.workerConfig, ctx.task, ctx.workContext, ctx.auditContext, ctx.signal)
      ctx.outputs.qualityGate = gate
      if (gate.hardRemaining.length) {
        // 失效裸色类硬闸：定向纠正后仍残留 → 不判 done（色类会被 Tailwind 静默丢弃，带病完成）。
        return fail('failed', buildQualityBlockedResult(ctx.task, gate.hardRemaining), `规范硬闸残留 ${gate.hardRemaining.length} 处`)
      }
      return { ok: true }
    },
  },
  {
    name: 'evidence',
    owner: 'worker',
    addedAt: '2026-10-17',
    applies: () => true,
    check(ctx) {
      const evidence = collectEvidence({ cwd: ctx.workContext.cwd, readOnly: Boolean(ctx.workContext.readOnly), git: ctx.deps.gitAt })
      ctx.evidence = evidence
      ctx.outputs.actualChangedFiles = evidence.changedFiles
      ctx.outputs.changeStat = evidence.changeStat
      return { ok: true }
    },
  },
  {
    name: 'identity.stable',
    owner: 'worker',
    addedAt: '2026-10-06',
    applies: (ctx) => !ctx.workContext.readOnly,
    check(ctx) {
      const identity = ctx.deps.inspectWorktreeIdentity({
        cwd: ctx.workContext.cwd,
        expectedBranch: ctx.executionIdentity?.branch,
        expectedHeadSha: ctx.executionIdentity?.headSha,
      })
      ctx.outputs.finalIdentity = identity
      if (!identity.ok) {
        return fail('failed', buildVerificationFailedResult({ task: ctx.task, cwd: ctx.workContext.cwd, receipt: { checks: [{ id: 'git-identity', ok: false, stderr: identity.problems.join('；') }] } }), `git 身份变了：${identity.problems.join('；')}`, { audit: { finalVerification: { status: 'failed', ok: false, identity } } })
      }
      return { ok: true }
    },
  },
  {
    name: 'env.verify',
    owner: 'worker',
    addedAt: '2026-10-06',
    applies: (ctx) => !ctx.workContext.readOnly,
    check(ctx) {
      const profile = repoProfileForTask(ctx.task)
      // 所有 AI 实施与规范纠正均已结束后再跑；回执覆盖的是将要提交的最终内容。
      if (ctx.evidence.changedFiles.length) ctx.deps.prepareRootTools(ctx.workContext.cwd, { installArgs: profile.installArgs })
      const receipt = ctx.deps.runFinalVerification({ cwd: ctx.workContext.cwd, changedFiles: ctx.evidence.changedFiles, finalChecks: profile?.finalChecks || null })
      ctx.outputs.workerVerification = receipt
      const audit = { finalVerification: { ...receipt, identity: ctx.outputs.finalIdentity || null } }
      if (!receipt.ok) return fail('failed', buildVerificationFailedResult({ task: ctx.task, receipt, cwd: ctx.workContext.cwd }), 'Worker 最终复验失败', { audit })
      return { ok: true, audit }
    },
  },
  {
    name: 'code-rules',
    owner: 'worker',
    addedAt: '2026-10-08',
    // 静态扫描只在真有改动时跑（零改动下面 done.trust 会判不可信，跑它没意义）。
    applies: (ctx) => !ctx.workContext.readOnly && ctx.evidence.changedFiles.length > 0,
    check(ctx) {
      const codeRules = ctx.deps.runCodeRulesScan({ cwd: ctx.workContext.cwd, base: ctx.workContext.baseRef })
      ctx.outputs.codeRules = codeRules
      if (!codeRules.ran) console.warn(`[lark-worker] ⚠ ${ctx.task.id} 规则扫描未跑成（不阻断）：${codeRules.reason}`)
      // 文件级归因硬闸：只有 error 级 finding 落在 bot 本次实测改动文件里才拦（存量债与 ran=false 不碰）。
      const hits = codeRuleErrorsInDiff({ summary: codeRules, changedFiles: ctx.evidence.changedFiles })
      if (hits.length) return fail('failed', buildCodeRulesBlockedResult(ctx.task, hits), `规则扫描 error ${hits.length} 处`, { audit: { codeRules } })
      return { ok: true, audit: { codeRules } }
    },
  },
  {
    name: 'done.trust',
    owner: 'worker',
    addedAt: '2026-10-07',
    applies: () => true,
    check(ctx) {
      const assessment = ctx.deps.assessDoneResult({
        reportedChangedFiles: ctx.aiRun.result.changedFiles,
        actualChangedFiles: ctx.evidence.changedFiles,
        checks: ctx.aiRun.result.checks,
        readOnly: Boolean(ctx.workContext.readOnly),
        // 修复/缺陷/需求类任务预期真改业务代码；只动测试文件=凑 diff 冒充完成，不可信。
        expectsCodeFix: ctx.expectsCode,
        // 只改文档报 done：对接答复 / 文档入库 / 清扫 / 等材料交办 / 落了待确认清单的放行，其余判不可信（aven 2026-10-20 review A9）。
        docsOnlyAllowed: allowsDocsOnlyDone({ task: ctx.task, result: ctx.aiRun.result }),
      })
      if (!assessment.trustworthy) return fail('failed', `${buildNeedsReviewResult(ctx.task)}\n附：${assessment.notes.join('；')}`, `done 不可信：${assessment.notes.join('；')}`)
      return { ok: true, warnNotes: assessment.notes }
    },
  },
  {
    name: 'scope',
    owner: 'worker',
    addedAt: '2026-10-11',
    applies: (ctx) => ctx.expectsCode,
    check(ctx) {
      const profile = repoProfileForTask(ctx.task)
      const scopeGate = ctx.deps.resolveScopeGate({
        task: ctx.task,
        scope: ctx.aiRun.scope,
        actualChangedFiles: ctx.evidence.changedFiles,
        numstat: ctx.evidence.numstat,
        workKind: resolveWorkKind(ctx.task),
        budgets: resolveScopeBudgets(profile, ctx.workerConfig.localConfig),
        exemptPrefixes: docArchiveDirs(profile), // 收件 + 答复目录同一份清单（aven 2026-10-20 review C8）
      })
      ctx.outputs.scopeGate = scopeGate
      const audit = { scopeCheck: scopeGate.check, scopeApprovals: ctx.task.scopeApprovals || [] }
      // 不通过 → 不提交、不回滚，挂起 waiting_confirmation：人回复「确认扩大范围」即走控制通道的续跑出口。
      if (scopeGate.blockedText) return fail('waiting_confirmation', scopeGate.blockedText, '范围契约核对不通过', { extra: { scopeRequest: scopeGate.scopeRequest }, audit })
      return { ok: true, warnNotes: scopeGate.warnNotes, audit }
    },
  },
]

// 跑完成态核验：按表顺序，第一道失败即返回；通过时 outputs 带各闸产出（qualityGate / workerVerification / codeRules / scopeGate …）。
export const runVerifyGates = async ({ task, workContext, aiRun, expectsCode, executionIdentity, workerConfig, auditContext, signal, deps = {}, gates = VERIFY_GATES }) => {
  const ctx = { task, workContext, aiRun, expectsCode, executionIdentity, workerConfig, auditContext, signal, deps: { ...defaultDeps, ...deps }, evidence: { readOnly: Boolean(workContext.readOnly), changedFiles: [], changeStat: '', numstat: '' }, outputs: { actualChangedFiles: [], changeStat: '', qualityGate: null, workerVerification: null, codeRules: null, scopeGate: null, finalIdentity: null } }
  const warnNotes = []
  const audit = {}
  const ran = []
  for (const gate of gates) {
    if (!gate.applies(ctx)) continue
    ran.push(gate.name)
    const outcome = await gate.check(ctx)
    if (outcome.audit) Object.assign(audit, outcome.audit)
    if (!outcome.ok) return { ok: false, gate: gate.name, status: outcome.status, text: outcome.text, reason: outcome.reason, extra: outcome.extra, audit: { ...audit, verifyGates: ran }, outputs: ctx.outputs }
    if (outcome.warnNotes?.length) warnNotes.push(...outcome.warnNotes)
  }
  return { ok: true, warnNotes, audit: { ...audit, verifyGates: ran }, outputs: ctx.outputs }
}
