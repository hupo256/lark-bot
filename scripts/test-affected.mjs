#!/usr/bin/env node
/**
 * 只跑和改动相关的测试（aven 2026-10-23：每次改动都跑全量没必要）。
 *
 * 分三层：改的过程中跑这个（几秒）；合并前跑一次全量（`node scripts/test-all.mjs`，带运行时间预算）；
 * bot 重启前自动全量（排空重启的测试闸，已有）。
 *
 * 怎么挑：改动文件 = 工作区相对 base 的改动（默认 HEAD，含未暂存 / 未跟踪）；沿 import 关系反查，
 * 直接或间接引用了被改模块的测试文件都跑；改的测试文件本身也跑；schema / json / md 这类非代码文件，
 * 找内容里提到它文件名的测试。
 *
 * 用法：node scripts/test-affected.mjs [--base <ref>] [--list] [文件…]
 *   --list  只列出会跑哪些测试，不跑
 *   文件…    不看 git，直接按给的文件挑
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CODE_DIRS = ['lib', 'lib/vendor', 'scripts', 'tools', 'runtime', '__tests__', '__tests__/fixtures/golden']
const TEST_DIR = '__tests__'

const listCode = () => CODE_DIRS.flatMap((dir) => {
  const abs = join(root, dir)
  return existsSync(abs) ? readdirSync(abs).filter((name) => /\.m?js$/.test(name)).map((name) => join(dir, name)) : []
}).concat(['lark-gateway.mjs', 'lark-worker.mjs', 'lark-bugtable-poller.mjs'].filter((file) => existsSync(join(root, file))))

// 一个文件 import 了哪些本仓文件（相对路径，含动态 import 的字面量）。纯函数。
export const importsOf = (file, source) => {
  const specs = [...source.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"`](\.{1,2}\/[^'"`]+)['"`]/g)].map((m) => m[1])
  return specs.map((spec) => relative(root, resolve(root, dirname(file), spec)))
}

// 反查：被改的文件 → 直接或间接引用它的所有文件。纯函数（graph: file → imports）。
export const dependentsOf = (changed, graph) => {
  const reverse = new Map()
  for (const [file, deps] of graph) for (const dep of deps) reverse.set(dep, [...(reverse.get(dep) || []), file])
  const seen = new Set(changed)
  const queue = [...changed]
  while (queue.length) {
    for (const parent of reverse.get(queue.shift()) || []) {
      if (!seen.has(parent)) {
        seen.add(parent)
        queue.push(parent)
      }
    }
  }
  return seen
}

export const pickTests = ({ changed, files, read }) => {
  const graph = new Map(files.map((file) => [file, importsOf(file, read(file))]))
  const tests = files.filter((file) => file.startsWith(`${TEST_DIR}/`) && file.endsWith('.test.mjs'))
  const code = changed.filter((file) => /\.m?js$/.test(file))
  const others = changed.filter((file) => !/\.m?js$/.test(file))
  const hit = dependentsOf(code, graph)
  const byName = others.length ? tests.filter((test) => others.some((file) => read(test).includes(basename(file)))) : []
  return [...new Set([...tests.filter((test) => hit.has(test)), ...byName])].sort()
}

const gitChanged = (base) => {
  const run = (args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean)
  return [...new Set([...run(['diff', '--name-only', base]), ...run(['ls-files', '--others', '--exclude-standard'])])]
}

const main = () => {
  const args = process.argv.slice(2)
  const baseIndex = args.indexOf('--base')
  const base = baseIndex >= 0 ? args[baseIndex + 1] : 'HEAD'
  const listOnly = args.includes('--list')
  const explicit = args.filter((arg, index) => !arg.startsWith('--') && args[index - 1] !== '--base')
  const changed = (explicit.length ? explicit : gitChanged(base)).map((file) => relative(root, resolve(root, file)))
  if (!changed.length) return console.log('没有改动，不用跑')
  const files = listCode()
  const tests = pickTests({ changed, files, read: (file) => readFileSync(join(root, file), 'utf8') })
  console.log(`改动 ${changed.length} 个文件 → 相关测试 ${tests.length} / ${files.filter((file) => file.endsWith('.test.mjs')).length} 个文件`)
  if (!tests.length || listOnly) return void tests.forEach((test) => console.log(`  ${test}`))
  const result = spawnSync(process.execPath, ['--test', ...tests], { cwd: root, stdio: 'inherit' })
  process.exitCode = result.status ?? 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
