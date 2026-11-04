/**
 * 任务契约（从 falive 10-21 架构加固 P2 搬来，11-01 对话层改）：一条任务「交付什么、怎样算完成」只在分类回写时算一次，存到 task.contract。
 *
 * 为什么：任务类型原来在十几处各自判定（commandType 正则、workKind、expectsCodeChange、resolveTaskMode、requestsPreCheck、
 * 视觉验证正则…）互相打架。falive 10-20 #58：aven「你自己在 pre 环境看，看完报告结果」被分类成 requirement → 提示说跳过浏览器
 * → 只回填了文档 → done.trust 判失败 → 回答丢了。每处单看都对，合起来错。11-01 lark-bot 同病：「test、pre 代码是不是一样」答对了却落成「无需改动」卡。
 *
 * 现在：各处分流只读 task.contract（lark-message / work-policy / quality-gate / worker-prompts 读字段，不 import 本模块，避免循环）。
 * 没有契约的任务（老任务、bug 表、系统任务）照旧走原逻辑。
 *
 * deliverable：
 *   change       要改业务代码（缺陷 / 需求 / 对接答复）
 *   verification 去环境上看 / 复测 / 看完报告——交付的是实测结论，不改代码也是完成
 *   answer       回答提问（只读代答）
 *   record       对接答复 / 通知，前端什么都不用做：只回一句「记下了」就结单，不开 worktree（falive 10-23 #74）
 *   ops          负责人私信的固定运维动作（部署邮件 / 发 MR，lib/lark-ops-task.mjs）：不改代码、不跑模型
 *
 * 与 falive 的差别：去掉 task.repo 条件（lark-bot 只有 fameex-web 一个仓）、去掉 doc_intake（文档随对接答复走 change）、
 * 加 ops、加 selfAnswer（分类器已把关于 bot 自己的问题答完，不用再开执行）。
 */

import { hasDocAttachment, ownCommandPrefix, ownMessageText, requestsPreCheck, requestsVisualCheck, resolveCommandType, WRITE_INTENT_RE } from './lark-message.mjs'

export const CONTRACT_VERSION = 1
const CLASSIFIER_DELIVERABLES = { verification: 'verification', answer: 'answer', change: 'change' }

// 本条原话里让人改东西的说法（「改完在 pre 看下」不是纯复测）。
const ASKS_CHANGE_RE = /改|修|加上|删/

// 原话明确要造测试数据（aven 11-04：pre 测试与造数据用测试号；b3 ep-1024「创建最新的帖子 进行测试」、aven「写脚本在 pre 造帖」）：
// 「造」+ 帖子 / 评论 / 数据这类对象；或「创建 / 新建 / 生成 / 发几条」+ 对象且同一句说了拿来测。「能不能 / 可以 / 是否」问的是功能、
// 后面跟「失败 / 报错 / 不了」报的是 bug，都不算要造。只认这一条原话（不看引用 / 上文），只给实测 / 改码；放不放行另看配置 testData.envs。
const TEST_DATA_OBJECT = '(?:测试)?(?:帖子?|评论|回复|动态|数据|内容)'
const COUNT = '(?:一些|一批|几[条个篇]|[一两\\d]+\\s*[条个篇])'
const MAKE_RE = new RegExp(`造(?:一些|点|${COUNT})?(?:新的?|最新的?)?${TEST_DATA_OBJECT}`)
const CREATE_RE = new RegExp(`(?:(?:创建|新建|生成)${COUNT}?|(?:新?发|再发)${COUNT})(?:新的?|最新的?)?${TEST_DATA_OBJECT}`)
const FOR_TEST_RE = /测试|测一下|测下|测测|来测|复测/
const ASKS_ABILITY_RE = /(?:能不能|能否|可不可以|可以|是否)\s*$/
const REPORTS_BUG_RE = /^.{0,3}(?:失败|报错|不了|不行|异常|有问题|出错|没反应)/
export const requestsTestData = (own) => {
  const text = String(own || '')
  const make = MAKE_RE.exec(text)
  const hit = make || (FOR_TEST_RE.test(text) ? CREATE_RE.exec(text) : null)
  if (!hit) return false
  return !ASKS_ABILITY_RE.test(text.slice(Math.max(0, hit.index - 6), hit.index)) && !REPORTS_BUG_RE.test(text.slice(hit.index + hit[0].length))
}

// 只记一笔（falive #74）：对接答复且分类器说前端什么都不用做（deliverable 为空）、不是归别人的、不是负责人私聊指示、
// 没带对接文档（带了文档就有东西要存、要按文档接，不是「记一笔」）。10-23 真机：Encone「pre 还不能发帖、评论」被算成 expectsCode、挂疑似私聊 aven。
export const isRecordOnly = (task, cls = task?.intake?.classification) => cls?.decision === 'api_reply' &&
  cls.deliverable == null && cls.forMe !== false && !task?.privateOrigin && !hasDocAttachment(task?.attachments || [])

