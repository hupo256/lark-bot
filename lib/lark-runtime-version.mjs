/**
 * 运行时版本指纹：回答「当前跑着的这个进程，是否还等于磁盘上的代码」。
 *
 * 为什么必须有：gateway / worker 由 launchd 常驻，可连跑数周。改完 lib/*.mjs 后如果忘记
 * `lark-bot restart`，进程仍跑着旧代码，而 /lark/health 的字段集、卡片文案、闸门策略全按旧版行为，
 * **从外部完全不可发现**（曾实测：进程 08:36 启动，routes.mjs 15:01 才改，health 里没有任何线索）。
 * 无人值守系统里这是元级故障——它会让后续所有修复看起来"改了没生效"。
 *
 * 判定方式：进程启动时哈希一次源码（= 它真正 import 进内存的那一版），health 请求时再哈希一次磁盘，
 * 两者不等即 `codeStale`。进程无法哈希自己的内存，但"启动那一刻的磁盘"就是它加载的版本，等价可靠。
 *
 * 纯计算 + 只读 IO，可 `node --test` 直测。
 */

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const larkBotRoot = dirname(dirname(fileURLToPath(import.meta.url)))

// 只哈希「决定进程行为的源文件」。排除项各有理由：
//   · __tests__ / docs：改它们不改变运行行为，纳入会造成"改文档也提示重启"的噪音告警；
//   · lark-tasks / *-state.json：运行态数据，每条任务都在变，纳入等于永远 stale；
//   · lark-bot.local.json：配置，单独算 configHash（改配置与改代码的处置动作不同）。
const SKIP_DIRS = new Set(['__tests__', 'docs', 'lark-tasks', 'node_modules'])
const SKIP_FILES = new Set(['lark-bot.local.json'])
const SOURCE_EXT_RE = /\.(?:mjs|json)$/
const STATE_FILE_RE = /-state\.json$/

const walk = (dir, root, out) => {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, root, out)
      continue
    }
    if (!entry.isFile()) continue
    if (SKIP_FILES.has(entry.name) || STATE_FILE_RE.test(entry.name)) continue
    if (!SOURCE_EXT_RE.test(entry.name)) continue
    out.push(relative(root, full))
  }
  return out
}

// 源文件清单（相对 larkBotRoot，已排序）。排序是必须的：readdir 顺序不保证跨平台稳定，
// 顺序漂移会让同一份代码算出不同 hash → 假 stale。
export const listSourceFiles = (root = larkBotRoot) => walk(root, root, []).sort()

// 内容哈希：路径 + 内容一起进 digest，故新增/删除/改名文件也会改变 hash（只哈希内容会漏掉纯改名）。
export const computeCodeHash = (root = larkBotRoot) => {
  const files = listSourceFiles(root)
  const digest = createHash('sha256')
  for (const file of files) {
    digest.update(file)
    digest.update('\0')
    try {
      digest.update(readFileSync(join(root, file)))
    } catch {
      digest.update('<unreadable>')
    }
    digest.update('\0')
  }
  return { hash: digest.digest('hex').slice(0, 12), fileCount: files.length }
}

export const hashFileContent = (path) => {
  try {
    return createHash('sha256').update(readFileSync(resolve(path))).digest('hex').slice(0, 12)
  } catch {
    return null
  }
}

// 磁盘上最新一次源码改动时间：stale 时用来告诉人"磁盘比你这个进程新多久"，比只报 hash 不等更可操作。
export const latestSourceMtime = (root = larkBotRoot) => {
  let newest = 0
  for (const file of listSourceFiles(root)) {
    try {
      const { mtimeMs } = statSync(join(root, file))
      if (mtimeMs > newest) newest = mtimeMs
    } catch { /* 文件在遍历与 stat 之间被删，忽略 */ }
  }
  return newest || null
}

/**
 * 建一个进程级版本观测器。启动时快照，之后 observe() 带 TTL 缓存地重算磁盘态。
 * TTL 存在的理由：health 可被外部探活高频调用，每次全量哈希 ~40 个文件没必要。
 */
