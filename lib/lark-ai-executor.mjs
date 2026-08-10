/**
 * Lark Worker 的 AI executor 适配层：选择优先级、命令边界、CLI 预检与 Codex 结构化结果。
 * 只允许 claude/codex 固定枚举，任何 Lark/config 输入都不能变成任意命令。
 */

import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { docsSystemRoot } from '../../engine/agent-scripts/lib/roots.mjs'
import {
  buildClaudeResultFileInstruction,
  parseStructuredAiResult,
  parseStructuredAnalysisResult,
  parseStructuredIntentResult,
} from './lark-ai-result.mjs'
import { aiStatusMeta } from './lark-status-meta.mjs'

const AI_EXECUTORS = new Set(['claude', 'codex'])
const DEFAULT_EXECUTOR = 'claude'
const defaultAiTimeoutMs = Number(process.env.LARK_WORKER_AI_TIMEOUT_MS || process.env.LARK_WORKER_CODEX_TIMEOUT_MS || 1800000)
const intentClassificationTimeoutMs = Number(process.env.LARK_INTENT_CLASSIFIER_TIMEOUT_MS || 120000)
// 导出供 worker 启动断言用：AI 超时必须 < gateway 租约（否则孤儿回收会与活着的 AI 双跑）。
export const aiTimeoutMs = defaultAiTimeoutMs
const codexResultSchema = join(docsSystemRoot, 'common/lark-bot/schemas/lark-ai-result.schema.json')
const codexAnalysisSchema = join(docsSystemRoot, 'common/lark-bot/schemas/lark-ai-analysis.schema.json')
const intentClassificationSchema = join(docsSystemRoot, 'common/lark-bot/schemas/lark-intent-classification.schema.json')
const intentClassificationSchemaText = readFileSync(intentClassificationSchema, 'utf8')
// codex workspace-write 沙箱默认只放行 cwd（worktree）。但 `apps/web/docs_tdd` 是指向本 docs 仓
// (docsSystemRoot) 的软链、落在 worktree 之外，登记文档写入会被 seatbelt 拒（patch: failed → 权限失败）。
// 把 docsSystemRoot 真实路径加进 writable_roots，codex 才能合规写 docs_tdd/<PR>/product/*.md。
// realpath 兜底：symlink/大小写卷等情况下 seatbelt 按规范路径判定。
const codexDocsWritableRoot = (() => {
  try {
    return realpathSync(docsSystemRoot)
  } catch {
    return docsSystemRoot
  }
})()

export const validateAiExecutor = (value, source = 'AI executor') => {
  const normalized = String(value || '').trim().toLowerCase()
  if (!AI_EXECUTORS.has(normalized)) throw new Error(`${source} must be one of: claude, codex`)
  return normalized
}

// task > 环境变量 > 本机 bot 配置 > wrapper 默认 > claude。
export const resolveAiExecutor = (workerConfig, task, env = process.env) => {
  const candidates = [
    [task.aiExecutor, 'task.aiExecutor'],
    [env.LARK_AI_EXECUTOR, 'LARK_AI_EXECUTOR'],
    [workerConfig.localConfig?.aiExecutor, 'config.aiExecutor'],
    [workerConfig.aiExecutor, 'worker aiExecutor'],
    [DEFAULT_EXECUTOR, 'default AI executor'],
  ]
  const [value, source] = candidates.find(([candidate]) => candidate != null && String(candidate).trim())
  return validateAiExecutor(value, source)
}

