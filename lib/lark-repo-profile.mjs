/**
 * 仓库 profile：lark-bot 原本是 fameex-web 单仓 bot（consumerRoot / origin/online / PR 号路由 / fameex 规则），
 * 这里把「一个任务在哪个仓、基于哪个分支、读哪些文档、用哪套规则与模型」收口成可配置的 profile，
 * 让同一套 gateway / worker 同时服务多个仓库（第一个非 fameex 仓是 falive-react）。
 *
 * 口径：
 *   · `repos` 缺省或某键缺省时，一切行为与拆仓前的 fameex 单仓完全一致（默认 profile = `fameex`）。
 *   · 非默认仓的任务带 `task.repo=<key>`、`task.project=<projectKey>`（如 FALIVE）；projectKey 复用原有的
 *     project 字段，这样附件 / 审计目录、分支名、卡片标题都沿既有链路工作，不必给每个模块再加一个仓库字段。
 *   · 群 → 仓 由 `chatIds` 决定（优先于群名解析项目号）；发卡按 profile 的 webhook / notifyChatId 改投
 *     （外部群加不了应用机器人，只能走自定义机器人 webhook）。
 *
 * 注册表是进程级单例（gateway / worker 启动时各自 registerRepoProfiles(config)）；未注册时只有默认 profile，
 * 零行为变化。纯函数部分（normalizeRepoProfile / buildRepoRegistry）可直测。
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { consumerRoot } from './lark-paths.mjs'

export const DEFAULT_REPO_KEY = 'fameex'
export const DEFAULT_BASE_REF = 'origin/online'

const expandHome = (value) => {
  if (typeof value !== 'string') return value
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  return value
}
const toAbsolute = (value, base) => {
  const expanded = expandHome(String(value || '').trim())
  if (!expanded) return ''
  return isAbsolute(expanded) ? resolve(expanded) : resolve(base || process.cwd(), expanded)
}
const stringArray = (value) => (Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : [])
const nonEmpty = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '')

// 默认 profile：拆仓前的 fameex 单仓行为原样（worktree 在主仓同级目录、临时 worktree 在 .lark-hotfix、
// 基线 origin/online、hotfix/<项目号>-<后缀> 分支、PRD 缓存做项目文档、fameex 规则快照）。
export const defaultRepoProfile = ({ root = consumerRoot } = {}) => ({
  key: DEFAULT_REPO_KEY,
  isDefault: true,
  projectKey: null,
  title: null,
  root,
  worktreesDir: dirname(root),
  tempWorktreeDir: join(dirname(root), '.lark-hotfix'),
  baseRef: DEFAULT_BASE_REF,
  fetchBase: true,
  branchPrefix: 'hotfix',
  chatIds: [],
  taskMentionOpenIds: [],
  webhook: null,
  notifyChatId: null,
  docs: [],
  readableDirs: [],
  ruleProfile: 'fameex',
  installArgs: null,
  checksHint: null,
  scopeBudgets: null,
  ownership: null,
  ownerMap: {},
  docIntakeDir: null,
  poll: null,
  dailyReport: null,
  claudeModel: null,
  claudeEffort: null,
  claudeAnalysisModel: null,
  claudeAnalysisEffort: null,
  claudeIntentModel: null,
  aiTimeoutMs: null,
})

// 把 local.json 里一个 repos.<key> 归一成完整 profile（缺省值补齐、路径转绝对）。纯函数。
export const normalizeRepoProfile = (key, raw = {}) => {
  const normalizedKey = nonEmpty(key).toLowerCase()
  if (!normalizedKey) throw new Error('repo profile 键不能为空')
  if (normalizedKey === DEFAULT_REPO_KEY) {
    // 默认仓允许覆盖少量字段（模型 / 预算 / 人员表），路径与分支口径保持单仓默认。
    const base = defaultRepoProfile()
    return {
      ...base,
      title: nonEmpty(raw.title) || base.title,
      scopeBudgets: raw.scopeBudgets ?? null,
      ownerMap: raw.ownerMap && typeof raw.ownerMap === 'object' ? raw.ownerMap : {},
      claudeModel: nonEmpty(raw.claudeModel) || null,
      claudeEffort: nonEmpty(raw.claudeEffort) || null,
      claudeAnalysisModel: nonEmpty(raw.claudeAnalysisModel) || null,
      claudeAnalysisEffort: nonEmpty(raw.claudeAnalysisEffort) || null,
      claudeIntentModel: nonEmpty(raw.claudeIntentModel) || null,
      aiTimeoutMs: Number(raw.aiTimeoutMs) > 0 ? Number(raw.aiTimeoutMs) : null,
    }
  }
  const root = toAbsolute(raw.root)
  if (!root) throw new Error(`repos.${normalizedKey}.root 必填（业务仓绝对路径）`)
  const worktreesDir = raw.worktreesDir ? toAbsolute(raw.worktreesDir) : join(dirname(root), `.lark-${normalizedKey}`)
  const baseRef = nonEmpty(raw.baseRef)
  if (!baseRef) throw new Error(`repos.${normalizedKey}.baseRef 必填（临时 worktree 的基线分支，如 feature/xxx 或 origin/main）`)
  const projectKey = (nonEmpty(raw.projectKey) || normalizedKey).toUpperCase()
  if (!/^[A-Z][A-Z0-9_-]{1,23}$/.test(projectKey)) {
    throw new Error(`repos.${normalizedKey}.projectKey 只能是大写字母 / 数字 / _ / -（会拼进目录与分支名）：${projectKey}`)
  }
  return {
    key: normalizedKey,
    isDefault: false,
    projectKey,
    title: nonEmpty(raw.title) || null,
    root,
    worktreesDir,
    // 集成分支（整改 #10，aven 2026-10-14 同意）：bot 每条任务做完自动合回它，新任务从它开；aven 每天把它合进 baseRef。
    integrationBranch: nonEmpty(raw.integrationBranch) || null,
    tempWorktreeDir: worktreesDir,
    baseRef,
    // 远端 ref 才需要 fetch；本地分支（如 aven 的集成分支）直接用本地 HEAD，不碰网络。
    fetchBase: typeof raw.fetchBase === 'boolean' ? raw.fetchBase : baseRef.startsWith('origin/'),
    branchPrefix: nonEmpty(raw.branchPrefix) || `lark/${normalizedKey}`,
    chatIds: stringArray(raw.chatIds),
    // chat_id → 显示名（直接填 chatIds 的群没有群名解析，消息里标群用这个；群改名不影响路由）。
    // 群里的自定义机器人（Aven.Bot）：@ 它 = 显式对 bot 说话（交办 / 提问 / 通知），绝不静默。chatId → open_id，启动时也按名字自动发现。
    botMentionOpenIds: Object.fromEntries(Object.entries(raw.botMentionOpenIds && typeof raw.botMentionOpenIds === 'object' ? raw.botMentionOpenIds : {}).filter(([key, value]) => nonEmpty(key) && nonEmpty(value))),
    botName: nonEmpty(raw.botName) || null,
    // 被动捕捉模式：full = 没 @ 机器人的消息也会派工单 / 代答；ledger = 只记台账（和入库文档），动手一律要 @ 机器人（aven 2026-10-14：就地转发闭环）。
    passiveMode: raw.passiveMode === 'ledger' ? 'ledger' : 'full',
    chatNameById: Object.fromEntries(Object.entries(raw.chatLabels && typeof raw.chatLabels === 'object' ? raw.chatLabels : {}).filter(([key, value]) => nonEmpty(key) && nonEmpty(value))),
    // 测试群：被代理人自己发的消息也当别人的（正常群里 aven 自己发的不当任务）。
    selfMessagesAsOthers: stringArray(raw.selfMessagesAsOthers),
    // 环境实测：执行器下结论前用它打真实环境（只读）。{ probeCommand, env, usage }
    verify: raw.verify && nonEmpty(raw.verify.probeCommand) ? { probeCommand: raw.verify.probeCommand.trim(), env: nonEmpty(raw.verify.env) || 'pre', usage: nonEmpty(raw.verify.usage) || '', schemaCheck: nonEmpty(raw.verify.schemaCheck) || '', schemaFiles: nonEmpty(raw.verify.schemaFiles) || '/data/(schema|queries)\\.ts$' } : null,
    // 群名（精确匹配）：外部群拿不到 chat_id 时先填群名，gateway 启动用用户身份 chat-search 解析后并入 chatIds。
    chatNames: stringArray(raw.chatNames),
    taskMentionOpenIds: stringArray(raw.taskMentionOpenIds),
    webhook: normalizeWebhookConfig(raw.webhook),
    // 每个外部群各有自己的自定义机器人 webhook：按群名（或 chat_id）分别配；没配的群回落 profile.webhook。
    webhooksByChat: Object.fromEntries(
      Object.entries(raw.webhooksByChat && typeof raw.webhooksByChat === 'object' ? raw.webhooksByChat : {})
        .map(([key, value]) => [nonEmpty(key), normalizeWebhookConfig(value)])
        .filter(([key, value]) => key && value),
    ),
    notifyChatId: nonEmpty(raw.notifyChatId) || null,
    docs: stringArray(raw.docs).map((doc) => toAbsolute(doc, root)),
    readableDirs: stringArray(raw.readableDirs).map((dir) => toAbsolute(dir)),
    ruleProfile: nonEmpty(raw.ruleProfile) || normalizedKey,
    installArgs: Array.isArray(raw.installArgs) && raw.installArgs.length ? raw.installArgs.map(String) : null,
    checksHint: nonEmpty(raw.checksHint) || null,
    // worker 独立终检（不信 AI 自报）：typecheck = 改了 .ts/.tsx 就跑的命令；tests = 改了 *.test.ts 时对这些文件跑的命令。
    finalChecks: raw.finalChecks && typeof raw.finalChecks === 'object'
      ? { typecheck: Array.isArray(raw.finalChecks.typecheck) ? raw.finalChecks.typecheck.map(String) : null, tests: Array.isArray(raw.finalChecks.tests) ? raw.finalChecks.tests.map(String) : null, timeoutMs: Number(raw.finalChecks.timeoutMs) || 10 * 60_000 }
      : null,
    scopeBudgets: raw.scopeBudgets ?? null,
    ownership: normalizeOwnership(raw.ownership, root),
    ownerMap: raw.ownerMap && typeof raw.ownerMap === 'object' ? raw.ownerMap : {},
    // 群里发来的对接文档落到仓库的哪个目录（仓库相对路径）；配了即启用「文档消息自动进意图分类」。
    docIntakeDir: nonEmpty(raw.docIntakeDir) || null,
    // 外部群只发结果卡，排队卡发负责人私聊（缺省 true；notifyChatId 为空时无效）。
    quietQueuedCards: raw.quietQueuedCards !== false,
    // 试运行期所有卡片只发负责人私聊，群里零打扰（2026-10-13 后端同事反馈群里卡太多干扰）；关掉后结果卡回群。
    cardsToNotifyOnly: raw.cardsToNotifyOnly === true,
    // 外部群按上下文判任务（缺省开）：别人发的实质消息都进只读意图分类，不靠 @。
    contextTrigger: raw.contextTrigger !== false,
    // 外部群分类去抖：收到消息后等这么久没有新消息再分类（同话题连发合并成一次分类）。
    intakeDebounceMs: positiveOr(raw.intakeDebounceMs, 90_000),
    // 该仓同时最多跑几条任务（1 = 串行，避免并行分支互相打架）。
    concurrency: Math.max(1, Number(raw.concurrency) || 3),
    // 提交标题前缀（满足仓库 commit-msg 钩子），如 `feat(bot)`；缺省沿用 `lark hotfix`。
    commitPrefix: nonEmpty(raw.commitPrefix) || null,
    // 外部群人话回复：以负责人用户身份往群里发「一句话 / 待确认清单文件 + @」（A 方案）。
    groupPostAsUser: raw.groupPostAsUser === true,
    poll: normalizePoll(raw.poll),
    dailyReport: normalizeDailyReport(raw.dailyReport, root),
    claudeModel: nonEmpty(raw.claudeModel) || null,
    claudeEffort: nonEmpty(raw.claudeEffort) || null,
    // 只读分析 / 分诊阶段可单独指定模型与推理强度（分析要全面精确，实施要快）。
    claudeAnalysisModel: nonEmpty(raw.claudeAnalysisModel) || null,
    claudeAnalysisEffort: nonEmpty(raw.claudeAnalysisEffort) || null,
    claudeIntentModel: nonEmpty(raw.claudeIntentModel) || null,
    aiTimeoutMs: Number(raw.aiTimeoutMs) > 0 ? Number(raw.aiTimeoutMs) : null,
  }
}

// webhook 配置两种写法：inline `{ url, secret }`，或 `{ file }` 指向 0600 的 JSON（{ webhookUrl|url, secret }）。
// 密钥不进 local.json 也行；file 形态在首次发送时才读（懒加载），缺文件即发送失败、不阻塞启动。
const normalizeWebhookConfig = (raw) => {
  if (!raw || typeof raw !== 'object') return null
  const file = nonEmpty(raw.file) ? toAbsolute(raw.file) : null
  const url = nonEmpty(raw.url) || nonEmpty(raw.webhookUrl) || null
  if (!file && !url) return null
  return { file, url, secret: nonEmpty(raw.secret) || null }
}

// 归属规则：me = 本 bot 替谁干活（功能总表「前端」列里的名字）；meOpenIds = 这些人的 Lark open_id，
// 他们本人点名要做别人的功能时放行一次（记忆口径：仅当次生效）；table = 判归属的权威表（仓库相对路径）。
const normalizeOwnership = (raw, root) => {
  if (!raw || typeof raw !== 'object') return null
  const me = nonEmpty(raw.me)
  if (!me) return null
  return {
    me,
    meOpenIds: stringArray(raw.meOpenIds),
    // 被代理人在群里的各种叫法（aven / Aven / Aven.tong）：分类器要知道「分给 @Aven」= 分给 me。
    meAliases: stringArray(raw.meAliases),
    table: nonEmpty(raw.table) ? toAbsolute(raw.table, root) : null,
  }
}

// 外部群用户身份轮询参数（aven 2026-10-12 定）：工作时段活跃 30s / 空闲 120s，夜间 15min，
// 出错退避到 15min、连续失败 10 次告警。缺省即这组值；`enabled:false` 可只配不跑。
export const DEFAULT_POLL = Object.freeze({
  enabled: true,
  workHours: [8, 19],
  activeMs: 30_000,
  idleMs: 120_000,
  nightMs: 15 * 60_000,
  activeWindowMs: 30 * 60_000,
  errorMaxMs: 15 * 60_000,
  alertAfterFailures: 10,
})
const positiveOr = (value, fallback) => (Number(value) > 0 ? Number(value) : fallback)
const normalizePoll = (raw) => {
  if (raw === false) return { ...DEFAULT_POLL, enabled: false }
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_POLL }
  const hours = Array.isArray(raw.workHours) && raw.workHours.length === 2 ? raw.workHours.map(Number) : DEFAULT_POLL.workHours
  return {
    enabled: raw.enabled !== false,
    workHours: hours.every((h) => Number.isInteger(h) && h >= 0 && h <= 24) ? hours : DEFAULT_POLL.workHours,
    activeMs: positiveOr(raw.activeMs, DEFAULT_POLL.activeMs),
    idleMs: positiveOr(raw.idleMs, DEFAULT_POLL.idleMs),
    nightMs: positiveOr(raw.nightMs, DEFAULT_POLL.nightMs),
    activeWindowMs: positiveOr(raw.activeWindowMs, DEFAULT_POLL.activeWindowMs),
    errorMaxMs: positiveOr(raw.errorMaxMs, DEFAULT_POLL.errorMaxMs),
    alertAfterFailures: positiveOr(raw.alertAfterFailures, DEFAULT_POLL.alertAfterFailures),
  }
}

// 日报：at=HH:MM 本地时间；to=收件（私聊 open_id 或群，试运行期私发负责人）；othersRef=其他人的工作看哪个远端分支；
// featureTable / roadmap=仓库相对路径；people={ 人名: [git 作者别名…] }。
const normalizeDailyReport = (raw, root) => {
  if (!raw || typeof raw !== 'object') return null
  const at = nonEmpty(raw.at)
  if (!/^\d{2}:\d{2}$/.test(at)) throw new Error(`dailyReport.at 必须是 HH:MM（如 19:00），实际：${at || '(空)'}`)
  const people = raw.people && typeof raw.people === 'object' ? raw.people : {}
  return {
    at,
    to: nonEmpty(raw.to) || null,
    // 以 .md 文件发到这些群（群名或 chat_id）；空则私聊 to 发卡片。
    sendTo: stringArray(raw.sendTo),
    othersRef: nonEmpty(raw.othersRef) || 'origin/pre',
    fetch: raw.fetch !== false,
    featureTable: nonEmpty(raw.featureTable) ? toAbsolute(raw.featureTable, root) : null,
    roadmap: nonEmpty(raw.roadmap) ? toAbsolute(raw.roadmap, root) : null,
    people,
    model: nonEmpty(raw.model) || null,
    effort: nonEmpty(raw.effort) || null,
    // 云文档版（aven 2026-10-13 定）：按 docTemplate（仓库里的交接报告）的结构写当天的完整版，用用户身份建成 Lark 云文档，
    // 短消息里带链接。pendingDir = 待对接文档目录（让模型读各方卡点）。
    docTemplate: nonEmpty(raw.docTemplate) ? toAbsolute(raw.docTemplate, root) : null,
    pendingDir: nonEmpty(raw.pendingDir) ? toAbsolute(raw.pendingDir, root) : null,
    docEffort: nonEmpty(raw.docEffort) || null,
    // 功能 → 验证接口（整改 #17）：日报前用探针实测，✅ 的功能逐个标「实测可用 / 没数据 / 不可用」。
    // [{ features: [36], label: '排行榜', path: '/api/ranking/speaking', params: {...}, pick: 'list', expect: 'nonEmpty' | 'ok' | 'field:pull' }]
    featureChecks: Array.isArray(raw.featureChecks) ? raw.featureChecks.filter((item) => item && nonEmpty(item.path)).map((item) => ({ features: Array.isArray(item.features) ? item.features.map(Number).filter(Number.isFinite) : [], label: nonEmpty(item.label) || item.path, path: item.path.trim(), params: item.params && typeof item.params === 'object' ? item.params : {}, pick: nonEmpty(item.pick) || null, expect: nonEmpty(item.expect) || 'nonEmpty' })) : [],
  }
}

const webhookCache = new Map()
// 解析 profile 的 webhook 凭据（file 形态懒读 + 缓存）。返回 { url, secret } 或 null。
export const resolveWebhookCredentials = (profile, chatId = null) => {
  const byChat = chatId ? profile?.webhooksByChat?.[chatId] || profile?.webhooksByChat?.[profile?.chatNameById?.[chatId] || ''] : null
  const webhook = byChat || profile?.webhook
  if (!webhook) return null
  if (webhook.url) return { url: webhook.url, secret: webhook.secret }
  if (!webhook.file) return null
  if (webhookCache.has(webhook.file)) return webhookCache.get(webhook.file)
  let parsed = null
  try {
    const json = JSON.parse(readFileSync(webhook.file, 'utf8'))
    const url = nonEmpty(json.webhookUrl) || nonEmpty(json.url)
    parsed = url ? { url, secret: nonEmpty(json.secret) || null } : null
  } catch {
    parsed = null
  }
  // 读不到不缓存 null：人补上文件后下一张卡就能发出去，不必重启。
  if (parsed) webhookCache.set(webhook.file, parsed)
  return parsed
}

export const buildRepoRegistry = (config = {}) => {
  const registry = new Map()
  const repos = config?.repos && typeof config.repos === 'object' && !Array.isArray(config.repos) ? config.repos : {}
  registry.set(DEFAULT_REPO_KEY, normalizeRepoProfile(DEFAULT_REPO_KEY, repos[DEFAULT_REPO_KEY] || {}))
  for (const [key, raw] of Object.entries(repos)) {
    if (key === DEFAULT_REPO_KEY) continue
    registry.set(key.toLowerCase(), normalizeRepoProfile(key, raw))
  }
  const projectKeys = new Map()
  const chatIds = new Map()
  for (const profile of registry.values()) {
    if (profile.projectKey) {
      if (projectKeys.has(profile.projectKey)) throw new Error(`repos 里 projectKey ${profile.projectKey} 重复（${projectKeys.get(profile.projectKey)} 与 ${profile.key}）`)
      projectKeys.set(profile.projectKey, profile.key)
    }
    for (const chatId of profile.chatIds) {
      if (chatIds.has(chatId)) throw new Error(`repos 里群 ${chatId} 同时属于 ${chatIds.get(chatId)} 与 ${profile.key}`)
      chatIds.set(chatId, profile.key)
    }
  }
  return registry
}

// 启动期校验（纯函数）：返回 errors 数组，供 lark-config.validateConfig 汇总。
export const validateRepoProfiles = (config) => {
  const errors = []
  try {
    const registry = buildRepoRegistry(config)
    for (const profile of registry.values()) {
      if (profile.isDefault) continue
      if (!existsSync(profile.root)) errors.push(`repos.${profile.key}.root 不存在：${profile.root}`)
      if (!existsSync(join(profile.root, '.git'))) errors.push(`repos.${profile.key}.root 不是 git 仓库根：${profile.root}`)
      for (const doc of profile.docs) {
        if (!existsSync(doc)) errors.push(`repos.${profile.key}.docs 里的文件不存在：${doc}`)
      }
      if (profile.ownership?.table && !existsSync(profile.ownership.table)) {
        errors.push(`repos.${profile.key}.ownership.table 不存在：${profile.ownership.table}`)
      }
    }
  } catch (error) {
    errors.push(error.message)
  }
  return errors
}

let registry = buildRepoRegistry({})

export const registerRepoProfiles = (config) => {
  registry = buildRepoRegistry(config)
  return registry
}
// 单测用：恢复成只有默认 profile。
export const resetRepoProfiles = () => registerRepoProfiles({})

export const listRepoProfiles = () => [...registry.values()]
// 运行期把解析出的 chat_id 并入 profile（群名 → id 解析在 gateway 启动时做）；去重，返回最新 chatIds。
export const addRepoChatIds = (key, chatIds, nameById = {}) => {
  const profile = registry.get(nonEmpty(key).toLowerCase())
  if (!profile) return []
  profile.chatIds = [...new Set([...profile.chatIds, ...stringArray(chatIds)])]
  // chat_id → 群名：webhooksByChat 可按群名配，发送时据此反查。
  profile.chatNameById = { ...(profile.chatNameById || {}), ...nameById }
  return profile.chatIds
}
export const repoProfile = (key) => registry.get(nonEmpty(key).toLowerCase()) || registry.get(DEFAULT_REPO_KEY)
// 任务 → profile：task.repo 优先；旧任务无 repo 时按 project 反查已注册的 projectKey（重启后沿用）；都无则默认仓。
export const repoProfileForTask = (task) => {
  if (task?.repo) return repoProfile(task.repo)
  const byProject = repoProfileForProjectKey(task?.project)
  return byProject || repoProfile(DEFAULT_REPO_KEY)
}
export const repoProfileForProjectKey = (value) => {
  const upper = nonEmpty(value).toUpperCase()
  if (!upper) return null
  return listRepoProfiles().find((profile) => !profile.isDefault && profile.projectKey === upper) || null
}
export const isRegisteredProjectKey = (value) => Boolean(repoProfileForProjectKey(value))
export const repoProfileForChat = (chatId) => {
  if (!chatId) return null
  return listRepoProfiles().find((profile) => profile.chatIds.includes(chatId)) || null
}

// 发卡投递决策（aven 2026-10-13：默认用 bot 身份，不行再用 webhook）：群属于某个非默认仓时返回该仓的兜底链——
// webhook（自定义机器人，外部群唯一能进的机器人）与 redirectTo（notifyChatId，私发负责人）。调用方先用 bot 身份发，
// 失败再按 webhook → redirectTo 顺序兜底；默认仓的群返回 null，行为不变。
export const resolveRepoDelivery = (chatId) => {
  const profile = repoProfileForChat(chatId)
  if (!profile) return null
  const webhook = resolveWebhookCredentials(profile, chatId)
  const redirectTo = profile.notifyChatId && profile.notifyChatId !== chatId ? profile.notifyChatId : null
  if (profile.cardsToNotifyOnly && redirectTo) return { repo: profile.key, webhook: null, redirectTo, forceRedirect: true }
  if (!webhook && !redirectTo) return null
  return { repo: profile.key, webhook: webhook || null, redirectTo }
}

// 临时 worktree 的分支名：默认仓沿用 hotfix/<项目号|adhoc>-<后缀>；非默认仓用 <branchPrefix>-<后缀>
//（如 lark/falive-om12ab34），不再拼 projectKey——同仓所有任务共享一个前缀即可按 `git branch --list 'lark/falive-*'` 盘点。
export const tempBranchNameFor = (profile, { project, suffix }) =>
  profile?.isDefault === false
    ? `${profile.branchPrefix}-${suffix}`
    : `hotfix/${project || 'adhoc'}-${suffix}`

// 规则预算 / 模型等「profile 优先、local.json 兜底」的取值助手。
export const resolveScopeBudgets = (profile, localConfig) => profile?.scopeBudgets ?? localConfig?.scopeBudgets ?? null
