import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { externalBlockers, extractLegacyBlockers, isFixElsewhere, nameIn } from '../lib/lark-blocked-ask.mjs'
import {
  blockedAskMentions, decideGroupReply, deliverAck, deliverHeldGroupReply, deliverIgnoredAfterAck, deliverNoted, deliverOutcome, deliverOverdueObligations,
  deliverStart, deliverSuspected, deliverableOf, legacyOutcome, mentionsFor,
} from '../lib/lark-delivery.mjs'
import { recordOutbox } from '../lib/lark-outbox.mjs'
import { getObligation, noteAck } from '../lib/lark-reply-obligation.mjs'
import { normalizeOutcome } from '../lib/lark-report-render.mjs'
import { createTaskStore } from '../lib/lark-task-store.mjs'
import { eachCase, runSteps } from './support/steps.mjs'

// 任务的人话出口（对话层 11-01）：发群 / 扣下 / 私信 × 回复义务转移；放行草稿；答应了没结论的巡检。一个 it，分段跑，每段独立临时目录。
const H = '登录页报错'
const G = '测试群'
const config = { notifyOpenId: 'ou_aven', ownerMap: { 后端: 'ou_be', William: 'ou_w', aven: 'ou_aven' }, internalNames: ['aven', '前端小李'], chatNames: { oc_g: G } }
const out = (raw) => normalizeOutcome({ summary: '摘要', ...raw })
const quiet = async (fn) => {
  const spies = ['log', 'warn', 'error'].map((name) => { const original = console[name]; console[name] = () => {}; return () => { console[name] = original } })
  try {
    return await fn()
  } finally {
    for (const restore of spies) restore()
  }
}

