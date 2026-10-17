/**
 * 任务存储：文件队列 + 内存索引。启动恢复未完成任务、领取时回收租约过期的孤儿 running 任务。
 * 逻辑集中在此，便于单测（`node --test`）覆盖租约回收与优先级排序。
 */

import { EventEmitter } from 'node:events'
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { QA_RETURN_REOPENABLE_STATUSES } from './lark-bugtable-parse.mjs'
import { hasDocAttachment } from './lark-message.mjs'
import { resolveScopeApproval } from './lark-scope-contract.mjs'

// 孤儿自动重入队上限：crash 型毒任务（每次都让 worker/AI 崩）会绕过「failed 需人工 retry」闭环
// 被无限 reclaim→领取→再崩，无限烧钱。达上限即转 failed（死信），停止自动重投，交人工。
const maxRequeue = Number(process.env.LARK_MAX_REQUEUE || 2)
// 人工 retry 上限（人在环里，主要防误触发的连环重跑；给得比自动 requeue 宽松）。
const maxRetry = Number(process.env.LARK_MAX_RETRY || 5)
const EXTERNALLY_CLOSABLE_STATUSES = new Set(['received', 'queued', 'running', 'verifying', 'waiting_confirmation', 'blocked', 'failed'])
// 任务控制通道视角下的「活动态」：尚未了结、回复其卡片时禁止 fall through 新建任务。
// 与 EXTERNALLY_CLOSABLE_STATUSES 同集合（凡可结单的都算活动），单列一份便于语义与后续演进解耦。
const CONTROL_ACTIVE_STATUSES = EXTERNALLY_CLOSABLE_STATUSES
export const isControlActiveStatus = (status) => CONTROL_ACTIVE_STATUSES.has(status)

// 入队门槛：fameex 群（bot 在群里，@bot 直呼）沿用 medium 即可；仓库 profile 的外部群按上下文判任务，
// 只有 high 且 forMe 不为 false 才自动开跑，其余 suspected 挂待确认交人（准确优先于速度）。
const intakeActionable = (task, classification, error) => {
  if (error) return false
  // 对接文档（外部群发来的 .md / .pdf …）：不看分类结果一律进执行器——先存进仓库，归属由执行器判、不归自己就 @ 负责人（aven 2026-10-14）。
  if (task?.repo && hasDocAttachment(task.attachments || [])) return true
  if (!['bug', 'requirement', 'api_reply', 'question'].includes(classification?.decision)) return false
  if (task?.repo) {
    // 负责人本人 @ 机器人下的指令：不走「拿不准先问他」，medium 也直接开跑（问他等于问自己）。
    if (task.addressedToBot && task.fromPrincipal) return ['high', 'medium'].includes(classification.confidence)
    if (classification.forMe === false) return false
    // 提问是只读代答（不开 worktree、不改代码），medium 也直接答；改代码的类别仍要 high。
    if (classification.decision === 'question') return ['high', 'medium'].includes(classification.confidence)
    return classification.confidence === 'high'
  }
  return ['high', 'medium'].includes(classification?.confidence)
}
// 结单原因 → 默认落态文案（回执卡另有面向用户文案，这里是 task.result 存档）。
const CLOSE_NOTE_BY_REASON = {
  cancelled: '人工确认取消该任务，原任务直接结单，不再排队/执行/催办。',
  no_longer_needed: '人工确认无需处理该任务，原任务直接结单，不再排队/执行/催办。',
  completed_elsewhere: '人工确认该问题已由其他人员或 AI 完成，原任务直接结单。',
}
const normalizeClosureReason = (reason) =>
  ['cancelled', 'no_longer_needed', 'completed_elsewhere'].includes(reason) ? reason : 'completed_elsewhere'
// 可重开的「已结单」任务：仅限经控制通道人工结单（externalResolution 落态）的 superseded，
// 兄弟归并 supersede（supersededBy，无 externalResolution）不走此路——那是被同话题任务完成的收尾，
// 复活它会与已完成的兄弟重复劳动。误结单可逆只针对「人手动关掉、事后发现关错」这一场景。
export const isReopenableClosedTask = (task) =>
  task?.status === 'superseded' && Boolean(task.externalResolution)
const sameIntentClassification = (left, right) =>
  ['decision', 'confidence', 'summary', 'reason'].every((key) => left?.[key] === right?.[key])

