/**
 * 仓库 profile（外部群）任务的人话出口（aven 2026-10-13 定）。
 * 默认仓（fameex）继续走卡片 + 回执 + 催办那一套，本文件只对 repoProfileForTask(task) 非默认的任务生效。
 *
 * 出口只有两条：
 *   · 负责人私聊：每条任务开始时一行、结束时一条短消息（Markdown），不发卡片、不催办、不发收尾知会；
 *   · 外部群：只在 done 时发一句人话（+ 待确认清单的云文档链接 + @ 负责人），走该群的自定义机器人 webhook；
 *     群没配 webhook 时不发，把要发的话放进私聊那条消息里，负责人想回就手动转发。
 * 回复群 / 私聊那条消息即可续跑（消息 id 登记成回执锚点）。
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { sendBotMarkdown } from './lark-cli.mjs'
import { createLarkDocFromMarkdown } from './lark-docs.mjs'
import { resolveMentions } from './lark-group-reply.mjs'
import { repoProfileForTask, resolveWebhookCredentials } from './lark-repo-profile.mjs'
import { sendWebhookMessage } from './lark-webhook.mjs'

const SIGNATURE = '— 由 aven 的助手整理'

export const isHumanDeliveryTask = (task) => {
  const profile = task ? repoProfileForTask(task) : null
  return Boolean(profile && !profile.isDefault)
}

// 结构化结果文案（「已完成，待发布。\n1. …\n2. 判定：…」）→ 人话段落：去掉定型首行、编号与机器口径的行。
const RESULT_HEADERS = /^(已完成，待发布。?|查询完成。?|无需改动。?|处理失败。?|已阻塞，需外部材料.*|需人工确认.*才能继续。?|需人工复核.*)$/
const MACHINE_LINES = /^(判定|分诊|依据|相关提交|失败类型|系统实测|Worker 终检|修改范围契约)[：:]/
export const humanizeResult = (result, { maxLines = 6 } = {}) => {
  const lines = String(result || '').split('\n').map((line) => line.trim()).filter(Boolean)
  const out = []
  let inContract = false
  for (const raw of lines) {
    if (RESULT_HEADERS.test(raw)) continue
    const line = raw.replace(/\*\*/g, '').replace(/^\d+[.、]\s*/, '').replace(/^[·•]\s*/, '')
    if (/^修改范围契约/.test(line)) { inContract = true; continue }
    if (inContract && /^(契约目标|同因搜索词|排除的兄弟位置|纳入的兄弟位置|-\s|…另 \d+ 项)/.test(line)) continue
    inContract = false
    if (MACHINE_LINES.test(line)) continue
    out.push(line)
    if (out.length >= maxLines) break
  }
  return out
}

const takeLine = (lines, prefix) => {
  const index = lines.findIndex((line) => line.startsWith(prefix))
  if (index < 0) return null
  const [line] = lines.splice(index, 1)
  return line.slice(prefix.length).trim()
}

const chatLabel = (profile, chatId) => profile?.chatNameById?.[chatId] || chatId

// 群里那句话：done 一句 ✅；有待跟进 → @ 负责人 + 一句 + 云文档链接 + 每人一行要点。
export const buildRepoGroupText = ({ task, mentions = [], docUrl = null }) => {
  const reply = (task.groupReply || task.summary || '').trim().replace(/[。.]$/, '')
  // 代答提问：答案本身，不带 ✅。
  if (task.commandType === 'status') return `${reply}\n${SIGNATURE}`
  if (!mentions.length) return `✅ ${reply}\n${SIGNATURE}`
  const who = mentions.map((m) => (m.openId ? `<at user_id="${m.openId}">${m.owner}</at>` : `@${m.owner}`)).join(' ')
  const bullets = mentions.filter((m) => m.items.length).map((m) => `${m.owner}：${m.items.slice(0, 4).join('；')}${m.items.length > 4 ? '…' : ''}`)
  return [`${who} ${reply ? `${reply}。` : ''}${docUrl ? `待确认的几点在这里：${docUrl}` : '还有几点要确认：'}`, ...bullets, SIGNATURE].join('\n')
}

