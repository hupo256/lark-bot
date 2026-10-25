/**
 * 自修工单执行器（从 falive 的「自修工单走任务队列」改成独立执行器，aven 2026-10-24）：fameex 没有多仓 profile，
 * 不能给 lark-bot 自己开一条网关任务，所以 worker 主循环在**没有在飞任务**时一次最多跑一张 pending 工单
 *（跑的时候不领新任务；排空重启把它算一个在飞，不会在自修中途重启）。
 *
 * 一张工单：lark-bot 本仓开临时 worktree（分支 lark/self-fix-<指纹短>-<日期>，基于开单时的 HEAD = 出错的那版代码）
 * → claude 实施模式（cwd = 临时 worktree，40 分钟）查根因、harness / prompt 层才改代码
 * → worker 机械验收，不信 AI 自报：改动只能在 lib/ scripts/ __tests__/ docs/；`node scripts/test-all.mjs` 全绿；
 *   `node scripts/mutate.mjs --diff <开单时 HEAD> --lanes 1` 存活 0
 * → 全过：本地提交（不 push），工单 ready，私信负责人「lark-bot self-fix apply <id>」；否则 rejected，删现场和分支。
 * env / external / model 层只报不改（reported）。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { execAiExecutor } from './lark-ai-executor.mjs'
import { runCommand } from './lark-drain-restart.mjs'
import { failuresDir } from './lark-failure-ledger.mjs'
import { larkBotRoot } from './lark-paths.mjs'
import { listTickets, selfFixDir, selfFixWorktreePath, updateTicket } from './lark-self-fix.mjs'

export const SELF_FIX_TIMEOUT_MS = 40 * 60_000
export const SELF_FIX_ALLOWED_DIRS = ['lib/', 'scripts/', '__tests__/', 'docs/']
export const SELF_FIX_LESSONS_DOC = 'docs/self-fix-log.md'
// 被中断（worker 重启 / 崩溃）的工单最多再跑一次，避免一张会把 worker 搞崩的工单无限重来。
export const SELF_FIX_MAX_ATTEMPTS = 2
const FIXABLE_LAYERS = new Set(['harness', 'prompt'])
const DONE_STATUSES = new Set(['done', 'done_with_warnings'])
const TESTS_TIMEOUT_MS = 10 * 60_000
const MUTATE_TIMEOUT_MS = 30 * 60_000
// 验收时的全量单测不卡 18 秒预算：worker 机器忙时变慢不该让一张对的工单作废（与排空重启自检同一口径）。
const TESTS_BUDGET_MS = 120_000

export const SELF_FIX_STATUS_LABELS = {
  pending: '待执行',
  running: '执行中',
  ready: '验收通过，等 apply',
  rejected: '验收不过，已作废',
  reported: '只报不改',
  failed: '执行出错',
  applied: '已合进运行分支',
  discarded: '已丢弃',
}
const LAYER_LABELS = { harness: 'bot 自己的代码', prompt: '提示词口径', env: '本机环境', model: '模型判断错', external: '外部服务' }

const short = (value, max = 160) => String(value?.message || value || '').slice(0, max)
const git = (cwd, args) => spawnSync('git', ['-C', cwd, '-c', 'core.quotepath=off', ...args], { encoding: 'utf8' })

export const parseRootCauseLayer = (summary) =>
  String(summary || '').match(/^\s*\[(harness|prompt|env|model|external)\]/i)?.[1].toLowerCase() || null

export const outsideAllowedDirs = (files = []) => files.filter((file) => !SELF_FIX_ALLOWED_DIRS.some((prefix) => file.startsWith(prefix)))

// ── 提示词 ───────────────────────────────────────────────

export const buildSelfFixPrompt = (ticket, { root = larkBotRoot, ledgerDir = failuresDir } = {}) => {
  const fp = ticket.fingerprint || {}
  const attempts = ticket.priorAttempts || 0
  return [
    `修复：lark-bot 自身缺陷——${fp.label}（指纹 ${fp.fingerprint}）`,
    '',
    `这是 lark-bot 的自修工单 ${ticket.id}。你在 lark-bot 本仓的临时 worktree 里（当前目录 ${ticket.worktreePath}，分支 ${ticket.branch}，基于出错那版代码 ${String(ticket.baseHead).slice(0, 8)}）。`,
    `触发：${ticket.trigger}。原任务 ${ticket.task?.id}（第 ${(ticket.task?.epoch || 0) + 1} 代）失败，worker 层错误原文：`,
    '```',
    String(ticket.error || '').slice(0, 1200),
    '```',
    `失败类别：${fp.cls}；7 天内同指纹 ${(ticket.recentSameFingerprint || 0) + 1} 次；自动重排队 ${attempts} 次${attempts ? '仍失败' : ''}。`,
    `原任务正文（前 400 字）：${String(ticket.task?.text || '').replace(/\n+/g, ' ')}`,
    '',
    '可读的证据（绝对路径，只读）：',
    ticket.auditJsonPath ? `- 原任务审计 JSON：${ticket.auditJsonPath}` : null,
    ticket.auditLogPath ? `- 原任务审计事件流：${ticket.auditLogPath}（stream-json，看最后几个 tool_use / result 事件）` : null,
    ticket.workerLogPath ? `- worker.log：${ticket.workerLogPath}` : null,
    `- 失败台账：${ledgerDir}`,
    `- 以往自修教训：${SELF_FIX_LESSONS_DOC}；自愈移植记录与开关：docs/port-from-falive-2026-10-24.md`,
    '',
    '先定根因层，写进结果 summary 开头：`[harness]` bot 自己的代码 / `[prompt]` 提示词口径 / `[env]` 本机环境（CLI、规则文件、凭据、配置）/ `[model]` 模型判断错 / `[external]` 外部服务（Lark、AI 接口、网关）。',
    `只有 harness / prompt 且有把握才改代码：只改 lib/ scripts/ __tests__/ docs/ 下的文件，补或改单测让这个错有回归保护，在 ${SELF_FIX_LESSONS_DOC} 表末追加一行（日期 · 工单 · 现象 · 根因层 · 落在哪 · 怎么验）。没把握就不改，status 用 blocked，blockers 写还缺什么证据。`,
    'env / external / model：不改任何文件，status 用 blocked，blockers 写明要人做什么（装什么、改哪个配置、哪条规则候选）。',
    `自检：改过的 .mjs 先 \`node --check\`；\`node scripts/test-affected.mjs --base ${ticket.baseHead}\` 跑相关测试；最后 \`node scripts/test-all.mjs\` 全绿、\`node scripts/mutate.mjs --diff ${ticket.baseHead} --lanes 1\` 存活 0（存活就补测，确属等价的登记 scripts/mutation-accepted.json 写原因；新文件先 \`git add\`，变异只看已跟踪文件）。worker 会自己重跑这两项和改动范围检查，任一不过整单作废。`,
    `硬边界：不碰 runtime/（配置、凭据、任务、审计、状态，包括 ${root}/runtime）；不改 fameex-web；不改 rules/；不 git commit（worker 验收过才替你提交）、不 push、不 restart、不切分支。`,
    '',
    '完成后的结果 JSON：status（done / done_with_warnings / blocked / failed）、summary（以 [根因层] 开头，一两句：现象 · 根因 · 改了什么）、checks（跑过的命令与结果）、changedFiles、warnings、blockers（blocked 时必填）；taskState / rootCauseLayer / evidence / owner / failureKind / nextStep 填 null（根因层只写在 summary 开头）。',
    ticket.workerLogTail ? `\n开单时 worker.log 尾部：\n\`\`\`\n${ticket.workerLogTail}\n\`\`\`` : null,
  ]
    .filter((line) => line != null)
    .join('\n')
}

// ── 孤儿执行器 ───────────────────────────────────────────

// 全部进程的 pid / 进程组 / 完整命令行（-ww 不截断：提示词在命令行末尾）。
export const listProcesses = () =>
  spawnSync('ps', ['-A', '-ww', '-o', 'pid=,pgid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout
    .split('\n')
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map(([, pid, pgid, command]) => ({ pid: Number(pid), pgid: Number(pgid), command }))

/**
 * 上个 worker 被 SIGKILL（优雅退出没机会 abort）时还在跑的自修执行器：claude 起时 detached，pid 即进程组号，
 * 连它的 Bash 工具孙进程一起杀（10-24 沙箱试跑：recover 只删现场不杀进程，claude 成孤儿接着跑）。
 * 防 pid 复用误杀：进程组里要有命令行含工单 worktree 路径的进程（提示词里带「当前目录 <worktree>」）才杀。返回是否杀了。
 */
