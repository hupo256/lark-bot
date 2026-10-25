#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
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

  it('status 先列进程，空行后再列 executor 与任务', () => {
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
        printf '%s' '{"ok":true,"worker":{"pid":202,"heartbeatStale":false,"codeStale":false,"readiness":{"ok":true,"executor":"codex","model":"gpt-5.6-sol","reasoningEffort":"high","modelProbe":"passed"}},"version":{"startedAt":"2026-08-26T07:39:48.923Z"},"counts":{},"pendingReceipts":{"total":0}}'
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
          printf '%s' '{"ok":true,"worker":{"pid":101,"readiness":{"ok":true,"executor":"claude"}},"counts":{"waiting_confirmation":1},"pendingReceipts":{"total":0}}'
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
          printf '%s' '{"ok":true,"worker":{"pid":101,"readiness":{"ok":true,"executor":"claude"}},"counts":{"waiting_confirmation":2},"pendingReceipts":{"total":0}}'
        fi
      }
      status
    `)
    assert.match(result.stdout, /tasks:.*waiting=2/)
    assert.match(result.stdout, /⚠ 有 2 个挂起任务但取不到明细/)
    // 发布层 stale 检测已下线：status 不再输出 `rules:` 行（2026-09-10）。
    assert.doesNotMatch(result.stdout, /rules:/)
  })

  it('worker 排空中：status 显示排空与在飞数，旧代码 / 旧配置提示改成「会自动 restart」；心跳停了或 pid 对不上不算排空', () => {
    const statusWith = (worker, version) => runBash(`
      export LARK_BOT_SOURCE_ONLY=1
      source ${JSON.stringify(script)}
      _pid() { echo 101 ; }
      curl() {
        if printf '%s' "$*" | grep -q '/lark/tasks'; then
          printf '%s' '{"tasks":[]}'
        else
          printf '%s' '${JSON.stringify({ ok: true, worker, version, counts: {}, pendingReceipts: { total: 0 } })}'
        fi
      }
      status
    `)
    const version = { codeStale: true, codeHash: 'aaa', diskCodeHash: 'bbb', configStale: true, configHash: 'c1', diskConfigHash: 'c2' }
    const draining = { pid: 101, codeHash: 'aaa', codeStale: true, draining: true, inFlight: 2, readiness: { ok: true, executor: 'claude' } }
    const drainingRun = statusWith(draining, version)
    const out = drainingRun.stdout
    // 10-24 沙箱试跑：排空中 status 把 worker 标 unhealthy、退出码 1；排空是正常的自动上线过程
    assert.match(out, /lark-worker:  running  pid=101  排空中（在飞 2 个，跑完即自动 restart）\n/)
    assert.equal(drainingRun.status, 0, out)
    assert.match(out, /gateway 跑的是旧代码（aaa，磁盘 bbb）：worker 排空中，在飞任务跑完、自检绿会自动 restart/)
    assert.match(out, /gateway 跑的是旧配置（c1，磁盘 c2）：worker 排空中/)
    assert.match(out, /worker 跑的是旧代码（aaa，磁盘 bbb）：worker 排空中/)
    assert.doesNotMatch(out, /需 lark-bot restart/)
    for (const notDraining of [{ ...draining, draining: false }, { ...draining, heartbeatStale: true }, { ...draining, pid: 999 }]) {
      const plainRun = statusWith(notDraining, version)
      const plain = plainRun.stdout
      assert.doesNotMatch(plain, /排空中/)
      assert.match(plain, /worker 跑的是旧代码（aaa，磁盘 bbb）：需 lark-bot restart/)
      assert.match(plain, /lark-worker:  unhealthy/)
      assert.equal(plainRun.status, 1)
    }
    // 自修工单在跑：status 显示自修中 + 工单 id（心跳的 inFlight 已把它算进去）
    const selfFix = { id: 'sf-20261024-abcdef12', since: '2026-10-24T01:00:00.000Z' }
    const fixing = statusWith({ ...draining, inFlight: 1, selfFix }, version).stdout
    assert.match(fixing, /lark-worker:  running  pid=101  排空中（在飞 1 个，跑完即自动 restart）  自修中 sf-20261024-abcdef12（自 2026-10-24T01:00）\n/)
    const fixingFresh = statusWith({ pid: 101, inFlight: 1, selfFix, readiness: { ok: true, executor: 'claude' } }, {}).stdout
    assert.match(fixingFresh, /lark-worker:  running  pid=101  自修中 sf-20261024-abcdef12（自 2026-10-24T01:00）\n/)
  })

  // 10-24 沙箱试跑：status / failed / retry / clean / close / resume / receipt-retry 把 3005 写死，沙箱实例（别的端口）全打到正式那套。
  it('gateway 地址统一认 LARK_GATEWAY_URL（缺省 http://127.0.0.1:3005），status 的 port 跟着它', () => {
    const calls = (url) => runBash(`
      export LARK_BOT_SOURCE_ONLY=1
      ${url ? `export LARK_GATEWAY_URL=${url}` : 'unset LARK_GATEWAY_URL'}
      source ${JSON.stringify(script)}
      _pid() { echo 101 ; }
      node() { cat >/dev/null; command node "$@" </dev/null >/dev/null 2>&1 || true; }
      log="$(mktemp)"
      curl() { for a in "$@"; do case "$a" in http*) echo "URL $a" >>"$log" ;; esac; done; }
      failed; retry t1; receipt_retry t2; clean 3; status
      cat "$log"; rm -f "$log"
    `).stdout
    const custom = calls('http://127.0.0.1:3999')
    assert.deepEqual(custom.match(/^URL .*$/gm), [
      'URL http://127.0.0.1:3999/lark/tasks',
      'URL http://127.0.0.1:3999/lark/tasks/t1/retry',
      'URL http://127.0.0.1:3999/lark/tasks/t2/receipt/retry',
      'URL http://127.0.0.1:3999/lark/tasks/prune',
      'URL http://127.0.0.1:3999/lark/health',
      'URL http://127.0.0.1:3999/lark/tasks',
    ])
    assert.doesNotMatch(custom, /3005/)
    assert.match(calls(''), /^URL http:\/\/127\.0\.0\.1:3005\/lark\/health$/m)
    const statusPort = (url) => runBash(`
      export LARK_BOT_SOURCE_ONLY=1
      export LARK_GATEWAY_URL=${url}
      source ${JSON.stringify(script)}
      _pid() { echo 101 ; }
      curl() { case "$*" in *health*) printf '%s' '{"ok":true,"worker":{"pid":101,"readiness":{"ok":true,"executor":"claude"}},"counts":{},"pendingReceipts":{"total":0}}' ;; *) printf '%s' '{"tasks":[]}' ;; esac; }
      status
    `).stdout
    assert.match(statusPort('http://127.0.0.1:3999'), /lark-gateway: running  port=3999\n/)
    assert.match(statusPort('http://localhost'), /lark-gateway: running  url=http:\/\/localhost\n/)
    const src = readFileSync(script, 'utf8')
    assert.deepEqual(src.match(/3005/g), ['3005'], '3005 只该出现在缺省值一处')
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
          printf '%s' '{"ok":true,"worker":{"pid":101,"readiness":{"ok":true,"executor":"claude"}},"counts":{},"pendingReceipts":{"total":0}}'
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
