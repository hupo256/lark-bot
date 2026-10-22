import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { GROUP_TEXT_MAX, keepGroupTextShort, publishMarkdownDoc } from '../lib/lark-detail-doc.mjs'

// 群消息只放结论，细节放 Lark 文档；超长不截断，整段转文档（aven 2026-10-22）。
describe('细节进文档、群消息不截断', () => {
  it('不超长原样发；超长整段转文档，群里留第一行（含 @）+ 链接；建文档失败原样发、一个字不丢', async () => {
    const short = await keepGroupTextShort({ text: '短', title: 't', publish: async () => { throw new Error('不该建') } })
    assert.deepEqual(short, { text: '短', docUrl: null })
    const long = `<at id=ou_a></at> 我要直播：通了 3 项，没通 2 项\n${'- 一项\n'.repeat(GROUP_TEXT_MAX)}`
    const published = []
    const moved = await keepGroupTextShort({ text: long, title: 't', publish: async (args) => { published.push(args); return 'https://doc/1' } })
    assert.equal(moved.text, '<at id=ou_a></at> 我要直播：通了 3 项，没通 2 项\n完整内容：https://doc/1')
    assert.equal(published[0].markdown, long, '文档里是全文')
    const failed = await keepGroupTextShort({ text: long, title: 't', publish: async () => null })
    assert.equal(failed.text, long)
  })
  it('建文档：markdown 落临时文件交给 create，at 标签去掉；create 失败返回 null', async () => {
    const calls = []
    const url = await publishMarkdownDoc({ title: '细节', markdown: '<at id=ou_x></at> curl -s x', create: async (args) => { calls.push(args); return { ok: true, url: 'https://doc/2' } } })
    assert.equal(url, 'https://doc/2')
    assert.equal(calls[0].file, 'detail.md')
    assert.equal(await publishMarkdownDoc({ title: 't', markdown: 'x', create: async () => ({ ok: false, reason: 'no' }) }), null)
  })
})
