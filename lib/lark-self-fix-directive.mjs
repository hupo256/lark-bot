/**
 * 负责人私信「上线 <工单 id>」/「丢弃 <工单 id>」：自修工单的私信出口（11-04，与 `lark-bot self-fix apply|discard` 同一套）。
 * aven 11-04「lark-bot 自修为什么这么难」——对齐 falive：验收过的工单私信负责人，回「上线」就合进运行分支，排空重启自动上线。
 * 只认负责人私信、整句才算；没写 id 且只有一张验收通过的，就是那张。
 * gateway 闭包不许有子进程：这里只读工单、落请求文件（lib/lark-self-fix-store.mjs），合并 / 丢弃、回原话题由 worker 下一轮做
 *（lib/lark-self-fix-run.mjs handleRequests）。
 */

import { sendPrincipalNote } from './lark-group-exit.mjs'
import { isPrincipal } from './lark-principal-channel.mjs'
import { listTickets, selfFixDir, writeSelfFixRequest } from './lark-self-fix-store.mjs'

const DIRECTIVE_RE = /^\s*(上线|丢弃)\s*(sf-\d{8}-\w+)?\s*[。.!！]?\s*$/i

/** 纯解析：{ action: 'apply' | 'discard', id: string | null } 或 null。 */
export const parseSelfFixDirective = (text) => {
  const match = String(text || '').match(DIRECTIVE_RE)
  if (!match) return null
  return { action: match[1] === '上线' ? 'apply' : 'discard', id: match[2] || null }
}

/** 没写 id：只有一张验收通过（ready）的就是它；没有 / 多张返回 { error }。写了 id 要是 ready 才收。纯函数。 */
export const pickReadyTicket = ({ tickets = [], id = null }) => {
  const ready = tickets.filter((ticket) => ticket.status === 'ready')
  if (id) return ready.some((ticket) => ticket.id === id) ? { id } : { error: `${id} 不是等上线的工单（lark-bot self-fix list 看）。` }
  if (ready.length === 1) return { id: ready[0].id }
  if (!ready.length) return { error: '现在没有等上线的自修工单。' }
  return { error: `有 ${ready.length} 张等上线的工单，带上 id 回我：\n${ready.map((ticket) => `- ${ticket.id}：${ticket.request?.summary || ticket.fingerprint?.label || ''}`).join('\n')}` }
}

export const maybeHandleSelfFixDirective = async ({ msg, config, store, dir = selfFixDir, now = Date.now(), deps = {} }) => {
  if (msg.chatType !== 'p2p' || !isPrincipal(config, msg.senderOpenId)) return false
  const directive = parseSelfFixDirective(msg.text)
  if (!directive) return false
  const send = deps.sendPrincipalNote || sendPrincipalNote
  const reply = (text) => send({ config, store, text, kind: 'self_fix', idempotencyKey: `${msg.messageId}-sf`.slice(0, 50) })
  const picked = pickReadyTicket({ tickets: listTickets({ dir }), id: directive.id })
  if (picked.error) {
    await reply(picked.error)
    return true
  }
  writeSelfFixRequest({ dir, id: picked.id, action: directive.action, messageId: msg.messageId, now })
  console.log(`[lark-gateway] 负责人私信${directive.action === 'apply' ? '上线' : '丢弃'} ${picked.id}：已交给 worker`)
  await reply(directive.action === 'apply' ? `好，${picked.id} 这就合进运行分支，合好告诉你。` : `好，${picked.id} 这就丢弃。`)
  return true
}
