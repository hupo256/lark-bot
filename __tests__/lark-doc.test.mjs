import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { validateSource } from '../../engine/agent-scripts/lib/lark-command.mjs'
import { extractLarkDocUrls, larkDocSlug, sourceTypeFromLarkUrl, taskReferencesLarkDocs } from '../lib/lark-doc.mjs'

describe('extractLarkDocUrls（任务正文里的 Lark 文档链接，去重）', () => {
  it('抓 wiki / docx / docs / doc 链接并去重（含带子域的 larksuite 与 feishu）', () => {
    const text = `参考 https://qfglxo2m3dc.sg.larksuite.com/wiki/MneowqH4CiiHlDk80hmlSpXgguc
还有 https://foo.feishu.cn/docx/AbCd123 和 https://x.larksuite.com/docs/Ee1
重复 https://qfglxo2m3dc.sg.larksuite.com/wiki/MneowqH4CiiHlDk80hmlSpXgguc`
    assert.deepEqual(extractLarkDocUrls(text), [
      'https://qfglxo2m3dc.sg.larksuite.com/wiki/MneowqH4CiiHlDk80hmlSpXgguc',
      'https://foo.feishu.cn/docx/AbCd123',
      'https://x.larksuite.com/docs/Ee1',
    ])
  })
  it('从 merged task.text 的【被引用消息】混排块里扫出 wiki 链接', () => {
    const text = '【被引用消息】\n审计一下埋点 https://qfglxo2m3dc.sg.larksuite.com/wiki/Mne80hmlSpXgguc\n\n【本条 @】请处理'
    assert.deepEqual(extractLarkDocUrls(text), ['https://qfglxo2m3dc.sg.larksuite.com/wiki/Mne80hmlSpXgguc'])
  })
  it('不抓 /sheets/ 与非 Lark 域', () => {
    assert.deepEqual(extractLarkDocUrls('https://x.larksuite.com/sheets/Abc123'), [])
    assert.deepEqual(extractLarkDocUrls('https://example.com/wiki/Abc123'), [])
    assert.deepEqual(extractLarkDocUrls('https://www.figma.com/design/K/x'), [])
  })
  it('无链接 / 空 / null → 空数组', () => {
    assert.deepEqual(extractLarkDocUrls('修一下登录按钮'), [])
    assert.deepEqual(extractLarkDocUrls(''), [])
    assert.deepEqual(extractLarkDocUrls(null), [])
  })
})

describe('taskReferencesLarkDocs', () => {
  it('有 Lark 文档链接 → true，否则 false', () => {
    assert.equal(taskReferencesLarkDocs('https://x.larksuite.com/wiki/Abc'), true)
    assert.equal(taskReferencesLarkDocs('普通文本'), false)
    assert.equal(taskReferencesLarkDocs(null), false)
  })
})

describe('sourceTypeFromLarkUrl', () => {
  it('/wiki/ → wiki，其余（docx/docs/doc）→ doc', () => {
    assert.equal(sourceTypeFromLarkUrl('https://x.larksuite.com/wiki/Abc'), 'wiki')
    assert.equal(sourceTypeFromLarkUrl('https://x.larksuite.com/docx/Abc'), 'doc')
    assert.equal(sourceTypeFromLarkUrl('https://x.larksuite.com/docs/Abc'), 'doc')
    assert.equal(sourceTypeFromLarkUrl('https://x.larksuite.com/doc/Abc'), 'doc')
    assert.equal(sourceTypeFromLarkUrl(null), 'doc')
  })
})

describe('larkDocSlug', () => {
  it('从末段 token 生成安全 .md 文件名，剥掉 query/fragment', () => {
    assert.equal(larkDocSlug('https://x.larksuite.com/wiki/MneowqH4?from=share'), 'lark-doc-MneowqH4.md')
    assert.equal(larkDocSlug('https://x.larksuite.com/docx/Ab_C-d'), 'lark-doc-Ab_C-d.md')
  })
  it('非法字符被安全替换（防路径穿越）', () => {
    assert.equal(larkDocSlug('https://x.larksuite.com/wiki/..%2f..%2fetc'), 'lark-doc-.._2f.._2fetc.md')
    assert.equal(larkDocSlug(''), 'lark-doc-doc.md')
  })
})

describe('validateSource 走的是只读安全闸（证明预取命令不含写词）', () => {
  it('wiki / doc 链接构造出只读 docs +fetch 命令', () => {
    for (const url of ['https://x.larksuite.com/wiki/Abc', 'https://x.larksuite.com/docx/Abc']) {
      const command = validateSource({ type: sourceTypeFromLarkUrl(url), url })
      assert.ok(Array.isArray(command))
      assert.ok(command.includes('+fetch'))
      assert.ok(command.includes('--as') && command.includes('user'))
      assert.ok(!command.some((t) => /(create|update|delete|write|upload|send|reply)/i.test(t)))
    }
  })
})
