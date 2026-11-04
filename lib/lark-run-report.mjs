/**
 * 执行结束 → 回写网关的结构化结果 task.outcome（worker only；11-01 对话层，母本是 falive lark-run-report）。
 *
 * 为什么：出口要说人话，就不能再靠正则去「读」结果文本（falive I4）；worker 把 summary / blockers / report / 分支 / 改了几个文件
 * 一次装成结构化 outcome 随 status 回写，网关只渲染。文本 result 仍并存（审计、lark-bot status、旧任务兜底）。
 * 三件事：
 *   · buildOutcome：AI 结果 + 实际改动 + 本轮会话证据 → outcome；report 里自称实测（pre / browser）但会话里没跑过的降「待验证」。
 *   · mapStatusForContract：按契约把 AI 状态映射成网关状态——代答 / 实测「查不到 / 没测通」也是 done（答案就是结论），
 *     不再落 blocked 去催办（11-01 真机：「test / pre 是否一样」答对了却发成「无需改动」卡）。
 *   · outcomeFromWorkerFailure：worker 自产的失败（质量闸 / 终检 / 提交失败）也有同形 outcome。
 */

import { applyEnvCheck } from './lark-env-target.mjs'

export { checkEnvTarget } from './lark-env-target.mjs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_BROWSER_PATTERN, applyRunEvidence, collectProbeLog, collectRunEvidence, normalizeReport } from './lark-report-render.mjs'
import { claudeProjectKey } from './lark-task-runner-support.mjs'
import { gatewayStatusForAiStatus } from './lark-status-meta.mjs'

// detailDoc 是结果顶层字段，但执行器常把它写进 report 里（falive #88）。两处都认，顶层优先。
const docText = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null)
export const detailDocOf = (result) => docText(result?.detailDoc) || docText(result?.report?.detailDoc)

const firstLine = (text) => String(text || '').split('\n').find((line) => line.trim())?.trim() || null

// envCheck：点名环境 vs 本轮真打过的环境（lib/lark-env-target.checkEnvTarget）；不匹配时结论前明说、实测通过降成待验证。
export const buildOutcome = ({ aiResult, status = null, actualChangedFiles = [], change = null, evidence = null, warnNotes = [], envCheck = null }) => ({
  kind: 'ai',
  summary: docText(aiResult?.summary),
  nextStep: docText(aiResult?.nextStep),
  failureKind: aiResult?.failureKind ?? null,
  owner: docText(aiResult?.owner),
  warnings: [...(Array.isArray(aiResult?.warnings) ? aiResult.warnings : []), ...warnNotes].filter(Boolean),
  blockers: Array.isArray(aiResult?.blockers) ? aiResult.blockers.filter(Boolean) : [],
  noChangeReason: aiResult?.noChangeReason ?? null,
  taskState: aiResult?.taskState ?? null,
  rootCauseLayer: aiResult?.rootCauseLayer ?? null,
  report: applyEnvCheck(applyRunEvidence(normalizeReport(aiResult?.report), evidence), envCheck),
  groupReply: docText(aiResult?.groupReply),
  detailDoc: detailDocOf(aiResult),
  followUps: Array.isArray(aiResult?.followUps) ? aiResult.followUps : null,
  probes: evidence?.probes?.length ? evidence.probes : null,
  changedFiles: actualChangedFiles.length ? actualChangedFiles : null,
  change: change ? { committed: Boolean(change.committed), gate: change.gate || null, reason: change.reason || null } : null,
  groupSilent: aiResult?.groupSilent === true,
  text: null,
  aiStatus: aiResult?.status || status || null,
})

// worker 自产失败 / 阻塞（质量闸、终检、提交失败、needs_review、需求闸）：summary 一句 + 可选 blockers / nextStep。
export const outcomeFromWorkerFailure = ({ summary, blockers = [], nextStep = null, kind = 'worker', change = null, failureKind = null }) => ({
  kind,
  summary: docText(summary),
  nextStep: docText(nextStep),
  failureKind,
  owner: null,
  warnings: [],
  blockers: blockers.filter(Boolean),
  noChangeReason: null,
  taskState: null,
  rootCauseLayer: null,
  report: null,
  groupReply: null,
  detailDoc: null,
  followUps: null,
  changedFiles: null,
  change: change ? { committed: Boolean(change.committed), gate: change.gate || null, reason: change.reason || null } : null,
  groupSilent: false,
  text: null,
})

// 按契约映射状态（plan §4.3）。answerLike = answer / verification：答案就是交付物，查不到 / 没测通照样 done，answer 写明；
// failed 只留工具 / 环境 / 权限类（requirement 类失败对代答没意义，也转 done）。change / ops / 无契约：原样。
export const mapStatusForContract = ({ contract, aiStatus, outcome }) => {
  const deliverable = contract?.deliverable || null
  const gateway = gatewayStatusForAiStatus(aiStatus)
  if (deliverable !== 'answer' && deliverable !== 'verification') return { status: gateway, outcome }
  const next = { ...outcome }
  const ensureAnswer = (fallback) => {
    if (next.report?.answer || next.report?.items?.length || next.groupReply) return
    next.report = { subject: next.report?.subject || null, answer: next.summary || fallback, items: [] }
  }
  if (aiStatus === 'done' || aiStatus === 'done_with_warnings') {
    ensureAnswer('已经看过了，结论见上。')
    return { status: 'done', outcome: next }
  }
  if (aiStatus === 'failed' && ['tool', 'env', 'permission'].includes(outcome?.failureKind)) {
    return { status: 'failed', outcome: next }
  }
  // no_change_needed / blocked / waiting_confirmation / requirement 类 failed：结论就是「查不到 / 没测通 / 得问谁」，照常回答。
  const reasons = (next.blockers || []).filter(Boolean)
  const head = deliverable === 'verification' ? '这次没测通' : '查不到'
  const answer = next.summary || `${head}：${reasons.join('；') || '缺少必要信息'}`
  next.report = next.report?.answer
    ? next.report
    : { subject: next.report?.subject || null, answer, items: [...(next.report?.items || []), ...reasons.map((name) => ({ mark: 'not_done', name, note: '', evidence: 'none' }))] }
  next.blockers = []
  return { status: 'done', outcome: next }
}

// 本轮会话（分析 + 实施，续会话时是同一份）里真跑过的探针 / 浏览器次数；只有 claude 落盘会话记录，别的执行器返回 null（不核）。
export const runEvidenceFor = ({ aiRun, cwd, verify = null, claudeHome = join(homedir(), '.claude') }) => {
  const ids = [...new Set([aiRun?.implementation?.analysisSessionId, aiRun?.analysisSessionId, aiRun?.sessionId].filter(Boolean))]
  if (!ids.length || !cwd) return null
  const sessionFiles = ids.map((id) => join(claudeHome, 'projects', claudeProjectKey(cwd), `${id}.jsonl`))
  const browserPattern = verify?.browserPattern ? new RegExp(verify.browserPattern, 'i') : DEFAULT_BROWSER_PATTERN
  const evidence = collectRunEvidence({ sessionFiles, probeCommand: verify?.probeCommand || null, browserPattern })
  // 真发过的请求（时刻 / 命令 / 返回开头）随结果存下来，下一单接着它或引用它时带给执行器（collectProbeLog，11-04 回放 ep-1014-d74f19）。
  const probes = evidence ? collectProbeLog({ sessionFiles, probeCommand: verify?.probeCommand || null }) : []
  return probes.length ? { ...evidence, probes } : evidence
}

export const outcomeHeadline = (outcome) => firstLine(outcome?.report?.answer) || firstLine(outcome?.summary) || null
