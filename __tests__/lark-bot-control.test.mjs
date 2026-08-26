#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, '../scripts/lark-bot')

const runBash = (body) => spawnSync('bash', ['-c', body], { encoding: 'utf8' })

describe('lark-bot control script', () => {
  it('脚本语法合法', () => {
    const result = spawnSync('bash', ['-n', script], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  })

  it('wait_until 超时必须返回非零，不能假成功', () => {
    const result = runBash(`
      export LARK_BOT_SOURCE_ONLY=1
      source ${JSON.stringify(script)}
      START_TIMEOUT_SECONDS=1
      never_ready() { return 1; }
      wait_until test-service never_ready
    `)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /test-service.*未在 1s 内就绪/)
  })

  it('restart 仅在原 poller 运行时恢复，并且恢复发生在 core 启动之后', () => {
    const result = runBash(`
      export LARK_BOT_SOURCE_ONLY=1
      source ${JSON.stringify(script)}
      _running() { return 0; }
      stop() { echo stop; }
      sleep() { :; }
      start() { echo start; }
      poll_on() { echo poll-on; }
      status() { echo status; }
      restart
    `)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /stop\nstart\npoll-on\n.*restored poller.*\nstatus/s)
  })

  it('原 poller 未运行时也执行最终严格 status', () => {
    const result = runBash(`
      export LARK_BOT_SOURCE_ONLY=1
      source ${JSON.stringify(script)}
      _running() { return 1; }
      stop() { echo stop; }
      sleep() { :; }
      start() { echo start; }
      poll_on() { echo unexpected-poll-on; }
      status() { echo status; }
      restart
    `)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /stop\nstart\nstatus/s)
    assert.doesNotMatch(result.stdout, /unexpected-poll-on/)
  })

  it('restart 最终 status 不健康时返回非零', () => {
    const result = runBash(`
      export LARK_BOT_SOURCE_ONLY=1
      source ${JSON.stringify(script)}
      _running() { return 1; }
      stop() { :; }
      sleep() { :; }
      start() { :; }
      status() { return 1; }
      restart
    `)
    assert.notEqual(result.status, 0)
  })

  it('status 先列进程，空行后再列 executor、任务与规则', () => {
    const result = runBash(`
      export LARK_BOT_SOURCE_ONLY=1
      source ${JSON.stringify(script)}
      _pid() {
        case "$1" in
          "$GW") echo 101 ;;
          "$WK") echo 202 ;;
          "$POLLER") echo 303 ;;
        esac
      }
      curl() {
        printf '%s' '{"ok":true,"worker":{"pid":202,"heartbeatStale":false,"codeStale":false,"readiness":{"ok":true,"executor":"codex","model":"gpt-5.6-sol","reasoningEffort":"high","modelProbe":"passed"}},"version":{"startedAt":"2026-08-26T07:39:48.923Z"},"counts":{},"ruleChainFresh":true,"pendingReceipts":{"total":0}}'
      }
      status
    `)
    assert.equal(result.status, 0, result.stderr)
    assert.match(
      result.stdout,
      /lark-worker:  running  pid=202\npoller:       running  pid=303\n\nexecutor:     codex  model=gpt-5\.6-sol  reasoning=high  probe=passed\ntasks:/,
    )
  })
})