export const createTaskStore = ({ tasksDir, leaseMs, onDeadLetter } = {}) => {
  mkdirSync(tasksDir, { recursive: true })
  const tasks = new Map()

  // 启动时恢复未完成任务。解析失败的文件改名为 .corrupt 并告警，不静默跳过——
  // persist 崩溃中断会截断出非法 JSON，静默 continue 会让该任务从恢复集里彻底消失（静默丢单）。
  for (const file of readdirSync(tasksDir)) {
    if (!file.endsWith('.json')) continue
    const full = join(tasksDir, file)
    try {
      const task = JSON.parse(readFileSync(full, 'utf8'))
      tasks.set(task.id, task)
    } catch (error) {
      const corruptPath = `${full}.corrupt`
      try {
        renameSync(full, corruptPath)
      } catch {
        // 改名失败也不阻塞启动，但下面的告警仍会打
      }
      console.warn(`[lark-gateway] ⚠ 任务文件损坏，已隔离为 ${file}.corrupt（需人工排查是否丢单）：${String(error).slice(0, 120)}`)
    }
  }

  // 原子写：先写同目录 .tmp 再 rename（同文件系统 rename 是原子替换），
  // 避免进程在写一半时被 kill/断电，把唯一副本截断成非法 JSON。
  // 0600：任务 JSON 里有群消息原文、附件本地路径与 AI 结论，属业务内容，不该 world-readable。
  // 变更流（第 2 批）：每次落盘发一条 { seq, id, status, epoch, at }，留最近 500 条；worker 用长轮询 /lark/tasks/changes
  // 盯取消 / 换代，不再每个在飞任务每秒拉一次全量 dump。
  const changes = new EventEmitter()
  changes.setMaxListeners(0)
  const changeLog = []
  let changeSeq = 0
  const emitChange = (task) => {
    changeSeq += 1
    const entry = { seq: changeSeq, id: task.id, status: task.status, epoch: task.epoch || 0, at: task.updatedAt || new Date().toISOString() }
    changeLog.push(entry)
    if (changeLog.length > 500) changeLog.splice(0, changeLog.length - 500)
    changes.emit('change', entry)
  }
  const persist = (task) => {
    const target = join(tasksDir, `${task.id}.json`)
    const tmp = `${target}.tmp`
    writeFileSync(tmp, JSON.stringify(task, null, 2), { mode: 0o600 })
    renameSync(tmp, target)
    emitChange(task)
  }

  const removeFile = (id) => {
    try {
      unlinkSync(join(tasksDir, `${id}.json`))
    } catch {
      // 文件可能已被清理，忽略
    }
  }

  // 任务可自带更长租约（日报清扫单趟实施要 90 分钟，默认租约盖不住）。
  const leaseFor = (task) => (Number(task?.leaseMs) > 0 ? Number(task.leaseMs) : leaseMs)
  const isOrphan = (task, now) =>
    task.status === 'running' && task.claimedAt && now - new Date(task.claimedAt).getTime() > leaseFor(task)

  // 把任务重置回可领取态（queued）并递增 epoch（fencing token）：挡掉被作废的旧执行
  //（租约回收 / 人工 retry / 补料续跑 / 优雅退出释放）迟到回写覆盖新一代执行的状态。
  // 只做「回队 + 换代」的公共部分；各调用方按需再叠加自己的计数（requeueCount/retryCount/resumeCount）与持久化。
  const requeueTask = (task, now = Date.now()) => {
    task.status = 'queued'
    task.claimedAt = null
    // 换代后上一轮的 waiting/blocked 回执已失效；若后台发送请求仍在飞，其返回值也会因
    // pending 对象不再相同而被忽略，避免新一轮执行期间补发旧卡。
    delete task.pendingReceipt
    task.requeuedAt = new Date(now).toISOString()
    task.epoch = (task.epoch || 0) + 1
    task.updatedAt = task.requeuedAt
  }

  // 回收租约过期的孤儿 running 任务（worker 崩溃/被杀后任务不会永卡 running），重新入队待领取。
  // 达 maxRequeue 上限的任务判定为毒任务（每次都让 worker/AI 崩），转 failed 死信、停止自动重投，
  // 交人工 —— 否则会无限 reclaim→领取→再崩、无限烧钱。
  const reclaimOrphans = () => {
    const now = Date.now()
    for (const task of tasks.values()) {
      if (!isOrphan(task, now)) continue
      if ((task.requeueCount || 0) >= maxRequeue) {
        task.status = 'failed'
        task.claimedAt = null
        task.deadLetterReason = `孤儿重入队达上限（${maxRequeue} 次仍未跑完），判定为毒任务，停止自动重投，需人工排查后 retry`
        task.updatedAt = new Date(now).toISOString()
        persist(task)
        console.warn(`[lark-gateway] 孤儿任务 ${task.id} 达重投上限，转 failed 死信：${task.deadLetterReason}`)
        try {
          onDeadLetter?.(task)
        } catch (error) {
          console.error(`[lark-gateway] onDeadLetter 回调异常：${String(error).slice(0, 120)}`)
        }
        continue
      }
      requeueTask(task, now)
      task.requeueCount = (task.requeueCount || 0) + 1
      persist(task)
      console.warn(`[lark-gateway] 租约过期，重新入队孤儿任务 ${task.id}（第 ${task.requeueCount} 次，epoch=${task.epoch}）`)
    }
  }

  return {
    has: (id) => tasks.has(id),
    get: (id) => tasks.get(id),
    // list({ statuses, repo, limit })：worker 领取只拉 queued / received，不再整库 dump。
    list: ({ statuses = null, repo = null, limit = 0 } = {}) => {
      let out = [...tasks.values()]
      if (statuses?.length) out = out.filter((task) => statuses.includes(task.status))
      if (repo) out = out.filter((task) => task.repo === repo)
      return limit > 0 ? out.slice(0, limit) : out
    },
    // 变更流：since 之后的变更；since 省略 / 为负只返回当前 seq（订阅方先对齐游标）。
    changesSince: (since) => ({ seq: changeSeq, changes: Number.isFinite(since) && since >= 0 ? changeLog.filter((entry) => entry.seq > since) : [] }),
    // 等下一条变更或超时（长轮询用）。
    waitForChange: (timeoutMs) =>
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          changes.off('change', onChange)
          resolve(false)
        }, Math.max(0, timeoutMs))
        timer.unref?.()
        function onChange() {
          clearTimeout(timer)
          resolve(true)
        }
        changes.once('change', onChange)
      }),
    // 写前核对（CAS）：mutator 在副本上改，epoch 不符或 status 与预期不同则不写、返回 null。
    updateIfEpoch(id, epoch, mutator, { expectStatus = null } = {}) {
      const current = tasks.get(id)
      if (!current) return null
      if (epoch != null && (current.epoch || 0) !== Number(epoch)) return null
      if (expectStatus && current.status !== expectStatus) return null
      const next = { ...current }
      mutator(next)
      next.updatedAt = new Date().toISOString()
      tasks.set(id, next)
      persist(next)
      return next
    },
    // 供 gateway 启动/定时调用：claim 前回收只在队列有可领任务时触发，空队列下孤儿会永卡 running。
    reclaimOrphans,
    // 回执卡由机器人主动发送，其 Lark message_id 与 task.id 不同。持久化反向索引所需数据，
    // 重启后仍能把“回复这张待确认卡”的消息定位回原任务。
    findByReceiptMessageId(messageId) {
      if (!messageId) return null
      return [...tasks.values()].find((task) =>
        (task.receipts || []).some((receipt) =>
          receipt.messageId === messageId && receipt.epoch === (task.epoch || 0))) || null
    },
    // 忽略代次的回执反查：结单/取消对代次不敏感——任务续跑过(epoch++)后，人回复的可能是旧代次那张卡，
    // 上面的 findByReceiptMessageId 会因 epoch 不匹配漏掉。控制通道锚定用本方法，确保回复任意历史卡都能关掉。
    findTaskByAnyReceipt(messageId) {
      if (!messageId) return null
      return [...tasks.values()].find((task) =>
        (task.receipts || []).some((receipt) => receipt.messageId === messageId)) || null
    },
    recordReceipt(id, { messageId, kind, epoch } = {}) {
      const task = tasks.get(id)
      if (!task || !messageId) return null
      const receipts = (task.receipts || []).filter((receipt) => receipt.messageId !== messageId)
      task.receipts = [
        ...receipts,
        { messageId, kind: kind || 'receipt', epoch: epoch ?? task.epoch ?? 0, createdAt: new Date().toISOString() },
      ].slice(-20)
      persist(task)
      return task
    },
    upsert(task) {
      task.updatedAt = new Date().toISOString()
      tasks.set(task.id, task)
      persist(task)
      return task
    },
    // 同话题(thread)里仍挂起(待确认/阻塞)的其它任务：供「同话题后续 @ 归并到原任务」与
    // 「兄弟任务完成后收尾挂起任务」两处使用。threadRootId 是对称存储的稳定话题键（见 lark-message），
    // 只认 parked 态且可排除自身，避免把已了结/正在跑的任务卷进来。空 threadRootId 直接返回 []。
    listParkedByThread(threadRootId, { excludeId } = {}) {
      if (!threadRootId) return []
      return [...tasks.values()].filter((task) =>
        task.id !== excludeId &&
        task.threadRootId === threadRootId &&
        (task.status === 'waiting_confirmation' || task.status === 'blocked'))
    },
    // 同话题里仍「活动」(未了结)的其它任务：供任务控制通道 thread 兜底锚定用。比 listParkedByThread 更宽——
    // 结单/取消可作用于 queued/running 等非 parked 态；调用方仍收窄到「恰好一条」才归并，避免误关。
    listActiveByThread(threadRootId, { excludeId } = {}) {
      if (!threadRootId) return []
      return [...tasks.values()].filter((task) =>
        task.id !== excludeId &&
        task.threadRootId === threadRootId &&
        CONTROL_ACTIVE_STATUSES.has(task.status))
    },
    // 收尾一条挂起任务：它要等的补料/结论已由同话题的兄弟任务落地，故不再实施、不再催办。
    // 仅对 parked 态生效（done/failed/running 不动，避免覆盖已了结或在跑的任务）。终态 'superseded'
    // 不在催办集合内，且被纳入每小时 prune，24h 后自动清掉，不残留僵尸卡。
    supersede({ id, bySiblingId, note } = {}) {
      const task = tasks.get(id)
      if (!task || (task.status !== 'waiting_confirmation' && task.status !== 'blocked')) return null
      task.status = 'superseded'
      task.supersededBy = bySiblingId || null
      task.parkedAt = null
      task.parkedRemindedRound = 0
      task.result = note || `已由同话题任务 ${bySiblingId || '(未知)'} 完成，本挂起任务收尾关闭。`
      task.updatedAt = new Date().toISOString()
      persist(task)
      return task
    },
    // 在跑期间收到同话题补充：任务落终态后带补充再跑一轮（复用分支；补充已在 text 里）。
    requeueForSupplement(id) {
      const task = tasks.get(id)
      if (!task || !task.rerunAfterDone) return null
      delete task.rerunAfterDone
      task.rerunCount = (task.rerunCount || 0) + 1
      if (task.rerunCount > 3) {
        persist(task)
        return null
      }
      task.status = 'queued'
      task.claimedAt = null
      task.epoch = (task.epoch || 0) + 1
      task.updatedAt = new Date().toISOString()
      persist(task)
      return task
    },
    // 人工明确确认「取消 / 无需处理 / 已由其他人·AI 完成」时直接结单。落稳定终态 superseded，
    // 但允许关闭 queued/running/waiting 等未了结状态；epoch++ 使已领取的 worker 迟到回写失效。
    // closureReason 区分取消类与外部完成类，供回群文案分流——取消绝不记成「已完成」。
    closeAsExternallyResolved({ id, operator, messageId, closureReason, note } = {}) {
      const task = tasks.get(id)
      if (!task || !EXTERNALLY_CLOSABLE_STATUSES.has(task.status)) return null
      const previousStatus = task.status
      const reason = normalizeClosureReason(closureReason)
      task.status = 'superseded'
      task.claimedAt = null
      task.parkedAt = null
      task.parkedRemindedRound = 0
      delete task.pendingReceipt
      task.epoch = (task.epoch || 0) + 1
      task.closureReason = reason
      task.externalResolution = {
        previousStatus,
        closureReason: reason,
        operator: operator || null,
        messageId: messageId || null,
        resolvedAt: new Date().toISOString(),
      }
      task.result = note || CLOSE_NOTE_BY_REASON[reason]
      task.updatedAt = task.externalResolution.resolvedAt
      persist(task)
      return { task, previousStatus, closureReason: reason }
    },
    // 误结单可逆：把经控制通道人工结单的 superseded 任务复活回 queued（epoch++ 挡迟到回写），
    // 把本次结单存档进 closureHistory 留痕，再清掉 closureReason/externalResolution。复用同一 task.id
    // → resolveWorkContext 算出同一 hotfix 分支/worktree，天然复用原执行现场。非可重开任务返回 null。
    reopenClosed({ id, operator, messageId, note, supplementText = '', supplementAttachments = [] } = {}) {
      const task = tasks.get(id)
      if (!isReopenableClosedTask(task)) return null
      const supplement = String(supplementText || '').trim()
      task.closureHistory = [
        ...(task.closureHistory || []),
        {
          ...task.externalResolution,
          reopenedBy: operator || null,
          reopenedFromMessageId: messageId || null,
          reopenedAt: new Date().toISOString(),
        },
      ].slice(-20)
      delete task.closureReason
      delete task.externalResolution
      if (supplement) {
        task.text = `${task.text || ''}\n\n【重开补充】\n${supplement}`.trim()
        task.summary = task.summary || supplement.slice(0, 80)
      }
      if (supplementAttachments.length) {
        task.attachments = [...(task.attachments || []), ...supplementAttachments]
      }
      task.reopenHistory = [
        ...(task.reopenHistory || []),
        {
          operator: operator || null,
          messageId: messageId || null,
          supplementText: supplement || null,
          supplementAttachments,
          reopenedAt: new Date().toISOString(),
        },
      ].slice(-20)
      task.parkedAt = null
      task.parkedRemindedRound = 0
      task.result = note || null
      task.owner = null
      requeueTask(task)
      task.reopenedAt = task.requeuedAt
      persist(task)
      return task
    },
    // 只 @ 负责人的消息由 Worker 完成前置意图分类后在这里原子落态：
    // bug/明确需求重新排队并换代；普通消息静默终止；分类器故障单列，绝不误触发写代码。
    resolveIntake({ id, epoch, classification, error } = {}) {
      const task = tasks.get(id)
      // 状态已持久化、但路由随后发领取卡失败时，Worker 会用同一 payload 重试。
      // 仅对与已存结果完全一致的请求幂等成功；不同结果仍 409，防止覆盖已决策的入队结论。
      if (task?.intake?.resolvedAt && !task.intake.required) {
        const sameError = error != null && task.intake.error === String(error).slice(0, 1000)
        const sameClassification = error == null && task.intake.error == null &&
          sameIntentClassification(task.intake.classification, classification)
        if (sameError || sameClassification) {
          const actionable = intakeActionable(task, task.intake.classification, task.intake.error)
          // actionable 首次落态会 bump epoch，非 actionable 不换代。幂等重试只允许
          // 对应的上一代/当前代，任务后续 retry/resume 再换代后，旧 intake 请求不得重放。
          const expectedEpoch = actionable ? (task.epoch || 0) - 1 : (task.epoch || 0)
          if (epoch == null || Number(epoch) === expectedEpoch) {
            return { ok: true, actionable, alreadyResolved: true, task }
          }
        }
      }
      if (!task || task.status !== 'running' || !task.intake?.required) {
        return { ok: false, code: 409, error: 'task is not awaiting intake classification' }
      }
      if (epoch != null && Number(epoch) !== (task.epoch || 0)) {
        return { ok: false, code: 409, error: `stale epoch: got ${epoch}, current ${task.epoch || 0}` }
      }

      const actionable = intakeActionable(task, classification, error)
      // 疑似（仓库 profile 的群：判定是任务但置信度只有 medium，或 forMe 不确定）：不开跑，挂待确认，
      // 由负责人在私聊里一句「继续任务 <id>」放行；不催办。
      // forMe=false（别人的功能）直接静默忽略，不打扰负责人；只有「可能是他的事但置信度不够」才算疑似。
      const suspected = !error && !actionable && Boolean(task.repo) &&
        ['bug', 'requirement', 'api_reply', 'question'].includes(classification?.decision) && classification?.forMe !== false
      task.intake = {
        ...task.intake,
        required: false,
        classification: classification || null,
        error: error ? String(error).slice(0, 1000) : null,
        resolvedAt: new Date().toISOString(),
      }
      task.claimedAt = null
      if (classification?.topic && !task.topic) task.topic = String(classification.topic).trim().slice(0, 60)
      if (typeof classification?.waitsFor === 'string' && classification.waitsFor.trim()) task.waitsFor = classification.waitsFor.trim().slice(0, 120)
      if (Array.isArray(classification?.items)) task.ledgerItems = classification.items.filter((item) => item && typeof item.id === 'string').slice(0, 20)
      if (actionable) {
        if (classification.summary) task.summary = classification.summary.slice(0, 80)
        // 对接答复：按 api 命令类型跑（分析 / 实施提示会要求先存档答复再按答复改代码）；没显式前缀时才补。
        if (task.repo && hasDocAttachment(task.attachments || []) && !task.commandType) {
          task.commandType = 'api'
          task.commandTypeSource = 'explicit'
        }
        if (classification.decision === 'api_reply' && !task.commandType) {
          task.commandType = 'api'
          task.commandTypeSource = 'explicit'
        }
        // 提问：只读作答（status 是现有的只读命令类型），答案走 groupReply 回群。
        if (classification.decision === 'question' && !task.commandType) {
          task.commandType = 'status'
          task.commandTypeSource = 'explicit'
        }
        requeueTask(task)
      } else if (suspected) {
        task.status = 'waiting_confirmation'
        task.suspected = true
        task.parkedAt = task.intake.resolvedAt
        task.parkedRemindedRound = 99
        task.waitRound = (task.waitRound || 0) + 1
        task.result = `疑似需要处理但没把握（${classification.decision} / ${classification.confidence}${classification.forMe === false ? '，判定不归本人' : ''}）：${classification.summary || ''}\n理由：${classification.reason || ''}`
        if (classification.summary) task.summary = classification.summary.slice(0, 80)
        task.updatedAt = task.intake.resolvedAt
      } else {
        task.status = error ? 'intake_failed' : 'ignored'
        task.updatedAt = task.intake.resolvedAt
      }
      persist(task)
      return { ok: true, actionable, suspected, task }
    },
    // 主题归并：分类器判定本条是已有任务的延续 → 把本条并入目标任务，本条落 superseded（不再独立执行）。
    // 目标未开跑：追加正文一起跑；在跑：跑完带补充再跑一轮；挂起：当作补料续跑；已了结：重开目标（同分支）直接排队。
    mergeIntoTask({ fromId, intoId } = {}) {
      const from = tasks.get(fromId)
      const into = tasks.get(intoId)
      if (!from || !into || from.id === into.id) return null
      const supplement = `【同主题补充 ${new Date().toISOString().slice(0, 16)}】${String(from.text || '').trim() || '（附件）'}`
      into.text = `${into.text || ''}\n\n${supplement}`.trim()
      if (from.attachments?.length) into.attachments = [...(into.attachments || []), ...from.attachments]
      into.mergedFrom = [...(into.mergedFrom || []), from.id].slice(-50)
      let mode
      if (into.status === 'received' || into.status === 'queued') {
        mode = 'appended'
      } else if (into.status === 'running' || into.status === 'verifying') {
        into.rerunAfterDone = true
        mode = 'rerun_after_done'
      } else if (into.status === 'waiting_confirmation' && into.suspected) {
        // 疑似任务还没经负责人放行：只追加内容、继续等人，绝不因为又来一条就自动开跑。
        mode = 'appended_suspected'
      } else if (into.status === 'waiting_confirmation' || into.status === 'blocked') {
        into.waitingHistory = [...(into.waitingHistory || []), { round: into.waitRound || 1, epoch: into.epoch || 0, status: into.status, result: into.result ?? null, resumedAt: new Date().toISOString() }].slice(-20)
        into.scopeRequest = null
        requeueTask(into)
        into.resumeCount = (into.resumeCount || 0) + 1
        into.result = null
        into.owner = null
        into.parkedAt = null
        into.parkedRemindedRound = 0
        mode = 'resumed'
      } else {
        into.threadHistory = [...(into.threadHistory || []), { status: into.status, result: into.result || null, closedAt: into.updatedAt || null }].slice(-20)
        into.result = null
        into.owner = null
        into.noChangeReason = null
        into.scopeRequest = null
        into.parkedAt = null
        into.parkedRemindedRound = 0
        into.claimedAt = null
        into.status = 'queued'
        into.epoch = (into.epoch || 0) + 1
        mode = 'reopened'
      }
      if (from.commandType && !into.commandType) {
        into.commandType = from.commandType
        into.commandTypeSource = from.commandTypeSource || 'explicit'
      }
      into.updatedAt = new Date().toISOString()
      persist(into)
      from.status = 'superseded'
      from.supersededBy = into.id
      from.epoch = (from.epoch || 0) + 1
      from.updatedAt = into.updatedAt
      persist(from)
      return { into, from, mode }
    },
    // 最近 N 天同一群的任务（给分类器当「最近任务」候选）：按更新时间倒序，排除自身与已被归并的。
    listRecentForChat(chatId, { excludeId, days = 7, limit = 15 } = {}) {
      const cutoff = Date.now() - days * 24 * 60 * 60_000
      return [...tasks.values()]
        .filter((task) => task.chatId === chatId && task.id !== excludeId && task.status !== 'superseded' && task.status !== 'ignored' &&
          Date.parse(task.updatedAt || task.createdAt || 0) >= cutoff)
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
        .slice(0, limit)
    },
    // 同话题的任务已了结（done / ignored / no_change / failed）后话题里又有新消息：复用同一任务（同一分支 / worktree），
    // 带新消息重新走一遍只读意图分类（aven 2026-10-13：同话题归到同一个任务，不要开很多 worktree）。
    // 疑似任务过期（整改 #8）：挂了 maxAgeMs 还没人放行 → 静默落 ignored，返回过期的任务列表供汇总知会。
    expireSuspected({ now = Date.now(), maxAgeMs = 48 * 60 * 60 * 1000 } = {}) {
      const expired = []
      for (const task of tasks.values()) {
        if (task.status !== 'waiting_confirmation' || !task.suspected) continue
        const since = new Date(task.parkedAt || task.updatedAt || 0).getTime()
        if (!Number.isFinite(since) || since <= 0 || now - since < maxAgeMs) continue
        task.status = 'ignored'
        task.suspected = false
        task.parkedAt = null
        task.result = `${task.result || ''}\n（疑似任务 48 小时无人放行，自动关闭）`.trim()
        task.updatedAt = new Date(now).toISOString()
        persist(task)
        expired.push(task)
      }
      return expired
    },
    // 还挂着等负责人决定的疑似任务（日报 / 汇总用）。
    listSuspected() {
      return [...tasks.values()].filter((task) => task.status === 'waiting_confirmation' && task.suspected)
    },
    reopenForThread({ id, supplementText, supplementAttachments = [], notBefore } = {}) {
      const task = tasks.get(id)
      if (!task || CONTROL_ACTIVE_STATUSES.has(task.status)) return null
      task.threadHistory = [...(task.threadHistory || []), { status: task.status, result: task.result || null, closedAt: task.updatedAt || null }].slice(-20)
      task.text = `${task.text || ''}\n\n【话题新消息 ${new Date().toISOString().slice(0, 16)}】${String(supplementText || '').trim() || '（附件）'}`.trim()
      if (supplementAttachments.length) task.attachments = [...(task.attachments || []), ...supplementAttachments]
      task.status = 'received'
      task.intake = { required: true, trigger: 'thread_followup', notBefore: notBefore || null, receivedAt: new Date().toISOString() }
      task.claimedAt = null
      task.result = null
      task.owner = null
      task.noChangeReason = null
      task.scopeRequest = null
      task.parkedAt = null
      task.parkedRemindedRound = 0
      task.epoch = (task.epoch || 0) + 1
      task.updatedAt = new Date().toISOString()
      persist(task)
      return task
    },
    // 人工重触发：把失败/阻塞的任务重置为待领取，worker 下一轮重新执行。
    // 群 @ 任务本可直接重新 @（新 messageId 天然是新任务）；bug 表任务 id=record_id 固定，
    // POST 幂等会命中旧 failed，只能靠这里显式重置，否则永远重跑不了。
    retry(id) {
      const task = tasks.get(id)
      if (!task || (task.status !== 'failed' && task.status !== 'blocked')) return null
      // 人工 retry 上限：主要防误触发的连环重跑。达上限返回带原因的信号，交调用方提示人工 clean。
      if ((task.retryCount || 0) >= maxRetry) {
        return { task: null, reason: `已达人工重试上限（${maxRetry} 次），请人工排查根因后 clean 再重建，或调高 LARK_MAX_RETRY` }
      }
      requeueTask(task)
      task.retryCount = (task.retryCount || 0) + 1
      persist(task)
      return task
    },
    // 回执发送达到上限后仅重开“发卡”，不重新执行 AI、不重复提交代码。
    retryReceipt(id) {
      const task = tasks.get(id)
      if (!task?.pendingReceipt) return null
      task.pendingReceipt.attempts = 0
      task.pendingReceipt.gaveUp = false
      task.pendingReceipt.updatedAt = new Date().toISOString()
      persist(task)
      return task
    },
    // QA 验退是新的人工验收轮次，不等同于工具失败重试：保留上一轮结论到 executionHistory，
    // 用最新表格正文重建 prompt、epoch 换代后重新排队。record_id 不变，故继续复用同一 hotfix 分支。
    reopenFromQaReturn({ id, text, summary, project, recordId, chatId, aiExecutor, commandType, operator } = {}) {
      const task = tasks.get(id)
      if (!task || task.source !== 'lark-bugtable' || !QA_RETURN_REOPENABLE_STATUSES.has(task.status)) return null

      const previousResult = String(task.result || '').trim()
      const previousRound = (task.qaReturnCount || 0) + 1
      task.executionHistory = [
        ...(task.executionHistory || []),
        {
          round: previousRound,
          epoch: task.epoch || 0,
          status: task.status,
          result: task.result ?? null,
          branch: task.branch || null,
          owner: task.owner || null,
          aiExecutor: task.aiExecutor || null,
          finishedAt: task.updatedAt || null,
        },
      ]

      task.text = [
        String(text || '').trim(),
        `【验退轮次】QA 第 ${previousRound} 次验退，当前进入第 ${previousRound + 1} 轮修复。`,
        previousResult ? `【上一轮执行结果】\n${previousResult.slice(0, 4000)}` : null,
      ].filter(Boolean).join('\n\n')
      task.summary = summary || task.summary
      if (project !== undefined) task.project = project
      if (recordId) task.recordId = recordId
      if (chatId) task.chatId = chatId
      if (aiExecutor) task.aiExecutor = aiExecutor
      if (commandType) task.commandType = commandType
      if (operator) task.operator = operator

      task.result = null
      task.owner = null
      task.qualityNote = null
      task.parkedAt = null
      task.parkedRemindedRound = 0
      task.deadLetterReason = null
      task.writebackAttempts = 0
      task.writebackGaveUp = false
      task.requeueCount = 0
      task.retryCount = 0
      task.resumeCount = 0
      task.qaReturnCount = previousRound
      requeueTask(task)
      task.reopenedAt = task.requeuedAt
      persist(task)
      return task
    },
    // worker 优雅退出（收到 SIGTERM）时把它正在跑、尚未回写终态的 running 任务交还队列，
    // 让重启后的 worker 立刻重领，而不必空等 40min 租约过期。不计入 retry/requeue 上限
    //（正常运维重启不该把任务推向死信）；epoch++ 挡掉被中断执行的迟到回写。
    // 续租（worker 每 leaseMs/3 调一次）：把 claimedAt 推到现在，让 isOrphan 从最近一次心跳起算。
    // epoch 不符 = 本次执行已被作废（租约回收 / 人工 retry），拒绝续命（409），worker 据此停心跳。
    touchLease(id, epoch) {
      const task = tasks.get(id)
      if (!task) return { ok: false, code: 404, error: 'task not found' }
      if (task.status !== 'running') return { ok: false, code: 409, error: `task status ${task.status} is not running` }
      if (epoch != null && Number(epoch) !== (task.epoch || 0)) return { ok: false, code: 409, error: `stale epoch: got ${epoch}, current ${task.epoch || 0}` }
      task.claimedAt = new Date(Date.now()).toISOString()
      task.leaseTouchedAt = task.claimedAt
      persist(task)
      return { ok: true, claimedAt: task.claimedAt }
    },
    releaseRunning(id) {
      const task = tasks.get(id)
      if (!task || task.status !== 'running') return null
      requeueTask(task)
      persist(task)
      return task
    },
    // waiting_confirmation / blocked 续任务：用户补料后复用**原任务**继续跑（而非新建孤儿任务）。
    // 把补料 append 到原 task.text 并重置为 queued；因复用同一 task.id，resolveWorkContext 会算出
    // 同一 hotfix 分支/worktree，天然复用原执行现场。bump epoch 挡掉旧执行残留 worker 的迟到回写。
    // 「确认扩大范围」也走这个出口：任务因范围契约越界挂起（task.scopeRequest）且补料是确认话术时，
    // 把被拦文件（及补料里点名的文件）记入 task.scopeApprovals，重跑的分析与收尾核对都把它们并入允许集合。
    // 请求无论是否被批准都在本次续跑消费掉——下一轮核对会按新改动重新产出。
    resumeWithSupplement({ id, supplementText = '', supplementAttachments = [], operator = null } = {}) {
      const task = tasks.get(id)
      if (!task || (task.status !== 'waiting_confirmation' && task.status !== 'blocked')) return null
      const supplement = String(supplementText || '').trim()
      if (!supplement && !supplementAttachments.length) return null
      delete task.suspected
      task.waitingHistory = [
        ...(task.waitingHistory || []),
        {
          round: task.waitRound || 1,
          epoch: task.epoch || 0,
          status: task.status,
          result: task.result ?? null,
          owner: task.owner || null,
          resumedAt: new Date().toISOString(),
        },
      ].slice(-20)
      if (supplement) {
        task.text = `${task.text || ''}\n\n【补料】\n${supplement}`.trim()
        task.summary = task.summary || supplement.slice(0, 80)
      }
      if (supplementAttachments.length) {
        task.attachments = [...(task.attachments || []), ...supplementAttachments]
      }
      const approval = resolveScopeApproval({ request: task.scopeRequest, supplementText: supplement, approvedBy: operator })
      if (approval) task.scopeApprovals = [...(task.scopeApprovals || []), approval].slice(-20)
      task.scopeRequest = null
      requeueTask(task)
      task.resumeCount = (task.resumeCount || 0) + 1
      task.result = null
      task.owner = null
      task.parkedAt = null
      task.parkedRemindedRound = 0
      persist(task)
      return task
    },
    // 让 /lark/health 计数不再单调增长。返回被删除的 id 列表。
    // 注意：清 failed 会让 bug 表对应记录（若仍待处理）在 poller 下一轮被当新任务重投，
    // 等于变相自动重试，故 failed 默认保留、交由人工 retry/clear 处置。
    pruneTerminal({ olderThanMs = 0, statuses = ['done'] } = {}) {
      const cutoff = Date.now() - olderThanMs
      const removed = []
      for (const task of [...tasks.values()]) {
        if (!statuses.includes(task.status)) continue
        const ts = new Date(task.updatedAt || task.createdAt).getTime()
        if (Number.isFinite(ts) && ts > cutoff) continue
        tasks.delete(task.id)
        removeFile(task.id)
        removed.push(task.id)
      }
      return removed
    },
    // 领取一个 pending 任务并置为 running（盖 claimedAt 作租约）。
    // 领取前先回收租约过期的孤儿 running 任务（worker 崩溃/被杀后任务不会永卡 running）。
    claimNext() {
      reclaimOrphans()
      const pending = [...tasks.values()]
        .filter((task) => task.status === 'queued' || task.status === 'received')
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))[0]
      if (!pending) return null
      pending.status = 'running'
      pending.claimedAt = new Date(Date.now()).toISOString()
      pending.epoch = pending.epoch || 0 // fencing token 基线，worker 回写时须带上
      persist(pending)
      return pending
    },
    // 按 id 原子领取（并行调度器用）：先回收孤儿，再仅当该任务处于可领取态时置 running。
    // 已被并发领走 / 状态已变 → 返回 null，调用方跳过。
    claimById(id) {
      reclaimOrphans()
      const task = tasks.get(id)
      if (!task || (task.status !== 'queued' && task.status !== 'received')) return null
      // 分类去抖：话题里连发几条时，等安静一会儿再一次性分类（见 lark-ingest 的 notBefore）。
      if (task.status === 'received' && task.intake?.notBefore && Date.now() < Date.parse(task.intake.notBefore)) return null
      task.status = 'running'
      task.claimedAt = new Date(Date.now()).toISOString()
      task.epoch = task.epoch || 0 // fencing token 基线，worker 回写时须带上
      persist(task)
      return task
    },
    // 健康检查用：各状态计数 + 卡住任务 + 队列年龄 / 租约余量 / requeue·retry Top / 死信数
    stats() {
      const now = Date.now()
      const byStatus = {}
      const stuck = []
      let oldestQueuedAgeMs = 0 // 最老 pending 的排队时长（积压信号）
      let minLeaseRemainingMs = null // 所有 running 里离租约到期最近的余量（负=已超期=孤儿）
      let deadLetters = 0 // 已转 failed 的死信（deadLetterReason 存在）
      const requeued = [] // 有 requeueCount/retryCount 的任务，供暴露 Top
      for (const task of tasks.values()) {
        byStatus[task.status] = (byStatus[task.status] || 0) + 1
        if (isOrphan(task, now)) stuck.push(task.id)
        if (task.deadLetterReason) deadLetters += 1
        if (task.requeueCount || task.retryCount) {
          requeued.push({ id: task.id, requeueCount: task.requeueCount || 0, retryCount: task.retryCount || 0 })
        }
        if (task.status === 'queued' || task.status === 'received') {
          const age = now - new Date(task.createdAt || now).getTime()
          if (Number.isFinite(age) && age > oldestQueuedAgeMs) oldestQueuedAgeMs = age
        }
        if (task.status === 'running' && task.claimedAt) {
          const remaining = leaseFor(task) - (now - new Date(task.claimedAt).getTime())
          if (minLeaseRemainingMs === null || remaining < minLeaseRemainingMs) minLeaseRemainingMs = remaining
        }
      }
      const topRequeued = requeued
        .sort((a, b) => b.requeueCount + b.retryCount - (a.requeueCount + a.retryCount))
        .slice(0, 5)
      return { counts: byStatus, stuck, oldestQueuedAgeMs, minLeaseRemainingMs, deadLetters, topRequeued }
    },
  }
}