// 只看本条原话（不看被引用的卡片、之前的群消息）：bot 自己的回复里常写「请测试同学在 pre 看一眼」，按全文判会误伤。
// 判定顺序（先到先得）：运维 > 显式前缀 > 分类器给的 deliverable > 只记一笔 > 提问 > 原话正则（去 pre 看）> 分类器其它类别一律改码。
export const deriveContract = (task) => {
  if (!task) return null
  const own = ownMessageText(task.text).replace(/^(?:@\S+\s*)+/, '') // 开头的 @Aven.Bot 不算原话
  const prefix = ownCommandPrefix(task.text)
  const cls = task.intake?.classification || null
  let deliverable = null
  let source = null
  if (resolveCommandType(task).type === 'ops') [deliverable, source] = ['ops', 'ops']
  else if (prefix === 'status') [deliverable, source] = ['answer', 'prefix']
  else if (prefix) [deliverable, source] = ['change', 'prefix']
  else if (CLASSIFIER_DELIVERABLES[cls?.deliverable]) [deliverable, source] = [CLASSIFIER_DELIVERABLES[cls.deliverable], 'classifier']
  else if (isRecordOnly(task, cls)) [deliverable, source] = ['record', 'classifier']
  else if (cls?.decision === 'question') [deliverable, source] = ['answer', 'classifier']
  else if (requestsPreCheck(task) && !WRITE_INTENT_RE.test(own) && !ASKS_CHANGE_RE.test(own)) [deliverable, source] = ['verification', 'regex']
  else if (cls) [deliverable, source] = ['change', 'classifier']
  if (!deliverable) return null
  const api = prefix === 'api' || cls?.decision === 'api_reply'
  return {
    v: CONTRACT_VERSION,
    deliverable,
    source,
    // 只读：代答 / 只记一笔不碰仓库。实测要起 worktree 跑 curl / 页面工具，运维要跑固定命令，都不算只读。
    readOnly: deliverable === 'answer' || deliverable === 'record',
    // 要改代码的：done.trust 查「只动测试 / 只动文档」、范围契约核对。
    expectsCode: deliverable === 'change',
    // 没有代码改动也是完成（实测结论 / 回答 / 记一笔 / 运维动作）。
    emptyDiffOk: deliverable !== 'change',
    // 只改了文档也是完成：上面几类 + 对接答复（回填对接文档是正当产出）。
    docsOnlyOk: deliverable !== 'change' || api,
    browser: deliverable === 'verification' || requestsVisualCheck(own),
    api,
    defect: deliverable === 'change' && cls?.decision === 'bug',
    // 分类器已经把关于 bot 自己的问题答完（reply 就是答案）：不开执行，直接落 answered（plan §3.3）。
    selfAnswer: cls?.selfAnswer === true && deliverable === 'answer',
    // 原话明确要造测试数据（实测 / 改码才有；放行环境另看配置 testData）。
    testData: (deliverable === 'verification' || deliverable === 'change') && requestsTestData(own),
    // 要改的是 bot 自己（评分 / 规则 / 逻辑，11-04）：不进 fameex-web，开需求型自修工单（lib/lark-self-fix.openSelfRequest）。
    botSelf: cls?.botSelf === true && deliverable === 'change',
  }
}

// @bot 交办的只读活（测试 / 复测 / 确认 / 查找 / 回答，契约 verification / answer）：不改代码，不看归属，直接做、结论回群
//（aven 2026-10-24：「这样 @bot 帮助测试、复测、确认、查找的任务，只要不是改代码的，直接做，做完结果回群」）。
// cls 可传分类器刚出的结果（入队判定时契约还没落到任务上）。
export const isReadOnlyAsk = (task, cls = task?.intake?.classification) => {
  // 负责人私聊指示不走这里（他说「不做」时分类器判 ignore，不能因为 deliverable 被放行）。
  if (!task?.addressedToBot || task.privateOrigin) return false
  // 判 ignore 的只认分类器明确填的 deliverable：契约会按原话正则推 verification（「21 点前别测」里有「测」），不能据此开跑。
  if (cls?.decision === 'ignore') return cls.deliverable === 'verification' || cls.deliverable === 'answer'
  const contract = cls ? deriveContract({ ...task, intake: { ...task.intake, classification: cls } }) : taskContract(task)
  return contract?.deliverable === 'verification' || contract?.deliverable === 'answer'
}

// 读契约：已存的且版本对就用，否则现算（不回写磁盘；网关和 worker 新旧代码短暂并存时两边都能用）。
export const taskContract = (task) => (task?.contract?.v === CONTRACT_VERSION ? task.contract : deriveContract(task))

// 任务内容被正当改写时重算（归并 / 重开：正文换成新消息的交办）。
export const refreshContract = (task) => {
  const contract = deriveContract(task)
  if (contract) task.contract = contract
  else delete task.contract
  return task
}
