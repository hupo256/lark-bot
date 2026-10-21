/**
 * 执行结束 → 回写网关的内容（从 lark-task-runner 拆出，10-21 架构加固 P1）：成功路径的附带字段与核验闸失败路径
 * 都从这里组装，runner 与黄金对话测试共用同一份，闸失败时丢了什么、带了什么有测试钉住。
 */

import { GROUP_REPLY_MAX_CHARS } from './lark-ai-result.mjs'
import { gatewayStatusForAiStatus } from './lark-status-meta.mjs'
import { integrationReport } from './lark-task-finish.mjs'

// 执行器结果里要随回写带给网关的字段（群回复、待跟进、实测记录、合回情况…）。
export const buildReportExtras = ({ aiResult, actualChangedFiles = [], scopeRequest = null, integration = null, taskBranch = null }) => ({
  noChangeReason: aiResult.noChangeReason,
  scopeRequest,
  // 群里的人话回复 + 待跟进清单（外部群只发这两样，详细卡只给负责人）。
  groupReply: typeof aiResult.groupReply === 'string' ? aiResult.groupReply.trim().slice(0, GROUP_REPLY_MAX_CHARS) : null,
  followUpDoc: typeof aiResult.followUpDoc === 'string' ? aiResult.followUpDoc.trim() : null,
  followUps: Array.isArray(aiResult.followUps) ? aiResult.followUps : null,
  changedFiles: actualChangedFiles.length ? actualChangedFiles : null,
  preChecks: Array.isArray(aiResult.preChecks) ? aiResult.preChecks.slice(0, 40) : null,
  payload: aiResult.completionClaim || aiResult.groupSilent ? { ...(aiResult.completionClaim ? { completionClaim: aiResult.completionClaim } : {}), ...(aiResult.groupSilent ? { groupSilent: true } : {}) } : null,
  integration: integrationReport(integration, { taskBranch }),
})

// 核验闸拦下：现状是只回写闸的结论文字，执行器写好的回答与实测记录不带（P3 改：闸只管改动能不能提交）。
export const buildGateFailureReport = ({ verify }) => ({ status: verify.status, result: verify.text, extras: verify.extra || {} })

// 不经过文档入库 / schema 实测 / 提交这几步的简单路径（黄金对话测试用；runner 的成功路径另有中间步骤）。
export const assembleRunReport = ({ aiResult, verify = null, resultText, actualChangedFiles = [] }) =>
  verify && !verify.ok
    ? buildGateFailureReport({ verify })
    : { status: gatewayStatusForAiStatus(aiResult.status), result: resultText, extras: buildReportExtras({ aiResult, actualChangedFiles }) }
