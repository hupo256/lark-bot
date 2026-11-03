import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CATCHUP_PACE_MS, CATCHUP_RETRY_DELAYS_MS, DM_CHAT_KEEP_MS, DM_CHAT_MAX, chatListMessageToEvent, flattenThreadReplies, isPollableMessage, mergeDmChats, readDmChats, readLastAliveAt, startWakeCatchup, writeLastAliveAt } from '../lib/lark-wake-catchup.mjs'
import { normalizeMessage } from '../lib/lark-message.mjs'

const quietWarn = async (fn) => {
  const original = console.warn
  console.warn = () => {}
  try {
    return await fn()
  } finally {
    console.warn = original
  }
}

describe('开盖补拉群消息（长连接睡着时收不到，飞书重推只覆盖约 7 小时的几个时间点）', () => {
  const setup = ({ messages = [], failTimes = 0, lastAlive = null, chats = ['oc_in'], failChats = [], tasks = [{ chatId: 'oc_in', updatedAt: '2026-10-16T16:00:00Z' }], dmFile = {}, limited = {} } = {}) => {
    const env = { now: Date.parse('2026-10-16T20:20:00+04:00'), closed: false, sleptAt: Date.parse('2026-10-16T09:00:00+04:00'), calls: [], ingested: [], fail: failTimes, alive: [], sleeps: [], limited: { ...limited } }
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
        readDmChats: () => dmFile,
        writeLastAliveAt: (at, options) => { env.alive.push(at); env.dmWritten = options?.dmChats },
        listChatMessages: async ({ chatId, start }) => {
          env.calls.push({ chatId, start })
          if (failChats.includes(chatId)) return { ok: false } // 没带 reason：日志里要落成 list failed
          if (env.limited[chatId] > 0) {
            env.limited[chatId] -= 1
            return { ok: false, reason: 'TAT endpoint rate limited (HTTP 429)', transient: true }
          }
          if (env.fail > 0) {
            env.fail -= 1
            return { ok: false, reason: 'network' }
          }
          return { ok: true, messages, hasMore: false, pageToken: null }
        },
        setInterval: () => ({ unref() {} }),
        sleep: async (ms) => { env.sleeps.push(ms); if (env.onSleep) await env.onSleep(ms) },
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
    // 重启空窗只补近 7 天有过 bot 任务的群（11-02：每次重启全拉 50 个群把接口频率打满）；太旧的、别的群不拉；
    // 私信会话（任务库里的 p2p + 状态文件里记过的，30 天内）照补，按私信身份送 ingest（11-02 晚：私信被分流丢了 5 分钟）
    const scoped = setup({ messages: [], lastAlive, chats: ['oc_in', 'oc_quiet', 'oc_old'], dmFile: { oc_dm_file: '2026-10-10T00:00:00Z', oc_dm_stale: '2026-09-01T00:00:00Z' }, tasks: [
      { chatId: 'oc_in', updatedAt: '2026-10-16T16:00:00Z' },
      { chatId: 'oc_old', updatedAt: '2026-10-09T16:00:00Z' },
      { chatId: 'oc_dm', chatType: 'p2p', updatedAt: '2026-10-16T16:00:00Z' },
      { chatId: 'oc_edge', createdAt: new Date(Date.parse('2026-10-16T20:21:00+04:00') - 7 * 24 * 3600_000).toISOString() },
      { chatId: 'ou_x', updatedAt: '2026-10-16T16:00:00Z' },
      { chatId: null },
    ] })
    scoped.env.now += 60_000
    assert.deepEqual(await scoped.catchup.tick(), { chats: 3, fed: 0, failedChats: 0 })
    assert.deepEqual(scoped.env.calls.map((c) => c.chatId), ['oc_in', 'oc_dm', 'oc_dm_file'], '私信按最近排；30 天前的不补')
    assert.deepEqual(Object.keys(scoped.env.dmWritten), ['oc_dm', 'oc_dm_file'], '私信会话表随「上次活着」落盘')
    const edge7 = setup({ messages: [], lastAlive, chats: ['oc_edge'], tasks: [{ chatId: 'oc_edge', createdAt: new Date(Date.parse('2026-10-16T20:21:00+04:00') - 7 * 24 * 3600_000).toISOString() }] })
    edge7.env.now += 60_000
    await edge7.catchup.tick()
    assert.deepEqual(edge7.env.calls.map((c) => c.chatId), ['oc_edge'], '恰好 7 天还算')
    const noList = startWakeCatchup({ config: {}, store: { has: () => false }, ingest: async () => {}, deps: { readDmChats: () => ({}), now: () => Date.parse('2026-10-16T20:21:00+04:00'), isLidClosed: async () => false, lastSystemSleepAt: async () => null, listBotChatIds: async () => ['oc_a'], readLastAliveAt: () => lastAlive, writeLastAliveAt: () => {}, listChatMessages: async () => ({ ok: true, messages: [], hasMore: false }), setInterval: () => ({ unref() {} }) } })
    assert.deepEqual(await noList.tick(), { chats: 0, fed: 0, failedChats: 0 }, 'store 没有 list 就一个群都不补')
    // 补完一次后再遇到睡眠窗口就全拉
    scoped.env.sleptAt = scoped.env.now + 10_000
    scoped.env.now += 3600_000
    scoped.env.calls.length = 0
    await scoped.catchup.tick()
    assert.deepEqual(scoped.env.calls.map((c) => c.chatId), ['oc_in', 'oc_quiet', 'oc_old', 'oc_dm', 'oc_dm_file'], '睡眠窗口群不受限，私信照补')
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
      assert.deepEqual(readDmChats({ path }), {})
      writeLastAliveAt(lastAlive, { path, dmChats: { oc_dm: '2026-10-16T00:00:00.000Z' } })
      writeLastAliveAt(lastAlive + 60_000, { path })
      assert.deepEqual([readLastAliveAt({ path }), readDmChats({ path })], [lastAlive + 60_000, { oc_dm: '2026-10-16T00:00:00.000Z' }], '只更新时刻时私信会话表原样留着')
      writeFileSync(path, JSON.stringify({ at: new Date(lastAlive).toISOString(), dmChats: ['oc_x'] }))
      assert.deepEqual(readDmChats({ path }), {}, '形状不对当空')
      const now = Date.parse('2026-11-02T12:00:00Z')
      const merged = mergeDmChats({
        previous: { oc_old: '2026-09-01T00:00:00Z', oc_keep: '2026-10-20T00:00:00Z', oc_task: '2026-10-01T00:00:00Z', oc_bad: 'x' },
        tasks: [
          { chatId: 'oc_task', chatType: 'p2p', updatedAt: '2026-11-02T10:00:00Z' },
          { chatId: 'oc_new', chatType: 'p2p', createdAt: '2026-11-01T10:00:00Z' },
          { chatId: 'oc_group', updatedAt: '2026-11-02T10:00:00Z' },
          { chatId: 'ou_aven', chatType: 'p2p', updatedAt: '2026-11-02T10:00:00Z' },
          { chatId: 'oc_task', chatType: 'p2p', updatedAt: '2026-10-01T00:00:00Z' },
        ],
        now,
      })
      assert.deepEqual(merged, { oc_task: '2026-11-02T10:00:00.000Z', oc_new: '2026-11-01T10:00:00.000Z', oc_keep: '2026-10-20T00:00:00.000Z' }, '按最近排；30 天前、ou_、群、坏时刻都不要；同一会话取最新')
      assert.deepEqual(Object.keys(mergeDmChats({ previous: { oc_edge: new Date(now - DM_CHAT_KEEP_MS).toISOString() }, now })), ['oc_edge'], '恰好 30 天还留')
      const many = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`oc_${String(i).padStart(2, '0')}`, new Date(now - i * 60_000).toISOString()]))
      assert.deepEqual([Object.keys(mergeDmChats({ previous: many, now })).length, DM_CHAT_MAX, Object.keys(mergeDmChats({ previous: many, now }))[0]], [20, 20, 'oc_00'])
      assert.equal(chatListMessageToEvent({ message_id: 'm' }, { chatId: 'oc_dm', chatType: 'p2p' }).chat_type, 'p2p')
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

    // 11-03：会话之间隔 300ms；撞限流（瞬时）的会话 5 秒、15 秒后各再补一轮，还不行才算拉不到；不是瞬时的不重试
    const limited = setup({ messages: [user('om_l')], chats: ['oc_a', 'oc_b', 'oc_c'], limited: { oc_b: 1, oc_c: 5 } })
    limited.env.sleptAt = limited.env.now + 10_000
    limited.env.now += 3600_000
    const warned2 = []
    console.warn = (line) => warned2.push(String(line))
    try {
      assert.deepEqual(await limited.catchup.tick(), { chats: 3, fed: 2, failedChats: 1 }, 'oc_a 首轮、oc_b 重试后各补到一条')
    } finally {
      console.warn = originalWarn
    }
    assert.deepEqual(limited.env.calls.map((c) => c.chatId), ['oc_a', 'oc_b', 'oc_c', 'oc_b', 'oc_c', 'oc_c'])
    assert.deepEqual(limited.env.sleeps, [300, 300, 5000, 300, 15000], '首轮两次间隔 + 5s；第二轮一次间隔 + 15s；第三轮只剩一个不用间隔')
    assert.match(warned2.join('\n'), /补拉 2 个会话撞限流 \/ 网络，5 秒后再补（第 1 次）/)
    assert.match(warned2.join('\n'), /补拉有 1 个群拉不到（跳过）：群 oc_c：TAT endpoint rate limited/)
    assert.deepEqual([CATCHUP_PACE_MS, CATCHUP_RETRY_DELAYS_MS], [300, [5000, 15000]])

    // 补拉（含重试）还没跑完时到点的 tick 跳过，不叠加；跑完后照常
    const slow = setup({ messages: [], chats: ['oc_a', 'oc_b'], limited: { oc_a: 1 } })
    slow.env.sleptAt = slow.env.now + 10_000
    slow.env.now += 3600_000
    let release = null
    slow.env.onSleep = (ms) => (ms === 5000 ? new Promise((resolve) => { release = resolve }) : null)
    const first = quietWarn(() => slow.catchup.tick())
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(await slow.catchup.tick(), null, '上一轮补拉还在跑')
    release()
    assert.deepEqual(await first, { chats: 2, fed: 0, failedChats: 0 })
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
