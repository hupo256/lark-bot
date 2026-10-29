/**
 * 「帮我合」：bot 任务分支合回负责人工作分支时只在 docs/ 下冲突，负责人私信回「帮我合」→ 每条建一个合并任务（aven 2026-10-29，教训 #94）。
 *
 * 合并任务就是一条普通的清扫类任务：照常从最新的 baseRef 开分支，执行器读原分支的改动、按意思补进当前文档，Worker 提交并合回；
 * 合上后连被它取代的原分支一起删（lib/lark-merge-back.mjs supersedes）。不在负责人的主目录里做 git merge、
 * 不把 baseRef 反向合进任务分支，git 状态只走现有合回链路。代码冲突不在这里，仍要人合。
 * gateway 侧：只读写 state 文件、建任务，不跑 git（gateway 纯度）。
 */
import { buildSweepTask, sweepProfiles } from './lark-daily-sweep.mjs'
import { localDateKey } from './lark-local-date.mjs'
import { takeDocsConflicts } from './lark-merge-back-state.mjs'

export const parseResolveMergeDirective = (text) => /^\s*帮我合\s*$/.test(String(text || ''))

export const buildResolveText = ({ me, baseRef, item }) => {
  const range = `$(git merge-base HEAD ${item.branch}) ${item.branch}`
  return `bot 任务分支 ${item.branch}（${item.summary}）合不进 ${baseRef}：和 ${me} 之后的提交改了同一段（冲突文件：${item.files.join('、')}）。${me} 回了「帮我合」，把这条分支的改动按意思补进当前文件。
看改动：\`git diff ${range}\`（全部文件，不只冲突的）；${me} 后来怎么改的：\`git log -p ${range.split(' ')[0]}..HEAD -- ${item.files.join(' ')}\`。
做法：以当前文件（HEAD）的结构、编号和口径为准；分支里有、当前没有的新事实（复测结论、证据、新条目）补到意思对应的位置，编号顺延，引用这些编号的地方一起改；被 ${me} 后来的提交推翻或改了口径的说法不照抄，改成符合当前口径或删掉。没冲突的文件可以 \`git diff ${range} -- <文件> | git apply\`。直接编辑文件，不要 git merge / checkout / cherry-pick 那条分支；只动 docs/；不提交（Worker 统一提交）。
summary：第一行「合回冲突已合：${item.summary}」，之后每处取舍一行「- 文件：补了什么 / 删了或改了什么（为什么）」。`
}

// 私信「帮我合」：取走全部只冲突在文档的分支，各建一个合并任务；返回回给负责人的 markdown。
export const handleResolveMerge = ({ store, now = new Date(), deps = {} }) => {
  const profiles = sweepProfiles()
  if (profiles.length !== 1) return profiles.length ? `开了清扫的仓不止一个（${profiles.map((p) => p.key).join('、')}），暂不支持选择。` : '没有开启日报清扫的仓。'
  const profile = profiles[0]
  const me = profile.ownership?.me || '负责人'
  const { taken, left } = takeDocsConflicts(profile.key, deps)
  const leftNote = left.length ? `\n\n有代码冲突的还要你手动合：${left.map((item) => item.branch).join('、')}` : ''
  if (!taken.length) return `没有只冲突在文档、等我合的分支。${leftNote}`
  const ids = taken.map((item) => {
    const id = `resolve-${item.branch.split('/').pop()}`
    if (!store.get(id)) {
      store.upsert({
        ...buildSweepTask({ profile, date: localDateKey(now), text: buildResolveText({ me, baseRef: profile.baseRef, item }), count: 1, now }),
        id, summary: `合回冲突：${item.summary}`, topic: `resolve#${item.branch}`,
        supersedes: [item.branch, ...(item.supersedes || [])],
      })
    }
    return id
  })
  console.log(`[lark-gateway] 帮我合：${ids.join('、')}`)
  return `好，${taken.length} 条开始合：${taken.map((item) => item.summary).join('；')}。合进 ${profile.baseRef} 后私信你取舍。${leftNote}`
}
