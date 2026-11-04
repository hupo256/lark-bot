/**
 * 代答 / 实测两种任务模式的提示块（worker only；11-01 对话层）。
 *
 * 为什么单独一个文件：lark-worker-prompts 只剩不到 150 行余量，而这两种模式的「群回复写法」「report 字段怎么填」
 * 是 falive 两周里反复打磨出来的口径（COMPLETION_RULE / GROUP_STYLE / REPORT_FORMAT / QUESTION_REPORT_FORMAT），
 * 要原样保留、集中维护；探针 / 页面工具部分按 fameex 的现状改写（没有 pre-probe，只有 curl + 可选页面工具）。
 * 群消息由代码渲染 report（lib/lark-report-render.mjs），提示里只讲字段怎么填，不讲排版。
 */

import { envTargetLine } from './lark-env-target.mjs'
import { buildEnvKnowledgeBlock } from './lark-knowledge.mjs'
import { ENV_LOGIN_TOOL } from './lark-paths.mjs'

// 群消息写法（aven 2026-10-22）：给人看的，先一句结论、说人话、写短；细节进 detailDoc（bot 建 Lark 文档，群里只放链接）。
const GROUP_STYLE = '群消息写法（给人看，不是给机器看）：先一句结论，说人话、写短；引用上下文只用一句话概括，不整段照抄；不写文件路径、sha、内部状态名；细节（curl、复现步骤、逐项证据、长清单）写进 detailDoc（markdown，bot 建成 Lark 文档，群里只放链接）；detailDoc 是结果顶层字段、和 report 平级，不要写进 report 里。'

export const QUESTION_REPORT_FORMAT = `${GROUP_STYLE}
代答填 report（groupReply 填 null）：answer 一两句直接回答对方问的那件事（做了 / 没做 / 做到哪 / 差别是什么）；对方要的是 curl / 复现步骤 / 配置 / 提交清单这类材料时，完整内容写进 detailDoc，answer 一句话说给了什么；items 只列答案的保留项（某处没接、接口报错、后端缺数据、查不到的部分），每项是 {mark,name,note,evidence} 对象，没有就 []；对方没问的不写。仓库 / git / 文档里找不到依据就在 answer 里直说找不到、建议问谁，不编。`

export const VERIFICATION_REPORT_FORMAT = `${GROUP_STYLE}
实测填 report（groupReply 填 null；代码按条目算第一行的通没通）：subject 写实测对象（哪个环境哪个流程）；items 一个功能 / 页面 / 接口一条，mark 只能是 ok / not_usable / not_done / na（ok = 本轮真测过且正常；not_usable 只给真卡着的：接口报错、后端没数据 / 没配置、缺账号；没测到的填 not_done 并在 note 写为什么没测到），note 写一句实测证据（code、关键字段、看到的现象），evidence 写依据（pre = 接口实测 curl，browser = 页面工具看过，code = 只看了代码，none）；必须本轮真跑过，否则会显示「待验证」。判断类（是不是前端的问题、谁来修）answer 首句给结论，items 每条写根因和谁跟。`

// 结果 JSON 里群回复相关字段的释义（只在 answer / verification 模式的 user 层出现，不进系统层）。
export const REPORT_RESULT_FIELDS = `- report：结构化群回复 {subject, answer, items:[{mark,name,note,evidence}]}（口径见上）；群里无事可说填 null；
- groupReply：只在 report 装不下（纯一段话、没有条目）时填一段人话，否则 null；
- detailDoc：给对方的材料（markdown），没有填 null；
- followUps：要别人跟进的点 [{owner, items:[…]}]，没有填 null；
- summary：写给负责人（aven）的一两句：结论 + 依据在哪（文件 / 命令），不复述 report。`

