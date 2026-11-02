import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { startConsumer } from '../lib/lark-consumer.mjs'
import { exemptReason } from '../lib/lark-chat-retention.mjs'
import { validateConfig } from '../lib/lark-config.mjs'
import { forwardOlMail } from '../lib/lark-mail-ol-forward.mjs'
import { catchUpMailOl, createMailOlHandler, fileMailOlIo, mailFromWatchLine, shouldHandleMail, startMailOlWatch } from '../lib/lark-mail-ol-watch.mjs'
import { classifyOlKind, hasOlSubject, isOlApplicationMail, renderOlScore, scoreOlMail } from '../lib/lark-mail-ol-score.mjs'
import { runSteps } from './support/steps.mjs'

// OL 上线申请邮件打分 + 转群（aven 11-02，口径见 docs/mail-ol-scoring-2026-11-02.md）。正文样本按 11-02 拉的 100 封里的真实写法缩写。
const FULL_BODY = [
  'Hi，尊敬的客户您好： 本次已通过测试验收，请安排以下更新，谢谢。 一、环境 ONLINE',
  '二、更新内容 类型 功能或者需求描述 开发者 需求 【TR-02647】Banner图删除修改为软删除 @Alec',
  '三、上线参与人及职责 验收角色 负责人 验收范围 在线状态 验收结论时限 QA 验收 @Alec 核心功能 已确认在线 OPS 通知更新完成后 60 分钟内',
  '四、服务版本信息 服务名称 发布版本 TAG 可回滚版本 TAG operate-web PROD-007e6c0bdfc7532700c9 PROD-263a7bc67a89228494b2',
  '五、后端服务更新 / 操作步骤执行 SQL 六、回滚方式服务回滚 七、线上验收 Checklist 八、注意事项 无 九、附件清单 TR-02647-OL.sql',
].join(' ')
const STD_TO = [{ mail_address: 'sysops@hqstech.com' }]
const STD_CC = [{ mail_address: 'devcto@mail.fameex.info' }, { mail_address: 'qa@globaldev.info' }]
const STD_SUBJECT = '【HQEX】【CHAINUP】【ONLINE】【TR-02647】【现货后台】Banner图删除修改为软删除【20261023】'
const mailOut = (data) => ({ code: 0, stdout: JSON.stringify({ ok: true, data }), stderr: '' })
const fakeRun = (results) => {
  const calls = []
  return { calls, run: async (args, options) => { calls.push({ args, identity: options?.identity || 'bot' }); return results[Math.min(calls.length, results.length) - 1] } }
}
const memIo = (initial = { checkedAt: null, forwarded: {} }) => {
  let state = JSON.parse(JSON.stringify(initial))
  const writes = []
  return { writes, read: () => JSON.parse(JSON.stringify(state)), write: (next) => { state = JSON.parse(JSON.stringify(next)); writes.push(state) } }
}
const OL_EVENT = { message_id: 'm1', folder_id: 'INBOX', subject: STD_SUBJECT }
const quiet = async (fn) => {
  const original = [console.log, console.warn, console.error]
  console.log = console.warn = console.error = () => {}
  try {
    return await fn()
  } finally {
    ;[console.log, console.warn, console.error] = original
  }
}

