/**
 * 校准报告（design-v2 §8 P1）：同一个事件组，falive 当时怎么做 vs falive 的代码在模拟器里怎么做。两边都是 falive 代码，对不上的就是模拟器偏差。
 * 比五样：
 *   1. 路由：网关日志里提到组内 case 的行（收到 / 收到回执 / 台账 / 开始 / 群回复 / 结果 / 私聊指示…），case id 换成 C1、C2，群 id 换成群名，逐行对。
 *      falive 当时的取自 replay/falive/dataset/episodes.json 的 baseline.routing（gateway.log 摘出来的同一种行）。
 *   2. 分类：baseline.classified vs 模拟里网关日志 `classified=<决定>/<置信>`。
 *   3. 群里说了什么：falive 发件簿（runtime/lark-outbox/<群>.jsonl，带 taskId）按 taskId 对——两边是同一套发件簿代码，逐条可比。
 *   4. 控制台（负责人私聊）说了什么：falive 当时的取时间线里控制台群的 bot 消息（按时间段 + 排除组外触发后 2 分钟内的，启发式）；模拟里取 outbox.jsonl。
 *   5. 看到的上下文：falive 审计里 task.text vs 模拟审计里的 task.text，按行比只有一边有的行。
 * 另附出网审计（egress.jsonl / probe.log）与假 CLI 缺口（missing.log）。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { GROUPS, casesDir, datasetDir } from './falive-data.mjs'

const readJson = (path, fallback = null) => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return fallback } }
const readLines = (path) => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : [])
const jsonl = (path) => readLines(path).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
const chatName = (id) => GROUPS.find((g) => g.chatId === id)?.key || id

// 路由行归一：case id → C1…，群 id → 群名，去掉随机 / 时刻部分；纯函数，供单测
export const normalizeRouting = (line, caseIds) => {
  let out = String(line).replace(/^\[lark-gateway\]\s*/, '')
  caseIds.forEach((id, i) => { out = out.split(id).join(`C${i + 1}`) })
  return out
    .replace(/oc_[0-9a-f]{32}/g, (id) => chatName(id))
    .replace(/(等待意图分类|：)[:：]?\s.*$/, '$1…') // 原话尾巴不比
    .replace(/工单键 \S+/, '工单键 …')
    .trim()
}
const ROUTING_RE = /(received |repo |回「收到」|台账：|task-mention |负责人私聊|锚定：|并入|续跑|出口闸|只私聊)/
export const routingLines = (logText, caseIds) => String(logText || '').split('\n')
  .filter((line) => caseIds.some((id) => line.includes(id)) && ROUTING_RE.test(line))
  .map((line) => normalizeRouting(line, caseIds))

const cardText = (text) => String(text || '').replace(/<at id=(ou_\w+)><\/at>/g, '@$1').trim()