// 环境地址：config.verify.envSites = { test, pre, uat, online }。说的是哪个环境就在哪个环境测（aven 2026-10-31 教训）。
// 实测可发登录 POST（aven 11-04 决策，docs/falive-replay-design-v2.md §7）：登录拿态之外的写操作仍禁止。
// 验证码登录算登录（aven 11-04 补充，b2 ep-1014-d74f19 把发登录码当写操作、核心问题没测）；发注册码算注册。命令层同口径（lib/lark-egress-policy）。
const configuredSites = (envSites) => Object.entries(envSites || {}).filter(([, url]) => typeof url === 'string' && url.trim())
// 出网范围（aven 11-04，p4b-check 里代答直接打了 hichat 上游 pre-hailiao.hai-liao-pre.com）：只打配置的环境地址，上游 / 合作方只转述。
// b2 ep-1031-f8065f 代答照样 curl 了 accounts.google.com/gsi/…（提示只是软约束）→ 改成命令层拦（lib/lark-egress-policy），提示只告诉它拦了怎么办。
const PROBE_SCOPE = '只打上面这些地址（含同主域子站），上游 / 合作方 / 第三方的域名（如 hichat 后端、Google 登录）不打，它们的状态只转述上下文并写明出处和日期；第三方组件看本环境页面怎么引用它 + 读代码。命令层会拦范围外地址（报「[lark-egress] 已拦截」），拦了就按转述写，不换写法重试'

export const buildEnvProbeRule = (envSites = null) => {
  const sites = configuredSites(envSites)
  if (!sites.length) return '环境实测：本仓没有配环境地址（config.verify.envSites），只能查代码 / git / 本地构建；上下文点名的环境没法实测就在 items 里填 not_done、note 写「没有环境地址，没实测」，不拿代码推断冒充实测。'
  return `环境实测（硬规则）：凡是说到某个环境「能不能用 / 有没有数据 / 报不报错」，必须本轮用 curl 打该环境的接口或用页面工具看页面再下结论；上下文说哪个环境就测哪个：${sites.map(([env, url]) => `${env} ${url}`).join('、')}；${PROBE_SCOPE}。不拿别的环境或更早的实测顶替；连不上就在 note 写「<环境> 这次没测通」，mark 填 not_done。只读探测：只发 GET，唯一例外是为拿登录态（token / cookie）登录，含验证码登录（发登录码 + 用码登录）；不注册（发注册码也算）、不上传、不下单、不改任何数据，要写数据的那步写明卡在哪、请谁手动做。`
}

// 代答里说到环境现状同样以本轮实测为准（11-04 falive 回放 ep-1029-f09207：Encone 引用 bot 10-28 的「实测 /hc-ws 握手 404」问是哪块需求，
// 分类成代答（问的确是需求归属 / 连接方式）；代答模式没有环境实测规则，答案把 10-28 的旧结论照抄成「现在 pre 握手回 404」，falive 当场复测 pre 已通）。
// 代答只放开 GET（登录 POST 仍只给实测模式，aven 11-04）。
export const buildAnswerEnvRule = (envSites = null) => {
  const sites = configuredSites(envSites)
  const head = '环境现状：answer 里要说某个环境现在能不能用 / 有没有数据 / 报不报错，包括复述引用消息、上下文、文档或上一单里更早的实测结论，'
  const tail = '写明那是哪天谁的结论、这次没复测，不当现状说。'
  if (!sites.length) return `${head}本仓没有配环境地址，不去打任何地址；${tail}`
  return `${head}先本轮只读打一下该环境（${sites.map(([env, url]) => `${env} ${url}`).join('、')}；${PROBE_SCOPE}），curl GET，WebSocket 看握手，以本轮结果为准；测不了就${tail}`
}

// 测试号登录只走固定工具（b3 回放 ep-1024-9ebe13：会话自己写脚本 import pre-client、设 PROBE_ALLOW_WRITE=1 去登录，被 Claude Code
// 自动审批判成绕过安全开关拦下，Bug-4942 / hichat_token 几条复测都没测成）。没配测试号不出这句。
export const buildEnvLoginRule = (testAccounts = null) => {
  const envs = Object.keys(testAccounts || {})
  if (!envs.length) return ''
  return `要登录态只用 \`node ${ENV_LOGIN_TOOL} --env <环境>\`（配了测试号的：${envs.join(' / ')}；只登录不注册，token 用 \`$(… --token)\` 取、不打印）；不自己写登录脚本、不设 PROBE_ALLOW_WRITE 之类写开关，被权限拦下也改用它。`
}

