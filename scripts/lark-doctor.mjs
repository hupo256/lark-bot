#!/usr/bin/env node
/**
 * lark-bot doctor [--json]：运行态体检（自愈环 3，见 lib/lark-doctor.mjs）。
 * 取 /lark/health + /lark/tasks + 失败台账 + bug 表轮询状态，打印带等级的报告；有 warn / bad 以非零退出。
 *   node scripts/lark-doctor.mjs [--json]
 */
import { defaultGatewayUrl } from '../lib/lark-constants.mjs'
import { runDoctorCli } from '../lib/lark-doctor.mjs'
import { createGatewayClient } from '../lib/lark-gateway-client.mjs'

const client = createGatewayClient(defaultGatewayUrl)
process.exitCode = await runDoctorCli({ argv: process.argv.slice(2), gatewayUrl: defaultGatewayUrl, listTasks: () => client.listTasks() })