export const killOrphanExec = ({ pid, worktreePath, ps = listProcesses, kill = process.kill }) => {
  if (!Number.isInteger(pid) || pid <= 1 || !worktreePath) return false
  if (!ps().some((proc) => proc.pgid === pid && proc.command.includes(worktreePath))) return false
  try {
    kill(-pid, 'SIGKILL')
    return true
  } catch {
    return false
  }
}

// ── git 现场 ─────────────────────────────────────────────

// 删现场：worktree 目录 + 登记 + 分支（branch 传 null 只删 worktree）。都是尽力而为，不抛。
export const removeSelfFixWorktree = ({ root = larkBotRoot, path, branch = null }) => {
  if (existsSync(path)) git(root, ['worktree', 'remove', '--force', path])
  rmSync(path, { recursive: true, force: true })
  git(root, ['worktree', 'prune'])
  if (branch) git(root, ['branch', '-D', branch])
}

export const prepareSelfFixWorktree = ({ root = larkBotRoot, path, branch, base }) => {
  removeSelfFixWorktree({ root, path, branch }) // 上次中断留下的现场先清掉
  const res = git(root, ['worktree', 'add', '-b', branch, path, base])
  if (res.status !== 0) throw new Error(`建自修 worktree 失败：${short(res.stderr, 200).trim()}`)
}

