#!/usr/bin/env node
// 负责人私聊 = 仓库控制通道：锚定 / 分流 / 指示任务形状（2026-10-14 真机：私聊回复建成 fameex hotfix 并催办）。

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  anchorHead,
  buildPrincipalInstructionTask,
  decidePrincipalAction,
  isReleaseHeldReply,
  latestReceiptAt,
  resolvePrincipalAnchor,
  resolvePrincipalProfile,
} from '../lib/lark-principal-channel.mjs'

const AVEN = 'ou_aven'
const P2P = 'oc_p2p'
const profile = { key: 'falive', isDefault: false, projectKey: 'FALIVE', title: 'falive', notifyChatId: AVEN, ownership: { me: 'aven', meOpenIds: [AVEN] } }
const fameex = { key: 'fameex', isDefault: true }
const at = (iso) => ({ messageId: `om_r_${iso}`, kind: 'suspected', createdAt: iso })
const makeStore = (tasks) => ({
  list: () => tasks,
  get: (id) => tasks.find((task) => task.id === id) || null,
  findTaskByAnyReceipt: (id) => tasks.find((task) => (task.receipts || []).some((receipt) => receipt.messageId === id)) || null,
  findByReceiptMessageId: () => null,
})
const msg = (over = {}) => ({ messageId: 'om_msg', chatId: P2P, chatType: 'p2p', senderOpenId: AVEN, text: '是', replyTo: null, replyToDirect: null, ...over })
const NOW = Date.parse('2026-10-14T13:23:00Z')

describe('resolvePrincipalProfile', () => {
  it('按 notifyChatId 或 meOpenIds 找到负责人的仓；默认仓与外人不算', () => {
    assert.equal(resolvePrincipalProfile({ senderOpenId: AVEN, profiles: [fameex, profile] }), profile)
    assert.equal(resolvePrincipalProfile({ senderOpenId: 'ou_other', profiles: [fameex, profile] }), null)
    assert.equal(resolvePrincipalProfile({ senderOpenId: AVEN, profiles: [fameex] }), null)
  })
})

describe('resolvePrincipalAnchor', () => {
  const repoTask = { id: 'om_group', repo: 'falive', chatId: 'oc_group', status: 'ignore', receipts: [at('2026-10-14T13:17:00Z')] }
  const olderRepo = { id: 'om_old', repo: 'falive', chatId: 'oc_group', status: 'waiting_confirmation', receipts: [at('2026-10-14T10:00:00Z')] }
  const fameexP2p = { id: 'om_fx', chatId: P2P, status: 'blocked', receipts: [{ messageId: 'om_fxr', kind: 'blocked', createdAt: '2026-10-14T12:00:00Z' }] }

  it('没回复任何消息：锚到 bot 最近一条私聊通知所属的仓库任务', () => {
    const anchor = resolvePrincipalAnchor({ msg: msg(), store: makeStore([olderRepo, repoTask, fameexP2p]), profile, now: NOW })
    assert.deepEqual({ id: anchor.task.id, via: anchor.via }, { id: 'om_group', via: 'recent' })
  })
  it('最近一条私聊是 fameex 任务的回执 → 不锚定，放行老路径', () => {
    const newerFameex = { ...fameexP2p, receipts: [{ messageId: 'om_fxr', kind: 'blocked', createdAt: '2026-10-14T13:20:00Z' }] }
    assert.equal(resolvePrincipalAnchor({ msg: msg(), store: makeStore([repoTask, newerFameex]), profile, now: NOW }), null)
  })
  it('超过窗口 → 不锚定', () => {
    assert.equal(resolvePrincipalAnchor({ msg: msg(), store: makeStore([repoTask]), profile, now: NOW, windowMs: 60_000 }), null)
  })
  it('回复了某条仓库私聊通知 → 锚到那条（哪怕不是最近的）', () => {
    const anchor = resolvePrincipalAnchor({ msg: msg({ replyToDirect: 'om_r_2026-10-14T10:00:00Z' }), store: makeStore([olderRepo, repoTask]), profile, now: NOW })
    assert.deepEqual({ id: anchor.task.id, via: anchor.via }, { id: 'om_old', via: 'reply' })
  })
  it('回复的是 fameex 任务的回执 → null（由老控制通道处理）', () => {
    assert.equal(resolvePrincipalAnchor({ msg: msg({ replyToDirect: 'om_fxr' }), store: makeStore([repoTask, fameexP2p]), profile, now: NOW }), null)
  })
  it('显式「继续任务 <id>」→ 锚到点名的那条（不是最近一条），带 directive；点名的不是本仓 / 不存在 → null 走老路径', () => {
    // 2026-10-16 真机：「继续任务 om_old 确认扩大范围」被 recent 锚到 William 刚 @bot 的 om_group，结论对着 William 说。
    const anchor = resolvePrincipalAnchor({ msg: msg({ text: '继续任务 om_old 确认扩大范围' }), store: makeStore([olderRepo, repoTask]), profile, now: NOW })
    assert.deepEqual({ id: anchor.task.id, via: anchor.via, directive: anchor.directive }, { id: 'om_old', via: 'explicit', directive: { taskId: 'om_old', supplementText: '确认扩大范围' } })
    assert.equal(decidePrincipalAction(anchor.task), 'resume')
    assert.equal(resolvePrincipalAnchor({ msg: msg({ text: '继续任务 om_fx 做' }), store: makeStore([repoTask, fameexP2p]), profile, now: NOW }), null)
    assert.equal(resolvePrincipalAnchor({ msg: msg({ text: '继续任务 om_nope 做' }), store: makeStore([repoTask]), profile, now: NOW }), null)
  })
  it('没有任何回执的任务不参与锚定', () => {
    assert.equal(latestReceiptAt({ receipts: [] }), 0)
    assert.equal(resolvePrincipalAnchor({ msg: msg(), store: makeStore([{ id: 'x', repo: 'falive', chatId: 'oc_group', status: 'done' }]), profile, now: NOW }), null)
  })
})

