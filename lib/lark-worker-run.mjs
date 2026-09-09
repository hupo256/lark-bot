/**
 * Lark Worker 的 AI 编排层：装载 worker 本地配置、命令类任务的项目文档同步，
 * 以及按执行器分流的 AI 运行（claude/pi/cursor 单趟；codex 走「只读分析 → 实施」两阶段并校验只读约束）。
 */

import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { inspectRuleChain } from '../../engine/agent-scripts/lib/rule-chain-runtime.mjs'
import { docsSystemRoot, repoRoot } from './lark-worker-env.mjs'
import { docsDir } from './lark-repo.mjs'
import { buildFocusedRuleContext } from './lark-rule-context.mjs'
import { resolveCommandType } from './lark-message.mjs'
import { resolveAnalysisGate } from './lark-work-policy.mjs'
import { buildAnalysisPrompt, buildIntentClassificationPrompt, buildTaskPrompt } from './lark-worker-prompts.mjs'
import { execAiExecutor, resolveAiExecutor } from './lark-ai-executor.mjs'
import { snapshotWorktree } from './lark-worker-git.mjs'
import { updateTaskAudit } from './lark-worker-audit.mjs'
import { blockedResultFromAnalysis } from './lark-worker-results.mjs'

// 测试反馈类任务不该被 G2 / PRD / 历史门禁等流程材料卡住，但「一律放行」同样错。
// 判定已下沉到 lark-work-policy.mjs：按 hard / soft / decision / process 四类归类 AI 给出的
// blockers，再由 workKind 决定哪些类构成停机理由；soft / decision 转成显式假设随实施 prompt 下发。
// 这里只保留一层薄适配（旧签名 (task, analysis) → analysis），供既有调用点与单测使用。
export const normalizeAnalysisForTask = (task, analysis) => resolveAnalysisGate({ task, analysis }).analysis

export const loadWorkerLocalConfig = (configPath) => {
  if (!configPath) return {}
  const absolutePath = isAbsolute(configPath) ? configPath : join(repoRoot, configPath)
  try {
    return JSON.parse(readFileSync(absolutePath, 'utf8'))
  } catch (error) {
    throw new Error(`worker config 读取失败（${absolutePath}）：${error.message}`)
  }
}

// 命令类任务（状态/文档/修复/自测/api/qa）开发前先同步项目文档；项目无同步脚本则跳过。
export const runProjectDocSync = async ({ projectId }) => {
  // 必须走 docsDir（= resolveProjectRoot）：三域重组后项目实例在 docs 仓 prds/<PR> 下，
  // 手拼 apps/web/docs_tdd/<PR> 会漏掉 prds/ 层 → access 恒失败 → 每个命令类任务都被
  // 静默判成「无同步脚本」跳过文档同步，AI 拿着过期文档干活且没有任何报错。
  const syncScript = join(docsDir(projectId), 'agent/scripts/sync-lark-docs.mjs')
  try {
    await access(syncScript)
  } catch {
    return { skipped: true, reason: 'missing project sync script' }
  }

  await new Promise((resolve, reject) => {
    const child = spawn('node', [syncScript], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) {
        if (stdout.trim()) console.log(`[lark-worker] doc sync: ${stdout.trim()}`)
        resolve()
        return
      }
      reject(new Error(`Lark doc sync failed before development: ${(stderr || stdout).trim() || `exit ${code}`}`))
    })
  })

  return { skipped: false }
}

// 只 @ 负责人的消息先在 docs 仓根目录做严格只读意图分类；不装 worktree、不读项目规则、不触碰业务代码。
export const classifyTaskIntent = async (workerConfig, task, auditContext, signal) => {
  const executor = resolveAiExecutor(workerConfig, task)
  updateTaskAudit(auditContext, { status: 'classifying_intent' })
  const run = await execAiExecutor({
    executor,
    promptText: buildIntentClassificationPrompt(task),
    cwd: docsSystemRoot,
    attachments: task.attachments || [],
    localConfig: workerConfig.localConfig,
    resultKind: 'intent',
    readOnly: true,
    auditLogPath: auditContext?.logPath,
    signal,
  })
  updateTaskAudit(auditContext, { status: 'intent_classified', intake: run.result })
  return run.result
}

