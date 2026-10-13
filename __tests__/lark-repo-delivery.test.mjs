import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import {
  buildRepoGroupText,
  buildRepoNote,
  buildRepoStartNote,
  buildRepoSuspectedNote,
  deliverRepoAck,
  deliverRepoIgnoredAfterAck,
  deliverRepoOutcome,
  mentionsMe,
  humanizeResult,
  isHumanDeliveryTask,
} from '../lib/lark-repo-delivery.mjs'
import { parkedReminderRound, remindParkedTasks } from '../lib/lark-parked-reminder.mjs'
import { addRepoChatIds, registerRepoProfiles, repoProfile, resetRepoProfiles } from '../lib/lark-repo-profile.mjs'

const ownerMap = { Ache: 'ou_ache', Encone: 'ou_encone' }
const register = () => {
  registerRepoProfiles({ repos: { falive: { root: '/tmp/falive-react', baseRef: 'main', chatIds: ['oc_falive'], notifyChatId: 'ou_aven', ownerMap, ownership: { me: 'aven' } } } })
  addRepoChatIds('falive', ['oc_falive'], { oc_falive: 'falive后端go天团' })
}

describe('仓库任务的人话出口', () => {
  afterEach(() => resetRepoProfiles())

  it('结构化结果 → 人话：去掉定型首行、编号、判定 / 系统实测 / 范围契约等机器行', () => {
    const lines = humanizeResult('已完成，待发布。\n1. 按 Ache 的 A1–A7 更新了 upcoming 的 schema 和文档。\n2. 判定：不归本 bot 代理\n修改范围契约：\n· 契约目标（1）：\n  - docs/x.md\n· 排除的兄弟位置（19）：\n  - src/a.ts：x\n  - …另 11 项\n**系统实测**：实测改动 1 处\n**Worker 终检**：通过')
    assert.deepEqual(lines, ['按 Ache 的 A1–A7 更新了 upcoming 的 schema 和文档。'])
  })

  it('私聊消息：done 带分支 / 文件数 / 群里发没发；停下来带「要什么」；疑似与开始各一行', () => {
    register()
    const profile = repoProfile('falive')
    const task = { id: 't1', chatId: 'oc_falive', repo: 'falive', summary: 'upcoming 接好了', branch: 'lark/falive-1', changedFiles: ['a', 'b', 'c'], followUpDoc: 'docs/delivery/pending/x-待确认.md' }
    const done = buildRepoNote({ task, status: 'done', profile, result: '已完成，待发布。\n1. upcoming 的昵称和预约状态按 A1–A7 接好了，pre 可以复测。', docUrl: 'https://doc/1', groupOutcome: { ok: false, reason: 'falive后端go天团 还没配 webhook', text: '<at user_id="ou_ache">Ache</at> 接完了。\n— 由 aven 的助手整理' }, mentions: [{ owner: 'Ache', openId: 'ou_ache', items: ['A9'] }] })
    assert.equal(done, '✅ upcoming 的昵称和预约状态按 A1–A7 接好了，pre 可以复测。\n分支 lark/falive-1 · 改了 3 个文件\n要 Ache 跟进：https://doc/1\n群里没发（falive后端go天团 还没配 webhook），要回可以转发这段：\n@Ache 接完了。')
    const blocked = buildRepoNote({ task, status: 'blocked', profile, result: '已阻塞，需外部材料 / 权限后才能继续。\n1. 录播详情接口没有。\n2. 待补充：R2 详情接口；pre 灌数据' })
    assert.equal(blocked, '⏸ 停下来了（falive后端go天团）：录播详情接口没有。\n要：R2 详情接口；pre 灌数据\n回复这条消息把材料补上就会继续。')
    assert.equal(buildRepoNote({ task, status: 'no_change_needed', profile, result: '无需改动。\n1. 这是 henry 的区块。' }), 'ℹ️ 看过了，不用改（falive后端go天团）：这是 henry 的区块。')
    assert.match(buildRepoNote({ task, status: 'failed', profile, result: '处理失败。\n1. 任务：x；\n2. 失败类型：工具\n3. 下一步：看日志' }), /^⛔ 没做成（falive后端go天团）：任务：x；\n看日志$/)
    assert.equal(buildRepoStartNote({ task, profile }), '🛠 开始做：upcoming 接好了（falive后端go天团）')
    assert.match(buildRepoSuspectedNote({ task, profile }), /^❓ 可能是你的事（falive后端go天团）：upcoming 接好了\n是 → 回「继续任务 t1 做」/)
  })

  it('群里那句：done 一句 ✅；有待跟进 → @ + 链接 + 每人要点；提问代答只发答案', () => {
    assert.equal(buildRepoGroupText({ task: { groupReply: '接好了，pre 可以复测。' } }), '✅ 接好了，pre 可以复测\n— 由 aven 的助手整理')
    assert.equal(buildRepoGroupText({ task: { groupReply: 'A2 已接完' }, mentions: [{ owner: 'Ache', openId: 'ou_ache', items: ['A9', 'A10'] }], docUrl: 'https://doc/1' }), '<at user_id="ou_ache">Ache</at> A2 已接完。待确认的几点在这里：https://doc/1\nAche：A9；A10\n— 由 aven 的助手整理')
    assert.equal(buildRepoGroupText({ task: { commandType: 'status', groupReply: '前端只用了 info.start_the_transaction' } }), '前端只用了 info.start_the_transaction\n— 由 aven 的助手整理')
  })

  it('deliverRepoOutcome：有 webhook 发群 + 私聊；没 webhook 只私聊并附要发的话；非仓库任务跳过', async () => {
    register()
    const sent = []
    const hooks = []
    const deps = {
      sendMarkdown: async (args) => { sent.push(args); return { ok: true, messageId: 'om_note' } },
      sendWebhookMessage: async (args) => { hooks.push(args); return { ok: true } },
      materializeDoc: () => ({ dir: '/tmp/x', file: 'x.md' }),
      createLarkDoc: async () => ({ ok: true, url: 'https://doc/2' }),
      webhookFor: () => ({ url: 'https://hook', secret: 's' }),
    }
    const task = { id: 't2', chatId: 'oc_falive', repo: 'falive', summary: 's', branch: 'lark/falive-2', groupReply: '接完了', followUpDoc: 'docs/x.md', followUps: [{ owner: 'Encone', items: ['补 uid'] }] }
    const out = await deliverRepoOutcome({ task, status: 'done', result: '已完成，待发布。\n1. 接完了。', deps })
    assert.equal(out.ok, true)
    assert.equal(out.messageId, 'om_note')
    assert.equal(hooks.length, 1)
    assert.match(hooks[0].text, /<at user_id="ou_encone">Encone<\/at> 接完了。待确认的几点在这里：https:\/\/doc\/2/)
    assert.equal(sent[0].chatId, 'ou_aven')
    assert.match(sent[0].markdown, /群里已回：「Encone 接完了。待确认的几点在这里：https:\/\/doc\/2」/)
    const noHook = await deliverRepoOutcome({ task: { ...task, followUpDoc: null, followUps: null }, status: 'done', result: 'x', deps: { ...deps, webhookFor: () => null } })
    assert.match(noHook.note, /群里没发（falive后端go天团 还没配 webhook），要回可以转发这段：\n✅ 接完了/)
    assert.equal(hooks.length, 1)
    assert.deepEqual(await deliverRepoOutcome({ task: { id: 't3', chatId: 'oc_pr', project: 'PR-00001' }, status: 'done', result: 'x', deps }), { ok: false, skipped: true })
    assert.equal(isHumanDeliveryTask({ id: 'x', chatId: 'oc_pr', project: 'PR-00001' }), false)
  })

  it('仓库任务不催办；默认仓照旧', async () => {
    register()
    const now = Date.now()
    const parked = (extra) => ({ id: 'p', status: 'blocked', parkedAt: new Date(now - 5 * 3600_000).toISOString(), chatId: 'oc_falive', ...extra })
    assert.equal(parkedReminderRound({ task: parked({}), now }), 1)
    const upserts = []
    const store = { list: () => [parked({ repo: 'falive' })], upsert: (task) => upserts.push(task), recordReceipt: () => {} }
    await remindParkedTasks({ config: { project: 'PR-00001', ownerMap: {} }, store, now })
    assert.equal(upserts.length, 0, '仓库任务不催办、不记轮次')
  })
})

