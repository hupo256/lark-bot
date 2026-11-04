#!/usr/bin/env node
/**
 * 假 lark-cli（离线模拟器，docs/falive-replay-plan-2026-11-03.md §2 L2）：LARK_CLI_BIN 指到 scripts/sim/lark-cli（壳脚本 exec 本文件）。
 * 从 SIM_DIR 供数 / 记账：
 *   timeline.json   数据集时间线（真人消息 + falive bot 的消息；哪些 bot 话不供见 hideFaliveBot）
 *   meta.json       simStartMs；按事件组跑时另有 episode / hideBotIds
 *   clock.json      虚拟时钟（只回「现在」以前的消息）
 *   events.ndjson   编排器按时间追加的长连接事件；`event consume im.message.receive_v1` 从 consume.offset 起 tail 输出
 *   sent.json       模拟 bot 发出的消息（send / reply），也参与列消息 / mget / 话题（后续消息的上下文）
 *   outbox.jsonl    每次发送的完整记录（对照用）
 *   cli-calls.log   每次调用的 argv（排错用）
 * 子命令：im +chat-list / +chat-messages-list / +messages-mget / +threads-messages-list / +messages-send / +messages-reply /
 * +messages-resources-download；event consume；docs +create / drive permission.public（记账）。
 * 上下文缓存（scripts/sim/build-context-cache.mjs 用 aven 身份只读拉好，落 replay/falive/raw/（仓库里跟版本），都是「拉取时」的版本）：
 *   docs +fetch                       raw/docs/<token>.json 的原始 stdout（sim 自己建的 simdoc 从 SIM_DIR/docs 读）
 *   base +record-list / +record-share-link-create / +record-get / +record-download-attachment   raw/bug-records/（tools/read-bug-record.mjs 的读法）
 *   +messages-mget / 列消息            raw/expanded/<id>.json 的 content 覆盖时间线里的（合并转发 / 渲染版缺失）
 *   +messages-resources-download      SIM_DIR/resources.json → raw/resources-extra.json → raw/lark-im-resources/<key>.*
 * 缓存查不到的、其余子命令：回 ok:false，并记 SIM_DIR/missing.log（一行一条：时间 类别 键 原因）；每次缓存查找记 SIM_DIR/context-cache.log（hit / miss）。
 */
import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const simDir = process.env.SIM_DIR
if (!simDir) {
  process.stdout.write(JSON.stringify({ ok: false, error: { type: 'sim', message: 'SIM_DIR 未设置' } }))
  process.exit(2)
}
const argv = process.argv.slice(2)
appendFileSync(join(simDir, 'cli-calls.log'), `${new Date().toISOString()} ${argv.map((a) => (a.length > 120 ? `${a.slice(0, 120)}…` : a)).join(' ')}\n`)

// 解析：位置参数 + --key value / --flag（重复的 flag 如 --file-token 另存进 multi）
const positional = []
const opts = {}
const multi = {}
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]
  if (a.startsWith('--')) {
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next != null && !next.startsWith('--')) {
      opts[key] = next
      ;(multi[key] ||= []).push(next)
      i += 1
    } else opts[key] = true
  } else positional.push(a)
}
const [domain, command, ...rest] = positional
const out = (payload) => process.stdout.write(JSON.stringify(payload))
const fail = (message) => {
  out({ ok: false, error: { type: 'sim', message } })
  process.exit(1)
}

