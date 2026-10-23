import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { extractBugRecordLinks, readBugRecords, screenshotTokensOf } from '../lib/lark-bug-record.mjs'
import { buildTaskPrompt } from '../lib/lark-worker-prompts.mjs'

const TOKEN = 'Q6S5rK3lHeUJ36ccYcul0Yo7gWg'
const URL = `https://qfglxo2m3dc.sg.larksuite.com/record/${TOKEN}`
const RECORD_MD = `\`_record_id\` is metadata\n\n- \`_record_id\`: rec4944\n- \`Bug编号\`: Bug-4944\n- \`问题标题\`: 直播間介紹\n- \`问题截图\`: [{"file_token":"f1","name":"a.png"},{"file_token":"f2","name":"b.png"}]\n`

describe('bug 表记录分享链接（10-23 Encone 贴 …/record/<token>，bot 只看得到标题）', () => {
  it('抽链接去重、截图 token、按分享链接反查记录并落盘（缓存命中不再反查）；不是这张表的 / 没配表记 skipped（按需读：AI 用 tools/read-bug-record.mjs 调）', () => {
    assert.deepEqual(extractBugRecordLinks(`看下 ${URL}\n再看 ${URL} 和 https://x.larksuite.com/record/short`).map((link) => link.token), [TOKEN])
    assert.deepEqual(screenshotTokensOf(RECORD_MD), ['f1', 'f2'])
    assert.deepEqual(screenshotTokensOf('- `问题截图`: '), [])
    // 不预取：提示里只说有链接、要细节时用工具读；没链接不提
    const workContext = { projectId: 'PR-00001', projectName: 'test', projectDocs: [], cwd: '/tmp/repo' }
    assert.match(buildTaskPrompt(workContext, { id: 't1', text: `修一下 ${URL}\nBug-4944`, attachments: [] }, 'claude'), /1 个 bug 表记录链接：标题和上下文够用就不读.*tools\/read-bug-record\.mjs <链接>/)
    assert.doesNotMatch(buildTaskPrompt(workContext, { id: 't2', text: '修一下标题', attachments: [] }, 'claude'), /bug 表记录链接/)

    const dir = mkdtempSync(join(tmpdir(), 'bug-record-'))
    try {
      const calls = []
      const run = (args) => {
        calls.push(args[1])
        if (args[1] === '+record-list') return { code: 0, stdout: JSON.stringify({ ok: true, data: { record_id_list: ['rec1', 'rec4944'], has_more: false } }) }
        if (args[1] === '+record-share-link-create') return { code: 0, stdout: JSON.stringify({ ok: true, data: { record_share_links: { rec1: 'https://t.larksuite.com/record/OtherTokenOtherTokenXX', rec4944: URL } } }) }
        if (args[1] === '+record-get') return { code: 0, stdout: RECORD_MD }
        return { code: 0, stdout: '{}' }
      }
      const table = { baseToken: 'base', tableId: 'tbl', viewId: 'vew' }
      const cachePath = join(dir, 'cache.json')
      const text = `请协助看下这个问题 ${URL}\nBug-4944\n另一张表 https://t.larksuite.com/record/NotInThisTableNotInThis`
      const result = readBugRecords({ text, outDir: join(dir, 'out'), table, run, cachePath })
      assert.deepEqual(result.records.map((r) => r.bug), ['Bug-4944'])
      assert.match(readFileSync(result.records[0].path, 'utf8'), /直播間介紹/)
      assert.equal(result.records[0].shots.length, 1)
      assert.deepEqual(result.skipped.map((s) => s.reason), ['不是这张 bug 表的记录，或没有权限'])
      assert.deepEqual(calls, ['+record-list', '+record-share-link-create', '+record-get', '+record-download-attachment'])

      calls.length = 0
      readBugRecords({ text: URL, outDir: join(dir, 'out'), table, run, cachePath })
      assert.deepEqual(calls, ['+record-get', '+record-download-attachment'], '分享 token 不变，缓存命中直接读')

      const noTable = readBugRecords({ text: URL, outDir: join(dir, 'x'), table: null, run, cachePath })
      assert.equal(noTable.skipped.length, 1)
      assert.equal(existsSync(join(dir, 'x')), false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
