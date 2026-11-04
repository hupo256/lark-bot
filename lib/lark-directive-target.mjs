/**
 * 显式指令（继续任务 / 结单 / 取消任务 / 重开任务 <id>）点名的 id 在本仓任务库里没有时，按上下文认任务（11-04 falive 回放 ep-1021-193c03）。
 *
 * aven 常照着 falive 卡片上的口令回（id 是 falive 的任务 id，也就是他自己那条 @ 消息 / 回复消息的 id），或抄错一两位。原先一律回
 *「没找到任务 / 续不了」，同一句第二次还被出口闸按内容拦掉，等于不回。现在：
 *   · 有且只有一条任务能对上，就按它做，并在回话开头说清认成了哪条：
 *       linked  这个 id 是那条任务处理过的消息（bot 回执、被它续跑 / 结单 / 确认过的人话、并进它的消息）
 *       merged  这个 id 的任务已经并进了另一条
 *       typo    和某条任务 / 关联消息的 id 只差一两位
 *       reply   本条回复的是那条任务的卡片 / 原消息
 *       scope   「继续任务 <id> 确认扩大范围」且只有一条任务在等确认扩大范围
 *   · 对不上或对上不止一条：不猜，列 1–3 条候选（最近在等的）让他回带 id 的口令。
 * 单凭「最近私信过他的那条挂起任务」不算对上：回放里 aven 贴的是 falive 分享卡片任务的 id，那时 lark-bot 唯一挂起的是新闻详情页，
 * 按最近一条认就续错了任务。最近一条只用来给候选排序。
 */

import { headline } from './lark-human-text.mjs'
import { isOpsOwner } from './lark-ops-task.mjs'
import { isScopeApprovalReply } from './lark-scope-contract.mjs'

const PARKED = new Set(['waiting_confirmation', 'blocked'])
const LINKED_MAX = 30
const CANDIDATE_WINDOW_MS = 48 * 60 * 60_000

// 这条消息是对这条任务说的（被控制通道 / 主通道处理过）：记在任务上，之后有人拿这条消息的 id 下指令能认回来。
export const linkMessageToTask = ({ store, taskId, messageId }) => {
  if (!messageId) return
  const task = store?.get?.(taskId)
  if (!task || (task.linkedMessageIds || []).includes(messageId)) return
  task.linkedMessageIds = [...(task.linkedMessageIds || []), messageId].slice(-LINKED_MAX)
  store.upsert?.(task)
}

// 编辑距离（相邻对调算一步）≤ max；长度差超过 max 直接否。id 是 30+ 位随机串，差两位以内撞上别的任务基本不可能。
export const withinEdits = (a = '', b = '', max = 2) => {
  if (a === b || Math.abs(a.length - b.length) > max) return false
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j += 1) d[0][j] = j
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      // 越界下标取到 undefined，和真字符永远不等，i / j = 1 时自然不算对调
      if (a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
    }
  }
  return d[a.length][b.length] <= max
}

const idsOf = (task) => [task.id, ...(task.linkedMessageIds || []), ...(task.mergedFrom || [])]
const lastTouch = (task) => Math.max(Date.parse(task.updatedAt) || 0, ...(task.receipts || []).map((receipt) => Date.parse(receipt.createdAt) || 0))

// 候选：负责人看全部（所有通知都私信他），别人只看自己提的 / 本群的；按动作挑状态，最近动过的在前，最多 3 条。
export const directiveCandidates = ({ msg, store, config, action, now = Date.now() }) => {
  const mine = isOpsOwner(config, msg.senderOpenId)
  const wanted = action === 'reopen'
    ? (task) => task.status === 'superseded' && Boolean(task.externalResolution)
    : (task) => PARKED.has(task.status) || (task.status === 'failed' && (action === 'close' || mine))
  return (store.list?.() || [])
    .filter((task) => wanted(task) && (mine || task.operator === msg.senderOpenId || task.chatId === msg.chatId) && now - lastTouch(task) <= CANDIDATE_WINDOW_MS)
    .sort((a, b) => lastTouch(b) - lastTouch(a))
    .slice(0, 3)
}

