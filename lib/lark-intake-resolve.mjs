/**
 * 分类结果落到任务上（从 falive 10-21 P0 搬来，11-01 按 plan §3.3 的表重写）：入队门槛、代答 / 追问 / 疑似 / 只记一笔 / 终态，
 * 以及分类器派生出的任务字段（契约、waitsFor、topic、continues / relatedTaskId）。store 负责并发 / 幂等 / 持久化，这里只改任务对象。
 *
 * 规则表（addressedToBot = 直接 @bot 或私信；fromPrincipal = 负责人本人；「四类」= bug / requirement / api_reply / question）：
 *   任意      分类出错                                   → intake_failed（瞬时错误由 store 先重试，到不了这里）
 *   ✓ 任何人  question + selfAnswer + 交付 answer         → selfAnswer：answered，ack 发 reply，不建执行（11-03 R9：原先只对负责人生效，
 *                                                          别人问「bot 能做什么」reply 已是完整答案却照样开跑，worker 再代答一遍发第二次）；
 *                                                          别人的要 high / medium，low 落疑似
 *   ✓ 负责人  四类 high / medium                         → actionable（api_reply + 交付 null 除外 → recordOnly，见下）
 *   ✓ 负责人  四类 low                                   → askBack：waiting_confirmation（分类器的追问当 reply 发），不催；下一条私信锚回
 *   ✓ 负责人  ignore                                     → ignored
 *   ✓ 别人    ignore + 交付 verification / answer，high / medium → actionable（帮测 / 帮答不看归属，aven 10-24）；
 *            回复 bot 消息没 @ 它、reply=null（在跟同事说，11-04）除外 → ignored，静默
 *   ✓ 别人    四类 high / medium，forMe ≠ false           → actionable
 *   ✓ 别人    四类，forMe = false                         → ignored（reply 礼貌转介）
 *   ✓ 任何人  api_reply + 交付 null                       → recordOnly：ignored（「收到，记下了」）；负责人的也一样（11-04 b3 ep-1019-57332a：
 *                                                          aven「这个待办清掉，之后到 uat 运营配数据」原先按只读派工，挂 waiting_confirmation 私信他重新派）
 *   ✓ 别人    四类 low                                   → suspected（私信 aven，不催，48h 关）
 *   ✗ 只 @ 负责人  bug / requirement high / medium        → actionable（现状）
 *   ✗         api_reply / question high / medium         → suspected（没叫 bot，先问 aven 再以他名义答）
 *   ✗         其它                                       → ignored，静默
 * 契约在可执行性判定前算（isReadOnlyAsk 要读）；question 无命令类型 → status，api_reply → api（falive #38 顺序）。
 */

import { renderProbeLog } from './lark-report-render.mjs'
import { deriveContract, isReadOnlyAsk, isRecordOnly } from './lark-task-contract.mjs'

const TASK_DECISIONS = new Set(['bug', 'requirement', 'api_reply', 'question'])
const SURE = new Set(['high', 'medium'])

const isSure = (cls) => SURE.has(cls?.confidence)
// 旧任务没有 addressedToBot 字段：只 @ 负责人（intake.trigger=task_mention）与直接入队的老任务都按「没叫 bot」处理。
const addressed = (task) => task?.addressedToBot === true
const principal = (task) => task?.fromPrincipal === true
const withCls = (task, cls) => ({ ...task, intake: { ...task?.intake, classification: cls } })
// 分类器已把关于 bot 自己的问题答完：只认 question，契约也得判成 answer（显式前缀 / 运维优先于分类器）。
const selfAnswerFor = (task, cls) => cls?.decision === 'question' && deriveContract(withCls(task, cls))?.selfAnswer === true

// 回复 bot 消息却没 @ 它、分类器判不是对机器人说的（ignore + reply=null；lib/lark-classify-prompt addressedBlock，11-04 falive 回放）：
// 人在 bot 卡片下的话题里跟同事说话。不走「ignore 的帮测 / 帮答照样做」，routes 里也不回话。
export const isReplyWithoutAt = (task) => task?.intake?.trigger === 'bot_reply' && task.intake.mentionedBot !== true
export const saidToOthers = (task, cls) => isReplyWithoutAt(task) && cls?.decision === 'ignore' && !cls?.reply