// —— 上下文缓存（raw/，build-context-cache.mjs 产出） ——
const rawDir = process.env.FALIVE_REPLAY_RAW || join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'replay', 'falive', 'raw') // case 数据在仓库 replay/falive/raw/
const resolveRaw = (p) => (!p ? null : isAbsolute(p) ? p : join(rawDir, p))
const cacheLog = (outcome, kind, key, reason = '') => {
  const line = `${new Date().toISOString()} ${outcome} ${kind} ${key}${reason ? ` ${reason}` : ''}\n`
  appendFileSync(join(simDir, 'context-cache.log'), line)
  if (outcome === 'miss') appendFileSync(join(simDir, 'missing.log'), line.replace(' miss ', ' '))
}
// 缓存没有：ok:false（与真 CLI 读不到时一样非 0 退出），并记 missing.log
const miss = (kind, key, message) => {
  cacheLog('miss', kind, key, message)
  fail(`${message}（回放缓存里没有：${kind} ${key}）`)
}
const readRaw = (...parts) => {
  try {
    return JSON.parse(readFileSync(join(rawDir, ...parts), 'utf8'))
  } catch {
    return null
  }
}
// 缓存记录里存的是 lark-cli 的原始 stdout：原样吐出
const replayStdout = (record) => {
  process.stdout.write(record.stdout)
  process.exit(0)
}
// 合并转发 / 渲染版缺失的消息：+messages-mget 展开后的 content（与时间线不同时以它为准）
let expandedCache = null
const expandedContent = (id) => {
  if (!expandedCache) {
    expandedCache = new Map()
    const dir = join(rawDir, 'expanded')
    if (existsSync(dir)) {
      for (const file of readdirSync(dir)) {
        const record = readRaw('expanded', file)
        if (!record?.ok) continue
        try {
          const msg = JSON.parse(record.stdout).data?.messages?.[0]
          if (msg && typeof msg.content === 'string') expandedCache.set(msg.message_id, { content: msg.content, msgType: msg.msg_type })
        } catch {
          // 坏记录跳过
        }
      }
    }
  }
  return expandedCache.get(id) || null
}

const BOT_APP_ID = 'cli_c08abc1da138d00f'
const AVEN_OPEN_ID = 'ou_91861d6da6cf6822e08045ba1868241e'
const WEBHOOK_CHAT_ID = 'oc_21a29d687ecfcd6d6776cac669a4c5d3'
const readJson = (name, fallback) => {
  try {
    return JSON.parse(readFileSync(join(simDir, name), 'utf8'))
  } catch {
    return fallback
  }
}
const nowMs = () => {
  const clock = readJson('clock.json', null)
  return clock && Number.isFinite(clock.virtualMs) ? clock.virtualMs + (Date.now() - clock.realMs) : Date.now()
}
const CHATS = readJson('chats.json', [])
const chatName = (chatId) => CHATS.find((c) => c.chat_id === chatId)?.name || ''

// 消息视图（与 +chat-messages-list 输出同形）。时间线条目 → list item；模拟发出的消息已是 list item。
// webhook 群（falive 的负责人控制台，只有 aven）= lark-bot 的负责人私信：run-sim 把 aven 在那里说的话喂成 chat_id = aven open_id 的 p2p，
// 这里把那个群的历史（aven 的话 + falive 当时私信过去的卡）也按同一个 chat_id 供，私信里读「之前的消息」才对得上（P0-d 冒烟发现：原来私信历史是空的）。
const toListItem = (m) => ({
  message_id: m.id,
  chat_id: m.chatId === WEBHOOK_CHAT_ID ? AVEN_OPEN_ID : m.chatId,
  msg_type: m.msgType,
  content: expandedContent(m.id)?.content ?? m.cliText ?? m.text, // bot 看到的 = 真 lark-cli 的渲染
  create_time: String(m.atMs),
  deleted: m.deleted,
  sender: { id: m.senderType === 'app' ? BOT_APP_ID : m.senderId, id_type: m.senderType === 'app' ? 'app_id' : 'open_id', sender_type: m.senderType, name: m.senderName, ...(m.ownBot ? { open_bot_id: BOT_APP_ID } : {}) },
  mentions: m.mentions || [],
  ...(m.threadId ? { thread_id: m.threadId } : {}),
  ...(m.rootId ? { root_id: m.rootId } : {}),
  ...(m.parentId ? { parent_id: m.parentId } : {}),
})
// falive bot 当时的话哪些不供（模拟 bot 自己会说话，供了就是一件事回两遍）：
// · 按事件组跑（meta.hideBotIds，run-sim --episode 写）：只藏 falive 对本组 case 说的那些（episodes.json 的 faliveBotIds：回复链 / 话题 /
//   卡 → case / 私信卡 → 任务），组外的 bot 话照供——群里的人后面的话是在回应那句（design-v2 §2）。
// · 按天跑（旧）：模拟窗口内的一律不供，窗口前的留作历史。
// 按 id 点名取（被引用 / 被回复的那条）不受这条限制，见 byIdAny。
let hiddenBot = null
const hideFaliveBot = (id, atMs) => {
  if (!hiddenBot) {
    const meta = readJson('meta.json', {})
    hiddenBot = Array.isArray(meta.hideBotIds) ? { ids: new Set(meta.hideBotIds) } : { simStart: Number(meta.simStartMs || 0) }
  }
  return hiddenBot.ids ? hiddenBot.ids.has(id) : atMs >= hiddenBot.simStart
}
let allMessages = null
const messages = () => {
  if (allMessages) return allMessages
  const cutoff = nowMs()
  const timeline = readJson('timeline.json', [])
    .filter((m) => !(m.ownBot && hideFaliveBot(m.id, m.atMs)))
    .map(toListItem)
  const sent = readJson('sent.json', [])
  allMessages = [...timeline, ...sent].filter((m) => Number(m.create_time) <= cutoff).sort((a, b) => Number(a.create_time) - Number(b.create_time))
  return allMessages
}
const byId = (id) => messages().find((m) => m.message_id === id) || null
// 按 id 点名取（被引用 / 被回复的那条）：窗口内 falive bot 当时发的卡片也给——人回复的正是它，拉不到引用分类器就看不到上文
//（11-03 fix7 定位：「已關閉沒推流的直播間」回复的是 falive bot 请关房的卡，模拟里引用拉不到判了 ignore）。列消息时仍隐藏。
const byIdAny = (id) => byId(id) || (() => {
  const m = readJson('timeline.json', []).find((x) => x.id === id && x.atMs <= nowMs())
  if (m) return toListItem(m)
  const t = threadItems().byId.get(id)
  if (!t || Number(t.create_time) > nowMs()) return null
  const { ownBot, ...item } = t
  return item
})()

