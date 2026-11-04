/**
 * 分类结果落到任务上（从 falive 10-21 P0 搬来，11-01 按 plan §3.3 的表重写）：入队门槛、代答 / 追问 / 疑似 / 只记一笔 / 终态，
 * 以及分类器派生出的任务字段（契约、waitsFor、topic、continues / relatedTaskId）。store 负责并发 / 幂等 / 持久化，这里只改任务对象。
 *
 * 规则表（addressedToBot = 直接 @bot 或私信；fromPrincipal = 负责人本人；「四类」= bug / requirement / api_reply / question）：
 *   任意      分类出错                                   → intake_failed（瞬时错误由 store 先重试，到不了这里）
 *   ✓ 任何人  question + selfAnswer + 交付 answer         → selfAnswer：answered，ack 发 reply，不建执行（11-03 R9：原先只对负责人生效，
 *                                                          别人问「bot 能做什么」reply 已是完整答案却照样开跑，worker 再代答一遍发第二次）；
 *                                                          别人的要 high / medium，low 落疑似
 *   ✓ 负责人  四类 high / medium                         → actionable
 *   ✓ 负责人  四类 low                                   → askBack：waiting_confirmation（分类器的追问当 reply 发），不催；下一条私信锚回
 *   ✓ 负责人  ignore                                     → ignored
 *   ✓ 别人    ignore + 交付 verification / answer，high / medium → actionable（帮测 / 帮答不看归属，aven 10-24）；
 *            回复 bot 消息没 @ 它、reply=null（在跟同事说，11-04）除外 → ignored，静默
 *   ✓ 别人    四类 high / medium，forMe ≠ false           → actionable
 *   ✓ 别人    四类，forMe = false                         → ignored（reply 礼貌转介）
 *   ✓ 别人    api_reply + 交付 null                       → recordOnly：ignored（「收到，记下了」）
 *   ✓ 别人    四类 low                                   → suspected（私信 aven，不催，48h 关）
 *   ✗ 只 @ 负责人  bug / requirement high / medium        → actionable（现状）
 *   ✗         api_reply / question high / medium         → suspected（没叫 bot，先问 aven 再以他名义答）
 *   ✗         其它                                       → ignored，静默
 * 契约在可执行性判定前算（isReadOnlyAsk 要读）；question 无命令类型 → status，api_reply → api（falive #38 顺序）。
 */

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

export const sameIntentClassification = (left, right) =>
  ['decision', 'confidence', 'summary', 'reason'].every((key) => left?.[key] === right?.[key])

export const intakeActionable = (task, classification, error) => {
  if (error) return false
  const cls = classification || null
  const decision = cls?.decision
  if (addressed(task)) {
    if (selfAnswerFor(task, cls)) return false
    if (principal(task)) {
      if (!TASK_DECISIONS.has(decision)) return false
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
export const priorConclusionOf = (prior) => {
  const outcome = prior?.outcome
  const lines = [
    outcome?.report?.answer || outcome?.groupReply || outcome?.summary,
    ...(outcome?.report?.items || []).map((item) => (item?.name ? `- ${item.name}${item.note ? `：${item.note}` : ''}` : null)),
    outcome?.detailDoc ? `详细：\n${outcome.detailDoc}` : null,
  ].filter(Boolean)
  return lines.length ? { taskId: prior.id, summary: prior.summary || null, text: lines.join('\n').slice(0, PRIOR_CONCLUSION_MAX) } : null
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
  const askBack = !error && !actionable && !selfAnswer && isAddressed && isPrincipal && taskDecision && cls.confidence === 'low'
  const recordOnly = !error && !actionable && !selfAnswer && isAddressed && !isPrincipal && isRecordOnly(task, cls)
  // 负责人自己 @ 的 low 已经被 askBack 接走，这里不用再区分是不是负责人。
  const suspected = !error && !actionable && !selfAnswer && !askBack && !recordOnly && taskDecision && (isAddressed
    ? cls.forMe !== false && cls.confidence === 'low'
    : (cls.decision === 'api_reply' || cls.decision === 'question') && isSure(cls))
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