export const buildCalibration = ({ simDir, episode, faliveArchive }) => {
  const caseIds = episode.caseIds
  const firstMs = Date.parse(episode.firstAt)
  const meta = readJson(join(simDir, 'meta.json'), {})
  const baseline = new Map((readJson(join(datasetDir, 'episodes.json'), []) || []).map((e) => [e.id, e]))
  const timeline = readJson(join(datasetDir, 'timeline.json'), [])
  const config = readJson(join(simDir, 'runtime', 'lark-bot.local.json'), {})
  const consoleChat = config.repos?.falive?.notifyChatId || 'oc_21a29d687ecfcd6d6776cac669a4c5d3'
  const simGatewayLog = existsSync(join(simDir, 'gateway.log')) ? readFileSync(join(simDir, 'gateway.log'), 'utf8') : ''

  // 群里：两边的发件簿按 taskId
  const outboxOf = (dir) => (existsSync(dir) ? readdirSync(dir).flatMap((f) => jsonl(join(dir, f))) : []).filter((e) => caseIds.includes(e.taskId))
  const realGroup = outboxOf(join(faliveArchive, 'runtime', 'lark-outbox'))
  const simGroup = outboxOf(join(simDir, 'runtime', 'lark-outbox'))
  // 控制台：falive 当时的按时间段取（组内最后一条群消息后 2 分钟为止），排除组外触发消息后 2 分钟内的（多半是别的任务的「开始做」）
  const realEndMs = Math.max(Date.parse(episode.lastAt), ...realGroup.map((e) => Date.parse(e.at))) + 120_000
  const hiddenAt = timeline.filter((m) => (meta.hiddenIds || []).includes(m.id)).map((m) => m.atMs)
  const realConsole = timeline.filter((m) => m.ownBot && m.chatId === consoleChat && m.atMs >= firstMs && m.atMs <= realEndMs && !/\[bugpoll\]/.test(m.text || '') && !hiddenAt.some((t) => m.atMs >= t && m.atMs - t <= 120_000))
  const simOutbox = jsonl(join(simDir, 'outbox.jsonl'))
  const simConsole = simOutbox.filter((e) => e.chatId === consoleChat)

  const perCase = caseIds.map((id, i) => {
    const base = baseline.get(id)?.baseline || {}
    const m = timeline.find((x) => x.id === id)
    const simClass = new RegExp(`task-mention ${id} classified=(\\w+)/(\\w+)`).exec(simGatewayLog)
    const realAudit = readJson(join(faliveArchive, 'runtime', 'lark-audits', 'FALIVE', `${id}-e1.json`), null)
    const simAudit = readJson(join(simDir, 'runtime', 'lark-audits', 'FALIVE', `${id}-e1.json`), null)
    const lines = (t) => new Set(String(t || '').split('\n').map((l) => l.replace(/\(ou_\w+\)/g, '').trim()).filter(Boolean))
    const realSeen = lines(realAudit?.task?.text)
    const simSeen = lines(simAudit?.task?.text)
    const simTask = readJson(join(simDir, 'runtime', 'lark-tasks', `${id}.json`), null)
    return {
      label: `C${i + 1}`,
      id,
      at: m ? new Date(m.atMs).toISOString() : null,
      chat: m?.chatKey || null,
      text: m?.text?.slice(0, 200) || null,
      classified: { falive: base.classified || null, sim: simClass ? { decision: simClass[1], confidence: simClass[2] } : null },
      status: { falive: realAudit?.status || null, sim: simTask?.status || simAudit?.status || null },
      seen: {
        falive: realSeen.size,
        sim: simSeen.size,
        onlyFalive: [...realSeen].filter((l) => !simSeen.has(l)).slice(0, 40),
        onlySim: [...simSeen].filter((l) => !realSeen.has(l)).slice(0, 40),
      },
      group: {
        falive: realGroup.filter((e) => e.taskId === id).map((e) => ({ at: e.at, afterSec: m ? Math.round((Date.parse(e.at) - m.atMs) / 1000) : null, phase: e.phase, gated: e.gated || null, text: cardText(e.text) })),
        sim: simGroup.filter((e) => e.taskId === id).map((e) => ({ at: e.at, afterSec: m ? Math.round((Date.parse(e.at) - m.atMs) / 1000) : null, phase: e.phase, gated: e.gated || null, text: cardText(e.text) })),
      },
    }
  })
  const routing = {
    falive: caseIds.flatMap((id) => (baseline.get(id)?.baseline?.routing || []).map((line) => normalizeRouting(line, caseIds))),
    sim: routingLines(simGatewayLog, caseIds),
  }
  routing.falive = [...new Set(routing.falive)]
  routing.sim = [...new Set(routing.sim)]
  const egress = jsonl(join(simDir, 'egress.jsonl'))
  return {
    episode: episode.id,
    faliveCode: meta.faliveCode || null,
    faliveConfig: meta.faliveConfig || null,
    cases: perCase,
    routing: { ...routing, onlyFalive: routing.falive.filter((l) => !routing.sim.includes(l)), onlySim: routing.sim.filter((l) => !routing.falive.includes(l)) },
    console: {
      falive: realConsole.map((m) => ({ at: new Date(m.atMs).toISOString(), text: m.text })),
      sim: simConsole.map((e) => ({ at: e.atIso, text: e.text })),
    },
    simOtherSends: simOutbox.filter((e) => e.chatId !== consoleChat).length - simGroup.filter((e) => !e.gated).length,
    egress: {
      connections: egress.length,
      nonLocal: egress.filter((e) => !e.local).map((e) => `${e.command} ${e.remote}${e.flagged ? ` ⚠${e.flagged}` : ''}`),
      flagged: egress.filter((e) => e.flagged),
      probe: readLines(join(simDir, 'probe.log')).length,
      probeBlocked: readLines(join(simDir, 'probe.log')).filter((l) => l.includes(' BLOCKED ')),
    },
    fakeCliGaps: readLines(join(simDir, 'missing.log')),
    casesDir,
  }
}

