#!/usr/bin/env node

/**
 * Lark Bot Gateway（本地专用）。事件源用 `lark-cli event consume` 长连接，对外暴露与 worker/poller
 * 约定的本地 HTTP 契约（/lark/health、/lark/tasks[/next|/:id/claim|/:id/release|/:id/retry|/prune|/:id/status]）。
 *
 * 本文件只做「装配 + 生命周期」：装载配置、建 store/consumer、挂 HTTP 路由（lib/lark-routes）、
 * 起定时器（prune / 回写重试）与优雅退出。各职责已拆到 lib/lark-*：
 *   · lark-message   信封归一 + 白名单/@bot 判定（纯，可单测）
 *   · lark-cards     回执卡片构建（纯）
 *   · lark-cli       lark-cli 子进程 + 发消息/附件/群名缓存/引用消息
 *   · lark-task-store 文件队列 + 租约回收
 *   · lark-consumer  长连接自愈消费   · lark-ingest 事件摄入
 *   · lark-bugtable-writeback bug 表回写 + 通知日志   · lark-status 状态回写处理
 *   · lark-routes    HTTP 路由分发   · lark-http body/响应工具
 *
 * 硬规则来源：apps/web/docs_tdd/common/lark-bot/docs/README.md、common/rules/lark-active-notification.md。
 */

import { createServer } from 'node:http'
import { loadConfig, resolveNotifyChatId } from './lib/lark-config.mjs'
import { larkTasksDir } from './lib/lark-repo.mjs'
import { normalizeAiExecutor } from './lib/lark-http.mjs'
import { buildCardContent } from './lib/lark-cards.mjs'
import { sendChatMessage } from './lib/lark-cli.mjs'
import { createTaskStore } from './lib/lark-task-store.mjs'
import { startConsumer } from './lib/lark-consumer.mjs'
import { ingestLarkEvent } from './lib/lark-ingest.mjs'
import { retryPendingWriteback } from './lib/lark-bugtable-writeback.mjs'
import { remindParkedTasks } from './lib/lark-parked-reminder.mjs'
import { startLogRotation } from './lib/lark-log-rotate.mjs'
import { prdsRootDir, sweepAttachments } from './lib/lark-retention.mjs'
import { createRequestHandler } from './lib/lark-routes.mjs'
import { createRuntimeVersion } from './lib/lark-runtime-version.mjs'
import { GATEWAY_HOST, defaultGatewayPort, defaultTaskLeaseMs } from './lib/lark-constants.mjs'

// 任务领取租约：worker 领走后置 running；超过此时长仍 running 视为孤儿，下次 claim 时自动重入队。
// 必须 > worker 的 AI 执行超时（默认 30min），避免误回收正在跑的长任务。

// 告警卡快捷发送：dead-letter / consumer-down / writeback 告警共用同一「alert 卡 + 幂等键」形态。
const sendAlertCard = ({ config, chatId, lines, logPrefix, idempotencyKey }) =>
  sendChatMessage({
    chatId,
    card: buildCardContent({ config, kind: 'alert', lines }),
    logPrefix,
    idempotencyKey,
  })

