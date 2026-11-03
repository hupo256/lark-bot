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
const RECENT_CHAT_MS = 7 * 24 * 3600_000
// 私信会话（aven 11-02：私信「test 和 pre 一样吗」被分流丢了 5 分钟）：补拉原来只补群，重启那十几秒里的私信只能等飞书重投（15s / 5min / 1h）。
// 任务库 24h 就清，所以把见过的私信会话（oc_ 会话 id）记在「上次活着」同一个状态文件里，留 30 天、最多 20 个。
export const DM_CHAT_KEEP_MS = 30 * 24 * 3600_000
export const DM_CHAT_MAX = 20
// 限流（11-03 开盖补拉：连着列 15 个会话，3 个群撞「TAT endpoint rate limited (HTTP 429)」被跳过——lark-cli 每次调用都先取一次应用令牌）：
// 会话之间隔 PACE_MS；瞬时失败（限流 / 网络）的会话按 RETRY_DELAYS_MS 再补两轮，还不行才算拉不到。
export const CATCHUP_PACE_MS = 300
export const CATCHUP_RETRY_DELAYS_MS = [5_000, 15_000]

// 「上次活着」时刻（-state.json 不算源码）：每分钟写一次；重启后从它起补拉——排空重启 / 手动 restart 的十来秒里
// 长连接是断的，事件总线不缓存，那一下送来的 @ 以前就丢了（11-02 真机：合代码期间发的实测请求没收到）。
const aliveStatePath = () => join(larkRuntimeDir, 'lark-gateway-alive-state.json')
const readAliveState = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) || {}
  } catch {
    return {}
  }
}
export const readLastAliveAt = ({ path = aliveStatePath() } = {}) => {
  const at = Date.parse(readAliveState(path)?.at || '')
  return Number.isFinite(at) ? at : null
}
// { [oc_ 会话 id]: 最近见到的 ISO 时刻 }；读坏当空。
export const readDmChats = ({ path = aliveStatePath() } = {}) => {
  const dmChats = readAliveState(path)?.dmChats
  return dmChats && typeof dmChats === 'object' && !Array.isArray(dmChats) ? dmChats : {}
}
// dmChats 不传就沿用文件里原有的（只更新时刻）。
export const writeLastAliveAt = (at, { path = aliveStatePath(), dmChats = null } = {}) => {
  if (!Number.isFinite(at)) return
  const keep = dmChats || readDmChats({ path })
  try {
    writeFileSync(path, `${JSON.stringify({ at: new Date(at).toISOString(), ...(Object.keys(keep).length ? { dmChats: keep } : {}) })}\n`)
  } catch {
    // 写不进去只影响下次重启的补拉起点，不影响运行
  }
}

