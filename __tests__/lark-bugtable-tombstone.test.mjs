import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { classifyBugPollAction, classifyBugTaskStatus, isBugtableTombstone } from '../lib/lark-bugtable-parse.mjs'
import { createTaskStore } from '../lib/lark-task-store.mjs'
import { gitTail } from '../lib/lark-worker-git.mjs'

// aven 2026-10-20 review：bug 表里判「无需改动」/ 人工结单的任务，表格仍是待处理；
// 任务被定期清理后 poller 查不到它，就按新 bug 重跑。人工结单原来连清理都不用等，每轮都按新 bug 入队。
describe('bug 表终局任务不重跑', () => {
  it('人工结单（superseded）与无需改动一样是终局，poller 不入队', () => {
    assert.equal(classifyBugTaskStatus('superseded'), 'no-change')
    assert.equal(classifyBugPollAction({ recordStatus: '待处理', taskStatus: 'superseded', seen: false, rejectedValue: '验退' }), 'no-change')
    assert.equal(classifyBugPollAction({ recordStatus: '待处理', taskStatus: undefined, seen: false, rejectedValue: '验退' }), 'enqueue')
  })

  it('只有 bug 表来源的无需改动 / 人工结单算墓碑', () => {
    assert.equal(isBugtableTombstone({ source: 'lark-bugtable', status: 'no_change_needed' }), true)
    assert.equal(isBugtableTombstone({ source: 'lark-bugtable', status: 'superseded' }), true)
    assert.equal(isBugtableTombstone({ source: 'lark-bugtable', status: 'done' }), false)
    assert.equal(isBugtableTombstone({ source: 'lark', status: 'no_change_needed' }), false)
  })

  it('定期清理留着墓碑，其它陈旧终态照删', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bugtable-tombstone-'))
    try {
      const old = { createdAt: '2000-01-01T00:00:00Z', updatedAt: '2000-01-01T00:00:00Z' }
      for (const task of [
        { id: 'rec-nochange', source: 'lark-bugtable', status: 'no_change_needed', ...old },
        { id: 'rec-closed', source: 'lark-bugtable', status: 'superseded', ...old },
        { id: 'rec-done', source: 'lark-bugtable', status: 'done', ...old },
        { id: 'chat-nochange', source: 'lark', status: 'no_change_needed', ...old },
      ]) writeFileSync(join(dir, `${task.id}.json`), JSON.stringify(task))
      const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
      const removed = store.pruneTerminal({ olderThanMs: 60_000, statuses: ['done', 'no_change_needed', 'superseded'], keep: isBugtableTombstone })
      assert.deepEqual(removed.sort(), ['chat-nochange', 'rec-done'])
      assert.equal(store.has('rec-nochange'), true)
      assert.equal(store.has('rec-closed'), true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('gitTail', () => {
  it('短输出原样；长输出首尾各留一半，末尾的真实报错不被截掉', () => {
    assert.equal(gitTail({ stderr: '  short error  ' }), 'short error')
    const long = `${'Backing up original state...\n'.repeat(20)}✖ biome check failed: src/a.ts`
    const out = gitTail({ stderr: long }, 120)
    assert.ok(out.length <= 120)
    assert.match(out, /^Backing up/)
    assert.match(out, /biome check failed: src\/a\.ts$/)
  })
})
