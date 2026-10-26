import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { hashText, listOutbox, localHHMM, pruneOutbox, recordOutbox, shouldSend } from '../lib/lark-outbox.mjs'
import { sendGroupCard } from '../lib/lark-repo-delivery.mjs'
import { runSteps } from './support/steps.mjs'

const withDir = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'lark-outbox-'))
  try { return fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

describe('发件簿（阶段 3）', () => {
  it('发件簿记账、按群列出、7 天清理；sendGroupCard 发成功才记账，未指定目录不落盘', () => runSteps([
    ['记一条、按群列出（只列本群）；转文档前的原文另存 fullText、正文不截断', () => withDir((dir) => {
      const t0 = Date.parse('2026-10-15T13:48:00Z')
      recordOutbox({ dir, now: t0, chatId: 'oc_x', taskId: 'om_1', topic: 'new#63a595', phase: 'done', to: 'ou_arthur', text: '那次请求信息如下，需要的话我重跑一次' })
      recordOutbox({ dir, now: t0 + 60_000, chatId: 'oc_x', taskId: 'om_2', phase: 'ack', to: 'ou_ache', mentions: ['ou_arthur'], text: '收到' })
      recordOutbox({ dir, now: t0 + 90_000, chatId: 'oc_other', taskId: 'om_3', phase: 'ack', to: 'ou_arthur', text: '别的群' })
      const all = listOutbox({ dir, chatId: 'oc_x' })
      assert.deepEqual(all.map((item) => item.phase), ['done', 'ack'])
      assert.equal(all[0].hash, hashText('那次请求信息如下，需要的话我重跑一次'))
      assert.equal(recordOutbox({ dir, chatId: '', phase: 'ack', text: 'x' }), null)
      const long = '很'.repeat(2500)
      recordOutbox({ dir, now: t0 + 120_000, chatId: 'oc_x', taskId: 'om_4', phase: 'done', text: '结论\n完整内容：https://doc', fullText: long })
      const last = listOutbox({ dir, chatId: 'oc_x' }).at(-1)
      assert.equal(last.fullText, long, '别人复制被转进文档的那段时要按原文找（lark-quote-lookup）')
      assert.equal(all[0].fullText, undefined, '没转文档的不另存')
    })],
    ['保留 7 天：清理只删过期行，文件其它行原样', () => withDir((dir) => {
      const now = Date.parse('2026-10-15T12:00:00Z')
      recordOutbox({ dir, now: now - 8 * 24 * 60 * 60_000, chatId: 'oc_x', phase: 'ack', text: '老' })
      recordOutbox({ dir, now: now - 60_000, chatId: 'oc_x', phase: 'ack', text: '新' })
      // 第 2 批起记账时每 6 小时自动清一次：第二条记账时已把 8 天前那条清掉，这里再清是 0
      assert.equal(pruneOutbox({ dir, now }), 0)
      assert.deepEqual(listOutbox({ dir, chatId: 'oc_x' }).map((item) => item.text), ['新'])
      assert.ok(readFileSync(join(dir, 'oc_x.jsonl'), 'utf8').endsWith('\n'))
    })],
    ['sendGroupCard：发成功才记账（LARK_OUTBOX_DIR 指到临时目录），失败不记', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'lark-outbox-send-'))
      process.env.LARK_OUTBOX_DIR = dir
      try {
        const sentCards = []
        const task = { id: 'om_t', chatId: 'oc_x', operator: 'ou_arthur', topic: 'new#1' }
        const ok = await sendGroupCard({ webhook: { url: 'u' }, task, phase: 'ack', body: '收到', logPrefix: 't', sendHook: async ({ card }) => { sentCards.push(card); return { ok: true } } })
        assert.equal(ok.ok, true)
        assert.equal(sentCards[0].elements[0].content, '收到')
        // 同文本换阶段：固定话术不按内容去重，不会被闸先拦下，走到发送失败。
        const fail = await sendGroupCard({ webhook: { url: 'u' }, task, phase: 'noted', body: '收到', logPrefix: 't', sendHook: async () => ({ ok: false, reason: 'x' }) })
        assert.equal(fail.ok, false)
        const entries = listOutbox({ chatId: 'oc_x' })
        assert.equal(entries.length, 1)
        assert.deepEqual([entries[0].taskId, entries[0].topic, entries[0].phase, entries[0].to], ['om_t', 'new#1', 'ack', 'ou_arthur'])
      } finally {
        delete process.env.LARK_OUTBOX_DIR
        rmSync(dir, { recursive: true, force: true })
      }
    }],
    ['sendGroupCard keepShort=false（日报）：超长也原样发，不转文档（10-26 日报只剩标题）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'lark-outbox-long-'))
      process.env.LARK_OUTBOX_DIR = dir
      try {
        const long = `# 日报\n\n${'进度'.repeat(400)}`
        const sentCards = []
        const docs = []
        const createDoc = async (args) => { docs.push(args); return { ok: true, url: 'https://doc/x' } }
        const sendHook = async ({ card }) => { sentCards.push(card); return { ok: true } }
        const kept = await sendGroupCard({ webhook: { url: 'u' }, chatId: 'oc_long', phase: 'daily_report', body: long, keepShort: false, logPrefix: 't', sendHook, createDoc })
        assert.equal(kept.ok, true)
        assert.equal(sentCards[0].elements[0].content, long)
        assert.equal(docs.length, 0)
        // 默认仍兜底：超长转文档、群里留第一行 + 链接。
        await sendGroupCard({ webhook: { url: 'u' }, chatId: 'oc_long', phase: 'noted', body: `${long}!`, logPrefix: 't', sendHook, createDoc })
        assert.equal(docs.length, 1)
        assert.equal(sentCards[1].elements[0].content, '# 日报\n完整内容：https://doc/x')
      } finally {
        delete process.env.LARK_OUTBOX_DIR
        rmSync(dir, { recursive: true, force: true })
      }
    }],
    ['node --test 子进程里没指定目录：不落盘、列表为空', () => {
      assert.equal(recordOutbox({ chatId: 'oc_real', phase: 'ack', text: '不该写进 runtime' }), null)
      assert.deepEqual(listOutbox({ chatId: 'oc_real' }), [])
    }],
  ]))
})

