/**
 * 任务的人话出口（改写自 falive lark-repo-delivery，去 webhook / profile / 台账；对话层 11-01）。
 * 出口只有两条：群里回复原消息（结论、收到、记下了、要材料、放行的草稿）；负责人（config.notifyOpenId）私信（开始、扣下的草稿、
 * 没做成、疑似、判错了、答应了没结论）。文案全部在 lib/lark-human-text.mjs，发送全部走 lib/lark-group-exit.mjs。
 * 数据源是结构化结果 task.outcome（normalizeOutcome 过的）；旧任务没有 outcome 时从 result 文本里抠（humanizeLegacyResult）。
 * 回复义务（lib/lark-reply-obligation.mjs）：发了 noteAnswer，扣下 noteHeld（草稿），回过「收到」却没结论 noteOwed。
 * aven 自己私信发起的任务（chatId 是 ou_）：「群」就是他的私信，不扣草稿、不另发一条私信；运维 / 没做成的文案直接发到私信。
 */

import { buildBlockedAskText, extractLegacyBlockers, externalBlockers, internalNamePattern, nameIn } from './lark-blocked-ask.mjs'
import { publishMarkdownDoc } from './lark-docs.mjs'
import { replyKeyFor, sendPrincipalNote, sendReply } from './lark-group-exit.mjs'
import {
  chatLabel, headline, humanizeLegacyResult, sayAck, sayDoneAnswerGroup, sayDoneAnswerPrincipal, sayDoneChangeGroup, sayDoneChangePrincipal,
  sayFailedPrincipal, sayHeldDraft, sayHeldFailed, sayHeldReleased, sayHeldStale, sayIgnoredAfterAck, sayMergedSupplement, sayNoChangeGroup, sayNoted, sayOps, sayOverdue,
  sayOwnItemsPrincipal, sayStart, saySuspected, trimPunct, who,
} from './lark-human-text.mjs'
import { listOutbox } from './lark-outbox.mjs'
import { clearHeldDraft, getObligation, heldDraftFor, listOverdueObligations, markAnsweredFromOutbox, markOverdueNotified, noteAck, noteAnswer, noteHeld, noteOwed } from './lark-reply-obligation.mjs'
import { renderReport } from './lark-report-render.mjs'
import { isControlActiveStatus } from './lark-task-store.mjs'

// 交付物只读契约（I2）；没契约的旧任务按命令类型折算：运维 → ops，只读查询 → answer，其余改码。
export const deliverableOf = (task) => task?.contract?.deliverable || (task?.commandType === 'ops' ? 'ops' : task?.commandType === 'status' ? 'answer' : 'change')
const isAnswerLike = (task) => ['answer', 'verification'].includes(deliverableOf(task))
// 负责人私信里发起的任务：p2p 会话（chat_id 是 oc_ 的 p2p 群，老任务 / 手工投递的是 ou_）或入口是私信。
export const isDmOriginTask = (task) => task?.chatType === 'p2p' || task?.intake?.trigger === 'dm' || String(task?.chatId || '').startsWith('ou_')
const isDmOrigin = isDmOriginTask
const PARKED = new Set(['blocked', 'waiting_confirmation'])
// 真出结论的终态：并入人的「补充也一起处理了」与 mergedNotified 只在这两种状态做（代答类 blocked / failed 也发群，但不是结论；fix10 review）。
const CONCLUDED = new Set(['done', 'no_change_needed'])
// 幂等键短码（§4.2）：同一任务同一代次同一种结论只发一次。
const STATUS_CODE = { done: 'done', failed: 'fail', no_change_needed: 'noop', blocked: 'blk', waiting_confirmation: 'wait' }

