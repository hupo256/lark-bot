/**
 * 合回负责人工作分支（aven 2026-10-27，取代 10-14 的集成分支 lark/falive-integration）。
 *
 * 流程：
 *   1. 开任务前把 profile.mergeBack.upstream（origin/pre）同步进主目录检出的 baseRef（feature/phase-5-test），
 *      任务分支再从 baseRef 开——看得见负责人的提交、之前 bot 合回的改动、别人合进 pre 的修复；
 *   2. 任务提交后直接把任务分支合进 baseRef（--no-ff），合完删任务分支；
 *   3. 主目录暂不能合（暂存区有内容 / 不在 baseRef / 未提交改动重叠）就排队，worker 每 2 分钟重试，合上了私信负责人；
 *      冲突不重试，记进 conflicts 私信负责人：冲突只在 docs/ 下的，负责人回「帮我合」由 bot 按语义合（lib/lark-merge-resolve.mjs），
 *      合并任务合回后删掉被它取代的原分支；代码冲突仍要人合。
 * 推上 pre 仍由负责人走 MR（或私信「推 pre」让 gateway 推 baseRef 并发 MR）。
 * git 副作用都在 lark-worker-git（mergeIntoMainWorktree 的三道检查）；这里只编排与记账。
 */
import { deleteMergedTaskBranch, gitAt, mergeBackMessage, mergeIntoMainWorktree, syncBaseFromUpstream } from './lark-worker-git.mjs'
import { RESOLVE_HINT, isDocsOnlyConflict, loadMergeBackState, queuePendingMerge, recordConflict, recordSyncResult, saveMergeBackState } from './lark-merge-back-state.mjs'

export const usesMergeBack = ({ workContext, profile, reroutedWip = null }) =>
  Boolean(workContext?.hotfixBranch && profile?.mergeBack && !reroutedWip)

// 开任务前同步上游：失败不拦任务（照常从 baseRef 开），冲突记下由重试器私信一次。
export const syncBeforeTask = ({ profile, deps = {} }) => {
  if (!profile.mergeBack?.upstream) return { ok: true, skipped: true }
  const synced = (deps.syncBaseFromUpstream || syncBaseFromUpstream)({ root: profile.root, baseRef: profile.baseRef, upstream: profile.mergeBack.upstream })
  if (synced.ok) recordSyncResult(profile.key, {}, deps)
  else if (synced.conflicts) recordSyncResult(profile.key, { conflict: synced.reason, upstreamSha: synced.upstreamSha }, deps)
  return synced
}

const summaryOf = (task) => String(task.summary || task.id).slice(0, 60)

// 冲突记账：返回 resolvable（只冲突在文档 = 可回「帮我合」）。
const noteConflict = ({ profile, item, conflicts, deps }) => {
  recordConflict(profile.key, { ...item, files: conflicts, since: new Date().toISOString() }, deps)
  return isDocsOnlyConflict(conflicts)
}

// 任务提交后合回 baseRef；合上了删任务分支（「帮我合」任务连被它取代的原分支一起删），暂不能合就排队，冲突记账。
export const mergeBackAfterTask = ({ profile, task, branch, deps = {} }) => {
  const message = mergeBackMessage({ branch, into: profile.baseRef, summary: task.summary })
  const merged = (deps.mergeIntoMainWorktree || mergeIntoMainWorktree)({ root: profile.root, baseRef: profile.baseRef, ref: branch, message })
  const drop = (target, superseded = false) => deleteMergedTaskBranch({ root: profile.root, branch: target, into: profile.baseRef, branchPrefix: profile.branchPrefix, superseded })
  if (merged.ok) {
    const cleanup = drop(branch)
    for (const old of task.supersedes || []) drop(old, true)
    return { ...merged, branchCleanup: cleanup }
  }
  // supersedes 跟着记账走：排队 / 再冲突后最终合上时，被取代的原分支照样删。
  const item = { taskId: task.id, branch, summary: summaryOf(task), ...(task.supersedes?.length ? { supersedes: task.supersedes } : {}) }
  if (merged.pending) queuePendingMerge(profile.key, { ...item, since: new Date().toISOString(), reason: merged.reason }, deps)
  if (merged.conflicts) return { ...merged, resolvable: noteConflict({ profile, item, conflicts: merged.conflicts, deps }) }
  return merged
}

