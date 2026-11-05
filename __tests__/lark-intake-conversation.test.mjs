/**
 * 对话层·接得上话（plan 目标 2 / §2.1，11-01）：默认锚点、群 / 话题上下文挑选、对话包数据与文本块、复制 bot 旧话反查、
 * 发件簿、回复义务状态机、persona / 人员画像。一个 it 合并全部段（测试棘轮）；表驱动给变异扫描用。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { OWN_EXPAND_CHARS, OWN_EXPAND_MAX, clipText, expandOwnBotMessages, parseFetchedMessage, pickEarlierDoc, pickRecentAttachments, pickRecentContext, pickThreadContext, shortTime, applyRecentWindow, RECENT_CONTEXT_HOURS } from '../lib/lark-chat-context.mjs'
import { ACTIVITY_WINDOW_MS, ANCHOR_WINDOW_MS, buildConversationData, renderActivityBlock, renderAnchorBlock, renderCandidateBlock, resolveDefaultAnchor } from '../lib/lark-conversation.mjs'
import { toEpochMs } from '../lib/lark-message.mjs'
import { hashText, listOutbox, localHHMM, pruneOutbox, recordOutbox, shouldSend } from '../lib/lark-outbox.mjs'
import { describePerson, personName, loadPeople, loadPersona, notePerson, peopleBlock, personaBlock } from '../lib/lark-persona.mjs'
import { buildQuotedBotBlock, findQuotedBotMessages, quoteCandidates } from '../lib/lark-quote-lookup.mjs'
import { clearHeldDraft, getObligation, heldDraftFor, listOverdueObligations, listUnansweredAddressed, markAnsweredFromOutbox, markOverdueNotified, noteAck, noteAddressed, noteAnswer, noteHeld, noteOwed, obligationIdFor, OVERDUE_AFTER_MS, settleAddressed, UNANSWERED_AFTER_MS } from '../lib/lark-reply-obligation.mjs'
import { eachCase, runSteps } from './support/steps.mjs'

const NOW_MS = Date.parse('2026-11-01T10:00:00.000Z')
const iso = (ms) => new Date(ms).toISOString()
const MIN = 60_000
const HOUR = 60 * MIN
const BOT = 'ou_bot'
const APP = 'cli_app'
const ME = 'ou_me'

// lark-cli 列消息的一条（拍平结构）。
const m = (id, { text = '', type = 'text', content, sender = { sender_type: 'user', id: 'ou_u', name: '小王' }, at = '2026-11-01 17:00', deleted } = {}) =>
  ({ message_id: id, msg_type: type, content: content ?? text, create_time: at, sender, ...(deleted ? { deleted } : {}) })
const userMsg = (id, text, extra = {}) => m(id, { text, ...extra })
const botMsg = (id, text, extra = {}) => m(id, { text, sender: { sender_type: 'app', id: APP, name: 'Aven.Bot' }, ...extra })

describe('对话层：锚点、上下文、对话包、发件簿、义务、persona', () => {
  let dir
  it('resolveDefaultAnchor / pick* / buildConversationData / render* / quote-lookup / outbox / obligations / persona', () => runSteps([
    ['resolveDefaultAnchor：同一人 15 分钟内、短指代句、没引用 → 接 bot 上一句（正 5 反 8）', () => {
      const last = { taskId: 'om_t', topic: 'diff', at: iso(NOW_MS - 5 * MIN), phase: 'done', text: '<at id=ou_u></at> 不一样，test 比 pre 多 3 个提交' }
      const want = { taskId: 'om_t', topic: 'diff', at: last.at, phase: 'done', text: '不一样，test 比 pre 多 3 个提交' }
      return eachCase([
        { name: '正：重跑一次', text: '重跑一次', anchor: want },
        { name: '正：@名字 + 这个可以了', text: '@Aven.Bot 这个可以了', anchor: want },
        { name: '正：ok', text: 'ok', anchor: want },
        { name: '正：好了吗？', text: '好了吗？', anchor: want },
        { name: '正：有哪些差别？（问号也算指代）', text: '有哪些差别？', anchor: want },
        { name: '正：恰好 15 分钟整', text: '继续', last: { ...last, at: iso(NOW_MS - ANCHOR_WINDOW_MS) }, anchor: { ...want, at: iso(NOW_MS - ANCHOR_WINDOW_MS) } },
        { name: '正：bot 那句时间在未来恰好一分钟（时钟允差边界）', text: '重跑一次', last: { ...last, at: iso(NOW_MS + 60_000) }, anchor: { ...want, at: iso(NOW_MS + 60_000) } },
        { name: '反：带引用', text: '重跑一次', replyTo: 'om_x', anchor: null },
        { name: '反：bot 没对他说过话', text: '重跑一次', last: null, anchor: null },
        { name: '反：bot 那句没挂任务', text: '重跑一次', last: { ...last, taskId: null }, anchor: null },
        { name: '反：超过 15 分钟', text: '重跑一次', last: { ...last, at: iso(NOW_MS - ANCHOR_WINDOW_MS - 1) }, anchor: null },
        { name: '反：bot 那句时间在未来一分钟以后（时钟不对）', text: '重跑一次', last: { ...last, at: iso(NOW_MS + 61_000) }, anchor: null },
        { name: '反：太长（> 20 字）', text: '重跑一次，顺便把登录页白屏的问题也一起查一下吧谢谢', anchor: null },
        { name: '反：没有指代词（像新话题）', text: '登录页白屏', anchor: null },
        { name: '反：只有 @名字', text: '@Aven.Bot', anchor: null },
        { name: '反：bot 那句时间解析不了', text: '重跑一次', last: { ...last, at: 'bad' }, anchor: null },
        // 11-03 静态 review R10：被出口闸拦下的（gated）人没看到，不能当「bot 上一句」锚
        { name: '反：bot 那句被出口闸拦下（人没看到）', text: '重跑一次', last: { ...last, gated: '拦下' }, anchor: null },
        { name: '反：21 字（上限 20）', text: '这个这个这个这个这个这个这个这个这个这个这', anchor: null },
        { name: '正：20 字', text: '这个这个这个这个这个这个这个这个这个这个', anchor: want },
      ], ({ text, replyTo = null, last: lastOutbox = last, anchor }) => assert.deepEqual(resolveDefaultAnchor({ text, replyTo, lastOutbox, nowMs: NOW_MS }), anchor))
    }],
    ['pickRecentContext：本 bot（sender.id 或 open_bot_id）标「我们自己」、别家机器人标「机器人」、系统 / 删除 / 无发送人跳过、beforeMs、排除、占位替换、链接不切半、limit', () => {
      const long = `${'字'.repeat(1990)} https://example.com/docx/CfbhdAyS`
      const msgs = [
        m('sys', { type: 'system', text: 'x 加入群聊' }),
        m('nosender', { text: '没有发送人', sender: null }),
        userMsg('del', '撤回的', { deleted: true }),
        userMsg('excluded', '已并入的'),
        userMsg('late', '在 @bot 之后发的', { at: '2026-11-01 18:30' }),
        userMsg('edge', '恰好在 @bot 那一刻发的（不算之前）', { at: '2026-11-01 18:00' }),
        botMsg('own-app', '<card>结论：都通了</card>'),
        m('own-custom', { text: '需要的话我重跑一次', sender: { sender_type: 'app', open_bot_id: BOT, name: 'Aven.Bot' } }),
        m('other-bot', { text: '[部署] online 已发布', sender: { sender_type: 'app', id: 'cli_other', name: '部署机器人' } }),
        m('bot-empty', { text: '📝 由 aven 的助手整理', sender: { sender_type: 'app', id: APP, name: 'Aven.Bot' } }),
        userMsg('img', '[Image: img_1] 看下这个 ![Image](img_2)'),
        m('pic', { type: 'image', content: JSON.stringify({ image_key: 'img_only' }) }),
        userMsg('long', long),
        userMsg('blank', '   '),
        userMsg('plain', '充值就不知道了', { at: '2026-11-01 17:05' }),
      ]
      const out = pickRecentContext(msgs, { beforeMs: Date.parse('2026-11-01T18:00:00'), excludeIds: ['excluded'], botOpenIds: [BOT, APP] })
      assert.deepEqual(out.map((item) => item.messageId), ['own-app', 'own-custom', 'other-bot', 'img', 'pic', 'long', 'plain'])
      assert.deepEqual(out[0], { messageId: 'own-app', sender: 'Aven.Bot（bot，我们自己）', time: '11-01 17:00', at: Date.parse('2026-11-01T17:00:00'), text: '结论：都通了', attachments: [], bot: true, ownBot: true })
      assert.equal(out[2].ownBot, undefined, '别家机器人不标 ownBot')
      assert.equal(out[1].sender, 'Aven.Bot（bot，我们自己）')
      assert.equal(out[2].sender, '部署机器人（机器人）')
      assert.deepEqual(out[3], { messageId: 'img', sender: '小王', senderOpenId: 'ou_u', time: '11-01 17:00', at: Date.parse('2026-11-01T17:00:00'), text: '看下这个 （发了 2 张图）', attachments: [{ type: 'image', imageKey: 'img_1' }, { type: 'image', imageKey: 'img_2' }] })
      assert.deepEqual(out[4].attachments, [{ type: 'image', imageKey: 'img_only' }])
      assert.equal(out[4].text, '（发了 1 张图）')
      assert.ok(out[5].text.endsWith('…') && !out[5].text.includes('https://'), '切点落在链接中间就整个去掉')
      assert.equal(out[6].time, '11-01 17:05')
      const many = Array.from({ length: 25 }, (_, i) => userMsg(`n${i}`, `第 ${i} 条`))
      assert.deepEqual(pickRecentContext(many, { beforeMs: Date.parse('2026-11-01T18:00:00') }).map((item) => item.messageId).slice(0, 2), ['n5', 'n6'])
      assert.equal(pickRecentContext(many, { beforeMs: Date.parse('2026-11-01T18:00:00'), limit: 3 }).length, 3)
      assert.deepEqual(pickRecentContext(null, { beforeMs: 0 }), [])
      assert.equal(pickRecentContext([userMsg('t0', 'x', { at: 0 })], { beforeMs: 1 }).length, 1, '没有时间的消息不按 beforeMs 过滤')
    }],
    ['applyRecentWindow：窗口内全留；更早的只留本 bot 最近 3 条和本人最近 2 条（别家机器人 / 别人旧话 / 本人更早的都去掉）；没时间的不删；窗口 0 / 缺 beforeMs 不截；保持顺序', () => {
      const H = 3_600_000
      const now = Date.parse('2026-11-02T18:00:00')
      const item = (id, hoursAgo, extra = {}) => ({ messageId: id, at: hoursAgo == null ? null : now - hoursAgo * H, ...extra })
      const items = [
        item('bot-old-1', 30, { bot: true, ownBot: true }), item('bot-old-2', 29, { bot: true, ownBot: true }), item('bot-old-3', 28, { bot: true, ownBot: true }), item('bot-old-4', 27, { bot: true, ownBot: true }),
        item('other-bot-old', 26, { bot: true }), item('me-old-1', 25, { senderOpenId: 'ou_me' }), item('me-old-2', 24, { senderOpenId: 'ou_me' }), item('me-old-3', 23, { senderOpenId: 'ou_me' }),
        item('pm-old', 5, { senderOpenId: 'ou_pm' }), item('no-time', null, { senderOpenId: 'ou_pm' }), item('edge', 4, { senderOpenId: 'ou_pm' }), item('pm-new', 1, { senderOpenId: 'ou_pm' }),
      ]
      assert.deepEqual(applyRecentWindow(items, { beforeMs: now, senderOpenId: 'ou_me' }).map((it) => it.messageId),
        ['bot-old-2', 'bot-old-3', 'bot-old-4', 'me-old-2', 'me-old-3', 'no-time', 'edge', 'pm-new'])
      assert.deepEqual(applyRecentWindow(items, { beforeMs: now }).map((it) => it.messageId), ['bot-old-2', 'bot-old-3', 'bot-old-4', 'no-time', 'edge', 'pm-new'], '不知道发送人就不留本人旧话')
      assert.equal(applyRecentWindow(items, { beforeMs: now, windowMs: 0 }).length, items.length)
      assert.equal(applyRecentWindow(items, { beforeMs: null }).length, items.length)
      assert.deepEqual(applyRecentWindow(items, { beforeMs: now, windowMs: 6 * H, keepOwnBot: 1, keepSameSender: 0, senderOpenId: 'ou_me' }).map((it) => it.messageId), ['bot-old-4', 'pm-old', 'no-time', 'edge', 'pm-new'])
      assert.deepEqual([applyRecentWindow(null, { beforeMs: now }), RECENT_CONTEXT_HOURS], [[], 4])
    }],
    ['expandOwnBotMessages：本 bot 的话按发件簿 fullText 展开（最近 2 条、每条限 1000 字、at 标签换名字、多行缩进）；没 fullText / 闸拦下的 / 别家机器人 / 真人的不动（11-04 b3 ep-1021-8cca5c）', () => {
      assert.deepEqual([OWN_EXPAND_MAX, OWN_EXPAND_CHARS], [2, 1000])
      const own = (id) => ({ messageId: id, text: `${id} 第一行 完整内容：https://doc/${id}`, bot: true, ownBot: true })
      const items = [own('b1'), own('b2'), { messageId: 'h1', text: '人说的', senderOpenId: 'ou_x' }, own('b3'), { messageId: 'o1', text: '别家', bot: true }, own('b4')]
      const entries = [
        { messageId: 'b1', fullText: 'b1 全文' }, { messageId: 'b2', fullText: '<at user_id="ou_a">Arthur</at> b2 全文\n- ⚠️ 两个号\n\n  - 第二条  ' },
        { messageId: 'b3', fullText: 'b3 全文', gated: '同内容已发过' }, { messageId: 'h1', fullText: '不该用' }, { messageId: 'o1', fullText: '不该用' }, { messageId: 'b4' }, { fullText: '没 id' },
        { messageId: 'b0', fullText: '<at id=ou_b></at> 旧卡写法' },
      ]
      const out = expandOwnBotMessages(items, { entries })
      assert.deepEqual(out.map((it) => it.text), ['b1 全文', '@Arthur b2 全文\n  - ⚠️ 两个号\n  - 第二条', '人说的', 'b3 第一行 完整内容：https://doc/b3', '别家', 'b4 第一行 完整内容：https://doc/b4'], '最近两条有原文的（b2、b1），闸拦下的 b3 和没原文的 b4 不算数')
      assert.equal(items[1].text, 'b2 第一行 完整内容：https://doc/b2', '不改入参')
      assert.deepEqual(expandOwnBotMessages(items, { entries, maxMessages: 1 }).map((it) => it.text.slice(0, 2)), ['b1', '@A', '人说', 'b3', '别家', 'b4'])
      assert.equal(expandOwnBotMessages([own('b0')], { entries }).at(0).text, '旧卡写法')
      assert.equal(expandOwnBotMessages([own('b1')], { entries: [{ messageId: 'b1', fullText: 'x'.repeat(1001) }] })[0].text, `${'x'.repeat(1000)}…`)
      assert.equal(expandOwnBotMessages([own('b1')], { entries: [{ messageId: 'b1', fullText: 'x'.repeat(1000) }] })[0].text, 'x'.repeat(1000))
      assert.deepEqual(expandOwnBotMessages([own('b1')], { entries, maxMessages: 0 }).map((it) => it.text), ['b1 第一行 完整内容：https://doc/b1'])
      assert.deepEqual(expandOwnBotMessages(), [])
      assert.deepEqual(expandOwnBotMessages([null, own('b1')], { entries }).map((it) => it?.text ?? null), [null, 'b1 全文'])
    }],
    ['pickThreadContext：本 bot 的话留下、别家 app 跳过、空消息跳过、limit', () => {
      const msgs = [
        botMsg('b1', '<card>我先看下</card>'),
        m('b2', { text: '别家', sender: { sender_type: 'app', id: 'cli_other' } }),
        m('b3', { text: '自定义机器人', sender: { sender_type: 'app', open_bot_id: BOT } }),
        userMsg('u1', ''),
        userMsg('u2', '登录页白屏 [Image: img_1]'),
        userMsg('skip', '排除'),
        m('nosender', { text: '无发送人也算人', sender: null }),
      ]
      const out = pickThreadContext(msgs, { excludeIds: ['skip'], botOpenIds: [BOT, APP] })
      assert.deepEqual(out.map((item) => item.messageId), ['b1', 'b3', 'u2', 'nosender'])
      assert.deepEqual(out[0], { messageId: 'b1', sender: 'Aven.Bot（bot，我们自己）', senderOpenId: '', text: '我先看下', attachments: [], bot: true, createTime: '2026-11-01 17:00' })
      assert.deepEqual(out[2].attachments, [{ type: 'image', imageKey: 'img_1' }])
      assert.deepEqual([out[2].sender, out[2].senderOpenId, out[3].sender, out[3].senderOpenId], ['小王', 'ou_u', '', ''])
      assert.deepEqual([out[2].createTime, pickThreadContext([{ ...userMsg('nt', '没时间'), create_time: undefined }])[0].createTime], ['2026-11-01 17:00', ''], '真人消息带 createTime（同话题前一单按它兜底切分），没有 → 空串')
      // 真人消息带 @ 了谁（answeringColleague 用）：id 是串或 { open_id }，没有的跳过
      assert.deepEqual([out[2].mentionIds, pickThreadContext([{ ...userMsg('mm', '@A @B 看下'), mentions: [{ id: 'ou_a' }, { id: { open_id: 'ou_b' } }, { key: '@_all' }] }])[0].mentionIds], [[], ['ou_a', 'ou_b']])
      assert.equal(pickThreadContext(msgs, { botOpenIds: [BOT, APP], limit: 2 }).length, 2)
      assert.deepEqual(pickThreadContext(undefined), [])
    }],
    ['pickRecentAttachments：从新到旧，图最多 maxImages、文件最多 maxFiles', () => {
      const img = (k) => ({ type: 'image', imageKey: k })
      const file = (k) => ({ type: 'file', fileKey: k })
      const recent = [
        { messageId: 'a', attachments: [img('a1'), file('fa')] },
        { messageId: 'b', attachments: [img('b1'), img('b2')] },
        { messageId: 'c', attachments: [file('fc'), img('c1')] },
      ]
      const out = pickRecentAttachments(recent, { maxImages: 2, maxFiles: 1 })
      assert.deepEqual(out.map(({ item, attachments }) => [item.messageId, attachments.map((a) => a.imageKey || a.fileKey)]), [['c', ['fc', 'c1']], ['b', ['b1']]])
      assert.deepEqual(pickRecentAttachments([{ messageId: 'x', attachments: [] }]), [])
      assert.equal(pickRecentAttachments(recent).flatMap((x) => x.attachments).length, 6, '默认上限 8 图 4 文件，都要')
    }],
    ['pickEarlierDoc：同一人发完文档紧接着 @ / 本条提到文档 → 并入；别人的、不提及、负责人发的 → 不并（正 2 反 3）', () => {
      const doc = { messageId: 'd', senderOpenId: 'ou_a', docs: [{ type: 'file', fileName: '123-头像接口.md' }] }
      return eachCase([
        { name: '正：同一人紧接着 @bot', recent: [doc], senderOpenId: 'ou_a', ownText: '看下', want: 'd' },
        { name: '正：别人发的但本条点名文件', recent: [doc, { messageId: 'x', senderOpenId: 'ou_b', text: '哈' }], senderOpenId: 'ou_c', ownText: '头像接口 这份按这个接', want: 'd' },
        { name: '正：本条说「文档」也算提及', recent: [doc, { messageId: 'x', senderOpenId: 'ou_b' }], senderOpenId: 'ou_c', ownText: '按上面的文档来', want: 'd' },
        { name: '正：文件名主干恰好 2 字、本条提到它', recent: [{ messageId: 'd2', senderOpenId: 'ou_a', docs: [{ type: 'file', fileName: '12-头像.md' }] }, { messageId: 'x', senderOpenId: 'ou_b' }], senderOpenId: 'ou_c', ownText: '头像按这个接', want: 'd2' },
        { name: '反：主干只有 1 字不算提到', recent: [{ messageId: 'd1', senderOpenId: 'ou_a', docs: [{ type: 'file', fileName: '1-头.md' }] }, { messageId: 'x', senderOpenId: 'ou_b' }], senderOpenId: 'ou_c', ownText: '头按这个接', want: null },
        { name: '反：同一人但中间有别人说话、本条也没提', recent: [doc, { messageId: 'x', senderOpenId: 'ou_b' }], senderOpenId: 'ou_a', ownText: '开播 500', want: null },
        { name: '反：中间有 bot 说话', recent: [doc, { messageId: 'x', bot: true, senderOpenId: '' }], senderOpenId: 'ou_a', ownText: '开播 500', want: null },
        { name: '反：负责人发的对接文档不算', recent: [{ ...doc, senderOpenId: ME }], senderOpenId: ME, ownText: '看下文档', excludeSenders: [ME], want: null },
        { name: '反：没有文档', recent: [{ messageId: 'x', senderOpenId: 'ou_a' }], senderOpenId: 'ou_a', ownText: '看下文档', want: null },
      ], ({ recent, senderOpenId, ownText, excludeSenders = [], want }) => assert.equal(pickEarlierDoc(recent, { excludeSenders, senderOpenId, ownText })?.messageId ?? null, want))
    }],
    ['clipText / shortTime / toEpochMs / parseFetchedMessage', () => {
      assert.equal(clipText('短的', 10), '短的')
      assert.equal(clipText('看这里 https://a.b/c/ddd 然后', 14), '看这里…', '切点在链接中间就去掉整段链接')
      assert.equal(clipText('看这里 https://a.b/c 然后', 17), '看这里 https://a.b/c…', '链接恰好完整就保留')
      assert.equal(clipText('一二三四五六', 3), '一二三…')
      assert.equal(clipText('短的', 2), '短的', '恰好等于上限不截')
      assert.equal(shortTime('2026-10-15 13:21'), '10-15 13:21')
      assert.equal(shortTime(''), '')
      assert.equal(shortTime('bad'), '')
      const d = new Date(2026, 9, 15, 13, 21)
      assert.equal(shortTime(d.getTime()), '10-15 13:21')
      assert.equal(shortTime(String(Math.floor(d.getTime() / 1000))), '10-15 13:21', '秒级时间戳也认')
      assert.equal(toEpochMs(1_700_000_000), 1_700_000_000_000)
      assert.equal(toEpochMs('1700000000000'), 1_700_000_000_000)
      assert.equal(toEpochMs('2026-11-01T10:00:00.000Z'), NOW_MS)
      assert.equal(toEpochMs(''), 0)
      assert.equal(toEpochMs(null), 0)
      assert.equal(toEpochMs('garbage'), 0)
      assert.equal(toEpochMs(1e12), 1e12, '恰好 1e12 按毫秒')
      assert.equal(toEpochMs(999_999_999_999), 999_999_999_999_000)
      assert.deepEqual(parseFetchedMessage('text', '纯文本'), { text: '纯文本', attachments: [] })
      assert.deepEqual(parseFetchedMessage('text', { text: '已解析的对象' }), { text: '已解析的对象', attachments: [] })
      assert.deepEqual(parseFetchedMessage('image', JSON.stringify({ image_key: 'img_k' })), { text: '', attachments: [{ type: 'image', imageKey: 'img_k' }] })
      assert.deepEqual(parseFetchedMessage('image', '{bad'), { text: '', attachments: [] })
      assert.deepEqual(parseFetchedMessage('text', JSON.stringify({ text: 'hi [Image: img_1]' })), { text: 'hi [Image: img_1]', attachments: [{ type: 'image', imageKey: 'img_1' }] })
    }],
    ['buildConversationData：发件簿只取对他说的 2h 内最新 3 条、他 2h 内最新 5 条任务、候选经 listRecentForChat 投影（交付 / bot 最后说）、锚点', () => {
      const chatId = 'oc_g'
      const other = 'ou_other'
      const at = (ms, extra = {}) => ({ chatId, phase: 'done', text: 'x', now: ms, dir, ...extra })
      recordOutbox(at(NOW_MS - 3 * HOUR, { to: 'ou_u', taskId: 'old', text: '三小时前对他说的' }))
      recordOutbox(at(NOW_MS - ACTIVITY_WINDOW_MS, { to: 'ou_u', taskId: 't_e', text: '两小时整' }))
      recordOutbox(at(NOW_MS - 90 * MIN, { to: other, text: 'o1' }))
      recordOutbox(at(NOW_MS - 80 * MIN, { to: other, text: 'o2' }))
      recordOutbox(at(NOW_MS - 60 * MIN, { to: other, taskId: 't_a', text: 'o3' }))
      recordOutbox(at(NOW_MS - 30 * MIN, { to: other, taskId: 't_b', text: '拦下的', gated: '拦下' }))
      recordOutbox(at(NOW_MS - 10 * MIN, { to: other, mentions: ['ou_u'], taskId: 't_m', phase: 'ack', text: '@到他的' }))
      recordOutbox(at(NOW_MS - 5 * MIN, { to: 'ou_u', taskId: 't_c', topic: 'diff', phase: 'done', text: `<at id=ou_u></at> 不一样，${'多'.repeat(130)}` }))
      const tasks = [
        { id: 'om_now', chatId, operator: 'ou_u', status: 'received', createdAt: iso(NOW_MS), text: '本条' },
        { id: 'k1', chatId, operator: 'ou_u', status: 'done', createdAt: iso(NOW_MS - 10 * MIN), summary: '摘要 1' },
        { id: 'k2', chatId, operator: 'ou_u', status: 'running', createdAt: iso(NOW_MS - 20 * MIN), text: '首行\n第二行' },
        { id: 'k3', chatId, operator: 'ou_u', status: 'done', createdAt: iso(NOW_MS - 30 * MIN) },
        { id: 'edge', chatId, operator: 'ou_u', status: 'done', createdAt: iso(NOW_MS - ACTIVITY_WINDOW_MS) },
        { id: 'other-chat', chatId: 'oc_x', operator: 'ou_u', status: 'done', createdAt: iso(NOW_MS - MIN) },
        { id: 'too-old', chatId, operator: 'ou_u', status: 'done', createdAt: iso(NOW_MS - ACTIVITY_WINDOW_MS - 1) },
        { id: 'no-time', chatId, operator: 'ou_u', status: 'done' },
        ...Array.from({ length: 6 }, (_, i) => ({ id: `o${i}`, chatId, operator: other, status: 'done', createdAt: iso(NOW_MS - (i + 1) * MIN) })),
      ]
      const recentCalls = []
      const store = {
        list: () => tasks,
        listRecentForChat: (id, opts) => { recentCalls.push([id, opts]); return [{ id: 't_c', status: 'answered', summary: 'test/pre 一样吗', contract: { v: 1, deliverable: 'answer' }, createdAt: 'c1' }, { id: 't_b', status: 'done', text: '第一行\n第二行' }, { id: 't_a', status: 'done', summary: 'a' }] },
      }
      const msg = { messageId: 'om_now', chatId, senderOpenId: 'ou_u', text: '有哪些差别？', replyTo: null }
      const data = buildConversationData({ store, msg, nowMs: NOW_MS })
      assert.deepEqual(data.activity.outbox, [
        { at: iso(NOW_MS - 5 * MIN), phase: 'done', topic: 'diff', text: `不一样，${'多'.repeat(130)}` },
        { at: iso(NOW_MS - 10 * MIN), phase: 'ack', topic: null, text: '@到他的' },
        { at: iso(NOW_MS - ACTIVITY_WINDOW_MS), phase: 'done', topic: null, text: '两小时整' },
      ], '新的在前；对他说的 + @到他的；恰好 2h 算在内、3h 不算；对别人说的不算')
      assert.deepEqual(data.activity.tasks, [
        { id: 'k1', summary: '摘要 1', status: 'done', createdAt: iso(NOW_MS - 10 * MIN) },
        { id: 'k2', summary: '首行 第二行', status: 'running', createdAt: iso(NOW_MS - 20 * MIN) },
        { id: 'k3', summary: '', status: 'done', createdAt: iso(NOW_MS - 30 * MIN) },
        { id: 'edge', summary: '', status: 'done', createdAt: iso(NOW_MS - ACTIVITY_WINDOW_MS) },
      ], '排除本条、别的群、别人的、2h 外、没时间的；恰好 2h 算在内')
      assert.deepEqual(recentCalls, [[chatId, { excludeId: 'om_now', days: 7, limit: 15 }]])
      assert.deepEqual(data.candidates, [
        { id: 't_c', summary: 'test/pre 一样吗', status: 'answered', deliverable: 'answer', createdAt: 'c1', botSaid: `不一样，${'多'.repeat(116)}…`, botSaidAt: iso(NOW_MS - 5 * MIN) },
        { id: 't_b', summary: '第一行 第二行', status: 'done', deliverable: null, createdAt: null, botSaid: null, botSaidAt: null },
        { id: 't_a', summary: 'a', status: 'done', deliverable: null, createdAt: null, botSaid: 'o3', botSaidAt: iso(NOW_MS - 60 * MIN) },
      ], '拦下的不算 bot 说过；bot 最后说截 120、带几点说的；对别人说的也算「bot 最后说」')
      assert.deepEqual(data.anchor, { taskId: 't_c', topic: 'diff', at: iso(NOW_MS - 5 * MIN), phase: 'done', text: `不一样，${'多'.repeat(130)}` })
      // 另一个人：发件簿最多 3 条、任务最多 5 条，都是新的在前
      const otherData = buildConversationData({ store, msg: { ...msg, senderOpenId: other, text: '重跑一次' }, nowMs: NOW_MS })
      assert.deepEqual(otherData.activity.outbox.map((e) => e.text), ['@到他的', 'o3', 'o2'], '11-03 R10：拦下的（人没看到）不算「bot 对他说的」，顺位补下一条')
      // 11-03 R10：bot 对他最后一句是被闸拦下的 → 默认锚点不能锚到那句（人没看到），退到再上一句真发出去的
      recordOutbox(at(NOW_MS - 2 * MIN, { to: other, taskId: 't_g', phase: 'done', text: '拦下的最新', gated: '拦下' }))
      const gatedLatest = buildConversationData({ store, msg: { ...msg, senderOpenId: other, text: '重跑一次' }, nowMs: NOW_MS })
      assert.deepEqual(gatedLatest.anchor, { taskId: 't_m', topic: null, at: iso(NOW_MS - 10 * MIN), phase: 'ack', text: '@到他的' }, '锚到真发出去的那句，不锚拦下的')
      assert.deepEqual(gatedLatest.activity.outbox.map((e) => e.text), ['@到他的', 'o3', 'o2'])
      assert.deepEqual(otherData.activity.tasks.map((t) => t.id), ['o0', 'o1', 'o2', 'o3', 'o4'])
      assert.deepEqual(otherData.anchor, { taskId: 't_m', topic: null, at: iso(NOW_MS - 10 * MIN), phase: 'ack', text: '@到他的' }, '锚到 bot 对他最后一句')
      // 没有 listRecentForChat 的 store：按同样口径从 list() 算
      const day = 24 * HOUR
      const fallbackTasks = [
        { id: 'f_sup', chatId, status: 'superseded', createdAt: iso(NOW_MS) },
        { id: 'f_ign', chatId, status: 'ignored', createdAt: iso(NOW_MS) },
        { id: 'f_fail', chatId, status: 'intake_failed', createdAt: iso(NOW_MS) },
        { id: 'f_old', chatId, status: 'done', createdAt: iso(NOW_MS - 7 * day - 1) },
        { id: 'f_edge', chatId, status: 'done', createdAt: iso(NOW_MS - 7 * day) },
        { id: 'f_upd', chatId, status: 'done', createdAt: iso(NOW_MS - 8 * day), updatedAt: iso(NOW_MS - 6 * day) },
        { id: 'f_other', chatId: 'oc_x', status: 'done', createdAt: iso(NOW_MS) },
        { id: 'om_now', chatId, status: 'received', createdAt: iso(NOW_MS) },
        { id: 'f_new', chatId, status: 'done', createdAt: iso(NOW_MS - day), updatedAt: iso(NOW_MS - day) },
        ...Array.from({ length: 12 }, (_, i) => ({ id: `f_many${i}`, chatId, status: 'done', createdAt: iso(NOW_MS - 2 * day - i * MIN), updatedAt: iso(NOW_MS - 2 * day - i * MIN) })),
      ]
      const fallback = buildConversationData({ store: { list: () => fallbackTasks }, msg, nowMs: NOW_MS })
      assert.deepEqual(fallback.candidates.map((c) => c.id), ['f_new', ...Array.from({ length: 12 }, (_, i) => `f_many${i}`), 'f_upd', 'f_edge'], '按更新时间新的在前；恰好 7 天算在内；被归并 / 忽略 / 分类失败 / 别的群 / 本条不算')
      const fallbackMany = buildConversationData({ store: { list: () => [...fallbackTasks, { id: 'f_more', chatId, status: 'done', createdAt: iso(NOW_MS - 3 * day) }] }, msg, nowMs: NOW_MS })
      assert.equal(fallbackMany.candidates.length, 15)
      assert.equal(fallbackMany.candidates.some((c) => c.id === 'f_edge'), false, '超过 15 条挤掉最旧的')
      assert.deepEqual(buildConversationData({ store, msg: { ...msg, senderOpenId: null }, nowMs: NOW_MS }), { anchor: null, activity: { outbox: [], tasks: [] }, candidates: [] })
      assert.deepEqual(buildConversationData({ store, msg: { ...msg, chatId: '' }, nowMs: NOW_MS }).candidates, [])
      assert.equal(buildConversationData({ store, msg: { ...msg, replyTo: 'om_q' }, nowMs: NOW_MS }).anchor, null, '带引用不默认锚')
    }],
    ['render*：有材料才出块、空输入空串；候选块说清 continues / relatedTaskId / 新主题', () => {
      const anchor = { taskId: 'om_t', topic: 'diff', at: iso(NOW_MS - 5 * MIN), phase: 'done', text: '不一样' }
      const hh = localHHMM(anchor.at)
      assert.equal(renderAnchorBlock(anchor), `【默认接着 bot 上一句】bot ${hh} 对他说（任务 om_t，主题 diff）：不一样\n本条是短指代句，默认是对这句的回应；确认则 continues 填该任务 id、topic 沿用，明显另起一事才不填。`)
      assert.equal(renderAnchorBlock({ ...anchor, topic: null }).includes('，主题'), false)
      assert.equal(renderAnchorBlock(null), '')
      assert.equal(renderAnchorBlock({ taskId: null }), '')
      const activity = { outbox: [{ at: anchor.at, phase: 'ack', topic: null, text: '<at id=ou_u></at>  收到 ' }], tasks: [{ id: 'k1', summary: '摘要 1', status: 'done', createdAt: anchor.at }] }
      assert.equal(renderActivityBlock({ senderLabel: '小王', activity }), `【小王 正在进行的事（任务 / bot 的话 2 小时内；新的在前）】\n- ${hh} bot 对他说（ack）：收到\n- 他 ${hh} 的消息 id=k1 状态=done：摘要 1`)
      assert.ok(renderActivityBlock({ activity: { outbox: [{ at: anchor.at, phase: null, topic: 'diff', text: 'x' }], tasks: [] } }).includes('【发送人 正在进行的事') && renderActivityBlock({ activity: { outbox: [{ at: anchor.at, phase: null, topic: 'diff', text: 'x' }], tasks: [] } }).includes('（-，主题 diff）'))
      assert.equal(renderActivityBlock({ activity: { outbox: [], tasks: [] } }), '')
      assert.equal(renderActivityBlock({}), '')
      const candidates = [
        { id: 't_c', summary: 'test/pre 一样吗', status: 'answered', deliverable: 'answer', createdAt: 'c1', botSaid: '不一样，多 3 个提交' },
        { id: 't_b', summary: '第一行', status: 'done', deliverable: null, createdAt: null, botSaid: null },
      ]
      const block = renderCandidateBlock(candidates)
      assert.equal(block, '【最近 7 天这个群里已有的任务】（判断本条是不是其中某条的延续 / 补充 / 对它的答复）\n- id=t_c 状态=answered 交付=answer 摘要=test/pre 一样吗｜bot 最后说：不一样，多 3 个提交\n- id=t_b 状态=done 摘要=第一行\n- 是延续（接着那条问 / 补料 / 答它）→ continues 填该 id，topic 沿用它的；相关但另一件事 → relatedTaskId 填该 id、continues=null；新主题 → 都为 null，topic 给一个短的稳定标识。')
      // 带几点说的（11-04 b3：引用自己的结论要说清是哪次）：候选跨 7 天，带日期；时间坏了回落 --:--
      const saidAt = '2026-10-24T06:19:00.000Z'
      const day = new Date(saidAt)
      const stamp = `${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')} ${localHHMM(saidAt)}`
      assert.match(renderCandidateBlock([{ ...candidates[0], botSaidAt: saidAt }]), new RegExp(`｜bot ${stamp} 最后说：不一样，多 3 个提交\\n`))
      assert.match(renderCandidateBlock([{ ...candidates[0], botSaidAt: 'bad' }]), /｜bot --:-- 最后说：/)
      assert.equal(renderCandidateBlock([]), '')
      assert.equal(renderCandidateBlock(undefined), '')
    }],
    ['quote-lookup：本条里有一行（≥12 字）能在 bot 发过的话里找到就把原消息带上；拦下的不算；最多 max 条', () => {
      const entries = [
        { at: iso(NOW_MS - 2 * HOUR), chatId: 'oc_g', taskId: 'om_1', topic: 'live', phase: 'done', text: '❌ 没接 开播设置里的『语言』下拉，后端没给字段' },
        { at: iso(NOW_MS - HOUR), chatId: 'oc_g', taskId: 'om_2', phase: 'done', text: '✅ 头像接口已经接上，pre 可以看', gated: '拦' },
        { at: iso(NOW_MS - 30 * MIN), chatId: 'oc_g', taskId: 'om_3', phase: 'done', text: '收到', fullText: '✅ 头像接口已经接上，pre 可以看' },
      ]
      assert.deepEqual(quoteCandidates('@Encone 收到\n> ❌ 没接 开播设置里的『语言』下拉，后端没给字段\n好的'), ['没接开播设置里的『语言』下拉，后端没给字段'])
      assert.deepEqual(quoteCandidates('短句'), [])
      assert.deepEqual(quoteCandidates('x'.repeat(12)), ['x'.repeat(12)], '恰好 12 字算')
      assert.deepEqual(quoteCandidates('x'.repeat(11)), [])
      const own = '- 没接 开播设置里的『语言』下拉，后端没给字段\n头像接口已经接上，pre 可以看'
      const hits = findQuotedBotMessages({ ownText: own, entries })
      assert.deepEqual(hits.map((h) => h.entry.taskId), ['om_3', 'om_1'], '新的在前；拦下的 om_2 不算，fullText 也比')
      assert.deepEqual(findQuotedBotMessages({ ownText: own, entries: [...entries, { at: iso(NOW_MS - 20 * MIN), chatId: 'oc_g', taskId: 'om_4', phase: 'done', text: '完全不相干的一句话，很长很长很长很长' }] }).map((h) => h.entry.taskId), ['om_3', 'om_1'], '没对上的不带')
      assert.equal(findQuotedBotMessages({ ownText: '头像接口已经接上，pre 可以看', entries, max: 1 }).length, 1)
      assert.deepEqual(findQuotedBotMessages({ ownText: own, entries, max: 1 }).map((h) => h.entry.taskId), ['om_3'], '最多 max 条')
      const dup = [entries[0], { ...entries[0], taskId: 'om_dup' }, { ...entries[0], chatId: 'oc_h', taskId: 'om_h' }]
      assert.deepEqual(findQuotedBotMessages({ ownText: own, entries: dup }).map((h) => h.entry.taskId), ['om_h', 'om_dup'], '同一时刻同一群只算一次；别的群的同一句算另一条')
      assert.deepEqual(findQuotedBotMessages({ ownText: '没有引用', entries }), [])
      const block = buildQuotedBotBlock({ ownText: '没接 开播设置里的『语言』下拉，后端没给字段', chatIds: ['oc_g'], list: ({ chatId }) => (chatId === 'oc_g' ? entries : []) })
      assert.ok(block.startsWith('【复制了 bot 之前说的话】'))
      assert.ok(block.includes('（任务 om_1，主题 live）：\n❌ 没接 开播设置里的『语言』下拉，后端没给字段'))
      assert.equal(buildQuotedBotBlock({ ownText: '没有引用', chatIds: ['oc_g'], list: () => entries }), '')
      assert.equal(buildQuotedBotBlock({ ownText: '没接 开播设置里的『语言』下拉，后端没给字段', chatIds: [], list: () => entries }), '')
    }],
    ['outbox：记 / 列 / 清；shouldSend 三种去重（content_24h 看内容哈希，per_person_2min 看同人同主题同阶段，per_message_24h 看同消息同阶段）；拦下的不算发过', () => {
      const chatId = 'oc_ob'
      assert.equal(recordOutbox({ chatId: '', phase: 'done', text: 'x', dir }), null)
      assert.equal(recordOutbox({ chatId, phase: '', text: 'x', dir }), null)
      const first = recordOutbox({ chatId, taskId: 'om_1', phase: 'done', to: 'ou_u', mentions: ['ou_x', null], text: ' 结论 ', fullText: '结论全文', messageId: 'om_bot1', now: NOW_MS - 2 * HOUR, dir })
      assert.deepEqual(first, { at: iso(NOW_MS - 2 * HOUR), chatId, taskId: 'om_1', topic: null, phase: 'done', to: 'ou_u', mentions: ['ou_x'], text: ' 结论 ', fullText: '结论全文', hash: hashText('结论'), messageId: 'om_bot1' })
      recordOutbox({ chatId, phase: 'ack', to: 'ou_u', topic: 'diff', text: '收到', now: NOW_MS - MIN, dir })
      recordOutbox({ chatId, phase: 'ack', to: 'ou_u', topic: 'diff', text: '收到', gated: '拦', now: NOW_MS - 10_000, dir })
      recordOutbox({ chatId, phase: 'done', text: '八天前', now: NOW_MS - 8 * 24 * HOUR, dir })
      assert.equal(listOutbox({ chatId, dir }).length, 4)
      assert.deepEqual(listOutbox({ chatId, sinceMs: NOW_MS - 2 * MIN, dir }).map((e) => e.gated || 'sent'), ['sent', '拦'])
      assert.deepEqual(listOutbox({ chatId, sinceMs: NOW_MS - MIN, dir }).map((e) => e.gated || 'sent'), ['sent', '拦'], '恰好等于 sinceMs 的算在内')
      assert.equal(listOutbox({ chatId: 'oc_none', dir }).length, 0)
      assert.equal(localHHMM(NOW_MS), localHHMM(iso(NOW_MS)), '毫秒数与 ISO 串同一口径')
      assert.notEqual(localHHMM(NOW_MS), '--:--')
      assert.equal(localHHMM('bad'), '--:--')
      delete process.env.LARK_OUTBOX_DIR
      assert.equal(listOutbox({ chatId }).length, 0, 'node --test 下没指定目录不读真实运行态')
      assert.equal(recordOutbox({ chatId, phase: 'done', text: 'x' }), null, '也不写')
      process.env.LARK_OUTBOX_DIR = dir
      assert.deepEqual(shouldSend({ chatId, phase: 'done', text: '结论', nowMs: NOW_MS, dir }), { send: false, reason: `同内容 ${localHHMM(NOW_MS - 2 * HOUR)} 已发过（done）` })
      assert.deepEqual(shouldSend({ chatId, phase: 'done', text: '结论', nowMs: NOW_MS + 23 * HOUR, dir }), { send: true }, '只有 2 小时前那条在 24h 窗里……但 23h 后它已超出 24h')
      assert.deepEqual(shouldSend({ chatId, phase: 'done', text: '别的结论', nowMs: NOW_MS, dir }), { send: true })
      assert.deepEqual(shouldSend({ chatId, phase: 'done', text: '收到', nowMs: NOW_MS, dir }), { send: true }, 'ack 发过的内容不算 done 发过')
      assert.deepEqual(shouldSend({ chatId, phase: 'ack', to: 'ou_u', topic: 'diff', text: '另一句收到', nowMs: NOW_MS, dir }), { send: false, reason: `2 分钟内已对同一人就主题 diff 发过 ack（${localHHMM(NOW_MS - MIN)}）` })
      assert.deepEqual(shouldSend({ chatId, phase: 'ack', to: 'ou_u', topic: null, text: '收到', nowMs: NOW_MS, dir }), { send: true }, '主题不同')
      assert.deepEqual(shouldSend({ chatId, phase: 'ack', to: 'ou_v', topic: 'diff', text: '收到', nowMs: NOW_MS, dir }), { send: true }, '对象不同')
      assert.deepEqual(shouldSend({ chatId, phase: 'noted', to: 'ou_u', topic: 'diff', text: '收到', nowMs: NOW_MS, dir }), { send: true }, '阶段不同')
      assert.deepEqual(shouldSend({ chatId, phase: 'ack', to: 'ou_u', topic: 'diff', text: '收到', nowMs: NOW_MS + 2 * MIN, dir }), { send: true }, '过了 2 分钟')
      assert.deepEqual(shouldSend({ chatId, phase: 'ack', to: 'ou_u', topic: 'diff', text: '收到', nowMs: NOW_MS + MIN, dir }), { send: true }, '恰好满 2 分钟也算过了')
      // 11-03 R11：per_message_24h（自答 / 追问）——按消息（taskId）+ 阶段去重，不看内容：两条消息同样的答复各发各的；同一条消息 24h 只回一次
      recordOutbox({ chatId: 'oc_pm', taskId: 'om_q1', phase: 'self_answer', text: '能力答复', now: NOW_MS - HOUR, dir })
      assert.deepEqual(shouldSend({ chatId: 'oc_pm', taskId: 'om_q2', phase: 'self_answer', text: '能力答复', nowMs: NOW_MS, dir }), { send: true }, '另一条消息同样的答复照发')
      assert.deepEqual(shouldSend({ chatId: 'oc_pm', taskId: 'om_q1', phase: 'self_answer', text: '另一句', nowMs: NOW_MS, dir }), { send: false, reason: `这条消息 ${localHHMM(NOW_MS - HOUR)} 已回过（self_answer）` })
      assert.deepEqual(shouldSend({ chatId: 'oc_pm', taskId: 'om_q1', phase: 'ask_back', text: '另一句', nowMs: NOW_MS, dir }), { send: true }, '同一条消息另一阶段不拦')
      assert.deepEqual(shouldSend({ chatId: 'oc_pm', taskId: 'om_q1', phase: 'self_answer', text: '另一句', nowMs: NOW_MS + 24 * HOUR, dir }), { send: true }, '过了 24h')
      assert.deepEqual(shouldSend({ chatId: 'oc_pm', taskId: null, phase: 'self_answer', text: '能力答复', nowMs: NOW_MS, dir }), { send: true }, '没 taskId 不拦')
      // b4 波 6 E1：notice 按「同内容 + 同一条消息」去重——同一单被另一条消息续跑，同样的「收到补充」照回
      recordOutbox({ chatId: 'oc_pm', taskId: 'om_t', phase: 'notice', text: '好，收到补充', anchor: 'om_m1', now: NOW_MS - HOUR, dir })
      recordOutbox({ chatId: 'oc_pm', taskId: 'om_t', phase: 'notice', text: '旧句', now: NOW_MS - HOUR, dir })
      recordOutbox({ chatId: 'oc_pm', taskId: 'om_t', phase: 'done', text: '结论句', anchor: 'om_m9', now: NOW_MS - HOUR, dir })
      assert.equal(listOutbox({ chatId: 'oc_pm', dir }).at(-3).anchor, 'om_m1')
      assert.deepEqual(shouldSend({ chatId: 'oc_pm', taskId: 'om_t', phase: 'notice', text: '好，收到补充', anchor: 'om_m2', nowMs: NOW_MS, dir }), { send: true }, '回另一条消息照发')
      assert.deepEqual(shouldSend({ chatId: 'oc_pm', taskId: 'om_t', phase: 'notice', text: '好，收到补充', anchor: 'om_m1', nowMs: NOW_MS, dir }), { send: false, reason: `同内容 ${localHHMM(NOW_MS - HOUR)} 已对这条消息发过（notice）` })
      assert.equal(shouldSend({ chatId: 'oc_pm', phase: 'notice', text: '好，收到补充', nowMs: NOW_MS, dir }).send, false, '本次没 anchor 退回按内容')
      assert.equal(shouldSend({ chatId: 'oc_pm', phase: 'notice', text: '旧句', anchor: 'om_m2', nowMs: NOW_MS, dir }).send, false, '旧条目没记 anchor 按同一条算')
      assert.deepEqual(shouldSend({ chatId: 'oc_pm', phase: 'notice', text: '结论句', anchor: 'om_m9', nowMs: NOW_MS, dir }), { send: true }, '只看同阶段')
      assert.deepEqual(shouldSend({ chatId: 'oc_pm', phase: 'notice', text: '好，收到补充', anchor: 'om_m1', nowMs: NOW_MS + 24 * HOUR, dir }), { send: true }, '过了 24h')
      assert.equal(pruneOutbox({ dir, now: NOW_MS }), 1, '清掉 7 天前那条')
      assert.equal(listOutbox({ chatId, dir }).length, 3)
      assert.equal(pruneOutbox({ dir, now: NOW_MS, keepMs: 2 * HOUR }), 1, '恰好满 keepMs 的也清')
      assert.equal(listOutbox({ chatId, dir }).length, 2)
      assert.equal(pruneOutbox({ dir: join(dir, 'nope') }), 0)
      // 记账时每个目录每 6 小时顺手清一次：没满 6 小时旧条目照记；满了清掉 7 天前的
      const sub = join(dir, 'sub')
      recordOutbox({ chatId: 'oc_p', phase: 'done', text: 'a', now: NOW_MS, dir: sub })
      recordOutbox({ chatId: 'oc_p', phase: 'done', text: 'old', now: NOW_MS - 8 * 24 * HOUR, dir: sub })
      assert.deepEqual(listOutbox({ chatId: 'oc_p', dir: sub }).map((e) => e.text), ['a', 'old'])
      recordOutbox({ chatId: 'oc_p', phase: 'done', text: 'b', now: NOW_MS + 6 * HOUR, dir: sub })
      assert.deepEqual(listOutbox({ chatId: 'oc_p', dir: sub }).map((e) => e.text), ['a', 'b'])
    }],
    ['obligations：open → acked → answered / held / owed；超时 4h 只提醒一次；发件簿里有结论就补记', () => {
      const chatId = 'oc_ob'
      const t = { id: 'om_1', chatId, operator: 'ou_u' }
      const t2 = { id: 'om_2', chatId, operator: 'ou_u', privateOrigin: { anchorId: 'om_1' } }
      assert.equal(obligationIdFor(t2), 'om_1', '私聊指示任务挂在它针对的群消息上')
      assert.equal(obligationIdFor({ id: 'x' }), 'x')
      assert.equal(obligationIdFor(null), null)
      assert.equal(getObligation(t), null)
      assert.equal(getObligation({ id: 'om_1' }), null, '没 chatId')
      const acked = noteAck({ task: t, text: '收到，我看一下', now: NOW_MS })
      assert.deepEqual([acked.state, acked.ackText, acked.ackedAt, acked.asker, acked.taskIds], ['acked', '收到，我看一下', iso(NOW_MS), 'ou_u', ['om_1']])
      noteAck({ task: t2, text: '再收到', now: NOW_MS + 1000 })
      assert.deepEqual([getObligation(t).ackedAt, getObligation(t).ackText, getObligation(t).taskIds], [iso(NOW_MS), '再收到', ['om_1', 'om_2']], '首次 ackedAt 不动，taskIds 累加')
      noteAck({ task: { chatId, privateOrigin: { anchorId: 'om_1' } }, text: '没 id 的', now: NOW_MS + 2000 })
      assert.deepEqual(getObligation(t).taskIds, ['om_1', 'om_2'], '没任务 id 的不往 taskIds 塞')
      assert.deepEqual(listOverdueObligations({ chatIds: [chatId], now: NOW_MS + OVERDUE_AFTER_MS }).map((i) => i.id), [], '恰好 4h 不算超时')
      assert.deepEqual(listOverdueObligations({ chatIds: [chatId], now: NOW_MS + OVERDUE_AFTER_MS + 1 }).map((i) => i.id), ['om_1'])
      assert.deepEqual(listOverdueObligations({ chatIds: ['oc_none'], now: NOW_MS + 5 * HOUR }), [])
      markOverdueNotified({ chatId, id: 'om_1', now: NOW_MS + 5 * HOUR })
      assert.deepEqual(listOverdueObligations({ chatIds: [chatId], now: NOW_MS + 9 * HOUR }), [], '提醒过一次不再提醒')
      markOverdueNotified({ chatId, id: 'nope' })
      const held = noteHeld({ task: t2, text: '草稿', mentions: ['ou_x'], reason: '没提交成', now: NOW_MS + 2 * HOUR })
      assert.equal(held.state, 'held')
      assert.deepEqual(heldDraftFor(t), { text: '草稿', mentions: ['ou_x'], reason: '没提交成', taskId: 'om_2', at: iso(NOW_MS + 2 * HOUR) })
      assert.deepEqual(listOverdueObligations({ chatIds: [chatId], now: NOW_MS + 9 * HOUR }), [], 'held 不算答应了没结论')
      clearHeldDraft({ task: t, now: NOW_MS + 2 * HOUR })
      assert.equal(heldDraftFor(t), null)
      noteHeld({ task: t, text: '草稿 2', now: NOW_MS + 2.5 * HOUR })
      const answered = noteAnswer({ task: t, text: '结论', now: NOW_MS + 3 * HOUR })
      assert.deepEqual([answered.state, answered.answerText, answered.answerTaskId, 'heldDraft' in answered], ['answered', '结论', 'om_1', false], '有结论了草稿作废')
      // heldAt 只增不删（11-03 第二次 review：「就这样回」靠它判锚点扣过草稿没有）：清草稿、再扣、发结论都不动第一次扣下的时刻
      assert.equal(answered.heldAt, iso(NOW_MS + 2 * HOUR))
      noteOwed({ task: t, status: 'failed', now: NOW_MS + 4 * HOUR })
      assert.equal(getObligation(t).state, 'answered', '答过的不退回 owed')
      const t3 = { id: 'om_3', chatId, operator: 'ou_v' }
      noteAck({ task: t3, text: '收到', now: NOW_MS })
      const owed = noteOwed({ task: t3, status: 'failed', now: NOW_MS + HOUR })
      assert.deepEqual([owed.state, owed.owedStatus, owed.owedAt], ['owed', 'failed', iso(NOW_MS + HOUR)])
      assert.deepEqual(listOverdueObligations({ chatIds: [chatId], now: NOW_MS + 9 * HOUR }), [], 'owed 不算超时')
      const t4 = { id: 'om_4', chatId, operator: 'ou_w' }
      noteAck({ task: t4, text: '收到', now: NOW_MS })
      markAnsweredFromOutbox({ chatId, id: 'om_4', entry: { at: iso(NOW_MS + HOUR), taskId: 'om_4', text: '发件簿里的结论' }, now: NOW_MS + 2 * HOUR })
      assert.deepEqual([getObligation(t4).state, getObligation(t4).answeredAt, getObligation(t4).answerText, getObligation(t4).answerTaskId], ['answered', iso(NOW_MS + HOUR), '发件簿里的结论', 'om_4'])
      markAnsweredFromOutbox({ chatId, id: 'nope', entry: {} })
      // b4 波 6 E3：@bot 开 open（再记一次不动首次时刻 / 原话）；超过 30 分钟仍 open 才列；回过「收到」的不列；查结后不再列
      const ua = 'oc_ua'
      noteAddressed({ chatId: ua, messageId: 'om_a1', asker: 'ou_a', text: '第一句'.repeat(30), now: NOW_MS })
      noteAddressed({ chatId: ua, messageId: 'om_a1', asker: 'ou_a', text: '再投一次', now: NOW_MS + MIN })
      noteAddressed({ chatId: ua, messageId: 'om_a2', asker: 'ou_b', now: NOW_MS })
      noteAck({ task: { id: 'om_a2', chatId: ua, operator: 'ou_b' }, text: '收到', now: NOW_MS })
      assert.deepEqual([getObligation({ id: 'om_a1', chatId: ua }).addressedAt, getObligation({ id: 'om_a1', chatId: ua }).text.length], [iso(NOW_MS), 80])
      assert.deepEqual(listUnansweredAddressed({ chatIds: [ua], now: NOW_MS + UNANSWERED_AFTER_MS }), [], '恰好 30 分钟不算')
      assert.deepEqual(listUnansweredAddressed({ chatIds: [ua], now: NOW_MS + UNANSWERED_AFTER_MS + 1 }).map((i) => [i.id, i.asker]), [['om_a1', 'ou_a']])
      settleAddressed({ chatId: ua, id: 'om_a1', how: 'replied', now: NOW_MS + HOUR })
      assert.deepEqual([getObligation({ id: 'om_a1', chatId: ua }).state, getObligation({ id: 'om_a1', chatId: ua }).answeredAt], ['answered', iso(NOW_MS + HOUR)])
      assert.deepEqual(listUnansweredAddressed({ chatIds: [ua], now: NOW_MS + 2 * HOUR }), [])
      settleAddressed({ chatId: ua, id: 'nope', how: 'notified' })
      assert.equal(getObligation({ id: 'nope', chatId: ua }), null)
      assert.equal(noteOwed({ task: { id: 'x' }, status: 'failed' }), null, '没 chatId 记不了')
      // 落盘时顺手清 7 天没动过的：恰好 7 天的还留着，过了才清（om_3 最后动在 +1h）
      noteAck({ task: { id: 'om_5', chatId, operator: 'ou_5' }, text: '收到', now: NOW_MS + 7 * 24 * HOUR + HOUR })
      assert.ok(getObligation(t3), '恰好 7 天的还留着')
      noteAck({ task: { id: 'om_6', chatId, operator: 'ou_6' }, text: '收到', now: NOW_MS + 7 * 24 * HOUR + HOUR + 1 })
      assert.equal(getObligation(t3), null, '过了 7 天清掉')
      assert.ok(getObligation(t4), '没到 7 天的还在')
      const file = join(dir, 'obligations', 'oc_ob.json')
      assert.ok(existsSync(file), '落盘到 LARK_OBLIGATIONS_DIR')
      assert.equal((statSync(file).mode & 0o777).toString(8), '600')
    }],
    // 11-03 合入前 review：B 的消息并入 A 重开（mergeTaskObjects 把 B 记进 A.answerFor），结论发出时原先只记 A 的义务，B 的一直 acked。
    ['obligations：重开并入的来源（answerFor）随结论一并记 answered；已答过的 / 没开过义务的不动', () => {
      const chatId = 'oc_ob_merge'
      const b = { id: 'om_b', chatId, operator: 'ou_b' }
      const c = { id: 'om_c', chatId, operator: 'ou_c' }
      noteAck({ task: b, text: '收到', now: NOW_MS })
      noteAnswer({ task: c, text: 'c 的旧结论', now: NOW_MS })
      const a = { id: 'om_a', chatId, operator: 'ou_b', answerFor: ['om_b', 'om_c', 'om_none'] }
      const own = noteAnswer({ task: a, text: '差别是这三处', now: NOW_MS + HOUR })
      assert.deepEqual([own.id, own.state], ['om_a', 'answered'], '返回的仍是本任务自己的义务')
      const ob = getObligation(b)
      assert.deepEqual([ob.state, ob.answeredAt, ob.answerTaskId, ob.answerText, ob.updatedAt, ob.ackText], ['answered', iso(NOW_MS + HOUR), 'om_a', '差别是这三处', iso(NOW_MS + HOUR), '收到'])
      assert.deepEqual([getObligation(c).answerText, getObligation(c).answeredAt], ['c 的旧结论', iso(NOW_MS)], '已答过的不覆盖')
      assert.equal(getObligation({ id: 'om_none', chatId }), null, '没开过义务的不凭空建')
      assert.equal(noteAnswer({ task: { id: 'x', answerFor: ['om_b'] }, text: 'y' }), null, '没 chatId 记不了')
      assert.equal(existsSync(join(dir, 'obligations', 'undefined.json')), false, '没 chatId 不落盘')
    }],
    ['persona：读 / 截断 / 没文件；people：记一笔（upsert、主题去重 ≤10、原子 0600）、描述、画像块；测试里不给 path 不落盘', () => {
      const personaPath = join(dir, 'persona', 'aven.md')
      assert.equal(loadPersona({ path: personaPath }), null)
      assert.equal(personaBlock({ path: personaPath }), '')
      writeFileSync(join(dir, 'blank.md'), '  \n')
      assert.equal(loadPersona({ path: join(dir, 'blank.md') }), null, '只有空白当没有')
      writeFileSync(join(dir, 'aven.md'), '\n我是 aven。\n归我的：web 前端。\n')
      assert.equal(loadPersona({ path: join(dir, 'aven.md') }), '我是 aven。\n归我的：web 前端。')
      assert.equal(personaBlock({ path: join(dir, 'aven.md') }), '【负责人（aven）的说明，以他的口吻和取舍判断】\n我是 aven。\n归我的：web 前端。')
      assert.equal(personaBlock({ path: join(dir, 'aven.md'), maxChars: 7 }), '【负责人（aven）的说明，以他的口吻和取舍判断】\n我是 aven（截断）')
      assert.equal(personaBlock({ path: join(dir, 'aven.md'), maxChars: 20 }).endsWith('web 前端。'), true, '恰好不超不截')
      const peoplePath = join(dir, 'people', 'people.json')
      assert.deepEqual(loadPeople({ path: peoplePath }), {})
      writeFileSync(join(dir, 'bad.json'), '[1]')
      assert.deepEqual(loadPeople({ path: join(dir, 'bad.json') }), {}, '不是对象当空')
      writeFileSync(join(dir, 'null.json'), 'null')
      assert.deepEqual(loadPeople({ path: join(dir, 'null.json') }), {})
      writeFileSync(join(dir, 'odd.json'), JSON.stringify({ ou_odd: 'not-an-object', ou_arr: { name: 'x', topics: 'bad', askedCount: 'NaN' } }))
      assert.deepEqual(notePerson({ openId: 'ou_odd', now: NOW_MS, path: join(dir, 'odd.json') }).askedCount, 1, '坏条目当没有')
      assert.deepEqual(notePerson({ openId: 'ou_arr', topic: 't', now: NOW_MS, path: join(dir, 'odd.json') }).topics, [{ topic: 't', at: iso(NOW_MS), taskId: null }], 'topics 不是数组当空')
      assert.equal(notePerson({ openId: '', name: 'x', path: peoplePath }), null)
      assert.equal(notePerson({ openId: 'ou_u', name: '小王', topic: 't' }), null, 'node --test 下不给 path 不落盘')
      assert.equal(existsSync(peoplePath), false)
      const first = notePerson({ openId: 'ou_u', name: '小王', role: 'QA', topic: ' 登录 ', chatId: 'oc_g', taskId: 'om_1', now: NOW_MS, path: peoplePath })
      assert.deepEqual(first, { openId: 'ou_u', name: '小王', role: 'QA', askedCount: 1, firstSeenAt: iso(NOW_MS), lastSeenAt: iso(NOW_MS), lastChatId: 'oc_g', lastTaskId: 'om_1', topics: [{ topic: '登录', at: iso(NOW_MS), taskId: 'om_1' }] })
      assert.equal((statSync(peoplePath).mode & 0o777).toString(8), '600')
      assert.equal(existsSync(`${peoplePath}.tmp`), false)
      const second = notePerson({ openId: 'ou_u', topic: '登录', taskId: 'om_2', now: NOW_MS + MIN, path: peoplePath })
      assert.deepEqual([second.name, second.role, second.askedCount, second.firstSeenAt, second.lastSeenAt, second.lastChatId, second.lastTaskId], ['小王', 'QA', 2, iso(NOW_MS), iso(NOW_MS + MIN), 'oc_g', 'om_2'], '没给的字段沿用旧的')
      assert.deepEqual(second.topics, [{ topic: '登录', at: iso(NOW_MS + MIN), taskId: 'om_2' }], '同主题去重、取最新')
      for (let i = 0; i < 11; i += 1) notePerson({ openId: 'ou_u', topic: `主题${i}`, now: NOW_MS + (i + 2) * MIN, path: peoplePath })
      const capped = loadPeople({ path: peoplePath }).ou_u
      assert.equal(capped.topics.length, 10)
      assert.deepEqual([capped.topics[0].topic, capped.topics.at(-1).topic, capped.askedCount, capped.lastTaskId], ['主题10', '主题1', 13, 'om_2'])
      notePerson({ openId: 'ou_v', now: NOW_MS, path: peoplePath })
      assert.deepEqual(loadPeople({ path: peoplePath }).ou_v.topics, [])
      assert.equal(JSON.parse(readFileSync(peoplePath, 'utf8')).ou_u.name, '小王')
      const people = loadPeople({ path: peoplePath })
      assert.equal(describePerson('ou_u', { people }), '小王（QA）')
      assert.equal(describePerson('ou_u', { people: { ou_u: { name: '小王' } } }), '小王')
      assert.equal(describePerson('ou_u', { people: { ou_u: { name: '小王' } }, memberRoles: { ou_u: '前端' } }), '小王（前端）', '画像没角色看配置')
      assert.equal(describePerson('ou_u', { people: { ou_u: { name: '小王', role: 'QA' } }, memberRoles: { ou_u: '前端' } }), '小王（QA）', '画像角色优先')
      assert.equal(describePerson('ou_z', { memberRoles: { ou_z: { name: '老张', role: '产品' } } }), '老张（产品）')
      assert.equal(describePerson('ou_z', { memberRoles: { ou_z: { name: '老张' } } }), '老张')
      assert.equal(describePerson('ou_z', { ownerMap: { 产品: 'ou_z' } }), '未登记成员（ou_z）', 'ownerMap 只给角色、没名字')
      assert.equal(describePerson('ou_z', { people: { ou_z: { name: '老张' } }, ownerMap: { 产品: 'ou_z' } }), '老张（产品）')
      // personName（11-05：任务上记 operatorName）：画像名 > memberRoles 名 > ownerMap 键；都没有 / 没 open_id → null
      assert.deepEqual([
        personName('ou_z', { people: { ou_z: { name: '老张' } }, memberRoles: { ou_z: { name: '张三' } }, ownerMap: { Zed: 'ou_z' } }),
        personName('ou_z', { people: { ou_z: { role: 'QA' } }, memberRoles: { ou_z: { name: '张三' } }, ownerMap: { Zed: 'ou_z' } }),
        personName('ou_z', { memberRoles: { ou_z: '前端' }, ownerMap: { Zed: 'ou_z' } }),
        personName('ou_z', { ownerMap: { Zed: 'ou_y' } }),
        personName(null, { ownerMap: { Zed: null } }),
        personName('ou_z'),
      ], ['老张', '张三', 'Zed', null, null, null])
      assert.equal(describePerson('ou_none'), '未登记成员（ou_none）')
      assert.equal(describePerson(''), '未登记成员（?）')
      assert.equal(peopleBlock({ openIds: ['ou_u', 'ou_u', 'ou_v', 'ou_none', null], people }), '【这些人的画像（自动累积）】\n- 小王（QA）：找过 bot 13 次，最近聊过：主题10 / 主题9 / 主题8')
      assert.equal(peopleBlock({ openIds: ['ou_v'], people }), '', '没名字的不列')
      assert.equal(peopleBlock({ openIds: [], people }), '')
      assert.equal(peopleBlock({ openIds: ['ou_u'], people: { ou_u: { openId: 'ou_u', name: '小王' } } }), '【这些人的画像（自动累积）】\n- 小王：找过 bot 0 次')
      assert.ok(peopleBlock({ openIds: ['ou_u'], people, maxChars: 30 }).endsWith('（截断）'))
    }],
  ], {
    before: () => {
      dir = mkdtempSync(join(tmpdir(), 'lark-conv-'))
      process.env.LARK_OUTBOX_DIR = dir
      process.env.LARK_OBLIGATIONS_DIR = join(dir, 'obligations')
    },
    after: () => {
      delete process.env.LARK_OUTBOX_DIR
      delete process.env.LARK_OBLIGATIONS_DIR
      rmSync(dir, { recursive: true, force: true })
    },
  }))
})
