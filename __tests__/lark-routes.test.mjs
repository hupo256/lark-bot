/**
 * Gateway HTTP 路由（lib/lark-routes.mjs createRequestHandler）：直接调 handler，假 req（Readable 正文）/ 假 res（记 writeHead / end）。
 * 真 store（临时目录）；lark-cli 用假脚本顶替（记参数、下载类成功，token 带 bad 的失败），LARK_CLI_BIN / LARK_RUNTIME_DIR / LARK_GATEWAY_SECRET
 * 在模块加载时读，所以先设环境再动态 import（同 lark-control-channel.test）。config 不配 notifyOpenId，开跑知会不发私信。
 * 一个 it，分段跑：鉴权 / health / 按 id 取 / 续租 / 结单 / 续跑 / next / intake / QA 验退 / retry / prune / claim / release / work/wait 长轮询 / 入队 / status / 回执重试 / 500；
 * 外加状态回写层（lib/lark-status.mjs）的 bug 表分支（假 lark-cli 记 record-batch-update 写了什么值）与回执判定（deliver 注入）。
 */
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { after, describe, it, mock } from 'node:test'

import { eachCase, runSteps } from './support/steps.mjs'

const dir = mkdtempSync(join(tmpdir(), 'lark-routes-'))
const runtime = join(dir, 'runtime')
mkdirSync(runtime, { recursive: true })
const bin = join(dir, 'lark-cli')
const cliLog = join(dir, 'cli.log')
writeFileSync(bin, `#!/bin/sh
printf '%s\\n' "$*" >> "${cliLog}"
case "$*" in
  *bad*) echo 'download failed' >&2; exit 1 ;;
  *download*|*record-batch-update*) printf '%s' '{"ok":true}' ;;
  *) exit 1 ;;
esac
`)
chmodSync(bin, 0o755)
const SECRET = 'route-secret'
process.env.LARK_CLI_BIN = bin
process.env.LARK_RUNTIME_DIR = runtime
process.env.LARK_GATEWAY_SECRET = SECRET
process.env.LARK_OUTBOX_DIR = join(dir, 'outbox')
process.env.LARK_OBLIGATIONS_DIR = join(dir, 'obligations')
delete process.env.LARK_EVENT_STALE_MS
const { createRequestHandler } = await import('../lib/lark-routes.mjs')
const { createTaskStore } = await import('../lib/lark-task-store.mjs')
const { handleStatusUpdate, resolveReceiptOutcome, retryPendingReceipts } = await import('../lib/lark-status.mjs')

const BUG = { appToken: 'app', tableId: 'tbl', chatId: 'oc_bug' }
const config = { project: 'PR-01947', title: '主项目', allowedChatIds: ['oc_allowed'], bugTable: BUG }
// PR-02000 绑了项目群：改投（deliverTo）只对它生效；其余项目查不到群，chatId 不变。
writeFileSync(join(runtime, 'lark-project-chats.json'), JSON.stringify({ version: 1, projects: { 'PR-02000': { chatId: 'oc_proj' } }, knownChats: {} }))
const onDisk = (tasksDir, id) => JSON.parse(readFileSync(join(tasksDir, `${id}.json`), 'utf8'))
const attachmentsRoot = join(runtime, 'lark-attachments')
const cliCalls = () => (existsSync(cliLog) ? readFileSync(cliLog, 'utf8').split('\n').filter(Boolean) : [])
const resetCli = () => { if (existsSync(cliLog)) unlinkSync(cliLog) }
const heartbeatFile = join(runtime, 'lark-worker-state.json')
const writeHeartbeat = (extra) => writeFileSync(heartbeatFile, JSON.stringify({ pid: 4242, codeHash: 'h1', heartbeatAt: new Date().toISOString(), readiness: { ok: true }, ...extra }))
const quiet = async (fn) => {
  const spies = ['log', 'warn', 'error'].map((name) => { const original = console[name]; console[name] = () => {}; return () => { console[name] = original } })
  try {
    return await fn()
  } finally {
    for (const restore of spies) restore()
  }
}

// 调一次 handler：body 为 undefined 时空正文；字符串原样发（坏 JSON 用）。
const call = async (handler, { method = 'GET', path, body, secret = SECRET }) => {
  const raw = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  const req = Readable.from(raw)
  Object.assign(req, { method, url: path, headers: secret == null ? {} : { 'x-lark-gateway-secret': secret } })
  const res = { status: null, body: null, writeHead(status) { this.status = status }, end(text) { this.body = JSON.parse(text) } }
  await handler(req, res)
  return res
}

