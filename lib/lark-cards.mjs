/**
 * Lark 回执卡片构建（纯函数层，零副作用）。
 *
 * 回执卡片样式与 notify-lark.mjs 的 G0-G8 卡片同一套规则（header 彩色模板 + 图标 + note 时间行），
 * 让 bot 主动发的「已收到/完成/失败/告警」与项目进度卡片视觉统一。
 */

export const formatDisplayTime = (date = new Date()) => {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

const RECEIPT_STYLES = {
  queued: { template: 'blue', icon: '🔄', statusText: '已收到，正在排队处理' },
  done: { template: 'green', icon: '✅', statusText: '已完成' },
  failed: { template: 'red', icon: '⛔', statusText: '处理失败' },
  waiting: { template: 'orange', icon: '⏳', statusText: '待确认，需补充材料' },
  blocked: { template: 'orange', icon: '🚧', statusText: '已阻塞，等待外部材料 / 权限' },
  alert: { template: 'red', icon: '⚠️', statusText: 'Lark 长连接异常' },
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
  const resultText = (result || (status === 'done' ? '已完成，待发布。' : '处理失败。')).trim()
  // 结论首行（已完成，待发布 / 处理失败）跟「结果：」同一行显示，编号明细才换行。
  const [head, ...rest] = resultText.split('\n')
  const resultBlock = rest.length ? `**结果**：${head}\n${rest.join('\n')}` : `**结果**：${head}`
  return buildCardContent({
    config,
    kind: status === 'done' ? 'done' : 'failed',
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
