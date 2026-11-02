/**
 * OL 上线申请邮件自动转审批群（aven 11-02「先这样跑一跑试几天」）：网关里常驻一个 `mail +watch`（aven 的 user 身份，
 * 收信通知事件），新邮件进 INBOX 且主题像 OL 申请首封 → forwardOlMail（分享卡片 + bot 回评分）。
 *
 * 已知代价（docs/mail-ol-scoring-2026-11-02.md §6 实测）：+watch 自己开一条 WebSocket，飞书会把本应用的部分 im 事件分到它这条，
 * 它没有 handler → 失败 → 飞书重投给网关，群消息偶尔晚到几秒；aven 知情、先试几天。config.mailOl.enabled=false 立即关。
 *
 * 不轮询：停机期间的邮件事件飞书不补推，启动时只做一次 +triage 补转「上次在线」之后到达的申请；首次启用不回填历史。
 * 台账 runtime/lark-mail-ol-state.json：{ checkedAt, forwarded: { [message_id]: { at, ok, step?, score? } } }，只留最近 500 条。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { larkCallFailed, runLarkCli } from './lark-cli.mjs'
import { startConsumer } from './lark-consumer.mjs'
import { forwardOlMail } from './lark-mail-ol-forward.mjs'
import { hasOlSubject } from './lark-mail-ol-score.mjs'
import { larkRuntimeDir } from './lark-paths.mjs'

export const MAIL_OL_STATE_FILE = 'lark-mail-ol-state.json'
const KEEP_RECORDS = 500
const CHECKPOINT_EVERY_MS = 10 * 60_000
const CATCHUP_MAX = 100

const defaultPath = () => (process.env.NODE_TEST_CONTEXT && !process.env.LARK_RUNTIME_DIR ? null : join(larkRuntimeDir, MAIL_OL_STATE_FILE))

// 文件读写（可注入）。读坏了当空台账；写先写 .tmp 再改名；写失败只打日志。
export const fileMailOlIo = (path = defaultPath()) => ({
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
      console.error('[lark-mail-ol] 台账写入失败:', error.message)
    }
  },
})

const trimRecords = (forwarded) =>
  Object.fromEntries(Object.entries(forwarded).sort((a, b) => String(b[1]?.at).localeCompare(String(a[1]?.at))).slice(0, KEEP_RECORDS))

// +watch --format data 的一行：{ message: {...} }；--format json 是 { ok, data: { message } }。都认。
export const mailFromWatchLine = (raw) => raw?.message || raw?.data?.message || null

// 一封邮件要不要处理：INBOX、主题带 OL 标记、没处理过。回复类在 forwardOlMail 里读全信后再按 in_reply_to / Re: 筛掉（记台账不重读）。
export const shouldHandleMail = (mail, forwarded) =>
  Boolean(mail?.message_id) && (mail.folder_id == null || mail.folder_id === 'INBOX') && hasOlSubject(mail.subject) && !forwarded[mail.message_id]

export const createMailOlHandler = ({ chatId, io = fileMailOlIo(), forward = forwardOlMail, now = () => new Date().toISOString() }) => {
  let chain = Promise.resolve()
  // 串行：同一封邮件事件重投 / 补转与实时撞车时不会转两遍（先查台账再转、转完立刻记）。
  const handle = (mail) => {
    chain = chain.then(async () => {
      const state = io.read()
      if (!shouldHandleMail(mail, state.forwarded)) return null
      let outcome
      try {
        outcome = await forward({ messageId: mail.message_id, chatId })
      } catch (error) {
        outcome = { ok: false, step: 'exception', reason: error.message }
      }
      // 读信 / 分享失败多半是瞬时（限流、网络）：不记台账，下次重投或重启补转还能再来；判定为非首封也记，免得反复读。
      if (!outcome.ok && outcome.step !== 'filter' && outcome.step !== 'score') {
        console.error(`[lark-mail-ol] ${mail.message_id} 转发失败（${outcome.step}）：${outcome.reason}`)
        return outcome
      }
      const fresh = io.read()
      fresh.forwarded[mail.message_id] = { at: now(), ok: outcome.ok, ...(outcome.step ? { step: outcome.step } : {}), ...(outcome.result ? { score: outcome.result.score, tier: outcome.result.tier } : {}) }
      fresh.forwarded = trimRecords(fresh.forwarded)
      io.write(fresh)
      console.log(`[lark-mail-ol] ${mail.message_id} ${outcome.ok ? `已转 ${outcome.result?.score}/${outcome.result?.max}（${outcome.result?.tier}）${outcome.scoreVia}` : `跳过（${outcome.step}）`}：${mail.subject}`)
      return outcome
    })
    return chain
  }
  return { handle }
}

// 启动补转：只查一次 INBOX 最近邮件，转「上次在线」之后到达、还没转过的 OL 申请。首次启用（无 checkedAt）只落时钟不回填。
export const catchUpMailOl = async ({ handler, io = fileMailOlIo(), run = runLarkCli, now = () => new Date().toISOString() }) => {
  const state = io.read()
  const since = state.checkedAt
  io.write({ ...state, checkedAt: now() })
  if (!since) return { skipped: 'first-run' }
  const result = await run(['mail', '+triage', '--filter', JSON.stringify({ folder: 'INBOX' }), '--query', 'OL', '--max', String(CATCHUP_MAX), '--format', 'json'], { identity: 'user' })
  if (larkCallFailed(result)) {
    console.error('[lark-mail-ol] 启动补转读收件箱失败:', String(result.stderr || result.stdout).slice(0, 200))
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

// 网关入口：config.mailOl = { enabled, chatId }。没开就什么都不起。
export const startMailOlWatch = ({ config, io = fileMailOlIo(), consume = startConsumer, catchUp = catchUpMailOl, schedule = setInterval }) => {
  const options = config?.mailOl
  if (!options?.enabled || !options.chatId) return { stop: () => {}, observe: () => null }
  const handler = createMailOlHandler({ chatId: options.chatId, io })
  const checkpoint = () => io.write({ ...io.read(), checkedAt: new Date().toISOString() })
  const consumer = consume({
    eventKey: 'mail.user_mailbox.event.message_received_v1',
    command: ['--as', 'user', 'mail', '+watch', '--msg-format', 'metadata', '--format', 'data'],
    maxRestarts: 8,
    onLine: (raw) => {
      const mail = mailFromWatchLine(raw)
      if (mail) return handler.handle(mail)
      return null
    },
    onDownAlert: () => {},
  })
  catchUp({ handler, io }).catch((error) => console.error('[lark-mail-ol] 启动补转失败:', error.message))
  // 只写本地时钟（下次重启补转的起点），不碰飞书。
  const timer = schedule(checkpoint, CHECKPOINT_EVERY_MS)
  timer?.unref?.()
  console.log(`[lark-mail-ol] 已启用：OL 上线申请邮件 → ${options.chatId}`)
  return {
    observe: () => consumer.observe?.() || null,
    stop: () => {
      clearInterval(timer)
      checkpoint()
      consumer.stop()
    },
  }
}
