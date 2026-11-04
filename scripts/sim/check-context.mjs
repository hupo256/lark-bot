#!/usr/bin/env node
/**
 * 冒烟核对：bot 实际看到的上下文 = 原始群聊（docs/falive-replay-design-v2.md §8 P0-d 验收、§9「冒烟」）。
 *   node scripts/sim/check-context.mjs --sim <轮>/<组> [--json]        或   --round <轮>（该轮全部组）
 * 对组里每条 case，拿 sim 的 runtime/lark-tasks/<case>.json（网关建任务时的上下文包：task.text / task.attachments）
 * 和「原始群聊」逐条对：
 *   期望 = 时间线（replay/falive/dataset，群里当时真有的消息，与假 CLI 的供数逻辑无关地重算）：
 *     · 【群里这条之前的消息】：同群主消息流（话题回复不算，真列群消息拿不到）在本条之前 7 天内的真人消息 + falive bot 的话，
 *       其中 falive 对本组 case 说的（meta.hideBotIds）换成本次模拟 bot 发的（sent.json）——design-v2 §2；
 *       再按 lark-bot 自己的挑选规则（lib/lark-chat-context：最近 20 条、4 小时外只留 bot 和本人）取，渲染成同样的行。
 *     · 【话题其它回复】：同话题本条之前的回复（同样换掉组内的 falive 话）；【被引用消息】：父消息正文；【本条 @】：本条原话。
 *     · 附件：本条 / 被引用消息的附件都下到了本地。
 *   实际 = task.text 里的对应段。逐条报：期望有、实际没有（缺）；实际有、期望没有（多：如别的话题的回复、本条之后的消息、该藏没藏的 falive 原话）。
 * 有一处对不上就非 0 退出。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { applyRecentWindow, parseFetchedMessage, pickRecentContext, pickThreadContext, RECENT_CONTEXT_HOURS } from '../../lib/lark-chat-context.mjs'
import { AVEN_OPEN_ID, BOT_APP_ID, GROUPS, rawDir, replayRoot } from './falive-data.mjs'

const BOT_OPEN_ID = 'ou_e331d79d4491e64b7bba89bb4e3b5e43' // run-sim 配置的 botOpenId
const WEBHOOK_CHAT_ID = GROUPS.find((g) => g.key === 'webhook-group').chatId
const args = process.argv.slice(2)
const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const readJson = (p, fallback = null) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return fallback } }

// 合并转发等：真 CLI 的展开版正文（假 CLI 同样以它为准）
const expanded = new Map()
if (existsSync(join(rawDir, 'expanded'))) {
  for (const f of readdirSync(join(rawDir, 'expanded'))) {
    const r = readJson(join(rawDir, 'expanded', f))
    try { const msg = r?.ok && JSON.parse(r.stdout).data?.messages?.[0]; if (msg && typeof msg.content === 'string') expanded.set(msg.message_id, msg.content) } catch { /* skip */ }
  }
}
// 主消息流：真列群消息能拿到的（话题回复只有「同时发到群」的那些在里面）
const listed = new Set(GROUPS.flatMap((g) => readJson(join(rawDir, `${g.key}.api.json`), {})?.data?.items || []).map((i) => i.message_id))
const mainStream = (x) => !(x.thread_id && x.parent_id) || listed.has(x.message_id)

const asItem = (m) => ({
  message_id: m.id,
  chat_id: m.chatId,
  msg_type: m.msgType,
  content: expanded.get(m.id) ?? m.cliText ?? m.text,
  create_time: String(m.atMs),
  deleted: m.deleted,
  sender: { id: m.senderType === 'app' ? BOT_APP_ID : m.senderId, sender_type: m.senderType, name: m.senderName, ...(m.ownBot ? { open_bot_id: BOT_APP_ID } : {}) },
  ...(m.threadId ? { thread_id: m.threadId } : {}),
  ...(m.parentId ? { parent_id: m.parentId } : {}),
  _src: m.ownBot ? 'falive' : m.senderType === 'user' ? 'human' : 'other-bot',
})
const recentLine = (item) => `${item.sender || ''}${item.time ? `（${item.time}）` : ''}${item.sender || item.time ? '：' : ''}${item.text}`
const threadLine = (item) => `${item.sender ? `${item.sender}：` : ''}${item.text}`
const flat = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/@\S+/g, '').replace(/\s+/g, '')
const short = (s, n = 50) => String(s || '').replace(/\s+/g, ' ').slice(0, n)

