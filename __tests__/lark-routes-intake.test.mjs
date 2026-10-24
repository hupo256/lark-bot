import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { eachCase, runSteps } from './support/steps.mjs'

process.env.LARK_GATEWAY_SECRET = 'test-secret'
// 运行态（台账 / 附件 / 日报）指到临时目录；lark-cli 换成 /usr/bin/true（退出 0、无输出）：路由按项目号反查群（chat-list）、
// retry 重下附件都会起 lark-cli，测试里不能碰本机真实运行目录和真实 lark-cli（变异补测 10-24）。
// 不现写桩脚本：macOS 首次执行新建的可执行文件要过一次安全扫描，约 300ms。true 当下载成功处理，落盘路径照常算出来。
const runtimeRoot = mkdtempSync(join(tmpdir(), 'lark-routes-intake-runtime-'))
process.env.LARK_RUNTIME_DIR = runtimeRoot
process.env.LARK_CLI_BIN = '/usr/bin/true'
const savedMode = process.env.LARK_INSTANCE_MODE
process.env.LARK_INSTANCE_MODE = 'repo-only'
const { createRequestHandler, resolveSweepDate } = await import('../lib/lark-routes.mjs')
const { createTaskStore } = await import('../lib/lark-task-store.mjs')
const { registerRepoProfiles, resetRepoProfiles, repoProfile } = await import('../lib/lark-repo-profile.mjs')
const { startChatPoller } = await import('../lib/lark-chat-poller.mjs')
const { larkRuntimeDir } = await import('../lib/lark-paths.mjs')

// aven 2026-10-20 review：分类回写路由的被动闸 / 疑似单并单 / 幂等重放；手工建任务与轮询告警不回落外部群；清扫默认本地日期。
// 仓库 key 用测试专用的 rvwfix：路由会写 runtime/lark-ledger/rvwfix.json（已 gitignore），测完删掉。
const GROUP = 'oc_rvw_group'
const CONSOLE = 'oc_rvw_console'
const headers = { 'x-lark-gateway-secret': 'test-secret', 'Content-Type': 'application/json' }

