#!/usr/bin/env node
/**
 * 变异测试：故意把一处代码改坏（=== ↔ !==、&& ↔ ||、边界、return true/false），看测试能不能发现。
 * 发现不了（存活）= 那行代码的行为没被测试钉住（aven 2026-10-24：兼顾健壮与效率）。说明见 docs/mutation-testing.md。
 *
 * 用法：
 *   node scripts/mutate.mjs --diff <基线>          只扫相对基线改动 / 新增的 lib 行（合并前必跑；有未豁免的存活就退出 1）
 *   node scripts/mutate.mjs --files lib/a.mjs,...  扫指定模块的全部变异点
 *   node scripts/mutate.mjs --sample 80 [--seed 7] 全 lib 随机抽样摸底
 *   node scripts/mutate.mjs --all                  全 lib 全部变异点（很慢，几千个；一般用不到）
 *   node scripts/mutate.mjs --only <清单.json>       只复跑清单里的变异点（--json 的输出或其子集），补测后验证用
 *   通用：--lanes N（并行路数，默认按核数最多 3，每路测试并发 2）  --json <文件>（存完整结果）  --list（只列变异点不跑）  --strict（非 diff 模式有存活也退出 1）
 *   排查：MUTATE_DEBUG=1 显示测试输出（基线红时看原因）
 *
 * 不碰本目录：bot 直接跑本目录的代码，变异只注入到临时拷贝里（每路一份），跑完删掉。
 * 已认定不必补测的存活（等价变异、只影响展示且无业务含义）登记在 scripts/mutation-accepted.json，写明原因；按文件 + 代码行文本匹配，行号漂移不影响。
 */

import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { availableParallelism, setPriority, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { importsOf, pickTests } from './test-affected.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const ACCEPTED_FILE = 'scripts/mutation-accepted.json'

// 变异算子：只认带空格的写法（本仓格式），避免误伤 => / >> / 泛型之类。
export const OPERATORS = [
  [' === ', ' !== '], [' !== ', ' === '],
  [' && ', ' || '], [' || ', ' && '],
  [' >= ', ' > '], [' <= ', ' < '], [' > ', ' >= '], [' < ', ' <= '],
  ['return true', 'return false'], ['return false', 'return true'],
]

// 逐字符标出哪些位置是代码（不在字符串 / 模板文字 / 注释里）。模板里的 ${…} 算代码。正则字面量不识别（本仓正则里极少出现带空格的运算符）。
export const codeMask = (source) => {
  const mask = new Uint8Array(source.length)
  const stack = [] // 模板嵌套：进入 ${ 时压入花括号深度
  let state = 'code'
  let depth = 0
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    const next = source[i + 1]
    if (state === 'code') {
      if (ch === '/' && next === '/') { state = 'line'; i += 1; continue }
      if (ch === '/' && next === '*') { state = 'block'; i += 1; continue }
      if (ch === '\'' || ch === '"') { state = ch; continue }
      if (ch === '`') { state = 'tpl'; continue }
      if (ch === '{') depth += 1
      if (ch === '}') {
        if (stack.length && depth === stack.at(-1)) { stack.pop(); state = 'tpl'; continue }
        depth -= 1
      }
      mask[i] = 1
    } else if (state === 'line') {
      if (ch === '\n') { state = 'code'; mask[i] = 1 }
    } else if (state === 'block') {
      if (ch === '*' && next === '/') { state = 'code'; i += 1 }
    } else if (state === '\'' || state === '"') {
      if (ch === '\\') i += 1
      else if (ch === state || ch === '\n') state = 'code'
    } else if (state === 'tpl') {
      if (ch === '\\') i += 1
      else if (ch === '`') state = 'code'
      else if (ch === '$' && next === '{') { stack.push(depth); state = 'code'; i += 1 }
    }
  }
  return mask
}

