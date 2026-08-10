/**
 * Lark Gateway 的 HTTP 路由分发：createRequestHandler({config,store,consumer,port}) 返回 server 回调。
 * 覆盖 health / tasks 列表 / next / claim / release / retry / prune / 投递 / status 回写，并统一做写操作鉴权。
 */

import { gatewaySecret } from './lark-config.mjs'
import { repoRoot } from './lark-repo.mjs'
import { normalizeAiExecutor, readBody, sendJson } from './lark-http.mjs'
import { parseCommandType, summarize } from './lark-message.mjs'
import { buildQueuedCard } from './lark-cards.mjs'
import { downloadAttachments, sendChatMessage } from './lark-cli.mjs'
import { resolveGatewayAiExecutor } from './lark-ingest.mjs'
import { handleStatusUpdate } from './lark-status.mjs'

export const createRequestHandler = ({ config, store, consumer, port }) =>
  async function handleRequest(req, res) {
    const url = new URL(req.url, `http://127.0.0.1:${port}`)
    const { pathname } = url

    try {
      // 写操作鉴权：配置了共享密钥时，所有 POST 必须带匹配的 x-lark-gateway-secret
      if (req.method === 'POST' && gatewaySecret && req.headers['x-lark-gateway-secret'] !== gatewaySecret) {
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
        if (stats.deadLetters) warnings.push(`${stats.deadLetters} 个死信任务`)
        return sendJson(res, consumerObs.alive ? 200 : 503, {
          ok: consumerObs.alive,
          consumer: consumerObs.alive,
          consumerDetail: consumerObs,
          eventStale,
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
        const task = store.upsert({
          id,
          source: body.source || 'lark-bugtable',
          chatId: body.chatId || config.bugTable?.chatId || config.allowedChatIds?.[0],
          recordId: body.recordId,
          // 无 project 一律走 adhoc 临时 hotfix worktree（与 ingest 的 project||null 口径统一）。
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
  }