// 相对开单 HEAD 的全部改动（含 AI 自己提交的、未提交的、新文件）。先 git add -A：新文件纳入跟踪，
// git diff <base> 与变异测试（只看已跟踪文件）才看得到它们。
export const listChangedFiles = ({ cwd, base }) => {
  git(cwd, ['add', '-A'])
  return git(cwd, ['diff', '--name-only', base]).stdout.split('\n').filter(Boolean)
}

export const commitSelfFix = ({ cwd, id, summary, mutate = null }) => {
  git(cwd, ['add', '-A'])
  const pending = git(cwd, ['diff', '--cached', '--name-only']).stdout.trim()
  if (pending) {
    const title = String(summary || '').split('\n')[0].slice(0, 100)
    // 改动行一个可变异点都没有时变异闸只是「没东西可查」，不能写成「变异存活 0」（10-24 沙箱试跑发现）。
    const mutateNote = mutate?.checked ? '变异存活 0' : '改动行没有可变异的运算符，未做变异检查'
    const res = git(cwd, ['commit', '-q', '-m', `fix(self-fix): ${title}（自修工单 ${id}，worker 验收：全量单测绿、${mutateNote}）`])
    if (res.status !== 0) return { ok: false, error: short(res.stderr || res.stdout, 200).trim() }
  }
  return { ok: true, sha: git(cwd, ['rev-parse', 'HEAD']).stdout.trim() }
}

// ── 验收 ─────────────────────────────────────────────────

// 异步子进程（超时 / abort 杀进程组）：与排空自检共用一份，定义在 lark-drain-restart。
export { runCommand }

const summaryLine = (tail, re, fallback) => String(tail).match(re)?.[0] || fallback

