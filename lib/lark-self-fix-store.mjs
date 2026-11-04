/**
 * 自修工单的纯文件读写（runtime/lark-self-fix/<id>.json）：从 lark-self-fix.mjs 拆出（11-04），不碰子进程——
 * gateway 收私信「上线 / 丢弃 <id>」时读工单、落请求文件要用（lib/lark-self-fix-directive.mjs；gateway 闭包不许有子进程）。
 * 合并 / 丢弃本身由 worker 做（lib/lark-self-fix-run.mjs handleRequests）。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { larkRuntimeDir } from './lark-paths.mjs'

export const selfFixDir = join(larkRuntimeDir, 'lark-self-fix')
const TICKET_ID_RE = /^sf-\d{8}-[\w]+$/

export const isTicketId = (id) => TICKET_ID_RE.test(String(id || ''))
const ticketFile = (dir, id) => join(dir, `${id}.json`)

export const readTicket = ({ dir = selfFixDir, id }) => {
  if (!isTicketId(id)) return null
  try {
    return JSON.parse(readFileSync(ticketFile(dir, id), 'utf8'))
  } catch {
    return null
  }
}

export const writeTicket = ({ dir = selfFixDir, ticket }) => {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = ticketFile(dir, ticket.id)
  writeFileSync(`${file}.tmp`, `${JSON.stringify(ticket, null, 2)}\n`, { mode: 0o600 })
  renameSync(`${file}.tmp`, file)
  return ticket
}

export const listTickets = ({ dir = selfFixDir } = {}) => {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readTicket({ dir, id: name.slice(0, -5) }))
    .filter(Boolean)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
}

// 状态流转都走这里：合并补丁 + 记一行 history（谁在什么时候把它改成了什么）。工单不存在返回 null。
export const updateTicket = ({ dir = selfFixDir, id, patch = {}, note = '', now = Date.now() }) => {
  const ticket = readTicket({ dir, id })
  if (!ticket) return null
  const at = new Date(now).toISOString()
  const next = { ...ticket, ...patch, updatedAt: at }
  if (patch.status && patch.status !== ticket.status) next.history = [...(ticket.history || []), { at, status: patch.status, note }]
  return writeTicket({ dir, ticket: next })
}

// ── 负责人的上线 / 丢弃请求：gateway 落 requests/<id>.json，worker 下一轮执行后删掉 ─────────────────
const requestsDir = (dir) => join(dir, 'requests')

export const writeSelfFixRequest = ({ dir = selfFixDir, id, action, messageId = null, now = Date.now() }) => {
  mkdirSync(requestsDir(dir), { recursive: true, mode: 0o700 })
  const file = join(requestsDir(dir), `${id}.json`)
  writeFileSync(`${file}.tmp`, `${JSON.stringify({ id, action, messageId, at: new Date(now).toISOString() })}\n`, { mode: 0o600 })
  renameSync(`${file}.tmp`, file)
}

export const listSelfFixRequests = ({ dir = selfFixDir } = {}) => {
  if (!existsSync(requestsDir(dir))) return []
  return readdirSync(requestsDir(dir))
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      try {
        return JSON.parse(readFileSync(join(requestsDir(dir), name), 'utf8'))
      } catch {
        return null
      }
    })
    .filter((request) => request && isTicketId(request.id) && ['apply', 'discard'].includes(request.action))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)))
}

export const clearSelfFixRequest = ({ dir = selfFixDir, id }) => rmSync(join(requestsDir(dir), `${id}.json`), { force: true })
