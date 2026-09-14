/**
 * 自动提交口径的**唯一事实源**（纯函数、零 IO，可 `node --test` 直测）。
 *
 * ## 为什么要单独一层
 *
 * `common/rules/collaboration-and-notifications.md` §4 把 commit 列为「需人工确认的高风险动作」，
 * 而 worker 一直在自动提交。二者并不真冲突——冲突的是**没有一处把边界写清**：口径散在
 * `lark-task-runner` 的路由分支、`finalizeTempWorktree` 的 `allowCommit`、`finalizeExistingWorktree`
 * 的注释里三处，各自只描述自己那一支，于是「什么情况下 bot 可以自己 commit」这个问题在代码里没有答案。
 *
 * ## 口径表（唯一）
 *
 * | 场景 | 模式 | 理由 |
 * |---|---|---|
 * | 只读任务 | `none` | 不产生改动，任何写都是越界 |
 * | 任务未完成（failed / blocked / 异常） | `none` | 半成品不入库，保留现场待人工 |
 * | 隔离临时 worktree（默认 `origin/online`；WIP 改路由时基于项目分支 HEAD） | `auto` | 分支是 bot 自己开的，工作区里不可能有别人的东西，全量提交安全 |
 * | 命中人类已有 worktree 的当前分支 | `scoped` | 只提交**本任务实测产生**的文件；其余一律留在工作区 |
 *
 * `scoped` 是这层存在的实际价值：路由层只在**任务开始前**检查过一次「已有 worktree 是否干净」，
 * 而 AI 可以跑 30 分钟。这期间人在自己的 worktree 里写的新 WIP，会被收尾时的 `git add -A` 一起
 * 扫进 bot 的提交——正是 §4 要防的那件事。改成按实测改动清单定向提交后，意外路径既不入库，
 * 也不被静默忽略：它们进 `unexpected`，由调用方回卡片请人确认。
 */

export const COMMIT_MODES = {
  auto: 'auto',
  scoped: 'scoped',
  none: 'none',
}

/**
 * 解析本次任务的提交模式。判据只有三个事实，刻意不接受 task 对象——避免这层又长成第二个语义源。
 * @param {{ isolatedBranch?: boolean, readOnly?: boolean, taskDone?: boolean }} input
 */
export const resolveCommitMode = ({ isolatedBranch = false, readOnly = false, taskDone = false } = {}) => {
  if (readOnly) return { mode: COMMIT_MODES.none, reason: '只读任务不提交' }
  if (!taskDone) {
    return {
      mode: COMMIT_MODES.none,
      reason: isolatedBranch ? '任务未完成，半成品未提交（现场已保留）' : '未完成，不往已有分支写半成品',
    }
  }
  if (isolatedBranch) return { mode: COMMIT_MODES.auto, reason: '隔离分支，全量提交' }
  return { mode: COMMIT_MODES.scoped, reason: '人类工作分支，只提交本任务实测改动' }
}

// 路径归一：去掉前后空白与 `./` 前缀，丢空串。git 两侧口径（diff --name-only / status --porcelain）
// 都给仓库相对路径，但调用方可能透传 AI 报告的路径，故统一一次再比。
const normalizePaths = (paths) => [
  ...new Set(
    (Array.isArray(paths) ? paths : [])
      .map((path) => String(path || '').trim().replace(/^\.\//, ''))
      .filter(Boolean),
  ),
]

/**
 * `scoped` 模式下把收尾时的工作区改动切成两半。
 * - `commit`：本任务实测清单 ∩ 收尾时仍有改动的路径（清单里已被 AI 自己 revert 的不必提交）。
 * - `unexpected`：收尾时才出现、不在实测清单里的路径——**任务运行期间新写入的人类 WIP**，绝不提交。
 * @param {{ taskPaths?: string[], worktreePaths?: string[] }} input
 */
export const partitionScopedPaths = ({ taskPaths, worktreePaths } = {}) => {
  const owned = new Set(normalizePaths(taskPaths))
  const present = normalizePaths(worktreePaths)
  return {
    commit: present.filter((path) => owned.has(path)),
    unexpected: present.filter((path) => !owned.has(path)),
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const cases = []
  const eq = (name, actual, expected) => cases.push({ name, ok: JSON.stringify(actual) === JSON.stringify(expected), actual, expected })

  eq('只读任务 → none', resolveCommitMode({ readOnly: true, taskDone: true, isolatedBranch: true }).mode, 'none')
  eq('未完成 + 隔离 → none', resolveCommitMode({ isolatedBranch: true, taskDone: false }).mode, 'none')
  eq('未完成 + 已有 worktree → none', resolveCommitMode({ taskDone: false }).mode, 'none')
  eq('未完成理由分两种', [
    resolveCommitMode({ isolatedBranch: true, taskDone: false }).reason,
    resolveCommitMode({ taskDone: false }).reason,
  ], ['任务未完成，半成品未提交（现场已保留）', '未完成，不往已有分支写半成品'])
  eq('done + 隔离 → auto', resolveCommitMode({ isolatedBranch: true, taskDone: true }).mode, 'auto')
  eq('done + 已有 worktree → scoped', resolveCommitMode({ taskDone: true }).mode, 'scoped')
  eq('无入参 → none（fail-safe）', resolveCommitMode().mode, 'none')

  eq('scoped 只提交实测清单内的路径', partitionScopedPaths({
    taskPaths: ['src/a.ts', 'src/b.ts'],
    worktreePaths: ['src/a.ts', 'src/b.ts', 'src/human-wip.ts'],
  }), { commit: ['src/a.ts', 'src/b.ts'], unexpected: ['src/human-wip.ts'] })
  eq('清单里已无改动的路径不进提交集', partitionScopedPaths({
    taskPaths: ['src/a.ts', 'src/reverted.ts'],
    worktreePaths: ['src/a.ts'],
  }), { commit: ['src/a.ts'], unexpected: [] })
  eq('工作区干净 → 两边都空', partitionScopedPaths({ taskPaths: ['src/a.ts'], worktreePaths: [] }), { commit: [], unexpected: [] })
  eq('实测清单为空 → 全部意外，一个都不提交', partitionScopedPaths({
    taskPaths: [],
    worktreePaths: ['src/human-wip.ts'],
  }), { commit: [], unexpected: ['src/human-wip.ts'] })
  eq('路径归一：./ 前缀与重复项', partitionScopedPaths({
    taskPaths: ['./src/a.ts', 'src/a.ts'],
    worktreePaths: [' src/a.ts ', './src/a.ts'],
  }), { commit: ['src/a.ts'], unexpected: [] })
  eq('缺参不抛错', partitionScopedPaths(), { commit: [], unexpected: [] })

  const failed = cases.filter((item) => !item.ok)
  for (const item of failed) console.error(`✖ ${item.name}\n  expected ${item.expected}\n  actual   ${item.actual}`)
  console.log(`${failed.length ? '✖' : '✅'} lark-commit-policy self-test: ${cases.length - failed.length}/${cases.length}`)
  process.exit(failed.length ? 1 : 0)
}
