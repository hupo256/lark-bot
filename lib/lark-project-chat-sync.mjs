/**
 * gateway 定时同步项目群绑定表 + 负责人的绑定指令（aven 2026-11-01）：拉 bot 所在群 → syncProjectChats → 有变化落盘、私信负责人。
 * bot 被拉进新群 = chat-list 里第一次出现；靠定时拉（默认 5 分钟）而不是入群事件（应用不一定订阅了该事件）。
 * 拉群列表失败本轮跳过（不把「读失败」当「退群」）。
 */
import { listBotChats, resolveChatName, sendChatMessage } from './lark-cli.mjs'
import {
  bindProjectChat,
  formatProjectChatEvents,
  formatProjectChatList,
  loadProjectChats,
  parseProjectChatDirective,
  saveProjectChats,
  syncProjectChats,
  unbindProjectChat,
} from './lark-project-chats.mjs'
import { parseWatchDirective, setWatchMode } from './lark-bug-watch.mjs'
import { loadWatchState, saveWatchState } from './lark-bug-watch-state.mjs'

export const PROJECT_CHAT_SYNC_MS = Number(process.env.LARK_PROJECT_CHAT_SYNC_MS || 5 * 60 * 1000)

export const runProjectChatSync = async ({
  notifyOpenId,
  list = listBotChats,
  load = loadProjectChats,
  save = saveProjectChats,
  send = sendChatMessage,
  now = Date.now(),
  log = console.log,
}) => {
  const chats = await list()
  if (!chats) return { ok: false, events: [] }
  const before = load()
  const { state, events } = syncProjectChats({ state: before, chats, now })
  if (JSON.stringify(state) !== JSON.stringify(before)) save(state)
  const text = formatProjectChatEvents(events)
  if (text) {
    log(`[lark-gateway] 项目群绑定：${events.map((e) => `${e.type} ${e.project || ''} ${e.chatId || ''}`.trim()).join('；')}`)
    if (notifyOpenId) await send({ chatId: notifyOpenId, text, logPrefix: 'project-chat sync', idempotencyKey: `project-chat-sync-${now}` })
  }
  return { ok: true, events }
}

export const startProjectChatSync = ({ config, intervalMs = PROJECT_CHAT_SYNC_MS, run = runProjectChatSync }) => {
  let running = null
  const tick = () => (running ||= run({ notifyOpenId: config.notifyOpenId })
    .catch((error) => console.error(`[lark-gateway] 项目群同步异常：${String(error?.message || error).slice(0, 160)}`))
    .finally(() => { running = null }))
  tick()
  const timer = setInterval(tick, intervalMs)
  timer.unref?.()
  return { tick, stop: () => clearInterval(timer) }
}

// 项目群绑定指令（aven 2026-11-01，lib/lark-project-chats.mjs）：负责人（notifyOpenId）私聊 bot 或在群里 @bot
// 「绑定 PR-xxxxx [oc_群id]」/「PR-xxxxx 群是 oc_xxx」/「解绑 PR-xxxxx」/「项目群」。群里不带群 id = 绑当前群。
// 不是负责人发的不接管（放行给原流程，当普通消息处理）。
export const maybeHandleProjectChatDirective = async ({ msg, config, load = loadProjectChats, save = saveProjectChats, send = sendChatMessage, chatNameOf = resolveChatName, watch = { load: loadWatchState, save: saveWatchState } }) => {
  const owners = [config.notifyOpenId, ...(Array.isArray(config.allowedOpenIds) ? config.allowedOpenIds : [])].filter(Boolean)
  // 「开始测试 / 结束测试」：切 bug 发现的档（写 poller 常驻进程每轮重读的状态文件）
  const mode = parseWatchDirective(msg.text)
  if (mode && owners.includes(msg.senderOpenId)) {
    watch.save(setWatchMode(watch.load(), mode))
    await send({ chatId: msg.chatId, text: mode === 'testing' ? 'bug 发现已切到「测试中」：\n- 读通知：工作时间每 1 分钟，其他时间每 10 分钟\n- 对账：每 15 分钟' : 'bug 发现已切到「平时」：\n- 读通知：每 60 分钟\n- 对账：每 120 分钟', logPrefix: 'bug-watch directive', idempotencyKey: `${msg.messageId}-bug-watch` })
    return true
  }
  const directive = parseProjectChatDirective(msg.text)
  if (!directive) return false
  if (!owners.includes(msg.senderOpenId)) return false
  const reply = (text) => send({ chatId: msg.chatId, text, logPrefix: 'project-chat directive', idempotencyKey: `${msg.messageId}-project-chat` })
  const state = load()
  if (directive.action === 'list') {
    await reply(formatProjectChatList(state))
    return true
  }
  if (directive.action === 'unbind') {
    const { state: next, prev } = unbindProjectChat(state, directive.project)
    if (prev) save(next)
    await reply(prev ? `已解绑 ${directive.project}（原群「${prev.chatName || ''}」${prev.chatId}）。\n之后它的结果先私聊发你。` : `${directive.project} 本来就没有绑定群。`)
    return true
  }
  const chatId = directive.chatId || (msg.chatType === 'p2p' ? '' : msg.chatId)
  if (!chatId) {
    await reply(`要绑定的群 id 没给：在项目群里 @我「绑定 ${directive.project}」，或私聊我「绑定 ${directive.project} oc_xxx」。`)
    return true
  }
  const chatName = await chatNameOf(chatId)
  const { state: next, prev } = bindProjectChat(state, { project: directive.project, chatId, chatName })
  save(next)
  await reply(`已把 ${directive.project} 绑定到群「${chatName || '(bot 不在该群或读不到群名)'}」（${chatId}）${prev && prev.chatId !== chatId ? `\n原来是「${prev.chatName || ''}」${prev.chatId}` : ''}\n之后回群按群 id，群改名不影响。`)
  return true
}
