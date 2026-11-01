/**
 * 完成结论的机械矛盾检查（从 falive 移植 lib/lark-completion-rule 的两个纯函数，aven 2026-10-13 / 教训 #56 #58）。
 * 模型常把「前端调用代码写好了」当成完成，同一段话里又列了没通的问题；或结论行说「还剩 N 项」、下面却列了别的数量。
 * falive 的群出口命中就不发群；fameex 的结果卡发到内部群由人 review，这里只在完成卡上追加一行 ⚠ 提醒，不扣消息。
 * 纯函数，不碰 I/O（worker / gateway 都能引）。
 */

const BLANKET = /(都|全部|全都|均|已全部)(已经?|已)?(对完|对接完|完成|接完|接好|做完|好了|没问题|通了|搞定)|不用再管|无遗留/
// 状态码只认带动词 / 协议词的写法（「回 500」「HTTP 404」「code -1」不算）：裸的 `\b[45]\d\d\b` 会把 uid 508 / 428、房间 431 当成 5xx。
const ISSUE = /(报错|报\s*\d{3}|(?:回|返回|响应|HTTP|status)\s*[45]\d\d\b|为空|没有?数据|没配|未配|未做|没做|还没|待确认|待回归|未验证|还差|缺(?!省)少?|不显示|不能用|卡在)/

// 否定说法是「已经好了」的证据，不是问题（#56：「都通了…第 2 页不再报错」被判自相矛盾）。
// 只剥「报错 / 报 5xx / 卡在」前的否定；「没有数据」「不显示」本身就是问题，不剥。
const NEGATED_ISSUE = /(?:不再|不会|没再|没有?|未|无|不)\s*(?:报错|报\s*\d{3}|卡在)/g
// 「为空」紧跟「说明到底了 / 是正常的」是分页到底的正常现象（#58）。
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

// 完成卡上追加的人话提醒；没问题返回 null。
export const completionContradictionNote = (text) => {
  const completion = findCompletionContradiction(text)
  if (completion) return `结论自相矛盾：说「${completion.blanket}」又列了「${completion.issue}」，请人工核对`
  const count = findCountMismatch(text)
  if (count) return `结论前后对不上：第一行说「${count.lead}」，下面却列了 ${count.actual} 条，请人工核对`
  return null
}
