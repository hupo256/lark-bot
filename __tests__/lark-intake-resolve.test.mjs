/**
 * 对话层·收与分类（plan §3.3，11-01）：任务契约 deriveContract、入队门槛 intakeActionable、分类落态 applyIntakeClassification、
 * 主题归并 mergeTaskObjects，以及 store 的委托（resolveIntake / mergeIntoTask / listRecentForChat / expireSuspected / recordReceipt chatId）。
 * 一个 it 合并全部段（测试棘轮）；表驱动，每行翻转一处条件，给变异扫描用。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, mock } from 'node:test'

import { CONTRACT_VERSION, deriveContract, isReadOnlyAsk, isRecordOnly, refreshContract, taskContract } from '../lib/lark-task-contract.mjs'
import { PRIOR_CONCLUSION_MAX, applyIntakeClassification, intakeActionable, priorConclusionOf, sameIntentClassification } from '../lib/lark-intake-resolve.mjs'
import { isNudgeFollowUp, mergeTaskObjects } from '../lib/lark-task-merge.mjs'
import { judgeIntakeCase, regressionTaskOf } from '../lib/lark-intake-replay.mjs'
import { buildIntentClassificationPrompt } from '../lib/lark-classify-prompt.mjs'
import { createTaskStore } from '../lib/lark-task-store.mjs'
import { eachCase, runSteps } from './support/steps.mjs'

const cls = (decision, confidence = 'high', extra = {}) => ({ decision, confidence, summary: `摘要-${decision}`, reason: '理由', deliverable: null, forMe: null, selfAnswer: false, reply: null, continues: null, relatedTaskId: null, topic: null, waitsFor: null, ...extra })
const task = (text, { classification = null, ...rest } = {}) => ({ id: 't1', text, intake: classification ? { classification } : {}, ...rest })
const pick = (contract, keys) => Object.fromEntries(keys.map((key) => [key, contract?.[key]]))
const NOW = '2026-11-01T10:00:00.000Z'

describe('对话层：契约、入队门槛、分类落态、归并', () => {
  it('deriveContract / isReadOnlyAsk / intakeActionable / applyIntakeClassification / mergeTaskObjects / store 委托', () => runSteps([
    ['分类回归集（11-02）：judgeIntakeCase 按可接受集合判、缺字段不比、单值也行；fixture 56 条都能拼出提示、没漏真实 open_id', () => {
      const expected = { decision: ['bug', 'question'], deliverable: ['change'], continues: [null], selfAnswer: false }
      assert.deepEqual(judgeIntakeCase(expected, { decision: 'question', deliverable: 'change', continues: undefined, selfAnswer: false }), { ok: true, mismatches: [] })
      assert.deepEqual(judgeIntakeCase(expected, { decision: 'ignore', deliverable: null, continues: 'om_x', selfAnswer: true }).mismatches, [
        'decision=ignore（应为 bug / question）', 'deliverable=null（应为 change）', 'continues=om_x（应为 null）', 'selfAnswer=true（应为 false）',
      ])
      assert.equal(judgeIntakeCase({ decision: 'bug' }, { decision: 'bug', deliverable: 'answer', continues: 'x', selfAnswer: true }).ok, true, '单值 / 没写的字段不比')
      assert.deepEqual(regressionTaskOf({ id: 'd', text: 't', trigger: 'dm', addressedToBot: false, fromPrincipal: true }, { principalOpenId: 'ou_p' }), {
        id: 'd', source: 'lark', text: 't', operator: 'ou_p', chatType: 'p2p', addressedToBot: false, privateOrigin: false, conversation: null, attachments: [], intake: { required: true, trigger: 'dm' },
      })
      const groupTask = regressionTaskOf({ id: 'g', text: 't', trigger: 'group', conversation: { anchor: null }, attachments: [{ type: 'image' }], privateOrigin: true })
      assert.deepEqual([groupTask.chatType, groupTask.intake.trigger, groupTask.addressedToBot, groupTask.operator, groupTask.conversation, groupTask.attachments.length, groupTask.privateOrigin], ['group', 'bot_mention', true, null, { anchor: null }, 1, true])
      const fixture = JSON.parse(readFileSync(new URL('./fixtures/intake-regression-1102.json', import.meta.url), 'utf8'))
      assert.equal(fixture.regression, true)
      assert.equal(fixture.cases.length, 56)
      assert.doesNotMatch(JSON.stringify(fixture), /ou_[0-9a-f]{20,}/, '真实 open_id 要换成占位')
      for (const item of fixture.cases) {
        assert.ok(Array.isArray(item.expected.decision) && item.expected.decision.length, `${item.id} 缺 expected.decision`)
        const built = regressionTaskOf(item, { principalOpenId: 'ou_aven' })
        assert.equal(built.operator, item.fromPrincipal ? 'ou_aven' : null)
        assert.ok(buildIntentClassificationPrompt(built, {}).includes(item.text.slice(0, 20)), `${item.id} 提示里没有正文`)
      }
    }],
    ['deriveContract：交付物只算一次，运维 > 显式前缀 > 分类器交付 > 只记一笔 > 提问 > 原话正则 > 其余改码', () => eachCase([
      { name: '显式「运维：」→ ops，不只读、不要代码、空 diff 也算完成', input: task('运维：部署 online'), want: { deliverable: 'ops', source: 'ops', readOnly: false, expectsCode: false, emptyDiffOk: true, docsOnlyOk: true, api: false, defect: false, browser: false, selfAnswer: false } },
      { name: '推断的运维（commandType=ops/inferred）→ ops', input: task('部署 online', { commandType: 'ops', commandTypeSource: 'inferred' }), want: { deliverable: 'ops', source: 'ops', readOnly: false } },
      { name: '「状态：」前缀 → answer / prefix，只读', input: task('状态：项目进度', { classification: cls('bug') }), want: { deliverable: 'answer', source: 'prefix', readOnly: true, expectsCode: false, defect: false } },
      { name: '开头的 @Aven.Bot 不算原话：「@Aven.Bot 状态：进度」仍是前缀', input: task('@Aven.Bot 状态：进度'), want: { deliverable: 'answer', source: 'prefix' } },
      { name: '「修复：」前缀 + bug → change / prefix，缺陷，要代码、空 diff 不算、只改文档不算', input: task('修复：登录报错', { classification: cls('bug') }), want: { deliverable: 'change', source: 'prefix', readOnly: false, expectsCode: true, emptyDiffOk: false, docsOnlyOk: false, api: false, defect: true } },
      { name: '「api：」前缀 → change，api=true，只改文档也算完成', input: task('api：后端答复的字段'), want: { deliverable: 'change', source: 'prefix', api: true, docsOnlyOk: true, defect: false } },
      { name: '分类器 deliverable=verification → 实测：不只读、起浏览器、空 diff 算完成', input: task('看看测试环境能不能注册', { classification: cls('question', 'high', { deliverable: 'verification' }) }), want: { deliverable: 'verification', source: 'classifier', readOnly: false, expectsCode: false, emptyDiffOk: true, docsOnlyOk: true, browser: true } },
      { name: '分类器 deliverable=answer → 代答', input: task('test、pre 代码是不是一样', { classification: cls('question', 'high', { deliverable: 'answer' }) }), want: { deliverable: 'answer', source: 'classifier', readOnly: true, browser: false } },
      { name: '分类器 deliverable=change + bug → 缺陷改码', input: task('登录页白屏', { classification: cls('bug', 'high', { deliverable: 'change' }) }), want: { deliverable: 'change', source: 'classifier', defect: true } },
      { name: 'api_reply + deliverable=change：分类器交付优先于只记一笔', input: task('接口字段改了', { classification: cls('api_reply', 'high', { deliverable: 'change', forMe: true }) }), want: { deliverable: 'change', api: true } },
      { name: '只记一笔：api_reply、deliverable 空、forMe≠false → record，只读、api', input: task('pre 还不能发帖', { classification: cls('api_reply', 'high', { forMe: true }) }), want: { deliverable: 'record', source: 'classifier', readOnly: true, api: true, expectsCode: false, defect: false } },
      { name: '只记一笔不认负责人私聊指示 → 改码', input: task('pre 还不能发帖', { classification: cls('api_reply'), privateOrigin: { anchorId: 'x' } }), want: { deliverable: 'change', source: 'classifier', api: true } },
      { name: '只记一笔不认 forMe=false → 改码', input: task('pre 还不能发帖', { classification: cls('api_reply', 'high', { forMe: false }) }), want: { deliverable: 'change', source: 'classifier' } },
      { name: '只记一笔不认带对接文档的 → 改码（有文档要存要接）', input: task('接口文档', { classification: cls('api_reply'), attachments: [{ type: 'file', fileName: 'api.md' }] }), want: { deliverable: 'change', api: true } },
      { name: '提问 → answer / classifier', input: task('有哪些差别', { classification: cls('question') }), want: { deliverable: 'answer', source: 'classifier', readOnly: true, selfAnswer: false } },
      { name: '原话正则：「你自己在 pre 看，看完报告」判 requirement 也走实测（falive #58）', input: task('你自己在 pre 看，看完报告', { classification: cls('requirement') }), want: { deliverable: 'verification', source: 'regex', browser: true } },
      { name: '「改完在 pre 看下」有改东西的说法 → change', input: task('改完在 pre 看下', { classification: cls('requirement') }), want: { deliverable: 'change', source: 'classifier' } },
      { name: '「在 pre 上测一下，顺便更新文案」有写操作动词 → change', input: task('在 pre 上测一下，顺便更新下文案', { classification: cls('requirement') }), want: { deliverable: 'change', source: 'classifier' } },
      { name: '只看本条原话：被引用的卡片里「请在 pre 看一眼」不算', input: task('【引用】请测试同学在 pre 看一眼\n【本条 @】加个导出按钮', { classification: cls('requirement') }), want: { deliverable: 'change', source: 'classifier', defect: false } },
      { name: 'selfAnswer：question + 分类器 selfAnswer → answer 且 selfAnswer=true', input: task('你能发邮件吗', { classification: cls('question', 'high', { selfAnswer: true, deliverable: 'answer' }) }), want: { deliverable: 'answer', selfAnswer: true } },
      { name: 'selfAnswer 只对交付 answer 成立：bug + selfAnswer → change，selfAnswer=false', input: task('登录报错', { classification: cls('bug', 'high', { selfAnswer: true }) }), want: { deliverable: 'change', selfAnswer: false } },
      { name: '显式视觉验证在改码任务上也开浏览器', input: task('修复：按钮错位，浏览器验证', { classification: cls('bug') }), want: { deliverable: 'change', browser: true } },
      { name: '分类器其它类别 → change / classifier，不是缺陷', input: task('加个导出功能', { classification: cls('requirement') }), want: { deliverable: 'change', source: 'classifier', defect: false, api: false } },
    ], ({ input, want }) => {
      const contract = deriveContract(input)
      assert.deepEqual(pick(contract, Object.keys(want)), want)
      assert.equal(contract.v, CONTRACT_VERSION)
    })],
    ['deriveContract：没分类、没前缀、没运维 → null；空任务 → null', () => {
      assert.equal(deriveContract(task('登录页白屏')), null)
      assert.equal(deriveContract(null), null)
      assert.equal(deriveContract(task('你自己在 pre 看，看完报告')).source, 'regex', '原话正则不依赖分类结果（续跑改写正文时也能算）')
    }],
    ['isRecordOnly 直接表', () => eachCase([
      { name: 'api_reply / deliverable 空 / forMe null → 是', t: task('x'), c: cls('api_reply'), want: true },
      { name: 'forMe=true → 是', t: task('x'), c: cls('api_reply', 'low', { forMe: true }), want: true },
      { name: 'deliverable=answer → 否', t: task('x'), c: cls('api_reply', 'high', { deliverable: 'answer' }), want: false },
      { name: 'question → 否', t: task('x'), c: cls('question'), want: false },
      { name: '没分类 → 否', t: task('x'), c: null, want: false },
      { name: '默认读 task.intake.classification', t: task('x', { classification: cls('api_reply') }), c: undefined, want: true },
    ], ({ t, c, want }) => assert.equal(c === undefined ? isRecordOnly(t) : isRecordOnly(t, c), want))],
    ['isReadOnlyAsk：只认 @bot、不认私聊指示；ignore 只看分类器填的 deliverable；其余按契约', () => eachCase([
      { name: '没 @bot → 否', t: task('x'), c: cls('question'), want: false },
      { name: '私聊指示 → 否', t: task('x', { addressedToBot: true, privateOrigin: { anchorId: 'a' } }), c: cls('question'), want: false },
      { name: 'ignore + verification → 是', t: task('x', { addressedToBot: true }), c: cls('ignore', 'high', { deliverable: 'verification' }), want: true },
      { name: 'ignore + answer → 是', t: task('x', { addressedToBot: true }), c: cls('ignore', 'high', { deliverable: 'answer' }), want: true },
      { name: 'ignore + change → 否', t: task('x', { addressedToBot: true }), c: cls('ignore', 'high', { deliverable: 'change' }), want: false },
      { name: 'ignore + 空 deliverable：原话有「测」也不按正则放行', t: task('别在 pre 上测', { addressedToBot: true }), c: cls('ignore'), want: false },
      { name: 'question → 契约 answer → 是', t: task('x', { addressedToBot: true }), c: cls('question'), want: true },
      { name: '原话正则 verification → 是', t: task('你自己在 pre 看，看完报告', { addressedToBot: true }), c: cls('requirement'), want: true },
      { name: 'bug → 契约 change → 否', t: task('x', { addressedToBot: true }), c: cls('bug'), want: false },
      { name: '不传 cls：读已存契约 verification → 是', t: task('x', { addressedToBot: true, contract: { v: CONTRACT_VERSION, deliverable: 'verification' } }), c: undefined, want: true },
      { name: '不传 cls：旧版契约不认，按正文重算（状态：→ answer）→ 是', t: task('状态：进度', { addressedToBot: true, contract: { v: 0, deliverable: 'change' } }), c: undefined, want: true },
      { name: '不传 cls、没契约、没分类 → 否', t: task('x', { addressedToBot: true }), c: undefined, want: false },
    ], ({ t, c, want }) => assert.equal(c === undefined ? isReadOnlyAsk(t) : isReadOnlyAsk(t, c), want))],
    ['taskContract / refreshContract', () => {
      const stored = { v: CONTRACT_VERSION, deliverable: 'verification' }
      assert.equal(taskContract(task('状态：x', { contract: stored })), stored, '版本对就用存的')
      assert.equal(taskContract(task('状态：x', { contract: { v: 99, deliverable: 'verification' } })).deliverable, 'answer', '版本不对现算')
      assert.equal(taskContract(null), null)
      const refreshed = refreshContract(task('状态：x', { contract: stored }))
      assert.equal(refreshed.contract.deliverable, 'answer')
      const dropped = refreshContract(task('没有任何线索', { contract: stored }))
      assert.equal('contract' in dropped, false, '算不出契约就删掉旧的')
    }],
    ['intakeActionable：plan §3.3 的表（A=@bot 或私信，P=负责人本人）', () => eachCase([
      { name: '分类出错 → 否（哪怕 A P bug high）', t: { addressedToBot: true, fromPrincipal: true }, c: cls('bug'), error: 'boom', want: false },
      { name: 'A P bug high → 是', t: { addressedToBot: true, fromPrincipal: true }, c: cls('bug'), want: true },
      { name: 'A P question medium → 是', t: { addressedToBot: true, fromPrincipal: true }, c: cls('question', 'medium'), want: true },
      { name: 'A P requirement low → 否（追问）', t: { addressedToBot: true, fromPrincipal: true }, c: cls('requirement', 'low'), want: false },
      { name: 'A P ignore high（带 deliverable answer）→ 否（负责人说不做就不做）', t: { addressedToBot: true, fromPrincipal: true }, c: cls('ignore', 'high', { deliverable: 'answer' }), want: false },
      { name: 'A P question + selfAnswer + answer → 否（分类器已答完）', t: { addressedToBot: true, fromPrincipal: true, text: '你能发邮件吗' }, c: cls('question', 'high', { selfAnswer: true, deliverable: 'answer' }), want: false },
      { name: 'A P question + selfAnswer 但显式「修复：」→ 契约 change，selfAnswer 不成立 → 是', t: { addressedToBot: true, fromPrincipal: true, text: '修复：登录' }, c: cls('question', 'high', { selfAnswer: true }), want: true },
      // 11-03 静态 review R9：别人问「bot 能做什么」分类器也把完整答案写进 reply 并置 selfAnswer，原先只对负责人生效——别人的照样 actionable，
      // reply 作「收到」发出（已是完整答案）后 worker 再代答一遍、发第二次。自答不看提问人：@bot 的问 bot 自己的问题答一次就结。
      { name: 'A ¬P question + selfAnswer + answer → 否（分类器已答完，不看提问人）', t: { addressedToBot: true, text: 'bot 能做什么' }, c: cls('question', 'high', { selfAnswer: true, deliverable: 'answer' }), want: false },
      { name: 'A ¬P question + selfAnswer 但显式「修复：」→ 契约 change → 是', t: { addressedToBot: true, text: '修复：登录' }, c: cls('question', 'high', { selfAnswer: true }), want: true },
      { name: 'A P 未知类别 → 否', t: { addressedToBot: true, fromPrincipal: true }, c: cls('chitchat'), want: false },
      { name: 'A P 私聊指示 + bug high → 是（负责人分支不看 privateOrigin）', t: { addressedToBot: true, fromPrincipal: true, privateOrigin: { anchorId: 'a' } }, c: cls('bug'), want: true },
      { name: 'A ¬P ignore + verification high → 是（帮测不看归属）', t: { addressedToBot: true }, c: cls('ignore', 'high', { deliverable: 'verification' }), want: true },
      { name: 'A ¬P ignore + answer medium → 是', t: { addressedToBot: true }, c: cls('ignore', 'medium', { deliverable: 'answer' }), want: true },
      { name: 'A ¬P ignore + verification low → 否', t: { addressedToBot: true }, c: cls('ignore', 'low', { deliverable: 'verification' }), want: false },
      // 11-04 falive 回放：bot 卡片下的话题里 mainly「@Arthur 前端给你了 guest_token…」被判 verification 建了复测——回复 bot 没 @ 它、分类器判不是对 bot 说（reply null）不帮测
      { name: 'A ¬P 回复 bot 没 @、ignore + verification high、reply null → 否（在跟同事说）', t: { addressedToBot: true, intake: { trigger: 'bot_reply', mentionedBot: false } }, c: cls('ignore', 'high', { deliverable: 'verification' }), want: false },
      { name: 'A ¬P 回复 bot 没 @、ignore + verification high、有 reply → 是（对 bot 说的，照旧帮测）', t: { addressedToBot: true, intake: { trigger: 'bot_reply', mentionedBot: false } }, c: cls('ignore', 'high', { deliverable: 'verification', reply: '我去看看' }), want: true },
      { name: 'A ¬P 回复 bot 且 @ 了它、ignore + verification high、reply null → 是', t: { addressedToBot: true, intake: { trigger: 'bot_reply', mentionedBot: true } }, c: cls('ignore', 'high', { deliverable: 'verification' }), want: true },
      { name: 'A ¬P ignore + change high → 否', t: { addressedToBot: true }, c: cls('ignore', 'high', { deliverable: 'change' }), want: false },
      { name: 'A ¬P 私聊指示 + ignore + answer → 否', t: { addressedToBot: true, privateOrigin: { anchorId: 'a' } }, c: cls('ignore', 'high', { deliverable: 'answer' }), want: false },
      { name: 'A ¬P bug high forMe null → 是', t: { addressedToBot: true }, c: cls('bug'), want: true },
      { name: 'A ¬P bug medium forMe true → 是', t: { addressedToBot: true }, c: cls('bug', 'medium', { forMe: true }), want: true },
      { name: 'A ¬P bug high forMe false → 否（礼貌转介）', t: { addressedToBot: true }, c: cls('bug', 'high', { forMe: false }), want: false },
      { name: 'A ¬P api_reply high deliverable 空 → 否（只记一笔）', t: { addressedToBot: true }, c: cls('api_reply', 'high', { forMe: true }), want: false },
      { name: 'A ¬P api_reply high deliverable change → 是', t: { addressedToBot: true }, c: cls('api_reply', 'high', { deliverable: 'change' }), want: true },
      { name: 'A ¬P question low → 否（疑似）', t: { addressedToBot: true }, c: cls('question', 'low'), want: false },
      { name: 'A ¬P 未知类别 high → 否', t: { addressedToBot: true }, c: cls('chitchat'), want: false },
      { name: '¬A bug high → 是（现状）', t: {}, c: cls('bug'), want: true },
      { name: '¬A requirement medium → 是', t: { intake: { trigger: 'task_mention' } }, c: cls('requirement', 'medium'), want: true },
      { name: '¬A bug low → 否', t: {}, c: cls('bug', 'low'), want: false },
      { name: '¬A question high → 否（疑似，先问 aven）', t: {}, c: cls('question'), want: false },
      { name: '¬A api_reply medium → 否（疑似）', t: {}, c: cls('api_reply', 'medium'), want: false },
      { name: '¬A ignore high → 否', t: {}, c: cls('ignore'), want: false },
      { name: 'addressedToBot 不是严格 true（字符串）按没叫 bot：question high → 否', t: { addressedToBot: 'yes' }, c: cls('question'), want: false },
      { name: 'fromPrincipal 不是严格 true：按别人算，ignore + answer high → 是', t: { addressedToBot: true, fromPrincipal: 1 }, c: cls('ignore', 'high', { deliverable: 'answer' }), want: true },
      { name: 'A P api_reply + selfAnswer + 交付 answer → 是（selfAnswer 只认 question）', t: { addressedToBot: true, fromPrincipal: true, text: 'x' }, c: cls('api_reply', 'high', { selfAnswer: true, deliverable: 'answer' }), want: true },
      { name: '没分类结果 → 否', t: { addressedToBot: true, fromPrincipal: true }, c: null, want: false },
    ], ({ t, c, error, want }) => assert.equal(intakeActionable({ id: 't', text: 'x', ...t }, c, error), want))],
    ['applyIntakeClassification：六种落法与派生字段', () => eachCase([
      {
        name: 'selfAnswer：answered、result=reply、不排队、契约 selfAnswer',
        t: { addressedToBot: true, fromPrincipal: true, text: '你能发邮件吗' },
        c: cls('question', 'high', { selfAnswer: true, deliverable: 'answer', reply: '能发，部署信那类私信我就行', topic: '发邮件', waitsFor: null }),
        want: { out: { actionable: false, suspected: false, recordOnly: false, selfAnswer: true, askBack: false, requeue: false }, status: 'answered', result: '能发，部署信那类私信我就行', selfAnswered: true, summary: '摘要-question', topic: '发邮件' },
        check: (t) => assert.equal(t.contract.selfAnswer, true),
      },
      {
        name: 'selfAnswer 没 reply → result 用摘要',
        t: { addressedToBot: true, fromPrincipal: true, text: '你能发邮件吗' },
        c: cls('question', 'high', { selfAnswer: true, deliverable: 'answer' }),
        want: { status: 'answered', result: '摘要-question' },
      },
      {
        // 11-03 R9：原预期「selfAnswer 只对负责人：别人问同样的话 → 开跑」——那会把分类器已写完整的 reply 当「收到」发出，再让 worker 代答一遍发第二次。
        name: 'selfAnswer 不看提问人：别人问 bot 自己的问题 → answered，答一次就结、不排队',
        t: { addressedToBot: true, text: '你能发邮件吗' },
        c: cls('question', 'high', { selfAnswer: true, deliverable: 'answer', reply: '能发，部署信那类私信 aven 就行' }),
        want: { out: { actionable: false, selfAnswer: true, requeue: false, suspected: false, recordOnly: false }, status: 'answered', selfAnswered: true, result: '能发，部署信那类私信 aven 就行', commandType: undefined },
      },
      { name: '别人问 bot 自己、forMe=false 也自答（问题是关于 bot 的，归属无关）', t: { addressedToBot: true, text: 'bot 能做什么' }, c: cls('question', 'high', { selfAnswer: true, deliverable: 'answer', forMe: false, reply: '能看代码答问题、改前端' }), want: { out: { selfAnswer: true, actionable: false }, status: 'answered', result: '能看代码答问题、改前端' } },
      // 11-03 合入前 review：别人 @bot、分类器拿不准（low）却直接自答结单，原来会落疑似私信 aven——非负责人自答要 high / medium。
      { name: '别人问 bot 自己、low → 不自答，照旧落疑似', t: { addressedToBot: true, text: 'bot 能做什么' }, c: cls('question', 'low', { selfAnswer: true, deliverable: 'answer', reply: '能看代码答问题' }), want: { out: { selfAnswer: false, suspected: true, actionable: false }, status: 'waiting_confirmation', suspected: true, selfAnswered: undefined } },
      { name: '别人问 bot 自己、medium → 自答', t: { addressedToBot: true, text: 'bot 能做什么' }, c: cls('question', 'medium', { selfAnswer: true, deliverable: 'answer', reply: '能看代码答问题' }), want: { out: { selfAnswer: true, suspected: false }, status: 'answered' } },
      { name: '负责人问 bot 自己、low → 仍自答（负责人口径不变，不走 askBack）', t: { addressedToBot: true, fromPrincipal: true, text: '你能发邮件吗' }, c: cls('question', 'low', { selfAnswer: true, deliverable: 'answer', reply: '能发' }), want: { out: { selfAnswer: true, askBack: false }, status: 'answered', result: '能发' } },
      {
        name: 'actionable question：commandType=status、契约 answer、waitsFor / topic / continues / relatedTaskId 落上、claimedAt 清',
        t: { addressedToBot: true, text: '有哪些差别', claimedAt: 'x' },
        c: cls('question', 'high', { deliverable: 'answer', reply: '我看下', waitsFor: ' 等后端给字段 ', topic: '  test-pre 差异 ', continues: 'om_prev', relatedTaskId: 'om_rel' }),
        want: { out: { actionable: true, requeue: true, suspected: false, recordOnly: false, selfAnswer: false, askBack: false }, status: undefined, commandType: 'status', commandTypeSource: 'explicit', waitsFor: '等后端给字段', topic: 'test-pre 差异', continues: 'om_prev', relatedTaskId: 'om_rel', claimedAt: null, summary: '摘要-question' },
        check: (t) => { assert.equal(t.contract.deliverable, 'answer'); assert.equal(t.intake.required, false); assert.equal(t.intake.resolvedAt, NOW); assert.equal(t.updatedAt, NOW); assert.equal(t.intake.classification.reply, '我看下', '开跑的提问 reply 照发') },
      },
      {
        name: 'actionable api_reply（deliverable change）→ commandType=api',
        t: { addressedToBot: true, text: '字段改了' },
        c: cls('api_reply', 'high', { deliverable: 'change' }),
        want: { commandType: 'api', commandTypeSource: 'explicit' },
      },
      {
        name: 'actionable bug / requirement（没前缀）不落 commandType（只有提问 → status、api_reply → api）',
        t: { addressedToBot: true, text: '登录页白屏' },
        c: cls('bug', 'high', { deliverable: 'change' }),
        want: { out: { actionable: true }, commandType: undefined, commandTypeSource: undefined, summary: '摘要-bug' },
      },
      {
        name: '已有 commandType 不覆盖；topic 已有不覆盖；waitsFor 空串 → null；continues 非字符串 → null',
        t: { addressedToBot: true, text: 'x', commandType: 'fix', commandTypeSource: 'explicit', topic: 'old' },
        c: cls('question', 'high', { waitsFor: '  ', topic: 'new', continues: 123, relatedTaskId: '' }),
        want: { commandType: 'fix', topic: 'old', waitsFor: null, continues: null, relatedTaskId: null },
      },
      {
        name: 'askBack：负责人 low → waiting_confirmation、askBack、parkedRemindedRound=99、waitRound+1、result=分类器追问',
        t: { addressedToBot: true, fromPrincipal: true, text: '那个改一下', waitRound: 1 },
        c: cls('requirement', 'low', { reply: '你是指哪个页面？' }),
        want: { out: { actionable: false, askBack: true, suspected: false, recordOnly: false, selfAnswer: false, requeue: false }, status: 'waiting_confirmation', askBack: true, parkedAt: NOW, parkedRemindedRound: 99, waitRound: 2, result: '你是指哪个页面？', summary: '摘要-requirement' },
      },
      {
        name: 'askBack 没 reply → result 用摘要',
        t: { addressedToBot: true, fromPrincipal: true, text: 'x' },
        c: cls('question', 'low'),
        want: { status: 'waiting_confirmation', askBack: true, result: '摘要-question', waitRound: 1 },
      },
      {
        name: '疑似（A ¬P bug low）：waiting_confirmation、suspected、result 带类别 / 置信度 / 理由',
        t: { addressedToBot: true, text: 'x' },
        c: cls('bug', 'low'),
        want: { out: { actionable: false, suspected: true, askBack: false, recordOnly: false, requeue: false }, status: 'waiting_confirmation', suspected: true, parkedAt: NOW, parkedRemindedRound: 99, waitRound: 1, result: '疑似需要处理但没把握（bug / low）：摘要-bug\n理由：理由', summary: '摘要-bug' },
      },
      { name: '疑似（¬A question high）', t: { text: 'x' }, c: cls('question'), want: { out: { suspected: true }, status: 'waiting_confirmation', suspected: true } },
      { name: '疑似（¬A api_reply medium）', t: { text: 'x' }, c: cls('api_reply', 'medium'), want: { out: { suspected: true, recordOnly: false }, status: 'waiting_confirmation' } },
      {
        name: '只记一笔（A ¬P api_reply deliverable 空）：ignored、recordOnly、不疑似',
        t: { addressedToBot: true, text: 'pre 还不能发帖' },
        c: cls('api_reply', 'high', { forMe: true }),
        want: { out: { actionable: false, recordOnly: true, suspected: false, askBack: false, requeue: false }, status: 'ignored', recordOnly: true, result: '只记一笔：摘要-api_reply', summary: '摘要-api_reply' },
        check: (t) => assert.equal(t.contract.deliverable, 'record'),
      },
      { name: '只记一笔也覆盖 low（规则表里只记一笔排在疑似前）', t: { addressedToBot: true, text: 'x' }, c: cls('api_reply', 'low', { forMe: true }), want: { out: { recordOnly: true, suspected: false }, status: 'ignored' } },
      { name: '负责人的 api_reply deliverable 空 high → 开跑，不是只记一笔；commandType=api', t: { addressedToBot: true, fromPrincipal: true, text: 'x' }, c: cls('api_reply'), want: { out: { actionable: true, recordOnly: false }, commandType: 'api', commandTypeSource: 'explicit' } },
      { name: 'A ¬P forMe=false bug high → ignored，不疑似、不只记', t: { addressedToBot: true, text: 'x' }, c: cls('bug', 'high', { forMe: false }), want: { out: { actionable: false, suspected: false, recordOnly: false, askBack: false }, status: 'ignored', suspected: undefined } },
      { name: 'A ¬P forMe=false low → ignored（不疑似）', t: { addressedToBot: true, text: 'x' }, c: cls('requirement', 'low', { forMe: false }), want: { out: { suspected: false }, status: 'ignored' } },
      { name: 'A P ignore → ignored，reply 保留', t: { addressedToBot: true, fromPrincipal: true, text: 'x' }, c: cls('ignore', 'high', { reply: '好，不做' }), want: { out: { actionable: false, suspected: false, askBack: false }, status: 'ignored' }, check: (t) => assert.equal(t.intake.classification.reply, '好，不做') },
      { name: 'A P ignore low → ignored（不追问）', t: { addressedToBot: true, fromPrincipal: true, text: 'x' }, c: cls('ignore', 'low'), want: { out: { askBack: false, suspected: false }, status: 'ignored' } },
      { name: '¬A 负责人（没 @bot）requirement low → ignored（不追问、不疑似）', t: { fromPrincipal: true, text: 'x' }, c: cls('requirement', 'low'), want: { out: { askBack: false, suspected: false, actionable: false }, status: 'ignored' } },
      { name: '¬A 负责人 question + selfAnswer → 疑似（没叫 bot 不自答）', t: { fromPrincipal: true, text: 'x' }, c: cls('question', 'high', { selfAnswer: true, deliverable: 'answer' }), want: { out: { selfAnswer: false, suspected: true }, status: 'waiting_confirmation' } },
      { name: 'A P api_reply + selfAnswer + answer → 开跑（selfAnswer 只认 question），commandType=api', t: { addressedToBot: true, fromPrincipal: true, text: 'x' }, c: cls('api_reply', 'high', { selfAnswer: true, deliverable: 'answer' }), want: { out: { selfAnswer: false, actionable: true }, commandType: 'api' } },
      { name: '¬A api_reply low → ignored 静默', t: { text: 'x' }, c: cls('api_reply', 'low'), want: { out: { suspected: false }, status: 'ignored' } },
      { name: '¬A bug low → ignored', t: { text: 'x' }, c: cls('bug', 'low'), want: { status: 'ignored', suspected: undefined } },
      { name: '¬A ignore → ignored', t: { text: 'x' }, c: cls('ignore'), want: { status: 'ignored' } },
      {
        name: '分类出错 → intake_failed，记 error，不算契约、不派生字段',
        t: { addressedToBot: true, fromPrincipal: true, text: 'x' },
        c: cls('bug'),
        error: new Error('schema invalid'),
        want: { out: { actionable: false, suspected: false, recordOnly: false, selfAnswer: false, askBack: false, requeue: false }, status: 'intake_failed', contract: undefined, waitsFor: undefined, continues: undefined },
        check: (t) => { assert.equal(t.intake.error, 'Error: schema invalid'); assert.deepEqual(t.intake.classification, cls('bug')) },
      },
      { name: '分类出错时哪怕结果像自答 / 追问 / 只记一笔也一律 intake_failed', t: { addressedToBot: true, fromPrincipal: true, text: 'x' }, c: cls('question', 'low', { selfAnswer: true, deliverable: 'answer' }), error: 'boom', want: { out: { selfAnswer: false, askBack: false, suspected: false, recordOnly: false }, status: 'intake_failed', contract: undefined } },
      { name: '分类出错（别人的 api_reply）也不只记一笔', t: { addressedToBot: true, text: 'x' }, c: cls('api_reply', 'high', { forMe: true }), error: 'boom', want: { out: { recordOnly: false, suspected: false }, status: 'intake_failed' } },
      { name: '没分类也没错 → ignored，classification=null', t: { addressedToBot: true, text: 'x' }, c: null, want: { status: 'ignored', contract: undefined }, check: (t) => assert.equal(t.intake.classification, null) },
      // 11-03 falive 回放：William「测试的tid 发出来」接着上一单实测（交付物不同另起），tid 只在那单的条目 / detailDoc 里，本单看不到就回了「去翻文档」。
      {
        name: '开跑且接着已有结论的那条（continues 优先于 relatedTaskId）→ 带上那条的结论',
        t: { addressedToBot: true, text: '测试的tid 发出来' },
        c: cls('question', 'high', { deliverable: 'answer', continues: 'om_prev', relatedTaskId: 'om_rel' }),
        known: { om_prev: { id: 'om_prev', summary: '翻译实测', outcome: { report: { answer: '标题没翻', items: [{ name: '标题翻译', note: '18726–18742' }] } } }, om_rel: { id: 'om_rel', outcome: { summary: '别的' } } },
        want: { priorConclusion: { taskId: 'om_prev', summary: '翻译实测', text: '标题没翻\n- 标题翻译：18726–18742' } },
      },
      { name: '只有 relatedTaskId → 带那条的', t: { addressedToBot: true, text: 'x' }, c: cls('question', 'high', { deliverable: 'answer', relatedTaskId: 'om_rel' }), known: { om_rel: { id: 'om_rel', outcome: { summary: '别的' } } }, want: { priorConclusion: { taskId: 'om_rel', summary: null, text: '别的' } } },
      { name: '那条还没结论 → 不带', t: { addressedToBot: true, text: 'x' }, c: cls('question', 'high', { deliverable: 'answer', continues: 'om_prev' }), known: { om_prev: { id: 'om_prev', outcome: null } }, want: { priorConclusion: undefined } },
      { name: 'continues 指自己 → 不带', t: { addressedToBot: true, text: 'x' }, c: cls('question', 'high', { deliverable: 'answer', continues: 'om_1' }), known: { om_1: { id: 'om_1', outcome: { summary: '自己' } } }, want: { priorConclusion: undefined } },
      { name: '没开跑（疑似）→ 不带', t: { addressedToBot: true, text: 'x' }, c: cls('bug', 'low', { continues: 'om_prev' }), known: { om_prev: { id: 'om_prev', outcome: { summary: '上一单' } } }, want: { out: { suspected: true }, priorConclusion: undefined } },
      // 11-03 第二次 review #5：priorConclusion 只写不清——重新分类后新结果没有 prior（或不开跑）还带着上一次分类的那单结论
      { name: '重新分类、新结果没有 prior → 删掉旧的', t: { addressedToBot: true, text: 'x', priorConclusion: { taskId: 'om_old', text: '旧' } }, c: cls('question', 'high', { deliverable: 'answer' }), known: {}, want: { out: { actionable: true } }, check: (t) => assert.equal('priorConclusion' in t, false) },
      { name: '重新分类成不开跑（疑似）→ 也删掉旧的', t: { addressedToBot: true, text: 'x', priorConclusion: { taskId: 'om_old', text: '旧' } }, c: cls('bug', 'low', { continues: 'om_prev' }), known: { om_prev: { id: 'om_prev', outcome: { summary: '上一单' } } }, want: { out: { suspected: true } }, check: (t) => assert.equal('priorConclusion' in t, false) },
      { name: '不给 lookup → 不带也不炸', t: { addressedToBot: true, text: 'x' }, c: cls('question', 'high', { deliverable: 'answer', continues: 'om_prev' }), want: { out: { actionable: true }, priorConclusion: undefined } },
      {
        name: 'ignore 被放行（只读活归别人）：reply 不当「收到」发，挪到 replyDropped',
        t: { addressedToBot: true, text: '帮看下 pre 能不能登录' },
        c: cls('ignore', 'high', { deliverable: 'verification', reply: '找后端联调' }),
        want: { out: { actionable: true, requeue: true } },
        check: (t) => { assert.equal(t.intake.classification.reply, null); assert.equal(t.intake.classification.replyDropped, '找后端联调'); assert.equal(t.contract.deliverable, 'verification') },
      },
      {
        name: 'ignore 被放行但本来没 reply → 分类结果原样',
        t: { addressedToBot: true, text: 'x' },
        c: cls('ignore', 'high', { deliverable: 'answer' }),
        want: { out: { actionable: true } },
        check: (t) => assert.equal('replyDropped' in t.intake.classification, false),
      },
    ], ({ t, c, error, known, want, check }) => {
      const target = { id: 'om_1', intake: { required: true, trigger: 'direct' }, ...t }
      const out = applyIntakeClassification(target, { classification: c, error, now: NOW, ...(known ? { lookup: (id) => known[id] } : {}) })
      const { out: wantOut, ...fields } = want
      if (wantOut) assert.deepEqual(pick(out, Object.keys(wantOut)), wantOut)
      assert.deepEqual(pick(target, Object.keys(fields)), fields)
      assert.equal(target.claimedAt, null)
      check?.(target)
    })],
    ['priorConclusionOf：答案取 report.answer → groupReply → summary；条目「- 名：说明」；detailDoc 附在后面；截到上限；没结论 → null', () => eachCase([
      { name: '三者都有取 answer', prior: { id: 'p', summary: 's', outcome: { report: { answer: 'A', items: [] }, groupReply: 'G', summary: 'S' } }, want: { taskId: 'p', summary: 's', text: 'A' } },
      { name: '没 answer 取 groupReply', prior: { id: 'p', outcome: { report: { answer: null, items: [{ name: '登录', note: '' }, { name: '', note: '孤立说明' }] }, groupReply: 'G', summary: 'S' } }, want: { taskId: 'p', summary: null, text: 'G\n- 登录' } },
      { name: '只有 summary + detailDoc', prior: { id: 'p', outcome: { summary: 'S', detailDoc: '# tid\n18608' } }, want: { taskId: 'p', summary: null, text: 'S\n详细：\n# tid\n18608' } },
      { name: '没结论 → null', prior: { id: 'p', outcome: { report: { answer: '', items: [] } } }, want: null },
      { name: '没任务 → null', prior: undefined, want: null },
    ], ({ prior, want }) => {
      assert.deepEqual(priorConclusionOf(prior), want)
      assert.equal(priorConclusionOf({ id: 'p', outcome: { detailDoc: 'x'.repeat(PRIOR_CONCLUSION_MAX * 2) } }).text.length, PRIOR_CONCLUSION_MAX)
    })],
    ['sameIntentClassification：只比 decision / confidence / summary / reason', () => {
      const a = cls('bug', 'high', { reply: 'x' })
      assert.equal(sameIntentClassification(a, { ...a, reply: 'y', topic: 't' }), true)
      assert.equal(sameIntentClassification(a, { ...a, reason: '别的' }), false)
      assert.equal(sameIntentClassification(a, { ...a, confidence: 'low' }), false)
      assert.equal(sameIntentClassification(null, null), true)
      assert.equal(sameIntentClassification(a, null), false)
    }],
    ['mergeTaskObjects：五种模式 + 对话包随新消息、契约只在重开时随新消息 + 来源任务 superseded', () => {
      const calls = []
      const requeueTask = (target) => { calls.push(target.id); target.status = 'queued'; target.claimedAt = null; target.epoch = (target.epoch || 0) + 1 }
      const fresh = (status, extra = {}) => ({ id: 'into', status, text: '原问题', epoch: 2, ...extra })
      const from = (extra = {}) => ({ id: 'from', text: '有哪些差别', epoch: 0, attachments: [{ type: 'image', imageKey: 'img_1' }], contract: { v: 1, deliverable: 'answer' }, conversation: { anchor: null }, ...extra })
      const run = (into, source = from()) => ({ mode: mergeTaskObjects({ from: source, into, requeueTask, now: NOW }), into, source })
      const nudge = (extra = {}) => from({ text: '【本条 @】这也麻烦在测试下', attachments: [{ type: 'image', imageKey: 'ctx', origin: '群里之前的消息' }], messageCreatedAt: '2026-11-01T09:58:59.000Z', ...extra })
      const done = (extra = {}) => fresh('done', { lastDeliveredReceipt: { status: 'done', epoch: 2, deliveredAt: '2026-11-01T09:59:00.000Z' }, ...extra })
      return eachCase([
        { name: 'queued → appended：正文追加、附件合并、不换代', into: fresh('queued'), mode: 'appended', after: (into) => { assert.equal(into.text, '原问题\n\n【同主题补充 2026-11-01T10:00】有哪些差别'); assert.deepEqual(into.attachments, [{ type: 'image', imageKey: 'img_1' }]); assert.equal(into.epoch, 2); assert.equal(into.status, 'queued') } },
        { name: 'received → appended', into: fresh('received'), mode: 'appended', after: (into) => assert.equal(into.status, 'received') },
        { name: 'running → rerun_after_done', into: fresh('running'), mode: 'rerun_after_done', after: (into) => { assert.equal(into.rerunAfterDone, true); assert.equal(into.status, 'running') } },
        { name: 'verifying → rerun_after_done', into: fresh('verifying'), mode: 'rerun_after_done' },
        // falive 回放 b2 ep-1014-d74f19：在跑时「这也麻烦在测试下」「麻烦在看看 有没有问题」各打一次 rerunAfterDone，群里 4 分钟连发 3 条几乎一样的结论。
        // 只是催 / 重复同一个请求 → 不欠一轮，这轮结论顺带答它（answerFor）；结论刚送达、它发在送达之前 → 不重开（answered_before）
        { name: 'running + 只是催 → nudge_running：不打 rerunAfterDone，记 answerFor', into: fresh('running', { answerFor: ['old'] }), source: nudge(), mode: 'nudge_running', after: (into) => assert.deepEqual([into.rerunAfterDone, into.answerFor, into.status, into.epoch], [undefined, ['old', 'from'], 'running', 2]) },
        { name: 'verifying + 只是催 → nudge_running', into: fresh('verifying'), source: nudge(), mode: 'nudge_running' },
        { name: 'running + 只是催、但已欠一轮 → 标记留着', into: fresh('running', { rerunAfterDone: true }), source: nudge(), mode: 'nudge_running', after: (into) => assert.equal(into.rerunAfterDone, true) },
        { name: 'running + 引用里带东西、本条只是催 → 仍算催（只看本条原话）', into: fresh('running'), source: nudge({ text: '【被引用消息】（Aven.Bot）\n用 508 号登录\n\n【本条 @】@Aven.Bot 麻烦在看看 有没有问题\n\n【群里这条之前的消息】\n验证码 123456' }), mode: 'nudge_running' },
        { name: 'running + 催但自己带了图 → rerun_after_done', into: fresh('running'), source: nudge({ attachments: [{ type: 'image', imageKey: 'own' }] }), mode: 'rerun_after_done' },
        { name: 'done、结论在它之后送达 + 只是催 → answered_before：不重开、不动目标', into: done({ ackReply: 'A 那句', envTargets: ['pre'], contract: { v: 1, deliverable: 'verification' }, mergedNotified: ['x'] }), source: nudge({ envTargets: ['uat'], ackReply: 'B 那句' }), mode: 'answered_before', after: (into) => assert.deepEqual([into.status, into.epoch, into.rerunAfterDone, into.ackReply, into.envTargets, into.contract.deliverable, into.mergedNotified, into.answerFor], ['done', 2, undefined, 'A 那句', ['pre'], 'verification', ['x', 'from'], undefined]) },
        { name: 'no_change_needed 同理', into: done({ status: 'no_change_needed', lastDeliveredReceipt: { status: 'no_change_needed', epoch: 2, deliveredAt: '2026-11-01T09:59:00.000Z' } }), source: nudge(), mode: 'answered_before' },
        { name: 'done、它发在结论送达之后（看过结论还要再看）→ reopened', into: done(), source: nudge({ messageCreatedAt: '2026-11-01T09:59:01.000Z' }), mode: 'reopened' },
        { name: 'done、恰好同一刻 → answered_before', into: done(), source: nudge({ messageCreatedAt: '2026-11-01T09:59:00.000Z' }), mode: 'answered_before' },
        { name: 'done、没 messageCreatedAt 按 createdAt', into: done(), source: nudge({ messageCreatedAt: undefined, createdAt: '2026-11-01T09:58:00.000Z' }), mode: 'answered_before' },
        { name: 'done、送达的是上一代的结论 → reopened', into: done({ lastDeliveredReceipt: { status: 'done', epoch: 1, deliveredAt: '2026-11-01T09:59:00.000Z' } }), source: nudge(), mode: 'reopened' },
        { name: 'done、没送达记录 → reopened', into: done({ lastDeliveredReceipt: undefined }), source: nudge(), mode: 'reopened' },
        { name: 'failed 的结论 → reopened（没做成，再看看是要重试）', into: done({ status: 'failed', lastDeliveredReceipt: { status: 'failed', epoch: 2, deliveredAt: '2026-11-01T09:59:00.000Z' } }), source: nudge(), mode: 'reopened' },
        { name: '送达的是 done、但目标现在是 failed（回写晚到）→ reopened', into: done({ status: 'failed' }), source: nudge(), mode: 'reopened' },
        { name: '目标 done、但送达的是挂起回执 → reopened', into: done({ lastDeliveredReceipt: { status: 'blocked', epoch: 2, deliveredAt: '2026-11-01T09:59:00.000Z' } }), source: nudge(), mode: 'reopened' },
        { name: 'done、结论之前发的但有新内容 → reopened', into: done(), source: nudge({ text: '【本条 @】验证码 123456 再测下' }), mode: 'reopened' },
        { name: '疑似挂起 → appended_suspected：不开跑、不换代', into: fresh('waiting_confirmation', { suspected: true, parkedAt: 'p' }), mode: 'appended_suspected', after: (into) => { assert.equal(into.status, 'waiting_confirmation'); assert.equal(into.epoch, 2); assert.equal(into.parkedAt, 'p'); assert.equal(calls.includes('into'), false) } },
        { name: '挂起（非疑似）→ resumed：经 requeueTask 换代、记 waitingHistory、清结果 / 挂起字段', into: fresh('waiting_confirmation', { waitRound: 2, result: '等材料', owner: 'qa', scopeRequest: { x: 1 }, parkedAt: 'p', parkedRemindedRound: 1 }), mode: 'resumed', after: (into) => { assert.equal(into.status, 'queued'); assert.equal(into.epoch, 3); assert.deepEqual(into.waitingHistory, [{ round: 2, epoch: 2, status: 'waiting_confirmation', result: '等材料', resumedAt: NOW }]); assert.equal(into.resumeCount, 1); assert.equal(into.result, null); assert.equal(into.owner, null); assert.equal(into.scopeRequest, null); assert.equal(into.parkedAt, null); assert.equal(into.parkedRemindedRound, 0); assert.deepEqual(calls, ['into']) } },
        { name: 'blocked → resumed', into: fresh('blocked'), mode: 'resumed', after: (into) => assert.equal(into.waitingHistory[0].round, 1) },
        { name: 'done → reopened：threadHistory、queued、换代（不经 requeueTask）', into: fresh('done', { result: '不一样', owner: 'x', noChangeReason: 'n', parkedRemindedRound: 1, claimedAt: 'c', updatedAt: 'u' }), mode: 'reopened', after: (into) => { assert.equal(into.status, 'queued'); assert.equal(into.epoch, 3); assert.deepEqual(into.threadHistory, [{ status: 'done', result: '不一样', closedAt: 'u' }]); assert.equal(into.result, null); assert.equal(into.owner, null); assert.equal(into.noChangeReason, null); assert.equal(into.claimedAt, null); assert.equal(into.parkedRemindedRound, 0); assert.equal(calls.filter((id) => id === 'into').length, 2, 'reopened 不走 requeueTask') } },
        { name: 'answered（终态含 answered）→ reopened，「有哪些差别」并入续答', into: fresh('answered'), mode: 'reopened', after: (into) => assert.equal(into.status, 'queued') },
        { name: 'failed → reopened', into: fresh('failed'), mode: 'reopened' },
        // 11-03 第二次 review #6：契约只在重开时按新消息换。A 的改码单挂着等文档，William「@bot 文档在这，你看还缺啥吗」判 answer 并入续跑，
        // 原先契约被换成只读代答，不改代码就 done；在跑 / 没开跑的并入也还是目标那件事。对话包仍随新消息（latest wins）。
        { name: '没开跑 → appended：契约保留目标的，对话包随新消息', into: fresh('queued', { contract: { v: 1, deliverable: 'change' }, conversation: { old: true } }), mode: 'appended', after: (into) => { assert.deepEqual(into.contract, { v: 1, deliverable: 'change' }); assert.deepEqual(into.conversation, { anchor: null }) } },
        { name: '挂起 → resumed：契约保留目标的（补料续跑不变成代答）', into: fresh('waiting_confirmation', { contract: { v: 1, deliverable: 'change' } }), mode: 'resumed', after: (into) => assert.deepEqual(into.contract, { v: 1, deliverable: 'change' }) },
        { name: '在跑 → rerun_after_done：契约保留目标的', into: fresh('running', { contract: { v: 1, deliverable: 'change' } }), mode: 'rerun_after_done', after: (into) => assert.deepEqual(into.contract, { v: 1, deliverable: 'change' }) },
        { name: '已了结 → reopened：契约随新消息（续答按新问题的交付物跑）', into: fresh('done', { contract: { v: 1, deliverable: 'verification' } }), mode: 'reopened', after: (into) => assert.deepEqual(into.contract, { v: 1, deliverable: 'answer' }) },
        { name: '目标没契约（老任务）→ 用新消息的', into: fresh('blocked'), mode: 'resumed', after: (into) => assert.deepEqual(into.contract, { v: 1, deliverable: 'answer' }) },
        { name: '点名环境：重开 / 续跑跟新消息走（r3-c：复测 OL 并进 uat 那条）', into: fresh('done', { envTargets: ['uat'] }), source: from({ envTargets: ['online'] }), mode: 'reopened', after: (into) => assert.deepEqual(into.envTargets, ['online']) },
        { name: '点名环境：在跑 / 没开跑的取并集', into: fresh('queued', { envTargets: ['uat'] }), source: from({ envTargets: ['online', 'uat'] }), mode: 'appended', after: (into) => assert.deepEqual(into.envTargets, ['uat', 'online']) },
        { name: '点名环境：目标没点名 → 用新消息的', into: fresh('running'), source: from({ envTargets: ['pre'] }), mode: 'rerun_after_done', after: (into) => assert.deepEqual(into.envTargets, ['pre']) },
        { name: '点名环境：新消息没点名 → 目标保留', into: fresh('blocked', { envTargets: ['uat'] }), mode: 'resumed', after: (into) => assert.deepEqual(into.envTargets, ['uat']) },
        { name: '新消息没契约 / 对话包 → 目标保留自己的', into: fresh('queued', { contract: { v: 1, deliverable: 'change' }, conversation: { old: true } }), source: from({ contract: undefined, conversation: undefined }), mode: 'appended', after: (into) => { assert.deepEqual(into.contract, { v: 1, deliverable: 'change' }); assert.deepEqual(into.conversation, { old: true }) } },
        { name: 'commandType 只在目标没有时带过去', into: fresh('queued'), source: from({ commandType: 'status', commandTypeSource: 'inferred' }), mode: 'appended', after: (into) => { assert.equal(into.commandType, 'status'); assert.equal(into.commandTypeSource, 'inferred') } },
        { name: '目标已有 commandType 不覆盖；来源没 source 时补 explicit', into: fresh('queued', { commandType: 'fix' }), source: from({ commandType: 'status' }), mode: 'appended', after: (into) => assert.equal(into.commandType, 'fix') },
        { name: '来源 commandType 没 source → explicit', into: fresh('queued'), source: from({ commandType: 'api' }), mode: 'appended', after: (into) => assert.equal(into.commandTypeSource, 'explicit') },
        { name: '来源没正文只有附件 → 「（附件）」；目标没附件也合并', into: fresh('queued', { text: '' }), source: from({ text: '  ' }), mode: 'appended', after: (into) => assert.equal(into.text, '【同主题补充 2026-11-01T10:00】（附件）') },
        { name: 'mergedFrom 只留最近 50', into: fresh('queued', { mergedFrom: Array.from({ length: 50 }, (_, i) => `m${i}`) }), mode: 'appended', after: (into) => { assert.equal(into.mergedFrom.length, 50); assert.equal(into.mergedFrom.at(-1), 'from'); assert.equal(into.mergedFrom[0], 'm1') } },
        { name: '来源任务换代：在原 epoch 上 +1（挡它自己的迟到回写）', into: fresh('queued'), source: from({ epoch: 2 }), sourceEpoch: 3, mode: 'appended' },
        // 11-03 静态 review R8：A 问「test / pre 是否一样」→ answered；B 在同话题 @bot「有哪些差别」→ continues=A → reopened。原先并入不动
        // operator / replyTarget / messageId / threadRootId，结论回到 A 的消息、回落直发时 @ 的是 A，B 的回复义务停在 acked。
        // 终态重开 / 挂起续跑：回复目标与提单人换成新消息的（latest wins，与契约 / 对话包同口径）；在跑 / 没开跑的并入保持原目标。
        // messageId 不换（11-03 合入前 review）：它是任务自己那条消息，routes 的 retry 按它重下原附件；回复目标看 replyTarget。
        { name: 'answered → reopened：回复目标 / 提单人 / 话题根换成新消息的（latest wins），messageId 保留原任务的', into: fresh('answered', { operator: 'ou_a', replyTarget: { messageId: 'into', inThread: false }, messageId: 'into', threadRootId: 'th_a' }), source: from({ operator: 'ou_b', replyTarget: { messageId: 'from', inThread: true }, messageId: 'from', threadRootId: 'th_b' }), mode: 'reopened', after: (into) => assert.deepEqual([into.operator, into.replyTarget, into.messageId, into.threadRootId], ['ou_b', { messageId: 'from', inThread: true }, 'into', 'th_b']) },
        // 11-03 合入前 review：挂起续跑是补料（A 报 bug 挂着等文档，William「@bot 文档在这」并入），结论仍该回 A；补料人由 delivery 的并入人末行 @ 覆盖。
        { name: 'blocked → resumed：补料续跑，回复目标 / 提单人 / 话题根保持原任务的', into: fresh('blocked', { operator: 'ou_a', replyTarget: { messageId: 'into', inThread: false }, messageId: 'into', threadRootId: 'th_a' }), source: from({ operator: 'ou_w', replyTarget: { messageId: 'from', inThread: true }, messageId: 'from', threadRootId: 'th_w' }), mode: 'resumed', after: (into) => assert.deepEqual([into.operator, into.replyTarget.messageId, into.messageId, into.threadRootId], ['ou_a', 'into', 'into', 'th_a']) },
        // 11-03 合入前 review：B 并入 A 重开，结论 noteAnswer 只记在 A 的义务上，B 的停在 acked——重开把来源 id 记进 answerFor，出结论时一并记 answered。
        { name: 'done → reopened：来源 id 累加进 answerFor（出结论时它的回复义务一并结）', into: fresh('done', { answerFor: ['old'] }), mode: 'reopened', after: (into) => assert.deepEqual(into.answerFor, ['old', 'from']) },
        { name: 'blocked → resumed：不记 answerFor（补料续跑，结论回原提问）', into: fresh('blocked'), mode: 'resumed', after: (into) => assert.equal(into.answerFor, undefined) },
        { name: 'reopened 但新消息没带目标 / 提单人 → 保留目标自己的', into: fresh('done', { operator: 'ou_a', replyTarget: { messageId: 'into', inThread: false }, messageId: 'into', threadRootId: 'th_a' }), source: from({ operator: undefined, replyTarget: undefined, messageId: undefined, threadRootId: null }), mode: 'reopened', after: (into) => assert.deepEqual([into.operator, into.replyTarget.messageId, into.messageId, into.threadRootId], ['ou_a', 'into', 'into', 'th_a']) },
        { name: 'running → rerun_after_done：保持原目标 / 提单人（本轮结论还是回原消息）', into: fresh('running', { operator: 'ou_a', replyTarget: { messageId: 'into', inThread: false }, messageId: 'into' }), source: from({ operator: 'ou_b', replyTarget: { messageId: 'from', inThread: true }, messageId: 'from' }), mode: 'rerun_after_done', after: (into) => assert.deepEqual([into.operator, into.replyTarget.messageId, into.messageId], ['ou_a', 'into', 'into']) },
        { name: 'queued → appended：保持原目标 / 提单人', into: fresh('queued', { operator: 'ou_a', replyTarget: { messageId: 'into', inThread: false } }), source: from({ operator: 'ou_b', replyTarget: { messageId: 'from', inThread: false } }), mode: 'appended', after: (into) => assert.deepEqual([into.operator, into.replyTarget.messageId], ['ou_a', 'into']) },
        // 11-03 第二次 review #4：worker 的「群里已先回了一句」读 ackReply——并入时换成来源那条已发出的「收到」（这次答应的是它）；
        // 重开 / 续跑而来源还没发（routes 并入后才 flush，届时 flushPendingAck 再写到目标上）→ 目标那句是上一轮的，删掉；在跑 / 没开跑的那句这轮仍欠着，留着。
        { name: 'ackReply：来源已发过 → 换成来源的', into: fresh('done', { ackReply: 'A 那句' }), source: from({ ackReply: 'B 那句' }), mode: 'reopened', after: (into) => assert.equal(into.ackReply, 'B 那句') },
        { name: 'ackReply：重开 / 续跑、来源没发过 → 删掉目标上一轮那句', into: fresh('blocked', { ackReply: 'A 那句' }), mode: 'resumed', after: (into) => assert.equal('ackReply' in into, false) },
        { name: 'ackReply：重开、来源没发过 → 删掉', into: fresh('answered', { ackReply: 'A 那句' }), mode: 'reopened', after: (into) => assert.equal('ackReply' in into, false) },
        { name: 'ackReply：没开跑、来源没发过 → 目标那句留着（这轮还欠着）', into: fresh('queued', { ackReply: 'A 那句' }), mode: 'appended', after: (into) => assert.equal(into.ackReply, 'A 那句') },
        { name: 'ackReply：在跑、来源已发过 → 换成来源的', into: fresh('running', { ackReply: 'A 那句' }), source: from({ ackReply: 'B 那句' }), mode: 'rerun_after_done', after: (into) => assert.equal(into.ackReply, 'B 那句') },
        // 11-03 第二次 review #5：重开后 B 接着的是目标自己上一轮的结论，不是目标第一次分类时接着的那单；续跑 / 追加还是同一件事，留着。
        { name: 'priorConclusion：重开 → 换成目标自己上一轮的结论（outcome）', into: fresh('done', { summary: 's', outcome: { report: { answer: '不一样', items: [] } }, priorConclusion: { taskId: 'om_x', text: '别单' } }), mode: 'reopened', after: (into) => assert.deepEqual(into.priorConclusion, { taskId: 'into', summary: 's', text: '不一样' }) },
        { name: 'priorConclusion：重开、上一轮没 outcome → 用 result', into: fresh('answered', { result: '能发', priorConclusion: { taskId: 'om_x', text: '别单' } }), mode: 'reopened', after: (into) => assert.deepEqual(into.priorConclusion, { taskId: 'into', summary: null, text: '能发' }) },
        { name: 'priorConclusion：重开、上一轮什么都没有 → 删掉', into: fresh('failed', { priorConclusion: { taskId: 'om_x', text: '别单' } }), mode: 'reopened', after: (into) => assert.equal('priorConclusion' in into, false) },
        { name: 'priorConclusion：续跑 / 追加 → 保留（还是那件事，接着的那单仍是背景）', into: fresh('blocked', { result: '等文档', priorConclusion: { taskId: 'om_x', text: '别单' } }), mode: 'resumed', after: (into) => assert.deepEqual(into.priorConclusion, { taskId: 'om_x', text: '别单' }) },
        { name: '疑似挂起 → appended_suspected：保持原目标', into: fresh('waiting_confirmation', { suspected: true, operator: 'ou_a' }), source: from({ operator: 'ou_b' }), mode: 'appended_suspected', after: (into) => assert.equal(into.operator, 'ou_a') },
      ], ({ into, source, mode, after, sourceEpoch = 1 }) => {
        const r = run(into, source)
        assert.equal(r.mode, mode)
        assert.equal(r.into.updatedAt, NOW)
        assert.equal(r.source.status, 'superseded')
        assert.equal(r.source.supersededBy, 'into')
        assert.equal(r.source.epoch, sourceEpoch)
        assert.equal(r.source.updatedAt, NOW)
        assert.deepEqual(r.into.mergedFrom.slice(-1), ['from'])
        after?.(r.into)
      })
    }],
    ['isNudgeFollowUp：本条原话整句都是催办 / 客套词才算；剩任何别的字、自己带附件都不算', () => eachCase([
      { name: '这也麻烦在测试下', text: '【本条 @】这也麻烦在测试下', want: true },
      { name: '麻烦在看看 有没有问题', text: '【本条 @】@Aven.Bot 麻烦在看看 有没有问题', want: true },
      { name: '进度怎么样了？', text: '进度怎么样了？', want: true },
      { name: '没【本条 @】看首行', text: '帮忙看下\n验证码 123456', want: true },
      { name: '改成红色（新内容）', text: '【本条 @】改成红色', want: false },
      { name: '测一下 pre（点名环境）', text: '【本条 @】测一下 pre', want: false },
      { name: '用 508 再测', text: '【本条 @】用 508 再测', want: false },
      { name: '只 @ 没附言', text: '【本条 @】（无附言，只 @ 了机器人）', want: false },
      { name: '空', text: '', want: false },
      { name: '超过 20 字', text: `【本条 @】${'麻烦'.repeat(11)}`, want: false },
      { name: '恰好 20 字', text: `【本条 @】${'麻烦'.repeat(10)}`, want: true },
      { name: '自己带图', text: '【本条 @】看看', attachments: [{ type: 'image', imageKey: 'p' }], want: false },
      { name: '群上下文带进来的图不算', text: '【本条 @】看看', attachments: [{ type: 'image', imageKey: 'p', origin: '群里之前的消息' }], want: true },
    ], ({ text, attachments, want }) => assert.equal(isNudgeFollowUp({ text, attachments }), want))],
    ['mergeTaskObjects：缺任一方、同一条、目标已 superseded → null，不动对象', () => {
      const same = { id: 'a', status: 'queued' }
      assert.equal(mergeTaskObjects({ from: same, into: same, requeueTask: () => {} }), null)
      assert.equal(mergeTaskObjects({ from: null, into: same, requeueTask: () => {} }), null)
      assert.equal(mergeTaskObjects({ from: same, into: undefined, requeueTask: () => {} }), null)
      assert.equal(same.status, 'queued')
      // 11-02 复核：被兄弟并掉 / 人工取消的（superseded）不能当目标——原先掉进「终态重开」把取消的活复活再跑
      const gone = { id: 'g', status: 'superseded', text: '取消的', epoch: 3 }
      assert.equal(mergeTaskObjects({ from: same, into: gone, requeueTask: () => { throw new Error('不该换代') } }), null)
      assert.deepEqual([gone, same], [{ id: 'g', status: 'superseded', text: '取消的', epoch: 3 }, { id: 'a', status: 'queued' }])
    }],
    ['store：recordReceipt 记 chatId（重启后仍在）；resolveIntake 委托 applyIntakeClassification；幂等重放按新门槛算', () => {
      const dir = mkdtempSync(join(tmpdir(), 'lark-intake-'))
      try {
        const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
        store.upsert({ id: 'om_q', status: 'received', addressedToBot: true, text: '有哪些差别', intake: { required: true, trigger: 'direct' }, createdAt: '2026-11-01T00:00:00Z' })
        store.recordReceipt('om_q', { messageId: 'om_ack', kind: 'ack', chatId: 'oc_g' })
        const firstCreatedAt = store.get('om_q').receipts[0].createdAt
        assert.match(firstCreatedAt, /^\d{4}-\d{2}-\d{2}T/)
        store.recordReceipt('om_q', { messageId: 'om_ack', kind: 'ack' }) // 状态落地再登记一次（不带 chatId）：保留已知的会话 id 与首次登记时间
        store.recordReceipt('om_q', { messageId: 'om_old', kind: 'receipt' })
        const reloaded = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
        // om_old 的登记时间与首次登记可能落在同一毫秒，只核它有时间戳，不核不相等（11-02 偶发红）
        assert.deepEqual(reloaded.get('om_q').receipts.map((r) => [r.messageId, r.kind, r.chatId, r.messageId === 'om_ack' ? r.createdAt === firstCreatedAt : /^\d{4}-/.test(r.createdAt)]), [['om_ack', 'ack', 'oc_g', true], ['om_old', 'receipt', null, true]])
        const claimedEpoch = store.claimById('om_q').epoch
        store.upsert({ id: 'om_prev', status: 'done', text: '上一单', summary: '上一单实测', outcome: { summary: 'tid 18608' }, createdAt: '2026-11-01T00:00:00Z' })
        const classification = cls('question', 'high', { deliverable: 'answer', topic: 'diff', continues: 'om_prev' })
        const out = store.resolveIntake({ id: 'om_q', epoch: claimedEpoch, classification })
        assert.deepEqual(out.task.priorConclusion, { taskId: 'om_prev', summary: '上一单实测', text: 'tid 18608' }, 'store 按 id 查到接着的那条')
        assert.deepEqual([out.ok, out.actionable, out.requeue, out.selfAnswer, out.suspected], [true, true, true, false, false])
        assert.equal(out.task.status, 'queued')
        assert.equal(out.task.epoch, claimedEpoch + 1)
        assert.equal(out.task.contract.deliverable, 'answer')
        assert.equal(out.task.commandType, 'status')
        assert.equal(out.task.topic, 'diff')
        const replay = store.resolveIntake({ id: 'om_q', epoch: claimedEpoch, classification })
        assert.deepEqual([replay.ok, replay.alreadyResolved, replay.actionable], [true, true, true])
        // 负责人自答：不换代、answered；重放 actionable=false 按当前代次
        store.upsert({ id: 'om_self', status: 'received', addressedToBot: true, fromPrincipal: true, text: '你能发邮件吗', intake: { required: true, trigger: 'direct' }, createdAt: '2026-11-01T00:00:00Z' })
        const selfEpoch = store.claimById('om_self').epoch
        const selfCls = cls('question', 'high', { selfAnswer: true, deliverable: 'answer', reply: '能发' })
        const selfOut = store.resolveIntake({ id: 'om_self', epoch: selfEpoch, classification: selfCls })
        assert.deepEqual([selfOut.selfAnswer, selfOut.actionable, selfOut.task.status, selfOut.task.result, selfOut.task.epoch], [true, false, 'answered', '能发', selfEpoch])
        const selfReplay = store.resolveIntake({ id: 'om_self', epoch: selfEpoch, classification: selfCls })
        assert.deepEqual([selfReplay.alreadyResolved, selfReplay.actionable], [true, false])
        assert.equal(createTaskStore({ tasksDir: dir, leaseMs: 1000 }).get('om_self').selfAnswered, true, '持久化了')
        // 疑似：挂起、不换代
        store.upsert({ id: 'om_sus', status: 'received', addressedToBot: true, text: 'x', intake: { required: true, trigger: 'direct' }, createdAt: '2026-11-01T00:00:00Z' })
        const susEpoch = store.claimById('om_sus').epoch
        const susOut = store.resolveIntake({ id: 'om_sus', epoch: susEpoch, classification: cls('bug', 'low') })
        assert.deepEqual([susOut.suspected, susOut.task.status, susOut.task.epoch], [true, 'waiting_confirmation', susEpoch])
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }],
    ['store：mergeIntoTask 两份都持久化；listRecentForChat 口径；listSuspected / expireSuspected 48h', () => {
      const dir = mkdtempSync(join(tmpdir(), 'lark-intake-'))
      try {
        const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
        const now = Date.now()
        const iso = (ms) => new Date(ms).toISOString()
        store.upsert({ id: 'into', status: 'waiting_confirmation', chatId: 'oc_g', text: '原问题', epoch: 1, createdAt: iso(now - 3_600_000) })
        store.upsert({ id: 'from', status: 'received', chatId: 'oc_g', text: '补一句', epoch: 0, contract: { v: 1, deliverable: 'answer' }, createdAt: iso(now) })
        const merged = store.mergeIntoTask({ fromId: 'from', intoId: 'into' })
        assert.equal(merged.mode, 'resumed')
        assert.equal(merged.into.id, 'into')
        assert.equal(merged.from.status, 'superseded')
        const reloaded = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
        assert.equal(reloaded.get('into').status, 'queued')
        assert.equal(reloaded.get('into').epoch, 2)
        assert.equal(reloaded.get('into').contract.deliverable, 'answer')
        assert.equal(reloaded.get('from').supersededBy, 'into')
        assert.equal(store.mergeIntoTask({ fromId: 'nope', intoId: 'into' }), null)
        assert.equal(store.mergeIntoTask({ fromId: 'into', intoId: 'into' }), null)
        // listRecentForChat：同群、排除自身、排除 superseded / ignored / intake_failed、7 天内、新的在前、limit
        const day = 24 * 60 * 60_000
        store.upsert({ id: 'r_old', status: 'done', chatId: 'oc_g', createdAt: iso(now - 8 * day) })
        store.get('r_old').updatedAt = iso(now - 8 * day)
        store.upsert({ id: 'r_other', status: 'done', chatId: 'oc_other', createdAt: iso(now) })
        store.upsert({ id: 'r_ign', status: 'ignored', chatId: 'oc_g', createdAt: iso(now) })
        store.upsert({ id: 'r_fail', status: 'intake_failed', chatId: 'oc_g', createdAt: iso(now) })
        store.upsert({ id: 'r_done', status: 'done', chatId: 'oc_g', createdAt: iso(now - 2 * day) })
        store.get('r_done').updatedAt = iso(now - 2 * day)
        store.upsert({ id: 'r_ans', status: 'answered', chatId: 'oc_g', createdAt: iso(now - day) })
        store.get('r_ans').updatedAt = iso(now - day)
        const ids = store.listRecentForChat('oc_g', { excludeId: 'into' }).map((t) => t.id)
        assert.deepEqual(ids, ['r_ans', 'r_done'])
        assert.deepEqual(store.listRecentForChat('oc_g', { excludeId: 'r_ans', limit: 1 }).map((t) => t.id), ['into'])
        assert.deepEqual(store.listRecentForChat('oc_g', { days: 1.5 }).map((t) => t.id), ['into', 'r_ans'])
        assert.deepEqual(store.listRecentForChat('oc_none'), [])
        // 磁盘上的老任务没有 updatedAt：按 createdAt 算入窗、排序；建得很早但最近更新过的按更新时间算
        const dir2 = join(dir, 'reload')
        mkdirSync(dir2)
        writeFileSync(join(dir2, 'r_disk.json'), JSON.stringify({ id: 'r_disk', status: 'done', chatId: 'oc_g', createdAt: iso(now - 36 * 3_600_000) }))
        const reloaded2 = createTaskStore({ tasksDir: dir2, leaseMs: 1000 })
        for (const [id, createdAt, updatedAt] of [['r_touched', now - 8 * day, now - 12 * 3_600_000], ['r_ans2', now - day, now - day], ['r_done2', now - 2 * day, now - 2 * day], ['r_mem', now - 30 * 3_600_000, null]]) {
          reloaded2.upsert({ id, status: 'done', chatId: 'oc_g', createdAt: iso(createdAt) })
          if (updatedAt) reloaded2.get(id).updatedAt = iso(updatedAt)
          else delete reloaded2.get(id).updatedAt // 内存里也可能只有 createdAt（后写入的也按它排）
        }
        assert.deepEqual(reloaded2.listRecentForChat('oc_g').map((t) => t.id), ['r_touched', 'r_ans2', 'r_mem', 'r_disk', 'r_done2'])
        mock.timers.enable({ apis: ['Date'], now })
        try {
          reloaded2.upsert({ id: 'tie_a', status: 'done', chatId: 'oc_g', createdAt: iso(now) })
          reloaded2.upsert({ id: 'tie_b', status: 'done', chatId: 'oc_g', createdAt: iso(now) })
          assert.deepEqual(reloaded2.listRecentForChat('oc_g', { days: 0, excludeId: 'into' }).map((t) => t.id), ['tie_b', 'tie_a'], '恰好在窗口边界的算在内；同一时刻后写的在前')
        } finally {
          mock.timers.reset()
        }
        // 疑似过期（恰好 48 小时也算过期）
        store.upsert({ id: 's_old', status: 'waiting_confirmation', suspected: true, parkedAt: iso(now - 49 * 3_600_000), result: '疑似：x', createdAt: iso(now - 50 * 3_600_000) })
        store.upsert({ id: 's_edge', status: 'waiting_confirmation', suspected: true, parkedAt: iso(now - 48 * 3_600_000), createdAt: iso(now) })
        store.upsert({ id: 's_new', status: 'waiting_confirmation', suspected: true, parkedAt: iso(now - 47 * 3_600_000), createdAt: iso(now) })
        store.upsert({ id: 's_wait', status: 'waiting_confirmation', parkedAt: iso(now - 90 * 3_600_000), createdAt: iso(now) })
        store.upsert({ id: 's_noparked', status: 'waiting_confirmation', suspected: true, createdAt: iso(now) })
        store.get('s_noparked').updatedAt = iso(now - 60 * 3_600_000)
        assert.deepEqual(store.listSuspected().map((t) => t.id).sort(), ['s_edge', 's_new', 's_noparked', 's_old'])
        const expired = store.expireSuspected({ now })
        assert.deepEqual(expired.map((t) => t.id).sort(), ['s_edge', 's_noparked', 's_old'])
        assert.equal(store.get('s_old').status, 'ignored')
        assert.equal(store.get('s_old').suspected, false)
        assert.equal(store.get('s_old').parkedAt, null)
        assert.equal(store.get('s_old').expiredAt, iso(now))
        assert.equal(store.get('s_old').result, '疑似：x\n（疑似任务 48 小时无人放行，自动关闭）')
        assert.equal(store.get('s_new').status, 'waiting_confirmation')
        assert.equal(store.get('s_wait').status, 'waiting_confirmation')
        assert.deepEqual(store.listSuspected().map((t) => t.id), ['s_new'])
        assert.deepEqual(store.expireSuspected({ now, maxAgeMs: 46 * 3_600_000 }).map((t) => t.id), ['s_new'])
        assert.equal(createTaskStore({ tasksDir: dir, leaseMs: 1000 }).get('s_old').status, 'ignored', '持久化了')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }],
  ]))
})
