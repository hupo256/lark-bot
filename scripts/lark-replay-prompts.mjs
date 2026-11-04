#!/usr/bin/env node
/**
 * 提示词回放（docs/upgrade-plan-context-layers-2026-11-01.md S7）：拿真实审计里的任务，用「基线版本」和「当前工作区」两版
 * buildTaskPrompt 各生成一遍，核三件事：
 *   1. 规则不丢：基线提示的每一行（去空白后）都还在当前版本的「系统层 + user」里（已知改写见 REWRITES）；
 *   2. 体积：基线整份 vs 当前系统层 / user / 续会话 user；
 *   3. 系统层跨任务逐字相同（能命中提示缓存的前提）。
 *   node scripts/lark-replay-prompts.mjs --audits <审计目录> [--base <git ref，默认 HEAD>] [--verify] [--json]
 * 基线用 git worktree 临时检出（结束删除），只读审计，不写任何运行态文件。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url))).replace(/\/$/, '')
const argv = process.argv.slice(2)
const option = (name, fallback) => {
  const at = argv.indexOf(name)
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback
}
const auditsDir = option('--audits', join(root, 'runtime/lark-audits'))
const baseRef = option('--base', 'HEAD')
const verify = argv.includes('--verify') ? { localDev: ['pnpm', 'dev'], compareBase: 'https://pre.example.com' } : null

// 有意改写的行：基线原文 → 当前版本里对应的说法（正则匹配当前全文）。其余行必须原样在。
const REWRITES = [
  [/^3\. 改完自审自己的 diff：`cd .+ && git diff`/, /3\. 改完自审自己的 diff：在当前工作目录 `git diff`/],
  [/Worker 已把本任务命中的 L3 规则原文与指纹放在上方 TRUSTED_RULE_CONTEXT/, /放在 user 消息的 TRUSTED_RULE_CONTEXT/],
  [/^（如需像素级预览，同目录下有 preview-\*\.png。请在 checks 中注明已读取的 spec\.md。）$/, /层级关系与整体观感看同目录的 preview-\*\.png/],
  [/^请在 .+ 中完成任务，并遵守以下文档：$/, /请在 .+ 中完成任务，并遵守以下文档：/],
  // 11-04 b3 stuck：evidence 释义里重复的「禁止补偿手法」清单去重，原文仍在「缺陷根因分诊」；行数上限改成只提醒的参考规模。
  [/^- evidence：\*\*rootCauseLayer 为 backend-/, /^(?=[^]*严禁用其它字段加减反推权威值)[^]*- evidence：[^]*禁止的补偿手法见「缺陷根因分诊」/],
  [/改动行数上限/, /改动行数参考 \d+ 行/],
  [/^- \*\*能不动代码就不动：/, /- \*\*能不动代码就不动：[^]*绝不允许为了凑 diff 而新增\/修改测试文件或其它无关文件（会被当不可信降级）。[^]*或 awaiting_owner_fix \/ blocked（待对应端修）。\*\*/],
]
const norm = (line) => line.replace(/\s+/g, ' ').trim()

const listAudits = (dir) => readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory())
  .flatMap((d) => readdirSync(join(dir, d.name)).filter((n) => n.endsWith('.json')).map((n) => join(dir, d.name, n)))

