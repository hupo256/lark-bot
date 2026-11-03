/**
 * 网关侧收口（11-01 对话层）：摄入全链路（真 store + 假 lark-cli）、上下文包、「收到」挂起 / 到点兜底 / 话题补充、负责人私信主通道、
 * 分类落地出口、入群事件、挂起催办、每日汇总。一个 it 合并全部段（测试棘轮）；每段翻转一处条件给变异扫描用。
 * LARK_RUNTIME_DIR / LARK_CLI_BIN 在模块加载时读，所以本文件先设环境再动态 import（同 lark-port-batch3.test）。
 */
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { eachCase, runSteps, waitUntil } from './support/steps.mjs'

const root = mkdtempSync(join(tmpdir(), 'lark-intake-flow-'))
const runtime = join(root, 'runtime')
// 假 lark-cli：只会答 +messages-mget（被引用消息），其它一律失败（群名 / 话题 / 最近消息 / 下载 / 发送都退成空）。
const refMessage = JSON.stringify({ ok: true, data: { messages: [{ message_id: 'om_ref', msg_type: 'text', content: JSON.stringify({ text: '登录页报错了' }), sender: { sender_type: 'user', id: 'ou_w', name: '小王' }, create_time: '2026-11-01 09:00' }] } })
const cliBin = join(root, 'lark-cli')
writeFileSync(cliBin, `#!/bin/sh\ncase "$*" in\n  *"+messages-mget"*) printf '%s\\n' '${refMessage}'; exit 0;;\nesac\nexit 1\n`)
chmodSync(cliBin, 0o755)
process.env.LARK_CLI_BIN = cliBin
process.env.LARK_RUNTIME_DIR = runtime

const { ACK_SWEEP_EVERY_MS, DEFAULT_ACK_TIMEOUT_MS, appendSuspectedSupplement, deliverFollowUpReply, flushPendingAck, holdsSuspectedForPrincipal, intakeTiming, isCompleteMessage, markAckPending, mergeThreadSupplement, pickSupplementTarget, resolveIntakeLane, resolveIntakeNotBefore, sweepPendingAcks } = await import('../lib/lark-intake-ack.mjs')
const { DEFAULT_PRINCIPAL_REPLY_WINDOW_MS, anchorHead, buildPrincipalInstructionTask, decidePrincipalAction, isDeployNotice, isReleaseHeldReply, isShortDeictic, latestDmReceipt, maybeHandlePrincipalChannel, resolvePrincipalAnchor } = await import('../lib/lark-principal-channel.mjs')
const { RERUN_ACK_REPLY, handleIntakeResolution, mergeableTarget, resolveMergeTarget } = await import('../lib/lark-routes-intake.mjs')
const { buildConversationBundle } = await import('../lib/lark-conversation-bundle.mjs')
const { ingestLarkEvent } = await import('../lib/lark-ingest.mjs')
const { handleBotAddedEvent, parseBotAddedEvent } = await import('../lib/lark-project-chat-sync.mjs')
const { defaultRemindAfterMs, defaultRemindRounds, isNeverNagged, remindParkedTasks } = await import('../lib/lark-parked-reminder.mjs')
const { collectDigest, expireSuspectedAndNotify, renderDigest, runDailyDigest, startDailyDigest } = await import('../lib/lark-daily-digest.mjs')
const { createTaskStore, isControlActiveStatus } = await import('../lib/lark-task-store.mjs')
const { getObligation, noteAck, noteAnswer, noteHeld } = await import('../lib/lark-reply-obligation.mjs')
const { localHHMM } = await import('../lib/lark-outbox.mjs')

const H = 3_600_000
const iso = (ms) => new Date(ms).toISOString()
const pad2 = (n) => String(n).padStart(2, '0')
const config = { project: 'PR-01947', botOpenId: 'ou_bot', botAppId: 'cli_x', allowedChatIds: ['oc_g'], allowedOpenIds: ['ou_aven'], notifyOpenId: 'ou_aven', taskMentionOpenIds: ['ou_aven'] }
const BOT = { id: 'ou_bot', name: 'Aven.Bot', key: '@_user_1' }
const AVEN = { id: 'ou_aven', name: 'aven', key: '@_user_2' }
// lark-cli 拍平的消息事件
const event = (id, text, { chatId = 'oc_g', chatType = 'group', sender = 'ou_qa', mentions = [], ...rest } = {}) =>
  ({ message_id: id, chat_id: chatId, chat_type: chatType, sender_type: 'user', sender_id: sender, message_type: 'text', content: text, mentions, ...rest })
const atBot = (id, text, extra = {}) => event(id, `@Aven.Bot ${text}`.trim(), { mentions: [BOT], ...extra })
// 私信的 chat_id 和生产一样是 oc_（p2p 会话），不是负责人的 open_id（11-02 复核：原来写成 ou_aven 把主通道 recent 锚定对不上 oc_ 的缺口盖住了）
const dm = (id, text, extra = {}) => event(id, text, { chatId: 'oc_p2p', chatType: 'p2p', sender: 'ou_aven', ...extra })
// 内存版任务库（只要 get / list / listActiveByThread 的纯函数段用）
const memStore = (tasks) => ({
  get: (id) => tasks.find((task) => task.id === id),
  list: () => [...tasks],
  listActiveByThread: (threadRootId, { excludeId } = {}) => tasks.filter((task) => task.id !== excludeId && task.threadRootId === threadRootId && isControlActiveStatus(task.status)),
})
const original = { log: console.log, warn: console.warn, error: console.error }