// 分类器写的「收到」不许替 bot 断言没核过的状态（11-04 b3）：分类只读、本轮什么都没测，ep-1014-d74f19「之前实测这条已经通了」（前文是缺反代没通）、
// ep-1024-9ebe13「你说存取一致那就对上了」（原始返回仍是转义的）都是这一句先说出去的。规则在提示里（lib/lark-classify-prompt reply），这里兜底：
// 按句切开，「实测…通 / 过 / 没问题」「对上了」「确实没 / 是 / 漏」这类断言没带时间（10:19 / 10-22）的句子去掉，补一句「先核实」；整句都是就交给固定句。
const STATUS_CLAIM_RE = /实测[^，。；!！]{0,12}(?:通|过|好了|没问题|正常)|对上了|就对了|确实(?:没|是|漏|有问题)/
const CLAIM_TIME_RE = /\d{1,2}[:：]\d{2}|\d{1,2}-\d{1,2}/
const isUnverifiedClaim = (sentence) => STATUS_CLAIM_RE.test(sentence) && !CLAIM_TIME_RE.test(sentence)
export const CLAIM_DROPPED_TAIL = '这个我先核实再回你。'
export const stripUnverifiedClaims = (reply) => {
  if (typeof reply !== 'string' || !reply.trim()) return { text: reply ?? null, dropped: [] }
  const sentences = reply.match(/[^。！!；;？?]+[。！!；;？?]*/g) || [reply]
  const dropped = sentences.filter(isUnverifiedClaim)
  if (!dropped.length) return { text: reply, dropped }
  const kept = sentences.filter((sentence) => !isUnverifiedClaim(sentence)).join('').trim()
  return { text: kept ? `${kept}${/[。！!？?；;]$/.test(kept) ? '' : '。'}${CLAIM_DROPPED_TAIL}` : null, dropped }
}

export const sameIntentClassification = (left, right) =>
  ['decision', 'confidence', 'summary', 'reason'].every((key) => left?.[key] === right?.[key])

export const intakeActionable = (task, classification, error) => {
  if (error) return false
  const cls = classification || null
  const decision = cls?.decision
  if (addressed(task)) {
    if (selfAnswerFor(task, cls)) return false
    if (principal(task)) {
      if (!TASK_DECISIONS.has(decision) || isRecordOnly(task, cls)) return false
      return isSure(cls)
    }
    if (decision === 'ignore') return !saidToOthers(task, cls) && isReadOnlyAsk(task, cls) && isSure(cls)
    if (!TASK_DECISIONS.has(decision) || cls.forMe === false || isRecordOnly(task, cls)) return false
    return isSure(cls)
  }
  return (decision === 'bug' || decision === 'requirement') && isSure(cls)
}

const trimmed = (value, max) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null)

// 接着 bot 之前那条另起的任务（continues / relatedTaskId；交付物不同没并进去）带上那条的结论给 worker（11-03 falive 回放：William
//「测试的tid 发出来」接着上一单实测，tid 只在那单的条目 / detailDoc 里，本单只看得到群里那句摘要，回了「去翻文档」）。答案 + 条目在前，整段截到上限。
export const PRIOR_CONCLUSION_MAX = 2000
// 那单真发过的请求（outcome.probes，lib/lark-report-render collectProbeLog）单独一段、单独上限，不被前面的长 detailDoc 截掉
//（11-04 回放 ep-1014-d74f19：引用 bot 实测卡片问「几点调的哪个接口 / 请求头参数 url」，结论里只有摘要，答成估个范围）。
export const PRIOR_PROBES_MAX = 2500
export const PROBE_RECORD_HEAD = '那单真发过的请求（时刻 · 命令 → 返回开头，token 已打码）：对方问请求时间 / url / 请求头 / 参数就照这里给原值，时间到秒并写明时区，这里没有的直说没有记录、不估范围'
export const priorConclusionOf = (prior) => {
  const outcome = prior?.outcome
  const lines = [
    outcome?.report?.answer || outcome?.groupReply || outcome?.summary,
    ...(outcome?.report?.items || []).map((item) => (item?.name ? `- ${item.name}${item.note ? `：${item.note}` : ''}` : null)),
    outcome?.detailDoc ? `详细：\n${outcome.detailDoc}` : null,
  ].filter(Boolean)
  const probes = renderProbeLog(outcome?.probes)
  if (!lines.length && !probes) return null
  const text = [lines.join('\n').slice(0, PRIOR_CONCLUSION_MAX), probes ? `${PROBE_RECORD_HEAD}：\n${probes}`.slice(0, PRIOR_PROBES_MAX) : null].filter(Boolean).join('\n')
  return { taskId: prior.id, summary: prior.summary || null, text }
}

