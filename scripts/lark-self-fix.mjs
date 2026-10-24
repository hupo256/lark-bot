#!/usr/bin/env node
/**
 * 自修工单人工出口：lark-bot self-fix {list|apply <id>|discard <id>}（实现在 lib/lark-self-fix-cli.mjs）。
 * 运行目录 = 本脚本所在仓（scripts/lark-bot 用 $LARK_BOT_ROOT/scripts/lark-self-fix.mjs 调，即运行中的那套）。
 */
import { runSelfFixCli } from '../lib/lark-self-fix-cli.mjs'

const { code, out } = runSelfFixCli(process.argv.slice(2))
console.log(out)
process.exitCode = code
