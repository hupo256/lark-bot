#!/usr/bin/env node
// 黄金对话测试用的假 lark-cli：不碰网络，所有查询回空列表（拉上下文 / 群名 / 话题都当作没有）。
// 例外：设了 LARK_GOLDEN_CHAT_FILE（JSON 数组，Lark 消息格式）时，+chat-messages-list 按 --end / --order 回这些消息（10-23 #74 场景用）。
import { existsSync, readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null)
const file = process.env.LARK_GOLDEN_CHAT_FILE
let messages = []
if (args.includes('+chat-messages-list') && file && existsSync(file)) {
  const endMs = Number(flag('--end') || Infinity) * 1000
  messages = JSON.parse(readFileSync(file, 'utf8')).filter((m) => Number(m.create_time) <= endMs)
  messages.sort((a, b) => Number(a.create_time) - Number(b.create_time))
  if (flag('--order') === 'desc') messages.reverse()
}
process.stdout.write(JSON.stringify({ code: 0, data: { items: messages, messages, chats: [], has_more: false } }))
