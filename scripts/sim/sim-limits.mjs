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
 * 数据只读：replay/falive/raw（编辑时间）、~/Library/Logs/falive-lark/{gateway,worker}.log（没有就不出旗标 5，loadSimLimitSources().logs 记 false）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { GROUPS, faliveLogDir, rawDir } from './falive-data.mjs'

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

/**
 * 一条 case 的模拟局限：[{ flag, why }]。
 * m：时间线消息；sim：loadSim 结果（tasks / fed）；data：loadJudgeData；lark：larkFacts（看 lark-bot 输出里有没有读 bug 表快照）；
 * src：loadSimLimitSources（或测试注入）。
 */
export const simLimitsOf = ({ m, sim, data, lark = null, src = loadSimLimitSources() }) => {
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
  return out
}
