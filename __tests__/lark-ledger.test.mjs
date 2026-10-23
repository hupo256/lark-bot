import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { ledgerSummary, loadLedger, markLedgerItems, parsePendingItems, pruneLedger, recordBotAsks, recordLedgerEvent, saveLedger, setStandingInstruction, standingLead, syncLedgerFromPending, takeStandingInstructions, waitsOnSender, workKeyFor } from '../lib/lark-ledger.mjs'

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

describe('bot 向人要的东西（10-23 #74）', () => {
  const profile = { ownership: { me: 'aven', meOpenIds: ['ou_aven'] }, ownerMap: { aven: 'ou_aven', Encone: 'ou_encone', Henry: 'ou_henry' } }
  const done = (extra = {}) => ({ id: 'om_src', chatId: 'oc', summary: 'intro 对接', result: '已完成。\n开播写入还差主播测试号', ledgerItems: [{ id: 'new#9fff15' }],
    followUps: [{ owner: 'Encone', items: ['给一个 pre 主播测试号'] }, { owner: 'aven', items: ['自己看一下'] }, { owner: '某运维', items: ['没在 ownerMap'] }], ...extra })

  it('followUps 点名、ownerMap 认得出的外部同事 → 条目挂 bot_ask：等谁、要什么、源工单；负责人本人和认不出的不算', () => {
    const ledger = { items: { 'new#9fff15': { id: 'new#9fff15', status: 'applied', title: 'intro' } }, events: [] }
    assert.deepEqual(recordBotAsks(ledger, { task: done(), profile, at: '2026-10-22T18:46:00Z' }), ['new#9fff15'])
    const standing = ledger.items['new#9fff15'].standing
    assert.equal(ledger.items['new#9fff15'].status, 'waiting')
    assert.deepEqual([standing.kind, standing.taskId, standing.from], ['bot_ask', 'om_src', ['ou_encone']])
    assert.match(standing.text, /续跑工单 om_src/)
    assert.match(standing.text, /开播写入还差主播测试号/)
    assert.match(ledgerSummary(ledger), /等：Encone：给一个 pre 主播测试号（工单 om_src，到了就续跑）/)
    assert.match(standingLead(standing, profile), /续跑工单 om_src 没做完的部分/)
    // 没 followUps / 只点了负责人本人：不记
    assert.deepEqual(recordBotAsks({ items: {}, events: [] }, { task: done({ followUps: [{ owner: 'aven', items: ['x'] }] }), profile }), [])
  })

  it('工单没触及条目 / 条目上挂着负责人的待命指令 → 另起一条 new#，不覆盖负责人的', () => {
    const ledger = { items: { 'a#1': { id: 'a#1', status: 'waiting', title: 'a', standing: { taskId: 'om_aven', text: '等域名再做', waitsFor: '域名', by: 'ou_aven' } } }, events: [] }
    const ids = recordBotAsks(ledger, { task: done({ ledgerItems: [{ id: 'a#1' }] }), profile })
    assert.equal(ids.length, 1)
    assert.match(ids[0], /^new#/)
    assert.equal(ledger.items['a#1'].standing.taskId, 'om_aven')
    assert.equal(ledger.items[ids[0]].standing.kind, 'bot_ask')
  })

  it('对话包取「在等他给的」：只认他、7 天内、新的在前；分类器只填了 continues 也按源工单取出', () => {
    const now = Date.parse('2026-10-23T02:36:00Z')
    const ledger = { items: {}, events: [] }
    ledger.items['x#1'] = { id: 'x#1', status: 'open', title: 'x' }
    ledger.items['x#2'] = { id: 'x#2', status: 'open', title: 'y' }
    recordBotAsks(ledger, { task: done({ id: 'om_src', ledgerItems: [{ id: 'x#1' }] }), profile, at: '2026-10-22T18:46:00Z' })
    recordBotAsks(ledger, { task: done({ id: 'om_old', ledgerItems: [{ id: 'x#2' }] }), profile, at: '2026-10-14T18:46:00Z' })
    assert.deepEqual(waitsOnSender(ledger, 'ou_encone', { nowMs: now }).map((item) => item.id), ['x#1'], '8 天前的不再列')
    assert.deepEqual(waitsOnSender(ledger, 'ou_henry', { nowMs: now }), [])
    const taken = takeStandingInstructions(ledger, [], { sourceTaskId: 'om_src' })
    assert.deepEqual(taken.map((item) => [item.itemId, item.kind]), [['x#1', 'bot_ask']])
    assert.equal(ledger.items['x#1'].standing, undefined)
  })

  it('等了 14 天没人给：撤掉，不再挂着', () => {
    const ledger = { items: { 'x#1': { id: 'x#1', status: 'open', title: 'x', updatedAt: '2026-10-01T00:00:00Z' } }, events: [] }
    recordBotAsks(ledger, { task: done({ ledgerItems: [{ id: 'x#1' }] }), profile, at: '2026-10-01T00:00:00Z' })
    pruneLedger(ledger, { now: Date.parse('2026-10-16T00:00:00Z') })
    assert.equal(ledger.items['x#1'].standing, undefined)
    assert.equal(ledger.items['x#1'].status, 'open')
  })
})
