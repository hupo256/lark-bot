#!/usr/bin/env node
/**
 * 金标准（docs/falive-replay-design-v2.md §5「金标准」、§8 前置 9 / P3）：全量裁判（max）之后，aven 亲自过分歧，定成 replay/falive/gold.jsonl，之后都对照它判。
 *   review  node scripts/sim/gold.mjs review --round <轮> [--out replay/falive/gold-review.md] [--again]
 *           挑「falive 更好 / 都不对 / 裁判拿不准（confidence=low）」的 case 出评审表：每条一屏（原话 + 简短上下文、falive 怎么回、
 *           lark-bot 怎么回 / 做了什么、裁判理由），aven 勾「falive 对 / lark-bot 对 / 都不对」（两边都行可勾「一样」），可写一句理想做法。
 *           同时写 <out 去掉 .md>.data.jsonl（每条的输出指纹、规范化输出、裁判结论），入库时用。已有 aven 金标准且指纹相同的跳过（--again 不跳）。
 *   ingest  node scripts/sim/gold.mjs ingest [--md replay/falive/gold-review.md | --jsonl choices.jsonl] [--round <轮>] [--gold replay/falive/gold.jsonl]
 *           把 aven 的选择并进 gold.jsonl（同 id 后来的覆盖；by=aven）。choices.jsonl 一行 {id, choice: falive|lark-bot|both_wrong|same（或中文）, ideal}。
 *           带 --round：那一轮其余没进评审表、裁判判 same / lark-bot 且不是 low 的，按裁判结论补进金标准（by=judge），不覆盖 aven 的。
 *   compare node scripts/sim/gold.mjs compare --round <轮> [其余参数同 judge-sim]
 *           = judge-sim.mjs --gold：输出指纹等于金标准审过的那版 → 沿用金标准结论；否则模型判，带金标准理想做法作参照。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { casesDir } from './falive-data.mjs'
import { contextLinesOf, faliveRepliesOf, loadJudgeData } from './judge-data.mjs'
import { listSimDirs, readJsonl, simSelectorFromArgs } from './sim-dir.mjs'

export const CHOICES = [
  { better: 'falive', label: 'falive 对' },
  { better: 'lark-bot', label: 'lark-bot 对' },
  { better: 'both_wrong', label: '都不对' },
  { better: 'same', label: '一样（两边都行）' },
]
const CHOICE_ALIASES = { falive: 'falive', 'falive 对': 'falive', 'lark-bot': 'lark-bot', 'lark-bot 对': 'lark-bot', both_wrong: 'both_wrong', 都不对: 'both_wrong', same: 'same', 一样: 'same', '一样（两边都行）': 'same' }
export const choiceToBetter = (choice) => CHOICE_ALIASES[String(choice || '').trim()] || null

const one = (t, n) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, n)
const fmt = (ms) => new Date(ms).toISOString().slice(5, 16).replace('T', ' ')
const after = (ms) => (ms == null ? '-' : ms < 60_000 ? `+${Math.round(ms / 1000)} 秒` : `+${Math.round(ms / 60_000)} 分钟`)
const quote = (text, n) => String(text || '').slice(0, n).split('\n').map((l) => `> ${l}`).join('\n')

/** 评审表挑哪些：falive 更好 / 都不对 / 裁判拿不准；待办不计分的不进。同一 case 在多个 sim 目录里（旧布局热身重叠）取第一个。 */
export const selectForReview = ({ judgeLines, gold = new Map(), again = false }) => {
  const seen = new Set()
  return judgeLines.filter((l) => {
    if (l.better === 'pending' || seen.has(l.id)) return false
    if (!(l.better === 'falive' || l.better === 'both_wrong' || l.confidence === 'low')) return false
    const g = gold.get(l.id)
    if (!again && g?.by === 'aven' && g.reviewedFingerprint === l.fingerprint) return false
    seen.add(l.id)
    return true
  }).sort((a, b) => String(a.at).localeCompare(String(b.at)))
}

