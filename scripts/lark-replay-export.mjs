#!/usr/bin/env node
/**
 * 把运行中 runtime 里带分类结果的任务导出成固定回放集（第 3 批：回放集从 6 条扩到全部历史）。
 *   node scripts/lark-replay-export.mjs [--runtime <dir>] [--repo falive] [--out __tests__/fixtures/falive-intake]
 * 线上判定搬到 intake.classification_at_capture 作基线标签；附件只留元数据（去掉本地路径）。已存在的文件不覆盖。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { larkRuntimeDir } from '../lib/lark-paths.mjs'

const args = process.argv.slice(2)
const flag = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback }
const runtimeDir = flag('--runtime', larkRuntimeDir)
const repo = flag('--repo', 'falive')
const out = flag('--out', join(new URL('..', import.meta.url).pathname, '__tests__/fixtures/falive-intake'))
mkdirSync(out, { recursive: true })
const dir = join(runtimeDir, 'lark-tasks')
let exported = 0
for (const name of readdirSync(dir).filter((item) => item.endsWith('.json'))) {
  let task
  try { task = JSON.parse(readFileSync(join(dir, name), 'utf8')) } catch { continue }
  if (task.repo !== repo || !task.text || !task.intake?.classification) continue
  const target = join(out, `${task.id}.json`)
  if (existsSync(target)) continue
  const { classification, ...intakeRest } = task.intake
  const fixture = {
    ...task,
    intake: { ...intakeRest, classification_at_capture: classification },
    attachments: (task.attachments || []).map(({ localPath, ...meta }) => meta),
    receipts: undefined,
  }
  writeFileSync(target, `${JSON.stringify(fixture, null, 2)}\n`)
  exported += 1
}
console.log(`exported ${exported} → ${out}`)