export const buildAiExecutorCommand = ({
  executor,
  promptText,
  cwd,
  resultPath,
  attachments = [],
  codexModel,
  codexReasoningEffort,
  resultKind = 'task',
  readOnly = false,
}) => {
  if (executor === 'codex') {
    const imageArgs = attachments
      .filter((item) => item.type === 'image' && item.localPath && existsSync(item.localPath))
      .flatMap((item) => ['--image', item.localPath])
    const workspaceWrite = !(resultKind === 'analysis' || readOnly)
    return {
      cmd: 'codex',
      args: [
        '--ask-for-approval', 'never',
        'exec', '--ephemeral',
        ...(codexModel ? ['--model', codexModel] : []),
        ...(codexReasoningEffort ? ['--config', `model_reasoning_effort=${JSON.stringify(codexReasoningEffort)}`] : []),
        '--sandbox', workspaceWrite ? 'workspace-write' : 'read-only',
        '-c', 'sandbox_workspace_write.network_access=false',
        // 仅 workspace-write 时放行 docs_tdd 软链目标，read-only 阶段无写、无需加。
        ...(workspaceWrite ? ['-c', `sandbox_workspace_write.writable_roots=${JSON.stringify([codexDocsWritableRoot])}`] : []),
        '--cd', cwd,
        '--output-schema', resultKind === 'analysis'
          ? codexAnalysisSchema
          : resultKind === 'intent'
            ? intentClassificationSchema
            : codexResultSchema,
        '--output-last-message', resultPath,
        ...imageArgs,
        '-',
      ],
      stdin: promptText,
      resultMode: 'structured',
    }
  }
  if (executor === 'claude') {
    // @负责人消息的前置分类必须是严格只读：只开放 Read（便于识别已下载截图），plan 模式禁写，
    // 结构化结果直接走 stdout，不要求 Claude 写临时结果文件。
    if (resultKind === 'intent') {
      return {
        cmd: 'claude',
        args: [
          '-p',
          '--permission-mode', 'plan',
          '--tools', 'Read',
          '--no-session-persistence',
          '--json-schema', intentClassificationSchemaText,
          '--output-format', 'json',
          promptText,
        ],
        stdin: null,
        resultMode: 'stdout-structured',
      }
    }
    return {
      cmd: 'claude',
      args: ['-p', '--dangerously-skip-permissions', promptText],
      stdin: null,
      // claude 与 codex 同构：不自调 Gateway，把结构化结果写进 resultPath（写入指令由 prompt 末尾注入），
      // Worker 解析后用正确 epoch 统一回写。彻底去掉旧的 gateway-callback（claude 无从得知运行时 epoch/密钥）。
      resultMode: 'structured',
    }
  }
  throw new Error(`unknown AI executor: ${executor} (expected claude or codex)`)
}

const preflightedExecutors = new Set()
export const preflightAiExecutor = (executor) => {
  if (preflightedExecutors.has(executor)) return
  const version = spawnSync(executor, ['--version'], { encoding: 'utf8', stdio: 'pipe' })
  if (version.error || version.status !== 0) {
    throw new Error(`${executor} CLI 不可用：${version.error?.message || (version.stderr || version.stdout || '').trim() || `exit ${version.status}`}`)
  }
  if (executor === 'codex') {
    const auth = spawnSync('codex', ['login', 'status'], { encoding: 'utf8', stdio: 'pipe' })
    if (auth.error || auth.status !== 0) {
      throw new Error(`Codex 未登录：${auth.error?.message || (auth.stderr || auth.stdout || '').trim() || `exit ${auth.status}`}`)
    }
  }
  preflightedExecutors.add(executor)
}

const appendAudit = (auditLogPath, value) => {
  if (!auditLogPath) return
  mkdirSync(dirname(auditLogPath), { recursive: true })
  appendFileSync(auditLogPath, value)
}

export const FAILURE_KIND_LABELS = {
  tool: '工具失败',
  env: '环境失败',
  permission: '权限失败',
  requirement: '需求不清',
}

export const formatStructuredAiResult = (result, executor = 'codex') => {
  const header = aiStatusMeta(result.status).header
  // 群卡片给领导/PM 看，只保留高层信息：状态 + 结论 + 执行器 + 待补充 + 失败类型。
  // 落点/验证/下一步/文件等实现细节不上卡（仍在结构化结果与 worker 日志里），owner 也不再列一行——
  // 它单独传给 reportStatus 用于卡片 @ 责任人，展示成一行文字对群里是噪声。
  const lines = [header, `1. ${result.summary.trim()}`, `2. 执行器：${executor}`]
  let n = 3
  if (result.status === 'failed' && result.failureKind) {
    lines.push(`${n++}. 失败类型：${FAILURE_KIND_LABELS[result.failureKind] || result.failureKind}`)
  }
  if ((result.status === 'waiting_confirmation' || result.status === 'blocked') && Array.isArray(result.blockers) && result.blockers.length) {
    lines.push(`${n++}. 待补充：${result.blockers.join('；')}`)
  }
  if (result.status === 'done_with_warnings' && Array.isArray(result.warnings) && result.warnings.length) {
    lines.push(`${n++}. 验证提醒：${result.warnings.join('；')}`)
  }
  return lines.join('\n')
}

