#!/usr/bin/env node

import { runLarkBugtablePoller } from '../lark-bugtable-poller.mjs'

runLarkBugtablePoller({
  configPath: 'apps/web/docs_tdd/common/lark-bot/runtime/lark-bot.local.json',
}).catch((error) => {
  console.error(error)
  process.exit(1)
})
