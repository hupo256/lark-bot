import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { runSteps } from './support/steps.mjs'

import { startChatPoller } from '../lib/lark-chat-poller.mjs'
import { ingestLarkEvent } from '../lib/lark-ingest.mjs'
import { classifyPauseIntent, isNonSupplementalReply, normalizeMessage, parseCommandType, parseControlDirective, parseResumeDirective, resolveMessageTrigger, stripMentionNames, textForParse } from '../lib/lark-message.mjs'
import { DEFAULT_ACK_TIMEOUT_MS, ackInGroup, flushPendingAck, holdsSuspectedForPrincipal, sweepPendingAcks, isPushPrePrincipal, pickSupplementTarget } from '../lib/lark-repo-intake.mjs'
import { CONSOLE_NO_TEXT_HINT } from '../lib/lark-repo-only.mjs'
import { registerRepoProfiles, repoProfile, resetRepoProfiles } from '../lib/lark-repo-profile.mjs'
import { resolvePrincipalProfiles, resolvePrincipalTarget } from '../lib/lark-principal-channel.mjs'
import { createTaskStore } from '../lib/lark-task-store.mjs'
import { noteAnswer, resetObligationMemory } from '../lib/lark-reply-obligation.mjs'

// aven 2026-10-20 review：falive 独立实例（repo-only）入口的 11 条问题。真实 ingest 路径 + 注入 fetch，不发任何 Lark 消息。
const GROUP = 'oc_review_group'
const CONSOLE = 'oc_review_console'
const AVEN = 'ou_review_aven'
const ENCONE = 'ou_review_encone'
const BOT = 'ou_review_bot'
const config = { allowedChatIds: [GROUP], allowedOpenIds: [AVEN, ENCONE], botOpenId: 'ou_review_appbot', project: 'PR-1' }
const faliveRaw = {
  root: '/tmp/falive-review', baseRef: 'main', chatIds: [GROUP], notifyChatId: CONSOLE,
  ownership: { me: 'Aven', meOpenIds: [AVEN] }, botMentionOpenIds: { [GROUP]: BOT },
  webhooksByChat: { [GROUP]: { url: 'https://hook/group' }, [CONSOLE]: { url: 'https://hook/console' } },
}

let savedMode
let savedFetch
let posted
let dir
let store
const setup = () => {
  savedMode = process.env.LARK_INSTANCE_MODE
  savedFetch = globalThis.fetch
  process.env.LARK_INSTANCE_MODE = 'repo-only'
  posted = []
  globalThis.fetch = async (url, init) => {
    posted.push({ url, body: JSON.parse(init.body) })
    return { ok: true, status: 200, text: async () => '{"code":0}', json: async () => ({ code: 0 }) }
  }
  registerRepoProfiles({ repos: { falive: faliveRaw } })
  dir = mkdtempSync(join(tmpdir(), 'lark-repo-intake-'))
  store = createTaskStore({ tasksDir: join(dir, 'tasks'), leaseMs: 60_000 })
}
const teardown = () => {
  if (savedMode === undefined) delete process.env.LARK_INSTANCE_MODE
  else process.env.LARK_INSTANCE_MODE = savedMode
  globalThis.fetch = savedFetch
  resetRepoProfiles()
  rmSync(dir, { recursive: true, force: true })
}
// 合并过的 it 每段（= 合并前的一个原 it）前后各跑一次，等价原来的 beforeEach / afterEach；只有一段的 it 所在 describe 自己挂 beforeEach / afterEach
const hooks = { before: setup, after: teardown }

const groupEvent = ({ id, text, sender = ENCONE, mentions = [], root = null, parent = null, createTime = null }) => ({
  message_id: id, chat_id: GROUP, chat_type: 'group', message_type: 'text', content: text,
  sender_type: 'user', sender_id: sender, mentions, root_id: root, reply_to: parent, ...(createTime ? { create_time: createTime } : {}),
})
const now = () => new Date().toISOString()