// 旧任务（没有 outcome）：从 result 文本抠出摘要 / 下一步 / 待补充，形状对齐 normalizeOutcome。
export const legacyOutcome = (task) => {
  const lines = humanizeLegacyResult(task?.result)
  const take = (prefix) => {
    const index = lines.findIndex((line) => line.startsWith(prefix))
    return index < 0 ? null : lines.splice(index, 1)[0].slice(prefix.length).trim()
  }
  const blockers = extractLegacyBlockers(task?.result)
  take('待补充：')
  const nextStep = take('下一步：')
  return {
    kind: 'ai', summary: lines.join('\n') || null, nextStep, blockers, report: null, groupReply: null, detailDoc: null, followUps: null,
    changedFiles: Array.isArray(task?.changedFiles) ? task.changedFiles : null, owner: task?.owner || null, groupSilent: false, text: task?.result || null,
  }
}
const outcomeOf = (task) => task?.outcome || legacyOutcome(task)
const labelOf = (task, config, deps) => chatLabel(task, { chatNames: deps.chatNames || config.chatNames || {} })
const firstLine = (text) => trimPunct(String(text || '').split('\n').find((line) => line.trim()) || '')
// 有完成旁证（worker 自愈环：结果文件丢了但有新提交）：不说「没做成」，说「可能做成了但没拿到结果」。
const isProbablyDone = (task, outcome) => /活可能已经干成|可能做成了/.test(String(outcome?.text || task?.result || ''))

// 待跟进的人（执行器写的 followUps）→ ownerMap 反查 open_id：精确命中 key，否则 key 作为关键词包含匹配；没命中保留名字（文案里只写 @名）。
export const mentionsFor = ({ followUps = [], ownerMap = {} }) => {
  const seen = new Set()
  const out = []
  for (const item of followUps || []) {
    const name = String(item?.owner || '').trim()
    if (!name) continue
    const lower = name.toLowerCase()
    const hit = Object.entries(ownerMap).find(([key]) => key.toLowerCase() === lower)
      || Object.entries(ownerMap).find(([key]) => key && (lower.includes(key.toLowerCase()) || key.toLowerCase().includes(lower)))
    if (hit && seen.has(hit[1])) continue
    if (hit) seen.add(hit[1])
    out.push({ name: hit ? hit[0] : name, openId: hit ? hit[1] : null, items: Array.isArray(item.items) ? item.items : [] })
  }
  return out
}

// 要材料时 @ 谁：责任人（执行器写的 owner）+ 待补充里点名的外部同事（ownerMap 里有、不是内部名单里的）+ 待补充里点名、在本条上下文里说过话的人
//（task.contextPeople，不在 ownerMap 里也有 open_id，名字大小写一致才算；11-05 b3 ep-1027-5e6172）；都没有就 @ 发起人。按 open_id 去重。
// 负责人本人（notifyOpenId）不 @——他看私信。falive 10-22 真机：「要 William、Encone 或测试 HTStone.z 给一个…」一个都没 @，当事人看不到不会补。
export const blockedAskMentions = ({ task, config = {}, blockers = [] }) => {
  const ownerMap = config.ownerMap || {}
  const internal = internalNamePattern(config)
  const me = config.notifyOpenId || null
  const text = blockers.join('\n')
  const external = (name) => !(internal && internal.test(name))
  const named = Object.keys(ownerMap).filter((name) => external(name) && nameIn(text, name)).map((owner) => ({ owner, items: blockers }))
  const owner = task?.outcome?.owner || task?.owner || null
  const seen = new Set()
  const fromContext = Object.entries(task?.contextPeople || {}).filter(([name]) => external(name) && nameIn(text, name, { caseSensitive: true })).map(([name, openId]) => ({ name, openId, items: blockers }))
  const out = [...mentionsFor({ followUps: [...(owner ? [{ owner, items: blockers }] : []), ...named], ownerMap }), ...fromContext]
    .filter((m) => m.openId && m.openId !== me && !seen.has(m.openId) && seen.add(m.openId))
  if (out.length) return out
  const operator = task?.operator || ''
  if (!operator.startsWith('ou_') || operator === me) return []
  const hit = Object.entries(ownerMap).find(([, id]) => id === operator)
  return [{ name: hit ? hit[0] : '', openId: operator, items: blockers }]
}

// 代答 / 实测的结论是给提问人的：回复的那条消息的发送人（task.operator）不是负责人、也不在要 @ 的待跟进里 → 行首 @ 他
//（回落直发时群里才知道是对谁说的；回复原消息时 @ 一下也更清楚）。非 ou_ 的（群 id / 空）不 @。
const answerAsker = ({ task, config = {}, mentions = [] }) => {
  const operator = String(task?.operator || '')
  if (!operator.startsWith('ou_') || operator === config.notifyOpenId || mentions.some((m) => m.openId === operator)) return null
  const hit = Object.entries(config.ownerMap || {}).find(([, id]) => id === operator)
  return { name: hit ? hit[0] : '', openId: operator, items: [] }
}

