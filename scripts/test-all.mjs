#!/usr/bin/env node
/**
 * 合并前跑一次全量（aven 2026-10-23）：全部测试 + 运行时间预算。改的过程中用 scripts/test-affected.mjs 只跑相关的。
 * 时间预算只在这里卡（合并前），不放进 bot 重启前的测试闸：机器忙时会变慢，不能因此让 bot 起不来。
 * 用法：node scripts/test-all.mjs [--budget-ms 18000]
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
// 10-23 热跑 11.3–11.4 秒、冷启动一次 15.0 秒；预算按冷启动留余量，抖一下不该算超
const budgetIndex = args.indexOf('--budget-ms')
const budgetMs = budgetIndex >= 0 && Number(args[budgetIndex + 1]) > 0 ? Number(args[budgetIndex + 1]) : 18_000
const files = readdirSync(resolve(root, '__tests__')).filter((name) => name.endsWith('.test.mjs')).map((name) => `__tests__/${name}`)
const started = Date.now()
const run = spawnSync(process.execPath, ['--test', ...files], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const elapsed = Date.now() - started
const out = `${run.stdout || ''}${run.stderr || ''}`
const pick = (key) => Number((out.match(new RegExp(`^ℹ ${key} (\\d+)`, 'm')) || [])[1] || 0)
const summary = `测试 ${pick('tests')} 个：通过 ${pick('pass')}，失败 ${pick('fail')}；全量用时 ${(elapsed / 1000).toFixed(1)} 秒（预算 ${budgetMs / 1000} 秒）`
if (run.status !== 0) {
  // 只摘失败的：✖ 开头的用例 / 套件，和紧跟的断言说明（通过的用例名里带 Error 字样的不要）。
  console.log(out.split('\n').filter((line) => /^\s*✖|AssertionError|ERR_[A-Z_]+/.test(line)).slice(0, 40).join('\n'))
  console.log(summary)
  process.exit(run.status || 1)
}
console.log(summary)
if (elapsed > budgetMs) {
  console.log(`超过运行时间预算：先看哪个文件慢（单独跑每个文件计时），能并发的改并发、能用纯函数测的别起真子进程；确实要放宽就改这里的预算并写明原因`)
  process.exit(3)
}
