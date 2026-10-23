/**
 * 盯 pre 部署 → 部署后复测，并接上 bot 在群里说过的「部署后再测」（aven 2026-10-23，教训 #82）。
 *
 * 原来只盯「负责人回『推 pre』之后」那一次（state.lastPush），10-19 之后开发分支都走 GitLab MR 合进 pre、运维手动发，
 * bot 完全不知道部署了：10-23 对 Encone 说「部署完我再测一遍告诉你」，14:37 pre 部署后没有任何东西接上。
 * 现在的口径：
 *   1. 定时探 pre 首页入口 JS 的 VITE_BUILD_TIME，只要比上次记录的新就算一次部署（日报推的、MR 合的、运维发的都算）；
 *      第一次（没有记录）只记基线，不建复测。
 *   2. 部署带进去的提交：origin/pre（先 fetch）上次部署点 → 这次构建时 pre 的 first-parent 头；
 *      上次部署点拿不到就退回「上次构建时间之后合进 origin/pre 的提交」。
 *   3. 按提交建一条整体复测（只私信负责人，只测负责人的功能、别人的只记录）；
 *      再回看各仓库群的发件簿，把上次部署之后、这次构建之前 bot 说过的「部署后再测 / 告诉你」原话，
 *      每条建一个复测任务挂在原群、对着原来的人（chatId / operator 就是原话的群和对象，复用现有群回复出口与 #79 的「答应了下文必须回群」）。
 * 承诺不另外记账：发件簿就是账，窗口按两次构建时间切，每条原话只会落进一次部署。
 */
import { gitAsync, buildSweepTask, loadSweepState, saveSweepState } from './lark-daily-sweep.mjs'
import { localDateKey } from './lark-local-date.mjs'
import { listOutbox, localHHMM } from './lark-outbox.mjs'
import { listRepoProfiles } from './lark-repo-profile.mjs'

// 回看发件簿的上限：太久之前说的话不再接（aven 2026-10-23：最近几天，如 3 天）。
export const PROMISE_LOOKBACK_MS = 3 * 24 * 3600_000

