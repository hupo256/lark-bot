import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { completionContradictionNote, findCompletionContradiction, findCountMismatch } from '../lib/lark-completion-check.mjs'
import { eachCase } from './support/steps.mjs'

describe('完成结论的机械矛盾检查（从 falive 移植 #56 #58）', () => {
  it('总括完成词 + 未完成信号 = 矛盾；否定 / 到底为空 / uid 508 不算；结论行数量与条目数不符 = 对不上；没问题返回 null', () => eachCase([
    { name: '都对完了又列 500', text: '接口都已对完。\n- getRoomInfo 回 500', note: /结论自相矛盾：说「都已对完」又列了「回 500」/ },
    { name: '否定说法是好了的证据（#56）', text: '都通了，第 2 页不再报错', note: null },
    { name: '分页到底为空是正常现象（#58）', text: '都通了：第 3 页为空说明到底了', note: null },
    { name: 'uid 508 不是 5xx', text: '全部完成，用 pre 测试号（uid 508）复测过', note: null },
    { name: '没有数据是问题', text: '全部完成\n- 排行榜没有数据', note: /又列了「没有数据」/ },
    { name: '还剩 2 项却列了 5 条', text: '还剩 2 项要确认\n- a\n- b\n- 已做 c\n- 已做 d\n- 已做 e', note: /第一行说「还剩 2 项」，下面却列了 5 条/ },
    { name: '中文数字也认', text: '还有三个点\n✅ a\n⚠️ b\n❌ c', note: null },
    { name: '结论行没给数量不比', text: '做完了\n- a\n- b', note: null },
  ], ({ text, note }) => {
    const got = completionContradictionNote(text)
    if (note) assert.match(got || '', note)
    else assert.equal(got, null)
  }).then(() => {
    assert.deepEqual(findCompletionContradiction('都好了。- 还差 1 项'), { blanket: '都好了', issue: '还差' })
    assert.deepEqual(findCountMismatch('还剩 2 项\n- a\n- b\n- c'), { lead: '还剩 2 项', expected: 2, actual: 3 })
    assert.equal(findCountMismatch('还剩 2 项\n没有条目'), null)
  }))
})