export const execAiExecutor = async ({
  executor,
  promptText,
  cwd,
  attachments = [],
  codexModel,
  codexReasoningEffort,
  resultKind = 'task',
  readOnly = false,
  auditLogPath,
  signal,
}) => {
  const resultDir = mkdtempSync(join(tmpdir(), `lark-${executor}-result-`))
  const resultPath = join(resultDir, 'result.json')
  // codex 用 --output-schema/--output-last-message 落盘；claude CLI 无此开关，改由 prompt 末尾指示它写入 resultPath。
  const effectivePrompt = executor === 'claude' && resultKind !== 'intent'
    ? `${promptText}\n\n${buildClaudeResultFileInstruction(resultPath)}`
    : promptText
  const { cmd, args, stdin, resultMode } = buildAiExecutorCommand({
    executor,
    promptText: effectivePrompt,
    cwd,
    resultPath,
    attachments,
    codexModel,
    codexReasoningEffort,
    resultKind,
    readOnly,
  })

  try {
    appendAudit(auditLogPath, `\n=== ${new Date().toISOString()} ${executor} ${resultKind} ===\n`)
    let capturedStdout = ''
    const effectiveTimeoutMs = resultKind === 'intent' ? intentClassificationTimeoutMs : defaultAiTimeoutMs
    await new Promise((resolve, reject) => {
      const shouldCapture = Boolean(auditLogPath) || resultMode === 'stdout-structured'
      const stdio = shouldCapture
        ? [stdin == null ? 'inherit' : 'pipe', 'pipe', 'pipe']
        : stdin == null
          ? 'inherit'
          : ['pipe', 'inherit', 'inherit']
      const child = spawn(cmd, args, { cwd, stdio })
      let timedOut = false
      let aborted = false
      let killTimer = null
      const timeout = Number.isFinite(effectiveTimeoutMs) && effectiveTimeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            child.kill('SIGTERM')
            killTimer = setTimeout(() => child.kill('SIGKILL'), 10000)
          }, effectiveTimeoutMs)
        : null
      // worker 优雅退出：abort 时中断 AI 子进程（SIGTERM，2s 内未退再 SIGKILL）。2s 宽限 < worker 侧
      // 收尾等待，确保子进程在 worker exit 前真正死掉，不会变孤儿继续改 worktree 与新一代 AI 双跑。
      const onAbort = () => {
        aborted = true
        child.kill('SIGTERM')
        killTimer = setTimeout(() => child.kill('SIGKILL'), 2000)
      }
      const clearChildTimeout = () => {
        if (timeout) clearTimeout(timeout)
        if (killTimer) clearTimeout(killTimer)
        signal?.removeEventListener('abort', onAbort)
      }
      if (signal?.aborted) onAbort()
      else signal?.addEventListener('abort', onAbort, { once: true })
      child.on('error', (error) => {
        clearChildTimeout()
        reject(error)
      })
      if (shouldCapture) {
        child.stdout.on('data', (chunk) => {
          capturedStdout += chunk.toString()
          if (resultMode !== 'stdout-structured') process.stdout.write(chunk)
          appendAudit(auditLogPath, chunk.toString())
        })
        child.stderr.on('data', (chunk) => {
          process.stderr.write(chunk)
          appendAudit(auditLogPath, chunk.toString())
        })
      }
      child.on('exit', (code) => {
        clearChildTimeout()
        if (aborted) return reject(new Error(`${executor} exec aborted（worker 优雅退出，交还任务重领）`))
        if (timedOut) return reject(new Error(`${executor} exec timed out after ${effectiveTimeoutMs}ms`))
        if (code === 0) return resolve()
        reject(new Error(`${executor} exec exited with code ${code}`))
      })
      if (stdin != null) {
        child.stdin.on('error', (error) => {
          if (error.code !== 'EPIPE') reject(error)
        })
        child.stdin.end(stdin)
      }
    })
    if (resultMode === 'stdout-structured') {
      let envelope
      try {
        envelope = JSON.parse(capturedStdout)
      } catch (error) {
        throw new Error(`${executor} 未返回合法 JSON envelope：${error.message}`)
      }
      return { executor, result: parseStructuredIntentResult(envelope.structured_output ?? envelope.result, executor) }
    }
    if (resultMode !== 'structured') return { executor, result: null }
    if (resultKind === 'analysis') return { executor, result: parseStructuredAnalysisResult(resultPath) }
    if (resultKind === 'intent') {
      return { executor, result: parseStructuredIntentResult(readFileSync(resultPath, 'utf8'), executor) }
    }
    return { executor, result: parseStructuredAiResult(resultPath, executor) }
  } finally {
    rmSync(resultDir, { recursive: true, force: true })
  }
}
