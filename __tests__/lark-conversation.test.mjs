import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { buildAnchorBlock, buildConversationContext, buildSenderActivityBlock, resolveDefaultAnchor } from '../lib/lark-conversation.mjs'
import { recordOutbox } from '../lib/lark-outbox.mjs'
import { createTaskStore } from '../lib/lark-task-store.mjs'

const T = Date.parse('2026-10-15T09:49:46Z')
const card = { taskId: 'om_db15b8a9', topic: 'new#63a595', phase: 'done', at: '2026-10-15T09:48:30Z', text: '<at id=ou_arthur></at> 那次请求信息如下\n需要的话我重跑一次' }

describe('默认锚点（阶段 4）：短指代句接 bot 上一句', () => {
  it('Arthur「@Aven.Bot 重跑一次」，bot 1 分钟前对他说过 → 锚到那条任务', () => {
    const anchor = resolveDefaultAnchor({ text: '@Aven.Bot 重跑一次', lastOutbox: card, nowMs: T })
    assert.equal(anchor.taskId, 'om_db15b8a9')
    assert.equal(anchor.topic, 'new#63a595')
    assert.equal(anchor.text, '那次请求信息如下 需要的话我重跑一次')
    assert.match(buildAnchorBlock(anchor), /【默认接着 bot 上一句】bot 09:48 对他说（任务 om_db15b8a9，主题 new#63a595）/)
  })
  it('有引用 / 太长 / 没指代 / bot 那句超过 15 分钟 / 没说过 → 不锚', () => {
    assert.equal(resolveDefaultAnchor({ text: '@Aven.Bot 重跑一次', replyTo: 'om_x', lastOutbox: card, nowMs: T }), null)
    assert.equal(resolveDefaultAnchor({ text: '@Aven.Bot 预约的部份要改下 matchId 已经完全移除了 要改方式请求', lastOutbox: card, nowMs: T }), null)
    assert.equal(resolveDefaultAnchor({ text: '@Aven.Bot 验证码发布了', lastOutbox: card, nowMs: T }), null)
    assert.equal(resolveDefaultAnchor({ text: '@Aven.Bot 重跑一次', lastOutbox: card, nowMs: T + 16 * 60_000 }), null)
    assert.equal(resolveDefaultAnchor({ text: '@Aven.Bot 重跑一次', lastOutbox: null, nowMs: T }), null)
    assert.equal(buildAnchorBlock(null), '')
  })
})

describe('这个人正在进行的事', () => {
  it('发件簿 / 他的任务 / 他参与的台账条目排成一块；都没有返回空', () => {
    const block = buildSenderActivityBlock({
      senderLabel: 'Arthur（hichat / 账号后端）',
      outbox: [card],
      tasks: [{ id: 'om_db15b8a9', createdAt: '2026-10-15T09:44:33Z', topic: 'q:om_db15b8a9', status: 'done', summary: '要请求明细' }],
      ledgerItems: [{ id: 'new#63a595', status: 'applied', title: '后端问 hichat_token 401 那次复测的调用时间' }],
    })
    assert.match(block, /^【Arthur（hichat \/ 账号后端） 正在进行的事/)
    assert.match(block, /09:48 bot 对他说（done，主题 new#63a595）：那次请求信息如下 需要的话我重跑一次/)
    assert.match(block, /他 09:44 的消息 id=om_db15b8a9 主题=q:om_db15b8a9 状态=done：要请求明细/)
    assert.match(block, /台账 new#63a595（applied）后端问 hichat_token 401/)
    assert.equal(buildSenderActivityBlock({}), '')
  })

  it('buildConversationContext：只取同群同人、2 小时内；别人的卡不算；锚点来自 bot 对他最后一句', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lark-conv-'))
    const tasksDir = mkdtempSync(join(tmpdir(), 'lark-conv-tasks-'))
    process.env.LARK_OUTBOX_DIR = dir
    try {
      const store = createTaskStore({ tasksDir, leaseMs: 60_000 })
      store.upsert({ id: 'om_old', repo: 'falive', chatId: 'oc_x', operator: 'ou_arthur', status: 'done', topic: 'q:om_old', summary: '太早的', createdAt: '2026-10-15T06:00:00Z' })
      store.upsert({ id: 'om_db15b8a9', repo: 'falive', chatId: 'oc_x', operator: 'ou_arthur', status: 'done', topic: 'q:om_db15b8a9', summary: '要请求明细', createdAt: '2026-10-15T09:44:33Z' })
      store.upsert({ id: 'om_ache', repo: 'falive', chatId: 'oc_x', operator: 'ou_ache', status: 'done', topic: 'x', summary: '别人的', createdAt: '2026-10-15T09:45:00Z' })
      recordOutbox({ chatId: 'oc_x', taskId: 'om_ache', phase: 'ack', to: 'ou_ache', text: '对 Ache 说的', now: Date.parse('2026-10-15T09:47:00Z') })
      recordOutbox({ chatId: 'oc_x', taskId: 'om_db15b8a9', topic: 'new#63a595', phase: 'done', to: 'ou_arthur', text: card.text, now: Date.parse(card.at) })
      const ledger = { items: { 'new#63a595': { id: 'new#63a595', status: 'applied', title: 't', updatedAt: '2026-10-15T09:48:00Z', lastEvent: { sender: 'ou_arthur' } }, 'x#1': { id: 'x#1', status: 'open', title: 'o', lastEvent: { sender: 'ou_ache' } } } }
      const out = buildConversationContext({ store, ledger, repo: { key: 'falive' }, msg: { messageId: 'om_new', chatId: 'oc_x', senderOpenId: 'ou_arthur', text: '@Aven.Bot 重跑一次', replyTo: null }, senderLabel: 'Arthur', nowMs: T })
      assert.equal(out.anchor.taskId, 'om_db15b8a9')
      assert.match(out.activityBlock, /id=om_db15b8a9/)
      assert.doesNotMatch(out.activityBlock, /om_old|别人的|对 Ache 说的|x#1/)
      assert.match(out.activityBlock, /台账 new#63a595/)
      const none = buildConversationContext({ store, ledger, repo: { key: 'falive' }, msg: { messageId: 'om_new', chatId: 'oc_x', senderOpenId: 'ou_nobody', text: '重跑一次' }, nowMs: T })
      assert.equal(none.anchor, null)
      assert.equal(none.activityBlock, '')
    } finally {
      delete process.env.LARK_OUTBOX_DIR
      rmSync(dir, { recursive: true, force: true })
      rmSync(tasksDir, { recursive: true, force: true })
    }
  })
})
