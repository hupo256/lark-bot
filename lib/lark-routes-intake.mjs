/**
 * 分类结果落地后的出口（POST /lark/tasks/:id/intake；11-01 对话层，plan §3.3 / §E）。
 * store.resolveIntake 已把怎么落（开跑 / 自答 / 追问 / 疑似 / 只记一笔 / 忽略）算好，这里只管：
 *   · 把挂着的「收到」用分类器写的 reply 发出去（或撤掉）；
 *   · 延续（continues / 控制通道锚到的任务）→ 并入原任务，不开平行工单；
 *   · 按结果给群里 / 负责人该说的那一句；开跑的改投项目群。
 * 幂等重放（worker 重试同一结果）：只在 actionable 且任务仍在队列 / 在跑时重发开跑知会，其余什么都不发。
 */

import { resolveEnvTargets } from './lark-env-target.mjs'
import { deliverIgnoredAfterAck, deliverNoted, deliverStart, deliverSuspected } from './lark-delivery.mjs'
import { sendPrincipalNote } from './lark-group-exit.mjs'
import { chatLabel, sayIntakeFailed } from './lark-human-text.mjs'
import { deliverFollowUpReply, flushPendingAck } from './lark-intake-ack.mjs'
import { notePerson } from './lark-persona.mjs'
import { getObligation, noteAnswer, noteOwed } from './lark-reply-obligation.mjs'
import { isControlActiveStatus } from './lark-task-store.mjs'

const ACTIVE_AFTER_INTAKE = new Set(['queued', 'running', 'verifying'])
const MERGE_DECISIONS = new Set(['bug', 'requirement', 'api_reply'])
// 并入在跑的任务（跑完带补充再跑一轮）时的「收到」：分类器写 reply 时不知道目标正在跑，固定说清楚会怎么处理。
export const RERUN_ACK_REPLY = '收到，这条等上一轮跑完一起处理'
const SUPERSEDED_HOPS_MAX = 5

// superseded 的任务不能当并入目标（11-02 复核：回复「好，「X」取消了」那条再报一个 bug、或回复被并进兄弟的那条的「收到」，
// 原先都掉进 mergeTaskObjects 的「终态重开」把取消 / 并掉的任务复活再跑一遍）：被兄弟归并掉的（supersededBy）顺着指到真正
// 承接的那条（最多追 5 跳）；人工结单 / 取消的（externalResolution，没有 supersededBy）没有目标，本条按新任务走。
export const mergeableTarget = ({ store, id, selfId = null }) => {
  let current = id && id !== selfId ? store.get(id) || null : null
  for (let hop = 0; current && current.status === 'superseded' && hop < SUPERSEDED_HOPS_MAX; hop += 1) {
    const nextId = current.supersededBy || null
    current = nextId && nextId !== selfId ? store.get(nextId) || null : null
  }
  return current && current.status !== 'superseded' ? current : null
}

// 延续要交付物兼容（11-03 falive 回放 smoke：Encone 问「api 待处理清单」答完后，William「portal 不用带头，更新清单」、Encone「你写脚本造测试帖」
// 都被判 continues 并进那条答疑任务重跑，整份清单作为对第一条消息的回复连发三遍）：目标在等补料的，什么都能并；
// 其它状态（排队 / 在跑 / 已了结）只有同一种交付物才算延续（追问 → 原答疑、补料 → 改码单），另一种诉求另起任务。没有契约的（老任务）照旧。
// 排队中（queued）也不例外（11-03 fix-a 回放：「检查下 preload」api_reply·verification 并进了排队中的「写脚本造帖」requirement·change，
// 一个任务干两件事，结论混在一起连发两条）；只有在等补料的（waiting_confirmation / blocked）什么都能并。
const MERGE_ANY_STATUSES = new Set(['waiting_confirmation', 'blocked'])
export const compatibleContinuation = ({ task, target }) => {
  const mine = task?.contract?.deliverable || null
  const theirs = target?.contract?.deliverable || null
  if (!mine || !theirs || MERGE_ANY_STATUSES.has(target.status)) return true
  // 同是实测但点名的环境互不相交（uat 那条答完，又要「复测 OL」）→ 另一件事
  const envA = task?.envTargets || []
  const envB = target?.envTargets || []
  if (envA.length && envB.length && !envA.some((env) => envB.includes(env))) return false
  return mine === theirs
}

