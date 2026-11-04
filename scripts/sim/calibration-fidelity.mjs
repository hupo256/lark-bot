#!/usr/bin/env node
/**
 * 校准保真度（design-v2 §8 P1 续）：calibration/<组>.json 的「falive 当时」一侧大半是空的（审计只从 10-27 起、发件簿当时多走 webhook 不记 taskId），
 * 这里换更全的来源把 falive 那一侧逐 case 补齐，再和「falive 代码在模拟器里」逐项比，给每处差异归因、出保真度结论。
 *   node scripts/sim/calibration-fidelity.mjs [--gist] [--max-gist 60]   → replay/falive/calibration/fidelity.json + fidelity-cases.md
 * 两边同一个口径（同一套 falive 代码、同一种日志），能对称的都对称取：
 *   · 群里 / 私信说了什么：falive 取时间线里自家 bot 的消息（text 是人看到的样子），模拟取 outbox.jsonl；按同一个归属函数 attributeMessages 归到触发消息上
 *     （模拟群里的另有发件簿 taskId 当真值，用来量归属函数的准确率）。时间上 falive 只取到模拟收尾时刻（clock.json），之后的不比。
 *   · 分类 / 路径 / 终态：两边都从网关日志（falive 当时 ~/Library/Logs/falive-lark/gateway.log；模拟 sim/<组>/gateway.log）按 id 取行，routeState 推终态；
 *     falive 审计（10-27 起才有）、模拟 lark-tasks 只作参考列。
 *   · 看到的上下文：两边 worker.log 的「claimed <id> via claude: <正文>」（领单正文含上下文块）；只比人说的行（bot 的话本就因上游抽样不同）。
 *   · 结论大意（--gist）：问模型（claude-q，opus effort low，结果缓存到 fidelity-gist.jsonl）。第一轮按归属两两比（11-04 跑过 33 次，缓存里留着）；
 *     第一轮不是 same 的再跑第二轮：把 falive 那段时间的全部消息给模型自己找对这条的回复（不靠启发式归属），有第二轮用第二轮。
 * 归因：差异先按规则粗分，再由 fidelity-labels.json（人工逐条看过的结论）覆盖；类别见 CATEGORY。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { GROUPS, casesDir, datasetDir, faliveLogDir, loadAudits, loadGatewayBaseline, loadWorkerClaimedTexts, parseClaimedTexts, parseGatewayLog, replayRoot } from './falive-data.mjs'
import { isAck } from './case-context.mjs'

export const CONSOLE_CHAT = GROUPS.find((g) => g.key === 'webhook-group').chatId
const CHAT_NAMES = [...GROUPS.filter((g) => g.key !== 'webhook-group').map((g) => [g.name, g.chatId]), ['falive 控制台', CONSOLE_CHAT], ['【专项】Falive融合技术讨论群', null]]
export const CATEGORY = {
  sim: '模拟偏差（能修）',
  sampling: '模型抽样（同输入不同输出）',
  limit: '还原不了（模拟局限）',
  unknown: '说不清',
}

// 不属于任何一单的私信广播（同 episodes.mjs 的 DM_BROADCAST_RE，另加日报核对 / 磁盘代码告警）
const BROADCAST_RE = /^<card(?: title="[^"]*")?>\s*(?:\[bugpoll\]|日报|🩺|pre 已部署|✅ pre 复测 [0-9a-f]{7,8}：|⏰|⚠ lark-bot|\*\*Falive Web|\*\*状态\*\*)|^<card title=/
const body = (text) => String(text || '').replace(/^<card[^>]*>\s*/, '')
const START_RE = /^(?:❓|🛠)/
const END_RE = /^(?:✅|ℹ️|⏸|⛔|❌|🤔)/
const RECEIPT_RE = /^(?:收到，当作|这句没对上|找不到任务|任务 \S+ 在，但|已按原文回群|只收到附件)/
const OM_RE = /om_x[0-9a-f]{20,}/g

const chatOfCard = (text) => {
  const head = body(text).split('\n')[0]
  for (const [name, chatId] of CHAT_NAMES) if (head.includes(`（${name}）`)) return { name, chatId }
  return null
}

/**
 * 把 bot 发的消息归到触发消息（case / 别的 @bot）上。纯函数，两边共用。
 *   triggers: [{ id, chatId, atMs, senderName, dm }]（dm = 负责人在控制台说的）；msgs: [{ id, chatId, atMs, text }]（按时间）。
 * 群里：同群、之前 6 小时内的触发；@ 了谁优先归那人的；「收到 / 我查一下」类 ack 归最近一条还没 ack 的，实质回复归最早一条已 ack 未答的。
 * 私信：点名任务 id 的归它；回执（收到，当作 / 这句没对上 / 已按原文回群）归 10 分钟内最近一条控制台触发；
 *   「❓ / 🛠」开始卡按（群名）归该群最近一条还没开始的，「✅ ℹ️ ⏸ ⛔」结果卡归该群最早一条已开始未结的；剩下的归 2 小时内最近开始过的。
 * 返回 Map<消息 id, 触发 id>；归不上的不在里面。
 */
