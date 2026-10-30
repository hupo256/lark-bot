/**
 * 阻塞 / 缺材料时发群那段的纯函数（从 lark-repo-delivery 拆出，10-30 体量预算）：哪些条目能给外部看、名字匹配、
 * 两种阻塞（缺材料 / 查到根因在别人）的措辞、标题。取条目（extractBlockers）与定 @ 谁（blockedAskMentions）仍在 lark-repo-delivery。
 */

import { isOffFrontendRootCause } from './lark-status-meta.mjs'

// 引用上下文只概括（aven 2026-10-22）：取第一个分句，不按字数硬截（原来截 40 字，常切在半句中间）。
export const firstClause = (text) => String(text || '').split('\n')[0].split(/[：:。；;]/)[0].trim()

// 阻塞 / 缺材料时群里那段：@ 责任人 + 卡在什么 + 要什么（整改 #12：最该 @ 后端的事不能只私聊负责人）。
// 内部分工（归属 / 负责人 / 不归 aven）不是对方能帮的事，不进群里的「需要你们帮忙」；只留真正要对方提供的材料。
// 内部名单来自 profile.memberRoles（角色含「前端」的同事 + 负责人本人），不再写死人名（第 3 批）。
const INTERNAL_WORDS = /归属|负责人|不归|分工|前端同事/i
// 我方工具 / 环境故障（读不到 Lark 文档、lark-cli、授权、凭证、Worker）也不是对方能帮的事，只私聊负责人
//（10-22 Bug-4944：把半截云文档链接当「需要你们帮忙」@ 了后端，链接谁都打不开）。
const TOOL_FAILURE_WORDS = /Lark 文档读取失败|读不到.{0,6}文档|lark-cli|授权|凭证|Worker|链接不完整/i
export const internalNamePattern = (profile) => {
  const names = Object.entries(profile?.memberRoles || {}).filter(([, role]) => /前端/.test(String(role))).map(([name]) => name)
  const me = [profile?.ownership?.me, ...(profile?.ownership?.meAliases || [])].filter(Boolean)
  const all = [...names, ...me].map((name) => String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return all.length ? new RegExp(all.join('|'), 'i') : null
}
export const externalBlockers = (blockers = [], { profile = null } = {}) => {
  const names = internalNamePattern(profile)
  return blockers.filter((item) => !INTERNAL_WORDS.test(String(item)) && !TOOL_FAILURE_WORDS.test(String(item)) && !(names && names.test(String(item))))
}

// 名字按词边界匹配（ownerMap 里的外部同事在待补充条目里被点名）。
export const nameIn = (text, name) => new RegExp(`(?<![A-Za-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'i').test(text)

// 阻塞分两种（aven 10-30：三条「这边卡住了」里第三条其实已查到后端根因，读起来却像 bot 卡住）：
// 执行器按防线 2 填了 taskState=awaiting_owner_fix 或后端 / 跨层根因 → 「查到根因在你们那边，请处理」；其余是缺材料 → 「需要你们帮忙」。
export const isFixElsewhere = (task) => task?.taskState === 'awaiting_owner_fix' || isOffFrontendRootCause(task?.rootCauseLayer)

// 标题只用问题本身（report.subject / 私聊指示锚的群消息），不回落任务摘要：摘要是分类器写的「谁让 bot 干什么」
//（10-30「aven 转发 Kaiser 报的 online 问题并交给 bot」），对方看不懂。没有标题就只写条目，条目本身要能自明。
const problemHeadline = (task) => task?.report?.subject || (task?.privateOrigin ? firstClause(task.privateOrigin.anchorHead) : null)

export const buildRepoBlockedGroupText = ({ task, mentions = [], blockers = [] }) => {
  const head = problemHeadline(task)
  // 发起人不在 ownerMap 里（没名字）：直接写 at 标签，buildGroupCard 不再替换。
  const who = mentions.length ? `${mentions.map((m) => (m.owner ? `@${m.owner}` : `<at id=${m.openId}></at>`)).join(' ')} ` : ''
  const ask = isFixElsewhere(task) ? '查到根因在你们那边，请处理：' : '需要你们帮忙：'
  const lines = [`${who}${head ? `「${head}」` : ''}${ask}`]
  for (const item of blockers.slice(0, 6)) lines.push(`- ${item}`)
  if (!blockers.length) lines.push('- 具体缺什么见 aven 稍后补充')
  return lines.join('\n')
}
