/**
 * 对接台账（事实层，aven 2026-10-14 定的新模型）：
 *   群里是一场持续的对接对话，对象是 aven 发出去的对接条目（pending/*.md 里的 A1 / O11 / R2 …）。
 *   每条消息只做一件事——判断它触及哪些条目、是什么变化（answer / ask / notify / confirm / new），记进台账；
 *   工单由条目状态变化派生（见 lark-routes），提问直接查台账 + 代码 + pre 作答。
 * 存储：runtime/lark-ledger/<repo>.json → { items: { [id]: Item }, events: Event[] }
 *   Item  = { id, doc, code, title, status: open|answered|applied|verified|noted|asked, updatedAt, lastEvent }
 *   Event = { at, messageId, chatId, sender, decision, items: [{ id, transition, note }], excerpt }
 * 条目 id 形如 `对接-live后端-3#2`（文档名#编号）；群里冒出来没对应条目的事记为 `new#<短码>`。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'

import { writeJsonAtomic } from './lark-fs.mjs'
import { isAbsolute, join } from 'node:path'

import { larkRuntimeDir } from './lark-paths.mjs'

export const TRANSITIONS = ['answer', 'ask', 'notify', 'confirm', 'new']
const STATUS_AFTER = { answer: 'answered', ask: 'asked', notify: 'noted', confirm: 'verified', new: 'open' }
const order = { answered: 0, asked: 1, waiting: 1, open: 2, noted: 3, applied: 4, verified: 5 }

const ledgerPath = (repoKey, dir) => join(dir || join(larkRuntimeDir, 'lark-ledger'), `${repoKey}.json`)

export const loadLedger = (repoKey, { dir = null } = {}) => {
  const file = ledgerPath(repoKey, dir)
  try {
    const parsed = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
    return { items: parsed?.items || {}, events: parsed?.events || [] }
  } catch {
    return { items: {}, events: [] }
  }
}

export const saveLedger = (repoKey, ledger, { dir = null } = {}) => {
  const file = ledgerPath(repoKey, dir)
  writeJsonAtomic(file, ledger, { trailingNewline: true })
}

// pending/*.md → 条目：认 `### 1. 标题` / `### A5 标题` 小标题，和 `| O11 | 标题 |` 表格首列编号行。
export const parsePendingItems = (name, text) => {
  const doc = name.replace(/\.md$/i, '')
  const items = []
  for (const raw of String(text || '').split('\n')) {
    const heading = raw.match(/^#{2,4}\s+([A-Z]{1,2}-?\d{1,3}(?:-\d)?|\d{1,2})[.、．]?\s+(.{2,80})$/)
    if (heading) { items.push({ id: `${doc}#${heading[1]}`, doc, code: heading[1], title: heading[2].replace(/\s+/g, ' ').trim().slice(0, 80) }); continue }
    const row = raw.match(/^\|\s*([A-Z]{1,2}-?\d{1,3}(?:-\d)?)\s*\|\s*([^|]{2,80})\|/)
    if (row) items.push({ id: `${doc}#${row[1]}`, doc, code: row[1], title: row[2].replace(/\*\*/g, '').trim().slice(0, 80) })
  }
  return items
}

export const pendingDirOf = (profile) => {
  const raw = profile?.docIntakeDir
  if (!raw) return null
  return isAbsolute(raw) ? raw : join(profile.root || '', raw)
}

// 把 pending 文档里的条目同步进台账（新条目 open；已有条目只更新标题，不动状态与历史）。
export const syncLedgerFromPending = (profile, ledger, { readDir = readdirSync, readFile = (path) => readFileSync(path, 'utf8') } = {}) => {
  const dir = pendingDirOf(profile)
  if (!dir || !existsSync(dir)) return { added: 0 }
  let names = []
  try {
    const pattern = profile?.ledgerDocPattern ? new RegExp(profile.ledgerDocPattern) : null
    names = readDir(dir).filter((name) => /\.md$/i.test(name) && !/^readme/i.test(name) && (!pattern || pattern.test(name)))
  } catch {
    return { added: 0 }
  }
  let added = 0
  const now = new Date().toISOString()
  // 不再收录的文档：没发生过事件的 open 条目直接清掉（有事件的留，别丢历史）。
  const keepDocs = new Set(names.map((name) => name.replace(/\.md$/i, '')))
  for (const [id, item] of Object.entries(ledger.items)) {
    if (item.doc && !keepDocs.has(item.doc) && item.status === 'open' && !item.lastEvent && !item.standing) delete ledger.items[id]
  }
  for (const name of names) {
    let text = ''
    try { text = readFile(join(dir, name)) } catch { continue }
    for (const item of parsePendingItems(name, text)) {
      const existing = ledger.items[item.id]
      if (existing) { existing.title = item.title; continue }
      ledger.items[item.id] = { ...item, status: 'open', updatedAt: now, lastEvent: null }
      added += 1
    }
  }
  return { added }
}

const shortCode = (seed) => String(seed || Date.now()).replace(/[^a-z0-9]/gi, '').slice(-6).toLowerCase()

