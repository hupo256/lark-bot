/**
 * Lark Worker 的 AI executor 适配层：选择优先级、命令边界、CLI 预检与结构化结果。
 * 只允许已知 CLI 执行器固定枚举，任何 Lark/config 输入都不能变成任意命令。
 */

import { pageToolOf } from './lark-verify-page.mjs'
import { BUG_RECORD_TOOL } from './lark-paths.mjs'
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { larkBotRoot, prdCacheRoot } from './lark-paths.mjs'
import {
  buildClaudeResultFileInstruction,
  buildClaudeResultRecoveryInstruction,
  parseStructuredAiResult,
  parseStructuredAnalysisResult,
  parseStructuredAnalysisValue,
  parseStructuredIntentResult,
  parseStructuredTriageResult,
} from './lark-ai-result.mjs'
import { AI_EXECUTORS, resolveClaudeBinary } from './lark-constants.mjs'
import { noChangeHeadline } from './lark-triage.mjs'
import { aiStatusMeta, FAILURE_KIND_LABELS, ROOT_CAUSE_LAYER_LABELS, TASK_STATE_LABELS, isOffFrontendRootCause } from './lark-status-meta.mjs'

const defaultAiTimeoutMs = Number(process.env.LARK_WORKER_AI_TIMEOUT_MS || process.env.LARK_WORKER_CODEX_TIMEOUT_MS || 1800000)
const intentClassificationTimeoutMs = Number(process.env.LARK_INTENT_CLASSIFIER_TIMEOUT_MS || 120000)
// Pi text 模式只在最终答案时输出，provider/工具卡死期间审计日志会一直为空。改走 JSON 事件流后，
// 用空闲超时识别「进程还活着但已无任何事件」的假运行，并交给瞬时错误重试；总超时仍是最终硬上限。
const piIdleTimeoutMs = Math.max(0, Number(process.env.LARK_PI_IDLE_TIMEOUT_MS || 300000))
// claude 事件流下，一次 Bash 工具执行期间不产出 stdout，故 idle 阈值需比 Pi 宽：真正挂死/watch 模式命令永不返回，
// 10 分钟仍能兜住（远好于 30 分钟硬超时死墙），而首次冷跑的合法 scoped tsc/vitest（数分钟）不会被误杀。
const claudeIdleTimeoutMs = Math.max(0, Number(process.env.LARK_CLAUDE_IDLE_TIMEOUT_MS || 600000))
const idleTimeoutMsFor = (executor) => (executor === 'claude' ? claudeIdleTimeoutMs : piIdleTimeoutMs)
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
// 无头任务模式摘掉的 Claude 内建工具：会结束本轮 / 排程到未来（ScheduleWakeup、Cron*）、把活甩到别的会话或云端
// （Workflow、RemoteTrigger）、切换工作目录（EnterWorktree / ExitWorktree）。这些在交互式会话里合理，在 `-p` 一次性
// 工单里只会让会话提前结束、结果文件没写（lessons #31）。
export const CLAUDE_HEADLESS_DISALLOWED_TOOLS = Object.freeze([
  'ScheduleWakeup',
  'CronCreate',
  'CronDelete',
  'CronList',
  'RemoteTrigger',
  'Workflow',
  'EnterWorktree',
  'ExitWorktree',
])
// 结果文件缺失 / 不合法时续会话补写的硬超时：只写一个文件，5 分钟足够；超时即放弃，沿用原错误。
const resultRecoveryTimeoutMs = Math.max(0, Number(process.env.LARK_CLAUDE_RESULT_RECOVERY_TIMEOUT_MS || 300000))
const codexResultSchema = join(larkBotRoot, 'schemas/lark-ai-result.schema.json')
const codexAnalysisSchema = join(larkBotRoot, 'schemas/lark-ai-analysis.schema.json')
const intentClassificationSchema = join(larkBotRoot, 'schemas/lark-intent-classification.schema.json')
// claude --json-schema 不认 draft 2020-12 的 $schema 元声明（报 "not a valid JSON Schema"），传文本前剥掉；
// codex 走 --output-schema 文件路径，不受影响。
const claudeSchemaText = (schemaPath) => {
  const { $schema: _meta, ...schema } = JSON.parse(readFileSync(schemaPath, 'utf8'))
  return JSON.stringify(schema)
}
const intentClassificationSchemaText = claudeSchemaText(intentClassificationSchema)
const triageSchema = join(larkBotRoot, 'schemas/lark-ai-triage.schema.json')
const triageSchemaText = claudeSchemaText(triageSchema)
const analysisSchemaText = claudeSchemaText(codexAnalysisSchema)
// 分诊 / 分析阶段 claude 只放行只读命令：查提交历史 / 搜代码。-p 模式下未放行的工具调用直接被拒，不会卡在审批。
const triageReadOnlyBashRules = ['git log', 'git show', 'git diff', 'git status', 'git branch', 'git rev-parse', 'git merge-base', 'git blame', 'rg']
  .map((command) => `Bash(${command}:*)`)
  .join(',')
