/**
 * Lark Worker 的 git / worktree 操作层：临时 worktree 生命周期（建/软链依赖/收尾提交）、
 * 命中已有 worktree 的 WIP 隔离与收尾提交、只读快照。全部围绕主仓 repoRoot 与传入的 cwd 工作。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { repoRoot } from './lark-worker-env.mjs'

// 同步睡眠（用于 prepareTempWorktree 里同步重试的退避）；不依赖平台 sleep 命令
const syncSleep = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export const git = (args) => spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' })
export const gitAt = (cwd, args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })

// spawnSync 结果的错误摘要（stderr 优先、无则 stdout），截断到人可读长度——多处日志/报错复用。
const gitTail = (res, max = 200) => (res.stderr || res.stdout || '').trim().slice(0, max)
// 工作区是否有未提交改动（含未跟踪）；git 失败时按「无改动」处理，交由调用方各自兜底。
const isDirty = (cwd) => {
  const res = gitAt(cwd, ['status', '--porcelain'])
  return res.status === 0 && Boolean(res.stdout.trim())
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
export const prepareTempWorktree = ({ path, branch }) => {
  fetchOnlineWithRetry()
  if (existsSync(path)) git(['worktree', 'remove', '--force', path]) // 清理残留
  git(['worktree', 'prune'])
  mkdirSync(dirname(path), { recursive: true })
  const add = git(['worktree', 'add', '-B', branch, path, 'origin/online'])
  if (add.status !== 0) throw new Error(`git worktree add 失败：${gitTail(add, 160)}`)
  linkNodeModules(path)
}

// 主仓下所有存在 node_modules 的目录（相对路径）：根 + 每个 workspace 包（apps/*、packages/*）。
// pnpm monorepo 每个包各有真实 node_modules（共享根 .pnpm store），逐个软链才能让子包依赖解析到位。
const nodeModulesDirsRel = () => {
  const rels = existsSync(join(repoRoot, 'node_modules')) ? [''] : []
  for (const group of ['apps', 'packages']) {
    const groupAbs = join(repoRoot, group)
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
    const target = join(repoRoot, rel, 'node_modules')
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
export const finalizeTempWorktree = ({ path, branch, task, allowCommit }) => {
  if (!existsSync(path)) return
  if (isDirty(path)) {
    if (!allowCommit) {
      console.error(`[lark-worker] ⚠ ${task.id} 未完成，不自动提交半成品；保留临时 worktree ${path} 待人工检查`)
      return
    }
    // --no-verify：临时 worktree 无 node_modules，husky pre-commit(pnpm lint-staged) 必失败；
    // 这些是留待人工 review 的 hotfix 提交，不需要跑钩子。
    const committed = commitAll(path, commitMessage('lark hotfix', task.summary || 'fix', task))
    if (committed.status !== 0) {
      // 提交失败：绝不 --force 删除（会连未提交改动一起灭失）。保留 worktree 待人工处理。
      console.error(`[lark-worker] ⚠ 提交到 ${branch} 失败，保留临时 worktree ${path} 以免丢改动：${gitTail(committed)}`)
      return
    }
    console.log(`[lark-worker] 改动已提交到本地分支 ${branch}（未 push），临时 worktree 已删`)
    git(['worktree', 'remove', '--force', path])
    return
  }
  // 工作区干净：只有分支相对 origin/online 确无新提交时才删空分支，
  // 否则 claude 可能已自行 commit（改动在提交里、工作区当然干净），删分支会丢。
  const ahead = git(['rev-list', '--count', `origin/online..${branch}`])
  const noCommits = ahead.status === 0 && ahead.stdout.trim() === '0'
  git(['worktree', 'remove', '--force', path])
  if (noCommits) {
    console.log(`[lark-worker] 无改动，删除临时 worktree + 空分支 ${branch}`)
    git(['branch', '-D', branch])
  } else {
    console.log(`[lark-worker] ${branch} 工作区干净但已有提交，保留分支待 review`)
  }
}

// 命中已有 worktree 且任务开始前该 worktree 已有未提交改动(WIP)：先把 WIP 单独提交一笔，
// 与随后本任务产生的改动隔离成两个 commit（本任务改动由 finalizeExistingWorktree 收尾提交）。
// 提交失败则不动、留给 finalize 时一并处理。
export const commitPreexistingWip = ({ cwd }) => {
  if (!isDirty(cwd)) return
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
export const finalizeExistingWorktree = ({ cwd, task }) => {
  if (!isDirty(cwd)) {
    console.log(`[lark-worker] ${cwd} 无改动，未提交`)
    return
  }
  const committed = commitAll(cwd, commitMessage('lark task', task.summary || task.text || 'fix', task))
  if (committed.status !== 0) {
    console.error(`[lark-worker] ⚠ 提交到 ${cwd} 当前分支失败（改动仍留工作区）：${gitTail(committed)}`)
    return
  }
  const branch = gitAt(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim()
  console.log(`[lark-worker] 改动已提交到 ${cwd} 当前分支 ${branch}（未 push）`)
}

export const snapshotWorktree = (cwd) => {
  const status = gitAt(cwd, ['status', '--porcelain=v1', '--untracked-files=all'])
  if (status.status !== 0) throw new Error(`读取 git status 失败：${gitTail(status)}`)
  const diff = gitAt(cwd, ['diff', '--binary', 'HEAD'])
  if (diff.status !== 0) throw new Error(`读取 git diff 失败：${gitTail(diff)}`)
  return { status: status.stdout, diff: diff.stdout }
}
