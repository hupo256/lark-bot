import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { ledgerAsOf, ledgerSummary, loadLedger, markLedgerItems, parsePendingItems, recordLedgerEvent, saveLedger, setStandingInstruction, syncLedgerFromPending, takeStandingInstructions, workKeyFor } from '../lib/lark-ledger.mjs'

describe('对接台账（事实层）', () => {
  it('pending 文档 → 条目：小标题编号与表格首列编号', () => {
    const items = parsePendingItems('对接-live后端-3.md', '## 需要你们做的\n\n### 1. 预约接口认不到 live_id\n\n### 2. pre 灌点播视频\n\n| O11 | 直播拉流：白名单已加 | x |\n| 不是 | 编号 |')
    assert.deepEqual(items.map((i) => i.id), ['对接-live后端-3#1', '对接-live后端-3#2', '对接-live后端-3#O11'])
    assert.equal(items[0].title, '预约接口认不到 live_id')
  })

  it('同步只补新条目不动状态；事件推进状态；新事建 new# 条目；工单键按条目排序', () => {
    const ledger = { items: {}, events: [] }
    const profile = { docIntakeDir: '/pending', root: '/' }
    const fs = { readDir: () => ['对接-live后端-3.md', 'README.md'], readFile: () => '### 1. 预约接口\n### 2. 灌视频\n' }
    const { existsSync } = globalThis.process ? { existsSync: null } : {}
    void existsSync
    // 直接造条目（syncLedgerFromPending 依赖真实目录，这里用 parse 结果手工灌）
    for (const item of parsePendingItems('对接-live后端-3.md', fs.readFile())) ledger.items[item.id] = { ...item, status: 'open', updatedAt: 't0', lastEvent: null }
    const touched = recordLedgerEvent(ledger, { messageId: 'om_1', chatId: 'oc', sender: 'Ache', decision: 'api_reply', items: [{ id: '对接-live后端-3#2', transition: 'answer', note: '灌了 3 条' }, { id: 'new', transition: 'new', note: '非 mp4 怎么播' }], excerpt: 'x' })
    assert.equal(touched.length, 2)
    assert.equal(ledger.items['对接-live后端-3#2'].status, 'answered')
    assert.ok(touched[1].startsWith('new#'))
    assert.equal(ledger.items[touched[1]].title, '非 mp4 怎么播')
    assert.equal(ledger.events.length, 1)
    assert.equal(workKeyFor({ items: [{ id: 'b' }, { id: 'a' }, { id: 'a' }], messageId: 'm' }), 'a+b')
    assert.equal(workKeyFor({ items: [], messageId: 'om_9' }), 'msg:om_9')
    markLedgerItems(ledger, ['对接-live后端-3#2'], 'applied', '工单 w1')
    assert.equal(ledger.items['对接-live后端-3#2'].status, 'applied')
    const summary = ledgerSummary(ledger)
    assert.match(summary, /^- 对接-live后端-3#1｜预约接口｜open/m)
    assert.match(summary, /对接-live后端-3#2｜灌视频｜applied｜最近：applied by bot/)
    // 落盘 / 读回
    const dir = mkdtempSync(join(tmpdir(), 'lark-ledger-'))
    try {
      saveLedger('falive', ledger, { dir })
      assert.equal(loadLedger('falive', { dir }).items['对接-live后端-3#2'].status, 'applied')
      assert.deepEqual(loadLedger('nope', { dir }), { items: {}, events: [] })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    void syncLedgerFromPending
    void profile
  })

  it('回放用的 ledgerAsOf：后来才建的条目不出现，最近事件退回到当时那次，没事件的文档条目原样留（10-23 回放接上 10-22 的条目）', () => {
    const ev = (at, id, transition, excerpt) => ({ at, messageId: `om_${at}`, sender: 'ou_x', items: [{ id, transition }], excerpt })
    const ledger = {
      items: {
        'new#old': { id: 'new#old', title: '旧事', status: 'answered', lastEvent: { at: '2026-10-22T10:00:00Z', transition: 'answer', note: '后来的答复' } },
        'new#late': { id: 'new#late', title: '10-22 才建', status: 'answered', lastEvent: { at: '2026-10-22T16:00:00Z', transition: 'answer' } },
        'new#noev': { id: 'new#noev', title: '没事件、后来的', status: 'open', lastEvent: { at: '2026-10-22T16:00:00Z', transition: 'new' } },
        '对接-live后端-3#1': { id: '对接-live后端-3#1', title: '文档条目', status: 'open' },
      },
      events: [ev('2026-10-15T08:00:00Z', 'new#old', 'new', '当时的提问'), ev('2026-10-22T10:00:00Z', 'new#old', 'answer', '后来的答复'), ev('2026-10-22T16:00:00Z', 'new#late', 'new', '后来')],
    }
    const asOf = ledgerAsOf(ledger, '2026-10-16T09:00:00Z')
    assert.deepEqual(Object.keys(asOf.items).sort(), ['new#old', '对接-live后端-3#1'])
    assert.deepEqual([asOf.items['new#old'].lastEvent.at, asOf.items['new#old'].lastEvent.transition, asOf.items['new#old'].lastEvent.note], ['2026-10-15T08:00:00Z', 'new', '当时的提问'])
    assert.equal(asOf.events.length, 1)
    assert.equal(ledger.items['new#old'].lastEvent.at, '2026-10-22T10:00:00Z', '不改原台账')
    assert.equal(ledgerAsOf(ledger, ''), ledger)
  })
})

describe('待命指令闭环', () => {
  it('交办挂在条目上并标 waiting；材料到了取出指令，条目回 answered；通知不把 waiting 降级', () => {
    const ledger = { items: { 'a#1': { id: 'a#1', title: 'x', status: 'open', updatedAt: 't', lastEvent: null } }, events: [] }
    setStandingInstruction(ledger, ['a#1'], { taskId: 'om_1', text: '等新文档后开工登录', waitsFor: '新版 PM-3217 文档', by: 'ou_aven' })
    assert.equal(ledger.items['a#1'].status, 'waiting')
    assert.match(ledgerSummary(ledger), /等：新版 PM-3217 文档（到了就开工）/)
    recordLedgerEvent(ledger, { messageId: 'om_2', chatId: 'oc', decision: 'ignore', items: [{ id: 'a#1', transition: 'notify' }] })
    assert.equal(ledger.items['a#1'].status, 'waiting', '普通通知不解除等待')
    const taken = takeStandingInstructions(ledger, ['a#1'])
    assert.equal(taken.length, 1)
    assert.equal(taken[0].text, '等新文档后开工登录')
    assert.equal(ledger.items['a#1'].status, 'answered')
    assert.equal(ledger.items['a#1'].standing, undefined)
    assert.deepEqual(takeStandingInstructions(ledger, ['a#1']), [])
  })
})
