/**
 * 外部群消息轮询器：falive 这类外部群加不了应用机器人，长连接收不到事件，改用 aven 的用户身份
 * `lark-cli im +chat-messages-list` 定时拉新消息，归一成与长连接同形的事件喂给 ingestLarkEvent。
 *
 * 频率（aven 2026-10-12 定，见 lark-repo-profile DEFAULT_POLL）：
 *   · 工作时段（08:00–19:00）：群里 30 分钟内有新消息 30s，否则 120s；
 *   · 夜间：15min；
 *   · 拉取出错：按 2 倍退避到 15min 封顶，连续失败 10 次给负责人发一次告警，恢复后再发一次恢复通知。
 *   · 跨睡眠的失败不计数：机器合盖睡眠时 Power Nap 每 15–20 分钟半醒几十秒，轮询在半醒窗口里发出、
 *     没返回又睡了，醒来 TCP 已断 → 超时 / TLS 错。这类失败不是登录态 / 网络问题，只记 sleepInterrupted。
 * 游标 / 已见 id 持久化在 runtime/lark-chat-poller-state.json；首次启动从「现在」开始，不回灌历史。
 * 纯函数（nextDelayMs / chatListMessageToEvent / isPollableMessage）可直测；IO 由 deps 注入。
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { buildCardContent } from './lark-cards.mjs'
import { toEpochMs } from './lark-message.mjs'
import { isChatMember, listChatMessages, listThreadMessages, sendChatMessage } from './lark-cli.mjs'
import { larkRuntimeDir } from './lark-paths.mjs'
import { writeJsonAtomic } from './lark-fs.mjs'
import { isLidClosed, lastSystemSleepAt } from './lark-power.mjs'
import { isRepoOnlyInstance } from './lark-constants.mjs'
import { listRepoProfiles } from './lark-repo-profile.mjs'

const SEEN_LIMIT = 2000
// 旧话题补抓：列消息接口按「话题首条」的时间过滤，老话题里新冒出来的回复不在窗口内。
// 对最近 5 天活跃过的话题（aven 2026-10-13 定）（最多 30 个）每轮单独拉一次回复，去重后喂入。
const THREAD_ACTIVE_MS = 5 * 24 * 60 * 60_000
// 第 1 批降频：每轮最多补 5 个话题；2 小时内有活动或仍有未了结任务的每轮补，其余每 30 分钟轮转一次。
const THREAD_POLL_LIMIT = 5
const THREAD_HOT_MS = 2 * 60 * 60_000
const THREAD_COLD_POLL_MS = 30 * 60_000
// 6 小时回看仍每 threadScanEveryMs（2 分钟）一次——老消息上新开话题里的 @ 要尽快看到；但每次最多翻 3 页（原 10 页）。
const THREAD_SCAN_MAX_PAGES = 3
// health / 体检只在连续失败到这个次数才报（退避 30s → 60s → 2min，约 1.5 分钟一直失败）；单次抖动轮询自己会恢复。
export const POLL_WARN_AFTER_FAILURES = 3
// 合盖暂停期间的复查间隔。睡眠时定时器不触发，醒来时已过期的定时器立刻触发——开盖即补拉，不用等夜间 15min。
const LID_RECHECK_MS = 60_000

// 入睡时间采样搬到 lib/lark-power.mjs（30s 缓存、与开盖补拉共用）；这里只做转出口，旧引用不变。
export { lastSystemSleepAt, parseKernSleepTime } from './lark-power.mjs'

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

// create_time 解析统一在 lark-message.mjs（normalizeMessage 也要用）；这里转出口，旧引用不变。
export { toEpochMs }

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
  const persist = () => writeJsonAtomic(statePath, data)
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
  const botIsMember = deps.isChatMember || isChatMember
  const listThread = deps.listThreadMessages || listThreadMessages
  const send = deps.sendChatMessage || sendChatMessage
  const now = deps.now || (() => new Date())
  const setTimer = deps.setTimeout || setTimeout
  const sleepAt = deps.lastSystemSleepAt || lastSystemSleepAt
  const lidClosed = deps.isLidClosed || isLidClosed
  const state = createPollerState(statePath)
  const timers = new Map()
  const observations = new Map()
  let stopped = false

  const targets = listRepoProfiles()
    .filter((profile) => !profile.isDefault && profile.poll?.enabled && profile.chatIds.length)
    .flatMap((profile) => [
      ...profile.chatIds.map((chatId) => ({ chatId, profile })),
      // repo-only 实例没有应用机器人私聊：负责人控制台群（notifyChatId 为 oc_ 群）当私聊轮询，消息按 p2p 进 ingest。
      ...(isRepoOnlyInstance() && String(profile.notifyChatId || '').startsWith('oc_') && !profile.chatIds.includes(profile.notifyChatId)
        ? [{ chatId: profile.notifyChatId, profile, chatType: 'p2p' }]
        : []),
    ])

  const alert = async (profile, lines, key) => {
    // 只发负责人控制台；没配 notifyChatId 就不发，绝不回落到外部群（aven 2026-10-20 review）。
    const chatId = profile.notifyChatId
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

  // since：排程时的真实墙钟（schedule 传入；不跟 deps.now 走，测试注入的 now 是冻结的假时间）。
  // 等定时器期间睡过、醒来网络没就绪也算跨睡眠；直接调用不传则从本轮开始算。
  const pollOnce = async ({ chatId, profile, chatType = 'group', since = Date.now() }) => {
    const chat = state.chat(chatId)
    const obs = observations.get(chatId) || { consecutiveFailures: 0, alerted: false, lastPolledAt: 0, lastError: null, polled: 0, ingested: 0, skippedBotMember: false, sleepInterrupted: 0, lastSleepError: null }
    observations.set(chatId, obs)
    // 应用机器人已经在群里（开了对外共享后被加进外部群）：消息走长连接推送，本群停止轮询，避免同一条处理两遍。
    // isChatMember 带 TTL 缓存，不会每轮都拉 chat-list；机器人被移出后下一轮自动恢复轮询。
    // repo-only 实例不建长连接，应用机器人在不在群里都照常轮询。
    if (!isRepoOnlyInstance() && await botIsMember(chatId)) {
      if (!obs.skippedBotMember) console.log(`[lark-gateway] chat-poller 群 ${chatId} 已有应用机器人，改走长连接，停止轮询`)
      obs.skippedBotMember = true
      // 游标跟到现在：之后再恢复轮询时不回灌长连接期间已处理过的消息。
      chat.cursorMs = now().getTime()
      state.persist()
      return obs
    }
    // 合盖 = bot 下班（aven 10-17）：不拉、游标不动，开盖后从游标处一次补拉合盖期间的消息。
    if (await lidClosed()) {
      if (!obs.pausedByLid) console.log(`[lark-gateway] chat-poller 群 ${chatId} 合盖，暂停轮询（游标停在 ${new Date(chat.cursorMs || now().getTime()).toISOString()}）`)
      obs.pausedByLid = true
      return obs
    }
    if (obs.pausedByLid) console.log(`[lark-gateway] chat-poller 群 ${chatId} 开盖，补拉合盖期间的消息`)
    obs.pausedByLid = false
    if (obs.skippedBotMember) console.log(`[lark-gateway] chat-poller 群 ${chatId} 机器人已不在群内，恢复轮询`)
    obs.skippedBotMember = false
    // 首次启动：游标从现在开始，不回灌历史（历史消息里的 @ 早已过时，回灌会把旧讨论当新任务建）。
    if (!chat.cursorMs) chat.cursorMs = now().getTime()
    // 多拉 2 分钟的重叠窗口，靠 seen 去重，防止时钟 / 服务端落库顺序让边界消息漏掉。
    const start = new Date(Math.max(0, chat.cursorMs - 120_000)).toISOString()
    const seen = new Set(chat.seen || [])
    let pageToken = null
    let newest = chat.cursorMs
    let fresh = 0
    // ingest 失败的消息不记 seen、游标也不越过它（cursorFloor）：靠下一轮的重叠窗口重喂，不再「打一行日志就永久丢失」。
    let cursorFloor = Infinity
    const feed = async (message) => {
      const id = message.message_id
      if (!id) return
      const createdMs = toEpochMs(message.create_time)
      // 已处理过的也推进 newest：重喂失败那条时窗口里其余消息都已 seen，游标仍要跟到本轮最新。
      newest = Math.max(newest, createdMs)
      if (seen.has(id)) return
      // 记录话题活跃度（host 与回复都算），供下方补抓旧话题。
      if (message.thread_id) {
        const thread = chat.threads[message.thread_id] || { hostMessageId: message.root_id || message.message_id, lastActivityMs: 0 }
        thread.lastActivityMs = Math.max(thread.lastActivityMs, createdMs || now().getTime())
        chat.threads[message.thread_id] = thread
      }
      if (!isPollableMessage(message)) {
        seen.add(id)
        return
      }
      fresh += 1
      try {
        await ingest({ raw: chatListMessageToEvent(message, { chatId, chatType }), config, store })
        obs.ingested += 1
        seen.add(id)
      } catch (error) {
        cursorFloor = Math.min(cursorFloor, createdMs || now().getTime())
        console.error(`[lark-gateway] chat-poller ingest ${id} 失败（下轮重喂）：${String(error?.message || error).slice(0, 160)}`)
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
      // 老消息上新开的话题：host 在增量窗口外，话题回复跟着 host 一起返回、增量页里不会再出现，chat.threads 也不知道它
      // （2026-10-15 真机：aven 在 Encone 15 分钟前的消息上建话题 @Aven.Bot「测试一下，报告回群」，轮询永远看不到）。
      // 每隔 threadScanEveryMs 回看 threadScanWindowMs 内的消息，只喂展开的话题回复（host 早已 seen，feed 直接跳过）。
      if (now().getTime() - (chat.lastThreadScanMs || 0) >= profile.poll.threadScanEveryMs) {
        const scanStart = new Date(Math.max(0, now().getTime() - profile.poll.threadScanWindowMs)).toISOString()
        let scanToken = null
        // 回看只翻 3 页（原 10 页）：6 小时内超过 150 条的群本来就是活跃群，增量窗口会覆盖到。
        for (let page = 0; page < THREAD_SCAN_MAX_PAGES; page += 1) {
          const result = await list({ chatId, start: scanStart, pageToken: scanToken, identity: 'user' })
          if (!result.ok) {
            console.warn(`[lark-gateway] chat-poller 群 ${chatId} 话题回看失败：${result.reason || 'list failed'}`)
            break
          }
          for (const message of result.messages) {
            for (const reply of flattenThreadReplies(message)) await feed(reply)
          }
          if (!result.hasMore || !result.pageToken) break
          scanToken = result.pageToken
        }
        chat.lastThreadScanMs = now().getTime()
      }
      // 旧话题里的新回复不在时间窗口内：对最近活跃的话题单独拉一次最新回复（失败不算整轮失败，只记日志）。
      const cutoff = now().getTime() - THREAD_ACTIVE_MS
      const nowMs = now().getTime()
      const hasOpenTask = (thread) => {
        const host = thread.hostMessageId ? store?.get?.(thread.hostMessageId) : null
        return Boolean(host && !['done', 'done_with_warnings', 'no_change_needed', 'ignored', 'superseded', 'failed', 'intake_failed'].includes(host.status))
          || (store?.listActiveByThread?.(thread.hostMessageId) || []).length > 0
      }
      const activeThreads = Object.entries(chat.threads)
        .filter(([, thread]) => thread.lastActivityMs >= cutoff)
        .filter(([, thread]) => nowMs - thread.lastActivityMs <= THREAD_HOT_MS || hasOpenTask(thread) || nowMs - (thread.lastPolledMs || 0) >= THREAD_COLD_POLL_MS)
        .sort((a, b) => b[1].lastActivityMs - a[1].lastActivityMs)
        .slice(0, THREAD_POLL_LIMIT)
      for (const [threadId, thread] of activeThreads) {
        thread.lastPolledMs = nowMs
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
      obs.retrySoon = false
      if (fresh > 0) chat.lastNewMessageAt = now().getTime()
      chat.cursorMs = Math.max(chat.cursorMs, Math.min(newest, cursorFloor))
      chat.seen = [...seen].slice(-SEEN_LIMIT)
      state.persist()
    } catch (error) {
      const message = String(error?.message || error).slice(0, 200)
      const sleptAt = await sleepAt()
      if (sleptAt && sleptAt > since) {
        obs.sleepInterrupted = (obs.sleepInterrupted || 0) + 1
        obs.lastSleepError = message
        obs.retrySoon = true // 刚醒网络未就绪：按活跃间隔重试，不按夜间 15min 等
        console.warn(`[lark-gateway] chat-poller ${chatId} 本轮期间系统睡眠过（${new Date(sleptAt).toISOString()} 入睡），失败不计数：${message}`)
        return obs
      }
      obs.consecutiveFailures += 1
      obs.lastError = message
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
    const delay = obs.pausedByLid
      ? LID_RECHECK_MS
      : obs.retrySoon
        ? target.profile.poll.activeMs
        : nextDelayMs({ poll: target.profile.poll, now: now(), lastNewMessageAt: chat.lastNewMessageAt, consecutiveFailures: obs.consecutiveFailures })
    const since = Date.now()
    const timer = setTimer(async () => {
      await pollOnce({ ...target, since })
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