describe('OL 上线申请邮件打分与转群', () => {
  it('首封判定、16 项打分与档位、缺项说明、转群走 user 分享 + bot 回卡片', () => runSteps([
    ['只转 OL 申请首封：回复 / 转发 / 非 OL 环境 / 有 in_reply_to 都不转', () => {
      for (const subject of [STD_SUBJECT, '【HQEX】【CHAINUP】【OL环境】生产环境 撮合 重启【20261027】', '【嗨聊】OL環境-申請上線 v6.10.3', '【HQEX】【CHAINUP】【ol】【需求】x【20261018】', '【20261031】【B2B_直播中心】【Falive 直播站】【OL环境 HQUC-AWS-JP-OL-falive-core01】 x']) {
        assert.equal(isOlApplicationMail({ subject }), true, subject)
      }
      for (const subject of [`Re: ${STD_SUBJECT}`, `回覆：${STD_SUBJECT}`, '【20261029】【Falive 直播站】【PRE环境】 同步更新 uat/online 的 baseUrl', 'TOOL 升级【20261102】', '【HQEX】【PRE】x']) {
        assert.equal(isOlApplicationMail({ subject }), false, subject)
      }
      assert.equal(isOlApplicationMail({ subject: STD_SUBJECT, inReplyTo: '<abc@x>' }), false)
    }],
    ['9 段模板 + 规范主题 + 正确收件 = 16/16 A 档；说明逐组打勾', () => {
      const result = scoreOlMail({ subject: STD_SUBJECT, body: FULL_BODY, to: STD_TO, cc: STD_CC })
      assert.deepEqual([result.score, result.max, result.tier, result.kind, result.riskNoRollback], [16, 16, 'A', 'hqex', false])
      const text = renderOlScore(result, { sender: 'Alec', subject: STD_SUBJECT })
      assert.match(text, /^\*\*OL 上线申请规范度：16\/16（A 档 · 标准）\*\* · 发件人 Alec/)
      assert.match(text, /- 主题 3\/3 ✓\n- 正文 10\/10 ✓\n- 收件 3\/3 ✓/)
    }],
    ['档位边界：14 → A、13 → B、12 → B、11 → C、8 → D', () => {
      const cut = (body) => scoreOlMail({ subject: STD_SUBJECT, body, to: STD_TO, cc: STD_CC })
      const noTail = FULL_BODY.replace(/七、线上验收 Checklist 八、注意事项 无 九、附件清单 TR-02647-OL.sql/, '')
      assert.deepEqual([cut(noTail).score, cut(noTail).tier], [13, 'B'])
      const s14 = scoreOlMail({ subject: STD_SUBJECT.replace('【20261023】', '【202601023】').replace('【TR-02647】', ''), body: FULL_BODY, to: STD_TO, cc: STD_CC })
      assert.deepEqual([s14.score, s14.tier], [14, 'A'])
      const s12 = scoreOlMail({ subject: STD_SUBJECT, body: noTail, to: [{ mail_address: 'hurley@krquant.com' }], cc: STD_CC })
      assert.deepEqual([s12.score, s12.tier], [12, 'B'])
      const s11 = scoreOlMail({ subject: STD_SUBJECT, body: noTail.replace(/PROD-\w+/g, 'v1'), to: [], cc: STD_CC })
      assert.deepEqual([s11.score, s11.tier], [11, 'C'])
      const s8 = scoreOlMail({ subject: STD_SUBJECT, body: '一、环境 ONLINE 请执行附件 sql', to: STD_TO, cc: STD_CC })
      assert.deepEqual([s8.score, s8.tier], [8, 'D'])
    }],
    ['缺项说明：9 位日期点出原文、高风险无回滚单列、运维类注明模板不适用；回复首句不吃正文', () => {
      const subject = '【HQEX】【CHAINUP】【OL环境】生产环境 撮合 重启【202601027】'
      const result = scoreOlMail({ subject, body: 'Hi, OPS 本邮件需要审批 重启前，请帮先删除 raft 目录', to: STD_TO, cc: [] })
      assert.equal(result.kind, 'ops')
      assert.equal(result.riskNoRollback, true)
      const text = renderOlScore(result, { subject })
      assert.match(text, /类别：运维操作单/)
      assert.match(text, /⚠️ 含 SQL \/ redis \/ 重启 \/ 删数据类操作，但没写回滚方式/)
      assert.match(text, /结尾 8 位日期【YYYYMMDD】（现在写的是【202601027】）/)
      assert.match(renderOlScore(scoreOlMail({ subject: '【HQEX】【ONLINE】x', body: '' }), { subject: '【HQEX】【ONLINE】x' }), /（没写日期）/)
      const quoted = scoreOlMail({ subject: `Re: ${STD_SUBJECT}`, body: `进行 Alec <a@x> 于2026年10月23日周五 16:14写道： ${FULL_BODY}`, to: STD_TO, cc: STD_CC })
      assert.equal(quoted.score, 16, '回复里引用的原申请照样按原文打分')
      assert.deepEqual(['falive', 'hichat', 'ops', 'hqex'], ['【Falive 直播站】', '【嗨聊】', '补K线', '【HQEX】'].map(classifyOlKind))
    }],
    ['两段条件缺一不算：只有段名没有开发者 / 验收人 / 时限都不给分；主题判定容忍空值；读信结果残缺算读失败', async () => {
      const ok = (body, key) => scoreOlMail({ subject: STD_SUBJECT, body }).items.find((item) => item.key === key).ok
      assert.deepEqual([ok('更新内容 类型 描述', 'bodyContent'), ok('开发者 @a', 'bodyContent'), ok('更新内容 开发者 @a', 'bodyContent')], [false, false, true])
      assert.deepEqual([ok('上线参与人及职责 负责人', 'bodyPeople'), ok('QA 验收 @a', 'bodyPeople'), ok('上线参与人及职责 QA 验收 @a', 'bodyPeople')], [false, false, true])
      assert.deepEqual([ok('已确认在线', 'bodyOnline'), ok('验收结论时限', 'bodyOnline'), ok('已确认在线 验收结论时限', 'bodyOnline')], [false, false, true])
      assert.deepEqual([hasOlSubject(undefined), hasOlSubject('【OL】x')], [false, true])
      const noData = fakeRun([{ code: 0, stdout: '{"ok":true}', stderr: '' }])
      assert.deepEqual(await forwardOlMail({ messageId: 'm', chatId: 'oc', run: noData.run }), { ok: false, step: 'read', reason: '{"ok":true}' })
      const byAddress = fakeRun([mailOut({ subject: STD_SUBJECT, body_plain_text: FULL_BODY, head_from: { mail_address: 'a@x.com' } })])
      assert.match((await forwardOlMail({ messageId: 'm', dryRun: true, run: byAddress.run })).markdown, /· 发件人 a@x\.com/)
    }],
    ['自动转发：+watch 行解析、只处理 INBOX 的 OL 主题、转过的不再转、并发同一封只转一次', async () => {
      assert.deepEqual([mailFromWatchLine({ message: OL_EVENT }), mailFromWatchLine({ ok: true, data: { message: OL_EVENT } }), mailFromWatchLine({ header: {} })], [OL_EVENT, OL_EVENT, null])
      assert.deepEqual([
        shouldHandleMail(OL_EVENT, {}),
        shouldHandleMail({ ...OL_EVENT, folder_id: undefined }, {}),
        shouldHandleMail({ ...OL_EVENT, folder_id: 'SENT' }, {}),
        shouldHandleMail({ ...OL_EVENT, subject: '【HQEX】【PRE】x' }, {}),
        shouldHandleMail(OL_EVENT, { m1: { at: 'x' } }),
        shouldHandleMail({ ...OL_EVENT, message_id: '' }, {}),
      ], [true, true, false, false, false, false])
      const io = memIo()
      const calls = []
      const forward = async ({ messageId, chatId }) => { calls.push([messageId, chatId]); return { ok: true, result: { score: 16, max: 16, tier: 'A' }, scoreVia: 'bot-reply' } }
      const handler = createMailOlHandler({ chatId: 'oc_ol', io, forward, now: () => 'T1' })
      await quiet(() => Promise.all([handler.handle(OL_EVENT), handler.handle(OL_EVENT)]))
      await quiet(() => handler.handle(OL_EVENT))
      assert.deepEqual(calls, [['m1', 'oc_ol']])
      assert.deepEqual(io.read().forwarded, { m1: { at: 'T1', ok: true, score: 16, tier: 'A' } })
    }],
    ['自动转发：读信 / 分享失败不记台账（重投或重启还能补）、非首封与评分发送失败记下不重读、抛错不打断后续', async () => {
      const io = memIo()
      const outcomes = { a: { ok: false, step: 'read', reason: '429' }, b: { ok: false, step: 'filter', reason: 'Re' }, c: { ok: false, step: 'score', reason: 'x' } }
      const forward = async ({ messageId }) => { if (messageId === 'd') throw new Error('boom'); return outcomes[messageId] }
      const handler = createMailOlHandler({ chatId: 'oc', io, forward, now: () => 'T' })
      for (const id of ['a', 'b', 'c', 'd']) await quiet(() => handler.handle({ ...OL_EVENT, message_id: id }))
      assert.deepEqual(io.read().forwarded, { b: { at: 'T', ok: false, step: 'filter' }, c: { at: 'T', ok: false, step: 'score' } })
      const many = memIo({ checkedAt: null, forwarded: Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`old${i}`, { at: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}` }])) })
      await quiet(() => createMailOlHandler({ chatId: 'oc', io: many, forward: async () => ({ ok: true, result: { score: 1, tier: 'D' } }), now: () => '2026-11-02T00:00:00' }).handle(OL_EVENT))
      assert.equal(Object.keys(many.read().forwarded).length, 500, '台账只留最近 500 条')
      assert.ok(many.read().forwarded.m1)
    }],
    ['启动补转：首次启用只落时钟不回填；之后只转上次在线之后到达的；读收件箱失败如实返回', async () => {
      const first = memIo()
      const handled = []
      const handler = { handle: async (mail) => handled.push(mail.message_id) }
      assert.deepEqual(await catchUpMailOl({ handler, io: first, run: async () => { throw new Error('不该读') }, now: () => '2026-11-02T10:00:00Z' }), { skipped: 'first-run' })
      assert.equal(first.read().checkedAt, '2026-11-02T10:00:00Z')
      const later = memIo({ checkedAt: '2026-11-02T10:00:00Z', forwarded: {} })
      const calls = []
      const run = async (args, options) => { calls.push([args, options]); return { code: 0, stdout: JSON.stringify({ messages: [{ message_id: 'new2', date: '2026-11-02T12:00:00Z' }, { message_id: 'new1', date: '2026-11-02T11:00:00Z' }, { message_id: 'old', date: '2026-11-02T09:00:00Z' }, { message_id: 'same', date: '2026-11-02T10:00:00Z' }, { message_id: 'nodate' }] }), stderr: '' } }
      assert.deepEqual(await catchUpMailOl({ handler, io: later, run, now: () => '2026-11-02T13:00:00Z' }), { checked: 2 })
      assert.deepEqual(handled, ['new1', 'new2'], '按到达先后补转，旧的不转')
      assert.equal(calls[0][1].identity, 'user')
      assert.deepEqual(calls[0][0].slice(0, 5), ['mail', '+triage', '--filter', '{"folder":"INBOX"}', '--query'])
      assert.equal(later.read().checkedAt, '2026-11-02T13:00:00Z')
      const failRun = async () => ({ code: 1, stdout: '', stderr: 'HTTP 429' })
      assert.deepEqual(await quiet(() => catchUpMailOl({ handler, io: memIo({ checkedAt: 'x', forwarded: {} }), run: failRun })), { failed: true })
      assert.deepEqual(await catchUpMailOl({ handler, io: memIo({ checkedAt: 'x', forwarded: {} }), run: async () => ({ code: 0, stdout: 'not json', stderr: '' }) }), { failed: true })
    }],
    ['台账文件：读坏 / 字段不对当空表、写后可读、无路径不落盘；startConsumer 自定义命令照传、缺省仍是 bot event consume', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'mail-ol-'))
      try {
        const path = join(dir, 'state.json')
        assert.deepEqual(fileMailOlIo(path).read(), { checkedAt: null, forwarded: {} }, '没有文件')
        writeFileSync(path, 'not json')
        assert.deepEqual(fileMailOlIo(path).read(), { checkedAt: null, forwarded: {} }, '读坏了')
        writeFileSync(path, JSON.stringify({ checkedAt: '', forwarded: 'x' }))
        assert.deepEqual(fileMailOlIo(path).read(), { checkedAt: null, forwarded: {} }, 'forwarded 不是对象')
        writeFileSync(path, JSON.stringify({ forwarded: null }))
        assert.deepEqual(fileMailOlIo(path).read().forwarded, {})
        fileMailOlIo(path).write({ checkedAt: 'T', forwarded: { m: { at: 'T' } } })
        assert.deepEqual(fileMailOlIo(path).read(), { checkedAt: 'T', forwarded: { m: { at: 'T' } } })
        assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).forwarded, { m: { at: 'T' } })
        fileMailOlIo(null).write({ checkedAt: 'x', forwarded: {} })
        await quiet(async () => fileMailOlIo(join(path, 'under-a-file', 's.json')).write({ checkedAt: 'x', forwarded: {} }))
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
      const spawned = []
      const spawnChild = (bin, args) => { const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {}; child.exitCode = null; spawned.push(args); return child }
      const custom = startConsumer({ eventKey: 'mail', command: ['--as', 'user', 'mail', '+watch'], onLine: () => {}, spawnChild })
      const plain = startConsumer({ eventKey: 'im.message.receive_v1', onLine: () => {}, spawnChild })
      custom.stop()
      plain.stop()
      assert.deepEqual(spawned, [['--as', 'user', 'mail', '+watch'], ['--as', 'bot', 'event', 'consume', 'im.message.receive_v1']])
    }],
    ['网关接线：没开 / 没群不起；开了用 user 身份常驻 +watch、行进 handler、停止时落时钟；配置校验；转发群不自动退', async () => {
      let consumed = null
      const consume = (options) => { consumed = options; return { stop: () => { consumed.stopped = true }, observe: () => ({ alive: true }) } }
      assert.equal(startMailOlWatch({ config: { mailOl: { enabled: false, chatId: 'oc' } }, consume }).observe(), null)
      assert.equal(startMailOlWatch({ config: { mailOl: { enabled: true } }, consume }).observe(), null)
      assert.equal(consumed, null)
      const io = memIo()
      let caught = null
      const timers = []
      const watch = await quiet(() => startMailOlWatch({ config: { mailOl: { enabled: true, chatId: 'oc_ol' } }, io, consume, catchUp: async (args) => { caught = args }, schedule: (fn, ms) => { timers.push([fn, ms]); return null } }))
      assert.deepEqual(consumed.command, ['--as', 'user', 'mail', '+watch', '--msg-format', 'metadata', '--format', 'data'])
      assert.equal(consumed.eventKey, 'mail.user_mailbox.event.message_received_v1')
      assert.equal(consumed.onLine({ header: {} }), null, '不是邮件的行不处理')
      assert.ok(caught?.handler && caught.io === io, '启动补转用同一个台账')
      assert.equal(timers[0][1], 600_000)
      timers[0][0]()
      assert.ok(io.read().checkedAt, '定时只写本地时钟')
      assert.deepEqual(watch.observe(), { alive: true })
      watch.stop()
      assert.equal(consumed.stopped, true)
      const base = { project: 'PR-01947' }
      assert.ok(validateConfig({ ...base, mailOl: [] }).errors.some((e) => /mailOl 必须是对象/.test(e)))
      assert.ok(validateConfig({ ...base, mailOl: { enabled: 'yes' } }).errors.some((e) => /mailOl.enabled 必须是/.test(e)))
      assert.ok(validateConfig({ ...base, mailOl: { enabled: true, chatId: 'ou_x' } }).errors.some((e) => /mailOl.chatId 必须是群/.test(e)))
      assert.ok(!validateConfig({ ...base, mailOl: { enabled: true, chatId: 'oc_ok1' } }).errors.some((e) => /mailOl/.test(e)))
      assert.ok(!validateConfig({ ...base, mailOl: { enabled: false } }).errors.some((e) => /mailOl/.test(e)))
      const state = { chats: {} }
      assert.equal(exemptReason({ config: { mailOl: { enabled: true, chatId: 'oc_ol' } }, state, chatId: 'oc_ol' }), 'OL 邮件转发群')
      assert.equal(exemptReason({ config: { mailOl: { enabled: false, chatId: 'oc_ol' } }, state, chatId: 'oc_ol' }), null)
    }],
    ['转群：user 读信 → user 分享卡片 → bot 回在卡片下（卡片 id 取 data.im_message_id）', async () => {
      const { calls, run } = fakeRun([
        mailOut({ subject: STD_SUBJECT, body_plain_text: FULL_BODY, to: STD_TO, cc: STD_CC, head_from: { name: 'Alec' } }),
        mailOut({ card_id: 'c1', im_message_id: 'om_card' }),
        mailOut({ message_id: 'om_score' }),
      ])
      const outcome = await quiet(() => forwardOlMail({ messageId: 'm1', chatId: 'oc_x', run }))
      assert.deepEqual([outcome.ok, outcome.cardMessageId, outcome.scoreMessageId, outcome.scoreVia], [true, 'om_card', 'om_score', 'bot-reply'])
      assert.deepEqual(calls.map((call) => [call.identity, call.args[0], call.args[1]]), [['user', 'mail', '+message'], ['user', 'mail', '+share-to-chat'], ['bot', 'im', '+messages-reply']])
      assert.deepEqual(calls[1].args.slice(2, 6), ['--message-id', 'm1', '--receive-id', 'oc_x'])
      assert.equal(calls[2].args[calls[2].args.indexOf('--message-id') + 1], 'om_card')
      assert.match(calls[2].args[calls[2].args.indexOf('--markdown') + 1], /16\/16（A 档/)
    }],
    ['转群：不是首封不发、读信失败 / 分享失败如实返回步骤、dryRun 只打分', async () => {
      const reply = fakeRun([mailOut({ subject: `Re: ${STD_SUBJECT}`, body_plain_text: '进行' })])
      assert.deepEqual(await forwardOlMail({ messageId: 'm', chatId: 'oc', run: reply.run }), { ok: false, step: 'filter', reason: `不是 OL 上线申请首封：Re: ${STD_SUBJECT}` })
      assert.equal(reply.calls.length, 1)
      const forced = fakeRun([mailOut({ subject: `Re: ${STD_SUBJECT}`, body_plain_text: '进行' })])
      assert.equal((await forwardOlMail({ messageId: 'm', force: true, dryRun: true, run: forced.run })).dryRun, true)
      const readFail = fakeRun([{ code: 1, stdout: '{"ok":false,"error":{"message":"missing scope"}}', stderr: '' }])
      assert.equal((await forwardOlMail({ messageId: 'm', chatId: 'oc', run: readFail.run })).step, 'read')
      const shareFail = fakeRun([mailOut({ subject: STD_SUBJECT, body_plain_text: FULL_BODY }), { code: 1, stdout: '', stderr: 'no permission' }])
      assert.deepEqual(await forwardOlMail({ messageId: 'm', chatId: 'oc', run: shareFail.run }), { ok: false, step: 'share', reason: 'no permission' })
      const dry = fakeRun([mailOut({ subject: STD_SUBJECT, body_plain_text: FULL_BODY })])
      const preview = await forwardOlMail({ messageId: 'm', dryRun: true, run: dry.run })
      assert.deepEqual([preview.ok, preview.result.score, dry.calls.length], [true, 13, 1], '没给收件人：收件 3 项全扣')
    }],
  ]))
})
