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
import { aiTimeoutMs, preflightAiExecutor, resolveAiExecutor, resolveAiModelConfig } from './lib/lark-ai-executor.mjs'
import { createGatewayClient, sleep } from './lib/lark-gateway-client.mjs'
import { loadWorkerLocalConfig } from './lib/lark-worker-run.mjs'
import { resolveWorkContext, safeProject } from './lib/lark-work-context.mjs'
import { createTaskRunner } from './lib/lark-task-runner.mjs'
import { startLogRotation } from './lib/lark-log-rotate.mjs'
import { createRuntimeVersion, versionWarnings, writeWorkerHeartbeat } from './lib/lark-runtime-version.mjs'
import { createDrainRestart, drainRestartSwitch } from './lib/lark-drain-restart.mjs'
import { startDoctorSchedule } from './lib/lark-doctor.mjs'
import { sendChatMessage } from './lib/lark-cli.mjs'
import { larkRuntimeDir } from './lib/lark-repo.mjs'
import { defaultTaskLeaseMs } from './lib/lark-constants.mjs'

function printHelp() {
  console.log(`usage: lark-worker.mjs [--once] [--preflight] [--help]

Lark Bot Gateway worker: claim pending tasks from the gateway and dispatch them to the configured AI executor.
Normally invoked by the per-project wrapper; this module also exports runLarkWorker().

Options:
  --help       Show this help message and exit
  --preflight  Validate the configured executor/model and exit
  --once       Process one task then exit instead of polling forever`)
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
  aiExecutor = defaultAiExecutor,
  configPath,
}) {
  const localConfig = loadWorkerLocalConfig(configPath)
  // 版本快照要在装配前拍（= 本进程真正加载的源码版本）。worker 无 HTTP 端口，故靠心跳文件让
  // gateway 的 /lark/health 代为上报——「gateway 重启了但 worker 还是旧的」是最容易漏的半重启态。
  const runtimeVersion = createRuntimeVersion({ configPath })
  // worker 是多项目的：真正干活的 projectId/projectName/projectDocs/cwd 由 resolveWorkContext 按
  // 每条 task.project 推导（见 lib/lark-work-context.mjs）。这里的项目身份只作软默认——从 config
  // 派生，用于 adhoc 任务的审计归桶兜底（lib/lark-worker-audit.mjs），不写死在 wrapper 里。
  projectId = projectId || safeProject(localConfig.project)
  projectName = projectName || localConfig.title || projectId || '(adhoc)'

  // 焊死「孤儿回收不与活着的 AI 双跑」这条唯一防线：AI 执行超时必须 < gateway 租约。
  // 否则 AI 还在跑，gateway 已判租约过期把任务重投/领走，两个 AI 同 worktree 改文件打架。
  // 默认 30min < 40min 成立；env 覆盖（LARK_WORKER_AI_TIMEOUT_MS / LARK_TASK_LEASE_MS）可能破坏，故启动即断言。
  const leaseMs = defaultTaskLeaseMs
  if (Number.isFinite(aiTimeoutMs) && aiTimeoutMs > 0 && aiTimeoutMs >= leaseMs) {
    throw new Error(
      `[lark-worker] 配置冲突：AI 超时(${aiTimeoutMs}ms) 必须小于任务租约 LARK_TASK_LEASE_MS(${leaseMs}ms)，` +
        '否则孤儿回收会与活着的 AI 双跑同一 worktree。请调低 LARK_WORKER_AI_TIMEOUT_MS 或调高 LARK_TASK_LEASE_MS。',
    )
  }

  const workerConfig = { projectId, projectName, aiExecutor, localConfig }
  const startupExecutor = resolveAiExecutor(workerConfig, {})
  const startupModelCfg = resolveAiModelConfig(localConfig, startupExecutor)
  const executorProfile = startupModelCfg?.model
    ? ` model=${startupModelCfg.model}${startupModelCfg.reasoningEffort ? ` reasoning=${startupModelCfg.reasoningEffort}` : ''}`
    : ''
  const readiness = preflightAiExecutor(startupExecutor, {
    localConfig,
    // 所选执行器为 Codex/Pi/Claude 时，Worker 在写首个 heartbeat 前真实探测模型；restart 只有看到该 heartbeat 才成功。
    probeModel: ['codex', 'pi', 'claude'].includes(startupExecutor),
  })
  console.log(`[lark-worker] AI executor=${startupExecutor}${executorProfile} readiness=${readiness.modelProbe}（task > config > wrapper > default）`)
  console.log(`[lark-worker] code=${runtimeVersion.codeHash} startedAt=${runtimeVersion.startedAt}`)

  if (argv.includes('--preflight')) {
    console.log(JSON.stringify(readiness))
    return
  }

  const heartbeat = (extra) => writeWorkerHeartbeat({ runtimeDir: larkRuntimeDir, version: runtimeVersion, extra: { readiness, ...extra } })
  heartbeat({ inFlight: 0 })

  const client = createGatewayClient(gatewayUrl)
  const runTask = createTaskRunner({ client, workerConfig })

  if (argv.includes('--once')) {
    const task = await client.getNextPendingTask()
    if (task) await runTask(task, resolveWorkContext(workerConfig, task))
    return
  }

  // 日志轮转：worker.log 里带 AI 完整 transcript，实测一天就能到 10MB，且进程连跑数周不重启。
  // 放在 --once 之后：一次性执行不需要定时器。只有 plist 注入了 LARK_LOG_FILE 才真的截断。
  const logTimer = startLogRotation()

  // 排空重启（从 falive 移植）：磁盘代码 / 配置变了 → 不再领新任务 → 在飞跑完、磁盘稳定、自检绿 → lark-bot restart。
  // 自检红：不重启、私信 notifyOpenId 一次（没配只写日志），同一版磁盘不再重跑。开关见 drainRestartSwitch。
  const selfHeal = localConfig.selfHeal || {}
  const drainSwitch = drainRestartSwitch({ selfHeal })
  const notifyOpenId = typeof localConfig.notifyOpenId === 'string' && localConfig.notifyOpenId.startsWith('ou_') ? localConfig.notifyOpenId : null
  const drain = createDrainRestart({
    version: runtimeVersion,
    configPath,
    enabled: drainSwitch.enabled,
    settleMs: Number(selfHeal.settleMs) > 0 ? Number(selfHeal.settleMs) : undefined,
    notify: notifyOpenId
      ? (text, { idempotencyKey } = {}) => sendChatMessage({ chatId: notifyOpenId, text, idempotencyKey, logPrefix: 'drain-restart' })
      : async () => {},
  })
  console.log(`[lark-worker] 排空重启：${drainSwitch.enabled ? `开（磁盘改动 → 排空 → 自检绿 → 自动 restart；自检红${notifyOpenId ? '私信 notifyOpenId' : '只写日志：未配 notifyOpenId'}）` : `关（${drainSwitch.reason}）`}`)

  // 运行态体检（自愈环 3，从 falive 移植）：启动 3 分钟后一次、之后每小时；warn / bad 私信 notifyOpenId（没配只写日志），
  // 同一条 24h 只报一次。开关 selfHeal.doctor=false / LARK_DOCTOR=0（只关定时，`lark-bot doctor` 照常可用）。
  startDoctorSchedule({ selfHeal, notifyOpenId, send: sendChatMessage, gatewayUrl, listTasks: () => client.listTasks() })

  // 优雅退出：SIGTERM/SIGINT（launchd bootout 与 lark-bot stop 都发 SIGTERM）时，先把在飞任务
  // 交还队列（releaseTask → queued + epoch++），再中断在跑的 AI 子进程，让重启后的 worker 立刻重领，
  // 而非空等 40min 租约过期。必须「先释放再 abort」：被中断执行随后那条 failed 迟到回写会因 epoch
  // 不匹配被 gateway 409 挡掉，任务干净停在 queued。中断 AI 子进程是必须的——Node 退出不杀子进程，
  // 不杀会与重领后的新 AI 双跑同一 worktree。
  const shutdownController = new AbortController()
  const inFlight = new Map() // cwd -> { promise, taskId }
  let shuttingDown = false

  // 版本心跳 + 自检告警：每分钟落一次盘（供 gateway health 汇总），同时把落后状态打进 worker.log。
  // 这里只告警不自杀——正在跑的长任务比"跑最新代码"更值得保住；重启时机由上面的排空重启（或人）决定。
  let lastVersionWarning = ''
  const heartbeatTimer = setInterval(() => {
    heartbeat({ inFlight: inFlight.size, draining: drain.isDraining() })
    // 版本落后只在内容变化时打一行（原每分钟一行，worker.log 里一天几千行同样的话）。
    const warningText = versionWarnings(runtimeVersion.observe()).join('\n')
    if (warningText && warningText !== lastVersionWarning) console.warn(`[lark-worker] ⚠ ${warningText}`)
    lastVersionWarning = warningText
  }, 60_000)
  heartbeatTimer.unref?.()
  const gracefulShutdown = async (signal) => {
    if (shuttingDown) return
    shuttingDown = true
    if (logTimer) clearInterval(logTimer)
    clearInterval(heartbeatTimer)
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
  // 任何漏网的 rejection 只记日志不退出：进程退出 = 在飞任务全部成孤儿、要等租约回收。
  process.on('unhandledRejection', (reason) => console.error(`[lark-worker] unhandledRejection（忽略，不退出）：${String(reason?.stack || reason).slice(0, 400)}`))
  process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'))
  process.on('SIGINT', () => void gracefulShutdown('SIGINT'))

  // 并行调度器：inFlight 以 workContext.cwd 为 key（同一 worktree 只允许一个在飞、天然串行；
  // 不同 worktree 并行）。git worktree add/remove 等走 spawnSync 同步执行，本就互不交错，无需额外锁。
  let lastDraining = false
  for (;;) {
    // 本轮跳过集：claim 竞态失败的 id 记下来，避免「可列出却不可领」的任务被反复重挑，
    // 把内层 while 变成不带退避的紧循环、满速打 gateway。每轮重新开始，不会永久屏蔽任务。
    const skipThisRound = new Set()
    // 排空重启每轮先判：排空中不领新任务（在飞的照常跑完）。
    await drain.tick({ inFlight: inFlight.size }).catch((error) => console.error('[lark-worker] 排空重启 tick 异常（忽略）：', error))
    // 排空状态一变就补写心跳，health / `lark-bot status` 不用等下一分钟才看到「排空中」。
    if (drain.isDraining() !== lastDraining) heartbeat({ inFlight: inFlight.size, draining: drain.isDraining() })
    lastDraining = drain.isDraining()
    while (!shuttingDown && !drain.isDraining() && inFlight.size < defaultConcurrency) {
      // gateway 重启 / 抖动时不裸崩：listClaimable 的 reliableRequest 只重试 3×150ms，超过就抛；
      // 原来这里没 try，一次 ECONNREFUSED 就让整个 worker 进程退出、在飞任务成孤儿。
      let candidates
      try {
        candidates = await client.listClaimable()
      } catch (error) {
        console.warn(`[lark-worker] 拉取可领取任务失败（${String(error?.cause?.code || error?.message || error).slice(0, 120)}），${Math.round(pollMs / 1000)}s 后再试`)
        break
      }
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
        .catch((error) => console.error(`[lark-worker] ${claimed.id} runTask 未捕获异常（任务交给租约回收）：${String(error?.stack || error).slice(0, 400)}`))
        .finally(() => inFlight.delete(key))
      inFlight.set(key, { promise: running, taskId: claimed.id })
    }

    if (shuttingDown) return
    await sleep(pollMs)
  }
}