describe('A2：ingest 失败回滚「已见」，轮询器下轮重喂能落成任务（真实 ingest）', () => {
  it('第一轮建任务时落盘抛错 → 第二轮同一条重喂，任务建出来', () => runSteps([
    ['第一轮建任务时落盘抛错 → 第二轮同一条重喂，任务建出来', async () => {
      let failOnce = true
      const flaky = { ...store, upsert: (task) => {
        if (failOnce && task.id === 'om_rv_a2') { failOnce = false; throw new Error('disk full') }
        return store.upsert(task)
      } }
      const nowMs = Date.now()
      const message = { message_id: 'om_rv_a2', msg_type: 'text', create_time: String(nowMs), sender: { id: ENCONE, sender_type: 'user' }, content: '@Aven.Bot 直播列表接口返回的字段不对，帮忙看一下', mentions: [{ id: BOT, key: '@_user_1', name: 'Aven.Bot' }] }
      const poller = startChatPoller({
        config, store: flaky, ingest: ingestLarkEvent, statePath: join(dir, 'poller.json'),
        deps: {
          now: () => new Date(nowMs), setTimeout: () => ({ unref() {} }), isLidClosed: async () => false, isChatMember: async () => false,
          sendChatMessage: async () => ({ ok: true }), listThreadMessages: async () => ({ ok: true, messages: [] }),
          listChatMessages: async () => ({ ok: true, messages: [message], hasMore: false, pageToken: null }),
        },
      })
      const profile = repoProfile('falive')
      await poller.pollOnce({ chatId: GROUP, profile })
      assert.equal(store.has('om_rv_a2'), false, '第一轮落盘失败')
      await poller.pollOnce({ chatId: GROUP, profile })
      assert.equal(store.get('om_rv_a2')?.status, 'received', '重喂没被「最近见过」挡掉，任务建出来等分类')
      poller.stop()
      assert.equal(posted.length, 0)
    }],
    ['消息已落成任务、进程内去重表已清空（网关重启）时同一条再推一次：不重复入队、原任务原样、不发消息（变异补测 10-24）', async () => {
      // 进程内的「最近见过」只防同一进程里的重推；重启后全靠 store 里已有这条任务挡住
      store.upsert({ id: 'om_rv_dup', source: 'lark', repo: 'falive', chatId: GROUP, operator: ENCONE, text: '原任务正文', status: 'running', epoch: 2, createdAt: now() })
      const snapshot = JSON.parse(JSON.stringify(store.get('om_rv_dup')))
      await ingestLarkEvent({ raw: groupEvent({ id: 'om_rv_dup', text: '@Aven.Bot 直播列表接口返回的字段不对，帮忙看一下', mentions: [{ id: BOT, key: '@_user_1', name: 'Aven.Bot' }] }), config, store })
      assert.deepEqual(store.get('om_rv_dup'), snapshot, '原任务不被重推覆盖')
      assert.equal(store.list().length, 1, '不另建任务')
      assert.equal(posted.length, 0, '不发消息')
    }],
  ], hooks))
})

