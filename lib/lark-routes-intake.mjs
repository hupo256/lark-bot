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
import { isReplyWithoutAt, saidToOthers } from './lark-intake-resolve.mjs'
import { isPrincipalDecline } from './lark-principal-channel.mjs'
import { getObligation, noteAnswer, noteOwed } from './lark-reply-obligation.mjs'
import { isControlActiveStatus } from './lark-task-store.mjs'

const ACTIVE_AFTER_INTAKE = new Set(['queued', 'running', 'verifying'])
const MERGE_DECISIONS = new Set(['bug', 'requirement', 'api_reply'])
// 并入在跑的任务（跑完带补充再跑一轮）时的「收到」：分类器写 reply 时不知道目标正在跑，固定说清楚会怎么处理。
export const RERUN_ACK_REPLY = '收到，这条等上一轮跑完一起处理'
// 只是催 / 重复同一个请求（lark-task-merge isNudgeFollowUp）：在跑的这轮就在做它，结论出来一起 @ 它；结论刚发在它之前的，指过去，不重跑。
export const NUDGE_RUNNING_ACK_REPLY = '在做了，有结果一起回你'
export const ANSWERED_BEFORE_ACK_REPLY = '结论刚发在上面了，有问题再叫我'
const MERGED_ACK_REPLY = { rerun_after_done: RERUN_ACK_REPLY, nudge_running: NUDGE_RUNNING_ACK_REPLY, answered_before: ANSWERED_BEFORE_ACK_REPLY }
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
// 点名环境不相交就算另一件事，只对「在某个环境上看 / 答」的交付物成立：实测 / 答疑（uat 那条答完，又要「复测 OL」）。
// 改码不看环境（11-03 合入前 review）：「test 环境 xx 按钮错位」改码单在跑，「pre 也有这个问题」改的是同一处代码，照交付物规则并入，不另起平行改码。
// 只查本条：本条是实测 / 答疑而目标交付物不同的，下面 mine === theirs 本来就不成立。
const ENV_SCOPED_DELIVERABLES = new Set(['verification', 'answer'])
// 别人的只读活正在跑（答疑 / 实测），另一个人来的答疑 / 实测不排在它后面（rerun_after_done 要等这轮跑完再整单重跑一轮）：另起、并行答。
// 同一个人在跑时补一句 / 改口照旧并入（下一轮按改过的问题答）；改码不拆（同一处代码两张单会打架）。
const RUNNING_STATUSES = new Set(['running', 'verifying'])
export const compatibleContinuation = ({ task, target }) => {
  const mine = task?.contract?.deliverable || null
  const theirs = target?.contract?.deliverable || null
  if (!mine || !theirs || MERGE_ANY_STATUSES.has(target.status)) return true
  const envA = task?.envTargets || []
  const envB = target?.envTargets || []
  if (ENV_SCOPED_DELIVERABLES.has(mine) && envA.length && envB.length && !envA.some((env) => envB.includes(env))) return false
  if (ENV_SCOPED_DELIVERABLES.has(mine) && RUNNING_STATUSES.has(target.status) && task.operator && target.operator && task.operator !== target.operator) return false
  return mine === theirs
}

// 锚点（回复了哪张 bot 卡 / 在哪个话题里）只说明本条落在哪，不说明是同一件事：只有还没了结的锚点才凭它并入（在跑 / 排队的改码单收补充、
// 挂起的等补料）；已了结的锚点要重开，得分类器自己判 continues（它看过候选和锚点仍没填，就是另一件事）。
// 11-04 falive 回放 b2 ep-1031-35935b：Arthur 在 bot 卡片话题里先要账号密码（判 ignore、已回一句），再报「日志里没找到请求 id、UAT 链路正常」
//（continues 指向答疑那条、交付物不同被拒），再要「测一下生产环境评论积分」（continues=null）——两条都凭锚点重开了要密码那条，
// 一个任务连干三件事：去 pre 白测一轮、没解释请求 id 的来历、说「没有生产账号」。
const ANCHOR_OPEN_STATUSES = new Set(['received', 'queued', 'running', 'verifying', 'waiting_confirmation', 'blocked'])

