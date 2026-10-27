import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { hashText, listOutbox, localHHMM, pruneOutbox, recordOutbox, shouldSend } from '../lib/lark-outbox.mjs'
import { GROUP_TEXT_MAX } from '../lib/lark-detail-doc.mjs'
import { GROUP_PHASES, groupPhasePolicy, validatePhaseTable } from '../lib/lark-group-phases.mjs'
import { larkBotRoot } from '../lib/lark-paths.mjs'
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
    ['出口内容契约（10-27）：每种群消息用真实大小的正文走真实出口，群里收到什么按出口规则表定——as_is 原样到达，to_doc 留第一行 + 文档链接；表外 phase 拒发', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'lark-outbox-contract-'))
      process.env.LARK_OUTBOX_DIR = dir
      try {
        // 10-26 日报缩水的那份正文量级：标题、数字行、两节列表、完整版链接，540 字以上。
        const long = ['# Falive Web 日报 2026-10-26', '', '总体进度 **92.6%**，已接通 **50 / 54**，今日 -2。', '', '## 今天', ...Array.from({ length: 6 }, (_, i) => `- **成员${i}**：${'顶栏搜索改成边输入边搜，并加上搜索历史；首页任务中心接上真实接口；'.repeat(2)}`), '', '## 测试 Bug', '- 共 102 个，今天新增 14', '', '完整版（云文档）：https://doc/full'].join('\n')
        assert.ok(long.length > GROUP_TEXT_MAX, `样例 ${long.length} 字要超过出口上限 ${GROUP_TEXT_MAX}`)
        for (const [phase, policy] of Object.entries(GROUP_PHASES)) {
          const cards = []
          const docs = []
          const sent = await sendGroupCard({ webhook: { url: 'u' }, chatId: `oc_${phase}`, phase, body: long, logPrefix: 't', sendHook: async ({ card }) => { cards.push(card); return { ok: true } }, createDoc: async (args) => { docs.push(args); return { ok: true, url: 'https://doc/x' } } })
          assert.equal(sent.ok, true, phase)
          const content = cards[0].elements[0].content
          if (policy.overflow === 'as_is') {
            assert.equal(content, long, `${phase} 是 as_is：群里必须收到完整原文`)
            assert.equal(docs.length, 0, `${phase} 是 as_is：不许转文档`)
          } else {
            assert.equal(content, '# Falive Web 日报 2026-10-26\n完整内容：https://doc/x', `${phase} 是 to_doc：留第一行 + 链接`)
          }
        }
        // 日报必须原样到达（10-26 教训钉死）。
        assert.equal(GROUP_PHASES.daily_report.overflow, 'as_is')
        // 短正文任何 phase 都原样发。
        const shortCards = []
        await sendGroupCard({ webhook: { url: 'u' }, chatId: 'oc_short', phase: 'noted', body: '收到，记下了', logPrefix: 't', sendHook: async ({ card }) => { shortCards.push(card); return { ok: true } } })
        assert.equal(shortCards[0].elements[0].content, '收到，记下了')
        // 表外 phase：不发、不记账、返回原因。
        let called = false
        const unknown = await sendGroupCard({ webhook: { url: 'u' }, chatId: 'oc_unknown', phase: 'weekly_report', body: 'x', logPrefix: 't', sendHook: async () => { called = true; return { ok: true } } })
        assert.equal(unknown.ok, false)
        assert.match(unknown.reason, /不在出口规则表/)
        assert.equal(called, false)
        assert.deepEqual(listOutbox({ chatId: 'oc_unknown' }), [])
      } finally {
        delete process.env.LARK_OUTBOX_DIR
        rmSync(dir, { recursive: true, force: true })
      }
    }],
    ['出口规则表（10-27）：每种 phase 每列必填、值合法、不许表外列；坏表逐条报出', () => {
      assert.deepEqual(validatePhaseTable(GROUP_PHASES), [])
      const errors = validatePhaseTable({ weekly: { overflow: 'to_doc', dedupe: 'content_24h' }, odd: { overflow: 'cut', dedupe: 'content_24h', privateOnly: 'forward_owner', mood: 'x' } })
      assert.deepEqual(errors, [
        'weekly 缺列 privateOnly（合法值：caller_reports / forward_owner）',
        'odd.overflow = cut 不合法（合法值：to_doc / as_is）',
        'odd 多了表外的列 mood：先在 POLICY_COLUMNS 登记',
      ])
      assert.equal(groupPhasePolicy('weekly_report'), null)
      assert.equal(groupPhasePolicy('toString'), null, '原型链上的名字不算登记')
    }],
    ['出口规则表覆盖全部发群调用（10-27）：源码里每个 sendGroupCard( 调用都写字面量 phase，且都在表里', () => {
      const files = [...readdirSync(join(larkBotRoot, 'lib')).filter((name) => name.endsWith('.mjs')).map((name) => join(larkBotRoot, 'lib', name)), ...readdirSync(larkBotRoot).filter((name) => name.endsWith('.mjs')).map((name) => join(larkBotRoot, name))]
      const calls = []
      for (const file of files) {
        const source = readFileSync(file, 'utf8')
        for (const match of source.matchAll(/sendGroupCard\(\{/g)) {
          const window = source.slice(match.index, match.index + 800)
          const phase = window.match(/\bphase: '([a-z_]+)'/)?.[1] || null
          calls.push({ file: file.slice(larkBotRoot.length + 1), phase })
        }
      }
      assert.ok(calls.length >= 8, `只扫到 ${calls.length} 处发群调用，扫描规则失效了`)
      for (const call of calls) {
        assert.ok(call.phase, `${call.file} 有一处 sendGroupCard 调用没写字面量 phase：出口规则表管不到它`)
        assert.ok(groupPhasePolicy(call.phase), `${call.file} 用了 phase ${call.phase}，出口规则表（lib/lark-group-phases.mjs）里没有`)
      }
      // 测试只许替换网络层（sendHook / sendWebhookMessage），不许替换整个出口：日报以前注入假出口，出口规则从没在日报上跑过（10-26）。
      for (const file of files) {
        const source = readFileSync(file, 'utf8')
        assert.doesNotMatch(source, /deps\.sendGroupCard|sendCard\s*=\s*sendGroupCard/, `${file.slice(larkBotRoot.length + 1)} 留了可替换的发群出口：只开放 sendHook`)
      }
      const testDir = join(larkBotRoot, '__tests__')
      for (const name of readdirSync(testDir).filter((item) => item.endsWith('.mjs'))) {
        assert.doesNotMatch(readFileSync(join(testDir, name), 'utf8'), /\bsendGroupCard\s*:|\bsendCard\s*[:=]/, `__tests__/${name} 替换了整个发群出口：只许替换 sendHook / sendWebhookMessage`)
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
