/**
 * 裁判这一侧要的 case 数据（只读，都在 replay/falive/ 里跟版本）：285 条 case、时间线、falive 逐条基线、风险标签、
 * 实测类当时证据、事件组。judge-rules / judge-sim / gold / acceptance 共用。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { isAck, loadCaseContext } from './case-context.mjs'
import { casesDir, datasetDir } from './falive-data.mjs'
import { readJsonl } from './sim-dir.mjs'

export const WEBHOOK_CHAT_KEY = 'webhook-group'

let cached = null
export const loadJudgeData = () => {
  if (cached) return cached
  const timeline = JSON.parse(readFileSync(join(datasetDir, 'timeline.json'), 'utf8'))
  const byId = new Map(timeline.map((m) => [m.id, m]))
  const baselines = new Map(JSON.parse(readFileSync(join(datasetDir, 'episodes.json'), 'utf8')).map((e) => [e.id, e]))
  const cases = readJsonl(join(casesDir, 'cases.jsonl'))
  const caseIds = new Set(cases.map((c) => c.id))
  const tags = new Map(readJsonl(join(casesDir, 'case-tags.jsonl')).map((t) => [t.id, t]))
  const evidence = new Map(readJsonl(join(casesDir, 'verification-evidence.jsonl')).map((e) => [e.id, e]))
  const groupsPath = join(casesDir, 'episodes.json')
  const groups = existsSync(groupsPath) ? JSON.parse(readFileSync(groupsPath, 'utf8')).groups || [] : []
  const groupById = new Map(groups.map((g) => [g.id, g]))
  const groupOfCase = new Map(groups.flatMap((g) => g.caseIds.map((id) => [id, g.id])))
  cached = { timeline, byId, baselines, cases, caseIds, tags, evidence, groups, groupById, groupOfCase }
  return cached
}

/** 一个 sim 目录负责判哪些 case：喂进去的 ∩ 285 条 case；新布局再 ∩ 本事件组；--score-from 之前的（热身）不算。 */
export const casesOfSim = ({ sim, data, scoreFromMs = 0 }) => {
  const group = sim.episodeId ? data.groupById.get(sim.episodeId) : null
  const inGroup = group ? new Set(group.caseIds) : null
  return sim.fed
    .filter((id) => data.caseIds.has(id) && (!inGroup || inGroup.has(id)))
    .map((id) => data.byId.get(id))
    .filter((m) => m && m.atMs >= scoreFromMs)
}

const fmt = (ms) => new Date(ms).toISOString().slice(5, 16).replace('T', ' ')
const one = (t, n) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, n)

/** 这条之前的消息：同群最近 recent 条（不含话题内）+ 同话题全部，按时间取最后 max 条，渲染成一行一条。 */
export const contextLinesOf = (m, { data = loadJudgeData(), recent = 10, max = 14, width = 300 } = {}) => {
  const thread = m.threadId ? data.timeline.filter((x) => x.threadId === m.threadId && x.atMs < m.atMs) : []
  const near = data.timeline.filter((x) => x.chatId === m.chatId && x.atMs < m.atMs && !x.threadId).slice(-recent)
  return [...new Set([...near, ...thread])].filter((x) => !x.deleted && x.text && x.senderType !== 'system').sort((a, b) => a.atMs - b.atMs).slice(-max)
    .map((x) => `${x.senderName}${x.ownBot ? '（bot）' : ''}（${fmt(x.atMs)}）：${one(x.text, width)}`)
}

// falive 当时对这条的回复：优先用 case-context 的认领（同群 @ 发话人 / 同话题、按词重合挑实质回复，外加第一句「收到」）；
// 读不到 falive 审计（别的机器 / 夹具）就退回逐条基线的「同群 2 小时内 bot 的话」。
let caseCtx
export const faliveRepliesOf = (m, { data = loadJudgeData() } = {}) => {
  const baseline = data.baselines.get(m.id)?.baseline || {}
  if (caseCtx === undefined) { try { caseCtx = loadCaseContext() } catch { caseCtx = null } }
  if (caseCtx) {
    try {
      const c = caseCtx.contextOf({ id: m.id })
      const picked = [...c.replies.filter((r) => isAck(r.text)).slice(0, 1), ...c.substantive.slice(0, 3)].sort((a, b) => a.atMs - b.atMs)
      if (picked.length || !baseline.botReplies?.length) return picked
    } catch { /* 落到基线 */ }
  }
  return baseline.botReplies || []
}