// 延续目标：分类器点名的 continues 最强；控制通道锚到的活动任务（anchorTaskId）只对改码 / 对接类生效（提问 / 闲聊不并进别人的工单）。
export const resolveMergeTarget = ({ task, store }) => {
  const cls = task.intake?.classification || null
  const named = cls?.continues ? mergeableTarget({ store, id: cls.continues, selfId: task.id }) : null
  if (named && compatibleContinuation({ task, target: named })) return named
  if (named) console.log(`[lark-gateway] ${task.id} continues=${named.id} 但交付物不同（${task.contract?.deliverable} vs ${named.contract?.deliverable}，${named.status}），另起任务`)
  const anchorId = task.intake?.anchorTaskId || null
  return anchorId && MERGE_DECISIONS.has(cls?.decision) ? mergeableTarget({ store, id: anchorId, selfId: task.id }) : null
}

export const handleIntakeResolution = async ({ config, store, id, body = {}, deliverTo = async () => {}, deps = {} }) => {
  const say = {
    flush: deps.flushPendingAck || flushPendingAck,
    noted: deps.deliverNoted || deliverNoted,
    ignoredAfterAck: deps.deliverIgnoredAfterAck || deliverIgnoredAfterAck,
    suspected: deps.deliverSuspected || deliverSuspected,
    start: deps.deliverStart || deliverStart,
    principal: deps.sendPrincipalNote || sendPrincipalNote,
    followUp: deps.deliverFollowUpReply || deliverFollowUpReply,
  }
  const outcome = store.resolveIntake({ id, epoch: body.epoch, classification: body.classification, error: body.error })
  if (!outcome.ok) return { status: outcome.code || 404, body: outcome }
  const task = outcome.task
  const cls = task.intake?.classification || null
  // 点名的环境（lib/lark-env-target，aven 11-02）：分类后定下来，worker 的提示与收尾核对都读它。只看「要做什么」的原话，不看上下文包。
  if (cls && !outcome.alreadyResolved) {
    const envTargets = resolveEnvTargets({ texts: [cls.summary, task.summary, task.privateOrigin ? String(task.text || '').split('\n')[0] : null], envSites: config.envSites })
    if (envTargets.length) {
      task.envTargets = envTargets
      store.upsert(task)
    }
  }
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
  // 非瞬时分类失败（11-03 R6）：挂着的「收到」撤掉不发——先承诺「稍后回你」再永久静默等于骗人；私信负责人看一眼（intake_failed 不能续跑，
  // 只能他另起）。「收到」已经发过固定句的（分类超 45s）义务记 owed，和 deliverOutcome 没做成一个口径，不当了结。
  if (body.error || task.status === 'intake_failed') {
    await say.flush({ config, store, task, reply: null, send: false, reason: 'intake_failed' })
    if (getObligation(task)?.ackedAt) noteOwed({ task, status: 'intake_failed' })
    const sent = await say.principal({ config, store, text: sayIntakeFailed({ task, chatLabel: chatLabel(task, { chatNames: config.chatNames || {} }) }), taskId: task.id, kind: 'intake_failed' })
    log(`分类失败，已私信负责人${sent?.ok ? '' : '（没发出去）'}：${String(body.error || '').slice(0, 160)}`)
    return result({ intakeFailed: true })
  }
  // 分类器那句就是答案 / 追问：「收到」还挂着就用它当「收到」回（一条 @bot 只有一个下文）；「收到」已经发过固定句、或被闸按人
  // 拦了、或没 reply 只有 result → flush 发不出这句，单独回一条到原消息（11-02 复核）。返回 ok 才算这句到了人眼前。
  const answerOrFollowUp = async ({ reason, kind, text }) => {
    const flushed = await say.flush({ config, store, task, reply, send: true, reason })
    if (flushed?.usedReply) return { ok: true, via: 'ack' }
    const sent = await say.followUp({ config, store, task, text, kind })
    return { ok: Boolean(sent?.ok), via: 'follow_up', reason: sent?.reason || null }
  }
  // 问 bot 自己的问题，分类器一句就答完：发那句，不建执行。发成了才记义务 answered；没发出去（闸拦 / 发送失败）义务留着。
  if (outcome.selfAnswer) {
    const answer = reply || task.result || ''
    const sent = await answerOrFollowUp({ reason: 'self_answer', kind: 'self_answer', text: answer })
    if (sent.ok) noteAnswer({ task, text: answer })
    log(sent.ok ? `自答（${sent.via}）：${answer.slice(0, 60)}` : `自答没发出去（${sent.reason || 'unknown'}），义务留着：${answer.slice(0, 60)}`)
    return result({ answered: sent.ok })
  }
  // 延续：并入原任务（追问并入上一条代答、补充并入在跑的改码单），本条落 superseded；本条的「收到」照发 reply。
  if (outcome.actionable || outcome.suspected) {
    const target = resolveMergeTarget({ task, store })
    const merged = target ? store.mergeIntoTask({ fromId: task.id, intoId: target.id }) : null
    if (merged) {
      // 并入在跑的那条：说清楚是等这轮跑完再带上补充跑一轮（跑完后由状态回写处 rerunAfterDone 换代重排），不是马上处理。
      await say.flush({ config, store, task, reply: merged.mode === 'rerun_after_done' ? RERUN_ACK_REPLY : reply, send: true, reason: `merged:${merged.mode}` })
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
    const question = reply || task.result || ''
    const sent = await answerOrFollowUp({ reason: 'ask_back', kind: 'ask_back', text: question })
    // 追问没发出去：任务已挂 waiting_confirmation、人却没看到问题。记在任务上（askBackUndelivered），日志报出来；不假装问过。
    if (!sent.ok) store.upsert(Object.assign(task, { askBackUndelivered: { reason: sent.reason || 'unknown', at: new Date().toISOString() } }))
    log(sent.ok ? `负责人的话拿不准，先追问（${sent.via}）：${question.slice(0, 60)}` : `追问没发出去（${sent.reason || 'unknown'}）：${question.slice(0, 60)}`)
    return result({ askBack: true, asked: sent.ok })
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
    // 锚点任务还在活动态（在跑 / 排队 / 挂起 / 没做成）→ 一并结掉（externalResolution，换代挡掉迟到回写；worker 轮询到换代就中止）：
    // 11-03 静态 review R3——对在跑的锚点私信「不做，这是后端的」原先只建指示任务，锚点照跑到 done 再回群，群里先「不归我们」后「改好了」。
    const anchor = task.privateOrigin.anchorId ? store.get(task.privateOrigin.anchorId) : null
    const closed = anchor && isControlActiveStatus(anchor.status)
      ? store.closeAsExternallyResolved({ id: anchor.id, operator: task.privateOrigin.senderOpenId || task.operator || null, messageId: task.id, closureReason: 'no_longer_needed' })
      : null
    if (reply) await say.noted({ config, store, task: { ...task, privateOrigin: null }, reply })
    await say.principal({ config, store, text: `记下了，「${task.privateOrigin.anchorHead}」这条不用动手${closed ? '；原来在跑的那条也关掉了，不再回群结论' : ''}。`, taskId: task.id, kind: 'ignored_after_ack' })
    log(`负责人指示：不处理${closed ? `，锚点 ${anchor.id} 由 ${closed.previousStatus} 结掉` : ''}`)
    return result({ ignored: true, ...(closed ? { anchorClosed: anchor.id } : {}) })
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
