import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { postGroupSummary, resolveMentions } from '../lib/lark-group-reply.mjs'

const ownerMap = { Ache: 'ou_ache', Encone: 'ou_encone', aven: 'ou_aven' }

describe('群回复共用件', () => {
  it('负责人名字 → open_id：精确 / 包含匹配，重复合并，查不到保留名字', () => {
    const mentions = resolveMentions({ followUps: [{ owner: '.Ache.l', items: ['A9 分页参数'] }, { owner: 'Ache', items: ['A10 封面 404'] }, { owner: '运维', items: ['O10'] }], ownerMap })
    assert.deepEqual(mentions.map((m) => [m.owner, m.openId, m.items.length]), [['Ache', 'ou_ache', 1], ['运维', null, 1]])
  })

  it('用户身份发外部群已下线（aven 2026-10-20 review：跨租户 230027 被拒）：postGroupSummary 什么都不发', async () => {
    const out = await postGroupSummary({ task: { id: 't', chatId: 'oc_falive', repo: 'falive', groupReply: '接完了' }, deps: { sendUserText: async () => { throw new Error('不该发') } } })
    assert.deepEqual(out, { ok: false, skipped: true, reason: 'user-identity group post retired' })
  })
})
