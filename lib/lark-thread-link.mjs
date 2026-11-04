/**
 * 同话题前一单关联（11-04 事故，aven「bot 要将这几个关联成同一问题，系统性地进行解决」）。
 *
 * 话题 omt_198f3efd1a0f1851：16:08 aven @bot「学习这个邮件，它应该被评为 A 档」建了一单（blocked，后人工关单）；16:38–16:39 评审人 Rou
 * 在话题里连发三条没 @bot 的指示（「bryn 發的可以直接作為a檔的範本」「Key 跟brad 發的可以作為範本建立」「還有Hurley」）；16:40 aven 再 @bot
 * 「obey order of ROU」。话题根是 bot 转发的评分帖、不是任务消息，控制通道锚不上；前一单已关、也不在「挂起」里——于是新单是孤立的，只看得到
 *「obey order of ROU」，Rou 那三条只混在【话题其它回复】里，没人告诉分类器 / 执行器它们就是这一单的要求。
 *
 * 这里只做纯判断与渲染，接线在 lib/lark-ingest.mjs（新单）与 lib/lark-conversation-bundle.mjs（上下文包）：
 *   · findThreadPredecessor：同话题里本条之前最近的一单（任何状态，含已关 / superseded / blocked）；
 *   · splitThreadSince：话题消息按「前一单那条 @ 之后」切开——之后、本条之前的（所有人，含 bot 自己的话）当本单的补充要求；
 *   · 新单：上下文包里带【同话题前一单】和【前一单之后话题里的消息】两块，intake.anchorTaskId 没锚点时补成前一单
 *    （分类成改码 / 对接类就并入它——已关的人工结单不复活，由 lib/lark-routes-intake mergeableTarget 守底线）；
 *   · 续跑（没写「继续任务 <id>」的都算：回挂起卡 / 原消息、话题里唯一活动单、同话题唯一挂起）：把这段消息并进补料，不再只续一句
 *    「obey order of ROU」；拉话题在 lib/lark-control-channel.mjs handleResume 里。
 */

import { toEpochMs } from './lark-message.mjs'

const MINUTE_MS = 60_000
const timeOf = (task) => Date.parse(task?.messageCreatedAt || task?.createdAt || '') || 0

// 本条所在话题的键：thread_id / root_id / reply_to 任一命中任务的 threadRootId，或话题根本身就是那条任务消息。
const threadKeysOf = (msg) => new Set([msg?.threadRootId, msg?.threadId, msg?.replyTo].filter(Boolean))

// 同话题里本条之前最近的一单（任何状态）。没有话题 / 没有前一单 → null。纯函数（store 只读 list）。
export const findThreadPredecessor = ({ msg, store }) => {
  const keys = threadKeysOf(msg)
  if (!keys.size) return null
  const before = msg.createTimeMs || Number.POSITIVE_INFINITY
  const candidates = (store.list?.() || []).filter((task) => task && task.id !== msg.messageId && task.source === 'lark' &&
    (keys.has(task.threadRootId) || keys.has(task.id)) && (timeOf(task) || 0) <= before)
  return candidates.sort((a, b) => timeOf(b) - timeOf(a))[0] || null
}

// 话题消息（pickThreadContext 的结果，正序）按前一单切开：前一单那条 @ 在列表里就按位置切；不在（太早翻出去了 / 它就是话题根）
// 按时间兜底（消息时间只到分钟：同一分钟的算之后，宁可多带一句）。本条之后的不算（拉话题时可能已经有更晚的回复）。纯函数。
export const splitThreadSince = ({ items = [], predecessor, msg }) => {
  if (!predecessor) return { before: items, since: [] }
  const untilMs = msg?.createTimeMs || 0
  const notAfterMsg = (item) => !untilMs || !toEpochMs(item.createTime) || toEpochMs(item.createTime) <= untilMs
  const index = items.findIndex((item) => item.messageId === predecessor.id)
  if (index >= 0) return { before: items.slice(0, index + 1), since: items.slice(index + 1).filter(notAfterMsg) }
  if (predecessor.id === msg?.replyTo) return { before: [], since: items.filter(notAfterMsg) }
  const fromMs = Math.floor(timeOf(predecessor) / MINUTE_MS) * MINUTE_MS
  const after = (item) => toEpochMs(item.createTime) >= fromMs
  return { before: items.filter((item) => !after(item)), since: items.filter((item) => after(item) && notAfterMsg(item)) }
}

