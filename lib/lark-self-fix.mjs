/**
 * 自修工单（自愈环 2.2，从 falive 移植，aven 2026-10-24；falive 设计见其 docs/falive-self-healing.md §3.2）：
 * worker 层失败经指纹 / 剧本判为直接失败后，「未归类 / 同指纹 7 天内复发 / 自动重跑也没救」的，开一张自修工单，
 * 让 bot 在 lark-bot 本仓的临时 worktree 里查根因、harness / prompt 层才改代码，worker 机械验收后只本地提交、私信负责人，
 * 人执行 `lark-bot self-fix apply <id>` 才合进运行分支（之后由排空重启上线）。
 *
 * fameex 没有多仓 profile，所以不走任务队列：工单是 runtime/lark-self-fix/<id>.json 一个文件，由 worker 空闲时
 * 的独立执行器（lark-self-fix-run.mjs）一次跑一张。本模块只管「开不开」与工单落盘 / 状态流转。
 *
 * 状态：pending（待跑）→ running → ready（验收全过、已本地提交，等人 apply）/ rejected（验收不过，现场已删）/
 * reported（env / external / model 层或没改代码：只报不改）/ failed（执行器自己出错）；人工：applied / discarded。
 * 预算：每天最多 3 张、同指纹 7 天 1 张（按失败台账里 action=self_fix 的行数）。自修工单自己失败不套娃（它不是网关任务，
 * 不进失败剧本）。开关：配置 selfHeal.selfFix=false 或环境 LARK_SELF_FIX=0。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { failuresDir, listFailures, recordFailure } from './lark-failure-ledger.mjs'
import { larkBotRoot, larkRuntimeDir } from './lark-paths.mjs'

export const selfFixDir = join(larkRuntimeDir, 'lark-self-fix')
export const SELF_FIX_ACTION = 'self_fix'
export const SELF_FIX_DAILY_CAP = 3
const WEEK_MS = 7 * 24 * 60 * 60_000
// 这些类不是 bot 代码能修的：权限 / 本机缺 CLI / 规范闸（改的是业务代码）/ 换代与中断（不是失败）。
const NEVER_SELF_FIX = new Set(['stale_epoch', 'aborted', 'permission', 'tool_missing', 'quality_gate'])
// 这些类只有复发才值得查（单次超时多半是任务本身大）。
const ONLY_IF_RECURRING = new Set(['timeout', 'exec_exit', 'transient_api'])
const TICKET_ID_RE = /^sf-\d{8}-[\w]+$/

export const selfFixEnabled = ({ localConfig, env = process.env } = {}) =>
  localConfig?.selfHeal?.selfFix !== false && env.LARK_SELF_FIX !== '0'

// 本地日期（「每天最多 3 张」按人的一天算，不按 UTC）。
export const dayKey = (ms) => {
  const date = new Date(ms)
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
}

export const selfFixBudget = ({ dir = failuresDir, fingerprint, now = Date.now() }) => {
  const entries = listFailures({ dir, sinceMs: now - WEEK_MS }).filter((entry) => entry.action === SELF_FIX_ACTION)
  return {
    openedToday: entries.filter((entry) => dayKey(Date.parse(entry.at)) === dayKey(now)).length,
    openedForFingerprint: entries.filter((entry) => entry.fingerprint === fingerprint).length,
  }
}

/** 纯决策：要不要为这次失败开自修工单。recentSameFingerprint = 7 天内撞上同指纹的别的任务数（不含本任务）。 */
export const shouldOpenSelfFix = ({
  task,
  fingerprint,
  playbook,
  recentSameFingerprint = 0,
  priorAttempts = 0,
  enabled = true,
  openedToday = 0,
  openedForFingerprint = 0,
}) => {
  if (!enabled) return { open: false, reason: 'selfHeal.selfFix 关闭' }
  if (task?.source === 'self-fix') return { open: false, reason: '自修工单自己失败，不套娃' }
  if (!fingerprint || playbook?.action !== 'fail') return { open: false, reason: `剧本是 ${playbook?.action || '?'}，不是失败` }
  if (NEVER_SELF_FIX.has(fingerprint.cls)) return { open: false, reason: `${fingerprint.label}：不是 bot 代码能修的` }
  const recurring = recentSameFingerprint >= 1
  if (ONLY_IF_RECURRING.has(fingerprint.cls) && !recurring) return { open: false, reason: `${fingerprint.label}：单次不查，复发才查` }
  const triggers = []
  if (recurring) triggers.push(`同指纹 7 天内第 ${recentSameFingerprint + 1} 次`)
  if (fingerprint.cls === 'unknown') triggers.push('未归类')
  if (priorAttempts > 0 && !ONLY_IF_RECURRING.has(fingerprint.cls)) triggers.push(`自动重跑 ${priorAttempts} 次仍失败`)
  if (!triggers.length) return { open: false, reason: '首次、已归类、未自动重跑：先记台账' }
  if (openedForFingerprint >= 1) return { open: false, reason: '同指纹 7 天内已开过自修工单' }
  if (openedToday >= SELF_FIX_DAILY_CAP) return { open: false, reason: `今天已开 ${openedToday} 张，达上限 ${SELF_FIX_DAILY_CAP}` }
  return { open: true, reason: triggers.join('，') }
}

// ── 工单落盘 ─────────────────────────────────────────────

