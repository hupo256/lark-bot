/**
 * Lark Worker 的单任务生命周期层：执行一个**已领取**的任务——preflight、临时/既有 worktree 准备、
 * 文档同步、AI 运行、规范硬闸 + done 可信度评估、按正确 epoch 回写 Gateway、审计与 worktree 收尾。
 * 用 createTaskRunner(deps) 注入 gateway client 与 workerConfig，避免全局闭包。
 */

import { dirname } from 'node:path'

import { isReadOnlyTask, resolveCommandType } from './lark-message.mjs'
import { COMMIT_MODES, resolveCommitMode } from './lark-commit-policy.mjs'
import { isFastLaneTask, requirementGate } from './lark-work-policy.mjs'
import { tempWorktreeContextFor } from './lark-work-context.mjs'
import { formatViolations } from './lark-lint-diff.mjs'
import { formatStructuredAiResult, preflightAiExecutor, resolveAiExecutor } from './lark-ai-executor.mjs'
import { gatewayStatusForAiStatus, isCompletedAiStatus } from './lark-status-meta.mjs'
import { createTaskAudit, updateTaskAudit } from './lark-worker-audit.mjs'
import {
  finalizeExistingWorktree,
  finalizeTempWorktree,
  gitAt,
  prepareTempWorktree,
  worktreeState,
} from './lark-worker-git.mjs'
import { classifyTaskIntent, runAI, runProjectDocSync } from './lark-worker-run.mjs'
import { assessDoneResult, buildQualityBlockedResult, enforceCodeQuality } from './lark-quality-gate.mjs'
import { prefetchFigmaSpec, taskReferencesFigma } from './lark-figma.mjs'
import { buildCommitFailedResult, buildFailureResult, buildNeedsReviewResult } from './lark-worker-results.mjs'

// 命令类型任务（状态/文档/修复/自测/api/qa）触发项目文档同步；其中「状态」为只读。
const isCommandTask = (task) => resolveCommandType(task).type != null
// 群内或 bug 表产品 / QA 反馈直接使用任务、附件与 Worker 注入规则，不在 AI 前重复同步 Lark 文档。
export const shouldSyncProjectDocs = (task) => isCommandTask(task) && !isReadOnlyTask(task) && !isFastLaneTask(task)

