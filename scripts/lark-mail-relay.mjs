#!/usr/bin/env node
/**
 * 审批邮件转群的独立入口（aven 11-02：将来拆成单独应用时「一键拆分」用；现在网关里已内置同一个引擎）。
 *   node scripts/lark-mail-relay.mjs check   [--config <json>]                 校验配置、列出启用的路由
 *   node scripts/lark-mail-relay.mjs forward --message-id <id> [--route <id>] [--dry-run] [--force] [--config <json>]
 *                                                                              手动转一封（不给 --route 就按路由表找第一条命中的）
 *   node scripts/lark-mail-relay.mjs run     --config <json>                   独立常驻（拆分后由新的 launchd 跑它；网关那边关 mailRelay.enabled）
 * --config 缺省读 runtime/lark-bot.local.json；文件里有 mailRelay 字段就取它，没有就把整份当 mailRelay。
 */
import { readFileSync } from 'node:fs'

import { createRelayCli, startMailRelay } from '../lib/lark-mail-relay.mjs'
import { fetchMail, forwardMail } from '../lib/lark-mail-relay-forward.mjs'
import { matchRoute, normalizeRoutes, validateMailRelay } from '../lib/lark-mail-relay-routes.mjs'
import { larkLocalConfigPath } from '../lib/lark-paths.mjs'

const [command, ...argv] = process.argv.slice(2)
const option = (name) => {
  const at = argv.indexOf(name)
  return at >= 0 ? argv[at + 1] : undefined
}
const usage = () => {
  console.error('用法：node scripts/lark-mail-relay.mjs check|forward|run [--config <json>] [--message-id <id> --route <id> --dry-run --force]')
  process.exit(2)
}

const configPath = option('--config') || larkLocalConfigPath
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
  const { run } = createRelayCli({ cliConfigDir: relay.cliConfigDir })
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
} else if (command === 'run') {
  if (!relay.enabled) {
    console.error('mailRelay.enabled 不是 true，不启动')
    process.exit(1)
  }
  const relayRun = startMailRelay({ relay })
  const shutdown = () => {
    relayRun.stop()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
} else {
  usage()
}
