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
import { AI_EXECUTORS, DEFAULT_EXECUTOR } from './lark-constants.mjs'
import { aiStatusMeta, FAILURE_KIND_LABELS, ROOT_CAUSE_LAYER_LABELS, TASK_STATE_LABELS, isOffFrontendRootCause } from './lark-status-meta.mjs'

const defaultAiTimeoutMs = Number(process.env.LARK_WORKER_AI_TIMEOUT_MS || process.env.LARK_WORKER_CODEX_TIMEOUT_MS || 1800000)
const intentClassificationTimeoutMs = Number(process.env.LARK_INTENT_CLASSIFIER_TIMEOUT_MS || 120000)
// 导出供 worker 启动断言用：AI 超时必须 < gateway 租约（否则孤儿回收会与活着的 AI 双跑）。
export const aiTimeoutMs = defaultAiTimeoutMs
// 瞬时 AI 错误自动重试的总尝试次数（含首发）：3 = 首发 + 2 次退避重试。仅对瞬时 API/网络错误生效。
const maxAiExecAttempts = Math.max(1, Number(process.env.LARK_AI_TRANSIENT_MAX_ATTEMPTS || 3))
const aiRetryBackoffMs = Math.max(0, Number(process.env.LARK_AI_TRANSIENT_BACKOFF_MS || 2000))

// 可 abort 的等待：退避期间若 worker 被打断/任务换代，立即结束不空等。
const delay = (ms, signal) =>
  new Promise((resolve) => {
    if (!(ms > 0)) return resolve()
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, ms)
    if (signal?.aborted) return onAbort()
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })

// claude/codex CLI 调底层 API 时的**瞬时**错误：连接中途断开、过载、限流、网关 5xx、网络抖动。
// 这类错误重跑大概率成功，不该像真·工具失败那样直接判 failed 逼人工重试。CLI 退出码统一是 1、
// 不带区分信息，故只能靠它打到 stdout/stderr 的原文识别（例：`API Error: Connection closed mid-response`）。
// 刻意不匹配裸 `api error`：400/401/403 等**永久性**API 错误重试无意义，只会白等三轮。
export const isTransientAiError = (text) => {
  const s = String(text || '').toLowerCase()
  if (!s) return false
  return /connection closed mid-response|connection (?:closed|reset)|socket hang up|econnreset|etimedout|enetunreach|eai_again|fetch failed|network error|overloaded|rate.?limit|too many requests|\b(?:429|500|502|503|504|529)\b|internal server error|bad gateway|service unavailable|gateway timeout|temporarily unavailable/.test(s)
}
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

const preflightedExecutors = new Map()

export const buildCodexReadinessCommand = ({ codexModel, codexReasoningEffort, cwd = tmpdir() } = {}) => ({
  cmd: 'codex',
  args: [
    '--ask-for-approval', 'never',
    'exec', '--ephemeral', '--skip-git-repo-check',
    ...(codexModel ? ['--model', codexModel] : []),
    ...(codexReasoningEffort ? ['--config', `model_reasoning_effort=${JSON.stringify(codexReasoningEffort)}`] : []),
    '--sandbox', 'read-only',
    '--cd', cwd,
    'This is a read-only readiness check. Reply with exactly: CODEX_MODEL_READY',
  ],
})

// Worker 启动时做 CLI/auth 预检；lark-bot restart 额外传 probeModel=true，真实验证指定模型可调用。
// 结果按 executor+模型档位缓存，任务领取时不会重复烧一次模型请求。
export const preflightAiExecutor = (executor, {
  codexModel,
  codexReasoningEffort,
  probeModel = false,
  cwd = tmpdir(),
} = {}) => {
  const key = [executor, codexModel || '', codexReasoningEffort || ''].join(':')
  const cached = preflightedExecutors.get(key)
  if (cached && (!probeModel || cached.modelProbe === 'passed')) return cached
  const version = spawnSync(executor, ['--version'], { encoding: 'utf8', stdio: 'pipe' })
  if (version.error || version.status !== 0) {
    throw new Error(`${executor} CLI 不可用：${version.error?.message || (version.stderr || version.stdout || '').trim() || `exit ${version.status}`}`)
  }
  if (executor === 'codex') {
    const auth = spawnSync('codex', ['login', 'status'], { encoding: 'utf8', stdio: 'pipe' })
    if (auth.error || auth.status !== 0) {
      throw new Error(`Codex 未登录：${auth.error?.message || (auth.stderr || auth.stdout || '').trim() || `exit ${auth.status}`}`)
    }
    if (probeModel) {
      const command = buildCodexReadinessCommand({ codexModel, codexReasoningEffort, cwd })
      const probe = spawnSync(command.cmd, command.args, { encoding: 'utf8', stdio: 'pipe', timeout: 120_000 })
      const output = `${probe.stdout || ''}\n${probe.stderr || ''}`
      if (probe.error || probe.status !== 0 || !output.includes('CODEX_MODEL_READY')) {
        throw new Error(
          `Codex 模型就绪检查失败（model=${codexModel || 'default'}, reasoning=${codexReasoningEffort || 'default'}）：` +
          `${probe.error?.message || output.trim().slice(-500) || `exit ${probe.status}`}`,
        )
      }
    }
  }
  const readiness = {
    ok: true,
    executor,
    model: executor === 'codex' ? (codexModel || 'default') : null,
    reasoningEffort: executor === 'codex' ? (codexReasoningEffort || 'default') : null,
    modelProbe: probeModel ? 'passed' : (cached?.modelProbe || 'not_run'),
    checkedAt: new Date().toISOString(),
  }
  preflightedExecutors.set(key, readiness)
  return readiness
}

