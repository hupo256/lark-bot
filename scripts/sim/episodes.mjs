#!/usr/bin/env node
/**
 * 事件组切分（docs/falive-replay-design-v2.md §2、§8 P0-b）：把 285 个 case 按「事」并成组，每组单独起一个 lark-bot 实例回放。
 *   规则 1 同话题 / 回复链 / 正文里引用的消息 id（含 aven 私聊「继续任务 / 结单 om_x…」；「就这样回」这类不带 id 的，指向它之前最近一张 falive 私信草稿的任务）
 *   规则 2 同群（或负责人私聊）相邻两条 case 间隔 < 30 分钟
 *   规则 3 falive 当时真实的归并 / 续跑（网关日志、worker 领单正文、审计 intake.continues、任务台账 continues / supersededBy / mergedFrom）：并过的必须同组
 *   规则 4 同一天（UTC，与 run-days 切天一致）、都改了代码、改动文件（不含 docs/ 与 .md）有交集
 * 只读：replay/falive/{cases.jsonl,dataset/timeline.json}、~/Library/Logs/falive-lark/、~/github/lark-bot-falive/runtime/。
 *   node scripts/sim/episodes.mjs   → replay/falive/episodes.json + episodes.md
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { casesDir, datasetDir, faliveLogDir, faliveRuntimeDir, loadWorkerClaimedTexts } from './falive-data.mjs'

const GAP_MS = 30 * 60_000
const WINDOW_LEAD_MS = 30 * 60_000
const OM_RE = /om_x[0-9a-f]{20,}/g
const HAS_OM = /om_x[0-9a-f]{20,}/
// 「就这样回」类：回的是 falive 刚私信来的草稿，不带任务 id。
const DRAFT_REPLY_RE = /^(就这样|就这么|照这个|按这个)回|^(发吧|可以发|直接发)/

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
const timeline = readJson(join(datasetDir, 'timeline.json'))
const byId = new Map(timeline.map((m) => [m.id, m]))
const cases = readFileSync(join(casesDir, 'cases.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  .map((c) => ({ ...c, atMs: Date.parse(c.at), msg: byId.get(c.id) }))
  .sort((a, b) => a.atMs - b.atMs || a.id.localeCompare(b.id))
const caseById = new Map(cases.map((c) => [c.id, c]))
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10)
const norm = (text) => String(text || '').replace(/@Aven\.(Test|Bot)/g, '').replace(/\s+/g, '').trim()

// —— 并查集：节点是 m:<消息 id>（时间线里有的）或 root:<id>（回复链 / 话题的根，时间线里可能没有）。
const parent = new Map()
const caseCount = new Map()
const find = (x) => {
  if (!parent.has(x)) { parent.set(x, x); caseCount.set(x, x.startsWith('m:') && caseById.has(x.slice(2)) ? 1 : 0) }
  let r = x
  while (parent.get(r) !== r) r = parent.get(r)
  for (let y = x; parent.get(y) !== r;) { const next = parent.get(y); parent.set(y, r); y = next }
  return r
}
const unions = [] // 合并了两个各含 case 的分量的那几次，带理由（审计用）
const tally = {}
const union = (a, b, rule, detail) => {
  const ra = find(a)
  const rb = find(b)
  if (ra === rb) return false
  const merged = caseCount.get(ra) > 0 && caseCount.get(rb) > 0
  parent.set(rb, ra)
  caseCount.set(ra, caseCount.get(ra) + caseCount.get(rb))
  if (merged) { unions.push({ rule, a, b, detail }); tally[rule] = (tally[rule] || 0) + 1 }
  return merged
}
const node = (id) => (byId.has(id) ? `m:${id}` : `root:${id}`)
const groupCount = () => new Set(cases.map((c) => find(`m:${c.id}`))).size
const stages = []
const stage = (name) => stages.push({ name, groups: groupCount() })

// 时间线消息的回复链根（root_id，没有就沿 parent_id 往上走到头）。
const chainRoot = (m) => {
  if (m.rootId) return m.rootId
  let cur = m
  const seen = new Set()
  while (cur.parentId && !seen.has(cur.id)) { seen.add(cur.id); if (!byId.has(cur.parentId)) return cur.parentId; cur = byId.get(cur.parentId) }
  return cur.id
}

// falive 的审计（全部代）：bot 卡归哪个任务、规则 3 / 4 都用。
const auditFiles = (() => {
  const dir = join(faliveRuntimeDir, 'lark-audits', 'FALIVE')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => /-e\d+\.json$/.test(f)).flatMap((f) => { try { return [{ file: f, audit: readJson(join(dir, f)) }] } catch { return [] } })
})()
const completions = auditFiles.map(({ audit }) => ({ taskId: audit.task?.messageId || audit.taskId, chatId: audit.task?.chatId || null, at: Date.parse(audit.completedAt || '') }))
  .filter((x) => x.taskId && Number.isFinite(x.at))
// bot 卡是哪个任务的结果：审计 completedAt 在卡前 3 分钟内（群里的卡还要同群）。
const completedBefore = (card, sameChat) => {
  let best = null
  for (const x of completions) {
    const d = card.atMs - x.at
    if (d < -10_000 || d > 180_000 || (sameChat && x.chatId !== card.chatId)) continue
    if (!best || Math.abs(d) < Math.abs(card.atMs - best.at)) best = x
  }
  return best?.taskId || null
}
// 私信草稿归哪个任务：先按审计完成时间；审计没了（早期的清过）就找它之前最近一张「🛠 开始做：…（群名）」卡，取那个群在开始卡前 2 小时内最后一条 case。
const draftOwner = (card) => {
  const byAudit = completedBefore(card, false)
  if (byAudit) return byAudit
  const start = timeline.filter((m) => m.chatKey === 'webhook-group' && m.ownBot && m.atMs <= card.atMs && card.atMs - m.atMs < 3 * 3600_000 && /🛠 开始做/.test(m.text)).at(-1)
  const chatName = start?.text.match(/（([^（）]+群)）\s*(?:<\/card>|$)/m)?.[1]
  return chatName ? cases.filter((c) => c.chat === chatName && c.atMs < start.atMs && start.atMs - c.atMs < 2 * 3600_000).at(-1)?.id || null : null
}

// —— 规则 1：同话题 / 回复链（全部时间线消息挂上根，bot 回复也算链上一环）
for (const m of timeline) {
  const root = chainRoot(m)
  if (root !== m.id) union(`m:${m.id}`, node(root), 'r1-reply-chain', `回复链根 ${root}`)
  if (m.threadId) union(`m:${m.id}`, `thread:${m.threadId}`, 'r1-thread', `话题 ${m.threadId}`)
}
// falive 在群里发卡不挂 reply（parent_id 全空），人回 bot 卡只连到卡本身：把卡连回它答的 case——
// 先按审计完成时间对任务，对不上就取同群 6 小时内最近一条、发话人被这张卡 @ 到的 case。
const cardOwners = []
for (const card of timeline) {
  if (!card.ownBot || card.chatKey === 'webhook-group' || card.parentId) continue
  let owner = completedBefore(card, true)
  let how = '审计完成时间'
  if (!owner) {
    owner = cases.filter((c) => c.msg?.chatId === card.chatId && c.atMs < card.atMs && card.atMs - c.atMs < 6 * 3600_000 && c.msg?.senderId && card.text.includes(c.msg.senderId)).at(-1)?.id || null
    how = '卡里 @ 了发话人'
  }
  if (!owner) continue
  cardOwners.push({ card: card.id, owner, how })
  union(`m:${card.id}`, node(owner), 'r1-bot-card', `bot 卡 ${card.id} 答的是 ${owner}（${how}）`)
}
// 正文引用的消息 / 任务 id
for (const c of cases) {
  for (const id of new Set(String(c.msg?.text || c.text).match(OM_RE) || [])) if (id !== c.id) union(`m:${c.id}`, node(id), 'r1-text-ref', `正文引用 ${id}`)
}
const drafts = timeline.filter((m) => m.chatKey === 'webhook-group' && m.ownBot && !/^<card>\s*(🛠 开始做|收到，当作)/.test(m.text))
const draftLinks = []
for (const c of cases) {
  if (c.kind !== 'principal_dm' || HAS_OM.test(c.text) || !DRAFT_REPLY_RE.test(norm(c.text))) continue
  const prior = drafts.filter((m) => m.atMs < c.atMs).reverse().map((m) => ({ m, owner: draftOwner(m) })).find((x) => x.owner)
  draftLinks.push({ caseId: c.id, text: c.text, draft: prior?.m.id || null, task: prior?.owner || null })
  if (prior) union(`m:${c.id}`, node(prior.owner), 'r1-draft-reply', `「${c.text.slice(0, 12)}」回 ${new Date(prior.m.atMs).toISOString().slice(5, 16)} 的私信草稿（任务 ${prior.owner}）`)
}
stage('规则 1 同话题 / 回复链 / 引用 id')

// —— 规则 2：同群（webhook 群 = 负责人私聊）相邻 < 30 分钟
const byChat = new Map()
for (const c of cases) { const k = c.msg?.chatKey || c.chat; if (!byChat.has(k)) byChat.set(k, []); byChat.get(k).push(c) }
for (const list of byChat.values()) {
  for (let i = 1; i < list.length; i += 1) {
    const gap = list[i].atMs - list[i - 1].atMs
    if (gap < GAP_MS) union(`m:${list[i - 1].id}`, `m:${list[i].id}`, 'r2-adjacent', `同群相隔 ${Math.round(gap / 60_000)} 分钟`)
  }
}
stage('规则 2 同群相邻 < 30 分钟')

// —— 规则 3：falive 真实归并 / 续跑
const faliveEdges = [] // [a 节点, b 节点, 来源]
const unmatched = []
const dmCases = cases.filter((c) => c.kind === 'principal_dm')
const consumed = new Set()
// 日志里不带来源 id 的私聊行（「负责人私聊（recent）→ 续跑 B：<原话>」等）：按原话对上私聊 case，日志按时间顺序写，同句取最早没用过的那条。
const matchCase = (pool, text) => {
  const t = norm(text)
  if (t.length < 2) return null
  const hit = pool.find((c) => !consumed.has(c.id) && (norm(c.text).startsWith(t) || (t.length >= 6 && norm(c.text).includes(t))))
  if (hit) consumed.add(hit.id)
  return hit || null
}
const gatewayPath = join(faliveLogDir, 'gateway.log')
const gatewayLines = existsSync(gatewayPath) ? readFileSync(gatewayPath, 'utf8').split('\n').map((l) => l.replace(/^\[lark-gateway\]\s*/, '')) : []
for (const line of gatewayLines) {
  let m
  const edge = (a, b, src) => faliveEdges.push([node(a), node(b), `${src}：${line.slice(0, 120)}`])
  if ((m = line.match(/^锚定：(om_x\w+) 接着 (om_x\w+)/))) edge(m[1], m[2], 'falive 锚定')
  else if ((m = line.match(/^话题补充：(om_x\w+) 并入任务 (om_x\w+)/))) edge(m[1], m[2], 'falive 话题补充')
  else if ((m = line.match(/^工单并入：(om_x\w+) → (om_x\w+)/))) edge(m[1], m[2], 'falive 工单并入')
  else if ((m = line.match(/^默认锚点：(om_x\w+) 接 bot .*（任务 (om_x\w+)）/))) edge(m[1], m[2], 'falive 默认锚点')
  else if ((m = line.match(/^同话题归并：本条 @ 并入挂起任务 (om_x\w+)（thread=(om_x\w+)）/))) edge(m[1], m[2], 'falive 同话题归并')
  else if ((m = line.match(/^同话题收尾：挂起任务 (om_x\w+) 由 (om_x\w+) 完成而 superseded/))) edge(m[1], m[2], 'falive 同话题收尾')
  else if ((m = line.match(/^负责人私聊（\w+）→ 指示任务 (om_x\w+)，针对 (om_x\w+)/))) edge(m[1], m[2], 'falive 私聊指示')
  else if ((m = line.match(/^负责人私聊（\w+）→ (?:续跑 (om_x\w+)|放行 (om_x\w+) 扣下的群回复)：(.*)$/))) {
    const hit = matchCase(dmCases, m[3])
    if (hit) edge(hit.id, m[1] || m[2], 'falive 私聊续跑')
    else unmatched.push(line.slice(0, 120))
  } else if ((m = line.match(/^resumed task (om_x\w+) with supplement（第 \d+ 次续跑）: (.*)$/))) {
    // 来源可能是私聊也可能是群里；只在原话本身带了目标 id 或能唯一对上时才连（续跑行和「负责人私聊 → 续跑」行通常成对出现，后者已连）。
    const pool = cases.filter((c) => norm(c.text).startsWith(norm(m[2])))
    if (pool.length === 1) edge(pool[0].id, m[1], 'falive 续跑')
    else if (!pool.length) unmatched.push(line.slice(0, 120))
  }
}
for (const [taskId, body] of loadWorkerClaimedTexts()) {
  if (!taskId.startsWith('om_x')) continue
  const m = body.match(/【指示针对的群消息（任务 (om_x\w+)/) || body.match(/【默认接着 bot 上一句】[^（\n]*（任务 (om_x\w+)/)
  if (m) faliveEdges.push([node(taskId), node(m[1]), `falive 领单正文：${taskId} 指向任务 ${m[1]}`])
}
for (const { file, audit } of auditFiles) {
  const id = audit.task?.messageId || audit.taskId
  const cont = audit.intake?.continues
  if (id?.startsWith('om_x') && typeof cont === 'string' && cont.startsWith('om_x')) faliveEdges.push([node(id), node(cont), `falive 审计 intake.continues（${file}）`])
}
const tasksDir = join(faliveRuntimeDir, 'lark-tasks')
for (const f of existsSync(tasksDir) ? readdirSync(tasksDir).filter((x) => x.startsWith('om_x')) : []) {
  let task
  try { task = readJson(join(tasksDir, f)) } catch { continue }
  for (const key of ['continues', 'supersededBy', 'mergedFrom']) {
    for (const other of [task[key]].flat()) if (typeof other === 'string' && other.startsWith('om_x')) faliveEdges.push([node(task.id), node(other), `falive 任务 ${key}（${f}）`])
  }
}
// 校验口径：两端都落在含 case 的分量上的边，规则 1–2 已同组的算「印证」，不同组的由这里补并。
const faliveCheck = { bothCases: 0, alreadySame: 0, merged: 0 }
for (const [a, b, why] of faliveEdges) {
  if (caseCount.get(find(a)) > 0 && caseCount.get(find(b)) > 0) {
    faliveCheck.bothCases += 1
    if (find(a) === find(b)) faliveCheck.alreadySame += 1
  }
  if (union(a, b, 'r3-falive', why)) faliveCheck.merged += 1
}
stage('规则 3 falive 真实归并 / 续跑')

