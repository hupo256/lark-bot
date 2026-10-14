import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import {
  buildGroupCard,
  FALLBACK_TEXT,
  buildRepoBlockedGroupText,
  followUpTopicKey,
  buildRepoGroupText,
  extractBlockers,
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
import { findCompletionContradiction, findCountMismatch, findGroupReplyContradiction } from '../lib/lark-completion-rule.mjs'
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
    const done = buildRepoNote({ task, status: 'done', profile, result: '已完成，待发布。\n1. upcoming 的昵称和预约状态按 A1–A7 接好了，pre 可以复测。', docUrl: 'https://doc/1', groupOutcome: { ok: false, reason: 'falive后端go天团 还没配 webhook', text: '@Ache 接完了。' }, mentions: [{ owner: 'Ache', openId: 'ou_ache', items: ['A9'] }] })
    assert.equal(done, '✅ upcoming 的昵称和预约状态按 A1–A7 接好了，pre 可以复测。\n分支 lark/falive-1 · 改了 3 个文件\n要 Ache 跟进：https://doc/1\n群里没发（falive后端go天团 还没配 webhook），要回可以转发这段：\n@Ache 接完了。')
    const blocked = buildRepoNote({ task, status: 'blocked', profile, result: '已阻塞，需外部材料 / 权限后才能继续。\n1. 录播详情接口没有。\n2. 待补充：R2 详情接口；pre 灌数据' })
    assert.equal(blocked, '⏸ 停下来了（falive后端go天团）：录播详情接口没有。\n要：R2 详情接口；pre 灌数据\n回复这条消息把材料补上就会继续。')
    assert.equal(buildRepoNote({ task, status: 'no_change_needed', profile, result: '无需改动。\n1. 这是 henry 的区块。' }), 'ℹ️ 看过了，不用改（falive后端go天团）：这是 henry 的区块。')
    assert.match(buildRepoNote({ task, status: 'failed', profile, result: '处理失败。\n1. 任务：x；\n2. 失败类型：工具\n3. 下一步：看日志' }), /^⛔ 没做成（falive后端go天团）：任务：x；\n看日志$/)
    assert.equal(buildRepoStartNote({ task, profile }), '🛠 开始做：upcoming 接好了（falive后端go天团）')
    assert.match(buildRepoSuspectedNote({ task, profile }), /^❓ 可能是你的事（falive后端go天团）：upcoming 接好了\n是 → 回「继续任务 t1 做」/)
  })

  it('群里那句：done 一句 ✅；有待跟进 → @ + 链接 + 每人要点；提问代答只发答案', () => {
    assert.equal(buildRepoGroupText({ task: { groupReply: '接好了，pre 可以复测。' } }), '✅ 接好了，pre 可以复测。')
    const mentions = [{ owner: 'Ache', openId: 'ou_ache', items: ['A9', 'A10'] }]
    const body = buildRepoGroupText({ task: { groupReply: 'A2 已接完。' }, mentions, docUrl: 'https://doc/1' })
    assert.equal(body, '@Ache A2 已接完。\n待确认的几点在这里：https://doc/1\n- Ache：A9；A10')
    const card = buildGroupCard({ body, mentions })
    assert.equal(card.elements[0].content, '<at id=ou_ache></at> A2 已接完。\n待确认的几点在这里：https://doc/1\n- Ache：A9；A10')
    assert.deepEqual(card.elements[1], { tag: 'note', elements: [{ tag: 'plain_text', content: '由 aven 的助手整理' }] }, '署名是灰色 note')
    assert.equal(buildRepoGroupText({ task: { commandType: 'status', groupReply: '前端只用了 info.start_the_transaction' } }), '前端只用了 info.start_the_transaction')
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
    assert.match(hooks[0].card.elements[0].content, /^<at id=ou_encone><\/at> 接完了\n待确认的几点在这里：https:\/\/doc\/2/)
    assert.equal(sent[0].chatId, 'ou_aven')
    assert.match(sent[0].markdown, /群里已回：「@Encone 接完了」/)
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
    const ok = await deliverRepoAck({ task: { id: 't', chatId: 'oc_t', repo: 'falive' }, deps: { composeAck: async () => null, webhookFor: () => ({ url: 'u' }), sendWebhookMessage: async (a) => { hooks.push(a); return { ok: true } } } })
    assert.equal(ok.ok, true)
    assert.equal(hooks[0].card.elements[0].content, '收到，我查一下，稍后回复。')
    assert.equal((await deliverRepoAck({ task: { id: 't', chatId: 'oc_t', repo: 'falive' }, deps: { composeAck: async () => null, webhookFor: () => null } })).skipped, true)
    const notes = []
    await deliverRepoIgnoredAfterAck({ task: { id: 't', chatId: 'oc_t', repo: 'falive', summary: '直播详情页还差什么接口', intake: { classification: { reason: '问进度' } } }, deps: { sendMarkdown: async (a) => { notes.push(a); return { ok: true } } } })
    assert.match(notes[0].markdown, /判断不用我处理.*\n理由：问进度\n判错了就回「继续任务 t 做」/)
  })
})

