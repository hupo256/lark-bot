#!/usr/bin/env node
/**
 * falive-bot 做过的全部 case 清单（docs/falive-replay-plan-2026-11-03.md 42）：时间线里触发过 bot 的真人消息——@bot、回复 bot 的、
 * aven 在 webhook 私聊群里发给 bot 的（口径与 judge-sim isTrigger 一致）。每条带 falive 当时第一句回复，供回放逐条裁判与人工查阅。
 *   node scripts/sim/list-cases.mjs   → replay/falive/cases.jsonl + cases.md
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { casesDir, datasetDir } from './falive-data.mjs'

const timeline = JSON.parse(readFileSync(join(datasetDir, 'timeline.json'), 'utf8'))
const byId = new Map(timeline.map((m) => [m.id, m]))
const one = (t, n) => String(t || '').replace(/<at user_id="[^"]*">([^<]*)<\/at>/g, '@$1').replace(/\s+/g, ' ').trim().slice(0, n)
const kindOf = (m) => (m.chatKey === 'webhook-group' && m.isAven ? 'principal_dm' : m.atBot ? 'at_bot' : m.parentId && byId.get(m.parentId)?.ownBot ? 'reply_to_bot' : null)
const cases = timeline.filter((m) => !m.ownBot && !m.deleted && m.senderType !== 'system' && kindOf(m)).map((m) => {
  const reply = timeline.find((r) => r.ownBot && r.atMs >= m.atMs && r.atMs <= m.atMs + 6 * 3600_000 && (r.parentId === m.id || (r.chatKey === m.chatKey && r.text?.includes(m.senderName))))
  return { id: m.id, at: new Date(m.atMs).toISOString(), chat: m.chatName, sender: m.senderName, kind: kindOf(m), text: one(m.text, 300), attachments: (m.resources || []).length, faliveReply: reply ? one(reply.text, 200) : null }
})
writeFileSync(join(casesDir, 'cases.jsonl'), `${cases.map((c) => JSON.stringify(c)).join('\n')}\n`)
const count = (k) => cases.filter((c) => c.kind === k).length
const md = [`# falive-bot 做过的 case（${cases.length} 条：@bot ${count('at_bot')}、回复 bot ${count('reply_to_bot')}、aven 私聊 ${count('principal_dm')}）`, '',
  '由 `node scripts/sim/list-cases.mjs` 从 dataset/timeline.json 生成，别手改。', '', '| 时间（UTC） | 群 | 人 | 类 | 原话 | falive 当时回 |', '|---|---|---|---|---|---|',
  ...cases.map((c) => `| ${c.at.slice(5, 16).replace('T', ' ')} | ${c.chat} | ${c.sender} | ${c.kind} | ${one(c.text, 80).replace(/\|/g, '\\|')}${c.attachments ? ` 📎${c.attachments}` : ''} | ${one(c.faliveReply || '—', 60).replace(/\|/g, '\\|')} |`)]
writeFileSync(join(casesDir, 'cases.md'), `${md.join('\n')}\n`)
console.log(`case ${cases.length} 条 → ${join(casesDir, 'cases.jsonl')}、cases.md`)