// 造测试数据（aven 11-04：pre 测试与造数据都用测试号；b3 ep-1024「创建最新的帖子 进行测试」lark-bot 拒发帖、没测成）：
// 只在原话明确要造（契约 testData）且配置 testData.envs 点名的环境，命令层同步放开这些环境的创建请求（lib/lark-egress-policy）。
export const buildTestDataRule = (envs = []) => (envs?.length
  ? `本单对方明确要造测试数据（发帖不允许的口径本单例外）：只在 ${envs.join(' / ')} 用测试号（先登录拿态）建够测的最少内容（发帖 / 评论 / 传图这类），不删、不改、不碰别人的数据、不注册；建了什么把 id（如 tid）列进 report；命令层拦了就照实写拦在哪。`
  : '')

// 要什么本轮给什么（11-03 falive 回放）：William「测试的tid 发出来」tid 就在上一单结论里，却回「去翻文档，没有的话我再拉一遍发你」；
//「创建最新的帖子 进行测试」群里先回了「我在 pre 发几条新帖」，实测只读发不了帖。代答 / 实测是单趟、不走系统层，规则挂在两个模式块末尾。
export const DELIVER_NOW_RULE = '对方要什么本轮就给什么：要事实（tid / 账号 / 地址 / 数据）就查出来直接列（先看下方上一单结论，没有再只读去环境拉），不让对方自己去翻；要一次操作，本模式允许就做，不允许（发帖 / 注册 / 下单这类写操作）就直说这边做不了、该找谁。单趟没有下次：answer 里不写「回头再… / …再发你」；群里先回的那句答应过的要兑现，兑现不了说明原因。'

// 下结论要有据（11-04 b3；与 b3a 的账号规则合并进 falive-next 后实测块超只读预算，两句都压了措辞、规则不减）：ep-1024-9ebe13 对方说「存 I'm QA. 读回来还是 I'm QA.」，没重抓原始返回就顺着说「对上了」（实际仍是 I&#039;m，
// 是 Lark 把实体渲染成了单引号）；追问「所以不是 Bug?」没用自己刚测的结果、日期还说错；ep-1021-193c03 明说看不到原分支，仍断言「确实没同步」。
export const CLAIM_EVIDENCE_RULE = '下结论要有据：通没通 / 修没修 / 是不是 bug 只依据本轮实测或 bot 最近一次带时间的实测（写明几点）；对方说法没核过不附和（不说「对上了」）也不反驳；核不了就说核不了、缺什么，不下结论。'

// 数据块：群里真正发出去的「收到」（task.ackReply，lark-intake-ack 发出时记；分类器写了没发的不算）+ 接着的那条的结论（task.priorConclusion）。
// 实测模式里上一单结论只作背景（11-03 第二次 review #8：环境不相交不并入、continues 仍指上一单，带的是 uat 的实测结论；环境实测硬规则不许拿它顶替）。
export const buildCarryOverBlock = (task, { verification = false } = {}) => {
  const ack = task?.ackReply
  const prior = task?.priorConclusion
  // 引用的 bot 消息出自另一单（task.quotedConclusion，lark-intake-resolve；11-04 回放 ep-1014-d74f19）：「针对这条消息」问的就是那单。
  const quoted = task?.quotedConclusion
  const background = verification ? '只作背景：环境能不能用 / 有没有数据以本轮实测为准，不拿它顶替' : '用前对一下'
  return [
    ack ? `群里已先回了一句：「${ack}」` : null,
    // 重开并入 / 在跑时并入跑完重跑时接着的是本单自己上一轮（lark-task-merge）：那轮已经回给对方了，这轮只接新追加的补充，不把答过的再说一遍。
    prior ? `${prior.taskId === task.id ? '本单上一轮 bot 已经回给对方的结论（这轮只处理之后新追加的【同主题补充】，上一轮答过的不再重复；' : `本条接着任务 ${prior.taskId}${prior.summary ? `（${prior.summary}）` : ''}，那单 bot 的结论（`}以前的记录，${background}）：\n${prior.text}` : null,
    quoted ? `本条引用的 bot 那条消息出自任务 ${quoted.taskId}${quoted.summary ? `（${quoted.summary}）` : ''}，「这条 / 本次」指的就是那单（以前的记录，${background}）：\n${quoted.text}` : null,
  ].filter(Boolean).join('\n')
}

