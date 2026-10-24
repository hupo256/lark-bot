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

  it('按 id 取任务、续租、结单、notify、坏 body 400 与密钥校验', async () => {
    {
      const case1 = 'GET /lark/tasks/:id：带密钥 200，不存在 404，没密钥 401'
      const ok = await fetch(`${base}/lark/tasks/t1`, { headers })
      assert.equal(ok.status, 200, case1)
      assert.equal((await ok.json()).task.id, 't1', case1)
      assert.equal((await fetch(`${base}/lark/tasks/nope`, { headers })).status, 404, case1)
      assert.equal((await fetch(`${base}/lark/tasks/t1`)).status, 401, case1)
    }

    {
      const case2 = 'POST heartbeat：epoch 对 200；错 409；坏 JSON 400'
      const ok = await fetch(`${base}/lark/tasks/t1/heartbeat`, { method: 'POST', headers, body: JSON.stringify({ epoch: 0 }) })
      assert.equal(ok.status, 200, case2)
      assert.equal((await fetch(`${base}/lark/tasks/t1/heartbeat`, { method: 'POST', headers, body: JSON.stringify({ epoch: 7 }) })).status, 409, case2)
      assert.equal((await fetch(`${base}/lark/tasks/t1/heartbeat`, { method: 'POST', headers, body: '{bad' })).status, 400, case2)
    }

    {
      const t3 = 'POST /close：挂起任务结单成 superseded、记原因；已了结的 409；没密钥 401'
      store.upsert({ id: 'w1', status: 'waiting_confirmation', createdAt: '2026-01-01T00:00:00Z', text: 'x', chatId: 'oc_1' })
      assert.equal((await fetch(`${base}/lark/tasks/w1/close`, { method: 'POST', body: '{}' })).status, 401, t3)
      const ok = await fetch(`${base}/lark/tasks/w1/close`, { method: 'POST', headers, body: JSON.stringify({ closureReason: 'completed_elsewhere' }) })
      assert.equal(ok.status, 200, t3)
      assert.equal((await ok.json()).previousStatus, 'waiting_confirmation', t3)
      assert.equal(store.get('w1').status, 'superseded', t3)
      assert.equal(store.get('w1').closureReason, 'completed_elsewhere', t3)
      assert.equal((await fetch(`${base}/lark/tasks/w1/close`, { method: 'POST', headers, body: '{}' })).status, 409, t3)
    }

    {
      const t4 = 'POST /notify：没密钥 401；没有外部群 profile（拿不到控制台群）404，不乱发'
      assert.equal((await fetch(`${base}/lark/notify`, { method: 'POST', body: '{}' })).status, 401, t4)
      assert.equal((await fetch(`${base}/lark/notify`, { method: 'POST', headers, body: JSON.stringify({ repo: 'falive', markdown: 'x' }) })).status, 404, t4)
    }

    {
      const t5 = 'POST /intake 坏 body 400，任务不会被落成 ignored'
      store.upsert({ id: 't2', status: 'received', createdAt: '2026-01-01T00:00:00Z', text: 'x', intake: { required: true } })
      const res = await fetch(`${base}/lark/tasks/t2/intake`, { method: 'POST', headers, body: '"not an object"' })
      assert.equal(res.status, 400, t5)
      assert.equal(store.get('t2').status, 'received', t5)
    }
  })
})

describe('变更流与按状态查（第 2 批）', () => {
  let dir
  let server
  let base
  let store
  const headers = { 'x-lark-gateway-secret': 'test-secret' }
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lark-routes-changes-'))
    store = createTaskStore({ tasksDir: dir, leaseMs: 60_000 })
    store.upsert({ id: 'q1', status: 'queued', createdAt: '2026-01-01T00:00:00Z', text: 'x' })
    store.upsert({ id: 'd1', status: 'done', createdAt: '2026-01-01T00:00:00Z', text: 'x' })
    server = createServer(createRequestHandler({ config: { project: 'PR-1' }, store, consumer: { observe: () => ({ alive: true }) }, port: 0, runtimeVersion: { observe: () => ({}) } }))
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${server.address().port}`
  })
  after(() => { server.close(); rmSync(dir, { recursive: true, force: true }) })

  it('按状态查只返回可领取的，变更流按 since 挂起或回 seq', async () => {
    const t1 = 'GET /lark/tasks?status=queued 只返回可领取的'
    const res = await (await fetch(`${base}/lark/tasks?status=queued,received`, { headers })).json()
    assert.deepEqual(res.tasks.map((task) => task.id), ['q1'], t1)

    const t2 = 'GET /lark/tasks/changes：无 since 只回 seq；有 since 挂到有变更或超时'
    const head = await (await fetch(`${base}/lark/tasks/changes`, { headers })).json()
    assert.equal(head.seq, 2, t2)
    assert.deepEqual(head.changes, [], t2)
    const pending = fetch(`${base}/lark/tasks/changes?since=2&wait=2000`, { headers })
    await new Promise((resolve) => setTimeout(resolve, 30))
    store.claimById('q1')
    const page = await (await pending).json()
    assert.equal(page.changes.length, 1, t2)
    assert.deepEqual([page.changes[0].id, page.changes[0].status], ['q1', 'running'], t2)
    const empty = await (await fetch(`${base}/lark/tasks/changes?since=${page.seq}&wait=20`, { headers })).json()
    assert.deepEqual(empty.changes, [], t2)
    assert.equal((await fetch(`${base}/lark/tasks/changes?since=0`)).status, 401, t2)
  })
})
