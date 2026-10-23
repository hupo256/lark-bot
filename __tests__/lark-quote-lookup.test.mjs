import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildQuotedBotBlock, findQuotedBotMessages, quoteCandidates } from '../lib/lark-quote-lookup.mjs'

// 复制 bot 以前的话来回复（10-23 Encone 贴了 bot 10-22 20:24 结论里的「语言」那行）：按发件簿找回原消息，不受上下文条数 / 时间限制。
describe('复制 bot 之前的话：按发件簿找回原消息', () => {
  const entries = [
    { at: '2026-10-22T16:24:11Z', chatId: 'oc_g', taskId: 'om_live', topic: 'new#08f79a', phase: 'done', text: '<at id=ou_e></at> 「我要直播」web 开播：通了 0 项，没通 5 项\n- ❌ 没接 开播设置里的「语言」下拉：创建 / 修改直播接口没有语言参数，等 Encone 给参数后再补' },
    { at: '2026-10-22T17:00:00Z', chatId: 'oc_g', taskId: 'om_gated', phase: 'done', gated: '出口闸', text: '这一条被拦下没发出去，群里没人见过它的内容' },
    { at: '2026-10-22T18:00:00Z', chatId: 'oc_g', taskId: 'om_long', phase: 'done', text: '结论一行\n完整内容：https://doc', fullText: '结论一行\n被转进文档的那段细节：取推流地址要主播号才能测' },
  ]
  const cases = [
    ['贴了带状态标记的那行 + 自己的话', '开播的 语言：\n\n❌ 没接 开播设置里的「语言」下拉：创建 / 修改直播接口没有语言参数，等 Encone 给参数后再补\n\nlive 侧前端写死中文、英文\n@Aven.Bot', ['om_live']],
    ['@名字后紧跟中文也能比（只删名字字符）', '@Aven.Bot被转进文档的那段细节：取推流地址要主播号才能测', ['om_long']],
    ['出口闸拦下、没发出去的不算', '这一条被拦下没发出去，群里没人见过它的内容', []],
    ['太短的不比（「收到」「好的」到处都有）', '@Aven.Bot 好的收到', []],
    ['无关的话找不到', '@Aven.Bot 帮我看下直播间为什么打不开，报错了', []],
  ]
  for (const [name, ownText, expected] of cases) {
    it(name, () => assert.deepEqual(findQuotedBotMessages({ ownText, entries }).map((hit) => hit.entry.taskId), expected))
  }
  it('块里带原消息全文（去掉 at 标签）、时间和任务；找不到返回空串；只取本条够长的行', () => {
    const block = buildQuotedBotBlock({ ownText: cases[0][1], chatIds: ['oc_g'], list: () => entries })
    assert.match(block, /^【复制了 bot 之前说的话】/)
    assert.match(block, /任务 om_live，主题 new#08f79a/)
    assert.doesNotMatch(block, /<at id=/)
    assert.equal(buildQuotedBotBlock({ ownText: '无关', chatIds: ['oc_g'], list: () => entries }), '')
    assert.deepEqual(quoteCandidates('- ✅ 通了 直播分类\n@Aven.Bot 好的'), [], '去掉标记后都太短')
  })
})
