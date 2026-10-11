// 来源：docs_tdd commit 165b070 的 common/engine/agent-scripts/lib/lark-command.mjs（拆仓时只复制 lark-doc 需要的部分）。
// Lark 只读文档抓取的命令构造与安全校验层：只放行 lark-cli 的 read/search/docs-fetch，
// 扫描整条命令拦截写类 token。validateSource 是禁写安全边界。
// 与原文件的差异：本地 markdown 源的路径校验从 docs_tdd 的 resolveDocsPath 改接 lark-paths——
// 只接受存量项目根（legacyPrdsRoot）内已存在的文件；未配置存量根时一律拒绝。
// 由 __tests__/lark-pure.test.mjs、__tests__/lark-doc.test.mjs 覆盖。

import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'

import { legacyPrdsRoot } from '../lark-paths.mjs'

const larkCliBin = process.env.LARK_CLI_BIN || 'lark-cli'

const allowedServices = new Set(['doc', 'docs', 'wiki', 'drive', 'markdown'])
const allowedOperations = new Set(['read', 'search'])
const forbiddenTokenPattern = /(create|update|patch|delete|remove|write|append|upload|send|reply|complete|move|copy|share|permission)/i
const remoteUrlPattern = /^https?:\/\//i

export const isLocalMarkdownSource = (source) => {
  const sourcePath = source.path || source.url
  return source.type === 'markdown' && sourcePath && !remoteUrlPattern.test(sourcePath)
}

export const assertInside = (parent, child, label) => {
  const relative = path.relative(parent, child)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside ${parent}: ${child}`)
  }
}

// 本地 markdown 源：必须是存量项目根内真实存在的文件（realpath 后再判边界，挡住软链逃逸）。
export const resolveLocalMarkdownSource = (source, { prdsRoot = legacyPrdsRoot } = {}) => {
  if (!prdsRoot) throw new Error('local markdown source requires legacyPrdsRoot, which is not configured')
  const input = String(source.path || source.url).trim()
  const candidate = path.isAbsolute(input) ? input : path.resolve(prdsRoot, input)
  if (!existsSync(candidate)) throw new Error(`docs path does not exist: ${candidate}`)
  const real = realpathSync(candidate)
  assertInside(realpathSync(prdsRoot), real, 'local markdown source')
  return real
}

const buildDefaultCommand = (source) => {
  const service = ['doc', 'docs', 'wiki'].includes(source.type) ? 'docs' : source.type
  const operation = source.operation || 'read'
  if (service === 'docs' && operation === 'read') {
    return [larkCliBin, 'docs', '+fetch', '--api-version', 'v2', '--doc', source.url, '--doc-format', 'markdown', '--as', 'user', '--format', 'json']
  }
  const urlFlag = operation === 'search' ? '--query' : '--url'
  return [larkCliBin, service, `+${operation}`, urlFlag, source.url, '--format', 'markdown']
}

const getCommand = (source) => {
  if (Array.isArray(source.command) && source.command.length) return source.command.map(String)
  return buildDefaultCommand(source)
}

export const validateSource = (source) => {
  const type = String(source.type || '')
  const operation = String(source.operation || 'read')

  if (!allowedServices.has(type)) throw new Error(`unsupported Lark source type: ${type}`)
  if (!allowedOperations.has(operation)) throw new Error(`unsupported Lark source operation: ${operation}`)
  if (!source.url) throw new Error(`source ${source.name || '<unnamed>'} requires url`)

  if (isLocalMarkdownSource(source)) {
    resolveLocalMarkdownSource(source)
    return null
  }

  const command = getCommand(source)
  const [binary, service, ...rest] = command
  const commandText = command.join(' ')
  const shortcut = rest.find((token) => token.startsWith('+'))

  if (binary !== 'lark-cli' && binary !== larkCliBin) throw new Error(`only lark-cli is allowed: ${commandText}`)
  if (!allowedServices.has(service)) throw new Error(`lark-cli service is not read-sync allowed: ${service}`)
  if (!shortcut || !['+read', '+search', '+fetch'].includes(shortcut)) {
    throw new Error(`lark-cli command must use +read, +search, or docs +fetch: ${commandText}`)
  }
  if (shortcut === '+fetch' && service !== 'docs') throw new Error(`+fetch is only allowed for docs read sync: ${commandText}`)

  // 禁写校验扫描整条命令的每个 token（不止 shortcut），防止 source.command 里夹带写命令；
  // 排除 source.url 本身以免 URL 路径里的普通词误触发。
  const forbiddenHit = command.filter((token) => token !== source.url).find((token) => forbiddenTokenPattern.test(token))
  if (forbiddenHit) throw new Error(`lark-cli command contains a forbidden write-like token (${forbiddenHit}): ${commandText}`)

  return command
}
