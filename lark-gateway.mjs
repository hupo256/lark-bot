#!/usr/bin/env node

/**
 * Lark Bot Gateway（本地专用）。事件源用 `lark-cli event consume` 长连接，对外暴露与 worker/poller
 * 约定的本地 HTTP 契约（/lark/health、/lark/tasks[/next|/:id/claim|/:id/release|/:id/retry|/prune|/:id/status]）。
 *
 * 本文件只做「装配 + 生命周期」：装载配置、建 store/consumer、挂 HTTP 路由（lib/lark-routes）、
 * 起定时器（prune / 回写重试）与优雅退出。各职责已拆到 lib/lark-*：
 *   · lark-message   信封归一 + 白名单/@bot 判定（纯，可单测）
 *   · lark-cli       lark-cli 子进程 + 发消息/附件/群名缓存/引用消息
 *   · lark-task-store 文件队列 + 租约回收
 *   · lark-consumer  长连接自愈消费   · lark-ingest 事件摄入
 *   · lark-bugtable-writeback bug 表回写   · lark-status 状态回写处理
 *   · lark-routes    HTTP 路由分发   · lark-http body/响应工具
 *
 * 硬规则来源：本仓 docs/README.md；主动通知规则原在 docs_tdd@165b070 common/rules/lark-active-notification.md（已冻结，未随拆仓复制）。
 */

import { createServer } from 'node:http'
import { join } from 'node:path'
import { assertConfigOrExit, gatewaySecret, loadConfig } from './lib/lark-config.mjs'
import { sendPrincipalNote } from './lib/lark-group-exit.mjs'
import { hardenRuntimeFiles, larkRuntimeDir, larkTasksDir } from './lib/lark-repo.mjs'
import { normalizeAiExecutor } from './lib/lark-http.mjs'
import { createTaskStore } from './lib/lark-task-store.mjs'
import { startConsumer } from './lib/lark-consumer.mjs'
import { ingestLarkEvent } from './lib/lark-ingest.mjs'
import { isBugtableTombstone } from './lib/lark-bugtable-parse.mjs'
import { retryPendingWriteback } from './lib/lark-bugtable-writeback.mjs'
import { retryPendingReceipts } from './lib/lark-status.mjs'
import { remindParkedTasks } from './lib/lark-parked-reminder.mjs'
import { startLogRotation } from './lib/lark-log-rotate.mjs'
import { sweepAttachments } from './lib/lark-retention.mjs'
import { larkAttachmentsRoot, larkLatencyPath } from './lib/lark-paths.mjs'
import { installLogTimestamps } from './lib/lark-log-time.mjs'
import { createRequestHandler } from './lib/lark-routes.mjs'
import { createWorkSignal } from './lib/lark-work-signal.mjs'
import { createRuntimeVersion } from './lib/lark-runtime-version.mjs'
import { startKeepAwake } from './lib/lark-keep-awake.mjs'
import { startWakeCatchup } from './lib/lark-wake-catchup.mjs'
import { handleBotAddedEvent, startProjectChatSync } from './lib/lark-project-chat-sync.mjs'
import { sendMarkdown } from './lib/lark-cli.mjs'
import { ACK_SWEEP_EVERY_MS, sweepPendingAcks } from './lib/lark-intake-ack.mjs'
import { deliverOverdueObligations, deliverUnansweredAddressed } from './lib/lark-delivery.mjs'
import { expireSuspectedAndNotify, startDailyDigest } from './lib/lark-daily-digest.mjs'
import { startDailyReport } from './lib/lark-daily-schedule.mjs'
import { startChatRetention } from './lib/lark-chat-retention.mjs'
import { startMailRelay } from './lib/lark-mail-relay.mjs'
import { GATEWAY_HOST, defaultGatewayPort, defaultTaskLeaseMs } from './lib/lark-constants.mjs'

// 任务领取租约：worker 领走后置 running；超过此时长仍 running 视为孤儿，下次 claim 时自动重入队。
// 必须 > worker 的 AI 执行超时（默认 30min），避免误回收正在跑的长任务。

// 网关告警（死信 / 长连接断）：只私信负责人一句人话，不往群里发卡片（aven 11-02：消息不用卡片）。
const sendAlert = ({ config, text, kind, idempotencyKey }) => sendPrincipalNote({ config, text, kind, idempotencyKey })

