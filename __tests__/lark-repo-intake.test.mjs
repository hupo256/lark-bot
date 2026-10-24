import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, beforeEach, describe, it } from 'node:test'
import { runSteps } from './support/steps.mjs'

// 运行态指到临时目录、lark-cli 换成假程序（10-24 变异补测：fameex 路径的群名 / 群成员 / 合并转发 / 附件下载都走 lark-cli 子进程）。
// 假程序不碰网络：FAKE_LARK_LOG 记每次调用的参数；+chat-list / +messages-mget 回 FAKE_LARK_CHATS / FAKE_LARK_MGET，其它回空列表 + 成功。
// LARK_CLI_BIN / LARK_RUNTIME_DIR 在模块加载时读，所以先设环境再动态 import。
const fakeRoot = mkdtempSync(join(tmpdir(), 'lark-repo-intake-env-'))
const savedEnv = Object.fromEntries(['LARK_CLI_BIN', 'LARK_RUNTIME_DIR', 'FAKE_LARK_CHATS'].map((key) => [key, process.env[key]]))
const FAKE_CLI = join(fakeRoot, 'fake-lark-cli')
writeFileSync(FAKE_CLI, [
  '#!/bin/sh',
  '[ -n "$FAKE_LARK_LOG" ] && printf \'%s\\n\' "$*" >> "$FAKE_LARK_LOG"',
  'case "$*" in',
  '  *+chat-list*) out="$FAKE_LARK_CHATS" ;;',
  '  *+messages-mget*) out="$FAKE_LARK_MGET" ;;',
  '  *) out="" ;;',
  'esac',
  '[ -n "$out" ] || out=\'{"code":0,"data":{"items":[],"messages":[],"chats":[]}}\'',
  'printf \'%s\' "$out"',
  '',
].join('\n'))
chmodSync(FAKE_CLI, 0o755)
process.env.LARK_CLI_BIN = FAKE_CLI
process.env.LARK_RUNTIME_DIR = join(fakeRoot, 'runtime')
// bot 所在的群（fameex 默认仓）：一个群名带项目号、一个不带。外部群 / 控制台都不在里面（bot 进不去）。
const FX_PR = 'oc_rv_fx_pr'
const FX_PLAIN = 'oc_rv_fx_plain'
process.env.FAKE_LARK_CHATS = JSON.stringify({ data: { chats: [{ chat_id: FX_PR, name: '[PR-02172]【直播】列表联调' }, { chat_id: FX_PLAIN, name: '前端内部群' }] } })
after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(fakeRoot, { recursive: true, force: true })
})

