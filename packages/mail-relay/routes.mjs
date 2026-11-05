/**
 * 邮件转发路由（aven 11-02）：一条路由 = 一类审批邮件 → 一个群。纯函数：配置归一、校验、匹配。
 *
 * mailRelay 顶层：{ enabled, routes: [...], mode?: poll | watch, pollMs?, alert?: { openId?, afterFailures? }, cliConfigDir?, stateFile? }
 *   alert：连续读收件箱失败告警（engine.mjs）；cliConfigDir：另一个飞书应用的 lark-cli 凭证目录；stateFile：台账路径。
 *
 * config.mailRelay.routes[] 每条：
 *   { id, enabled?(默认 true), preset?, label?, chatId: "oc_…", scorer?: 评分器 id | null, reply?: true,
 *     match?: { subject?: [正则], subjectNot?: [正则], from?: [地址或 @域名], to?: [地址或 @域名], firstOnly?: true } }
 * 匹配规则：subject 任一命中（且预设的 subjectTest 通过）、subjectNot 都不中、from 任一命中、to（收件 + 抄送）任一命中；没写的条件不限制。
 * firstOnly（默认 true）：只转申请首封——主题不以 Re: / 回复 / 转发…开头、没有 in_reply_to。
 * 多条路由都命中时按顺序取第一条（一封邮件只转一次）。正则不区分大小写。
 */

import { MAIL_PRESETS, MAIL_SCORERS } from './presets.mjs'

export const REPLY_SUBJECT = /^\s*(re|fw|fwd|回复|回覆|答复|转发|轉寄)\s*[:：]/i

const toRegexList = (list) => (Array.isArray(list) ? list.map((source) => new RegExp(source, 'i')) : [])
const lower = (value) => String(value || '').trim().toLowerCase()

// 地址：head_from 对象、{ mail_address }、或 +triage 的 "Name <a@b>" 字符串都认。
export const addressOf = (value) => {
  if (value && typeof value === 'object') return lower(value.mail_address)
  const text = String(value || '')
  return lower((text.match(/<([^>]+)>/) || [])[1] || text)
}
const addressMatches = (address, patterns) => patterns.some((pattern) => (pattern.startsWith('@') ? address.endsWith(pattern) : address === pattern))

// 配置 → 运行用路由（预设合并、正则编译、地址小写）。只收 enabled 的。
export const normalizeRoutes = (relay) =>
  (Array.isArray(relay?.routes) ? relay.routes : [])
    .filter((route) => route && route.enabled !== false)
    .map((route) => {
      const preset = (route.preset && MAIL_PRESETS[route.preset]) || {}
      const match = route.match || {}
      return {
        id: route.id,
        label: route.label || preset.label || route.id,
        chatId: route.chatId,
        scorer: route.scorer !== undefined ? route.scorer : preset.scorer || null,
        reply: route.reply !== false,
        match: {
          subjectTest: preset.match?.subjectTest || null,
          subject: toRegexList(match.subject),
          subjectNot: toRegexList(match.subjectNot),
          from: (match.from || []).map(lower),
          to: (match.to || []).map(lower),
          firstOnly: match.firstOnly !== false,
        },
      }
    })

// partial：+watch 事件 / +triage 只有部分字段（没有抄送、没有 in_reply_to），缺的字段先放行，读全信后再判一次。
export const routeMatches = (route, mail, { partial = false } = {}) => {
  const subject = String(mail?.subject || '')
  const { match } = route
  if (match.subjectTest && !match.subjectTest(subject)) return false
  if (match.subject.length && !match.subject.some((re) => re.test(subject))) return false
  if (match.subjectNot.some((re) => re.test(subject))) return false
  if (match.firstOnly && (REPLY_SUBJECT.test(subject) || String(mail?.in_reply_to || '').trim())) return false
  const from = addressOf(mail?.head_from ?? mail?.from)
  if (match.from.length && !(partial && !from) && !addressMatches(from, match.from)) return false
  const recipients = [...(mail?.to || []), ...(mail?.cc || [])].map(addressOf).filter(Boolean)
  if (match.to.length && !(partial && !mail?.cc) && !recipients.some((address) => addressMatches(address, match.to))) return false
  return true
}

export const matchRoute = (routes, mail, options) => routes.find((route) => routeMatches(route, mail, options)) || null

