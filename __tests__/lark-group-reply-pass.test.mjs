import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildGroupReplyPassPrompt, docIntakeGroupReply, owesGroupReply, runGroupReplyPass } from '../lib/lark-group-reply-pass.mjs'

// 10-23 #79：群里回过「…查完回你」、执行器结论没写群回复 → 续会话补写一次。
const task = { id: 't', repo: 'falive', ackedInGroup: true, ackReply: '收到截图，我对比下参数差在哪，查完回你' }
const result = { status: 'done', groupReply: null, report: null, summary: '原因是 pre 上前端旧版本' }

describe('群里答应过下文的补写群回复', () => {
  it('只在回过收到、终态可发群、没显式静默、群回复和 report 都没写时才欠', () => {
    assert.equal(owesGroupReply({ task, result }), true)
    assert.equal(owesGroupReply({ task, result: { ...result, status: 'no_change_needed' } }), true)
    assert.equal(owesGroupReply({ task: { ...task, ackedInGroup: false }, result }), false, '没回过收到：维持原规则')
    assert.equal(owesGroupReply({ task: { ...task, repo: undefined }, result }), false)
    assert.equal(owesGroupReply({ task, result: { ...result, status: 'failed' } }), false, '失败只私聊（I6）')
    assert.equal(owesGroupReply({ task, result: { ...result, groupSilent: true } }), false, '执行侧显式判群里无事可说')
    assert.equal(owesGroupReply({ task, result: { ...result, groupReply: '查到了' } }), false)
    assert.equal(owesGroupReply({ task, result: { ...result, report: { subject: 'x', answer: null, items: [] } } }), false)
  })

  it('提示带上群里答应过的那句，只补写不改代码，不写分支 / 提交号 / 路径', () => {
    const prompt = buildGroupReplyPassPrompt({ task })
    assert.match(prompt, /查完回你/)
    assert.match(prompt, /不改任何代码/)
    assert.match(prompt, /不写分支名、提交号、文件路径/)
  })

  it('续会话补上 groupReply 并回 aiRun.result；没会话 / 不是 claude / 补写为空 / 抛错都返回 false 不动结果', async () => {
    const calls = []
    const aiRun = { result: { ...result }, sessionId: 's1', executor: 'claude' }
    const ok = await runGroupReplyPass({ task, aiRun, cwd: '/w', exec: async (opts) => { calls.push(opts); return { result: { groupReply: '  查到了：pre 前端旧版本  ' } } } })
    assert.equal(ok, true)
    assert.equal(aiRun.result.groupReply, '查到了：pre 前端旧版本')
    assert.equal(aiRun.result.summary, result.summary, '其余字段照旧')
    assert.deepEqual([calls[0].resumeSessionId, calls[0].cwd, calls[0].executor], ['s1', '/w', 'claude'])
    for (const run of [{ sessionId: null, executor: 'claude' }, { sessionId: 's', executor: 'codex' }]) {
      const other = { result: { ...result }, ...run }
      assert.equal(await runGroupReplyPass({ task, aiRun: other, exec: async () => { throw new Error('不该调') } }), false)
    }
    const empty = { result: { ...result }, sessionId: 's', executor: 'claude' }
    assert.equal(await runGroupReplyPass({ task, aiRun: empty, exec: async () => ({ result: { groupReply: null, report: null } }) }), false)
    assert.equal(await runGroupReplyPass({ task, aiRun: empty, exec: async () => { throw new Error('boom') } }), false)
    assert.equal(empty.result.groupReply, null)
  })

  // 10-23 #81：对接文档入库原是一律不回群（#44）；群里回过「收到，按文档改」的答应了下文，结论照常回群。
  it('文档入库：回过收到 → 保留群回复、不静默；没回过收到 → 维持静默', () => {
    assert.deepEqual(docIntakeGroupReply({ task, result: { groupReply: ' 文档收到，已按它接好 ' } }), { groupReply: '文档收到，已按它接好', groupSilent: false })
    assert.deepEqual(docIntakeGroupReply({ task, result: { groupReply: null } }), { groupReply: null, groupSilent: false }, '补写也没成：交出口按 #79 草稿私聊负责人')
    assert.deepEqual(docIntakeGroupReply({ task: { ...task, ackedInGroup: false }, result: { groupReply: '不该发' } }), { groupReply: null, groupSilent: true })
  })
})

