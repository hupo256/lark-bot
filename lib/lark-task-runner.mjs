/**
 * Lark Worker 的单任务生命周期层：执行一个**已领取**的任务——preflight、临时/既有 worktree 准备、
 * 文档同步、AI 运行、规范硬闸 + done 可信度评估、按正确 epoch 回写 Gateway、审计与 worktree 收尾。
 * 用 createTaskRunner(deps) 注入 gateway client 与 workerConfig，避免全局闭包。
 */

import { isReadOnlyCommand, parseCommandType } from './lark-message.mjs'
import { formatViolations } from './lark-lint-diff.mjs'
import { formatStructuredAiResult, preflightAiExecutor, resolveAiExecutor } from './lark-ai-executor.mjs'
import { createTaskAudit, updateTaskAudit } from './lark-worker-audit.mjs'
import {
  commitPreexistingWip,
  finalizeExistingWorktree,
  finalizeTempWorktree,
  gitAt,
  prepareTempWorktree,
} from './lark-worker-git.mjs'
import { runAI, runProjectDocSync } from './lark-worker-run.mjs'
import { assessDoneResult, buildQualityBlockedResult, enforceCodeQuality } from './lark-quality-gate.mjs'
import { buildFailureResult, buildNeedsReviewResult } from './lark-worker-results.mjs'

const commandTypeOf = (task) => task.commandType || parseCommandType(task.text)
// 命令类型任务（状态/文档/修复/自测/api/qa）触发项目文档同步；其中「状态」为只读。
const isCommandTask = (task) => commandTypeOf(task) != null
// 只读任务（状态/status）不改代码，done 时工作区本就无改动，故豁免「done+零改动」的可信度降级。
const isReadOnlyTask = (task) => isReadOnlyCommand(commandTypeOf(task))

