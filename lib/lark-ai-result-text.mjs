/**
 * Lark Worker 的结构化 AI 结果 → 群卡片正文渲染。从 lark-ai-executor.mjs 搬出（11-01）：执行器文件顶在 829 行只许缩，
 * 而渲染只依赖状态元数据与分诊文案，不依赖子进程；单独成文件后 task-runner / ops-run 可直接引用，不必拖进整个执行器。
 */

import { noChangeHeadline } from './lark-triage.mjs'
import { aiStatusMeta, FAILURE_KIND_LABELS, ROOT_CAUSE_LAYER_LABELS, TASK_STATE_LABELS, isOffFrontendRootCause } from './lark-status-meta.mjs'

// 执行器不参与正文渲染——它已由卡片固定字段展示，故不作入参，避免误以为结果因执行器而不同。
// 群卡片只放要点：最多 3 条、每条截到 120 字；完整依据在任务审计（triage）里。
const formatEvidenceForCard = (evidence, { maxItems = 3, maxChars = 120 } = {}) => {
  const items = evidence.slice(0, maxItems).map((item) => (item.length > maxChars ? `${item.slice(0, maxChars)}…` : item))
  const rest = evidence.length - items.length
  return `${items.join('；')}${rest > 0 ? `（另有 ${rest} 条见任务审计）` : ''}`
}

export const formatStructuredAiResult = (result, { readOnly = false } = {}) => {
  const header = readOnly && (result.status === 'done' || result.status === 'done_with_warnings')
    ? '查询完成。'
    : aiStatusMeta(result.status).header
  // 群卡片给领导/PM 看，只保留高层信息：状态 + 结论 + 待补充 + 失败类型。
  // 执行器已由卡片固定字段展示，结果正文不再重复追加。
  // 落点/验证/下一步/文件等实现细节不上卡（仍在结构化结果与 worker 日志里），owner 也不再列一行——
  // 它单独传给 reportStatus 用于卡片 @ 责任人，展示成一行文字对群里是噪声。
  const lines = [header, `1. ${result.summary.trim()}`]
  let n = 2
  // 缺陷根因分诊（防线1/2）：结果带 rootCauseLayer / taskState 时上卡，向 PM/领导显式呈现根因层与诊断状态，
  // 让「后端根因、已转交」一目了然，杜绝前端凑数关单被误读成「前端已修好」。仅在字段存在时追加。
  const layerLabel = ROOT_CAUSE_LAYER_LABELS[result.rootCauseLayer]
  const stateLabel = TASK_STATE_LABELS[result.taskState]
  if (layerLabel || stateLabel) {
    const diag = []
    if (layerLabel) diag.push(`根因层 ${layerLabel}${isOffFrontendRootCause(result.rootCauseLayer) ? '（非前端，需对应端修复）' : ''}`)
    if (stateLabel) diag.push(`诊断状态 ${stateLabel}`)
    lines.push(`${n++}. 分诊：${diag.join('，')}`)
  }
  // 分诊判定不改代码：把「为什么不改」讲给群里——判定类型 + 可核对的依据 + 相关提交 + 下一步。
  const noChangeLine = result.status === 'no_change_needed' ? noChangeHeadline(result.noChangeReason) : null
  if (noChangeLine) {
    lines.push(`${n++}. 判定：${noChangeLine}`)
    if (result.triageEvidence?.length) lines.push(`${n++}. 依据：${formatEvidenceForCard(result.triageEvidence)}`)
    if (result.relatedCommits?.length) lines.push(`${n++}. 相关提交：${result.relatedCommits.join('；')}`)
    if (result.nextStep) lines.push(`${n++}. 下一步：${result.nextStep}`)
  }
  if (result.status === 'failed' && result.failureKind) {
    lines.push(`${n++}. 失败类型：${FAILURE_KIND_LABELS[result.failureKind] || result.failureKind}`)
  }
  if ((result.status === 'waiting_confirmation' || result.status === 'blocked') && Array.isArray(result.blockers) && result.blockers.length) {
    lines.push(`${n++}. 待补充：${result.blockers.join('；')}`)
  }
  if (result.status === 'done_with_warnings' && Array.isArray(result.warnings) && result.warnings.length) {
    lines.push(`${n++}. 验证提醒：${result.warnings.join('；')}`)
  }
  return lines.join('\n')
}
