#!/usr/bin/env node
/**
 * lark-bot doctor [repo]：运行态体检（自愈环 3）。取 /lark/health + /lark/tasks + 失败台账 + 日报状态，
 * 打印一份带等级的报告；有 warn / bad 以非零退出（给外部探活 / 人工一眼看）。
 *   node scripts/lark-doctor.mjs [falive] [--json]
 */
import { readFileSync } from 'node:fs'

import { readDailyReportState } from '../lib/lark-daily-report.mjs'
import { buildDoctorReport, formatDoctorReport } from '../lib/lark-doctor.mjs'
import { summarizeFailures } from '../lib/lark-failure-ledger.mjs'
import { createGatewayClient } from '../lib/lark-gateway-client.mjs'
import { larkLocalConfigPath, larkRuntimeDir } from '../lib/lark-paths.mjs'
import { listRepoProfiles, registerRepoProfiles } from '../lib/lark-repo-profile.mjs'
import { computeCodeHash, readWorkerHeartbeat } from '../lib/lark-runtime-version.mjs'

const args = process.argv.slice(2)
const repo = args.find((arg) => !arg.startsWith('--')) || null
const asJson = args.includes('--json')
const gatewayUrl = process.env.LARK_GATEWAY_URL || 'http://127.0.0.1:3005'

let localConfig = {}
try {
  localConfig = JSON.parse(readFileSync(larkLocalConfigPath, 'utf8'))
} catch {
  localConfig = {}
}
registerRepoProfiles(localConfig)

const client = createGatewayClient(gatewayUrl)
let health = null
let tasks = null
try {
  health = await client.request('/lark/health')
} catch {
  health = null
}
try {
  tasks = await client.listTasks()
} catch {
  tasks = null
}
const profiles = listRepoProfiles().filter((profile) => !profile.isDefault && (!repo || profile.key === repo))
const report = buildDoctorReport({
  health,
  tasks: tasks && repo ? tasks.filter((task) => task.repo === repo) : tasks,
  profiles,
  failures: summarizeFailures({ repo }),
  dailyState: readDailyReportState(larkRuntimeDir),
  heartbeat: readWorkerHeartbeat({ runtimeDir: larkRuntimeDir, expectedCodeHash: computeCodeHash().hash }),
})
if (asJson) console.log(JSON.stringify(report, null, 2))
else console.log(formatDoctorReport(report))
process.exit(report.ok ? 0 : 1)