// 只读阶段（不允许落任何写）：codex 用 read-only 沙箱；其余执行器由 Worker 前后快照校验兜底。
const isReadOnlyResultKind = (resultKind) => resultKind === 'analysis' || resultKind === 'triage'
// realpath 兜底：symlink/大小写卷等情况下沙箱按规范路径判定。
const realpathOr = (path) => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}
// codex workspace-write 沙箱只放行 cwd（worktree）写入；lark-bot 仓库（附件/审计/预取文档）与 PRD 缓存只需读，
// codex 两种沙箱默认都可读全盘，无需额外放行。
// claude（未跳过权限的只读模式）/ cursor 默认只放行 cwd，需显式加读目录：lark-bot 仓库（附件、审计目录下的
// Figma / Lark 文档预取、bot 文档）、PRD 缓存。不存在的目录不传。
// pi 没有目录沙箱，不需要也不支持该参数；claude 任务模式已 --dangerously-skip-permissions，同样不需要。
// extraDirs：仓库 profile 的 readableDirs（如 falive 的只读参考仓 x9_web_react）。
export const executorReadableDirs = (extraDirs = []) =>
  [...new Set([larkBotRoot, prdCacheRoot, ...extraDirs].filter((dir) => dir && existsSync(dir)).map(realpathOr))]

export { resolveAiExecutor, validateAiExecutor } from './lark-ai-executor-select.mjs'
import { resolveAiExecutor, validateAiExecutor } from './lark-ai-executor-select.mjs'
void validateAiExecutor
void resolveAiExecutor

// 执行器名 → 本机二进制。claude 走 resolveClaudeBinary（LARK_CLAUDE_BIN 覆盖；node --test 里默认必失败的路径，测试绝不起真 claude，
// 10-25 搬自 fameex 沙箱试跑）。任务四种模式、就绪探针、--version 预检都经这里。
export const resolveAiExecutorBinary = (executor) => (executor === 'claude' ? resolveClaudeBinary() : executor)

// 各执行器在本地配置里的模型/推理强度/Provider 键名不同；缺省时返回空，由 CLI 自己决定默认值。
// claude：`claudeModel` / `claudeEffort`（兼容旧键 model / reasoningEffort），仓库 profile 可按仓覆盖；
// `claudeIntentModel` / `claudeIntentEffort` 给只读意图/信息分类单独指定模型与强度（缺省同 claudeModel / claudeEffort）。
export const resolveAiModelConfig = (localConfig, executor, repoProfile = null) => {
  const empty = { model: null, reasoningEffort: null, provider: null, intentModel: null, intentEffort: null, analysisModel: null, analysisEffort: null }
  if (!localConfig || typeof localConfig !== 'object') localConfig = {}
  switch (executor) {
    case 'claude':
    default: {
      const model = repoProfile?.claudeModel || localConfig.claudeModel || localConfig.model || null
      const reasoningEffort = repoProfile?.claudeEffort || localConfig.claudeEffort || localConfig.reasoningEffort || null
      return {
        ...empty,
        model,
        reasoningEffort,
        intentModel: repoProfile?.claudeIntentModel || localConfig.claudeIntentModel || model,
        intentEffort: repoProfile?.claudeIntentEffort || localConfig.claudeIntentEffort || reasoningEffort,
        // 只读分析 / 分诊阶段：缺省沿用任务模型与强度。
        analysisModel: repoProfile?.claudeAnalysisModel || localConfig.claudeAnalysisModel || model,
        analysisEffort: repoProfile?.claudeAnalysisEffort || localConfig.claudeAnalysisEffort || reasoningEffort,
      }
    }
  }
}