describe('「完成」口径的机械检查', () => {
  afterEach(() => resetRepoProfiles())
  it('总括完成词 + 未完成信号 = 自相矛盾，不发群', async () => {
    assert.ok(findCompletionContradiction('直播详情页我这边的接口都已对完（排行榜、预告）。还差后端在 pre 补：非主播 getRoomInfo 报 500。'))
    assert.equal(findCompletionContradiction('直播详情页还有 5 项没通：\n- getRoomInfo 非主播报 500'), null)
    assert.equal(findCompletionContradiction('预告、礼物、推荐都通了，pre 已实测。'), null)
    register()
    const hooks = []
    const out = await deliverRepoOutcome({
      task: { id: 'q', chatId: 'oc_falive', repo: 'falive', commandType: 'status', groupReply: '接口都已对完，还差举报分类为空。' },
      status: 'done', result: 'x',
      deps: { sendMarkdown: async () => ({ ok: true }), sendWebhookMessage: async (a) => { hooks.push(a); return { ok: true } }, webhookFor: () => ({ url: 'u' }) },
    })
    assert.equal(hooks.length, 0)
    assert.match(out.note, /自相矛盾，我没发/)
  })
  it('结论行「还剩 N 项」+ 条目数 ≠ N（后面又接了一组已做的）= 前后对不上，不发群', async () => {
    const bad = '首页做了 H5 自适应，不过还剩 2 项要确认：\n- 底部导航还在等设计走查\n- 真机效果没验证\n已做的：\n- 三档还原\n- Hero 重排\n- 汉堡菜单'
    assert.deepEqual(findCountMismatch(bad), { lead: '还剩 2 项', expected: 2, actual: 5 })
    assert.equal(findCountMismatch('首页做了 H5 自适应，不过还剩 2 项要确认：\n- 底部导航还在等设计走查\n- 真机效果没验证'), null)
    assert.equal(findCountMismatch('直播详情页还有两项没通：\n- getRoomInfo 报 500\n- 举报分类为空\n能用的：预告、礼物、推荐。'), null)
    assert.equal(findCountMismatch('首页做了 H5 自适应，pre 可以看。'), null)
    assert.equal(findCountMismatch('还剩 2 项要确认：底部导航走查、真机验证。'), null)
    assert.match(findGroupReplyContradiction(bad), /第一行说「还剩 2 项」，下面却列了 5 条/)
    register()
    const hooks = []
    const out = await deliverRepoOutcome({
      task: { id: 'q2', chatId: 'oc_falive', repo: 'falive', commandType: 'status', groupReply: bad },
      status: 'done', result: 'x',
      deps: { sendMarkdown: async () => ({ ok: true }), sendWebhookMessage: async (a) => { hooks.push(a); return { ok: true } }, webhookFor: () => ({ url: 'u' }) },
    })
    assert.equal(hooks.length, 0)
    assert.match(out.note, /前后对不上，我没发/)
  })
})

describe('pre 结论必须实测', () => {
  it('说了 pre 状态但没有 preChecks → 不发群；有实测记录 → 放行；没配 verify 不查', async () => {
    const { findGroupReplyContradiction } = await import('../lib/lark-completion-rule.mjs')
    const verify = { probeCommand: 'node scripts/pre-probe.mjs', env: 'pre' }
    const text = '直播详情页：通了 1 项，没通 1 项\n- ⚠️ 留言板：pre 举报分类为空，不显示'
    assert.match(findGroupReplyContradiction(text, { verify, preChecks: null }), /没在 pre 上实测过/)
    assert.equal(findGroupReplyContradiction(text, { verify, preChecks: [{ endpoint: '/api/report/classifyList', outcome: 'code 0，0 条' }] }), null)
    assert.equal(findGroupReplyContradiction(text), null)
  })
})