describe('任务的人话出口', () => {
  let tmp
  let store
  let sent
  let deps
  const task = (extra = {}) => store.upsert({ id: 'om_1', epoch: 1, chatId: 'oc_g', messageId: 'om_1', operator: 'ou_qa', topic: 'login', summary: `${H}，看一下`, status: 'running', contract: { deliverable: 'change' }, ...extra })
  const group = () => sent.filter((item) => item.kind === 'reply')
  const dm = () => sent.filter((item) => item.kind === 'send').map((item) => item.markdown)
  it('decideGroupReply 矩阵、deliverOutcome 发 / 扣 / 私信 × 义务转移、放行草稿、巡检答应了没结论', () => runSteps([
    ['decideGroupReply 矩阵', () => eachCase([
      { name: 'groupSilent → none', t: { contract: { deliverable: 'answer' }, outcome: out({ groupSilent: true, report: { answer: 'a', items: [] } }) }, status: 'done', want: { mode: 'none', reason: '执行侧判群里无事可说' } },
      { name: 'answer 有 report，failed 也 post', t: { contract: { deliverable: 'answer' }, outcome: out({ report: { answer: '查不到', items: [] } }) }, status: 'failed', want: { mode: 'post', reason: null } },
      { name: 'verification 有 groupReply，blocked 也 post', t: { contract: { deliverable: 'verification' }, outcome: out({ groupReply: '没测通' }) }, status: 'blocked', want: { mode: 'post', reason: null } },
      { name: 'answer 没回复，failed → none', t: { contract: { deliverable: 'answer' }, outcome: out({}) }, status: 'failed', want: { mode: 'none', reason: null } },
      { name: 'change done → post', t: { contract: { deliverable: 'change' }, outcome: out({}) }, status: 'done', want: { mode: 'post', reason: null } },
      { name: 'change no_change_needed → post', t: { contract: { deliverable: 'change' }, outcome: out({}) }, status: 'no_change_needed', want: { mode: 'post', reason: null } },
      { name: 'change failed 有 groupReply → hold', t: { contract: { deliverable: 'change' }, outcome: out({ groupReply: '改了' }) }, status: 'failed', want: { mode: 'hold', reason: '任务没做成（failed），回答先给你看' } },
      { name: 'change waiting 有 report、改动没提交 → hold 带闸原因', t: { contract: { deliverable: 'change' }, outcome: out({ report: { answer: 'a', items: [] }, change: { committed: false, gate: 'lint', reason: '2 处' } }) }, status: 'waiting_confirmation', want: { mode: 'hold', reason: '改动没提交（lint：2 处），回答先给你看' } },
      { name: 'change 改动没提交但没写闸 → ?', t: { contract: { deliverable: 'change' }, outcome: out({ groupReply: 'x', change: { committed: false } }) }, status: 'blocked', want: { mode: 'hold', reason: '改动没提交（?：），回答先给你看' } },
      { name: 'change blocked 没回复 → none', t: { contract: { deliverable: 'change' }, outcome: out({ blockers: ['要接口'] }) }, status: 'blocked', want: { mode: 'none', reason: null } },
      { name: '旧任务没有 outcome：done post / failed none', t: { result: '已完成。' }, status: 'done', want: { mode: 'post', reason: null } },
      { name: '旧任务 failed → none', t: { result: '处理失败。' }, status: 'failed', want: { mode: 'none', reason: null } },
    ], ({ t, status, want }) => assert.deepEqual(decideGroupReply({ task: t, status }), want))],
    ['deliverableOf / mentionsFor / blockedAskMentions / blocked-ask 纯函数', () => {
      assert.equal(deliverableOf({ contract: { deliverable: 'answer' }, commandType: 'ops' }), 'answer')
      assert.equal(deliverableOf({ commandType: 'ops' }), 'ops')
      assert.equal(deliverableOf({ commandType: 'status' }), 'answer')
      assert.equal(deliverableOf({ commandType: 'bug' }), 'change')
      assert.equal(deliverableOf(null), 'change')
      assert.deepEqual(mentionsFor({ followUps: [{ owner: '后端', items: ['补接口'] }, { owner: 'william', items: [] }, { owner: '后端同学' }, { owner: '设计', items: ['切图'] }, { owner: '' }], ownerMap: config.ownerMap }),
        [{ name: '后端', openId: 'ou_be', items: ['补接口'] }, { name: 'William', openId: 'ou_w', items: [] }, { name: '设计', openId: null, items: ['切图'] }])
      assert.deepEqual(mentionsFor({}), [])
      const blockers = ['要 William 给接口示例', '让 aven 确认']
      assert.deepEqual(blockedAskMentions({ task: { operator: 'ou_qa' }, config, blockers }), [{ name: 'William', openId: 'ou_w', items: blockers }], '点名的外部同事；内部名单里的 aven 不 @')
      assert.deepEqual(blockedAskMentions({ task: { operator: 'ou_qa', outcome: { owner: '后端' } }, config, blockers }).map((m) => m.openId), ['ou_be', 'ou_w'], '责任人在前')
      assert.deepEqual(blockedAskMentions({ task: { operator: 'ou_qa', owner: '后端' }, config, blockers }).map((m) => m.openId), ['ou_be', 'ou_w'], '任务上的 owner 也算责任人')
      assert.deepEqual(blockedAskMentions({ task: { operator: 'ou_qa', owner: 'aven' }, config, blockers: ['x'] }), [{ name: '', openId: 'ou_qa', items: ['x'] }], '只有负责人本人时回落发起人')
      assert.deepEqual(blockedAskMentions({ task: { operator: 'ou_be' }, config, blockers: ['x'] }), [{ name: '后端', openId: 'ou_be', items: ['x'] }], '发起人在 ownerMap 里带名字')
      assert.deepEqual(blockedAskMentions({ task: { operator: 'ou_aven' }, config, blockers: ['x'] }), [])
      assert.deepEqual(blockedAskMentions({ task: { operator: 'oc_g' }, config: {}, blockers: ['x'] }), [])
      assert.deepEqual(externalBlockers(['要接口示例', '负责人确认归属', '读不到 Lark 文档', 'lark-cli 没授权', '找前端小李要', '要 Aven 看'], { config }), ['要接口示例'])
      assert.deepEqual(externalBlockers(['找前端小李要'], { config: {} }), ['找前端小李要'], '没配内部名单只过固定词')
      assert.equal(nameIn('要 William 给', 'william'), true)
      assert.equal(nameIn('要 Williams 给', 'William'), false)
      assert.equal(isFixElsewhere({ outcome: { taskState: 'awaiting_owner_fix' } }), true)
      assert.equal(isFixElsewhere({ taskState: 'awaiting_owner_fix' }), true)
      assert.equal(isFixElsewhere({ outcome: { rootCauseLayer: 'backend-data' } }), true)
      assert.equal(isFixElsewhere({ rootCauseLayer: 'frontend-logic', taskState: 'diagnosing' }), false)
      assert.equal(isFixElsewhere(null), false)
      assert.deepEqual(extractLegacyBlockers('已阻塞，需外部材料 / 权限后才能继续。\n1. 待补充：接口文档；账号\n下一步：等'), ['接口文档', '账号'])
      assert.deepEqual(extractLegacyBlockers('已完成。'), [])
      assert.deepEqual(legacyOutcome({ result: '处理失败。\n1. 构建红了\n2. 待补充：a；b\n3. 下一步：看 CI', changedFiles: ['x'], owner: '后端' }), { kind: 'ai', summary: '构建红了', nextStep: '看 CI', blockers: ['a', 'b'], report: null, groupReply: null, detailDoc: null, followUps: null, changedFiles: ['x'], owner: '后端', groupSilent: false, text: '处理失败。\n1. 构建红了\n2. 待补充：a；b\n3. 下一步：看 CI' })
      assert.deepEqual(legacyOutcome({}).summary, null)
      assert.deepEqual([legacyOutcome({ result: '下一步：看' }).nextStep, legacyOutcome({ result: '下一步：看' }).summary], ['看', null], '下一步在第一行也能取到')
      assert.deepEqual(blockedAskMentions({ task: { operator: 'ou_qa' }, config: { ownerMap: { William: 'ou_w' } }, blockers: ['要 William 给'] }), [{ name: 'William', openId: 'ou_w', items: ['要 William 给'] }], '没配内部名单也能点名')
    }],
    ['change done：群里回原消息（摘要首句 + 事实 + 待跟进 + 详细见）、私信 ✅ + 群里已回、义务 answered', () => quiet(async () => {
      const t = task({ branch: 'fix/login', outcome: out({ summary: '修好了。改了校验。', changedFiles: ['a', 'b'], followUps: [{ owner: '后端', items: ['补接口'] }], detailDoc: '# 细节' }) })
      noteAck({ task: t, text: '收到。' })
      const published = []
      const result = await deliverOutcome({ config, store, task: t, status: 'done', deps: { ...deps, publish: async (args) => { published.push(args); return deps.publish(args) } } })
      assert.deepEqual([result.ok, result.messageId, result.reason, result.docUrl], [true, 'om_r1', null, 'https://doc/1'])
      assert.deepEqual(published, [{ title: `${H}，看一下（细节）`, markdown: '# 细节', identity: 'user' }])
      assert.deepEqual([group()[0].messageId, group()[0].markdown, group()[0].idempotencyKey], ['om_1', '修好了。\n分支 fix/login · 改了 2 个文件\n<at user_id="ou_be">后端</at>：补接口\n详细见：https://doc/1', 'om_1-e1-done'])
      assert.deepEqual(dm(), [`✅ ${H}，看一下（${G}）· 分支 fix/login · 改了 2 个文件\n群里已回「修好了」`])
      // 义务上记的是渲染 @ 之前的原文（草稿放行时再渲染一次）
      assert.deepEqual([getObligation(t).state, getObligation(t).answerText], ['answered', '修好了。\n分支 fix/login · 改了 2 个文件\n@后端：补接口\n详细见：https://doc/1'])
      assert.deepEqual(store.get('om_1').receipts.map((r) => r.kind), ['done', 'done'])
    })],
    ['change done 群里被闸拦下：不算已回，私信说「群里没发」，义务 owed；aven 私信发起的不另发私信', () => quiet(async () => {
      const t = task({ outcome: out({ summary: '修好了。' }) })
      noteAck({ task: t, text: '收到。' })
      await deliverOutcome({ config, store, task: t, status: 'done', deps })
      const again = task({ id: 'om_2', messageId: 'om_2', outcome: out({ summary: '修好了。' }) })
      noteAck({ task: again, text: '收到。' })
      const result = await deliverOutcome({ config, store, task: again, status: 'done', deps })
      assert.equal(result.ok, false)
      assert.match(result.reason, /^出口闸拦下：同内容/)
      assert.equal(group().length, 1)
      assert.match(dm()[1], /^✅ .*\n群里没发（出口闸拦下：同内容 .* 已发过（done））。$/)
      assert.equal(getObligation(again).state, 'owed')
      sent.length = 0
      const mine = task({ id: 'om_3', messageId: 'om_3', chatId: 'ou_aven', operator: 'ou_aven', outcome: out({ summary: '改好了。' }) })
      assert.equal((await deliverOutcome({ config, store, task: mine, status: 'done', deps })).ok, true)
      assert.deepEqual([group().length, group()[0].messageId, dm().length], [1, 'om_3', 0])
    })],
    ['answer / verification：report 原样回群；他不是提单人才私信「替你答了」；没写回复、回过收到 → 义务 owed、不发群', () => quiet(async () => {
      const t = task({ contract: { deliverable: 'answer' }, outcome: out({ report: { subject: 'test / pre', answer: '不一样，test 比 pre 多 3 个提交。', items: ['a1 修复'] }, detailDoc: '# 三行提交' }) })
      assert.equal((await deliverOutcome({ config, store, task: t, status: 'done', deps })).ok, true)
      assert.equal(group()[0].markdown, '不一样，test 比 pre 多 3 个提交。\n- a1 修复\n材料在这里：https://doc/1')
      assert.deepEqual(dm(), [`💬 替你答了（${G}）：不一样，test 比 pre 多 3 个提交`])
      assert.equal(getObligation(t).state, 'answered')
      sent.length = 0
      const self = task({ id: 'om_2', messageId: 'om_2', operator: 'ou_aven', contract: { deliverable: 'verification' }, outcome: out({ report: { subject: '注册登录', items: [{ mark: 'ok', name: '注册' }, { mark: 'not_done', name: '登录', note: '500' }] } }) })
      assert.equal((await deliverOutcome({ config, store, task: self, status: 'done', deps })).ok, true)
      assert.equal(group()[0].markdown, '注册登录：通了 1 项，没通 1 项\n- ❌ 登录：500\n- ✅ 注册')
      assert.deepEqual(dm(), [], '提单人就是 aven，不私信')
      sent.length = 0
      const empty = task({ id: 'om_3', messageId: 'om_3', contract: { deliverable: 'verification' }, outcome: out({ summary: null }) })
      noteAck({ task: empty, text: '收到，我测一下。' })
      const result = await deliverOutcome({ config, store, task: empty, status: 'done', deps })
      assert.deepEqual([result.ok, result.reason, group().length, dm().length, getObligation(empty).state], [false, '没写群回复', 0, 0, 'owed'])
    })],
    ['change failed 有 groupReply：不发群、草稿私信（held）→ 「就这样回」按原文回群、义务 answered、草稿清掉 → 再放行 stale', () => quiet(async () => {
      const t = task({ outcome: out({ summary: '改了但没提交', groupReply: '登录页改好了，等发布。', blockers: [], detailDoc: '# 细节', followUps: [{ owner: '后端', items: ['x'] }], change: { committed: false, gate: 'lint', reason: '2 处' } }) })
      noteAck({ task: t, text: '收到，我看一下。' })
      const result = await deliverOutcome({ config, store, task: t, status: 'failed', deps })
      assert.deepEqual([result.ok, result.messageId, group().length], [true, 'om_s1', 0])
      assert.deepEqual(dm(), [`⛔ 没做成（${G}）：改了但没提交\n群里只回过「收到，我看一下」，结论还没发。没问题就回「就这样回」，我把下面这段原样发群：\n登录页改好了，等发布。\n详细见：https://doc/1`])
      assert.deepEqual([getObligation(t).state, getObligation(t).heldDraft.text, getObligation(t).heldDraft.reason, getObligation(t).heldDraft.mentions], ['held', '登录页改好了，等发布。\n详细见：https://doc/1', '改动没提交（lint：2 处），回答先给你看', []])
      assert.deepEqual(store.get('om_1').receipts.map((r) => [r.kind, r.chatId]), [['held', 'ou_aven']])
      sent.length = 0
      const released = await deliverHeldGroupReply({ config, store, task: t, deps })
      assert.deepEqual(released, { ok: true, stale: false, reason: null, messageId: 'om_r1', note: `已按原文回群（${H}，看一下）。` })
      assert.deepEqual([group()[0].markdown, group()[0].messageId, group()[0].idempotencyKey], ['登录页改好了，等发布。\n详细见：https://doc/1', 'om_1', 'om_1-e1-rel'])
      assert.deepEqual([getObligation(t).state, getObligation(t).heldDraft], ['answered', undefined])
      assert.deepEqual(await deliverHeldGroupReply({ config, store, task: t, deps }), { ok: false, stale: true, reason: 'no held draft', messageId: null, note: `「${H}，看一下」这条已经发过更新的结论了，没有待放行的草稿。` })
      // 放行时发送失败：草稿留着
      const t2 = task({ id: 'om_2', messageId: 'om_2', outcome: out({ groupReply: '草稿二' }) })
      await deliverOutcome({ config, store, task: t2, status: 'failed', deps })
      const failing = { ...deps, replyMarkdown: async () => ({ ok: false, messageId: null, via: 'reply', reason: '撤回了' }) }
      assert.deepEqual(await deliverHeldGroupReply({ config, store, task: t2, deps: failing }), { ok: false, stale: false, reason: '撤回了', messageId: null, note: '没发出去：撤回了。' })
      assert.equal(getObligation(t2).heldDraft.text, '草稿二')
      // 没开过义务但任务上记了 ack 原话：照样如实说群里只回过那句
      sent.length = 0
      await deliverOutcome({ config, store, task: task({ id: 'om_3', messageId: 'om_3', ackReply: '收到 r。', outcome: out({ groupReply: '草稿三' }) }), status: 'failed', deps })
      assert.match(dm()[0], /群里只回过「收到 r」/)
      // aven 自己私信发起的：没有扣草稿，结论直接回他的私信，不另发一条
      sent.length = 0
      const mine = task({ id: 'om_4', messageId: 'om_4', chatId: 'ou_aven', operator: 'ou_aven', outcome: out({ groupReply: '改了一半' }) })
      assert.equal((await deliverOutcome({ config, store, task: mine, status: 'failed', deps })).ok, true)
      assert.deepEqual([group().map((i) => [i.messageId, i.markdown]), dm().length, getObligation(mine).state], [[['om_4', '改了一半']], 0, 'answered'])
    })],
    ['change failed 没回复：只私信「没做成 + 下一步」（有旁证说可能做成了）、义务 owed；aven 私信发起的失败也只发一条', () => quiet(async () => {
      const t = task({ outcome: out({ summary: '构建红', nextStep: '要你看 CI' }) })
      noteAck({ task: t, text: '收到。' })
      const result = await deliverOutcome({ config, store, task: t, status: 'failed', deps })
      assert.deepEqual([result.ok, result.messageId, group().length, dm(), getObligation(t).state], [true, 'om_s1', 0, [`⛔ 没做成（${G}）：构建红\n要你看 CI`], 'owed'])
      sent.length = 0
      const evidence = task({ id: 'om_2', messageId: 'om_2', outcome: out({ summary: '结果文件丢了', text: '活可能已经干成了：有新提交' }) })
      await deliverOutcome({ config, store, task: evidence, status: 'failed', deps })
      assert.deepEqual(dm(), [`⚠ 可能做成了、但没拿到结果（${G}）：结果文件丢了`])
      sent.length = 0
      const legacyEvidence = task({ id: 'om_2b', messageId: 'om_2b', result: '活可能已经干成了：有新提交', outcome: out({ summary: '丢了', text: null }) })
      await deliverOutcome({ config, store, task: legacyEvidence, status: 'failed', deps })
      assert.deepEqual(dm(), [`⚠ 可能做成了、但没拿到结果（${G}）：丢了`], '结构化结果没带文本时看任务上的 result 文本')
      sent.length = 0
      const mine = task({ id: 'om_3', messageId: 'om_3', chatId: 'ou_aven', operator: 'ou_aven', outcome: out({ summary: '构建红' }) })
      assert.equal((await deliverOutcome({ config, store, task: mine, status: 'failed', deps })).ok, true)
      assert.deepEqual([group().length, dm()], [0, ['⛔ 没做成（私信）：构建红']])
      // 没回过收到、没私信对象：既不发群也没私信 → 不算交付、义务不动
      sent.length = 0
      const noPrincipal = task({ id: 'om_4', messageId: 'om_4', outcome: out({ summary: 'x' }) })
      assert.deepEqual(await deliverOutcome({ config: { ...config, notifyOpenId: null }, store, task: noPrincipal, status: 'failed', deps }).then((r) => [r.ok, r.reason]), [false, 'no notifyOpenId'])
      assert.equal(getObligation(noPrincipal), null)
    })],
    ['change blocked：外部条目 + 有人可 @ → 群里 @ 要材料（回执 blocked_ask、义务 answered）；交办时已说在等什么 / 全是内部条目 / 疑似 → 不发群，私信 ⏸ + 要', () => quiet(async () => {
      const t = task({ outcome: out({ blockers: ['要 William 给接口返回示例', '负责人确认归属'] }) })
      noteAck({ task: t, text: '收到。' })
      const result = await deliverOutcome({ config, store, task: t, status: 'blocked', deps })
      assert.deepEqual([result.ok, result.messageId, dm().length], [true, 'om_r1', 0])
      assert.deepEqual([group()[0].markdown, group()[0].idempotencyKey], [`<at user_id="ou_w">William</at> 「${H}，看一下」需要你们帮忙：\n- 要 William 给接口返回示例`, 'om_1-e1-ask'])
      assert.deepEqual([getObligation(t).state, store.get('om_1').receipts.map((r) => r.kind)], ['answered', ['blocked_ask']])
      sent.length = 0
      const waits = task({ id: 'om_2', messageId: 'om_2', waitsFor: '后端给字段', outcome: out({ blockers: ['要 William 给接口返回示例'] }) })
      noteAck({ task: waits, text: '收到。' })
      assert.equal((await deliverOutcome({ config, store, task: waits, status: 'blocked', deps })).ok, true)
      assert.deepEqual([group().length, dm(), getObligation(waits).state], [0, [`⏸ 停下来了（${G}）：${H}，看一下\n要：要 William 给接口返回示例\n群里只回过「收到」，结论还没发。`], 'owed'])
      assert.deepEqual(store.get('om_2').receipts.map((r) => r.kind), ['blocked'])
      sent.length = 0
      const internal = task({ id: 'om_3', messageId: 'om_3', outcome: out({ blockers: ['负责人确认归属'] }) })
      await deliverOutcome({ config, store, task: internal, status: 'waiting_confirmation', deps })
      assert.deepEqual([group().length, dm(), store.get('om_3').receipts.map((r) => r.kind)], [0, [`⏸ 停下来了（${G}）：${H}，看一下\n要：负责人确认归属`], ['waiting']])
      sent.length = 0
      const suspected = task({ id: 'om_4', messageId: 'om_4', suspected: true, outcome: out({ blockers: ['要 William 给接口返回示例'] }) })
      await deliverOutcome({ config, store, task: suspected, status: 'blocked', deps })
      assert.equal(group().length, 0)
      sent.length = 0
      const nobody = task({ id: 'om_5', messageId: 'om_5', operator: 'ou_aven', outcome: out({ blockers: ['要接口返回示例'] }) })
      await deliverOutcome({ config, store, task: nobody, status: 'blocked', deps })
      assert.deepEqual([group().length, dm().length], [0, 1], '没人可 @ 只私信')
      sent.length = 0
      const answer = task({ id: 'om_6', messageId: 'om_6', contract: { deliverable: 'answer' }, outcome: out({ blockers: ['要 William 给接口返回示例'] }) })
      await deliverOutcome({ config, store, task: answer, status: 'blocked', deps })
      assert.equal(group().length, 0, '代答类不往群里要材料')
      sent.length = 0
      const mine = task({ id: 'om_7', messageId: 'om_7', chatId: 'ou_aven', operator: 'ou_aven', outcome: out({ blockers: ['要 William 给接口返回示例'] }) })
      assert.equal((await deliverOutcome({ config, store, task: mine, status: 'blocked', deps })).ok, true)
      assert.deepEqual([group().length, dm()], [0, [`⏸ 停下来了（私信）：${H}，看一下\n要：要 William 给接口返回示例`]], 'aven 私信发起的不往别的群要材料，停下来直接告诉他')
    })],
    ['no_change（change 类）回群「看过了」；ops 只私信（失败加 ⛔）；groupSilent 不发群只私信 ✅；旧任务没 outcome 用 result 文本', () => quiet(async () => {
      const t = task({ outcome: out({ summary: '是后端字段没返回。', owner: '后端' }) })
      assert.equal((await deliverOutcome({ config, store, task: t, status: 'no_change_needed', deps })).ok, true)
      assert.deepEqual([group()[0].markdown, group()[0].idempotencyKey, dm().length], ['看过了，这个不用改前端：是后端字段没返回。要 后端 看下。', 'om_1-e1-noop', 0])
      sent.length = 0
      const bare = await deliverOutcome({ config, store, task: task({ id: 'om_0', messageId: 'om_0', outcome: out({ summary: null }) }), status: 'no_change_needed', deps })
      assert.deepEqual([bare.ok, bare.reason, group().length], [false, '没写群回复', 0], '没摘要不发「看过了：」')
      sent.length = 0
      const ops = task({ id: 'om_2', messageId: 'om_2', chatId: 'ou_aven', contract: { deliverable: 'ops' }, outcome: out({ kind: 'ops', text: 'online 已经是 9f3c2a1，没有新内容，不发。' }) })
      assert.deepEqual(await deliverOutcome({ config, store, task: ops, status: 'done', deps }), { ok: true, messageId: 'om_s1', reason: null })
      await deliverOutcome({ config, store, task: ops, status: 'failed', deps })
      assert.deepEqual([group().length, dm()], [0, ['online 已经是 9f3c2a1，没有新内容，不发。', '⛔ online 已经是 9f3c2a1，没有新内容，不发。']])
      assert.deepEqual(store.get('om_2').receipts.map((r) => r.kind), ['ops', 'ops'])
      sent.length = 0
      const legacyOps = task({ id: 'om_3', messageId: 'om_3', chatId: 'ou_aven', contract: null, commandType: 'ops', result: 'build 绿' })
      await deliverOutcome({ config, store, task: legacyOps, status: 'done', deps })
      await deliverOutcome({ config, store, task: task({ id: 'om_3b', messageId: 'om_3b', chatId: 'ou_aven', contract: { deliverable: 'ops' }, outcome: out({ kind: 'ops', summary: '只有摘要' }) }), status: 'done', deps })
      assert.deepEqual(dm(), ['build 绿', '只有摘要'])
      sent.length = 0
      const silent = task({ id: 'om_4', messageId: 'om_4', outcome: out({ summary: '群里不用说', groupSilent: true }) })
      assert.equal((await deliverOutcome({ config, store, task: silent, status: 'done', deps })).ok, true)
      assert.deepEqual([group().length, dm()], [0, [`✅ ${H}，看一下（${G}）`]])
      sent.length = 0
      const legacy = task({ id: 'om_5', messageId: 'om_5', contract: null, commandType: 'bug', branch: 'fix/x', result: '已完成，待发布。\n1. **修了**登录页。细节略\n判定：bug' })
      assert.equal((await deliverOutcome({ config, store, task: legacy, status: 'done', deps })).ok, true)
      assert.equal(group()[0].markdown, '修了登录页。\n分支 fix/x')
    })],
    ['ack / noted / start / suspected / ignored-after-ack', () => quiet(async () => {
      const t = task()
      const ack = await deliverAck({ config, store, task: t, reply: '能发，我看下要发什么', deps })
      assert.deepEqual([ack.ok, group()[0].markdown, group()[0].idempotencyKey, getObligation(t).state, getObligation(t).ackText], [true, '能发，我看下要发什么。', 'om_1-e1-ack', 'acked', '能发，我看下要发什么。'])
      assert.deepEqual(await deliverAck({ config, store, task: task({ id: 'om_p', privateOrigin: { anchorId: 'om_1', anchorHead: 'x' } }), deps }), { ok: false, skipped: true, reason: 'private origin' })
      const noted = await deliverNoted({ config, store, task: task({ id: 'om_2', messageId: 'om_2', operator: 'ou_other' }), deps })
      assert.deepEqual([noted.ok, group()[1].markdown, group()[1].idempotencyKey, getObligation(store.get('om_2')).state], [true, '收到，记下了。', 'om_2-e1-nt', 'answered'])
      assert.deepEqual(await deliverNoted({ config, store, task: task({ id: 'om_p2', privateOrigin: { anchorId: 'om_1', anchorHead: 'x' } }), deps }), { ok: false, skipped: true, reason: 'private origin' })
      const failing = { ...deps, replyMarkdown: async () => ({ ok: false, messageId: null, via: 'reply', reason: 'x' }) }
      assert.equal((await deliverNoted({ config, store, task: task({ id: 'om_3', messageId: 'om_3', operator: 'ou_c' }), deps: failing })).ok, false)
      assert.equal(getObligation(store.get('om_3')), null, '没发成不开义务')
      sent.length = 0
      assert.equal((await deliverStart({ config, store, task: t, deps })).ok, true)
      await deliverStart({ config, store, task: task({ id: 'om_4', messageId: 'om_4', resumeCount: 2 }), deps })
      assert.deepEqual(await deliverStart({ config, store, task: task({ id: 'om_5', chatId: 'ou_aven' }), deps }), { ok: false, skipped: true, reason: 'dm origin' })
      assert.deepEqual(await deliverStart({ config, store, task: task({ id: 'om_5b', chatType: 'p2p' }), deps }), { ok: false, skipped: true, reason: 'dm origin' }, 'p2p 会话也是私信发起')
      assert.deepEqual(await deliverStart({ config, store, task: task({ id: 'om_5c', intake: { trigger: 'dm' } }), deps }), { ok: false, skipped: true, reason: 'dm origin' }, '入口是私信也是')
      await deliverSuspected({ config, store, task: t, deps })
      await deliverIgnoredAfterAck({ config, store, task: t, reason: '只是通知', deps })
      await deliverIgnoredAfterAck({ config, store, task: task({ id: 'om_6', intake: { classification: { reason: '分类器的理由' } } }), deps })
      await deliverIgnoredAfterAck({ config, store, task: task({ id: 'om_7', intake: { classification: { summary: '只有摘要' } } }), deps })
      assert.deepEqual(dm(), [
        `🛠 开始做：${H}，看一下（${G}）`,
        `🛠 接着做（第 2 次续跑）：${H}，看一下`,
        `❓ 可能是你的事（${G}）：${H}，看一下\n是 → 回「继续任务 om_1 做」；不是 → 回「取消任务 om_1」。不回也不催，48 小时后自动关。`,
        `🤔 群里 @我 的这条看了，判断不用我处理（${G}）：${H}，看一下\n理由：只是通知\n判错了回「继续任务 om_1 做」。`,
        `🤔 群里 @我 的这条看了，判断不用我处理（${G}）：${H}，看一下\n理由：分类器的理由\n判错了回「继续任务 om_6 做」。`,
        `🤔 群里 @我 的这条看了，判断不用我处理（${G}）：${H}，看一下\n理由：只有摘要\n判错了回「继续任务 om_7 做」。`,
      ])
      assert.deepEqual(store.get('om_1').receipts.map((r) => [r.kind, r.chatId]), [['ack', 'oc_g'], ['start', 'ou_aven'], ['suspected', 'ou_aven'], ['ignored_after_ack', 'ou_aven']])
    })],
    ['巡检答应了没结论：4h 没结论私信一次并标记；发件簿里已有结论的补记 answered；任务已了结 / 挂起等人 / 疑似 / 追问 / 私信发起的不提醒（标记一次）；没发成不标记', () => quiet(async () => {
      const now = Date.now()
      const ago = now - 5 * 60 * 60_000
      const a = task({ id: 'om_a', messageId: 'om_a', status: 'running' })
      noteAck({ task: a, text: '收到，我看一下。', now: ago })
      const b = task({ id: 'om_b', messageId: 'om_b', operator: 'ou_b', status: 'running' })
      noteAck({ task: b, text: '收到。', now: ago })
      await deliverAck({ config, store, task: task({ id: 'om_b2', messageId: 'om_b2', operator: 'ou_b2', privateOrigin: null }), deps })
      // b 的结论其实发过（某条出口漏了 noteAnswer）
      await deliverNoted({ config, store, task: store.get('om_b'), deps })
      const bState = getObligation(b)
      bState.state = 'acked'
      const c = task({ id: 'om_c', messageId: 'om_c', operator: 'ou_c', status: 'done' })
      noteAck({ task: c, text: '收到。', now: ago })
      // 11-02 复核：挂起等人（waiting / blocked）、疑似、追问、私信发起的都不是「没跑完」——疑似 / 追问只回了「收到」就挂起，原来 4h 后误报一条。
      // 每种单独成立就跳过（标记一次、下轮不再查），不靠状态与标记同时成立。
      const parked = [
        task({ id: 'om_d', messageId: 'om_d', operator: 'ou_d', status: 'waiting_confirmation' }),
        task({ id: 'om_bl', messageId: 'om_bl', operator: 'ou_bl', status: 'blocked' }),
        task({ id: 'om_su', messageId: 'om_su', operator: 'ou_su', status: 'running', suspected: true }),
        task({ id: 'om_ab', messageId: 'om_ab', operator: 'ou_ab', status: 'queued', askBack: true }),
        task({ id: 'om_dm', messageId: 'om_dm', operator: 'ou_aven', status: 'running', chatType: 'p2p', chatId: 'oc_p2p' }),
      ]
      for (const t of parked) noteAck({ task: t, text: `收到 ${t.id}。`, now: ago })
      const fresh = task({ id: 'om_e', messageId: 'om_e', operator: 'ou_e', status: 'running' })
      noteAck({ task: fresh, text: '收到。', now: now - 60_000 })
      sent.length = 0
      const count = await deliverOverdueObligations({ config, store, now, deps })
      assert.equal(count, 1)
      assert.deepEqual(dm(), [
        `⏰ 群里答应过「收到，我看一下」（${G}），4 小时了还没结论，任务可能没跑完。要重跑回「继续任务 om_a」，不用管就忽略。`,
      ])
      assert.deepEqual([getObligation(a).overdueNotifiedAt != null, getObligation(c).overdueNotifiedAt != null, getObligation(fresh).overdueNotifiedAt], [true, true, undefined])
      assert.deepEqual(parked.map((t) => [t.id, getObligation(t).state, getObligation(t).overdueNotifiedAt != null]), parked.map((t) => [t.id, 'acked', true]), '挂起 / 疑似 / 追问 / 私信发起的：不提醒、标记一次')
      assert.deepEqual([getObligation(b).state, getObligation(b).answerTaskId], ['answered', 'om_b'], '发件簿里有「记下了」就补记 answered')
      assert.deepEqual(store.get('om_a').receipts.map((r) => r.kind), ['overdue'])
      assert.equal(await deliverOverdueObligations({ config, store, now, deps }), 0, '提醒过的不再提醒')
      // 任务已被清掉（没在 store 里）照样提醒；发送失败不标记，下次再试
      const gone = task({ id: 'om_g', messageId: 'om_g', operator: 'ou_g', status: 'running' })
      noteAck({ task: gone, text: '收到 g。', now: ago })
      const failing = { sendMarkdown: async () => ({ ok: false, messageId: null, reason: '网络' }) }
      assert.equal(await deliverOverdueObligations({ config, store, now, deps: failing }), 0)
      assert.equal(getObligation(gone).overdueNotifiedAt, undefined)
      sent.length = 0
      assert.equal(await deliverOverdueObligations({ config, store, now, deps }), 1)
      assert.match(dm()[0], /继续任务 om_g/)
      // 私聊指示任务：义务挂在它针对的群消息上，答复由任务自己发出 → 按 taskIds 对上算答过；答应之前发的结论不算；提醒时用最后一条任务 id
      sent.length = 0
      const p = task({ id: 'om_p', messageId: 'om_p', operator: 'ou_p', status: 'running', privateOrigin: { anchorId: 'om_x', anchorHead: 'x' } })
      noteAck({ task: p, text: '收到 p。', now: ago })
      recordOutbox({ chatId: 'oc_g', taskId: 'om_p', phase: 'done', text: 'p 的结论', now: now - 60 * 60_000 })
      const q = task({ id: 'om_q', messageId: 'om_q', operator: 'ou_q', status: 'running', privateOrigin: { anchorId: 'om_y', anchorHead: 'y' } })
      noteAck({ task: q, text: '收到 q。', now: ago })
      recordOutbox({ chatId: 'oc_g', taskId: 'om_q', phase: 'done', text: '更早的结论', now: ago - 60 * 60_000 })
      assert.equal(await deliverOverdueObligations({ config, store, now, deps }), 1)
      assert.deepEqual([getObligation(p).state, getObligation(p).answerTaskId], ['answered', 'om_p'])
      assert.match(dm()[0], /答应过「收到 q」.*继续任务 om_q/)
    })],
  ], {
    before: () => {
      tmp = mkdtempSync(join(tmpdir(), 'lark-delivery-'))
      process.env.LARK_OUTBOX_DIR = join(tmp, 'outbox')
      process.env.LARK_OBLIGATIONS_DIR = join(tmp, 'obligations')
      store = createTaskStore({ tasksDir: join(tmp, 'tasks') })
      sent = []
      deps = {
        replyMarkdown: async (args) => { sent.push({ kind: 'reply', ...args }); return { ok: true, messageId: `om_r${sent.filter((i) => i.kind === 'reply').length}`, via: 'reply', reason: null } },
        sendMarkdown: async (args) => { sent.push({ kind: 'send', ...args }); return { ok: true, messageId: `om_s${sent.filter((i) => i.kind === 'send').length}`, reason: null } },
        publish: async () => ({ ok: true, url: 'https://doc/1', reason: null }),
      }
    },
    after: () => {
      delete process.env.LARK_OUTBOX_DIR
      delete process.env.LARK_OBLIGATIONS_DIR
      rmSync(tmp, { recursive: true, force: true })
    },
  }))
})
