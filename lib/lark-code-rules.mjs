/**
 * Lark Worker 的 changed-file 静态尺子：bot 改完代码后跑一次与人类 `docs-tdd changed` 同一把尺子
 * （`verify-code-rules.mjs --project <ID> --json`），把 error/warn 计数附到完成卡上。**不阻断**——
 * 卡上如实写数字，人来决定要不要回炉；bot 自己判「过/不过」的硬闸只有 lark-quality-gate 那一层。
 *
 * 为什么不直接 spawn `docs-tdd changed`：那条 CLI 入口要求先有编码 rule session（`docs-tdd context`
 * 签发，绑客户端+指纹+HEAD），而 Lark 两个入口按设计不签会话、改为每个任务注入当前规则章节
 * （见 lark-rule-context.mjs）。走 CLI 的结果是每张卡片都挂一条会话缺失的 FAIL，毫无信息量。
 * 故这里直接调用 `changed` 底下那个真正扫改动文件的子检，口径与它一致。
 */

import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { docsSystemRoot, repoRoot } from './lark-worker-env.mjs'

const SCAN_SCRIPT = join(docsSystemRoot, 'common/engine/agent-scripts/verify-code-rules.mjs')

// verify-code-rules --json 的 findings → 计数摘要。severity 只认 error/warn/note 三档，
// 其余（将来新增档）归入 other 而不是静默丢掉。纯函数便于单测。
export const summarizeCodeRules = (payload) => {
  const findings = Array.isArray(payload?.findings) ? payload.findings : []
  const counts = { error: 0, warn: 0, note: 0, other: 0 }
  const ruleIds = []
  for (const finding of findings) {
    const severity = String(finding?.severity || '').toLowerCase()
    if (severity in counts) counts[severity] += 1
    else counts.other += 1
    const ruleId = String(finding?.ruleId || '').trim()
    if (severity !== 'note' && ruleId && !ruleIds.includes(ruleId)) ruleIds.push(ruleId)
  }
  return {
    ran: true,
    ok: counts.error === 0,
    changedFiles: Array.isArray(payload?.changedFiles) ? payload.changedFiles.length : 0,
    ...counts,
    ruleIds,
  }
}

// 完成卡上的一行。ran=false 时如实写「未跑成」+ 原因，绝不写成 0 违规（那等于伪造扫描结果）。
export const formatCodeRulesLine = (summary) => {
  if (!summary?.ran) return `**规则扫描**：未跑成（${summary?.reason || '原因未知'}），本次无静态扫描结论`
  const idNote = summary.ruleIds.length ? `（${summary.ruleIds.slice(0, 6).join('、')}）` : ''
  const noteTail = summary.note ? ` · note ${summary.note}` : ''
  return `**规则扫描**：改动 ${summary.changedFiles} 文件 · error ${summary.error} · warn ${summary.warn}${noteTail}${idNote}`
}

// 在任务 worktree 里实跑一次静态扫描。任何异常（脚本缺失、非法 JSON、超时）都收敛成 ran:false，
// 不抛、不改任务状态：这一层的定位是「给人看的数字」，不是闸。
export const runCodeRulesScan = ({ cwd, projectId } = {}) => {
  const args = [SCAN_SCRIPT, '--json']
  if (projectId) args.push('--project', projectId)
  const result = spawnSync(process.execPath, args, {
    cwd: cwd || repoRoot,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 120_000,
  })
  if (result.error) return { ran: false, reason: `扫描进程启动失败：${result.error.message}` }
  // 退出码 1 = 有 error 级 finding，stdout 仍是完整 JSON，属正常结论，不当失败处理。
  try {
    return summarizeCodeRules(JSON.parse(result.stdout || ''))
  } catch {
    const tail = (result.stderr || result.stdout || '').trim().split('\n').slice(-2).join(' / ')
    return { ran: false, reason: `扫描输出无法解析（exit ${result.status ?? '?'}）：${tail || '无输出'}` }
  }
}
