import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  addressTo, changeFacts, chatLabel, dedupeMentions, firstClause, firstSentence, headline, humanizeLegacyResult, mentionTag, resolveOwnerMention,
  sayAck, sayBlockedAsk, sayDigest, sayDoneAnswerGroup, sayDoneAnswerPrincipal, sayDoneChangeGroup, sayDoneChangePrincipal, sayFailedNotice, sayFailedPrincipal,
  sayHeldDraft, sayHeldFailed, sayHeldReleased, sayHeldStale, sayIgnoredAfterAck, sayIntakeFailed, sayMergedSupplement, sayNoChangeGroup, sayNoted, sayOps, sayOverdue, sayReminderGroup,
  sayReminderPrincipal, sayStart, saySuspected, saySuspectedExpired, trimPunct,
} from '../lib/lark-human-text.mjs'
import { applyRunEvidence, collectRunEvidence, normalizeOutcome, normalizeReport, renderReport, unverifiedClaims } from '../lib/lark-report-render.mjs'
import { eachCase, runSteps } from './support/steps.mjs'

// 结构化群回复（falive 10-21 P6 的用例搬来）：第一行数字由条目算，不会再出现「都通了」又列问题；实测声明按会话记录核实。
const item = (mark, name, extra = {}) => ({ mark, name, note: '', evidence: 'none', ...extra })

// 对话层出口文案（计划 §4.1，aven 2026-11-01）：每一格的字符串逐字钉住；一个 it，表驱动。
const task = { id: 'om_1', epoch: 2, chatId: 'oc_g', operator: 'ou_qa', summary: '登录页报错，看一下。然后别的', branch: 'fix/login', changedFiles: ['a', 'b', 'c'] }
const H = '登录页报错，看一下'
const G = '测试群'
const answerReport = normalizeReport({ subject: 'test / pre 代码', answer: '不一样，test 比 pre 多 3 个提交。', items: [{ mark: 'remark', name: 'a1 修复' }] })
const verifyReport = normalizeReport({ subject: '注册登录', items: [{ mark: 'ok', name: '注册', note: 'pre 通', evidence: 'pre' }, { mark: 'unverified', name: '登录' }] })
const allOkReport = normalizeReport({ subject: '注册登录', items: [{ mark: 'ok', name: '注册' }, { mark: 'ok', name: '登录' }] })

