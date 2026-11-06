/**
 * 审批邮件转群引擎（aven 11-02「转发邮件并评分如果好用，后面可能单独成应用，现在预留好接口，到时一键拆分」）。
 *
 * 一个常驻 `mail +watch`（邮箱主人的 user 身份，收信通知事件）→ 新邮件进 INBOX → 按 config.mailRelay.routes 找第一条命中的路由
 * → forwardMail（分享卡片 + bot 回评分 / 类别）。路由与预设见 lark-mail-relay-routes / lark-mail-relay-presets。
 *
 * 拆分接口（同一份代码，两种跑法）：
 *   · 现在：网关里 startMailRelay({ relay: config.mailRelay })，和 bot 共用一个应用、一份 lark-cli 凭证；
 *   · 拆成独立应用：scripts/lark-mail-relay.mjs --config <json> 单独起进程；mailRelay.cliConfigDir 指向新应用的 lark-cli 凭证目录
 *     （所有 lark-cli 调用带 LARKSUITE_CLI_CONFIG_DIR，邮箱读写 / 分享 / bot 回复都换成新应用），stateFile 指向它自己的台账；
 *     网关这边把 mailRelay.enabled 关掉即可。引擎只依赖 lark-cli 调用器、台账 io、长连接启动器三个可注入件，不碰网关的任务 / 群消息链路。
 *
 * 收信方式（mailRelay.mode）：
 *   · poll（默认，11-02 起）：每 pollMs（默认 2 分钟）用 `mail +triage` 拉一次 INBOX，转「上次拉成功」往前再多看 15 分钟之后到达的（发信时间
 *     可能早于到达时间，重叠部分靠台账去重）；只在拉成功后推进时钟，拉失败下一轮接着补。不开 WebSocket。
 *   · watch：常驻 `mail +watch`。**和 bot 同一个应用时不要用**：+watch 另开一条 WebSocket，飞书在同一应用的两条连接间分流事件，
 *     落到它这条的 im 消息事件（私信 / @bot）会被丢掉、靠飞书重投（11-02 实测 4 小时丢 6 条，一条私信晚了 5 分钟）。拆成独立应用后才用。
 *     watch 模式照样每 pollMs 拉一次收件箱兜底（11-06）：实时转发靠事件，漏掉的事件靠拉取补，两路共用 handler + 台账去重。
 *   首次启用（台账没有时钟）只落时钟、不回填历史。
 * 拉取失败告警（11-05 aven「连续拉取失败 5 次时私信一次」）：连续 alert.afterFailures（默认 5）轮读收件箱失败，私信 alert.openId
 *   （缺省用调用方给的 notifyOpenId：网关传 config.notifyOpenId）一次，带最近一次的真实错误；之后恢复再报一次。发信用本引擎的 lark-cli
 *   调用器（bot 身份），拆成独立应用时跟着换成新应用的 bot。没有收件人就只打日志。
 * 包边界（11-05 P1 拆分）：本目录不 import lark-bot 的任何模块；路径一律按调用方给的 baseDir 解析（独立运行 = 配置文件所在目录）。
 *   lark-bot 内置时经 lib/lark-mail-relay.mjs 薄转发，注入它自己的 runLarkCli / 长连接 / 台账路径（runtime/lark-mail-relay-state.json）。
 * 影子模式（mailRelay.shadow=true，11-05 P3 切换前在新机器上跑 1 个工作日）：照常读信、判路由、评分、记台账（记录带 dryRun: true），
 *   但不分享卡片、不回评分；之后用 `bin/mail-relay.mjs compare` 和线上台账逐封对。
 * 台账（独立运行缺省 <baseDir>/mail-relay-state.json，stateFile 可改）：{ checkedAt, forwarded: { [message_id]: { at, route, ok, step?, score?, tier? } } }，留最近 500 条。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { startConsumer } from './consumer.mjs'
import { forwardMail } from './forward.mjs'
import { larkCallFailed, runLarkCli, sendMarkdown } from './lark.mjs'
import { matchRoute, normalizeRoutes } from './routes.mjs'

export const MAIL_RELAY_STANDALONE_STATE_FILE = 'mail-relay-state.json'
const KEEP_RECORDS = 500
export const RELAY_POLL_MS = 2 * 60_000
export const RELAY_POLL_MIN_MS = 30_000
export const RELAY_POLL_OVERLAP_MS = 15 * 60_000
export const RELAY_ALERT_AFTER_FAILURES = 5
// 邮箱主人要授权的用户权限（读信 + 监听 + 以用户身份把卡片发进群 + 续期；11-05 新应用「审批邮件助手」按这份申请）。授权过期告警里的重新授权命令用它。
export const RELAY_USER_SCOPES = [
  'mail:user_mailbox:readonly',
  'mail:user_mailbox.message:readonly',
  'mail:user_mailbox.message.subject:read',
  'mail:user_mailbox.message.body:read',
  'mail:user_mailbox.message.address:read',
  'mail:event',
  'mail:user_mailbox.event.mail_address:read',
  // +share-to-chat 用邮箱主人的身份把邮件卡片发进群（11-06 Mac mini 首次真发报 missing_scope 才发现；老 bot 应用早有这两个，一直没暴露）
  'im:message',
  'im:message.send_as_user',
  'offline_access',
]
const CATCHUP_MAX = 100

// 台账读写（可注入）。path 为空不落盘（单测）；读坏了当空台账；写先写 .tmp 再改名；写失败只打日志。
export const fileRelayIo = (path) => ({
  read: () => {
    try {
      const state = JSON.parse(readFileSync(path, 'utf8'))
      return { checkedAt: state.checkedAt || null, forwarded: state.forwarded && typeof state.forwarded === 'object' ? state.forwarded : {} }
    } catch {
      return { checkedAt: null, forwarded: {} }
    }
  },
  write: (state) => {
    if (!path) return
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(`${path}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 })
      renameSync(`${path}.tmp`, path)
    } catch (error) {
      console.error('[lark-mail-relay] 台账写入失败:', error.message)
    }
  },
})

// lark-cli 调用器 + 长连接子进程的环境变量：cliConfigDir 有值就都带 LARKSUITE_CLI_CONFIG_DIR（拆成独立应用时换凭证），否则原样。
// 相对路径按 baseDir 解析（独立运行 = 配置文件所在目录；lark-bot 内置 = 仓库根）。
export const createRelayCli = ({ cliConfigDir, run = runLarkCli, baseDir = process.cwd() } = {}) => {
  if (!cliConfigDir) return { run, env: null }
  const env = { LARKSUITE_CLI_CONFIG_DIR: resolve(baseDir, cliConfigDir) }
  return { env, run: (args, options = {}) => run(args, { ...options, env: { ...(options.env || {}), ...env } }) }
}

const trimRecords = (forwarded) =>
  Object.fromEntries(Object.entries(forwarded).sort((a, b) => String(b[1]?.at).localeCompare(String(a[1]?.at))).slice(0, KEEP_RECORDS))

// +watch --format data 的一行：{ message: {...} }；--format json 是 { ok, data: { message } }。都认。
export const mailFromWatchLine = (raw) => raw?.message || raw?.data?.message || null

// 事件 / 补转里的一封邮件：INBOX（缺字段当 INBOX）、没转过、命中某条路由（部分字段先放行）→ 返回路由，否则 null。
export const pickRoute = ({ routes, mail, forwarded }) => {
  if (!mail?.message_id || forwarded[mail.message_id]) return null
  if (mail.folder_id != null && mail.folder_id !== 'INBOX') return null
  return matchRoute(routes, mail, { partial: true })
}

export const createRelayHandler = ({ routes, io = fileRelayIo(), forward = forwardMail, run = runLarkCli, now = () => new Date().toISOString(), dryRun = false }) => {
  let chain = Promise.resolve()
  // 串行：同一封邮件事件重投 / 补转与实时撞车时不会转两遍（先查台账再转、转完立刻记）。
  const handle = (mail) => {
    chain = chain.then(async () => {
      const route = pickRoute({ routes, mail, forwarded: io.read().forwarded })
      if (!route) return null
      let outcome
      try {
        outcome = await forward({ messageId: mail.message_id, route, run, ...(dryRun ? { dryRun: true } : {}) })
      } catch (error) {
        outcome = { ok: false, step: 'exception', reason: error.message }
      }
      // 读信 / 分享失败多半是瞬时（限流、网络）：不记台账，重投或重启补转还能再来；判定不符合路由 / 评分发送失败也记，免得反复读。
      if (!outcome.ok && outcome.step !== 'filter' && outcome.step !== 'score') {
        console.error(`[lark-mail-relay] ${route.id} ${mail.message_id} 转发失败（${outcome.step}）：${outcome.reason}`)
        return outcome
      }
      const fresh = io.read()
      fresh.forwarded[mail.message_id] = {
        at: now(),
        route: route.id,
        ok: outcome.ok,
        ...(outcome.step ? { step: outcome.step } : {}),
        ...(outcome.result ? { score: outcome.result.score, tier: outcome.result.tier } : {}),
        ...(outcome.dryRun ? { dryRun: true } : {}),
      }
      fresh.forwarded = trimRecords(fresh.forwarded)
      io.write(fresh)
      const verb = outcome.dryRun ? '影子·本该转' : '已转'
      const done = outcome.result ? `${verb} ${outcome.result.score}/${outcome.result.max}（${outcome.result.tier}）` : verb
      console.log(`[lark-mail-relay] ${route.id} ${mail.message_id} ${outcome.ok ? `${done}${outcome.scoreVia ? ` ${outcome.scoreVia}` : ''}` : `跳过（${outcome.step}）`}：${mail.subject}`)
      return outcome
    })
    return chain
  }
  return { handle }
}

// 拉一次 INBOX（poll 模式每轮 / watch 模式启动时补转）：转「上次拉成功」往前 overlapMs 之后到达、还没转过、命中路由的（台账去重）。
// 首次启用（无 checkedAt）只落时钟不回填；只在读成功后把时钟推到本轮开始时刻，读失败不推（下一轮接着补）。
// 读收件箱失败的真实原因（11-05：一天 15 次失败，日志里只看得到 lark-cli 每次都打在 stderr 的「tip: … confirm your email identity」——
// 原来取 stderr || stdout，stderr 永远不空，stdout 里的 JSON error 一次没记下来）。结构化 error 优先，stderr 去掉 tip 行，带上退出码。
const TIP_LINE = /^\s*tip:/i
export const relayFailureText = (result = {}) => {
  const stdout = String(result.stdout || '').trim()
  // 去掉 tip 行后的 stderr；lark-cli 有时把结构化错误 JSON 打在 stderr 里（11-06 Mac mini 限流那次），也要能解析。
  const stderr = String(result.stderr || '').split('\n').filter((line) => line.trim() && !TIP_LINE.test(line)).join('\n').trim()
  const structured = (text) => {
    try {
      const error = JSON.parse(text)?.error
      if (!error || !(error.type || error.message)) return null
      return [[error.type, error.subtype].filter(Boolean).join('/'), error.code != null ? `code ${error.code}` : null, String(error.message || '').replace(/\s+/g, ' ').trim()]
        .filter(Boolean)
        .join(' ')
    } catch {
      return null
    }
  }
  const fromStdout = structured(stdout)
  const fromStderr = fromStdout ? null : structured(stderr)
  const detail = fromStdout || fromStderr || (stdout ? stdout.replace(/\s+/g, ' ') : null)
  const rest = fromStderr ? null : stderr.split('\n').map((line) => line.trim()).join(' | ') || null
  const parts = [result.code ? `退出码 ${result.code}` : null, detail, rest].filter(Boolean)
  return (parts.length ? parts.join('；') : '没有输出').slice(0, 400)
}

export const catchUpRelay = async ({ handler, io = fileRelayIo(), run = runLarkCli, now = () => new Date().toISOString(), overlapMs = 0, label = '启动补转' }) => {
  const state = io.read()
  const since = state.checkedAt
  const startedAt = now()
  if (!since) {
    io.write({ ...state, checkedAt: startedAt })
    return { skipped: 'first-run' }
  }
  const result = await run(['mail', '+triage', '--filter', JSON.stringify({ folder: 'INBOX' }), '--max', String(CATCHUP_MAX), '--format', 'json'], { identity: 'user' })
  if (larkCallFailed(result)) {
    const error = relayFailureText(result)
    console.error(`[lark-mail-relay] ${label}读收件箱失败: ${error}`)
    return { failed: true, error }
  }
  let messages = []
  try {
    messages = JSON.parse(result.stdout).messages || []
  } catch {
    const error = `返回不是 JSON：${relayFailureText({ stdout: result.stdout })}`
    console.error(`[lark-mail-relay] ${label}读收件箱失败: ${error}`)
    return { failed: true, error }
  }
  const floor = Date.parse(since) - overlapMs
  const missed = messages.filter((mail) => mail.date && Date.parse(mail.date) > floor).reverse()
  for (const mail of missed) await handler.handle({ ...mail, folder_id: 'INBOX' })
  io.write({ ...io.read(), checkedAt: startedAt })
  return { checked: missed.length }
}

// poll 间隔：mailRelay.pollMs，缺省 2 分钟，最少 30 秒（别把邮箱接口打满）。
export const relayPollMs = (relay) => {
  const value = Number(relay?.pollMs)
  return Number.isFinite(value) && value > 0 ? Math.max(RELAY_POLL_MIN_MS, value) : RELAY_POLL_MS
}

// 告警设置：收件人 alert.openId 优先、否则调用方给的 notifyOpenId；阈值 alert.afterFailures，缺省 5。
export const relayAlertSettings = (relay, notifyOpenId = null) => ({
  openId: relay?.alert?.openId || notifyOpenId || null,
  afterFailures: Number.isInteger(relay?.alert?.afterFailures) && relay.alert.afterFailures > 0 ? relay.alert.afterFailures : RELAY_ALERT_AFTER_FAILURES,
})

const hhmm = (iso) => new Date(iso).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })

// 连续失败计数 + 告警（纯状态机，可单测）：observe(outcome) 每轮调一次，返回这轮要发的话（没有就 null）。
// 满阈值那一轮发一次「拉不到了」；告过警之后第一次成功发「恢复了」；没告过警的恢复不说话。
// 授权类错误（user token 过期 / 撤销 / 需要重新登录）：告警里附重新授权命令（reloginHint），别的错误不附。
const AUTH_ERROR_RE = /authenticat|authoriz|token (?:expired|invalid)|access[_ ]token|re-?login|auth login|99991663|99991668|99991677|99991679/i
export const isRelayAuthError = (error) => AUTH_ERROR_RE.test(String(error || ''))

export const createFailureAlarm = ({ afterFailures = RELAY_ALERT_AFTER_FAILURES, reloginHint = null, prefix = '' } = {}) => {
  let streak = { count: 0, since: null, alerted: false }
  return {
    observe: ({ at, failed, error }) => {
      if (failed) {
        streak = { ...streak, count: streak.count + 1, since: streak.since || at }
        if (streak.alerted || streak.count < afterFailures) return null
        streak.alerted = true
        const relogin = reloginHint && isRelayAuthError(error) ? `\n像是邮箱授权过期了，在跑转发的那台机器上重新授权：\n${reloginHint}` : ''
        return `${prefix}审批邮件转发：连续 ${streak.count} 次读收件箱失败（${hhmm(streak.since)} 起），新邮件暂时转不进群；恢复后会自动补转这段时间的。\n最近一次错误：${error || '未知'}${relogin}`
      }
      const was = streak
      streak = { count: 0, since: null, alerted: false }
      if (!was.alerted) return null
      return `${prefix}审批邮件转发恢复了：${hhmm(was.since)} 起连续失败 ${was.count} 次，这段时间的邮件会自动补转。`
    },
    state: () => ({ ...streak }),
  }
}

// 入口（网关 / 独立进程共用）：relay = config.mailRelay。没开或没有启用的路由就什么都不起。
// baseDir：stateFile / cliConfigDir 的相对路径按它解析；io / cli 给了就用给的（lark-bot 内置注入）。
export const startMailRelay = ({ relay, io, cli, baseDir = process.cwd(), notifyOpenId = null, notify, consume = startConsumer, catchUp = catchUpRelay, schedule = setInterval }) => {
  const routes = relay?.enabled ? normalizeRoutes(relay) : []
  if (routes.length === 0) return { stop: () => {}, observe: () => null }
  const ledger = io || fileRelayIo(resolve(baseDir, relay.stateFile || MAIL_RELAY_STANDALONE_STATE_FILE))
  const { run, env } = cli || createRelayCli({ cliConfigDir: relay.cliConfigDir, baseDir })
  const shadow = relay.shadow === true
  const handler = createRelayHandler({ routes, io: ledger, run, dryRun: shadow })
  const reloginHint = `${env?.LARKSUITE_CLI_CONFIG_DIR ? `LARKSUITE_CLI_CONFIG_DIR=${env.LARKSUITE_CLI_CONFIG_DIR} ` : ''}lark-cli auth login --scope "${RELAY_USER_SCOPES.join(' ')}"`
  const routeText = `${routes.map((route) => `${route.id}（${route.label}）→ ${route.chatId}`).join('；')}${shadow ? '（影子模式：只记台账、不往群里发）' : ''}`
  // 定时拉取：poll 模式是唯一的收信路；watch 模式是兜底（11-06：原来 watch 只在启动时补拉一次、每 10 分钟把时钟直接推到现在，
  // 长连接漏掉的事件既没实时转、重启也补不回来）。上一轮没跑完就跳过本轮，不叠加；读成功才推时钟；连续失败告警两种模式都有。
  const watch = relay.mode === 'watch'
  const pollMs = relayPollMs(relay)
  const alertSettings = relayAlertSettings(relay, notifyOpenId)
  const alarm = createFailureAlarm({ ...alertSettings, reloginHint, prefix: shadow ? '[影子] ' : '' })
  const send =
    notify ||
    (async (text) => {
      if (!alertSettings.openId) return console.warn(`[lark-mail-relay] 没有告警收件人（mailRelay.alert.openId / notifyOpenId），只记日志：${text}`)
      const sent = await sendMarkdown({ chatId: alertSettings.openId, markdown: text, logPrefix: 'mail-relay alert', logTag: '[lark-mail-relay]', run })
      if (!sent.ok) console.error(`[lark-mail-relay] 告警私信没发出去：${sent.reason || '未知'}`)
    })
  let running = false
  let last = null
  const tick = async () => {
    if (running) return
    running = true
    try {
      last = { at: new Date().toISOString(), ...(await catchUp({ handler, io: ledger, run, overlapMs: RELAY_POLL_OVERLAP_MS, label: watch ? '兜底拉取' : '定时拉取' })) }
    } catch (error) {
      last = { at: new Date().toISOString(), failed: true, error: error.message }
      console.error('[lark-mail-relay] 定时拉取失败:', error.message)
    }
    try {
      const text = alarm.observe(last)
      if (text) await send(text)
    } catch (error) {
      console.error('[lark-mail-relay] 告警发送异常:', error.message)
    } finally {
      running = false
    }
  }
  // watch：常驻 user 身份 +watch，新邮件事件一到就进 handler（和兜底拉取共用 handler：串行 + 台账去重，同一封不会转两遍）。
  const consumer = watch
    ? consume({
        eventKey: 'mail.user_mailbox.event.message_received_v1',
        command: ['--as', 'user', 'mail', '+watch', '--msg-format', 'metadata', '--format', 'data'],
        env,
        maxRestarts: 8,
        onLine: (raw) => {
          const mail = mailFromWatchLine(raw)
          return mail ? handler.handle(mail) : null
        },
        onDownAlert: () => {},
      })
    : null
  tick()
  const pollTimer = schedule(tick, pollMs)
  pollTimer?.unref?.()
  const how = watch ? `实时监听 +watch，另每 ${Math.round(pollMs / 1000)} 秒拉一次收件箱兜底` : `每 ${Math.round(pollMs / 1000)} 秒拉一次收件箱`
  console.log(`[lark-mail-relay] 已启用 ${routes.length} 条路由（${how}）：${routeText}`)
  return {
    routes,
    mode: watch ? 'watch' : 'poll',
    observe: () => ({ mode: watch ? 'watch' : 'poll', pollMs, last, failures: alarm.state(), ...(consumer ? { watch: consumer.observe?.() || null } : {}) }),
    stop: () => {
      clearInterval(pollTimer)
      consumer?.stop()
    },
  }
}
