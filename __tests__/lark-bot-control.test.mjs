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

  // 挂起任务催办满 N 轮后 gateway 就闭嘴了，此后只有 status 能盘点到它们；计数与明细必须都在。
  it('status 列出 waiting_confirmation 计数与明细（含续跑/结单指令）', () => {
    const result = runBash(`
      export LARK_BOT_SOURCE_ONLY=1
      source ${JSON.stringify(script)}
      _pid() { echo 101 ; }
      curl() {
        if printf '%s' "$*" | grep -q '/lark/tasks'; then
          printf '%s' '{"tasks":[{"id":"recAAA","status":"waiting_confirmation","project":"PR-02172","summary":"修复：埋点没上报","result":"需人工确认 / 补充材料后才能继续。","parkedAt":"2020-01-01T00:00:00.000Z","parkedRemindedRound":2},{"id":"recBBB","status":"done","summary":"不该出现"}]}'
        else
          printf '%s' '{"ok":true,"worker":{"pid":101,"readiness":{"ok":true,"executor":"claude"}},"counts":{"waiting_confirmation":1},"ruleChainFresh":true,"pendingReceipts":{"total":0}}'
        fi
      }
      status
    `)
    assert.match(result.stdout, /tasks:.*waiting=1/)
    assert.match(result.stdout, /waiting-confirmation（等人补料\/确认/)
    assert.match(result.stdout, /recAAA\s+\[PR-02172\]\s+已挂起 \d+h\s+已催 2\/3 轮/)
    assert.match(result.stdout, /修复：埋点没上报/)
    assert.match(result.stdout, /→ 需人工确认 \/ 补充材料后才能继续。/)
    assert.match(result.stdout, /继续任务 recAAA <补充内容>.*结单 recAAA/)
    // 非挂起态不得混进明细
    assert.doesNotMatch(result.stdout, /不该出现/)
  })

  it('挂起明细取不到时降级为提示，不吞掉其余状态', () => {
    const result = runBash(`
      export LARK_BOT_SOURCE_ONLY=1
      source ${JSON.stringify(script)}
      _pid() { echo 101 ; }
      curl() {
        if printf '%s' "$*" | grep -q '/lark/tasks'; then
          printf '%s' 'unauthorized-not-json'
        else
          printf '%s' '{"ok":true,"worker":{"pid":101,"readiness":{"ok":true,"executor":"claude"}},"counts":{"waiting_confirmation":2},"ruleChainFresh":true,"pendingReceipts":{"total":0}}'
        fi
      }
      status
    `)
    assert.match(result.stdout, /tasks:.*waiting=2/)
    assert.match(result.stdout, /⚠ 有 2 个挂起任务但取不到明细/)
    assert.match(result.stdout, /rules:\s+fresh/)
  })

  it('无挂起任务时不输出挂起区块', () => {
    const result = runBash(`
      export LARK_BOT_SOURCE_ONLY=1
      source ${JSON.stringify(script)}
      _pid() { echo 101 ; }
      curl() {
        if printf '%s' "$*" | grep -q '/lark/tasks'; then
          printf '%s' '{"tasks":[]}'
        else
          printf '%s' '{"ok":true,"worker":{"pid":101,"readiness":{"ok":true,"executor":"claude"}},"counts":{},"ruleChainFresh":true,"pendingReceipts":{"total":0}}'
        fi
      }
      status
    `)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /tasks:.*waiting=0/)
    assert.doesNotMatch(result.stdout, /waiting-confirmation（/)
    assert.doesNotMatch(result.stdout, /取不到明细/)
  })
})
