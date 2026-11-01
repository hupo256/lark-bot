/**
 * 审计度量（docs/upgrade-plan-context-layers-2026-11-01.md S6）：读 runtime/lark-audits/<项目>/<任务>-e<代>.log 里 claude 的
 * stream-json 事件（实施 / 只读任务阶段；分析 / 分诊走单个 json 信封，没有 init 事件，不计），配同名 .json 审计，
 * 汇总成一张表：宿主隔离是否生效、工具怎么选、该用的工具用了没、缓存命中。
 * 《8 个卡点》§5：能启动 ≠ 会被选择——工具描述改不改、怎么改，先看这张表，不凭感觉。纯函数，取数在 scripts/lark-metrics.mjs。
 */

import { extractBugRecordLinks } from './lark-bug-record.mjs'

// Bash 里「拿 Bash 读文件 / 搜代码」的命令：这些本该用 Read / Grep / Glob 专用工具（输出受控、不吃 shell 噪音）。
const READER_COMMANDS = new Set(['cat', 'head', 'tail', 'grep', 'egrep', 'rg', 'find', 'ls', 'wc', 'awk', 'less', 'nl'])
const IMAGE_PATH = /\.(?:png|jpe?g|gif|webp)$/i

// 去掉 `cd x &&`、`VAR=… ` 前缀，取真正执行的第一个命令词；sed 只有 -n（打印）算读，-i 是写。
export const bashCommandHead = (command) => {
  let text = String(command || '').trim()
  for (;;) {
    const next = text.replace(/^cd\s+[^;&|]+(?:&&|;)\s*/, '').replace(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/, '')
    if (next === text) break
    text = next
  }
  const words = text.split(/\s+/)
  const word = (words[0] || '').replace(/^.*\//, '')
  return { word, isReader: READER_COMMANDS.has(word) || (word === 'sed' && /\s-n\b/.test(text) && !/\s-i\b/.test(text)) }
}

// 一份审计日志 → 会话数组。日志里混着 worker 写的「=== 时间 执行器 阶段 ===」分隔行与 stderr，只认 JSON 行。
export const parseAuditLog = (text) => {
  const sessions = []
  let current = null
  for (const line of String(text || '').split('\n')) {
    if (!line.startsWith('{')) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event.type === 'system' && event.subtype === 'init') {
      current = {
        model: event.model || null,
        outputStyle: event.output_style || null,
        permissionMode: event.permissionMode || null,
        mcpServers: (event.mcp_servers || []).map((server) => server.name),
        skills: Array.isArray(event.skills) ? event.skills.length : null,
        tools: [],
        result: null,
      }
      sessions.push(current)
    } else if (event.type === 'assistant' && current) {
      for (const item of event.message?.content || []) {
        if (item?.type === 'tool_use') current.tools.push({ name: item.name, command: item.input?.command || null, path: item.input?.file_path || null })
      }
    } else if (event.type === 'result' && current) {
      const usage = event.usage || {}
      current.result = {
        cacheRead: usage.cache_read_input_tokens || 0,
        cacheCreation: usage.cache_creation_input_tokens || 0,
        input: usage.input_tokens || 0,
        costUsd: event.total_cost_usd || 0,
        turns: event.num_turns || 0,
        denials: (event.permission_denials || []).length,
      }
    }
  }
  return sessions
}

const bump = (counter, key, n = 1) => {
  counter[key] = (counter[key] || 0) + n
  return counter
}
const ratio = (hit, total) => (total ? Number((hit / total).toFixed(3)) : null)
const median = (values) => {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null
}

