/**
 * 部署等待（aven 11-06「部署 dev / test」后半段）：worker 合完 MR 登记一条，网关每分钟看一眼「建置通知」群，
 * 这次合并要部署的每个 Label（exchange-<Label>）都出了卡就收口：
 *   · 全部部署成功 → 私信一句，开一条复测任务（实测契约，私信回结果）；
 *   · 有失败卡 → 私信失败的流水线和构建地址，不复测；
 *   · 超过 deadline 还没等齐 → 私信在等哪张卡。
 * 登记一条一个文件（runtime/lark-deploy-watch/<id>.json）：worker 写、网关改，两边不抢同一个文件。只在有等待时才读群
 *（用负责人身份读，lib/lark-user-auth-guard 护着）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { matchDeployNotices, parseBuildNotice, projectForLabel } from './lark-build-notice.mjs'
import { replyMarkdown, runLarkCli } from './lark-cli.mjs'
import { larkDeployWatchDir } from './lark-paths.mjs'
import { deriveContract } from './lark-task-contract.mjs'

// 「建置通知」群（外部群，bot 不在里面，用负责人身份读）。config.deployWatch.noticeChatId 可改。
export const DEFAULT_NOTICE_CHAT_ID = 'oc_621cccdebf3f1daa99d3abf0a8a7ffb1'
export const DEPLOY_WAIT_MS = 40 * 60_000
const KEEP_FINISHED_MS = 7 * 24 * 60 * 60_000

// ── 登记存储 ──────────────────────────────────────────────

const fileOf = (dir, id) => join(dir, `${String(id).replace(/[^\w.-]+/g, '_')}.json`)

export const writeWatch = ({ dir, entry }) => {
  mkdirSync(dir, { recursive: true })
  const path = fileOf(dir, entry.id)
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(entry, null, 2)}\n`)
  renameSync(tmp, path)
  return entry
}

export const listWatches = ({ dir }) => {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((name) => name.endsWith('.json')).flatMap((name) => {
    try {
      return [JSON.parse(readFileSync(join(dir, name), 'utf8'))]
    } catch {
      return []
    }
  })
}

// ── 复测任务 ──────────────────────────────────────────────

const short = (sha) => String(sha || '').slice(0, 8)

/** 复测要做什么：原任务（回复的那张卡出自的 / 同分支最近做完的那单）的原话和结论；没有原任务就按分支的提交。 */
export const buildRetestText = ({ watch, sourceTask = null, site = null, cards = {} }) => {
  const built = Object.values(cards).map((card) => `${card.project}${card.url ? ` ${card.url}` : ''}`).join('；')
  return [
    `复测 ${watch.env} 环境：${watch.branch} 已合进 ${watch.env}（合并提交 ${short(watch.mergeSha)}，MR ${watch.mr?.url || '?'}），Jenkins 已部署（${built}）。`,
    `去 ${watch.env} 环境${site ? `（${site}）` : ''}实测这次改动是不是都生效了：先用 tools/env-version.mjs ${watch.env} 核对站点跑的版本包含 ${short(watch.mergeSha)}，再逐项打开页面核对（要登录就登录），每项给结论和截图；没生效 / 有问题的写清现象。`,
    sourceTask
      ? `这次改动对应的任务 ${sourceTask.id}（${sourceTask.project || '无项目号'}）。原话：\n<<<SOURCE\n${String(sourceTask.text || '').slice(0, 2000)}\nSOURCE${typeof sourceTask.result === 'string' && sourceTask.result.trim() ? `\n当时的结论：${sourceTask.result.trim().slice(0, 600)}` : ''}`
      : `没有对应的 bot 任务：按 \`git log origin/${watch.env}\` 里 ${watch.branch} 的提交（相对合并前的 ${watch.env}）改了哪些页面来测${watch.projectId ? `，需求是 ${watch.projectId}` : ''}。`,
  ].join('\n')
}

