/**
 * Lark Worker 的单任务生命周期层：执行一个**已领取**的任务——preflight、临时/既有 worktree 准备、
 * AI 运行、规范硬闸 + done 可信度评估、按正确 epoch 回写 Gateway、审计与 worktree 收尾。
 * 用 createTaskRunner(deps) 注入 gateway client 与 workerConfig，避免全局闭包。
 */

import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'

import { COMMIT_MODES, resolveCommitMode } from './lark-commit-policy.mjs'
import { expectsCodeChange, requirementGate } from './lark-work-policy.mjs'
import { scopeRequestFromBlockers } from './lark-scope-contract.mjs'
import { tempWorktreeContextFor, validateWorkContextRoute } from './lark-work-context.mjs'
import { runSystemTask } from './lark-system-runner.mjs'
import { runVerifyGates } from './lark-task-gates.mjs'
import { isSystemTask } from './lark-system-tasks.mjs'
import { collectFailureEvidence, formatFailureEvidence } from './lark-failure-evidence.mjs'
import { buildSelfHealHint, decideFailurePlaybook, fingerprintFailure, formatFingerprintLine } from './lark-failure-fingerprint.mjs'
import { countRecentFingerprint, recordFailure, selfHealAttemptsForTask } from './lark-failure-ledger.mjs'
import { maybeOpenSelfFix } from './lark-self-fix.mjs'
import { listOutbox } from './lark-outbox.mjs'
import { formatStructuredAiResult, preflightAiExecutor, resolveAiExecutor } from './lark-ai-executor.mjs'
import { buildGateFailureReport, buildReportExtras, runEvidenceFor } from './lark-run-report.mjs'
import { gatewayStatusForAiStatus, isCompletedAiStatus } from './lark-status-meta.mjs'
import { createTaskAudit, updateTaskAudit } from './lark-worker-audit.mjs'
import {
  formatWorkerVerificationLine,
  inspectWorkingTreeFingerprint,
  runFinalVerification,
} from './lark-final-verification.mjs'
import {
  finalizeExistingWorktree,
  finalizeTempWorktree,
  removeTempWorktreeIfClean,
  inspectWorktreeIdentity,
  prepareTempWorktree,
  ensureIntegrationBranch,
  mergeIntoIntegration,
  deleteMergedTaskBranch,
  worktreeState,
} from './lark-worker-git.mjs'
import { classifyTaskIntent, runAI } from './lark-worker-run.mjs'
import { prefetchFigmaSpec, taskReferencesFigma } from './lark-figma.mjs'
import { prefetchLarkDocs, taskReferencesLarkDocs } from './lark-doc.mjs'
import { repoProfileForTask } from './lark-repo-profile.mjs'
import {
  appendPublicCompletionEvidence,
  buildCommitFailedResult,
  buildFailureResult,
  buildNeedsReviewResult,
  buildVerificationFailedResult,
} from './lark-worker-results.mjs'
import { schemaVerifyVerdict } from './lark-completion-rule.mjs'
import { archiveDocAttachments, buildDocIntakeText, changedDocPaths, discardUnsavedDocs, parseArchivedEntry, planDocIntakeCommit, restoreKeptDocs, shouldSkipDocSave } from './lark-doc-archive.mjs'
import { readableBranchAfterMerge, shouldUseIntegrationBranch } from './lark-task-finish.mjs'
import {
  ownerTableFor,
  claudeProjectKey,
  ensureSharedClaudeMemory,
  isExecutionSuperseded,
  monitorExecutionCancellation,
  DEFAULT_TASK_BUDGET_MS,
  LEASE_HEARTBEAT_DIVISOR,
  remainingTaskBudgetMs,
  isShutdownAbort,
  startLeaseHeartbeat,
} from './lark-task-runner-support.mjs'

