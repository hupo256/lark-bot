import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { handleStatusUpdate } from '../lib/lark-status.mjs'
import { createTaskStore } from '../lib/lark-task-store.mjs'
import { runSteps } from './support/steps.mjs'

describe('状态回写写前核对（第 0 批：await 期间被换代 / 结单的回写拒绝，不覆盖）', () => {
  let dir
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lark-status-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const deps = (store, { onResolve = async () => null } = {}) => ({
    config: { project: 'PR-1' },
    store,
    resolveGroupChat: onResolve,
    sendMessage: async () => ({ ok: true, messageId: 'om_r' }),
    postGroup: async () => ({ ok: true }),
    deliverRepo: async () => ({ ok: true, messageId: 'om_d' }),
  })

  it('正常回写：running → done，字段落盘', () => runSteps([
    ['正常回写：running → done，字段落盘', async () => {
      const store = createTaskStore({ tasksDir: dir, leaseMs: 60_000 })
      store.upsert({ id: 't', status: 'queued', createdAt: '2026-01-01T00:00:00Z', project: 'PR-1', chatId: 'oc_1', text: 'x' })
      store.claimNext()
      const outcome = await handleStatusUpdate({ ...deps(store), id: 't', status: 'done', result: '完成', epoch: 0, changedFiles: ['a.ts'] })
      assert.equal(outcome.ok, true)
      assert.equal(store.get('t').status, 'done')
      assert.deepEqual(store.get('t').changedFiles, ['a.ts'])
    }],
    ['preChecks 落盘清洗：丢掉空项 / 缺 endpoint / endpoint 非字符串的条目，result 归一成 outcome，kind 只认白名单（变异补测 10-24）', async () => {
      const ownDir = mkdtempSync(join(tmpdir(), 'lark-status-prechecks-'))
      try {
        const store = createTaskStore({ tasksDir: ownDir, leaseMs: 60_000 })
        store.upsert({ id: 't', status: 'queued', createdAt: '2026-01-01T00:00:00Z', project: 'PR-1', chatId: 'oc_1', text: 'x' })
        store.claimNext()
        const preChecks = [
          null,
          { outcome: '没写 endpoint' },
          { endpoint: 42, outcome: 'endpoint 不是字符串' },
          { endpoint: '/api/a', result: '200', kind: 'ok' },
          { endpoint: '/api/b', outcome: '字段缺失', kind: 'weird' },
        ]
        const outcome = await handleStatusUpdate({ ...deps(store), id: 't', status: 'done', result: '完成', epoch: 0, preChecks })
        assert.equal(outcome.ok, true)
        assert.deepEqual(store.get('t').preChecks, [
          { endpoint: '/api/a', outcome: '200', kind: 'ok' },
          { endpoint: '/api/b', outcome: '字段缺失' },
        ])
      } finally {
        rmSync(ownDir, { recursive: true, force: true })
      }
    }],
  ]))

  it('await 期间任务被交还队列（epoch+1）：回写 409，任务仍是 queued、result 不被覆盖', async () => {
    const store = createTaskStore({ tasksDir: dir, leaseMs: 60_000 })
    store.upsert({ id: 't', status: 'queued', createdAt: '2026-01-01T00:00:00Z', project: 'PR-1', chatId: 'oc_1', text: 'x', result: '旧' })
    store.claimNext()
    const outcome = await handleStatusUpdate({
      ...deps(store, { onResolve: async () => { store.releaseRunning('t'); return null } }),
      id: 't', status: 'done', result: '迟到的 done', epoch: 0,
    })
    assert.equal(outcome.ok, false)
    assert.equal(outcome.code, 409)
    assert.equal(store.get('t').status, 'queued')
    assert.equal(store.get('t').epoch, 1)
    assert.equal(store.get('t').result, '旧')
  })
})
