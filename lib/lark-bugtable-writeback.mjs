/**
 * Lark Gateway 的 bug 表回写层：done 后把记录状态改为约定完成值、领取即置「修复中」、
 * 回写失败挂起后的定时重试，以及项目通知日志追加。写失败仅告警不阻塞任务。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { docsDir } from './lark-repo.mjs'
import { buildCardContent } from './lark-cards.mjs'
import { runLarkCliWithRetry, sendChatMessage } from './lark-cli.mjs'
import { resolveCommandType, isReadOnlyCommand } from './lark-message.mjs'

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
  const { type, source } = resolveCommandType(task)
  const readOnly = isReadOnlyCommand(type)
  // 推断来源（非显式前缀）的只读判定绝不写回完成值：万一把真 bug 误判成 status，
  // 写「已处理」会让记录离开待处理筛选、再无人复核（P0-1）。显式前缀才是权威口径。
  // 正常路径下 bug 表已是显式 only，此处是纵深防御，兜住任何 inferred 来源的意外回写。
  if (readOnly && source === 'inferred') {
    console.warn(`[lark-gateway] ${task.id} 只读判定来自自然语言推断（非显式前缀），跳过完成值回写，保留 bug 表原状态待人工复核`)
    return { ok: true }
  }
  const doneValue = readOnly ? (bug.readOnlyDoneValue || bug.doneValue) : bug.doneValue
  // doneValue 缺失就不写：文档 §5.3 明确「处理中」非合法枚举，写非法值只会让 lark-cli 报错
  if (!doneValue) {
    console.warn(`[lark-gateway] bug write-back skipped: config.bugTable.${readOnly ? 'readOnlyDoneValue/doneValue' : 'doneValue'} 未配置，不写非法值`)
    return { ok: true } // 配置缺失是人工要处理的另一回事，不该把任务永卡中间态
  }
  if (readOnly && !bug.readOnlyDoneValue) {
    console.warn(`[lark-gateway] status 查询未配置 readOnlyDoneValue，兼容回写 doneValue「${bug.doneValue}」；建议配置独立“已处理/无需推版”状态`)
  }

  const outcome = await patchBugRecordStatus({ config, task, value: doneValue })
  if (outcome.ok) return { ok: true }

  await sendChatMessage({
    chatId: task.chatId,
    card: buildCardContent({
      config,
      kind: 'alert',
      lines: [`**详情**：记录 ${task.recordId} 状态回写「${doneValue}」失败，将自动重试；如持续失败请手动在 bug 表改状态。原因：${outcome.reason}`],
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
  const value = isReadOnlyCommand(resolveCommandType(task).type)
    ? (bug?.queryingValue || bug?.inProgressValue)
    : bug?.inProgressValue
  if (!bug?.appToken || !bug?.tableId || !task.recordId || !value) return
  const outcome = await patchBugRecordStatus({ config, task, value })
  if (!outcome.ok) console.warn(`[lark-gateway] bug 置「${value}」失败（不阻塞任务）：${outcome.reason}`)
}

// waiting/blocked 是可恢复的业务暂停，不是失败。配置了 waitingValue 时同步到表格；未配置则只保留
// Gateway 真值与橙色卡片，避免写入 Base 中不存在的单选值。
export const markBugRecordWaiting = async ({ config, task }) => {
  const bug = config.bugTable
  if (!bug?.appToken || !bug?.tableId || !task.recordId || !bug.waitingValue) return
  const outcome = await patchBugRecordStatus({ config, task, value: bug.waitingValue })
  if (!outcome.ok) console.warn(`[lark-gateway] bug 置「${bug.waitingValue}」失败（不阻塞续跑）：${outcome.reason}`)
}

// 回写重试上限：默认 12 次。定时器每 5min 跑一轮 ⇒ 约 1 小时。
// 上限存在的理由：回写失败往往是配置/权限/记录被删这类**重试永远不会成功**的原因，
// 无上限就变成永久后台请求，静默到没人知道。到上限就停手 + 升级告警，把问题交回给人。
const maxWritebackAttempts = Number(process.env.LARK_WRITEBACK_MAX_ATTEMPTS || 12)

/**
 * 回写重试一轮之后的状态判定（纯函数，可直测）。三种出口，**没有第四种**：
 * - 回写成功 → `done`（这才是完成态：群里说完成 ⇔ 表格也已完成）；
 * - 未到上限 → 继续停在 `done_pending_writeback`，下轮再试；
 * - 到上限 → 仍停在 `done_pending_writeback` 并置 `gaveUp`，等人改表格（理由见调用处注释）。
 * @param {{ ok: boolean, attempts?: number, max?: number }} input
 */
export const resolveWritebackOutcome = ({ ok, attempts = 0, max = maxWritebackAttempts }) => {
  if (ok) return { status: 'done', attempts: 0, gaveUp: false, retry: false }
  const next = attempts + 1
  return { status: 'done_pending_writeback', attempts: next, gaveUp: next >= max, retry: next < max }
}