// claude 的 --add-dir 吃多个值（一次传完）；cursor-agent 的 --add-dir 每次一个、可重复。
const addDirArgs = (executor, extraDirs = []) => {
  const dirs = executorReadableDirs(extraDirs)
  if (!dirs.length) return []
  return ['--add-dir', ...dirs]
}

// claude 的模型 / 推理强度参数：缺省不传，由 claude.env 的 ANTHROPIC_MODEL（proxy）或账号默认（local）决定。
const claudeModelArgs = ({ model, effort }) => [
  ...(model ? ['--model', model] : []),
  ...(effort ? ['--effort', effort] : []),
]

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
  readableDirs = [],
  // 仓库 profile 额外放行的只读命令（如 pre 探针），分析 / 分诊阶段也能实测环境。
  extraReadOnlyCommands = [],
  // 结果文件补写：续上一次 claude 会话（仅任务模式）。
  resumeSessionId = null,
}) => {
  const readOnlyBashRules = [triageReadOnlyBashRules, ...extraReadOnlyCommands.map((command) => `Bash(${command}:*)`)].join(',')
  // 兼容旧调用点传入的 codexModel/codexReasoningEffort；新执行器走通用 model/reasoningEffort。
  const m = model ?? codexModel
  const re = reasoningEffort ?? codexReasoningEffort
  if (executor === 'claude') {
    // @负责人消息的前置分类必须是严格只读：只开放 Read（便于识别已下载截图），plan 模式禁写，
    // 结构化结果直接走 stdout，不要求 Claude 写临时结果文件。
    if (resultKind === 'intent') {
      return {
        cmd: resolveAiExecutorBinary('claude'),
        args: [
          '-p',
          '--permission-mode', 'plan',
          '--tools', 'Read',
          ...claudeModelArgs({ model: m, effort: re }),
          // --add-dir 是变长参数：必须紧跟下一个 -- 选项，绝不能放在末尾 prompt 前面（会把 prompt 吞成目录）。
          ...addDirArgs('claude', readableDirs),
          '--no-session-persistence',
          '--json-schema', intentClassificationSchemaText,
          '--output-format', 'json',
          promptText,
        ],
        stdin: null,
        resultMode: 'stdout-structured',
      }
    }
    // bug 分诊：只读决定「改不改代码」。不给 Write/Edit，Bash 只放行只读 git/rg；结构化结果走 stdout。
    if (resultKind === 'triage') {
      return {
        cmd: resolveAiExecutorBinary('claude'),
        args: [
          '-p',
          '--tools', 'Read,Grep,Glob,Bash',
          '--allowedTools', readOnlyBashRules,
          ...claudeModelArgs({ model: m, effort: re }),
          ...addDirArgs('claude', readableDirs),
          '--no-session-persistence',
          '--json-schema', triageSchemaText,
          '--output-format', 'json',
          promptText,
        ],
        stdin: null,
        resultMode: 'stdout-structured',
      }
    }
    // 改代码前的只读分析（范围契约）：工具面与分诊同档——无 Write/Edit，Bash 只放行只读 git/rg；
    // 结构化结果走 --json-schema + stdout，schema 与 codex 的 --output-schema 是同一份（含 scope）。
    if (resultKind === 'analysis') {
      // 不带 --no-session-persistence：实施阶段 --resume 续这个会话，省掉第二趟冷启动重读代码（升级计划第 1 批）。
      return {
        cmd: resolveAiExecutorBinary('claude'),
        args: [
          '-p',
          '--tools', 'Read,Grep,Glob,Bash',
          '--allowedTools', readOnlyBashRules,
          ...claudeModelArgs({ model: m, effort: re }),
          ...addDirArgs('claude', readableDirs),
          '--json-schema', analysisSchemaText,
          '--output-format', 'json',
          promptText,
        ],
        stdin: null,
        resultMode: 'stdout-structured',
      }
    }
    return {
      cmd: resolveAiExecutorBinary('claude'),
      // 事件流（stream-json）供 Worker 做「外部命令卡死」的空闲超时与审计定位：headless `-p` 默认只在结束时吐一坨
      // 文本，一旦某步（如把校验误跑成 watch 模式的 vitest、卡网络的命令）挂住，就只能死等满硬超时被强杀，且审计日志为空、
      // 无从定位。改用 stream-json 后每个工具/消息事件都会落审计，且 idle 超时可在无事件 N 分钟后终止并转瞬时重试。
      // --include-partial-messages 让思考/文本增量持续刷新 idle 计时器，因此只有真正阻塞的工具调用才触发 idle，
      // 合法的长思考不会被误杀。最终业务结果仍由模型写 resultPath（与 codex/pi 同构），stdout 仅作事件遥测。
      args: [
        '-p',
        // 只读任务（状态 / 复测 / 代答）跑在人的主仓里：工具面与分析阶段同档（无 Write/Edit，Bash 只放行只读命令），
        // 绝不带 --dangerously-skip-permissions——由命令构造保证只读任务拿不到可写面，不靠 prompt 自觉。
        ...(readOnly ? ['--tools', 'Read,Grep,Glob,Bash', '--allowedTools', readOnlyBashRules] : ['--dangerously-skip-permissions']),
        ...claudeModelArgs({ model: m, effort: re }),
        // 任务模式已跳过权限，cwd 外的只读参考仓（profile.readableDirs）仍需显式放行给 Read/Grep。
        ...(readableDirs.length ? ['--add-dir', ...executorReadableDirs(readableDirs).filter((dir) => dir !== realpathOr(larkBotRoot) && dir !== realpathOr(prdCacheRoot))] : []),
        // 无头 `-p` 里一调用就结束本轮（ScheduleWakeup / Cron*）或把工作甩给别处（Workflow / RemoteTrigger /
        // 切 worktree）的工具一律摘掉：10-15「日报发一下」就是模型把长命令放后台再 ScheduleWakeup「等它」，
        // 会话当场结束、result.json 没写，活干成了却报失败。变长参数，必须紧跟下一个 -- 选项。
        '--disallowedTools', ...CLAUDE_HEADLESS_DISALLOWED_TOOLS,
        // 结果文件补写：续上一次会话（同上下文）只让它写 resultPath，不重跑整个任务。
        ...(resumeSessionId ? ['--resume', resumeSessionId] : []),
        '--output-format', 'stream-json',
        '--verbose',
        '--include-partial-messages',
        promptText,
      ],
      stdin: null,
      resultMode: 'structured',
      eventStream: true,
    }
  }
  throw new Error(`unknown AI executor: ${executor} (expected ${[...AI_EXECUTORS].join(', ')})`)
}

