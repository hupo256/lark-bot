/**
 * 别人复制 bot 以前说过的话来回复（不用飞书的「引用」）：按发件簿找回原消息（aven 2026-10-23）。
 *
 * 10-23 真机：Encone 把 bot 10-22 20:24 结论里的一行「❌ 没接 开播设置里的『语言』下拉…」整段贴过来再接自己的回复，
 * 没有引用关系，上下文按条数 / 时间也可能够不着，bot 不知道「开播的语言」指什么。上下文要按关联取，不按时间窗：
 * 本条原话里有一行能在 bot 发过的群消息里找到，就把那条原消息整条带上（哪天、哪个任务、当时说了什么）。
 */

import { listOutbox } from './lark-outbox.mjs'

// 比对用的规整：去掉 at 标签、@名字、行首的状态标记 / 列表符号、所有空白。
const normalize = (text) => String(text || '')
  .replace(/<at id=[^>]*><\/at>/g, '')
  .replace(/@[A-Za-z0-9_.\-]+(?:\(ou_[A-Za-z0-9]+\))?/g, '') // 只删名字字符：「@Encone请看下」后面的中文不能一起删
  .replace(/[\s　]+/g, '')
const LINE_MARK = /^[\s>*·•\-–—]*(?:[✅❌⚠️➖🚀✔️]️?\s*)*/u
// 够长才比（太短的「收到」「好的」到处都有），按规整后的字数算。
export const MIN_QUOTE_CHARS = 12

// 本条原话里拿来比对的行：去掉行首标记后规整，够长的留下。纯函数。
export const quoteCandidates = (ownText, { minChars = MIN_QUOTE_CHARS } = {}) => [...new Set(String(ownText || '')
  .split('\n')
  .map((line) => normalize(line.replace(LINE_MARK, '')))
  .filter((line) => line.length >= minChars))]

// 在发件记录里找被复制的原消息（新的在前，最多 max 条，同一条只算一次）。纯函数。
export const findQuotedBotMessages = ({ ownText, entries = [], max = 3, minChars = MIN_QUOTE_CHARS }) => {
  const candidates = quoteCandidates(ownText, { minChars })
  if (!candidates.length) return []
  const hits = []
  for (const entry of [...entries].reverse()) {
    if (entry.gated) continue // 出口闸拦下没发出去的，群里没人见过
    const body = normalize(entry.fullText || entry.text)
    const matched = candidates.filter((line) => body.includes(line))
    if (matched.length && !hits.some((hit) => hit.entry.at === entry.at && hit.entry.chatId === entry.chatId)) hits.push({ entry, matched })
    if (hits.length >= max) break
  }
  return hits
}

const readable = (text) => String(text || '').replace(/<at id=[^>]*><\/at>\s*/g, '').trim()
const stamp = (iso) => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// 给任务正文的一块：找不到返回空串。chatIds：该仓所有群（对方可能从别的群复制过来），发件簿保留 7 天。
export const buildQuotedBotBlock = ({ ownText, chatIds = [], sinceMs = Date.now() - 7 * 24 * 60 * 60_000, list = listOutbox }) => {
  const entries = chatIds.flatMap((chatId) => list({ chatId, sinceMs })).sort((a, b) => String(a.at).localeCompare(String(b.at)))
  const hits = findQuotedBotMessages({ ownText, entries })
  if (!hits.length) return ''
  const body = hits.map(({ entry }) => `- bot ${stamp(entry.at)} 在群里说（任务 ${entry.taskId || '-'}${entry.topic ? `，主题 ${entry.topic}` : ''}）：\n${readable(entry.fullText || entry.text)}`).join('\n')
  return `【复制了 bot 之前说的话】本条里有内容和 bot 之前发的群消息一样，对方多半是在接这条说（按原消息理解本条，continues 可填对应任务）：\n${body}`
}
