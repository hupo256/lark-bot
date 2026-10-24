import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import { DEFAULT_TASK_BUDGET_MS, claudeProjectKey, createTaskRunner, isShutdownAbort, remainingTaskBudgetMs, startLeaseHeartbeat } from '../lib/lark-task-runner.mjs'
import { registerRepoProfiles } from '../lib/lark-repo-profile.mjs'
import { resolveWorkContext } from '../lib/lark-work-context.mjs'
import { countRecentFingerprint } from '../lib/lark-failure-ledger.mjs'
import { runSteps } from './support/steps.mjs'

// createTaskRunner 端到端（变异补测 10-24）：运行态目录在模块加载时定，只能整个进程指到临时目录，所以在子进程里跑真 createTaskRunner。
// 本文件同时是子进程入口：带 LARK_RUNNER_E2E_BATCH 启动时只跑给定的一批用例、把结果写回文件后退出，不注册测试。
// 用例按名字定义在 E2E 表里（声明式：任务 / 仓库文件 / 分析与实施结果 / 网关脚本）；全部用例分几路子进程并行跑一次、结果按名字取，
// 各段只读自己那几条用例的结果（每条用例自带临时业务仓与假网关，互不共享状态，跟段的先后无关）。
// PATH 前插假 claude：--version 通过；只读分析 / 意图分类 / 分诊按 spec 吐结构化结果；实施阶段按 spec 写文件、写结果文件。
const DOC = 'docs/delivery/pending/对接-用户接口.md'
const KEPT_DOC = 'docs/delivery/pending/对接-旧版.md'
const RULES_MD = '# rules\n\n## 固定前提（勿偏离）\n\n- 只做前端\n\n## 硬规则速览（细则见各向导）\n\n- 数据只用 zod\n'
const FEATURE_TABLE = '| 1 | 直播 | 直播间 | - | aven | php | ✅ |\n| 2 | 广场 | 帖子 | - | Lily | php | ✅ |\n| 3 | 任务 | 任务中心 | - | Bob | go | ✅ |\n'
const SCOPE_A = { targets: [{ path: 'src/a.html', symbols: [], reason: '按钮颜色' }], siblings: { searchQueries: ['按钮'], items: [] } }
const SCOPE_AQ = { targets: [...SCOPE_A.targets, { path: 'src/data/queries.html', symbols: [], reason: '请求' }], siblings: SCOPE_A.siblings }
const VERIFY = { probeCommand: 'probe', schemaFiles: 'src/data/queries\\.html$' }
const aiResult = (patch = {}) => ({ status: 'done', taskState: null, rootCauseLayer: null, evidence: null, summary: '改好了', checks: [], changedFiles: [], warnings: [], blockers: null, owner: null, failureKind: null, nextStep: null, ...patch })
const docAttachment = (name = '123-对接-用户接口.md', content = '# 用户接口\n') => ({ type: 'file', name, content })
const DOC_TASK = { text: '对接文档，看下要改什么', attachments: [docAttachment()] }
const BLOCKED_DOC_RESULT = aiResult({ status: 'blocked', summary: '文档缺字段，等后端补', blockers: ['缺 total 字段'] })
const OWNERSHIP_PROFILE = { ownership: { me: 'aven', table: 'docs/features.md' } }
const OWNERSHIP_FILES = { 'docs/features.md': FEATURE_TABLE }
const ago = (ms) => new Date(Date.now() - ms).toISOString()
const DAY = 24 * 60 * 60_000