const preflightedExecutors = new Map()

export const buildClaudeReadinessCommand = ({ model = null, effort = null } = {}) => ({
  cmd: resolveAiExecutorBinary('claude'),
  args: [
    '-p',
    '--permission-mode', 'plan',
    '--tools', 'Read',
    ...claudeModelArgs({ model, effort }),
    '--no-session-persistence',
    'This is a read-only readiness check. Reply with exactly: CLAUDE_MODEL_READY',
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
  repoProfile = null,
} = {}) => {
  const cfg = resolveAiModelConfig(localConfig, executor, repoProfile)
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

  // claude 的 --version 不验鉴权：代理 key 欠费（402）或本机未登录时照样通过，只有真实调用才暴露。
  if (executor === 'claude' && probeModel) {
    const command = buildClaudeReadinessCommand({ model: m, effort: re })
    const probe = spawnSync(command.cmd, command.args, { encoding: 'utf8', stdio: 'pipe', timeout: 120_000, cwd })
    const output = `${probe.stdout || ''}\n${probe.stderr || ''}`
    if (probe.error || probe.status !== 0 || !output.includes('CLAUDE_MODEL_READY')) {
      throw new Error(`Claude 模型就绪检查失败（model=${m || 'default'}, effort=${re || 'default'}, auth=${process.env.ANTHROPIC_BASE_URL ? 'proxy' : 'local'}）：${probe.error?.message || output.trim().slice(-500) || `exit ${probe.status}`}`)
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
  // 审计含群聊原文，只给本机用户读（新建时 0600；已存在的文件由 chmod 兜底一次）。
  appendFileSync(auditLogPath, value, { mode: 0o600 })
}

// 执行器不参与正文渲染——它已由卡片固定字段展示，故不作入参，避免误以为结果因执行器而不同。
// 群卡片只放要点：最多 3 条、每条截到 120 字；完整依据在任务审计（triage）里。
const formatEvidenceForCard = (evidence, { maxItems = 3, maxChars = 120 } = {}) => {
  const items = evidence.slice(0, maxItems).map((item) => (item.length > maxChars ? `${item.slice(0, maxChars)}…` : item))
  const rest = evidence.length - items.length
  return `${items.join('；')}${rest > 0 ? `（另有 ${rest} 条见任务审计）` : ''}`
}

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
  // 分诊判定不改代码：把「为什么不改」讲给群里——判定类型 + 可核对的依据 + 相关提交 + 下一步。
  const noChangeLine = result.status === 'no_change_needed' ? noChangeHeadline(result.noChangeReason) : null
  if (noChangeLine) {
    lines.push(`${n++}. 判定：${noChangeLine}`)
    if (result.triageEvidence?.length) lines.push(`${n++}. 依据：${formatEvidenceForCard(result.triageEvidence)}`)
    if (result.relatedCommits?.length) lines.push(`${n++}. 相关提交：${result.relatedCommits.join('；')}`)
    if (result.nextStep) lines.push(`${n++}. 下一步：${result.nextStep}`)
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
  // 仓库 profile：模型 / 推理强度 / 只读参考目录 / 硬超时按仓覆盖；缺省与单仓行为一致。
  repoProfile = null,
  timeoutMs = null,
  // 测试注入：假子进程演练「结果文件缺失 → 续会话补写」。
  spawnImpl = spawn,
  // 续会话实施（第 1 批）：resumeSessionId 为分析阶段的 session_id，promptText 是增量提示；
  // 续不上（会话不存在 / 非零退出且非瞬时）就用 fallbackPromptText 开新会话跑一次，审计记 resumeFallback。
  resumeSessionId = null,
  fallbackPromptText = null,
}) => {
  const cfg = resolveAiModelConfig(localConfig, executor, repoProfile)
  // 按阶段选模型：意图 / 信息分类用 claudeIntentModel（+ 其强度）；只读分析 / 分诊用 claudeAnalysisModel（+ 其强度）；实施用任务模型。
  const isAnalysisKind = resultKind === 'analysis' || resultKind === 'triage'
  const m = (resultKind === 'intent' && cfg?.intentModel) || (isAnalysisKind && cfg?.analysisModel) || cfg?.model || model || codexModel
  const re = (resultKind === 'intent' && cfg?.intentEffort) || (isAnalysisKind && cfg?.analysisEffort) || cfg?.reasoningEffort || reasoningEffort || codexReasoningEffort
  const readableDirs = repoProfile?.readableDirs || []
  // Pi/Cursor 的 Agent 沙箱通常只放行 cwd，把结果目录放在工作区内，避免写到 /tmp 被拒。
  const resultDir = mkdtempSync(join(tmpdir(), `lark-${executor}-result-`))
  const resultPath = join(resultDir, 'result.json')
  // codex 用 --output-schema/--output-last-message 落盘；claude/pi/cursor 由 prompt 末尾指示写入 resultPath。
  const needsResultInstruction = !['intent', 'triage', 'analysis'].includes(resultKind)
  const effectivePrompt = needsResultInstruction
    ? `${promptText}\n\n${buildClaudeResultFileInstruction(resultPath)}`
    : promptText
  const buildCommand = (prompt, { resumeSessionId = null } = {}) =>
    buildAiExecutorCommand({
      extraReadOnlyCommands: [...(repoProfile?.verify?.probeCommand ? [repoProfile.verify.probeCommand, pageToolOf(repoProfile.verify)] : []), `node ${BUG_RECORD_TOOL}`],
      executor,
      promptText: prompt,
      cwd,
      resultPath,
      attachments,
      model: m,
      reasoningEffort: re,
      provider: cfg?.provider,
      resultKind,
      readOnly,
      readableDirs,
      resumeSessionId,
    })
  const canResume = Boolean(resumeSessionId) && executor === 'claude' && resultKind === 'task'
  let { cmd, args, stdin, resultMode, eventStream = false } = buildCommand(effectivePrompt, { resumeSessionId: canResume ? resumeSessionId : null })
  let resumeFallback = false
  // stream-json 的 init 事件带 session_id：结果文件缺失时用它 `--resume` 续会话只补写文件（见下 recoverResultFile）。
  let lastSessionId = null

  const taskTimeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : (Number(repoProfile?.aiTimeoutMs) > 0 ? Number(repoProfile.aiTimeoutMs) : defaultAiTimeoutMs)
  const effectiveTimeoutMs = resultKind === 'intent' ? intentClassificationTimeoutMs : taskTimeoutMs
  // intent 分类通常单发；Pi 上游偶发「连接不断但无响应」，只对 Pi 的瞬时超时允许补发一次。
  const maxAttempts = resultKind === 'intent' ? 1 : maxAiExecAttempts

  // 单次子进程执行：resolve 出本次 stdout；非零退出时把 stdout/stderr 尾部原文附到错误上并标注是否瞬时。
  const runAttempt = ({ cmd, args, stdin, timeoutMs: attemptTimeoutMs = effectiveTimeoutMs } = {}) =>
    new Promise((resolve, reject) => {
      const idleTimeoutMs = idleTimeoutMsFor(executor)
      const shouldCapture = Boolean(auditLogPath) || resultMode === 'stdout-structured' || eventStream
      const stdio = shouldCapture
        ? [stdin == null ? 'inherit' : 'pipe', 'pipe', 'pipe']
        : stdin == null
          ? 'inherit'
          : ['pipe', 'inherit', 'inherit']
      // detached：子进程成为新进程组组长，terminateChild 用 -pid 杀整组——claude 的 Bash 工具起的 tsc / dev server
      // 孙进程一起死，不会在取消 / 退出后继续改 worktree、与重领后的新 AI 双跑。
      const child = spawnImpl(cmd, args, { cwd, stdio, detached: true })
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
      const killTree = (sig) => {
        try {
          if (child.pid) process.kill(-child.pid, sig)
          else child.kill(sig)
        } catch {
          try {
            child.kill(sig)
          } catch {
            // 已退出
          }
        }
      }
      const terminateChild = (graceMs = 10000) => {
        killTree('SIGTERM')
        if (killTimer) clearTimeout(killTimer)
        killTimer = setTimeout(() => killTree('SIGKILL'), graceMs)
      }
      const timeout = Number.isFinite(attemptTimeoutMs) && attemptTimeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            terminateChild()
          }, attemptTimeoutMs)
        : null
      const resetIdleTimeout = () => {
        if (!eventStream || !(idleTimeoutMs > 0)) return
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
          idleTimedOut = true
          appendAudit(auditLogPath, `\n[worker] ${executor} event stream idle for ${idleTimeoutMs}ms; terminating for retry\n`)
          terminateChild()
        }, idleTimeoutMs)
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
          if (eventStream && !lastSessionId) lastSessionId = text.match(/"session_id":"([^"]+)"/)?.[1] || null
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
          const error = new Error(`${executor} exec produced no events for ${idleTimeoutMs}ms`)
          error.transient = true
          return reject(error)
        }
        if (timedOut) {
          const error = new Error(`${executor} exec timed out after ${attemptTimeoutMs}ms`)
          error.transient = false
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
        capturedStdout = await runAttempt({ cmd, args, stdin })
        break
      } catch (error) {
        // 续会话失败（会话不存在 / 被清理 / 非零退出且非瞬时）：回退到完整提示开新会话，只回退一次。
        if (canResume && !resumeFallback && !signal?.aborted && !/aborted|timed out/.test(String(error?.message))) {
          resumeFallback = true
          lastSessionId = null // 失败的续会话 id 作废，补写结果文件要续的是新会话（aven 2026-10-20 review #12）
          const fullPrompt = fallbackPromptText ? `${fallbackPromptText}\n\n${buildClaudeResultFileInstruction(resultPath)}` : effectivePrompt
          ;({ cmd, args, stdin, resultMode, eventStream = false } = buildCommand(fullPrompt))
          console.warn(`[lark-worker] 续会话 ${resumeSessionId} 失败，改用完整提示开新会话：${String(error.message).slice(0, 160)}`)
          appendAudit(auditLogPath, `[resume-fallback] ${new Date().toISOString()} ${String(error.message).slice(0, 200)}\n`)
          continue
        }
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
      const structured = envelope.structured_output ?? envelope.result
      // json 模式的 envelope 带 session_id：分析阶段的会话 id 交给实施阶段 --resume。
      const sessionId = envelope.session_id || lastSessionId || null
      if (resultKind === 'triage') return { executor, result: parseStructuredTriageResult(structured, executor), sessionId }
      if (resultKind === 'analysis') return { executor, result: parseStructuredAnalysisValue(structured, executor), sessionId }
      return { executor, result: parseStructuredIntentResult(structured, executor), sessionId }
    }
    if (resultMode !== 'structured') return { executor, result: null }
    // 自纠偏（lessons #31）：claude 任务模式正常退出却没写 / 写坏结果文件时，续同一会话只让它补写这一个文件，
    // 不重跑任务。只试一次；补写仍不合法就按原错误上抛，交 worker 归因。
    const recoverResultFile = async (parse, error) => {
      if (executor !== 'claude' || resultKind !== 'task' || !lastSessionId || signal?.aborted) throw error
      const sessionId = lastSessionId
      appendAudit(auditLogPath, `\n[self-heal] ${new Date().toISOString()} 结果文件缺失或不合法（${String(error.message).slice(0, 200)}），--resume ${sessionId} 只补写 result.json\n`)
      console.warn(`[lark-worker] claude 结果文件缺失或不合法，续会话 ${sessionId} 补写：${String(error.message).slice(0, 160)}`)
      const recovery = buildCommand(buildClaudeResultRecoveryInstruction(resultPath, error.message), { resumeSessionId: sessionId })
      try {
        await runAttempt({ cmd: recovery.cmd, args: recovery.args, stdin: recovery.stdin, timeoutMs: resultRecoveryTimeoutMs })
        const result = parse()
        appendAudit(auditLogPath, `[self-heal] 补写成功：status=${result?.status}\n`)
        return result
      } catch (retryError) {
        appendAudit(auditLogPath, `[self-heal] 补写失败：${String(retryError.message).slice(0, 200)}\n`)
        throw new Error(`${error.message}（续会话补写也失败：${String(retryError.message).slice(0, 160)}）`)
      }
    }
    if (resultKind === 'analysis') return { executor, result: parseStructuredAnalysisResult(resultPath, executor) }
    if (resultKind === 'intent') {
      return { executor, result: parseStructuredIntentResult(readFileSync(resultPath, 'utf8'), executor) }
    }
    if (resultKind === 'triage') {
      return { executor, result: parseStructuredTriageResult(readFileSync(resultPath, 'utf8'), executor) }
    }
    const parseTask = () => parseStructuredAiResult(resultPath, executor)
    try {
      return { executor, result: parseTask(), sessionId: lastSessionId, resumedSession: canResume && !resumeFallback ? resumeSessionId : null, resumeFallback }
    } catch (error) {
      return { executor, result: await recoverResultFile(parseTask, error), sessionId: lastSessionId, resumedSession: canResume && !resumeFallback ? resumeSessionId : null, resumeFallback }
    }
  } finally {
    rmSync(resultDir, { recursive: true, force: true })
  }
}
