#!/usr/bin/env node
/**
 * 多轮模拟总览（docs/falive-replay-plan-2026-11-03.md）：基线 full-* / 第二轮 fix-* / 第三轮 r3-*，每轮按段 a（10-20→10-24）/
 * b（10-25→10-29）/ c（10-30→11-02）汇总 judge.jsonl 的胜负、larkIssue 分布、运营指标（回复 / 重复回复 / 私信 aven / 任务终态），
 * 列出最新一轮仍比 falive 差的条目，并附 L1（l1/<run>/judge.jsonl）的 better / larkReplyQuality 分布。
 *   node scripts/sim/summarize.mjs [--md <out>]
 * 缺的目录跳过；没跑完的段标「未完」（sim.log「窗口」行数不足该段天数、最后一行不是「[sim] 完成」、或 run-days 进程还在）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { AVEN_OPEN_ID, replayRoot } from './falive-data.mjs'

const args = process.argv.slice(2)
const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const out = value('--md', null)

const ROUNDS = [
  { label: '基线', prefix: 'full' },
  { label: '第二轮', prefix: 'fix' },
  { label: '第三轮', prefix: 'r3' },
  // 第五 / 六轮每段切两半并行跑（docs §28 / §33）：a = a1（3 天）+ a2（2 天），b = b1 + b2，c = c1 + c2，合并成一段统计
  { label: '第五轮（fix12 前）', prefix: 'r5', parts: { a: [['a1', 3], ['a2', 2]], b: [['b1', 3], ['b2', 2]], c: [['c1', 2], ['c2', 2]] } },
  { label: '第六轮（最终版）', prefix: 'r6', parts: { a: [['a1', 3], ['a2', 2]], b: [['b1', 3], ['b2', 2]], c: [['c1', 2], ['c2', 2]] } },
]
const SEGMENTS = [
  { key: 'a', days: 5, range: '10-20→10-24' },
  { key: 'b', days: 5, range: '10-25→10-29' },
  { key: 'c', days: 4, range: '10-30→11-02' },
]
const BETTER = ['falive', 'lark-bot', 'same', 'both_wrong']
const ISSUES = ['missed', 'noisy', 'wrong_target', 'wrong_content', 'duplicate', 'stuck']
const QUALITY = ['good', 'awkward', 'wrong', 'none']

const readJsonl = (path) => {
  if (!existsSync(path)) return []
  const rows = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try { rows.push(JSON.parse(line)) } catch { /* 写到一半的行跳过 */ }
  }
  return rows
}
const readJson = (path, fallback) => {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return fallback }
}
const one = (t, n) => String(t || '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').slice(0, n)
const count = (rows, field) => {
  const d = {}
  for (const r of rows) d[r[field]] = (d[r[field]] || 0) + 1
  return d
}

let runningCmds = ''
try { runningCmds = execFileSync('ps', ['-axo', 'command'], { encoding: 'utf8' }) } catch { /* 拿不到就只看 sim.log */ }
// 只认 `sh scripts/sim/run-days.sh <start> <end> <sim> [port]` 本身（别的 shell 包装命令行里也可能出现 run-days.sh 和 sim 名）。
const runDaysAlive = (name) => runningCmds.split('\n').some((line) => {
  const tokens = line.trim().split(/\s+/)
  return /(^|\/)(sh|bash|zsh)$/.test(tokens[0] || '') && /(^|\/)run-days\.sh$/.test(tokens[1] || '') && tokens[4] === name
})

