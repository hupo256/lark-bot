/**
 * 自修工单（自愈环 2.2，docs/falive-self-healing.md §3.2）：worker 层失败经指纹分类后仍失败、且属于
 * 「复发 / 未归类 / 自动重跑也没救」的，给 lark-bot 自己开一条仓库任务（repo profile `lark-bot`），
 * 走现成的「只读分析 → 实施 → 终检 → 本地提交 → 私信」链路：分诊根因层，harness / prompt 层才改代码，
 * 补测试 + lessons 一行，`node --test` 全绿才交付；只私信 aven，不上线（aven 回「上线」再合进工作分支，
 * 磁盘变了由排空重启生效）。预算：每天最多 3 条、同指纹 7 天 1 条；自修工单自己失败不再套娃。
 */

import { existsSync, readFileSync } from 'node:fs'

import { listFailures, recordFailure } from './lark-failure-ledger.mjs'
import { larkBotRoot } from './lark-paths.mjs'
import { repoProfile } from './lark-repo-profile.mjs'

export const SELF_FIX_REPO = 'lark-bot'
export const SELF_FIX_DAILY_CAP = 3
// 这些类不是 bot 代码能修的：权限 / 本机缺 CLI / 规范闸（改的是业务代码）/ 换代与中断（不是失败）。
const NEVER_SELF_FIX = new Set(['stale_epoch', 'aborted', 'permission', 'tool_missing', 'quality_gate'])
// 这些类只有复发才值得查（单次超时多半是任务本身大）。
const ONLY_IF_RECURRING = new Set(['timeout', 'exec_exit', 'transient_api'])

const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10)

export const selfFixBudget = ({ dir, fingerprint, now = Date.now() }) => {
  const entries = listFailures({ dir, sinceMs: now - 7 * 24 * 60 * 60_000 }).filter((entry) => entry.action === 'self_fix_opened')
  const openedToday = entries.filter((entry) => dayKey(Date.parse(entry.at)) === dayKey(now)).length
  const openedForFingerprint = entries.filter((entry) => entry.fingerprint === fingerprint).length
  return { openedToday, openedForFingerprint }
}

/** 纯决策：要不要为这次失败开自修工单。 */
export const shouldOpenSelfFix = ({
  task,
  fingerprint,
  playbook,
  recentSameFingerprint = 0,
  priorAttempts = 0,
  enabled = true,
  profileExists = true,
  openedToday = 0,
  openedForFingerprint = 0,
}) => {
  if (!enabled) return { open: false, reason: 'selfHeal.selfFix 关闭' }
  if (!profileExists) return { open: false, reason: `没有 ${SELF_FIX_REPO} 仓库 profile` }
  if (task?.repo === SELF_FIX_REPO || task?.source === 'self-heal') return { open: false, reason: '自修工单自己失败，不套娃' }
  if (!playbook || playbook.action !== 'fail') return { open: false, reason: `剧本是 ${playbook?.action || '?'}，不是失败` }
  if (NEVER_SELF_FIX.has(fingerprint.cls)) return { open: false, reason: `${fingerprint.label}：不是 bot 代码能修的` }
  const recurring = recentSameFingerprint >= 1
  if (ONLY_IF_RECURRING.has(fingerprint.cls) && !recurring) return { open: false, reason: `${fingerprint.label}：单次不查，复发才查` }
  const triggers = []
  if (recurring) triggers.push(`同指纹 7 天内第 ${recentSameFingerprint + 1} 次`)
  if (fingerprint.cls === 'unknown') triggers.push('未归类')
  if (priorAttempts > 0 && !ONLY_IF_RECURRING.has(fingerprint.cls)) triggers.push(`自动重跑 ${priorAttempts} 次仍失败`)
  if (!triggers.length) return { open: false, reason: '首次、已归类、未自动重跑：先记台账' }
  if (openedForFingerprint >= 1) return { open: false, reason: '同指纹 7 天内已开过自修工单' }
  if (openedToday >= SELF_FIX_DAILY_CAP) return { open: false, reason: `今天已开 ${openedToday} 条，达上限 ${SELF_FIX_DAILY_CAP}` }
  return { open: true, reason: triggers.join('，') }
}

const tail = (file, lines = 120) => {
  try {
    if (!file || !existsSync(file)) return ''
    return readFileSync(file, 'utf8').split('\n').slice(-lines).join('\n')
  } catch {
    return ''
  }
}

export const selfFixTaskId = ({ fingerprint, now = Date.now() }) =>
  `selffix-${fingerprint.fingerprint.replace(/[^\w]/g, '-')}-${dayKey(now).replace(/-/g, '')}`