// 话题内的回复（raw/threads/，build-context-cache.mjs threads）：群历史按群拉不到它们。真 CLI 的 +threads-messages-list 只给回复、不含话题根
//（11-03 实测 204 个话题都不含根），列群消息也不含——所以只在 +threads-messages-list 与按 id 点名取时供出。
let threadCache = null
const threadItems = () => {
  if (threadCache) return threadCache
  threadCache = { byThread: new Map(), byId: new Map() }
  const dir = join(rawDir, 'threads')
  if (!existsSync(dir)) return threadCache
  for (const file of readdirSync(dir)) {
    const record = readRaw('threads', file)
    if (!record?.ok) continue
    let api = []
    let rendered = new Map()
    try {
      api = JSON.parse(record.api).data?.items || []
      rendered = new Map((JSON.parse(record.rendered).data?.messages || []).map((m) => [m.message_id, m]))
    } catch {
      continue
    }
    const list = []
    for (const it of api) {
      const view = rendered.get(it.message_id) || {}
      const app = it.sender?.sender_type === 'app'
      const item = {
        message_id: it.message_id,
        chat_id: it.chat_id,
        msg_type: it.msg_type,
        content: typeof view.content === 'string' ? view.content : String(it.body?.content || ''),
        create_time: String(it.create_time),
        deleted: Boolean(it.deleted),
        sender: { id: it.sender?.id, id_type: app ? 'app_id' : 'open_id', sender_type: it.sender?.sender_type, name: view.sender?.name || it.sender?.id, ...(app && it.sender?.id === BOT_APP_ID ? { open_bot_id: BOT_APP_ID } : {}) },
        mentions: (it.mentions || []).map((x) => ({ id: x.id, key: x.key, name: x.name })),
        thread_id: it.thread_id || record.threadId,
        ...(it.root_id ? { root_id: it.root_id } : {}),
        ...(it.parent_id ? { parent_id: it.parent_id } : {}),
        ownBot: app && it.sender?.id === BOT_APP_ID,
      }
      list.push(item)
      threadCache.byId.set(item.message_id, item)
    }
    threadCache.byThread.set(record.threadId, list)
  }
  return threadCache
}

// 列群消息只给主消息流：话题里的回复真 CLI 列群消息拿不到（只有 +threads-messages-list 给），时间线里却并进了 1793 条话题回复
//（P0-d 冒烟核对出来：bot 的【群里这条之前的消息】里混进了别的话题的回复，线上看不到）。真列表里本来就有的（raw/<群>.api.json，
// 「同时发到群」的那十来条）照给；模拟 bot 发在话题里的同口径不给。
let listedIds = null
const inMainStream = (m) => {
  if (!(m.thread_id && m.parent_id)) return true
  if (!listedIds) {
    listedIds = new Set()
    for (const key of ['php-group', 'tech-group', 'webhook-group']) for (const item of readRaw(`${key}.api.json`)?.data?.items || []) listedIds.add(item.message_id)
  }
  return listedIds.has(m.message_id)
}

