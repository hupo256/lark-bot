#!/usr/bin/env node
/**
 * 读 bug 表记录分享链接（…larksuite.com/record/<token>）：打印整条记录（复现步骤 / 状态 / 负责 RD / 备注）和问题截图路径。
 * 给 worker 里的 AI 按需调用（aven 2026-10-23：要链接出去、还要读很多信息的 url 先不读，判断需要再读）。
 *
 * 用法：node tools/read-bug-record.mjs <链接…> [--repo falive]
 *   不给 --repo 就用第一个配了 dailyReport.bugTable 的仓库。只读：lark-cli 用户身份读记录、下截图。
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { readBugRecords } from '../lib/lark-bug-record.mjs'
import { larkAttachmentsRoot, larkLocalConfigPath } from '../lib/lark-paths.mjs'

const args = process.argv.slice(2)
const repoIndex = args.indexOf('--repo')
const repoKey = repoIndex >= 0 ? args[repoIndex + 1] : null
const text = args.filter((arg, index) => !arg.startsWith('--') && !(repoIndex >= 0 && index === repoIndex + 1)).join('\n')

const repos = JSON.parse(readFileSync(larkLocalConfigPath, 'utf8')).repos || {}
const table = (repoKey ? repos[repoKey] : Object.values(repos).find((repo) => repo?.dailyReport?.bugTable))?.dailyReport?.bugTable
const run = (cliArgs, { cwd } = {}) => {
  const result = spawnSync('lark-cli', [...cliArgs, '--as', 'user'], { encoding: 'utf8', timeout: 60_000, cwd, env: process.env })
  return { code: result.error ? -1 : result.status, stdout: result.stdout || '', stderr: result.error ? String(result.error.message) : result.stderr || '' }
}

const result = readBugRecords({ text, outDir: join(larkAttachmentsRoot, 'bug-records'), table, run })
if (!result.urls.length) console.log('没认出 bug 表记录链接（要 https://…larksuite.com/record/<token> 这种）')
for (const record of result.records) {
  console.log(`## ${record.bug}（${record.url}）\n${readFileSync(record.path, 'utf8').trim()}`)
  console.log(record.shots.length ? `\n问题截图目录（用 Read 看图）：${record.shots.join('、')}\n` : '\n没有问题截图\n')
}
for (const item of result.skipped) console.log(`没读到 ${item.url}：${item.reason}`)