export const createTaskRunner = ({ client, workerConfig }) => {
  const { updateTask, getTask, resolveIntake } = client

  // 执行一个**已领取**的任务（领取由调度器/--once 完成）。workContext 由调用方算好传入。
  // 异常在内部吞掉并回写 failed，不向外抛（调度器里各任务并行 detached，抛出会变未捕获 rejection）。
  // signal：worker 优雅退出信号——abort 时底层 AI 子进程被中断，且本函数跳过 failed 回写（任务已被
  // 交还队列 queued+epoch++，那条 failed 会因 epoch 不匹配被 gateway 409 挡掉，此处主动跳过更干净）。
  return async function runTask(task, workContext, { signal } = {}) {
    // 回写统一带上领取时的 epoch（fencing token）：若本次领取已被租约回收/人工 retry 作废，
    // 迟到回写会被 Gateway 以 409 拒掉，不覆盖新一代执行的状态。
    const reportStatus = (status, result, executor, owner, branch) =>
      updateTask(task.id, status, result, executor, task.epoch, owner, branch)
    if (!task.text?.trim() && !(task.attachments || []).length) {
      await reportStatus('failed', '处理失败。\n1. 这条 Lark 任务内容为空；\n2. 请重新 @ 应用并写清需要处理的事项。')
      return
    }

    let selectedExecutor
    let auditContext
    try {
      selectedExecutor = resolveAiExecutor(workerConfig, task)
      auditContext = createTaskAudit({ workerConfig, task, workContext, executor: selectedExecutor })
      preflightAiExecutor(selectedExecutor)
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
        const classification = await classifyTaskIntent(workerConfig, task, auditContext, signal)
        const outcome = await resolveIntake(task.id, { epoch: task.epoch, classification })
        updateTaskAudit(auditContext, {
          status: outcome.actionable ? 'queued_after_intake' : 'ignored',
          intake: classification,
          completedAt: new Date().toISOString(),
        })
      } catch (error) {
        if (!signal?.aborted) {
          const message = error instanceof Error ? error.message : String(error)
          updateTaskAudit(auditContext, { status: 'intake_failed', error: message, completedAt: new Date().toISOString() })
          await resolveIntake(task.id, { epoch: task.epoch, error: message })
        }
      }
      return
    }

    console.log(`[lark-worker] claimed ${task.id} via ${selectedExecutor}: ${task.text}`)
    // 新需求放行闸：在动 worktree、烧 AI 之前就停。判为 requirement 且人还没放行过 → 回一张待确认卡，
    // 人补一句预期行为（回复卡片即可）就续跑。放这么早有两个硬理由：
    //   1. 默认执行器 claude 没有只读分析阶段，只在分析阶段拦等于对默认路径无效；
    //   2. 拦下来的任务一次 AI 都不该跑，也不该碰任何 worktree。
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
    // bot 的改动落 origin/online 上的 hotfix 分支、完全不碰人类工作区，留待人工 review/挑拣。
    // 边界：bot 提交自己的改动是允许的（隔离分支 / 命中干净 worktree 的当前分支），提交人类 WIP 不允许。
    if (!workContext.hotfixBranch && !workContext.readOnly && worktreeState(workContext.cwd) === 'dirty') {
      const isolated = tempWorktreeContextFor(task)
      console.warn(`[lark-worker] ⚠ ${task.id} 命中的已有 worktree ${workContext.cwd} 有未提交 WIP，改到隔离 worktree ${isolated.cwd}（分支 ${isolated.hotfixBranch}），不触碰你的 WIP`)
      workContext = isolated
      updateTaskAudit(auditContext, {
        workContext: { cwd: workContext.cwd, hotfixBranch: workContext.hotfixBranch, reroutedFrom: 'preexisting-wip' },
      })
    }
    console.log(`[lark-worker] routing ${task.id} → ${workContext.cwd}${workContext.hotfixBranch ? ` (临时 worktree ${workContext.hotfixBranch})` : ''}`)
    // 收尾提交只能发生一次：正常 done 路径在**发完成卡之前**主动调用（见 finalizeWork 注释），
    // 其余路径（失败/阻塞/异常）由 finally 兜底。此标记防止两处重复收尾。
    let finalized = false
    // 本任务实测产生的改动清单（AI 跑完、规范闸之后测得）。收尾提交在命中人类已有 worktree 时按它
    // 定向提交（见 lark-commit-policy 的 scoped 口径），故必须声明在 finalizeWork 之外。
    let taskChangedPaths = []
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
      if (workContext.hotfixBranch) {
        return finalizeTempWorktree({ path: workContext.cwd, branch: workContext.hotfixBranch, task, allowCommit: mode === COMMIT_MODES.auto })
      }
      // 命中已有 worktree：失败/阻塞一律不提交（不往你的活跃分支写半成品），改动留在工作区。
      if (mode === COMMIT_MODES.none) return { ok: true, committed: false, reason }
      return finalizeExistingWorktree({ cwd: workContext.cwd, task, taskPaths: taskChangedPaths })
    }
    try {
      if (workContext.hotfixBranch) {
        try {
          prepareTempWorktree({ path: workContext.cwd, branch: workContext.hotfixBranch })
        } catch (prepError) {
          await reportStatus('failed', `处理失败。\n1. 项目 ${workContext.projectId} 本地无 worktree，需临时 worktree；\n2. ${prepError.message}`)
          return
        }
      }

      if (shouldSyncProjectDocs(task)) {
        await runProjectDocSync({ projectId: workContext.projectId })
      }

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

      task.aiExecutor = selectedExecutor
      // 先持久化实际执行器 + 目标分支：都在 AI 跑之前定好，故 done 卡构建时 task.branch 已就位。
      // 只读任务不提交、无分支；hotfix 走临时分支；命中已有 worktree 用其当前分支。
      const targetBranch = workContext.readOnly
        ? null
        : workContext.hotfixBranch || (gitAt(workContext.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout || '').trim() || null
      await reportStatus('running', undefined, selectedExecutor, undefined, targetBranch)
      const aiRun = await runAI(workerConfig, task, workContext, auditContext, signal)

      let latestTask = await getTask(task.id)
      let qualityGate = null
      // claude / codex 都不自调 Gateway；两者都把结构化结果落盘，由 Worker 用正确 epoch 统一回写。
      if (aiRun.result && latestTask?.status === 'running') {
        const warnNotes = []
        // 系统实测数据（发完成卡时与 AI 自证分栏展示）：真实改动文件、diff 规模。
        // 在 isCompletedAiStatus 分支内测得，故在此外层声明供下方 reportStatus 使用。
        let actualChangedFiles = []
        let changeStat = ''
        // 规则上下文里辅助（非 required）章节缺失时的降级 warnings：随结果卡浮现给群，
        // 否则「用不完整规则执行」只在审计里、无人看见（A2）。required 章节缺失仍在 runAI 里 fail-closed。
        if (aiRun.ruleContext?.warnings?.length) warnNotes.push(...aiRun.ruleContext.warnings)
        // 只有完成态（done/done_with_warnings）才进规范闸 + done 可信度评估。no_change_needed 是非完成态终局
        // （本仓无对应改动、转后端/别的仓）：无 diff、无提交，故在此**天然短路**——不进空 diff 评估（否则又被误判失败），
        // 走下面与 waiting/blocked 同一条「非 done 直接回写」路径，finally 兜底以 allowCommit=false 回收临时 worktree。
        if (isCompletedAiStatus(aiRun.result.status)) {
          // 状态查询是严格只读：不跑会 `git add -N` / 触发纠正 AI 的代码规范闸，也不读取现有 WIP
          // 来证明本次完成；只要求 AI 正常返回结构化 done。普通变更任务仍保留全部硬闸。
          if (!workContext.readOnly) {
            qualityGate = await enforceCodeQuality(workerConfig, task, workContext, auditContext)
            if (qualityGate.hardRemaining.length) {
              // 失效裸色类硬闸：定向纠正后仍残留 → 不判 done，降级失败待人工（色类会被 Tailwind 静默丢弃，带病完成）。
              const failText = buildQualityBlockedResult(task, qualityGate.hardRemaining)
              console.error(`[lark-worker] ⛔ ${task.id} 规范硬闸拦截（失效色类）：\n${formatViolations(qualityGate.hardRemaining)}`)
              await reportStatus('failed', failText, aiRun.executor)
              updateTaskAudit(auditContext, { status: 'failed', gateway: { status: 'failed', result: failText } })
              return
            }
          }
          // changedFiles 交叉校验 + 分级探测：enforceCodeQuality 已 `git add -A -N`，此处 name-only diff 含新增文件。
          actualChangedFiles = workContext.readOnly
            ? []
            : (gitAt(workContext.cwd, ['diff', '--name-only', 'HEAD']).stdout || '')
                .split('\n').map((line) => line.trim()).filter(Boolean)
          // 收尾提交的定向清单来自同一次实测，保证「提交了什么」与「卡片说改了什么」同源。
          taskChangedPaths = actualChangedFiles
          // 系统实测：真实 diff 规模（--shortstat）。
          changeStat = workContext.readOnly ? '' : (gitAt(workContext.cwd, ['diff', '--shortstat', 'HEAD']).stdout || '').trim()
          const assessment = assessDoneResult({
            reportedChangedFiles: aiRun.result.changedFiles,
            actualChangedFiles,
            checks: aiRun.result.checks,
            readOnly: workContext.readOnly,
          })
          if (!assessment.trustworthy) {
            // done 但工作区零改动等强信号 → 不按已完成处理（无改动=无修复=不可信），降级需人工复核。
            const failText = `${buildNeedsReviewResult(task)}\n附：${assessment.notes.join('；')}`
            await reportStatus('failed', failText, aiRun.executor)
            updateTaskAudit(auditContext, { status: 'failed', gateway: { status: 'failed', result: failText } })
            return
          }
          // 到这里 assessment.trustworthy 恒为 true。剩下的 notes 是「AI 漏报/虚报改动文件」这类非阻塞
          // 提醒——附到完成卡供人工核对即可。L2 契约/共享改动缺 type-check 证据的情形已在上面 !trustworthy
          // 分支被降级为需复核（不再是 note 级）：我们不按整包 tsc exit code 硬判（会被历史基线红误伤），
          // 只校验 AI 是否给出了它本应产出的 type-check 证据。
          warnNotes.push(...assessment.notes)
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
        if (isCompletedAiStatus(aiRun.result.status) && !workContext.readOnly) {
          const figmaLabel = !task.figmaSpec?.referencesFigma
            ? '不涉及'
            : `✓ 已落盘设计稿 ${task.figmaSpec.specs.length} 处`
          const changeLabel = changeStat
            ? `实测改动 ${actualChangedFiles.length} 处（${changeStat}）`
            : `实测改动 ${actualChangedFiles.length} 处`
          resultText += `\n**系统实测**：${changeLabel} · Figma 核验 ${figmaLabel}`
        }
        // owner（AI 推断的责任人角色/关键词）随回写带给 Gateway，用于 waiting/blocked 卡片 @ 责任人。
        let gatewayStatus = gatewayStatusForAiStatus(aiRun.result.status)
        // 先落盘、再报喜：done 必须在收尾提交成功之后才回写，提交失败就地降级 failed，
        // 否则群里的「已完成」会跑在提交前面，改动只躺在工作区、下一轮清理就没了。
        if (gatewayStatus === 'done' && !workContext.readOnly) {
          const outcome = finalizeWork({ allowCommit: true })
          if (!outcome.ok) {
            console.error(`[lark-worker] ⛔ ${task.id} AI 判完成但收尾提交失败，降级为 failed：${outcome.reason}`)
            gatewayStatus = 'failed'
            resultText = buildCommitFailedResult({ task, resultText, cwd: workContext.cwd, reason: outcome.reason })
          }
        }
        await reportStatus(gatewayStatus, resultText, aiRun.executor, aiRun.result.owner)
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

      // 规范闸兜底：正常结构化 done 已在上面回写时跑过规范闸（qualityGate 已置），此处仅覆盖极端遗漏路径。
      // 结果卡已由上面的 reportStatus 发出，故此处不重发卡片，只保证「进分支的代码」变干净。
      if (latestTask?.status === 'done' && !qualityGate) {
        const gate = await enforceCodeQuality(workerConfig, task, workContext, auditContext)
        if (!gate.ok) {
          task.qualityNote = `含 ${gate.remaining.length} 处未修正规范问题（arbitrary value / 失效色类），需人工处理`
          console.error(`[lark-worker] ⚠ ${task.id} 规范闸残留：\n${formatViolations(gate.remaining)}`)
        }
      }
    } catch (error) {
      const latestTask = await getTask(task.id)
      // 优雅退出中断（signal.aborted）不写 failed：任务已被交还队列待重领；即便释放请求也失败了，
      // 也宁可保留 running 交给租约过期回收，绝不把一条正常任务误标成 failed。
      if (latestTask?.status === 'running' && !signal?.aborted) {
        await reportStatus('failed', buildFailureResult(task, error))
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
}
