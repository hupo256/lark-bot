import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { chatListMessageToEvent } from '../lib/lark-chat-poller.mjs'
import { sendBotMarkdown, sendChatMessage } from '../lib/lark-cli.mjs'
import { resolvePrincipalAnchor } from '../lib/lark-principal-channel.mjs'
import { registerRepoProfiles, resetRepoProfiles, resolveWebhookForChat } from '../lib/lark-repo-profile.mjs'
import { createTaskStore } from '../lib/lark-task-store.mjs'
import { CONSOLE_UNANCHORED_HINT, isConsoleMessage, isForeignChat, replyUnanchoredConsole } from '../lib/lark-repo-only.mjs'

// repo-only 实例（falive 独立部署，aven 2026-10-20）：只走 webhook、不用应用机器人身份发任何消息、不碰非仓库群。
const CONSOLE = 'oc_console'
const GROUP = 'oc_external'

describe('repo-only 实例', () => {
  let savedMode
  let savedFetch
  let posted
  beforeEach(() => {
    savedMode = process.env.LARK_INSTANCE_MODE
    savedFetch = globalThis.fetch
    posted = []
    globalThis.fetch = async (url, init) => {
      posted.push({ url, body: JSON.parse(init.body) })
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, msg: 'success' }), json: async () => ({ code: 0, msg: 'success' }) }
    }
    registerRepoProfiles({ repos: { falive: { root: '/tmp/falive', baseRef: 'main', chatIds: [GROUP], notifyChatId: CONSOLE, webhooksByChat: { [CONSOLE]: { url: 'https://hook/console' }, [GROUP]: { url: 'https://hook/group' } } } } })
  })
  afterEach(() => {
    if (savedMode === undefined) delete process.env.LARK_INSTANCE_MODE
    else process.env.LARK_INSTANCE_MODE = savedMode
    globalThis.fetch = savedFetch
    resetRepoProfiles()
  })

  it('按群找登记的 webhook（含不在 chatIds 里的控制台群）', () => {
    assert.equal(resolveWebhookForChat(CONSOLE)?.url, 'https://hook/console')
    assert.equal(resolveWebhookForChat(GROUP)?.url, 'https://hook/group')
    assert.equal(resolveWebhookForChat('oc_internal'), null)
  })

  it('私聊通知与群卡片都直走 webhook；没登记 webhook 的收件人拒发，不回落 bot 身份', async () => {
    process.env.LARK_INSTANCE_MODE = 'repo-only'
    const note = await sendBotMarkdown({ chatId: CONSOLE, markdown: '**完成**', retries: 1 })
    assert.equal(note.ok, true)
    assert.equal(posted[0].url, 'https://hook/console')
    assert.equal(posted[0].body.msg_type, 'interactive')
    assert.equal(posted[0].body.card.elements[0].content, '**完成**')
    // 旧卡片通道发往外部群：一律改发控制台（10-21，外部群只收 sendGroupCard 出口的话）
    const card = await sendChatMessage({ chatId: GROUP, text: 'hi', logPrefix: 't', retries: 1 })
    assert.equal(card.ok, true)
    assert.equal(posted[1].url, 'https://hook/console')
    const refused = await sendBotMarkdown({ chatId: 'ou_someone', markdown: 'x', retries: 1 })
    assert.equal(refused.ok, false)
    assert.match(refused.reason, /repo-only/)
    assert.equal(posted.length, 2)
  })

  it('非仓库群忽略；控制台按 p2p 处理；锚不到任务只回提示', async () => {
    process.env.LARK_INSTANCE_MODE = 'repo-only'
    assert.equal(isForeignChat({ msg: { chatId: 'oc_internal', chatType: 'group', messageId: 'm1' }, repo: null }), true)
    assert.equal(isForeignChat({ msg: { chatId: GROUP, chatType: 'group' }, repo: { key: 'falive' } }), false)
    assert.equal(isConsoleMessage({ chatType: 'p2p' }), true)
    const sent = []
    await replyUnanchoredConsole({ msg: { chatId: CONSOLE, messageId: 'm2', text: '在吗' }, send: async (args) => sent.push(args) })
    assert.deepEqual(sent.map((item) => [item.chatId, item.markdown]), [[CONSOLE, CONSOLE_UNANCHORED_HINT]])
    assert.equal(chatListMessageToEvent({ message_id: 'm3' }, { chatId: CONSOLE, chatType: 'p2p' }).chat_type, 'p2p')
    assert.equal(chatListMessageToEvent({ message_id: 'm4' }, { chatId: GROUP }).chat_type, 'group')
  })

  it('非 repo-only（fameex 那套）守卫全部不生效', () => {
    delete process.env.LARK_INSTANCE_MODE
    assert.equal(isForeignChat({ msg: { chatId: 'oc_internal', chatType: 'group' }, repo: null }), false)
    assert.equal(isConsoleMessage({ chatType: 'p2p' }), false)
  })

  it('webhook 通知没有 message_id 也登记回执：控制台随口回一句能接上最近的任务，回复锚定不受合成 id 影响', () => {
    const dir = mkdtempSync(join(tmpdir(), 'repo-only-receipt-'))
    try {
      const store = createTaskStore({ tasksDir: join(dir, 'tasks'), leaseMs: 60_000 })
      store.upsert({ id: 'om_task1', repo: 'falive', chatId: GROUP, status: 'done', text: 't', summary: '直播预告复测' })
      store.recordReceipt('om_task1', { messageId: undefined, kind: 'done', epoch: 0 })
      const [receipt] = store.get('om_task1').receipts
      assert.match(receipt.messageId, /^webhook:done:/)
      const profile = { key: 'falive' }
      const anchor = resolvePrincipalAnchor({ msg: { chatId: CONSOLE, text: '这条再测一下', replyTo: null, replyToDirect: null }, store, profile })
      assert.equal(anchor?.task.id, 'om_task1')
      assert.equal(anchor?.via, 'recent')
      assert.equal(store.findTaskByAnyReceipt('om_real_reply_target'), null)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
