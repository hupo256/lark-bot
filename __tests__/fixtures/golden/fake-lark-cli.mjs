#!/usr/bin/env node
// 黄金对话测试用的假 lark-cli：不碰网络，所有查询回空列表（拉上下文 / 群名 / 话题都当作没有）。
process.stdout.write(JSON.stringify({ code: 0, data: { items: [], messages: [], chats: [], has_more: false } }))
