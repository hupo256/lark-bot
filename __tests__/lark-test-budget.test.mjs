import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { eachCase, runSteps } from './support/steps.mjs'

// 测试体量棘轮（aven 2026-10-23：925 个测试只增不减，后面会爆掉）。和体量预算 / 提示词预算一样做成测试：
// 静态统计 it( 的个数，只许持平或变少。要加测试先看能不能：① 并进现有用例表（加一行，循环里的 it 只算一个）；
// ② 同一次提交删掉被新口径取代的旧测试。合并多条原用例进一个 it 时必须用 support/steps.mjs 的 runSteps / eachCase
// （每段都跑、失败全报、每段 before / after 隔离），不许写一失败就停的循环或本地 step（aven 2026-10-24：优化不能以健壮性为代价）。
//确实要净增，就在同一次提交里调高 TEST_CASE_BUDGET 并在提交说明里写原因。
// 运行时间预算（全量 ≤ 15 秒）在 scripts/test-all.mjs（合并前跑），测试里量不了自己。
const TEST_CASE_BUDGET = 335 // 10-24 +1：变异测试工具 scripts/mutate.mjs 的纯函数测试（新模块一条用例）。同日 +2：棘轮改为连 test( 一起数（lark-worktree-deps 原有 2 个 test( 之前漏数，不是新增）。同日 +1：合并用例的执行器与调用约束（support/steps.mjs 自检 + 调用处必须 await、禁本地 step）。同日 10-24 合并细碎 it：929 → 331（aven「900+ 测试太多」）；断言不删，原标题进断言 message / 用例表 name。之前 10-23 +2 lark-bug-record、+7 lark-deploy-watch（#84）

const dir = dirname(fileURLToPath(import.meta.url))
// it( 和 test( 都算（10-24 前只数 it(，lark-worktree-deps 的 test( 漏数）。
export const countTestCases = (source) => (source.match(/^\s*(it|test)\(/gm) || []).length

describe('测试体量棘轮', () => {
  it(`it( 总数不超过 ${TEST_CASE_BUDGET}（只许持平或变少）`, () => {
    const files = readdirSync(dir).filter((name) => name.endsWith('.test.mjs'))
    const counts = files.map((name) => [name, countTestCases(readFileSync(join(dir, name), 'utf8'))])
    const total = counts.reduce((sum, [, n]) => sum + n, 0)
    const top = counts.sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, n]) => `${name} ${n}`).join('、')
    assert.ok(total <= TEST_CASE_BUDGET, `测试 ${total} 个，超过棘轮 ${TEST_CASE_BUDGET}（最多的：${top}）。先并进现有用例表、删掉被取代的旧测试；确实要净增就同一次提交调高 TEST_CASE_BUDGET 并写明原因`)
  })
})

// 合并用例的健壮性闸（aven 2026-10-24）：执行器本身不能吞错，调用处不能漏 await，各文件不能另写会一失败就停的本地 step。
// 调用 runSteps / eachCase 的行必须是 return / await / 箭头直接返回（`=> runSteps(`），否则段失败会变成没人接的 rejection。
// 箭头换行写法（上一行以 => 结尾、本行以 runSteps( 开头）也算直接返回；本文件自测里的反例字符串不算调用。
export const unawaitedStepCalls = (source) => {
  const lines = source.split('\n')
  return lines
    .map((line, index) => [index + 1, line, lines[index - 1] || ''])
    .filter(([, line, prev]) => /\b(runSteps|eachCase)\(/.test(line) && !/^\s*(import\b|\/\/|\*)/.test(line) && !line.includes('unawaitedStepCalls(')
      && !/(\breturn|\bawait|=>)\s*(runSteps|eachCase)\(/.test(line) && !(/=>\s*$/.test(prev) && /^\s*(runSteps|eachCase)\(/.test(line)))
    .map(([line, text]) => [line, text])
}
const LOCAL_STEP_HELPER = /^\s*(const|let|function)\s+(step|freshStep|scenario|seg)\b/m

describe('合并用例的执行器与调用约束', () => {
  it('runSteps 每段都跑、失败全报带原标题、清理照跑；eachCase 每行都跑；调用处都 await、没有本地 step、没有无上限空转等待', async () => {
    const ran = []
    const error = await runSteps([
      ['段一', () => { ran.push('1'); assert.equal(1, 2) }],
      ['段二', () => { ran.push('2') }],
      ['段三', async () => { ran.push('3'); throw new Error('坏了') }],
    ], { before: () => ran.push('before'), after: () => ran.push('after') }).then(() => null, (caught) => caught)
    assert.ok(error, '有段失败必须抛错，不能吞掉')
    assert.deepEqual(ran, ['before', '1', 'after', 'before', '2', 'after', 'before', '3', 'after'], '每段都跑、每段前后 hooks 各一次、失败也清理')
    assert.match(error.message, /^2 \/ 3 段失败/)
    assert.match(error.message, /▶ 段一 ◀/)
    assert.match(error.message, /▶ 段三 ◀ 坏了/)
    assert.doesNotMatch(error.message, /段二/)
    const cleanup = await runSteps([['只有清理坏', () => {}]], { after: () => { throw new Error('清理炸了') } }).then(() => null, (caught) => caught)
    assert.match(cleanup?.message || '', /▶ 只有清理坏（清理） ◀ 清理炸了/, '清理失败也要报')
    await runSteps([['全过', () => {}]])
    const rows = []
    const tableError = await eachCase([{ name: '行一', v: 1 }, { name: '行二', v: 2 }, { v: 3 }], ({ v }) => { rows.push(v); assert.equal(v, 1) }).then(() => null, (caught) => caught)
    assert.deepEqual(rows, [1, 2, 3], '用例表每行都跑')
    assert.match(tableError?.message || '', /2 \/ 3 段失败[\s\S]*▶ 行二 ◀[\s\S]*▶ 第 3 行 ◀/)

    assert.deepEqual(unawaitedStepCalls("it('x', () => runSteps([]))\n  await runSteps([])\n  return eachCase([], f)\nimport { runSteps } from 'x'\nit('y', () =>\n  runSteps([]))"), [])
    assert.deepEqual(unawaitedStepCalls("it('x', () => {\n  runSteps([])\n})").map(([line]) => line), [2])
    const files = readdirSync(dir).filter((name) => name.endsWith('.test.mjs'))
    const bad = files.flatMap((name) => unawaitedStepCalls(readFileSync(join(dir, name), 'utf8')).map(([line]) => `${name}:${line}`))
    assert.deepEqual(bad, [], 'runSteps / eachCase 调用必须 return / await')
    const local = files.filter((name) => LOCAL_STEP_HELPER.test(readFileSync(join(dir, name), 'utf8')))
    assert.deepEqual(local, [], '合并用例统一用 support/steps.mjs，不另写本地 step / freshStep / scenario / seg')
    const spinning = files.filter((name) => /while \(!?[\w.]+\) await/.test(readFileSync(join(dir, name), 'utf8')))
    assert.deepEqual(spinning, [], '等桩被调用用 support/steps.mjs 的 waitUntil（有上限），不写无上限的 while 空转（10-24 变异扫描留下空转孤儿进程）')
  })
})
