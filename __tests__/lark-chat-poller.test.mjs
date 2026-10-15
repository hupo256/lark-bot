import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { chatListMessageToEvent, flattenThreadReplies, isPollableMessage, nextDelayMs, startChatPoller, toEpochMs } from '../lib/lark-chat-poller.mjs'
import { extractInlineFileAttachments, hasDocAttachment, normalizeMessage, parseTextAndAttachments, resolveMessageTrigger } from '../lib/lark-message.mjs'
import { DEFAULT_POLL, registerRepoProfiles, resetRepoProfiles } from '../lib/lark-repo-profile.mjs'
import { pickRecentContext } from '../lib/lark-cli.mjs'

const at = (hour, minute = 0) => new Date(2026, 9, 13, hour, minute, 0)

describe('轮询间隔（aven 定：08–19 活跃 30s / 空闲 120s，夜间 15min，出错退避到 15min）', () => {
  it('工作时段按最近是否有新消息分活跃 / 空闲', () => {
    const now = at(10)
    assert.equal(nextDelayMs({ poll: DEFAULT_POLL, now, lastNewMessageAt: now.getTime() - 5 * 60_000 }), 30_000)
    assert.equal(nextDelayMs({ poll: DEFAULT_POLL, now, lastNewMessageAt: now.getTime() - 31 * 60_000 }), 120_000)
    assert.equal(nextDelayMs({ poll: DEFAULT_POLL, now, lastNewMessageAt: 0 }), 120_000)
  })
  it('19:00 起算夜间；08:00 前也是夜间', () => {
    assert.equal(nextDelayMs({ poll: DEFAULT_POLL, now: at(19), lastNewMessageAt: at(19).getTime() }), 15 * 60_000)
    assert.equal(nextDelayMs({ poll: DEFAULT_POLL, now: at(7, 59), lastNewMessageAt: at(7, 59).getTime() }), 15 * 60_000)
    assert.equal(nextDelayMs({ poll: DEFAULT_POLL, now: at(8), lastNewMessageAt: at(8).getTime() }), 30_000)
  })
  it('出错按 2 倍退避并封顶 15min', () => {
    const now = at(10)
    assert.equal(nextDelayMs({ poll: DEFAULT_POLL, now, consecutiveFailures: 1 }), 30_000)
    assert.equal(nextDelayMs({ poll: DEFAULT_POLL, now, consecutiveFailures: 3 }), 120_000)
    assert.equal(nextDelayMs({ poll: DEFAULT_POLL, now, consecutiveFailures: 6 }), 15 * 60_000)
    assert.equal(nextDelayMs({ poll: DEFAULT_POLL, now, consecutiveFailures: 40 }), 15 * 60_000)
  })
})

describe('列消息 → 事件归一', () => {
  it('lark-cli 列消息形态能被 normalizeMessage 吃下：文本 + @ + 文件占位', () => {
    const event = chatListMessageToEvent({
      message_id: 'om_1',
      msg_type: 'text',
      create_time: '1760342400000',
      sender: { id: 'ou_encone', id_type: 'open_id', sender_type: 'user', name: 'Encone' },
      content: '@Aven 直播档案列表 <file key="file_v3_abc" name="B2B-04-anchor-record-list-对接.md" size="9.9KB"/>',
      mentions: [{ id: 'ou_aven', key: '@_user_1', name: 'Aven' }],
      thread_id: 'omt_9',
    }, { chatId: 'oc_falive' })
    const msg = normalizeMessage(event)
    assert.equal(msg.chatId, 'oc_falive')
    assert.equal(msg.chatType, 'group')
    assert.equal(msg.senderOpenId, 'ou_encone')
    assert.equal(msg.senderType, 'user')
    assert.equal(msg.text, '直播档案列表')
    assert.deepEqual(msg.attachments, [{ type: 'file', fileKey: 'file_v3_abc', fileName: 'B2B-04-anchor-record-list-对接.md' }])
    assert.deepEqual(msg.mentions, [{ id: 'ou_aven', key: '@_user_1', name: 'Aven' }])
    assert.equal(msg.threadRootId, 'omt_9')
  })
  it('文件消息的 JSON content 与行内占位都解析成 file 附件；文档类扩展名才算对接文档', () => {
    assert.deepEqual(parseTextAndAttachments({ messageType: 'file', rawContent: '{"file_key":"file_v3_x","file_name":"api.pdf"}', mentions: [] }), { text: '', attachments: [{ type: 'file', fileKey: 'file_v3_x', fileName: 'api.pdf' }] })
    assert.deepEqual(extractInlineFileAttachments('a <file key="file_1" name="x.md"/> b <file key="file_1" name="x.md"/>'), [{ type: 'file', fileKey: 'file_1', fileName: 'x.md' }])
    assert.equal(hasDocAttachment([{ type: 'file', fileName: '对接.md' }]), true)
    assert.equal(hasDocAttachment([{ type: 'file', fileName: 'demo.mp4' }]), false)
    assert.equal(hasDocAttachment([{ type: 'image', imageKey: 'img_1' }]), false)
  })
  it('只喂真人消息：bot / app / system / 已撤回一律丢', () => {
    assert.equal(isPollableMessage({ message_id: 'om_1', msg_type: 'text', sender: { sender_type: 'user' } }), true)
    assert.equal(isPollableMessage({ message_id: 'om_2', msg_type: 'interactive', sender: { sender_type: 'app' } }), false)
    assert.equal(isPollableMessage({ message_id: 'om_3', msg_type: 'system', sender: { sender_type: 'user' } }), false)
    assert.equal(isPollableMessage({ message_id: 'om_4', msg_type: 'text', deleted: true, sender: { sender_type: 'user' } }), false)
    assert.equal(toEpochMs('1760342400000'), 1760342400000)
    assert.equal(toEpochMs('1760342400'), 1760342400000)
    assert.equal(toEpochMs('2026-10-13T10:00:00+04:00'), Date.parse('2026-10-13T10:00:00+04:00'))
    assert.equal(toEpochMs(''), 0)
  })
  it('对接文档消息无需 @ 即触发只读意图分类（仅配了 docAttachmentsTrigger 的群）', () => {
    const msg = { chatType: 'group', senderType: 'user', mentions: [], attachments: [{ type: 'file', fileName: 'api.md' }] }
    assert.equal(resolveMessageTrigger({ msg, config: { botOpenId: 'ou_bot', docAttachmentsTrigger: true } }), 'task_mention')
    assert.equal(resolveMessageTrigger({ msg, config: { botOpenId: 'ou_bot' } }), null)
  })
})

