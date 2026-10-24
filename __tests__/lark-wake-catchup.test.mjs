import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { chatListMessageToEvent, flattenThreadReplies, isPollableMessage, startWakeCatchup } from '../lib/lark-wake-catchup.mjs'
import { normalizeMessage } from '../lib/lark-message.mjs'

describe('开盖补拉群消息（长连接睡着时收不到，飞书重推只覆盖约 7 小时的几个时间点）', () => {
  const setup = ({ messages = [], failTimes = 0 } = {}) => {
    const env = { now: Date.parse('2026-10-16T20:20:00+04:00'), closed: false, sleptAt: Date.parse('2026-10-16T09:00:00+04:00'), calls: [], ingested: [], fail: failTimes }
    const catchup = startWakeCatchup({
      config: {},
      store: { has: (id) => id === 'om_task' },
      ingest: async ({ raw }) => env.ingested.push(raw.message_id),
      deps: {
        now: () => env.now,
        isLidClosed: async () => env.closed,
        lastSystemSleepAt: async () => env.sleptAt,
        listBotChatIds: async () => ['oc_in'],
        listChatMessages: async ({ chatId, start }) => {
          env.calls.push({ chatId, start })
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
    assert.deepEqual(await catchup.tick(), { chats: 1, fed: 1 })
    assert.deepEqual(env.calls, [{ chatId: 'oc_in', start: new Date(beforeSleep - 120_000).toISOString() }])
    assert.deepEqual(env.ingested, ['om_1'])
    env.now += 60_000
    assert.equal(await catchup.tick(), null, '补完一次就清掉窗口')
  })

  it('开盖首轮拉失败（网络没就绪）：保留窗口下分钟重试；连续 3 次失败放弃本窗口（应用没权限时不每分钟刷日志）', async () => {
    const { env, catchup } = setup({ messages: [user('om_1')], failTimes: 1 })
    const beforeSleep = env.now
    env.sleptAt = env.now + 10_000
    env.now += 9 * 3600_000
    assert.equal(await catchup.tick(), null)
    env.now += 60_000
    assert.deepEqual(await catchup.tick(), { chats: 1, fed: 1 })
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