// —— 规则 4：同一天、都改了代码、改动的代码文件有交集
const isCodePath = (p) => !/^docs\//.test(p) && !/\.md$/i.test(p)
const codeTasks = []
for (const { file, audit } of auditFiles) {
  const id = audit.task?.messageId || audit.taskId
  if (!id?.startsWith('om_x') || !audit.commit?.committed) continue
  const files = (audit.final?.changedFiles?.length ? audit.final.changedFiles : (audit.scope?.targets || []).map((t) => t.path)).filter(isCodePath)
  const atMs = caseById.get(id)?.atMs ?? Date.parse(audit.startedAt || '')
  if (files.length && Number.isFinite(atMs)) codeTasks.push({ id, file, day: utcDay(atMs), files })
}
const codePairs = []
for (let i = 0; i < codeTasks.length; i += 1) {
  for (let j = i + 1; j < codeTasks.length; j += 1) {
    const [x, y] = [codeTasks[i], codeTasks[j]]
    if (x.id === y.id || x.day !== y.day) continue
    const shared = x.files.filter((p) => y.files.includes(p))
    if (!shared.length) continue
    const merged = union(node(x.id), node(y.id), 'r4-same-code', `${x.day} 都改代码，同改 ${shared.slice(0, 3).join('、')}`)
    codePairs.push({ a: x.id, b: y.id, day: x.day, shared, merged })
  }
}
stage('规则 4 同天改同一批代码文件')

