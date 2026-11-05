/**
 * 两份台账逐封对账（11-05 P3：新机器影子跑 1 个工作日后，和线上 lark-bot 台账比；切换后也能拿来查漏转）。纯函数。
 * 台账形状：{ checkedAt, forwarded: { [message_id]: { at, route, ok, step?, score?, tier?, dryRun? } } }。
 * 同一个邮箱的 message_id 两边一致（都是邮箱主人的 user 身份读的），按 id 对齐。
 * since：只比两边 at 都不早于它的记录（任一边落在窗口里就算进来）；until 同理（缺省不限）。
 */
const inWindow = (record, since, until) => {
  const at = Date.parse(record?.at || '')
  if (!Number.isFinite(at)) return false
  return (since == null || at >= Date.parse(since)) && (until == null || at <= Date.parse(until))
}

// 返回 { onlyLeft, onlyRight, differ, same }：each 是 [{ id, left?, right? }]。只看 ok 的记录（转成 / 本该转成），filter / score 失败的另列在 skipped。
export const compareLedgers = ({ left, right, since = null, until = null }) => {
  const pick = (ledger) => Object.fromEntries(Object.entries(ledger?.forwarded || {}).filter(([, record]) => inWindow(record, since, until)))
  const a = pick(left)
  const b = pick(right)
  const ids = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort((x, y) => String((a[x] || b[x]).at).localeCompare(String((a[y] || b[y]).at)))
  const result = { onlyLeft: [], onlyRight: [], differ: [], same: [] }
  for (const id of ids) {
    const l = a[id]
    const r = b[id]
    if (!r) result.onlyLeft.push({ id, left: l })
    else if (!l) result.onlyRight.push({ id, right: r })
    else if (l.route !== r.route || l.ok !== r.ok || (l.score ?? null) !== (r.score ?? null) || (l.tier ?? null) !== (r.tier ?? null)) result.differ.push({ id, left: l, right: r })
    else result.same.push({ id, left: l, right: r })
  }
  return result
}

const brief = (record) => [record.route, record.ok ? null : `没转成(${record.step || '?'})`, record.score != null ? `${record.score}分 ${record.tier}` : null].filter(Boolean).join(' ')

// 人看的报告：一行总结 + 有差异的逐条。leftName / rightName 是两份台账的叫法（如「新机器影子」「线上」）。
export const renderComparison = ({ comparison, leftName = '左', rightName = '右' }) => {
  const { onlyLeft, onlyRight, differ, same } = comparison
  const lines = [`一致 ${same.length} 封；只在${leftName} ${onlyLeft.length} 封；只在${rightName} ${onlyRight.length} 封；两边结果不同 ${differ.length} 封`]
  for (const { id, left } of onlyLeft) lines.push(`- 只在${leftName}：${id}（${brief(left)}，${left.at}）`)
  for (const { id, right } of onlyRight) lines.push(`- 只在${rightName}：${id}（${brief(right)}，${right.at}）`)
  for (const { id, left, right } of differ) lines.push(`- 不同：${id}（${leftName} ${brief(left)}；${rightName} ${brief(right)}）`)
  return lines.join('\n')
}

export const comparisonClean = ({ onlyLeft, onlyRight, differ }) => onlyLeft.length === 0 && onlyRight.length === 0 && differ.length === 0
