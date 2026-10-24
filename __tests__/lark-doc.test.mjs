import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { validateSource } from '../lib/vendor/lark-command.mjs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractLarkDocUrls, isBitableUrl, isCompleteLarkDocUrl, larkDocSlug, prefetchLarkDocs, sourceTypeFromLarkUrl, taskReferencesLarkDocs } from '../lib/lark-doc.mjs'
import { extractFigmaUrls } from '../lib/lark-figma.mjs'

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

describe('vendor validateSource 不再接受 markdown 源', () => {
  it('本地 / 远程 markdown 都按不支持的类型拒绝（本地源只服务于已归档的 docs_tdd 存量项目）', () => {
    assert.throws(() => validateSource({ type: 'markdown', url: 'PR-00001/prd.md' }), /unsupported Lark source type/)
    assert.throws(() => validateSource({ type: 'markdown', url: 'https://x.larksuite.com/docx/Abc' }), /unsupported Lark source type/)
  })
})

describe('链接边界与不该抓的链接（falive #21 / Bug-4927）', () => {
  const url = 'https://qfglxo2m3dc.sg.larksuite.com/docx/WxXMdAqv7oLrWkxqB3SlZzJugrh'
  it('markdown 链接 [URL](URL) / 转义 \\] / 编码的 %5D 不被吞进地址；Figma 同口径', () => {
    assert.deepEqual(extractLarkDocUrls(`待确认的几点在这里：[${url}](${url})`), [url])
    assert.deepEqual(extractLarkDocUrls(`[${url}\\](${url})`), [url])
    assert.deepEqual(extractLarkDocUrls(`<${url}?from=im>`), [`${url}?from=im`])
    assert.deepEqual(extractLarkDocUrls(`${url}%5D(${url})`), [url])
    const figma = 'https://www.figma.com/design/AbC123/x?node-id=1-2'
    assert.deepEqual(extractFigmaUrls(`[${figma}](${figma})`), [figma])
  })
  it('token 不到 20 位的是被截断的半截链接；wiki 里的多维表格（bug 表）不是文档', () => {
    assert.equal(isCompleteLarkDocUrl('https://x.larksuite.com/docx/WxXMdAqv7o'), false)
    assert.equal(isCompleteLarkDocUrl(url), true)
    assert.equal(isBitableUrl('https://qfglxo2m3dc.sg.larksuite.com/wiki/VtEmw9rlMipoRQkV7tllMXb7ggw?table=tblbJYjrxZsPe40V&view=vewvqqPhkD'), true)
    assert.equal(isBitableUrl(url), false)
  })
  it('预取：多维表格链接记 skipped 不拦、不起子进程；半截链接按读不到处理（拦）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lark-doc-'))
    try {
      const table = prefetchLarkDocs({ text: '复测 Bug-4927：https://qfglxo2m3dc.sg.larksuite.com/wiki/VtEmw9rlMipoRQkV7tllMXb7ggw?table=tblbJYjrxZsPe40V&view=vewvqqPhkD', outDir: dir })
      assert.equal(table.ok, true)
      assert.equal(table.error, null)
      assert.equal(table.skipped[0].reason, '多维表格，不是文档')
      const half = prefetchLarkDocs({ text: '按这个 PRD 做：https://x.larksuite.com/docx/WxXMdAqv7o', outDir: dir })
      assert.equal(half.ok, false)
      assert.match(half.error, /链接不完整/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
