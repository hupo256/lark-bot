#!/usr/bin/env node
/**
 * 校准差异汇总（design-v2 §8 P1）：读 replay/falive/calibration/<组>.json（falive 当时 vs falive 代码在模拟器里），
 * 逐 case 比：分类决策、终态、群里说没说 / 说了几句、首句时延、看到的上下文差几行；按「对得上 / 抽样差异 / 模拟偏差嫌疑」归类，写 calibration/diff.md。
 *   node scripts/sim/calibration-summary.mjs
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { casesDir } from './falive-data.mjs'

const dir = join(casesDir, 'calibration')
const tags = new Map(readFileSync(join(casesDir, 'case-tags.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { const t = JSON.parse(l); return [t.id, t] }))
const rows = []
for (const f of readdirSync(dir).filter((x) => /^ep-.*\.json$/.test(x))) {
  const c = JSON.parse(readFileSync(join(dir, f), 'utf8'))
  for (const k of c.cases || []) {
    const fa = k.classified?.falive?.decision || null
    const si = k.classified?.sim?.decision || null
    const fg = k.group?.falive || []
    const sg = k.group?.sim || []
    const ctxDiff = (k.seen?.onlyFalive?.length || 0) + (k.seen?.onlySim?.length || 0)
    const ctxBase = Math.max(k.seen?.falive || 0, k.seen?.sim || 0, 1)
    const issues = []
    if (fa !== si) issues.push(fa && si ? '分类不同' : !si ? '模拟没分类' : 'falive 当时没分类')
    if ((k.status?.falive || null) !== (k.status?.sim || null)) issues.push('终态不同')
    if (Boolean(fg.length) !== Boolean(sg.length)) issues.push(fg.length ? '模拟没说话' : '模拟多说话')
    if (ctxDiff / ctxBase > 0.2) issues.push(`上下文差 ${ctxDiff} 行`)
    rows.push({ ep: c.episode?.id || f.replace(/\.json$/, ''), id: k.id, label: k.label, text: String(k.text || '').replace(/\s+/g, ' ').slice(0, 60), fa, si, fs: k.status?.falive || null, ss: k.status?.sim || null, fn: fg.length, sn: sg.length, ctxDiff, ctxBase, issues, pending: Boolean(tags.get(k.id)?.pending) })
  }
}
const scored = rows.filter((r) => !r.pending)
const ok = scored.filter((r) => !r.issues.length)
const count = (pred) => scored.filter(pred).length
const md = [`# 校准差异汇总（${rows.length} 条 case，待办不计分 ${rows.length - scored.length} 条）`, '',
  `计分的 ${scored.length} 条：完全对得上 ${ok.length}（${Math.round((ok.length / Math.max(scored.length, 1)) * 100)}%）`, '',
  '| 差异 | 条数 |', '|---|---|',
  ...['分类不同', '模拟没分类', 'falive 当时没分类', '终态不同', '模拟没说话', '模拟多说话'].map((k) => `| ${k} | ${count((r) => r.issues.includes(k))} |`),
  `| 上下文差 >20% | ${count((r) => r.issues.some((i) => i.startsWith('上下文差')))} |`, '',
  '## 有差异的 case', '',
  '| 组 | case | 原话 | 分类 falive→模拟 | 终态 | 群里句数 | 上下文差 | 差异 |', '|---|---|---|---|---|---|---|---|',
  ...rows.filter((r) => r.issues.length).map((r) => `| ${r.ep} | ${r.label}${r.pending ? '（待办）' : ''} | ${r.text.replace(/\|/g, '\\|')} | ${r.fa || '—'}→${r.si || '—'} | ${r.fs || '—'}→${r.ss || '—'} | ${r.fn}→${r.sn} | ${r.ctxDiff}/${r.ctxBase} | ${r.issues.join('、')} |`)]
writeFileSync(join(dir, 'diff.md'), `${md.join('\n')}\n`)
console.log(md.slice(0, 13).join('\n'))
