/**
 * 日报（aven 2026-10-12 定）：每天 19:00 汇总「这个项目今天完成到哪、负责人是谁、没完成卡在哪、需要什么支持」。
 *
 * 口径：
 *   · 所有人的工作（含 aven）只看 `origin/pre` 当天的提交与代码（aven 2026-10-13 定：团队每天往 pre 合，本地 / 其它分支不算）；
 *     模型在 origin/pre 的 detached 检出（<worktreesDir>/daily-review）里只读评审；
 *   · 整体进度来自功能总表（phase1-feature-table.md）的状态列，并与上一次快照 diff 出「今日升级」；
 *   · 卡点 / 需要支持来自交付路线图（docs/delivery/README.md）「可交付分三档」表与 bot 当天的任务结果。
 * 事实由脚本确定性采集（git / 文件 / 任务库），再交给 Claude 只读整理成固定模板；模型不碰 git 写操作。
 * 试运行期只私发 aven（profile.dailyReport.to），看准了再发群。
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { buildCardContent } from './lark-cards.mjs'
import { sendBotMarkdown, sendChatMessage } from './lark-cli.mjs'
import { larkRuntimeDir } from './lark-paths.mjs'
import { listRepoProfiles, resolveWebhookCredentials } from './lark-repo-profile.mjs'
import { sendWebhookMessage } from './lark-webhook.mjs'
import { createLarkDocFromMarkdown } from './lark-docs.mjs'
import { COMPLETION_RULE } from './lark-completion-rule.mjs'
import { ledgerSummary, loadLedger, syncLedgerFromPending } from './lark-ledger.mjs'

const STATUS_LABELS = { '✅': '真实接口可用', '🟠': '部分实现 / 接了不通', '🟡': 'UI 完成仅 mock', '❌': '未实现' }

const pad = (n) => String(n).padStart(2, '0')
export const localDateKey = (date = new Date()) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
const startOfDayIso = (date = new Date()) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).toISOString()

// 功能总表：`| # | 一级模块 | 功能 | 来源 | 前端 | 服务端 | 状态 | 代码落点 | 备注 |`，只认首列为数字的行。
export const parseFeatureTable = (markdown) => {
  const rows = []
  for (const line of String(markdown || '').split('\n')) {
    const match = line.match(/^\|\s*(\d+)\s*\|(.*)\|\s*$/)
    if (!match) continue
    const cells = match[2].split('|').map((cell) => cell.trim())
    if (cells.length < 6) continue
    const [module, feature, , owner, server, status, location = '', note = ''] = cells
    rows.push({ no: Number(match[1]), module, feature, owner, server, status: status.match(/✅|🟠|🟡|❌/u)?.[0] || status, location, note })
  }
  return rows
}

export const summarizeFeatureTable = (rows) => {
  const byStatus = {}
  const byOwner = {}
  for (const row of rows) {
    byStatus[row.status] = (byStatus[row.status] || 0) + 1
    const owner = row.owner || '未定'
    byOwner[owner] = byOwner[owner] || { total: 0, done: 0 }
    byOwner[owner].total += 1
    if (row.status === '✅') byOwner[owner].done += 1
  }
  return { total: rows.length, byStatus, byOwner }
}

export const diffFeatureTables = (previousRows = [], currentRows = []) => {
  const previous = new Map(previousRows.map((row) => [row.no, row]))
  return currentRows
    .filter((row) => previous.has(row.no) && previous.get(row.no).status !== row.status)
    .map((row) => ({ no: row.no, feature: row.feature, owner: row.owner, from: previous.get(row.no).status, to: row.status }))
}

const defaultGit = (root, args) => {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 120_000 })
  return { ok: result.status === 0, stdout: result.stdout || '', stderr: result.stderr || '' }
}

const parseCommits = (stdout) =>
  stdout.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const [sha, author, email, ...rest] = line.split('|')
    return { sha, author, email, subject: rest.join('|') }
  })

// git 作者 → 人名：profile.dailyReport.people 里 { henry: ['Henry', 'henry.x'] }；对不上的保留原作者名。
export const resolvePerson = (people, { author, email }) => {
  const haystack = [author, email].map((value) => String(value || '').toLowerCase())
  for (const [name, aliases] of Object.entries(people || {})) {
    const candidates = [name, ...(Array.isArray(aliases) ? aliases : [])].map((value) => String(value).toLowerCase())
    if (candidates.some((alias) => alias && haystack.some((value) => value === alias || value.startsWith(`${alias}@`) || value.includes(alias)))) return name
  }
  return author || email || '未知'
}

export const groupCommitsByPerson = (commits, people) => {
  const groups = {}
  for (const commit of commits) {
    // 合并提交（Merge branch …）不算工作量，但说明有人 MR 了：单独计数不列条目。
    const person = resolvePerson(people, commit)
    groups[person] = groups[person] || { commits: [], merges: 0 }
    if (/^Merge (branch|remote-tracking branch)/i.test(commit.subject)) groups[person].merges += 1
    else groups[person].commits.push(commit)
  }
  return groups
}

// 评审检出：日报只看 origin/pre 的真实代码（aven 2026-10-13 定：不再看本地 / 其它分支，团队每天往 pre 合）。
// 在 worktreesDir 下维护一个 detached 的 pre 检出，每次先 fetch 再 reset 到 origin/pre；模型就在这里只读。
export const prepareReviewCheckout = ({ profile, ref = 'origin/pre', git = defaultGit }) => {
  const root = profile.root
  const dir = join(profile.worktreesDir, 'daily-review')
  const [remote, ...branchParts] = ref.split('/')
  const fetched = git(root, ['fetch', remote, branchParts.join('/')])
  const note = fetched.ok ? '' : `fetch ${ref} 失败，用本地引用（可能陈旧）：${fetched.stderr.trim().slice(0, 120)}`
  if (existsSync(join(dir, '.git'))) {
    const reset = git(dir, ['reset', '--hard', ref])
    if (!reset.ok) return { dir: root, note: `${note} 评审检出重置失败：${reset.stderr.trim().slice(0, 120)}` }
    git(dir, ['clean', '-fdq'])
    return { dir, note }
  }
  mkdirSync(profile.worktreesDir, { recursive: true })
  const added = git(root, ['worktree', 'add', '--detach', dir, ref])
  if (!added.ok) return { dir: root, note: `${note} 评审检出创建失败，改在主仓读：${added.stderr.trim().slice(0, 120)}` }
  return { dir, note }
}

// 文档路径映射到评审检出里（pre 上有就用 pre 的版本，没有回落主仓的）。
const inCheckout = (checkoutDir, root, absolutePath) => {
  if (!absolutePath) return absolutePath
  const relative = absolutePath.startsWith(`${root}/`) ? absolutePath.slice(root.length + 1) : null
  if (!relative) return absolutePath
  const candidate = join(checkoutDir, relative)
  return existsSync(candidate) ? candidate : absolutePath
}

// 探针输出「### GET /path {...} -> code msg data」→ 按 featureChecks 判「可用 / 没数据 / 不可用」（整改 #17）。
// 探针的结构摘要（PROBE_SUMMARY=1 时每条多打一行 ### SUMMARY … -> code {type,len|keys}，不截断）→ 按 featureChecks 判
// 「可用 / 没数据 / 不可用」（整改 #17）。只认摘要行，不解析可能被截断的正文 JSON。
const pickSummary = (node, pick) => {
  if (!pick) return node
  let cur = node
  for (const key of String(pick).split('.')) {
    if (!cur || cur.type !== 'object' || !cur.keys || !(key in cur.keys)) return undefined
    cur = cur.keys[key]
  }
  return cur
}
const summaryEmpty = (node) => !node || node.type === 'null' || node.type === 'undefined' || (node.type === 'array' && !node.len) || (node.type === 'string' && node.empty) || (node.type === 'object' && node.keys && !Object.keys(node.keys).length)
export const judgeFeatureCheck = (check, summaryLine) => {
  if (!summaryLine) return { status: '未测', detail: `${check.label}：探针没有返回这条` }
  const m = summaryLine.match(/->\s*(\S+)\s*(\{.*\})?\s*$/)
  if (!m) return { status: '未测', detail: `${check.label}：${summaryLine.slice(0, 80)}` }
  const code = m[1]
  if (code === 'UNREACHABLE' || code === 'SKIPPED') return { status: '不可用', detail: `${check.label}：pre 连不上或没测` }
  if (code !== '0') return { status: '不可用', detail: `${check.label}：接口返回 code ${code}` }
  let summary = null
  try {
    summary = m[2] ? JSON.parse(m[2]) : null
  } catch {
    summary = null
  }
  if (check.expect === 'ok') return { status: '可用', detail: `${check.label}：code 0` }
  const target = pickSummary(summary, check.pick)
  if (check.expect.startsWith('field:')) {
    const field = check.expect.slice(6)
    const node = pickSummary(target, field)
    return summaryEmpty(node) ? { status: '没数据', detail: `${check.label}：${field} 为空` } : { status: '可用', detail: `${check.label}：${field} 有值` }
  }
  return summaryEmpty(target)
    ? { status: '没数据', detail: `${check.label}：返回为空` }
    : { status: '可用', detail: `${check.label}：${target?.type === 'array' ? `${target.len} 条` : '有数据'}` }
}

// 跑探针：一次把 featureChecks 全传进去（探针自己并发），输出按入参顺序逐行对应。probe 可注入（单测）。
export const runFeatureChecks = ({ profile, checks, probe = null }) => {
  if (!checks?.length || !profile?.verify?.probeCommand) return []
  const spec = JSON.stringify(checks.map((check) => [check.path, check.params]))
  let stdout = ''
  if (probe) stdout = probe(spec)
  else {
    const [cmd, ...args] = profile.verify.probeCommand.split(/\s+/)
    const result = spawnSync(cmd, [...args, spec, '10'], { cwd: profile.root, encoding: 'utf8', timeout: 180_000, env: { ...process.env, PROBE_BUDGET_MS: '150000', PROBE_SUMMARY: '1' } })
    stdout = `${result.stdout || ''}${result.stderr || ''}`
  }
  const lines = stdout.split('\n').filter((line) => line.startsWith('### SUMMARY '))
  return checks.map((check) => {
    const needle = ` ${check.path} ${JSON.stringify(check.params || {})} ->`
    const line = lines.find((item) => item.includes(needle)) || lines.find((item) => item.includes(` ${check.path} `))
    return { ...check, ...judgeFeatureCheck(check, line) }
  })
}

export const collectDailyFacts = ({ profile, store, now = new Date(), git = defaultGit, readFile = (path) => readFileSync(path, 'utf8'), snapshotDir, checkout = null, probe = null }) => {
  const root = profile.root
  const since = startOfDayIso(now)
  const report = profile.dailyReport
  const people = report?.people || {}
  const format = '--format=%h|%an|%ae|%s'
  const ref = report?.othersRef || 'origin/pre'
  const review = checkout || (report?.fetch === false ? { dir: root, note: '' } : prepareReviewCheckout({ profile, ref, git }))
  const fetchNote = review.note || ''
  // 所有人的工作（含 aven）只看 origin/pre 当天的提交。
  const others = git(root, ['log', ref, `--since=${since}`, format])
  const head = git(root, ['rev-parse', '--short', ref])
  // 功能总表是负责人手维护的状态（aven 2026-10-13：状态列以总表为准），读本地最新版，不读 pre 上可能落后的那份。
  const featureTablePath = report?.featureTable || null
  const table = featureTablePath ? readFileSafe(readFile, featureTablePath) : ''
  const rows = parseFeatureTable(table)
  const snapshotPath = snapshotDir ? join(snapshotDir, 'feature-table.json') : null
  let previousRows = []
  if (snapshotPath && existsSync(snapshotPath)) {
    try {
      previousRows = JSON.parse(readFileSync(snapshotPath, 'utf8')).rows || []
    } catch {
      previousRows = []
    }
  }
  const roadmap = report?.roadmap ? readFileSafe(readFile, inCheckout(review.dir, root, report.roadmap)) : ''
  const todayKey = localDateKey(now)
  const botTasks = (store?.list?.() || []).filter((task) => (task.repo === profile.key || task.project === profile.projectKey) && String(task.updatedAt || task.createdAt || '').startsWith(todayKey))
  // 整改 #11：aven 本地工作分支领先 pre 的提交（已做未合），日报要单列，不能写成没做。
  const aheadLog = profile.baseRef ? git(root, ['log', `${ref}..${profile.baseRef}`, '--format=%h|%an|%ae|%s']) : { ok: false, stdout: '' }
  const localAhead = aheadLog.ok ? parseCommits(aheadLog.stdout) : []
  const integrationAhead = profile.integrationBranch && git(root, ['rev-parse', '--verify', '--quiet', profile.integrationBranch]).ok
    ? parseCommits(git(root, ['log', `${profile.baseRef}..${profile.integrationBranch}`, '--format=%h|%an|%ae|%s']).stdout || '')
    : []
  // 整改 #17：✅ 的功能用探针实测（功能 → 接口表在 dailyReport.featureChecks）。
  const featureChecks = runFeatureChecks({ profile, checks: report?.featureChecks || [], probe })
  // 整改 #8：还挂着等负责人决定的疑似任务。
  const suspected = (store?.listSuspected?.() || []).filter((task) => task.repo === profile.key).map((task) => ({ id: task.id, summary: task.summary || task.id, since: task.parkedAt || task.updatedAt }))
  const ledger = loadLedger(profile.key)
  syncLedgerFromPending(profile, ledger)
  return {
    ledgerSummary: ledgerSummary(ledger, { max: 60 }),
    localAhead,
    integrationAhead,
    featureChecks,
    suspected,
    date: todayKey,
    repo: profile.key,
    title: profile.title || profile.key,
    othersRef: ref,
    reviewDir: review.dir,
    reviewHead: head.ok ? head.stdout.trim() : '',
    fetchNote,
    others: groupCommitsByPerson(parseCommits(others.stdout), people),
    table: { rows, summary: summarizeFeatureTable(rows), changes: diffFeatureTables(previousRows, rows), hadSnapshot: previousRows.length > 0 },
    roadmapSection: extractRoadmapSection(roadmap),
    apiGapSources: collectApiGapSources({ dir: review.dir, rows, git, readFile }),
    botTasks: botTasks.map((task) => ({ id: task.id, status: task.status, summary: task.summary, result: String(task.result || '').split('\n').slice(0, 3).join(' ') })),
    docPaths: {
      featureTable: featureTablePath,
      roadmap: report?.roadmap ? inCheckout(review.dir, root, report.roadmap) : null,
      pendingDir: report?.pendingDir ? inCheckout(review.dir, root, report.pendingDir) : null,
      // 模板是负责人手写的，以本地仓库里的最新版为准（可能还没合进 pre）。
      docTemplate: report?.docTemplate || null,
    },
    people: Object.keys(people),
    me: profile.ownership?.me || null,
  }
}

// 全项目接口缺口线索（aven 2026-10-14：二节不能只看 pending/）。从 ${ref} 检出里确定性采集，模型再逐条核对。
// 宽匹配（mock 导入、mock 开关、Phase 1：mock 注释、withApiFallback 回落）：多抓由模型核对，少抓就漏功能。
const MOCK_PATTERN = 'mock|withApiFallback'
export const parseMockUsages = (stdout) => {
  const byFile = new Map()
  for (const line of String(stdout || '').split('\n')) {
    const match = line.match(/^([^:]+):\d+:/)
    if (!match || /\.test\.ts$|\/mock\.ts$/.test(match[1])) continue
    byFile.set(match[1], (byFile.get(match[1]) || 0) + 1)
  }
  return [...byFile].map(([file, hits]) => ({ file, hits }))
}

export const collectApiGapSources = ({ dir, rows = [], git = defaultGit, readFile = (path) => readFileSync(path, 'utf8') }) => {
  let msw = []
  try {
    msw = (JSON.parse(readFile(join(dir, 'src/mocks/pending-endpoints.json'))).pending || []).filter((item) => !item.ready)
  } catch {
    msw = []
  }
  const grep = git(dir, ['grep', '-n', '-i', '-E', MOCK_PATTERN, '--', 'src/modules/*/data/*.ts', 'src/modules/*/data/**/*.ts'])
  return {
    unfinished: rows.filter((row) => row.status !== '✅').map(({ no, feature, owner, location, note }) => ({ no, feature, owner, location, note })),
    msw: msw.map(({ path, owner, reason }) => ({ path, owner, reason })),
    mockUsages: grep?.ok === false ? [] : parseMockUsages(grep?.stdout),
  }
}

