/**
 * Lark AI executor 的结构化结果解析层：读取 codex/claude 落盘的结果 JSON 并逐字段校验，
 * 以及 claude 专用的「把结果写入指定文件」prompt 指令。校验失败即抛，交由 executor 归因。
 */

import { readFileSync } from 'node:fs'

import { AI_RESULT_STATUSES } from './lark-status-meta.mjs'

// 非空字符串数组：checks / changedFiles / requirements / 分析 blockers 的公共校验口径。
const isNonEmptyStringArray = (value) =>
  Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim())

// 完成态判定与 Gateway 落态映射的单一事实源在 lark-status-meta；此处仅转出门面，既有调用方（barrel / runner）不改导入路径。
export { isCompletedAiStatus, gatewayStatusForAiStatus } from './lark-status-meta.mjs'

const readResultJson = (resultPath, invalidMessage) => {
  try {
    return JSON.parse(readFileSync(resultPath, 'utf8'))
  } catch (error) {
    throw new Error(`${invalidMessage}：${error.message}`)
  }
}

export const parseStructuredAiResult = (resultPath, executor = 'codex') => {
  const label = executor === 'claude' ? 'Claude' : 'Codex'
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
  if (result.failureKind != null && !['tool', 'env', 'permission', 'requirement'].includes(result.failureKind)) {
    throw new Error(`${label} 结构化结果 failureKind 必须是 tool/env/permission/requirement 之一`)
  }
  if (result.nextStep != null && typeof result.nextStep !== 'string') {
    throw new Error(`${label} 结构化结果 nextStep 必须是字符串`)
  }
  return result
}

// claude CLI 没有 codex 的 --output-schema/--output-last-message，改由 prompt 末尾给出具体结果文件路径，
// 指示它把符合约定字段的 JSON 写进该文件作为最后一步；Worker 随后按结构化结果统一回写（同 codex）。
export const buildClaudeResultFileInstruction = (resultPath) => `结果文件路径：${resultPath}
把上面「完成后」要求的最终结果 JSON 用你的文件写入能力覆盖写入这个文件，作为本次任务的最后一步；只写 JSON 本身，不要 markdown 代码围栏、不要多余文字。这一步是 Worker 判定任务结果的唯一依据，务必完成。`

export const parseStructuredAnalysisResult = (resultPath) => {
  const result = readResultJson(resultPath, 'Codex 未返回合法分析结果')
  if (!['ready', 'blocked'].includes(result.status) || typeof result.summary !== 'string' || !result.summary.trim()) {
    throw new Error('Codex 分析结果缺少合法 status/summary')
  }
  if (!Array.isArray(result.applicableRules) || !result.applicableRules.every((item) =>
    item && typeof item.source === 'string' && item.source.trim() && typeof item.application === 'string' && item.application.trim())) {
    throw new Error('Codex 分析结果 applicableRules 必须包含 source/application')
  }
  if (!isNonEmptyStringArray(result.requirements)) {
    throw new Error('Codex 分析结果 requirements 必须是字符串数组')
  }
  if (!isNonEmptyStringArray(result.blockers)) {
    throw new Error('Codex 分析结果 blockers 必须是字符串数组')
  }
  if (result.status === 'blocked' && !result.blockers.length) {
    throw new Error('Codex blocked 分析结果必须列出 blockers')
  }
  return result
}

// @指定负责人消息的前置意图分类。这里只决定是否进入任务队列，不承载任何实施结论。
export const parseStructuredIntentResult = (value, executor = 'codex') => {
  const label = executor === 'claude' ? 'Claude' : 'Codex'
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
