/**
 * task-runner 的纯步骤（11-02：给 createTaskRunner 开 deps 注入点时从 lark-task-runner 拆出，体量预算）：
 * worker 自产失败的 summary 行、WIP 改路由提示、审计里的 workContext 快照、完成卡的系统实测栏、收尾提交（createWorkFinalizer）。
 * 这里不直接碰 git / 审计 / 页面验证服务：都由 runner 解析好的 deps 传进来，单测用假件驱动同一段真实控制流。
 */

import { COMMIT_MODES, resolveCommitMode } from './lark-commit-policy.mjs'
import { formatWorkerVerificationLine } from './lark-final-verification.mjs'
import { appendPublicCompletionEvidence } from './lark-worker-results.mjs'

// worker 自产失败的 summary（人话出口首行）：跳过「处理失败。/ 已完成。/ 无需改动。」这类定型首行，取第一句实质内容；全是定型行就整段。
export const failureSummaryOf = (text) =>
  String(text).split('\n').find((line) => line.trim() && !/^(处理失败|已完成|无需改动)[。．]?$/.test(line.trim())) || text

// WIP 隔离提示（仅完成态）：任务开始时 worktree 有未提交改动，改动已隔离到旁支而非原分支。
// 不说清就容易被误读成「改在原分支、直接发布即可」（PR-02273）。
export const reroutedWipNote = (reroutedWip) => {
  const target = reroutedWip.originalBranch || '你的工作分支'
  return `任务开始时你的 worktree 有未提交改动，为不碰你的现场，本次从 ${target}@${reroutedWip.sourceHeadSha.slice(0, 12)} 创建隔离分支 \`${reroutedWip.hotfixBranch}\`（完全没动你的工作区）；发布前需把它 cherry-pick / merge 回 ${target}`
}

// 路由校验 + git 身份校验后写进审计的 workContext 快照（保留 WIP 改路由时已写入的 reroutedFrom* 字段）。
export const auditWorkContextPatch = ({ previous, workContext, routeValidation, gitIdentity }) => ({
  ...(previous || {}),
  cwd: workContext.cwd,
  projectId: routeValidation.projectId,
  hotfixBranch: workContext.hotfixBranch || null,
  baseRef: workContext.baseRef || null,
  sourceBranch: workContext.sourceBranch || null,
  sourceWorktree: workContext.sourceWorktree || null,
  routeValidation,
  gitIdentity,
})

// 系统实测栏：与 AI 自证（summary）分栏，给群里领导 / PM 一个 worker 亲测的事实基准
// ——真实改动规模 + 设计稿是否已由 Worker 落盘供 AI 读——防止「截图代打卡还报完成」这类虚报（PR-02172）。
export const appendCompletionEvidence = ({ resultText, task, actualChangedFiles, changeStat, workerVerification, scopeGate }) => {
  const figmaLabel = !task.figmaSpec?.referencesFigma
    ? '不涉及'
    : `✓ 已落盘设计稿 ${task.figmaSpec.specs.length} 处`
  const changeLabel = changeStat
    ? `实测改动 ${actualChangedFiles.length} 处（${changeStat}）`
    : `实测改动 ${actualChangedFiles.length} 处`
  return appendPublicCompletionEvidence({
    resultText,
    changeLabel,
    figmaLabel,
    workerVerificationLine: workerVerification ? formatWorkerVerificationLine(workerVerification) : null,
    scopeSection: scopeGate?.section || null,
  })
}

/**
 * 收尾提交器。返回的 finalizeWork({ allowCommit }) 给出 { ok, committed, reason }，**必须在回写 done 之前调用**：
 * 曾经是先回写 done（Gateway 立刻发完成卡 + 回写 bug 表），再提交，提交失败只打一行 worker 日志——
 * 群里显示「已完成」而改动只躺在工作区，人按完成处理，下一次 retry/清理就把它带走了。
 * 现在提交失败会把任务降级成 failed，群里看到的「已完成」恒等于「改动已落到分支上」。
 * 收尾只能发生一次：正常 done 路径在发完成卡之前主动调用，其余路径（失败/阻塞/异常）由 runner 的 finally 兜底；
 * state.finalized 防止两处重复收尾。state 还带 runner 开工时记下的 git 身份（executionIdentity）、终检回执（workerVerification）
 * 与本任务实测改动清单（taskChangedPaths，命中人类 worktree 时按它定向提交）。
 */
