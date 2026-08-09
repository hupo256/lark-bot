#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { docsSystemRoot, resolveRoots } from '../engine/agent-scripts/lib/roots.mjs'
import { scanDiffForViolations, formatViolations } from './lib/lark-lint-diff.mjs'
import { buildFocusedRuleContext } from './lib/lark-rule-context.mjs'
import { isReadOnlyCommand, parseCommandType } from './lib/lark-message.mjs'
import {
  buildAnalysisPrompt,
  buildTaskPrompt,
  buildValidationRequirements,
} from './lib/lark-worker-prompts.mjs'
import {
  aiTimeoutMs,
  execAiExecutor,
  formatStructuredAiResult,
  preflightAiExecutor,
  resolveAiExecutor,
} from './lib/lark-ai-executor.mjs'

export { buildAnalysisPrompt, buildTaskPrompt, buildValidationRequirements }

const defaultGatewayUrl = process.env.LARK_GATEWAY_URL || 'http://127.0.0.1:3005'
const defaultPollMs = Number(process.env.LARK_WORKER_POLL_MS || 5000)
// 并行执行上限：不同 worktree 的任务可同时跑，同一 worktree（cwd 相同）仍串行。
// 每个并发任务都会起一个 claude + 全套验证，很吃 CPU/内存，默认 3 是吞吐与机器负载的平衡点。
const defaultConcurrency = Math.max(1, Number(process.env.LARK_WORKER_CONCURRENCY || 3))
const defaultAiExecutor = 'claude'

const { consumerRoot: repoRoot } = resolveRoots()
// worktree 约定：/Users/aven/github/<项目ID>；无 worktree 的任务用临时 worktree（见 prepareTempWorktree）
const worktreesDir = dirname(repoRoot)
// 临时 hotfix worktree 落盘目录（用完即删，不进 worktree 常驻区）
const tempWorktreeDir = join(worktreesDir, '.lark-hotfix')
// 与 gateway 约定的本地 API 共享密钥（可选）：配置后 worker 的写请求必须带头
const gatewaySecret = process.env.LARK_GATEWAY_SECRET || ''

const PROJECT_ID_RE = /^(PR|PM)-\d{3,}$/i
// 归一并校验项目号：仅接受 PR-#### / PM-#### 形态（大写）。project 会拼进 worktree 路径与
// hotfix 分支名，恶意/异常值（如 bug 表「项目ID」列填 ../../x）必须被挡在外面，否则会越出 worktree 根目录。
export const safeProject = (raw) => {
  const value = String(raw || '').trim().toUpperCase()
  return PROJECT_ID_RE.test(value) ? value : ''
}

const safeAuditFilePart = (raw) => String(raw || 'task').replace(/[^\w.-]+/g, '_').slice(0, 120) || 'task'

// 审计留存：lark-audits/ 每任务产 <id>.json + <id>.log 且只增不减（.log 是 AI 全量输出，可达数百 KB）。
// worker 每跑一个任务时顺手扫所有项目的 lark-audits/，按 mtime 删掉超过留存期（默认 7 天）的文件，
// 避免占满磁盘。纯本地审计痕迹、删除不影响运行；清理全程吞异常，绝不阻断任务本身。
const auditRetentionMs = Math.max(0, Number(process.env.LARK_AUDIT_RETENTION_MS || 7 * 24 * 60 * 60 * 1000))
export const pruneStaleAudits = (root = docsSystemRoot, retentionMs = auditRetentionMs) => {
  if (!retentionMs) return
  const cutoff = Date.now() - retentionMs
  let projectDirs = []
  try {
    projectDirs = readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of projectDirs) {
    if (!entry.isDirectory()) continue
    const auditDir = join(root, entry.name, 'agent/lark-audits')
    let files = []
    try {
      files = readdirSync(auditDir)
    } catch {
      continue // 该项目没有审计目录
    }
    for (const name of files) {
      const filePath = join(auditDir, name)
      try {
        if (statSync(filePath).mtimeMs < cutoff) rmSync(filePath, { force: true })
      } catch {
        // 单个文件清理失败（权限/并发删除）不影响其余文件与任务
      }
    }
  }
}

const createTaskAudit = ({ workerConfig, task, workContext, executor }) => {
  pruneStaleAudits()
  const auditProject = safeProject(workContext.projectId) || safeProject(workerConfig.projectId) || '_adhoc'
  const auditDir = join(docsSystemRoot, auditProject, 'agent/lark-audits')
  const basename = safeAuditFilePart(task.id)
  mkdirSync(auditDir, { recursive: true })
  const context = {
    jsonPath: join(auditDir, `${basename}.json`),
    logPath: join(auditDir, `${basename}.log`),
    record: {
      schemaVersion: 1,
      taskId: task.id,
      project: task.project || workContext.projectId,
      executor,
      status: 'started',
      startedAt: new Date().toISOString(),
      task: {
        summary: task.summary,
        text: task.text,
        source: task.source,
        chatId: task.chatId,
        messageId: task.messageId,
      },
      workContext: {
        cwd: workContext.cwd,
        hotfixBranch: workContext.hotfixBranch || null,
      },
      attachments: (task.attachments || []).map((item) => ({
        type: item.type,
        imageKey: item.imageKey,
        localPath: item.localPath,
        width: item.width,
        height: item.height,
        downloadError: item.downloadError,
      })),
      rules: null,
      analysis: null,
      final: null,
      error: null,
    },
  }
  writeFileSync(context.jsonPath, `${JSON.stringify(context.record, null, 2)}\n`, { mode: 0o600 })
  return context
}

const updateTaskAudit = (context, patch) => {
  if (!context) return
  Object.assign(context.record, patch, { updatedAt: new Date().toISOString() })
  writeFileSync(context.jsonPath, `${JSON.stringify(context.record, null, 2)}\n`, { mode: 0o600 })
}