// 发件：分配 om_sim id，落 sent.json（下次列消息能看到）与 outbox.jsonl（对照）。
const withLock = (fn) => {
  const lock = join(simDir, 'sent.lock')
  for (let i = 0; i < 400; i += 1) {
    let fd = null
    try {
      fd = openSync(lock, 'wx')
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
      continue
    }
    try {
      return fn()
    } finally {
      closeSync(fd)
      unlinkSync(lock)
    }
  }
  throw new Error('sent.lock 一直拿不到')
}
const record = ({ kind, chatId, parentId = null, text, msgType, inThread = false, userId = null }) => withLock(() => {
  const sent = readJson('sent.json', [])
  const seq = readJson('seq.json', { n: 0 })
  seq.n += 1
  writeFileSync(join(simDir, 'seq.json'), JSON.stringify(seq))
  const id = `om_sim${String(seq.n).padStart(5, '0')}`
  const at = nowMs()
  const parent = parentId ? byIdAny(parentId) : null
  // 在没有话题的消息下 --reply-in-thread：真飞书会就地开一个话题（父消息也进这个话题），这里给个 omt_sim_<父 id>
  const threadId = parent?.thread_id || (inThread && parentId ? `omt_sim_${parentId}` : null)
  const item = {
    message_id: id,
    chat_id: chatId,
    msg_type: msgType,
    content: text,
    create_time: String(at),
    deleted: false,
    sender: { id: BOT_APP_ID, id_type: 'app_id', sender_type: 'app', name: 'Aven.Bot', open_bot_id: BOT_APP_ID },
    mentions: [],
    ...(threadId ? { thread_id: threadId } : {}),
    ...(parentId ? { parent_id: parentId, root_id: parent?.root_id || parentId } : {}),
  }
  sent.push(item)
  writeFileSync(join(simDir, 'sent.json'), JSON.stringify(sent))
  appendFileSync(join(simDir, 'outbox.jsonl'), `${JSON.stringify({ id, kind, at, atIso: new Date(at).toISOString(), chatId, userId, parentId, inThread, msgType, text, idempotencyKey: opts['idempotency-key'] || null })}\n`)
  return { id, chatId }
})
const contentText = () => {
  if (opts.markdown != null) return String(opts.markdown)
  if (opts.text != null) return String(opts.text)
  if (opts.content != null) {
    try {
      const parsed = JSON.parse(opts.content)
      if (parsed?.zh_cn?.content) return parsed.zh_cn.content.map((row) => row.map((el) => el.text || '').join('')).join('\n')
      if (parsed?.elements) return `<card>\n${JSON.stringify(parsed.elements).slice(0, 2000)}\n</card>`
      return String(opts.content)
    } catch {
      return String(opts.content)
    }
  }
  return ''
}
const page = (list, { order = 'desc', pageSize = 50, pageToken }) => {
  const sorted = order === 'asc' ? list : [...list].reverse()
  const offset = Number(pageToken || 0)
  const slice = sorted.slice(offset, offset + pageSize)
  const hasMore = offset + pageSize < sorted.length
  return { messages: slice, has_more: hasMore, page_token: hasMore ? String(offset + pageSize) : '' }
}

