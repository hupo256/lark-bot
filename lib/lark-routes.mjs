/**
 * Lark Gateway 的 HTTP 路由分发：createRequestHandler({config,store,consumer,port}) 返回 server 回调。
 * 覆盖 health / tasks 列表 / next / claim / release / retry / prune / 投递 / status 回写，并统一做写操作鉴权。
 */

import { configTitleFor, gatewaySecret, resolveNotifyChatId } from './lark-config.mjs'
import { normalizeAiExecutor, readBody, sendJson } from './lark-http.mjs'
import { classifyCommandType, summarize } from './lark-message.mjs'
import { versionWarnings, readWorkerHeartbeat } from './lark-runtime-version.mjs'
import { larkRuntimeDir } from './lark-repo.mjs'
import { downloadAttachments, resolveDeliveryChatId } from './lark-cli.mjs'
import { resolveGatewayAiExecutor } from './lark-ingest.mjs'
import { handleStatusUpdate, sendQueuedReceipt } from './lark-status.mjs'
import { buildCardContent } from './lark-cards.mjs'
import { sendChatMessage } from './lark-cli.mjs'

// 给某任务发一张卡（走任务的 chatId，外部群会按 profile 改投负责人），送达则登记回执便于回复锚定。
const sendChatMessageForTask = async ({ store, task, card, logPrefix, idempotencyKey }) => {
  const receipt = await sendChatMessage({ chatId: task.chatId, card, logPrefix, idempotencyKey })
  if (receipt.ok && receipt.messageId) store.recordReceipt(task.id, { messageId: receipt.messageId, kind: 'suspected', epoch: task.epoch || 0 })
  return receipt
}
import { repoProfile } from './lark-repo-profile.mjs'
import { deliverRepoIgnoredAfterAck, deliverRepoSuspected, isHumanDeliveryTask } from './lark-repo-delivery.mjs'

