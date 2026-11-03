import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { extractBugRecordLinks, normalizeBugTable, readBugRecords, recordJsonToMarkdown, screenshotTokensOf, taskReferencesBugRecords } from '../lib/lark-bug-record.mjs'
import { buildTaskPrompt } from '../lib/lark-worker-prompts.mjs'

const TOKEN = 'Q6S5rK3lHeUJ36ccYcul0Yo7gWg'
const URL = `https://qfglxo2m3dc.sg.larksuite.com/record/${TOKEN}`
const RECORD_MD = `\`_record_id\` is metadata\n\n- \`_record_id\`: rec4944\n- \`Bug编号\`: Bug-4944\n- \`问题标题\`: 直播間介紹\n- \`问题截图\`: [{"file_token":"f1","name":"a.png"},{"file_token":"f2","name":"b.png"}]\n`

// lark-cli base +record-get --format json 的真实形状（11-03 起默认 ndjson 落文件，只能显式要 json）
const RECORD_JSON = JSON.stringify({ ok: true, data: { fields: ['Bug编号', '问题标题', '状态', '修复完成时间', '问题截图'], record_id_list: ['rec4944'], data: [['Bug-4944', '直播間介紹', ['待处理'], null, [{ file_token: 'f1', name: 'a.png' }, { file_token: 'f2', name: 'b.png' }]]] } })

