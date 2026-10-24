import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  DEFAULT_TASK_BUDGET_MS,
  claudeProjectKey,
  defaultClaudeMemoryDir,
  ensureSharedClaudeMemory,
  isShutdownAbort,
  remainingTaskBudgetMs,
  startLeaseHeartbeat,
} from '../lib/lark-task-runner-support.mjs'
import { isExecutionSuperseded, monitorExecutionCancellation } from '../lib/lark-task-runner.mjs'

describe('任务截止时间与续租心跳', () => {
  it('剩余预算从领取时刻起算；任务自带 taskBudgetMs 优先；超预算也留 60s 写失败', () => {
    const now = Date.parse('2026-10-17T10:00:00Z')
    assert.equal(remainingTaskBudgetMs({ claimedAt: '2026-10-17T09:50:00Z' }, now), DEFAULT_TASK_BUDGET_MS - 10 * 60_000)
    assert.equal(remainingTaskBudgetMs({ claimedAt: '2026-10-17T09:00:00Z', taskBudgetMs: 30 * 60_000 }, now), 60_000)
    assert.equal(remainingTaskBudgetMs({}, now), DEFAULT_TASK_BUDGET_MS)
  })

  it('退出型中断不写 failed，截止时间（TimeoutError）要写 failed', () => {
    const shutdown = new AbortController()
    shutdown.abort()
    assert.equal(isShutdownAbort(shutdown.signal), true)
    const timeout = AbortSignal.timeout(1)
    return new Promise((resolve) => setTimeout(() => {
      assert.equal(timeout.aborted, true)
      assert.equal(isShutdownAbort(timeout), false)
      assert.equal(isShutdownAbort(undefined), false)
      resolve()
    }, 20))
  })

  it('心跳每 leaseMs/3 续一次；gateway 回 ok:false（epoch 变了）就停；stop 后不再调', async () => {
    const calls = []
    let tick = null
    let cleared = 0
    const client = { heartbeatTask: async (id, epoch) => { calls.push([id, epoch]); return calls.length >= 2 ? { ok: false, code: 409 } : { ok: true } } }
    const stop = startLeaseHeartbeat({
      client,
      task: { id: 't1', epoch: 3 },
      leaseMs: 90_000,
      setIntervalImpl: (fn, ms) => { tick = fn; assert.equal(ms, 30_000); return { unref() {} } },
      clearIntervalImpl: () => { cleared += 1 },
    })
    await tick()
    assert.deepEqual(calls, [['t1', 3]])
    await tick()
    assert.equal(cleared, 1, '409 后停心跳')
    await tick()
    assert.equal(calls.length, 2, '停了就不再调')
    stop()
    assert.equal(startLeaseHeartbeat({ client: {}, task: { id: 'x' } })(), undefined, '没有 heartbeatTask 的 client 直接 no-op')
  })

  it('取消检测与监控仍从 lark-task-runner 转出口（旧引用不变）', async () => {
    assert.equal(isExecutionSuperseded({ current: { status: 'superseded', epoch: 0 }, claimedEpoch: 0 }), true)
    assert.equal(isExecutionSuperseded({ current: { status: 'running', epoch: 2 }, claimedEpoch: 1 }), true)
    assert.equal(isExecutionSuperseded({ current: null, claimedEpoch: 1 }), false)
    const controller = new AbortController()
    const stop = monitorExecutionCancellation({ getTask: async () => ({ status: 'running', epoch: 9 }), taskId: 't', claimedEpoch: 1, controller, intervalMs: 50 })
    await new Promise((resolve) => setTimeout(resolve, 120))
    stop()
    assert.equal(controller.signal.aborted, true)
  })
})

describe('项目记忆软链（bot 的临时 worktree 与负责人主仓读同一份 ~/.claude/projects/<主仓>/memory）', () => {
  it('cwd → Claude 项目目录键；缺省记忆目录按业务主仓推导', () => {
    assert.equal(claudeProjectKey('/Users/aven/github/fameex-web'), '-Users-aven-github-fameex-web')
    assert.equal(defaultClaudeMemoryDir({ repoRoot: '/Users/aven/github/fameex-web', claudeHome: '/h/.claude' }), '/h/.claude/projects/-Users-aven-github-fameex-web/memory')
    assert.equal(defaultClaudeMemoryDir({ repoRoot: null }), null)
  })
  it('首次软链；再次调用识别已软链；目标是真实目录时不动；记忆目录不存在不做', () => {
    const home = mkdtempSync(join(tmpdir(), 'lark-claude-home-'))
    try {
      const memoryDir = join(home, 'main-memory')
      mkdirSync(memoryDir)
      const cwd = '/tmp/worktrees/PR-1'
      assert.deepEqual(ensureSharedClaudeMemory({ cwd, memoryDir, claudeHome: home }), { ok: true, linked: true })
      const target = join(home, 'projects', claudeProjectKey(cwd), 'memory')
      assert.ok(lstatSync(target).isSymbolicLink())
      assert.equal(ensureSharedClaudeMemory({ cwd, memoryDir, claudeHome: home }).linked, false)
      const real = '/tmp/worktrees/PR-2'
      mkdirSync(join(home, 'projects', claudeProjectKey(real), 'memory'), { recursive: true })
      assert.equal(ensureSharedClaudeMemory({ cwd: real, memoryDir, claudeHome: home }).ok, false)
      assert.equal(ensureSharedClaudeMemory({ cwd, memoryDir: join(home, 'missing'), claudeHome: home }).reason, 'no memory dir')
      assert.equal(existsSync(join(home, 'projects', claudeProjectKey('/tmp/worktrees/PR-3'))), false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
