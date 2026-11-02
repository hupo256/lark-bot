/**
 * 对话包（从 falive 阶段 4 搬来，11-01 对话层改）：@bot / 私信时机械地把「它在接谁的哪句话」拉齐，再让分类器判——
 *   · 默认锚点：同一个人 + bot 对他最后一句在 15 分钟内 + 本条短（≤ 20 字）且带指代（重跑 / 这个 / 可以了…）且没引用
 *     → 默认接那条，分类器只确认或否决（continues）。
 *   · 这个人正在进行的事：他 2 小时内的任务、bot 最近对他说的话（发件簿）。
 *   · 最近 7 天这个群里已有的任务：分类器判本条是延续（continues）、相关（relatedTaskId）还是新主题。
 * 多人同时聊时先在同一发送人的对话里找，再看引用 / 话题；不同人各自一条线，互不串。
 * falive 2026-10-15 真机：Arthur「@Aven.Bot 重跑一次」，1 分钟前 bot 刚说「需要的话我重跑一次」，分类器答「没看出是哪条」。
 * 11-01 aven：「有哪些差别」丢上文判成新需求——非话题消息也要带前文，短指代句默认接 bot 上一句。
 *
 * 与 falive 的差别：去台账、去 repo；buildConversationData 只产数据（存进 task.conversation、回放可用），文本块由 render* 纯函数渲染。
 */
import { clipText } from './lark-chat-context.mjs'
import { listOutbox, localHHMM } from './lark-outbox.mjs'

export const ANCHOR_WINDOW_MS = 15 * 60_000
export const ANCHOR_MAX_CHARS = 20
export const ACTIVITY_WINDOW_MS = 2 * 60 * 60_000
const CANDIDATE_WINDOW_MS = 7 * 24 * 60 * 60_000
const DEICTIC_RE = /(重跑|再跑|再试|再测|重测|再来|重新|这个|那个|这条|那条|上面|刚才|还是|不对|不行|可以了|好了|行了|搞定|继续|再看看|试一下|看一下|怎么样|呢|吗|ok|OK|好的|收到|\?|？)/
const CANDIDATE_STATUS_SKIP = new Set(['superseded', 'ignored', 'intake_failed'])

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

const summaryOf = (task) => oneLine(task.summary || task.text, 80)
const newestFirst = (key) => (a, b) => (String(a[key] || '') < String(b[key] || '') ? 1 : -1)

// 没有 store.listRecentForChat 时（旧 store / 测试桩）按同样口径从 store.list() 算：同群、不是被归并 / 忽略 / 分类失败的、7 天内，新的在前。
const fallbackRecent = (store, { chatId, excludeId, sinceMs, limit }) => store.list()
  .filter((task) => task.chatId === chatId && task.id !== excludeId && !CANDIDATE_STATUS_SKIP.has(task.status) && Date.parse(task.updatedAt || task.createdAt || '') >= sinceMs)
  .sort(newestFirst('updatedAt'))
  .slice(0, limit)

// 组对话包：从任务库 / 发件簿取材料（I/O 都在这里），返回纯数据：锚点、这个人正在进行的事、本群候选任务。
export const buildConversationData = ({ store, msg, nowMs = Date.now() }) => {
  const operator = msg?.senderOpenId
  const chatId = msg?.chatId
  if (!operator || !chatId) return { anchor: null, activity: { outbox: [], tasks: [] }, candidates: [] }
  const sinceMs = nowMs - ACTIVITY_WINDOW_MS
  const weekOutbox = listOutbox({ chatId, sinceMs: nowMs - CANDIDATE_WINDOW_MS })
  const outbox = weekOutbox
    .filter((entry) => Date.parse(entry.at || '') >= sinceMs && (entry.to === operator || (entry.mentions || []).includes(operator)))
    .slice(-3)
    .reverse()
  const tasks = store.list()
    .filter((task) => task.id !== msg.messageId && task.chatId === chatId && task.operator === operator && Date.parse(task.createdAt || '') >= sinceMs)
    .sort(newestFirst('createdAt'))
    .slice(0, 5)
  // bot 对每条任务最后说的一句（发件簿新的在后）：候选列表里带上，分类器才知道「那条任务 bot 答到哪了」。
  const botSaidByTask = new Map()
  for (const entry of weekOutbox) if (entry.taskId && !entry.gated) botSaidByTask.set(entry.taskId, oneLine(entry.text, 120))
  const recent = typeof store.listRecentForChat === 'function'
    ? store.listRecentForChat(chatId, { excludeId: msg.messageId, days: 7, limit: 15 })
    : fallbackRecent(store, { chatId, excludeId: msg.messageId, sinceMs: nowMs - CANDIDATE_WINDOW_MS, limit: 15 })
  const candidates = recent.map((task) => ({
    id: task.id,
    summary: summaryOf(task),
    status: task.status,
    deliverable: task.contract?.deliverable ?? null,
    createdAt: task.createdAt || null,
    botSaid: botSaidByTask.get(task.id) || null,
  }))
  const anchor = resolveDefaultAnchor({ text: msg.text, replyTo: msg.replyTo, lastOutbox: outbox[0] || null, nowMs })
  return {
    anchor,
    activity: {
      outbox: outbox.map((entry) => ({ at: entry.at, phase: entry.phase || null, topic: entry.topic || null, text: flatten(entry.text) })),
      tasks: tasks.map((task) => ({ id: task.id, summary: summaryOf(task), status: task.status, createdAt: task.createdAt || null })),
    },
    candidates,
  }
}

// —— 文本块（纯函数，给分类器提示用；没有材料返回空串）——

export const renderAnchorBlock = (anchor) => (anchor?.taskId
  ? `【默认接着 bot 上一句】bot ${hhmm(anchor.at)} 对他说（任务 ${anchor.taskId}${anchor.topic ? `，主题 ${anchor.topic}` : ''}）：${anchor.text}\n本条是短指代句，默认是对这句的回应；确认则 continues 填该任务 id、topic 沿用，明显另起一事才不填。`
  : '')

export const renderActivityBlock = ({ senderLabel = '发送人', activity } = {}) => {
  const outbox = activity?.outbox || []
  const tasks = activity?.tasks || []
  const lines = [
    ...outbox.map((entry) => `- ${hhmm(entry.at)} bot 对他说（${entry.phase || '-'}${entry.topic ? `，主题 ${entry.topic}` : ''}）：${flatten(entry.text)}`),
    ...tasks.map((task) => `- 他 ${hhmm(task.createdAt)} 的消息 id=${task.id} 状态=${task.status}：${oneLine(task.summary, 80)}`),
  ]
  return lines.length ? `【${senderLabel} 正在进行的事（任务 / bot 的话 2 小时内；新的在前）】\n${lines.join('\n')}` : ''
}

export const renderCandidateBlock = (candidates = []) => {
  if (!candidates?.length) return ''
  const lines = candidates.map((item) => `- id=${item.id} 状态=${item.status}${item.deliverable ? ` 交付=${item.deliverable}` : ''} 摘要=${oneLine(item.summary, 80)}${item.botSaid ? `｜bot 最后说：${oneLine(item.botSaid, 120)}` : ''}`)
  return `【最近 7 天这个群里已有的任务】（判断本条是不是其中某条的延续 / 补充 / 对它的答复）\n${lines.join('\n')}\n- 是延续（接着那条问 / 补料 / 答它）→ continues 填该 id，topic 沿用它的；相关但另一件事 → relatedTaskId 填该 id、continues=null；新主题 → 都为 null，topic 给一个短的稳定标识。`
}