describe('bug 表记录分享链接（从 falive 移植 #85：群里贴 …/record/<token>，bot 原来只看得到标题）', () => {
  it('抽链接去重、截图 token、按分享链接反查记录并落盘（缓存命中不再反查）；不是这张表的 / 没配表记 skipped；配置用 fameex 的 bugTable.appToken', () => {
    assert.deepEqual(extractBugRecordLinks(`看下 ${URL}\n再看 ${URL} 和 https://x.larksuite.com/record/short`).map((link) => link.token), [TOKEN])
    assert.deepEqual(screenshotTokensOf(RECORD_MD), ['f1', 'f2'])
    // JSON → 原 markdown 形状：字符串原样、null 留空、其它 JSON 化；错 id（也回 ok）/ 不是 JSON → ''
    const md = recordJsonToMarkdown(RECORD_JSON, 'rec4944')
    assert.equal(md, '`_record_id` is metadata\n\n- `_record_id`: rec4944\n- `Bug编号`: Bug-4944\n- `问题标题`: 直播間介紹\n- `状态`: ["待处理"]\n- `修复完成时间`: \n- `问题截图`: [{"file_token":"f1","name":"a.png"},{"file_token":"f2","name":"b.png"}]\n')
    assert.deepEqual(screenshotTokensOf(md), ['f1', 'f2'])
    assert.equal(recordJsonToMarkdown(RECORD_JSON, 'recOther'), '')
    assert.equal(recordJsonToMarkdown('不是 JSON', 'rec4944'), '')
    assert.equal(recordJsonToMarkdown(JSON.stringify({ ok: true, data: { record_id_list: ['r'] } }), 'r'), '`_record_id` is metadata\n\n- `_record_id`: r\n')
    assert.deepEqual(screenshotTokensOf('- `问题截图`: '), [])
    assert.deepEqual(screenshotTokensOf(RECORD_MD, 'QA截图'), [], '列名可配，配了别的列名就不读默认列')
    assert.equal(taskReferencesBugRecords(`看 ${URL}`), true)
    assert.equal(taskReferencesBugRecords('没有链接'), false)
    assert.equal(normalizeBugTable({ tableId: 'tbl' }), null, '缺 appToken 不算配了表')
    assert.deepEqual(normalizeBugTable({ appToken: 'base', tableId: 'tbl', titleField: '标题' }), { baseToken: 'base', tableId: 'tbl', viewId: null, titleField: '标题', screenshotField: '问题截图', bugIdField: 'Bug编号' })
    // 不预取：提示里只说有链接、要细节时用工具读；没链接不提
    const workContext = { projectId: 'PR-00001', projectName: 'test', projectDocs: [], cwd: '/tmp/repo' }
    assert.match(buildTaskPrompt(workContext, { id: 't1', text: `修一下 ${URL}\nBug-4944`, attachments: [] }, 'claude'), /1 个 bug 表记录链接：标题和上下文够用就不读.*tools\/read-bug-record\.mjs <链接>/)
    assert.doesNotMatch(buildTaskPrompt(workContext, { id: 't2', text: '修一下标题', attachments: [] }, 'claude'), /bug 表记录链接/)

    const dir = mkdtempSync(join(tmpdir(), 'bug-record-'))
    try {
      const calls = []
      const run = (args, opts) => {
        calls.push(args[1])
        if (args[1] === '+record-list') {
          assert.deepEqual(args.slice(args.indexOf('--field-id'), args.indexOf('--field-id') + 2), ['--field-id', '问题标题'], '列记录按标题列投影')
          return { code: 0, stdout: JSON.stringify({ ok: true, data: { record_id_list: ['rec1', 'rec4944'], has_more: false } }) }
        }
        if (args[1] === '+record-share-link-create') return { code: 0, stdout: JSON.stringify({ ok: true, data: { record_share_links: { rec1: 'https://t.larksuite.com/record/OtherTokenOtherTokenXX', rec4944: URL } } }) }
        if (args[1] === '+record-get') {
          assert.deepEqual(args.slice(-2), ['--format', 'json'], '显式要 JSON，不让它落 ndjson 文件')
          assert.equal(opts?.cwd, join(dir, 'out'), '万一还落文件，也只落在任务目录')
          return { code: 0, stdout: RECORD_JSON }
        }
        return { code: 0, stdout: '{}' }
      }
      const table = { appToken: 'base', tableId: 'tbl', viewId: 'vew' }
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
      assert.deepEqual(noTable.skipped, [{ url: URL, reason: '没配 bug 表（config.bugTable）' }])
      assert.equal(existsSync(join(dir, 'x')), false)

      // 读记录的各种失败：非 0 退出 / 退出 0 但不是记录正文 → skipped，原因取 stderr、再 stdout、再退出码
      // 非 0 退出即使 stdout 是记录也不算；错 id 也回 ok（record_id_list 里没有它）→ skipped
      const wrongId = JSON.stringify({ ok: true, data: { fields: ['Bug编号'], record_id_list: ['recOther'], data: [[null]] } })
      const gets = [{ code: 1, stdout: '', stderr: '' }, { code: 1, stdout: 'nope', stderr: '' }, { code: 0, stdout: '不是记录', stderr: '' }, { code: 1, stdout: RECORD_JSON, stderr: 'boom' }, { code: 0, stdout: wrongId, stderr: '' }]
      const runGet = (args) => (args[1] === '+record-get' ? gets.shift() : { code: 0, stdout: '{}' })
      const reasons = [0, 1, 2, 3, 4].map(() => readBugRecords({ text: URL, outDir: join(dir, 'out'), table, run: runGet, cachePath }).skipped[0].reason)
      assert.deepEqual(reasons, ['读记录失败：1', '读记录失败：nope', '读记录失败：不是记录', '读记录失败：boom', `读记录失败：${wrongId.slice(0, 120)}`])

      // 老缓存条目没有 tableId：读记录用表配置里的 tableId
      const legacyCache = join(dir, 'legacy.json')
      writeFileSync(legacyCache, JSON.stringify({ [TOKEN]: { recordId: 'rec4944' } }))
      const seen = []
      readBugRecords({ text: URL, outDir: join(dir, 'out'), table, run: (args) => { if (args[1] === '+record-get' || args[1] === '+record-download-attachment') seen.push(args[args.indexOf('--table-id') + 1]); return args[1] === '+record-get' ? { code: 0, stdout: RECORD_JSON } : { code: 0, stdout: '{}' } }, cachePath: legacyCache })
      assert.deepEqual(seen, ['tbl', 'tbl'])

      // 反查：列记录失败（非 0）就停、不生成分享链接；表里没有记录时也不发空的分享链接请求；翻页最多 10 页
      const listCalls = []
      const listRun = (reply) => (args) => { listCalls.push(args[1]); return args[1] === '+record-list' ? reply(args) : { code: 0, stdout: '{}' } }
      const other = 'https://t.larksuite.com/record/NotInThisTableNotInThis'
      readBugRecords({ text: other, outDir: join(dir, 'out'), table, run: listRun(() => ({ code: 1, stdout: JSON.stringify({ data: { record_id_list: ['recX'], has_more: false } }) })), cachePath: join(dir, 'c1.json') })
      assert.deepEqual(listCalls, ['+record-list'], '列记录非 0 退出：不拿它的 data 去生成分享链接')
      listCalls.length = 0
      readBugRecords({ text: other, outDir: join(dir, 'out'), table, run: listRun(() => ({ code: 0, stdout: JSON.stringify({ data: { record_id_list: [], has_more: false } }) })), cachePath: join(dir, 'c2.json') })
      assert.deepEqual(listCalls, ['+record-list'], '表里没记录：不发空的分享链接请求')
      listCalls.length = 0
      readBugRecords({ text: other, outDir: join(dir, 'out'), table, run: listRun((args) => ({ code: 0, stdout: JSON.stringify({ data: { record_id_list: [`rec${args[args.indexOf('--offset') + 1]}`], has_more: true } }) })), cachePath: join(dir, 'c3.json') })
      assert.equal(listCalls.filter((c) => c === '+record-list').length, 10, 'has_more 一直为真最多翻 10 页')
      assert.equal(listCalls.filter((c) => c === '+record-share-link-create').length, 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
