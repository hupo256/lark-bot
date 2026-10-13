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
    tempWorktreeDir: worktreesDir,
    baseRef,
    // 远端 ref 才需要 fetch；本地分支（如 aven 的集成分支）直接用本地 HEAD，不碰网络。
    fetchBase: typeof raw.fetchBase === 'boolean' ? raw.fetchBase : baseRef.startsWith('origin/'),
    branchPrefix: nonEmpty(raw.branchPrefix) || `lark/${normalizedKey}`,
    chatIds: stringArray(raw.chatIds),
    taskMentionOpenIds: stringArray(raw.taskMentionOpenIds),
    webhook: normalizeWebhookConfig(raw.webhook),
    notifyChatId: nonEmpty(raw.notifyChatId) || null,
    docs: stringArray(raw.docs).map((doc) => toAbsolute(doc, root)),
    readableDirs: stringArray(raw.readableDirs).map((dir) => toAbsolute(dir)),
    ruleProfile: nonEmpty(raw.ruleProfile) || normalizedKey,
    installArgs: Array.isArray(raw.installArgs) && raw.installArgs.length ? raw.installArgs.map(String) : null,
    checksHint: nonEmpty(raw.checksHint) || null,
    scopeBudgets: raw.scopeBudgets ?? null,
    ownership: normalizeOwnership(raw.ownership, root),
    ownerMap: raw.ownerMap && typeof raw.ownerMap === 'object' ? raw.ownerMap : {},
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
    table: nonEmpty(raw.table) ? toAbsolute(raw.table, root) : null,
  }
}

const webhookCache = new Map()
// 解析 profile 的 webhook 凭据（file 形态懒读 + 缓存）。返回 { url, secret } 或 null。
export const resolveWebhookCredentials = (profile) => {
  const webhook = profile?.webhook
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

// 发卡投递决策：群属于某个非默认仓时，按 profile 改投——有 webhook 走自定义机器人；否则改投 notifyChatId
// （试运行期先私发给负责人）；两者皆无返回 null，由调用方照常用 bot 身份发（外部群会失败并进回执重试）。
export const resolveRepoDelivery = (chatId) => {
  const profile = repoProfileForChat(chatId)
  if (!profile) return null
  const webhook = resolveWebhookCredentials(profile)
  if (webhook) return { repo: profile.key, webhook }
  if (profile.notifyChatId && profile.notifyChatId !== chatId) return { repo: profile.key, redirectTo: profile.notifyChatId }
  return null
}

// 临时 worktree 的分支名：默认仓沿用 hotfix/<项目号|adhoc>-<后缀>；非默认仓用 <branchPrefix>-<后缀>
//（如 lark/falive-om12ab34），不再拼 projectKey——同仓所有任务共享一个前缀即可按 `git branch --list 'lark/falive-*'` 盘点。
export const tempBranchNameFor = (profile, { project, suffix }) =>
  profile?.isDefault === false
    ? `${profile.branchPrefix}-${suffix}`
    : `hotfix/${project || 'adhoc'}-${suffix}`

// 规则预算 / 模型等「profile 优先、local.json 兜底」的取值助手。
export const resolveScopeBudgets = (profile, localConfig) => profile?.scopeBudgets ?? localConfig?.scopeBudgets ?? null
