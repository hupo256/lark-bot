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

import { rmSync } from 'node:fs'
import { basename, join } from 'node:path'

import { materializeDoc } from './lark-git-read.mjs'

import { sendBotMarkdown } from './lark-cli.mjs'
import { isProbablyDoneResult } from './lark-failure-evidence.mjs'
import { createLarkDocFromMarkdown, overwriteLarkDocFromMarkdown } from './lark-docs.mjs'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { larkRuntimeDir } from './lark-paths.mjs'
import { resolveMentions } from './lark-group-reply.mjs'
import { isPrivateOnlyChat, repoProfileForChat, repoProfileForTask, resolveWebhookCredentials } from './lark-repo-profile.mjs'
import { sendWebhookMessage } from './lark-webhook.mjs'
import { keepGroupTextShort, publishMarkdownDoc } from './lark-detail-doc.mjs'
import { localHHMM, recordOutbox, shouldSend } from './lark-outbox.mjs'
import { findGroupReplyContradiction } from './lark-completion-rule.mjs'
import { renderReport } from './lark-report-render.mjs'
import { clearHeldDraft, heldDraftFor, listOverdueObligations, markOverdueNotified, noteAck, noteAnswer, noteHeld, noteOwed } from './lark-reply-obligation.mjs'
import { isSweepTask, sweepPushHint } from './lark-daily-sweep.mjs'

// 署名放卡片 note（灰色小字），正文里不出现（aven 2026-10-13）。
export const SIGNATURE = '由 aven 的助手整理'

export const isHumanDeliveryTask = (task) => {
  const profile = task ? repoProfileForTask(task) : null
  return Boolean(profile && !profile.isDefault)
}

// 结构化结果文案（「已完成。\n1. …\n2. 判定：…」）→ 人话段落：去掉定型首行、编号与机器口径的行。
// 「，待发布」是 10-22 前的旧首行（发布不归开发，aven 2026-10-22），历史任务里还有，照样认。
const RESULT_HEADERS = /^(已完成(（有验证提醒）)?(，待发布)?。?|查询完成。?|无需改动。?|处理失败。?|已阻塞，需外部材料.*|需人工确认.*才能继续。?|需人工复核.*)$/
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

// 结果文案里的「待补充：a；b」→ 条目数组（阻塞 / 待确认时要给群里 @ 的内容）。
export const extractBlockers = (result) => {
  const line = humanizeResult(result, { maxLines: 20 }).find((item) => item.startsWith('待补充：'))
  return line ? line.slice(4).split(/[；;]\s*/).map((item) => item.trim()).filter(Boolean) : []
}