export const createTaskRunner = ({ client, workerConfig, changeWatcher = null }) => {
  const { updateTask, getTask, resolveIntake } = client

  // 执行一个**已领取**的任务（领取由调度器/--once 完成）。workContext 由调用方算好传入。
  // 异常在内部吞掉并回写 failed，不向外抛（调度器里各任务并行 detached，抛出会变未捕获 rejection）。
  // signal：worker 优雅退出信号——abort 时底层 AI 子进程被中断，且本函数跳过 failed 回写（任务已被
  // 交还队列 queued+epoch++，那条 failed 会因 epoch 不匹配被 gateway 409 挡掉，此处主动跳过更干净）。
  const runTaskBody = async (task, workContext, { signal } = {}) => {
    // 回写统一带上领取时的 epoch（fencing token）：若本次领取已被租约回收/人工 retry 作废，
    // 迟到回写会被 Gateway 以 409 拒掉，不覆盖新一代执行的状态。
    const reportStatus = (status, result, executor, owner, branch, extra) =>
      updateTask(task.id, status, result, executor, task.epoch, owner, branch, extra)
    // 协作式取消回查：拉网关实时状态，检出本次执行已被人工结单(superseded)/换代即中止。
    // 关键用途是**提交前**回查——done 回写虽会因 epoch 被 409 挡掉，但代码在回写前已 commit，
    // 若不在此拦下，已取消任务仍会把改动提进分支。读状态失败不误判取消（返回 false 继续）。
    const supersededMidRun = async (phase) => {
      const current = await getTask(task.id).catch(() => null)
      if (!isExecutionSuperseded({ current, claimedEpoch: task.epoch })) return false
      console.log(`[lark-worker] ${task.id} 在「${phase}」前检出已被取消/换代（status=${current?.status} epoch=${current?.epoch} vs 领取时 ${task.epoch}），中止本次执行、跳过提交`)
      updateTaskAudit(auditContext, { status: 'superseded_midrun', supersededPhase: phase, supersededAt: new Date().toISOString() })
      return true
    }
    if (!task.text?.trim() && !(task.attachments || []).length) {
      await reportStatus('failed', '处理失败。\n1. 这条 Lark 任务内容为空；\n2. 请重新 @ 应用并写清需要处理的事项。')
      return
    }
    // 系统任务（日报等）：确定性链路，不经分类 / 分析 / 规范闸（lib/lark-system-runner.mjs）。
    if (isSystemTask(task)) {
      await reportStatus('running')
      await runSystemTask({ task, client, workerConfig, reportStatus })
      return
    }

    let selectedExecutor
    let auditContext
    try {
      selectedExecutor = resolveAiExecutor(workerConfig, task)
      auditContext = createTaskAudit({ workerConfig, task, workContext, executor: selectedExecutor })
      // 自愈环 2：这条任务若是自动重排队后重领的，把上次失败的类别喂给模型（runAI 追加到分析 / 实施提示末尾）。
      try {
        const priorSelfHeal = selfHealAttemptsForTask({ repo: repoProfileForTask(task)?.key, taskId: task.id })
        if (priorSelfHeal.length) {
          task.selfHealHint = buildSelfHealHint(priorSelfHeal)
          updateTaskAudit(auditContext, { selfHealAttempts: priorSelfHeal.map((item) => ({ at: item.at, cls: item.cls, reason: item.reason })) })
          console.log(`[lark-worker] ${task.id} 自愈重跑第 ${priorSelfHeal.length + 1} 次（上次：${priorSelfHeal.at(-1).label || priorSelfHeal.at(-1).cls}）`)
        }
      } catch (ledgerError) {
        console.warn(`[lark-worker] ${task.id} 读失败台账出错（忽略）：${String(ledgerError).slice(0, 120)}`)
      }
      preflightAiExecutor(selectedExecutor, {
        localConfig: workerConfig.localConfig,
        repoProfile: repoProfileForTask(task),
      })
    } catch (error) {
      updateTaskAudit(auditContext, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        completedAt: new Date().toISOString(),
      })
      if (task.intake?.required) {
        await resolveIntake(task.id, { epoch: task.epoch, error: error instanceof Error ? error.message : String(error) })
      } else {
        await reportStatus('failed', buildFailureResult(task, error))
      }
      return
    }

    // 前置意图分类是独立只读阶段：结束后由 Gateway 原子决定 queued / ignored / intake_failed，
    // 本次领取绝不继续准备 worktree 或执行代码。actionable 会在下一轮作为正式任务重新领取。
    if (task.intake?.required) {
      try {
        console.log(`[lark-worker] classifying task-mention ${task.id} via ${selectedExecutor}`)
        // 最近 7 天同一群的任务作为「主题候选」给分类器：判断本条是延续还是新主题（外部群才需要）。
        const candidates = task.repo
          ? (await client.listTasks()).filter((item) => item.chatId === task.chatId && item.id !== task.id && !['superseded', 'ignored'].includes(item.status) &&
              Date.now() - Date.parse(item.updatedAt || item.createdAt || 0) < 7 * 24 * 60 * 60_000)
              .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, 15)
          : []
        const classification = await classifyTaskIntent(workerConfig, task, auditContext, signal, { candidates })
        const outcome = await resolveIntake(task.id, { epoch: task.epoch, classification })
        updateTaskAudit(auditContext, {
          status: outcome.actionable ? 'queued_after_intake' : 'ignored',
          intake: classification,
          completedAt: new Date().toISOString(),
        })
      } catch (error) {
        if (!isShutdownAbort(signal)) {
          const message = error instanceof Error ? error.message : String(error)
          const outcome = await resolveIntake(task.id, { epoch: task.epoch, error: message }) // 瞬时失败 Gateway 会放回待分类（retried）
          updateTaskAudit(auditContext, { status: outcome?.retried ? 'intake_retry' : 'intake_failed', error: message, completedAt: new Date().toISOString() })
          if (outcome?.retried) console.warn(`[lark-worker] ⚠ ${task.id} 分类失败（${message.slice(0, 80)}），第 ${outcome.task?.intake?.retries} 次自动重试排在 ${outcome.task?.intake?.notBefore}`)
        }
      }
      return
    }

    console.log(`[lark-worker] claimed ${task.id} via ${selectedExecutor}: ${task.text}`)
    // 新需求放行闸（混合兜底）：只有「连自评材料都没有」的裸一句话新需求（未放行 + 无附件 + 正文极短）
    // 才在动 worktree、烧 AI 之前就停、回一张待确认卡——这种消息 AI 也只能空手，先问一句更省。
    // 有附件 / 正文有细节的新需求不再盲拦，放行到下面 runAI 由能读上下文的 AI 在只读分析阶段自评
    //（四种执行器同一阶段）。人补一句预期行为（回复卡片即可）就续跑。
    const gate = requirementGate(task)
    if (gate) {
      console.log(`[lark-worker] ${task.id} workKind=${gate.workKind}，等待人工确认预期行为（未执行 AI）`)
      updateTaskAudit(auditContext, {
        status: 'waiting_confirmation',
        workKind: gate.workKind,
        blockers: gate.blockers,
        completedAt: new Date().toISOString(),
      })
      await reportStatus(
        'waiting_confirmation',
        formatStructuredAiResult({
          status: 'waiting_confirmation',
          summary: `这条任务被判定为新需求而非缺陷反馈，已停在实施之前等待确认。${gate.nextStep}`,
          blockers: gate.blockers,
        }),
        selectedExecutor,
      )
      return
    }
    // 命中已有 worktree 且任务开始前该工作区已有人类未提交 WIP：**绝不自动提交人类的 WIP**
    //（那是他们没打算提交的活，混进 bot 的提交里会毁掉他们的工作现场）。改路由到隔离的临时 worktree，
    // 但隔离分支必须从该项目 worktree 当前分支的已提交 HEAD 创建，不能退回 origin/online；开发中的需求
    // 往往已经远离 online，退回会让 AI 看不到目标代码并误报「缺材料」。未提交 WIP 仍完全留在原工作区。
    // reroutedWip 记下原工作分支，供完成卡明确提示「改动落到了隔离分支、需 cherry-pick 回来」——
    // 否则卡片只显示 hotfix 分支名，容易被误读成改在原分支上（PR-02273 教训：撞上人 5s 后才 commit 的 WIP）。
    let reroutedWip = null
    if (!workContext.hotfixBranch && !workContext.readOnly && worktreeState(workContext.cwd) === 'dirty') {
      const sourceWorktree = workContext.cwd
      const sourceIdentity = inspectWorktreeIdentity({ cwd: sourceWorktree })
      if (!sourceIdentity.ok) {
        const reason = `WIP 隔离前无法锁定项目分支基线：${sourceIdentity.problems.join('；')}`
        updateTaskAudit(auditContext, { status: 'failed', error: reason, completedAt: new Date().toISOString() })
        await reportStatus('failed', `处理失败。\n1. ${reason}\n2. 为保护现有 WIP，Worker 未创建隔离分支、未触碰项目 worktree。`)
        return
      }
      const isolated = tempWorktreeContextFor(task, {
        baseRef: sourceIdentity.headSha,
        sourceBranch: sourceIdentity.branch,
        sourceWorktree,
      })
      console.warn(`[lark-worker] ⚠ ${task.id} 命中的已有 worktree ${sourceWorktree} 有未提交 WIP，基于 ${sourceIdentity.branch}@${sourceIdentity.headSha.slice(0, 12)} 改到隔离 worktree ${isolated.cwd}（分支 ${isolated.hotfixBranch}），不触碰你的 WIP`)
      workContext = isolated
      reroutedWip = { hotfixBranch: isolated.hotfixBranch, originalBranch: sourceIdentity.branch, sourceHeadSha: sourceIdentity.headSha }
      updateTaskAudit(auditContext, {
        workContext: {
          cwd: workContext.cwd,
          hotfixBranch: workContext.hotfixBranch,
          baseRef: workContext.baseRef,
          reroutedFrom: 'preexisting-wip',
          reroutedFromWorktree: sourceWorktree,
          reroutedFromBranch: sourceIdentity.branch,
          reroutedFromHeadSha: sourceIdentity.headSha,
        },
      })
    }
    console.log(`[lark-worker] routing ${task.id} → ${workContext.cwd}${workContext.hotfixBranch ? ` (临时 worktree ${workContext.hotfixBranch})` : ''}`)
    // 收尾提交只能发生一次：正常 done 路径在**发完成卡之前**主动调用（见 finalizeWork 注释），
    // 其余路径（失败/阻塞/异常）由 finally 兜底。此标记防止两处重复收尾。
    let finalized = false
    // Worker 开工时读取到的真实 git 身份。提交前必须仍是同一 root/branch/HEAD；否则说明任务执行期间
    // 有人切分支/提交，或 AI 绕过 Worker 自行提交，自动提交链立即失去独占性并 fail-closed。
    let executionIdentity = null
    // Worker 对所有 AI 修改和规范纠正后的最终工作树生成的终检回执。收尾提交前必须重新计算
    // HEAD + diffHash 并与它比较，避免异步取消回查期间同一路径被继续修改后提交未经终检的内容。
    let workerVerification = null
    // 本任务实测产生的改动清单（AI 跑完、规范闸之后测得）。收尾提交在命中人类已有 worktree 时按它
    // 定向提交（见 lark-commit-policy 的 scoped 口径），故必须声明在 finalizeWork 之外。
    let taskChangedPaths = []
    // 对接文档入库路径：AI 判 blocked / failed 时工作树里可能有半成品代码，提交只能限定在文档本身
    //（lark-worker-git.finalizeExistingWorktree 的 scoped 口径），绝不走临时 worktree 的全量 `git add -A`。
    let commitScopedPaths = null
    // 收尾提交并返回 { ok, committed, reason }。**必须在回写 done 之前调用**：
    // 曾经是先回写 done（Gateway 立刻发完成卡 + 回写 bug 表），再提交，提交失败只打一行 worker 日志——
    // 群里显示「已完成」而改动只躺在工作区，人按完成处理，下一次 retry/清理就把它带走了。
    // 现在提交失败会把任务降级成 failed，群里看到的「已完成」恒等于「改动已落到分支上」。
    const finalizeWork = ({ allowCommit }) => {
      if (finalized) return { ok: true, committed: false, reason: '已收尾' }
      finalized = true
      // 提交模式的唯一口径在 lark-commit-policy：只读 / 未完成 → none，隔离分支 → auto（全量），
      // 命中人类 worktree → scoped（只提交本任务实测清单）。这里只按模式分派，不再各自判条件。
      const { mode, reason } = resolveCommitMode({
        isolatedBranch: Boolean(workContext.hotfixBranch),
        readOnly: Boolean(workContext.readOnly),
        taskDone: Boolean(allowCommit),
      })
      let commitIdentity = null
      let commitFingerprint = null
      let outcome
      if (allowCommit && executionIdentity) {
        commitIdentity = inspectWorktreeIdentity({
          cwd: workContext.cwd,
          expectedBranch: executionIdentity.branch,
          expectedHeadSha: executionIdentity.headSha,
        })
        if (!commitIdentity.ok) {
          outcome = {
            ok: false,
            committed: false,
            reason: `提交前 git 身份校验失败：${commitIdentity.problems.join('；')}`,
          }
          updateTaskAudit(auditContext, { commit: { mode, identity: commitIdentity, fingerprint: null, ...outcome } })
          return outcome
        }
      }
      if (allowCommit && !workContext.readOnly) {
        if (!workerVerification?.ok || !workerVerification.fingerprint?.diffHash) {
          outcome = {
            ok: false,
            committed: false,
            reason: '提交前缺少已通过的 Worker 最终复验指纹',
          }
          updateTaskAudit(auditContext, { commit: { mode, identity: commitIdentity, fingerprint: null, ...outcome } })
          return outcome
        }
        commitFingerprint = inspectWorkingTreeFingerprint({
          cwd: workContext.cwd,
          expectedHeadSha: workerVerification.fingerprint.headSha,
          expectedDiffHash: workerVerification.fingerprint.diffHash,
        })
        if (!commitFingerprint.ok) {
          outcome = {
            ok: false,
            committed: false,
            reason: `提交前工作树指纹校验失败：${commitFingerprint.problems.join('；')}`,
          }
          updateTaskAudit(auditContext, { commit: { mode, identity: commitIdentity, fingerprint: commitFingerprint, ...outcome } })
          return outcome
        }
      }
      if (commitScopedPaths && mode !== COMMIT_MODES.none) {
        outcome = finalizeExistingWorktree({ cwd: workContext.cwd, task, taskPaths: commitScopedPaths, commitPrefix: repoProfileForTask(task).commitPrefix || 'lark task' })
        if (outcome.ok && outcome.committed && workContext.hotfixBranch) removeTempWorktreeIfClean({ path: workContext.cwd, repoRoot: workContext.repoRoot })
      } else if (workContext.hotfixBranch) {
        outcome = finalizeTempWorktree({
          path: workContext.cwd,
          branch: workContext.hotfixBranch,
          baseRef: workContext.baseRef,
          repoRoot: workContext.repoRoot,
          task,
          allowCommit: mode === COMMIT_MODES.auto,
          commitPrefix: repoProfileForTask(task).commitPrefix || 'lark hotfix',
        })
      } else if (mode === COMMIT_MODES.none) {
        // 命中已有 worktree：失败/阻塞一律不提交（不往你的活跃分支写半成品），改动留在工作区。
        outcome = { ok: true, committed: false, reason }
      } else {
        outcome = finalizeExistingWorktree({ cwd: workContext.cwd, task, taskPaths: taskChangedPaths, commitPrefix: repoProfileForTask(task).commitPrefix || 'lark task' })
      }
      updateTaskAudit(auditContext, { commit: { mode, identity: commitIdentity, fingerprint: commitFingerprint, ...outcome } })
      return outcome
    }
    // 集成分支（整改 #10）：仓库 profile 配了 integrationBranch 时，先把 aven 的工作分支同步进集成分支，
    // 新任务从集成分支的 tip 开（看得见之前 bot 的改动）；同步有冲突就退回从 baseRef 开并记下原因交人。
    let integration = null
    const integrationProfile = task.repo ? repoProfileForTask(task) : null
    if (shouldUseIntegrationBranch({ workContext, profile: integrationProfile, reroutedWip })) {
      const worktreePath = join(integrationProfile.worktreesDir, 'integration')
      const ensured = ensureIntegrationBranch({ root: workContext.repoRoot, integrationBranch: integrationProfile.integrationBranch, baseRef: integrationProfile.baseRef, worktreePath })
      integration = { branch: integrationProfile.integrationBranch, worktreePath, ...ensured }
      if (ensured.ok) {
        workContext.baseRef = integrationProfile.integrationBranch
        workContext.fetchBase = false
      } else {
        console.warn(`[lark-worker] ⚠ ${task.id} 集成分支不可用，改从 ${integrationProfile.baseRef} 开：${ensured.reason}`)
      }
      updateTaskAudit(auditContext, { integration })
    }
    try {
      if (workContext.hotfixBranch) {
        try {
          prepareTempWorktree({
            path: workContext.cwd,
            branch: workContext.hotfixBranch,
            baseRef: workContext.baseRef,
            repoRoot: workContext.repoRoot,
            fetchBase: workContext.fetchBase,
          })
        } catch (prepError) {
          await reportStatus('failed', `处理失败。\n1. 项目 ${workContext.projectId} 需要准备隔离临时 worktree；\n2. ${prepError.message}`)
          return
        }
      }

      const routeValidation = validateWorkContextRoute({ task, workContext })
      if (!routeValidation.ok) throw new Error(`任务路由一致性校验失败：${routeValidation.problems.join('；')}`)
      if (!workContext.readOnly) {
        executionIdentity = inspectWorktreeIdentity({
          cwd: workContext.cwd,
          expectedBranch: workContext.hotfixBranch || undefined,
        })
        if (!executionIdentity.ok) throw new Error(`worktree 身份校验失败：${executionIdentity.problems.join('；')}`)
      }
      updateTaskAudit(auditContext, {
        workContext: {
          ...(auditContext.record.workContext || {}),
          cwd: workContext.cwd,
          projectId: routeValidation.projectId,
          hotfixBranch: workContext.hotfixBranch || null,
          baseRef: workContext.baseRef || null,
          sourceBranch: workContext.sourceBranch || null,
          sourceWorktree: workContext.sourceWorktree || null,
          routeValidation,
          gitIdentity: executionIdentity,
        },
      })

      // Figma 预取（仅非只读实施任务）：任务正文引用了设计稿时，Worker 先用 figma-spec.mjs 把几何/标注
      // 确定性落盘到审计目录，注入 prompt 让 AI 必读（见 buildTaskPrompt）。读不到设计稿即 fail-closed——
      // 不烧 AI、回 waiting_confirmation，绝不让 AI 凭 Lark 截图硬做还报完成（PR-02172 教训）。
      if (!workContext.readOnly && taskReferencesFigma(task.text)) {
        const outDir = auditContext?.logPath ? dirname(auditContext.logPath) : workContext.cwd
        task.figmaSpec = prefetchFigmaSpec({ text: task.text, outDir })
        updateTaskAudit(auditContext, {
          figma: { urls: task.figmaSpec.urls, specs: task.figmaSpec.specs.map((s) => s.dir), ok: task.figmaSpec.ok },
        })
        if (!task.figmaSpec.ok) {
          console.warn(`[lark-worker] ⚠ ${task.id} 引用 Figma 但预取失败，停在实施前转人工：${task.figmaSpec.error}`)
          const waitText = formatStructuredAiResult({
            status: 'waiting_confirmation',
            summary: '任务引用了 Figma 设计稿，但 Worker 无法读取设计稿规格，已停在实施之前等待处理（避免凭截图硬做）。',
            blockers: [task.figmaSpec.error],
            nextStep: '确认 Figma 链接可访问、node-id 正确，且 Worker 已配置有效的 FIGMA_API_KEY 后重试。',
          })
          await reportStatus('waiting_confirmation', waitText, selectedExecutor)
          updateTaskAudit(auditContext, {
            status: 'waiting_confirmation',
            gateway: { status: 'waiting_confirmation', result: waitText },
            completedAt: new Date().toISOString(),
          })
          return
        }
      }

      // Lark 文档预取（仅非只读实施任务）：任务正文引用了 Lark PRD / Wiki 时，Worker 先用 lark-cli（宿主机
      // 有 user 凭证，沙箱没有）把文档正文抓成本地 markdown 落盘，注入 prompt 让 AI 必读（见 buildTaskPrompt）。
      // 读不到即 fail-closed——不烧 AI、回 waiting_confirmation，绝不让 AI 缺 PRD 硬做（PR-01644 教训）。
      if (!workContext.readOnly && taskReferencesLarkDocs(task.text)) {
        const outDir = auditContext?.logPath ? dirname(auditContext.logPath) : workContext.cwd
        task.larkDocs = prefetchLarkDocs({ text: task.text, outDir })
        updateTaskAudit(auditContext, {
          larkDocs: { urls: task.larkDocs.urls, docs: task.larkDocs.docs.map((d) => d.path), ok: task.larkDocs.ok },
        })
        if (!task.larkDocs.ok) {
          console.warn(`[lark-worker] ⚠ ${task.id} 引用 Lark 文档但预取失败，停在实施前转人工：${task.larkDocs.error}`)
          const waitText = formatStructuredAiResult({
            status: 'waiting_confirmation',
            summary: '任务引用了 Lark 文档（PRD / Wiki），但 Worker 无法读取文档正文，已停在实施之前等待处理（避免缺 PRD 硬做）。',
            blockers: [task.larkDocs.error],
            nextStep: '确认文档链接可访问、且 Worker 的 lark-cli 已授权（--as user）后重试。',
          })
          await reportStatus('waiting_confirmation', waitText, selectedExecutor)
          updateTaskAudit(auditContext, {
            status: 'waiting_confirmation',
            gateway: { status: 'waiting_confirmation', result: waitText },
            completedAt: new Date().toISOString(),
          })
          return
        }
      }

      task.aiExecutor = selectedExecutor
      // 先持久化实际执行器 + 目标分支：都在 AI 跑之前定好，故 done 卡构建时 task.branch 已就位。
      // 只读任务不提交、无分支；hotfix 走临时分支；命中已有 worktree 用其当前分支。
      const targetBranch = workContext.readOnly ? null : executionIdentity?.branch || null
      await reportStatus('running', undefined, selectedExecutor, undefined, targetBranch)
      // 协作式取消·检查点①（烧 AI 之前）：人若在排队/刚 running 时就结单，这里直接省掉整趟 AI。
      if (await supersededMidRun('AI 执行')) return
      const aiController = new AbortController()
      const forwardWorkerAbort = () => aiController.abort(signal?.reason)
      if (signal?.aborted) forwardWorkerAbort()
      else signal?.addEventListener('abort', forwardWorkerAbort, { once: true })
      const onSupersededMidRun = (current) => {
        console.log(`[lark-worker] ${task.id} 在 AI 执行中检出已被取消/换代（status=${current?.status} epoch=${current?.epoch}），正在中止 AI 子进程`)
        updateTaskAudit(auditContext, { status: 'superseded_midrun', supersededPhase: 'AI 执行中', supersededAt: new Date().toISOString() })
      }
      // 取消 / 换代：主路径是变更流（lib/lark-change-watch.mjs，一条长轮询盯全部在飞任务），轮询只做 30s 兜底。
      const unwatch = changeWatcher?.watch(task.id, task.epoch, (entry) => {
        onSupersededMidRun(entry)
        aiController.abort(new Error(`task ${task.id} was superseded during AI execution`))
      })
      const stopCancellationMonitor = monitorExecutionCancellation({
        getTask,
        taskId: task.id,
        claimedEpoch: task.epoch,
        controller: aiController,
        intervalMs: Number(process.env.LARK_CANCEL_POLL_MS || 30_000),
        onSuperseded: onSupersededMidRun,
      })
      let aiRun
      let archivedDocs = []
      try {
        // 对接文档机械存档（不靠 AI 记得做）：拷到 worktree 的 docIntakeDir，文件名去掉下载前缀；AI 之后只做判断与接入。
        // 项目记忆共享：bot 的 claude 和负责人会话读同一份 ~/.claude/projects/<主仓>/memory。
        if (task.repo && repoProfileForTask(task)?.claudeMemoryDir) {
          const shared = ensureSharedClaudeMemory({ cwd: workContext.cwd, memoryDir: repoProfileForTask(task).claudeMemoryDir })
          if (shared.linked) console.log(`[lark-worker] ${task.id} 项目记忆已软链到主仓 memory`)
          else if (!shared.ok) console.warn(`[lark-worker] ${task.id} 项目记忆软链失败：${shared.reason}`)
        }
        archivedDocs = !workContext.readOnly && task.repo ? archiveDocAttachments({ task, cwd: workContext.cwd, profile: repoProfileForTask(task) }) : []
        if (archivedDocs.length) console.log(`[lark-worker] ${task.id} 对接文档已存档：${archivedDocs.join('、')}`)
        task.archivedDocs = archivedDocs // 提示词据此告诉 AI 已存档、#kept 不要覆盖（aven 2026-10-20 review C5）
        aiRun = await runAI(workerConfig, task, workContext, auditContext, aiController.signal)
      } finally {
        stopCancellationMonitor()
        unwatch?.()
        signal?.removeEventListener('abort', forwardWorkerAbort)
      }

      // #kept（仓里已有不同版本）被 AI 改了：临时 worktree 全量提交前恢复成 HEAD 版本，终检前做，指纹覆盖恢复后的内容。
      if (workContext.hotfixBranch && archivedDocs.some((item) => parseArchivedEntry(item).mark === 'kept')) {
        const restored = restoreKeptDocs({ cwd: workContext.cwd, archived: archivedDocs })
        if (restored.length) console.warn(`[lark-worker] ⚠ ${task.id} AI 改了不该覆盖的已有文档，已恢复为 HEAD 版本：${restored.join('、')}`)
      }
      let latestTask = await getTask(task.id)
      let qualityGate = null
      // 四种执行器都不自调 Gateway；结构化结果统一落盘，由 Worker 用正确 epoch 回写。
      if (aiRun.result && latestTask?.status === 'running') {
        const warnNotes = []
        // 系统实测数据（发完成卡时与 AI 自证分栏展示）：真实改动文件、diff 规模。
        // 在 isCompletedAiStatus 分支内测得，故在此外层声明供下方 reportStatus 使用。
        let actualChangedFiles = []
        let changeStat = ''
        // 修改范围契约核对结果（仅会改代码的任务）：完成卡附「契约 vs 实测」段落，越界则挂起待人确认扩大范围。
        let scopeGate = null
        // 修复 / 缺陷 / 需求类任务预期真改业务代码：done 可信度（只动测试 = 凑 diff）与范围契约核对共用此判据。
        const expectsCode = expectsCodeChange({ task, readOnly: workContext.readOnly })
        // changed-file 静态扫描摘要（与人类 `docs-tdd changed` 同一把尺子，非阻断）：在完成卡上给出
        // error/warn 计数，让「bot 改的代码有没有踩规则」不再只有 bot 自己知道（D5）。
        let codeRules = null
        // 规则上下文里辅助（非 required）章节缺失时的降级 warnings：随结果卡浮现给群，
        // 否则「用不完整规则执行」只在审计里、无人看见（A2）。required 章节缺失仍在 runAI 里 fail-closed。
        if (aiRun.ruleContext?.warnings?.length) warnNotes.push(...aiRun.ruleContext.warnings)
        // WIP 隔离提示（仅完成态）：任务开始时 worktree 有未提交改动，改动已隔离到旁支而非原分支。
        // failed/blocked 未提交无需提示；不说清就容易被误读成「改在原分支、直接发布即可」（PR-02273）。
        if (reroutedWip && isCompletedAiStatus(aiRun.result.status)) {
          const target = reroutedWip.originalBranch || '你的工作分支'
          warnNotes.push(`任务开始时你的 worktree 有未提交改动，为不碰你的现场，本次从 ${target}@${reroutedWip.sourceHeadSha.slice(0, 12)} 创建隔离分支 \`${reroutedWip.hotfixBranch}\`（完全没动你的工作区）；发布前需把它 cherry-pick / merge 回 ${target}`)
        }
        // 只有完成态（done/done_with_warnings）才进规范闸 + done 可信度评估。no_change_needed 是非完成态终局
        // （本仓无对应改动、转后端/别的仓）：无 diff、无提交，故在此**天然短路**——不进空 diff 评估（否则又被误判失败），
        // 走下面与 waiting/blocked 同一条「非 done 直接回写」路径，finally 兜底以 allowCommit=false 回收临时 worktree。
        // 文档入库且工作区一点没动（附件全是仓里已有版本、AI 也没改别的）：不进核验闸（空 diff 会被判不可信），走下面「无需提交」（review C9）。
        const docIntakeNoop = Boolean(task.repo && archivedDocs.length && isCompletedAiStatus(aiRun.result.status) && worktreeState(workContext.cwd) === 'clean')
        if (isCompletedAiStatus(aiRun.result.status) && !docIntakeNoop) {
          // 完成态核验（第 2 批）：lint / git 身份 / 终检 / 规则扫描 / done 可信度 / 范围契约按注册表顺序跑，
          // 证据只采一次（lib/lark-task-gates.mjs）。第一道失败即回写并返回。
          const verify = await runVerifyGates({ task, workContext, aiRun, expectsCode, executionIdentity, workerConfig, auditContext, signal })
          updateTaskAudit(auditContext, verify.audit)
          if (!verify.ok) {
            console.error(`[lark-worker] ⛔ ${task.id} 核验闸「${verify.gate}」拦下（${verify.status}）：${verify.reason}`)
            const failed = buildGateFailureReport({ verify, aiRun, evidence: runEvidenceFor({ aiRun, cwd: workContext.cwd, verify: repoProfileForTask(task)?.verify }) })
            await reportStatus(failed.status, failed.result, aiRun.executor, null, undefined, failed.extras)
            updateTaskAudit(auditContext, { status: verify.status, gateway: { status: verify.status, result: verify.text }, verifyGate: verify.gate })
            return
          }
          ;({ actualChangedFiles, changeStat, qualityGate, workerVerification, codeRules, scopeGate } = verify.outputs)
          // 收尾提交的定向清单来自同一次实测，保证「提交了什么」与「卡片说改了什么」同源。
          taskChangedPaths = actualChangedFiles
          warnNotes.push(...verify.warnNotes)
        }
        let resultText = formatStructuredAiResult(aiRun.result, { readOnly: workContext.readOnly })
        if (qualityGate?.softRemaining.length) {
          // 软违规（arbitrary value 等，可能无对应 token）不硬拦，附清单到完成消息供人工 review。
          task.qualityNote = `含 ${qualityGate.softRemaining.length} 处未修正规范问题（arbitrary value 等），需人工确认`
          warnNotes.push(task.qualityNote)
        }
        if (warnNotes.length) resultText += `\n⚠ ${warnNotes.join('；')}`
        // 系统实测栏：与上面的 AI 自证（summary）分栏，给群里领导/PM 一个 worker 亲测的事实基准
        // ——真实改动规模 + 设计稿是否已由 Worker 落盘供 AI 读——防止「截图代打卡还报完成」这类虚报（PR-02172）。
        // 仓库 profile（外部群）任务：结果只给负责人私聊看人话，范围契约 / 系统实测 / 终检明细留在审计里不上消息。
        if (isCompletedAiStatus(aiRun.result.status) && !workContext.readOnly && !task.repo) {
          const figmaLabel = !task.figmaSpec?.referencesFigma
            ? '不涉及'
            : `✓ 已落盘设计稿 ${task.figmaSpec.specs.length} 处`
          const changeLabel = changeStat
            ? `实测改动 ${actualChangedFiles.length} 处（${changeStat}）`
            : `实测改动 ${actualChangedFiles.length} 处`
          resultText = appendPublicCompletionEvidence({
            resultText,
            changeLabel,
            figmaLabel,
            workerVerificationLine: workerVerification ? formatWorkerVerificationLine(workerVerification) : null,
            scopeSection: scopeGate?.section || null,
          })
        }
        // 实施阶段按契约要求自停（waiting_confirmation 并在 blockers 里点名要追加的文件）：转成与收尾越界同形的
        // 待批准请求，人回复「确认扩大范围」即可一键放行，而不必再把路径抄一遍。
        const scopeRequest = aiRun.result.status === 'waiting_confirmation' && expectsCode
          ? scopeRequestFromBlockers({ scope: aiRun.scope, approvals: task.scopeApprovals, blockers: aiRun.result.blockers })
          : null
        if (scopeRequest) {
          resultText += `\n如确认可以改上述契约外文件（${scopeRequest.paths.join('、')}），回复本卡片「确认扩大范围」即并入修改范围续跑。`
        }
        // owner（AI 推断的责任人角色/关键词）随回写带给 Gateway，用于 waiting/blocked 卡片 @ 责任人。
        let gatewayStatus = gatewayStatusForAiStatus(aiRun.result.status)
        // 改动有没有提交（10-21 P3）：下面任何一步没过都记一笔，回答照带，投递按任务契约决定发不发。
        let changeVerdict = null
        // 外部群任务：归属判定不是被代理人的事 → 静默忽略（不发卡、不回群），只记审计。
        if (task.repo && archivedDocs.length && (!isCompletedAiStatus(aiRun.result.status) || docIntakeNoop)) {
          // 对接文档：不管 AI 判成阻塞 / 无需改动 / 归别人，文档都要入库（done + 提交），群里以「收到、已入库、归谁」收尾。
          // 负责人从结论文字里认功能总表上的名字（可能多人）；认不出就不 @。
          const me = repoProfileForTask(task).ownership?.me || ''
          const knownOwners = Object.keys(ownerTableFor(repoProfileForTask(task)))
          // 归属优先用分析阶段的结构化 ownership（第 3 批）；没有再按名字在结论文字里找。
          const declared = aiRun.analysis?.ownership && typeof aiRun.analysis.ownership === 'object' ? aiRun.analysis.ownership : null
          const text = `${aiRun.result.summary || ''}\n${(aiRun.result.blockers || []).join('\n')}\n${aiRun.result.owner || ''}`
          const escape = (name) => String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          const owners = declared ? (declared.owner && declared.owner !== me ? [declared.owner] : []) : knownOwners.filter((name) => name && name !== me && new RegExp(escape(name), 'i').test(text))
          const mine = declared ? Boolean(declared.mine) : Boolean(me && new RegExp(escape(me), 'i').test(text))
          // 只提交真有改动的文档：#kept 不进提交，#same 没改过也不算；一份都没有 → 无需提交、按 ok 收尾（aven 2026-10-20 review C9）。
          const plan = planDocIntakeCommit({ archived: archivedDocs, changedPaths: changedDocPaths({ cwd: workContext.cwd, paths: archivedDocs.map((item) => parseArchivedEntry(item).path) }) })
          // 跟负责人无关的文档不进仓库：撤掉工作区里的存档，不提交，只私聊说一句（aven 10-20，教训 #53）。
          const skipped = shouldSkipDocSave({ declared, mine, owners })
          if (skipped) discardUnsavedDocs({ cwd: workContext.cwd, paths: plan.commit })
          archivedDocs = skipped ? [] : plan.commit
          console.log(`[lark-worker] ${task.id} 对接文档${skipped ? `跟 ${me || '负责人'} 无关，不入库（撤掉 ${plan.commit.length} 份）` : `入库 ${plan.commit.length} 份（相同 ${plan.same.length}、未覆盖 ${plan.kept.length}）`}，AI 判 ${aiRun.result.status}，归 ${owners.join('、') || (mine ? me : '未识别')}`)
          gatewayStatus = 'done'
          resultText = buildDocIntakeText({ ...plan, owners, mine, skipped, summary: aiRun.result.summary, blockers: aiRun.result.blockers || [] })
          // 文档入库一律不回群，只私聊负责人：归我的等后端按对接文档答复（教训 #36）；归别人的也不 @ 接手——跟负责人无关就忽略、能不回群就不回群（aven 10-19，教训 #44）。
          aiRun.result.groupReply = null
          aiRun.result.groupSilent = true // groupReply 置空不等于不发群（出口会回落到 summary），要显式关
          aiRun.result.followUps = null
          aiRun.result.followUpDoc = null
          aiRun.result.status = 'done'
          // 提交前要有 worker 终检指纹（与正常 done 同一道闸）：只改了文档，终检只做 intent-to-add / diff-check。
          actualChangedFiles = archivedDocs
          taskChangedPaths = archivedDocs
          commitScopedPaths = archivedDocs
          if (!archivedDocs.length) {
            finalizeWork({ allowCommit: false }) // 没有要提交的：按未完成口径收尾（临时 worktree 有半成品就留现场），任务本身 done
          } else if (!(workerVerification = runFinalVerification({ cwd: workContext.cwd, changedFiles: archivedDocs, finalChecks: repoProfileForTask(task)?.finalChecks || null })).ok) {
            gatewayStatus = 'failed'
            changeVerdict = { committed: false, gate: 'final-verification', reason: '文档终检没过' }
            resultText = buildVerificationFailedResult({ task, receipt: workerVerification, cwd: workContext.cwd })
          }
        } else if (task.repo && aiRun.result.status === 'no_change_needed' && aiRun.result.noChangeReason === 'other_owner') {
          console.log(`[lark-worker] ${task.id} 归属不归 ${repoProfileForTask(task).ownership?.me || '代理人'}（${aiRun.result.owner || '?'}），静默忽略`)
          gatewayStatus = 'ignored'
        }
        // 先落盘、再报喜：done 必须在收尾提交成功之后才回写，提交失败就地降级 failed，
        // 否则群里的「已完成」会跑在提交前面，改动只躺在工作区、下一轮清理就没了。
        // 整改 #6：仓库 profile 配了 verify 且本次改到接口 schema / queries → 必须有本轮实测记录（preChecks）；
        // 有 issues 的降级 failed（schema 与真实响应对不上），完全没实测的挂 waiting_confirmation 等 pre 可用后重跑。
        if (gatewayStatus === 'done' && !workContext.readOnly && task.repo) {
          const verify = repoProfileForTask(task)?.verify
          const schemaTouched = verify && actualChangedFiles.some((file) => new RegExp(verify.schemaFiles).test(file))
          if (schemaTouched) {
            const outcomeOf = (item) => String(item?.outcome ?? item?.result ?? '')
            // kind 优先、没填退回文字匹配；静态资源 404 不算（教训 #42）；没有一条接口实测通过 = 没实测（aven 2026-10-20 review C13）
            const { verdict, broken } = schemaVerifyVerdict(aiRun.result.preChecks)
            if (verdict === 'broken') {
              gatewayStatus = 'failed'
              changeVerdict = { committed: false, gate: 'schema', reason: `schema 与 ${verify.env} 真实响应对不上` }
              resultText += `\n⛔ schema 与 ${verify.env} 真实响应对不上，未按完成处理：${broken.map((item) => `${item.endpoint} → ${outcomeOf(item).slice(0, 120)}`).join('；')}`
              console.error(`[lark-worker] ⛔ ${task.id} schema 校验有 issues，降级 failed`)
            } else if (verdict === 'unverified') {
              gatewayStatus = 'waiting_confirmation'
              changeVerdict = { committed: false, gate: 'schema-unverified', reason: `接口改动没有在 ${verify.env} 实测通过` }
              resultText += `\n待补充：接口改动没有一条在 ${verify.env} 实测通过（没跑或全是连不上），不能按完成处理；确认 ${verify.env} 可用后回复「继续任务 ${task.id} 重跑并实测」`
              console.warn(`[lark-worker] ⚠ ${task.id} 改了接口 schema 但没有通过的 preChecks，挂待确认`)
            }
          }
        }
        if (gatewayStatus === 'done' && !workContext.readOnly) {
          // 协作式取消·检查点②（提交之前，最关键）：AI 跑完到提交之间人可能刚结单。此处检出即
          // 跳过提交、不回写 done、直接 return——finally 会以 allowCommit=false 收尾（temp worktree 清掉、
          // 命中的已有 worktree 不提交），已取消任务的改动绝不进分支。群里「已取消」卡由控制通道已发，不重复。
          if (await supersededMidRun('提交')) return
          const outcome = finalizeWork({ allowCommit: true })
          if (!outcome.ok) {
            console.error(`[lark-worker] ⛔ ${task.id} AI 判完成但收尾提交失败，降级为 failed：${outcome.reason}`)
            gatewayStatus = 'failed'
            changeVerdict = { committed: false, gate: 'commit', reason: String(outcome.reason || '').slice(0, 300) }
            resultText = buildCommitFailedResult({ task, resultText, cwd: workContext.cwd, reason: outcome.reason })
          }
          if (outcome.ok) changeVerdict = { committed: Boolean(outcome.committed) }
          if (outcome.ok && integration?.ok && outcome.committed && workContext.hotfixBranch) {
            // 合回集成分支；冲突不影响任务完成，但要告诉负责人「没合进去、冲突在哪」。
            const merged = mergeIntoIntegration({ root: workContext.repoRoot, worktreePath: integration.worktreePath, branch: workContext.hotfixBranch, integrationBranch: integration.branch, message: `merge: ${workContext.hotfixBranch}（${(task.summary || '').slice(0, 40)}）` })
            // 合回成功即删任务分支（改动已在集成分支里）；冲突 / 失败不删，留给负责人处理。
            const branchCleanup = merged.ok
              ? deleteMergedTaskBranch({ root: workContext.repoRoot, branch: workContext.hotfixBranch, integrationBranch: integration.branch, branchPrefix: integrationProfile?.branchPrefix })
              : null
            integration = { ...integration, mergeBack: merged, branchCleanup }
            updateTaskAudit(auditContext, { integration })
            if (!merged.ok) console.warn(`[lark-worker] ⚠ ${task.id} 合回集成分支失败：${merged.reason}`)
            else if (branchCleanup && !branchCleanup.deleted) console.warn(`[lark-worker] ⚠ ${task.id} 任务分支 ${workContext.hotfixBranch} 未删：${branchCleanup.reason}`)
          }
        }
        // 任务分支合回后被删：task.branch 改指集成分支，网关 `git show <branch>:<followUpDoc>` 才取得到（aven 2026-10-20 review C6）。
        await reportStatus(gatewayStatus, resultText, aiRun.executor, aiRun.result.owner, readableBranchAfterMerge(integration),
          buildReportExtras({ aiResult: aiRun.result, actualChangedFiles, scopeRequest, integration, taskBranch: workContext.hotfixBranch, change: changeVerdict, evidence: runEvidenceFor({ aiRun, cwd: workContext.cwd, verify: repoProfileForTask(task)?.verify }) }))
        latestTask = await getTask(task.id)
        updateTaskAudit(auditContext, {
          status: latestTask?.status || gatewayStatus,
          gateway: { status: latestTask?.status || gatewayStatus, result: latestTask?.result || resultText },
        })
      }

      if (latestTask?.status === 'running') {
        // AI 退出但没显式回写 done/failed → 一律判失败待人工复核（不分任务类型，绝不兜底成功）
        await reportStatus('failed', buildNeedsReviewResult(task))
        updateTaskAudit(auditContext, {
          status: 'failed',
          gateway: { status: 'failed', result: buildNeedsReviewResult(task) },
        })
        return
      }

    } catch (error) {
      const latestTask = await getTask(task.id)
      // 优雅退出中断（signal.aborted）不写 failed：任务已被交还队列待重领；即便释放请求也失败了，
      // 也宁可保留 running 交给租约过期回收，绝不把一条正常任务误标成 failed。
      if (latestTask?.status === 'running' && !isShutdownAbort(signal)) {
        // 自愈环 2：失败指纹 → 确定性剧本。可重排队的类（结果文件 / 结果不合约 / 瞬时 API / git / 非零退出）
        // 且本任务没自动重跑过 → 交还队列（queued + epoch++，不发失败卡），重领后带提示再跑一次；
        // 其余按失败报，卡上写归类与 7 天内复发次数（复发 = 自修工单的触发条件）。
        const repoKey = repoProfileForTask(task)?.key
        const fingerprint = fingerprintFailure(error)
        let playbook = { action: 'fail', reason: fingerprint.label, recurring: false }
        let recentSame = 0
        try {
          const priorAttempts = selfHealAttemptsForTask({ repo: repoKey, taskId: task.id }).length
          recentSame = countRecentFingerprint({ repo: repoKey, fingerprint: fingerprint.fingerprint })
          playbook = decideFailurePlaybook({ fingerprint, priorAttempts, recentSameFingerprint: recentSame })
        } catch (ledgerError) {
          console.warn(`[lark-worker] ${task.id} 读失败台账出错（按直接失败处理）：${String(ledgerError).slice(0, 120)}`)
        }
        updateTaskAudit(auditContext, { failureFingerprint: fingerprint, failurePlaybook: playbook })
        if (playbook.action === 'requeue') {
          let requeued = false
          try {
            requeued = Boolean(await client.releaseTask(task.id))
          } catch (releaseError) {
            console.warn(`[lark-worker] ${task.id} 自愈重排队失败（改报失败）：${String(releaseError).slice(0, 120)}`)
          }
          if (requeued) {
            recordFailure({ repo: repoKey, taskId: task.id, epoch: task.epoch, fingerprint, action: 'requeue', reason: playbook.reason, message: error?.message, recurring: playbook.recurring })
            console.warn(`[lark-worker] ${task.id} 自愈：${playbook.reason}，已交还队列重领（指纹 ${fingerprint.fingerprint}）`)
            updateTaskAudit(auditContext, { status: 'self_heal_requeued', error: error instanceof Error ? error.message : String(error) })
            return
          }
          playbook = { ...playbook, action: 'fail' }
        }
        // 自愈环 1.6：报「没做成」前先看旁证（发件簿已发的群消息、工作区改动），避免把干成的活说成失败。
        let evidenceLine = null
        try {
          const evidence = collectFailureEvidence({
            task,
            outbox: task.chatId ? listOutbox({ chatId: task.chatId, sinceMs: Date.parse(task.claimedAt || task.createdAt || '') || 0 }) : [],
            worktreeState: workContext?.cwd && existsSync(workContext.cwd) ? worktreeState(workContext.cwd) : null,
          })
          evidenceLine = formatFailureEvidence(evidence)
          if (evidence.probablyDone) console.warn(`[lark-worker] ${task.id} 失败但有完成旁证：${evidence.lines.join('；')}`)
          updateTaskAudit(auditContext, { failureEvidence: evidence })
        } catch (evidenceError) {
          console.warn(`[lark-worker] ${task.id} 收集失败旁证出错（忽略）：${String(evidenceError).slice(0, 120)}`)
        }
        if (playbook.action !== 'ignore') {
          recordFailure({ repo: repoKey, taskId: task.id, epoch: task.epoch, fingerprint, action: 'fail', reason: playbook.reason, message: error?.message, recurring: playbook.recurring })
        }
        const fingerprintLine = formatFingerprintLine({ fingerprint, playbook, recentSameFingerprint: recentSame })
        await reportStatus('failed', buildFailureResult(task, error, { evidenceLine, fingerprintLine }))
        // 自愈环 2.2：复发 / 未归类 / 自动重跑也没救 → 给 lark-bot 自己开自修工单（预算与套娃保护在模块内）。
        try {
          const priorAttempts = selfHealAttemptsForTask({ repo: repoKey, taskId: task.id }).length
          const selfFix = await maybeOpenSelfFix({ client, task, error, fingerprint, playbook, recentSameFingerprint: recentSame, priorAttempts, auditContext, localConfig: workerConfig.localConfig })
          updateTaskAudit(auditContext, { selfFix })
        } catch (selfFixError) {
          console.warn(`[lark-worker] ${task.id} 自修工单判定出错（忽略）：${String(selfFixError).slice(0, 120)}`)
        }
      }
      updateTaskAudit(auditContext, {
        status: latestTask?.status === 'running' ? 'failed' : latestTask?.status || 'failed',
        error: error instanceof Error ? error.message : String(error),
      })
      console.error(`[lark-worker] task ${task.id} 执行异常：`, error)
    } finally {
      let finalTask
      try {
        finalTask = await getTask(task.id)
      } catch (error) {
        console.error(`[lark-worker] ⚠ ${task.id} 收尾时无法读取最终状态，按未完成保留可能的半成品：${error.message}`)
        updateTaskAudit(auditContext, { error: `读取最终状态失败：${error.message}` })
      }
      updateTaskAudit(auditContext, {
        status: finalTask?.status || auditContext?.record.status || 'unknown',
        gateway: finalTask ? { status: finalTask.status, result: finalTask.result } : auditContext?.record.gateway,
        completedAt: new Date().toISOString(),
      })
      // 收尾兜底：正常 done 已在发卡前收尾过（finalized=true，此处跳过）。剩下的是失败/阻塞/异常路径——
      // 有改动就保留现场待人工，无改动才清理；命中已有 worktree 时一律不提交。
      if (!finalized) {
        const outcome = finalizeWork({ allowCommit: finalTask?.status === 'done' })
        // 极端路径：状态已是 done（非本函数回写，如遗漏路径）却收尾失败，卡片已发出无法降级，只能告警。
        if (!outcome.ok && finalTask?.status === 'done') {
          console.error(`[lark-worker] ⚠ ${task.id} 已置 done 但收尾提交失败（卡片已发出，无法降级）：${outcome.reason}`)
        }
      }
    }
  }

  // 租约心跳 + 单一截止时间（第 0 批）：
  //   · 租约 75min 从领取起算、原来不续期，而分析 60min + 实施 60min + 纠正 + 重试远超它，长任务必被当孤儿回收重跑；
  //     现在每 leaseMs/3 给 gateway 续一次（epoch 不符即停，说明本次执行已被作废）。
  //   · 截止时间 = 领取时刻 + taskBudgetMs（默认 150min），用 AbortSignal.timeout 与退出信号合成一个 signal 传下去，
  //     到点统一中断，不再各阶段各一个 60min。截止中断按失败处理（TimeoutError），退出中断不写 failed（isShutdownAbort）。
  return async function runTask(task, workContext, { signal } = {}) {
    const stopLease = startLeaseHeartbeat({ client, task })
    const remaining = remainingTaskBudgetMs(task)
    const deadline = AbortSignal.timeout(remaining)
    const combined = typeof AbortSignal.any === 'function' ? AbortSignal.any([deadline, ...(signal ? [signal] : [])]) : signal || deadline
    try {
      return await runTaskBody(task, workContext, { signal: combined })
    } finally {
      stopLease()
    }
  }
}

// 生命周期辅助拆到 lark-task-runner-support（10-21 P0），这里转出口，旧引用不变。
export {
  ownerTableFor,
  claudeProjectKey,
  ensureSharedClaudeMemory,
  isExecutionSuperseded,
  monitorExecutionCancellation,
  DEFAULT_TASK_BUDGET_MS,
  LEASE_HEARTBEAT_DIVISOR,
  remainingTaskBudgetMs,
  isShutdownAbort,
  startLeaseHeartbeat,
}