describe('Gateway HTTP 路由 createRequestHandler', () => {
  let store
  let handler
  let consumerObs
  let versionObs
  let tasksDir
  // seed：直接落盘再建 store（upsert 会把 updatedAt 盖成现在，prune 要旧时间戳）。
  const fresh = ({ seed = [] } = {}) => {
    tasksDir = mkdtempSync(join(dir, 'tasks-'))
    for (const task of seed) writeFileSync(join(tasksDir, `${task.id}.json`), JSON.stringify(task))
    store = createTaskStore({ tasksDir, leaseMs: 60_000 })
    consumerObs = { alive: true, lastEventAt: null }
    versionObs = null
    handler = createRequestHandler({ config, store, consumer: { observe: () => consumerObs }, port: 9, runtimeVersion: { observe: () => versionObs } })
  }
  const get = (path, opts = {}) => call(handler, { method: 'GET', path, ...opts })
  const post = (path, body, opts = {}) => call(handler, { method: 'POST', path, body, ...opts })
  after(() => rmSync(dir, { recursive: true, force: true }))

  it('鉴权 / health / 任务读写各路由 / 入队 / 回写 / 异常', () => runSteps([
    ['鉴权：POST 一律要密钥；GET 列表与按 id 取要密钥；health 匿名；未知路径 404', async () => {
      fresh()
      store.upsert({ id: 'a b', status: 'queued', createdAt: '2026-11-01T00:00:00Z' })
      const denied = await post('/lark/tasks/next', {}, { secret: null })
      assert.deepEqual([denied.status, denied.body], [401, { ok: false, error: 'unauthorized' }])
      for (const secret of [null, 'wrong']) {
        assert.equal((await post('/lark/tasks/next', {}, { secret })).status, 401)
        assert.equal((await get('/lark/tasks', { secret })).status, 401)
        assert.equal((await get('/lark/tasks/a%20b', { secret })).status, 401)
      }
      assert.equal(store.get('a b').status, 'queued', '没鉴权的 next 不领任务')
      const list = await get('/lark/tasks')
      assert.equal(list.status, 200)
      assert.deepEqual(list.body.tasks.map((task) => task.id), ['a b'])
      const one = await get('/lark/tasks/a%20b')
      assert.equal(one.status, 200)
      assert.equal(one.body.task.id, 'a b', 'id 做 decodeURIComponent')
      assert.deepEqual((await get('/lark/tasks/nope')).body, { ok: false, error: 'task not found' })
      assert.equal((await get('/lark/tasks/nope')).status, 404)
      const health = await get('/lark/health', { secret: null })
      assert.equal(health.status, 200, 'health 不要密钥')
      assert.equal((await get('/lark/health', { secret: 'wrong' })).status, 200)
      assert.deepEqual(await get('/lark/elsewhere').then((r) => [r.status, r.body]), [404, { ok: false, error: 'not found' }])
      assert.equal((await post('/lark/health', {})).status, 404, 'POST health 不是路由')
      assert.equal((await get('/lark/tasks/next')).status, 404, 'GET next 走按 id 取，没这条任务')
      assert.equal((await post('/lark/tasks/a%20b', {})).status, 404, 'POST 按 id 取不是路由')
      assert.equal((await get('/lark/tasks/a%20b/claim')).status, 404, 'GET claim 不是路由')
    }],
    ['health：ok 只看长连接；事件静默只进 warnings（默认 30min、可配、边界不含）', async () => {
      fresh()
      if (existsSync(heartbeatFile)) unlinkSync(heartbeatFile)
      const alive = await get('/lark/health')
      assert.equal(alive.status, 200)
      assert.deepEqual(alive.body, {
        ok: true, consumer: true, consumerDetail: { alive: true, lastEventAt: null }, eventStale: false, version: null, worker: null,
        pendingReceipts: { total: 0, gaveUp: 0 },
        warnings: ['未见 worker 版本心跳（worker 未启动，或仍是不写心跳的旧版本）'],
        counts: {}, stuck: [], oldestQueuedAgeMs: 0, minLeaseRemainingMs: null, deadLetters: 0, topRequeued: [],
      })
      consumerObs = { alive: false, lastEventAt: null, restarts: 3 }
      const dead = await get('/lark/health')
      assert.deepEqual([dead.status, dead.body.ok, dead.body.consumer, dead.body.consumerDetail], [503, false, false, consumerObs])
      consumerObs = { alive: true, lastEventAt: Date.now() - 31 * 60_000 }
      const stale = await get('/lark/health')
      assert.equal(stale.status, 200, '静默不影响 ok')
      assert.equal(stale.body.eventStale, true)
      assert.equal(stale.body.warnings[0], '已 31min 无事件（夜间空闲属正常，持续整个工作日则需排查长连接）')
      consumerObs = { alive: true, lastEventAt: Date.now() - 29 * 60_000 }
      assert.equal((await get('/lark/health')).body.eventStale, false, '默认阈值 30min')
      process.env.LARK_EVENT_STALE_MS = '60000'
      try {
        consumerObs = { alive: true, lastEventAt: Date.now() - 2 * 60_000 }
        assert.equal((await get('/lark/health')).body.eventStale, true, 'LARK_EVENT_STALE_MS 可调')
        mock.timers.enable({ apis: ['Date'], now: 10_000_000 })
        try {
          consumerObs = { alive: true, lastEventAt: 10_000_000 - 60_000 }
          assert.equal((await get('/lark/health')).body.eventStale, false, '恰好等于阈值不算静默')
          consumerObs = { alive: true, lastEventAt: 10_000_000 - 60_001 }
          assert.equal((await get('/lark/health')).body.eventStale, true)
        } finally {
          mock.timers.reset()
        }
      } finally {
        delete process.env.LARK_EVENT_STALE_MS
      }
    }],
    ['health：failed / 分类失败 / 回写挂起（分重试与放弃）/ 回执未达（分重试与放弃）/ 死信 逐条点名', async () => {
      fresh()
      writeHeartbeat()
      const t = (id, extra) => store.upsert({ id, createdAt: '2026-11-01T00:00:00Z', ...extra })
      t('f1', { status: 'failed', deadLetterReason: '毒任务' })
      t('f2', { status: 'failed' })
      t('i1', { status: 'intake_failed' })
      t('w1', { status: 'done_pending_writeback', writebackGaveUp: true })
      t('w2', { status: 'done_pending_writeback' })
      t('d1', { status: 'done', writebackGaveUp: true, pendingReceipt: { gaveUp: true } })
      t('r1', { status: 'result_pending_receipt', writebackGaveUp: true, pendingReceipt: { gaveUp: false } })
      const body = (await get('/lark/health')).body
      assert.deepEqual(body.warnings, [
        '2 个 failed 任务待人工处置（lark-bot failed 查看）',
        '1 条 @负责人消息意图分类失败（未触发代码执行）',
        '2 个任务已完成但 bug 表状态回写挂起，其中 1 个已停止重试、需人工改表格',
        '2 个任务回执尚未送达，其中 1 个已停止重试、需人工检查 Lark 发送能力',
        '1 个死信任务',
      ])
      assert.deepEqual(body.pendingReceipts, { total: 2, gaveUp: 1 })
      assert.deepEqual(body.counts, { failed: 2, intake_failed: 1, done_pending_writeback: 2, done: 1, result_pending_receipt: 1 })
      assert.equal(body.worker.pid, 4242)
      fresh()
      t('w3', { status: 'done_pending_writeback' })
      t('r2', { status: 'done', pendingReceipt: { gaveUp: false } })
      const retrying = (await get('/lark/health')).body
      assert.deepEqual(retrying.warnings, ['1 个任务已完成但 bug 表状态回写挂起，正在重试', '1 个任务回执尚未送达，正在重试'])
      assert.deepEqual(retrying.pendingReceipts, { total: 1, gaveUp: 0 })
    }],
    ['health：运行版本漂移 + worker 心跳（缺失 / 停了 / 旧代码·排空与否 / 未就绪）', async () => {
      fresh()
      versionObs = { codeHash: 'old', diskCodeHash: 'h2', codeStale: true, configStale: false }
      writeHeartbeat({ codeHash: 'h1' })
      const drift = (await get('/lark/health')).body
      assert.deepEqual(drift.version, { codeHash: 'old', diskCodeHash: 'h2', codeStale: true, configStale: false })
      assert.equal(drift.worker.codeStale, true)
      assert.deepEqual(drift.warnings, [
        '运行中的代码已落后磁盘（进程加载版 old，磁盘 h2）：本次会话对 lark-bot 的所有修改都尚未生效，需 `lark-bot restart`',
        'worker 跑的是旧代码（h1，磁盘 h2）：需 `lark-bot restart`',
      ])
      writeHeartbeat({ codeHash: 'h1', draining: true })
      assert.deepEqual((await get('/lark/health')).body.warnings, [
        '运行中的代码已落后磁盘（进程加载版 old，磁盘 h2）：本次会话对 lark-bot 的所有修改都尚未生效，worker 已在排空，在飞任务跑完、自检绿会自动 restart',
        'worker 跑的是旧代码（h1，磁盘 h2）：已在排空，在飞任务跑完、自检绿会自动 restart',
      ])
      writeHeartbeat({ codeHash: 'h2', heartbeatAt: new Date(Date.now() - 10 * 60_000).toISOString(), readiness: null })
      versionObs = { codeHash: 'h2', diskCodeHash: 'h2', codeStale: false, configStale: false }
      assert.deepEqual((await get('/lark/health')).body.warnings, [
        'worker 心跳已停 10min（pid 4242 可能已死）',
        'worker 尚未完成 AI executor/model 就绪检查，不能确认新任务可执行',
      ])
      writeHeartbeat({ codeHash: 'h2' })
      assert.deepEqual((await get('/lark/health')).body.warnings, [], '心跳新鲜、代码一致、已就绪 → 无告警')
    }],
    ['续租 heartbeat：200 / epoch 不符与非 running 409 / 不存在 404 / 坏正文 400', async () => {
      fresh()
      store.upsert({ id: 'h 1', status: 'running', epoch: 1, claimedAt: '2000-01-01T00:00:00Z' })
      store.upsert({ id: 'q', status: 'queued' })
      const ok = await post('/lark/tasks/h%201/heartbeat', { epoch: 1 })
      assert.equal(ok.status, 200)
      assert.equal(ok.body.ok, true)
      assert.equal(store.get('h 1').claimedAt, ok.body.claimedAt)
      const staleBeat = await post('/lark/tasks/h%201/heartbeat', { epoch: 0 })
      assert.deepEqual([staleBeat.status, staleBeat.body], [409, { ok: false, code: 409, error: 'stale epoch: got 0, current 1' }])
      assert.equal((await post('/lark/tasks/q/heartbeat', {})).status, 409)
      const missing = await post('/lark/tasks/none/heartbeat', {})
      assert.deepEqual([missing.status, missing.body], [404, { ok: false, code: 404, error: 'task not found' }])
      const bad = await post('/lark/tasks/h%201/heartbeat', '{oops')
      assert.deepEqual([bad.status, bad.body], [400, { ok: false, error: 'invalid or oversized JSON body' }])
      assert.equal((await post('/lark/tasks/h%201/heartbeat', '[1]')).status, 200, '数组也是 object，按空参数续租')
    }],
    ['结单 close：缺省 operator=cli、原因 completed_elsewhere；显式参数透传；不可结单 409；坏正文 400', async () => {
      fresh()
      store.upsert({ id: 'c 1', status: 'queued' })
      store.upsert({ id: 'c2', status: 'running', epoch: 2 })
      store.upsert({ id: 'c3', status: 'done' })
      const dflt = await post('/lark/tasks/c%201/close', {})
      assert.equal(dflt.status, 200)
      assert.deepEqual([dflt.body.ok, dflt.body.previousStatus, dflt.body.closureReason], [true, 'queued', 'completed_elsewhere'])
      assert.equal(dflt.body.task.externalResolution.operator, 'cli')
      assert.equal(dflt.body.task.result, '人工确认该问题已由其他人员或 AI 完成，原任务直接结单。')
      const explicit = await post('/lark/tasks/c2/close', { operator: 'ou_x', closureReason: 'cancelled', note: '不做了' })
      assert.deepEqual([explicit.body.closureReason, explicit.body.task.externalResolution.operator, explicit.body.task.result, explicit.body.task.epoch], ['cancelled', 'ou_x', '不做了', 3])
      const done = await post('/lark/tasks/c3/close', {})
      assert.deepEqual([done.status, done.body], [409, { ok: false, error: 'task not found or not closable' }])
      assert.equal((await post('/lark/tasks/c3/close', 'x')).status, 400)
    }],
    ['续跑 resume：补料复用原任务回队；operator 缺省 cli；按项目号改投并落盘；无补料 / 非挂起 409；坏正文 400', async () => {
      fresh()
      const scopeRequest = { paths: ['apps/web/src/a.ts'], overBudget: false, siblingsRequired: false }
      store.upsert({ id: 'r1', source: 'lark-bugtable', project: 'PR-02000', chatId: 'ou_op', status: 'waiting_confirmation', epoch: 1, text: '原文', scopeRequest })
      store.upsert({ id: 'r2', source: 'lark', project: 'PR-01947', chatId: 'oc_g', status: 'blocked', epoch: 0, text: '原文', scopeRequest })
      const resumed = await quiet(() => post('/lark/tasks/r1/resume', { supplementText: '确认扩大范围' }))
      assert.equal(resumed.status, 200)
      assert.deepEqual([resumed.body.ok, resumed.body.task.status, resumed.body.task.epoch, resumed.body.task.chatId], [true, 'queued', 2, 'oc_proj'])
      assert.equal(resumed.body.task.scopeApprovals[0].approvedBy, 'cli')
      assert.equal(onDisk(tasksDir, 'r1').chatId, 'oc_proj', '改投后的 chatId 落盘')
      const byOp = await quiet(() => post('/lark/tasks/r2/resume', { supplementText: '确认扩大范围', operator: 'ou_me' }))
      assert.deepEqual([byOp.body.task.scopeApprovals[0].approvedBy, byOp.body.task.chatId], ['ou_me', 'oc_g'], '项目没绑群 → chatId 不变')
      store.upsert({ id: 'r3', status: 'waiting_confirmation', text: 'x' })
      const empty = await post('/lark/tasks/r3/resume', {})
      assert.deepEqual([empty.status, empty.body], [409, { ok: false, error: 'task not found, not parked, or no supplement given' }])
      assert.equal(store.get('r3').status, 'waiting_confirmation')
      assert.equal((await post('/lark/tasks/r1/resume', { supplementText: '再来' })).status, 409, '已回队的不是挂起态')
      assert.equal((await post('/lark/tasks/r3/resume', 'nope')).status, 400)
    }],
    ['next 领最早的 pending；intake 透传给分类落地（不在等分类 → 409）；坏正文 400', async () => {
      fresh()
      assert.deepEqual((await post('/lark/tasks/next', {})).body, { task: null })
      store.upsert({ id: 'n1', status: 'queued', createdAt: '2026-11-01T00:00:00Z' })
      const next = await post('/lark/tasks/next', {})
      assert.deepEqual([next.status, next.body.task.id, next.body.task.status], [200, 'n1', 'running'])
      const intake = await post('/lark/tasks/n1/intake', { classification: { intent: 'bug' } })
      assert.deepEqual([intake.status, intake.body], [409, { ok: false, code: 409, error: 'task is not awaiting intake classification' }])
      assert.equal((await post('/lark/tasks/n1/intake', '{')).status, 400)
    }],
    ['QA 验退 reopen：非 bug 表 404；活动态幂等（不读正文）；不可重开 409；坏正文 400', async () => {
      fresh()
      store.upsert({ id: 'lark1', source: 'lark', status: 'done' })
      store.upsert({ id: 'sup', source: 'lark-bugtable', status: 'superseded' })
      store.upsert({ id: 'dn', source: 'lark-bugtable', status: 'done' })
      for (const id of ['nope', 'lark1']) {
        const res = await post(`/lark/tasks/${id}/reopen`, {})
        assert.deepEqual([res.status, res.body], [404, { ok: false, error: 'bug table task not found' }])
      }
      await eachCase(['queued', 'received', 'running', 'verifying', 'waiting_confirmation'].map((status) => ({ name: status, status })), async ({ status }) => {
        store.upsert({ id: `act-${status}`, source: 'lark-bugtable', status })
        const res = await post(`/lark/tasks/act-${status}/reopen`, '{broken')
        if (status === 'waiting_confirmation') return assert.equal(res.status, 400, '挂起态不在幂等集合里，读正文')
        assert.deepEqual([res.status, res.body.ok, res.body.reopened, res.body.task.status], [200, true, false, status])
      })
      const notReopenable = await post('/lark/tasks/sup/reopen', { text: 'x' })
      assert.deepEqual([notReopenable.status, notReopenable.body], [409, { ok: false, error: 'task status superseded is not reopenable' }])
      assert.equal((await post('/lark/tasks/dn/reopen', '{')).status, 400)
    }],
    ['QA 验退 reopen：缺省沿用原任务字段、新截图替换旧 bug 表截图；显式参数覆盖；按项目号改投', async () => {
      fresh()
      resetCli()
      store.upsert({ id: 'rec1', source: 'lark-bugtable', status: 'done', project: 'PR-01947', chatId: 'oc_old', operator: 'ou_op', epoch: 1, result: '上一轮', attachments: [{ source: 'bugtable', imageKey: 'old' }, { source: 'lark', imageKey: 'keep' }] })
      const res = await quiet(() => post('/lark/tasks/rec1/reopen', { text: '新正文\n第二行', screenshots: [{ fileToken: 'ft1', name: 's.png' }] }))
      assert.deepEqual([res.status, res.body.ok, res.body.reopened], [200, true, true])
      const task = res.body.task
      assert.deepEqual(
        [task.status, task.epoch, task.summary, task.recordId, task.chatId, task.commandType, task.operator, task.aiExecutor, task.qaReturnCount],
        ['queued', 2, '新正文', 'rec1', 'oc_old', 'fix', 'ou_op', 'claude', 1],
      )
      assert.ok(task.text.startsWith('新正文\n第二行\n\n【验退轮次】'))
      assert.deepEqual(task.attachments, [
        { source: 'lark', imageKey: 'keep' },
        { type: 'image', imageKey: 'ft1', name: 's.png', source: 'bugtable', localPath: join(attachmentsRoot, 'PR-01947', 'rec1', '1-ft1.img') },
      ])
      assert.deepEqual(onDisk(tasksDir, 'rec1').attachments, task.attachments, '换截图后落盘')
      assert.match(cliCalls()[0], /\+record-download-attachment --base-token app --table-id tbl --record-id rec1 --file-token ft1/)
      store.upsert({ id: 'rec2', source: 'lark-bugtable', status: 'failed', project: 'PR-01947', chatId: 'oc_old', operator: 'ou_op', attachments: [{ source: 'bugtable', imageKey: 'old' }] })
      resetCli()
      const over = await quiet(() => post('/lark/tasks/rec2/reopen', { text: 't', project: 'PR-02000', recordId: 'recX', chatId: 'ou_new', commandType: 'status', operator: 'ou_qa', aiExecutor: 'Codex', screenshots: [{ fileToken: 'ft2' }] }))
      const t2 = over.body.task
      assert.deepEqual([t2.project, t2.recordId, t2.chatId, t2.commandType, t2.operator, t2.aiExecutor], ['PR-02000', 'recX', 'oc_proj', 'status', 'ou_qa', 'codex'])
      assert.equal(t2.attachments.at(-1).localPath, join(attachmentsRoot, 'PR-02000', 'recX', '1-ft2.img'), '截图按显式项目号 / recordId 落盘')
      assert.match(cliCalls()[0], /--record-id recX /)
      store.upsert({ id: 'rec3', source: 'lark-bugtable', status: 'no_change_needed', attachments: [{ source: 'bugtable', imageKey: 'old' }] })
      const noShots = await quiet(() => post('/lark/tasks/rec3/reopen', { text: 't', chatId: 'oc_new' }))
      assert.deepEqual(noShots.body.task.attachments, [{ source: 'bugtable', imageKey: 'old' }], '没新截图不动旧截图')
      assert.equal(noShots.body.task.chatId, 'oc_new', '显式 chatId 覆盖（项目号没绑群，不改投）')
      store.upsert({ id: 'rec4', source: 'lark-bugtable', status: 'done', project: 'PR-01947', attachments: [] })
      const keep = await quiet(() => post('/lark/tasks/rec4/reopen', { text: '再看看' }))
      assert.equal(keep.body.task.project, 'PR-01947', '正文没带项目号沿用原任务的（11-02：原来清成 null）')
      store.upsert({ id: 'rec5', source: 'lark-bugtable', status: 'done', project: null, attachments: [] })
      assert.equal((await quiet(() => post('/lark/tasks/rec5/reopen', { text: '再看看' }))).body.task.project, null)
    }],
    ['retry：不存在 / 不可重试 404 带缺省原因；达上限 404 带上限原因；成功回队并重下失败附件（无 messageId 不重下）', async () => {
      fresh()
      store.upsert({ id: 'dn', status: 'done' })
      store.upsert({ id: 'cap', status: 'failed', retryCount: 5 })
      for (const id of ['none', 'dn']) {
        const res = await post(`/lark/tasks/${id}/retry`, {})
        assert.deepEqual([res.status, res.body], [404, { ok: false, error: 'task not found or not retryable (must be failed/blocked)' }])
      }
      const cap = await post('/lark/tasks/cap/retry', {})
      assert.equal(cap.status, 404)
      assert.match(cap.body.error, /^已达人工重试上限（5 次）/)
      resetCli()
      store.upsert({ id: 'f1', status: 'failed', messageId: 'om_1', attachments: [{ type: 'image', imageKey: 'k1', downloadError: 'x' }, { type: 'image', imageKey: 'k2', localPath: '/p' }] })
      const ok = await quiet(() => post('/lark/tasks/f1/retry', {}))
      assert.deepEqual([ok.status, ok.body.task.status, ok.body.task.retryCount], [200, 'queued', 1])
      assert.equal(ok.body.task.attachments[0].localPath, join(attachmentsRoot, 'PR-01947', 'om_1', '1-k1.img'), '无项目号按 config.project 落盘')
      assert.deepEqual(ok.body.task.attachments[1], { type: 'image', imageKey: 'k2', localPath: '/p' })
      assert.equal(onDisk(tasksDir, 'f1').attachments[0].localPath, ok.body.task.attachments[0].localPath)
      assert.equal(cliCalls().length, 1)
      store.upsert({ id: 'f2', status: 'blocked', project: 'PR-02000', chatId: 'ou_op', source: 'lark-bugtable', messageId: 'om_2', attachments: [{ type: 'image', imageKey: 'k3', downloadError: 'x' }] })
      const proj = await quiet(() => post('/lark/tasks/f2/retry', {}))
      assert.equal(proj.body.task.attachments[0].localPath, join(attachmentsRoot, 'PR-02000', 'om_2', '1-k3.img'))
      assert.equal(proj.body.task.chatId, 'oc_proj')
      resetCli()
      store.upsert({ id: 'f3', status: 'failed', attachments: [{ type: 'image', imageKey: 'k4', downloadError: 'x' }] })
      const noMsg = await quiet(() => post('/lark/tasks/f3/retry', {}))
      assert.deepEqual([noMsg.status, noMsg.body.task.attachments, cliCalls()], [200, [{ type: 'image', imageKey: 'k4', downloadError: 'x' }], []])
    }],
    ['prune：缺省只清 done、不看年龄；olderThanHours 按小时；statuses 非空数组才生效；坏正文 400', async () => {
      const old = new Date(Date.now() - 3 * 3_600_000).toISOString()
      const seed = () => [
        { id: 'd_old', status: 'done', updatedAt: old },
        { id: 'd_new', status: 'done', updatedAt: new Date(Date.now() - 1000).toISOString() },
        { id: 'f_old', status: 'failed', updatedAt: old },
      ]
      await eachCase([
        { name: '缺省', body: {}, removed: ['d_new', 'd_old'] },
        { name: '2 小时以前', body: { olderThanHours: 2 }, removed: ['d_old'] },
        { name: '负数按 0', body: { olderThanHours: -5 }, removed: ['d_new', 'd_old'] },
        { name: '显式 failed', body: { statuses: ['failed'] }, removed: ['f_old'] },
        { name: '空数组按缺省', body: { statuses: [] }, removed: ['d_new', 'd_old'] },
        { name: '字符串不算', body: { statuses: 'failed' }, removed: ['d_new', 'd_old'] },
      ], async ({ body, removed }) => {
        fresh({ seed: seed() })
        const res = await post('/lark/tasks/prune', body)
        assert.deepEqual([res.status, res.body.ok, res.body.removed.sort()], [200, true, removed])
      })
      assert.equal((await post('/lark/tasks/prune', 'x')).status, 400)
    }],
    ['claim 按 id 领；release 交还在跑任务，非 running 404', async () => {
      fresh()
      store.upsert({ id: 'c 1', status: 'queued' })
      const claimed = await post('/lark/tasks/c%201/claim', {})
      assert.deepEqual([claimed.status, claimed.body.task.status], [200, 'running'])
      assert.deepEqual((await post('/lark/tasks/c%201/claim', {})).body, { task: null })
      const released = await post('/lark/tasks/c%201/release', {})
      assert.deepEqual([released.status, released.body.ok, released.body.task.status, released.body.task.epoch], [200, true, 'queued', 1])
      const again = await post('/lark/tasks/c%201/release', {})
      assert.deepEqual([again.status, again.body], [404, { ok: false, error: 'task not found or not running' }])
    }],
    ['work/wait 长轮询：鉴权；没带 since 立即对时；挂起后任务写成可领取才唤醒（running 不算）；超时 woke=false；since 比当前大（gateway 重启过）立即返回；没装信号 404', async () => {
      fresh()
      assert.equal((await get('/lark/work/wait?since=0')).status, 404, '没装 workSignal（旧 gateway）= 没这个路由，worker 据此退回纯轮询')
      const { createWorkSignal } = await import('../lib/lark-work-signal.mjs')
      const signal = createWorkSignal()
      const s = createTaskStore({ tasksDir: mkdtempSync(join(dir, 'tasks-')), leaseMs: 60_000, onClaimable: () => signal.bump() })
      const h = createRequestHandler({ config, store: s, consumer: { observe: () => ({ alive: true }) }, port: 9, runtimeVersion: { observe: () => null }, workSignal: signal })
      const wait = (query, opts = {}) => call(h, { path: `/lark/work/wait${query}`, ...opts })
      assert.equal((await wait('?since=0&timeoutMs=10', { secret: null })).status, 401)
      assert.deepEqual((await wait('')).body, { seq: 0, woke: true }, '没带 since：立即返回当前序号')
      const pending = wait('?since=0&timeoutMs=5000')
      s.upsert({ id: 'w1', status: 'running' })
      assert.equal(signal.waiting(), 1, 'running 不算有活，不唤醒')
      s.upsert({ id: 'w1', status: 'queued' })
      assert.deepEqual((await pending).body, { seq: 1, woke: true })
      s.upsert({ id: 'w2', status: 'received' })
      assert.equal(signal.seq(), 2, '待分类也算有活')
      assert.deepEqual((await wait('?since=2&timeoutMs=10')).body, { seq: 2, woke: false }, '超时')
      assert.deepEqual((await wait('?since=9&timeoutMs=5000')).body, { seq: 2, woke: true }, 'since 比当前大 = gateway 重启过，立即对时')
      assert.equal(signal.waiting(), 0)
      // 长轮询期间 worker 断开（本地先醒、abort 了请求）：摘掉等待者，等到了也不往已断的连接写。
      const closers = []
      const gone = { writes: 0, destroyed: false, writableEnded: false, on(event, fn) { if (event === 'close') closers.push(fn) }, writeHead() { this.writes += 1 }, end() { this.writes += 1 } }
      const req = Object.assign(Readable.from([]), { method: 'GET', url: '/lark/work/wait?since=2&timeoutMs=5000', headers: { 'x-lark-gateway-secret': SECRET } })
      const handling = h(req, gone)
      assert.deepEqual([signal.waiting(), closers.length], [1, 1])
      gone.destroyed = true
      closers[0]()
      await handling
      assert.deepEqual([signal.waiting(), gone.writes], [0, 0])
    }],
    ['入队 POST /lark/tasks：id 取 id > recordId > messageId；已存在原样返回；缺省字段；坏正文 / 缺 id 400', async () => {
      fresh()
      assert.equal((await post('/lark/tasks', '{')).status, 400)
      const noId = await post('/lark/tasks', { text: 'x' })
      assert.deepEqual([noId.status, noId.body], [400, { ok: false, error: 'missing id' }])
      resetCli()
      const dflt = await quiet(() => post('/lark/tasks', { id: 'i1', recordId: 'r1', messageId: 'm1', text: '\n修复：按钮错位\n第二行', source: 'lark' }))
      const task = dflt.body.task
      assert.equal(dflt.status, 200)
      assert.deepEqual(
        { id: task.id, source: task.source, chatId: task.chatId, recordId: task.recordId, project: task.project, commandType: task.commandType, commandTypeSource: task.commandTypeSource, operator: task.operator, projectTitle: task.projectTitle, summary: task.summary, attachments: task.attachments, aiExecutor: task.aiExecutor, status: task.status },
        { id: 'i1', source: 'lark', chatId: 'oc_bug', recordId: 'r1', project: null, commandType: 'fix', commandTypeSource: 'explicit', operator: null, projectTitle: undefined, summary: '修复：按钮错位', attachments: [], aiExecutor: 'claude', status: 'queued' },
      )
      assert.ok(task.createdAt)
      assert.deepEqual(cliCalls(), [], '非 bug 表来源不下截图')
      const same = await post('/lark/tasks', { id: 'i1', text: '别的' })
      assert.deepEqual([same.status, same.body.task.text], [200, '\n修复：按钮错位\n第二行'], '已存在 → 原样返回不覆盖')
      assert.equal((await quiet(() => post('/lark/tasks', { recordId: 'r2', messageId: 'm2' }))).body.task.id, 'r2')
      assert.equal((await quiet(() => post('/lark/tasks', { messageId: 'm3' }))).body.task.id, 'm3')
      const empty = (await quiet(() => post('/lark/tasks', { id: 'e1' }))).body.task
      assert.deepEqual([empty.text, empty.summary, empty.source, empty.commandType, empty.commandTypeSource], ['', '群内任务', 'lark-bugtable', null, null])
      const explicit = (await quiet(() => post('/lark/tasks', { id: 'x1', commandType: 'status', text: '修复：x', chatId: 'oc_given', operator: 'ou_op', project: 'PR-01947', attachments: [{ type: 'image', imageKey: 'a' }] }))).body.task
      assert.deepEqual(
        [explicit.commandType, explicit.commandTypeSource, explicit.chatId, explicit.operator, explicit.project, explicit.projectTitle, explicit.attachments],
        ['status', 'explicit', 'oc_given', 'ou_op', 'PR-01947', '主项目', [{ type: 'image', imageKey: 'a' }]],
      )
      const fallback = createRequestHandler({ config: { allowedChatIds: ['oc_first'] }, store, consumer: { observe: () => consumerObs }, port: 9 })
      assert.equal((await quiet(() => call(fallback, { method: 'POST', path: '/lark/tasks', body: { id: 'nb1' } }))).body.task.chatId, 'oc_first', '没配 bug 表群 → 白名单第一个群')
    }],
    ['入队：bug 表（或未写来源）先下截图再入队，按项目号 / recordId 落盘；其它来源不下；按项目号改投', async () => {
      fresh()
      await eachCase([
        { name: '显式 bug 表来源', body: { id: 'b1', source: 'lark-bugtable', recordId: 'rec1', project: 'PR-01947' }, dirs: ['PR-01947', 'rec1'] },
        { name: '未写来源当 bug 表', body: { id: 'b2' }, dirs: ['_adhoc', 'b2'] },
        { name: '其它来源不下', body: { id: 'b3', source: 'lark' }, dirs: null },
      ], async ({ body, dirs }) => {
        resetCli()
        const task = (await quiet(() => post('/lark/tasks', { ...body, attachments: [{ type: 'image', imageKey: 'x' }], screenshots: [{ fileToken: 's1', name: 'a.png' }, { fileToken: 'bad1' }] }))).body.task
        if (!dirs) {
          assert.deepEqual([task.attachments, cliCalls()], [[{ type: 'image', imageKey: 'x' }], []])
          return
        }
        assert.deepEqual(task.attachments.map((a) => [a.imageKey, a.localPath || a.downloadError]), [
          ['x', undefined],
          ['s1', join(attachmentsRoot, ...dirs, '1-s1.img')],
          ['bad1', 'download failed'],
        ])
        assert.match(cliCalls()[0], new RegExp(`--record-id ${dirs[1]} --file-token s1`))
      })
      const moved = (await quiet(() => post('/lark/tasks', { id: 'mv', chatId: 'ou_op', project: 'PR-02000' }))).body.task
      assert.equal(moved.chatId, 'oc_proj')
      assert.equal(onDisk(tasksDir, 'mv').chatId, 'oc_proj')
    }],
    ['status 回写透传，ok 200 / 带 code 用 code / 不带 code 404；坏正文 400', async () => {
      fresh()
      store.upsert({ id: 's 1', status: 'running', epoch: 2, source: 'lark' })
      const ok = await post('/lark/tasks/s%201/status', { status: 'verifying', epoch: 2, result: '验证中', aiExecutor: 'codex', owner: 'w1', branch: 'hotfix/x', noChangeReason: 'env_version', scopeRequest: { paths: ['a.ts'] }, outcome: { summary: '还在验' } })
      assert.deepEqual([ok.status, ok.body], [200, { ok: true }])
      const task = store.get('s 1')
      assert.deepEqual([task.status, task.result, task.aiExecutor, task.owner, task.branch, task.noChangeReason, task.scopeRequest], ['verifying', '验证中', 'codex', 'w1', 'hotfix/x', 'env_version', null])
      assert.equal(task.outcome.summary, '还在验')
      const stale = await post('/lark/tasks/s%201/status', { status: 'verifying', epoch: 1 })
      assert.deepEqual([stale.status, stale.body], [409, { ok: false, code: 409, error: 'stale epoch: got 1, current 2' }])
      const invalid = await post('/lark/tasks/s%201/status', { status: 'bogus' })
      assert.deepEqual([invalid.status, invalid.body], [404, { ok: false, error: 'invalid status: bogus' }])
      assert.equal((await post('/lark/tasks/s%201/status', 'x')).status, 400)
    }],
    ['回执重试 receipt/retry：有挂起回执 200 并重置计数；没有 409；处理中抛错 500', async () => {
      fresh()
      store.upsert({ id: 'p 1', status: 'result_pending_receipt', pendingReceipt: { attempts: 12, gaveUp: true } })
      store.upsert({ id: 'p2', status: 'done' })
      const ok = await post('/lark/tasks/p%201/receipt/retry', {})
      assert.deepEqual([ok.status, ok.body.ok, ok.body.task.pendingReceipt.attempts, ok.body.task.pendingReceipt.gaveUp], [200, true, 0, false])
      const none = await post('/lark/tasks/p2/receipt/retry', {})
      assert.deepEqual([none.status, none.body], [409, { ok: false, error: 'task has no pending receipt' }])
      const boom = await post('/lark/tasks', { id: 'z', aiExecutor: 'bogus' })
      assert.deepEqual([boom.status, boom.body], [500, { ok: false, error: 'invalid aiExecutor: bogus' }])
      assert.equal(store.has('z'), false)
    }],
    ['status 回写 × bug 表：领取置修复中 / done 回写完成值 / 无需改动·环境版本置不是问题 / 挂起置等待；非 bug 表来源与其它状态不写', async () => {
      const btConfig = { bugTable: { appToken: 'app', tableId: 'tbl', statusField: 'st', inProgressValue: 'IP', doneValue: 'DONE', notIssueValue: 'NOTISSUE', waitingValue: 'WAIT' } }
      const patches = () => cliCalls().filter((line) => line.includes('+record-batch-update')).map((line) => line.match(/"st":"([^"]+)"/)[1])
      const deliver = async () => ({ ok: true, messageId: null })
      await eachCase([
        { name: 'bug 表 running → 修复中', source: 'lark-bugtable', status: 'running', want: ['IP'] },
        { name: 'bug 表 verifying 不写', source: 'lark-bugtable', status: 'verifying', want: [] },
        { name: '群消息 running 不写', source: 'lark', status: 'running', want: [] },
        { name: 'bug 表 done → 完成值', source: 'lark-bugtable', status: 'done', want: ['DONE'], landed: 'done' },
        { name: '群消息 done 不回写', source: 'lark', status: 'done', want: [], landed: 'done' },
        { name: 'bug 表 无需改动·环境版本 → 不是问题', source: 'lark-bugtable', status: 'no_change_needed', noChangeReason: 'env_version', want: ['NOTISSUE'] },
        { name: 'bug 表 无需改动·非前端 不写', source: 'lark-bugtable', status: 'no_change_needed', noChangeReason: 'not_frontend', want: [] },
        { name: '群消息 无需改动·环境版本 不写', source: 'lark', status: 'no_change_needed', noChangeReason: 'env_version', want: [] },
        { name: 'bug 表 failed·环境版本 不写', source: 'lark-bugtable', status: 'failed', noChangeReason: 'env_version', want: [] },
        { name: 'bug 表 待确认 → 等待', source: 'lark-bugtable', status: 'waiting_confirmation', want: ['WAIT'] },
        { name: 'bug 表 阻塞 → 等待', source: 'lark-bugtable', status: 'blocked', want: ['WAIT'] },
        { name: '群消息 阻塞 不写', source: 'lark', status: 'blocked', want: [] },
      ], async ({ source, status, noChangeReason, want, landed }) => {
        fresh()
        resetCli()
        store.upsert({ id: 'wb', source, recordId: 'rec9', status: 'running', epoch: 0, chatId: 'oc_g', commandType: 'fix', commandTypeSource: 'explicit', text: 'x' })
        const out = await quiet(() => handleStatusUpdate({ config: btConfig, store, id: 'wb', status, result: 'r', noChangeReason, deliver, resolveGroupChat: async () => null }))
        assert.equal(out.ok, true)
        assert.deepEqual(patches(), want)
        if (landed) assert.equal(store.get('wb').status, landed)
      })
    }],
    ['status 回写 × 回执：发送中被换代 / 改态的判定、失败挂起字段、已送达清 pending、挂起锚点', async () => {
      const send = (effect, result = { ok: true, messageId: 'om_r' }) => async ({ task }) => { effect?.(task); return result }
      const run = (id, status, deliver, extra = {}) => quiet(() => handleStatusUpdate({ config: {}, store, id, status, epoch: 0, result: '结论', deliver, resolveGroupChat: async () => null, ...extra }))
      await eachCase([
        { name: '发送中冒出别的 pending → 作废', status: 'done', effect: (task) => { task.pendingReceipt = { idempotencyKey: 'other' } }, want: { ok: true, receiptSuperseded: true } },
        { name: 'done 发送中转回写挂起仍算当前', status: 'done', effect: (task) => { task.status = 'done_pending_writeback' }, want: { ok: true }, delivered: true },
        { name: 'failed 发送中转回写挂起 → 作废', status: 'failed', effect: (task) => { task.status = 'done_pending_writeback' }, want: { ok: true, receiptSuperseded: true } },
        { name: 'done 发送中被改成 queued（同代）→ 作废', status: 'done', effect: (task) => { task.status = 'queued' }, want: { ok: true, receiptSuperseded: true } },
      ], async ({ status, effect, want, delivered }) => {
        fresh()
        store.upsert({ id: 'rc', status: 'running', epoch: 0, chatId: 'oc_g' })
        assert.deepEqual(await run('rc', status, send(effect)), want)
        assert.equal(Boolean(store.get('rc').lastDeliveredReceipt), Boolean(delivered))
      })
      fresh()
      store.upsert({ id: 'pf', status: 'running', epoch: 0, chatId: 'oc_g' })
      assert.deepEqual(await run('pf', 'done', send(null, { ok: false, reason: 'net down' })), { ok: true, receiptPending: true })
      assert.deepEqual([store.get('pf').status, store.get('pf').pendingReceipt.result, store.get('pf').pendingReceipt.lastError, store.get('pf').pendingReceipt.idempotencyKey], ['result_pending_receipt', '结论', 'net down', 'pf-e0-done'])
      store.upsert({ id: 'pb', status: 'running', epoch: 0, chatId: 'oc_g' })
      await run('pb', 'blocked', send(null, { ok: false }))
      assert.deepEqual([store.get('pb').status, store.get('pb').pendingReceipt.lastError], ['blocked', 'unknown receipt error'], '挂起态失败不改成 result_pending_receipt')
      store.upsert({ id: 'ad', status: 'running', epoch: 0, chatId: 'oc_g', lastDeliveredReceipt: { idempotencyKey: 'ad-e0-done' }, pendingReceipt: { idempotencyKey: 'ad-e0-done', status: 'done' } })
      assert.deepEqual(await run('ad', 'done', send(() => assert.fail('已送达不再发'))), { ok: true, receiptAlreadyDelivered: true })
      assert.equal(store.get('ad').pendingReceipt, undefined, '同键 pending 一并清掉')
      store.upsert({ id: 'ad2', status: 'running', epoch: 0, chatId: 'oc_g', lastDeliveredReceipt: { idempotencyKey: 'ad2-e0-done' }, pendingReceipt: { idempotencyKey: 'ad2-e0-wait', status: 'waiting_confirmation' } })
      await run('ad2', 'done', send(() => assert.fail('已送达不再发')))
      assert.equal(store.get('ad2').pendingReceipt.idempotencyKey, 'ad2-e0-wait', '别的键的 pending 不动')
      store.upsert({ id: 'pk', status: 'blocked', epoch: 0, chatId: 'oc_g', parkedAt: null })
      await run('pk', 'blocked', send())
      assert.ok(store.get('pk').parkedAt, '老任务挂起态没锚点 → 补上')
      assert.equal(store.get('pk').waitRound, 1)
    }],
    ['retryPendingReceipts：幂等键缺省按 id-e代次-短码 补；已送达直接结算；发送失败但已送达也结算；发送中已送达仍消费重跑标记；上限缺省 12', async () => {
      const calls = []
      const deliver = (effect, result = { ok: true, messageId: 'om_x' }) => async ({ task, status }) => { calls.push([task.id, status]); effect?.(task); return result }
      fresh()
      store.upsert({ id: 'k1', status: 'result_pending_receipt', epoch: 1, pendingReceipt: { status: 'done', epoch: 1, attempts: 0 } })
      await quiet(() => retryPendingReceipts({ config: {}, store, deliver: deliver() }))
      assert.deepEqual([calls, store.get('k1').status, store.get('k1').pendingReceipt], [[['k1', 'done']], 'done', undefined], '没键也照发')
      assert.equal(store.get('k1').lastDeliveredReceipt.idempotencyKey, 'k1-e1-done')
      calls.length = 0
      fresh()
      store.upsert({ id: 'k2', status: 'result_pending_receipt', epoch: 1, lastDeliveredReceipt: { idempotencyKey: 'k2-e1-done' }, pendingReceipt: { status: 'done', epoch: 1 } })
      store.upsert({ id: 'k3', status: 'result_pending_receipt', epoch: 1, lastDeliveredReceipt: { idempotencyKey: 'custom' }, pendingReceipt: { status: 'failed', idempotencyKey: 'custom' } })
      await quiet(() => retryPendingReceipts({ config: {}, store, deliver: deliver() }))
      assert.deepEqual(calls, [], '已送达（缺省键 / 自带键）不再发')
      assert.deepEqual([store.get('k2').status, store.get('k2').pendingReceipt, store.get('k3').status, store.get('k3').pendingReceipt], ['done', undefined, 'failed', undefined])
      fresh()
      store.upsert({ id: 'k4', status: 'result_pending_receipt', epoch: 0, pendingReceipt: { status: 'no_change_needed', epoch: 0, idempotencyKey: 'k4-e0-noop' } })
      await quiet(() => retryPendingReceipts({ config: {}, store, deliver: deliver((task) => { task.lastDeliveredReceipt = { idempotencyKey: 'k4-e0-noop' } }, { ok: false, reason: 'timeout' }) }))
      assert.deepEqual([store.get('k4').status, store.get('k4').pendingReceipt], ['no_change_needed', undefined], '返回失败但标记已送达 → 结算')
      fresh()
      store.upsert({ id: 'k5', status: 'result_pending_receipt', epoch: 0, rerunAfterDone: true, pendingReceipt: { status: 'done', epoch: 0, idempotencyKey: 'k5-e0-done' } })
      await quiet(() => retryPendingReceipts({ config: {}, store, deliver: deliver((task) => { task.lastDeliveredReceipt = { idempotencyKey: 'k5-e0-done' } }) }))
      assert.deepEqual([store.get('k5').status, store.get('k5').rerunCount, store.get('k5').epoch], ['queued', 1, 1], '送达后消费并入的重跑')
      assert.deepEqual(resolveReceiptOutcome({ ok: false, attempts: 11 }), { attempts: 12, gaveUp: true, retry: false })
      assert.deepEqual(resolveReceiptOutcome({ ok: false, attempts: 10 }), { attempts: 11, gaveUp: false, retry: true })
    }],
  ]))
})
