#!/usr/bin/env node
/**
 * 回放起跑前的预检闸（docs/replay/falive-replay-plan-2026-11-03.md 43；aven 11-03：「数据都没有怎么反复跑了 6 轮」）。
 * 不过就不许起跑（run-round.sh 第一步调它，非 0 退出即中止）。三类检查：
 *   数据：285 条 case 各自的上下文在不在——本条 + 父消息 + 同话题消息的附件文件都找得到、话题回复已并进时间线、
 *         提到的云文档有缓存、提到的 bug 单有记录；拉取时就失败 / 跳过的列成「已知缺口」逐条写出来，不许静默。
 *   代码：工作区干净（没提交的改动不算这一轮的代码）、包含运行分支 fameex-stable 的全部提交（「最新」）。
 *   环境：没有同名轮次在跑、没有额度暂停。
 *   node scripts/sim/preflight.mjs --round r11 [--md out.md]
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { extractLarkDocUrls, isBitableUrl } from '../../lib/lark-doc.mjs'
import { casesDir, datasetDir, rawDir, replayRoot, resolveRaw } from './falive-data.mjs'

const args = process.argv.slice(2)
const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const round = value('--round', null)
const repo = new URL('../..', import.meta.url).pathname
const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' })
const fails = []
const known = []
const lines = [`# 预检 ${round || ''}（${new Date().toISOString()}）`, '']

// —— 数据 ——
const timeline = JSON.parse(readFileSync(join(datasetDir, 'timeline.json'), 'utf8'))
const byId = new Map(timeline.map((m) => [m.id, m]))
const cases = readFileSync(join(casesDir, 'cases.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const report = JSON.parse(readFileSync(join(rawDir, 'context-cache-report.json'), 'utf8'))
const extra = JSON.parse(readFileSync(join(rawDir, 'resources-extra.json'), 'utf8')).resources || {}
const bugIndex = JSON.parse(readFileSync(join(rawDir, 'bug-records', 'index.json'), 'utf8'))
const threadMsgs = new Map()
for (const m of timeline) if (m.threadId) (threadMsgs.get(m.threadId) || threadMsgs.set(m.threadId, []).get(m.threadId)).push(m)
const knownResFail = new Set((report.resources?.failed || []).map((f) => `${f.id}/${f.key}`))
const knownDocSkip = new Set((report.docs?.skipped || []).map((s) => s.url))
const knownBugMissing = new Set(report.bugs?.missingBugIds || [])
const count = { cases: cases.length, attachments: 0, threads: 0, docs: 0, bugs: 0 }
const caseFail = (c, what) => fails.push(`case ${c.id}（${c.at.slice(5, 16)} ${c.sender}）${what}`)
for (const c of cases) {
  const m = byId.get(c.id)
  if (!m) { caseFail(c, '不在时间线里'); continue }
  const ctx = [m, m.parentId && byId.get(m.parentId), ...(m.threadId ? (threadMsgs.get(m.threadId) || []).filter((x) => x.atMs <= m.atMs) : [])].filter(Boolean)
  if (m.parentId && !byId.get(m.parentId)) caseFail(c, `父消息 ${m.parentId} 不在时间线里`)
  for (const x of new Set(ctx)) for (const r of x.resources || []) {
    count.attachments += 1
    const id = `${x.id}/${r.key}`
    const path = [r.localPath, extra[id]].map(resolveRaw).find((p) => p && existsSync(p))
    if (!path) (knownResFail.has(id) ? known : fails).push(`case ${c.id} 附件 ${id}${knownResFail.has(id) ? '（拉取时就失败）' : ' 找不到文件'}`)
  }
  if (m.threadId) {
    count.threads += 1
    const tf = join(rawDir, 'threads', `${m.threadId}.json`)
    if (!existsSync(tf)) caseFail(c, `话题 ${m.threadId} 没拉`)
    else if ((threadMsgs.get(m.threadId) || []).length < 2 && m.parentId) caseFail(c, `话题 ${m.threadId} 的回复没并进时间线`)
  }
  for (const x of new Set(ctx)) for (const url of extractLarkDocUrls(x.text || '')) {
    count.docs += 1
    const token = url.split(/[?#]/)[0].replace(/(?:%5[BD]|%2[89])+$/i, '').split('/').filter(Boolean).pop() || ''
    if (existsSync(join(rawDir, 'docs', `${token.replace(/[^\w-]/g, '_')}.json`))) continue
    if (knownDocSkip.has(url) || isBitableUrl(url)) known.push(`case ${c.id} 文档 ${url.slice(0, 90)}（拉取时跳过：多维表格等）`)
    else fails.push(`case ${c.id} 文档 ${url.slice(0, 90)} 没缓存`)
  }
  for (const bug of new Set(String(m.text || '').match(/bug-\d{3,5}/gi) || [])) {
    count.bugs += 1
    const id = bug.toLowerCase()
    if (bugIndex.byBugId?.[id] && existsSync(join(rawDir, 'bug-records', `${bugIndex.byBugId[id]}.json`))) continue
    ;(knownBugMissing.has(id) ? known : fails).push(`case ${c.id} bug 单 ${id}${knownBugMissing.has(id) ? '（表里查不到）' : ' 没有记录'}`)
  }
}
lines.push(`## 数据：${count.cases} 条 case；查了附件 ${count.attachments} 份、话题 ${count.threads} 个、文档链接 ${count.docs} 个、bug 单 ${count.bugs} 个`)

// —— 代码 ——
const head = git('rev-parse', '--short', 'HEAD').stdout.trim()
const branch = git('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim()
const dirty = git('status', '--porcelain', '--', 'lib', 'lark-gateway.mjs', 'lark-worker.mjs', 'runtime/lark-worker.mjs', 'tools', 'scripts/sim', 'replay/falive/dataset', 'replay/falive/raw', 'replay/falive/episodes.json').stdout.trim()
if (dirty) fails.push(`代码：工作区有没提交的改动（这一轮跑的不是任何一个提交）：${dirty.split('\n').slice(0, 5).join('；')}`)
const behind = git('rev-list', '--count', 'HEAD..fameex-stable').stdout.trim()
// 续跑同一轮（run-episodes 传 --resume：round.json 已钉代码指纹）：运行分支之后又进的提交下一轮再带，本轮不中途换代码（一轮只许一版代码）
if (behind !== '0' && !args.includes('--resume')) fails.push(`代码：比运行分支 fameex-stable 少 ${behind} 个提交（不是最新）：${git('log', '--oneline', 'HEAD..fameex-stable').stdout.trim().split('\n').slice(0, 5).join('；')}`)
lines.push(`## 代码：${branch} @ ${head}${behind === '0' ? '，含 fameex-stable 全部提交' : ''}`)

// —— 环境 ——
if (existsSync(join(replayRoot, 'quota-pause.json'))) {
  const p = JSON.parse(readFileSync(join(replayRoot, 'quota-pause.json'), 'utf8'))
  if (p.until > Date.now()) fails.push(`环境：Claude 额度暂停中，到 ${p.untilIso}`)
}
if (round && [`run-sim.mjs --sim ${round}-`, `run-sim.mjs --sim ${round}/`].some((p) => spawnSync('pgrep', ['-f', p]).status === 0)) fails.push(`环境：${round} 已经有段 / 组在跑`)

lines.push('', `## 结论：${fails.length ? `不通过（${fails.length} 处）` : '通过'}；已知缺口 ${known.length} 处（拉取时就拿不到，裁判时注意）`, '')
if (fails.length) lines.push('### 不通过', ...fails.slice(0, 200).map((f) => `- ${f}`), '')
if (known.length) lines.push('### 已知缺口', ...known.map((f) => `- ${f}`), '')
const text = lines.join('\n')
const out = value('--md', null)
if (out) writeFileSync(out, text)
console.log(text.split('\n').slice(0, 30).join('\n'))
process.exit(fails.length ? 1 : 0)
