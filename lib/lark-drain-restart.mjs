/**
 * 排空重启（自愈环 3，aven 2026-10-16 拍板，docs/falive-self-healing.md §4）：
 * 磁盘上的代码 / 配置和进程加载的不一样时，worker 不再领新任务，在飞的跑完就 `lark-bot restart`。
 * 之前只会每分钟打一行「已落后磁盘」警告，改完代码一直用旧代码跑到有人手动重启（10-15 连打 8 条）。
 * 「马上重启」会把跑了一半的任务作废重来，「等完全空闲」可能等一晚上，排空是折中：通常几分钟。
 *
 * 重启前先跑一遍单测：红了不重启、只私信一句，继续用旧代码跑（坏代码上线比旧代码更糟）。
 * 决策是纯函数（planDrainRestart），副作用（跑测试 / 发起重启 / 私信）由 createDrainRestart 注入，便于单测。
 */

import { spawn, spawnSync } from 'node:child_process'
import { openSync } from 'node:fs'
import { join } from 'node:path'

import { larkBotRoot } from './lark-paths.mjs'

export const DEFAULT_SETTLE_MS = 60_000
// 发起重启后 launchd 应在几秒内 SIGTERM 本进程；超过这个时间还活着，说明 restart 没生效，允许再发一次。
export const RESTART_OVERDUE_MS = 3 * 60_000

const diskKeyOf = (version) => `${version?.diskCodeHash || ''}:${version?.diskConfigHash || ''}`

/**
 * 纯决策。state：{ draining, failedKey, restartRequestedAt }（由调用方持有并按返回的 patch 更新）。
 * 返回 { action, reason, patch }：
 *   none           无事（磁盘与进程一致，或功能关闭）
 *   cancel-drain   排空中磁盘又改回来了 → 取消排空
 *   start-drain    磁盘变了 → 进入排空（不再领新任务）
 *   wait-inflight  排空中，等在飞任务跑完
 *   wait-settle    排空中，磁盘刚改完不到 settleMs（人可能还在存盘）
 *   wait-restart   已发起重启，等 SIGTERM
 *   verify         该跑测试并重启了（调用方据结果再喂 markVerified）
 *   skip-failed    这版磁盘代码测试已红过，照旧跑旧代码，等下一次改动
 */
export const planDrainRestart = ({ version, inFlight = 0, now = Date.now(), state = {}, settleMs = DEFAULT_SETTLE_MS, enabled = true }) => {
  if (!enabled || !version) return { action: 'none', reason: enabled ? 'no version' : 'disabled' }
  const stale = Boolean(version.codeStale || version.configStale)
  if (!stale) {
    return state.draining
      ? { action: 'cancel-drain', reason: '磁盘又与进程一致', patch: { draining: false, restartRequestedAt: null } }
      : { action: 'none', reason: 'fresh' }
  }
  const diskKey = diskKeyOf(version)
  if (state.failedKey === diskKey) return { action: 'skip-failed', reason: '这版磁盘代码测试已红' }
  if (state.restartRequestedAt) {
    if (now - state.restartRequestedAt < RESTART_OVERDUE_MS) return { action: 'wait-restart', reason: '已发起重启' }
    return { action: 'verify', reason: 'restart 逾期未生效，重发', patch: { restartRequestedAt: null } }
  }
  if (!state.draining) return { action: 'start-drain', reason: version.codeStale ? '磁盘代码已更新' : '磁盘配置已更新', patch: { draining: true } }
  if (inFlight > 0) return { action: 'wait-inflight', reason: `还有 ${inFlight} 个在飞` }
  const changedAtMs = version.diskChangedAt ? Date.parse(version.diskChangedAt) : null
  if (Number.isFinite(changedAtMs) && now - changedAtMs < settleMs) return { action: 'wait-settle', reason: '磁盘刚改完，等稳定' }
  return { action: 'verify', reason: '0 在飞且磁盘已稳定' }
}

