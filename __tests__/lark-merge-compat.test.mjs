/**
 * 延续并入的交付物兼容性（lib/lark-routes-intake.compatibleContinuation，11-03 falive 回放）。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { compatibleContinuation, resolveMergeTarget } from '../lib/lark-routes-intake.mjs'

const c = (deliverable) => ({ deliverable })
describe('continues 只在交付物兼容时并入', () => {
  it('目标还没开跑 / 在等补料：什么都能并；在跑或已了结：只有同一种交付物才算延续；没契约照旧', () => {
    const me = (d) => ({ id: 'om_me', contract: d ? c(d) : null })
    const target = (status, d) => ({ id: 'om_t', status, contract: d ? c(d) : null })
    assert.equal(compatibleContinuation({ task: me('change'), target: target('queued', 'answer') }), true, '还没开跑：一起跑')
    assert.equal(compatibleContinuation({ task: me('change'), target: target('waiting_confirmation', 'answer') }), true, '等补料：并进去')
    assert.equal(compatibleContinuation({ task: me('answer'), target: target('answered', 'answer') }), true, '追问 → 原答疑')
    assert.equal(compatibleContinuation({ task: me('change'), target: target('running', 'change') }), true, '补料 → 在跑的改码单')
    assert.equal(compatibleContinuation({ task: me('change'), target: target('answered', 'answer') }), false, '答完的清单 + 新交办：另起')
    assert.equal(compatibleContinuation({ task: me('verification'), target: target('done', 'answer') }), false, '答完 + 要实测：另起')
    assert.equal(compatibleContinuation({ task: me('verification'), target: target('running', 'answer') }), false, '在跑的答疑 + 要实测：另起')
    assert.equal(compatibleContinuation({ task: me(null), target: target('done', 'answer') }), true, '本条没契约：照旧')
    assert.equal(compatibleContinuation({ task: me('change'), target: target('done', null) }), true, '目标没契约：照旧')
  })
  it('resolveMergeTarget：continues 指向交付物不同的已了结任务 → 不并（null）；兼容的照并', () => {
    const tasks = new Map([['om_list', { id: 'om_list', status: 'answered', contract: c('answer') }], ['om_fix', { id: 'om_fix', status: 'running', contract: c('change') }]])
    const store = { get: (id) => tasks.get(id) || null }
    const quiet = console.log
    console.log = () => {}
    try {
      assert.equal(resolveMergeTarget({ task: { id: 'om_me', contract: c('change'), intake: { classification: { decision: 'api_reply', continues: 'om_list' } } }, store }), null)
      assert.equal(resolveMergeTarget({ task: { id: 'om_me', contract: c('verification'), intake: { classification: { decision: 'requirement', continues: 'om_list' } } }, store }), null)
      assert.equal(resolveMergeTarget({ task: { id: 'om_me', contract: c('answer'), intake: { classification: { decision: 'question', continues: 'om_list' } } }, store })?.id, 'om_list')
      assert.equal(resolveMergeTarget({ task: { id: 'om_me', contract: c('change'), intake: { classification: { decision: 'bug', continues: 'om_fix' } } }, store })?.id, 'om_fix')
    } finally {
      console.log = quiet
    }
  })
})
