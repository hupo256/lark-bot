/**
 * 回复义务（10-21 架构加固 P5）：群里每条 @ 了机器人的消息开一条义务，记它被怎样回应过——回过「收到」没有、
 * 结论发了没有、有没有被扣下等负责人放行。一条群消息只有一份，私聊指示、续跑、重跑都记在同一份上。
 *
 * 为什么：「有且只有一个下文」原来没有对象承载，收到 / 结论 / 兜底 / 放行分散在七八个函数，去重靠任务 id、发件簿时间窗、
 * 锚点各补一层（#11 #22 #26 #36 #44 #52 #56 #57 #58）。10-20：同一条 Encone 的消息因为私聊指示另起了任务，
 * 按任务 id 去重查不到，群里补了两句「这条我拿不准」。
 *
 * 口径（aven 10-21）：群里不再有兜底话术。回过「收到」之后——
 *   · 结论能发 → 发一次（answered）；
 *   · 结论被扣下 / 没做成 → 群里不补话，草稿私聊负责人，回「就这样回」才发（held / owed）；
 *   · 答应了却迟迟没结论（执行器崩了、任务丢了）→ 到期私聊负责人一次，不发群（overdue）。
 *
 * 存储：runtime/lark-obligations/<chatId>.json（任务 24 小时就会被清，义务不能只挂在任务上）；保留 7 天。
 * node --test 下且没指定目录时只存内存，不碰真实运行态。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { larkRuntimeDir } from './lark-paths.mjs'

const KEEP_MS = 7 * 24 * 60 * 60_000
export const OVERDUE_AFTER_MS = 4 * 60 * 60_000
const memory = new Map()

const resolveDir = () => {
  if (process.env.LARK_OBLIGATIONS_DIR) return process.env.LARK_OBLIGATIONS_DIR
  if (process.env.NODE_TEST_CONTEXT && !process.env.LARK_RUNTIME_DIR) return null
  return join(larkRuntimeDir, 'lark-obligations')
}
const fileFor = (dir, chatId) => join(dir, `${String(chatId).replace(/[^\w-]/g, '_')}.json`)
const load = (chatId) => {
  const dir = resolveDir()
  if (!dir) return memory.get(chatId) || {}
  try {
    return JSON.parse(readFileSync(fileFor(dir, chatId), 'utf8')) || {}
  } catch {
    return {}
  }
}
const save = (chatId, data, now = Date.now()) => {
  for (const [id, item] of Object.entries(data)) if (now - (Date.parse(item.updatedAt || '') || now) > KEEP_MS) delete data[id]
  const dir = resolveDir()
  if (!dir) return void memory.set(chatId, data)
  mkdirSync(dir, { recursive: true })
  const file = fileFor(dir, chatId)
  writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2), { mode: 0o600 })
  renameSync(`${file}.tmp`, file)
}

// 一条义务 = 一条群消息：私聊指示任务挂在它针对的那条上，其余任务就是它自己。
export const obligationIdFor = (task) => task?.privateOrigin?.anchorId || task?.id || null

export const getObligation = (task) => {
  const id = obligationIdFor(task)
  return id && task?.chatId ? load(task.chatId)[id] || null : null
}

const update = (task, mutate, now = Date.now()) => {
  const id = obligationIdFor(task)
  if (!id || !task?.chatId) return null
  const data = load(task.chatId)
  const at = new Date(now).toISOString()
  const item = data[id] || { id, chatId: task.chatId, asker: task.operator || null, state: 'open', taskIds: [], createdAt: at }
  if (task.id && !item.taskIds.includes(task.id)) item.taskIds = [...item.taskIds, task.id].slice(-10)
  mutate(item, at)
  item.updatedAt = at
  data[id] = item
  save(task.chatId, data, now)
  return item
}

export const noteAck = ({ task, text, now }) => update(task, (item, at) => {
  item.ackedAt = item.ackedAt || at
  item.ackText = String(text || '').slice(0, 200)
  if (item.state === 'open') item.state = 'acked'
}, now)

export const noteAnswer = ({ task, text, now }) => update(task, (item, at) => {
  item.state = 'answered'
  item.answeredAt = at
  item.answerTaskId = task.id
  item.answerText = String(text || '').slice(0, 300)
  delete item.heldDraft // 有更新的结论发出去了：之前扣下的草稿作废，「就这样回」不再放旧的
}, now)

export const noteHeld = ({ task, text, mentions = [], reason = null, now }) => update(task, (item, at) => {
  item.state = 'held'
  item.heldDraft = { text: String(text || ''), mentions, reason: reason ? String(reason).slice(0, 300) : null, taskId: task.id, at }
}, now)

// 回过「收到」但这次没给出结论（失败 / 没写回复）：群里不补话，记一笔；之后有结论照样发。
export const noteOwed = ({ task, status, now }) => update(task, (item, at) => {
  if (item.state === 'answered') return
  item.state = 'owed'
  item.owedAt = at
  item.owedStatus = status
}, now)

// 「就这样回」要放的草稿（扣下之后又有更新的结论发出去，noteAnswer 已把它作废）。
export const heldDraftFor = (task) => getObligation(task)?.heldDraft?.text ? getObligation(task).heldDraft : null
export const clearHeldDraft = ({ task, now }) => update(task, (item) => { delete item.heldDraft }, now)

// 答应了却迟迟没结论：回过「收到」、过了 afterMs 仍是 acked / open（没答复、没扣下、没记失败）、还没提醒过。
export const listOverdueObligations = ({ chatIds = [], now = Date.now(), afterMs = OVERDUE_AFTER_MS }) => chatIds.flatMap((chatId) =>
  Object.values(load(chatId)).filter((item) => item.state === 'acked' && !item.overdueNotifiedAt && now - (Date.parse(item.ackedAt || '') || now) > afterMs))
export const markOverdueNotified = ({ chatId, id, now = Date.now() }) => {
  const data = load(chatId)
  if (!data[id]) return
  data[id].overdueNotifiedAt = new Date(now).toISOString()
  data[id].updatedAt = data[id].overdueNotifiedAt
  save(chatId, data, now)
}

// 测试用：清空内存存储。
export const resetObligationMemory = () => memory.clear()
