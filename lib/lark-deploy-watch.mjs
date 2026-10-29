/**
 * 盯 pre 部署 → 部署后复测，并接上 bot 在群里说过的「部署后再测」（aven 2026-10-23，教训 #84）。
 *
 * 原来只盯「负责人回『推 pre』之后」那一次（state.lastPush），10-19 之后开发分支都走 GitLab MR 合进 pre、运维手动发，
 * bot 完全不知道部署了：10-23 对 Encone 说「部署完我再测一遍告诉你」，14:37 pre 部署后没有任何东西接上。
 * 现在的口径：
 *   1. 每 2 分钟探 pre 首页入口 JS 的 VITE_BUILD_TIME，只要比上次记录的新就算一次部署（日报推的、MR 合的、运维发的都算）；
 *      第一次（没有记录）只记基线，不建复测。入口文件名带内容哈希、每次构建都变：文件名没变就不再下载近 1MB 的入口 JS。
 *   2. 部署带进去的提交：包里有 VITE_BUILD_SHA（10-28 起构建时写入）就直接用它；没有就取这次构建时 pre 的 first-parent 头。
 *      起点是上次部署点，拿不到就退回「上次构建时间之后合进 origin/pre 的提交」。
 *   2b. 配了 sweep.onDeploy（bugpoll 的 deployed.py）就带上 --sha / --build-time 跑一次，输出私信负责人：bug 表「待推版」改「已推版」
 *      不再等负责人在群里说「已部署」（aven 2026-10-28）。
 *   3. 按提交建一条整体复测（只私信负责人，只测负责人的功能、别人的只记录）；
 *      再回看各仓库群的发件簿，把上次部署之后、这次构建之前 bot 说过的「部署后再测 / 告诉你」原话，
 *      每条建一个复测任务挂在原群、对着原来的人（chatId / operator 就是原话的群和对象，复用现有群回复出口与 #79 的「答应了下文必须回群」）。
 * 承诺不另外记账：发件簿就是账，窗口按两次构建时间切，每条原话只会落进一次部署。
 */
import { execAsync, gitAsync, buildSweepTask, loadSweepState, saveSweepState } from './lark-daily-sweep.mjs'
import { sendBotMarkdown } from './lark-cli.mjs'
import { localDateKey } from './lark-local-date.mjs'
import { listOutbox, localHHMM } from './lark-outbox.mjs'
import { runSeoCheck, seoChangeMessage, seoRetestNote } from './lark-seo-watch.mjs'
import { listRepoProfiles } from './lark-repo-profile.mjs'

// 回看发件簿的上限：太久之前说的话不再接（aven 2026-10-23：最近几天，如 3 天）。
export const PROMISE_LOOKBACK_MS = 3 * 24 * 3600_000

