/**
 * 日报后清扫负责人待办（aven 2026-10-14）。
 *
 * 日报只「写」不「做」：第三节「需要再跟进的工作」里负责人名下的行没人去执行，天天挂着。
 * 本模块在日报发布成功后：
 *   1. 从完整版日报确定性抽出负责人的待办（第三节表格 + 第一节计数行），不交给模型挑；
 *   2. 建一条 source='daily-sweep' 的任务（不经分类、不发「开始」行），worker 单趟实施，结果只私信负责人；
 *   3. 负责人私信回「推 pre」→ 确定性代码推负责人的工作分支 baseRef，并用 push option 建 / 更新发往 pre 的 MR
 *      （aven 2026-10-27：合代码走 MR，不再直接推 pre；bot 的改动已由 worker 合进 baseRef，见 lib/lark-merge-back.mjs）；
 *   4. 部署后复测不再只盯这里推的那次：任何 pre 部署（MR 合入 / 运维手动发）都由 lib/lark-deploy-watch.mjs 认出并复测（#84）。
 * 推送只发生在第 3 步，且每次都由负责人当次回复触发（lark-bot AGENTS.md：未经当次明确授权不推送）。
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'

import { writeJsonAtomic } from './lark-fs.mjs'
import { join } from 'node:path'

import { larkRuntimeDir } from './lark-paths.mjs'
import { listRepoProfiles } from './lark-repo-profile.mjs'
import { loadMergeBackState } from './lark-merge-back-state.mjs'
import { pageToolOf } from './lark-verify-page.mjs'

export const SWEEP_SOURCE = 'daily-sweep'
export const isSweepTask = (task) => task?.source === SWEEP_SOURCE

const stripMarks = (text) => String(text || '').replace(/\*\*/g, '').replace(/<br\s*\/?>/gi, ' ').trim()
const splitRow = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((cell) => cell.trim())
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// 取「## <前缀>」开头的一节（到下一个 ## 为止）。
export const extractSection = (markdown, prefix) => {
  const lines = String(markdown || '').split('\n')
  const start = lines.findIndex((line) => line.startsWith(`## ${prefix}`))
  if (start < 0) return []
  const end = lines.findIndex((line, index) => index > start && /^##\s/.test(line))
  return lines.slice(start + 1, end < 0 ? lines.length : end)
}

// 节内所有 markdown 表的行（按负责人分组时一节可能有多张表，表头相同）→ [{ 列名: 值 }]。
export const parseTables = (lines) => {
  const out = []
  let header = null
  for (const raw of lines) {
    const line = raw.trim()
    if (!line.startsWith('|')) {
      header = null
      continue
    }
    if (/^\|\s*:?-{2,}/.test(line)) continue
    const cells = splitRow(line)
    if (!header) {
      header = cells.map(stripMarks)
      continue
    }
    out.push(Object.fromEntries(cells.map((cell, index) => [header[index] || `col${index}`, cell])))
  }
  return out
}

const mentionsOwner = (cell, names) => {
  const text = stripMarks(cell).toLowerCase()
  return names.some((name) => name && text.includes(name.toLowerCase()))
}

/**
 * 从完整版日报抽负责人的待办（纯函数）：
 * - followUps：第三节表格里负责人列含 me / 别名的行（含共同负责、「aven 跟进」）；
 * - unfinished：第一节计数列表里「- me n 项：#…」那一行（负责人自己的未完成功能）。
 */
export const extractOwnerTodos = ({ markdown, me, aliases = [] }) => {
  const names = [me, ...aliases].filter(Boolean)
  const followUps = parseTables(extractSection(markdown, '三、'))
    .filter((row) => mentionsOwner(row['负责人'], names))
    .map((row) => ({ title: stripMarks(row['事项']), detail: stripMarks(row['说明']), owners: stripMarks(row['负责人']) }))
    .filter((row) => row.title)
  const ownerLine = new RegExp(`^[-*]\\s*(?:\\*\\*)?(?:${names.map(escapeRe).join('|')})(?:\\*\\*)?\\s*\\d+\\s*项`, 'i')
  const unfinished = extractSection(markdown, '一、').map((line) => line.trim()).find((line) => ownerLine.test(line)) || null
  return { followUps, unfinished: unfinished ? stripMarks(unfinished.replace(/^[-*]\s*/, '')) : null }
}

// 当天完整版日报落盘位置（runDailyReport 写在 runtime/lark-daily-report/<repo>/…日报-<date>-完整版.md）。
export const findFullDailyReport = ({ profile, date, runtimeDir = larkRuntimeDir }) => {
  const dir = join(runtimeDir, 'lark-daily-report', profile.key)
  if (!existsSync(dir)) return null
  const name = readdirSync(dir).find((file) => file.endsWith(`日报-${date}-完整版.md`))
  return name ? join(dir, name) : null
}

export const sweepTaskId = (profile, date) => `sweep-${profile.key}-${String(date).replace(/-/g, '')}`

// 清扫任务正文：待办清单 + 收尾契约。契约里的做法来自 10-14 手工清扫的实际经验，改的时候同步 docs/falive-lessons.md。
export const buildSweepText = ({ date, me, todos, docUrl = null, verify = null }) => {
  const items = todos.followUps.map((item, index) => `${index + 1}. ${item.title}（负责人：${item.owners}）：${item.detail || '（无说明）'}`)
  if (todos.unfinished) items.push(`${items.length + 1}. ${me} 名下未完成功能（日报第一节计数）：${todos.unfinished}`)
  return `清扫 ${date} 日报里 ${me} 名下的待办，尽可能全部收尾。${me} 只看结果，不看过程。
${docUrl ? `日报云文档：${docUrl}\n` : ''}
待办（共 ${items.length} 条，日报原文）：
${items.join('\n')}

每条必须落到下面四种结果之一，并当场拿到证据：
A 已经完成：事实已变、只是日报没更新（例：pre 首页入口 JS 的 VITE_BUILD_TIME 晚于 \`git log --first-parent origin/pre\` 的合入时间 = 已部署）。只记证据，不重复做。
B 做掉：前端自己能完成的，直接做完——改代码、回填待对接文档（docs/delivery/pending/ 下对应编号的行、docs/apis/对接状态总览.md、功能总表备注列；功能总表状态列不改）、在 pre 上实测或浏览器验证。口径：**API 以后台实际响应为准**，后端没书面回复但 pre 实测结构已经明确的，按实测改，不再等确认；UI / UX 以产品为准。
C 需要 ${me} 本人动作：只有他能做的（发部署邮件给 OPS、对外拍板）。把能准备的都准备好，写清他只需要做哪一步。
D 依赖外部：三条全部满足才算——① 写清缺什么、找谁；② 有今天的实测证据证明现在确实拿不到（命令 / 请求 + 响应 code / msg）；③ 前端能先做的部分已经做完，且该依赖已登记在待对接文档里。拿不出证据的不许归 D，回去按 B 做。
共同负责的行只做 ${me} 那一半；别人的部分只记录，不改别人负责的代码（归属查 docs/lark-migration-source/requirements/phase1-feature-table.md「前端」列）。

本仓现成工具（直接用）：
- pre 接口：\`node scripts/pre-probe.mjs '[["/api/xxx",{参数}]]'\`（B2B 签名，带 PROBE_MAIL=任意新邮箱@probe.test 自动注册登录，验证码固定 123456）；token：\`PROBE_MAIL=… node scripts/pre-token-probe.mjs\`；用项目 zod schema 校验真实响应：\`SCHEMA_CHECK='[{"module":"@/modules/…/schema","export":"xxxSchema","path":"/api/…","pick":"0"}]' pnpm vitest run --config vitest.probe.config.ts\`。
- portal（账号）：\`https://falivepre.fdsser.com/go-api/api/auth/*\`，直接 curl。
- 页面验证：用页面工具，不要自己写 Playwright 脚本——还没部署的改动 \`${pageToolOf(verify)} start --cwd <当前工作区>\` 先起，改完 \`${pageToolOf(verify)} check --cwd <当前工作区> [--login] <页面路径>\`（连真实 pre 后端，自动和已部署的同一页比对，标「本地新出现」的要处理）；已部署的直接 \`${pageToolOf(verify)} check --base https://falivepre.fdsser.com [--login] <路径>\`。
- 已部署哪一版：取 pre 首页入口 JS 里的 VITE_BUILD_TIME（毫秒时间戳）。
禁止：给不认识的真实手机号发短信（测短信只用后端已知不支持的号段，或不测）；改 pre 共享数据（造帖、灌数据）；自己提交或推送（Worker 统一提交，推 pre 由 ${me} 回复触发）。

时间预算：整条任务约 60 分钟。先做最快能清掉的，浏览器复测放后面；做不完的如实写「没做完」和原因，不许写成已完成。

summary 写给 ${me} 本人（只看结果，按这个格式，不写过程）：
第一行：「${date} 日报 ${me} 待办 N 条：清掉 X 条，剩 Y 条。」
第二行：「清掉：事项 A、事项 B、…」（一行，不展开）
之后每条剩下的一行：「- 事项：原因」——D 写「等谁 · 缺什么 · 证据（时间 + 关键响应）」；C 写「你要做：…」；没做完写「没做完：原因」。`
}

export const buildSweepTask = ({ profile, date, text, count, now = new Date() }) => {
  const sweep = profile.dailyReport?.sweep || {}
  const me = profile.ownership?.me || '负责人'
  const timeoutMs = sweep.timeoutMs
  return {
    id: sweepTaskId(profile, date),
    source: SWEEP_SOURCE,
    repo: profile.key,
    project: profile.projectKey,
    chatId: profile.notifyChatId,
    operator: profile.ownership?.meOpenIds?.[0] || null,
    commandType: 'docs',
    commandTypeSource: 'explicit',
    summary: `清扫 ${date} 日报里 ${me} 的待办（${count} 条）`,
    text,
    attachments: [],
    topic: `sweep#${date}`,
    aiTimeoutMs: timeoutMs,
    // 租约要盖住单趟 AI + Worker 终检；默认租约（75 分钟）不够清扫用。
    leaseMs: timeoutMs + 30 * 60_000,
    aiEffort: sweep.effort,
    status: 'queued',
    createdAt: now.toISOString(),
  }
}

/**
 * 日报发布成功后调用：读完整版日报，有负责人待办就建清扫任务。幂等（同一天只建一次）。
 * outcome = runDailyReport 的返回（需要 outcome.doc.path）。返回 { ok, taskId?, skipped? }。
 */
export const enqueueDailySweep = ({ store, profile, outcome, readFile = (path) => readFileSync(path, 'utf8'), now = new Date() }) => {
  const sweep = profile?.dailyReport?.sweep
  if (!sweep) return { ok: false, skipped: 'profile 未开启 dailyReport.sweep' }
  if (!profile.notifyChatId) return { ok: false, skipped: 'profile 缺 notifyChatId（结果只私信负责人）' }
  const docPath = outcome?.doc?.path
  if (!docPath || !existsSync(docPath)) return { ok: false, skipped: '没有完整版日报' }
  const date = outcome.date
  const id = sweepTaskId(profile, date)
  if (store.get(id)) return { ok: true, taskId: id, skipped: '今天已建过' }
  const me = profile.ownership?.me || '负责人'
  const todos = extractOwnerTodos({ markdown: readFile(docPath), me, aliases: profile.ownership?.meAliases || [] })
  const count = todos.followUps.length + (todos.unfinished ? 1 : 0)
  if (!count) return { ok: true, skipped: `日报里没有 ${me} 的待办` }
  const text = buildSweepText({ date, me, todos, docUrl: outcome.doc.url || null, verify: profile.verify })
  const task = store.upsert(buildSweepTask({ profile, date, text, count, now }))
  console.log(`[lark-gateway] 日报清扫已建：${task.id}（${count} 条）`)
  return { ok: true, taskId: task.id, count }
}

// 清扫结果私信末尾：有改动 → 提示回「推 pre」（推的是负责人的工作分支，发 pre 的 MR）。
export const sweepPushHint = (task) => {
  if (!Array.isArray(task?.changedFiles) || !task.changedFiles.length) return null
  if (task.integration?.mergedBack === true) return `改动已合进 ${task.integration.branch}。回「推 pre」我就推 ${task.integration.branch} 并发 pre 的 MR。`
  if (task.branch) return `改动在分支 ${task.branch}，还没合进你的工作分支（合上了我会私信你）。合上后回「推 pre」我就推并发 pre 的 MR。`
  return null
}

/* ------------------------------ 推 pre ------------------------------ */

export const parsePushPreDirective = (text) => /^\s*推\s*pre\s*$/i.test(String(text || ''))

export const gitAsync = (cwd, args, { timeout = 120_000 } = {}) =>
  new Promise((resolve) => {
    execFile('git', ['-C', cwd, '-c', 'core.quotepath=off', ...args], { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout || ''), stderr: String(stderr || error?.message || '') })
    })
  })

