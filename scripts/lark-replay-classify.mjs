#!/usr/bin/env node
/**
 * 用已落盘的任务正文回放意图分类（调提示词 / 核对准确率用）：不碰 gateway、不改任务文件、不发消息。
 * 用法：node scripts/lark-replay-classify.mjs [repoKey=falive] [--limit n] [--ids om_a,om_b|后 8 位] [--dir <任务目录>] [--refetch-context]
 *   --dir              从别的目录读任务（固定回放集 __tests__/fixtures/falive-intake/）
 *   --refetch-context  正文里没有「群里这条之前的消息」块的，按收到时间用用户身份重新拉一次（含本群 Aven.Bot 的卡）再分类
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { fetchRecentChatContext } from '../lib/lark-cli.mjs'
import { larkRuntimeDir, larkTasksDir } from '../lib/lark-repo.mjs'
import { registerRepoProfiles, repoProfileForChat } from '../lib/lark-repo-profile.mjs'
import { classifyTaskIntent, loadWorkerLocalConfig } from '../lib/lark-worker-run.mjs'

const args = process.argv.slice(2)
const flagValue = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : null
}
const key = args.find((item, index) => !item.startsWith('--') && !(index > 0 && args[index - 1].startsWith('--') && ['--limit', '--ids', '--dir'].includes(args[index - 1]))) || 'falive'
const limit = flagValue('--limit') ? Number(flagValue('--limit')) : Infinity
const ids = flagValue('--ids') ? flagValue('--ids').split(',').map((item) => item.trim()).filter(Boolean) : null
const dir = flagValue('--dir') || larkTasksDir
const refetch = args.includes('--refetch-context')
// --report：与 fixture 里的基线（intake.classification_at_capture）比：forMe 召回、decision 一致率、medium 占比；
// --gate 时召回 < 100% 或一致率 < 95% 以非零退出（改提示词 / schema 前的门槛，第 3 批）。
const report = args.includes('--report') || args.includes('--gate')
const gate = args.includes('--gate')
const localConfig = loadWorkerLocalConfig(join(larkRuntimeDir, 'lark-bot.local.json'))
registerRepoProfiles(localConfig)
const workerConfig = { projectId: localConfig.project, projectName: localConfig.title, aiExecutor: 'claude', localConfig }

const RECENT_HEADER = '【群里这条之前的消息】'
const tasks = readdirSync(dir).filter((name) => name.endsWith('.json'))
  .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')))
  .filter((task) => task.repo === key && task.text)
  .filter((task) => !ids || ids.some((id) => task.id === id || task.id.endsWith(id)))
  .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
  .slice(0, limit)
const seen = []
const rows = []
for (const stored of tasks) {
  let task = stored
  if (refetch && !task.text.includes(RECENT_HEADER)) {
    const profile = repoProfileForChat(task.chatId)
    const beforeMs = Date.parse(task.intake?.receivedAt || task.createdAt || '') || 0
    const recent = await fetchRecentChatContext({ chatId: task.chatId, beforeMs, excludeIds: [task.id, task.threadRootId], botOpenIds: Object.values(profile?.botMentionOpenIds || {}) })
    if (recent.length) task = { ...task, text: `${task.text}\n\n${RECENT_HEADER}\n${recent.map((item) => `${item.sender ? `${item.sender}：` : ''}${item.text}`).join('\n')}` }
  }
  const candidates = seen.slice(-10)
  let out
  try {
    // 按原来的分道回放：没 @ 的慢道用低强度、快道用高强度（10-23 分道定强度）；录得早没有 lane 的按是否 @ 机器人补。
    const lane = task.intake?.lane || (task.addressedToBot ? 'fast' : 'slow')
    out = await classifyTaskIntent(workerConfig, { ...task, intake: { required: true, lane } }, null, null, { candidates })
  } catch (error) {
    out = { decision: 'ERROR', reason: String(error?.message || error).slice(0, 120) }
  }
  const head = (task.text || '').split('\n')[0].slice(0, 40)
  console.log(JSON.stringify({ id: task.id.slice(-8), at: String(task.createdAt).slice(11, 16), head, decision: out.decision, deliverable: out.deliverable ?? null, confidence: out.confidence, forMe: out.forMe, topic: out.topic, related: out.relatedTaskId ? out.relatedTaskId.slice(-8) : null, reply: out.reply, summary: out.summary }))
  seen.push({ id: task.id, topic: out.topic || task.topic, status: 'done', summary: out.summary || task.summary, text: task.text })
  rows.push({ id: task.id, out, base: stored.intake?.classification_at_capture || null, expectedDeliverable: stored.intake?.expected_deliverable || null, expectedDecision: stored.intake?.expected_decision || null })
}
if (report) {
  const labeled = rows.filter((row) => row.base)
  const forMeBase = labeled.filter((row) => row.base.forMe)
  const recall = forMeBase.filter((row) => row.out.forMe).length
  // expected_decision（字符串或数组）优先于基线：基线是当时线上的判定，有几条本身就判错了（README 有记），拿它比一致率不合理（10-21 P4）。
  const accepts = (row) => [].concat(row.expectedDecision || row.base.decision)
  const agree = labeled.filter((row) => accepts(row).includes(row.out.decision)).length
  const medium = rows.filter((row) => row.out.confidence === 'medium').length
  const summary = {
    total: rows.length,
    labeled: labeled.length,
    forMeRecall: forMeBase.length ? recall / forMeBase.length : null,
    forMeMissed: forMeBase.filter((row) => !row.out.forMe).map((row) => row.id.slice(-8)),
    decisionAgreement: labeled.length ? agree / labeled.length : null,
    decisionMissed: labeled.filter((row) => !accepts(row).includes(row.out.decision)).map((row) => `${row.id.slice(-8)}:${row.out.decision}∉${accepts(row).join('/')}`),
    mediumRatio: rows.length ? medium / rows.length : null,
    errors: rows.filter((row) => row.out.decision === 'ERROR').length,
    // 任务契约（10-21 P4）：标了 expected_deliverable 的样例，分类器给的 deliverable 要全对。
    deliverableLabeled: rows.filter((row) => row.expectedDeliverable).length,
    deliverableMissed: rows.filter((row) => row.expectedDeliverable && row.out.deliverable !== row.expectedDeliverable).map((row) => `${row.id.slice(-8)}:${row.out.deliverable ?? 'null'}≠${row.expectedDeliverable}`),
  }
  console.log(`REPORT ${JSON.stringify(summary)}`)
  if (gate && ((summary.forMeRecall != null && summary.forMeRecall < 1) || (summary.decisionAgreement != null && summary.decisionAgreement < 0.95) || summary.deliverableMissed.length)) {
    console.error('GATE FAILED：forMe 召回要 100%、decision 一致率要 ≥ 95%、标注了 deliverable 的要全对')
    process.exit(2)
  }
}
