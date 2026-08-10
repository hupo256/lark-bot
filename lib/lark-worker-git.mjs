/**
 * Lark Worker 的 git / worktree 操作层：临时 worktree 生命周期（建/软链依赖/收尾提交）、
 * 命中已有 worktree 的 WIP 隔离与收尾提交、只读快照。全部围绕主仓 repoRoot 与传入的 cwd 工作。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { repoRoot } from './lark-worker-env.mjs'

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

// spawnSync 结果的错误摘要（stderr 优先、无则 stdout），截断到人可读长度——多处日志/报错复用。
const gitTail = (res, max = 200) => (res.stderr || res.stdout || '').trim().slice(0, max)
// 工作区状态三态：'clean' | 'dirty' | 'error'。**必须把 git 异常与 clean 区分开**——
// 曾经这里 git 失败返回 false（视作无改动），会让 finalizeTempWorktree 走「干净可删」分支
// remove --force + branch -D，把无法确认的改动连同分支一起灭失。不可读时一律按「可能有改动」处理。
const worktreeState = (cwd) => {
  const res = gitAt(cwd, ['status', '--porcelain'])
  if (res.status !== 0) return 'error'
  return res.stdout.trim() ? 'dirty' : 'clean'
}
// 全量暂存并提交（无人值守：--no-verify 跳过 husky）。返回 spawnSync 结果，失败处理留给调用方。
const commitAll = (cwd, message) => {
  gitAt(cwd, ['add', '-A'])
  return gitAt(cwd, ['commit', '--no-verify', '-m', message])
}
// 收尾提交信息统一格式：`<前缀>: <摘要截断> [<id>]`，可选追加质量告警。摘要由调用方决定 fallback。
const commitMessage = (prefix, summary, task) =>
  `${prefix}: ${summary.slice(0, 60)} [${task.id}]${task.qualityNote ? `\n\n⚠ ${task.qualityNote}` : ''}`

// 无 worktree 的任务用「一次性临时 worktree」而非切主仓分支：
//   · 不碰主仓（主仓脏/在别的分支都不受影响），天然无并发/顺序碰撞
//   · 基于 origin/online 建 hotfix 分支，干完自动本地提交到该分支、删掉临时目录（分支保留待 review）
//   · 无常驻 worktree 蔓延（用完即删）
// 分支相对 origin/online 是否已有提交。git 失败按「有提交」处理（宁可保守保留，不可误删）。
const branchHasCommits = (branch) => {
  const ahead = git(['rev-list', '--count', `origin/online..${branch}`])
  return !(ahead.status === 0 && ahead.stdout.trim() === '0')
}

// 残留现场是否值得保留：上次失败/阻塞时 finalizeTempWorktree 会**故意**留下带半成品的 worktree。
// 有未提交改动 / git 状态不可读 / 分支已有提交，三者任一都说明里面有人类还没看过的东西。
const tempWorktreeWorthKeeping = ({ path, branch }) => {
  // 不是有效 worktree（残留空壳目录）→ 无 git 数据可保，交由调用方按原逻辑重建。
  if (gitAt(path, ['rev-parse', '--is-inside-work-tree']).status !== 0) return null
  const state = worktreeState(path)
  if (state === 'dirty') return '有未提交改动'
  if (state === 'error') return 'git 状态不可读'
  if (branchHasCommits(branch)) return '分支已有提交'
  return null
}

export const prepareTempWorktree = ({ path, branch }) => {
  fetchOnlineWithRetry()
  if (existsSync(path)) {
    // retry / resume 复用同一 task.id ⇒ 解析出同一 path + branch。若在此无条件
    // `worktree remove --force` + `worktree add -B`，会把上次失败刻意保留的半成品连同分支上
    // 已有的提交一起重置灭失——正好摧毁「失败保留现场」这条保证。故先判残留是否有价值：
    // 有价值就原地复用（AI 在上次现场继续，补料续跑本就该如此），无价值才重建。
    const keepReason = tempWorktreeWorthKeeping({ path, branch })
    if (keepReason) {
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
  const add = git(['worktree', 'add', '-B', branch, path, 'origin/online'])
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

// 临时 worktree 基于同一 commit（origin/online），依赖集与主仓一致 → 直接软链主仓 node_modules，
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
    last = git(['fetch', 'origin', 'online'])
    if (last.status === 0) return
    if (attempt < retries) syncSleep(attempt * 1500)
  }
  if (git(['rev-parse', '--verify', '--quiet', 'origin/online']).status === 0) {
    console.warn(`[lark-worker] ⚠ git fetch origin online 失败，改用本地已有 origin/online（可能陈旧）：${gitTail(last, 160)}`)
    return
  }
  throw new Error(`git fetch origin online 失败且本地无 origin/online 引用：${gitTail(last, 160)}`)
}

// 收尾：有改动就本地提交到分支（不 push/不合并，留待人工 review），然后删临时目录；
// 没改动则连空分支一起删，免留垃圾。只有 done 才提交；失败/阻塞若有半成品则保留现场。
// 返回 { ok, committed, reason }：ok=false 表示「改动没能落到分支上」，调用方据此把任务降级、
// 不能对群里谎报已完成（见 lark-task-runner 里 done 卡与提交的顺序说明）。
export const finalizeTempWorktree = ({ path, branch, task, allowCommit }) => {
  if (!existsSync(path)) return { ok: true, committed: false, reason: 'worktree 已不存在' }
  const state = worktreeState(path)
  // git 状态不可读：无法证明工作区干净，一律保留现场、不做任何删除（宁可留垃圾也不丢改动）。
  if (state === 'error') {
    console.error(`[lark-worker] ⚠ 读不到 ${path} 的 git 状态，无法确认有无未提交改动；保留临时 worktree 与分支 ${branch}，不做清理`)
    return { ok: false, committed: false, reason: `读不到 ${path} 的 git 状态，无法确认改动是否已落盘` }
  }
  if (state === 'dirty') {
    if (!allowCommit) {
      console.error(`[lark-worker] ⚠ ${task.id} 未完成，不自动提交半成品；保留临时 worktree ${path} 待人工检查`)
      return { ok: false, committed: false, reason: '任务未完成，半成品未提交（现场已保留）' }
    }
    // --no-verify：临时 worktree 无 node_modules，husky pre-commit(pnpm lint-staged) 必失败；
    // 这些是留待人工 review 的 hotfix 提交，不需要跑钩子。
    const committed = commitAll(path, commitMessage('lark hotfix', task.summary || 'fix', task))
    if (committed.status !== 0) {
      // 提交失败：绝不 --force 删除（会连未提交改动一起灭失）。保留 worktree 待人工处理。
      console.error(`[lark-worker] ⚠ 提交到 ${branch} 失败，保留临时 worktree ${path} 以免丢改动：${gitTail(committed)}`)
      return { ok: false, committed: false, reason: `git commit 到 ${branch} 失败：${gitTail(committed, 120)}` }
    }
    console.log(`[lark-worker] 改动已提交到本地分支 ${branch}（未 push），临时 worktree 已删`)
    git(['worktree', 'remove', '--force', path])
    return { ok: true, committed: true, reason: `已提交到本地分支 ${branch}` }
  }
  // 工作区干净：只有分支相对 origin/online 确无新提交时才删空分支，
  // 否则 claude 可能已自行 commit（改动在提交里、工作区当然干净），删分支会丢。
  const noCommits = !branchHasCommits(branch)
  git(['worktree', 'remove', '--force', path])
  if (noCommits) {
    console.log(`[lark-worker] 无改动，删除临时 worktree + 空分支 ${branch}`)
    git(['branch', '-D', branch])
    return { ok: true, committed: false, reason: '工作区无改动' }
  }
  console.log(`[lark-worker] ${branch} 工作区干净但已有提交，保留分支待 review`)
  return { ok: true, committed: true, reason: `${branch} 已有提交（AI 自行提交），保留分支待 review` }
}

// 命中已有 worktree 且任务开始前该 worktree 已有未提交改动(WIP)：先把 WIP 单独提交一笔，
// 与随后本任务产生的改动隔离成两个 commit（本任务改动由 finalizeExistingWorktree 收尾提交）。
// 提交失败则不动、留给 finalize 时一并处理。
export const commitPreexistingWip = ({ cwd }) => {
  const state = worktreeState(cwd)
  if (state === 'error') {
    console.error(`[lark-worker] ⚠ 读不到 ${cwd} 的 git 状态，跳过任务前 WIP 隔离提交（若确有 WIP，将与本任务改动混在一起）`)
    return
  }
  if (state === 'clean') return
  const committed = commitAll(cwd, 'chore(wip): 保存 Lark 任务开始前该 worktree 已存在的未提交改动（非本任务产生，自动隔离提交）')
  if (committed.status !== 0) {
    console.error(`[lark-worker] ⚠ 预提交任务前 WIP 失败（改动仍留工作区，将与本任务改动一并提交）：${gitTail(committed)}`)
    return
  }
  console.log(`[lark-worker] 已把任务前的 WIP 单独提交隔离（${cwd}）`)
}

// 命中已有 worktree（非临时）：任务成功后把改动提交到该 worktree 当前所在分支，
// 让连续任务各自成独立 commit、不在工作区累加混作一团。只在有改动时提交；失败保留改动在工作区、不删。
// 任务前的既存 WIP 已由 commitPreexistingWip 提前单独提交隔离，故此处正常只含本任务改动。
// 返回同 finalizeTempWorktree 的 { ok, committed, reason }。
export const finalizeExistingWorktree = ({ cwd, task }) => {
  const state = worktreeState(cwd)
  if (state === 'error') {
    console.error(`[lark-worker] ⚠ 读不到 ${cwd} 的 git 状态，跳过收尾提交（改动仍留工作区，需人工确认）`)
    return { ok: false, committed: false, reason: `读不到 ${cwd} 的 git 状态，无法确认改动是否已落盘` }
  }
  if (state === 'clean') {
    console.log(`[lark-worker] ${cwd} 无改动，未提交`)
    return { ok: true, committed: false, reason: '工作区无改动' }
  }
  const committed = commitAll(cwd, commitMessage('lark task', task.summary || task.text || 'fix', task))
  if (committed.status !== 0) {
    console.error(`[lark-worker] ⚠ 提交到 ${cwd} 当前分支失败（改动仍留工作区）：${gitTail(committed)}`)
    return { ok: false, committed: false, reason: `git commit 到 ${cwd} 当前分支失败：${gitTail(committed, 120)}` }
  }
  const branch = gitAt(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim()
  console.log(`[lark-worker] 改动已提交到 ${cwd} 当前分支 ${branch}（未 push）`)
  return { ok: true, committed: true, reason: `已提交到分支 ${branch}` }
}

export const snapshotWorktree = (cwd) => {
  const status = gitAt(cwd, ['status', '--porcelain=v1', '--untracked-files=all'])
  if (status.status !== 0) throw new Error(`读取 git status 失败：${gitTail(status)}`)
  const diff = gitAt(cwd, ['diff', '--binary', 'HEAD'])
  if (diff.status !== 0) throw new Error(`读取 git diff 失败：${gitTail(diff)}`)
  return { status: status.stdout, diff: diff.stdout }
}
