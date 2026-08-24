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

const isStringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string')
const nonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0

// 启动期配置结构校验（纯函数，便于直测）：返回 { errors, warnings }。
// 不引 ajv——仓库零运行时依赖，且这里要校验的是「字段齐不齐、类型对不对、bugTable 配了就得配全」
// 这类固定形状，手写守卫比拉一个 schema 引擎更轻、错误信息也更贴使用场景。
// errors 由启动方 fail-closed（缺了会让 gateway/poller 静默跑歪，晚炸不如早拒）；warnings 只提示。
// 真值口径全部对齐消费处：poller 用 appToken/tableId/statusField/assigneeField 拉取与过滤，
// writeback 用 statusField patch、doneValue 缺失时优雅跳过（故 doneValue 只告警不阻断）。
export function validateConfig(config) {
  const errors = []
  const warnings = []
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { errors: ['config 必须是对象'], warnings }
  }
  if (!nonEmptyString(config.project)) errors.push('project 必填且为非空字符串（任务路由与日志都依赖它）')
  if (config.title != null && typeof config.title !== 'string') errors.push('title 必须是字符串')
  if (config.botOpenId != null && typeof config.botOpenId !== 'string') errors.push('botOpenId 必须是字符串')
  else if (!config.botOpenId) warnings.push('未配 botOpenId：@机器人 无法判定为直呼，写任务会退化为只读意图分类（见 lark-message）')
  if (config.allowedChatIds != null && config.allowedChatIds !== 'auto' && !isStringArray(config.allowedChatIds)) {
    errors.push('allowedChatIds 必须是 "auto" 或字符串数组')
  }
  for (const key of ['allowedOpenIds', 'taskMentionOpenIds']) {
    if (config[key] != null && !isStringArray(config[key])) errors.push(`${key} 必须是字符串数组`)
  }
  if (config.bugTable != null) {
    const bug = config.bugTable
    if (typeof bug !== 'object' || Array.isArray(bug)) {
      errors.push('bugTable 必须是对象')
    } else {
      // 配了 bugTable 就要配全轮询/回写依赖的字段——缺任一都会让 poller 静默拉不到或回写打到空字段。
      for (const field of ['appToken', 'tableId', 'statusField', 'assigneeField']) {
        if (!nonEmptyString(bug[field])) errors.push(`bugTable.${field} 必填（poller 拉取/过滤与状态回写依赖它，缺失会静默失败）`)
      }
      if (!nonEmptyString(bug.doneValue)) warnings.push('bugTable.doneValue 未配：完成后无法回写「已处理」状态，任务会停在 done_pending_writeback')
    }
  }
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
