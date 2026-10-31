import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { ACCEPTED_FILE, applyMutation, changedLinesFromDiff, codeMask, findSites, isAccepted, sampleSites } from '../scripts/mutate.mjs'
import { runSteps } from './support/steps.mjs'

const ops = (sites) => sites.map((site) => `${site.line}:${site.from.trim()}→${site.to.trim()}`)

describe('变异测试工具（scripts/mutate.mjs）', () => {
  it('只在代码位置找变异点、注入可逆、diff 只取新增行、豁免按文件 + 代码行 + 算子匹配', () => runSteps([
    ['字符串 / 模板文字 / 注释里的运算符不算，模板 ${} 里的算', () => {
      const source = [
        "const a = x === 1 && y",
        "const s = 'a || b' + \"c && d\"",
        'const t = `文字 a || b ${p || q} 尾 ${ { k: 1 }.k > 0 } 完`',
        '// x === y 注释',
        '/* a && b */ const z = m !== n',
      ].join('\n')
      assert.deepEqual(ops(findSites('lib/x.mjs', source)), ['1:===→!==', '1:&&→||', '3:||→&&', '3:>→>=', '5:!==→==='])
      const mask = codeMask("'x' + y")
      assert.equal(mask[1], 0)
      assert.equal(mask[6], 1)
    }],
    ['同一行同一算子的每一处都算；import / console 行、=> 和 return trueish 不算', () => {
      const source = [
        "import { a } from './a.mjs'",
        'export { a }',
        "console.log(a || b)",
        'const f = (v) => v > 1 || v < -1 || v >= 9',
        'return trueValue',
        'return false',
      ].join('\n')
      assert.deepEqual(ops(findSites('lib/x.mjs', source)), ['4:||→&&', '4:||→&&', '4:>=→>', '4:>→>=', '4:<→<=', '6:return false→return true'])
    }],
    ['注入只改那一处、能还原；位置对不上直接报错', () => {
      const source = 'if (a || b || c) go()'
      const [, second] = findSites('lib/x.mjs', source)
      assert.equal(applyMutation(source, second), 'if (a || b && c) go()')
      assert.throws(() => applyMutation('if (a && b) go()', second), /变异点对不上/)
    }],
    ['git diff -U0 → 新版改动行号（删除块没有新行、新文件全算）', () => {
      const diff = [
        'diff --git a/lib/a.mjs b/lib/a.mjs',
        '--- a/lib/a.mjs',
        '+++ b/lib/a.mjs',
        '@@ -3 +3 @@',
        '@@ -10,2 +11,3 @@',
        '@@ -20,4 +22,0 @@',
        'diff --git a/lib/gone.mjs b/lib/gone.mjs',
        '--- a/lib/gone.mjs',
        '+++ /dev/null',
        '@@ -1,5 +0,0 @@',
      ].join('\n')
      const changed = changedLinesFromDiff(diff)
      assert.deepEqual([...changed['lib/a.mjs']], [3, 11, 12, 13])
      assert.equal(changed['lib/gone.mjs'], undefined)
    }],
    ['豁免按文件 + 代码行文本 + 算子匹配，行号无关；抽样可复现且不重复', () => {
      const [site] = findSites('lib/x.mjs', '\n\nconst a = b || c')
      const entry = { file: 'lib/x.mjs', code: 'const a = b || c', op: '|| → &&', reason: '等价' }
      assert.equal(isAccepted(site, [entry]), true)
      assert.equal(isAccepted(site, [{ ...entry, op: '&& → ||' }]), false)
      assert.equal(isAccepted(site, [{ ...entry, file: 'lib/y.mjs' }]), false)
      const [onA, onB] = findSites('lib/x.mjs', 'if (!p || p.d || !p.n) go()')
      const one = { file: 'lib/x.mjs', code: 'if (!p || p.d || !p.n) go()', op: '|| → &&', col: onA.col, reason: '只豁免第一处' }
      assert.deepEqual([isAccepted(onA, [one]), isAccepted(onB, [one])], [true, false], '带 col 只豁免该行那一处')
      const pool = Array.from({ length: 50 }, (_, index) => ({ id: index }))
      const first = sampleSites(pool, 10, 3)
      assert.deepEqual(first, sampleSites(pool, 10, 3))
      assert.equal(new Set(first.map((item) => item.id)).size, 10)
    }],
    ['豁免清单每条都对得上现存代码、写了原因、算子合法：代码改了留下的过期条目当场报出来（10-24）', () => {
      const accepted = JSON.parse(readFileSync(new URL(`../${ACCEPTED_FILE}`, import.meta.url), 'utf8'))
      const stale = accepted.filter((item) => !readFileSync(new URL(`../${item.file}`, import.meta.url), 'utf8').split('\n').some((line) => line.trim() === item.code))
      assert.deepEqual(stale.map((item) => `${item.file}｜${item.code}`), [], '过期豁免：代码行已不存在，删掉或按新代码重新判断')
      const ops = new Set(['=== → !==', '!== → ===', '&& → ||', '|| → &&', '>= → >', '<= → <', '> → >=', '< → <=', 'return true → return false', 'return false → return true'])
      assert.deepEqual(accepted.filter((item) => !ops.has(item.op) || String(item.reason || '').trim().length < 10).map((item) => item.code), [], '算子要合法、原因要写清')
    }],
  ]))
})
