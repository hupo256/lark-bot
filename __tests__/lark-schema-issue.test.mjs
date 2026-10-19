import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { isSchemaIssue } from '../lib/lark-completion-rule.mjs'

describe('改接口 schema 的实测闸只认接口请求（教训 #42）', () => {
  it('静态资源（安装包 / 图片 / /upload/）404 不算 schema 问题', () => {
    assert.equal(isSchemaIssue({ endpoint: 'https://falivepre.fdsser.com/upload/apk/falive-pre.apk', kind: 'issues', outcome: 'HEAD 404 text/html' }), false)
    assert.equal(isSchemaIssue({ endpoint: 'https://cdn.x/cover.webp?x=1', kind: 'issues' }), false)
  })

  it('接口请求的 issues / 文字匹配仍算；ok / unreachable 不算', () => {
    assert.equal(isSchemaIssue({ endpoint: 'GET /api/secret/getHot', kind: 'issues' }), true)
    assert.equal(isSchemaIssue({ endpoint: '/bbsv2/thread/listCursor', outcome: 'parse 失败：author 缺字段' }), true)
    assert.equal(isSchemaIssue({ endpoint: '/api/secret/getHot', kind: 'ok' }), false)
    assert.equal(isSchemaIssue({ endpoint: '/api/x', kind: 'unreachable' }), false)
    assert.equal(isSchemaIssue(null), false)
  })
})
