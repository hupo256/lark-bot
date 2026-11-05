/**
 * 模拟局限旗标（judge-rules 用；P1 校准保真度报告 lark-bot-cal replay/falive/calibration/fidelity.md「判 lark-bot 基线时要标模拟局限的 case 类型」6 类 + 11-04 b2 的 sim_limit_ref）。
 * 每个旗标都是确定性规则（不花 token），带一句为什么，交给裁判 v3 看：差异来自这些就判 cause=sim_limit，实测类 / 控制台指示类判过程不判结论。
 *   sim_limit_ref         aven 的「继续任务 / 结单 / 结束 <id>」点名的任务在模拟里不存在（falive 当时自己建的）
 *   sim_limit_verify      1 实测类：回放打的是今天的环境，结论不和当时比，对照当时证据看测法与是否如实
 *   sim_limit_anchor      2 控制台私聊指示锚的是模拟里没有的任务（falive 当时锚到窗口前 / 组外任务），或依赖任务分支 / 合回状态（推 pre / 帮我合）
 *   sim_limit_edited      3 触发消息发出后被编辑过（原始 API update_time − create_time ≥ 2 秒）：falive 当时可能看到的是编辑前的版本
 *   sim_limit_timing      4 时序敏感：同一人 2 分钟内连发、同话题 10 分钟内接连补充——分单 / ack 去重随时序变，按整件事判
 *   sim_limit_falive_down 5 falive 当时的「收到」没发出去（ERR_SSL / 连接超时），或 worker 正在排空重启（不领新单）：falive 一侧没回 / 慢不作数
 *   sim_limit_memory      6 依赖记忆或 bug 表快照（bug 号复测、bug 表认领）：模拟里的记忆是近似版本，读 ~/.lark-bugpoll 是读到了今天的数据
 *   sim_limit_testdata    7 原话明确要造测试数据（lib/lark-task-contract requestsTestData）：线上放开 pre 用测试号建，回放的写拦截照拦
 *                         （「回放：真实写入已拦截」），软旗标：判过程——有没有用测试号在 pre 计划 / 尝试创建、有没有如实报「回放拦截、未创建」
 *   sim_limit_falive_ref  8 （11-05 b4 波 5）这条接的是 falive 当时自己发的话（回复 / 点名的 falive 卡，或没回复时紧挨着的上一张 falive 卡），
 *                         那张卡按事件组藏了（meta.hideBotIds），模拟 bot 在同会话里也没说过卡里那些事实（关键词覆盖 < 一半）：
 *                         冲着 bot 说、且问的就是那张卡（「这条消息 / 那两个 / 文档在哪 / 你测的 / 所以不是 bug」、≤12 字短句里的「这个 / 重跑」、空 @bot、
 *                         引了卡里原句、「确认扩大范围 / 就这样回」）→ 硬；否则软（sim_limit_falive_ref_soft）；跟人说的（cc @x）不算。
 *                         没藏的 falive 卡（组外任务的卡照供）只在「结束 / 继续 / 重跑这个任务」而卡上的任务模拟里没有时算（硬）
 *   sim_limit_external    9 （11-05）lark-bot 的结论 / 卡点是外部设计 / 文档源（Figma 等）在回放里读不到（出网拦截 / 没导出）：
 *                         任务因此 blocked → 硬，只是提到 → 软（sim_limit_external_soft）
 * 数据只读：replay/falive/raw（编辑时间）、~/Library/Logs/falive-lark/{gateway,worker}.log（没有就不出旗标 5，loadSimLimitSources().logs 记 false）、
 * sim 目录的 meta.json / outbox / egress.log（旗标 8、9）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { requestsTestData } from '../../lib/lark-task-contract.mjs'
import { BOT_MENTION_IDS, GROUPS, faliveLogDir, rawDir } from './falive-data.mjs'

export const SIM_LIMIT_PREFIX = 'sim_limit_'
export const EDIT_MIN_MS = 2000
export const BURST_MS = 2 * 60_000
export const THREAD_BURST_MS = 10 * 60_000
export const ANCHOR_LOOKBACK_MS = 12 * 60 * 60_000
const TASK_ID_RE = /\b(?:om_x[0-9a-f]{20,}|retest-[A-Za-z0-9-]+)/g

const readJson = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null } }

/** 原始 API（群历史 + 话题回复）里每条消息被编辑的时长：update_time − create_time，≥ EDIT_MIN_MS 才记（< 2 秒的是发出后服务端的处理，几乎每条都有）。 */
export const loadEditDelays = (dir = rawDir) => {
  const out = new Map()
  const add = (items) => {
    for (const it of items || []) {
      const delay = Number(it.update_time) - Number(it.create_time)
      if (it.message_id && it.updated && delay >= EDIT_MIN_MS) out.set(it.message_id, delay)
    }
  }
  for (const g of GROUPS) add(readJson(join(dir, `${g.key}.api.json`))?.data?.items)
  const threads = join(dir, 'threads')
  if (existsSync(threads)) for (const f of readdirSync(threads)) {
    if (!f.endsWith('.json')) continue
    const cached = readJson(join(threads, f))
    try { add(JSON.parse(cached?.api || '{}').data?.items) } catch { /* 没拉到 */ }
  }
  return out
}

