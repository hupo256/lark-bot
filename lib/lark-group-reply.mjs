/**
 * 外部群的人话回复（aven 2026-10-13 定，A 方案：以负责人的用户身份发，看起来就是 aven 本人发的）。
 *   · 全部对接完：群里只发一句 ✅ groupReply（+ 分支名）；
 *   · 还有要对方跟进的：把执行器落盘的待确认清单（followUpDoc，随分支提交）从分支里取出来，以文件发进群，
 *     再发一句 @ 对应负责人（followUps[].owner → profile.ownerMap）；
 *   · failed / blocked / waiting 不进群（详细卡只发负责人私聊）。
 * 文末固定署名「— 由 aven 的助手整理」，让群里知道这是 bot 代发。纯函数部分（buildGroupText / resolveMentions）可直测。
 */

import { rmSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'

import { materializeDoc } from './lark-git-read.mjs'

import { runLarkCli, larkCallFailed, formatLarkCliError } from './lark-cli.mjs'
import { repoProfileForChat, repoProfileForTask } from './lark-repo-profile.mjs'
import { recordOutbox } from './lark-outbox.mjs'

const SIGNATURE = '— 由 aven 的助手整理'

// 负责人名字 → open_id：精确命中 key，否则 key 作为关键词包含匹配（群显示名如 ".Ache.l" 含 "Ache"）。
export const resolveMentions = ({ followUps = [], ownerMap = {} }) => {
  const seen = new Set()
  const out = []
  for (const item of followUps || []) {
    const owner = String(item?.owner || '').trim()
    if (!owner) continue
    const lower = owner.toLowerCase()
    const hit = Object.entries(ownerMap).find(([key]) => key.toLowerCase() === lower)
      || Object.entries(ownerMap).find(([key]) => key && (lower.includes(key.toLowerCase()) || key.toLowerCase().includes(lower)))
    if (hit && !seen.has(hit[1])) {
      seen.add(hit[1])
      out.push({ owner: hit[0], openId: hit[1], items: Array.isArray(item.items) ? item.items : [] })
    } else if (!hit) {
      out.push({ owner, openId: null, items: Array.isArray(item.items) ? item.items : [] })
    }
  }
  return out
}

const atTag = (mention) => (mention.openId ? `<at user_id="${mention.openId}">${mention.owner}</at>` : `@${mention.owner}`)

export const buildGroupText = ({ task, mentions = [], hasDoc = false }) => {
  const reply = (task.groupReply || task.summary || '').trim()
  if (!mentions.length) {
    const branch = task.branch ? `（分支 ${task.branch}）` : ''
    return `✅ ${reply}${branch}\n${SIGNATURE}`
  }
  const who = mentions.map(atTag).join(' ')
  const bullet = mentions
    .filter((mention) => mention.items.length)
    .map((mention) => `${mention.owner}：${mention.items.slice(0, 4).join('；')}${mention.items.length > 4 ? '…' : ''}`)
    .join('\n')
  const docLine = hasDoc ? '待确认项见上面的文件。' : ''
  return `${who} ${reply ? `${reply}。` : ''}${docLine}\n${bullet}\n${SIGNATURE}`.replace(/\n{2,}/g, '\n').trim()
}

const sendUserFile = async ({ chatId, dir, file }) => {
  const result = await runLarkCli(['im', '+messages-send', '--chat-id', chatId, '--file', basename(file)], { identity: 'user', cwd: dir })
  return larkCallFailed(result) ? { ok: false, reason: formatLarkCliError(result) } : { ok: true }
}

const sendUserText = async ({ chatId, text }) => {
  const result = await runLarkCli(['im', '+messages-send', '--chat-id', chatId, '--text', text], { identity: 'user' })
  return larkCallFailed(result) ? { ok: false, reason: formatLarkCliError(result) } : { ok: true }
}

export const postGroupSummary = async ({ task, deps = {} }) => {
  const profile = repoProfileForChat(task.chatId) || repoProfileForTask(task)
  // 只对外部群（repo profile 登记的群）且开启了群回复的仓发；私聊 / 手工投递的任务没有群可回。
  if (!profile || profile.isDefault || !profile.groupPostAsUser || !profile.chatIds.includes(task.chatId)) return { ok: false, skipped: true }
  const sendFile = deps.sendUserFile || sendUserFile
  const sendText = deps.sendUserText || sendUserText
  const materialize = deps.materializeDoc || materializeDoc
  const mentions = resolveMentions({ followUps: task.followUps || [], ownerMap: profile.ownerMap })
  let doc = null
  if (task.followUpDoc) {
    doc = await materialize({ root: profile.root, branch: task.branch, path: task.followUpDoc })
    if (!doc) console.warn(`[lark-gateway] ${task.id} 待确认清单 ${task.followUpDoc} 在分支 ${task.branch} 里取不到，只发文字`)
  }
  try {
    if (doc) {
      const sent = await sendFile({ chatId: task.chatId, dir: doc.dir, file: isAbsolute(doc.file) ? doc.file : join(doc.dir, doc.file) })
      if (!sent.ok) console.error(`[lark-gateway] ${task.id} 待确认清单文件发送失败：${sent.reason}`)
    }
    const text = buildGroupText({ task, mentions, hasDoc: Boolean(doc) })
    const sent = await sendText({ chatId: task.chatId, text })
    if (!sent.ok) {
      console.error(`[lark-gateway] ${task.id} 群回复发送失败：${sent.reason}`)
      return { ok: false, reason: sent.reason }
    }
    try {
      recordOutbox({ chatId: task.chatId, taskId: task.id, topic: task.topic || null, phase: 'summary', to: task.operator || null, mentions: mentions.map((item) => item.openId).filter(Boolean), text })
    } catch (error) {
      console.warn(`[lark-gateway] 发件簿记账失败（summary ${task.id}）：${String(error?.message || error).slice(0, 120)}`)
    }
    console.log(`[lark-gateway] ${task.id} 群回复已发（${mentions.length ? `@ ${mentions.map((item) => item.owner).join('、')}` : '一句话'}${doc ? ' + 文件' : ''}）`)
    return { ok: true, mentions: mentions.length, doc: Boolean(doc) }
  } finally {
    if (doc) rmSync(doc.dir, { recursive: true, force: true })
  }
}