describe('轮询一轮（IO 全注入）', () => {
  afterEach(() => resetRepoProfiles())

  it('首轮游标从现在起、重叠窗口去重、只喂真人消息、游标推进并落盘；连续失败到阈值告警一次', async () => {
    registerRepoProfiles({ repos: { falive: { root: '/tmp/falive-react', baseRef: 'main', chatIds: ['oc_falive'], notifyChatId: 'ou_aven', title: 'Falive' } } })
    const dir = mkdtempSync(join(tmpdir(), 'lark-poller-'))
    const statePath = join(dir, 'state.json')
    const ingested = []
    const sent = []
    let listCalls = 0
    let failing = false
    const nowMs = Date.parse('2026-10-13T10:00:00+04:00')
    const messages = [
      { message_id: 'om_a', msg_type: 'text', create_time: String(nowMs + 1000), sender: { id: 'ou_x', sender_type: 'user' }, content: 'hi', thread_id: 'omt_1',
        thread_replies: [{ message_id: 'om_a_r1', msg_type: 'text', create_time: String(nowMs + 1500), sender: { id: 'ou_y', sender_type: 'user' }, content: '@Aven 这个要改' }] },
      { message_id: 'om_card', msg_type: 'interactive', create_time: String(nowMs + 2000), sender: { id: 'ou_bot', sender_type: 'app' }, content: '{}' },
    ]
    // 旧话题里后来冒出的回复：不在列消息窗口里，靠话题补抓拿到
    const lateReplies = [{ message_id: 'om_a_r2', msg_type: 'text', create_time: String(nowMs + 90_000), sender: { id: 'ou_z', sender_type: 'user' }, content: '补充字段' }]
    let threadCalls = 0
    let botMember = false
    try {
      const poller = startChatPoller({
        config: {},
        store: {},
        statePath,
        ingest: async ({ raw }) => ingested.push(raw.message_id),
        deps: {
          now: () => new Date(nowMs),
          setTimeout: () => ({ unref() {} }), // 不真正排程，手动 pollOnce
          listChatMessages: async ({ start }) => {
            listCalls += 1
            if (failing) return { ok: false, reason: 'missing_scope', transient: false }
            assert.ok(start)
            return { ok: true, messages, hasMore: false, pageToken: null }
          },
          sendChatMessage: async (args) => { sent.push(args); return { ok: true } },
          listThreadMessages: async ({ threadId }) => { threadCalls += 1; assert.equal(threadId, 'omt_1'); return { ok: true, messages: threadCalls >= 2 ? lateReplies : [] } },
          isChatMember: async () => botMember,
        },
      })
      assert.deepEqual(poller.targets, [{ chatId: 'oc_falive', repo: 'falive' }])
      const target = { chatId: 'oc_falive', profile: { ...registerRepoProfiles({ repos: { falive: { root: '/tmp/falive-react', baseRef: 'main', chatIds: ['oc_falive'], notifyChatId: 'ou_aven' } } }).get('falive') } }
      await poller.pollOnce(target)
      assert.deepEqual(ingested, ['om_a', 'om_a_r1'], '话题回复随 host 一起拍平喂入')
      await poller.pollOnce(target) // 同一批再拉：seen 去重；活跃话题补抓拿到迟到回复
      assert.deepEqual(ingested, ['om_a', 'om_a_r1', 'om_a_r2'])
      const saved = JSON.parse(readFileSync(statePath, 'utf8'))
      assert.equal(saved.chats.oc_falive.cursorMs, nowMs + 90_000)
      assert.deepEqual(saved.chats.oc_falive.seen, ['om_a', 'om_a_r1', 'om_card', 'om_a_r2'])
      assert.equal(saved.chats.oc_falive.threads.omt_1.hostMessageId, 'om_a')
      const flat = flattenThreadReplies(messages[0])
      assert.equal(flat[0].root_id, 'om_a')
      assert.equal(flat[0].thread_id, 'omt_1')
      // 话题键用 root_id（首条消息 id）：首条建任务时还没有 thread_id，回复要能对回去
      assert.equal(normalizeMessage(chatListMessageToEvent(flat[0], { chatId: 'oc_falive' })).threadRootId, 'om_a')
      assert.equal(saved.chats.oc_falive.lastNewMessageAt, nowMs)
      failing = true
      for (let i = 0; i < 10; i += 1) await poller.pollOnce(target)
      assert.equal(poller.observe().oc_falive.consecutiveFailures, 10)
      assert.equal(sent.length, 1, '连续失败 10 次只告警一次')
      assert.equal(sent[0].chatId, 'ou_aven')
      await poller.pollOnce(target)
      assert.equal(sent.length, 1)
      failing = false
      await poller.pollOnce(target)
      assert.equal(poller.observe().oc_falive.consecutiveFailures, 0)
      assert.equal(sent.length, 2, '恢复后发一次恢复通知')
      // 应用机器人进群后：本群停止轮询，不再调列消息接口
      botMember = true
      const callsBefore = listCalls
      await poller.pollOnce(target)
      assert.equal(listCalls, callsBefore)
      assert.equal(poller.observe().oc_falive.skippedBotMember, true)
      botMember = false
      await poller.pollOnce(target)
      assert.equal(listCalls, callsBefore + 1)
      assert.ok(listCalls >= 13)
      poller.stop()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('群里之前的消息：真人 + 本群 Aven.Bot 自己的卡（2026-10-15「重跑一次」）', () => {
  const BOT = 'ou_caf1610a679ff12b9b92204f37572491'
  const messages = [
    { message_id: 'om_1', create_time: '2026-10-15 13:44', msg_type: 'text', sender: { id: 'ou_arthur', sender_type: 'user', name: 'Arthur.a' }, content: '@Aven.Bot 把本次请求时间、请求头提供一下' },
    { message_id: 'om_2', create_time: '2026-10-15 13:48', msg_type: 'interactive', sender: { id: 'cli_x', sender_type: 'app', name: 'Aven.Bot', open_bot_id: BOT }, content: '<card>\n@Arthur.a(ou_arthur) 那次请求信息如下\n需要的话我重跑一次\n📝 由 aven 的助手整理\n</card>' },
    { message_id: 'om_3', create_time: '2026-10-15 13:48', msg_type: 'interactive', sender: { id: 'cli_other', sender_type: 'app', name: '别的机器人', open_bot_id: 'ou_other' }, content: '<card>广告</card>' },
    { message_id: 'om_4', create_time: '2026-10-15 13:49', msg_type: 'text', sender: { id: 'ou_arthur', sender_type: 'user', name: 'Arthur.a' }, content: '@Aven.Bot 重跑一次' },
    { message_id: 'om_5', create_time: '2026-10-15 13:50', msg_type: 'text', sender: { id: 'ou_x', sender_type: 'user', name: '后来的人' }, content: '晚于本条，不该出现' },
  ]
  it('保留真人与自家 bot 的卡（剥 <card> 与署名、标「bot，我们自己」），丢别家机器人、排除本条与晚于本条的', () => {
    const beforeMs = Date.parse('2026-10-15 13:49') + 46_000
    const out = pickRecentContext(messages, { beforeMs, excludeIds: ['om_4'], botOpenIds: [BOT] })
    assert.deepEqual(out.map((item) => item.messageId), ['om_1', 'om_2'])
    assert.equal(out[1].sender, 'Aven.Bot（bot，我们自己）')
    assert.equal(out[1].bot, true)
    assert.equal(out[1].text, '@Arthur.a(ou_arthur) 那次请求信息如下\n需要的话我重跑一次')
    assert.equal(out[0].bot, undefined)
  })
  it('没配 botOpenIds 时机器人消息一律不要（旧行为）', () => {
    const out = pickRecentContext(messages, { beforeMs: Date.parse('2026-10-15 13:49') + 46_000, excludeIds: ['om_4'] })
    assert.deepEqual(out.map((item) => item.messageId), ['om_1'])
  })
})
