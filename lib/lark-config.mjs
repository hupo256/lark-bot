/**
 * Lark 组件共享的配置与本地 API 鉴权基座：读配置 JSON、与 Gateway 约定的共享密钥及其请求头。
 * gateway / worker / poller 统一复用，避免各自重复 loadConfig 与 x-lark-gateway-secret 拼装。
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { repoProfileForProjectKey, validateRepoProfiles } from './lark-repo-profile.mjs'

export const loadConfig = (configPath, label = 'config') => {
  const absolute = resolve(configPath)
  if (!existsSync(absolute)) throw new Error(`Missing ${label}: ${absolute}`)
  return JSON.parse(readFileSync(absolute, 'utf8'))
}

// 与 gateway 约定的本地 API 共享密钥（**必填**）：gateway 缺此值直接拒绝启动，所有写请求必须带
// x-lark-gateway-secret。「只绑 127.0.0.1」不构成边界——本机任一进程都能 POST 触发改代码 / commit / prune。
export const gatewaySecret = process.env.LARK_GATEWAY_SECRET || ''
// 写请求要带的鉴权头（无密钥时为空对象），供 worker/poller 客户端复用。
export const secretHeaders = () => (gatewaySecret ? { 'x-lark-gateway-secret': gatewaySecret } : {})

// 通知/告警发去哪个群的统一兜底链：优先用调用方已知的 chatId（任务自带 / body 传入 / bug 表专属群），
// 否则回落 bug 表配置群，再回落白名单第一个群。原来在 gateway/routes/poller 六处各写一遍这条 `||` 链，
// 改字段名或加一层兜底时容易漏改其中一处，故收口成单一函数。
export const resolveNotifyChatId = (config, preferred) =>
  preferred || config.bugTable?.chatId || config.allowedChatIds?.[0]

// config.title 只属于 config.project 这一个项目：网关是多项目的（按群名/正文解析项目号），
// 别的项目的任务若也挂上它，卡片与 AI 上下文都会把 PR-02233 叫成 PR-01947 的项目名（2026-10-11 真机）。
// 不匹配时返回 undefined，调用方回落到项目号本身。
// 非默认仓的 projectKey（如 FALIVE）取其 profile.title——同样只对该仓自己的任务生效。
export const configTitleFor = (project, config) => {
  if (!project) return undefined
  if (project === config?.project) return config.title
  return repoProfileForProjectKey(project)?.title || undefined
}

const isStringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string')
const nonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0

// 启动期配置结构校验（纯函数，便于直测）：返回 { errors, warnings }。
// 不引 ajv——仓库零运行时依赖，手写守卫比拉一个 schema 引擎更轻、错误信息也更贴使用场景。
// errors 由启动方 fail-closed（缺了会让 gateway / worker 静默跑歪，晚炸不如早拒）；warnings 只提示。
export function validateConfig(config) {
  const errors = []
  const warnings = []
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { errors: ['config 必须是对象'], warnings }
  }
  if (!nonEmptyString(config.project)) errors.push('project 必填且为非空字符串（任务路由与日志都依赖它）')
  if (config.title != null && typeof config.title !== 'string') errors.push('title 必须是字符串')
  if (config.botOpenId != null && typeof config.botOpenId !== 'string') errors.push('botOpenId 必须是字符串')
  if (config.allowedChatIds != null && config.allowedChatIds !== 'auto' && !isStringArray(config.allowedChatIds)) {
    errors.push('allowedChatIds 必须是 "auto" 或字符串数组')
  }
  for (const key of ['allowedOpenIds', 'taskMentionOpenIds']) {
    if (config[key] != null && !isStringArray(config[key])) errors.push(`${key} 必须是字符串数组`)
  }
  // 多仓 profile：结构错（缺 root/baseRef、projectKey 重复、群重复、路径不存在）一律 error——
  // 路由错仓等于在错的代码库上改代码。
  errors.push(...validateRepoProfiles(config))
  return { errors, warnings }
}

// 启动方统一入口：校验不过则打印每条 error 并 process.exit(1)（fail-closed），warnings 仅告警。
export function assertConfigOrExit(config, label = 'config') {
  const { errors, warnings } = validateConfig(config)
  for (const warning of warnings) console.warn(`[${label}] ⚠ ${warning}`)
  if (errors.length) {
    console.error(`[${label}] ✖ 配置校验未通过，拒绝启动：\n${errors.map((error) => `  - ${error}`).join('\n')}`)
    process.exit(1)
  }
}
