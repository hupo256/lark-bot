/**
 * 分类结果落到任务上（纯函数，从 lark-task-store resolveIntake 拆出，10-21 架构加固 P0）：
 * 入队门槛、疑似挂起、终态，以及分类器派生出的任务字段。store 负责并发 / 幂等 / 持久化，这里只改任务对象。
 */

import { hasDocAttachment } from './lark-message.mjs'
import { deriveContract, isRecordOnly } from './lark-task-contract.mjs'

// 入队门槛：fameex 群（bot 在群里，@bot 直呼）沿用 medium 即可；仓库 profile 的外部群按上下文判任务：
// 判得出是负责人的事（forMe=true）medium 也直接开跑；只有归属拿不准（forMe 未给）且不到 high 才挂 suspected 问人
//（aven 2026-10-23：「能判断是不是我的任务，为什么还要私聊问我」，#74）。前端什么都不用做的对接答复只记一笔，不开跑。
export const intakeActionable = (task, classification, error) => {
  if (error) return false
  // @ 机器人带来的对接文档：不看分类结果进执行器，由分析判归属，归负责人才存进仓库（aven 10-20 改：没 @ 的只记台账，教训 #53）。
  if (task?.repo && task.addressedToBot && hasDocAttachment(task.attachments || [])) return true
  if (!['bug', 'requirement', 'api_reply', 'question'].includes(classification?.decision)) return false
  if (task?.repo) {
    // 负责人本人 @ 机器人下的指令：不走「拿不准先问他」，medium 也直接开跑（问他等于问自己）。
    if (task.addressedToBot && task.fromPrincipal) return ['high', 'medium'].includes(classification.confidence)
    if (classification.forMe === false || isRecordOnly(task, classification)) return false
    // 提问是只读代答，medium 也直接答；改代码的类别 forMe=true 时 medium 也开跑，归属拿不准才要 high。
    if (classification.decision === 'question' || classification.forMe === true) return ['high', 'medium'].includes(classification.confidence)
    return classification.confidence === 'high'
  }
  return ['high', 'medium'].includes(classification?.confidence)
}
export const sameIntentClassification = (left, right) =>
  ['decision', 'confidence', 'summary', 'reason'].every((key) => left?.[key] === right?.[key])

// 返回 { actionable, suspected, recordOnly, requeue }：requeue=true 由 store 换代排队（requeueTask 在 store 闭包里）。
export const applyIntakeClassification = (task, { classification, error }) => {
  let requeue = false
  const actionable = intakeActionable(task, classification, error)
  const recordOnly = !error && !actionable && isRecordOnly(task, classification)
  // 疑似（仓库 profile 的群：判定是任务但归属拿不准、置信度又不到 high）：不开跑，挂待确认，
  // 由负责人在私聊里一句「继续任务 <id>」放行；不催办。
  // forMe=false（别人的功能）直接静默忽略，不打扰负责人；只有「可能是他的事但置信度不够」才算疑似。
  const suspected = !error && !actionable && !recordOnly && Boolean(task.repo) &&
    ['bug', 'requirement', 'api_reply', 'question'].includes(classification?.decision) && classification?.forMe !== false
  task.intake = {
    ...task.intake,
    required: false,
    classification: classification || null,
    error: error ? String(error).slice(0, 1000) : null,
    resolvedAt: new Date().toISOString(),
  }
  task.claimedAt = null
  // 仓库任务的 topic 由 routes 按台账条目 / 消息 id 定（稳定键）；只有默认仓才用分类器的自由文本（第 3 批）。
  if (classification?.topic && !task.topic && !task.repo) task.topic = String(classification.topic).trim().slice(0, 60)
  if (typeof classification?.waitsFor === 'string' && classification.waitsFor.trim()) task.waitsFor = classification.waitsFor.trim().slice(0, 120)
  if (Array.isArray(classification?.items)) task.ledgerItems = classification.items.filter((item) => item && typeof item.id === 'string').slice(0, 20)
  // 任务契约只在这里算一次（10-21 P2）：交付什么、怎样算完成，后面各处都读它。
  if (task.repo && classification && !error) {
    const contract = deriveContract(task)
    if (contract) task.contract = contract
  }
  if (actionable) {
    if (classification.summary) task.summary = classification.summary.slice(0, 80)
    // 提问：只读作答（status），答案走 groupReply 回群；须先于下面「带文档就按 api」，否则提问被当改代码工单（教训 #38）。
    if (classification.decision === 'question' && !task.commandType) {
      task.commandType = 'status'
      task.commandTypeSource = 'explicit'
    }
    // 对接答复：按 api 命令类型跑（分析 / 实施提示会要求先存档答复再按答复改代码）；没显式前缀时才补。
    if (task.repo && hasDocAttachment(task.attachments || []) && !task.commandType) {
      task.commandType = 'api'
      task.commandTypeSource = 'explicit'
    }
    if (classification.decision === 'api_reply' && !task.commandType) {
      task.commandType = 'api'
      task.commandTypeSource = 'explicit'
    }
    requeue = true
  } else if (suspected) {
    task.status = 'waiting_confirmation'
    task.suspected = true
    task.parkedAt = task.intake.resolvedAt
    task.parkedRemindedRound = 99
    task.waitRound = (task.waitRound || 0) + 1
    task.result = `疑似需要处理但没把握（${classification.decision} / ${classification.confidence}${classification.forMe === false ? '，判定不归本人' : ''}）：${classification.summary || ''}\n理由：${classification.reason || ''}`
    if (classification.summary) task.summary = classification.summary.slice(0, 80)
    task.updatedAt = task.intake.resolvedAt
  } else if (recordOnly) {
    // 只记一笔：台账由路由记，群里一句中性确认就结单；不私聊、不开 worktree（#74）。
    task.status = 'ignored'
    task.recordOnly = true
    task.result = `只记台账（${classification.decision} / ${classification.confidence}，前端不用动）：${classification.summary || ''}`
    if (classification.summary) task.summary = classification.summary.slice(0, 80)
    task.updatedAt = task.intake.resolvedAt
  } else {
    task.status = error ? 'intake_failed' : 'ignored'
    task.updatedAt = task.intake.resolvedAt
  }
  return { actionable, suspected, recordOnly, requeue }
}
