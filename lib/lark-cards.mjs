/**
 * Lark 回执卡片构建（纯函数层，零副作用）。
 *
 * 回执卡片样式与 notify-lark.mjs 的 G0-G8 卡片同一套规则（header 彩色模板 + 图标 + note 时间行），
 * 让 bot 主动发的「已收到/完成/失败/告警」与项目进度卡片视觉统一。
 */

import { aiStatusMeta } from './lark-status-meta.mjs'

export const formatDisplayTime = (date = new Date()) => {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

const RECEIPT_STYLES = {
  queued: { template: 'blue', icon: '🔄', statusText: '已收到，正在排队处理' },
  done: { template: 'green', icon: '✅', statusText: '已完成' },
  failed: { template: 'red', icon: '⛔', statusText: '处理失败' },
  // no_change：经核对本仓无对应改动（后台 API / 别的仓）。中性灰，既非成功也非失败，避免误读成「已修复」或「炸了」。
  no_change: { template: 'grey', icon: 'ℹ️', statusText: '无需改动（不属本仓）' },
  waiting: { template: 'orange', icon: '⏳', statusText: '待确认，需补充材料' },
  blocked: { template: 'orange', icon: '🚧', statusText: '已阻塞，等待外部材料 / 权限' },
  // alert 是 dead-letter / consumer 掉线 / bug 表回写失败 共用的告警形态，具体是哪一种由 lines 说明；
  // 标题不能写死成「长连接异常」，否则回写失败的卡片会把人误导去查长连接。
  alert: { template: 'red', icon: '⚠️', statusText: '需人工关注' },
  // notice：运维态知会（poller 收工等），既不是任务结果也不是故障，用中性色避免与告警混淆。
  notice: { template: 'grey', icon: 'ℹ️', statusText: '运行状态通知' },
}

// 构建 interactive 卡片 content（供 sendChatMessage 的 --content 使用）。lines 为「**标签**：值」正文行。
// 标题跟随任务项目：传 project 用它（跨项目 @ / bug 表任务），不传则回落 config.project + config.title（gateway 级告警）。
export const buildCardContent = ({ config, kind, lines, project, projectTitle }) => {
  const style = RECEIPT_STYLES[kind]
  const headerProject = project || config.project
  const suffix = projectTitle !== undefined
    ? (projectTitle ? ` ${projectTitle}` : '')
    : (headerProject === config.project ? ` ${config.title || config.project}` : '')
  const content = [`**状态**：${style.statusText} ${style.icon}`, ...lines].join('\n')
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      template: style.template,
      title: { tag: 'plain_text', content: `[${headerProject}]${suffix}` },
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content } },
      { tag: 'note', elements: [{ tag: 'plain_text', content: formatDisplayTime() }] },
    ],
  })
}

const taskLine = (task) => `**任务**：${(task.summary || task.text || '').slice(0, 200)}`
const executorLine = (task) => task.aiExecutor ? `**执行器**：${task.aiExecutor === 'codex' ? 'Codex' : 'Claude'}` : null
// 改动落在哪个分支（去哪 review / push）。领取时即写入 task.branch，只读任务无分支则不显示。
const branchLine = (task) => task.branch ? `**分支**：${task.branch}` : null

// 卡片标题用的项目段：有项目号用它（仅当 == config.project 才带 config.title 后缀），
// 无项目号（adhoc 主仓 hotfix）显示「主仓 hotfix」。
const cardProjectOf = (task, config) => ({
  project: task.project || '主仓 hotfix',
  projectTitle: task.project ? (task.project === config.project ? config.title : undefined) : '',
})

export const buildQueuedCard = ({ config, task, note }) =>
  buildCardContent({
    config,
    kind: 'queued',
    lines: [taskLine(task), executorLine(task), note].filter(Boolean),
    ...cardProjectOf(task, config),
  })

