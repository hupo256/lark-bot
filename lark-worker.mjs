#!/usr/bin/env node

/**
 * Lark Bot Gateway worker：从 Gateway 领取 pending 任务派给 AI 执行，跑规范闸/可信度评估后回写。
 * 本文件只做「装配 + 调度」——领取任务、按 workContext（同一 worktree 串行、不同 worktree 并行）
 * 分发给 lib/lark-task-runner。各职责（git/审计/路由/规范闸/结果文案/AI 编排/HTTP）已拆到 lib/lark-*。
 */

import {
  defaultAiExecutor,
  defaultConcurrency,
  defaultGatewayUrl,
  defaultPollMs,
} from './lib/lark-worker-env.mjs'
import { aiTimeoutMs, resolveAiExecutor } from './lib/lark-ai-executor.mjs'
import { createGatewayClient, sleep } from './lib/lark-gateway-client.mjs'
import { loadWorkerLocalConfig } from './lib/lark-worker-run.mjs'
import { resolveWorkContext } from './lib/lark-work-context.mjs'
import { createTaskRunner } from './lib/lark-task-runner.mjs'

// 对外契约：测试与其它模块沿用从本文件导入这些符号（实现已下沉到 lib/，此处只再导出门面）。
export { safeProject, resolveWorkContext } from './lib/lark-work-context.mjs'
export { pruneStaleAudits } from './lib/lark-worker-audit.mjs'
export { assessDoneResult, crossCheckChangedFiles, detectChangeTier, splitViolations } from './lib/lark-quality-gate.mjs'
export { classifyWorkerFailure } from './lib/lark-worker-results.mjs'
export { gatewayStatusForAiStatus, isCompletedAiStatus } from './lib/lark-ai-result.mjs'
export { requestJson } from './lib/lark-gateway-client.mjs'
export { buildAnalysisPrompt, buildTaskPrompt, buildValidationRequirements } from './lib/lark-worker-prompts.mjs'
export { normalizeAnalysisForTask } from './lib/lark-worker-run.mjs'
export { shouldSyncProjectDocs } from './lib/lark-task-runner.mjs'

function printHelp() {
  console.log(`usage: lark-worker.mjs [--once] [--help]

Lark Bot Gateway worker: claim pending tasks from the gateway and dispatch them to codex.
Normally invoked by the per-project wrapper; this module also exports runLarkWorker().

Options:
  --help  Show this help message and exit
  --once  Process one task then exit instead of polling forever`)
}

if (process.argv.includes('--help')) {
  printHelp()
  process.exit(0)
}