describe('C3：疑似单只有负责人能放行', () => {
  const suspected = () => store.upsert({ id: 'om_rv_sus', source: 'lark', repo: 'falive', chatId: GROUP, threadRootId: 'om_rv_sus', operator: ENCONE, text: '原消息', status: 'waiting_confirmation', suspected: true, epoch: 1, createdAt: now() })

  it('疑似单：别人不 @ 回话 / 同话题归并都拦，放行权只给负责人', () => runSteps([
    ['别人在话题里不 @ 机器人回一句：不处理（10-23 起外部群只响应 @bot），疑似单原样等负责人，不发卡', async () => {
      suspected()
      await ingestLarkEvent({ raw: groupEvent({ id: 'om_rv_sus_r1', text: '接口已经部署好了，可以联调', root: 'om_rv_sus', parent: 'om_rv_sus' }), config, store })
      const task = store.get('om_rv_sus')
      assert.equal(task.status, 'waiting_confirmation')
      assert.equal(task.epoch, 1)
      assert.equal(task.text, '原消息')
      assert.equal(task.suspectedSupplements, undefined)
      assert.equal(posted.length, 0, '别人不 @ 机器人回一句：不发卡')
    }],
    ['同话题归并分支同样拦（listParkedByThread → handleResume）', async () => {
      store.upsert({ id: 'om_rv_sus2', source: 'lark', repo: 'falive', chatId: GROUP, threadRootId: 'omt_rv_x', operator: ENCONE, text: 'x', status: 'waiting_confirmation', suspected: true, epoch: 0, createdAt: now() })
      // 话题根不是任务本身、话题里还有一条已了结的任务（控制通道锚不到），走同话题归并
      store.upsert({ id: 'omt_rv_x', source: 'lark', repo: 'falive', chatId: GROUP, threadRootId: 'omt_rv_x', text: 'old', status: 'done', createdAt: now() })
      await ingestLarkEvent({ raw: groupEvent({ id: 'om_rv_sus2_r', text: '@Aven.Bot 这个也看下', mentions: [{ id: BOT, key: '@_user_1', name: 'Aven.Bot' }], root: 'omt_rv_x' }), config, store })
      assert.equal(store.get('om_rv_sus2').status, 'waiting_confirmation')
      assert.match(store.get('om_rv_sus2').text, /待负责人放行/, '同话题归并分支同样拦')
    }],
    ['放行权判定：负责人放行，别人不放行；非疑似 / 非待确认不拦', () => {
      const held = { repo: 'falive', status: 'waiting_confirmation', suspected: true }
      assert.equal(holdsSuspectedForPrincipal({ task: held, operator: AVEN }), false, '负责人放行')
      assert.equal(holdsSuspectedForPrincipal({ task: held, operator: ENCONE }), true, '别人不放行')
      assert.equal(holdsSuspectedForPrincipal({ task: { ...held, suspected: false }, operator: ENCONE }), false, '非疑似不拦')
      assert.equal(holdsSuspectedForPrincipal({ task: { ...held, status: 'blocked', suspected: false }, operator: ENCONE }), false, '非待确认不拦')
    }],
  ], hooks))
})

describe('C10：外部群保留 @名字 后，判实质内容与指令解析先剥掉 @', () => {
  const botMention = [{ id: BOT, key: '@_user_1', name: 'Aven.Bot' }]
  it('剥 @ 后 ^ 锚定的解析都能命中、没 @ 机器人不触发；真实 ingest 下「@Aven.Bot 取消任务」能结单', () => runSteps([
    ['纯函数：剥 @ 后 ^ 锚定的解析都能命中；没 @ 机器人的「@Encone 👍」不触发', () => {
      const msg = normalizeMessage(groupEvent({ id: 'om_rv_p', text: '@Aven.Bot 取消任务 om_rv_abc', mentions: botMention }), { keepMentions: true })
      assert.equal(msg.text, '@Aven.Bot 取消任务 om_rv_abc', '正文仍保留 @名字')
      assert.equal(parseControlDirective(textForParse(msg))?.taskId, 'om_rv_abc')
      const at = (text) => stripMentionNames(text, botMention)
      assert.equal(parseResumeDirective(at('@Aven.Bot 继续任务 om_rv_abc 做'))?.taskId, 'om_rv_abc')
      assert.equal(classifyPauseIntent(at('@Aven.Bot 暂停')), true)
      assert.equal(isNonSupplementalReply({ text: at('@Aven.Bot 收到') }), true)
      assert.equal(parseCommandType(at('@Aven.Bot 状态：做到哪了')), 'status')
      const thumbs = { text: '@Encone 👍', mentions: [{ id: 'ou_e', name: 'Encone' }], attachments: [] }
      assert.equal(resolveMessageTrigger({ msg: { ...thumbs, chatType: 'group', senderOpenId: 'ou_x' }, config: { contextTrigger: true, botOpenId: 'ou_b' } }), null, '没 @ 机器人的「@Encone 👍」不触发')
    }],
    ['真实 ingest：外部群「@Aven.Bot 取消任务 <id>」能结单', async () => {
      store.upsert({ id: 'om_rv_t1', source: 'lark', repo: 'falive', chatId: GROUP, text: 'x', status: 'queued', createdAt: now() })
      await ingestLarkEvent({ raw: groupEvent({ id: 'om_rv_c10', text: '@Aven.Bot 取消任务 om_rv_t1', mentions: botMention }), config, store })
      assert.equal(store.get('om_rv_t1').status, 'superseded', '真实 ingest：外部群「@Aven.Bot 取消任务 <id>」能结单')
      assert.equal(store.get('om_rv_t1').closureReason, 'cancelled')
      assert.equal(store.has('om_rv_c10'), false, '没另建任务')
    }],
  ], hooks))
})