export const buildResultCard = ({ config, task, status, result }) => {
  // 结论首行与配色统一走 AI 状态表：done→绿、no_change_needed→中性灰、其余→红失败。
  const meta = aiStatusMeta(status)
  const resultText = (result || meta.header).trim()
  // 结论首行（已完成，待发布 / 处理失败）跟「结果：」同一行显示，编号明细才换行。
  const [head, ...rest] = resultText.split('\n')
  const resultBlock = rest.length ? `**结果**：${head}\n${rest.join('\n')}` : `**结果**：${head}`
  return buildCardContent({
    config,
    kind: meta.cardKind,
    lines: [taskLine(task), executorLine(task), branchLine(task), resultBlock].filter(Boolean),
    ...cardProjectOf(task, config),
  })
}

// 角色/关键词 → open_id 映射：AI 推断的 owner（如「产品」「QA」「设计」）命中配置表 config.ownerMap
// 则 @ 对应责任人；否则回落 @ 提单人（operator）并注明「未识别责任人」。ownerMap 为可选配置，缺表即始终回落。
// 纯函数便于单测：先精确命中 key，再把 key 当关键词做包含匹配（owner 文案里出现该关键词即命中）。
export const resolveOwnerMention = ({ owner, ownerMap = {}, operator } = {}) => {
  const normalizedOwner = String(owner || '').trim()
  if (normalizedOwner && ownerMap) {
    const exact = ownerMap[normalizedOwner]
    const keywordHit = exact
      ? null
      : Object.entries(ownerMap).find(([keyword]) => keyword && normalizedOwner.includes(keyword))?.[1]
    const ownerOpenId = exact || keywordHit
    if (ownerOpenId) return { mentionOpenId: ownerOpenId, ownerNote: null, matched: true }
  }
  return {
    mentionOpenId: operator || null,
    // 有 owner 文案但没配到 open_id、且能回落到提单人时，注明「暂 @ 提单人」，让人知道责任人未识别。
    ownerNote: normalizedOwner && operator ? `（未在责任人表识别「${normalizedOwner}」，暂 @ 提单人）` : null,
    matched: false,
  }
}

// 任务因缺材料 / 待人工确认（waiting_confirmation）或外部阻塞（blocked）而暂停时的回执卡。
// 与「完成/失败」是不同的一条独立消息：橙色 header，能识别责任人（mentionOpenId）时在群里 @ 其补料。
export const buildWaitingCard = ({ config, task, status, result, mentionOpenId, ownerNote }) => {
  const resultText = (result || '需人工确认 / 补充材料后才能继续。').trim()
  // 结论首行跟「结果：」同一行显示，编号明细才换行（与完成/失败卡一致）。
  const [head, ...rest] = resultText.split('\n')
  const resultBlock = rest.length ? `**结果**：${head}\n${rest.join('\n')}` : `**结果**：${head}`
  const mentionLine = mentionOpenId
    ? `<at id=${mentionOpenId}></at> 请协助确认 / 补充上述材料后重新 @ 应用继续${ownerNote ? `\n${ownerNote}` : ''}`
    : null
  return buildCardContent({
    config,
    kind: status === 'blocked' ? 'blocked' : 'waiting',
    lines: [mentionLine, taskLine(task), executorLine(task), resultBlock].filter(Boolean),
    ...cardProjectOf(task, config),
  })
}

// 挂起催办卡：waiting/blocked 的任务在等人补料，没人催就会一直静静躺着（机器人这边不会再动它）。
// 与原回执同色同标题，正文只讲「已挂起多久 + 第几轮催办 + 当时结论首行」，避免重复整篇结果。
export const buildParkedReminderCard = ({ config, task, hours, round, mentionOpenId, ownerNote }) => {
  const nudge = `这条任务已挂起 ${hours}h 无人处理，补充材料后重新 @ 应用即可继续`
  const mentionLine = mentionOpenId
    ? `<at id=${mentionOpenId}></at> ${nudge}${ownerNote ? `\n${ownerNote}` : ''}`
    : `**催办**：${nudge}`
  const conclusion = (task.result || '').trim().split('\n')[0]
  return buildCardContent({
    config,
    kind: task.status === 'blocked' ? 'blocked' : 'waiting',
    lines: [
      mentionLine,
      taskLine(task),
      `**催办轮次**：第 ${round} 轮`,
      conclusion ? `**当时结论**：${conclusion}` : null,
    ].filter(Boolean),
    ...cardProjectOf(task, config),
  })
}
