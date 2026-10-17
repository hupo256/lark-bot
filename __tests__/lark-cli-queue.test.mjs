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
process.env.LARK_CLI_CONCURRENCY = '1'
const { larkCliQueueStats, runLarkCli } = await import('../lib/lark-cli.mjs')

describe('lark-cli 子进程限流（第 1 批）', () => {
  it('同身份并发受限，其余排队；排队时 send 先于 read（并发 1 使完成顺序可判定，不受调度抖动影响）', async () => {
    try {
      const order = []
      const run = (tag, priority) => runLarkCli(['im', tag], { identity: 'user', priority }).then(() => order.push(tag))
      const until = async (predicate, label) => {
        // 全量跑时几十个测试进程并发，起一个 sh 子进程可能要几百毫秒：最多等 15s。
        for (let i = 0; i < 1500; i += 1) {
          if (predicate()) return
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        assert.fail(`等不到：${label}（${JSON.stringify(larkCliQueueStats().user)}）`)
      }
      const first = run('r1', 'read')
      await until(() => larkCliQueueStats().user.running === 1, '一个在跑')
      const rest = [run('r2', 'read'), run('r3', 'read'), run('s1', 'send')]
      await until(() => larkCliQueueStats().user.queued === 3, '三个排队')
      await Promise.all([first, ...rest])
      assert.deepEqual(order, ['r1', 's1', 'r2', 'r3'], '排队的 send 先于排队的 read')
      assert.deepEqual(larkCliQueueStats().user, { running: 0, queued: 0 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
