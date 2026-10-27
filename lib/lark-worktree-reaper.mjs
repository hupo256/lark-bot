/**
 * 任务分支 / 临时 worktree 回收（aven 2026-10-19）：已合入的 `lark/<repo>-<id>` 分支和它的临时 worktree 留着，
 * `git branch` 里一排 `+ lark/falive-…` 越积越多。
 *
 * 为什么会残留：deleteMergedTaskBranch 只在「合回 baseRef」那一刻删一次，分支还被临时 worktree 检出时
 * `branch -D` 被拒；失败 / 取消 / 已完成但现场没回收的任务都会留下来，之后再没人管。
 * 这里由 worker 每小时扫一遍，按下面的口径回收（宁可留垃圾，不丢人类没看过的东西）：
 *   · 任务还在活动态（排队 / 运行 / 待回写…，或不认识的状态）→ 不动；
 *   · 只碰 profile.tempWorktreeDir 下的 worktree，人类的 worktree 一律不碰；
 *   · 分支已被 baseRef 包含 + 工作区干净 → 删 worktree + 分支；
 *   · 有未提交改动：只有任务已结单（done / 无需改动 / 忽略 / 取消）满 graceMs 才回收，先把改动存成补丁到
 *     runtime/reaped/，再删；失败 / 阻塞 / 待确认的现场是给续跑用的，保留；
 *   · 分支有没合进去的提交 → 保留（人类还没 review）。
 * 判定是纯函数 decideReap，git 副作用在 reapRepo。
 */

import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { larkRuntimeDir } from './lark-paths.mjs'
import { gitAt, worktreeState } from './lark-worker-git.mjs'

// 已了结、不会再被 worker 领走的状态。不在表里的（含将来新增的）一律按活动态处理，fail-closed。
const SETTLED_STATUSES = new Set(['done', 'done_with_warnings', 'no_change_needed', 'ignored', 'superseded', 'failed', 'blocked', 'waiting_confirmation'])
// 结单后不会再续跑的状态：现场里的未提交改动可以存补丁后丢掉。failed / blocked / waiting_confirmation 可以「继续任务」续跑，不在此列。
const CLOSED_STATUSES = new Set(['done', 'done_with_warnings', 'no_change_needed', 'ignored', 'superseded'])
const DEFAULT_GRACE_MS = 60 * 60_000
const DEFAULT_BACKUP_DIR = join(larkRuntimeDir, 'reaped')

/**
 * @param branch     任务分支名
 * @param task       该分支最新的任务记录（可为 null = 找不到任务）
 * @param worktree   null（没有 worktree）| { inTempDir, busy, state: 'clean' | 'dirty' | 'error' }
 * @param merged     分支是否已被 baseRef 包含
 * @returns { action: 'keep' | 'reap', reason, backup? }
 */
export const decideReap = ({ branch, task, worktree, merged, now = Date.now(), graceMs = DEFAULT_GRACE_MS }) => {
  if (worktree?.busy) return { action: 'keep', reason: 'worker 正在这个 worktree 里跑任务' }
  if (task && !SETTLED_STATUSES.has(task.status)) return { action: 'keep', reason: `任务 ${task.id} 仍是 ${task.status}` }
  if (worktree && !worktree.inTempDir) return { action: 'keep', reason: `${branch} 检出在 bot 临时目录之外，不碰人类 worktree` }
  if (worktree?.state === 'error') return { action: 'keep', reason: 'git 状态不可读，无法确认有无改动' }
  if (!merged) return { action: 'keep', reason: '分支有未合入的提交，留待 review' }
  if (worktree?.state !== 'dirty') return { action: 'reap', reason: '已合入且工作区干净' }
  if (!task || !CLOSED_STATUSES.has(task.status)) return { action: 'keep', reason: `现场有未提交改动，任务${task ? ` ${task.status}` : '记录缺失'}，留待续跑或人工` }
  const closedAt = Date.parse(task.updatedAt || '')
  if (!Number.isFinite(closedAt) || now - closedAt < graceMs) return { action: 'keep', reason: '任务刚结单，宽限期内不回收' }
  return { action: 'reap', reason: `任务已 ${task.status}，未提交改动存补丁后回收`, backup: true }
}

// macOS 的 /var → /private/var 这类软链会让同一目录写法不同，先取真实路径再比。
const realPath = (path) => {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

const isUnder = (child, parent) => {
  const rel = relative(realPath(parent), realPath(child))
  return rel !== '' && !rel.startsWith('..')
}

// `git worktree list --porcelain` → branch 名 → worktree 路径
const worktreesByBranch = (root) => {
  const map = new Map()
  let path = null
  for (const line of gitAt(root, ['worktree', 'list', '--porcelain']).stdout.split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length)
    else if (line.startsWith('branch refs/heads/') && path) map.set(line.slice('branch refs/heads/'.length), path)
  }
  return map
}

const isAncestor = (root, branch, ref) => Boolean(ref) && gitAt(root, ['merge-base', '--is-ancestor', branch, ref]).status === 0

