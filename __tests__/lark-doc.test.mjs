import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { eachCase, runSteps } from './support/steps.mjs'

import { validateSource } from '../lib/vendor/lark-command.mjs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractLarkDocUrls, isCompleteLarkDocUrl, larkDocSlug, prefetchLarkDocs, sourceTypeFromLarkUrl, splitTaskTextByOrigin, taskReferencesLarkDocs } from '../lib/lark-doc.mjs'

describe('extractLarkDocUrls（任务正文里的 Lark 文档链接，去重）', () => {
  it('抓链接去重、混排块、markdown 转义、排除非文档域、空输入', () => {
    const url = 'https://qfglxo2m3dc.sg.larksuite.com/docx/WxXMdAqv7oLrWkxqB3SlZzJugrh'
    const cases = [
      {
        name: '抓 wiki / docx / docs / doc 链接并去重（含带子域的 larksuite 与 feishu）',
        text: `参考 https://qfglxo2m3dc.sg.larksuite.com/wiki/MneowqH4CiiHlDk80hmlSpXgguc
还有 https://foo.feishu.cn/docx/AbCd123 和 https://x.larksuite.com/docs/Ee1
重复 https://qfglxo2m3dc.sg.larksuite.com/wiki/MneowqH4CiiHlDk80hmlSpXgguc`,
        want: [
          'https://qfglxo2m3dc.sg.larksuite.com/wiki/MneowqH4CiiHlDk80hmlSpXgguc',
          'https://foo.feishu.cn/docx/AbCd123',
          'https://x.larksuite.com/docs/Ee1',
        ],
      },
      {
        name: '从 merged task.text 的【被引用消息】混排块里扫出 wiki 链接',
        text: '【被引用消息】\n审计一下埋点 https://qfglxo2m3dc.sg.larksuite.com/wiki/Mne80hmlSpXgguc\n\n【本条 @】请处理',
        want: ['https://qfglxo2m3dc.sg.larksuite.com/wiki/Mne80hmlSpXgguc'],
      },
      { name: 'markdown 链接 [URL](URL) / 转义 \\] 不被吞成一个地址（10-14 卡片原文回归）：[URL](URL)', text: `待确认的几点在这里：[${url}](${url})`, want: [url] },
      { name: 'markdown 链接 [URL](URL) / 转义 \\] 不被吞成一个地址（10-14 卡片原文回归）：转义 \\]', text: `[${url}\\](${url})`, want: [url] },
      { name: 'markdown 链接 [URL](URL) / 转义 \\] 不被吞成一个地址（10-14 卡片原文回归）：尖括号包裹保留 query', text: `<${url}?from=im>`, want: [`${url}?from=im`] },
      { name: 'markdown 链接 [URL](URL) / 转义 \\] 不被吞成一个地址（10-14 卡片原文回归）：%5D( 编码', text: `${url}%5D(${url})`, want: [url] },
      { name: '不抓 /sheets/ 与非 Lark 域：/sheets/', text: 'https://x.larksuite.com/sheets/Abc123', want: [] },
      { name: '不抓 /sheets/ 与非 Lark 域：非 Lark 域', text: 'https://example.com/wiki/Abc123', want: [] },
      { name: '不抓 /sheets/ 与非 Lark 域：figma', text: 'https://www.figma.com/design/K/x', want: [] },
      { name: '无链接 / 空 / null → 空数组：无链接', text: '修一下登录按钮', want: [] },
      { name: '无链接 / 空 / null → 空数组：空串', text: '', want: [] },
      { name: '无链接 / 空 / null → 空数组：null', text: null, want: [] },
    ]
    return eachCase(cases, ({ name, text, want }) => assert.deepEqual(extractLarkDocUrls(text), want, name))
  })
})

describe('taskReferencesLarkDocs / sourceTypeFromLarkUrl / larkDocSlug', () => {
  it('有无文档链接判断、来源类型、安全 .md 文件名', () => runSteps([
    ['有 Lark 文档链接 → true，否则 false', () => {
      assert.equal(taskReferencesLarkDocs('https://x.larksuite.com/wiki/Abc'), true)
      assert.equal(taskReferencesLarkDocs('普通文本'), false)
      assert.equal(taskReferencesLarkDocs(null), false)
    }],
    ['/wiki/ → wiki，其余（docx/docs/doc）→ doc', () => {
      assert.equal(sourceTypeFromLarkUrl('https://x.larksuite.com/wiki/Abc'), 'wiki')
      assert.equal(sourceTypeFromLarkUrl('https://x.larksuite.com/docx/Abc'), 'doc')
      assert.equal(sourceTypeFromLarkUrl('https://x.larksuite.com/docs/Abc'), 'doc')
      assert.equal(sourceTypeFromLarkUrl('https://x.larksuite.com/doc/Abc'), 'doc')
      assert.equal(sourceTypeFromLarkUrl(null), 'doc')
    }],
    ['从末段 token 生成安全 .md 文件名，剥掉 query/fragment', () => {
      assert.equal(larkDocSlug('https://x.larksuite.com/wiki/MneowqH4?from=share'), 'lark-doc-MneowqH4.md')
      assert.equal(larkDocSlug('https://x.larksuite.com/docx/Ab_C-d'), 'lark-doc-Ab_C-d.md')
    }],
    ['非法字符被安全替换（防路径穿越）', () => {
      assert.equal(larkDocSlug('https://x.larksuite.com/wiki/..%2f..%2fetc'), 'lark-doc-.._2f.._2fetc.md', '非法字符被安全替换（防路径穿越）')
      assert.equal(larkDocSlug(''), 'lark-doc-doc.md')
    }],
  ]))
})

