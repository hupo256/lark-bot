/**
 * Lark Worker 的 AI 编排层：装载 worker 本地配置，
 * 以及 AI 运行：非只读任务不分执行器一律「只读分析（输出范围契约 scope）→ 实施」两阶段并校验只读约束；
 * 只读查询 claude/pi/cursor 单趟。
 * bug 表修复任务在此之前统一先跑只读分诊（lark-triage），只有判定 frontend_fix 才进入上述流程。
 */

import { readFileSync } from 'node:fs'
import { larkBotRoot, repoRoot } from './lark-worker-env.mjs'
import { resolveFromLarkBotRoot } from './lark-paths.mjs'
import { buildFocusedRuleContext, readRuleRevisions, stripAutoLoadedRules } from './lark-rule-context.mjs'
import { resolveCommandType } from './lark-message.mjs'
import { expectsCodeChange, resolveAnalysisGate, resolveWorkKind } from './lark-work-policy.mjs'
import { applyScopeApprovals, resolveLineBudget } from './lark-scope-contract.mjs'
import { buildAnalysisPrompt, buildIntentClassificationPrompt, buildTaskPrompt, buildTriagePrompt } from './lark-worker-prompts.mjs'
import { execAiExecutor, resolveAiExecutor, resolveAiModelConfig } from './lark-ai-executor.mjs'
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