// 延续目标：分类器点名的 continues 最强；点名了但交付物 / 环境对不上 = 同一主题的另一件事，另起，不再退到锚点（分类器已经判过主题）。
// 没点名时控制通道锚到的任务（anchorTaskId）只对改码 / 对接类生效（提问 / 闲聊不并进别人的工单），且锚点要还没了结、交付物兼容。
// 直接回复 bot 的某张卡（quotedOwnCard，锚点就是那张卡的任务）：本条归那张卡的事，分类器点名别的任务也不并过去（11-04 b2 ep-1014-d74f19：
// Ache 回 R6 复测卡「麻烦再看看」被并进同话题 Arthur 的 123456 / token 复测单，R6 一直没测）；按锚点规则判（没了结 + 交付物兼容才并）。
export const resolveMergeTarget = ({ task, store }) => {
  const cls = task.intake?.classification || null
  const card = task.quotedOwnCard && task.intake?.anchorTaskId ? mergeableTarget({ store, id: task.intake.anchorTaskId, selfId: task.id }) : null
  const namedRaw = cls?.continues ? mergeableTarget({ store, id: cls.continues, selfId: task.id }) : null
  if (card && namedRaw && namedRaw.id !== card.id) {
    console.log(`[lark-gateway] ${task.id} 回复的是 ${card.id} 的卡，continues=${namedRaw.id} 是别的任务，不并过去`)
    return ANCHOR_OPEN_STATUSES.has(card.status) && MERGE_DECISIONS.has(cls?.decision) && compatibleContinuation({ task, target: card }) ? card : null
  }
  const named = namedRaw
  if (named && compatibleContinuation({ task, target: named })) return named
  if (named) {
    console.log(`[lark-gateway] ${task.id} continues=${named.id} 但交付物不同（${task.contract?.deliverable} vs ${named.contract?.deliverable}，${named.status}），另起任务`)
    return null
  }
  const anchorId = task.intake?.anchorTaskId || null
  if (!anchorId || !MERGE_DECISIONS.has(cls?.decision)) return null
  const anchor = mergeableTarget({ store, id: anchorId, selfId: task.id })
  if (!anchor) return null
  // 分类器写了 continues 但那条找不到（编错 id / 指向人工取消的）：它判了是延续，锚点就是它要接的那张卡，已了结的也可以重开。
  if (!ANCHOR_OPEN_STATUSES.has(anchor.status) && !cls.continues) {
    console.log(`[lark-gateway] ${task.id} 锚在已了结的 ${anchor.id}（${anchor.status}），分类器没判延续，另起任务`)
    return null
  }
  if (!compatibleContinuation({ task, target: anchor })) {
    console.log(`[lark-gateway] ${task.id} 锚在 ${anchor.id} 但交付物不同（${task.contract?.deliverable} vs ${anchor.contract?.deliverable}，${anchor.status}），另起任务`)
    return null
  }
  return anchor
}