export const defaultRunTests = async ({ cwd, signal }) => {
  const run = await runCommand({ args: ['scripts/test-all.mjs', '--budget-ms', String(TESTS_BUDGET_MS)], cwd, timeoutMs: TESTS_TIMEOUT_MS, signal })
  const failing = run.tail.split('\n').filter((line) => /^\s*✖/.test(line)).slice(0, 3)
  const head = summaryLine(run.tail, /^测试 \d+ 个.*$/m, run.timedOut ? '超时' : `exit ${run.code}`)
  return { ok: run.ok, summary: failing.length ? `${head}；红：${failing.map((line) => line.trim()).join(' / ')}` : head }
}

// checked：真跑了变异（有变异点）。改动行没有可变异的运算符时 mutate 照样退出 0，但那是「未做变异检查」，
// 私信 / 提交说明要如实写，不能写成「变异存活 0」（10-24 沙箱试跑发现）。
export const defaultRunMutate = async ({ cwd, base, signal }) => {
  const run = await runCommand({ args: ['scripts/mutate.mjs', '--diff', base, '--lanes', '1'], cwd, timeoutMs: MUTATE_TIMEOUT_MS, signal })
  const survivors = run.tail.split('\n').filter((line) => /^\s+存活 /.test(line)).slice(0, 3)
  const stats = run.tail.match(/^变异 (\d+) 个：抓到 (\d+)，豁免 (\d+)，存活 (\d+)/m)
  if (!stats) {
    const nothing = run.ok && /^没有可变异的改动行$/m.test(run.tail)
    return { ok: run.ok, checked: false, summary: nothing ? '改动行没有可变异的运算符（未做变异检查）' : run.timedOut ? '超时' : `exit ${run.code}` }
  }
  const [, sites, killed, accepted, survived] = stats
  const head = `变异存活 ${survived}（${sites} 个变异点：抓到 ${killed}，豁免 ${accepted}）`
  return { ok: run.ok, checked: true, summary: survivors.length ? `${head}；${survivors.map((line) => line.trim()).join(' / ')}` : head }
}

/** 机械验收：改动范围 → 全量单测 → 变异。返回 { ok, stage, reason, changedFiles, tests, mutate }。 */
export const verifySelfFix = async ({ cwd, base, changedFiles, runTests = defaultRunTests, runMutate = defaultRunMutate, signal = null }) => {
  const outside = outsideAllowedDirs(changedFiles)
  if (outside.length) return { ok: false, stage: 'scope', reason: `改了允许范围外的文件：${outside.slice(0, 5).join('、')}`, changedFiles }
  const tests = await runTests({ cwd, signal })
  if (!tests.ok) return { ok: false, stage: 'tests', reason: `全量单测没过：${tests.summary}`, changedFiles, tests }
  const mutate = await runMutate({ cwd, base, signal })
  if (!mutate.ok) return { ok: false, stage: 'mutate', reason: `变异测试没过：${mutate.summary}`, changedFiles, tests, mutate }
  return { ok: true, stage: 'done', reason: '', changedFiles, tests, mutate }
}

// ── 交付消息 ─────────────────────────────────────────────

export const buildSelfFixReport = (ticket) => {
  const fp = ticket.fingerprint || {}
  const layer = ticket.layer ? `${ticket.layer}（${LAYER_LABELS[ticket.layer]}）` : '未标'
  const lines = [
    `lark-bot 自修工单 ${ticket.id}：${SELF_FIX_STATUS_LABELS[ticket.status] || ticket.status}`,
    `现象：${fp.label}（指纹 ${fp.fingerprint}；${ticket.trigger}），原任务 ${ticket.task?.id}`,
  ]
  if (ticket.ai?.summary) lines.push(`根因层：${layer}。${ticket.ai.summary.slice(0, 300)}`)
  if (ticket.changedFiles?.length) lines.push(`改了什么：${ticket.changedFiles.slice(0, 8).join('、')}${ticket.changedFiles.length > 8 ? ' 等' : ''}`)
  if (ticket.verdict?.tests) lines.push(`测试：${ticket.verdict.tests.summary}${ticket.verdict.mutate ? `；变异：${ticket.verdict.mutate.summary}` : ''}`)
  if (ticket.status === 'ready') {
    lines.push(`执行 \`lark-bot self-fix apply ${ticket.id}\` 合进运行分支，合进后排空重启自动上线；不要就 \`lark-bot self-fix discard ${ticket.id}\`。（分支 ${ticket.branch}，提交 ${String(ticket.commit).slice(0, 8)}）`)
  } else if (ticket.status === 'reported') {
    lines.push(`只报不改：${ticket.reason}${ticket.ai?.blockers?.length ? `；要人做：${ticket.ai.blockers.join('；')}` : ''}`)
  } else if (ticket.reason) {
    lines.push(`${ticket.status === 'failed' ? '出错' : '作废原因'}：${ticket.reason}。现场与分支已删。`)
  }
  return lines.join('\n')
}