if (domain === 'event' && command === 'consume') {
  const key = rest[0]
  if (key !== 'im.message.receive_v1') {
    // 其它事件（入群）：挂着不输出，别让 consumer 反复重连。
    setInterval(() => {}, 60_000)
  } else {
    const file = join(simDir, 'events.ndjson')
    const offsetPath = join(simDir, 'consume.offset')
    let offset = Number(existsSync(offsetPath) ? readFileSync(offsetPath, 'utf8') : 0) || 0
    process.stderr.write('sim consumer ready\n')
    const pump = () => {
      if (!existsSync(file)) return
      const size = statSync(file).size
      if (size <= offset) return
      const fd = openSync(file, 'r')
      const buf = Buffer.alloc(size - offset)
      readSync(fd, buf, 0, buf.length, offset)
      closeSync(fd)
      const text = buf.toString('utf8')
      const lastNl = text.lastIndexOf('\n')
      if (lastNl < 0) return
      process.stdout.write(text.slice(0, lastNl + 1))
      offset += Buffer.byteLength(text.slice(0, lastNl + 1))
      writeFileSync(offsetPath, String(offset))
    }
    pump()
    setInterval(pump, 300)
  }
} else if (domain === 'im' && command === '+chat-list') {
  out({ ok: true, data: { chats: CHATS, has_more: false, page_token: '' } })
} else if (domain === 'im' && command === '+chat-messages-list') {
  const chatId = opts['chat-id']
  const start = opts.start ? Number(opts.start) * 1000 : 0
  const end = opts.end ? Number(opts.end) * 1000 : Infinity
  const list = messages().filter((m) => m.chat_id === chatId && Number(m.create_time) >= start && Number(m.create_time) <= end && inMainStream(m))
  out({ ok: true, data: page(list, { order: opts.order || 'desc', pageSize: Number(opts['page-size'] || 50), pageToken: opts['page-token'] }) })
} else if (domain === 'im' && command === '+messages-mget') {
  const ids = String(opts['message-ids'] || '').split(',').filter(Boolean)
  out({ ok: true, data: { messages: ids.map(byIdAny).filter(Boolean) } })
} else if (domain === 'im' && command === '+threads-messages-list') {
  // 锚点按 id 点名取（窗口内 falive bot 的卡片也算，同 mget）；锚点不在话题里时真 CLI 回 not_found（11-03 实测
  // 「thread ID not found for this message」），这里照回——原来按 root_id 拼一串回复给出，是生产没有的上下文。列出的消息仍不含窗口内 falive bot 的。
  const anchorId = String(opts.thread || '')
  const anchor = anchorId.startsWith('omt_') ? null : byIdAny(anchorId)
  const simThread = `omt_sim_${anchorId}`
  const threadId = anchorId.startsWith('omt_') ? anchorId : anchor?.thread_id || (messages().some((m) => m.thread_id === simThread) ? simThread : null)
  if (!threadId) {
    out({ ok: false, identity: opts.as || 'bot', error: { type: 'api', subtype: 'not_found', message: 'thread ID not found for this message' } })
    process.exit(1)
  }
  // 话题根不在结果里（真 CLI 同口径）：时间线里带 thread_id 的都是根；模拟 bot 发的话题内回复、缓存的话题回复都有 parent_id。
  // falive bot 自己在话题里说的按 hideFaliveBot 藏（同列群消息）。
  const cutoff = nowMs()
  const cached = (threadItems().byThread.get(threadId) || []).filter((m) => Number(m.create_time) <= cutoff && !(m.ownBot && hideFaliveBot(m.message_id, Number(m.create_time))))
  const seen = new Set(cached.map((m) => m.message_id))
  const list = [...cached, ...messages().filter((m) => m.thread_id === threadId && m.parent_id && !seen.has(m.message_id))]
    .map(({ ownBot, ...m }) => m)
    .sort((a, b) => Number(a.create_time) - Number(b.create_time))
  cacheLog(cached.length ? 'hit' : 'empty', 'thread', threadId, `${cached.length} 条缓存回复`)
  out({ ok: true, data: page(list, { order: opts.order || 'desc', pageSize: Number(opts['page-size'] || 50), pageToken: opts['page-token'] }) })
} else if (domain === 'im' && command === '+messages-send') {
  const chatId = opts['chat-id'] || opts['user-id']
  const sent = record({ kind: 'send', chatId, userId: opts['user-id'] || null, text: contentText(), msgType: opts.markdown != null ? 'post' : opts['msg-type'] || 'text' })
  out({ ok: true, data: { message_id: sent.id, chat_id: chatId } })
} else if (domain === 'im' && command === '+messages-reply') {
  const parent = byIdAny(opts['message-id'])
  if (!parent) fail(`回复目标不存在：${opts['message-id']}`)
  const sent = record({ kind: 'reply', chatId: parent.chat_id, parentId: parent.message_id, inThread: Boolean(opts['reply-in-thread']), text: contentText(), msgType: opts.markdown != null ? 'post' : opts['msg-type'] || 'text' })
  out({ ok: true, data: { message_id: sent.id, chat_id: parent.chat_id } })
} else if (domain === 'im' && command === '+messages-resources-download') {
  // 查找顺序：SIM_DIR/resources.json（run-sim 建的；路径不存在就往下找）→ raw/resources-extra.json（全部附件的正确路径 + 补拉的）→ 按 file-key 在存档目录里找
  const key = String(opts['file-key'] || '')
  const id = `${opts['message-id']}/${key}`
  const resources = readJson('resources.json', {})
  const extra = readRaw('resources-extra.json')?.resources || {}
  const archive = join(rawDir, 'lark-im-resources')
  const byKey = key && existsSync(archive) ? readdirSync(archive).find((f) => f === key || f.startsWith(`${key}.`)) : null
  const src = [resources[id], resources[key], extra[id], byKey ? join(archive, byKey) : null].map(resolveRaw).find((p) => p && existsSync(p))
  if (!src) miss('resource', id, '存档里没有这份附件')
  cacheLog('hit', 'resource', id)
  const dst = resolve(process.cwd(), String(opts.output || basename(src)))
  copyFileSync(src, dst)
  out({ ok: true, identity: opts.as || 'bot', data: { saved_path: dst } })
} else if (domain === 'docs' && command === '+fetch') {
  // --doc 是链接或 token；token 取路径末段（去掉 ?query 与 Lark 渲染坏链接时编码进去的括号，同 lib/lark-doc.extractLarkDocUrls）
  const doc = String(opts.doc || '')
  const token = doc.split(/[?#]/)[0].replace(/(?:%5[BD]|%2[89])+$/i, '').split('/').filter(Boolean).pop() || ''
  if (/^simdoc\d+$/.test(token) && existsSync(join(simDir, 'docs', `${token}.md`))) {
    // 模拟 bot 自己建的细节文档
    cacheLog('hit', 'doc', token)
    out({ ok: true, identity: 'user', data: { document: { document_id: token, revision_id: 1, content: readFileSync(join(simDir, 'docs', `${token}.md`), 'utf8') } } })
  } else {
    const record = readRaw('docs', `${token.replace(/[^\w-]/g, '_')}.json`)
    if (!record?.ok) miss('doc', token || doc, record ? `缓存里是失败记录（${record.exitCode}）` : '文档读取失败')
    cacheLog('hit', 'doc', token, `fetchedAt=${record.fetchedAt}`)
    replayStdout(record)
  }
} else if (domain === 'base' && ['+record-list', '+record-share-link-create', '+record-get', '+record-download-attachment'].includes(command)) {
  // bug 表（tools/read-bug-record.mjs → lib/lark-bug-record.mjs 的读法）。--base-token 不校验：sim 配置里放占位即可，真 token 不进 sim 目录。
  const index = readRaw('bug-records', 'index.json')
  if (!index) miss('bug-table', String(opts['table-id'] || ''), 'bug 表缓存不存在')
  if (opts['table-id'] && opts['table-id'] !== index.tableId) miss('bug-table', String(opts['table-id']), '不是缓存的那张 bug 表')
  if (command === '+record-list') {
    if (opts['filter-json'] || opts['sort-json']) miss('bug-list', 'filter', '缓存只有全表 / 视图的 record_id 列表，不支持筛选 / 排序')
    const viewed = opts['view-id'] ? (opts['view-id'] === index.viewId ? index.viewRecordIds : null) : index.allRecordIds
    if (!viewed) miss('bug-list', String(opts['view-id']), '视图没缓存')
    const offset = Number(opts.offset || 0)
    const limit = Number(opts.limit || 100)
    const ids = viewed.slice(offset, offset + limit)
    const fields = multi['field-id'] || ['Bug编号', '问题标题']
    const cell = (rid, f) => (f === 'Bug编号' ? index.titles[rid]?.bugId ?? null : f === '问题标题' ? index.titles[rid]?.title ?? null : null)
    cacheLog('hit', 'bug-list', `${opts['view-id'] || 'all'}@${offset}`)
    out({ ok: true, identity: opts.as || 'bot', data: { data: ids.map((rid) => fields.map((f) => cell(rid, f))), fields, record_id_list: ids, has_more: offset + limit < viewed.length } })
  } else if (command === '+record-share-link-create') {
    // 分享 token 对每条记录固定：按缓存的 token → record_id 反查回放（falive 的链接缓存 + 同行 Bug 号推断），缓存里没有的记录不给链接
    const byRecord = {}
    for (const [token, v] of Object.entries(index.shareTokens || {})) byRecord[v.recordId] ||= token
    const asked = String(opts['record-ids'] || '').split(',').filter(Boolean)
    const links = Object.fromEntries(asked.filter((rid) => byRecord[rid]).map((rid) => [rid, `https://qfglxo2m3dc.sg.larksuite.com/record/${byRecord[rid]}`]))
    cacheLog('hit', 'bug-share', `${Object.keys(links).length}/${asked.length}`)
    out({ ok: true, identity: opts.as || 'bot', data: { record_share_links: links } })
  } else if (command === '+record-get') {
    const rid = String(opts['record-id'] || '')
    const record = readRaw('bug-records', `${rid.replace(/[^\w-]/g, '_')}.json`)
    if (!record?.ok) miss('bug-record', rid, '读记录失败')
    cacheLog('hit', 'bug-record', rid, `fetchedAt=${record.fetchedAt}`)
    replayStdout(record)
  } else {
    // 问题截图：一个 --file-token 且 --output 不是已有目录时就是文件本身；否则进目录、用原文件名（真 CLI 同口径）
    const rid = String(opts['record-id'] || '')
    const record = readRaw('bug-records', `${rid.replace(/[^\w-]/g, '_')}.json`)
    let names = {}
    try {
      const data = JSON.parse(record.stdout).data
      const col = data.fields.indexOf('问题截图')
      names = Object.fromEntries((data.data[0][col] || []).map((s) => [s.file_token, s.name]))
    } catch {
      names = {}
    }
    const tokens = multi['file-token'] || Object.keys(names)
    const output = resolve(process.cwd(), String(opts.output || '.'))
    const intoDir = tokens.length !== 1 || (existsSync(output) && statSync(output).isDirectory())
    const saved = []
    for (const token of tokens) {
      const src = join(rawDir, 'bug-records', 'shots', rid, token)
      if (!existsSync(src)) miss('bug-shot', `${rid}/${token}`, '截图没缓存')
      const dst = intoDir ? join(output, names[token] || token) : output
      mkdirSync(dirname(dst), { recursive: true })
      if (existsSync(dst) && !opts.overwrite) fail(`文件已存在：${dst}`)
      copyFileSync(src, dst)
      saved.push(dst)
    }
    cacheLog('hit', 'bug-shot', `${rid}×${saved.length}`)
    out({ ok: true, identity: opts.as || 'bot', data: { files: saved } })
  }
} else if (domain === 'docs' && command === '+create') {
  // 建云文档：正文落 SIM_DIR/docs/<n>.md，回一个假 url（对照时能看到 bot 想发什么细节）。
  const seq = readJson('seq.json', { n: 0 })
  seq.n += 1
  writeFileSync(join(simDir, 'seq.json'), JSON.stringify(seq))
  const docId = `simdoc${String(seq.n).padStart(5, '0')}`
  const content = String(opts.content || '').startsWith('@') ? (existsSync(join(process.cwd(), String(opts.content).slice(1))) ? readFileSync(join(process.cwd(), String(opts.content).slice(1)), 'utf8') : '') : String(opts.content || '')
  mkdirSync(join(simDir, 'docs'), { recursive: true })
  writeFileSync(join(simDir, 'docs', `${docId}.md`), `# ${opts.title || ''}\n\n${content}`)
  out({ ok: true, data: { document: { document_id: docId, url: `https://sim.local/docx/${docId}`, title: opts.title || '' } } })
} else if (domain === 'drive' && command === 'permission.public') {
  out({ ok: true, data: {} })
} else if (domain === 'im' && command === 'chats' && rest[0] === 'get') {
  const id = JSON.parse(opts.params || '{}').chat_id
  out({ ok: true, data: { chat_id: id, name: chatName(id) } })
} else {
  cacheLog('miss', 'command', positional.join(' ').slice(0, 120) || '(空)', '模拟里不支持的子命令')
  fail(`模拟里不可用：${positional.join(' ')}`)
}
