/**
 * Lark Worker 的 changed-file 静态尺子：bot 改完代码后跑一次与人类 `docs-tdd changed` 同一把尺子
 * （`verify-code-rules.mjs --project <ID> --json`），把 error/warn 计数写入内部审计。
 * 责任模块存量债与「扫描没跑成」不阻断，且扫描详情不展示在普通群结果卡中。
 * **阻断例外**：error 级 finding 的文件落在 bot 本次实测改动清单里（`codeRuleErrorsInDiff` 求交，
 * 文件级归因）时降级 failed——bot 本次改坏的代码不该静默进分支，与失效裸色类硬闸同一立场。
 *
 * 为什么不直接 spawn `docs-tdd changed`：那条 CLI 入口要求先有编码 rule session（`docs-tdd context`
 * 签发，绑客户端+指纹+HEAD），而 Lark Bot 无人值守入口按设计不签会话、改为每个任务注入当前规则章节
 * （见 lark-rule-context.mjs）。走 CLI 的结果是每次扫描都产生一条会话缺失的 FAIL，毫无信息量。
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
  // error 级 finding 逐条留 {ruleId,file,line}：供完成路径与本次实测改动文件求交（文件级归因），
  // 只有 bot 本次真改过的文件命中 error 才阻断，绝不拿责任模块存量债误伤本次完成。
  const errorFindings = []
  for (const finding of findings) {
    const severity = String(finding?.severity || '').toLowerCase()
    if (severity in counts) counts[severity] += 1
    else counts.other += 1
    const ruleId = String(finding?.ruleId || '').trim()
    if (severity !== 'note' && ruleId && !ruleIds.includes(ruleId)) ruleIds.push(ruleId)
    if (severity === 'error') {
      errorFindings.push({ ruleId, file: String(finding?.file || '').trim(), line: Number(finding?.line) || 0 })
    }
  }
  return {
    ran: true,
    ok: counts.error === 0,
    changedFiles: Array.isArray(payload?.changedFiles) ? payload.changedFiles.length : 0,
    ...counts,
    ruleIds,
    errorFindings,
  }
}

// 文件级归因：从扫描摘要里挑出「文件落在本次实测改动清单里」的 error 级 finding。
// 这是把 changed-file 静态尺子升成硬闸的唯一入口——verify-code-rules 默认已 diff-scoped，
// 这里再与 bot 本次任务的 actualChangedFiles 求交，把可能来自更早基线改动的 error 排除掉。
export const codeRuleErrorsInDiff = ({ summary, changedFiles } = {}) => {
  if (!summary?.ran || !Array.isArray(summary.errorFindings)) return []
  const touched = new Set(Array.isArray(changedFiles) ? changedFiles : [])
  return summary.errorFindings.filter((finding) => finding.file && touched.has(finding.file))
}

// diff 命中 error 的阻断卡文案：如实点名 ruleId 与文件:行，给出「修掉或具名豁免」两条出口。
export const buildCodeRulesBlockedResult = (task, hits) => {
  const lines = hits.slice(0, 10).map((hit) => `- ${hit.ruleId} ${hit.file}${hit.line ? `:${hit.line}` : ''}`)
  const more = hits.length > 10 ? `\n…另 ${hits.length - 10} 处` : ''
  return [
    `⛔ ${task?.id || '任务'} 规则扫描：本次改动文件命中 ${hits.length} 处 error 级违规，不判 done（改坏的代码不该静默进分支）。`,
    lines.join('\n') + more,
    `请修掉，或确有正当理由时在 \`agent/rule-waivers.json\` 具名豁免（reason/owner/expiresAt）后重试。`,
  ].join('\n')
}

// 在任务 worktree 里实跑一次静态扫描。任何异常（脚本缺失、非法 JSON、超时）都收敛成 ran:false，
// 不抛、不改任务状态：扫描不可用只记审计；只有可归因到本次改动文件的 error 由调用方执行硬闸。
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
