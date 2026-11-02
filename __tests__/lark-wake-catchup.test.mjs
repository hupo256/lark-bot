import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { chatListMessageToEvent, flattenThreadReplies, isPollableMessage, readLastAliveAt, startWakeCatchup, writeLastAliveAt } from '../lib/lark-wake-catchup.mjs'
import { normalizeMessage } from '../lib/lark-message.mjs'

describe('开盖补拉群消息（长连接睡着时收不到，飞书重推只覆盖约 7 小时的几个时间点）', () => {
  const setup = ({ messages = [], failTimes = 0, lastAlive = null, chats = ['oc_in'], failChats = [], tasks = [{ chatId: 'oc_in', updatedAt: '2026-10-16T16:00:00Z' }] } = {}) => {
    const env = { now: Date.parse('2026-10-16T20:20:00+04:00'), closed: false, sleptAt: Date.parse('2026-10-16T09:00:00+04:00'), calls: [], ingested: [], fail: failTimes, alive: [] }
    const catchup = startWakeCatchup({
      config: {},
      store: { has: (id) => id === 'om_task', list: () => tasks },
      ingest: async ({ raw }) => env.ingested.push(raw.message_id),
      deps: {
        now: () => env.now,
        isLidClosed: async () => env.closed,
        lastSystemSleepAt: async () => env.sleptAt,
        listBotChatIds: async () => chats,
        readLastAliveAt: () => lastAlive,
        writeLastAliveAt: (at) => env.alive.push(at),
        listChatMessages: async ({ chatId, start }) => {
          env.calls.push({ chatId, start })
          if (failChats.includes(chatId)) return { ok: false } // 没带 reason：日志里要落成 list failed
          if (env.fail > 0) {
            env.fail -= 1
            return { ok: false, reason: 'network' }
          }
          return { ok: true, messages, hasMore: false, pageToken: null }
        },
        setInterval: () => ({ unref() {} }),
      },
    })
    return { env, catchup }
  }
  const user = (id) => ({ message_id: id, msg_type: 'text', create_time: '1', sender: { id: 'ou_k', sender_type: 'user' }, content: '{"text":"@_user_1 看下"}', mentions: [{ id: 'ou_aven', key: '@_user_1', name: 'aven' }] })

  it('没睡过、没合盖：不补拉', async () => {
    const { env, catchup } = setup()
    env.now += 60_000
    assert.equal(await catchup.tick(), null)
    assert.deepEqual(env.calls, [])
  })

  it('合盖期间不拉；开盖后从合盖前最后醒着的时刻（减 2 分钟）起补拉 bot 所在群，跳过机器人消息与已成任务的', async () => {
    const { env, catchup } = setup({ messages: [user('om_1'), user('om_task'), { ...user('om_bot'), sender: { id: 'cli_x', sender_type: 'app' } }] })
    const beforeSleep = env.now
    env.now = Date.parse('2026-10-16T20:21:30+04:00')
    env.sleptAt = Date.parse('2026-10-16T20:21:21+04:00')
    env.closed = true
    assert.equal(await catchup.tick(), null)
    env.now = Date.parse('2026-10-17T05:28:52+04:00')
    assert.equal(await catchup.tick(), null)
    assert.deepEqual(env.calls, [])
    env.closed = false
    env.now = Date.parse('2026-10-17T06:44:02+04:00')
    assert.deepEqual(await catchup.tick(), { chats: 1, fed: 1, failedChats: 0 })
    assert.deepEqual(env.calls, [{ chatId: 'oc_in', start: new Date(beforeSleep - 120_000).toISOString() }])
    assert.deepEqual(env.ingested, ['om_1'])
    env.now += 60_000
    assert.equal(await catchup.tick(), null, '补完一次就清掉窗口')
    assert.equal(env.alive.at(-1), env.now, '开着盖每轮记一次「活着」')
    assert.equal(env.alive.includes(Date.parse('2026-10-17T05:28:52+04:00')), false, '合盖时不记')

    // 重启补拉：上次活着在 24h 内 → 首轮从它（减 2 分钟）起补拉；更早的不补；写盘读盘
    const lastAlive = Date.parse('2026-10-16T20:19:40+04:00')
    const restarted = setup({ messages: [user('om_gap')], lastAlive })
    restarted.env.now += 60_000
    assert.deepEqual(await restarted.catchup.tick(), { chats: 1, fed: 1, failedChats: 0 })
    assert.deepEqual(restarted.env.calls, [{ chatId: 'oc_in', start: new Date(lastAlive - 120_000).toISOString() }])
    assert.deepEqual(restarted.env.ingested, ['om_gap'])
    // 重启空窗只补近 7 天有过 bot 任务的群（11-02：每次重启全拉 50 个群把接口频率打满）；私信、太旧的、别的群不拉
    const scoped = setup({ messages: [], lastAlive, chats: ['oc_in', 'oc_quiet', 'oc_old', 'oc_dm'], tasks: [
      { chatId: 'oc_in', updatedAt: '2026-10-16T16:00:00Z' },
      { chatId: 'oc_old', updatedAt: '2026-10-09T16:00:00Z' },
      { chatId: 'oc_dm', chatType: 'p2p', updatedAt: '2026-10-16T16:00:00Z' },
      { chatId: 'oc_edge', createdAt: new Date(Date.parse('2026-10-16T20:21:00+04:00') - 7 * 24 * 3600_000).toISOString() },
      { chatId: 'ou_x', updatedAt: '2026-10-16T16:00:00Z' },
      { chatId: null },
    ] })
    scoped.env.now += 60_000
    assert.deepEqual(await scoped.catchup.tick(), { chats: 1, fed: 0, failedChats: 0 })
    assert.deepEqual(scoped.env.calls.map((c) => c.chatId), ['oc_in'])
    const edge7 = setup({ messages: [], lastAlive, chats: ['oc_edge'], tasks: [{ chatId: 'oc_edge', createdAt: new Date(Date.parse('2026-10-16T20:21:00+04:00') - 7 * 24 * 3600_000).toISOString() }] })
    edge7.env.now += 60_000
    await edge7.catchup.tick()
    assert.deepEqual(edge7.env.calls.map((c) => c.chatId), ['oc_edge'], '恰好 7 天还算')
    const noList = startWakeCatchup({ config: {}, store: { has: () => false }, ingest: async () => {}, deps: { now: () => Date.parse('2026-10-16T20:21:00+04:00'), isLidClosed: async () => false, lastSystemSleepAt: async () => null, listBotChatIds: async () => ['oc_a'], readLastAliveAt: () => lastAlive, writeLastAliveAt: () => {}, listChatMessages: async () => ({ ok: true, messages: [], hasMore: false }), setInterval: () => ({ unref() {} }) } })
    assert.deepEqual(await noList.tick(), { chats: 0, fed: 0, failedChats: 0 }, 'store 没有 list 就一个群都不补')
    // 补完一次后再遇到睡眠窗口就全拉
    scoped.env.sleptAt = scoped.env.now + 10_000
    scoped.env.now += 3600_000
    scoped.env.calls.length = 0
    await scoped.catchup.tick()
    assert.deepEqual(scoped.env.calls.map((c) => c.chatId), ['oc_in', 'oc_quiet', 'oc_old', 'oc_dm'], '睡眠窗口不受限')
    const stale = setup({ messages: [user('om_old')], lastAlive: Date.parse('2026-10-15T20:00:00+04:00') })
    stale.env.now += 60_000
    assert.equal(await stale.catchup.tick(), null, '超过 24h 的「上次活着」不当窗口')
    assert.deepEqual(stale.env.calls, [])
    const edge = setup({ messages: [user('om_edge')], lastAlive: Date.parse('2026-10-16T20:20:00+04:00') - 24 * 3600_000 })
    edge.env.now += 60_000
    assert.deepEqual(await edge.catchup.tick(), { chats: 1, fed: 1, failedChats: 0 }, '恰好 24h 还算')
    const dir = mkdtempSync(join(tmpdir(), 'lark-alive-'))
    try {
      const path = join(dir, 'lark-gateway-alive-state.json')
      assert.equal(readLastAliveAt({ path }), null)
      writeLastAliveAt(lastAlive, { path })
      assert.equal(readLastAliveAt({ path }), lastAlive)
      writeLastAliveAt(NaN, { path })
      assert.equal(readLastAliveAt({ path }), lastAlive, '坏时间戳不写')
      writeFileSync(path, '{"at":"garbage"}')
      assert.equal(readLastAliveAt({ path }), null, '坏文件读回 null')
      assert.equal(readLastAliveAt({ path: join(dir, 'nope', 'x.json') }), null)
      writeLastAliveAt(lastAlive, { path: join(dir, 'nope', 'x.json') }) // 写不进去不抛
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('开盖首轮拉失败（网络没就绪）：保留窗口下分钟重试；连续 3 次失败放弃本窗口（应用没权限时不每分钟刷日志）', async () => {
    const { env, catchup } = setup({ messages: [user('om_1')], failTimes: 1 })
    const beforeSleep = env.now
    env.sleptAt = env.now + 10_000
    env.now += 9 * 3600_000
    assert.equal(await catchup.tick(), null)
    env.now += 60_000
    assert.deepEqual(await catchup.tick(), { chats: 1, fed: 1, failedChats: 0 })
    assert.equal(env.calls.at(-1).start, new Date(beforeSleep - 120_000).toISOString())

    const stuck = setup({ messages: [user('om_1')], failTimes: 99 })
    stuck.env.sleptAt = stuck.env.now + 10_000
    stuck.env.now += 3600_000
    for (let i = 0; i < 3; i += 1) {
      assert.equal(await stuck.catchup.tick(), null)
      stuck.env.now += 60_000
    }
    const callsAfterGiveUp = stuck.env.calls.length
    assert.equal(await stuck.catchup.tick(), null)
    assert.equal(stuck.env.calls.length, callsAfterGiveUp, '放弃后不再拉')

    // 一个群没权限只跳过它，别的群照补；全部群都拉不到才算这轮失败
    const partial = setup({ messages: [user('om_p')], chats: ['oc_noperm', 'oc_ok'], failChats: ['oc_noperm'] })
    partial.env.sleptAt = partial.env.now + 10_000
    partial.env.now += 3600_000
    const warned = []
    const originalWarn = console.warn
    console.warn = (line) => warned.push(String(line))
    try {
      assert.deepEqual(await partial.catchup.tick(), { chats: 2, fed: 1, failedChats: 1 })
    } finally {
      console.warn = originalWarn
    }
    assert.deepEqual(partial.env.ingested, ['om_p'])
    assert.match(warned.join('\n'), /补拉有 1 个群拉不到（跳过）：群 oc_noperm：list failed/)
    const allFail = setup({ messages: [user('om_q')], chats: ['oc_a', 'oc_b'], failChats: ['oc_a', 'oc_b'] })
    allFail.env.sleptAt = allFail.env.now + 10_000
    allFail.env.now += 3600_000
    assert.equal(await allFail.catchup.tick(), null)
    allFail.env.now += 60_000
    assert.equal(await allFail.catchup.tick(), null, '全失败保留窗口重试')
    assert.equal(allFail.env.calls.length, 4)
  })

  it('列消息形态 → 长连接同形事件，normalizeMessage 能吃；话题回复拍平并指回 host；只喂真人消息', () => {
    const raw = chatListMessageToEvent(user('om_9'), { chatId: 'oc_in' })
    const msg = normalizeMessage(raw)
    assert.equal(msg.messageId, 'om_9')
    assert.equal(msg.chatId, 'oc_in')
    assert.equal(msg.senderOpenId, 'ou_k')
    assert.deepEqual(msg.mentions.map((m) => m.id), ['ou_aven'])
    const replies = flattenThreadReplies({ message_id: 'om_host', thread_id: 'omt_1', thread_replies: [{ message_id: 'om_r1', msg_type: 'text' }] })
    assert.deepEqual(replies.map((r) => [r.root_id, r.thread_id, r.parent_id]), [['om_host', 'omt_1', 'om_host']])
    assert.equal(isPollableMessage(user('om_1')), true)
    assert.equal(isPollableMessage({ ...user('om_2'), sender: { id: 'cli_x', sender_type: 'app' } }), false)
    assert.equal(isPollableMessage({ ...user('om_3'), deleted: true }), false)
    assert.equal(isPollableMessage({ ...user('om_4'), msg_type: 'system' }), false)
  })
})