export async function runLarkWorker({
  argv = process.argv.slice(2),
  gatewayUrl = defaultGatewayUrl,
  pollMs = defaultPollMs,
  projectId,
  projectName,
  projectDocs = [],
  aiExecutor = defaultAiExecutor,
  configPath,
  repoCwd,
}) {
  if (!projectId || !projectName) {
    throw new Error('runLarkWorker requires projectId and projectName')
  }

  // 焊死「孤儿回收不与活着的 AI 双跑」这条唯一防线：AI 执行超时必须 < gateway 租约。
  // 否则 AI 还在跑，gateway 已判租约过期把任务重投/领走，两个 AI 同 worktree 改文件打架。
  // 默认 30min < 40min 成立；env 覆盖（LARK_WORKER_AI_TIMEOUT_MS / LARK_TASK_LEASE_MS）可能破坏，故启动即断言。
  const leaseMs = Number(process.env.LARK_TASK_LEASE_MS || 40 * 60 * 1000)
  if (Number.isFinite(aiTimeoutMs) && aiTimeoutMs > 0 && aiTimeoutMs >= leaseMs) {
    throw new Error(
      `[lark-worker] 配置冲突：AI 超时(${aiTimeoutMs}ms) 必须小于任务租约 LARK_TASK_LEASE_MS(${leaseMs}ms)，` +
        '否则孤儿回收会与活着的 AI 双跑同一 worktree。请调低 LARK_WORKER_AI_TIMEOUT_MS 或调高 LARK_TASK_LEASE_MS。',
    )
  }

  const localConfig = loadWorkerLocalConfig(configPath)
  const workerConfig = { projectId, projectName, projectDocs, aiExecutor, localConfig, repoCwd }
  const startupExecutor = resolveAiExecutor(workerConfig, {})
  const codexProfile = startupExecutor === 'codex'
    ? ` model=${localConfig.codexModel || '(Codex default)'} reasoning=${localConfig.codexReasoningEffort || '(Codex default)'}`
    : ''
  console.log(`[lark-worker] AI executor=${startupExecutor}${codexProfile}（task > env > config > wrapper）`)

  const client = createGatewayClient(gatewayUrl)
  const runTask = createTaskRunner({ client, workerConfig })

  if (argv.includes('--once')) {
    const task = await client.getNextPendingTask()
    if (task) await runTask(task, resolveWorkContext(workerConfig, task))
    return
  }

  // 优雅退出：SIGTERM/SIGINT（launchd bootout 与 lark-bot stop 都发 SIGTERM）时，先把在飞任务
  // 交还队列（releaseTask → queued + epoch++），再中断在跑的 AI 子进程，让重启后的 worker 立刻重领，
  // 而非空等 40min 租约过期。必须「先释放再 abort」：被中断执行随后那条 failed 迟到回写会因 epoch
  // 不匹配被 gateway 409 挡掉，任务干净停在 queued。中断 AI 子进程是必须的——Node 退出不杀子进程，
  // 不杀会与重领后的新 AI 双跑同一 worktree。
  const shutdownController = new AbortController()
  const inFlight = new Map() // cwd -> { promise, taskId }
  let shuttingDown = false
  const gracefulShutdown = async (signal) => {
    if (shuttingDown) return
    shuttingDown = true
    const entries = [...inFlight.values()]
    console.log(`[lark-worker] 收到 ${signal}，优雅退出：交还 ${entries.length} 个在飞任务并中断 AI`)
    await Promise.allSettled(
      entries.map(({ taskId }) =>
        client.releaseTask(taskId).catch((error) =>
          console.error(`[lark-worker] 释放任务 ${taskId} 失败（回落到租约过期回收）：${String(error).slice(0, 120)}`),
        ),
      ),
    )
    shutdownController.abort()
    // 给在飞任务一点收尾时间（worktree 清理等），但不超过 launchd SIGKILL 宽限（~5s）。
    await Promise.race([Promise.allSettled(entries.map(({ promise }) => promise)), sleep(3000)])
    process.exit(0)
  }
  process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'))
  process.on('SIGINT', () => void gracefulShutdown('SIGINT'))

  // 并行调度器：inFlight 以 workContext.cwd 为 key（同一 worktree 只允许一个在飞、天然串行；
  // 不同 worktree 并行）。git worktree add/remove 等走 spawnSync 同步执行，本就互不交错，无需额外锁。
  for (;;) {
    // 本轮跳过集：claim 竞态失败的 id 记下来，避免「可列出却不可领」的任务被反复重挑，
    // 把内层 while 变成不带退避的紧循环、满速打 gateway。每轮重新开始，不会永久屏蔽任务。
    const skipThisRound = new Set()
    while (!shuttingDown && inFlight.size < defaultConcurrency) {
      const candidates = await client.listClaimable()
      // 挑第一个「目标 cwd 未在飞」的任务；其余留到下一轮（保证同 worktree 串行）
      let picked = null
      let pickedCtx = null
      for (const candidate of candidates) {
        if (skipThisRound.has(candidate.id)) continue
        const ctx = resolveWorkContext(workerConfig, candidate)
        if (inFlight.has(ctx.cwd)) continue
        picked = candidate
        pickedCtx = ctx
        break
      }
      if (!picked) break

      let claimed = null
      try {
        claimed = await client.claimTask(picked.id)
      } catch (error) {
        console.error('[lark-worker] claim 失败：', error)
        break
      }
      if (!claimed) {
        skipThisRound.add(picked.id) // 被并发领走 / 状态已变，本轮不再重挑，下一轮重新 list
        continue
      }
      // 领取与 SIGTERM 的竞态：若在上面两次 await 期间收到 SIGTERM，gracefulShutdown 已快照过
      // inFlight（此时还没加入本任务），不会替它释放租约 → 任务卡 running 白等 40min 租约过期。
      // 故退出中刚领到的任务自行交还，再退出。
      if (shuttingDown) {
        await client
          .releaseTask(claimed.id)
          .catch((error) =>
            console.error(`[lark-worker] 退出期间交还刚领取的 ${claimed.id} 失败（回落到租约回收）：${String(error).slice(0, 120)}`),
          )
        return
      }

      const key = pickedCtx.cwd
      const running = runTask(claimed, pickedCtx, { signal: shutdownController.signal })
        .finally(() => inFlight.delete(key))
      inFlight.set(key, { promise: running, taskId: claimed.id })
    }

    if (shuttingDown) return
    await sleep(pollMs)
  }
}
