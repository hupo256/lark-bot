import assert from 'node:assert/strict'
import { mkdtempSync, rmdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

process.env.LARK_GATEWAY_SECRET = 'test-secret'
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
  })

  const at = new Date().toISOString()
  const intake = (id, classification, epoch = 0) => fetch(`${base}/lark/tasks/${id}/intake`, { method: 'POST', headers, body: JSON.stringify({ epoch, classification }) }).then((res) => res.json())
  const received = (id, extra = {}) => {
    store.upsert({ id, source: 'lark', repo: 'rvwfix', chatId: GROUP, text: `t-${id}`, status: 'received', intake: { required: true }, createdAt: at, ...extra })
    assert.ok(store.claimById(id))
  }

  it('被动消息（没 @ 机器人）判成高置信 bug：只记台账落 ignored，不并进同条目在排队的工单；重放不补发「开始做」', async () => {
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
  })

  it('疑似单（medium）不并进同条目在排队的工单，单独挂待确认', async () => {
    received('om_rvw_s')
    const out = await intake('om_rvw_s', { decision: 'bug', confidence: 'medium', forMe: true, summary: 's', reason: 'r', continues: 'om_rvw_q', items: [] })
    assert.equal(out.suspected, true)
    assert.equal(out.mergedInto, undefined)
    assert.equal(store.get('om_rvw_s').status, 'waiting_confirmation')
    assert.equal(store.get('om_rvw_q').text, 'queued-body')
    assert.deepEqual(posted.map((item) => item.url), ['https://hook/console'], '只私聊负责人一句疑似')
  })

  it('手工建任务：非默认仓没给 chatId 时不默认投外部群；连 notifyChatId 都没有就 400', async () => {
    const res = await fetch(`${base}/lark/tasks`, { method: 'POST', headers, body: JSON.stringify({ id: 'rvw_manual', repo: 'rvwnonotify', text: 'x' }) })
    assert.equal(res.status, 400)
    assert.match((await res.json()).error, /notifyChatId/)
    assert.equal(store.has('rvw_manual'), false)
  })
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
