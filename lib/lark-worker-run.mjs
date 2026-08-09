/**
 * Lark Worker 的 AI 编排层：装载 worker 本地配置、命令类任务的项目文档同步，
 * 以及按执行器分流的 AI 运行（claude 单趟；codex 走「只读分析 → 实施」两阶段并校验只读约束）。
 */

import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { repoRoot } from './lark-worker-env.mjs'
import { buildFocusedRuleContext } from './lark-rule-context.mjs'
import { isTestFeedbackTask } from './lark-message.mjs'
import { buildAnalysisPrompt, buildTaskPrompt } from './lark-worker-prompts.mjs'
import { execAiExecutor, resolveAiExecutor } from './lark-ai-executor.mjs'
import { snapshotWorktree } from './lark-worker-git.mjs'
import { updateTaskAudit } from './lark-worker-audit.mjs'
import { blockedResultFromAnalysis } from './lark-worker-results.mjs'

const SCOPE_OR_ACCESS_BLOCKER_RE = /(?:范围|scope|目标(?:页面|组件|模块|文件)|无法定位|不能定位|多个候选|哪(?:个|一)|跨项目|(?:越出|超出|不属于).{0,12}(?:当前项目|feature)|(?:扩大|新增|修改).{0,12}(?:公共|全局|共享)|访问|权限|凭证|下载失败|代码不存在|工作目录|附件.*(?:失败|不可用))/i

// 项目群与 bug 表测试反馈不再被 G2 / PRD / 历史门禁等流程材料卡住。Prompt 是第一层引导，
// 这里再做确定性兜底：只保留真正的范围歧义或访问阻塞，防模型再次死板复述流程门禁。
export const normalizeAnalysisForTask = (task, analysis) => {
  if (!isTestFeedbackTask(task) || analysis?.status !== 'blocked') return analysis
  const actionableBlockers = (analysis.blockers || []).filter((item) => SCOPE_OR_ACCESS_BLOCKER_RE.test(item))
  if (actionableBlockers.length) return { ...analysis, blockers: actionableBlockers }
  return {
    ...analysis,
    status: 'ready',
    summary: `${analysis.summary}；测试反馈已确认进入直接实施，不受 G2 或历史流程材料阻断。`,
    requirements: [...(analysis.requirements || []), '严格限定在群反馈可定位的修改范围内，不扩大到相邻功能'],
    blockers: [],
  }
}

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
  const syncScript = join(repoRoot, 'apps/web/docs_tdd', projectId, 'agent/scripts/sync-lark-docs.mjs')
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

export const runAI = async (workerConfig, task, workContext, auditContext, signal) => {
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
    // 优雅退出信号：abort 时中断底层 AI 子进程（worker 收到 SIGTERM → 交还任务 → 杀 AI）。
    signal,
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
  const analysis = normalizeAnalysisForTask(task, analysisRun.result)
  updateTaskAudit(auditContext, { analysis })

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
