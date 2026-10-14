#!/usr/bin/env node
/**
 * 手动跑一次某仓的日报（调格式 / 补发用）：和调度器走同一条 runDailyReport 链路，
 * 结果按 profile 投递（配了 sendTo 就发群）；不写调度状态，不影响当天定时那份。
 * --private：不发群，只私聊 profile.dailyReport.to（试跑用）；--to 指定私聊对象，同样不发群。
 * 用法：node scripts/lark-daily-report-now.mjs [repoKey=falive] [--private] [--to <chat_id|open_id>]
 */
import { join } from 'node:path'

import { loadConfig } from '../lib/lark-config.mjs'
import { normalizeAiExecutor } from '../lib/lark-http.mjs'
import { larkRuntimeDir, larkTasksDir } from '../lib/lark-repo.mjs'
import { listRepoProfiles, registerRepoProfiles } from '../lib/lark-repo-profile.mjs'
import { createTaskStore } from '../lib/lark-task-store.mjs'
import { runDailyReport } from '../lib/lark-daily-report.mjs'
import { defaultTaskLeaseMs } from '../lib/lark-constants.mjs'

const args = process.argv.slice(2)
const toIndex = args.indexOf('--to')
const key = args.find((item, index) => !item.startsWith('--') && index !== toIndex + 1) || 'falive'
const privateOnly = args.includes('--private') || toIndex >= 0
const loaded = loadConfig(join(larkRuntimeDir, 'lark-bot.local.json'), 'daily report config')
const config = { ...loaded, aiExecutor: normalizeAiExecutor(loaded.aiExecutor) }
registerRepoProfiles(config)
const profile = listRepoProfiles().find((item) => item.key === key)
if (!profile || !profile.dailyReport?.at) {
  console.error(`repo ${key} 没有配置 dailyReport`)
  process.exit(1)
}
if (toIndex >= 0) profile.dailyReport.to = args[toIndex + 1]
if (privateOnly) profile.dailyReport.sendTo = []
const store = createTaskStore({ tasksDir: larkTasksDir, leaseMs: defaultTaskLeaseMs })
const outcome = await runDailyReport({ config, store, profile, now: new Date() })
console.log(JSON.stringify({ ok: outcome.ok, reason: outcome.reason, to: outcome.to, reportPath: outcome.reportPath, doc: outcome.doc?.url || null }, null, 2))
process.exit(outcome.ok ? 0 : 1)