// 同一分支可能对应多条任务记录（续跑 / 换代），取最近更新的那条。
const latestTaskByBranch = (tasks) => {
  const map = new Map()
  for (const task of tasks || []) {
    if (!task?.branch) continue
    const prev = map.get(task.branch)
    if (!prev || String(task.updatedAt || '') > String(prev.updatedAt || '')) map.set(task.branch, task)
  }
  return map
}

// 未提交改动（含未跟踪文件）存成可 `git apply` 的补丁。暂存区借用一下，worktree 随后就删。
const backupDirtyWorktree = ({ path, branch, backupDir, now }) => {
  gitAt(path, ['add', '-A'])
  const diff = gitAt(path, ['diff', '--cached', '--binary', 'HEAD'])
  if (diff.status !== 0) return null
  mkdirSync(backupDir, { recursive: true })
  const file = join(backupDir, `${branch.replace(/\//g, '-')}-${new Date(now).toISOString().replace(/[:.]/g, '-')}.patch`)
  writeFileSync(file, diff.stdout)
  return file
}

/**
 * 扫一个仓库 profile：返回每个候选分支的处理结果。dryRun 只判不删。
 * @param profile    非默认仓 profile（root / branchPrefix / baseRef / tempWorktreeDir）
 * @param tasks      gateway 的任务列表
 * @param backupDir  未提交改动的补丁目录（runtime/reaped）
 * @param busyPaths  worker 在飞任务的 cwd（领任务和扫描之间的竞态兜底）
 */
export const reapRepo = ({ profile, tasks, backupDir = DEFAULT_BACKUP_DIR, busyPaths = [], dryRun = false, now = Date.now(), graceMs }) => {
  const { root, branchPrefix, baseRef, tempWorktreeDir } = profile
  const prefix = `${branchPrefix}-`
  const branches = gitAt(root, ['for-each-ref', '--format=%(refname:short)', `refs/heads/${prefix}*`]).stdout
    .split('\n').map((name) => name.trim()).filter((name) => name.startsWith(prefix))
  if (!branches.length) return []
  const checkouts = worktreesByBranch(root)
  const taskOf = latestTaskByBranch(tasks)
  const busy = new Set([...busyPaths].map(realPath))
  const results = []
  for (const branch of branches) {
    const path = checkouts.get(branch) || null
    const worktree = path ? { inTempDir: isUnder(path, tempWorktreeDir), busy: busy.has(realPath(path)), state: worktreeState(path) } : null
    const merged = isAncestor(root, branch, baseRef)
    const decision = decideReap({ branch, task: taskOf.get(branch) || null, worktree, merged, now, graceMs })
    if (decision.action !== 'reap' || dryRun) {
      results.push({ branch, path, ...decision, done: false })
      continue
    }
    const backup = decision.backup ? backupDirtyWorktree({ path, branch, backupDir, now }) : null
    if (decision.backup && !backup) {
      results.push({ branch, path, action: 'keep', reason: '补丁没存下来，不回收', done: false })
      continue
    }
    if (path) {
      const removed = gitAt(root, ['worktree', 'remove', '--force', path])
      if (removed.status !== 0) {
        results.push({ branch, path, action: 'keep', reason: `worktree 删除失败：${(removed.stderr || '').trim().slice(0, 120)}`, backup, done: false })
        continue
      }
    }
    const deleted = gitAt(root, ['branch', '-D', branch])
    results.push({ branch, path, ...decision, backup, done: deleted.status === 0, ...(deleted.status === 0 ? {} : { reason: `分支删除失败：${(deleted.stderr || '').trim().slice(0, 120)}` }) })
  }
  gitAt(root, ['worktree', 'prune'])
  return results
}

/**
 * worker 定时入口：扫所有非默认仓 profile，回收结果只打日志（只是清理，不私信、不发群）。
 * @param listTasks  () => Promise<任务列表>；拉不到任务列表就整轮跳过（不知道任务状态时不删任何东西）
 * @param busyPaths  () => 在飞任务的 cwd 列表
 */
export const createWorktreeReaper = ({ profiles, listTasks, busyPaths, backupDir = DEFAULT_BACKUP_DIR, log = console }) => async () => {
  let tasks
  try {
    tasks = await listTasks()
  } catch (error) {
    log.warn(`[lark-worker] 分支回收：拉不到任务列表，本轮跳过（${String(error?.message || error).slice(0, 120)}）`)
    return []
  }
  const results = []
  for (const profile of profiles.filter((item) => !item.isDefault)) {
    for (const result of reapRepo({ profile, tasks, backupDir, busyPaths: busyPaths() })) {
      results.push({ repo: profile.key, ...result })
      if (result.done) log.log(`[lark-worker] 分支回收：删除 ${result.branch}${result.path ? ` 及 worktree ${result.path}` : ''}（${result.reason}${result.backup ? `，改动补丁 ${result.backup}` : ''}）`)
      else if (result.action === 'reap') log.warn(`[lark-worker] ⚠ 分支回收：${result.branch} 没删掉：${result.reason}`)
    }
  }
  return results
}
