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

export const GROUP_REPLY_FORMAT = `群回复格式（发到群里给人看，要好读）：
- 第一行一句结论，先说没完成的（如「直播详情页还有 5 项没通」）；全部能用才说「都通了」。
- 之后每件事单独一行，以「- 」开头，不要把几件事挤在一段里；别人负责的单独写一行点名负责人。
- 第一行写了「还有 / 还剩 N 项」，「- 」条目就只能是这 N 条；能用的 / 已做的合成一行「能用的：A、B、C」收尾，不拆成条目、不另起第二组。
- 不写文件路径、sha、内部状态名；总长不超过 400 字。`

export const QUESTION_REPLY_FORMAT = `代答回复格式（对方问什么答什么，不做盘点）：
- 第一行直接回答对方问的那件事（做了 / 没做 / 做到哪），一句话。
- 答案有保留（等走查、pre 没验证、某处没接）才往下列，一条一行以「- 」开头；第一行说了「还有 N 项」，下面就只有这 N 条，不能再接「已做的」「另外」之类的第二组。
- 对方没问的不写：没问「做了哪些」就不列已完成清单，没问分支就不说合到哪了；上面的三档口径只管措辞诚实，不是要把每一档都列一遍。
- 不写文件路径、sha、内部状态名；总长不超过 200 字。`

const BLANKET = /(都|全部|全都|均|已全部)(已经?|已)?(对完|对接完|完成|接完|接好|做完|好了|没问题|通了|搞定)|不用再管|无遗留/
const ISSUE = /(报错|报\s*\d{3}|\b[45]\d\d\b|为空|没有?数据|没配|未配|未做|没做|还没|待确认|待回归|未验证|还差|缺少?|不显示|不能用|卡在)/

// 返回 null = 没问题；否则 { blanket, issue } 两个命中片段。
export const findCompletionContradiction = (text) => {
  const value = String(text || '')
  const blanket = value.match(BLANKET)
  const issue = value.match(ISSUE)
  return blanket && issue ? { blanket: blanket[0], issue: issue[0] } : null
}

const CN_DIGITS = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
const LEAD_COUNT = /(?:还剩|还有|剩下|还差|有)\s*(\d+|[一两二三四五六七八九十])\s*(?:项|个|条|件|点)/
const BULLET = /^\s*[-•·]\s+\S/

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

// 发群前的统一自检：命中任一矛盾返回人话原因，否则 null。
export const findGroupReplyContradiction = (text) => {
  const completion = findCompletionContradiction(text)
  if (completion) return `这段话说「${completion.blanket}」又列了没完成的问题，自相矛盾，我没发`
  const count = findCountMismatch(text)
  if (count) return `第一行说「${count.lead}」，下面却列了 ${count.actual} 条（多半是把已做的也列进去了），前后对不上，我没发`
  return null
}
