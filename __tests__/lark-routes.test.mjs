import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { runSteps } from './support/steps.mjs'

process.env.LARK_GATEWAY_SECRET = 'test-secret'
// 运行态指到临时目录：health 读 worker 心跳文件，不能读 / 写本机真实运行目录（变异补测 10-24）
const runtimeRoot = mkdtempSync(join(tmpdir(), 'lark-routes-runtime-'))
process.env.LARK_RUNTIME_DIR = runtimeRoot
const { createRequestHandler } = await import('../lib/lark-routes.mjs')
const { createTaskStore } = await import('../lib/lark-task-store.mjs')
const { workerHeartbeatPath } = await import('../lib/lark-runtime-version.mjs')

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
  after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); rmSync(runtimeRoot, { recursive: true, force: true }) })

  it('按 id 取任务、续租、结单、notify、坏 body 400 与密钥校验', () => runSteps([
    ['GET /lark/tasks/:id：带密钥 200，不存在 404，没密钥 401', async () => {
      const ok = await fetch(`${base}/lark/tasks/t1`, { headers })
      assert.equal(ok.status, 200)
      assert.equal((await ok.json()).task.id, 't1')
      assert.equal((await fetch(`${base}/lark/tasks/nope`, { headers })).status, 404)
      assert.equal((await fetch(`${base}/lark/tasks/t1`)).status, 401)
    }],
    ['POST heartbeat：epoch 对 200；错 409；坏 JSON 400', async () => {
      const ok = await fetch(`${base}/lark/tasks/t1/heartbeat`, { method: 'POST', headers, body: JSON.stringify({ epoch: 0 }) })
      assert.equal(ok.status, 200)
      assert.equal((await fetch(`${base}/lark/tasks/t1/heartbeat`, { method: 'POST', headers, body: JSON.stringify({ epoch: 7 }) })).status, 409)
      assert.equal((await fetch(`${base}/lark/tasks/t1/heartbeat`, { method: 'POST', headers, body: '{bad' })).status, 400)
    }],
    ['POST /close：挂起任务结单成 superseded、记原因；已了结的 409；没密钥 401', async () => {
      store.upsert({ id: 'w1', status: 'waiting_confirmation', createdAt: '2026-01-01T00:00:00Z', text: 'x', chatId: 'oc_1' })
      assert.equal((await fetch(`${base}/lark/tasks/w1/close`, { method: 'POST', body: '{}' })).status, 401)
      const ok = await fetch(`${base}/lark/tasks/w1/close`, { method: 'POST', headers, body: JSON.stringify({ closureReason: 'completed_elsewhere' }) })
      assert.equal(ok.status, 200)
      assert.equal((await ok.json()).previousStatus, 'waiting_confirmation')
      assert.equal(store.get('w1').status, 'superseded')
      assert.equal(store.get('w1').closureReason, 'completed_elsewhere')
      assert.equal((await fetch(`${base}/lark/tasks/w1/close`, { method: 'POST', headers, body: '{}' })).status, 409)
    }],
    ['POST /notify：没密钥 401；没有外部群 profile（拿不到控制台群）404，不乱发', async () => {
      assert.equal((await fetch(`${base}/lark/notify`, { method: 'POST', body: '{}' })).status, 401)
      assert.equal((await fetch(`${base}/lark/notify`, { method: 'POST', headers, body: JSON.stringify({ repo: 'falive', markdown: 'x' }) })).status, 404)
    }],
    ['POST /intake 坏 body 400，任务不会被落成 ignored', async () => {
      store.upsert({ id: 't2', status: 'received', createdAt: '2026-01-01T00:00:00Z', text: 'x', intake: { required: true } })
      const res = await fetch(`${base}/lark/tasks/t2/intake`, { method: 'POST', headers, body: '"not an object"' })
      assert.equal(res.status, 400)
      assert.equal(store.get('t2').status, 'received')
    }],
    ['POST /lark/tasks 建任务：正文原样落进任务；没给正文落空串（变异补测 10-24）', async () => {
      const text = '直播列表第 2 页接口返回的 cover 字段为空，帮忙看一下'
      const ok = await fetch(`${base}/lark/tasks`, { method: 'POST', headers, body: JSON.stringify({ id: 'mk_text', text }) })
      assert.equal(ok.status, 200)
      assert.equal((await ok.json()).task.text, text, '响应里的任务带正文')
      assert.equal(store.get('mk_text').text, text, '落盘的任务带正文，worker 才知道要做什么')
      assert.equal(store.get('mk_text').status, 'queued')
      const empty = await fetch(`${base}/lark/tasks`, { method: 'POST', headers, body: JSON.stringify({ id: 'mk_empty' }) })
      assert.equal(empty.status, 200)
      assert.equal(store.get('mk_empty').text, '', '没给正文落空串，不落 undefined')
    }],
    ['GET /lark/health：worker 就绪检查过了不报「尚未就绪」；没过才报；没心跳只报未见心跳（变异补测 10-24）', async () => {
      const file = workerHeartbeatPath(runtimeRoot)
      const health = async () => {
        const res = await fetch(`${base}/lark/health`)
        assert.equal(res.status, 200)
        return (await res.json()).warnings
      }
      const notReady = (warnings) => warnings.some((line) => line.includes('尚未完成 AI executor/model 就绪检查'))
      try {
        const beat = (readiness) => writeFileSync(file, JSON.stringify({ pid: 1, codeHash: 'h', heartbeatAt: new Date().toISOString(), readiness }))
        beat({ ok: true })
        assert.equal(notReady(await health()), false, 'worker 已就绪，不能误报尚未就绪')
        beat({ ok: false })
        assert.equal(notReady(await health()), true, 'worker 就绪检查没过要报')
        rmSync(file, { force: true })
        const missing = await health()
        assert.ok(missing.some((line) => line.includes('未见 worker 版本心跳')), '没心跳报未见心跳')
        assert.equal(notReady(missing), false, '没心跳不再叠报尚未就绪')
      } finally {
        rmSync(file, { force: true })
      }
    }],
  ]))
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

  it('按状态查只返回可领取的，变更流按 since 挂起或回 seq', () => runSteps([
    ['GET /lark/tasks?status=queued 只返回可领取的', async () => {
      const res = await (await fetch(`${base}/lark/tasks?status=queued,received`, { headers })).json()
      assert.deepEqual(res.tasks.map((task) => task.id), ['q1'])
    }],
    ['GET /lark/tasks/changes：无 since 只回 seq；有 since 挂到有变更或超时', async () => {
      const head = await (await fetch(`${base}/lark/tasks/changes`, { headers })).json()
      assert.equal(head.seq, 2)
      assert.deepEqual(head.changes, [])
      const pending = fetch(`${base}/lark/tasks/changes?since=2&wait=2000`, { headers })
      await new Promise((resolve) => setTimeout(resolve, 30))
      store.claimById('q1')
      const page = await (await pending).json()
      assert.equal(page.changes.length, 1)
      assert.deepEqual([page.changes[0].id, page.changes[0].status], ['q1', 'running'])
      const empty = await (await fetch(`${base}/lark/tasks/changes?since=${page.seq}&wait=20`, { headers })).json()
      assert.deepEqual(empty.changes, [])
      assert.equal((await fetch(`${base}/lark/tasks/changes?since=0`)).status, 401)
    }],
  ]))
})
