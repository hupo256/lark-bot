#!/usr/bin/env node
/**
 * 用 falive bot 自己的代码跑离线模拟器（design-v2 §8 P0-h / P1 校准）：模拟器里跑 falive 当时的代码，应当复现 falive 当时的表现；
 * 复现不了的差异就是模拟器的偏差（修模拟器或标「模拟局限」），不是 lark-bot 的问题。
 *   node scripts/sim/run-sim-falive.mjs --episode ep-1028-ee9885 [--sim <名>] [--reset] [--dry] [--port 3205] [--falive-ref <sha>]
 *        [--tail-min 60] [--max-wait-min 30] [--report-only]
 * 与 run-sim.mjs（跑 lark-bot）共用：假 lark-cli（scripts/sim/lark-cli）、虚拟时钟预载、额度闸 claude-q、业务仓 clone --shared 钉到当时的提交。
 * falive 和 lark-bot 不一样的地方（这里各自接上）：
 *   · 收消息：falive 是 repo-only 实例，用户身份轮询 `+chat-messages-list`（不走长连接事件）。所以不写 events.ndjson，只推虚拟时钟：
 *     消息到点就在假 CLI 里「出现」，轮询自己拉到；喂到组内的触发消息后等轮询状态里 seen 有它再往下走。
 *     组外的触发消息（别的 case）进 meta.hiddenIds，哪儿都不供——不然轮询看到 @bot 就当新任务接走；组外 bot 原话（组开始前的、bugpoll 的）进 meta.keepOwnBotIds 照供。
 *   · 发消息：falive 一律走群自定义机器人 webhook（fetch 直连飞书）。配置里 webhooksByChat 全换成本机 http://127.0.0.1:<端口>/hook/<chat_id>，
 *     这里收下：记进 SIM_DIR/outbox.jsonl（kind=webhook）和 sent.json（之后列消息看得到，渲染同真 CLI 的卡片文本）。
 *   · 代码 / 配置按当时：falive-code-pin.mjs 按 gateway.log 的启动指纹钉提交（复算指纹核对），配置取当时生效的备份。
 *   · 关掉的旁路：日报调度（dailyReport.at）、部署盯梢 / 复测（dailyReport.sweep）、自修 / 体检 / 排空重启 / 分支回收、合盖防睡；
 *     业务仓 clone 的 origin 改成不存在的路径（fetch / push 都不出网，不会碰主仓和 GitLab）。
 *   · 实测：PROBE_HOST 指到本机转发（probe-proxy.mjs → streampre.fdsser.com），拦下 NewRegisteredByMail / sendVerificationCode（pre-client 登录失败会自动注册）。
 *   · 运行态按窗口起点还原：轮询状态（窗口前的都已 seen、5 天内的话题都登记）、发件簿、台账（falive 自己的 ledgerAsOf）、回复义务、待确认清单文档；
 *     falive 自身仓（profile lark-bot 的 root 原是存档目录）换成当时代码的 clone；Claude 记忆拷一份、只留窗口前改过的。
 *   · 上下文保真（11-04 校准查出的模拟偏差，都在假 CLI 里按开关修，不影响 run-sim）：列群消息不含话题回复（meta.threadRepliesInList=false，同真 CLI）；
 *     自家 bot 卡的 sender.open_bot_id 用各群自定义机器人的 open_id（chats.json botOpenId），falive 才认得出「bot，我们自己」。
 *   · 出网审计：每 3 秒 lsof 一遍网关 / worker 及其子进程的 TCP 连接，落 egress.jsonl；飞书 / GitLab / 邮件域名解析出的 IP 命中就记 flagged。
 * 产物：runtime/falive-replay/sim/<sim>/，收尾写 calibration.json / calibration.md（falive 当时 vs falive 代码在模拟器里）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BOT_APP_ID, GROUPS, casesDir, datasetDir, rawDir, replayRoot, resolveRaw } from './falive-data.mjs'
import { FALIVE_ARCHIVE, faliveConfigAt, pinFaliveCode } from './falive-code-pin.mjs'
import { buildCalibration, renderCalibration } from './falive-calibration.mjs'
import { startProbeProxy } from './probe-proxy.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const episodeId = value('--episode', null)
if (!episodeId) throw new Error('--episode <事件组 id> 必填（replay/falive/episodes.json）')
const episode = JSON.parse(readFileSync(join(casesDir, 'episodes.json'), 'utf8')).groups.find((g) => g.id === episodeId)
if (!episode) throw new Error(`episodes.json 里没有 ${episodeId}`)
const simName = value('--sim', `falive-${episodeId}`)
const port = Number(value('--port', 3205))
const hookPort = port + 1
const probePort = port + 2
const maxWaitMs = Number(value('--max-wait-min', 30)) * 60_000
const tailMs = Number(value('--tail-min', 60)) * 60_000
const fromMs = Date.parse(episode.windowStart)
const firstMs = Date.parse(episode.firstAt)
const lastMs = Date.parse(episode.lastAt)
const caseIds = new Set(episode.caseIds)

const simDir = join(replayRoot, 'sim', simName)
const runtimeDir = join(simDir, 'runtime')
if (flag('--reset') && existsSync(simDir)) rmSync(simDir, { recursive: true, force: true })
mkdirSync(runtimeDir, { recursive: true })
mkdirSync(join(simDir, 'repos'), { recursive: true })
const log = (line) => {
  const text = `${new Date().toISOString()} [sim-falive] ${line}`
  console.log(text)
  appendFileSync(join(simDir, 'sim.log'), `${text}\n`)
}
const readJson = (path, fallback) => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return fallback } }

if (flag('--report-only')) {
  const report = buildCalibration({ simDir, episode, faliveArchive: FALIVE_ARCHIVE })
  writeFileSync(join(simDir, 'calibration.json'), JSON.stringify(report, null, 2))
  writeFileSync(join(simDir, 'calibration.md'), renderCalibration(report))
  log(`校准报告已重写：${join(simDir, 'calibration.md')}`)
  process.exit(0)
}

// —— falive 当时的代码与配置 ——
const pin = pinFaliveCode({ atMs: firstMs, ref: value('--falive-ref', null) })
const faliveCode = pin.dir
const { path: faliveConfigPath, config: faliveConfig } = faliveConfigAt(firstMs)
log(`falive 代码 ${pin.sha.slice(0, 7)}（${pin.verified ? `指纹 ${pin.codeHash} 与 gateway.log ${pin.startedAt} 那次启动一致` : `未核对上指纹${pin.codeHash ? `（当时 ${pin.codeHash}，试过 ${pin.tried.map((t) => t.sha).join(' ')}）` : '（10-20 前日志没有指纹）'}，按时间取`}）；配置 ${faliveConfigPath.split('/').pop()}`)

// —— 数据：时间线、群、附件、组内外的可见性 ——
const timeline = JSON.parse(readFileSync(join(datasetDir, 'timeline.json'), 'utf8'))
const caseList = readFileSync(join(casesDir, 'cases.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
const hiddenIds = caseList.filter((c) => !caseIds.has(c.id) && Date.parse(c.at) >= fromMs).map((c) => c.id)
const keepOwnBotIds = timeline.filter((m) => m.ownBot && m.atMs >= fromMs && (m.atMs < firstMs || /\[bugpoll\]/.test(m.text || ''))).map((m) => m.id)
writeFileSync(join(simDir, 'timeline.json'), JSON.stringify(timeline))
// botOpenId：各群自定义机器人的 open_id（真 CLI 列消息里 bot 卡的 sender.open_bot_id 就是它，falive 靠它认「bot，我们自己」；取自 raw 拉取里占绝大多数的那个）
const CUSTOM_BOT_IDS = { 'php-group': 'ou_caf1610a679ff12b9b92204f37572491', 'tech-group': 'ou_f57c6c1d7caa9f3467607b925abd66a2', 'webhook-group': 'ou_9699982a8993fe4cb4c411e18a6d9b45' }
writeFileSync(join(simDir, 'chats.json'), JSON.stringify(GROUPS.map((g) => ({ chat_id: g.chatId, name: g.name, external: g.external, botOpenId: CUSTOM_BOT_IDS[g.key] }))))
const resources = {}
for (const m of timeline) for (const r of m.resources || []) if (r.localPath) resources[`${m.id}/${r.key}`] = resolveRaw(r.localPath)
const extraResourcesPath = join(rawDir, 'resources-extra.json')
if (existsSync(extraResourcesPath)) for (const [k, p] of Object.entries(readJson(extraResourcesPath, {}).resources || {})) resources[k] = resolveRaw(p)
writeFileSync(join(simDir, 'resources.json'), JSON.stringify(resources))
writeFileSync(join(simDir, 'meta.json'), JSON.stringify({ simStartMs: fromMs, episode: episodeId, hiddenIds, keepOwnBotIds, threadRepliesInList: false, faliveCode: pin, faliveConfig: faliveConfigPath, createdAt: new Date().toISOString() }))
log(`组 ${episodeId}：${episode.size} 个 case，窗口 ${episode.windowStart} 起；组外触发消息隐藏 ${hiddenIds.length} 条，窗口内照供 falive 原话 ${keepOwnBotIds.length} 条`)

// —— 业务仓：clone --shared，本地分支 = 配置里的 baseRef，钉到窗口起点；origin 之后改成不存在的路径 ——
const repoCfg = faliveConfig.repos?.falive || {}
const FALIVE_REPO = repoCfg.root || join(homedir(), 'github', 'falive-react')
const baseRef = repoCfg.baseRef || 'feature/phase-6-ol'
const git = (cmd, cwd = FALIVE_REPO) => spawnSync('git', cmd, { cwd, encoding: 'utf8' })
const before = new Date(fromMs).toISOString()
const baseSha = git(['rev-list', '-1', `--before=${before}`, baseRef]).stdout.trim()
if (!baseSha) throw new Error(`falive-react 在 ${before} 之前没有 ${baseRef} 提交`)
const repoLink = join(simDir, 'repos', 'falive-react')
if (!existsSync(repoLink)) {
  const cloned = git(['clone', '--shared', '--no-checkout', FALIVE_REPO, repoLink])
  if (cloned.status !== 0) throw new Error(`clone --shared 失败：${cloned.stderr.slice(0, 300)}`)
  // 只留基线和当时的 origin/pre、origin/online（falive 的合回 / 提示都提到它们），其余引用删掉（翻 git log --all 看不到「未来」）
  for (const ref of git(['for-each-ref', '--format=%(refname)', 'refs/remotes', 'refs/heads'], repoLink).stdout.split('\n').filter(Boolean)) git(['update-ref', '-d', ref], repoLink)
  for (const upstream of ['pre', 'online']) {
    const sha = git(['rev-list', '-1', `--before=${before}`, `refs/remotes/origin/${upstream}`]).stdout.trim()
    if (sha) git(['update-ref', `refs/remotes/origin/${upstream}`, sha], repoLink)
  }
  const out = git(['checkout', '--quiet', '-B', baseRef, baseSha], repoLink)
  if (out.status !== 0) throw new Error(`checkout 基线失败：${out.stderr.slice(0, 300)}`)
  git(['remote', 'set-url', 'origin', join(simDir, 'no-network-origin.git')], repoLink) // fetch / push 都失败：不出网、不碰主仓
  if (!existsSync(join(repoLink, 'node_modules'))) symlinkSync(join(FALIVE_REPO, 'node_modules'), join(repoLink, 'node_modules'))
}
log(`业务仓 ${baseRef} = ${baseSha.slice(0, 8)}（${git(['log', '-1', '--format=%ci %s', baseSha]).stdout.trim().slice(0, 100)}）`)

// —— falive 自己的仓（profile lark-bot，root 是存档目录 ~/github/lark-bot-falive）：换成当时代码的 clone，存档不许动 ——
const selfRepo = join(simDir, 'repos', 'lark-bot-falive')
const selfCfg = faliveConfig.repos?.['lark-bot']
if (selfCfg && !existsSync(selfRepo)) {
  const cloned = git(['clone', '--shared', '--no-checkout', pin.dir, selfRepo])
  if (cloned.status !== 0) throw new Error(`falive 自身仓 clone 失败：${cloned.stderr.slice(0, 300)}`)
  for (const ref of git(['for-each-ref', '--format=%(refname)', 'refs/remotes', 'refs/heads'], selfRepo).stdout.split('\n').filter(Boolean)) git(['update-ref', '-d', ref], selfRepo)
  const out = git(['checkout', '--quiet', '-B', selfCfg.baseRef || 'feature/falive-repo-profile', pin.sha], selfRepo)
  if (out.status !== 0) throw new Error(`falive 自身仓 checkout 失败：${out.stderr.slice(0, 300)}`)
  git(['remote', 'set-url', 'origin', join(simDir, 'no-network-origin.git')], selfRepo)
}

// —— Claude 记忆：falive 的 claudeMemoryDir 是 aven 的真记忆（会被写、且含之后的事）：拷一份，只留窗口起点之前改过的 ——
const memoryDir = join(simDir, 'claude-memory')
if (repoCfg.claudeMemoryDir && existsSync(repoCfg.claudeMemoryDir) && !existsSync(memoryDir)) {
  mkdirSync(memoryDir, { recursive: true })
  const kept = new Set()
  for (const f of readdirSync(repoCfg.claudeMemoryDir)) {
    const src = join(repoCfg.claudeMemoryDir, f)
    if (f === 'MEMORY.md' || !f.endsWith('.md') || statSync(src).mtimeMs >= fromMs) continue
    copyFileSync(src, join(memoryDir, f))
    kept.add(f)
  }
  const index = readFileSync(join(repoCfg.claudeMemoryDir, 'MEMORY.md'), 'utf8').split('\n')
    .filter((line) => { const link = /\]\(([^)]+\.md)\)/.exec(line)?.[1]; return !link || kept.has(link) })
  writeFileSync(join(memoryDir, 'MEMORY.md'), index.join('\n'))
  log(`Claude 记忆：拷了窗口前改过的 ${kept.size} 篇（之后改过的不带，免得看到未来）`)
}

// —— 运行配置：falive 当时的配置，只换掉出网 / 旁路 / 路径 ——
const hookUrl = (chatId) => `http://127.0.0.1:${hookPort}/hook/${chatId}`
const pollChats = [...new Set([...(repoCfg.chatIds || []), repoCfg.notifyChatId].filter(Boolean))]
// 日报：dailyReport 不能删（读 bug 单的表配置 dailyReport.bugTable 在里面，at 又是必填），把 at 挪到 23:59（10-28 版没有 paused 开关）；
// sweep 删掉 = 部署盯梢 / 复测 / onDeploy 脚本都不起。窗口跨过本地 23:59 的组会触发日报，起跑时报出来。
const dailyRest = repoCfg.dailyReport ? { ...Object.fromEntries(Object.entries(repoCfg.dailyReport).filter(([k]) => k !== 'sweep')), at: '23:59' } : null
const simRepo = {
  ...repoCfg,
  root: repoLink,
  fetchBase: false,
  webhooksByChat: Object.fromEntries(pollChats.map((chatId) => [chatId, { url: hookUrl(chatId) }])),
  webhook: undefined,
  // 日报调度（at）与部署盯梢 / 复测（sweep.preSiteUrl）都不起：只回放主链（handoff §1）
  dailyReport: dailyRest || undefined,
  // 外部群里的自定义机器人 open_id：当时启动时按群成员查（+chat-members-list），这里直接给（falive-data.mjs 里的同一组 id）
  botMentionOpenIds: { oc_40621901e1583e623f6133e8c66d352e: 'ou_f57c6c1d7caa9f3467607b925abd66a2', ...(repoCfg.botMentionOpenIds || {}) },
  claudeMemoryDir: existsSync(memoryDir) ? memoryDir : undefined,
}
// 自身仓的只读目录指着存档的审计 / 日志（含之后的事）：换成本模拟自己的
const selfReadable = (selfCfg?.readableDirs || []).map((dir) => dir.replace(join(FALIVE_ARCHIVE, 'runtime'), runtimeDir).replace(join(homedir(), 'Library', 'Logs', 'falive-lark'), simDir))
const config = {
  ...faliveConfig,
  repos: { ...faliveConfig.repos, falive: simRepo, ...(selfCfg ? { 'lark-bot': { ...selfCfg, root: selfRepo, fetchBase: false, readableDirs: selfReadable } } : {}) },
  consumerRoot: repoLink,
  selfHeal: { drainRestart: false, selfFix: false, doctor: false, reaper: false },
}
writeFileSync(join(runtimeDir, 'lark-bot.local.json'), JSON.stringify(config, null, 2), { mode: 0o600 })
const localDay = (ms) => new Date(ms).toLocaleDateString('sv-SE')
if (dailyRest && localDay(fromMs) !== localDay(lastMs + tailMs + 3600_000)) log('⚠ 窗口跨过本地 23:59：日报调度会在模拟里起一次')

// —— 轮询状态：按「falive 一直在跑」预置——窗口前的消息都已 seen、游标在窗口起点、5 天内活跃的话题都登记上。
// 不预置的话首次启动游标从现在开始，但话题回看（6 小时）/ 旧话题补抓会把窗口前早已处理过的 @bot 当新消息重新接一遍
//（11-04 第一次跑：09:57 那条「请给出详细信息 @Aven.Bot」在 10:29 起的窗口里又被建成任务、真跑了执行）。
const pollerStatePath = join(runtimeDir, 'lark-chat-poller-state.json')
if (!existsSync(pollerStatePath)) {
  const chats = {}
  for (const chatId of pollChats) {
    const before = timeline.filter((m) => m.chatId === chatId && m.atMs < fromMs).sort((a, b) => a.atMs - b.atMs)
    const threads = {}
    for (const m of before.filter((x) => x.threadId && x.atMs >= fromMs - 5 * 24 * 3600_000)) {
      const t = threads[m.threadId] ||= { hostMessageId: m.rootId || m.id, lastActivityMs: 0, lastPolledMs: fromMs }
      t.lastActivityMs = Math.max(t.lastActivityMs, m.atMs)
    }
    chats[chatId] = { cursorMs: fromMs, seen: before.map((m) => m.id).slice(-2000), lastNewMessageAt: before.at(-1)?.atMs || 0, threads, lastThreadScanMs: fromMs }
  }
  writeFileSync(pollerStatePath, JSON.stringify({ chats }))
}

// —— falive 的运行态按窗口起点还原（存档里是 11-03 的样子）：发件簿（出口闸 / 引用查找用）按 at 截；台账用 falive 自己的 ledgerAsOf；
// 回复义务、待确认清单文档只留窗口前就已了结 / 更新过的（之后才变的回放不了当时的状态，不带）。只在第一次建目录时做。
const archiveRuntime = join(FALIVE_ARCHIVE, 'runtime')
const seedMark = join(runtimeDir, '.seeded')
if (!existsSync(seedMark)) {
  const beforeIso = new Date(fromMs).toISOString()
  const outboxDir = join(archiveRuntime, 'lark-outbox')
  if (existsSync(outboxDir)) {
    mkdirSync(join(runtimeDir, 'lark-outbox'), { recursive: true })
    for (const f of readdirSync(outboxDir)) {
      const kept = readFileSync(join(outboxDir, f), 'utf8').split('\n').filter((l) => { try { return JSON.parse(l).at < beforeIso } catch { return false } })
      writeFileSync(join(runtimeDir, 'lark-outbox', f), kept.length ? `${kept.join('\n')}\n` : '')
    }
  }
  const ledgerPath = join(archiveRuntime, 'lark-ledger', 'falive.json')
  if (existsSync(ledgerPath)) {
    const { ledgerAsOf } = await import(join(pin.dir, 'lib', 'lark-ledger.mjs'))
    mkdirSync(join(runtimeDir, 'lark-ledger'), { recursive: true })
    writeFileSync(join(runtimeDir, 'lark-ledger', 'falive.json'), JSON.stringify(ledgerAsOf(readJson(ledgerPath, { items: {}, events: [] }), beforeIso), null, 2))
  }
  const obligationsDir = join(archiveRuntime, 'lark-obligations')
  if (existsSync(obligationsDir)) {
    mkdirSync(join(runtimeDir, 'lark-obligations'), { recursive: true })
    for (const f of readdirSync(obligationsDir)) {
      const kept = Object.fromEntries(Object.entries(readJson(join(obligationsDir, f), {})).filter(([, o]) => String(o.updatedAt || o.createdAt || '') < beforeIso))
      writeFileSync(join(runtimeDir, 'lark-obligations', f), JSON.stringify(kept, null, 2))
    }
  }
  const followPath = join(archiveRuntime, 'lark-followup-docs', 'falive.json')
  if (existsSync(followPath)) {
    mkdirSync(join(runtimeDir, 'lark-followup-docs'), { recursive: true })
    writeFileSync(join(runtimeDir, 'lark-followup-docs', 'falive.json'), JSON.stringify(Object.fromEntries(Object.entries(readJson(followPath, {})).filter(([, d]) => String(d.updatedAt || '') < beforeIso)), null, 2))
  }
  writeFileSync(seedMark, beforeIso)
  log('运行态按窗口起点还原：发件簿 / 台账（ledgerAsOf）/ 回复义务 / 待确认清单文档')
}

if (flag('--dry')) {
  log('dry：目录、业务仓、配置、运行态已就绪，不起进程')
  process.exit(0)
}

// —— 发件：webhook 收件 → outbox.jsonl / sent.json（与假 CLI 同一把锁、同一个序号） ——
const names = new Map()
for (const m of timeline) {
  if (m.senderId && m.senderName) names.set(m.senderId, m.senderName)
  for (const x of m.mentions || []) if (x.id && x.name) names.set(x.id, x.name)
}
const withLock = (fn) => {
  const lock = join(simDir, 'sent.lock')
  for (let i = 0; i < 400; i += 1) {
    let fd = null
    try { fd = openSync(lock, 'wx') } catch (error) {
      if (error.code !== 'EEXIST') throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
      continue
    }
    try { return fn() } finally { closeSync(fd); unlinkSync(lock) }
  }
  throw new Error('sent.lock 一直拿不到')
}
const clockPath = join(simDir, 'clock.json')
const clockNow = () => { const c = readJson(clockPath, null); return c ? c.virtualMs + (Date.now() - c.realMs) : fromMs }
// 卡片 → 文本：bot 看到的（cli）同真 lark-cli 渲染「@名字(ou_xxx)」，人看到的（display）只有「@名字」
const renderWebhookBody = (body) => {
  if (body?.msg_type === 'text') return { title: null, cli: String(body.content?.text || ''), display: String(body.content?.text || '') }
  const card = body?.card || {}
  const parts = []
  for (const el of card.elements || []) {
    if (el.tag === 'markdown') parts.push(String(el.content || ''))
    else if (el.tag === 'div') parts.push(String(el.text?.content || ''))
    else if (el.tag === 'note') parts.push(`📝 ${(el.elements || []).map((x) => x.content || x.text || '').join('')}`)
    else if (el.tag === 'hr') parts.push('---')
  }
  const raw = parts.join('\n')
  const at = (withId) => raw.replace(/<at (?:id|user_id)=["']?(ou_\w+|all)["']?><\/at>/g, (_, id) => (id === 'all' ? '@所有人' : `@${names.get(id) || id}${withId ? `(${id})` : ''}`))
  const title = card.header?.title?.content || null
  const wrap = (text) => `<card${title ? ` title="${title}"` : ''}>\n${text}\n</card>`
  return { title, cli: wrap(at(true)), display: wrap(at(false)) }
}
const recordWebhook = (chatId, body) => withLock(() => {
  const sent = readJson(join(simDir, 'sent.json'), [])
  const seq = readJson(join(simDir, 'seq.json'), { n: 0 })
  seq.n += 1
  writeFileSync(join(simDir, 'seq.json'), JSON.stringify(seq))
  const id = `om_sim${String(seq.n).padStart(5, '0')}`
  const at = clockNow()
  const text = renderWebhookBody(body)
  const msgType = body?.msg_type === 'text' ? 'text' : 'interactive'
  sent.push({ message_id: id, chat_id: chatId, msg_type: msgType, content: text.cli, create_time: String(at), deleted: false, sender: { id: BOT_APP_ID, id_type: 'app_id', sender_type: 'app', name: 'Aven.Bot', open_bot_id: CUSTOM_BOT_IDS[GROUPS.find((g) => g.chatId === chatId)?.key] || BOT_APP_ID }, mentions: [] })
  writeFileSync(join(simDir, 'sent.json'), JSON.stringify(sent))
  appendFileSync(join(simDir, 'outbox.jsonl'), `${JSON.stringify({ id, kind: 'webhook', at, atIso: new Date(at).toISOString(), chatId, userId: null, parentId: null, inThread: false, msgType, text: text.display, card: body?.card || null })}\n`)
  return id
})
const readBody = (req) => new Promise((resolve) => { const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => resolve(Buffer.concat(chunks))) })
const hookServer = createServer(async (req, res) => {
  const chatId = /^\/hook\/(oc_\w+)$/.exec(req.url || '')?.[1]
  const raw = await readBody(req)
  let body = null
  try { body = JSON.parse(raw.toString('utf8')) } catch { /* 下面按坏请求回 */ }
  if (req.method !== 'POST' || !chatId || !body) {
    res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 19001, msg: 'sim: bad webhook request' }))
    return
  }
  const id = recordWebhook(chatId, body)
  log(`webhook → ${GROUPS.find((g) => g.chatId === chatId)?.key || chatId}：${id}`)
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 0, msg: 'success', data: {} }))
})
await new Promise((resolve) => hookServer.listen(hookPort, '127.0.0.1', resolve))

