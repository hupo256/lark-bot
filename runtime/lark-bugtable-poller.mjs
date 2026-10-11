#!/usr/bin/env node

import { runLarkBugtablePoller } from '../lark-bugtable-poller.mjs'
import { larkLocalConfigPath } from '../lib/lark-paths.mjs'

runLarkBugtablePoller({
  // 锚定 larkRuntimeDir 的绝对路径（runtime/lark-bot.local.json），与 launchd WorkingDirectory（fameex-web）无关。
  configPath: larkLocalConfigPath,
}).catch((error) => {
  console.error(error)
  process.exit(1)
})
