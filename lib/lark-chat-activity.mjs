/**
 * 群活跃记账（aven 11-02「14 天没有 @bot 的群，能自动退群吗？」）：每个群最后一次有人 @bot / 回复 bot、或 bot 在群里回任务的时刻。
 * 自动退群（lib/lark-chat-retention.mjs）每天按它判「多久没人找我了」。
 *
 * 文件 runtime/lark-chat-activity-state.json（名字以 -state.json 结尾：每条消息都在变，不能算进源码版本哈希）：
 *   { startedAt, lastRunDate?, scopeNotifiedFor?, chats: { [chatId]: { lastActiveAt?, warnedAt?, keep? } } }
 * startedAt = 这个功能第一次跑的时刻：不回填历史，上线后 14 天内没有群会被判闲置。
 * gateway 和 worker 都会写（worker 也走群消息出口），所以每次都现读现写、不在内存缓存；写失败只打日志，绝不抛给调用方。
 * node --test 里没指定 LARK_RUNTIME_DIR 就不落盘（不往真运行态写假群 id）。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { larkRuntimeDir } from './lark-paths.mjs'

export const CHAT_ACTIVITY_FILE = 'lark-chat-activity-state.json'

const defaultPath = () => (process.env.NODE_TEST_CONTEXT && !process.env.LARK_RUNTIME_DIR ? null : join(larkRuntimeDir, CHAT_ACTIVITY_FILE))

const normalize = (state) => ({ ...state, chats: state?.chats && typeof state.chats === 'object' && !Array.isArray(state.chats) ? state.chats : {} })

// 文件读写（可注入：单测用内存版）。没有 / 读坏了 / 不落盘都当空表（时钟重新起算，只会退得更晚）；写是先写 .tmp 再改名。
export const fileActivityIo = (path = defaultPath()) => ({
  read: () => {
    try {
      return normalize(JSON.parse(readFileSync(path, 'utf8')))
    } catch {
      return normalize({})
    }
  },
  write: (state) => {
    if (!path) return
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(`${path}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 })
    renameSync(`${path}.tmp`, path)
  },
})

// 现读 → 改 → 写。mutate 返回 false 表示没改、不写。
export const updateActivity = (mutate, io = fileActivityIo()) => {
  const state = io.read()
  if (mutate(state) === false) return state
  io.write(state)
  return state
}

// 时钟从功能第一次跑时开始（不回填历史）。
export const ensureStarted = (state, now) => {
  if (!state.startedAt) state.startedAt = new Date(now).toISOString()
  return state
}

// 群里有人找 bot / bot 在群里回了任务：记一笔活跃，提醒过要退的就作废（不退了）。只记群（oc_ 且不是私聊）；绝不抛错。
export const recordChatActivity = ({ chatId, chatType, now = Date.now(), io } = {}) => {
  if (chatType === 'p2p' || !String(chatId || '').startsWith('oc_')) return false
  try {
    updateActivity((state) => {
      ensureStarted(state, now)
      const entry = state.chats[chatId] || {}
      delete entry.warnedAt
      state.chats[chatId] = { ...entry, lastActiveAt: new Date(now).toISOString() }
    }, io || fileActivityIo())
    return true
  } catch (error) {
    console.warn(`[lark-gateway] 群活跃记账失败（${chatId}）：${String(error?.message || error).slice(0, 120)}`)
    return false
  }
}