// 用例表：名字 → spec（只放可序列化的数据，子进程里还原）。
const E2E = {
  // ── 入口闸
  empty: { task: { text: '  ' } },
  attachOnlySuperseded: { task: { text: ' ', attachments: [{ type: 'file', name: 'trace.log', content: 'log' }] }, getTask: { 1: { status: 'superseded' } } },
  intake: {
    task: { intake: { required: true } },
    intent: { decision: 'ignore', confidence: 'high', summary: '闲聊', reason: '与项目无关' },
    listTasks: [
      { id: 'same-recent', chatId: 'oc', status: 'done', updatedAgo: 60_000, createdAgo: 2 * 60_000 },
      { id: 'other-chat', chatId: 'oc2', status: 'done', updatedAgo: 60_000, createdAgo: 2 * 60_000 },
      { id: '$self', chatId: 'oc', status: 'running', updatedAgo: 0, createdAgo: 0 },
      { id: 'superseded', chatId: 'oc', status: 'superseded', updatedAgo: 60_000, createdAgo: 60_000 },
      { id: 'ignored', chatId: 'oc', status: 'ignored', updatedAgo: 60_000, createdAgo: 60_000 },
      { id: 'revived', chatId: 'oc', status: 'done', updatedAgo: 2 * 60 * 60_000, createdAgo: 30 * DAY },
      { id: 'stale', chatId: 'oc', status: 'done', updatedAgo: 8 * DAY, createdAgo: 30 * DAY },
      { id: 'created-only', chatId: 'oc', status: 'queued', createdAgo: 3 * 60 * 60_000 },
    ],
  },
  // 17 条近期候选：13 条有 updatedAt（10–22 小时前），4 条只有 createdAt 且更新（1–4 分钟前），排在列表开头。
  intakeTop15: {
    task: { intake: { required: true } },
    intent: { decision: 'ignore', confidence: 'high', summary: '闲聊', reason: '与项目无关' },
    listTasks: [
      ...Array.from({ length: 4 }, (_, i) => ({ id: `c${i + 1}`, chatId: 'oc', status: 'queued', createdAgo: (i + 1) * 60_000 })),
      ...Array.from({ length: 13 }, (_, i) => ({ id: `u${i + 1}`, chatId: 'oc', status: 'done', updatedAgo: (10 + i) * 60 * 60_000, createdAgo: 20 * DAY })),
    ],
  },
  // ── 完成态提交
  rootDone: {
    memoryDir: true,
    files: { 'src/a.html': '<p>1</p>\n', 'src/data/queries.html': '<p>q</p>\n' },
    profile: { verify: VERIFY },
    analysis: { scope: SCOPE_AQ },
    writes: { 'src/a.html': '<p>2</p>\n', 'src/data/queries.html': '<p>q</p>\n// 只加注释\n' },
    result: aiResult({ changedFiles: ['src/a.html', 'src/data/queries.html'] }),
  },
  hotfixDone: {
    context: 'temp',
    files: { 'src/a.html': '<p>1</p>\n' },
    profile: { commitPrefix: 'fix(falive)' },
    analysis: { scope: SCOPE_A },
    writes: { 'src/a.html': '<p>2</p>\n' },
    result: aiResult({ changedFiles: ['src/a.html'] }),
  },
  hotfixWrongBranch: { context: 'temp', occupyTempPath: true, analysis: { scope: SCOPE_A }, result: aiResult() },
  commitFingerprintDrift: {
    files: { 'src/a.html': '<p>1</p>\n' },
    analysis: { scope: SCOPE_A },
    writes: { 'src/a.html': '<p>2</p>\n' },
    result: aiResult({ changedFiles: ['src/a.html'] }),
    getTask: { 3: { write: { 'src/a.html': '<p>人在提交前又改了</p>\n' } } },
  },
  readOnlyDone: { context: 'readOnly', task: { text: '看下现在状态', attachments: [docAttachment()] }, result: aiResult({ summary: '状态正常' }) },
  wipReroute: {
    files: { 'src/a.html': '<p>1</p>\n', 'src/data/queries.html': '<p>q</p>\n' },
    dirty: { 'notes.txt': '人的 WIP\n' },
    profile: { verify: VERIFY },
    analysis: { scope: SCOPE_AQ },
    writes: { 'src/data/queries.html': '<p>q2</p>\n' },
    result: aiResult({ changedFiles: ['src/data/queries.html'], preChecks: [{ endpoint: 'GET /api/x', outcome: 'issues: total 缺失', kind: 'issues' }] }),
  },
  // ── 对接文档入库
  docBlocked: { task: DOC_TASK, result: BLOCKED_DOC_RESULT },
  docSame: { task: DOC_TASK, files: { [DOC]: '# 用户接口\n' }, result: aiResult({ summary: '文档缺字段，等后端补' }) },
  docDoneNew: { task: DOC_TASK, result: aiResult({ summary: '文档已接入', changedFiles: [DOC] }) },
  docProjectWorktree: { context: 'temp', projectWorktree: true, task: { ...DOC_TASK, project: 'FALIVE' }, result: BLOCKED_DOC_RESULT },
  docHotfixPartial: { context: 'temp', task: DOC_TASK, writes: { 'src/half.html': '<p>半成品</p>\n' }, result: BLOCKED_DOC_RESULT },
  docKeptHotfix: {
    context: 'temp',
    task: { ...DOC_TASK, attachments: [docAttachment('9-对接-旧版.md', '# 群里转的版本\n')] },
    files: { [KEPT_DOC]: '# 仓里的版本\n' },
    writes: { [KEPT_DOC]: '# AI 改过\n' },
    result: aiResult({ summary: '对过了', changedFiles: [KEPT_DOC] }),
  },
  docJsonVerifyFail: { task: { ...DOC_TASK, attachments: [docAttachment('5-对接-字段.json', '{}\n')] }, result: BLOCKED_DOC_RESULT, getTask: { 4: { status: 'done' } } },
  docDeclaredOther: { task: DOC_TASK, files: OWNERSHIP_FILES, profile: OWNERSHIP_PROFILE, analysis: { ownership: { mine: false, owner: 'Lily', featureIds: ['2'] } } },
  docDeclaredMineNoOwner: { task: DOC_TASK, files: OWNERSHIP_FILES, profile: OWNERSHIP_PROFILE, analysis: { ownership: { mine: true, owner: null, featureIds: [] } }, result: aiResult({ status: 'blocked', summary: '先等接口', blockers: ['缺接口'] }) },
  docSummaryNamesOther: { task: DOC_TASK, files: OWNERSHIP_FILES, profile: OWNERSHIP_PROFILE, result: aiResult({ status: 'blocked', summary: '这块是 Lily 的帖子', blockers: ['等接口定下来'] }) },
  docSummaryNamesMe: {
    task: { ...DOC_TASK, attachments: [docAttachment(), docAttachment('9-对接-旧版.md', '# 群里转的版本\n')] },
    files: { ...OWNERSHIP_FILES, [KEPT_DOC]: '# 仓里的版本\n' },
    profile: OWNERSHIP_PROFILE,
    writes: { [KEPT_DOC]: '# AI 改过\n' },
    result: aiResult({ status: 'blocked', summary: '直播间这块 aven 负责', blockers: ['等接口定下来'], owner: 'Bob' }),
  },
  sweepDoc: { task: { ...DOC_TASK, source: 'daily-sweep' }, result: BLOCKED_DOC_RESULT },
  // ── 非完成态 / 归属
  otherOwner: { analysis: { ownership: { mine: false, owner: 'Lily', featureIds: ['12'] } } },
  notFrontend: { result: aiResult({ status: 'no_change_needed', noChangeReason: 'not_frontend', summary: '后端字段没返回' }) },
  statusChangedMidRun: { analysis: { status: 'blocked', blockers: ['缺设计稿'] }, getTask: { 2: { status: 'waiting_confirmation' } } },
  scopeAsk: { files: { 'src/a.html': '<p>1</p>\n' }, analysis: { scope: SCOPE_A }, result: aiResult({ status: 'waiting_confirmation', summary: '还要改别处', blockers: ['需要一并改 src/b.html 才能修好'] }) },
  scopeAskNoCode: { task: { contract: { expectsCode: false } }, files: { 'src/a.html': '<p>1</p>\n' }, analysis: { scope: SCOPE_A }, result: aiResult({ status: 'waiting_confirmation', summary: '还要改别处', blockers: ['需要一并改 src/b.html 才能修好'] }) },
  // ── 内部群任务（无 task.repo，按 projectKey 落到同一 profile）：完成卡附系统实测栏
  nonRepoBlocked: { context: 'temp', memoryDir: true, task: { repo: null, project: 'FALIVE' }, analysis: { status: 'blocked', blockers: ['缺设计稿'] }, getTask: { 3: null, 4: 'throw' } },
  nonRepoDone: {
    context: 'temp',
    task: { repo: null, project: 'FALIVE' },
    files: { 'src/a.html': '<p>1</p>\n' },
    analysis: { scope: SCOPE_A },
    writes: { 'src/a.html': '<p>2</p>\n' },
    result: aiResult({ changedFiles: ['src/a.html'] }),
  },
  // ── 异常 / 中断
  routeMismatch: { context: 'wrongCwd', releaseTask: true },
  routeMismatchSuperseded: { context: 'wrongCwd', getTask: { 1: { status: 'superseded', epoch: 2 }, 2: 'throw' } },
  shutdownAbort: { signal: 'aborted', analysis: { status: 'blocked', blockers: ['缺设计稿'] } },
  deadline: { signal: 'live', deadline: true, analysis: { status: 'blocked', blockers: ['缺设计稿'] } },
  deadlineNoAny: { deadline: true, noAbortSignalAny: true, analysis: { status: 'blocked', blockers: ['缺设计稿'] } },
}

