#!/usr/bin/env node
/**
 * 离线模拟器编排（docs/falive-replay-plan-2026-11-03.md §2 L2 / L3）：真网关 + 真 worker 跑在隔离运行目录，
 * lark-cli 换成 scripts/sim/lark-cli（时间线供数、发件落 outbox），Date 换成虚拟时钟，按时间线逐条喂事件，每条等系统空闲再喂下一条。
 *   node scripts/sim/run-sim.mjs --sim day1020 --from 2026-10-20T08:00+04:00 --to 2026-10-20T20:00+04:00 [--reset] [--effort medium] [--intent-effort high]
 *        [--max-wait-min 30] [--settle-sec 25] [--dry]（只准备目录与事件，不起进程）[--no-ai-cache]（关掉 claude 调用缓存，全部真调）
 * 产物：runtime/falive-replay/sim/<sim>/ 下 outbox.jsonl（bot 发了什么）、runtime/（任务 / 审计 / 发件簿 / 义务）、gateway.log / worker.log、events.ndjson。
 * claude 调用缓存（§6 改法 2）：LARK_CLAUDE_BIN 指到 scripts/sim/claude（claude-cache.mjs），只读调用（分类 / 分诊 / 分析 / 代答 / 实测）
 *   按规范化后的完整输入复用上次输出，可写调用与续会话直通；每次调用记 SIM_DIR/ai-cache.log，收尾在 sim.log 打本次 hit / miss / bypass 计数。
 * 基线代码：按窗口起点把 falive-react 的 feature/phase-6-ol 钉到当时的提交（主仓建分支 sim-base-<日期>；每个 sim 一份 clone --shared，origin = 主仓）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AVEN_OPEN_ID, BOT_APP_ID, GROUPS, datasetDir, replayRoot, toSimEvent } from './falive-data.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const larkBotRoot = dirname(dirname(here))
const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const simName = value('--sim', null)
if (!simName) throw new Error('--sim <name> 必填')
const fromMs = Date.parse(value('--from', '2026-10-20T00:00:00+04:00'))
const toMs = Date.parse(value('--to', '2026-10-21T00:00:00+04:00'))
const maxWaitMs = Number(value('--max-wait-min', 30)) * 60_000
const settleMs = Number(value('--settle-sec', 25)) * 1000
const port = Number(value('--port', 3105))
const dry = flag('--dry')
const aiCache = !flag('--no-ai-cache')
const BOT_OPEN_ID = 'ou_e331d79d4491e64b7bba89bb4e3b5e43'
const FALIVE_REPO = join(homedir(), 'github', 'falive-react')
const FALIVE_BRANCH = 'feature/phase-6-ol'

const simDir = join(replayRoot, 'sim', simName)
const runtimeDir = join(simDir, 'runtime')
if (flag('--reset') && existsSync(simDir)) rmSync(simDir, { recursive: true, force: true })
mkdirSync(runtimeDir, { recursive: true })
mkdirSync(join(simDir, 'repos'), { recursive: true })
const log = (line) => {
  const text = `${new Date().toISOString()} [sim] ${line}`
  console.log(text)
  appendFileSync(join(simDir, 'sim.log'), `${text}\n`)
}

// —— 数据 ——
const timeline = JSON.parse(readFileSync(join(datasetDir, 'timeline.json'), 'utf8'))
writeFileSync(join(simDir, 'timeline.json'), JSON.stringify(timeline))
writeFileSync(join(simDir, 'chats.json'), JSON.stringify(GROUPS.map((g) => ({ chat_id: g.chatId, name: g.name, external: g.external }))))
const resources = {}
for (const m of timeline) for (const r of m.resources || []) if (r.localPath) resources[`${m.id}/${r.key}`] = join(replayRoot, 'raw', r.localPath.replace(/^\.?\/?/, ''))
writeFileSync(join(simDir, 'resources.json'), JSON.stringify(resources))
if (!existsSync(join(simDir, 'meta.json'))) writeFileSync(join(simDir, 'meta.json'), JSON.stringify({ simStartMs: fromMs, createdAt: new Date().toISOString() }))
const events = timeline.filter((m) => m.atMs >= fromMs && m.atMs < toMs && !m.ownBot && !m.deleted && m.senderType === 'user' && (m.text || m.resources?.length))
const fedPath = join(simDir, 'fed.json')
const fed = new Set(existsSync(fedPath) ? JSON.parse(readFileSync(fedPath, 'utf8')) : [])
log(`窗口 ${new Date(fromMs).toISOString()} → ${new Date(toMs).toISOString()}：${events.length} 条真人消息（已喂 ${fed.size}）`)

// —— 业务仓基线：钉到窗口起点当时的提交 ——
const git = (cmd, cwd = FALIVE_REPO) => spawnSync('git', cmd, { cwd, encoding: 'utf8' })
const baseSha = git(['rev-list', '-1', `--before=${new Date(fromMs).toISOString()}`, FALIVE_BRANCH]).stdout.trim()
if (!baseSha) throw new Error(`falive-react 在 ${new Date(fromMs).toISOString()} 之前没有 ${FALIVE_BRANCH} 提交`)
const baseBranch = `sim-base-${new Date(fromMs).toISOString().slice(0, 10)}`
git(['branch', '-f', baseBranch, baseSha])
// 业务仓副本：每个 sim 一份 `git clone --shared`（对象共享、分支 / worktree 各自独立——任务分支名 hotfix/adhoc-<id> 按任务 id 定死，
// 多个 sim 共用一个仓会互相撞分支：11-03 full-a 的造数任务因为 smoke 留下的同名分支「已有提交但不包含本次基线」直接 failed），
// 检出到基线提交；只读答疑在这里跑，临时 hotfix worktree 从这里派生。node_modules 软链主仓的（版本略有漂移，可接受）。
const repoLink = join(simDir, 'repos', 'falive-react')
if (!existsSync(repoLink)) {
  const cloned = git(['clone', '--shared', '--no-checkout', FALIVE_REPO, repoLink])
  if (cloned.status !== 0) throw new Error(`clone --shared 失败：${cloned.stderr.slice(0, 300)}`)
}
git(['fetch', '--quiet', 'origin', baseBranch], repoLink)
// 只留基线分支的引用：clone 会带上主仓全部分支（含「未来」的提交），worker 翻 git log --all / 看 online 分支就能看到窗口之后的合入
//（10-31 回放：bot 说「Justin 10-31 已合入 online」）。对象还在（shared），但不可达就翻不到。
for (const ref of git(['for-each-ref', '--format=%(refname)', 'refs/remotes', 'refs/heads'], repoLink).stdout.split('\n').filter(Boolean)) {
  if (ref === `refs/remotes/origin/${baseBranch}` || ref === 'refs/remotes/origin/HEAD') continue
  git(['update-ref', '-d', ref], repoLink)
}
git(['config', 'remote.origin.fetch', `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`], repoLink)
if (git(['rev-parse', 'HEAD'], repoLink).stdout.trim() !== baseSha) {
  const out = git(['checkout', '--quiet', '--detach', baseSha], repoLink)
  if (out.status !== 0) throw new Error(`checkout 基线失败：${out.stderr.slice(0, 300)}`)
}
if (!existsSync(join(repoLink, 'node_modules'))) symlinkSync(join(FALIVE_REPO, 'node_modules'), join(repoLink, 'node_modules'))
log(`业务仓基线 ${baseBranch} = ${baseSha.slice(0, 8)}（${git(['log', '-1', '--format=%ci %s', baseSha]).stdout.trim().slice(0, 100)}）`)

// —— 运行配置 ——
const faliveConfig = JSON.parse(readFileSync(join(homedir(), 'github', 'lark-bot-falive', 'runtime', 'lark-bot.local.json'), 'utf8'))
const repo = faliveConfig.repos?.falive || {}
const config = {
  project: 'FALIVE',
  title: 'Falive Web',
  botOpenId: BOT_OPEN_ID,
  botAppId: BOT_APP_ID,
  allowedChatIds: 'auto',
  allowedOpenIds: [AVEN_OPEN_ID],
  notifyOpenId: AVEN_OPEN_ID,
  taskMentionOpenIds: [],
  ownerMap: repo.ownerMap || {},
  memberRoles: repo.memberRoles || {},
  aiExecutor: 'claude',
  claudeModel: 'claude-opus-5-5',
  claudeEffort: value('--effort', repo.claudeEffort || 'medium'),
  claudeIntentModel: 'claude-opus-5-5',
  claudeIntentEffort: value('--intent-effort', repo.claudeIntentEffort || 'high'),
  claudeAnalysisModel: 'claude-opus-5-5',
  claudeAnalysisEffort: repo.claudeAnalysisEffort || 'high',
  repoLabel: 'falive-react（Falive Web 前端仓）',
  commitPrefix: 'feat(bot)', // falive-react 的 commit-msg 钩子要求 <type>(<scope>): 主题（falive 当时的 repo profile 同值）
  consumerRoot: repoLink,
  intake: repo.intake || undefined,
  // 环境按时间线里第一次出现的日子生效（11-03：中途把 uat / online 一律加进来，10-22 的回放就「编出了当时还不存在的 uat」）：
  // pre 10-08 起；uat 10-28 起（Encone 首次给出 faliveuat）；online 10-29 起（www.falive.com 首次出现）。
  envSites: {
    pre: 'https://falivepre.fdsser.com',
    ...(fromMs >= Date.parse('2026-10-28T00:00:00Z') ? { uat: 'https://faliveuat.fdsser.com' } : {}),
    ...(fromMs >= Date.parse('2026-10-29T00:00:00Z') ? { online: 'https://www.falive.com' } : {}),
  },
  dailyReport: { enabled: false },
  chatRetention: { enabled: false },
  digest: { enabled: false },
  selfHeal: { drainRestart: false, selfFix: false, doctor: false },
  mailRelay: { enabled: false },
}
writeFileSync(join(runtimeDir, 'lark-bot.local.json'), JSON.stringify(config, null, 2), { mode: 0o600 })
for (const name of ['persona', 'knowledge']) {
  const src = join(homedir(), 'github', 'lark-bot', 'runtime', name)
  const dst = join(runtimeDir, name)
  if (!existsSync(dst) && existsSync(src) && name === 'persona') symlinkSync(src, dst)
  if (name === 'knowledge') mkdirSync(dst, { recursive: true }) // fameex 的环境知识不带进 falive 回放
}
if (dry) {
  log('dry：目录与配置已就绪，不起进程')
  process.exit(0)
}

// —— claude 调用缓存 ——
// 真 claude：SIM_REAL_CLAUDE 显式给的优先，否则 PATH 里第一个不是包装壳的（包装壳自己也按同一规则找，这里先解析好传下去，日志里看得到用的哪个）。
const { resolveRealClaude } = await import('./claude-cache.mjs')
const aiCacheLog = join(simDir, 'ai-cache.log')
const aiCacheLogStart = existsSync(aiCacheLog) ? statSync(aiCacheLog).size : 0
const aiCacheEnv = aiCache ? { LARK_CLAUDE_BIN: join(here, 'claude'), SIM_REAL_CLAUDE: resolveRealClaude() } : {}
log(aiCache ? `claude 调用缓存开（真 claude：${aiCacheEnv.SIM_REAL_CLAUDE}）` : 'claude 调用缓存关（--no-ai-cache），全部真调')
// 本次运行追加到 ai-cache.log 的行：hit / miss / bypass 计数 + 按 resultKind 细分（同一 sim 跨天续跑，只数本次）。
const aiCacheSummary = () => {
  if (!existsSync(aiCacheLog)) return '无 claude 调用'
  const lines = readFileSync(aiCacheLog).subarray(aiCacheLogStart).toString('utf8').split('\n').filter(Boolean)
  const total = { hit: 0, miss: 0, bypass: 0 }
  const byKind = {}
  let savedMs = 0
  for (const line of lines) {
    const [, outcome, kind, , , ...rest] = line.split(' ')
    if (!(outcome in total)) continue
    total[outcome] += 1
    byKind[kind] ??= { hit: 0, miss: 0, bypass: 0 }
    byKind[kind][outcome] += 1
    if (outcome === 'hit') savedMs += Number(/原耗时 (\d+)ms/.exec(rest.join(' '))?.[1] || 0)
  }
  const cacheable = total.hit + total.miss
  const kinds = Object.entries(byKind).map(([kind, c]) => `${kind} ${c.hit}/${c.miss}/${c.bypass}`).join('，')
  return `hit ${total.hit} / miss ${total.miss} / bypass ${total.bypass}（可缓存命中率 ${cacheable ? Math.round((total.hit / cacheable) * 100) : 0}%，命中省下 ${Math.round(savedMs / 1000)}s）；按类 hit/miss/bypass：${kinds || '无'}`
}

// —— 进程 ——
const env = {
  ...process.env,
  SIM_DIR: simDir,
  LARK_RUNTIME_DIR: runtimeDir,
  LARK_CLI_BIN: join(here, 'lark-cli'),
  LARK_GATEWAY_PORT: String(port),
  LARK_GATEWAY_URL: `http://127.0.0.1:${port}`,
  LARK_GATEWAY_SECRET: 'sim-secret',
  LARK_BOT_CONSUMER_ROOT: repoLink,
  LARK_BASE_REMOTE: 'origin', // clone 的 origin = 主仓，主仓里有 sim-base-<日期> 分支
  LARK_BASE_BRANCH: baseBranch,
  LARK_DRAIN_RESTART: '0',
  LARK_WAKE_CATCHUP: '0',
  LARK_KEEP_AWAKE: '0',
  LARK_DOCTOR: '0',
  LARK_SELF_FIX: '0',
  LARK_WORKER_CONCURRENCY: value('--conc', '2'),
  LARK_CHAT_NAME_TTL_MS: '600000',
  ...aiCacheEnv,
}
const clockPath = join(simDir, 'clock.json')
const setClock = (virtualMs) => writeFileSync(clockPath, JSON.stringify({ virtualMs, realMs: Date.now() }))
let virtualNow = fromMs
setClock(virtualNow)
const preload = join(here, 'virtual-clock.mjs')
const spawnNode = (name, script, extra = []) => {
  const out = join(simDir, `${name}.log`)
  const child = spawn('node', ['--import', preload, script, ...extra], { cwd: larkBotRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (chunk) => appendFileSync(out, chunk))
  child.stderr.on('data', (chunk) => appendFileSync(out, chunk))
  child.on('exit', (code) => log(`${name} 退出 code=${code}`))
  return child
}
const gateway = spawnNode('gateway', join(larkBotRoot, 'lark-gateway.mjs'), ['--config', join(runtimeDir, 'lark-bot.local.json'), '--port', String(port)])
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const health = async () => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/lark/health`)
    return res.ok
  } catch {
    return false
  }
}
for (let i = 0; i < 60 && !(await health()); i += 1) await sleep(500)
if (!(await health())) throw new Error('网关没起来，看 gateway.log')
const worker = spawnNode('worker', join(larkBotRoot, 'runtime', 'lark-worker.mjs'))
log(`网关 :${port} 与 worker 已起（基线 origin/${baseBranch}）`)

const ACTIVE = new Set(['received', 'queued', 'running', 'verifying', 'result_pending_receipt', 'done_pending_writeback'])
const listTasks = async () => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/lark/tasks`, { headers: { 'x-lark-gateway-secret': 'sim-secret' } })
    return (await res.json()).tasks || []
  } catch {
    return null
  }
}
const waitIdle = async (label, settle = settleMs) => {
  const started = Date.now()
  let idleSince = null
  for (;;) {
    const tasks = await listTasks()
    const active = tasks ? tasks.filter((t) => ACTIVE.has(t.status) || t.ackPending) : []
    const elapsed = Date.now() - started
    if (!active.length && elapsed >= settle) {
      idleSince ??= Date.now()
      if (Date.now() - idleSince >= 3000) return
    } else idleSince = null
    if (elapsed > maxWaitMs) {
      log(`${label}：等了 ${Math.round(elapsed / 60000)} 分钟仍有 ${active.length} 条在跑（${active.map((t) => `${t.id.slice(-6)}:${t.status}`).join(' ')}），继续喂下一条`)
      return
    }
    await sleep(3000)
  }
}

const shutdown = () => {
  worker.kill('SIGTERM')
  gateway.kill('SIGTERM')
}
process.on('SIGINT', () => { shutdown(); process.exit(130) })

for (const m of events) {
  if (fed.has(m.id)) continue
  if (m.atMs > virtualNow) {
    virtualNow = m.atMs
    setClock(virtualNow)
  }
  const event = toSimEvent(m, { botOpenId: BOT_OPEN_ID })
  appendFileSync(join(simDir, 'events.ndjson'), `${JSON.stringify(event)}\n`)
  fed.add(m.id)
  writeFileSync(fedPath, JSON.stringify([...fed]))
  log(`喂 ${m.id} ${new Date(m.atMs).toISOString().slice(5, 16)} ${m.chatKey} ${m.senderName}：${String(m.text).replace(/\s+/g, ' ').slice(0, 60)}${m.atBot ? '（@bot）' : ''}`)
  // 没叫 bot 的群消息网关只记上下文 / 并入补料，等 3 秒就够；@bot / 私信 / 回复 bot 的才等「收到」巡检与任务跑完。
  const replyToBot = m.parentId ? Boolean(timeline.find((x) => x.id === m.parentId)?.ownBot) : false
  const trigger = m.atBot || replyToBot || (m.chatKey === 'webhook-group' && m.senderId === AVEN_OPEN_ID)
  await waitIdle(m.id, trigger ? settleMs : 3000)
}
log('事件喂完；再等一轮空闲后收尾')
await waitIdle('final')
// 让虚拟时间再走 5 小时：逾期义务 / 催办巡检有机会跑到（parked 15 分钟一轮、ack 15 秒一轮）
virtualNow += 5 * 60 * 60_000
setClock(virtualNow)
await sleep(20_000)
shutdown()
await sleep(2000)
log(`claude 调用缓存：${aiCache ? aiCacheSummary() : '关'}`)
log('完成')
process.exit(0)