// —— 实测转发：pre-client 的 PROBE_HOST 指到这里；注册 / 发验证码拦下，其余原样转给 pre（probe-proxy.mjs）——
const probeServer = await startProbeProxy({ port: probePort, logPath: join(simDir, 'probe.log') })

// —— 进程 ——
const env = { ...process.env }
delete env.LARK_LOG_FILE // 不是 launchd 托管：排空重启 / 日志轮转都不开
Object.assign(env, {
  SIM_DIR: simDir,
  LARK_RUNTIME_DIR: runtimeDir,
  LARK_INSTANCE_MODE: 'repo-only',
  LARK_CLI_BIN: join(here, 'lark-cli'),
  LARK_GATEWAY_PORT: String(port),
  LARK_GATEWAY_URL: `http://127.0.0.1:${port}`,
  LARK_GATEWAY_SECRET: 'sim-secret',
  LARK_BOT_CONSUMER_ROOT: repoLink,
  LARK_DRAIN_RESTART: '0',
  LARK_REAPER: '0',
  LARK_SELF_FIX: '0',
  LARK_KEEP_AWAKE: '0',
  LARK_CHAT_NAME_TTL_MS: '600000',
  LARK_CLAUDE_BIN: join(here, 'claude-q'),
  LARK_CLAUDE_IDLE_TIMEOUT_MS: String(8 * 3600_000),
  LARK_INTENT_CLASSIFIER_TIMEOUT_MS: String(8 * 3600_000),
  LARK_WORKER_AI_TIMEOUT_MS: String(8 * 3600_000),
  LARK_TASK_LEASE_MS: String(9 * 3600_000),
  SIM_ORIG_IDLE_MS: '600000',
  SIM_ORIG_INTENT_MS: '120000',
  SIM_ORIG_TOTAL_MS: String(repoCfg.aiTimeoutMs || 1800000),
  PROBE_HOST: `http://127.0.0.1:${probePort}`,
  // 出网拦截（11-04 校准 ep-1024 事故：falive 的 claude 会话在 Bash 里直接敲 lark-cli，走的是 PATH 里的真 lark-cli，用 aven 身份读了真实 bug 表）：
  // 同 run-sim，curl / wget / lark-cli 壳放 PATH 最前（lark-cli 壳只转假 CLI），node 子进程预载 egress-hook 记 fetch。
  // 第二道保险（11-04）：真 lark-cli 的配置目录指到空目录——就算有进程绕过 PATH 壳调到真 lark-cli，user / bot 身份都是「not configured」，读写不了真飞书。
  LARKSUITE_CLI_CONFIG_DIR: join(simDir, 'no-lark-credentials'),
  PATH: `${join(here, 'egress')}:${process.env.PATH || ''}`,
  NODE_OPTIONS: `${process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : ''}--import ${join(here, 'egress-hook.mjs')}`,
})
mkdirSync(join(simDir, 'no-lark-credentials'), { recursive: true })
let virtualNow = fromMs
const setClock = (virtualMs) => writeFileSync(clockPath, JSON.stringify({ virtualMs, realMs: Date.now() }))
setClock(virtualNow)
const { pausedUntil } = await import('./claude-quota.mjs')
let frozenAt = null
setInterval(() => {
  if (pausedUntil()) {
    if (frozenAt == null) { frozenAt = clockNow(); log(`额度暂停：虚拟时钟冻在 ${new Date(frozenAt).toISOString()}`) }
    setClock(frozenAt)
  } else if (frozenAt != null) { log('额度恢复：虚拟时钟接着走'); frozenAt = null }
}, 1000).unref()
const preload = join(here, 'virtual-clock.mjs')
const children = []
let shuttingDown = false
const spawnNode = (name, script, extra = []) => {
  const out = join(simDir, `${name}.log`)
  const child = spawn('node', ['--import', preload, script, ...extra], { cwd: repoLink, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (chunk) => appendFileSync(out, chunk))
  child.stderr.on('data', (chunk) => appendFileSync(out, chunk))
  child.on('exit', (code) => {
    log(`${name} 退出 code=${code}`)
    if (shuttingDown) return
    log(`${name} 中途退出，收尾不跑报告`) // 网关 / worker 崩了还接着推时钟就是白跑
    for (const other of children) if (other !== child) other.kill('SIGTERM')
    process.exit(1)
  })
  children.push(child)
  return child
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// 被停（SIGTERM / Ctrl-C）时把网关 / worker 一起停掉：worker 收 SIGTERM 会交还在飞任务并中断 AI 子进程（falive 的优雅退出）
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { shuttingDown = true; for (const child of children) child.kill('SIGTERM'); setTimeout(() => process.exit(130), 3000) })
const gateway = spawnNode('gateway', join(faliveCode, 'lark-gateway.mjs'), ['--config', join(runtimeDir, 'lark-bot.local.json'), '--port', String(port)])
const health = async () => { try { return (await fetch(`http://127.0.0.1:${port}/lark/health`)).ok } catch { return false } }
for (let i = 0; i < 60 && !(await health()); i += 1) await sleep(500)
if (!(await health())) throw new Error('falive 网关没起来，看 gateway.log')
const worker = spawnNode('worker', join(faliveCode, 'runtime', 'lark-worker.mjs'))
log(`falive 网关 :${port} 与 worker 已起；webhook 收件 :${hookPort}，实测转发 :${probePort}`)

// —— 出网审计 ——
const FLAG_HOSTS = ['open.larksuite.com', 'open.feishu.cn', 'qfglxo2m3dc.sg.larksuite.com', 'ojp3our9ofog.jp.larksuite.com', 'mgit.lgroup.co', 'smtp.larksuite.com', 'imap.larksuite.com', 'smtp.gmail.com']
const flagged = new Map()
for (const host of FLAG_HOSTS) {
  try { for (const a of await lookup(host, { all: true })) flagged.set(a.address, host) } catch { /* 解析不到就不比 */ }
}
const egressSeen = new Set()
const descendants = () => {
  const rows = spawnSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }).stdout.trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number))
  const out = new Set(children.map((c) => c.pid))
  for (let grew = true; grew;) { grew = false; for (const [pid, ppid] of rows) if (out.has(ppid) && !out.has(pid)) { out.add(pid); grew = true } }
  return [...out]
}
const egressTimer = setInterval(() => {
  const pids = descendants()
  const res = spawnSync('lsof', ['-nP', '-a', '-iTCP', '-sTCP:ESTABLISHED,SYN_SENT', '-p', pids.join(',')], { encoding: 'utf8' })
  for (const line of res.stdout.split('\n').slice(1).filter(Boolean)) {
    const cols = line.trim().split(/\s+/)
    const remote = /->(\S+)/.exec(line)?.[1]
    if (!remote) continue
    const ip = remote.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
    const key = `${cols[0]} ${remote}`
    if (egressSeen.has(key)) continue
    egressSeen.add(key)
    const entry = { at: new Date().toISOString(), command: cols[0], pid: Number(cols[1]), remote, local: ip === '127.0.0.1' || ip === '::1', flagged: flagged.get(ip) || null }
    appendFileSync(join(simDir, 'egress.jsonl'), `${JSON.stringify(entry)}\n`)
    if (entry.flagged) {
      log(`⚠ 出网命中 ${entry.flagged}：${key}——立即停跑（回放不许碰真飞书 / GitLab / 邮件）`)
      writeFileSync(join(simDir, 'EGRESS-STOP'), `${JSON.stringify(entry)}\n`)
      shuttingDown = true
      for (const child of children) child.kill('SIGTERM')
      try { process.kill(entry.pid, 'SIGKILL') } catch { /* 已退出 */ }
      process.exit(3)
    }
  }
}, 3000)
egressTimer.unref()

