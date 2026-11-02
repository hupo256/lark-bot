/**
 * 分类结果落地后的出口（POST /lark/tasks/:id/intake；11-01 对话层，plan §3.3 / §E）。
 * store.resolveIntake 已把怎么落（开跑 / 自答 / 追问 / 疑似 / 只记一笔 / 忽略）算好，这里只管：
 *   · 把挂着的「收到」用分类器写的 reply 发出去（或撤掉）；
 *   · 延续（continues / 控制通道锚到的任务）→ 并入原任务，不开平行工单；
 *   · 按结果给群里 / 负责人该说的那一句；开跑的改投项目群。
 * 幂等重放（worker 重试同一结果）：只在 actionable 且任务仍在队列 / 在跑时重发开跑知会，其余什么都不发。
 */

import { deliverIgnoredAfterAck, deliverNoted, deliverStart, deliverSuspected } from './lark-delivery.mjs'
import { sendPrincipalNote } from './lark-group-exit.mjs'
import { flushPendingAck } from './lark-intake-ack.mjs'
import { notePerson } from './lark-persona.mjs'
import { noteAnswer } from './lark-reply-obligation.mjs'

const ACTIVE_AFTER_INTAKE = new Set(['queued', 'running', 'verifying'])
const MERGE_DECISIONS = new Set(['bug', 'requirement', 'api_reply'])

// 延续目标：分类器点名的 continues 最强；控制通道锚到的活动任务（anchorTaskId）只对改码 / 对接类生效（提问 / 闲聊不并进别人的工单）。
export const resolveMergeTarget = ({ task, store }) => {
  const cls = task.intake?.classification || null
  const named = cls?.continues && cls.continues !== task.id ? store.get(cls.continues) : null
  if (named) return named
  const anchorId = task.intake?.anchorTaskId || null
  const anchored = anchorId && anchorId !== task.id && MERGE_DECISIONS.has(cls?.decision) ? store.get(anchorId) : null
  return anchored || null
}

