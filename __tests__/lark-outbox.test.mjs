import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { hashText, lastOutboxTo, listOutbox, pruneOutbox, recordOutbox, shouldSend } from '../lib/lark-outbox.mjs'
import { sendGroupCard } from '../lib/lark-repo-delivery.mjs'

const withDir = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'lark-outbox-'))
  try { return fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

describe('发件簿（阶段 3）', () => {
  it('记一条、按群列出、找 bot 最近对某人说的话（to 或 mentions 命中）', () => withDir((dir) => {
    const t0 = Date.parse('2026-10-15T13:48:00Z')
    recordOutbox({ dir, now: t0, chatId: 'oc_x', taskId: 'om_1', topic: 'new#63a595', phase: 'done', to: 'ou_arthur', text: '那次请求信息如下，需要的话我重跑一次' })
    recordOutbox({ dir, now: t0 + 60_000, chatId: 'oc_x', taskId: 'om_2', phase: 'ack', to: 'ou_ache', mentions: ['ou_arthur'], text: '收到' })
    recordOutbox({ dir, now: t0 + 90_000, chatId: 'oc_other', taskId: 'om_3', phase: 'ack', to: 'ou_arthur', text: '别的群' })
    const all = listOutbox({ dir, chatId: 'oc_x' })
    assert.deepEqual(all.map((item) => item.phase), ['done', 'ack'])
    assert.equal(all[0].hash, hashText('那次请求信息如下，需要的话我重跑一次'))
    assert.equal(lastOutboxTo({ dir, chatId: 'oc_x', to: 'ou_arthur' }).taskId, 'om_2', 'mentions 里 @ 到也算对他说')
    assert.equal(lastOutboxTo({ dir, chatId: 'oc_x', to: 'ou_arthur', sinceMs: t0 + 70_000 }), null)
    assert.equal(lastOutboxTo({ dir, chatId: 'oc_x', to: 'ou_nobody' }), null)
    assert.equal(recordOutbox({ dir, chatId: '', phase: 'ack', text: 'x' }), null)
  }))

  it('保留 7 天：清理只删过期行，文件其它行原样', () => withDir((dir) => {
    const now = Date.parse('2026-10-15T12:00:00Z')
    recordOutbox({ dir, now: now - 8 * 24 * 60 * 60_000, chatId: 'oc_x', phase: 'ack', text: '老' })
    recordOutbox({ dir, now: now - 60_000, chatId: 'oc_x', phase: 'ack', text: '新' })
    assert.equal(pruneOutbox({ dir, now }), 1)
    assert.deepEqual(listOutbox({ dir, chatId: 'oc_x' }).map((item) => item.text), ['新'])
    assert.ok(readFileSync(join(dir, 'oc_x.jsonl'), 'utf8').endsWith('\n'))
  }))

  it('sendGroupCard：发成功才记账（LARK_OUTBOX_DIR 指到临时目录），失败不记', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lark-outbox-send-'))
    process.env.LARK_OUTBOX_DIR = dir
    try {
      const sentCards = []
      const task = { id: 'om_t', chatId: 'oc_x', operator: 'ou_arthur', topic: 'new#1' }
      const ok = await sendGroupCard({ webhook: { url: 'u' }, task, phase: 'ack', body: '收到', logPrefix: 't', sendHook: async ({ card }) => { sentCards.push(card); return { ok: true } } })
      assert.equal(ok.ok, true)
      assert.equal(sentCards[0].elements[0].content, '收到')
      // 换内容、换阶段才不会被出口闸先拦下（同内容 24h / 同人「收到」2 分钟）。
      const fail = await sendGroupCard({ webhook: { url: 'u' }, task, phase: 'noted', body: '记下了', logPrefix: 't', sendHook: async () => ({ ok: false, reason: 'x' }) })
      assert.equal(fail.ok, false)
      const entries = listOutbox({ chatId: 'oc_x' })
      assert.equal(entries.length, 1)
      assert.deepEqual([entries[0].taskId, entries[0].topic, entries[0].phase, entries[0].to], ['om_t', 'new#1', 'ack', 'ou_arthur'])
    } finally {
      delete process.env.LARK_OUTBOX_DIR
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('node --test 子进程里没指定目录：不落盘、列表为空', () => {
    assert.equal(recordOutbox({ chatId: 'oc_real', phase: 'ack', text: '不该写进 runtime' }), null)
    assert.deepEqual(listOutbox({ chatId: 'oc_real' }), [])
  })
})

describe('出口闸（阶段 5）', () => {
  it('同主题同阶段 2 分钟 1 条；不同阶段 / 不同主题不拦；同内容 24 小时不重发；gated 记录不算已发', () => withDir((dir) => {
    const t0 = Date.parse('2026-10-15T13:00:00Z')
    recordOutbox({ dir, now: t0, chatId: 'oc_x', taskId: 'om_1', topic: 'new#a', phase: 'done', to: 'ou_a', text: '结果一' })
    recordOutbox({ dir, now: t0 + 1000, chatId: 'oc_x', taskId: 'om_9', topic: 'new#a', phase: 'done', to: 'ou_a', text: '被拦的', gated: '同主题' })
    assert.equal(shouldSend({ dir, nowMs: t0 + 30_000, chatId: 'oc_x', topic: 'new#a', phase: 'done', text: '结果二' }).send, false)
    assert.equal(shouldSend({ dir, nowMs: t0 + 30_000, chatId: 'oc_x', topic: 'new#a', phase: 'blocked_ask', text: '要材料' }).send, true)
    assert.equal(shouldSend({ dir, nowMs: t0 + 30_000, chatId: 'oc_x', topic: 'new#b', phase: 'done', text: '结果二' }).send, true)
    assert.equal(shouldSend({ dir, nowMs: t0 + 130_000, chatId: 'oc_x', topic: 'new#a', phase: 'done', text: '结果二' }).send, true)
    assert.equal(shouldSend({ dir, nowMs: t0 + 3 * 60 * 60_000, chatId: 'oc_x', topic: 'new#c', phase: 'done', text: '结果一' }).send, false, '同内容 24h 不重发')
    assert.equal(shouldSend({ dir, nowMs: t0 + 30_000, chatId: 'oc_x', topic: 'new#a', phase: 'done', text: '被拦的' }).send, false, '哈希命中的是「结果一」以外还要看 gated：被拦的那条不算已发，但同主题同阶段仍拦')
    assert.equal(shouldSend({ dir, nowMs: t0 + 130_000, chatId: 'oc_x', topic: 'new#a', phase: 'done', text: '被拦的' }).send, true, 'gated 记录不参与去重')
  }))
  it('「收到」按人：同人 2 分钟 1 次，换人不拦，和主题无关', () => withDir((dir) => {
    const t0 = Date.parse('2026-10-15T13:00:00Z')
    recordOutbox({ dir, now: t0, chatId: 'oc_x', taskId: 'om_1', topic: 'new#a', phase: 'ack', to: 'ou_arthur', text: '收到一' })
    assert.equal(shouldSend({ dir, nowMs: t0 + 60_000, chatId: 'oc_x', topic: 'new#zzz', phase: 'ack', to: 'ou_arthur', text: '收到二' }).send, false)
    assert.equal(shouldSend({ dir, nowMs: t0 + 60_000, chatId: 'oc_x', topic: 'new#a', phase: 'ack', to: 'ou_ache', text: '收到二' }).send, true)
    assert.equal(shouldSend({ dir, nowMs: t0 + 150_000, chatId: 'oc_x', topic: 'new#a', phase: 'ack', to: 'ou_arthur', text: '收到二' }).send, true)
  }))
  it('sendGroupCard 被闸拦下：不调发送、记 gated、返回 ok+gated', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lark-outbox-gate-'))
    process.env.LARK_OUTBOX_DIR = dir
    try {
      let calls = 0
      const task = { id: 'om_t', chatId: 'oc_x', operator: 'ou_arthur', topic: 'new#1' }
      const hook = async () => { calls += 1; return { ok: true } }
      await sendGroupCard({ webhook: { url: 'u' }, task, phase: 'done', body: '结果', logPrefix: 't', sendHook: hook })
      const second = await sendGroupCard({ webhook: { url: 'u' }, task: { ...task, id: 'om_t2' }, phase: 'done', body: '另一个结果', logPrefix: 't', sendHook: hook })
      assert.equal(calls, 1)
      assert.equal(second.ok, true)
      assert.match(second.gated, /同主题 new#1 的 done/)
      const entries = listOutbox({ chatId: 'oc_x' })
      assert.deepEqual(entries.map((item) => Boolean(item.gated)), [false, true])
    } finally {
      delete process.env.LARK_OUTBOX_DIR
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
