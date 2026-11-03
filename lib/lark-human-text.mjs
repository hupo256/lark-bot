/**
 * 对话层出口文案（计划 §4.1，aven 2026-11-01）：bot 在群里 / 私信里说的每一句都由这里的纯函数渲染，不套卡片模板。
 * 口径：群里一律回复原消息所以不引原话；结论先行、条目用符号；改码任务多一行「分支 · 改了 N 个文件」；
 * @ 人写成 `@名字`（发送前由 lark-group-exit.renderMentions 换成 post-md 的 <at user_id="ou_x">名</at>）。
 * 纯函数、零 IO；每格的字符串在 __tests__/lark-human-text.test.mjs 逐字钉住。
 */

import { renderReport } from './lark-report-render.mjs'

// ---- 基础件 ----

// post-md 的 @ 写法（dry-run 实测 markdown 被包成 post md 段）；没名字渲染成空名标签，Lark 侧照样能 @ 到。
export const mentionTag = (openId, name = '') => `<at user_id="${openId}">${name || ''}</at>`
const AT_TAG_RE = /<at user_id="(ou_[^"]*)">[^<]*<\/at> ?/g
// 同一个人 @ 两次只留第一个（falive 2026-10-15 真机：「@Ache @Ache Ache 回复复测」）：行首对着说的人 + 待跟进里的负责人是同一人时。
export const dedupeMentions = (text) => {
  const seen = new Set()
  return String(text || '').replace(AT_TAG_RE, (tag, openId) => {
    if (seen.has(openId)) return ''
    seen.add(openId)
    return tag
  })
}
// 对着人说：行首 @ 他。openId 不是 ou_ 的（群 id / 空）不加。
export const addressTo = ({ openId, name = '', body }) => (openId && String(openId).startsWith('ou_') ? `${mentionTag(openId, name)} ${body}` : String(body || ''))

export const trimPunct = (text) => String(text || '').trim().replace(/[。.！!；;，,\s]+$/, '')
// 第一个分句（第一行按 。；;！!？? 切），≤ 50 字：标题、引用概括用，不按字数硬截半句（aven 2026-10-22）。
export const firstClause = (text) => String(text || '').split('\n')[0].split(/[。；;！!？?]/)[0].trim().slice(0, 50)
// 第一句（保留句末标点）：群里结论第一行用，不限长。
export const firstSentence = (text) => {
  const line = String(text || '').split('\n').find((item) => item.trim())?.trim() || ''
  const match = line.match(/^.*?[。！？!?]/)
  return match ? match[0] : line
}

// 任务一句话标题：执行器写的对象（report.subject）> 负责人私聊指示锚的群消息（anchorHead，私信原话不进群，C1）> 摘要第一个分句。
export const headline = (task) => task?.outcome?.report?.subject || (task?.privateOrigin?.anchorHead ? firstClause(task.privateOrigin.anchorHead) : '') || firstClause(task?.summary || task?.text || '')

// 「分支 X · 改了 N 个文件」：缺哪项省哪项，都没有返回 ''。文件数先看结构化结果（outcome.changedFiles），再看任务上的。
export const changeFacts = (task) => {
  const files = task?.outcome?.changedFiles ?? task?.changedFiles
  const parts = []
  if (task?.branch) parts.push(`分支 ${task.branch}`)
  if (Array.isArray(files) && files.length) parts.push(`改了 ${files.length} 个文件`)
  return parts.join(' · ')
}

// 群的叫法：群名表 > 私信 > 入队时记下的群名 > 项目标题 > 项目号 > chatId（11-02 真机：通知里出现裸 oc_ id）。
export const chatLabel = (task, { chatNames = {} } = {}) => {
  const chatId = task?.chatId || ''
  if (chatNames?.[chatId]) return chatNames[chatId]
  if (chatId.startsWith('ou_') || task?.chatType === 'p2p' || task?.intake?.trigger === 'dm') return '私信'
  return task?.chatName || task?.projectTitle || task?.project || chatId
}

// 角色/关键词 → open_id 映射（从 lib/lark-cards.mjs 迁入，第 3 批删那边的副本）：AI 推断的 owner（如「产品」「QA」「设计」）命中配置表 config.ownerMap
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

