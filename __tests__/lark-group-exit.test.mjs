import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'

import { fetchRecentChatContext, markdownIdempotencyKey, replyMarkdown, sendMarkdown } from '../lib/lark-cli.mjs'
import { createLarkDocFromMarkdown, keepGroupTextShort, publishMarkdownDoc } from '../lib/lark-docs.mjs'
import { renderMentions, replyKeyFor, sendPrincipalNote, sendReply } from '../lib/lark-group-exit.mjs'
import { GROUP_PHASES, validatePhaseTable } from '../lib/lark-group-phases.mjs'
import { listOutbox } from '../lib/lark-outbox.mjs'
import { createTaskStore } from '../lib/lark-task-store.mjs'
import { runSteps } from './support/steps.mjs'

// 群 / 私信唯一出口（对话层 11-01）：阶段表、回复原消息 → 直发回落、出口闸、超长转文档、@ 渲染、回执登记。一个 it，分段跑，每段独立临时目录。
const root = resolve(new URL('..', import.meta.url).pathname)
const okOut = (id) => ({ code: 0, stdout: JSON.stringify({ ok: true, data: { message_id: id } }), stderr: '' })
const paramFail = { code: 1, stdout: JSON.stringify({ ok: false, error: { type: 'invalid_argument', message: 'message not found' } }), stderr: '' }
const netFail = { code: -1, stdout: '', stderr: 'timeout' }
// 假 lark-cli：按出现顺序回结果，记下参数。
const fakeRun = (results) => {
  const calls = []
  return { calls, run: async (args) => { calls.push(args); return results[Math.min(calls.length, results.length) - 1] } }
}
const quiet = async (fn) => {
  const spies = ['log', 'warn', 'error'].map((name) => { const original = console[name]; console[name] = () => {}; return () => { console[name] = original } })
  try {
    return await fn()
  } finally {
    for (const restore of spies) restore()
  }
}
const LONG = `${'结论第一行'}\n${'细'.repeat(600)}`