describe('网关侧收口：摄入、上下文包、收到、主通道、分类落地、入群、催办、汇总', () => {
  let dir
  let store
  let logs
  let errors
  it('ingest / conversation-bundle / intake-ack / principal-channel / routes-intake / project-chat-sync / parked-reminder / daily-digest', () => runSteps([
    ['intake-ack 纯函数：默认超时、分道、完整件、notBefore', () => {
      assert.equal(DEFAULT_ACK_TIMEOUT_MS, 45_000)
      assert.equal(ACK_SWEEP_EVERY_MS, 15_000)
      assert.deepEqual(intakeTiming(undefined), { fastLaneMs: 0, quietGapMs: 60_000, maxWaitMs: 180_000 })
      assert.deepEqual(intakeTiming({ intake: { quietGapMs: 5 } }), { fastLaneMs: 0, quietGapMs: 5, maxWaitMs: 180_000 })
      assert.deepEqual([{ addressedToBot: true }, { fromPrincipal: true }, { quotedOwnCard: true }, {}, null].map((task) => resolveIntakeLane({ task })), ['fast', 'fast', 'fast', 'slow', 'slow'])
      const now = Date.parse('2026-11-01T10:00:00.000Z')
      const intake = { fastLaneMs: 1000, quietGapMs: 60_000, maxWaitMs: 180_000 }
      assert.equal(resolveIntakeNotBefore({ lane: 'fast', now, intake }), iso(now + 1000))
      assert.equal(resolveIntakeNotBefore({ lane: 'slow', complete: true, now, intake }), iso(now + 1000), '完整件不等')
      assert.equal(resolveIntakeNotBefore({ lane: 'slow', now, intake, firstReceivedAt: iso(now) }), iso(now + 60_000))
      assert.equal(resolveIntakeNotBefore({ lane: 'slow', now, intake, firstReceivedAt: iso(now - 170_000) }), iso(now + 10_000), '最多等到首条 + maxWait')
      assert.equal(resolveIntakeNotBefore({ lane: 'slow', now, intake }), iso(now + 60_000), '没有首条时刻按现在算')
      assert.equal(resolveIntakeNotBefore({ lane: 'slow', now, intake, firstReceivedAt: iso(now - 400_000) }), iso(now), '超过最长等待也不早于现在')
      return eachCase([
        { name: '文档附件 + 短正文 → 完整', input: { msg: { text: '短', attachments: [{ type: 'file', fileName: 'prd.md' }] } }, want: true },
        { name: '图片不算文档', input: { msg: { text: '短', attachments: [{ type: 'image', imageKey: 'img' }] } }, want: false },
        { name: '长正文 → 完整', input: { msg: { text: 'x'.repeat(200) } }, want: true },
        { name: '差一个字不算', input: { msg: { text: 'x'.repeat(199) } }, want: false },
        { name: '恰好 minChars', input: { msg: { text: 'abcdefghij', attachments: [] }, minChars: 10 }, want: true },
        { name: '空消息', input: { msg: {}, minChars: 5 }, want: false },
        { name: '没 msg', input: { msg: null }, want: false },
      ], ({ input, want }) => assert.equal(isCompleteMessage(input), want))
    }],
    ['markAckPending / sweepPendingAcks / flushPendingAck', async () => {
      const now = Date.now()
      const live = store.upsert({ id: 'om_a', status: 'received', ackedInGroup: true, createdAt: iso(now) })
      assert.equal(markAckPending({ store, task: { id: 'om_a', ackedInGroup: false }, now }), live, '按 store 里的活对象判，回过「收到」的不再挂')
      assert.equal(store.get('om_a').ackPending, undefined)
      const fresh = markAckPending({ store, task: { id: 'om_new', status: 'received' }, now, timeoutMs: 30_000 })
      assert.deepEqual(fresh.ackPending, { at: iso(now), deadline: iso(now + 30_000) })
      assert.equal(store.get('om_new'), fresh, '不在库里的任务也能挂，并落库')
      assert.equal(markAckPending({ store, task: fresh, now: now + 5 }).ackPending.at, iso(now), '已挂的不重挂')
      const deliveries = []
      const deliver = async ({ task, reply }) => { deliveries.push([task.id, reply]); return { ok: true } }
      store.upsert({ id: 'om_due', status: 'received', ackPending: { at: iso(now - 10_000), deadline: iso(now - 1) }, createdAt: iso(now) })
      store.upsert({ id: 'om_edge', status: 'received', ackPending: { at: iso(now - 60_000), deadline: iso(now) }, createdAt: iso(now) })
      store.upsert({ id: 'om_fallback', status: 'received', ackPending: { at: iso(now - 50_000) }, createdAt: iso(now) }) // 没 deadline：at + 45s
      store.upsert({ id: 'om_later', status: 'received', ackPending: { at: iso(now), deadline: iso(now + 30_000) }, createdAt: iso(now) })
      store.upsert({ id: 'om_bad', status: 'received', ackPending: { at: 'garbage' }, createdAt: iso(now) })
      store.upsert({ id: 'om_none', status: 'received', createdAt: iso(now) })
      // 11-03 R2：到点前任务已被关掉 / 判完（superseded / ignored / answered / intake_failed）——「收到」只撤不发，不再给已取消的任务说「稍后回你」
      for (const [id, status] of [['om_closed', 'superseded'], ['om_ign', 'ignored'], ['om_ans', 'answered'], ['om_if', 'intake_failed']]) store.upsert({ id, status, ackPending: { at: iso(now - 50_000), deadline: iso(now - 1) }, createdAt: iso(now) })
      assert.equal(await sweepPendingAcks({ config, store, now, deliver }), 3)
      assert.deepEqual(deliveries.map(([id]) => id).sort(), ['om_due', 'om_edge', 'om_fallback'])
      for (const id of ['om_due', 'om_edge', 'om_fallback']) assert.deepEqual([store.get(id).ackPending, store.get(id).ackedInGroup], [null, true], id)
      for (const id of ['om_closed', 'om_ign', 'om_ans', 'om_if']) assert.deepEqual([store.get(id).ackPending, store.get(id).ackedInGroup], [null, undefined], `${id}：撤掉、没发、不算回过`)
      assert.equal(store.get('om_later').ackPending.deadline, iso(now + 30_000))
      assert.equal(await sweepPendingAcks({ config, store, now, deliver }), 0, '发过的不再到点')
      const t = store.upsert({ id: 'om_f', status: 'received', chatId: 'oc_g', ackPending: { at: iso(now), deadline: iso(now + 45_000) }, createdAt: iso(now) })
      deliveries.length = 0
      assert.deepEqual(await flushPendingAck({ config, store, task: t, reply: ' 能发，我看下 ', deliver }), { sent: true, usedReply: true })
      assert.deepEqual(deliveries, [['om_f', '能发，我看下']])
      assert.deepEqual([t.ackPending, t.ackedInGroup, t.ackReply, store.get('om_f').ackReply, 'ackCoalesced' in t], [null, true, '能发，我看下', '能发，我看下', false])
      assert.deepEqual(await flushPendingAck({ config, store, task: t, reply: 'x', deliver }), { sent: false, usedReply: false }, '已撤掉的不再发')
      assert.equal(deliveries.length, 1)
      const fixed = store.upsert({ id: 'om_fx', status: 'received', ackPending: { at: iso(now) }, createdAt: iso(now) })
      assert.deepEqual(await flushPendingAck({ config, store, task: fixed, deliver }), { sent: true, usedReply: false })
      assert.deepEqual([deliveries.at(-1), 'ackReply' in fixed, fixed.ackedInGroup], [['om_fx', null], false, true])
      const gated = store.upsert({ id: 'om_g', status: 'received', ackPending: { at: iso(now) }, createdAt: iso(now) })
      assert.deepEqual(await flushPendingAck({ config, store, task: gated, reply: 'r', deliver: async () => ({ ok: false, gated: true }) }), { sent: false, usedReply: false })
      assert.deepEqual([gated.ackedInGroup, gated.ackCoalesced, 'ackReply' in gated], [true, true, false], '闸拦下的也算回过')
      const failed = store.upsert({ id: 'om_fail', status: 'received', ackPending: { at: iso(now) }, createdAt: iso(now) })
      assert.deepEqual(await flushPendingAck({ config, store, task: failed, reply: 'r', deliver: async () => ({ ok: false, reason: 'x' }) }), { sent: false, usedReply: false })
      assert.deepEqual([failed.ackPending, failed.ackedInGroup], [null, undefined])
      const silent = store.upsert({ id: 'om_s', status: 'received', ackPending: { at: iso(now) }, createdAt: iso(now) })
      assert.deepEqual(await flushPendingAck({ config, store, task: silent, send: false, deliver }), { sent: false, usedReply: false })
      assert.deepEqual([silent.ackPending, deliveries.length], [null, 2])
      assert.deepEqual(await flushPendingAck({ config, store, task: null, deliver }), { sent: false, usedReply: false })
      // 「收到」已发过 / 被拦后单独回的那句：自答走 self_answer、追问走 ask_back（11-03 R11：按消息去重——两个人问同样的问题各自要得到答复——不按内容 24h、不按人 2 分钟拦）；空的不发
      const sends = []
      const send = async (args) => { sends.push(args); return { ok: true, messageId: 'om_x', gated: false, reason: null } }
      const ft = { id: 'om_f', epoch: 1, chatId: 'oc_g' }
      assert.deepEqual(await deliverFollowUpReply({ config, store, task: ft, text: ' 能发 ', send }), { ok: true, messageId: 'om_x', gated: false, reason: null })
      assert.deepEqual(await deliverFollowUpReply({ config, store, task: ft, text: '哪个环境？', kind: 'ask_back', send }), { ok: true, messageId: 'om_x', gated: false, reason: null })
      assert.deepEqual(sends, [
        { config, store, task: ft, phase: 'self_answer', text: '能发', idempotencyKey: 'om_f-e1-ans' },
        { config, store, task: ft, phase: 'ask_back', text: '哪个环境？', idempotencyKey: 'om_f-e1-askb' },
      ])
      assert.deepEqual(await deliverFollowUpReply({ config, store, task: ft, text: '  ', send }), { ok: false, gated: false, reason: 'empty follow-up' })
      assert.equal(sends.length, 2)
    }],
    ['pickSupplementTarget：同话题 / 回复同一条；或同人同群安静期内的主楼连发（只认还没分类的）', () => {
      const now = Date.parse('2026-11-01T10:00:00.000Z')
      const gap = 60_000
      const t = (id, extra = {}) => ({ id, status: 'received', chatId: 'oc_g', operator: 'ou_qa', intake: { required: true, receivedAt: iso(now - 10_000) }, createdAt: iso(now - 10_000), ...extra })
      const plain = { messageId: 'om_in', chatId: 'oc_g', senderOpenId: 'ou_qa' }
      return eachCase([
        { name: '空库 → 严格 null', tasks: [], want: null },
        { name: '同人同群安静期内的主楼消息 → 并入', tasks: [t('om_a')], want: 'om_a' },
        { name: '在跑的不并', tasks: [t('om_a', { status: 'running' })], want: null },
        { name: '已不要求分类的（required=false）不并', tasks: [t('om_a', { intake: { required: false, receivedAt: iso(now - 10_000) } })], want: null },
        { name: '本条自己不并', tasks: [t('om_in')], want: null },
        { name: '目标在话题里的不按同人连发并', tasks: [t('om_a', { threadRootId: 'om_x' })], want: null },
        { name: '已了结的不并', tasks: [t('om_a', { status: 'done' })], want: null },
        { name: '别的群不并', tasks: [t('om_a', { chatId: 'oc_other' })], want: null },
        { name: '别人的不并', tasks: [t('om_a', { operator: 'ou_b' })], want: null },
        { name: '按收到时刻算安静期（建任务时刻更早也行）', tasks: [t('om_a', { intake: { required: true, receivedAt: iso(now - 10_000) }, createdAt: iso(now - 2 * H) })], want: 'om_a' },
        { name: '没收到时刻用建任务时刻', tasks: [t('om_a', { intake: { required: true }, createdAt: iso(now - 10_000) })], want: 'om_a' },
        { name: '恰好到安静期 → 不并', tasks: [t('om_a', { intake: { required: true, receivedAt: iso(now - gap) } })], want: null },
        { name: '多条取最新的', tasks: [t('om_1', { createdAt: iso(now - 30_000) }), t('om_2', { createdAt: iso(now - 20_000) })], want: 'om_2' },
        { name: '同一时刻取后登记的', tasks: [t('om_1'), t('om_2')], want: 'om_2' },
        { name: '回复某条 → 那条（哪怕在别的群、别人的）', tasks: [t('om_root', { chatId: 'oc_other', operator: 'ou_b' })], msg: { ...plain, replyTo: 'om_root' }, want: 'om_root' },
        { name: '话题根已了结但话题里有未分类的兄弟 → 兄弟', tasks: [t('om_root', { status: 'done' }), t('om_sib', { threadRootId: 'om_root' })], msg: { ...plain, threadRootId: 'om_root' }, want: 'om_sib' },
        { name: '话题里没有 → null（不回落到同人连发）', tasks: [t('om_a')], msg: { ...plain, threadRootId: 'om_root' }, want: null },
        { name: '话题根本身还没分类 → 话题根', tasks: [t('om_root')], msg: { ...plain, threadRootId: 'om_root' }, want: 'om_root' },
      ], ({ tasks, msg = plain, want }) => {
        const found = pickSupplementTarget({ msg, store: memStore(tasks), now, quietGapMs: gap })
        assert.equal(found, want === null ? null : tasks.find((task) => task.id === want))
      })
    }],
    ['mergeThreadSupplement / holdsSuspectedForPrincipal / appendSuspectedSupplement', async () => {
      const now = Date.now()
      const t = store.upsert({ id: 'om_t', status: 'received', chatId: 'oc_g', operator: 'ou_qa', text: 'orig', project: 'PR-X', attachments: [{ type: 'image', imageKey: 'img_old' }], intake: { required: true, lane: 'slow', receivedAt: iso(now) }, createdAt: iso(now) })
      const downloads = []
      const download = async (args) => { downloads.push(args); return args.attachments.map((item) => ({ ...item, localPath: '/tmp/x' })) }
      const msg = (extra = {}) => ({ messageId: 'om_m', chatId: 'oc_g', senderOpenId: 'ou_qa', senderType: 'user', text: ' add ', attachments: [], ...extra })
      assert.equal(await mergeThreadSupplement({ msg: msg({ senderType: 'bot' }), config, store, download }), false)
      assert.equal(await mergeThreadSupplement({ msg: msg({ text: ' ' }), config, store, download }), false, '没正文没附件不并')
      assert.equal(await mergeThreadSupplement({ msg: msg({ chatId: 'oc_other' }), config, store, download }), false, '没目标')
      assert.equal(store.get('om_t').text, 'orig')
      assert.equal(await mergeThreadSupplement({ msg: msg(), config, store, download }), true)
      assert.match(t.text, /^orig\n\n【话题补充 \d{2}:\d{2}】add$/)
      assert.deepEqual([t.addressedToBot, t.ackPending, t.intake.lane, downloads.length], [undefined, undefined, 'slow', 0])
      assert.ok(Date.parse(t.intake.notBefore) - now >= 59_000, '慢道：重新按安静期算')
      assert.equal(await mergeThreadSupplement({ msg: msg({ messageId: 'om_m2', text: '', attachments: [{ type: 'image', imageKey: 'img_new' }] }), config, store, addressedToBot: true, download }), true)
      assert.match(t.text, /【话题补充 \d{2}:\d{2}】（附件）$/)
      assert.deepEqual(downloads, [{ project: 'PR-X', messageId: 'om_m2', attachments: [{ type: 'image', imageKey: 'img_new' }] }])
      assert.deepEqual(t.attachments.map((a) => a.imageKey), ['img_old', 'img_new'])
      assert.deepEqual([t.addressedToBot, t.fromPrincipal, t.intake.lane, Boolean(t.ackPending)], [true, undefined, 'fast', true], '补充里叫了 bot：升级目标、转快道、挂「收到」')
      assert.ok(Date.parse(t.intake.notBefore) - now < 5_000, '快道不等')
      const mine = store.upsert({ id: 'om_t2', status: 'received', chatId: 'oc_g', operator: 'ou_aven', text: '', ackedInGroup: true, intake: { required: true, lane: 'slow', receivedAt: iso(now) }, createdAt: iso(now) })
      assert.equal(await mergeThreadSupplement({ msg: msg({ messageId: 'om_m3', senderOpenId: 'ou_aven', text: 'x' }), config, store, addressedToBot: true, download }), true)
      assert.deepEqual([mine.fromPrincipal, mine.ackPending, mine.text.startsWith('【话题补充')], [true, undefined, true], '负责人补充：fromPrincipal；回过「收到」的不再挂')
      // 调用方已锚到目标（回复了「收到」，11-02 复核）：按话题 / 同人找不到也并进指定的那条
      const anchored = store.upsert({ id: 'om_t3', status: 'received', chatId: 'oc_far', operator: 'ou_other', text: 'far', intake: { required: true, lane: 'slow', receivedAt: iso(now) }, createdAt: iso(now) })
      assert.equal(await mergeThreadSupplement({ msg: msg({ messageId: 'om_m4', chatId: 'oc_far', senderOpenId: 'ou_zz', text: 'Safari 也复现' }), config, store, download }), false, '没指定目标：别人的任务找不到')
      assert.equal(await mergeThreadSupplement({ msg: msg({ messageId: 'om_m4', chatId: 'oc_far', senderOpenId: 'ou_zz', text: 'Safari 也复现' }), config, store, target: anchored, download }), true)
      assert.match(anchored.text, /^far\n\n【话题补充 \d{2}:\d{2}】Safari 也复现$/)
      await eachCase([
        { name: '疑似 + 挂起 + 不是负责人 → 扣住', task: { suspected: true, status: 'waiting_confirmation' }, operator: 'ou_qa', want: true },
        { name: '已不挂起', task: { suspected: true, status: 'done' }, operator: 'ou_qa', want: false },
        { name: '负责人本人', task: { suspected: true, status: 'waiting_confirmation' }, operator: 'ou_aven', want: false },
        { name: '不是疑似', task: { status: 'waiting_confirmation' }, operator: 'ou_qa', want: false },
        { name: '没任务', task: null, operator: 'ou_qa', want: false },
      ], ({ task, operator, want }) => assert.equal(holdsSuspectedForPrincipal({ task, operator, config }), want))
      const sus = store.upsert({ id: 'om_sus', status: 'waiting_confirmation', suspected: true, text: 'orig', attachments: [{ type: 'image', imageKey: 'a' }], suspectedSupplements: [{ operator: 'ou_x', at: 'before' }], createdAt: iso(now) })
      const at = new Date('2026-11-01T02:03:00.000Z')
      const out = appendSuspectedSupplement({ store, task: sus, supplementText: ' hi ', supplementAttachments: [{ type: 'image', imageKey: 'b' }], operator: 'ou_qa', now: at })
      assert.equal(out.text, `orig\n\n【补充 ${localHHMM(at)}，待负责人放行】hi`)
      assert.deepEqual(out.attachments.map((a) => a.imageKey), ['a', 'b'])
      assert.deepEqual(out.suspectedSupplements, [{ operator: 'ou_x', at: 'before' }, { operator: 'ou_qa', at: at.toISOString() }])
      assert.equal(store.get('om_sus'), out)
      const bare = appendSuspectedSupplement({ store, task: { id: 'om_sus2', text: '' }, now: at })
      assert.deepEqual([bare.text, bare.attachments, bare.suspectedSupplements.length], [`【补充 ${localHHMM(at)}，待负责人放行】（附件）`, [], 1])
    }],
    ['principal-channel 纯函数：latestDmReceipt / anchorHead / isShortDeictic / isReleaseHeldReply / isDeployNotice / buildPrincipalInstructionTask', () => {
      const T1 = '2026-11-01T01:00:00.000Z'
      const T2 = '2026-11-01T02:00:00.000Z'
      assert.equal(latestDmReceipt({ receipts: [] }, 'ou_aven'), null)
      assert.equal(latestDmReceipt(null, 'ou_aven'), null)
      assert.deepEqual(latestDmReceipt({ receipts: [{ chatId: 'oc_g', kind: 'ack', createdAt: T2 }, { chatId: 'ou_aven', kind: 'suspected', createdAt: T1 }] }, 'ou_aven'), { at: Date.parse(T1), kind: 'suspected' }, '群里的回执不算私信')
      assert.deepEqual(latestDmReceipt({ receipts: [{ chatId: 'ou_aven', kind: 'start', createdAt: T1 }, { chatId: 'ou_aven', kind: 'done', createdAt: T2 }] }, 'ou_aven'), { at: Date.parse(T2), kind: 'done' })
      assert.deepEqual(latestDmReceipt({ receipts: [{ chatId: 'ou_aven', kind: 'a', createdAt: T1 }, { chatId: 'ou_aven', kind: 'b', createdAt: T1 }] }, 'ou_aven'), { at: Date.parse(T1), kind: 'a' }, '同一时刻取先登记的')
      assert.equal(latestDmReceipt({ receipts: [{ chatId: 'ou_aven', kind: 'x', createdAt: 'bad' }] }, 'ou_aven'), null, '时间解析不了的不算')
      // 11-02 复核：私信通知按 open_id 发、回执记 ou_，他回过来的 p2p 消息 chat_id 是 oc_：两种 id 都算这个会话；群里的仍不算；没 chatId 的老回执不算
      assert.deepEqual(latestDmReceipt({ receipts: [{ chatId: 'oc_g', kind: 'ack', createdAt: T2 }, { chatId: 'ou_aven', kind: 'suspected', createdAt: T1 }] }, 'oc_p2p', 'ou_aven'), { at: Date.parse(T1), kind: 'suspected' }, 'ou_ 回执按负责人 open_id 认')
      assert.deepEqual(latestDmReceipt({ receipts: [{ chatId: 'oc_p2p', kind: 'held', createdAt: T2 }, { chatId: 'ou_aven', kind: 'suspected', createdAt: T1 }] }, 'oc_p2p', 'ou_aven'), { at: Date.parse(T2), kind: 'held' }, 'oc_ 回执按本次私信 chat_id 认，两种混着取最近')
      assert.equal(latestDmReceipt({ receipts: [{ chatId: 'ou_aven', kind: 'suspected', createdAt: T1 }, { kind: 'old', createdAt: T2 }] }, 'oc_p2p'), null, '没给 open_id 只认 chat_id；没 chatId 的老回执不算')
      assert.equal(latestDmReceipt({ receipts: [{ chatId: 'oc_g', kind: 'ack', createdAt: T1 }] }, 'oc_p2p', 'ou_aven'), null, '群里的回执不算')
      assert.equal(anchorHead({ summary: '【引用】登录页报错\n第二行', text: 'T' }), '登录页报错')
      assert.equal(anchorHead({ text: '\n  只有正文  \n' }), '只有正文')
      assert.equal(anchorHead({ summary: 'x'.repeat(60) }, 10), 'x'.repeat(10))
      assert.equal(anchorHead(null), '')
      assert.deepEqual(['waiting_confirmation', 'blocked', 'done', undefined].map((status) => decidePrincipalAction(status ? { status } : null)), ['resume', 'resume', 'instruct', 'instruct'])
      const anchor = { id: 'om_g1', status: 'done', chatId: 'oc_g', messageId: 'om_g1', replyTarget: { messageId: 'om_g1', inThread: false }, threadRootId: 'omt_1', operator: 'ou_qa', project: 'PR-X', projectTitle: '跟单', chatName: '跟单群', text: '群里原话', summary: '【引用】群里原话', attachments: [{ type: 'image', imageKey: 'g' }], aiExecutor: 'codex', intake: { classification: { decision: 'ignore', reason: '只是通知' } } }
      const at = new Date('2026-11-01T03:00:00.000Z')
      const task = buildPrincipalInstructionTask({ msg: { messageId: 'om_p', chatId: 'oc_p2p', senderOpenId: 'ou_aven', text: ' 这个要做 ' }, anchor, attachments: [{ type: 'image', imageKey: 'p' }], commandType: 'fix', commandTypeSource: 'explicit', now: at })
      assert.deepEqual(task, {
        id: 'om_p', source: 'lark', chatId: 'oc_g', messageId: 'om_p', replyTarget: { messageId: 'om_g1', inThread: false }, threadRootId: 'omt_1', operator: 'ou_qa', project: 'PR-X', commandType: 'fix', commandTypeSource: 'explicit', projectTitle: '跟单', chatName: '跟单群',
        text: '【aven 私聊指示】这个要做\n\n【指示针对的群消息（任务 om_g1，当前 done，之前判定 ignore：只是通知）】\n群里原话',
        summary: '群里原话', attachments: [{ type: 'image', imageKey: 'p' }, { type: 'image', imageKey: 'g' }], aiExecutor: 'codex', status: 'received',
        intake: { required: true, trigger: 'principal_private', mentionedOpenIds: [], lane: 'fast', notBefore: null, receivedAt: at.toISOString() },
        addressedToBot: true, fromPrincipal: true, privateOrigin: { chatId: 'oc_p2p', senderOpenId: 'ou_aven', anchorId: 'om_g1', anchorHead: '群里原话' }, createdAt: at.toISOString(),
      })
      const bare = buildPrincipalInstructionTask({ msg: { messageId: 'om_p2', chatId: 'oc_p2p', senderOpenId: 'ou_aven', text: '' }, anchor: { id: 'om_g2', status: 'waiting_confirmation', chatId: 'oc_g', messageId: 'om_g2', operator: 'ou_qa', text: '' }, now: at })
      assert.deepEqual([bare.text, bare.summary, bare.replyTarget, bare.threadRootId, bare.project, bare.projectTitle, bare.attachments, bare.aiExecutor, bare.commandType, bare.commandTypeSource],
        ['【aven 私聊指示】（附件）\n\n【指示针对的群消息（任务 om_g2，当前 waiting_confirmation）】\n', '（附件）', { messageId: 'om_g2', inThread: false }, null, null, null, [], 'claude', null, null])
      return eachCase([
        { name: '短指代句', fn: isShortDeictic, text: '重跑', want: true },
        { name: '去掉 @ 名字再判', fn: isShortDeictic, text: '@Aven.Bot 这个再看看', want: true },
        { name: '没指代词', fn: isShortDeictic, text: '修复登录页的报错问题', want: false },
        // 11-02 真机：问句里带「是 / 吗 / ?」不算指代，独立私信问题进分类器
        { name: '带「是」的问句不算', fn: isShortDeictic, text: '现在 pre 环境跑的是哪个版本', want: false },
        { name: '带「吗」的问句不算', fn: isShortDeictic, text: '你能发邮件吗', want: false },
        { name: '带问号的问句不算', fn: isShortDeictic, text: 'test 和 pre 一样?', want: false },
        { name: '「帮我做个页面」不算', fn: isShortDeictic, text: '帮我做个页面', want: false },
        { name: '整句「是」', fn: isShortDeictic, text: '是', want: true },
        { name: '整句「是的。」', fn: isShortDeictic, text: '是的。', want: true },
        { name: '整句「做吧」', fn: isShortDeictic, text: '做吧', want: true },
        { name: '整句「可以」', fn: isShortDeictic, text: '可以', want: true },
        { name: '整句「不」', fn: isShortDeictic, text: '不', want: true },
        { name: '「这个不用做」', fn: isShortDeictic, text: '这个不用做', want: true },
        { name: '恰好 40 字', fn: isShortDeictic, text: `这个${'啊'.repeat(38)}`, want: true },
        { name: '41 字太长', fn: isShortDeictic, text: `重跑${'啊'.repeat(39)}`, want: false },
        { name: '空', fn: isShortDeictic, text: '', want: false },
        { name: 'null', fn: isShortDeictic, text: null, want: false },
        { name: '就这样回', fn: isReleaseHeldReply, text: '就这样回', want: true },
        { name: '就这样回吧', fn: isReleaseHeldReply, text: ' 就这样回吧 ', want: true },
        { name: '带别的要求的不是放行', fn: isReleaseHeldReply, text: '改成xx再发', want: false },
        { name: '放行 + 40 字', fn: isReleaseHeldReply, text: `就这样回，${'x'.repeat(35)}`, want: true },
        { name: '放行 + 45 字太长', fn: isReleaseHeldReply, text: `就这样回，${'x'.repeat(40)}`, want: false },
        { name: '空', fn: isReleaseHeldReply, text: '', want: false },
        { name: 'null', fn: isReleaseHeldReply, text: null, want: false },
        { name: '已部署', fn: isDeployNotice, text: '已部署', want: true },
        { name: 'pre 已部署了。', fn: isDeployNotice, text: 'pre 已部署了。', want: true },
        { name: '带后话的不是通知', fn: isDeployNotice, text: '已部署，顺便看下登录', want: false },
        { name: 'null', fn: isDeployNotice, text: null, want: false },
      ], ({ fn, text, want }) => assert.equal(fn(text), want))
    }],
    ['resolvePrincipalAnchor：显式 > 回复私信通知 > 12h 内最近一条（只认「在问他」的，或本条是短指代句）', () => {
      const now = Date.parse('2026-11-01T12:00:00.000Z')
      // 本条私信的 chat_id 和生产一样是 oc_；私信通知的回执记的是负责人 open_id（ou_aven = config.notifyOpenId），11-02 复核前两者对不上、recent 永远锚不到
      const dmMsg = (text, extra = {}) => ({ messageId: 'om_in', chatId: 'oc_p2p', senderOpenId: 'ou_aven', text, mentions: [], ...extra })
      const put = (id, receipts, extra = {}) => store.upsert({ id, status: 'done', chatId: 'oc_g', text: `任务 ${id}`, epoch: 0, createdAt: iso(now - 20 * H), ...(receipts ? { receipts } : {}), ...extra })
      const resolve = (text, extra, more = {}) => resolvePrincipalAnchor({ msg: dmMsg(text, extra), store, config, now, ...more })
      put('om_plain')
      assert.equal(resolve('好'), null, '没有任何私信回执')
      const named = put('om_x', [])
      assert.deepEqual(resolve('继续任务 om_x 做'), { task: named, via: 'explicit', directive: { taskId: 'om_x', supplementText: '做' } })
      assert.equal(resolve('继续任务 om_nope'), null, '点名了但没这条 → 不回落')
      const replied = put('om_r', [{ messageId: 'om_rcpt', kind: 'suspected', epoch: 0, chatId: 'ou_aven', createdAt: iso(now - H) }], { epoch: 1 })
      assert.deepEqual(resolve('好', { replyToDirect: 'om_rcpt' }), { task: replied, via: 'reply' }, '换代前的回执也认')
      assert.deepEqual(resolve('好', { replyTo: 'om_rcpt' }), { task: replied, via: 'reply' })
      const legacy = { get: () => null, list: () => [], findByReceiptMessageId: (id) => (id === 'om_rcpt' ? replied : null) }
      assert.deepEqual(resolvePrincipalAnchor({ msg: dmMsg('好', { replyTo: 'om_rcpt' }), store: legacy, config, now }), { task: replied, via: 'reply' }, '老 store 只有按代次的回执反查也能锚')
      put('om_grp', [{ messageId: 'om_gr', kind: 'suspected', epoch: 0, chatId: 'oc_g', createdAt: iso(now) }])
      assert.deepEqual(resolve('把登录页按钮改成灰色'), { task: replied, via: 'recent' }, '「在问他」的通知：长句也锚；群里的回执不算私信；ou_ 回执按 notifyOpenId 认')
      assert.equal(resolvePrincipalAnchor({ msg: dmMsg('是'), store, config: { ...config, notifyOpenId: null }, now }), null, '没配 notifyOpenId 就只按本条 chat_id 认，ou_ 回执对不上')
      const byChat = put('om_oc', [{ messageId: 'om_oc_r', kind: 'held', epoch: 0, chatId: 'oc_p2p', createdAt: iso(now - 30 * 60_000) }])
      assert.deepEqual(resolve('就这样回'), { task: byChat, via: 'recent' }, '回执记了 p2p 会话 chat_id（oc_）的按本条 chat_id 认')
      assert.equal(resolvePrincipalAnchor({ msg: dmMsg('就这样回', { chatId: 'oc_other_p2p' }), store, config: { ...config, notifyOpenId: null }, now }), null, '别的会话的 oc_ 回执不算')
      const done = put('om_done', [{ messageId: 'om_d', kind: 'done', epoch: 0, chatId: 'ou_aven', createdAt: iso(now - 10 * 60_000) }])
      assert.deepEqual(resolve('重跑一次'), { task: done, via: 'recent' }, '结果类通知 + 短指代句')
      assert.equal(resolve('把登录页按钮改成灰色'), null, '结果类通知 + 长的独立私信 → 不粘')
      assert.equal(resolve('重跑一次', {}, { now: now + 13 * H }), null, '12 小时外不锚')
      assert.deepEqual(resolve('重跑一次', {}, { now: now - 10 * 60_000 + DEFAULT_PRINCIPAL_REPLY_WINDOW_MS }), { task: done, via: 'recent' }, '恰好到窗口边界还算')
      assert.equal(resolve('重跑一次', {}, { config: { ...config, principalReplyWindowMs: 5 * 60_000 } }), null, '配置的窗口更短')
      const first = put('om_t1', [{ messageId: 'om_1', kind: 'suspected', epoch: 0, chatId: 'ou_aven', createdAt: iso(now - 60_000) }])
      put('om_t2', [{ messageId: 'om_2', kind: 'suspected', epoch: 0, chatId: 'ou_aven', createdAt: iso(now - 60_000) }])
      assert.equal(resolve('好').task, first, '同一时刻的取先登记的')
      // 私信里发起的任务不被 reply / recent 锚（aven 11-02 真机：「你能发邮件吗」自答后的下一句被当成对它的指示）。
      const dmSelf = put('om_dm', [{ messageId: 'om_dm_ack', kind: 'ack', epoch: 0, chatId: 'ou_aven', createdAt: iso(now) }], { status: 'answered', chatId: 'ou_aven', chatType: 'p2p', intake: { trigger: 'dm' }, text: '你能发邮件吗' })
      assert.equal(resolve('那条再看看'), null, '私信任务 + 短指代句 → 不锚（也不越过它粘更早的群任务）')
      assert.equal(resolve('那你看看，现在 test、pre 两个环境运行的代码是不是一样的'), null, '私信任务 + 新问题 → 不锚')
      assert.equal(resolve('好', { replyToDirect: 'om_dm_ack' }), null, '回复私信任务的回执 → 不锚')
      assert.equal(resolve('好', { replyTo: 'om_dm_ack' }), null)
      assert.deepEqual(resolve('继续任务 om_dm 再查一下'), { task: dmSelf, via: 'explicit', directive: { taskId: 'om_dm', supplementText: '再查一下' } }, '显式点名私信任务照样认')
      for (const extra of [{ chatId: 'ou_aven' }, { chatType: 'p2p' }, { intake: { trigger: 'dm' } }]) {
        put('om_dm', [{ messageId: 'om_dm_ack', kind: 'suspected', epoch: 0, chatId: 'ou_aven', createdAt: iso(now) }], { chatId: 'oc_g', ...extra })
        assert.equal(resolve('好'), null, `私信身份按 ${JSON.stringify(extra)} 判`)
      }
      const grp = put('om_grp2', [{ messageId: 'om_g2', kind: 'done', epoch: 0, chatId: 'ou_aven', createdAt: iso(now + 1) }])
      assert.deepEqual(resolve('那条再看看'), { task: grp, via: 'recent' }, '群里发起的任务 + 短指代句照旧锚')
      assert.equal(resolve('现在 pre 环境跑的是哪个版本'), null, '群任务的结果通知后问新问题 → 不锚（11-02 真机：带「是」的问句被当指示、答案发去了群里）')
    }],
    ['maybeHandlePrincipalChannel：部署通知 / 放行草稿 / 续跑 / 指示任务；锚不到放行', async () => {
      const now = Date.now()
      const notes = []
      const resumes = []
      const releases = []
      const downloads = []
      let anchor = null
      let releaseResult = { ok: true }
      const deps = {
        sendPrincipalNote: async (args) => { notes.push(args); return { ok: true, messageId: 'om_n' } },
        handleResume: async (args) => { resumes.push(args) },
        deliverHeldGroupReply: async (args) => { releases.push(args.task.id); return releaseResult },
        downloadAttachments: async (args) => { downloads.push(args); return [{ type: 'image', imageKey: 'dl', localPath: '/x' }] },
        resolveAnchor: () => anchor,
      }
      const msg = (text, extra = {}) => ({ messageId: 'om_p', chatId: 'oc_p2p', chatType: 'p2p', senderOpenId: 'ou_aven', senderType: 'user', text, mentions: [], attachments: [], ...extra })
      const run = (text, extra) => maybeHandlePrincipalChannel({ msg: msg(text, extra), config, store, deps })
      assert.equal(await run('已部署', { chatType: 'group', chatId: 'oc_g' }), false, '群里的不走主通道')
      assert.equal(await run('已部署', { senderOpenId: 'ou_qa' }), false, '不是负责人')
      assert.equal(notes.length, 0)
      assert.equal(await run('pre 已部署'), true)
      assert.deepEqual(notes.pop(), { config, store, text: '好，知道了。', taskId: null, kind: 'private', idempotencyKey: 'om_p-pn' })
      assert.equal(await run('好'), false, '锚不到放行老路径')
      const held = store.upsert({ id: 'om_h', status: 'failed', chatId: 'oc_g', messageId: 'om_h', operator: 'ou_qa', summary: '登录页报错', text: '登录页报错', project: 'PR-X', createdAt: iso(now) })
      anchor = { task: held, via: 'reply' }
      assert.equal(await run('就这样回'), true)
      assert.deepEqual(notes.pop(), { config, store, text: '「登录页报错」这条没有扣下的草稿，没什么可发的。', taskId: 'om_h', kind: 'private', idempotencyKey: 'om_p-pn' })
      noteAnswer({ task: held, text: '结论' })
      assert.equal(await run('就这样回'), true)
      assert.deepEqual([notes.pop().text, releases.length], ['「登录页报错」这条已经发过更新的结论了，没有待放行的草稿。', 0])
      noteHeld({ task: held, text: '草稿' })
      assert.equal(await run('就这样回'), true)
      assert.deepEqual([releases, notes.pop()], [['om_h'], { config, store, text: '已按原文回群（登录页报错）。', taskId: 'om_h', kind: 'private', idempotencyKey: 'om_p-pn' }])
      releaseResult = { ok: false, reason: '撤回了' }
      assert.equal(await run('就这样回'), true)
      assert.equal(notes.pop().text, '没发出去：撤回了。')
      releaseResult = { ok: false }
      await run('就这样回')
      assert.equal(notes.pop().text, '没发出去：找不到要发的群。')
      anchor = { task: store.upsert({ ...held, id: 'om_h2', privateOrigin: { anchorId: 'om_zz', anchorHead: '原群消息' } }), via: 'recent' }
      await run('就这样回')
      assert.equal(notes.pop().text, '「原群消息」这条没有扣下的草稿，没什么可发的。', '私聊指示任务用它锚的群消息做标题')
      const waiting = store.upsert({ id: 'om_w', status: 'waiting_confirmation', chatId: 'oc_g', summary: 'W', createdAt: iso(now) })
      anchor = { task: waiting, via: 'explicit', directive: { taskId: 'om_w', supplementText: '做' } }
      assert.equal(await run('继续任务 om_w 做'), true)
      assert.deepEqual(resumes.pop(), { msg: msg('继续任务 om_w 做'), config, store, resumeDirective: anchor.directive, parentTask: { taskId: 'om_w', task: waiting, explicit: true } })
      anchor = { task: waiting, via: 'recent' }
      assert.equal(await run('用 508 号试'), true)
      assert.deepEqual([resumes.pop().resumeDirective, resumes.at(-1), notes.length, downloads.length], [undefined, undefined, 0, 0])
      const doneTask = store.upsert({ id: 'om_d', status: 'done', chatId: 'oc_g', messageId: 'om_d', operator: 'ou_qa', summary: '导出按钮', text: '导出按钮没反应', project: 'PR-X', attachments: [{ type: 'image', imageKey: 'g' }], createdAt: iso(now) })
      anchor = { task: doneTask, via: 'recent' }
      assert.equal(await run('修复：这个要做', { attachments: [{ type: 'image', imageKey: 'p' }] }), true)
      assert.deepEqual(downloads, [{ project: 'PR-X', messageId: 'om_p', attachments: [{ type: 'image', imageKey: 'p' }] }])
      const created = store.get('om_p')
      assert.deepEqual([created.status, created.chatId, created.operator, created.commandType, created.commandTypeSource, created.privateOrigin.anchorId, created.attachments.map((a) => a.imageKey)], ['received', 'oc_g', 'ou_qa', 'fix', 'explicit', 'om_d', ['dl', 'g']])
      assert.deepEqual(notes.pop(), { config, store, text: '收到，当作对「导出按钮」这条的指示处理；不是这条就回「取消任务 om_p」。', taskId: 'om_p', kind: 'ack', idempotencyKey: 'om_p-pn' })
      anchor = { task: { ...doneTask, id: 'om_d2', project: null }, via: 'recent' }
      assert.equal(await run('没附件', { messageId: 'om_p2', attachments: undefined }), true)
      assert.deepEqual([downloads.at(-1), store.get('om_p2').commandType], [{ project: 'PR-01947', messageId: 'om_p2', attachments: [] }, null])
    }],
    ['routes-intake：resolveMergeTarget（continues > 锚点，只对改码 / 对接类）；superseded 不当目标，顺 supersededBy 找承接的那条', () => {
      const tasks = [
        { id: 'om_a', status: 'queued' }, { id: 'om_b', status: 'done' }, { id: 'om_me', status: 'received' },
        // 11-02 复核：被兄弟并掉的 → 指到承接的；人工取消的（externalResolution、没 supersededBy）→ 没目标；链 / 环都有上限
        { id: 'om_s1', status: 'superseded', supersededBy: 'om_a' }, { id: 'om_s2', status: 'superseded', supersededBy: 'om_s1' },
        { id: 'om_cancel', status: 'superseded', externalResolution: { closureReason: 'cancelled' } },
        { id: 'om_dead', status: 'superseded', supersededBy: 'om_cancel' }, { id: 'om_loop', status: 'superseded', supersededBy: 'om_loop' },
        { id: 'om_tome', status: 'superseded', supersededBy: 'om_me' }, { id: 'om_gone', status: 'superseded', supersededBy: 'om_nope' },
        ...Array.from({ length: 6 }, (_, i) => ({ id: `om_c${i + 1}`, status: 'superseded', supersededBy: i === 0 ? 'om_a' : `om_c${i}` })), // om_c6 → … → om_c1 → om_a
      ]
      const st = memStore(tasks)
      const t = (cls, anchorTaskId = null) => ({ id: 'om_me', intake: { classification: cls, anchorTaskId } })
      assert.deepEqual(['om_s1', 'om_s2', 'om_cancel', 'om_dead', 'om_loop', 'om_tome', 'om_gone', 'om_a', 'om_nope', null].map((id) => mergeableTarget({ store: st, id, selfId: 'om_me' })?.id ?? null), ['om_a', 'om_a', null, null, null, null, null, 'om_a', null, null])
      assert.equal(mergeableTarget({ store: st, id: 'om_me', selfId: 'om_me' }), null, '自己不算')
      assert.deepEqual([mergeableTarget({ store: st, id: 'om_c5' })?.id, mergeableTarget({ store: st, id: 'om_c6' })], ['om_a', null], '最多追 5 跳')
      assert.equal(mergeableTarget({ store: st, id: 'om_a' })?.id, 'om_a', '不传 selfId 也行')
      return eachCase([
        { name: 'continues 指向被并掉的 → 承接它的那条', task: t({ decision: 'question', continues: 'om_s2' }), want: tasks[0] },
        { name: 'continues 指向人工取消的 → 落到锚点', task: t({ decision: 'bug', continues: 'om_cancel' }, 'om_a'), want: tasks[0] },
        { name: '锚点是人工取消的（回复「取消了」那条再报 bug）→ 新任务', task: t({ decision: 'bug' }, 'om_cancel'), want: null },
        { name: '锚点是被并掉的（回复它的「收到」）→ 承接它的那条', task: t({ decision: 'requirement' }, 'om_s1'), want: tasks[0] },
        { name: '分类器点名 continues → 那条', task: t({ decision: 'question', continues: 'om_a' }), want: tasks[0] },
        { name: 'continues 指向自己 → 不算', task: t({ decision: 'bug', continues: 'om_me' }), want: null },
        { name: 'continues 不存在 → 落到锚点', task: t({ decision: 'bug', continues: 'om_nope' }, 'om_b'), want: tasks[1] },
        { name: '锚点对对接类生效', task: t({ decision: 'api_reply' }, 'om_a'), want: tasks[0] },
        { name: '提问不并进锚点', task: t({ decision: 'question' }, 'om_a'), want: null },
        { name: '锚点是自己 → 不算', task: t({ decision: 'bug' }, 'om_me'), want: null },
        { name: '锚点不存在 → 严格 null', task: t({ decision: 'bug' }, 'om_nope'), want: null },
        { name: '没分类 → null', task: { id: 'om_me', intake: { anchorTaskId: 'om_a' } }, want: null },
        { name: '没 intake → null', task: { id: 'om_me' }, want: null },
      ], ({ task, want }) => assert.equal(resolveMergeTarget({ task, store: st }), want))
    }],
    ['routes-intake：handleIntakeResolution 每条出口', async () => {
      let outcome = null
      let mergeResult = null
      const target = { id: 'om_target', status: 'queued' }
      const calls = []
      const st = {
        resolveIntake: (args) => { calls.push(['resolveIntake', args]); return outcome },
        get: (id) => ({ om_target: target })[id],
        mergeIntoTask: (args) => { calls.push(['merge', args]); return mergeResult },
        upsert: (task) => task,
      }
      const said = []
      const names = ['flushPendingAck', 'deliverNoted', 'deliverIgnoredAfterAck', 'deliverSuspected', 'deliverStart', 'sendPrincipalNote', 'notePerson', 'deliverFollowUpReply']
      // flushPendingAck 桩：「收到」还挂着（ackLive）且有 reply → 用 reply 发了；否则没发（到点发过固定句 / 被闸拦）。followUp 桩按 followUpOk 回 ok / 拦下。
      let ackLive = true
      let followUpOk = true
      const deps = Object.fromEntries(names.map((name) => [name, (args) => {
        said.push([name, args])
        if (name === 'flushPendingAck') return Promise.resolve(ackLive && args.send && args.reply ? { sent: true, usedReply: true } : { sent: ackLive && args.send, usedReply: false })
        if (name === 'deliverFollowUpReply') return Promise.resolve(followUpOk ? { ok: true, messageId: 'om_fu', gated: false, reason: null } : { ok: false, gated: true, reason: '出口闸拦下：同内容' })
        return Promise.resolve({ ok: true })
      }]))
      const delivered = []
      const deliverTo = async (task) => { delivered.push(task) }
      const cfg = { ...config, ownerMap: { 小王: 'ou_qa' }, memberRoles: { 小王: '测试' } }
      const cls = (extra = {}) => ({ decision: 'question', confidence: 'high', deliverable: 'answer', forMe: null, selfAnswer: false, reply: 'R', continues: null, relatedTaskId: null, topic: null, waitsFor: null, summary: '摘要', reason: '理由', ...extra })
      const task = (extra = {}, c = cls()) => ({ id: 'om_me', chatId: 'oc_g', operator: 'ou_qa', status: 'queued', addressedToBot: true, intake: { classification: c }, ...extra })
      const run = (out, body = { epoch: 0, classification: out.task?.intake?.classification }) => {
        outcome = out
        said.length = 0
        delivered.length = 0
        logs.length = 0
        return handleIntakeResolution({ config: cfg, store: st, id: 'om_me', body, deliverTo, deps })
      }
      const upserts = []
      st.upsert = (task) => { upserts.push(task); return task }
      const body = (extra = {}) => ({ status: 200, body: { ok: true, actionable: false, suspected: false, selfAnswer: false, ...extra } })
      const saidNames = () => said.map(([name]) => name)
      assert.deepEqual(await run({ ok: false, code: 409, error: 'stale' }), { status: 409, body: { ok: false, code: 409, error: 'stale' } })
      assert.deepEqual(await run({ ok: false }), { status: 404, body: { ok: false } })
      assert.deepEqual(calls.at(-1), ['resolveIntake', { id: 'om_me', epoch: 0, classification: undefined, error: undefined }])
      // 自答：「收到」还挂着 → 分类器那句当「收到」发（一条 @bot 一个下文）、记义务、不建执行
      const selfTask = task({ status: 'answered', result: 'S' })
      assert.deepEqual(await run({ ok: true, selfAnswer: true, task: selfTask }), body({ selfAnswer: true, answered: true }))
      assert.deepEqual(said, [['notePerson', { openId: 'ou_qa', name: '小王', role: '测试', topic: '摘要', chatId: 'oc_g', taskId: 'om_me' }], ['flushPendingAck', { config: cfg, store: st, task: selfTask, reply: 'R', send: true, reason: 'self_answer' }]])
      assert.deepEqual([getObligation(selfTask).state, getObligation(selfTask).answerText, logs.at(-1)], ['answered', 'R', '[lark-gateway] 分类落地 om_me：自答（ack）：R'])
      // 点名的环境（aven 11-02）：分类后从「要做什么」的原话认出来存到任务上；没点名不写；重放（alreadyResolved）不重算
      assert.equal(selfTask.envTargets, undefined, '没配 envSites、原话里也没环境名 → 不写')
      const envCfg = { ...cfg, envSites: { pre: 'https://www.azmgb.com', online: 'https://www.fameex.com' } }
      const envRun = (t, extra = {}) => { outcome = { ok: true, actionable: true, task: t, ...extra }; upserts.length = 0; return handleIntakeResolution({ config: envCfg, store: st, id: 'om_me', body: { epoch: 0, classification: t.intake.classification }, deliverTo, deps }) }
      const onlineTask = task({ summary: '充值页白屏' }, cls({ summary: '去线上复测充值页', deliverable: 'verification' }))
      await envRun(onlineTask)
      assert.deepEqual([onlineTask.envTargets, upserts.includes(onlineTask)], [['online'], true])
      const ownText = task({ summary: 'www.azmgb.com 打不开' }, cls({ summary: '看看页面' }))
      await envRun(ownText)
      assert.deepEqual(ownText.envTargets, ['pre'], '本条原话里的域名也算')
      const dmFirstLine = task({ summary: '群里原话', privateOrigin: { chatId: 'oc_p2p' }, text: '【aven 私聊指示】去 pre 看\n\n【指示针对的群消息】online 报错' }, cls({ summary: '复测' }))
      await envRun(dmFirstLine)
      assert.deepEqual(dmFirstLine.envTargets, ['pre'], '私聊指示只看私信那一行，不看被锚的群消息')
      const notPrivate = task({ summary: '群里原话', text: '去 pre 看' }, cls({ summary: '复测' }))
      await envRun(notPrivate)
      assert.equal(notPrivate.envTargets, undefined, '不是私聊指示就不看 text（上下文包）')
      const none = task({ summary: '按钮颜色不对' }, cls({ summary: '改颜色' }))
      await envRun(none)
      assert.deepEqual([none.envTargets, upserts.includes(none)], [undefined, false])
      const replay = task({ summary: '线上' }, cls({ summary: '线上' }))
      await envRun(replay, { alreadyResolved: true })
      assert.equal(replay.envTargets, undefined, '重放不重算')
      const noCls = { id: 'om_me', chatId: 'oc_g', operator: 'ou_qa', status: 'intake_failed', summary: '线上', intake: {} }
      outcome = { ok: true, task: noCls }
      await handleIntakeResolution({ config: envCfg, store: st, id: 'om_me', body: { epoch: 0, error: 'x' }, deliverTo, deps })
      assert.equal(noCls.envTargets, undefined, '分类失败没有 classification 不算')
      // 没 reply 只有 result：「收到」发的是固定句，答案（result）单独回一条
      const selfBare = task({ id: 'om_me2', status: 'answered', result: 'S', topic: '主题' }, cls({ reply: null }))
      await run({ ok: true, selfAnswer: true, task: selfBare })
      assert.deepEqual([getObligation(selfBare).answerText, said[0][1].topic, said[1][1].reply, said[2], logs.at(-1)], ['S', '主题', null, ['deliverFollowUpReply', { config: cfg, store: st, task: selfBare, text: 'S', kind: 'self_answer' }], '[lark-gateway] 分类落地 om_me2：自答（follow_up）：S'])
      // 11-02 复核：分类超过 45s、「收到」已被巡检发了固定句（或被闸按人拦了）→ 答案单独回一条到原消息；发成才记 answered
      ackLive = false
      const selfLate = task({ id: 'om_me3', status: 'answered', result: 'R' })
      assert.deepEqual(await run({ ok: true, selfAnswer: true, task: selfLate }), body({ selfAnswer: true, answered: true }))
      assert.deepEqual([said.slice(1), getObligation(selfLate).state, logs.at(-1)], [[['flushPendingAck', { config: cfg, store: st, task: selfLate, reply: 'R', send: true, reason: 'self_answer' }], ['deliverFollowUpReply', { config: cfg, store: st, task: selfLate, text: 'R', kind: 'self_answer' }]], 'answered', '[lark-gateway] 分类落地 om_me3：自答（follow_up）：R'])
      followUpOk = false
      const selfGated = task({ id: 'om_me4', status: 'answered', result: 'R' })
      assert.deepEqual(await run({ ok: true, selfAnswer: true, task: selfGated }), body({ selfAnswer: true, answered: false }))
      assert.deepEqual([getObligation(selfGated), logs.at(-1)], [null, '[lark-gateway] 分类落地 om_me4：自答没发出去（出口闸拦下：同内容），义务留着：R'], '没发出去不记 answered')
      ackLive = true
      followUpOk = true
      // 已落过：重放只在仍在队列 / 在跑且 actionable 时重发开跑
      const replayActive = task({ status: 'queued' })
      assert.deepEqual(await run({ ok: true, alreadyResolved: true, actionable: true, task: replayActive }), body({ actionable: true }))
      assert.deepEqual([saidNames(), delivered], [['flushPendingAck', 'deliverStart'], [replayActive]])
      assert.deepEqual(await run({ ok: true, alreadyResolved: true, actionable: true, task: task({ status: 'done' }) }), body({ actionable: true, replayed: true }))
      assert.deepEqual([said, delivered], [[], []])
      assert.deepEqual(await run({ ok: true, alreadyResolved: true, selfAnswer: true, task: task({ status: 'answered' }) }), body({ selfAnswer: true, replayed: true }))
      assert.deepEqual([said, delivered], [[], []])
      // 瞬时失败延后 / 分类失败
      assert.deepEqual(await run({ ok: true, retried: true, task: task({ status: 'received' }) }), body({ retried: true }))
      assert.deepEqual(saidNames(), ['notePerson'])
      // 11-03 R6：分类非瞬时失败——挂着的「收到」撤掉不发（不能先承诺「稍后回你」再永久静默）、私信负责人一句；没回过「收到」不开义务
      const failedTask = task({ id: 'om_if1', status: 'intake_failed', summary: '登录页报错' }, null)
      assert.deepEqual(await run({ ok: true, task: failedTask }, { epoch: 0, error: 'boom' }), body({ intakeFailed: true }))
      assert.deepEqual([said, getObligation(failedTask), logs.at(-1)], [[
        ['flushPendingAck', { config: cfg, store: st, task: failedTask, reply: null, send: false, reason: 'intake_failed' }],
        ['sendPrincipalNote', { config: cfg, store: st, text: '⛔ 这条我没分出来是什么事，你看下（oc_g）：登录页报错', taskId: 'om_if1', kind: 'intake_failed' }],
      ], null, '[lark-gateway] 分类落地 om_if1：分类失败，已私信负责人：boom'])
      // 分类超 45s、「收到」已被巡检发了固定句：义务记 owed（答应了没结论，不算了结），逾期巡检不再当 settled 跳过
      const ackedFailed = task({ id: 'om_if2', status: 'intake_failed', ackedInGroup: true }, null)
      noteAck({ task: ackedFailed, text: '收到，我看一下，稍后回你。' })
      assert.deepEqual(await run({ ok: true, task: ackedFailed }, { epoch: 0, error: 'boom' }), body({ intakeFailed: true }))
      assert.deepEqual([getObligation(ackedFailed).state, getObligation(ackedFailed).owedStatus, saidNames()], ['owed', 'intake_failed', ['flushPendingAck', 'sendPrincipalNote']])
      assert.deepEqual(await run({ ok: true, task: task({ status: 'running' }, null) }, { epoch: 0, error: 'boom' }), body({ intakeFailed: true }), '带 error 的回写一律按失败处理')
      assert.deepEqual(await run({ ok: true, task: task({ status: 'intake_failed' }, null) }), body({ intakeFailed: true }))
      assert.equal(logs.at(-1), '[lark-gateway] 分类落地 om_me：分类失败，已私信负责人：')
      // 延续：并入原任务，挂起 / 终态的并入后要重新开跑
      const cont = task({}, cls({ decision: 'bug', continues: 'om_target' }))
      mergeResult = { mode: 'resumed', into: target }
      assert.deepEqual(await run({ ok: true, actionable: true, task: cont }), body({ actionable: true, mergedInto: 'om_target', mode: 'resumed' }))
      assert.deepEqual([calls.at(-1), said.slice(1), delivered], [['merge', { fromId: 'om_me', intoId: 'om_target' }], [['flushPendingAck', { config: cfg, store: st, task: cont, reply: 'R', send: true, reason: 'merged:resumed' }], ['deliverStart', { config: cfg, store: st, task: target }]], [target]])
      mergeResult = { mode: 'reopened', into: target }
      await run({ ok: true, actionable: true, task: cont })
      assert.deepEqual([saidNames(), delivered], [['notePerson', 'flushPendingAck', 'deliverStart'], [target]])
      mergeResult = { mode: 'appended', into: target }
      assert.deepEqual(await run({ ok: true, suspected: true, task: cont }), body({ suspected: true, mergedInto: 'om_target', mode: 'appended' }), '疑似也并')
      assert.deepEqual([saidNames(), delivered], [['notePerson', 'flushPendingAck'], []])
      // 并入在跑的那条（跑完再带补充跑一轮）：「收到」说清楚会怎么处理，不用分类器那句、不重发开跑
      mergeResult = { mode: 'rerun_after_done', into: { ...target, status: 'running' } }
      assert.deepEqual(await run({ ok: true, actionable: true, task: cont }), body({ actionable: true, mergedInto: 'om_target', mode: 'rerun_after_done' }))
      assert.deepEqual([said.slice(1), delivered, RERUN_ACK_REPLY], [[['flushPendingAck', { config: cfg, store: st, task: cont, reply: '收到，这条等上一轮跑完一起处理', send: true, reason: 'merged:rerun_after_done' }]], [], '收到，这条等上一轮跑完一起处理'])
      mergeResult = null
      // 开跑
      const go = task()
      assert.deepEqual(await run({ ok: true, actionable: true, task: go }), body({ actionable: true }))
      assert.deepEqual([said.slice(1), delivered, logs.at(-1)], [[['flushPendingAck', { config: cfg, store: st, task: go, reply: 'R', send: true }], ['deliverStart', { config: cfg, store: st, task: go }]], [go], '[lark-gateway] 分类落地 om_me：question/high·answer，正式入队'])
      // 追问 / 疑似 / 只记一笔
      const ask = task({ status: 'waiting_confirmation', fromPrincipal: true })
      assert.deepEqual(await run({ ok: true, askBack: true, task: ask }), body({ askBack: true, asked: true }))
      assert.deepEqual([said[1], said.length, logs.at(-1)], [['flushPendingAck', { config: cfg, store: st, task: ask, reply: 'R', send: true, reason: 'ask_back' }], 2, '[lark-gateway] 分类落地 om_me：负责人的话拿不准，先追问（ack）：R'])
      // 11-02 复核：「收到」已发过固定句 → 追问单独回一条；发不出去记在任务上（askBackUndelivered），不假装问过
      ackLive = false
      const askLate = task({ id: 'om_ask2', status: 'waiting_confirmation', fromPrincipal: true, result: 'Q' }, cls({ reply: null }))
      assert.deepEqual(await run({ ok: true, askBack: true, task: askLate }), body({ askBack: true, asked: true }))
      assert.deepEqual([said[2], 'askBackUndelivered' in askLate, logs.at(-1)], [['deliverFollowUpReply', { config: cfg, store: st, task: askLate, text: 'Q', kind: 'ask_back' }], false, '[lark-gateway] 分类落地 om_ask2：负责人的话拿不准，先追问（follow_up）：Q'])
      followUpOk = false
      const askGated = task({ id: 'om_ask3', status: 'waiting_confirmation', fromPrincipal: true })
      assert.deepEqual(await run({ ok: true, askBack: true, task: askGated }), body({ askBack: true, asked: false }))
      assert.deepEqual([askGated.askBackUndelivered.reason, upserts.at(-1), logs.at(-1)], ['出口闸拦下：同内容', askGated, '[lark-gateway] 分类落地 om_ask3：追问没发出去（出口闸拦下：同内容）：R'])
      ackLive = true
      followUpOk = true
      const sus = task({ status: 'waiting_confirmation', suspected: true }, cls({ decision: 'bug', confidence: 'low' }))
      assert.deepEqual(await run({ ok: true, suspected: true, task: sus }), body({ suspected: true }))
      assert.deepEqual([said.slice(1), logs.at(-1)], [[['flushPendingAck', { config: cfg, store: st, task: sus, reply: 'R', send: true, reason: 'suspected' }], ['deliverSuspected', { config: cfg, store: st, task: sus }]], '[lark-gateway] 分类落地 om_me：bug/low forMe=null，疑似：已私信负责人'])
      await run({ ok: true, suspected: true, task: task({ status: 'waiting_confirmation', suspected: true, addressedToBot: false }) })
      assert.equal(said[1][1].send, false, '没叫 bot 的不回「收到」')
      const rec = task({ status: 'ignored' }, cls({ decision: 'api_reply', deliverable: null, reply: '记下了' }))
      assert.deepEqual(await run({ ok: true, recordOnly: true, task: rec }), body({ recordOnly: true }))
      assert.deepEqual(said.slice(1), [['flushPendingAck', { config: cfg, store: st, task: rec, reply: null, send: false }], ['deliverNoted', { config: cfg, store: st, task: rec, reply: '记下了' }]])
      // 忽略：负责人私聊指示 / @ 了 bot / 只 @ 负责人
      const priv = task({ status: 'ignored', privateOrigin: { anchorId: 'om_g1', anchorHead: '导出按钮' } }, cls({ decision: 'ignore', reply: '这个不改' }))
      assert.deepEqual(await run({ ok: true, task: priv }), body({ ignored: true }))
      assert.deepEqual(said.slice(1), [['deliverNoted', { config: cfg, store: st, task: { ...priv, privateOrigin: null }, reply: '这个不改' }], ['sendPrincipalNote', { config: cfg, store: st, text: '记下了，「导出按钮」这条不用动手。', taskId: 'om_me', kind: 'ignored_after_ack' }]])
      await run({ ok: true, task: task({ status: 'ignored', privateOrigin: { anchorId: 'om_g1', anchorHead: '导出按钮' } }, cls({ decision: 'ignore', reply: null })) })
      assert.deepEqual(saidNames(), ['notePerson', 'sendPrincipalNote'], '没说怎么回群就不回')
      const ign = task({ status: 'ignored' }, cls({ decision: 'ignore', reply: '不用我' }))
      assert.deepEqual(await run({ ok: true, task: ign }), body({ ignored: true }))
      assert.deepEqual(said.slice(1), [['flushPendingAck', { config: cfg, store: st, task: ign, reply: null, send: false }], ['deliverNoted', { config: cfg, store: st, task: ign, reply: '不用我' }], ['deliverIgnoredAfterAck', { config: cfg, store: st, task: ign }]])
      await run({ ok: true, task: task({ status: 'ignored' }, cls({ decision: 'ignore', forMe: true })) })
      assert.deepEqual(saidNames(), ['notePerson', 'flushPendingAck', 'deliverNoted'], '明确是我的事判不做：不用再私信负责人')
      await run({ ok: true, task: task({ status: 'ignored', fromPrincipal: true }, cls({ decision: 'ignore' })) })
      assert.deepEqual(saidNames(), ['notePerson', 'flushPendingAck', 'deliverNoted'], '负责人自己说的不用处理')
      const quiet = task({ status: 'ignored', addressedToBot: false, ackedInGroup: true }, cls({ decision: 'ignore' }))
      assert.deepEqual(await run({ ok: true, task: quiet }), body({ ignored: true }))
      assert.deepEqual(said.slice(1), [['flushPendingAck', { config: cfg, store: st, task: quiet, reply: null, send: false }], ['deliverIgnoredAfterAck', { config: cfg, store: st, task: quiet }]])
      await run({ ok: true, task: task({ status: 'ignored', addressedToBot: false }, cls({ decision: 'ignore' })) })
      assert.deepEqual(saidNames(), ['notePerson', 'flushPendingAck'])
      const blank = { id: 'om_me', status: 'ignored', intake: {} }
      await run({ ok: true, task: blank })
      assert.deepEqual(said, [['flushPendingAck', { config: cfg, store: st, task: blank, reply: null, send: false }]], '没分类也没 operator：什么都不记')
    }],
    ['conversation-bundle：引用 / 话题 / 最近消息 / 附件来源 / 更早的文档 / 引用 bot 自己的卡', async () => {
      const calls = []
      let ref = null
      let thread = []
      let recent = []
      const deps = {
        fetchReferencedContext: async (id) => { calls.push(['ref', id]); return ref },
        fetchThreadContext: async (id, opts) => { calls.push(['thread', id, opts]); return thread },
        fetchRecentChatContext: async (args) => { calls.push(['recent', args]); return recent },
        downloadAttachments: async (args) => { calls.push(['download', args]); return args.attachments.map((item) => ({ ...item, localPath: '/x' })) },
      }
      const msg = (extra = {}) => ({ messageId: 'om_m', chatId: 'oc_g', senderOpenId: 'ou_qa', text: '登录页报错', mentions: [], attachments: [], ...extra })
      const bundle = (extra, project = null) => buildConversationBundle({ msg: msg(extra), config, store, project, deps })
      const bare = await bundle()
      assert.deepEqual(bare, { text: '登录页报错', attachments: [], threadSpeakers: [], conversation: { anchor: null, activity: { outbox: [], tasks: [] }, candidates: [] }, refText: null, quotedOwnCard: false })
      assert.deepEqual(calls, [['download', { project: 'PR-01947', messageId: 'om_m', attachments: [] }]])
      store.upsert({ id: 'om_bot', status: 'done', chatId: 'oc_g', epoch: 1, createdAt: iso(Date.now()) })
      store.recordReceipt('om_bot', { messageId: 'om_rcpt', kind: 'done', epoch: 0, chatId: 'oc_g' }) // 换代前的回执：只有忽略代次的反查能命中
      ref = { text: '被引用的原话', sender: '小王', senderOpenId: 'ou_w', createTime: '2026-11-01 09:00', attachments: [{ type: 'image', imageKey: 'ref_img' }] }
      thread = [{ messageId: 'om_t1', sender: '小李', senderOpenId: 'ou_l', text: '话题里的补充', attachments: [{ type: 'image', imageKey: 'thr_img' }] }, { messageId: 'om_t2', sender: '', senderOpenId: '', text: '', attachments: [] }]
      const mine = { messageId: 'om_r2', sender: '我', senderOpenId: 'ou_qa', time: '17:05', text: '发了文档', attachments: [], docs: [{ type: 'file', fileName: 'api.md', fileKey: 'f1' }] }
      recent = [
        { messageId: 'om_r0', sender: '小李', senderOpenId: 'ou_l', time: '', text: '先问一句', attachments: [] },
        { messageId: 'om_r1', sender: '小王', senderOpenId: 'ou_w', time: '17:00', text: '之前说的', attachments: [{ type: 'image', imageKey: 'rec_img' }] },
        mine,
      ]
      calls.length = 0
      const full = await bundle({ replyTo: 'om_rcpt', createTimeMs: 1_700_000_000_000, attachments: [{ type: 'image', imageKey: 'own_img', origin: '自带' }] }, 'PR-X')
      assert.equal(full.text, '【被引用消息】（小王 11-01 09:00）\n被引用的原话\n\n【本条 @】登录页报错\n\n【话题其它回复】\n小李：话题里的补充\n\n【群里这条之前的消息】\n小李：先问一句\n小王（17:00）：之前说的\n我（17:05）：发了文档')
      assert.deepEqual(full.attachments, [
        { type: 'image', imageKey: 'own_img', origin: '自带', localPath: '/x' },
        { type: 'image', imageKey: 'ref_img', origin: '被引用消息 · 小王 11-01 09:00', localPath: '/x' },
        { type: 'image', imageKey: 'thr_img', origin: '话题回复 · 小李', localPath: '/x' },
        { type: 'image', imageKey: 'rec_img', origin: '群里之前的消息 · 小王 17:00', localPath: '/x' },
      ])
      assert.deepEqual([full.threadSpeakers, full.refText, full.quotedOwnCard], [['ou_l'], '被引用的原话', true])
      assert.deepEqual(calls.slice(0, 3), [['ref', 'om_rcpt'], ['thread', 'om_rcpt', { excludeIds: ['om_m', 'om_rcpt'], botOpenIds: ['ou_bot', 'cli_x'] }], ['recent', { chatId: 'oc_g', beforeMs: 1_700_000_000_000, excludeIds: ['om_m', 'om_rcpt', 'om_t1', 'om_t2'], botOpenIds: ['ou_bot', 'cli_x'] }]])
      assert.deepEqual(calls.slice(3).map(([, args]) => [args.project, args.messageId, args.attachments.map((a) => a.imageKey)]), [['PR-X', 'om_m', ['own_img']], ['PR-X', 'om_rcpt', ['ref_img']], ['PR-X', 'om_t1', ['thr_img']], ['PR-X', 'om_r1', ['rec_img']]])
      // 单独 @bot、本条没文档：带上同一人紧接着发的那份文档；本条自带文档就不带
      calls.length = 0
      const earlier = await bundle({ messageId: 'om_m3', createTimeMs: 1_700_000_000_000 })
      assert.deepEqual(earlier.attachments.map((a) => [a.imageKey || a.fileName, a.origin]), [['api.md', '群里之前的消息 · 我 17:05'], ['rec_img', '群里之前的消息 · 小王 17:00']])
      assert.deepEqual(calls.filter(([kind]) => kind === 'download').map(([, args]) => args.messageId), ['om_m3', 'om_r2', 'om_r1'])
      const ownDoc = await bundle({ messageId: 'om_m4', createTimeMs: 1_700_000_000_000, attachments: [{ type: 'file', fileName: 'prd.md', fileKey: 'k' }] })
      assert.deepEqual(ownDoc.attachments.map((a) => [a.imageKey || a.fileName, a.origin]), [['prd.md', '本条'], ['rec_img', '群里之前的消息 · 小王 17:00']])
      // 别人发的文档：本条原话提到文档才带
      recent = [{ ...mine, sender: '小李', senderOpenId: 'ou_l' }, recent[1]]
      const refers = await bundle({ messageId: 'om_m5', createTimeMs: 1_700_000_000_000, text: '@Aven.Bot 按文档接一下', mentions: [BOT] })
      assert.deepEqual(refers.attachments.map((a) => [a.imageKey || a.fileName, a.origin]), [['api.md', '群里之前的消息 · 小李 17:05'], ['rec_img', '群里之前的消息 · 小王 17:00']])
      const unrelated = await bundle({ messageId: 'om_m6', createTimeMs: 1_700_000_000_000 })
      assert.deepEqual(unrelated.attachments.map((a) => a.imageKey), ['rec_img'])
      // 引用的不是 bot 的卡：quotedOwnCard=false；被引用消息没正文就只有本条；有正文没附言
      ref = { text: '', sender: '', attachments: [] }
      recent = []
      thread = []
      const plainReply = await bundle({ messageId: 'om_m7', replyTo: 'om_other', text: '' })
      assert.deepEqual([plainReply.text, plainReply.refText, plainReply.quotedOwnCard], ['', null, false])
      ref = { text: '原话', sender: '', attachments: [] }
      const noNote = await bundle({ messageId: 'om_m8', replyTo: 'om_rcpt', text: '' })
      assert.deepEqual([noNote.text, noNote.quotedOwnCard], ['【被引用消息】\n原话\n\n【本条 @】（无附言）', true])
    }],
    ['ingest：aven 私信 → received / dm / 快道 / 挂「收到」；非消息事件 / 幂等 / bot / 白名单外的不建', async () => {
      const before = Date.now()
      await ingestLarkEvent({ raw: dm('om_dm1', '有哪些差别'), config, store })
      const a = store.get('om_dm1')
      assert.deepEqual([a.status, a.chatType, a.chatId, a.operator, a.addressedToBot, a.fromPrincipal, a.quotedOwnCard, a.project, a.projectTitle, a.commandType, a.commandTypeSource, a.text, a.summary, a.threadRootId, a.replyTarget, a.attachments, a.aiExecutor],
        ['received', 'p2p', 'oc_p2p', 'ou_aven', true, true, false, null, undefined, null, null, '有哪些差别', '有哪些差别', null, { messageId: 'om_dm1', inThread: false }, [], 'claude'])
      assert.deepEqual({ ...a.intake, notBefore: undefined, receivedAt: undefined }, { required: true, trigger: 'dm', mentionedOpenIds: [], lane: 'fast', anchorTaskId: null, notBefore: undefined, receivedAt: undefined })
      const gapMs = Date.parse(a.intake.notBefore) - Date.parse(a.intake.receivedAt)
      assert.ok(gapMs >= 0 && gapMs < 1000, `快道不等：${gapMs}`)
      assert.ok(Date.parse(a.intake.receivedAt) >= before && a.createdAt === a.intake.receivedAt)
      assert.deepEqual([Date.parse(a.ackPending.at) >= before, Date.parse(a.ackPending.deadline) - Date.parse(a.ackPending.at)], [true, DEFAULT_ACK_TIMEOUT_MS])
      a.text = 'kept'
      await ingestLarkEvent({ raw: dm('om_dm1', '再发一次'), config, store })
      assert.equal(store.get('om_dm1').text, 'kept', '同一条消息投递两次只建一次')
      await ingestLarkEvent({ raw: { type: 'heartbeat' }, config, store })
      await ingestLarkEvent({ raw: { ...atBot('om_botself', '我是 bot'), sender_type: 'bot' }, config, store })
      await ingestLarkEvent({ raw: atBot('om_outside', '外面的群', { chatId: 'oc_other' }), config, store })
      await ingestLarkEvent({ raw: dm('om_stranger', '陌生人私信', { sender: 'ou_stranger', chatId: 'ou_stranger' }), config, store })
      assert.deepEqual(store.list().map((task) => task.id), ['om_dm1'])
    }],
    ['ingest：群里 @bot 建任务；只 @ 负责人的不送分类（11-02）；同人连发并入还没分类的任务', async () => {
      await ingestLarkEvent({ raw: atBot('om_b', '登录页报错', { create_time: '1793613600000' }), config, store })
      const b = store.get('om_b')
      assert.equal(b.messageCreatedAt, new Date(1793613600000).toISOString(), '飞书发出时间记下来做时延起点（lib/lark-latency）')
      assert.deepEqual([b.intake.trigger, b.intake.lane, b.intake.mentionedOpenIds, b.addressedToBot, b.fromPrincipal, b.chatType, Boolean(b.ackPending), b.text, b.summary], ['bot_mention', 'fast', [], true, false, 'group', true, '登录页报错', '登录页报错'])
      await ingestLarkEvent({ raw: event('om_c', '@aven 导出按钮没反应', { sender: 'ou_pm', mentions: [AVEN] }), config, store })
      assert.equal(store.has('om_c'), false, '只 @ 负责人本人的不建任务')
      await ingestLarkEvent({ raw: event('om_d', '补充：是在订单页'), config, store })
      assert.equal(store.has('om_d'), false)
      assert.match(b.text, /^登录页报错\n\n【话题补充 \d{2}:\d{2}】补充：是在订单页$/)
      await ingestLarkEvent({ raw: atBot('om_e', '帮看下'), config, store })
      assert.equal(store.has('om_e'), false)
      assert.match(b.text, /【话题补充 \d{2}:\d{2}】帮看下$/)
      assert.deepEqual([b.addressedToBot, b.fromPrincipal, b.intake.lane, Boolean(b.ackPending)], [true, false, 'fast', true])
      await ingestLarkEvent({ raw: event('om_f', '别人的话不并', { sender: 'ou_pm' }), config, store })
      assert.deepEqual([store.has('om_f'), b.text.includes('别人的话')], [false, false])
      assert.deepEqual(store.list().map((task) => task.id), ['om_b'])
    }],
    ['ingest：负责人私信「运维：」直接排队，不过分类；群里的「运维：」不算', async () => {
      await ingestLarkEvent({ raw: dm('om_ops', '运维：部署 pre', { thread_id: 'omt_1', create_time: '1793613600000' }), config, store })
      const ops = store.get('om_ops')
      assert.equal(ops.messageCreatedAt, new Date(1793613600000).toISOString(), '飞书发出时间记下来做时延起点（lib/lark-latency）')
      assert.deepEqual({ ...ops, createdAt: undefined, updatedAt: undefined, contract: undefined, messageCreatedAt: undefined }, {
        id: 'om_ops', source: 'lark', chatId: 'oc_p2p', chatType: 'p2p', messageId: 'om_ops', replyTarget: { messageId: 'om_ops', inThread: false }, threadRootId: 'omt_1', operator: 'ou_aven', project: null,
        commandType: 'ops', commandTypeSource: 'explicit', projectTitle: null, text: '运维：部署 pre', summary: '运维：部署 pre', attachments: [], addressedToBot: true, fromPrincipal: true, aiExecutor: 'claude', status: 'queued', intake: null,
        createdAt: undefined, updatedAt: undefined, contract: undefined, messageCreatedAt: undefined,
      })
      assert.deepEqual([ops.contract.deliverable, ops.contract.source], ['ops', 'ops'])
      await ingestLarkEvent({ raw: dm('om_ops2', '发 pre'), config, store })
      assert.deepEqual([store.get('om_ops2').commandType, store.get('om_ops2').commandTypeSource, store.get('om_ops2').threadRootId, store.get('om_ops2').status], ['ops', 'inferred', null, 'queued'])
      await ingestLarkEvent({ raw: atBot('om_ops3', '运维：部署 pre'), config, store })
      assert.deepEqual([store.get('om_ops3').status, store.get('om_ops3').commandType, store.get('om_ops3').intake.trigger], ['received', 'ops', 'bot_mention'])
    }],
    ['ingest：话题里接已了结的任务带锚点、只 @bot 引用别人的话用被引用正文做摘要、回复 bot 换代前的旧卡算 bot_reply', async () => {
      const now = Date.now()
      store.upsert({ id: 'om_done', status: 'done', chatId: 'oc_g', messageId: 'om_done', operator: 'ou_g', text: '原问题', summary: '原问题', createdAt: iso(now - H) })
      await ingestLarkEvent({ raw: atBot('om_g', '有哪些差别', { sender: 'ou_g', root_id: 'om_done', thread_id: 'omt_g' }), config, store })
      const g = store.get('om_g')
      assert.deepEqual([g.status, g.intake.trigger, g.intake.anchorTaskId, g.threadRootId, g.replyTarget, g.summary, g.text, g.quotedOwnCard],
        ['received', 'bot_mention', 'om_done', 'omt_g', { messageId: 'om_g', inThread: true }, '有哪些差别', '【被引用消息】（小王 11-01 09:00）\n登录页报错了\n\n【本条 @】有哪些差别', false])
      assert.equal(store.get('om_done').status, 'done', '不动原任务')
      await ingestLarkEvent({ raw: atBot('om_h', '', { sender: 'ou_h', reply_to: 'om_ref' }), config, store })
      const h = store.get('om_h')
      assert.deepEqual([h.summary, h.text, h.threadRootId, h.replyTarget.inThread, h.intake.anchorTaskId], ['登录页报错了', '【被引用消息】（小王 11-01 09:00）\n登录页报错了\n\n【本条 @】（无附言）', 'om_ref', false, null])
      store.upsert({ id: 'om_old', status: 'done', chatId: 'oc_g', messageId: 'om_old', operator: 'ou_j', text: '老问题', epoch: 1, createdAt: iso(now - H) })
      store.recordReceipt('om_old', { messageId: 'om_rc', kind: 'done', epoch: 0, chatId: 'oc_g' })
      await ingestLarkEvent({ raw: event('om_j', '导出也有这个问题', { sender: 'ou_j', reply_to: 'om_rc' }), config, store })
      const j = store.get('om_j')
      assert.deepEqual([j.intake.trigger, j.intake.anchorTaskId, j.addressedToBot, j.intake.lane, j.quotedOwnCard, Boolean(j.ackPending)], ['bot_reply', 'om_old', true, 'fast', true, true])
    }],
    ['project-chat-sync：parseBotAddedEvent 两种信封；handleBotAddedEvent 外部群不绑、进群同步、配了问候才说', async () => {
      await eachCase([
        { name: '官方信封', raw: { event: { chat_id: 'oc_1', name: 'N', operator_id: { open_id: 'ou_a' }, external: true } }, want: { chatId: 'oc_1', name: 'N', operatorOpenId: 'ou_a', external: true } },
        { name: 'data.event + 驼峰', raw: { data: { event: { chatId: 'oc_2', i18n_names: { zh_cn: 'Z', en_us: 'E' }, operator_id: { openId: 'ou_b' } } } }, want: { chatId: 'oc_2', name: 'Z', operatorOpenId: 'ou_b', external: false } },
        { name: '拍平到顶层', raw: { chat_id: 'oc_3', i18n_names: { en_us: 'E' }, operator_open_id: 'ou_c', external: 'true' }, want: { chatId: 'oc_3', name: 'E', operatorOpenId: 'ou_c', external: false } },
        { name: '只有 chat_id', raw: { chat_id: 'oc_4' }, want: { chatId: 'oc_4', name: '', operatorOpenId: null, external: false } },
        { name: '缺 chat_id → null', raw: { event: { name: 'x' } }, want: null },
        { name: 'null → null', raw: null, want: null },
      ], ({ raw, want }) => assert.deepEqual(parseBotAddedEvent(raw), want))
      const sends = []
      const lines = []
      let synced = 0
      const send = async (args) => { sends.push(args); return { ok: true } }
      const sync = async () => { synced += 1 }
      const log = (line) => lines.push(line)
      assert.equal(await handleBotAddedEvent({ raw: {}, config, sync, send, log }), null)
      const ext = await handleBotAddedEvent({ raw: { chat_id: 'oc_ext1234567890', name: '外部群', external: true, operator_id: { open_id: 'ou_x' } }, config: { notifyOpenId: 'ou_aven', joinGreeting: '大家好' }, sync, send, log })
      assert.deepEqual([ext.external, synced, sends, lines], [true, 0, [{ chatId: 'ou_aven', text: '👋 被拉进了外部群「外部群」，外部群不绑项目，先不处理。', logPrefix: 'bot-added external', idempotencyKey: 'join-xt1234567890-ext' }], ['[lark-gateway] 被拉进群「外部群」（oc_ext1234567890，外部群），操作人 ou_x']])
      sends.length = 0
      lines.length = 0
      await handleBotAddedEvent({ raw: { chat_id: 'oc_ext2', external: true }, config: {}, sync, send, log })
      assert.deepEqual([sends, lines], [[], ['[lark-gateway] 被拉进群「oc_ext2」（oc_ext2，外部群）']], '没配负责人就不私信；没群名用群 id')
      const joined = await handleBotAddedEvent({ raw: { chat_id: 'oc_new1234567890', name: '新群' }, config: { notifyOpenId: 'ou_aven', joinGreeting: '  大家好 ' }, sync, send, log })
      assert.deepEqual([joined, synced, sends], [{ chatId: 'oc_new1234567890', name: '新群', operatorOpenId: null, external: false }, 1, [{ chatId: 'oc_new1234567890', text: '大家好', logPrefix: 'join greeting', idempotencyKey: 'join-ew1234567890-hi' }]])
      sends.length = 0
      await handleBotAddedEvent({ raw: { chat_id: 'oc_n2' }, config: { joinGreeting: '   ' }, sync, send, log })
      await handleBotAddedEvent({ raw: { chat_id: 'oc_n3' }, config: {}, sync, send, log })
      await handleBotAddedEvent({ raw: { chat_id: 'oc_n4' }, config: { joinGreeting: 42 }, sync, send, log })
      assert.deepEqual([synced, sends], [4, []], '空白 / 没配 / 不是字符串的问候都不说')
    }],
    ['parked-reminder：永不催的名单；第 1 轮群里对提单人、第 2 轮私信负责人', async () => {
      assert.deepEqual([defaultRemindRounds, defaultRemindAfterMs], [2, 4 * H])
      const ok = { chatId: 'oc_g', chatType: 'group', intake: { trigger: 'bot_mention' }, contract: { deliverable: 'change' }, commandType: 'fix', parkedRemindedRound: 1 }
      await eachCase([
        { name: '群里发起的改码任务 → 催', task: ok, want: false },
        { name: '没契约的老任务也催', task: { ...ok, contract: undefined }, want: false },
        { name: '代答不催', task: { ...ok, contract: { deliverable: 'answer' } }, want: true },
        { name: '运维不催', task: { ...ok, commandType: 'ops' }, want: true },
        { name: 'p2p 不催', task: { ...ok, chatType: 'p2p' }, want: true },
        { name: '私信入口不催', task: { ...ok, intake: { trigger: 'dm' } }, want: true },
        { name: 'chatId 是 ou_ 不催', task: { ...ok, chatId: 'ou_x' }, want: true },
        { name: '负责人私聊指示不催', task: { ...ok, privateOrigin: { anchorId: 'a' } }, want: true },
        { name: '疑似不催', task: { ...ok, suspected: true }, want: true },
        { name: '追问不催', task: { ...ok, askBack: true }, want: true },
        { name: '轮次 99 = 永不催', task: { ...ok, parkedRemindedRound: 99 }, want: true },
        { name: '轮次 98 照催', task: { ...ok, parkedRemindedRound: 98 }, want: false },
        { name: '没任务', task: null, want: true },
      ], ({ task, want }) => assert.equal(isNeverNagged(task), want))
      const now = Date.now()
      const replies = []
      const notes = []
      const deps = { sendReply: async (args) => { replies.push(args); return { ok: true } }, sendPrincipalNote: async (args) => { notes.push(args); return { ok: true } }, chatNames: { oc_g: '测试群' } }
      const base = { status: 'waiting_confirmation', chatId: 'oc_g', chatType: 'group', operator: 'ou_qa', summary: '登录页报错', contract: { deliverable: 'change' }, epoch: 2, intake: { trigger: 'bot_mention' }, createdAt: iso(now - 9 * H) }
      const r1 = store.upsert({ ...base, id: 'om_r1', parkedAt: iso(now - 4 * H), outcome: { blockers: ['要接口示例', '要账号'] } })
      const r2 = store.upsert({ ...base, id: 'om_r2', parkedAt: iso(now - 8 * H), parkedRemindedRound: 1 })
      store.upsert({ ...base, id: 'om_fresh', parkedAt: iso(now - H) })
      store.upsert({ ...base, id: 'om_dm', chatType: 'p2p', parkedAt: iso(now - 4 * H) })
      await remindParkedTasks({ config, store, now, deps })
      assert.deepEqual(replies, [{ config, store, task: r1, phase: 'reminder', text: '「登录页报错」还在等你补：要接口示例。补上回我一句就继续。', mentions: [{ openId: 'ou_qa', name: '' }], idempotencyKey: 'om_r1-e2-rm1' }])
      assert.deepEqual(notes, [{ config, store, text: '⏰ 「登录页报错」（测试群）等了 8 小时没人补材料，我不再催群里了。要关掉回「取消任务 om_r2」。', taskId: 'om_r2', kind: 'reminder', idempotencyKey: 'om_r2-e2-rm2' }])
      assert.deepEqual([store.get('om_r1').parkedRemindedRound, store.get('om_r2').parkedRemindedRound, store.get('om_fresh').parkedRemindedRound, store.get('om_dm').parkedRemindedRound], [1, 2, undefined, undefined])
      assert.equal(r2, store.get('om_r2'))
      replies.length = 0
      notes.length = 0
      store.upsert({ ...base, id: 'om_r3', parkedAt: iso(now - 4 * H), operator: null })
      await remindParkedTasks({ config, store, now, deps })
      assert.deepEqual([replies.map((r) => [r.text, r.mentions, r.idempotencyKey]), notes], [[['「登录页报错」还在等你补材料。补上回我一句就继续。', [], 'om_r3-e2-rm1']], []], '催过的不重复；没 blocker 说「补材料」（11-02 复核：不再拼 null）')
    }],
    ['daily-digest：四组挑选、同一天只发一次、断点文件、定时器、疑似过期合并知会', async () => {
      const now = Date.parse('2026-11-01T12:00:00.000Z')
      const mk = (id, extra) => ({ id, chatId: 'oc_g', summary: `任务${id}`, createdAt: iso(now - 30 * H), ...extra })
      const tasks = [
        mk('sus', { suspected: true, status: 'waiting_confirmation', parkedAt: iso(now - H) }),
        mk('sus_closed', { suspected: true, status: 'ignored', parkedAt: iso(now - H) }),
        mk('parked_old', { status: 'blocked', contract: { deliverable: 'change' }, parkedAt: iso(now - 25 * H) }),
        mk('parked_nocontract', { status: 'waiting_confirmation', parkedAt: iso(now - 25 * H) }),
        mk('parked_updated', { status: 'blocked', updatedAt: iso(now - 25 * H) }),
        mk('parked_edge', { status: 'blocked', parkedAt: iso(now - 24 * H) }),
        mk('parked_fresh', { status: 'blocked', parkedAt: iso(now - 23 * H) }),
        mk('parked_askback', { status: 'waiting_confirmation', askBack: true, parkedAt: iso(now - 25 * H) }),
        mk('parked_answer', { status: 'waiting_confirmation', contract: { deliverable: 'answer' }, parkedAt: iso(now - 25 * H) }),
        mk('running_old', { status: 'running', parkedAt: iso(now - 25 * H), ackedAt: iso(now - 5 * H) }),
        mk('held', { status: 'failed' }),
        mk('overdue', { status: 'running', ackedInGroup: true, ackedAt: iso(now - 5 * H) }),
        mk('overdue_edge', { status: 'running', ackedInGroup: true, ackedAt: iso(now - 4 * H) }),
        mk('overdue_fresh', { status: 'running', ackedInGroup: true, ackedAt: iso(now - 3 * H) }),
        mk('acked_done', { status: 'done', ackedInGroup: true, ackedAt: iso(now - 5 * H) }),
        mk('acked_parked', { status: 'blocked', ackedInGroup: true, ackedAt: iso(now - 5 * H), parkedAt: iso(now - H) }),
        mk('not_acked_old', { status: 'done', ackedAt: iso(now - 5 * H) }),
      ]
      noteHeld({ task: tasks.find((task) => task.id === 'held'), text: '草稿' })
      const st = { list: () => tasks }
      const chatNames = { oc_g: '测试群' }
      const item = (id, at) => ({ headline: `任务${id}`, chatLabel: '测试群', time: localHHMM(at) })
      const digest = collectDigest({ store: st, now, chatNames })
      assert.deepEqual(digest, {
        suspected: [item('sus', iso(now - H))],
        held: [item('held', iso(now - 30 * H))],
        overdue: [item('overdue', iso(now - 5 * H))],
        parked: [item('parked_old', iso(now - 25 * H)), item('parked_nocontract', iso(now - 25 * H)), item('parked_updated', iso(now - 30 * H))],
      })
      assert.equal(collectDigest({ store: { list: () => [] } }).suspected.length, 0)
      const text = renderDigest(digest)
      assert.ok(text.startsWith('等你决定的 6 条\n疑似：\n- 任务sus（测试群）· '), text)
      const sends = []
      let sendResult = { ok: true }
      const send = async (args) => { sends.push(args); return sendResult }
      const saved = []
      const save = (state) => saved.push(state)
      const today = new Date(now).toLocaleDateString('sv-SE')
      assert.deepEqual(await runDailyDigest({ config, store: st, now, send, state: { lastSentDate: today }, save }), { sent: false, reason: 'already sent today' })
      assert.deepEqual(await runDailyDigest({ config, store: { list: () => [] }, now, send, state: {}, save }), { sent: false, reason: 'nothing to decide' })
      assert.equal(sends.length, 0)
      assert.deepEqual(await runDailyDigest({ config, store: st, now, send, state: { lastSentDate: '2026-10-31', other: 1 }, save, chatNames }), { sent: true, reason: null })
      assert.deepEqual([sends, saved], [[{ config, store: st, text, kind: 'digest', idempotencyKey: `digest-${today.replace(/-/g, '')}` }], [{ lastSentDate: today, other: 1 }]])
      sendResult = { ok: false, reason: '网络' }
      assert.deepEqual(await runDailyDigest({ config, store: st, now, send, state: {}, save }), { sent: false, reason: '网络' })
      assert.equal(saved.length, 1, '没发成不记已发')
      // 断点文件（runtime/lark-digest-state.json）：默认从它读、发成写回
      const statePath = join(runtime, 'lark-digest-state.json')
      mkdirSync(runtime, { recursive: true })
      writeFileSync(statePath, JSON.stringify({ lastSentDate: today }))
      sendResult = { ok: true }
      assert.deepEqual(await runDailyDigest({ config, store: st, now, send }), { sent: false, reason: 'already sent today' }, '断点文件里今天发过')
      rmSync(statePath)
      assert.deepEqual(await runDailyDigest({ config, store: st, now, send }), { sent: true, reason: null })
      assert.deepEqual(JSON.parse(readFileSync(statePath, 'utf8')), { lastSentDate: today })
      assert.equal(existsSync(`${statePath}.tmp`), false)
      // 定时器：关掉 / 到点 / 异常只记日志
      const off = startDailyDigest({ config: { digest: { enabled: false } }, store: st })
      assert.deepEqual(Object.keys(off), ['stop'])
      off.stop()
      const runs = []
      const run = async (args) => { runs.push(args) }
      const early = startDailyDigest({ config: { digest: { at: '00:00' } }, store: st, run })
      early.tick()
      early.stop()
      assert.deepEqual([runs.length, runs[0].config.digest.at, runs[0].store, typeof runs[0].now], [1, '00:00', st, 'number'])
      const clock = new Date()
      const hhmm = `${pad2(clock.getHours())}:${pad2(clock.getMinutes())}`
      const late = startDailyDigest({ config: { digest: { at: '23:59' } }, store: st, run })
      late.tick()
      late.stop()
      if (hhmm !== '23:59') assert.equal(runs.length, 1, '没到点不跑')
      const exact = startDailyDigest({ config: { digest: { at: hhmm } }, store: st, run })
      exact.tick()
      exact.stop()
      assert.equal(runs.length, hhmm === '23:59' ? 3 : 2, '到点那一分钟就跑')
      const boom = startDailyDigest({ config: { digest: { at: '00:00' } }, store: st, run: async () => { throw new Error('boom') } })
      boom.tick()
      boom.stop()
      await waitUntil(() => errors.some((line) => line.includes('日汇总异常')), { what: '日汇总异常日志' })
      assert.deepEqual(errors.filter((line) => line.includes('日汇总异常')), ['[lark-gateway] 日汇总异常：boom'])
      // 疑似过期：合并一条私信；没过期什么都不发；老 store 没有 expireSuspected 也不炸
      sends.length = 0
      const expired = [mk('exp1', { status: 'ignored' }), mk('exp2', { status: 'ignored' })]
      const expStore = { expireSuspected: ({ now: at }) => { assert.equal(at, now); return expired } }
      assert.deepEqual(await expireSuspectedAndNotify({ config, store: expStore, now, send, chatNames }), { expired: 2 })
      assert.deepEqual(sends, [{ config, store: expStore, text: '🧹 这 2 条疑似 48 小时没人认领，已关掉：\n- 任务exp1（测试群）\n- 任务exp2（测试群）', kind: 'suspected_expired', idempotencyKey: `sus-exp-${iso(now).slice(0, 13)}` }])
      assert.deepEqual(await expireSuspectedAndNotify({ config, store: { expireSuspected: () => [] }, now, send }), { expired: 0 })
      assert.deepEqual(await expireSuspectedAndNotify({ config, store: {}, now, send }), { expired: 0 })
      assert.equal(sends.length, 1)
    }],
  ], {
    before: () => {
      dir = mkdtempSync(join(root, 'case-'))
      process.env.LARK_OUTBOX_DIR = join(dir, 'outbox')
      process.env.LARK_OBLIGATIONS_DIR = join(dir, 'obligations')
      store = createTaskStore({ tasksDir: join(dir, 'tasks'), leaseMs: 1000 })
      logs = []
      errors = []
      console.log = (...args) => logs.push(args.join(' '))
      console.warn = (...args) => logs.push(args.join(' '))
      console.error = (...args) => errors.push(args.join(' '))
    },
    after: () => {
      Object.assign(console, original)
      delete process.env.LARK_OUTBOX_DIR
      delete process.env.LARK_OBLIGATIONS_DIR
      rmSync(dir, { recursive: true, force: true })
    },
  }))
})

after(() => rmSync(root, { recursive: true, force: true }))