export const createRequestHandler = ({ config, store, consumer, port, runtimeVersion, chatPoller = null }) =>
  async function handleRequest(req, res) {
    const url = new URL(req.url, `http://127.0.0.1:${port}`)
    const { pathname } = url

    // 发回执卡前按项目号改投项目群：入队时若 bot 未进群，chatId 冻结成了私聊/通知群；此刻项目群可解析
    // 就改投并回写（持久化后本任务后续所有卡都用改投后的 id）。未命中群则语义不变、仍用原 chatId。
    const deliverTo = async (task) => {
      const chatId = await resolveDeliveryChatId({ project: task.project, fallbackChatId: task.chatId })
      if (chatId !== task.chatId) {
        task.chatId = chatId
        store.upsert(task)
      }
      return chatId
    }

    try {
      // 写操作鉴权：所有 POST 必须带匹配的 x-lark-gateway-secret。
      // 密钥缺失不再短路放行——gateway 启动时已断言必须有密钥（见 lark-gateway.mjs），
      // 这里若还保留 `gatewaySecret &&` 就等于给「配置被清空」留一条静默敞开的路。
      if (req.method === 'POST' && req.headers['x-lark-gateway-secret'] !== gatewaySecret) {
        return sendJson(res, 401, { ok: false, error: 'unauthorized' })
      }
      // /lark/tasks 列表也要鉴权：它返回全部任务的正文、附件本地路径、AI 结论与内部分支名，
      // 属于业务内容而非运行指标（health 才是可匿名探活的那个）。本机任一进程都能 curl 到，
      // 不鉴权等于把群里的工单内容对本机所有程序敞开。三个客户端（worker/poller/CLI）都已带密钥。
      if (req.method === 'GET' && pathname === '/lark/tasks' && req.headers['x-lark-gateway-secret'] !== gatewaySecret) {
        return sendJson(res, 401, { ok: false, error: 'unauthorized' })
      }
      if (req.method === 'GET' && pathname === '/lark/health') {
        const consumerObs = consumer.observe()
        // 事件静默是**诊断信号，不是存活判据**：群里夜间本就没消息，隔夜必然静默 >30min，
        // 若让它参与 ok 就会每天早上误报 503（实测 consumer alive、restarts=0 仍报不健康），
        // 把 `lark-bot start` 的健康门白等到超时、外部探活误重启。故 ok 只看长连接是否活着，
        // eventStale 仅作为 warnings 暴露给人看。
        const staleMs = Number(process.env.LARK_EVENT_STALE_MS || 30 * 60 * 1000)
        const eventStale = consumerObs.lastEventAt != null && Date.now() - consumerObs.lastEventAt > staleMs
        const stats = store.stats()
        const warnings = []
        if (eventStale) warnings.push(`已 ${Math.round((Date.now() - consumerObs.lastEventAt) / 60000)}min 无事件（夜间空闲属正常，持续整个工作日则需排查长连接）`)
        if (stats.counts?.failed) warnings.push(`${stats.counts.failed} 个 failed 任务待人工处置（lark-bot failed 查看）`)
        if (stats.counts?.intake_failed) warnings.push(`${stats.counts.intake_failed} 条 @负责人消息意图分类失败（未触发代码执行）`)
        // 中间态不出现在任何终态列表里，不在这儿点名就只能靠翻日志发现。回写重试有 1h 上限，
        // 到上限后任务**仍停在这个中间态**（见 lark-bugtable-writeback：不落 done，否则不一致会被 prune 抹掉），
        // 故这里把「还在重试」与「已放弃、等人改表格」分开报，后者是需要人动手的。
        if (stats.counts?.done_pending_writeback) {
          const gaveUp = store.list().filter((task) => task.status === 'done_pending_writeback' && task.writebackGaveUp).length
          warnings.push(
            `${stats.counts.done_pending_writeback} 个任务已完成但 bug 表状态回写挂起${gaveUp ? `，其中 ${gaveUp} 个已停止重试、需人工改表格` : '，正在重试'}`,
          )
        }
        const receiptPending = store.list().filter((task) => task.pendingReceipt)
        if (receiptPending.length) {
          const gaveUp = receiptPending.filter((task) => task.pendingReceipt.gaveUp).length
          warnings.push(
            `${receiptPending.length} 个任务回执尚未送达${gaveUp ? `，其中 ${gaveUp} 个已停止重试、需人工检查 Lark 发送能力` : '，正在重试'}`,
          )
        }
        if (stats.deadLetters) warnings.push(`${stats.deadLetters} 个死信任务`)
        // 运行版本漂移：常驻进程跑着旧代码时，本进程的一切行为都按旧版走，外部无从发现（见 lark-runtime-version）。
        // 不参与 ok 判定（同 eventStale：会让 `lark-bot start` 的健康门白等超时），但必须在 warnings + 字段里显形。
        const version = runtimeVersion?.observe() || null
        warnings.push(...versionWarnings(version))
        // worker 版本代报：两个 launchd label 独立，只重启 gateway 时 worker 会静默留在旧代码上。
        const worker = readWorkerHeartbeat({ runtimeDir: larkRuntimeDir, expectedCodeHash: version?.diskCodeHash })
        if (!worker) warnings.push('未见 worker 版本心跳（worker 未启动，或仍是不写心跳的旧版本）')
        else if (worker.heartbeatStale) warnings.push(`worker 心跳已停 ${Math.round(worker.heartbeatAgeMs / 60000)}min（pid ${worker.pid} 可能已死）`)
        else if (worker.codeStale) warnings.push(`worker 跑的是旧代码（${worker.codeHash}，磁盘 ${version?.diskCodeHash}）：需 \`lark-bot restart\``)
        if (worker && !worker.readiness?.ok) warnings.push('worker 尚未完成 AI executor/model 就绪检查，不能确认新任务可执行')
        const chatPollerObs = chatPoller?.observe?.() || null
        for (const [chatId, obs] of Object.entries(chatPollerObs || {})) {
          if (obs.consecutiveFailures > 0) warnings.push(`外部群 ${chatId} 轮询已连续失败 ${obs.consecutiveFailures} 次：${obs.lastError || ''}`)
        }
        return sendJson(res, consumerObs.alive ? 200 : 503, {
          ok: consumerObs.alive,
          consumer: consumerObs.alive,
          consumerDetail: consumerObs,
          chatPoller: chatPollerObs,
          eventStale,
          version,
          worker,
          pendingReceipts: {
            total: receiptPending.length,
            gaveUp: receiptPending.filter((task) => task.pendingReceipt.gaveUp).length,
          },
          warnings,
          ...stats,
        })
      }
      if (req.method === 'GET' && pathname === '/lark/tasks') {
        return sendJson(res, 200, { tasks: store.list() })
      }
      if (req.method === 'POST' && pathname === '/lark/tasks/next') {
        return sendJson(res, 200, { task: store.claimNext() })
      }
      // @负责人消息的前置分类回写。只有 bug / 明确需求才正式排队和发领取卡；ignore / 分类失败均静默。
      const intakeMatch = pathname.match(/^\/lark\/tasks\/([^/]+)\/intake$/)
      if (req.method === 'POST' && intakeMatch) {
        const body = await readBody(req)
        const outcome = store.resolveIntake({
          id: decodeURIComponent(intakeMatch[1]),
          epoch: body.epoch,
          classification: body.classification,
          error: body.error,
        })
        if (!outcome.ok) return sendJson(res, outcome.code || 409, outcome)
        const { task } = outcome
        // 主题归并：分类器指认本条是最近某任务的延续 → 并入那条（同一任务、同一分支），本条不再独立执行。
        const relatedId = task.intake?.classification?.relatedTaskId
        if (!outcome.alreadyResolved && (outcome.actionable || outcome.suspected) && relatedId && relatedId !== task.id && store.get(relatedId)) {
          const merged = store.mergeIntoTask({ fromId: task.id, intoId: relatedId })
          if (merged) {
            console.log(`[lark-gateway] 主题归并：${task.id} → ${merged.into.id}（${merged.mode}，主题 ${merged.into.topic || task.topic || '-'}）`)
            if (merged.mode === 'resumed' || merged.mode === 'reopened') {
              await deliverTo(merged.into)
              await sendQueuedReceipt({ config, store, task: merged.into, note: `**说明**：群里有同主题的新消息，并入原任务续跑（复用原分支）。`, logPrefix: 'merge receipt', idempotencyKey: `${merged.into.id}-merge-${task.id}`.slice(0, 50) })
            }
            return sendJson(res, 200, { ...outcome, mergedInto: merged.into.id, mode: merged.mode })
          }
        }
        if (outcome.actionable) {
          await deliverTo(task)
          await sendQueuedReceipt({
            config,
            store,
            task,
            note: `**来源**：群消息 @ 负责人，已识别为${{ bug: '缺陷', requirement: '明确需求', api_reply: '对接答复（将据此更新前端并复核）', question: '群里的提问（只读作答）' }[task.intake.classification.decision] || '任务'}。`,
            logPrefix: 'classified queued receipt',
            idempotencyKey: `${task.id}-e${task.epoch}-classified`,
          })
          if (!outcome.alreadyResolved) {
            console.log(`[lark-gateway] task-mention ${task.id} classified=${task.intake.classification.decision}/${task.intake.classification.confidence}，正式入队`)
          }
        } else if (outcome.suspected && isHumanDeliveryTask(task)) {
          await deliverTo(task)
          const sent = await deliverRepoSuspected({ task })
          if (sent.ok && sent.messageId) store.recordReceipt(task.id, { messageId: sent.messageId, kind: 'suspected', epoch: task.epoch || 0 })
          console.log(`[lark-gateway] task-mention ${task.id} classified=${task.intake.classification.decision}/${task.intake.classification.confidence} forMe=${task.intake.classification.forMe}，疑似任务挂待确认（已私聊负责人一句）`)
        } else if (outcome.suspected) {
          await deliverTo(task)
          const { mentionOpenId } = { mentionOpenId: null }
          await sendChatMessageForTask({
            config,
            store,
            task,
            card: buildCardContent({
              config,
              kind: 'waiting',
              lines: [
                `**任务**：${task.summary || task.id}`,
                `**判定**：${task.result}`,
                `**如何处理**：是你的事就回复 \`继续任务 ${task.id} 做\`（可附要求）开跑；不是就回复 \`取消任务 ${task.id}\`。不处理也不会催。`,
              ],
              project: task.project,
              projectTitle: configTitleFor(task.project, config) || '',
            }),
            logPrefix: 'suspected task notice',
            idempotencyKey: `${task.id}-e${task.epoch}-suspected`,
          })
          console.log(`[lark-gateway] task-mention ${task.id} classified=${task.intake.classification.decision}/${task.intake.classification.confidence} forMe=${task.intake.classification.forMe}，疑似任务挂待确认`)
          void mentionOpenId
        } else if (body.error) {
          console.error(`[lark-gateway] task-mention ${task.id} 分类失败，已静默停止：${String(body.error).slice(0, 160)}`)
        } else if (task.ackedInGroup && isHumanDeliveryTask(task)) {
          await deliverRepoIgnoredAfterAck({ task })
          console.log(`[lark-gateway] task-mention ${task.id} classified=ignore（群里已回过收到，已私聊负责人说明）`)
        } else {
          console.log(`[lark-gateway] task-mention ${task.id} classified=ignore，静默忽略`)
        }
        return sendJson(res, 200, outcome)
      }
      // QA 验退：同一 bug record_id 开启新一轮修复。保留上一轮执行历史、epoch 换代并补发领取卡；
      // 活动态的重复请求按幂等成功处理，避免 poller 读写并发导致整轮报错。
      const reopenMatch = pathname.match(/^\/lark\/tasks\/([^/]+)\/reopen$/)
      if (req.method === 'POST' && reopenMatch) {
        const id = decodeURIComponent(reopenMatch[1])
        const existing = store.get(id)
        if (!existing || existing.source !== 'lark-bugtable') {
          return sendJson(res, 404, { ok: false, error: 'bug table task not found' })
        }
        if (existing.status === 'queued' || existing.status === 'received' || existing.status === 'running' || existing.status === 'verifying') {
          return sendJson(res, 200, { ok: true, reopened: false, task: existing })
        }

        const body = await readBody(req)
        const task = store.reopenFromQaReturn({
          id,
          text: body.text,
          summary: summarize(body.text),
          project: body.project || null,
          recordId: body.recordId || id,
          chatId: body.chatId || existing.chatId,
          aiExecutor: resolveGatewayAiExecutor({ requestedExecutor: normalizeAiExecutor(body.aiExecutor), config }),
          commandType: body.commandType || 'fix',
          operator: body.operator || existing.operator,
        })
        if (!task) {
          return sendJson(res, 409, { ok: false, error: `task status ${existing.status} is not reopenable` })
        }
        await deliverTo(task)
        await sendQueuedReceipt({
          config,
          store,
          task,
          logPrefix: 'QA return receipt',
          idempotencyKey: `${task.id}-e${task.epoch}-qa-return`,
        })
        return sendJson(res, 200, { ok: true, reopened: true, task })
      }
      // 运维侧续跑：给 waiting_confirmation / blocked 的任务补一句说明并续跑（外部群的 webhook 卡片没有 message_id，
      // 群里回复卡片无法锚定；负责人在终端 `lark-bot resume <id> "<补充>"` 即可，不必去群里发指令）。
      const resumeMatch = pathname.match(/^\/lark\/tasks\/([^/]+)\/resume$/)
      if (req.method === 'POST' && resumeMatch) {
        const body = await readBody(req)
        const id = decodeURIComponent(resumeMatch[1])
        const existing = store.get(id)
        if (!existing) return sendJson(res, 404, { ok: false, error: 'task not found' })
        if (existing.status !== 'waiting_confirmation' && existing.status !== 'blocked') {
          return sendJson(res, 409, { ok: false, error: `task status ${existing.status} is not resumable` })
        }
        const supplementText = String(body.supplementText || '').trim()
        if (!supplementText) return sendJson(res, 400, { ok: false, error: 'missing supplementText' })
        const resumed = store.resumeWithSupplement({ id, supplementText, supplementAttachments: [], operator: body.operator || 'cli' })
        if (!resumed) return sendJson(res, 409, { ok: false, error: 'resume did not take effect' })
        await deliverTo(resumed)
        await sendQueuedReceipt({
          config,
          store,
          task: resumed,
          note: '**说明**：负责人已补充说明，续跑原任务（复用原分支/worktree）。',
          logPrefix: 'cli resume receipt',
          idempotencyKey: `${resumed.id}-resume-${resumed.resumeCount}`,
        })
        return sendJson(res, 200, { ok: true, task: resumed })
      }
      // 人工重触发：把 failed/blocked 任务重置为 queued，worker 下一轮重跑，并补发「已重新入队」卡片。
      const retryMatch = pathname.match(/^\/lark\/tasks\/([^/]+)\/retry$/)
      if (req.method === 'POST' && retryMatch) {
        const outcome = store.retry(decodeURIComponent(retryMatch[1]))
        // retry 返回 task（成功）或 { task:null, reason }（达上限）或 null（不存在/非 failed·blocked）
        const task = outcome && 'task' in outcome ? outcome.task : outcome
        if (!task) {
          const reason = outcome?.reason || 'task not found or not retryable (must be failed/blocked)'
          return sendJson(res, 404, { ok: false, error: reason })
        }
        // 上次因下载 bug 失败的附件，retry 时用 task.messageId 重下一次；修了下载链路后 retry 才能真正恢复视觉任务。
        const failedAttachments = (task.attachments || []).filter((a) => a.imageKey && !a.localPath && a.downloadError)
        if (failedAttachments.length && task.messageId) {
          const redownloaded = await downloadAttachments({
            project: task.project || config.project,
            messageId: task.messageId,
            attachments: failedAttachments,
          })
          const byKey = new Map(redownloaded.map((a) => [a.imageKey, a]))
          task.attachments = task.attachments.map((a) => byKey.get(a.imageKey) || a)
          store.upsert(task)
        }
        await deliverTo(task)
        await sendQueuedReceipt({
          config,
          store,
          task,
          logPrefix: 'retry receipt',
          idempotencyKey: `${task.id}-retry-${task.retryCount}`,
        })
        return sendJson(res, 200, { task })
      }
      // 陈旧终态清理：默认清 done（failed 需显式传 statuses，见 store 注释里的自动重投风险）。
      if (req.method === 'POST' && pathname === '/lark/tasks/prune') {
        const body = await readBody(req)
        const olderThanMs = Math.max(0, Number(body.olderThanHours ?? 0)) * 3600000
        const statuses = Array.isArray(body.statuses) && body.statuses.length ? body.statuses : ['done']
        const removed = store.pruneTerminal({ olderThanMs, statuses })
        return sendJson(res, 200, { ok: true, removed })
      }
      // 并行调度器按 id 原子领取：cwd 相同的任务串行、不同 worktree 并行，worker 侧决策哪个可领
      const claimMatch = pathname.match(/^\/lark\/tasks\/([^/]+)\/claim$/)
      if (req.method === 'POST' && claimMatch) {
        return sendJson(res, 200, { task: store.claimById(decodeURIComponent(claimMatch[1])) })
      }
      // worker 优雅退出释放租约：把它在跑的 running 任务交还队列（queued, epoch++），重启后的 worker 立刻重领。
      // 静默处理（不发卡片）——这是运维态的进程交接，对群里无意义；非 running 则 404。
      const releaseMatch = pathname.match(/^\/lark\/tasks\/([^/]+)\/release$/)
      if (req.method === 'POST' && releaseMatch) {
        const task = store.releaseRunning(decodeURIComponent(releaseMatch[1]))
        if (!task) return sendJson(res, 404, { ok: false, error: 'task not found or not running' })
        return sendJson(res, 200, { ok: true, task })
      }
      if (req.method === 'POST' && pathname === '/lark/tasks') {
        const body = await readBody(req)
        const id = body.id || body.recordId || body.messageId
        if (!id) return sendJson(res, 400, { ok: false, error: 'missing id' })
        if (store.has(id)) return sendJson(res, 200, { task: store.get(id) })
        // body.repo：外部投递（日报 / 轮询器 / 手工 curl）指定仓库 profile；非默认仓的 project 固定为其 projectKey，
        // 默认通知群也改为该仓登记的群（或 notifyChatId），不塞进 fameex 的通知群。
        const repo = body.repo ? repoProfile(body.repo) : null
        if (body.repo && (!repo || repo.key !== String(body.repo).toLowerCase())) {
          return sendJson(res, 400, { ok: false, error: `unknown repo: ${body.repo}` })
        }
        const repoChatId = repo && !repo.isDefault ? (repo.chatIds[0] || repo.notifyChatId || null) : null
        const task = store.upsert({
          id,
          source: body.source || 'lark-bugtable',
          chatId: resolveNotifyChatId(config, body.chatId || repoChatId),
          recordId: body.recordId,
          ...(repo && !repo.isDefault ? { repo: repo.key } : {}),
          // 无 project 一律走 adhoc 临时 hotfix worktree（与 ingest 的 project||null 口径统一）。
          project: repo && !repo.isDefault ? repo.projectKey : (body.project || null),
          // body.commandType 来自 poller 的 readBugCommandType（现为显式前缀 only），有值即权威口径；
          // 无值时按正文分类并记录来源，供 worker/回写/卡片据 source 决定是否可写回完成态。
          ...(() => {
            const { type, source } = body.commandType
              ? { type: body.commandType, source: 'explicit' }
              : classifyCommandType(body.text)
            return { commandType: type, commandTypeSource: source }
          })(),
          operator: body.operator || null,
          projectTitle: configTitleFor(repo && !repo.isDefault ? repo.projectKey : body.project, config),
          text: body.text || '',
          summary: summarize(body.text),
          attachments: body.attachments || [],
          aiExecutor: resolveGatewayAiExecutor({ requestedExecutor: normalizeAiExecutor(body.aiExecutor), config }),
          status: 'queued',
          createdAt: new Date().toISOString(),
        })
        await deliverTo(task)
        await sendQueuedReceipt({ config, store, task })
        return sendJson(res, 200, { task })
      }
      const statusMatch = pathname.match(/^\/lark\/tasks\/([^/]+)\/status$/)
      if (req.method === 'POST' && statusMatch) {
        const body = await readBody(req)
        const outcome = await handleStatusUpdate({
          config,
          store,
          id: decodeURIComponent(statusMatch[1]),
          status: body.status,
          result: body.result,
          aiExecutor: body.aiExecutor,
          epoch: body.epoch,
          owner: body.owner,
          branch: body.branch,
          noChangeReason: body.noChangeReason,
          scopeRequest: body.scopeRequest,
          groupReply: body.groupReply,
          followUpDoc: body.followUpDoc,
          followUps: body.followUps,
          changedFiles: body.changedFiles,
        })
        return sendJson(res, outcome.ok ? 200 : (outcome.code || 404), outcome)
      }
      const receiptRetryMatch = pathname.match(/^\/lark\/tasks\/([^/]+)\/receipt\/retry$/)
      if (req.method === 'POST' && receiptRetryMatch) {
        const task = store.retryReceipt(decodeURIComponent(receiptRetryMatch[1]))
        return sendJson(res, task ? 200 : 409, task
          ? { ok: true, task }
          : { ok: false, error: 'task has no pending receipt' })
      }
      return sendJson(res, 404, { ok: false, error: 'not found' })
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: error.message })
    }
  }