// 一个文件的全部变异点：每个算子在代码位置的每一处出现各算一个。import 行、纯日志行（console.*）不算。
export const findSites = (file, source) => {
  const mask = codeMask(source)
  const sites = []
  let offset = 0
  source.split('\n').forEach((line, index) => {
    const trimmed = line.trim()
    const skip = !trimmed || /^import\b|^export \{/.test(trimmed) || /^console\.(log|warn|error|info)\(/.test(trimmed)
    if (!skip) {
      for (const [from, to] of OPERATORS) {
        for (let col = line.indexOf(from); col >= 0; col = line.indexOf(from, col + 1)) {
          if (from.startsWith('return') && /\w/.test(line[col + from.length] || '')) continue
          if (mask[offset + col + (from.startsWith(' ') ? 1 : 0)]) sites.push({ file, line: index + 1, col: col + 1, from, to, code: trimmed })
        }
      }
    }
    offset += line.length + 1
  })
  return sites
}

export const applyMutation = (source, site) => {
  const lines = source.split('\n')
  const line = lines[site.line - 1]
  const col = site.col - 1
  if (line.slice(col, col + site.from.length) !== site.from) throw new Error(`变异点对不上：${site.file}:${site.line}:${site.col}`)
  lines[site.line - 1] = line.slice(0, col) + site.to + line.slice(col + site.from.length)
  return lines.join('\n')
}

// git diff -U0 输出 → { 文件: Set(新版行号) }。只看新增 / 改动行（删除行没有可变异的新代码）。
export const changedLinesFromDiff = (diffText) => {
  const result = {}
  let file = null
  for (const line of String(diffText || '').split('\n')) {
    const header = line.match(/^\+\+\+ b\/(.+)$/)
    if (header) { file = header[1]; result[file] ||= new Set(); continue }
    if (line.startsWith('+++ /dev/null')) { file = null; continue }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/)
    if (hunk && file) {
      const start = Number(hunk[1])
      const count = hunk[2] === undefined ? 1 : Number(hunk[2])
      for (let n = start; n < start + count; n += 1) result[file].add(n)
    }
  }
  return result
}

export const siteKey = (site) => `${site.file}｜${site.code}｜${site.from.trim()} → ${site.to.trim()}`
// 豁免按文件 + 代码行文本 + 算子匹配；带 col 时只豁免该行那一处（同一行有多处同算子时用）
export const isAccepted = (site, accepted = []) => accepted.some((item) => item.file === site.file && item.code === site.code && item.op === `${site.from.trim()} → ${site.to.trim()}` && (item.col === undefined || item.col === site.col))

export const sampleSites = (sites, n, seed = 7) => {
  let state = Number(seed) || 7
  const rnd = () => ((state = (state * 1103515245 + 12345) % 2147483648) / 2147483648)
  const pool = [...sites]
  const picked = []
  while (picked.length < n && pool.length) picked.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0])
  return picked
}

const parseArgs = (argv) => {
  const value = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined)
  return {
    diff: value('--diff'),
    files: value('--files')?.split(',').map((file) => file.trim()).filter(Boolean),
    sample: value('--sample') ? Number(value('--sample')) : null,
    seed: value('--seed') ? Number(value('--seed')) : 7,
    lanes: value('--lanes') ? Number(value('--lanes')) : Math.max(1, Math.min(3, Math.floor(availableParallelism() / 2) - 1)),
    json: value('--json'),
    only: value('--only'),
    list: argv.includes('--list'),
    all: argv.includes('--all'),
    help: argv.includes('--help') || argv.includes('-h'),
    strict: argv.includes('--strict'),
  }
}

const git = (args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 << 20 }).stdout || ''
const libFiles = () => git(['ls-files', '-co', '--exclude-standard', 'lib']).split('\n').filter((file) => /^lib\/.*\.mjs$/.test(file))