/**
 * falive 当时自身的状态（日志没有时间戳，按行序）：
 *   gateway.log「<id> 回「收到」（…）：请求失败 / 连接失败」、「webhook attempt 3/3 failed」→ 这条的 ack 没发出去；
 *   worker.log「排空重启：磁盘代码 / 配置已更新…不再领新任务」起，到「测试红 / 自检红 / 取消排空」或重启后的「code=… startedAt=」止，其间出现的消息 id → 到达时 falive 在排空。
 */
export const parseFaliveDown = ({ gateway = '', worker = '' }) => {
  const out = new Map()
  const note = (id, why) => { if (!out.has(id)) out.set(id, why) }
  for (const line of gateway.split('\n')) {
    const ack = line.match(/(om_x[0-9a-f]{20,}) 回「收到」（[^）]*）：((?:请求失败|连接失败)[^\n]*)/)
    if (ack) { note(ack[1], `falive 的「收到」当时没发出去（${ack[2].replace(/（[^）]*）/g, '').slice(0, 60)}）`); continue }
    const final = line.match(/ack (om_x[0-9a-f]{20,}) webhook attempt 3\/3 failed: ([^\n]*)/)
    if (final) note(final[1], `falive 的「收到」三次都没发出去（${final[2].slice(0, 60)}）`)
  }
  // 排空窗口 [起, 止]（行号）；每条消息第一次出现的行、第一次 claimed 的行。已在飞的任务（先 claimed 后排空）照跑，不算。
  const lines = worker.split('\n')
  const windows = []
  const first = new Map()
  const claimed = new Map()
  let open = null
  lines.forEach((line, i) => {
    if (open == null && /排空重启：磁盘(?:代码|配置)已更新/.test(line)) open = i
    else if (open != null && /排空重启：(?:测试红|自检红|磁盘又与进程一致)|^\[lark-worker\] code=\S+ startedAt=/.test(line)) { windows.push([open, i]); open = null }
    for (const [id] of line.matchAll(/om_x[0-9a-f]{20,}/g)) if (!first.has(id)) first.set(id, i)
    const c = line.match(/claimed (om_x[0-9a-f]{20,})/)
    if (c && !claimed.has(c[1])) claimed.set(c[1], i)
  })
  if (open != null) windows.push([open, lines.length])
  for (const [id, at] of first) {
    const until = claimed.get(id) ?? at
    if (windows.some(([a, b]) => (at > a && at < b) || (a > at && a < until))) note(id, 'falive 当时在排空重启（不领新单，等单测 / 重启）')
  }
  return out
}

let sources = null
/** 规则要的外部数据（只读一次）。测试注入 { editDelays, faliveDown } 即可。 */
export const loadSimLimitSources = () => {
  if (sources) return sources
  const read = (name) => { try { return readFileSync(join(faliveLogDir, name), 'utf8') } catch { return null } }
  const gateway = read('gateway.log')
  const worker = read('worker.log')
  sources = { editDelays: loadEditDelays(), faliveDown: parseFaliveDown({ gateway: gateway || '', worker: worker || '' }), logs: gateway != null && worker != null }
  return sources
}

const human = (x) => !x.ownBot && x.senderType === 'user' && !x.deleted

