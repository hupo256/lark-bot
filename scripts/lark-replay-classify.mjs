#!/usr/bin/env node
/**
 * 用已落盘的任务正文回放意图分类（调提示词 / 核对准确率用）：不碰 gateway、不改任务文件、不发消息。
 * 用法：node scripts/lark-replay-classify.mjs [repoKey=falive] [--limit n]
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { larkRuntimeDir, larkTasksDir } from '../lib/lark-repo.mjs'
import { registerRepoProfiles } from '../lib/lark-repo-profile.mjs'
import { classifyTaskIntent, loadWorkerLocalConfig } from '../lib/lark-worker-run.mjs'

const args = process.argv.slice(2)
const key = args.find((item) => !item.startsWith('--')) || 'falive'
const limitIndex = args.indexOf('--limit')
const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : Infinity
const localConfig = loadWorkerLocalConfig(join(larkRuntimeDir, 'lark-bot.local.json'))
registerRepoProfiles(localConfig)
const workerConfig = { projectId: localConfig.project, projectName: localConfig.title, aiExecutor: 'claude', localConfig }

const tasks = readdirSync(larkTasksDir).filter((name) => name.endsWith('.json'))
  .map((name) => JSON.parse(readFileSync(join(larkTasksDir, name), 'utf8')))
  .filter((task) => task.repo === key && task.text)
  .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
  .slice(0, limit)
const seen = []
for (const task of tasks) {
  const candidates = seen.slice(-10)
  let out
  try {
    out = await classifyTaskIntent(workerConfig, { ...task, intake: { required: true } }, null, null, { candidates })
  } catch (error) {
    out = { decision: 'ERROR', reason: String(error?.message || error).slice(0, 120) }
  }
  const head = (task.text || '').split('\n')[0].slice(0, 40)
  console.log(JSON.stringify({ id: task.id.slice(-8), at: String(task.createdAt).slice(11, 16), head, decision: out.decision, confidence: out.confidence, forMe: out.forMe, topic: out.topic, related: out.relatedTaskId ? out.relatedTaskId.slice(-8) : null, summary: out.summary }))
  seen.push({ id: task.id, topic: out.topic || task.topic, status: 'done', summary: out.summary || task.summary, text: task.text })
}
