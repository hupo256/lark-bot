/**
 * Lark AI executor 的结构化结果解析层：读取 codex/claude 落盘的结果 JSON 并逐字段校验，
 * 以及 claude 专用的「把结果写入指定文件」prompt 指令。校验失败即抛，交由 executor 归因。
 */

import { readFileSync } from 'node:fs'

import { AI_RESULT_STATUSES, FAILURE_KINDS, TASK_STATES, ROOT_CAUSE_LAYERS, isOffFrontendRootCause } from './lark-status-meta.mjs'

// 非空字符串数组：checks / changedFiles / requirements / 分析 blockers 的公共校验口径。
const isNonEmptyStringArray = (value) =>
  Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim())

const readResultJson = (resultPath, invalidMessage) => {
  try {
    return JSON.parse(readFileSync(resultPath, 'utf8'))
  } catch (error) {
    throw new Error(`${invalidMessage}：${error.message}`)
  }
}

const executorLabel = (executor = 'codex') => String(executor).charAt(0).toUpperCase() + String(executor).slice(1)

export const parseStructuredAiResult = (resultPath, executor = 'codex') => {
  const label = executorLabel(executor)
  const result = readResultJson(resultPath, `${label} 未返回合法结构化结果`)
  if (!AI_RESULT_STATUSES.includes(result.status) || typeof result.summary !== 'string' || !result.summary.trim()) {
    throw new Error(`${label} 结构化结果缺少合法 status/summary`)
  }
  if (!isNonEmptyStringArray(result.checks)) {
    throw new Error(`${label} 结构化结果 checks 必须是字符串数组`)
  }
  if (!isNonEmptyStringArray(result.changedFiles)) {
    throw new Error(`${label} 结构化结果 changedFiles 必须是字符串数组`)
  }
  if (!isNonEmptyStringArray(result.warnings)) {
    throw new Error(`${label} 结构化结果 warnings 必须是字符串数组`)
  }
  if (result.status === 'done_with_warnings' && !result.warnings.length) {
    throw new Error(`${label} done_with_warnings 结构化结果必须列出 warnings`)
  }
  if (result.status === 'done' && result.warnings.length) {
    throw new Error(`${label} done 结构化结果存在 warnings 时必须改用 done_with_warnings`)
  }
  // waiting_confirmation / blocked 必须带 blockers；owner 为可选补充字段。
  // 注意：此处 blockers 允许空字符串（与分析结果口径不同），故不复用 isNonEmptyStringArray。
  if (result.blockers != null && (!Array.isArray(result.blockers) || !result.blockers.every((item) => typeof item === 'string'))) {
    throw new Error(`${label} 结构化结果 blockers 必须是字符串数组`)
  }
  if (['waiting_confirmation', 'blocked'].includes(result.status) && !result.blockers?.length) {
    throw new Error(`${label} ${result.status} 结构化结果必须列出 blockers`)
  }
  if (result.owner != null && typeof result.owner !== 'string') {
    throw new Error(`${label} 结构化结果 owner 必须是字符串`)
  }
  if (result.failureKind != null && !FAILURE_KINDS.includes(result.failureKind)) {
    throw new Error(`${label} 结构化结果 failureKind 必须是 tool/env/permission/requirement 之一`)
  }
  if (result.nextStep != null && typeof result.nextStep !== 'string') {
    throw new Error(`${label} 结构化结果 nextStep 必须是字符串`)
  }
  // 防线1/2/4：诊断状态机 + 根因层 + 后端根因证据链（均向后兼容，字段缺省即旧形态，不强制缺陷分流）。
  if (result.taskState != null && !TASK_STATES.includes(result.taskState)) {
    throw new Error(`${label} 结构化结果 taskState 必须是 ${TASK_STATES.join('/')} 之一`)
  }
  if (result.rootCauseLayer != null && !ROOT_CAUSE_LAYERS.includes(result.rootCauseLayer)) {
    throw new Error(`${label} 结构化结果 rootCauseLayer 必须是 ${ROOT_CAUSE_LAYERS.join('/')} 之一`)
  }
  validateEvidenceForRootCause(result, label)
  validateBackendRootCauseCompletion(result, label)
  return result
}