// 负责人私聊指示判 ignore 时，只有「明确拒绝」才把锚点一并结掉（11-03 合入前 review）：aven 对「🛠 开始做」私信回「收到 / 知道了」也会被短指代
// 锚到在跑任务、建成指示任务，分类器把寒暄判 ignore，原先照样把在跑的锚点结成 no_longer_needed。
// 判据按负责人原话（11-03 第二次 review）：原来看分类器 reply 有无 + reason 关键词，两头都错——「收到，谢谢」「好的辛苦了」不在寒暄词表、
// 分类器写了 reply 就当拒绝；真拒绝的 reason 写「负责人知会归后端」又被「知会」豁免。现在复用挂起任务那套否定 / 归属判定（isPrincipalDecline）：
// 原话是拒绝 / 归属才结锚点；寒暄或认不出都不结。原话 = text 里「【aven 私聊指示】」之后、「【指示针对的群消息…】」之前那段。
const principalWords = (task) => String(task?.text || '').split('\n\n【')[0].replace(/^【[^】]*】/, '').trim()
const ACK_WORD = '(?:收到|知道了|了解|明白|好的?|好嘞|ok|okay|嗯嗯?|谢谢|多谢|感谢|辛苦了?)'
const ACK_ONLY_RE = new RegExp(`^(?:${ACK_WORD}[吧啊呀呢的了啦]?[，,。.!！~～\\s]*)+$`, 'i')
// 负责人原话整句就是寒暄（「收到」「收到，谢谢」「好的辛苦了」「ok 收到」「嗯嗯好的」）：既不算拒绝，也不往群里回分类器写的 reply（那句只会是噪音）。
export const isPrincipalAckOnly = (task) => ACK_ONLY_RE.test(principalWords(task))
export const privateInstructionDeclines = ({ task }) => isPrincipalDecline(principalWords(task))

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
      const flushed = await say.flush({ config, store, task, reply: MERGED_ACK_REPLY[merged.mode] || reply, send: true, reason: `merged:${merged.mode}` })
      // 结论已经答到它了：这句指过去就算了结（不然 4 小时后催办「答应了没结论」）。
      if (merged.mode === 'answered_before' && flushed?.usedReply) noteAnswer({ task, text: ANSWERED_BEFORE_ACK_REPLY })
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
    // 只有明确拒绝才结（见 privateInstructionDeclines）；寒暄不动锚点，私信说一句它照常在做。
    const anchor = task.privateOrigin.anchorId ? store.get(task.privateOrigin.anchorId) : null
    const active = Boolean(anchor) && isControlActiveStatus(anchor.status)
    const declines = privateInstructionDeclines({ task })
    const closed = active && declines
      ? store.closeAsExternallyResolved({ id: anchor.id, operator: task.privateOrigin.senderOpenId || task.operator || null, messageId: task.id, closureReason: 'no_longer_needed' })
      : null
    // 回群跟同一份原话判定走：原话是拒绝 → 回那句礼貌拒绝；寒暄 → 不回；锚点还在跑又没结掉 → 不回（它自己会给结论，
    // 先回一句拒绝再来「改好了」自相矛盾，fix14 留的口子）；其余（锚点已了结、他说怎么回群）照旧回。
    if (reply && !isPrincipalAckOnly(task) && !(active && !closed)) await say.noted({ config, store, task: { ...task, privateOrigin: null }, reply })
    const head = task.privateOrigin.anchorHead
    const text = active && !declines ? `好，「${head}」那条照常在做，没动它。` : `记下了，「${head}」这条不用动手${closed ? '；原来在跑的那条也关掉了，不再回群结论' : ''}。`
    await say.principal({ config, store, text, taskId: task.id, kind: 'ignored_after_ack' })
    log(`负责人指示：不处理${closed ? `，锚点 ${anchor.id} 由 ${closed.previousStatus} 结掉` : ''}`)
    return result({ ignored: true, ...(closed ? { anchorClosed: anchor.id } : {}) })
  }
  // 回复 bot 消息、没 @ 它，分类器判不是对机器人说的（ignore 且 reply=null，见 lib/lark-classify-prompt addressedBlock）：人在 bot 卡片下的话题里
  // 跟同事说话，不插话、不私信负责人（11-04 falive 回放：aven「cc @Encone」被回「收到，记下了」）；「收到」已经按固定句发出去的照旧私信一句。
  // 回复 bot 消息没 @ 它、判不用处理的，分类器写了 reply 也不回（11-04 b3 ep-1031-f8065f：aven 在 bot 卡片话题里发半句「如果不方便补信息,」，
  // 分类器判 ignore 却写了「这句好像没发完…」，原先只认 reply=null 才静默，这句发进了群）。没 @ 的话 bot 只在有事可做时出声。
  if (task.addressedToBot && isReplyWithoutAt(task)) {
    await say.flush({ config, store, task, reply: null, send: false })
    if (task.ackedInGroup) await say.ignoredAfterAck({ config, store, task })
    log(saidToOthers(task, cls) ? '回复 bot 消息没 @ 它、不是对机器人说的，静默' : '回复 bot 消息没 @ 它、判不用处理，静默')
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
