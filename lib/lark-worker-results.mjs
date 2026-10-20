/**
 * Lark Worker 的结果文案层（纯函数，零副作用）：把各类结局（阻塞 / 无回写 / 技术失败）
 * 转成群内可读的定型文案，并对 Worker 层失败做归因分类。
 */

import { FAILURE_KIND_LABELS } from './lark-status-meta.mjs'

// 取文本首个非空行（用于把多行任务正文压成一句摘要）。
const firstNonEmptyLine = (text) => (text || '').split('\n').find((line) => line.trim())?.trim() || ''
// 任务摘要行：首个非空行，空则用 fallback，统一截断到 80 字。多个结果/文案构建器复用。
export const taskLine = (source, fallback) => (firstNonEmptyLine(source) || fallback).slice(0, 80)

// 普通群完成卡只展示协作方需要的结果证据。规则扫描详情、deliveryAuthority 等内部治理字段
// 留在审计和日志中，避免把实现口径与解析噪音暴露给业务群。
// scopeSection（范围契约 vs 实测）排在结论之后、系统实测之前：先看「声明改哪些 / 实际改了哪些」，再看规模与终检。
export const appendPublicCompletionEvidence = ({ resultText, changeLabel, figmaLabel, workerVerificationLine, scopeSection = null }) => [
  resultText,
  scopeSection,
  `**系统实测**：${changeLabel} · Figma 核验 ${figmaLabel}`,
  workerVerificationLine ? `**Worker 终检**：${workerVerificationLine}` : null,
].filter(Boolean).join('\n')

// 第一阶段（只读分析）判定阻塞时，把分析结论转成 blocked 结果对象（不进入实施阶段）。四种执行器同一口径。
export const blockedResultFromAnalysis = (analysis) => ({
  status: 'blocked',
  summary: analysis.summary,
  blockers: analysis.blockers,
  checks: ['第一阶段已只读完成需求、规则与修改范围核对；未进入代码实施阶段'],
  changedFiles: [],
})

// AI 进程退出但没有显式回写 done/failed 时的结果文案：一律判失败待人工复核。
// 不分任务类型都不能兜底谎报「已完成」——无回写 = 无验证 = 不可信（AI 可能中途放弃/崩溃/未按要求回调）。
export const buildNeedsReviewResult = (task) =>
  `处理失败。\n1. 任务：${taskLine(task.text, '群内反馈的问题')}；\n2. AI 已执行结束但未显式回写完成结果，无法确认改动是否成功或已验证；\n3. 需人工查看 Worker/AI 日志与分支改动后再定，禁止按已完成处理。`

// AI 判完成、但收尾提交没成功时的结果文案。这条路径**不能**报 done：群里说「已完成」必须等价于
// 「改动已落到分支上」，否则人按完成处理、改动只躺在某个 worktree 的工作区里，下一次 retry/清理就没了。
// 保留 AI 的原始结论（人需要它判断价值），后面接上未落盘的事实与人工收尾步骤。
export const buildCommitFailedResult = ({ task, resultText, cwd, reason }) =>
  `${resultText}\n\n⛔ 但改动未能提交到分支，故不按已完成处理。\n1. 任务：${taskLine(task.text, '群内任务')}；\n2. 原因：${reason}；\n3. 改动仍在 ${cwd} 的工作区里（现场已保留，未删除、未重置）；\n4. 请人工进入该目录检查并手动提交；确认无价值可直接丢弃。`

// Worker 对最终工作树实跑的终检失败：不能继续提交，也不能让 AI 自报的 checks 覆盖这个事实。
export const buildVerificationFailedResult = ({ task, receipt, cwd }) => {
  const failures = (receipt?.checks || [])
    .filter((check) => !check.ok)
    .map((check) => `${check.id}: ${check.stderr || `exit ${check.exitCode ?? 'unknown'}`}`)
    .join('；')
  return `处理失败。\n1. 任务：${taskLine(task.text, '群内任务')}；\n2. Worker 对最终内容的独立终检未通过，未提交、未按完成处理；\n3. 失败项：${(failures || '终检回执缺失').slice(0, 500)}；\n4. 改动仍保留在 ${cwd}，修正后需重新执行终检。`
}

// Worker 层技术性失败归因（preflight / timeout / worktree / exit code）：把恒定的「Worker 执行异常」

// 换成定型的失败类型 + 下一步。纯函数便于单测。返回 { failureKind, kindLabel, nextStep }。
// 报错的固定前缀：执行器非零退出（`exec exited with code N：<模型输出尾部>`）只取到退出码为止。尾部里的 inputTokens /
// git diff / tsc 会把失败归类带偏、让指纹每次不同（aven 2026-10-20 review A7）。失败指纹（lark-failure-fingerprint）共用。
// 放在这里而不是指纹模块：本模块在 gateway 闭包里，指纹模块的正则含 spawnSync 字样会触发纯度闸。
const EXEC_EXIT_RE = /exec exited with code -?\d+/
export const failureHead = (message) => {
  const text = String(message || '')
  const hit = EXEC_EXIT_RE.exec(text)
  return hit ? text.slice(0, hit.index + hit[0].length) : text
}

// 只看报错的固定前缀（见 failureHead）。
export const classifyWorkerFailure = (error) => {
  const message = failureHead(error instanceof Error ? error.message : String(error || '')).toLowerCase()
  if (/timeout|超时|sigterm|sigkill/.test(message)) {
    return { failureKind: 'tool', kindLabel: FAILURE_KIND_LABELS.tool, nextStep: '查看 AI 日志确认是否卡死；可调大 LARK_WORKER_AI_TIMEOUT_MS 或拆小任务后重试' }
  }
  if (/登录|login|unauthor|forbidden|permission|\btoken\b/.test(message)) {
    return { failureKind: 'permission', kindLabel: FAILURE_KIND_LABELS.permission, nextStep: '在本机完成对应 AI CLI 登录（如 `codex login`）后重试' }
  }
  if (/enoent|not found|command not found|缺.*二进制|no such file|worktree|git/.test(message)) {
    return { failureKind: 'env', kindLabel: FAILURE_KIND_LABELS.env, nextStep: '检查本机 AI CLI / 依赖 / worktree / git 状态后重试' }
  }
  return { failureKind: 'tool', kindLabel: FAILURE_KIND_LABELS.tool, nextStep: '查看本地任务记录与 Worker/AI 日志定位后重试' }
}

// evidenceLine：失败卡旁证（lark-failure-evidence.formatFailureEvidence），放在失败类型前面——
// 人先看到「活可能已经干成」，再看错误类型，而不是反过来（自愈环 1.6）。
export const buildFailureResult = (task, error, { evidenceLine = null, fingerprintLine = null } = {}) => {
  const message = error instanceof Error ? error.message : String(error)
  const { kindLabel, nextStep } = classifyWorkerFailure(error)
  const lines = [`1. 任务：${taskLine(task.text, '群内任务')}`]
  if (evidenceLine) lines.push(`${lines.length + 1}. ${evidenceLine}`)
  lines.push(`${lines.length + 1}. 失败类型：${kindLabel}`)
  if (fingerprintLine) lines.push(`${lines.length + 1}. ${fingerprintLine}`)
  lines.push(`${lines.length + 1}. 下一步：${nextStep}。`)
  if (message) lines.push(`${lines.length + 1}. 错误：${message.slice(0, 160)}`)
  return `处理失败。\n${lines.join('；\n').replace(/。；\n/g, '。\n')}`
}
