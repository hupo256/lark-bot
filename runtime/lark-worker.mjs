#!/usr/bin/env node

import { runLarkWorker } from '../lark-worker.mjs'
import { larkLocalConfigPath } from '../lib/lark-paths.mjs'

// 薄包装：worker 是多项目的，按 task.project 路由到对应 worktree（见 lib/lark-work-context.mjs）。
// 项目身份（project/title）与 executor 都从 lark-bot.local.json 派生，勿在此写死。
runLarkWorker({
  // 锚定 larkRuntimeDir 的绝对路径（runtime/lark-bot.local.json），与 launchd WorkingDirectory（fameex-web）无关。
  configPath: larkLocalConfigPath,
}).catch((error) => {
  console.error(error)
  process.exit(1)
})
