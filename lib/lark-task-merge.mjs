/**
 * 主题归并（falive store.mergeIntoTask 的函数体拆成纯函数，11-01 对话层）：分类器判定本条是已有任务的延续
 *（cls.continues）或控制通道锚到了旧任务 → 把本条并入目标任务，本条落 superseded（不再独立执行）。
 *
 * 为什么拆出来：store 只管并发 / 幂等 / 持久化，归并怎么改两份任务对象在这里一眼看全，单测直接喂对象、不建目录。
 *
 * 目标任务按状态分五种模式（plan §3.3）：
 *   appended            目标还没开跑（received / queued）：追加正文一起跑
 *   rerun_after_done    目标在跑（running / verifying）：跑完带补充再跑一轮、不发第二张
 *   appended_suspected  目标是挂着等负责人放行的疑似任务：只追加内容、继续等人，绝不因为又来一条就自动开跑
 *   resumed             目标挂起（waiting_confirmation / blocked）：当作补料续跑（经 store 的 requeueTask 换代）
 *   reopened            目标已了结（done / failed / no_change / ignored / answered…，终态含 answered）：重开直接排队
 *                      （11-01「有哪些差别」并入「test / pre 是否一样」那条续答，契约随新消息）
 *   nudge_running       目标在跑、本条只是催 / 重复同一个请求（isNudgeFollowUp）：不打 rerunAfterDone，这轮结论顺带答它（answerFor + 末行 @）
 *   answered_before     目标已了结、本条只是催，且发在这轮结论送达之前（人还没看到结论）：不重开，结论就是答它
 *                      （falive 回放 b2 ep-1014-d74f19：「这也麻烦在测试下」「麻烦在看看 有没有问题」各触发一轮重跑，群里 4 分钟连发 3 条几乎一样的结论）
 *   superseded 的目标一律不并（返回 null，11-02 复核）：被兄弟归并掉的 / 人工结单取消的，复活它等于把取消的活再跑一遍或双跑；
 *   该指到谁由调用方（lark-routes-intake mergeableTarget 顺 supersededBy）决定，这里只守底线。
 *
 * 新消息的对话包覆盖目标的（latest wins）；契约只在终态重开时随新消息（续答要按新问题的交付物跑），其余模式保留目标的
 *（还是那件事：挂着的改码单来了补料，不能变成只读代答）。
 * 终态重开（reopened）时回复目标 / 提单人 / 话题根也换成新消息的（messageId 不换，见下方注释）（11-03 静态 review R8：A 问「test / pre 是否一样」
 * 答完，B 同话题「有哪些差别」并入重开，结论原先回到 A 的消息、回落直发 @ 的是 A，B 的回复义务停在 acked）；挂起续跑（resumed）是补料，
 * 不换（11-03 合入前 review：A 报 bug 挂着等文档，William「@bot 文档在这」并入，换了结论就回到 William、A 收不到；补料人由 delivery 的
 * 并入人末行 @ 覆盖）；在跑 / 没开跑的并入（rerun_after_done / appended / appended_suspected）本轮结论仍回原消息，只记 mergedFrom，不换目标。
 */

import { PRIOR_CONCLUSION_MAX, priorConclusionOf } from './lark-intake-resolve.mjs'
import { ownMessageText } from './lark-message.mjs'

const MERGED_FROM_MAX = 50
const HISTORY_MAX = 20

// 重开时目标自己上一轮的结论（11-03 第二次 review #5）：B 接着的是这一轮，不是目标第一次分类时接着的那单。outcome 优先，
// 没有（自答 / 老任务只有 result）退到 result 文本。续跑 / 追加不动 priorConclusion：还是同一件事没跑完，当初接着的那单仍是背景。
const ownLastConclusion = (task) => priorConclusionOf(task) || (typeof task.result === 'string' && task.result.trim()
  ? { taskId: task.id, summary: task.summary || null, text: task.result.trim().slice(0, PRIOR_CONCLUSION_MAX) }
  : null)