const FAKE_CLAUDE = [
  `#!${process.execPath}`,
  "const fs = require('node:fs')",
  "const path = require('node:path')",
  'const args = process.argv.slice(2)',
  "if (args[0] === '--version') { console.log('9.9.9 (fake)'); process.exit(0) }",
  "const spec = JSON.parse(fs.readFileSync(process.env.LARK_FAKE_CLAUDE_SPEC, 'utf8'))",
  "const kind = args.includes('plan') ? 'intent' : !args.includes('--json-schema') ? 'task' : args.includes('--no-session-persistence') ? 'triage' : 'analysis'",
  'fs.appendFileSync(`${process.env.LARK_FAKE_CLAUDE_SPEC}.calls`, `${kind}\\n`)',
  "if (kind !== 'task') { process.stdout.write(JSON.stringify({ session_id: 'sess-a', structured_output: spec[kind] || {} })); process.exit(0) }",
  "process.stdout.write('{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"sess-t\"}\\n')",
  'for (const [file, content] of Object.entries(spec.writes || {})) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content) }',
  "const resultPath = args.at(-1).match(/结果文件路径：(\\S+)/)?.[1]",
  'if (resultPath && spec.result) fs.writeFileSync(resultPath, JSON.stringify(spec.result))',
  '',
].join('\n')

