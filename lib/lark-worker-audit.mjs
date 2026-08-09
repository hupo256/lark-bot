/**
 * Lark Worker 的任务审计层：每任务在 <项目>/agent/lark-audits/ 落 <id>.json + <id>.log（只增不减），
 * 并顺手清理超留存期的旧审计。纯本地痕迹，全程吞异常、绝不阻断任务本身。
 */

import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { auditRetentionMs, docsSystemRoot } from './lark-worker-env.mjs'
import { safeProject } from './lark-work-context.mjs'

const safeAuditFilePart = (raw) => String(raw || 'task').replace(/[^\w.-]+/g, '_').slice(0, 120) || 'task'

// 审计留存：worker 每跑一个任务时扫所有项目的 lark-audits/，按 mtime 删掉超过留存期（默认 7 天）的文件，
// 避免占满磁盘。清理全程吞异常，绝不阻断任务本身。
export const pruneStaleAudits = (root = docsSystemRoot, retentionMs = auditRetentionMs) => {
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
    const auditDir = join(root, entry.name, 'agent/lark-audits')
    let files = []
    try {
      files = readdirSync(auditDir)
    } catch {
      continue // 该项目没有审计目录
    }
    for (const name of files) {
      const filePath = join(auditDir, name)
      try {
        if (statSync(filePath).mtimeMs < cutoff) rmSync(filePath, { force: true })
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
  const auditDir = join(docsSystemRoot, auditProject, 'agent/lark-audits')
  const basename = safeAuditFilePart(task.id)
  mkdirSync(auditDir, { recursive: true })
  const context = {
    jsonPath: join(auditDir, `${basename}.json`),
    logPath: join(auditDir, `${basename}.log`),
    record: {
      schemaVersion: 1,
      taskId: task.id,
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