const formatApiGapSources = (sources) => {
  if (!sources) return '（未采集）'
  const unfinished = sources.unfinished.map((row) => `  - #${row.no} ${row.feature}（${row.owner}）：${String(row.note || '').slice(0, 120)}`).join('\n') || '  （无）'
  const msw = sources.msw.map((item) => `  - ${item.path}（登记 owner ${item.owner}）：${item.reason}`).join('\n') || '  （无）'
  const mocks = sources.mockUsages.map((item) => `  - ${item.file}（${item.hits} 处）`).join('\n') || '  （无）'
  return `- 功能总表里没打 ✅ 的功能（${sources.unfinished.length} 项）：\n${unfinished}\n- MSW 登记的未接端点：\n${msw}\n- 数据层里仍引用 mock / mock 开关 / 回落的文件（每个都要打开看是哪个接口没接）：\n${mocks}`
}

const readFileSafe = (readFile, path) => {
  try {
    return readFile(path)
  } catch {
    return ''
  }
}

// 交付路线图的「可交付分三档」表 + 关键路径段：原文直接给模型，不自行解析（表头经常变）。
export const extractRoadmapSection = (markdown) => {
  const text = String(markdown || '')
  const start = text.indexOf('## 一、')
  if (start < 0) return text.slice(0, 6000)
  const end = text.indexOf('\n## 三、', start)
  return text.slice(start, end > 0 ? end : start + 8000).slice(0, 8000)
}