const loadSim = (name, segment) => {
  const dir = join(replayRoot, 'sim', name)
  if (!existsSync(dir)) return null
  const log = existsSync(join(dir, 'sim.log')) ? readFileSync(join(dir, 'sim.log'), 'utf8').split('\n').filter(Boolean) : []
  const windows = log.filter((l) => l.includes('[sim] 窗口')).length
  const alive = runDaysAlive(name)
  const done = !alive && windows === segment.days && String(log.at(-1) || '').includes('[sim] 完成')
  const tasks = []
  const tasksDir = join(dir, 'runtime', 'lark-tasks')
  if (existsSync(tasksDir)) for (const f of readdirSync(tasksDir)) if (f.endsWith('.json')) { const t = readJson(join(tasksDir, f), null); if (t) tasks.push(t) }
  return {
    name,
    done,
    progress: `${windows}/${segment.days} 天${alive ? '，在跑' : ''}`,
    fed: readJson(join(dir, 'fed.json'), []),
    outbox: readJsonl(join(dir, 'outbox.jsonl')),
    judge: readJsonl(join(dir, 'judge.jsonl')),
    tasks,
  }
}

// 切半跑的段：各半合并（done = 都完成；fed / outbox / judge / tasks 拼接；进度写各半）。一半都没有就 null。
const loadParts = (round, segment) => {
  const parts = round.parts[segment.key].map(([key, days]) => loadSim(`${round.prefix}-${key}`, { ...segment, days }))
  if (parts.every((p) => !p)) return null
  const got = parts.filter(Boolean)
  return {
    name: got.map((p) => p.name).join('+'),
    done: parts.every((p) => p?.done),
    progress: parts.map((p, i) => `${round.parts[segment.key][i][0]} ${p ? p.progress : '没起'}`).join('，'),
    fed: got.flatMap((p) => p.fed),
    outbox: got.flatMap((p) => p.outbox),
    judge: got.flatMap((p) => p.judge),
    tasks: got.flatMap((p) => p.tasks),
  }
}

const dupes = (outbox) => {
  const seen = new Set()
  let n = 0
  for (const o of outbox) {
    if (!o.parentId) continue
    const key = `${o.parentId}|${String(o.text || '').slice(0, 60)}`
    if (seen.has(key)) n += 1
    seen.add(key)
  }
  return n
}
const betterCell = (rows) => {
  if (!rows.length) return '—'
  const d = count(rows, 'better')
  return BETTER.map((k) => d[k] || 0).join(' / ')
}

const rounds = ROUNDS.map((round) => ({
  ...round,
  segs: SEGMENTS.map((segment) => ({ segment, sim: round.parts ? loadParts(round, segment) : loadSim(`${round.prefix}-${segment.key}`, segment) })),
}))

const lines = ['# falive 回放模拟总览', '', `生成于 ${new Date().toISOString()}；数据目录 ${join(replayRoot, 'sim')}`, '']

// 1. 总表
lines.push('## 1. 胜负总表', '', '单元格 = falive 更好 / lark-bot 更好 / 一样 / 都不对（judge.jsonl 条数；未完的段是已判部分）', '')
lines.push(`| 轮次 | ${SEGMENTS.map((s) => `${s.key}（${s.range}）`).join(' | ')} | 合计 | 完成度 |`, `|---|${SEGMENTS.map(() => '---').join('|')}|---|---|`)
for (const r of rounds) {
  const cells = r.segs.map(({ sim }) => (!sim ? '缺' : `${betterCell(sim.judge)}${sim.done ? '' : '（未完）'}`))
  const allJudge = r.segs.flatMap(({ sim }) => sim?.judge || [])
  const status = r.segs.map(({ segment, sim }) => `${segment.key}:${!sim ? '缺' : sim.done ? '完成' : `未完 ${sim.progress}`}`).join('；')
  lines.push(`| ${r.label}（${r.prefix}） | ${cells.join(' | ')} | ${betterCell(allJudge)} | ${status} |`)
}
lines.push('')

// 2. 问题类型
lines.push('## 2. larkIssue 分布（排除 none）', '', `| 轮次 | ${ISSUES.join(' | ')} | 其它 |`, `|---|${ISSUES.map(() => '---').join('|')}|---|`)
for (const r of rounds) {
  const rows = r.segs.flatMap(({ sim }) => sim?.judge || []).filter((j) => j.larkIssue && j.larkIssue !== 'none')
  const d = count(rows, 'larkIssue')
  const other = Object.entries(d).filter(([k]) => !ISSUES.includes(k)).reduce((s, [, v]) => s + v, 0)
  lines.push(`| ${r.label} | ${ISSUES.map((k) => d[k] || 0).join(' | ')} | ${other} |`)
}
lines.push('')