// —— 出组
const members = new Map()
for (const c of cases) { const r = find(`m:${c.id}`); if (!members.has(r)) members.set(r, []); members.get(r).push(c) }
const unionsByRoot = new Map()
for (const u of unions) { const r = find(u.a); if (!unionsByRoot.has(r)) unionsByRoot.set(r, []); unionsByRoot.get(r).push(u) }
const label = (key) => (key.startsWith('m:') && caseById.has(key.slice(2)) ? key.slice(2) : key)
const groups = [...members.entries()].map(([root, list]) => {
  const first = list[0]
  const last = list[list.length - 1]
  const days = [...new Set(list.map((c) => utcDay(c.atMs)))]
  const kinds = {}
  for (const c of list) kinds[c.kind] = (kinds[c.kind] || 0) + 1
  return {
    id: `ep-${utcDay(first.atMs).slice(5).replace('-', '')}-${first.id.slice(-6)}`,
    size: list.length,
    firstAt: first.at,
    lastAt: last.at,
    windowStart: new Date(first.atMs - WINDOW_LEAD_MS).toISOString(),
    days,
    chats: [...new Set(list.map((c) => c.chat))],
    kinds,
    caseIds: list.map((c) => c.id),
    unions: (unionsByRoot.get(root) || []).map((u) => ({ rule: u.rule, a: label(u.a), b: label(u.b), detail: u.detail })),
  }
}).sort((a, b) => a.firstAt.localeCompare(b.firstAt))

