#!/usr/bin/env node

/**
 * Lark Bot Gateway（本地专用）。事件源用 `lark-cli event consume` 长连接，对外暴露与 worker/poller
 * 约定的本地 HTTP 契约（/lark/health、/lark/tasks[/next|/:id/claim|/:id/retry|/prune|/:id/status]）。
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
 * 硬规则来源：apps/web/docs_tdd/common/rules/lark-bot-gateway.md、lark-active-notification.md。
 */

import { createServer } from 'node:http'
import { join } from 'node:path'
import { loadConfig } from './lib/lark-config.mjs'
import { docsDir } from './lib/lark-repo.mjs'
import { normalizeAiExecutor } from './lib/lark-http.mjs'
import { buildCardContent } from './lib/lark-cards.mjs'
import { sendChatMessage } from './lib/lark-cli.mjs'
import { createTaskStore } from './lib/lark-task-store.mjs'
import { startConsumer } from './lib/lark-consumer.mjs'
import { ingestLarkEvent } from './lib/lark-ingest.mjs'
import { retryPendingWriteback } from './lib/lark-bugtable-writeback.mjs'
import { createRequestHandler } from './lib/lark-routes.mjs'

// 沿用既有 import 路径的对外契约（单测 + 外部调用方无需改动）：pure 判定、执行器指令、状态回写处理。
export { isForBot, isWhitelisted, normalizeMessage } from './lib/lark-message.mjs'
export { parseAiExecutorDirective, resolveGatewayAiExecutor } from './lib/lark-ingest.mjs'
export { handleStatusUpdate } from './lib/lark-status.mjs'

const defaultPort = Number(process.env.LARK_GATEWAY_PORT || 3005)
// 任务领取租约：worker 领走后置 running；超过此时长仍 running 视为孤儿，下次 claim 时自动重入队。
// 必须 > worker 的 AI 执行超时（默认 30min），避免误回收正在跑的长任务。
const taskLeaseMs = Number(process.env.LARK_TASK_LEASE_MS || 40 * 60 * 1000)

// 告警卡快捷发送：dead-letter / consumer-down / writeback 告警共用同一「alert 卡 + 幂等键」形态。
const sendAlertCard = ({ config, chatId, lines, logPrefix, idempotencyKey }) =>
  sendChatMessage({
    chatId,
    card: buildCardContent({ config, kind: 'alert', lines }),
    logPrefix,
    idempotencyKey,
  })

export async function runLarkGateway({ configPath, port = defaultPort }) {
  const config = loadConfig(configPath, 'gateway config')
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
      sendAlertCard({
        config,
        chatId: task.chatId || config.bugTable?.chatId || config.allowedChatIds?.[0],
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
        chatId: config.bugTable?.chatId || config.allowedChatIds?.[0],
        lines: [`**详情**：已连续 ${attempt} 次重连仍未恢复，可能暂时收不到群内 @；请检查网络或 lark-cli 登录态。`],
        logPrefix: 'consumer-down alert',
        idempotencyKey: `consumer-down-${attempt}`,
      }),
  })

  const server = createServer(createRequestHandler({ config, store, consumer, port }))
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