export const renderCalibration = (r) => {
  const out = [`# 校准：${r.episode}（falive 当时 vs falive 代码在模拟器里）`, '']
  const code = r.faliveCode
  out.push(`- falive 代码：${code?.sha?.slice(0, 7) || '?'}${code?.verified ? `（指纹 ${code.codeHash} 与当时启动 ${code.startedAt} 一致）` : '（未核对上指纹）'}；配置：${String(r.faliveConfig || '').split('/').pop()}`)
  out.push(`- 出网：${r.egress.connections} 条连接，非本机 ${r.egress.nonLocal.length} 条，命中飞书 / GitLab / 邮件 ${r.egress.flagged.length} 条；实测转发 ${r.egress.probe} 次，拦下注册 ${r.egress.probeBlocked.length} 次；假 CLI 缺口 ${r.fakeCliGaps.length} 条`)
  out.push('')
  for (const c of r.cases) {
    out.push(`## ${c.label} ${c.id}（${c.chat} ${c.at?.slice(5, 19)}）`, '', `> ${c.text}`, '')
    out.push(`- 分类：falive ${c.classified.falive ? `${c.classified.falive.decision}/${c.classified.falive.confidence}` : '—'}；模拟 ${c.classified.sim ? `${c.classified.sim.decision}/${c.classified.sim.confidence}` : '—'}`)
    out.push(`- 终态：falive ${c.status.falive || '—'}；模拟 ${c.status.sim || '—'}`)
    out.push(`- 看到的上下文：falive ${c.seen.falive} 行、模拟 ${c.seen.sim} 行；只 falive 有 ${c.seen.onlyFalive.length} 行、只模拟有 ${c.seen.onlySim.length} 行`)
    for (const l of c.seen.onlyFalive.slice(0, 12)) out.push(`  - 只 falive：${l.slice(0, 140)}`)
    for (const l of c.seen.onlySim.slice(0, 12)) out.push(`  - 只模拟：${l.slice(0, 140)}`)
    out.push('', '| 谁 | 距 case | 阶段 | 群里说了什么 |', '|---|---|---|---|')
    for (const [who, list] of [['falive', c.group.falive], ['模拟', c.group.sim]]) {
      for (const e of list) out.push(`| ${who} | ${e.afterSec}s | ${e.phase}${e.gated ? `（拦下：${e.gated}）` : ''} | ${e.text.replace(/\n/g, ' ').replace(/\|/g, '\\|').slice(0, 400)} |`)
      if (!list.length) out.push(`| ${who} | — | — | （没发） |`)
    }
    out.push('')
  }
  out.push('## 路由（网关日志）', '', '| falive 当时 | 模拟 |', '|---|---|')
  for (let i = 0; i < Math.max(r.routing.falive.length, r.routing.sim.length); i += 1) out.push(`| ${(r.routing.falive[i] || '').replace(/\|/g, '\\|')} | ${(r.routing.sim[i] || '').replace(/\|/g, '\\|')} |`)
  out.push('', `只 falive 有：${r.routing.onlyFalive.length ? '' : '无'}`, ...r.routing.onlyFalive.map((l) => `- ${l}`), '', `只模拟有：${r.routing.onlySim.length ? '' : '无'}`, ...r.routing.onlySim.map((l) => `- ${l}`), '')
  out.push('## 控制台（负责人私聊）', '', '**falive 当时**（时间线，启发式取段）：', '')
  for (const m of r.console.falive) out.push(`- ${m.at.slice(11, 19)} ${m.text.replace(/\s+/g, ' ').slice(0, 300)}`)
  out.push('', '**模拟**：', '')
  for (const m of r.console.sim) out.push(`- ${String(m.at).slice(11, 19)} ${String(m.text).replace(/\s+/g, ' ').slice(0, 300)}`)
  out.push('', '## 出网', '', ...(r.egress.nonLocal.length ? r.egress.nonLocal.map((l) => `- ${l}`) : ['- 无非本机连接']), '')
  if (r.fakeCliGaps.length) out.push('## 假 CLI 缺口', '', ...r.fakeCliGaps.map((l) => `- ${l}`), '')
  return out.join('\n')
}