const baseDir = mkdtempSync(join(tmpdir(), 'lark-replay-base-'))
execFileSync('git', ['worktree', 'add', '--detach', baseDir, baseRef], { cwd: root, stdio: 'pipe' })
try {
  const realBaseDir = realpathSync(baseDir)
  const oldPrompts = await import(join(baseDir, 'lib/lark-worker-prompts.mjs'))
  const newPrompts = await import(join(root, 'lib/lark-worker-prompts.mjs'))
  const { buildFocusedRuleContext, stripAutoLoadedRules } = await import(join(root, 'lib/lark-rule-context.mjs'))
  const rows = []
  const missing = new Map()
  const systems = new Set()
  for (const path of listAudits(auditsDir)) {
    let audit
    try {
      audit = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      continue
    }
    if (!audit?.task?.text) continue
    const task = { id: audit.taskId || 't', project: audit.project, ...audit.task, attachments: audit.attachments || [] }
    const wc = audit.workContext || {}
    const ctx = { projectId: audit.project, projectName: audit.project, projectDocs: [], cwd: wc.cwd || '/repo', hotfixBranch: wc.hotfixBranch || null, baseRef: wc.baseRef || null, sourceBranch: wc.sourceBranch || null, sourceWorktree: wc.sourceWorktree || null }
    const ruleContext = stripAutoLoadedRules(buildFocusedRuleContext({ taskText: task.text, hasImage: task.attachments.some((a) => a?.type === 'image') }))
    const analysis = audit.analysis?.status === 'ready' && Array.isArray(audit.analysis.requirements) ? { ...audit.analysis, applicableRules: audit.analysis.applicableRules || [] } : null
    const variants = [['首轮', { ruleContext, verify }], ...(analysis ? [['分析后', { ruleContext, analysis, verify }], ['续会话', { ruleContext, analysis, verify, followUp: true }]] : [])]
    for (const [variant, options] of variants) {
      // 基线从临时 worktree 加载，提示里 bot 自身路径（边界文档 / 读记录工具）指向那个目录：换回本仓路径再比
      const before = oldPrompts.buildTaskPrompt(ctx, task, 'claude', options).split(realBaseDir).join(root).split(baseDir).join(root)
      const parts = newPrompts.buildTaskPromptParts(ctx, task, 'claude', options)
      const after = norm([parts.system, parts.user].filter(Boolean).join('\n'))
      if (parts.system) systems.add(parts.system)
      const lost = before.split('\n').map(norm).filter(Boolean).filter((line) => !after.includes(line))
        .filter((line) => !REWRITES.some(([from, to]) => from.test(line) && to.test(after)))
      for (const line of lost) missing.set(line, (missing.get(line) || 0) + 1)
      rows.push({ id: `${audit.taskId}-${audit.epoch ?? ''}`, variant, before: before.length, system: parts.system?.length || 0, user: parts.user.length, lost: lost.length })
    }
  }
  const sum = (key, filter = () => true) => rows.filter(filter).reduce((n, row) => n + row[key], 0)
  const avg = (key, filter) => {
    const picked = rows.filter(filter)
    return picked.length ? Math.round(sum(key, filter) / picked.length) : 0
  }
  const report = {
    audits: auditsDir,
    base: baseRef,
    prompts: rows.length,
    tasks: new Set(rows.map((r) => r.id)).size,
    linesLost: [...missing.entries()].map(([line, count]) => ({ count, line: line.slice(0, 160) })),
    distinctSystemLayers: systems.size,
    avgChars: Object.fromEntries(['首轮', '分析后', '续会话'].map((v) => [v, { before: avg('before', (r) => r.variant === v), system: avg('system', (r) => r.variant === v), user: avg('user', (r) => r.variant === v) }])),
  }
  if (argv.includes('--json')) console.log(JSON.stringify(report, null, 2))
  else {
    console.log(`回放 ${report.tasks} 条真实任务、${report.prompts} 份提示（基线 ${baseRef}${verify ? '，配页面工具' : ''}）`)
    console.log(`规则不丢：${report.linesLost.length ? `✖ ${report.linesLost.length} 行在新版里找不到` : '✓ 基线每一行都在新版（系统层 + user）里'}`)
    for (const item of report.linesLost.slice(0, 20)) console.log(`  ×${item.count} ${item.line}`)
    console.log(report.distinctSystemLayers ? `系统层：${report.distinctSystemLayers} 种（应为 1：跨任务逐字相同）` : '系统层：无（只读查询单趟，不走系统层）')
    for (const [variant, v] of Object.entries(report.avgChars)) if (v.before) console.log(`${variant}：基线整份 ${v.before} 字 → 系统层 ${v.system} + user ${v.user}（user 降 ${Math.round((1 - v.user / v.before) * 100)}%）`)
  }
  process.exitCode = report.linesLost.length || report.distinctSystemLayers > 1 ? 1 : 0
} finally {
  execFileSync('git', ['worktree', 'remove', '--force', baseDir], { cwd: root, stdio: 'pipe' })
  if (existsSync(baseDir)) rmSync(baseDir, { recursive: true, force: true })
}