describe('#6：同人连发去抖不跨话题', () => {
  beforeEach(setup)
  afterEach(teardown)
  const pendingTask = (extra) => store.upsert({ id: 'om_rv_main', source: 'lark', repo: 'falive', chatId: GROUP, operator: ENCONE, threadRootId: null, text: 'a', status: 'received', intake: { required: true, receivedAt: now() }, createdAt: now(), ...extra })
  it('本条在旧话题里 → 不并进他刚在主楼发的；主楼连发才并；目标在话题里、本条在主楼也不并', () => {
    const repo = repoProfile('falive')
    pendingTask()
    assert.equal(pickSupplementTarget({ msg: { messageId: 'm2', chatId: GROUP, senderOpenId: ENCONE, threadRootId: 'om_old', replyTo: 'om_old' }, store, repo }), null)
    assert.equal(pickSupplementTarget({ msg: { messageId: 'm3', chatId: GROUP, senderOpenId: ENCONE }, store, repo })?.id, 'om_rv_main')
    assert.equal(pickSupplementTarget({ msg: { messageId: 'm4', chatId: GROUP, senderOpenId: AVEN }, store, repo }), null, '别人不算')
    pendingTask({ threadRootId: 'omt_rv_y' })
    assert.equal(pickSupplementTarget({ msg: { messageId: 'm5', chatId: GROUP, senderOpenId: ENCONE }, store, repo }), null)
    assert.equal(pickSupplementTarget({ msg: { messageId: 'm6', chatId: GROUP, senderOpenId: AVEN, threadRootId: 'omt_rv_y' }, store, repo })?.id, 'om_rv_main', '同话题照旧并')
  })
})

describe('#7：私聊「推 pre」只认负责人', () => {
  it('开了清扫的仓的 meOpenIds 才算；真实 ingest 下非负责人私聊「推 pre」不处理、不回消息', () => runSteps([
    ['纯函数：开了清扫的仓的 meOpenIds 才算', () => {
      const profiles = [{ key: 'falive', dailyReport: { sweep: {} }, ownership: { meOpenIds: [AVEN] } }, { key: 'x', ownership: { meOpenIds: [ENCONE] } }]
      assert.equal(isPushPrePrincipal({ senderOpenId: AVEN, profiles }), true)
      assert.equal(isPushPrePrincipal({ senderOpenId: ENCONE, profiles }), false, '没开清扫的仓的负责人不算')
      assert.equal(isPushPrePrincipal({ senderOpenId: AVEN, profiles: [{ ...profiles[0], isDefault: true }] }), false)
    }],
    ['真实 ingest：非负责人私聊「推 pre」不处理、不回消息', async () => {
      await ingestLarkEvent({ raw: { message_id: 'om_rv_push', chat_id: CONSOLE, chat_type: 'p2p', message_type: 'text', content: '推 pre', sender_type: 'user', sender_id: ENCONE }, config, store })
      assert.equal(posted.length, 0, '非负责人私聊「推 pre」不回消息')
      assert.equal(store.list().length, 0, '非负责人私聊「推 pre」不处理')
    }],
  ], hooks))
})