const CELLS = [
  { name: 'ack 有 reply', got: () => sayAck({ reply: '能发，我看下要发什么。' }), want: '能发，我看下要发什么。' },
  { name: 'ack 无 reply（只有标点也算无）', got: () => [sayAck({ reply: null }), sayAck({ reply: '。' })], want: ['收到，我看一下，稍后回你。', '收到，我看一下，稍后回你。'] },
  { name: 'noted', got: () => [sayNoted({ reply: '好，记下了' }), sayNoted({})], want: ['好，记下了。', '收到，记下了。'] },
  { name: 'start 首次 / 续跑', got: () => [sayStart({ task, chatLabel: G }), sayStart({ task, chatLabel: G, resumeCount: 0 }), sayStart({ task, chatLabel: G, resumeCount: 2 })], want: [`🛠 开始做：${H}（${G}）`, `🛠 开始做：${H}（${G}）`, `🛠 接着做（第 2 次续跑）：${H}`] },
  {
    name: 'done · change（群）：摘要首句 / 事实 / 每人一行 / 详细见',
    got: () => sayDoneChangeGroup({ task, outcome: { summary: '登录页报错修好了。改了校验。' }, mentions: [{ name: '后端', openId: 'ou_be', items: ['补接口', '改字段'] }, { name: 'QA', openId: 'ou_qa', items: [] }, { name: '', openId: 'ou_x', items: ['看一眼'] }], docUrl: 'https://d/1' }),
    want: '登录页报错修好了。\n分支 fix/login · 改了 3 个文件\n@后端：补接口；改字段\n<at user_id="ou_x"></at>：看一眼\n详细见：https://d/1',
  },
  { name: 'done · change（群）：没有事实 / 文档', got: () => sayDoneChangeGroup({ task: { summary: 'x' }, outcome: { summary: '修好了' } }), want: '修好了' },
  {
    name: 'done · change（aven）：群里已回 / 没发（扣下）/ 没发（原因）/ 没群结果 / 待跟进里写给他的事项（群里不 @ 他，fix10 review）',
    got: () => [
      sayDoneChangePrincipal({ task, chatLabel: G, groupOutcome: { ok: true, text: '登录页报错修好了。\n第二行' } }),
      sayDoneChangePrincipal({ task, chatLabel: G, groupOutcome: { ok: false, held: true, reason: '任务没做成（failed），回答先给你看', text: 'x' } }),
      sayDoneChangePrincipal({ task: { ...task, branch: null, changedFiles: [] }, chatLabel: G, groupOutcome: { ok: false, reason: '出口闸拦下：同内容' } }),
      sayDoneChangePrincipal({ task, chatLabel: G, groupOutcome: null }),
      sayDoneChangePrincipal({ task, chatLabel: G, groupOutcome: { ok: true, text: '修好了' }, ownItems: ['合并到 online 后部署', '通知 QA'] }),
    ],
    want: [
      `✅ ${H}（${G}）· 分支 fix/login · 改了 3 个文件\n群里已回「登录页报错修好了」`,
      `✅ ${H}（${G}）· 分支 fix/login · 改了 3 个文件\n群里没发（任务没做成（failed），回答先给你看）。没问题就回「就这样回」，我按原文发群。`,
      `✅ ${H}（${G}）\n群里没发（出口闸拦下：同内容）。`,
      `✅ ${H}（${G}）· 分支 fix/login · 改了 3 个文件`,
      `✅ ${H}（${G}）· 分支 fix/login · 改了 3 个文件\n群里已回「修好了」\n你这边：合并到 online 后部署；通知 QA`,
    ],
  },
  {
    name: 'done · answer（群）：report 原样不加 ✅；带材料；report 空用 groupReply / summary；都空 → 空串',
    got: () => [
      sayDoneAnswerGroup({ outcome: { report: answerReport } }),
      sayDoneAnswerGroup({ outcome: { report: answerReport }, docUrl: 'https://d/2' }),
      sayDoneAnswerGroup({ outcome: { report: null, groupReply: '群回复', summary: '摘要' } }),
      sayDoneAnswerGroup({ outcome: { report: null, summary: '查不到，得问后端。' } }),
      sayDoneAnswerGroup({ outcome: { report: null }, docUrl: 'https://d/3' }),
    ],
    want: ['不一样，test 比 pre 多 3 个提交。\n- a1 修复', '不一样，test 比 pre 多 3 个提交。\n- a1 修复\n材料在这里：https://d/2', '群回复', '查不到，得问后端。', ''],
  },
  // 11-03 falive 回放 wrong_target：代答 / 实测结论正文 @ 的是待跟进里点名的人，提问人反而没 @，像在催别人。
  {
    name: 'done · answer（群）：行首 @ 提问人（有名字写 @名）；待跟进只列要动手的、每人一行在材料链接前',
    got: () => [
      sayDoneAnswerGroup({ outcome: { report: answerReport }, asker: { name: '', openId: 'ou_qa' }, mentions: [{ name: 'Kai', openId: 'ou_k', items: ['复测充值', '看日志'] }, { name: 'Eric', openId: 'ou_e', items: [] }], docUrl: 'https://d/4' }),
      sayDoneAnswerGroup({ outcome: { report: null, groupReply: '群回复' }, asker: { name: 'Ache', openId: 'ou_a' } }),
      sayDoneAnswerGroup({ outcome: { report: null }, asker: { name: 'Ache', openId: 'ou_a' }, mentions: [{ name: 'Kai', openId: 'ou_k', items: ['x'] }] }),
    ],
    want: ['<at user_id="ou_qa"></at> 不一样，test 比 pre 多 3 个提交。\n- a1 修复\n@Kai：复测充值；看日志\n材料在这里：https://d/4', '@Ache 群回复', ''],
  },
  {
    name: '并入的补充（群，结论末行）：一人「你的」/ 多人「你们的」/ 没人空串',
    got: () => [sayMergedSupplement({ mentions: [{ name: 'A', openId: 'ou_a' }] }), sayMergedSupplement({ mentions: [{ name: 'A', openId: 'ou_a' }, { name: '', openId: 'ou_b' }] }), sayMergedSupplement({ mentions: [] }), sayMergedSupplement({})],
    want: ['@A 你的补充也一起处理了。', '@A <at user_id="ou_b"></at> 你们的补充也一起处理了。', '', ''],
  },
  {
    name: 'done · answer（aven）：首行 / 待跟进里写给他的事项另起一行',
    got: () => [sayDoneAnswerPrincipal({ chatLabel: G, firstLine: '不一样，test 比 pre 多 3 个提交' }), sayDoneAnswerPrincipal({ chatLabel: G, firstLine: '查过了', ownItems: ['定口径'] })],
    want: [`💬 替你答了（${G}）：不一样，test 比 pre 多 3 个提交`, `💬 替你答了（${G}）：查过了\n你这边：定口径`],
  },
  {
    name: 'done · verification（群）：通了 a 项没通 b 项 + 条目符号 / 都通了',
    got: () => [sayDoneAnswerGroup({ outcome: { report: verifyReport } }), sayDoneAnswerGroup({ outcome: { report: allOkReport } })],
    want: ['注册登录：通了 1 项，没通 1 项\n- ⚠️ 待验证 登录\n- ✅ 注册：pre 通', '注册登录：都通了\n- ✅ 注册\n- ✅ 登录'],
  },
  { name: 'no_change（群）有 / 无 owner', got: () => [sayNoChangeGroup({ outcome: { summary: '是后端字段没返回。', owner: '后端' } }), sayNoChangeGroup({ outcome: { summary: '是后端字段没返回' } })], want: ['看过了，这个不用改前端：是后端字段没返回。要 后端 看下。', '看过了，这个不用改前端：是后端字段没返回。'] },
  {
    name: 'blocked_ask（群）：缺材料 / 根因在对方 / 没标题 / 条目最多 6 条 / 没名字的 @',
    got: () => [
      sayBlockedAsk({ task, mentions: [{ name: 'William', openId: 'ou_w' }], items: ['接口返回示例', '字段说明'] }),
      sayBlockedAsk({ task, mentions: [{ name: 'William', openId: 'ou_w' }, { name: '', openId: 'ou_z' }], items: ['改返回'], fixElsewhere: true }),
      sayBlockedAsk({ task: { summary: '' }, mentions: [], items: ['1', '2', '3', '4', '5', '6', '7'] }),
    ],
    want: [
      `@William 「${H}」需要你们帮忙：\n- 接口返回示例\n- 字段说明`,
      `@William <at user_id="ou_z"></at> 「${H}」查到根因在你们那边，请处理：\n- 改返回`,
      '需要你们帮忙：\n- 1\n- 2\n- 3\n- 4\n- 5\n- 6',
    ],
  },
  {
    name: 'held draft（aven）：停下来了 + 要 / 没做成 / 没回过收到 / 没草稿',
    got: () => [
      sayHeldDraft({ task, chatLabel: G, status: 'blocked', outcome: { blockers: ['接口文档', '账号'] }, ackText: '收到，我看一下。', draft: '草稿第一行\n第二行' }),
      sayHeldDraft({ task, chatLabel: G, status: 'failed', outcome: { summary: '构建红了' }, ackText: '收到', draft: '草稿' }),
      sayHeldDraft({ task, chatLabel: G, status: 'failed', outcome: {}, ackText: null, draft: '草稿' }),
      sayHeldDraft({ task, chatLabel: G, status: 'waiting_confirmation', outcome: { blockers: [] }, ackText: '收到', draft: '' }),
      sayHeldDraft({ task, chatLabel: G, status: 'blocked', outcome: { blockers: ['接口文档'] }, ackText: null, draft: '' }),
    ],
    want: [
      `⏸ 停下来了（${G}）：${H}\n要：接口文档；账号\n群里只回过「收到，我看一下」，结论还没发。没问题就回「就这样回」，我把下面这段原样发群：\n草稿第一行\n第二行`,
      `⛔ 没做成（${G}）：构建红了\n群里只回过「收到」，结论还没发。没问题就回「就这样回」，我把下面这段原样发群：\n草稿`,
      `⛔ 没做成（${G}）：${H}\n没问题就回「就这样回」，我把下面这段原样发群：\n草稿`,
      `⏸ 停下来了（${G}）：${H}\n群里只回过「收到」，结论还没发。`,
      `⏸ 停下来了（${G}）：${H}\n要：接口文档`,
    ],
  },
  { name: 'held release / stale / failed（aven）', got: () => [sayHeldReleased({ task }), sayHeldStale({ task }), sayHeldFailed({ reason: '原消息被撤回' })], want: [`已按原文回群（${H}）。`, `「${H}」这条已经发过更新的结论了，没有待放行的草稿。`, '没发出去：原消息被撤回。'] },
  { name: 'reminder r1（群）有 / 无 @', got: () => [sayReminderGroup({ task, blocker: '接口文档', mentions: [{ name: 'QA', openId: 'ou_qa' }] }), sayReminderGroup({ task, blocker: '接口文档。' })], want: [`@QA 「${H}」还在等你补：接口文档。补上回我一句就继续。`, `「${H}」还在等你补：接口文档。补上回我一句就继续。`] },
  // 11-02 复核：旧任务没 outcome / blockers 空 → 不拼 null，说「补材料」。
  { name: 'reminder r1（群）没有具体条目：null / undefined / 空串', got: () => [sayReminderGroup({ task, blocker: null, mentions: [{ name: 'QA', openId: 'ou_qa' }] }), sayReminderGroup({ task }), sayReminderGroup({ task, blocker: ' ' })], want: [`@QA 「${H}」还在等你补材料。补上回我一句就继续。`, `「${H}」还在等你补材料。补上回我一句就继续。`, `「${H}」还在等你补材料。补上回我一句就继续。`] },
  { name: 'reminder r2（aven）', got: () => sayReminderPrincipal({ task, chatLabel: G }), want: `⏰ 「${H}」（${G}）等了 8 小时没人补材料，我不再催群里了。要关掉回「取消任务 om_1」。` },
  { name: 'suspected（aven）', got: () => saySuspected({ task, chatLabel: G }), want: `❓ 可能是你的事（${G}）：${H}\n是 → 回「继续任务 om_1 做」；不是 → 回「取消任务 om_1」。不回也不催，48 小时后自动关。` },
  {
    name: 'suspected expired（aven，合并）/ 空',
    got: () => [saySuspectedExpired({ tasks: [task, { id: 'om_2', chatId: 'oc_h', summary: '充值问题' }], chatNames: { oc_g: G } }), saySuspectedExpired({ tasks: [] })],
    want: [`🧹 这 2 条疑似 48 小时没人认领，已关掉：\n- ${H}（${G}）\n- 充值问题（oc_h）`, ''],
  },
  { name: 'ignored-after-ack（aven）有 / 无理由', got: () => [sayIgnoredAfterAck({ task, chatLabel: G, reason: '只是通知' }), sayIgnoredAfterAck({ task, chatLabel: G, reason: null })], want: [`🤔 群里 @我 的这条看了，判断不用我处理（${G}）：${H}\n理由：只是通知\n判错了回「继续任务 om_1 做」。`, `🤔 群里 @我 的这条看了，判断不用我处理（${G}）：${H}\n理由：未给出\n判错了回「继续任务 om_1 做」。`] },
  { name: 'intake-failed（aven，11-03 R6）：分类器非瞬时失败，群里不承诺，私信一句', got: () => sayIntakeFailed({ task, chatLabel: G }), want: `⛔ 这条我没分出来是什么事，你看下（${G}）：${H}` },
  { name: 'overdue（aven）有 / 无 ack 文本', got: () => [sayOverdue({ task, chatLabel: G, ackText: '收到，我看一下。' }), sayOverdue({ task, chatLabel: G, ackText: null })], want: [`⏰ 群里答应过「收到，我看一下」（${G}），4 小时了还没结论，任务可能没跑完。要重跑回「继续任务 om_1」，不用管就忽略。`, `⏰ 群里答应过「收到」（${G}），4 小时了还没结论，任务可能没跑完。要重跑回「继续任务 om_1」，不用管就忽略。`] },
  { name: 'ops（aven）原样 / 失败', got: () => [sayOps({ text: 'online 已经是 9f3c2a1（上次部署），没有新内容，不发。' }), sayOps({ text: 'build 红', failed: true })], want: ['online 已经是 9f3c2a1（上次部署），没有新内容，不发。', '⛔ build 红'] },
  {
    name: 'failed · change（aven）：没做成 + 下一步 / 有旁证 / 没摘要用标题',
    got: () => [sayFailedPrincipal({ task, chatLabel: G, outcome: { summary: '构建红', nextStep: '要你看 CI' } }), sayFailedPrincipal({ task, chatLabel: G, outcome: { summary: '构建红' }, probablyDone: true }), sayFailedPrincipal({ task, chatLabel: G, outcome: null })],
    want: [`⛔ 没做成（${G}）：构建红\n要你看 CI`, `⚠ 可能做成了、但没拿到结果（${G}）：构建红`, `⛔ 没做成（${G}）：${H}`],
  },
  // 11-03 静态 review R13：failed 在控制活动态，提单人回原消息「怎么样了」原先回「还在处理中」；说实话。
  { name: 'failed · 群里问进度（对提单人）：说没做成、已告诉 aven；没标题用 id', got: () => [sayFailedNotice({ task }), sayFailedNotice({ task: { id: 'om_9' } })], want: [`「${H}」这条上次没做成，已经告诉 aven 了，不是还在处理。要关掉回「取消任务 om_1」，要重做直接 @我 再发一条。`, '「om_9」这条上次没做成，已经告诉 aven 了，不是还在处理。要关掉回「取消任务 om_9」，要重做直接 @我 再发一条。'] },
  {
    name: 'digest（aven 09:30）：分组 / 全空不发',
    got: () => [sayDigest({ suspected: [{ headline: 'A', chatLabel: '群1', time: '09:10' }], overdue: [{ headline: 'B', chatLabel: '群2', time: '08:00' }], held: [], parked: [] }), sayDigest({}), sayDigest({ held: [{ headline: 'C', chatLabel: '群3', time: '07:00' }], parked: [{ headline: 'D', chatLabel: '群4', time: '06:00' }] })],
    want: ['等你决定的 2 条\n疑似：\n- A（群1）· 09:10\n答应了没结论：\n- B（群2）· 08:00', '', '等你决定的 2 条\n扣下的群回复：\n- C（群3）· 07:00\n等材料超 24h：\n- D（群4）· 06:00'],
  },
]

