#!/usr/bin/env node

import { runLarkWorker } from '../lark-worker.mjs'

runLarkWorker({
  projectId: 'PR-01947',
  projectName: 'CopyTrading 跟单设置',
  projectDocs: [
    'apps/web/docs_tdd/prds/PR-01947/agent/lark-integration.md',
    'apps/web/docs_tdd/prds/PR-01947/agent/README.md',
  ],
  // AI 在 PR-01947 worktree 内执行；executor 可被 lark-bot.local.json / task / LARK_AI_EXECUTOR 覆盖
  repoCwd: '/Users/aven/github/PR-01947',
  configPath: 'apps/web/docs_tdd/common/lark-bot/runtime/lark-bot.local.json',
}).catch((error) => {
  console.error(error)
  process.exit(1)
})