// 防线2：根因判定落在后端/跨层时，必须给出可核对的结构化证据链（用户所见/API 实际/契约期望/数据链首个出错位置）。
// 取不到证据就不能声称 backend-* 根因——应保持 taskState=diagnosing，禁止无证据的猜测式定性。
const EVIDENCE_FIELDS = ['userSeenValue', 'apiActualValue', 'contractExpectedValue', 'dataFlowFirstErrorLocation']
function validateEvidenceForRootCause(result, label) {
  if (!isOffFrontendRootCause(result.rootCauseLayer)) return
  const evidence = result.evidence
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new Error(`${label} rootCauseLayer=${result.rootCauseLayer}（后端/跨层根因）必须给出 evidence 证据链，取不到证据请保持 taskState=diagnosing 而非猜测定性`)
  }
  const missing = EVIDENCE_FIELDS.filter((field) => typeof evidence[field] !== 'string' || !evidence[field].trim())
  if (missing.length) {
    throw new Error(`${label} 后端/跨层根因的 evidence 缺少：${missing.join('、')}（沿 API→schema/mapper→state→UI 定位首个出错位置）`)
  }
}

// 防线4：完成门禁。taskState=completed 且根因在后端/跨层时，不得靠前端凑数关单——必须要么已转交
// （blockers 列出转交项）、要么走 awaiting_owner_fix。文件数/typecheck/截图不构成根因证据，故不放行。
function validateBackendRootCauseCompletion(result, label) {
  if (result.taskState !== 'completed' || !isOffFrontendRootCause(result.rootCauseLayer)) return
  const handedOff = Array.isArray(result.blockers) && result.blockers.some((item) => typeof item === 'string' && item.trim())
  if (!handedOff) {
    throw new Error(`${label} 根因在 ${result.rootCauseLayer}（后端/跨层），不能标 taskState=completed 关单：请改用 awaiting_owner_fix，并在 blockers 列出已转交后端的缺陷项；前端不得自行补偿凑数`)
  }
}

// claude CLI 没有 codex 的 --output-schema/--output-last-message，改由 prompt 末尾给出具体结果文件路径，
// 指示它把符合约定字段的 JSON 写进该文件作为最后一步；Worker 随后按结构化结果统一回写（同 codex）。
export const buildClaudeResultFileInstruction = (resultPath) => `结果文件路径：${resultPath}
把上面「完成后」要求的最终结果 JSON 用你的文件写入能力覆盖写入这个文件，作为本次任务的最后一步；只写 JSON 本身，不要 markdown 代码围栏、不要多余文字。这一步是 Worker 判定任务结果的唯一依据，务必完成。`

export const parseStructuredAnalysisResult = (resultPath, executor = 'codex') => {
  const label = executorLabel(executor)
  const result = readResultJson(resultPath, `${label} 未返回合法分析结果`)
  if (!['ready', 'blocked'].includes(result.status) || typeof result.summary !== 'string' || !result.summary.trim()) {
    throw new Error(`${label} 分析结果缺少合法 status/summary`)
  }
  if (!Array.isArray(result.applicableRules) || !result.applicableRules.every((item) =>
    item && typeof item.source === 'string' && item.source.trim() && typeof item.application === 'string' && item.application.trim())) {
    throw new Error(`${label} 分析结果 applicableRules 必须包含 source/application`)
  }
  if (!isNonEmptyStringArray(result.requirements)) {
    throw new Error(`${label} 分析结果 requirements 必须是字符串数组`)
  }
  if (!isNonEmptyStringArray(result.blockers)) {
    throw new Error(`${label} 分析结果 blockers 必须是字符串数组`)
  }
  if (result.status === 'blocked' && !result.blockers.length) {
    throw new Error(`${label} blocked 分析结果必须列出 blockers`)
  }
  return result
}

// @指定负责人消息的前置意图分类。这里只决定是否进入任务队列，不承载任何实施结论。
export const parseStructuredIntentResult = (value, executor = 'codex') => {
  const label = executorLabel(executor)
  const result = typeof value === 'string'
    ? (() => {
        try {
          // Claude CLI 的 --json-schema 结果会放在 envelope.result，且偶发地把完整
          // JSON 包成 Markdown 代码围栏。只兼容“整段即 JSON”的窄形态；夹带解释文字仍拒绝。
          const trimmed = value.trim()
          const fenced = trimmed.match(/^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i)
          return JSON.parse(fenced ? fenced[1].trim() : trimmed)
        } catch (error) {
          throw new Error(`${label} 未返回合法意图分类结果：${error.message}`)
        }
      })()
    : value
  if (!result || !['bug', 'requirement', 'ignore'].includes(result.decision)) {
    throw new Error(`${label} 意图分类结果缺少合法 decision`)
  }
  if (!['high', 'medium', 'low'].includes(result.confidence)) {
    throw new Error(`${label} 意图分类结果缺少合法 confidence`)
  }
  if (typeof result.summary !== 'string' || !result.summary.trim()) {
    throw new Error(`${label} 意图分类结果缺少 summary`)
  }
  if (typeof result.reason !== 'string' || !result.reason.trim()) {
    throw new Error(`${label} 意图分类结果缺少 reason`)
  }
  return result
}
