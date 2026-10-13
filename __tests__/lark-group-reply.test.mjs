import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { buildGroupText, postGroupSummary, resolveMentions } from '../lib/lark-group-reply.mjs'
import { registerRepoProfiles, resetRepoProfiles } from '../lib/lark-repo-profile.mjs'

const ownerMap = { Ache: 'ou_ache', Encone: 'ou_encone', aven: 'ou_aven' }

describe('群回复（A 方案：以负责人身份发）', () => {
  afterEach(() => resetRepoProfiles())

  it('负责人名字 → open_id：精确 / 包含匹配，重复合并，查不到保留名字', () => {
    const mentions = resolveMentions({ followUps: [{ owner: '.Ache.l', items: ['A9 分页参数'] }, { owner: 'Ache', items: ['A10 封面 404'] }, { owner: '运维', items: ['O10'] }], ownerMap })
    assert.deepEqual(mentions.map((m) => [m.owner, m.openId, m.items.length]), [['Ache', 'ou_ache', 1], ['运维', null, 1]])
  })

  it('全部对接完 → 一句话 + 分支 + 署名；有待跟进 → @ 名单 + 条目 + 文件提示', () => {
    const done = buildGroupText({ task: { groupReply: '直播预告的昵称和预约状态已接好，pre 可以复测', branch: 'lark/falive-1' } })
    assert.equal(done, '✅ 直播预告的昵称和预约状态已接好，pre 可以复测（分支 lark/falive-1）\n— 由 aven 的助手整理')
    const text = buildGroupText({ task: { groupReply: 'A2 已接完' }, mentions: resolveMentions({ followUps: [{ owner: 'Ache', items: ['A9', 'A10'] }], ownerMap }), hasDoc: true })
    assert.match(text, /^<at user_id="ou_ache">Ache<\/at> A2 已接完。待确认项见上面的文件。\nAche：A9；A10\n— 由 aven 的助手整理$/)
  })

  it('postGroupSummary：只对外部群任务发；有清单先发文件再发文字；私聊 / 默认仓跳过', async () => {
    registerRepoProfiles({ repos: { falive: { root: '/tmp/falive-react', baseRef: 'main', chatIds: ['oc_falive'], groupPostAsUser: true, ownerMap } } })
    const calls = []
    const deps = {
      sendUserFile: async (args) => { calls.push(['file', args.chatId, args.file]); return { ok: true } },
      sendUserText: async (args) => { calls.push(['text', args.chatId, args.text]); return { ok: true } },
      materializeDoc: ({ branch, path }) => ({ dir: '/tmp/x', file: `/tmp/x/${path.split('/').pop()}` }),
    }
    const out = await postGroupSummary({ task: { id: 't', chatId: 'oc_falive', repo: 'falive', branch: 'lark/falive-1', groupReply: '接完了', followUpDoc: 'docs/delivery/pending/对接-live后端-2-待确认-2026-10-13.md', followUps: [{ owner: 'Encone', items: ['补 uid 映射'] }] }, deps })
    assert.equal(out.ok, true)
    assert.equal(calls[0][0], 'file')
    assert.equal(calls[0][2], '/tmp/x/对接-live后端-2-待确认-2026-10-13.md')
    assert.equal(calls[1][0], 'text')
    assert.match(calls[1][2], /<at user_id="ou_encone">Encone<\/at> 接完了。待确认项见上面的文件。/)
    const skipped = await postGroupSummary({ task: { id: 't2', chatId: 'ou_aven', repo: 'falive', groupReply: 'x' }, deps })
    assert.equal(skipped.skipped, true)
    const fameex = await postGroupSummary({ task: { id: 't3', chatId: 'oc_pr', project: 'PR-00001', groupReply: 'x' }, deps })
    assert.equal(fameex.skipped, true)
  })
})
