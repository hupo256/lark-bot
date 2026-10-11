/**
 * Lark Worker 的任务审计层：每次执行在 runtime/lark-audits/<项目>/ 落 <id>-e<epoch>.json/.log，
 * 并顺手清理超留存期的旧审计。纯本地痕迹，全程吞异常、绝不阻断任务本身。
 */

import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { auditDirFor, larkAuditsRoot } from './lark-paths.mjs'
import { auditRetentionMs } from './lark-worker-env.mjs'
import { safeProject } from './lark-work-context.mjs'

const safeAuditFilePart = (raw) => String(raw || 'task').replace(/[^\w.-]+/g, '_').slice(0, 120) || 'task'

// 审计留存：worker 每跑一个任务时扫所有项目的 lark-audits/，按 mtime 删掉超过留存期（默认 7 天）的文件，
// 避免占满磁盘。清理全程吞异常，绝不阻断任务本身。
// root 默认必须是 larkAuditsRoot（= runtime/lark-audits）：本函数只看 root 的**直接子目录**（每个项目一个），
// 必须与 createTaskAudit 的落盘口径 auditDirFor(project) = <larkAuditsRoot>/<项目>/ 同一个根。
// 根一旦错位（如扫 runtime/ 或别的仓），一个审计文件都匹配不到 → 清理器静默空转、审计目录无上限增长。
export const pruneStaleAudits = (root = larkAuditsRoot, retentionMs = auditRetentionMs) => {
  if (!retentionMs) return
  const cutoff = Date.now() - retentionMs
  let projectDirs = []
  try {
    projectDirs = readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of projectDirs) {
    if (!entry.isDirectory()) continue
    const auditDir = join(root, entry.name)
    let files = []
    try {
      files = readdirSync(auditDir)
    } catch {
      continue // 该项目没有审计目录
    }
    for (const name of files) {
      const filePath = join(auditDir, name)
      try {
        // recursive：审计目录里除了 .json/.log，还有 figma 预取落盘的 <fileKey-node>/ 子目录，
        // 过期时一并清掉（对非空目录 rmSync 不加 recursive 会抛）。
        if (statSync(filePath).mtimeMs < cutoff) rmSync(filePath, { recursive: true, force: true })
      } catch {
        // 单个文件清理失败（权限/并发删除）不影响其余文件与任务
      }
    }
  }
}

// 审计 JSON 落盘（0o600 私有）：createTaskAudit/updateTaskAudit 共用。
const writeAuditJson = (context) => {
  writeFileSync(context.jsonPath, `${JSON.stringify(context.record, null, 2)}\n`, { mode: 0o600 })
}

export const createTaskAudit = ({ workerConfig, task, workContext, executor }) => {
  pruneStaleAudits()
  const auditProject = safeProject(workContext.projectId) || safeProject(workerConfig.projectId) || '_adhoc'
  // 与 pruneStaleAudits 的 larkAuditsRoot 口径一致（都走 runtime/lark-audits/<项目>）：
  // 一旦这里手拼别的根、清理器扫 larkAuditsRoot，写入的审计就永远清不掉、无上限堆积。
  const auditDir = auditDirFor(auditProject)
  // retry / 补料 / QA 验退都会 bump epoch；文件名带 epoch，避免新一轮覆盖上一轮 JSON/CLI 日志。
  const basename = safeAuditFilePart(`${task.id}-e${task.epoch || 0}`)
  mkdirSync(auditDir, { recursive: true })
  const context = {
    jsonPath: join(auditDir, `${basename}.json`),
    logPath: join(auditDir, `${basename}.log`),
    record: {
      schemaVersion: 2,
      assuranceMode: 'lark-lightweight',
      deliveryAuthority: false,
      deliveryAuthorityReason: 'Lark done 仅代表本地候选修复；项目正式交付以 v3.3 authoritative PASS 为准',
      taskId: task.id,
      epoch: task.epoch || 0,
      qaReturnCount: task.qaReturnCount || 0,
      project: task.project || workContext.projectId,
      executor,
      status: 'started',
      startedAt: new Date().toISOString(),
      task: {
        summary: task.summary,
        text: task.text,
        source: task.source,
        chatId: task.chatId,
        messageId: task.messageId,
      },
      workContext: {
        cwd: workContext.cwd,
        hotfixBranch: workContext.hotfixBranch || null,
        baseRef: workContext.baseRef || null,
        sourceBranch: workContext.sourceBranch || null,
        sourceWorktree: workContext.sourceWorktree || null,
      },
      attachments: (task.attachments || []).map((item) => ({
        type: item.type,
        imageKey: item.imageKey,
        localPath: item.localPath,
        width: item.width,
        height: item.height,
        downloadError: item.downloadError,
      })),
      rules: null,
      analysis: null,
      finalVerification: null,
      commit: null,
      final: null,
      error: null,
    },
  }
  writeAuditJson(context)
  return context
}

export const updateTaskAudit = (context, patch) => {
  if (!context) return
  Object.assign(context.record, patch, { updatedAt: new Date().toISOString() })
  writeAuditJson(context)
}