// 配置校验（网关启动 / 独立进程启动共用）。返回错误数组。
export const validateMailRelay = (relay) => {
  if (relay == null) return []
  if (typeof relay !== 'object' || Array.isArray(relay)) return ['mailRelay 必须是对象 { enabled, routes: [...], mode?, pollMs?, alert?, cliConfigDir?, stateFile? }']
  const errors = []
  if (relay.enabled != null && typeof relay.enabled !== 'boolean') errors.push('mailRelay.enabled 必须是 true / false')
  if (relay.mode != null && !['poll', 'watch'].includes(relay.mode)) errors.push('mailRelay.mode 只能是 poll（默认，定时拉）/ watch（实时监听，只在独立应用里用）')
  if (relay.pollMs != null && !(Number.isFinite(relay.pollMs) && relay.pollMs > 0)) errors.push('mailRelay.pollMs 必须是正数（毫秒）')
  for (const key of ['cliConfigDir', 'stateFile']) {
    if (relay[key] != null && !(typeof relay[key] === 'string' && relay[key].trim())) errors.push(`mailRelay.${key} 必须是非空路径字符串`)
  }
  if (relay.alert != null) {
    if (typeof relay.alert !== 'object' || Array.isArray(relay.alert)) errors.push('mailRelay.alert 必须是对象 { openId?, afterFailures? }')
    else {
      if (relay.alert.openId != null && !/^ou_\w+$/.test(String(relay.alert.openId))) errors.push('mailRelay.alert.openId 必须是 open_id（ou_ 开头）')
      if (relay.alert.afterFailures != null && !(Number.isInteger(relay.alert.afterFailures) && relay.alert.afterFailures > 0)) errors.push('mailRelay.alert.afterFailures 必须是正整数')
    }
  }
  if (relay.routes != null && !Array.isArray(relay.routes)) return [...errors, 'mailRelay.routes 必须是数组']
  const seen = new Set()
  for (const [index, route] of (relay.routes || []).entries()) {
    const at = `mailRelay.routes[${index}]`
    if (!route || typeof route !== 'object' || Array.isArray(route)) {
      errors.push(`${at} 必须是对象`)
      continue
    }
    if (!(typeof route.id === 'string' && route.id.trim())) errors.push(`${at}.id 必须是非空字符串`)
    else if (seen.has(route.id)) errors.push(`${at}.id 重复：${route.id}`)
    else seen.add(route.id)
    if (route.enabled != null && typeof route.enabled !== 'boolean') errors.push(`${at}.enabled 必须是 true / false`)
    if (route.enabled !== false && !/^oc_\w+$/.test(String(route.chatId || ''))) errors.push(`${at}.chatId 必须是群 chat_id（oc_ 开头）`)
    if (route.preset != null && !MAIL_PRESETS[route.preset]) errors.push(`${at}.preset 不认识：${route.preset}（可选：${Object.keys(MAIL_PRESETS).join(' / ')}）`)
    if (route.scorer != null && !MAIL_SCORERS[route.scorer]) errors.push(`${at}.scorer 不认识：${route.scorer}（可选：${Object.keys(MAIL_SCORERS).join(' / ')}，不评分写 null）`)
    if (route.match != null && (typeof route.match !== 'object' || Array.isArray(route.match))) {
      errors.push(`${at}.match 必须是对象`)
    } else if (route.match) {
      for (const key of ['subject', 'subjectNot', 'from', 'to']) {
        const list = route.match[key]
        if (list == null) continue
        if (!(Array.isArray(list) && list.every((item) => typeof item === 'string' && item))) errors.push(`${at}.match.${key} 必须是字符串数组`)
        else if (key.startsWith('subject')) {
          for (const source of list) {
            try {
              new RegExp(source, 'i')
            } catch {
              errors.push(`${at}.match.${key} 正则写错了：${source}`)
            }
          }
        }
      }
      if (route.match.firstOnly != null && typeof route.match.firstOnly !== 'boolean') errors.push(`${at}.match.firstOnly 必须是 true / false`)
    }
    if (!route.preset && route.enabled !== false && !(route.match && (route.match.subject?.length || route.match.from?.length || route.match.to?.length))) {
      errors.push(`${at} 没有预设也没写 match（subject / from / to 至少一项），会把所有邮件都转出去`)
    }
  }
  return errors
}

// 本配置里所有启用路由的目标群（闲置自动退群要豁免它们）。
export const relayChatIds = (relay) => (relay?.enabled ? normalizeRoutes(relay).map((route) => route.chatId).filter(Boolean) : [])