// 词：英文 / 路径 / 数字串（≥ 3 字符）、中文二字组；相似度取余弦（两边长短差很多也不至于一边倒）
const tokens = (text) => {
  const t = String(text || '').replace(/<\/?card[^>]*>|📝.*$|@\S+/gm, ' ')
  const out = new Set((t.match(/[A-Za-z0-9_./-]{3,}/g) || []).map((w) => w.toLowerCase()))
  for (const run of t.match(/[\u4e00-\u9fff]{2,}/g) || []) for (let i = 0; i + 2 <= run.length; i += 1) out.add(run.slice(i, i + 2))
  return out
}
const similarity = (a, b) => { if (!a.size || !b.size) return 0; let n = 0; for (const w of a) if (b.has(w)) n += 1; return n / Math.sqrt(a.size * b.size) }

export const attributeMessages = ({ triggers, msgs, consoleChat = CONSOLE_CHAT }) => {
  const ids = new Set(triggers.map((t) => t.id))
  const st = new Map(triggers.map((t) => [t.id, { ack: false, sub: false, start: false, end: false }]))
  const tok = new Map(triggers.map((t) => [t.id, tokens(`${t.text || ''}\n${t.parentText || ''}`)]))
  const out = new Map()
  const before = (m, pred, windowMs) => triggers.filter((t) => t.atMs <= m.atMs && m.atMs - t.atMs <= windowMs && pred(t))
  // 先按状态挑（ack 给还没 ack 的最近一条，实质回复给已 ack 未答的最早一条）；同一批里有明显更像的（相似度 ≥ 0.12 且高出 0.05）就给更像的
  const pick = (pool, byRule, mtok) => {
    const scored = pool.map((t) => ({ t, s: similarity(mtok, tok.get(t.id)) }))
    const best = scored.reduce((a, b) => (b.s > a.s ? b : a), { t: null, s: 0 })
    const ruleScore = scored.find((x) => x.t === byRule)?.s || 0
    if (best.t && best.s >= 0.12 && best.s > ruleScore + 0.05) return best.t
    return byRule
  }
  for (const m of [...msgs].sort((a, b) => a.atMs - b.atMs)) {
    const text = String(m.text || '')
    if (BROADCAST_RE.test(text)) continue
    const named = (text.match(OM_RE) || []).find((id) => ids.has(id))
    let owner = null
    if (m.chatId !== consoleChat) {
      const pool = before(m, (t) => t.chatId === m.chatId && !t.dm, 6 * 3600_000)
      const atted = pool.filter((t) => t.senderName && text.includes(`@${t.senderName}`))
      const cand = atted.length ? atted : pool
      const mtok = tokens(text)
      const fresh = cand.filter((t) => !st.get(t.id).ack && !st.get(t.id).sub)
      const waiting = cand.filter((t) => st.get(t.id).ack && !st.get(t.id).sub)
      if (named) owner = named
      else if (isAck(text)) owner = pick(fresh.length ? fresh : cand, fresh.at(-1) || cand.at(-1), mtok)?.id || null
      else owner = pick([...waiting, ...fresh.slice(-1)], waiting[0] || fresh.at(-1) || cand.at(-1), mtok)?.id || null
      if (owner) { const s = st.get(owner); if (isAck(text) && !s.sub) s.ack = true; else s.sub = true }
    } else {
      const b = body(text)
      const chat = chatOfCard(text)
      const inChat = (t) => (chat?.chatId === consoleChat ? t.dm : chat?.chatId ? t.chatId === chat.chatId && !t.dm : true)
      if (named) owner = named
      else if (RECEIPT_RE.test(b)) owner = before(m, (t) => t.dm, 10 * 60_000).at(-1)?.id || null
      else if (START_RE.test(b)) { const pool = before(m, inChat, 6 * 3600_000); owner = (pool.filter((t) => !st.get(t.id).start).at(-1) || pool.at(-1))?.id || null }
      else if (END_RE.test(b)) { const pool = before(m, inChat, 12 * 3600_000); owner = (pool.find((t) => st.get(t.id).start && !st.get(t.id).end) || pool.at(-1))?.id || null }
      else owner = before(m, (t) => st.get(t.id).start, 2 * 3600_000).at(-1)?.id || before(m, () => true, 30 * 60_000).at(-1)?.id || null
      if (owner) { const s = st.get(owner); if (START_RE.test(b) || named) s.start = true; if (END_RE.test(b)) s.end = true }
    }
    if (owner) out.set(m.id, owner)
  }
  return out
}

/**
 * 网关日志里提到这条 id 的行 → 路径与终态（两边同一套 falive 代码，行的说法一样）。纯函数。
 *   state：有「repo outcome <id> <状态>」取最后一个；否则 并入 / 终端结单 / 挂待确认（疑似且没开始）/ 只记下 / 开始了没出结果 / 收到没动作。
 */
