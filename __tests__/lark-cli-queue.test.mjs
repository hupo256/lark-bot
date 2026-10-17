import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

// 假 lark-cli：睡 150ms 后吐 ok。LARK_CLI_BIN 在模块加载时读，所以先设环境再动态 import。
const dir = mkdtempSync(join(tmpdir(), 'lark-cli-q-'))
const bin = join(dir, 'fake-lark-cli')
writeFileSync(bin, '#!/bin/sh\nsleep 0.3\necho "{\\"ok\\":true,\\"data\\":{}}"\n')
chmodSync(bin, 0o755)
process.env.LARK_CLI_BIN = bin
process.env.LARK_CLI_CONCURRENCY = '2'
const { larkCliQueueStats, runLarkCli } = await import('../lib/lark-cli.mjs')

describe('lark-cli 子进程限流（第 1 批）', () => {
  it('同身份最多 2 个并发，其余排队；send 优先于 read', async () => {
    try {
      const order = []
      const run = (tag, priority) => runLarkCli(['im', tag], { identity: 'user', priority }).then(() => order.push(tag))
      // 机器负载高时子进程起得慢：等到状态满足再断言，不用固定毫秒数。
      const until = async (predicate, label) => {
        // 全量跑时几十个测试进程并发，起一个 sh 子进程可能要几百毫秒：最多等 15s。
        for (let i = 0; i < 1500; i += 1) {
          if (predicate()) return
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        assert.fail(`等不到：${label}（${JSON.stringify(larkCliQueueStats().user)}）`)
      }
      const first = [run('r1', 'read'), run('r2', 'read')]
      await until(() => larkCliQueueStats().user.running === 2, '两个在跑')
      assert.deepEqual(larkCliQueueStats().user, { running: 2, queued: 0 })
      const rest = [run('r3', 'read'), run('r4', 'read'), run('s1', 'send')]
      await until(() => larkCliQueueStats().user.queued === 3, '三个排队')
      await Promise.all([...first, ...rest])
      assert.equal(order.indexOf('s1') < order.indexOf('r3'), true, '排队的 send 先于排队的 read')
      assert.deepEqual(larkCliQueueStats().user, { running: 0, queued: 0 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