describe('#11：控制台只发文件不建空任务', () => {
  it('锚得到任务也只回提示，不建「私聊指示」空任务', () => runSteps([
    ['锚得到任务也只回提示，不建「私聊指示」空任务', async () => {
      store.upsert({ id: 'om_rv_anchor', source: 'lark', repo: 'falive', chatId: GROUP, text: 'x', status: 'ignored', receipts: [{ messageId: 'om_rv_card', epoch: 0, createdAt: now() }], createdAt: now() })
      await ingestLarkEvent({ raw: { message_id: 'om_rv_file', chat_id: CONSOLE, chat_type: 'p2p', message_type: 'file', content: '{"file_key":"file_v3_rv","file_name":"a.md"}', sender_type: 'user', sender_id: AVEN }, config, store })
      assert.equal(store.has('om_rv_file'), false)
      assert.equal(posted.length, 1)
      assert.equal(posted[0].url, 'https://hook/console')
      assert.equal(posted[0].body.card.elements[0].content, CONSOLE_NO_TEXT_HINT)
    }],
    ['控制台回复一条非仓库任务的待确认卡：控制通道续跑原任务，不再补「没对上任务」提示、不建新任务（变异补测 10-24）', async () => {
      store.upsert({ id: 'om_rv_park', source: 'lark', chatId: CONSOLE, text: '原任务', status: 'waiting_confirmation', epoch: 1, receipts: [{ messageId: 'om_rv_park_card', epoch: 1, createdAt: now() }], createdAt: now() })
      await ingestLarkEvent({ raw: { message_id: 'om_rv_park_r', chat_id: CONSOLE, chat_type: 'p2p', message_type: 'text', content: '接口地址改成 /api/v2/live 了，按这个改', sender_type: 'user', sender_id: AVEN, reply_to: 'om_rv_park_card' }, config, store })
      const task = store.get('om_rv_park')
      assert.equal(task.status, 'queued', '续跑原任务')
      assert.equal(task.resumeCount, 1)
      assert.equal(store.has('om_rv_park_r'), false, '不建新任务')
      assert.equal(posted.some((item) => JSON.stringify(item.body).includes('没对上任务')), false, '已续跑就不再回「没对上任务」')
    }],
    ['控制台在有两条未结束任务的话题里说话：不建任务，回卡列出每条任务的摘要，没摘要的写状态（变异补测 10-24）', async () => {
      store.upsert({ id: 'om_rv_amb1', source: 'lark', chatId: CONSOLE, threadRootId: 'omt_rv_amb', text: 'a', summary: '直播列表 cover 字段为空', status: 'running', createdAt: now() })
      store.upsert({ id: 'om_rv_amb2', source: 'lark', chatId: CONSOLE, threadRootId: 'omt_rv_amb', text: 'b', status: 'queued', createdAt: now() })
      await ingestLarkEvent({ raw: { message_id: 'om_rv_amb_r', chat_id: CONSOLE, chat_type: 'p2p', message_type: 'text', content: '这个再看下', sender_type: 'user', sender_id: AVEN, root_id: 'omt_rv_amb' }, config, store })
      assert.equal(store.has('om_rv_amb_r'), false, '归属不明不建任务')
      assert.equal(posted.length, 1)
      const card = JSON.stringify(posted[0].body)
      assert.ok(card.includes('om_rv_amb1：直播列表 cover 字段为空'), '有摘要列摘要')
      assert.ok(card.includes('om_rv_amb2：queued'), '没摘要列状态')
    }],
  ], hooks))
})