// 子进程里跑一条用例：建临时业务仓 → 注册 profile → 跑真 createTaskRunner → 收集回写 / 审计 / git 结果。
const runE2ECase = async (name, spec, root) => {
  const dir = join(root, name)
  const repo = join(dir, 'repo')
  mkdirSync(repo, { recursive: true })
  const git = (args, cwd = repo) => spawnSync('git', ['-C', cwd, '-c', 'core.quotepath=off', ...args], { encoding: 'utf8' }).stdout.trim()
  const writeAll = (base, files = {}) => {
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(join(base, file)), { recursive: true })
      writeFileSync(join(base, file), content)
    }
  }
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.email', 't@t'])
  git(['config', 'user.name', 't'])
  writeAll(repo, { 'CLAUDE.md': RULES_MD, ...spec.files })
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'init'])
  writeAll(repo, spec.dirty)
  const profile = { root: repo, baseRef: 'main', chatIds: ['oc'], ownership: { me: 'aven' }, docIntakeDir: 'docs/delivery/pending', worktreesDir: join(dir, 'wt'), ...spec.profile }
  if (spec.memoryDir) {
    profile.claudeMemoryDir = join(dir, 'memory')
    mkdirSync(profile.claudeMemoryDir)
  }
  registerRepoProfiles({ repos: { falive: profile } })
  // 人的项目 worktree（<worktreesDir>/<项目号>，主仓的 linked worktree）：任务就地在它的当前分支上干活。
  if (spec.projectWorktree) git(['worktree', 'add', '-q', '-b', 'feature/falive', join(dir, 'wt', 'FALIVE')])
  const specPath = join(dir, 'spec.json')
  const analysis = { status: 'ready', summary: '分析', applicableRules: [], requirements: [], blockers: [], scope: null, ...spec.analysis }
  writeFileSync(specPath, JSON.stringify({ analysis, intent: spec.intent, result: spec.result || null, writes: spec.writes || {} }))
  process.env.LARK_FAKE_CLAUDE_SPEC = specPath
  const now = new Date().toISOString()
  const attachments = (spec.task?.attachments || []).map(({ name: fileName, content, type }) => {
    writeFileSync(join(dir, fileName), content)
    return type === 'image' ? { type, imageKey: 'img-1', localPath: join(dir, fileName) } : { type, fileName, localPath: join(dir, fileName) }
  })
  const task = { id: `e2e-${name}`, epoch: 1, status: 'running', repo: 'falive', chatId: 'oc', text: '修一下按钮颜色', addressedToBot: true, createdAt: now, claimedAt: now, ...spec.task, ...(spec.task?.attachments ? { attachments } : {}) }
  if (task.repo === null) delete task.repo
  const workContext = spec.context === 'temp'
    ? resolveWorkContext({ localConfig: {} }, task)
    : { repo: 'falive', projectId: spec.context === 'readOnly' ? '(adhoc)' : null, projectName: 'Falive', cwd: spec.context === 'wrongCwd' ? dir : repo, projectDocs: [], readOnly: spec.context === 'readOnly' }
  const tempPath = spec.context === 'temp' ? workContext.cwd : null
  if (spec.occupyTempPath) {
    git(['worktree', 'add', '-q', '-b', 'other', tempPath])
    writeFileSync(join(tempPath, 'stray.txt'), '上次留下的\n')
  }
  const reports = []
  const intakes = []
  let current = { ...task }
  let getTaskCount = 0
  let releaseCalls = 0
  let deadline = null
  let liveCwd = workContext.cwd
  const client = {
    updateTask: async (id, status, result, executor, epoch, owner, branch, extra) => {
      reports.push({ status, result: result || '', owner: owner ?? null, branch: branch ?? null, extra: extra ?? null })
      current = { ...current, status, result }
      return { ok: true }
    },
    getTask: async () => {
      getTaskCount += 1
      if (getTaskCount === 1 && deadline) deadline.abort(new DOMException('任务截止时间到', 'TimeoutError'))
      const scripted = spec.getTask?.[getTaskCount]
      if (scripted === 'throw') throw new Error('网关读不到')
      if (scripted === null) return null
      if (scripted?.write) writeAll(liveCwd, scripted.write)
      return scripted?.status ? { ...current, ...scripted } : current
    },
    resolveIntake: async (id, payload) => { intakes.push(payload); return {} },
    listTasks: async () => (spec.listTasks || []).map(({ updatedAgo, createdAgo, id, ...item }) => ({
      ...item,
      id: id === '$self' ? task.id : id,
      ...(updatedAgo === undefined ? {} : { updatedAt: ago(updatedAgo) }),
      ...(createdAgo === undefined ? {} : { createdAt: ago(createdAgo) }),
    })),
    heartbeatTask: async () => ({ ok: true }),
    releaseTask: async () => { releaseCalls += 1; return Boolean(spec.releaseTask) },
  }
  const controller = new AbortController()
  if (spec.signal === 'aborted') controller.abort()
  const originalTimeout = AbortSignal.timeout
  const originalAny = AbortSignal.any
  if (spec.deadline) {
    deadline = new AbortController()
    AbortSignal.timeout = () => deadline.signal
  }
  if (spec.noAbortSignalAny) AbortSignal.any = undefined
  let threw = null
  const started = Date.now()
  try {
    await createTaskRunner({ client, workerConfig: { localConfig: {} } })(task, workContext, spec.signal ? { signal: controller.signal } : {})
  } catch (error) {
    threw = String(error?.stack || error)
  } finally {
    AbortSignal.timeout = originalTimeout
    AbortSignal.any = originalAny
  }
  const auditRoot = join(process.env.LARK_RUNTIME_DIR, 'lark-audits')
  const auditFile = (existsSync(auditRoot) ? readdirSync(auditRoot) : []).map((project) => join(auditRoot, project, `${task.id}-e1.json`)).find((file) => existsSync(file))
  const audit = auditFile ? JSON.parse(readFileSync(auditFile, 'utf8')) : null
  const callsFile = `${specPath}.calls`
  const fingerprint = audit?.failureFingerprint?.fingerprint
  return {
    ms: Date.now() - started,
    reports,
    intakes,
    audit,
    threw,
    getTaskCount,
    releaseCalls,
    taskId: task.id,
    calls: existsSync(callsFile) ? readFileSync(callsFile, 'utf8').split('\n').filter(Boolean) : [],
    // 全部分支上的提交（主题 + 文件），最新的在前、init 在最后。
    commits: git(['log', '--all', '--format=%x00%s', '--name-only']).split('\0').filter(Boolean).map((block) => {
      const [subject, ...files] = block.split('\n').filter(Boolean)
      return { subject, files }
    }),
    repoStatus: git(['status', '--porcelain', '--untracked-files=all']),
    repoFiles: Object.fromEntries([DOC, KEPT_DOC, 'notes.txt'].map((file) => [file, existsSync(join(repo, file)) ? readFileSync(join(repo, file), 'utf8') : null])),
    repo,
    branch: workContext.hotfixBranch || null,
    tempPathExists: tempPath ? existsSync(tempPath) : null,
    cwdExists: existsSync(workContext.cwd),
    memoryLinked: existsSync(join(homedir(), '.claude', 'projects', claudeProjectKey(workContext.cwd), 'memory')),
    ledgerCount: fingerprint ? countRecentFingerprint({ repo: 'falive', fingerprint }) : null,
  }
}

