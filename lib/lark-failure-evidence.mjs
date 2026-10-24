/**
 * 失败卡旁证（自愈环 1.6，从 falive 移植，aven 2026-10-24）：worker 报「没做成」之前，把这条任务实际留下的痕迹
 * 写到失败卡上，让人一眼分清「啥都没干就挂了」和「活干了一半 / 干完了只是没拿到结果文件」，不用再去翻日志。
 * falive 查的是发件簿（bot 已发的群消息）；fameex 没有发件簿，只用 fameex 自己有的三样：
 *   ① 审计里任务停在哪个阶段（分诊 / 只读分析 / 实施）；② 工作区未提交改动；③ 本任务开工后分支上新增的提交。
 * 只给事实，不下「已做成」的判断（没有发件簿那种强旁证），也不改任务状态。
 */

import { gitAt } from './lark-worker-git.mjs'

// 审计 record.status（lark-worker-run 写入）→ 旁证句。其它状态（started / running 等）不说。
const PHASE_LINES = {
  triaging: '失败时还在分诊阶段（没动代码）',
  analyzing: '失败时还在只读分析阶段（没动代码）',
  implementing: '失败时已在实施阶段（分析已跑完）',
}

const MAX_FILES_SHOWN = 3

/**
 * 纯函数。changedFiles：工作区未提交改动的路径数组；null = 没读（只读任务 / 目录不在 / git 读不出），不下结论。
 * @returns {{ lines: string[] }}
 */
export const collectFailureEvidence = ({ phase = null, changedFiles = null, newCommits = 0, latestCommit = '' } = {}) => {
  const lines = []
  if (PHASE_LINES[phase]) lines.push(PHASE_LINES[phase])
  if (changedFiles?.length) {
    const shown = changedFiles.slice(0, MAX_FILES_SHOWN).join('、')
    const more = changedFiles.length > MAX_FILES_SHOWN ? ' 等' : ''
    lines.push(`工作区有 ${changedFiles.length} 个文件未提交（${shown}${more}，现场已保留）`)
  }
  if (newCommits > 0) lines.push(`本任务开工后分支上多了 ${newCommits} 个提交（最新「${String(latestCommit).slice(0, 60)}」）`)
  if (Array.isArray(changedFiles) && !changedFiles.length && !(newCommits > 0)) lines.push('工作区无改动、无新提交')
  return { lines }
}

// 失败卡里的一行：有旁证列旁证；什么都读不到就明说「无」，让人不用再去翻。
export const formatFailureEvidence = (evidence) => {
  if (!evidence?.lines?.length) return '旁证：无（没读到阶段与工作区信息）'
  return `旁证：${evidence.lines.join('；')}`
}

/**
 * 读真实 git：只读任务不看工作区（那是人的主仓 / 项目 worktree，改动不是本任务的）。
 * sinceHeadSha：开工时记录的 HEAD（task-runner 的 executionIdentity.headSha），没有就不数提交。
 */
export const readFailureEvidence = ({ cwd, sinceHeadSha = null, phase = null, readOnly = false } = {}) => {
  // 目录不在时 git 读不出（status 非 0）→ changedFiles=null、不数提交，和只读一样只给阶段。
  if (readOnly || !cwd) return collectFailureEvidence({ phase })
  const status = gitAt(cwd, ['status', '--porcelain'])
  const changedFiles = status.status === 0 ? status.stdout.split('\n').filter(Boolean).map((line) => line.slice(3)) : null
  let newCommits = 0
  let latestCommit = ''
  if (sinceHeadSha) {
    const count = gitAt(cwd, ['rev-list', '--count', `${sinceHeadSha}..HEAD`])
    newCommits = count.status === 0 ? Number(count.stdout.trim()) : 0
    if (newCommits) latestCommit = gitAt(cwd, ['log', '-1', '--format=%s']).stdout.trim()
  }
  return collectFailureEvidence({ phase, changedFiles, newCommits, latestCommit })
}
