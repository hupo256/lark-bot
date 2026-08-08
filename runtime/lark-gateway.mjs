#!/usr/bin/env node

import { runLarkGateway } from '../lark-gateway.mjs'

runLarkGateway({
  configPath: 'apps/web/docs_tdd/common/lark-bot/runtime/lark-bot.local.json',
}).catch((error) => {
  console.error(error)
  process.exit(1)
})