/** falive 网关路由里这条指示锚到的任务：「指示任务 <本条>，针对 <目标>（状态）」「锚定：<本条> 接着 <目标>（…）」。 */
export const faliveAnchorsOf = (routing = []) => {
  const out = new Set()
  for (const line of routing) {
    for (const m of String(line).matchAll(/针对 (\S+?)（/g)) out.add(m[1])
    for (const m of String(line).matchAll(/接着 (\S+?)（/g)) out.add(m[1])
  }
  return [...out]
}

/** aven 点名的任务 id 在模拟里不存在（原 judge-rules.refMissing，11-04 b2）。 */
export const refMissing = (m, sim) => {
  const text = String(m.text || '')
  if (!/继续任务|结单|结束|取消任务|重开/.test(text)) return false
  const ids = [...text.matchAll(/om_x[0-9a-f]{20,}/g)].map((x) => x[0]).filter((id) => id !== m.id)
  return ids.length > 0 && ids.every((id) => !sim.tasks.has(id))
}

export const REF_LOOKBACK_MS = 30 * 60_000
export const REF_POOL_MS = 24 * 3600_000
export const REF_MIN_FACTS = 3
export const REF_COVER_MAX = 0.5
const REF_STOP = new Set(['card', 'http', 'https', 'aven', 'with', 'from', 'this', 'that', 'docx', 'wiki', 'larksuite', 'image', 'html', 'the', 'and'])
const URL_RE = /https?:\/\/[^\s)\]」，。；<>]+/g
/** 卡片 / 帖子里的标记去掉：<p> <card> <at>、@人名、「由 aven 的助手整理」署名。 */
const plain = (text) => String(text || '')
  .replace(/<at [^>]*>[^<]*<\/at>/g, ' ').replace(/<\/?[a-z]+[^>]*>/gi, ' ')
  .replace(/@[^\s@（(，,]+/g, ' ').replace(/📝 由 aven 的助手整理/g, ' ')
  .replace(/\[([^\]]*)\]\((https?:[^)]+)\)/g, '$2')

/** 一段话里可核对的事实词：接口路径（含链接的路径）、「引号里的原句」、编号 / 三位以上数字 / 钟点、四个字母以上的英文标识（小写）。 */
export const refFactsOf = (text) => {
  const s = plain(text)
  const out = new Set()
  // 链接只取路径（falive 的 Lark 文档链接模拟里永远对不上，不算事实；接口链接的路径算）
  const rest = s.replace(URL_RE, (u) => (/larksuite\.com|feishu\.cn/.test(u) ? ' ' : ` ${u.replace(/^https?:\/\/[^/]+/, '')} `))
  for (const x of rest.matchAll(/\/[A-Za-z][\w./-]{3,}/g)) out.add(x[0].toLowerCase().replace(/[.]+$/, ''))
  for (const x of rest.matchAll(/「([^」]{2,30})」/g)) out.add(x[1].toLowerCase())
  for (const x of rest.matchAll(/(?<![\w.])(?:bug[-_ ]?\d{3,}|\d{1,2}:\d{2}|\d{3,})(?![\w])/gi)) out.add(x[0].toLowerCase())
  for (const x of rest.matchAll(/(?<![\w/.-])[A-Za-z][A-Za-z0-9_]{3,}(?![\w])/g)) if (!REF_STOP.has(x[0].toLowerCase())) out.add(x[0].toLowerCase())
  return [...out]
}

/** 问的就是那张卡本身：空 @、指代 / 追问细节、按卡上的按钮话术回、或引了卡里的原句。 */
const ABOUT_RE = /这条消息|针对这条|这两个|那两个|哪两个|哪个两个|两个(?:号|接口)|文档在哪|链接在哪|你测的|你这次|本次请求|这次(?:测试|请求|实测)|所以(?:不是|是不是|就是)|列出来|什么时候调|请求头|请求参数|原始返回|确认扩大范围|就这样回/
/** 短句（≤ 12 字）里的指代也算：「这个重跑一次」「新接口文档，是这个么」。 */
const SHORT_ABOUT_RE = /这个|那个|这条|那条|这次|重跑|再测/
export const asksAboutRef = (caseText, refText, { atBot = true } = {}) => {
  const own = plain(caseText).replace(/\s+/g, ' ').trim()
  if (own.replace(/[\s\p{P}]/gu, '').length <= 2) return atBot ? '空 @ 接着那张卡' : null
  if (ABOUT_RE.test(own) || (own.replace(/\s+/g, '').length <= 12 && SHORT_ABOUT_RE.test(own))) return `追问那张卡的内容（「${own.slice(0, 30)}」）`
  const ref = String(refText || '')
  const quoted = [...own.matchAll(/「([^」]{2,40})」|"([^"]{2,40})"/g)].map((x) => x[1] || x[2]).find((q) => ref.includes(q))
  return quoted ? `引了那张卡里的原句「${quoted}」` : null
}