// 默认副作用：跑全量单测（7 秒级）；配置改了只校验 JSON 能解析。
export const runSelfTests = ({ root = larkBotRoot, timeoutMs = 5 * 60_000 } = {}) => {
  const res = spawnSync('node', ['--test', '__tests__/*.test.mjs'], { cwd: root, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 })
  const summary = (res.stdout || '').split('\n').filter((line) => /^ℹ (tests|pass|fail) /.test(line)).join(' ')
  const failing = (res.stdout || '').split('\n').filter((line) => /^✖ /.test(line)).slice(0, 5)
  return { ok: res.status === 0 && !res.error, summary: summary || (res.error ? String(res.error.message) : `exit ${res.status}`), failing }
}

// 默认重启：脱离本进程组起 `lark-bot restart`（脚本会 bootout worker → 本进程收 SIGTERM 优雅退出 → start）。
// 输出追加到 worker.log（LARK_LOG_FILE），没有就丢弃。
export const requestRestartViaScript = ({ root = larkBotRoot, logFile = process.env.LARK_LOG_FILE } = {}) => {
  let out = 'ignore'
  try {
    if (logFile) out = openSync(logFile, 'a')
  } catch {
    out = 'ignore'
  }
  const child = spawn('/bin/bash', [join(root, 'scripts', 'lark-bot'), 'restart'], { cwd: root, detached: true, stdio: ['ignore', out, out] })
  child.unref()
  return child.pid
}

/**
 * 有状态的驱动：每轮主循环调一次 tick({ inFlight })。
 * deps：version（createRuntimeVersion 的实例）、runTests、requestRestart、notify(text)、log、now。
 */
export const createDrainRestart = ({
  version,
  enabled = true,
  settleMs = DEFAULT_SETTLE_MS,
  runTests = runSelfTests,
  requestRestart = requestRestartViaScript,
  notify = async () => {},
  log = console.log,
  now = Date.now,
}) => {
  const state = { draining: false, failedKey: null, restartRequestedAt: null }
  const apply = (patch) => Object.assign(state, patch || {})

  const tick = async ({ inFlight = 0 } = {}) => {
    const snapshot = version.observe()
    const plan = planDrainRestart({ version: snapshot, inFlight, now: now(), state, settleMs, enabled })
    apply(plan.patch)
    switch (plan.action) {
      case 'start-drain':
        log(`[lark-worker] 排空重启：${plan.reason}（进程 ${snapshot.codeHash} → 磁盘 ${snapshot.diskCodeHash}），不再领新任务，在飞 ${inFlight} 个跑完即重启`)
        break
      case 'cancel-drain':
        log('[lark-worker] 排空重启：磁盘又与进程一致，取消排空')
        break
      case 'verify': {
        const diskKey = diskKeyOf(snapshot)
        const tests = snapshot.codeStale ? runTests() : { ok: true, summary: '仅配置改动，不跑测试', failing: [] }
        if (!tests.ok) {
          apply({ failedKey: diskKey, draining: false })
          const text = `⚠ lark-bot 磁盘代码改了但单测没过，没重启、还在跑旧代码（${snapshot.codeHash}）。${tests.summary}${tests.failing.length ? `\n${tests.failing.join('\n')}` : ''}\n修好再存盘会自动再试。`
          // 红的测试名也进 worker.log（以前只在私信里，排查时翻不到）。
          log(`[lark-worker] 排空重启：测试红，不重启。${tests.summary}${tests.failing.length ? `；红：${tests.failing.join(' / ')}` : ''}`)
          await notify(text).catch((error) => log(`[lark-worker] 排空重启：私信失败（忽略）：${String(error).slice(0, 120)}`))
          break
        }
        const pid = requestRestart()
        apply({ restartRequestedAt: now() })
        log(`[lark-worker] 排空重启：测试绿（${tests.summary}），已发起 lark-bot restart（pid ${pid ?? '?'}），等 SIGTERM`)
        break
      }
      default:
        break
    }
    return plan
  }

  return { tick, isDraining: () => state.draining, state }
}