// 阻塞 / 缺材料时群里那段：@ 责任人 + 卡在什么 + 要什么（整改 #12：最该 @ 后端的事不能只私聊负责人）。
// 内部分工（归属 / 负责人 / 不归 aven）不是对方能帮的事，不进群里的「需要你们帮忙」；只留真正要对方提供的材料。
// 内部名单来自 profile.memberRoles（角色含「前端」的同事 + 负责人本人），不再写死人名（第 3 批）。
const INTERNAL_WORDS = /归属|负责人|不归|分工|前端同事/i
// 我方工具 / 环境故障（读不到 Lark 文档、lark-cli、授权、凭证、Worker）也不是对方能帮的事，只私聊负责人
//（10-22 Bug-4944：把半截云文档链接当「需要你们帮忙」@ 了后端，链接谁都打不开）。
const TOOL_FAILURE_WORDS = /Lark 文档读取失败|读不到.{0,6}文档|lark-cli|授权|凭证|Worker|链接不完整/i
export const internalNamePattern = (profile) => {
  const names = Object.entries(profile?.memberRoles || {}).filter(([, role]) => /前端/.test(String(role))).map(([name]) => name)
  const me = [profile?.ownership?.me, ...(profile?.ownership?.meAliases || [])].filter(Boolean)
  const all = [...names, ...me].map((name) => String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return all.length ? new RegExp(all.join('|'), 'i') : null
}
export const externalBlockers = (blockers = [], { profile = null } = {}) => {
  const names = internalNamePattern(profile)
  return blockers.filter((item) => !INTERNAL_WORDS.test(String(item)) && !TOOL_FAILURE_WORDS.test(String(item)) && !(names && names.test(String(item))))
}

// 要材料时 @ 谁：负责人 + 待补充里点名的外部同事（ownerMap 里有、不是前端同事 / 负责人本人）；都没有就 @ 发起人。
// 10-22 真机：intake 没定负责人，「要 William、Encone 或测试 HTStone.z 给一个…」一个都没 @，当事人看不到不会补。
const nameIn = (text, name) => new RegExp(`(?<![A-Za-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'i').test(text)
export const blockedAskMentions = ({ task, profile, blockers = [] }) => {
  const ownerMap = profile?.ownerMap || {}
  const internal = internalNamePattern(profile)
  const me = new Set(profile?.ownership?.meOpenIds || [])
  const text = blockers.join('\n')
  const named = Object.keys(ownerMap).filter((name) => !(internal && internal.test(name)) && nameIn(text, name)).map((owner) => ({ owner, items: blockers }))
  const owners = task?.owner ? [{ owner: task.owner, items: blockers }] : []
  const out = resolveMentions({ followUps: [...owners, ...named], ownerMap }).filter((m) => !me.has(m.openId))
  if (out.length) return out
  const operator = groupAddressee({ task, profile })
  if (!operator || !/^ou_/.test(operator) || me.has(operator)) return []
  const hit = Object.entries(ownerMap).find(([, id]) => id === operator)
  return [{ owner: hit ? hit[0] : null, openId: operator, items: blockers }]
}

export const buildRepoBlockedGroupText = ({ task, mentions = [], blockers = [] }) => {
  const head = taskHeadline(task)
  // 发起人不在 ownerMap 里（没名字）：直接写 at 标签，buildGroupCard 不再替换。
  const who = mentions.length ? `${mentions.map((m) => (m.owner ? `@${m.owner}` : `<at id=${m.openId}></at>`)).join(' ')} ` : ''
  const lines = [`${who}「${head}」这边卡住了，需要你们帮忙：`]
  for (const item of blockers.slice(0, 6)) lines.push(`- ${item}`)
  if (!blockers.length) lines.push('- 具体缺什么见 aven 稍后补充')
  return lines.join('\n')
}

const takeLine = (lines, prefix) => {
  const index = lines.findIndex((line) => line.startsWith(prefix))
  if (index < 0) return null
  const [line] = lines.splice(index, 1)
  return line.slice(prefix.length).trim()
}

// 任务一句话标题：文件消息（正文是「群内任务」占位）用文件名。
// 负责人私聊指示任务：标题一律用被锚的群消息（privateOrigin.anchorHead）——summary / text 里是 aven 的私聊原话，
// 会被 buildRepoBlockedGroupText 引进外部群（aven 2026-10-20 review C1）。
// 引用上下文只概括（aven 2026-10-22）：取第一个分句，不按字数硬截（原来截 40 字，常切在半句中间）。
const firstClause = (text) => String(text || '').split('\n')[0].split(/[：:。；;]/)[0].trim()
const taskHeadline = (task) => {
  if (task.report?.subject) return task.report.subject
  if (task.privateOrigin) return firstClause(task.privateOrigin.anchorHead)
  const doc = (task.attachments || []).find((item) => item?.type === 'file' && item.fileName)
  const raw = (task.summary || task.text || '').split('\n')[0]
  return /^群内任务$|^api：群里发来对接文档/.test(raw) && doc ? doc.fileName : firstClause(raw)
}
const chatLabel = (profile, chatId) => profile?.chatNameById?.[chatId] || chatId

// 群里那段话（纯 Markdown，@ 写成「@名字」，发送时再换成 at 标签）：done 一句 ✅；有待跟进 → @ 负责人 + 链接 + 每人一行。
// 模型偶尔把署名抄进正文（它在上下文里见过群里的卡片）：署名只在卡片 note 里出现，正文里的一律剥掉。
// 正文只认 groupReply，绝不回落 summary / text（aven 2026-10-20 review C1/C2）：summary 是对方原话或负责人私聊原话，
// 回落的结果是群里「✅ + 对方原话」、或把 aven 的私聊指示发进外部群。groupReply 为空返回空串，调用方不发群。
const stripSignature = (text) => String(text || '').split('\n').filter((line) => !/由\s*\S+\s*的助手整理/.test(line)).join('\n').trim()

// 有结构化 report（10-21 P6）就按它渲染；没有走旧的自由文本 groupReply（过渡期，P7 删）。
export const buildRepoGroupText = ({ task, mentions = [], docUrl = null }) => {
  const reply = task.report ? renderReport(task.report) : stripSignature(task.groupReply || '')
  if (!reply) return ''
  // 代答提问：答案本身，不带 ✅。
  if (task.contract ? task.contract.deliverable === 'answer' : task.commandType === 'status') return reply
  // 正文里已经有逐项状态（⚠️ / ❌）时，行首不再加 ✅，否则「✅ … 没通 1 项」自相矛盾。
  if (!mentions.length) return /⚠️|❌/.test(reply) ? reply : `✅ ${reply}`
  const who = mentions.map((m) => `@${m.owner}`).join(' ')
  const bullets = mentions.filter((m) => m.items.length).map((m) => `- ${m.owner}：${m.items.slice(0, 4).join('；')}${m.items.length > 4 ? '…' : ''}`)
  return [`${who} ${reply}`, docUrl ? `待确认的几点在这里：${docUrl}` : null, ...bullets].filter(Boolean).join('\n')
}

// 群消息用卡片发（webhook interactive）：正文 markdown + 灰色 note 署名；@ 名字换成 at 标签。
export const buildGroupCard = ({ body, mentions = [] }) => {
  let content = String(body || '')
  for (const m of mentions) {
    if (m.openId) content = content.split(`@${m.owner}`).join(`<at id=${m.openId}></at>`)
  }
  // 同一个人连着 @ 两次（行首 addressTo 的发消息人 + 待跟进 @ 的负责人是同一人）只留一个（2026-10-15 真机：「@Ache @Ache Ache 回复复测」）。
  content = content.replace(/(<at id=(ou_\w+)><\/at>)(?:\s*<at id=\2><\/at>)+/g, '$1')
  return {
    config: { wide_screen_mode: true },
    elements: [
      { tag: 'markdown', content },
      { tag: 'note', elements: [{ tag: 'plain_text', content: SIGNATURE }] },
    ],
  }
}

// 负责人私聊那条：状态符号 + 人话结论 + 分支 / 文件数 + 群里发没发 + 待确认清单链接。
export const buildRepoNote = ({ task, status, profile, result, docUrl = null, groupOutcome = null, mentions = [] }) => {
  // 日报清扫的结论是逐条清单，不截成 6 行。
  const sweep = isSweepTask(task)
  const lines = humanizeResult(result, { maxLines: sweep ? 40 : 6 })
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
    if (sweep && sweepPushHint(task)) out.push(sweepPushHint(task))
    else if (task.integration?.mergedBack === true) out.push(`已合进 ${task.integration.branch}，你合这一条分支就够`)
    else if (task.integration?.mergedBack === false) out.push(`⚠ 没合进 ${task.integration.branch}：${task.integration.mergeReason}。分支 ${task.branch} 要你手动合`)
    else if (task.integration && task.integration.synced === false) out.push(`⚠ 集成分支没同步上你的分支（${task.integration.syncReason}），这条是从 ${task.integration.branch === task.branch ? '基线' : '你的工作分支'} 开的`)
    if (mentions.length) out.push(`要 ${mentions.map((m) => m.owner).join('、')} 跟进${docUrl ? `：${docUrl}` : '（清单在分支里的 ' + (task.followUpDoc || '待确认文档') + '）'}`)
  } else if (status === 'no_change_needed') {
    out.push(`ℹ️ 看过了，不用改${where}：${body || head}`)
  } else if (status === 'failed') {
    // 有完成旁证（自愈环 1.6）：不说「没做成」，说「可能做成了但没拿到结果」，人先去群里核对。
    out.push(isProbablyDoneResult(result) ? `⚠ 可能做成了、但没拿到结果文件${where}：${body || head}` : `⛔ 没做成${where}：${body || head}`)
    if (nextStep) out.push(nextStep)
  } else {
    out.push(`⏸ 停下来了${where}：${body || head}`)
    if (blockers) out.push(`要：${blockers}`)
    out.push('回复这条消息把材料补上就会继续。')
  }
  for (const note of task.ownerNotes || []) out.push(`⚠ ${note}`)
  if (groupOutcome) {
    if (groupOutcome.missingReply) out.push('这条没写群回复，群里没发。')
    else if (groupOutcome.ok) out.push(`群里已回：「${groupOutcome.text.split('\n')[0].trim()}」`)
    else if (groupOutcome.held) out.push(`群里没发（${groupOutcome.reason}）。没问题就回「就这样回」，我按原文发群：\n${groupOutcome.text}`)
    else if (groupOutcome.text) out.push(`群里没发（${groupOutcome.reason}），要回可以转发这段：\n${groupOutcome.text}`)
  }
  // 群里回过「收到」、这次结论没发出去（没做成 / 发送失败）：如实说群里实际只有那句收到（10-23 #79 改写，不再说「不会再补话」）。
  if (task.ackedInGroup && !groupOutcome?.ok && !groupOutcome?.held && !groupOutcome?.privateOnly) out.push(`群里只回过「${trimPunct(task.ackReply || '收到').slice(0, 60)}」，结论还没发到群里。`)
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

// 从分支里取出待确认清单：异步 git show（lib/lark-git-read.mjs），不再 spawnSync 卡 gateway。
// 待确认清单的云文档按主题复用（整改 #13）：同一主题（task.topic，缺省用文件名去掉日期）只建一份，之后整篇覆盖更新。
// 登记表：runtime/lark-followup-docs/<repo>.json → { [topicKey]: { documentId, url, title, updatedAt } }。
export const followUpTopicKey = (task) => {
  const topic = String(task.topic || '').trim()
  if (topic) return topic
  return basename(task.followUpDoc || '').replace(/\.md$/i, '').replace(/-?\d{4}-\d{2}-\d{2}$/, '')
}
// 登记表目录：deps.docRegistryDir > LARK_FOLLOWUP_DOCS_DIR > 真实 runtime；node --test 子进程里没指定就不落盘（null），
// 同发件簿的做法——10-20 发现单测把假文档 {"x":{"url":"https://doc/2"}} 写进了 falive 实例的真实登记表（aven 2026-10-20 review）。
export const resolveDocRegistryDir = (deps = {}) => {
  if (deps.docRegistryDir) return deps.docRegistryDir
  if (process.env.LARK_FOLLOWUP_DOCS_DIR) return process.env.LARK_FOLLOWUP_DOCS_DIR
  if (process.env.NODE_TEST_CONTEXT) return null
  return join(larkRuntimeDir, 'lark-followup-docs')
}
const loadDocRegistry = (dir, repo) => {
  if (!dir) return {}
  const file = join(dir, `${repo}.json`)
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  } catch {
    return {}
  }
}
const saveDocRegistry = (dir, repo, registry) => {
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${repo}.json`), `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 })
}

const publishFollowUpDoc = async ({ task, profile, deps }) => {
  if (!task.followUpDoc) return null
  // 合回集成分支后任务分支已删：按合并那一刻的提交读，内容不随集成分支前移（aven 2026-10-20 review C7）。
  const ref = task.integration?.mergedSha || task.branch
  const doc = await (deps.materializeDoc || materializeDoc)({ root: profile.root, branch: ref, path: task.followUpDoc })
  if (!doc) {
    console.warn(`[lark-gateway] ${task.id} 待确认清单 ${task.followUpDoc} 在 ${ref} 里取不到`)
    return null
  }
  try {
    const title = basename(task.followUpDoc).replace(/\.md$/i, '')
    const registryDir = resolveDocRegistryDir(deps)
    const registry = loadDocRegistry(registryDir, profile.key)
    const key = followUpTopicKey(task)
    const existing = registry[key]
    if (existing?.documentId) {
      const updated = await (deps.overwriteLarkDoc || overwriteLarkDocFromMarkdown)({ documentId: existing.documentId, dir: doc.dir, file: doc.file })
      if (updated.ok) {
        registry[key] = { ...existing, title, updatedAt: new Date().toISOString() }
        saveDocRegistry(registryDir, profile.key, registry)
        console.log(`[lark-gateway] ${task.id} 待确认清单已更新同主题云文档（${key}）`)
        return existing.url
      }
      console.warn(`[lark-gateway] ${task.id} 更新同主题云文档失败，改为新建：${updated.reason}`)
    }
    const created = await (deps.createLarkDoc || createLarkDocFromMarkdown)({ title, dir: doc.dir, file: doc.file })
    if (!created.ok) {
      console.error(`[lark-gateway] ${task.id} 待确认清单建云文档失败：${created.reason}`)
      return null
    }
    registry[key] = { documentId: created.documentId, url: created.url, title, updatedAt: new Date().toISOString() }
    saveDocRegistry(registryDir, profile.key, registry)
    return created.url
  } finally {
    if (!deps.materializeDoc) rmSync(doc.dir, { recursive: true, force: true })
  }
}

// 群里有人直接 @ 负责人：收到就先在群里回一句，再去分类干活（aven 2026-10-13：不能静默）。
export const ACK_TEXT = '收到，我查一下，稍后回复。'

// 「收到」用固定句（第 1 批）：原来在 gateway 里起一次 claude 写场景化一句（40s 超时），是 gateway 内唯一的 LLM 调用；
// 场景化的回应改由分类结果的 reply 字段在 deliverRepoNoted 里带出，gateway 不再跑模型。

// 群里的回应要对着人说：行首 @ 发消息的人（webhook 发不了「回复某条消息」，这是最接近的形式），再引一句原话。
const trimPunct = (text) => String(text || '').trim().replace(/[。.！!；;，,\s]+$/, '')
export const addressTo = ({ task, body, quote = null, openId = null }) => {
  const target = openId || task?.operator
  const at = target && /^ou_/.test(target) ? `<at id=${target}></at> ` : ''
  const q = quote ? `\n> ${trimPunct(quote).slice(0, 60)}` : ''
  return `${at}${body}${q}`
}
// 负责人转交别人的对接答复（发起人是负责人、分类 api_reply）：结论对着答复人说——@ 话题里最后发言的非负责人；没有就照旧 @ 发消息的人（教训 #41）。
export const groupAddressee = ({ task, profile }) => {
  const me = new Set(profile?.ownership?.meOpenIds || [])
  if (task?.fromPrincipal && task.intake?.classification?.decision === 'api_reply') {
    const replier = [...(task.threadSpeakers || [])].reverse().find((id) => /^ou_/.test(id) && !me.has(id))
    if (replier) return replier
  }
  return task?.operator
}
// 认 @Aven.Bot：先按网关启动时查到的 open_id；id 不认识但被 @ 的名字就是 botName 时按名字认，并记住新 id（10-21）。
// 自定义机器人移出群再拉回来是新的机器人、新的 open_id，原来只在启动时查一次，重拉后 @ 它会被当成没 @、只记台账。
const compactName = (name) => String(name || '').replace(/\s+/g, '').toLowerCase()
export const mentionsBot = ({ profile, chatId, mentions = [] }) => {
  const id = profile?.botMentionOpenIds?.[chatId]
  if (id && mentions.some((mention) => mention?.id === id)) return true
  const botName = compactName(profile?.botName)
  const byName = botName && mentions.find((mention) => mention?.id && compactName(mention.name) === botName)
  if (!byName || !profile?.chatIds?.includes(chatId)) return false
  if (profile.botMentionOpenIds && profile.botMentionOpenIds[chatId] !== byName.id) {
    console.log(`[lark-gateway] repo ${profile.key} 群 ${chatId} 的 ${profile.botName} 按名字认出：${byName.id}（原 ${id || '无'}）`)
    profile.botMentionOpenIds[chatId] = byName.id
  }
  return true
}

// 群发统一出口（阶段 3 发件簿 + 阶段 5 出口闸）：发之前查发件簿（同主题同阶段 2 分钟 1 条、同内容 24 小时 1 次、
// 「收到」每人 2 分钟 1 次），拦下的记一条 gated 不发群、返回 { ok: false, gated }——拦下就是没发，调用方不得当已发
//（10-16 真机：拦下返回 ok:true，私聊告诉负责人「群里已回」，群里其实没发）；
// 发出去了就记进发件簿（对着谁、哪个主题、哪个阶段、说了什么）。
// 只私聊的群（profile.privateOnlyChats）：一律不发群、按拦下处理；done / blocked_ask 的原话由结果私聊带出，ack 私聊另有交代，
// 其余阶段（noted、日报请求回应等）把原话私发负责人。
const PRIVATE_ONLY_REPORTED_PHASES = new Set(['ack', 'done', 'blocked_ask'])
export const sendGroupCard = async ({ webhook, task = null, chatId = task?.chatId, phase, body: rawBody, mentions = [], to = task?.operator || null, logPrefix, sendHook = sendWebhookMessage, sendPrivate = sendBotMarkdown, createDoc }) => {
  // 群消息只放结论（aven 2026-10-22）：仍超长就整段转 Lark 文档、群里留第一行 + 链接；不截断，建不成原样发。
  const { text: body } = await keepGroupTextShort({ text: rawBody, title: `${task ? taskHeadline(task) || task.id : chatId}（完整内容）`, publish: (args) => publishMarkdownDoc({ ...args, ...(createDoc ? { create: createDoc } : {}) }) })
  const entry = { chatId, taskId: task?.id || null, topic: task?.topic || null, phase, to, mentions: mentions.map((item) => item.openId).filter(Boolean), text: body }
  const profile = repoProfileForChat(chatId)
  if (isPrivateOnlyChat(profile, chatId)) {
    const reason = `${chatLabel(profile, chatId)} 只私聊不发群`
    console.log(`[lark-gateway] ${logPrefix}：${reason}`)
    try { recordOutbox({ ...entry, gated: reason }) } catch { /* 记不上不影响 */ }
    if (!PRIVATE_ONLY_REPORTED_PHASES.has(phase) && profile.notifyChatId) {
      await sendPrivate({ chatId: profile.notifyChatId, markdown: `${reason}，原本要回群：\n${body}`, logPrefix: `${logPrefix} private-only` })
    }
    // privateOnly：调用方据此区分「只私聊的群、群里根本没发」和「出口闸刚对同一人发过」（ingest 的 ackedInGroup 该只认后者）。
    return { ok: false, gated: reason, reason, privateOnly: true }
  }
  let gate = { send: true }
  try { gate = shouldSend(entry) } catch { /* 闸出错不拦 */ }
  if (!gate.send) {
    console.log(`[lark-gateway] 出口闸拦下 ${logPrefix}：${gate.reason}`)
    try { recordOutbox({ ...entry, gated: gate.reason }) } catch { /* 记不上不影响 */ }
    return { ok: false, gated: gate.reason, reason: `出口闸拦下：${gate.reason}` }
  }
  const sent = await sendHook({ ...webhook, card: buildGroupCard({ body, mentions }), logPrefix })
  if (sent.ok) {
    try {
      recordOutbox(entry)
    } catch (error) {
      console.warn(`[lark-gateway] 发件簿记账失败（${phase} ${task?.id || chatId}）：${String(error?.message || error).slice(0, 120)}`)
    }
  }
  return sent
}

// @ 了机器人、最后判定不用处理：群里回一句「收到，记下了」，不能没下文。
export const deliverRepoNoted = async ({ task, deps = {} }) => {
  const profile = repoProfileForTask(task)
  if (!profile || profile.isDefault || !profile.chatIds.includes(task.chatId)) return { ok: false, skipped: true }
  const reply = trimPunct(task.intake?.classification?.reply || '')
  // 负责人私聊指示判为不用动手：有要回群的话（如礼貌拒绝）就对着原发送人回群；没有就只私聊一句。
  if (task.privateOrigin && !reply) {
    if (!profile.notifyChatId) return { ok: false, skipped: true }
    return (deps.sendMarkdown || sendBotMarkdown)({ chatId: profile.notifyChatId, markdown: `记下了，「${task.privateOrigin.anchorHead}」这条不用动手。`, logPrefix: `repo noted-private ${task.id}` })
  }
  const webhook = deps.webhookFor ? deps.webhookFor(profile, task.chatId) : resolveWebhookCredentials(profile, task.chatId)
  if (!webhook) return { ok: false, skipped: true, reason: 'no webhook' }
  const summary = trimPunct((task.intake?.classification?.summary || task.summary || '').split('\n')[0]).slice(0, 60)
  const body = reply ? `${reply}。` : `收到，记下了${summary ? `：${summary}` : ''}。`
  const sent = await sendGroupCard({ webhook, task, phase: 'noted', body: addressTo({ task, body }), logPrefix: `repo noted ${task.id}`, sendHook: deps.sendWebhookMessage || sendWebhookMessage, createDoc: deps.createLarkDoc, sendPrivate: deps.sendMarkdown || sendBotMarkdown })
  // 「记下了」就是这条的下文：之前回过「收到」的义务到此了结，不再到点私聊负责人（#74）。
  if (sent.ok) noteAnswer({ task, text: body })
  return sent
}

// reply：分类器按上下文写的那句（教训 #57），有就用它当「收到」；没有用固定句并点明接的哪条。
export const deliverRepoAck = async ({ task, reply = null, deps = {} }) => {
  const profile = repoProfileForTask(task)
  if (!profile || profile.isDefault || !profile.chatIds.includes(task.chatId)) return { ok: false, skipped: true }
  // 负责人私聊指示：群里不回「收到」（群里没人在等），私聊一句点明挂到了哪条群消息上，锚错了他能立刻纠正。
  if (task.privateOrigin) {
    if (!profile.notifyChatId) return { ok: false, skipped: true }
    const markdown = `收到，当作对「${task.privateOrigin.anchorHead}」（${chatLabel(profile, task.chatId)}）这条的指示处理。不是这条就回「取消任务 ${task.id}」。`
    return (deps.sendMarkdown || sendBotMarkdown)({ chatId: profile.notifyChatId, markdown, logPrefix: `repo ack-private ${task.id}` })
  }
  const webhook = deps.webhookFor ? deps.webhookFor(profile, task.chatId) : resolveWebhookCredentials(profile, task.chatId)
  if (!webhook) return { ok: false, skipped: true, reason: 'no webhook' }
  // 默认锚点（阶段 4）：点明接的是哪句，锚错了对方一句话就能纠正。
  const said = trimPunct(reply).slice(0, 80)
  const body = said ? `${said}。` : task.anchor?.at ? `${ACK_TEXT.replace(/[。.]$/, '')}（接着 ${localHHMM(task.anchor.at)} 那条）。` : ACK_TEXT
  const sent = await sendGroupCard({ webhook, task, phase: 'ack', body: addressTo({ task, body }), logPrefix: `repo ack ${task.id}`, sendHook: deps.sendWebhookMessage || sendWebhookMessage, createDoc: deps.createLarkDoc, sendPrivate: deps.sendMarkdown || sendBotMarkdown })
  if (sent.ok) noteAck({ task, text: body })
  return sent
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

// 这次的回答发不发群（10-21 P3：核验闸只管改动能不能提交，不再连带把回答丢掉）。纯函数，返回 { mode: post | hold | none, reason }：
//   · groupSilent（执行侧显式判群里无事可说）→ none；
//   · done / no_change_needed → post（没写回复的由调用方按「没写群回复」处理）；
//   · 其它终态写了回复：交付的不是代码改动（复测 / 回答 / 文档入库，见任务契约）且只是改动没提交 → post，回答不依赖提交；
//     否则 hold——没做成的事不能当结论发出去，原文私聊负责人，回「就这样回」再发；
//   · 其它终态没写回复 → none（阻塞要材料另有出口）。
export const decideGroupReply = ({ task, status }) => {
  if (task.payload?.groupSilent) return { mode: 'none', reason: '执行侧判群里无事可说' }
  if (status === 'done' || status === 'no_change_needed') return { mode: 'post', reason: null }
  if (!task.groupReply && !task.report) return { mode: 'none', reason: null }
  const answerLike = Boolean(task.contract && task.contract.deliverable !== 'change')
  if (answerLike && task.change?.committed === false) return { mode: 'post', reason: null }
  const why = task.change?.committed === false ? `改动没提交（${task.change.gate || '?'}：${task.change.reason || ''}）` : `任务没做成（${status}）`
  return { mode: 'hold', reason: `${why}，回答先给你看` }
}

// 任务结束：done、或 no_change_needed 写了群回复 → 群里一句（webhook）+ 私聊一条；其它终态 / 挂起 → 只私聊一条。返回私聊的 messageId 供登记回执。
// no_change_needed 原来一律不发群：复测「后端修好了、前端不用改」写好了群回复也被扣下，群里只剩兜底「拿不准」（教训 #56）。
export const deliverRepoOutcome = async ({ task, status, result, deps = {} }) => {
  const profile = repoProfileForTask(task)
  if (!profile || profile.isDefault) return { ok: false, skipped: true }
  const send = deps.sendMarkdown || sendBotMarkdown
  const sendHook = deps.sendWebhookMessage || sendWebhookMessage
  const inGroup = profile.chatIds.includes(task.chatId)
  const webhook = inGroup ? (deps.webhookFor ? deps.webhookFor(profile, task.chatId) : resolveWebhookCredentials(profile, task.chatId)) : null
  const noWebhook = () => ({ ok: false, reason: `${chatLabel(profile, task.chatId)} 还没配 webhook` })
  const sentOutcome = (sent, text) => (sent.ok ? { ok: true, text } : { ok: false, gated: Boolean(sent.gated), reason: sent.gated ? sent.reason : `发送失败：${sent.reason}`, text })
  const mentions = status === 'done' ? resolveMentions({ followUps: task.followUps || [], ownerMap: profile.ownerMap }) : []
  let docUrl = null
  let groupOutcome = null
  const decision = decideGroupReply({ task, status })
  if (decision.mode !== 'none' && inGroup) {
    docUrl = await publishFollowUpDoc({ task, profile, deps })
    let text = buildRepoGroupText({ task, mentions, docUrl })
    // 细节（curl、复现步骤、逐项证据）放文档，群里只附链接；建不成就把细节原样接在后面，不丢（aven 2026-10-22）。
    if (text && task.detailDoc) {
      const detailUrl = await publishMarkdownDoc({ title: `${taskHeadline(task)}（细节）`, markdown: task.detailDoc, ...(deps.createLarkDoc ? { create: deps.createLarkDoc } : {}) })
      text = `${text}\n${detailUrl ? `详细见：${detailUrl}` : task.detailDoc}`
    }
    // 没写群回复（含代答提问没答案）、也没在群里答应过下文：不发群、不回落 summary，私聊负责人一句（aven 2026-10-20 review C2）。
    // 发群前最后一道：说「都完成」又列了没完成的问题、或「还剩 N 项」却列了不止 N 条 = 自相矛盾，不发群，交负责人改。
    // 结构化 report 由代码渲染，数字从条目算，不会自相矛盾，也不用正则去读（10-21 P6）；正则只查旧的自由文本。
    const contradiction = text && !task.report ? findGroupReplyContradiction(text, { verify: profile.verify, preChecks: task.preChecks, completionClaim: task.payload?.completionClaim || null }) : null
    // 群里回过「收到」、答应过下文的，没写回复也不放弃（10-23 #79）：worker 已续会话补写过一次，到这里还空 = 补写没成，
    // 把人话化的结论作为草稿私聊负责人（held），回「就这样回」发群；没答应过的照旧不发。
    const draft = !text && task.ackedInGroup ? humanizeResult(result, { maxLines: 3 }).join('\n') : ''
    if (draft) {
      groupOutcome = { ok: false, held: true, reason: '执行器没写群回复，补写也没成', text: draft, mentions }
    } else if (!text) {
      groupOutcome = { ok: false, missingReply: true, reason: '没写群回复', text: '' }
    } else if (decision.mode === 'hold') {
      groupOutcome = { ok: false, held: true, reason: decision.reason, text, mentions }
    } else if (contradiction) {
      console.warn(`[lark-gateway] ${task.id} 群回复自相矛盾（${contradiction}），不发群`)
      // held：负责人看过回「就这样回」可按原文放出去（deliverHeldGroupReply），不用重跑。
      groupOutcome = { ok: false, held: true, reason: contradiction, text, mentions }
    } else if (!webhook) {
      groupOutcome = { ...noWebhook(), text }
    } else {
      // 待跟进里已经 @ 了要对着说的人（负责人就是他）→ 不再在行首重复 @ 他。
      const addressee = groupAddressee({ task, profile })
      const alreadyAddressed = mentions.some((m) => m.openId && m.openId === addressee)
      const sent = await sendGroupCard({ webhook, task, phase: 'done', body: (task.addressedToBot || task.ackedInGroup) && !alreadyAddressed ? addressTo({ task, body: text, openId: addressee }) : text, mentions, logPrefix: `repo group reply ${task.id}`, sendHook, createDoc: deps.createLarkDoc })
      groupOutcome = sentOutcome(sent, text)
    }
  }
  // 阻塞 / 缺材料：群里 @ 责任人要材料（没 webhook 就只私聊并附要发的话）。
  // 交办时已说明在等什么（task.waitsFor）：不往群里要材料，对方会自己发；只私聊负责人。
  if (['blocked', 'waiting_confirmation'].includes(status) && inGroup && !task.suspected && !task.waitsFor && externalBlockers(extractBlockers(result), { profile }).length) {
    const blockers = externalBlockers(extractBlockers(result), { profile })
    const askMentions = blockedAskMentions({ task, profile, blockers })
    const text = buildRepoBlockedGroupText({ task, mentions: askMentions, blockers })
    if (!webhook) groupOutcome = { ...noWebhook(), text }
    else groupOutcome = sentOutcome(await sendGroupCard({ webhook, task, phase: 'blocked_ask', body: text, mentions: askMentions, logPrefix: `repo blocked ask ${task.id}`, sendHook, createDoc: deps.createLarkDoc }), text)
  }
  // 回复义务（10-21 P5）：发出去了 → 答复；扣下 → 存草稿等负责人放行；回过「收到」却没结论 → 记欠着。群里不再补兜底话术。
  if (inGroup) {
    if (groupOutcome?.ok) noteAnswer({ task, text: groupOutcome.text })
    else if (groupOutcome?.held) noteHeld({ task, text: groupOutcome.text, mentions: groupOutcome.mentions || [], reason: groupOutcome.reason })
    else if (task.ackedInGroup) noteOwed({ task, status })
  }
  const note = buildRepoNote({ task, status, profile, result, docUrl, groupOutcome, mentions })
  // 没配 notifyChatId 就不发：原来回落 task.chatId，等于把给负责人的私聊（含原话、内部判断）发进外部群（aven 2026-10-20 review）。
  if (!profile.notifyChatId) {
    console.warn(`[lark-gateway] ${task.id} ${profile.key} 没配 notifyChatId，${status} 私聊不发`)
    return { ok: false, reason: 'no notifyChatId', messageId: null, to: null, note, groupOutcome, docUrl }
  }
  const to = profile.notifyChatId
  const sent = await send({ chatId: to, markdown: note, logPrefix: `repo outcome ${task.id} ${status}` })
  return { ok: sent.ok, reason: sent.reason, messageId: sent.messageId || null, to, note, groupOutcome, docUrl }
}

// 负责人放行被扣下的群回复（教训 #56 → 10-21 P5）：私聊回「就这样回 / 照发」时按原文发群，不再建任务重跑。
// 草稿存在回复义务上（同一条群消息只有一份）；扣下之后又有更新的结论发出去了就不放旧草稿。出口闸照常查。
export const deliverHeldGroupReply = async ({ task, deps = {} }) => {
  const held = heldDraftFor(task)
  const profile = repoProfileForTask(task)
  if (!held?.text || !profile || profile.isDefault || !profile.chatIds.includes(task.chatId)) return { ok: false, skipped: true }
  const webhook = deps.webhookFor ? deps.webhookFor(profile, task.chatId) : resolveWebhookCredentials(profile, task.chatId)
  if (!webhook) return { ok: false, reason: `${chatLabel(profile, task.chatId)} 还没配 webhook` }
  const mentions = Array.isArray(held.mentions) ? held.mentions : []
  const addressee = groupAddressee({ task, profile })
  const body = mentions.some((m) => m.openId && m.openId === addressee) ? held.text : addressTo({ task, body: held.text, openId: addressee })
  const sent = await sendGroupCard({ webhook, task, phase: 'done', body, mentions, logPrefix: `repo held reply ${task.id}`, sendHook: deps.sendWebhookMessage || sendWebhookMessage, createDoc: deps.createLarkDoc, sendPrivate: deps.sendMarkdown || sendBotMarkdown })
  if (sent.ok) {
    noteAnswer({ task, text: held.text })
    clearHeldDraft({ task })
  }
  return sent
}

// 答应了却迟迟没结论（执行器崩了 / 任务丢了）：私聊负责人一次，不发群（aven 10-21）。网关挂起巡检时顺带跑。
export const deliverOverdueObligations = async ({ profiles = [], now = Date.now(), sendPrivate = sendBotMarkdown }) => {
  let count = 0
  for (const profile of profiles) {
    if (!profile || profile.isDefault || !profile.notifyChatId) continue
    for (const item of listOverdueObligations({ chatIds: profile.chatIds || [], now })) {
      const taskId = item.taskIds?.at(-1) || item.id
      const markdown = `⏰ 群里答应过「${trimPunct(item.ackText || '收到').slice(0, 60)}」（${chatLabel(profile, item.chatId)}），4 小时了还没结论，任务可能没跑完。要重跑回「继续任务 ${taskId}」，不用管就忽略。`
      const sent = await sendPrivate({ chatId: profile.notifyChatId, markdown, logPrefix: `repo overdue ${item.id}` })
      if (sent?.ok) {
        markOverdueNotified({ chatId: item.chatId, id: item.id, now })
        count += 1
      }
    }
  }
  return count
}
