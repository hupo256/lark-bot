#!/usr/bin/env node
/**
 * 假 lark-cli（离线模拟器，docs/falive-replay-plan-2026-11-03.md §2 L2）：LARK_CLI_BIN 指到 scripts/sim/lark-cli（壳脚本 exec 本文件）。
 * 从 SIM_DIR 供数 / 记账：
 *   timeline.json   数据集时间线（真人消息 + 模拟开始前 falive bot 的消息）
 *   clock.json      虚拟时钟（只回「现在」以前的消息）
 *   events.ndjson   编排器按时间追加的长连接事件；`event consume im.message.receive_v1` 从 consume.offset 起 tail 输出
 *   sent.json       模拟 bot 发出的消息（send / reply），也参与列消息 / mget / 话题（后续消息的上下文）
 *   outbox.jsonl    每次发送的完整记录（对照用）
 *   cli-calls.log   每次调用的 argv（排错用）
 * 子命令：im +chat-list / +chat-messages-list / +messages-mget / +threads-messages-list / +messages-send / +messages-reply /
 * +messages-resources-download；event consume；其余回 ok:false（docs / base / search 在模拟里不可用）。
 */
import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const simDir = process.env.SIM_DIR
if (!simDir) {
  process.stdout.write(JSON.stringify({ ok: false, error: { type: 'sim', message: 'SIM_DIR 未设置' } }))
  process.exit(2)
}
const argv = process.argv.slice(2)
appendFileSync(join(simDir, 'cli-calls.log'), `${new Date().toISOString()} ${argv.map((a) => (a.length > 120 ? `${a.slice(0, 120)}…` : a)).join(' ')}\n`)

// 解析：位置参数 + --key value / --flag
const positional = []
const opts = {}
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]
  if (a.startsWith('--')) {
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next != null && !next.startsWith('--')) {
      opts[key] = next
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

const BOT_APP_ID = 'cli_c08abc1da138d00f'
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
const toListItem = (m) => ({
  message_id: m.id,
  chat_id: m.chatId,
  msg_type: m.msgType,
  content: m.text,
  create_time: String(m.atMs),
  deleted: m.deleted,
  sender: { id: m.senderType === 'app' ? BOT_APP_ID : m.senderId, id_type: m.senderType === 'app' ? 'app_id' : 'open_id', sender_type: m.senderType, name: m.senderName, ...(m.ownBot ? { open_bot_id: BOT_APP_ID } : {}) },
  mentions: m.mentions || [],
  ...(m.threadId ? { thread_id: m.threadId } : {}),
  ...(m.rootId ? { root_id: m.rootId } : {}),
  ...(m.parentId ? { parent_id: m.parentId } : {}),
})
let allMessages = null
const messages = () => {
  if (allMessages) return allMessages
  const cutoff = nowMs()
  const simStart = Number(readJson('meta.json', {}).simStartMs || 0)
  const timeline = readJson('timeline.json', [])
    // 模拟窗口内 falive bot 真实发过的消息不供数（模拟 bot 自己会说话）；窗口前的留作历史。
    .filter((m) => !(m.ownBot && m.atMs >= simStart))
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
  return m ? toListItem(m) : null
})()

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
  const parent = parentId ? byId(parentId) : null
  const item = {
    message_id: id,
    chat_id: chatId,
    msg_type: msgType,
    content: text,
    create_time: String(at),
    deleted: false,
    sender: { id: BOT_APP_ID, id_type: 'app_id', sender_type: 'app', name: 'Aven.Bot', open_bot_id: BOT_APP_ID },
    mentions: [],
    ...(parent?.thread_id ? { thread_id: parent.thread_id } : {}),
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
  const list = messages().filter((m) => m.chat_id === chatId && Number(m.create_time) >= start && Number(m.create_time) <= end)
  out({ ok: true, data: page(list, { order: opts.order || 'desc', pageSize: Number(opts['page-size'] || 50), pageToken: opts['page-token'] }) })
} else if (domain === 'im' && command === '+messages-mget') {
  const ids = String(opts['message-ids'] || '').split(',').filter(Boolean)
  out({ ok: true, data: { messages: ids.map(byIdAny).filter(Boolean) } })
} else if (domain === 'im' && command === '+threads-messages-list') {
  const anchor = byId(opts.thread)
  const threadId = anchor?.thread_id || null
  const list = threadId ? messages().filter((m) => m.thread_id === threadId) : (anchor ? messages().filter((m) => m.root_id === anchor.message_id || m.message_id === anchor.message_id) : [])
  out({ ok: true, data: page(list, { order: opts.order || 'desc', pageSize: Number(opts['page-size'] || 50), pageToken: opts['page-token'] }) })
} else if (domain === 'im' && command === '+messages-send') {
  const chatId = opts['chat-id'] || opts['user-id']
  const sent = record({ kind: 'send', chatId, userId: opts['user-id'] || null, text: contentText(), msgType: opts.markdown != null ? 'post' : opts['msg-type'] || 'text' })
  out({ ok: true, data: { message_id: sent.id, chat_id: chatId } })
} else if (domain === 'im' && command === '+messages-reply') {
  const parent = byId(opts['message-id'])
  if (!parent) fail(`回复目标不存在：${opts['message-id']}`)
  const sent = record({ kind: 'reply', chatId: parent.chat_id, parentId: parent.message_id, inThread: Boolean(opts['reply-in-thread']), text: contentText(), msgType: opts.markdown != null ? 'post' : opts['msg-type'] || 'text' })
  out({ ok: true, data: { message_id: sent.id, chat_id: parent.chat_id } })
} else if (domain === 'im' && command === '+messages-resources-download') {
  const resources = readJson('resources.json', {})
  const src = resources[`${opts['message-id']}/${opts['file-key']}`] || resources[String(opts['file-key'])]
  if (!src || !existsSync(src)) fail('存档里没有这份附件')
  copyFileSync(src, join(process.cwd(), String(opts.output)))
  out({ ok: true, data: {} })
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
  fail(`模拟里不可用：${positional.join(' ')}`)
}
