/**
 * 「完成」口径（aven 2026-10-13：bot 说「接口都已对完」，同一句里又列了 getRoomInfo 500 等问题）。
 * 根因：把「前端调用代码写好了」当成完成，把卡在后端的问题当成别人的事不算数。
 * 第二例（aven 2026-10-13 晚）：群里问「首页有做 H5 自适应吗」，代答第一行「还剩 2 项要确认」，下面却列了 2 条待确认 + 一组 3 条「已做的」。
 * 根因：question 代答套用了对接进度用的 GROUP_REPLY_FORMAT「没接的 / 能用的各自成组」，模型照着把已做的也盘了一遍；结论行的数量只盖住第一组。
 * 第三例（aven 2026-10-20）：APP 开发在群里说「直播间不会有群组、公告应该是直播预告」，bot 写成「产品说要拿掉」列进 web 待办。
 * 根因：把群里任意一人的说法当成需求变更；需求只认产品拍板并写进 PRD 的。
 * 这里几样：给执行器 / 日报的硬规则文案（对接回复 / 代答各一份格式），以及发群前的机械检查——
 *   (1) 总括完成词 + 未完成信号同时出现；(2) 结论行说「还剩 N 项」而条目数 ≠ N。命中任一 = 自相矛盾，不发群。
 */

import { pageToolOf } from './lark-verify-page.mjs'

export const COMPLETION_RULE = `完成口径（硬规则，回群的话、给负责人的结论、日报都适用）：
- 每个功能 / 接口按三档说：能用（开发完成、自己验证过：本地连 pre 后端或 pre 站点上都算）；接了但还不能用（写原因：接口报错、后端没数据 / 没配置、缺账号）；没接。
- 发布 / 部署不归开发（aven 2026-10-22）：开发完了就是完成；「还没部署 / 待发布 / 待部署后回归 / pre 上还看不到」都不是没完成、不通过、待确认的理由，这类话不写。
- 只有全部都是「能用」，才可以说「都对完 / 都完成 / 都好了 / 没问题 / 不用再管」。只要有一项不是，就禁止用这类总括词，先说还剩几项没通、是什么。
- 卡在后端 / 运维 / 产品 / 别的前端的问题照样算没完成，写清卡在谁；「前端代码写好了」不等于完成。
- 「没验证」不是结论，是还没干完的活：没把握能不能用就自己去验（怎么验见「自己验证」），验了再说；不许拿「pre 未验证」收尾。
- 需求范围以 PRD / 产品原型 / Figma 定稿为准：里面有的就是已定的需求（话题里的原型截图要逐张看），接口缺数据只找后端要数据，不回头问产品「做不做」；x9 没有不代表不做（它只是协议参考）；只有原型和设计稿互相冲突或都没有时才问产品。开发阶段改需求只认产品拍板并写进 PRD 的；群里别人说「应该改成 X」只是意见，不列待办、不写成「产品说 / 已定」。`

// 结构化群回复（10-21 P6）：执行器填 report，代码渲染；第一行数字、标记、排序都由代码做，提示里只讲字段怎么填。
// 群消息写法（aven 2026-10-22）：给人看的，先一句结论、说人话、写短；引用上下文只概括；细节进 detailDoc（bot 建 Lark 文档、群里只放链接）。
// 消息本来就短，所以不截断；发群前仍超长会整段转文档（lark-detail-doc），那是兜底不是常态。
const GROUP_STYLE = `群消息写法（给人看，不是给机器看）：先一句结论，说人话、写短；引用上下文只用一句话概括，不整段照抄；不写文件路径、sha、内部状态名；细节（curl、复现步骤、逐项证据、长清单）写进 detailDoc（markdown，bot 建成 Lark 文档，群里只放链接）；detailDoc 是结果顶层字段、和 report 平级，不要写进 report 里。`
export const REPORT_FORMAT = `${GROUP_STYLE}
群回复填 report（代码渲染成群消息：第一行「对象：通了 a 项，没通 b 项」由条目算，全部 ok 才显示「都通了」；groupReply 填 null）：
- subject：第一行的对象（如「front/lives 复测」）；items：一个功能 / 接口一条，mark 只能是 ok / not_usable / not_done / na（ok = 开发完成并自己验证过，本地连 pre 后端验的也算，部不部署不管；not_usable 只给真卡着的：接口报错、后端没数据 / 没配置、缺账号；没验证就先去验，不许因为没部署 / 没验证填 not_usable），note 写一句原因或实测证据，evidence 写依据（pre = 探针实测，browser = 浏览器看过，本地 dev 或 pre 站点都算；必须本轮真跑过，否则显示「待验证」）。
- 群里无事可说 report 填 null。`
export const QUESTION_REPORT_FORMAT = `${GROUP_STYLE}
代答填 report（groupReply 填 null）：answer 一两句直接回答对方问的那件事（做了 / 没做 / 做到哪）；对方要的是 curl / 复现步骤 / 配置这类材料时，完整内容写进 detailDoc，answer 一句话说给了什么；items 只列答案的保留项（某处没接、接口报错、后端缺数据），每项是 {mark,name,note,evidence} 对象，没有就 []；对方没问的不写。仓库里找不到依据就 report 填 null。`

