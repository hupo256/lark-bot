/**
 * 失败指纹（自愈环 2，docs/falive-self-healing.md §3.1）：把 worker 层异常文本归一成稳定指纹并分到固定类，
 * 每类对应一条**确定性**剧本（重排队一次 / 不重跑只报）。不用模型；分类规则按 worker.log 里真实出现过的
 * 错误形状写（10-13 ~ 10-15：规则上下文缺失 16 次、exit code 1 5 次、timeout 4 次、ENOENT result.json、409 stale epoch…）。
 */

import { failureHead } from './lark-worker-results.mjs'

// 归一：路径 / 任务与消息 id / 时间戳 / 临时目录名 / 数字 → 占位，同一种错不同实例指纹相同。
export const normalizeFailureText = (text) =>
  String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/\/(?:var|private|tmp|Users)\/\S+/g, '<path>')
    .replace(/\b(?:om|ou|oc|open)_[a-z0-9]+\b/gi, '<id>')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '<ts>')
    .replace(/lark-[a-z]+-result-\w+/g, 'lark-result-<tmp>')
    .replace(/\d+/g, '#')
    .trim()
    .slice(0, 300)

const hash = (text) => {
  let h = 0x811c9dc5
  for (const ch of text) {
    h ^= ch.charCodeAt(0)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

// 顺序即优先级：先判「不是失败」的竞态，再判结果文件，再判外部瞬时，最后兜底。
const CLASS_RULES = [
  { cls: 'stale_epoch', re: /stale epoch|\b409\b/i, requeue: false, label: '回写时任务已换代（不是失败）', next: '任务已被人工 retry / 结单 / 换代，本次结果作废，不用管' },
  { cls: 'aborted', re: /exec aborted|worker 退出或任务已取消/i, requeue: false, label: '被中断（worker 重启 / 任务取消）', next: '任务已交还队列，会自动重领' },
  { cls: 'result_missing', re: /未返回合法(?:结构化|分析|意图分类|分诊)结果|未返回合法 JSON|ENOENT: no such file or directory, open '?<path>?.*result\.json|result\.json/i, requeue: true, label: '模型没写结果文件', next: '已自动续会话补写过；重排队一次' },
  // 「结构化结果 checks 必须是…」中间夹字段名：允许夹一个词（aven 2026-10-20 review A8）；全部报错原文见 lark-ai-result 与其测试表。
  { cls: 'result_invalid', re: /(?:结构化|分析|意图分类|分诊)结果\s*\S*\s*(?:缺少|必须|存在|不是)|分诊判定 \S+ 必须|evidence 缺少|必须给出 evidence|不能标 taskState|请改用 awaiting_owner_fix/i, requeue: true, label: '模型结果不合约', next: '重排队一次，提示里点明上次哪里不合约' },
  { cls: 'rule_context', re: /VERIFY-RULE-\d+|规则上下文构建失败|缺失常驻硬规则/i, requeue: false, label: '规则文件缺失（bot 自己的环境）', next: '检查 ~/.ai-rules 与 profile.ruleProfile 指向的规则文件是否存在' },
  { cls: 'readonly_violation', re: /违反只读约束/i, requeue: true, label: '分析阶段改了文件', next: '重排队一次（worktree 会重建）' },
  { cls: 'timeout', re: /timed out after|exec produced no events|超时/i, requeue: false, label: '执行超时 / 卡死', next: '看审计里最后一个工具调用卡在哪；拆小任务或调大超时后人工 retry' },
  { cls: 'transient_api', re: /connection closed|connection reset|socket hang up|econnreset|etimedout|fetch failed|network error|overloaded|rate.?limit|too many requests|\b(?:429|500|502|503|504|529)\b|internal server error|bad gateway|service unavailable|gateway timeout|temporarily unavailable|\(attempt \d+\)/i, requeue: true, label: 'AI 接口瞬时错误', next: '重排队一次' },
  // spawn 失败两种形状：spawnSync（就绪检查）和异步 spawn（执行器，`spawn claude ENOENT` / `EACCES`）。10-25 搬自 fameex 沙箱试跑：
  // 原来只认 spawnSync ENOENT，异步那种落成 unknown → 开「未归类」自修工单，自修任务同样起不来 claude，白占预算。
  { cls: 'tool_missing', re: /CLI 不可用|spawn(?:Sync)? \S+ (?:ENOENT|EACCES)|command not found|缺.*二进制/i, requeue: false, label: '执行器 CLI 不在本机', next: '装好对应 CLI（或修好 PATH / 执行权限）后人工 retry' },
  { cls: 'permission', re: /登录|login|unauthor|forbidden|permission denied|token/i, requeue: false, label: '权限 / 登录', next: '在本机完成对应 CLI 登录后人工 retry' },
  { cls: 'git', re: /worktree|merge|conflict|branch|git /i, requeue: true, label: 'git / worktree', next: '重排队一次（临时 worktree 重建）' },
  { cls: 'quality_gate', re: /规范硬闸|终检未通过|tsc|vitest|biome/i, requeue: false, label: '规范 / 终检红', next: '看失败项，人工处理后 retry' },
  { cls: 'exec_exit', re: /exec exited with code/i, requeue: true, label: '执行器非零退出（原因不明）', next: '重排队一次；再失败看审计尾部' },
]

// 执行器非零退出的报错带模型输出尾部（`exec exited with code 1：<尾部 300 字>`）：尾部里的 inputTokens / git diff / tsc
// 会把分类带偏（token→权限、diff→git、tsc→规范闸），且尾部每次不同、指纹永远数不到复发。分类与指纹只看尾部之前的
// 固定前缀（aven 2026-10-20 review A7）；唯一例外：前缀只能判成「非零退出」时，尾部 / error.transient 里的瞬时错误
// 仍可把它归成 transient_api（两类都重排队一次，误判代价小）。
const TRANSIENT_RULE = CLASS_RULES.find((rule) => rule.cls === 'transient_api')

export const fingerprintFailure = (error) => {
  const full = error instanceof Error ? error.message : String(error || '')
  const message = failureHead(full)
  const normalized = normalizeFailureText(message)
  const probe = normalizeFailureText(message).replace(/<path>/g, '/path')
  const matched = CLASS_RULES.find((item) => item.re.test(message) || item.re.test(probe))
  const tailTransient = full !== message && (error?.transient === true || TRANSIENT_RULE.re.test(full.slice(message.length)))
  const rule = matched?.cls === 'exec_exit' && tailTransient ? TRANSIENT_RULE : matched
  return {
    cls: rule?.cls || 'unknown',
    label: rule?.label || '未归类的异常',
    requeue: Boolean(rule?.requeue),
    nextStep: rule?.next || '看审计日志定位；同一指纹再出现会进自修工单',
    fingerprint: `${rule?.cls || 'unknown'}:${hash(normalized)}`,
    normalized,
  }
}

/**
 * 确定性剧本：这次失败该重排队还是直接报失败。
 * priorAttempts：本任务此前自愈重排队次数（台账）；recentSameFingerprint：7 天内撞上同指纹的别的任务数（不含本任务，见 countRecentFingerprint）。
 */
export const decideFailurePlaybook = ({ fingerprint, priorAttempts = 0, recentSameFingerprint = 0, maxRequeue = 1 }) => {
  const recurring = recentSameFingerprint >= 1
  if (fingerprint.cls === 'stale_epoch' || fingerprint.cls === 'aborted') {
    return { action: 'ignore', reason: fingerprint.label, recurring }
  }
  if (fingerprint.requeue && priorAttempts < maxRequeue) {
    return { action: 'requeue', reason: `${fingerprint.label}：自动重排队（第 ${priorAttempts + 1}/${maxRequeue} 次）`, recurring }
  }
  return {
    action: 'fail',
    reason: priorAttempts > 0 ? `${fingerprint.label}：已自动重跑 ${priorAttempts} 次仍失败` : fingerprint.label,
    recurring,
  }
}

// 失败卡上的一行：类别 + 是否重跑过 + 7 天内复发次数（复发是自修工单的触发条件）。
export const formatFingerprintLine = ({ fingerprint, playbook, recentSameFingerprint = 0 }) => {
  const parts = [`失败归类：${fingerprint.label}`]
  if (playbook?.action === 'fail' && /已自动重跑/.test(playbook.reason)) parts.push(playbook.reason.split('：')[1])
  if (recentSameFingerprint >= 1) parts.push(`同一种错 7 天内第 ${recentSameFingerprint + 1} 次`)
  parts.push(`指纹 ${fingerprint.fingerprint}`)
  return parts.join('，')
}

// 重领后喂给模型的一句话提示（分析 / 实施提示末尾），只在有过自愈重排队时出现。
export const buildSelfHealHint = (attempts = []) => {
  const last = attempts[attempts.length - 1]
  if (!last) return null
  const lines = [`【自动重跑】这条任务上一次失败了（${last.label || last.cls}），这是自动重排队后的第 ${attempts.length + 1} 次执行。`]
  if (last.cls === 'result_missing') lines.push('上次没有把结果文件写出来：这次所有命令前台跑完就立刻写结果文件，不要放后台、不要等待。')
  if (last.cls === 'result_invalid') lines.push(`上次的结果 JSON 不合约：${String(last.message || '').slice(0, 160)}。这次严格按「完成后」要求的字段和取值写。`)
  if (last.cls === 'readonly_violation') lines.push('上次在只读分析阶段改了文件：分析阶段只读，不要动工作区。')
  return lines.join('\n')
}