// 旧文本结果（「已完成。\n1. …\n2. 判定：…」）→ 人话行：去掉定型首行、编号、加粗与机器口径的行。
// 只给没有 outcome 的旧任务兜底（第 3 批合入时在飞的任务回写缺 outcome）。「，待发布」是 10-22 前的旧首行，历史任务里还有，照样认。
const RESULT_HEADERS = /^(已完成(（有验证提醒）)?(，待发布)?。?|查询完成。?|无需改动。?|处理失败。?|已阻塞，需外部材料.*|需人工确认.*才能继续。?|需人工复核.*)$/
const MACHINE_LINES = /^(判定|分诊|依据|相关提交|失败类型|系统实测|Worker 终检|修改范围契约)[：:]/
export const humanizeLegacyResult = (text, { maxLines = 6 } = {}) => {
  const lines = String(text || '').split('\n').map((line) => line.trim()).filter(Boolean)
  const out = []
  let inContract = false
  for (const raw of lines) {
    if (RESULT_HEADERS.test(raw)) continue
    const line = raw.replace(/\*\*/g, '').replace(/^\d+[.、]\s*/, '').replace(/^[·•]\s*/, '')
    if (/^修改范围契约/.test(line)) {
      inContract = true
      continue
    }
    if (inContract && /^(契约目标|同因搜索词|排除的兄弟位置|纳入的兄弟位置|-\s|…另 \d+ 项)/.test(line)) continue
    inContract = false
    if (MACHINE_LINES.test(line)) continue
    out.push(line)
    if (out.length >= maxLines) break
  }
  return out
}

// ---- §4.1 各格 ----

const who = (mentions = []) => mentions.map((m) => (m.name ? `@${m.name}` : mentionTag(m.openId))).join(' ')

// ack：分类器按上下文写的那句（有就用它），没有用固定句。
export const sayAck = ({ reply }) => (trimPunct(reply) ? `${trimPunct(reply)}。` : '收到，我看一下，稍后回你。')
// noted：@ 了 bot 但不用处理——不能没下文。
export const sayNoted = ({ reply }) => (trimPunct(reply) ? `${trimPunct(reply)}。` : '收到，记下了。')
// start：只私信 aven。
export const sayStart = ({ task, chatLabel: where, resumeCount = null }) => (resumeCount ? `🛠 接着做（第 ${resumeCount} 次续跑）：${headline(task)}` : `🛠 开始做：${headline(task)}（${where}）`)

// done · change（群）：摘要首句 / 分支·文件数 / 待跟进每人一行 / 详细见链接。
export const sayDoneChangeGroup = ({ task, outcome, mentions = [], docUrl = null }) => {
  const lines = [firstSentence(outcome?.summary), changeFacts(task)]
  for (const m of mentions) if (m.items?.length) lines.push(`${m.name ? `@${m.name}` : mentionTag(m.openId)}：${m.items.join('；')}`)
  if (docUrl) lines.push(`详细见：${docUrl}`)
  return lines.filter(Boolean).join('\n')
}
// done · change（aven）：✅ 标题（群）· 事实，第二行群里发没发。
export const sayDoneChangePrincipal = ({ task, chatLabel: where, groupOutcome = null }) => {
  const facts = changeFacts(task)
  const lines = [`✅ ${headline(task)}（${where}）${facts ? `· ${facts}` : ''}`]
  if (groupOutcome?.ok) lines.push(`群里已回「${trimPunct(String(groupOutcome.text || '').split('\n')[0]).slice(0, 60)}」`)
  else if (groupOutcome?.held) lines.push(`群里没发（${groupOutcome.reason}）。没问题就回「就这样回」，我按原文发群。`)
  else if (groupOutcome?.reason) lines.push(`群里没发（${groupOutcome.reason}）。`)
  return lines.join('\n')
}
// done · answer / verification（群）：report 按条目渲染（不加 ✅）；report 空而 summary 有 → summary；有材料文档附链接。
export const sayDoneAnswerGroup = ({ outcome, docUrl = null }) => {
  const body = renderReport(outcome?.report) || outcome?.groupReply || outcome?.summary || ''
  if (!body) return ''
  return docUrl ? `${body}\n材料在这里：${docUrl}` : body
}
// done · answer（aven，仅他不是提单人时）。
export const sayDoneAnswerPrincipal = ({ chatLabel: where, firstLine }) => `💬 替你答了（${where}）：${firstLine}`
// no_change（群，仅 change 类）。
export const sayNoChangeGroup = ({ outcome }) => `看过了，这个不用改前端：${trimPunct(outcome?.summary)}。${outcome?.owner ? `要 ${outcome.owner} 看下。` : ''}`

// blocked_ask（群，change 类 + 有外部条目 + 有人可 @）：缺材料 → 需要你们帮忙；查到根因在对方 → 请处理。
export const sayBlockedAsk = ({ task, mentions = [], items = [], fixElsewhere = false }) => {
  const head = headline(task)
  const lead = `${who(mentions)}${mentions.length ? ' ' : ''}${head ? `「${head}」` : ''}${fixElsewhere ? '查到根因在你们那边，请处理：' : '需要你们帮忙：'}`
  return [lead, ...items.slice(0, 6).map((item) => `- ${item}`)].join('\n')
}

