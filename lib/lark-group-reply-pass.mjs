/**
 * 群里答应过下文、执行器却没写群回复（10-23 #79）：续实施会话只补写群回复，结论照常回群。
 *
 * 10-23 真机：Encone @bot「我测试 API 开播正常，但是界面 web 开播 500」，bot 先回「…查完回你」；执行器查清了（结论在 result），
 * 但 groupReply / report 都填了 null，网关按「没写群回复不发群」什么都没发，群里的承诺没有下文。
 * 做法同 runVerifyPass（续会话补测一轮）：执行器上下文都在，由它按结果写一段给对方的人话；只 claude 有会话可续。
 * 补写也没成的，网关把人话化的结论作为草稿私聊负责人（held，回「就这样回」发群），见 lark-repo-delivery。
 */

import { execAiExecutor } from './lark-ai-executor.mjs'

// 结论照常回群的终态（decideGroupReply 的 post 分支）；失败 / 阻塞另有出口，不在这里补。
const POSTABLE = new Set(['done', 'done_with_warnings', 'no_change_needed'])
const hasText = (value) => typeof value === 'string' && value.trim().length > 0

// 欠群里一个结论：仓库任务、群里回过「收到」、终态可发群、执行侧没显式判群里无事可说、群回复和结构化 report 都没写。
export const owesGroupReply = ({ task, result }) => Boolean(task?.repo && task.ackedInGroup && result && POSTABLE.has(result.status) &&
  !result.groupSilent && !hasText(result.groupReply) && !result.report)

export const buildGroupReplyPassPrompt = ({ task }) => `群里已经回过对方「${task.ackReply || '收到'}」，答应了给他下文，但你的结果里 groupReply 和 report 都是 null，群里会没有下文。现在只补这一项：
1. 不改任何代码 / 文档，不再查，用你已经查到的结论。
2. 按原来的结果格式整份重写结果文件，其余字段照旧；groupReply 写给对方看的一段人话：先接住他这句，再一两句说结论（原因是什么、他那边要不要做什么、我们这边做到哪）。不写分支名、提交号、文件路径、内部状态；细节已在 detailDoc 的不重复。`

// 返回 true = 补上了（aiRun.result 已并入新的 groupReply / report）；false = 不欠、没会话可续或补写失败。exec 供单测注入。
export const runGroupReplyPass = async ({ task, aiRun, exec = execAiExecutor, ...execOptions }) => {
  if (!owesGroupReply({ task, result: aiRun?.result })) return false
  if (!aiRun.sessionId || aiRun.executor !== 'claude') return false
  console.warn(`[lark-worker] ${task.id} 群里答应过下文、结果没写群回复，续会话补写一次`)
  try {
    const pass = await exec({ ...execOptions, executor: aiRun.executor, promptText: buildGroupReplyPassPrompt({ task }), resumeSessionId: aiRun.sessionId })
    const groupReply = hasText(pass?.result?.groupReply) ? pass.result.groupReply.trim() : null
    const report = groupReply ? null : pass?.result?.report || null
    if (!groupReply && !report) return false
    aiRun.result = { ...aiRun.result, groupReply, report, detailDoc: aiRun.result.detailDoc || pass.result.detailDoc || null }
    return true
  } catch (error) {
    console.warn(`[lark-worker] ${task.id} 补写群回复异常（交网关按草稿私聊负责人）：${String(error?.message || error).slice(0, 160)}`)
    return false
  }
}