export const saveFeatureTableSnapshot = ({ snapshotDir, rows }) => {
  if (!snapshotDir) return
  mkdirSync(snapshotDir, { recursive: true })
  writeFileSync(join(snapshotDir, 'feature-table.json'), JSON.stringify({ savedAt: new Date().toISOString(), rows }, null, 2), { mode: 0o600 })
}

const formatCommits = (commits, limit = 20) => commits.slice(0, limit).map((commit) => `  - ${commit.sha} ${commit.subject}`).join('\n') || '  （无）'

// 实测 / 本地领先 / 疑似：三段事实文案，短版和完整版提示共用。
const formatVerifiedChecks = (facts) => {
  if (!facts.featureChecks?.length) return ''
  const lines = facts.featureChecks.map((check) => `  - ${check.status}｜#${check.features.join('/#')} ${check.detail}`)
  return `pre 实测（日报前探针刚打的，✅ 的功能以这里为准，「没数据 / 不可用」的要在「其中 k 项 pre 上还看不到效果」里点名）：\n${lines.join('\n')}\n\n`
}
const formatLocalAhead = (facts) => {
  const mine = facts.localAhead || []
  const integ = facts.integrationAhead || []
  if (!mine.length && !integ.length) return ''
  const lines = []
  if (mine.length) lines.push(`${facts.me || '负责人'} 本地工作分支领先 ${facts.othersRef} 的提交 ${mine.length} 个（已做、没合 pre，日报单列一行「本地已做、未合 pre」，不要写成没做）：\n${mine.slice(0, 12).map((c) => `  - ${c.sha} ${c.subject}`).join('\n')}`)
  if (integ.length) lines.push(`bot 集成分支里还没合进 ${facts.me || '负责人'} 工作分支的提交 ${integ.length} 个：\n${integ.slice(0, 8).map((c) => `  - ${c.sha} ${c.subject}`).join('\n')}`)
  return `${lines.join('\n')}\n\n`
}
const formatLedger = (facts) => (facts.ledgerSummary ? `对接台账（条目｜标题｜状态｜最近事件；answered = 对方答了、前端还没做；applied = bot 已做；asked = 对方在等我方答）：\n${facts.ledgerSummary}\n\n` : '')
const formatSuspected = (facts) => (facts.suspected?.length ? `等 ${facts.me || '负责人'} 决定的疑似任务 ${facts.suspected.length} 条（日报末尾单列一行「等你决定的」）：\n${facts.suspected.slice(0, 8).map((task) => `  - ${task.summary}`).join('\n')}\n\n` : '')

