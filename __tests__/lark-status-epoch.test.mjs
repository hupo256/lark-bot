import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, beforeEach, describe, it } from 'node:test'

import { runSteps } from './support/steps.mjs'

// 假 lark-cli（变异补测 10-24）：bug 表状态同步 / 日报失败私信 / 补料再跑排队卡这几条路径直接调 lark-cli，没有注入口。
// LARK_CLI_BIN / LARK_RUNTIME_DIR 在模块加载时读，所以先设环境再动态 import；每段用 fakeCli() 换一份调用记录。
const cliRoot = mkdtempSync(join(tmpdir(), 'lark-status-cli-'))
const cliBin = join(cliRoot, 'fake-lark-cli')
writeFileSync(cliBin, '#!/bin/sh\necho \'{"ok":true,"data":{}}\'\n')
chmodSync(cliBin, 0o755)
process.env.LARK_CLI_BIN = cliBin
process.env.LARK_RUNTIME_DIR = join(cliRoot, 'runtime')
delete process.env.LARK_RECEIPT_MAX_ATTEMPTS
delete process.env.LARK_INSTANCE_MODE
const { handleStatusUpdate, resolveReceiptOutcome, retryPendingReceipts, sendQueuedReceipt } = await import('../lib/lark-status.mjs')
const { createTaskStore } = await import('../lib/lark-task-store.mjs')
const { registerRepoProfiles, resetRepoProfiles } = await import('../lib/lark-repo-profile.mjs')
const { buildDailyReportTask } = await import('../lib/lark-system-tasks.mjs')
const { readDailyReportState } = await import('../lib/lark-daily-schedule.mjs')
const { loadLedger, saveLedger } = await import('../lib/lark-ledger.mjs')

after(() => rmSync(cliRoot, { recursive: true, force: true }))

// 每次调用记一行参数；发送类都回成功。calls(pattern) 返回含 pattern 的调用行。
const fakeCli = () => {
  const caseDir = mkdtempSync(join(cliRoot, 'case-'))
  writeFileSync(cliBin, `#!/bin/sh\necho "$*" >> "${caseDir}/calls.log"\necho '{"ok":true,"data":{"message_id":"om_cli"}}'\n`)
  const lines = () => {
    try { return readFileSync(join(caseDir, 'calls.log'), 'utf8').split('\n').filter(Boolean) } catch { return [] }
  }
  return { calls: (pattern) => lines().filter((line) => line.includes(pattern)) }
}

