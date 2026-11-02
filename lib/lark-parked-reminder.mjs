/**
 * 挂起任务催办：waiting_confirmation / blocked 的改码任务在等人补材料，机器人这边不会再动它。
 * 只发一次回执 = 一旦那条消息被群里的其它讨论刷下去，任务就静静躺到没人记得。
 *
 * 11-01 对话层口径（plan §1.8）：只催改码类、群里发起的任务——第 1 轮（4h）群里对提单人说一句人话，第 2 轮（8h）私信负责人一次，之后不催。
 * 永不催：代答 / 实测 / 运维 / 只记一笔（契约非 change）、私信发起的、负责人私聊指示、疑似（parkedRemindedRound=99）。
 * 11-01 真机：问一句「能不能发邮件」被当新需求挂起，4h 一轮催了三轮；运维「没新内容」落 blocked 也被催——催办对象错了。
 */

import { sendPrincipalNote, sendReply } from './lark-group-exit.mjs'
import { chatLabel, sayReminderGroup, sayReminderPrincipal } from './lark-human-text.mjs'

const PARKED_STATUSES = new Set(['waiting_confirmation', 'blocked'])
const NEVER_NAG_DELIVERABLES = new Set(['answer', 'verification', 'ops', 'record'])
// 每轮催办间隔（默认 4h）与最多催办轮次（默认 2 轮：群里一次、负责人一次）。
export const defaultRemindAfterMs = Number(process.env.LARK_PARKED_REMIND_MS || 4 * 60 * 60 * 1000)
export const defaultRemindRounds = Number(process.env.LARK_PARKED_REMIND_ROUNDS || 2)

// 不该催的任务（纯函数）。
export const isNeverNagged = (task) => Boolean(
  !task ||
  NEVER_NAG_DELIVERABLES.has(task.contract?.deliverable) ||
  task.commandType === 'ops' ||
  task.chatType === 'p2p' ||
  task.intake?.trigger === 'dm' ||
  String(task.chatId || '').startsWith('ou_') ||
  task.privateOrigin ||
  task.suspected ||
  task.askBack ||
  (task.parkedRemindedRound || 0) >= 99,
)

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

export const remindParkedTasks = async ({ config, store, now = Date.now(), deps = {} }) => {
  for (const task of store.list()) {
    if (isNeverNagged(task)) continue
    const round = parkedReminderRound({ task, now })
    if (!round) continue
    // 先记轮次再发：发送失败也不会在下一轮定时器里重复轰炸（幂等键同样带轮次兜底）。
    task.parkedRemindedRound = round
    store.upsert(task)
    const key = `${task.id}-e${task.epoch || 0}-rm${round}`.slice(0, 50)
    const where = chatLabel(task, { chatNames: deps.chatNames })
    const receipt = round === 1
      ? await (deps.sendReply || sendReply)({ config, store, task, phase: 'reminder', text: sayReminderGroup({ task, blocker: (task.outcome?.blockers || [])[0] || null }), mentions: task.operator ? [{ openId: task.operator, name: '' }] : [], idempotencyKey: key })
      : await (deps.sendPrincipalNote || sendPrincipalNote)({ config, store, text: sayReminderPrincipal({ task, chatLabel: where }), taskId: task.id, kind: 'reminder', idempotencyKey: key })
    console.log(`[lark-gateway] 挂起催办 ${task.id}（第 ${round} 轮，${round === 1 ? '群里对提单人' : '私信负责人'}）：${receipt?.ok ? 'ok' : receipt?.reason || 'skipped'}`)
  }
}