export const buildDailyReportPrompt = (facts) => {
  const statusLine = Object.entries(facts.table.summary.byStatus).map(([status, count]) => `${status}${STATUS_LABELS[status] ? `(${STATUS_LABELS[status]})` : ''} ${count}`).join(' · ')
  const ownerLines = Object.entries(facts.table.summary.byOwner).map(([owner, item]) => `  - ${owner}：${item.done}/${item.total} ✅`).join('\n')
  const changeLines = facts.table.changes.length
    ? facts.table.changes.map((change) => `  - #${change.no} ${change.feature}（${change.owner}）：${change.from} → ${change.to}`).join('\n')
    : facts.table.hadSnapshot ? '  （今日无状态变化）' : '  （首次生成，无上次快照可比）'
  const otherLines = Object.entries(facts.others).map(([person, group]) =>
    `- ${person}：${group.commits.length} 个提交${group.merges ? `、${group.merges} 次合并` : ''}\n${formatCommits(group.commits)}`).join('\n') || '- （今天 ' + facts.othersRef + ' 没有任何新提交）'
  const silent = facts.people.filter((name) => !facts.others[name])
  const botLines = facts.botTasks.map((task) => `  - [${task.status}] ${task.summary || task.id}：${task.result}`).join('\n') || '  （无）'
  return `你是 ${facts.title} 项目的日报撰写者。下面是脚本**确定性采集**的事实（可信），请只依据它们写当天日报；不要编造没有出现在事实里的进度、人名或原因。看不出原因的卡点写「待负责人补充」。
写给项目群里的产品 / 后端 / 前端同事看：说人话、不贴 sha、不贴文件路径、不贴内部状态名。

日期：${facts.date}
功能总表（${facts.table.summary.total} 项）：${statusLine}
各前端负责人完成度：
${ownerLines}
今日状态变化：
${changeLines}

${formatVerifiedChecks(facts)}${formatLocalAhead(facts)}${formatLedger(facts)}${formatSuspected(facts)}今天合入 ${facts.othersRef}（${facts.reviewHead}）的提交（按人；只认 ${facts.othersRef}，没合进去的工作不算）：
${otherLines}
${facts.fetchNote ? `注意：${facts.fetchNote}\n` : ''}今天在 ${facts.othersRef} 上没有提交的人：${silent.length ? silent.join('、') : '（无）'}

bot 今天处理过的任务：
${botLines}

交付路线图里的「还差什么 / 卡在谁」（原文，可引用）：
<<<ROADMAP
${facts.roadmapSection || '（读不到交付路线图）'}
ROADMAP

请严格按下面模板输出 **Markdown**（会作为 .md 文件发到项目群，给人 10 秒扫完用），正文不超过 16 行；没有内容的段整段省略，不要写「无」：

# ${facts.title} 日报 ${facts.date}

已接通 **<✅数> / ${facts.table.summary.total}**${facts.table.hadSnapshot ? '，今日 +<升为✅的数>' : ''}

## 今天
- **<人名>**：<做了什么，合并同类，≤ 40 字，不写编号、细节、文件>（每人一行，只写今天有提交或有动作的人；替别人推进的在括号里注明「替 henry」）

## 卡点 → 等谁
- **<对方：live 后端 / 运维 / 产品 / hichat 后端 / 某前端>**：<要他做什么，一句话，编号放括号；同一方多件事用「；」并一行>（最多 5 行，按上线档位 L1 > L2 > L3 排；只写外部卡点）

## 今天没合 pre
<人名、人名>（${facts.othersRef} 没提交的人，一行）

要求：只用上面这几种 Markdown（一级标题、二级标题、无序列表、加粗），不要表格、代码块、表情、链接；不要「整体 / 需要支持」等额外段落。
${COMPLETION_RULE}
`.trim()
}

