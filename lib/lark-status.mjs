/**
 * Lark Gateway 的任务状态回写处理：校验 status/epoch(fencing)、落态、bug 表 done 回写、
 * 并按终态/待确认发对应回执卡。worker 经 POST /lark/tasks/:id/status 触发。
 */

import { normalizeAiExecutor } from './lark-http.mjs'
import {
  markBugRecordInProgress,
  markBugRecordNotIssue,
  markBugRecordWaiting,
  writeBackBugRecord,
} from './lark-bugtable-writeback.mjs'
import { buildCardContent, buildQueuedCard, buildResultCard, buildWaitingCard, resolveOwnerMention } from './lark-cards.mjs'
import { resolveChatIdByProject, resolveDeliveryChatId, sendChatMessage } from './lark-cli.mjs'
import { normalizeScopeRequest } from './lark-scope-contract.mjs'
import { repoProfileForChat, repoProfileForTask } from './lark-repo-profile.mjs'
import { postGroupSummary } from './lark-group-reply.mjs'
import { deliverRepoOutcome, deliverRepoStart, isHumanDeliveryTask } from './lark-repo-delivery.mjs'

// 会向群/私聊发回执卡的终态与挂起态：仅这些状态才需在发卡前按项目号改投群（其余如 running 不发卡，
// 不查 chat-list 以保持 network-free）。
const CARD_SENDING_STATUSES = new Set(['done', 'failed', 'no_change_needed', 'waiting_confirmation', 'blocked'])
const RESULT_RECEIPT_STATUSES = new Set(['done', 'failed', 'no_change_needed'])
const WAITING_RECEIPT_STATUSES = new Set(['waiting_confirmation', 'blocked'])
const maxReceiptAttempts = Number(process.env.LARK_RECEIPT_MAX_ATTEMPTS || 12)

// 所有排队卡都记录真实 message_id，后续回复“已解决”才能精确锚定原任务并直接结单。
export const sendQueuedReceipt = async ({
  config,
  store,
  task,
  note,
  logPrefix = 'queued receipt',
  idempotencyKey = `${task.id}-queued`,
  sendMessage = sendChatMessage,
}) => {
  const epoch = task.epoch || 0
  // 仓库 profile（外部群）任务：不发卡，负责人私聊一行「开始做」（aven 2026-10-13：消息要拟人、要少）。
  if (isHumanDeliveryTask(task)) {
    const started = await deliverRepoStart({ task })
    if (started.ok && started.messageId) store.recordReceipt(task.id, { messageId: started.messageId, kind: 'queued', epoch })
    return started
  }
  // 外部群（仓库 profile）里只发结果卡，排队卡改发负责人私聊（profile.notifyChatId）：
  // 群里每条任务两张卡太吵（aven 2026-10-13），排队状态负责人自己知道就行。
  const repo = repoProfileForChat(task.chatId)
  const queuedTo = repo?.notifyChatId && repo.quietQueuedCards !== false ? repo.notifyChatId : task.chatId
  const receipt = await sendMessage({
    chatId: queuedTo,
    card: buildQueuedCard({ config, task, note: queuedTo !== task.chatId ? [note, `**群**：${repo.chatNameById?.[task.chatId] || task.chatId}（排队卡只发给你，结果卡发群）`].filter(Boolean).join('\n') : note }),
    logPrefix,
    idempotencyKey,
  })
  if (receipt.ok && receipt.messageId) {
    store.recordReceipt(task.id, { messageId: receipt.messageId, kind: 'queued', epoch })
  }
  return receipt
}

const NO_CHANGE_REASON_VALUES = new Set(['env_version', 'not_frontend', 'other_owner'])
// ignored：仓库 profile 的任务在分析阶段判出「不归本 bot 代理的人」→ 静默落 ignored，不发任何卡（aven 2026-10-13）。
const VALID_STATUSES = new Set(['queued', 'running', 'verifying', 'done', 'failed', 'no_change_needed', 'blocked', 'waiting_confirmation', 'ignored'])
// 回执幂等键里的状态短码：键有 50 字符上限，状态全名会把代次挤出去（见 receiptKey 处注释）。
const RECEIPT_STATUS_CODE = {
  done: 'done',
  failed: 'fail',
  no_change_needed: 'noop',
  blocked: 'blk',
  waiting_confirmation: 'wait',
}

