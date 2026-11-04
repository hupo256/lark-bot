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
      // 待跟进里点名负责人本人 → 群里不 @ 他（他看私信；11-03 falive 回放 10-30 扰民）
      const t2 = task({ id: 'om_2', branch: 'fix/x', outcome: out({ summary: '好了。', changedFiles: ['a'], followUps: [{ owner: 'aven', items: ['定口径'] }, { owner: 'William', items: ['复测'] }] }) })
      await deliverOutcome({ config, store, task: t2, status: 'done', deps })
      assert.ok(!group().at(-1).markdown.includes('ou_aven') && group().at(-1).markdown.includes('<at user_id="ou_w">William</at>：复测'), '不 @ 负责人，照 @ 别人')
      // 他的事项不能丢：进给他的私信（fix10 review：群里那行去掉后私信也没有，「合并到 online 后部署」丢了）；没映射 open_id 的照旧群里写名字
      assert.equal(dm().at(-1), `✅ ${H}，看一下（${G}）· 分支 fix/x · 改了 1 个文件\n群里已回「好了」\n你这边：定口径`)
      const t3 = task({ id: 'om_3', messageId: 'om_3', outcome: out({ summary: '又好了。', followUps: [{ owner: '设计', items: ['切图'] }] }) })
      await deliverOutcome({ config, store, task: t3, status: 'done', deps })
      assert.deepEqual([group().at(-1).markdown, dm().at(-1)], ['又好了。\n@设计：切图', `✅ ${H}，看一下（${G}）\n群里已回「又好了」`], '不是负责人的不进私信')
      // aven 私信发起的：「群」就是他的私信，事项照常列出
      const mine = task({ id: 'om_4', messageId: 'om_4', chatType: 'p2p', operator: 'ou_aven', outcome: out({ summary: '改好了。', followUps: [{ owner: 'aven', items: ['合并到 online 后部署'] }] }) })
      await deliverOutcome({ config, store, task: mine, status: 'done', deps })
      assert.equal(group().at(-1).markdown, '改好了。\n<at user_id="ou_aven">aven</at>：合并到 online 后部署')
    })],
    // 11-04 b3 ep-1031-35935b：改码 done 带了兑现「收到」的复测条目，超长转文档只留第一行（改码摘要），「pre 复测没做」只在文档里
    ['超长转文档：改码 done 带复测条目 → 群里留放得下的开头几行（复测条目在内）；没条目的改码、代答照旧只留第一行', () => quiet(async () => {
      const note = '细'.repeat(140)
      const items = [{ mark: 'not_done', name: '帖子回复 pre 复测', note }, { mark: 'not_done', name: '完善资料到账', note }, { mark: 'ok', name: '完善资料申报', note }]
      const t = task({ branch: 'fix/profile', outcome: out({ summary: '已接入完善资料。', changedFiles: ['a'], report: { subject: '评论积分 pre 复测', items } }) })
      await deliverOutcome({ config, store, task: t, status: 'done', deps })
      assert.equal(group().at(-1).markdown, `已接入完善资料。\n分支 fix/profile · 改了 1 个文件\n评论积分 pre 复测：通了 1 项，没通 2 项\n- ❌ 帖子回复 pre 复测：${note}\n- ❌ 完善资料到账：${note}\n完整内容：https://doc/1`)
      const plain = task({ id: 'om_p', messageId: 'om_p', branch: 'fix/x', outcome: out({ summary: '已接入完善资料。', changedFiles: ['a'], followUps: [{ owner: '后端', items: [note, note, note, note] }] }) })
      await deliverOutcome({ config, store, task: plain, status: 'done', deps })
      assert.equal(group().at(-1).markdown, '已接入完善资料。\n完整内容：https://doc/1', '没复测条目：只留第一行')
      const ans = task({ id: 'om_q', messageId: 'om_q', operator: 'ou_aven', contract: { deliverable: 'verification' }, outcome: out({ report: { subject: '评论积分', items: [...items, { mark: 'ok', name: '再一项', note }] } }) })
      await deliverOutcome({ config, store, task: ans, status: 'done', deps })
      assert.equal(group().at(-1).markdown, '评论积分：通了 2 项，没通 2 项\n完整内容：https://doc/1', '实测：只留第一行')
    })],
    // 11-03 静态 review R12：docUrl 原先不持久化，回执没送达时 retryPendingReceipts 每 5 分钟重跑 deliverOutcome 都建一份细节文档（上限 12 份同内容）。
    ['细节文档只建一次：同任务同代同状态重发（回执重试）复用第一次建成的 docUrl；换代另建', () => quiet(async () => {
      const t = task({ contract: { deliverable: 'answer' }, outcome: out({ report: { subject: 'test / pre', answer: '不一样。', items: [] }, detailDoc: '# 三行提交' }) })
      const published = []
      let down = true
      const publish = async (args) => { published.push(args); return { ok: true, url: `https://doc/${published.length}`, reason: null } }
      const replyMarkdown = async (args) => (down ? { ok: false, messageId: null, reason: 'network down', via: null } : deps.replyMarkdown(args))
      const first = await deliverOutcome({ config, store, task: t, status: 'done', deps: { ...deps, publish, replyMarkdown } })
      assert.deepEqual([first.ok, first.docUrl, published.length], [false, 'https://doc/1', 1])
      assert.deepEqual(store.get('om_1').publishedDoc, { key: 'om_1-e1-done', url: 'https://doc/1' }, '第一次建成的 docUrl 记在任务上')
      down = false
      const second = await deliverOutcome({ config, store, task: store.get('om_1'), status: 'done', deps: { ...deps, publish, replyMarkdown } })
      assert.deepEqual([second.ok, second.docUrl, published.length], [true, 'https://doc/1', 1], '重试复用，不再建第二份')
      assert.equal(group().at(-1).markdown, '<at user_id="ou_qa"></at> 不一样。\n材料在这里：https://doc/1', '群里附的是复用的那份')
      const next = store.get('om_1')
      next.epoch = 2
      const third = await deliverOutcome({ config, store, task: next, status: 'done', deps: { ...deps, publish, replyMarkdown } })
      assert.deepEqual([third.docUrl, published.length, store.get('om_1').publishedDoc.key], ['https://doc/2', 2, 'om_1-e2-done'], '换代是新一轮结论，另建')
      const failedDoc = task({ id: 'om_nodoc', messageId: 'om_nodoc', contract: { deliverable: 'answer' }, outcome: out({ report: { subject: 's', answer: '答', items: [] }, detailDoc: '# x' }) })
      await deliverOutcome({ config, store, task: failedDoc, status: 'done', deps: { ...deps, publish: async () => ({ ok: false, url: null, reason: 'quota' }) } })
      assert.equal('publishedDoc' in store.get('om_nodoc'), false, '建不成不记（下次再试）')
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
      assert.equal(group()[0].markdown, '<at user_id="ou_qa"></at> 不一样，test 比 pre 多 3 个提交。\n- a1 修复\n材料在这里：https://doc/1')
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
    // 11-03 falive 回放裁判 wrong_target：复测 / 代答结论回的是提问人的消息，正文却 @ 待跟进里点名的人（Kai / Encone），提问人没被 @，像在催别人。
    ['代答 / 实测结论 @ 谁：行首 @ 提问人（回复原消息也 @）；待跟进只 @ 要动手的；提问人已在待跟进 / 私信发起的不另 @；没做成照样 @ 提问人', () => quiet(async () => {
      const t = task({ contract: { deliverable: 'answer' }, outcome: out({ report: { answer: '查过了，是后端没返回。', items: [] }, followUps: [{ owner: 'William', items: [] }, { owner: '后端', items: ['补字段'] }] }) })
      await deliverOutcome({ config, store, task: t, status: 'done', deps })
      assert.equal(group()[0].markdown, '<at user_id="ou_qa"></at> 查过了，是后端没返回。\n<at user_id="ou_be">后端</at>：补字段', '提问人在行首；William 没事要做不 @')
      const asked = task({ id: 'om_2', messageId: 'om_2', operator: 'ou_w', contract: { deliverable: 'verification' }, outcome: out({ report: { subject: '充值', items: [{ mark: 'ok', name: '充值' }] }, followUps: [{ owner: 'William', items: ['再测提现'] }] }) })
      await deliverOutcome({ config, store, task: asked, status: 'done', deps })
      assert.equal(group()[1].markdown, '充值\n- ✅ 充值\n<at user_id="ou_w">William</at>：再测提现', '提问人就在待跟进里：不在行首再 @ 一次')
      const p2p = task({ id: 'om_3', messageId: 'om_3', chatType: 'p2p', contract: { deliverable: 'answer' }, outcome: out({ report: { answer: '私信里的答案。', items: [] } }) })
      await deliverOutcome({ config, store, task: p2p, status: 'done', deps })
      assert.equal(group()[2].markdown, '私信里的答案。', '私信发起的不 @')
      const failed = task({ id: 'om_4', messageId: 'om_4', contract: { deliverable: 'answer' }, outcome: out({ report: { answer: '查不到。', items: [] }, followUps: [{ owner: '后端', items: ['补字段'] }] }) })
      await deliverOutcome({ config, store, task: failed, status: 'failed', deps })
      assert.equal(group()[3].markdown, '<at user_id="ou_qa"></at> 查不到。', '没做成也是给提问人的结论；待跟进照旧只在做成时 @')
      const named = task({ id: 'om_5', messageId: 'om_5', operator: 'ou_be', contract: { deliverable: 'answer' }, outcome: out({ report: { answer: '后端问的答案。', items: [] } }) })
      await deliverOutcome({ config, store, task: named, status: 'done', deps })
      assert.deepEqual([group()[4].markdown, dm().at(-1)], ['<at user_id="ou_be">后端</at> 后端问的答案。', `💬 替你答了（${G}）：后端问的答案`], '提问人在 ownerMap 里带名字；私信首行不带 @')
      // 待跟进里写给负责人的：群里不 @ 他，私信里另起一行（fix10 review）；他自己在群里问的也私信，不然事项没地方看
      const ownTask = task({ id: 'om_6', messageId: 'om_6', contract: { deliverable: 'answer' }, outcome: out({ report: { answer: '要改配置。', items: [] }, followUps: [{ owner: 'aven', items: ['合并到 online 后部署'] }] }) })
      await deliverOutcome({ config, store, task: ownTask, status: 'done', deps })
      assert.deepEqual([group()[5].markdown, dm().at(-1)], ['<at user_id="ou_qa"></at> 要改配置。', `💬 替你答了（${G}）：要改配置\n你这边：合并到 online 后部署`])
      const ownAsk = task({ id: 'om_7', messageId: 'om_7', operator: 'ou_aven', contract: { deliverable: 'answer' }, outcome: out({ report: { answer: '自己问的。', items: [] }, followUps: [{ owner: 'aven', items: ['定口径'] }] }) })
      await deliverOutcome({ config, store, task: ownAsk, status: 'done', deps })
      assert.deepEqual([group()[6].markdown, dm().at(-1)], ['自己问的。', `💬 替你答了（${G}）：自己问的\n你这边：定口径`])
    })],
    // fix16 review：负责人自己的事项（ownItems）原先只在代答群里发成功时才进私信——被出口闸拦下、没写群回复、groupSilent、record 交付物都丢了。
    ['待跟进里有负责人的事项：群里没发成 / 不发群 / 交付物本不私信时也私信一条，群里发成功那条已含就不再单发', () => quiet(async () => {
      const own = (items) => [{ owner: 'aven', items }]
      const answer = (id, raw) => task({ id, messageId: id, contract: { deliverable: 'answer' }, outcome: out(raw) })
      await deliverOutcome({ config, store, task: answer('om_1', { report: { answer: '同一个答案。', items: [] }, followUps: own(['定口径']) }), status: 'done', deps })
      assert.deepEqual(dm(), [`💬 替你答了（${G}）：同一个答案\n你这边：定口径`], '群里发成功：只发含事项的那一条')
      sent.length = 0
      const gated = await deliverOutcome({ config, store, task: answer('om_2', { report: { answer: '同一个答案。', items: [] }, followUps: own(['再定口径']) }), status: 'done', deps })
      assert.deepEqual([gated.ok, group().length, dm().length], [false, 0, 1])
      assert.match(dm()[0], new RegExp(`^📌 ${H}，看一下（${G}）\\n群里没发（出口闸拦下：同内容 .*）。\\n你这边：再定口径$`))
      sent.length = 0
      await deliverOutcome({ config, store, task: answer('om_3', { summary: null, followUps: own(['补数据']) }), status: 'done', deps })
      await deliverOutcome({ config, store, task: answer('om_4', { groupSilent: true, report: { answer: '不用回群。', items: [] }, followUps: own(['看日志']) }), status: 'done', deps })
      await deliverOutcome({ config, store, task: task({ id: 'om_5', messageId: 'om_5', contract: { deliverable: 'record' }, outcome: out({ summary: '记下了。', followUps: own(['周五前排期']) }) }), status: 'done', deps })
      await deliverOutcome({ config, store, task: answer('om_6', { groupSilent: true, report: { answer: '没事项。', items: [] } }), status: 'done', deps })
      assert.deepEqual([group().map((item) => item.markdown), dm()], [['记下了。'], [
        `📌 ${H}，看一下（${G}）\n群里没发（没写群回复）。\n你这边：补数据`,
        `📌 ${H}，看一下（${G}）\n你这边：看日志`,
        `📌 ${H}，看一下（${G}）\n群里已回「记下了」\n你这边：周五前排期`,
      ]], '没写群回复 / groupSilent / record 各一条；没事项的照旧不私信')
      assert.deepEqual(store.get('om_4').receipts.map((r) => r.kind), ['answered'])
    })],
    // 11-03 静态 review R8 后半：在跑 / 没开跑时并入的别人的消息（appended / rerun_after_done）只记 mergedFrom、结论仍回原消息，并入人只得到一句「收到」。
    ['并入的别人的补充：结论末行 @ 那些提单人（去重；排除负责人 / 本任务提单人 / bot / 已 @ 的 / 已清掉的）；还欠一轮重跑的留给重跑那轮；@ 过的下一轮不再 @', () => quiet(async () => {
      const cfg = { ...config, botOpenId: 'ou_bot' }
      for (const [id, operator] of [['om_m1', 'ou_b1'], ['om_m2', 'ou_b1'], ['om_m3', 'ou_aven'], ['om_m4', 'ou_qa'], ['om_m5', 'ou_bot'], ['om_m6', 'ou_w'], ['om_m7', 'oc_g'], ['om_m8', 'ou_be']]) store.upsert({ id, chatId: 'oc_g', operator, status: 'superseded', supersededBy: 'om_1' })
      const mergedFrom = ['om_m1', 'om_m2', 'om_m3', 'om_m4', 'om_m5', 'om_m6', 'om_m7', 'om_gone']
      const t = task({ mergedFrom, rerunAfterDone: true, outcome: out({ summary: '第一轮修好了。' }) })
      await deliverOutcome({ config: cfg, store, task: t, status: 'done', deps })
      assert.equal(group()[0].markdown, '第一轮修好了。', '这轮没带上补充（跑完再跑一轮），先不 @ 并入人')
      assert.equal(store.get('om_1').mergedNotified, undefined)
      const rerun = store.get('om_1')
      delete rerun.rerunAfterDone
      rerun.epoch = 2
      rerun.outcome = out({ summary: '带上补充又跑了一轮。' })
      await deliverOutcome({ config: cfg, store, task: rerun, status: 'done', deps })
      assert.equal(group()[1].markdown, '带上补充又跑了一轮。\n<at user_id="ou_b1"></at> <at user_id="ou_w">William</at> 你们的补充也一起处理了。')
      assert.deepEqual(store.get('om_1').mergedNotified, mergedFrom, '这轮覆盖到的并入都记下')
      const later = store.get('om_1')
      later.epoch = 3
      later.mergedFrom = [...mergedFrom, 'om_m8']
      later.outcome = out({ summary: '第三轮。' })
      await deliverOutcome({ config: cfg, store, task: later, status: 'done', deps })
      assert.equal(group()[2].markdown, '第三轮。\n<at user_id="ou_be">后端</at> 你的补充也一起处理了。', '只 @ 新并入的')
      const answer = task({ id: 'om_a', messageId: 'om_a', mergedFrom: ['om_m1', 'om_m6'], contract: { deliverable: 'answer' }, outcome: out({ report: { answer: '答案。', items: [] }, followUps: [{ owner: 'William', items: ['复测'] }] }) })
      await deliverOutcome({ config: cfg, store, task: answer, status: 'done', deps })
      assert.equal(group()[3].markdown, '<at user_id="ou_qa"></at> 答案。\n<at user_id="ou_w">William</at>：复测\n<at user_id="ou_b1"></at> 你的补充也一起处理了。', '已在待跟进里 @ 的不再进补充行')
      const blocked = task({ id: 'om_b', messageId: 'om_b', mergedFrom: ['om_m1'], outcome: out({ blockers: ['负责人确认归属'] }) })
      await deliverOutcome({ config: cfg, store, task: blocked, status: 'blocked', deps })
      assert.equal(store.get('om_b').mergedNotified, undefined, '群里没发结论不记')
      const held = task({ id: 'om_h', messageId: 'om_h', mergedFrom: ['om_m6'], outcome: out({ groupReply: '改了一半。' }) })
      await deliverOutcome({ config: cfg, store, task: held, status: 'failed', deps })
      assert.deepEqual([getObligation(held).heldDraft.text, getObligation(held).heldDraft.mentions.map((m) => m.openId), store.get('om_h').mergedNotified], ['改了一半。', [], undefined], '没做成的草稿不带并入人、不记（fix10 review：留给真出结论那轮）')
      // 代答类 blocked / waiting / failed 也发群，但那不是结论：不 @ 并入人、不记 mergedNotified，否则真出结论时他们不再被 @（fix10 review）
      const pending = task({ id: 'om_p', messageId: 'om_p', mergedFrom: ['om_m1'], contract: { deliverable: 'answer' }, outcome: out({ report: { answer: '还在等后端。', items: [] } }) })
      for (const [i, status] of ['blocked', 'waiting_confirmation', 'failed'].entries()) {
        pending.epoch = i + 1
        await deliverOutcome({ config: cfg, store, task: pending, status, deps })
        assert.deepEqual([group().at(-1).markdown, store.get('om_p').mergedNotified], ['<at user_id="ou_qa"></at> 还在等后端。', undefined], status)
      }
      const concluded = store.get('om_p')
      concluded.epoch = 9
      concluded.outcome = out({ report: { answer: '后端修好了。', items: [] } })
      await deliverOutcome({ config: cfg, store, task: concluded, status: 'done', deps })
      assert.deepEqual([group().at(-1).markdown, store.get('om_p').mergedNotified], ['<at user_id="ou_qa"></at> 后端修好了。\n<at user_id="ou_b1"></at> 你的补充也一起处理了。', ['om_m1']], '真出结论那轮 @ 并记下')
      const noop = task({ id: 'om_n', messageId: 'om_n', mergedFrom: ['om_m6'], outcome: out({ summary: '是后端字段没返回。' }) })
      await deliverOutcome({ config: cfg, store, task: noop, status: 'no_change_needed', deps })
      assert.deepEqual([group().at(-1).markdown, store.get('om_n').mergedNotified], ['看过了，这个不用改前端：是后端字段没返回。\n<at user_id="ou_w">William</at> 你的补充也一起处理了。', ['om_m6']], '不用改也是结论')
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
      // 负责人私信里点名续跑的这一代（resumeAsk.epoch = 当前代次）：群里 @ 人要了材料，私信里也给他一句（b3 ep-1030-167d28）；代次过了 / 别人续的不发
      const asked = task({ id: 'om_6', messageId: 'om_6', epoch: 3, resumeAsk: { by: 'ou_aven', epoch: 3 }, outcome: out({ blockers: ['要 William 给 online 抓包'] }) })
      await deliverOutcome({ config, store, task: asked, status: 'blocked', deps })
      assert.deepEqual([group().length, dm()], [1, [`⏸ 接着做的「${H}，看一下」又停下了（${G}），已在群里找人要材料\n要：要 William 给 online 抓包`]])
      assert.equal(store.get('om_6').receipts.at(-1).kind, 'resumed')
      sent.length = 0
      const doneAsked = task({ id: 'om_7', messageId: 'om_7', epoch: 2, resumeAsk: { by: 'ou_aven', epoch: 2 }, outcome: out({ summary: '前端不用改，后端核对绑定' }) })
      await deliverOutcome({ config, store, task: doneAsked, status: 'no_change_needed', deps })
      assert.deepEqual(dm(), [`📨 接着做的「${H}，看一下」有结论了（${G}），群里已回：看过了，这个不用改前端：前端不用改，后端核对绑定`])
      sent.length = 0
      const stale = task({ id: 'om_8', messageId: 'om_8', epoch: 4, resumeAsk: { by: 'ou_aven', epoch: 3 }, outcome: out({ blockers: ['要 William 给 uat 抓包'] }) })
      await deliverOutcome({ config, store, task: stale, status: 'blocked', deps })
      assert.deepEqual([group().length, dm()], [1, []])
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
      // 11-04 b3：对接答复逐项复测后不用改——归别人跟的（followUps）照样每人一行
      const followed = task({ id: 'om_nf', messageId: 'om_nf', outcome: out({ summary: '前端不用改', owner: null, followUps: [{ owner: 'William', items: ['配 APK 地址'] }] }) })
      await deliverOutcome({ config, store, task: followed, status: 'no_change_needed', deps })
      assert.match(group()[0].markdown, /^看过了，这个不用改前端：前端不用改。\n(?:@William|<at user_id="ou_w">William<\/at>)：配 APK 地址$/)
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
