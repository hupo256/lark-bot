/**
 * Lark Gateway 的 bug 表回写层：done 后把记录状态改为约定完成值、领取即置「修复中」、
 * 回写失败挂起后的定时重试，以及项目通知日志追加。写失败仅告警不阻塞任务。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { docsDir } from './lark-repo.mjs'
import { buildCardContent } from './lark-cards.mjs'
import { runLarkCliWithRetry, sendChatMessage } from './lark-cli.mjs'

// 通用 bug 表状态回写：patch statusField=value，返回 runLarkCliWithRetry 的 outcome。
// 完成回写与领取置「修复中」共用这一条底层调用，避免两处拼 lark-cli 参数漂移。
const patchBugRecordStatus = ({ config, task, value }) => {
  const bug = config.bugTable
  return runLarkCliWithRetry(
    [
      'base', '+record-batch-update',
      '--base-token', bug.appToken,
      '--table-id', bug.tableId,
      '--json',
      JSON.stringify({ record_id_list: [task.recordId], patch: { [bug.statusField]: value } }),
    ],
    { logPrefix: `bug status ${task.recordId} -> ${value}` },
  )
}

// done 后把记录状态从「待处理」改为约定完成值。回写失败发群告警并返回 ok:false，
// 交由调用方置 done_pending_writeback 后定时重试，避免「群报完成 + 表格永卡待处理」。
export const writeBackBugRecord = async ({ config, task }) => {
  const bug = config.bugTable
  if (!bug?.appToken || !bug?.tableId || !task.recordId) return { ok: true } // 无表可写，视作无需回写
  // doneValue 缺失就不写：文档 §5.3 明确「处理中」非合法枚举，写非法值只会让 lark-cli 报错
  if (!bug.doneValue) {
    console.warn('[lark-gateway] bug write-back skipped: config.bugTable.doneValue 未配置，不写非法值')
    return { ok: true } // 配置缺失是人工要处理的另一回事，不该把任务永卡中间态
  }

  const outcome = await patchBugRecordStatus({ config, task, value: bug.doneValue })
  if (outcome.ok) return { ok: true }

  await sendChatMessage({
    chatId: task.chatId,
    card: buildCardContent({
      config,
      kind: 'alert',
      lines: [`**详情**：记录 ${task.recordId} 状态回写「${bug.doneValue}」失败，将自动重试；如持续失败请手动在 bug 表改状态。原因：${outcome.reason}`],
    }),
    logPrefix: 'writeback alert',
    idempotencyKey: `${task.recordId}-writeback-alert`,
  })
  return { ok: false, reason: outcome.reason }
}

// 领取即把 bug 记录置「修复中」（inProgressValue），让表格实时反映“正在处理”。
// best-effort：知会性状态，写失败仅告警日志、绝不阻塞任务或改任务态。
export const markBugRecordInProgress = async ({ config, task }) => {
  const bug = config.bugTable
  if (!bug?.appToken || !bug?.tableId || !task.recordId || !bug.inProgressValue) return
  const outcome = await patchBugRecordStatus({ config, task, value: bug.inProgressValue })
  if (!outcome.ok) console.warn(`[lark-gateway] bug 置「${bug.inProgressValue}」失败（不阻塞任务）：${outcome.reason}`)
}

// 回写失败挂起的 bug 任务（done_pending_writeback）：定时器重试回写，成功后才落地 done。
export const retryPendingWriteback = async ({ config, store }) => {
  const pending = store.list().filter((task) => task.status === 'done_pending_writeback')
  for (const task of pending) {
    const wb = await writeBackBugRecord({ config, task })
    if (wb.ok) {
      task.status = 'done'
      store.upsert(task)
      console.log(`[lark-gateway] 回写重试成功，${task.id} 落地 done`)
    }
  }
}

export const appendNotificationLog = ({ config, row }) => {
  const logPath = join(docsDir(config.project), 'agent/notification-log.md')
  if (!existsSync(logPath)) return
  const content = readFileSync(logPath, 'utf8')
  const marker = '\n## 规则'
  const next = content.includes(marker)
    ? content.replace(marker, `${row}\n${marker}`)
    : `${content.trimEnd()}\n${row}\n`
  writeFileSync(logPath, next)
}