const TASK_CTRL_RE = /(?:结束|继续|结单|重跑|取消|关掉)(?:这个|这条|该)?任务|^\s*(?:@\S+\s*)*结单/
/** 卡上写的 falive 任务（om_x… 或分支 lark/falive-<8 位>）在模拟里一个都没有。 */
const cardTaskMissing = (refText, sim) => {
  const text = String(refText || '')
  const ids = [...text.matchAll(/om_x[0-9a-f]{20,}/g)].map((x) => x[0])
  const tails = [...text.matchAll(/lark\/falive-([0-9a-f]{8})/g)].map((x) => x[1])
  if (!ids.length && !tails.length) return null
  const simIds = [...(sim.tasks?.keys() || [])]
  const has = ids.some((id) => sim.tasks.has(id)) || tails.some((t) => simIds.some((id) => id.endsWith(t)))
  return has ? null : (ids[0] ? `…${ids[0].slice(-8)}` : tails[0])
}

/**
 * 旗标 8：这条接的那张 falive 卡（见文件头）。返回 { hard, why } 或 null。
 * hidden：本组藏起来的 falive 话（meta.hideBotIds ∪ 事件组 faliveBotIds）；pool：模拟 bot 在同会话、这条之前 24 小时内说过的话。
 */
export const faliveRefOf = ({ m, sim, data }) => {
  const byId = data.byId || new Map((data.timeline || []).map((x) => [x.id, x]))
  const hidden = new Set([...(sim.meta?.hideBotIds || []), ...((sim.episodeId && data.groupById?.get(sim.episodeId)?.faliveBotIds) || [])])
  const text = String(m.text || '')
  const parent = m.parentId ? byId.get(m.parentId) || null : null
  const named = [...text.matchAll(/om_x[0-9a-f]{20,}/g)].map((x) => byId.get(x[0])).find((x) => x?.ownBot)
  let ref = parent?.ownBot ? parent : named || null
  let via = ref ? (ref === parent ? '回复的' : '点名的') : null
  if (!ref && !parent) { // 没回复：紧挨着的上一张有内容的 falive 卡（同会话、同话题 / 主流，30 分钟内），且这条确实在问它
    ref = (data.timeline || []).filter((x) => x.ownBot && hidden.has(x.id) && x.chatId === m.chatId && (x.threadId || null) === (m.threadId || null)
      && x.atMs < m.atMs && m.atMs - x.atMs <= REF_LOOKBACK_MS && refFactsOf(x.text).length >= REF_MIN_FACTS).at(-1) || null
    via = ref ? '紧挨着的上一张' : null
  }
  if (!ref) return null
  // 只看冲着 bot 说的：@ 了 bot、负责人私信，或回 bot 的卡且没 @ 别人（「cc @x」「@Arthur 你描述一下」是在跟人说）
  const toBot = m.atBot || m.chatKey === 'webhook-group' || (ref === parent && !(m.mentions || []).some((x) => !BOT_MENTION_IDS.has(x.id)))
  if (!toBot) return null
  const about = asksAboutRef(text, ref.text, { atBot: Boolean(m.atBot || m.chatKey === 'webhook-group') })
  const at = `${via} falive 卡（…${ref.id.slice(-8)}，${new Date(ref.atMs).toISOString().slice(5, 16).replace('T', ' ')}）`
  if (!hidden.has(ref.id)) {
    const missing = TASK_CTRL_RE.test(plain(text)) && !named ? cardTaskMissing(ref.text, sim) : null
    return missing ? { hard: true, why: `${at}照供，但卡上的任务（${missing}）是 falive 当时自己的，模拟里没有：「${plain(text).trim().slice(0, 20)}」指的那单续 / 结不了` } : null
  }
  if (via === '紧挨着的上一张' && !about) return null
  const facts = refFactsOf(ref.text)
  if (facts.length < REF_MIN_FACTS) return null
  const dm = m.chatKey === 'webhook-group'
  const pool = (sim.outbox || []).filter((o) => o.at <= m.atMs && m.atMs - o.at <= REF_POOL_MS && (dm ? Boolean(o.userId) || o.chatId === m.chatId : o.chatId === m.chatId))
    .map((o) => String(o.text || '')).join('\n').toLowerCase()
  const hit = facts.filter((f) => pool.includes(f))
  if (hit.length / facts.length >= REF_COVER_MAX) return null
  const miss = facts.filter((f) => !pool.includes(f)).slice(0, 5)
  return {
    hard: Boolean(about),
    why: `${at}按事件组藏了，模拟 bot 在这里没说过卡里的事实（${hit.length}/${facts.length} 对得上，缺 ${miss.join('、')}）${about ? `；${about}` : ''}：falive 答的是它自己那份记录，lark-bot 手上没有`,
  }
}

