#!/usr/bin/env node
/**
 * 离线模拟器编排（docs/falive-replay-plan-2026-11-03.md §2 L2 / L3）：真网关 + 真 worker 跑在隔离运行目录，
 * lark-cli 换成 scripts/sim/lark-cli（时间线供数、发件落 outbox），Date 换成虚拟时钟，按时间线逐条喂事件，每条等系统空闲再喂下一条。
 *   node scripts/sim/run-sim.mjs --sim day1020 --from 2026-10-20T08:00+04:00 --to 2026-10-20T20:00+04:00 [--reset] [--effort medium] [--intent-effort high]
 *        [--max-wait-min 30] [--settle-sec 25] [--dry]（只准备目录与事件，不起进程）[--no-ai-cache]（关掉 claude 调用缓存，全部真调）
 *   按事件组跑（design-v2 §2 / P0-d，scripts/sim/run-episodes.mjs 调）：--sim <轮>/<组> --episode <组 id> --from --to [--tail-to <ISO>] [--tail-hours 5]
 *        只喂本组的 case（组里 caseIds 落在 [from, to) 的）；同群其它真人消息、别的组的 case 都只是上下文（假 CLI 按虚拟时钟从时间线供）；
 *        falive 对本组 case 说过的话（episodes.json 的 faliveBotIds）不供，组外的 bot 话照供（meta.json hideBotIds，见 fake-lark-cli hideFaliveBot）。
 *        跨天的组由 run-episodes 按天多次调本脚本、共用一个 sim 目录（每天重钉业务仓基线，同 run-days）；虚拟时钟只进不退，
 *        --tail-to 给下一段第一条 case 的时刻：收尾时钟往前走不超过它。
 * 产物：runtime/falive-replay/sim/<sim>/ 下 outbox.jsonl（bot 发了什么）、runtime/（任务 / 审计 / 发件簿 / 义务）、gateway.log / worker.log、events.ndjson。
 * claude 调用缓存（§6 改法 2）：LARK_CLAUDE_BIN 指到 scripts/sim/claude（claude-cache.mjs），只读调用（分类 / 分诊 / 分析 / 代答 / 实测）
 *   按规范化后的完整输入复用上次输出，可写调用与续会话直通；每次调用记 SIM_DIR/ai-cache.log，收尾在 sim.log 打本次 hit / miss / bypass 计数。
 * 基线代码：按窗口起点把 falive-react 当时用的基线分支（faliveBranchAt）钉到当时的提交（主仓建分支 sim-base-<日期>；每个 sim 一份 clone --shared，origin = 主仓）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AVEN_OPEN_ID, BOT_APP_ID, GROUPS, casesDir, datasetDir, faliveRuntimeDir, rawDir, replayRoot, resolveRaw, toSimEvent } from './falive-data.mjs'
import { startSampler } from './proc-sampler.mjs'

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
const aiCache = flag('--ai-cache') // 默认关：只跑一次完整确认时用不上，缓存脚本也没测完（11-03）
const episodeId = value('--episode', null)
const tailToMs = value('--tail-to', null) ? Date.parse(value('--tail-to', null)) : Infinity
const tailMs = Number(value('--tail-hours', 5)) * 3600_000
const BOT_OPEN_ID = 'ou_e331d79d4491e64b7bba89bb4e3b5e43'
const FALIVE_REPO = join(homedir(), 'github', 'falive-react')
// 业务仓基线分支按时间取 falive 当时实际用的（11-04 p0h 校准发现：原来一律 phase-6-ol，10-30 之前的组 bot 看到的业务代码不是当时那版）。
// 时间点取自 falive 网关每次启动打印的「repo falive: … base=<分支>」（~/Library/Logs/falive-lark/gateway.log）；phase-4-page 本地分支已删，用 origin 上的。
const FALIVE_BRANCHES = [
  [Date.parse('2026-10-30T19:35:46Z'), 'feature/phase-6-ol'],
  [Date.parse('2026-10-26T06:40:50Z'), 'feature/phase-5-test'],
  [Date.parse('2026-10-21T12:33:22Z'), 'feature/phase-4-api'],
  [0, 'origin/feature/phase-4-page'],
]
const faliveBranchAt = (ms) => FALIVE_BRANCHES.find(([since]) => ms >= since)[1]

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
// 时间线里的 localPath 已是绝对路径（11-03 发现：原来又拼到 raw/ 后面，所有模拟附件全部下载失败）；补拉的附件在 raw/resources-extra.json。
for (const m of timeline) for (const r of m.resources || []) if (r.localPath) resources[`${m.id}/${r.key}`] = resolveRaw(r.localPath)
const extraResourcesPath = join(rawDir, 'resources-extra.json')
if (existsSync(extraResourcesPath)) for (const [k, p] of Object.entries(JSON.parse(readFileSync(extraResourcesPath, 'utf8')).resources || {})) resources[k] = resolveRaw(p)
writeFileSync(join(simDir, 'resources.json'), JSON.stringify(resources))
// 按事件组跑：只喂本组的 case；按天跑（旧）：窗口内全部真人消息（网关自己丢掉不触发 bot 的）。
const episode = episodeId ? (JSON.parse(readFileSync(join(casesDir, 'episodes.json'), 'utf8')).groups || []).find((g) => g.id === episodeId) : null
if (episodeId && !episode) throw new Error(`episodes.json 里没有 ${episodeId}`)
const metaPath = join(simDir, 'meta.json')
const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : null
if (meta && (meta.episode || null) !== (episodeId || null)) throw new Error(`${simDir} 是 ${meta.episode || '按天跑'} 的目录，不是 ${episodeId || '按天跑'}`)
if (!meta) writeFileSync(metaPath, JSON.stringify({ simStartMs: fromMs, createdAt: new Date().toISOString(), ...(episode ? { episode: episode.id, caseIds: episode.caseIds, hideBotIds: episode.faliveBotIds || [] } : {}) }))
const caseSet = episode ? new Set(episode.caseIds) : null
const events = episode
  ? timeline.filter((m) => caseSet.has(m.id) && m.atMs >= fromMs && m.atMs < toMs)
  : timeline.filter((m) => m.atMs >= fromMs && m.atMs < toMs && !m.ownBot && !m.deleted && m.senderType === 'user' && (m.text || m.resources?.length))
const fedPath = join(simDir, 'fed.json')
const fed = new Set(existsSync(fedPath) ? JSON.parse(readFileSync(fedPath, 'utf8')) : [])
log(`窗口 ${new Date(fromMs).toISOString()} → ${new Date(toMs).toISOString()}：${events.length} 条${episode ? `本组（${episode.id}）case` : '真人消息'}（已喂 ${fed.size}）`)

// —— 业务仓基线：钉到窗口起点当时的提交 ——
const git = (cmd, cwd = FALIVE_REPO) => spawnSync('git', cmd, { cwd, encoding: 'utf8' })
const FALIVE_BRANCH = faliveBranchAt(fromMs)
const baseSha = git(['rev-list', '-1', `--before=${new Date(fromMs).toISOString()}`, FALIVE_BRANCH]).stdout.trim()
if (!baseSha) throw new Error(`falive-react 在 ${new Date(fromMs).toISOString()} 之前没有 ${FALIVE_BRANCH} 提交`)
// 分支名带提交号：按组跑时同一天不同组的窗口起点不同、基线提交可能不同，只按日期命名会被并行的组互相 -f 改掉（拿到别组的「未来」提交）
const baseBranch = `sim-base-${new Date(fromMs).toISOString().slice(0, 10)}-${baseSha.slice(0, 8)}`
// 并行的组可能同时改主仓的 ref（锁冲突就失败）：重试到分支确实指向基线为止
for (let i = 0; git(['rev-parse', '--verify', '--quiet', `refs/heads/${baseBranch}`]).stdout.trim() !== baseSha; i += 1) {
  if (i >= 10) throw new Error(`建不了基线分支 ${baseBranch}`)
  git(['branch', '-f', baseBranch, baseSha])
  if (git(['rev-parse', '--verify', '--quiet', `refs/heads/${baseBranch}`]).stdout.trim() !== baseSha) spawnSync('sleep', [String(0.2 + Math.random())])
}
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
// 主仓 origin 上别人的分支按窗口起点钉回当时的提交（11-04 b3 ep-1031-35935b：模拟仓只剩基线，「查重：别的分支是不是已经有人做了」无从查起；
// falive 当时就是从 origin/codex/task-center-core 看到 Justin 已做了完善资料）。只留窗口前 30 天内有提交的，按提交时间取（看不到窗口之后的）。
const pinnedBefore = new Date(fromMs).toISOString()
let pinnedBranches = 0
for (const ref of git(['for-each-ref', '--format=%(refname)', 'refs/remotes/origin']).stdout.split('\n').filter(Boolean)) {
  if (ref === 'refs/remotes/origin/HEAD' || ref === `refs/remotes/origin/${baseBranch}`) continue
  const [sha, at] = git(['log', '-1', `--before=${pinnedBefore}`, '--format=%H %ct', ref]).stdout.trim().split(' ')
  if (!sha || Number(at) * 1000 < fromMs - 30 * 86_400_000) continue
  if (git(['update-ref', ref, sha], repoLink).status === 0) pinnedBranches += 1
}
git(['config', 'remote.origin.fetch', `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`], repoLink)
if (git(['rev-parse', 'HEAD'], repoLink).stdout.trim() !== baseSha) {
  const out = git(['checkout', '--quiet', '--detach', baseSha], repoLink)
  if (out.status !== 0) throw new Error(`checkout 基线失败：${out.stderr.slice(0, 300)}`)
}
if (!existsSync(join(repoLink, 'node_modules'))) symlinkSync(join(FALIVE_REPO, 'node_modules'), join(repoLink, 'node_modules'))
log(`业务仓 origin 其它分支按窗口起点钉回 ${pinnedBranches} 条`)
log(`业务仓基线 ${baseBranch} = ${baseSha.slice(0, 8)}（${git(['log', '-1', '--format=%ci %s', baseSha]).stdout.trim().slice(0, 100)}）`)

// —— 运行配置 ——
const faliveConfig = JSON.parse(readFileSync(join(homedir(), 'github', 'lark-bot-falive', 'runtime', 'lark-bot.local.json'), 'utf8'))
const repo = faliveConfig.repos?.falive || {}
// 模型 / 强度与线上 fameex 运行配置对齐（design-v2 §8 前置 1：原来 worker 取 falive 配置或 medium、分类默认 high，线上是 worker high、分类 low——测的不是线上那个 bot）。
// 只取模型相关字段；仓库、环境地址、群这些项目相关项仍按 falive。--effort / --intent-effort 显式给了才覆盖（L1 两档对照用）。
const prodConfig = JSON.parse(readFileSync(join(homedir(), 'github', 'lark-bot', 'runtime', 'lark-bot.local.json'), 'utf8'))
const prodModel = prodConfig.claudeModel || 'claude-opus-5-5'
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
  claudeModel: prodModel,
  claudeEffort: value('--effort', prodConfig.claudeEffort || 'high'),
  claudeIntentModel: prodConfig.claudeIntentModel || prodModel,
  claudeIntentEffort: value('--intent-effort', prodConfig.claudeIntentEffort || prodConfig.claudeEffort || 'high'),
  ...(prodConfig.claudeAnalysisModel ? { claudeAnalysisModel: prodConfig.claudeAnalysisModel } : {}),
  ...(prodConfig.claudeAnalysisEffort ? { claudeAnalysisEffort: prodConfig.claudeAnalysisEffort } : {}),
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
  // falive php 发验证码 type：1 注册 / 2 找回密码 / 3 登录（falive-react src/modules/auth/data/schema.ts VerificationCodeType）；portal 用 scene=login 不用配
  egress: { loginCodeTypes: ['3'] },
  dailyReport: { enabled: false },
  // bug 表占位（读 bug 单的工具 tools/read-bug-record.mjs 要它；假 CLI 按 raw/bug-records 缓存供数，appToken 不校验）。bug-watch 不起。
  bugTable: { appToken: 'sim-falive-bugtable', tableId: 'tblbJYjrxZsPe40V', viewId: 'vewvqqPhkD', statusField: '状态', assigneeField: '负责RD', watch: { enabled: false } },
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
// 测试号：falive 当时从 Claude 记忆 pre-test-account.md 读到负责人给的各环境测试号（含 Kaiser 的生产号 uid 484），lark-bot 的对应物是固定知识
//（runtime/knowledge）。11-04 b3 ep-1031-35935b「测生产评论任务」lark-bot 回「没有生产测试账号」——模拟里根本没给它。按窗口起点还原那篇
//（窗口前改过的原样拷；之后改过的按段落里写的日期去掉窗口之后的段——那篇被 Bash 改过，会话记录重放不出来，见 memory-asof keepParagraphsAsOf），写进知识目录。
const accountsMemory = repo.claudeMemoryDir ? join(repo.claudeMemoryDir, 'pre-test-account.md') : null
const accountsKnowledge = join(runtimeDir, 'knowledge', 'falive-test-accounts.md')
if (accountsMemory && existsSync(accountsMemory) && !existsSync(accountsKnowledge)) {
  const { keepParagraphsAsOf } = await import('./memory-asof.mjs')
  const raw = readFileSync(accountsMemory, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '').trim()
  const body = statSync(accountsMemory).mtimeMs < fromMs ? raw : keepParagraphsAsOf(raw, fromMs)
  writeFileSync(accountsKnowledge, `## Falive 各环境测试号（负责人给的；密码不发群）\n\n${body}\n`, { mode: 0o600 })
  log(`测试号知识：${body.length} 字（窗口起点之后写的段已去掉）`)
}
if (dry) {
  log('dry：目录与配置已就绪，不起进程')
  process.exit(0)
}

// —— claude 调用缓存 ——
// 真 claude：SIM_REAL_CLAUDE 显式给的优先，否则 PATH 里第一个不是包装壳的（包装壳自己也按同一规则找，这里先解析好传下去，日志里看得到用的哪个）。
const resolveRealClaude = aiCache ? (await import('./claude-cache.mjs')).resolveRealClaude : () => null // 缓存脚本未入库，只在 --ai-cache 时加载
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
  LARK_WORKER_CONCURRENCY: value('--conc', '4'),
  LARK_CHAT_NAME_TTL_MS: '600000',
  // 额度闸（claude-quota.mjs）：撞限额时等到重置再重试；lark-bot 的真实时间超时放大到 8 小时，原超时由闸按真实耗时执行（不算等额度的时间）
  LARK_CLAUDE_BIN: join(here, 'claude-q'),
  LARK_CLAUDE_IDLE_TIMEOUT_MS: String(8 * 3600_000),
  LARK_INTENT_CLASSIFIER_TIMEOUT_MS: String(8 * 3600_000),
  LARK_WORKER_AI_TIMEOUT_MS: String(8 * 3600_000),
  LARK_TASK_LEASE_MS: String(9 * 3600_000), // worker 启动自检：AI 超时必须小于租约（r10 第一次起跑 worker 因此拒绝启动，任务全卡 received）
  // 应用令牌直铸（lib/lark-tenant-token，1cc516e）会读线上 ~/.config/fameex-lark/lark-app-secret 去请求真飞书：回放里指到本机不存在的端口，立刻失败、回落假 lark-cli
  LARK_APP_ID: 'cli_sim_replay',
  LARK_OPEN_API_HOST: 'http://127.0.0.1:9',
  SIM_ORIG_IDLE_MS: process.env.LARK_CLAUDE_IDLE_TIMEOUT_MS || '600000',
  SIM_ORIG_INTENT_MS: process.env.LARK_INTENT_CLASSIFIER_TIMEOUT_MS || '120000',
  SIM_ORIG_TOTAL_MS: process.env.LARK_WORKER_AI_TIMEOUT_MS || '1800000',
  ...aiCacheEnv,
  ...(aiCache ? { SIM_REAL_CLAUDE: join(here, 'claude-q') } : {}),
  // 出网审计（design-v2 §8 前置 7）：curl / wget / lark-cli 壳放 PATH 最前（claude 的 Bash 工具保留这个 PATH，11-04 实测），
  // node 子进程全部预载 egress-hook 记 fetch / http(s)；都落 SIM_DIR/egress.log，egress-audit.mjs 归类。
  // 第二道保险（11-04）：真 lark-cli 的配置目录指到空目录——就算有进程绕过 PATH 壳调到真 lark-cli，user / bot 身份都是「not configured」，读写不了真飞书。
  LARKSUITE_CLI_CONFIG_DIR: join(simDir, 'no-lark-credentials'),
  PATH: `${join(here, 'egress')}:${process.env.PATH || ''}`,
  NODE_OPTIONS: `${process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : ''}--import ${join(here, 'egress-hook.mjs')}`,
}
mkdirSync(join(simDir, 'no-lark-credentials'), { recursive: true })
const clockPath = join(simDir, 'clock.json')
const setClock = (virtualMs) => writeFileSync(clockPath, JSON.stringify({ virtualMs, realMs: Date.now() }))
// 虚拟时钟只进不退：同一 sim 目录跨天续跑时，上一段收尾可能已经走过了这一段的 --from
const prevVirtual = (() => { try { return Number(JSON.parse(readFileSync(clockPath, 'utf8')).virtualMs) || 0 } catch { return 0 } })()
let virtualNow = Math.max(fromMs, prevVirtual)
setClock(virtualNow)
// 撞额度暂停期间冻住虚拟时钟（各进程每 200ms 读一次 clock.json）：等额度的真实时间不算虚拟时间，义务 / 催办 / 「收到」巡检都不往前走。
const { pausedUntil } = await import('./claude-quota.mjs')
let frozenAt = null
let pausedMsTotal = 0
setInterval(() => {
  if (pausedUntil()) {
    if (frozenAt == null) { frozenAt = clockNow(); log(`额度暂停：虚拟时钟冻在 ${new Date(frozenAt).toISOString()}`) }
    setClock(frozenAt)
    pausedMsTotal += 1000
  } else if (frozenAt != null) { log('额度恢复：虚拟时钟接着走'); frozenAt = null }
}, 1000).unref()
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
// 本实例进程树的内存 + 出网连接采样（P0-e / 前置 7）：mem.jsonl、mem-peak.json、egress.log（via sock）
const sampler = startSampler({ simDir, rootPid: process.pid, intervalMs: Number(value('--sample-sec', 5)) * 1000 })

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
  let started = Date.now()
  let idleSince = null
  for (;;) {
    if (pausedUntil()) { await sleep(3000); started += 3000; continue }
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
process.on('SIGTERM', () => { shutdown(); process.exit(143) }) // 守卫按 pid / pkill 停 run-sim 时把网关、worker 一起带走

// 喂事件的节奏（11-03 改）：系统有任务在跑时虚拟时间按真实速度走，到下一条消息的时刻就喂（当时群里的人就是在 bot 干活时接着说话的，
// 会被并入 / 进上下文）；系统空闲就直接跳到下一条。原来每条都等完全空闲才喂下一条，既慢又把并发的对话串成了先后。
const clockNow = () => {
  try {
    const c = JSON.parse(readFileSync(clockPath, 'utf8'))
    return c.virtualMs + (Date.now() - c.realMs)
  } catch {
    return virtualNow
  }
}
const isIdle = async () => {
  const tasks = await listTasks()
  return Boolean(tasks) && !tasks.some((t) => ACTIVE.has(t.status) || t.ackPending)
}
const byIdAll = new Map(timeline.map((m) => [m.id, m]))
// 触发 bot 的（@bot / 私信 / 回复 bot 的消息）喂完等网关接住；其余只进上下文（读历史时按时钟从时间线取），网关直接丢，不用等。
const triggersBot = (m) => m.atBot || m.chatKey === 'webhook-group' || Boolean(m.parentId && byIdAll.get(m.parentId)?.ownBot)
// 空闲要稳住 3 秒、期间没有新发件（seq.json 不动）才跳表（11-04 b2 ep-1031-35935b：worker 把任务写成 done 后网关还在建细节文档、
// 发结论，这一刻任务列表已经「空闲」，时钟跳到 4 小时后的下一条，结论被盖上跳表后的时刻，裁判判「晚了 4 小时」；实际 2.5 分钟就答了）。
const sentSeq = () => { try { return JSON.parse(readFileSync(join(simDir, 'seq.json'), 'utf8')).n || 0 } catch { return 0 } }
const IDLE_STABLE_MS = 3000
const advanceTo = async (targetMs, label, settleMs = 1500) => {
  let started = Date.now()
  let idleSince = null
  let idleSeq = null
  await sleep(settleMs) // 刚喂的消息先让网关接住（建任务 / 挂「收到」），再判空闲
  for (;;) {
    if (pausedUntil()) { await sleep(2000); started += 2000; idleSince = null; continue }
    if (clockNow() >= targetMs) return
    if (await isIdle()) {
      const seq = sentSeq()
      if (idleSince == null || seq !== idleSeq) { idleSince = Date.now(); idleSeq = seq }
      else if (Date.now() - idleSince >= IDLE_STABLE_MS || Date.now() - started > maxWaitMs) {
        setClock(targetMs)
        return
      }
      await sleep(1000)
      continue
    }
    idleSince = null
    if (Date.now() - started > maxWaitMs) {
      log(`${label}：忙了 ${Math.round((Date.now() - started) / 60000)} 分钟还没到下一条的时刻，直接跳过去`)
      setClock(targetMs)
      return
    }
    await sleep(2000)
  }
}

// 人回复的那张 falive 卡是对组内哪条 case 说的（11-04 b2 ep-1014-d74f19 / ep-1031-35935b：原来一律改成回复「模拟 bot 在同群对本组 case 说的最近一句」，
// Ache 回 R6 复测卡「麻烦再看看」被接到 Arthur 那条 123456 / token 复测的「收到」下面，分类器照引用判 continues，测错了对象；
// Arthur 回 falive 的「uat 已部署」通知卡，被接到要账号密码那条的回复下面）。认法：卡自己的回复链（最多 5 跳）落到组内 case；
// 否则按 falive 发件簿（runtime/lark-outbox/<群>.jsonl，带 taskId，10-27 起才有）同群 ±15 秒的那条的 taskId；再不行按卡开头 @ 的人
// 在卡之前 2 小时内最近一条组内 case。认不出 = 对组外的事 / 无主通知。
let faliveOutbox = null
const faliveOutboxOf = (chatId) => {
  faliveOutbox ??= new Map()
  if (!faliveOutbox.has(chatId)) {
    const path = join(faliveRuntimeDir, 'lark-outbox', `${chatId}.jsonl`)
    let rows = []
    try { rows = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) } catch {}
    faliveOutbox.set(chatId, rows)
  }
  return faliveOutbox.get(chatId)
}
const caseOfFaliveCard = (cardId) => {
  let card = byIdAll.get(cardId) || null
  for (let hop = 0; card && hop < 5; hop += 1) {
    const up = card.parentId || null
    if (up && caseSet.has(up)) return up
    card = up ? byIdAll.get(up) || null : null
  }
  const self = byIdAll.get(cardId)
  if (!self?.chatId || !Number.isFinite(self.atMs)) return null
  const near = faliveOutboxOf(self.chatId)
    .map((o) => ({ taskId: o.taskId, gap: Math.abs(Date.parse(o.at) - self.atMs) }))
    .filter((o) => o.taskId && caseSet.has(o.taskId) && o.gap <= 15_000)
    .sort((a, b) => a.gap - b.gap)
  if (near[0]) return near[0].taskId
  // 发件簿没有的（10-27 前）：falive 的群卡开头 @ 的是在答谁，取同群、卡之前 2 小时内这个人最近一条组内 case（实测组内对得上的都在 100 分钟内；放到 6 小时会把 Ache 回 R6 卡接到她早上「预约改版」那条）。
  const firstAt = /@[^(\s]*\((ou_[0-9a-f]+)\)|<at user_id="(ou_[0-9a-f]+)"/.exec(String(self.cliText ?? self.text ?? ''))
  const to = firstAt ? firstAt[1] || firstAt[2] : null
  if (!to) return null
  return timeline.filter((c) => caseSet.has(c.id) && c.chatId === self.chatId && c.senderId === to && c.atMs <= self.atMs && self.atMs - c.atMs <= 2 * 3600_000).at(-1)?.id || null
}

let jumpedToFirst = false
for (const [index, m] of events.entries()) {
  if (fed.has(m.id)) continue
  if (!jumpedToFirst) {
    if (m.atMs > clockNow()) setClock(m.atMs) // 本次起跑（或断点续跑）的第一条：时钟直接跳到它
    jumpedToFirst = true
  }
  virtualNow = Math.max(clockNow(), m.atMs)
  const event = toSimEvent(m, { botOpenId: BOT_OPEN_ID })
  // 组内的人回复的是 falive 对组内 case 说的话（本次模拟里那句由模拟 bot 说、id 不同，原 id 的消息 bot 认不出是自己的 → 网关当成没 @ 的群聊丢掉；
  // P0-d 冒烟 ep-1029「cc @HQUCEncone」就这样没接住）：改成回复模拟 bot 在同群（私信）里对本组 case 说的最近一句，记 remap.jsonl。
  if (episode && m.parentId && (meta?.hideBotIds || episode.faliveBotIds || []).includes(m.parentId)) {
    const sent = existsSync(join(simDir, 'sent.json')) ? JSON.parse(readFileSync(join(simDir, 'sent.json'), 'utf8')) : []
    const visible = sent.filter((s) => s.chat_id === event.chat_id && Number(s.create_time) <= clockNow())
    // 私信（负责人私聊）照旧接最近一句；群里先接模拟 bot 对同一条 case 说的话。认不出 / 模拟 bot 没对它说过：@ 了 bot 的原样喂——
    // 被回复的 falive 卡按 id 照供（假 CLI byIdAny 不受隐藏限制），bot 看到的引用就是人当时看到的那张卡，不编一个别人的锚点；
    // 没 @ 的仍接最近一句（原样喂网关认不出是回复 bot，整条丢掉；组内 24 条这样的多是「好」「cc @x」，也有「发布到 pre 了，方便测一下吗」）。
    const ownCase = event.chat_type === 'p2p' ? null : caseOfFaliveCard(m.parentId)
    const latest = visible.filter((s) => (s.parent_id ? caseSet.has(s.parent_id) : event.chat_type === 'p2p')).at(-1)
    const sameCase = ownCase ? visible.filter((s) => s.parent_id === ownCase).at(-1) : null
    const target = event.chat_type === 'p2p' ? latest : sameCase || (m.atBot ? null : latest)
    if (!target && event.chat_type !== 'p2p') {
      appendFileSync(join(simDir, 'remap.jsonl'), `${JSON.stringify({ caseId: m.id, faliveParent: m.parentId, simParent: null, faliveCase: ownCase, reason: ownCase ? 'sim_bot_silent_on_case' : 'card_not_for_group_case' })}\n`)
      log(`${m.id} 回复的 falive 卡 ${m.parentId}${ownCase ? `是对 ${ownCase} 说的，模拟 bot 还没对它说过话` : '不是对组内 case 说的'}：原样喂（引用照供 falive 原卡）`)
    } else if (target) {
      Object.assign(event, { reply_to: target.message_id, root_id: target.root_id || target.message_id })
      if (target.thread_id) event.thread_id = target.thread_id
      else delete event.thread_id
      appendFileSync(join(simDir, 'remap.jsonl'), `${JSON.stringify({ caseId: m.id, faliveParent: m.parentId, simParent: target.message_id, simThread: target.thread_id || null, faliveCase: ownCase })}\n`)
      log(`${m.id} 回复的是 falive 对组内 case 的原话 ${m.parentId}：改成回复模拟 bot 的 ${target.message_id}`)
    } else log(`${m.id} 回复的是 falive 对组内 case 的原话 ${m.parentId}，模拟 bot 在这里还没说过话：原样喂（多半接不住，裁判标模拟局限）`)
  }
  appendFileSync(join(simDir, 'events.ndjson'), `${JSON.stringify(event)}\n`)
  fed.add(m.id)
  writeFileSync(fedPath, JSON.stringify([...fed]))
  log(`喂 ${m.id} ${new Date(m.atMs).toISOString().slice(5, 16)} ${m.chatKey} ${m.senderName}：${String(m.text).replace(/\s+/g, ' ').slice(0, 60)}${m.atBot ? '（@bot）' : ''}`)
  const next = events[index + 1]
  if (next) await advanceTo(next.atMs, m.id, triggersBot(m) ? 1500 : 200)
}
log('事件喂完；再等一轮空闲后收尾')
await waitIdle('final')
// 让虚拟时间再走 5 小时：逾期义务 / 催办巡检有机会跑到（parked 15 分钟一轮、ack 15 秒一轮）。
// 跨天的组中间那段：不超过下一段第一条 case（--tail-to），时钟只进不退，下一段不会倒着走。
virtualNow = Math.max(clockNow(), Math.min(clockNow() + tailMs, tailToMs))
setClock(virtualNow)
await sleep(20_000)
if (episode) await waitIdle('tail', 5000) // 巡检起的单（催办 / 义务）跑完再收：组是最小断点单位，收尾不能截断在飞任务
const peak = sampler.stop()
log(`进程树内存峰值 ${peak.rssMb}MB（${peak.at || '-'}，${peak.procs || 0} 个进程：${Object.entries(peak.byCommMb || {}).map(([k, v]) => `${k} ${v}`).join('、')}）`)
shutdown()
await sleep(2000)
log(`claude 调用缓存：${aiCache ? aiCacheSummary() : '关'}`)
log('完成')
process.exit(0)