// 云文档版：按交接报告模板的结构写当天完整版（功能进度总览全表 / API 缺什么有问题 / 其它没做的 / 一句话现状）。
// 模型在业务仓根目录只读运行，自己读模板、功能总表、待对接目录、路线图核对；脚本只喂当天的 git 事实。
export const buildDailyDocPrompt = (facts, report) => {
  const otherLines = Object.entries(facts.others).map(([person, group]) =>
    `- ${person}：${group.commits.length} 个提交${group.merges ? `、${group.merges} 次合并` : ''}\n${formatCommits(group.commits)}`).join('\n') || `- （今天 ${facts.othersRef} 没有新提交）`
  const dateTag = facts.date.slice(5)
  return `你是 ${facts.title} 项目的交接 / 日报撰写者。请写 **${facts.date} 的完整版日报（云文档）**，结构、表格列、语气、详略**严格照抄这份模板**：
\`${facts.docPaths.docTemplate || report.docTemplate}\`
它是负责人手写的上一版日报，你的任务是把它更新成「截至今天」的版本，不是另起炉灶：结构一个块都不增减，只改内容。

必须先读（只读，不改任何文件）：
1. 模板本身（上面路径，绝对路径，在本地仓库里）。
2. 功能总表：\`${facts.docPaths.featureTable}\`（「前端」列 = 负责人，状态列 = 当前实现状态，备注列 = 还剩什么）。
3. 待对接目录：\`${facts.docPaths.pendingDir || '（未配置）'}\` 下所有文档（各方卡点、编号如 A5-2 / O10 / H1 的权威来源）。
4. 交付路线图：\`${facts.docPaths.roadmap}\`。

**代码事实只以 ${facts.othersRef}（${facts.reviewHead}）为准**：你所在的工作目录就是它的检出，功能做没做、接没接真实接口，去读这里的代码判断；本地其它分支、别人没合进 pre 的工作一概不算。

脚本采集的当天事实（可信）：
- 今天合入 ${facts.othersRef} 的提交（按人）：
${otherLines}
${facts.fetchNote ? `- 注意：${facts.fetchNote}` : ''}
- bot 今天处理过的任务：
${facts.botTasks.map((task) => `  - [${task.status}] ${task.summary || task.id}：${task.result}`).join('\n') || '  （无）'}
${formatVerifiedChecks(facts)}${formatLocalAhead(facts)}${formatLedger(facts)}${formatSuspected(facts)}- 功能总表今日状态变化：${facts.table.changes.length ? facts.table.changes.map((change) => `#${change.no} ${change.from}→${change.to}`).join('、') : '（无 / 首次）'}
- 全项目接口缺口线索（脚本从 ${facts.othersRef} 检出采集，写二节用；线索不等于结论，要逐条打开代码核对）：
${formatApiGapSources(facts.apiGapSources)}

输出结构（Markdown + Lark 文档 XML 块，直接可建成云文档），从上到下：
1. 一级标题：\`# ${facts.title} 一期 · 日报（${facts.date}）\`。
2. 紧接一行二级标题 \`## 总体进度：xx.x%\`（全部功能的加权完成度：✅ 记 100%，UI 写完只差接口或回归的按完成程度记 50%–80%，没 UI 的记 0%，#54 不计，保留一位小数）。总体进度只放这里，一节里不再重复；模板里若还在一节下面，以这里为准。
3. 紧接一个高亮框引子，标签照模板原样：\`<callout emoji="📝" background-color="light-yellow" border-color="yellow">\` … \`</callout>\`，里面每行一个 \`<p><b>名字：</b>一句话</p>\`：先按负责人各一行（负责几项、几项 ✅、没完成的卡在哪、等谁），再「运维」一行（今天做了什么、等什么），最后「外部阻塞」一行（最大的两个外部阻塞、各卡住多少功能）。高亮框里只能有 \`<p>\`，文本里的 \`<\` \`>\` \`&\` 要写成 \`&lt;\` \`&gt;\` \`&amp;\`，标签本身不转义。不要模板之外的任何引用块。
4. 「## 一、功能进度总览（…）」：标题括号里的总数说明照模板；一行图例「✅ = 写完且接了真实接口。没打勾的写明还剩什么、卡在哪、找谁。」；然后**全量表格**，模板有几行就保留几行（含合并行如 17–20），列为 # / 功能 / 负责人 / 状态 / 还剩什么 · 卡在哪 / 需要谁支持，状态只用 ✅ / ⬜ / —，**状态列以功能总表（人维护）为准，不要按代码自行改判**：总表标 ✅ 就写 ✅，总表没标 ✅ 就写 ⬜，哪怕 pre 上看着能用；代码只用来写「还剩什么 · 卡在哪」和当天进展。今天有进展或变化的行（包括 ✅ 的行），在「还剩什么 · 卡在哪」里以「${dateTag}：」开头写一句今天发生了什么；模板里带旧日期前缀的句子，事实没变就保留，变了就改。表后「**计数**（不含 #54）：✅ n 项，…。未完成 m 项：」接一个无序列表，每个负责人一行「名字 n 项：#编号…（简述卡点）」。
5. 「## 二、API：还缺什么、哪些有问题」：**按整个项目的前端功能盘，不能只抄待对接目录**。做法：以上面「全项目接口缺口线索」为起点，逐个打开没打 ✅ 的功能的代码落点和每个仍引用 mock 的数据层文件，查清每个功能缺哪个接口（没接 / 只有 mock / 接了但 pre 没数据 / 接了但报错）；再对照 \`docs/apis/对接状态总览.md\`、待对接目录和 \`docs/archive/\` 下的答复补上编号与文档。只有两小节：
   - 2.1 缺接口 / 缺数据 / 缺配置（表，列为 功能 / 缺什么 / 现状 / 找谁 / 文档）：「功能」写 #编号 + 名称，同一接口卡多个功能就并一行；「现状」写 pre 上是 mock / 没接 / 没数据；「文档」写待对接编号，**还没登记进任何对接文档的写「未登记」**，这类是要补问的，不能因为没文档就漏掉。
   - 2.2 接过但有问题的接口（表，列为 接口 / 问题 / 处理 / 负责人）。
   - 两表之后一行「**不缺接口的未完成功能**：#编号…（只差 UI / 回归 / 走查）」，让没打 ✅ 的每个功能都能在二节找到归宿。
   **不要**写「已接通并在 pre 实测过的」那种汇总段。
6. 「## 三、需要再跟进的工作」（表，列为 事项 / 说明 / 负责人）。文档到这里结束，不再写「四、一句话现状」（已并进开头的高亮框）。

写法要求：
${COMPLETION_RULE}
- 高亮框里每个负责人那行：「负责 n 项，m 项 ✅」之后必须接一句「其中 k 项 pre 上还看不到效果（#编号 原因）」，k=0 才可以不写；✅ 只代表总表状态，不代表能用。
- 「没合进 pre」要作为事实写在「还剩什么」里：某负责人的功能若在 ${facts.othersRef} 上还是 mock / 未接，就写明，哪怕他说本地做了（状态列仍按总表）。
- 事实以仓库文档和上面的提交为准；模板里今天已经解决的条目要改掉，不要照抄过期内容；不确定的写「待确认」，不要编。
- 不要代码块、不要表情（状态符号和高亮框 emoji 除外）、不要写 bot / 任务 id / 内部状态名。
- **只输出文档正文**：从一级标题、总体进度标题开始、到「三、需要再跟进的工作」的表格结束；不要在前后附加说明、「待确认的地方」之类的写作备注（有不确定的直接写进对应表格的「待确认」）。`
}

