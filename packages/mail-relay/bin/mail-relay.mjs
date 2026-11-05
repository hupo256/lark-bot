#!/usr/bin/env node
/**
 * 审批邮件转发的独立入口（11-05 P1 拆分；P3 在 Mac mini 上由 launchd 跑它，见 docs/plan/plan-mail-relay-standalone-2026-11-05.md）。
 * 不依赖 lark-bot：只读自己的配置，相对路径（stateFile / cliConfigDir）按配置文件所在目录解析。
 *   node bin/mail-relay.mjs check   --config <json>
 *   node bin/mail-relay.mjs forward --config <json> --message-id <id> [--route <id>] [--dry-run] [--force]
 *   node bin/mail-relay.mjs run     --config <json>
 * 配置：{ mailRelay: {...} } 或直接就是 mailRelay 对象；可带顶层 notifyOpenId（告警收件人缺省值，mailRelay.alert.openId 优先）。
 * 字段见 routes.mjs 头注释（routes / mode / pollMs / alert / cliConfigDir / stateFile）。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { createRelayCli, startMailRelay } from '../engine.mjs'
import { fetchMail, forwardMail } from '../forward.mjs'
import { matchRoute, normalizeRoutes, validateMailRelay } from '../routes.mjs'

const [command, ...argv] = process.argv.slice(2)
const option = (name) => {
  const at = argv.indexOf(name)
  return at >= 0 ? argv[at + 1] : undefined
}
const usage = () => {
  console.error('用法：node bin/mail-relay.mjs check|forward|run --config <json> [--message-id <id> --route <id> --dry-run --force]')
  process.exit(2)
}

const configOption = option('--config')
if (!configOption || !['check', 'forward', 'run'].includes(command)) usage()
const configPath = resolve(configOption)
const baseDir = dirname(configPath)
const loaded = JSON.parse(readFileSync(configPath, 'utf8'))
const relay = loaded.mailRelay || loaded
const errors = validateMailRelay(relay)
if (errors.length) {
  console.error(`mailRelay 配置有误（${configPath}）：\n- ${errors.join('\n- ')}`)
  process.exit(1)
}
const routes = normalizeRoutes(relay)

if (command === 'check') {
  console.log(`mailRelay ${relay.enabled ? '已开' : '没开'}，${routes.length} 条启用路由（${configPath}）`)
  for (const route of routes) console.log(`- ${route.id}（${route.label}）→ ${route.chatId}，评分器 ${route.scorer || '无'}`)
} else if (command === 'forward') {
  const messageId = option('--message-id')
  if (!messageId) usage()
  const { run } = createRelayCli({ cliConfigDir: relay.cliConfigDir, baseDir })
  let route = routes.find((item) => item.id === option('--route'))
  if (!route) {
    const read = await fetchMail({ messageId, run })
    route = read.ok ? matchRoute(routes, read.mail) : null
    if (!route) {
      console.error(read.ok ? `没有路由命中：${read.mail.subject}（用 --route 指定）` : `读信失败：${read.reason}`)
      process.exit(1)
    }
  }
  const outcome = await forwardMail({ messageId, route, run, dryRun: argv.includes('--dry-run'), force: argv.includes('--force') })
  if (outcome.markdown) console.log(outcome.markdown)
  console.log(JSON.stringify({ ...outcome, markdown: undefined, result: outcome.result ? { score: outcome.result.score, tier: outcome.result.tier } : undefined }))
  process.exit(outcome.ok ? 0 : 1)
} else {
  if (!relay.enabled) {
    console.error('mailRelay.enabled 不是 true，不启动')
    process.exit(1)
  }
  const relayRun = startMailRelay({ relay, baseDir, notifyOpenId: loaded.notifyOpenId || null })
  const shutdown = () => {
    relayRun.stop()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}
