/**
 * Lark 卡片构建（纯函数层，零副作用）——11-01 对话层后只剩网关告警 / 运维知会两种：
 * 死信、长连接掉线、bug 表回写失败、poller 收工这类「不是任务结论」的消息。任务相关的所有回复（收到 / 结论 / 待确认 / 催办）
 * 都改成人话回复原消息（lib/lark-human-text.mjs + lib/lark-group-exit.mjs），不再有卡片模板。
 * 卡片样式与 notify-lark.mjs 的 G0-G8 卡片同一套规则（header 彩色模板 + 图标 + note 时间行）。
 */

export const formatDisplayTime = (date = new Date()) => {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

const RECEIPT_STYLES = {
  // alert 是 dead-letter / consumer 掉线 / bug 表回写失败 共用的告警形态，具体是哪一种由 lines 说明；
  // 标题不能写死成「长连接异常」，否则回写失败的卡片会把人误导去查长连接。
  alert: { template: 'red', icon: '⚠️', statusText: '需人工关注' },
  // notice：运维态知会（poller 收工等），既不是任务结果也不是故障，用中性色避免与告警混淆。
  notice: { template: 'grey', icon: 'ℹ️', statusText: '运行状态通知' },
}

// 构建 interactive 卡片 content（供 sendChatMessage 的 --content 使用）。lines 为「**标签**：值」正文行。
// 标题跟随任务项目：传 project 用它（跨项目 @ / bug 表任务），不传则回落 config.project + config.title（gateway 级告警）。
export const buildCardContent = ({ config, kind, lines, project, projectTitle }) => {
  const style = RECEIPT_STYLES[kind] || RECEIPT_STYLES.notice
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

// 角色 / 关键词 → open_id 映射已搬到 lib/lark-human-text.mjs；这里转出口给旧引用。
export { resolveOwnerMention } from './lark-human-text.mjs'