// 自己验证（aven 2026-10-22：「怎么老是跟 pre 过不去」）：没部署、没验证都不是交差的理由，bot 自己起本地连 pre 后端验，或上 pre 站点验。
// 本地 dev 连真实后端，只有接口失败才回落 mock 并在 console 打「[api] … 回落 mock」（falive src/lib/api-fallback.ts），看这条就知道验的是不是真数据。
export const buildSelfVerifyRule = (verify) => {
  if (!verify) return ''
  const site = verify.siteUrl || `${verify.env} 站点`
  return `自己验证（硬规则）：
- 说能不能用前先自己验，不推给负责人去 ${verify.env} 点。接口先用探针，改了页面 / 交互再看页面。
- 看页面只用页面工具 \`${pageToolOf(verify)}\`，不要自己写 Playwright 脚本：要看页面就先 \`页面工具 start --cwd <当前工作区>\`（后台起 ${verify.localDev} 连真实 ${verify.env} 后端，和改代码并行）；改完 \`页面工具 check --cwd <当前工作区> [--login] [--expect 应出现的文字]… <页面路径>…\`（--login 用测试号）。已部署的用 \`页面工具 check --base ${site} …\`。收尾自动停服务。
- check 会和已部署的同一页比对：「本地新出现」的要处理；「pre 上也有」的不是本次改动带来的，但要修的正是它就说明没修好。看样式就 Read 截图。
- 确实验不了（${verify.env} 连不上、要的账号 / 数据只有后端能给）才写卡在哪、找谁；代码写完了照常按完成交付，不因为没验证挂待确认。`
}