describe('decidePrincipalAction / buildPrincipalInstructionTask', () => {
  it('挂着的任务续跑；其它状态建指示任务', () => {
    assert.equal(decidePrincipalAction({ status: 'waiting_confirmation' }), 'resume')
    assert.equal(decidePrincipalAction({ status: 'blocked' }), 'resume')
    for (const status of ['ignore', 'running', 'done', 'queued', 'superseded']) assert.equal(decidePrincipalAction({ status }), 'instruct')
  })
  it('指示任务：身份是私聊消息，群 / 发送人 / 话题沿用原群消息，带 privateOrigin 与 @bot 语义', () => {
    const anchor = {
      id: 'om_group', chatId: 'oc_group', operator: 'ou_encone', threadRootId: 'om_root', status: 'ignore',
      text: '@Aven.Bot API 有问题，能不能自己修了', summary: '@Aven.Bot API 有问题，能不能自己修了', attachments: [{ type: 'image', path: '/a.png' }],
      intake: { classification: { decision: 'ignore', reason: '要我们改后端' } },
    }
    const task = buildPrincipalInstructionTask({ msg: msg({ text: '这个要求应该礼貌拒绝，因为我们目前只负责 web 端' }), anchor, profile, attachments: [], commandType: null, now: new Date(NOW) })
    assert.equal(task.id, 'om_msg')
    assert.equal(task.chatId, 'oc_group')
    assert.equal(task.operator, 'ou_encone')
    assert.equal(task.threadRootId, 'om_root')
    assert.equal(task.repo, 'falive')
    assert.equal(task.status, 'received')
    assert.equal(task.intake.trigger, 'principal_private')
    assert.equal(task.addressedToBot, true)
    assert.equal(task.fromPrincipal, true)
    assert.deepEqual(task.privateOrigin, { chatId: P2P, senderOpenId: AVEN, anchorId: 'om_group', anchorHead: '@Aven.Bot API 有问题，能不能自己修了' })
    assert.match(task.text, /^【aven 私聊指示】这个要求应该礼貌拒绝/)
    assert.equal(task.summary, '@Aven.Bot API 有问题，能不能自己修了', '标题用被锚群消息，不带私聊原话（aven 2026-10-20 review C1）')
    assert.doesNotMatch(task.summary, /礼貌拒绝|私聊/)
    assert.match(task.text, /【指示针对的群消息（任务 om_group，当前 ignore，之前判定 ignore：要我们改后端）】\n@Aven\.Bot API 有问题/)
    assert.equal(task.attachments.length, 1)
    assert.equal(anchorHead({ summary: '【话题补充 12:00】第一行\n第二行' }), '第一行')
  })
})

describe('放行被扣下的群回复（教训 #56）', () => {
  it('以放行说法开头的短句才算；带别的要求 / 回滚 / 发布不算', () => {
    for (const text of ['就这样回，哪里拿不准了', '就这样回', '照发', '发吧', '直接发', '可以发', '就按这个回', '按原文发群里']) assert.equal(isReleaseHeldReply(text), true, text)
    for (const text of ['回复一下 Encone 他问的那个', '改成「都通了」再发', '回滚这条', '发布到 pre', '回头再说', '', '就这样回'.padEnd(41, '。')]) assert.equal(isReleaseHeldReply(text), false, text)
  })
})