// 返回 { task, via }（via=exact 就是点名的那条，调用方照旧处理）或 { task: null, candidates }。
export const resolveDirectiveTarget = ({ msg, store, config, taskId, action, supplementText = '', now = Date.now() }) => {
  const tasks = store.list?.() || []
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const named = byId.get(taskId)
  if (named) {
    const into = named.status === 'superseded' ? tasks.find((task) => (task.mergedFrom || []).includes(taskId)) : null
    return into ? { task: into, via: 'merged' } : { task: named, via: 'exact' }
  }
  const viaOf = new Map()
  const receiptOwner = store.findTaskByAnyReceipt?.(taskId)
  if (receiptOwner) viaOf.set(receiptOwner.id, 'linked')
  for (const task of tasks) if (idsOf(task).includes(taskId)) viaOf.set(task.id, 'linked')
  if (!viaOf.size && taskId.length >= 16) for (const task of tasks) if (idsOf(task).some((id) => withinEdits(id, taskId))) viaOf.set(task.id, 'typo')
  const replyId = msg.replyToDirect || msg.replyTo
  const replied = replyId ? store.findTaskByAnyReceipt?.(replyId) || byId.get(replyId) : null
  const hits = [...viaOf.keys()]
  if (hits.length === 1 && (!replied || replied.id === hits[0])) return { task: byId.get(hits[0]), via: viaOf.get(hits[0]) }
  if (!hits.length) {
    if (replied) return { task: replied, via: 'reply' }
    const scopeAsk = action === 'resume' && isOpsOwner(config, msg.senderOpenId) && isScopeApprovalReply(supplementText)
    const waiting = scopeAsk ? tasks.filter((task) => PARKED.has(task.status) && task.scopeRequest) : []
    if (waiting.length === 1) return { task: waiting[0], via: 'scope' }
  }
  // 对上不止一条（id 认出的和回复的不是同一条、或 id 关联到多条）：把它们列出来；什么都没对上：列最近在等的
  const conflicting = [...new Set([...hits, ...(replied ? [replied.id] : [])])].map((id) => byId.get(id)).filter(Boolean)
  return { task: null, candidates: conflicting.length ? conflicting.slice(0, 3) : directiveCandidates({ msg, store, config, action, now }) }
}

const head = (task) => headline(task) || task.id
const VIA_LABEL = {
  linked: '这个 id 是它的消息',
  merged: '那条已经并进了它',
  typo: 'id 和它只差一两位，像是抄错了',
  reply: '你回复的是它的消息',
  scope: '只有它在等确认扩大范围',
}
// 认成了哪条：放在回话开头（「你给的 X 我这边没有，……，按「标题」处理。」）。
export const mappedLead = ({ taskId, task, via }) => via === 'merged'
  ? `${taskId} 已经并进「${head(task)}」（${task.id}），按这条处理。`
  : `你给的 ${taskId} 我这边没有，${VIA_LABEL[via] || '按上下文'}，按「${head(task)}」（${task.id}）处理。`

const ACTION_WORD = { resume: '续', close: '结单', reopen: '重开' }
const COMMAND = { resume: '继续任务', close: '取消任务', reopen: '重开任务' }
// 对不上：不猜。列候选 + 带 id 的口令；没候选就说清楚。
export const askBackText = ({ taskId, action, candidates = [] }) => {
  const word = ACTION_WORD[action]
  if (!candidates.length) {
    return `没找到任务 ${taskId}（可能是别的 bot 的 id 或抄错了），我这边现在也没有在等你的任务，${word}不了。要做什么直接 @我 说。`
  }
  return [
    `没找到任务 ${taskId}（可能是别的 bot 的 id 或抄错了），这句先没动。你说的是不是这${candidates.length > 1 ? '几' : ''}条：`,
    ...candidates.map((task) => `- 「${head(task)}」：回「${COMMAND[action]} ${task.id}」`),
  ].join('\n')
}