const collectSites = (opts) => {
  if (opts.only) {
    // 只复跑清单里的变异点（--json 的输出或其子集）；按文件 + 行号 + 列 + 代码行文本 + 算子精确定位（补测期间 lib 不该变；变了就重扫）。
    const wanted = JSON.parse(readFileSync(resolve(opts.only), 'utf8'))
    const key = (site) => `${site.file}｜${site.line}｜${site.col}｜${site.code}｜${site.from}｜${site.to}`
    const keys = new Set(wanted.map(key))
    return [...new Set(wanted.map((site) => site.file))].flatMap((file) => findSites(file, readFileSync(join(root, file), 'utf8')).filter((site) => keys.has(key(site))))
  }
  if (opts.diff) {
    const changed = changedLinesFromDiff(git(['diff', '-U0', opts.diff, '--', 'lib']))
    for (const file of git(['ls-files', '-o', '--exclude-standard', 'lib']).split('\n').filter((name) => name.endsWith('.mjs'))) {
      changed[file] = new Set(readFileSync(join(root, file), 'utf8').split('\n').map((_, index) => index + 1))
    }
    return Object.entries(changed).filter(([file]) => file.endsWith('.mjs')).flatMap(([file, lines]) =>
      findSites(file, readFileSync(join(root, file), 'utf8')).filter((site) => lines.has(site.line)))
  }
  const files = opts.files?.length ? opts.files : libFiles()
  const all = files.flatMap((file) => findSites(file, readFileSync(join(root, file), 'utf8')))
  return opts.sample ? sampleSites(all, opts.sample, opts.seed) : all
}

const runNodeTests = (cwd, tests) => new Promise((done) => {
  if (!tests.length) return done({ failed: false })
  // 单独进程组：超时整组杀掉。只杀 node --test 主进程会留下孤儿（10-24：变异让测试卡死循环，16 个孤儿空转一小时吃掉 5 个核）
  const child = spawn(process.execPath, ['--test', '--test-concurrency=2', ...tests], { cwd, detached: true, env: { ...process.env, LARK_CLI_BIN: '/usr/bin/false' }, stdio: process.env.MUTATE_DEBUG ? 'inherit' : 'ignore' })
  const killGroup = () => { try { process.kill(-child.pid, 'SIGKILL') } catch {} }
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; killGroup() }, 120_000)
  child.on('close', (code) => { clearTimeout(timer); killGroup(); done({ failed: code !== 0 || timedOut, timedOut }) })
})

const KNOWN_FLAGS = new Set(['--diff', '--files', '--sample', '--seed', '--lanes', '--json', '--only', '--list', '--strict', '--all', '--help', '-h'])
const usage = () => readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(2, 14).map((line) => line.replace(/^ \*\s?/, '')).join('\n')

