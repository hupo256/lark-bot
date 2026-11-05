#!/usr/bin/env node
/**
 * 规则预判（docs/replay/falive-replay-design-v2.md §5「裁判」1，不花 token）：对每个 sim 目录里每条 case 算结构事实——
 * lark-bot 回没回、回了几条、有没有重复、多久回（虚拟时间）、任务终态、交付物类型、并入谁、私信 aven 几条；
 * 同列 falive 当时的对应事实；再给 lark-bot 输出一个指纹（群里回复 + 私信的规范化文本 + 终态 / 交付物），
 * 模型裁判按指纹判「变没变」（scripts/sim/judge-sim.mjs）。
 *   node scripts/sim/judge-rules.mjs --round <轮> | --sim <名> | --dir <路径> [--score-from <ISO>] [--quiet]
 * 产物：每个 sim 目录下 rules.jsonl（每条 case 一行），最后打印汇总。
 *
 * 发件归属（outbox 一条归哪条 case）：parentId 就是 case → 它；parentId 是已归属的 bot 消息 → 跟着走；
 * 发件的 idempotencyKey 开头的消息 id（发它的任务 / 消息：<id>-e2-done、<id>-pn、<id>-resume）是 case → 它，是任务不是 case → 沿任务链
 *（replyTarget → rerunReplyTo.replyTarget → answerFor → supersededBy / mergedInto）找到 case；
 * 正文里点了本 sim 某条 case 的 id → 它；否则归同一会话（私信不限会话）里在它之前、2 小时内最近的一条 case；都不是 → 孤儿（汇总里报数）。
 * 任务链优先于「正文点名」与时间窗（b4 波 5：私信列候选任务的 id、并入单的私信 ✅ 按时间窗归错 case，93d62945 / 742acdf9）。
 */
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { LOCAL_HOST_RE } from './egress-log.mjs'
import { AVEN_OPEN_ID, GROUPS } from './falive-data.mjs'
import { WEBHOOK_CHAT_KEY, casesOfSim, loadJudgeData } from './judge-data.mjs'
import { listSimDirs, loadSim, simSelectorFromArgs } from './sim-dir.mjs'
import { loadSimLimitSources, simLimitsOf } from './sim-limits.mjs'

export { refMissing } from './sim-limits.mjs'

export const FOLLOW_MS = 2 * 60 * 60_000
export const RULES_VERSION = 'rules-v3-1105' // v2：模拟局限旗标 6 类（sim-limits.mjs），行里多 simLimits: [{ flag, why }]；v3：发件按任务链归属，旗标加 falive_ref / external
const WEBHOOK_CHAT_ID = GROUPS.find((g) => g.key === WEBHOOK_CHAT_KEY)?.chatId
const NOT_CONCLUDED = new Set(['received', 'queued', 'ready', 'running', 'verifying', 'failed', 'intake_failed'])

/**
 * 输出规范化：去掉每轮都会变、和 bot 行为无关的部分——回放发件 id（om_sim00012）、时间戳 / 钟点 / 耗时、sim 目录与临时路径、
 * hotfix worktree 名、多余空白。真实消息 id（om_x…）是时间线里的，跨轮不变，保留。
 */
