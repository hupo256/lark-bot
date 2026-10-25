/**
 * 排空重启（从 falive 移植，aven 2026-10-24；falive 原设计见其 docs/falive-self-healing.md §4）：
 * 磁盘上的代码 / 配置和进程加载的不一样时，worker 不再领新任务，在飞的跑完就 `lark-bot restart`。
 * 原来只会打一行「已落后磁盘」警告，改完代码一直用旧代码跑到有人手动重启。
 * 「马上重启」会把跑了一半的任务作废重来，「等完全空闲」可能等一晚上，排空是折中：通常几分钟。
 *
 * 重启前先自检：代码改了跑全量单测，配置改了做启动期同款校验；不过就不重启、只私信一次，继续用旧代码跑
 * （坏代码 / 坏配置上线比旧代码更糟：gateway 启动校验不过会直接起不来）。
 * 决策是纯函数（planDrainRestart），副作用（自检 / 发起重启 / 私信）由 createDrainRestart 注入，便于单测。
 */

import { spawn } from 'node:child_process'
import { openSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { loadConfig, validateConfig } from './lark-config.mjs'
import { larkBotRoot } from './lark-paths.mjs'

export const DEFAULT_SETTLE_MS = 60_000
// 发起重启后 launchd 应在几秒内 SIGTERM 本进程；超过这个时间还活着，说明 restart 没生效，允许再发一次。
export const RESTART_OVERDUE_MS = 3 * 60_000

const diskKeyOf = (version) => `${version?.diskCodeHash || ''}:${version?.diskConfigHash || ''}`

/**
 * 开关：配置 selfHeal.drainRestart=false 或环境 LARK_DRAIN_RESTART=0 关；
 * 只在 launchd 托管时开（plist 注入 LARK_LOG_FILE）：手工前台起的 worker 自己发起 restart 会和 launchd 双跑。
 */
export const drainRestartSwitch = ({ selfHeal = {}, env = process.env } = {}) => {
  if (selfHeal?.drainRestart === false || env.LARK_DRAIN_RESTART === '0') return { enabled: false, reason: '配置 / 环境关闭' }
  if (!env.LARK_LOG_FILE) return { enabled: false, reason: '非 launchd 托管' }
  return { enabled: true, reason: 'launchd 托管' }
}

/**
 * 纯决策。state：{ draining, failedKey, restartRequestedAt }（由调用方持有并按返回的 patch 更新）。
 * 返回 { action, reason, patch }：
 *   none           无事（磁盘与进程一致，或功能关闭）
 *   cancel-drain   排空中磁盘又改回来了 → 取消排空
 *   start-drain    磁盘变了 → 进入排空（不再领新任务）
 *   wait-inflight  排空中，等在飞任务跑完
 *   wait-settle    排空中，磁盘刚改完不到 settleMs（人可能还在存盘）
 *   wait-restart   已发起重启，等 SIGTERM
 *   verify         该自检并重启了（调用方据结果更新 state）
 *   skip-failed    这版磁盘自检已红过，照旧跑旧代码，等下一次改动
 */
export const planDrainRestart = ({ version, inFlight = 0, now = Date.now(), state = {}, settleMs = DEFAULT_SETTLE_MS, enabled = true }) => {
  if (!enabled || !version) return { action: 'none', reason: enabled ? 'no version' : 'disabled' }
  const stale = Boolean(version.codeStale || version.configStale)
  if (!stale) {
    return state.draining
      ? { action: 'cancel-drain', reason: '磁盘又与进程一致', patch: { draining: false, restartRequestedAt: null } }
      : { action: 'none', reason: 'fresh' }
  }
  if (state.failedKey === diskKeyOf(version)) return { action: 'skip-failed', reason: '这版磁盘自检已红' }
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

// 从 node --test 的 spec 输出里摘失败项：只看「✖ failing tests:」那一节（不要文件级 ✖ 和节标题）。
// 合并过的用例报错里每个失败段是一行「▶ 原用例标题 ◀ 说明」（falive 的 support/steps.mjs 格式，本仓暂无，
// 留着通用解析无害），摘出前几段的原标题；普通用例取报错第一行。没有那一节时退回所有 ✖ 行。
export const pickFailingTests = (stdout, { limit = 5, stepLimit = 3 } = {}) => {
  const lines = String(stdout || '').split('\n')
  const start = lines.findIndex((line) => /^✖ failing tests:/.test(line))
  if (start < 0) return lines.filter((line) => /^✖ /.test(line)).slice(0, limit)
  const out = []
  for (let i = start + 1; i < lines.length && out.length < limit; i += 1) {
    if (!/^✖ /.test(lines[i])) continue
    const steps = []
    let message = ''
    for (let j = i + 1; j < lines.length && !/^(✖ |test at )/.test(lines[j]); j += 1) {
      const step = lines[j].match(/^\s+▶ (.+?) ◀/)
      if (step) steps.push(step[1].trim().slice(0, 80))
      else if (!message && /^\s+\S/.test(lines[j]) && !/^\s+at /.test(lines[j])) message = lines[j].trim().slice(0, 120)
    }
    const detail = steps.length ? steps.slice(0, stepLimit).join(' / ') + (steps.length > stepLimit ? ` / 另 ${steps.length - stepLimit} 段` : '') : message
    out.push(detail ? `${lines[i].trim()} → ${detail}` : lines[i].trim())
  }
  return out
}

// bot 自己跑单测时的子进程环境：去掉全部 LARK_* 实例变量（launchd 注入的 LARK_LOG_FILE、gateway 密钥、
// claude.env 里可能写的 LARK_RUNTIME_DIR / 端口 / 超时……），测试结果不随跑在哪套实例里变；
// 也去掉 NODE_TEST_CONTEXT（本进程若跑在 node --test 下，子 node --test 会改走序列化通道、不出 spec 摘要）。
export const hermeticTestEnv = (env = process.env) =>
  Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('LARK_') && key !== 'NODE_TEST_CONTEXT'))