// falive 并过的两端都落在 case 上的，必须同组（构造上成立，这里再核一遍）
const groupOf = new Map(groups.flatMap((g) => g.caseIds.map((id) => [id, g.id])))
const violations = faliveEdges.filter(([a, b]) => find(a) !== find(b))
if (violations.length) throw new Error(`falive 并过的不同组：${violations.length}`)

const sizeBins = [[1, 1], [2, 2], [3, 5], [6, 10], [11, 20], [21, 40], [41, Infinity]]
const hist = sizeBins.map(([lo, hi]) => ({ bin: hi === Infinity ? `${lo}+` : lo === hi ? `${lo}` : `${lo}–${hi}`, groups: groups.filter((g) => g.size >= lo && g.size <= hi).length }))
const crossDay = groups.filter((g) => g.days.length > 1)
const spanDays = (g) => Math.round((Date.parse(g.lastAt) - Date.parse(g.firstAt)) / 864e5 * 10) / 10
const kindMix = {}
for (const g of groups) { const k = Object.keys(g.kinds).sort().join('+'); kindMix[k] = (kindMix[k] || 0) + 1 }
const out = {
  generatedBy: 'node scripts/sim/episodes.mjs',
  rules: { gapMinutes: GAP_MS / 60_000, windowLeadMinutes: WINDOW_LEAD_MS / 60_000, day: 'UTC（与 run-days 切天一致）', codeOverlap: '改动文件交集，不含 docs/ 与 .md' },
  stats: {
    cases: cases.length, groups: groups.length, maxSize: Math.max(...groups.map((g) => g.size)), crossDayGroups: crossDay.length,
    stages, effectiveUnions: tally, faliveEdges: faliveEdges.length, faliveCheck, faliveLogLinesWithoutCase: unmatched,
    draftReplies: draftLinks, botCardsLinked: cardOwners.length, codeTasks: codeTasks.length, codePairs: codePairs.length, histogram: hist, kindMix,
  },
  groups,
}
writeFileSync(join(casesDir, 'episodes.json'), `${JSON.stringify(out, null, 1)}\n`)