// 并入的别人的消息（lark-task-merge appended / rerun_after_done 只记 mergedFrom、结论仍回原消息）：本轮结论末行 @ 那些提单人，否则他们只得到一句「收到」
//（11-03 静态 review R8 后半）。按 mergedFrom 去 store 取 operator：去重，排除负责人、本任务提单人、bot、已在 @ 里的、非 ou_ 的、已清掉的。
// 还欠一轮重跑（rerunAfterDone）时这轮没带上补充，留给重跑那轮；已经 @ 过的（task.mergedNotified）不再 @。
const mergedAskers = ({ task, store, config = {}, exclude = [] }) => {
  if (task?.rerunAfterDone === true) return []
  const notified = new Set(task?.mergedNotified || [])
  const skip = new Set([config.notifyOpenId, config.botOpenId, task?.operator, ...exclude.map((m) => m?.openId)].filter(Boolean))
  const out = []
  for (const id of task?.mergedFrom || []) {
    const openId = notified.has(id) ? '' : String(store?.get?.(id)?.operator || '')
    if (!openId.startsWith('ou_') || skip.has(openId)) continue
    skip.add(openId)
    const hit = Object.entries(config.ownerMap || {}).find(([, value]) => value === openId)
    out.push({ name: hit ? hit[0] : '', openId, items: [] })
  }
  return out
}

// 这次的回答发不发群（§4.3；falive 10-21 P3：核验闸只管改动能不能提交，不再连带把回答丢掉）。纯函数，返回 { mode: post | hold | none, reason }：
//   · groupSilent（执行侧显式判群里无事可说）→ none；
//   · answer / verification 写了 report / groupReply → post（不看 status，回答不依赖提交）；
//   · done / no_change_needed → post（没写回复的由调用方按「没写群回复」处理）；
//   · change 类其它终态写了回复 → hold：没做成的事不能当结论发出去，草稿私信负责人，回「就这样回」再发；
//   · 其它终态没写回复 → none（阻塞要材料另有出口 blocked_ask）。
export const decideGroupReply = ({ task, status }) => {
  const outcome = task?.outcome || null
  if (outcome?.groupSilent) return { mode: 'none', reason: '执行侧判群里无事可说' }
  const hasReply = Boolean(outcome?.report || outcome?.groupReply)
  if (isAnswerLike(task) && hasReply) return { mode: 'post', reason: null }
  if (status === 'done' || status === 'no_change_needed') return { mode: 'post', reason: null }
  if (!hasReply) return { mode: 'none', reason: null }
  const why = outcome.change?.committed === false ? `改动没提交（${outcome.change.gate || '?'}：${outcome.change.reason || ''}）` : `任务没做成（${status}）`
  return { mode: 'hold', reason: `${why}，回答先给你看` }
}

// 群里那段：改码 done → 摘要首句 + 事实 + 待跟进 + 详细见；no_change → 看过了不用改；代答 / 实测 → report 渲染；扣下的草稿 → report / groupReply 原文。
const composeGroupText = ({ task, status, outcome, mentions, asker, docUrl }) => {
  if (isAnswerLike(task)) return sayDoneAnswerGroup({ outcome, mentions, asker, docUrl })
  if (status === 'done') return sayDoneChangeGroup({ task, outcome, mentions, docUrl })
  if (status === 'no_change_needed') return outcome.summary ? sayNoChangeGroup({ outcome, mentions }) : ''
  const body = renderReport(outcome.report) || outcome.groupReply || ''
  return body && docUrl ? `${body}\n详细见：${docUrl}` : body
}

const principalNote = ({ config, store, task, text, kind, deps }) => sendPrincipalNote({ config, store, text, taskId: task.id, kind, idempotencyKey: replyKeyFor(task, `pn-${kind.slice(0, 2)}`), deps })

