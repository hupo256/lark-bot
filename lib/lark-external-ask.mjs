import { sendGroupCard } from './lark-repo-delivery.mjs'
import { isPrivateOnlyChat, resolveWebhookCredentials } from './lark-repo-profile.mjs'
import { sendWebhookMessage } from './lark-webhook.mjs'

// 本机脚本（~/.lark-bugpoll 的 bug 表轮询）在仓库群里向测试 / 开发要材料（测试账号、复现数据）：aven 2026-10-26 定，
// 拿不到对方账号就验不了的，直接在群里 @ 当事人要，不只在汇报里写「没验到」。
// 只发仓库登记的群；只私聊的群不发、回 privateOnly 由调用方写进汇报；走 sendGroupCard 的出口闸，phase 用 blocked_ask（同内容 24h 不重发）。
// mentions：[{ openId, owner }]，正文里写 @owner 会换成 @人；正文没写到的人补在行首。
export const deliverExternalAsk = async ({ profile, chatId = null, body, mentions = [], source = 'cli', deps = {} }) => {
  if (!profile || profile.isDefault) return { ok: false, status: 404, reason: 'repo not found' }
  const text = String(body || '').trim()
  if (!text) return { ok: false, status: 400, reason: 'missing markdown' }
  const targets = chatId ? [chatId] : profile.chatIds.filter((id) => !isPrivateOnlyChat(profile, id))
  const target = targets[0]
  if (!profile.chatIds.includes(target)) return { ok: false, status: 400, reason: `chat not registered for repo ${profile.key}: ${target || '(none)'}` }
  const people = (Array.isArray(mentions) ? mentions : []).filter((item) => /^ou_\w+$/.test(String(item?.openId || ''))).map((item) => ({ openId: item.openId, owner: String(item.owner || item.openId) }))
  const lead = people.filter((item) => !text.includes(`@${item.owner}`)).map((item) => `@${item.owner}`).join(' ')
  const webhook = deps.webhookFor ? deps.webhookFor(profile, target) : resolveWebhookCredentials(profile, target)
  if (!webhook && !isPrivateOnlyChat(profile, target)) return { ok: false, status: 400, reason: `no webhook for ${target}` }
  const sent = await sendGroupCard({
    webhook,
    chatId: target,
    phase: 'blocked_ask',
    body: lead ? `${lead} ${text}` : text,
    mentions: people,
    logPrefix: `ask ${String(source).slice(0, 40)}`,
    sendHook: deps.sendWebhookMessage || sendWebhookMessage,
    createDoc: deps.createLarkDoc,
  })
  return { ok: Boolean(sent.ok), chatId: target, gated: sent.gated ?? null, privateOnly: Boolean(sent.privateOnly), reason: sent.reason ?? null, status: sent.ok ? 200 : (sent.gated ? 409 : 502) }
}