// 返回 { actionable, suspected, recordOnly, selfAnswer, askBack, requeue }：requeue=true 由 store 换代排队（requeueTask 在 store 闭包里）。
// lookup(id) 由 store 给（按 id 取别的任务），用来带上接着的那条的结论。
export const applyIntakeClassification = (task, { classification, error, now = new Date().toISOString(), lookup = () => null }) => {
  const cls = classification || null
  const actionable = intakeActionable(task, cls, error)
  const isAddressed = addressed(task)
  const isPrincipal = principal(task)
  const taskDecision = TASK_DECISIONS.has(cls?.decision)
  // 判 ignore 却被放行的（只读活归别人）：它写的 reply 多半是「找 xx 联调」的推托，不能当「收到」发出去，改用固定句。
  const overridden = actionable && cls?.decision === 'ignore' && cls.reply
  task.intake = {
    ...task.intake,
    required: false,
    classification: overridden ? { ...cls, reply: null, replyDropped: cls.reply } : cls,
    error: error ? String(error).slice(0, 1000) : null,
    resolvedAt: now,
  }
  task.claimedAt = null
  // 只写不清会让重新分类后还带着上一次分类接着的那单（11-03 第二次 review #5）：每次落态先清，开跑且查到 prior 再带上。
  delete task.priorConclusion
  delete task.quotedConclusion
  let contract = null
  if (cls && !error) {
    // 任务契约只在这里算一次（falive P2）：交付什么、怎样算完成，后面各处都读它。要在 intake.classification 落上之后算。
    contract = deriveContract(task)
    if (contract) task.contract = contract
    task.waitsFor = trimmed(cls.waitsFor, 120)
    if (!task.topic && trimmed(cls.topic, 60)) task.topic = trimmed(cls.topic, 60)
    task.continues = trimmed(cls.continues, 80)
    task.relatedTaskId = trimmed(cls.relatedTaskId, 80)
  }
  // 非负责人自答要 high / medium（11-03 合入前 review）：low 照旧落疑似私信负责人；负责人本人不看置信度。
  const selfAnswer = !error && isAddressed && (isPrincipal || isSure(cls)) && cls?.decision === 'question' && contract?.selfAnswer === true
  const recordOnly = !error && !actionable && !selfAnswer && isAddressed && isRecordOnly(task, cls)
  const askBack = !error && !actionable && !selfAnswer && !recordOnly && isAddressed && isPrincipal && taskDecision && cls.confidence === 'low'
  // 负责人自己 @ 的 low 已经被 askBack 接走，这里不用再区分是不是负责人。
  const suspected = !error && !actionable && !selfAnswer && !askBack && !recordOnly && taskDecision && (isAddressed
    ? cls.forMe !== false && cls.confidence === 'low'
    : (cls.decision === 'api_reply' || cls.decision === 'question') && isSure(cls))
  // 要发出去当「收到」/「记下了」的那句去掉没核过的断言（自答 / 追问是在答 / 问，不动；ignore 的回话不动）。
  const claims = (actionable || suspected || recordOnly) && !overridden ? stripUnverifiedClaims(cls?.reply) : { dropped: [] }
  if (claims.dropped.length) task.intake.classification = { ...task.intake.classification, reply: claims.text, replyDropped: claims.dropped.join('') }
  const summary = trimmed(cls?.summary, 80)
  if (selfAnswer) {
    task.status = 'answered'
    task.selfAnswered = true
    task.result = trimmed(cls.reply, 400) || summary || ''
    if (summary) task.summary = summary
  } else if (actionable) {
    if (summary) task.summary = summary
    const priorId = task.continues || task.relatedTaskId
    const prior = priorId === task.id ? null : priorConclusionOf(lookup(priorId))
    if (prior) task.priorConclusion = prior
    // 引用的是 bot 自己的消息（ingest 按回执查到出自哪单，task.quotedTaskId）而分类器没接那单：那单的结论和请求记录也带上。
    const quotedId = task.quotedTaskId || null
    const quoted = quotedId && quotedId !== task.id && quotedId !== priorId ? priorConclusionOf(lookup(quotedId)) : null
    if (quoted) task.quotedConclusion = quoted
    // 提问：只读作答（status），答案回群；须先于「api_reply 按 api」，否则提问被当改代码工单（falive #38）。
    if (cls.decision === 'question' && !task.commandType) {
      task.commandType = 'status'
      task.commandTypeSource = 'explicit'
    }
    if (cls.decision === 'api_reply' && !task.commandType) {
      task.commandType = 'api'
      task.commandTypeSource = 'explicit'
    }
  } else if (askBack) {
    // 负责人自己 @ 的、分类器拿不准：把它的追问发给他，挂着等他下一条私信锚回；parkedRemindedRound=99 让催办器不碰。
    task.status = 'waiting_confirmation'
    task.askBack = true
    task.parkedAt = now
    task.parkedRemindedRound = 99
    task.waitRound = (task.waitRound || 0) + 1
    task.result = trimmed(cls.reply, 400) || summary || ''
    if (summary) task.summary = summary
  } else if (suspected) {
    // 疑似：不开跑，挂待确认，由负责人在私聊里一句「继续任务 <id> 做」放行；不催办，48h 自动关。
    task.status = 'waiting_confirmation'
    task.suspected = true
    task.parkedAt = now
    task.parkedRemindedRound = 99
    task.waitRound = (task.waitRound || 0) + 1
    task.result = `疑似需要处理但没把握（${cls.decision} / ${cls.confidence}）：${cls.summary || ''}\n理由：${cls.reason || ''}`
    if (summary) task.summary = summary
  } else if (recordOnly) {
    // 只记一笔：一句中性确认就结单；不私聊、不开 worktree（falive #74）。
    task.status = 'ignored'
    task.recordOnly = true
    task.result = `只记一笔：${cls.summary || ''}`
    if (summary) task.summary = summary
  } else {
    task.status = error ? 'intake_failed' : 'ignored'
  }
  task.updatedAt = now
  return { actionable, suspected, recordOnly, selfAnswer, askBack, requeue: actionable }
}