// 任务结束：群里一段（按 decideGroupReply）+ 阻塞要材料 + 回复义务 + 负责人私信。返回 { ok, messageId, reason }，ok = 主交付发出去了
//（群里发了 / 扣下并私信了 / 只私信的发了）。
export const deliverOutcome = async ({ config = {}, store, task, status, deps = {} }) => {
  const outcome = outcomeOf(task)
  const where = labelOf(task, config, deps)
  const dm = isDmOrigin(task)
  const deliverable = deliverableOf(task)
  // 日报（lib/lark-daily-report.mjs）worker 已经自己私发了，出口不再说话。
  if (deliverable === 'daily') return { ok: true, messageId: null, reason: null }
  if (deliverable === 'ops') {
    const sent = await principalNote({ config, store, task, text: sayOps({ text: outcome.text || outcome.summary || '', failed: status === 'failed' }), kind: 'ops', deps })
    return { ok: sent.ok, messageId: sent.messageId, reason: sent.reason }
  }
  const decision = decideGroupReply({ task, status })
  // aven 自己私信发起的：「群」就是他的私信，没有扣草稿这回事。
  const mode = dm && decision.mode === 'hold' ? 'post' : decision.mode
  let docUrl = null
  let docMs = null
  let text = ''
  // 待跟进的 @ 只在做成时才有意义（群里每人一行）。
  // 负责人本人不 @（他看私信；11-03 falive 回放 10-30：结论里「找 aven」把群里 @ 了 aven 讲内部限制，扰民），与 blockedAskMentions 同口径；
  // 他的事项改进给他的私信（ownItems），不能丢（fix10 review）。他私信发起的「群」就是私信，照常列。
  // 不用改（no_change_needed）也算做成：对接答复逐项复测后归别人跟的照样每人一行（11-04 b3）。
  const doneMentions = CONCLUDED.has(status) ? mentionsFor({ followUps: outcome.followUps || [], ownerMap: config.ownerMap || {} }) : []
  const isPrincipal = (m) => !dm && Boolean(m.openId) && m.openId === config.notifyOpenId
  const followUpMentions = doneMentions.filter((m) => !isPrincipal(m))
  const ownItems = doneMentions.filter(isPrincipal).flatMap((m) => m.items)
  // 代答 / 实测：只 @ 要动手的（没写事项的不 @），行首 @ 提问人（11-03 falive 回放 wrong_target）。改码类照旧。
  const mentions = isAnswerLike(task) ? followUpMentions.filter((m) => m.items.length) : followUpMentions
  const asker = isAnswerLike(task) && !dm ? answerAsker({ task, config, mentions }) : null
  const merged = dm || !CONCLUDED.has(status) ? [] : mergedAskers({ task, store, config, exclude: [...mentions, asker] })
  const replyMentions = [...(asker ? [asker] : []), ...mentions, ...merged]
  if (mode !== 'none') {
    // 细节（curl、复现步骤、逐项证据）放文档，群里只附链接；建不成就不附（正文本身是结论，不丢）。
    // 建成的 docUrl 按「任务 + 代次 + 状态」记在 task.publishedDoc（与回复幂等键同一把）：回执没送达时 retryPendingReceipts 每 5 分钟重跑本函数，
    // 原先每次都新建一份同内容文档（上限 12 份，11-03 静态 review R12）；同键复用，换代 / 换状态才另建。
    if (outcome.detailDoc) {
      const docKey = replyKeyFor(task, STATUS_CODE[status] || 'st')
      if (task.publishedDoc?.key === docKey && task.publishedDoc.url) {
        docUrl = task.publishedDoc.url
      } else {
        const docStartedAt = Date.now()
        docUrl = (await (deps.publish || publishMarkdownDoc)({ title: `${headline(task) || task.id}（细节）`, markdown: outcome.detailDoc, identity: config.docIdentity || 'user' })).url || null
        docMs = Date.now() - docStartedAt // 时延记账：建细节文档单独记一段（lib/lark-latency）
        if (docUrl) {
          task.publishedDoc = { key: docKey, url: docUrl }
          store?.upsert?.(task)
        }
      }
    }
    text = composeGroupText({ task, status, outcome, mentions, asker, docUrl })
    if (text && merged.length) text = `${text}\n${sayMergedSupplement({ mentions: merged })}`
  }
  let groupOutcome = null
  if (mode !== 'none' && !text) groupOutcome = { ok: false, missingReply: true, reason: '没写群回复', text: '' }
  else if (mode === 'hold') groupOutcome = { ok: false, held: true, reason: decision.reason, text, mentions: replyMentions }
  else if (mode === 'post') {
    // 改码 done 带了复测条目（兑现「收到」里答应的只读事）：超长转文档时条目开头几行留在群里，不只留改码摘要。
    const keepLeading = deliverable === 'change' && status === 'done' && Boolean(outcome.report?.items?.length)
    const sent = await sendReply({ config, store, task, phase: 'done', text, mentions: replyMentions, idempotencyKey: replyKeyFor(task, STATUS_CODE[status] || 'st'), keepLeading, deps })
    groupOutcome = sent.ok ? { ok: true, text, messageId: sent.messageId } : { ok: false, gated: sent.gated, reason: sent.reason, text }
    // 这轮结论覆盖到的并入都记下（含本来就不用 @ 的）：下一轮（换提单人的重开 / 续跑）不再 @ 他们。
    if (sent.ok && CONCLUDED.has(status) && task.mergedFrom?.length && task.rerunAfterDone !== true) {
      task.mergedNotified = [...task.mergedFrom]
      store?.upsert?.(task)
    }
  }
  // 阻塞 / 缺材料（改码类）：群里 @ 责任人要材料。交办时已说明在等什么（task.waitsFor）或疑似任务不往群里要；一个可 @ 的人都没有只私信负责人。
  if (deliverable === 'change' && PARKED.has(status) && !dm && !task.suspected && !task.waitsFor) {
    const blockers = externalBlockers(outcome.blockers || [], { config })
    const askMentions = blockers.length ? blockedAskMentions({ task, config, blockers }) : []
    if (askMentions.length) {
      const askText = buildBlockedAskText({ task, mentions: askMentions, blockers })
      const sent = await sendReply({ config, store, task, phase: 'blocked_ask', text: askText, mentions: askMentions, idempotencyKey: replyKeyFor(task, 'ask'), deps })
      if (!groupOutcome?.ok) groupOutcome = sent.ok ? { ok: true, text: askText, messageId: sent.messageId, asked: true } : { ok: false, reason: sent.reason, text: askText }
    }
  }
  const obligation = getObligation(task)
  const ackText = obligation?.ackText || task.ackReply || null
  if (groupOutcome?.ok) noteAnswer({ task, text: groupOutcome.text })
  else if (groupOutcome?.held) noteHeld({ task, text: groupOutcome.text, mentions: replyMentions, reason: groupOutcome.reason })
  else if (obligation?.ackedAt) noteOwed({ task, status })
  const note = principalTextFor({ task, config, status, outcome, where, dm, groupOutcome, ackText, asker, ownItems })
  const sent = note ? await principalNote({ config, store, task, text: note.text, kind: note.kind, deps }) : null
  // ok：群里发了；或扣下 / 只私信的那条私信发了。群里没发、私信也没发（或没什么可说）就不算交付。
  const ok = Boolean(groupOutcome?.ok) || (Boolean(sent?.ok) && (Boolean(groupOutcome?.held) || !groupOutcome))
  const reason = groupOutcome?.ok ? null : groupOutcome?.reason || sent?.reason || null
  return { ok, messageId: groupOutcome?.messageId || sent?.messageId || null, reason, groupOutcome, docUrl, docMs }
}