// 每段自建 store 与临时目录，结束清掉并恢复默认仓 profile。
const withStore = async (fn) => {
  const own = mkdtempSync(join(tmpdir(), 'lark-status-mut-'))
  try {
    return await fn(createTaskStore({ tasksDir: join(own, 'tasks'), leaseMs: 60_000 }), own)
  } finally {
    rmSync(own, { recursive: true, force: true })
    resetRepoProfiles()
  }
}
const cardText = (card) => (typeof card === 'string' ? card : JSON.stringify(card))
const running = (extra = {}) => ({ status: 'running', epoch: 0, project: 'PR-1', chatId: 'oc_1', text: 'x', createdAt: '2026-01-01T00:00:00Z', ...extra })
const stubs = { config: { project: 'PR-1' }, resolveGroupChat: async () => null, postGroup: async () => ({ ok: true }), deliverRepo: async () => ({ ok: true, messageId: 'om_d' }) }

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
    ['回执重试上限缺省 12 次：第 12 次失败才放弃自动重试，之前都继续（变异补测 10-24）', () => {
      assert.deepEqual(resolveReceiptOutcome({ ok: false, attempts: 10 }), { attempts: 11, gaveUp: false, retry: true })
      assert.deepEqual(resolveReceiptOutcome({ ok: false, attempts: 11 }), { attempts: 12, gaveUp: true, retry: false })
    }],
    ['外部群排队卡改发负责人私聊并注明群名（没配群名写 chat_id）；quietQueuedCards=false 照发群；没有 message_id 不登记回执（变异补测 10-24）', () => withStore(async () => {
      registerRepoProfiles({ repos: { falive: { root: '/tmp/falive-react', baseRef: 'main', chatIds: ['oc_ext', 'oc_nolabel'], notifyChatId: 'ou_aven', chatLabels: { oc_ext: 'Falive 对接群' } } } })
      const sent = []
      const recorded = []
      const store = { recordReceipt: (id, value) => recorded.push({ id, ...value }) }
      const send = (reply) => async (args) => { sent.push(args); return reply }
      const queue = (task, reply) => sendQueuedReceipt({ config: { project: 'PR-1' }, store, task: { summary: '排队', ...task }, note: '**说明**：先排着', sendMessage: send(reply) })
      await queue({ id: 'q1', chatId: 'oc_ext', epoch: 3 }, { ok: true, messageId: 'om_q1' })
      assert.equal(sent[0].chatId, 'ou_aven', '排队卡只发负责人私聊')
      assert.ok(cardText(sent[0].card).includes('**群**：Falive 对接群（排队卡只发给你，结果卡发群）'))
      assert.ok(cardText(sent[0].card).includes('**说明**：先排着'))
      assert.deepEqual(recorded, [{ id: 'q1', messageId: 'om_q1', kind: 'queued', epoch: 3 }])
      await queue({ id: 'q2', chatId: 'oc_nolabel' }, { ok: true })
      assert.ok(cardText(sent[1].card).includes('**群**：oc_nolabel（排队卡只发给你'), '没配群名时写 chat_id')
      assert.equal(recorded.length, 1, '发送成功但没有 message_id 不登记回执')
      registerRepoProfiles({ repos: { falive: { root: '/tmp/falive-react', baseRef: 'main', chatIds: ['oc_ext'], notifyChatId: 'ou_aven', quietQueuedCards: false } } })
      await queue({ id: 'q3', chatId: 'oc_ext' }, { ok: true, messageId: 'om_q3' })
      assert.equal(sent[2].chatId, 'oc_ext', '关掉 quietQueuedCards 照发群')
      assert.ok(!cardText(sent[2].card).includes('排队卡只发给你'))
    })],
    ['归属别的负责人（other_owner）的无需改动卡 @ 该负责人，人名表 = 全局 ownerMap 叠加仓库 ownerMap；其它原因 / 其它终态不 @（变异补测 10-24）', () => withStore(async (store) => {
      registerRepoProfiles({ repos: { fameex: { ownerMap: { henry: 'ou_henry' } } } })
      const cards = {}
      const update = async (id, extra) => {
        store.upsert({ id, ...running() })
        await handleStatusUpdate({ ...stubs, config: { project: 'PR-1', ownerMap: { lily: 'ou_lily' } }, store, id, epoch: 0, result: '结束。', sendMessage: async ({ card }) => { cards[id] = cardText(card); return { ok: true, messageId: `om_${id}` } }, ...extra })
      }
      await update('a', { status: 'no_change_needed', noChangeReason: 'other_owner', owner: 'henry' })
      await update('b', { status: 'no_change_needed', noChangeReason: 'other_owner', owner: 'lily' })
      await update('c', { status: 'no_change_needed', noChangeReason: 'env_version', owner: 'henry' })
      await update('d', { status: 'done', noChangeReason: 'other_owner', owner: 'henry' })
      await update('e', { status: 'done', owner: 'henry' })
      assert.ok(cards.a.includes('<at id=ou_henry></at> 该功能的前端负责人是 henry，bot 已跳过，请接手处理'), '仓库 ownerMap 里的负责人被 @')
      assert.ok(cards.b.includes('<at id=ou_lily></at> 该功能的前端负责人是 lily'), '全局 ownerMap 里的负责人被 @')
      for (const id of ['c', 'd', 'e']) assert.ok(!cards[id].includes('<at '), `${id}：不是 other_owner 的无需改动卡不 @ 人`)
    })],
    ['挂起卡回执结算：正常送达登记回执；发送期间被同话题收尾或写进别的 pending 时，旧发送结果作废不登记（变异补测 10-24）', () => withStore(async (store) => {
      const blocked = async (id, duringSend = () => {}) => {
        store.upsert({ id, ...running() })
        return handleStatusUpdate({ ...stubs, store, id, status: 'blocked', result: '等补料', epoch: 0, sendMessage: async () => { duringSend(); return { ok: true, messageId: `om_${id}` } } })
      }
      assert.deepEqual(await blocked('ok'), { ok: true })
      assert.equal(store.get('ok').lastDeliveredReceipt?.idempotencyKey, 'ok-e0-blk')
      assert.equal(store.findByReceiptMessageId('om_ok')?.id, 'ok')
      const superseded = await blocked('sup', () => store.supersede({ id: 'sup', bySiblingId: 'sib' }))
      assert.equal(superseded.receiptSuperseded, true)
      assert.equal(store.get('sup').status, 'superseded')
      assert.equal(store.get('sup').lastDeliveredReceipt, undefined)
      assert.equal(store.findByReceiptMessageId('om_sup'), null)
      const otherPending = { status: 'blocked', result: '另一轮', epoch: 0, idempotencyKey: 'pend-e0-other', attempts: 0, gaveUp: false }
      const replaced = await blocked('pend', () => { store.get('pend').pendingReceipt = otherPending })
      assert.equal(replaced.receiptSuperseded, true)
      assert.equal(store.get('pend').lastDeliveredReceipt, undefined)
      assert.equal(store.get('pend').pendingReceipt.idempotencyKey, 'pend-e0-other', '后来写入的 pending 不被旧请求结算')
    })],
    ['结果卡发送期间任务转入 result_pending_receipt（同一代）：回执仍算本轮，照常登记（变异补测 10-24）', () => withStore(async (store) => {
      store.upsert({ id: 't', ...running() })
      const outcome = await handleStatusUpdate({ ...stubs, store, id: 't', status: 'failed', result: '处理失败。', epoch: 0, sendMessage: async () => { store.get('t').status = 'result_pending_receipt'; return { ok: true, messageId: 'om_fail' } } })
      assert.equal(outcome.receiptSuperseded, undefined)
      assert.equal(store.get('t').lastDeliveredReceipt?.idempotencyKey, 't-e0-fail')
      assert.equal(store.findByReceiptMessageId('om_fail')?.id, 't')
    })],
    ['结果卡送达结算同键 pending 时，发送期间被回写重试改成的 result_pending_receipt 一并落回 done，不永久卡住（bug 修复 10-24）', () => withStore(async (store) => {
      // 上一轮：回写失败 + 回执失败 → done_pending_writeback 且存了同代 pending；worker 同代重发 done，
      // 发卡期间回写重试定时器成功，因有 pending 把状态原地改成 result_pending_receipt。
      store.upsert({ id: 't', ...running({ status: 'done_pending_writeback' }), pendingReceipt: { status: 'done', result: '完成', epoch: 0, idempotencyKey: 't-e0-done', attempts: 1, gaveUp: false } })
      const outcome = await handleStatusUpdate({ ...stubs, store, id: 't', status: 'done', result: '完成', epoch: 0, sendMessage: async () => { store.get('t').status = 'result_pending_receipt'; return { ok: true, messageId: 'om_done' } } })
      assert.deepEqual(outcome, { ok: true })
      assert.equal(store.get('t').pendingReceipt, undefined)
      assert.equal(store.get('t').status, 'done', '两个重试器都不再管它，必须当场落回本次状态')
      assert.equal(store.get('t').lastDeliveredReceipt?.idempotencyKey, 't-e0-done')
    })],
    ['回执此前已送达、同键 pending 还挂着：同代重发 done 不重发卡、结算 pending、状态为 done（提前返回分支前状态已落成本次，中间无 await，不会卡在 result_pending_receipt）（10-24）', () => withStore(async (store) => {
      store.upsert({ id: 't', ...running({ status: 'result_pending_receipt' }), pendingReceipt: { status: 'done', result: '完成', epoch: 0, idempotencyKey: 't-e0-done', attempts: 1, gaveUp: false }, lastDeliveredReceipt: { idempotencyKey: 't-e0-done', status: 'done', epoch: 0, deliveredAt: '2026-01-01T00:00:00Z' } })
      let sends = 0
      const outcome = await handleStatusUpdate({ ...stubs, store, id: 't', status: 'done', result: '完成', epoch: 0, sendMessage: async () => { sends += 1; return { ok: true, messageId: 'om_dup' } } })
      assert.equal(outcome.receiptAlreadyDelivered, true)
      assert.equal(sends, 0, '已送达过不重发')
      assert.equal(store.get('t').pendingReceipt, undefined)
      assert.equal(store.get('t').status, 'done', '删了 pending 必须落回本次状态，否则两个重试器都不再管它')
    })],
    ['挂起卡发送失败：pending 存下本轮结果正文，任务保持挂起态（不转 result_pending_receipt，补料续跑可用）（变异补测 10-24）', () => withStore(async (store) => {
      store.upsert({ id: 't', ...running() })
      const outcome = await handleStatusUpdate({ ...stubs, store, id: 't', status: 'blocked', result: '等补料：缺接口文档', epoch: 0, sendMessage: async () => ({ ok: false, reason: 'network down' }) })
      assert.equal(outcome.receiptPending, true)
      assert.equal(store.get('t').status, 'blocked')
      assert.equal(store.get('t').pendingReceipt.result, '等补料：缺接口文档')
      assert.equal(store.get('t').pendingReceipt.idempotencyKey, 't-e0-blk')
    })],
    ['回执定时重试：只挑有 pending 且没放弃的任务；老 pending 没存幂等键时按 代次 + 状态短码 补出键再发（变异补测 10-24）', () => withStore(async (store) => {
      store.upsert({ id: 'plain', ...running({ status: 'done' }) })
      store.upsert({ id: 'gave', ...running({ status: 'result_pending_receipt' }), pendingReceipt: { status: 'done', epoch: 0, idempotencyKey: 'gave-e0-done', attempts: 12, gaveUp: true } })
      store.upsert({ id: 'legacy', ...running({ status: 'result_pending_receipt', epoch: 3 }), pendingReceipt: { status: 'failed', result: '处理失败。', epoch: 3, attempts: 1, gaveUp: false } })
      const sent = []
      await retryPendingReceipts({ config: { project: 'PR-1' }, store, sendMessage: async ({ idempotencyKey }) => { sent.push(idempotencyKey); return { ok: true, messageId: 'om_legacy' } } })
      assert.deepEqual(sent, ['legacy-e3-fail'], '只重试 legacy，键补成 <id>-e<代次>-<短码>')
      assert.equal(store.get('legacy').status, 'failed')
      assert.equal(store.get('legacy').pendingReceipt, undefined)
      assert.equal(store.get('legacy').lastDeliveredReceipt?.idempotencyKey, 'legacy-e3-fail')
      assert.equal(store.get('gave').pendingReceipt.gaveUp, true, '已放弃的不再自动请求')
    })],
    ['回执重试失败、但发送期间别处已登记送达：直接结算 pending 并落回原终态，不累加失败（变异补测 10-24）', () => withStore(async (store) => {
      store.upsert({ id: 't', ...running({ status: 'result_pending_receipt', epoch: 2 }), pendingReceipt: { status: 'done', result: '完成', epoch: 2, idempotencyKey: 't-e2-done', attempts: 1, gaveUp: false } })
      await retryPendingReceipts({
        config: { project: 'PR-1' },
        store,
        sendMessage: async () => {
          store.get('t').lastDeliveredReceipt = { idempotencyKey: 't-e2-done', status: 'done', epoch: 2, deliveredAt: '2026-01-01T00:00:00Z' }
          return { ok: false, reason: 'response lost' }
        },
      })
      assert.equal(store.get('t').pendingReceipt, undefined)
      assert.equal(store.get('t').status, 'done')
    })],
    ['回写字段清洗：aiExecutor 不带时沿用原值、带了以本次为准；followUps / ownerNotes 丢掉坏项；integration / payload 只收对象（变异补测 10-24）', () => withStore(async (store) => {
      store.upsert({ id: 't', ...running({ aiExecutor: 'codex' }) })
      await handleStatusUpdate({ ...stubs, store, id: 't', status: 'running', epoch: 0, aiExecutor: 'claude' })
      assert.equal(store.get('t').aiExecutor, 'claude', '本次带了 aiExecutor 以本次为准')
      await handleStatusUpdate({
        ...stubs,
        store,
        id: 't',
        status: 'done',
        result: '完成',
        epoch: 0,
        sendMessage: async () => ({ ok: true, messageId: 'om_t' }),
        followUps: [null, { owner: 1 }, { owner: 'henry', title: '接口' }],
        ownerNotes: ['   ', '先合 pre', 5],
        integration: { mergedBack: true },
        payload: { doc: { url: 'https://doc' } },
      })
      const task = store.get('t')
      assert.equal(task.aiExecutor, 'claude', '不带 aiExecutor 沿用原值')
      assert.deepEqual(task.followUps, [{ owner: 'henry', title: '接口' }])
      assert.deepEqual(task.ownerNotes, ['先合 pre'])
      assert.deepEqual(task.integration, { mergedBack: true })
      assert.deepEqual(task.payload, { doc: { url: 'https://doc' } })
      store.upsert({ id: 'u', ...running() })
      await handleStatusUpdate({ ...stubs, store, id: 'u', status: 'failed', result: '失败', epoch: 0, sendMessage: async () => ({ ok: true, messageId: 'om_u' }), integration: 'merged', payload: 'doc' })
      assert.equal(store.get('u').integration, null)
      assert.equal(store.get('u').payload, null)
    })],
    ['bug 表状态同步：领取置修复中、环境版本无需改动置不是问题、挂起置待确认；只对 bug 表来源且只在对应状态（变异补测 10-24）', () => withStore(async (store) => {
      const cli = fakeCli()
      const config = { project: 'PR-1', bugTable: { appToken: 'app', tableId: 'tbl', statusField: '状态', inProgressValue: '修复中', notIssueValue: '不是问题', waitingValue: '待确认' } }
      const cases = [
        { id: 'r1', source: 'lark-bugtable', status: 'running', expected: ['修复中'] },
        { id: 'r2', source: 'lark-group', status: 'running', expected: [] },
        { id: 'r3', source: 'lark-bugtable', status: 'failed', noChangeReason: 'env_version', expected: [] },
        { id: 'r4', source: 'lark-bugtable', status: 'no_change_needed', noChangeReason: 'env_version', expected: ['不是问题'] },
        { id: 'r5', source: 'lark-bugtable', status: 'no_change_needed', noChangeReason: 'not_frontend', expected: [] },
        { id: 'r6', source: 'lark-group', status: 'no_change_needed', noChangeReason: 'env_version', expected: [] },
        { id: 'r7', source: 'lark-bugtable', status: 'blocked', expected: ['待确认'] },
        { id: 'r8', source: 'lark-group', status: 'blocked', expected: [] },
      ]
      for (const { id, source, status, noChangeReason } of cases) {
        store.upsert({ id, ...running({ status: 'queued', source, recordId: `rec_${id}` }) })
        await handleStatusUpdate({ ...stubs, config, store, id, status, noChangeReason, result: '结果', epoch: 0, sendMessage: async () => ({ ok: true, messageId: `om_${id}` }) })
      }
      for (const { id, expected } of cases) {
        const values = cli.calls('+record-batch-update').filter((line) => line.includes(`"rec_${id}"`)).map((line) => line.match(/"状态":"([^"]+)"/)?.[1])
        assert.deepEqual(values, expected, `${id} 的 bug 表状态同步`)
      }
    })],
    ['挂起锚点：老任务没有 parkedAt 时同态回写补上锚点；从待确认转阻塞算新一轮等待，锚点重起、轮次 +1（变异补测 10-24）', () => withStore(async (store) => {
      const sendMessage = async () => ({ ok: true })
      store.upsert({ id: 'legacy', ...running({ status: 'blocked' }) })
      await handleStatusUpdate({ ...stubs, store, id: 'legacy', status: 'blocked', result: 'x', sendMessage })
      assert.ok(store.get('legacy').parkedAt, '老挂起任务补上锚点，催办才有起点')
      assert.equal(store.get('legacy').waitRound, 1)
      store.upsert({ id: 'moved', ...running({ status: 'waiting_confirmation', parkedAt: '2026-01-01T00:00:00.000Z', waitRound: 1 }) })
      await handleStatusUpdate({ ...stubs, store, id: 'moved', status: 'blocked', result: 'x', sendMessage })
      assert.notEqual(store.get('moved').parkedAt, '2026-01-01T00:00:00.000Z')
      assert.equal(store.get('moved').waitRound, 2)
    })],
    ['日报任务记账：done 记已发并按完整版排清扫；失败且群里要的 → 私信日报接收人带失败原因；定时日报失败 / running 不私信（变异补测 10-24）', () => withStore(async (store, own) => {
      const cli = fakeCli()
      const profile = registerRepoProfiles({ repos: { falive: { root: '/tmp/falive-react', baseRef: 'main', chatIds: ['oc_falive'], notifyChatId: 'ou_aven', ownership: { me: 'aven', meOpenIds: ['ou_aven'] }, dailyReport: { at: '19:00', to: 'ou_daily', sweep: { timeoutMinutes: 90 } } } } }).get('falive')
      const docPath = join(own, 'Falive日报-2026-10-15-完整版.md')
      writeFileSync(docPath, '# 日报\n\n## 三、需要再跟进的工作\n\n| 事项 | 说明 | 负责人 |\n|---|---|---|\n| 发邮件部署 pre | 还没部署 | **aven** |\n')
      const daily = (date, extra = {}) => store.upsert(buildDailyReportTask({ profile, date, reportNow: new Date(`${date}T19:00:00`), ...extra }))
      const update = (task, status, extra = {}) => handleStatusUpdate({ ...stubs, store, runtimeDir: own, id: task.id, status, epoch: 0, sendMessage: async () => ({ ok: true }), ...extra })
      await update(daily('2026-10-15'), 'done', { result: '日报已发', payload: { date: '2026-10-15', doc: { path: docPath, url: 'https://doc' } } })
      assert.equal(readDailyReportState(own).falive, '2026-10-15')
      assert.ok(store.get('sweep-falive-20261015'), 'done 时按完整版日报排清扫任务')
      await update(daily('2026-10-16', { requestChatId: 'oc_falive' }), 'running')
      assert.deepEqual(cli.calls('+messages-send'), [], 'running 不是失败，不私信')
      await update(daily('2026-10-17'), 'failed', { result: 'probe down' })
      assert.deepEqual(cli.calls('+messages-send'), [], '定时日报失败不私信（定时补发自己会重试）')
      await update(daily('2026-10-18', { requestChatId: 'oc_falive' }), 'failed', { result: 'probe down' })
      const notices = cli.calls('+messages-send')
      assert.equal(notices.length, 1)
      assert.ok(notices[0].includes('--user-id ou_daily'), '发给日报接收人（dailyReport.to 优先于 notifyChatId）')
      assert.ok(notices[0].includes('群里要的今天日报没发出去：probe down'))
      assert.equal(readDailyReportState(own).falive, '2026-10-15', '失败不记已发')
      assert.equal(store.get('sweep-falive-20261018'), undefined, '失败不排清扫')
    })],
    ['跑完带话题补充再跑一轮：终态才回队（代次 +1），ignored 只清标记不再跑，running 不动（变异补测 10-24）', () => withStore(async (store) => {
      fakeCli()
      const sendMessage = async () => ({ ok: true, messageId: 'om_r' })
      store.upsert({ id: 'done', ...running({ rerunAfterDone: true }) })
      await handleStatusUpdate({ ...stubs, store, id: 'done', status: 'done', result: '完成', epoch: 0, sendMessage })
      assert.equal(store.get('done').status, 'queued')
      assert.equal(store.get('done').epoch, 1)
      assert.equal(store.get('done').rerunCount, 1)
      assert.equal(store.get('done').rerunAfterDone, undefined)
      store.upsert({ id: 'ign', ...running({ rerunAfterDone: true }) })
      await handleStatusUpdate({ ...stubs, store, id: 'ign', status: 'ignored', epoch: 0, sendMessage })
      assert.equal(store.get('ign').status, 'ignored')
      assert.equal(store.get('ign').epoch, 0)
      assert.equal(store.get('ign').rerunAfterDone, undefined)
      store.upsert({ id: 'run', ...running({ rerunAfterDone: true }) })
      await handleStatusUpdate({ ...stubs, store, id: 'run', status: 'running', epoch: 0, sendMessage })
      assert.equal(store.get('run').status, 'running')
      assert.equal(store.get('run').epoch, 0)
      assert.equal(store.get('run').rerunAfterDone, true)
    })],
    ['外部群任务 done：台账触及条目标 applied 并记分支，只读查询（status）不推进；人话消息按本代 epoch 登记回执；没有台账条目照常投递（变异补测 10-24）', () => withStore(async (store) => {
      registerRepoProfiles({ repos: { falive: { root: '/tmp/falive-react', baseRef: 'main', chatIds: ['oc_falive'], notifyChatId: 'ou_aven' } } })
      const item = (id) => ({ id, doc: '对接', code: id.split('#')[1], title: id, status: 'answered', updatedAt: '2026-01-01T00:00:00Z', lastEvent: null })
      saveLedger('falive', { items: { '对接#A1': item('对接#A1'), '对接#A2': item('对接#A2') }, events: [] })
      try {
        const human = (id, extra) => ({ id, ...running({ repo: 'falive', chatId: 'oc_falive', ...extra }) })
        store.upsert(human('fix', { epoch: 2, branch: 'lark/falive-fix', commandType: 'fix', ledgerItems: [{ id: '对接#A1' }] }))
        const fixed = await handleStatusUpdate({ ...stubs, store, id: 'fix', status: 'done', result: '已完成。', epoch: 2, deliverRepo: async () => ({ ok: true, messageId: 'om_fix' }) })
        assert.deepEqual(fixed, { ok: true, humanDelivery: true, delivered: true })
        store.upsert(human('ask', { commandType: 'status', ledgerItems: [{ id: '对接#A2' }] }))
        await handleStatusUpdate({ ...stubs, store, id: 'ask', status: 'done', result: '查询完成。', epoch: 0 })
        store.upsert(human('plain', {}))
        const plain = await handleStatusUpdate({ ...stubs, store, id: 'plain', status: 'done', result: '已完成。', epoch: 0 })
        assert.equal(plain.humanDelivery, true)
        const ledger = loadLedger('falive')
        assert.equal(ledger.items['对接#A1'].status, 'applied')
        assert.equal(ledger.items['对接#A1'].lastEvent.note, '工单 fix 已做，分支 lark/falive-fix')
        assert.equal(ledger.items['对接#A2'].status, 'answered', '只读查询不推进台账')
        assert.deepEqual(store.get('fix').receipts.at(-1).epoch, 2)
        assert.equal(store.findByReceiptMessageId('om_fix')?.id, 'fix')
      } finally {
        rmSync(join(process.env.LARK_RUNTIME_DIR, 'lark-ledger'), { recursive: true, force: true })
      }
    })],
    ['同一终态重复回写且留有本轮 pending：已送达过 → 只清 pending 不重发；没送达 → 重发成功后结算 pending（变异补测 10-24）', () => withStore(async (store) => {
      const pending = (id) => ({ status: 'done', result: '完成', epoch: 0, idempotencyKey: `${id}-e0-done`, attempts: 1, gaveUp: false })
      let sends = 0
      const sendMessage = async () => { sends += 1; return { ok: true, messageId: 'om_again' } }
      store.upsert({ id: 'seen', ...running({ status: 'result_pending_receipt' }), pendingReceipt: pending('seen'), lastDeliveredReceipt: { idempotencyKey: 'seen-e0-done', status: 'done', epoch: 0, deliveredAt: '2026-01-01T00:00:00Z' } })
      const seen = await handleStatusUpdate({ ...stubs, store, id: 'seen', status: 'done', result: '完成', epoch: 0, sendMessage })
      assert.equal(seen.receiptAlreadyDelivered, true)
      assert.equal(sends, 0)
      assert.equal(store.get('seen').pendingReceipt, undefined)
      store.upsert({ id: 'again', ...running({ status: 'result_pending_receipt' }), pendingReceipt: pending('again') })
      const again = await handleStatusUpdate({ ...stubs, store, id: 'again', status: 'done', result: '完成', epoch: 0, sendMessage })
      assert.deepEqual(again, { ok: true })
      assert.equal(sends, 1)
      assert.equal(store.get('again').pendingReceipt, undefined)
      assert.equal(store.get('again').status, 'done')
      assert.equal(store.get('again').lastDeliveredReceipt?.idempotencyKey, 'again-e0-done')
    })],
  ]))

  it('await 期间任务被交还队列（epoch+1）：回写 409，任务仍是 queued、result 不被覆盖', () => runSteps([
    ['await 期间任务被交还队列（epoch+1）：回写 409，任务仍是 queued、result 不被覆盖', async () => {
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
    }],
    ['await 期间被同话题收尾（status 变、epoch 不变）也拒绝 409、不复活；409 说明写清前后代次与状态（变异补测 10-24）', () => withStore(async (store) => {
      store.upsert({ id: 't', ...running({ status: 'waiting_confirmation', epoch: 3 }) })
      const outcome = await handleStatusUpdate({ ...deps(store, { onResolve: async () => { store.supersede({ id: 't', bySiblingId: 'sib' }); return null } }), id: 't', status: 'blocked', result: '等补料', epoch: 3 })
      assert.equal(outcome.code, 409)
      assert.equal(outcome.error, 'task changed during status update: epoch 3→3, status waiting_confirmation→superseded')
      assert.equal(store.get('t').status, 'superseded')
      const stale = await handleStatusUpdate({ ...deps(store), id: 't', status: 'done', epoch: 1 })
      assert.equal(stale.error, 'stale epoch: got 1, current 3')
    })],
  ]))
})
