/**
 * lark-bot 唯一的路径基座：本仓根 / 运行态目录、业务主仓（consumer）、PRD 缓存。
 * 其它模块一律从这里取路径，不再自行推导（拆仓前这些路径来自 docs_tdd 引擎的 roots.mjs）。
 *
 * 优先级口径统一为：env > runtime/lark-bot.local.json > 内置默认值。local.json 读不到/不合法时
 * 静默回落默认值——路径解析不能因为配置缺失而在 import 期抛错（gateway 启动时会另做配置结构校验）。
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 用本文件位置锚定仓库根（lib/ 的上一级），与 cwd / launchd WorkingDirectory 无关。
export const larkBotRoot = dirname(dirname(fileURLToPath(import.meta.url)))
// Lark 单例运行时目录（与 lark-bot.local.json 同级）。任务队列、附件、审计都是跨项目的 bot 运行态，
// 统一落在这里，不再寄生在某个业务 PR 的文档目录下（那样会随该 PR 生命周期被误清、也会把别的项目数据混进去）。
// LARK_RUNTIME_DIR：试跑 / 测试把运行态整个指到别的目录（与生产 runtime 隔离）；生产不设。
export const larkRuntimeDir = process.env.LARK_RUNTIME_DIR || join(larkBotRoot, 'runtime')
export const larkLocalConfigPath = join(larkRuntimeDir, 'lark-bot.local.json')
export const larkTasksDir = join(larkRuntimeDir, 'lark-tasks')
// 端到端时延记账（lib/lark-latency）：gateway 每交付一条终态回执追加一行；scripts/lark-metrics.mjs --latency 读。
export const larkLatencyPath = join(larkRuntimeDir, 'lark-latency.jsonl')
// 附件：runtime/lark-attachments/<PR>/<messageId>/；审计：runtime/lark-audits/<PR>/。
// 两个根都按「<根>/<项目>/…」组织，清扫器（lark-retention / pruneStaleAudits）只扫这两个根的直接子目录。
export const larkAttachmentsRoot = join(larkRuntimeDir, 'lark-attachments')
export const larkAuditsRoot = join(larkRuntimeDir, 'lark-audits')
// 给 worker 里的 AI 按需调用的只读工具（bug 表记录分享链接，从 falive 移植 10-31）。
export const BUG_RECORD_TOOL = join(larkBotRoot, 'tools', 'read-bug-record.mjs')
// 查各环境当前跑的提交（tools/env-version.mjs，只读）：只读答疑 / 实测的 Bash 白名单放行。
export const ENV_VERSION_TOOL = join(larkBotRoot, 'tools', 'env-version.mjs')
// 用配置的测试号登录环境（tools/env-login.mjs，只登录不注册）：代答 / 实测的 Bash 白名单放行；登录态存 runtime/lark-env-login/<环境>.json（0600）。
export const ENV_LOGIN_TOOL = join(larkBotRoot, 'tools', 'env-login.mjs')
export const larkEnvLoginDir = join(larkRuntimeDir, 'lark-env-login')
// 代答 / 实测的出网核对（lib/lark-egress-policy）：curl / wget 壳目录（放 claude 子进程 PATH 最前）与 node 预载。
export const EGRESS_GUARD_BIN_DIR = join(larkBotRoot, 'tools', 'egress-guard', 'bin')
export const EGRESS_GUARD_PRELOAD = join(larkBotRoot, 'tools', 'egress-guard', 'preload.mjs')
// 负责人维护的固定知识（runtime/knowledge/*.md，gitignore）：环境与部署等，只读答疑 / 实测的提示里带上（lib/lark-knowledge）。
export const larkKnowledgeDir = join(larkRuntimeDir, 'knowledge')
// 飞书应用 secret（0600，负责人放；lib/lark-tenant-token 直接读，不进进程环境——worker 起的 AI 子进程会继承整份环境）。
// 应用令牌缓存（0600，gitignore 的 *.local.json）：gateway / worker / poller 共用一枚，lark-cli 不再每个子进程各铸一次。
export const larkAppSecretPath = join(homedir(), '.config', 'fameex-lark', 'lark-app-secret')
export const larkTenantTokenCachePath = join(larkRuntimeDir, 'lark-tenant-token.local.json')

const DEFAULT_CONSUMER_ROOT = '/Users/aven/github/fameex-web'

const expandHome = (value) => {
  if (typeof value !== 'string') return value
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  return value
}

const nonEmpty = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '')

// 只取路径相关的几个键；整份配置的结构校验由 lark-config.validateConfig 在启动时负责。
export const readLocalPathConfig = (configPath = larkLocalConfigPath) => {
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

const toAbsolute = (value) => resolve(expandHome(value))

// 业务主仓（fameex-web）：env LARK_BOT_CONSUMER_ROOT > local.json consumerRoot > 默认。纯函数，可注入。
export const resolveConsumerRoot = ({ env = process.env, localConfig = readLocalPathConfig() } = {}) => {
  const value = nonEmpty(env.LARK_BOT_CONSUMER_ROOT) || nonEmpty(localConfig.consumerRoot) || DEFAULT_CONSUMER_ROOT
  return toAbsolute(value)
}

// PRD 缓存（prd-to-commit 落盘处，只读）：env LARK_BOT_PRD_CACHE > 默认 ~/.prd-cache。
export const resolvePrdCacheRoot = ({ env = process.env } = {}) =>
  toAbsolute(nonEmpty(env.LARK_BOT_PRD_CACHE) || join(homedir(), '.prd-cache'))

const localPathConfig = readLocalPathConfig()
export const consumerRoot = resolveConsumerRoot({ localConfig: localPathConfig })
// worktree 约定：/Users/aven/github/<项目ID>（主仓同级目录）
export const worktreesDir = dirname(consumerRoot)
export const prdCacheRoot = resolvePrdCacheRoot()

// 按项目归档的运行态目录。project 由调用方先经 safeProject 归一（防路径穿越）；空值归入 _adhoc。
export const attachmentsDirFor = (project, messageId) => join(larkAttachmentsRoot, project || '_adhoc', messageId)
export const auditDirFor = (project) => join(larkAuditsRoot, project || '_adhoc')

// 相对路径按 larkBotRoot 解析（入口包装传的 configPath 已是绝对路径，这里只兜底手工调用）。
export const resolveFromLarkBotRoot = (path) => (isAbsolute(path) ? path : join(larkBotRoot, path))
