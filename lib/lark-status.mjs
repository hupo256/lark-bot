/**
 * Lark Gateway 的任务状态回写处理：校验 status/epoch(fencing)、落态、bug 表 done 回写、
 * 并按终态/待确认发对应回执卡。worker 经 POST /lark/tasks/:id/status 触发。
 */

import { appendLatency, latencyRecordOf } from './lark-latency.mjs'
import { normalizeAiExecutor } from './lark-http.mjs'
import {
  markBugRecordInProgress,
  markBugRecordNotIssue,
  markBugRecordWaiting,
  writeBackBugRecord,
} from './lark-bugtable-writeback.mjs'
import { resolveChatIdByProject, resolveDeliveryChatId } from './lark-cli.mjs'
import { normalizeScopeRequest } from './lark-scope-contract.mjs'
import { normalizeOutcome } from './lark-report-render.mjs'
import { deliverOutcome, deliverStart } from './lark-delivery.mjs'
import { noteAnswer } from './lark-reply-obligation.mjs'

// 发回执前该投到哪（11-02 复核）：按项目号改投项目群（abcce3e）是给「入队时 bot 没进群、chatId 冻结成了 operator 私聊」的 bug 表任务用的；
// Lark 消息发起的任务（source=lark，私信或群里 @bot）chatId 就是人说话的地方，正文带个 PR 号也不能改投群——改了之后 sendReply 回复原消息
// 一旦非瞬时失败就回落直发群，私聊 / 群 A 的答案进了项目群 B，发件簿 / 回执 / 回复义务也记错会话，A 里后续「重跑一次」的对话包看不到这条
//（11-02 只豁免了私信；11-03 静态 review R4 把群里发起的也留在原群）。bug 表任务（没有来源群）的 ou_ chatId 只是回落，照旧改投。
export const deliveryChatIdFor = async ({ task, resolve = resolveChatIdByProject }) => {
  if (task.source === 'lark') return task.chatId
  return resolveDeliveryChatId({ project: task.project, fallbackChatId: task.chatId, resolve })
}

// 11-02 复核：消费 lark-task-merge 打的 rerunAfterDone——本轮结论已经发出去（或早就送达）才回队重跑，让 worker 带着【同主题补充】再跑一轮；
// 回执没送达时标记留着，由 retryPendingReceipts 送达后再消费。
const rerunMergedFollowUp = async ({ config, store, task, deps }) => {
  if (task.rerunAfterDone !== true) return
  const requeued = store.requeueMergedFollowUp?.(task.id)
  if (!requeued) return
  console.log(`[lark-gateway] 并入的后续重跑一轮：${task.id}`)
  await deliverStart({ config, store, task: requeued, deps })
}

// 会向群/私聊发回执卡的终态与挂起态：仅这些状态才需在发卡前按项目号改投群（其余如 running 不发卡，
// 不查 chat-list 以保持 network-free）。
const CARD_SENDING_STATUSES = new Set(['done', 'failed', 'no_change_needed', 'waiting_confirmation', 'blocked'])
const RESULT_RECEIPT_STATUSES = new Set(['done', 'failed', 'no_change_needed'])
const WAITING_RECEIPT_STATUSES = new Set(['waiting_confirmation', 'blocked'])
const maxReceiptAttempts = Number(process.env.LARK_RECEIPT_MAX_ATTEMPTS || 12)

// 任务开跑 / 续跑的知会（11-01 对话层）：群里不再发排队卡（对方已收到分类器写的那句「收到」），只私信负责人一行；
// 负责人自己私信发起的不发。回执由出口登记（回复那条私信能锚回任务）。note / logPrefix / idempotencyKey 保留给旧调用点，出口自己定键。
export const sendQueuedReceipt = async ({ config, store, task, note, logPrefix = 'queued receipt', idempotencyKey, sendMessage, deliver = deliverStart, deps = {} }) => {
  void note
  void logPrefix
  void idempotencyKey
  void sendMessage
  return deliver({ config, store, task, deps })
}

const NO_CHANGE_REASON_VALUES = new Set(['env_version', 'not_frontend'])
const VALID_STATUSES = new Set(['queued', 'running', 'verifying', 'done', 'failed', 'no_change_needed', 'blocked', 'waiting_confirmation'])
// 回执幂等键里的状态短码：键有 50 字符上限，状态全名会把代次挤出去（见 receiptKey 处注释）。
const RECEIPT_STATUS_CODE = {
  done: 'done',
  failed: 'fail',
  no_change_needed: 'noop',
  blocked: 'blk',
  waiting_confirmation: 'wait',
}

const receiptKeyFor = (task, status) => `${task.id}-e${task.epoch || 0}-${RECEIPT_STATUS_CODE[status] || 'st'}`