/** 一条一屏。item：{ line（judge.jsonl 行）, rule（rules.jsonl 行）, m（时间线消息）, context[], faliveReplies[], evidence, parent } */
export const renderReviewItem = ({ line, rule, m, context = [], faliveReplies = [], evidence = null, parent = null }, index, total) => {
  const lark = rule?.lark || {}
  const tags = [line.kind || '-', line.risk?.length ? `风险 ${line.risk.join('/')}` : '无风险标签'].join(' · ')
  const out = [
    `## ${index}/${total} · ${fmt(m.atMs)} · ${m.chatKey === 'webhook-group' ? '负责人私信' : m.chatName} · ${m.senderName} \`${line.id.slice(-8)}\``,
    `<!-- gold:${line.id} -->`,
    `${tags} · 裁判 **${line.better}**/${line.confidence || '-'}（${line.larkIssue || '-'} · ${line.cause || '-'}） · ${line.sim}`,
    '',
    quote(m.text, 600),
    ...(parent ? ['', `被回复的：${parent.senderName}${parent.ownBot ? '（bot）' : ''}：${one(parent.text, 160)}`] : []),
    '',
    `上文：${context.length ? '' : '（无）'}`,
    ...context.slice(-4).map((c) => `- ${one(c, 160)}`),
    '',
    `**falive 当时**（${line.falive || '-'}）：${faliveReplies.length ? '' : '没回'}`,
    ...faliveReplies.slice(0, 2).map((r) => `- （${after(r.atMs - m.atMs)}）${one(r.text, 300)}`),
    '',
    `**lark-bot 这次**（${line.larkBot || '-'}；交付物 ${lark.deliverable || '-'}；群里 ${lark.replyCount ?? '-'} 条 / 私信 aven ${lark.dmToAven ?? '-'} 条${lark.duplicates ? ` / 重复 ${lark.duplicates}` : ''}${lark.mergedInto ? ` / 并入 ${lark.mergedInto.slice(-8)}` : ''}）：${lark.lines?.length ? '' : '没回'}`,
    ...(lark.lines || []).slice(0, 3).map((l) => `- （${after(l.afterMs)}，${l.channel === 'dm' ? '私信' : '群里'}）${one(l.text, 300)}`),
    ...(evidence ? ['', `falive 当时实测证据（${(evidence.env || []).join('/') || '-'}${evidence.envDownThen ? '，当时环境挂了' : ''}）：${one(evidence.evidence, 200) || '无'}`] : []),
    '',
    `**裁判**：${one(line.reason, 200)}；理想：${one(line.idealBehavior, 120)}`,
    '',
    '**aven 选**（把一个 [ ] 改成 [x]）：',
    ...CHOICES.map((c) => `- [ ] ${c.label}`),
    '- 理想做法：',
    '',
    '---',
    '',
  ]
  return out.join('\n')
}

/** 解析 aven 改过的评审表：每节一个 <!-- gold:<id> -->，取勾上的那项与「理想做法：」后面的话。勾了多项 / 没勾的进 problems / 跳过。 */
export const parseReviewMd = (text) => {
  const picks = []
  const problems = []
  const sections = String(text).split(/<!-- gold:(om_[A-Za-z0-9_]+) -->/)
  for (let i = 1; i < sections.length; i += 2) {
    const id = sections[i]
    const body = sections[i + 1].split(/\n---\s*\n/)[0]
    const checked = [...body.matchAll(/^\s*-\s*\[(?:x|X|✓|√)\]\s*(.+?)\s*$/gm)].map((x) => choiceToBetter(x[1]))
    const ideal = (body.match(/^\s*-\s*理想做法[：:]\s*(.*)$/m)?.[1] || '').trim()
    if (checked.length > 1) { problems.push({ id, problem: '勾了多项' }); continue }
    if (!checked.length) { if (ideal) problems.push({ id, problem: '写了理想做法但没勾选' }); continue }
    if (!checked[0]) { problems.push({ id, problem: '勾选项认不出' }); continue }
    picks.push({ id, better: checked[0], ideal })
  }
  return { picks, problems }
}