// 同步睡眠（用于 prepareTempWorktree 里同步重试的退避）；不依赖平台 sleep 命令
const syncSleep = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

const loadWorkerLocalConfig = (configPath) => {
  if (!configPath) return {}
  const absolutePath = isAbsolute(configPath) ? configPath : join(repoRoot, configPath)
  try {
    return JSON.parse(readFileSync(absolutePath, 'utf8'))
  } catch (error) {
    throw new Error(`worker config 读取失败（${absolutePath}）：${error.message}`)
  }
}

// 项目文档：docs_tdd 在主仓下（软链到 ~/github/docs_tdd），按项目号取存在的文档
const projectDocsFor = (projectId) =>
  [
    `apps/web/docs_tdd/prds/${projectId}/agent/lark-integration.md`,
    `apps/web/docs_tdd/prds/${projectId}/agent/README.md`,
  ].filter((rel) => existsSync(join(repoRoot, rel)))

// 按 task.project 决定 worker 在哪个仓/目录干活：
//   · 有项目号且 /Users/aven/github/<项目号> 有 worktree → 就在该 worktree 改
//   · 有项目号但本地无 worktree → 一次性临时 worktree（基于 origin/online 建 hotfix 分支，见 prepareTempWorktree）
//   · 无项目号（群 @ 且群名/正文都没编号）→ 同样临时 worktree，分支 hotfix/adhoc-<id>
// hotfixBranch 存在即表示走「临时 worktree」流程，cwd 就是该临时目录。
const tempWorktreeCtx = ({ projectId, projectName, projectDocs, branch }) => {
  const path = join(tempWorktreeDir, branch.replace(/\//g, '-'))
  return { cwd: path, projectId, projectName, projectDocs, hotfixBranch: branch }
}

export const resolveWorkContext = (workerConfig, task) => {
  const project = safeProject(task.project)
  // 只读命令（状态/status）不改代码：命中已有 worktree 就地只读；无 worktree 也不新建临时 worktree
  // （git worktree add + origin/online 拉取很贵），直接在主仓只读回答，跳过提交闸。
  const readOnly = isReadOnlyCommand(task.commandType || parseCommandType(task.text))
  // 取 id 尾部做分支后缀：同一群的 messageId 共享长前缀，取头部会导致所有任务算出同一分支名而撞车
  const short = String(task.recordId || task.id || '').replace(/[^\w]/g, '').slice(-8) || 'x'
  if (project) {
    const worktree = join(worktreesDir, project)
    if (existsSync(worktree)) {
      return { cwd: worktree, projectId: project, projectName: task.projectTitle || project, projectDocs: projectDocsFor(project), readOnly }
    }
    if (readOnly) {
      return { cwd: repoRoot, projectId: project, projectName: task.projectTitle || project, projectDocs: projectDocsFor(project), readOnly: true }
    }
    return tempWorktreeCtx({
      projectId: project,
      projectName: task.projectTitle || project,
      projectDocs: projectDocsFor(project),
      branch: `hotfix/${project}-${short}`,
    })
  }
  if (readOnly) {
    return { cwd: repoRoot, projectId: '(adhoc)', projectName: task.projectTitle || '临时修复', projectDocs: [], readOnly: true }
  }
  // 无项目号 → 临时 worktree（adhoc 分支）
  return tempWorktreeCtx({ projectId: '(adhoc)', projectName: task.projectTitle || '临时修复', projectDocs: [], branch: `hotfix/adhoc-${short}` })
}

const git = (args) => spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' })
const gitAt = (cwd, args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })

// 无 worktree 的任务用「一次性临时 worktree」而非切主仓分支：
//   · 不碰主仓（主仓脏/在别的分支都不受影响），天然无并发/顺序碰撞
//   · 基于 origin/online 建 hotfix 分支，干完自动本地提交到该分支、删掉临时目录（分支保留待 review）
//   · 无常驻 worktree 蔓延（用完即删）
const prepareTempWorktree = ({ path, branch }) => {
  fetchOnlineWithRetry()
  if (existsSync(path)) git(['worktree', 'remove', '--force', path]) // 清理残留
  git(['worktree', 'prune'])
  mkdirSync(dirname(path), { recursive: true })
  const add = git(['worktree', 'add', '-B', branch, path, 'origin/online'])
  if (add.status !== 0) {
    throw new Error(`git worktree add 失败：${(add.stderr || add.stdout || '').trim().slice(0, 160)}`)
  }
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
  const hasLocalRef = git(['rev-parse', '--verify', '--quiet', 'origin/online']).status === 0
  if (hasLocalRef) {
    console.warn(`[lark-worker] ⚠ git fetch origin online 失败，改用本地已有 origin/online（可能陈旧）：${(last.stderr || last.stdout || '').trim().slice(0, 160)}`)
    return
  }
  throw new Error(`git fetch origin online 失败且本地无 origin/online 引用：${(last.stderr || last.stdout || '').trim().slice(0, 160)}`)
}

// 收尾：有改动就本地提交到分支（不 push/不合并，留待人工 review），然后删临时目录；
// 没改动则连空分支一起删，免留垃圾。只有 done 才提交；失败/阻塞若有半成品则保留现场。
const finalizeTempWorktree = ({ path, branch, task, allowCommit }) => {
  if (!existsSync(path)) return
  const dirty = gitAt(path, ['status', '--porcelain'])
  const hasChanges = dirty.status === 0 && dirty.stdout.trim()
  if (hasChanges) {
    if (!allowCommit) {
      console.error(`[lark-worker] ⚠ ${task.id} 未完成，不自动提交半成品；保留临时 worktree ${path} 待人工检查`)
      return
    }
    gitAt(path, ['add', '-A'])
    // --no-verify：临时 worktree 无 node_modules，husky pre-commit(pnpm lint-staged) 必失败；
    // 这些是留待人工 review 的 hotfix 提交，不需要跑钩子。
    const committed = gitAt(path, ['commit', '--no-verify', '-m', `lark hotfix: ${(task.summary || 'fix').slice(0, 60)} [${task.id}]${task.qualityNote ? `\n\n⚠ ${task.qualityNote}` : ''}`])
    if (committed.status !== 0) {
      // 提交失败：绝不 --force 删除（会连未提交改动一起灭失）。保留 worktree 待人工处理。
      console.error(`[lark-worker] ⚠ 提交到 ${branch} 失败，保留临时 worktree ${path} 以免丢改动：${(committed.stderr || committed.stdout || '').trim().slice(0, 200)}`)
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
// --no-verify 跳过 husky（无人值守）。提交失败则不动、留给 finalize 时一并处理。
const commitPreexistingWip = ({ cwd }) => {
  const dirty = gitAt(cwd, ['status', '--porcelain'])
  if (!(dirty.status === 0 && dirty.stdout.trim())) return
  gitAt(cwd, ['add', '-A'])
  const committed = gitAt(cwd, ['commit', '--no-verify', '-m', 'chore(wip): 保存 Lark 任务开始前该 worktree 已存在的未提交改动（非本任务产生，自动隔离提交）'])
  if (committed.status !== 0) {
    console.error(`[lark-worker] ⚠ 预提交任务前 WIP 失败（改动仍留工作区，将与本任务改动一并提交）：${(committed.stderr || committed.stdout || '').trim().slice(0, 200)}`)
    return
  }
  console.log(`[lark-worker] 已把任务前的 WIP 单独提交隔离（${cwd}）`)
}

// 命中已有 worktree（非临时）：任务成功后把改动提交到该 worktree 当前所在分支，
// 让连续任务各自成独立 commit、不在工作区累加混作一团。只在有改动时提交；
// --no-verify 跳过 husky（无人值守场景钩子不适用）。失败保留改动在工作区、不删。
// 任务前的既存 WIP 已由 commitPreexistingWip 提前单独提交隔离，故此处正常只含本任务改动
// （除非预提交失败，那种情况会连带 WIP，属降级兜底）。
const finalizeExistingWorktree = ({ cwd, task }) => {
  const dirty = gitAt(cwd, ['status', '--porcelain'])
  if (!(dirty.status === 0 && dirty.stdout.trim())) {
    console.log(`[lark-worker] ${cwd} 无改动，未提交`)
    return
  }
  gitAt(cwd, ['add', '-A'])
  const committed = gitAt(cwd, ['commit', '--no-verify', '-m', `lark task: ${(task.summary || task.text || 'fix').slice(0, 60)} [${task.id}]${task.qualityNote ? `\n\n⚠ ${task.qualityNote}` : ''}`])
  if (committed.status !== 0) {
    console.error(`[lark-worker] ⚠ 提交到 ${cwd} 当前分支失败（改动仍留工作区）：${(committed.stderr || committed.stdout || '').trim().slice(0, 200)}`)
    return
  }
  const branch = gitAt(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim()
  console.log(`[lark-worker] 改动已提交到 ${cwd} 当前分支 ${branch}（未 push）`)
}

function printHelp() {
  console.log(`usage: lark-worker.mjs [--once] [--help]

Lark Bot Gateway worker: claim pending tasks from the gateway and dispatch them to codex.
Normally invoked by the per-project wrapper; this module also exports runLarkWorker().

Options:
  --help  Show this help message and exit
  --once  Process one task then exit instead of polling forever`)
}

if (process.argv.includes('--help')) {
  printHelp()
  process.exit(0)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const TRANSIENT_GATEWAY_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_SOCKET'])

const isTransientGatewayError = (error) =>
  TRANSIENT_GATEWAY_CODES.has(error?.code) ||
  TRANSIENT_GATEWAY_CODES.has(error?.cause?.code) ||
  (error instanceof TypeError && /fetch failed/i.test(error.message))

// 本地 Gateway 偶发 ECONNRESET 时，仅幂等请求可自动重试；claim/next 绝不重试，避免响应丢失后重复领取。
export const requestJson = async (
  gatewayUrl,
  path,
  options = {},
  { fetchImpl = fetch, sleepImpl = sleep } = {},
) => {
  const { retryTransient = false, ...fetchOptions } = options
  const attempts = retryTransient ? 3 : 1
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(`${gatewayUrl}${path}`, {
        ...fetchOptions,
        headers: {
          'Content-Type': 'application/json',
          ...(gatewaySecret ? { 'x-lark-gateway-secret': gatewaySecret } : {}),
          ...(fetchOptions.headers || {}),
        },
      })

      if (!response.ok) {
        throw new Error(`${fetchOptions.method || 'GET'} ${path} failed: ${response.status} ${await response.text()}`)
      }
      return response.json()
    } catch (error) {
      if (attempt === attempts || !isTransientGatewayError(error)) throw error
      console.warn(`[lark-worker] Gateway 瞬时连接失败，重试 ${attempt}/${attempts - 1}：${path} (${error.cause?.code || error.code || error.message})`)
      await sleepImpl(attempt * 150)
    }
  }
}

const runProjectDocSync = async ({ projectId }) => {
  const { spawn } = await import('node:child_process')
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const syncScript = path.join(repoRoot, 'apps/web/docs_tdd', projectId, 'agent/scripts/sync-lark-docs.mjs')

  try {
    await fs.access(syncScript)
  } catch (error) {
    return { skipped: true, reason: 'missing project sync script' }
  }

  await new Promise((resolve, reject) => {
    const child = spawn('node', [syncScript], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) {
        if (stdout.trim()) {
          console.log(`[lark-worker] doc sync: ${stdout.trim()}`)
        }
        resolve()
        return
      }

      reject(new Error(`Lark doc sync failed before development: ${(stderr || stdout).trim() || `exit ${code}`}`))
    })
  })

  return { skipped: false }
}

const snapshotWorktree = (cwd) => {
  const status = gitAt(cwd, ['status', '--porcelain=v1', '--untracked-files=all'])
  if (status.status !== 0) throw new Error(`读取 git status 失败：${(status.stderr || status.stdout || '').trim()}`)
  const diff = gitAt(cwd, ['diff', '--binary', 'HEAD'])
  if (diff.status !== 0) throw new Error(`读取 git diff 失败：${(diff.stderr || diff.stdout || '').trim()}`)
  return { status: status.stdout, diff: diff.stdout }
}

const blockedResultFromAnalysis = (analysis) => ({
  status: 'blocked',
  summary: analysis.summary,
  blockers: analysis.blockers,
  checks: ['Codex 第一阶段已在只读沙箱完成需求与规则核对；未进入代码实施阶段'],
  changedFiles: [],
})

const runAI = async (workerConfig, task, workContext, auditContext) => {
  const executor = resolveAiExecutor(workerConfig, task)
  const cwd = workContext.cwd || repoRoot
  const ruleContext = buildFocusedRuleContext({
    taskText: task.text,
    hasImage: (task.attachments || []).some((item) => item?.type === 'image'),
    isFix: /^\s*(修复|fix)\s*[:：]/i.test(task.text || ''),
  })
  updateTaskAudit(auditContext, {
    status: executor === 'codex' ? 'analyzing' : 'running',
    rules: {
      scenario: ruleContext.scenario,
      scenarios: ruleContext.scenarios,
      signals: ruleContext.signals,
      fingerprint: ruleContext.fingerprint,
      sources: ruleContext.sources,
      warnings: ruleContext.warnings,
    },
  })

  const commonOptions = {
    executor,
    cwd,
    attachments: task.attachments || [],
    codexModel: workerConfig.localConfig?.codexModel,
    codexReasoningEffort: workerConfig.localConfig?.codexReasoningEffort,
    auditLogPath: auditContext?.logPath,
    // 只读命令（状态/status）：codex 用只读沙箱，绝不落任何写。
    readOnly: Boolean(workContext.readOnly),
  }

  if (executor !== 'codex') {
    return execAiExecutor({
      ...commonOptions,
      promptText: buildTaskPrompt(workContext, task, executor, { ruleContext }),
    })
  }

  const beforeAnalysis = snapshotWorktree(cwd)
  const analysisRun = await execAiExecutor({
    ...commonOptions,
    promptText: buildAnalysisPrompt(workContext, task, ruleContext),
    resultKind: 'analysis',
  })
  const afterAnalysis = snapshotWorktree(cwd)
  if (beforeAnalysis.status !== afterAnalysis.status || beforeAnalysis.diff !== afterAnalysis.diff) {
    throw new Error('Codex 第一阶段违反只读约束：git status/diff 在分析前后发生变化，已停止实施')
  }
  updateTaskAudit(auditContext, { analysis: analysisRun.result })

  if (analysisRun.result.status === 'blocked') {
    const result = blockedResultFromAnalysis(analysisRun.result)
    updateTaskAudit(auditContext, { status: 'blocked', final: result })
    return { executor, result, analysis: analysisRun.result, ruleContext }
  }

  updateTaskAudit(auditContext, { status: 'implementing' })
  const implementationRun = await execAiExecutor({
    ...commonOptions,
    promptText: buildTaskPrompt(workContext, task, executor, { ruleContext, analysis: analysisRun.result }),
  })
  updateTaskAudit(auditContext, { status: implementationRun.result.status, final: implementationRun.result })
  return { ...implementationRun, analysis: analysisRun.result, ruleContext }
}

// 变更分级探测（L1/L2）：命中契约 / 共享 / 类型敏感路径即 L2+（需 type-check 兜底）。纯函数便于单测。
// L2+ 触发：schema 契约、mapper 映射、/api/ 层、.d.ts 声明、跨包 packages/ 改动。
const L2_PATH_RULES = [
  { re: /\.schema\./i, reason: 'schema 契约文件' },
  { re: /mapper/i, reason: 'mapper 映射层' },
  { re: /\/api\//i, reason: 'api 层' },
  { re: /\.d\.ts$/i, reason: '类型声明 .d.ts' },
  { re: /(?:^|\/)packages\//i, reason: '跨包 packages/ 共享改动' },
]
export const detectChangeTier = (files = []) => {
  const reasons = []
  for (const file of files) {
    for (const rule of L2_PATH_RULES) {
      if (rule.re.test(String(file || '')) && !reasons.includes(rule.reason)) reasons.push(rule.reason)
    }
  }
  return { tier: reasons.length ? 'L2' : 'L1', reasons }
}

// AI 自报 changedFiles 与真实 `git diff --name-only HEAD` 交叉校验：归一路径后比较，actual 为准
// （AI 可能漏报真改的文件，也可能虚报没改的文件）。纯函数便于单测。
export const crossCheckChangedFiles = ({ reported = [], actual = [] } = {}) => {
  const norm = (list) => new Set((list || []).map((f) => String(f || '').trim().replace(/^\.\//, '')).filter(Boolean))
  const reportedSet = norm(reported)
  const actualSet = norm(actual)
  const missingFromReport = [...actualSet].filter((f) => !reportedSet.has(f)) // 真改了但 AI 没报
  const notActuallyChanged = [...reportedSet].filter((f) => !actualSet.has(f)) // AI 报了但没真改
  return {
    actualEmpty: actualSet.size === 0,
    reportedEmpty: reportedSet.size === 0,
    missingFromReport,
    notActuallyChanged,
    consistent: missingFromReport.length === 0 && notActuallyChanged.length === 0,
  }
}

// 已声明 done 的结果可信度评估：只读任务（状态/status）豁免；否则用真实改动交叉校验 + 分级探测，
// 产出人工可见 notes。done 但工作区零改动 → 判不可信（无改动=无修复=不可信，降级需复核）；
// L2+ 改动但 AI 自报 checks 不含 type-check → 挂 note 提示人工确认契约/类型无回归。纯函数便于单测。
const TYPECHECK_RE = /tsc|type[\s-]?check|typecheck/i
export const assessDoneResult = ({ reportedChangedFiles = [], actualChangedFiles = [], checks = [], readOnly = false } = {}) => {
  if (readOnly) return { trustworthy: true, notes: [], tier: 'L1' }
  const cross = crossCheckChangedFiles({ reported: reportedChangedFiles, actual: actualChangedFiles })
  const { tier, reasons } = detectChangeTier(actualChangedFiles)
  const notes = []
  if (cross.actualEmpty) {
    return { trustworthy: false, tier, notes: ['AI 报告 done 但工作区无任何改动（git diff HEAD 为空），无法确认已真正修复，需人工复核'] }
  }
  if (cross.missingFromReport.length) notes.push(`AI 漏报改动文件：${cross.missingFromReport.join('、')}`)
  if (cross.notActuallyChanged.length) notes.push(`AI 自报改了但实际未改：${cross.notActuallyChanged.join('、')}`)
  if (tier === 'L2' && !checks.some((c) => TYPECHECK_RE.test(String(c || '')))) {
    notes.push(`L2+ 改动（${reasons.join('、')}）但未见 type-check，建议人工确认类型/契约无回归`)
  }
  return { trustworthy: true, tier, notes }
}

// 无人值守规范闸：扫本次 diff 新增行的 arbitrary value / 失效裸色类；有违规先让 AI 定向纠正一次。
// 纠正后仍残留时分两桶：失效裸色类（invalid-color-class，一定是 bug 且必可修）为「硬」违规——不判 done、
// 降级人工；其余（arbitrary value 等，可能无对应 token）为「软」违规——附清单到完成消息供人工 review，不静默放过。
// 只对代码类改动生效。
const HARD_GATE_KINDS = new Set(['invalid-color-class'])
export const splitViolations = (violations) => ({
  hardRemaining: violations.filter((v) => HARD_GATE_KINDS.has(v.kind)),
  softRemaining: violations.filter((v) => !HARD_GATE_KINDS.has(v.kind)),
})
const enforceCodeQuality = async (workerConfig, task, workContext, auditContext) => {
  const cwd = workContext.cwd || repoRoot
  const diffOf = () => {
    gitAt(cwd, ['add', '-A', '-N']) // 让新增文件也进 diff（intent-to-add，非破坏性）
    // 用 `git diff HEAD`（工作区 vs HEAD）而非裸 `git diff`（仅未暂存）：AI 若自行 git add/commit，
    // 裸 diff 会扫到 0 违规静默放行。口径与 snapshotWorktree 的 `git diff HEAD` 统一。
    return gitAt(cwd, ['diff', 'HEAD']).stdout || ''
  }
  let violations = scanDiffForViolations(diffOf())
  if (!violations.length) return { ok: true, remaining: [], hardRemaining: [], softRemaining: [] }

  console.warn(`[lark-worker] 规范闸命中 ${violations.length} 处违规，触发定向纠正 pass（${task.id}）`)
  try {
    const executor = resolveAiExecutor(workerConfig, task)
    await execAiExecutor({
      executor,
      promptText: buildLintFixPrompt(cwd, violations),
      cwd,
      codexModel: workerConfig.localConfig?.codexModel,
      codexReasoningEffort: workerConfig.localConfig?.codexReasoningEffort,
      auditLogPath: auditContext?.logPath,
    })
  } catch (error) {
    console.warn(`[lark-worker] 规范纠正 pass 执行异常（保留原改动）：${error.message}`)
  }

  violations = scanDiffForViolations(diffOf())
  return { ok: violations.length === 0, remaining: violations, ...splitViolations(violations) }
}

// 规范硬闸命中（残留失效裸色类）→ done 降级为失败待人工的结果文案。色类会被 Tailwind 静默丢弃、
// 根本不生效，属可修的确定性 bug，不能带病判完成。
const buildQualityBlockedResult = (task, hardRemaining) => {
  const summary = (task.summary || task.text || 'fix').split('\n').find((line) => line.trim())?.trim() || '群内反馈的问题'
  return `处理失败。\n1. 任务：${summary.slice(0, 80)}；\n2. 改动引入 ${hardRemaining.length} 处失效裸色类（Tailwind 会静默丢弃、根本不生效），定向纠正后仍残留，不能按已完成处理；\n3. 需人工把这些类换成项目语义 token（text-sem-g / text-sem-r / text-1..8 等）后再重跑：\n${formatViolations(hardRemaining)}`
}

const buildLintFixPrompt = (cwd, violations) =>
  `你刚在 ${cwd} 完成一处修复，但触碰了编码规范红线，请**只修正下列 class**（不要改动其它逻辑/文案/结构，改完不必回写 Gateway）：

${formatViolations(violations)}

规则：Tailwind 一律用 packages/config/tailwind-preset.js 里定义的 token，不用 arbitrary value \`[..]\`；颜色必须是 preset 里真实存在的类（未知类如 text-green 会被 Tailwind 静默丢弃、根本不生效）。改完用 \`git diff\` 自查这些点已全部换成 token。`

// AI 进程退出但没有显式回写 done/failed 时的结果文案：一律判失败待人工复核。
// 不分任务类型都不能兜底谎报「已完成」——无回写 = 无验证 = 不可信（AI 可能中途放弃/崩溃/未按要求回调）。
const buildNeedsReviewResult = (task) => {
  const summary = (task.text || '').split('\n').find((line) => line.trim())?.trim() || '群内反馈的问题'

  return `处理失败。\n1. 任务：${summary.slice(0, 80)}；\n2. AI 已执行结束但未显式回写完成结果，无法确认改动是否成功或已验证；\n3. 需人工查看 Worker/AI 日志与分支改动后再定，禁止按已完成处理。`
}

// Worker 层技术性失败归因（preflight / timeout / worktree / exit code）：把恒定的「Worker 执行异常」
// 换成定型的失败类型 + 下一步。纯函数便于单测。返回 { failureKind, kindLabel, nextStep }。
const FAILURE_KIND_LABELS = {
  tool: '工具失败',
  env: '环境失败',
  permission: '权限失败',
  requirement: '需求不清',
}
export const classifyWorkerFailure = (error) => {
  const message = (error instanceof Error ? error.message : String(error || '')).toLowerCase()
  if (/timeout|超时|sigterm|sigkill/.test(message)) {
    return { failureKind: 'tool', kindLabel: FAILURE_KIND_LABELS.tool, nextStep: '查看 AI 日志确认是否卡死；可调大 LARK_WORKER_AI_TIMEOUT_MS 或拆小任务后重试' }
  }
  if (/登录|login|unauthor|forbidden|permission|token/.test(message)) {
    return { failureKind: 'permission', kindLabel: FAILURE_KIND_LABELS.permission, nextStep: '在本机完成对应 AI CLI 登录（如 `codex login`）后重试' }
  }
  if (/enoent|not found|command not found|缺.*二进制|no such file|worktree|git/.test(message)) {
    return { failureKind: 'env', kindLabel: FAILURE_KIND_LABELS.env, nextStep: '检查本机 AI CLI / 依赖 / worktree / git 状态后重试' }
  }
  return { failureKind: 'tool', kindLabel: FAILURE_KIND_LABELS.tool, nextStep: '查看本地任务记录与 Worker/AI 日志定位后重试' }
}

const buildFailureResult = (task, error) => {
  const summary = (task.text || '').split('\n').find((line) => line.trim())?.trim() || '群内任务'
  const message = error instanceof Error ? error.message : String(error)
  const { kindLabel, nextStep } = classifyWorkerFailure(error)
  return `处理失败。\n1. 任务：${summary.slice(0, 80)}；\n2. 失败类型：${kindLabel}；\n3. 下一步：${nextStep}。${message ? `\n4. 错误：${message.slice(0, 160)}` : ''}`
}

const commandTypeOf = (task) => task.commandType || parseCommandType(task.text)

// 命令类型任务（状态/文档/修复/自测/api/qa）触发项目文档同步；其中「状态」为只读。
const isCommandTask = (task) => commandTypeOf(task) != null

// 只读任务（状态/status）不改代码，done 时工作区本就无改动，故豁免「done+零改动」的可信度降级。
const isReadOnlyTask = (task) => isReadOnlyCommand(commandTypeOf(task))

export async function runLarkWorker({
  argv = process.argv.slice(2),
  gatewayUrl = defaultGatewayUrl,
  pollMs = defaultPollMs,
  projectId,
  projectName,
  projectDocs = [],
  aiExecutor = defaultAiExecutor,
  configPath,
  repoCwd,
}) {
  if (!projectId || !projectName) {
    throw new Error('runLarkWorker requires projectId and projectName')
  }

  // 焊死「孤儿回收不与活着的 AI 双跑」这条唯一防线：AI 执行超时必须 < gateway 租约。
  // 否则 AI 还在跑，gateway 已判租约过期把任务重投/领走，两个 AI 同 worktree 改文件打架。
  // 默认 30min < 40min 成立；env 覆盖（LARK_WORKER_AI_TIMEOUT_MS / LARK_TASK_LEASE_MS）可能破坏，故启动即断言。
  const leaseMs = Number(process.env.LARK_TASK_LEASE_MS || 40 * 60 * 1000)
  if (Number.isFinite(aiTimeoutMs) && aiTimeoutMs > 0 && aiTimeoutMs >= leaseMs) {
    throw new Error(
      `[lark-worker] 配置冲突：AI 超时(${aiTimeoutMs}ms) 必须小于任务租约 LARK_TASK_LEASE_MS(${leaseMs}ms)，` +
        '否则孤儿回收会与活着的 AI 双跑同一 worktree。请调低 LARK_WORKER_AI_TIMEOUT_MS 或调高 LARK_TASK_LEASE_MS。',
    )
  }

  const localConfig = loadWorkerLocalConfig(configPath)
  const workerConfig = { projectId, projectName, projectDocs, aiExecutor, localConfig, repoCwd }
  const startupExecutor = resolveAiExecutor(workerConfig, {})
  const codexProfile = startupExecutor === 'codex'
    ? ` model=${localConfig.codexModel || '(Codex default)'} reasoning=${localConfig.codexReasoningEffort || '(Codex default)'}`
    : ''
  console.log(`[lark-worker] AI executor=${startupExecutor}${codexProfile}（task > env > config > wrapper）`)
  const request = (path, options) => requestJson(gatewayUrl, path, options)
  const reliableRequest = (path, options = {}) => requestJson(gatewayUrl, path, { ...options, retryTransient: true })
  const updateTask = (taskId, status, result, executor, epoch, owner, branch) =>
    reliableRequest(`/lark/tasks/${encodeURIComponent(taskId)}/status`, {
      method: 'POST',
      body: JSON.stringify({ status, result, aiExecutor: executor, epoch, owner, branch }),
    })

  const getTask = async (taskId) => {
    const { tasks = [] } = await reliableRequest('/lark/tasks')
    return tasks.find((item) => item.id === taskId)
  }

  const getNextPendingTask = async () => {
    const { task } = await request('/lark/tasks/next', { method: 'POST' })
    return task
  }

  // 执行一个**已领取**的任务（领取由调度器/--once 完成）。workContext 由调用方算好传入，
  // 与调度器挑选时用的 cwd 一致（同一 worktree 串行的判定依据）。异常在内部吞掉并回写 failed，
  // 不向外抛（调度器里各任务并行 detached，抛出会变未捕获 rejection）。
  const runTask = async (task, workContext) => {
    // 回写统一带上领取时的 epoch（fencing token）：若本次领取已被租约回收/人工 retry 作废，
    // 迟到回写会被 Gateway 以 409 拒掉，不覆盖新一代执行的状态。
    const reportStatus = (status, result, executor, owner, branch) => updateTask(task.id, status, result, executor, task.epoch, owner, branch)
    if (!task.text?.trim()) {
      await reportStatus('failed', '处理失败。\n1. 这条 Lark 任务内容为空；\n2. 请重新 @ 应用并写清需要处理的事项。')
      return
    }

    let selectedExecutor
    let auditContext
    try {
      selectedExecutor = resolveAiExecutor(workerConfig, task)
      auditContext = createTaskAudit({ workerConfig, task, workContext, executor: selectedExecutor })
      preflightAiExecutor(selectedExecutor)
    } catch (error) {
      updateTaskAudit(auditContext, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        completedAt: new Date().toISOString(),
      })
      await reportStatus('failed', buildFailureResult(task, error))
      return
    }

    console.log(`[lark-worker] claimed ${task.id} via ${selectedExecutor}: ${task.text}`)
    console.log(`[lark-worker] routing ${task.id} → ${workContext.cwd}${workContext.hotfixBranch ? ` (临时 worktree ${workContext.hotfixBranch})` : ''}`)
    // 命中已有 worktree 且进来时已有未提交 WIP → 先把 WIP 单独提交一笔隔离，
    // 与随后本任务的改动分成两个 commit，避免你的 WIP 和 bot 改动混作一团。
    if (!workContext.hotfixBranch && !workContext.readOnly) commitPreexistingWip({ cwd: workContext.cwd })
    try {
      if (workContext.hotfixBranch) {
        try {
          prepareTempWorktree({ path: workContext.cwd, branch: workContext.hotfixBranch })
        } catch (prepError) {
          await reportStatus('failed', `处理失败。\n1. 项目 ${workContext.projectId} 本地无 worktree，需临时 worktree；\n2. ${prepError.message}`)
          return
        }
      }

      if (isCommandTask(task)) {
        await runProjectDocSync({ projectId: workContext.projectId })
      }

      task.aiExecutor = selectedExecutor
      // 先持久化实际执行器 + 目标分支：都在 AI 跑之前定好，故 done 卡构建时 task.branch 已就位。
      // 只读任务不提交、无分支；hotfix 走临时分支；命中已有 worktree 用其当前分支。
      const targetBranch = workContext.readOnly
        ? null
        : workContext.hotfixBranch || (gitAt(workContext.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout || '').trim() || null
      await reportStatus('running', undefined, selectedExecutor, undefined, targetBranch)
      const aiRun = await runAI(workerConfig, task, workContext, auditContext)

      let latestTask = await getTask(task.id)
      let qualityGate = null
      // claude / codex 都不自调 Gateway；两者都把结构化结果落盘，由 Worker 用正确 epoch 统一回写。
      if (aiRun.result && latestTask?.status === 'running') {
        const warnNotes = []
        if (aiRun.result.status === 'done') {
          qualityGate = await enforceCodeQuality(workerConfig, task, workContext, auditContext)
          if (qualityGate.hardRemaining.length) {
            // 失效裸色类硬闸：定向纠正后仍残留 → 不判 done，降级失败待人工（色类会被 Tailwind 静默丢弃，带病完成）。
            const failText = buildQualityBlockedResult(task, qualityGate.hardRemaining)
            console.error(`[lark-worker] ⛔ ${task.id} 规范硬闸拦截（失效色类）：\n${formatViolations(qualityGate.hardRemaining)}`)
            await reportStatus('failed', failText, aiRun.executor)
            updateTaskAudit(auditContext, { status: 'failed', gateway: { status: 'failed', result: failText } })
            return
          }
          // changedFiles 交叉校验 + 分级探测：enforceCodeQuality 已 `git add -A -N`，此处 name-only diff 含新增文件。
          const actualChangedFiles = (gitAt(workContext.cwd, ['diff', '--name-only', 'HEAD']).stdout || '')
            .split('\n').map((line) => line.trim()).filter(Boolean)
          const assessment = assessDoneResult({
            reportedChangedFiles: aiRun.result.changedFiles,
            actualChangedFiles,
            checks: aiRun.result.checks,
            readOnly: isReadOnlyTask(task),
          })
          if (!assessment.trustworthy) {
            // done 但工作区零改动等强信号 → 不按已完成处理（无改动=无修复=不可信），降级需人工复核。
            const failText = `${buildNeedsReviewResult(task)}\n附：${assessment.notes.join('；')}`
            await reportStatus('failed', failText, aiRun.executor)
            updateTaskAudit(auditContext, { status: 'failed', gateway: { status: 'failed', result: failText } })
            return
          }
          // L2+ 改动的 type-check 提示由 assessDoneResult 产出（note 级，不硬卡）：整包 tsc 基线本身就红，
          // 按 exit code 硬判会因历史欠债误伤所有 L2 改动，故只提示「需人工确认类型/契约无回归」，不阻断 done。
          warnNotes.push(...assessment.notes)
        }
        let resultText = formatStructuredAiResult(aiRun.result, aiRun.executor)
        if (qualityGate?.softRemaining.length) {
          // 软违规（arbitrary value 等，可能无对应 token）不硬拦，附清单到完成消息供人工 review。
          task.qualityNote = `含 ${qualityGate.softRemaining.length} 处未修正规范问题（arbitrary value 等），需人工确认`
          warnNotes.push(task.qualityNote)
        }
        if (warnNotes.length) resultText += `\n⚠ ${warnNotes.join('；')}`
        // owner（AI 推断的责任人角色/关键词）随回写带给 Gateway，用于 waiting/blocked 卡片 @ 责任人。
        await reportStatus(aiRun.result.status, resultText, aiRun.executor, aiRun.result.owner)
        latestTask = await getTask(task.id)
        updateTaskAudit(auditContext, {
          status: latestTask?.status || aiRun.result.status,
          gateway: { status: latestTask?.status || aiRun.result.status, result: latestTask?.result || resultText },
        })
      }

      if (latestTask?.status === 'running') {
        // AI 退出但没显式回写 done/failed → 一律判失败待人工复核（不分任务类型，绝不兜底成功）
        await reportStatus('failed', buildNeedsReviewResult(task))
        updateTaskAudit(auditContext, {
          status: 'failed',
          gateway: { status: 'failed', result: buildNeedsReviewResult(task) },
        })
        return
      }

      // 规范闸兜底：正常结构化 done 已在上面回写时跑过规范闸（qualityGate 已置），此处仅覆盖极端遗漏路径。
      // 结果卡已由上面的 reportStatus 发出，故此处不重发卡片，只保证「进分支的代码」变干净。
      if (latestTask?.status === 'done' && !qualityGate) {
        const gate = await enforceCodeQuality(workerConfig, task, workContext, auditContext)
        if (!gate.ok) {
          task.qualityNote = `含 ${gate.remaining.length} 处未修正规范问题（arbitrary value / 失效色类），需人工处理`
          console.error(`[lark-worker] ⚠ ${task.id} 规范闸残留：\n${formatViolations(gate.remaining)}`)
        }
      }

      // 命中已有 worktree（非临时）且任务成功 → 提交到该 worktree 当前分支。
      // 只读任务在主仓就地回答，绝不提交；失败/阻塞不提交（不往你的活跃分支写半成品）；
      // 临时 worktree 走 finally 里的 finalizeTempWorktree。
      if (!workContext.hotfixBranch && !workContext.readOnly) {
        const finalTask = await getTask(task.id)
        if (finalTask?.status === 'done') finalizeExistingWorktree({ cwd: workContext.cwd, task })
      }
    } catch (error) {
      const latestTask = await getTask(task.id)
      if (latestTask?.status === 'running') {
        await reportStatus('failed', buildFailureResult(task, error))
      }
      updateTaskAudit(auditContext, {
        status: latestTask?.status === 'running' ? 'failed' : latestTask?.status || 'failed',
        error: error instanceof Error ? error.message : String(error),
      })
      console.error(`[lark-worker] task ${task.id} 执行异常：`, error)
    } finally {
      let finalTask
      try {
        finalTask = await getTask(task.id)
      } catch (error) {
        console.error(`[lark-worker] ⚠ ${task.id} 收尾时无法读取最终状态，按未完成保留可能的半成品：${error.message}`)
        updateTaskAudit(auditContext, { error: `读取最终状态失败：${error.message}` })
      }
      updateTaskAudit(auditContext, {
        status: finalTask?.status || auditContext?.record.status || 'unknown',
        gateway: finalTask ? { status: finalTask.status, result: finalTask.result } : auditContext?.record.gateway,
        completedAt: new Date().toISOString(),
      })
      // 临时 worktree 收尾：只有最终状态 done 才提交；失败/阻塞有改动时保留现场，无改动可清理。
      if (workContext.hotfixBranch) {
        finalizeTempWorktree({
          path: workContext.cwd,
          branch: workContext.hotfixBranch,
          task,
          allowCommit: finalTask?.status === 'done',
        })
      }
    }
  }

  // 可领取任务（queued/received）按创建时间升序，供调度器挑选
  const listClaimable = async () => {
    const { tasks = [] } = await reliableRequest('/lark/tasks')
    return tasks
      .filter((item) => item.status === 'queued' || item.status === 'received')
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
  }

  const once = argv.includes('--once')

  if (once) {
    const task = await getNextPendingTask()
    if (task) await runTask(task, resolveWorkContext(workerConfig, task))
    return
  }

  // 并行调度器：inFlight 以 workContext.cwd 为 key（同一 worktree 只允许一个在飞、天然串行；
  // 不同 worktree 并行）。git worktree add/remove 等走 spawnSync 同步执行，本就互不交错，无需额外锁。
  const inFlight = new Map()
  for (;;) {
    while (inFlight.size < defaultConcurrency) {
      const candidates = await listClaimable()
      // 挑第一个「目标 cwd 未在飞」的任务；其余留到下一轮（保证同 worktree 串行）
      let picked = null
      let pickedCtx = null
      for (const candidate of candidates) {
        const ctx = resolveWorkContext(workerConfig, candidate)
        if (inFlight.has(ctx.cwd)) continue
        picked = candidate
        pickedCtx = ctx
        break
      }
      if (!picked) break

      let claimed = null
      try {
        const res = await request(`/lark/tasks/${encodeURIComponent(picked.id)}/claim`, { method: 'POST' })
        claimed = res.task
      } catch (error) {
        console.error('[lark-worker] claim 失败：', error)
        break
      }
      if (!claimed) continue // 被并发领走 / 状态已变，下一轮重新 list

      const key = pickedCtx.cwd
      const running = runTask(claimed, pickedCtx).finally(() => inFlight.delete(key))
      inFlight.set(key, running)
    }

    await sleep(pollMs)
  }
}