// 终态 / 挂起的出口（11-01 对话层）：不再发卡，由 lib/lark-delivery.mjs 按契约说人话（群里回复原消息 + 私信负责人）。
// 返回 { ok, messageId, reason }：ok = 主消息落地（群里发了 / 扣下私信了 / 只私信）；只有发送本身失败才 ok:false，走 pendingReceipt 重试。
const sendTaskReceipt = async ({ config, store, task, status, result, deliver = deliverOutcome, deps = {} }) => {
  void result
  return deliver({ config, store, task, status, deps })
}

const receiptWasDelivered = (task, idempotencyKey) => task.lastDeliveredReceipt?.idempotencyKey === idempotencyKey

const recordSuccessfulReceipt = ({ store, task, status, receipt, epoch, idempotencyKey }) => {
  if (receiptWasDelivered(task, idempotencyKey)) return
  task.lastDeliveredReceipt = {
    idempotencyKey,
    status,
    epoch,
    deliveredAt: new Date().toISOString(),
  }
  // 所有已送达卡片（含 done/failed/no_change_needed 终态结果卡）都登记为回执，让「回复任意历史卡 →
  // 结单/取消/重开」能经 findTaskByAnyReceipt 锚定回原任务。此前只登记待确认/阻塞卡，回复一条终态结果卡时
  // 反查不到、且终态任务不在 listActiveByThread 内，控制通道 fall through 新建任务（例：回复已完成卡说
  // 「取消任务」被误建成一条新任务）。
  if (receipt.messageId) {
    store.recordReceipt(task.id, { messageId: receipt.messageId, kind: status, epoch })
  } else {
    store.upsert(task)
  }
}

const receiptStillCurrent = ({ task, status, epoch, idempotencyKey }) => {
  if ((task.epoch || 0) !== epoch) return false
  if (task.pendingReceipt && task.pendingReceipt.idempotencyKey !== idempotencyKey) return false
  if (WAITING_RECEIPT_STATUSES.has(status)) return task.status === status
  return task.status === status || task.status === 'result_pending_receipt' ||
    (status === 'done' && task.status === 'done_pending_writeback')
}

/** 回执发送一轮后的持久化判定：失败保持 pending，达上限后停止自动请求但不伪装成已送达。 */
export const resolveReceiptOutcome = ({ ok, attempts = 0, max = maxReceiptAttempts }) => {
  if (ok) return { attempts: 0, gaveUp: false, retry: false }
  const next = attempts + 1
  return { attempts: next, gaveUp: next >= max, retry: next < max }
}

const savePendingReceipt = ({ store, task, status, result, reason, outcome }) => {
  task.pendingReceipt = {
    status,
    result: result || null,
    epoch: task.epoch || 0,
    idempotencyKey: receiptKeyFor(task, status),
    attempts: outcome.attempts,
    gaveUp: outcome.gaveUp,
    lastError: String(reason || 'unknown receipt error').slice(0, 500),
    updatedAt: new Date().toISOString(),
  }
  // 完成/失败/无需改动在回执送达前不进入可清理终态；挂起态仍保留原状态，确保补料续跑可用。
  if (RESULT_RECEIPT_STATUSES.has(status) && task.status === status) task.status = 'result_pending_receipt'
  store.upsert(task)
}

/** Gateway 定时重试未送达的结果/挂起回执；幂等键固定，响应丢失也不会重复发卡。 */
export const retryPendingReceipts = async ({ config, store, deliver = deliverOutcome, deps = {} }) => {
  const pending = store.list().filter((task) => task.pendingReceipt && !task.pendingReceipt.gaveUp)
  for (const task of pending) {
    const saved = task.pendingReceipt
    const savedKey = saved.idempotencyKey || `${task.id}-e${saved.epoch ?? task.epoch ?? 0}-${RECEIPT_STATUS_CODE[saved.status] || 'st'}`
    // 上次可能已收到发送成功响应并持久化 delivered marker，但在删除 pending 前进程退出。
    // 此时直接结算，不再请求 Lark。
    if (receiptWasDelivered(task, savedKey)) {
      delete task.pendingReceipt
      if (task.status === 'result_pending_receipt') task.status = saved.status
      store.upsert(task)
      continue
    }
    const receipt = await sendTaskReceipt({ config, store, task, status: saved.status, result: saved.result, deliver, deps })
    // 发卡期间任务可能被补料续跑、人工 retry，或进入了更新一代的终态。旧请求的返回值
    // 只能结算它启动时看到的 pending，不能删除或覆盖后来写入的新 pending。
    if (task.pendingReceipt !== saved) continue
    if (!receipt.ok && receiptWasDelivered(task, savedKey)) {
      delete task.pendingReceipt
      if (task.status === 'result_pending_receipt') task.status = saved.status
      store.upsert(task)
      continue
    }
    const outcome = resolveReceiptOutcome({ ok: receipt.ok, attempts: saved.attempts })
    if (receipt.ok) {
      recordSuccessfulReceipt({
        store,
        task,
        status: saved.status,
        receipt,
        epoch: saved.epoch ?? task.epoch ?? 0,
        idempotencyKey: savedKey,
      })
      delete task.pendingReceipt
      if (task.status === 'result_pending_receipt') task.status = saved.status
      store.upsert(task)
      console.log(`[lark-gateway] 回执重试成功，${task.id} 落地 ${task.status}`)
      await rerunMergedFollowUp({ config, store, task, deps })
      continue
    }
    savePendingReceipt({ store, task, status: saved.status, result: saved.result, reason: receipt.reason, outcome })
    if (outcome.gaveUp) {
      console.error(`[lark-gateway] ⚠ ${task.id} 回执重试 ${outcome.attempts} 次仍失败，停止自动重试并保持 pending：${receipt.reason}`)
    }
  }
}