// pre 首页 → 入口 JS → { buildTime: VITE_BUILD_TIME（毫秒）, sha: VITE_BUILD_SHA | null }。连不上 / 读不到返回 null。
// 首页引用的脚本名和上次一样 = 同一个包，直接回上次读到的结果（cache 每个站点一份，进程内）。
const probeCache = new Map()
export const probePreBuild = async ({ siteUrl, fetchImpl = fetch, timeoutMs = 15_000, cache = probeCache }) => {
  try {
    const html = await (await fetchImpl(siteUrl, { signal: AbortSignal.timeout(timeoutMs) })).text()
    const scripts = [...new Set([...html.matchAll(/\/assets\/[\w.-]+\.js/g)].map((match) => match[0]))]
    const key = scripts.slice().sort().join(' ')
    const cached = cache.get(siteUrl)
    if (key && cached?.key === key) return cached.build
    for (const path of scripts) {
      const js = await (await fetchImpl(new URL(path, siteUrl), { signal: AbortSignal.timeout(timeoutMs) })).text()
      const hit = js.match(/VITE_BUILD_TIME["']?\s*:\s*["']?(\d{12,})/)
      if (!hit) continue
      const build = { buildTime: Number(hit[1]), sha: js.match(/VITE_BUILD_SHA["']?\s*:\s*["']([0-9a-f]{7,40})["']/)?.[1] || null }
      cache.set(siteUrl, { key, build })
      return build
    }
    return null
  } catch {
    return null
  }
}

/* ------------------------------ 等部署的原话 ------------------------------ */

// 「部署完 / 部署后 / 合进 pre 后 / 发布后 / pre 更新后」+ 后面跟着 bot 自己要做的「再测 / 再看 / 复测 / 告诉你 / 回你」。
// 「你再看看 / 你再点一次」是让对方做，不算 bot 的承诺；「复测了 / 再测过」是做完的汇报，也不算（10-23：「pre 部署后复测了：…」）；「还没复测 / 未复测」是状态汇报（10-20 日报式群消息），同样不算。
const DEPLOY_WAIT_RE = /(?:部署|发布|上线|更新)\s*(?:到\s*)?(?:pre\s*)?(?:完|好|后|之后|以后)|合(?:进|入|到)\s*pre\s*(?:后|之后|以后)/i
const FOLLOW_UP_RE = /(?<!你)(?:再|重新)(?:测|看|验|跑|确认)(?![了过])|(?<![没未])复测(?![了过])|告诉你|回你|通知你|同步给?你/
const stripAt = (text) => String(text || '').replace(/<at id=\w+><\/at>\s*/g, '').trim()

export const findPromiseSentence = (text) => {
  for (const sentence of stripAt(text).split(/[。！？!?\n]/)) {
    const hit = DEPLOY_WAIT_RE.exec(sentence)
    if (hit && FOLLOW_UP_RE.test(sentence.slice(hit.index + hit[0].length))) return sentence.trim()
  }
  return null
}

// 发件簿里 (sinceMs, untilMs] 之间真的发到群里的（gated = 没发出去）等部署原话；同一源任务只取最后一句。
export const findDeployPromises = ({ chatIds = [], sinceMs, untilMs, dir = null }) => {
  const byTask = new Map()
  for (const chatId of chatIds) {
    for (const entry of listOutbox({ chatId, sinceMs, dir })) {
      const at = Date.parse(entry.at || '')
      if (entry.gated || !(at > sinceMs && at <= untilMs)) continue
      const quote = findPromiseSentence(entry.text)
      if (quote) byTask.set(`${chatId}:${entry.taskId || at}`, { chatId, to: entry.to || null, taskId: entry.taskId || null, at: entry.at, quote })
    }
  }
  return [...byTask.values()]
}

/* ------------------------------ 部署带进去的提交 ------------------------------ */

const iso = (ms) => new Date(ms).toISOString()
// 构建机与 GitLab 的时钟有偏差：10-23 那次 VITE_BUILD_TIME 是 10:37:04Z，触发它的 MR 合并提交记的是 10:37:05Z。
// 按构建时间往后放 5 分钟取 pre 头（构建总在合并之后才触发，5 分钟内再合一个 MR 的情况少，复测时会核对）。
export const BUILD_CLOCK_SLACK_MS = 5 * 60_000
const revAt = async (git, root, ms) => (await git(root, ['rev-list', '-1', '--first-parent', `--before=${iso(ms + BUILD_CLOCK_SLACK_MS)}`, 'origin/pre'])).stdout.trim() || null

// 这次构建时 pre 的头 = 包里写的 VITE_BUILD_SHA（本地 fetch 得到才用）；没有就取构建时间之前 origin/pre 的最后一个 first-parent 提交。
// 起点 = 上次部署点，拿不到退回上次构建时间。
export const deployedCommits = async ({ root, prevHead = null, prevBuildTime = null, buildTime, sha = null, git = gitAsync }) => {
  const fetched = await git(root, ['fetch', 'origin', 'pre'])
  const head = (sha && (await git(root, ['cat-file', '-e', `${sha}^{commit}`])).ok ? sha : null) || await revAt(git, root, buildTime)
  if (!head) return { head: null, commits: [], from: null, fetched: fetched.ok }
  let from = null
  if (prevHead && (await git(root, ['merge-base', '--is-ancestor', prevHead, head])).ok) from = prevHead
  else if (prevBuildTime) from = await revAt(git, root, prevBuildTime)
  if (!from || from === head) return { head, commits: [], from, fetched: fetched.ok }
  const log = (await git(root, ['log', '--no-merges', '--format=%h %s', `${from}..${head}`])).stdout.trim()
  const commits = log ? log.split('\n') : []
  // 只改 docs/ 的提交（bot 回填对接文档 / 复测结论）不算要复测的改动：否则复测提交随下次部署进 pre，又为它建复测，一轮接一轮（aven 2026-10-27）。
  const touching = new Set((await git(root, ['log', '--no-merges', '--format=%h', `${from}..${head}`, '--', '.', ':(exclude)docs'])).stdout.split('\n').map((line) => line.trim().split(' ')[0]).filter(Boolean))
  return { head, commits, codeCommits: commits.filter((line) => touching.has(line.split(' ')[0])), from, fetched: fetched.ok }
}

/* ------------------------------ 复测任务 ------------------------------ */

const deployLabel = ({ head, buildTime }) => `${head ? `pre @ ${head.slice(0, 8)}，` : ''}构建于 ${localDateKey(new Date(buildTime)).slice(5)} ${localHHMM(buildTime)}`
const commitList = (commits) => (commits.length ? commits.slice(0, 30).map((line) => `- ${line}`).join('\n') : '- （没取到提交列表，按 pre 实际页面复测）')
const TOOLS = '工具与禁止事项同日报清扫：scripts/pre-probe.mjs、页面工具、验证码 123456、不给陌生号码发短信、不改 pre 共享数据'

export const buildRetestText = ({ me, deploy, commits, siteUrl, promiseCount = 0, seoNote = null }) => `pre 已部署（${deployLabel(deploy)}），在 pre 上复测这次部署带进去的改动。${me} 只看结果。
本次部署带进去的提交：
${commitList(commits)}

做法：按提交逐条找到对应功能，在已部署的 pre 站点 ${siteUrl} 做浏览器验证或接口实测（${TOOLS}）。只复测 ${me} 负责的功能，别人的只记录。
${seoNote ? `${seoNote}\n` : ''}复测通过的，在对应待对接文档 / 功能总表备注里把「待部署后回归」改成复测结论；不通过的，判断前端还是后端：前端问题直接修（Worker 统一提交），后端问题写进待对接文档并带证据。
写文档只追加、不改原句（${me} 可能同时在改同一段，改原句合回必冲突，10-29 #94）：除「待部署后回归」这几个字外不改已有的行；结论和新问题写在该文档末尾的「## 复测追记」节（没有就建，每次一小节「MM-DD pre 复测 <提交号>」），功能总表在变更记录表头插一行；docs/delivery/pending/README.md 的索引行不动。
${promiseCount ? `群里答应过别人「部署后再测」的 ${promiseCount} 句已各建复测任务、结论回原群，这里不用重复回群。\n` : ''}summary 格式：第一行「pre 复测 ${(deploy.head || '').slice(0, 8) || deployLabel(deploy)}：通过 X 项，不通过 Y 项。」，之后每个不通过一行「- 功能：原因（前端已修 / 等谁 · 证据）」。`

const nameOf = (profile, openId) => Object.entries(profile.ownerMap || {}).find(([, id]) => id === openId)?.[0] || '对方'
const chatName = (profile, chatId) => profile.chatLabels?.[chatId] || profile.chatNameById?.[chatId] || chatId

export const buildPromiseRetestText = ({ profile, me, deploy, commits, siteUrl, promise }) => {
  const who = nameOf(profile, promise.to)
  return `pre 已部署（${deployLabel(deploy)}）。部署前 bot 在「${chatName(profile, promise.chatId)}」对 ${who} 说过要等部署后再测、再告诉他，现在兑现。
原话（${localDateKey(new Date(promise.at)).slice(5)} ${localHHMM(promise.at)}，源任务 ${promise.taskId || '（未记）'}）：「${promise.quote}」
本次部署带进去的提交：
${commitList(commits)}

做法：只复测原话里答应的内容（需要上下文就看源任务），在 pre 站点 ${siteUrl} 实测（${TOOLS}）。先确认相关修复在不在这次部署的提交里：不在就如实说还没上 pre，不要说测通了。这条只测不改代码：前端还有问题写进 summary 交 ${me}，后端问题写清证据。
结论发回原群对着 ${who}：report / groupReply 写给他看的人话（先接住原话，再说现在测的结果、他那边要不要做什么），不写分支名、提交号、文件路径。
summary 第一行「部署后复测（答应 ${who} 的）：通过 / 没通过」，没通过的下一行写原因和证据。`
}

// 部署后复测的交付是实测结论（任务契约，10-21 P2）：不要求改代码、没 diff 也是完成。
const VERIFY_CONTRACT = { v: 1, deliverable: 'verification', source: 'deploy-watch', readOnly: false, expectsCode: false, emptyDiffOk: true, docsOnlyOk: true, browser: true, api: false, defect: false }
// sweep.onDeploy：部署后跑一次的本机命令（bugpoll 的 deployed.py），追加 --sha / --build-time；有输出就私信负责人，失败也私信。
export const runOnDeploy = async ({ profile, deploy, exec = execAsync, send = sendBotMarkdown }) => {
  const [file, ...args] = profile.dailyReport?.sweep?.onDeploy || []
  if (!file || !deploy.head) return null
  const out = await exec(file, [...args, '--sha', deploy.head, '--build-time', String(deploy.buildTime)], { timeout: 10 * 60_000 })
  const rerun = [file, ...args, '--sha', deploy.head].join(' ')
  const markdown = out.ok ? out.stdout.trim() : `部署后改 bug 表没跑成（${deployLabel(deploy)}）：${(out.stderr || out.stdout).trim().slice(0, 300)}\n这次部署不会再自动跑，修好后手动补：${rerun}`
  if (markdown && profile.notifyChatId) await send({ chatId: profile.notifyChatId, markdown, logPrefix: `deploy onDeploy ${profile.key}` })
  return { ok: out.ok, markdown }
}

const stamp = (ms) => `${localDateKey(new Date(ms)).replace(/-/g, '')}-${localHHMM(ms).replace(':', '')}`

/**
 * 探一次 pre：构建时间比记录的新 = 一次部署 → 建整体复测 + 每句等部署原话一个复测（任务 id 幂等）。
 * 没记录过 = 第一次启动，只记基线。返回 { checked, baseline?, deployed?, taskId?, promiseTaskIds? }。
 */
export const checkDeployAndRetest = async ({ store, profile, now = new Date(), deps = {} }) => {
  const siteUrl = profile.dailyReport?.sweep?.preSiteUrl
  if (!siteUrl) return { checked: false }
  const { buildTime, sha = null } = (await (deps.probePreBuild || probePreBuild)({ siteUrl })) || {}
  if (!buildTime) return { checked: true, deployed: false }
  const { lastPush: _retired, ...state } = loadSweepState(profile.key, deps) // lastPush 是旧的「推 pre 后才盯」记录，已由本机制取代
  const last = state.lastDeploy
  if (last && buildTime <= last.buildTime) return { checked: true, deployed: false }
  const { head, commits, codeCommits = commits } = await deployedCommits({ root: profile.root, prevHead: last?.head, prevBuildTime: last?.buildTime, buildTime, sha, git: deps.git })
  const deploy = { buildTime, head }
  const record = (extra, top = {}) => saveSweepState(profile.key, { ...state, ...top, lastDeploy: { buildTime, head, detectedAt: now.toISOString(), ...extra } }, deps)
  if (!last) {
    record({ baseline: true })
    console.log(`[lark-gateway] 盯部署：${profile.key} 首次记录基线（${deployLabel(deploy)}），不建复测`)
    return { checked: true, baseline: true }
  }
  const me = profile.ownership?.me || '负责人'
  const base = `retest-${profile.key}-${stamp(buildTime)}`
  const make = ({ id, text, count, extra }) => {
    if (!store.get(id)) store.upsert({ ...buildSweepTask({ profile, date: localDateKey(now), text, count, now }), id, ...extra })
    return id
  }
  const promises = findDeployPromises({ chatIds: profile.chatIds || [], sinceMs: Math.max(last.buildTime, now - PROMISE_LOOKBACK_MS), untilMs: buildTime, dir: deps.outboxDir })
  const promiseTaskIds = promises.map((promise) => make({
    id: `${base}-${String(promise.taskId || promise.at).slice(-6)}`,
    text: buildPromiseRetestText({ profile, me, deploy, commits, siteUrl, promise }),
    count: 1,
    extra: {
      chatId: promise.chatId, operator: promise.to, ackedInGroup: true, ackReply: promise.quote, contract: VERIFY_CONTRACT,
      promiseOf: { taskId: promise.taskId, chatId: promise.chatId, to: promise.to, at: promise.at },
      summary: `部署后复测：答应 ${nameOf(profile, promise.to)} 的「${promise.quote.slice(0, 30)}」`, topic: `retest#${promise.taskId || base}`,
    },
  }))
  // SEO 爬虫检查 bot 先跑、和上次比（lib/lark-seo-watch.mjs）：已知卡点不变就不让复测再报；跑挂了不更新基准
  const seo = await (deps.runSeoCheck || runSeoCheck)({ profile, siteUrl })
  const prevSeo = state.lastSeo?.fails || []
  const seoNote = seoRetestNote({ seo, prev: prevSeo, siteUrl })
  const taskId = codeCommits.length ? make({ id: base, text: buildRetestText({ me, deploy, commits: codeCommits, siteUrl, promiseCount: promises.length, seoNote }), count: codeCommits.length, extra: { summary: `pre 部署后复测（${deployLabel(deploy)}）`, topic: `retest#${stamp(buildTime)}` } }) : null
  record({ retestTaskIds: [taskId, ...promiseTaskIds].filter(Boolean) }, seo?.fails ? { lastSeo: { fails: seo.fails, buildTime } } : {})
  const seoMessage = taskId ? null : seoChangeMessage({ seo, prev: prevSeo, label: deployLabel(deploy) })
  if (seoMessage && profile.notifyChatId) await (deps.send || sendBotMarkdown)({ chatId: profile.notifyChatId, markdown: seoMessage, logPrefix: `deploy seo ${profile.key}` })
  console.log(`[lark-gateway] pre 已部署（${deployLabel(deploy)}，${commits.length} 个提交，${codeCommits.length} 个改了代码），复测任务：${[taskId, ...promiseTaskIds].filter(Boolean).join('、') || '无'}`)
  const onDeploy = await (deps.runOnDeploy || runOnDeploy)({ profile, deploy })
  return { checked: true, deployed: true, taskId, promiseTaskIds, onDeploy }
}

// 回负责人那句「已部署」：说明已自动探测，附上最近一次探到的部署。
export const deployNoticeReply = (profile, deps = {}) => {
  const last = loadSweepState(profile.key, deps).lastDeploy
  return `部署现在自动探测（每 2 分钟），不用再说「已部署」，刚又探了一次。${last ? `最近一次探到的部署：${deployLabel(last)}，bug 表的「待推版」按它自动改。` : '还没探到过部署。'}`
}

const watchProfiles = () => listRepoProfiles().filter((profile) => !profile.isDefault && profile.dailyReport?.sweep?.preSiteUrl)

// 负责人还在群里说「已部署」时立刻探一次（lark-ingest 调）；没在盯就什么都不做。
let kick = null
export const checkDeployNow = () => kick?.()

export const startDeployWatch = ({ store, intervalMs = 2 * 60_000, deps = {} }) => {
  const targets = watchProfiles()
  if (!targets.length) return { targets: [], stop: () => {} }
  let running = null
  // 上一轮（含 onDeploy 改表）没跑完不叠第二轮
  const tick = () => (running ||= (async () => {
    for (const profile of targets) {
      try {
        await checkDeployAndRetest({ store, profile, deps })
      } catch (error) {
        console.error(`[lark-gateway] 部署检查异常：${profile.key} ${String(error?.message || error).slice(0, 160)}`)
      }
    }
  })().finally(() => { running = null }))
  kick = tick
  const timer = (deps.setInterval || setInterval)(() => { tick().catch(() => {}) }, intervalMs)
  timer.unref?.()
  // 启动即探一次：首次记基线、重启期间的部署不用等下一轮
  tick().catch(() => {})
  return { targets: targets.map((profile) => profile.key), tick, stop: () => { clearInterval(timer); kick = null } }
}