// 话题里同事之间在说话（11-04 b3 ep-1019-57332a：Henry「@Encone 用户中心哪些要换接口？」，Encone 没 @ 谁回「稍等，我给你一份」——在 bot 卡片的
// 话题里就成了「回复 bot」，bot 接了句「好，等你的文档」）。本条没 @ 任何人、没带附件，话题里紧挨着的上一条是另一个人 30 分钟内 @ 了本条发送人
//（中间 bot 没插话）→ 在回那个人，返回他的名字（没名字给 open_id）；否则 null。items = pickThreadContext 的结果（正序）。纯函数。
export const ANSWERING_WINDOW_MS = 30 * MINUTE_MS
export const answeringColleague = ({ msg, items = [], windowMs = ANSWERING_WINDOW_MS }) => {
  if (!msg?.senderOpenId || (msg.mentions || []).length || (msg.attachments || []).length) return null
  const untilMs = msg.createTimeMs || 0
  const last = items.filter((item) => item.messageId !== msg.messageId && (!untilMs || toEpochMs(item.createTime) <= untilMs)).at(-1)
  if (!last || last.bot || !last.senderOpenId || last.senderOpenId === msg.senderOpenId || !(last.mentionIds || []).includes(msg.senderOpenId)) return null
  const at = toEpochMs(last.createTime)
  return !untilMs || !at || untilMs - at <= windowMs ? last.sender || last.senderOpenId : null
}

const line = (item) => `${item.sender ? `${item.sender}：` : ''}${item.text || '（附件）'}`
const clip = (text, max) => {
  const flat = String(text || '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}
const stateOf = (task) => {
  if (task.status === 'superseded' && task.closureReason) return `已人工结单（${task.closureReason}）`
  if (task.status === 'superseded' && task.supersededBy) return `已并入 ${task.supersededBy}`
  return task.status
}

// 【同话题前一单】一段：哪一单、什么状态、要的是什么、上一轮停在哪。
export const renderPredecessorBlock = (task) => {
  if (!task) return ''
  const result = clip(task.result, 200)
  return [
    `【同话题前一单】${task.id}（${stateOf(task)}）：${clip(task.summary || task.text, 120) || '（无摘要）'}`,
    result ? `上一轮结果：${result}` : '',
    '本条是同一话题里的后续 @：多半是前一单的延续，按前一单的目标 + 下面的补充要求一起处理；如果明显是另一件事，按新问题处理。',
  ].filter(Boolean).join('\n')
}

// 【前一单之后话题里的消息】：两次 @bot 之间所有人在话题里说的，当本单的补充要求。
export const renderSinceBlock = ({ since = [], predecessor }) => (since.length && predecessor
  ? `【前一单（${predecessor.id}）之后话题里的消息——当作本单的补充要求】\n${since.map(line).join('\n')}`
  : '')

// 续跑补料最多带多少字（从最新往前留，超出的最早那条截断）：话题可能很长、补料会落进任务正文和每轮提示词。条数由拉话题时的 limit（40）兜住。
export const RESUME_SINCE_MAX_CHARS = 4000
const keepNewest = (items) => {
  const kept = []
  let room = RESUME_SINCE_MAX_CHARS
  for (const item of [...items].reverse()) {
    if (room <= 0) break
    kept.unshift(item.text.length > room ? { ...item, text: `${item.text.slice(0, room)}…` } : item)
    room -= item.text.length
  }
  return kept
}

// 续跑补料：本条原话 + 前一单之后话题里还没并进去的消息。跳过：任务正文里已经有的（话题补充 / 上次续跑带过）、这单自己发的 bot 消息
//（回执 / 要材料的卡，task.receipts）、本条回的那张 bot 卡（同话题归并时回的是别的单的卡）、本条及之后的（拉话题时可能已经有更晚的回复；
// 时间只到分钟，按位置切才准）。本条回的是同事的消息（贴的材料）照样带。
export const buildResumeSupplement = ({ msg, task, items = [] }) => {
  const known = String(task?.text || '')
  const ownCards = new Set((task?.receipts || []).map((receipt) => receipt.messageId))
  const at = items.findIndex((item) => item.messageId === msg?.messageId)
  const { since } = splitThreadSince({ items: at >= 0 ? items.slice(0, at) : items, predecessor: task, msg })
  const fresh = keepNewest(since.filter((item) => item.text && !known.includes(item.text) && !ownCards.has(item.messageId) && !(item.bot && item.messageId === msg?.replyTo)))
  const own = String(msg?.text || '').trim()
  return fresh.length ? [own, renderSinceBlock({ since: fresh, predecessor: task })].filter(Boolean).join('\n\n') : own
}