// 用 claude 只读整理（plan 模式、只给 Read/Grep，cwd 在业务仓，可自行翻文档核对）。返回纯文本。
export const generateDailyReportText = ({ prompt, profile, model, effort, timeoutMs = 10 * 60_000, spawnImpl = spawn, cwd = null }) =>
  new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--permission-mode', 'plan',
      '--tools', 'Read,Grep,Glob',
      ...(model ? ['--model', model] : []),
      ...(effort ? ['--effort', effort] : []),
      '--no-session-persistence',
      '--output-format', 'text',
      prompt,
    ]
    const child = spawnImpl('claude', args, { cwd: cwd || profile.root, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error(`claude 日报生成失败（exit ${code}）：${stderr.trim().slice(-300)}`))
      resolve(stdout.trim())
    })
  })

// sendTo 里的群名经 profile.chatNameById 反查成 chat_id；直接给 oc_ / ou_ 也行。
export const resolveSendTargets = ({ profile, report }) => {
  const byName = Object.fromEntries(Object.entries(profile.chatNameById || {}).map(([id, name]) => [name, id]))
  return (report?.sendTo || []).map((item) => (/^(oc|ou)_/.test(item) ? item : byName[item] || null)).filter(Boolean)
}

export const buildDailyReportCard = ({ config, profile, text, date }) => {
  const lines = text.split('\n').map((line) => line.trimEnd()).filter(Boolean)
  // 首行标题已含日期，卡片 header 用项目名；正文每行一条，lark_md 直接渲染。
  const body = lines[0]?.startsWith('【') ? lines.slice(1) : lines
  return buildCardContent({
    config,
    kind: 'notice',
    lines: [`**日报 ${date}**`, ...body],
    project: profile.projectKey,
    projectTitle: profile.title || '',
  })
}