export const routeState = (lines, id) => {
  const L = lines || []
  const has = (re) => L.some((l) => re.test(l))
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const outcomes = L.map((l) => new RegExp(`repo outcome ${esc} (\\w+)`).exec(l)?.[1]).filter(Boolean)
  const classified = L.map((l) => new RegExp(`task-mention ${esc} (?:classified=)?(\\w+)/(\\w+)`).exec(l)).find(Boolean)
  const path = {
    received: has(new RegExp(`received task-mention ${esc}`)),
    ack: has(new RegExp(`repo ack ${esc} ok|${esc} 回「收到」`)),
    suspected: has(new RegExp(`repo suspected ${esc}|${esc} classified=\\S+ forMe=null`)),
    started: has(new RegExp(`repo start ${esc}`)),
    resumed: has(new RegExp(`resumed task ${esc}|续跑 ${esc}`)),
    merged: has(new RegExp(`${esc} 并入|工单并入：${esc}|话题补充：${esc}`)),
    anchored: has(new RegExp(`锚定：${esc} 接着|指示任务 ${esc}`)),
    unanchored: has(new RegExp(`控制台消息 ${esc} 锚不到`)),
    closed: has(new RegExp(`(?:终端|人工)结单.*${esc}`)),
    noted: has(new RegExp(`${esc} classified=ignore|${esc} \\S+ 前端不用动，只记台账结单|repo noted ${esc}`)),
    gated: has(new RegExp(`出口闸拦下 repo \\S+ ${esc}`)),
    dmResume: has(/^负责人私聊（\w+）→ 续跑 /),
    dmRelease: has(/^负责人私聊（\w+）→ 放行 /),
  }
  let state
  if (outcomes.length) state = outcomes.at(-1)
  else if (path.merged) state = 'merged'
  else if (path.closed) state = 'closed'
  else if (path.suspected && !path.started) state = 'waiting_confirmation'
  else if (path.noted) state = 'noted'
  else if (path.unanchored) state = 'unanchored'
  else if (path.started) state = 'started'
  else if (path.dmRelease) state = 'released'
  else if (path.dmResume) state = 'resumed'
  else if (path.received) state = 'no_action'
  else state = L.length ? 'other' : 'none' // 整段日志里一行都没提到它 = 当时没当任务接（日志覆盖 10-20 起，校准组都在之后）
  return { state, decision: classified ? classified[1] : null, confidence: classified ? classified[2] : null, path }
}

// 不带本条 id 的两种行，按原话对回 case（同句按时间顺序取最早没用过的，同 episodes.mjs）：
//   「负责人私聊（recent）→ 续跑 <任务>：<原话>」「…→ 放行 <任务> 扣下的群回复：<原话>」——只对私聊 case，原样记下；
//   「resumed task <任务> with supplement（第 n 次续跑）: <原话>」——紧跟在私聊行后面的是同一件事，跳过；否则是群里的话并进了挂起任务
//   （「同话题归并：本条 @ 并入挂起任务 X」那行也不带本条 id），记成「<本条> 并入 <任务>」。
const normText = (t) => String(t || '').replace(/@Aven\.(Test|Bot)/g, '').replace(/\s+/g, '').trim()
export const matchTextLines = ({ logText, cases }) => {
  const out = new Map()
  const used = new Set()
  const add = (id, line) => out.set(id, [...(out.get(id) || []), line])
  const find = (pool, text) => {
    const t = normText(text)
    if (t.length < 2) return null
    const hit = pool.find((c) => !used.has(c.id) && (normText(c.text).startsWith(t) || (t.length >= 6 && normText(c.text).includes(t))))
    if (hit) used.add(hit.id)
    return hit
  }
  const dm = cases.filter((c) => c.kind === 'principal_dm')
  const group = cases.filter((c) => c.kind !== 'principal_dm')
  let lastDmText = null
  for (const raw of String(logText || '').split('\n')) {
    const line = raw.replace(/^\[lark-gateway\]\s*/, '')
    let m = /^负责人私聊（\w+）→ (?:续跑 \S+|放行 \S+ 扣下的群回复)：(.*)$/.exec(line)
    if (m) { lastDmText = normText(m[1]); const hit = find(dm, m[1]); if (hit) add(hit.id, line); continue }
    m = /^resumed task (\S+) with supplement（第 \d+ 次续跑）: (.*)$/.exec(line)
    if (m) {
      if (lastDmText && normText(m[2]) === lastDmText) { lastDmText = null; continue }
      const hit = find(group, m[2])
      if (hit && hit.id !== m[1]) add(hit.id, `${hit.id} 并入 ${m[1]}（${line.slice(0, 80)}）`)
    }
    if (!/^(chat-poller|台账)/.test(line)) lastDmText = null
  }
  return out
}

// 只比人说的上下文行：bot 的话（多行卡片整条）、「正在进行的事」块（台账 / bot 对他说过什么，都是上游 bot 输出的派生）不比——
// 两边 bot 的话本来就因抽样不同，比它们只是把上游差异再数一遍。剩下：本条、群里之前人说的、话题里人说的、被引用的人话。
const SPEAKER_RE = /^(.+?)（(?:bot，我们自己）（)?\d\d-\d\d \d\d:\d\d）：/
const humanLines = (text) => {
  const out = new Set()
  let block = ''
  let botSpeaking = false
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\(ou_\w+\)/g, '').trim()
    if (!line) continue
    const head = /^【([^】]*)】/.exec(line)
    if (head) { block = head[1]; botSpeaking = /^被引用消息】?（Aven\.(Bot|Test)/.test(line.slice(1)) || /（Aven\.(Bot|Test) /.test(line); continue }
    if (/正在进行的事|台账|进行中/.test(block)) continue
    const sp = SPEAKER_RE.exec(line)
    if (sp) botSpeaking = /（bot，我们自己）|^Aven\.(Bot|Test)$/.test(line.slice(0, sp[0].length)) || /^Aven\.(Bot|Test)/.test(sp[1])
    if (botSpeaking || /^<\/?card|^📝/.test(line)) continue
    out.add(line)
  }
  return out
}
export const seenOverlap = (faliveText, simText) => {
  if (!faliveText || !simText) return null
  const f = humanLines(faliveText)
  const s = humanLines(simText)
  const both = [...f].filter((l) => s.has(l)).length
  return { falive: f.size, sim: s.size, recall: f.size ? both / f.size : 1, extra: [...s].filter((l) => !f.has(l)).length, onlyFalive: [...f].filter((l) => !s.has(l)).slice(0, 8), onlySim: [...s].filter((l) => !f.has(l)).slice(0, 8) }
}