// 回写失败挂起的 bug 任务（done_pending_writeback）：定时器重试回写，成功后才落地 done。
// 已放弃重试的（writebackGaveUp）不再参与，避免上限形同虚设。
export const retryPendingWriteback = async ({ config, store }) => {
  const pending = store.list().filter((task) => task.status === 'done_pending_writeback' && !task.writebackGaveUp)
  for (const task of pending) {
    const wb = await writeBackBugRecord({ config, task })
    const outcome = resolveWritebackOutcome({ ok: wb.ok, attempts: task.writebackAttempts })
    // 表格回写已恢复、但结果卡仍未送达时，不能提前进入可清理的 done；交给回执重试落最终态。
    task.status = wb.ok && task.pendingReceipt ? 'result_pending_receipt' : outcome.status
    task.writebackAttempts = outcome.attempts
    if (wb.ok) {
      store.upsert(task)
      console.log(`[lark-gateway] 回写重试成功，${task.id} 落地 done`)
      continue
    }
    if (outcome.retry) {
      store.upsert(task)
      continue
    }
    // 达上限：停止重试，但**状态停在 done_pending_writeback，不落 done**。
    // 曾经落 done：代码确实提交了，看着合理——代价是这条「群里说完成、bug 表还挂着待处理」的
    // 不一致当场消失（done 会被 prune 每小时清掉、/lark/health 计数里也不再点名），只剩一条
    // 没人回看的日志。停在中间态则相反：它不在任何终态清理列表里，health 会一直报，直到人改了表格
    // （人工改完可用 `lark-bot retry` / 重开走正常落地）。「已提交但表格没写上」本身就不是完成态。
    task.writebackGaveUp = true
    store.upsert(task)
    console.error(`[lark-gateway] ⚠ ${task.id} 回写重试 ${task.writebackAttempts} 次仍失败，停止重试并保持 done_pending_writeback，需人工改表格：${wb.reason}`)
    await sendChatMessage({
      chatId: task.chatId,
      card: buildCardContent({
        config,
        kind: 'alert',
        lines: [
          `**详情**：记录 ${task.recordId} 的状态回写已重试 ${task.writebackAttempts} 次仍失败，已停止重试。`,
          '代码改动本身已完成并提交，**只是 bug 表状态字段没写上**，请手动把该记录改为完成态。',
          `任务保持 \`done_pending_writeback\`（不算完成态、不会被自动清理），改完表格前 /lark/health 会持续提示。`,
          `原因：${wb.reason}`,
        ],
      }),
      logPrefix: 'writeback giveup',
      idempotencyKey: `${task.recordId}-wb-giveup`,
    })
  }
}

// 通知日志按任务实际项目归位：优先写 task.project 的日志，其不存在时回落到 gateway 宿主项目
// （config.project）的日志；两者都无则维持 no-op（与原行为一致，不静默丢到别处）。
// 曾经恒定写 config.project，跨项目群任务/bug 表任务的审计行会全部错记到宿主项目名下。
const resolveNotificationLogPath = ({ config, project }) => {
  const seen = new Set()
  for (const candidate of [project, config.project]) {
    if (!candidate || seen.has(candidate)) continue
    seen.add(candidate)
    const logPath = join(docsDir(candidate), 'agent/notification-log.md')
    if (existsSync(logPath)) return logPath
  }
  return null
}

// 加界：通知日志只 append 从不清理，长期单调膨胀。只保留 `## 规则` 之前最近 max 条**数据行**
// （表头/分隔行永远保留），丢弃最旧的。表结构异常（找不到分隔行）时不裁剪，避免误删正文。
export const capNotificationRows = (content, max = 300) => {
  const lines = content.split('\n')
  const isPipe = (line) => line.trimStart().startsWith('|')
  const isSeparator = (line) => isPipe(line) && /^\s*\|[\s|:-]+\|?\s*$/.test(line) && line.includes('-')
  const sepIdx = lines.findIndex(isSeparator)
  if (sepIdx < 0) return content
  const dataIdx = []
  for (let i = sepIdx + 1; i < lines.length; i += 1) {
    if (isPipe(lines[i])) dataIdx.push(i)
  }
  if (dataIdx.length <= max) return content
  const drop = new Set(dataIdx.slice(0, dataIdx.length - max))
  return lines.filter((_, i) => !drop.has(i)).join('\n')
}

export const appendNotificationLog = ({ config, project, row }) => {
  const logPath = resolveNotificationLogPath({ config, project })
  if (!logPath) return
  const content = readFileSync(logPath, 'utf8')
  const marker = '\n## 规则'
  const appended = content.includes(marker)
    ? content.replace(marker, `${row}\n${marker}`)
    : `${content.trimEnd()}\n${row}\n`
  writeFileSync(logPath, capNotificationRows(appended))
}