// 异步跑子进程（worker 主循环和心跳不能被同步调用卡住）。detached + 杀进程组：超时 / abort 时测试孙进程一起死。
// 排空自检与自修验收共用（lark-self-fix-run 从这里 re-export）。tail 只留最后 tailMax 字。
export const runCommand = ({ cmd = process.execPath, args = [], cwd, env = hermeticTestEnv(), timeoutMs = 0, signal = null, tailMax = 4000 }) =>
  new Promise((resolve) => {
    let tail = ''
    let timedOut = false
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    const keep = (chunk) => {
      tail = (tail + chunk).slice(-tailMax)
    }
    const kill = () => {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        // 已退出
      }
    }
    const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; kill() }, timeoutMs) : null
    signal?.addEventListener('abort', kill, { once: true })
    const done = (code, extra = '') => {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', kill)
      resolve({ ok: code === 0 && !timedOut, code, timedOut, tail: `${tail}${extra}` })
    }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    child.on('error', (error) => done(null, String(error?.message || error).slice(0, 160)))
    child.on('close', (code) => done(code))
  })

// 默认自检（代码）：跑全量单测（与 scripts/test-all.mjs 同一组文件，不卡运行时间预算：机器忙时变慢不该让 bot 起不来）。
// 异步子进程（原 spawnSync 卡住 worker 事件循环 8–11 秒、心跳不更新，10-24 沙箱试跑发现）。
export const runSelfTests = async ({ root = larkBotRoot, timeoutMs = 5 * 60_000 } = {}) => {
  const files = readdirSync(join(root, '__tests__')).filter((name) => name.endsWith('.test.mjs')).map((name) => `__tests__/${name}`)
  const run = await runCommand({ args: ['--test', '--test-reporter=spec', ...files], cwd: root, timeoutMs, tailMax: 256 * 1024 })
  const summary = run.tail.split('\n').filter((line) => /^ℹ (tests|pass|fail) /.test(line)).join(' ')
  const fallback = run.timedOut ? `超时（${timeoutMs}ms）` : `exit ${run.code}`
  return { ok: run.ok, summary: summary || fallback, failing: pickFailingTests(run.tail) }
}

