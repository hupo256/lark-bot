/**
 * run-sim-falive 的「按窗口起点还原 falive 当时状态」补丁（11-04 校准保真度分析查出的模拟偏差，见 replay/falive/calibration/fidelity.md）。
 * 全是纯函数（IO 在 run-sim-falive），供单测：
 *   · taskStubsFromAudits：任务库没还原 → 私聊「已部署 / 已发布 / 帮我合」锚不到「12 小时内发给你的任务通知」，回「这句没对上任务」。
 *     falive 的任务库存档只剩 11-02 起（终态 24 小时就清），这里按审计（10-27 起）补出窗口前 24 小时内了结、72 小时内挂起的任务，带私聊回执时刻。
 *   · sweepForSim：原来整段删掉 dailyReport.sweep 关部署盯梢，连「推 pre」的负责人判定（要求开了清扫）一起关了 → 私聊「推 pre」被当成非负责人忽略。
 *     改成只去掉 preSiteUrl / onDeploy（不配就不盯部署、不跑脚本），清扫本身留着。
 *   · privateOnlyAt：配置备份按 mtime 取，可 10-27 10:27Z–11:00Z 之间 privateOnlyChats 被改过却没留备份 → 那时融合群「只私聊不发群」，模拟里照发群。
 *     按网关日志里的实际行为（「<群> 只私聊不发群」 vs 「repo ack|group reply <id> ok」）取窗口起点那一刻每个群的状态。
 *   · ownRootsToKeep：组内 falive 当时的 bot 话不供（由模拟 bot 自己回），可有人在那张卡下开了话题——卡不在，轮询发现不了这个话题，回复永远收不到
 *     （ep-1027 C2「文档在哪里」、ep-1030 C4）。这类话题根照供，代价是群里同一件事 falive 原话和模拟 bot 的话都在。
 */

const TERMINAL = new Set(['done', 'done_with_warnings', 'no_change_needed', 'ignored', 'superseded', 'failed'])
const PARKED = new Set(['blocked', 'waiting_confirmation'])

/**
 * audits: [{ taskId, epoch, audit }]（同一任务多代都给）；返回窗口起点那一刻任务库里该有的任务（最少字段，够控制台锚定 / 续跑 / 指示任务用）。
 *   取 startedAt < fromMs 的最新一代；completedAt ≥ fromMs 的是窗口前在飞的（还原不了，列进 inFlight）；
 *   了结的留 24 小时内（同 falive 的 pruneDoneAfterHours 默认）、挂起的留 72 小时内。
 */
export const taskStubsFromAudits = ({ audits, fromMs, senderOf = () => null, owner = null, doneKeepMs = 24 * 3600_000, parkedKeepMs = 72 * 3600_000 }) => {
  const latest = new Map()
  for (const a of audits) {
    const started = Date.parse(a.audit?.startedAt || '')
    if (!a.taskId || !Number.isFinite(started) || started >= fromMs) continue
    const prev = latest.get(a.taskId)
    if (!prev || (a.epoch ?? 0) > (prev.epoch ?? 0)) latest.set(a.taskId, a)
  }
  const stubs = []
  const inFlight = []
  for (const { taskId, epoch, audit } of latest.values()) {
    const startedAt = audit.startedAt
    const completedMs = Date.parse(audit.completedAt || '')
    const status = audit.final?.status || audit.status || null
    if (!Number.isFinite(completedMs) || completedMs >= fromMs) { inFlight.push(taskId); continue }
    const age = fromMs - completedMs
    if (!(TERMINAL.has(status) && age <= doneKeepMs) && !(PARKED.has(status) && age <= parkedKeepMs)) continue
    const task = audit.task || {}
    stubs.push({
      id: taskId,
      source: task.source || 'lark',
      repo: audit.repo || 'falive',
      project: audit.project || 'FALIVE',
      chatId: task.chatId || null,
      messageId: task.messageId || taskId,
      operator: senderOf(taskId) || (task.source === 'daily-sweep' ? owner : null),
      summary: task.summary || null,
      text: task.text || '',
      attachments: [],
      status,
      createdAt: startedAt,
      updatedAt: audit.completedAt,
      claimedAt: null,
      epoch: epoch ?? 0,
      result: audit.gateway?.result || audit.final?.summary || null,
      receipts: [
        { messageId: `webhook:start:${Date.parse(startedAt)}`, kind: 'start', epoch: epoch ?? 0, createdAt: startedAt },
        { messageId: `webhook:${status}:${completedMs}`, kind: status, epoch: epoch ?? 0, createdAt: audit.completedAt },
      ],
      restoredFrom: 'audit', // 模拟还原的占位任务（不是 falive 当时的完整任务对象）
    })
  }
  return { stubs, inFlight }
}

export const sweepForSim = (sweep) => {
  if (!sweep || typeof sweep !== 'object') return sweep
  const { preSiteUrl, onDeploy, deployWatchHours, ...rest } = sweep
  return rest
}

/**
 * 网关日志 → 每个群「只私聊」与否的行为证据。logLines：网关日志行；chatOfId：消息 id → { chatId, atMs }（时间线）。
 * 返回 [{ chatId, atMs, privateOnly }]（按时间）。
 */
export const privateOnlyEvidence = ({ logLines, chatOfId }) => {
  const out = []
  for (const line of logLines) {
    const m = /repo (?:ack|group reply) (om_x[0-9a-f]+)(?: ok\b|：.* 只私聊不发群)/.exec(line)
    if (!m) continue
    const at = chatOfId(m[1])
    if (!at) continue
    out.push({ chatId: at.chatId, atMs: at.atMs, privateOnly: / 只私聊不发群/.test(line) })
  }
  return out.sort((a, b) => a.atMs - b.atMs)
}
/** 某时刻每个群的状态：取该时刻之前最后一条证据；之前没有就取之后第一条（同一段配置）；都没有就按配置。 */
export const privateOnlyAt = ({ evidence, atMs, chatIds, configured = [] }) => chatIds.filter((chatId) => {
  const list = evidence.filter((e) => e.chatId === chatId)
  const before = list.filter((e) => e.atMs <= atMs).at(-1)
  const after = list.find((e) => e.atMs > atMs)
  const hit = before || after
  return hit ? hit.privateOnly : configured.includes(chatId)
})

/**
 * 组内会喂的人话里，挂在 falive 窗口内自己发的卡下面的话题回复：那张卡（话题根）照供。只认话题（有 threadId），普通「回复」不加——
 * 被回复的卡假 CLI 按时间线就能取到（引用块里看得到原话），没必要让它也出现在群历史里和模拟 bot 的话重复。
 */
export const ownRootsToKeep = ({ timeline, fromMs, untilMs, hidden = new Set() }) => {
  const byId = new Map(timeline.map((m) => [m.id, m]))
  const keep = new Set()
  for (const m of timeline) {
    if (m.ownBot || m.deleted || !m.threadId || m.atMs < fromMs || m.atMs > untilMs || hidden.has(m.id)) continue
    const root = byId.get(m.rootId || m.parentId)
    if (root?.ownBot && root.threadId === m.threadId && root.atMs >= fromMs && root.atMs < m.atMs) keep.add(root.id)
  }
  return [...keep]
}
