import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { claudeModelArgs, namespacedClaudeModel } from '../lib/lark-claude-args.mjs'

// 11-04：apikey 切线路后 bot 钉的裸模型名在 reachvpn 上不认；前缀由 claude.env 的 LARK_CLAUDE_MODEL_NAMESPACE 给。
describe('claude 模型命名空间', () => {
  it('裸名按线路加前缀、已带前缀不重复、空模型不造；claudeModelArgs 统一出口带上', () => {
    const NS = '@hqex-react-aventong-3/'
    for (const [model, ns, want] of [
      ['claude-opus-5-5', '', 'claude-opus-5-5'],
      ['claude-opus-5-5', undefined, 'claude-opus-5-5'],
      ['claude-opus-5-5', NS, `${NS}claude-opus-5-5`],
      ['claude-opus-5-5', '@hqex-react-aventong-3', `${NS}claude-opus-5-5`],
      ['@x/claude-opus-5-5', NS, '@x/claude-opus-5-5'],
      [null, NS, null],
    ]) assert.equal(namespacedClaudeModel(model, ns), want, `${model} + ${ns}`)
    assert.deepEqual(claudeModelArgs({ model: 'claude-opus-5-5', effort: 'high', namespace: NS }), ['--model', `${NS}claude-opus-5-5`, '--effort', 'high'])
    assert.deepEqual(claudeModelArgs({ model: null, effort: null, namespace: NS }), [])
  })
})