export const isTicketId = (id) => TICKET_ID_RE.test(String(id || ''))
const ticketFile = (dir, id) => join(dir, `${id}.json`)
const fingerprintShort = (fingerprint) => String(fingerprint.fingerprint).split(':').pop().replace(/\W/g, '')

export const selfFixIds = ({ fingerprint, now = Date.now() }) => {
  const short = fingerprintShort(fingerprint)
  return { id: `sf-${dayKey(now)}-${short}`, branch: `lark/self-fix-${short}-${dayKey(now)}` }
}

// 工单临时 worktree 放仓库同级（与人手开的 worktree 一样平级），不放 runtime/：运行目录里多一份源码会干扰排查。
export const selfFixWorktreePath = ({ root = larkBotRoot, id }) => join(dirname(root), `${basename(root)}-${id}`)

export const readTicket = ({ dir = selfFixDir, id }) => {
  if (!isTicketId(id)) return null
  try {
    return JSON.parse(readFileSync(ticketFile(dir, id), 'utf8'))
  } catch {
    return null
  }
}

export const writeTicket = ({ dir = selfFixDir, ticket }) => {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = ticketFile(dir, ticket.id)
  writeFileSync(`${file}.tmp`, `${JSON.stringify(ticket, null, 2)}\n`, { mode: 0o600 })
  renameSync(`${file}.tmp`, file)
  return ticket
}

export const listTickets = ({ dir = selfFixDir } = {}) => {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readTicket({ dir, id: name.slice(0, -5) }))
    .filter(Boolean)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
}

// 状态流转都走这里：合并补丁 + 记一行 history（谁在什么时候把它改成了什么）。工单不存在返回 null。
export const updateTicket = ({ dir = selfFixDir, id, patch = {}, note = '', now = Date.now() }) => {
  const ticket = readTicket({ dir, id })
  if (!ticket) return null
  const at = new Date(now).toISOString()
  const next = { ...ticket, ...patch, updatedAt: at }
  if (patch.status && patch.status !== ticket.status) next.history = [...(ticket.history || []), { at, status: patch.status, note }]
  return writeTicket({ dir, ticket: next })
}

// 读不到（没配 LARK_LOG_FILE / 文件不在）就是空串。
const tailOf = (file, lines = 150) => {
  try {
    return readFileSync(file, 'utf8').split('\n').slice(-lines).join('\n').slice(-20_000)
  } catch {
    return ''
  }
}

const headOf = (root) => {
  const res = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
  return res.status === 0 ? res.stdout.trim() : ''
}

/**
 * 失败剧本判为直接失败后调（handleTaskFailure 的 onFail）：决策 → 落一张 pending 工单 → 台账记 self_fix。
 * 同步、不抛给调用方以外的东西（调用方已包 try）；返回 { opened, reason, id }。
 */
export const maybeOpenSelfFix = ({
  task,
  error,
  fingerprint,
  playbook,
  recentSameFingerprint = 0,
  priorAttempts = 0,
  auditContext = null,
  enabled = true,
  ledgerDir = failuresDir,
  dir = selfFixDir,
  root = larkBotRoot,
  workerLogPath = process.env.LARK_LOG_FILE || null,
  now = Date.now(),
  log = console.log,
}) => {
  const budget = selfFixBudget({ dir: ledgerDir, fingerprint: fingerprint?.fingerprint, now })
  const decision = shouldOpenSelfFix({ task, fingerprint, playbook, recentSameFingerprint, priorAttempts, enabled, ...budget })
  // 不开也打一行原因（10-24 沙箱试跑：同指纹已开过 / 预算满时 worker.log 里什么都没有，看不出自修为什么没动）。
  const skip = (reason) => {
    log(`[lark-worker] ${task?.id} 不开自修工单：${reason}`)
    return { opened: false, reason, id: null }
  }
  if (!decision.open) return skip(decision.reason)
  const baseHead = headOf(root)
  if (!baseHead) return skip(`取不到 ${root} 的 HEAD`)
  const { id, branch } = selfFixIds({ fingerprint, now })
  const message = error instanceof Error ? error.message : String(error || '')
  const at = new Date(now).toISOString()
  writeTicket({
    dir,
    ticket: {
      id,
      status: 'pending',
      createdAt: at,
      updatedAt: at,
      trigger: decision.reason,
      task: { id: task.id, epoch: task.epoch ?? null, project: task.project || null, text: String(task.text || '').slice(0, 400) },
      error: message.slice(0, 2000),
      fingerprint: { cls: fingerprint.cls, fingerprint: fingerprint.fingerprint, label: fingerprint.label },
      recentSameFingerprint,
      priorAttempts,
      auditJsonPath: auditContext?.jsonPath || null,
      auditLogPath: auditContext?.logPath || null,
      workerLogPath,
      workerLogTail: tailOf(workerLogPath),
      baseHead,
      branch,
      worktreePath: selfFixWorktreePath({ root, id }),
      attempts: 0,
      history: [{ at, status: 'pending', note: decision.reason }],
    },
  })
  recordFailure({ dir: ledgerDir, taskId: task.id, epoch: task.epoch, fingerprint, action: SELF_FIX_ACTION, reason: `${decision.reason} → ${id}`, message, now })
  log(`[lark-worker] ${task.id} 已开自修工单 ${id}（${decision.reason}），worker 空闲时执行`)
  return { opened: true, reason: decision.reason, id }
}
