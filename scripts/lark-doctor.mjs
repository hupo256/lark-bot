#!/usr/bin/env node
/**
 * lark-bot doctor [--json]：运行态体检（自愈环 3，见 lib/lark-doctor.mjs）。
 * 取 /lark/health + /lark/tasks + 失败台账 + bug 表轮询状态，打印带等级的报告；有 warn / bad 以非零退出。
 *   node scripts/lark-doctor.mjs [--json]
 */
import { readFileSync } from 'node:fs'

import { defaultGatewayUrl } from '../lib/lark-constants.mjs'
import { runDoctorCli } from '../lib/lark-doctor.mjs'
import { resolveClaudeBinary } from '../lib/lark-ai-executor.mjs'
import { buildExecutorChecks, collectExecutorFacts } from '../lib/lark-executor-doctor.mjs'
import { createGatewayClient } from '../lib/lark-gateway-client.mjs'
import { larkLocalConfigPath } from '../lib/lark-paths.mjs'
import { repoRoot } from '../lib/lark-repo.mjs'

const readLocalConfig = () => {
  try {
    return JSON.parse(readFileSync(larkLocalConfigPath, 'utf8'))
  } catch {
    return {}
  }
}
const client = createGatewayClient(defaultGatewayUrl)
// 手动体检多查一节「AI 执行层」（claude CLI / 参数 / 个人设置隔离 / AGENTS.md 遮蔽 / 常驻规则），定时体检不跑。
// LARK_DOCTOR_EXECUTOR=0 跳过（只看 bot 自身健康时用；端到端测试也用它，避免起 claude 子进程）。
const executorChecks = process.env.LARK_DOCTOR_EXECUTOR === '0'
  ? null
  : buildExecutorChecks(collectExecutorFacts({ localConfig: readLocalConfig(), repoDir: repoRoot, claudeBin: resolveClaudeBinary() }))
process.exitCode = await runDoctorCli({ argv: process.argv.slice(2), gatewayUrl: defaultGatewayUrl, listTasks: () => client.listTasks(), executorChecks })
