import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { chatListMessageToEvent, flattenThreadReplies, isPollableMessage, nextDelayMs, parseKernSleepTime, startChatPoller, toEpochMs } from '../lib/lark-chat-poller.mjs'
import { extractInlineFileAttachments, hasDocAttachment, normalizeMessage, parseTextAndAttachments, resolveMessageTrigger } from '../lib/lark-message.mjs'
import { DEFAULT_POLL, registerRepoProfiles, resetRepoProfiles } from '../lib/lark-repo-profile.mjs'
import { pickRecentContext, pickThreadContext } from '../lib/lark-chat-context.mjs'
import { imageExtFromBytes } from '../lib/lark-cli.mjs'

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
          isLidClosed: async () => false,
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

describe('话题上下文：只留最近 limit 条，带上本群 Aven.Bot 自己的回复（教训 #48）', () => {
  const BOT = 'ou_bot_thread'
  const human = (i) => ({ message_id: `om_${i}`, msg_type: 'text', sender: { id: `ou_${i}`, sender_type: 'user', name: `人${i}` }, content: `第 ${i} 条` })
  it('超过 limit 时保留最新的，顺序仍是从早到晚', () => {
    const messages = Array.from({ length: 50 }, (_, i) => human(i + 1))
    const out = pickThreadContext(messages, { limit: 40 })
    assert.equal(out.length, 40)
    assert.equal(out[0].messageId, 'om_11')
    assert.equal(out.at(-1).messageId, 'om_50')
  })
  it('自家 bot 的卡剥署名、标「bot，我们自己」，不算发言人；别家机器人丢掉；排除本条', () => {
    const messages = [
      human(1),
      { message_id: 'om_b', msg_type: 'interactive', sender: { id: 'cli_x', sender_type: 'app', name: 'Aven.Bot', open_bot_id: BOT }, content: '<card>\n需要的话我重跑一次\n📝 由 aven 的助手整理\n</card>' },
      { message_id: 'om_o', msg_type: 'interactive', sender: { id: 'cli_o', sender_type: 'app', name: '别的机器人', open_bot_id: 'ou_other' }, content: '<card>广告</card>' },
      human(2),
      human(3),
    ]
    const out = pickThreadContext(messages, { excludeIds: ['om_3'], botOpenIds: [BOT] })
    assert.deepEqual(out.map((item) => item.messageId), ['om_1', 'om_b', 'om_2'])
    assert.equal(out[1].sender, 'Aven.Bot（bot，我们自己）')
    assert.equal(out[1].text, '需要的话我重跑一次')
    assert.equal(out[1].senderOpenId, '')
    assert.deepEqual(pickThreadContext(messages, {}).map((item) => item.messageId), ['om_1', 'om_2', 'om_3'], '没配 botOpenIds 时机器人一律不要')
  })
})

describe('图片附件按文件头定扩展名（Read 按扩展名判类型，.img 读成乱码）', () => {
  it('JPEG / PNG / GIF / WebP 识别，其它为 null', () => {
    const pad = (arr) => Buffer.from([...arr, ...new Array(12 - arr.length).fill(0)])
    assert.equal(imageExtFromBytes(pad([0xff, 0xd8, 0xff, 0xe0])), 'jpg')
    assert.equal(imageExtFromBytes(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])), 'png')
    assert.equal(imageExtFromBytes(pad([0x47, 0x49, 0x46, 0x38])), 'gif')
    assert.equal(imageExtFromBytes(Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])), 'webp')
    assert.equal(imageExtFromBytes(pad([0x00, 0x01])), null)
    assert.equal(imageExtFromBytes(Buffer.from([0xff])), null)
  })
})