// 负责人私聊那条：状态符号 + 人话结论 + 分支 / 文件数 + 群里发没发 + 待确认清单链接。
export const buildRepoNote = ({ task, status, profile, result, docUrl = null, groupOutcome = null, mentions = [] }) => {
  const lines = humanizeResult(result)
  const blockers = takeLine(lines, '待补充：')
  const nextStep = takeLine(lines, '下一步：')
  const body = lines.join('\n')
  const where = `（${chatLabel(profile, task.chatId)}）`
  const head = (task.summary || task.text || '').split('\n')[0].slice(0, 60)
  const out = []
  if (status === 'done') {
    out.push(`✅ ${body || head}`)
    const facts = []
    if (task.branch) facts.push(`分支 ${task.branch}`)
    if (Array.isArray(task.changedFiles) && task.changedFiles.length) facts.push(`改了 ${task.changedFiles.length} 个文件`)
    if (facts.length) out.push(facts.join(' · '))
    if (mentions.length) out.push(`要 ${mentions.map((m) => m.owner).join('、')} 跟进${docUrl ? `：${docUrl}` : '（清单在分支里的 ' + (task.followUpDoc || '待确认文档') + '）'}`)
  } else if (status === 'no_change_needed') {
    out.push(`ℹ️ 看过了，不用改${where}：${body || head}`)
  } else if (status === 'failed') {
    out.push(`⛔ 没做成${where}：${body || head}`)
    if (nextStep) out.push(nextStep)
  } else {
    out.push(`⏸ 停下来了${where}：${body || head}`)
    if (blockers) out.push(`要：${blockers}`)
    out.push('回复这条消息把材料补上就会继续。')
  }
  if (groupOutcome) {
    if (groupOutcome.ok) out.push(`群里已回：「${groupOutcome.text.split('\n')[0].replace(/<at[^>]*>|<\/at>/g, '').trim()}」`)
    else if (groupOutcome.text) out.push(`群里没发（${groupOutcome.reason}），要回可以转发这段：\n${groupOutcome.text.replace(/<at user_id="[^"]*">([^<]*)<\/at>/g, '@$1').replace(`\n${SIGNATURE}`, '')}`)
  }
  return out.join('\n')
}

// 疑似（分类拿不准）：问负责人一句，不催。
export const buildRepoSuspectedNote = ({ task, profile }) => {
  const head = (task.summary || task.text || '').split('\n')[0].slice(0, 80)
  return `❓ 可能是你的事（${chatLabel(profile, task.chatId)}）：${head}\n是 → 回「继续任务 ${task.id} 做」；不是 → 回「取消任务 ${task.id}」。不回也不催。`
}

export const deliverRepoSuspected = async ({ task, deps = {} }) => {
  const profile = repoProfileForTask(task)
  if (!profile || profile.isDefault || !profile.notifyChatId) return { ok: false, skipped: true }
  const send = deps.sendMarkdown || sendBotMarkdown
  return send({ chatId: profile.notifyChatId, markdown: buildRepoSuspectedNote({ task, profile }), logPrefix: `repo suspected ${task.id}` })
}

export const buildRepoStartNote = ({ task, profile }) => {
  const head = (task.summary || task.text || '').split('\n')[0].slice(0, 80)
  return `🛠 开始做${task.resumeCount || task.rerunCount ? '（续）' : ''}：${head}（${chatLabel(profile, task.chatId)}）`
}

