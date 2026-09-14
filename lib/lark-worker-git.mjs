/**
 * Lark Worker 的 git / worktree 操作层：临时 worktree 生命周期（建/软链依赖/收尾提交）、
 * 命中已有 worktree 的 WIP 隔离与收尾提交、只读快照。全部围绕主仓 repoRoot 与传入的 cwd 工作。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { partitionScopedPaths } from './lark-commit-policy.mjs'
import { repoRoot } from './lark-worker-env.mjs'

const BASE_REMOTE = 'origin'
const BASE_BRANCH = 'online'
const BASE_REF = `${BASE_REMOTE}/${BASE_BRANCH}`

// 同步睡眠（用于 prepareTempWorktree 里同步重试的退避）；不依赖平台 sleep 命令
const syncSleep = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// 主仓根可注入：这一层会 `worktree remove --force` / `branch -D`，是整个 bot 里唯一能删掉人类
// 未看过的改动的代码，必须能在临时仓库里跑**真实 git**单测。生产路径不调用 setRepoRoot，沿用 env 解析值。
let activeRepoRoot = repoRoot
export const setRepoRoot = (root) => {
  activeRepoRoot = root || repoRoot
}

export const git = (args) => spawnSync('git', ['-C', activeRepoRoot, ...args], { encoding: 'utf8' })
export const gitAt = (cwd, args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })

const canonicalPath = (path) => {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path || '')
  }
}

// 实际 git 身份校验：调度层给出的 cwd 不足以证明 AI 正在正确分支工作。任务开工时记录 branch + HEAD，
// 终检和提交前再次校验，既防串 worktree/切错分支，也防 AI 绕过 Worker 自行 commit。
export const inspectWorktreeIdentity = ({ cwd, expectedBranch, expectedHeadSha } = {}) => {
  const rootResult = gitAt(cwd, ['rev-parse', '--show-toplevel'])
  const branchResult = gitAt(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  const headResult = gitAt(cwd, ['rev-parse', 'HEAD'])
  const root = rootResult.status === 0 ? rootResult.stdout.trim() : ''
  const branch = branchResult.status === 0 ? branchResult.stdout.trim() : ''
  const headSha = headResult.status === 0 ? headResult.stdout.trim() : ''
  const problems = []

  if (!root) problems.push(`无法读取 ${cwd || '(missing)'} 的 git root`)
  else if (canonicalPath(root) !== canonicalPath(cwd)) problems.push(`git root ${root} 与任务 cwd ${cwd || '(missing)'} 不一致`)
  if (!branch) problems.push('当前处于 detached HEAD 或无法读取分支')
  if (expectedBranch && branch !== expectedBranch) problems.push(`预期分支 ${expectedBranch}，实际为 ${branch || '(unknown)'}`)
  if (expectedHeadSha && headSha !== expectedHeadSha) {
    problems.push(`任务执行期间 HEAD 从 ${expectedHeadSha.slice(0, 12)} 变为 ${(headSha || '(unknown)').slice(0, 12)}；提交链不再由 Worker 独占`)
  }

  return { ok: problems.length === 0, root, branch, headSha, problems }
}

// spawnSync 结果的错误摘要（stderr 优先、无则 stdout），截断到人可读长度——多处日志/报错复用。
const gitTail = (res, max = 200) => (res.stderr || res.stdout || '').trim().slice(0, max)
// 工作区状态三态：'clean' | 'dirty' | 'error'。**必须把 git 异常与 clean 区分开**——
// 曾经这里 git 失败返回 false（视作无改动），会让 finalizeTempWorktree 走「干净可删」分支
// remove --force + branch -D，把无法确认的改动连同分支一起灭失。不可读时一律按「可能有改动」处理。
export const worktreeState = (cwd) => {
  const res = gitAt(cwd, ['status', '--porcelain'])
  if (res.status !== 0) return 'error'
  return res.stdout.trim() ? 'dirty' : 'clean'
}
// 全量暂存并提交（无人值守：--no-verify 跳过 husky）。传 paths 则退化为**定向提交**：只暂存并提交
// 这些路径（`commit -- <pathspec>` 不受索引里其它条目影响，含 enforceCodeQuality 留下的 intent-to-add）。
// 返回 spawnSync 结果，失败处理留给调用方。
const commitAll = (cwd, message, paths) => {
  if (paths?.length) {
    gitAt(cwd, ['add', '-A', '--', ...paths])
    return gitAt(cwd, ['commit', '--no-verify', '-m', message, '--', ...paths])
  }
  gitAt(cwd, ['add', '-A'])
  return gitAt(cwd, ['commit', '--no-verify', '-m', message])
}
// 收尾时工作区里仍有改动的路径清单。先 `add -A -N`（仅登记意图、不改内容）再 name-only diff，
// 口径与 lark-task-runner 量 actualChangedFiles 时完全一致，两边才能按路径直接比对。
const dirtyPathsFor = (cwd) => {
  gitAt(cwd, ['add', '-A', '-N'])
  const res = gitAt(cwd, ['diff', '--name-only', 'HEAD'])
  if (res.status !== 0) return null
  return (res.stdout || '').split('\n').map((line) => line.trim()).filter(Boolean)
}
// 两类 worktree 共用的「三态检查 → 有改动则提交」核心；调用方保留各自的日志与清理策略。
const commitWorktreeChanges = ({ cwd, message, target, successReason, commitDirty = true, dirtyReason, paths }) => {
  const state = worktreeState(cwd)
  if (state === 'error') {
    return { state, ok: false, committed: false, reason: `读不到 ${cwd} 的 git 状态，无法确认改动是否已落盘` }
  }
  if (state === 'clean') return { state, ok: true, committed: false, reason: '工作区无改动' }
  if (!commitDirty) return { state, ok: false, committed: false, reason: dirtyReason }

  const result = commitAll(cwd, message, paths)
  if (result.status !== 0) {
    return {
      state,
      result,
      ok: false,
      committed: false,
      reason: `git commit 到 ${target} 失败：${gitTail(result, 120)}`,
    }
  }
  return { state, result, ok: true, committed: true, reason: successReason }
}
// 收尾提交信息统一格式：`<前缀>: <摘要截断> [<id>]`，正文带机器可查的 `lark-task:` trailer
//（`git log --grep '^lark-task: <id>'` 能把一次群内反馈直接对到提交上，标题里的 `[id]` 是给人看的），
// 可选追加质量告警。摘要由调用方决定 fallback。
const commitMessage = (prefix, summary, task) =>
  `${prefix}: ${summary.slice(0, 60)} [${task.id}]\n\nlark-task: ${task.id}${task.qualityNote ? `\n\n⚠ ${task.qualityNote}` : ''}`

// 无 worktree 的任务用「一次性临时 worktree」而非切主仓分支：
//   · 不碰主仓（主仓脏/在别的分支都不受影响），天然无并发/顺序碰撞
//   · 普通任务基于 origin/online；项目 worktree 有 WIP 时基于该 worktree 分支当时的 HEAD
//   · 干完自动本地提交到 hotfix 分支、删掉临时目录（分支保留待 review）
//   · 无常驻 worktree 蔓延（用完即删）
// 分支相对其创建基线是否已有提交。git 失败按「有提交」处理（宁可保守保留，不可误删）。
const branchHasCommits = (branch, baseRef = BASE_REF) => {
  const ahead = git(['rev-list', '--count', `${baseRef}..${branch}`])
  return !(ahead.status === 0 && ahead.stdout.trim() === '0')
}

const branchContainsBase = (branch, baseRef) =>
  git(['merge-base', '--is-ancestor', baseRef, branch]).status === 0

// 残留现场是否值得保留：上次失败/阻塞时 finalizeTempWorktree 会**故意**留下带半成品的 worktree。
// 有未提交改动 / git 状态不可读 / 分支已有提交，三者任一都说明里面有人类还没看过的东西。
const tempWorktreeWorthKeeping = ({ path, branch, baseRef }) => {
  // 不是有效 worktree（残留空壳目录）→ 无 git 数据可保，交由调用方按原逻辑重建。
  if (gitAt(path, ['rev-parse', '--is-inside-work-tree']).status !== 0) return null
  const state = worktreeState(path)
  if (state === 'dirty') return '有未提交改动'
  if (state === 'error') return 'git 状态不可读'
  if (branchHasCommits(branch, baseRef)) return '分支已有提交'
  return null
}

const ensureBaseRef = (baseRef) => {
  if (baseRef === BASE_REF) fetchOnlineWithRetry()
  const resolved = git(['rev-parse', '--verify', `${baseRef}^{commit}`])
  if (resolved.status !== 0) throw new Error(`临时 worktree 基线 ${baseRef} 不存在：${gitTail(resolved, 160)}`)
  return resolved.stdout.trim()
}

export const prepareTempWorktree = ({ path, branch, baseRef = BASE_REF }) => {
  const baseSha = ensureBaseRef(baseRef)
  if (existsSync(path)) {
    // retry / resume 复用同一 task.id ⇒ 解析出同一 path + branch。若在此无条件
    // `worktree remove --force` + `worktree add -B`，会把上次失败刻意保留的半成品连同分支上
    // 已有的提交一起重置灭失——正好摧毁「失败保留现场」这条保证。故先判残留是否有价值：
    // 有价值就原地复用（AI 在上次现场继续，补料续跑本就该如此），无价值才重建。
    const keepReason = tempWorktreeWorthKeeping({ path, branch, baseRef })
    if (keepReason) {
      if (!branchContainsBase(branch, baseSha)) {
        throw new Error(`临时分支 ${branch} 不包含本次项目基线 ${baseSha.slice(0, 12)}，且现场${keepReason}；为避免丢改动已保留现场，请人工 rebase/cherry-pick 后重试`)
      }
      console.log(`[lark-worker] 复用上次保留的临时 worktree ${path}（${keepReason}），不重建以免丢改动`)
      linkNodeModules(path)
      return
    }
    git(['worktree', 'remove', '--force', path]) // 干净且无提交的残留，可安全清理
    // 残留是个「空壳目录」（不是注册过的 worktree）时上面这条必然失败、目录还在，
    // 随后 `worktree add` 会以 already exists 报错——任务就此永久卡死，retry 也修不好。
    // 此处已确认无 git 数据可保（tempWorktreeWorthKeeping 返回 null），直接删目录解锁。
    if (existsSync(path)) {
      console.warn(`[lark-worker] ⚠ ${path} 是无 git 数据的残留目录（非有效 worktree），直接删除后重建`)
      rmSync(path, { recursive: true, force: true })
    }
  }
  git(['worktree', 'prune'])
  mkdirSync(dirname(path), { recursive: true })
  // QA 验退会复用同一 record_id / hotfix 分支。上一轮成功后临时目录已删、分支仍保留；
  // 此时必须从现有分支 tip 继续，不能把上一轮提交重置回创建基线。
  let branchExists = git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0
  if (branchExists && !branchContainsBase(branch, baseSha)) {
    if (branchHasCommits(branch, baseSha)) {
      throw new Error(`临时分支 ${branch} 已有提交但不包含本次项目基线 ${baseSha.slice(0, 12)}；为避免把旧基线提交混入当前需求，请人工 rebase/cherry-pick 后重试`)
    }
    // 仅落后于新基线、没有任何独有提交的空分支可安全重建；常见于进程中断后留下的旧 online 空分支。
    const removed = git(['branch', '-D', branch])
    if (removed.status !== 0) throw new Error(`重建过期空分支 ${branch} 失败：${gitTail(removed, 160)}`)
    branchExists = false
  }
  const add = branchExists
    ? git(['worktree', 'add', path, branch])
    : git(['worktree', 'add', '-b', branch, path, baseSha])
  if (add.status !== 0) throw new Error(`git worktree add 失败：${gitTail(add, 160)}`)
  linkNodeModules(path)
}

// 主仓下所有存在 node_modules 的目录（相对路径）：根 + 每个 workspace 包（apps/*、packages/*）。
// pnpm monorepo 每个包各有真实 node_modules（共享根 .pnpm store），逐个软链才能让子包依赖解析到位。
const nodeModulesDirsRel = () => {
  const rels = existsSync(join(activeRepoRoot, 'node_modules')) ? [''] : []
  for (const group of ['apps', 'packages']) {
    const groupAbs = join(activeRepoRoot, group)
    if (!existsSync(groupAbs)) continue
    for (const entry of readdirSync(groupAbs, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(groupAbs, entry.name, 'node_modules'))) {
        rels.push(join(group, entry.name))
      }
    }
  }
  return rels
}

// 临时 worktree 与主仓共享同一仓库对象库；其依赖集通常也与活跃项目 worktree 接近，直接软链主仓 node_modules，
// 免去 pnpm install（monorepo 重建整棵符号链接树很慢）。Node 经目录软链 realpath 解析进主仓 store，正确。
// 失败只 warn 不阻塞：claude 仍可自行 pnpm install 兜底。
const linkNodeModules = (worktreePath) => {
  let linked = 0
  for (const rel of nodeModulesDirsRel()) {
    const target = join(activeRepoRoot, rel, 'node_modules')
    const linkPath = join(worktreePath, rel, 'node_modules')
    try {
      if (existsSync(linkPath)) continue
      mkdirSync(dirname(linkPath), { recursive: true })
      symlinkSync(target, linkPath, 'dir')
      linked += 1
    } catch (error) {
      console.warn(`[lark-worker] ⚠ 软链 node_modules 失败（${rel || '根'}），claude 需自行装依赖：${error.message}`)
    }
  }
  if (linked) console.log(`[lark-worker] 已软链主仓 node_modules ×${linked} 到临时 worktree（跳过 pnpm install）`)
}

// git fetch origin online 带退避重试；网络抖动是常见 SPOF。若重试仍失败但本地已有
// origin/online 引用，容忍用（可能陈旧的）本地引用继续（hotfix 分支留待人工 review 时会 rebase），
// 只有本地连引用都没有才真失败。
const fetchOnlineWithRetry = () => {
  const retries = 3
  let last
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    last = git(['fetch', BASE_REMOTE, BASE_BRANCH])
    if (last.status === 0) return
    if (attempt < retries) syncSleep(attempt * 1500)
  }
  if (git(['rev-parse', '--verify', '--quiet', BASE_REF]).status === 0) {
    console.warn(`[lark-worker] ⚠ git fetch ${BASE_REMOTE} ${BASE_BRANCH} 失败，改用本地已有 ${BASE_REF}（可能陈旧）：${gitTail(last, 160)}`)
    return
  }
  throw new Error(`git fetch ${BASE_REMOTE} ${BASE_BRANCH} 失败且本地无 ${BASE_REF} 引用：${gitTail(last, 160)}`)
}

// 收尾：有改动就本地提交到分支（不 push/不合并，留待人工 review），然后删临时目录；
// 没改动则连空分支一起删，免留垃圾。只有 done 才提交；失败/阻塞若有半成品则保留现场。
// 返回 { ok, committed, reason }：ok=false 表示「改动没能落到分支上」，调用方据此把任务降级、
// 不能对群里谎报已完成（见 lark-task-runner 里 done 卡与提交的顺序说明）。
export const finalizeTempWorktree = ({ path, branch, baseRef = BASE_REF, task, allowCommit }) => {
  if (!existsSync(path)) return { ok: true, committed: false, reason: 'worktree 已不存在' }
  const outcome = commitWorktreeChanges({
    cwd: path,
    message: commitMessage('lark hotfix', task.summary || 'fix', task),
    target: branch,
    successReason: `已提交到本地分支 ${branch}`,
    commitDirty: allowCommit,
    dirtyReason: '任务未完成，半成品未提交（现场已保留）',
  })
  // git 状态不可读：无法证明工作区干净，一律保留现场、不做任何删除（宁可留垃圾也不丢改动）。
  if (outcome.state === 'error') {
    console.error(`[lark-worker] ⚠ 读不到 ${path} 的 git 状态，无法确认有无未提交改动；保留临时 worktree 与分支 ${branch}，不做清理`)
    return { ok: outcome.ok, committed: outcome.committed, reason: outcome.reason }
  }
  if (outcome.state === 'dirty') {
    if (!allowCommit) {
      console.error(`[lark-worker] ⚠ ${task.id} 未完成，不自动提交半成品；保留临时 worktree ${path} 待人工检查`)
      return { ok: outcome.ok, committed: outcome.committed, reason: outcome.reason }
    }
    if (!outcome.ok) {
      // 提交失败：绝不 --force 删除（会连未提交改动一起灭失）。保留 worktree 待人工处理。
      console.error(`[lark-worker] ⚠ 提交到 ${branch} 失败，保留临时 worktree ${path} 以免丢改动：${gitTail(outcome.result)}`)
      return { ok: outcome.ok, committed: outcome.committed, reason: outcome.reason }
    }
    console.log(`[lark-worker] 改动已提交到本地分支 ${branch}（未 push），临时 worktree 已删`)
    git(['worktree', 'remove', '--force', path])
    return { ok: outcome.ok, committed: outcome.committed, reason: outcome.reason }
  }
  // 工作区干净：只有分支相对创建基线确无新提交时才删空分支，
  // 否则 AI 可能已自行 commit（改动在提交里、工作区当然干净），删分支会丢。
  const noCommits = !branchHasCommits(branch, baseRef)
  git(['worktree', 'remove', '--force', path])
  if (noCommits) {
    console.log(`[lark-worker] 无改动，删除临时 worktree + 空分支 ${branch}`)
    git(['branch', '-D', branch])
    return { ok: true, committed: false, reason: '工作区无改动' }
  }
  console.log(`[lark-worker] ${branch} 工作区干净但已有提交，保留分支待 review`)
  return { ok: true, committed: true, reason: `${branch} 已有提交（AI 自行提交），保留分支待 review` }
}

// 命中已有 worktree（非临时）：任务成功后把改动提交到该 worktree 当前所在分支，
// 让连续任务各自成独立 commit、不在工作区累加混作一团。只在有改动时提交；失败保留改动在工作区、不删。
//
// **定向提交（COMMIT_MODES.scoped，口径见 lark-commit-policy.mjs）**：路由层只在**任务开始前**查过一次
// 「这个 worktree 是否干净」，而 AI 可以跑 30 分钟。这期间人在同一 worktree 里新写的 WIP，会被
// `git add -A` 一起扫进 bot 的提交——正是 collaboration-and-notifications §4 要防的高风险动作。
// 故这里只提交 `taskPaths`（AI 跑完后实测的本任务改动清单）∩ 收尾时仍有改动的路径；收尾时才出现的
// 路径进 `unexpected`，既不提交也不静默——写进 reason 由完成卡告知人工确认。
// 返回 { ok, committed, reason, unexpected }（ok=false 表示改动没能落到分支上，调用方据此降级任务）。
export const finalizeExistingWorktree = ({ cwd, task, taskPaths }) => {
  const worktreePaths = dirtyPathsFor(cwd)
  if (worktreePaths === null) {
    console.error(`[lark-worker] ⚠ 读不到 ${cwd} 的改动清单，跳过收尾提交（改动仍留工作区，需人工确认）`)
    return { ok: false, committed: false, reason: `读不到 ${cwd} 的改动清单，无法确认本任务改动是否已落盘` }
  }
  const { commit: scoped, unexpected } = partitionScopedPaths({ taskPaths, worktreePaths })
  if (unexpected.length) {
    console.warn(`[lark-worker] ⚠ ${cwd} 收尾时出现 ${unexpected.length} 个本任务之外的改动（任务执行期间产生的 WIP），不予提交：${unexpected.slice(0, 8).join('、')}`)
  }
  const unexpectedNote = unexpected.length
    ? `；另有 ${unexpected.length} 个本任务之外的改动未提交（任务执行期间产生，需你确认）：${unexpected.slice(0, 5).join('、')}`
    : ''
  if (!worktreePaths.length) {
    console.log(`[lark-worker] ${cwd} 无改动，未提交`)
    return { ok: true, committed: false, reason: '工作区无改动', unexpected }
  }
  // 工作区脏但本任务的改动一个都不在了：实测清单在收尾前被回退/挪走，不能按「已完成」处理。
  // 这个判断必须排在提交之前——`paths: []` 会被 commitAll 当成「未指定路径」退回全量 `git add -A`，
  // 那正好是本函数要防的事（把任务执行期间产生的 WIP 一起提交）。
  if (!scoped.length) {
    console.error(`[lark-worker] ⚠ ${cwd} 里本任务的改动已不存在（实测清单 ${(taskPaths || []).length} 项均无改动），不提交`)
    return { ok: false, committed: false, reason: `本任务改动在收尾前已消失，未提交任何内容${unexpectedNote}`, unexpected }
  }
  const outcome = commitWorktreeChanges({
    cwd,
    message: commitMessage('lark task', task.summary || task.text || 'fix', task),
    target: `${cwd} 当前分支`,
    successReason: '',
    paths: scoped,
  })
  if (outcome.state === 'error') {
    console.error(`[lark-worker] ⚠ 读不到 ${cwd} 的 git 状态，跳过收尾提交（改动仍留工作区，需人工确认）`)
    return { ok: outcome.ok, committed: outcome.committed, reason: outcome.reason, unexpected }
  }
  if (outcome.state === 'clean') {
    console.log(`[lark-worker] ${cwd} 无改动，未提交`)
    return { ok: outcome.ok, committed: outcome.committed, reason: outcome.reason, unexpected }
  }
  if (!outcome.ok) {
    console.error(`[lark-worker] ⚠ 提交到 ${cwd} 当前分支失败（改动仍留工作区）：${gitTail(outcome.result)}`)
    return { ok: outcome.ok, committed: outcome.committed, reason: outcome.reason, unexpected }
  }
  const branch = gitAt(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim()
  console.log(`[lark-worker] 本任务 ${scoped.length} 个文件已提交到 ${cwd} 当前分支 ${branch}（未 push）`)
  return { ok: true, committed: true, reason: `已提交到分支 ${branch}（${scoped.length} 个文件）${unexpectedNote}`, unexpected }
}

export const snapshotWorktree = (cwd) => {
  const status = gitAt(cwd, ['status', '--porcelain=v1', '--untracked-files=all'])
  if (status.status !== 0) throw new Error(`读取 git status 失败：${gitTail(status)}`)
  const diff = gitAt(cwd, ['diff', '--binary', 'HEAD'])
  if (diff.status !== 0) throw new Error(`读取 git diff 失败：${gitTail(diff)}`)
  return { status: status.stdout, diff: diff.stdout }
}
