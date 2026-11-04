/**
 * falive 当时的 bot 话归哪条 case（逐条，不是按事件组）：episodes.mjs（切组、faliveBotIds）与 round-metrics.mjs（falive 侧时延）共用。
 * 只读 ~/github/lark-bot-falive/runtime/lark-audits/FALIVE（审计 completedAt → 任务 id = case id）。
 *   群里的卡（falive 群里发卡不挂 reply）：审计 completedAt 在卡前 3 分钟内的同群任务；对不上就取同群 6 小时内最近一条、发话人被这张卡 @ 到的 case。
 *   私信（webhook 群 = 负责人私聊）：广播类不归；卡里写了 case 的任务 id → 它；「收到，当作…」「这句没对上」回执 → 之前 10 分钟内最近一条私聊 case；
 *     再按审计完成时间（3 分钟内）；开始 / 结论 / 停下卡最后按 draftOwner（之前最近一张「🛠 开始做」卡的群里最近一条 case）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { faliveRuntimeDir } from './falive-data.mjs'

const OM_RE = /om_x[0-9a-f]{20,}/g
// 不属于任何一单的私信广播（bug 表轮询、日报、体检、部署 / 复测通知、逾期提醒）：不按时间就近归到 case 上（11-04 实测会误归一串 bugpoll）。
export const DM_BROADCAST_RE = /^<card(?: title="[^"]*")?>\s*(?:\[bugpoll\]|日报|🩺|pre 已部署|✅ pre 复测|⏰|⚠ lark-bot|\*\*Falive Web)|^<card title=/

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

/** falive 的审计（全部代，只 .json）。 */
export const loadFaliveAuditFiles = () => {
  const dir = join(faliveRuntimeDir, 'lark-audits', 'FALIVE')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => /-e\d+\.json$/.test(f)).flatMap((f) => { try { return [{ file: f, audit: readJson(join(dir, f)) }] } catch { return [] } })
}

/**
 * timeline：dataset/timeline.json；cases：cases.jsonl 每条加 atMs（ms）与 msg（时间线里的原消息），按时间排好；auditFiles：loadFaliveAuditFiles()。
 * 返回 { completedBefore, draftOwner, groupCardOwner, dmOwner }。
 */
export const createFaliveBotOwners = ({ timeline, cases, auditFiles }) => {
  const caseById = new Map(cases.map((c) => [c.id, c]))
  const dmCases = cases.filter((c) => c.kind === 'principal_dm')
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
  /** 群里一张 bot 卡答的是哪条 case：{ owner, how } 或 null。 */
  const groupCardOwner = (card) => {
    const byAudit = completedBefore(card, true)
    if (byAudit) return { owner: byAudit, how: '审计完成时间' }
    const owner = cases.filter((c) => c.msg?.chatId === card.chatId && c.atMs < card.atMs && card.atMs - c.atMs < 6 * 3600_000 && c.msg?.senderId && (card.cliText ?? card.text).includes(c.msg.senderId)).at(-1)?.id || null
    return owner ? { owner, how: '卡里 @ 了发话人' } : null
  }
  /** 私信里一条 bot 话归哪条 case（case id 或 null）。 */
  const dmOwner = (m) => {
    if (DM_BROADCAST_RE.test(m.text)) return null
    const named = (String(m.cliText ?? m.text).match(OM_RE) || []).find((id) => caseById.has(id)) || null
    const owner = named
      || (/^<card>\s*(?:收到，当作|这句没对上)/.test(m.text) ? dmCases.filter((c) => c.atMs <= m.atMs && m.atMs - c.atMs < 10 * 60_000).at(-1)?.id || null : null)
      || completedBefore(m, false)
      || (/^<card>\s*(?:🛠 开始做|✅|⏸|⛔|ℹ️)/.test(m.text) ? draftOwner(m) : null)
    return owner && caseById.has(owner) ? owner : null
  }
  return { completedBefore, draftOwner, groupCardOwner, dmOwner }
}