// 用用户身份把 Markdown 建成 Lark 云文档，返回 { ok, url, documentId, reason }。
export const runDailyReport = async ({ config, store, profile, now = new Date(), deps = {} }) => {
  const report = profile.dailyReport
  if (!report) return { ok: false, reason: 'profile 未配置 dailyReport' }
  const reportDir = join(deps.runtimeDir || larkRuntimeDir, 'lark-daily-report', profile.key)
  mkdirSync(reportDir, { recursive: true })
  const facts = (deps.collectFacts || collectDailyFacts)({ profile, store, now, snapshotDir: reportDir })
  const prompt = buildDailyReportPrompt(facts)
  let text = await (deps.generateText || generateDailyReportText)({ prompt, profile, model: report.model || profile.claudeModel, effort: report.effort || 'medium', cwd: facts.reviewDir })
  if (!text) return { ok: false, reason: '模型未产出日报正文' }
  const date = facts.date
  // 云文档版：配了 docTemplate 才做（耗时较长，单独一趟模型调用；失败不影响短消息）。
  let doc = null
  if (report.docTemplate) {
    try {
      const fullText = await (deps.generateText || generateDailyReportText)({ prompt: buildDailyDocPrompt(facts, report), profile, model: report.model || profile.claudeModel, effort: report.docEffort || report.effort || 'medium', timeoutMs: 20 * 60_000, cwd: facts.reviewDir })
      if (fullText) {
        const fullName = `${(profile.title || profile.key).replace(/[\\/:*?"<>|\s]/g, '')}日报-${date}-完整版.md`
        writeFileSync(join(reportDir, fullName), `${fullText}\n`, { mode: 0o600 })
        const created = await (deps.createLarkDoc || createLarkDocFromMarkdown)({ title: `${profile.title || profile.key} 一期 · 日报（${date}）`, dir: reportDir, file: fullName })
        doc = created.ok ? { url: created.url, documentId: created.documentId, path: join(reportDir, fullName) } : null
        if (!created.ok) console.error(`[lark-gateway] 日报云文档创建失败：${created.reason}`)
        else text = `${text}\n\n完整版（云文档）：${created.url}`
      }
    } catch (error) {
      console.error(`[lark-gateway] 日报云文档生成异常：${String(error?.message || error).slice(0, 200)}`)
    }
  }
  writeFileSync(join(reportDir, `${date}.md`), `${text}\n\n---\n<!-- facts -->\n${JSON.stringify(facts, null, 2)}\n`, { mode: 0o600 })
  saveFeatureTableSnapshot({ snapshotDir: reportDir, rows: facts.table.rows })
  // 投递（aven 2026-10-13 定）：用户身份发不进外部群（230027），外部群只能走各群自定义机器人 webhook 的富文本；
  // 配了 sendTo（群名 / chat_id）且该群有 webhook → webhook post；没配 → 以 bot 身份私聊负责人发 Markdown（试运行期）。
  const targets = resolveSendTargets({ profile, report })
  const fileName = `${(profile.title || profile.key).replace(/[\\/:*?"<>|\s]/g, '')}日报-${date}.md`
  const filePath = join(reportDir, fileName)
  writeFileSync(filePath, `${text}\n`, { mode: 0o600 })
  if (targets.length) {
    const sendHook = deps.sendWebhookMessage || sendWebhookMessage
    const outcomes = []
    for (const chatId of targets) {
      const webhook = resolveWebhookCredentials(profile, chatId)
      if (!webhook) {
        outcomes.push({ chatId, ok: false, reason: '该群没有配置 webhook（外部群只能靠自定义机器人发）' })
        continue
      }
      outcomes.push({ chatId, ...(await sendHook({ ...webhook, markdown: text, logPrefix: `daily report ${profile.key} -> ${chatId}` })) })
    }
    const ok = outcomes.every((item) => item.ok)
    if (!ok) console.error(`[lark-gateway] 日报群发失败：${outcomes.filter((item) => !item.ok).map((item) => `${item.chatId}: ${item.reason}`).join('；')}`)
    return { ok, reason: ok ? null : 'group send failed', date, to: targets.join(','), text, reportPath: filePath, outcomes, doc }
  }
  const to = report.to || profile.notifyChatId || profile.chatIds[0]
  const sent = await (deps.sendUserMarkdown || sendBotMarkdown)({ chatId: to, markdown: text })
  return { ok: sent.ok, reason: sent.reason, date, to, text, reportPath: filePath, doc }
}