describe('分类回写：被动闸先于并单、疑似单不并单、幂等重放按当前状态', () => {
  let dir
  let server
  let base
  let store
  let savedFetch
  const posted = []
  before(async () => {
    savedFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith('https://hook/')) {
        posted.push({ url, body: JSON.parse(init.body) })
        return { ok: true, status: 200, text: async () => '{"code":0}', json: async () => ({ code: 0 }) }
      }
      return savedFetch(url, init)
    }
    registerRepoProfiles({ repos: {
      rvwfix: { root: '/tmp/rvwfix', baseRef: 'main', chatIds: [GROUP], notifyChatId: CONSOLE, passiveMode: 'ledger', ownership: { me: 'Aven', meOpenIds: ['ou_rvw_aven'] },
        webhooksByChat: { [GROUP]: { url: 'https://hook/group' }, [CONSOLE]: { url: 'https://hook/console' } } },
      rvwnonotify: { root: '/tmp/rvwnonotify', baseRef: 'main', chatIds: ['oc_rvw_other'] },
      rvwsweep: { root: '/tmp/rvwsweep', baseRef: 'main', chatIds: ['oc_rvw_sweep'], notifyChatId: 'oc_rvw_sweep_console', ownership: { me: 'aven' }, dailyReport: { at: '19:00', sweep: {} } },
    } })
    dir = mkdtempSync(join(tmpdir(), 'lark-routes-intake-'))
    store = createTaskStore({ tasksDir: dir, leaseMs: 60_000 })
    server = createServer(createRequestHandler({ config: { project: 'PR-1' }, store, consumer: { observe: () => ({ alive: true }) }, port: 0, runtimeVersion: { observe: () => ({}) } }))
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${server.address().port}`
  })
  after(() => {
    server.close()
    globalThis.fetch = savedFetch
    resetRepoProfiles()
    rmSync(dir, { recursive: true, force: true })
    rmSync(join(larkRuntimeDir, 'lark-ledger', 'rvwfix.json'), { force: true })
    try { rmdirSync(join(larkRuntimeDir, 'lark-ledger')) } catch { /* 目录里还有别的台账（本机运行态），不动 */ }
    if (savedMode === undefined) delete process.env.LARK_INSTANCE_MODE
    else process.env.LARK_INSTANCE_MODE = savedMode
    rmSync(runtimeRoot, { recursive: true, force: true })
  })

  const at = new Date().toISOString()
  const intake = (id, classification, epoch = 0) => fetch(`${base}/lark/tasks/${id}/intake`, { method: 'POST', headers, body: JSON.stringify({ epoch, classification }) }).then((res) => res.json())
  const received = (id, extra = {}) => {
    store.upsert({ id, source: 'lark', repo: 'rvwfix', chatId: GROUP, text: `t-${id}`, status: 'received', intake: { required: true }, createdAt: at, ...extra })
    assert.ok(store.claimById(id))
  }

  // 变异补测新段各起一个独立 store + server（变异补测 10-24）：不和上面几段共用任务，结束即关服、删目录。
  // fetch 默认 keep-alive，关服前先断开连接，否则 close 要等空闲超时。
  const withServer = async (fn) => {
    const tasksDir = mkdtempSync(join(tmpdir(), 'lark-routes-intake-own-'))
    const own = createTaskStore({ tasksDir, leaseMs: 60_000 })
    const srv = createServer(createRequestHandler({ config: { project: 'PR-1' }, store: own, consumer: { observe: () => ({ alive: true }) }, port: 0, runtimeVersion: { observe: () => ({}) } }))
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${srv.address().port}`
    const post = async (path, body = {}) => {
      const res = await fetch(`${url}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
      return { status: res.status, body: await res.json() }
    }
    try {
      return await fn({ store: own, post })
    } finally {
      srv.closeAllConnections()
      await new Promise((resolve) => srv.close(resolve))
      rmSync(tasksDir, { recursive: true, force: true })
    }
  }
  const ignoreCls = { decision: 'ignore', confidence: 'high', forMe: false, summary: '别人的排期', reason: '跟前端无关', items: [] }

  it('分类回写：被动高置信 bug 只记台账、疑似单不并单单独挂起、手工建任务不默认投外部群', () => runSteps([
    ['被动消息（没 @ 机器人）判成高置信 bug：只记台账落 ignored，不并进同条目在排队的工单；重放不补发「开始做」', async () => {
      store.upsert({ id: 'om_rvw_q', source: 'lark', repo: 'rvwfix', chatId: GROUP, text: 'queued-body', topic: 'T-rvw', status: 'queued', createdAt: at })
      received('om_rvw_p', { passiveLedgerOnly: true })
      const classification = { decision: 'bug', confidence: 'high', forMe: true, summary: 's', reason: 'r', continues: 'om_rvw_q', items: [] }
      const first = await intake('om_rvw_p', classification)
      assert.equal(first.ledgerOnly, true)
      assert.equal(first.mergedInto, undefined)
      assert.equal(store.get('om_rvw_p').status, 'ignored')
      assert.equal(store.get('om_rvw_q').text, 'queued-body', '没被并进去')
      const replay = await intake('om_rvw_p', classification)
      assert.equal(replay.alreadyResolved, true)
      assert.equal(replay.replayed, true)
      assert.equal(posted.length, 0, '重放没发「开始做」')
    }],
    // 10-23 #74 起 forMe=true 的 medium 直接开跑，疑似只剩「归属拿不准（forMe 未给）+ medium」
    ['疑似单（归属拿不准、medium）不并进同条目在排队的工单，单独挂待确认', async () => {
      received('om_rvw_s')
      const out = await intake('om_rvw_s', { decision: 'bug', confidence: 'medium', summary: 's', reason: 'r', continues: 'om_rvw_q', items: [] })
      assert.equal(out.suspected, true)
      assert.equal(out.mergedInto, undefined)
      assert.equal(store.get('om_rvw_s').status, 'waiting_confirmation')
      assert.equal(store.get('om_rvw_q').text, 'queued-body')
      assert.deepEqual(posted.map((item) => item.url), ['https://hook/console'], '只私聊负责人一句疑似')
    }],
    ['手工建任务：非默认仓没给 chatId 时不默认投外部群；连 notifyChatId 都没有就 400', async () => {
      const res = await fetch(`${base}/lark/tasks`, { method: 'POST', headers, body: JSON.stringify({ id: 'rvw_manual', repo: 'rvwnonotify', text: 'x' }) })
      assert.equal(res.status, 400)
      assert.match((await res.json()).error, /notifyChatId/)
      assert.equal(store.has('rvw_manual'), false)
    }],
    ['只 @ 负责人（没 @ 机器人、群里也没回过收到）的消息判不处理：静默，群里不回、也不私聊负责人（变异补测 10-24）', () => withServer(async ({ store: own, post }) => {
      const mark = posted.length
      own.upsert({ id: 'om_ign_quiet', source: 'lark', repo: 'rvwfix', chatId: GROUP, text: '下周排期另说', status: 'received', intake: { required: true }, createdAt: at })
      assert.ok(own.claimById('om_ign_quiet'))
      const res = await post('/lark/tasks/om_ign_quiet/intake', { epoch: 0, classification: ignoreCls })
      assert.equal(res.status, 200)
      assert.equal(own.get('om_ign_quiet').status, 'ignored')
      assert.deepEqual(posted.slice(mark).map((item) => item.url), [], '没人在等回复，一句都不发')
    })],
    ['判不处理但 @ 了机器人 / 群里回过收到：私聊负责人说明，回执登记在任务当前代次上（换过代的任务不能记成第 0 代）（变异补测 10-24）', () => withServer(({ store: own, post }) => eachCase([
      { name: '@ 机器人：群里回「记下了」+ 私聊负责人', id: 'om_ign_bot', extra: { addressedToBot: true }, urls: ['https://hook/group', 'https://hook/console'] },
      { name: '只 @ 负责人但群里回过收到：只私聊负责人', id: 'om_ign_acked', extra: { ackedInGroup: true }, urls: ['https://hook/console'] },
    ], async ({ id, extra, urls }) => {
      const mark = posted.length
      own.upsert({ id, source: 'lark', repo: 'rvwfix', chatId: GROUP, text: '下周排期另说', status: 'received', intake: { required: true }, epoch: 2, createdAt: at, ...extra })
      assert.ok(own.claimById(id))
      const res = await post(`/lark/tasks/${id}/intake`, { epoch: 2, classification: ignoreCls })
      assert.equal(res.status, 200)
      assert.deepEqual(posted.slice(mark).map((item) => item.url), urls)
      const receipt = (own.get(id).receipts || []).find((item) => item.kind === 'ignored')
      assert.ok(receipt, '私聊送达要登记回执，负责人回「继续任务」才锚得上')
      assert.equal(receipt.epoch, 2)
    }))],
    ['QA 验退重开 bug 表任务：请求里的项目号 / record / 群 / 指令类型 / 操作人覆盖旧值，换代重新排队；不存在或不是 bug 表任务 404（变异补测 10-24）', () => withServer(async ({ store: own, post }) => {
      own.upsert({ id: 'rec_qa', source: 'lark-bugtable', status: 'done', project: 'PR-OLD', recordId: 'rec_old', chatId: 'oc_old', commandType: 'fix', operator: 'op_old', text: '旧正文', result: '上一轮改了按钮', epoch: 1, createdAt: at })
      own.upsert({ id: 'om_chat_done', source: 'lark', status: 'done', chatId: 'oc_old', text: 'x', createdAt: at })
      assert.equal((await post('/lark/tasks/nope/reopen', { text: 'x' })).status, 404)
      const notBug = await post('/lark/tasks/om_chat_done/reopen', { text: 'x' })
      assert.equal(notBug.status, 404, '群消息任务不走 QA 验退')
      assert.equal(own.get('om_chat_done').status, 'done')
      const res = await post('/lark/tasks/rec_qa/reopen', { text: 'QA：仍复现', project: 'PR-9', recordId: 'rec_9', chatId: 'oc_new', commandType: 'api', operator: 'qa_li' })
      assert.equal(res.status, 200)
      assert.equal(res.body.reopened, true)
      const task = own.get('rec_qa')
      assert.deepEqual([task.status, task.epoch, task.project, task.recordId, task.chatId, task.commandType, task.operator], ['queued', 2, 'PR-9', 'rec_9', 'oc_new', 'api', 'qa_li'])
      assert.match(task.text, /^QA：仍复现/)
    })],
    ['QA 验退撞上还在排队 / 分类 / 执行 / 终检的同一 bug：幂等成功、不重开不换代（变异补测 10-24）', () => withServer(({ store: own, post }) => eachCase(['queued', 'received', 'running', 'verifying'].map((status) => ({ name: status, status })), async ({ status }) => {
      const id = `rec_active_${status}`
      own.upsert({ id, source: 'lark-bugtable', status, recordId: id, chatId: 'oc_old', text: '旧正文', epoch: 3, createdAt: at })
      const res = await post(`/lark/tasks/${id}/reopen`, { text: 'QA：仍复现' })
      assert.equal(res.status, 200)
      assert.equal(res.body.reopened, false)
      assert.deepEqual([own.get(id).status, own.get(id).epoch, own.get(id).text], [status, 3, '旧正文'])
    }))],
    ['手动补跑清扫：按请求的仓读当天完整版日报建清扫任务，正文带日报云文档链接；不认识的仓 404（变异补测 10-24）', () => withServer(async ({ store: own, post }) => {
      const reportDir = join(runtimeRoot, 'lark-daily-report', 'rvwsweep')
      mkdirSync(reportDir, { recursive: true })
      writeFileSync(join(reportDir, 'Falive 日报-2026-10-14-完整版.md'), '# 日报\n\n## 三、需要再跟进的工作\n\n| 事项 | 说明 | 负责人 |\n|---|---|---|\n| 发邮件部署 pre | 今天合入的还没部署 | **aven** |\n')
      try {
        assert.equal((await post('/lark/sweep', { repo: 'nosuch', date: '2026-10-14' })).status, 404)
        const res = await post('/lark/sweep', { repo: 'rvwsweep', date: '2026-10-14', docUrl: 'https://doc.example/d1' })
        assert.equal(res.status, 200)
        assert.deepEqual([res.body.ok, res.body.taskId, res.body.count], [true, 'sweep-rvwsweep-20261014', 1])
        assert.match(own.get('sweep-rvwsweep-20261014').text, /日报云文档：https:\/\/doc\.example\/d1/)
      } finally {
        rmSync(reportDir, { recursive: true, force: true })
      }
    })],
    ['本机脚本发私聊（/lark/notify）：发到请求仓的控制台、正文原样、成功 reason 为 null；没正文 400；仓没配控制台 404（变异补测 10-24）', () => withServer(async ({ post }) => {
      const mark = posted.length
      assert.equal((await post('/lark/notify', { repo: 'rvwnonotify', markdown: 'x' })).status, 404)
      assert.equal((await post('/lark/notify', { repo: 'rvwfix' })).status, 400, '没正文不能发出「undefined」')
      assert.equal(posted.length, mark)
      const res = await post('/lark/notify', { repo: 'rvwfix', markdown: '  bug 表轮询：3 条已修  ', source: 'bugpoll' })
      assert.equal(res.status, 200)
      assert.deepEqual(res.body, { ok: true, reason: null })
      assert.deepEqual(posted.slice(mark).map((item) => item.url), ['https://hook/console'])
      assert.match(JSON.stringify(posted.at(-1).body), /bug 表轮询：3 条已修/)
    })],
    ['终端结单：记下操作人和说明；没给操作人记 cli（变异补测 10-24）', () => withServer(async ({ store: own, post }) => {
      own.upsert({ id: 'cz_1', status: 'waiting_confirmation', chatId: 'oc_plain', text: 'x', createdAt: at })
      own.upsert({ id: 'cz_2', status: 'blocked', chatId: 'oc_plain', text: 'x', createdAt: at })
      assert.equal((await post('/lark/tasks/cz_1/close', { operator: 'aven', closureReason: 'completed_elsewhere', note: '已由 MR !120 修掉' })).status, 200)
      assert.deepEqual([own.get('cz_1').externalResolution.operator, own.get('cz_1').result], ['aven', '已由 MR !120 修掉'])
      assert.equal((await post('/lark/tasks/cz_2/close', {})).status, 200)
      assert.equal(own.get('cz_2').externalResolution.operator, 'cli')
    })],
    ['终端续跑：待确认 / 阻塞的任务带补充说明重新排队；别的状态 409；没补充 400；确认扩大范围记下批准人（变异补测 10-24）', () => withServer(async ({ store: own, post }) => {
      await eachCase(['waiting_confirmation', 'blocked'].map((status) => ({ name: status, status })), async ({ status }) => {
        const id = `rs_${status}`
        own.upsert({ id, status, chatId: 'oc_plain', text: '原正文', createdAt: at })
        assert.equal((await post(`/lark/tasks/${id}/resume`, {})).status, 400, '没补充不续跑')
        assert.equal(own.get(id).status, status)
        const res = await post(`/lark/tasks/${id}/resume`, { supplementText: '  接口已改成 v2  ' })
        assert.equal(res.status, 200)
        assert.equal(own.get(id).status, 'queued')
        assert.match(own.get(id).text, /【补料】\n接口已改成 v2$/)
      })
      own.upsert({ id: 'rs_running', status: 'running', chatId: 'oc_plain', text: '原正文', createdAt: at })
      const busy = await post('/lark/tasks/rs_running/resume', { supplementText: '补一句' })
      assert.equal(busy.status, 409)
      assert.match(busy.body.error, /not resumable/)
      own.upsert({ id: 'rs_scope', status: 'blocked', chatId: 'oc_plain', text: '原正文', scopeRequest: { paths: ['src/a.ts'] }, createdAt: at })
      assert.equal((await post('/lark/tasks/rs_scope/resume', { supplementText: '确认扩大范围', operator: 'aven' })).status, 200)
      assert.equal(own.get('rs_scope').scopeApprovals?.[0]?.approvedBy, 'aven')
    })],
    ['人工 retry：只重下载失败的图片（落在任务项目号目录、下成功过的不重下——哪怕还留着旧的 downloadError、没 messageId 不下）；无附件也能重试；达上限带原因 404（变异补测 10-24）', () => withServer(async ({ store: own, post }) => {
      const done = { type: 'image', imageKey: 'img_done', localPath: '/orig/done.png', downloadError: '上一轮 retry 前的失败（重下成功后这个字段不清）' }
      const ok = { type: 'image', imageKey: 'img_ok', localPath: '/orig/ok.png' }
      own.upsert({ id: 'rt_img', status: 'failed', project: 'PR-77', messageId: 'om_src', chatId: 'oc_plain', text: 'x', createdAt: at,
        attachments: [{ ...done }, { type: 'image', imageKey: 'img_bad', downloadError: 'boom' }, { ...ok }] })
      const res = await post('/lark/tasks/rt_img/retry')
      assert.equal(res.status, 200)
      const [afterDone, bad, afterOk] = own.get('rt_img').attachments
      assert.equal(bad.localPath, join(runtimeRoot, 'lark-attachments', 'PR-77', 'om_src', '1-img_bad.img'), '只重下这一张，落在任务项目号目录')
      assert.deepEqual([afterDone, afterOk], [done, ok], '下成功过的不重下')
      assert.equal(own.get('rt_img').status, 'queued')
      own.upsert({ id: 'rt_nomsg', status: 'failed', chatId: 'oc_plain', text: 'x', createdAt: at, attachments: [{ type: 'image', imageKey: 'img_x', downloadError: 'boom' }] })
      assert.equal((await post('/lark/tasks/rt_nomsg/retry')).status, 200)
      assert.equal(own.get('rt_nomsg').attachments[0].localPath, undefined, '没 messageId 下不了，不硬下')
      own.upsert({ id: 'rt_plain', status: 'blocked', chatId: 'oc_plain', text: 'x', createdAt: at })
      assert.equal((await post('/lark/tasks/rt_plain/retry')).status, 200)
      assert.equal(own.get('rt_plain').retryCount, 1)
      own.upsert({ id: 'rt_cap', status: 'failed', retryCount: 999, chatId: 'oc_plain', text: 'x', createdAt: at })
      const capped = await post('/lark/tasks/rt_cap/retry')
      assert.equal(capped.status, 404)
      assert.match(capped.body.error, /上限/, '达上限要告诉人为什么')
      assert.equal((await post('/lark/tasks/nope/retry')).body.error, 'task not found or not retryable (must be failed/blocked)')
    })],
    ['清理终态：statuses 给空数组按默认只清 done；显式给 failed 才清 failed（变异补测 10-24）', () => withServer(async ({ store: own, post }) => {
      own.upsert({ id: 'pr_done', status: 'done', text: 'x', createdAt: at })
      own.upsert({ id: 'pr_failed', status: 'failed', text: 'x', createdAt: at })
      own.upsert({ id: 'pr_q', status: 'queued', text: 'x', createdAt: at })
      assert.deepEqual((await post('/lark/tasks/prune', { statuses: [] })).body.removed, ['pr_done'])
      assert.deepEqual((await post('/lark/tasks/prune', { statuses: ['failed'] })).body.removed, ['pr_failed'])
      assert.equal(own.has('pr_q'), true)
    })],
    ['按 id 领取置 running；释放交还队列并换代，非 running 404；未知 POST 路径 404（变异补测 10-24）', () => withServer(async ({ store: own, post }) => {
      own.upsert({ id: 'cl_q', status: 'queued', text: 'x', createdAt: at })
      assert.equal((await post('/lark/tasks/cl_q/claim')).body.task?.status, 'running')
      const released = await post('/lark/tasks/cl_q/release')
      assert.equal(released.status, 200)
      assert.deepEqual([own.get('cl_q').status, own.get('cl_q').epoch], ['queued', 1])
      assert.equal((await post('/lark/tasks/cl_q/release')).status, 404)
      const unknown = await post('/lark/nope')
      assert.deepEqual([unknown.status, unknown.body.error], [404, 'not found'])
    })],
    ['建任务的 id 取 id / recordId / messageId 任一；状态回写失败按业务码返回（过期代次 409、任务不存在 404）；POST 回执重试有 pending 才重置（变异补测 10-24）', () => withServer(async ({ store: own, post }) => {
      assert.equal((await post('/lark/tasks', { recordId: 'rec_only', text: '只给 recordId' })).status, 200)
      assert.equal((await post('/lark/tasks', { messageId: 'om_only', text: '只给 messageId' })).status, 200)
      assert.deepEqual([own.has('rec_only'), own.has('om_only')], [true, true], '只给 recordId 或 messageId 也能建任务')
      own.upsert({ id: 't-stale', status: 'running', epoch: 2, text: 'x', createdAt: '2026-01-01T00:00:00Z' })
      const stale = await post('/lark/tasks/t-stale/status', { status: 'done', result: '迟到的回写', epoch: 1 })
      assert.equal(stale.status, 409, '过期代次按业务码 409 拒绝，不是 404')
      assert.match(stale.body.error, /stale epoch/)
      assert.equal((await post('/lark/tasks/no-such/status', { status: 'done' })).status, 404, '任务不存在（无业务码）回落 404')
      own.upsert({ id: 't-rcpt', status: 'result_pending_receipt', epoch: 0, text: 'x', createdAt: '2026-01-01T00:00:00Z', pendingReceipt: { status: 'done', epoch: 0, idempotencyKey: 't-rcpt-e0-done', attempts: 12, gaveUp: true } })
      const retried = await post('/lark/tasks/t-rcpt/receipt/retry')
      assert.equal(retried.status, 200)
      assert.deepEqual([own.get('t-rcpt').pendingReceipt.attempts, own.get('t-rcpt').pendingReceipt.gaveUp], [0, false], '人工重试清零次数、取消放弃')
      assert.equal((await post('/lark/tasks/t-stale/receipt/retry')).status, 409, '没有 pending 回执 409')
    })],
    ['手工建任务：不认识的仓 400；仓任务没给 chatId 投控制台、来源默认 lark-bugtable；显式给的群 / 项目号 / 来源 / 操作人 / 附件原样落（变异补测 10-24）', () => withServer(async ({ store: own, post }) => {
      const unknown = await post('/lark/tasks', { id: 'mk_unknown', repo: 'nosuch', text: 'x' })
      assert.equal(unknown.status, 400)
      assert.match(unknown.body.error, /unknown repo: nosuch/)
      assert.equal(own.has('mk_unknown'), false)
      assert.equal((await post('/lark/tasks', { id: 'mk_repo', repo: 'rvwfix', text: 'x' })).status, 200)
      assert.deepEqual([own.get('mk_repo').chatId, own.get('mk_repo').repo, own.get('mk_repo').source], [CONSOLE, 'rvwfix', 'lark-bugtable'])
      const attachments = [{ type: 'image', imageKey: 'img_1' }]
      assert.equal((await post('/lark/tasks', { id: 'mk_full', chatId: 'oc_explicit', project: 'PR-5', source: 'manual-curl', operator: 'aven', attachments, text: 'y' })).status, 200)
      const task = own.get('mk_full')
      assert.deepEqual([task.chatId, task.project, task.source, task.operator, task.attachments], ['oc_explicit', 'PR-5', 'manual-curl', 'aven', attachments])
    })],
  ]))
})

describe('轮询告警只发负责人控制台', () => {
  it('没配 notifyChatId：连续失败到阈值也不发，不回落外部群', async () => {
    registerRepoProfiles({ repos: { rvwpoll: { root: '/tmp/rvwpoll', baseRef: 'main', chatIds: ['oc_rvw_poll'] } } })
    const dir = mkdtempSync(join(tmpdir(), 'lark-poller-alert-'))
    const sent = []
    try {
      const poller = startChatPoller({
        config: {}, store: {}, statePath: join(dir, 'state.json'), ingest: async () => {},
        deps: {
          now: () => new Date(), setTimeout: () => ({ unref() {} }), isLidClosed: async () => false, isChatMember: async () => false, lastSystemSleepAt: async () => null,
          sendChatMessage: async (args) => { sent.push(args); return { ok: true } },
          listThreadMessages: async () => ({ ok: true, messages: [] }),
          listChatMessages: async () => ({ ok: false, reason: 'missing_scope', transient: false }),
        },
      })
      const profile = repoProfile('rvwpoll')
      for (let i = 0; i < profile.poll.alertAfterFailures + 1; i += 1) await poller.pollOnce({ chatId: 'oc_rvw_poll', profile })
      assert.equal(poller.observe().oc_rvw_poll.consecutiveFailures, profile.poll.alertAfterFailures + 1)
      assert.equal(sent.length, 0)
      poller.stop()
    } finally {
      resetRepoProfiles()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('清扫默认日期取本机日期', () => {
  it('本机 00:30 取当天，不是 UTC 的前一天；显式日期原样', () => {
    assert.equal(resolveSweepDate(undefined, new Date(2026, 9, 20, 0, 30)), '2026-10-20')
    assert.equal(resolveSweepDate('bad', new Date(2026, 9, 20, 23, 59)), '2026-10-20')
    assert.equal(resolveSweepDate('2026-10-18', new Date(2026, 9, 20)), '2026-10-18')
  })
})
