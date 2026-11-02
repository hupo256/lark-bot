/**
 * 阻塞 / 缺材料时发群那段的纯函数（从 falive lark-blocked-ask 搬来，对话层 11-01）：哪些条目能给外部看、名字匹配、
 * 两种阻塞（缺材料 / 查到根因在别人）的措辞。取条目的来源是结构化结果 outcome.blockers（旧任务从 result 文本里抠）；
 * 定 @ 谁（blockedAskMentions）在 lark-delivery。内部人名读 config.internalNames，不再写死。
 */

import { humanizeLegacyResult, sayBlockedAsk } from './lark-human-text.mjs'
import { isOffFrontendRootCause } from './lark-status-meta.mjs'

// 内部分工（归属 / 负责人 / 不归 aven）不是对方能帮的事，不进群里的「需要你们帮忙」；只留真正要对方提供的材料。
const INTERNAL_WORDS = /归属|负责人|不归|分工|前端同事/i
// 我方工具 / 环境故障（读不到 Lark 文档、lark-cli、授权、凭证、Worker）也不是对方能帮的事，只私信负责人
//（falive 10-22 Bug-4944：把半截云文档链接当「需要你们帮忙」@ 了后端，链接谁都打不开）。
const TOOL_FAILURE_WORDS = /Lark 文档读取失败|读不到.{0,6}文档|lark-cli|授权|凭证|Worker|链接不完整/i
const escapeRe = (name) => String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// 内部名单（config.internalNames：前端同事 + 负责人本人的名字 / 别名）→ 正则；没配返回 null。
export const internalNamePattern = (config) => {
  const names = (config?.internalNames || []).filter(Boolean).map(escapeRe)
  return names.length ? new RegExp(names.join('|'), 'i') : null
}
export const externalBlockers = (blockers = [], { config = null } = {}) => {
  const names = internalNamePattern(config)
  return blockers.filter((item) => !INTERNAL_WORDS.test(String(item)) && !TOOL_FAILURE_WORDS.test(String(item)) && !(names && names.test(String(item))))
}

// 名字按词边界匹配（ownerMap 里的外部同事在待补充条目里被点名）。
export const nameIn = (text, name) => new RegExp(`(?<![A-Za-z0-9])${escapeRe(name)}(?![A-Za-z0-9])`, 'i').test(text)

// 阻塞分两种（aven 10-30：三条「这边卡住了」里第三条其实已查到后端根因，读起来却像 bot 卡住）：
// 执行器按防线 2 填了 taskState=awaiting_owner_fix 或后端 / 跨层根因 → 「查到根因在你们那边，请处理」；其余是缺材料 → 「需要你们帮忙」。
export const isFixElsewhere = (task) => (task?.outcome?.taskState || task?.taskState) === 'awaiting_owner_fix' || isOffFrontendRootCause(task?.outcome?.rootCauseLayer || task?.rootCauseLayer)

// 旧文本结果里的「待补充：a；b」→ 条目数组（没有 outcome 的旧任务兜底）。
export const extractLegacyBlockers = (result) => {
  const line = humanizeLegacyResult(result, { maxLines: 20 }).find((item) => item.startsWith('待补充：'))
  return line ? line.slice(4).split(/[；;]\s*/).map((item) => item.trim()).filter(Boolean) : []
}

// 群里那段：@ 责任人 + 「标题」+ 卡在什么 + 条目（≤ 6）。
export const buildBlockedAskText = ({ task, mentions = [], blockers = [] }) => sayBlockedAsk({ task, mentions, items: blockers, fixElsewhere: isFixElsewhere(task) })
