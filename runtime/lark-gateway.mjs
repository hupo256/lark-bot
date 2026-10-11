#!/usr/bin/env node

import { runLarkGateway } from '../lark-gateway.mjs'
import { larkLocalConfigPath } from '../lib/lark-paths.mjs'

runLarkGateway({
  // 锚定 larkRuntimeDir 的绝对路径（runtime/lark-bot.local.json），与 launchd WorkingDirectory（fameex-web）无关。
  configPath: larkLocalConfigPath,
}).catch((error) => {
  console.error(error)
  process.exit(1)
})
