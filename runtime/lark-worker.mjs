#!/usr/bin/env node

import { runLarkWorker } from '../lark-worker.mjs'

// 薄包装：worker 是多项目的，按 task.project 路由到对应 worktree（见 lib/lark-work-context.mjs）。
// 项目身份（project/title）与 executor 都从 lark-bot.local.json 派生，勿在此写死。
runLarkWorker({
  configPath: 'apps/web/docs_tdd/common/lark-bot/runtime/lark-bot.local.json',
}).catch((error) => {
  console.error(error)
  process.exit(1)
})