describe('对话层出口文案（§4.1）', () => {
  it('每格文案逐字、@ 去重、事实行省略、标题回落、旧结果人话化', () => runSteps([
    ['§4.1 每格', () => eachCase(CELLS, ({ got, want }) => assert.deepEqual(got(), want))],
    ['mentionTag / dedupeMentions / addressTo', () => {
      assert.equal(mentionTag('ou_a', 'A'), '<at user_id="ou_a">A</at>')
      assert.equal(mentionTag('ou_a'), '<at user_id="ou_a"></at>')
      assert.equal(dedupeMentions('<at user_id="ou_a">A</at> <at user_id="ou_a">A</at> 看下 <at user_id="ou_b">B</at> 和 <at user_id="ou_a"></at>吧'), '<at user_id="ou_a">A</at> 看下 <at user_id="ou_b">B</at> 和 吧')
      assert.equal(dedupeMentions(''), '')
      assert.equal(addressTo({ openId: 'ou_a', name: 'A', body: '看下' }), '<at user_id="ou_a">A</at> 看下')
      assert.equal(addressTo({ openId: 'oc_g', body: '看下' }), '看下')
      assert.equal(addressTo({ openId: null, body: '看下' }), '看下')
    }],
    ['changeFacts：缺哪项省哪项', () => {
      assert.equal(changeFacts(task), '分支 fix/login · 改了 3 个文件')
      assert.equal(changeFacts({ changedFiles: ['a'] }), '改了 1 个文件')
      assert.equal(changeFacts({ branch: 'b', changedFiles: [] }), '分支 b')
      assert.equal(changeFacts({ branch: 'b', outcome: { changedFiles: ['x', 'y'] }, changedFiles: ['a'] }), '分支 b · 改了 2 个文件', '先看结构化结果')
      assert.equal(changeFacts({}), '')
      assert.equal(changeFacts(null), '')
    }],
    ['headline / firstClause / firstSentence / trimPunct / chatLabel', () => {
      assert.equal(headline({ ...task, outcome: { report: { subject: '对象' } }, privateOrigin: { anchorHead: '锚' } }), '对象')
      assert.equal(headline({ ...task, privateOrigin: { anchorHead: '群消息原话。后面' } }), '群消息原话')
      assert.equal(headline(task), H)
      assert.equal(headline({ text: '只有正文；后面' }), '只有正文')
      assert.equal(headline({ summary: '' }), '')
      assert.equal(headline(null), '')
      assert.equal(firstClause('a；b'), 'a')
      assert.equal(firstClause('a！b'), 'a')
      assert.equal(firstClause('a?b'), 'a')
      assert.equal(firstClause('x'.repeat(60)), 'x'.repeat(50))
      assert.equal(firstClause(''), '')
      assert.equal(firstSentence('修好了。改了校验。'), '修好了。')
      assert.equal(firstSentence('\n 没标点\n第二行'), '没标点')
      assert.equal(firstSentence(''), '')
      assert.equal(trimPunct('收到，我看一下。 '), '收到，我看一下')
      assert.equal(chatLabel({ chatId: 'oc_g', project: 'PR-1' }, { chatNames: { oc_g: G } }), G)
      assert.equal(chatLabel({ chatId: 'ou_aven' }), '私信')
      assert.equal(chatLabel({ chatId: 'oc_p2p', chatType: 'p2p' }), '私信', 'chatType 单独就算私信')
      assert.equal(chatLabel({ chatId: 'oc_dm', intake: { trigger: 'dm' } }), '私信', 'trigger=dm 单独就算私信')
      assert.equal(chatLabel({ chatId: 'oc_g', projectTitle: '标题', project: 'PR-1' }), '标题')
      assert.equal(chatLabel({ chatId: 'oc_g', chatName: '测试群', projectTitle: '标题', project: 'PR-1' }), '测试群', '入队时记下的群名优先于项目标题')
      assert.equal(chatLabel({ chatId: 'oc_p', chatType: 'p2p', chatName: '不该用' }), '私信')
      assert.equal(chatLabel({ chatId: 'oc_g', project: 'PR-1' }), 'PR-1')
      assert.equal(chatLabel({ chatId: 'oc_g' }), 'oc_g')
      assert.equal(chatLabel(null), '')
    }],
    ['resolveOwnerMention（从 cards 迁入，行为不变）', () => {
      const ownerMap = { 产品: 'ou_pm', QA: 'ou_qa' }
      assert.deepEqual(resolveOwnerMention({ owner: '产品', ownerMap, operator: 'ou_op' }), { mentionOpenId: 'ou_pm', ownerNote: null, matched: true })
      assert.deepEqual(resolveOwnerMention({ owner: '产品经理小王', ownerMap, operator: 'ou_op' }), { mentionOpenId: 'ou_pm', ownerNote: null, matched: true })
      assert.deepEqual(resolveOwnerMention({ owner: '设计', ownerMap, operator: 'ou_op' }), { mentionOpenId: 'ou_op', ownerNote: '（未在责任人表识别「设计」，暂 @ 提单人）', matched: false })
      assert.deepEqual(resolveOwnerMention({ owner: '设计', ownerMap }), { mentionOpenId: null, ownerNote: null, matched: false })
      assert.deepEqual(resolveOwnerMention({ owner: '', ownerMap, operator: 'ou_op' }), { mentionOpenId: 'ou_op', ownerNote: null, matched: false })
      assert.deepEqual(resolveOwnerMention({ owner: '产品', ownerMap: null, operator: 'ou_op' }), { mentionOpenId: 'ou_op', ownerNote: '（未在责任人表识别「产品」，暂 @ 提单人）', matched: false })
      assert.deepEqual(resolveOwnerMention(), { mentionOpenId: null, ownerNote: null, matched: false })
    }],
    ['humanizeLegacyResult：去定型首行、编号、加粗、机器行与范围契约块', () => {
      const legacy = '已完成，待发布。\n1. **修了** 登录\n- 保留的条目\n判定：bug\n修改范围契约：x\n契约目标：y\n- a\n…另 2 项\n• 不在契约里的行\n2. 下一步：看 CI\n依据：z\n待补充：接口文档；账号\n'
      assert.deepEqual(humanizeLegacyResult(legacy), ['修了 登录', '- 保留的条目', '不在契约里的行', '下一步：看 CI', '待补充：接口文档；账号'])
      assert.deepEqual(humanizeLegacyResult(legacy, { maxLines: 1 }), ['修了 登录'])
      assert.deepEqual(humanizeLegacyResult('无需改动。\n处理失败。\n已阻塞，需外部材料 / 权限后才能继续。\n需人工确认 / 补充材料后才能继续。'), [])
      assert.deepEqual(humanizeLegacyResult(null), [])
    }],
    ['结构化群回复：首行按条目算、计数项不到 2 项不写计数、标签只留符号、代答只列保留项且不截断、结构不对回 null、待发布按通了收', () => {
      assert.equal(renderReport(normalizeReport({ subject: 'front/lives 复测', answer: null, items: [item('ok', '第 2 页', { note: '不再报错' }), item('ok', '第 3 页', { note: '为空说明到底了' })] })),
        'front/lives 复测：都通了\n- ✅ 第 2 页：不再报错\n- ✅ 第 3 页：为空说明到底了')
      assert.equal(renderReport(normalizeReport({ subject: '直播详情页', answer: null, items: [item('ok', '礼物'), item('not_usable', 'getRoomInfo', { note: '非主播回 500' }), item('na', '分享')] })),
        '直播详情页：通了 1 项，没通 1 项\n- ⚠️ getRoomInfo：非主播回 500\n- ✅ 礼物\n- ➖ 分享')
      // 计数项不到 2 项不写计数（aven 2026-10-28）；一项都没通不写统计（aven 10-30）
      assert.equal(renderReport(normalizeReport({ subject: '页脚运营位删除', answer: null, items: [item('ok', '页脚删除两列', { note: '本地连 pre 看过首页' })] })), '页脚运营位删除\n- ✅ 页脚删除两列：本地连 pre 看过首页')
      assert.equal(renderReport(normalizeReport({ subject: '+84 区号', answer: null, items: [item('na', '+84 手机号', { note: '后端配置' }), item('na', '收码测试账号')] })), '+84 区号\n- ➖ +84 手机号：后端配置\n- ➖ 收码测试账号')
      assert.equal(renderReport(normalizeReport({ subject: '分享', answer: null, items: [item('not_usable', '复制链接', { note: '500' }), item('na', '海报')] })), '分享\n- ⚠️ 复制链接：500\n- ➖ 海报')
      assert.equal(renderReport(normalizeReport({ subject: null, answer: null, items: [item('ok', '单项')] })), '- ✅ 单项', '没有对象也不留空行')
      const backend = (name) => item('not_usable', name, { note: '后端问题' })
      assert.equal(renderReport(normalizeReport({ subject: null, answer: '这 3 个都不用 web 改。', items: [backend('Bug-5139'), backend('Bug-5141')] })), '这 3 个都不用 web 改。\n- Bug-5139：后端问题\n- Bug-5141：后端问题', '代答且条目状态一样时不加标签')
      assert.equal(renderReport(normalizeReport({ subject: null, answer: 'a', items: [backend('x'), item('ok', 'y')] })), 'a\n- ⚠️ x：后端问题\n- ✅ y', '状态不一样仍带符号')
      assert.equal(renderReport(normalizeReport({ subject: null, answer: 'a', items: [backend('x'), '补充说明'] })), 'a\n- x：后端问题\n- 补充说明', 'remark 不算一种状态')
      assert.equal(renderReport(normalizeReport({ subject: '复测', answer: null, items: [backend('a'), item('not_done', 'b')] })), '复测\n- ⚠️ a：后端问题\n- ❌ b')
      assert.doesNotMatch(renderReport(normalizeReport({ subject: '复测', answer: null, items: [backend('a'), item('ok', 'b')] })), /接了但还不能用|通了 0 项|项没通/)
      assert.equal(renderReport(normalizeReport({ subject: null, answer: '头像用 getRoomInfo 的 userData.avatar', items: [] })), '头像用 getRoomInfo 的 userData.avatar')
      assert.equal(renderReport(null), '')
      for (const bad of [null, 'str', [item('ok', 'x')], { subject: 'x', answer: null, items: [] }, { subject: 'x', items: 'no' }]) assert.equal(normalizeReport(bad), null)
      assert.deepEqual(normalizeReport({ items: [null, 'x', { mark: 'ok', name: '  ' }, { mark: 'ok', name: ' a ', note: ' b  c ', evidence: 'nope' }] }).items, [{ mark: 'remark', name: 'x', note: '', evidence: 'none' }, { mark: 'ok', name: 'a', note: 'b c', evidence: 'none' }], '空条目丢掉、字符串条目按 remark、未知 evidence 按 none')
      const odd = normalizeReport({ subject: '预约 Tab', answer: null, items: [item('ok', '参数'), item('pending', 'Tab 显示', { note: '还没部署 pre' })] })
      assert.equal(renderReport(odd), '预约 Tab：通了 1 项，没通 1 项\n- ⚠️ Tab 显示：还没部署 pre\n- ✅ 参数', '未知 mark 按「还不能用」保留')
      const deploy = normalizeReport({ subject: '我要直播', answer: null, items: [item('awaiting_deploy', '开播记录列表'), item('not_usable', '取推流地址', { note: '要主播测试号' }), item('ok', '直播分类')] })
      assert.equal(renderReport(deploy), '我要直播：通了 2 项，没通 1 项\n- ⚠️ 取推流地址：要主播测试号\n- ✅ 开播记录列表\n- ✅ 直播分类')
      const curl = `curl -s -X POST 'https://pre.example/go-api/api/auth/login' -H 'Content-Type: application/json' -d '{"username":"t@probe.test","password":"x"}'`
      const answer = `复现 curl 如下（pre，测试号）：\n① 登录拿 token：\n${curl}\n取返回里的 data.token 记为 TOKEN。\n\n\n② 签到：\n${curl.replace('auth/login', 'checkinPointsTask/sign')}`
      const report = normalizeReport({ subject: null, answer, items: ['没替你调 sign（写操作）', '要走网关，直连 404'] })
      assert.equal(report.answer, answer.replace('\n\n\n', '\n\n'), '多行答案只收连续空行')
      assert.equal(renderReport(report), `${report.answer}\n- 没替你调 sign（写操作）\n- 要走网关，直连 404`)
      assert.deepEqual(normalizeReport(report), report, '网关再校验一遍结果不变')
      const longAnswer = Array.from({ length: 200 }, (_, i) => `第 ${i} 行 ${'x'.repeat(20)}`).join('\n')
      assert.equal(normalizeReport({ subject: null, answer: longAnswer, items: [] }).answer, longAnswer, '不截断')
      const many = normalizeReport({ subject: 's', answer: null, items: Array.from({ length: 15 }, (_, i) => item('ok', `第 ${i} 项`, { note: '长'.repeat(400) })) })
      assert.deepEqual([many.items.length, many.items[0].note.length], [15, 400], '不丢条目')
    }],
    ['实测声明核对：声称 pre / 浏览器实测但本轮没跑 → 那一项降成待验证；读不到会话记录不核；会话记录按 tool_use id 去重数探针 / 浏览器 / 直连接口', () => {
      const report = normalizeReport({ subject: '签到复测', answer: null, items: [item('ok', '签到', { evidence: 'pre' }), item('ok', '滚到底', { evidence: 'browser', note: '滚到底续拉正常' }), item('ok', '文案', { evidence: 'code' }), item('not_usable', '没通的', { evidence: 'pre' })] })
      assert.deepEqual(unverifiedClaims(report, { probeCalls: 1, browserCalls: 0 }).map((x) => x.name), ['滚到底'])
      assert.deepEqual(unverifiedClaims(report, { probeCalls: 0, browserCalls: 2 }).map((x) => x.name), ['签到'])
      assert.deepEqual(unverifiedClaims(report, { probeCalls: 0, browserCalls: 0 }).map((x) => x.name), ['签到', '滚到底'], '没通的条目不算声称实测')
      assert.deepEqual(unverifiedClaims(report, { probeCalls: 2, browserCalls: 2 }), [])
      assert.deepEqual(unverifiedClaims(report, null), [], '读不到会话记录不核')
      assert.deepEqual(unverifiedClaims(null, { probeCalls: 0, browserCalls: 0 }), [])
      const down = applyRunEvidence(report, { probeCalls: 1, browserCalls: 0 })
      assert.equal(renderReport(down), '签到复测：通了 2 项，没通 2 项\n- ⚠️ 没通的\n- ⚠️ 待验证 滚到底：滚到底续拉正常\n- ✅ 签到\n- ✅ 文案')
      assert.doesNotMatch(renderReport(down), /没实测/)
      assert.equal(applyRunEvidence(report, null), report)
      assert.equal(applyRunEvidence(null, { probeCalls: 0, browserCalls: 0 }), null)
      assert.equal(normalizeReport(down).items[1].mark, 'unverified', '网关再校验时认 unverified')
      const dir = mkdtempSync(join(tmpdir(), 'lark-evidence-'))
      try {
        const use = (id, command, name = 'Bash') => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: command == null ? {} : { command } }] } })
        writeFileSync(join(dir, 'a.jsonl'), [use('t1', "node scripts/pre-probe.mjs '[]'"), use('t1', "node scripts/pre-probe.mjs '[]'"), use('t2', 'cd /tmp && node -e "require(\'playwright\')"'), 'not json "tool_use"', JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'tool_use playwright' }] } })].join('\n'))
        writeFileSync(join(dir, 'b.jsonl'), use('t3', 'git diff'))
        // 页面工具：路径先赋给变量再 check 也算（10-28 页脚任务真测过被判没实测）；只 start / stop 不算；工具名本身像浏览器（mcp 的 playwright 工具，没有命令）也算
        writeFileSync(join(dir, 'c.jsonl'), [use('p1', 'T=/x/tools/verify-page.mjs; node $T start --cwd .; node $T check --cwd . --expect 关注我们 /'), use('p2', 'node /x/tools/verify-page.mjs stop --cwd .'), use('p3', 'node /x/tools/verify-page.mjs check /room/1'), use('p4', null, 'mcp__playwright__browser_click'), JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'p5', name: 'Bash', input: { script: 'node x/verify-page.mjs check /' } }] } })].join('\n'))
        assert.deepEqual(collectRunEvidence({ sessionFiles: [join(dir, 'c.jsonl')] }), { probeCalls: 0, browserCalls: 4, hosts: [] }, '没给探针命令就不按脚本名数探针')
        assert.deepEqual(collectRunEvidence({ sessionFiles: [join(dir, 'a.jsonl'), join(dir, 'b.jsonl')], probeCommand: 'node scripts/pre-probe.mjs' }), { probeCalls: 1, browserCalls: 1, hosts: [] })
        assert.deepEqual(collectRunEvidence({ sessionFiles: [join(dir, 'a.jsonl')], probeCommand: 'bash' }), { probeCalls: 0, browserCalls: 1, hosts: [] }, '探针命令里没有脚本文件名就不按名字数')
        assert.equal(collectRunEvidence({ sessionFiles: [join(dir, 'missing.jsonl'), null] }), null)
        assert.equal(collectRunEvidence({ sessionFiles: [] }), null)
        // 直连接口也算实测（10-29 OL 换域名直连 www.falive.com 被判没实测）；只是 grep 里带网址不算
        writeFileSync(join(dir, 'd.jsonl'), [use('h1', 'for p in /api/preload/lives /go-api/health; do curl -s -m 15 "https://www.falive.com$p"; done'), use('h2', 'wget -qO- http://x.test/a'), use('h3', 'grep -n "https://www.falive.com" build/service-hosts.ts')].join('\n'))
        // 页面工具按 input.url 打开的页面也记主机（mcp 浏览器工具没有 command）
        writeFileSync(join(dir, 'e.jsonl'), JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'u1', name: 'mcp__playwright__browser_navigate', input: { url: 'https://www.Fameex.com/login' } }] } }))
        assert.deepEqual(collectRunEvidence({ sessionFiles: [join(dir, 'e.jsonl')] }), { probeCalls: 0, browserCalls: 1, hosts: ['www.fameex.com'] })
        assert.deepEqual(collectRunEvidence({ sessionFiles: [join(dir, 'd.jsonl')] }), { probeCalls: 2, browserCalls: 0, hosts: ['www.falive.com', 'x.test'] }, '只记真发了请求的主机，grep 里的网址不算')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }],
    ['normalizeOutcome：非对象 → null；kind 只认 ai / ops / worker；字符串截 2000、数组截 40、followUps 10 人各 10 条、change 三字段；类型不对落 null', () => {
      for (const bad of [null, undefined, 'x', 3]) assert.equal(normalizeOutcome(bad), null)
      assert.deepEqual(normalizeOutcome({}), { kind: 'ai', summary: null, nextStep: null, failureKind: null, owner: null, warnings: [], blockers: [], noChangeReason: null, taskState: null, rootCauseLayer: null, report: null, groupReply: null, detailDoc: null, followUps: null, changedFiles: null, change: null, groupSilent: false, text: null })
      assert.deepEqual([normalizeOutcome({ kind: 'ops' }).kind, normalizeOutcome({ kind: 'worker' }).kind, normalizeOutcome({ kind: 'bogus' }).kind], ['ops', 'worker', 'ai'])
      const long = normalizeOutcome({ summary: ` ${'s'.repeat(2001)} `, nextStep: 'n'.repeat(2001), failureKind: 'f'.repeat(41), owner: 'o'.repeat(81), noChangeReason: 'r'.repeat(41), taskState: 't'.repeat(41), rootCauseLayer: 'l'.repeat(41), groupReply: 'g'.repeat(2001), detailDoc: 'd'.repeat(20001), text: 'x'.repeat(4001), warnings: Array.from({ length: 41 }, (_, i) => ` w${i} `), blockers: [1, '', ' b '], changedFiles: Array.from({ length: 101 }, (_, i) => `f${i}`) })
      assert.deepEqual([long.summary.length, long.nextStep.length, long.failureKind.length, long.owner.length, long.noChangeReason.length, long.taskState.length, long.rootCauseLayer.length, long.groupReply.length, long.detailDoc.length, long.text.length], [2000, 2000, 40, 80, 40, 40, 40, 2000, 20000, 4000])
      assert.deepEqual([long.warnings.length, long.warnings[0], long.blockers, long.changedFiles.length], [40, 'w0', ['b'], 100])
      assert.deepEqual(normalizeOutcome({ summary: '  ', warnings: 'x', changedFiles: 'x', followUps: 'x', report: 'x', groupSilent: 'yes' }), { ...normalizeOutcome({}), warnings: [], changedFiles: null, followUps: null, report: null, groupSilent: false })
      const follow = normalizeOutcome({ followUps: [null, 'x', { owner: 5 }, { owner: '  ' }, { owner: ` ${'后'.repeat(41)} `, items: [1, '', ' 补接口 ', ...Array.from({ length: 12 }, (_, i) => `i${i}`)] }, ...Array.from({ length: 10 }, (_, i) => ({ owner: `p${i}` }))] })
      assert.equal(follow.followUps.length, 10)
      assert.deepEqual([follow.followUps[0].owner, follow.followUps[0].items.length, follow.followUps[0].items[0], follow.followUps[1]], ['后'.repeat(40), 10, '补接口', { owner: 'p0', items: [] }])
      assert.equal(normalizeOutcome({ followUps: [{ owner: ' ' }] }).followUps, null, '过滤后空 → null')
      assert.deepEqual(normalizeOutcome({ change: { committed: 1, gate: 'g'.repeat(41), reason: 'r'.repeat(301) } }).change, { committed: true, gate: 'g'.repeat(40), reason: 'r'.repeat(300) })
      assert.deepEqual(normalizeOutcome({ change: {} }).change, { committed: false, gate: null, reason: null })
      assert.equal(normalizeOutcome({ change: 'committed' }).change, null)
      assert.deepEqual([normalizeOutcome({ groupSilent: true }).groupSilent, normalizeOutcome({ report: { answer: 'a', items: [] } }).report], [true, { subject: null, answer: 'a', items: [] }])
    }],
  ]))
})