// 改码任务也要兑现「收到」里答应的只读事（11-04 falive 回放 ep-1031-35935b：「帖子回复已完成，完善资料要前端接入」分类成 change，
// 群里先回了「评论积分我去 pre 再测一下」；改码单只接了完善资料、没复测，groupReply 还写「测完把结果回你」——单趟没有下次，成了空头承诺）。
// 只在真发过「收到」时出现（task.ackReply）；复测结论写进 report，done 时附在改码结论后面发群（lark-human-text sayDoneChangeGroup）。
// 实施阶段也要拿到 envSites / knowledge（lark-worker-run promptOptions；11-04 b3 同一单：没传，块里成了「本仓没配环境地址」，worker 照做没复测）。
// 固定知识（测试号 / 环境）只在有答应的事时带，改码单平时不带。
export const buildAckPromiseBlock = (task, { envSites = null, knowledge = '', testAccounts = null, testDataEnvs = [] } = {}) => {
  const ack = task?.ackReply
  // 改码单里对方明确要造测试数据（aven「写脚本在 pre 造帖」）：同样给造数据与登录口径。
  const testData = testDataEnvs?.length ? `${buildTestDataRule(testDataEnvs)}${buildEnvLoginRule(testAccounts)}` : ''
  if (!ack) return testData
  const sites = configuredSites(envSites)
  const where = sites.length ? `打 ${sites.map(([env, url]) => `${env} ${url}`).join('、')}，只发 GET（登录拿态的 POST 除外；下方固定知识里有该环境测试号就用它登录），上游 / 合作方域名不打` : '本仓没配环境地址，测不了就写明'
  const promise = `群里已先回了一句：「${ack}」。里面答应的只读事（去环境复测 / 查给对方）本轮一并做（${where}），结论写进 report {subject, answer:null, items:[{mark,name,note,evidence}]}：一项一条，mark 取 ok（本轮真测过且正常）/ not_usable / not_done（没测到，note 写原因），evidence 填 pre / code / none；要写操作或测不了就写明该谁测。单趟没有下次，不写「测完再回你」。`
  const known = buildEnvKnowledgeBlock({ knowledge, envSites })
  return [promise, known, testData].filter(Boolean).join('\n')
}

// 对方逐项答复我方对接待办的改码单（分类 api_reply、交付改码）：交付除了要改的，还有逐项复测 + 逐项结论（11-04 b3 ep-1019-57332a：Encone 的回复文档
//「读一下」判了不用改、pre 没复测；「已经上 pre 了」并进去只报了改码。falive 当时逐项复测、报了过 / 没过，再按 C4 / C5 改前端）。
// 只对改码类出现（代答 / 实测本来就按条目报）；跟「收到」里答应的只读事（buildAckPromiseBlock）各说各的，同一份 report。
export const buildApiReplyRetestBlock = (task, { envSites = null } = {}) => {
  if (task?.intake?.classification?.decision !== 'api_reply') return ''
  const sites = configuredSites(envSites)
  const where = sites.length ? `打 ${sites.map(([env, url]) => `${env} ${url}`).join('、')}，只发 GET（登录拿态的 POST 除外）` : '本仓没配环境地址，测不了就写明'
  return `本条是对方在答复我方的对接待办（已修 / 已发布 / 已配 / 不改）：答复里的每一项本轮都去环境复测（${where}），逐项写进 report.items（一项一条，mark ok / not_usable / not_done，note 写实测证据或没测的原因，evidence 填 pre / code / none）；前端要适配的照改，归别人的写进 followUps [{owner, items}]（后端 / 运营 / 运维 / 前端谁跟）。不用改代码也逐项报，不只给一句「不用改」。`
}