/** 工单正文：给分析 / 实施模型的全部事实 + 边界。首行带「修复：」前缀 → commandType=fix → bugfix 快车道，不要人工放行。 */
export const buildSelfFixTaskText = ({
  task,
  error,
  fingerprint,
  recentSameFingerprint = 0,
  priorAttempts = 0,
  auditContext = null,
  workerLogPath = process.env.LARK_LOG_FILE || null,
  trigger = '',
}) => {
  const message = error instanceof Error ? error.message : String(error || '')
  const auditJson = auditContext?.jsonPath || null
  const auditLog = auditContext?.logPath || null
  const workerTail = tail(workerLogPath, 150)
  return [
    `修复：lark-bot 自身缺陷——${fingerprint.label}（指纹 ${fingerprint.fingerprint}）`,
    '',
    `这是 bot 的自修工单（docs/falive-self-healing.md §3.2）。触发：${trigger || '复发'}。原任务 ${task.id}（仓 ${task.repo || '默认'}，第 ${(task.epoch || 0) + 1} 代）失败，worker 层错误原文：`,
    '```',
    message.slice(0, 1200),
    '```',
    `失败类别：${fingerprint.cls}；7 天内同指纹 ${recentSameFingerprint + 1} 次；自动重排队 ${priorAttempts} 次${priorAttempts ? '仍失败' : ''}。`,
    `原任务正文（前 400 字）：${String(task.text || '').slice(0, 400).replace(/\n+/g, ' ')}`,
    '',
    '可读的证据（绝对路径，已放行只读）：',
    auditJson ? `- 原任务审计 JSON：${auditJson}` : null,
    auditLog ? `- 原任务审计事件流：${auditLog}（stream-json，看最后几个 tool_use / result 事件）` : null,
    workerLogPath ? `- worker.log：${workerLogPath}` : null,
    `- 失败台账：${larkBotRoot}/runtime/lark-failures/`,
    '- 出错台账（已沉淀的规则 / 闸）：docs/falive-lessons.md；自愈策略：docs/falive-self-healing.md',
    '',
    '分析阶段必须先定根因层，写进 summary 开头：`[harness]` bot 自己的代码 / `[prompt]` 提示词口径 / `[env]` 本机环境（CLI、规则文件、凭据）/ `[model]` 模型判断错 / `[external]` 外部服务。',
    '只有 harness / prompt 才实施：改 lib/ scripts/ __tests__/ docs/ 下的文件，补或改单测让这个错有回归保护，在 docs/falive-lessons.md 表末追加一行（现象 · 根因 · 落在哪 · 怎么验），并在 summary 里写清「改了什么、怎么验」。',
    'env / external / model：不改代码，status 用 blocked，blockers 写明要人做什么（装什么、改哪个配置、哪条规则候选）。',
    "硬边界：不碰 runtime/（配置、凭据、任务、审计、状态）；不改 falive-react；不 push；不 restart；不改 rules/；改完 `node --check` 每个 .mjs 并 `node --test __tests__/<相关文件>.test.mjs`，最后 `node --test '__tests__/*.test.mjs'` 必须全绿，红了不许交 done；再跑 `node scripts/mutate.mjs --diff HEAD`（只扫本次改动行），有存活就补测，确属等价的登记进 scripts/mutation-accepted.json 并写原因。",
    workerTail ? `\nworker.log 尾部（最近 150 行）：\n\`\`\`\n${workerTail}\n\`\`\`` : null,
  ]
    .filter((line) => line != null)
    .join('\n')
}

/** 开工单：POST /lark/tasks（repo=lark-bot，源 self-heal），并在失败台账记 self_fix_opened。返回 { opened, reason, taskId }。 */
export const maybeOpenSelfFix = async ({
  client,
  task,
  error,
  fingerprint,
  playbook,
  recentSameFingerprint = 0,
  priorAttempts = 0,
  auditContext = null,
  localConfig = {},
  ledgerDir = undefined,
  now = Date.now(),
  log = console.log,
}) => {
  const enabled = localConfig?.selfHeal?.selfFix !== false && process.env.LARK_SELF_FIX !== '0'
  const profile = repoProfile(SELF_FIX_REPO)
  const budget = selfFixBudget({ dir: ledgerDir, fingerprint: fingerprint.fingerprint, now })
  const decision = shouldOpenSelfFix({
    task,
    fingerprint,
    playbook,
    recentSameFingerprint,
    priorAttempts,
    enabled,
    profileExists: Boolean(profile && !profile.isDefault),
    ...budget,
  })
  if (!decision.open) return { opened: false, reason: decision.reason, taskId: null }
  const taskId = selfFixTaskId({ fingerprint, now })
  const text = buildSelfFixTaskText({ task, error, fingerprint, recentSameFingerprint, priorAttempts, auditContext, trigger: decision.reason })
  try {
    const outcome = await client.enqueueTask({ id: taskId, repo: SELF_FIX_REPO, source: 'self-heal', text, operator: task.operator || null })
    recordFailure({ dir: ledgerDir, repo: task.repo, taskId: task.id, epoch: task.epoch, fingerprint, action: 'self_fix_opened', reason: `${decision.reason} → ${taskId}`, message: error?.message, now })
    log(`[lark-worker] ${task.id} 已开自修工单 ${outcome?.task?.id || taskId}（${decision.reason}）`)
    return { opened: true, reason: decision.reason, taskId: outcome?.task?.id || taskId }
  } catch (enqueueError) {
    log(`[lark-worker] ${task.id} 开自修工单失败（忽略）：${String(enqueueError).slice(0, 160)}`)
    return { opened: false, reason: `enqueue 失败：${String(enqueueError).slice(0, 120)}`, taskId: null }
  }
}