describe('C12：多仓共用负责人 / 控制台时取回执最新的任务锚定', () => {
  const registerTwo = () => registerRepoProfiles({ repos: { falive: faliveRaw, 'lark-bot': { root: '/tmp/lark-bot-review', baseRef: 'main', chatIds: [], notifyChatId: CONSOLE, ownership: { me: 'Aven', meOpenIds: [AVEN] } } } })
  it('notifyChatId 是 oc_ 控制台时按 meOpenIds 命中两个仓；recent 取最新；点名优先', () => runSteps([
    ['notifyChatId 是 oc_ 控制台时按 meOpenIds 命中两个仓；recent 取最新；点名优先', () => {
      registerTwo()
      const profiles = [repoProfile('falive'), repoProfile('lark-bot')]
      assert.deepEqual(resolvePrincipalProfiles({ senderOpenId: AVEN, profiles }).map((p) => p.key), ['falive', 'lark-bot'])
      assert.deepEqual(resolvePrincipalProfiles({ senderOpenId: ENCONE, profiles }), [])
      const t = Date.now()
      store.upsert({ id: 'om_rv_f', repo: 'falive', chatId: GROUP, status: 'done', receipts: [{ messageId: 'c1', epoch: 0, createdAt: new Date(t - 60_000).toISOString() }], createdAt: now() })
      store.upsert({ id: 'om_rv_l', repo: 'lark-bot', chatId: CONSOLE, status: 'done', receipts: [{ messageId: 'c2', epoch: 0, createdAt: new Date(t - 1000).toISOString() }], createdAt: now() })
      const msg = { messageId: 'm', chatId: CONSOLE, chatType: 'p2p', senderOpenId: AVEN, text: '这个再看下', mentions: [] }
      const recent = resolvePrincipalTarget({ msg, store, profiles, now: t })
      assert.deepEqual([recent.profile.key, recent.anchor.task.id, recent.anchor.via], ['lark-bot', 'om_rv_l', 'recent'])
      const named = resolvePrincipalTarget({ msg: { ...msg, text: '继续任务 om_rv_f 再跑' }, store, profiles, now: t })
      assert.deepEqual([named.profile.key, named.anchor.task.id, named.anchor.via], ['falive', 'om_rv_f', 'explicit'])
      assert.equal(resolvePrincipalTarget({ msg: { ...msg, senderOpenId: ENCONE }, store, profiles, now: t }), null)
    }],
    ['负责人从别的私聊会话回「就这样回」但草稿已作废：说明发到仓库登记的负责人控制台，不发回来源会话、不建任务（变异补测 10-24）', async () => {
      const anchor = store.upsert({ id: 'om_rv_held', source: 'lark', repo: 'falive', chatId: GROUP, operator: ENCONE, text: '直播列表接口字段不对', status: 'done', receipts: [{ messageId: 'om_rv_held_card', epoch: 0, createdAt: now() }], createdAt: now() })
      try {
        noteAnswer({ task: anchor, text: '更新的结论' })
        await ingestLarkEvent({ raw: { message_id: 'om_rv_held_r', chat_id: 'oc_rv_aven_dm', chat_type: 'p2p', message_type: 'text', content: '就这样回', sender_type: 'user', sender_id: AVEN, reply_to: 'om_rv_held_card' }, config, store })
        assert.equal(posted.length, 1)
        assert.equal(posted[0].url, 'https://hook/console', '发到 profile.notifyChatId')
        assert.match(JSON.stringify(posted[0].body), /已经发过更新的结论了/)
        assert.equal(store.has('om_rv_held_r'), false, '不建指示任务重跑')
      } finally {
        resetObligationMemory()
      }
    }],
  ], hooks))
})

describe('#9：分类中的任务回队落回 received', () => {
  beforeEach(setup)
  afterEach(teardown)
  it('分类中被交还 / 租约回收 → received；普通任务 → queued', () => {
    store.upsert({ id: 'om_rv_cls', status: 'received', intake: { required: true }, text: 'x', createdAt: now() })
    store.claimById('om_rv_cls')
    assert.equal(store.releaseRunning('om_rv_cls').status, 'received')
    const leaseDir = join(dir, 'lease')
    const short = createTaskStore({ tasksDir: leaseDir, leaseMs: 1 })
    short.upsert({ id: 'om_rv_orphan', status: 'running', claimedAt: new Date(Date.now() - 1000).toISOString(), intake: { required: true }, text: 'x', createdAt: now() })
    short.reclaimOrphans()
    assert.equal(short.get('om_rv_orphan').status, 'received')
    store.upsert({ id: 'om_rv_q', status: 'queued', text: 'x', createdAt: now() })
    store.claimById('om_rv_q')
    assert.equal(store.releaseRunning('om_rv_q').status, 'queued')
  })
})