export async function runLarkGateway({ configPath, port = defaultGatewayPort }) {
  installLogTimestamps() // gateway.log 每行带本地时间（lib/lark-log-time，LARK_LOG_TIMESTAMPS=0 关）
  // 版本快照必须在最前面拍：它代表「本进程 import 进内存的那一版源码」，晚于任何磁盘改动就失去意义。
  const runtimeVersion = createRuntimeVersion({ configPath })
  const loadedConfig = loadConfig(configPath, 'gateway config')
  const config = { ...loadedConfig, aiExecutor: normalizeAiExecutor(loadedConfig.aiExecutor) }
  // 结构校验前置：字段缺失/类型错会让下游静默跑歪（bugTable 尤甚），缺了直接拒绝启动。
  assertConfigOrExit(config, 'lark-gateway')
  const membershipMode = config.allowedChatIds === 'auto'
  // 本地 API 鉴权是硬前置：没有共享密钥时本机任一进程都能 POST 触发改代码 / commit / prune，
  // 「只绑 127.0.0.1」不构成边界。与 isWhitelisted 同一立场——缺配置就拒绝启动，而不是降级放行。
  if (!gatewaySecret) {
    console.error(
      '[lark-gateway] ✖ 缺少 LARK_GATEWAY_SECRET，拒绝启动。\n' +
        '  写入 0600 的 ~/.config/fameex-lark/gateway-secret（launchd-node.sh 与 lark-bot 均从该文件注入）：\n' +
        "  mkdir -p ~/.config/fameex-lark && (umask 077 && node -e 'process.stdout.write(require(\"crypto\").randomBytes(32).toString(\"base64url\"))' > ~/.config/fameex-lark/gateway-secret)\n" +
        '  然后 `lark-bot restart`（worker/poller 会从同一文件读同一密钥）。',
    )
    process.exit(1)
  }
  // 本机运行时文件权限收紧（配置含 bug 表 appToken/URL；历史文件多为 0644）。
  const tightened = hardenRuntimeFiles([configPath, ...['lark-bot.local.json', 'lark-worker-state.json', 'lark-bugtable-state.json'].map((name) => join(larkRuntimeDir, name))])
  if (tightened.length) console.warn(`[lark-gateway] ⚠ 已收紧运行时文件权限：${tightened.join('、')}`)
  if (!membershipMode && !config.allowedChatIds?.length && !config.allowedOpenIds?.length) {
    console.warn('[lark-gateway] ⚠ 未配置任何白名单（allowedChatIds/allowedOpenIds），将拒绝所有事件（fail-closed）。请填 allowedChatIds:"auto"（bot 所在群）或显式群 id。')
  }
  // 有活了就唤醒长轮询的 worker（GET /lark/work/wait），新消息不再白等 worker 的 5 秒轮询。
  const workSignal = createWorkSignal()
  const store = createTaskStore({
    tasksDir: larkTasksDir,
    leaseMs: defaultTaskLeaseMs,
    onClaimable: () => workSignal.bump(),
    // 孤儿达重投上限转 failed 死信时发一次告警卡：无人值守下这是人工介入的唯一信号
    onDeadLetter: (task) => {
      sendAlert({
        config,
        text: `⛔ 任务「${task.summary || task.id}」${task.deadLetterReason}，已经停止自动重投。查清原因修好后回「继续任务 ${task.id}」或跑 lark-bot retry ${task.id}。`,
        kind: 'dead-letter',
        idempotencyKey: `${task.id}-deadletter`,
      })
    },
  })

  const consumer = startConsumer({
    eventKey: 'im.message.receive_v1',
    onLine: (raw) => ingestLarkEvent({ raw, config, store }),
    onDownAlert: (attempt) =>
      sendAlert({
        config,
        text: `⚠ 飞书消息长连接连续 ${attempt} 次重连都没恢复，这段时间群里 @我可能收不到；看下网络或 lark-cli 登录。恢复后会补拉这段时间的群消息。`,
        kind: 'consumer-down',
        idempotencyKey: `consumer-down-${attempt}`,
      }),
  })

  // 项目群绑定表（aven 2026-11-01）：定时拉 bot 所在群，新入群按群名线索绑定项目号、换群改绑，回群一律按 chat_id。
  const projectChatSync = startProjectChatSync({ config })
  // 入群事件（11-01 对话层）：进群立刻同步绑定表、私信负责人；后台没订阅该事件时 consumer 自停（maxRestarts），仍靠上面的定时拉。
  const joinConsumer = startConsumer({
    eventKey: 'im.chat.member.bot.added_v1',
    maxRestarts: 5,
    onLine: (raw) => handleBotAddedEvent({ raw, config, sync: () => projectChatSync.tick(), send: sendMarkdown }),
    onDownAlert: () => {},
  })

  const server = createServer(createRequestHandler({ config, store, consumer, port, runtimeVersion, workSignal, latencyPath: larkLatencyPath }))
  server.listen(port, GATEWAY_HOST, () => {
    console.log(`[lark-gateway] listening on http://${GATEWAY_HOST}:${port} for ${config.project}`)
    console.log(`[lark-gateway] whitelist chats=${config.allowedChatIds === 'auto' ? 'auto(bot 所在群)' : ((config.allowedChatIds || []).join(',') || '(none)')} consume=im.message.receive_v1,im.chat.member.bot.added_v1`)
    console.log(`[lark-gateway] code=${runtimeVersion.codeHash} startedAt=${runtimeVersion.startedAt}（health.version 会在磁盘代码变更后报 codeStale）`)
  })

  // 开盖不空闲睡眠（caffeinate -i -w <gateway pid>，LARK_KEEP_AWAKE=0 关）；睡过 / 合过盖 → 开盖后补拉 bot 所在群
  // 睡眠期间的消息送进同一条 ingest（LARK_WAKE_CATCHUP=0 关；应用没有读群消息权限时会放弃并告警一次）。
  const keepAwake = startKeepAwake()
  const wakeCatchup = process.env.LARK_WAKE_CATCHUP === '0' ? { stop: () => {} } : startWakeCatchup({ config, store, ingest: ingestLarkEvent })

  // 定期清理陈旧终态任务，防止 /lark/health 计数单调增长（failed 保留待人工 retry/clear）。
  // no_change_needed / done_with_warnings 同属「已了结」终态，一并纳入（否则会永久残留、催办残影）。
  const pruneDoneAfterMs = Number(config.pruneDoneAfterHours ?? 24) * 3600000
  const pruneTimer = setInterval(() => {
    const removed = store.pruneTerminal({
      olderThanMs: pruneDoneAfterMs,
      statuses: ['done', 'done_with_warnings', 'no_change_needed', 'ignored', 'intake_failed', 'superseded', 'answered'],
      keep: isBugtableTombstone, // 表格仍是待处理的终局 bug 任务留着，否则 poller 当新 bug 重跑
    })
    if (removed.length) console.log(`[lark-gateway] 清理陈旧终态任务 ${removed.length} 条`)
  }, 60 * 60 * 1000)
  pruneTimer.unref?.()

  // 附件保留期清扫：lark-attachments 此前无任何清理会单调膨胀（含任务 prune 后的孤儿图片）。
  // 按目录 mtime TTL 清，每小时一次 + 启动即扫一次，默认保留 7 天（config.attachmentRetentionDays 可调）。
  const attachmentMaxAgeMs = Number(config.attachmentRetentionDays ?? 7) * 24 * 3600000
  const sweepAttachmentsOnce = () => {
    try {
      const { removed } = sweepAttachments({ attachmentsRoot: larkAttachmentsRoot, maxAgeMs: attachmentMaxAgeMs })
      if (removed) console.log(`[lark-gateway] 清理过期附件目录 ${removed} 个（保留期 ${attachmentMaxAgeMs / 86400000} 天）`)
    } catch (error) {
      console.error(`[lark-gateway] 附件清扫异常：${String(error).slice(0, 120)}`)
    }
  }
  sweepAttachmentsOnce()
  const sweepTimer = setInterval(sweepAttachmentsOnce, 60 * 60 * 1000)
  sweepTimer.unref?.()

  // 孤儿租约回收：worker 只在队列有可领任务时才 claim，仅靠 claim 前回收会让空队列下的孤儿永卡 running
  //（2026-10-05 gateway 重启致 worker release 失败，任务卡了 5 天）。启动即扫一次，之后每 5min 一次。
  store.reclaimOrphans()
  const reclaimTimer = setInterval(() => store.reclaimOrphans(), 5 * 60 * 1000)
  reclaimTimer.unref?.()

  // 回写重试：done_pending_writeback 的 bug 任务每 5min 重试回写，成功即落地 done。
  const writebackTimer = setInterval(() => {
    retryPendingWriteback({ config, store }).catch((error) =>
      console.error(`[lark-gateway] 回写重试异常：${String(error).slice(0, 120)}`),
    )
  }, 5 * 60 * 1000)
  writebackTimer.unref?.()

  // 回执重试：终态/挂起卡发送失败时任务会持久化 pendingReceipt，避免“已 done 但群里无消息”。
  const receiptTimer = setInterval(() => {
    retryPendingReceipts({ config, store }).catch((error) =>
      console.error(`[lark-gateway] 回执重试异常：${String(error).slice(0, 120)}`),
    )
  }, 5 * 60 * 1000)
  receiptTimer.unref?.()

  // 挂起催办：waiting_confirmation / blocked 的任务每 15min 盘一遍，超时未处理按轮次催办。
  // 无此定时器时，挂起任务只有最初那一条回执，被群里讨论刷下去就再无人记得。
  // 同一轮顺带：答应了 4h 没结论的私信负责人一次（回复义务）、群里 @bot 半小时一句没回过的私信一次、疑似 48h 没人认领的自动关（合并私信一条）。
  const parkedTimer = setInterval(() => {
    remindParkedTasks({ config, store }).catch((error) =>
      console.error(`[lark-gateway] 挂起催办异常：${String(error).slice(0, 120)}`),
    )
    deliverOverdueObligations({ config, store }).catch((error) =>
      console.error(`[lark-gateway] 逾期义务巡检异常：${String(error).slice(0, 120)}`),
    )
    // 群里 @bot 半小时一句没回过的：私信负责人一次（不变量巡检，b4 波 6 E3）。
    deliverUnansweredAddressed({ config, store }).catch((error) =>
      console.error(`[lark-gateway] 未回 @ 巡检异常：${String(error).slice(0, 120)}`),
    )
    expireSuspectedAndNotify({ config, store }).catch((error) =>
      console.error(`[lark-gateway] 疑似过期巡检异常：${String(error).slice(0, 120)}`),
    )
  }, 15 * 60 * 1000)
  parkedTimer.unref?.()

  // 「收到」兜底：挂着 ackPending 的任务到点（45s）还没分类就发固定句；启动先跑一次接上重启前挂着的。
  const sweepAcks = () => sweepPendingAcks({ config, store }).catch((error) => console.error(`[lark-gateway] 收到巡检异常：${String(error).slice(0, 120)}`))
  sweepAcks()
  const ackTimer = setInterval(sweepAcks, ACK_SWEEP_EVERY_MS)
  ackTimer.unref?.()

  // 每天「等你决定的 n 条」（疑似 / 扣下的草稿 / 答应了没结论 / 等材料超 24h）私信负责人；没有就不发。
  const digest = startDailyDigest({ config, store })
  // fameex 日报（默认工作日 19:00，config.dailyReport）：到点建系统任务交给 worker 生成，只私发负责人。
  const dailyReport = startDailyReport({ config, store })
  // 闲置群自动退出（默认每天 09:35，config.chatRetention）：14 天没人 @bot 先私信负责人，48 小时后还没人找就退群。
  const chatRetention = startChatRetention({ config })
  // 审批邮件 → 审批群（11-02，config.mailRelay 路由表；OL 上线附评分）：默认每 2 分钟 mail +triage 拉一次（邮箱主人 user 身份）；
  // 不在本应用里开 mail +watch——它另开的 WebSocket 会分走私信 / @bot 事件（11-02 实测丢了 6 条），见 lib/lark-mail-relay。
  // 拆成独立应用时这里关掉，改跑 scripts/lark-mail-relay.mjs run（见 lib/lark-mail-relay.mjs 头注释）。
  // 连续读收件箱失败（默认 5 次）私信负责人一次、恢复再报一次；收件人可用 mailRelay.alert.openId 另配。
  const mailRelay = startMailRelay({ relay: config.mailRelay, notifyOpenId: config.notifyOpenId })

  // 日志轮转：launchd 把 stdout/stderr 定向到固定文件，进程可连跑数周不重启，日志无上限。
  // 只有 plist 注入了 LARK_LOG_FILE 才生效（前台手跑不截断任何文件）。
  const logTimer = startLogRotation()

  const shutdown = () => {
    clearInterval(pruneTimer)
    projectChatSync.stop()
    clearInterval(sweepTimer)
    clearInterval(writebackTimer)
    clearInterval(receiptTimer)
    clearInterval(parkedTimer)
    clearInterval(ackTimer)
    digest.stop()
    dailyReport.stop()
    chatRetention.stop()
    mailRelay.stop()
    if (logTimer) clearInterval(logTimer)
    wakeCatchup.stop()
    keepAwake.stop()
    joinConsumer.stop()
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
    port: portArgIndex >= 0 ? Number(process.argv[portArgIndex + 1]) : defaultGatewayPort,
  }).catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
