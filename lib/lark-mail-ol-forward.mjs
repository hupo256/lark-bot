/**
 * OL 上线申请邮件 → 审批群（aven 11-02）：读邮件（aven 的 user 身份）→ 打分 → 以 aven 身份把邮件分享成卡片发到群
 * （+share-to-chat 只支持 user 身份）→ bot 回复那张卡片附评分说明（bot 不在群里 / 回复失败就回落为 aven 身份直发）。
 * 事件接入（mail +watch）落地前，先由 scripts/lark-mail-ol-forward.mjs 手动按 message_id 触发；见 docs/mail-ol-scoring-2026-11-02.md。
 * run 可注入（单测桩掉子进程）。
 */
import { larkCallFailed, parseSentMessageId, replyMarkdown, runLarkCli, sendMarkdown } from './lark-cli.mjs'
import { isOlApplicationMail, renderOlScore, scoreOlMail } from './lark-mail-ol-score.mjs'

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

// force：跳过「是否 OL 申请首封」判定（手动补发某封回复时用）。dryRun：只打分不发。
export const forwardOlMail = async ({ messageId, chatId, force = false, dryRun = false, run = runLarkCli }) => {
  const read = await fetchMail({ messageId, run })
  if (!read.ok) return read
  const { mail } = read
  if (!force && !isOlApplicationMail({ subject: mail.subject, inReplyTo: mail.in_reply_to })) {
    return { ok: false, step: 'filter', reason: `不是 OL 上线申请首封：${mail.subject}` }
  }
  const result = scoreOlMail({ subject: mail.subject, body: mail.body_plain_text || mail.body_preview, to: mail.to, cc: mail.cc })
  const markdown = renderOlScore(result, { sender: mail.head_from?.name || mail.head_from?.mail_address, subject: mail.subject })
  if (dryRun) return { ok: true, dryRun: true, subject: mail.subject, result, markdown }

  const shared = await run(['mail', '+share-to-chat', '--message-id', messageId, '--receive-id', chatId, '--format', 'json'], { identity: 'user' })
  if (larkCallFailed(shared)) return failure('share', shared)
  // +share-to-chat 回的是 data.im_message_id（11-02 真发核对），不是 messages-send 的 message_id。
  const cardMessageId = parseJson(shared.stdout)?.data?.im_message_id || parseSentMessageId(shared.stdout)

  // bot 回在卡片下；bot 不在群里时 reply 会非瞬时失败 → 回落直发（仍是 bot），再失败就用 aven 身份直发，保证评分到群。
  const reply = await replyMarkdown({ messageId: cardMessageId, markdown, fallbackChatId: chatId, logPrefix: 'mail-ol score', logTag: '[lark-mail-ol]', run })
  if (reply.ok) return { ok: true, subject: mail.subject, result, cardMessageId, scoreMessageId: reply.messageId, scoreVia: `bot-${reply.via}` }
  const asUser = (args, options = {}) => run(args, { ...options, identity: 'user' })
  const fallback = await sendMarkdown({ chatId, markdown, logPrefix: 'mail-ol score as user', logTag: '[lark-mail-ol]', run: asUser })
  if (!fallback.ok) return { ok: false, step: 'score', reason: `bot：${reply.reason}；user：${fallback.reason}`, cardMessageId }
  return { ok: true, subject: mail.subject, result, cardMessageId, scoreMessageId: fallback.messageId, scoreVia: 'user-send' }
}