const branchExists = (root, branch) => gitAt(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0

// 一个仓的一轮重试：返回要私信负责人的行（空 = 没新鲜事）。
export const retryMergeBack = ({ profile, deps = {} }) => {
  const state = loadMergeBackState(profile.key, deps)
  const { root, baseRef } = profile
  const lines = []
  const pending = []
  for (const item of state.pending) {
    if (!branchExists(root, item.branch)) continue // 负责人手动处理过 / 已回收
    const merged = (deps.mergeIntoMainWorktree || mergeIntoMainWorktree)({ root, baseRef, ref: item.branch, message: mergeBackMessage({ branch: item.branch, into: baseRef, summary: item.summary }) })
    if (merged.ok) {
      deleteMergedTaskBranch({ root, branch: item.branch, into: baseRef, branchPrefix: profile.branchPrefix })
      for (const old of item.supersedes || []) deleteMergedTaskBranch({ root, branch: old, into: baseRef, branchPrefix: profile.branchPrefix, superseded: true })
      lines.push(`✅ 已合进 ${baseRef}：${item.summary}`)
    } else if (merged.pending) {
      if (!item.notified) lines.push(`⏸ 等合进 ${baseRef}：${item.summary}（${merged.reason}），条件满足后我自动合`)
      pending.push({ ...item, reason: merged.reason, notified: true })
    } else {
      const resolvable = merged.conflicts && noteConflict({ profile, item, conflicts: merged.conflicts, deps })
      lines.push(`⚠ 没合进 ${baseRef}：${item.summary}（${merged.reason}）。分支 ${item.branch} 保留，${resolvable ? RESOLVE_HINT : '要你手动合'}`)
    }
  }
  let syncConflict = state.syncConflict
  if (syncConflict && !syncConflict.notified) {
    lines.push(`⚠ ${profile.mergeBack?.upstream || '上游'} 同步进 ${baseRef} 时${syncConflict.reason.replace(/^合进 \S+ /, '')}。在主目录 \`git merge ${profile.mergeBack?.upstream}\` 解一下；没解之前 bot 的任务照常从 ${baseRef} 开`)
    syncConflict = { ...syncConflict, notified: true }
  }
  // 上游冲突第一次提醒必然带一行，所以「有行或队列变了」就覆盖了所有要落盘的情况。
  // 冲突记账里负责人已手动合掉 / 删掉的分支清出去，免得回「帮我合」时给它建任务。
  const latest = loadMergeBackState(profile.key, deps) // 重读：本轮冲突已记进 conflicts
  const conflicts = latest.conflicts.filter((item) => branchExists(root, item.branch) && gitAt(root, ['merge-base', '--is-ancestor', item.branch, baseRef]).status !== 0)
  if (lines.length || pending.length !== state.pending.length || conflicts.length !== latest.conflicts.length) {
    saveMergeBackState(profile.key, { ...latest, pending, syncConflict, conflicts }, deps)
  }
  return lines
}

// worker 定时入口：没配 mergeBack 的仓跳过；私信失败只打日志（下一轮不会重发已标 notified 的行）。
export const createMergeBackRetrier = ({ profiles, notify, log = console, deps = {} }) => async () => {
  for (const profile of profiles.filter((item) => !item.isDefault && item.mergeBack)) {
    let lines = []
    try {
      lines = retryMergeBack({ profile, deps })
    } catch (error) {
      log.warn(`[lark-worker] ⚠ 合回 ${profile.baseRef} 重试异常（忽略）：${String(error?.message || error).slice(0, 160)}`)
      continue
    }
    if (!lines.length) continue
    log.log(`[lark-worker] 合回 ${profile.baseRef}：${lines.join(' | ')}`)
    try {
      await notify(`**${profile.title || profile.key} · 合回 ${profile.baseRef}**\n${lines.join('\n')}`)
    } catch (error) {
      log.warn(`[lark-worker] ⚠ 合回通知没发出去：${String(error?.message || error).slice(0, 120)}`)
    }
  }
}