// 默认自检（配置）：JSON 能解析 + 启动期同款结构校验（gateway / poller 启动时校验不过会直接拒绝启动）。
export const checkConfigFile = (configPath) => {
  let config
  try {
    config = loadConfig(configPath)
  } catch (error) {
    return { ok: false, summary: `配置读不了：${String(error?.message || error).slice(0, 160)}`, failing: [] }
  }
  const { errors } = validateConfig(config)
  if (errors.length) return { ok: false, summary: `配置校验 ${errors.length} 条不过`, failing: errors.slice(0, 5) }
  return { ok: true, summary: '配置校验通过', failing: [] }
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
  // LARK_BOT_ROOT 钉成本进程所在的仓：脚本缺省控制 ~/github/lark-bot，从别的目录跑的 worker 不能去重启生产那套。
  const child = spawn('/bin/bash', [join(root, 'scripts', 'lark-bot'), 'restart'], {
    cwd: root,
    env: { ...process.env, LARK_BOT_ROOT: root },
    detached: true,
    stdio: ['ignore', out, out],
  })
  child.unref()
  return child.pid
}

// 合并两路自检：代码改了跑单测，配置改了校验配置，两样都改了两样都做。
const selfCheck = async ({ snapshot, runTests, checkConfig, configPath }) => {
  const results = []
  if (snapshot.codeStale) results.push(await runTests())
  if (snapshot.configStale) results.push(checkConfig(configPath))
  return {
    ok: results.every((item) => item.ok),
    summary: results.map((item) => item.summary).join('；'),
    failing: results.flatMap((item) => item.failing || []),
  }
}

// 日志里「从哪版变到哪版」：改了什么打什么的哈希（只改配置时原来打的是代码哈希「a → a」，看不出变化）。
const staleHashes = (snapshot) =>
  [
    snapshot.codeStale && `代码 ${snapshot.codeHash} → ${snapshot.diskCodeHash}`,
    snapshot.configStale && `配置 ${snapshot.configHash} → ${snapshot.diskConfigHash}`,
  ].filter(Boolean).join('，')

/**
 * 有状态的驱动：每轮主循环调一次 tick({ inFlight })。
 * deps：version（createRuntimeVersion 的实例）、configPath、runTests、checkConfig、requestRestart、
 * notify(text, { idempotencyKey })、log、now。
 */
export const createDrainRestart = ({
  version,
  configPath,
  enabled = true,
  settleMs = DEFAULT_SETTLE_MS,
  runTests = runSelfTests,
  checkConfig = checkConfigFile,
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
        log(`[lark-worker] 排空重启：${plan.reason}（${staleHashes(snapshot)}），不再领新任务，在飞 ${inFlight} 个跑完即重启`)
        break
      case 'cancel-drain':
        log('[lark-worker] 排空重启：磁盘又与进程一致，取消排空')
        break
      case 'verify': {
        const diskKey = diskKeyOf(snapshot)
        const check = await selfCheck({ snapshot, runTests, checkConfig, configPath })
        if (!check.ok) {
          apply({ failedKey: diskKey, draining: false })
          const failingText = check.failing.length ? `\n${check.failing.join('\n')}` : ''
          // 红的项也进 worker.log：没配 notifyOpenId 时这是唯一出口，配了也方便排查时翻。
          log(`[lark-worker] 排空重启：自检红，不重启。${check.summary}${check.failing.length ? `；红：${check.failing.join(' / ')}` : ''}`)
          const text = `⚠ lark-bot 磁盘上的代码 / 配置改了但自检没过，没重启、还在跑旧代码（${snapshot.codeHash}）。${check.summary}${failingText}\n修好再存盘会自动再试。`
          await notify(text, { idempotencyKey: `drain-red-${diskKey}` }).catch((error) => log(`[lark-worker] 排空重启：私信失败（忽略）：${String(error).slice(0, 120)}`))
          break
        }
        const pid = requestRestart()
        apply({ restartRequestedAt: now() })
        log(`[lark-worker] 排空重启：自检绿（${check.summary}），已发起 lark-bot restart（pid ${pid ?? '?'}），等 SIGTERM`)
        break
      }
      default:
        break
    }
    return plan
  }

  return { tick, isDraining: () => state.draining, state }
}