describe('直接 @ 负责人先回「收到」', () => {
  afterEach(() => resetRepoProfiles())
  it('@ 到负责人才回；有 webhook 才发；判 ignore 后私聊说明', async () => {
    registerRepoProfiles({ repos: { falive: { root: '/tmp/f', baseRef: 'main', chatIds: ['oc_t'], notifyChatId: 'ou_aven', taskMentionOpenIds: ['ou_aven'], ownership: { me: 'aven' } } } })
    const profile = repoProfile('falive')
    assert.equal(mentionsMe({ profile, mentions: [{ id: 'ou_aven' }] }), true)
    assert.equal(mentionsMe({ profile, mentions: [{ id: 'ou_x' }] }), false)
    const hooks = []
    const ok = await deliverRepoAck({ task: { id: 't', chatId: 'oc_t', repo: 'falive' }, deps: { webhookFor: () => ({ url: 'u' }), sendWebhookMessage: async (a) => { hooks.push(a); return { ok: true } } } })
    assert.equal(ok.ok, true)
    assert.match(hooks[0].text, /^收到，我查一下/)
    assert.equal((await deliverRepoAck({ task: { id: 't', chatId: 'oc_t', repo: 'falive' }, deps: { webhookFor: () => null } })).skipped, true)
    const notes = []
    await deliverRepoIgnoredAfterAck({ task: { id: 't', chatId: 'oc_t', repo: 'falive', summary: '直播详情页还差什么接口', intake: { classification: { reason: '问进度' } } }, deps: { sendMarkdown: async (a) => { notes.push(a); return { ok: true } } } })
    assert.match(notes[0].markdown, /判断不用我处理.*\n理由：问进度\n判错了就回「继续任务 t 做」/)
  })
})
