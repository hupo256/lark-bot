/**
 * Lark Worker 的变更分级 + 规范闸层：改动分级（L1/L2）、AI 自报改动与真实 diff 的交叉校验、
 * done 结果可信度评估，以及无人值守规范闸（扫 diff 新增行的失效裸色类 / arbitrary value 并定向纠正）。
 * 判定部分为纯函数便于单测；enforceCodeQuality 触碰 git 与 AI executor。
 */

import { formatViolations, scanDiffForViolations } from './lark-lint-diff.mjs'
import { execAiExecutor, resolveAiExecutor } from './lark-ai-executor.mjs'
import { gitAt } from './lark-worker-git.mjs'
import { repoRoot } from './lark-worker-env.mjs'
import { taskLine } from './lark-worker-results.mjs'

// 变更分级探测（L1/L2）：命中契约 / 共享 / 类型敏感路径即 L2+（需 type-check 兜底）。纯函数便于单测。
// L2+ 触发：schema 契约、mapper 映射、/api/ 层、.d.ts 声明、跨包 packages/ 改动。
const L2_PATH_RULES = [
  { re: /\.schema\./i, reason: 'schema 契约文件' },
  { re: /mapper/i, reason: 'mapper 映射层' },
  { re: /\/api\//i, reason: 'api 层' },
  { re: /\.d\.ts$/i, reason: '类型声明 .d.ts' },
  { re: /(?:^|\/)packages\//i, reason: '跨包 packages/ 共享改动' },
]
export const detectChangeTier = (files = []) => {
  const reasons = []
  for (const file of files) {
    for (const rule of L2_PATH_RULES) {
      if (rule.re.test(String(file || '')) && !reasons.includes(rule.reason)) reasons.push(rule.reason)
    }
  }
  return { tier: reasons.length ? 'L2' : 'L1', reasons }
}

// AI 自报 changedFiles 与真实 `git diff --name-only HEAD` 交叉校验：归一路径后比较，actual 为准
// （AI 可能漏报真改的文件，也可能虚报没改的文件）。纯函数便于单测。
export const crossCheckChangedFiles = ({ reported = [], actual = [] } = {}) => {
  const norm = (list) => new Set((list || []).map((f) => String(f || '').trim().replace(/^\.\//, '')).filter(Boolean))
  const reportedSet = norm(reported)
  const actualSet = norm(actual)
  const missingFromReport = [...actualSet].filter((f) => !reportedSet.has(f)) // 真改了但 AI 没报
  const notActuallyChanged = [...reportedSet].filter((f) => !actualSet.has(f)) // AI 报了但没真改
  return {
    actualEmpty: actualSet.size === 0,
    reportedEmpty: reportedSet.size === 0,
    missingFromReport,
    notActuallyChanged,
    consistent: missingFromReport.length === 0 && notActuallyChanged.length === 0,
  }
}

// 已声明 done 的结果可信度评估：只读任务（状态/status）豁免；否则用真实改动交叉校验 + 分级探测，
// 产出人工可见 notes。done 但工作区零改动 → 判不可信（无改动=无修复=不可信，降级需复核）。
//
// L2（契约/共享高风险：schema / mapper / api / .d.ts / packages）改动而 AI 自报 checks 里无 type-check
// 证据 → 同样判不可信、降级人工复核，**而不是**只挂 note。理由：这类改动最可能静默改坏调用方，
// 实施 prompt 已明确要求 L2/L3 在触达包跑一次 tsc（见 buildValidationRequirements），故「没跑」是真信号
// 而非措辞噪音。注意这与「我们自己按整包 tsc 的 exit code 硬判」不同——那会被历史基线红误伤所有 L2 改动，
// 我们从不那么做；这里只校验 AI 是否给出了它自己应当产出的 type-check 证据。纯函数便于单测。
const TYPECHECK_RE = /tsc|type[\s-]?check|typecheck/i
export const assessDoneResult = ({ reportedChangedFiles = [], actualChangedFiles = [], checks = [], readOnly = false } = {}) => {
  if (readOnly) return { trustworthy: true, notes: [], tier: 'L1' }
  const cross = crossCheckChangedFiles({ reported: reportedChangedFiles, actual: actualChangedFiles })
  const { tier, reasons } = detectChangeTier(actualChangedFiles)
  const notes = []
  if (cross.actualEmpty) {
    return { trustworthy: false, tier, notes: ['AI 报告 done 但工作区无任何改动（git diff HEAD 为空），无法确认已真正修复，需人工复核'] }
  }
  if (cross.missingFromReport.length) notes.push(`AI 漏报改动文件：${cross.missingFromReport.join('、')}`)
  if (cross.notActuallyChanged.length) notes.push(`AI 自报改了但实际未改：${cross.notActuallyChanged.join('、')}`)
  if (tier === 'L2' && !checks.some((c) => TYPECHECK_RE.test(String(c || '')))) {
    notes.push(`L2 契约/共享改动（${reasons.join('、')}）未见 type-check 证据：契约/类型改动不跑 type-check 无法确认没改坏调用方，不能按已完成处理；请在触达包跑一次 \`tsc --noEmit\` 并在 checks 注明后重跑`)
    return { trustworthy: false, tier, notes }
  }
  return { trustworthy: true, tier, notes }
}

// 无人值守规范闸：扫本次 diff 新增行的 arbitrary value / 失效裸色类；有违规先让 AI 定向纠正一次。
// 纠正后仍残留时分两桶：失效裸色类（invalid-color-class，一定是 bug 且必可修）为「硬」违规——不判 done、
// 降级人工；其余（arbitrary value 等，可能无对应 token）为「软」违规——附清单到完成消息供人工 review，不静默放过。
const HARD_GATE_KINDS = new Set(['invalid-color-class'])
export const splitViolations = (violations) => ({
  hardRemaining: violations.filter((v) => HARD_GATE_KINDS.has(v.kind)),
  softRemaining: violations.filter((v) => !HARD_GATE_KINDS.has(v.kind)),
})

const buildLintFixPrompt = (cwd, violations) =>
  `你刚在 ${cwd} 完成一处修复，但触碰了编码规范红线，请**只修正下列 class**（不要改动其它逻辑/文案/结构，改完不必回写 Gateway）：

${formatViolations(violations)}

规则：Tailwind 一律用 packages/config/tailwind-preset.js 里定义的 token，不用 arbitrary value \`[..]\`；颜色必须是 preset 里真实存在的类（未知类如 text-green 会被 Tailwind 静默丢弃、根本不生效）。改完用 \`git diff\` 自查这些点已全部换成 token。`

export const enforceCodeQuality = async (workerConfig, task, workContext, auditContext) => {
  const cwd = workContext.cwd || repoRoot
  const diffOf = () => {
    gitAt(cwd, ['add', '-A', '-N']) // 让新增文件也进 diff（intent-to-add，非破坏性）
    // 用 `git diff HEAD`（工作区 vs HEAD）而非裸 `git diff`（仅未暂存）：AI 若自行 git add/commit，
    // 裸 diff 会扫到 0 违规静默放行。口径与 snapshotWorktree 的 `git diff HEAD` 统一。
    return gitAt(cwd, ['diff', 'HEAD']).stdout || ''
  }
  let violations = scanDiffForViolations(diffOf())
  if (!violations.length) return { ok: true, remaining: [], hardRemaining: [], softRemaining: [] }

  console.warn(`[lark-worker] 规范闸命中 ${violations.length} 处违规，触发定向纠正 pass（${task.id}）`)
  try {
    await execAiExecutor({
      executor: resolveAiExecutor(workerConfig, task),
      promptText: buildLintFixPrompt(cwd, violations),
      cwd,
      codexModel: workerConfig.localConfig?.codexModel,
      codexReasoningEffort: workerConfig.localConfig?.codexReasoningEffort,
      auditLogPath: auditContext?.logPath,
    })
  } catch (error) {
    console.warn(`[lark-worker] 规范纠正 pass 执行异常（保留原改动）：${error.message}`)
  }

  violations = scanDiffForViolations(diffOf())
  return { ok: violations.length === 0, remaining: violations, ...splitViolations(violations) }
}

// 规范硬闸命中（残留失效裸色类）→ done 降级为失败待人工的结果文案。色类会被 Tailwind 静默丢弃、
// 根本不生效，属可修的确定性 bug，不能带病判完成。
export const buildQualityBlockedResult = (task, hardRemaining) =>
  `处理失败。\n1. 任务：${taskLine(task.summary || task.text || 'fix', '群内反馈的问题')}；\n2. 改动引入 ${hardRemaining.length} 处失效裸色类（Tailwind 会静默丢弃、根本不生效），定向纠正后仍残留，不能按已完成处理；\n3. 需人工把这些类换成项目语义 token（text-sem-g / text-sem-r / text-1..8 等）后再重跑：\n${formatViolations(hardRemaining)}`
