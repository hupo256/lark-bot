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

// 与 gateway 约定的本地 API 共享密钥（可选）：配置后所有写请求必须带 x-lark-gateway-secret。
export const gatewaySecret = process.env.LARK_GATEWAY_SECRET || ''
// 写请求要带的鉴权头（无密钥时为空对象），供 worker/poller 客户端复用。
export const secretHeaders = () => (gatewaySecret ? { 'x-lark-gateway-secret': gatewaySecret } : {})