/** 并进金标准：aven 的覆盖一切；judge 的只补空位、不覆盖 aven 的。 */
export const mergeGold = (existing, incoming) => {
  const out = new Map(existing)
  for (const g of incoming) {
    const prev = out.get(g.id)
    if (g.by === 'judge' && prev?.by === 'aven') continue
    out.set(g.id, g)
  }
  return out
}

const goldEntry = ({ id, better, ideal, by, data }) => ({
  id, better, ideal: ideal || data?.judge?.idealBehavior || '', by,
  larkIssue: better === 'falive' || better === 'both_wrong' ? data?.judge?.larkIssue || null : 'none',
  cause: data?.judge?.cause || null,
  reviewedFingerprint: data?.fingerprint || null,
  reviewedSim: data?.sim || null,
  reviewedOutput: data?.output || null,
  judge: data?.judge || null,
  at: new Date().toISOString(),
})

const roundLines = (selector) => {
  const judgeLines = []
  const rules = new Map()
  for (const s of listSimDirs(selector)) {
    for (const l of readJsonl(join(s.dir, 'judge.jsonl'))) judgeLines.push(l)
    for (const r of readJsonl(join(s.dir, 'rules.jsonl'))) rules.set(`${s.label}\0${r.id}`, r)
  }
  return { judgeLines, rules }
}
const dataOf = (line, rule) => ({ id: line.id, sim: line.sim, fingerprint: line.fingerprint, output: rule?.lark?.output || null, judge: { better: line.better, confidence: line.confidence, reason: line.reason, larkIssue: line.larkIssue, cause: line.cause, idealBehavior: line.idealBehavior, promptVersion: line.promptVersion, effort: line.effort } })

