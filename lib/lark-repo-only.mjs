/**
 * repo-only 实例（falive 独立部署，aven 2026-10-20：与 fameex 分开、互不影响）的 ingest 入口守卫。
 * 这套实例只轮询仓库 profile 的群与负责人控制台群（控制台按 p2p 进来），没有 fameex 的老路径：
 * 别的群一律不处理；控制台里锚不到仓库任务的话只回一句怎么指明任务，绝不新建 fameex 任务。
 */

import { sendBotMarkdown } from './lark-cli.mjs'
import { isRepoOnlyInstance } from './lark-constants.mjs'

export const CONSOLE_UNANCHORED_HINT = '这句没对上任务：12 小时内没有我发给你的任务通知。要续跑或补充，请写「继续任务 <任务 id> 补充内容」；要结单写「结单 <任务 id>」。'

export const isForeignChat = ({ msg, repo }) => {
  if (!isRepoOnlyInstance() || repo || msg.chatType === 'p2p') return false
  console.log(`[lark-gateway] repo-only：${msg.chatId} 不是仓库群，忽略 ${msg.messageId}`)
  return true
}

export const isConsoleMessage = (msg) => isRepoOnlyInstance() && msg.chatType === 'p2p'

export const replyUnanchoredConsole = async ({ msg, send = sendBotMarkdown }) => {
  console.log(`[lark-gateway] repo-only 控制台消息 ${msg.messageId} 锚不到仓库任务：${(msg.text || '').slice(0, 60)}`)
  await send({ chatId: msg.chatId, markdown: CONSOLE_UNANCHORED_HINT, logPrefix: 'console unanchored' })
}
