/**
 * falive 实战数据读取（只读；docs/falive-replay-plan-2026-11-03.md §1）。
 * 源：replay/falive/raw/（仓库里跟版本） 下三个群的两份拉取（raw API 版：parent_id / root_id / 原始 content；+chat-messages-list 版：渲染文本、
 * sender 名、已下载附件）、~/Library/Logs/falive-lark/{gateway,worker}.log、lark-bot-falive 的台账与审计。
 * 产出统一的时间线消息（toEvent 可直接喂 ingestLarkEvent，形态同 lark-cli 拍平事件）与每条消息的 falive 基线。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// case 数据（原始拉取 raw/ + 整理后的 dataset/）跟仓库走、进版本：replay/falive/（aven 11-03「case 与回放脚本、计划和进度都放到 lark-bot 下，要跟踪版本」）。
// 回放产物（sim/<轮>-<段>/、l1/<run>/、ai-cache/、quota-pause.json）体量大、可重跑，仍在 runtime/falive-replay/（gitignore）；每轮的裁判与总账另存 replay/falive/rounds/。
export const casesDir = process.env.FALIVE_CASES_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'replay', 'falive')
export const replayRoot = process.env.FALIVE_REPLAY_DIR || join(homedir(), 'github', 'lark-bot', 'runtime', 'falive-replay')
export const rawDir = join(casesDir, 'raw')
export const datasetDir = join(casesDir, 'dataset')
export const roundsDir = join(casesDir, 'rounds')
// 附件路径在 case 数据里存成相对 raw/ 的（lark-im-resources/<file>），用时拼回绝对路径；老的绝对路径原样返回。
export const resolveRaw = (p) => (!p ? null : isAbsolute(p) ? p : join(rawDir, p))
export { replayRoot as outputRoot }
export const faliveRuntimeDir = join(homedir(), 'github', 'lark-bot-falive', 'runtime')
export const faliveLogDir = join(homedir(), 'Library', 'Logs', 'falive-lark')

export const GROUPS = [
  { key: 'php-group', chatId: 'oc_c2a63ac7c217235e14407ed1bba69d06', name: 'Falive PHP后端群', external: true },
  { key: 'tech-group', chatId: 'oc_40621901e1583e623f6133e8c66d352e', name: 'Falive产研技术沟通群', external: true },
  { key: 'webhook-group', chatId: 'oc_21a29d687ecfcd6d6776cac669a4c5d3', name: 'webhook bot', external: false },
]
export const chatById = Object.fromEntries(GROUPS.map((g) => [g.chatId, g]))

// falive bot（Aven.Bot / Aven.Test）：列消息里 sender.id 是应用 id；@ 它的 mention id 按群不同（外部群各一个 open_id）。
export const BOT_APP_ID = 'cli_c08abc1da138d00f'
export const BOT_MENTION_IDS = new Set([
  'ou_caf1610a679ff12b9b92204f37572491', // PHP 群
  'ou_f57c6c1d7caa9f3467607b925abd66a2', // 产研群 / 融合群
  'ou_9699982a8993fe4cb4c411e18a6d9b45', // webhook 群（Aven.Test）
  'ou_e331d79d4491e64b7bba89bb4e3b5e43', // 本租户 open_id（配置 botOpenId）
  'ou_a4c3fa804713a0f96a549a77e19b6a0f',
])
export const BOT_NAMES = new Set(['Aven.Bot', 'Aven.Test'])
export const AVEN_OPEN_ID = 'ou_91861d6da6cf6822e08045ba1868241e'

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

// 渲染版（+chat-messages-list）的 content 已内联 @名字；raw API 版 content 是 JSON 串（text {"text"} / post 结构）。
// 只有 raw 版时（渲染版拉不到，如已删除）按 text / post 粗渲染。
const renderRawContent = (msgType, rawContent, mentions = []) => {
  const nameOf = (key) => mentions.find((m) => m.key === key)?.name || key
  try {
    const content = JSON.parse(rawContent || '{}')
    if (msgType === 'text') return String(content.text || '').replace(/@_user_\d+/g, (key) => `@${nameOf(key)}`)
    if (msgType === 'post') {
      const blocks = Object.values(content).flatMap((locale) => (Array.isArray(locale) ? locale : locale?.content || []))
      return blocks.map((line) => (Array.isArray(line) ? line : []).map((el) => (
        el.tag === 'text' ? el.text : el.tag === 'at' ? `@${el.user_name || nameOf(el.user_id)}` : el.tag === 'a' ? `${el.text || ''}(${el.href || ''})` : el.tag === 'img' ? `![Image](${el.image_key})` : ''
      )).join('')).join('\n')
    }
    if (msgType === 'image') return `![Image](${content.image_key})`
    if (msgType === 'file') return `<file key="${content.file_key}" name="${content.file_name || ''}"/>`
  } catch {
    // 落到下面
  }
  return typeof rawContent === 'string' ? rawContent : ''
}

// 卡片（interactive）的渲染版文本：+chat-messages-list 把卡片里的 @ 渲染成「@名字(ou_xxx)」，人在群里看到的只是「@名字」。
// 11-04 核对（docs/falive-replay-design-v2.md §8 前置 5）：渲染版与 raw API 卡片 JSON（title / text / at / a / img / note）逐项比，
// 字段、列表项、链接都在（falive 的卡片只有 markdown / div / note，没有按钮），唯一的偏差就是这个 open_id 后缀，这里去掉。
// 只动 app 发的卡片；真人消息的文本原样不动。
const CARD_AT_RE = /@([^@()\n]+?)\((ou_[0-9A-Za-z]+)\)/g // 名字里可能有空格（「@Williamwang HT(ou_…)」）
export const cardDisplayText = (text) => String(text || '').replace(CARD_AT_RE, '@$1')
const displayText = ({ msgType, senderType, text }) => (msgType === 'interactive' && senderType === 'app' ? cardDisplayText(text) : text)

// 话题回复（raw/threads/<omt>.json，build-context-cache.mjs 拉的）：按群拉历史只拿到每个话题的第一条，回复全漏
//（11-03：漏 1781 条，其中真人 @bot 54 条、falive 当时分类过的 121 条）。同一格式（api 一份 + 渲染版一份），按 chat_id 并进各群。
const loadThreadReplies = () => {
  const dir = join(rawDir, 'threads')
  const api = new Map()
  const rendered = new Map()
  if (!existsSync(dir)) return { api, rendered }
  const parse = (text) => {
    try {
      const data = JSON.parse(text || '{}').data || {}
      return data.items || data.messages || []
    } catch {
      return []
    }
  }
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue
    let cached
    try { cached = readJson(join(dir, file)) } catch { continue }
    for (const item of parse(cached.api)) {
      if (!api.has(item.chat_id)) api.set(item.chat_id, [])
      api.get(item.chat_id).push(item)
    }
    for (const view of parse(cached.rendered)) rendered.set(view.message_id, view)
  }
  return { api, rendered }
}

export const loadTimeline = () => {
  const messages = new Map()
  const threads = loadThreadReplies()
  for (const group of GROUPS) {
    const apiPath = join(rawDir, `${group.key}.api.json`)
    const listPath = join(rawDir, `${group.key}.json`)
    const rendered = new Map()
    if (existsSync(listPath)) for (const m of readJson(listPath).data?.messages || []) rendered.set(m.message_id, m)
    for (const item of threads.api.get(group.chatId) || []) if (threads.rendered.has(item.message_id) && !rendered.has(item.message_id)) rendered.set(item.message_id, threads.rendered.get(item.message_id))
    const groupItems = existsSync(apiPath) ? readJson(apiPath).data?.items || [] : []
    const seenIds = new Set(groupItems.map((item) => item.message_id))
    const apiItems = [...groupItems, ...(threads.api.get(group.chatId) || []).filter((item) => !seenIds.has(item.message_id) && seenIds.add(item.message_id))]
    const seen = new Set()
    for (const item of apiItems) {
      seen.add(item.message_id)
      const view = rendered.get(item.message_id) || null
      const mentions = (item.mentions || view?.mentions || []).map((m) => ({ id: m.id, key: m.key, name: m.name }))
      const senderType = item.sender?.sender_type || view?.sender?.sender_type || ''
      const senderId = item.sender?.id || view?.sender?.id || ''
      const ownBot = senderType === 'app' && (senderId === BOT_APP_ID || BOT_NAMES.has(view?.sender?.name))
      const recalled = view?.content === '[Invalid text JSON]' || /^This message was recalled$/.test(String(item.body?.content || ''))
      const shown = recalled ? '' : typeof view?.content === 'string' ? view.content : renderRawContent(item.msg_type, item.body?.content, mentions)
      const text = displayText({ msgType: item.msg_type, senderType, text: shown })
      const cliText = text !== shown ? shown : undefined // 真 lark-cli 给 bot 看的就是带 (ou_xxx) 的版本：假 CLI 供数用它，裁判 / 清单用 text
      messages.set(item.message_id, {
        id: item.message_id,
        ...(cliText ? { cliText } : {}),
        chatId: group.chatId,
        chatKey: group.key,
        chatName: group.name,
        atMs: Number(item.create_time),
        msgType: item.msg_type,
        senderType,
        senderId,
        senderName: view?.sender?.name || (ownBot ? 'Aven.Bot' : senderId),
        ownBot,
        isAven: senderId === AVEN_OPEN_ID,
        text,
        rawContent: item.body?.content ?? null,
        mentions,
        parentId: item.parent_id || null,
        rootId: item.root_id || null,
        threadId: item.thread_id || null,
        deleted: Boolean(item.deleted) || recalled,
        resources: (view?.resources || []).map((r) => ({ key: r.key, type: r.type, localPath: r.local_path || null })),
        atBot: mentions.some((m) => BOT_MENTION_IDS.has(m.id) || BOT_NAMES.has(m.name)),
      })
    }
    // 渲染版有、raw 版没有的（极少）：补进去，没有引用关系。
    for (const [id, view] of rendered) {
      if (seen.has(id)) continue
      const senderType = view.sender?.sender_type || ''
      const ownBot = senderType === 'app' && BOT_NAMES.has(view.sender?.name)
      const mentions = (view.mentions || []).map((m) => ({ id: m.id, key: m.key, name: m.name }))
      messages.set(id, {
        id, chatId: group.chatId, chatKey: group.key, chatName: group.name, atMs: Date.parse(String(view.create_time).replace(' ', 'T')) || 0,
        msgType: view.msg_type, senderType, senderId: view.sender?.id || '', senderName: view.sender?.name || '', ownBot, isAven: view.sender?.id === AVEN_OPEN_ID,
        text: displayText({ msgType: view.msg_type, senderType, text: typeof view.content === 'string' ? view.content : '' }),
        ...(typeof view.content === 'string' && displayText({ msgType: view.msg_type, senderType, text: view.content }) !== view.content ? { cliText: view.content } : {}), rawContent: null, mentions, parentId: null, rootId: null, threadId: view.thread_id || null,
        deleted: Boolean(view.deleted), resources: (view.resources || []).map((r) => ({ key: r.key, type: r.type, localPath: r.local_path || null })),
        atBot: mentions.some((m) => BOT_MENTION_IDS.has(m.id) || BOT_NAMES.has(m.name)),
      })
    }
  }
  return [...messages.values()].sort((a, b) => a.atMs - b.atMs || a.id.localeCompare(b.id))
}

// 时间线消息 → lark-cli 拍平的长连接事件（lib/lark-message.normalizeMessage 认的形态；见 __tests__/lark-ingest-flow.test.mjs 的 raw()）。
export const toEvent = (m) => ({
  message_id: m.id,
  chat_id: m.chatId,
  chat_type: 'group',
  message_type: m.msgType,
  sender_type: m.senderType === 'app' ? 'bot' : m.senderType || 'user',
  sender_id: m.senderId,
  content: m.cliText ?? m.text, // 假 CLI / 分类回放给 bot 看的 = 真 lark-cli 的渲染（卡片里 @名字(ou_xxx)）
  mentions: m.mentions,
  create_time: String(m.atMs),
  ...(m.parentId ? { reply_to: m.parentId } : {}),
  ...(m.rootId ? { root_id: m.rootId } : {}),
  ...(m.threadId ? { thread_id: m.threadId } : {}),
})

// 时间线消息 → +chat-messages-list / +messages-mget 返回的单条形态（lib/lark-chat-context.pickRecentContext 读的字段）。
export const toListItem = (m) => ({
  message_id: m.id,
  chat_id: m.chatId,
  msg_type: m.msgType,
  content: m.text,
  create_time: String(m.atMs),
  deleted: m.deleted,
  sender: { id: m.senderType === 'app' ? BOT_APP_ID : m.senderId, id_type: m.senderType === 'app' ? 'app_id' : 'open_id', sender_type: m.senderType, name: m.senderName, ...(m.ownBot ? { open_bot_id: BOT_APP_ID } : {}) },
  mentions: m.mentions,
  ...(m.threadId ? { thread_id: m.threadId } : {}),
})

// —— falive 基线 ——
const CLASSIFIED_RE = /task-mention (om_x[0-9a-f]+) classified=([a-z_]+)(?:\/([a-z]+))?/
const stripTs = (line) => line.replace(/^\d{4}-\d{2}-\d{2}[ T][\d:.]+\S*\s+/, '')

export const loadGatewayBaseline = () => {
  const path = join(faliveLogDir, 'gateway.log')
  if (!existsSync(path)) return { classified: new Map(), lines: new Map() }
  const classified = new Map()
  const lines = new Map()
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = stripTs(raw)
    const m = line.match(CLASSIFIED_RE)
    if (m) classified.set(m[1], { decision: m[2], confidence: m[3] || null })
    for (const id of new Set(line.match(/om_x[0-9a-f]{20,}/g) || [])) {
      if (!lines.has(id)) lines.set(id, [])
      lines.get(id).push(line.replace(/^\[lark-gateway\]\s*/, '').slice(0, 300))
    }
  }
  return { classified, lines }
}