const main = () => {
  const [cmd, ...args] = process.argv.slice(2)
  const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
  const goldPath = value('--gold', join(casesDir, 'gold.jsonl'))
  const gold = new Map(readJsonl(goldPath).map((g) => [g.id, g]))
  if (cmd === 'review') {
    const outPath = value('--out', join(casesDir, 'gold-review.md'))
    const { judgeLines, rules } = roundLines(simSelectorFromArgs(args))
    if (!judgeLines.length) { console.error('[gold] 没有 judge.jsonl（先跑 judge-sim.mjs）'); process.exit(2) }
    const picked = selectForReview({ judgeLines, gold, again: args.includes('--again') })
    const data = loadJudgeData()
    const blocks = picked.map((line, i) => {
      const m = data.byId.get(line.id)
      return renderReviewItem({ line, rule: rules.get(`${line.sim}\0${line.id}`), m, context: contextLinesOf(m, { data, recent: 4, max: 4, width: 160 }), faliveReplies: faliveRepliesOf(m, { data }), evidence: data.evidence.get(line.id) || null, parent: m.parentId ? data.byId.get(m.parentId) : null }, i + 1, picked.length)
    })
    const scored = judgeLines.filter((l) => l.better !== 'pending')
    const head = [
      '# 金标准评审表',
      '',
      `由 \`node scripts/sim/gold.mjs review\` 生成（${new Date().toISOString().slice(0, 16)}）。裁判 ${scored.length} 条里挑了 ${picked.length} 条：falive 更好 / 都不对 / 裁判拿不准。`,
      '每条勾一个：falive 对 / lark-bot 对 / 都不对（两边都行勾「一样」），可在「理想做法：」后写一句该怎么回。没勾的不入库。改完跑 `node scripts/sim/gold.mjs ingest`。',
      '',
      '---',
      '',
    ]
    writeFileSync(outPath, head.join('\n') + blocks.join('\n'))
    const sidecar = outPath.replace(/\.md$/, '') + '.data.jsonl'
    writeFileSync(sidecar, picked.map((l) => JSON.stringify(dataOf(l, rules.get(`${l.sim}\0${l.id}`)))).join('\n') + (picked.length ? '\n' : ''))
    console.log(`[gold] 评审表 ${outPath}（${picked.length} 条；falive ${picked.filter((l) => l.better === 'falive').length}、都不对 ${picked.filter((l) => l.better === 'both_wrong').length}、拿不准 ${picked.filter((l) => l.confidence === 'low').length}），数据 ${sidecar}`)
    return
  }
  if (cmd === 'ingest') {
    const mdPath = value('--md', join(casesDir, 'gold-review.md'))
    const jsonlPath = value('--jsonl', null)
    const sidecarPath = value('--data', mdPath.replace(/\.md$/, '') + '.data.jsonl')
    const reviewed = new Map(readJsonl(sidecarPath).map((d) => [d.id, d]))
    let picks = []
    let problems = []
    if (jsonlPath) picks = readJsonl(jsonlPath).map((r) => ({ id: r.id, better: choiceToBetter(r.choice || r.better), ideal: r.ideal || '' })).filter((p) => (p.better ? true : (problems.push({ id: p.id, problem: '选择认不出' }), false)))
    else if (existsSync(mdPath)) ({ picks, problems } = parseReviewMd(readFileSync(mdPath, 'utf8')))
    const incoming = picks.map((p) => goldEntry({ ...p, by: 'aven', data: reviewed.get(p.id) }))
    const missingData = picks.filter((p) => !reviewed.has(p.id)).map((p) => p.id)
    let accepted = 0
    if (value('--round', null) || value('--sim', null) || value('--dir', null)) {
      const { judgeLines, rules } = roundLines(simSelectorFromArgs(args))
      const pickedIds = new Set(picks.map((p) => p.id))
      const seen = new Set()
      for (const l of judgeLines) {
        if (seen.has(l.id) || pickedIds.has(l.id) || reviewed.has(l.id) || l.better === 'pending') continue
        seen.add(l.id)
        if ((l.better === 'same' || l.better === 'lark-bot') && l.confidence !== 'low') {
          incoming.push(goldEntry({ id: l.id, better: l.better, ideal: l.idealBehavior, by: 'judge', data: dataOf(l, rules.get(`${l.sim}\0${l.id}`)) }))
          accepted += 1
        }
      }
    }
    const merged = mergeGold(gold, incoming)
    const rows = [...merged.values()].sort((a, b) => a.id.localeCompare(b.id))
    writeFileSync(goldPath, rows.map((g) => JSON.stringify(g)).join('\n') + (rows.length ? '\n' : ''))
    console.log(`[gold] ${goldPath}：aven 选了 ${picks.length} 条${accepted ? `，按裁判补 ${accepted} 条` : ''}，现共 ${rows.length} 条（aven ${rows.filter((g) => g.by === 'aven').length} / 裁判 ${rows.filter((g) => g.by === 'judge').length}）`)
    for (const p of problems) console.log(`[gold] 跳过 ${p.id}：${p.problem}`)
    if (missingData.length) console.log(`[gold] ${missingData.length} 条在评审数据里找不到输出指纹（${missingData.slice(0, 5).join(', ')}）：对照时一律送模型`)
    return
  }
  if (cmd === 'compare') {
    const judge = join(dirname(fileURLToPath(import.meta.url)), 'judge-sim.mjs')
    const forwarded = args.includes('--gold') ? args : [...args, '--gold', goldPath]
    const run = spawnSync(process.execPath, [judge, ...forwarded], { stdio: 'inherit' })
    process.exit(run.status ?? 1)
  }
  console.error('用法：node scripts/sim/gold.mjs review|ingest|compare …（见文件头）')
  process.exit(2)
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main()