// 代答模式（contract.deliverable=answer）：只读、单趟、答案写进 report.answer，summary 给负责人。
export const ANSWER_MODE_BLOCK = (task, { persona = '', envSites = null, testAccounts = null } = {}) => `本任务是代答群里 / 私信里的提问（问题与前后文在上方任务内容里；被问的是负责人 aven，你替他答）：
${envTargetLine({ targets: task?.envTargets || [], envSites }) ? `${envTargetLine({ targets: task.envTargets, envSites })}\n` : ''}1. 只读：翻仓库代码、git 历史、项目文档、配置找依据，不改任何文件、不装依赖、不起服务；问的是机器人自己能做什么就按本提示的能力说明答。
对方指着前文问（「那两个」「刚才说的」）：从近往远找被指的那句——先对上下文末尾 bot 自己最近发的结论（含展开的原文），数目 / 对象对得上的就是它（「哪两个」就找那条里的「两个 …」，数的可能是号、接口或环境，照它答、不换成数别的），没有再翻更早的记录；answer 开头点明对的是哪条（几点 bot 说的什么），最近那条和更早记录说法不同以最近的为准并说清差别；真对不上就直说记录里是什么，不硬凑。
${buildAnswerEnvRule(envSites)}${buildEnvLoginRule(testAccounts) ? `\n${buildEnvLoginRule(testAccounts)}` : ''}
2. 答案会以 aven 助手的名义直接回到群里 / 私信里，对方只看这段，所以：
${QUESTION_REPORT_FORMAT}
${persona ? `3. 口吻与取舍按负责人的说明：\n${persona}\n4.` : '3.'} status 一律 done（查不到也是 done，answer 里说清查不到什么、建议问谁）；changedFiles 必须为 []；只有工具 / 环境 / 权限导致读不到必要事实时才 failed。
${DELIVER_NOW_RULE}
${CLAIM_EVIDENCE_RULE}`

// 账号 / 写操作 / 修复上没上（11-04 b3 ep-1031-35935b「测一下生产评论任务和积分到账」：回「没有生产测试账号」只确认接口在线；
// falive 用负责人给的生产测试号只读查了任务和余额基线、点名 Kaiser 用该号发评论、追问 Go 修复发没发生产）。
const VERIFY_ACCOUNT_RULE = '账号：固定知识有该环境测试号就登录查只读基线（任务状态、余额 / 流水），不说没账号；写数据点名请报问题或有号的人做；复测修复先核上没上该环境（后端的问对方）。'

// 实测模式（contract.deliverable=verification）：去环境上看、复测、看完报结果；交付的是实测结论，不改代码也是完成。
export const VERIFICATION_MODE_BLOCK = (task, { envSites = null, hasPageTool = false, testAccounts = null, testDataEnvs = [] } = {}) => `本任务是实测 / 复测 / 确认（上方任务内容说了要看什么），交付的是实测结论，不改代码：
${envTargetLine({ targets: task?.envTargets || [], envSites }) ? `${envTargetLine({ targets: task.envTargets, envSites })}\n` : ''}1. 先搞清要测的是哪个环境、哪个流程、对方期待什么结果；再去测，测完按条目报。
2. ${buildEnvProbeRule(envSites)}${[buildEnvLoginRule(testAccounts), buildTestDataRule(testDataEnvs)].filter(Boolean).map((line) => `\n${line}`).join('')}
${VERIFY_ACCOUNT_RULE}
${hasPageTool ? '3. 页面 / 交互按下方「自己验证」规则用页面工具看，不要自己写 Playwright。' : '3. 没有配页面工具：页面行为只能靠接口探测 + 读代码推断，推断出来的条目 evidence 填 code。'}
4. ${VERIFICATION_REPORT_FORMAT}
5. status：测完（哪怕几项没通）一律 done；环境整体连不上也是 done，answer 说明这次没测通；changedFiles 必须为 []；只有工具 / 权限问题导致完全没法测才 failed。
${DELIVER_NOW_RULE}
${CLAIM_EVIDENCE_RULE}`