// 只是催 / 把同一个请求再说一遍（「这也麻烦在测试下」「麻烦在看看 有没有问题」「进度怎么样」）：本条原话（【本条 @】那行，不看引用卡片和群上下文）
// 去掉 @ / 标点后 ≤ 20 字，且整句都由催办 / 客套词拼成、拆完没剩东西；自己带了附件（不算从群上下文带进来的 origin 附件）的不算。
// 剩了任何别的字（「改成红色」「测一下 pre」「用 508」）都当有新内容——宁可多跑一轮，不吞人家补的东西。
const NUDGE_TOKENS = ['有没有问题', '有问题吗', '怎么样了', '怎么样', '好了吗', '完了吗', '有进展吗', '有进展', '进度', '在吗', '麻烦', '帮忙', '帮我', '帮', '请',
  '再', '在', '也', '一起', '这个', '这条', '那个', '那条', '这', '那', '一下', '下', '复测', '测试', '测', '看看', '看一下', '看下', '看', '检查', '查', '试试', '试',
  '确认', '处理', '跟进', '催', '谢谢', '辛苦', '吧', '呢', '了', '的', '啊', '哈', '嘛']
const NUDGE_TOKEN_RE = new RegExp(NUDGE_TOKENS.sort((a, b) => b.length - a.length).join('|'), 'g')
const squash = (text) => String(text || '').replace(/@\S+/g, '').replace(/[\s，,。.!！?？~～、：:]+/g, '')
const ownAttachment = (task) => (task?.attachments || []).some((item) => !item?.origin)
export const isNudgeFollowUp = (task) => {
  if (ownAttachment(task)) return false
  const own = squash(ownMessageText(task?.text))
  return own.length > 0 && own.length <= 20 && own.replace(NUDGE_TOKEN_RE, '') === ''
}
// 把目标单已经带着的一段话原样再发一遍（11-05 b3 ep-1029-8aca6e 26c9c800：Encone 17:33 发了 uat / online 域名、紧接着空 @ 建了单，
// 17:36 同一段带 @bot 又发一遍，并进在跑单打了 rerunAfterDone，重跑出一条和上一条口径相反的「不用改」）：跟催一样，这轮结论就是答它。
// 本条原话去掉 @ / 标点后 ≥ 12 字（短句交给 isNudgeFollowUp），自己没带附件，且整段出现在目标单的正文里（原话 / 引用 / 前文 / 补充都算）。
const REPEAT_MIN_CHARS = 12
export const repeatsTargetText = (from, into) => {
  if (ownAttachment(from)) return false
  const own = squash(ownMessageText(from?.text))
  return own.length >= REPEAT_MIN_CHARS && squash(into?.text).includes(own)
}
// 这轮结论（done / no_change_needed）已送达、且本条发在送达之前：人发这句时还没看到结论。
const RESULT_DELIVERED = new Set(['done', 'no_change_needed'])
const sentBeforeConclusion = (from, into) => {
  const receipt = into.lastDeliveredReceipt
  if (!receipt || !RESULT_DELIVERED.has(receipt.status) || !RESULT_DELIVERED.has(into.status) || (receipt.epoch ?? 0) !== (into.epoch || 0)) return false
  const sentAt = Date.parse(from.messageCreatedAt || from.createdAt || '')
  const deliveredAt = Date.parse(receipt.deliveredAt || '')
  return Number.isFinite(sentAt) && Number.isFinite(deliveredAt) && sentAt <= deliveredAt
}

// 在跑时并入（rerun_after_done）的那轮跑完、回队重跑前（store.requeueMergedFollowUp 调，回队换代由 store 做）：本轮存进 threadHistory、
// 清结果 / 挂起字段，priorConclusion 换成本单刚发出去的这轮结论（11-03 review 遗留：原先还是当初接着的那单，重跑看不到自己刚在群里说了什么，
// 把答过的再答一遍）；这轮没结论（失败没 outcome / result）就留着原来的背景。
export const prepareMergedRerun = (task) => {
  task.threadHistory = [...(task.threadHistory || []), { status: task.status, result: task.result || null, closedAt: task.updatedAt || null }].slice(-HISTORY_MAX)
  const own = ownLastConclusion(task)
  if (own) task.priorConclusion = own
  task.result = null
  task.owner = null
  task.noChangeReason = null
  task.scopeRequest = null
  task.parkedAt = null
  task.parkedRemindedRound = 0
}