// worker.log 里「claimed <id> via claude: <正文…>」：正文到下一行 [lark-worker] 为止（含上下文块）。
export const loadWorkerClaimedTexts = () => {
  const path = join(faliveLogDir, 'worker.log')
  const out = new Map()
  if (!existsSync(path)) return out
  const lines = readFileSync(path, 'utf8').split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const m = stripTs(lines[i]).match(/\[lark-worker\] claimed (om_x[0-9a-f]+|[\w-]+) via \w+: (.*)$/)
    if (!m) continue
    const body = [m[2]]
    for (let j = i + 1; j < lines.length && !/\[lark-(worker|gateway)\]/.test(lines[j]); j += 1) body.push(lines[j])
    if (!out.has(m[1])) out.set(m[1], body.join('\n').trim())
  }
  return out
}

export const loadLedger = () => {
  const path = join(faliveRuntimeDir, 'lark-ledger', 'falive.json')
  if (!existsSync(path)) return { items: {}, events: [], byMessage: new Map() }
  const ledger = readJson(path)
  const byMessage = new Map()
  for (const event of ledger.events || []) if (event.messageId) byMessage.set(event.messageId, event)
  return { ...ledger, byMessage }
}

// 审计：每个任务取最后一代（-e<n>.json 最大的）。
export const loadAudits = () => {
  const dir = join(faliveRuntimeDir, 'lark-audits', 'FALIVE')
  const byTask = new Map()
  if (!existsSync(dir)) return byTask
  for (const file of readdirSync(dir)) {
    const m = file.match(/^(.*)-e(\d+)\.json$/)
    if (!m) continue
    const epoch = Number(m[2])
    const prev = byTask.get(m[1])
    if (prev && prev.epoch >= epoch) continue
    try {
      const audit = readJson(join(dir, file))
      byTask.set(m[1], { epoch, file: join(dir, file), audit })
    } catch {
      // 坏文件跳过
    }
  }
  return byTask
}

