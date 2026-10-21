/**
 * 群回复结构化渲染（10-21 架构加固 P6）：执行器交结构化的 report（对象 / 答案 / 逐项状态），代码渲染成群里那段话。
 *
 * 为什么：群回复原来是自由文本，发群前用正则去「读」它判断有没有自相矛盾（findCompletionContradiction 等），
 * 误判一个修一个：#34「uid 508」被当成 5xx、#56「不再报错」被当成报错、#58 重跑「为空说明到底了」被当成没数据。
 * 现在第一行的数字由条目算，「都通了」只在每一项都 ok 时出现——结论和条目不可能对不上，也就不需要正则去查。
 *
 * 「有没有实测」不信模型自报：条目写 evidence=pre / browser，但本轮会话里没有对应的探针 / 浏览器调用，降级成「待验证」
 *（只降这一项，不扣整段）。证据读 Claude Code 自己落盘的会话记录（~/.claude/projects/<cwd>/<session>.jsonl）：
 * 分析阶段是 json 输出、审计日志里没有它的工具事件，而浏览器复测常在分析阶段就做了（10-20 #58 重跑即如此）。
 * 会话记录读不到 → 不降级（宁可不核，不误伤真做过的复测）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'

export const MARKS = ['ok', 'not_usable', 'not_done', 'na']
// unverified 只由 applyRunEvidence 打（模型的 schema 里没有），回写后网关再校验时要认它。
const KNOWN_MARKS = [...MARKS, 'unverified']
const EVIDENCE = ['pre', 'browser', 'code', 'none']
const LABEL = { ok: '✅ 通了', not_usable: '⚠️ 接了但还不能用', unverified: '⚠️ 待验证', not_done: '❌ 没接', na: '➖ 不涉及接口' }
const ORDER = ['not_usable', 'unverified', 'not_done', 'ok', 'na']
const OPEN = new Set(['not_usable', 'unverified', 'not_done'])
const clip = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

// 校验 + 截断；结构不对返回 null（走旧的 groupReply 路径）。
export const normalizeReport = (raw) => {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) return null
  const items = raw.items
    .filter((item) => item && clip(item.name, 60))
    .slice(0, 12)
    // 不认识的 mark（10-21 真机：执行器写了 pending）按「还不能用」显示，不能丢——丢掉的往往正是保留意见，剩下的会被渲染成「都通了」。
    .map((item) => ({ mark: KNOWN_MARKS.includes(item.mark) ? item.mark : 'not_usable', name: clip(item.name, 60), note: clip(item.note, 120), evidence: EVIDENCE.includes(item.evidence) ? item.evidence : 'none' }))
  const subject = clip(raw.subject, 40) || null
  const answer = clip(raw.answer, 200) || null
  if (!items.length && !answer) return null
  return { subject, answer, items }
}

// 本轮会话里实际跑了几次探针 / 浏览器（按 tool_use id 去重）。一份会话记录都读不到返回 null（不降级）。
export const DEFAULT_BROWSER_PATTERN = /playwright|chromium|puppeteer/i
export const collectRunEvidence = ({ sessionFiles = [], probeCommand = null, browserPattern = DEFAULT_BROWSER_PATTERN }) => {
  const probeName = probeCommand ? basename(String(probeCommand).split(/\s+/).find((part) => /\.(m?js|sh|py)$/.test(part)) || '') : ''
  const probe = new Set()
  const browser = new Set()
  let read = 0
  for (const file of sessionFiles.filter(Boolean)) {
    if (!existsSync(file)) continue
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    read += 1
    for (const line of text.split('\n')) {
      if (!line.includes('"tool_use"')) continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      for (const part of event?.message?.content || []) {
        if (part?.type !== 'tool_use') continue
        const command = String(part.input?.command || part.input?.script || '')
        if (browserPattern.test(part.name || '') || browserPattern.test(command)) browser.add(part.id)
        if (probeName && command.includes(probeName)) probe.add(part.id)
      }
    }
  }
  return read ? { probeCalls: probe.size, browserCalls: browser.size } : null
}

// 条目自称实测但本轮没有对应调用 → 待验证。evidence 为 null（读不到事件）不动。
export const applyRunEvidence = (report, evidence) => {
  if (!report || !evidence) return report
  const items = report.items.map((item) => {
    const missing = item.mark === 'ok' && ((item.evidence === 'pre' && !evidence.probeCalls) || (item.evidence === 'browser' && !evidence.browserCalls))
    return missing ? { ...item, mark: 'unverified', note: `${item.note ? `${item.note}；` : ''}这次没实测` } : item
  })
  return { ...report, items }
}

// 渲染：代答第一行是答案，下面只列给出的条目；其余第一行「对象：通了 a 项，没通 b 项」，全部 ok 才写「都通了」。
export const renderReport = (report) => {
  if (!report) return ''
  const sorted = [...report.items].sort((a, b) => ORDER.indexOf(a.mark) - ORDER.indexOf(b.mark))
  const lines = sorted.map((item) => `- ${LABEL[item.mark]} ${item.name}${item.note ? `：${item.note}` : ''}`)
  if (report.answer) return [report.answer, ...lines].join('\n')
  const open = report.items.filter((item) => OPEN.has(item.mark)).length
  const ok = report.items.filter((item) => item.mark === 'ok').length
  const tally = open === 0 && ok ? '都通了' : `通了 ${ok} 项，没通 ${open} 项`
  return [`${report.subject ? `${report.subject}：` : ''}${tally}`, ...lines].join('\n')
}
