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
 *   superseded 的目标一律不并（返回 null，11-02 复核）：被兄弟归并掉的 / 人工结单取消的，复活它等于把取消的活再跑一遍或双跑；
 *   该指到谁由调用方（lark-routes-intake mergeableTarget 顺 supersededBy）决定，这里只守底线。
 *
 * 新消息的契约 / 对话包覆盖目标的（latest wins）：续答要按新问题的交付物跑，不是按旧问题的。
 * 终态重开 / 挂起续跑（reopened / resumed）时回复目标 / 提单人 / 话题根也换成新消息的（11-03 静态 review R8：A 问「test / pre 是否一样」
 * 答完，B 同话题「有哪些差别」并入重开，结论原先回到 A 的消息、回落直发 @ 的是 A，B 的回复义务停在 acked）；在跑 / 没开跑的并入
 *（rerun_after_done / appended / appended_suspected）本轮结论仍回原消息，只记 mergedFrom，不换目标。
 */

const MERGED_FROM_MAX = 50
const HISTORY_MAX = 20

// 把 from 并进 into，返回模式字符串；两份对象都被就地改写，持久化由调用方负责。from / into 缺失或同一条 → null。
// requeueTask(into)：store 传进来的「回队 + 换代」（queued / claimedAt=null / epoch++ / 删 pendingReceipt）。
export const mergeTaskObjects = ({ from, into, requeueTask, now = new Date().toISOString() }) => {
  if (!from || !into || from.id === into.id || into.status === 'superseded') return null
  const supplement = `【同主题补充 ${now.slice(0, 16)}】${String(from.text || '').trim() || '（附件）'}`
  into.text = `${into.text || ''}\n\n${supplement}`.trim()
  if (from.attachments?.length) into.attachments = [...(into.attachments || []), ...from.attachments]
  into.mergedFrom = [...(into.mergedFrom || []), from.id].slice(-MERGED_FROM_MAX)
  let mode
  if (into.status === 'received' || into.status === 'queued') {
    mode = 'appended'
  } else if (into.status === 'running' || into.status === 'verifying') {
    into.rerunAfterDone = true
    mode = 'rerun_after_done'
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
    into.result = null
    into.owner = null
    into.noChangeReason = null
    into.scopeRequest = null
    into.parkedAt = null
    into.parkedRemindedRound = 0
    into.claimedAt = null
    into.status = 'queued'
    into.epoch = (into.epoch || 0) + 1
    mode = 'reopened'
  }
  if (mode === 'resumed' || mode === 'reopened') {
    for (const key of ['operator', 'replyTarget', 'messageId', 'threadRootId']) if (from[key]) into[key] = from[key]
  }
  if (from.commandType && !into.commandType) {
    into.commandType = from.commandType
    into.commandTypeSource = from.commandTypeSource || 'explicit'
  }
  if (from.contract) into.contract = from.contract
  // 点名的环境跟新消息走（11-03 falive 回放 r3-c：「复测 OL」并进 uat 那条，收尾核对还拿 uat 比，结论开头警告「测的不是你说的 uat」）；
  // 在跑 / 没开跑的合并取并集（这轮或下一轮两个都要测）。
  if (from.envTargets?.length) into.envTargets = mode === 'reopened' || mode === 'resumed' ? [...from.envTargets] : [...new Set([...(into.envTargets || []), ...from.envTargets])]
  if (from.conversation) into.conversation = from.conversation
  into.updatedAt = now
  from.status = 'superseded'
  from.supersededBy = into.id
  from.epoch = (from.epoch || 0) + 1
  from.updatedAt = now
  return mode
}
