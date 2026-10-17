/**
 * 开盖补拉内部群（aven 10-17：合盖 bot 下班，开盖后批量处理合盖期间的 @）。
 * 内部群走长连接，机器睡着时连接是断的；飞书事件推送失败只按 15s / 5min / 1h / 6h 重试 4 次（约 7 小时），
 * 正好落在 Power Nap 半醒窗口的概率很低，合盖一夜的消息基本收不到。
 * 做法：每分钟看一次「中间睡过没有 / 盖子合着没有」，记下睡前最后一次醒着的时刻；开盖后用 bot 身份把 bot 所在群
 * 从那一刻（多留 2 分钟重叠）起的消息拉一遍，送进同一条 ingest——任务幂等靠 store，重推靠 ingest 的最近 id 去重。
 * 外部群（仓库 profile 的 chatIds）由 lark-chat-poller 自己按游标补，这里跳过。
 */

import { listBotChatIds, listChatMessages } from './lark-cli.mjs'
import { chatListMessageToEvent, flattenThreadReplies, isPollableMessage } from './lark-chat-poller.mjs'
import { isLidClosed, lastSystemSleepAt } from './lark-power.mjs'
import { listRepoProfiles } from './lark-repo-profile.mjs'

const TICK_MS = 60_000
const OVERLAP_MS = 120_000
const MAX_PAGES = 10

export const startWakeCatchup = ({ config, store, ingest, deps = {} }) => {
  const now = deps.now || Date.now
  const lidClosed = deps.isLidClosed || isLidClosed
  const sleepAt = deps.lastSystemSleepAt || lastSystemSleepAt
  const listChats = deps.listBotChatIds || listBotChatIds
  const list = deps.listChatMessages || listChatMessages
  let lastTickAt = now()
  let windowStart = null // 睡前 / 合盖前最后一次醒着的时刻；null = 没有待补的

  const catchUp = async (start) => {
    const polled = new Set(listRepoProfiles().flatMap((profile) => profile.chatIds || []))
    const chatIds = (await listChats()).filter((chatId) => !polled.has(chatId))
    const startIso = new Date(Math.max(0, start - OVERLAP_MS)).toISOString()
    let fed = 0
    for (const chatId of chatIds) {
      let pageToken = null
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const result = await list({ chatId, start: startIso, pageToken, identity: 'bot' })
        if (!result.ok) throw new Error(`群 ${chatId}：${result.reason || 'list failed'}`)
        for (const message of result.messages.flatMap((item) => [item, ...flattenThreadReplies(item)])) {
          if (!isPollableMessage(message) || store.has(message.message_id)) continue
          await ingest({ raw: chatListMessageToEvent(message, { chatId }), config, store })
          fed += 1
        }
        if (!result.hasMore || !result.pageToken) break
        pageToken = result.pageToken
      }
    }
    return { chats: chatIds.length, fed }
  }

  const tick = async () => {
    const at = now()
    const [closed, sleptAt] = await Promise.all([lidClosed(), sleepAt()])
    if (windowStart == null && (closed || (sleptAt && sleptAt > lastTickAt))) windowStart = lastTickAt
    lastTickAt = at
    if (closed || windowStart == null) return null
    try {
      const outcome = await catchUp(windowStart)
      console.log(`[lark-gateway] 开盖补拉内部群：${outcome.chats} 个群，自 ${new Date(windowStart).toISOString()} 起补送 ${outcome.fed} 条`)
      windowStart = null
      return outcome
    } catch (error) {
      console.warn(`[lark-gateway] 开盖补拉内部群失败（下分钟重试）：${String(error?.message || error).slice(0, 160)}`)
      return null
    }
  }

  const timer = (deps.setInterval || setInterval)(() => { tick().catch(() => {}) }, TICK_MS)
  timer.unref?.()
  return { tick, stop: () => clearInterval(timer) }
}
