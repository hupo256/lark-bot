/**
 * Lark Gateway 的事件摄入层：把长连接事件归一为任务——白名单/@bot 判定、waiting/blocked 续任务补料、
 * 引用消息合并、附件下载、项目号路由、建 task 并发排队卡与通知日志。含并发占位防 TOCTOU 双跑。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot, worktreesDir } from './lark-repo.mjs'
import { resolveAiExecutor } from './lark-ai-executor.mjs'
import {
  isForBot,
  isWhitelisted,
  normalizeMessage,
  parseCommandType,
  parseProjectFromText,
  summarize,
} from './lark-message.mjs'
import { buildQueuedCard, formatDisplayTime } from './lark-cards.mjs'
import {
  downloadAttachments,
  fetchReferencedContext,
  isChatMember,
  resolveChatName,
  sendChatMessage,
} from './lark-cli.mjs'
import { appendNotificationLog } from './lark-bugtable-writeback.mjs'

// 群消息可用 `[codex]` / `[claude]` 临时覆盖本机默认；只返回固定枚举，不接受命令参数。
export const parseAiExecutorDirective = (text) => {
  const match = String(text || '').match(/^\s*\[(codex|claude)\]/i)
  return match ? match[1].toLowerCase() : undefined
}

// 排队卡必须展示任务最终会用的执行器，不能等 Worker 领取后才补写。
export const resolveGatewayAiExecutor = ({ requestedExecutor, config, env = process.env }) =>
  resolveAiExecutor({ localConfig: config }, { aiExecutor: requestedExecutor }, env)

// 项目号解析优先级：群名 `[PR-xxxxx]`（权威）> 正文 PR-####。都无则返回 null，
// 由调用方回落到「主仓临时 hotfix 分支」。群名优先是因为正文常引用别的工单号会路由到错项目。
const resolveProject = async ({ chatId, text }) => {
  const fromChatName = parseProjectFromText(await resolveChatName(chatId))
  return fromChatName || parseProjectFromText(text) || null
}

// auto 成员制白名单需查 bot 是否在该群（仅群消息且 auto 模式才查，避免无谓网络调用）
const resolveMembership = async ({ msg, config }) =>
  config.allowedChatIds === 'auto' && msg.chatType !== 'p2p' ? isChatMember(msg.chatId) : false

// 正在摄入中的 messageId（同步占位，防 TOCTOU 双跑）：lark-cli 可能把同一事件投递两次，
// 两个 onLine 并发进 ingest 会各自在 `store.has` 后、`store.upsert` 前的 await 窗口里都判为「新」。
// 此 Set 在任何 await 前同步占位，只有首个能进入；持久化后由 store.has 接管去重。
const ingestingMessageIds = new Set()

export const ingestLarkEvent = async ({ raw, config, store }) => {
  const msg = normalizeMessage(raw)
  if (!msg || store.has(msg.messageId) || ingestingMessageIds.has(msg.messageId)) return // 非消息事件 / 幂等 / 并发占位
  ingestingMessageIds.add(msg.messageId)
  try {
    await ingestWhitelistedEvent({ msg, config, store })
  } finally {
    ingestingMessageIds.delete(msg.messageId)
  }
}

const ingestWhitelistedEvent = async ({ msg, config, store }) => {
  const isMember = await resolveMembership({ msg, config })
  if (!isWhitelisted({ msg, config, isMember }) || !isForBot({ msg, config })) return
  if (!msg.text && !msg.attachments.length && !msg.replyTo) return

  // waiting_confirmation / blocked 续任务：本条是对一条仍卡在待确认/阻塞的原任务的回复补料时，
  // 复用原任务续跑（append 补料 + 复用原分支/worktree），而不是新建一个孤儿任务。
  const parentTask = msg.replyTo ? store.get(msg.replyTo) : null
  if (parentTask && (parentTask.status === 'waiting_confirmation' || parentTask.status === 'blocked')) {
    const supplementAttachments = await downloadAttachments({
      repoRoot,
      project: parentTask.project || config.project,
      messageId: msg.messageId,
      attachments: msg.attachments,
    })
    const resumed = store.resumeWithSupplement({ id: parentTask.id, supplementText: msg.text, supplementAttachments })
    if (resumed) {
      console.log(`[lark-gateway] resumed task ${resumed.id} with supplement（第 ${resumed.resumeCount} 次续跑）: ${msg.text?.slice(0, 60) || '(仅附件)'}`)
      await sendChatMessage({
        chatId: resumed.chatId,
        card: buildQueuedCard({ config, task: resumed, note: '**说明**：已收到补充材料，续跑原任务（复用原分支/worktree）。' }),
        logPrefix: 'resume receipt',
        idempotencyKey: `${resumed.id}-resume-${resumed.resumeCount}`,
      })
      return
    }
  }

  // 合并被引用/被回复消息（真正的 bug 正文与截图多在父消息里）
  const refCtx = msg.replyTo ? await fetchReferencedContext(msg.replyTo) : null
  const mergedText = refCtx?.text
    ? `【被引用消息】\n${refCtx.text}\n\n【本条 @】${msg.text || '（无附言）'}`.trim()
    : msg.text
  const project = await resolveProject({ chatId: msg.chatId, text: mergedText })
  // 附件跟任务实际项目落盘；跨项目群任务不再错误写进 gateway 默认项目目录。
  const attachmentProject = project || config.project
  const resolvedAttachments = await downloadAttachments({
    repoRoot,
    project: attachmentProject,
    messageId: msg.messageId,
    attachments: msg.attachments,
  })
  const refAttachments = refCtx?.attachments?.length
    ? await downloadAttachments({ repoRoot, project: attachmentProject, messageId: msg.replyTo, attachments: refCtx.attachments })
    : []
  const attachments = [...resolvedAttachments, ...refAttachments]

  const worktreeExists = project ? existsSync(join(worktreesDir, project)) : false
  const requestedExecutor = parseAiExecutorDirective(msg.text)
  const aiExecutor = resolveGatewayAiExecutor({ requestedExecutor, config })

  const task = store.upsert({
    id: msg.messageId,
    source: 'lark',
    chatId: msg.chatId,
    messageId: msg.messageId,
    operator: msg.senderOpenId,
    project: project || null,
    commandType: parseCommandType(mergedText),
    projectTitle: config.title,
    text: mergedText,
    // 卡片「任务」摘要优先展示用户本条附言，其次被引用消息首行
    summary: summarize(msg.text?.trim() ? msg.text : refCtx?.text || ''),
    attachments,
    aiExecutor,
    status: 'queued',
    createdAt: new Date().toISOString(),
  })

  // 无 worktree（有项目号或 adhoc）统一走临时 hotfix worktree，不再发「请选择处理方式」卡片
  const note = worktreeExists
    ? undefined
    : project
      ? `**说明**：本地无 ${project} worktree，将用临时 hotfix 分支处理。`
      : '**说明**：未识别项目号（群名/正文均无），将用临时 hotfix 分支处理。'
  console.log(`[lark-gateway] queued task ${task.id} (${project || 'adhoc'})${worktreeExists ? '' : ' [temp-worktree]'}: ${task.summary}`)
  await sendChatMessage({ chatId: task.chatId, card: buildQueuedCard({ config, task, note }), logPrefix: 'queued receipt', idempotencyKey: `${task.id}-queued` })
  appendNotificationLog({
    config,
    row: `| ${formatDisplayTime()} | Lark Job | 进行中 | 收到群任务(${project || 'adhoc'})：${task.summary} | real | success |`,
  })
}