const EXTERNAL_HOST_RE = /figma|sketch|zeplin|lanhuapp|mastergo|modao|pixso/i
const EXTERNAL_TEXT_RE = /(?:figma|设计稿|ui\s*稿|稿子?)[^。\n]{0,60}(?:出网|白名单|拦截|被拦|读不到|拿不到|访问不了|打不开|没有?导出)|(?:出网|白名单|egress)[^。\n]{0,30}(?:figma|设计)/i
/** 旗标 9：lark-bot 说外部设计源读不到，或 egress 里拦了设计站的请求。task：本条或并入目标的任务。返回 { hard, why } 或 null。 */
export const externalLimitOf = ({ lark = null, task = null, egressBlocked = [] }) => {
  const said = [lark?.output, ...(lark?.lines || []).map((l) => l.text), task?.result, task?.summary, typeof task?.blocker === 'string' ? task.blocker : JSON.stringify(task?.blocker || '')].filter(Boolean).join('\n')
  const quote = said.match(EXTERNAL_TEXT_RE)?.[0] || null
  const blocked = egressBlocked.filter((e) => EXTERNAL_HOST_RE.test(e.host || ''))
  if (!quote && !blocked.length) return null
  const hard = task?.status === 'blocked' && Boolean(quote)
  return { hard, why: `外部设计 / 文档源回放里读不到${quote ? `（lark-bot：「${quote.replace(/\s+/g, ' ').slice(0, 50)}」）` : ''}${blocked.length ? `（egress 拦了 ${[...new Set(blocked.map((e) => e.host))].join('、')} ${blocked.length} 次）` : ''}${hard ? '，任务因此停在 blocked' : ''}：线上 bot 能读稿，卡在这里不算 bot 的错，看它要稿 / 报卡点是否清楚` }
}

/**
 * 一条 case 的模拟局限：[{ flag, why }]。
 * m：时间线消息；sim：loadSim 结果（tasks / fed）；data：loadJudgeData；lark：larkFacts（看 lark-bot 输出里有没有读 bug 表快照）；
 * src：loadSimLimitSources（或测试注入）。
 */
