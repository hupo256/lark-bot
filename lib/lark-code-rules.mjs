/**
 * Lark Worker 的 changed-file 静态尺子：bot 改完代码后在任务 worktree 根跑一次内置的 `scripts/code-rules.mjs --json`
 * （钉版副本，权威版本在 ~/.ai-rules prd-to-commit；与人类走 prd-to-commit 时 check.mjs 调的是同一把尺子），
 * 把 error 计数写入内部审计。
 * 扫描器契约：`{ ok, changedFiles, findings:[{severity:'error', ruleId, file, line, message}], baseResolved }`，
 * 退出码 0 无 error / 1 有 error（stdout 仍是完整 JSON）/ 2 工具自身失败；豁免只有行内或上一行
 * `code-rules-ignore <RULE-ID>: <理由>` 注释一种。
 * 责任模块存量债与「扫描没跑成」不阻断，且扫描详情不展示在普通群结果卡中。
 * **阻断例外**：error 级 finding 的文件落在 bot 本次实测改动清单里（`codeRuleErrorsInDiff` 求交，
 * 文件级归因）时降级 failed——bot 本次改坏的代码不该静默进分支，与失效裸色类硬闸同一立场。
 *
 * 拆仓前这里直接调 docs_tdd 引擎 `docs-tdd changed` 底下的 verify-code-rules.mjs 子检；该引擎已冻结，
 * 新扫描器零依赖、无编码会话与项目文档概念，所以不再传 `--project`。
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { larkBotRoot, repoRoot } from './lark-worker-env.mjs'

// 扫描器是 lark-bot 内置的钉版副本（零依赖 code-rules.mjs，来源 ~/.ai-rules prd-to-commit），
// 不再 spawn docs_tdd 引擎的 verify-code-rules.mjs。副本缺失时扫描降级为 ran:false（只记审计、不阻断）。
const SCAN_SCRIPT = join(larkBotRoot, 'scripts/code-rules.mjs')

// code-rules --json 的 findings → 计数摘要。新扫描器只产出 error 级；warn/note 档保留是为兼容旧审计口径，
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
    // base 解析不到（如临时仓库无 origin/online）时扫描器降级为只看工作区 + 暂存区 + untracked，审计里留痕
    ...(typeof payload?.baseResolved === 'boolean' ? { baseResolved: payload.baseResolved } : {}),
  }
}

// 文件级归因：从扫描摘要里挑出「文件落在本次实测改动清单里」的 error 级 finding。
// 这是把 changed-file 静态尺子升成硬闸的唯一入口——code-rules 已按 merge-base(HEAD, base) 做 diff-scoped，
// 这里再与 bot 本次任务的 actualChangedFiles 求交，把可能来自更早基线改动（人类 WIP、分支旧提交）的 error 排除掉。
export const codeRuleErrorsInDiff = ({ summary, changedFiles } = {}) => {
  if (!summary?.ran || !Array.isArray(summary.errorFindings)) return []
  const touched = new Set(Array.isArray(changedFiles) ? changedFiles : [])
  return summary.errorFindings.filter((finding) => finding.file && touched.has(finding.file))
}

// diff 命中 error 的阻断卡文案：如实点名 ruleId 与文件:行，给出「修掉或行内豁免」两条出口。
export const buildCodeRulesBlockedResult = (task, hits) => {
  const lines = hits.slice(0, 10).map((hit) => `- ${hit.ruleId} ${hit.file}${hit.line ? `:${hit.line}` : ''}`)
  const more = hits.length > 10 ? `\n…另 ${hits.length - 10} 处` : ''
  return [
    `⛔ ${task?.id || '任务'} 规则扫描：本次改动文件命中 ${hits.length} 处 error 级违规，不判 done（改坏的代码不该静默进分支）。`,
    lines.join('\n') + more,
    `请修掉，或确有正当理由时在该行或上一行加注释 \`code-rules-ignore <RULE-ID>: <理由>\`（缺理由不生效）后重试。`,
  ].join('\n')
}

// 在任务 worktree 里实跑一次静态扫描。任何异常（脚本缺失、非法 JSON、超时）都收敛成 ran:false，
// 不抛、不改任务状态：扫描不可用只记审计；只有可归因到本次改动文件的 error 由调用方执行硬闸。
// base 不传时用扫描器默认 origin/online（与临时 worktree 的默认基线一致）；调用方多传的 projectId 等字段直接忽略。
export const runCodeRulesScan = ({ cwd, base, scanScript = SCAN_SCRIPT } = {}) => {
  if (!existsSync(scanScript)) return { ran: false, reason: `代码规则扫描器未安装（缺 ${scanScript}）` }
  const args = [scanScript, '--json']
  if (base) args.push('--base', base)
  const result = spawnSync(process.execPath, args, {
    cwd: cwd || repoRoot,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 120_000,
  })
  if (result.error) return { ran: false, reason: `扫描进程启动失败：${result.error.message}` }
  // 退出码 1 = 有 error 级 finding，stdout 仍是完整 JSON，属正常结论，不当失败处理；
  // 退出码 2 = 工具自身失败（非 git 仓库等），stdout 为空，落到下面的解析失败分支记 ran:false。
  try {
    return summarizeCodeRules(JSON.parse(result.stdout || ''))
  } catch {
    const tail = (result.stderr || result.stdout || '').trim().split('\n').slice(-2).join(' / ')
    return { ran: false, reason: `扫描输出无法解析（exit ${result.status ?? '?'}）：${tail || '无输出'}` }
  }
}