// 把 from 并进 into，返回模式字符串；两份对象都被就地改写，持久化由调用方负责。from / into 缺失或同一条 → null。
// requeueTask(into)：store 传进来的「回队 + 换代」（queued / claimedAt=null / epoch++ / 删 pendingReceipt）。
export const mergeTaskObjects = ({ from, into, requeueTask, now = new Date().toISOString() }) => {
  if (!from || !into || from.id === into.id || into.status === 'superseded') return null
  const nudge = isNudgeFollowUp(from) || repeatsTargetText(from, into) // 先比，再把本条追加进目标正文
  // 补充带上是谁说的（ingest 记的 operatorName；11-05 b3 ep-1029-8aca6e 4abde287：结论把提问的 William 叫成 Encone）。
  const supplement = `【同主题补充 ${now.slice(0, 16)}${from.operatorName ? ` · ${from.operatorName}` : ''}】${String(from.text || '').trim() || '（附件）'}`
  into.text = `${into.text || ''}\n\n${supplement}`.trim()
  if (from.attachments?.length) into.attachments = [...(into.attachments || []), ...from.attachments]
  into.mergedFrom = [...(into.mergedFrom || []), from.id].slice(-MERGED_FROM_MAX)
  let mode
  if (into.status === 'received' || into.status === 'queued') {
    mode = 'appended'
  } else if ((into.status === 'running' || into.status === 'verifying') && nudge) {
    // 在跑的这轮就是在做它要的事：不再欠一轮；这轮结论末行 @ 它（delivery mergedAskers），义务一并记 answered（answerFor）。
    into.answerFor = [...(into.answerFor || []), from.id].slice(-HISTORY_MAX)
    mode = 'nudge_running'
  } else if (into.status === 'running' || into.status === 'verifying') {
    into.rerunAfterDone = true
    mode = 'rerun_after_done'
  } else if (nudge && sentBeforeConclusion(from, into)) {
    // 结论刚送达、这句发在它之前：结论就是答它，不重开（调用方回一句指过去，并记它的义务 answered）。已指过，下一轮不再 @。
    into.mergedNotified = [...new Set([...(into.mergedNotified || []), from.id])].slice(-MERGED_FROM_MAX)
    mode = 'answered_before'
  } else if (into.status === 'waiting_confirmation' && into.suspected) {
    mode = 'appended_suspected'
  } else if (into.status === 'waiting_confirmation' || into.status === 'blocked') {
    into.waitingHistory = [...(into.waitingHistory || []), { round: into.waitRound || 1, epoch: into.epoch || 0, status: into.status, result: into.result ?? null, resumedAt: now }].slice(-HISTORY_MAX)
    into.scopeRequest = null
    requeueTask(into)
    into.resumeCount = (into.resumeCount || 0) + 1
    into.result = null
    into.owner = null
    into.parkedAt = null
    into.parkedRemindedRound = 0
    mode = 'resumed'
  } else {
    // 终态重开：不走 requeueTask（它会删 pendingReceipt、记 requeuedAt，那是续跑语义）；换代挡掉旧执行的迟到回写。
    into.threadHistory = [...(into.threadHistory || []), { status: into.status, result: into.result || null, closedAt: into.updatedAt || null }].slice(-HISTORY_MAX)
    const own = ownLastConclusion(into)
    if (own) into.priorConclusion = own
    else delete into.priorConclusion
    into.result = null
    into.owner = null
    into.noChangeReason = null
    into.scopeRequest = null
    into.parkedAt = null
    into.parkedRemindedRound = 0
    into.claimedAt = null
    into.status = 'queued'
    into.epoch = (into.epoch || 0) + 1
    // 这轮结论也是给来源那条的：delivery 的 noteAnswer 按 answerFor 把它的回复义务一并记 answered（11-03 合入前 review）。
    into.answerFor = [...(into.answerFor || []), from.id].slice(-HISTORY_MAX)
    mode = 'reopened'
  }
  // 结论已答到它：目标的执行字段（ackReply / 契约 / 环境 / 对话包）都不动，只记来源、本条落 superseded。
  if (mode === 'answered_before') return supersede({ from, into, now, mode })
  // 负责人私信指示（「继续任务 <id> 做」走指示任务并进来）把目标续跑 / 重开的这一代：记 resumeAsk，出口在群里回完 / 要完材料后也私信他一句
  //（lark-delivery resumedFromPrincipalDm；11-05 b3 ep-1021-d4e64d 99cadc79：群里 blocked_ask 了，aven 私信里没有下文）。别人续跑 / 重开的清掉。
  if (mode === 'resumed' || mode === 'reopened') {
    if (from.privateOrigin) into.resumeAsk = { by: from.privateOrigin.senderOpenId || from.operator || null, epoch: into.epoch || 0, at: now }
    else delete into.resumeAsk
  }
  // messageId 不换：它是任务自己那条消息（routes retry 按它重下原附件），回复目标只看 replyTarget。
  if (mode === 'reopened') {
    for (const key of ['operator', 'replyTarget', 'threadRootId']) if (from[key]) into[key] = from[key]
    if (from.operator) into.operatorName = from.operatorName || null
  }
  // 命令类型决定任务性质（resolveWorkKind：api / fix → 缺陷修复），与契约同口径：只在重开或目标还没契约时随新消息。b3 ep-1023-9f0fd7：
  // 头像切 Go 接口的需求单挂着，Arthur「是的」判 api_reply 并入续跑，commandType=api 带过去把需求单变成缺陷修复。
  if (from.commandType && !into.commandType && (mode === 'reopened' || !into.contract)) {
    into.commandType = from.commandType
    into.commandTypeSource = from.commandTypeSource || 'explicit'
  }
  // 「群里已先回了一句」（worker 只读 ackReply）换成来源那条已发出的「收到」；来源还没发的（routes 并入后才 flush，届时写到这里），
  // 重开 / 续跑时目标那句是上一轮的，删掉；在跑 / 没开跑的那句这轮仍欠着，留着（11-03 第二次 review #4）。
  if (from.ackReply) into.ackReply = from.ackReply
  else if (mode === 'reopened' || mode === 'resumed') delete into.ackReply
  // 契约只在重开时随新消息（续答按新问题的交付物跑）；续跑 / 在跑 / 没开跑的还是目标那件事，保留目标的（11-03 第二次 review #6：
  // A 的改码单挂着等文档，William「@bot 文档在这，你看还缺啥吗」判 answer 并入续跑，原先换成只读代答、不改代码就 done）。
  if (from.contract && (mode === 'reopened' || !into.contract)) into.contract = from.contract
  // 点名的环境跟新消息走（11-03 falive 回放 r3-c：「复测 OL」并进 uat 那条，收尾核对还拿 uat 比，结论开头警告「测的不是你说的 uat」）；
  // 在跑 / 没开跑的合并取并集（这轮或下一轮两个都要测）。
  if (from.envTargets?.length) into.envTargets = mode === 'reopened' || mode === 'resumed' ? [...from.envTargets] : [...new Set([...(into.envTargets || []), ...from.envTargets])]
  if (from.conversation) into.conversation = from.conversation
  return supersede({ from, into, now, mode })
}

const supersede = ({ from, into, now, mode }) => {
  into.updatedAt = now
  from.status = 'superseded'
  from.supersededBy = into.id
  from.epoch = (from.epoch || 0) + 1
  from.updatedAt = now
  return mode
}