export const auditSummary = (entry) => {
  if (!entry) return null
  const a = entry.audit
  return {
    file: entry.file,
    epoch: entry.epoch,
    status: a.status || null,
    workKind: a.workKind || null,
    chatId: a.task?.chatId || null,
    text: a.task?.text || null,
    summary: a.task?.summary || null,
    attachments: (a.attachments || a.task?.attachments || []).map((x) => ({ type: x.type, localPath: x.localPath || null, origin: x.origin || null })),
    finalStatus: a.final?.status || null,
    finalSummary: a.final?.summary || null,
    commit: a.commit?.sha || a.commit || null,
    startedAt: a.startedAt || null,
    completedAt: a.completedAt || null,
  }
}

// 时间线消息 → 模拟器 / L1 回放喂给 ingest 的事件：不同群里 @bot 的 open_id 统一改写成配置的 botOpenId；
// webhook 群（falive 控制台，只有 aven）里 aven 说的话映射成负责人私信（p2p，chat_id = aven open_id）。
export const toSimEvent = (m, { botOpenId }) => {
  const event = toEvent(m)
  event.mentions = event.mentions.map((x) => (BOT_MENTION_IDS.has(x.id) ? { ...x, id: botOpenId } : x))
  if (m.chatKey === 'webhook-group' && m.senderId === AVEN_OPEN_ID) Object.assign(event, { chat_type: 'p2p', chat_id: AVEN_OPEN_ID })
  return event
}