// 记一条消息事件：触及的条目各自改状态；没对应条目的（id 以 new 开头或台账里没有）建新条目。返回触及的条目 id 列表。
export const recordLedgerEvent = (ledger, { messageId, chatId, sender = '', at = new Date().toISOString(), decision, items = [], excerpt = '' }) => {
  const touched = []
  for (const raw of items || []) {
    if (!raw || typeof raw !== 'object') continue
    const transition = TRANSITIONS.includes(raw.transition) ? raw.transition : 'notify'
    let id = String(raw.id || '').trim()
    if (!id || id.startsWith('new') || !ledger.items[id]) {
      if (id && ledger.items[id]) { /* 已存在 */ } else {
        id = `new#${shortCode(messageId)}${touched.length ? `-${touched.length}` : ''}`
        ledger.items[id] = { id, doc: null, code: null, title: String(raw.note || excerpt || '群里新提出的事').slice(0, 80), status: 'open', updatedAt: at, lastEvent: null }
      }
    }
    const item = ledger.items[id]
    if (!(item.standing && transition === 'notify')) item.status = STATUS_AFTER[transition] || item.status
    item.updatedAt = at
    item.lastEvent = { at, messageId, transition, sender, note: String(raw.note || '').slice(0, 200) }
    touched.push(id)
  }
  ledger.events.push({ at, messageId, chatId, sender, decision, items: touched.map((id) => ({ id, transition: ledger.items[id].lastEvent?.transition })), excerpt: String(excerpt || '').slice(0, 200) })
  if (ledger.events.length > 2000) ledger.events.splice(0, ledger.events.length - 2000)
  return touched
}

// 清理无界增长：群里冒出来的 `new#` 条目（没有对应 pending 文档）14 天没再动、没挂待命指令、也没推进到 applied / verified 的删掉；
// events 已在 recordLedgerEvent 里截到 2000 条。返回删掉的 id。
export const pruneLedger = (ledger, { now = Date.now(), maxIdleMs = 14 * 24 * 60 * 60_000 } = {}) => {
  const removed = []
  for (const [id, item] of Object.entries(ledger.items || {})) {
    if (!id.startsWith('new#') || item.standing) continue
    if (['applied', 'verified'].includes(item.status)) continue
    const updated = Date.parse(item.updatedAt || '') || 0
    if (now - updated < maxIdleMs) continue
    delete ledger.items[id]
    removed.push(id)
  }
  return removed
}

// 给分类器 / 代答 / 日报看的台账摘要：每条目一行「id｜标题｜状态｜最近事件」。open 的在前。
export const ledgerSummary = (ledger, { max = 50, titleLen = 40 } = {}) => {
  const rows = Object.values(ledger.items)
    .sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, max)
  return rows.map((item) => `- ${item.id}｜${String(item.title).slice(0, titleLen)}｜${item.status}${item.standing ? `｜等：${item.standing.waitsFor || '材料'}（到了就开工）` : ''}${item.lastEvent ? `｜最近：${item.lastEvent.transition} by ${item.lastEvent.sender || '?'} ${String(item.lastEvent.at).slice(5, 16)}${item.lastEvent.note ? ` ${item.lastEvent.note.slice(0, 60)}` : ''}` : ''}`).join('\n')
}

// 待命指令（闭环的关键）：负责人交办时说「等 X 到了再做」→ 把原始指令挂在触及的条目上；
// 之后任何消息把 X 带来了（文档 / 域名 / 说可以了），就取出这条指令直接派工单，不再重新理解一遍。
export const setStandingInstruction = (ledger, ids, { taskId, text, waitsFor, by = '', at = new Date().toISOString() }) => {
  for (const id of ids || []) {
    const item = ledger.items[id]
    if (!item) continue
    item.standing = { taskId, text: String(text || '').slice(0, 4000), waitsFor: String(waitsFor || '').slice(0, 120), by, at }
    item.status = 'waiting'
    item.updatedAt = at
  }
}
export const takeStandingInstructions = (ledger, ids) => {
  const out = []
  for (const id of ids || []) {
    const item = ledger.items[id]
    if (!item?.standing) continue
    out.push({ itemId: id, ...item.standing })
    delete item.standing
    item.status = 'answered'
  }
  return out
}

// 工单键：触及的条目 id 排序拼接；没条目就用消息 id（一条消息一张工单）。
export const workKeyFor = ({ items = [], messageId }) => {
  const ids = [...new Set((items || []).map((item) => String(item?.id || '').trim()).filter(Boolean))].sort()
  return ids.length ? ids.join('+') : `msg:${messageId}`
}

// 条目状态推进（工单做完 → applied；实测通过 → verified）。
export const markLedgerItems = (ledger, ids, status, note = '') => {
  const at = new Date().toISOString()
  for (const id of ids || []) {
    const item = ledger.items[id]
    if (!item) continue
    item.status = status
    item.updatedAt = at
    item.lastEvent = { at, messageId: null, transition: status, sender: 'bot', note: String(note).slice(0, 200) }
  }
}
