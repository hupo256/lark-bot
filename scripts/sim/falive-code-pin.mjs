/**
 * falive bot 当时跑的是哪版代码 / 配置（design-v2 §8 P0-h / P1 校准用）：只读存档 ~/github/lark-bot-falive，不动它。
 *   · 代码：falive 网关每次启动在 gateway.log 打一行 `code=<12 位指纹> startedAt=<ISO>`（10-20 起才有）。取某时刻之前最后一次启动的指纹，
 *     在 feature/falive-repo-profile 上从「启动前最后一个提交」往前试几个，worktree 建在 ~/github/lark-bot-falive-sim/code-<sha>，
 *     用那版自己的 computeCodeHash 复算（指纹把 runtime 根下的 json 也算进去：当时已有的配置备份 + lark-bug-record-links.json，按 mtime 摆回去再算）。
 *     对上 = verified；对不上（10-20 前没有指纹 / 当时有未提交的改动 / 链接缓存内容变过）退回按时间取的提交，verified=false。
 *   · 配置：runtime/lark-bot.bak-<日期>*.local.json 是改配置时备份的旧版，mtime = 备份时刻。某时刻生效的配置 = mtime 晚于它的最早一份备份；
 *     都早于它就是现行 lark-bot.local.json。
 * 纯函数（parseCodeStarts / runningCodeAt / pickConfigBackup）可单测；IO 在 pinFaliveCode / faliveConfigAt。
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const FALIVE_ARCHIVE = join(homedir(), 'github', 'lark-bot-falive')
export const FALIVE_BRANCH = 'feature/falive-repo-profile'
export const FALIVE_SIM_ROOT = join(homedir(), 'github', 'lark-bot-falive-sim') // 存档只读：要跑它的代码就在这里另建 worktree
const GATEWAY_LOG = join(homedir(), 'Library', 'Logs', 'falive-lark', 'gateway.log')

const CODE_LINE_RE = /\[lark-gateway\] code=([0-9a-f]{12}) startedAt=(\S+?)（/g
export const parseCodeStarts = (text) => [...String(text || '').matchAll(CODE_LINE_RE)]
  .map((m) => ({ codeHash: m[1], startedAtMs: Date.parse(m[2]) }))
  .filter((e) => Number.isFinite(e.startedAtMs))
  .sort((a, b) => a.startedAtMs - b.startedAtMs)
export const runningCodeAt = (starts, atMs) => starts.filter((e) => e.startedAtMs <= atMs).at(-1) || null

// backups：[{ path, mtimeMs }]；返回 atMs 时生效的那份（null = 用现行配置）
export const pickConfigBackup = (backups, atMs) => [...backups].filter((b) => b.mtimeMs > atMs).sort((a, b) => a.mtimeMs - b.mtimeMs)[0] || null

const listConfigBackups = () => readdirSync(join(FALIVE_ARCHIVE, 'runtime'))
  .filter((f) => /^lark-bot\.bak-.*\.local\.json$/.test(f))
  .map((f) => ({ path: join(FALIVE_ARCHIVE, 'runtime', f), mtimeMs: statSync(join(FALIVE_ARCHIVE, 'runtime', f)).mtimeMs }))

export const faliveConfigAt = (atMs) => {
  const backup = pickConfigBackup(listConfigBackups(), atMs)
  const path = backup?.path || join(FALIVE_ARCHIVE, 'runtime', 'lark-bot.local.json')
  return { path, config: JSON.parse(readFileSync(path, 'utf8')) }
}

const git = (args, cwd = FALIVE_ARCHIVE) => spawnSync('git', args, { cwd, encoding: 'utf8' })

const ensureWorktree = (sha) => {
  const dir = join(FALIVE_SIM_ROOT, `code-${sha.slice(0, 7)}`)
  if (!existsSync(join(dir, 'lark-gateway.mjs'))) {
    mkdirSync(FALIVE_SIM_ROOT, { recursive: true })
    const added = git(['worktree', 'add', '--detach', dir, sha])
    if (added.status !== 0) throw new Error(`git worktree add ${sha} 失败：${added.stderr.slice(0, 300)}`)
  }
  return dir
}

// 用那版自己的 computeCodeHash 复算：runtime 根下摆上当时已有的 json（备份配置 mtime 早于启动时刻的 + 链接缓存），算完拿走
// 链接缓存是 10-2x 才有的：带 / 不带各算一次（11-04 全部 61 组实测：10-20 起 50 组里 47 组能对上）
const hashAt = (dir, startedAtMs, withLinks) => {
  const runtime = join(dir, 'runtime')
  const placed = []
  for (const b of listConfigBackups().filter((x) => x.mtimeMs < startedAtMs)) placed.push(b.path)
  const links = join(FALIVE_ARCHIVE, 'runtime', 'lark-bug-record-links.json')
  if (withLinks && existsSync(links)) placed.push(links)
  const copied = placed.map((src) => { const dst = join(runtime, src.split('/').pop()); copyFileSync(src, dst); return dst })
  try {
    const out = spawnSync('node', ['-e', "import('./lib/lark-runtime-version.mjs').then((m) => process.stdout.write(m.computeCodeHash(process.cwd()).hash))"], { cwd: dir, encoding: 'utf8' })
    return out.stdout.trim() || null
  } finally {
    for (const f of copied) rmSync(f, { force: true })
  }
}

// 返回 { sha, dir, codeHash, startedAt, verified, tried }
export const pinFaliveCode = ({ atMs, ref = null, maxTries = 6 }) => {
  if (ref) {
    const sha = git(['rev-parse', ref]).stdout.trim()
    if (!sha) throw new Error(`falive 存档里没有 ${ref}`)
    return { sha, dir: ensureWorktree(sha), codeHash: null, startedAt: null, verified: false, tried: [] }
  }
  const running = existsSync(GATEWAY_LOG) ? runningCodeAt(parseCodeStarts(readFileSync(GATEWAY_LOG, 'utf8')), atMs) : null
  const before = new Date(running?.startedAtMs ?? atMs).toISOString()
  const candidates = git(['rev-list', `--max-count=${maxTries}`, `--before=${before}`, FALIVE_BRANCH]).stdout.split('\n').filter(Boolean)
  if (!candidates.length) throw new Error(`falive 在 ${before} 之前没有提交`)
  const tried = []
  if (running) {
    // 候选在一个草稿 worktree 里逐个检出复算，对上了才建正式的 code-<sha>
    const scratch = join(FALIVE_SIM_ROOT, 'pin-scratch')
    if (!existsSync(join(scratch, 'lark-gateway.mjs'))) {
      mkdirSync(FALIVE_SIM_ROOT, { recursive: true })
      git(['worktree', 'add', '--detach', scratch, candidates[0]])
    }
    for (const sha of candidates) {
      git(['checkout', '--quiet', '--detach', sha], scratch)
      const hashes = [hashAt(scratch, running.startedAtMs, true), hashAt(scratch, running.startedAtMs, false)]
      tried.push({ sha: sha.slice(0, 7), hashes })
      const hash = hashes.find((h) => h === running.codeHash)
      if (hash) return { sha, dir: ensureWorktree(sha), codeHash: hash, startedAt: new Date(running.startedAtMs).toISOString(), verified: true, tried }
    }
  }
  const sha = candidates[0]
  return { sha, dir: ensureWorktree(sha), codeHash: running?.codeHash || null, startedAt: running ? new Date(running.startedAtMs).toISOString() : null, verified: false, tried }
}
