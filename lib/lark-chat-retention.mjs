/**
 * 自动退闲置群（aven 11-02「14 天没有 @bot 的群，能自动退群吗？」）。gateway 侧，纯轻量：
 *   · 每天本地 config.chatRetention.at（默认 09:35）查一次 bot 所在群（listBotChats，读失败本轮整个跳过，不把「读不到」当「没群」）；
 *   · 闲置 = 现在 − 最后活跃（没记过就从功能上线 startedAt 算，不回填历史）≥ idleDays（默认 14 天）；
 *   · 闲置且没提醒过 → 合并私信负责人一条「48 小时后自动退出」；提醒后 ≥ graceHours（默认 48）还闲置 → 退群、合并私信「已退出」；
 *     提醒后群里又有人找 bot（lib/lark-chat-activity.mjs 记账时清掉 warnedAt）就不退了；
 *   · 退群缺权限（飞书 99991672「has not applied for the required scope(s)」）：私信负责人一次要开哪个权限，群留在待退列表，
 *     之后每天静默再试，错误不变不再私信（scopeNotifiedFor 记上次私信过的错误）；
 *   · 永远不退：config.chatRetention.keep、OL 邮件转发群（mailOl.chatId，bot 只回卡片不记活跃）、bug 表群（bugTable.chatId / bugTable.watch.notifyChatId）、负责人私信「留下 关键字」标过的。
 *    falive 的群不豁免（aven 11-02：满足规则也可以退）——同一个飞书应用，群里 @bot 的事件 lark-bot 照样收得到、照样记活跃。
 * 负责人私信指令（整句前缀，只认私聊）：「留下 群名里的几个字」标为不退；「退群列表」看待退 / 已提醒 / 不退的群。
 * 退群用异步 runLarkCliRetrying（gateway 纯度闸：闭包里不许同步子进程）。
 */

import { formatLarkCliError, larkCallFailed, listBotChats, runLarkCliRetrying } from './lark-cli.mjs'
import { ensureStarted, fileActivityIo, updateActivity } from './lark-chat-activity.mjs'
import { sendPrincipalNote } from './lark-group-exit.mjs'
import { isPrincipal } from './lark-principal-channel.mjs'

const HOUR_MS = 60 * 60_000
const DAY_MS = 24 * HOUR_MS
// 每天只查一次、查点随 gateway 重启在那一分钟里漂：宽限按「到点前一小时内」也算到点，免得提醒后第三天才退。
export const RUN_SLACK_MS = HOUR_MS
// 群列表读失败后隔多久再试（不每分钟打飞书接口，11-02 限流教训）。
export const RETRY_GAP_MS = 30 * 60_000
const KIND = 'chat_retention'

const pad = (n) => String(n).padStart(2, '0')
const localDateKey = (ms) => new Date(ms).toLocaleDateString('sv-SE')
const localHHMM = (ms) => `${pad(new Date(ms).getHours())}:${pad(new Date(ms).getMinutes())}`
const localMDHM = (ms) => `${pad(new Date(ms).getMonth() + 1)}-${pad(new Date(ms).getDate())} ${localHHMM(ms)}`

// 配置缺省：开、14 天、48 小时、09:35、不额外留（形状由 lark-config validateConfig 把关）。
export const retentionSettings = (config) => {
  const raw = config?.chatRetention || {}
  return { enabled: raw.enabled !== false, idleDays: raw.idleDays ?? 14, graceHours: raw.graceHours ?? 48, at: raw.at || '09:35', keep: raw.keep || [] }
}

// 不退的理由（null = 可以退）。
export const exemptReason = ({ config, state, chatId, name }) => {
  if (retentionSettings(config).keep.includes(chatId)) return '配置里留着'
  if (config.mailOl?.enabled && config.mailOl.chatId === chatId) return 'OL 邮件转发群'
  if (state.chats[chatId]?.keep) return '你说留下的'
  if (chatId === config?.bugTable?.chatId || chatId === config?.bugTable?.watch?.notifyChatId) return 'bug 表的群'
  return null
}

// 纯函数：把 bot 当前所在群分成 到点该退 leave / 已提醒还没到点 warned / 闲置没提醒 idle / 不退 exempt。
export const classifyChats = ({ config, state, chats, now }) => {
  const { idleDays, graceHours } = retentionSettings(config)
  const out = { leave: [], warned: [], idle: [], exempt: [] }
  for (const [chatId, rawName] of chats) {
    const name = rawName || chatId
    const reason = exemptReason({ config, state, chatId, name: rawName })
    if (reason) {
      out.exempt.push({ chatId, name, reason })
      continue
    }
    const entry = state.chats[chatId] || {}
    const since = Date.parse(entry.lastActiveAt || state.startedAt || '')
    if (!(now - since >= idleDays * DAY_MS)) continue
    const warnedAt = Date.parse(entry.warnedAt || '')
    if (!warnedAt) {
      out.idle.push({ chatId, name })
      continue
    }
    const due = warnedAt + graceHours * HOUR_MS
    ;(now >= due - RUN_SLACK_MS ? out.leave : out.warned).push({ chatId, name, due })
  }
  return out
}

