import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { runSteps } from './support/steps.mjs'

// 真实 ingest 段（变异补测 10-24）：lark-cli 换成 sh 小脚本（按子命令回桩 JSON、记下每次调用的参数），运行态（附件 / 回复义务）
// 指到临时目录。这两个变量在 lib 加载时读，必须先设好再动态 import。
// 脚本放固定路径、内容不变（桩目录走 LARK_FAKE_CLI_DIR）：macOS 第一次执行一个新路径的可执行文件要先扫一遍（约 300–450ms），
// 每次放进新的临时目录就每次都慢；固定路径只有本机第一次慢，之后每次起进程几毫秒。先写临时文件再改名，并行的测试进程不会读到半截。
const ingestRoot = mkdtempSync(join(tmpdir(), 'lark-thread-ingest-'))
const fakeDir = join(ingestRoot, 'fake-cli')
mkdirSync(fakeDir)
const FAKE_CLI_SCRIPT = `#!/bin/sh
dir="$LARK_FAKE_CLI_DIR"
{ for a in "$@"; do printf '%s\\037' "$a"; done; printf '\\036'; } >> "$dir/calls.log"
case "$4" in
  +messages-mget) f="$dir/mget.json" ;;
  +threads-messages-list) f="$dir/thread.json" ;;
  +chat-messages-list) f="$dir/chat.json" ;;
  *) f="" ;;
esac
if [ -n "$f" ] && [ -f "$f" ]; then cat "$f"; else printf '{"code":0,"data":{}}'; fi
`
const fakeBinDir = join(tmpdir(), 'lark-bot-test-fake-cli')
const fakeBin = join(fakeBinDir, 'lark-cli-recorder.sh')
if (!existsSync(fakeBin) || readFileSync(fakeBin, 'utf8') !== FAKE_CLI_SCRIPT) {
  mkdirSync(fakeBinDir, { recursive: true })
  const staging = join(fakeBinDir, `.lark-cli-recorder.${process.pid}`)
  writeFileSync(staging, FAKE_CLI_SCRIPT, { mode: 0o755 })
  renameSync(staging, fakeBin)
}
const savedEnv = Object.fromEntries(['LARK_CLI_BIN', 'LARK_FAKE_CLI_DIR', 'LARK_RUNTIME_DIR', 'LARK_INSTANCE_MODE'].map((key) => [key, process.env[key]]))
const restoreEnv = (key) => {
  if (savedEnv[key] === undefined) delete process.env[key]
  else process.env[key] = savedEnv[key]
}
process.env.LARK_CLI_BIN = fakeBin
process.env.LARK_FAKE_CLI_DIR = fakeDir
process.env.LARK_RUNTIME_DIR = join(ingestRoot, 'runtime')
after(() => {
  for (const key of Object.keys(savedEnv)) restoreEnv(key)
  rmSync(ingestRoot, { recursive: true, force: true })
})

const { applySupplementAddressing, ingestLarkEvent, isCompleteMessage, resolveIntakeLane, resolveIntakeNotBefore, resolveRepoAddressing } = await import('../lib/lark-ingest.mjs')
const { createTaskStore } = await import('../lib/lark-task-store.mjs')
const { registerRepoProfiles, resetRepoProfiles } = await import('../lib/lark-repo-profile.mjs')
const { noteHeld } = await import('../lib/lark-reply-obligation.mjs')