// pre 首页 → 入口 JS → VITE_BUILD_TIME（毫秒）。连不上返回 null。
export const probePreBuildTime = async ({ siteUrl, fetchImpl = fetch, timeoutMs = 15_000 }) => {
  try {
    const html = await (await fetchImpl(siteUrl, { signal: AbortSignal.timeout(timeoutMs) })).text()
    const scripts = [...new Set([...html.matchAll(/\/assets\/[\w.-]+\.js/g)].map((match) => match[0]))]
    for (const path of scripts) {
      const js = await (await fetchImpl(new URL(path, siteUrl), { signal: AbortSignal.timeout(timeoutMs) })).text()
      const hit = js.match(/VITE_BUILD_TIME["']?\s*:\s*["']?(\d{12,})/)
      if (hit) return Number(hit[1])
    }
    return null
  } catch {
    return null
  }
}

/* ------------------------------ 等部署的原话 ------------------------------ */

// 「部署完 / 部署后 / 合进 pre 后 / 发布后 / pre 更新后」+ 后面跟着 bot 自己要做的「再测 / 再看 / 复测 / 告诉你 / 回你」。
// 「你再看看 / 你再点一次」是让对方做，不算 bot 的承诺。
const DEPLOY_WAIT_RE = /(?:部署|发布|上线|更新)\s*(?:到\s*)?(?:pre\s*)?(?:完|好|后|之后|以后)|合(?:进|入|到)\s*pre\s*(?:后|之后|以后)/i
const FOLLOW_UP_RE = /(?<!你)(?:再|重新)(?:测|看|验|跑|确认)|复测|告诉你|回你|通知你|同步给?你/
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

// 这次构建时 pre 的头 = 构建时间之前 origin/pre 的最后一个 first-parent 提交；起点 = 上次部署点，拿不到退回上次构建时间。
export const deployedCommits = async ({ root, prevHead = null, prevBuildTime = null, buildTime, git = gitAsync }) => {
  const fetched = await git(root, ['fetch', 'origin', 'pre'])
  const head = await revAt(git, root, buildTime)
  if (!head) return { head: null, commits: [], from: null, fetched: fetched.ok }
  let from = null
  if (prevHead && (await git(root, ['merge-base', '--is-ancestor', prevHead, head])).ok) from = prevHead
  else if (prevBuildTime) from = await revAt(git, root, prevBuildTime)
  if (!from || from === head) return { head, commits: [], from, fetched: fetched.ok }
  const log = (await git(root, ['log', '--no-merges', '--format=%h %s', `${from}..${head}`])).stdout.trim()
  return { head, commits: log ? log.split('\n') : [], from, fetched: fetched.ok }
}

/* ------------------------------ 复测任务 ------------------------------ */

const deployLabel = ({ head, buildTime }) => `${head ? `pre @ ${head.slice(0, 8)}，` : ''}构建于 ${localDateKey(new Date(buildTime)).slice(5)} ${localHHMM(buildTime)}`
const commitList = (commits) => (commits.length ? commits.slice(0, 30).map((line) => `- ${line}`).join('\n') : '- （没取到提交列表，按 pre 实际页面复测）')
const TOOLS = '工具与禁止事项同日报清扫：scripts/pre-probe.mjs、页面工具、验证码 123456、不给陌生号码发短信、不改 pre 共享数据'

export const buildRetestText = ({ me, deploy, commits, siteUrl, promiseCount = 0 }) => `pre 已部署（${deployLabel(deploy)}），在 pre 上复测这次部署带进去的改动。${me} 只看结果。
本次部署带进去的提交：
${commitList(commits)}

做法：按提交逐条找到对应功能，在已部署的 pre 站点 ${siteUrl} 做浏览器验证或接口实测（${TOOLS}）。只复测 ${me} 负责的功能，别人的只记录。
复测通过的，在对应待对接文档 / 功能总表备注里把「待部署后回归」改成复测结论；不通过的，判断前端还是后端：前端问题直接修（Worker 统一提交），后端问题写进待对接文档并带证据。
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
const stamp = (ms) => `${localDateKey(new Date(ms)).replace(/-/g, '')}-${localHHMM(ms).replace(':', '')}`

/**
 * 探一次 pre：构建时间比记录的新 = 一次部署 → 建整体复测 + 每句等部署原话一个复测（任务 id 幂等）。
 * 没记录过 = 第一次启动，只记基线。返回 { checked, baseline?, deployed?, taskId?, promiseTaskIds? }。
 */
export const checkDeployAndRetest = async ({ store, profile, now = new Date(), deps = {} }) => {
  const siteUrl = profile.dailyReport?.sweep?.preSiteUrl
  if (!siteUrl) return { checked: false }
  const buildTime = await (deps.probePreBuildTime || probePreBuildTime)({ siteUrl })
  if (!buildTime) return { checked: true, deployed: false }
  const { lastPush: _retired, ...state } = loadSweepState(profile.key, deps) // lastPush 是旧的「推 pre 后才盯」记录，已由本机制取代
  const last = state.lastDeploy
  if (last && buildTime <= last.buildTime) return { checked: true, deployed: false }
  const { head, commits } = await deployedCommits({ root: profile.root, prevHead: last?.head, prevBuildTime: last?.buildTime, buildTime, git: deps.git })
  const deploy = { buildTime, head }
  const record = (extra) => saveSweepState(profile.key, { ...state, lastDeploy: { buildTime, head, detectedAt: now.toISOString(), ...extra } }, deps)
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
  const taskId = commits.length ? make({ id: base, text: buildRetestText({ me, deploy, commits, siteUrl, promiseCount: promises.length }), count: commits.length, extra: { summary: `pre 部署后复测（${deployLabel(deploy)}）`, topic: `retest#${stamp(buildTime)}` } }) : null
  record({ retestTaskIds: [taskId, ...promiseTaskIds].filter(Boolean) })
  console.log(`[lark-gateway] pre 已部署（${deployLabel(deploy)}，${commits.length} 个提交），复测任务：${[taskId, ...promiseTaskIds].filter(Boolean).join('、') || '无'}`)
  return { checked: true, deployed: true, taskId, promiseTaskIds }
}

const watchProfiles = () => listRepoProfiles().filter((profile) => !profile.isDefault && profile.dailyReport?.sweep?.preSiteUrl)

export const startDeployWatch = ({ store, intervalMs = 10 * 60_000, deps = {} }) => {
  const targets = watchProfiles()
  if (!targets.length) return { targets: [], stop: () => {} }
  const tick = async () => {
    for (const profile of targets) {
      try {
        await checkDeployAndRetest({ store, profile, deps })
      } catch (error) {
        console.error(`[lark-gateway] 部署检查异常：${profile.key} ${String(error?.message || error).slice(0, 160)}`)
      }
    }
  }
  const timer = (deps.setInterval || setInterval)(() => { tick().catch(() => {}) }, intervalMs)
  timer.unref?.()
  // 启动即探一次：首次记基线、重启期间的部署不用等 10 分钟
  tick().catch(() => {})
  return { targets: targets.map((profile) => profile.key), tick, stop: () => clearInterval(timer) }
}
