/**
 * 任务收尾里与合回负责人工作分支相关的纯判定（aven 2026-10-20 review 拆出，10-27 集成分支改为直接合回 baseRef）：
 * 合回后 task.branch 该指哪、回写给网关的 integration 摘要。
 */

// 合回 baseRef 且任务分支已删：网关读待确认清单用 `git show ${task.branch}:${followUpDoc}`（lark-repo-delivery /
// lark-group-reply），任务分支没了必失败——改让 task.branch 指向 baseRef（合并提交 sha 另记在 integration.mergedSha）。
// 任务分支还在（没合 / 没删）返回 undefined：网关不覆盖 task.branch。
export const readableBranchAfterMerge = (integration) =>
  integration?.mergeBack?.ok && integration.mergeBack.branchCleanup?.deleted ? integration.branch : undefined

// 回写网关的 integration 摘要（字段名沿用集成分支时期，网关只存不解释）。branch = 合入目标（baseRef）；
// mergedBack：true 合上了 / false 冲突要人合 / null 没走合回；pending：主目录暂不能合，worker 排队重试；
// mergedSha：合并后的 baseRef 头（读取方优先用它，内容固定不随分支前移）。
export const integrationReport = (integration, { taskBranch = null } = {}) => {
  if (!integration?.mergeBack) return null
  const mergeBack = integration.mergeBack
  return {
    branch: integration.branch,
    mergedBack: mergeBack.ok ? true : mergeBack.pending ? null : false,
    pending: Boolean(mergeBack.pending),
    mergeReason: mergeBack.ok ? null : mergeBack.reason || null,
    mergedSha: mergeBack.ok ? mergeBack.head || null : null,
    taskBranch,
    taskBranchDeleted: Boolean(mergeBack.branchCleanup?.deleted),
  }
}