export const checkEpisode = (simDir) => {
  const meta = readJson(join(simDir, 'meta.json'), {})
  const timeline = readJson(join(simDir, 'timeline.json'), [])
  const byId = new Map(timeline.map((m) => [m.id, m]))
  const hide = new Set(meta.hideBotIds || [])
  const sent = readJson(join(simDir, 'sent.json'), []).map((s) => ({ ...s, _src: 'sim' }))
  const tasksDir = join(simDir, 'runtime', 'lark-tasks')
  const tasks = existsSync(tasksDir) ? readdirSync(tasksDir).filter((f) => f.endsWith('.json')).map((f) => readJson(join(tasksDir, f))).filter(Boolean) : []
  const botOpenIds = [BOT_OPEN_ID, BOT_APP_ID]
  const results = []
  for (const caseId of meta.caseIds || []) {
    const m = byId.get(caseId)
    const r = { caseId, at: new Date(m.atMs).toISOString().slice(5, 16), chat: m.chatKey, sender: m.senderName, text: short(m.text, 40), problems: [], notes: [] }
    results.push(r)
    let task = tasks.find((t) => t.id === caseId)
    if (!task) {
      const host = tasks.find((t) => flat(t.text).includes(flat(m.text).slice(0, 20)))
      if (host) { r.notes.push(`没有独立任务，原话并进了任务 ${host.id}`); task = null } else { r.problems.push('没有任务，原话也不在任何任务里（没接住？）'); continue }
    }
    if (!task) continue
    const text = String(task.text || '')
    const isDm = m.chatId === WEBHOOK_CHAT_ID
    const simChat = isDm ? AVEN_OPEN_ID : m.chatId
    // —— 话题（只在有父消息时拉，同 lib/lark-conversation-bundle）
    const parent = m.parentId ? byId.get(m.parentId) || null : null
    const simParent = m.parentId && !parent ? sent.find((s) => s.message_id === m.parentId) : null
    const threadId = parent?.threadId || simParent?.thread_id || null
    let threadItems = []
    if (m.parentId && threadId) {
      const pool = [
        ...timeline.filter((x) => x.threadId === threadId && x.parentId && x.atMs <= m.atMs && !(x.ownBot && hide.has(x.id))).map(asItem),
        ...sent.filter((s) => s.thread_id === threadId && s.parent_id && Number(s.create_time) <= m.atMs),
      ].sort((a, b) => Number(a.create_time) - Number(b.create_time))
      threadItems = pickThreadContext(pool, { excludeIds: [m.id, m.parentId], botOpenIds, limit: 40 })
      const block = text.includes('【话题其它回复】') ? text.slice(text.indexOf('【话题其它回复】')).split(/\n\n【(?!话题其它回复)/)[0] : ''
      const missing = threadItems.filter((it) => !block.includes(threadLine(it)))
      for (const it of missing) r.problems.push(`话题回复缺：${short(threadLine(it), 70)}`)
      const hiddenShown = timeline.filter((x) => x.threadId === threadId && x.ownBot && hide.has(x.id) && block.includes(flat(x.text).slice(0, 15)))
      for (const x of hiddenShown) r.problems.push(`话题里出现了该藏的 falive 原话（组内 case 由模拟 bot 回）：${short(x.text, 60)}`)
      r.notes.push(`话题回复 期望 ${threadItems.length} 条，对上 ${threadItems.length - missing.length}`)
    }
    // —— 群里之前的消息
    const pool = [
      ...timeline.filter((x) => x.chatId === m.chatId && !x.deleted && x.atMs < m.atMs && x.atMs >= m.atMs - 7 * 864e5 && !(x.ownBot && hide.has(x.id))).map(asItem).filter(mainStream),
      ...sent.filter((s) => s.chat_id === simChat && Number(s.create_time) < m.atMs && mainStream(s)),
    ].sort((a, b) => Number(a.create_time) - Number(b.create_time))
    const srcOf = new Map(pool.map((x) => [x.message_id, x._src]))
    const picked = pickRecentContext(pool, { beforeMs: m.atMs, excludeIds: [m.id, m.parentId, ...threadItems.map((it) => it.messageId)], botOpenIds, limit: 20 })
    const expected = applyRecentWindow(picked, { beforeMs: m.atMs, windowMs: RECENT_CONTEXT_HOURS * 3_600_000, senderOpenId: m.senderId })
    const recentAt = text.indexOf('【群里这条之前的消息】')
    const block = recentAt >= 0 ? text.slice(recentAt) : ''
    const missing = expected.filter((it) => !block.includes(recentLine(it)))
    for (const it of missing) r.problems.push(`群里之前的消息缺（${srcOf.get(it.messageId) || '?'}）：${short(recentLine(it), 80)}`)
    // 实际多出来的：块里每一行「名字（MM-DD HH:mm）：」开头的，对不上任何期望条目
    const expectedHeads = new Set(expected.map((it) => recentLine(it).split('\n')[0]))
    const extra = block.split('\n').filter((line) => /^[^\n：]{1,60}（\d\d-\d\d \d\d:\d\d）：/.test(line) && !expectedHeads.has(line) && ![...expectedHeads].some((h) => h.startsWith(line) || line.startsWith(h)))
    for (const line of extra) r.problems.push(`群里之前的消息多：${short(line, 80)}`)
    const replaced = timeline.filter((x) => x.chatId === m.chatId && x.ownBot && hide.has(x.id) && x.atMs < m.atMs && x.atMs >= m.atMs - RECENT_CONTEXT_HOURS * 3_600_000)
    for (const x of replaced) if (block.includes(flat(x.text).slice(0, 15)) || block.includes(short(x.cliText ?? x.text, 30))) r.problems.push(`群里之前的消息里出现了该藏的 falive 原话：${short(x.text, 60)}`)
    r.notes.push(`群里之前的消息 期望 ${expected.length} 条（真人 ${expected.filter((it) => srcOf.get(it.messageId) === 'human').length}、falive 组外 ${expected.filter((it) => srcOf.get(it.messageId) === 'falive').length}、模拟 bot ${expected.filter((it) => srcOf.get(it.messageId) === 'sim').length}），对上 ${expected.length - missing.length}；falive 组内原话换成模拟 bot 的 ${replaced.length} 条`)
    // —— 被引用消息 / 本条
    if (m.parentId) {
      const p = parent ? asItem(parent) : simParent
      if (!p) r.problems.push(`父消息 ${m.parentId} 不在时间线 / 模拟发件里`)
      else {
        const refText = parseFetchedMessage(p.msg_type, p.content).text
        if (!text.includes('【被引用消息】') || (refText && !flat(text).includes(flat(refText).slice(0, 40)))) r.problems.push(`被引用消息不对：期望「${short(refText, 50)}」`)
      }
    }
    const own = flat(parseFetchedMessage(m.msgType, m.cliText ?? m.text).text)
    if (own && !flat(text).includes(own.slice(0, 20))) r.problems.push(`本条原话不在上下文里：「${short(m.text, 50)}」`)
    // —— 附件
    const atts = task.attachments || []
    const want = [['本条', m.resources || []], ['被引用消息', parent?.resources || []]]
    for (const [origin, list] of want) {
      const got = atts.filter((a) => String(a.origin || '').startsWith(origin))
      if (got.length < list.length) r.problems.push(`${origin}附件 期望 ${list.length} 份，下到 ${got.length} 份`)
      for (const a of got) if (!a.localPath || !existsSync(a.localPath)) r.problems.push(`${origin}附件文件不在：${a.localPath}`)
      if (list.length) r.notes.push(`${origin}附件 ${got.length}/${list.length}`)
    }
  }
  return results
}

const main = () => {
  const round = value('--round', null)
  const sims = value('--sim', null) ? [value('--sim', null)] : round ? readdirSync(join(replayRoot, 'sim', round), { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(replayRoot, 'sim', round, d.name, 'meta.json'))).map((d) => `${round}/${d.name}`) : []
  if (!sims.length) throw new Error('--sim <轮>/<组> 或 --round <轮>')
  let bad = 0
  const all = []
  for (const sim of sims) {
    const res = checkEpisode(join(replayRoot, 'sim', sim))
    all.push({ sim, cases: res })
    console.log(`## ${sim}`)
    for (const r of res) {
      bad += r.problems.length ? 1 : 0
      console.log(`- ${r.problems.length ? '✗' : '✓'} ${r.caseId.slice(-6)} ${r.at} ${r.chat} ${r.sender}：${r.text}`)
      for (const n of r.notes) console.log(`    · ${n}`)
      for (const p of r.problems) console.log(`    ✗ ${p}`)
    }
  }
  if (args.includes('--json')) console.log(JSON.stringify(all, null, 1))
  console.log(bad ? `\n${bad} 条 case 上下文对不上` : '\n全部对上')
  process.exit(bad ? 1 : 0)
}
main()