/**
 * 推负责人的工作分支 baseRef，用 GitLab push option 建 / 更新发往 pre 的 MR（已有 MR 时 GitLab 只更新它）。
 * 不碰负责人的工作区；baseRef 相对 origin/pre 没有新提交就不推。返回 { ok, nothingNew?, commits?, mrUrl?, reason? }。
 */
export const pushBaseForMr = async ({ profile, git = gitAsync }) => {
  const { root, baseRef } = profile
  const fetched = await git(root, ['fetch', 'origin', 'pre'])
  if (!fetched.ok) return { ok: false, reason: `fetch origin pre 失败：${fetched.stderr.trim().slice(0, 160)}` }
  const log = (await git(root, ['log', '--no-merges', '--format=%h %s', `origin/pre..${baseRef}`])).stdout.trim()
  if (!log) return { ok: true, nothingNew: true }
  const pushed = await git(root, ['push', '-o', 'merge_request.create', '-o', 'merge_request.target=pre', 'origin', baseRef], { timeout: 300_000 })
  if (!pushed.ok) return { ok: false, reason: `推送 ${baseRef} 失败：${pushed.stderr.trim().slice(0, 200)}` }
  const mrUrl = `${pushed.stdout}\n${pushed.stderr}`.match(/https?:\/\/\S+\/merge_requests\/\d+/)?.[0] || null
  return { ok: true, commits: log.split('\n'), mrUrl }
}