export const buildRetestTask = ({ watch, sourceTask = null, site = null, cards = {}, config, now = Date.now() }) => {
  const text = buildRetestText({ watch, sourceTask, site, cards })
  const base = {
    id: `retest-${watch.id}`,
    source: 'system',
    chatId: watch.chatId || config.notifyOpenId,
    chatType: 'p2p',
    messageId: watch.messageId || null,
    replyTarget: watch.messageId ? { messageId: watch.messageId, inThread: false } : null,
    threadRootId: watch.messageId || null,
    operator: config.notifyOpenId,
    project: sourceTask?.project || watch.projectId || null,
    projectTitle: sourceTask?.projectTitle || null,
    text,
    summary: `复测 ${watch.env}：${watch.branch}`,
    attachments: [],
    addressedToBot: true,
    fromPrincipal: true,
    status: 'queued',
    // 契约直接定成实测（不过分类器）：交付的是实测结论，不改代码。
    intake: { classification: { decision: 'question', deliverable: 'verification', forMe: true } },
    deployRetest: { watchId: watch.id, env: watch.env, branch: watch.branch, mergeSha: watch.mergeSha },
    createdAt: new Date(now).toISOString(),
  }
  return { ...base, contract: deriveContract(base) }
}

// ── 一轮 ──────────────────────────────────────────────────

/** 原任务：登记里点名的 > 同分支、最近完成的那单。 */
export const pickSourceTask = ({ watch, tasks = [], get = () => null }) => {
  const named = watch.sourceTaskId ? get(watch.sourceTaskId) : null
  if (named) return named
  return tasks
    .filter((task) => task.branch && (task.branch === watch.branch) && !task.deployRetest)
    .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)))[0] || null
}

const failedLine = (card) => `- ${card.project}：${card.stage === 'deploy' ? '部署' : '构建'}失败${card.url ? ` ${card.url}` : ''}`

/**
 * 跑一轮。deps：readNotices({ sinceIso }) → 卡片数组（已解析）、isAncestor(a, b)（可选；网关闭包不许同步子进程，现在不传——
 * 卡片「新增提交」会列出这次的合并提交）、send({ chatId, messageId, text })、
 * store（upsert / list / get）、config、dir、now()。返回本轮收口的 [{ id, outcome }]。
 */
export const runDeployWatchTick = async ({ deps }) => {
  const { dir, now, config } = deps
  const all = listWatches({ dir })
  // 收口超过 7 天的删掉
  for (const watch of all) {
    if (watch.status !== 'waiting' && now() - Date.parse(watch.finishedAt || watch.startedAt) > KEEP_FINISHED_MS) rmSync(fileOf(dir, watch.id), { force: true })
  }
  const waiting = all.filter((watch) => watch.status === 'waiting')
  if (!waiting.length) return []
  const since = Math.min(...waiting.map((watch) => Date.parse(watch.startedAt))) - 5 * 60_000
  let notices
  try {
    notices = await deps.readNotices({ sinceIso: new Date(since).toISOString() })
  } catch (error) {
    console.warn(`[lark-gateway] 部署等待：读建置通知失败（下轮再看）：${String(error?.message || error).slice(0, 200)}`)
    notices = null
  }
  const settled = []
  const finish = (watch, outcome, extra = {}) => {
    writeWatch({ dir, entry: { ...watch, ...extra, status: outcome, finishedAt: new Date(now()).toISOString() } })
    settled.push({ id: watch.id, outcome })
  }
  for (const watch of waiting) {
    const deadline = Date.parse(watch.startedAt) + (watch.waitMs || DEPLOY_WAIT_MS)
    const match = notices ? matchDeployNotices({ env: watch.env, mergeSha: watch.mergeSha, labels: watch.labels, notices, isAncestor: deps.isAncestor }) : { done: {}, pending: watch.labels }
    const failed = Object.values(match.done).filter((card) => !card.ok)
    if (failed.length) {
      await deps.send({ chatId: watch.chatId, messageId: watch.messageId, text: [`⛔ ${watch.branch} 合进 ${watch.env} 后 Jenkins 没过，没复测：`, ...failed.map(failedLine), `MR：${watch.mr?.url || '?'}`].join('\n') })
      finish(watch, 'failed', { cards: match.done })
      continue
    }
    if (!match.pending.length) {
      const sourceTask = pickSourceTask({ watch, tasks: deps.store.list(), get: (id) => deps.store.get(id) })
      const task = deps.store.upsert(buildRetestTask({ watch, sourceTask, site: config.envSites?.[watch.env] || null, cards: match.done, config, now: now() }))
      await deps.send({ chatId: watch.chatId, messageId: watch.messageId, text: `${watch.env} 部署好了（${Object.values(match.done).map((card) => card.project).join('、')}），开始复测，结果随后私信你。` })
      finish(watch, 'deployed', { cards: match.done, retestTaskId: task.id })
      continue
    }
    if (now() > deadline) {
      await deps.send({ chatId: watch.chatId, messageId: watch.messageId, text: `${watch.branch} 合进 ${watch.env} 已经 ${Math.round((watch.waitMs || DEPLOY_WAIT_MS) / 60_000)} 分钟，建置通知里还没等到 ${match.pending.map(projectForLabel).join('、')} 的部署卡，不等了、没复测。去 Jenkins 看一下流水线（MR ${watch.mr?.url || '?'}）。` })
      finish(watch, 'timeout', { cards: match.done })
    }
  }
  return settled
}