// entries：[{ audit（.json 审计对象，可为 null）, sessions（parseAuditLog 结果） }]。
export const summarizeAuditMetrics = (entries) => {
  const sessions = entries.flatMap((entry) => entry.sessions)
  const tools = {}
  const bashHeads = {}
  let bashTotal = 0
  let bashReaders = 0
  const outputStyles = {}
  const models = {}
  const mcpNames = {}
  let mcpExposed = 0
  let mcpCalls = 0
  const cache = { read: 0, creation: 0, input: 0 }
  let costUsd = 0
  let denials = 0
  for (const session of sessions) {
    bump(outputStyles, session.outputStyle || 'unknown')
    bump(models, session.model || 'unknown')
    if (session.mcpServers.length) mcpExposed += 1
    for (const name of session.mcpServers) bump(mcpNames, name)
    for (const tool of session.tools) {
      bump(tools, tool.name)
      if (tool.name.startsWith('mcp__')) mcpCalls += 1
      if (tool.name === 'Bash') {
        bashTotal += 1
        const head = bashCommandHead(tool.command)
        bump(bashHeads, head.word || '(空)')
        if (head.isReader) bashReaders += 1
      }
    }
    if (session.result) {
      cache.read += session.result.cacheRead
      cache.creation += session.result.cacheCreation
      cache.input += session.result.input
      costUsd += session.result.costUsd
      denials += session.result.denials
    }
  }
  // 工具路由：该用的时候用了没（按任务算，一条任务可能多个会话——续会话 / 补写）。
  const routing = { imageTasks: 0, imageRead: 0, bugLinkTasks: 0, bugToolUsed: 0 }
  for (const { audit, sessions: own } of entries) {
    if (!own.length) continue
    const allTools = own.flatMap((session) => session.tools)
    const images = (audit?.attachments || audit?.task?.attachments || []).filter((item) => item?.type === 'image')
    if (images.length) {
      routing.imageTasks += 1
      if (allTools.some((tool) => tool.name === 'Read' && IMAGE_PATH.test(tool.path || ''))) routing.imageRead += 1
    }
    if (extractBugRecordLinks(audit?.task?.text || '').length) {
      routing.bugLinkTasks += 1
      if (allTools.some((tool) => tool.name === 'Bash' && /read-bug-record/.test(tool.command || ''))) routing.bugToolUsed += 1
    }
  }
  const cacheTotal = cache.read + cache.creation + cache.input
  return {
    tasks: entries.filter((entry) => entry.sessions.length).length,
    sessions: sessions.length,
    isolation: {
      outputStyles,
      models,
      mcpExposedSessions: mcpExposed,
      mcpServerNames: mcpNames,
      mcpToolCalls: mcpCalls,
      medianSkills: median(sessions.map((session) => session.skills)),
    },
    tools,
    bash: { total: bashTotal, readers: bashReaders, readerRatio: ratio(bashReaders, bashTotal), topHeads: Object.entries(bashHeads).sort((a, b) => b[1] - a[1]).slice(0, 12) },
    routing: { ...routing, imageReadRatio: ratio(routing.imageRead, routing.imageTasks), bugToolRatio: ratio(routing.bugToolUsed, routing.bugLinkTasks) },
    cache: { ...cache, readRatio: ratio(cache.read, cacheTotal) },
    costUsd: Number(costUsd.toFixed(2)),
    permissionDenials: denials,
  }
}

const formatCounter = (counter) => Object.entries(counter).sort((a, b) => b[1] - a[1]).map(([key, n]) => `${key} ${n}`).join('、') || '—'
const pct = (value) => (value == null ? '—' : `${Math.round(value * 100)}%`)

export const formatAuditMetrics = (m) => [
  `任务 ${m.tasks}，claude 会话 ${m.sessions}（只计实施 / 只读阶段的 stream-json 会话）`,
  `隔离：输出样式 ${formatCounter(m.isolation.outputStyles)}；模型 ${formatCounter(m.isolation.models)}；skill 中位数 ${m.isolation.medianSkills ?? '—'}`,
  `MCP：挂着连接器的会话 ${m.isolation.mcpExposedSessions}/${m.sessions}（${formatCounter(m.isolation.mcpServerNames)}），实际调用 ${m.isolation.mcpToolCalls} 次`,
  `工具：${formatCounter(m.tools)}`,
  `Bash ${m.bash.total} 次，其中拿 Bash 读文件 / 搜代码 ${m.bash.readers} 次（${pct(m.bash.readerRatio)}）；前几位：${m.bash.topHeads.map(([w, n]) => `${w} ${n}`).join('、')}`,
  `路由：带截图的任务 ${m.routing.imageTasks} 条，打开过截图 ${m.routing.imageRead} 条（${pct(m.routing.imageReadRatio)}）；带 bug 记录链接 ${m.routing.bugLinkTasks} 条，用了读记录工具 ${m.routing.bugToolUsed} 条（${pct(m.routing.bugToolRatio)}）`,
  `缓存：读 ${m.cache.read} / 写 ${m.cache.creation} / 未缓存 ${m.cache.input} token，命中 ${pct(m.cache.readRatio)}；花费 $${m.costUsd}；权限拒绝 ${m.permissionDenials} 次`,
].join('\n')
