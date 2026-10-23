/**
 * 对话包（阶段 4，2026-10-15）：@ 机器人时机械地把「它在接谁的哪句话」拉齐，再让分类器判——
 *   · 这个人正在进行的事：他 2 小时内的任务、bot 最近对他说的话（发件簿）、他参与的台账条目；
 *   · 默认锚点：同一个人 + bot 对他最后一张卡在 15 分钟内 + 本条短（≤ 20 字）且带指代（重跑 / 这个 / 可以了…）且没引用
 *     → 默认接那条，分类器只确认或否决（continues）。
 * 多人同时聊时先在同一发送人的对话里找，再看引用 / 话题；不同人各自一条线，互不串。
 * 2026-10-15 真机：Arthur「@Aven.Bot 重跑一次」，1 分钟前 bot 刚说「需要的话我重跑一次」，分类器答「没看出是哪条」。
 */
import { clipText } from './lark-chat-context.mjs'
import { listOutbox, localHHMM } from './lark-outbox.mjs'

export const ANCHOR_WINDOW_MS = 15 * 60_000
export const ANCHOR_MAX_CHARS = 20
export const ACTIVITY_WINDOW_MS = 2 * 60 * 60_000
const DEICTIC_RE = /(重跑|再跑|再试|再测|重测|再来|重新|这个|那个|这条|那条|上面|刚才|还是|不对|不行|可以了|好了|行了|搞定|继续|再看看|试一下|看一下|怎么样|呢|吗|ok|OK|好的|收到|\?|？)/

// 给分类器看的时刻与群里人说的「几点那条」对齐，按本地时区（aven 2026-10-20 review：原来是 UTC）。
const hhmm = localHHMM
const flatten = (text) => String(text || '').replace(/<at id=ou_[^>]*><\/at>\s*/g, '').replace(/\s+/g, ' ').trim()
const oneLine = (text, max = 120) => clipText(flatten(text), max)

// 去掉 @ 名字后的正文（判「短指代句」用）。
const bareText = (text) => String(text || '').replace(/@[^\s@]+/g, '').replace(/\s+/g, ' ').trim()

export const resolveDefaultAnchor = ({ text, replyTo = null, lastOutbox = null, nowMs = Date.now(), windowMs = ANCHOR_WINDOW_MS, maxChars = ANCHOR_MAX_CHARS }) => {
  if (replyTo || !lastOutbox?.taskId) return null
  const at = Date.parse(lastOutbox.at || '')
  if (!Number.isFinite(at) || nowMs - at > windowMs || at > nowMs + 60_000) return null
  const bare = bareText(text)
  if (!bare || bare.length > maxChars || !DEICTIC_RE.test(bare)) return null
  return { taskId: lastOutbox.taskId, topic: lastOutbox.topic || null, at: lastOutbox.at, phase: lastOutbox.phase || null, text: flatten(lastOutbox.text) } // bot 自己说的话本来就短，不截
}

// 纯函数：把三类材料排成分类器能读的块。没有材料返回空串。
export const buildSenderActivityBlock = ({ senderLabel = '发送人', tasks = [], outbox = [], ledgerItems = [] }) => {
  const lines = []
  if (outbox.length) lines.push(...outbox.map((entry) => `- ${hhmm(entry.at)} bot 对他说（${entry.phase || '-'}${entry.topic ? `，主题 ${entry.topic}` : ''}）：${flatten(entry.text)}`))
  if (tasks.length) lines.push(...tasks.map((task) => `- 他 ${hhmm(task.createdAt)} 的消息 id=${task.id} 主题=${task.topic || '-'} 状态=${task.status}：${oneLine(task.summary || task.text, 80)}`))
  if (ledgerItems.length) lines.push(...ledgerItems.map((item) => `- 台账 ${item.id}（${item.status}）${oneLine(item.title, 50)}${item.lastEvent?.note ? `｜最近：${oneLine(item.lastEvent.note, 60)}` : ''}`))
  if (!lines.length) return ''
  return `【${senderLabel} 正在进行的事（任务 / bot 的话 2 小时内，台账条目不限；新的在前）】\n${lines.join('\n')}`
}

export const buildAnchorBlock = (anchor) => (anchor
  ? `【默认接着 bot 上一句】bot ${hhmm(anchor.at)} 对他说（任务 ${anchor.taskId}${anchor.topic ? `，主题 ${anchor.topic}` : ''}）：${anchor.text}\n本条是短指代句，默认是对这句的回应；分类器确认则 continues 填该任务 id、topic 沿用。`
  : '')

// 组对话包：从任务库 / 发件簿 / 台账取材料（I/O 都在这里），返回锚点与两个文本块。
export const buildConversationContext = ({ store, ledger = null, repo, msg, senderLabel, nowMs = Date.now() }) => {
  const operator = msg.senderOpenId
  if (!operator || !msg.chatId) return { anchor: null, anchorBlock: '', activityBlock: '' }
  const sinceMs = nowMs - ACTIVITY_WINDOW_MS
  const outbox = listOutbox({ chatId: msg.chatId, sinceMs })
    .filter((entry) => entry.to === operator || (entry.mentions || []).includes(operator))
    .slice(-3)
    .reverse()
  const tasks = store.list()
    .filter((task) => task.id !== msg.messageId && task.repo === repo.key && task.chatId === msg.chatId && task.operator === operator && Date.parse(task.createdAt || '') >= sinceMs)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, 5)
  // 他提起过 / 对接过的条目（台账事件里有他）：bot 推进过（markLedgerItems 把 lastEvent 改成 bot）也照样列，
  // 10-23 #74：intro 工单做完后条目 lastEvent=bot，Encone 第二天 @bot 时这条从他的上下文里消失了。
  const hisItems = new Set((ledger?.events || []).filter((event) => event?.sender === operator).flatMap((event) => (event.items || []).map((item) => item?.id)))
  const ledgerItems = Object.values(ledger?.items || {})
    .filter((item) => item?.lastEvent?.sender === operator || hisItems.has(item?.id))
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .slice(0, 5)
  const lastOutbox = outbox[0] || null
  const anchor = resolveDefaultAnchor({ text: msg.text, replyTo: msg.replyTo, lastOutbox, nowMs })
  return { anchor, anchorBlock: buildAnchorBlock(anchor), activityBlock: buildSenderActivityBlock({ senderLabel, tasks, outbox, ledgerItems }) }
}