describe('群 / 私信唯一出口', () => {
  let tmp
  let store
  const config = { notifyOpenId: 'ou_aven', docIdentity: 'user' }
  const stubs = () => {
    const sent = []
    return {
      sent,
      replyMarkdown: async (args) => { sent.push({ kind: 'reply', ...args }); return { ok: true, messageId: `om_r${sent.length}`, via: 'reply', reason: null } },
      sendMarkdown: async (args) => { sent.push({ kind: 'send', ...args }); return { ok: true, messageId: `om_s${sent.length}`, reason: null } },
      publish: async () => ({ ok: true, url: 'https://doc/1', reason: null }),
    }
  }
  const newTask = (extra = {}) => store.upsert({ id: 'om_1', epoch: 2, chatId: 'oc_g', messageId: 'om_1', operator: 'ou_qa', topic: 'login', summary: '登录页报错', status: 'running', ...extra })
  it('阶段表校验与源码字面量、reply→send 回落、出口闸、超长转文档、@ 渲染、幂等键、私信回执', () => runSteps([
    ['validatePhaseTable：缺列 / 非法值 / 表外列各报一条；好表零错', () => {
      const errors = validatePhaseTable({ bad: { overflow: 'to_doc', dedupe: 'weekly', anchor: 'reply_origin', extra: 1 } })
      assert.deepEqual(errors, ['bad.dedupe = weekly 不合法（合法值：content_24h / per_person_2min）', 'bad 缺列 receipt（合法值：task / none）', 'bad 多了表外的列 extra：先在 POLICY_COLUMNS 登记'])
      assert.deepEqual(validatePhaseTable({ good: { overflow: 'as_is', dedupe: 'content_24h', anchor: 'send', receipt: 'none' } }), [])
      assert.deepEqual(validatePhaseTable({}), [])
    }],
    ['源码里每个 phase 字面量都在表里', () => {
      const missing = []
      for (const name of readdirSync(join(root, 'lib')).filter((item) => item.endsWith('.mjs'))) {
        // 只看代码行（注释里描述本扫描的 `phase: '…'` 不算）。
        const code = readFileSync(join(root, 'lib', name), 'utf8').split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n')
        for (const match of code.matchAll(/phase: '([^']+)'/g)) if (!GROUP_PHASES[match[1]]) missing.push(`${name}: ${match[1]}`)
      }
      assert.deepEqual(missing, [])
      assert.ok(Object.keys(GROUP_PHASES).length >= 9)
    }],
    ['replyMarkdown：成功走 reply；非瞬时失败回落 send（键加 -s、≤ 50）；瞬时失败不回落；没 messageId 直接 send；--reply-in-thread 只在话题里', () => quiet(async () => {
      const ok = fakeRun([okOut('om_9')])
      assert.deepEqual(await replyMarkdown({ messageId: 'om_1', markdown: '好', inThread: true, fallbackChatId: 'oc_g', retries: 1, run: ok.run }), { ok: true, messageId: 'om_9', via: 'reply', reason: null })
      assert.deepEqual(ok.calls[0], ['im', '+messages-reply', '--message-id', 'om_1', '--markdown', '好', '--reply-in-thread', '--idempotency-key', markdownIdempotencyKey('om_1', '好'), '--format', 'json'])
      const fallback = fakeRun([paramFail, okOut('om_10')])
      const longKey = 'k'.repeat(60)
      const sent = await replyMarkdown({ messageId: 'om_1', markdown: '好', fallbackChatId: 'oc_g', idempotencyKey: longKey, retries: 1, run: fallback.run })
      assert.deepEqual(sent, { ok: true, messageId: 'om_10', chatId: null, via: 'send', reason: null })
      assert.equal(fallback.calls[0].includes('--reply-in-thread'), false)
      assert.equal(fallback.calls[0][fallback.calls[0].indexOf('--idempotency-key') + 1], 'k'.repeat(50))
      assert.equal(fallback.calls[1][1], '+messages-send')
      assert.equal(fallback.calls[1][fallback.calls[1].indexOf('--idempotency-key') + 1], `${'k'.repeat(48)}-s`)
      const both = fakeRun([paramFail, paramFail])
      assert.match((await replyMarkdown({ messageId: 'om_1', markdown: '好', fallbackChatId: 'oc_g', retries: 1, run: both.run })).reason, /回复失败.*直发也失败/)
      const transient = fakeRun([netFail])
      assert.deepEqual(await replyMarkdown({ messageId: 'om_1', markdown: '好', fallbackChatId: 'oc_g', retries: 1, run: transient.run }), { ok: false, messageId: null, via: 'reply', reason: 'timeout' })
      assert.equal(transient.calls.length, 1, '瞬时失败不回落')
      const noFallback = fakeRun([paramFail])
      assert.equal((await replyMarkdown({ messageId: 'om_1', markdown: '好', retries: 1, run: noFallback.run })).via, 'reply')
      const direct = fakeRun([okOut('om_11')])
      assert.equal((await replyMarkdown({ messageId: null, markdown: '好', fallbackChatId: 'ou_aven', retries: 1, run: direct.run })).via, 'send')
      assert.deepEqual(direct.calls[0].slice(0, 4), ['im', '+messages-send', '--user-id', 'ou_aven'])
      assert.deepEqual(await replyMarkdown({ messageId: null, markdown: '好', retries: 1, run: direct.run }), { ok: false, messageId: null, via: 'reply', reason: 'missing messageId' })
    })],
    ['sendMarkdown：缺 chatId 不发；ou_ 走 --user-id、oc_ 走 --chat-id；默认键 md-<40 hex>；失败带原因', () => quiet(async () => {
      assert.deepEqual(await sendMarkdown({ chatId: '', markdown: 'x' }), { ok: false, messageId: null, reason: 'missing chatId' })
      const run = fakeRun([okOut('om_2'), paramFail, { code: 0, stdout: JSON.stringify({ ok: true, data: { message_id: 'om_3', chat_id: 'oc_dm' } }), stderr: '' }])
      assert.deepEqual(await sendMarkdown({ chatId: 'oc_g', markdown: 'x', retries: 1, run: run.run }), { ok: true, messageId: 'om_2', chatId: null, reason: null })
      assert.deepEqual(run.calls[0], ['im', '+messages-send', '--chat-id', 'oc_g', '--markdown', 'x', '--idempotency-key', markdownIdempotencyKey('oc_g', 'x'), '--format', 'json'])
      assert.match(markdownIdempotencyKey('oc_g', 'x'), /^md-[0-9a-f]{40}$/)
      assert.notEqual(markdownIdempotencyKey('oc_g', 'x'), markdownIdempotencyKey('oc_h', 'x'))
      assert.equal((await sendMarkdown({ chatId: 'ou_a', markdown: 'x', retries: 1, run: run.run })).ok, false)
      assert.deepEqual(run.calls[1].slice(2, 4), ['--user-id', 'ou_a'])
      // 按 open_id 私信时 lark-cli 回 data.chat_id：带回来给回执记 oc_（11-02 复核，私信回「是 / 继续」要按它锚）
      assert.deepEqual(await sendMarkdown({ chatId: 'ou_a', markdown: 'y', retries: 1, run: run.run }), { ok: true, messageId: 'om_3', chatId: 'oc_dm', reason: null })
    })],
    ['sendReply：表外 phase 拒发；缺 chatId 不发；reply_origin 回原消息（话题内 inThread）、send 直发；发成记发件簿 + 回执', () => quiet(async () => {
      const s = stubs()
      const task = newTask({ replyTarget: { messageId: 'om_root', inThread: true } })
      assert.match((await sendReply({ config, store, task, phase: 'nope', text: 'x', deps: s })).reason, /不在出口规则表/)
      assert.equal((await sendReply({ config, store, task: { id: 'x' }, phase: 'ack', text: 'x', deps: s })).reason, 'missing chatId')
      const sent = await sendReply({ config, store, task, phase: 'ack', text: '收到。', idempotencyKey: 'k1', deps: s })
      assert.deepEqual(sent, { ok: true, messageId: 'om_r1', gated: false, reason: null, via: 'reply' })
      assert.deepEqual([s.sent[0].messageId, s.sent[0].inThread, s.sent[0].fallbackChatId, s.sent[0].idempotencyKey, s.sent[0].logPrefix], ['om_root', true, 'oc_g', 'k1', 'ack om_1'])
      assert.deepEqual(store.get('om_1').receipts.map((r) => [r.messageId, r.kind, r.epoch, r.chatId]), [['om_r1', 'ack', 2, 'oc_g']])
      const entry = listOutbox({ chatId: 'oc_g' })[0]
      assert.deepEqual([entry.phase, entry.to, entry.topic, entry.messageId, entry.text, entry.gated], ['ack', 'ou_qa', 'login', 'om_r1', '收到。', undefined])
      // 没有 replyTarget 回原消息本身、不进话题；没有 messageId 直发
      const plain = newTask({ id: 'om_2', messageId: 'om_2' })
      await sendReply({ config, store, task: plain, phase: 'done', text: '结论', deps: s })
      assert.deepEqual([s.sent[1].kind, s.sent[1].messageId, s.sent[1].inThread, s.sent[1].idempotencyKey], ['reply', 'om_2', false, undefined])
      const direct = await sendReply({ config, store, task: newTask({ id: 'om_3', messageId: null, operator: 'ou_other' }), phase: 'done', text: '结论二', deps: s })
      assert.deepEqual([s.sent[2].kind, s.sent[2].chatId, direct.via], ['send', 'oc_g', 'send'])
      // anchor=send 的 phase 直发；receipt=none 不登记回执
      await sendReply({ config, store, task: newTask({ id: 'om_4', chatId: 'ou_aven' }), phase: 'digest', text: '汇总', deps: s })
      assert.deepEqual([s.sent[3].kind, s.sent[3].chatId], ['send', 'ou_aven'])
      assert.equal(store.get('om_4').receipts, undefined)
      // 发送失败：不记发件簿、不登记回执
      const failing = { ...s, replyMarkdown: async () => ({ ok: false, messageId: null, via: 'reply', reason: '撤回了' }) }
      assert.deepEqual(await sendReply({ config, store, task: newTask({ id: 'om_5', messageId: 'om_5' }), phase: 'done', text: '结论三', deps: failing }), { ok: false, messageId: null, gated: false, reason: '撤回了', via: 'reply' })
      assert.equal(listOutbox({ chatId: 'oc_g' }).some((item) => item.taskId === 'om_5'), false)
      assert.equal(store.get('om_5').receipts, undefined)
      // 发成但没拿到 message_id：记发件簿、不登记回执
      const noId = { ...s, replyMarkdown: async () => ({ ok: true, messageId: null, via: 'reply', reason: null }) }
      assert.equal((await sendReply({ config, store, task: newTask({ id: 'om_6', messageId: 'om_6' }), phase: 'done', text: '结论四', deps: noId })).ok, true)
      assert.equal(store.get('om_6').receipts, undefined)
    })],
    ['出口闸：同一人 2 分钟内第二句「收到」拦下，记 gated 不发、不登记回执；同内容结论 24h 只发一次', () => quiet(async () => {
      const s = stubs()
      const task = newTask()
      assert.equal((await sendReply({ config, store, task, phase: 'ack', text: '收到。', deps: s })).ok, true)
      const gated = await sendReply({ config, store, task: newTask({ id: 'om_2', messageId: 'om_2' }), phase: 'ack', text: '收到，看看。', deps: s })
      assert.deepEqual([gated.ok, gated.gated, gated.via], [false, true, null])
      assert.match(gated.reason, /^出口闸拦下：2 分钟内已对同一人就主题 login 发过 ack/)
      assert.equal(s.sent.length, 1)
      const entries = listOutbox({ chatId: 'oc_g' })
      assert.deepEqual(entries.map((item) => [item.taskId, Boolean(item.gated)]), [['om_1', false], ['om_2', true]])
      assert.equal(store.get('om_2').receipts, undefined)
      assert.equal((await sendReply({ config, store, task: newTask({ id: 'om_3', messageId: 'om_3', operator: 'ou_else' }), phase: 'ack', text: '收到。', deps: s })).ok, true, '另一个人不拦')
      assert.equal((await sendReply({ config, store, task, phase: 'done', text: '结论一样', deps: s })).ok, true)
      assert.equal((await sendReply({ config, store, task: newTask({ id: 'om_4', messageId: 'om_4' }), phase: 'done', text: '结论一样', deps: s })).gated, true)
      assert.equal((await sendReply({ config, store, task: newTask({ id: 'om_5', messageId: 'om_5' }), phase: 'done', text: '结论不一样', deps: s })).ok, true)
    })],
    ['超长转文档：to_doc 的 phase 建成文档留第一行 + 链接（发件簿记 fullText，文档标题是任务标题 / 没标题用 id）；建不成原文照发不截；as_is 的 phase 不转', () => quiet(async () => {
      const titles = []
      const s = { ...stubs(), publish: async (args) => { titles.push(args.title); return { ok: true, url: 'https://doc/1', reason: null } } }
      const sent = await sendReply({ config, store, task: newTask(), phase: 'done', text: LONG, deps: s })
      assert.equal(sent.ok, true)
      assert.equal(s.sent[0].markdown, '结论第一行\n完整内容：https://doc/1')
      await sendReply({ config, store, task: newTask({ id: 'om_4', messageId: 'om_4', summary: null }), phase: 'done', text: `第二条结论\n${'细'.repeat(600)}`, deps: s })
      assert.deepEqual(titles, ['登录页报错（完整内容）', 'om_4（完整内容）'])
      const entry = listOutbox({ chatId: 'oc_g' })[0]
      assert.deepEqual([entry.text, entry.fullText], ['结论第一行\n完整内容：https://doc/1', LONG])
      const failing = { ...s, publish: async () => ({ ok: false, url: null, reason: '没 scope' }) }
      await sendReply({ config, store, task: newTask({ id: 'om_2', messageId: 'om_2' }), phase: 'done', text: `${LONG}2`, deps: failing })
      assert.equal(s.sent[2].markdown, `${LONG}2`, '建不成原文照发')
      assert.equal(listOutbox({ chatId: 'oc_g' })[2].fullText, undefined)
      await sendReply({ config, store, task: newTask({ id: 'om_3', messageId: 'om_3' }), phase: 'reminder', text: `${LONG}3`, deps: s })
      assert.equal(s.sent[3].markdown, `${LONG}3`, 'as_is 不转')
      assert.deepEqual(await keepGroupTextShort({ text: '短', title: 't', publish: async () => { throw new Error('不该调') } }), { text: '短', docUrl: null, overflowed: false })
      assert.deepEqual(await keepGroupTextShort({ text: 'ab', title: 't', max: 2, publish: async () => { throw new Error('不该调') } }), { text: 'ab', docUrl: null, overflowed: false }, '恰好等于上限不转')
      assert.deepEqual(await keepGroupTextShort({ text: 'abc', title: 't', max: 2, publish: async () => ({ ok: true, url: null }) }), { text: 'abc', docUrl: null, overflowed: true })
      assert.deepEqual(await publishMarkdownDoc({ title: 't', markdown: '<at user_id="ou_a">A</at> 看 <at id=ou_b></at>x', create: async ({ file, identity, dir }) => ({ ok: readFileSync(join(dir, file), 'utf8') === 'A 看 x' && identity === 'user', url: 'u' }) }), { ok: true, url: 'u', reason: null })
      assert.deepEqual(await publishMarkdownDoc({ title: 't', markdown: 'x', create: async () => ({ ok: false, reason: 'r' }) }), { ok: false, url: null, reason: 'r' })
      assert.deepEqual(await publishMarkdownDoc({ title: 't', markdown: 'x', create: async () => { throw new Error('炸') } }), { ok: false, url: null, reason: '炸' })
      assert.deepEqual(await publishMarkdownDoc({ title: 't', markdown: 'x' }), { ok: false, url: null, reason: 'test' }, '单测里默认不真建文档')
      // createLarkDocFromMarkdown：用户身份建文档 + 设链接可读（失败只告警）；没 url / 解析失败 / 调用失败各自报原因
      const created = fakeRun([{ code: 0, stdout: JSON.stringify({ ok: true, data: { document: { url: 'https://doc/9', document_id: 'dx' } } }), stderr: '' }, paramFail])
      assert.deepEqual(await createLarkDocFromMarkdown({ title: 'T', dir: '/tmp', file: 'd.md', run: created.run }), { ok: true, url: 'https://doc/9', documentId: 'dx', linkReadable: false })
      assert.deepEqual(created.calls[0].slice(0, 4), ['docs', '+create', '--title', 'T'])
      assert.deepEqual(created.calls[1].slice(0, 5), ['drive', 'permission.public', 'patch', '--yes', '--token'])
      const noShare = fakeRun([{ code: 0, stdout: JSON.stringify({ data: { document: { url: 'u', document_id: 'd' } } }), stderr: '' }])
      assert.equal((await createLarkDocFromMarkdown({ title: 'T', dir: '/tmp', file: 'd.md', linkReadable: false, run: noShare.run })).linkReadable, true)
      assert.equal(noShare.calls.length, 1, '不设链接可读就不调权限接口')
      assert.deepEqual(await createLarkDocFromMarkdown({ title: 'T', dir: '/tmp', file: 'd.md', run: fakeRun([{ code: 0, stdout: '{"data":{}}', stderr: '' }]).run }), { ok: false, reason: '未返回文档 url' })
      assert.match((await createLarkDocFromMarkdown({ title: 'T', dir: '/tmp', file: 'd.md', run: fakeRun([{ code: 0, stdout: 'nope', stderr: '' }]).run })).reason, /^解析失败/)
      assert.deepEqual(await createLarkDocFromMarkdown({ title: 'T', dir: '/tmp', file: 'd.md', run: fakeRun([paramFail]).run }), { ok: false, reason: 'invalid_argument: message not found' })
    })],
    ['renderMentions：@名字 换 at 标签、没点到名的补行首、没 openId 的忽略；同一人只 @ 一次', () => {
      assert.equal(renderMentions('@后端：补接口', [{ name: '后端', openId: 'ou_be' }, { name: '', openId: 'ou_x' }, { name: '无', openId: null }]), '<at user_id="ou_x"></at> <at user_id="ou_be">后端</at>：补接口')
      assert.equal(renderMentions('<at user_id="ou_x"></at> 看', [{ name: '', openId: 'ou_x' }]), '<at user_id="ou_x"></at> 看', '已有标签不补')
      assert.equal(renderMentions('看', []), '看')
      assert.equal(renderMentions('看', [{ name: 'A', openId: 'ou_a' }]), '<at user_id="ou_a">A</at> 看')
      assert.equal(renderMentions('@A @A 看', [{ name: 'A', openId: 'ou_a' }]), '<at user_id="ou_a">A</at> <at user_id="ou_a">A</at> 看', '去重在 sendReply 里做')
    }],
    ['replyKeyFor：任务 + 代次 + 短码 ≤ 50', () => {
      assert.equal(replyKeyFor({ id: 'om_1', epoch: 3 }, 'ask'), 'om_1-e3-ask')
      assert.equal(replyKeyFor({ id: 'om_1' }, 'rm', '1'), 'om_1-e0-rm1')
      assert.equal(replyKeyFor({ id: 'x'.repeat(60), epoch: 1 }, 'done').length, 50)
      assert.equal(replyKeyFor(null, 'done'), 'na-e0-done')
    }],
    ['sendPrincipalNote：没配 notifyOpenId 不发；发成记发件簿（按他的 open_id）+ 任务回执；没 taskId 不登记；失败带原因', () => quiet(async () => {
      const s = stubs()
      assert.deepEqual(await sendPrincipalNote({ config: {}, store, text: 'x', deps: s }), { ok: false, messageId: null, reason: 'no notifyOpenId' })
      newTask()
      assert.deepEqual(await sendPrincipalNote({ config, store, text: '❓ 疑似', taskId: 'om_1', kind: 'suspected', idempotencyKey: 'k', deps: s }), { ok: true, messageId: 'om_s1', reason: null })
      assert.deepEqual([s.sent[0].chatId, s.sent[0].markdown, s.sent[0].idempotencyKey], ['ou_aven', '❓ 疑似', 'k'])
      assert.deepEqual(store.get('om_1').receipts.map((r) => [r.messageId, r.kind, r.epoch, r.chatId]), [['om_s1', 'suspected', 2, 'ou_aven']])
      const entry = listOutbox({ chatId: 'ou_aven' })[0]
      assert.deepEqual([entry.phase, entry.taskId, entry.topic, entry.to, entry.messageId], ['suspected', 'om_1', 'login', 'ou_aven', 'om_s1'])
      assert.equal((await sendPrincipalNote({ config, store, text: '汇总', deps: s })).ok, true)
      assert.equal(listOutbox({ chatId: 'ou_aven' })[1].taskId, null)
      assert.equal(store.get('om_1').receipts.length, 1)
      const failing = { sendMarkdown: async () => ({ ok: false, messageId: null, reason: '网络' }) }
      assert.deepEqual(await sendPrincipalNote({ config, store, text: 'x', taskId: 'om_1', deps: failing }), { ok: false, messageId: null, reason: '网络' })
      const noId = { sendMarkdown: async () => ({ ok: true, messageId: null }) }
      assert.equal((await sendPrincipalNote({ config, store, text: 'y', taskId: 'om_1', deps: noId })).ok, true)
      assert.equal(store.get('om_1').receipts.length, 1, '没 message_id 不登记回执')
    })],
    ['fetchRecentChatContext：倒着翻页凑够 limit、拉失败 / 抛错返回已拿到的、缺参数返回空', async () => {
      const user = (id, t) => ({ message_id: id, msg_type: 'text', create_time: String(t), sender: { id: 'ou_k', sender_type: 'user', name: 'K' }, content: JSON.stringify({ text: `m${id}` }) })
      const beforeMs = 1_700_000_000_000
      const pages = [
        { ok: true, messages: [user('3', beforeMs - 3000), user('2', beforeMs - 4000)], hasMore: true, pageToken: 'p2' },
        { ok: true, messages: [user('1', beforeMs - 5000)], hasMore: false, pageToken: null },
      ]
      const calls = []
      const list = async (args) => { calls.push(args); return pages[calls.length - 1] }
      const out = await fetchRecentChatContext({ chatId: 'oc', beforeMs, limit: 10, list })
      assert.deepEqual(out.map((item) => item.text), ['m1', 'm2', 'm3'])
      assert.deepEqual([calls[0].order, calls[0].pageSize, calls[0].pageToken, calls[1].pageToken, calls[0].end], ['desc', 50, null, 'p2', String(Math.ceil(beforeMs / 1000))])
      let n = 0
      assert.equal((await fetchRecentChatContext({ chatId: 'oc', beforeMs, limit: 2, list: async () => pages[n++] })).length, 2, '凑够就不翻下一页')
      assert.equal(n, 1, '凑够 limit 只拉了一页')
      n = 0
      assert.deepEqual((await fetchRecentChatContext({ chatId: 'oc', beforeMs, list: async () => (n++ ? pages[1] : { ...pages[0], pageToken: null }) })).map((item) => item.text), ['m2', 'm3'], 'hasMore 却没 pageToken 就停')
      n = 0
      assert.equal((await fetchRecentChatContext({ chatId: 'oc', beforeMs, limit: 10, maxPages: 1, list: async () => pages[n++] })).length, 2)
      n = 0
      assert.deepEqual((await fetchRecentChatContext({ chatId: 'oc', beforeMs, list: async () => (n++ ? { ok: false } : pages[0]) })).map((item) => item.text), ['m2', 'm3'])
      assert.deepEqual(await fetchRecentChatContext({ chatId: 'oc', beforeMs, list: async () => { throw new Error('x') } }), [])
      assert.deepEqual(await fetchRecentChatContext({ chatId: '', beforeMs, list }), [])
      assert.deepEqual(await fetchRecentChatContext({ chatId: '', beforeMs, list: async () => pages[0] }), [], '缺 chatId 根本不拉')
      assert.deepEqual(await fetchRecentChatContext({ chatId: 'oc', beforeMs: 0, list }), [])
    }],
  ], {
    before: () => {
      tmp = mkdtempSync(join(tmpdir(), 'lark-exit-'))
      process.env.LARK_OUTBOX_DIR = join(tmp, 'outbox')
      store = createTaskStore({ tasksDir: join(tmp, 'tasks') })
    },
    after: () => {
      delete process.env.LARK_OUTBOX_DIR
      rmSync(tmp, { recursive: true, force: true })
    },
  }))
})
