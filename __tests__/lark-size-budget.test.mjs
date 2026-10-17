import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'

// 体量预算（第 4 批治理）：lib/ 新文件 ≤ 600 行；已经超线的老文件只许变小，不许再长（快照见下）。
// 要往大文件里加东西，先拆出去——这是让 bot 不再变重的机械闸。
const root = resolve(new URL('..', import.meta.url).pathname)
const LINE_BUDGET = 600
const LEGACY_SNAPSHOT = {
  'lib/lark-task-runner.mjs': 900,
  'lib/lark-ai-executor.mjs': 720,
  'lib/lark-ingest.mjs': 830,
  'lib/lark-daily-report.mjs': 830,
  'lib/lark-task-store.mjs': 760,
  'lib/lark-scope-contract.mjs': 730,
  'lib/lark-worker-prompts.mjs': 660,
}
const countLines = (file) => readFileSync(join(root, file), 'utf8').split('\n').length

describe('体量预算', () => {
  it('lib/*.mjs 与入口文件不超线', () => {
    const files = [...readdirSync(join(root, 'lib')).filter((name) => name.endsWith('.mjs')).map((name) => `lib/${name}`), 'lark-gateway.mjs', 'lark-worker.mjs']
    const offenders = []
    for (const file of files) {
      const lines = countLines(file)
      const budget = LEGACY_SNAPSHOT[file] ?? LINE_BUDGET
      if (lines > budget) offenders.push(`${file} ${lines} 行 > ${budget}`)
    }
    assert.deepEqual(offenders, [], `超过体量预算：${offenders.join('；')}（先拆文件，不要加预算）`)
  })
})
