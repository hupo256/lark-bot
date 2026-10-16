/**
 * 「完成」口径（aven 2026-10-13：bot 说「接口都已对完」，同一句里又列了 getRoomInfo 500 等问题）。
 * 根因：把「前端调用代码写好了」当成完成，把卡在后端的问题当成别人的事不算数。
 * 第二例（aven 2026-10-13 晚）：群里问「首页有做 H5 自适应吗」，代答第一行「还剩 2 项要确认」，下面却列了 2 条待确认 + 一组 3 条「已做的」。
 * 根因：question 代答套用了对接进度用的 GROUP_REPLY_FORMAT「没接的 / 能用的各自成组」，模型照着把已做的也盘了一遍；结论行的数量只盖住第一组。
 * 这里几样：给执行器 / 日报的硬规则文案（对接回复 / 代答各一份格式），以及发群前的机械检查——
 *   (1) 总括完成词 + 未完成信号同时出现；(2) 结论行说「还剩 N 项」而条目数 ≠ N。命中任一 = 自相矛盾，不发群。
 */

export const COMPLETION_RULE = `完成口径（硬规则，回群的话、给负责人的结论、日报都适用）：
- 每个功能 / 接口按三档说：能用（pre 上实测过、数据正常）；代码接了但 pre 上还不能用（写原因：接口报错、没数据、没配置、待回归）；没接。
- 只有全部都是「能用」，才可以说「都对完 / 都完成 / 都好了 / 没问题 / 不用再管」。只要有一项不是，就禁止用这类总括词，先说还剩几项没通、是什么。
- 卡在后端 / 运维 / 产品 / 别的前端的问题照样算没完成，写清卡在谁；「前端代码写好了」不等于完成。
- 没把握有没有在 pre 实测过，就当没实测，写「代码已接，pre 未验证」。`

export const GROUP_REPLY_FORMAT = `群回复格式（发到群里给领导和同事看，要一眼看懂）：
- 第一行一句结论，带数字：「<对象>：通了 a 项，没通 b 项」；全部通了才写「都通了」。
- 之后一个功能一行，以「- 」开头、紧跟固定标记，标记只用这四个：「✅ 通了」「⚠️ 接了但还不能用」「❌ 没接」「➖ 不涉及接口」，后面写功能名 + 一句原因或实测证据。
- 一行只写一个功能，不要把几个功能合在一行，不要「能用：A、B；C 不需要接口」这种混排。按标记分组：先 ⚠️ 和 ❌，再 ✅，最后 ➖。
- 别人负责的另起一段，开头一行「henry 负责的：」，下面同样一个功能一行带标记。
- 不写文件路径、sha、内部状态名；不要在末尾写「由 xx 的助手整理」之类的署名（卡片会自动带）；总长不超过 500 字。`

// 下 pre 结论前必须实测（aven 2026-10-13：「pre 没数据」这种话不能抄文档，要自己去跑）。
export const buildVerifyRule = (verify) => (verify ? `环境实测（硬规则）：
- 凡是说到 ${verify.env} 上「有没有数据 / 能不能用 / 报不报错 / 显不显示」，必须先在本轮用 \`${verify.probeCommand}\` 实测对应接口，以本轮实测为准；对接文档、日报、旧任务里写的「pre 没数据 / 为空」都是过去的事，只能当线索，不能当现状。
- 用法：${verify.usage || `${verify.probeCommand} '[["/api/xxx",{"参数":1}]]' 600`}（默认只读，写请求会被跳过，不要试图绕过）。一次可以传多个接口，把要说的接口一次测完。
- 实测到的每个接口写进结果的 preChecks（endpoint + 一句结果：code、条数、关键字段）；结论只能引用 preChecks 里有的事实。
${verify.schemaCheck ? `- 改了接口的 schema / queries：改完后必须跑 schema 校验（用项目真实的 zod schema 去 parse ${verify.env} 的真实响应）：${verify.schemaCheck}。每条「### SCHEMA」结果原样写进 preChecks（endpoint 填接口路径，outcome 填 ok / issues: … / UNREACHABLE …）；issues 要改到 ok 为止；UNREACHABLE 如实写，不许当成通过。\n` : ''}- 探针最多跑 2 次：第一次把要说的接口全部一次传进去；有 UNREACHABLE 的，只把这几个再跑一次。还是 UNREACHABLE（${verify.env} 连不上或该接口挂住），就停止重试，结论里如实写「${verify.env} 上这几项这次没测通：…」，不要用旧结论顶替，也不要反复重跑。` : '')

export const QUESTION_REPLY_FORMAT = `代答回复格式（对方问什么答什么，不做盘点）：
- 第一行直接回答对方问的那件事（做了 / 没做 / 做到哪），一句话。
- 答案有保留（等走查、pre 没验证、某处没接）才往下列，一条一行以「- 」开头，「- 」后紧跟状态标记（✅ 通了 / ⚠️ 接了但还不能用 / ❌ 没接 / ➖ 不涉及接口）再写功能名和原因；第一行说了「还有 N 项」，下面就只有这 N 条，不能再接「已做的」「另外」之类的第二组。
- 对方没问的不写：没问「做了哪些」就不列已完成清单，没问分支就不说合到哪了；上面的三档口径只管措辞诚实，不是要把每一档都列一遍。
- 不写文件路径、sha、内部状态名；总长不超过 200 字。`

const BLANKET = /(都|全部|全都|均|已全部)(已经?|已)?(对完|对接完|完成|接完|接好|做完|好了|没问题|通了|搞定)|不用再管|无遗留/
// 状态码只认带动词 / 协议词的写法（「回 500」「HTTP 404」「code -1」不算）：裸的 `\b[45]\d\d\b` 会把 uid 508 / 428、房间 431 当成 5xx
// （2026-10-16 真机：R6 复测「用 pre 测试号（uid 508）」被判成「都通了又列了问题」，结论没发回群）。
const ISSUE = /(报错|报\s*\d{3}|(?:回|返回|响应|HTTP|status)\s*[45]\d\d\b|为空|没有?数据|没配|未配|未做|没做|还没|待确认|待回归|未验证|还差|缺少?|不显示|不能用|卡在)/

// 返回 null = 没问题；否则 { blanket, issue } 两个命中片段。
export const findCompletionContradiction = (text) => {
  const value = String(text || '')
  const blanket = value.match(BLANKET)
  const issue = value.match(ISSUE)
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
const PRE_CLAIM = /pre[^\n。；;]{0,15}?(没有?数据|没有|为空|无数据|不显示|报\s*\d|报错|能播|有数据|已通|实测|没回归|还没)/i
export const findUnverifiedPreClaim = ({ text, preChecks }) => {
  const hit = String(text || '').match(PRE_CLAIM)
  if (!hit) return null
  return Array.isArray(preChecks) && preChecks.length ? null : hit[0]
}

// 发群前的统一自检：命中任一矛盾返回人话原因，否则 null。verify 传了才查「没实测就下 pre 结论」。
export const findGroupReplyContradiction = (text, { verify = null, preChecks = null } = {}) => {
  const unverified = verify ? findUnverifiedPreClaim({ text, preChecks }) : null
  if (unverified) return `这段话说了「${unverified}」，但这次没在 pre 上实测过，我没发`
  const completion = findCompletionContradiction(text)
  if (completion) return `这段话说「${completion.blanket}」又列了没完成的问题，自相矛盾，我没发`
  const count = findCountMismatch(text)
  if (count) return `第一行说「${count.lead}」，下面却列了 ${count.actual} 条（多半是把已做的也列进去了），前后对不上，我没发`
  return null
}
