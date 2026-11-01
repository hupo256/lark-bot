/**
 * bug 查重（aven 2026-11-01，B3）：领单前在业务仓近 14 天所有分支里找提到这条记录（bot 提交的 `lark-task: <记录 id>` trailer）
 * 或 bug 编号的提交，找到就把提交附进任务正文，让 AI 先 git show 核对：已修好就按无需改动结单，不重复修。
 * 跑 git，只给 poller 用（不进 gateway 闭包）。
 */
import { spawnSync } from 'node:child_process'

// ── 查重 ─────────────────────────────────────────────

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 近 days 天、所有分支里提到这条记录 / bug 编号的提交（去重，最多 limit 条），每行「短 sha 作者 日期 标题」。
 * 只读 git log；读不到（仓不在 / git 出错）返回 []，不挡开工。
 */
export const findMentioningCommits = ({ repoRoot, recordId = '', bugNo = '', days = 14, limit = 5, run = spawnSync }) => {
  const patterns = [recordId && `lark-task: ${escapeRe(recordId)}$`, bugNo && `\\b${escapeRe(bugNo)}\\b`].filter(Boolean)
  if (!repoRoot || !patterns.length) return []
  const args = ['-C', repoRoot, 'log', '--all', `--since=${days} days ago`, '-E', '-i', '--format=%h %an %ad %s', '--date=format:%m-%d %H:%M']
  for (const pattern of patterns) args.push(`--grep=${pattern}`)
  const result = run('git', args, { encoding: 'utf8', timeout: 20_000 })
  if (result?.status !== 0) return []
  return [...new Set(String(result.stdout || '').split('\n').map((line) => line.trim()).filter(Boolean))].slice(0, limit)
}

export const dedupeNote = (lines) =>
  lines.length
    ? `\n\n【查重】业务仓近 14 天已有提交提到这单：\n${lines.map((line) => `- ${line}`).join('\n')}\n先逐条 git show 核对：已修好同一问题就不要重复改，按无需改动结单并写明由哪个提交修复；只是同文件的无关改动就照常修。`
    : ''