// ── 网关接线 ──────────────────────────────────────────────

/** 读「建置通知」：负责人身份，倒序翻到 sinceIso 之前为止（最多 maxPages 页）。 */
export const readBuildNotices = async ({ chatId, sinceIso, run, maxPages = 4 }) => {
  const notices = []
  let pageToken = ''
  for (let page = 0; page < maxPages; page += 1) {
    const args = ['im', '+chat-messages-list', '--chat-id', chatId, '--order', 'desc', '--page-size', '50', '--no-reactions', '--format', 'json', '--start', sinceIso, ...(pageToken ? ['--page-token', pageToken] : [])]
    const result = await run(args, { identity: 'user' })
    let data
    try {
      const parsed = JSON.parse(result.stdout || '')
      if (parsed.ok === false || result.code !== 0) throw new Error(JSON.stringify(parsed.error || {}).slice(0, 200))
      data = parsed.data || {}
    } catch (error) {
      throw new Error(`读建置通知失败：${String(error?.message || result.stderr || '').slice(0, 200)}`)
    }
    notices.push(...(data.messages || []).map(parseBuildNotice).filter(Boolean))
    if (!data.has_more || !data.page_token) break
    pageToken = data.page_token
  }
  return notices
}

/** 网关里每分钟一轮（没有等待就什么都不做）。deps 里缺的按网关默认补。 */
export const startDeployWatch = ({ deps, intervalMs = 60_000 }) => {
  let running = false
  const tick = async () => {
    if (running) return []
    running = true
    try {
      return await runDeployWatchTick({ deps })
    } catch (error) {
      console.warn(`[lark-gateway] 部署等待一轮出错：${String(error?.message || error).slice(0, 200)}`)
      return []
    } finally {
      running = false
    }
  }
  const timer = setInterval(tick, intervalMs)
  timer.unref?.()
  return { stop: () => clearInterval(timer), tick }
}

/** 网关用的真实依赖：负责人身份读建置通知、回在「部署 X」那条私信下面（回不了就直发）。 */
export const startGatewayDeployWatch = ({ config, store }) => startDeployWatch({
  deps: {
    dir: larkDeployWatchDir,
    config,
    store,
    now: Date.now,
    readNotices: ({ sinceIso }) => readBuildNotices({ chatId: config.deployWatch?.noticeChatId || DEFAULT_NOTICE_CHAT_ID, sinceIso, run: runLarkCli }),
    send: ({ chatId, messageId, text }) => replyMarkdown({ messageId, markdown: text, fallbackChatId: chatId || config.notifyOpenId, logPrefix: 'deploy-watch' }),
  },
})