// 调度：每分钟看一次本地时间，到 profile.dailyReport.at（HH:MM）且当天未发过就跑；状态落盘防重启重发。
export const startDailyReportScheduler = ({ config, store, deps = {} }) => {
  const statePath = join(deps.runtimeDir || larkRuntimeDir, 'lark-daily-report', 'state.json')
  let state = {}
  try {
    state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {}
  } catch {
    state = {}
  }
  const persist = () => {
    mkdirSync(join(deps.runtimeDir || larkRuntimeDir, 'lark-daily-report'), { recursive: true })
    writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 })
  }
  const targets = listRepoProfiles().filter((profile) => !profile.isDefault && profile.dailyReport?.at)
  const running = new Set()
  const tick = async () => {
    const now = deps.now ? deps.now() : new Date()
    const hhmm = `${pad(now.getHours())}:${pad(now.getMinutes())}`
    const today = localDateKey(now)
    for (const profile of targets) {
      if (profile.dailyReport.at !== hhmm || state[profile.key] === today || running.has(profile.key)) continue
      running.add(profile.key)
      try {
        const outcome = await runDailyReport({ config, store, profile, now, deps })
        if (outcome.ok) {
          state[profile.key] = today
          persist()
          console.log(`[lark-gateway] 日报已发：${profile.key} ${today} → ${outcome.to}`)
        } else {
          console.error(`[lark-gateway] 日报发送失败：${profile.key} ${outcome.reason}`)
        }
      } catch (error) {
        console.error(`[lark-gateway] 日报生成异常：${profile.key} ${String(error?.message || error).slice(0, 200)}`)
      } finally {
        running.delete(profile.key)
      }
    }
  }
  const timer = (deps.setInterval || setInterval)(() => { tick().catch(() => {}) }, 60_000)
  timer.unref?.()
  for (const profile of targets) console.log(`[lark-gateway] 日报调度：${profile.key} 每天 ${profile.dailyReport.at} → ${profile.dailyReport.to || profile.notifyChatId || '群'}`)
  return { targets: targets.map((profile) => profile.key), tick, stop: () => clearInterval(timer) }
}
