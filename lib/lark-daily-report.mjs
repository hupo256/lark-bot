/**
 * 日报（aven 2026-10-12 定）：每天 19:00 汇总「这个项目今天完成到哪、负责人是谁、没完成卡在哪、需要什么支持」。
 *
 * 口径：
 *   · 所有人的工作（含 aven）只看 `origin/pre` 当天的提交与代码（aven 2026-10-13 定：团队每天往 pre 合，本地 / 其它分支不算）；
 *     模型在 origin/pre 的 detached 检出（<worktreesDir>/daily-review）里只读评审；
 *   · 状态以 origin/pre 真实代码为准、所有负责人一视同仁（aven 2026-10-14 定，推翻 10-13「以功能总表为准」）：模型在完整版末尾输出
 *     逐功能状态 JSON，脚本校验齐全后算总体进度 / 计数、回写状态列，短版与完整版用同一组数字（lark-daily-ledger.mjs）；
 *   · 三节是台账（aven 2026-10-14；10-21 起二节改成脚本生成的测试 Bug 段，对接问题不进日报）：模板 = 前一天的完整版，解决一行删一行，无依据消失的行私信 aven；
 *   · 只在工作日 19:00 发（dailyReport.days）；
 *   · 卡点 / 需要支持来自交付路线图（docs/delivery/README.md）「可交付分三档」表与 bot 当天的任务结果。
 * 事实由脚本确定性采集（git / 文件 / 任务库），再交给 Claude 只读整理成固定模板；模型不碰 git 写操作。
 * 试运行期只私发 aven（profile.dailyReport.to），看准了再发群。
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { sendBotMarkdown, sendChatMessage } from './lark-cli.mjs'
import { larkRuntimeDir } from './lark-paths.mjs'
import { resolveClaudeBinary } from './lark-constants.mjs'
import { createLarkDocFromMarkdown } from './lark-docs.mjs'
import { CODE_STATUS_SNAPSHOT, FEATURE_TABLE_SNAPSHOT, loadBaselineSnapshot, openDailyDelivery, recordDailySnapshot, sendDailyToGroups } from './lark-daily-delivery.mjs'
import { localDateOf } from './lark-local-date.mjs'
import { fetchBugRecords, renderBugLines, summarizeBugs } from './lark-daily-bugs.mjs'
import { COMPLETION_RULE } from './lark-completion-rule.mjs'
import { ledgerSummary, loadLedger, syncLedgerFromPending } from './lark-ledger.mjs'
import {
  STATUS_CLOSE,
  STATUS_OPEN,
  annotateLedgerHeadings,
  applyProgress,
  applyStatusColumn,
  buildHeadline,
  stripCalloutExtras,
  stripNonIssues,
  checkCalloutCounts,
  checkVerbose,
  pruneCalloutDone,
  replaceSection,
  fillEmptyTables,
  checkStreamUrl,
  computeProgress,
  keepUnchangedStatuses,
  diffLedger,
  fetchSiteBuildTime,
  findPreviousFullReport,
  isReportDay,
  splitStatusBlock,
  tableMismatches,
  validateStatusData,
  applyCalloutCounts,
  applyFeatureClosures,
  applyLedgerClosures,
  loadOwnerClosures,
} from './lark-daily-ledger.mjs'

const STATUS_LABELS = { '✅': '真实接口可用', '🟠': '部分实现 / 接了不通', '🟡': 'UI 完成仅 mock', '❌': '未实现' }

const pad = (n) => String(n).padStart(2, '0')
export { localDateKey, markDailyReportSent, readDailyReportState } from './lark-daily-schedule.mjs'
import { localDateKey } from './lark-daily-schedule.mjs'
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
export const runFeatureChecks = ({ profile, checks, probe = null, cwd = null }) => {
  if (!checks?.length || !profile?.verify?.probeCommand) return []
  const runProbe = (items, host) => {
    const spec = JSON.stringify(items.map((check) => [check.path, check.params]))
    if (probe) return probe(spec, host)
    const [cmd, ...args] = profile.verify.probeCommand.split(/\s+/)
    const result = spawnSync(cmd, [...args, spec, '10'], { cwd: cwd || profile.root, encoding: 'utf8', timeout: 180_000, env: { ...process.env, PROBE_BUDGET_MS: '150000', PROBE_SUMMARY: '1', ...(host ? { PROBE_HOST: host } : {}) } })
    return `${result.stdout || ''}${result.stderr || ''}`
  }
  const judgeAll = (items, stdout) => {
    const lines = stdout.split('\n').filter((line) => line.startsWith('### SUMMARY '))
    return items.map((check) => {
      const needle = ` ${check.path} ${JSON.stringify(check.params || {})} ->`
      const line = lines.find((item) => item.includes(needle)) || lines.find((item) => item.includes(` ${check.path} `))
      return { ...check, ...judgeFeatureCheck(check, line) }
    })
  }
  // 按 host 分组（bbsv2 走 admin host），连不上 / 没返回的再打一次，仍不行才写「未测」（aven 10-14：不要一次没连上就写待确认）。
  const groups = new Map()
  for (const check of checks) groups.set(check.host || '', [...(groups.get(check.host || '') || []), check])
  const out = []
  for (const [host, items] of groups) {
    let judged = judgeAll(items, runProbe(items, host || null))
    const retry = judged.filter((item) => item.status === '未测' || /连不上/.test(item.detail))
    if (retry.length) {
      const again = judgeAll(retry, runProbe(retry, host || null))
      judged = judged.map((item) => again.find((hit) => hit.path === item.path && JSON.stringify(hit.params) === JSON.stringify(item.params)) || item)
    }
    out.push(...judged)
  }
  return checks.map((check) => out.find((item) => item.path === check.path && JSON.stringify(item.params) === JSON.stringify(check.params) && item.label === check.label) || { ...check, status: '未测', detail: `${check.label}：没跑到` })
}

// 评审检出在仓外（没有 node_modules），探针 / schema 校验要依赖：软链主仓的 node_modules（被 .gitignore，reset / clean 不会动）。
export const ensureReviewDeps = ({ dir, root }) => {
  if (!dir || !root || dir === root) return
  const target = join(dir, 'node_modules')
  if (existsSync(target) || !existsSync(join(root, 'node_modules'))) return
  try {
    symlinkSync(join(root, 'node_modules'), target, 'dir')
  } catch {
    // 软链失败就让探针自己报错，日报照常
  }
}

// 用 pre 代码里的 zod schema 校验 pre 真实返回（falive scripts/pre-schema-check.probe.ts）。输出「### SCHEMA <export> <path> -> ok | issues…」。
export const parseSchemaCheckOutput = (checks, stdout) => {
  const lines = String(stdout || '').split('\n').filter((line) => line.includes('### SCHEMA '))
  return checks.map((check) => {
    const line = lines.find((item) => item.includes(`### SCHEMA ${check.export} ${check.path} ->`))
    if (!line) return { ...check, status: '未测', detail: `${check.export}：校验没跑到` }
    const result = line.split('->').slice(1).join('->').trim()
    if (/^ok\b/.test(result)) return { ...check, status: '可用', detail: `${check.export}：pre 返回过 schema` }
    if (/UNREACHABLE/.test(result)) return { ...check, status: '未测', detail: `${check.export}：pre 连不上` }
    return { ...check, status: '不可用', detail: `${check.export}：pre 返回不过前端 schema（${result.slice(0, 160)}）` }
  })
}
export const runSchemaChecks = ({ profile, checks, cwd, exec = null }) => {
  const report = profile.dailyReport
  if (!checks?.length) return []
  const command = report?.schemaCheckCommand || 'pnpm vitest run --config vitest.probe.config.ts'
  let stdout = ''
  if (exec) stdout = exec(checks)
  else {
    const [cmd, ...args] = command.split(/\s+/)
    const result = spawnSync(cmd, args, { cwd: cwd || profile.root, encoding: 'utf8', timeout: 240_000, env: { ...process.env, SCHEMA_CHECK: JSON.stringify(checks.map(({ features, ...item }) => item)) } })
    stdout = `${result.stdout || ''}${result.stderr || ''}`
  }
  return parseSchemaCheckOutput(checks, stdout)
}

// 拉流实测：探针完整输出里取 pull_m3u8 / pull，真实去拉（只看 pull 字段有值会把断流当成能播）。
export const extractPullUrls = (stdout) => {
  const out = {}
  for (const key of ['pull_m3u8', 'pull_flv', 'pull']) {
    const hit = String(stdout || '').match(new RegExp(`"${key}"\\s*:\\s*"(https?:[^"]+)"`))
    if (hit) out[key] = hit[1].replace(/\\\//g, '/')
  }
  return out
}
export const runStreamCheck = async ({ profile, cwd, probe = null, fetchImpl = fetch }) => {
  const check = profile.dailyReport?.streamCheck
  if (!check || !profile?.verify?.probeCommand) return null
  const spec = JSON.stringify([[check.path, check.params]])
  let stdout = ''
  if (probe) stdout = probe(spec)
  else {
    const [cmd, ...args] = profile.verify.probeCommand.split(/\s+/)
    const result = spawnSync(cmd, [...args, spec, '20000'], { cwd: cwd || profile.root, encoding: 'utf8', timeout: 60_000, env: { ...process.env, PROBE_BUDGET_MS: '45000' } })
    stdout = `${result.stdout || ''}${result.stderr || ''}`
  }
  const urls = extractPullUrls(stdout)
  const url = urls.pull_m3u8 || urls.pull_flv || urls.pull
  if (!url) return { features: check.features, ok: false, detail: `${check.path} ${JSON.stringify(check.params)}：没取到拉流地址` }
  const result = await checkStreamUrl({ url, fetchImpl })
  return { features: check.features, ok: result.ok, detail: `${check.path} ${JSON.stringify(check.params)}：${result.detail}` }
}

// 把几个分支在内存里链式合并（git merge-tree --write-tree），返回合并结果的提交与冲突文件。
// 只生成无引用的临时对象（commit-tree 出的提交不挂任何分支，随 gc 回收），不动分支、不动工作区。
// 任一步失败（分支缺失、git 太旧、无共同祖先）返回 null，调用方回落到逐文件取较新提交。
export const mergeRefsTree = ({ root, refs, git = defaultGit }) => {
  const present = refs.filter((ref) => git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).ok)
  if (!present.length) return null
  let commit = git(root, ['rev-parse', `${present[0]}^{commit}`]).stdout.trim()
  const conflicts = new Set()
  for (const ref of present.slice(1)) {
    // 有冲突时退出码 1，首行仍是树 id，其后每行一个冲突文件（--name-only），冲突文件内容带 <<<<<<< 标记。
    const out = git(root, ['-c', 'core.quotepath=off', 'merge-tree', '--write-tree', '--name-only', '--no-messages', commit, ref])
    const lines = out.stdout.split('\n')
    const tree = lines[0].trim()
    if (!/^[0-9a-f]{40,64}$/.test(tree)) return null
    for (const line of lines.slice(1)) if (line.trim()) conflicts.add(line.trim())
    const made = git(root, ['commit-tree', tree, '-p', commit, '-p', ref, '-m', 'lark-bot 日报待对接文档视图（临时，无引用）'])
    if (!made.ok) return null
    commit = made.stdout.trim()
  }
  return { commit, conflicts, refs: present }
}

// 待对接文档的「最新视图」（aven 2026-10-14）：origin/pre、负责人工作分支、集成分支三处合并后的结果——
// 负责人手改在工作分支、bot 群任务回填在集成分支（推 pre 前）、清扫与推过的在 origin/pre，三处各改的行都要保留；
// 负责人忘了把本地分支合进 pre，日报也照样反映最新情况。只有某份文件真冲突，才回落到「取最后提交较新的那版」，
// 并记为 conflict（不把带冲突标记的内容写进视图）。只看已提交内容；结果写进 outDir 给模型只读。
export const buildDocsView = ({ root, refs, relDir, outDir, git = defaultGit, readBlob = null }) => {
  const show = readBlob || ((ref, path) => {
    const result = spawnSync('git', ['-C', root, 'show', `${ref}:${path}`], { maxBuffer: 32 * 1024 * 1024 })
    return result.status === 0 ? result.stdout : null
  })
  const listFiles = (ref) => {
    const listed = git(root, ['-c', 'core.quotepath=off', 'ls-tree', '-r', '--name-only', ref, '--', relDir])
    return listed.ok ? listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean) : []
  }
  const newest = (file) => refs
    .map((ref) => ({ ref, time: Number(git(root, ['log', '-1', '--format=%ct', ref, '--', file]).stdout?.trim() || 0) }))
    .filter((item) => item.time > 0)
    .sort((a, b) => b.time - a.time)[0] || null
  const merged = mergeRefsTree({ root, refs, git })
  const files = new Set(merged ? listFiles(merged.commit) : refs.flatMap(listFiles))
  if (merged) for (const file of merged.conflicts) if (file.startsWith(`${relDir}/`)) files.add(file)
  if (!files.size) return { dir: null, picked: [], merged: Boolean(merged) }
  rmSync(outDir, { recursive: true, force: true })
  const picked = []
  for (const file of [...files].sort()) {
    const conflict = Boolean(merged?.conflicts.has(file))
    const source = merged && !conflict ? { ref: merged.commit, label: 'merged' } : (() => {
      const hit = newest(file)
      return hit ? { ref: hit.ref, label: hit.ref } : null
    })()
    if (!source) continue
    const blob = show(source.ref, file)
    if (blob === null || blob === undefined) continue
    const target = join(outDir, file.slice(relDir.length).replace(/^\/+/, ''))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, blob)
    picked.push(conflict ? { file, ref: source.label, conflict: true } : { file, ref: source.label })
  }
  return { dir: outDir, picked, merged: Boolean(merged) }
}

export const collectDailyFacts = ({ profile, store, now = new Date(), git = defaultGit, readFile = (path) => readFileSync(path, 'utf8'), snapshotDir, checkout = null, probe = null, schemaExec = null, readBlob = null }) => {
  const root = profile.root
  const since = startOfDayIso(now)
  const report = profile.dailyReport
  const people = report?.people || {}
  const format = '--format=%h|%an|%ae|%s'
  const ref = report?.othersRef || 'origin/pre'
  const review = checkout || (report?.fetch === false ? { dir: root, note: '' } : prepareReviewCheckout({ profile, ref, git }))
  const fetchNote = review.note || ''
  if (!checkout) ensureReviewDeps({ dir: review.dir, root })
  // 所有人的工作（含 aven）只看 origin/pre 当天的提交。
  const others = git(root, ['log', ref, `--since=${since}`, format])
  const head = git(root, ['rev-parse', '--short', ref])
  // 功能总表（人维护）只作功能清单与负责人来源；状态以 pre 代码为准（aven 2026-10-14），总表与代码不符的行私信 aven 改。读本地最新版。
  const featureTablePath = report?.featureTable || null
  const table = featureTablePath ? readFileSafe(readFile, featureTablePath) : ''
  const rows = parseFeatureTable(table)
  const todayKey = localDateKey(now)
  // 「今日升级」基线只取早于今天的快照（aven 2026-10-20 review C15：当天重试 / 重发不拿当天第一次的快照当昨天）。
  const previousRows = loadBaselineSnapshot({ dir: snapshotDir, file: FEATURE_TABLE_SNAPSHOT, today: todayKey })?.rows || []
  const roadmap = report?.roadmap ? readFileSafe(readFile, inCheckout(review.dir, root, report.roadmap)) : ''
  // 任务时间是 UTC ISO，按本地日期比（aven 2026-10-20 review：原来拿 UTC 前 10 位比本地 todayKey，本地凌晨的任务进不了日报）。
  const botTasks = (store?.list?.() || []).filter((task) => (task.repo === profile.key || task.project === profile.projectKey) && localDateOf(task.updatedAt || task.createdAt) === todayKey)
  // 整改 #11：aven 本地工作分支领先 pre 的提交（已做未合），日报要单列，不能写成没做。
  const aheadLog = profile.baseRef ? git(root, ['log', `${ref}..${profile.baseRef}`, '--format=%h|%an|%ae|%s']) : { ok: false, stdout: '' }
  const localAhead = aheadLog.ok ? parseCommits(aheadLog.stdout) : []
  const integrationAhead = profile.integrationBranch && git(root, ['rev-parse', '--verify', '--quiet', profile.integrationBranch]).ok
    ? parseCommits(git(root, ['log', `${profile.baseRef}..${profile.integrationBranch}`, '--format=%h|%an|%ae|%s']).stdout || '')
    : []
  // 整改 #17：✅ 的功能用探针实测（功能 → 接口表在 dailyReport.featureChecks）。
  // 探针与 schema 校验都在 origin/pre 检出里跑（aven 2026-10-14：状态以 pre 真实代码为准）。
  const featureChecks = runFeatureChecks({ profile, checks: report?.featureChecks || [], probe, cwd: review.dir })
  const schemaChecks = runSchemaChecks({ profile, checks: report?.schemaChecks || [], cwd: review.dir, exec: schemaExec })
  // 模板 = 前一天的完整版（二、三节台账逐日延续）；没有就用配置的手写模板。
  const previousReport = findPreviousFullReport({ dir: snapshotDir, date: localDateKey(now) })
  const pendingRel = report?.pendingDir && report.pendingDir.startsWith(`${root}/`) ? report.pendingDir.slice(root.length + 1) : null
  const pendingView = pendingRel && snapshotDir
    ? buildDocsView({ root, refs: [ref, profile.baseRef, profile.integrationBranch].filter(Boolean), relDir: pendingRel, outDir: join(snapshotDir, 'pending-view'), git, readBlob })
    : null
  // 整改 #8：还挂着等负责人决定的疑似任务。
  const suspected = (store?.listSuspected?.() || []).filter((task) => task.repo === profile.key).map((task) => ({ id: task.id, summary: task.summary || task.id, since: task.parkedAt || task.updatedAt }))
  const ledger = loadLedger(profile.key)
  syncLedgerFromPending(profile, ledger)
  return {
    ledgerSummary: ledgerSummary(ledger, { max: 60 }),
    ownerClosures: loadOwnerClosures(snapshotDir),
    localAhead,
    integrationAhead,
    featureChecks,
    schemaChecks,
    previousReport,
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
      // 待对接文档：origin/pre、工作分支、集成分支三处合并后的视图（见 buildDocsView）；视图建不出来才回落本地目录。代码状态仍只认 pre。
      pendingDir: pendingView?.dir || report?.pendingDir || null,
      // 三处合并时真冲突、只能取较新那版的文件（另一边改的行可能没进视图）。
      pendingConflicts: (pendingView?.picked || []).filter((item) => item.conflict).map((item) => item.file),
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

const formatCommits = (commits, limit = 20) => commits.slice(0, limit).map((commit) => `  - ${commit.sha} ${commit.subject}`).join('\n') || '  （无）'

// 实测 / 本地领先 / 疑似：三段事实文案，短版和完整版提示共用。
const formatVerifiedChecks = (facts) => {
  if (!facts.featureChecks?.length) return ''
  const lines = facts.featureChecks.map((check) => `  - ${check.status}｜#${check.features.join('/#')} ${check.detail}`)
  return `pre 实测（日报前探针刚打的，只用来判断功能状态；pre 上没数据不是问题，不写进日报）：\n${lines.join('\n')}\n\n`
}
const formatLedger = (facts) => (facts.ledgerSummary ? `对接台账（条目｜标题｜状态｜最近事件；answered = 对方答了、前端还没做；applied = bot 已做；asked = 对方在等我方答）：\n${facts.ledgerSummary}\n\n` : '')
// 负责人拍板（owner-closures.json）：模型照写，脚本兜底强制。
const formatOwnerClosures = (facts) => {
  const { features = [], rows = [] } = facts.ownerClosures || {}
  if (!features.length && !rows.length) return ''
  const featureLines = features.map((item) => `  - 功能 #${item.no} 按 ${item.status}、pre ${item.pre} 写（${item.by || '负责人'} ${item.at} 确认${item.note ? `：${item.note}` : ''}）；高亮框、二 / 三节都不要再把它列成没做完`)
  const rowLines = rows.map((item) => `  - ${item.section ? `${item.section}节` : '二 / 三节'}「${item.key}」`)
  return `负责人拍板（权威，覆盖你按代码的判断，照写、不要质疑）：\n${featureLines.join('\n')}${featureLines.length && rowLines.length ? '\n' : ''}${rowLines.length ? `  - 以下台账行已关闭（负责人说都做完了）：不要再写进二 / 三节；也不要换个名字、或把它说明里的子项拆成新行补回（例如把「#2 收尾」的某一条单列、把「同步待对接文档」改叫「转发某某通知」）；从模板删掉时登记进 resolved：\n${rowLines.map((line) => `  ${line}`).join('\n')}` : ''}\n\n`
}
const formatSuspected = (facts) => (facts.suspected?.length ? `等 ${facts.me || '负责人'} 决定的疑似任务 ${facts.suspected.length} 条（日报末尾单列一行「等你决定的」）：\n${facts.suspected.slice(0, 8).map((task) => `  - ${task.summary}`).join('\n')}\n\n` : '')

const formatSchemaChecks = (facts) => {
  if (!facts.schemaChecks?.length) return ''
  return `pre 真实返回 × pre 代码里的前端 schema（不过 schema = 页面上会被丢掉，是真问题，写进 2.3）：\n${facts.schemaChecks.map((check) => `  - ${check.status}｜#${(check.features || []).join('/#')} ${check.detail}`).join('\n')}\n\n`
}
const formatStream = (facts) => (facts.streamCheck ? `直播拉流实测（真实去拉，不只看地址字段）：${facts.streamCheck.ok ? '能拉' : '拉不到'}｜#${facts.streamCheck.features.join('/#')} ${facts.streamCheck.detail}\n\n` : '')
const formatBuild = (facts) => {
  const build = facts.preBuild
  if (!build) return ''
  // 部署 / 复测不是问题（aven 2026-10-21）：只给构建时间供核对实测结果，不让模型写部署状态。
  return build.ok ? `pre 线上前端构建时间：${build.local}（部署由 aven 发邮件安排，不是问题，日报里不写部署 / 复测状态）。\n\n` : ''
}

// 短版：在完整版之后生成，数字全部来自脚本（与完整版同一组），模型只写「今天」一段，Bug 段脚本追加。
export const buildDailyReportPrompt = (facts, computed = {}) => {
  const otherLines = Object.entries(facts.others).map(([person, group]) =>
    `- ${person}：${group.commits.length} 个提交${group.merges ? `、${group.merges} 次合并` : ''}\n${formatCommits(group.commits)}`).join('\n') || '- （今天 ' + facts.othersRef + ' 没有任何新提交）'
  return `你是 ${facts.title} 项目的日报撰写者，写当天日报的**短版**（发项目群，给人 10 秒扫完）。数字和状态已经由脚本定好、和完整版一致，你只写下面三段的正文，不要再写标题和数字行。
写给产品 / 后端 / 前端同事看：说人话、不贴 sha、不贴文件路径、不贴内部状态名。

日期：${facts.date}
脚本定的数字（只能引用，不能改）：${computed.headline || '（无）'}

今天合入 ${facts.othersRef} 的提交（按人；只认 ${facts.othersRef}）：
${otherLines}
${formatBuild(facts)}${formatSuspected(facts)}今天的完整版（事实以它为准）：
<<<FULL
${String(computed.fullDoc || '（完整版没生成，按上面的提交写）').slice(0, 24_000)}
FULL

只输出下面一段 Markdown（没有内容就不写，不要写「无」），总共不超过 8 行。不写卡点、不写对接问题（项目已进测试，对接文档已发后端，aven 10-21）；不写谁没合 pre、本地已做未合 pre（合不合 pre 不是问题也不是待办，aven 10-21）；测试 Bug 段由脚本追加，你不要写：

## 今天
- **<人名>**：<做了什么，合并同类，≤ 40 字，不写编号、细节、文件>（每人一行，只写今天有提交或有动作的人；替别人推进的在括号里注明「替 henry」）

要求：只用二级标题、无序列表、加粗；不要表格、代码块、表情、链接。
${COMPLETION_RULE}
`.trim()
}

// 云文档完整版：模板 = 前一天的完整版（台账延续）；状态以 origin/pre 代码为准、覆盖所有负责人；末尾输出逐功能状态 JSON 供脚本校验与计数。
export const buildDailyDocPrompt = (facts, report) => {
  const otherLines = Object.entries(facts.others).map(([person, group]) =>
    `- ${person}：${group.commits.length} 个提交${group.merges ? `、${group.merges} 次合并` : ''}\n${formatCommits(group.commits)}`).join('\n') || `- （今天 ${facts.othersRef} 没有新提交）`
  const dateTag = facts.date.slice(5)
  const template = facts.previousReport?.path || facts.docPaths.docTemplate || report.docTemplate
  const nos = facts.table.rows.map((row) => row.no)
  return `你是 ${facts.title} 项目的日报撰写者。请写 **${facts.date} 的完整版日报（云文档）**。模板是上一版日报（${facts.previousReport ? `${facts.previousReport.date} 的完整版` : '负责人手写的交接报告'}）：
\`${template}\`
把它更新成「截至今天」的版本：结构、表格列照模板，详略按下面的「精简口径」（模板里写长了的今天压短）；**内容一行一行重新核对，不许把模板里的句子不经核对抄过来——每个负责人都一样**（aven 10-14：只更新 aven 的行、别人的行照抄，是低级失误）。

必须先读（只读，不改任何文件）：
1. 模板（上面路径）。
2. 功能总表：\`${facts.docPaths.featureTable}\`——只用它的功能清单（编号 / 名称 / 负责人 / 代码落点）。**它的状态列是人手维护的、经常落后，不作数。**
3. 待对接目录：\`${facts.docPaths.pendingDir || '（未配置）'}\`（各方卡点与编号 A5-2 / O10 / H1 的权威来源，是 origin/pre、负责人工作分支、集成分支三处合并后的最新版）。${facts.docPaths.pendingConflicts?.length ? `其中 ${facts.docPaths.pendingConflicts.join('、')} 三处合并有冲突，只取了最后提交较新的一版，另一边改的行可能没进来：这几份里的结论按「待确认」处理，并在三节加一行「待对接文档合并冲突：文件名（aven 手动合）」。` : ''}
4. 交付路线图：\`${facts.docPaths.roadmap}\`。

**所有状态以 ${facts.othersRef}（${facts.reviewHead}）的真实代码为准**（aven 10-14）：你的工作目录就是它的检出。每个功能都要打开它在这里的代码落点看：UI 有没有、数据层调的是真实接口还是 mock / MSW / 写死 / 失败回落假数据。本地分支、别人说做了但没合进 ${facts.othersRef} 的，一概按 ${facts.othersRef} 上的样子算。

脚本采集的当天事实（可信）：
- 今天合入 ${facts.othersRef} 的提交（按人）：
${otherLines}
${facts.fetchNote ? `- 注意：${facts.fetchNote}\n` : ''}- bot 今天处理过的任务：
${facts.botTasks.map((task) => `  - [${task.status}] ${task.summary || task.id}：${task.result}`).join('\n') || '  （无）'}
${formatBuild(facts)}${formatVerifiedChecks(facts)}${formatSchemaChecks(facts)}${formatStream(facts)}${formatLedger(facts)}${formatOwnerClosures(facts)}${formatSuspected(facts)}- 全项目接口缺口线索（脚本从 ${facts.othersRef} 检出采集，写一节「卡在哪」用；线索不等于结论，要逐条打开代码核对）：
${formatApiGapSources(facts.apiGapSources)}

状态口径（每个功能必须给一个，所有负责人一视同仁）：
- ✅ = ${facts.othersRef} 上 UI 已做、且生产路径调的是真实接口（没有 mock / MSW / 写死 / 回落假数据）。
- 🟠 = 接了真实接口但不完整，或接了但不通（报错 / 认不到 / 卡在后端）。
- 🟡 = UI 已做，数据仍是 mock / 写死。
- ❌ = ${facts.othersRef} 上没有 UI。
- — = 不是 web 的工作（如 #54）。

输出结构（Markdown + Lark 文档 XML 块，直接可建成云文档），从上到下：
1. 一级标题：\`# ${facts.title} 一期 · 日报（${facts.date}）\`。
2. 一行 \`## 总体进度：待脚本填\`（脚本按你给的状态算，你不要估数字）。
3. 高亮框引子，标签照模板原样：\`<callout emoji="📝" background-color="light-yellow" border-color="yellow">\` … \`</callout>\`，里面每个负责人一行 \`<p><b>名字：</b>…</p>\`，只写「负责 n 项，m 项 ✅」（n、m 必须和你末尾 JSON 里该负责人的数一致），有没完成的再接「；没完成的 #编号 卡在 <对接编号>（等谁）」，同一卡点的编号并在一起。不写今天做了什么、不写 pre 上看不到效果、不写「运维」「外部阻塞」行（对接问题不进日报，aven 10-21）。高亮框里只能有 \`<p>\`，文本里的 \`<\` \`>\` \`&\` 写成 \`&lt;\` \`&gt;\` \`&amp;\`。
4. 「## 一、功能进度总览（…）」：图例「✅ = ${facts.othersRef} 上写完且接了真实接口。没打勾的写明还剩什么、卡在哪、找谁。」；**全量表格**（列 # / 功能 / 负责人 / 状态 / 还剩什么 · 卡在哪 / 需要谁支持，合并行如 17–20 保留），状态列写 ✅ / ⬜ / —（脚本会按 JSON 再回写一遍）。「还剩什么 · 卡在哪」「需要谁支持」只写卡点（还差什么、等谁、对接编号）：✅ 的行两列都写 \`--\`（脚本也会回写）；没打勾的行不写做了什么、改了什么、实测结果（「${dateTag}：侧栏改读标签字典」「日报前实测 20 条、过 schema」都不要），没有卡点也写 \`--\`。表后只写一行 \`**计数**\`（脚本生成具体数字和「- 名字 n 项：#…」列表，你不要写）。
5. 「## 二、测试 Bug」由脚本按 bug 表生成：你不要写二节，也不要在任何地方列对接问题（缺接口、缺数据、接口有问题都在对接文档里，已发后端，aven 10-21）。
6. 「## 三、需要再跟进的工作」——**台账**：模板里每一行逐条核对，已经解决的整行删掉，并在末尾 JSON 的 resolved 里登记（key = 那一行第一列的原文，evidence = 依据：哪个提交 / 实测结果）；没解决的第一列原样保留，其它列更新成今天的事实；**每个负责人的事项都要核对**（例如别人已经在 ${facts.othersRef} 上做掉的改名、开关、接口，就删）。表头固定为 \`| 事项 | 说明 | 负责人 |\`，**按负责人分组排**：aven 的在最前，其余负责人各自相邻，外部方（后端 / 运维 / 产品）在最后。挂了多天、其实不依赖任何人就能定的「待确认」，要么定下来删掉，要么写清在等谁。
   三节的目标是清零：只留真的还没解决的。

最后，在文档末尾**另起一段**输出逐功能状态 JSON（脚本会剥掉，不会进文档）：
${STATUS_OPEN}
{"features":[{"no":1,"status":"🟡","evidence":"modules/user/data/queries.ts 仍走 mock"},{"no":5,"status":"✅","evidence":"…","change":"今天 abc123 接了真实接口"}, …],"resolved":[{"section":"三","key":"<模板里该行第一列原文>","evidence":"<依据>"}]}
${STATUS_CLOSE}
- features 必须覆盖总表全部 ${nos.length} 个功能（#${nos.join(' #')}），每个都要有 evidence（${facts.othersRef} 上的代码落点 / 提交 / 实测）。
${facts.previousStatuses ? `- 上一版的状态：${nos.map((no) => `#${no} ${facts.previousStatuses[String(no)]?.status || '?'}`).join(' ')}。和它不同的必须填 change（今天的新依据：新提交 / 今天的实测结果）；没有新依据就沿用上一版，不要重新判（脚本会把没给 change 的改回上一版）。
` : ''}- 只有今天删掉的行才进 resolved；没删的不进。

写法要求：
${COMPLETION_RULE}
- 不确定的写「待确认」并写清缺什么，不要编。
- 精简口径（aven 10-21）：每件事全文只写一处。外部方（后端 / 运维 / 产品 / 运营）要做或要答的事不进日报（对接文档已发，后端看文档）；三节只留前端负责人自己要动手的事，不列「Go 后端待答」「运维配置」这类外部方汇总行（产品待答的都留在「产品：一期全项目问题 P1–P12」这一行，不另起新行）。三节不轻易加新行：只有今天新出现、前端负责人要自己动手的事才加。表格单元格 ≤ 60 字：不写时间段、房间号清单、请求细节，写「见对接文档 <编号>」。
- 没测的先测完再写（aven 10-21）：要写「没测 / 没验 / 待确认能不能用」之前，先用 \`node scripts/pre-probe.mjs '[["/api/…",{参数}]]'\` 在 pre 上测（只读，已登录测试号），按结果写；探针测不了的（要浏览器、要特定数据）这一项就不写，不写「没测」。
- 走查、部署、复测都不是问题（aven 10-20 / 10-21）：不算没完成、不算卡点，不进任何表和列表；日报里不写「走查」「还没部署 / 待发邮件部署」「还没复测 / 部署版没验」「pre 上看不到效果 / pre 未验证」这类话（脚本也会删）；上面完成口径里「pre 未验证 / 待回归」的写法在日报里不适用。
- 不要代码块（末尾 JSON 段除外）、不要表情（状态符号和高亮框 emoji 除外）、不要写 bot / 任务 id / 内部状态名。
- **只输出文档正文 + 末尾 JSON 段**：不要在前后附加说明。`
}

// 用 claude 只读整理（cwd 在业务仓，可自行翻文档核对）。返回纯文本。默认 plan 模式、只给 Read/Grep；
// 给了 probeCommand（完整版用，aven 2026-10-21「没测就先测完」）时多开 Bash，但只放行这一条只读探针命令，写开关由 env 锁死。
export const generateDailyReportText = ({ prompt, profile, model, effort, timeoutMs = 10 * 60_000, spawnImpl = spawn, cwd = null, probeCommand = null, env = null }) =>
  new Promise((resolve, reject) => {
    const args = [
      '-p',
      ...(probeCommand ? ['--tools', 'Read,Grep,Glob,Bash', '--allowedTools', `Bash(${probeCommand}:*)`] : ['--permission-mode', 'plan', '--tools', 'Read,Grep,Glob']),
      ...(model ? ['--model', model] : []),
      ...(effort ? ['--effort', effort] : []),
      '--no-session-persistence',
      '--output-format', 'text',
      prompt,
    ]
    // claude 路径同执行器（LARK_CLAUDE_BIN 覆盖、测试里起不来真 claude，10-25）。
    const child = spawnImpl(resolveClaudeBinary(), args, { cwd: cwd || profile.root, stdio: ['ignore', 'pipe', 'pipe'], ...(env ? { env } : {}) })
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

// 用用户身份把 Markdown 建成 Lark 云文档，返回 { ok, url, documentId, reason }。
// 完整版后处理：剥 JSON → 校验 → 按代码状态算进度 / 计数 → 回写状态列 → 台账比对。纯函数，便于单测。
export const finalizeFullReport = ({ fullText, facts, previousText = '' }) => {
  const rows = facts.table.rows
  const split = splitStatusBlock(fullText)
  const problems = []
  if (split.error) problems.push(split.error)
  const validated = validateStatusData(split.data || {}, rows)
  problems.push(...validated.errors)
  // JSON 缺的功能回落总表状态（并在私信里点名），保证计数不缺项。
  const statuses = new Map(validated.statuses)
  for (const row of rows) if (!statuses.has(row.no)) statuses.set(row.no, { no: row.no, status: row.no === 54 ? '—' : row.status, pre: '未验证', reason: '', evidence: '（JSON 缺，回落总表）' })
  const kept = keepUnchangedStatuses(statuses, facts.previousStatuses)
  if (kept.length) problems.push(`这些功能今天判的状态和昨天不同但没给新依据，按昨天算：${kept.map((item) => `#${item.no}（今天 ${item.today} → 沿用 ${item.kept}）`).join('、')}`)
  // 负责人拍板优先于模型判断：功能状态覆盖、台账行删除（删除记为有依据）。
  applyFeatureClosures(statuses, facts.ownerClosures)
  // 走查不是任务（aven 2026-10-20）：今天的和昨天的一起剥，免得删掉的走查行被当成「没给依据就消失」。
  previousText = stripNonIssues(previousText)
  const body = replaceSection(stripCalloutExtras(stripNonIssues(split.doc)), '## 二、', ['## 二、测试 Bug', '', ...(facts.bugLines || ['- --'])])
  const closed = applyLedgerClosures({ markdown: body, previous: previousText, closures: facts.ownerClosures })
  closed.doc = fillEmptyTables(closed.doc)
  const progress = computeProgress({ rows, statuses })
  let doc = applyStatusColumn(closed.doc, statuses)
  doc = applyProgress(doc, progress)
  doc = pruneCalloutDone(applyCalloutCounts(doc, progress), statuses)
  const ledger = previousText ? diffLedger({ previous: previousText, current: doc, resolved: [...validated.resolved, ...closed.resolved] }) : null
  if (ledger) doc = annotateLedgerHeadings(doc, ledger)
  problems.push(...checkCalloutCounts(doc, progress), ...checkVerbose(doc))
  return { doc, statuses, progress, ledger, problems, mismatches: tableMismatches(rows, statuses) }
}

// 私信 aven 的核对单：校验问题、无依据消失的台账行、总表与 pre 代码不符的行。没有就不发。
export const buildReviewNote = ({ date, problems = [], ledger = null, mismatches = [] }) => {
  const lines = []
  if (problems.length) lines.push(`**日报校验**：\n${problems.map((item) => `- ${item}`).join('\n')}`)
  const lost = (ledger || []).flatMap((section) => section.unexplained.map((key) => `- ${section.name}节：${key}`))
  if (lost.length) lines.push(`**昨天还在、今天没了、也没给依据的行**（请确认是否真解决，没解决明天会补回）：\n${lost.join('\n')}`)
  const done = (ledger || []).flatMap((section) => section.resolved.map((item) => `- ${section.name}节：${item.key}——${item.evidence || '（无依据）'}`))
  if (done.length) lines.push(`**今天删掉的行**：\n${done.join('\n')}`)
  const added = (ledger || []).filter((section) => section.name === '三').flatMap((section) => (section.added || []).map((key) => `- ${key}`))
  if (added.length) lines.push(`**三节今天新加的行**（不该有的告诉 Claude 记进拍板关闭 owner-closures.json）：\n${added.join('\n')}`)
  if (mismatches.length) lines.push(`**功能总表要改的状态**（日报已按 pre 代码写）：\n${mismatches.map((item) => `- #${item.no} ${item.feature}（${item.owner}）：总表 ${item.table} → pre 代码 ${item.code}${item.evidence ? `（${item.evidence.slice(0, 80)}）` : ''}`).join('\n')}`)
  return lines.length ? `日报核对 ${date}\n\n${lines.join('\n\n')}` : ''
}

// deliveryMode（aven 2026-10-20 review C15）：'resume' = 自动重试，已发的不再发、已建的云文档复用；'fresh' = 群里「重发日报」，
// 当天记账清零从头发；null = 手动脚本，不读不写记账。见 lib/lark-daily-delivery.mjs。
export const runDailyReport = async ({ config, store, profile, now = new Date(), deliveryMode = null, deps = {} }) => {
  const report = profile.dailyReport
  if (!report) return { ok: false, reason: 'profile 未配置 dailyReport' }
  // 没配发群目标就只发私信目标；私信目标也没有就直接不发（aven 2026-10-20 review：不再回落 profile.chatIds[0] 外部群），生成前就停。
  const targets = deps.privateOnly ? [] : resolveSendTargets({ profile, report })
  const privateTo = targets.length ? null : deps.privateTo || report.to || profile.notifyChatId || null
  if (!targets.length && !privateTo) {
    console.error(`[lark-gateway] 日报 ${profile.key} 没有发送目标（sendTo 空、dailyReport.to / notifyChatId 都没配），不发、不回落外部群`)
    return { ok: false, reason: '没有发送目标（dailyReport.to / notifyChatId 都没配），不回落外部群' }
  }
  const reportDir = join(deps.runtimeDir || larkRuntimeDir, 'lark-daily-report', profile.key)
  mkdirSync(reportDir, { recursive: true })
  const facts = (deps.collectFacts || collectDailyFacts)({ profile, store, now, snapshotDir: reportDir })
  const date = facts.date
  // 昨天（早于今天的最近一次）的逐功能状态：完整版判状态时对照，变了要给新依据。
  facts.previousStatuses ??= loadBaselineSnapshot({ dir: reportDir, file: CODE_STATUS_SNAPSHOT, today: date })?.statuses || null
  const delivery = openDailyDelivery({ dir: reportDir, date, mode: deliveryMode })
  const generate = deps.generateText || generateDailyReportText
  // 脚本实测（模型没网络）：pre 线上构建时间、直播拉流。
  if (report.siteUrl && !facts.preBuild) {
    const build = await (deps.fetchSiteBuildTime || fetchSiteBuildTime)({ siteUrl: report.siteUrl })
    facts.preBuild = build.ok ? { ...build, local: new Date(build.ms).toLocaleString('zh-CN', { hour12: false }) } : build
  }
  // 测试 Bug 段（aven 2026-10-21）：脚本读 bug 表算数字，完整版二节与群简报共用；读不到照发、私信说明。
  const bugs = report.bugTable ? await (deps.fetchBugRecords || fetchBugRecords)({ table: report.bugTable }) : null
  facts.bugLines = bugs?.ok ? renderBugLines(summarizeBugs({ records: bugs.records, date })) : null
  if (report.streamCheck && facts.streamCheck === undefined) facts.streamCheck = await (deps.runStreamCheck || runStreamCheck)({ profile, cwd: facts.reviewDir })

  // 1) 完整版（状态 / 计数 / 台账的唯一来源）。重试且当天已建过云文档：复用那次的原文与文档，不再跑模型、不再新建公开文档。
  let doc = null
  let final = null
  const fullName = `${(profile.title || profile.key).replace(/[\\/:*?"<>|\s]/g, '')}日报-${date}-完整版.md`
  const known = delivery.doc()
  if (report.docTemplate || facts.previousReport) {
    try {
      const rawPath = join(reportDir, `${fullName}.raw`)
      const reuse = Boolean(known?.url) && existsSync(rawPath)
      const fullText = reuse ? readFileSync(rawPath, 'utf8') : await generate({ prompt: buildDailyDocPrompt(facts, report), profile, model: report.model || profile.claudeModel, effort: report.docEffort || report.effort || 'medium', timeoutMs: 25 * 60_000, cwd: facts.reviewDir, probeCommand: profile.verify?.probeCommand || null, env: { ...process.env, PROBE_ALLOW_WRITE: '0', ...(report.probeMail ? { PROBE_MAIL: report.probeMail } : {}) } })
      if (fullText) {
        if (!reuse) writeFileSync(rawPath, fullText, { mode: 0o600 })
        const previousText = facts.previousReport ? readFileSafe((path) => readFileSync(path, 'utf8'), facts.previousReport.path) : ''
        final = finalizeFullReport({ fullText, facts, previousText })
        writeFileSync(join(reportDir, fullName), `${final.doc}\n`, { mode: 0o600 })
        doc = { url: known?.url || null, documentId: known?.documentId || null, path: join(reportDir, fullName) }
        const created = known?.url ? null : await (deps.createLarkDoc || createLarkDocFromMarkdown)({ title: `${profile.title || profile.key} 一期 · 日报（${date}）`, dir: reportDir, file: fullName })
        if (created?.ok) {
          doc = { ...doc, url: created.url, documentId: created.documentId }
          delivery.setDoc({ url: created.url, documentId: created.documentId })
        } else if (created) console.error(`[lark-gateway] 日报云文档创建失败：${created.reason}`)
      }
    } catch (error) {
      console.error(`[lark-gateway] 日报云文档生成异常：${String(error?.message || error).slice(0, 200)}`)
    }
  }
  // 没有完整版时，计数回落总表（并在私信里说明）。
  if (!final) {
    const statuses = new Map(facts.table.rows.map((row) => [row.no, { no: row.no, status: row.no === 54 ? '—' : row.status, pre: '未验证', reason: '' }]))
    final = { doc: '', statuses, progress: computeProgress({ rows: facts.table.rows, statuses }), ledger: null, problems: ['完整版没生成，短版数字回落功能总表'], mismatches: [] }
  }
  if (bugs && !bugs.ok) final.problems.push(`Bug 段没出来：${bugs.reason}`)

  // 2) 短版：数字行由脚本定，正文由模型从完整版摘。「今日 +N」基线只取早于今天的快照（C15）。
  const previousCode = loadBaselineSnapshot({ dir: reportDir, file: CODE_STATUS_SNAPSHOT, today: date })
  const gained = previousCode?.done === undefined ? null : final.progress.done - previousCode.done
  const headline = buildHeadline({ progress: final.progress, gained })
  const body = await generate({ prompt: buildDailyReportPrompt(facts, { headline, fullDoc: final.doc }), profile, model: report.model || profile.claudeModel, effort: report.effort || 'medium', cwd: facts.reviewDir })
  if (!body) return { ok: false, reason: '模型未产出日报正文' }
  // 模型照旧写了「卡点」段也剥掉（aven 10-21：测试阶段不列对接问题）。
  const shortBody = replaceSection(replaceSection(stripNonIssues(body.replace(/^#\s.*\n+/, '').replace(/^.*已接通.*\n+/m, '')), '## 卡点', []), '## 今天没合 pre', []).trim()
  let text = `# ${facts.title} 日报 ${date}\n\n${headline}\n\n${shortBody}${facts.bugLines ? `\n\n## 测试 Bug\n${facts.bugLines.join('\n')}` : ''}`
  if (doc?.url) text = `${text}\n\n完整版（云文档）：${doc.url}`
  writeFileSync(join(reportDir, `${date}.md`), `${text}\n\n---\n<!-- facts -->\n${JSON.stringify(facts, null, 2)}\n`, { mode: 0o600 })
  // 快照发出去之后才落（C15）：至少一处收到了今天的数字，才把它记成今天的。
  const saveSnapshots = () => {
    recordDailySnapshot({ dir: reportDir, file: FEATURE_TABLE_SNAPSHOT, date, payload: { rows: facts.table.rows } })
    recordDailySnapshot({ dir: reportDir, file: CODE_STATUS_SNAPSHOT, date, payload: { done: final.progress.done, percent: final.progress.percent, statuses: Object.fromEntries(final.statuses) } })
  }

  // 3) 私信 aven 的核对单（不进群）；重试时已发过的不再发。
  const note = buildReviewNote({ date, problems: final.problems, ledger: final.ledger, mismatches: final.mismatches })
  const owner = report.to || profile.notifyChatId
  if (note && owner && !delivery.isSent(`review:${owner}`)) {
    const sentNote = await (deps.sendUserMarkdown || sendBotMarkdown)({ chatId: owner, markdown: note }).catch(() => null)
    if (sentNote?.ok) delivery.mark(`review:${owner}`)
  }

  // 4) 投递（aven 2026-10-13 定）：外部群只能走各群自定义机器人 webhook；配了 sendTo 且该群有 webhook → 卡片；没配 → 私聊负责人。
  const fileName = `${(profile.title || profile.key).replace(/[\\/:*?"<>|\s]/g, '')}日报-${date}.md`
  const filePath = join(reportDir, fileName)
  writeFileSync(filePath, `${text}\n`, { mode: 0o600 })
  const extra = { progress: final.progress, review: note || null }
  if (targets.length) {
    const outcomes = await sendDailyToGroups({ profile, targets, text, delivery, sendHook: deps.sendWebhookMessage })
    const ok = outcomes.every((item) => item.ok)
    if (outcomes.some((item) => item.ok)) saveSnapshots()
    if (!ok) console.error(`[lark-gateway] 日报群发失败：${outcomes.filter((item) => !item.ok).map((item) => `${item.chatId}: ${item.reason}`).join('；')}`)
    return { ok, reason: ok ? null : 'group send failed', date, to: targets.join(','), text, reportPath: filePath, outcomes, doc, ...extra }
  }
  const to = privateTo
  if (delivery.isSent(`private:${to}`)) {
    saveSnapshots()
    return { ok: true, reason: null, skipped: 'already sent', date, to, text, reportPath: filePath, doc, ...extra }
  }
  // 私信版末尾加一行 bot 自检（自愈环 3）：群发版不加。取不到就不加，不让自检拖垮日报。
  let selfCheck = null
  try {
    selfCheck = deps.selfCheckLine === false ? null : (deps.selfCheckLine || (await import('./lark-doctor.mjs')).buildDailySelfCheckLine)()
  } catch {
    selfCheck = null
  }
  const sent = await (deps.sendUserMarkdown || sendBotMarkdown)({ chatId: to, markdown: selfCheck ? `${text}\n\n${selfCheck}` : text })
  if (sent.ok) {
    delivery.mark(`private:${to}`)
    saveSnapshots()
  }
  return { ok: sent.ok, reason: sent.reason, date, to, text, reportPath: filePath, doc, ...extra }
}
