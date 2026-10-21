import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { fetchBugRecords, renderBugLines, summarizeBugs } from '../lib/lark-daily-bugs.mjs'

const person = (name) => ({ id: `ou_${name}`, name })
const record = (status, owners, created = '2026-10-21T10:00:00.000+04:00') => ({ fields: { 状态: [status], 负责RD: owners.map(person), 创建时间: created } })

describe('测试 Bug 段（aven 2026-10-21）', () => {
  it('按状态计数（没解决的在前、不认识的状态排后面）、今天新增按创建日期、待处理 / 修复中按负责人（多人各算一次、名字去掉前导点）', () => {
    const summary = summarizeBugs({
      date: '2026-10-21',
      records: [
        record('Pre测试通过', ['Henry']),
        record('待处理', ['Henry']),
        record('待处理', ['HQUCEncone', '.Ache.l'], '2026-10-20T09:00:00.000+04:00'),
        record('修复中', ['Henry']),
        record('待推版', ['Aven.tong']),
        record('新状态', []),
        record('待处理', []),
      ],
    })
    assert.equal(summary.total, 7)
    assert.equal(summary.today, 6)
    assert.deepEqual(renderBugLines(summary), [
      '- 共 7 个，今天新增 6：待处理 3、修复中 1、待推版 1、Pre测试通过 1、新状态 1',
      '- 待处理 / 修复中按负责人：Henry 2、HQUCEncone 1、Ache.l 1、未分配 1',
    ])
    assert.deepEqual(renderBugLines(summarizeBugs({ records: [], date: '2026-10-21' })), ['- 暂无'])
    assert.deepEqual(renderBugLines(summarizeBugs({ records: [record('已推版', ['Henry'])], date: '2026-10-21' }))[1], '- 待处理 / 修复中：--')
  })
  it('读表用用户身份、带视图；失败 / 非 JSON / 没配都返回 ok:false 和原因', async () => {
    const calls = []
    const data = { fields: ['状态'], data: [[['待处理']]], record_id_list: ['rec1'], has_more: false }
    const ok = await fetchBugRecords({ table: { baseToken: 'b', tableId: 't', viewId: 'v' }, runCli: async (args, opts) => { calls.push({ args, opts }); return { code: 0, stdout: JSON.stringify({ ok: true, data }) } } })
    assert.equal(ok.ok, true)
    assert.deepEqual(ok.records, [{ record_id: 'rec1', fields: { 状态: ['待处理'] } }])
    assert.equal(calls[0].opts.identity, 'user')
    assert.deepEqual(calls[0].args.slice(0, 2), ['base', '+record-list'])
    assert.ok(calls[0].args.includes('--view-id'))
    assert.equal((await fetchBugRecords({ table: null })).ok, false)
    assert.match((await fetchBugRecords({ table: { baseToken: 'b', tableId: 't' }, runCli: async () => ({ code: 1, stdout: '', stderr: 'missing_scope' }) })).reason, /missing_scope/)
    assert.match((await fetchBugRecords({ table: { baseToken: 'b', tableId: 't' }, runCli: async () => ({ code: 1, stdout: '', stderr: JSON.stringify({ ok: false, error: { message: 'invalid --limit' } }) }) })).reason, /invalid --limit$/)
    // 翻页：has_more 时按 offset 继续读，合并两页
    const pages = []
    const paged = await fetchBugRecords({ table: { baseToken: 'b', tableId: 't' }, runCli: async (args) => {
      const offset = Number(args[args.indexOf('--offset') + 1])
      pages.push(offset)
      return { code: 0, stdout: JSON.stringify({ ok: true, data: { fields: ['状态'], data: [[['待处理']]], record_id_list: [`r${offset}`], has_more: offset === 0 } }) }
    } })
    assert.deepEqual(pages, [0, 200])
    assert.deepEqual(paged.records.map((item) => item.record_id), ['r0', 'r200'])
    assert.equal(calls[0].args[calls[0].args.indexOf('--limit') + 1], '200')
  })
})