const receiptKeyFor = (task, status) => `${task.id}-e${task.epoch || 0}-${RECEIPT_STATUS_CODE[status] || 'st'}`

// 责任人表：全局 ownerMap 叠加任务所属仓库 profile 的 ownerMap（人名 → open_id）。
const ownerMapFor = (config, task) => ({ ...(config.ownerMap || {}), ...(repoProfileForTask(task).ownerMap || {}) })

const sendTaskReceipt = async ({ config, task, status, result, sendMessage, idempotencyKey = receiptKeyFor(task, status) }) => {
  if (RESULT_RECEIPT_STATUSES.has(status)) {
    // 归属别的前端负责人而跳过：结果卡 @ 该负责人接手（只在人名表能对上时 @，对不上不 @ 提单人——那不是他的活）。
    const ownerMention = status === 'no_change_needed' && task.noChangeReason === 'other_owner' && task.owner
      ? resolveOwnerMention({ owner: task.owner, ownerMap: ownerMapFor(config, task), operator: null })
      : null
    return sendMessage({
      chatId: task.chatId,
      card: buildResultCard({
        config,
        task,
        status,
        result,
        mentionOpenId: ownerMention?.matched ? ownerMention.mentionOpenId : null,
        mentionNote: ownerMention?.matched ? `该功能的前端负责人是 ${task.owner}，bot 已跳过，请接手处理` : null,
      }),
      logPrefix: 'result receipt',
      idempotencyKey,
    })
  }

  const { mentionOpenId, ownerNote } = resolveOwnerMention({ owner: task.owner, ownerMap: ownerMapFor(config, task), operator: task.operator })
  return sendMessage({
    chatId: task.chatId,
    card: buildWaitingCard({ config, task, status, result, mentionOpenId, ownerNote }),
    logPrefix: `${status} receipt`,
    idempotencyKey,
  })
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
export const retryPendingReceipts = async ({ config, store, sendMessage = sendChatMessage }) => {
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
    const receipt = await sendTaskReceipt({
      config,
      task,
      status: saved.status,
      result: saved.result,
      sendMessage,
      idempotencyKey: savedKey,
    })
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
  groupReply,
  followUpDoc,
  followUps,
  changedFiles,
  preChecks,
  integration,
  resolveGroupChat = resolveChatIdByProject,
  sendMessage = sendChatMessage,
  postGroup = postGroupSummary,
  deliverRepo = deliverRepoOutcome,
}) => {
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
  if (status !== 'running') {
    task.groupReply = typeof groupReply === 'string' && groupReply.trim() ? groupReply.trim() : null
    task.followUpDoc = typeof followUpDoc === 'string' && followUpDoc.trim() ? followUpDoc.trim() : null
    task.followUps = Array.isArray(followUps) ? followUps.filter((item) => item && typeof item.owner === 'string') : null
    // 模型偶尔把 outcome 写成 result：统一成 outcome。
    task.integration = integration && typeof integration === 'object' ? integration : null
    task.preChecks = Array.isArray(preChecks) ? preChecks.filter((item) => item && typeof item.endpoint === 'string').slice(0, 40).map((item) => ({ endpoint: item.endpoint, outcome: String(item.outcome ?? item.result ?? '') })) : null
    task.changedFiles = Array.isArray(changedFiles) ? changedFiles.filter((item) => typeof item === 'string').slice(0, 100) : null
  }
  // 仓库 profile（外部群）任务走人话出口：没有卡片、催办、收尾知会，只有负责人私聊一条 + 群里一句。
  const humanMode = isHumanDeliveryTask(task)

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
    task.chatId = await resolveDeliveryChatId({ project: task.project, fallbackChatId: task.chatId, resolve: resolveGroupChat })
  }
  store.upsert(task)
  // 同话题挂起兄弟收尾（安全网）：本任务落成功终态时，若同一话题里还挂着其它待确认/阻塞任务，
  // 它们等的结论已由本任务落地 → 一并 supersede 收尾并知会，避免僵尸任务永久挂起、催办残影。
  // 摄入期的同话题归并已能覆盖「挂起在前、后续 @ 在后」的主路径；此处兜住反序/并发竞态。
  // 在跑期间收到的同话题补充：发完本轮结果卡后带补充再跑一轮（最多 3 轮）。
  if (['done', 'no_change_needed', 'failed', 'ignored'].includes(status) && task.rerunAfterDone) {
    const requeued = status === 'ignored' ? (delete task.rerunAfterDone, store.upsert(task), null) : store.requeueForSupplement(task.id)
    if (requeued) {
      console.log(`[lark-gateway] ${task.id} 跑完后带话题补充再跑一轮（第 ${requeued.rerunCount} 次）`)
      await sendQueuedReceipt({ config, store, task: requeued, note: '**说明**：执行期间话题里又有补充，带上补充再跑一轮（复用原分支）。', logPrefix: 'rerun receipt', idempotencyKey: `${task.id}-rerun-${requeued.rerunCount}` })
    }
  }
  if (['done', 'done_with_warnings', 'no_change_needed'].includes(status)) {
    for (const sibling of store.listParkedByThread(task.threadRootId, { excludeId: task.id })) {
      store.supersede({ id: sibling.id, bySiblingId: task.id })
      console.log(`[lark-gateway] 同话题收尾：挂起任务 ${sibling.id} 由 ${task.id} 完成而 superseded`)
      if (humanMode) continue
      try {
        await sendMessage({
          chatId: sibling.chatId,
          card: buildCardContent({
            config,
            kind: 'notice',
            lines: [`**说明**：本挂起任务已由同话题任务 ${task.id} 完成，自动收尾关闭，不再催办。`],
          }),
          logPrefix: 'supersede notice',
          idempotencyKey: `${sibling.id}-superseded-by-${task.id}`.slice(0, 45),
        })
      } catch (error) {
        console.error(`[lark-gateway] supersede notice 发送失败（不阻塞收尾）：${String(error).slice(0, 120)}`)
      }
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
  // 外部群的人话回复（aven 2026-10-13 定 A 方案：以负责人用户身份发）：done → 一句话；有待跟进 → 发清单文件并 @ 负责人。
  // 独立于回执卡（回执卡只发负责人私聊），失败只记日志，不影响任务落态。
  if (humanMode && CARD_SENDING_STATUSES.has(status)) {
    const delivered = await deliverRepo({ task, status, result })
    if (delivered.ok && delivered.messageId) store.recordReceipt(task.id, { messageId: delivered.messageId, kind: status, epoch: task.epoch || 0 })
    else if (!delivered.ok && !delivered.skipped) console.error(`[lark-gateway] ${task.id} ${status} 人话消息发送失败：${delivered.reason}`)
    return { ok: true, humanDelivery: true, delivered: delivered.ok }
  }
  if (['done', 'no_change_needed'].includes(status)) {
    try {
      await postGroup({ config, task })
    } catch (error) {
      console.error(`[lark-gateway] ${task.id} 群回复发送异常：${String(error?.message || error).slice(0, 160)}`)
    }
  }
  if (CARD_SENDING_STATUSES.has(status)) {
    const receiptEpoch = task.epoch || 0
    const idempotencyKey = receiptKeyFor(task, status)
    if (receiptWasDelivered(task, idempotencyKey)) {
      if (task.pendingReceipt?.idempotencyKey === idempotencyKey) {
        delete task.pendingReceipt
        store.upsert(task)
      }
      return { ok: true, receiptAlreadyDelivered: true }
    }
    const pendingAtStart = task.pendingReceipt
    const receipt = await sendTaskReceipt({ config, task, status, result, sendMessage, idempotencyKey })
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
    if (task.pendingReceipt?.idempotencyKey === idempotencyKey) {
      delete task.pendingReceipt
    }
    store.upsert(task)
  }
  return { ok: true }
}