describe('阻塞时群里 @ 责任人要材料（整改 #12）', () => {
  afterEach(() => resetRepoProfiles())
  it('blocked → 群里一段 @ + 条目；私聊注明群里已回；疑似任务不发', async () => {
    register()
    assert.deepEqual(extractBlockers('已阻塞，需外部材料 / 权限后才能继续。\n1. 录播详情接口没有。\n2. 待补充：R2 单条详情接口；pre 灌点播数据'), ['R2 单条详情接口', 'pre 灌点播数据'])
    const text = buildRepoBlockedGroupText({ task: { summary: '录播 tab 接详情' }, mentions: [{ owner: 'Ache', openId: 'ou_ache', items: [] }], blockers: ['R2 单条详情接口'] })
    assert.equal(text, '@Ache 「录播 tab 接详情」这边卡住了，需要你们帮忙：\n- R2 单条详情接口')
    const hooks = []
    const sent = []
    const deps = { sendMarkdown: async (a) => { sent.push(a); return { ok: true } }, sendWebhookMessage: async (a) => { hooks.push(a); return { ok: true } }, webhookFor: () => ({ url: 'u' }) }
    const out = await deliverRepoOutcome({ task: { id: 'b1', chatId: 'oc_falive', repo: 'falive', summary: '录播 tab 接详情', owner: 'Ache' }, status: 'blocked', result: '已阻塞，需外部材料 / 权限后才能继续。\n1. 没有详情接口。\n2. 待补充：R2 单条详情接口', deps })
    assert.equal(out.ok, true)
    assert.match(hooks[0].card.elements[0].content, /^<at id=ou_ache><\/at> 「录播 tab 接详情」这边卡住了/)
    assert.match(sent[0].markdown, /⏸ 停下来了.*\n要：R2 单条详情接口\n.*\n群里已回：「@Ache 「录播 tab 接详情」这边卡住了，需要你们帮忙：」/s)
    await deliverRepoOutcome({ task: { id: 'b2', chatId: 'oc_falive', repo: 'falive', summary: 's', suspected: true }, status: 'waiting_confirmation', result: 'x', deps })
    assert.equal(hooks.length, 1, '疑似任务不往群里要材料')
  })
})

describe('待确认清单按主题复用云文档（#13）与兜底话术（#15）', () => {
  afterEach(() => resetRepoProfiles())
  it('同主题第二次走 overwrite 不新建；主题缺省取文件名去日期；守门拦下且群里回过收到 → 发兜底', async () => {
    register()
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'lark-followup-reg-'))
    try {
      assert.equal(followUpTopicKey({ followUpDoc: 'docs/delivery/pending/对接-live后端-3-待确认-2026-10-14.md' }), '对接-live后端-3-待确认')
      const calls = []
      const deps = {
        docRegistryDir: dir,
        sendMarkdown: async () => ({ ok: true }),
        sendWebhookMessage: async (a) => { calls.push(a.logPrefix); return { ok: true } },
        webhookFor: () => ({ url: 'u' }),
        materializeDoc: () => ({ dir: '/tmp', file: 'x.md' }),
        createLarkDoc: async () => { calls.push('create'); return { ok: true, url: 'https://doc/A', documentId: 'docA' } },
        overwriteLarkDoc: async ({ documentId }) => { calls.push(`overwrite:${documentId}`); return { ok: true } },
      }
      const base = { chatId: 'oc_falive', repo: 'falive', topic: 'live-3', branch: 'b', groupReply: '接完了', followUpDoc: 'docs/x-待确认-2026-10-14.md', followUps: [{ owner: 'Ache', items: ['A9'] }] }
      const first = await deliverRepoOutcome({ task: { ...base, id: 'd1' }, status: 'done', result: 'x', deps })
      const second = await deliverRepoOutcome({ task: { ...base, id: 'd2' }, status: 'done', result: 'x', deps })
      assert.equal(first.docUrl, 'https://doc/A')
      assert.equal(second.docUrl, 'https://doc/A', '同主题复用同一份')
      assert.deepEqual(calls.filter((c) => c === 'create' || c.startsWith('overwrite')), ['create', 'overwrite:docA'])
      calls.length = 0
      await deliverRepoOutcome({ task: { id: 'g', chatId: 'oc_falive', repo: 'falive', commandType: 'status', groupReply: '接口都已对完，还差举报分类为空。', ackedInGroup: true }, status: 'done', result: 'x', deps })
      assert.deepEqual(calls, ['repo fallback g'], '守门拦下 + 群里回过收到 → 只发兜底')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('显式 @ 机器人通道', () => {
  afterEach(() => resetRepoProfiles())
  it('按群识别自定义机器人的 open_id；判 ignore 时群里回「收到，记下了」', async () => {
    registerRepoProfiles({ repos: { falive: { root: '/tmp/f', baseRef: 'main', chatIds: ['oc_php'], notifyChatId: 'ou_aven', botMentionOpenIds: { oc_php: 'ou_bot' } } } })
    const { mentionsBot, deliverRepoNoted } = await import('../lib/lark-repo-delivery.mjs')
    const profile = repoProfile('falive')
    assert.equal(mentionsBot({ profile, chatId: 'oc_php', mentions: [{ id: 'ou_bot' }] }), true)
    assert.equal(mentionsBot({ profile, chatId: 'oc_other', mentions: [{ id: 'ou_bot' }] }), false)
    const hooks = []
    await deliverRepoNoted({ task: { id: 'n', chatId: 'oc_php', repo: 'falive', intake: { classification: { summary: 'golang 第一次部署 pre，等部署完' } } }, deps: { webhookFor: () => ({ url: 'u' }), sendWebhookMessage: async (a) => { hooks.push(a); return { ok: true } } } })
    assert.equal(hooks[0].card.elements[0].content, '收到，记下了：golang 第一次部署 pre，等部署完。')
  })
})