describe('#57：「收到」等分类结果，用分类器按上下文写的那句回（真实 ingest）', () => {
  const groupCards = () => posted.filter((p) => p.url === 'https://hook/group').map((p) => JSON.stringify(p.body))
  it('@bot 进来先不回固定句、分类回来用 reply 回、判不处理只撤不发；分类迟迟不回时截止落盘、重启后巡检照发固定句', () => runSteps([
    ['@bot 进来先不回固定句；分类回来用 reply 回一句；判不处理只撤不发', async () => {
      await ingestLarkEvent({ raw: groupEvent({ id: 'om_rv_ack', text: '@Aven.Bot 你自己在 pre 环境看，看完报告结果', sender: AVEN, mentions: [{ id: BOT, key: '@_user_1', name: 'Aven.Bot' }] }), config, store })
      const task = store.get('om_rv_ack')
      assert.ok(task.ackPending, '挂着等分类')
      assert.equal(groupCards().some((c) => c.includes('稍后回复')), false, '不先发固定句')
      const out = await flushPendingAck({ store, task, reply: '收到，我去 pre 的 /lives 滚到底，看第 2 页有没有接上，看完报结果' })
      assert.deepEqual(out, { sent: true, usedReply: true })
      assert.ok(groupCards().some((c) => c.includes('我去 pre 的 /lives 滚到底') && !c.includes('稍后回复')))
      assert.equal(store.get('om_rv_ack').ackedInGroup, true)
      assert.equal(store.get('om_rv_ack').ackPending, null)
      assert.deepEqual(await flushPendingAck({ store, task: store.get('om_rv_ack'), reply: 'x' }), { sent: false, usedReply: false }, '只回一次')
      const ignored = store.upsert({ ...task, id: 'om_rv_ack2', ackPending: { at: now() }, ackedInGroup: false })
      const before = posted.length
      assert.deepEqual(await flushPendingAck({ store, task: ignored, reply: '收到，记下了', send: false }), { sent: false, usedReply: false })
      assert.equal(posted.length, before)
      assert.equal(store.get('om_rv_ack2').ackPending, null, '判不处理只撤不发')
    }],
    ['分类迟迟不回：截止时间落盘，网关重启后巡检照发固定句；没到点不发', async () => {
      const t0 = Date.parse('2026-10-21T08:00:00Z')
      const slowTask = store.upsert({ id: 'om_rv_ack3', chatId: GROUP, repo: 'falive', operator: ENCONE, text: 'x' })
      await ackInGroup({ store, task: slowTask, now: t0 })
      assert.ok(store.get('om_rv_ack3').ackPending.deadline)
      // 模拟网关重启：换一个读同一目录的 store
      const restarted = createTaskStore({ tasksDir: join(dir, 'tasks'), leaseMs: 60_000 })
      assert.equal(await sweepPendingAcks({ store: restarted, now: t0 + 10_000 }), 0, '没到点不发')
      assert.equal(groupCards().some((c) => c.includes('稍后回复')), false)
      assert.equal(await sweepPendingAcks({ store: restarted, now: t0 + DEFAULT_ACK_TIMEOUT_MS + 1 }), 1)
      assert.ok(groupCards().some((c) => c.includes('收到，我查一下，稍后回复')))
      assert.equal(restarted.get('om_rv_ack3').ackedInGroup, true)
      assert.equal(await sweepPendingAcks({ store: restarted, now: t0 + 999_999 }), 0, '只发一次')
      // 10-20 版留下的老格式（没有 deadline）按 at + 默认超时算
      restarted.upsert({ id: 'om_rv_ack4', chatId: GROUP, repo: 'falive', operator: AVEN, text: 'y', ackPending: { at: new Date(t0).toISOString() } })
      assert.equal(await sweepPendingAcks({ store: restarted, now: t0 + DEFAULT_ACK_TIMEOUT_MS + 1 }), 1)
    }],
  ], hooks))
})
