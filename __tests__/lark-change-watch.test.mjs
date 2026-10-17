import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createChangeWatcher } from '../lib/lark-change-watch.mjs'

describe('变更流监听（第 2 批）', () => {
  it('一条长轮询盯多个任务：换代 / superseded 触发回调并取消监听；无关变更不触发', async () => {
    const pages = [
      { seq: 10, changes: [] },
      { seq: 12, changes: [{ seq: 11, id: 'a', status: 'running', epoch: 0 }, { seq: 12, id: 'b', status: 'superseded', epoch: 0 }] },
      { seq: 13, changes: [{ seq: 13, id: 'a', status: 'queued', epoch: 1 }] },
    ]
    const requested = []
    const client = { watchChanges: async ({ since }) => { requested.push(since); return pages.shift() || await new Promise(() => {}) } }
    const fired = []
    const watcher = createChangeWatcher({ client, waitMs: 1 })
    watcher.watch('a', 0, (entry) => fired.push(['a', entry.status, entry.epoch]))
    watcher.watch('b', 0, (entry) => fired.push(['b', entry.status]))
    // 等到两个回调都到（最多 5s），不用固定毫秒数——全量并发时事件循环可能被挤
    for (let i = 0; i < 500 && fired.length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.deepEqual(fired, [['b', 'superseded'], ['a', 'queued', 1]])
    assert.deepEqual(requested.slice(0, 3), [-1, 10, 12], '先对齐游标再从 seq 之后拉')
    assert.equal(watcher.size(), 0)
    watcher.stop()
  })
})