// 合并私信会话：原有的 + 任务库里的私信任务（chatType=p2p、oc_ 会话 id，按 updatedAt / createdAt），去掉 keepMs 以前的，按最近排序留 max 个。纯函数。
export const mergeDmChats = ({ previous = {}, tasks = [], now = Date.now(), keepMs = DM_CHAT_KEEP_MS, max = DM_CHAT_MAX }) => {
  const seen = new Map(Object.entries(previous || {}).map(([id, at]) => [id, Date.parse(at) || 0]))
  for (const task of tasks) {
    if (task?.chatType !== 'p2p' || !String(task.chatId || '').startsWith('oc_')) continue
    const at = Date.parse(task.updatedAt || task.createdAt || '') || 0
    if (at > (seen.get(task.chatId) || 0)) seen.set(task.chatId, at)
  }
  return Object.fromEntries([...seen.entries()]
    .filter(([, at]) => at && now - at <= keepMs)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([id, at]) => [id, new Date(at).toISOString()]))
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
  const readDm = deps.readDmChats || readDmChats
  const pause = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  let catchingUp = false // 补拉含重试可能超过一分钟：期间到点的 tick 跳过，不叠加
  // 私信会话表：启动时读文件，每轮 tick（补拉之前）并入任务库里的私信、随「上次活着」一起落盘。
  let dmChats = readDm()
  let lastTickAt = now()
  let windowStart = null // 睡前 / 合盖前最后一次醒着的时刻；null = 没有待补的
  let restartWindow = false // 本窗口是重启留下的（十几秒）：只补近 7 天有过任务的群，不把 bot 所在的几十个群全拉一遍
  let failures = 0

  // 重启补拉：上次活着的时刻在 24h 内 → 当作一个待补窗口，首轮 tick 就补（11-02 复核）。
  const lastAlive = readAlive()
  if (lastAlive && lastTickAt - lastAlive <= MAX_RESTART_GAP_MS) {
    windowStart = lastAlive
    restartWindow = true
    console.log(`[lark-gateway] 重启补拉：上次活着 ${new Date(lastAlive).toISOString()}，首轮补拉这段时间的群消息`)
  }

  // 单个群拉不到（应用没读这个群的权限 / 群已解散）只记一笔、继续别的群；全军覆没才算失败（11-02 复核：
  // 原来一个群失败整轮抛出，三次后放弃，于是有一个没权限的群就永远补不了别的群）。
  // 11-02：每次重启都把 bot 所在的约 50 个群各列一遍消息，再加上每次 lark-cli 调用都要先取一次 token，一天重启十几次就把
  // 应用的接口频率打满（HTTP 429）。重启空窗只有十几秒，只补最近有过 bot 任务的群；合盖 / 睡眠的长空窗照旧全拉。
  const recentTaskChats = () => {
    const since = now() - RECENT_CHAT_MS
    return [...new Set((store.list?.() || [])
      .filter((task) => String(task.chatId || '').startsWith('oc_') && task.chatType !== 'p2p' && (Date.parse(task.updatedAt || task.createdAt || '') || 0) >= since)
      .map((task) => task.chatId))]
  }
  const catchUp = async (start) => {
    const all = await listChats()
    const groupIds = restartWindow ? all.filter((chatId) => recentTaskChats().includes(chatId)) : all
    // 群按群、私信按私信（chat_type 决定 ingest 走私信口径）；私信会话见 mergeDmChats。
    const targets = [...groupIds.map((chatId) => ({ chatId, chatType: 'group' })), ...Object.keys(dmChats).map((chatId) => ({ chatId, chatType: 'p2p' }))]
    const chatIds = targets.map((target) => target.chatId)
    const startIso = new Date(Math.max(0, start - OVERLAP_MS)).toISOString()
    let fed = 0
    const failed = []
    // 拉一个会话的全部页；中途失败返回失败（已送进 ingest 的靠 store.has 去重，重试从头拉不会重复建任务）。
    const pullChat = async ({ chatId, chatType }) => {
      let pageToken = null
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const result = await list({ chatId, start: startIso, pageToken })
        if (!result.ok) return { ok: false, transient: Boolean(result.transient), reason: `${chatType === 'p2p' ? '私信' : '群'} ${chatId}：${result.reason || 'list failed'}` }
        for (const message of result.messages.flatMap((item) => [item, ...flattenThreadReplies(item)])) {
          if (!isPollableMessage(message) || store.has(message.message_id)) continue
          await ingest({ raw: chatListMessageToEvent(message, { chatId, chatType }), config, store })
          fed += 1
        }
        if (!result.hasMore || !result.pageToken) break
        pageToken = result.pageToken
      }
      return { ok: true }
    }
    let pending = targets
    for (let round = 0; pending.length; round += 1) {
      const retry = []
      for (const [index, target] of pending.entries()) {
        if (index > 0) await pause(CATCHUP_PACE_MS)
        const outcome = await pullChat(target)
        if (outcome.ok) continue
        if (outcome.transient && round < CATCHUP_RETRY_DELAYS_MS.length) retry.push(target)
        else failed.push(outcome.reason)
      }
      if (retry.length) {
        console.warn(`[lark-gateway] 补拉 ${retry.length} 个会话撞限流 / 网络，${CATCHUP_RETRY_DELAYS_MS[round] / 1000} 秒后再补（第 ${round + 1} 次）`)
        await pause(CATCHUP_RETRY_DELAYS_MS[round])
      }
      pending = retry
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
    if (!closed) {
      dmChats = mergeDmChats({ previous: dmChats, tasks: store.list?.() || [], now: at })
      writeAlive(at, { dmChats })
    }
    if (closed || windowStart == null || catchingUp) return null
    catchingUp = true
    try {
      const outcome = await catchUp(windowStart)
      console.log(`[lark-gateway] ${restartWindow ? '重启' : '开盖'}补拉：${outcome.chats} 个会话（其中私信 ${Object.keys(dmChats).length} 个），自 ${new Date(windowStart).toISOString()} 起补送 ${outcome.fed} 条`)
      windowStart = null
      restartWindow = false
      failures = 0
      return outcome
    } catch (error) {
      failures += 1
      if (failures >= GIVE_UP_AFTER_FAILURES) {
        console.warn(`[lark-gateway] 开盖补拉连续 ${failures} 次失败，放弃本窗口（应用可能没有读群消息权限）：${String(error?.message || error).slice(0, 160)}`)
        windowStart = null
        restartWindow = false
        failures = 0
      } else {
        console.warn(`[lark-gateway] 开盖补拉群消息失败（下分钟重试）：${String(error?.message || error).slice(0, 160)}`)
      }
      return null
    } finally {
      catchingUp = false
    }
  }

  const timer = (deps.setInterval || setInterval)(() => { tick().catch(() => {}) }, TICK_MS)
  timer.unref?.()
  return { tick, stop: () => clearInterval(timer) }
}
