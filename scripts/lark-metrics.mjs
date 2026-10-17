#!/usr/bin/env node
/**
 * 运行指标（升级计划第 0 批）：从任务文件 + 审计目录算出基线表那几项，改前改后对照用。
 *   node scripts/lark-metrics.mjs [--json] [--repo falive] [--days 7] [--runtime <dir>]
 * 指标：消息→分类完成（p50/p90）、任务 wall（p50/p90/max）、Claude 调用次数与每任务次数、
 *       分析 / 实施两趟时长、forMe 需确认占比、分类 ignore 占比。只读，不碰 gateway。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { larkRuntimeDir } from '../lib/lark-paths.mjs'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : fallback
}
const asJson = args.includes('--json')
const days = Number(flag('--days', 7))
const repoKey = flag('--repo', null)
const sinceMs = Date.now() - days * 24 * 3600_000
// --runtime：指定别的 runtime 目录（在 worktree 里跑脚本看运行中那份数据）。
const runtimeDir = flag('--runtime', larkRuntimeDir)

const pct = (values, q) => {
  const sorted = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b)
  if (!sorted.length) return null
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]
}
const sec = (ms) => (ms == null ? '-' : `${Math.round(ms / 1000)}s`)

// 任务文件：入口延迟、分类结果分布
const tasksDir = join(runtimeDir, 'lark-tasks')
const tasks = existsSync(tasksDir)
  ? readdirSync(tasksDir).filter((name) => name.endsWith('.json')).flatMap((name) => {
      try {
        return [JSON.parse(readFileSync(join(tasksDir, name), 'utf8'))]
      } catch {
        return []
      }
    })
  : []
const recentTasks = tasks.filter((task) => Date.parse(task.createdAt || 0) >= sinceMs && (!repoKey || task.repo === repoKey))
const intakeLatency = recentTasks.map((task) => (task.intake?.resolvedAt && task.createdAt ? Date.parse(task.intake.resolvedAt) - Date.parse(task.createdAt) : NaN))
const classified = recentTasks.filter((task) => task.intake?.classification)
const forMe = classified.filter((task) => task.intake.classification.forMe)
const ignored = classified.filter((task) => task.intake.classification.decision === 'ignore')
const needConfirm = forMe.filter((task) => task.intake.classification.confidence !== 'high')

// 审计：每任务 Claude 调用次数、分析 / 实施时长、任务 wall
const auditsRoot = join(runtimeDir, 'lark-audits')
const auditDirs = existsSync(auditsRoot) ? readdirSync(auditsRoot).map((name) => join(auditsRoot, name)).filter((dir) => { try { return readdirSync(dir).length > 0 } catch { return false } }) : []
const runsPerTask = new Map()
const firstCallMs = []
const secondCallMs = []
const wallMs = []
for (const dir of auditDirs) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (name.endsWith('.log')) {
      let text
      try {
        text = readFileSync(path, 'utf8')
      } catch {
        continue
      }
      const results = [...text.matchAll(/"type":"result"[^\n]*"duration_ms":(\d+)/g)].map((match) => Number(match[1]))
      if (!results.length) continue
      const taskId = name.replace(/-e\d+\.log$/, '')
      runsPerTask.set(taskId, (runsPerTask.get(taskId) || 0) + results.length)
      if (/-e[1-9]\d*\.log$/.test(name)) {
        if (results[0]) firstCallMs.push(results[0])
        if (results[1]) secondCallMs.push(results[1])
      }
    } else if (name.endsWith('.json')) {
      try {
        const record = JSON.parse(readFileSync(path, 'utf8'))
        if (record.startedAt && record.completedAt && Date.parse(record.startedAt) >= sinceMs && (!repoKey || record.repo === repoKey)) {
          wallMs.push(Date.parse(record.completedAt) - Date.parse(record.startedAt))
        }
      } catch {
        // 跳过坏文件
      }
    }
  }
}
const runs = [...runsPerTask.values()]

const metrics = {
  window: { days, since: new Date(sinceMs).toISOString(), repo: repoKey },
  intake: {
    tasks: recentTasks.length,
    classified: classified.length,
    ignoredRatio: classified.length ? Number((ignored.length / classified.length).toFixed(2)) : null,
    forMe: forMe.length,
    forMeNeedConfirm: needConfirm.length,
    latencyP50Ms: pct(intakeLatency, 0.5),
    latencyP90Ms: pct(intakeLatency, 0.9),
  },
  execution: {
    tasksWithRuns: runs.length,
    claudeRuns: runs.reduce((sum, value) => sum + value, 0),
    runsPerTaskP50: pct(runs, 0.5),
    runsPerTaskMax: runs.length ? Math.max(...runs) : null,
    firstCallP50Ms: pct(firstCallMs, 0.5),
    secondCallP50Ms: pct(secondCallMs, 0.5),
    wallP50Ms: pct(wallMs, 0.5),
    wallP90Ms: pct(wallMs, 0.9),
    wallMaxMs: wallMs.length ? Math.max(...wallMs) : null,
  },
}

if (asJson) {
  console.log(JSON.stringify(metrics))
} else {
  const rows = [
    ['消息 → 分类完成', `p50 ${sec(metrics.intake.latencyP50Ms)} / p90 ${sec(metrics.intake.latencyP90Ms)}（${metrics.intake.classified} 条）`],
    ['分类 ignore 占比', metrics.intake.ignoredRatio == null ? '-' : `${Math.round(metrics.intake.ignoredRatio * 100)}%`],
    ['forMe 需确认', `${metrics.intake.forMeNeedConfirm} / ${metrics.intake.forMe}`],
    ['Claude 调用', `${metrics.execution.claudeRuns} 次，${metrics.execution.tasksWithRuns} 个任务，每任务 p50 ${metrics.execution.runsPerTaskP50 ?? '-'} / max ${metrics.execution.runsPerTaskMax ?? '-'}`],
    ['分析 / 实施两趟', `p50 ${sec(metrics.execution.firstCallP50Ms)} + ${sec(metrics.execution.secondCallP50Ms)}`],
    ['任务 wall', `p50 ${sec(metrics.execution.wallP50Ms)} / p90 ${sec(metrics.execution.wallP90Ms)} / max ${sec(metrics.execution.wallMaxMs)}`],
  ]
  console.log(`lark-bot 指标（最近 ${days} 天${repoKey ? `，repo ${repoKey}` : ''}）`)
  for (const [label, value] of rows) console.log(`  ${label.padEnd(14, '　')}${value}`)
}
