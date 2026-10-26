import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { runSteps } from './support/steps.mjs'

process.env.LARK_GATEWAY_SECRET = 'test-secret'
// 运行态指到临时目录：health 读 worker 心跳文件，不能读 / 写本机真实运行目录（变异补测 10-24）
const runtimeRoot = mkdtempSync(join(tmpdir(), 'lark-routes-runtime-'))
process.env.LARK_RUNTIME_DIR = runtimeRoot
// 默认实例（非 repo-only）：默认仓的卡走 lark-cli，换成假程序——参数记进临时日志、群列表只有一个 [PR-77777] 项目群、
// 发消息回固定 message_id；发件簿不落盘（node --test 下未指定目录即不记），不碰真实 Lark 与运行态（变异补测 10-24）。
// 假程序按内容哈希放在系统临时目录的固定路径、复用不重建：macOS 对新建的可执行文件首次执行要扫描约 370ms。
delete process.env.LARK_INSTANCE_MODE
delete process.env.LARK_OUTBOX_DIR
const cliLog = join(runtimeRoot, 'fake-lark-cli.log')
process.env.LARK_ROUTES_FAKE_CLI_LOG = cliLog
const fakeCliBody = [
  '#!/bin/sh',
  'printf "%s\\n" "$*" >> "$LARK_ROUTES_FAKE_CLI_LOG"',
  'case "$*" in',
  `  *+chat-list*) printf '%s' '{"code":0,"data":{"chats":[{"chat_id":"oc_mut_proj","name":"[PR-77777] 直播项目群"}]}}' ;;`,
  `  *) printf '%s' '{"code":0,"data":{"message_id":"om_mut_sent"}}' ;;`,
  'esac',
  '',
].join('\n')
const fakeCli = join(tmpdir(), `lark-routes-fake-cli-${createHash('sha1').update(fakeCliBody).digest('hex').slice(0, 12)}.sh`)
if (!existsSync(fakeCli)) {
  writeFileSync(`${fakeCli}.${process.pid}`, fakeCliBody, { mode: 0o755 })
  renameSync(`${fakeCli}.${process.pid}`, fakeCli)
}
process.env.LARK_CLI_BIN = fakeCli
const { createRequestHandler } = await import('../lib/lark-routes.mjs')
const { createTaskStore } = await import('../lib/lark-task-store.mjs')
const { workerHeartbeatPath } = await import('../lib/lark-runtime-version.mjs')
const { registerRepoProfiles, resetRepoProfiles } = await import('../lib/lark-repo-profile.mjs')
const { loadLedger, saveLedger } = await import('../lib/lark-ledger.mjs')
const { POLL_WARN_AFTER_FAILURES } = await import('../lib/lark-chat-poller.mjs')
const { resolveChatIdByProject } = await import('../lib/lark-cli.mjs')

const headersWithSecret = { 'x-lark-gateway-secret': 'test-secret', 'Content-Type': 'application/json' }
const cliCalls = () => (existsSync(cliLog) ? readFileSync(cliLog, 'utf8') : '')

