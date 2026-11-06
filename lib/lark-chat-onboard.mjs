/**
 * 新群接入（aven 2026-11-03：「webhook bot 每加一个群都要改好几处 + 重启，没封装好」）。
 *
 * 自定义机器人只能往群里发、收不到任何事件，bot 不知道自己被拉进了哪个群；webhook 地址和密钥只在群设置里看得到。
 * 这两样必须人给，其余由 `falive-bot add-chat` 一次做完：
 *   ① 群 id：按群名精确查（用户身份 chat-search），或直接给 --chat-id；
 *   ② webhook 校验：签名正确、消息类型故意给错，Lark 验过签名后拒收（19002），群里不会出现任何消息；
 *   ③ 群里机器人的 open_id：按 botName 认（不区分大小写 / 空格，群里叫「Aven.bot」也认）；
 *   ④ 凭据存 0600 文件，profile 写四处（chatIds / webhooksByChat / chatLabels / botMentionOpenIds），写前备份。
 * 不用手动重启：worker 的排空重启（lib/lark-drain-restart.mjs）看到配置变了，等在飞任务跑完、自检通过后自动 restart。
 *
 * 纯函数（认机器人 / 选群 / 判校验结果 / 改配置）可直测；IO 走 deps 注入。
 */

import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { signWebhook } from './lark-webhook.mjs'

const compactName = (name) => String(name || '').replace(/\s+/g, '').toLowerCase()

// 认群里的自定义机器人：名字去空格、不区分大小写（11-03 交接群里叫「Aven.bot」，配置是「Aven.Bot」，启动发现认不出）。
export const sameBotName = (a, b) => Boolean(compactName(a)) && compactName(a) === compactName(b)
export const findCustomBot = (bots, botName) => (bots || []).find((bot) => sameBotName(bot?.name, botName)) || null

// 群名只认精确命中（去首尾空格）；没有或重名都不猜，把候选报回去。
export const pickChatByName = (chats, name) => {
  const wanted = String(name || '').trim()
  const exact = (chats || []).filter((chat) => chat?.chat_id && String(chat.name || '').trim() === wanted)
  if (exact.length > 1) return { error: `有 ${exact.length} 个群都叫「${wanted}」，请改用 --chat-id 指定` }
  if (exact.length === 1) return { chat: exact[0] }
  const candidates = (chats || []).map((chat) => chat?.name).filter(Boolean)
  return { error: `没找到叫「${wanted}」的群（候选：${candidates.join(' / ') || '无'}）；确认你本人在群里、群名一字不差，或改用 --chat-id` }
}

// webhook 校验结果：19002（参数错）= 签名已验过、只是内容被拒，凭据是对的；19021 = 密钥不对；其它（如 19001）= 地址不对 / 机器人被删。
export const classifyWebhookProbe = (payload) => {
  const code = payload?.code ?? payload?.StatusCode
  if (code === 19002 || code === 0) return { ok: true }
  if (code === 19021) return { ok: false, reason: '签名不对：密钥填错了，或这个机器人没开签名校验却填了密钥' }
  return { ok: false, reason: `webhook 不可用（code ${code ?? '无'}：${String(payload?.msg || payload?.StatusMessage || '响应解析不了').slice(0, 80)}）：地址填错了，或机器人已被移出群` }
}

// 故意发一个不存在的消息类型：Lark 先验签名再验内容，群里不会出现消息。
export const probeWebhook = async ({ url, secret, fetchImpl = fetch, now = Date.now() }) => {
  const body = { msg_type: 'falive_onboard_probe' }
  if (secret) {
    body.timestamp = String(Math.floor(now / 1000))
    body.sign = signWebhook({ secret, timestamp: body.timestamp })
  }
  try {
    const response = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) })
    let payload = null
    try {
      payload = JSON.parse(await response.text())
    } catch { /* 非 JSON 按不可用处理 */ }
    return classifyWebhookProbe(payload)
  } catch (error) {
    return { ok: false, reason: `webhook 请求失败：${String(error?.message || error).slice(0, 120)}` }
  }
}

// 凭据文件名：<仓>-webhook-<chat_id 末 8 位>.json，同一个群重复接入覆盖同一个文件。
export const webhookFileFor = (credDir, repoKey, chatId) => join(credDir, `${repoKey}-webhook-${String(chatId).slice(-8)}.json`)

