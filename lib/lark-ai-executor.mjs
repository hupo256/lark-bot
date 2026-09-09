/**
 * Lark Worker 的 AI executor 适配层：选择优先级、命令边界、CLI 预检与结构化结果。
 * 只允许已知 CLI 执行器固定枚举，任何 Lark/config 输入都不能变成任意命令。
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
// Pi text 模式只在最终答案时输出，provider/工具卡死期间审计日志会一直为空。改走 JSON 事件流后，
// 用空闲超时识别「进程还活着但已无任何事件」的假运行，并交给瞬时错误重试；总超时仍是最终硬上限。
const piIdleTimeoutMs = Math.max(0, Number(process.env.LARK_PI_IDLE_TIMEOUT_MS || 300000))
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

// 各 Agent CLI 调底层 API 时的**瞬时**错误：连接中途断开、过载、限流、网关 5xx、网络抖动。
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
  if (!AI_EXECUTORS.has(normalized)) throw new Error(`${source} must be one of: ${[...AI_EXECUTORS].join(', ')}`)
  return normalized
}

// task > 本机 bot 配置 > wrapper 默认 > 内置默认值。执行器切换只允许走任务或显式配置，
// 不读取进程环境变量，避免 launchd/终端残留环境让实际执行器与配置文件不一致。
export const resolveAiExecutor = (workerConfig, task) => {
  const candidates = [
    [task.aiExecutor, 'task.aiExecutor'],
    [workerConfig.localConfig?.aiExecutor, 'config.aiExecutor'],
    [workerConfig.aiExecutor, 'worker aiExecutor'],
    [DEFAULT_EXECUTOR, 'default AI executor'],
  ]
  const [value, source] = candidates.find(([candidate]) => candidate != null && String(candidate).trim())
  return validateAiExecutor(value, source)
}

// 部分执行器名称（用户侧）与本地 CLI 二进制名称不一致，统一在这里映射，避免散落各处。
export const resolveAiExecutorBinary = (executor) => {
  switch (executor) {
    case 'pi':
      return 'pi'
    case 'cursor':
      return 'cursor-agent'
    default:
      return executor
  }
}

// 各执行器在本地配置里的模型/推理强度/Provider 键名不同；缺省时返回空，由 CLI 自己决定默认值。
export const resolveAiModelConfig = (localConfig, executor) => {
  if (!localConfig || typeof localConfig !== 'object') return { model: null, reasoningEffort: null, provider: null }
  switch (executor) {
    case 'codex':
      return { model: localConfig.codexModel, reasoningEffort: localConfig.codexReasoningEffort, provider: null }
    case 'pi':
      return { model: localConfig.piModel, reasoningEffort: localConfig.piReasoningEffort, provider: localConfig.piProvider }
    case 'cursor':
      return { model: localConfig.cursorModel, reasoningEffort: null, provider: null }
    case 'claude':
    default:
      return { model: localConfig.model, reasoningEffort: localConfig.reasoningEffort, provider: null }
  }
}

export const buildAiExecutorCommand = ({
  executor,
  promptText,
  cwd,
  resultPath,
  attachments = [],
  model,
  reasoningEffort,
  provider,
  codexModel,
  codexReasoningEffort,
  resultKind = 'task',
  readOnly = false,
}) => {
  // 兼容旧调用点传入的 codexModel/codexReasoningEffort；新执行器走通用 model/reasoningEffort。
  const m = model ?? codexModel
  const re = reasoningEffort ?? codexReasoningEffort
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
        ...(m ? ['--model', m] : []),
        ...(re ? ['--config', `model_reasoning_effort=${JSON.stringify(re)}`] : []),
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
  // Pi/Cursor 都是带工具循环的 Agent CLI，统一用「prompt 指示写入 resultPath + Worker 读盘」的结构化模式。
  if (executor === 'pi') {
    const fileArgs = attachments
      .filter((item) => item.type === 'image' && item.localPath && existsSync(item.localPath))
      .flatMap((item) => [`@${item.localPath}`])
    return {
      cmd: resolveAiExecutorBinary('pi'),
      args: [
        '--print',
        '--no-session',
        // 事件流供 Worker 做空闲超时与审计；最终业务结果仍由模型写 resultPath。
        '--mode', 'json',
        ...(provider ? ['--provider', provider] : []),
        ...(m ? ['--model', m] : []),
        ...(re ? ['--thinking', re] : []),
        '--',
        ...fileArgs,
        promptText,
      ],
      stdin: null,
      resultMode: 'structured',
      eventStream: true,
    }
  }
  if (executor === 'cursor') {
    return {
      cmd: resolveAiExecutorBinary('cursor'),
      args: [
        '--print',
        '--trust',
        '--yolo',
        '--workspace', cwd,
        '--skip-worktree-setup',
        '--sandbox', 'enabled',
        ...(m ? ['--model', m] : []),
        promptText,
      ],
      stdin: null,
      resultMode: 'structured',
    }
  }
  throw new Error(`unknown AI executor: ${executor} (expected ${[...AI_EXECUTORS].join(', ')})`)
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

export const buildPiReadinessCommand = ({ provider, model, reasoningEffort } = {}) => ({
  cmd: resolveAiExecutorBinary('pi'),
  args: [
    '--print', '--no-session', '--mode', 'text', '--no-tools',
    ...(provider ? ['--provider', provider] : []),
    ...(model ? ['--model', model] : []),
    ...(reasoningEffort ? ['--thinking', reasoningEffort] : []),
    '--', 'Reply with exactly: PI_MODEL_READY',
  ],
})

// Worker 启动时做 CLI/auth 预检；lark-bot restart 额外传 probeModel=true，真实验证指定模型可调用。
// 结果按 executor+模型档位缓存，任务领取时不会重复烧一次模型请求。
export const preflightAiExecutor = (executor, {
  localConfig,
  model,
  reasoningEffort,
  codexModel,
  codexReasoningEffort,
  probeModel = false,
  cwd = tmpdir(),
} = {}) => {
  const cfg = resolveAiModelConfig(localConfig, executor)
  const m = cfg?.model || model || codexModel
  const re = cfg?.reasoningEffort || reasoningEffort || codexReasoningEffort
  const key = [executor, cfg?.provider || '', m || '', re || ''].join(':')
  const cached = preflightedExecutors.get(key)
  if (cached && (!probeModel || cached.modelProbe === 'passed')) return cached

  const cmd = resolveAiExecutorBinary(executor)
  const version = spawnSync(cmd, ['--version'], { encoding: 'utf8', stdio: 'pipe' })
  if (version.error || version.status !== 0) {
    throw new Error(`${cmd} CLI 不可用：${version.error?.message || (version.stderr || version.stdout || '').trim() || `exit ${version.status}`}`)
  }

  if (executor === 'codex') {
    const auth = spawnSync('codex', ['login', 'status'], { encoding: 'utf8', stdio: 'pipe' })
    if (auth.error || auth.status !== 0) {
      throw new Error(`Codex 未登录：${auth.error?.message || (auth.stderr || auth.stdout || '').trim() || `exit ${auth.status}`}`)
    }
    if (probeModel) {
      const command = buildCodexReadinessCommand({ codexModel: m, codexReasoningEffort: re, cwd })
      const probe = spawnSync(command.cmd, command.args, { encoding: 'utf8', stdio: 'pipe', timeout: 120_000 })
      const output = `${probe.stdout || ''}\n${probe.stderr || ''}`
      if (probe.error || probe.status !== 0 || !output.includes('CODEX_MODEL_READY')) {
        throw new Error(
          `Codex 模型就绪检查失败（model=${m || 'default'}, reasoning=${re || 'default'}）：` +
          `${probe.error?.message || output.trim().slice(-500) || `exit ${probe.status}`}`,
        )
      }
    }
  }

  if (executor === 'pi') {
    const provider = cfg?.provider || 'google'
    const auth = spawnSync(cmd, ['auth', 'check', '--provider', provider, '--json', '--no-refresh'], { encoding: 'utf8', stdio: 'pipe' })
    let authResult
    try {
      authResult = JSON.parse(auth.stdout)
    } catch {
      authResult = { status: 'unknown' }
    }
    if (authResult.status !== 'ready') {
      const detail = authResult.reason || (auth.stdout || auth.stderr || '').trim() || `exit ${auth.status}`
      throw new Error(`Pi 未就绪（provider=${provider}）：${detail}`)
    }
    if (probeModel) {
      const command = buildPiReadinessCommand({ provider, model: m, reasoningEffort: re })
      const probe = spawnSync(command.cmd, command.args, { encoding: 'utf8', stdio: 'pipe', timeout: 120_000 })
      const output = `${probe.stdout || ''}\n${probe.stderr || ''}`
      if (/insufficient_quota|insufficient balance|402/.test(output) || probe.error || probe.status !== 0 || !output.includes('PI_MODEL_READY')) {
        throw new Error(`Pi 模型就绪检查失败（provider=${provider}, model=${m || 'default'}）：${probe.error?.message || output.trim().slice(-500) || `exit ${probe.status}`}`)
      }
    }
  }

  if (executor === 'cursor') {
    const auth = spawnSync(cmd, ['status'], { encoding: 'utf8', stdio: 'pipe' })
    const authText = `${auth.stdout || ''}\n${auth.stderr || ''}`.trim()
    if (/not logged in/i.test(authText)) {
      throw new Error(`Cursor Agent 未登录：${authText}`)
    }
  }

  const readiness = {
    ok: true,
    executor,
    model: m || 'default',
    reasoningEffort: re || 'default',
    provider: cfg?.provider || null,
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

// 执行器不参与正文渲染——它已由卡片固定字段展示，故不作入参，避免误以为结果因执行器而不同。
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
  localConfig,
  model,
  reasoningEffort,
  codexModel,
  codexReasoningEffort,
  resultKind = 'task',
  readOnly = false,
  auditLogPath,
  signal,
}) => {
  const cfg = resolveAiModelConfig(localConfig, executor)
  const m = cfg?.model || model || codexModel
  const re = cfg?.reasoningEffort || reasoningEffort || codexReasoningEffort
  // Pi/Cursor 的 Agent 沙箱通常只放行 cwd，把结果目录放在工作区内，避免写到 /tmp 被拒。
  const resultBaseDir = ['pi', 'cursor'].includes(executor) ? cwd : tmpdir()
  const resultDir = mkdtempSync(join(resultBaseDir, `lark-${executor}-result-`))
  const resultPath = join(resultDir, 'result.json')
  // codex 用 --output-schema/--output-last-message 落盘；claude/pi/cursor 由 prompt 末尾指示写入 resultPath。
  const needsResultInstruction = executor !== 'codex' && !(executor === 'claude' && resultKind === 'intent')
  const effectivePrompt = needsResultInstruction
    ? `${promptText}\n\n${buildClaudeResultFileInstruction(resultPath)}`
    : promptText
  const { cmd, args, stdin, resultMode, eventStream = false } = buildAiExecutorCommand({
    executor,
    promptText: effectivePrompt,
    cwd,
    resultPath,
    attachments,
    model: m,
    reasoningEffort: re,
    provider: cfg?.provider,
    resultKind,
    readOnly,
  })

  const effectiveTimeoutMs = resultKind === 'intent' ? intentClassificationTimeoutMs : defaultAiTimeoutMs
  // intent 分类通常单发；Pi 上游偶发「连接不断但无响应」，只对 Pi 的瞬时超时允许补发一次。
  const maxAttempts = resultKind === 'intent' ? (executor === 'pi' ? 2 : 1) : maxAiExecAttempts

  // 单次子进程执行：resolve 出本次 stdout；非零退出时把 stdout/stderr 尾部原文附到错误上并标注是否瞬时。
  const runAttempt = () =>
    new Promise((resolve, reject) => {
      const shouldCapture = Boolean(auditLogPath) || resultMode === 'stdout-structured' || eventStream
      const stdio = shouldCapture
        ? [stdin == null ? 'inherit' : 'pipe', 'pipe', 'pipe']
        : stdin == null
          ? 'inherit'
          : ['pipe', 'inherit', 'inherit']
      const child = spawn(cmd, args, { cwd, stdio })
      let capturedStdout = ''
      let eventAuditBuffer = ''
      // Pi 的 user/agent_end 事件可能内嵌图片 base64；保留事件与工具轨迹，但不把图片正文重复灌入审计日志。
      const appendEventAudit = (text, { flush = false } = {}) => {
        if (!auditLogPath) return
        eventAuditBuffer += text
        const parts = eventAuditBuffer.split('\n')
        eventAuditBuffer = flush ? '' : (parts.pop() || '')
        if (flush && eventAuditBuffer) parts.push(eventAuditBuffer)
        for (const line of parts) {
          const redacted = line.replace(
            /"(data|encrypted_content|thinkingSignature)":"(?:\\.|[^"\\])*"/g,
            '"$1":"[omitted]"',
          )
          // agent_end 会重复整个会话；工具读文件也可能产生超长单行。审计只需定位最后事件，不复制整份上下文。
          const sanitized = redacted.length > 20000
            ? `${redacted.slice(0, 16000)}...[event truncated ${redacted.length - 18000} chars]...${redacted.slice(-2000)}`
            : redacted
          appendAudit(auditLogPath, `${sanitized}\n`)
        }
      }
      // stdout+stderr 尾部（限长）：退出码统一为 1、不带信息，靠这段原文识别瞬时错误并附到失败卡。
      let capturedTail = ''
      const appendTail = (text) => {
        capturedTail = (capturedTail + text).slice(-2000)
      }
      let timedOut = false
      let idleTimedOut = false
      let aborted = false
      let killTimer = null
      let idleTimer = null
      const terminateChild = (graceMs = 10000) => {
        child.kill('SIGTERM')
        if (killTimer) clearTimeout(killTimer)
        killTimer = setTimeout(() => child.kill('SIGKILL'), graceMs)
      }
      const timeout = Number.isFinite(effectiveTimeoutMs) && effectiveTimeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            terminateChild()
          }, effectiveTimeoutMs)
        : null
      const resetIdleTimeout = () => {
        if (!eventStream || !(piIdleTimeoutMs > 0)) return
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
          idleTimedOut = true
          appendAudit(auditLogPath, `\n[worker] ${executor} event stream idle for ${piIdleTimeoutMs}ms; terminating for retry\n`)
          terminateChild()
        }, piIdleTimeoutMs)
      }
      // worker 优雅退出：abort 时中断 AI 子进程（SIGTERM，2s 内未退再 SIGKILL）。2s 宽限 < worker 侧
      // 收尾等待，确保子进程在 worker exit 前真正死掉，不会变孤儿继续改 worktree 与新一代 AI 双跑。
      const onAbort = () => {
        aborted = true
        terminateChild(2000)
      }
      const clearChildTimeout = () => {
        if (timeout) clearTimeout(timeout)
        if (idleTimer) clearTimeout(idleTimer)
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
          if (resultMode === 'stdout-structured') capturedStdout += text
          appendTail(text)
          resetIdleTimeout()
          if (resultMode !== 'stdout-structured' && !eventStream) process.stdout.write(chunk)
          if (eventStream) appendEventAudit(text)
          else appendAudit(auditLogPath, text)
        })
        child.stderr.on('data', (chunk) => {
          const text = chunk.toString()
          appendTail(text)
          resetIdleTimeout()
          process.stderr.write(chunk)
          appendAudit(auditLogPath, text)
        })
      }
      resetIdleTimeout()
      child.on('exit', (code) => {
        clearChildTimeout()
        if (eventStream) appendEventAudit('', { flush: true })
        if (aborted) return reject(new Error(`${executor} exec aborted（worker 退出或任务已取消/换代）`))
        if (idleTimedOut) {
          const error = new Error(`${executor} exec produced no events for ${piIdleTimeoutMs}ms`)
          error.transient = true
          return reject(error)
        }
        if (timedOut) {
          const error = new Error(`${executor} exec timed out after ${effectiveTimeoutMs}ms`)
          error.transient = executor === 'pi' && resultKind === 'intent'
          return reject(error)
        }
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
