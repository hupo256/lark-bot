import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { registerRepoProfiles, resetRepoProfiles } from '../lib/lark-repo-profile.mjs'
import { startWakeCatchup } from '../lib/lark-wake-catchup.mjs'
import { runSteps } from './support/steps.mjs'

describe('开盖补拉内部群（长连接睡着时收不到，飞书重推只覆盖约 7 小时的几个时间点）', () => {
  const hooks = { after: () => resetRepoProfiles() }

  const setup = ({ messages = [], failFirst = false } = {}) => {
    registerRepoProfiles({ repos: { falive: { root: '/tmp/falive-react', baseRef: 'main', chatIds: ['oc_ext'], notifyChatId: 'ou_aven' } } })
    const env = { now: Date.parse('2026-10-16T20:20:00+04:00'), closed: false, sleptAt: Date.parse('2026-10-16T09:00:00+04:00'), calls: [], ingested: [], fail: failFirst }
    const catchup = startWakeCatchup({
      config: {},
      store: { has: (id) => id === 'om_task' },
      ingest: async ({ raw }) => env.ingested.push(raw.message_id),
      deps: {
        now: () => env.now,
        isLidClosed: async () => env.closed,
        lastSystemSleepAt: async () => env.sleptAt,
        listBotChatIds: async () => ['oc_in', 'oc_ext'],
        listChatMessages: async ({ chatId, start, identity }) => {
          env.calls.push({ chatId, start, identity })
          if (env.fail) {
            env.fail = false
            return { ok: false, reason: 'network' }
          }
          return { ok: true, messages, hasMore: false, pageToken: null }
        },
        setInterval: () => ({ unref() {} }),
      },
    })
    return { env, catchup }
  }
  const user = (id) => ({ message_id: id, msg_type: 'text', create_time: '1', sender: { id: 'ou_k', sender_type: 'user' }, content: '@kingstar 看下', mentions: [{ id: 'ou_aven', key: '@_user_1', name: 'kingstar' }] })

  it('开盖补拉：没睡过不拉，合盖不拉、开盖从合盖前起补拉内部群，首轮失败保留窗口重试', () => runSteps([
    ['没睡过、没合盖：不补拉', async () => {
      const { env, catchup } = setup()
      env.now += 60_000
      assert.equal(await catchup.tick(), null)
      assert.deepEqual(env.calls, [])
    }],
    ['合盖期间不拉；开盖后从合盖前最后醒着的时刻（减 2 分钟）起，bot 身份补拉内部群、跳过外部群与已成任务的', async () => {
      const { env, catchup } = setup({ messages: [user('om_1'), user('om_task'), { ...user('om_bot'), sender: { id: 'cli_x', sender_type: 'app' } }] })
      const beforeSleep = env.now
      env.now = Date.parse('2026-10-16T20:21:30+04:00') // 20:21:21 合盖入睡后的第一次半醒
      env.sleptAt = Date.parse('2026-10-16T20:21:21+04:00')
      env.closed = true
      assert.equal(await catchup.tick(), null)
      env.now = Date.parse('2026-10-17T05:28:52+04:00')
      assert.equal(await catchup.tick(), null)
      assert.deepEqual(env.calls, [])
      env.closed = false
      env.now = Date.parse('2026-10-17T06:44:02+04:00')
      const outcome = await catchup.tick()
      assert.deepEqual(outcome, { chats: 1, fed: 1 })
      assert.deepEqual(env.calls, [{ chatId: 'oc_in', start: new Date(beforeSleep - 120_000).toISOString(), identity: 'bot' }])
      assert.deepEqual(env.ingested, ['om_1'])
      env.now += 60_000
      assert.equal(await catchup.tick(), null, '补完一次就清掉窗口')
    }],
    ['开盖首轮拉失败（网络没就绪）：保留窗口，下分钟重试', async () => {
      const { env, catchup } = setup({ messages: [user('om_1')], failFirst: true })
      const beforeSleep = env.now
      env.sleptAt = env.now + 10_000
      env.now += 9 * 3600_000
      assert.equal(await catchup.tick(), null)
      env.now += 60_000
      assert.deepEqual(await catchup.tick(), { chats: 1, fed: 1 })
      assert.equal(env.calls.at(-1).start, new Date(beforeSleep - 120_000).toISOString())
    }],
  ], hooks))
})
