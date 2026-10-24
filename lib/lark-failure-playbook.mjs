/**
 * 失败处置剧本（自愈环 2 的接入层，从 falive 的 task-runner 失败分支移植，aven 2026-10-24）。
 * task-runner 的 catch 只调 handleTaskFailure，开工时调 selfHealHintFor；本模块把「指纹 → 剧本 → 台账 → 旁证 → 失败卡」
 * 串起来，客户端 / 回写 / 旁证读取都由调用方注入，可直测。
 *
 *   · 可重排队的类（REQUEUE_CLASSES）且本任务没自动重跑过 → client.releaseTask 交还队列（queued + epoch++，静默，
 *     不发失败卡），台账记 requeue；重领后 selfHealHintFor 给提示末尾加「上次失败类别 + 针对性一句」。
 *   · stale_epoch / aborted → 不算失败：不进台账，失败卡照发（换代的回写网关会 409 挡掉）。
 *   · 其余 → 台账记 fail，失败卡第 3 行「失败归类：… 同一种错 7 天内第 N 次，指纹 …」，第 4 行旁证。
 * 开关：配置 selfHeal.playbook=false 或环境 LARK_FAILURE_PLAYBOOK=0 → 整段关掉，失败卡回到原来的格式、不记台账、不重排队。
 */

import { updateTaskAudit } from './lark-worker-audit.mjs'
import { buildFailureResult } from './lark-worker-results.mjs'
import { formatFailureEvidence } from './lark-failure-evidence.mjs'
import { buildSelfHealHint, decideFailurePlaybook, fingerprintFailure, formatFingerprintLine } from './lark-failure-fingerprint.mjs'
import { FAILURE_LEDGER_KEY, countRecentFingerprint, failuresDir, recordFailure, selfHealAttemptsForTask } from './lark-failure-ledger.mjs'

export const failurePlaybookEnabled = ({ localConfig, env = process.env } = {}) =>
  localConfig?.selfHeal?.playbook !== false && env.LARK_FAILURE_PLAYBOOK !== '0'

const short = (error) => String(error).slice(0, 120)

// 开工时：这条任务若是自动重排队后重领的，返回给模型的提示（runAI 追加到提示末尾）；没有返回 null。读台账出错不阻断。
export const selfHealHintFor = ({ task, auditContext, enabled = true, dir = failuresDir, repo = FAILURE_LEDGER_KEY }) => {
  if (!enabled) return null
  try {
    const attempts = selfHealAttemptsForTask({ dir, repo, taskId: task.id })
    if (!attempts.length) return null
    updateTaskAudit(auditContext, { selfHealAttempts: attempts.map((item) => ({ at: item.at, cls: item.cls, reason: item.reason })) })
    console.log(`[lark-worker] ${task.id} 自愈重跑第 ${attempts.length + 1} 次（上次：${attempts.at(-1).label || attempts.at(-1).cls}）`)
    return buildSelfHealHint(attempts)
  } catch (error) {
    console.warn(`[lark-worker] ${task.id} 读失败台账出错（忽略）：${short(error)}`)
    return null
  }
}

/**
 * 任务执行异常的处置。调用前提（由 task-runner 判断）：网关里任务仍是 running，且不是 worker 退出 / 取消中断。
 * collectEvidence：() => { lines }（lark-failure-evidence.readFailureEvidence 的闭包），只在要发失败卡时调。
 * signal：本次执行的合成中断信号；因任务总预算到点（TimeoutError）中断的按 timeout 归类，而不是「被中断（不算失败）」。
 * onFail：判为直接失败、失败卡发出后调（自修工单开单，lark-self-fix.maybeOpenSelfFix），参数
 *   { fingerprint, playbook, recentSameFingerprint, priorAttempts }；出错只记日志，不影响失败卡。
 * @returns {Promise<{ action: 'requeue' | 'fail' | 'ignore', fingerprint?: object, playbook?: object }>}
 */
export const handleTaskFailure = async ({
  client,
  task,
  error,
  reportStatus,
  auditContext,
  collectEvidence = null,
  signal = null,
  onFail = null,
  enabled = true,
  dir = failuresDir,
  repo = FAILURE_LEDGER_KEY,
}) => {
  if (!enabled) {
    await reportStatus('failed', buildFailureResult(task, error))
    return { action: 'fail' }
  }
  const message = error instanceof Error ? error.message : String(error)
  const deadlineExceeded = Boolean(signal?.aborted) && signal.reason?.name === 'TimeoutError'
  const fingerprint = fingerprintFailure(error, { deadlineExceeded })
  let playbook = { action: 'fail', reason: fingerprint.label, recurring: false }
  let recentSame = 0
  let priorAttempts = 0
  try {
    priorAttempts = selfHealAttemptsForTask({ dir, repo, taskId: task.id }).length
    recentSame = countRecentFingerprint({ dir, repo, fingerprint: fingerprint.fingerprint })
    playbook = decideFailurePlaybook({ fingerprint, priorAttempts, recentSameFingerprint: recentSame })
  } catch (ledgerError) {
    console.warn(`[lark-worker] ${task.id} 读失败台账出错（按直接失败处理）：${short(ledgerError)}`)
  }
  updateTaskAudit(auditContext, { failureFingerprint: fingerprint, failurePlaybook: playbook })
  const record = (action) => recordFailure({ dir, repo, taskId: task.id, epoch: task.epoch, fingerprint, action, reason: playbook.reason, message, recurring: playbook.recurring })

  if (playbook.action === 'requeue') {
    let requeued = false
    try {
      requeued = Boolean(await client.releaseTask(task.id))
    } catch (releaseError) {
      console.warn(`[lark-worker] ${task.id} 自愈重排队失败（改报失败）：${short(releaseError)}`)
    }
    if (requeued) {
      record('requeue')
      console.warn(`[lark-worker] ${task.id} 自愈：${playbook.reason}，已交还队列重领（指纹 ${fingerprint.fingerprint}）`)
      updateTaskAudit(auditContext, { status: 'self_heal_requeued', error: message })
      return { action: 'requeue', fingerprint, playbook }
    }
    playbook = { ...playbook, action: 'fail' }
  }

  let evidenceLine = null
  if (collectEvidence) {
    try {
      const evidence = collectEvidence()
      evidenceLine = formatFailureEvidence(evidence)
      updateTaskAudit(auditContext, { failureEvidence: evidence })
    } catch (evidenceError) {
      console.warn(`[lark-worker] ${task.id} 收集失败旁证出错（忽略）：${short(evidenceError)}`)
    }
  }
  if (playbook.action !== 'ignore') record('fail')
  const fingerprintLine = formatFingerprintLine({ fingerprint, playbook, recentSameFingerprint: recentSame })
  await reportStatus('failed', buildFailureResult(task, error, { evidenceLine, fingerprintLine }))
  if (onFail && playbook.action === 'fail') {
    try {
      await onFail({ fingerprint, playbook, recentSameFingerprint: recentSame, priorAttempts })
    } catch (hookError) {
      console.warn(`[lark-worker] ${task.id} 失败后处置出错（忽略）：${short(hookError)}`)
    }
  }
  return { action: playbook.action, fingerprint, playbook }
}