export const createTaskRunner = ({ client, workerConfig }) => {
  const { updateTask, getTask } = client

  // 执行一个**已领取**的任务（领取由调度器/--once 完成）。workContext 由调用方算好传入。
  // 异常在内部吞掉并回写 failed，不向外抛（调度器里各任务并行 detached，抛出会变未捕获 rejection）。
  return async function runTask(task, workContext) {
    // 回写统一带上领取时的 epoch（fencing token）：若本次领取已被租约回收/人工 retry 作废，
    // 迟到回写会被 Gateway 以 409 拒掉，不覆盖新一代执行的状态。
    const reportStatus = (status, result, executor, owner, branch) =>
      updateTask(task.id, status, result, executor, task.epoch, owner, branch)
    if (!task.text?.trim()) {
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
      await reportStatus('failed', buildFailureResult(task, error))
      return
    }

    console.log(`[lark-worker] claimed ${task.id} via ${selectedExecutor}: ${task.text}`)
    console.log(`[lark-worker] routing ${task.id} → ${workContext.cwd}${workContext.hotfixBranch ? ` (临时 worktree ${workContext.hotfixBranch})` : ''}`)
    // 命中已有 worktree 且进来时已有未提交 WIP → 先把 WIP 单独提交一笔隔离，
    // 与随后本任务的改动分成两个 commit，避免你的 WIP 和 bot 改动混作一团。
    if (!workContext.hotfixBranch && !workContext.readOnly) commitPreexistingWip({ cwd: workContext.cwd })
    try {
      if (workContext.hotfixBranch) {
        try {
          prepareTempWorktree({ path: workContext.cwd, branch: workContext.hotfixBranch })
        } catch (prepError) {
          await reportStatus('failed', `处理失败。\n1. 项目 ${workContext.projectId} 本地无 worktree，需临时 worktree；\n2. ${prepError.message}`)
          return
        }
      }

      if (isCommandTask(task)) {
        await runProjectDocSync({ projectId: workContext.projectId })
      }

      task.aiExecutor = selectedExecutor
      // 先持久化实际执行器 + 目标分支：都在 AI 跑之前定好，故 done 卡构建时 task.branch 已就位。
      // 只读任务不提交、无分支；hotfix 走临时分支；命中已有 worktree 用其当前分支。
      const targetBranch = workContext.readOnly
        ? null
        : workContext.hotfixBranch || (gitAt(workContext.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout || '').trim() || null
      await reportStatus('running', undefined, selectedExecutor, undefined, targetBranch)
      const aiRun = await runAI(workerConfig, task, workContext, auditContext)

      let latestTask = await getTask(task.id)
      let qualityGate = null
      // claude / codex 都不自调 Gateway；两者都把结构化结果落盘，由 Worker 用正确 epoch 统一回写。
      if (aiRun.result && latestTask?.status === 'running') {
        const warnNotes = []
        if (aiRun.result.status === 'done') {
          qualityGate = await enforceCodeQuality(workerConfig, task, workContext, auditContext)
          if (qualityGate.hardRemaining.length) {
            // 失效裸色类硬闸：定向纠正后仍残留 → 不判 done，降级失败待人工（色类会被 Tailwind 静默丢弃，带病完成）。
            const failText = buildQualityBlockedResult(task, qualityGate.hardRemaining)
            console.error(`[lark-worker] ⛔ ${task.id} 规范硬闸拦截（失效色类）：\n${formatViolations(qualityGate.hardRemaining)}`)
            await reportStatus('failed', failText, aiRun.executor)
            updateTaskAudit(auditContext, { status: 'failed', gateway: { status: 'failed', result: failText } })
            return
          }
          // changedFiles 交叉校验 + 分级探测：enforceCodeQuality 已 `git add -A -N`，此处 name-only diff 含新增文件。
          const actualChangedFiles = (gitAt(workContext.cwd, ['diff', '--name-only', 'HEAD']).stdout || '')
            .split('\n').map((line) => line.trim()).filter(Boolean)
          const assessment = assessDoneResult({
            reportedChangedFiles: aiRun.result.changedFiles,
            actualChangedFiles,
            checks: aiRun.result.checks,
            readOnly: isReadOnlyTask(task),
          })
          if (!assessment.trustworthy) {
            // done 但工作区零改动等强信号 → 不按已完成处理（无改动=无修复=不可信），降级需人工复核。
            const failText = `${buildNeedsReviewResult(task)}\n附：${assessment.notes.join('；')}`
            await reportStatus('failed', failText, aiRun.executor)
            updateTaskAudit(auditContext, { status: 'failed', gateway: { status: 'failed', result: failText } })
            return
          }
          // L2+ 改动的 type-check 提示由 assessDoneResult 产出（note 级，不硬卡）：整包 tsc 基线本身就红，
          // 按 exit code 硬判会因历史欠债误伤所有 L2 改动，故只提示「需人工确认类型/契约无回归」，不阻断 done。
          warnNotes.push(...assessment.notes)
        }
        let resultText = formatStructuredAiResult(aiRun.result, aiRun.executor)
        if (qualityGate?.softRemaining.length) {
          // 软违规（arbitrary value 等，可能无对应 token）不硬拦，附清单到完成消息供人工 review。
          task.qualityNote = `含 ${qualityGate.softRemaining.length} 处未修正规范问题（arbitrary value 等），需人工确认`
          warnNotes.push(task.qualityNote)
        }
        if (warnNotes.length) resultText += `\n⚠ ${warnNotes.join('；')}`
        // owner（AI 推断的责任人角色/关键词）随回写带给 Gateway，用于 waiting/blocked 卡片 @ 责任人。
        await reportStatus(aiRun.result.status, resultText, aiRun.executor, aiRun.result.owner)
        latestTask = await getTask(task.id)
        updateTaskAudit(auditContext, {
          status: latestTask?.status || aiRun.result.status,
          gateway: { status: latestTask?.status || aiRun.result.status, result: latestTask?.result || resultText },
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

      // 命中已有 worktree（非临时）且任务成功 → 提交到该 worktree 当前分支。
      // 只读任务在主仓就地回答，绝不提交；失败/阻塞不提交（不往你的活跃分支写半成品）；
      // 临时 worktree 走 finally 里的 finalizeTempWorktree。
      if (!workContext.hotfixBranch && !workContext.readOnly) {
        const finalTask = await getTask(task.id)
        if (finalTask?.status === 'done') finalizeExistingWorktree({ cwd: workContext.cwd, task })
      }
    } catch (error) {
      const latestTask = await getTask(task.id)
      if (latestTask?.status === 'running') {
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
      // 临时 worktree 收尾：只有最终状态 done 才提交；失败/阻塞有改动时保留现场，无改动可清理。
      if (workContext.hotfixBranch) {
        finalizeTempWorktree({
          path: workContext.cwd,
          branch: workContext.hotfixBranch,
          task,
          allowCommit: finalTask?.status === 'done',
        })
      }
    }
  }
}
