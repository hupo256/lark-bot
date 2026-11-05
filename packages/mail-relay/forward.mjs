/**
 * 一封邮件按路由转到群（aven 11-02）：user 读全信 → 按路由再判一次（全字段）→ 评分器打分（路由没配就不评）
 * → user 身份 +share-to-chat 分享成卡片 → bot 回在卡片下（评分说明，或只有类别一行；首行放 text 段，话题收起时也看得到）；回复失败回落 bot 直发，再失败 user 直发。
 * run 是 lark-cli 调用器（可注入：单测桩、或拆成独立应用时带 LARKSUITE_CLI_CONFIG_DIR 的版本）。
 */
import { larkCallFailed, parseSentMessageId, replyMarkdown, runLarkCli, sendMarkdown } from './lark.mjs'
import { getScorer } from './presets.mjs'
import { routeMatches } from './routes.mjs'

const parseJson = (text) => {
  try {
    return JSON.parse(String(text || ''))
  } catch {
    return null
  }
}

const failure = (step, result) => ({ ok: false, step, reason: String(result?.stderr || result?.stdout || '').slice(0, 300) })

export const fetchMail = async ({ messageId, run = runLarkCli }) => {
  const result = await run(['mail', '+message', '--message-id', messageId, '--format', 'json'], { identity: 'user' })
  const mail = parseJson(result.stdout)?.data
  if (larkCallFailed(result) || !mail) return { ok: false, ...failure('read', result) }
  return { ok: true, mail }
}

const senderOf = (mail) => mail.head_from?.name || mail.head_from?.mail_address || null

// 群里卡片下那条：有评分器 → 评分说明；没有 → 只标类别和发件人，让群里知道这是哪类审批。
export const renderRelayNote = ({ route, mail }) => {
  const scorer = getScorer(route.scorer)
  const body = mail.body_plain_text || mail.body_preview
  if (!scorer) return { result: null, markdown: `**${route.label}**${senderOf(mail) ? ` · 发件人 ${senderOf(mail)}` : ''}` }
  const result = scorer.score({ subject: mail.subject, body, to: mail.to, cc: mail.cc })
  return { result, markdown: scorer.render(result, { sender: senderOf(mail), subject: mail.subject, label: route.label }) }
}

// force：跳过路由复核（手动补发）。dryRun：只出说明不发。
export const forwardMail = async ({ messageId, route, force = false, dryRun = false, run = runLarkCli }) => {
  const read = await fetchMail({ messageId, run })
  if (!read.ok) return read
  const { mail } = read
  if (!force && !routeMatches(route, mail)) return { ok: false, step: 'filter', reason: `不符合路由 ${route.id}：${mail.subject}` }
  const { result, markdown } = renderRelayNote({ route, mail })
  if (dryRun) return { ok: true, dryRun: true, subject: mail.subject, route: route.id, result, markdown }

  const shared = await run(['mail', '+share-to-chat', '--message-id', messageId, '--receive-id', route.chatId, '--format', 'json'], { identity: 'user' })
  if (larkCallFailed(shared)) return failure('share', shared)
  // +share-to-chat 回的是 data.im_message_id（11-02 真发核对），不是 messages-send 的 message_id。
  const cardMessageId = parseJson(shared.stdout)?.data?.im_message_id || parseSentMessageId(shared.stdout)
  const base = { subject: mail.subject, route: route.id, result, cardMessageId }
  if (!route.reply) return { ok: true, ...base, scoreVia: 'none' }

  const reply = await replyMarkdown({ messageId: cardMessageId, markdown, headline: true, fallbackChatId: route.chatId, logPrefix: `mail-relay ${route.id}`, logTag: '[lark-mail-relay]', run })
  if (reply.ok) return { ok: true, ...base, scoreMessageId: reply.messageId, scoreVia: `bot-${reply.via}` }
  const asUser = (args, options = {}) => run(args, { ...options, identity: 'user' })
  const fallback = await sendMarkdown({ chatId: route.chatId, markdown, headline: true, logPrefix: `mail-relay ${route.id} as user`, logTag: '[lark-mail-relay]', run: asUser })
  if (!fallback.ok) return { ok: false, step: 'score', reason: `bot：${reply.reason}；user：${fallback.reason}`, cardMessageId }
  return { ok: true, ...base, scoreMessageId: fallback.messageId, scoreVia: 'user-send' }
}