// 一次性网关：独立 store（或注入的桩）、段内起段末关，各段互不共享任务（变异补测 10-24）
const withGateway = async ({ config = { project: 'PR-1' }, consumer = { observe: () => ({ alive: true }) }, runtimeVersion = { observe: () => ({}) }, chatPoller = null, store: givenStore = null, seed = [] } = {}, fn) => {
  const tasksDir = mkdtempSync(join(tmpdir(), 'lark-routes-mut-'))
  const store = givenStore || createTaskStore({ tasksDir, leaseMs: 60_000 })
  for (const task of seed) store.upsert({ createdAt: '2026-01-01T00:00:00Z', text: 'x', ...task })
  const server = createServer(createRequestHandler({ config, store, consumer, port: 0, runtimeVersion, chatPoller }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  rmSync(cliLog, { force: true })
  try {
    return await fn({ base: `http://127.0.0.1:${server.address().port}`, store })
  } finally {
    server.closeAllConnections?.()
    server.close()
    rmSync(tasksDir, { recursive: true, force: true })
  }
}

// 待分类的任务（received + intake.required）领出来，再走真实 /intake 路由回写分类结果。
const receive = (store, task) => {
  store.upsert({ status: 'received', intake: { required: true }, createdAt: '2026-01-01T00:00:00Z', text: `正文-${task.id}`, ...task })
  const claimed = store.claimById(task.id)
  assert.ok(claimed, `任务 ${task.id} 领不到`)
  return claimed
}
const postIntake = async (base, task, classification, extra = {}) => {
  const res = await fetch(`${base}/lark/tasks/${encodeURIComponent(task.id)}/intake`, { method: 'POST', headers: headersWithSecret, body: JSON.stringify({ epoch: task.epoch, classification, ...extra }) })
  return { status: res.status, ...(await res.json()) }
}

// 外部群仓库 profile（mutrt）：群 / 控制台各一个 webhook（fetch 桩记下发了什么），负责人 Aven；台账写在临时运行态，段末删。
const MUT_GROUP = 'oc_mut_group'
const MUT_AVEN = 'ou_mut_aven'
const withRepo = async (fn) => {
  registerRepoProfiles({ repos: { mutrt: {
    root: '/tmp/mutrt', baseRef: 'main', chatIds: [MUT_GROUP], notifyChatId: 'oc_mut_console', ownership: { me: 'Aven', meOpenIds: [MUT_AVEN] },
    webhooksByChat: { [MUT_GROUP]: { url: 'https://hook/group' }, oc_mut_console: { url: 'https://hook/console' } },
  } } })
  const savedFetch = globalThis.fetch
  const posted = []
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://hook/')) return savedFetch(url, init)
    posted.push({ url: String(url), body: String(init?.body || '') })
    return { ok: true, status: 200, text: async () => '{"code":0}', json: async () => ({ code: 0 }) }
  }
  try {
    return await fn({ posted })
  } finally {
    globalThis.fetch = savedFetch
    resetRepoProfiles()
    rmSync(join(runtimeRoot, 'lark-ledger'), { recursive: true, force: true })
    rmSync(join(runtimeRoot, 'lark-obligations'), { recursive: true, force: true })
  }
}
const seedLedger = (items) => saveLedger('mutrt', { items: Object.fromEntries(items.map((item) => [item.id, { doc: 'd', code: item.id.split('#')[1], title: item.id, status: 'open', updatedAt: new Date().toISOString(), lastEvent: null, ...item }])), events: [] })
const repoTask = (store, task) => receive(store, { repo: 'mutrt', chatId: MUT_GROUP, operator: 'ou_mut_encone', ...task })
const bugFor = (extra = {}) => ({ decision: 'bug', confidence: 'high', forMe: true, summary: 's', reason: 'r', items: [], ...extra })

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
    ['POST /notify、/group-ask：没密钥 401；没有外部群 profile（拿不到控制台群）404，不乱发', async () => {
      assert.equal((await fetch(`${base}/lark/notify`, { method: 'POST', body: '{}' })).status, 401)
      assert.equal((await fetch(`${base}/lark/notify`, { method: 'POST', headers, body: JSON.stringify({ repo: 'falive', markdown: 'x' }) })).status, 404)
      // 群里 @ 人要账号（10-26）同样：没密钥 401，拿不到仓库 profile 404
      assert.equal((await fetch(`${base}/lark/group-ask`, { method: 'POST', body: '{}' })).status, 401)
      const ask = await fetch(`${base}/lark/group-ask`, { method: 'POST', headers, body: JSON.stringify({ repo: 'falive', markdown: 'x' }) })
      assert.equal(ask.status, 404)
      assert.equal((await ask.json()).reason, 'repo not found')
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
    ['GET /lark/tasks 没密钥 401（列表含工单正文，不对本机任意进程敞开）；带密钥 200（变异补测 10-24）', async () => {
      assert.equal((await fetch(`${base}/lark/tasks`)).status, 401)
      assert.equal((await fetch(`${base}/lark/tasks`, { headers })).status, 200)
    }],
    ['POST heartbeat：任务不存在回 404，不混成「换代」的 409（变异补测 10-24）', async () => {
      const res = await fetch(`${base}/lark/tasks/ghost/heartbeat`, { method: 'POST', headers, body: JSON.stringify({ epoch: 0 }) })
      assert.equal(res.status, 404)
    }],
    ['POST /lark/tasks/next 领走排队任务置 running，没有可领的回 null；POST 打到按 id 取的路径不当查询（404）（变异补测 10-24）', () => withGateway({ seed: [{ id: 'n1', status: 'queued' }] }, async ({ base: gw, store: s }) => {
      const next = async () => (await fetch(`${gw}/lark/tasks/next`, { method: 'POST', headers: headersWithSecret, body: '{}' })).json()
      assert.equal((await next()).task?.id, 'n1')
      assert.equal(s.get('n1').status, 'running')
      assert.equal((await next()).task, null)
      assert.equal((await fetch(`${gw}/lark/tasks/n1`, { method: 'POST', headers: headersWithSecret, body: '{}' })).status, 404)
    })],
    ['GET /lark/tasks?repo=&limit=：按仓库过滤、按条数截断；不给参数返回全部（变异补测 10-24）', () => withGateway({ seed: [{ id: 'a1', repo: 'falive', status: 'queued' }, { id: 'b1', repo: 'other', status: 'queued' }, { id: 'a2', repo: 'falive', status: 'done' }] }, async ({ base: gw }) => {
      const ids = async (query) => (await (await fetch(`${gw}/lark/tasks${query}`, { headers: headersWithSecret })).json()).tasks.map((task) => task.id)
      assert.deepEqual(await ids('?repo=falive'), ['a1', 'a2'])
      assert.deepEqual(await ids('?repo=falive&limit=1'), ['a1'])
      assert.deepEqual(await ids(''), ['a1', 'b1', 'a2'])
    })],
    ['GET /lark/health：事件静默超过阈值（默认 30min，LARK_EVENT_STALE_MS 可调）才报、不影响 ok；还没收过事件不算静默（变异补测 10-24）', async () => {
      const savedStale = process.env.LARK_EVENT_STALE_MS
      delete process.env.LARK_EVENT_STALE_MS
      let lastEventAt = null
      try {
        await withGateway({ consumer: { observe: () => ({ alive: true, lastEventAt }) } }, async ({ base: gw }) => {
          const health = async () => (await fetch(`${gw}/lark/health`)).json()
          const silent = (body) => body.warnings.some((line) => line.includes('无事件'))
          let body = await health()
          assert.deepEqual([body.eventStale, silent(body)], [false, false], '还没收过事件')
          lastEventAt = Date.now() - 31 * 60_000
          body = await health()
          assert.deepEqual([body.eventStale, silent(body), body.ok], [true, true, true], '默认阈值 30min；静默只是诊断信号')
          lastEventAt = Date.now() - 29 * 60_000
          assert.equal((await health()).eventStale, false)
          process.env.LARK_EVENT_STALE_MS = '60000'
          lastEventAt = Date.now() - 2 * 60_000
          assert.equal((await health()).eventStale, true, '按环境变量的阈值')
        })
      } finally {
        if (savedStale === undefined) delete process.env.LARK_EVENT_STALE_MS
        else process.env.LARK_EVENT_STALE_MS = savedStale
      }
    }],
    ['GET /lark/health：回写挂起分「正在重试」与「已停止重试、需人工改表格」，只数还停在回写态的（变异补测 10-24）', () => withGateway({ seed: [{ id: 'wb1', status: 'done_pending_writeback' }, { id: 'wb_old', status: 'done', writebackGaveUp: true }] }, async ({ base: gw, store: s }) => {
      const line = async () => (await (await fetch(`${gw}/lark/health`)).json()).warnings.find((item) => item.includes('bug 表状态回写挂起'))
      assert.equal(await line(), '1 个任务已完成但 bug 表状态回写挂起，正在重试', '已落 done 的旧放弃标记不算')
      s.upsert({ ...s.get('wb1'), writebackGaveUp: true })
      assert.equal(await line(), '1 个任务已完成但 bug 表状态回写挂起，其中 1 个已停止重试、需人工改表格')
    })],
    ['GET /lark/health：运行版本漂移进 version 字段与告警；外部群轮询连续失败到阈值才报、带上错误原因（变异补测 10-24）', () => withGateway({
      runtimeVersion: { observe: () => ({ codeStale: true, codeHash: 'old1', diskCodeHash: 'new2' }) },
      chatPoller: { observe: () => ({ oc_at: { consecutiveFailures: POLL_WARN_AFTER_FAILURES, lastError: 'missing_scope' }, oc_below: { consecutiveFailures: POLL_WARN_AFTER_FAILURES - 1, lastError: 'x' }, oc_noerr: { consecutiveFailures: POLL_WARN_AFTER_FAILURES + 1 } }) },
    }, async ({ base: gw }) => {
      const body = await (await fetch(`${gw}/lark/health`)).json()
      assert.equal(body.version?.diskCodeHash, 'new2')
      assert.ok(body.warnings.some((line) => line.includes('运行中的代码已落后磁盘')), '版本漂移要显形')
      assert.deepEqual(Object.keys(body.chatPoller || {}), ['oc_at', 'oc_below', 'oc_noerr'])
      assert.deepEqual(body.warnings.filter((line) => line.startsWith('外部群 ')), [
        `外部群 oc_at 轮询已连续失败 ${POLL_WARN_AFTER_FAILURES} 次：missing_scope`,
        `外部群 oc_noerr 轮询已连续失败 ${POLL_WARN_AFTER_FAILURES + 1} 次：`,
      ])
    })],
    ['POST /intake 默认仓 bug：回执卡改投项目群并回写 chatId，卡上写明识别成「缺陷」，回执登记（变异补测 10-24）', () => withGateway({}, async ({ base: gw, store: s }) => {
      // 先把群列表缓存预热好：lark-cli 封装在子进程 exit 时就结算、负载下 stdout 偶尔没读到（群列表为空），本段测的是改投不是这个
      for (let i = 0; i < 5 && (await resolveChatIdByProject('PR-77777')) !== 'oc_mut_proj'; i += 1);
      assert.equal(await resolveChatIdByProject('PR-77777'), 'oc_mut_proj', '前提：项目群可解析')
      rmSync(cliLog, { force: true })
      const out = await postIntake(gw, receive(s, { id: 'om_mut_def', chatId: 'oc_mut_private', project: 'PR-77777' }), bugFor())
      assert.deepEqual([out.status, out.actionable], [200, true])
      assert.equal(s.get('om_mut_def').chatId, 'oc_mut_proj', '项目群可解析就改投并回写，后续卡都发项目群')
      const sends = cliCalls().split('\n').filter((line) => line.includes('+messages-send'))
      assert.equal(sends.length, 1)
      assert.ok(sends[0].includes('--chat-id oc_mut_proj '), sends[0])
      assert.ok(sends[0].includes('已识别为缺陷'), sends[0])
    })],
    ['POST /intake 默认仓按 relatedTaskId 归并：已了结 / 挂起的续跑并补发说明卡；排队中的只追加不发卡；判 ignore 的不并（变异补测 10-24）', () => withGateway({ seed: [
      { id: 'old_done', status: 'done', chatId: 'oc_mut_g', text: '旧任务' },
      { id: 'old_wait', status: 'waiting_confirmation', chatId: 'oc_mut_g', text: '挂起任务' },
      { id: 'old_q', status: 'queued', chatId: 'oc_mut_g', text: '排队任务' },
      { id: 'old_x', status: 'done', chatId: 'oc_mut_g', text: '无关旧任务' },
    ] }, async ({ base: gw, store: s }) => {
      const merge = (id, extra) => postIntake(gw, receive(s, { id, chatId: 'oc_mut_g' }), bugFor(extra))
      for (const [id, into, mode] of [['om_mut_r1', 'old_done', 'reopened'], ['om_mut_r2', 'old_wait', 'resumed']]) {
        rmSync(cliLog, { force: true })
        const out = await merge(id, { relatedTaskId: into })
        assert.deepEqual([out.mergedInto, out.mode], [into, mode])
        assert.deepEqual([s.get(into).status, s.get(id).status], ['queued', 'superseded'])
        assert.ok(cliCalls().includes('并入原任务续跑'), `${mode} 要补发说明卡`)
      }
      rmSync(cliLog, { force: true })
      const appended = await merge('om_mut_r3', { relatedTaskId: 'old_q' })
      assert.deepEqual([appended.mergedInto, appended.mode], ['old_q', 'appended'])
      assert.equal(cliCalls().includes('+messages-send'), false, '只追加正文，不发卡')
      const ignored = await merge('om_mut_r4', { relatedTaskId: 'old_x', decision: 'ignore' })
      assert.equal(ignored.mergedInto, undefined)
      assert.deepEqual([s.get('old_x').status, s.get('old_x').text, s.get('om_mut_r4').status], ['done', '无关旧任务', 'ignored'])
    })],
    ['POST /intake 未登记仓（走默认 profile）的疑似单：发待确认卡（写任务摘要、项目名），回执按当前代次登记；不记台账（变异补测 10-24）', () => withGateway({ config: { project: 'PR-1', title: '直播测试项目' } }, async ({ base: gw, store: s }) => {
      const task = receive(s, { id: 'om_mut_legacy', repo: 'legacyrepo', chatId: 'oc_mut_g', project: 'PR-1', epoch: 2 })
      const out = await postIntake(gw, task, { decision: 'bug', confidence: 'medium', summary: '首页直播卡片封面不显示', reason: 'r' })
      assert.equal(out.suspected, true)
      const card = cliCalls().split('\n').find((line) => line.includes('+messages-send')) || ''
      assert.ok(card.includes('**任务**：首页直播卡片封面不显示'), card)
      assert.ok(card.includes('[PR-1] 直播测试项目'), card)
      assert.deepEqual(s.get('om_mut_legacy').receipts.map(({ kind, epoch }) => ({ kind, epoch })), [{ kind: 'suspected', epoch: 2 }])
      assert.equal(existsSync(join(runtimeRoot, 'lark-ledger')), false, '默认 profile 不记台账')
    })],
    ['POST /intake 外部群疑似单：挂着的「收到」用分类器那句回群；私聊负责人的疑似提示按当前代次登记回执（变异补测 10-24）', () => withRepo(({ posted }) => withGateway({}, async ({ base: gw, store: s }) => {
      const task = repoTask(s, { id: 'om_mut_sus', epoch: 2, ackPending: { at: new Date().toISOString() } })
      const out = await postIntake(gw, task, { decision: 'bug', confidence: 'medium', summary: '封面不显示', reason: 'r', reply: '收到，我先看下封面的问题', items: [] })
      assert.equal(out.suspected, true)
      assert.ok(posted.some((item) => item.url === 'https://hook/group' && item.body.includes('我先看下封面的问题')), '疑似单也要把「收到」回掉')
      assert.equal(s.get('om_mut_sus').ackedInGroup, true)
      assert.ok(cliCalls().includes('可能是你的事'), '私聊负责人一句疑似')
      assert.deepEqual(s.get('om_mut_sus').receipts.filter((item) => item.kind === 'suspected').map(({ epoch }) => epoch), [2])
    }))],
    ['POST /intake 外部群判 ignore（没 @ 机器人、群里没回过收到）：不记台账、不定工单键、群里不出声也不私聊（变异补测 10-24）', () => withRepo(({ posted }) => withGateway({}, async ({ base: gw, store: s }) => {
      const out = await postIntake(gw, repoTask(s, { id: 'om_mut_ign' }), { decision: 'ignore', confidence: 'high', summary: '闲聊', reason: 'r' })
      assert.equal(out.status, 200)
      assert.deepEqual([s.get('om_mut_ign').status, s.get('om_mut_ign').topic], ['ignored', undefined])
      assert.deepEqual(loadLedger('mutrt').events, [], '判不处理的不进台账')
      assert.deepEqual(posted, [], '群里不出声')
      assert.equal(cliCalls(), '', '也不私聊')
    }))],
    ['POST /intake 外部群接着之前某条（continues）：沿用它的话题根与主题；它没话题根就以它为根；自己已有话题根不改；指向自己的不算接续（变异补测 10-24）', () => withRepo(() => withGateway({ seed: [
      { id: 'om_mut_p1', repo: 'mutrt', chatId: MUT_GROUP, status: 'done', threadRootId: 'om_mut_root', topic: 'T-p1' },
      { id: 'om_mut_p2', repo: 'mutrt', chatId: MUT_GROUP, status: 'done' },
      { id: 'om_mut_p3', repo: 'mutrt', chatId: MUT_GROUP, status: 'done', threadRootId: 'om_mut_root3', topic: 'T-p3' },
    ] }, async ({ base: gw, store: s }) => {
      const anchor = async (id, continues, extra = {}) => {
        await postIntake(gw, repoTask(s, { id, ...extra }), bugFor({ continues }))
        const { continues: by, threadRootId, topic } = s.get(id)
        return { continues: by, threadRootId, topic }
      }
      assert.deepEqual(await anchor('om_mut_c1', 'om_mut_p1'), { continues: 'om_mut_p1', threadRootId: 'om_mut_root', topic: 'T-p1' })
      assert.deepEqual(await anchor('om_mut_c2', 'om_mut_p2'), { continues: 'om_mut_p2', threadRootId: 'om_mut_p2', topic: 'msg:om_mut_c2' })
      assert.equal((await anchor('om_mut_c3', 'om_mut_p3', { threadRootId: 'om_mut_mine' })).threadRootId, 'om_mut_mine')
      assert.deepEqual(await anchor('om_mut_c4', 'om_mut_c4'), { continues: undefined, threadRootId: undefined, topic: 'msg:om_mut_c4' })
    }))],
    ['POST /intake 外部群消息记台账：触及的条目按分类推进，事件记下发言人与摘要（分类器的优先，没有用消息摘要，也作新条目标题）；工单键 = 条目（变异补测 10-24）', () => withRepo(() => withGateway({}, async ({ base: gw, store: s }) => {
      seedLedger([{ id: 'd#A1' }])
      await postIntake(gw, repoTask(s, { id: 'om_mut_l1' }), bugFor({ items: [{ id: 'd#A1', transition: 'answer' }] }))
      assert.deepEqual([s.get('om_mut_l1').ledgerItems, s.get('om_mut_l1').topic], [[{ id: 'd#A1' }], 'd#A1'])
      // 别人的事（forMe=false）不派工单但照记台账：任务摘要还是群消息原样，事件摘要用分类器的
      await postIntake(gw, repoTask(s, { id: 'om_mut_l2', summary: '首页直播封面不显示，谁看下' }), bugFor({ forMe: false, summary: '别人负责的封面接口问题' }))
      // 分类器没给摘要：事件摘要与群里新冒出来的条目标题都用消息摘要
      await postIntake(gw, repoTask(s, { id: 'om_mut_l3', summary: '直播列表分页少一条' }), bugFor({ summary: '', items: [{ id: 'new', transition: 'new' }] }))
      const ledger = loadLedger('mutrt')
      assert.equal(ledger.items['d#A1'].status, 'answered')
      assert.deepEqual(ledger.events.map(({ messageId, sender, items, excerpt }) => ({ messageId, sender, items, excerpt })), [
        { messageId: 'om_mut_l1', sender: 'ou_mut_encone', items: [{ id: 'd#A1', transition: 'answer' }], excerpt: 's' },
        { messageId: 'om_mut_l2', sender: 'ou_mut_encone', items: [], excerpt: '别人负责的封面接口问题' },
        { messageId: 'om_mut_l3', sender: 'ou_mut_encone', items: [{ id: s.get('om_mut_l3').ledgerItems[0]?.id, transition: 'new' }], excerpt: '直播列表分页少一条' },
      ])
      assert.equal(ledger.items[s.get('om_mut_l3').ledgerItems[0].id].title, '直播列表分页少一条')
    }))],
    ['POST /intake 待命指令：负责人交办「等 X 再做」挂到触及的条目上并记下交办人；别人说「等 X」不挂（变异补测 10-24）', () => withRepo(() => withGateway({}, async ({ base: gw, store: s }) => {
      seedLedger([{ id: 'd#A1' }, { id: 'd#A2' }])
      const ask = (id, item, extra) => postIntake(gw, repoTask(s, { id, text: '等接口文档到了把直播列表换成真实接口', ...extra }), bugFor({ decision: 'requirement', waitsFor: '接口文档', items: [{ id: item, transition: 'ask' }] }))
      await ask('om_mut_w1', 'd#A1', { operator: MUT_AVEN, fromPrincipal: true })
      await ask('om_mut_w2', 'd#A2', {})
      const ledger = loadLedger('mutrt')
      const { taskId, text, waitsFor, by } = ledger.items['d#A1'].standing || {}
      assert.deepEqual({ taskId, text, waitsFor, by }, { taskId: 'om_mut_w1', text: '等接口文档到了把直播列表换成真实接口', waitsFor: '接口文档', by: MUT_AVEN })
      assert.equal(ledger.items['d#A2'].standing, undefined, '不是负责人交办的不挂')
    }))],
    ['POST /intake 等的东西到了：带来对接文档或分类器判已满足，取出待命指令按原交办开工并标明交办人；只是接着聊的不触发（变异补测 10-24）', () => withRepo(() => withGateway({}, async ({ base: gw, store: s }) => {
      const standing = (by) => ({ taskId: 'om_mut_principal', text: '等接口文档到了把直播列表换成真实接口', waitsFor: '接口文档', by, at: new Date().toISOString() })
      seedLedger([{ id: 'd#B1', status: 'waiting', standing: standing(MUT_AVEN) }, { id: 'd#B2', status: 'waiting', standing: standing('ou_mut_other') }, { id: 'd#B3', status: 'waiting', standing: standing(MUT_AVEN) }])
      const bring = (id, text, item, extra = {}, cls = {}) => postIntake(gw, repoTask(s, { id, text, ...extra }), bugFor({ items: [{ id: item, transition: 'answer' }], ...cls }))
      await bring('om_mut_b1', '文档发了', 'd#B1', { attachments: [{ type: 'file', fileName: '直播接口.md' }] }, { decision: 'api_reply' })
      const b1 = s.get('om_mut_b1')
      assert.equal(b1.text, '【Aven 之前的交办（等「接口文档」，现在到了，直接开工）】\n等接口文档到了把直播列表换成真实接口\n\n【这次带来的】\n文档发了')
      assert.equal(b1.summary, '等的「接口文档」到了，执行之前的交办：等接口文档到了把直播列表换成真实接口')
      assert.deepEqual([b1.standingFrom, b1.status], [['om_mut_principal'], 'queued'])
      await bring('om_mut_b2', '可以了', 'd#B2', {}, { satisfiesWait: true })
      assert.ok(s.get('om_mut_b2').text.startsWith('【负责人 之前的交办（等「接口文档」'), '不是负责人本人交办的写「负责人」')
      await bring('om_mut_b3', '这个接口还有个字段要确认', 'd#B3')
      assert.equal(s.get('om_mut_b3').text, '这个接口还有个字段要确认', '没带来等的东西不触发')
      assert.equal(loadLedger('mutrt').items['d#B3'].standing?.taskId, 'om_mut_principal', '待命指令还挂着')
    }))],
    ['POST /intake 存量被动消息（没 @ 机器人建的任务）：只记台账落 ignored，结论补一句被动模式说明（变异补测 10-24）', () => withRepo(() => withGateway({}, async ({ base: gw, store: s }) => {
      const out = await postIntake(gw, repoTask(s, { id: 'om_mut_pass', passiveLedgerOnly: true }), bugFor())
      assert.equal(out.ledgerOnly, true)
      assert.deepEqual([s.get('om_mut_pass').status, s.get('om_mut_pass').result], ['ignored', '（被动模式：只记台账，没 @ 机器人不派工单）'])
    }))],
    ['POST /intake 外部群同条目：确定要做的并进同仓同条目还没开跑的那张，不并别的仓 / 别的条目（变异补测 10-24）', () => withRepo(() => withGateway({ seed: [
      { id: 'om_mut_decoy', repo: 'otherrepo', topic: 'd#C1', status: 'queued', text: '别的仓' },
      { id: 'om_mut_other', repo: 'mutrt', topic: 'd#C9', status: 'queued', text: '别的条目' },
      { id: 'om_mut_target', repo: 'mutrt', chatId: MUT_GROUP, topic: 'd#C1', status: 'queued', text: '先来的' },
    ] }, async ({ base: gw, store: s }) => {
      seedLedger([{ id: 'd#C1' }])
      const out = await postIntake(gw, repoTask(s, { id: 'om_mut_m1', text: '后来的' }), bugFor({ items: [{ id: 'd#C1', transition: 'notify' }] }))
      assert.deepEqual([out.mergedInto, out.mode], ['om_mut_target', 'appended'])
      assert.match(s.get('om_mut_target').text, /后来的/)
      assert.deepEqual([s.get('om_mut_decoy').text, s.get('om_mut_other').text], ['别的仓', '别的条目'])
    }))],
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
    ['GET /lark/tasks/changes：已有变更立即返回不挂起；没给 wait 不挂起；没给 since 只对齐游标；since=0 是合法游标、照样挂起（变异补测 10-24）', async () => {
      let changes = []
      const waits = []
      const stub = { changesSince: (since) => ({ seq: 5, changes: since >= 0 ? changes : [] }), waitForChange: async (ms) => { waits.push(ms) } }
      await withGateway({ store: stub }, async ({ base: gw }) => {
        const poll = (query) => fetch(`${gw}/lark/tasks/changes${query}`, { headers }).then((res) => res.json())
        changes = [{ seq: 5, id: 'q1' }]
        assert.equal((await poll('?since=4&wait=1000')).changes.length, 1)
        assert.deepEqual(waits, [], '有变更立即返回')
        changes = []
        await poll('?since=5')
        assert.deepEqual(waits, [], '没给 wait 不挂起')
        await poll('?wait=1000')
        assert.deepEqual(waits, [], '没给 since 只回游标')
        await poll('?since=0&wait=1000')
        assert.deepEqual(waits, [1000], 'since=0 照样挂起等变更')
      })
    }],
  ]))
})
