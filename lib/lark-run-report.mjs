/**
 * 执行结束 → 回写网关的内容（从 lark-task-runner 拆出，10-21 架构加固 P1）：成功路径的附带字段与核验闸失败路径
 * 都从这里组装，runner 与黄金对话测试共用同一份，闸失败时丢了什么、带了什么有测试钉住。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_BROWSER_PATTERN, applyRunEvidence, collectRunEvidence, normalizeReport } from './lark-report-render.mjs'
import { claudeProjectKey } from './lark-task-runner-support.mjs'
import { gatewayStatusForAiStatus } from './lark-status-meta.mjs'
import { integrationReport } from './lark-task-finish.mjs'

// 执行器结果里要随回写带给网关的字段（群回复、待跟进、实测记录、合回情况…）。
// change：改动有没有提交（核验闸 / schema 实测 / 提交失败时 committed=false，记下是哪一道）；投递据此决定回答发不发。
// report：结构化群回复（10-21 P6），按本轮会话里真跑过的探针 / 浏览器核实 evidence（evidence=null 读不到就不核）。
// ownerNotes：只给负责人看的提醒（私聊里固定显示，不受结论正文 6 行截断影响），如截图没打开看（#62）。
export const buildReportExtras = ({ aiResult, actualChangedFiles = [], scopeRequest = null, integration = null, taskBranch = null, change = null, evidence = null, ownerNotes = [] }) => ({
  change,
  ownerNotes: ownerNotes.filter(Boolean),
  report: applyRunEvidence(normalizeReport(aiResult.report), evidence),
  noChangeReason: aiResult.noChangeReason,
  scopeRequest,
  // 群里的人话回复 + 待跟进清单（外部群只发这两样，详细卡只给负责人）。
  // 群回复不截断（aven 2026-10-22：写短 + 细节进 detailDoc，发群前超长自动转文档，见 lark-detail-doc）。
  groupReply: typeof aiResult.groupReply === 'string' ? aiResult.groupReply.trim() : null,
  detailDoc: typeof aiResult.detailDoc === 'string' && aiResult.detailDoc.trim() ? aiResult.detailDoc.trim() : null,
  followUpDoc: typeof aiResult.followUpDoc === 'string' ? aiResult.followUpDoc.trim() : null,
  followUps: Array.isArray(aiResult.followUps) ? aiResult.followUps : null,
  changedFiles: actualChangedFiles.length ? actualChangedFiles : null,
  preChecks: Array.isArray(aiResult.preChecks) ? aiResult.preChecks.slice(0, 40) : null,
  payload: aiResult.completionClaim || aiResult.groupSilent ? { ...(aiResult.completionClaim ? { completionClaim: aiResult.completionClaim } : {}), ...(aiResult.groupSilent ? { groupSilent: true } : {}) } : null,
  integration: integrationReport(integration, { taskBranch }),
})

// 核验闸拦下（10-21 P3）：闸只管「改动能不能提交」。原来闸一拦就只回写闸的文字，执行器写好的回答与实测记录整个丢掉
//（10-20 #58：复测做完了，因为没改代码被判失败，回答没了）。现在照带，另记 change.committed=false，由投递按任务契约决定。
export const buildGateFailureReport = ({ verify, aiRun = null, evidence = null, ownerNotes = [] }) => ({
  status: verify.status,
  result: verify.text,
  extras: {
    ...(aiRun?.result ? buildReportExtras({ aiResult: aiRun.result, evidence, ownerNotes }) : {}),
    ...(verify.extra || {}),
    change: { committed: false, gate: verify.gate || null, reason: String(verify.reason || '').slice(0, 300) },
  },
})

// 不经过文档入库 / schema 实测 / 提交这几步的简单路径（黄金对话测试用；runner 的成功路径另有中间步骤）。
export const assembleRunReport = ({ aiResult, verify = null, resultText, actualChangedFiles = [], evidence = null, ownerNotes = [] }) =>
  verify && !verify.ok
    ? buildGateFailureReport({ verify, aiRun: { result: aiResult }, evidence, ownerNotes })
    : { status: gatewayStatusForAiStatus(aiResult.status), result: resultText, extras: buildReportExtras({ aiResult, actualChangedFiles, change: actualChangedFiles.length ? { committed: true } : null, evidence, ownerNotes }) }

// 本轮会话（分析 + 实施，续会话时是同一份）里真跑过的探针 / 浏览器次数；只有 claude 落盘会话记录，别的执行器返回 null（不核）。
export const runEvidenceFor = ({ aiRun, cwd, verify = null, watchFiles = [], claudeHome = join(homedir(), '.claude') }) => {
  const ids = [...new Set([aiRun?.analysisSessionId, aiRun?.sessionId, aiRun?.verifySessionId].filter(Boolean))]
  if (!ids.length || !cwd) return null
  const sessionFiles = ids.map((id) => join(claudeHome, 'projects', claudeProjectKey(cwd), `${id}.jsonl`))
  const browserPattern = verify?.browserPattern ? new RegExp(verify.browserPattern, 'i') : DEFAULT_BROWSER_PATTERN
  return collectRunEvidence({ sessionFiles, probeCommand: verify?.probeCommand || null, browserPattern, watchFiles })
}

// 任务带了截图、执行器一张都没打开（或只看了一部分）：给负责人的结果里提示一句（10-21 #62）。
export const imageAttachmentPaths = (task) => (task?.attachments || []).filter((item) => item?.type === 'image' && item.localPath).map((item) => item.localPath)
export const unopenedImagesNote = ({ evidence, total }) => {
  const missed = evidence?.unopenedFiles?.length || 0
  if (!total || !missed) return null
  return `${missed === total ? `任务带的 ${total} 张截图执行器一张都没打开看` : `任务带的 ${total} 张截图有 ${missed} 张执行器没打开看`}，结论可能漏了截图里的信息（比如原型里已有的需求），发群前请过一眼`
}

// runner 用：本轮会话证据（探针 / 浏览器调用、截图有没有打开）只取一次，回写的几条路径共用；非仓库任务不取。
export const collectRunOutcomeEvidence = ({ task, aiRun, cwd, verify = null }) => {
  const imagePaths = imageAttachmentPaths(task)
  const runEvidence = task?.repo ? runEvidenceFor({ aiRun, cwd, verify, watchFiles: imagePaths }) : null
  return { runEvidence, ownerNotes: [unopenedImagesNote({ evidence: runEvidence, total: imagePaths.length })].filter(Boolean) }
}
