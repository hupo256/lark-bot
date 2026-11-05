#!/usr/bin/env node
/**
 * 按事件组跑一轮回放（docs/replay/falive-replay-design-v2.md §2、§8 P0-d；取代按天切段的 run-round.sh / run-days.sh）：
 *   node scripts/sim/run-episodes.mjs --round <轮> [--only ep-…,ep-…] [--max-parallel N] [--port-base 3200] [--no-guard] [--ai-cache] [--no-judge]
 *   [--mem-reserve-mb 3072] [--episode-mem-mb 2560]：内存闸——系统可用内存（memory_pressure 的空闲百分比 × 物理内存）
 *   不够「余量 + 一组的预估峰值」就不起下一组，等在跑的组收尾（并发上限现在由内存决定，design-v2 §0；11-03 八段全开内存紧张杀过进程）。
 *   --ai-cache 透传给 run-sim（claude 调用录放，scripts/sim/claude-cache.mjs；SIM_AI_CACHE_HIT_DELAY 等环境变量照常继承）。
 * 每组 = 一个独立的 lark-bot 实例（网关 + worker），目录 runtime/falive-replay/sim/<轮>/<组>/：从组里第一条 case 前 30 分钟起，
 * 只喂本组的 case，到最后一条之后 bot 没动静、再让虚拟时间走 5 小时（逾期义务 / 催办）为止。跨天的组按 UTC 天切段，
 * 每段一次 run-sim（共用同一个 sim 目录：任务 / 义务 / 发件簿延续；每天重钉业务仓基线，同 run-days）。
 * 断点（组级）：组跑完写 <组>/DONE（含代码指纹）；再跑同一条命令跳过 DONE 的组，没跑完的组整组清掉重跑（组都小）。
 * 一轮只许一版代码：<轮>/round.json 记指纹，现在的代码指纹不同就拒绝（换轮名，或删掉 sim/<轮>）。
 * 调度：最长的组先跑（case 数、跨度），同时最多 --max-parallel 组（默认见 DEFAULT_PARALLEL，按 P0-e 实测内存定）；
 * 起跑前预检（preflight.mjs）、防睡眠（caffeinate）、止损守卫（round-guard.mjs）；额度闸 claude-q 由 run-sim 的环境接上。
 * 每组跑完做出网审计（egress-audit.mjs → <组>/egress-summary.json）；全部跑完出总账 replay/falive/rounds/<轮>/report.md。
 * 每组跑完接着裁判：judge-sim --dir <组目录>（规则预判 + 按输出指纹缓存，只判变了的）→ <组>/judge.jsonl、judge.out；--no-judge 不判。
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { auditEgress } from './egress-audit.mjs'
import { casesDir, datasetDir, replayRoot, roundsDir } from './falive-data.mjs'

// P0-e（11-04）：小组实测单组进程树峰值见 docs/replay/falive-replay-plan-2026-11-03.md 49；16G 留 3G 余量
export const DEFAULT_PARALLEL = 4
const here = dirname(fileURLToPath(import.meta.url))
const repo = dirname(dirname(here))
const args = process.argv.slice(2)
const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const isMain = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === process.argv[1]
const round = value('--round', isMain ? null : '_import')
if (!round || !/^[\w.-]+$/.test(round)) throw new Error('--round <轮名> 必填（字母数字 . _ -）')
const only = value('--only', null)?.split(',').filter(Boolean) || null
const maxParallel = Number(value('--max-parallel', DEFAULT_PARALLEL))
const portBase = Number(value('--port-base', 3200))
const memReserveMb = Number(value('--mem-reserve-mb', 3072))
const episodeMemMb = Number(value('--episode-mem-mb', 2560))
// macOS 可用内存（MB）：memory_pressure 的「System-wide memory free percentage」× 物理内存——内核判内存压力用的口径（空闲 + 可回收的文件缓存），
// 比 vm_stat 的 free+inactive 宽、比「总量 − App − 联动 − 压缩」窄；读不到按 0（只放行第一组）。
export const availableMemMb = () => {
  const pct = Number(/free percentage:\s*(\d+)%/.exec(spawnSync('memory_pressure', [], { encoding: 'utf8' }).stdout || '')?.[1] || 0)
  const total = Number(spawnSync('sysctl', ['-n', 'hw.memsize'], { encoding: 'utf8' }).stdout.trim() || 0)
  return Math.round((total * pct) / 100 / 1048576)
}
const roundDir = join(replayRoot, 'sim', round)
const outDir = join(roundsDir, round)
const log = (line) => {
  const text = `${new Date().toISOString()} [episodes] ${line}`
  console.log(text)
  appendFileSync(join(roundDir, 'run-episodes.log'), `${text}\n`)
}

// —— 代码指纹：bot 代码（lib / 入口 / tools）+ case 数据 + 分组 + 决定场景的模拟器文件 + 线上运行配置里的模型 / 强度 ——
// 都取 HEAD 的 git tree（预检已保证这些路径没有未提交改动）；裁判 / 报表脚本不进指纹（改了不影响 bot 的输出）。
const FINGERPRINT_PATHS = ['lib', 'lark-gateway.mjs', 'lark-worker.mjs', 'runtime/lark-worker.mjs', 'tools', 'replay/falive/dataset', 'replay/falive/raw', 'replay/falive/episodes.json',
  'scripts/sim/run-sim.mjs', 'scripts/sim/fake-lark-cli.mjs', 'scripts/sim/lark-cli', 'scripts/sim/virtual-clock.mjs', 'scripts/sim/falive-data.mjs', 'scripts/sim/claude-quota.mjs', 'scripts/sim/claude-q',
  'scripts/sim/egress', 'scripts/sim/egress-hook.mjs', 'scripts/sim/egress-log.mjs', 'scripts/sim/proc-sampler.mjs', 'scripts/sim/claude', 'scripts/sim/claude-cache.mjs', 'scripts/sim/falive-env-login.mjs']
export const codeFingerprint = () => {
  const trees = FINGERPRINT_PATHS.map((p) => {
    const out = spawnSync('git', ['-C', repo, 'rev-parse', `HEAD:${p}`], { encoding: 'utf8' })
    if (out.status !== 0) throw new Error(`指纹：HEAD 里没有 ${p}`)
    return `${p} ${out.stdout.trim()}`
  })
  const prod = JSON.parse(readFileSync(join(homedir(), 'github', 'lark-bot', 'runtime', 'lark-bot.local.json'), 'utf8'))
  const model = ['claudeModel', 'claudeEffort', 'claudeIntentModel', 'claudeIntentEffort', 'claudeAnalysisModel', 'claudeAnalysisEffort'].map((k) => `${k}=${prod[k] ?? ''}`).join(' ')
  return createHash('sha1').update([...trees, model].join('\n')).digest('hex').slice(0, 12)
}

// 组的分段：按 UTC 天（与 episodes.mjs 的 days 一致）；第一段从窗口起点（首条 − 30 分钟）开始，中间段收尾不越过下一段第一条 case。
export const episodeSegments = (group, atOf) => {
  const days = [...new Set(group.caseIds.map((id) => new Date(atOf(id)).toISOString().slice(0, 10)))].sort()
  const nextDay = (day) => new Date(Date.parse(`${day}T00:00:00Z`) + 864e5).toISOString().slice(0, 10)
  return days.map((day, i) => {
    const next = days[i + 1]
    const firstNext = next ? Math.min(...group.caseIds.map(atOf).filter((ms) => new Date(ms).toISOString().slice(0, 10) === next)) : null
    return {
      day,
      from: i === 0 ? group.windowStart : `${day}T00:00:00.000Z`,
      to: `${nextDay(day)}T00:00:00.000Z`,
      ...(firstNext ? { tailTo: new Date(firstNext - 60_000).toISOString() } : {}),
    }
  })
}

const main = async () => {
  mkdirSync(roundDir, { recursive: true })
  mkdirSync(outDir, { recursive: true })
  // 防睡眠（前置 8）：本进程活着期间系统、磁盘、显示都不睡
  spawn('caffeinate', ['-dims', '-w', String(process.pid)], { stdio: 'ignore', detached: true }).unref()
  const pre = spawnSync('node', [join(here, 'preflight.mjs'), '--round', round, '--md', join(outDir, 'preflight.md'), ...(existsSync(join(roundDir, 'round.json')) ? ['--resume'] : [])], { cwd: repo, stdio: 'inherit' })
  if (pre.status !== 0) { log(`PREFLIGHT-FAIL ${round}（见 replay/falive/rounds/${round}/preflight.md）`); process.exit(1) }
  const fingerprint = codeFingerprint()
  const head = spawnSync('git', ['-C', repo, 'log', '-1', '--format=%h %s'], { encoding: 'utf8' }).stdout.trim().slice(0, 60)
  const branch = spawnSync('git', ['-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
  const roundMetaPath = join(roundDir, 'round.json')
  const roundMeta = existsSync(roundMetaPath) ? JSON.parse(readFileSync(roundMetaPath, 'utf8')) : null
  if (roundMeta && roundMeta.fingerprint !== fingerprint) {
    log(`!!! ${round} 已按代码指纹 ${roundMeta.fingerprint}（${roundMeta.head}）跑过，现在是 ${fingerprint}（${head}）：一轮不混两版代码。换轮名重跑，或删掉 ${roundDir}`)
    process.exit(3)
  }
  if (!roundMeta) writeFileSync(roundMetaPath, JSON.stringify({ fingerprint, head, branch, createdAt: new Date().toISOString() }, null, 1))
  writeFileSync(join(outDir, 'code.txt'), `${head} ${branch} 指纹 ${fingerprint}\n`)

  const timeline = JSON.parse(readFileSync(join(datasetDir, 'timeline.json'), 'utf8'))
  const atMs = new Map(timeline.map((m) => [m.id, m.atMs]))
  const atOf = (id) => atMs.get(id)
  const all = JSON.parse(readFileSync(join(casesDir, 'episodes.json'), 'utf8')).groups
  if (only) for (const id of only) if (!all.some((g) => g.id === id)) throw new Error(`episodes.json 里没有 ${id}`)
  const span = (g) => Date.parse(g.lastAt) - Date.parse(g.firstAt)
  const picked = all.filter((g) => !only || only.includes(g.id)).sort((a, b) => b.size - a.size || span(b) - span(a))
  const todo = []
  for (const g of picked) {
    const dir = join(roundDir, g.id)
    const donePath = join(dir, 'DONE')
    if (existsSync(donePath)) {
      const done = JSON.parse(readFileSync(donePath, 'utf8'))
      if (done.fingerprint !== fingerprint) { log(`!!! ${g.id} 的 DONE 指纹 ${done.fingerprint} ≠ ${fingerprint}`); process.exit(3) }
      log(`跳过 ${g.id}（已跑完 ${done.finishedAt}）`)
      continue
    }
    todo.push(g)
  }
  log(`${round}：${picked.length} 组，待跑 ${todo.length}（最长先跑，并发 ${maxParallel}，端口 ${portBase}+），指纹 ${fingerprint}（${head}）`)
  if (!todo.length) return finish([])

  const guard = args.includes('--no-guard') ? null : spawn('node', [join(here, 'round-guard.mjs'), '--round', round, '--pid', String(process.pid)], { cwd: repo, stdio: ['ignore', openSync(join(roundDir, 'guard.out'), 'a'), openSync(join(roundDir, 'guard.out'), 'a')] })
  const running = new Set()
  const stopAll = (signal) => { for (const child of running) child.kill('SIGTERM'); guard?.kill('SIGTERM'); process.exit(signal === 'SIGINT' ? 130 : 143) }
  process.on('SIGINT', () => stopAll('SIGINT'))
  process.on('SIGTERM', () => stopAll('SIGTERM'))

  const runSegment = (g, seg, port) => new Promise((resolve) => {
    const dir = join(roundDir, g.id)
    const argv = [join(here, 'run-sim.mjs'), '--sim', `${round}/${g.id}`, '--episode', g.id, '--from', seg.from, '--to', seg.to, '--port', String(port), '--conc', '3', '--max-wait-min', '40', ...(seg.tailTo ? ['--tail-to', seg.tailTo] : []), ...(args.includes('--ai-cache') ? ['--ai-cache'] : [])]
    const out = openSync(join(dir, 'run.out'), 'a')
    const child = spawn('node', argv, { cwd: repo, stdio: ['ignore', out, out] })
    running.add(child)
    child.on('exit', (code) => { running.delete(child); resolve(code ?? 1) })
  })
  const runEpisode = async (g, port) => {
    const dir = join(roundDir, g.id)
    if (existsSync(dir)) { log(`${g.id} 有跑了一半的目录：整组清掉重跑`); rmSync(dir, { recursive: true, force: true }) }
    mkdirSync(dir, { recursive: true })
    const segments = episodeSegments(g, atOf)
    const started = Date.now()
    log(`起 ${g.id}（${g.size} 条，${segments.length} 天，端口 ${port}）`)
    for (const seg of segments) {
      const code = await runSegment(g, seg, port)
      if (code !== 0) {
        writeFileSync(join(dir, 'FAILED'), JSON.stringify({ segment: seg, code, at: new Date().toISOString() }))
        log(`!!! ${g.id} ${seg.day} 段 run-sim 退出 code=${code}（看 ${join(dir, 'run.out')}）`)
        return { id: g.id, ok: false }
      }
    }
    const egress = auditEgress(dir)
    const mem = existsSync(join(dir, 'mem-peak.json')) ? JSON.parse(readFileSync(join(dir, 'mem-peak.json'), 'utf8')) : {}
    const done = { fingerprint, head, finishedAt: new Date().toISOString(), realMin: Math.round((Date.now() - started) / 6000) / 10, segments, memPeakMb: mem.rssMb ?? null, egress: { violations: egress.violations.length, review: egress.review.length } }
    writeFileSync(join(dir, 'DONE'), JSON.stringify(done, null, 1))
    log(`完成 ${g.id}：${done.realMin} 分钟，内存峰值 ${done.memPeakMb}MB，出网违规 ${egress.violations.length} / 待核 ${egress.review.length}`)
    if (!args.includes('--no-judge')) {
      const out = openSync(join(dir, 'judge.out'), 'a')
      const code = await new Promise((resolve) => spawn('node', [join(here, 'judge-sim.mjs'), '--dir', dir, '--conc', '2'], { cwd: repo, stdio: ['ignore', out, out] }).on('exit', (c) => resolve(c ?? 1)))
      log(`裁判 ${g.id}：${code === 0 ? '完成' : `退出 code=${code}（看 judge.out）`}`)
    }
    return { id: g.id, ok: true }
  }

  // 有界并发池：每个槽位一个固定端口
  const queue = [...todo]
  const results = []
  await Promise.all(Array.from({ length: Math.max(1, Math.min(maxParallel, todo.length)) }, async (_, slot) => {
    await new Promise((r) => setTimeout(r, slot * 15_000)) // 错开起跑：每组要 clone 业务仓、起网关
    for (let g = queue.shift(); g; g = queue.shift()) {
      // 内存闸：第一组总是放行；之后可用内存不够「余量 + 一组峰值」就等（每 30 秒看一次，在跑的组收尾会放出内存）
      for (let waited = 0; running.size > 0 && availableMemMb() < memReserveMb + episodeMemMb; waited += 1) {
        if (waited % 10 === 0) log(`内存闸：可用 ${availableMemMb()}MB < 余量 ${memReserveMb} + 一组 ${episodeMemMb}，${g.id} 等在跑的组收尾`)
        await new Promise((r) => setTimeout(r, 30_000))
      }
      results.push(await runEpisode(g, portBase + slot))
    }
  }))
  guard?.kill('SIGTERM')
  return finish(results)
}

const finish = (results) => {
  // 每组的裁判进版本：replay/falive/rounds/<轮>/<组>.judge.jsonl（sim 目录本身体量大、可重跑，留在 runtime）
  for (const g of readdirSync(roundDir)) if (existsSync(join(roundDir, g, 'judge.jsonl'))) copyFileSync(join(roundDir, g, 'judge.jsonl'), join(outDir, `${g}.judge.jsonl`))
  spawnSync('node', [join(here, 'round-report.mjs'), '--round', round, '--md', join(outDir, 'report.md')], { cwd: repo, stdio: 'inherit' })
  const failed = results.filter((r) => !r.ok)
  log(failed.length ? `ROUND-PARTIAL ${round}：${failed.length} 组没跑完（${failed.map((r) => r.id).join('、')}）` : `ROUND-DONE ${round}`)
  process.exit(failed.length ? 1 : 0)
}

if (isMain) await main()
