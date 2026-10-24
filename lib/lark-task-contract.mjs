/**
 * 任务契约（10-21 架构加固 P2）：一条仓库任务「交付什么、怎样算完成」只在分类回写时算一次，存到 task.contract。
 *
 * 为什么：任务类型原来在约 12 处各自判定（commandType 正则每次对改过的正文重跑、workKind、expectsCodeChange、
 * resolveTaskMode、allowsDocsOnlyDone、requestsPreCheck、isQuestion、视觉验证正则…），会互相打架。
 * 10-20 #58：aven「你自己在 pre 环境看，看完报告结果」被分类成 requirement → 提示说跳过浏览器（视觉正则没命中）
 * → 只回填了文档 → done.trust 说「只改文档不算修复」判失败 → 回答丢了。每处单看都对，合起来错。
 *
 * 现在：各处判定只要看到 task.contract 就以它为准（lark-message / work-policy / quality-gate / defect-rules /
 * worker-prompts / delivery 读字段，不 import 本模块，避免循环）。没有契约的任务（老任务、bug 表、系统任务）照旧走原逻辑。
 *
 * deliverable：
 *   change       要改业务代码（缺陷 / 需求 / 对接答复）
 *   verification 去环境上看 / 复测 / 看完报告——交付的是实测结论，不改代码也是完成
 *   answer       回答群里的提问（只读）
 *   doc_intake   @bot 带来的对接文档（存档、按文档接入）
 *   record       对接答复 / 通知，前端什么都不用做：只记台账、群里一句中性确认就结单，不开 worktree（10-23 #74）
 */

import { hasDocAttachment, ownCommandPrefix, ownMessageText, requestsPreCheck, requestsVisualCheck, WRITE_INTENT_RE } from './lark-message.mjs'

export const CONTRACT_VERSION = 1
const CLASSIFIER_DELIVERABLES = { verification: 'verification', answer: 'answer', change: 'change' }

// 本条原话里让人改东西的说法（「改完在 pre 看下」不是纯复测）。
const ASKS_CHANGE_RE = /改|修|加上|删/

// 只记一笔（10-23 #74）：对接答复且分类器说前端什么都不用做（deliverable 为空）、不是把等的东西带来了 / 续跑、
// 不是负责人私聊指示、不是对接文档。10-23 真机：Encone「pre 还不能发帖、评论」被算成 expectsCode、挂疑似私聊 aven。
export const isRecordOnly = (task, cls = task?.intake?.classification) => Boolean(task?.repo) && cls?.decision === 'api_reply' &&
  cls.deliverable == null && cls.forMe !== false && cls.satisfiesWait !== true && !task.privateOrigin && !task.standingFrom?.length &&
  !hasDocAttachment(task.attachments || [])

// 只看本条原话（不看被引用的卡片、之前的群消息）：bot 自己的卡里常写「请测试同学在 pre 看一眼」，按全文判会误伤。
export const deriveContract = (task) => {
  if (!task?.repo) return null
  const own = ownMessageText(task.text).replace(/^(?:@\S+\s*)+/, '') // 开头的 @Aven.Bot 不算原话
  const prefix = ownCommandPrefix(task.text)
  const cls = task.intake?.classification || null
  const docIntake = Boolean(task.addressedToBot && hasDocAttachment(task.attachments || []))
  let deliverable = null
  let source = null
  if (docIntake) [deliverable, source] = ['doc_intake', 'attachment']
  else if (prefix === 'status') [deliverable, source] = ['answer', 'prefix']
  else if (prefix) [deliverable, source] = ['change', 'prefix']
  else if (CLASSIFIER_DELIVERABLES[cls?.deliverable]) [deliverable, source] = [CLASSIFIER_DELIVERABLES[cls.deliverable], 'classifier']
  else if (isRecordOnly(task, cls)) [deliverable, source] = ['record', 'classifier']
  else if (cls?.decision === 'question') [deliverable, source] = ['answer', 'classifier']
  else if (requestsPreCheck(task) && !WRITE_INTENT_RE.test(own) && !ASKS_CHANGE_RE.test(own)) [deliverable, source] = ['verification', 'regex']
  else if (cls) [deliverable, source] = ['change', 'classifier']
  if (!deliverable) return null
  const api = docIntake || prefix === 'api' || cls?.decision === 'api_reply'
  return {
    v: CONTRACT_VERSION,
    deliverable,
    source,
    readOnly: deliverable === 'answer' || deliverable === 'record',
    // 要改代码的：done.trust 查「只动测试 / 只动文档」、范围契约核对。对接文档入库也可能按文档改代码，范围照查。
    expectsCode: deliverable === 'change' || deliverable === 'doc_intake',
    // 没有代码改动也是完成（实测结论 / 回答 / 文档已存档）。
    emptyDiffOk: deliverable !== 'change',
    // 只改了文档也是完成：上面几类 + 对接答复（回填对接文档是正当产出）。
    docsOnlyOk: deliverable !== 'change' || api,
    browser: deliverable === 'verification' || requestsVisualCheck(own),
    api,
    defect: deliverable === 'change' && cls?.decision === 'bug',
  }
}

// @bot 交办的只读活（测试 / 复测 / 确认 / 查找 / 回答，契约 verification / answer）：不改代码，不看归属，直接做、结论回群
//（aven 2026-10-24：「这样 @bot 帮助测试、复测、确认、查找的任务，只要不是改代码的，直接做，做完结果回群」）。
// cls 可传分类器刚出的结果（入队判定时契约还没落到任务上）。
export const isReadOnlyAsk = (task, cls = task?.intake?.classification) => {
  // 负责人私聊指示不走这里（他说「不做」时分类器判 ignore，不能因为 deliverable 被放行）。
  if (!task?.repo || !task.addressedToBot || task.privateOrigin) return false
  // 判 ignore 的只认分类器明确填的 deliverable：契约会按原话正则推 verification（「21 点前别测」里有「测」），不能据此开跑。
  if (cls?.decision === 'ignore') return cls.deliverable === 'verification' || cls.deliverable === 'answer'
  const contract = cls ? deriveContract({ ...task, intake: { ...task.intake, classification: cls } }) : taskContract(task)
  return contract?.deliverable === 'verification' || contract?.deliverable === 'answer'
}

// 读契约：已存的且版本对就用，否则现算（不回写磁盘；网关和 worker 新旧代码短暂并存时两边都能用）。
export const taskContract = (task) => (task?.contract?.v === CONTRACT_VERSION ? task.contract : deriveContract(task))

// 任务内容被正当改写时重算（待命指令触发：正文换成之前的交办）。
export const refreshContract = (task) => {
  const contract = deriveContract(task)
  if (contract) task.contract = contract
  else delete task.contract
  return task
}
