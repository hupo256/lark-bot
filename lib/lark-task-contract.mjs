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
 */

import { hasDocAttachment, ownMessageText, parseCommandType, requestsPreCheck, requestsVisualCheck, WRITE_INTENT_RE } from './lark-message.mjs'

export const CONTRACT_VERSION = 1
export const DELIVERABLES = ['change', 'verification', 'answer', 'doc_intake']
const CLASSIFIER_DELIVERABLES = { verification: 'verification', answer: 'answer', change: 'change' }

// 本条原话里让人改东西的说法（「改完在 pre 看下」不是纯复测）。
const ASKS_CHANGE_RE = /改|修|加上|删/

// 只看本条原话（不看被引用的卡片、之前的群消息）：bot 自己的卡里常写「请测试同学在 pre 看一眼」，按全文判会误伤。
export const deriveContract = (task) => {
  if (!task?.repo) return null
  const own = ownMessageText(task.text).replace(/^(?:@\S+\s*)+/, '') // 开头的 @Aven.Bot 不算原话
  const prefix = parseCommandType(own)
  const cls = task.intake?.classification || null
  const docIntake = Boolean(task.addressedToBot && hasDocAttachment(task.attachments || []))
  let deliverable = null
  let source = null
  if (docIntake) [deliverable, source] = ['doc_intake', 'attachment']
  else if (prefix === 'status') [deliverable, source] = ['answer', 'prefix']
  else if (prefix) [deliverable, source] = ['change', 'prefix']
  else if (CLASSIFIER_DELIVERABLES[cls?.deliverable]) [deliverable, source] = [CLASSIFIER_DELIVERABLES[cls.deliverable], 'classifier']
  else if (cls?.decision === 'question') [deliverable, source] = ['answer', 'classifier']
  else if (requestsPreCheck(task) && !WRITE_INTENT_RE.test(own) && !ASKS_CHANGE_RE.test(own)) [deliverable, source] = ['verification', 'regex']
  else if (cls) [deliverable, source] = ['change', 'classifier']
  if (!deliverable) return null
  const api = docIntake || prefix === 'api' || cls?.decision === 'api_reply'
  return {
    v: CONTRACT_VERSION,
    deliverable,
    source,
    readOnly: deliverable === 'answer',
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

// 读契约：已存的且版本对就用，否则现算（不回写磁盘；网关和 worker 新旧代码短暂并存时两边都能用）。
export const taskContract = (task) => (task?.contract?.v === CONTRACT_VERSION ? task.contract : deriveContract(task))

// 任务内容被正当改写时重算（待命指令触发：正文换成之前的交办）。
export const refreshContract = (task) => {
  const contract = deriveContract(task)
  if (contract) task.contract = contract
  else delete task.contract
  return task
}
