/**
 * 开盖补拉群消息：机器睡着时长连接是断的；飞书事件推送失败只按 15s / 5min / 1h / 6h 重试 4 次（约 7 小时），
 * 正好落在 Power Nap 半醒窗口的概率很低，合盖一夜的 @ 基本收不到。
 * 做法：每分钟看一次「中间睡过没有 / 盖子合着没有」，记下睡前最后一次醒着的时刻；开盖后用 bot 身份把 bot 所在群
 * 从那一刻（多留 2 分钟重叠）起的消息拉一遍，送进同一条 ingest——任务幂等靠 store（已建过任务的消息直接跳过）。
 * 应用没有读群消息权限时拉取会一直失败：连续 3 次失败就放弃这一窗口并告警一次，不每分钟刷日志。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { listBotChatIds, listChatMessages } from './lark-cli.mjs'
import { larkRuntimeDir } from './lark-paths.mjs'
import { isLidClosed, lastSystemSleepAt } from './lark-power.mjs'

const TICK_MS = 60_000
const OVERLAP_MS = 120_000
const MAX_PAGES = 10
const GIVE_UP_AFTER_FAILURES = 3
// 重启补拉只认 24h 内的「上次活着」时刻：更早的多半是停了很久，拉一天的群消息进 ingest 没意义。
const MAX_RESTART_GAP_MS = 24 * 3600_000

// 「上次活着」时刻（-state.json 不算源码）：每分钟写一次；重启后从它起补拉——排空重启 / 手动 restart 的十来秒里
// 长连接是断的，事件总线不缓存，那一下送来的 @ 以前就丢了（11-02 真机：合代码期间发的实测请求没收到）。
const aliveStatePath = () => join(larkRuntimeDir, 'lark-gateway-alive-state.json')
export const readLastAliveAt = ({ path = aliveStatePath() } = {}) => {
  try {
    const at = Date.parse(JSON.parse(readFileSync(path, 'utf8'))?.at || '')
    return Number.isFinite(at) ? at : null
  } catch {
    return null
  }
}
export const writeLastAliveAt = (at, { path = aliveStatePath() } = {}) => {
  if (!Number.isFinite(at)) return
  try {
    writeFileSync(path, `${JSON.stringify({ at: new Date(at).toISOString() })}\n`)
  } catch {
    // 写不进去只影响下次重启的补拉起点，不影响运行
  }
}

// lark-cli 列消息的形态 → 与长连接事件同形（normalizeMessage 能吃的拍平顶层结构）。纯函数。
export const chatListMessageToEvent = (message, { chatId, chatType = 'group' }) => ({
  message_id: message.message_id,
  chat_id: message.chat_id || chatId,
  chat_type: chatType,
  message_type: message.msg_type,
  content: message.content,
  sender: message.sender || null,
  sender_type: message.sender?.sender_type || message.sender_type || 'unknown',
  sender_id: message.sender?.id || message.sender?.open_id || null,
  mentions: message.mentions || [],
  reply_to: message.parent_id || message.reply_to || null,
  root_id: message.root_id || null,
  thread_id: message.thread_id || null,
  create_time: message.create_time || null,
})

// 列消息会把话题回复展开在 host.thread_replies 里：拍平成独立消息，并补上 root_id / thread_id 指回 host。纯函数。
export const flattenThreadReplies = (message) => {
  const replies = Array.isArray(message?.thread_replies) ? message.thread_replies : []
  return replies.map((reply) => ({
    ...reply,
    root_id: reply.root_id || message.message_id,
    thread_id: reply.thread_id || message.thread_id || null,
    parent_id: reply.parent_id || message.message_id,
  }))
}

// 只喂真人消息：bot / app 与系统消息直接丢；已撤回的也丢。纯函数。
export const isPollableMessage = (message) => {
  if (!message || !message.message_id) return false
  if (message.deleted) return false
  const senderType = message.sender?.sender_type || message.sender_type || 'user'
  if (senderType !== 'user') return false
  return message.msg_type !== 'system'
}

export const startWakeCatchup = ({ config, store, ingest, deps = {} }) => {
  const now = deps.now || Date.now
  const lidClosed = deps.isLidClosed || isLidClosed
  const sleepAt = deps.lastSystemSleepAt || lastSystemSleepAt
  const listChats = deps.listBotChatIds || listBotChatIds
  const list = deps.listChatMessages || listChatMessages
  const readAlive = deps.readLastAliveAt || readLastAliveAt
  const writeAlive = deps.writeLastAliveAt || writeLastAliveAt
  let lastTickAt = now()
  let windowStart = null // 睡前 / 合盖前最后一次醒着的时刻；null = 没有待补的
  let failures = 0

  // 重启补拉：上次活着的时刻在 24h 内 → 当作一个待补窗口，首轮 tick 就补（11-02 复核）。
  const lastAlive = readAlive()
  if (lastAlive && lastTickAt - lastAlive <= MAX_RESTART_GAP_MS) {
    windowStart = lastAlive
    console.log(`[lark-gateway] 重启补拉：上次活着 ${new Date(lastAlive).toISOString()}，首轮补拉这段时间的群消息`)
  }

  // 单个群拉不到（应用没读这个群的权限 / 群已解散）只记一笔、继续别的群；全军覆没才算失败（11-02 复核：
  // 原来一个群失败整轮抛出，三次后放弃，于是有一个没权限的群就永远补不了别的群）。
  const catchUp = async (start) => {
    const chatIds = await listChats()
    const startIso = new Date(Math.max(0, start - OVERLAP_MS)).toISOString()
    let fed = 0
    const failed = []
    for (const chatId of chatIds) {
      let pageToken = null
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const result = await list({ chatId, start: startIso, pageToken })
        if (!result.ok) {
          failed.push(`群 ${chatId}：${result.reason || 'list failed'}`)
          break
        }
        for (const message of result.messages.flatMap((item) => [item, ...flattenThreadReplies(item)])) {
          if (!isPollableMessage(message) || store.has(message.message_id)) continue
          await ingest({ raw: chatListMessageToEvent(message, { chatId }), config, store })
          fed += 1
        }
        if (!result.hasMore || !result.pageToken) break
        pageToken = result.pageToken
      }
    }
    if (failed.length && failed.length === chatIds.length) throw new Error(failed[0])
    if (failed.length) console.warn(`[lark-gateway] 补拉有 ${failed.length} 个群拉不到（跳过）：${failed.slice(0, 3).join('；').slice(0, 200)}`)
    return { chats: chatIds.length, fed, failedChats: failed.length }
  }

  const tick = async () => {
    const at = now()
    const [closed, sleptAt] = await Promise.all([lidClosed(), sleepAt()])
    if (windowStart == null && (closed || (sleptAt && sleptAt > lastTickAt))) windowStart = lastTickAt
    lastTickAt = at
    if (!closed) writeAlive(at)
    if (closed || windowStart == null) return null
    try {
      const outcome = await catchUp(windowStart)
      console.log(`[lark-gateway] 开盖补拉群消息：${outcome.chats} 个群，自 ${new Date(windowStart).toISOString()} 起补送 ${outcome.fed} 条`)
      windowStart = null
      failures = 0
      return outcome
    } catch (error) {
      failures += 1
      if (failures >= GIVE_UP_AFTER_FAILURES) {
        console.warn(`[lark-gateway] 开盖补拉连续 ${failures} 次失败，放弃本窗口（应用可能没有读群消息权限）：${String(error?.message || error).slice(0, 160)}`)
        windowStart = null
        failures = 0
      } else {
        console.warn(`[lark-gateway] 开盖补拉群消息失败（下分钟重试）：${String(error?.message || error).slice(0, 160)}`)
      }
      return null
    }
  }

  const timer = (deps.setInterval || setInterval)(() => { tick().catch(() => {}) }, TICK_MS)
  timer.unref?.()
  return { tick, stop: () => clearInterval(timer) }
}
