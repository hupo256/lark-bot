/**
 * 每条 case 的「当时上下文」：原话全文、父消息、falive 当时干了什么（分类、台账、审计、群里的实质回复）。
 * tag-cases.mjs（风险标签）与 verification-evidence.mjs（实测类证据）共用；只读，不写任何东西。
 * 审计只到 10-27（lark-bot-falive/runtime/lark-audits/FALIVE 最早一份 10-27 12:32），之前的 case 只能看群里回复。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { casesDir, datasetDir, faliveLogDir, faliveRuntimeDir } from './falive-data.mjs'

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
export const one = (t, n) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, n)
// 去掉卡片外壳、署名、@、图片 / 文件占位，剩下的是「这句话本身说了什么」。
export const strip = (t) => String(t || '')
  .replace(/<\/?card[^>]*>/g, '').replace(/📝.*$/gm, '').replace(/<\/?p>/g, '')
  .replace(/<at [^>]*>[^<]*<\/at>/g, '').replace(/@[^\s@，。,:：]+/g, '')
  .replace(/!\[Image\]\([^)]*\)|\[Image: [^\]]*\]|<file [^>]*\/>/g, '')
  .replace(/\bcc\b/gi, '').replace(/\s+/g, ' ').trim()
// falive 的「收到，我查一下」一类先回的 ack：短、没有结论标记。
const ACK_RE = /收到|好的|我查一下|稍后回复|我看一下|这就去|马上|测完|看完|查完|改完|整理好|我去/
export const isAck = (text) => {
  const s = strip(text)
  return s.length < 90 && ACK_RE.test(s) && !/[✅❌⚠️]|通了|没通|结论/.test(s)
}

// 审计 task.text 里本条自己的话：有「【本条 @】」取那一段，否则取第一个上下文块（【…】）之前的部分。
const taskBody = (text) => {
  const t = String(text || '')
  const i = t.indexOf('【本条')
  return (i >= 0 ? t.slice(i).replace(/^【本条[^】]*】/, '') : t).split(/\n\s*【/)[0]
}
// 比相似度用的词：英文 / 路径 / 数字串（≥ 3 字符）、Bug 号、中文二字组。
const tokens = (text) => {
  const s = strip(text)
  const out = new Set((s.match(/[A-Za-z0-9_./-]{3,}/g) || []).map((w) => w.toLowerCase()))
  for (const run of s.match(/[\u4e00-\u9fff]{2,}/g) || []) for (let i = 0; i + 2 <= run.length; i += 1) out.add(run.slice(i, i + 2))
  return out
}

export const loadCaseContext = () => {
  const timeline = readJson(join(datasetDir, 'timeline.json'))
  const byId = new Map(timeline.map((m) => [m.id, m]))
  const episodes = new Map(readJson(join(datasetDir, 'episodes.json')).map((e) => [e.id, e]))
  const cases = readFileSync(join(casesDir, 'cases.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))

  // 审计：全部代（同一任务多代时都留着，证据可能在前一代），按任务 id 与 task.text 索引。
  const auditDir = join(faliveRuntimeDir, 'lark-audits', 'FALIVE')
  const audits = []
  for (const file of readdirSync(auditDir)) {
    if (!file.endsWith('.json')) continue
    let a
    try { a = readJson(join(auditDir, file)) } catch { continue }
    audits.push({ file: join(auditDir, file), taskId: a.taskId || file.replace(/-e\d+\.json$/, ''), epoch: a.epoch ?? null, startedMs: Date.parse(a.startedAt || '') || 0, workKind: a.workKind || null, status: a.final?.status || a.status || null, taskText: a.task?.text || '', taskSummary: a.task?.summary || '', finalSummary: a.final?.summary || a.gateway?.result || '', checks: a.final?.checks || [], analysis: a.analysis?.summary || '' })
  }
  const auditsByTask = new Map()
  for (const a of audits) (auditsByTask.get(a.taskId) || auditsByTask.set(a.taskId, []).get(a.taskId)).push(a)

  // 网关日志里「X 并入任务 Y」：并进别的任务的 case，证据在 Y 的审计里。
  const mergedInto = new Map()
  try {
    for (const line of readFileSync(join(faliveLogDir, 'gateway.log'), 'utf8').split('\n')) {
      const m = line.match(/(om_x[0-9a-f]+) 并入任务 (om_x[0-9a-f]+)/)
      if (m && !mergedInto.has(m[1])) mergedInto.set(m[1], m[2])
    }
  } catch {
    // 没有日志就只按 id / 原文关联
  }

  const contextOf = (c) => {
    const m = byId.get(c.id)
    const parent = m?.parentId ? byId.get(m.parentId) || null : null
    const ep = episodes.get(c.id) || null
    const b = ep?.baseline || {}
    // falive 群里的回复：bot 发的都是新消息（没有 parent_id），只能按「同群、之后 6 小时内、@了发话人（或同话题）」找；
    // 控制台群（principal_dm）bot 话多，只看 30 分钟。同一个人接连发好几条时，按和原话（+ 父消息）的词重合度挑最像的。
    const windowMs = m.chatKey === 'webhook-group' ? 30 * 60_000 : 6 * 3600_000
    const replies = timeline.filter((r) => r.ownBot && r.chatKey === m.chatKey && r.atMs >= m.atMs && r.atMs <= m.atMs + windowMs
      && ((m.threadId && r.threadId === m.threadId) || String(r.text).includes(`@${m.senderName}`) || m.chatKey === 'webhook-group'))
      .slice(0, 12)
    const want = tokens(`${m.text}\n${parent ? parent.text : ''}`)
    const score = (r) => { const got = tokens(r.text); let n = 0; for (const w of want) if (got.has(w)) n += 1; return want.size ? n / want.size : 0 }
    const nextSame = timeline.find((y) => y.id !== m.id && !y.ownBot && y.chatKey === m.chatKey && y.senderId === m.senderId && y.atMs > m.atMs && y.atMs <= m.atMs + windowMs)
    const scored = replies.filter((r) => !isAck(r.text) && !/^\s*(<card[^>]*>\s*)?🛠 开始做/.test(r.text))
      .map((r) => ({ r, s: score(r) + (nextSame && r.atMs > nextSame.atMs ? -0.1 : 0), beforeNext: !nextSame || r.atMs < nextSame.atMs }))
      .sort((a, b) => b.s - a.s || a.r.atMs - b.r.atMs)
    const substantive = scored.map((x) => x.r)
    // principal_dm 是在回控制台里 bot 刚发的卡片：取前 60 分钟里 bot 的最后两条。
    const before = m.chatKey === 'webhook-group' ? timeline.filter((r) => r.ownBot && r.chatKey === m.chatKey && r.atMs < m.atMs && r.atMs > m.atMs - 3600_000).slice(-2) : []
    const taskIds = new Set([c.id])
    if (mergedInto.has(c.id)) taskIds.add(mergedInto.get(c.id))
    for (const id of String(m.text).match(/(?:继续任务|结单)\s+(om_x[0-9a-f]+)/g) || []) taskIds.add(id.split(/\s+/).pop())
    const linked = [...taskIds].flatMap((id) => auditsByTask.get(id) || [])
    // 并入 / 续跑没留日志的：审计 task.text 的「本条」正文（不含被引用消息、群里之前的消息等上下文块）带着这句原话（≥ 10 字），且在它之后 24 小时内开始。
    const own = strip(m.text)
    if (own.length >= 10) for (const a of audits) if (!linked.includes(a) && strip(taskBody(a.taskText)).includes(own.slice(0, 40)) && a.startedMs >= m.atMs - 60_000 && a.startedMs <= m.atMs + 24 * 3600_000) linked.push(a)
    return { c, m, parent, ep, baseline: b, replies, substantive, scored, before, audits: linked, mergedInto: mergedInto.get(c.id) || null }
  }
  return { timeline, byId, episodes, cases, audits, contextOf }
}
