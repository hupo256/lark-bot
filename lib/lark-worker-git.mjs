/**
 * Lark Worker 的 git / worktree 操作层：临时 worktree 生命周期（建/按需准备依赖/收尾提交）、
 * 命中已有 worktree 的 WIP 隔离与收尾提交、只读快照。全部围绕主仓 repoRoot 与传入的 cwd 工作。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, rmSync, unlinkSync } from 'node:fs'
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
// bot 的合并提交信息一律以「Merge branch」开头：业务仓的 commit-msg 钩子（falive-react scripts/verify-commit-msg.mjs）只放行
// `<type>: …` 或 Merge / Revert 开头的信息，原来写的 `merge: …` 会被拦（10-21：集成分支同步卡在半路，任务改动没合回）。
export const integrationMergeMessage = ({ branch, integrationBranch, summary = '' }) =>
  `Merge branch '${branch}' into ${integrationBranch}${summary ? `（${String(summary).slice(0, 40)}）` : ''}`

export const setRepoRoot = (root) => {
  activeRepoRoot = root || repoRoot
}

// core.quotepath=off：中文路径（falive 的 docs/delivery/待对接/…）默认会被 git 输出成 \345\257… 八进制转义，
// name-only / numstat 拿到的是转义串，与范围契约里的真实路径对不上，会被误判成「改了契约外的文件」（2026-10-13 真机）。
export const git = (args) => spawnSync('git', ['-C', activeRepoRoot, '-c', 'core.quotepath=off', ...args], { encoding: 'utf8' })
export const gitAt = (cwd, args) => spawnSync('git', ['-C', cwd, '-c', 'core.quotepath=off', ...args], { encoding: 'utf8' })
// 多仓：临时 worktree 属于哪个主仓由调用方传 repoRoot（仓库 profile 的 root）；缺省仍是默认主仓。
const gitIn = (root, args) => gitAt(root || activeRepoRoot, args)

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
// 超长时首尾各留一半：git 的结论常在最后一行（「Automatic merge failed…」），只截开头会丢（aven 2026-10-20 review #19）。
export const gitTail = (res, max = 200) => {
  const text = (res?.stderr || res?.stdout || '').trim()
  if (text.length <= max) return text
  const half = Math.max(1, Math.floor((max - 3) / 2))
  return `${text.slice(0, half)} … ${text.slice(-half)}`
}
// 工作区状态三态：'clean' | 'dirty' | 'error'。**必须把 git 异常与 clean 区分开**——
// 曾经这里 git 失败返回 false（视作无改动），会让 finalizeTempWorktree 走「干净可删」分支
// remove --force + branch -D，把无法确认的改动连同分支一起灭失。不可读时一律按「可能有改动」处理。
export const worktreeState = (cwd) => {
  const res = gitAt(cwd, ['status', '--porcelain'])
  if (res.status !== 0) return 'error'
  return res.stdout.trim() ? 'dirty' : 'clean'
}
// 全量暂存并正常运行 hook 提交。传 paths 则退化为**定向提交**：只暂存并提交
// 这些路径（`commit -- <pathspec>` 不受索引里其它条目影响，含 enforceCodeQuality 留下的 intent-to-add）。
// 返回 spawnSync 结果，失败处理留给调用方。
const commitAll = (cwd, message, paths) => {
  if (paths?.length) {
    const added = gitAt(cwd, ['add', '-A', '--', ...paths])
    if (added.status !== 0) return added
    return gitAt(cwd, ['commit', '-m', message, '--', ...paths])
  }
  const added = gitAt(cwd, ['add', '-A'])
  if (added.status !== 0) return added
  return gitAt(cwd, ['commit', '-m', message])
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
//   · 干完自动本地提交到 hotfix 分支、删掉临时目录；分支保留待 review，配了集成分支的仓库合回后即删（deleteMergedTaskBranch）
//   · 无常驻 worktree 蔓延（用完即删）
// 分支相对其创建基线是否已有提交。git 失败按「有提交」处理（宁可保守保留，不可误删）。
const branchHasCommits = (branch, baseRef = BASE_REF, root) => {
  const ahead = gitIn(root, ['rev-list', '--count', `${baseRef}..${branch}`])
  return !(ahead.status === 0 && ahead.stdout.trim() === '0')
}

const branchContainsBase = (branch, baseRef, root) =>
  gitIn(root, ['merge-base', '--is-ancestor', baseRef, branch]).status === 0

// 残留现场是否值得保留：上次失败/阻塞时 finalizeTempWorktree 会**故意**留下带半成品的 worktree。
// 有未提交改动 / git 状态不可读 / 分支已有提交，三者任一都说明里面有人类还没看过的东西。
const tempWorktreeWorthKeeping = ({ path, branch, baseRef, root }) => {
  // 不是有效 worktree（残留空壳目录）→ 无 git 数据可保，交由调用方按原逻辑重建。
  if (gitAt(path, ['rev-parse', '--is-inside-work-tree']).status !== 0) return null
  const state = worktreeState(path)
  if (state === 'dirty') return '有未提交改动'
  if (state === 'error') return 'git 状态不可读'
  if (branchHasCommits(branch, baseRef, root)) return '分支已有提交'
  return null
}

// fetchBase 缺省时沿用旧口径：只有默认基线 origin/online 才 fetch；仓库 profile 可显式指定
//（远端 ref 为 true、本地集成分支为 false，人类 WIP 改道的 sha 基线恒为 false）。
// 挂起现场跟进新基线：stash（含未跟踪）→ rebase / reset → stash pop。冲突则回滚到原 HEAD 并还原 stash。
const advanceTempWorktreeToBase = ({ path, branch, baseSha, root }) => {
  const originalHead = gitAt(path, ['rev-parse', 'HEAD']).stdout.trim()
  const dirty = worktreeState(path) === 'dirty'
  if (dirty) {
    // 终检会 `git add -N` 登记新文件，stash 收不了 intent-to-add 条目（not uptodate. Cannot merge）：先把索引退回 HEAD，新文件变回未跟踪、内容不动（教训 #40）。
    gitAt(path, ['reset', '-q'])
    const stashed = gitAt(path, ['stash', 'push', '--include-untracked', '-m', `lark-advance-${branch}`])
    if (stashed.status !== 0) return { ok: false, reason: `stash 失败：${gitTail(stashed, 120)}` }
  }
  const hasOwnCommits = branchHasCommits(branch, originalHead, root) || gitAt(path, ['rev-list', '--count', `${baseSha}..HEAD`]).stdout.trim() !== '0'
  const mode = hasOwnCommits && gitAt(path, ['merge-base', '--is-ancestor', originalHead, baseSha]).status !== 0 ? 'rebase' : 'reset'
  const moved = mode === 'rebase' ? gitAt(path, ['rebase', baseSha]) : gitAt(path, ['reset', '--hard', baseSha])
  if (moved.status !== 0) {
    if (mode === 'rebase') gitAt(path, ['rebase', '--abort'])
    gitAt(path, ['reset', '--hard', originalHead])
    if (dirty) gitAt(path, ['stash', 'pop'])
    return { ok: false, reason: `${mode} 到新基线冲突：${gitTail(moved, 160)}` }
  }
  if (dirty) {
    const popped = gitAt(path, ['stash', 'pop'])
    if (popped.status !== 0) {
      // pop 冲突：回到原 HEAD 再 pop，保证现场原样。
      gitAt(path, ['checkout', '--', '.'])
      gitAt(path, ['clean', '-fd'])
      gitAt(path, ['reset', '--hard', originalHead])
      gitAt(path, ['stash', 'pop'])
      return { ok: false, reason: `未提交改动与新基线冲突：${gitTail(popped, 160)}` }
    }
  }
  return { ok: true, mode }
}

const ensureBaseRef = (baseRef, { root, fetchBase } = {}) => {
  const shouldFetch = typeof fetchBase === 'boolean' ? fetchBase : baseRef === BASE_REF
  if (shouldFetch) fetchBaseWithRetry(baseRef, root)
  const resolved = gitIn(root, ['rev-parse', '--verify', `${baseRef}^{commit}`])
  if (resolved.status !== 0) throw new Error(`临时 worktree 基线 ${baseRef} 不存在：${gitTail(resolved, 160)}`)
  return resolved.stdout.trim()
}

export const prepareTempWorktree = ({ path, branch, baseRef = BASE_REF, repoRoot, fetchBase }) => {
  const root = repoRoot || activeRepoRoot
  const baseSha = ensureBaseRef(baseRef, { root, fetchBase })
  if (existsSync(path)) {
    // retry / resume 复用同一 task.id ⇒ 解析出同一 path + branch。若在此无条件
    // `worktree remove --force` + `worktree add -B`，会把上次失败刻意保留的半成品连同分支上
    // 已有的提交一起重置灭失——正好摧毁「失败保留现场」这条保证。故先判残留是否有价值：
    // 有价值就原地复用（AI 在上次现场继续，补料续跑本就该如此），无价值才重建。
    const keepReason = tempWorktreeWorthKeeping({ path, branch, baseRef, root })
    if (keepReason) {
      if (!branchContainsBase(branch, baseSha, root)) {
        // 基线在任务挂起期间前移了（人类在集成分支上又提交了）：把现场跟上去——未提交改动先 stash，
        // 分支有自己的提交就 rebase、没有就 reset 到新基线，再 stash pop。任一步冲突即恢复原状并抛错交人工。
        const advanced = advanceTempWorktreeToBase({ path, branch, baseSha, root })
        if (!advanced.ok) {
          throw new Error(`临时分支 ${branch} 不包含本次项目基线 ${baseSha.slice(0, 12)}，且现场${keepReason}；自动跟进基线失败（${advanced.reason}），已保留现场，请人工 rebase/cherry-pick 后重试`)
        }
        console.log(`[lark-worker] 临时 worktree ${path} 已跟进新基线 ${baseSha.slice(0, 12)}（${advanced.mode}），保留未提交改动`)
      }
      console.log(`[lark-worker] 复用上次保留的临时 worktree ${path}（${keepReason}），不重建以免丢改动`)
      removeLegacyNodeModulesLinks(path, root)
      return
    }
    gitIn(root, ['worktree', 'remove', '--force', path]) // 干净且无提交的残留，可安全清理
    // 残留是个「空壳目录」（不是注册过的 worktree）时上面这条必然失败、目录还在，
    // 随后 `worktree add` 会以 already exists 报错——任务就此永久卡死，retry 也修不好。
    // 此处已确认无 git 数据可保（tempWorktreeWorthKeeping 返回 null），直接删目录解锁。
    if (existsSync(path)) {
      console.warn(`[lark-worker] ⚠ ${path} 是无 git 数据的残留目录（非有效 worktree），直接删除后重建`)
      rmSync(path, { recursive: true, force: true })
    }
  }
  gitIn(root, ['worktree', 'prune'])
  mkdirSync(dirname(path), { recursive: true })
  // QA 验退会复用同一 record_id / hotfix 分支。上一轮成功后临时目录已删、分支仍保留；
  // 此时必须从现有分支 tip 继续，不能把上一轮提交重置回创建基线。
  let branchExists = gitIn(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0
  if (branchExists && !branchContainsBase(branch, baseSha, root)) {
    if (branchHasCommits(branch, baseSha, root)) {
      throw new Error(`临时分支 ${branch} 已有提交但不包含本次项目基线 ${baseSha.slice(0, 12)}；为避免把旧基线提交混入当前需求，请人工 rebase/cherry-pick 后重试`)
    }
    // 仅落后于新基线、没有任何独有提交的空分支可安全重建；常见于进程中断后留下的旧 online 空分支。
    const removed = gitIn(root, ['branch', '-D', branch])
    if (removed.status !== 0) throw new Error(`重建过期空分支 ${branch} 失败：${gitTail(removed, 160)}`)
    branchExists = false
  }
  const add = branchExists
    ? gitIn(root, ['worktree', 'add', path, branch])
    : gitIn(root, ['worktree', 'add', '-b', branch, path, baseSha])
  if (add.status !== 0) throw new Error(`git worktree add 失败：${gitTail(add, 160)}`)
  removeLegacyNodeModulesLinks(path, root)
}

// 只迁移旧 bot 曾创建、且仍精确指向主仓的依赖软链；不碰独立安装或其它来源的依赖。
const nodeModulesDirsRel = (worktreePath, repoRoot = activeRepoRoot) => {
  const rels = new Set([''])
  for (const group of ['apps', 'packages']) {
    for (const root of [repoRoot, worktreePath]) {
      const groupAbs = join(root, group)
      if (!existsSync(groupAbs)) continue
      for (const entry of readdirSync(groupAbs, { withFileTypes: true })) {
        if (entry.isDirectory()) rels.add(join(group, entry.name))
      }
    }
  }
  return rels
}

const removeLegacyNodeModulesLinks = (worktreePath, repoRoot = activeRepoRoot) => {
  for (const rel of nodeModulesDirsRel(worktreePath, repoRoot)) {
    const target = join(repoRoot, rel, 'node_modules')
    const linkPath = join(worktreePath, rel, 'node_modules')
    let isLink = false
    try {
      isLink = lstatSync(linkPath).isSymbolicLink()
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (isLink &&
      resolve(dirname(linkPath), readlinkSync(linkPath)) === target) {
      unlinkSync(linkPath)
      console.log(`[lark-worker] 已移除旧 bot 的跨 worktree 依赖软链：${rel || '根'}`)
    }
  }
}

// git fetch origin online 带退避重试；网络抖动是常见 SPOF。若重试仍失败但本地已有
// origin/online 引用，容忍用（可能陈旧的）本地引用继续（hotfix 分支留待人工 review 时会 rebase），
// 只有本地连引用都没有才真失败。
// baseRef 形如 `<remote>/<branch>` 才能 fetch；其它形态（本地分支 / sha）调用方不该传 fetchBase=true。
const fetchBaseWithRetry = (baseRef = BASE_REF, root) => {
  const slash = baseRef.indexOf('/')
  if (slash <= 0) throw new Error(`基线 ${baseRef} 不是 <remote>/<branch> 形态，无法 fetch（本地分支请在 profile 里设 fetchBase:false）`)
  const remote = baseRef.slice(0, slash)
  const branch = baseRef.slice(slash + 1)
  const retries = 3
  let last
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    last = gitIn(root, ['fetch', remote, branch])
    if (last.status === 0) return
    if (attempt < retries) syncSleep(attempt * 1500)
  }
  if (gitIn(root, ['rev-parse', '--verify', '--quiet', baseRef]).status === 0) {
    console.warn(`[lark-worker] ⚠ git fetch ${remote} ${branch} 失败，改用本地已有 ${baseRef}（可能陈旧）：${gitTail(last, 160)}`)
    return
  }
  throw new Error(`git fetch ${remote} ${branch} 失败且本地无 ${baseRef} 引用：${gitTail(last, 160)}`)
}

// 收尾：有改动就本地提交到分支（不 push/不合并，留待人工 review），然后删临时目录；
// 没改动则连空分支一起删，免留垃圾。只有 done 才提交；失败/阻塞若有半成品则保留现场。
// 返回 { ok, committed, reason }：ok=false 表示「改动没能落到分支上」，调用方据此把任务降级、
// 不能对群里谎报已完成（见 lark-task-runner 里 done 卡与提交的顺序说明）。
// commitPrefix：仓库 profile 可指定提交标题前缀以满足该仓的 commit-msg 钩子（falive 要求 `<type>(<scope>)?: <中文主题>`，
// 默认的 `lark hotfix:` 会被钩子拒绝，2026-10-13 真机）。
export const finalizeTempWorktree = ({ path, branch, baseRef = BASE_REF, task, allowCommit, repoRoot, commitPrefix = 'lark hotfix' }) => {
  const root = repoRoot || activeRepoRoot
  if (!existsSync(path)) return { ok: true, committed: false, reason: 'worktree 已不存在' }
  const outcome = commitWorktreeChanges({
    cwd: path,
    message: commitMessage(commitPrefix, task.summary || 'fix', task),
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
    gitIn(root, ['worktree', 'remove', '--force', path])
    return { ok: outcome.ok, committed: outcome.committed, reason: outcome.reason }
  }
  // 工作区干净：只有分支相对创建基线确无新提交时才删空分支，
  // 否则 AI 可能已自行 commit（改动在提交里、工作区当然干净），删分支会丢。
  const noCommits = !branchHasCommits(branch, baseRef, root)
  gitIn(root, ['worktree', 'remove', '--force', path])
  if (noCommits) {
    console.log(`[lark-worker] 无改动，删除临时 worktree + 空分支 ${branch}`)
    gitIn(root, ['branch', '-D', branch])
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
// 临时 worktree 走「只提交本任务文件」收尾后，工作区已干净就顺手删掉：否则分支仍被它检出，紧接着合回集成分支后的
// deleteMergedTaskBranch 会被拒，要等每小时的回收才清（教训 #45）。还有未提交改动 / 读不到状态一律保留。
export const removeTempWorktreeIfClean = ({ path, repoRoot }) => {
  if (!path || !existsSync(path) || worktreeState(path) !== 'clean') return false
  return gitIn(repoRoot, ['worktree', 'remove', path]).status === 0
}

export const finalizeExistingWorktree = ({ cwd, task, taskPaths, commitPrefix = 'lark task' }) => {
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
    message: commitMessage(commitPrefix, task.summary || task.text || 'fix', task),
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

// ---------- 集成分支（整改 #10 / #11） ----------
// 常驻 worktree <worktreesDir>/integration 检出 integrationBranch；没有分支就从 baseRef 建。
// 每次任务开始前把 baseRef（aven 的工作分支）合进集成分支（aven 本地领先的部分 bot 也要看见）；
// 合不进（冲突）就 abort、返回 reason 交人，任务改为从 baseRef 开（不让冲突拦住干活）。
export const ensureIntegrationBranch = ({ root, integrationBranch, baseRef, worktreePath }) => {
  const exists = gitIn(root, ['show-ref', '--verify', '--quiet', `refs/heads/${integrationBranch}`]).status === 0
  if (!exists) {
    const created = gitIn(root, ['branch', integrationBranch, baseRef])
    if (created.status !== 0) return { ok: false, reason: `建集成分支失败：${gitTail(created)}` }
  }
  if (!existsSync(worktreePath)) {
    gitIn(root, ['worktree', 'prune'])
    mkdirSync(dirname(worktreePath), { recursive: true })
    const add = gitIn(root, ['worktree', 'add', worktreePath, integrationBranch])
    if (add.status !== 0) return { ok: false, reason: `集成 worktree 建立失败：${gitTail(add)}` }
  }
  const onBranch = gitAt(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim()
  if (onBranch !== integrationBranch) return { ok: false, reason: `集成 worktree 不在 ${integrationBranch} 上（在 ${onBranch}）` }
  const dirty = gitAt(worktreePath, ['status', '--porcelain']).stdout.trim()
  if (dirty) return { ok: false, reason: '集成 worktree 有未提交改动，不敢合并' }
  // 跟上 aven 的工作分支：已包含就跳过；能 ff 就 ff；否则 merge，冲突即 abort。
  const contains = gitIn(root, ['merge-base', '--is-ancestor', baseRef, integrationBranch]).status === 0
  if (!contains) {
    const merged = gitAt(worktreePath, ['merge', '--no-edit', '-m', integrationMergeMessage({ branch: baseRef, integrationBranch }), baseRef])
    if (merged.status !== 0) {
      const conflicts = gitAt(worktreePath, ['diff', '--name-only', '--diff-filter=U']).stdout.trim().split('\n').filter(Boolean)
      gitAt(worktreePath, ['merge', '--abort'])
      return { ok: false, reason: `把 ${baseRef} 合进 ${integrationBranch} 有冲突：${conflicts.slice(0, 6).join('、') || gitTail(merged, 120)}`, conflicts }
    }
  }
  const head = gitIn(root, ['rev-parse', integrationBranch]).stdout.trim()
  return { ok: true, head }
}

// 任务分支合回集成分支（--no-ff，留痕）。冲突 → abort，返回冲突文件给人。
export const mergeIntoIntegration = ({ root, worktreePath, branch, integrationBranch, message }) => {
  if (!existsSync(worktreePath)) return { ok: false, reason: '集成 worktree 不存在' }
  const dirty = gitAt(worktreePath, ['status', '--porcelain']).stdout.trim()
  if (dirty) return { ok: false, reason: '集成 worktree 有未提交改动，不敢合并' }
  const already = gitIn(root, ['merge-base', '--is-ancestor', branch, integrationBranch]).status === 0
  if (already) return { ok: true, merged: false, reason: '已包含', head: gitIn(root, ['rev-parse', integrationBranch]).stdout.trim() }
  const merged = gitAt(worktreePath, ['merge', '--no-ff', '--no-edit', '-m', message, branch])
  if (merged.status !== 0) {
    const conflicts = gitAt(worktreePath, ['diff', '--name-only', '--diff-filter=U']).stdout.trim().split('\n').filter(Boolean)
    gitAt(worktreePath, ['merge', '--abort'])
    return { ok: false, reason: `合进 ${integrationBranch} 有冲突：${conflicts.slice(0, 6).join('、') || gitTail(merged, 120)}`, conflicts }
  }
  return { ok: true, merged: true, head: gitIn(root, ['rev-parse', integrationBranch]).stdout.trim() }
}

// 合回集成分支后删掉任务分支：改动已在集成分支的 merge 提交里，分支只剩名字，留着会越积越多（aven 2026-10-16）。
// 只删「本仓任务分支前缀（profile.branchPrefix，如 lark/falive-*；未传沿用 lark/）、不是集成分支本身、且已是集成分支祖先」的分支；用 merge-base 判包含而不是 `branch -d`
// （-d 看的是主仓当前检出分支，aven 的 feature 分支往往还没合进集成分支，会误拒）。
// 分支仍被某个 worktree 检出（失败现场 / 已有 worktree 任务）时 `branch -D` 本身会拒绝，按未删返回。
const isTaskBranch = (branch, branchPrefix) => (branchPrefix
  ? branch.startsWith(`${branchPrefix}-`) || branch.startsWith(`${branchPrefix}/`)
  : branch.startsWith('lark/'))
export const deleteMergedTaskBranch = ({ root, branch, integrationBranch, branchPrefix = null }) => {
  if (!branch || !isTaskBranch(branch, branchPrefix) || branch === integrationBranch) {
    return { deleted: false, reason: `不是可清理的任务分支：${branch}` }
  }
  if (gitIn(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).status !== 0) {
    return { deleted: false, reason: '分支已不存在' }
  }
  if (gitIn(root, ['merge-base', '--is-ancestor', branch, integrationBranch]).status !== 0) {
    return { deleted: false, reason: `${integrationBranch} 未完整包含 ${branch}，保留` }
  }
  const removed = gitIn(root, ['branch', '-D', branch])
  if (removed.status !== 0) return { deleted: false, reason: gitTail(removed, 120) }
  return { deleted: true }
}
