import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

// 测试体量棘轮（aven 2026-10-23：925 个测试只增不减，后面会爆掉）。和体量预算 / 提示词预算一样做成测试：
// 静态统计 it( 的个数，只许持平或变少。要加测试先看能不能：① 并进现有用例表（加一行，循环里的 it 只算一个）；
// ② 同一次提交删掉被新口径取代的旧测试。确实要净增，就在同一次提交里调高 TEST_CASE_BUDGET 并在提交说明里写原因。
// 运行时间预算（全量 ≤ 15 秒）在 scripts/test-all.mjs（合并前跑），测试里量不了自己。
const TEST_CASE_BUDGET = 331 // 10-24 合并细碎 it：929 → 331（aven「900+ 测试太多」）；断言不删，原标题进断言 message / 用例表 name。之前 10-23 +2 lark-bug-record、+7 lark-deploy-watch（#84）

const dir = dirname(fileURLToPath(import.meta.url))
export const countTestCases = (source) => (source.match(/^\s*it\(/gm) || []).length

describe('测试体量棘轮', () => {
  it(`it( 总数不超过 ${TEST_CASE_BUDGET}（只许持平或变少）`, () => {
    const files = readdirSync(dir).filter((name) => name.endsWith('.test.mjs'))
    const counts = files.map((name) => [name, countTestCases(readFileSync(join(dir, name), 'utf8'))])
    const total = counts.reduce((sum, [, n]) => sum + n, 0)
    const top = counts.sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, n]) => `${name} ${n}`).join('、')
    assert.ok(total <= TEST_CASE_BUDGET, `测试 ${total} 个，超过棘轮 ${TEST_CASE_BUDGET}（最多的：${top}）。先并进现有用例表、删掉被取代的旧测试；确实要净增就同一次提交调高 TEST_CASE_BUDGET 并写明原因`)
  })
})
