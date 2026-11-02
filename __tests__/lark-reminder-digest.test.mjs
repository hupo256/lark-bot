/**
 * 挂起催办（lark-parked-reminder）与每日「等你决定」汇总（lark-daily-digest）（11-01，变异补测）：
 * 永不催的每条豁免、催办轮次默认值与锚点回落、真实任务库上两轮催办的出口 / 幂等键 / 先记后发；
 * 汇总四组的每个条件与边界（24h / 4h 恰好不算）、同一天只发一次、断点文件读写、定时 tick 的时间比较与 at 校验、疑似过期合并知会。
 * 一个 it 合并全部段（测试棘轮）。断点文件与回复义务都落临时目录：LARK_RUNTIME_DIR / LARK_OBLIGATIONS_DIR 先设、lib 用动态 import（同 lark-run-report）。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { eachCase, runSteps } from './support/steps.mjs'

const dir = mkdtempSync(join(tmpdir(), 'lark-reminder-digest-'))
process.env.LARK_RUNTIME_DIR = join(dir, 'runtime')
process.env.LARK_OBLIGATIONS_DIR = join(dir, 'obligations')
const { defaultRemindRounds, isNeverNagged, parkedReminderRound, remindParkedTasks } = await import('../lib/lark-parked-reminder.mjs')
const { collectDigest, expireSuspectedAndNotify, renderDigest, runDailyDigest, startDailyDigest } = await import('../lib/lark-daily-digest.mjs')
const { createTaskStore } = await import('../lib/lark-task-store.mjs')
const { noteAck, noteHeld } = await import('../lib/lark-reply-obligation.mjs')
const { localHHMM } = await import('../lib/lark-outbox.mjs')

const HOUR = 3600_000
// 本地时间 2026-11-02 10:00：汇总的「今天」按本地日期算，定时 tick 也比本地 HH:MM。
const NOW = new Date(2026, 10, 2, 10, 0, 0).getTime()
const TODAY = new Date(NOW).toLocaleDateString('sv-SE')
const ago = (ms) => new Date(NOW - ms).toISOString()
const pick = (obj, keys) => Object.fromEntries(keys.map((key) => [key, obj?.[key]]))
// 群里发起、改码类的普通任务：每条豁免都从它翻一个字段。
const plainTask = (extra = {}) => ({ id: 't', status: 'blocked', chatId: 'oc_1', chatType: 'group', intake: { trigger: 'mention' }, contract: { deliverable: 'change' }, ...extra })
const silent = async (fn) => {
  const { log, error } = console
  const logs = []
  console.log = (...args) => logs.push(args.join(' '))
  console.error = (...args) => logs.push(args.join(' '))
  try {
    return await fn(logs)
  } finally {
    console.log = log
    console.error = error
  }
}
// 记录调用、按预置返回的出口桩
const stub = (result = { ok: true, messageId: 'om_sent' }) => {
  const calls = []
  const fn = async (args) => {
    calls.push(args)
    return typeof result === 'function' ? result(args) : result
  }
  return { fn, calls }
}
// collectDigest：这条任务落进哪些组
const groupsOf = (task, { chatNames } = {}) => {
  const digest = collectDigest({ store: { list: () => [task] }, now: NOW, chatNames })
  return Object.entries(digest).filter(([, items]) => items.length).map(([key]) => key).sort()
}

describe('挂起催办与每日汇总', () => {
  it('isNeverNagged / parkedReminderRound / remindParkedTasks / collectDigest / renderDigest / runDailyDigest / startDailyDigest / expireSuspectedAndNotify', () => runSteps([
    ['isNeverNagged：群里发起的改码任务要催；契约非 change / 运维 / 私信（chatType、trigger、ou_ chatId）/ 负责人私聊指示 / 疑似 / 追问 / 轮次 99 永不催', () => eachCase([
      { name: '空任务 → 不催', task: null, want: true },
      { name: '群里 @ 的改码任务 → 催', task: plainTask(), want: false },
      { name: '没有契约（老任务）→ 当 change 催', task: plainTask({ contract: null }), want: false },
      { name: '没有 chatId 的群任务 → 催', task: plainTask({ chatId: undefined }), want: false },
      { name: '轮次 98 → 还在正常轮次', task: plainTask({ parkedRemindedRound: 98 }), want: false },
      { name: '契约 answer → 不催', task: plainTask({ contract: { deliverable: 'answer' } }), want: true },
      { name: '契约 verification → 不催', task: plainTask({ contract: { deliverable: 'verification' } }), want: true },
      { name: '契约 ops → 不催', task: plainTask({ contract: { deliverable: 'ops' } }), want: true },
      { name: '契约 record → 不催', task: plainTask({ contract: { deliverable: 'record' } }), want: true },
      { name: 'commandType ops → 不催', task: plainTask({ commandType: 'ops' }), want: true },
      { name: 'chatType p2p → 不催', task: plainTask({ chatType: 'p2p' }), want: true },
      { name: 'intake.trigger dm → 不催', task: plainTask({ intake: { trigger: 'dm' } }), want: true },
      { name: 'chatId 是 ou_ 私信 → 不催', task: plainTask({ chatId: 'ou_aven' }), want: true },
      { name: '负责人私聊指示（privateOrigin）→ 不催', task: plainTask({ privateOrigin: { anchorId: 'om_1' } }), want: true },
      { name: '疑似 → 不催', task: plainTask({ suspected: true }), want: true },
      { name: '已追问（askBack）→ 不催', task: plainTask({ askBack: true }), want: true },
      { name: '轮次 99（疑似标记）→ 不催', task: plainTask({ parkedRemindedRound: 99 }), want: true },
    ], ({ task, want }) => assert.equal(isNeverNagged(task), want))],
    ['parkedReminderRound：默认最多 2 轮（LARK_PARKED_REMIND_ROUNDS 没设）、每轮 4h；锚点 parkedAt 优先于 updatedAt', () => {
      assert.equal(defaultRemindRounds, 2)
      const round = (task, extra = {}) => parkedReminderRound({ task, now: NOW, ...extra })
      assert.equal(round({ status: 'blocked', parkedAt: ago(4 * HOUR) }), 1)
      assert.equal(round({ status: 'blocked', parkedAt: ago(8 * HOUR) }), 2)
      assert.equal(round({ status: 'blocked', parkedAt: ago(12 * HOUR) }), 0, '第 3 轮超过默认 2 轮 → 不催')
      assert.equal(round({ status: 'blocked', parkedAt: ago(12 * HOUR) }, { rounds: 3 }), 3)
      assert.equal(round({ status: 'blocked', parkedAt: ago(5 * HOUR), updatedAt: ago(1 * HOUR) }), 1, '催办会刷新 updatedAt，锚点只认 parkedAt')
      assert.equal(round({ status: 'waiting_confirmation', updatedAt: ago(5 * HOUR) }), 1, '老任务没 parkedAt 回落 updatedAt')
      assert.equal(round({ status: 'blocked' }), 0)
      assert.equal(round({ status: 'blocked', parkedAt: 'not-a-date' }), 0, '锚点解析不出来 → 0，不是 NaN')
      assert.equal(round({ status: 'blocked', parkedAt: 0 }, { rounds: Infinity }), 0, '纪元 0 不算锚点，轮次上限再大也不催')
    }],
    ['remindParkedTasks（真实任务库）：第 1 轮群里 @ 提单人说缺什么、第 2 轮私信负责人；轮次先落盘再发；幂等键 id-e<epoch>-rm<轮>；永不催 / 没到点的跳过；同一时刻再跑不重复', async () => {
      const tasksDir = join(dir, 'tasks-remind')
      const store = createTaskStore({ tasksDir })
      const config = { notifyOpenId: 'ou_aven' }
      store.upsert({ id: 't1', status: 'blocked', chatId: 'oc_1', chatType: 'group', operator: 'ou_op', epoch: 2, summary: '补充字段', parkedAt: ago(4.5 * HOUR), contract: { deliverable: 'change' }, outcome: { blockers: ['缺 PRD', '缺设计稿'] } })
      store.upsert({ id: 't2', status: 'waiting_confirmation', chatId: 'oc_2', chatType: 'group', operator: 'ou_op', summary: '改按钮', parkedAt: ago(9 * HOUR), parkedRemindedRound: 1 })
      store.upsert({ id: 't3', status: 'blocked', chatId: 'oc_1', chatType: 'group', summary: '问一句', parkedAt: ago(9 * HOUR), contract: { deliverable: 'answer' } })
      store.upsert({ id: 't4', status: 'blocked', chatId: 'oc_1', chatType: 'group', summary: '刚挂起', parkedAt: ago(1 * HOUR) })
      const persistedRound = (id) => createTaskStore({ tasksDir }).get(id)?.parkedRemindedRound
      const seen = {}
      const sendReply = stub((args) => {
        seen.replyPersisted = persistedRound(args.task.id)
        return { ok: true, messageId: 'om_r1' }
      })
      const sendPrincipalNote = stub((args) => {
        seen.notePersisted = persistedRound(args.taskId)
        return { ok: false, reason: '没配' }
      })
      const run = () => silent(() => remindParkedTasks({ config, store, now: NOW, deps: { sendReply: sendReply.fn, sendPrincipalNote: sendPrincipalNote.fn, chatNames: { oc_2: '支付群' } } }))
      await run()
      assert.equal(sendReply.calls.length, 1)
      assert.equal(sendReply.calls[0].config, config)
      assert.equal(sendReply.calls[0].store, store)
      assert.equal(sendReply.calls[0].task.id, 't1')
      assert.deepEqual(pick(sendReply.calls[0], ['phase', 'text', 'mentions', 'idempotencyKey']), { phase: 'reminder', text: '「补充字段」还在等你补：缺 PRD。补上回我一句就继续。', mentions: [{ openId: 'ou_op', name: '' }], idempotencyKey: 't1-e2-rm1' })
      assert.equal(sendPrincipalNote.calls.length, 1)
      assert.equal(sendPrincipalNote.calls[0].config, config)
      assert.deepEqual(pick(sendPrincipalNote.calls[0], ['text', 'taskId', 'kind', 'idempotencyKey']), { text: '⏰ 「改按钮」（支付群）等了 8 小时没人补材料，我不再催群里了。要关掉回「取消任务 t2」。', taskId: 't2', kind: 'reminder', idempotencyKey: 't2-e0-rm2' })
      assert.deepEqual(seen, { replyPersisted: 1, notePersisted: 2 }, '发之前轮次已落盘（发失败也不重发）')
      assert.deepEqual(store.list().map((task) => [task.id, task.parkedRemindedRound]).sort(), [['t1', 1], ['t2', 2], ['t3', undefined], ['t4', undefined]])
      await run()
      assert.equal(sendReply.calls.length + sendPrincipalNote.calls.length, 2, '同一时刻再跑：本轮已催过，不重复')
    }],
    ['collectDigest：疑似 = suspected 且 waiting_confirmation；等材料 = 挂起 且 非追问 且 契约 change（缺省算 change）且 挂起超 24h（恰 24h 不算，parkedAt 优先 updatedAt）；答应了没结论 = ackedInGroup 且 活动态 且 非挂起 且 超 4h（恰 4h 不算）', () => eachCase([
      { name: '疑似 + waiting_confirmation → 疑似', task: { id: 'a', suspected: true, status: 'waiting_confirmation', parkedAt: ago(30 * HOUR) }, want: ['suspected'] },
      { name: '疑似 + blocked → 不算疑似，按等材料', task: { id: 'a', suspected: true, status: 'blocked', parkedAt: ago(30 * HOUR) }, want: ['parked'] },
      { name: '非疑似 waiting_confirmation 超 24h → 等材料', task: { id: 'a', status: 'waiting_confirmation', parkedAt: ago(30 * HOUR) }, want: ['parked'] },
      { name: 'blocked 超 24h、没契约 → 等材料', task: { id: 'a', status: 'blocked', parkedAt: ago(30 * HOUR) }, want: ['parked'] },
      { name: 'blocked 超 24h、契约 change → 等材料', task: { id: 'a', status: 'blocked', parkedAt: ago(30 * HOUR), contract: { deliverable: 'change' } }, want: ['parked'] },
      { name: 'blocked 超 24h、契约 answer → 不进', task: { id: 'a', status: 'blocked', parkedAt: ago(30 * HOUR), contract: { deliverable: 'answer' } }, want: [] },
      { name: 'blocked 超 24h、已追问 → 不进', task: { id: 'a', status: 'blocked', parkedAt: ago(30 * HOUR), askBack: true }, want: [] },
      { name: 'blocked 刚 1h → 不进', task: { id: 'a', status: 'blocked', parkedAt: ago(1 * HOUR) }, want: [] },
      { name: 'blocked 恰好 24h → 不进', task: { id: 'a', status: 'blocked', parkedAt: ago(24 * HOUR) }, want: [] },
      { name: 'blocked 24h 多 1 秒 → 等材料', task: { id: 'a', status: 'blocked', parkedAt: ago(24 * HOUR + 1000) }, want: ['parked'] },
      { name: 'parkedAt 30h 前、updatedAt 1h 前 → 认 parkedAt', task: { id: 'a', status: 'blocked', parkedAt: ago(30 * HOUR), updatedAt: ago(1 * HOUR) }, want: ['parked'] },
      { name: '没 parkedAt 回落 updatedAt', task: { id: 'a', status: 'blocked', updatedAt: ago(30 * HOUR) }, want: ['parked'] },
      { name: '挂起态没任何时间 → 不进', task: { id: 'a', status: 'blocked' }, want: [] },
      { name: 'queued 很久 → 不是挂起', task: { id: 'a', status: 'queued', updatedAt: ago(30 * HOUR), createdAt: ago(30 * HOUR) }, want: [] },
      { name: '答应了 5h 没结论（running）→ 没结论', task: { id: 'a', status: 'running', ackedInGroup: true, ackedAt: ago(5 * HOUR) }, want: ['overdue'] },
      { name: '答应了恰好 4h → 不进', task: { id: 'a', status: 'running', ackedInGroup: true, ackedAt: ago(4 * HOUR) }, want: [] },
      { name: '答应了 4h 多 1 秒 → 没结论', task: { id: 'a', status: 'queued', ackedInGroup: true, ackedAt: ago(4 * HOUR + 1000) }, want: ['overdue'] },
      { name: '答应了才 1h → 不进', task: { id: 'a', status: 'running', ackedInGroup: true, ackedAt: ago(1 * HOUR) }, want: [] },
      { name: '答应了但没 ackedAt → 不进', task: { id: 'a', status: 'running', ackedInGroup: true }, want: [] },
      { name: '没答应过（ackedInGroup 假）5h → 不进', task: { id: 'a', status: 'running', ackedAt: ago(5 * HOUR) }, want: [] },
      { name: '答应了但已 done → 不进', task: { id: 'a', status: 'done', ackedInGroup: true, ackedAt: ago(5 * HOUR) }, want: [] },
      // 11-02 复核：failed 在控制通道里算活动态（可结单）却从不被 prune，负责人早收到 ⛔ 私信，不能天天列成「没结论」。
      { name: '答应了但已 failed（负责人已收 ⛔）→ 不进', task: { id: 'a', status: 'failed', ackedInGroup: true, ackedAt: ago(5 * HOUR) }, want: [] },
      { name: '答应了 5h 没结论（verifying）→ 没结论', task: { id: 'a', status: 'verifying', ackedInGroup: true, ackedAt: ago(5 * HOUR) }, want: ['overdue'] },
      { name: '答应了后挂起（blocked 1h）→ 不算没结论', task: { id: 'a', status: 'blocked', ackedInGroup: true, ackedAt: ago(5 * HOUR), parkedAt: ago(1 * HOUR) }, want: [] },
      { name: '扣下的群回复（义务 held）→ 扣下', task: { id: 'h1', status: 'running', chatId: 'oc_h' }, held: true, want: ['held'] },
      { name: '义务只是 acked → 不算扣下', task: { id: 'h2', status: 'running', chatId: 'oc_h' }, acked: true, want: [] },
    ], ({ task, held, acked, want }) => {
      if (held) noteHeld({ task, text: '草稿', now: NOW })
      if (acked) noteAck({ task, text: '收到', now: NOW })
      assert.deepEqual(groupsOf(task), want)
    })],
    ['collectDigest 条目：标题（没摘要用 id）/ 群名表叫法 / 时间认 parkedAt > ackedAt > createdAt', () => {
      const parked = { id: 'p1', status: 'blocked', chatId: 'oc_1', summary: '补充字段', parkedAt: ago(30 * HOUR), createdAt: ago(40 * HOUR) }
      assert.deepEqual(collectDigest({ store: { list: () => [parked] }, now: NOW, chatNames: { oc_1: '支付群' } }).parked, [{ headline: '补充字段', chatLabel: '支付群', time: localHHMM(ago(30 * HOUR)) }])
      const overdue = { id: 'o1', status: 'running', chatId: 'oc_1', ackedInGroup: true, ackedAt: ago(5 * HOUR), createdAt: ago(6 * HOUR) }
      assert.deepEqual(collectDigest({ store: { list: () => [overdue] }, now: NOW }).overdue, [{ headline: 'o1', chatLabel: 'oc_1', time: localHHMM(ago(5 * HOUR)) }])
      assert.notEqual(localHHMM(ago(5 * HOUR)), localHHMM(ago(6 * HOUR)))
      assert.notEqual(localHHMM(ago(30 * HOUR)), localHHMM(ago(40 * HOUR)))
      // 11-02 复核：扣下的草稿按义务去重——私聊指示任务（privateOrigin.anchorId）与被锚的群消息共用一份义务，只列一条；别的群的同 id 义务不混
      const anchor = { id: 'om_held', status: 'running', chatId: 'oc_d', summary: '群里那条', createdAt: ago(3 * HOUR) }
      const instruction = { id: 'om_dm', status: 'running', chatId: 'oc_d', privateOrigin: { anchorId: 'om_held', anchorHead: '群里那条' }, summary: '私聊指示', createdAt: ago(2 * HOUR) }
      const otherChat = { id: 'om_held', status: 'running', chatId: 'oc_e', summary: '另一群', createdAt: ago(1 * HOUR) }
      noteHeld({ task: anchor, text: '草稿', now: NOW })
      noteHeld({ task: otherChat, text: '草稿', now: NOW })
      assert.deepEqual(collectDigest({ store: { list: () => [instruction, anchor, otherChat] }, now: NOW }).held, [{ headline: '群里那条', chatLabel: 'oc_d', time: localHHMM(ago(2 * HOUR)) }, { headline: '另一群', chatLabel: 'oc_e', time: localHHMM(ago(1 * HOUR)) }])
    }],
    ['renderDigest：全空返回空串（不发）；有条目按组列', () => {
      assert.equal(renderDigest({}), '')
      assert.equal(renderDigest({ parked: [{ headline: '补充字段', chatLabel: '支付群', time: '09:00' }] }), '等你决定的 1 条\n等材料超 24h：\n- 补充字段（支付群）· 09:00')
    }],
    ['runDailyDigest：同一天只发一次；没有条目不发也不记；发成功才记 lastSentDate；幂等键 digest-YYYYMMDD', async () => {
      const store = { list: () => [{ id: 's1', suspected: true, status: 'waiting_confirmation', chatId: 'oc_1', summary: '可能是你的', parkedAt: ago(2 * HOUR) }] }
      const config = { notifyOpenId: 'ou_aven' }
      const sent = stub({ ok: true, messageId: 'om_d' })
      const save = stub(undefined)
      assert.deepEqual(await runDailyDigest({ config, store, now: NOW, send: sent.fn, state: { lastSentDate: TODAY }, save: save.fn }), { sent: false, reason: 'already sent today' })
      assert.equal(sent.calls.length + save.calls.length, 0)
      assert.deepEqual(await runDailyDigest({ config, store, now: NOW, send: sent.fn, state: { lastSentDate: '2026-11-01', other: 1 }, save: save.fn, chatNames: { oc_1: '支付群' } }), { sent: true, reason: null })
      assert.equal(sent.calls.length, 1)
      assert.equal(sent.calls[0].config, config)
      assert.equal(sent.calls[0].store, store)
      assert.deepEqual(pick(sent.calls[0], ['text', 'kind', 'idempotencyKey']), { text: `等你决定的 1 条\n疑似：\n- 可能是你的（支付群）· ${localHHMM(ago(2 * HOUR))}`, kind: 'digest', idempotencyKey: `digest-${TODAY.replace(/-/g, '')}` })
      assert.deepEqual(save.calls, [{ lastSentDate: TODAY, other: 1 }])
      assert.deepEqual(await runDailyDigest({ config, store: { list: () => [] }, now: NOW, send: sent.fn, state: {}, save: save.fn }), { sent: false, reason: 'nothing to decide' })
      assert.equal(sent.calls.length + save.calls.length, 2, '没有条目：不发、不记')
      const failed = stub({ ok: false, reason: '网络' })
      assert.deepEqual(await runDailyDigest({ config, store, now: NOW, send: failed.fn, state: {}, save: save.fn }), { sent: false, reason: '网络' })
      assert.equal(save.calls.length, 1, '发失败不记已发')
    }],
    ['runDailyDigest 断点文件：缺省 state / save 读写 runtime/lark-digest-state.json，记过今天第二次就不发', async () => {
      const store = { list: () => [{ id: 's1', suspected: true, status: 'waiting_confirmation', chatId: 'oc_1', summary: '可能是你的', parkedAt: ago(2 * HOUR) }] }
      const statePath = join(dir, 'runtime', 'lark-digest-state.json')
      assert.equal(existsSync(statePath), false)
      const sent = stub({ ok: true, messageId: 'om_d' })
      assert.deepEqual(await runDailyDigest({ config: {}, store, now: NOW, send: sent.fn }), { sent: true, reason: null })
      assert.deepEqual(JSON.parse(readFileSync(statePath, 'utf8')), { lastSentDate: TODAY })
      assert.deepEqual(await runDailyDigest({ config: {}, store, now: NOW, send: sent.fn }), { sent: false, reason: 'already sent today' })
      assert.equal(sent.calls.length, 1)
    }],
    ['startDailyDigest：enabled=false 不起定时器；at 只认 HH:MM（否则 09:30）；本地时间到点（含恰好到点）才跑、没到不跑；run 抛错只记日志', async () => {
      const off = startDailyDigest({ config: { digest: { enabled: false } }, store: {} })
      assert.equal(typeof off.stop, 'function')
      assert.equal(off.tick, undefined)
      off.stop()
      const RealDate = Date
      let fakeNow = NOW
      class FakeDate extends RealDate {
        constructor(...args) { super(...(args.length ? args : [fakeNow])) }
        static now() { return fakeNow }
      }
      globalThis.Date = FakeDate
      const started = []
      try {
        const tickAt = async ({ digest, hhmm, run = stub(undefined) }) => {
          const [h, m] = hhmm.split(':').map(Number)
          fakeNow = new RealDate(2026, 10, 2, h, m, 5).getTime()
          const config = digest === undefined ? {} : { digest }
          const handle = startDailyDigest({ config, store: { list: () => [] }, run: run.fn, intervalMs: 60 * 60_000 })
          started.push(handle)
          assert.equal(typeof handle.tick, 'function')
          handle.tick()
          await new Promise((resolve) => setImmediate(resolve))
          return { calls: run.calls, config }
        }
        await eachCase([
          { name: 'at 09:30，本地 09:30 恰好到点 → 跑', digest: { at: '09:30' }, hhmm: '09:30', runs: 1 },
          { name: 'at 09:30，本地 09:29 → 不跑', digest: { at: '09:30' }, hhmm: '09:29', runs: 0 },
          { name: 'at 09:30，本地 11:00 过点 → 跑', digest: { at: '09:30' }, hhmm: '11:00', runs: 1 },
          { name: 'at 00:00，本地 09:29 → 跑（不是缺省 09:30）', digest: { at: '00:00' }, hhmm: '09:29', runs: 1 },
          { name: 'at 23:59，本地 11:00 → 不跑', digest: { at: '23:59' }, hhmm: '11:00', runs: 0 },
          { name: 'at 不合法（9:30）→ 按 09:30：09:29 不跑', digest: { at: '9:30' }, hhmm: '09:29', runs: 0 },
          { name: 'at 不合法 → 按 09:30：09:30 跑', digest: { at: '9:30' }, hhmm: '09:30', runs: 1 },
          { name: '没配 digest → 按 09:30：09:31 跑', digest: undefined, hhmm: '09:31', runs: 1 },
        ], async ({ digest, hhmm, runs }) => {
          const { calls, config } = await tickAt({ digest, hhmm })
          assert.equal(calls.length, runs)
          if (runs) assert.deepEqual(pick(calls[0], ['config', 'now']), { config, now: fakeNow })
        })
        const boom = { fn: async () => { throw new Error('boom') }, calls: [] }
        const logs = await silent(async (lines) => { await tickAt({ digest: { at: '09:30' }, hhmm: '10:00', run: boom }); return lines })
        assert.deepEqual(logs, ['[lark-gateway] 日汇总异常：boom'])
      } finally {
        globalThis.Date = RealDate
        started.forEach((handle) => handle.stop())
      }
    }],
    ['expireSuspectedAndNotify：有过期的合并私信一条（幂等键按 UTC 小时）；没过期 / 任务库不支持 → 不发', async () => {
      const tasks = [{ id: 'x1', summary: '看看注册', chatId: 'oc_1' }, { id: 'x2', summary: '查日志', chatId: 'oc_2' }]
      const sent = stub({ ok: true, messageId: 'om_x' })
      const seen = []
      const store = { expireSuspected: (args) => { seen.push(args); return tasks } }
      assert.deepEqual(await silent(() => expireSuspectedAndNotify({ config: {}, store, now: NOW, send: sent.fn, chatNames: { oc_1: '支付群' } })), { expired: 2 })
      assert.deepEqual(seen, [{ now: NOW }])
      assert.equal(sent.calls.length, 1)
      assert.equal(sent.calls[0].store, store)
      assert.deepEqual(pick(sent.calls[0], ['text', 'kind', 'idempotencyKey']), { text: '🧹 这 2 条疑似 48 小时没人认领，已关掉：\n- 看看注册（支付群）\n- 查日志（oc_2）', kind: 'suspected_expired', idempotencyKey: `sus-exp-${new Date(NOW).toISOString().slice(0, 13)}` })
      assert.deepEqual(await expireSuspectedAndNotify({ config: {}, store: { expireSuspected: () => [] }, now: NOW, send: sent.fn }), { expired: 0 })
      assert.deepEqual(await expireSuspectedAndNotify({ config: {}, store: {}, now: NOW, send: sent.fn }), { expired: 0 })
      assert.equal(sent.calls.length, 1)
    }],
  ]))
})
