/**
 * 发件簿：bot 往群里说过的每句话。webhook 卡片没有 message_id，不记下来 bot 就不知道自己对谁、就哪个主题、在哪个阶段
 * 说过什么——阶段 4 的锚定（「重跑一次」接的是 bot 上一张卡）与阶段 5 的出口闸（同主题同阶段不重复发）都靠它。
 * 落盘 runtime/lark-outbox/<chatId>.jsonl，一行一条；保留 7 天，每个进程首次写入时清理一次。
 */
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { larkRuntimeDir } from './lark-paths.mjs'

export const outboxDir = join(larkRuntimeDir, 'lark-outbox')
// 默认目录在调用时解析：LARK_OUTBOX_DIR 可覆盖（测试指到临时目录）；node --test 子进程里没指定就不落盘，
// 免得 delivery / group-reply / daily-report 的单测把假群的记录写进真实 runtime。
const resolveDir = (dir) => {
  if (dir) return dir
  if (process.env.LARK_OUTBOX_DIR) return process.env.LARK_OUTBOX_DIR
  if (process.env.NODE_TEST_CONTEXT) return null
  return outboxDir
}
const KEEP_MS = 7 * 24 * 60 * 60_000
const pruned = new Set()

export const hashText = (text) => createHash('sha1').update(String(text || '').trim()).digest('hex').slice(0, 12)

const fileFor = (dir, chatId) => join(dir, `${String(chatId).replace(/[^\w.-]/g, '_')}.jsonl`)

const readEntries = (file) => {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
}

// 清理 keepMs 之前的条目（整文件重写）；每个进程每个目录只做一次，避免每条消息都扫盘。
export const pruneOutbox = ({ dir = outboxDir, now = Date.now(), keepMs = KEEP_MS } = {}) => {
  if (!existsSync(dir)) return 0
  let removed = 0
  for (const name of readdirSync(dir).filter((item) => item.endsWith('.jsonl'))) {
    const file = join(dir, name)
    const entries = readEntries(file)
    const kept = entries.filter((entry) => now - Date.parse(entry.at || '') < keepMs)
    if (kept.length !== entries.length) {
      writeFileSync(file, kept.map((entry) => JSON.stringify(entry)).join('\n') + (kept.length ? '\n' : ''))
      removed += entries.length - kept.length
    }
  }
  return removed
}

// 记一条群发：phase = ack / noted / done / fallback / blocked_ask / summary / daily_report；to = 对着谁说（open_id），
// mentions = 还 @ 了谁；text 存前 2000 字；hash 供去重。只在真的发出去（ok）之后调用。
export const recordOutbox = ({ chatId, taskId = null, topic = null, phase, to = null, mentions = [], text, dir: dirOverride = null, now = Date.now() }) => {
  const dir = resolveDir(dirOverride)
  if (!chatId || !phase || !dir) return null
  if (!pruned.has(dir)) {
    pruned.add(dir)
    try { pruneOutbox({ dir, now }) } catch { /* 清理失败不影响记账 */ }
  }
  mkdirSync(dir, { recursive: true })
  const entry = {
    at: new Date(now).toISOString(),
    chatId,
    taskId,
    topic,
    phase,
    to,
    mentions: mentions.filter(Boolean),
    text: String(text || '').slice(0, 2000),
    hash: hashText(text),
  }
  appendFileSync(fileFor(dir, chatId), `${JSON.stringify(entry)}\n`)
  return entry
}

export const listOutbox = ({ chatId, sinceMs = 0, dir: dirOverride = null } = {}) => {
  const dir = resolveDir(dirOverride)
  return dir ? readEntries(fileFor(dir, chatId)).filter((entry) => Date.parse(entry.at || '') >= sinceMs) : []
}

// bot 最近一次对某人说的话（阶段 4 锚定：同一个人 15 分钟内的短指代句默认接它）。
export const lastOutboxTo = ({ chatId, to, sinceMs = 0, dir = null }) => {
  const entries = listOutbox({ chatId, sinceMs, dir }).filter((entry) => entry.to === to || (entry.mentions || []).includes(to))
  return entries.length ? entries[entries.length - 1] : null
}