// 负责人在私信里点名续跑的这一轮（handleResume 记 task.resumeAsk，代次对得上才算）：结论 / 找人要材料都在群里，他私信里只剩一句「接着做」
//（b3 ep-1023-9f0fd7「继续任务 <id>」、ep-1030-167d28「自己登录进去看看，这个是账号…」：续跑真跑了、群里 @ 了人，私信里没下文）。
export const resumedFromPrincipalDm = (task, config = {}) =>
  Boolean(task?.resumeAsk?.by) && task.resumeAsk.by === config.notifyOpenId && task.resumeAsk.epoch === (task.epoch || 0)
const sayResumedPrincipal = ({ task, where, status, outcome, groupOutcome }) => {
  const head = headline(task)
  if (PARKED.has(status)) {
    const blockers = (outcome?.blockers || []).join('；')
    return [`⏸ 接着做的「${head}」又停下了（${where}），已在群里找人要材料`, blockers ? `要：${blockers.slice(0, 600)}` : null].filter(Boolean).join('\n')
  }
  return `📨 接着做的「${head}」有结论了（${where}），群里已回：${firstLine(groupOutcome?.text).slice(0, 200)}`
}

// 负责人私信说什么（§4.1）：扣下的发草稿；没做成的一条（含旁证）；停下来又没人可 @ 的一条（⏸ + 要：…）；
// aven 自己私信发起的到此为止（结论已经回在他的私信里）；change done 一条「✅ + 群里已回」；代答成功且他不是提单人一条；其余有他的事项单发一条。
// 返回 { text, kind }（kind 是回执类型，主通道按它锚回）或 null。
const principalTextFor = ({ task, config, status, outcome, where, dm, groupOutcome, ackText, asker = null, ownItems = [] }) => {
  if (groupOutcome?.held) return { text: sayHeldDraft({ task, chatLabel: where, status, outcome, ackText, draft: groupOutcome.text }), kind: 'held' }
  if (status === 'failed' && !groupOutcome?.ok) return { text: sayFailedPrincipal({ task, chatLabel: where, outcome, probablyDone: isProbablyDone(task, outcome) }), kind: 'failed' }
  if (PARKED.has(status) && !groupOutcome?.ok) return { text: sayHeldDraft({ task, chatLabel: where, status, outcome, ackText, draft: '' }), kind: status === 'blocked' ? 'blocked' : 'waiting' }
  if (dm) return null
  if (deliverableOf(task) === 'change' && status === 'done') return { text: sayDoneChangePrincipal({ task, chatLabel: where, groupOutcome, ownItems }), kind: 'done' }
  // 他自己提的不私信（结论就回在他的消息下）；待跟进里有他的事项时仍私信，群里没列。
  if (isAnswerLike(task) && groupOutcome?.ok && (task.operator !== config.notifyOpenId || ownItems.length)) {
    // 首行去掉行首对提问人的 @（私信里只要答案；群里那段有 asker 时一定以它开头）。
    const prefix = asker ? `${who([asker])} ` : ''
    return { text: sayDoneAnswerPrincipal({ chatLabel: where, firstLine: firstLine(groupOutcome.text).slice(prefix.length), ownItems }), kind: 'answered' }
  }
  // 他这边的事项：代答群里没发成（闸拦 / 没写回复）、groupSilent、交付物本不私信（record）时也单发一条，不能丢（fix16 review）；
  // 群里发成功那条（上面两格）已含就走不到这。代答类用同一 kind（幂等键 pn-an）：回执重试时群里补发成功不再私信第二遍。
  if (ownItems.length) return { text: sayOwnItemsPrincipal({ task, chatLabel: where, groupOutcome, ownItems }), kind: isAnswerLike(task) ? 'answered' : 'done' }
  if (groupOutcome?.ok && resumedFromPrincipalDm(task, config)) return { text: sayResumedPrincipal({ task, where, status, outcome, groupOutcome }), kind: 'resumed' }
  return null
}

