import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { assessDoneResult, allowsDocsOnlyDone } from '../lib/lark-quality-gate.mjs'
import { applyIntakeClassification, intakeActionable } from '../lib/lark-intake-resolve.mjs'
import { isReadOnlyTask } from '../lib/lark-message.mjs'
import { deriveContract, isReadOnlyAsk, refreshContract, taskContract } from '../lib/lark-task-contract.mjs'
import { WORK_KINDS, expectsCodeChange, requirementGate, resolveWorkKind } from '../lib/lark-work-policy.mjs'
import { isDefectCandidate } from '../lib/lark-defect-rules.mjs'

// 任务契约（10-21 架构加固 P2）：一条仓库任务交付什么只算一次，各处判定读同一份。
const task = ({ own, decision = 'requirement', quoted = '请测试同学在 pre 看一眼', ...rest }) => ({
  id: 't', repo: 'falive', source: 'lark', addressedToBot: true, attachments: [],
  text: `【被引用消息】\n${quoted}\n\n【本条 @】@Aven.Bot ${own}`,
  intake: { classification: { decision, confidence: 'high', forMe: true } }, ...rest,
})

describe('任务契约', () => {
  it('deliverable 只看本条原话：复测 / 回答 / 改代码 / 文档入库', () => {
    assert.equal(deriveContract(task({ own: '你自己在 pre 环境看，看完报告结果' })).deliverable, 'verification', '#58')
    assert.equal(deriveContract(task({ own: '在浏览器里看一下滚到底' })).deliverable, 'verification')
    assert.equal(deriveContract(task({ own: '改一下文案，改完在 pre 看下' })).deliverable, 'change', '带了改东西不是纯复测')
    assert.equal(deriveContract(task({ own: '这个接口字段不对', decision: 'bug' })).deliverable, 'change', '引用卡里那句「在 pre 看一眼」不算')
    assert.equal(deriveContract(task({ own: '头像是哪个接口', decision: 'question' })).deliverable, 'answer')
    assert.equal(deriveContract(task({ own: '状态：项目进度' })).source, 'prefix')
    assert.equal(deriveContract(task({ own: '看下', attachments: [{ type: 'file', fileName: '对接-直播.md' }] })).deliverable, 'doc_intake')
    assert.equal(deriveContract(task({ own: 'x', intake: { classification: { decision: 'requirement', deliverable: 'verification' } } })).source, 'classifier', '分类器给了 deliverable 优先')
    assert.equal(deriveContract({ id: 'x', text: 'y' }), null, '非仓库任务没有契约')
  })

  it('#58 那条：契约让各处判定一致——不只读、给浏览器、不走新需求闸、空 diff / 只改文档都算完成', () => {
    const t = task({ own: '你自己在 pre 环境看，看完报告结果', fromPrincipal: true })
    t.contract = deriveContract(t)
    assert.equal(isReadOnlyTask(t), false, '要在 worktree 里跑（能用 Playwright）')
    assert.equal(t.contract.browser, true)
    assert.equal(resolveWorkKind(t), WORK_KINDS.verification)
    assert.equal(requirementGate(t), null)
    assert.equal(expectsCodeChange({ task: t }), false)
    assert.equal(isDefectCandidate({ task: t }), false)
    assert.equal(allowsDocsOnlyDone({ task: t }), true)
    assert.equal(assessDoneResult({ actualChangedFiles: [], expectsCodeFix: false, emptyDiffOk: t.contract.emptyDiffOk }).trustworthy, true, '空 diff 不判失败')
    assert.equal(assessDoneResult({ actualChangedFiles: [], expectsCodeFix: true }).trustworthy, false, '改代码任务空 diff 照样不可信')
  })

  it('回答类只读；改代码类要改代码、只改文档不算完成（对接答复除外）', () => {
    const q = task({ own: '头像是哪个接口', decision: 'question' })
    q.contract = deriveContract(q)
    assert.equal(isReadOnlyTask(q), true)
    const fix = task({ own: '预约按钮颜色改成红色', decision: 'requirement' })
    fix.contract = deriveContract(fix)
    assert.equal(expectsCodeChange({ task: fix }), true)
    assert.equal(allowsDocsOnlyDone({ task: fix }), false)
    const api = task({ own: '接口更新了，再试试', decision: 'api_reply' })
    api.contract = deriveContract(api)
    assert.equal(api.contract.docsOnlyOk, true)
    assert.equal(api.contract.api, true)
  })

  it('分类回写时落盘；读取按版本，老任务现算；正文改写可重算', () => {
    const t = { ...task({ own: '你自己在 pre 环境看，看完报告结果' }), status: 'running', intake: { required: true } }
    applyIntakeClassification(t, { classification: { decision: 'requirement', confidence: 'high', forMe: true } })
    assert.equal(t.contract.deliverable, 'verification')
    assert.equal(taskContract({ ...t, contract: { v: 0 } }).v, 1, '旧版本现算')
    t.text = '【本条 @】@Aven.Bot 把按钮改成红色'
    assert.equal(refreshContract(t).contract.deliverable, 'change')
  })

  it('10-23 #74：forMe=true 的 medium 直接开跑，归属拿不准才挂疑似；对接答复前端不用做 → 只记一笔，契约不算改代码', () => {
    const t = (cls, extra = {}) => ({ id: 't', repo: 'falive', addressedToBot: true, attachments: [], text: '@Aven.Bot x', ...extra, intake: { classification: { confidence: 'medium', summary: 's', ...cls } } })
    assert.equal(intakeActionable(t({}), { decision: 'bug', confidence: 'medium', forMe: true }), true)
    assert.equal(intakeActionable(t({}), { decision: 'bug', confidence: 'medium', forMe: null }), false)
    assert.equal(intakeActionable(t({}), { decision: 'bug', confidence: 'high' }), true)
    const notice = t({ decision: 'api_reply', forMe: true, deliverable: null })
    const out = applyIntakeClassification(notice, { classification: notice.intake.classification })
    assert.deepEqual([out.actionable, out.suspected, out.recordOnly, notice.status, notice.recordOnly], [false, false, true, 'ignored', true])
    assert.deepEqual([notice.contract.deliverable, notice.contract.expectsCode], ['record', false])
    // 带来了等的东西 / 拿不准归属但要改代码：不算只记一笔
    const brought = t({ decision: 'api_reply', forMe: true, deliverable: null, satisfiesWait: true })
    assert.equal(applyIntakeClassification(brought, { classification: brought.intake.classification }).actionable, true)
    const unsure = t({ decision: 'api_reply', forMe: null, deliverable: 'change' })
    assert.equal(applyIntakeClassification(unsure, { classification: unsure.intake.classification }).suspected, true)
    // aven 2026-10-24：@bot 让测试 / 复测 / 确认 / 查找的，只要不改代码就直接做，不看归属；要改代码的、没 @ bot 的照旧按归属。
    const ro = (extra = {}) => ({ id: 't', repo: 'falive', addressedToBot: true, attachments: [], text: '【本条 @】@Aven.Bot Bug-4942 再复测下！', ...extra })
    assert.equal(intakeActionable(ro(), { decision: 'bug', confidence: 'medium', forMe: false, deliverable: 'verification' }), true)
    assert.equal(intakeActionable(ro(), { decision: 'question', confidence: 'medium', forMe: false, deliverable: 'answer' }), true)
    assert.equal(isReadOnlyAsk(ro(), { decision: 'bug', confidence: 'medium', deliverable: 'verification' }), true)
    // 归别人时分类器判 ignore，但照填了 deliverable：照样放行（10-24 William 让测 fameEx/market/symbol/list）
    assert.equal(intakeActionable(ro(), { decision: 'ignore', confidence: 'medium', forMe: false, deliverable: 'verification' }), true)
    assert.equal(intakeActionable(ro(), { decision: 'ignore', confidence: 'medium', forMe: false, deliverable: null }), false)
    const william = ro()
    applyIntakeClassification(william, { classification: { decision: 'ignore', confidence: 'medium', forMe: false, deliverable: 'verification', reply: '这个接口找 Broker 联调' } })
    assert.deepEqual([william.intake.classification.reply, william.contract.deliverable], [null, 'verification'], '推托的 reply 不当收到发')
    assert.equal(intakeActionable(ro({ privateOrigin: { anchorHead: 'x' } }), { decision: 'ignore', confidence: 'high', forMe: false, deliverable: 'verification' }), false, '负责人私聊说不做')
    assert.equal(intakeActionable(ro(), { decision: 'bug', confidence: 'high', forMe: false, deliverable: 'change' }), false)
    assert.equal(isReadOnlyAsk(ro({ addressedToBot: false }), { decision: 'bug', confidence: 'high', deliverable: 'verification' }), false)
  })
})
