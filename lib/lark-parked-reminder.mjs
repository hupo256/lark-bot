/**
 * 挂起任务催办：waiting_confirmation / blocked 的任务在等人补材料，机器人这边不会再动它。
 * 只发一次回执 = 一旦那条消息被群里的其它讨论刷下去，任务就静静躺到没人记得。
 * 这里按「挂起时长」分轮次催办，每轮只发一次，满 N 轮停（不做无限刷群）。
 */

import { buildParkedReminderCard, resolveOwnerMention } from './lark-cards.mjs'
import { sendChatMessage } from './lark-cli.mjs'

const PARKED_STATUSES = new Set(['waiting_confirmation', 'blocked'])
// 每轮催办间隔（默认 4h）与最多催办轮次（默认 3 轮 ⇒ 12h 后不再催，交给人自己盘点）。
export const defaultRemindAfterMs = Number(process.env.LARK_PARKED_REMIND_MS || 4 * 60 * 60 * 1000)
export const defaultRemindRounds = Number(process.env.LARK_PARKED_REMIND_ROUNDS || 3)

// 纯函数：这条挂起任务当前该发第几轮催办；0 表示还不到点 / 本轮已催过 / 已催满。
// 时间锚点用 parkedAt 而非 updatedAt——催办本身要 upsert 记录轮次，会刷新 updatedAt，
// 用它当锚点会让挂起时长永远归零、催办一次后再也不触发。
export const parkedReminderRound = ({
  task,
  now,
  afterMs = defaultRemindAfterMs,
  rounds = defaultRemindRounds,
}) => {
  if (!PARKED_STATUSES.has(task.status)) return 0
  const parkedAt = new Date(task.parkedAt || task.updatedAt || 0).getTime()
  if (!Number.isFinite(parkedAt) || parkedAt <= 0) return 0
  const round = Math.floor((now - parkedAt) / afterMs)
  if (round < 1 || round > rounds) return 0
  if ((task.parkedRemindedRound || 0) >= round) return 0
  return round
}

export const remindParkedTasks = async ({ config, store, now = Date.now() }) => {
  for (const task of store.list()) {
    const round = parkedReminderRound({ task, now })
    if (!round) continue
    const hours = Math.floor((now - new Date(task.parkedAt || task.updatedAt).getTime()) / 3600000)
    const { mentionOpenId, ownerNote } = resolveOwnerMention({
      owner: task.owner,
      ownerMap: config.ownerMap,
      operator: task.operator,
    })
    // 先记轮次再发卡：发送失败也不会在下一轮定时器里重复轰炸（幂等键同样带轮次兜底）。
    task.parkedRemindedRound = round
    store.upsert(task)
    await sendChatMessage({
      chatId: task.chatId,
      card: buildParkedReminderCard({ config, task, hours, round, mentionOpenId, ownerNote }),
      logPrefix: `parked reminder r${round}`,
      // 键必须带轮次，否则第二轮会被 Lark 幂等去重（键上限 50 字符，故用 rm 短码，见 lark-status 注释）。
      idempotencyKey: `${task.id}-e${task.epoch || 0}-rm${round}`,
    })
    console.log(`[lark-gateway] 挂起催办 ${task.id}（第 ${round} 轮，已挂起 ${hours}h）`)
  }
}