// 「收到」：分类器按上下文写的那句（有就用），没有用固定句；发成了开义务。负责人私聊指示（privateOrigin）群里没人在等，不回。
export const deliverAck = async ({ config = {}, store, task, reply = null, deps = {} }) => {
  if (task.privateOrigin) return { ok: false, skipped: true, reason: 'private origin' }
  const text = sayAck({ reply })
  const sent = await sendReply({ config, store, task, phase: 'ack', text, idempotencyKey: replyKeyFor(task, 'ack'), deps })
  if (sent.ok) noteAck({ task, text })
  return sent
}

// 「记下了」：@ 了 bot、最后判定不用处理——不能没下文；就是这条的下文，义务到此了结（falive #74）。
export const deliverNoted = async ({ config = {}, store, task, reply = null, deps = {} }) => {
  if (task.privateOrigin) return { ok: false, skipped: true, reason: 'private origin' }
  const text = sayNoted({ reply })
  const sent = await sendReply({ config, store, task, phase: 'noted', text, idempotencyKey: replyKeyFor(task, 'nt'), deps })
  if (sent.ok) noteAnswer({ task, text })
  return sent
}

// 已在群里回过「收到」、最后却判断不用处理：私信负责人一句，别让人以为 bot 死了。
export const deliverIgnoredAfterAck = async ({ config = {}, store, task, reason = null, deps = {} }) => {
  const why = reason || task.intake?.classification?.reason || task.intake?.classification?.summary || null
  return principalNote({ config, store, task, text: sayIgnoredAfterAck({ task, chatLabel: labelOf(task, config, deps), reason: why }), kind: 'ignored_after_ack', deps })
}

// 疑似（分类拿不准 / 没叫 bot）：只私信负责人问一句，不催。
export const deliverSuspected = async ({ config = {}, store, task, deps = {} }) => principalNote({ config, store, task, text: saySuspected({ task, chatLabel: labelOf(task, config, deps) }), kind: 'suspected', deps })

