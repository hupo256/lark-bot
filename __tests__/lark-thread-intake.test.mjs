import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { runSteps } from './support/steps.mjs'

import { applySupplementAddressing, isCompleteMessage, resolveIntakeLane, resolveIntakeNotBefore, resolveRepoAddressing } from '../lib/lark-ingest.mjs'
import { createTaskStore } from '../lib/lark-task-store.mjs'

const withStore = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'lark-thread-intake-'))
  try {
    return fn(createTaskStore({ tasksDir: dir, leaseMs: 60_000 }))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const received = (store, extra = {}) => store.upsert({
  id: 'omt_thread1',
  source: 'lark',
  repo: 'falive',
  project: 'FALIVE',
  chatId: 'oc_x',
  threadRootId: 'omt_thread1',
  text: 'x',
  status: 'received',
  intake: { required: true, trigger: 'task_mention', notBefore: null },
  createdAt: new Date().toISOString(),
  ...extra,
})

describe('外部群任务入口：准确优先', () => {
  // 10-23 #74：forMe=true 的 medium 也直接开跑（见 lark-task-contract.test），疑似只剩归属拿不准 + medium；对接答复前端不用做的只记一笔
  it('resolveIntake 分类结论：仓库任务疑似 / 静默 / 开跑，fameex、对接文档（#53）、负责人本人、提问带文档（#38）', () => {
    // 单条用例表：每行一个独立 store，seed 建任务 → 领取 → 分类 → 核对结论
    const cases = [
      {
        name: 'fameex（无 repo）沿用 medium 即可开跑',
        id: 'om_f',
        seed: (store) => store.upsert({ id: 'om_f', source: 'lark', chatId: 'oc_f', text: 'x', status: 'received', intake: { required: true }, createdAt: new Date().toISOString() }),
        classification: { decision: 'bug', confidence: 'medium', summary: 's', reason: 'r' },
        want: { actionable: true },
      },
      {
        // 原 describe「对接文档只认 @ 机器人带来的（教训 #53）」
        name: '@ 机器人带文档附件：分类 ignore 也进执行器（api 命令），归属交分析判',
        id: 'omt_doc',
        seed: (store) => received(store, { id: 'omt_doc', threadRootId: null, addressedToBot: true, attachments: [{ type: 'file', fileName: 'PM-3217-对接文档.md', localPath: '/tmp/x.md' }] }),
        classification: { decision: 'ignore', confidence: 'high', forMe: false, summary: 's', reason: 'r' },
        want: { actionable: true, commandType: 'api' },
      },
      {
        name: '没 @ 机器人的文档：按分类走，不再一律进执行器',
        id: 'omt_doc2',
        seed: (store) => received(store, { id: 'omt_doc2', threadRootId: null, attachments: [{ type: 'file', fileName: '任务中心-后端问询清单.md', localPath: '/tmp/y.md' }] }),
        classification: { decision: 'ignore', confidence: 'high', forMe: false, summary: 's', reason: 'r' },
        want: { actionable: false },
      },
      {
        // 原 describe「负责人本人 @ 机器人」
        name: 'medium 也直接开跑，不挂疑似',
        id: 'omt_me',
        seed: (store) => received(store, { id: 'omt_me', threadRootId: null, addressedToBot: true, fromPrincipal: true }),
        classification: { decision: 'requirement', confidence: 'medium', forMe: true, summary: 's', reason: 'r' },
        want: { actionable: true },
      },
      {
        // 原 describe「提问带对接文档附件（教训 #38）」
        name: '分类为 question 时走只读作答（status），不因话题里带文档被当成 api 改代码工单',
        id: 'omt_q_doc',
        seed: (store) => received(store, { id: 'omt_q_doc', threadRootId: 'omt_q_doc', attachments: [{ type: 'file', fileName: 'aven-后端待办-自测新增-2026-10-19.md' }] }),
        classification: { decision: 'question', confidence: 'high', forMe: true, summary: 's', reason: 'r' },
        want: { actionable: true, commandType: 'status' },
      },
      {
        name: '对接答复带文档附件仍按 api 跑',
        id: 'omt_api_doc',
        seed: (store) => received(store, { id: 'omt_api_doc', threadRootId: 'omt_api_doc', attachments: [{ type: 'file', fileName: '回复.md' }] }),
        classification: { decision: 'api_reply', confidence: 'high', forMe: true, summary: 's', reason: 'r' },
        want: { commandType: 'api' },
      },
    ]
    return runSteps([
      ['仓库 profile 的任务：归属拿不准（forMe 未给）又不到 high 挂疑似待确认且不催办；ignore 静默', () => withStore((store) => {
        received(store)
        assert.ok(store.claimById('omt_thread1'))
        let out = store.resolveIntake({ id: 'omt_thread1', epoch: 0, classification: { decision: 'bug', confidence: 'medium', summary: 's', reason: 'r' } })
        assert.equal(out.actionable, false, '归属拿不准又不到 high 不开跑')
        assert.equal(out.suspected, true, '归属拿不准又不到 high 挂疑似')
        assert.equal(out.task.status, 'waiting_confirmation')
        assert.equal(out.task.parkedRemindedRound, 99, '疑似不催办')
        assert.match(out.task.result, /疑似需要处理/)

        received(store, { id: 'omt_thread2', threadRootId: 'omt_thread2' })
        store.claimById('omt_thread2')
        out = store.resolveIntake({ id: 'omt_thread2', epoch: 0, classification: { decision: 'bug', confidence: 'high', forMe: false, summary: 's', reason: 'r' } })
        assert.equal(out.actionable, false)
        assert.equal(out.suspected, false, '别人的功能（forMe=false）静默忽略，不算疑似')
        assert.equal(out.task.status, 'ignored')

        received(store, { id: 'omt_thread3', threadRootId: 'omt_thread3' })
        store.claimById('omt_thread3')
        // 10-23 #74：对接答复要说清前端交付什么才开跑（deliverable=null 是「前端不用做、只记一笔」）
        out = store.resolveIntake({ id: 'omt_thread3', epoch: 0, classification: { decision: 'api_reply', confidence: 'high', forMe: true, deliverable: 'change', summary: 's', reason: 'r' } })
        assert.equal(out.actionable, true, '对接答复说清前端交付什么才开跑')
        assert.equal(out.task.status, 'queued')
        assert.equal(out.task.commandType, 'api')

        received(store, { id: 'omt_thread5', threadRootId: 'omt_thread5' })
        store.claimById('omt_thread5')
        out = store.resolveIntake({ id: 'omt_thread5', epoch: 0, classification: { decision: 'question', confidence: 'high', forMe: true, summary: 's', reason: 'r' } })
        assert.equal(out.actionable, true, '群里向负责人提的问题：只读代答')
        assert.equal(out.task.commandType, 'status')

        received(store, { id: 'omt_thread6', threadRootId: 'omt_thread6' })
        store.claimById('omt_thread6')
        out = store.resolveIntake({ id: 'omt_thread6', epoch: 0, classification: { decision: 'question', confidence: 'medium', forMe: true, summary: 's', reason: 'r' } })
        assert.equal(out.actionable, true, '提问只读代答，medium 也直接答')

        received(store, { id: 'omt_thread4', threadRootId: 'omt_thread4' })
        store.claimById('omt_thread4')
        out = store.resolveIntake({ id: 'omt_thread4', epoch: 0, classification: { decision: 'ignore', confidence: 'high', forMe: false, summary: 's', reason: 'r' } })
        assert.equal(out.suspected, false, 'ignore 静默')
        assert.equal(out.task.status, 'ignored')
      })],
      ...cases.map(({ name, id, seed, classification, want }) => [name, () => withStore((store) => {
        seed(store)
        store.claimById(id)
        const out = store.resolveIntake({ id, epoch: 0, classification })
        if ('actionable' in want) assert.equal(out.actionable, want.actionable, name)
        if ('commandType' in want) assert.equal(out.task.commandType, want.commandType, name)
      })]),
    ])
  })

  it('分类去抖 notBefore 未到不可领取；已了结的话题任务被新消息重开（同一 id、epoch++、重新分类、历史留痕）', () => runSteps([
    ['分类去抖：notBefore 未到不可领取', () => withStore((store) => {
      received(store, { intake: { required: true, notBefore: new Date(Date.now() + 60_000).toISOString() } })
      assert.equal(store.claimById('omt_thread1'), null, '分类去抖：notBefore 未到不可领取')
      received(store, { intake: { required: true, notBefore: new Date(Date.now() - 1000).toISOString() } })
      assert.ok(store.claimById('omt_thread1'))
    })],
    ['已了结的话题任务被新消息重开：同一 id、epoch++、重新分类、历史留痕', () => withStore((store) => {
      received(store, { status: 'ignored', intake: { required: false }, result: 'old', epoch: 2 })
      assert.equal(store.reopenForThread({ id: 'omt_thread1', supplementText: '运维更新好了' }).status, 'received', '已了结的话题任务被新消息重开')
      const task = store.get('omt_thread1')
      assert.equal(task.epoch, 3)
      assert.equal(task.intake.required, true)
      assert.equal(task.intake.trigger, 'thread_followup')
      assert.match(task.text, /【话题新消息 .*】运维更新好了/)
      assert.equal(task.threadHistory.length, 1)
      assert.equal(task.threadHistory[0].status, 'ignored')
      // 活动态不可重开
      assert.equal(store.reopenForThread({ id: 'omt_thread1', supplementText: 'again' }), null, '活动态不可重开')
    })],
  ]))

  it('主题归并（并入未开跑 / 在跑 / 挂起 / 已了结，本条落 superseded）；疑似任务 48h 过期（#8）', () => runSteps([
    ['主题归并：并入未开跑 / 在跑 / 挂起 / 已了结的目标，本条落 superseded；最近任务候选排除自身与已归并', () => withStore((store) => {
      const mk = (id, status, extra = {}) => store.upsert({ id, source: 'lark', repo: 'falive', chatId: 'oc_x', text: `t-${id}`, status, topic: 'live-2', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...extra })
      mk('into_q', 'queued'); mk('from1', 'received', { commandType: 'api' })
      let out = store.mergeIntoTask({ fromId: 'from1', intoId: 'into_q' })
      assert.equal(out.mode, 'appended'); assert.match(store.get('into_q').text, /【同主题补充 .*】t-from1/); assert.equal(store.get('from1').status, 'superseded'); assert.equal(store.get('into_q').commandType, 'api')
      mk('into_r', 'running'); mk('from2', 'received')
      assert.equal(store.mergeIntoTask({ fromId: 'from2', intoId: 'into_r' }).mode, 'rerun_after_done'); assert.equal(store.get('into_r').rerunAfterDone, true)
      mk('into_w', 'waiting_confirmation', { epoch: 1 }); mk('from3', 'received')
      assert.equal(store.mergeIntoTask({ fromId: 'from3', intoId: 'into_w' }).mode, 'resumed'); assert.equal(store.get('into_w').status, 'queued'); assert.equal(store.get('into_w').epoch, 2)
      mk('into_s', 'waiting_confirmation', { epoch: 1, suspected: true }); mk('from3b', 'received')
      assert.equal(store.mergeIntoTask({ fromId: 'from3b', intoId: 'into_s' }).mode, 'appended_suspected', '疑似任务不因新消息自动开跑'); assert.equal(store.get('into_s').status, 'waiting_confirmation')
      mk('into_d', 'done', { epoch: 4, result: 'old' }); mk('from4', 'received')
      assert.equal(store.mergeIntoTask({ fromId: 'from4', intoId: 'into_d' }).mode, 'reopened'); assert.equal(store.get('into_d').status, 'queued'); assert.equal(store.get('into_d').epoch, 5); assert.equal(store.get('into_d').threadHistory.length, 1)
      const recent = store.listRecentForChat('oc_x', { excludeId: 'into_q' })
      assert.ok(recent.every((task) => task.status !== 'superseded' && task.id !== 'into_q'), '最近任务候选排除自身与已归并')
      assert.equal(store.mergeIntoTask({ fromId: 'nope', intoId: 'into_q' }), null)
    })],
    // 原 describe「疑似任务 48h 过期（#8）」
    ['挂满 48h 的疑似任务自动 ignored 并返回；未满的不动', () => withStore((store) => {
      const old = new Date(Date.now() - 49 * 3600_000).toISOString()
      store.upsert({ id: 's1', source: 'lark', repo: 'falive', chatId: 'oc_x', text: 'a', summary: '录播接口', status: 'waiting_confirmation', suspected: true, parkedAt: old, createdAt: old, updatedAt: old })
      store.upsert({ id: 's2', source: 'lark', repo: 'falive', chatId: 'oc_x', text: 'b', status: 'waiting_confirmation', suspected: true, parkedAt: new Date().toISOString(), createdAt: new Date().toISOString() })
      assert.equal(store.listSuspected().length, 2)
      const expired = store.expireSuspected()
      assert.deepEqual(expired.map((t) => t.id), ['s1'], '挂满 48h 的疑似任务自动 ignored 并返回')
      assert.equal(store.get('s1').status, 'ignored')
      assert.match(store.get('s1').result, /自动关闭/)
      assert.equal(store.listSuspected().length, 1, '未满的不动')
    })],
  ]))
})

describe('话题补充 @ 机器人（10-23 起外部群只有 @bot 的任务）', () => {
  it('补充 @ 机器人：标显式通道；10-23 前的存量被动任务被接手，去掉只记台账；补充没 @ 不改通道', () => {
    const target = { id: 'omt_reserve', passiveLedgerOnly: true }
    assert.equal(applySupplementAddressing({ target, addressing: { toBot: true, fromPrincipal: true } }), true)
    assert.equal(target.passiveLedgerOnly, undefined)
    assert.equal(target.addressedToBot, true)
    assert.equal(target.fromPrincipal, true)
    assert.equal(applySupplementAddressing({ target, addressing: { toBot: true } }), false, '已经是显式通道，不重复回收到')
    const other = { id: 'omt_p', addressedToBot: true }
    assert.equal(applySupplementAddressing({ target: other, addressing: { toBot: false } }), false)
  })
})

describe('分类去抖分道（阶段 2）', () => {
  const intake = { fastLaneMs: 0, quietGapMs: 60_000, maxWaitMs: 180_000 }
  const now = Date.parse('2026-10-15T10:00:00Z')
  it('快慢道判定、notBefore 计算（安静期 / 顺延封顶）、完整件慢道也不等', () => runSteps([
    ['@ 机器人 / 回复 bot 的卡 / 负责人本人 → 快道；被动上下文 → 慢道', () => {
      assert.equal(resolveIntakeLane({ addressing: { toBot: true } }), 'fast', '@ 机器人 → 快道')
      assert.equal(resolveIntakeLane({ addressing: { fromPrincipal: true } }), 'fast', '负责人本人 → 快道')
      assert.equal(resolveIntakeLane({ addressing: {}, quotedIsOurs: true }), 'fast', '回复 bot 的卡 → 快道')
      assert.equal(resolveIntakeLane({ addressing: { toBot: false } }), 'slow', '被动上下文 → 慢道')
    }],
    ['快道不等；慢道首条等安静期；补充只顺延到首条 + 封顶；超过封顶立刻', () => {
      assert.equal(resolveIntakeNotBefore({ lane: 'fast', firstReceivedAt: new Date(now).toISOString(), now, intake }), new Date(now).toISOString(), '快道不等')
      assert.equal(resolveIntakeNotBefore({ lane: 'slow', firstReceivedAt: new Date(now).toISOString(), now, intake }), new Date(now + 60_000).toISOString(), '慢道首条等安静期')
      assert.equal(resolveIntakeNotBefore({ lane: 'slow', firstReceivedAt: new Date(now - 150_000).toISOString(), now, intake }), new Date(now + 30_000).toISOString(), '补充只顺延到首条 + 封顶')
      assert.equal(resolveIntakeNotBefore({ lane: 'slow', firstReceivedAt: new Date(now - 200_000).toISOString(), now, intake }), new Date(now).toISOString(), '超过封顶立刻')
    }],
    ['完整件（对接文档 / ≥200 字）慢道也不等', () => {
      assert.equal(isCompleteMessage({ msg: { text: '再看看', attachments: [] } }), false)
      assert.equal(isCompleteMessage({ msg: { text: '预'.repeat(200), attachments: [] } }), true, '≥200 字是完整件')
      assert.equal(isCompleteMessage({ msg: { text: '', attachments: [{ type: 'file', fileName: 'PM-3217.md' }] } }), true, '对接文档是完整件')
      assert.equal(resolveIntakeNotBefore({ lane: 'slow', complete: true, firstReceivedAt: new Date(now).toISOString(), now, intake }), new Date(now).toISOString(), '完整件慢道也不等')
    }],
  ]))
})