const appendAudit = (auditLogPath, value) => {
  if (!auditLogPath) return
  mkdirSync(dirname(auditLogPath), { recursive: true })
  appendFileSync(auditLogPath, value)
}

// 执行器（codex/claude）不参与正文渲染——它已由卡片固定字段展示，故不作入参，避免误以为结果因执行器而不同。
export const formatStructuredAiResult = (result, { readOnly = false } = {}) => {
  const header = readOnly && (result.status === 'done' || result.status === 'done_with_warnings')
    ? '查询完成。'
    : aiStatusMeta(result.status).header
  // 群卡片给领导/PM 看，只保留高层信息：状态 + 结论 + 待补充 + 失败类型。
  // 执行器已由卡片固定字段展示，结果正文不再重复追加。
  // 落点/验证/下一步/文件等实现细节不上卡（仍在结构化结果与 worker 日志里），owner 也不再列一行——
  // 它单独传给 reportStatus 用于卡片 @ 责任人，展示成一行文字对群里是噪声。
  const lines = [header, `1. ${result.summary.trim()}`]
  let n = 2
  // 缺陷根因分诊（防线1/2）：结果带 rootCauseLayer / taskState 时上卡，向 PM/领导显式呈现根因层与诊断状态，
  // 让「后端根因、已转交」一目了然，杜绝前端凑数关单被误读成「前端已修好」。仅在字段存在时追加。
  const layerLabel = ROOT_CAUSE_LAYER_LABELS[result.rootCauseLayer]
  const stateLabel = TASK_STATE_LABELS[result.taskState]
  if (layerLabel || stateLabel) {
    const diag = []
    if (layerLabel) diag.push(`根因层 ${layerLabel}${isOffFrontendRootCause(result.rootCauseLayer) ? '（非前端，需对应端修复）' : ''}`)
    if (stateLabel) diag.push(`诊断状态 ${stateLabel}`)
    lines.push(`${n++}. 分诊：${diag.join('，')}`)
  }
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

  const effectiveTimeoutMs = resultKind === 'intent' ? intentClassificationTimeoutMs : defaultAiTimeoutMs
  // intent 分类走短超时、只读且高频，重试价值低、代价高：保持单发。其余任务对瞬时 API/网络错误自动重试。
  const maxAttempts = resultKind === 'intent' ? 1 : maxAiExecAttempts

  // 单次子进程执行：resolve 出本次 stdout；非零退出时把 stdout/stderr 尾部原文附到错误上并标注是否瞬时。
  const runAttempt = () =>
    new Promise((resolve, reject) => {
      const shouldCapture = Boolean(auditLogPath) || resultMode === 'stdout-structured'
      const stdio = shouldCapture
        ? [stdin == null ? 'inherit' : 'pipe', 'pipe', 'pipe']
        : stdin == null
          ? 'inherit'
          : ['pipe', 'inherit', 'inherit']
      const child = spawn(cmd, args, { cwd, stdio })
      let capturedStdout = ''
      // stdout+stderr 尾部（限长）：退出码统一为 1、不带信息，靠这段原文识别瞬时错误并附到失败卡。
      let capturedTail = ''
      const appendTail = (text) => {
        capturedTail = (capturedTail + text).slice(-2000)
      }
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
          const text = chunk.toString()
          capturedStdout += text
          appendTail(text)
          if (resultMode !== 'stdout-structured') process.stdout.write(chunk)
          appendAudit(auditLogPath, text)
        })
        child.stderr.on('data', (chunk) => {
          const text = chunk.toString()
          appendTail(text)
          process.stderr.write(chunk)
          appendAudit(auditLogPath, text)
        })
      }
      child.on('exit', (code) => {
        clearChildTimeout()
        if (aborted) return reject(new Error(`${executor} exec aborted（worker 退出或任务已取消/换代）`))
        if (timedOut) return reject(new Error(`${executor} exec timed out after ${effectiveTimeoutMs}ms`))
        if (code === 0) return resolve(capturedStdout)
        const tail = capturedTail.trim()
        const error = new Error(`${executor} exec exited with code ${code}${tail ? `：${tail.slice(-300)}` : ''}`)
        error.transient = isTransientAiError(capturedTail)
        reject(error)
      })
      if (stdin != null) {
        child.stdin.on('error', (error) => {
          if (error.code !== 'EPIPE') reject(error)
        })
        child.stdin.end(stdin)
      }
    })

  try {
    let capturedStdout = ''
    for (let attempt = 1; ; attempt++) {
      if (signal?.aborted) throw new Error(`${executor} exec aborted（worker 退出或任务已取消/换代）`)
      appendAudit(
        auditLogPath,
        `\n=== ${new Date().toISOString()} ${executor} ${resultKind}${attempt > 1 ? `（瞬时错误重试 ${attempt - 1}/${maxAttempts - 1}）` : ''} ===\n`,
      )
      try {
        capturedStdout = await runAttempt()
        break
      } catch (error) {
        // 仅**瞬时** AI-API/网络错误在上限内自动退避重试；abort/timeout/硬错误立即上抛，交由 worker 归因与人工重试。
        if (attempt < maxAttempts && error?.transient && !signal?.aborted) {
          const backoffMs = aiRetryBackoffMs * attempt
          console.warn(`[lark-worker] ${executor} 命中瞬时错误，退避 ${backoffMs}ms 后重试（第 ${attempt}/${maxAttempts} 次）：${String(error.message).slice(0, 160)}`)
          appendAudit(auditLogPath, `[retry] ${executor} transient error, backing off ${backoffMs}ms\n`)
          await delay(backoffMs, signal)
          continue
        }
        throw error
      }
    }
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