// —— 推时钟 ——
const ACTIVE = new Set(['received', 'queued', 'running', 'verifying', 'result_pending_receipt', 'done_pending_writeback'])
const listTasks = async () => {
  try { return (await (await fetch(`http://127.0.0.1:${port}/lark/tasks`, { headers: { 'x-lark-gateway-secret': 'sim-secret' } })).json()).tasks || [] } catch { return null }
}
const isIdle = async () => { const tasks = await listTasks(); return Boolean(tasks) && !tasks.some((t) => ACTIVE.has(t.status) || t.ackPending) }
const pollerSeen = (chatId, id) => (readJson(join(runtimeDir, 'lark-chat-poller-state.json'), { chats: {} }).chats?.[chatId]?.seen || []).includes(id)
const advanceTo = async (targetMs, label) => {
  let started = Date.now()
  await sleep(1500)
  for (;;) {
    if (pausedUntil()) { await sleep(2000); started += 2000; continue }
    if (clockNow() >= targetMs) return
    if (await isIdle()) { setClock(targetMs); return }
    if (Date.now() - started > maxWaitMs) { log(`${label}：忙了 ${Math.round((Date.now() - started) / 60000)} 分钟还没到下一条的时刻，直接跳过去`); setClock(targetMs); return }
    await sleep(2000)
  }
}
const hidden = new Set(hiddenIds)
const pollSet = new Set(pollChats)
const steps = timeline.filter((m) => m.atMs >= fromMs && m.atMs <= lastMs && !m.ownBot && !m.deleted && m.senderType === 'user' && pollSet.has(m.chatId) && !hidden.has(m.id))
log(`推时钟：${steps.length} 条真人消息（其中组内 case ${steps.filter((m) => caseIds.has(m.id)).length} 条）`)
await sleep(25_000) // 轮询首轮在启动后 activeMs（20s）：先让它把游标定在窗口起点
for (const m of steps) {
  await advanceTo(m.atMs, m.id)
  virtualNow = Math.max(clockNow(), m.atMs)
  if (!caseIds.has(m.id)) continue
  log(`case ${m.id} ${new Date(m.atMs).toISOString().slice(5, 19)} ${m.chatKey} ${m.senderName}：${String(m.text).replace(/\s+/g, ' ').slice(0, 60)}`)
  const waitFrom = Date.now()
  while (!pollerSeen(m.chatId, m.id) && Date.now() - waitFrom < 120_000) await sleep(1000)
  log(pollerSeen(m.chatId, m.id) ? `  轮询已收（${Math.round((Date.now() - waitFrom) / 1000)}s）` : '  ⚠ 2 分钟内轮询没收到这条')
}
log('组内消息推完；等空闲后再让虚拟时间走一段（催办 / 义务巡检）')
const settleFrom = Date.now()
for (;;) {
  if (pausedUntil()) { await sleep(3000); continue }
  if (await isIdle()) break
  if (Date.now() - settleFrom > maxWaitMs) { log('final：等空闲超时，直接收尾'); break }
  await sleep(3000)
}
setClock(clockNow() + tailMs)
await sleep(30_000)
shuttingDown = true
for (const child of children) child.kill('SIGTERM')
await sleep(2000)
hookServer.close()
probeServer.close()
clearInterval(egressTimer)
const report = buildCalibration({ simDir, episode, faliveArchive: FALIVE_ARCHIVE })
writeFileSync(join(simDir, 'calibration.json'), JSON.stringify(report, null, 2))
writeFileSync(join(simDir, 'calibration.md'), renderCalibration(report))
log(`完成；校准报告 ${join(simDir, 'calibration.md')}`)
process.exit(0)