export const normalizeOutputText = (text, { simDir = null } = {}) => {
  let s = String(text || '')
  if (simDir) s = s.split(simDir).join('<SIM_DIR>')
  return s
    .replace(/om_sim\d+/g, '<SIM_MSG>')
    .replace(/omt_sim_[A-Za-z0-9_]+/g, '<SIM_THREAD>')
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<TIME>')
    .replace(/(?<![\d.])\d{1,2}:\d{2}(?::\d{2})?(?![\d.])/g, '<HH:MM>')
    .replace(/(?<![\w.])\d+(?:\.\d+)?\s*(?:ms|毫秒|秒|分钟|min|s)(?![A-Za-z])/g, '<DUR>')
    .replace(/(?:\/private)?\/(?:tmp|var\/folders)\/[^\s"'`)\]，。；]+/g, '<TMP>')
    .replace(/\.lark-hotfix\/[^\s/"'`)\]，。；]+/g, '.lark-hotfix/<WT>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
}

export const channelOf = (item, webhookChatId = WEBHOOK_CHAT_ID) => (item.userId || (webhookChatId && item.chatId === webhookChatId) ? 'dm' : 'group')

/** 任务 id → case：本身是 case 就是它；否则沿 replyTarget / rerunReplyTo / answerFor / supersededBy / mergedInto 走几步。 */
export const caseOfTask = ({ id, caseIds, tasks = new Map(), hops = 4 }) => {
  if (!id) return null
  if (caseIds.has(id)) return id
  const t = tasks.get(id)
  if (!t || hops <= 0) return null
  const next = [t.replyTarget?.messageId, t.rerunReplyTo?.replyTarget?.messageId, ...(t.answerFor || []), t.supersededBy, t.mergedInto].filter((x) => x && x !== id)
  for (const n of next) if (caseIds.has(n)) return n
  for (const n of next) { const c = caseOfTask({ id: n, caseIds, tasks, hops: hops - 1 }); if (c) return c }
  return null
}

const KEY_ID_RE = /^(om_x[0-9a-f]{20,})-/

/**
 * 发件归属。cases：本 sim 的 case 消息（时间线形态：id / chatId / atMs），outbox：按时间排好的发件，tasks：sim 的任务（Map，可省）。
 * 返回 { byCase: Map<caseId, item[]>, orphans: item[] }。
 */
export const attributeOutbox = ({ cases, outbox, tasks = new Map(), webhookChatId = WEBHOOK_CHAT_ID }) => {
  const caseIds = new Set(cases.map((m) => m.id))
  const sorted = [...cases].sort((a, b) => a.atMs - b.atMs)
  const byCase = new Map(cases.map((m) => [m.id, []]))
  const owner = new Map() // 发件 id → case id
  const orphans = []
  for (const item of outbox) {
    let caseId = null
    if (item.parentId && caseIds.has(item.parentId)) caseId = item.parentId
    else if (item.parentId && owner.has(item.parentId)) caseId = owner.get(item.parentId)
    if (!caseId) caseId = caseOfTask({ id: String(item.idempotencyKey || '').match(KEY_ID_RE)?.[1], caseIds, tasks })
    if (!caseId) {
      const named = [...String(item.text || '').matchAll(/om_x[0-9a-f]{20,}/g)].map((x) => x[0]).find((id) => caseIds.has(id))
      if (named) caseId = named
    }
    if (!caseId) {
      const dm = channelOf(item, webhookChatId) === 'dm'
      for (let i = sorted.length - 1; i >= 0; i -= 1) {
        const m = sorted[i]
        if (m.atMs > item.at) continue
        if (item.at - m.atMs > FOLLOW_MS) break
        if (dm || m.chatId === item.chatId) { caseId = m.id; break }
      }
    }
    if (caseId) { byCase.get(caseId).push(item); owner.set(item.id, caseId) } else orphans.push(item)
  }
  return { byCase, orphans }
}

/**
 * 「继续任务 <id> …」没建自己的任务（目标在跑，只回了「正在做」）：点名的任务在模拟里有 → 当作并进了它（裁判看它的终态 / 结论）。
 * b4 742acdf9：私信续跑在跑的 0308f79a，3 分钟后那单出了结论，裁判只看到「正在做」判 stuck。
 */
export const resumedTaskOf = ({ m, sim }) => {
  if (!/继续任务|接着做|续跑/.test(String(m.text || ''))) return null
  let id = [...String(m.text || '').matchAll(/om_x[0-9a-f]{20,}/g)].map((x) => x[0]).find((x) => x !== m.id && sim.tasks.has(x)) || null
  // 点名的单后来被并进 / 顶替了：跟到最后接手的那单（b4 cb660733 点名 108fd4fd，它已并进 2b0063a6）
  for (let hops = 0; id && hops < 4 && sim.mergedInto?.get(id) && sim.mergedInto.get(id) !== m.id; hops += 1) id = sim.mergedInto.get(id)
  return id
}

const EVIDENCE_SKIP_HOST_RE = /(?:^|\.)(?:anthropic\.com|claude\.ai|uniaix\.com|larksuite\.com|feishu\.cn|larkoffice\.com)$/i
/**
 * 裁判的出网证据（P4，b4 4650decc：裁判从「新建 / 修改时带的介绍存得下」推成 lark-bot 写了 pre）：整组 egress.log 按方法 + 主机（写请求再加路径）计数，
 * 回放拦下的标出来。跳过本机、IP 级连接、模型 / Lark 网关。返回 [{ line, write, blocked }]，按次数降序。
 */
export const egressEvidenceOf = (egress = []) => {
  const rows = new Map()
  for (const e of egress) {
    if (!e.host || e.via === 'sock' || e.via === 'lark-cli-shim' || LOCAL_HOST_RE.test(e.host) || EVIDENCE_SKIP_HOST_RE.test(e.host)) continue
    const write = !['GET', 'HEAD', 'OPTIONS'].includes(e.method)
    const blocked = e.extra === 'blocked'
    const key = `${e.method} ${e.host}${write ? ` ${e.path || ''}` : ''}${blocked ? '（回放拦下，没发出）' : ''}`
    const row = rows.get(key) || { line: key, write, blocked, n: 0 }
    row.n += 1
    rows.set(key, row)
  }
  return [...rows.values()].sort((a, b) => b.n - a.n).map((r) => ({ line: `${r.line} ×${r.n}`, write: r.write, blocked: r.blocked }))
}

const WRITE_TALK_RE = /新建|创建|修改|写入|存得下|存进|保存|设成|设为|发帖|发了帖|评论了|上传|提交了|注册|改资料|删除|造了|建了/
/** 哪些 case 给裁判看出网证据：组里有打环境的请求，且这条带造数旗标，或 lark-bot 的话里像是写了东西（裁判会从这类话推断写入）。 */
export const egressRelevant = ({ row, evidence }) => evidence.length > 0
  && ((row.flags || []).includes('sim_limit_testdata') || WRITE_TALK_RE.test(row.lark?.output || ''))

const shortHash = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16)

/** lark-bot 这一侧的事实 + 输出指纹。 */
export const larkFacts = ({ m, items, task = null, mergedIntoId = null, mergedTask = null, audit = null, simDir = null, webhookChatId = WEBHOOK_CHAT_ID }) => {
  const principalDm = m.chatKey === WEBHOOK_CHAT_KEY
  const cls = task?.intake?.classification || null
  const lines = items.map((item) => ({
    at: item.at,
    channel: channelOf(item, webhookChatId),
    toAven: item.userId === AVEN_OPEN_ID || (principalDm && channelOf(item, webhookChatId) === 'dm'),
    kind: item.kind,
    text: normalizeOutputText(item.text, { simDir }),
    raw: item.text,
  }))
  const seen = new Set()
  let duplicates = 0
  for (const l of lines) {
    const key = `${l.channel}\0${l.text}`
    if (seen.has(key)) duplicates += 1
    seen.add(key)
  }
  const group = lines.filter((l) => l.channel === 'group')
  const dms = lines.filter((l) => l.channel === 'dm')
  const replied = group.length > 0 || (principalDm && dms.length > 0)
  const first = (principalDm ? lines : group)[0] || null
  const status = mergedIntoId ? 'merged' : task?.status || null
  const deliverable = task?.contract?.deliverable || cls?.deliverable || null
  const output = [
    `status=${status || '-'} deliverable=${deliverable || '-'}${mergedIntoId ? ` mergedTargetStatus=${mergedTask?.status || '-'}` : ''}`,
    ...lines.map((l) => `[${l.channel}${l.toAven ? ':aven' : ''}] ${l.text}`),
  ].join('\n')
  return {
    decision: cls?.decision || (mergedIntoId ? 'merged' : task ? '(未分类)' : 'ignore'),
    confidence: cls?.confidence || null,
    deliverable,
    continues: cls?.continues || null,
    status,
    taskStatus: task?.status || null,
    mergedInto: mergedIntoId,
    mergedTargetStatus: mergedTask?.status || null,
    auditStatus: audit?.final?.status || audit?.status || null,
    replied,
    replyCount: group.length,
    dmToAven: dms.filter((l) => l.toAven).length,
    dmOther: dms.filter((l) => !l.toAven).length,
    duplicates,
    firstReplyMs: first ? first.at - m.atMs : null,
    lastReplyMs: lines.length ? lines[lines.length - 1].at - m.atMs : null,
    fingerprint: shortHash(output),
    output,
    lines: lines.map(({ at, channel, toAven, raw }) => ({ afterMs: at - m.atMs, channel, toAven, text: raw })),
  }
}

/** falive 当时的对应事实（dataset/episodes.json 的逐条基线；botReplies 是同群 2 小时内 bot 的话，可能含别的事的，只作粗对照）。 */
export const faliveFacts = ({ m, baseline }) => {
  const b = baseline?.baseline || {}
  const replies = b.botReplies || []
  return {
    decision: b.classified?.decision || null, // 网关没分类记录 ≠ 判了 ignore
    confidence: b.classified?.confidence || null,
    replied: replies.length > 0,
    replyCount: replies.length,
    firstReplyMs: replies.length ? replies[0].atMs - m.atMs : null,
    auditStatus: b.audit?.status || null,
  }
}

/** 规则旗标：便宜信号，给汇总 / 验收 / 裁判排序用，不是结论。 */
export const ruleFlags = ({ lark, falive, pending }) => {
  const flags = []
  if (pending) flags.push('pending')
  if (falive.replied && !lark.replied) flags.push('no_reply')
  if (!falive.replied && lark.replied) flags.push('extra_reply')
  if (lark.duplicates > 0) flags.push('duplicate')
  if (falive.decision && lark.decision !== falive.decision) flags.push('decision_diff')
  if (lark.status && NOT_CONCLUDED.has(lark.status)) flags.push('not_concluded')
  if (lark.firstReplyMs != null && falive.firstReplyMs != null && lark.firstReplyMs > falive.firstReplyMs + 10 * 60_000) flags.push('slower')
  return flags
}

/** 一个 sim 目录的全部 case 行。 */
export const computeSimRules = ({ sim, data, scoreFromMs = 0, limitSources = loadSimLimitSources() }) => {
  const cases = casesOfSim({ sim, data, scoreFromMs })
  const { byCase, orphans } = attributeOutbox({ cases, outbox: sim.outbox, tasks: sim.tasks })
  const rows = cases.map((m) => {
    const tag = data.tags.get(m.id) || null
    const task = sim.tasks.get(m.id) || null
    const mergedIntoId = sim.mergedInto.get(m.id) || (task ? null : resumedTaskOf({ m, sim })) || null
    const lark = larkFacts({ m, items: byCase.get(m.id) || [], task, mergedIntoId, mergedTask: mergedIntoId ? sim.tasks.get(mergedIntoId) : null, audit: sim.audits.get(m.id) || null, simDir: sim.dir })
    const falive = faliveFacts({ m, baseline: data.baselines.get(m.id) })
    const pending = Boolean(tag?.pending)
    const simLimits = simLimitsOf({ m, sim, data, lark, task: (mergedIntoId && sim.tasks.get(mergedIntoId)) || task, src: limitSources })
    return {
      id: m.id,
      sim: sim.label,
      episode: sim.episodeId || data.groupOfCase.get(m.id) || null,
      at: new Date(m.atMs).toISOString(),
      chatKey: m.chatKey,
      principalDm: m.chatKey === WEBHOOK_CHAT_KEY,
      kind: tag?.kind || null,
      risk: tag?.risk || [],
      pending,
      rulesVersion: RULES_VERSION,
      fingerprint: lark.fingerprint,
      flags: [...ruleFlags({ lark, falive, pending }), ...simLimits.map((x) => x.flag)],
      simLimits,
      lark,
      falive,
    }
  })
  return { rows, orphans }
}

const main = () => {
  const args = process.argv.slice(2)
  const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
  const sims = listSimDirs(simSelectorFromArgs(args))
  if (!sims.length) {
    console.error('用法：node scripts/sim/judge-rules.mjs --round <轮> | --sim <名> | --dir <路径> [--score-from <ISO>]（没找到 sim 目录）')
    process.exit(2)
  }
  const scoreFromMs = value('--score-from', null) ? Date.parse(value('--score-from', null)) : 0
  const data = loadJudgeData()
  const total = { cases: 0, flags: {}, orphans: 0 }
  for (const entry of sims) {
    const sim = loadSim(entry)
    const { rows, orphans } = computeSimRules({ sim, data, scoreFromMs })
    writeFileSync(join(sim.dir, 'rules.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''))
    total.cases += rows.length
    total.orphans += orphans.length
    for (const r of rows) for (const f of r.flags) total.flags[f] = (total.flags[f] || 0) + 1
    if (!args.includes('--quiet')) console.log(`[rules] ${sim.label}：case ${rows.length}，发件 ${sim.outbox.length}（孤儿 ${orphans.length}），旗标 ${JSON.stringify(rows.reduce((acc, r) => { for (const f of r.flags) acc[f] = (acc[f] || 0) + 1; return acc }, {}))}`)
  }
  console.log(`[rules] ${sims.length} 个 sim 目录，case ${total.cases}，孤儿发件 ${total.orphans}，旗标 ${JSON.stringify(total.flags)}`)
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main()