const { startChatPoller } = await import('../lib/lark-chat-poller.mjs')
const { ingestLarkEvent } = await import('../lib/lark-ingest.mjs')
const { classifyPauseIntent, isNonSupplementalReply, normalizeMessage, parseCommandType, parseControlDirective, parseResumeDirective, resolveMessageTrigger, stripMentionNames, textForParse } = await import('../lib/lark-message.mjs')
const { DEFAULT_ACK_TIMEOUT_MS, ackInGroup, flushPendingAck, holdsSuspectedForPrincipal, sweepPendingAcks, isPushPrePrincipal, pickSupplementTarget } = await import('../lib/lark-repo-intake.mjs')
const { CONSOLE_NO_TEXT_HINT, CONSOLE_UNANCHORED_HINT } = await import('../lib/lark-repo-only.mjs')
const { registerRepoProfiles, repoProfile, resetRepoProfiles } = await import('../lib/lark-repo-profile.mjs')
const { resolvePrincipalProfiles, resolvePrincipalTarget } = await import('../lib/lark-principal-channel.mjs')
const { createTaskStore } = await import('../lib/lark-task-store.mjs')
const { noteAnswer, resetObligationMemory } = await import('../lib/lark-reply-obligation.mjs')

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
  process.env.FAKE_LARK_LOG = join(dir, 'lark-cli.log')
}
const teardown = () => {
  if (savedMode === undefined) delete process.env.LARK_INSTANCE_MODE
  else process.env.LARK_INSTANCE_MODE = savedMode
  globalThis.fetch = savedFetch
  delete process.env.FAKE_LARK_LOG
  delete process.env.FAKE_LARK_MGET
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
// 本段假 lark-cli 收到的全部调用（每次一行参数，卡片 JSON 原样在内）。
const cliCalls = () => (existsSync(process.env.FAKE_LARK_LOG || '') ? readFileSync(process.env.FAKE_LARK_LOG, 'utf8') : '')
const BOT_MENTION = [{ id: BOT, key: '@_user_1', name: 'Aven.Bot' }]
// fameex 默认仓的群消息（@ 应用机器人）；控制台私聊消息。
const fxEvent = ({ id, chat, text }) => ({ ...groupEvent({ id, text, mentions: [{ id: config.botOpenId, key: '@_user_1', name: 'Aven' }] }), chat_id: chat })
const consoleEvent = ({ id, text, sender = AVEN, ...extra }) => ({ message_id: id, chat_id: CONSOLE, chat_type: 'p2p', message_type: 'text', content: text, sender_type: 'user', sender_id: sender, ...extra })

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
    ['没变成任务的控制指令被重推（长连接重推 / 开盖补拉同一条）：只执行一次，不回两张卡（变异补测 10-24）', async () => {
      const raw = consoleEvent({ id: 'om_rv_repush', text: '取消任务 om_rv_repush_none' })
      await ingestLarkEvent({ raw, config, store })
      await ingestLarkEvent({ raw, config, store })
      assert.equal(posted.length, 1)
      assert.match(JSON.stringify(posted[0].body), /找不到任务 om_rv_repush_none/)
    }],
    ['进程内「最近见过」留最近 2000 条：往后又来了 1999 条时重推仍挡住，再挤进一条才忘掉（变异补测 10-24）', async () => {
      const chatter = (id) => ingestLarkEvent({ raw: groupEvent({ id, text: '普通聊天' }), config, store })
      const raw = consoleEvent({ id: 'om_rv_lru', text: '取消任务 om_rv_lru_none' })
      for (let index = 0; index < 2000; index += 1) await chatter(`om_rv_lru_a${index}`) // 先把表填满，之前段落记的都挤掉
      await ingestLarkEvent({ raw, config, store })
      for (let index = 0; index < 1999; index += 1) await chatter(`om_rv_lru_b${index}`)
      await ingestLarkEvent({ raw, config, store })
      assert.equal(posted.length, 1, '它仍在最近 2000 条里：重推挡住')
      await chatter('om_rv_lru_c')
      await ingestLarkEvent({ raw, config, store })
      assert.equal(posted.length, 2, '挤出最近 2000 条后才忘掉')
      assert.equal(store.list().length, 0, '普通聊天不建任务')
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
    ['外部群 @bot 建的任务正文保留点名的 @名字，轮询拍平的消息和长连接 event 包都一样（变异补测 10-24）', async () => {
      const mentions = [...BOT_MENTION, { id: 'ou_review_world', key: '@_user_2', name: 'World' }]
      await ingestLarkEvent({ raw: groupEvent({ id: 'om_rv_km1', text: '@Aven.Bot 让 @World 看下 cover 字段', sender: AVEN, mentions }), config, store })
      const { sender_type: senderType, sender_id: senderId, ...message } = groupEvent({ id: 'om_rv_km2', text: '@Aven.Bot 让 @World 看下 cover 字段', mentions })
      await ingestLarkEvent({ raw: { event: { message, sender: { sender_type: senderType, sender_id: { open_id: senderId } } } }, config, store })
      assert.match(store.get('om_rv_km1')?.text || '', /让 @World 看下 cover 字段/, '拍平形状')
      assert.match(store.get('om_rv_km2')?.text || '', /让 @World 看下 cover 字段/, 'event 包形状')
    }],
    ['非仓库会话（控制台私聊）不保留 @名字：续跑落进原任务的补料是剥掉 @ 的正文（变异补测 10-24）', async () => {
      store.upsert({ id: 'om_rv_km_park', source: 'lark', chatId: CONSOLE, text: '原任务', status: 'waiting_confirmation', epoch: 1, receipts: [{ messageId: 'om_rv_km_card', epoch: 1, createdAt: now() }], createdAt: now() })
      await ingestLarkEvent({ raw: consoleEvent({ id: 'om_rv_km_r', text: '@World 接口地址改成 /api/v2/live 了', mentions: [{ id: 'ou_review_world', key: '@_user_1', name: 'World' }], reply_to: 'om_rv_km_card' }), config, store })
      const task = store.get('om_rv_km_park')
      assert.equal(task.status, 'queued', '续跑原任务')
      assert.match(task.text, /【补料】\n接口地址改成 \/api\/v2\/live 了/)
      assert.doesNotMatch(task.text, /@World/)
    }],
    ['外部群合并转发并进同人刚发的待分类任务：子消息展开成正文、本条自带的图片保留；普通消息不去拉子消息；控制台私聊的合并转发不展开（变异补测 10-24）', async () => {
      store.upsert({ id: 'om_rv_mf_main', source: 'lark', repo: 'falive', chatId: GROUP, operator: ENCONE, threadRootId: null, text: '直播列表 cover 为空', status: 'received', intake: { required: true, receivedAt: now() }, createdAt: now() })
      process.env.FAKE_LARK_MGET = JSON.stringify({ data: { messages: [{ message_id: 'om_rv_mf_child', msg_type: 'text', content: JSON.stringify({ text: '后端说 cover 字段改名了' }), sender: { name: 'World' }, upper_message_id: 'om_rv_mf' }] } })
      const mgetCalls = () => cliCalls().split('\n').filter((line) => line.includes('+messages-mget')).length
      await ingestLarkEvent({ raw: { ...groupEvent({ id: 'om_rv_mf', text: '[Image: img_rv_own]' }), message_type: 'merge_forward' }, config, store })
      const merged = store.get('om_rv_mf_main')
      assert.match(merged.text, /【合并转发的消息】\nWorld：后端说 cover 字段改名了/, '子消息展开')
      assert.ok(merged.attachments.some((item) => item.imageKey === 'img_rv_own'), '本条自带的图片保留')
      assert.equal(mgetCalls(), 1)
      await ingestLarkEvent({ raw: groupEvent({ id: 'om_rv_mf_plain', text: '补一句：是 /api/front/lives 接口' }), config, store })
      assert.equal(mgetCalls(), 1, '普通消息不拉子消息')
      assert.equal(store.get('om_rv_mf_main').text.split('【合并转发的消息】').length, 2, '普通消息没并进合并转发正文')
      await ingestLarkEvent({ raw: consoleEvent({ id: 'om_rv_mf_dm', text: '', message_type: 'merge_forward' }), config, store })
      assert.equal(mgetCalls(), 1, '控制台私聊不展开')
      assert.equal(posted.length, 0, '控制台空消息不回话')
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
    ['auto 白名单：bot 在的群 @ 能建任务、不在的群不建；私聊不查群成员（不起 chat-list）（变异补测 10-24）', async () => {
      delete process.env.LARK_INSTANCE_MODE // fameex 默认仓
      const auto = { ...config, allowedChatIds: 'auto' }
      await ingestLarkEvent({ raw: fxEvent({ id: 'om_rv_mem1', chat: FX_PLAIN, text: '@Aven 首页 banner 不显示' }), config: auto, store })
      await ingestLarkEvent({ raw: fxEvent({ id: 'om_rv_mem2', chat: 'oc_rv_fx_stranger', text: '@Aven 首页 banner 不显示' }), config: auto, store })
      assert.equal(store.get('om_rv_mem1')?.status, 'queued', 'bot 在的群建任务')
      assert.equal(store.has('om_rv_mem2'), false, 'bot 不在的群不建')
      const seen = cliCalls().length
      await ingestLarkEvent({ raw: { ...consoleEvent({ id: 'om_rv_mem3', text: '取消任务 om_rv_mem_none' }), chat_id: 'oc_rv_dm_mem' }, config: auto, store })
      assert.match(cliCalls().slice(seen), /找不到任务 om_rv_mem_none/, '私聊指令照常处理')
      assert.doesNotMatch(cliCalls().slice(seen), /\+chat-list/, '私聊不查群成员')
    }],
    ['auto 白名单下仓库登记的外部群直接放行（bot 不在外部群里，查成员必然查不到）（变异补测 10-24）', async () => {
      await ingestLarkEvent({ raw: groupEvent({ id: 'om_rv_mem4', text: '@Aven.Bot 直播列表接口字段不对', mentions: BOT_MENTION }), config: { ...config, allowedChatIds: 'auto' }, store })
      assert.equal(store.get('om_rv_mem4')?.status, 'received')
      assert.doesNotMatch(cliCalls(), /\+chat-list/, '不查群成员')
    }],
    ['非仓库群定项目号：正文恰好一个项目号以正文为准；正文多个时用群名的；群名没有就取正文第一个（变异补测 10-24）', async () => {
      delete process.env.LARK_INSTANCE_MODE // fameex 默认仓
      const fx = { ...config, allowedChatIds: [FX_PR, FX_PLAIN] }
      await ingestLarkEvent({ raw: fxEvent({ id: 'om_rv_prj1', chat: FX_PR, text: '@Aven PR-02306 这个页面 cover 不显示' }), config: fx, store })
      await ingestLarkEvent({ raw: fxEvent({ id: 'om_rv_prj2', chat: FX_PR, text: '@Aven PR-02306 和 PR-02400 的 cover 都不显示' }), config: fx, store })
      await ingestLarkEvent({ raw: fxEvent({ id: 'om_rv_prj3', chat: FX_PLAIN, text: '@Aven PR-02306 和 PR-02400 的 cover 都不显示' }), config: fx, store })
      assert.deepEqual(['om_rv_prj1', 'om_rv_prj2', 'om_rv_prj3'].map((id) => store.get(id)?.project), ['PR-02306', 'PR-02172', 'PR-02306'])
    }],
  ], hooks))
})