const BATCH = process.env.LARK_RUNNER_E2E_BATCH
if (BATCH) {
  const { names, root, out } = JSON.parse(readFileSync(BATCH, 'utf8'))
  const results = {}
  for (const name of names) {
    try {
      results[name] = await runE2ECase(name, E2E[name], root)
    } catch (error) {
      results[name] = { crashed: String(error?.stack || error) }
    }
  }
  writeFileSync(out, JSON.stringify(results))
  process.exit(0)
}

// 全部用例分 LANES 路子进程并行跑一次（每路一个运行态目录），结果按名字缓存；哪段先要就哪段触发。
const LANES = 4
let e2eBatch = null
const runE2EBatch = async () => {
  const root = mkdtempSync(join(tmpdir(), 'lark-runner-e2e-'))
  try {
    const bin = join(root, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'claude'), FAKE_CLAUDE)
    chmodSync(join(bin, 'claude'), 0o755)
    // 子进程 HOME 指到临时目录（不读写本机 ~/.claude、~/.ai-rules）：只放规则上下文必需的常驻硬规则章节。
    mkdirSync(join(root, 'home', '.ai-rules'), { recursive: true })
    writeFileSync(join(root, 'home', '.ai-rules', 'AGENT.md'), '# rules\n\n## React / TypeScript Hard Rules\n\n- 不用裸 any\n')
    const names = Object.keys(E2E)
    const lanes = Array.from({ length: LANES }, (_, lane) => names.filter((_, index) => index % LANES === lane))
    const parts = await Promise.all(lanes.map((laneNames, lane) => new Promise((resolve) => {
      const batchFile = join(root, `batch-${lane}.json`)
      const out = join(root, `out-${lane}.json`)
      writeFileSync(batchFile, JSON.stringify({ names: laneNames, root: join(root, `lane-${lane}`), out }))
      const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, LARK_RUNTIME_DIR: join(root, `runtime-${lane}`), LARK_CLI_BIN: '/usr/bin/false', LARK_SELF_FIX: '0', HOME: join(root, 'home'), LARK_RUNNER_E2E_BATCH: batchFile }
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], { env, cwd: root, stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000) })
      child.on('close', () => resolve(existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : Object.fromEntries(laneNames.map((name) => [name, { crashed: stderr }]))))
    })))
    return Object.assign({}, ...parts)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
const e2e = async (name) => {
  e2eBatch ||= runE2EBatch()
  const result = (await e2eBatch)[name]
  assert.ok(result && !result.crashed, `端到端用例 ${name} 没跑完：${result?.crashed?.slice(-1500)}`)
  assert.equal(result.threw, null, `端到端用例 ${name} 不该向外抛：${result.threw}`)
  return { ...result, final: result.reports.at(-1) }
}