const sweepStatePath = (key, dir) => join(dir || larkRuntimeDir, 'lark-daily-sweep', `${key}.json`)
export const loadSweepState = (key, { runtimeDir } = {}) => {
  try {
    return JSON.parse(readFileSync(sweepStatePath(key, runtimeDir), 'utf8'))
  } catch {
    return {}
  }
}
export const saveSweepState = (key, state, { runtimeDir } = {}) => {
  mkdirSync(join(runtimeDir || larkRuntimeDir, 'lark-daily-sweep'), { recursive: true })
  writeJsonAtomic(sweepStatePath(key, runtimeDir), state)
}

const sweepProfiles = () => listRepoProfiles().filter((profile) => !profile.isDefault && profile.dailyReport?.sweep)

// 私信「推 pre」：只认开启了清扫的仓；返回要回给负责人的 markdown。还排队等合进 baseRef 的 bot 改动这次带不上，一并说明。
export const handlePushPre = async ({ deps = {} } = {}) => {
  const profiles = sweepProfiles()
  if (profiles.length !== 1) return profiles.length ? `开了清扫的仓不止一个（${profiles.map((p) => p.key).join('、')}），暂不支持选择。` : '没有开启日报清扫的仓。'
  const profile = profiles[0]
  const pushed = await (deps.pushBaseForMr || pushBaseForMr)({ profile })
  const waiting = loadMergeBackState(profile.key, deps).pending
  const waitingNote = waiting.length ? `\n\n还有 ${waiting.length} 个 bot 改动没合进 ${profile.baseRef}，这次没带上：${waiting.slice(0, 5).map((item) => item.summary).join('；')}` : ''
  if (!pushed.ok) return `⛔ 没推：${pushed.reason}${waitingNote}`
  if (pushed.nothingNew) return `${profile.baseRef} 没有 pre 之外的提交，不用推。${waitingNote}`
  return `✅ 已推 ${profile.baseRef}（${pushed.commits.length} 个提交），发往 pre 的 MR：${pushed.mrUrl || '推送输出里没拿到链接，去 GitLab 看'}。MR 合并后要部署就发邮件给 OPS；部署好以后我会自动在 pre 上复测，结果私信你。${waitingNote}`
}
