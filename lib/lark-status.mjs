/**
 * Lark Gateway 的任务状态回写处理：校验 status/epoch(fencing)、落态、bug 表 done 回写、
 * 并按终态/待确认发对应回执卡与通知日志。worker 经 POST /lark/tasks/:id/status 触发。
 */

import { normalizeAiExecutor } from './lark-http.mjs'
import {
  appendNotificationLog,
  markBugRecordInProgress,
  writeBackBugRecord,
} from './lark-bugtable-writeback.mjs'
import { buildResultCard, buildWaitingCard, formatDisplayTime, resolveOwnerMention } from './lark-cards.mjs'
import { sendChatMessage } from './lark-cli.mjs'

const VALID_STATUSES = new Set(['queued', 'running', 'verifying', 'done', 'failed', 'blocked', 'waiting_confirmation'])
// 回执幂等键里的状态短码：键有 50 字符上限，状态全名会把代次挤出去（见 receiptKey 处注释）。
const RECEIPT_STATUS_CODE = {
  done: 'done',
  failed: 'fail',
  blocked: 'blk',
  waiting_confirmation: 'wait',
}

export const handleStatusUpdate = async ({ config, store, id, status, result, aiExecutor, epoch, owner, branch }) => {
  if (!VALID_STATUSES.has(status)) return { ok: false, error: `invalid status: ${status}` }
  const task = store.get(id)
  if (!task) return { ok: false, error: 'task not found' }
  // fencing token：worker 回写须带领取时的 epoch。不匹配 = 该 worker 的领取已被租约回收/人工 retry 作废，
  // 任务已由新一代执行接管，拒绝这条迟到回写（409）。epoch 缺省时不校验，保持向后兼容。
  if (epoch != null && Number(epoch) !== (task.epoch || 0)) {
    return { ok: false, code: 409, error: `stale epoch: got ${epoch}, current ${task.epoch || 0}` }
  }
  task.result = result
  task.aiExecutor = normalizeAiExecutor(aiExecutor) || task.aiExecutor
  if (owner != null) task.owner = owner
  // 目标提交分支：worker 在 running 回写时（AI 跑之前）就带上，故 done 卡构建时 task.branch 已就位。只读任务无分支，不覆盖。
  if (branch) task.branch = branch

  // 领取（worker 首次回写 running）即把 bug 记录置「修复中」。best-effort，不阻塞。
  if (status === 'running' && task.source === 'lark-bugtable') {
    await markBugRecordInProgress({ config, task })
  }

  // done + bug 表来源：必须回写成功才落地 done。回写失败置中间态 done_pending_writeback，由定时器重试。
  if (status === 'done' && task.source === 'lark-bugtable') {
    const wb = await writeBackBugRecord({ config, task })
    task.status = wb.ok ? 'done' : 'done_pending_writeback'
  } else {
    task.status = status
  }
  store.upsert(task)
  // 幂等键必须带代次（epoch）：同一任务补料续跑后**再次**待确认、或人工 retry 后**再次**失败时，
  // 不带代次的 `${id}-${status}` 与上一代完全相同 → Lark 幂等去重 → 群里收不到第二张卡，
  // 人以为机器人死了。epoch 每次回队都自增，天然区分代次。入队卡早已带 resumeCount/retryCount，此处对齐。
  // 状态用短码而非全名：lark-cli 会把键截到 50 字符，`om_`(35) + `-waiting_confirmation`(21) 会超，
  // 一截就把尾部的 epoch 切掉、退化成旧行为。短码把键压到 45 以内，保证代次不被截断。
  const receiptKey = `${task.id}-e${task.epoch || 0}-${RECEIPT_STATUS_CODE[status] || 'st'}`
  if (status === 'done' || status === 'failed') {
    await sendChatMessage({
      chatId: task.chatId,
      card: buildResultCard({ config, task, status, result }),
      logPrefix: 'result receipt',
      idempotencyKey: receiptKey,
    })
    appendNotificationLog({
      config,
      row: `| ${formatDisplayTime()} | Lark Job | ${status === 'done' ? '已完成' : '阻塞中'} | ${task.summary}：${(result || '').slice(0, 60)} | real | ${status === 'done' ? 'success' : 'failed'} |`,
    })
  }
  // 待确认 / 阻塞：单独一条橙色回执。责任人识别：AI 自报 owner 命中 config.ownerMap 则 @ 对应责任人，
  // 否则回落 @ 提单人（task.operator）并注明未识别。bug 表任务通常无 operator，则不 @、仅发群。
  if (status === 'waiting_confirmation' || status === 'blocked') {
    const { mentionOpenId, ownerNote } = resolveOwnerMention({ owner: task.owner, ownerMap: config.ownerMap, operator: task.operator })
    await sendChatMessage({
      chatId: task.chatId,
      card: buildWaitingCard({ config, task, status, result, mentionOpenId, ownerNote }),
      logPrefix: `${status} receipt`,
      idempotencyKey: receiptKey,
    })
    appendNotificationLog({
      config,
      row: `| ${formatDisplayTime()} | Lark Job | 待确认 | ${task.summary}：${(result || '').slice(0, 60)} | real | waiting |`,
    })
  }
  return { ok: true }
}
