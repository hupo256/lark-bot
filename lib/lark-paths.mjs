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
// LARK_RUNTIME_DIR：测试把运行态整个指到临时目录（黄金对话测试，10-21 P1）；生产不设。
export const larkRuntimeDir = process.env.LARK_RUNTIME_DIR || join(larkBotRoot, 'runtime')
export const larkLocalConfigPath = join(larkRuntimeDir, 'lark-bot.local.json')
export const larkTasksDir = join(larkRuntimeDir, 'lark-tasks')
// 附件：runtime/lark-attachments/<PR>/<messageId>/；审计：runtime/lark-audits/<PR>/。
// 两个根都按「<根>/<项目>/…」组织，清扫器（lark-retention / pruneStaleAudits）只扫这两个根的直接子目录。
export const larkAttachmentsRoot = join(larkRuntimeDir, 'lark-attachments')
export const larkAuditsRoot = join(larkRuntimeDir, 'lark-audits')

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