// 把群写进 repo profile（返回新对象，不改入参）；同一个群已归别的仓就拒绝（buildRepoRegistry 会因此拒绝启动）。
// console=true：负责人控制台群（notifyChatId）——bot 把它当私聊轮询，不是仓库群，不进 chatIds。
export const applyChatToRepoConfig = (config, { repoKey, chatId, label, botOpenId, webhookFile, console: asConsole = false }) => {
  if (!config?.repos?.[repoKey]) throw new Error(`配置里没有仓 ${repoKey}`)
  for (const [key, repo] of Object.entries(config.repos)) {
    if (key !== repoKey && (repo?.chatIds || []).includes(chatId)) throw new Error(`群 ${chatId} 已经属于仓 ${key}`)
  }
  const next = structuredClone(config)
  const repo = next.repos[repoKey]
  if (asConsole) {
    if ((repo.chatIds || []).includes(chatId)) throw new Error(`群 ${chatId} 已经是仓库群，不能再当控制台`)
    repo.notifyChatId = chatId
  } else {
    if (repo.notifyChatId === chatId) throw new Error(`群 ${chatId} 是控制台群，不能再当仓库群`)
    repo.chatIds = [...new Set([...(repo.chatIds || []), chatId])]
  }
  repo.webhooksByChat = { ...repo.webhooksByChat, [chatId]: { file: webhookFile } }
  if (label) repo.chatLabels = { ...repo.chatLabels, [chatId]: label }
  if (botOpenId) repo.botMentionOpenIds = { ...repo.botMentionOpenIds, [chatId]: botOpenId }
  return next
}

// 0600 原子写：先写同目录临时文件再 rename，写到一半崩了不会留下半个配置。
const writePrivateJson = (path, value) => {
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}`)
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
}

const stamp = (date) => date.toISOString().replace(/[-:]/g, '').slice(0, 13)

/**
 * 接入一个群。参数：configPath、repoKey、name 或 chatId（至少一个）、webhookUrl、secret（可空）、label（默认群名）、credDir、console（控制台群）。
 * deps：searchChats(name) → [{ chat_id, name }]、listBots(chatId) → [{ name, openId }]、probe({ url, secret }) → { ok, reason }、
 *       validate(config) → 错误数组、now()。
 * 返回 { ok, chatId, label, botOpenId, webhookFile, backup, notes } 或 { ok: false, reason }。校验没过之前不写任何文件。
 */
export const onboardChat = async ({ configPath, repoKey = 'falive', name = '', chatId = '', webhookUrl, secret = '', label = '', credDir, console: asConsole = false, deps }) => {
  if (!webhookUrl) return { ok: false, reason: '缺 --webhook（群设置 → 群机器人 → 该机器人 → webhook 地址）' }
  if (!name && !chatId) return { ok: false, reason: '缺 --name（群名）或 --chat-id' }
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  const profile = config.repos?.[repoKey]
  if (!profile) return { ok: false, reason: `配置里没有仓 ${repoKey}` }

  let resolvedId = chatId
  let resolvedName = ''
  if (!resolvedId) {
    const picked = pickChatByName(await deps.searchChats(name), name)
    if (picked.error) return { ok: false, reason: picked.error }
    resolvedId = picked.chat.chat_id
    resolvedName = String(picked.chat.name || '').trim()
  }

  const probe = await deps.probe({ url: webhookUrl, secret })
  if (!probe.ok) return { ok: false, reason: probe.reason }

  const notes = []
  const bots = await deps.listBots(resolvedId)
  const bot = findCustomBot(bots, profile.botName)
  if (!bot) notes.push(`群里没认出「${profile.botName}」（群里的机器人：${bots.map((item) => item.name).join(' / ') || '无'}），先不写机器人 id；群里第一次 @ 它时 bot 会按名字认出并记住`)

  const webhookFile = webhookFileFor(credDir, repoKey, resolvedId)
  const finalLabel = label || resolvedName || name || profile.chatLabels?.[resolvedId] || ''
  let next
  try {
    next = applyChatToRepoConfig(config, { repoKey, chatId: resolvedId, label: finalLabel, botOpenId: bot?.openId || '', webhookFile, console: asConsole })
  } catch (error) {
    return { ok: false, reason: error.message }
  }
  const errors = deps.validate(next)
  if (errors.length) return { ok: false, reason: `写入后配置校验不过：${errors.join('；')}` }

  writePrivateJson(webhookFile, secret ? { webhookUrl, secret } : { webhookUrl })
  const backup = join(dirname(configPath), `lark-bot.bak-${stamp(deps.now())}.local.json`)
  if (!existsSync(backup)) writeFileSync(backup, readFileSync(configPath), { mode: 0o600 })
  writePrivateJson(configPath, next)
  return { ok: true, chatId: resolvedId, label: finalLabel, botOpenId: bot?.openId || '', webhookFile, backup, notes }
}
