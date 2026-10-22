/**
 * repo-only 实例（falive 独立部署，aven 2026-10-20：与 fameex 分开、互不影响）的 ingest 入口守卫。
 * 这套实例只轮询仓库 profile 的群与负责人控制台群（控制台按 p2p 进来），没有 fameex 的老路径：
 * 别的群一律不处理；控制台里锚不到仓库任务的话只回一句怎么指明任务，绝不新建 fameex 任务。
 */

import { sendBotMarkdown } from './lark-cli.mjs'
import { isRepoOnlyInstance } from './lark-constants.mjs'
import { parseResumeDirective, textForParse } from './lark-message.mjs'

export const CONSOLE_UNANCHORED_HINT = '这句没对上任务：12 小时内没有我发给你的任务通知。要续跑或补充，请写「继续任务 <任务 id> 补充内容」；要结单写「结单 <任务 id>」。'
// 控制台只发了文件 / 图片、没有文字（aven 2026-10-20 review）：不建空任务，提示怎么说。
export const CONSOLE_NO_TEXT_HINT = '只收到附件、没有文字，没建任务。请用文字说明要做什么：续跑写「继续任务 <任务 id> 补充内容」，结单写「结单 <任务 id>」。'

export const isForeignChat = ({ msg, repo }) => {
  if (!isRepoOnlyInstance() || repo || msg.chatType === 'p2p') return false
  console.log(`[lark-gateway] repo-only：${msg.chatId} 不是仓库群，忽略 ${msg.messageId}`)
  return true
}

export const isConsoleMessage = (msg) => isRepoOnlyInstance() && msg.chatType === 'p2p'

// 点名了任务 id 却锚不到（10-22 #65：id 抄错一位，回的却是「12 小时内没有任务通知」）：明说找不到哪个 id；
// 有且只有一条任务 id 跟它同长、只差一两位，就给出改好的整句，复制就能发。
const NEAR_ID_MAX_DIFF = 2
export const nearTaskIds = ({ taskId, store }) => (store?.list?.() || [])
  .map((task) => task.id)
  .filter((id) => id && id !== taskId && id.length === taskId.length && [...id].filter((ch, i) => ch !== taskId[i]).length <= NEAR_ID_MAX_DIFF)

export const consoleUnanchoredHint = ({ msg, store }) => {
  const directive = parseResumeDirective(textForParse(msg))
  if (!directive) return CONSOLE_UNANCHORED_HINT
  const { taskId, supplementText } = directive
  if (store?.get?.(taskId)) return `任务 ${taskId} 在，但这里接不上（不是本仓任务，或发送人不是负责人），没续跑。`
  const near = nearTaskIds({ taskId, store })
  const guess = near.length === 1 ? `是不是 ${near[0]}？是的话发「继续任务 ${near[0]}${supplementText ? ` ${supplementText}` : ''}」。` : '请从通知里整行复制「继续任务 <任务 id> 补充内容」再发。'
  return `找不到任务 ${taskId}，没续跑。${guess}`
}

export const replyUnanchoredConsole = async ({ msg, store = null, send = sendBotMarkdown, hint = consoleUnanchoredHint({ msg, store }) }) => {
  console.log(`[lark-gateway] repo-only 控制台消息 ${msg.messageId} 锚不到仓库任务：${(msg.text || '').slice(0, 60) || '（无文字）'}`)
  await send({ chatId: msg.chatId, markdown: hint, logPrefix: 'console unanchored' })
}