// 首句时延是否「差不多」：两边都在 2 分钟内，或差不超过 60 秒，或相差不到一倍。
export const latencyClose = (a, b) => a != null && b != null && ((a <= 120 && b <= 120) || Math.abs(a - b) <= 60 || Math.max(a, b) <= 2 * Math.min(a, b))

const readJson = (path, fallback = null) => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return fallback } }
const jsonl = (path) => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } }) : [])
const one = (t, n = 200) => String(t || '').replace(/<\/?card[^>]*>|📝 由 aven 的助手整理/g, '').replace(/\s+/g, ' ').trim().slice(0, n)

// —— 主流程 ——
const main = async () => {
  const args = process.argv.slice(2)
  const wantGist = args.includes('--gist')
  const maxGist = Number(args.includes('--max-gist') ? args[args.indexOf('--max-gist') + 1] : 60)
  const calDir = join(casesDir, 'calibration')
  const timeline = readJson(join(datasetDir, 'timeline.json'), [])
  const byId = new Map(timeline.map((m) => [m.id, m]))
  const baselines = new Map(readJson(join(datasetDir, 'episodes.json'), []).map((e) => [e.id, e]))
  const groups = new Map(readJson(join(casesDir, 'episodes.json'), { groups: [] }).groups.map((g) => [g.id, g]))
  const caseKinds = new Map(readFileSync(join(casesDir, 'cases.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { const c = JSON.parse(l); return [c.id, c.kind] }))
  const tags = new Map(readFileSync(join(casesDir, 'case-tags.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { const t = JSON.parse(l); return [t.id, t] }))
  const faliveGw = loadGatewayBaseline()
  const faliveClaimed = loadWorkerClaimedTexts()
  const faliveAudits = loadAudits()
  const casesAll = readFileSync(join(casesDir, 'cases.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  const faliveDm = matchTextLines({ logText: existsSync(join(faliveLogDir, 'gateway.log')) ? readFileSync(join(faliveLogDir, 'gateway.log'), 'utf8') : '', cases: casesAll })
  const labels = readJson(join(calDir, 'fidelity-labels.json'), {})
  const gistPath = join(calDir, 'fidelity-gist.jsonl')
  const gistCache = new Map(jsonl(gistPath).map((g) => [g.key, g]))
  // 触发消息池：逐条基线里的全部（falive 分类过 / @bot / aven 在控制台说的），不止 285 条 case——组外的 @bot falive 当时也回了，不放进池子会被误归到组内 case。
  const triggerOf = (m) => ({ id: m.id, chatId: m.chatId, atMs: m.atMs, senderName: m.senderName, dm: m.chatKey === 'webhook-group', text: m.text, parentText: m.parentId ? byId.get(m.parentId)?.text || '' : '' })
  const allTriggers = [...baselines.values()].map((e) => byId.get(e.id)).filter((m) => m && !m.ownBot)

  const rows = []
  const attributionCheck = { total: 0, right: 0, wrong: [] }
  const episodes = readdirSync(calDir).filter((f) => /^ep-.*\.json$/.test(f)).map((f) => f.replace(/\.json$/, '')).sort()
  for (const epId of episodes) {
    const ep = groups.get(epId)
    // calibrate.mjs 的目录是 cal-<组>；更早单独跑的（P0-h 冒烟）是 falive-<组>[-r2]：取 calibration.json 和这里那份一样的
    const mine = readFileSync(join(calDir, `${epId}.json`), 'utf8')
    const candidates = [`cal-${epId}`, `falive-${epId}-r2`, `falive-${epId}`].map((n) => join(replayRoot, 'sim', n)).filter((d) => existsSync(d))
    const simDir = candidates.find((d) => existsSync(join(d, 'calibration.json')) && readFileSync(join(d, 'calibration.json'), 'utf8') === mine) || candidates[0]
    if (!ep || !simDir) continue
    const meta = readJson(join(simDir, 'meta.json'), {})
    const hidden = new Set(meta.hiddenIds || [])
    const fromMs = Date.parse(ep.windowStart)
    const firstMs = Date.parse(ep.firstAt)
    const simEndMs = readJson(join(simDir, 'clock.json'), null)?.virtualMs || Date.parse(ep.lastAt) + 3600_000
    const chats = new Set([...ep.caseIds.map((id) => byId.get(id)?.chatId).filter(Boolean), CONSOLE_CHAT])
    const sGwText = existsSync(join(simDir, 'gateway.log')) ? readFileSync(join(simDir, 'gateway.log'), 'utf8') : ''
    const sGw = parseGatewayLog(sGwText)
    // 池子只放那一边网关真收到过的（日志里有它的行；控制台私聊的行不带 id，照放）：没收到的不可能被回，放进去只会抢走别的 case 的回复
    // （ep-1024 C6「测试的tid 发出来」falive 当时没收到，相似度却把 C7 的回复归给了它）。
    // falive 当时：窗口内全部触发进池；bot 消息取组首条起、到模拟收尾为止
    const window = allTriggers.filter((m) => m.atMs >= fromMs - 6 * 3600_000 && m.atMs <= simEndMs).map(triggerOf)
    const fTriggers = window.filter((t) => t.dm || faliveGw.lines.has(t.id))
    const fMsgs = timeline.filter((m) => m.ownBot && chats.has(m.chatId) && m.atMs >= firstMs && m.atMs <= simEndMs).map((m) => ({ id: m.id, chatId: m.chatId, atMs: m.atMs, text: m.text }))
    const fOwner = attributeMessages({ triggers: fTriggers, msgs: fMsgs })
    // 模拟：组外 case 不供，池子里也不放
    const sTriggers = window.filter((t) => !hidden.has(t.id) && (t.dm || sGw.lines.has(t.id)))
    const sOut = jsonl(join(simDir, 'outbox.jsonl')).map((e) => ({ id: e.id, chatId: e.chatId, atMs: e.at, text: e.text }))
    const sOwnerHeur = attributeMessages({ triggers: sTriggers, msgs: sOut })
    // 模拟群里的真值：发件簿 taskId（同群、时刻差 3 秒内、按顺序配对）
    const truth = new Map()
    const ledger = readdirSync(join(simDir, 'runtime', 'lark-outbox')).flatMap((f) => jsonl(join(simDir, 'runtime', 'lark-outbox', f))).filter((e) => !e.gated && e.taskId)
    for (const e of ledger) {
      const hit = sOut.find((o) => !truth.has(o.id) && o.chatId === e.chatId && Math.abs(o.atMs - Date.parse(e.at)) < 3000)
      if (hit) truth.set(hit.id, e.taskId)
    }
    for (const [msgId, taskId] of truth) {
      if (!sTriggers.some((t) => t.id === taskId)) continue
      attributionCheck.total += 1
      if (sOwnerHeur.get(msgId) === taskId) attributionCheck.right += 1
      else attributionCheck.wrong.push({ ep: epId, msg: msgId, truth: taskId, heur: sOwnerHeur.get(msgId) || null })
    }
    const sOwner = new Map([...sOwnerHeur].filter(([id]) => !truth.has(id)))
    for (const [id, taskId] of truth) sOwner.set(id, taskId)
    const simDm = matchTextLines({ logText: sGwText, cases: casesAll.filter((c) => ep.caseIds.includes(c.id)) })
    const sClaimed = parseClaimedTexts(existsSync(join(simDir, 'worker.log')) ? readFileSync(join(simDir, 'worker.log'), 'utf8') : '')

    ep.caseIds.forEach((id, i) => {
      const m = byId.get(id)
      const base = baselines.get(id)?.baseline || {}
      const kind = caseKinds.get(id) || null
      const side = (msgs, owner, gwLines, claimed, extra) => {
        const mine = msgs.filter((x) => owner.get(x.id) === id)
        const group = mine.filter((x) => x.chatId !== CONSOLE_CHAT)
        const dm = mine.filter((x) => x.chatId === CONSOLE_CHAT)
        const route = routeState(gwLines, id)
        const firstOf = (list) => (list.length && m ? Math.round((list[0].atMs - m.atMs) / 1000) : null)
        const substantive = [...group].reverse().find((x) => !isAck(x.text)) || [...dm].reverse().find((x) => END_RE.test(body(x.text))) || null
        const endCard = [...dm].reverse().find((x) => END_RE.test(body(x.text))) || null
        return {
          group: group.map((x) => ({ afterSec: Math.round((x.atMs - m.atMs) / 1000), text: one(x.text, 300) })),
          dm: dm.map((x) => ({ afterSec: Math.round((x.atMs - m.atMs) / 1000), text: one(x.text, 300) })),
          firstSec: kind === 'principal_dm' ? firstOf(mine) : firstOf(group.length ? group : mine),
          conclusion: substantive ? one(substantive.text, 1200) : null,
          // 给模型看的全量结论：群里实质回复 + 私信结果卡（群里只发「完整内容：链接」时结论在私信卡里）
          fullConclusion: substantive || endCard ? [substantive && substantive !== endCard ? `群里：${one(substantive.text, 1500)}` : null, endCard ? `私信 aven：${one(endCard.text, 1500)}` : null].filter(Boolean).join('\n') : null,
          route,
          seenText: claimed || null,
          ...extra,
        }
      }
      const fAudit = faliveAudits.get(id)?.audit || null
      const falive = side(fMsgs, fOwner, [...(faliveGw.lines.get(id) || base.routing || []), ...(faliveDm.get(id) || [])], faliveClaimed.get(id) || fAudit?.task?.text || null, { audit: fAudit ? fAudit.status : null, classifiedRaw: faliveGw.classified.get(id) || base.classified || null })
      const simTask = readJson(join(simDir, 'runtime', 'lark-tasks', `${id}.json`), null)
      const sim = side(sOut, sOwner, [...(sGw.lines.get(id) || []), ...(simDm.get(id) || [])], sClaimed.get(id) || null, { task: simTask?.status || null, classifiedRaw: sGw.classified.get(id) || null })
      // falive 那一侧整段记录（不靠归属：组内全部 case 的原话 + falive 这段时间发的全部消息），给第二轮结论比对用
      const fLog = [...ep.caseIds.map((cid, j) => ({ atMs: byId.get(cid)?.atMs || 0, line: `【C${j + 1}${cid === id ? '，就是这条' : ''}】${byId.get(cid)?.senderName}：${one(byId.get(cid)?.text, 300)}` })),
        ...fMsgs.filter((x) => !BROADCAST_RE.test(x.text)).map((x) => ({ atMs: x.atMs, line: `  bot→${x.chatId === CONSOLE_CHAT ? '私信 aven' : '群里'}：${one(x.text, 700)}` }))]
        .sort((a, b) => a.atMs - b.atMs).map((x) => `${new Date(x.atMs).toISOString().slice(11, 19)} ${x.line}`).join('\n').slice(0, 14000)
      rows.push({ ep: epId, label: `C${i + 1}`, id, kind, chat: m?.chatKey || null, at: m ? new Date(m.atMs).toISOString() : null, sender: m?.senderName || null, text: one(m?.text, 160), pending: Boolean(tags.get(id)?.pending), falive, sim, faliveLog: fLog })
    })
  }

  // —— 逐项比 ——
  const FIELDS = ['replied', 'groupCount', 'dmCount', 'latency', 'decision', 'endState', 'gist', 'seen']
  const compare = (r) => {
    const f = r.falive
    const s = r.sim
    const groupCase = r.kind !== 'principal_dm'
    const repliedOf = (x) => (groupCase ? x.group.length > 0 : x.group.length + x.dm.length > 0)
    const out = {}
    out.replied = { falive: repliedOf(f), sim: repliedOf(s), match: repliedOf(f) === repliedOf(s) }
    out.groupCount = { falive: f.group.length, sim: s.group.length, match: f.group.length === s.group.length }
    out.dmCount = { falive: f.dm.length, sim: s.dm.length, match: f.dm.length === s.dm.length }
    out.latency = f.firstSec == null || s.firstSec == null ? { falive: f.firstSec, sim: s.firstSec, match: null } : { falive: f.firstSec, sim: s.firstSec, match: latencyClose(f.firstSec, s.firstSec) }
    const fd = f.route.decision || f.classifiedRaw?.decision || null
    const sd = s.route.decision || s.classifiedRaw?.decision || null
    out.decision = fd == null && sd == null ? { falive: null, sim: null, match: null, why: '两边都没走分类（控制台指示 / 并入）' } : fd == null ? { falive: 'unknown', sim: sd, match: null } : { falive: fd, sim: sd, match: fd === sd }
    out.endState = f.route.state == null ? { falive: 'unknown', sim: s.route.state, match: null } : { falive: f.route.state, sim: s.route.state, match: f.route.state === s.route.state }
    const ov = seenOverlap(f.seenText, s.seenText)
    out.seen = !f.seenText ? { match: null, why: 'falive 没留领单正文' } : !s.seenText ? { match: null, why: '模拟没领单' } : { ...ov, match: ov.recall >= 0.8 && ov.extra <= Math.max(2, 0.2 * ov.falive) }
    out.gist = { match: null }
    return out
  }
  for (const r of rows) r.cmp = compare(r)

  // —— 结论大意：两边都有实质结论才问 ——
  // 第一轮（v1）：两边归属后的结论两两比。第二轮（v2，--gist）：v1 不是 same 的（或没比成的），把 falive 那段时间的全部消息给模型、让它自己找出对这条的回复再比——
  // falive 一侧的归属是启发式（模拟真值上 9 成对），归错了 v1 会把「答的不是一回事」算成差异。有 v2 用 v2。
  const verdictOf = (g) => ({ verdict: g.verdict, reason: g.reason, round: g.key.startsWith('v2|') ? 2 : 1, match: g.verdict === 'same' ? true : g.verdict === 'different' ? false : g.verdict === 'none' ? null : 'partial' })
  let calls = 0
  for (const r of rows) {
    const v1 = r.falive.conclusion && r.sim.conclusion ? gistCache.get(`${r.id}|${r.falive.conclusion.slice(0, 80)}|${r.sim.conclusion.slice(0, 80)}`) : null
    const key2 = `v2|${r.id}|${String(r.sim.fullConclusion || '').slice(0, 80)}`
    let v2 = gistCache.get(key2) || null
    const needV2 = r.sim.fullConclusion && (r.falive.conclusion || r.falive.group.length || r.falive.dm.length) && (!v1 || v1.verdict !== 'same')
    if (wantGist && needV2 && !v2 && calls < maxGist) {
      calls += 1
      try {
        v2 = { key: key2, id: r.id, ...(await askGist2(r)) }
        gistCache.set(key2, v2)
        appendFileSync(gistPath, `${JSON.stringify(v2)}\n`)
        console.log(`[gist2] ${r.ep} ${r.label} → ${v2.verdict}`)
      } catch (error) { console.log(`[gist2] ${r.ep} ${r.label} 失败：${error.message.slice(0, 120)}`) }
    }
    const g = v2 || v1
    if (g) r.cmp.gist = verdictOf(g)
  }

  // —— 归因：人工标注优先，否则规则粗分 ——
  for (const r of rows) {
    r.diffs = FIELDS.filter((k) => r.cmp[k].match === false || r.cmp[k].match === 'partial')
    const label = labels[r.id] || null
    r.category = r.diffs.length ? (label?.category || 'unknown') : null
    r.cause = label?.cause || null
    r.note = label?.note || null
    r.fieldCategories = label?.fields || null
  }

  // —— 汇总 ——
  const scored = rows.filter((r) => !r.pending)
  const fieldStats = Object.fromEntries(FIELDS.map((k) => {
    const comparable = scored.filter((r) => r.cmp[k].match !== null)
    const match = comparable.filter((r) => r.cmp[k].match === true).length
    const partial = comparable.filter((r) => r.cmp[k].match === 'partial').length
    const byCategory = {}
    for (const r of comparable.filter((x) => x.cmp[k].match !== true)) { const c = r.fieldCategories?.[k] || r.category || 'unknown'; byCategory[c] = (byCategory[c] || 0) + 1 }
    return [k, { comparable: comparable.length, match, partial, mismatch: comparable.length - match - partial, byCategory, unknownFalive: scored.filter((r) => r.cmp[k].match === null && (r.cmp[k].falive === 'unknown' || /falive/.test(r.cmp[k].why || ''))).length }]
  }))
  const cells = scored.flatMap((r) => FIELDS.filter((k) => r.cmp[k].match !== null).map((k) => ({ r, k, m: r.cmp[k].match })))
  const byCat = {}
  for (const r of scored.filter((x) => x.diffs.length)) {
    const fc = r.fieldCategories || {}
    for (const k of r.diffs) { const c = fc[k] || r.category; byCat[c] = (byCat[c] || 0) + 1 }
  }
  const summary = {
    generatedAt: new Date().toISOString(),
    episodes: episodes.length,
    cases: rows.length,
    scored: scored.length,
    fullMatch: scored.filter((r) => !r.diffs.length).length,
    cells: { comparable: cells.length, match: cells.filter((c) => c.m === true).length, partial: cells.filter((c) => c.m === 'partial').length },
    fieldStats,
    diffCellsByCategory: byCat,
    casesByCategory: Object.fromEntries(Object.keys(CATEGORY).map((c) => [c, scored.filter((r) => r.category === c).length])),
    casesWithCategory: Object.fromEntries(Object.keys(CATEGORY).map((c) => [c, scored.filter((r) => r.diffs.some((k) => (r.fieldCategories?.[k] || r.category) === c)).length])),
    pendingCases: rows.filter((r) => r.pending).map((r) => ({ ep: r.ep, label: r.label, diffs: r.diffs, category: r.category, cause: r.cause })),
    // 把模拟偏差 / 还原不了 / 说不清的格子拿掉后的一致率 = 同输入下 falive 代码自己和自己的一致程度（抽样噪声底）
    samplingFloor: (() => { const kept = cells.filter((c) => c.m === true || ['sampling'].includes(c.r.fieldCategories?.[c.k] || c.r.category)); return { comparable: kept.length, match: kept.filter((c) => c.m === true).length } })(),
    attributionCheck: { ...attributionCheck, accuracy: attributionCheck.total ? attributionCheck.right / attributionCheck.total : null },
  }
  // 领单正文 / falive 整段记录只是比对的中间料，不落盘（体积大头）
  const slim = rows.map(({ faliveLog, ...r }) => ({ ...r, falive: { ...r.falive, seenText: undefined }, sim: { ...r.sim, seenText: undefined } }))
  writeFileSync(join(calDir, 'fidelity.json'), `${JSON.stringify({ summary, rows: slim }, null, 1)}\n`)
  writeFileSync(join(calDir, 'fidelity-cases.md'), renderCases({ rows, summary }))
  console.log(JSON.stringify(summary, (k, v) => (k === 'wrong' ? v.length : v), 1))
}

const fmtCell = (c) => (c.match === null ? '·' : c.match === true ? '✓' : c.match === 'partial' ? '½' : '✗')
const renderCases = ({ rows, summary }) => {
  const out = [`# 校准逐 case 对照（${summary.cases} 条，计分 ${summary.scored}）`, '', '由 `node scripts/sim/calibration-fidelity.mjs` 生成，别手改；结论见 fidelity.md。✓ 对得上 ✗ 对不上 ½ 部分 · 不可比。', '',
    '| 组 | case | 类型 | 原话 | 回 | 群 | 私 | 时延 | 分类 | 终态 | 大意 | 上下文 | 归因 |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|']
  for (const r of rows) {
    const c = r.cmp
    out.push(`| ${r.ep} | ${r.label}${r.pending ? '（待办）' : ''} | ${r.kind} | ${r.text.slice(0, 40).replace(/\|/g, '\\|')} | ${fmtCell(c.replied)} | ${c.groupCount.falive}→${c.groupCount.sim} | ${c.dmCount.falive}→${c.dmCount.sim} | ${c.latency.falive ?? '—'}s→${c.latency.sim ?? '—'}s ${fmtCell(c.latency)} | ${c.decision.falive || '—'}→${c.decision.sim || '—'} | ${c.endState.falive || '—'}→${c.endState.sim || '—'} | ${fmtCell(c.gist)} | ${c.seen.recall != null ? `${Math.round(c.seen.recall * 100)}%+${c.seen.extra}` : '·'} | ${r.category ? `${CATEGORY[r.category]}${r.cause ? `：${r.cause}` : ''}` : '—'} |`)
  }
  out.push('', '## 有差异的 case 明细', '')
  for (const r of rows.filter((x) => x.diffs.length)) {
    out.push(`### ${r.ep} ${r.label} ${r.id}（${r.chat}，${r.kind}）`, '', `> ${r.sender}：${r.text}`, '', `- 差异：${r.diffs.join('、')}；归因：${r.category ? CATEGORY[r.category] : '—'}${r.cause ? `（${r.cause}）` : ''}${r.note ? `——${r.note}` : ''}`)
    out.push(`- 路径 falive：${pathStr(r.falive.route)}；模拟：${pathStr(r.sim.route)}${r.sim.task ? `（模拟任务 ${r.sim.task}）` : ''}${r.falive.audit ? `（falive 审计 ${r.falive.audit}）` : ''}`)
    if (r.cmp.gist.verdict) out.push(`- 大意：${r.cmp.gist.verdict}——${r.cmp.gist.reason}`)
    if (r.cmp.seen.onlyFalive?.length || r.cmp.seen.onlySim?.length) out.push(`- 上下文：只 falive ${r.cmp.seen.onlyFalive.map((l) => `「${l.slice(0, 60)}」`).join(' ')}；只模拟 ${r.cmp.seen.onlySim.map((l) => `「${l.slice(0, 60)}」`).join(' ')}`)
    for (const [who, x] of [['falive', r.falive], ['模拟', r.sim]]) {
      for (const g of x.group) out.push(`  - ${who} 群 +${g.afterSec}s：${g.text.slice(0, 180)}`)
      for (const g of x.dm) out.push(`  - ${who} 私 +${g.afterSec}s：${g.text.slice(0, 180)}`)
    }
    out.push('')
  }
  return `${out.join('\n')}\n`
}
const pathStr = (route) => `${route.decision || '—'}/${route.state || '—'}（${Object.entries(route.path).filter(([, v]) => v).map(([k]) => k).join(' ') || '无日志'}）`

const askGist2 = async (r) => {
  const prompt = `同一个机器人（同一套代码）先后两次处理同一组群消息：A 是当时真实的那次，B 是之后离线重放的那次。判断 A、B 对【就是这条】那条消息给的「结论大意」是否一致。
A 那次只有整段记录（含它对组里别的消息的回复），先从里面找出 A 对【就是这条】的回复（按时间、@ 的人、内容对上；「收到 / 我查一下」类先回的话不算结论）；B 对这条的结论已经挑好了。
只看结论（判断是什么、做没做成、给了什么答案 / 交付），不看措辞、长短、格式、时间戳、文档链接、帖子 / 记录编号这类每次都会变的值。
- same：结论一致（同一判断 / 同一结果；细节多少可以不同）
- partial：主结论一致但有实质分歧（一边多出 / 少了关键发现，或一边做成一边部分做成）
- different：结论不同（相反判断、一边卡住一边做成、答的不是一回事）
- none：A 对这条没有给出结论（没回、只回了收到、或回复归不到这条）

【A 的整段记录】
${r.faliveLog}

【B 对这条的结论】
${r.sim.fullConclusion}

reason 用一句中文说明（先说 A 对这条的结论是什么）。`
  const schema = { type: 'object', properties: { verdict: { type: 'string', enum: ['same', 'partial', 'different', 'none'] }, reason: { type: 'string' } }, required: ['verdict', 'reason'] }
  const v = await runClaudeJson(prompt, schema)
  if (!['same', 'partial', 'different', 'none'].includes(v?.verdict)) throw new Error(`结论不合结构：${JSON.stringify(v).slice(0, 200)}`)
  return { verdict: v.verdict, reason: v.reason || '' }
}
const runClaudeJson = async (prompt, schema) => {
  const child = spawn(join(dirname(fileURLToPath(import.meta.url)), 'claude-q'), ['-p', '--permission-mode', 'plan', '--tools', '', '--model', 'claude-opus-5-5', '--effort', 'low', '--strict-mcp-config', '--setting-sources', 'project', '--no-session-persistence', '--json-schema', JSON.stringify(schema), '--output-format', 'json', prompt], { cwd: replayRoot, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SIM_ORIG_INTENT_MS: '1800000' } })
  let out = ''
  let err = ''
  child.stdout.on('data', (c) => { out += c })
  child.stderr.on('data', (c) => { err += c })
  const code = await new Promise((resolve) => child.on('close', resolve))
  if (code !== 0) throw new Error(`claude exit ${code}: ${err.slice(0, 200)}`)
  const envelope = JSON.parse(out)
  return envelope.structured_output ?? (typeof envelope.result === 'string' ? JSON.parse(envelope.result) : envelope.result)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
