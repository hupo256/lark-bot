import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildGroupReplyPassPrompt, docIntakeGroupReply, otherOwnerGroupReply, owesGroupReply, runGroupReplyPass } from '../lib/lark-group-reply-pass.mjs'

// 10-23 #79：群里回过「…查完回你」、执行器结论没写群回复 → 续会话补写一次。
const task = { id: 't', repo: 'falive', ackedInGroup: true, ackReply: '收到截图，我对比下参数差在哪，查完回你' }
const result = { status: 'done', groupReply: null, report: null, summary: '原因是 pre 上前端旧版本' }

describe('群里答应过下文的补写群回复', () => {
  it('欠不欠群回复的判定与补写提示', () => {
    const t1 = '只在回过收到、终态可发群、没显式静默、群回复和 report 都没写时才欠'
    assert.equal(owesGroupReply({ task, result }), true, t1)
    assert.equal(owesGroupReply({ task, result: { ...result, status: 'no_change_needed' } }), true, t1)
    assert.equal(owesGroupReply({ task: { ...task, ackedInGroup: false }, result }), false, '没回过收到：维持原规则')
    assert.equal(owesGroupReply({ task: { ...task, repo: undefined }, result }), false, t1)
    assert.equal(owesGroupReply({ task, result: { ...result, status: 'failed' } }), false, '失败只私聊（I6）')
    assert.equal(owesGroupReply({ task, result: { ...result, groupSilent: true } }), false, '执行侧显式判群里无事可说')
    assert.equal(owesGroupReply({ task, result: { ...result, groupReply: '查到了' } }), false, t1)
    assert.equal(owesGroupReply({ task, result: { ...result, report: { subject: 'x', answer: null, items: [] } } }), false, t1)

    const t2 = '提示带上群里答应过的那句，只补写不改代码，不写分支 / 提交号 / 路径'
    const prompt = buildGroupReplyPassPrompt({ task })
    assert.match(prompt, /查完回你/, t2)
    assert.match(prompt, /不改任何代码/, t2)
    assert.match(prompt, /不写分支名、提交号、文件路径/, t2)
  })

  it('续会话补写 groupReply 的成败处理；文档入库 / 归属别人按是否回过收到决定有无下文', async () => {
    const t1 = '续会话补上 groupReply 并回 aiRun.result；没会话 / 不是 claude / 补写为空 / 抛错都返回 false 不动结果'
    const calls = []
    const aiRun = { result: { ...result }, sessionId: 's1', executor: 'claude' }
    const ok = await runGroupReplyPass({ task, aiRun, cwd: '/w', exec: async (opts) => { calls.push(opts); return { result: { groupReply: '  查到了：pre 前端旧版本  ' } } } })
    assert.equal(ok, true, t1)
    assert.equal(aiRun.result.groupReply, '查到了：pre 前端旧版本', t1)
    assert.equal(aiRun.result.summary, result.summary, '其余字段照旧')
    assert.deepEqual([calls[0].resumeSessionId, calls[0].cwd, calls[0].executor], ['s1', '/w', 'claude'], t1)
    for (const run of [{ sessionId: null, executor: 'claude' }, { sessionId: 's', executor: 'codex' }]) {
      const other = { result: { ...result }, ...run }
      assert.equal(await runGroupReplyPass({ task, aiRun: other, exec: async () => { throw new Error('不该调') } }), false, t1)
    }
    const empty = { result: { ...result }, sessionId: 's', executor: 'claude' }
    assert.equal(await runGroupReplyPass({ task, aiRun: empty, exec: async () => ({ result: { groupReply: null, report: null } }) }), false, t1)
    assert.equal(await runGroupReplyPass({ task, aiRun: empty, exec: async () => { throw new Error('boom') } }), false, t1)
    assert.equal(empty.result.groupReply, null, t1)

    // 10-23 #81：对接文档入库原是一律不回群（#44）；群里回过「收到，按文档改」的答应了下文，结论照常回群。
    const t2 = '文档入库 / 归属别人：回过收到（或 @ 过 bot）→ 有下文；都没有 → 维持静默'
    assert.deepEqual(docIntakeGroupReply({ task, result: { groupReply: ' 文档收到，已按它接好 ' } }), { groupReply: '文档收到，已按它接好', groupSilent: false }, t2)
    assert.deepEqual(docIntakeGroupReply({ task, result: { groupReply: null } }), { groupReply: null, groupSilent: false }, '补写也没成：交出口按 #79 草稿私聊负责人')
    assert.deepEqual(docIntakeGroupReply({ task: { ...task, ackedInGroup: false }, result: { groupReply: '不该发' } }), { groupReply: null, groupSilent: true }, t2)
    // 10-24 真机：Encone @bot 报他人主页游客打不开，归属判 henry → 原来静默忽略。@ 过 bot / 回过收到的回一句归谁（@ 由网关按 ownerMap 补）。
    const otherOwner = { status: 'no_change_needed', noChangeReason: 'other_owner', owner: 'henry', groupReply: null }
    const reply = otherOwnerGroupReply({ task: { addressedToBot: true }, result: otherOwner, featureIds: ['46', '#1'] })
    assert.match(reply, /henry 负责的部分（功能总表 #46、#1）/, t2)
    assert.doesNotMatch(reply, /<at/, t2)
    assert.equal(otherOwnerGroupReply({ task: { ackedInGroup: true }, result: { ...otherOwner, groupReply: ' 问题在前端 ' } }), '问题在前端', t2)
    assert.equal(otherOwnerGroupReply({ task: {}, result: otherOwner }), null, '没 @ bot、也没回过收到：维持静默')
  })
})

