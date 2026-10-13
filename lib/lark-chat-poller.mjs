/**
 * 外部群消息轮询器：falive 这类外部群加不了应用机器人，长连接收不到事件，改用 aven 的用户身份
 * `lark-cli im +chat-messages-list` 定时拉新消息，归一成与长连接同形的事件喂给 ingestLarkEvent。
 *
 * 频率（aven 2026-10-12 定，见 lark-repo-profile DEFAULT_POLL）：
 *   · 工作时段（08:00–19:00）：群里 30 分钟内有新消息 30s，否则 120s；
 *   · 夜间：15min；
 *   · 拉取出错：按 2 倍退避到 15min 封顶，连续失败 10 次给负责人发一次告警，恢复后再发一次恢复通知。
 * 游标 / 已见 id 持久化在 runtime/lark-chat-poller-state.json；首次启动从「现在」开始，不回灌历史。
 * 纯函数（nextDelayMs / chatListMessageToEvent / isPollableMessage）可直测；IO 由 deps 注入。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { buildCardContent } from './lark-cards.mjs'
import { listChatMessages, listThreadMessages, sendChatMessage } from './lark-cli.mjs'
import { larkRuntimeDir } from './lark-paths.mjs'
import { listRepoProfiles } from './lark-repo-profile.mjs'

const SEEN_LIMIT = 2000
// 旧话题补抓：列消息接口按「话题首条」的时间过滤，老话题里新冒出来的回复不在窗口内。
// 对最近 3 天活跃过的话题（最多 30 个）每轮单独拉一次回复，去重后喂入。
const THREAD_ACTIVE_MS = 3 * 24 * 60 * 60_000
const THREAD_POLL_LIMIT = 30

// 下一次拉取间隔。now 为本地时间（Date），lastNewMessageAt 为该群最近一次拉到新消息的时间戳。
export const nextDelayMs = ({ poll, now = new Date(), lastNewMessageAt = 0, consecutiveFailures = 0 }) => {
  if (consecutiveFailures > 0) {
    // 退避：activeMs × 2^(n-1)，封顶 errorMaxMs（30s → 60s → 2min → 4min → 8min → 15min）。
    return Math.min(poll.errorMaxMs, poll.activeMs * 2 ** Math.min(consecutiveFailures - 1, 10))
  }
  const hour = now.getHours() + now.getMinutes() / 60
  const [start, end] = poll.workHours
  const inWorkHours = hour >= start && hour < end
  if (!inWorkHours) return poll.nightMs
  const recentlyActive = lastNewMessageAt > 0 && now.getTime() - lastNewMessageAt <= poll.activeWindowMs
  return recentlyActive ? poll.activeMs : poll.idleMs
}

// lark-cli 列消息的形态 → 与长连接事件同形（normalizeMessage 能吃的拍平顶层结构）。
// 列消息的 content 已是人类可读文本（图片 / 文件是占位标记），mentions 为 { id, key, name }。
export const chatListMessageToEvent = (message, { chatId }) => ({
  message_id: message.message_id,
  chat_id: message.chat_id || chatId,
  chat_type: 'group',
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

// 列消息会把话题回复展开在 host.thread_replies 里：拍平成独立消息，并补上 root_id / thread_id 指回 host，
// 让 ingest 能按「回复了原消息 / 同话题」合并上下文、按话题归并任务。
export const flattenThreadReplies = (message) => {
  const replies = Array.isArray(message?.thread_replies) ? message.thread_replies : []
  return replies.map((reply) => ({
    ...reply,
    root_id: reply.root_id || message.message_id,
    thread_id: reply.thread_id || message.thread_id || null,
    parent_id: reply.parent_id || message.message_id,
  }))
}

// 只喂真人消息：bot / app（含自家 webhook 卡片）与系统消息直接丢；已撤回的也丢。
export const isPollableMessage = (message) => {
  if (!message || !message.message_id) return false
  if (message.deleted) return false
  const senderType = message.sender?.sender_type || message.sender_type || 'user'
  if (senderType !== 'user') return false
  return message.msg_type !== 'system'
}

// create_time 可能是毫秒字符串或 ISO；统一成毫秒数，解析不了返回 0。
export const toEpochMs = (value) => {
  if (value == null || value === '') return 0
  const asNumber = Number(value)
  if (Number.isFinite(asNumber)) return asNumber < 1e12 ? asNumber * 1000 : asNumber
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed : 0
}

const createPollerState = (statePath) => {
  mkdirSync(dirname(statePath), { recursive: true })
  let data = { chats: {} }
  if (existsSync(statePath)) {
    try {
      data = JSON.parse(readFileSync(statePath, 'utf8'))
      if (!data || typeof data !== 'object' || !data.chats) data = { chats: {} }
    } catch {
      data = { chats: {} }
    }
  }
  const persist = () => writeFileSync(statePath, JSON.stringify(data, null, 2), { mode: 0o600 })
  return {
    chat(chatId) {
      if (!data.chats[chatId]) data.chats[chatId] = { cursorMs: 0, seen: [], lastNewMessageAt: 0, threads: {} }
      if (!data.chats[chatId].threads) data.chats[chatId].threads = {}
      return data.chats[chatId]
    },
    persist,
  }
}

export const startChatPoller = ({
  config,
  store,
  ingest,
  statePath = join(larkRuntimeDir, 'lark-chat-poller-state.json'),
  deps = {},
}) => {
  const list = deps.listChatMessages || listChatMessages
  const listThread = deps.listThreadMessages || listThreadMessages
  const send = deps.sendChatMessage || sendChatMessage
  const now = deps.now || (() => new Date())
  const setTimer = deps.setTimeout || setTimeout
  const state = createPollerState(statePath)
  const timers = new Map()
  const observations = new Map()
  let stopped = false

  const targets = listRepoProfiles()
    .filter((profile) => !profile.isDefault && profile.poll?.enabled && profile.chatIds.length)
    .flatMap((profile) => profile.chatIds.map((chatId) => ({ chatId, profile })))

  const alert = async (profile, lines, key) => {
    const chatId = profile.notifyChatId || profile.chatIds[0]
    if (!chatId) return
    try {
      await send({
        chatId,
        card: buildCardContent({ config, kind: 'alert', lines, project: profile.projectKey, projectTitle: profile.title || '' }),
        logPrefix: 'chat-poller alert',
        idempotencyKey: key,
      })
    } catch (error) {
      console.error(`[lark-gateway] chat-poller 告警发送失败：${String(error).slice(0, 120)}`)
    }
  }

  const pollOnce = async ({ chatId, profile }) => {
    const chat = state.chat(chatId)
    const obs = observations.get(chatId) || { consecutiveFailures: 0, alerted: false, lastPolledAt: 0, lastError: null, polled: 0, ingested: 0 }
    observations.set(chatId, obs)
    // 首次启动：游标从现在开始，不回灌历史（历史消息里的 @ 早已过时，回灌会把旧讨论当新任务建）。
    if (!chat.cursorMs) chat.cursorMs = now().getTime()
    // 多拉 2 分钟的重叠窗口，靠 seen 去重，防止时钟 / 服务端落库顺序让边界消息漏掉。
    const start = new Date(Math.max(0, chat.cursorMs - 120_000)).toISOString()
    const seen = new Set(chat.seen || [])
    let pageToken = null
    let newest = chat.cursorMs
    let fresh = 0
    const feed = async (message) => {
      const id = message.message_id
      if (!id || seen.has(id)) return
      seen.add(id)
      const createdMs = toEpochMs(message.create_time)
      newest = Math.max(newest, createdMs)
      // 记录话题活跃度（host 与回复都算），供下方补抓旧话题。
      if (message.thread_id) {
        const thread = chat.threads[message.thread_id] || { hostMessageId: message.root_id || message.message_id, lastActivityMs: 0 }
        thread.lastActivityMs = Math.max(thread.lastActivityMs, createdMs || now().getTime())
        chat.threads[message.thread_id] = thread
      }
      if (!isPollableMessage(message)) return
      fresh += 1
      try {
        await ingest({ raw: chatListMessageToEvent(message, { chatId }), config, store })
        obs.ingested += 1
      } catch (error) {
        console.error(`[lark-gateway] chat-poller ingest ${id} 失败：${String(error?.message || error).slice(0, 160)}`)
      }
    }
    try {
      for (let page = 0; page < 10; page += 1) {
        const result = await list({ chatId, start, pageToken, identity: 'user' })
        if (!result.ok) throw Object.assign(new Error(result.reason || 'list failed'), { transient: result.transient })
        for (const message of result.messages) {
          await feed(message)
          // 同一页里展开的话题回复：按时间顺序跟在 host 后面喂。
          for (const reply of flattenThreadReplies(message)) await feed(reply)
        }
        if (!result.hasMore || !result.pageToken) break
        pageToken = result.pageToken
      }
      // 旧话题里的新回复不在时间窗口内：对最近活跃的话题单独拉一次最新回复（失败不算整轮失败，只记日志）。
      const cutoff = now().getTime() - THREAD_ACTIVE_MS
      const activeThreads = Object.entries(chat.threads)
        .filter(([, thread]) => thread.lastActivityMs >= cutoff)
        .sort((a, b) => b[1].lastActivityMs - a[1].lastActivityMs)
        .slice(0, THREAD_POLL_LIMIT)
      for (const [threadId, thread] of activeThreads) {
        const replies = await listThread({ threadId, identity: 'user' })
        if (!replies.ok) {
          console.warn(`[lark-gateway] chat-poller 话题 ${threadId} 补抓失败：${replies.reason}`)
          continue
        }
        for (const reply of [...replies.messages].reverse()) {
          await feed({ ...reply, root_id: reply.root_id || thread.hostMessageId, thread_id: reply.thread_id || threadId, parent_id: reply.parent_id || thread.hostMessageId })
        }
      }
      for (const [threadId, thread] of Object.entries(chat.threads)) {
        if (thread.lastActivityMs < cutoff) delete chat.threads[threadId]
      }
      obs.polled += 1
      obs.lastPolledAt = now().getTime()
      obs.lastError = null
      if (obs.consecutiveFailures >= profile.poll.alertAfterFailures || obs.alerted) {
        await alert(profile, [`**详情**：群 ${chatId} 的消息轮询已恢复（此前连续失败 ${obs.consecutiveFailures} 次）。`], `chat-poller-recovered-${chatId}-${Date.now()}`)
      }
      obs.consecutiveFailures = 0
      obs.alerted = false
      if (fresh > 0) chat.lastNewMessageAt = now().getTime()
      chat.cursorMs = Math.max(chat.cursorMs, newest)
      chat.seen = [...seen].slice(-SEEN_LIMIT)
      state.persist()
    } catch (error) {
      obs.consecutiveFailures += 1
      obs.lastError = String(error?.message || error).slice(0, 200)
      console.error(`[lark-gateway] chat-poller ${chatId} 第 ${obs.consecutiveFailures} 次失败：${obs.lastError}`)
      if (obs.consecutiveFailures === profile.poll.alertAfterFailures && !obs.alerted) {
        obs.alerted = true
        await alert(profile, [`**详情**：群 ${chatId}（${profile.title || profile.key}）的消息轮询已连续失败 ${obs.consecutiveFailures} 次，期间群里的 @ 与文档都收不到。最近错误：${obs.lastError}。请检查 lark-cli 用户登录态 / im scope。`], `chat-poller-failed-${chatId}-${obs.consecutiveFailures}`)
      }
    }
    return obs
  }

  const schedule = (target) => {
    if (stopped) return
    const chat = state.chat(target.chatId)
    const obs = observations.get(target.chatId) || { consecutiveFailures: 0 }
    const delay = nextDelayMs({ poll: target.profile.poll, now: now(), lastNewMessageAt: chat.lastNewMessageAt, consecutiveFailures: obs.consecutiveFailures })
    const timer = setTimer(async () => {
      await pollOnce(target)
      schedule(target)
    }, delay)
    timer.unref?.()
    timers.set(target.chatId, timer)
  }

  for (const target of targets) {
    console.log(`[lark-gateway] chat-poller 启动：群 ${target.chatId}（repo ${target.profile.key}，用户身份轮询）`)
    schedule(target)
  }
  if (!targets.length) console.log('[lark-gateway] chat-poller 未启动：没有配置 chatIds 的仓库 profile')

  return {
    targets: targets.map((target) => ({ chatId: target.chatId, repo: target.profile.key })),
    pollOnce,
    observe: () => Object.fromEntries([...observations].map(([chatId, obs]) => [chatId, { ...obs }])),
    stop() {
      stopped = true
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    },
  }
}