const main = async () => {
  const argv = process.argv.slice(2)
  const opts = parseArgs(argv)
  const unknown = argv.filter((arg) => arg.startsWith('-') && !KNOWN_FLAGS.has(arg))
  // 不带模式 / 未知参数 / --help：只打印用法，绝不默认去跑全 lib（10-24 误跑 --help 起了 4000 多个变异）
  if (opts.help || unknown.length || !(opts.diff || opts.files?.length || opts.sample || opts.only || opts.all)) {
    if (unknown.length) console.log(`不认识的参数：${unknown.join(' ')}\n`)
    console.log(usage())
    process.exitCode = opts.help ? 0 : 2
    return
  }
  // 自己和所有子进程降到低优先级：后台慢慢跑，不抢前台与 bot 本身（子进程继承 nice 值）
  try { setPriority(15) } catch {}
  const accepted = existsSync(join(root, ACCEPTED_FILE)) ? JSON.parse(readFileSync(join(root, ACCEPTED_FILE), 'utf8')) : []
  const sites = collectSites(opts)
  if (opts.list) return void sites.forEach((site) => console.log(`${site.file}:${site.line}:${site.col}  ${site.from.trim()} → ${site.to.trim()}  ${site.code.slice(0, 100)}`))
  if (!sites.length) return console.log('没有可变异的改动行')

  // 每路一个临时 worktree（HEAD），再盖上本目录未提交的改动和新文件：有 git 历史（有测试读提交号），也带着这次的改动。变异只改这些副本。
  const tracked = git(['ls-files', '-co', '--exclude-standard']).split('\n').filter((file) => file && existsSync(join(root, file)))
  const dirty = [...new Set([...git(['diff', '--name-only', 'HEAD']).split('\n'), ...git(['ls-files', '-o', '--exclude-standard']).split('\n')])].filter(Boolean)
  const lanes = Array.from({ length: Math.max(1, Math.min(opts.lanes, sites.length)) }, () => join(mkdtempSync(join(tmpdir(), 'lark-mutate-')), 'repo'))
  const cleanup = () => lanes.forEach((dir) => {
    spawnSync('git', ['-C', root, 'worktree', 'remove', '--force', dir], { stdio: 'ignore' })
    rmSync(dirname(dir), { recursive: true, force: true })
  })
  process.on('SIGINT', () => { cleanup(); process.exit(130) })
  try {
    for (const dir of lanes) {
      if (spawnSync('git', ['-C', root, 'worktree', 'add', '--detach', '-q', dir, 'HEAD'], { stdio: 'ignore' }).status !== 0) throw new Error(`建临时 worktree 失败：${dir}`)
      for (const file of dirty) {
        if (existsSync(join(root, file))) { mkdirSync(dirname(join(dir, file)), { recursive: true }); cpSync(join(root, file), join(dir, file)) } else rmSync(join(dir, file), { force: true })
      }
    }
    const codeFiles = tracked.filter((file) => /\.m?js$/.test(file))
    const read = (file) => readFileSync(join(root, file), 'utf8')
    const testsCache = new Map()
    // 先跑直接 import 被改模块的测试（多数变异在这里就被抓到），没抓到再跑间接依赖的其余测试。
    const testsFor = (file) => {
      if (!testsCache.has(file)) {
        const all = pickTests({ changed: [file], files: codeFiles, read })
        const direct = all.filter((test) => importsOf(test, read(test)).includes(file))
        testsCache.set(file, [direct, all.filter((test) => !direct.includes(test))])
      }
      return testsCache.get(file)
    }
    const baseline = await runNodeTests(lanes[0], [...new Set(sites.flatMap((site) => testsFor(site.file).flat()))])
    if (baseline.failed) throw new Error('基线（未变异）相关测试就是红的，先修好再跑变异')

    console.log(`变异点 ${sites.length} 个，${lanes.length} 路并行`)
    const queue = [...sites]
    const results = []
    const started = Date.now()
    await Promise.all(lanes.map(async (dir) => {
      for (let site = queue.shift(); site; site = queue.shift()) {
        const path = join(dir, site.file)
        const original = readFileSync(path, 'utf8')
        writeFileSync(path, applyMutation(original, site))
        const [direct, rest] = testsFor(site.file)
        let run = await runNodeTests(dir, direct)
        if (!run.failed) run = await runNodeTests(dir, rest)
        writeFileSync(path, original)
        results.push({ ...site, killed: run.failed, timedOut: Boolean(run.timedOut), accepted: !run.failed && isAccepted(site, accepted) })
        if (results.length % 20 === 0) console.log(`  ${results.length} / ${sites.length}（${Math.round((Date.now() - started) / 1000)} 秒）`)
      }
    }))
    results.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.col - b.col)
    const survived = results.filter((item) => !item.killed && !item.accepted)
    const killed = results.filter((item) => item.killed).length
    console.log(`\n变异 ${results.length} 个：抓到 ${killed}，豁免 ${results.filter((item) => item.accepted).length}，存活 ${survived.length}；用时 ${Math.round((Date.now() - started) / 1000)} 秒`)
    for (const item of survived) console.log(`  存活 ${item.file}:${item.line}:${item.col}  ${item.from.trim()} → ${item.to.trim()}  ${item.code.slice(0, 120)}`)
    if (opts.json) writeFileSync(resolve(opts.json), `${JSON.stringify(results, null, 2)}\n`)
    if (survived.length && (opts.diff || opts.strict)) {
      console.log(`\n有存活变异：补测试钉住这些行的行为；确属等价 / 无业务含义的，登记进 ${ACCEPTED_FILE}（file / code / op / reason）`)
      process.exitCode = 1
    }
  } finally {
    cleanup()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(String(error?.message || error)); process.exitCode = 2 })
}
