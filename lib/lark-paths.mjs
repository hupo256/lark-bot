/**
 * lark-bot 唯一的路径基座：本仓根 / 运行态目录、业务主仓（consumer）、PRD 缓存、存量 docs_tdd 项目根。
 * 其它模块一律从这里取路径，不再自行推导（拆仓前这些路径来自 docs_tdd 引擎的 roots.mjs）。
 *
 * 优先级口径统一为：env > runtime/lark-bot.local.json > 内置默认值。local.json 读不到/不合法时
 * 静默回落默认值——路径解析不能因为配置缺失而在 import 期抛错（gateway 启动时会另做配置结构校验）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 用本文件位置锚定仓库根（lib/ 的上一级），与 cwd / launchd WorkingDirectory 无关。
export const larkBotRoot = dirname(dirname(fileURLToPath(import.meta.url)))
// Lark 单例运行时目录（与 lark-bot.local.json 同级）。任务队列、附件、审计都是跨项目的 bot 运行态，
// 统一落在这里，不再寄生在某个业务 PR 的文档目录下（那样会随该 PR 生命周期被误清、也会把别的项目数据混进去）。
export const larkRuntimeDir = join(larkBotRoot, 'runtime')
export const larkLocalConfigPath = join(larkRuntimeDir, 'lark-bot.local.json')
export const larkTasksDir = join(larkRuntimeDir, 'lark-tasks')
// 附件：runtime/lark-attachments/<PR>/<messageId>/；审计：runtime/lark-audits/<PR>/。
// 两个根都按「<根>/<项目>/…」组织，清扫器（lark-retention / pruneStaleAudits）只扫这两个根的直接子目录。
export const larkAttachmentsRoot = join(larkRuntimeDir, 'lark-attachments')
export const larkAuditsRoot = join(larkRuntimeDir, 'lark-audits')

const DEFAULT_CONSUMER_ROOT = '/Users/aven/github/fameex-web'
// 存量 docs_tdd v1/v2 项目（prds/<PR>/）只作可选只读配置项；docs_tdd 冻结后新项目不再落在这里。
const DEFAULT_LEGACY_PRDS_ROOT = '/Users/aven/github/docs_tdd/prds'

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

// 存量项目根：local.json legacyPrdsRoot > 默认。目录不存在时返回 null，所有消费方必须优雅跳过。
export const resolveLegacyPrdsRoot = ({ localConfig = readLocalPathConfig(), exists = existsSync } = {}) => {
  const candidate = toAbsolute(nonEmpty(localConfig.legacyPrdsRoot) || DEFAULT_LEGACY_PRDS_ROOT)
  return exists(candidate) ? candidate : null
}

const localPathConfig = readLocalPathConfig()
export const consumerRoot = resolveConsumerRoot({ localConfig: localPathConfig })
// worktree 约定：/Users/aven/github/<项目ID>（主仓同级目录）
export const worktreesDir = dirname(consumerRoot)
export const prdCacheRoot = resolvePrdCacheRoot()
export const legacyPrdsRoot = resolveLegacyPrdsRoot({ localConfig: localPathConfig })

// 存量项目基目录 <legacyPrdsRoot>/<projectId>；legacyPrdsRoot 不存在时返回 null。
export const resolveLegacyProjectBaseRoot = (projectId, { prdsRoot = legacyPrdsRoot } = {}) => {
  if (typeof projectId !== 'string' || !projectId.trim()) throw new Error('projectId is empty')
  if (!prdsRoot) return null
  return join(resolve(prdsRoot), projectId.trim())
}

// 存量项目实际文档根。复制自 docs_tdd@165b070 common/engine/agent-scripts/lib/roots.mjs 的
// resolveProjectRoot：v2 项目用 active-change.json 指针把实例切到 changes/<changeId>/，没有指针就是基目录。
// 与原实现一致：指针存在但损坏/契约不符时抛错（宁可显式失败，也不把文档写到错的 change 里）。
export const resolveLegacyProjectRoot = (projectId, options = {}) => {
  const baseRoot = resolveLegacyProjectBaseRoot(projectId, options)
  if (!baseRoot) return null
  const pointerFile = join(baseRoot, 'active-change.json')
  if (!existsSync(pointerFile)) return baseRoot
  let pointer
  try {
    pointer = JSON.parse(readFileSync(pointerFile, 'utf8'))
  } catch (error) {
    throw new Error(`${projectId} active-change.json is invalid: ${error.message}`)
  }
  if (pointer?.schemaVersion !== 1 || pointer?.projectId !== projectId || !pointer?.changeId) {
    throw new Error(`${projectId} active-change.json has an invalid contract`)
  }
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(pointer.changeId)) {
    throw new Error('changeId must be 1-48 lowercase letters, numbers, or hyphens')
  }
  return join(baseRoot, 'changes', pointer.changeId)
}

// 按项目归档的运行态目录。project 由调用方先经 safeProject 归一（防路径穿越）；空值归入 _adhoc。
export const attachmentsDirFor = (project, messageId) => join(larkAttachmentsRoot, project || '_adhoc', messageId)
export const auditDirFor = (project) => join(larkAuditsRoot, project || '_adhoc')

// 相对路径按 larkBotRoot 解析（入口包装传的 configPath 已是绝对路径，这里只兜底手工调用）。
export const resolveFromLarkBotRoot = (path) => (isAbsolute(path) ? path : join(larkBotRoot, path))
