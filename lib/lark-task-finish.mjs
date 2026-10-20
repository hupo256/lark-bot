/**
 * 任务收尾里与集成分支相关的纯判定（aven 2026-10-20 review，从 lark-task-runner 拆出以便单测、守体量预算）：
 * 要不要走集成分支、合回后 task.branch 该指哪、回写给网关的 integration 摘要。
 */

// 集成分支只给临时 worktree 任务用；人类 WIP 改道（reroutedWip）的基线是原工作分支当时的 HEAD，
// 不能再被集成分支覆盖（否则 AI 看不到人类已提交的代码，完成卡又让人 cherry-pick 回原分支，两头对不上）。
export const shouldUseIntegrationBranch = ({ workContext, profile, reroutedWip = null }) =>
  Boolean(workContext?.hotfixBranch && profile?.integrationBranch && !reroutedWip)

// 合回集成分支且任务分支已删：网关读待确认清单用 `git show ${task.branch}:${followUpDoc}`（lark-repo-delivery /
// lark-group-reply），任务分支没了必失败——改让 task.branch 指向集成分支（合并提交 sha 另记在 integration.mergedSha）。
// 任务分支还在（没合 / 没删）返回 undefined：网关不覆盖 task.branch。
export const readableBranchAfterMerge = (integration) =>
  integration?.mergeBack?.ok && integration.branchCleanup?.deleted ? integration.branch : undefined

// 回写网关的 integration 摘要。mergedSha：合并提交（读取方优先用它，内容固定不随集成分支前移）；
// taskBranch / taskBranchDeleted：原任务分支名与是否已删，读取方据此知道 task.branch 已改指集成分支。
export const integrationReport = (integration, { taskBranch = null } = {}) => {
  if (!integration) return null
  const mergeBack = integration.mergeBack || null
  return {
    branch: integration.branch,
    synced: Boolean(integration.ok),
    syncReason: integration.ok ? null : integration.reason,
    mergedBack: mergeBack ? Boolean(mergeBack.ok) : null,
    mergeReason: mergeBack && !mergeBack.ok ? mergeBack.reason : null,
    mergedSha: mergeBack?.ok ? mergeBack.head || null : null,
    taskBranch: mergeBack ? taskBranch : null,
    taskBranchDeleted: mergeBack ? Boolean(integration.branchCleanup?.deleted) : null,
  }
}