const hhmm = (iso) => iso.slice(5, 16).replace('T', ' ')
const md = [
  `# falive 回放事件组（${groups.length} 组 / ${cases.length} 个 case）`, '',
  '由 `node scripts/sim/episodes.mjs` 生成（规则见 docs/falive-replay-design-v2.md §2），别手改；明细与每次并组的理由在 `episodes.json`。时间 UTC。', '',
  `- 最大一组 ${out.stats.maxSize} 条；跨天的 ${crossDay.length} 组；单条成组 ${groups.filter((g) => g.size === 1).length} 组`,
  `- 逐步组数：${stages.map((s) => `${s.name} → ${s.groups}`).join('；')}`,
  `- 各规则实际并掉的组数：${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join('、')}`,
  `- falive 真实归并 / 续跑共 ${faliveEdges.length} 条，两端都是 case 的 ${faliveCheck.bothCases} 条：规则 1–2 已同组 ${faliveCheck.alreadySame}、校验补并 ${faliveCheck.merged}（私聊原话在 case 里找不到的日志行 ${unmatched.length}，是 webhook 拉取之后 / 原话不全的）；改代码任务 ${codeTasks.length} 个，同天同文件 ${codePairs.length} 对（其中 ${codePairs.filter((p) => p.merged).length} 对真并了组）`, '',
  '## 大小分布', '', '| 组大小 | 组数 |', '|---|---|', ...hist.map((h) => `| ${h.bin} | ${h.groups} |`), '',
  '## 类型构成（按组里 case 类型的组合）', '', '| 类型组合 | 组数 |', '|---|---|', ...Object.entries(kindMix).sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${k} | ${v} |`), '',
  '## 每组', '', '| 组 | 条数 | 首条 → 末条 | 跨度（天） | 天数 | 群 | 类型 |', '|---|---|---|---|---|---|---|',
  ...groups.map((g) => `| ${g.id} | ${g.size} | ${hhmm(g.firstAt)} → ${hhmm(g.lastAt)} | ${spanDays(g)} | ${g.days.length} | ${g.chats.join('、')} | ${Object.entries(g.kinds).map(([k, v]) => `${k} ${v}`).join('、')} |`),
]
writeFileSync(join(casesDir, 'episodes.md'), `${md.join('\n')}\n`)
console.log(`${groups.length} 组（最大 ${out.stats.maxSize}，跨天 ${crossDay.length}）→ replay/falive/episodes.json、episodes.md`)
console.log(stages.map((s) => `${s.name} → ${s.groups}`).join('\n'))
console.log('并组次数', tally, `falive 边 ${faliveEdges.length}，校验 ${JSON.stringify(faliveCheck)}，私聊原话无 case ${unmatched.length}；改码对 ${codePairs.length}；就这样回 ${draftLinks.length}；同组校验 ${groupOf.size} 条 case`)