export const handleIntakeResolution = async ({ config, store, id, body = {}, deliverTo = async () => {}, deps = {} }) => {
  const say = {
    flush: deps.flushPendingAck || flushPendingAck,
    noted: deps.deliverNoted || deliverNoted,
    ignoredAfterAck: deps.deliverIgnoredAfterAck || deliverIgnoredAfterAck,
    suspected: deps.deliverSuspected || deliverSuspected,
    start: deps.deliverStart || deliverStart,
    principal: deps.sendPrincipalNote || sendPrincipalNote,
  }
  const outcome = store.resolveIntake({ id, epoch: body.epoch, classification: body.classification, error: body.error })
  if (!outcome.ok) return { status: outcome.code || 404, body: outcome }
  const task = outcome.task
  const cls = task.intake?.classification || null
  // 人员画像（数字分身地基）：谁在哪个群问过什么，累积到 runtime/people.json；名字按 ownerMap 反查，查不到只记 open_id。
  if (cls && !outcome.alreadyResolved && task.operator) {
    const name = Object.entries(config.ownerMap || {}).find(([, openId]) => openId === task.operator)?.[0] || null
    try {
      (deps.notePerson || notePerson)({ openId: task.operator, name, role: config.memberRoles?.[name] || null, topic: task.topic || cls.summary || null, chatId: task.chatId, taskId: task.id })
    } catch (error) {
      console.warn(`[lark-gateway] 人员画像写入失败（忽略）：${String(error?.message || error).slice(0, 120)}`)
    }
  }
  const reply = cls?.reply || null
  const log = (line) => console.log(`[lark-gateway] 分类落地 ${task.id}：${line}`)
  const result = (extra = {}) => ({ status: 200, body: { ok: true, actionable: Boolean(outcome.actionable), suspected: Boolean(outcome.suspected), selfAnswer: Boolean(outcome.selfAnswer), ...extra } })

  if (outcome.alreadyResolved && !(outcome.actionable && ACTIVE_AFTER_INTAKE.has(task.status))) return result({ replayed: true })
  // 瞬时失败：任务放回待分类，「收到」继续挂着，到点由巡检发固定句。
  if (outcome.retried) return result({ retried: true })
  if (body.error || task.status === 'intake_failed') {
    await say.flush({ config, store, task, reply: null, send: true, reason: 'intake_failed' })
    log(`分类失败，已静默停止：${String(body.error || '').slice(0, 160)}`)
    return result({ intakeFailed: true })
  }
  // 问 bot 自己的问题，分类器一句就答完：发那句，不建执行。
  if (outcome.selfAnswer) {
    await say.flush({ config, store, task, reply, send: true, reason: 'self_answer' })
    noteAnswer({ task, text: reply || task.result || '' })
    log(`自答：${(reply || '').slice(0, 60)}`)
    return result({ answered: true })
  }
  // 延续：并入原任务（追问并入上一条代答、补充并入在跑的改码单），本条落 superseded；本条的「收到」照发 reply。
  if (outcome.actionable || outcome.suspected) {
    const target = resolveMergeTarget({ task, store })
    const merged = target ? store.mergeIntoTask({ fromId: task.id, intoId: target.id }) : null
    if (merged) {
      await say.flush({ config, store, task, reply, send: true, reason: `merged:${merged.mode}` })
      log(`延续 ${target.id}（${merged.mode}）`)
      if (merged.mode === 'resumed' || merged.mode === 'reopened') {
        await deliverTo(merged.into)
        await say.start({ config, store, task: merged.into })
      }
      return result({ mergedInto: target.id, mode: merged.mode })
    }
  }
  if (outcome.actionable) {
    await say.flush({ config, store, task, reply, send: true })
    await deliverTo(task)
    await say.start({ config, store, task })
    log(`${cls.decision}/${cls.confidence}${cls.deliverable ? `·${cls.deliverable}` : ''}，正式入队`)
    return result()
  }
  if (outcome.askBack) {
    await say.flush({ config, store, task, reply, send: true, reason: 'ask_back' })
    log(`负责人的话拿不准，先追问：${(reply || '').slice(0, 60)}`)
    return result({ askBack: true })
  }
  if (outcome.suspected) {
    await say.flush({ config, store, task, reply, send: Boolean(task.addressedToBot), reason: 'suspected' })
    const sent = await say.suspected({ config, store, task })
    log(`${cls.decision}/${cls.confidence} forMe=${cls.forMe}，疑似：已私信负责人${sent?.ok ? '' : '（没发出去）'}`)
    return result()
  }
  if (outcome.recordOnly) {
    await say.flush({ config, store, task, reply: null, send: false })
    await say.noted({ config, store, task, reply })
    log('对接答复、前端不用动，记下了')
    return result({ recordOnly: true })
  }
  // ignore
  if (task.privateOrigin) {
    // 负责人私聊指示判「不做」：他说怎么回群就回群（reply），再私信他一句记下了。
    if (reply) await say.noted({ config, store, task: { ...task, privateOrigin: null }, reply })
    await say.principal({ config, store, text: `记下了，「${task.privateOrigin.anchorHead}」这条不用动手。`, taskId: task.id, kind: 'ignored_after_ack' })
    log('负责人指示：不处理')
    return result({ ignored: true })
  }
  if (task.addressedToBot) {
    await say.flush({ config, store, task, reply: null, send: false })
    await say.noted({ config, store, task, reply })
    if (cls?.forMe !== true && !task.fromPrincipal) await say.ignoredAfterAck({ config, store, task })
    log('@ 了机器人但判不用处理，已回一句')
    return result({ ignored: true })
  }
  await say.flush({ config, store, task, reply: null, send: false })
  if (task.ackedInGroup) await say.ignoredAfterAck({ config, store, task })
  log('判不用处理，静默')
  return result({ ignored: true })
}