// deps 仅供单测注入 mock 执行器 / 快照（不起真实 AI CLI、不读真实 git）；生产调用不传。
export const runAI = async (workerConfig, task, workContext, auditContext, signal, { exec = execAiExecutor, snapshot = snapshotWorktree } = {}) => {
  const executor = resolveAiExecutor(workerConfig, task)
  const cwd = workContext.cwd || repoRoot
  // 只取规则来源版本（~/.ai-rules 与 lark-bot 仓库的 git HEAD）用于审计/AI 上下文注入，不判 stale：
  // 拆仓后不再读 docs_tdd 引擎的发布指纹，版本号足以事后还原当次注入的规则原文。
  const ruleRevisions = readRuleRevisions()
  const ruleContext = buildFocusedRuleContext({
    taskText: task.text,
    hasImage: (task.attachments || []).some((item) => item?.type === 'image'),
    isFix: resolveCommandType(task).type === 'fix',
    ruleRevisions,
  })
  // claude 会自动加载 CLAUDE.md / ~/.ai-rules/AGENT.md：提示里不再重复这些章节（审计仍记完整 sources）。
  const promptRules = executor === 'claude' ? stripAutoLoadedRules(ruleContext) : ruleContext
  updateTaskAudit(auditContext, {
    status: executor === 'codex' || !workContext.readOnly ? 'analyzing' : 'running',
    rules: {
      omittedAutoLoaded: promptRules.omittedAutoLoaded || [],
      scenario: ruleContext.scenario,
      scenarios: ruleContext.scenarios,
      signals: ruleContext.signals,
      fingerprint: ruleContext.fingerprint,
      aiRulesRevision: ruleContext.aiRulesRevision,
      larkBotRevision: ruleContext.larkBotRevision,
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
    const beforeTriage = snapshot(cwd)
    const triageRun = await exec({
      ...commonOptions,
      promptText: buildTriagePrompt(workContext, task, formatTriageFacts(facts)),
      resultKind: 'triage',
    })
    const afterTriage = snapshot(cwd)
    if (beforeTriage.status !== afterTriage.status || beforeTriage.diff !== afterTriage.diff) {
      throw new Error(`${executor} 分诊阶段违反只读约束：git status/diff 在分诊前后发生变化，已停止实施`)
    }
    const triage = triageRun.result
    const outcome = resolveTriageOutcome(triage)
    updateTaskAudit(auditContext, { triage, triageFacts: facts, triageProceed: outcome.proceed })
    console.log(`[lark-worker] ${task.id} 分诊判定 ${triage.verdict}${outcome.proceed ? '，进入实施' : '，不改代码'}：${triage.summary}`)
    if (!outcome.proceed) {
      updateTaskAudit(auditContext, { status: outcome.result.status, final: outcome.result })
      return { executor, result: outcome.result, triage, ruleContext, scope: null }
    }
    triageForImplementation = triage
  }

  // 只读分析阶段（范围契约）：所有执行器在非只读任务上都先只读分析、输出结构化 scope，再实施。
  // 只读命令任务（状态查询）不改文件、无需契约，claude/pi/cursor 仍单趟；codex 保持原有两阶段不变。
  // 分诊已判 frontend_fix 的 bug 表任务同样继续走「分析 → 实施」。
  const needsAnalysis = executor === 'codex' || !workContext.readOnly
  if (!needsAnalysis) {
    // ruleContext 必须随执行结果一并返回：task-runner 要把降级规则章节的 warnings 推到卡片/审计，
    // 否则辅助规则缺失只在此静默降级、群里看不到（A2）。
    const run = await exec({
      ...commonOptions,
      promptText: buildTaskPrompt(workContext, task, executor, { ruleContext: promptRules, triage: triageForImplementation }),
    })
    return { ...run, ruleContext, scope: null }
  }

  // 收尾只对会改代码的任务核对契约（与 task-runner 同一判据）；文档 / 自测 / 只读任务不向 AI 宣称「越界不提交」。
  const scopeEnforced = expectsCodeChange({ task, readOnly: workContext.readOnly })
  // 行数上限按 workKind 取（本机 scopeBudgets 覆盖默认值）；分析与实施两段提示用同一个数，与收尾核对同口径。
  const lineLimit = scopeEnforced ? resolveLineBudget(resolveWorkKind(task), workerConfig.localConfig?.scopeBudgets) : null
  const beforeAnalysis = snapshot(cwd)
  const analysisRun = await exec({
    ...commonOptions,
    promptText: buildAnalysisPrompt(workContext, task, promptRules, { lineLimit, scopeEnforced }),
    resultKind: 'analysis',
  })
  const afterAnalysis = snapshot(cwd)
  if (beforeAnalysis.status !== afterAnalysis.status || beforeAnalysis.diff !== afterAnalysis.diff) {
    throw new Error(`${executor} 分析阶段违反只读约束：git status/diff 在分析前后发生变化，已停止实施`)
  }
  // 阻塞分类：AI 的 blocked 结论不被覆写，只被归类。哪些类真的构成停机由 workKind 决定，
  // 分类明细进审计——「为什么这条 blocker 被放行/被保留」事后必须可追。
  const gate = resolveAnalysisGate({ task, analysis: analysisRun.result })
  const analysis = gate.analysis
  // 范围契约只认分析阶段这一份（实施阶段自报的不算）；task-runner 收尾用它核对实测改动。
  const scope = analysis?.scope ?? null
  updateTaskAudit(auditContext, {
    analysis,
    scope,
    workKind: gate.workKind,
    blockerClasses: gate.classified,
    suppressedBlockers: gate.suppressed,
    assumptions: gate.assumptions,
  })

  if (analysis.status === 'blocked') {
    const result = blockedResultFromAnalysis(analysis)
    updateTaskAudit(auditContext, { status: 'blocked', final: result })
    return { executor, result, analysis, ruleContext, scope }
  }

  updateTaskAudit(auditContext, { status: 'implementing' })
  const promptOptions = {
    ruleContext: promptRules,
    analysis,
    triage: triageForImplementation,
    // 有效契约 = 分析阶段 scope ∪ 人工已批准扩大的文件；行数上限按本机 scopeBudgets 覆盖默认值。
    scopeContract: scopeEnforced ? { scope: applyScopeApprovals(scope, task.scopeApprovals), lineLimit } : null,
  }
  // 实施续分析的会话：同一执行器、同一模型才续；提示用增量版（任务正文 / 规则已在会话里），续不上回退完整提示。
  const modelCfg = resolveAiModelConfig(workerConfig.localConfig, executor)
  const canResume = executor === 'claude' && Boolean(analysisRun.sessionId) && (modelCfg?.analysisModel || null) === (modelCfg?.model || null)
  const fullPrompt = buildTaskPrompt(workContext, task, executor, promptOptions)
  const implementationRun = await exec({
    ...commonOptions,
    promptText: canResume ? buildTaskPrompt(workContext, task, executor, { ...promptOptions, followUp: true }) : fullPrompt,
    resumeSessionId: canResume ? analysisRun.sessionId : null,
    fallbackPromptText: canResume ? fullPrompt : null,
  })
  updateTaskAudit(auditContext, {
    status: implementationRun.result.status,
    final: implementationRun.result,
    implementation: { resumedSession: implementationRun.resumedSession || null, resumeFallback: Boolean(implementationRun.resumeFallback), analysisSessionId: analysisRun.sessionId || null },
  })
  return { ...implementationRun, analysis, ruleContext, scope }
}
