/**
 * bug 修复前的只读分诊：先回答「该不该改代码」，再决定是否进入实施阶段。
 *
 * 为什么要单独一阶段：实施阶段的执行器带写权限、提示词以编码规范开头，天然倾向「修点什么」。
 * PR-02233 多次出现两类误改——① 环境跑的是旧版本，代码里其实已修好；② 根因在后端/App，不归前端——
 * 执行器仍然改了代码，改了反而出问题。分诊阶段只读、结论四选一，只有 frontend_fix 才放行改代码，
 * 其余判定由 Worker 直接产出结果回群说明。
 */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'

import { gitAt } from './lark-worker-git.mjs'
import { readBugMetaFromText } from './lark-bugtable-parse.mjs'
import { resolveCommandType } from './lark-message.mjs'

// 不改代码的两类原因：gateway 据此决定 bug 表回写（env_version 回写「不是问题」，not_frontend 不动表格）
export const NO_CHANGE_REASONS = {
  envVersion: 'env_version',
  notFrontend: 'not_frontend',
}

// 只对 bug 表来源的修复任务分诊：群里人工交办的「改成 X」是明确指令，不该被分诊挡下。
export const shouldRunTriage = (task, workContext = {}) =>
  !workContext.readOnly && task.source === 'lark-bugtable' && resolveCommandType(task).type === 'fix'

const gitLines = (cwd, args) => {
  const out = gitAt(cwd, args)
  return out.status === 0 ? out.stdout.split('\n').map((line) => line.trim()).filter(Boolean) : null
}

// 已迁移到 web-next 的模块：这些页面 / 流程在各环境由 web-next 提供，apps/web 同名旧实现不作为分诊依据。
// 目录缺失（非 FameEX Web 仓 / 旧分支）时返回 null，事实里如实写「未知」。
const listWebNextApps = (cwd) => {
  try {
    return readdirSync(join(cwd, 'apps/web-next/src/apps'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== 'shared')
      .map((entry) => entry.name)
      .sort()
  } catch {
    return null
  }
}

// Worker 侧确定性采集的事实，交给分诊 AI 作为判断「是否只是环境没部署」的起点，而不是让它自己猜。
export const collectTriageFacts = ({ cwd, task }) => {
  const meta = readBugMetaFromText(task.text)
  const commitFormat = '--format=%h %cI %s'
  const branch = gitLines(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])?.[0] || null
  const head = gitLines(cwd, ['rev-parse', '--short', 'HEAD'])?.[0] || null
  const upstream = gitLines(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])?.[0] || null
  const unpushed = upstream ? gitLines(cwd, ['log', commitFormat, '-n', '30', `${upstream}..HEAD`]) : null
  const sinceBug = meta.createdAt
    ? gitLines(cwd, ['log', commitFormat, '-n', '30', `--since=${meta.createdAt}`, 'HEAD'])
    : null
  return { meta, branch, head, upstream, unpushed, sinceBug, webNextApps: listWebNextApps(cwd) }
}

const formatCommitList = (lines, empty) => (lines?.length ? lines.map((line) => `  - ${line}`).join('\n') : `  ${empty}`)

export const formatTriageFacts = ({ meta, branch, head, upstream, unpushed, sinceBug, webNextApps }) => [
  `- bug 编号：${meta.bugNo || '--'}；QA 测试环境：${meta.env || '--'}；涉及端口：${meta.ports || '--'}；bug 创建时间：${meta.createdAt || '--'}`,
  `- 当前分支：${branch || '--'}，HEAD ${head || '--'}；上游：${upstream || '无上游（本地分支未推送过）'}`,
  `- 尚未推送到上游的提交（这些改动一定还没部署到任何环境）：\n${upstream ? formatCommitList(unpushed, '无') : '  无上游，全部本地提交均未推送'}`,
  `- bug 创建之后进入当前分支的提交（QA 测试时环境里大概率还没有这些改动）：\n${meta.createdAt ? formatCommitList(sinceBug, '无') : '  bug 创建时间未知'}`,
  `- 已迁移到 apps/web-next 的模块（apps/web-next/src/apps）：${webNextApps?.length ? webNextApps.join('、') : '未知'}`,
].join('\n')

const NO_CHANGE_HEADLINES = {
  [NO_CHANGE_REASONS.envVersion]: '环境版本未包含修复——当前代码已符合预期，无需改代码',
  [NO_CHANGE_REASONS.notFrontend]: '非前端问题——根因不在本仓前端，无需改前端代码',
}
export const noChangeHeadline = (reason) => NO_CHANGE_HEADLINES[reason] || null

// 分诊判定 → 是否放行实施；不放行时直接给出与实施阶段同构的结果（走同一条回写 / 回群链路）。
export const resolveTriageOutcome = (triage) => {
  if (triage.verdict === 'frontend_fix') return { proceed: true }
  const base = {
    summary: triage.summary.trim(),
    taskState: null,
    rootCauseLayer: null,
    evidence: null,
    checks: triage.evidence,
    changedFiles: [],
    warnings: [],
    failureKind: null,
    nextStep: triage.nextStep || null,
    triageEvidence: triage.evidence,
    relatedCommits: triage.relatedCommits,
  }
  if (triage.verdict === 'needs_info') {
    return {
      proceed: false,
      result: { ...base, status: 'waiting_confirmation', blockers: triage.questions, owner: triage.owner || 'QA' },
    }
  }
  const noChangeReason = triage.verdict === 'already_fixed_in_code' ? NO_CHANGE_REASONS.envVersion : NO_CHANGE_REASONS.notFrontend
  return {
    proceed: false,
    result: {
      ...base,
      status: 'no_change_needed',
      blockers: null,
      owner: triage.owner || (noChangeReason === NO_CHANGE_REASONS.envVersion ? 'QA' : null),
      noChangeReason,
    },
  }
}
