import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'

// 体量预算（从 falive 第 4 批治理移植，10-31）：lib/ 新文件 ≤ 600 行；已经超线的老文件只许变小，不许再长（快照见下）。
// 要往大文件里加东西，先拆出去——这是让 bot 不再变重的机械闸。
const root = resolve(new URL('..', import.meta.url).pathname)
const LINE_BUDGET = 600
const LEGACY_SNAPSHOT = {
  'lib/lark-ai-executor.mjs': 829,
  'lib/lark-scope-contract.mjs': 690,
  'lib/lark-task-runner.mjs': 686,
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