describe('#11：控制台只发文件不建空任务', () => {
  // 控制台上一条非仓库任务（有摘要，回执卡 id = <id>_card）与对那张卡的回复；sent() = 已发出的每条消息正文。
  const SUMMARY = '直播列表 cover 字段为空'
  const cardTask = (id, extra = {}) => store.upsert({ id, source: 'lark', chatId: CONSOLE, text: '原任务', summary: SUMMARY, status: 'running', epoch: 0, receipts: [{ messageId: `${id}_card`, epoch: 0, createdAt: now() }], createdAt: now(), ...extra })
  const replyCard = (taskId, id, text, extra = {}) => ingestLarkEvent({ raw: consoleEvent({ id, text, reply_to: `${taskId}_card`, ...extra }), config, store })
  const sent = () => posted.map((item) => JSON.stringify(item.body))
  const reopenable = { status: 'superseded', closureReason: 'cancelled', externalResolution: { closureReason: 'cancelled', operator: AVEN } }
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
    ['回复任务卡「取消」：结单，回执写任务摘要和取消文案，只回这一张（变异补测 10-24）', async () => {
      cardTask('om_rv_cc1')
      await replyCard('om_rv_cc1', 'om_rv_cc1_r', '取消')
      assert.equal(store.get('om_rv_cc1').status, 'superseded')
      assert.equal(posted.length, 1)
      assert.ok(sent()[0].includes(`**任务**：${SUMMARY}`), '写摘要不写 id')
      assert.ok(sent()[0].includes('原任务已取消并结单'))
    }],
    ['回复已结束任务的卡「取消」：不重复结单，回「已结束」并写任务摘要（变异补测 10-24）', async () => {
      cardTask('om_rv_cc2', { status: 'done' })
      await replyCard('om_rv_cc2', 'om_rv_cc2_r', '取消')
      assert.equal(store.get('om_rv_cc2').status, 'done')
      assert.equal(posted.length, 1)
      assert.ok(sent()[0].includes(`**任务**：${SUMMARY}`))
      assert.ok(sent()[0].includes('当前状态为「done」，已结束'))
    }],
    ['「取消任务，＋新问题」：先结单，再单独回一张确认卡点出后半段（写原任务摘要），一共两张（变异补测 10-24）', async () => {
      cardTask('om_rv_cc3')
      await replyCard('om_rv_cc3', 'om_rv_cc3_r', '取消任务，首页 banner 图片不显示需要修复')
      assert.equal(store.get('om_rv_cc3').status, 'superseded')
      assert.equal(posted.length, 2)
      assert.ok(sent()[0].includes('原任务已取消并结单'))
      assert.ok(sent()[1].includes(`**原任务**：${SUMMARY}（已结单）`) && sent()[1].includes('首页 banner 图片不显示需要修复'))
    }],
    ['意图不明只问一句、不改任务：夹带「另一部分继续」问整单还是部分；弱信号写出猜的方向（取消该任务）并给带真实 id 的一键指令（变异补测 10-24）', async () => {
      cardTask('om_rv_cc4a')
      cardTask('om_rv_cc4b')
      await replyCard('om_rv_cc4a', 'om_rv_cc4a_r', '取消吧，不过另一部分继续做')
      await replyCard('om_rv_cc4b', 'om_rv_cc4b_r', '就到这吧')
      assert.equal(posted.length, 2, '每条只回一张')
      assert.ok(sent()[0].includes(`**任务**：${SUMMARY}`) && sent()[0].includes('还是只取消其中一部分') && sent()[0].includes('取消任务 om_rv_cc4a'))
      assert.ok(!sent()[0].includes('这条像是想'))
      assert.ok(sent()[1].includes('这条像是想「取消该任务」') && sent()[1].includes('取消任务 om_rv_cc4b'))
      assert.deepEqual([store.get('om_rv_cc4a').status, store.get('om_rv_cc4b').status], ['running', 'running'])
    }],
    ['回复任务卡「先暂停一下」：只回暂停说明（写摘要），任务状态不动（变异补测 10-24）', async () => {
      cardTask('om_rv_cc5')
      await replyCard('om_rv_cc5', 'om_rv_cc5_r', '先暂停一下')
      assert.equal(posted.length, 1)
      assert.ok(sent()[0].includes(`**任务**：${SUMMARY}`) && sent()[0].includes('收到暂停表达；任务保持当前「running」'))
      assert.equal(store.get('om_rv_cc5').status, 'running')
    }],
    ['回复在跑任务的卡说了句补充：回「当前在跑、未新建任务」说明（写摘要），不续跑不新建（变异补测 10-24）', async () => {
      cardTask('om_rv_cc6')
      await replyCard('om_rv_cc6', 'om_rv_cc6_r', '接口地址改成 /api/v2/live 了')
      assert.equal(posted.length, 1)
      assert.ok(sent()[0].includes(`**任务**：${SUMMARY}`) && sent()[0].includes('原任务当前为「running」'))
      assert.equal(store.get('om_rv_cc6').status, 'running')
      assert.equal(store.has('om_rv_cc6_r'), false)
    }],
    ['回复待确认任务的卡只说「收到」：静默消费，不续跑、不回话（变异补测 10-24）', async () => {
      cardTask('om_rv_cc7', { status: 'waiting_confirmation' })
      await replyCard('om_rv_cc7', 'om_rv_cc7_r', '收到')
      assert.equal(posted.length, 0)
      assert.equal(store.get('om_rv_cc7').status, 'waiting_confirmation')
      assert.equal(store.get('om_rv_cc7').resumeCount, undefined)
    }],
    ['回复已结束任务的卡提新要求：控制通道放行，控制台没有新任务路径，回「没对上任务」提示（变异补测 10-24）', async () => {
      cardTask('om_rv_cc8', { status: 'done' })
      await replyCard('om_rv_cc8', 'om_rv_cc8_r', '再看下首页 banner 的间距')
      assert.equal(posted.length, 1)
      assert.ok(sent()[0].includes(CONSOLE_UNANCHORED_HINT))
      assert.equal(store.get('om_rv_cc8').status, 'done')
    }],
    ['回复人工结单任务的卡说「关错了，重新打开」：复活重排，只回重开回执（变异补测 10-24）', async () => {
      cardTask('om_rv_cc9', reopenable)
      await replyCard('om_rv_cc9', 'om_rv_cc9_r', '关错了，重新打开')
      assert.equal(store.get('om_rv_cc9').status, 'queued')
      assert.equal(posted.length, 1)
      assert.ok(sent()[0].includes('已重开原任务'))
    }],
    ['显式指令「取消任务 / 重开任务 <id>」：id 不存在按动作回「无法结单 / 无法重开」；不可重开的任务说明原因（写摘要）；每条只回一张（变异补测 10-24）', async () => {
      await ingestLarkEvent({ raw: consoleEvent({ id: 'om_rv_cd1', text: '取消任务 om_rv_cd_none1' }), config, store })
      await ingestLarkEvent({ raw: consoleEvent({ id: 'om_rv_cd2', text: '重开任务 om_rv_cd_none2' }), config, store })
      cardTask('om_rv_cd3', { status: 'done' })
      await ingestLarkEvent({ raw: consoleEvent({ id: 'om_rv_cd3_r', text: '重开任务 om_rv_cd3' }), config, store })
      assert.equal(posted.length, 3)
      assert.ok(sent()[0].includes('找不到任务 om_rv_cd_none1，无法结单'))
      assert.ok(sent()[1].includes('找不到任务 om_rv_cd_none2，无法重开'))
      assert.ok(sent()[2].includes(`**任务**：${SUMMARY}`) && sent()[2].includes('不是可重开的「人工结单」任务'))
      assert.equal(store.get('om_rv_cd3').status, 'done')
    }],
    ['显式「重开任务 <id>」带截图：复活重排，截图落在任务自己的项目目录（不是网关默认项目），只回重开回执（变异补测 10-24）', async () => {
      cardTask('om_rv_cd4', { ...reopenable, project: 'PR-02172' })
      await ingestLarkEvent({ raw: consoleEvent({ id: 'om_rv_cd4_r', text: '重开任务 om_rv_cd4 [Image: img_rv_reopen]' }), config, store })
      const task = store.get('om_rv_cd4')
      assert.equal(task.status, 'queued')
      assert.match(task.attachments?.find((item) => item.imageKey === 'img_rv_reopen')?.localPath || '', /\/PR-02172\/om_rv_cd4_r\//)
      assert.equal(posted.length, 1)
    }],
    ['话题里回复的是一条普通消息（不是卡）、话题里有两条未结束任务：按话题根找出两条，列出来让人选，不建任务（变异补测 10-24）', async () => {
      store.upsert({ id: 'om_rv_th1', source: 'lark', chatId: CONSOLE, threadRootId: 'omt_rv_th', text: 'a', summary: SUMMARY, status: 'running', createdAt: now() })
      store.upsert({ id: 'om_rv_th2', source: 'lark', chatId: CONSOLE, threadRootId: 'omt_rv_th', text: 'b', summary: '首页 banner 间距不对', status: 'queued', createdAt: now() })
      await ingestLarkEvent({ raw: consoleEvent({ id: 'om_rv_th_r', text: '这个再看下', root_id: 'omt_rv_th', reply_to: 'om_rv_th_human' }), config, store })
      assert.equal(posted.length, 1)
      assert.ok(sent()[0].includes(`om_rv_th1：${SUMMARY}`) && sent()[0].includes('om_rv_th2：首页 banner 间距不对'), sent()[0])
      assert.equal(store.has('om_rv_th_r'), false)
    }],
    ['回复活动任务卡的会话登记在仓库 chatIds 里：不发运行状态卡；@ 了机器人的不吞，交给后面的路径（控制台回「没对上任务」）（变异补测 10-24）', async () => {
      resetRepoProfiles()
      registerRepoProfiles({ repos: { falive: { ...faliveRaw, chatIds: [GROUP, CONSOLE], botMentionOpenIds: { [GROUP]: BOT, [CONSOLE]: BOT } } } })
      cardTask('om_rv_rn')
      await replyCard('om_rv_rn', 'om_rv_rn_r1', '接口地址改成 /api/v2/live 了')
      assert.equal(posted.length, 0, '不发通知卡')
      await replyCard('om_rv_rn', 'om_rv_rn_r2', '@Aven.Bot 接口地址改成 /api/v2/live 了', { mentions: BOT_MENTION })
      assert.equal(posted.length, 1)
      assert.ok(sent()[0].includes(CONSOLE_UNANCHORED_HINT))
      assert.equal(store.get('om_rv_rn').status, 'running')
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
    ['「就这样回」但草稿已作废：说明里点名的是哪条——有私聊来源摘要用它，没有就用任务摘要首行（变异补测 10-24）', async () => {
      const answered = (id, extra) => {
        const task = store.upsert({ id, source: 'lark', repo: 'falive', chatId: GROUP, operator: ENCONE, text: '原消息', summary: '直播列表接口字段不对', status: 'done', receipts: [{ messageId: `${id}_card`, epoch: 0, createdAt: now() }], createdAt: now(), ...extra })
        noteAnswer({ task, text: '更新的结论' })
      }
      try {
        answered('om_rv_hd1', { privateOrigin: { anchorHead: '首页 banner 间距不对' } })
        answered('om_rv_hd2')
        await ingestLarkEvent({ raw: consoleEvent({ id: 'om_rv_hd1_r', text: '就这样回', reply_to: 'om_rv_hd1_card' }), config, store })
        await ingestLarkEvent({ raw: consoleEvent({ id: 'om_rv_hd2_r', text: '就这样回', reply_to: 'om_rv_hd2_card' }), config, store })
        const sent = posted.map((item) => JSON.stringify(item.body))
        assert.equal(sent.length, 2)
        assert.ok(sent[0].includes('「首页 banner 间距不对」这条已经发过更新的结论了'), sent[0])
        assert.ok(sent[1].includes('「直播列表接口字段不对」这条已经发过更新的结论了'), sent[1])
      } finally {
        resetObligationMemory()
      }
    }],
    ['已答复过的任务，负责人私聊回的是新指示（不是「就这样回」）：照常建私聊指示任务，不回「没有待放行的草稿」（变异补测 10-24）', async () => {
      const task = store.upsert({ id: 'om_rv_ins', source: 'lark', repo: 'falive', chatId: GROUP, operator: ENCONE, text: '原消息', summary: '直播列表接口字段不对', status: 'done', receipts: [{ messageId: 'om_rv_ins_card', epoch: 0, createdAt: now() }], createdAt: now() })
      try {
        noteAnswer({ task, text: '更新的结论' })
        await ingestLarkEvent({ raw: consoleEvent({ id: 'om_rv_ins_r', text: '这个再看下接口字段', reply_to: 'om_rv_ins_card' }), config, store })
        assert.match(store.get('om_rv_ins_r')?.text || '', /私聊指示】这个再看下接口字段/, '建了指示任务')
        assert.equal(posted.some((item) => JSON.stringify(item.body).includes('已经发过更新的结论')), false)
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