const bullets = (items) => items.map((item) => `- ${item.name}`).join('\n')

export const sayWarn = ({ items, settings }) =>
  `这 ${items.length} 个群 ${settings.idleDays} 天没人 @我了，${settings.graceHours} 小时后我自动退出：\n${bullets(items)}\n要留哪个就回「留下 群名里的几个字」。`
export const sayLeft = (items) => `已退出：\n${bullets(items)}`
export const sayLeaveFailed = ({ failure, pending }) => (failure.scopes
  ? `到点该退的群我退不了：应用还没开通 ${failure.scopes.length ? `${failure.scopes.join('、')} 权限` : '退群要的权限'}，去飞书开发者后台给应用加上、发个版就行。我每天会自己再试，这事不再提醒。还没退的：\n${bullets(pending)}`
  : `到点该退的群退失败了（${failure.reason}）。我每天会自己再试，同样的错不再提醒。还没退的：\n${bullets(pending)}`)

// 退群失败归类：缺权限（带要开的 scope）/ 其它。key 用来判断「错误变了没有」，变了才再私信。
const SCOPE_RE = /required scope\(s\):\s*([a-z][\w.]*:[\w:.]*\w(?:\s*,\s*[a-z][\w.]*:[\w:.]*\w)*)/i
export const leaveFailureOf = (result) => {
  const text = `${result?.stdout || ''} ${result?.stderr || ''}`
  const scopes = text.match(SCOPE_RE)?.[1]
  if (scopes || /99991672/.test(text)) return { key: `scope:${scopes || ''}`, scopes: scopes ? scopes.split(/\s*,\s*/) : [] }
  const reason = formatLarkCliError(result)
  return { key: `error:${reason.replace(/\d+/g, '#').slice(0, 80)}`, reason }
}

// bot 自己退群：把应用（app_id）从群成员里删掉。没配 botAppId 当失败返回（不发请求）。
export const leaveChat = async ({ config, chatId, run = runLarkCliRetrying }) => {
  if (!config?.botAppId) return { code: -1, stdout: '', stderr: '没配 botAppId（cli_ 开头），不知道把谁移出群' }
  return run(['im', 'chat.members', 'delete', '--yes', '--params', JSON.stringify({ chat_id: chatId, member_id_type: 'app_id' }), '--data', JSON.stringify({ id_list: [config.botAppId] })])
}

// 每天跑一次：先退到点的，再提醒新闲置的。返回本轮结果（日志 / 单测用）。
export const runChatRetention = async ({ config, now = Date.now(), io = fileActivityIo(), listChats = listBotChats, send = sendPrincipalNote, leave = leaveChat }) => {
  const settings = retentionSettings(config)
  if (!settings.enabled) return { skipped: 'disabled' }
  const chats = await listChats()
  if (!chats) return { skipped: 'list failed' }
  const today = localDateKey(now)
  const state = updateActivity((s) => {
    ensureStarted(s, now)
    for (const chatId of Object.keys(s.chats)) if (!chats.has(chatId)) delete s.chats[chatId] // 已不在的群（被移出 / 解散）不再记
    // 提醒过、后来改成不退的：清掉提醒，免得哪天又不留了直接退、不先说一声
    for (const [chatId, name] of chats) if (s.chats[chatId]?.warnedAt && exemptReason({ config, state: s, chatId, name })) delete s.chats[chatId].warnedAt
    s.lastRunDate = today
  }, io)
  const plan = classifyChats({ config, state, chats, now })
  const left = []
  let failure = null
  for (const item of plan.leave) {
    const result = await leave({ config, chatId: item.chatId })
    if (larkCallFailed(result)) {
      failure = leaveFailureOf(result)
      break // 缺权限之类，后面的也一样会失败，不白打接口
    }
    left.push(item)
  }
  if (left.length) {
    updateActivity((s) => {
      for (const item of left) delete s.chats[item.chatId]
      delete s.scopeNotifiedFor // 退成功过，之后再失败要重新说
    }, io)
    await send({ config, text: sayLeft(left), kind: KIND, idempotencyKey: `chat-left-${today}` })
  }
  if (failure && io.read().scopeNotifiedFor !== failure.key) {
    const sent = await send({ config, text: sayLeaveFailed({ failure, pending: plan.leave.slice(left.length) }), kind: KIND, idempotencyKey: `chat-leave-fail-${today}` })
    if (sent?.ok) updateActivity((s) => { s.scopeNotifiedFor = failure.key }, io)
  }
  if (plan.idle.length) {
    const sent = await send({ config, text: sayWarn({ items: plan.idle, settings }), kind: KIND, idempotencyKey: `chat-warn-${today}` })
    if (sent?.ok) {
      updateActivity((s) => {
        for (const item of plan.idle) s.chats[item.chatId] = { ...s.chats[item.chatId], warnedAt: new Date(now).toISOString() }
      }, io)
    }
  }
  const result = { left: left.map((item) => item.chatId), warned: plan.idle.map((item) => item.chatId), failed: failure?.key || null }
  console.log(`[lark-gateway] 闲置群巡检：退出 ${left.length} 个、提醒 ${plan.idle.length} 个${failure ? `、退群失败 ${failure.key}` : ''}`)
  return result
}