// 从分支里取出待确认清单（worktree 已回收，文件只在提交里），建成云文档。取不到 / 建失败返回 null。
const materializeDoc = ({ root, branch, path }) => {
  if (!root || !branch || !path) return null
  const show = spawnSync('git', ['-C', root, '-c', 'core.quotepath=off', 'show', `${branch}:${path}`], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  if (show.status !== 0) return null
  const dir = mkdtempSync(join(tmpdir(), 'lark-followup-'))
  const file = basename(path)
  writeFileSync(join(dir, file), show.stdout)
  return { dir, file }
}

const publishFollowUpDoc = async ({ task, profile, deps }) => {
  if (!task.followUpDoc) return null
  const doc = (deps.materializeDoc || materializeDoc)({ root: profile.root, branch: task.branch, path: task.followUpDoc })
  if (!doc) {
    console.warn(`[lark-gateway] ${task.id} 待确认清单 ${task.followUpDoc} 在分支 ${task.branch} 里取不到`)
    return null
  }
  try {
    const title = basename(task.followUpDoc).replace(/\.md$/i, '')
    const created = await (deps.createLarkDoc || createLarkDocFromMarkdown)({ title, dir: doc.dir, file: doc.file })
    if (!created.ok) {
      console.error(`[lark-gateway] ${task.id} 待确认清单建云文档失败：${created.reason}`)
      return null
    }
    return created.url
  } finally {
    if (!deps.materializeDoc) rmSync(doc.dir, { recursive: true, force: true })
  }
}

// 群里有人直接 @ 负责人：收到就先在群里回一句，再去分类干活（aven 2026-10-13：不能静默）。
export const ACK_TEXT = `收到，我查一下，稍后回复。\n${SIGNATURE}`
export const mentionsMe = ({ profile, mentions = [] }) => {
  const me = new Set([...(profile?.ownership?.meOpenIds || []), ...(profile?.taskMentionOpenIds || [])])
  return mentions.some((mention) => me.has(mention?.id))
}
export const deliverRepoAck = async ({ task, deps = {} }) => {
  const profile = repoProfileForTask(task)
  if (!profile || profile.isDefault || !profile.chatIds.includes(task.chatId)) return { ok: false, skipped: true }
  const webhook = deps.webhookFor ? deps.webhookFor(profile, task.chatId) : resolveWebhookCredentials(profile, task.chatId)
  if (!webhook) return { ok: false, skipped: true, reason: 'no webhook' }
  return (deps.sendWebhookMessage || sendWebhookMessage)({ ...webhook, text: ACK_TEXT, logPrefix: `repo ack ${task.id}` })
}

// 已在群里回过「收到」、最后却判断不用处理：私聊负责人一句，别让人以为 bot 死了。
export const deliverRepoIgnoredAfterAck = async ({ task, deps = {} }) => {
  const profile = repoProfileForTask(task)
  if (!profile || profile.isDefault || !profile.notifyChatId) return { ok: false, skipped: true }
  const c = task.intake?.classification || {}
  const head = (task.summary || task.text || '').split('\n')[0].slice(0, 60)
  const markdown = `🤔 群里 @你 的这条我看了，判断不用我处理（${chatLabel(profile, task.chatId)}）：${head}\n理由：${c.reason || c.summary || '未给出'}\n判错了就回「继续任务 ${task.id} 做」。`
  return (deps.sendMarkdown || sendBotMarkdown)({ chatId: profile.notifyChatId, markdown, logPrefix: `repo ignored-after-ack ${task.id}` })
}

// 任务开始：负责人私聊一行。
export const deliverRepoStart = async ({ task, deps = {} }) => {
  const profile = repoProfileForTask(task)
  if (!profile || profile.isDefault || !profile.notifyChatId) return { ok: false, skipped: true }
  const send = deps.sendMarkdown || sendBotMarkdown
  return send({ chatId: profile.notifyChatId, markdown: buildRepoStartNote({ task, profile }), logPrefix: `repo start ${task.id}` })
}

// 任务结束：done → 群里一句（webhook）+ 私聊一条；其它终态 / 挂起 → 只私聊一条。返回私聊的 messageId 供登记回执。
export const deliverRepoOutcome = async ({ task, status, result, deps = {} }) => {
  const profile = repoProfileForTask(task)
  if (!profile || profile.isDefault) return { ok: false, skipped: true }
  const send = deps.sendMarkdown || sendBotMarkdown
  const sendHook = deps.sendWebhookMessage || sendWebhookMessage
  const mentions = status === 'done' ? resolveMentions({ followUps: task.followUps || [], ownerMap: profile.ownerMap }) : []
  let docUrl = null
  let groupOutcome = null
  // 代答提问没答案（groupReply 空）就不回群，只私聊负责人。
  if (status === 'done' && profile.chatIds.includes(task.chatId) && !(task.commandType === 'status' && !task.groupReply)) {
    docUrl = await publishFollowUpDoc({ task, profile, deps })
    const text = buildRepoGroupText({ task, mentions, docUrl })
    const webhook = deps.webhookFor ? deps.webhookFor(profile, task.chatId) : resolveWebhookCredentials(profile, task.chatId)
    if (!webhook) {
      groupOutcome = { ok: false, reason: `${chatLabel(profile, task.chatId)} 还没配 webhook`, text }
    } else {
      const sent = await sendHook({ ...webhook, text, logPrefix: `repo group reply ${task.id}` })
      groupOutcome = sent.ok ? { ok: true, text } : { ok: false, reason: `发送失败：${sent.reason}`, text }
    }
  }
  const note = buildRepoNote({ task, status, profile, result, docUrl, groupOutcome, mentions })
  const to = profile.notifyChatId || task.chatId
  const sent = await send({ chatId: to, markdown: note, logPrefix: `repo outcome ${task.id} ${status}` })
  return { ok: sent.ok, reason: sent.reason, messageId: sent.messageId || null, to, note, groupOutcome, docUrl }
}