export const createWorkFinalizer = ({ task, workContext, auditContext, state, verify, deps }) => ({ allowCommit }) => {
  if (state.finalized) return { ok: true, committed: false, reason: '已收尾' }
  state.finalized = true
  if (verify) deps.stopVerifyServer(workContext.cwd) // 页面验证服务要在提交 / 删 worktree 前停掉；没配就没起过
  // 提交模式的唯一口径在 lark-commit-policy：只读 / 未完成 → none，隔离分支 → auto（全量），
  // 命中人类 worktree → scoped（只提交本任务实测清单）。这里只按模式分派，不再各自判条件。
  const { mode, reason } = resolveCommitMode({
    isolatedBranch: Boolean(workContext.hotfixBranch),
    readOnly: Boolean(workContext.readOnly),
    taskDone: Boolean(allowCommit),
  })
  let commitIdentity = null
  let commitFingerprint = null
  let outcome
  // 提交前必须仍是开工时的 root/branch/HEAD；否则说明任务执行期间有人切分支/提交，或 AI 绕过 Worker 自行提交，fail-closed。
  if (allowCommit && state.executionIdentity) {
    commitIdentity = deps.inspectWorktreeIdentity({
      cwd: workContext.cwd,
      expectedBranch: state.executionIdentity.branch,
      expectedHeadSha: state.executionIdentity.headSha,
    })
    if (!commitIdentity.ok) {
      outcome = { ok: false, committed: false, reason: `提交前 git 身份校验失败：${commitIdentity.problems.join('；')}` }
      deps.updateTaskAudit(auditContext, { commit: { mode, identity: commitIdentity, fingerprint: null, ...outcome } })
      return outcome
    }
  }
  // 终检回执绑定 HEAD + diffHash；提交前重算并比较，避免异步取消回查期间同一路径被继续修改后提交未经终检的内容。
  if (allowCommit && !workContext.readOnly) {
    if (!state.workerVerification?.ok || !state.workerVerification.fingerprint?.diffHash) {
      outcome = { ok: false, committed: false, reason: '提交前缺少已通过的 Worker 最终复验指纹' }
      deps.updateTaskAudit(auditContext, { commit: { mode, identity: commitIdentity, fingerprint: null, ...outcome } })
      return outcome
    }
    commitFingerprint = deps.inspectWorkingTreeFingerprint({
      cwd: workContext.cwd,
      expectedHeadSha: state.workerVerification.fingerprint.headSha,
      expectedDiffHash: state.workerVerification.fingerprint.diffHash,
    })
    if (!commitFingerprint.ok) {
      outcome = { ok: false, committed: false, reason: `提交前工作树指纹校验失败：${commitFingerprint.problems.join('；')}` }
      deps.updateTaskAudit(auditContext, { commit: { mode, identity: commitIdentity, fingerprint: commitFingerprint, ...outcome } })
      return outcome
    }
  }
  if (workContext.hotfixBranch) {
    outcome = deps.finalizeTempWorktree({
      path: workContext.cwd,
      branch: workContext.hotfixBranch,
      baseRef: workContext.baseRef,
      task,
      allowCommit: mode === COMMIT_MODES.auto,
    })
  } else if (mode === COMMIT_MODES.none) {
    // 命中已有 worktree：失败/阻塞一律不提交（不往你的活跃分支写半成品），改动留在工作区。
    outcome = { ok: true, committed: false, reason }
  } else {
    outcome = deps.finalizeExistingWorktree({ cwd: workContext.cwd, task, taskPaths: state.taskChangedPaths })
  }
  deps.updateTaskAudit(auditContext, { commit: { mode, identity: commitIdentity, fingerprint: commitFingerprint, ...outcome } })
  return outcome
}
