/**
 * Lark Worker 的 AI 编排层：装载 worker 本地配置、命令类任务的项目文档同步，
 * 以及按执行器分流的 AI 运行（claude/pi/cursor 单趟；codex 走「只读分析 → 实施」两阶段并校验只读约束）。
 * bug 表修复任务在此之前统一先跑只读分诊（lark-triage），只有判定 frontend_fix 才进入上述流程。
 */

import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readRuleFingerprints } from '../../engine/agent-scripts/lib/rule-chain-runtime.mjs'
import { larkBotRoot, repoRoot } from './lark-worker-env.mjs'
import { resolveFromLarkBotRoot, resolveLegacyProjectRoot } from './lark-paths.mjs'
import { buildFocusedRuleContext } from './lark-rule-context.mjs'
import { resolveCommandType } from './lark-message.mjs'
import { resolveAnalysisGate } from './lark-work-policy.mjs'
import { buildAnalysisPrompt, buildIntentClassificationPrompt, buildTaskPrompt, buildTriagePrompt } from './lark-worker-prompts.mjs'
import { execAiExecutor, resolveAiExecutor } from './lark-ai-executor.mjs'
import { snapshotWorktree } from './lark-worker-git.mjs'
import { updateTaskAudit } from './lark-worker-audit.mjs'
import { blockedResultFromAnalysis } from './lark-worker-results.mjs'
import { collectTriageFacts, formatTriageFacts, resolveTriageOutcome, shouldRunTriage } from './lark-triage.mjs'

// 测试反馈类任务不该被 G2 / PRD / 历史门禁等流程材料卡住，但「一律放行」同样错。
// 判定已下沉到 lark-work-policy.mjs：按 hard / soft / decision / process 四类归类 AI 给出的
// blockers，再由 workKind 决定哪些类构成停机理由；soft / decision 转成显式假设随实施 prompt 下发。
// 这里只保留一层薄适配（旧签名 (task, analysis) → analysis），供既有调用点与单测使用。
export const normalizeAnalysisForTask = (task, analysis) => resolveAnalysisGate({ task, analysis }).analysis

export const loadWorkerLocalConfig = (configPath) => {
  if (!configPath) return {}
  // 入口包装传的是锚定 larkRuntimeDir 的绝对路径；相对路径（手工调用）按本仓根解析，不再依赖业务主仓 cwd。
  const absolutePath = resolveFromLarkBotRoot(configPath)
  try {
    return JSON.parse(readFileSync(absolutePath, 'utf8'))
  } catch (error) {
    throw new Error(`worker config 读取失败（${absolutePath}）：${error.message}`)
  }
}

// 命令类任务（状态/文档/修复/自测/api/qa）开发前先同步项目文档；项目无同步脚本则跳过。
// 同步脚本只存在于存量 docs_tdd 项目（prds/<PR>/agent/scripts/），故走 resolveLegacyProjectRoot（含 v2 的
// active-change 指针）；未配置 legacyPrdsRoot 时直接跳过，prd-to-commit 新项目本就没有这个脚本。
export const runProjectDocSync = async ({ projectId }) => {
  const projectRoot = resolveLegacyProjectRoot(projectId)
  if (!projectRoot) return { skipped: true, reason: 'legacy prds root not configured' }
  const syncScript = join(projectRoot, 'agent/scripts/sync-lark-docs.mjs')
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

// 只 @ 负责人的消息先在 lark-bot 仓根目录做严格只读意图分类；不装 worktree、不读项目规则、不触碰业务代码。
// cwd 取 larkBotRoot：附件落在 runtime/lark-attachments/ 下，claude plan 模式只放行 Read 也能读到截图。
export const classifyTaskIntent = async (workerConfig, task, auditContext, signal) => {
  const executor = resolveAiExecutor(workerConfig, task)
  updateTaskAudit(auditContext, { status: 'classifying_intent' })
  const run = await execAiExecutor({
    executor,
    promptText: buildIntentClassificationPrompt(task),
    cwd: larkBotRoot,
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
  // 只取当前规则指纹用于审计/AI 上下文注入，不再判 stale：规则消费已切 pin-based，发布层是否 == 源
  // 对在飞任务无影响，旧 stale 检测退化成 fameex-web AGENTS.md 漂移的狼来了噪音，已下线。
  const ruleChain = readRuleFingerprints({ cwd: repoRoot })
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

  let triageForImplementation = null
  if (shouldRunTriage(task, workContext)) {
    updateTaskAudit(auditContext, { status: 'triaging' })
    const facts = collectTriageFacts({ cwd, task })
    const beforeTriage = snapshotWorktree(cwd)
    const triageRun = await execAiExecutor({
      ...commonOptions,
      promptText: buildTriagePrompt(workContext, task, formatTriageFacts(facts)),
      resultKind: 'triage',
    })
    const afterTriage = snapshotWorktree(cwd)
    if (beforeTriage.status !== afterTriage.status || beforeTriage.diff !== afterTriage.diff) {
      throw new Error(`${executor} 分诊阶段违反只读约束：git status/diff 在分诊前后发生变化，已停止实施`)
    }
    const triage = triageRun.result
    const outcome = resolveTriageOutcome(triage)
    updateTaskAudit(auditContext, { triage, triageFacts: facts, triageProceed: outcome.proceed })
    console.log(`[lark-worker] ${task.id} 分诊判定 ${triage.verdict}${outcome.proceed ? '，进入实施' : '，不改代码'}：${triage.summary}`)
    if (!outcome.proceed) {
      updateTaskAudit(auditContext, { status: outcome.result.status, final: outcome.result })
      return { executor, result: outcome.result, triage, ruleContext }
    }
    triageForImplementation = triage
  }

  if (executor !== 'codex') {
    // ruleContext 必须随执行结果一并返回：task-runner 要把降级规则章节的 warnings 推到卡片/审计，
    // 否则辅助规则缺失只在此静默降级、群里看不到（A2）。codex 分支各 return 已带 ruleContext。
    const run = await execAiExecutor({
      ...commonOptions,
      promptText: buildTaskPrompt(workContext, task, executor, { ruleContext, triage: triageForImplementation }),
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
    promptText: buildTaskPrompt(workContext, task, executor, { ruleContext, analysis, triage: triageForImplementation }),
  })
  updateTaskAudit(auditContext, { status: implementationRun.result.status, final: implementationRun.result })
  return { ...implementationRun, analysis, ruleContext }
}