export const simLimitsOf = ({ m, sim, data, lark = null, task = null, src = loadSimLimitSources() }) => {
  const out = []
  const add = (flag, why) => out.push({ flag: `${SIM_LIMIT_PREFIX}${flag}`, why })
  const tag = data.tags?.get(m.id) || null
  const baseline = data.baselines?.get(m.id)?.baseline || {}
  const text = String(m.text || '')

  if (refMissing(m, sim)) add('ref', '点名的任务是 falive 当时自己建的，模拟里没有')

  const ev = data.evidence?.get(m.id) || null
  if (tag?.kind === 'verification' || ev) {
    add('verify', `回放打的是今天的环境，结论不和当时比${ev ? `；falive 当时证据（${(ev.env || []).join(' / ') || '环境没写明'}${ev.envDownThen ? '，当时环境挂了' : ''}，关联 ${ev.match || '-'}）` : '；falive 当时没留下实测证据'}`)
  }

  if (requestsTestData(text)) {
    add('testdata', '原话明确要造测试数据：线上会用 pre 测试号建，回放拦了真实写入（「回放：真实写入已拦截」）。判过程：有没有用测试号在 pre 计划 / 尝试创建、有没有如实报回放拦截、没编 id；falive 当时真建了帖，结论不比')
  }

  if (m.chatKey === 'webhook-group') {
    const fed = new Set(sim.fed || [])
    const anchors = faliveAnchorsOf(baseline.routing).filter((id) => id !== m.id)
    const missing = anchors.filter((id) => !sim.tasks.has(id) && !fed.has(id))
    if (missing.length) add('anchor', `falive 当时把这句锚到 ${missing.map((id) => (id.startsWith('om_') ? `…${id.slice(-8)}` : id)).join('、')}（窗口前 / 组外的任务），模拟里没有`)
    else if (/推\s*pre|帮我合|合一下|合进|合到/i.test(text)) add('anchor', '依赖任务分支 / 合回状态（推 pre / 帮我合 / 合没合到某环境），模拟还原不了当时的分支')
    else if (!anchors.length && /已部署|已发布|部署好了|发布了/.test(text)) { // falive 锚到了、模拟里也有 → 不算
      const prior = [...sim.tasks.values()].some((t) => t.id !== m.id && Date.parse(t.createdAt || '') < m.atMs && m.atMs - Date.parse(t.createdAt || '') <= ANCHOR_LOOKBACK_MS)
      if (!prior) add('anchor', '「已部署 / 已发布」要锚 12 小时内的任务通知，模拟里这段时间 lark-bot 没有任务')
    }
  }

  const edited = src.editDelays?.get(m.id)
  if (edited) add('edited', `发出后 ${Math.round(edited / 1000)} 秒被编辑过：falive 当时轮询到的可能是编辑前的版本（没 @ / 话没说完），模拟拿的是编辑后的`)

  // 只看「bot 也会接」的邻居（别的 case 或 @ 了 bot 的）：同一人连发闲话不影响分单
  const near = (data.timeline || []).filter((x) => x.id !== m.id && human(x) && (data.caseIds?.has(x.id) || x.atBot) && x.chatId === m.chatId && x.senderId === m.senderId && (
    Math.abs(x.atMs - m.atMs) <= BURST_MS || (m.threadId && x.threadId === m.threadId && Math.abs(x.atMs - m.atMs) <= THREAD_BURST_MS)))
  if (near.length) {
    const inThread = near.some((x) => m.threadId && x.threadId === m.threadId && Math.abs(x.atMs - m.atMs) > BURST_MS)
    add('timing', `${m.senderName || '同一人'}${inThread ? '在同话题 10 分钟内接连补充' : ' 2 分钟内连发'}（前后另有 ${near.length} 条 bot 也会接的）：ack 去重、并入还是另起一单随时序变，按整件事判`)
  }

  const down = src.faliveDown?.get(m.id)
  if (down) add('falive_down', `${down}：falive 一侧没回 / 回得慢不作数`)

  const faliveText = [baseline.audit?.finalSummary, ...(baseline.botReplies || []).map((r) => r.text)].join('\n')
  const larkText = [lark?.output, ...(lark?.lines || []).map((l) => l.text)].join('\n')
  const why = []
  if (/bug[-_ #]?\d{3,}|bug\s*(?:表|单|号)|缺陷|认领|bugpoll/i.test(text)) why.push('这条点了 bug 号 / bug 表')
  if (/lark-bugpoll|bug\s*表/i.test(faliveText)) why.push('falive 当时靠记忆 / bug 表快照答的')
  if (/lark-bugpoll/.test(larkText)) why.push('lark-bot 会话读了 ~/.lark-bugpoll（今天的 bug 表快照，含窗口之后的备注）')
  if (why.length) add('memory', `${why.join('；')}：记忆是近似版本，bug 表快照是今天的`)

  // 8 / 9：硬的是 sim_limit_falive_ref / sim_limit_external（acceptance.SIM_LIMIT_HARD），软的带 _soft 后缀，只给裁判看
  const ref = faliveRefOf({ m, sim, data })
  if (ref) add(ref.hard ? 'falive_ref' : 'falive_ref_soft', ref.why)
  const ext = externalLimitOf({ lark, task, egressBlocked: sim.egressBlocked || [] })
  if (ext) add(ext.hard ? 'external' : 'external_soft', ext.why)
  return out
}
