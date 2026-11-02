/**
 * 闲置群自动退出（aven 11-02「14 天没有 @bot 的群，能自动退群吗？」）：lib/lark-chat-activity.mjs（记账）+ lib/lark-chat-retention.mjs（每日巡检 / 私信指令 / 定时器）
 * + 出口 sendReply 记活跃 + 配置校验。now / 群列表 / 私信 / 退群 / 状态读写全部注入，私信逐字钉住；不碰真实 lark-cli。
 * 一个 it 合并全部段（测试棘轮）。运行态目录先指到临时目录再动态 import（lark-paths 加载时读）。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { eachCase, runSteps } from './support/steps.mjs'

const dir = mkdtempSync(join(tmpdir(), 'lark-chat-retention-'))
process.env.LARK_RUNTIME_DIR = join(dir, 'runtime')
process.env.LARK_OUTBOX_DIR = join(dir, 'outbox')
const activity = await import('../lib/lark-chat-activity.mjs')
const retention = await import('../lib/lark-chat-retention.mjs')
const { validateConfig } = await import('../lib/lark-config.mjs')
const { sendReply } = await import('../lib/lark-group-exit.mjs')

const { CHAT_ACTIVITY_FILE, ensureStarted, fileActivityIo, recordChatActivity, updateActivity } = activity
const { RETRY_GAP_MS, RUN_SLACK_MS, classifyChats, exemptReason, leaveChat, leaveFailureOf, maybeHandleRetentionDirective, parseRetentionDirective, retentionSettings, runChatRetention, sayRetentionList, startChatRetention } = retention

const HOUR = 60 * 60_000
const DAY = 24 * HOUR
const at = (d, h, m = 0) => new Date(2026, 10, d, h, m).getTime() // 2026-11-d 本地时间
const iso = (ms) => new Date(ms).toISOString()
const ME = 'ou_me'
const CONFIG = { notifyOpenId: ME, botAppId: 'cli_bot' }
const CHATS = () => new Map([['oc_a', 'PR-02306 交易页'], ['oc_b', '活动页群']])
const OK = { code: 0, stdout: '{"ok":true}', stderr: '' }
const SCOPE_FAIL = { code: 1, stdout: '{"ok":false,"error":{"type":"api","code":99991672,"message":"Access denied. App has not applied for the required scope(s): im:chat, im:chat.members:write_only. 应用尚未开通所需的应用身份权限"}}', stderr: '' }
const OTHER_FAIL = { code: 1, stdout: '{"ok":false,"error":{"type":"api","subtype":"forbidden","message":"bot is not in chat 230001"}}', stderr: '' }
const WARN_AB = '这 2 个群 14 天没人 @我了，48 小时后我自动退出：\n- PR-02306 交易页\n- 活动页群\n要留哪个就回「留下 群名里的几个字」。'
const SCOPE_TEXT = (list) => `到点该退的群我退不了：应用还没开通 im:chat、im:chat.members:write_only 权限，去飞书开发者后台给应用加上、发个版就行。我每天会自己再试，这事不再提醒。还没退的：\n${list}`

// 内存版状态读写：每次读给一份深拷贝（和文件一样，改了不写就不算）。
const memIo = (initial = {}) => {
  let data = JSON.parse(JSON.stringify({ chats: {}, ...initial }))
  return { read: () => JSON.parse(JSON.stringify(data)), write: (state) => { data = JSON.parse(JSON.stringify(state)) }, get data() { return data } }
}
const spySend = (ok = true) => {
  const sent = []
  const send = async (args) => { sent.push({ text: args.text, kind: args.kind, key: args.idempotencyKey }); return { ok } }
  return { sent, send }
}
const spyLeave = (results = []) => {
  const calls = []
  const leave = async ({ chatId, config }) => { calls.push(chatId); assert.equal(config.botAppId, 'cli_bot'); return results.length ? results.shift() : OK }
  return { calls, leave }
}
const quiet = async (fn) => {
  const spies = ['log', 'warn', 'error'].map((name) => { const original = console[name]; console[name] = () => {}; return () => { console[name] = original } })
  try {
    return await fn()
  } finally {
    for (const restore of spies) restore()
  }
}
// 一轮巡检（默认群列表 A、B，私信 / 退群都记下来）。
const run = ({ io, now, config = CONFIG, chats = CHATS(), send = spySend(), leave = spyLeave() }) =>
  quiet(() => runChatRetention({ config, now, io, listChats: async () => chats, send: send.send, leave: leave.leave })).then((result) => ({ result, sent: send.sent, left: leave.calls }))
const START = at(2, 9, 0)
const started = (chats = {}, extra = {}) => memIo({ startedAt: iso(START), chats, ...extra })

describe('闲置群自动退出', () => {
  after(() => rmSync(dir, { recursive: true, force: true }))

  it('记账 / 不回填 / 14 天边界 / 提醒一次 / 宽限边界 / 提醒后有人找就作废 / 缺权限只私信一次 / 豁免 / 私信指令 / 定时器 / 出口记活跃 / 配置', () => runSteps([
    ['配置：chatRetention 形状不对拒绝启动，缺省开 / 14 天 / 48 小时 / 09:35', () => {
      const errorsOf = (chatRetention) => validateConfig({ project: 'PR-1', chatRetention }).errors.filter((e) => e.startsWith('chatRetention'))
      assert.deepEqual(errorsOf(undefined), [])
      assert.deepEqual(errorsOf({ enabled: false, idleDays: 7, graceHours: 1.5, at: '23:59', keep: ['oc_x'] }), [])
      assert.deepEqual(errorsOf([]), ['chatRetention 必须是对象 { enabled, idleDays, graceHours, at: "HH:MM", keep: [chat_id] }'])
      assert.deepEqual(errorsOf('on'), ['chatRetention 必须是对象 { enabled, idleDays, graceHours, at: "HH:MM", keep: [chat_id] }'])
      assert.deepEqual(errorsOf({ enabled: 'yes' }), ['chatRetention.enabled 必须是 true / false'])
      assert.deepEqual(errorsOf({ idleDays: 0, graceHours: '48' }), ['chatRetention.idleDays 必须是正数', 'chatRetention.graceHours 必须是正数'])
      assert.deepEqual(errorsOf({ idleDays: Number.NaN }), ['chatRetention.idleDays 必须是正数'])
      assert.deepEqual(errorsOf({ at: '24:00' }), ['chatRetention.at 必须是 HH:MM（00:00–23:59）'])
      assert.deepEqual(errorsOf({ keep: 'oc_x' }), ['chatRetention.keep 必须是 chat_id 字符串数组（这些群永远不自动退）'])
      assert.deepEqual(retentionSettings({}), { enabled: true, idleDays: 14, graceHours: 48, at: '09:35', keep: [] })
      assert.deepEqual(retentionSettings({ chatRetention: { enabled: false, idleDays: 3, graceHours: 2, at: '08:00', keep: ['oc_k'] } }), { enabled: false, idleDays: 3, graceHours: 2, at: '08:00', keep: ['oc_k'] })
    }],
    ['不回填历史：第一次跑记 startedAt，满 14 天前一毫秒不提醒，正好 14 天提醒（合并一条，逐字）', async () => {
      const io = memIo()
      const first = await run({ io, now: START })
      assert.deepEqual([first.sent, first.left, io.data.startedAt, io.data.lastRunDate], [[], [], iso(START), '2026-11-02'])
      assert.deepEqual((await run({ io, now: START + 14 * DAY - 1 })).sent, [])
      const due = await run({ io, now: START + 14 * DAY })
      assert.deepEqual(due.sent, [{ text: WARN_AB, kind: 'chat_retention', key: 'chat-warn-2026-11-16' }])
      assert.deepEqual(due.result, { left: [], warned: ['oc_a', 'oc_b'], failed: null })
      assert.deepEqual(io.data.chats, { oc_a: { warnedAt: iso(START + 14 * DAY) }, oc_b: { warnedAt: iso(START + 14 * DAY) } })
      assert.equal(io.data.startedAt, iso(START), '时钟不重起')
    }],
    ['最后活跃比 startedAt 新就按最后活跃算；群名空的列 chat_id；自定义天数 / 小时数进文案', async () => {
      const io = started({ oc_a: { lastActiveAt: iso(START + 5 * DAY) } })
      const chats = new Map([['oc_a', 'PR-02306 交易页'], ['oc_c', '']])
      const d14 = await run({ io, now: START + 14 * DAY, chats })
      assert.deepEqual(d14.sent.map((s) => s.text), ['这 1 个群 14 天没人 @我了，48 小时后我自动退出：\n- oc_c\n要留哪个就回「留下 群名里的几个字」。'])
      const onlyA = new Map([['oc_a', 'PR-02306 交易页']])
      assert.deepEqual((await run({ io, now: START + 19 * DAY - 1, chats: onlyA })).sent, [])
      assert.equal((await run({ io, now: START + 19 * DAY, chats: onlyA })).sent[0].text, '这 1 个群 14 天没人 @我了，48 小时后我自动退出：\n- PR-02306 交易页\n要留哪个就回「留下 群名里的几个字」。')
      const custom = await run({ io: started(), now: START + 3 * DAY, config: { ...CONFIG, chatRetention: { idleDays: 3, graceHours: 24 } }, chats: new Map([['oc_a', 'A']]) })
      assert.equal(custom.sent[0].text, '这 1 个群 3 天没人 @我了，24 小时后我自动退出：\n- A\n要留哪个就回「留下 群名里的几个字」。')
    }],
    ['只提醒一次；宽限：到点前一小时（查点误差）减一毫秒不退，到了就退、合并私信「已退出」、从记账里删掉', async () => {
      const W = START + 14 * DAY
      const io = started({ oc_a: { warnedAt: iso(W) }, oc_b: { warnedAt: iso(W) } })
      const early = await run({ io, now: W + 48 * HOUR - RUN_SLACK_MS - 1 })
      assert.deepEqual([early.sent, early.left], [[], []])
      const leave = spyLeave()
      const due = await run({ io, now: W + 48 * HOUR - RUN_SLACK_MS, leave })
      assert.deepEqual(leave.calls, ['oc_a', 'oc_b'])
      assert.deepEqual(due.sent, [{ text: '已退出：\n- PR-02306 交易页\n- 活动页群', kind: 'chat_retention', key: 'chat-left-2026-11-18' }])
      assert.deepEqual([io.data.chats, due.result], [{}, { left: ['oc_a', 'oc_b'], warned: [], failed: null }])
    }],
    ['提醒后群里有人找 bot（记活跃清掉 warnedAt）：到点不退，也不马上再提醒', async () => {
      const W = START + 14 * DAY
      const io = started({ oc_a: { warnedAt: iso(W) } })
      assert.equal(recordChatActivity({ chatId: 'oc_a', chatType: 'group', now: W + HOUR, io }), true)
      assert.deepEqual(io.data.chats.oc_a, { lastActiveAt: iso(W + HOUR) })
      const chats = new Map([['oc_a', 'A']])
      const r = await run({ io, now: W + 48 * HOUR, chats })
      assert.deepEqual([r.sent, r.left], [[], []])
    }],
    ['退群缺权限：私信一次要开哪个权限（只试第一个、群留在待退），之后每天静默再试；错误变了再说；退成功后清掉', async () => {
      const W = START + 14 * DAY
      const io = started({ oc_a: { warnedAt: iso(W) }, oc_b: { warnedAt: iso(W) } })
      const d1 = await run({ io, now: W + 2 * DAY, leave: spyLeave([SCOPE_FAIL]) })
      assert.deepEqual(d1.left, ['oc_a'], '缺权限后面的不白打接口')
      assert.deepEqual(d1.sent, [{ text: SCOPE_TEXT('- PR-02306 交易页\n- 活动页群'), kind: 'chat_retention', key: 'chat-leave-fail-2026-11-18' }])
      assert.equal(d1.result.failed, 'scope:im:chat, im:chat.members:write_only')
      assert.deepEqual([io.data.scopeNotifiedFor, Object.keys(io.data.chats)], ['scope:im:chat, im:chat.members:write_only', ['oc_a', 'oc_b']])
      const d2 = await run({ io, now: W + 3 * DAY, leave: spyLeave([SCOPE_FAIL]) })
      assert.deepEqual([d2.left, d2.sent], [['oc_a'], []], '同样的错不再私信')
      const d3 = await run({ io, now: W + 4 * DAY, leave: spyLeave([OTHER_FAIL]) })
      assert.deepEqual(d3.sent.map((s) => s.text), ['到点该退的群退失败了（api/forbidden: bot is not in chat 230001）。我每天会自己再试，同样的错不再提醒。还没退的：\n- PR-02306 交易页\n- 活动页群'])
      assert.equal(io.data.scopeNotifiedFor, 'error:api/forbidden: bot is not in chat #')
      const d4 = await run({ io, now: W + 5 * DAY, leave: spyLeave([OK, SCOPE_FAIL]) })
      assert.deepEqual(d4.sent.map((s) => s.text), ['已退出：\n- PR-02306 交易页', SCOPE_TEXT('- 活动页群')], '退成功过就清掉记号，再缺权限要重新说')
      const failSend = spySend(false)
      const io2 = started({ oc_a: { warnedAt: iso(W) } })
      await run({ io: io2, now: W + 2 * DAY, leave: spyLeave([SCOPE_FAIL]), send: failSend, chats: new Map([['oc_a', 'A']]) })
      assert.equal(io2.data.scopeNotifiedFor, undefined, '私信没发出去不记，明天再说')
    }],
    ['退群失败归类与退群调用：缺权限带 scope / 只有错误码 / 其它；没配 botAppId 不发请求', async () => {
      assert.deepEqual(leaveFailureOf(SCOPE_FAIL), { key: 'scope:im:chat, im:chat.members:write_only', scopes: ['im:chat', 'im:chat.members:write_only'] })
      assert.deepEqual(leaveFailureOf({ code: 1, stdout: '', stderr: 'code 99991672 denied' }), { key: 'scope:', scopes: [] })
      assert.deepEqual(leaveFailureOf({ code: -1, stdout: '', stderr: 'timeout' }), { key: 'error:timeout', reason: 'timeout' })
      assert.equal(retention.sayLeaveFailed({ failure: { scopes: [] }, pending: [{ name: 'A' }] }), '到点该退的群我退不了：应用还没开通 退群要的权限，去飞书开发者后台给应用加上、发个版就行。我每天会自己再试，这事不再提醒。还没退的：\n- A')
      const calls = []
      const result = await leaveChat({ config: CONFIG, chatId: 'oc_a', run: async (args) => { calls.push(args); return OK } })
      assert.deepEqual([result, calls], [OK, [['im', 'chat.members', 'delete', '--yes', '--params', '{"chat_id":"oc_a","member_id_type":"app_id"}', '--data', '{"id_list":["cli_bot"]}']]])
      const noApp = await leaveChat({ config: {}, chatId: 'oc_a', run: async () => assert.fail('不该发请求') })
      assert.deepEqual(noApp, { code: -1, stdout: '', stderr: '没配 botAppId（cli_ 开头），不知道把谁移出群' })
    }],
    ['豁免：配置 keep / bug 表群 / 「新的 Bug」会话 / 群名带 falive（不分大小写）/ 私信留下的——永不提醒；提醒过又豁免的清掉提醒', () => eachCase([
      { name: '配置 keep', config: { ...CONFIG, chatRetention: { keep: ['oc_x'] } }, reason: '配置里留着' },
      { name: 'bug 表群', config: { ...CONFIG, bugTable: { chatId: 'oc_x' } }, reason: 'bug 表的群' },
      { name: '新的 Bug 会话', config: { ...CONFIG, bugTable: { chatId: 'oc_other', watch: { notifyChatId: 'oc_x' } } }, reason: 'bug 表的群' },
      { name: 'falive 群', config: CONFIG, name2: '[FaLive] 直播', reason: 'falive 也在' },
      { name: '私信留下的', config: CONFIG, keep: true, reason: '你说留下的' },
    ], async ({ config, name2 = '某群', keep = false, reason }) => {
      const io = started({ oc_x: { warnedAt: iso(START), ...(keep ? { keep: true } : {}) } })
      const chats = new Map([['oc_x', name2]])
      assert.equal(exemptReason({ config, state: io.read(), chatId: 'oc_x', name: name2 }), reason)
      const r = await run({ io, now: START + 30 * DAY, config, chats })
      assert.deepEqual([r.sent, r.left, io.data.chats.oc_x.warnedAt], [[], [], undefined])
      assert.equal(exemptReason({ config: CONFIG, state: { chats: {} }, chatId: 'oc_y', name: '某群' }), null)
    })],
    ['群已不在列表（被移出 / 解散）：从记账里删掉；群列表读失败：整轮跳过，不动记账、不发不退；关掉：不读群列表', async () => {
      const io = started({ oc_gone: { warnedAt: iso(START) }, oc_a: { lastActiveAt: iso(START + DAY) } })
      await run({ io, now: START + 2 * DAY })
      assert.deepEqual(Object.keys(io.data.chats), ['oc_a'])
      const before = started({ oc_a: { warnedAt: iso(START) } })
      const send = spySend()
      const leave = spyLeave()
      const skipped = await runChatRetention({ config: CONFIG, now: START + 30 * DAY, io: before, listChats: async () => null, send: send.send, leave: leave.leave })
      assert.deepEqual([skipped, send.sent, leave.calls, before.data], [{ skipped: 'list failed' }, [], [], { startedAt: iso(START), chats: { oc_a: { warnedAt: iso(START) } } }])
      const off = await runChatRetention({ config: { chatRetention: { enabled: false } }, io: before, listChats: async () => assert.fail('关掉了不该读群列表') })
      assert.deepEqual(off, { skipped: 'disabled' })
    }],
    ['提醒私信没发出去：不记 warnedAt（下次再提醒，不会没说就退）', async () => {
      const io = started()
      await run({ io, now: START + 14 * DAY, send: spySend(false) })
      assert.deepEqual(io.data.chats, {})
    }],
    ['分类与「退群列表」文案：已提醒带退的时间、闲置没提醒、不退的带理由；都没有说「现在没有要退的群」', () => {
      const W = at(16, 9, 35)
      const state = { startedAt: iso(START), chats: { oc_a: { warnedAt: iso(W) }, oc_k: { keep: true } } }
      const chats = new Map([['oc_a', 'A 群'], ['oc_b', 'B 群'], ['oc_k', 'K 群'], ['oc_f', 'falive 群']])
      const plan = classifyChats({ config: CONFIG, state, chats, now: W + HOUR })
      assert.deepEqual(plan.warned, [{ chatId: 'oc_a', name: 'A 群', due: W + 48 * HOUR }])
      assert.equal(sayRetentionList({ config: CONFIG, state, chats, now: W + HOUR }), '已经提醒过、到点就退的：\n- A 群（11-18 09:35 后退）\n14 天没人 @我、下次查的时候会提醒的：\n- B 群\n不退的：\n- K 群（你说留下的）\n- falive 群（falive 也在）')
      assert.equal(sayRetentionList({ config: CONFIG, state: { startedAt: iso(W), chats: {} }, chats: new Map([['oc_b', 'B 群']]), now: W }), '现在没有要退的群。')
      assert.deepEqual(classifyChats({ config: CONFIG, state: { chats: {} }, chats: new Map([['oc_b', 'B']]), now: W }).idle, [], '没有 startedAt 不判闲置')
    }],
    ['私信指令解析：「留下 关键字」要空格或冒号、去引号；「退群列表」整句', () => eachCase([
      { text: '留下 交易页', want: { kind: 'keep', keyword: '交易页' } },
      { text: '留下：「活动」', want: { kind: 'keep', keyword: '活动' } },
      { text: '  退群列表。 ', want: { kind: 'list' } },
      { text: '留下来吧', want: null },
      { text: '留下 ', want: null },
      { text: '看下退群列表', want: null },
    ], ({ text, want }) => assert.deepEqual(parseRetentionDirective(text), want))],
    ['「留下」：一个命中标不退（清掉提醒）/ 没命中 / 多个命中让说长点；「退群列表」；只认负责人私聊；群列表读不到', async () => {
      const chats = new Map([['oc_a', 'PR-02306 交易页'], ['oc_b', '活动页群'], ['oc_c', '活动二群']])
      const io = started({ oc_a: { warnedAt: iso(START), lastActiveAt: iso(START) } })
      const say = async (text, { chatType = 'p2p', sender = ME, list = async () => chats } = {}) => {
        const send = spySend()
        const handled = await maybeHandleRetentionDirective({ msg: { messageId: 'om_1234567890123456789012345678901234567890xyz', chatType, senderOpenId: sender, text }, config: CONFIG, now: START, io, listChats: list, send: send.send })
        return { handled, sent: send.sent }
      }
      const one = await say('留下 pr-02306')
      assert.deepEqual(one, { handled: true, sent: [{ text: '好，「PR-02306 交易页」不退了。', kind: 'chat_retention', key: 'om_1234567890123456789012345678901234567890xyz-rt'.slice(0, 50) }] })
      assert.deepEqual(io.data.chats.oc_a, { lastActiveAt: iso(START), keep: true })
      assert.deepEqual((await say('留下 活动')).sent.map((s) => s.text), ['名字里带「活动」的群有 2 个：\n- 活动页群\n- 活动二群\n多给几个字，我好分清是哪个。'])
      assert.deepEqual((await say('留下 合约')).sent.map((s) => s.text), ['没找到名字里带「合约」的群。'])
      const listed = await say('退群列表')
      assert.deepEqual([listed.handled, listed.sent.map((s) => s.text)], [true, ['现在没有要退的群。\n不退的：\n- PR-02306 交易页（你说留下的）']])
      const unreadable = await say('退群列表', { list: async () => null })
      assert.deepEqual([unreadable.handled, unreadable.sent.map((s) => s.text)], [true, ['群列表这会儿读不到，过会儿再试。']])
      assert.deepEqual(await say('留下 活动', { chatType: 'group' }), { handled: false, sent: [] })
      assert.deepEqual(await say('留下 活动', { sender: 'ou_other' }), { handled: false, sent: [] })
      assert.deepEqual(await say('发日报'), { handled: false, sent: [] })
      const fresh = memIo()
      await maybeHandleRetentionDirective({ msg: { messageId: 'om_k', chatType: 'p2p', senderOpenId: ME, text: '留下 交易' }, config: CONFIG, now: START, io: fresh, listChats: async () => chats, send: spySend().send })
      assert.deepEqual(fresh.data, { startedAt: iso(START), chats: { oc_a: { keep: true } } }, '标留下也从这一刻起算时钟')
    }],
    ['记活跃：只记群（私聊 / 非 oc_ 不记）；startedAt 没有就补；写坏了不抛给调用方', () => {
      const io = memIo()
      assert.equal(recordChatActivity({ chatId: 'oc_dm', chatType: 'p2p', now: START, io }), false)
      assert.equal(recordChatActivity({ chatId: 'ou_me', chatType: 'group', now: START, io }), false)
      assert.equal(recordChatActivity({ chatType: 'group', now: START, io }), false)
      assert.deepEqual(io.data, { chats: {} })
      assert.equal(recordChatActivity({ chatId: 'oc_g', chatType: 'group', now: START, io }), true)
      assert.deepEqual(io.data, { startedAt: iso(START), chats: { oc_g: { lastActiveAt: iso(START) } } })
      const broken = { read: () => ({ chats: {} }), write: () => { throw new Error('disk full') } }
      const warned = []
      const { warn } = console
      console.warn = (line) => warned.push(line)
      try {
        assert.equal(recordChatActivity({ chatId: 'oc_g', chatType: 'group', now: START, io: broken }), false)
      } finally {
        console.warn = warn
      }
      assert.match(warned[0], /群活跃记账失败（oc_g）：disk full/)
      const state = { startedAt: 'x', chats: {} }
      assert.equal(ensureStarted(state, START).startedAt, 'x', '已有不覆盖')
      assert.equal(updateActivity(() => false, { read: () => ({ chats: {} }), write: () => assert.fail('没改不写') }).chats instanceof Object, true)
    }],
    ['文件读写：默认落在运行态目录的 -state.json；没有 / 读坏 / chats 形状不对都当空表；单测没指运行态目录不落盘', () => {
      const path = join(process.env.LARK_RUNTIME_DIR, CHAT_ACTIVITY_FILE)
      assert.ok(CHAT_ACTIVITY_FILE.endsWith('-state.json'), '名字以 -state.json 结尾，不进源码版本哈希')
      assert.deepEqual(fileActivityIo().read(), { chats: {} })
      recordChatActivity({ chatId: 'oc_f', chatType: 'group', now: START })
      assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { startedAt: iso(START), chats: { oc_f: { lastActiveAt: iso(START) } } })
      assert.deepEqual(fileActivityIo().read().chats, { oc_f: { lastActiveAt: iso(START) } })
      writeFileSync(path, '{坏了')
      assert.deepEqual(fileActivityIo().read(), { chats: {} })
      writeFileSync(path, JSON.stringify({ startedAt: 'x', chats: ['oc_a'] }))
      assert.deepEqual(fileActivityIo().read(), { startedAt: 'x', chats: {} })
      writeFileSync(path, 'null')
      assert.deepEqual(fileActivityIo().read(), { chats: {} })
      rmSync(path)
      const saved = process.env.LARK_RUNTIME_DIR
      delete process.env.LARK_RUNTIME_DIR
      try {
        recordChatActivity({ chatId: 'oc_f', chatType: 'group', now: START })
        assert.deepEqual(fileActivityIo().read(), { chats: {} })
      } finally {
        process.env.LARK_RUNTIME_DIR = saved
      }
      assert.equal(existsSync(path), false, '单测没指运行态目录不往真运行态写')
    }],
    ['定时器：没到点不跑、正好到点跑；今天跑成功过不再跑；读群失败隔 30 分钟再试；上一轮没跑完不叠；上线记 startedAt 一次；关掉不起', async () => {
      let now = at(16, 9, 34)
      const io = memIo()
      const runs = []
      let release = null
      const fakeRun = async ({ now: n, io: runIo }) => {
        runs.push(n)
        if (release === 'hold') await new Promise((resolve) => { release = resolve })
        return { ok: true, io: runIo === io }
      }
      const timer = startChatRetention({ config: CONFIG, run: fakeRun, io, clock: () => now, intervalMs: 3_600_000 })
      timer.stop()
      assert.equal(io.data.startedAt, iso(at(16, 9, 34)), '上线即起算')
      assert.equal(await timer.tick(), null, '09:34 没到点')
      now = at(16, 9, 35)
      assert.deepEqual(await timer.tick(), { ok: true, io: true })
      now += RETRY_GAP_MS - 1
      assert.equal(await timer.tick(), null, '上次尝试不满 30 分钟')
      now += 1
      assert.deepEqual(await timer.tick(), { ok: true, io: true }, '没记 lastRunDate（读群失败）就隔 30 分钟再试')
      io.write({ ...io.read(), lastRunDate: '2026-11-16' })
      now += RETRY_GAP_MS
      assert.equal(await timer.tick(), null, '今天跑过了')
      now = at(17, 9, 35)
      release = 'hold'
      const first = timer.tick()
      await new Promise((resolve) => setImmediate(resolve))
      now += RETRY_GAP_MS
      assert.equal(await timer.tick(), null, '上一轮还在跑')
      release()
      await first
      assert.equal(runs.length, 3)
      const again = startChatRetention({ config: CONFIG, run: fakeRun, io, clock: () => at(20, 9, 0) })
      again.stop()
      assert.equal(io.data.startedAt, iso(at(16, 9, 34)), '已经起算过不重置')
      const offIo = memIo()
      const off = startChatRetention({ config: { chatRetention: { enabled: false } }, run: () => assert.fail('关掉了'), io: offIo, clock: () => at(16, 10) })
      off.stop()
      assert.deepEqual([await off.tick(), offIo.data], [null, { chats: {} }])
      const boom = startChatRetention({ config: CONFIG, run: async () => { throw new Error('炸了') }, io: memIo(), clock: () => at(16, 10) })
      boom.stop()
      assert.equal(await quiet(() => boom.tick()), null, '巡检异常不抛出定时器')
    }],
    ['出口：bot 在群里回了任务就记一笔活跃；私聊的不记', async () => {
      const path = join(process.env.LARK_RUNTIME_DIR, CHAT_ACTIVITY_FILE)
      const deps = { replyMarkdown: async () => ({ ok: true, messageId: 'om_r', via: 'reply' }), sendMarkdown: async () => ({ ok: true, messageId: 'om_s' }) }
      const store = { recordReceipt: () => {} }
      await quiet(() => sendReply({ store, task: { id: 't1', chatId: 'oc_dm', chatType: 'p2p', messageId: 'om_1', operator: 'ou_q' }, phase: 'done', text: '私聊里说一句', deps }))
      assert.equal(existsSync(path), false)
      const sent = await quiet(() => sendReply({ store, task: { id: 't2', chatId: 'oc_grp', chatType: 'group', messageId: 'om_2', operator: 'ou_q' }, phase: 'done', text: '群里说一句', deps }))
      assert.equal(sent.ok, true)
      assert.ok(fileActivityIo().read().chats.oc_grp.lastActiveAt, '群里回过任务记了活跃')
    }],
  ]))
})
