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

// 回写重试上限：默认 12 次。定时器每 5min 跑一轮 ⇒ 约 1 小时。
// 上限存在的理由：回写失败往往是配置/权限/记录被删这类**重试永远不会成功**的原因，
// 无上限就变成永久后台请求 + 任务永卡 done_pending_writeback（prune 也清不到、counts 里看不见），
// 静默到没人知道。到上限就落地 + 升级告警，把问题交回给人。
const maxWritebackAttempts = Number(process.env.LARK_WRITEBACK_MAX_ATTEMPTS || 12)

// 回写失败挂起的 bug 任务（done_pending_writeback）：定时器重试回写，成功后才落地 done。
export const retryPendingWriteback = async ({ config, store }) => {
  const pending = store.list().filter((task) => task.status === 'done_pending_writeback')
  for (const task of pending) {
    const wb = await writeBackBugRecord({ config, task })
    if (wb.ok) {
      task.status = 'done'
      task.writebackAttempts = 0
      store.upsert(task)
      console.log(`[lark-gateway] 回写重试成功，${task.id} 落地 done`)
      continue
    }
    task.writebackAttempts = (task.writebackAttempts || 0) + 1
    if (task.writebackAttempts < maxWritebackAttempts) {
      store.upsert(task)
      continue
    }
    // 达上限：代码改动早已提交、任务实质已完成，卡住的只是 bug 表那个状态字段。
    // 故落地 done（不是 failed——failed 会误导人以为改动没做）并升级告警，请人手动改表格。
    task.status = 'done'
    task.writebackGaveUp = true
    store.upsert(task)
    console.error(`[lark-gateway] ⚠ ${task.id} 回写重试 ${task.writebackAttempts} 次仍失败，停止重试并落地 done，需人工改表格：${wb.reason}`)
    await sendChatMessage({
      chatId: task.chatId,
      card: buildCardContent({
        config,
        kind: 'alert',
        lines: [
          `**详情**：记录 ${task.recordId} 的状态回写已重试 ${task.writebackAttempts} 次仍失败，已停止重试。`,
          '代码改动本身已完成并提交，**只是 bug 表状态字段没写上**，请手动把该记录改为完成态。',
          `原因：${wb.reason}`,
        ],
      }),
      logPrefix: 'writeback giveup',
      idempotencyKey: `${task.recordId}-wb-giveup`,
    })
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