const withStore = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'lark-thread-intake-'))
  try {
    return fn(createTaskStore({ tasksDir: dir, leaseMs: 60_000 }))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const received = (store, extra = {}) => store.upsert({
  id: 'omt_thread1',
  source: 'lark',
  repo: 'falive',
  project: 'FALIVE',
  chatId: 'oc_x',
  threadRootId: 'omt_thread1',
  text: 'x',
  status: 'received',
  intake: { required: true, trigger: 'task_mention', notBefore: null },
  createdAt: new Date().toISOString(),
  ...extra,
})

describe('外部群任务入口：准确优先', () => {
  // 10-23 #74：forMe=true 的 medium 也直接开跑（见 lark-task-contract.test），疑似只剩归属拿不准 + medium；对接答复前端不用做的只记一笔
  it('resolveIntake 分类结论：仓库任务疑似 / 静默 / 开跑，fameex、对接文档（#53）、负责人本人、提问带文档（#38）', () => {
    // 单条用例表：每行一个独立 store，seed 建任务 → 领取 → 分类 → 核对结论
    const cases = [
      {
        name: 'fameex（无 repo）沿用 medium 即可开跑',
        id: 'om_f',
        seed: (store) => store.upsert({ id: 'om_f', source: 'lark', chatId: 'oc_f', text: 'x', status: 'received', intake: { required: true }, createdAt: new Date().toISOString() }),
        classification: { decision: 'bug', confidence: 'medium', summary: 's', reason: 'r' },
        want: { actionable: true },
      },
      {
        // 原 describe「对接文档只认 @ 机器人带来的（教训 #53）」
        name: '@ 机器人带文档附件：分类 ignore 也进执行器（api 命令），归属交分析判',
        id: 'omt_doc',
        seed: (store) => received(store, { id: 'omt_doc', threadRootId: null, addressedToBot: true, attachments: [{ type: 'file', fileName: 'PM-3217-对接文档.md', localPath: '/tmp/x.md' }] }),
        classification: { decision: 'ignore', confidence: 'high', forMe: false, summary: 's', reason: 'r' },
        want: { actionable: true, commandType: 'api' },
      },
      {
        name: '没 @ 机器人的文档：按分类走，不再一律进执行器',
        id: 'omt_doc2',
        seed: (store) => received(store, { id: 'omt_doc2', threadRootId: null, attachments: [{ type: 'file', fileName: '任务中心-后端问询清单.md', localPath: '/tmp/y.md' }] }),
        classification: { decision: 'ignore', confidence: 'high', forMe: false, summary: 's', reason: 'r' },
        want: { actionable: false },
      },
      {
        // 原 describe「负责人本人 @ 机器人」
        name: 'medium 也直接开跑，不挂疑似',
        id: 'omt_me',
        seed: (store) => received(store, { id: 'omt_me', threadRootId: null, addressedToBot: true, fromPrincipal: true }),
        classification: { decision: 'requirement', confidence: 'medium', forMe: true, summary: 's', reason: 'r' },
        want: { actionable: true },
      },
      {
        // 原 describe「提问带对接文档附件（教训 #38）」
        name: '分类为 question 时走只读作答（status），不因话题里带文档被当成 api 改代码工单',
        id: 'omt_q_doc',
        seed: (store) => received(store, { id: 'omt_q_doc', threadRootId: 'omt_q_doc', attachments: [{ type: 'file', fileName: 'aven-后端待办-自测新增-2026-10-19.md' }] }),
        classification: { decision: 'question', confidence: 'high', forMe: true, summary: 's', reason: 'r' },
        want: { actionable: true, commandType: 'status' },
      },
      {
        name: '对接答复带文档附件仍按 api 跑',
        id: 'omt_api_doc',
        seed: (store) => received(store, { id: 'omt_api_doc', threadRootId: 'omt_api_doc', attachments: [{ type: 'file', fileName: '回复.md' }] }),
        classification: { decision: 'api_reply', confidence: 'high', forMe: true, summary: 's', reason: 'r' },
        want: { commandType: 'api' },
      },
    ]
    return runSteps([
      ['仓库 profile 的任务：归属拿不准（forMe 未给）又不到 high 挂疑似待确认且不催办；ignore 静默', () => withStore((store) => {
        received(store)
        assert.ok(store.claimById('omt_thread1'))
        let out = store.resolveIntake({ id: 'omt_thread1', epoch: 0, classification: { decision: 'bug', confidence: 'medium', summary: 's', reason: 'r' } })
        assert.equal(out.actionable, false, '归属拿不准又不到 high 不开跑')
        assert.equal(out.suspected, true, '归属拿不准又不到 high 挂疑似')
        assert.equal(out.task.status, 'waiting_confirmation')
        assert.equal(out.task.parkedRemindedRound, 99, '疑似不催办')
        assert.match(out.task.result, /疑似需要处理/)

        received(store, { id: 'omt_thread2', threadRootId: 'omt_thread2' })
        store.claimById('omt_thread2')
        out = store.resolveIntake({ id: 'omt_thread2', epoch: 0, classification: { decision: 'bug', confidence: 'high', forMe: false, summary: 's', reason: 'r' } })
        assert.equal(out.actionable, false)
        assert.equal(out.suspected, false, '别人的功能（forMe=false）静默忽略，不算疑似')
        assert.equal(out.task.status, 'ignored')

        received(store, { id: 'omt_thread3', threadRootId: 'omt_thread3' })
        store.claimById('omt_thread3')
        // 10-23 #74：对接答复要说清前端交付什么才开跑（deliverable=null 是「前端不用做、只记一笔」）
        out = store.resolveIntake({ id: 'omt_thread3', epoch: 0, classification: { decision: 'api_reply', confidence: 'high', forMe: true, deliverable: 'change', summary: 's', reason: 'r' } })
        assert.equal(out.actionable, true, '对接答复说清前端交付什么才开跑')
        assert.equal(out.task.status, 'queued')
        assert.equal(out.task.commandType, 'api')

        received(store, { id: 'omt_thread5', threadRootId: 'omt_thread5' })
        store.claimById('omt_thread5')
        out = store.resolveIntake({ id: 'omt_thread5', epoch: 0, classification: { decision: 'question', confidence: 'high', forMe: true, summary: 's', reason: 'r' } })
        assert.equal(out.actionable, true, '群里向负责人提的问题：只读代答')
        assert.equal(out.task.commandType, 'status')

        received(store, { id: 'omt_thread6', threadRootId: 'omt_thread6' })
        store.claimById('omt_thread6')
        out = store.resolveIntake({ id: 'omt_thread6', epoch: 0, classification: { decision: 'question', confidence: 'medium', forMe: true, summary: 's', reason: 'r' } })
        assert.equal(out.actionable, true, '提问只读代答，medium 也直接答')

        received(store, { id: 'omt_thread4', threadRootId: 'omt_thread4' })
        store.claimById('omt_thread4')
        out = store.resolveIntake({ id: 'omt_thread4', epoch: 0, classification: { decision: 'ignore', confidence: 'high', forMe: false, summary: 's', reason: 'r' } })
        assert.equal(out.suspected, false, 'ignore 静默')
        assert.equal(out.task.status, 'ignored')
      })],
      ...cases.map(({ name, id, seed, classification, want }) => [name, () => withStore((store) => {
        seed(store)
        store.claimById(id)
        const out = store.resolveIntake({ id, epoch: 0, classification })
        if ('actionable' in want) assert.equal(out.actionable, want.actionable, name)
        if ('commandType' in want) assert.equal(out.task.commandType, want.commandType, name)
      })]),
    ])
  })

  it('分类去抖 notBefore 未到不可领取；已了结的话题任务被新消息重开（同一 id、epoch++、重新分类、历史留痕）', () => runSteps([
    ['分类去抖：notBefore 未到不可领取', () => withStore((store) => {
      received(store, { intake: { required: true, notBefore: new Date(Date.now() + 60_000).toISOString() } })
      assert.equal(store.claimById('omt_thread1'), null, '分类去抖：notBefore 未到不可领取')
      received(store, { intake: { required: true, notBefore: new Date(Date.now() - 1000).toISOString() } })
      assert.ok(store.claimById('omt_thread1'))
    })],
    ['已了结的话题任务被新消息重开：同一 id、epoch++、重新分类、历史留痕', () => withStore((store) => {
      received(store, { status: 'ignored', intake: { required: false }, result: 'old', epoch: 2 })
      assert.equal(store.reopenForThread({ id: 'omt_thread1', supplementText: '运维更新好了' }).status, 'received', '已了结的话题任务被新消息重开')
      const task = store.get('omt_thread1')
      assert.equal(task.epoch, 3)
      assert.equal(task.intake.required, true)
      assert.equal(task.intake.trigger, 'thread_followup')
      assert.match(task.text, /【话题新消息 .*】运维更新好了/)
      assert.equal(task.threadHistory.length, 1)
      assert.equal(task.threadHistory[0].status, 'ignored')
      // 活动态不可重开
      assert.equal(store.reopenForThread({ id: 'omt_thread1', supplementText: 'again' }), null, '活动态不可重开')
    })],
  ]))

  it('主题归并（并入未开跑 / 在跑 / 挂起 / 已了结，本条落 superseded）；疑似任务 48h 过期（#8）', () => runSteps([
    ['主题归并：并入未开跑 / 在跑 / 挂起 / 已了结的目标，本条落 superseded；最近任务候选排除自身与已归并', () => withStore((store) => {
      const mk = (id, status, extra = {}) => store.upsert({ id, source: 'lark', repo: 'falive', chatId: 'oc_x', text: `t-${id}`, status, topic: 'live-2', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...extra })
      mk('into_q', 'queued'); mk('from1', 'received', { commandType: 'api' })
      let out = store.mergeIntoTask({ fromId: 'from1', intoId: 'into_q' })
      assert.equal(out.mode, 'appended'); assert.match(store.get('into_q').text, /【同主题补充 .*】t-from1/); assert.equal(store.get('from1').status, 'superseded'); assert.equal(store.get('into_q').commandType, 'api')
      mk('into_r', 'running'); mk('from2', 'received')
      assert.equal(store.mergeIntoTask({ fromId: 'from2', intoId: 'into_r' }).mode, 'rerun_after_done'); assert.equal(store.get('into_r').rerunAfterDone, true)
      mk('into_w', 'waiting_confirmation', { epoch: 1 }); mk('from3', 'received')
      assert.equal(store.mergeIntoTask({ fromId: 'from3', intoId: 'into_w' }).mode, 'resumed'); assert.equal(store.get('into_w').status, 'queued'); assert.equal(store.get('into_w').epoch, 2)
      mk('into_s', 'waiting_confirmation', { epoch: 1, suspected: true }); mk('from3b', 'received')
      assert.equal(store.mergeIntoTask({ fromId: 'from3b', intoId: 'into_s' }).mode, 'appended_suspected', '疑似任务不因新消息自动开跑'); assert.equal(store.get('into_s').status, 'waiting_confirmation')
      mk('into_d', 'done', { epoch: 4, result: 'old' }); mk('from4', 'received')
      assert.equal(store.mergeIntoTask({ fromId: 'from4', intoId: 'into_d' }).mode, 'reopened'); assert.equal(store.get('into_d').status, 'queued'); assert.equal(store.get('into_d').epoch, 5); assert.equal(store.get('into_d').threadHistory.length, 1)
      const recent = store.listRecentForChat('oc_x', { excludeId: 'into_q' })
      assert.ok(recent.every((task) => task.status !== 'superseded' && task.id !== 'into_q'), '最近任务候选排除自身与已归并')
      assert.equal(store.mergeIntoTask({ fromId: 'nope', intoId: 'into_q' }), null)
    })],
    // 原 describe「疑似任务 48h 过期（#8）」
    ['挂满 48h 的疑似任务自动 ignored 并返回；未满的不动', () => withStore((store) => {
      const old = new Date(Date.now() - 49 * 3600_000).toISOString()
      store.upsert({ id: 's1', source: 'lark', repo: 'falive', chatId: 'oc_x', text: 'a', summary: '录播接口', status: 'waiting_confirmation', suspected: true, parkedAt: old, createdAt: old, updatedAt: old })
      store.upsert({ id: 's2', source: 'lark', repo: 'falive', chatId: 'oc_x', text: 'b', status: 'waiting_confirmation', suspected: true, parkedAt: new Date().toISOString(), createdAt: new Date().toISOString() })
      assert.equal(store.listSuspected().length, 2)
      const expired = store.expireSuspected()
      assert.deepEqual(expired.map((t) => t.id), ['s1'], '挂满 48h 的疑似任务自动 ignored 并返回')
      assert.equal(store.get('s1').status, 'ignored')
      assert.match(store.get('s1').result, /自动关闭/)
      assert.equal(store.listSuspected().length, 1, '未满的不动')
    })],
  ]))
})

// ── 真实 ingest 段的桩（变异补测 10-24）──────────────────────────────────────
const GROUP = 'oc_ti_group'
const CONSOLE = 'oc_ti_console'
const FGROUP = 'oc_ti_fameex'
const AVEN = 'ou_ti_aven'
const ENCONE = 'ou_ti_encone'
const ARTHUR = 'ou_ti_arthur'
const BOT = 'ou_ti_bot'
const APP_BOT = 'ou_ti_appbot'
const ingestConfig = { allowedChatIds: [GROUP, FGROUP], allowedOpenIds: [AVEN, ENCONE], botOpenId: APP_BOT, project: 'PR-1' }
const faliveRaw = {
  root: '/tmp/falive-ti', baseRef: 'main', chatIds: [GROUP], notifyChatId: CONSOLE, docIntakeDir: 'docs/delivery/pending',
  ownership: { me: 'Aven', meOpenIds: [AVEN] }, ownerMap: { Encone: ENCONE, Arthur: ARTHUR }, botMentionOpenIds: { [GROUP]: BOT },
  webhooksByChat: { [GROUP]: { url: 'https://hook/group' }, [CONSOLE]: { url: 'https://hook/console' } },
}
const atBot = [{ id: BOT, key: '@_user_1', name: 'Aven.Bot' }]
let posted
let ingestStore
let ingestDir
let savedFetch
const ingestHooks = {
  before: () => {
    process.env.LARK_INSTANCE_MODE = 'repo-only'
    savedFetch = globalThis.fetch
    posted = []
    globalThis.fetch = async (url, init) => {
      posted.push({ url: String(url), body: String(init?.body || '') })
      return { ok: true, status: 200, text: async () => '{"code":0}', json: async () => ({ code: 0 }) }
    }
    registerRepoProfiles({ repos: { falive: faliveRaw } })
    ingestDir = mkdtempSync(join(ingestRoot, 'case-'))
    ingestStore = createTaskStore({ tasksDir: join(ingestDir, 'tasks'), leaseMs: 60_000 })
  },
  after: () => {
    restoreEnv('LARK_INSTANCE_MODE')
    globalThis.fetch = savedFetch
    resetRepoProfiles()
    for (const name of ['calls.log', 'mget.json', 'thread.json', 'chat.json']) rmSync(join(fakeDir, name), { force: true })
    rmSync(ingestDir, { recursive: true, force: true })
    rmSync(process.env.LARK_RUNTIME_DIR, { recursive: true, force: true })
  },
}
// 假 lark-cli 的回包：mget = 被引用消息，thread = 话题回复（新的在前），chat = 群里之前的消息（新的在前）
const fakeLarkCli = (replies) => {
  for (const [name, messages] of Object.entries(replies)) writeFileSync(join(fakeDir, `${name}.json`), JSON.stringify({ code: 0, data: { messages, has_more: false } }))
}
const cliCalls = () => (existsSync(join(fakeDir, 'calls.log')) ? readFileSync(join(fakeDir, 'calls.log'), 'utf8').split('\x1e').filter(Boolean).map((call) => call.split('\x1f').filter(Boolean)) : [])
const ingestRaw = (raw) => ingestLarkEvent({ raw: { sender_type: 'user', message_type: 'text', ...raw }, config: ingestConfig, store: ingestStore })
const groupSay = ({ id, content, sender = ENCONE, mentions = atBot, replyTo = null, root = null, createTime = null, chat = GROUP }) =>
  ingestRaw({ message_id: id, chat_id: chat, chat_type: 'group', content, sender_id: sender, mentions, ...(replyTo ? { reply_to: replyTo } : {}), ...(root ? { root_id: root } : {}), ...(createTime ? { create_time: String(createTime) } : {}) })
const dmSay = ({ id, content, chat = CONSOLE, replyTo = null }) =>
  ingestRaw({ message_id: id, chat_id: chat, chat_type: 'p2p', content, sender_id: AVEN, ...(replyTo ? { reply_to: replyTo } : {}) })
const postedTo = (hook) => posted.filter((item) => item.url === `https://hook/${hook}`).map((item) => item.body)
const seedTask = (task) => ingestStore.upsert({ source: 'lark', repo: 'falive', project: 'FALIVE', chatId: GROUP, operator: ENCONE, text: '原任务', createdAt: new Date().toISOString(), ...task })

describe('话题补充 @ 机器人（10-23 起外部群只有 @bot 的任务）', () => {
  it('补充 @ 机器人：标显式通道；10-23 前的存量被动任务被接手，去掉只记台账；补充没 @ 不改通道；真实 ingest：@bot 建任务带全上下文 / 续跑 / 私聊放行 / 日报', () => runSteps([
    ['补充 @ 机器人：标显式通道；10-23 前的存量被动任务被接手，去掉只记台账；补充没 @ 不改通道', () => {
      const target = { id: 'omt_reserve', passiveLedgerOnly: true }
      assert.equal(applySupplementAddressing({ target, addressing: { toBot: true, fromPrincipal: true } }), true)
      assert.equal(target.passiveLedgerOnly, undefined)
      assert.equal(target.addressedToBot, true)
      assert.equal(target.fromPrincipal, true)
      assert.equal(applySupplementAddressing({ target, addressing: { toBot: true } }), false, '已经是显式通道，不重复回收到')
      const other = { id: 'omt_p', addressedToBot: true }
      assert.equal(applySupplementAddressing({ target: other, addressing: { toBot: false } }), false)
    }],
    ['外部群 @bot 回复一条消息：任务带上被引用原文与本条原话、话题回复 / 群里之前的图（标明来源）、他提到的那份文档（负责人自己发的不算）、他正在进行的事；话题身份 = 被回复的消息，项目 = 仓的项目号，附件落仓的项目目录（变异补测 10-24）', async () => {
      const now = Date.now()
      const min = 60_000
      seedTask({ id: 'om_ti_prev', summary: '开播 500', status: 'done', createdAt: new Date(now - 10 * min).toISOString() })
      fakeLarkCli({
        mget: [{ message_id: 'om_ti_parent', msg_type: 'text', content: '直播列表 cover 字段为空', sender: { id: 'ou_ti_qa', name: 'QA小王' }, create_time: String(now - 30 * min) }],
        thread: [{ message_id: 'om_ti_th1', msg_type: 'image', content: '{"image_key":"img_thread"}', sender: { id: ARTHUR, sender_type: 'user', name: 'Arthur' } }],
        chat: [
          { message_id: 'om_ti_c4', msg_type: 'text', content: '没人署名的那句', sender: { id: 'ou_ti_anon', sender_type: 'user' }, create_time: String(now - 1 * min) },
          { message_id: 'om_ti_c3', msg_type: 'image', content: '{"image_key":"img_recent"}', sender: { id: ENCONE, sender_type: 'user', name: 'Encone' }, create_time: String(now - 2 * min) },
          { message_id: 'om_ti_c2', msg_type: 'file', content: '<file key="file_v3_mine" name="mine-notes.md"/>', sender: { id: AVEN, sender_type: 'user', name: 'Aven' }, create_time: String(now - 3 * min) },
          { message_id: 'om_ti_c1', msg_type: 'file', content: '<file key="file_v3_api" name="live-api.md"/>', sender: { id: ARTHUR, sender_type: 'user', name: 'Arthur' }, create_time: String(now - 4 * min) },
        ],
      })
      await groupSay({ id: 'om_ti_r1', content: '@_user_1 看下这个文档里的报错 [Image: img_own]', replyTo: 'om_ti_parent', createTime: now })
      const task = ingestStore.get('om_ti_r1')
      assert.ok(task, '建了任务')
      assert.equal(task.threadRootId, 'om_ti_parent', '只回复没进话题：话题身份 = 被回复的消息')
      assert.equal(task.project, 'FALIVE', '项目 = 仓的项目号')
      assert.ok(task.text.includes('【被引用消息】') && task.text.includes('直播列表 cover 字段为空'), '带被引用原文')
      assert.ok(task.text.includes('【本条 @】@Aven.Bot 看下这个文档里的报错'), '带本条原话，不是「无附言」')
      assert.ok(!task.text.includes('群里发来对接文档'), '普通 @bot 不当成「接文档」')
      assert.ok(task.text.includes('【Encone 正在进行的事'), '对话包标明是谁（不是「发送人」）')
      assert.match(task.text, /\n（\d{2}-\d{2} \d{2}:\d{2}）：没人署名的那句/, '群里之前的消息：没署名也用「：」隔开正文')
      const byKey = (key) => task.attachments.find((item) => item.imageKey === key || item.fileKey === key)
      assert.equal(byKey('img_own')?.origin, '本条', '本条的图带上并标来源')
      assert.ok(byKey('img_own').localPath.includes(join('FALIVE', 'om_ti_r1')), '附件落仓的项目目录')
      assert.equal(byKey('img_thread')?.origin, '话题回复 · Arthur', '话题回复的图标明是谁发的')
      assert.match(byKey('img_recent')?.origin || '', /^群里之前的消息 · Encone \d{2}-\d{2} \d{2}:\d{2}$/, '群里之前的图标明谁、什么时候')
      assert.equal(byKey('file_v3_api')?.fileName, 'live-api.md', '他提到文档：并入之前别人发的那份')
      assert.match(byKey('file_v3_api').origin, /^群里之前的消息 · Arthur \d{2}-\d{2} \d{2}:\d{2}$/)
      assert.equal(byKey('file_v3_mine'), undefined, '负责人自己发的文档不算要接的')
    }],
    ['外部群 @bot 回复一条带文档的消息：被引用的文档就是要接的，不再并群里更早别人发的文档（变异补测 10-24）', async () => {
      const now = Date.now()
      fakeLarkCli({
        mget: [{ message_id: 'om_ti_docmsg', msg_type: 'file', content: '<file key="file_v3_reply" name="reply-api.md"/>', sender: { id: ARTHUR, name: 'Arthur' } }],
        chat: [{ message_id: 'om_ti_old', msg_type: 'file', content: '<file key="file_v3_old" name="old-api.md"/>', sender: { id: ARTHUR, sender_type: 'user', name: 'Arthur' }, create_time: String(now - 60_000) }],
      })
      await groupSay({ id: 'om_ti_r2', content: '@_user_1 按这个文档接一下', replyTo: 'om_ti_docmsg', createTime: now })
      const names = ingestStore.get('om_ti_r2').attachments.map((item) => item.fileName)
      assert.deepEqual(names, ['reply-api.md'])
      assert.match(ingestStore.get('om_ti_r2').attachments[0].origin, /^被引用消息/)
    }],
    ['外部群 @bot 只带对接文档没有正文：任务正文写明「群里发来对接文档 <文件名>」和存放目录；带了正文的照原话（变异补测 10-24）', async () => {
      // 两条换人发：同一个人连发会并成一条（话题补充）
      await groupSay({ id: 'om_ti_doc1', content: '<file key="file_v3_pm" name="PM-1.md"/>' })
      const intro = ingestStore.get('om_ti_doc1').text
      assert.ok(intro.startsWith('api：群里发来对接文档 PM-1.md。'), intro)
      assert.ok(intro.includes('docs/delivery/pending/'))
      await groupSay({ id: 'om_ti_doc2', sender: ARTHUR, content: '@_user_1 接一下 <file key="file_v3_pm2" name="PM-2.md"/>' })
      assert.equal(ingestStore.get('om_ti_doc2').text, '@Aven.Bot 接一下')
    }],
    ['外部群 @bot「继续任务 <id> 补充」续跑阻塞的任务：补充原话进正文、附件落原任务的项目目录，不当成负责人放行、不当成疑似单旁注（变异补测 10-24）', async () => {
      seedTask({ id: 'om_ti_blk', status: 'blocked', epoch: 1 })
      await groupSay({ id: 'om_ti_res1', content: '@_user_1 继续任务 om_ti_blk 接口改成 v2 [Image: img_sup]' })
      const task = ingestStore.get('om_ti_blk')
      assert.equal(task.status, 'queued', '阻塞的任务也能续跑')
      assert.equal(task.resumeCount, 1)
      assert.ok(task.text.includes('【补料】\n接口改成 v2'), task.text)
      assert.ok(!task.text.includes('负责人放行'), '不是负责人，不当放行')
      assert.equal(ingestStore.has('om_ti_res1'), false, '不另建任务')
      assert.ok(task.attachments.find((item) => item.imageKey === 'img_sup').localPath.includes(join('FALIVE', 'om_ti_res1')), '附件落原任务的项目目录')
    }],
    ['外部群 @bot 在话题里回复某条（不是话题根）：按话题归并到唯一挂起的任务续跑，不另建任务（变异补测 10-24）', async () => {
      seedTask({ id: 'om_ti_sib', threadRootId: 'om_ti_root', status: 'waiting_confirmation', epoch: 1 })
      await groupSay({ id: 'om_ti_tm', content: '@_user_1 补一句：只在安卓上出现', root: 'om_ti_root', replyTo: 'om_ti_mid' })
      assert.equal(ingestStore.get('om_ti_sib').status, 'queued')
      assert.ok(ingestStore.get('om_ti_sib').text.includes('只在安卓上出现'))
      assert.equal(ingestStore.has('om_ti_tm'), false)
    }],
    ['负责人私聊「继续任务 <id> 补充」：只把补充原话（不含指令）续进原任务，不当成放行，也不再建私聊指示任务（变异补测 10-24）', async () => {
      seedTask({ id: 'om_ti_wc', status: 'waiting_confirmation', epoch: 1 })
      await dmSay({ id: 'om_ti_dm1', content: '继续任务 om_ti_wc 改成 v2 接口' })
      const task = ingestStore.get('om_ti_wc')
      assert.equal(task.status, 'queued')
      assert.ok(task.text.endsWith('【补料】\n改成 v2 接口'), task.text)
      assert.ok(!task.text.includes('负责人放行'))
      assert.equal(ingestStore.has('om_ti_dm1'), false, '续跑了就不再建指示任务')
      assert.equal(postedTo('console').length, 1, `控制台只收到开工那一句，不再补「没对上任务」：${postedTo('console').join('\n')}`)
    }],
    ['负责人回「就这样回」：扣下的草稿发群，控制台只收到一句结果（含锚定那条的标题）；在别的私聊会话回、发不出去时，原因也发到控制台（变异补测 10-24）', async () => {
      const held = (id) => {
        const task = seedTask({ id, summary: '直播列表 cover 为空', status: 'done', receipts: [{ messageId: `${id}_card`, epoch: 0, createdAt: new Date().toISOString() }] })
        noteHeld({ task, text: '已修好，可以再测' })
      }
      held('om_ti_held')
      await dmSay({ id: 'om_ti_dm2', content: '就这样回', replyTo: 'om_ti_held_card' })
      assert.ok(postedTo('group').some((body) => body.includes('已修好，可以再测')), '草稿发群')
      assert.deepEqual(postedTo('console').map((body) => body.includes('已按原文回群（直播列表 cover 为空）。')), [true], '控制台只收到一句结果，带锚定那条的标题')
      assert.equal(ingestStore.has('om_ti_dm2'), false, '不建指示任务')
      registerRepoProfiles({ repos: { falive: { ...faliveRaw, webhooksByChat: { [CONSOLE]: { url: 'https://hook/console' } } } } })
      posted.length = 0
      held('om_ti_held2')
      await dmSay({ id: 'om_ti_dm3', content: '就这样回', chat: 'oc_ti_aven_dm', replyTo: 'om_ti_held2_card' })
      const [note] = postedTo('console')
      assert.ok(note?.includes('没发出去：') && note.includes('还没配 webhook'), note)
      assert.ok(!note.includes('找不到要发的群'))
    }],
    ['负责人私聊回一条已了结任务的通知、说新要求：建私聊指示任务、控制台只回一句「收到」，不再补「没对上任务」（变异补测 10-24）', async () => {
      seedTask({ id: 'om_ti_ins', summary: '开播 500', status: 'done', receipts: [{ messageId: 'om_ti_ins_card', epoch: 0, createdAt: new Date().toISOString() }] })
      await dmSay({ id: 'om_ti_dm4', content: '顺便把封面也换成默认图', replyTo: 'om_ti_ins_card' })
      assert.ok(ingestStore.has('om_ti_dm4'), '建了指示任务')
      const replies = postedTo('console')
      assert.equal(replies.length, 1, replies.join('\n'))
      assert.ok(replies[0].includes('当作对「开播 500」'))
    }],
    ['群里 @bot「补发日报」：开了日报的仓走日报链路、不建普通任务；没开日报的仓当普通任务（变异补测 10-24）', async () => {
      await groupSay({ id: 'om_ti_daily1', content: '@_user_1 补发日报' })
      assert.ok(ingestStore.has('om_ti_daily1'), '没开日报：普通任务')
      registerRepoProfiles({ repos: { falive: { ...faliveRaw, dailyReport: { at: '19:00' } } } })
      await groupSay({ id: 'om_ti_daily2', sender: ARTHUR, content: '@_user_1 补发日报' })
      assert.equal(ingestStore.has('om_ti_daily2'), false, '开了日报：不建普通任务')
      assert.equal(ingestStore.list().filter((task) => task.id !== 'om_ti_daily1').length, 1, '建了日报任务')
    }],
    ['fameex 群只 @bot 回复一条消息：摘要取被引用原文，不拉群里之前的消息（那是外部群的）（变异补测 10-24）', async () => {
      delete process.env.LARK_INSTANCE_MODE
      fakeLarkCli({
        mget: [{ message_id: 'om_ti_fparent', msg_type: 'text', content: '直播列表 cover 为空', sender: { id: 'ou_ti_qa', name: 'QA小王' } }],
        chat: [{ message_id: 'om_ti_fc1', msg_type: 'text', content: 'pre 上也一样', sender: { id: ENCONE, sender_type: 'user', name: 'Encone' }, create_time: String(Date.now() - 60_000) }],
      })
      await groupSay({ id: 'om_ti_f1', chat: FGROUP, content: '@_user_1', mentions: [{ id: APP_BOT, key: '@_user_1', name: '应用' }], replyTo: 'om_ti_fparent', createTime: Date.now() })
      const task = ingestStore.get('om_ti_f1')
      assert.equal(task.summary, '直播列表 cover 为空')
      assert.ok(!task.text.includes('【群里这条之前的消息】'))
      assert.equal(cliCalls().some((args) => args.includes('+chat-messages-list')), false, '不拉群消息')
    }],
    ['fameex 群回复待确认卡「确认扩大范围」：续跑回执点名并入的文件（变异补测 10-24）', async () => {
      delete process.env.LARK_INSTANCE_MODE
      seedTask({ id: 'om_ti_scope', repo: undefined, project: null, chatId: FGROUP, status: 'waiting_confirmation', epoch: 1, scopeRequest: { paths: ['src/modules/live/LivePage.tsx'] }, receipts: [{ messageId: 'om_ti_scope_card', epoch: 1, createdAt: new Date().toISOString() }] })
      await groupSay({ id: 'om_ti_f2', chat: FGROUP, content: '确认扩大范围，按申请的一起改', mentions: [], replyTo: 'om_ti_scope_card' })
      assert.equal(ingestStore.get('om_ti_scope').status, 'queued')
      const cards = cliCalls().filter((args) => args.includes('+messages-send')).map((args) => args.join(' '))
      assert.ok(cards.some((card) => card.includes('已确认扩大修改范围（并入 src/modules/live/LivePage.tsx）')), cards.join('\n'))
    }],
  ], ingestHooks))
})

describe('分类去抖分道（阶段 2）', () => {
  const intake = { fastLaneMs: 0, quietGapMs: 60_000, maxWaitMs: 180_000 }
  const now = Date.parse('2026-10-15T10:00:00Z')
  it('快慢道判定、notBefore 计算（安静期 / 顺延封顶）、完整件慢道也不等', () => runSteps([
    ['@ 机器人 / 回复 bot 的卡 / 负责人本人 → 快道；被动上下文 → 慢道', () => {
      assert.equal(resolveIntakeLane({ addressing: { toBot: true } }), 'fast', '@ 机器人 → 快道')
      assert.equal(resolveIntakeLane({ addressing: { fromPrincipal: true } }), 'fast', '负责人本人 → 快道')
      assert.equal(resolveIntakeLane({ addressing: {}, quotedIsOurs: true }), 'fast', '回复 bot 的卡 → 快道')
      assert.equal(resolveIntakeLane({ addressing: { toBot: false } }), 'slow', '被动上下文 → 慢道')
    }],
    ['快道不等；慢道首条等安静期；补充只顺延到首条 + 封顶；超过封顶立刻', () => {
      assert.equal(resolveIntakeNotBefore({ lane: 'fast', firstReceivedAt: new Date(now).toISOString(), now, intake }), new Date(now).toISOString(), '快道不等')
      assert.equal(resolveIntakeNotBefore({ lane: 'slow', firstReceivedAt: new Date(now).toISOString(), now, intake }), new Date(now + 60_000).toISOString(), '慢道首条等安静期')
      assert.equal(resolveIntakeNotBefore({ lane: 'slow', firstReceivedAt: new Date(now - 150_000).toISOString(), now, intake }), new Date(now + 30_000).toISOString(), '补充只顺延到首条 + 封顶')
      assert.equal(resolveIntakeNotBefore({ lane: 'slow', firstReceivedAt: new Date(now - 200_000).toISOString(), now, intake }), new Date(now).toISOString(), '超过封顶立刻')
    }],
    ['完整件（对接文档 / ≥200 字）慢道也不等', () => {
      assert.equal(isCompleteMessage({ msg: { text: '再看看', attachments: [] } }), false)
      assert.equal(isCompleteMessage({ msg: { text: '预'.repeat(200), attachments: [] } }), true, '≥200 字是完整件')
      assert.equal(isCompleteMessage({ msg: { text: '', attachments: [{ type: 'file', fileName: 'PM-3217.md' }] } }), true, '对接文档是完整件')
      assert.equal(resolveIntakeNotBefore({ lane: 'slow', complete: true, firstReceivedAt: new Date(now).toISOString(), now, intake }), new Date(now).toISOString(), '完整件慢道也不等')
    }],
  ]))
})