// held draft（aven）：停下来了 / 没做成 + 群里只回过「收到」+ 草稿（回「就这样回」才发群）。
export const sayHeldDraft = ({ task, chatLabel: where, status, outcome, ackText = null, draft = '' }) => {
  const lines = []
  if (status === 'failed') lines.push(`⛔ 没做成（${where}）：${outcome?.summary || headline(task)}`)
  else {
    lines.push(`⏸ 停下来了（${where}）：${headline(task)}`)
    if (outcome?.blockers?.length) lines.push(`要：${outcome.blockers.join('；')}`)
  }
  // 群里回过「收到」就如实说群里只有那句（falive 10-23 #79：不再说「不会再补话」）；没回过、也没草稿（私信发起 / 没人可 @）只报停下来了。
  const acked = ackText ? `群里只回过「${trimPunct(ackText).slice(0, 60)}」，结论还没发。` : ''
  if (draft) lines.push(`${acked}没问题就回「就这样回」，我把下面这段原样发群：`, draft)
  else if (acked) lines.push(acked)
  return lines.join('\n')
}
export const sayHeldReleased = ({ task }) => `已按原文回群（${headline(task)}）。`
export const sayHeldStale = ({ task }) => `「${headline(task)}」这条已经发过更新的结论了，没有待放行的草稿。`
export const sayHeldFailed = ({ reason }) => `没发出去：${reason}。`

// reminder r1（群，对提单人）/ r2（aven）。
// 11-02 复核：没有具体条目（旧任务没 outcome、blockers 空）时说「补材料」，不把 null 直接拼进群消息（「还在等你补：null。」）。
export const sayReminderGroup = ({ task, blocker, mentions = [] }) => `${who(mentions)}${mentions.length ? ' ' : ''}「${headline(task)}」${trimPunct(blocker) ? `还在等你补：${trimPunct(blocker)}。` : '还在等你补材料。'}补上回我一句就继续。`
export const sayReminderPrincipal = ({ task, chatLabel: where }) => `⏰ 「${headline(task)}」（${where}）等了 8 小时没人补材料，我不再催群里了。要关掉回「取消任务 ${task.id}」。`

// suspected（aven）/ 过期合并。
export const saySuspected = ({ task, chatLabel: where }) => `❓ 可能是你的事（${where}）：${headline(task)}\n是 → 回「继续任务 ${task.id} 做」；不是 → 回「取消任务 ${task.id}」。不回也不催，48 小时后自动关。`
export const saySuspectedExpired = ({ tasks = [], chatNames = {} }) => (tasks.length
  ? [`🧹 这 ${tasks.length} 条疑似 48 小时没人认领，已关掉：`, ...tasks.map((task) => `- ${headline(task)}（${chatLabel(task, { chatNames })}）`)].join('\n')
  : '')

// ignored-after-ack（aven）。
export const sayIgnoredAfterAck = ({ task, chatLabel: where, reason }) => `🤔 群里 @我 的这条看了，判断不用我处理（${where}）：${headline(task)}\n理由：${reason || '未给出'}\n判错了回「继续任务 ${task.id} 做」。`
// intake-failed（aven，11-03 R6）：分类器非瞬时失败——群里不承诺（挂着的「收到」撤掉），只私信他看一眼；intake_failed 不能「继续任务」，所以不给指令。
export const sayIntakeFailed = ({ task, chatLabel: where }) => `⛔ 这条我没分出来是什么事，你看下（${where}）：${headline(task)}`
// overdue（aven）：答应了 4 小时没结论。
export const sayOverdue = ({ task, chatLabel: where, ackText }) => `⏰ 群里答应过「${trimPunct(ackText || '收到').slice(0, 60)}」（${where}），4 小时了还没结论，任务可能没跑完。要重跑回「继续任务 ${task.id}」，不用管就忽略。`
// ops（aven）：原样，失败前加 ⛔。
export const sayOps = ({ text, failed = false }) => (failed ? `⛔ ${text}` : String(text || ''))
// failed · change（aven，群不发）：有完成旁证说「可能做成了」。
export const sayFailedPrincipal = ({ task, chatLabel: where, outcome, probablyDone = false }) => {
  const summary = outcome?.summary || headline(task)
  const lines = [probablyDone ? `⚠ 可能做成了、但没拿到结果（${where}）：${summary}` : `⛔ 没做成（${where}）：${summary}`]
  if (outcome?.nextStep) lines.push(outcome.nextStep)
  return lines.join('\n')
}

// digest（aven 09:30）：各组条目已是 { headline, chatLabel, time }；全空返回 ''（不发）。
const DIGEST_GROUPS = [['suspected', '疑似'], ['held', '扣下的群回复'], ['overdue', '答应了没结论'], ['parked', '等材料超 24h']]
export const sayDigest = ({ suspected = [], held = [], overdue = [], parked = [] }) => {
  const groups = { suspected, held, overdue, parked }
  const total = Object.values(groups).reduce((sum, items) => sum + items.length, 0)
  if (!total) return ''
  const lines = [`等你决定的 ${total} 条`]
  for (const [key, label] of DIGEST_GROUPS) {
    if (!groups[key].length) continue
    lines.push(`${label}：`, ...groups[key].map((item) => `- ${item.headline}（${item.chatLabel}）· ${item.time}`))
  }
  return lines.join('\n')
}
