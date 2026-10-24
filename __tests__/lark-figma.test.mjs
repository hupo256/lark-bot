import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { extractFigmaUrls, parseSpecWrittenDir, taskReferencesFigma } from '../lib/lark-figma.mjs'

describe('extractFigmaUrls（任务正文里的 figma 链接，去重）', () => {
  it('抓设计稿链接并去重，markdown 链接不吞并，空输入与非设计稿路径不抓', () => {
    // 抓 design/file/proto/board 链接并去重
    const text = `看这个 https://www.figma.com/design/KEY/x?node-id=1-2 还有 https://figma.com/file/abc
重复 https://www.figma.com/design/KEY/x?node-id=1-2`
    assert.deepEqual(extractFigmaUrls(text), [
      'https://www.figma.com/design/KEY/x?node-id=1-2',
      'https://figma.com/file/abc',
    ])

    const t2 = 'markdown 链接 [URL](URL) 不被吞成一个地址'
    const url = 'https://www.figma.com/design/KEY/x?node-id=1-2'
    assert.deepEqual(extractFigmaUrls(`设计稿：[${url}](${url})`), [url], t2)

    const t3 = '无链接 / 空 / null → 空数组'
    assert.deepEqual(extractFigmaUrls('修一下登录按钮'), [], t3)
    assert.deepEqual(extractFigmaUrls(''), [], t3)
    assert.deepEqual(extractFigmaUrls(null), [], t3)

    const t4 = '不抓非设计稿的 figma 域名路径（如 /community）'
    assert.deepEqual(extractFigmaUrls('https://www.figma.com/community/file/123'), [], t4)
  })
})

describe('taskReferencesFigma', () => {
  it('有 figma 设计稿链接 → true，否则 false', () => {
    assert.equal(taskReferencesFigma('https://www.figma.com/design/K/x?node-id=1-2'), true)
    assert.equal(taskReferencesFigma('普通文本'), false)
    assert.equal(taskReferencesFigma(null), false)
  })
})

describe('parseSpecWrittenDir（从 stdout 取 FIGMA_SPEC_WRITTEN 哨兵目录）', () => {
  it('哨兵行取目录，无哨兵 / 空 / null 返回 null', () => {
    const t1 = '命中哨兵行取目录（多行 stdout 里）'
    const stdout = 'nodes read: 1\nimages: 1 png(s)\nFIGMA_SPEC_WRITTEN: /tmp/x/KEY-1-2\n'
    assert.equal(parseSpecWrittenDir(stdout), '/tmp/x/KEY-1-2', t1)

    const t2 = '无哨兵 / 空 / null → null'
    assert.equal(parseSpecWrittenDir('nodes read: 0\n'), null, t2)
    assert.equal(parseSpecWrittenDir(''), null, t2)
    assert.equal(parseSpecWrittenDir(null), null, t2)
  })
})