describe('validateSource 走的是只读安全闸（证明预取命令不含写词）', () => {
  it('wiki / doc 链接构造出只读 docs +fetch 命令；markdown 源一律拒绝', () => runSteps([
    ['wiki / doc 链接构造出只读 docs +fetch 命令', () => {
      for (const url of ['https://x.larksuite.com/wiki/Abc', 'https://x.larksuite.com/docx/Abc']) {
        const command = validateSource({ type: sourceTypeFromLarkUrl(url), url })
        assert.ok(Array.isArray(command))
        assert.ok(command.includes('+fetch'))
        assert.ok(command.includes('--as') && command.includes('user'))
        assert.ok(!command.some((t) => /(create|update|delete|write|upload|send|reply)/i.test(t)))
      }
    }],
    // vendor validateSource 不再接受 markdown 源
    ['本地 / 远程 markdown 都按不支持的类型拒绝（本地源只服务于已归档的 docs_tdd 存量项目）', () => {
      assert.throws(() => validateSource({ type: 'markdown', url: 'PR-00001/prd.md' }), /unsupported Lark source type/)
      assert.throws(() => validateSource({ type: 'markdown', url: 'https://x.larksuite.com/docx/Abc' }), /unsupported Lark source type/)
    }],
  ]))
})

describe('上下文里的半截链接不拦任务（10-22 Bug-4944）', () => {
  const HALF = 'https://qfglxo2m3dc.sg.larksuite.com/docx/CfbhdAyS'
  const text = `api：群里发来对接文档 bug-4944直播间介绍intro-接口变更说明.md。\n\n【群里这条之前的消息】\nAven.Bot（bot，我们自己）：待确认的几点在这里：[${HALF}\n\n【Encone 正在进行的事（2 小时内，新的在前）】\n- bot 对他说：见 ${HALF}`
  it('按来源拆主消息 / 上下文、识别半截链接、上下文半截不拦而主消息半截照旧拦', () => runSteps([
    ['按来源分：本条 / 被引用是主消息，之前的消息 / 话题回复 / 正在进行的事是上下文', () => {
      const { primary, context } = splitTaskTextByOrigin(`【被引用消息】\nPRD 在 https://x.larksuite.com/docx/AAAAAAAAAAAAAAAAAAAAAAAAAAA\n\n【本条 @】按这个做\n\n【话题其它回复】\nMateo：参考 https://x.larksuite.com/docx/BBBBBBBBBBBBBBBBBBBBBBBBBBB`)
      assert.match(primary, /AAAA/)
      assert.match(primary, /按这个做/)
      assert.doesNotMatch(primary, /BBBB/)
      assert.match(context, /BBBB/)
    }],
    ['token 不到 20 位的是被截断的半截链接', () => {
      assert.equal(isCompleteLarkDocUrl(HALF), false, 'token 不到 20 位的是被截断的半截链接')
      assert.equal(isCompleteLarkDocUrl('https://qfglxo2m3dc.sg.larksuite.com/docx/G5hHdiYreouN9XxHV0BlgIb4gFb'), true)
    }],
    ['上下文里的半截链接：不去抓、不拦，记进 skipped；主消息里的半截链接照旧拦', () => {
      const dir = mkdtempSync(join(tmpdir(), 'lark-doc-'))
      try {
        const out = prefetchLarkDocs({ text, outDir: dir })
        assert.equal(out.ok, true, '上下文里的半截链接不拦')
        assert.equal(out.error, null)
        assert.deepEqual(out.skipped.map((d) => d.url), [HALF])
        const table = prefetchLarkDocs({ text: '复测 Bug-4927：https://qfglxo2m3dc.sg.larksuite.com/wiki/VtEmw9rlMipoRQkV7tllMXb7ggw?table=tblbJYjrxZsPe40V&view=vewvqqPhkD', outDir: dir })
        assert.equal(table.ok, true, '多维表格链接（bug 表）不按文档读、不拦')
        assert.equal(table.skipped[0].reason, '多维表格，不是文档')
        const primary = prefetchLarkDocs({ text: `按这个 PRD 做：${HALF}`, outDir: dir })
        assert.equal(primary.ok, false, '主消息里的半截链接照旧拦')
        assert.match(primary.error, /链接不完整/)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }],
  ]))
})