export async function runLarkGateway({ configPath, port = defaultGatewayPort }) {
  // 版本快照必须在最前面拍：它代表「本进程 import 进内存的那一版源码」，晚于任何磁盘改动就失去意义。
  const runtimeVersion = createRuntimeVersion({ configPath })
  const loadedConfig = loadConfig(configPath, 'gateway config')
  const config = { ...loadedConfig, aiExecutor: normalizeAiExecutor(loadedConfig.aiExecutor) }
  const membershipMode = config.allowedChatIds === 'auto'
  if (!membershipMode && !config.allowedChatIds?.length && !config.allowedOpenIds?.length) {
    console.warn('[lark-gateway] ⚠ 未配置任何白名单（allowedChatIds/allowedOpenIds），将拒绝所有事件（fail-closed）。请填 allowedChatIds:"auto"（bot 所在群）或显式群 id。')
  }
  const store = createTaskStore({
    tasksDir: larkTasksDir,
    leaseMs: defaultTaskLeaseMs,
    // 孤儿达重投上限转 failed 死信时发一次告警卡：无人值守下这是人工介入的唯一信号
    onDeadLetter: (task) => {
      sendAlertCard({
        config,
        chatId: resolveNotifyChatId(config, task.chatId),
        lines: [`**详情**：任务「${task.summary || task.id}」${task.deadLetterReason}。已停止自动重投，请人工排查（修复根因后 \`lark-bot retry ${task.id}\`）。`],
        logPrefix: 'dead-letter alert',
        idempotencyKey: `${task.id}-deadletter`,
      })
    },
  })

  const consumer = startConsumer({
    eventKey: 'im.message.receive_v1',
    onLine: (raw) => ingestLarkEvent({ raw, config, store }),
    onDownAlert: (attempt) =>
      sendAlertCard({
        config,
        chatId: resolveNotifyChatId(config),
        lines: [`**详情**：Lark 事件长连接已连续 ${attempt} 次重连仍未恢复，可能暂时收不到群内 @；请检查网络或 lark-cli 登录态。`],
        logPrefix: 'consumer-down alert',
        idempotencyKey: `consumer-down-${attempt}`,
      }),
  })

  const server = createServer(createRequestHandler({ config, store, consumer, port, runtimeVersion }))
  server.listen(port, GATEWAY_HOST, () => {
    console.log(`[lark-gateway] listening on http://${GATEWAY_HOST}:${port} for ${config.project}`)
    console.log(`[lark-gateway] whitelist chats=${config.allowedChatIds === 'auto' ? 'auto(bot 所在群)' : ((config.allowedChatIds || []).join(',') || '(none)')} consume=im.message.receive_v1`)
    console.log(`[lark-gateway] code=${runtimeVersion.codeHash} startedAt=${runtimeVersion.startedAt}（health.version 会在磁盘代码变更后报 codeStale）`)
  })

  // 定期清理陈旧终态任务，防止 /lark/health 计数单调增长（failed 保留待人工 retry/clear）。
  // no_change_needed / done_with_warnings 同属「已了结」终态，一并纳入（否则会永久残留、催办残影）。
  const pruneDoneAfterMs = Number(config.pruneDoneAfterHours ?? 24) * 3600000
  const pruneTimer = setInterval(() => {
    const removed = store.pruneTerminal({
      olderThanMs: pruneDoneAfterMs,
      statuses: ['done', 'done_with_warnings', 'no_change_needed', 'ignored', 'intake_failed'],
    })
    if (removed.length) console.log(`[lark-gateway] 清理陈旧终态任务 ${removed.length} 条`)
  }, 60 * 60 * 1000)
  pruneTimer.unref?.()

  // 附件保留期清扫：lark-attachments 此前无任何清理会单调膨胀（含任务 prune 后的孤儿图片）。
  // 按目录 mtime TTL 清，每小时一次 + 启动即扫一次，默认保留 7 天（config.attachmentRetentionDays 可调）。
  const attachmentMaxAgeMs = Number(config.attachmentRetentionDays ?? 7) * 24 * 3600000
  const sweepAttachmentsOnce = () => {
    try {
      const { removed } = sweepAttachments({ prdsRoot: prdsRootDir(), maxAgeMs: attachmentMaxAgeMs })
      if (removed) console.log(`[lark-gateway] 清理过期附件目录 ${removed} 个（保留期 ${attachmentMaxAgeMs / 86400000} 天）`)
    } catch (error) {
      console.error(`[lark-gateway] 附件清扫异常：${String(error).slice(0, 120)}`)
    }
  }
  sweepAttachmentsOnce()
  const sweepTimer = setInterval(sweepAttachmentsOnce, 60 * 60 * 1000)
  sweepTimer.unref?.()

  // 回写重试：done_pending_writeback 的 bug 任务每 5min 重试回写，成功即落地 done。
  const writebackTimer = setInterval(() => {
    retryPendingWriteback({ config, store }).catch((error) =>
      console.error(`[lark-gateway] 回写重试异常：${String(error).slice(0, 120)}`),
    )
  }, 5 * 60 * 1000)
  writebackTimer.unref?.()

  // 挂起催办：waiting_confirmation / blocked 的任务每 15min 盘一遍，超时未处理按轮次催办。
  // 无此定时器时，挂起任务只有最初那一条回执，被群里讨论刷下去就再无人记得。
  const parkedTimer = setInterval(() => {
    remindParkedTasks({ config, store }).catch((error) =>
      console.error(`[lark-gateway] 挂起催办异常：${String(error).slice(0, 120)}`),
    )
  }, 15 * 60 * 1000)
  parkedTimer.unref?.()

  // 日志轮转：launchd 把 stdout/stderr 定向到固定文件，进程可连跑数周不重启，日志无上限。
  // 只有 plist 注入了 LARK_LOG_FILE 才生效（前台手跑不截断任何文件）。
  const logTimer = startLogRotation()

  const shutdown = () => {
    clearInterval(pruneTimer)
    clearInterval(sweepTimer)
    clearInterval(writebackTimer)
    clearInterval(parkedTimer)
    if (logTimer) clearInterval(logTimer)
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
