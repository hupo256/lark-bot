/**
 * Lark 组件共享的配置与本地 API 鉴权基座：读配置 JSON、与 Gateway 约定的共享密钥及其请求头。
 * gateway / worker / poller 统一复用，避免各自重复 loadConfig 与 x-lark-gateway-secret 拼装。
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { validateMailRelay } from './lark-mail-relay-routes.mjs'

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
export const configTitleFor = (project, config) => (project && project === config?.project ? config.title : undefined)

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
  if (config.botAppId != null && typeof config.botAppId !== 'string') errors.push('botAppId 必须是字符串（应用 id，cli_ 开头）')
  else if (!config.botAppId) warnings.push('未配 botAppId：开盖补拉回来的 @机器人 消息（mention id 是 cli_ 应用 id）认不出是在叫 bot')
  // 自愈消息（排空重启自检红等）只私信这一个人；没配就只写日志。ou_ 开头 sendChatMessage 才会走 --user-id。
  if (config.notifyOpenId != null && !(typeof config.notifyOpenId === 'string' && config.notifyOpenId.startsWith('ou_'))) {
    errors.push('notifyOpenId 必须是负责人 open_id（ou_ 开头）：自愈消息只私信这个人')
  } else if (!config.notifyOpenId) warnings.push('未配 notifyOpenId：自愈消息（排空重启自检红等）不私信，只写日志')
  if (config.allowedChatIds != null && config.allowedChatIds !== 'auto' && !isStringArray(config.allowedChatIds)) {
    errors.push('allowedChatIds 必须是 "auto" 或字符串数组')
  }
  for (const key of ['allowedOpenIds', 'taskMentionOpenIds', 'internalNames']) {
    if (config[key] != null && !isStringArray(config[key])) errors.push(`${key} 必须是字符串数组`)
  }
  // 对话层（11-01）的可选键：形状不对就拒绝启动，缺省都有默认值。
  if (config.joinGreeting != null && config.joinGreeting !== false && !nonEmptyString(config.joinGreeting)) errors.push('joinGreeting 必须是 false 或一句非空字符串（进群打招呼）')
  if (config.personaPath != null && !nonEmptyString(config.personaPath)) errors.push('personaPath 必须是非空字符串')
  if (config.docIdentity != null && !['bot', 'user'].includes(config.docIdentity)) errors.push('docIdentity 必须是 bot / user（建 Lark 文档用哪个身份）')
  if (config.digest != null && (typeof config.digest !== 'object' || Array.isArray(config.digest))) errors.push('digest 必须是对象 { at: "HH:MM", enabled }')
  else if (config.digest?.at != null && !/^\d{2}:\d{2}$/.test(String(config.digest.at))) errors.push('digest.at 必须是 HH:MM')
  // fameex 日报（11-02，lib/lark-daily-schedule.mjs）：{ enabled（默认 true）, at（默认 19:00）, days（默认 [1..5]，0 = 周日）}。
  const daily = config.dailyReport
  if (daily != null && (typeof daily !== 'object' || Array.isArray(daily))) errors.push('dailyReport 必须是对象 { enabled, at: "HH:MM", days: [1, 2, 3, 4, 5] }')
  else if (daily != null) {
    if (daily.enabled != null && typeof daily.enabled !== 'boolean') errors.push('dailyReport.enabled 必须是 true / false')
    if (daily.at != null && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(daily.at))) errors.push('dailyReport.at 必须是 HH:MM（00:00–23:59）')
    if (daily.days != null && !(Array.isArray(daily.days) && daily.days.length > 0 && daily.days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6))) errors.push('dailyReport.days 必须是 0–6 的整数数组（0 = 周日），不能为空')
  }
  // 闲置群自动退出（11-02，lib/lark-chat-retention.mjs）：{ enabled（默认 true）, idleDays（14）, graceHours（48）, at（09:35）, keep: [chat_id] }。
  const retention = config.chatRetention
  if (retention != null && (typeof retention !== 'object' || Array.isArray(retention))) errors.push('chatRetention 必须是对象 { enabled, idleDays, graceHours, at: "HH:MM", keep: [chat_id] }')
  else if (retention != null) {
    if (retention.enabled != null && typeof retention.enabled !== 'boolean') errors.push('chatRetention.enabled 必须是 true / false')
    for (const key of ['idleDays', 'graceHours']) {
      if (retention[key] != null && !(Number.isFinite(retention[key]) && retention[key] > 0)) errors.push(`chatRetention.${key} 必须是正数`)
    }
    if (retention.at != null && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(retention.at))) errors.push('chatRetention.at 必须是 HH:MM（00:00–23:59）')
    if (retention.keep != null && !isStringArray(retention.keep)) errors.push('chatRetention.keep 必须是 chat_id 字符串数组（这些群永远不自动退）')
  }
  // 审批邮件转群（11-02，lib/lark-mail-relay*.mjs）：{ enabled, routes: [...], cliConfigDir?, stateFile? }，规则在 validateMailRelay。
  errors.push(...validateMailRelay(config.mailRelay))
  if (config.intake != null && (typeof config.intake !== 'object' || Array.isArray(config.intake))) errors.push('intake 必须是对象 { quietGapMs, maxWaitMs, fastLaneMs }')
  if (config.envSites != null && (typeof config.envSites !== 'object' || Array.isArray(config.envSites))) errors.push('envSites 必须是对象 { test, pre, uat, online }')
  // 出网核对（lib/lark-egress-policy）：egress.loginCodeTypes = 发验证码接口里表示「登录」的 type 值（scene=login 这类不用配）。
  if (config.egress?.loginCodeTypes != null && !isStringArray(config.egress.loginCodeTypes)) errors.push('egress.loginCodeTypes 必须是字符串数组（发验证码接口里表示登录的 type 值，如 ["3"]）')
  for (const key of ['ownerMap', 'memberRoles']) {
    if (config[key] != null && (typeof config[key] !== 'object' || Array.isArray(config[key]))) errors.push(`${key} 必须是对象（名字 → open_id / 角色）`)
  }
  // 宿主隔离（S1）：claude 会话只在模型 / 强度钉在本配置里时才切断个人设置（--setting-sources project），
  // 否则继续继承 ~/.claude/settings.json——换台机器（Mac mini）模型 / 强度 / 输出样式就跟着变。
  if (config.claudeSettingSources != null && !nonEmptyString(config.claudeSettingSources)) {
    errors.push('claudeSettingSources 必须是非空字符串（逗号分隔的 user / project / local）')
  } else if ((config.aiExecutor || 'claude') === 'claude' && config.claudeSettingSources == null
    && !((config.claudeModel || config.model) && (config.claudeEffort || config.reasoningEffort))) {
    warnings.push('未钉 claudeModel / claudeEffort：bot 的 claude 会话仍继承本机个人设置（模型 / 强度 / 输出样式 / 个人 skills），换机器行为会变；钉上后自动只读业务仓项目设置')
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
      // 两档调度（aven 2026-11-01 B2）：watch 配了就得是对象；开了但没配通知会话 = 只对账、发现新 bug 慢
      if (bug.watch != null && (typeof bug.watch !== 'object' || Array.isArray(bug.watch))) errors.push('bugTable.watch 必须是对象')
      else if (bug.watch?.enabled === true && !(typeof bug.watch.notifyChatId === 'string' && bug.watch.notifyChatId.startsWith('oc_'))) {
        warnings.push('bugTable.watch.notifyChatId 未配（「你有一个新的Bug」私聊会话 oc_ id）：只能靠对账发现新 bug')
      }
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
