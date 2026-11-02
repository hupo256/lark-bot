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
 * 已知代价（docs/mail-ol-scoring-2026-11-02.md §6）：和 bot 同一应用时 +watch 另开一条 WebSocket，飞书会把部分 im 事件分给它、失败后重投网关，
 * 群消息偶尔晚几秒；拆成独立应用就没有这个问题。
 * 不轮询：停机期间的邮件事件飞书不补推，启动时只做一次 +triage 补转「上次在线」之后到达的；首次启用不回填历史。
 * 台账（默认 runtime/lark-mail-relay-state.json）：{ checkedAt, forwarded: { [message_id]: { at, route, ok, step?, score?, tier? } } }，留最近 500 条。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { larkCallFailed, runLarkCli } from './lark-cli.mjs'
import { startConsumer } from './lark-consumer.mjs'
import { forwardMail } from './lark-mail-relay-forward.mjs'
import { matchRoute, normalizeRoutes } from './lark-mail-relay-routes.mjs'
import { larkRuntimeDir, resolveFromLarkBotRoot } from './lark-paths.mjs'

export const MAIL_RELAY_STATE_FILE = 'lark-mail-relay-state.json'
const KEEP_RECORDS = 500
const CHECKPOINT_EVERY_MS = 10 * 60_000
const CATCHUP_MAX = 100

const defaultPath = () => (process.env.NODE_TEST_CONTEXT && !process.env.LARK_RUNTIME_DIR ? null : join(larkRuntimeDir, MAIL_RELAY_STATE_FILE))

// 台账读写（可注入）。读坏了当空台账；写先写 .tmp 再改名；写失败只打日志。
export const fileRelayIo = (path = defaultPath()) => ({
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
export const createRelayCli = ({ cliConfigDir, run = runLarkCli } = {}) => {
  if (!cliConfigDir) return { run, env: null }
  const env = { LARKSUITE_CLI_CONFIG_DIR: resolveFromLarkBotRoot(cliConfigDir) }
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

export const createRelayHandler = ({ routes, io = fileRelayIo(), forward = forwardMail, run = runLarkCli, now = () => new Date().toISOString() }) => {
  let chain = Promise.resolve()
  // 串行：同一封邮件事件重投 / 补转与实时撞车时不会转两遍（先查台账再转、转完立刻记）。
  const handle = (mail) => {
    chain = chain.then(async () => {
      const route = pickRoute({ routes, mail, forwarded: io.read().forwarded })
      if (!route) return null
      let outcome
      try {
        outcome = await forward({ messageId: mail.message_id, route, run })
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
      }
      fresh.forwarded = trimRecords(fresh.forwarded)
      io.write(fresh)
      const done = outcome.result ? `已转 ${outcome.result.score}/${outcome.result.max}（${outcome.result.tier}）` : '已转'
      console.log(`[lark-mail-relay] ${route.id} ${mail.message_id} ${outcome.ok ? `${done} ${outcome.scoreVia}` : `跳过（${outcome.step}）`}：${mail.subject}`)
      return outcome
    })
    return chain
  }
  return { handle }
}

// 启动补转：只查一次 INBOX 最近邮件，转「上次在线」之后到达、还没转过、命中路由的。首次启用（无 checkedAt）只落时钟不回填。
export const catchUpRelay = async ({ handler, io = fileRelayIo(), run = runLarkCli, now = () => new Date().toISOString() }) => {
  const state = io.read()
  const since = state.checkedAt
  io.write({ ...state, checkedAt: now() })
  if (!since) return { skipped: 'first-run' }
  const result = await run(['mail', '+triage', '--filter', JSON.stringify({ folder: 'INBOX' }), '--max', String(CATCHUP_MAX), '--format', 'json'], { identity: 'user' })
  if (larkCallFailed(result)) {
    console.error('[lark-mail-relay] 启动补转读收件箱失败:', String(result.stderr || result.stdout).slice(0, 200))
    return { failed: true }
  }
  let messages = []
  try {
    messages = JSON.parse(result.stdout).messages || []
  } catch {
    return { failed: true }
  }
  const missed = messages.filter((mail) => mail.date && Date.parse(mail.date) > Date.parse(since)).reverse()
  for (const mail of missed) await handler.handle({ ...mail, folder_id: 'INBOX' })
  return { checked: missed.length }
}

// 入口（网关 / 独立进程共用）：relay = config.mailRelay。没开或没有启用的路由就什么都不起。
export const startMailRelay = ({ relay, io, cli, consume = startConsumer, catchUp = catchUpRelay, schedule = setInterval }) => {
  const routes = relay?.enabled ? normalizeRoutes(relay) : []
  if (routes.length === 0) return { stop: () => {}, observe: () => null }
  const ledger = io || fileRelayIo(relay.stateFile ? resolveFromLarkBotRoot(relay.stateFile) : undefined)
  const { run, env } = cli || createRelayCli({ cliConfigDir: relay.cliConfigDir })
  const handler = createRelayHandler({ routes, io: ledger, run })
  const checkpoint = () => ledger.write({ ...ledger.read(), checkedAt: new Date().toISOString() })
  const consumer = consume({
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
  catchUp({ handler, io: ledger, run }).catch((error) => console.error('[lark-mail-relay] 启动补转失败:', error.message))
  // 只写本地时钟（下次重启补转的起点），不碰飞书。
  const timer = schedule(checkpoint, CHECKPOINT_EVERY_MS)
  timer?.unref?.()
  console.log(`[lark-mail-relay] 已启用 ${routes.length} 条路由：${routes.map((route) => `${route.id}（${route.label}）→ ${route.chatId}`).join('；')}`)
  return {
    routes,
    observe: () => consumer.observe?.() || null,
    stop: () => {
      clearInterval(timer)
      checkpoint()
      consumer.stop()
    },
  }
}