export const runAI = async (workerConfig, task, workContext, auditContext, signal) => {
  const executor = resolveAiExecutor(workerConfig, task)
  const cwd = workContext.cwd || repoRoot
  // 规则链新鲜度：提示不阻断。effective 指纹会因 consumerRoot(fameex-web) 的 AGENTS.md 随分支/合并
  // 漂移而频繁 stale，但 AI 读的是 worktree 里实际规则文件、并不因此变错。fail-closed 曾把每个任务误挡
  // （VERIFY-RULE-004 多次刷群）。故降级为 inspectRuleChain：stale 时记 warning 继续，不再抛错。
  const ruleChain = inspectRuleChain({ cwd: repoRoot })
  if (!ruleChain.fresh) console.warn(`[lark-worker] ⚠ 规则链 stale（不阻断，继续执行）：${(ruleChain.failures || []).join('; ')}`)
  const ruleContext = buildFocusedRuleContext({
    taskText: task.text,
    hasImage: (task.attachments || []).some((item) => item?.type === 'image'),
    isFix: resolveCommandType(task).type === 'fix',
    ruleChain,
  })
  updateTaskAudit(auditContext, {
    status: executor === 'codex' ? 'analyzing' : 'running',
    rules: {
      scenario: ruleContext.scenario,
      scenarios: ruleContext.scenarios,
      signals: ruleContext.signals,
      fingerprint: ruleContext.fingerprint,
      ruleReleaseFingerprint: ruleContext.ruleReleaseFingerprint,
      effectiveRulesFingerprint: ruleContext.effectiveRulesFingerprint,
      sources: ruleContext.sources,
      warnings: ruleContext.warnings,
    },
  })

  const commonOptions = {
    executor,
    cwd,
    attachments: task.attachments || [],
    localConfig: workerConfig.localConfig,
    auditLogPath: auditContext?.logPath,
    // 只读命令（状态/status）：codex 用只读沙箱，绝不落任何写。
    readOnly: Boolean(workContext.readOnly),
    // 优雅退出信号：abort 时中断底层 AI 子进程（worker 收到 SIGTERM -> 交还任务 -> 杀 AI）。
    signal,
  }

  if (executor !== 'codex') {
    // ruleContext 必须随执行结果一并返回：task-runner 要把降级规则章节的 warnings 推到卡片/审计，
    // 否则辅助规则缺失只在此静默降级、群里看不到（A2）。codex 分支各 return 已带 ruleContext。
    const run = await execAiExecutor({
      ...commonOptions,
      promptText: buildTaskPrompt(workContext, task, executor, { ruleContext }),
    })
    return { ...run, ruleContext }
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
  // 阻塞分类：AI 的 blocked 结论不被覆写，只被归类。哪些类真的构成停机由 workKind 决定，
  // 分类明细进审计——「为什么这条 blocker 被放行/被保留」事后必须可追。
  const gate = resolveAnalysisGate({ task, analysis: analysisRun.result })
  const analysis = gate.analysis
  updateTaskAudit(auditContext, {
    analysis,
    workKind: gate.workKind,
    blockerClasses: gate.classified,
    suppressedBlockers: gate.suppressed,
    assumptions: gate.assumptions,
  })

  if (analysis.status === 'blocked') {
    const result = blockedResultFromAnalysis(analysis)
    updateTaskAudit(auditContext, { status: 'blocked', final: result })
    return { executor, result, analysis, ruleContext }
  }

  updateTaskAudit(auditContext, { status: 'implementing' })
  const implementationRun = await execAiExecutor({
    ...commonOptions,
    promptText: buildTaskPrompt(workContext, task, executor, { ruleContext, analysis }),
  })
  updateTaskAudit(auditContext, { status: implementationRun.result.status, final: implementationRun.result })
  return { ...implementationRun, analysis, ruleContext }
}