// 任务开始：只私信负责人一行；他自己私信发起的不发（他在等结论，不用知会开始）。
export const deliverStart = async ({ config = {}, store, task, deps = {} }) => {
  if (isDmOrigin(task)) return { ok: false, skipped: true, reason: 'dm origin' }
  return principalNote({ config, store, task, text: sayStart({ task, chatLabel: labelOf(task, config, deps), resumeCount: task.resumeCount || task.rerunCount }), kind: 'start', deps })
}

// 负责人放行被扣下的群回复（「就这样回」）：按原文发群，不重跑。草稿存在回复义务上；扣下之后又有更新的结论发出去了就没草稿可放（stale）。
// 返回 { ok, reason, stale, messageId, note }：note 是回给负责人的那句（调用方发到私信）。
export const deliverHeldGroupReply = async ({ config = {}, store, task, deps = {} }) => {
  const held = heldDraftFor(task)
  if (!held?.text) return { ok: false, stale: true, reason: 'no held draft', messageId: null, note: sayHeldStale({ task }) }
  const mentions = Array.isArray(held.mentions) ? held.mentions : []
  const sent = await sendReply({ config, store, task, phase: 'held_release', text: held.text, mentions, idempotencyKey: replyKeyFor(task, 'rel'), deps })
  if (!sent.ok) return { ok: false, stale: false, reason: sent.reason, messageId: null, note: sayHeldFailed({ reason: sent.reason }) }
  noteAnswer({ task, text: held.text })
  clearHeldDraft({ task })
  return { ok: true, stale: false, reason: null, messageId: sent.messageId, note: sayHeldReleased({ task }) }
}

// 答应了却迟迟没结论（执行器崩了 / 任务丢了）：私信负责人一次，不发群。网关挂起巡检时顺带跑。
// 提醒前先查：发件簿里其实已经发过结论（某条出口漏了 noteAnswer）就补记 answered；任务已了结（done / 结单 / 已答）说明他知道，也不提醒；
// 挂起等他 / 等材料的（疑似 / 追问 / blocked / waiting）和他私信发起的也不提醒（11-02 复核）。
const ANSWER_PHASES = new Set(['noted', 'done', 'blocked_ask', 'held_release', 'self_answer', 'ask_back'])
export const deliverOverdueObligations = async ({ config = {}, store, now = Date.now(), deps = {} }) => {
  const chatIds = [...new Set(store.list().map((task) => task.chatId).filter(Boolean))]
  let count = 0
  for (const item of listOverdueObligations({ chatIds, now })) {
    const taskIds = new Set([item.id, ...(item.taskIds || [])])
    const answered = listOutbox({ chatId: item.chatId, sinceMs: Date.parse(item.ackedAt || '') || 0 }).findLast((entry) => !entry.gated && taskIds.has(entry.taskId) && ANSWER_PHASES.has(entry.phase))
    if (answered) {
      markAnsweredFromOutbox({ chatId: item.chatId, id: item.id, entry: answered, now })
      continue
    }
    const taskId = item.taskIds?.at(-1) || item.id
    const task = store.get(taskId) || { id: taskId, chatId: item.chatId }
    // 11-02 复核：疑似 / 追问 / 停下来等材料的任务是在等负责人或群里的人，不是「没跑完」——疑似和追问只回了「收到」就挂起
    //（waiting_confirmation 是活跃状态、也没人记 owed），4h 后这里误报「群里答应过…还没结论」；他自己私信发起的也不提醒
    //（私信里没有「群里答应过」这回事，他本来就在等结论）。和已了结的一样标记一次就不再查，口径对齐 lark-daily-digest collectDigest。
    const settled = task.status && !isControlActiveStatus(task.status)
    if (settled || PARKED.has(task.status) || task.suspected || task.askBack || isDmOrigin(task)) {
      markOverdueNotified({ chatId: item.chatId, id: item.id, now })
      continue
    }
    const sent = await principalNote({ config, store, task, text: sayOverdue({ task, chatLabel: labelOf(task, config, deps), ackText: item.ackText }), kind: 'overdue', deps })
    if (sent.ok) {
      markOverdueNotified({ chatId: item.chatId, id: item.id, now })
      count += 1
    }
  }
  return count
}