export const handleStatusUpdate = async ({
  config,
  store,
  id,
  status,
  result,
  aiExecutor,
  epoch,
  owner,
  branch,
  noChangeReason,
  scopeRequest,
  outcome = null,
  resolveGroupChat = resolveChatIdByProject,
  deliver = deliverOutcome,
  deps = {},
  // 时延记账文件（lib/lark-latency）：gateway 路由传 larkLatencyPath；不传不记（单测直接调本函数时不碰真实运行态）。
  latencyPath = null,
}) => {
  const reportedAt = new Date().toISOString()
  if (!VALID_STATUSES.has(status)) return { ok: false, error: `invalid status: ${status}` }
  const task = store.get(id)
  if (!task) return { ok: false, error: 'task not found' }
  // fencing token：worker 回写须带领取时的 epoch。不匹配 = 该 worker 的领取已被租约回收/人工 retry 作废，
  // 任务已由新一代执行接管，拒绝这条迟到回写（409）。epoch 缺省时不校验，保持向后兼容。
  if (epoch != null && Number(epoch) !== (task.epoch || 0)) {
    return { ok: false, code: 409, error: `stale epoch: got ${epoch}, current ${task.epoch || 0}` }
  }
  task.result = result
  const previousStatus = task.status
  task.aiExecutor = normalizeAiExecutor(aiExecutor) || task.aiExecutor
  if (owner != null) task.owner = owner
  // 目标提交分支：worker 在 running 回写时（AI 跑之前）就带上，故 done 卡构建时 task.branch 已就位。只读任务无分支，不覆盖。
  if (branch) task.branch = branch
  // 不改代码的原因（分诊产出）只属于本轮终态；running 不带它，其余状态一律以本次回写为准，避免上一轮残留。
  if (status !== 'running') task.noChangeReason = NO_CHANGE_REASON_VALUES.has(noChangeReason) ? noChangeReason : null
  // 范围契约的待批准请求同理只属于本轮终态：只在 waiting_confirmation 时保留，人回复「确认扩大范围」续跑时
  // 由 store.resumeWithSupplement 转成 task.scopeApprovals；其它状态一律清空，避免旧请求被后来的回复误批准。
  if (status !== 'running') task.scopeRequest = status === 'waiting_confirmation' ? normalizeScopeRequest(scopeRequest) : null
  // 结构化结果（11-01 对话层）：人话出口只读它；网关再规整一遍，非法整体落 null，旧 worker 不带时也为 null（出口回落到文本 result）。
  if (status !== 'running') task.outcome = normalizeOutcome(outcome)

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
  if (status === 'no_change_needed' && task.source === 'lark-bugtable' && task.noChangeReason === 'env_version') {
    await markBugRecordNotIssue({ config, task })
  }
  // 挂起时长锚点：催办要按「挂起了多久」算轮次，不能用 updatedAt（催办自己会刷新它）。
  // 每次**新进入**挂起态都重新起算（补料续跑后再次待确认属于新一轮等待），离开挂起态则清掉。
  if (status === 'waiting_confirmation' || status === 'blocked') {
    if (task.parkedAt == null || previousStatus !== status) {
      task.parkedAt = new Date().toISOString()
      task.parkedRemindedRound = 0
      task.waitRound = (task.waitRound || 0) + 1
    }
  } else {
    task.parkedAt = null
    task.parkedRemindedRound = 0
  }
  // 发卡前按项目号改投项目群：入队时 bot 可能还没进群，chatId 冻结成了私聊；此刻若项目群已可解析
  // 就改投群并回写（持久化后，随后 result/waiting 两处 send 及后续 retry/reopen 卡都用改投后的 id）。
  // 只对会发卡的状态重解析，running 等不发卡状态不触发 chat-list 查询。
  if (CARD_SENDING_STATUSES.has(status)) {
    task.chatId = await deliveryChatIdFor({ task, resolve: resolveGroupChat })
  }
  store.upsert(task)
  // 同话题挂起兄弟收尾（安全网）：本任务落成功终态时，若同一话题里还挂着其它待确认/阻塞任务，
  // 它们等的结论已由本任务落地 → 一并 supersede 收尾并知会，避免僵尸任务永久挂起、催办残影。
  // 摄入期的同话题归并已能覆盖「挂起在前、后续 @ 在后」的主路径；此处兜住反序/并发竞态。
  if (['done', 'done_with_warnings', 'no_change_needed'].includes(status)) {
    for (const sibling of store.listParkedByThread(task.threadRootId, { excludeId: task.id })) {
      store.supersede({ id: sibling.id, bySiblingId: task.id })
      // 群里不再发「自动收尾」知会（falive I6：群里能不说就不说）；义务按同件事已答记一笔。
      noteAnswer({ task: sibling, text: '（同件事已由同话题任务处理）' })
      console.log(`[lark-gateway] 同话题收尾：挂起任务 ${sibling.id} 由 ${task.id} 完成而 superseded`)
    }
  }
  // 幂等键必须带代次（epoch）：同一任务补料续跑后**再次**待确认、或人工 retry 后**再次**失败时，
  // 不带代次的 `${id}-${status}` 与上一代完全相同 → Lark 幂等去重 → 群里收不到第二张卡，
  // 人以为机器人死了。epoch 每次回队都自增，天然区分代次。入队卡早已带 resumeCount/retryCount，此处对齐。
  // 状态用短码而非全名：lark-cli 会把键截到 50 字符，`om_`(35) + `-waiting_confirmation`(21) 会超，
  // 一截就把尾部的 epoch 切掉、退化成旧行为。短码把键压到 45 以内，保证代次不被截断。
  if (WAITING_RECEIPT_STATUSES.has(status) && task.source === 'lark-bugtable') {
    await markBugRecordWaiting({ config, task })
  }
  if (CARD_SENDING_STATUSES.has(status)) {
    const receiptEpoch = task.epoch || 0
    const idempotencyKey = receiptKeyFor(task, status)
    if (receiptWasDelivered(task, idempotencyKey)) {
      if (task.pendingReceipt?.idempotencyKey === idempotencyKey) {
        delete task.pendingReceipt
        store.upsert(task)
      }
      await rerunMergedFollowUp({ config, store, task, deps })
      return { ok: true, receiptAlreadyDelivered: true }
    }
    const pendingAtStart = task.pendingReceipt
    const receipt = await sendTaskReceipt({ config, store, task, status, result, deliver, deps })
    if (pendingAtStart && task.pendingReceipt !== pendingAtStart) {
      return { ok: true, receiptSuperseded: true }
    }
    if (!receiptStillCurrent({ task, status, epoch: receiptEpoch, idempotencyKey })) {
      console.warn(`[lark-gateway] ${task.id} ${status} 回执返回时任务已换代或进入新状态，忽略旧发送结果`)
      return { ok: true, receiptSuperseded: true }
    }
    if (!receipt.ok) {
      if (receiptWasDelivered(task, idempotencyKey)) return { ok: true, receiptAlreadyDelivered: true }
      const priorAttempts = task.pendingReceipt?.idempotencyKey === idempotencyKey
        ? task.pendingReceipt.attempts
        : 0
      const outcome = resolveReceiptOutcome({ ok: false, attempts: priorAttempts })
      savePendingReceipt({ store, task, status, result, reason: receipt.reason, outcome })
      console.error(`[lark-gateway] ⚠ ${task.id} ${status} 回执未送达，已持久化等待重试：${receipt.reason}`)
      return { ok: true, receiptPending: true }
    }
    recordSuccessfulReceipt({ store, task, status, receipt, epoch: receiptEpoch, idempotencyKey })
    if (latencyPath && RESULT_RECEIPT_STATUSES.has(status)) {
      appendLatency(latencyRecordOf({ task, status, reportedAt, deliveredAt: task.lastDeliveredReceipt?.deliveredAt || new Date().toISOString(), docMs: receipt.docMs }), { path: latencyPath })
    }
    if (task.pendingReceipt?.idempotencyKey === idempotencyKey) {
      delete task.pendingReceipt
      // 10-24（falive）：发卡期间回写重试定时器成功、因有 pending 把状态改成了 result_pending_receipt；删了 pending
      // 却不落回本次状态，两个重试器（一个要 pending、一个要 done_pending_writeback）都不再管它，任务永久卡住。
      // 与 retryPendingReceipts 的结算一致。
      if (task.status === 'result_pending_receipt') task.status = status
    }
    store.upsert(task)
    await rerunMergedFollowUp({ config, store, task, deps })
  }
  return { ok: true }
}
