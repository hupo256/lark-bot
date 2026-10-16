/**
 * 失败卡旁证（自愈环 1.6，docs/falive-self-healing.md）：worker 要报「没做成」之前，先看这条任务
 * 期间 bot 实际对外做了什么——发件簿里已发出的群消息、工作区有没有改动。10-15「日报发一下」就是
 * 日报 21:24 已经发到群里、只是结果文件没写，失败卡却只贴 ENOENT，人要去翻日志才知道活干成了。
 * 纯函数；发件簿条目由调用方传入（lark-outbox.listOutbox）。
 */

// 这些阶段只是「收到 / 开始 / 被闸拦下」，不算做成了什么。
const NON_OUTCOME_PHASES = new Set(['ack', 'start', 'received', 'suspected', 'gated'])

const PHASE_LABELS = {
  done: '完成消息',
  daily_report: '日报',
  question: '代答',
  blocked: '阻塞说明',
  waiting: '待确认',
}

const hhmm = (iso) => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '?'
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const firstLine = (text) =>
  String(text || '')
    .replace(/<at id=[^>]*><\/at>/g, '')
    .split('\n')
    .map((line) => line.replace(/^#+\s*/, '').trim())
    .find(Boolean)
    ?.slice(0, 60) || ''

/**
 * @returns {{ probablyDone: boolean, lines: string[] }}
 *   probablyDone：发件簿里有本任务的完成消息（或任务是日报而期间日报已发群）——活大概率干成了。
 *   lines：给失败卡 / 私信看的旁证句子，没有旁证就空数组。
 */
export const collectFailureEvidence = ({ task, outbox = [], worktreeState = null }) => {
  const sinceMs = Date.parse(task?.claimedAt || task?.createdAt || '') || 0
  const sent = outbox.filter((entry) => !entry.gated && (Date.parse(entry.at || '') || 0) >= sinceMs && !NON_OUTCOME_PHASES.has(entry.phase))
  const own = sent.filter((entry) => entry.taskId === task?.id)
  const isReportTask = /日报/.test(String(task?.text || task?.summary || ''))
  const strong = [
    ...own.filter((entry) => entry.phase === 'done'),
    ...(isReportTask ? sent.filter((entry) => entry.phase === 'daily_report') : []),
  ]
  const lines = []
  const seen = new Set()
  for (const entry of [...strong, ...own, ...sent]) {
    if (seen.has(entry) || lines.length >= 3) continue
    seen.add(entry)
    const label = PHASE_LABELS[entry.phase] || entry.phase
    const whose = entry.taskId === task?.id ? '本任务的' : strong.includes(entry) ? '' : '另一条'
    lines.push(`${hhmm(entry.at)} 群里已发${whose}${label}「${firstLine(entry.text)}」`)
  }
  if (worktreeState === 'dirty') lines.push('工作区有未提交改动（现场已保留）')
  return { probablyDone: strong.length > 0, lines }
}

// 失败卡里的一行：有旁证列旁证并给判断；没有就明说「无」，让人不用再去翻。
export const formatFailureEvidence = (evidence) => {
  if (!evidence?.lines?.length) return '旁证：无（期间群里没发过消息、工作区无改动）'
  const tail = evidence.probablyDone ? ' → 活可能已经干成，只是没拿到结果文件，先看群里' : ''
  return `旁证：${evidence.lines.join('；')}${tail}`
}

export const isProbablyDoneResult = (result) => /活可能已经干成/.test(String(result || ''))