describe('任务截止时间与续租心跳（第 0 批）', () => {
  it('剩余预算从领取时刻起算，退出型中断不写 failed、截止超时要写', () => runSteps([
    ['剩余预算从领取时刻起算；任务自带 taskBudgetMs 优先；超预算也留 60s 写失败', () => {
      const now = Date.parse('2026-10-17T10:00:00Z')
      assert.equal(remainingTaskBudgetMs({ claimedAt: '2026-10-17T09:50:00Z' }, now), DEFAULT_TASK_BUDGET_MS - 10 * 60_000)
      assert.equal(remainingTaskBudgetMs({ claimedAt: '2026-10-17T09:00:00Z', taskBudgetMs: 30 * 60_000 }, now), 60_000)
      assert.equal(remainingTaskBudgetMs({}, now), DEFAULT_TASK_BUDGET_MS)
    }],
    ['退出型中断不写 failed，截止时间（TimeoutError）要写 failed', () => {
      const shutdown = new AbortController()
      shutdown.abort()
      assert.equal(isShutdownAbort(shutdown.signal), true)
      const timeout = AbortSignal.timeout(1)
      return new Promise((resolve) => setTimeout(() => {
        assert.equal(timeout.aborted, true)
        assert.equal(isShutdownAbort(timeout), false)
        assert.equal(isShutdownAbort(undefined), false)
        resolve()
      }, 20))
    }],
    ['对接文档入库：AI 判 blocked（没完成）时文档照样入库提交，任务按 done 收尾、结论写「已存进仓库」+ 还缺什么（变异补测 10-24）', async () => {
      const { final, commits } = await e2e('docBlocked')
      assert.equal(final.status, 'done', final.result)
      assert.match(final.result, /^文档已存进仓库（docs\/delivery\/pending\/对接-用户接口\.md）。/)
      assert.match(final.result, /还缺：缺 total 字段/)
      assert.equal(commits.length, 2, '入库提交了一次')
      assert.deepEqual(commits[0].files, [DOC], '只提交文档本身')
      assert.match(commits[0].subject, /^lark task: /, 'profile 没配 commitPrefix 时用默认前缀 lark task')
    }],
    ['对接文档入库：AI 判 done 但文档和仓里已有版本逐字节相同、工作区没动（无需改动）→ 也走入库收尾：done、「无需提交」、不提交（变异补测 10-24）', async () => {
      const { final, commits } = await e2e('docSame')
      assert.equal(final.status, 'done', final.result)
      assert.match(final.result, /^文档无需提交：对接-用户接口\.md 和仓里已有版本逐字节相同/)
      assert.deepEqual(commits.map((item) => item.subject), ['init'], '没有要提交的')
    }],
    ['空任务直接按失败回写；正文为空但带附件不算空任务、照常开工；开工前回查到已被取消就中止，不跑 AI（变异补测 10-24）', async () => {
      const empty = await e2e('empty')
      assert.deepEqual(empty.reports.map((item) => item.status), ['failed'])
      assert.match(empty.final.result, /这条 Lark 任务内容为空/)
      const attachOnly = await e2e('attachOnlySuperseded')
      assert.deepEqual(attachOnly.reports.map((item) => item.status), ['running'], '只带附件的任务照常开工，开工后回查到 superseded 就停、不再回写')
      assert.deepEqual(attachOnly.calls, [], '取消检查点在烧 AI 之前')
    }],
    ['前置意图分类的主题候选：只取同群、非本条、没结单 / 没忽略、7 天内有更新（updatedAt 优先，缺了用 createdAt）的任务（变异补测 10-24）', async () => {
      const { audit, intakes } = await e2e('intake')
      assert.deepEqual([...audit.intakeCandidates].sort(), ['created-only', 'revived', 'same-recent'])
      assert.equal(intakes.length, 1, '分类结论交给网关结算一次')
      assert.equal(intakes[0].classification?.decision, 'ignore')
    }],
    ['前置意图分类的主题候选超过 15 条：按「updatedAt，缺了用 createdAt」降序取最近的 15 条，只有 createdAt 的新任务不被旧任务挤掉（bug 修复 10-24）', async () => {
      const { audit } = await e2e('intakeTop15')
      const expected = ['c1', 'c2', 'c3', 'c4', ...Array.from({ length: 11 }, (_, i) => `u${i + 1}`)]
      assert.deepEqual([...audit.intakeCandidates].sort(), expected.sort(), '最旧的 u12、u13 落选')
    }],
    ['命中人类 worktree 的完成任务：只提交本任务实测改动、默认前缀 lark task、running 回写带当前分支；只加注释的接口文件不触发实测闸；外部群结论不附系统实测栏；AI 运行中不高频回查网关（变异补测 10-24）', async () => {
      const r = await e2e('rootDone')
      assert.deepEqual(r.reports.map((item) => item.status), ['running', 'done'], r.final.result)
      assert.equal(r.reports[0].branch, 'main', 'running 回写带上命中 worktree 的当前分支')
      assert.deepEqual(r.final.extra.change, { committed: true }, '回写带上「已提交」的结论')
      assert.doesNotMatch(r.final.result, /实测改动|修改范围契约/, '外部群（task.repo）结论只给人话，系统实测栏留在审计')
      assert.doesNotMatch(r.final.result, /没在 pre 实测|对不上/, '接口文件只加了注释，不算接口改动')
      assert.equal(r.commits.length, 2)
      assert.match(r.commits[0].subject, /^lark task: 修一下按钮颜色/)
      assert.deepEqual(r.commits[0].files, ['src/a.html', 'src/data/queries.html'])
      assert.equal(r.audit.commit.mode, 'scoped')
      assert.equal(r.audit.status, 'done')
      const { hotfixBranch, baseRef, sourceBranch, sourceWorktree } = r.audit.workContext
      assert.deepEqual({ hotfixBranch, baseRef, sourceBranch, sourceWorktree }, { hotfixBranch: null, baseRef: null, sourceBranch: null, sourceWorktree: null }, '审计里没有的路由字段记 null')
      assert.equal(r.memoryLinked, true, '外部群仓库任务把项目记忆软链到主仓 memory')
      assert.ok(r.getTaskCount <= 6, `网关回查只在开工 / AI 后 / 提交前 / 回写后 / 收尾各一次，AI 运行中按 30s 兜底轮询，实际 ${r.getTaskCount} 次`)
    }],
    ['隔离临时 worktree 的完成任务：按 profile 的提交前缀全量提交、删掉临时 worktree、running 回写带任务分支、审计记下分支与基线（变异补测 10-24）', async () => {
      const r = await e2e('hotfixDone')
      assert.match(r.branch, /^lark\/falive-/)
      assert.deepEqual(r.reports.map((item) => item.status), ['running', 'done'], r.final.result)
      assert.equal(r.reports[0].branch, r.branch)
      assert.deepEqual(r.final.extra.change, { committed: true })
      assert.match(r.commits[0].subject, /^fix\(falive\): /)
      assert.deepEqual(r.commits[0].files, ['src/a.html'])
      assert.equal(r.audit.commit.mode, 'auto')
      assert.equal(r.tempPathExists, false, '提交后临时 worktree 删掉')
      assert.equal(r.audit.workContext.hotfixBranch, r.branch)
      assert.equal(r.audit.workContext.baseRef, 'main')
    }],
    ['复用的临时 worktree 检出的不是本任务分支：开工前 git 身份校验拦下按失败回写，不跑 AI（变异补测 10-24）', async () => {
      const r = await e2e('hotfixWrongBranch')
      assert.equal(r.final.status, 'failed')
      assert.match(r.final.result, /worktree 身份校验失败：预期分支 lark\/falive-\S+，实际为 other/)
      assert.deepEqual(r.calls, [])
    }],
    ['终检后到提交前工作树又被改了：不提交、降级 failed，回写带 commit 闸与原因（变异补测 10-24）', async () => {
      const r = await e2e('commitFingerprintDrift')
      assert.equal(r.final.status, 'failed')
      assert.equal(r.final.extra.change.gate, 'commit')
      assert.match(r.final.extra.change.reason, /^提交前工作树指纹校验失败/)
      assert.equal(r.commits.length, 1, '没有提交')
    }],
    ['只读任务完成：附件不存档进人的主仓、不提交，收尾不报错（变异补测 10-24）', async () => {
      const r = await e2e('readOnlyDone')
      assert.deepEqual(r.reports.map((item) => item.status), ['running', 'done'], r.final.result)
      const { mode, ok, committed, reason } = r.audit.commit
      assert.deepEqual({ mode, ok, committed, reason }, { mode: 'none', ok: true, committed: false, reason: '只读任务不提交' })
      assert.equal(r.repoFiles[DOC], null, '只读任务不往主仓存对接文档')
      assert.equal(r.repoStatus, '')
    }],
    ['开工时人的 worktree 有 WIP：改到基于当前分支 HEAD 的隔离分支、结论提示合回原分支、审计保留改道来源；接口实测有 issues 降级 failed 不提交（变异补测 10-24）', async () => {
      const r = await e2e('wipReroute')
      assert.equal(r.final.status, 'failed')
      assert.match(r.final.result, /本次从 main@[0-9a-f]{12} 创建隔离分支/)
      assert.match(r.final.result, /merge 回 main/)
      assert.match(r.final.result, /schema 与 pre 真实响应对不上/)
      assert.equal(r.final.extra.change.gate, 'schema')
      assert.equal(r.commits.length, 1, '没有提交')
      assert.equal(r.repoFiles['notes.txt'], '人的 WIP\n', '人的 WIP 原样留在原工作区')
      const { reroutedFrom, sourceBranch, sourceWorktree } = r.audit.workContext
      assert.deepEqual({ reroutedFrom, sourceBranch, sourceWorktree }, { reroutedFrom: 'preexisting-wip', sourceBranch: 'main', sourceWorktree: r.repo })
    }],
    ['对接文档 AI 判 done、新存档让工作区有改动：走正常核验闸按完成提交，不走「无需提交」捷径（变异补测 10-24）', async () => {
      const { final, commits } = await e2e('docDoneNew')
      assert.equal(final.status, 'done')
      assert.match(final.result, /^已完成。/)
      assert.deepEqual(commits[0].files, [DOC])
    }],
    ['对接文档入库只提交文档：临时 worktree 里不带上 AI 留下的半成品代码；人的项目 worktree 提交后原样保留（变异补测 10-24）', async () => {
      const { final, commits } = await e2e('docHotfixPartial')
      assert.equal(final.status, 'done', final.result)
      assert.equal(commits.length, 2)
      assert.deepEqual(commits[0].files, [DOC])
      assert.match(commits[0].subject, /^lark task: /)
      const project = await e2e('docProjectWorktree')
      assert.equal(project.final.status, 'done', project.final.result)
      assert.deepEqual(project.commits[0].files, [DOC])
      assert.equal(project.cwdExists, true, '人的项目 worktree 入库提交后原样保留，不当临时 worktree 删')
    }],
    ['临时 worktree 里 AI 改了仓里已有不同版本的文档（#kept）：提交前恢复成仓里版本，结论「无需提交、没覆盖」（变异补测 10-24）', async () => {
      const { final, commits } = await e2e('docKeptHotfix')
      assert.equal(final.status, 'done')
      assert.match(final.result, /^文档无需提交：对接-旧版\.md 仓里已有不同版本，没覆盖/)
      assert.equal(commits.length, 1)
    }],
    ['对接文档终检没过：降级 failed；之后网关即便显示 done，收尾也因没有通过的终检指纹不提交（变异补测 10-24）', async () => {
      const { final, commits, audit } = await e2e('docJsonVerifyFail')
      assert.equal(final.status, 'failed')
      assert.deepEqual(final.extra.change, { committed: false, gate: 'final-verification', reason: '文档终检没过' })
      assert.equal(commits.length, 1)
      assert.equal(audit.commit.ok, false)
      assert.equal(audit.commit.reason, '提交前缺少已通过的 Worker 最终复验指纹')
    }],
    ['对接文档的归属：结构化 ownership 优先（不归我不入库）；没给时按功能总表名字在结论 / 待补 / owner 里认人，认出别人不入库、认出自己照存；人的 worktree 里 #kept 的改动不回滚（变异补测 10-24）', async () => {
      const declaredOther = await e2e('docDeclaredOther')
      assert.match(declaredOther.final.result, /^文档内容归 Lily 负责，跟你无关，没存进仓库/)
      assert.equal(declaredOther.repoFiles[DOC], null, '不入库的文档从工作区撤掉')
      assert.equal(declaredOther.commits.length, 1)
      const declaredMine = await e2e('docDeclaredMineNoOwner')
      assert.match(declaredMine.final.result, /^文档已存进仓库（docs\/delivery\/pending\/对接-用户接口\.md）。是我负责的部分/)
      const namesOther = await e2e('docSummaryNamesOther')
      assert.match(namesOther.final.result, /^文档内容归 Lily 负责，跟你无关/)
      assert.equal(namesOther.repoFiles[DOC], null)
      const namesMe = await e2e('docSummaryNamesMe')
      assert.match(namesMe.final.result, /^文档已存进仓库（docs\/delivery\/pending\/对接-用户接口\.md）；对接-旧版\.md 仓里已有不同版本，没覆盖。内容归 Bob 负责，不归我/)
      assert.deepEqual(namesMe.commits[0].files, [DOC])
      assert.equal(namesMe.repoFiles[KEPT_DOC], '# AI 改过\n', '人的 worktree 不替 AI 回滚，只是不提交')
    }],
    ['没有分析阶段的任务（日报清扫）带对接文档：照样入库（变异补测 10-24）', async () => {
      const { final } = await e2e('sweepDoc')
      assert.equal(final.status, 'done', final.result)
      assert.match(final.result, /^文档已存进仓库/)
    }],
    ['归属别的负责人（other_owner）：群里回一句归谁、带功能总表序号；非前端（not_frontend）无需改动：不回群、不走文档入库、不提交（变异补测 10-24）', async () => {
      const other = await e2e('otherOwner')
      assert.equal(other.final.status, 'no_change_needed')
      assert.equal(other.final.extra.groupReply, '看过了，这条要改的在前端 Lily 负责的部分（功能总表 #12），麻烦 Lily 看下，我这边不动。')
      const notFrontend = await e2e('notFrontend')
      assert.equal(notFrontend.final.status, 'no_change_needed')
      assert.equal(notFrontend.final.extra.groupReply, null)
      assert.match(notFrontend.final.result, /^无需改动。/)
      const { mode, ok, committed, reason } = notFrontend.audit.commit
      assert.deepEqual({ mode, ok, committed, reason }, { mode: 'none', ok: true, committed: false, reason: '未完成，不往已有分支写半成品' })
      assert.equal(notFrontend.commits.length, 1)
    }],
    ['AI 跑完时网关状态已不是 running：不再回写结果（变异补测 10-24）', async () => {
      const { reports } = await e2e('statusChangedMidRun')
      assert.deepEqual(reports.map((item) => item.status), ['running'])
    }],
    ['实施阶段自停点名契约外文件：会改代码的任务给出「确认扩大范围」放行请求，不改代码的任务不给（变异补测 10-24）', async () => {
      const ask = await e2e('scopeAsk')
      assert.equal(ask.final.status, 'waiting_confirmation')
      assert.match(ask.final.result, /回复本卡片「确认扩大范围」/)
      assert.deepEqual(ask.final.extra.scopeRequest?.paths, ['src/b.html'])
      const noCode = await e2e('scopeAskNoCode')
      assert.equal(noCode.final.status, 'waiting_confirmation')
      assert.doesNotMatch(noCode.final.result, /确认扩大范围/)
      assert.equal(noCode.final.extra.scopeRequest, null)
    }],
    ['内部群任务：完成卡附系统实测栏与范围契约段，未完成不附；回写后网关读不到时，审计按本次回写记状态与结论（变异补测 10-24）', async () => {
      const done = await e2e('nonRepoDone')
      assert.equal(done.final.status, 'done', done.final.result)
      assert.match(done.final.result, /实测改动 1 处/)
      assert.match(done.final.result, /修改范围契约：/)
      const blocked = await e2e('nonRepoBlocked')
      assert.equal(blocked.final.status, 'blocked')
      assert.doesNotMatch(blocked.final.result, /实测改动|修改范围契约/)
      assert.equal(blocked.audit.status, 'blocked')
      assert.deepEqual(blocked.audit.gateway, { status: 'blocked', result: blocked.final.result })
      assert.match(blocked.audit.error, /读取最终状态失败/)
      assert.equal(blocked.memoryLinked, false, '项目记忆软链只给带 task.repo 的仓库任务')
    }],
    ['执行异常：报失败并记失败台账，非重排队类不交还队列；网关显示已换代就不报失败、审计记网关状态（变异补测 10-24）', async () => {
      const failed = await e2e('routeMismatch')
      assert.deepEqual(failed.reports.map((item) => item.status), ['failed'])
      assert.match(failed.final.result, /任务路由一致性校验失败/)
      assert.equal(failed.releaseCalls, 0, '未归类异常不自动重排队')
      assert.equal(failed.ledgerCount, 1, '失败记进台账（7 天复发计数靠它）')
      const superseded = await e2e('routeMismatchSuperseded')
      assert.deepEqual(superseded.reports, [])
      assert.equal(superseded.audit.status, 'superseded')
    }],
    ['截止时间到（TimeoutError）中断 AI 并按失败回写；Worker 带退出信号时截止时间照样生效，没有 AbortSignal.any 的运行时也生效（变异补测 10-24）', async () => {
      const withSignal = await e2e('deadline')
      assert.deepEqual(withSignal.reports.map((item) => item.status), ['running', 'failed'], withSignal.final.result)
      const noAny = await e2e('deadlineNoAny')
      assert.deepEqual(noAny.reports.map((item) => item.status), ['running', 'failed'], noAny.final.result)
    }],
    ['退出型中断（Worker 优雅退出）：AI 被中断后不写 failed，任务留给重领（变异补测 10-24）', async () => {
      const { reports } = await e2e('shutdownAbort')
      assert.deepEqual(reports.map((item) => item.status), ['running'])
    }],
  ]))

  it('心跳每 leaseMs/3 续一次；gateway 回 ok:false（epoch 变了）就停；stop 后不再调', async () => {
    const calls = []
    let tick = null
    let cleared = 0
    const client = { heartbeatTask: async (id, epoch) => { calls.push([id, epoch]); return calls.length >= 2 ? { ok: false, code: 409 } : { ok: true } } }
    const stop = startLeaseHeartbeat({
      client,
      task: { id: 't1', epoch: 3 },
      leaseMs: 90_000,
      setIntervalImpl: (fn, ms) => { tick = fn; assert.equal(ms, 30_000); return { unref() {} } },
      clearIntervalImpl: () => { cleared += 1 },
    })
    await tick()
    assert.deepEqual(calls, [['t1', 3]])
    await tick()
    assert.equal(cleared, 1, '409 后停心跳')
    await tick()
    assert.equal(calls.length, 2, '停了就不再调')
    stop()
    assert.equal(startLeaseHeartbeat({ client: {}, task: { id: 'x' } })(), undefined, '没有 heartbeatTask 的 client 直接 no-op')
  })
})