// 「退群列表」的回复。
export const sayRetentionList = ({ config, state, chats, now }) => {
  const plan = classifyChats({ config, state, chats, now })
  const { idleDays } = retentionSettings(config)
  const lines = []
  const pending = [...plan.leave, ...plan.warned]
  if (pending.length) lines.push('已经提醒过、到点就退的：', ...pending.map((item) => `- ${item.name}（${localMDHM(item.due)} 后退）`))
  if (plan.idle.length) lines.push(`${idleDays} 天没人 @我、下次查的时候会提醒的：`, bullets(plan.idle))
  if (!lines.length) lines.push('现在没有要退的群。')
  if (plan.exempt.length) lines.push('不退的：', ...plan.exempt.map((item) => `- ${item.name}（${item.reason}）`))
  return lines.join('\n')
}

// 负责人私信指令：「退群列表」整句；「留下 关键字」前缀（留下后面要有空格或冒号，免得「留下来」之类误认）。
export const parseRetentionDirective = (text) => {
  const bare = String(text || '').trim()
  if (/^退群列表[。.!！]?$/.test(bare)) return { kind: 'list' }
  const keyword = bare.match(/^留下[\s:：]+(.+)$/)?.[1].replace(/^[「“"']+|[」”"']+$/g, '').trim()
  return keyword ? { kind: 'keep', keyword } : null
}

// ingest 在分类之前调：只认负责人本人私聊。认出来就回一句，返回 true（不再往下走分类）。
export const maybeHandleRetentionDirective = async ({ msg, config, now = Date.now(), io = fileActivityIo(), listChats = listBotChats, send = sendPrincipalNote }) => {
  if (msg.chatType !== 'p2p' || !isPrincipal(config, msg.senderOpenId)) return false
  const directive = parseRetentionDirective(msg.text)
  if (!directive) return false
  const reply = (text) => send({ config, text, kind: KIND, idempotencyKey: `${msg.messageId}-rt`.slice(0, 50) })
  const chats = await listChats()
  if (!chats) {
    await reply('群列表这会儿读不到，过会儿再试。')
    return true
  }
  if (directive.kind === 'list') {
    await reply(sayRetentionList({ config, state: io.read(), chats, now }))
    return true
  }
  const needle = directive.keyword.toLowerCase()
  const hits = [...chats].filter(([, name]) => String(name || '').toLowerCase().includes(needle)).map(([chatId, name]) => ({ chatId, name }))
  if (hits.length === 1) {
    updateActivity((s) => {
      ensureStarted(s, now)
      const { warnedAt, ...entry } = s.chats[hits[0].chatId] || {}
      s.chats[hits[0].chatId] = { ...entry, keep: true }
    }, io)
    await reply(`好，「${hits[0].name}」不退了。`)
  } else if (hits.length) {
    await reply(`名字里带「${directive.keyword}」的群有 ${hits.length} 个：\n${bullets(hits)}\n多给几个字，我好分清是哪个。`)
  } else {
    await reply(`没找到名字里带「${directive.keyword}」的群。`)
  }
  return true
}

// 每分钟看一眼：到了当天的点、今天还没成功查过、离上次尝试超过 30 分钟、上一轮没在跑 → 跑一次。enabled=false 整个不起（私信指令照样能用）。
export const startChatRetention = ({ config, run = runChatRetention, io = fileActivityIo(), intervalMs = 60_000, clock = Date.now }) => {
  const settings = retentionSettings(config)
  if (!settings.enabled) return { stop: () => {}, tick: async () => null }
  try {
    updateActivity((s) => (s.startedAt ? false : Boolean(ensureStarted(s, clock()))), io) // 时钟从上线这一刻起，不回填历史
  } catch (error) {
    console.warn(`[lark-gateway] 闲置群记账初始化失败：${String(error?.message || error).slice(0, 120)}`)
  }
  let running = false
  let lastAttemptAt = -Infinity
  const tick = async () => {
    const now = clock()
    if (running || localHHMM(now) < settings.at || now - lastAttemptAt < RETRY_GAP_MS) return null
    if (io.read().lastRunDate === localDateKey(now)) return null
    running = true
    lastAttemptAt = now
    try {
      return await run({ config, now, io })
    } catch (error) {
      console.error(`[lark-gateway] 闲置群巡检异常：${String(error?.message || error).slice(0, 160)}`)
      return null
    } finally {
      running = false
    }
  }
  const timer = setInterval(tick, intervalMs)
  timer.unref?.()
  return { stop: () => clearInterval(timer), tick }
}
