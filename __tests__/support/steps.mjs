// 一个 it 里跑多段原用例（aven 2026-10-24：合并测试不能以健壮性为代价）。
// 每段都跑：前一段失败不挡后面；每段前后跑 before / after（等价于原来的 beforeEach / afterEach）；
// 最后把全部失败段一起报（每段一行「▶ 原用例标题 ◀ 说明」，重启告警按这个摘标题），带测试文件里的行号。必须 await / return，否则失败会漏（棘轮测试会查）。
import assert from 'node:assert/strict'

const where = (error) => String(error?.stack || '').split('\n').find((line) => line.includes('/__tests__/') && !line.includes('/support/'))?.trim().replace(/^at\s+/, '') || ''

export const runSteps = async (steps, { before, after } = {}) => {
  const failures = []
  for (const [name, fn] of steps) {
    try {
      await before?.()
      await fn()
    } catch (error) {
      failures.push({ name, error })
    } finally {
      try {
        await after?.()
      } catch (error) {
        failures.push({ name: `${name}（清理）`, error })
      }
    }
  }
  if (!failures.length) return
  const lines = failures.map(({ name, error }) => `▶ ${name} ◀ ${String(error?.message || error).trim()}${where(error) ? `\n    at ${where(error)}` : ''}`)
  throw new assert.AssertionError({ message: `${failures.length} / ${steps.length} 段失败：\n${lines.join('\n')}` })
}

// 用例表：每一行都跑，全部失败一起报；行的 name 是原用例标题。
export const eachCase = (cases, fn, hooks) => runSteps(cases.map((item, index) => [item?.name || `第 ${index + 1} 行`, () => fn(item)]), hooks)

// 等某个条件成立（如桩函数被调用），有上限：等不到就报错，不空转。
// 10-24：无上限的 while (!x) await setImmediate 在代码被改坏时会无限循环，变异扫描留下的孤儿进程空转了一小时。
export const waitUntil = async (check, { ticks = 10_000, what = '条件' } = {}) => {
  for (let i = 0; i < ticks; i += 1) {
    if (check()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new assert.AssertionError({ message: `等了 ${ticks} 轮还没等到：${what}` })
}
