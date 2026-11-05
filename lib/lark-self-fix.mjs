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
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { failuresDir, listFailures, recordFailure } from './lark-failure-ledger.mjs'
import { larkBotRoot } from './lark-paths.mjs'

// 工单的纯文件读写在 lark-self-fix-store.mjs（gateway 也要读：私信「上线 <id>」，gateway 闭包不许有子进程）。
import { isTicketId, listTickets, readTicket, selfFixDir, selfFixWorktreePath, updateTicket, writeTicket } from './lark-self-fix-store.mjs'
export { isTicketId, listTickets, readTicket, selfFixDir, selfFixWorktreePath, updateTicket, writeTicket }
export const SELF_FIX_ACTION = 'self_fix'
export const SELF_FIX_DAILY_CAP = 3
const WEEK_MS = 7 * 24 * 60 * 60_000
// 这些类不是 bot 代码能修的：权限 / 本机缺 CLI / 规范闸（改的是业务代码）/ 换代与中断（不是失败）。
const NEVER_SELF_FIX = new Set(['stale_epoch', 'aborted', 'permission', 'tool_missing', 'quality_gate'])
// 这些类只有复发才值得查（单次超时多半是任务本身大）。
const ONLY_IF_RECURRING = new Set(['timeout', 'exec_exit', 'transient_api'])

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

const fingerprintShort = (fingerprint) => String(fingerprint.fingerprint).split(':').pop().replace(/\W/g, '')

export const selfFixIds = ({ fingerprint, now = Date.now() }) => {
  const short = fingerprintShort(fingerprint)
  return { id: `sf-${dayKey(now)}-${short}`, branch: `lark/self-fix-${short}-${dayKey(now)}` }
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

// ── 需求型工单（11-04）：群里 @bot 要改 bot 自己（评分 / 规则 / 逻辑），分类器判 botSelf ────────────────
// aven 11-04「这个逻辑与 falive-bot 自身的异常、错误，自己修复，然后排空重启逻辑不一样吗」：falive 靠多仓 profile 给 lark-bot 开普通任务；
// fameex 没有多仓 profile，就复用这里的工单 + 独立执行器 + 机械验收，只是触发从「运行失败」换成「群里的需求」。
// 合并仍要负责人点头（私信「上线 <id>」或 lark-bot self-fix apply），群里任何人的话都不会自己变成 bot 的新代码。
export const SELF_REQUEST_DAILY_CAP = 5
const REQUEST_TEXT_MAX = 8000

export const selfRequestIds = ({ task, now = Date.now() }) => {
  const short = String(task?.id || '').replace(/\W/g, '').slice(-8) || 'req'
  return { id: `sf-${dayKey(now)}-req${short}`, branch: `lark/self-req-${short}-${dayKey(now)}` }
}

/** 从任务开一张需求型工单。返回 { opened, reason, id, ticket }；同一任务已开过就返回那张（不重复开）。 */
export const openSelfRequest = ({ task, dir = selfFixDir, root = larkBotRoot, enabled = true, now = Date.now(), log = console.log }) => {
  const skip = (reason) => {
    log(`[lark-worker] ${task?.id} 不开需求型自修工单：${reason}`)
    return { opened: false, reason, id: null, ticket: null }
  }
  if (!enabled) return skip('自修工单关着（selfHeal.selfFix=false / LARK_SELF_FIX=0）')
  const { id, branch } = selfRequestIds({ task, now })
  const existing = listTickets({ dir }).find((ticket) => ticket.kind === 'request' && ticket.request?.taskId === task.id && !['discarded', 'rejected', 'failed'].includes(ticket.status))
  if (existing) return { opened: false, reason: `已有工单 ${existing.id}`, id: existing.id, ticket: existing }
  const today = listTickets({ dir }).filter((ticket) => ticket.kind === 'request' && dayKey(Date.parse(ticket.createdAt)) === dayKey(now)).length
  if (today >= SELF_REQUEST_DAILY_CAP) return skip(`今天已开 ${today} 张需求型工单（上限 ${SELF_REQUEST_DAILY_CAP}）`)
  const baseHead = headOf(root)
  if (!baseHead) return skip(`取不到 ${root} 的 HEAD`)
  const summary = String(task.summary || task.text || '').replace(/\s+/g, ' ').trim().slice(0, 120)
  const at = new Date(now).toISOString()
  const ticket = writeTicket({
    dir,
    ticket: {
      id,
      kind: 'request',
      status: 'pending',
      createdAt: at,
      updatedAt: at,
      trigger: '群里的需求：要改 bot 自己',
      // fingerprint 只给列表 / 私信沿用同一套展示，需求型工单没有失败指纹。
      fingerprint: { cls: 'request', fingerprint: 'request', label: `群里需求：${summary}` },
      request: {
        taskId: task.id,
        summary,
        text: String(task.text || '').slice(0, REQUEST_TEXT_MAX),
        operator: task.operator || null,
        chatId: task.chatId || null,
        chatName: task.chatName || null,
        replyTarget: task.replyTarget || null,
      },
      baseHead,
      branch,
      worktreePath: selfFixWorktreePath({ root, id }),
      attempts: 0,
      history: [{ at, status: 'pending', note: `任务 ${task.id}` }],
    },
  })
  log(`[lark-worker] ${task.id} 要改 bot 自己：已开需求型自修工单 ${id}，worker 空闲时执行`)
  return { opened: true, reason: 'opened', id, ticket }
}