describe('出口闸（阶段 5）', () => {
  it('出口闸去重：结论按内容 24h，「收到」/ 记下了 / 日报回话按人 + 主题 + 2 分钟', () => runSteps([
    ['结论阶段只按内容去重（10-21 P5：语义去重归回复义务）：同内容 24 小时不重发；不同内容同主题照发；gated 记录不算已发', () => withDir((dir) => {
      const t0 = Date.parse('2026-10-15T13:00:00Z')
      recordOutbox({ dir, now: t0, chatId: 'oc_x', taskId: 'om_1', topic: 'new#a', phase: 'done', to: 'ou_a', text: '结果一' })
      recordOutbox({ dir, now: t0 + 1000, chatId: 'oc_x', taskId: 'om_9', topic: 'new#a', phase: 'done', to: 'ou_a', text: '被拦的', gated: '同内容' })
      assert.equal(shouldSend({ dir, nowMs: t0 + 30_000, chatId: 'oc_x', topic: 'new#a', phase: 'done', to: 'ou_a', text: '结果二' }).send, true, '同主题不同内容照发')
      assert.equal(shouldSend({ dir, nowMs: t0 + 3 * 60 * 60_000, chatId: 'oc_x', topic: 'new#c', phase: 'done', text: '结果一' }).send, false, '同内容 24h 不重发')
      assert.equal(shouldSend({ dir, nowMs: t0 + 3 * 60 * 60_000, chatId: 'oc_x', topic: 'new#c', phase: 'daily_report', text: '结果一' }).send, false, '日报也按内容去重')
      assert.equal(shouldSend({ dir, nowMs: t0 + 25 * 60 * 60_000, chatId: 'oc_x', phase: 'done', text: '结果一' }).send, true, '过了 24 小时可以再发')
      assert.equal(shouldSend({ dir, nowMs: t0 + 30_000, chatId: 'oc_x', topic: 'new#a', phase: 'done', to: 'ou_a', text: '被拦的' }).send, true, 'gated 记录不参与去重')
    })],
    ['「收到」同文本：同人同主题 2 分钟 1 次；过了 2 分钟（24 小时内）照样再回；换人 / 换主题不拦（aven 2026-10-20 review）', () => withDir((dir) => {
      const t0 = Date.parse('2026-10-15T13:00:00Z')
      recordOutbox({ dir, now: t0, chatId: 'oc_x', taskId: 'om_1', phase: 'ack', to: 'ou_arthur', text: '收到' })
      assert.equal(shouldSend({ dir, nowMs: t0 + 60_000, chatId: 'oc_x', phase: 'ack', to: 'ou_arthur', text: '收到' }).send, false)
      assert.equal(shouldSend({ dir, nowMs: t0 + 60_000, chatId: 'oc_x', phase: 'ack', to: 'ou_ache', text: '收到' }).send, true)
      assert.equal(shouldSend({ dir, nowMs: t0 + 60_000, chatId: 'oc_x', topic: 'new#zzz', phase: 'ack', to: 'ou_arthur', text: '收到' }).send, true)
      assert.equal(shouldSend({ dir, nowMs: t0 + 150_000, chatId: 'oc_x', phase: 'ack', to: 'ou_arthur', text: '收到' }).send, true)
      assert.equal(shouldSend({ dir, nowMs: t0 + 5 * 60 * 60_000, chatId: 'oc_x', phase: 'ack', to: 'ou_arthur', text: '收到' }).send, true, '同一人当天第二次 @ 也能收到「收到」')
    })],
    ['收到记下了 / 日报请求回话同文本：不按内容 24h 去重，只按人 + 主题 + 2 分钟', () => withDir((dir) => {
      const t0 = Date.parse('2026-10-15T13:00:00Z')
      const fallback = '这条我拿不准，等 aven 看过再回。'
      recordOutbox({ dir, now: t0, chatId: 'oc_x', taskId: 'om_1', topic: 'new#a', phase: 'noted', to: 'ou_a', text: fallback })
      recordOutbox({ dir, now: t0, chatId: 'oc_x', phase: 'daily_report_request', to: 'ou_a', text: '今天的日报正在生成，好了直接发到群里。' })
      assert.equal(shouldSend({ dir, nowMs: t0 + 30_000, chatId: 'oc_x', topic: 'new#a', phase: 'noted', to: 'ou_a', text: fallback }).send, false)
      assert.equal(shouldSend({ dir, nowMs: t0 + 30_000, chatId: 'oc_x', topic: 'new#b', phase: 'noted', to: 'ou_a', text: fallback }).send, true)
      assert.equal(shouldSend({ dir, nowMs: t0 + 30_000, chatId: 'oc_x', topic: 'new#a', phase: 'noted', to: 'ou_b', text: fallback }).send, true)
      assert.equal(shouldSend({ dir, nowMs: t0 + 3 * 60_000, chatId: 'oc_x', topic: 'new#a', phase: 'noted', to: 'ou_a', text: fallback }).send, true)
      assert.equal(shouldSend({ dir, nowMs: t0 + 3 * 60_000, chatId: 'oc_x', phase: 'daily_report_request', to: 'ou_a', text: '今天的日报正在生成，好了直接发到群里。' }).send, true)
      assert.equal(shouldSend({ dir, nowMs: t0 + 30_000, chatId: 'oc_x', phase: 'daily_report_request', to: 'ou_a', text: '今天的日报正在生成，好了直接发到群里。' }).send, false)
    })],
  ]))
  it('localHHMM：按本机本地时区出 HH:MM（不是 UTC 切片）；接受 ISO / 毫秒；解析不了给 --:--', () => {
    const prev = process.env.TZ
    process.env.TZ = 'Asia/Shanghai'
    try {
      assert.equal(localHHMM('2026-10-15T09:48:30Z'), '17:48')
      assert.equal(localHHMM(Date.parse('2026-10-15T16:05:00Z')), '00:05')
      assert.equal(localHHMM(''), '--:--')
      assert.equal(localHHMM(null), '--:--')
    } finally {
      if (prev == null) delete process.env.TZ
      else process.env.TZ = prev
    }
  })
  it('sendGroupCard 被闸拦下：不调发送、记 gated、返回 ok:false + gated（拦下就是没发，调用方不得当已发）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lark-outbox-gate-'))
    process.env.LARK_OUTBOX_DIR = dir
    try {
      let calls = 0
      const task = { id: 'om_t', chatId: 'oc_x', operator: 'ou_arthur', topic: 'new#1' }
      const hook = async () => { calls += 1; return { ok: true } }
      await sendGroupCard({ webhook: { url: 'u' }, task, phase: 'done', body: '结果', logPrefix: 't', sendHook: hook })
      const second = await sendGroupCard({ webhook: { url: 'u' }, task: { ...task, id: 'om_t2' }, phase: 'done', body: '结果', logPrefix: 't', sendHook: hook })
      assert.equal(calls, 1)
      assert.equal(second.ok, false)
      assert.match(second.gated, /同内容 .* 已发过（done）/)
      assert.match(second.reason, /出口闸拦下/)
      const entries = listOutbox({ chatId: 'oc_x' })
      assert.deepEqual(entries.map((item) => Boolean(item.gated)), [false, true])
    } finally {
      delete process.env.LARK_OUTBOX_DIR
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
