#!/usr/bin/env node

/**
 * Lark Bot Gateway（本地专用，替代已丢失的 Koa 服务）。
 *
 * 事件源用 `lark-cli event consume` 长连接，不再依赖公网 tunnel + challenge/验签。
 * 对外暴露与 common/lark-worker.mjs 已约定的本地 HTTP 契约：
 *   GET  /lark/health
 *   GET  /lark/tasks
 *   POST /lark/tasks          （外部投递，如 bug 表轮询器）
 *   POST /lark/tasks/next     （worker 领取，pending -> running）
 *   POST /lark/tasks/:id/status（worker 回写终态，触发对应回群卡；仅 done 回写 bug 表）
 *
 * 本文件只做编排 + HTTP 接线；纯函数/IO 拆到 lib/lark-*.mjs：
 *   · lib/lark-message.mjs  信封归一 + 白名单/@bot 判定（纯，可单测）
 *   · lib/lark-cards.mjs    回执卡片构建（纯）
 *   · lib/lark-cli.mjs      lark-cli 子进程 + 发消息/附件/群名缓存/引用消息
 *   · lib/lark-task-store.mjs 文件队列 + 租约回收
 *
 * 硬规则来源：apps/web/docs_tdd/common/lark-bot-gateway.md、lark-active-notification.md。
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { resolve, join, dirname } from 'node:path'

import { resolveRoots } from '../agent-scripts/lib/roots.mjs'
import { resolveAiExecutor } from './lib/lark-ai-executor.mjs'
import {
  isForBot,
  isWhitelisted,
  normalizeMessage,
  parseCommandType,
  parseProjectFromText,
  summarize,
} from './lib/lark-message.mjs'
import { buildCardContent, buildQueuedCard, buildResultCard, buildWaitingCard, formatDisplayTime, resolveOwnerMention } from './lib/lark-cards.mjs'
import {
  downloadAttachments,
  fetchReferencedContext,
  isChatMember,
  resolveChatName,
  runLarkCliWithRetry,
  sendChatMessage,
} from './lib/lark-cli.mjs'
import { createTaskStore } from './lib/lark-task-store.mjs'

// pure 判定/归一化从 lib 透出，保持既有 import 路径（单测 + 外部调用方无需改动）
export { isForBot, isWhitelisted, normalizeMessage } from './lib/lark-message.mjs'

const { consumerRoot: repoRoot } = resolveRoots()
// worktree 约定：/Users/aven/github/<项目ID>（主仓同级目录）
const worktreesDir = dirname(repoRoot)

const defaultPort = Number(process.env.LARK_GATEWAY_PORT || 3005)
// 任务领取租约：worker 领走后置 running 并盖 claimedAt；超过此时长仍 running 视为孤儿（worker 崩了），
// 下次 claim 时自动重入队。必须 > worker 的 AI 执行超时（默认 30min），避免误回收正在跑的长任务。
const taskLeaseMs = Number(process.env.LARK_TASK_LEASE_MS || 40 * 60 * 1000)
// 本地 HTTP 契约的可选共享密钥：配置后所有写操作 POST 必须带 x-lark-gateway-secret
// （worker / poller 从同名环境变量 LARK_GATEWAY_SECRET 读取）。未配置则仅靠 127.0.0.1 绑定兜底。
const gatewaySecret = process.env.LARK_GATEWAY_SECRET || ''
// POST body 上限，防止本地异常进程灌爆内存（默认 1MB）
const maxBodyBytes = Number(process.env.LARK_GATEWAY_MAX_BODY || 1024 * 1024)

const loadConfig = (configPath) => {
  const absolute = resolve(configPath)
  if (!existsSync(absolute)) {
    throw new Error(`Missing gateway config: ${absolute}`)
  }
  return JSON.parse(readFileSync(absolute, 'utf8'))
}

const docsDir = (project) => join(repoRoot, 'apps/web/docs_tdd', project)

// 群消息可用 `[codex]` / `[claude]` 临时覆盖本机默认；只返回固定枚举，不接受命令参数。
export const parseAiExecutorDirective = (text) => {
  const match = String(text || '').match(/^\s*\[(codex|claude)\](?:\s+|$)/i)
  return match ? match[1].toLowerCase() : undefined
}

// 排队卡必须展示任务最终会用的执行器，不能等 Worker 领取后才补写。
export const resolveGatewayAiExecutor = ({ requestedExecutor, config, env = process.env }) =>
  resolveAiExecutor({ localConfig: config }, { aiExecutor: requestedExecutor }, env)

// ---------------------------------------------------------------------------
// bug 表回写：done 后把记录状态从「待处理」改为约定完成值
// ---------------------------------------------------------------------------

const writeBackBugRecord = async ({ config, task }) => {
  const bug = config.bugTable
  if (!bug?.appToken || !bug?.tableId || !task.recordId) return { ok: true } // 无表可写，视作无需回写
  // doneValue 缺失就不写：文档 §5.3 明确「处理中」非合法枚举，写非法值只会让 lark-cli 报错
  if (!bug.doneValue) {
    console.warn(`[lark-gateway] bug write-back skipped: config.bugTable.doneValue 未配置，不写非法值`)
    return { ok: true } // 配置缺失是人工要处理的另一回事，不该把任务永卡中间态
  }

  const outcome = await patchBugRecordStatus({ config, task, value: bug.doneValue })
  if (outcome.ok) return { ok: true }

  // 重试仍失败 → 发群告警。否则「群里已报完成 + poller 已 seen 不再捞 + 表格永卡待处理」会静默不一致。
  // 调用方据 ok=false 把任务置 done_pending_writeback，交定时器后续重试，直至表格与实际一致。
  await sendChatMessage({
    chatId: task.chatId,
    card: buildCardContent({
      config,
      kind: 'alert',
      lines: [`**详情**：记录 ${task.recordId} 状态回写「${bug.doneValue}」失败，将自动重试；如持续失败请手动在 bug 表改状态。原因：${outcome.reason}`],
    }),
    logPrefix: 'writeback alert',
    idempotencyKey: `${task.recordId}-writeback-alert`,
  })
  return { ok: false, reason: outcome.reason }
}

// 通用 bug 表状态回写：patch statusField=value，返回 runLarkCliWithRetry 的 outcome。
// 完成回写（待推版）与领取置「修复中」共用这一条底层调用，避免两处拼 lark-cli 参数漂移。
const patchBugRecordStatus = ({ config, task, value }) => {
  const bug = config.bugTable
  return runLarkCliWithRetry(
    [
      'base', '+record-batch-update',
      '--base-token', bug.appToken,
      '--table-id', bug.tableId,
      '--json',
      JSON.stringify({ record_id_list: [task.recordId], patch: { [bug.statusField]: value } }),
    ],
    { logPrefix: `bug status ${task.recordId} -> ${value}` },
  )
}

// 领取即把 bug 记录置「修复中」（inProgressValue），让表格实时反映“正在处理”。
// best-effort：这是知会性状态、非终态一致性要求，写失败仅告警日志、绝不阻塞任务或改任务态。
// 仅 bug 表来源且配了 inProgressValue 才写；失败态按约定不写表（停在「修复中」，靠群失败卡 + 人工 retry）。
const markBugRecordInProgress = async ({ config, task }) => {
  const bug = config.bugTable
  if (!bug?.appToken || !bug?.tableId || !task.recordId || !bug.inProgressValue) return
  const outcome = await patchBugRecordStatus({ config, task, value: bug.inProgressValue })
  if (!outcome.ok) console.warn(`[lark-gateway] bug 置「${bug.inProgressValue}」失败（不阻塞任务）：${outcome.reason}`)
}

// 回写失败挂起的 bug 任务（done_pending_writeback）：定时器重试回写，成功后才落地 done。
// 只有回写与实际状态一致，poller 才会 seen 掉不再捞；否则会「群报完成 + 表格永卡待处理」。
const retryPendingWriteback = async ({ config, store }) => {
  const pending = store.list().filter((task) => task.status === 'done_pending_writeback')
  for (const task of pending) {
    const wb = await writeBackBugRecord({ config, task })
    if (wb.ok) {
      task.status = 'done'
      store.upsert(task)
      console.log(`[lark-gateway] 回写重试成功，${task.id} 落地 done`)
    }
  }
}

const appendNotificationLog = ({ config, row }) => {
  const logPath = join(docsDir(config.project), 'agent/notification-log.md')
  if (!existsSync(logPath)) return
  const content = readFileSync(logPath, 'utf8')
  const marker = '\n## 规则'
  const next = content.includes(marker)
    ? content.replace(marker, `${row}\n${marker}`)
    : `${content.trimEnd()}\n${row}\n`
  writeFileSync(logPath, next)
}

// ---------------------------------------------------------------------------
// 事件摄入
// ---------------------------------------------------------------------------

// 项目号解析优先级：群名 `[PR-xxxxx]`（权威）> 正文 PR-####。都无则返回 null，
// 由调用方回落到「主仓临时 hotfix 分支」（不再默认套 config.project，避免把无关任务塞进 PR-01947）。
// 群名优先是因为正文常引用别的工单号（如 PR-02172 群里正文提到 PR-02193），只读正文会路由到错项目。
const resolveProject = async ({ chatId, text }) => {
  const fromChatName = parseProjectFromText(await resolveChatName(chatId))
  return fromChatName || parseProjectFromText(text) || null
}

// auto 成员制白名单需查 bot 是否在该群（仅群消息且 auto 模式才查，避免无谓网络调用）
const resolveMembership = async ({ msg, config }) =>
  config.allowedChatIds === 'auto' && msg.chatType !== 'p2p' ? isChatMember(msg.chatId) : false

// 正在摄入中的 messageId（同步占位，防 TOCTOU 双跑）：lark-cli 可能把同一事件投递两次，
// 两个 onLine 并发进 ingest 会各自在 `store.has` 后、`store.upsert` 前的 await 窗口里都判为「新」，
// 双跑同一 messageId。此 Set 在任何 await 前同步占位，只有首个能进入；持久化后由 store.has 接管去重。
const ingestingMessageIds = new Set()

const ingestLarkEvent = async ({ raw, config, store }) => {
  const msg = normalizeMessage(raw)
  if (!msg || store.has(msg.messageId) || ingestingMessageIds.has(msg.messageId)) return // 非消息事件 / 幂等 / 并发占位
  ingestingMessageIds.add(msg.messageId)
  try {
    await ingestWhitelistedEvent({ msg, config, store })
  } finally {
    ingestingMessageIds.delete(msg.messageId)
  }
}

const ingestWhitelistedEvent = async ({ msg, config, store }) => {
  const isMember = await resolveMembership({ msg, config })
  if (!isWhitelisted({ msg, config, isMember }) || !isForBot({ msg, config })) return
  if (!msg.text && !msg.attachments.length && !msg.replyTo) return

  // waiting_confirmation / blocked 续任务：本条是对一条「仍卡在待确认/阻塞」的原任务的回复补料时，
  // 复用原任务续跑（append 补料 + 复用原分支/worktree），而不是新建一个孤儿任务。
  const parentTask = msg.replyTo ? store.get(msg.replyTo) : null
  if (parentTask && (parentTask.status === 'waiting_confirmation' || parentTask.status === 'blocked')) {
    const supplementAttachments = await downloadAttachments({
      repoRoot,
      project: parentTask.project || config.project,
      messageId: msg.messageId,
      attachments: msg.attachments,
    })
    const resumed = store.resumeWithSupplement({ id: parentTask.id, supplementText: msg.text, supplementAttachments })
    if (resumed) {
      console.log(`[lark-gateway] resumed task ${resumed.id} with supplement（第 ${resumed.resumeCount} 次续跑）: ${msg.text?.slice(0, 60) || '(仅附件)'}`)
      await sendChatMessage({
        chatId: resumed.chatId,
        card: buildQueuedCard({ config, task: resumed, note: '**说明**：已收到补充材料，续跑原任务（复用原分支/worktree）。' }),
        logPrefix: 'resume receipt',
        idempotencyKey: `${resumed.id}-resume-${resumed.resumeCount}`,
      })
      return
    }
  }

  // 合并被引用/被回复消息（真正的 bug 正文与截图多在父消息里）
  const refCtx = msg.replyTo ? await fetchReferencedContext(msg.replyTo) : null
  const mergedText = refCtx?.text
    ? `【被引用消息】\n${refCtx.text}\n\n【本条 @】${msg.text || '（无附言）'}`.trim()
    : msg.text
  const project = await resolveProject({ chatId: msg.chatId, text: mergedText })
  // 附件跟任务实际项目落盘；跨项目群任务不再错误写进 gateway 默认项目目录。
  const attachmentProject = project || config.project
  const resolvedAttachments = await downloadAttachments({
    repoRoot,
    project: attachmentProject,
    messageId: msg.messageId,
    attachments: msg.attachments,
  })
  const refAttachments = refCtx?.attachments?.length
    ? await downloadAttachments({ repoRoot, project: attachmentProject, messageId: msg.replyTo, attachments: refCtx.attachments })
    : []
  const attachments = [...resolvedAttachments, ...refAttachments]

  const worktreeExists = project ? existsSync(join(worktreesDir, project)) : false
  const requestedExecutor = parseAiExecutorDirective(msg.text)
  const aiExecutor = resolveGatewayAiExecutor({ requestedExecutor, config })

  const task = store.upsert({
    id: msg.messageId,
    source: 'lark',
    chatId: msg.chatId,
    messageId: msg.messageId,
    operator: msg.senderOpenId,
    project: project || null,
    commandType: parseCommandType(mergedText),
    projectTitle: config.title,
    text: mergedText,
    // 卡片「任务」摘要优先展示用户本条附言，其次被引用消息首行
    summary: summarize(msg.text?.trim() ? msg.text : refCtx?.text || ''),
    attachments,
    aiExecutor,
    status: 'queued',
    createdAt: new Date().toISOString(),
  })

  // 无 worktree（有项目号或 adhoc）统一走临时 hotfix worktree，不再发「请选择处理方式」卡片
  const note = worktreeExists
    ? undefined
    : project
      ? `**说明**：本地无 ${project} worktree，将用临时 hotfix 分支处理。`
      : '**说明**：未识别项目号（群名/正文均无），将用临时 hotfix 分支处理。'
  console.log(`[lark-gateway] queued task ${task.id} (${project || 'adhoc'})${worktreeExists ? '' : ' [temp-worktree]'}: ${task.summary}`)
  await sendChatMessage({ chatId: task.chatId, card: buildQueuedCard({ config, task, note }), logPrefix: 'queued receipt', idempotencyKey: `${task.id}-queued` })
  appendNotificationLog({
    config,
    row: `| ${formatDisplayTime()} | Lark Job | 进行中 | 收到群任务(${project || 'adhoc'})：${task.summary} | real | success |`,
  })
}

// ---------------------------------------------------------------------------
// 启动 lark-cli 长连接消费事件（保持 stdin 打开常驻）
// ---------------------------------------------------------------------------

// 长连接自愈：lark-cli 事件消费子进程掉线（WS 抖动/服务端踢连接/进程崩溃）后，
// 若不重连就静默收不到事件。这里用退避重连 + 稳定运行后重置退避 + 连续失败发群告警（可选）。
const RECONNECT_BACKOFFS_MS = [1000, 2000, 5000, 10000, 30000, 60000]
const STABLE_UPTIME_MS = 60000 // 连接存活超过此时长视为已稳定，下次掉线的退避延迟从最小重来
const ALERT_AFTER_RESTARTS = 3 // 滑动窗口内重连达到此次数 -> 发一次群告警
const RECONNECT_ALERT_WINDOW_MS = Number(process.env.LARK_RECONNECT_ALERT_WINDOW_MS || 10 * 60 * 1000) // 抖动统计窗口（默认 10min）

// 通用长连接消费（当前用于 im.message.receive_v1 收群 @）。
// onLine(raw) 处理逐行 JSON 事件；onDownAlert 可选（掉线告警）；maxRestarts 可选（未订阅类错误设上限免刷日志）。
const startConsumer = ({ eventKey, onLine, onDownAlert, maxRestarts }) => {
  // backoffAttempts 只驱动退避延迟（稳定存活后归零）；restartWindow 是滑动窗口内的掉线时间戳，
  // 驱动告警——「每 61s 抖一次」这类稳定即归零 backoff 但仍在持续掉线的情况，靠窗口计数才能告警。
  const state = { child: null, stopped: false, backoffAttempts: 0, restartWindow: [], alerted: false, lastEventAt: 0 }

  const spawnOnce = () => {
    // `--as bot`：lark-cli defaultAs:auto 会解析成 user 身份，而 event consume 只支持 bot
    // （报 "only supports: bot, use --as bot"）。显式指定，避免 consumer 反复 exit 2。
    const child = spawn(process.env.LARK_CLI_BIN || 'lark-cli', ['--as', 'bot', 'event', 'consume', eventKey], { stdio: ['pipe', 'pipe', 'pipe'] })
    state.child = child
    const spawnedAt = Date.now()
    let buffer = ''

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString()
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
        if (!line) continue
        let raw
        try {
          raw = JSON.parse(line)
        } catch {
          continue
        }
        state.lastEventAt = Date.now() // 观测：最近一次收到事件；health 据此判活
        Promise.resolve(onLine(raw)).catch((error) =>
          console.error(`[lark-gateway] ${eventKey} handler error:`, error.message),
        )
      }
    })
    child.stderr.on('data', (chunk) => process.stderr.write(`[lark-cli consume ${eventKey}] ${chunk}`))
    child.on('error', (error) => console.error(`[lark-gateway] ${eventKey} spawn error:`, error.message))
    child.on('exit', (code) => {
      state.child = null
      if (state.stopped) return

      const now = Date.now()
      // 连接曾稳定存活足够久 -> 退避延迟从头来（但不清空告警窗口：持续抖动仍需被统计到）
      if (now - spawnedAt >= STABLE_UPTIME_MS) state.backoffAttempts = 0

      // 滑动窗口：记录本次掉线、剔除窗口外的旧记录
      state.restartWindow.push(now)
      state.restartWindow = state.restartWindow.filter((ts) => now - ts <= RECONNECT_ALERT_WINDOW_MS)
      // 窗口内已恢复安静（仅剩本次）则允许下一轮再次告警
      if (state.restartWindow.length <= 1) state.alerted = false

      if (maxRestarts && state.backoffAttempts >= maxRestarts) {
        console.error(
          `[lark-gateway] ${eventKey} 连续 ${state.backoffAttempts} 次消费失败，已停止重试（多为后台未订阅该事件）；订阅后 lark-bot restart 生效`,
        )
        return
      }

      const delay = RECONNECT_BACKOFFS_MS[Math.min(state.backoffAttempts, RECONNECT_BACKOFFS_MS.length - 1)]
      state.backoffAttempts += 1
      console.error(
        `[lark-gateway] ${eventKey} consumer exited (code ${code}); reconnecting in ${delay}ms (窗口内第 ${state.restartWindow.length} 次抖动)`,
      )
      if (onDownAlert && state.restartWindow.length >= ALERT_AFTER_RESTARTS && !state.alerted) {
        state.alerted = true
        onDownAlert(state.restartWindow.length).catch((error) =>
          console.error(`[lark-gateway] ${eventKey} down alert failed:`, error.message),
        )
      }
      setTimeout(() => {
        if (!state.stopped) spawnOnce()
      }, delay)
    })
  }

  spawnOnce()

  return {
    isAlive: () => state.child != null && state.child.exitCode === null,
    // 观测快照：health 用来暴露长连接健康度（最近事件时间 / 抖动窗口计数 / 是否已告警 / 退避档位）
    observe: () => ({
      alive: state.child != null && state.child.exitCode === null,
      lastEventAt: state.lastEventAt || null,
      restartsInWindow: state.restartWindow.length,
      alerted: state.alerted,
      backoffAttempts: state.backoffAttempts,
    }),
    stop: () => {
      state.stopped = true
      state.child?.kill('SIGTERM')
    },
  }
}

// ---------------------------------------------------------------------------
// HTTP 服务
// ---------------------------------------------------------------------------

const readBody = (req) =>
  new Promise((resolve) => {
    let data = ''
    let aborted = false
    req.on('data', (chunk) => {
      if (aborted) return
      data += chunk
      if (data.length > maxBodyBytes) {
        aborted = true
        req.destroy()
        resolve({})
      }
    })
    req.on('end', () => {
      if (aborted) return
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch {
        resolve({})
      }
    })
  })

const sendJson = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

const VALID_STATUSES = new Set(['queued', 'running', 'verifying', 'done', 'failed', 'blocked', 'waiting_confirmation'])
const VALID_AI_EXECUTORS = new Set(['claude', 'codex'])

const normalizeAiExecutor = (value) => {
  if (value == null || value === '') return undefined
  const normalized = String(value).trim().toLowerCase()
  if (!VALID_AI_EXECUTORS.has(normalized)) throw new Error(`invalid aiExecutor: ${value}`)
  return normalized
}

export const handleStatusUpdate = async ({ config, store, id, status, result, aiExecutor, epoch, owner, branch }) => {
  if (!VALID_STATUSES.has(status)) return { ok: false, error: `invalid status: ${status}` }
  const task = store.get(id)
  if (!task) return { ok: false, error: 'task not found' }
  // fencing token：worker 回写须带领取时的 epoch。不匹配 = 该 worker 的领取已被租约回收/人工 retry 作废，
  // 任务已由新一代执行接管，拒绝这条迟到回写（409），防旧 worker 覆盖新执行的状态。
  // epoch 缺省（旧 worker / --once 未带）时不校验，保持向后兼容。
  if (epoch != null && Number(epoch) !== (task.epoch || 0)) {
    return { ok: false, code: 409, error: `stale epoch: got ${epoch}, current ${task.epoch || 0}` }
  }
  task.result = result
  task.aiExecutor = normalizeAiExecutor(aiExecutor) || task.aiExecutor
  if (owner != null) task.owner = owner
  // 目标提交分支：worker 在 running 回写时（AI 跑之前）就带上，故 done 卡构建时 task.branch 已就位，
  // 让完成卡显示改动落在哪个分支（去哪 review / push）。只读任务无分支，不覆盖。
  if (branch) task.branch = branch

  // 领取（worker 首次回写 running）即把 bug 记录置「修复中」，让表格实时反映“正在处理”。best-effort，不阻塞。
  if (status === 'running' && task.source === 'lark-bugtable') {
    await markBugRecordInProgress({ config, task })
  }

  // done + bug 表来源：必须回写成功才落地 done。回写失败置中间态 done_pending_writeback，
  // 由 retryPendingWriteback 定时重试，避免 poller 依 gateway=done 置 seen 后表格永卡待处理。
  if (status === 'done' && task.source === 'lark-bugtable') {
    const wb = await writeBackBugRecord({ config, task })
    task.status = wb.ok ? 'done' : 'done_pending_writeback'
  } else {
    task.status = status
  }
  store.upsert(task)
  if (status === 'done' || status === 'failed') {
    await sendChatMessage({
      chatId: task.chatId,
      card: buildResultCard({ config, task, status, result }),
      logPrefix: 'result receipt',
      idempotencyKey: `${task.id}-${status}`,
    })
    appendNotificationLog({
      config,
      row: `| ${formatDisplayTime()} | Lark Job | ${status === 'done' ? '已完成' : '阻塞中'} | ${task.summary}：${(result || '').slice(0, 60)} | real | ${status === 'done' ? 'success' : 'failed'} |`,
    })
  }
  // 待确认 / 阻塞：单独一条橙色回执（区别于完成/失败）。责任人识别：AI 自报 owner（角色/关键词）
  // 命中 config.ownerMap 则 @ 对应责任人，否则回落 @ 提单人（task.operator）并注明未识别。
  // bug 表任务通常无 operator，则不 @、仅发群。
  if (status === 'waiting_confirmation' || status === 'blocked') {
    const { mentionOpenId, ownerNote } = resolveOwnerMention({ owner: task.owner, ownerMap: config.ownerMap, operator: task.operator })
    await sendChatMessage({
      chatId: task.chatId,
      card: buildWaitingCard({ config, task, status, result, mentionOpenId, ownerNote }),
      logPrefix: `${status} receipt`,
      idempotencyKey: `${task.id}-${status}`,
    })
    appendNotificationLog({
      config,
      row: `| ${formatDisplayTime()} | Lark Job | 待确认 | ${task.summary}：${(result || '').slice(0, 60)} | real | waiting |`,
    })
  }
  return { ok: true }
}

export async function runLarkGateway({ configPath, port = defaultPort }) {
  const config = loadConfig(configPath)
  config.aiExecutor = normalizeAiExecutor(config.aiExecutor)
  const membershipMode = config.allowedChatIds === 'auto'
  if (!membershipMode && !config.allowedChatIds?.length && !config.allowedOpenIds?.length) {
    console.warn('[lark-gateway] ⚠ 未配置任何白名单（allowedChatIds/allowedOpenIds），将拒绝所有事件（fail-closed）。请填 allowedChatIds:"auto"（bot 所在群）或显式群 id。')
  }
  const store = createTaskStore({
    tasksDir: join(docsDir(config.project), 'agent/lark-tasks'),
    leaseMs: taskLeaseMs,
    // 孤儿达重投上限转 failed 死信时发一次告警卡：无人值守下这是人工介入的唯一信号
    onDeadLetter: (task) => {
      sendChatMessage({
        chatId: task.chatId || config.bugTable?.chatId || config.allowedChatIds?.[0],
        card: buildCardContent({
          config,
          kind: 'alert',
          lines: [`**详情**：任务「${task.summary || task.id}」${task.deadLetterReason}。已停止自动重投，请人工排查（修复根因后 \`lark-bot retry ${task.id}\`）。`],
        }),
        logPrefix: 'dead-letter alert',
        idempotencyKey: `${task.id}-deadletter`,
      })
    },
  })

  const alertConsumerDown = (attempt) =>
    sendChatMessage({
      chatId: config.bugTable?.chatId || config.allowedChatIds?.[0],
      card: buildCardContent({
        config,
        kind: 'alert',
        lines: [`**详情**：已连续 ${attempt} 次重连仍未恢复，可能暂时收不到群内 @；请检查网络或 lark-cli 登录态。`],
      }),
      logPrefix: 'consumer-down alert',
      idempotencyKey: `consumer-down-${attempt}`,
    })

  const consumer = startConsumer({
    eventKey: 'im.message.receive_v1',
    onLine: (raw) => ingestLarkEvent({ raw, config, store }),
    onDownAlert: alertConsumerDown,
  })

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`)
    const { pathname } = url

    try {
      // 写操作鉴权：配置了共享密钥时，所有 POST 必须带匹配的 x-lark-gateway-secret
      if (req.method === 'POST' && gatewaySecret && req.headers['x-lark-gateway-secret'] !== gatewaySecret) {
        return sendJson(res, 401, { ok: false, error: 'unauthorized' })
      }
      if (req.method === 'GET' && pathname === '/lark/health') {
        const consumerObs = consumer.observe()
        // 事件静默阈值：长连接「活着」但久无事件也可能是暗掉（服务端不再推）。仅当曾收到过事件才判静默，
        // 空闲期（从未有事件）不误报。consumer 死亡或事件过久静默 -> 非 200，供外部探活/告警。
        const staleMs = Number(process.env.LARK_EVENT_STALE_MS || 30 * 60 * 1000)
        const eventStale = consumerObs.lastEventAt != null && Date.now() - consumerObs.lastEventAt > staleMs
        const healthy = consumerObs.alive && !eventStale
        return sendJson(res, healthy ? 200 : 503, {
          ok: healthy,
          consumer: consumerObs.alive,
          consumerDetail: consumerObs,
          eventStale,
          ...store.stats(),
        })
      }
      if (req.method === 'GET' && pathname === '/lark/tasks') {
        return sendJson(res, 200, { tasks: store.list() })
      }
      if (req.method === 'POST' && pathname === '/lark/tasks/next') {
        return sendJson(res, 200, { task: store.claimNext() })
      }
      // 人工重触发：把 failed/blocked 任务重置为 queued，worker 下一轮重跑，并补发「已重新入队」卡片。
      // bug 表任务只能走这里重跑（POST 幂等命中旧 failed）；群 @ 任务也可直接重新 @。
      const retryMatch = pathname.match(/^\/lark\/tasks\/([^/]+)\/retry$/)
      if (req.method === 'POST' && retryMatch) {
        const outcome = store.retry(decodeURIComponent(retryMatch[1]))
        // retry 返回 task（成功）或 { task:null, reason }（达上限）或 null（不存在/非 failed·blocked）
        const task = outcome && 'task' in outcome ? outcome.task : outcome
        if (!task) {
          const reason = outcome?.reason || 'task not found or not retryable (must be failed/blocked)'
          return sendJson(res, 404, { ok: false, error: reason })
        }
        // 若上次因下载 bug（如历史绝对路径 --output）失败的附件，retry 时用 task.messageId 重下一次；
        // 修了下载链路后 retry 才能真正恢复视觉任务。ref 消息附件的原 messageId 未单独留存，best-effort。
        const failedAttachments = (task.attachments || []).filter((a) => a.imageKey && !a.localPath && a.downloadError)
        if (failedAttachments.length && task.messageId) {
          const redownloaded = await downloadAttachments({
            repoRoot,
            project: task.project || config.project,
            messageId: task.messageId,
            attachments: failedAttachments,
          })
          const byKey = new Map(redownloaded.map((a) => [a.imageKey, a]))
          task.attachments = task.attachments.map((a) => byKey.get(a.imageKey) || a)
          store.upsert(task)
        }
        await sendChatMessage({
          chatId: task.chatId,
          card: buildQueuedCard({ config, task }),
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
      if (req.method === 'POST' && pathname === '/lark/tasks') {
        const body = await readBody(req)
        const id = body.id || body.recordId || body.messageId
        if (!id) return sendJson(res, 400, { ok: false, error: 'missing id' })
        if (store.has(id)) return sendJson(res, 200, { task: store.get(id) })
        const task = store.upsert({
          id,
          source: body.source || 'lark-bugtable',
          chatId: body.chatId || config.bugTable?.chatId || config.allowedChatIds?.[0],
          recordId: body.recordId,
          // 无 project 一律走 adhoc 临时 hotfix worktree（与 ingest 的 project||null 口径统一）；
          // 不再回落 config.project，否则填错/跨项目的 bug 会被塞进 gateway 主项目常驻 worktree 并提交进去。
          project: body.project || null,
          commandType: parseCommandType(body.text),
          projectTitle: config.title,
          text: body.text || '',
          summary: summarize(body.text),
          attachments: body.attachments || [],
          aiExecutor: resolveGatewayAiExecutor({ requestedExecutor: normalizeAiExecutor(body.aiExecutor), config }),
          status: 'queued',
          createdAt: new Date().toISOString(),
        })
        await sendChatMessage({ chatId: task.chatId, card: buildQueuedCard({ config, task }), logPrefix: 'queued receipt', idempotencyKey: `${task.id}-queued` })
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
        })
        return sendJson(res, outcome.ok ? 200 : (outcome.code || 404), outcome)
      }
      return sendJson(res, 404, { ok: false, error: 'not found' })
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: error.message })
    }
  })

  server.listen(port, '127.0.0.1', () => {
    console.log(`[lark-gateway] listening on http://127.0.0.1:${port} for ${config.project}`)
    console.log(`[lark-gateway] whitelist chats=${config.allowedChatIds === 'auto' ? 'auto(bot 所在群)' : ((config.allowedChatIds || []).join(',') || '(none)')} consume=im.message.receive_v1`)
  })

  // 定期清理陈旧 done 任务，防止 /lark/health 计数单调增长（failed 保留待人工 retry/clear）。
  const pruneDoneAfterMs = Number(config.pruneDoneAfterHours ?? 24) * 3600000
  const pruneTimer = setInterval(() => {
    const removed = store.pruneTerminal({ olderThanMs: pruneDoneAfterMs, statuses: ['done'] })
    if (removed.length) console.log(`[lark-gateway] 清理陈旧 done 任务 ${removed.length} 条`)
  }, 60 * 60 * 1000)
  pruneTimer.unref?.()

  // 回写重试：done_pending_writeback 的 bug 任务每 5min 重试回写，成功即落地 done。
  const writebackTimer = setInterval(() => {
    retryPendingWriteback({ config, store }).catch((error) =>
      console.error(`[lark-gateway] 回写重试异常：${String(error).slice(0, 120)}`),
    )
  }, 5 * 60 * 1000)
  writebackTimer.unref?.()

  const shutdown = () => {
    clearInterval(pruneTimer)
    clearInterval(writebackTimer)
    consumer.stop()
    server.close()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const configArgIndex = process.argv.indexOf('--config')
  const configPath = configArgIndex >= 0 ? process.argv[configArgIndex + 1] : undefined
  if (!configPath) {
    console.error('usage: lark-gateway.mjs --config <path> [--port <n>]')
    process.exit(1)
  }
  const portArgIndex = process.argv.indexOf('--port')
  runLarkGateway({
    configPath,
    port: portArgIndex >= 0 ? Number(process.argv[portArgIndex + 1]) : defaultPort,
  }).catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
