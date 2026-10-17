import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

process.env.LARK_GATEWAY_SECRET = 'test-secret'
const { createRequestHandler } = await import('../lib/lark-routes.mjs')
const { createTaskStore } = await import('../lib/lark-task-store.mjs')

describe('gateway 路由（第 0 批：按 id 取任务、续租、坏 body 400）', () => {
  let dir
  let server
  let base
  let store
  const headers = { 'x-lark-gateway-secret': 'test-secret', 'Content-Type': 'application/json' }
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lark-routes-'))
    store = createTaskStore({ tasksDir: dir, leaseMs: 60_000 })
    store.upsert({ id: 't1', status: 'queued', createdAt: '2026-01-01T00:00:00Z', text: 'hi', chatId: 'oc_1' })
    store.claimNext()
    server = createServer(createRequestHandler({
      config: { project: 'PR-1' },
      store,
      consumer: { observe: () => ({ alive: true }) },
      port: 0,
      runtimeVersion: { observe: () => ({}) },
    }))
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${server.address().port}`
  })
  after(() => { server.close(); rmSync(dir, { recursive: true, force: true }) })

  it('GET /lark/tasks/:id：带密钥 200，不存在 404，没密钥 401', async () => {
    const ok = await fetch(`${base}/lark/tasks/t1`, { headers })
    assert.equal(ok.status, 200)
    assert.equal((await ok.json()).task.id, 't1')
    assert.equal((await fetch(`${base}/lark/tasks/nope`, { headers })).status, 404)
    assert.equal((await fetch(`${base}/lark/tasks/t1`)).status, 401)
  })

  it('POST heartbeat：epoch 对 200；错 409；坏 JSON 400', async () => {
    const ok = await fetch(`${base}/lark/tasks/t1/heartbeat`, { method: 'POST', headers, body: JSON.stringify({ epoch: 0 }) })
    assert.equal(ok.status, 200)
    assert.equal((await fetch(`${base}/lark/tasks/t1/heartbeat`, { method: 'POST', headers, body: JSON.stringify({ epoch: 7 }) })).status, 409)
    assert.equal((await fetch(`${base}/lark/tasks/t1/heartbeat`, { method: 'POST', headers, body: '{bad' })).status, 400)
  })

  it('POST /intake 坏 body 400，任务不会被落成 ignored', async () => {
    store.upsert({ id: 't2', status: 'received', createdAt: '2026-01-01T00:00:00Z', text: 'x', intake: { required: true } })
    const res = await fetch(`${base}/lark/tasks/t2/intake`, { method: 'POST', headers, body: '"not an object"' })
    assert.equal(res.status, 400)
    assert.equal(store.get('t2').status, 'received')
  })
})