export const createRuntimeVersion = ({ configPath, root = larkBotRoot, ttlMs = 10_000, now = () => Date.now() } = {}) => {
  const startedAtMs = now()
  const startup = computeCodeHash(root)
  const startupConfigHash = configPath ? hashFileContent(configPath) : null
  let cache = null

  const observe = () => {
    const at = now()
    if (cache && at - cache.at < ttlMs) return cache.value
    const disk = computeCodeHash(root)
    const diskConfigHash = configPath ? hashFileContent(configPath) : null
    const codeStale = disk.hash !== startup.hash
    const configStale = startupConfigHash != null && diskConfigHash !== startupConfigHash
    const value = {
      startedAt: new Date(startedAtMs).toISOString(),
      uptimeMs: at - startedAtMs,
      codeHash: startup.hash,
      codeFileCount: startup.fileCount,
      diskCodeHash: disk.hash,
      codeStale,
      configHash: startupConfigHash,
      diskConfigHash,
      configStale,
      diskChangedAt: codeStale ? new Date(latestSourceMtime(root) || at).toISOString() : null,
    }
    cache = { at, value }
    return value
  }

  return { observe, codeHash: startup.hash, startedAt: new Date(startedAtMs).toISOString() }
}

// 版本告警文案（health warnings 与 CLI 共用一句口径，避免两处措辞不一致）。
export const versionWarnings = (version) => {
  const warnings = []
  if (version?.codeStale) {
    warnings.push(
      `运行中的代码已落后磁盘（进程加载版 ${version.codeHash}，磁盘 ${version.diskCodeHash}`
      + `${version.diskChangedAt ? `，磁盘最后改动 ${version.diskChangedAt}` : ''}）`
      + '：本次会话对 lark-bot 的所有修改都尚未生效，需 `lark-bot restart`',
    )
  }
  if (version?.configStale) {
    warnings.push(`运行中的配置已落后磁盘（进程加载版 ${version.configHash}，磁盘 ${version.diskConfigHash}）：需 \`lark-bot restart\``)
  }
  return warnings
}

/**
 * Worker 心跳：worker 不开 HTTP 端口，它的版本无从被外部观测——而它才是真正执行代码的那个进程。
 * 故 worker 定期把自己的 { pid, startedAt, codeHash } 落盘，由 gateway 的 /lark/health 汇总上报，
 * 让「gateway 已重启但 worker 还是旧的」这种半重启状态也能被发现（launchd 两个 label 是独立的）。
 *
 * 文件名刻意以 `-state.json` 结尾：它每分钟都在变，必须被 computeCodeHash 的 STATE_FILE_RE 排除，
 * 否则 worker 自己的心跳会让 codeHash 永远漂移。
 */
export const workerHeartbeatPath = (runtimeDir) => join(runtimeDir, 'lark-worker-state.json')

export const writeWorkerHeartbeat = ({ runtimeDir, version, extra = {}, now = () => Date.now() }) => {
  const path = workerHeartbeatPath(runtimeDir)
  const payload = {
    pid: process.pid,
    startedAt: version.startedAt,
    codeHash: version.codeHash,
    heartbeatAt: new Date(now()).toISOString(),
    ...extra,
  }
  try {
    // 原子写：health 可能正好在读；半截 JSON 会让 health 误报 worker 缺失。
    writeFileSync(`${path}.tmp`, `${JSON.stringify(payload, null, 2)}\n`)
    renameSync(`${path}.tmp`, path)
  } catch (error) {
    console.error(`[lark-worker] 写版本心跳失败（不影响任务执行）：${String(error).slice(0, 120)}`)
  }
  return payload
}

// 读取 worker 心跳并判定活性/版本一致性。心跳过期阈值取 3 倍写入间隔，容忍一次漏写。
export const readWorkerHeartbeat = ({ runtimeDir, expectedCodeHash, staleMs = 3 * 60_000, now = () => Date.now() }) => {
  let raw
  try {
    raw = JSON.parse(readFileSync(workerHeartbeatPath(runtimeDir), 'utf8'))
  } catch {
    return null
  }
  const heartbeatAgeMs = now() - Date.parse(raw.heartbeatAt || 0)
  return {
    ...raw,
    heartbeatAgeMs,
    heartbeatStale: !Number.isFinite(heartbeatAgeMs) || heartbeatAgeMs > staleMs,
    codeStale: expectedCodeHash != null && raw.codeHash !== expectedCodeHash,
  }
}