// 下 pre 结论前必须实测（aven 2026-10-13：「pre 没数据」这种话不能抄文档，要自己去跑）。
export const buildVerifyRule = (verify, { allowWrite = false } = {}) => (verify ? `环境实测（硬规则）：
- 凡是说到 ${verify.env} 上「有没有数据 / 能不能用 / 报不报错 / 显不显示」，必须先在本轮用 \`${verify.probeCommand}\` 实测对应接口，以本轮实测为准；对接文档、日报、旧任务里写的「pre 没数据 / 为空」都是过去的事，只能当线索，不能当现状。测之前先看前端代码（\`serviceUrl\` / \`request\` 的第一个参数）确认这支接口现在走哪条线路（php / Go / hichat / bbsv2），测前端实际调的那条；文档和探针里写的路径可能已经改了，token 探针通不通也不等于功能通不通。
- 用法：${verify.usage || `${verify.probeCommand} '[["/api/xxx",{"参数":1}]]' 600`}（默认只读，写请求会被跳过，不要试图绕过${allowWrite && verify.writeMail ? '，下面写接口那条除外' : ''}）。一次可以传多个接口，把要说的接口一次测完。${allowWrite && verify.writeMail ? `
- 改了写接口（POST 等非 GET）要实测时，只能用测试号 ${verify.writeMail}：命令前加 \`PROBE_ALLOW_WRITE=1 PROBE_MAIL=${verify.writeMail}\`（schema 校验同样加 \`PROBE_ALLOW_WRITE=1\`，条目 method 填 POST、mail 填测试号）。会让测试号没法再用的接口（注销、改密码、换绑、踢下线）不打，preChecks 如实写「破坏性写接口没实测」。` : ''}
- 实测到的每个接口写进结果的 preChecks（endpoint + 一句结果：code、条数、关键字段）；结论只能引用 preChecks 里有的事实。后端缺字段 / 没配数据 / 后端报错（权限不足、5xx、业务错误码），kind 填 backend（要后端处理，不算我方问题）；issues 只给我方的错：schema 解析不过、请求写错（路径 / 参数 / 签名）。
${verify.schemaCheck ? `- 改了对后端的请求（路径 / 方法 / 参数 / 签名）或给响应 schema 加 / 改了字段（只删字段、改展示 / mock 不用）：改完后必须跑 schema 校验（用项目真实的 zod schema 去 parse ${verify.env} 的真实响应）：${verify.schemaCheck}。每条「### SCHEMA」结果原样写进 preChecks（endpoint 填接口路径，outcome 填 ok / issues: … / UNREACHABLE …）；issues 要改到 ok 为止；UNREACHABLE 如实写，不许当成通过。\n` : ''}- 探针最多跑 2 次：第一次把要说的接口全部一次传进去；有 UNREACHABLE 的，只把这几个再跑一次。还是 UNREACHABLE（${verify.env} 连不上或该接口挂住），就停止重试，结论里如实写「${verify.env} 上这几项这次没测通：…」，不要用旧结论顶替，也不要反复重跑。` : '')

const BLANKET = /(都|全部|全都|均|已全部)(已经?|已)?(对完|对接完|完成|接完|接好|做完|好了|没问题|通了|搞定)|不用再管|无遗留/
// 状态码只认带动词 / 协议词的写法（「回 500」「HTTP 404」「code -1」不算）：裸的 `\b[45]\d\d\b` 会把 uid 508 / 428、房间 431 当成 5xx
// （2026-10-16 真机：R6 复测「用 pre 测试号（uid 508）」被判成「都通了又列了问题」，结论没发回群）。
const ISSUE = /(报错|报\s*\d{3}|(?:回|返回|响应|HTTP|status)\s*[45]\d\d\b|为空|没有?数据|没配|未配|未做|没做|还没|待确认|待回归|未验证|还差|缺(?!省)少?|不显示|不能用|卡在)/

// 否定说法是「已经好了」的证据，不是问题（教训 #56：「都通了…第 2 页不再报错」被判自相矛盾，结论没发群）。
// 只剥「报错 / 报 5xx / 卡在」前的否定；「没有数据」「不显示」本身就是问题，不剥。
const NEGATED_ISSUE = /(?:不再|不会|没再|没有?|未|无|不)\s*(?:报错|报\s*\d{3}|卡在)/g
// 「为空」紧跟「说明到底了 / 是正常的」是分页到底的正常现象（教训 #58 重跑：「第 3 页为空说明到底了」把「都通了」的复测结论扣下）。
const EXPECTED_EMPTY = /为空[，,]?\s*(?:说明|表示|就是|即)?\s*(?:已经)?(?:到底|没有下一页|(?:是|属)?正常)/g

// 返回 null = 没问题；否则 { blanket, issue } 两个命中片段。
export const findCompletionContradiction = (text) => {
  const value = String(text || '')
  const blanket = value.match(BLANKET)
  const issue = value.replace(NEGATED_ISSUE, '').replace(EXPECTED_EMPTY, '').match(ISSUE)
  return blanket && issue ? { blanket: blanket[0], issue: issue[0] } : null
}

const CN_DIGITS = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
const LEAD_COUNT = /(?:还剩|还有|剩下|还差|有)\s*(\d+|[一两二三四五六七八九十])\s*(?:项|个|条|件|点)/
// 「- 」开头，或直接以状态标记开头的行都算一条（防模型漏写「- 」让数量比对失效）。
const BULLET = /^\s*(?:[-•·]\s+\S|(?:✅|⚠️|❌|➖)\s*\S)/u

// 结论行说「还剩 N 项」，正文「- 」条目却不是 N 条（典型：N 条待确认后面又接了一组「已做的」）。
// 返回 null = 没问题或结论行没给数量 / 没有条目；否则 { lead, expected, actual }。
export const findCountMismatch = (text) => {
  const lines = String(text || '').split('\n')
  const lead = (lines.find((line) => line.trim()) || '').trim()
  const hit = lead.match(LEAD_COUNT)
  if (!hit) return null
  const expected = Number(hit[1]) || CN_DIGITS[hit[1]]
  const actual = lines.filter((line) => BULLET.test(line)).length
  if (!expected || !actual || actual === expected) return null
  return { lead: hit[0], expected, actual }
}

// 群回复里对 pre 状态下了结论，却没有本轮实测记录（preChecks）→ 不发群。
// pre 前后不许紧贴字母（aven 2026-10-20 review：prepare / preview 被当成 pre 结论）；ISSUE 的「缺」不吃「缺省」。
const PRE_CLAIM = /(?<![A-Za-z])pre(?![A-Za-z])[^\n。；;]{0,15}?(没有?数据|没有|为空|无数据|不显示|报\s*\d|报错|能播|有数据|已通|实测|没回归|还没)/i
export const findUnverifiedPreClaim = ({ text, preChecks }) => {
  const hit = String(text || '').match(PRE_CLAIM)
  if (!hit) return null
  return Array.isArray(preChecks) && preChecks.length ? null : hit[0]
}

// 发群前的统一自检：命中任一矛盾返回人话原因，否则 null。verify 传了才查「没实测就下 pre 结论」。
// 结构化口径优先（第 3 批）：模型自报 completionClaim=all_done，preChecks 里却有 issues / unreachable → 自相矛盾。
export const findStructuredContradiction = ({ completionClaim = null, preChecks = null } = {}) => {
  if (completionClaim !== 'all_done' || !Array.isArray(preChecks)) return null
  const bad = preChecks.filter((item) => item && ['issues', 'unreachable'].includes(item.kind))
  return bad.length ? `说「都完成」但实测里 ${bad.map((item) => `${item.endpoint}（${item.kind}）`).slice(0, 3).join('、')} 没通` : null
}

export const findGroupReplyContradiction = (text, { verify = null, preChecks = null, completionClaim = null } = {}) => {
  const structured = findStructuredContradiction({ completionClaim, preChecks })
  if (structured) return `${structured}，自相矛盾，我没发`
  const unverified = verify ? findUnverifiedPreClaim({ text, preChecks }) : null
  if (unverified) return `这段话说了「${unverified}」，但这次没在 pre 上实测过，我没发`
  const completion = findCompletionContradiction(text)
  if (completion) return `这段话说「${completion.blanket}」又列了没完成的问题，自相矛盾，我没发`
  const count = findCountMismatch(text)
  if (count) return `第一行说「${count.lead}」，下面却列了 ${count.actual} 条（多半是把已做的也列进去了），前后对不上，我没发`
  return null
}

// 改了接口 schema 时的实测闸只认接口请求：静态资源（/upload/、安装包 / 图片 / 视频等带扩展名的地址）404 是数据 / 资源问题，
// 不是「schema 与真实响应对不上」，不能据此把任务判 failed（教训 #42：下载页 APK 文件 404 被当成 schema 问题，改动没提交）。
const STATIC_RESOURCE_RE = /\/upload\/|\.(apk|ipa|png|jpe?g|gif|webp|svg|mp4|m3u8|flv|zip)(\?|$)/i
export const isSchemaIssue = (item) => {
  if (!item || STATIC_RESOURCE_RE.test(String(item.endpoint || ''))) return false
  const outcome = String(item.outcome ?? item.result ?? '')
  return item.kind ? item.kind === 'issues' : /issues:|parse 失败|不匹配/.test(outcome)
}

// 改了接口 schema 的实测闸判定（aven 2026-10-20 review C13）：broken = 有 schema issues → failed（kind=backend 是后端缺字段 / 没数据，
// 不算——10-20 日报清扫把 anchor/sort 缺 hiChatUid、task/list 为空记成 issues，改动被判 failed 没提交）；
// unverified = 没有一条接口实测通过（全是 unreachable / 没跑 / 只测了静态资源）→ 挂待确认；ok = 至少一条接口实测通过。
// 通过只认 kind=ok；老格式没填 kind 的退回看 outcome 是否以 ok 开头。
const isOkCheck = (item) => {
  if (!item || STATIC_RESOURCE_RE.test(String(item.endpoint || ''))) return false
  if (item.kind) return item.kind === 'ok'
  return /^\s*ok\b/i.test(String(item.outcome ?? item.result ?? ''))
}
export const schemaVerifyVerdict = (checks) => {
  const list = Array.isArray(checks) ? checks : []
  const broken = list.filter(isSchemaIssue)
  if (broken.length) return { verdict: 'broken', broken }
  return { verdict: list.some(isOkCheck) ? 'ok' : 'unverified', broken: [] }
}