// 3. 运营指标
lines.push('## 3. 运营指标', '', '| 轮次 | 段 | 已喂 | 群里回复 | 重复回复 | 私信 aven | failed | 任务终态 |', '|---|---|---|---|---|---|---|---|')
for (const r of rounds) for (const { segment, sim } of r.segs) {
  if (!sim) { lines.push(`| ${r.label} | ${segment.key} | 缺 | | | | | |`); continue }
  const status = count(sim.tasks, 'status')
  const dist = Object.entries(status).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join(' ') || '—'
  lines.push(`| ${r.label} | ${segment.key}${sim.done ? '' : '（未完）'} | ${sim.fed.length} | ${sim.outbox.filter((o) => o.kind === 'reply').length} | ${dupes(sim.outbox)} | ${sim.outbox.filter((o) => o.kind === 'send' && o.userId === AVEN_OPEN_ID).length} | ${status.failed || 0} | ${dist} |`)
}
lines.push('')

// 4. 最新一轮仍比 falive 差
const latest = [...rounds].reverse().find((r) => r.segs.some(({ sim }) => sim?.judge.length))
lines.push('## 4. 仍比 falive 差（最新一轮）', '')
if (!latest) lines.push('还没有任何 judge.jsonl。', '')
else {
  const missingSegs = latest.segs.filter(({ sim }) => !sim?.judge.length).map(({ segment }) => segment.key)
  const unfinished = latest.segs.filter(({ sim }) => sim && !sim.done).map(({ segment }) => segment.key)
  lines.push(`取 ${latest.label}（${latest.prefix}-*）${missingSegs.length ? `；段 ${missingSegs.join('/')} 还没有裁判结果` : ''}${unfinished.length ? `；段 ${unfinished.join('/')} 未完` : ''}`, '')
  const worse = latest.segs.flatMap(({ segment, sim }) => (sim?.judge || []).filter((j) => j.better === 'falive').map((j) => ({ ...j, seg: segment.key })))
  const groups = new Map()
  for (const j of worse) {
    const key = j.larkIssue || 'none'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(j)
  }
  if (!worse.length) lines.push('没有 better=falive 的条目。', '')
  for (const [issue, rows] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`### ${issue}（${rows.length}）`, '')
    for (const j of rows.sort((a, b) => String(a.at).localeCompare(String(b.at)))) {
      const stamp = String(j.at || '').slice(5, 16).replace('T', ' ')
      lines.push(`- ${stamp} [${j.seg}] ${j.chatKey} ${j.sender}：「${one(j.text, 60)}」—— ${one(j.reason, 300)}`)
    }
    lines.push('')
  }
}

// 5. L1
lines.push('## 5. L1 分类回放', '')
const l1Dir = join(replayRoot, 'l1')
const l1Runs = existsSync(l1Dir) ? readdirSync(l1Dir).filter((d) => existsSync(join(l1Dir, d, 'judge.jsonl'))).sort() : []
if (!l1Runs.length) lines.push('l1/ 下没有 judge.jsonl。', '')
else {
  lines.push(`| run | 条数 | falive / lark-bot / same / both_wrong | ${QUALITY.join(' / ')} |`, '|---|---|---|---|')
  for (const run of l1Runs) {
    const rows = readJsonl(join(l1Dir, run, 'judge.jsonl'))
    const b = count(rows, 'better')
    const q = count(rows, 'larkReplyQuality')
    lines.push(`| ${run} | ${rows.length} | ${BETTER.map((k) => b[k] || 0).join(' / ')} | ${QUALITY.map((k) => q[k] || 0).join(' / ')} |`)
  }
  lines.push('')
}

const text = lines.join('\n')
if (out) {
  writeFileSync(out, text)
  console.log(`写到 ${out}`)
} else console.log(text)