describe('老消息上新开的话题（2026-10-15 aven 在 Encone 15 分钟前的消息上建话题 @Aven.Bot）', () => {
  it('增量窗口看不到 host；每 threadScanEveryMs 回看一次长窗口，捞到展开的话题回复', async () => {
    registerRepoProfiles({ repos: { falive: { root: '/tmp/falive-react', baseRef: 'main', chatIds: ['oc_falive'], notifyChatId: 'ou_aven' } } })
    const dir = mkdtempSync(join(tmpdir(), 'lark-poller-thread-'))
    const ingested = []
    let nowMs = Date.parse('2026-10-15T16:34:00+04:00')
    const hostMs = nowMs - 15 * 60_000
    let replyVisible = false
    const host = () => ({ message_id: 'om_encone', msg_type: 'text', create_time: String(hostMs), sender: { id: 'ou_encone', sender_type: 'user' }, content: 'google 登陆好了，再试试', thread_id: 'omt_g',
      thread_replies: replyVisible ? [{ message_id: 'om_aven_reply', msg_type: 'text', create_time: String(nowMs), sender: { id: 'ou_aven', sender_type: 'user' }, content: '测试一下，报告回群 @Aven.Bot' }] : [] })
    try {
      const poller = startChatPoller({
        config: {}, store: {}, statePath: join(dir, 'state.json'),
        ingest: async ({ raw }) => ingested.push(raw.message_id),
        deps: {
          now: () => new Date(nowMs),
          setTimeout: () => ({ unref() {} }),
          // 模拟 Lark：只返回 start 之后的消息；话题回复挂在 host 下面
          listChatMessages: async ({ start }) => ({ ok: true, messages: Date.parse(start) <= hostMs ? [host()] : [], hasMore: false, pageToken: null }),
          sendChatMessage: async () => ({ ok: true }),
          listThreadMessages: async () => ({ ok: true, messages: [] }),
          isChatMember: async () => false,
          isLidClosed: async () => false,
        },
      })
      const target = { chatId: 'oc_falive', profile: registerRepoProfiles({ repos: { falive: { root: '/tmp/falive-react', baseRef: 'main', chatIds: ['oc_falive'], notifyChatId: 'ou_aven' } } }).get('falive') }
      await poller.pollOnce(target) // 首轮：回看一次，话题还没回复
      assert.deepEqual(ingested, [])
      replyVisible = true
      nowMs += 60_000
      await poller.pollOnce(target) // 增量窗口里没有 host；回看未到期
      assert.deepEqual(ingested, [])
      nowMs += 70_000
      await poller.pollOnce(target) // 回看到期：捞到话题回复
      assert.deepEqual(ingested, ['om_aven_reply'])
      await poller.pollOnce(target)
      assert.deepEqual(ingested, ['om_aven_reply'], 'seen 去重')
      poller.stop()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('跨系统睡眠的失败不计数（2026-10-16 夜合盖，Power Nap 半醒时轮询超时，体检连报「轮询连续失败」）', () => {
  it('解析 sysctl -n kern.sleeptime；没睡过（sec = 0）/ 乱码为 null', () => {
    assert.equal(parseKernSleepTime('{ sec = 1792204239, usec = 128033 } Sat Oct 17 06:30:39 2026'), 1792204239000)
    assert.equal(parseKernSleepTime('{ sec = 0, usec = 0 }'), null)
    assert.equal(parseKernSleepTime(''), null)
  })

  it('排程后系统入睡过的那轮失败只记 sleepInterrupted；没睡过的失败照常计数', async () => {
    const profile = registerRepoProfiles({ repos: { falive: { root: '/tmp/falive-react', baseRef: 'main', chatIds: ['oc_falive'], notifyChatId: 'ou_aven' } } }).get('falive')
    const dir = mkdtempSync(join(tmpdir(), 'lark-poller-sleep-'))
    const since = Date.parse('2026-10-17T05:23:27+04:00')
    let sleptAt = since + 2_000 // 半醒窗口里发出请求，2 秒后又睡了
    try {
      const poller = startChatPoller({
        config: {},
        store: {},
        statePath: join(dir, 'state.json'),
        ingest: async () => {},
        deps: {
          now: () => new Date(since),
          setTimeout: () => ({ unref() {} }),
          lastSystemSleepAt: async () => sleptAt,
          isChatMember: async () => false,
          isLidClosed: async () => false,
          sendChatMessage: async () => ({ ok: true }),
          listThreadMessages: async () => ({ ok: true, messages: [] }),
          listChatMessages: async () => ({ ok: false, reason: '[lark-cli timeout after 60000ms]', transient: true }),
        },
      })
      await poller.pollOnce({ chatId: 'oc_falive', profile, since })
      let obs = poller.observe().oc_falive
      assert.equal(obs.consecutiveFailures, 0)
      assert.equal(obs.sleepInterrupted, 1)
      assert.match(obs.lastSleepError, /timeout/)
      assert.equal(obs.lastError, null)
      sleptAt = since - 60_000 // 上次入睡在排程之前：这轮醒着失败
      await poller.pollOnce({ chatId: 'oc_falive', profile, since })
      obs = poller.observe().oc_falive
      assert.equal(obs.consecutiveFailures, 1)
      assert.equal(obs.sleepInterrupted, 1)
      sleptAt = null // 取不到入睡时间（非 macOS）：照常计数
      await poller.pollOnce({ chatId: 'oc_falive', profile, since })
      assert.equal(poller.observe().oc_falive.consecutiveFailures, 2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('合盖暂停、开盖补拉（aven 10-17：合盖 bot 下班，开盖后批量处理合盖期间的 @）', () => {
  it('合盖不调列消息、游标不动；开盖一轮把游标之后的消息全部喂入', async () => {
    const profile = registerRepoProfiles({ repos: { falive: { root: '/tmp/falive-react', baseRef: 'main', chatIds: ['oc_falive'], notifyChatId: 'ou_aven' } } }).get('falive')
    const dir = mkdtempSync(join(tmpdir(), 'lark-poller-lid-'))
    const statePath = join(dir, 'state.json')
    let nowMs = Date.parse('2026-10-16T20:21:00+04:00')
    let lidClosed = false
    let backlog = []
    const starts = []
    const ingested = []
    try {
      const poller = startChatPoller({
        config: {},
        store: {},
        statePath,
        ingest: async ({ raw }) => ingested.push(raw.message_id),
        deps: {
          now: () => new Date(nowMs),
          setTimeout: () => ({ unref() {} }),
          isLidClosed: async () => lidClosed,
          isChatMember: async () => false,
          sendChatMessage: async () => ({ ok: true }),
          listThreadMessages: async () => ({ ok: true, messages: [] }),
          listChatMessages: async ({ start }) => {
            starts.push(start)
            return { ok: true, messages: backlog, hasMore: false, pageToken: null }
          },
        },
      })
      await poller.pollOnce({ chatId: 'oc_falive', profile })
      const cursorBefore = JSON.parse(readFileSync(statePath, 'utf8')).chats.oc_falive.cursorMs
      lidClosed = true
      nowMs = Date.parse('2026-10-17T05:28:00+04:00')
      backlog = [
        { message_id: 'om_n1', msg_type: 'text', create_time: String(Date.parse('2026-10-16T23:10:00+04:00')), sender: { id: 'ou_e', sender_type: 'user' }, content: '@Aven.Bot 登录页报错' },
        { message_id: 'om_n2', msg_type: 'text', create_time: String(Date.parse('2026-10-17T02:40:00+04:00')), sender: { id: 'ou_a', sender_type: 'user' }, content: '@Aven.Bot 接口改好了' },
      ]
      const callsBefore = starts.length
      await poller.pollOnce({ chatId: 'oc_falive', profile })
      assert.equal(starts.length, callsBefore, '合盖不拉')
      assert.equal(poller.observe().oc_falive.pausedByLid, true)
      assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).chats.oc_falive.cursorMs, cursorBefore, '游标不动')
      lidClosed = false
      nowMs = Date.parse('2026-10-17T06:44:00+04:00')
      await poller.pollOnce({ chatId: 'oc_falive', profile })
      assert.equal(Date.parse(starts[callsBefore]), cursorBefore - 120_000, '从合盖前的游标起拉')
      assert.deepEqual(ingested, ['om_n1', 'om_n2'])
      assert.equal(poller.observe().oc_falive.pausedByLid, false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('ingest 失败的消息不记 seen、游标不越过它（第 0 批：以前打一行日志就永久丢）', () => {
  it('第一轮 ingest 抛错 → 下一轮重喂成功', async () => {
    const profile = registerRepoProfiles({ repos: { falive: { root: '/tmp/falive-react', baseRef: 'main', chatIds: ['oc_falive'], notifyChatId: 'ou_aven' } } }).get('falive')
    const dir = mkdtempSync(join(tmpdir(), 'lark-poller-retry-'))
    const statePath = join(dir, 'state.json')
    const nowMs = Date.parse('2026-10-17T10:00:00+04:00')
    let failOnce = true
    const ingested = []
    const messages = [
      { message_id: 'om_ok', msg_type: 'text', create_time: String(nowMs + 1000), sender: { id: 'ou_x', sender_type: 'user' }, content: 'a' },
      { message_id: 'om_bad', msg_type: 'text', create_time: String(nowMs + 2000), sender: { id: 'ou_x', sender_type: 'user' }, content: 'b' },
      { message_id: 'om_after', msg_type: 'text', create_time: String(nowMs + 3000), sender: { id: 'ou_x', sender_type: 'user' }, content: 'c' },
    ]
    try {
      const poller = startChatPoller({
        config: {},
        store: {},
        statePath,
        ingest: async ({ raw }) => {
          if (raw.message_id === 'om_bad' && failOnce) { failOnce = false; throw new Error('boom') }
          ingested.push(raw.message_id)
        },
        deps: {
          now: () => new Date(nowMs),
          setTimeout: () => ({ unref() {} }),
          isLidClosed: async () => false,
          isChatMember: async () => false,
          sendChatMessage: async () => ({ ok: true }),
          listThreadMessages: async () => ({ ok: true, messages: [] }),
          listChatMessages: async () => ({ ok: true, messages, hasMore: false, pageToken: null }),
        },
      })
      await poller.pollOnce({ chatId: 'oc_falive', profile })
      let saved = JSON.parse(readFileSync(statePath, 'utf8')).chats.oc_falive
      assert.deepEqual(ingested, ['om_ok', 'om_after'])
      assert.equal(saved.seen.includes('om_bad'), false)
      assert.equal(saved.cursorMs, nowMs + 2000, '游标停在失败那条，不越过')
      await poller.pollOnce({ chatId: 'oc_falive', profile })
      saved = JSON.parse(readFileSync(statePath, 'utf8')).chats.oc_falive
      assert.deepEqual(ingested, ['om_ok', 'om_after', 'om_bad'])
      assert.equal(saved.seen.includes('om_bad'), true)
      assert.equal(saved.cursorMs, nowMs + 3000)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