// ── 执行器 ───────────────────────────────────────────────

/**
 * 有状态的驱动：worker 主循环每轮（领完任务后）调 maybeStart({ inFlight, draining, shuttingDown })；
 * busy() 为真时不领新任务；排空重启的在飞数要加 inFlightCount()。exec / runTests / runMutate / notify 可注入。
 */
export const createSelfFixRunner = ({
  dir = selfFixDir,
  root = larkBotRoot,
  localConfig = {},
  enabled = true,
  exec = execAiExecutor,
  runTests = defaultRunTests,
  runMutate = defaultRunMutate,
  notify = async () => {},
  log = console.log,
  now = Date.now,
  signal = null,
  timeoutMs = SELF_FIX_TIMEOUT_MS,
  killOrphan = killOrphanExec,
}) => {
  let current = null

  const settle = async (id, patch, note = '') => {
    const ticket = updateTicket({ dir, id, patch, note: note || patch.reason || '', now: now() })
    log(`[lark-worker] 自修工单 ${id}：${SELF_FIX_STATUS_LABELS[patch.status]}${patch.reason ? `（${patch.reason}）` : ''}`)
    await notify(buildSelfFixReport(ticket), { idempotencyKey: `self-fix-${id}-${patch.status}` })
      .catch((error) => log(`[lark-worker] 自修工单 ${id}：私信失败（忽略）：${short(error, 120)}`))
    return ticket
  }

  // 被中断的：退回 pending 下次空闲再跑；中断满上限就作废，不再重来。
  const interrupted = (ticket, attempts, note) => {
    if (attempts < SELF_FIX_MAX_ATTEMPTS) {
      updateTicket({ dir, id: ticket.id, patch: { status: 'pending' }, note, now: now() })
      log(`[lark-worker] 自修工单 ${ticket.id}：${note}，退回待执行`)
      return null
    }
    return settle(ticket.id, { status: 'failed', reason: `${note}，已中断 ${attempts} 次，不再重跑` })
  }

  const runTicket = async (ticket) => {
    const { id, branch, baseHead } = ticket
    const path = selfFixWorktreePath({ root, id })
    const attempts = (ticket.attempts || 0) + 1
    updateTicket({ dir, id, patch: { status: 'running', attempts, worktreePath: path }, note: `第 ${attempts} 次执行`, now: now() })
    log(`[lark-worker] 自修工单 ${id} 开始执行（${ticket.fingerprint?.label}），跑完前不领新任务`)
    const cleanup = () => removeSelfFixWorktree({ root, path, branch })
    let run
    try {
      prepareSelfFixWorktree({ root, path, branch, base: baseHead })
      run = await exec({
        // 执行器进程组记进工单：worker 被 SIGKILL 后 recover 靠它杀孤儿。
        onSpawn: ({ pid }) => pid && updateTicket({ dir, id, patch: { execPid: pid }, now: now() }),
        executor: 'claude',
        promptText: buildSelfFixPrompt({ ...ticket, worktreePath: path }, { root }),
        cwd: path,
        localConfig,
        resultKind: 'task',
        auditLogPath: join(dir, `${id}.log`),
        signal,
        timeoutMs,
      })
    } catch (error) {
      cleanup()
      if (signal?.aborted) return interrupted(ticket, attempts, 'worker 退出，执行被中断')
      return settle(id, { status: 'failed', reason: `执行器出错：${short(error)}` })
    }
    const result = run?.result || {}
    const layer = parseRootCauseLayer(result.summary)
    const ai = { status: result.status || null, summary: String(result.summary || '').slice(0, 1000), blockers: result.blockers || [], checks: (result.checks || []).slice(0, 10) }
    const changedFiles = listChangedFiles({ cwd: path, base: baseHead })
    if (!changedFiles.length) {
      cleanup()
      const reason = FIXABLE_LAYERS.has(layer) ? `定为 ${layer} 层但没改代码` : `根因层 ${layer || '未标'}，不改代码`
      return settle(id, { status: 'reported', layer, ai, reason })
    }
    let reject = null
    if (!FIXABLE_LAYERS.has(layer)) reject = layer ? `根因层 ${layer} 只报不改，却改了文件` : 'summary 开头没标根因层，不认改动'
    else if (!DONE_STATUSES.has(result.status)) reject = `AI 自报 ${result.status || '无状态'}（没做完）却改了文件`
    if (reject) {
      cleanup()
      return settle(id, { status: 'rejected', layer, ai, changedFiles, reason: reject })
    }
    const verdict = await verifySelfFix({ cwd: path, base: baseHead, changedFiles, runTests, runMutate, signal })
    if (signal?.aborted) {
      cleanup()
      return interrupted(ticket, attempts, 'worker 退出，验收被中断')
    }
    const { tests = null, mutate = null } = verdict
    if (!verdict.ok) {
      cleanup()
      return settle(id, { status: 'rejected', layer, ai, changedFiles, verdict: { stage: verdict.stage, tests, mutate }, reason: verdict.reason })
    }
    const commit = commitSelfFix({ cwd: path, id, summary: ai.summary, mutate })
    if (!commit.ok) {
      cleanup()
      return settle(id, { status: 'rejected', layer, ai, changedFiles, verdict: { stage: 'commit', tests, mutate }, reason: `本地提交失败：${commit.error}` })
    }
    return settle(id, { status: 'ready', layer, ai, changedFiles, verdict: { stage: 'done', tests, mutate }, commit: commit.sha })
  }

  // 上个进程跑到一半的（崩溃 / 被 restart）：删现场，退回 pending 或作废。
  const recover = () => {
    for (const ticket of listTickets({ dir })) {
      if (ticket.status !== 'running') continue
      const path = selfFixWorktreePath({ root, id: ticket.id })
      if (killOrphan({ pid: ticket.execPid, worktreePath: path })) log(`[lark-worker] 自修工单 ${ticket.id}：杀掉上次遗留的执行器进程组 ${ticket.execPid}`)
      removeSelfFixWorktree({ root, path, branch: ticket.branch })
      void interrupted(ticket, ticket.attempts || 0, '上次执行时 worker 重启')
    }
  }

  const maybeStart = ({ inFlight = 0, draining = false, shuttingDown = false } = {}) => {
    if (!enabled || current || inFlight > 0 || draining || shuttingDown || signal?.aborted) return null
    const next = listTickets({ dir }).find((ticket) => ticket.status === 'pending')
    if (!next) return null
    const promise = runTicket(next)
      .catch((error) => log(`[lark-worker] 自修工单 ${next.id} 未捕获异常（忽略）：${short(error, 400)}`))
      .finally(() => {
        current = null
      })
    current = { id: next.id, since: new Date(now()).toISOString(), promise }
    return next.id
  }

  if (enabled) recover()
  return {
    maybeStart,
    busy: () => Boolean(current),
    inFlightCount: () => (current ? 1 : 0),
    // 心跳里的自修状态（status / doctor 显示「自修中 <id>」）；没在跑为 null。
    status: () => (current ? { id: current.id, since: current.since } : null),
    current: () => current?.promise || null,
    runTicket,
  }
}
