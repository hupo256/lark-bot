/**
 * 日报（aven 2026-10-12 定）：每天 19:00 汇总「这个项目今天完成到哪、负责人是谁、没完成卡在哪、需要什么支持」。
 *
 * 口径：
 *   · aven 的工作看本地集成分支（profile.baseRef，如 feature/phase-3-api）当天的提交；
 *   · 其他人的工作看 `origin/pre` 当天的提交（aven 要求每人每天至少 MR 一次到 pre），按作者分组；
 *   · 整体进度来自功能总表（phase1-feature-table.md）的状态列，并与上一次快照 diff 出「今日升级」；
 *   · 卡点 / 需要支持来自交付路线图（docs/delivery/README.md）「可交付分三档」表与 bot 当天的任务结果。
 * 事实由脚本确定性采集（git / 文件 / 任务库），再交给 Claude 只读整理成固定模板；模型不碰 git 写操作。
 * 试运行期只私发 aven（profile.dailyReport.to），看准了再发群。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { buildCardContent } from './lark-cards.mjs'
import { formatLarkCliError, larkCallFailed, runLarkCli, sendChatMessage } from './lark-cli.mjs'
import { larkRuntimeDir } from './lark-paths.mjs'
import { listRepoProfiles, resolveWebhookCredentials } from './lark-repo-profile.mjs'
import { sendWebhookMessage } from './lark-webhook.mjs'

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

export const collectDailyFacts = ({ profile, store, now = new Date(), git = defaultGit, readFile = (path) => readFileSync(path, 'utf8'), snapshotDir }) => {
  const root = profile.root
  const since = startOfDayIso(now)
  const report = profile.dailyReport
  const people = report?.people || {}
  const format = '--format=%h|%an|%ae|%s'
  const mine = git(root, ['log', profile.baseRef, `--since=${since}`, format])
  const dirty = git(root, ['status', '--porcelain'])
  let fetchNote = ''
  if (report?.fetch !== false) {
    const [remote, ...branchParts] = String(report?.othersRef || 'origin/pre').split('/')
    const fetched = git(root, ['fetch', remote, branchParts.join('/')])
    if (!fetched.ok) fetchNote = `fetch ${report?.othersRef || 'origin/pre'} 失败，用本地引用（可能陈旧）：${fetched.stderr.trim().slice(0, 120)}`
  }
  const others = git(root, ['log', report?.othersRef || 'origin/pre', `--since=${since}`, format])
  const table = report?.featureTable ? readFileSafe(readFile, report.featureTable) : ''
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
  const roadmap = report?.roadmap ? readFileSafe(readFile, report.roadmap) : ''
  const todayKey = localDateKey(now)
  const botTasks = (store?.list?.() || []).filter((task) => (task.repo === profile.key || task.project === profile.projectKey) && String(task.updatedAt || task.createdAt || '').startsWith(todayKey))
  return {
    date: todayKey,
    repo: profile.key,
    title: profile.title || profile.key,
    baseRef: profile.baseRef,
    othersRef: report?.othersRef || 'origin/pre',
    fetchNote,
    mine: { commits: parseCommits(mine.stdout), uncommittedFiles: dirty.stdout.split('\n').filter(Boolean).length },
    others: groupCommitsByPerson(parseCommits(others.stdout), people),
    table: { rows, summary: summarizeFeatureTable(rows), changes: diffFeatureTables(previousRows, rows), hadSnapshot: previousRows.length > 0 },
    roadmapSection: extractRoadmapSection(roadmap),
    botTasks: botTasks.map((task) => ({ id: task.id, status: task.status, summary: task.summary, result: String(task.result || '').split('\n').slice(0, 3).join(' ') })),
    people: Object.keys(people),
    me: profile.ownership?.me || null,
  }
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

export const buildDailyReportPrompt = (facts) => {
  const statusLine = Object.entries(facts.table.summary.byStatus).map(([status, count]) => `${status}${STATUS_LABELS[status] ? `(${STATUS_LABELS[status]})` : ''} ${count}`).join(' · ')
  const ownerLines = Object.entries(facts.table.summary.byOwner).map(([owner, item]) => `  - ${owner}：${item.done}/${item.total} ✅`).join('\n')
  const changeLines = facts.table.changes.length
    ? facts.table.changes.map((change) => `  - #${change.no} ${change.feature}（${change.owner}）：${change.from} → ${change.to}`).join('\n')
    : facts.table.hadSnapshot ? '  （今日无状态变化）' : '  （首次生成，无上次快照可比）'
  const otherLines = Object.entries(facts.others).map(([person, group]) =>
    `- ${person}：${group.commits.length} 个提交${group.merges ? `、${group.merges} 次合并` : ''}\n${formatCommits(group.commits)}`).join('\n') || '- （今天 ' + facts.othersRef + ' 没有任何新提交）'
  const silent = facts.people.filter((name) => !facts.others[name] && name !== facts.me)
  const botLines = facts.botTasks.map((task) => `  - [${task.status}] ${task.summary || task.id}：${task.result}`).join('\n') || '  （无）'
  return `你是 ${facts.title} 项目的日报撰写者。下面是脚本**确定性采集**的事实（可信），请只依据它们写当天日报；不要编造没有出现在事实里的进度、人名或原因。看不出原因的卡点写「待负责人补充」。
写给项目群里的产品 / 后端 / 前端同事看：说人话、不贴 sha、不贴文件路径、不贴内部状态名。

日期：${facts.date}
功能总表（${facts.table.summary.total} 项）：${statusLine}
各前端负责人完成度：
${ownerLines}
今日状态变化：
${changeLines}

${facts.me || 'aven'} 今天的提交（分支 ${facts.baseRef}，${facts.mine.commits.length} 个；工作区未提交文件 ${facts.mine.uncommittedFiles} 个）：
${formatCommits(facts.mine.commits)}

其他人今天合入 ${facts.othersRef} 的提交（按人）：
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
`.trim()
}

// 云文档版：按交接报告模板的结构写当天完整版（功能进度总览全表 / API 缺什么有问题 / 其它没做的 / 一句话现状）。
// 模型在业务仓根目录只读运行，自己读模板、功能总表、待对接目录、路线图核对；脚本只喂当天的 git 事实。
export const buildDailyDocPrompt = (facts, report) => {
  const otherLines = Object.entries(facts.others).map(([person, group]) =>
    `- ${person}：${group.commits.length} 个提交${group.merges ? `、${group.merges} 次合并` : ''}\n${formatCommits(group.commits)}`).join('\n') || `- （今天 ${facts.othersRef} 没有新提交）`
  return `你是 ${facts.title} 项目的交接 / 日报撰写者。请写 **${facts.date} 的完整版日报（云文档）**，结构、表格列、语气、详略**严格照抄这份模板**：
\`${report.docTemplate}\`
它是负责人手写的交接报告，你的任务是把它更新成「截至今天」的版本，不是另起炉灶。

必须先读（只读，不改任何文件）：
1. 模板本身（上面路径）。
2. 功能总表：\`${report.featureTable}\`（「前端」列 = 负责人，状态列 = 当前实现状态，备注列 = 还剩什么）。
3. 待对接目录：\`${report.pendingDir || '（未配置）'}\` 下所有文档（各方卡点、编号如 A5-2 / O10 / H1 的权威来源）。
4. 交付路线图：\`${report.roadmap}\`。

脚本采集的当天事实（可信）：
- ${facts.me || 'aven'} 今天在 ${facts.baseRef} 的提交（${facts.mine.commits.length} 个）：
${formatCommits(facts.mine.commits, 30)}
- 其他人今天合入 ${facts.othersRef}：
${otherLines}
${facts.fetchNote ? `- 注意：${facts.fetchNote}` : ''}
- bot 今天处理过的任务：
${facts.botTasks.map((task) => `  - [${task.status}] ${task.summary || task.id}：${task.result}`).join('\n') || '  （无）'}
- 功能总表今日状态变化：${facts.table.changes.length ? facts.table.changes.map((change) => `#${change.no} ${change.from}→${change.to}`).join('、') : '（无 / 首次）'}

输出要求（纯 Markdown，直接可建成云文档）：
- 一级标题：\`# ${facts.title} 一期 · 日报（${facts.date}）\`；开头的引用块写范围（分支 / 提交）、分支关系、负责人依据，照模板格式。
- 「一、功能进度总览」：**全量表格**，模板里有几行就保留几行（含合并行如 17–20），列为 # / 功能 / 负责人 / 状态 / 还剩什么 · 卡在哪 / 需要谁支持；状态只用 ✅ / ⬜ / —；表后一段「计数」按负责人统计。今天状态有变化的行，在「还剩什么」里以「10-13：」开头写一句今天发生了什么。
- 「二、API」三小节照模板：缺接口 / 缺数据 / 缺配置（表）、接过但有问题（表）、已接通并实测过（一段）。编号与文档链接引用待对接目录里的实际文档。
- 「三、其它没做的工作」（表）、「四、一句话现状」。
- 事实以仓库文档和上面的提交为准；模板里今天已经解决的条目要改掉，不要照抄过期内容；不确定的写「待确认」，不要编。
- 不要代码块、不要表情（状态符号除外）、不要写 bot / 任务 id / 内部状态名。`
}

// 用 claude 只读整理（plan 模式、只给 Read/Grep，cwd 在业务仓，可自行翻文档核对）。返回纯文本。
export const generateDailyReportText = ({ prompt, profile, model, effort, timeoutMs = 10 * 60_000, spawnImpl = spawn }) =>
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
    const child = spawnImpl('claude', args, { cwd: profile.root, stdio: ['ignore', 'pipe', 'pipe'] })
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

// 私聊负责人：bot 身份发 Markdown（lark-cli 自动转成 post 富文本）。chatId 为 ou_ 时走 --user-id。
const sendBotMarkdownDefault = async ({ chatId, markdown }) => {
  const recipient = String(chatId).startsWith('ou_') ? ['--user-id', chatId] : ['--chat-id', chatId]
  const result = await runLarkCli(['im', '+messages-send', ...recipient, '--markdown', markdown], { identity: 'bot' })
  return larkCallFailed(result) ? { ok: false, reason: formatLarkCliError(result) } : { ok: true }
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
const createLarkDocDefault = async ({ title, dir, file }) => {
  const result = await runLarkCli(['docs', '+create', '--title', title, '--doc-format', 'markdown', '--content', `@${file}`, '--format', 'json'], { identity: 'user', cwd: dir, timeoutMs: 120_000 })
  if (larkCallFailed(result)) return { ok: false, reason: formatLarkCliError(result) }
  try {
    const doc = JSON.parse(result.stdout).data?.document || {}
    return doc.url ? { ok: true, url: doc.url, documentId: doc.document_id } : { ok: false, reason: '未返回文档 url' }
  } catch (error) {
    return { ok: false, reason: `解析失败：${error.message}` }
  }
}

export const runDailyReport = async ({ config, store, profile, now = new Date(), deps = {} }) => {
  const report = profile.dailyReport
  if (!report) return { ok: false, reason: 'profile 未配置 dailyReport' }
  const reportDir = join(deps.runtimeDir || larkRuntimeDir, 'lark-daily-report', profile.key)
  mkdirSync(reportDir, { recursive: true })
  const facts = (deps.collectFacts || collectDailyFacts)({ profile, store, now, snapshotDir: reportDir })
  const prompt = buildDailyReportPrompt(facts)
  let text = await (deps.generateText || generateDailyReportText)({ prompt, profile, model: report.model || profile.claudeModel, effort: report.effort || 'medium' })
  if (!text) return { ok: false, reason: '模型未产出日报正文' }
  const date = facts.date
  // 云文档版：配了 docTemplate 才做（耗时较长，单独一趟模型调用；失败不影响短消息）。
  let doc = null
  if (report.docTemplate) {
    try {
      const fullText = await (deps.generateText || generateDailyReportText)({ prompt: buildDailyDocPrompt(facts, report), profile, model: report.model || profile.claudeModel, effort: report.docEffort || report.effort || 'medium', timeoutMs: 20 * 60_000 })
      if (fullText) {
        const fullName = `${(profile.title || profile.key).replace(/[\\/:*?"<>|\s]/g, '')}日报-${date}-完整版.md`
        writeFileSync(join(reportDir, fullName), `${fullText}\n`, { mode: 0o600 })
        const created = await (deps.createLarkDoc || createLarkDocDefault)({ title: `${profile.title || profile.key} 一期 · 日报（${date}）`, dir: reportDir, file: fullName })
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
  const sent = await (deps.sendUserMarkdown || sendBotMarkdownDefault)({ chatId: to, markdown: text })
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
