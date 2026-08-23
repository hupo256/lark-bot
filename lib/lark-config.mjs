/**
 * Lark 组件共享的配置与本地 API 鉴权基座：读配置 JSON、与 Gateway 约定的共享密钥及其请求头。
 * gateway / worker / poller 统一复用，避免各自重复 loadConfig 与 x-lark-gateway-secret 拼装。
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

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
