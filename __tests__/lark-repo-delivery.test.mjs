import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import {
  buildGroupCard,
  blockedAskMentions,
  buildRepoBlockedGroupText,
  externalBlockers,
  followUpTopicKey,
  buildRepoGroupText,
  extractBlockers,
  buildRepoNote,
  buildRepoStartNote,
  buildRepoSuspectedNote,
  decideGroupReply,
  deliverHeldGroupReply,
  deliverOverdueObligations,
  deliverRepoAck,
  deliverRepoNoted,
  deliverRepoIgnoredAfterAck,
  deliverRepoOutcome,
  humanizeResult,
  isHumanDeliveryTask,
  addressTo as addressToForAddressee,
  groupAddressee,
} from '../lib/lark-repo-delivery.mjs'
import { findCompletionContradiction, findCountMismatch, findGroupReplyContradiction } from '../lib/lark-completion-rule.mjs'
import { parkedReminderRound, remindParkedTasks } from '../lib/lark-parked-reminder.mjs'
import { addRepoChatIds, registerRepoProfiles, repoProfile, resetRepoProfiles } from '../lib/lark-repo-profile.mjs'
import { OVERDUE_AFTER_MS, getObligation, heldDraftFor, noteAck, resetObligationMemory } from '../lib/lark-reply-obligation.mjs'
import { recordOutbox } from '../lib/lark-outbox.mjs'

// 合并用例的分段：失败时把原用例标题拼到报错最前面，仍能看出是哪一条（异步段要 await）。
const step = (name, fn) => {
  const tag = (error) => {
    if (error instanceof Error) {
      error.message = `[${name}] ${error.message}`
      error.stack = `[${name}] ${error.stack}`
    }
    throw error
  }
  try {
    const out = fn()
    return typeof out?.then === 'function' ? out.catch(tag) : out
  } catch (error) {
    return tag(error)
  }
}

const ownerMap = { Ache: 'ou_ache', Encone: 'ou_encone' }
const register = () => {
  registerRepoProfiles({ repos: { falive: { root: '/tmp/falive-react', baseRef: 'main', chatIds: ['oc_falive'], notifyChatId: 'ou_aven', ownerMap, ownership: { me: 'aven' } } } })
  addRepoChatIds('falive', ['oc_falive'], { oc_falive: 'falive后端go天团' })
}

describe('仓库任务的人话出口', () => {
  afterEach(() => resetRepoProfiles())

  it('人话格式：结构化结果去机器行；私聊消息 done / 停下 / 不用改 / 失败 / 开始 / 疑似各一种写法；群里那句 ✅ / @ + 链接 / 代答只发答案', () => {
    step('结构化结果 → 人话：去掉定型首行、编号、判定 / 系统实测 / 范围契约等机器行', () => {
      const lines = humanizeResult('已完成，待发布。\n1. 按 Ache 的 A1–A7 更新了 upcoming 的 schema 和文档。\n2. 判定：不归本 bot 代理\n修改范围契约：\n· 契约目标（1）：\n  - docs/x.md\n· 排除的兄弟位置（19）：\n  - src/a.ts：x\n  - …另 11 项\n**系统实测**：实测改动 1 处\n**Worker 终检**：通过')
      assert.deepEqual(lines, ['按 Ache 的 A1–A7 更新了 upcoming 的 schema 和文档。'])
    })

    step('群里那句：done 一句 ✅；有待跟进 → @ + 链接 + 每人要点；提问代答只发答案', () => {
      assert.equal(buildRepoGroupText({ task: { groupReply: '接好了，pre 可以复测。' } }), '✅ 接好了，pre 可以复测。')
      assert.equal(buildRepoGroupText({ task: { groupReply: '登录转发：通了 1 项，没通 1 项\n- ⚠️ 接了但还不能用 x\n📝 由 aven 的助手整理' } }), '登录转发：通了 1 项，没通 1 项\n- ⚠️ 接了但还不能用 x', '有逐项状态不加 ✅；正文里的署名剥掉')
      const mentions = [{ owner: 'Ache', openId: 'ou_ache', items: ['A9', 'A10'] }]
      const body = buildRepoGroupText({ task: { groupReply: 'A2 已接完。' }, mentions, docUrl: 'https://doc/1' })
      assert.equal(body, '@Ache A2 已接完。\n待确认的几点在这里：https://doc/1\n- Ache：A9；A10')
      const card = buildGroupCard({ body, mentions })
      assert.equal(card.elements[0].content, '<at id=ou_ache></at> A2 已接完。\n待确认的几点在这里：https://doc/1\n- Ache：A9；A10')
      assert.deepEqual(card.elements[1], { tag: 'note', elements: [{ tag: 'plain_text', content: '由 aven 的助手整理' }] }, '署名是灰色 note')
      assert.equal(buildRepoGroupText({ task: { commandType: 'status', groupReply: '前端只用了 info.start_the_transaction' } }), '前端只用了 info.start_the_transaction')
      assert.equal(buildRepoGroupText({ task: { summary: 'Ache：直播预告重复了' } }), '', 'groupReply 空不回落 summary（对方原话）')
      assert.equal(buildRepoGroupText({ task: { summary: 'Ache：直播预告重复了' }, mentions }), '')
    })

    step('私聊消息：done 带分支 / 文件数 / 群里发没发；停下来带「要什么」；疑似与开始各一行', () => {
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
  })

  it('deliverRepoOutcome 投递：同一人不连 @ 两次 / 归属别人 @ 负责人；有 webhook 发群 + 私聊、没 webhook 只私聊；groupSilent 只私聊；仓库任务不催办', async () => {
    await step('同一个人不连着 @ 两次：行首发消息人 + 待跟进负责人是同一人时只留一个（10-15「@Ache @Ache」）', async () => {
      const mentions = [{ owner: 'Ache', openId: 'ou_ache', items: ['R6 去重'] }]
      const card = buildGroupCard({ body: '<at id=ou_ache></at> @Ache Ache 回复复测：通了 3 项', mentions })
      assert.equal(card.elements[0].content, '<at id=ou_ache></at> Ache 回复复测：通了 3 项')
      assert.equal(buildGroupCard({ body: '@Ache 和 @Encone', mentions: [...mentions, { owner: 'Encone', openId: 'ou_encone', items: [] }] }).elements[0].content, '<at id=ou_ache></at> 和 <at id=ou_encone></at>', '不同人不动')
      register()
      const hooks = []
      const deps = {
        sendMarkdown: async () => ({ ok: true, messageId: 'om_note' }),
        sendWebhookMessage: async (args) => { hooks.push(args); return { ok: true } },
        materializeDoc: () => null,
        createLarkDoc: async () => ({ ok: true, url: 'https://doc/3' }),
        webhookFor: () => ({ url: 'https://hook', secret: 's' }),
      }
      const task = { id: 't-dup', chatId: 'oc_falive', repo: 'falive', operator: 'ou_ache', ackedInGroup: true, addressedToBot: true, summary: 's', groupReply: 'Ache 回复复测：通了 3 项', followUps: [{ owner: 'Ache', items: ['R6 去重'] }] }
      await deliverRepoOutcome({ task, status: 'done', result: 'x', deps })
      assert.equal(hooks.length, 1)
      assert.match(hooks[0].card.elements[0].content, /^<at id=ou_ache><\/at> Ache 回复复测：通了 3 项\n/)
      assert.equal((hooks[0].card.elements[0].content.match(/<at id=ou_ache>/g) || []).length, 1)
      // 归属别人（other_owner）且写了群回复：群里 @ 提问人 + @ 负责人（10-24 Encone @bot 报 henry 的他人主页）
      const ooHooks = []
      const ooDeps = {
        sendMarkdown: async () => ({ ok: true, messageId: 'om_note' }),
        sendWebhookMessage: async (args) => { ooHooks.push(args); return { ok: true } },
        materializeDoc: () => null,
        webhookFor: () => ({ url: 'https://hook', secret: 's' }),
      }
      const ooTask = { id: 't-oo', chatId: 'oc_falive', repo: 'falive', operator: 'ou_encone', addressedToBot: true, summary: 's', noChangeReason: 'other_owner', owner: 'ache', groupReply: '看过了，这条要改的在前端 ache 负责的部分，麻烦 ache 看下，我这边不动。' }
      await deliverRepoOutcome({ task: ooTask, status: 'no_change_needed', result: 'x', deps: ooDeps })
      assert.equal(ooHooks.length, 1)
      assert.match(ooHooks[0].card.elements[0].content, /^<at id=ou_encone><\/at> <at id=ou_ache><\/at> 看过了/)
      ooHooks.length = 0
      await deliverRepoOutcome({ task: { ...ooTask, owner: '不在表里的人' }, status: 'no_change_needed', result: 'x', deps: ooDeps })
      assert.match(ooHooks[0].card.elements[0].content, /^<at id=ou_encone><\/at> (✅ )?看过了/, '人名表对不上就不 @')
    })

    await step('deliverRepoOutcome：有 webhook 发群 + 私聊；没 webhook 只私聊并附要发的话；非仓库任务跳过', async () => {
      resetRepoProfiles()
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

    await step('groupSilent：对接文档归我、只等后端答复 → 群里不发「已存进仓库」，只私聊（10-19 教训 #36）', async () => {
      resetRepoProfiles()
      register()
      const sent = []
      const hooks = []
      const deps = {
        sendMarkdown: async (args) => { sent.push(args); return { ok: true, messageId: 'om_note' } },
        sendWebhookMessage: async (args) => { hooks.push(args); return { ok: true } },
        materializeDoc: () => null,
        createLarkDoc: async () => ({ ok: true, url: 'https://doc/4' }),
        webhookFor: () => ({ url: 'https://hook', secret: 's' }),
      }
      const task = { id: 't-silent', chatId: 'oc_falive', repo: 'falive', summary: 'Encone 请 Arthur 看 go 服务的几项', groupReply: null, payload: { groupSilent: true } }
      const out = await deliverRepoOutcome({ task, status: 'done', result: '已完成，待发布。\n1. 文档已存进仓库。', deps })
      assert.equal(hooks.length, 0, '群里一条都不发')
      assert.equal(out.groupOutcome, null)
      assert.equal(sent.length, 1)
      assert.doesNotMatch(sent[0].markdown, /群里已回|群里没发/)
      const noReply = await deliverRepoOutcome({ task: { ...task, payload: null }, status: 'done', result: 'x', deps })
      assert.equal(hooks.length, 0, '没 groupSilent 时空 groupReply 也不发群，不回落 summary（aven 2026-10-20 review C2）')
      assert.match(noReply.note, /这条没写群回复，群里没发。/)
    })

    await step('仓库任务不催办；默认仓照旧', async () => {
      resetRepoProfiles()
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
})

// 原「直接 @ 负责人先回「收到」」「显式 @ 机器人通道」两组与「收到」时刻一条合并：都是先回执的那一句。
describe('先回执：「收到」与「收到，记下了」', () => {
  afterEach(() => resetRepoProfiles())
  it('@ 到负责人才回「收到」、有 webhook 才发、判 ignore 后私聊说明；按群识别自定义机器人 open_id、ignore 回「记下了」；「收到」点明接的哪条按本地时区', async () => {
    await step('直接 @ 负责人先回「收到」：@ 到负责人才回；有 webhook 才发；判 ignore 后私聊说明', async () => {
      registerRepoProfiles({ repos: { falive: { root: '/tmp/f', baseRef: 'main', chatIds: ['oc_t'], notifyChatId: 'ou_aven', taskMentionOpenIds: ['ou_aven'], ownership: { me: 'aven' } } } })
      const profile = repoProfile('falive')
      const hooks = []
      const ok = await deliverRepoAck({ task: { id: 't', chatId: 'oc_t', repo: 'falive' }, deps: { composeAck: async () => null, webhookFor: () => ({ url: 'u' }), sendWebhookMessage: async (a) => { hooks.push(a); return { ok: true } } } })
      assert.equal(ok.ok, true)
      assert.equal(hooks[0].card.elements[0].content, '收到，我查一下，稍后回复。')
      assert.equal((await deliverRepoAck({ task: { id: 't', chatId: 'oc_t', repo: 'falive' }, deps: { composeAck: async () => null, webhookFor: () => null } })).skipped, true)
      const notes = []
      await deliverRepoIgnoredAfterAck({ task: { id: 't', chatId: 'oc_t', repo: 'falive', summary: '直播详情页还差什么接口', intake: { classification: { reason: '问进度' } } }, deps: { sendMarkdown: async (a) => { notes.push(a); return { ok: true } } } })
      assert.match(notes[0].markdown, /判断不用我处理.*\n理由：问进度\n判错了就回「继续任务 t 做」/)
    })

    await step('显式 @ 机器人通道：按群识别自定义机器人的 open_id；判 ignore 时群里回「收到，记下了」', async () => {
      resetRepoProfiles()
      registerRepoProfiles({ repos: { falive: { root: '/tmp/f', baseRef: 'main', chatIds: ['oc_php'], notifyChatId: 'ou_aven', botMentionOpenIds: { oc_php: 'ou_bot' } } } })
      const { mentionsBot, deliverRepoNoted } = await import('../lib/lark-repo-delivery.mjs')
      const profile = repoProfile('falive')
      assert.equal(mentionsBot({ profile, chatId: 'oc_php', mentions: [{ id: 'ou_bot' }] }), true)
      assert.equal(mentionsBot({ profile, chatId: 'oc_other', mentions: [{ id: 'ou_bot' }] }), false)
      const hooks = []
      await deliverRepoNoted({ task: { id: 'n', chatId: 'oc_php', repo: 'falive', intake: { classification: { summary: 'golang 第一次部署 pre，等部署完' } } }, deps: { webhookFor: () => ({ url: 'u' }), sendWebhookMessage: async (a) => { hooks.push(a); return { ok: true } } } })
      assert.equal(hooks[0].card.elements[0].content, '收到，记下了：golang 第一次部署 pre，等部署完。')
    })

    await step('「收到」点明接的哪条：时刻按本地时区', async () => {
      resetRepoProfiles()
      const prev = process.env.TZ
      process.env.TZ = 'Asia/Shanghai'
      try {
        register()
        const hooks = []
        const deps = {
          sendMarkdown: async () => ({ ok: true, messageId: 'om_note' }),
          sendWebhookMessage: async (a) => { hooks.push(a); return { ok: true } },
          webhookFor: () => ({ url: 'u' }),
          materializeDoc: () => null,
        }
        await deliverRepoAck({ task: { id: 'a1', chatId: 'oc_falive', repo: 'falive', anchor: { at: '2026-10-15T09:48:30Z' } }, deps })
        assert.equal(hooks[0].card.elements[0].content, '收到，我查一下，稍后回复（接着 17:48 那条）。')
      } finally {
        if (prev == null) delete process.env.TZ
        else process.env.TZ = prev
      }
    })
  })
})

// 原「「完成」口径的机械检查」两条与「pre 结论必须实测」一条合并：都是发群前的口径守门。
describe('「完成」口径的机械检查', () => {
  afterEach(() => resetRepoProfiles())
  it('总括完成词 + 未完成信号 = 自相矛盾不发群；「还剩 N 项」+ 条目数 ≠ N 不发群；说了 pre 状态必须有实测记录', async () => {
    await step('总括完成词 + 未完成信号 = 自相矛盾，不发群', async () => {
      assert.ok(findCompletionContradiction('直播详情页我这边的接口都已对完（排行榜、预告）。还差后端在 pre 补：非主播 getRoomInfo 报 500。'))
      assert.equal(findCompletionContradiction('直播详情页还有 5 项没通：\n- getRoomInfo 非主播报 500'), null)
      assert.equal(findCompletionContradiction('预告、礼物、推荐都通了，pre 已实测。'), null)
      // 2026-10-16 真机：uid 508 / 房间 428 被裸 `[45]\d\d` 当成 5xx，R6「都通了」的结论被拦。状态码只认带动词 / 协议词的写法。
      assert.equal(findCompletionContradiction('直播预告重复（R6）：都通了\n- ✅ 通了 front/upcoming：28 条不重复；要登录态的接口用 pre 测试号（uid 508），主播 428 也看了'), null)
      assert.ok(findCompletionContradiction('直播预告都通了，getRoomInfo 非主播回 500'))
      assert.ok(findCompletionContradiction('都通了，录播接口 HTTP 404'))
      // 教训 #56：「不再报错 / 没报 500」是好了的证据；否定只剥报错类，「没有数据」照样算问题。
      assert.equal(findCompletionContradiction('直播列表第 2 页：都通了\n- ✅ 通了 直播列表翻页：第 2 页不再报错，也没有被限流'), null)
      assert.equal(findCompletionContradiction('都通了，getRoomInfo 没报 500，也不卡在登录'), null)
      assert.ok(findCompletionContradiction('都通了，第 2 页不再报错，但第 3 页没有数据'))
      assert.ok(findCompletionContradiction('都通了，第 2 页还是报错'))
      // #58 重跑：分页到底的「为空」是正常现象；没说明理由的「为空」照样算问题。
      assert.equal(findCompletionContradiction('/lives 滚到底续拉：都通了\n- ✅ 通了 front/lives 分页接口：第 1、2 页 code 0 有数据，第 3 页为空说明到底了'), null)
      assert.equal(findCompletionContradiction('都通了，第 3 页为空，是正常的'), null)
      assert.ok(findCompletionContradiction('都通了，举报分类为空'))
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

    await step('结论行「还剩 N 项」+ 条目数 ≠ N（后面又接了一组已做的）= 前后对不上，不发群', async () => {
      resetRepoProfiles()
      const bad = '首页做了 H5 自适应，不过还剩 2 项要确认：\n- 底部导航还在等设计走查\n- 真机效果没验证\n已做的：\n- 三档还原\n- Hero 重排\n- 汉堡菜单'
      assert.deepEqual(findCountMismatch(bad), { lead: '还剩 2 项', expected: 2, actual: 5 })
      assert.equal(findCountMismatch('首页做了 H5 自适应，不过还剩 2 项要确认：\n- 底部导航还在等设计走查\n- 真机效果没验证'), null)
      assert.equal(findCountMismatch('直播详情页还有两项没通：\n- getRoomInfo 报 500\n- 举报分类为空\n能用的：预告、礼物、推荐。'), null)
      assert.equal(findCountMismatch('首页做了 H5 自适应，pre 可以看。'), null)
      assert.equal(findCountMismatch('还剩 2 项要确认：底部导航走查、真机验证。'), null)
      assert.match(findGroupReplyContradiction(bad), /第一行说「还剩 2 项」，下面却列了 5 条/)
      register()
      const hooks2 = []
      const out2 = await deliverRepoOutcome({
        task: { id: 'q2', chatId: 'oc_falive', repo: 'falive', commandType: 'status', groupReply: bad },
        status: 'done', result: 'x',
        deps: { sendMarkdown: async () => ({ ok: true }), sendWebhookMessage: async (a) => { hooks2.push(a); return { ok: true } }, webhookFor: () => ({ url: 'u' }) },
      })
      assert.equal(hooks2.length, 0)
      assert.match(out2.note, /前后对不上，我没发/)
    })

    step('pre 结论必须实测：说了 pre 状态但没有 preChecks → 不发群；有实测记录 → 放行；没配 verify 不查', () => {
      const verify = { probeCommand: 'node scripts/pre-probe.mjs', env: 'pre' }
      const text = '直播详情页：通了 1 项，没通 1 项\n- ⚠️ 留言板：pre 举报分类为空，不显示'
      assert.match(findGroupReplyContradiction(text, { verify, preChecks: null }), /没在 pre 上实测过/)
      assert.equal(findGroupReplyContradiction(text, { verify, preChecks: [{ endpoint: '/api/report/classifyList', outcome: 'code 0，0 条' }] }), null)
      assert.equal(findGroupReplyContradiction(text), null)
    })
  })
})

describe('细节进文档、引用只概括（aven 2026-10-22）', () => {
  afterEach(() => resetRepoProfiles())
  it('结果带 detailDoc：建成文档、群里附「详细见」；卡住时引用任务只取第一个分句，不按字数截', async () => {
    register()
    const hooks = []
    const docs = []
    const deps = { sendMarkdown: async () => ({ ok: true }), sendWebhookMessage: async (a) => { hooks.push(a); return { ok: true } }, webhookFor: () => ({ url: 'u' }), createLarkDoc: async (a) => { docs.push(a); return { ok: true, url: 'https://doc/curl' } } }
    const report = { subject: null, answer: '复现 curl 在文档里', items: [] }
    await deliverRepoOutcome({ task: { id: 'd1', chatId: 'oc_falive', repo: 'falive', summary: 'Arthur 要复现 curl', operator: 'ou_ache', addressedToBot: true, contract: { deliverable: 'answer' }, report, detailDoc: 'curl -s https://x' }, status: 'done', result: '已完成。', deps })
    assert.match(hooks[0].card.elements[0].content, /复现 curl 在文档里\n详细见：https:\/\/doc\/curl/)
    assert.equal(docs.length, 1)
    hooks.length = 0
    await deliverRepoOutcome({ task: { id: 'd2', chatId: 'oc_falive', repo: 'falive', owner: 'Ache', summary: 'Encone（portal 后端）发来 Bug-4944 直播间介绍 intro 的接口变更说明：createRoom / updateLive 新增可选参数' }, status: 'blocked', result: '已阻塞，需外部材料 / 权限后才能继续。\n1. x\n2. 待补充：主播测试号', deps })
    assert.match(hooks[0].card.elements[0].content, /「Encone（portal 后端）发来 Bug-4944 直播间介绍 intro 的接口变更说明」这边卡住了/)
  })
})

// 原「工具故障不进群（10-22 Bug-4944）」一条并入本组：都是阻塞时向谁要什么材料。
describe('阻塞时群里 @ 责任人要材料（整改 #12）', () => {
  afterEach(() => resetRepoProfiles())
  it('blocked → 群里 @ + 条目、私聊注明已回、疑似不发；没定负责人 @ 点名的外部同事或发起人（Bug-4927）；我方工具故障不算要的材料（Bug-4944）', async () => {
    step('工具故障不进群（10-22 Bug-4944）：读不到 Lark 文档 / lark-cli / 授权这类我方故障不算向对方要的材料', () => {
      assert.deepEqual(externalBlockers(['Lark 文档读取失败：https://x.larksuite.com/docx/Cfb → }', 'lark-cli 没授权', 'R2 详情接口']), ['R2 详情接口'])
    })

    await step('blocked → 群里一段 @ + 条目；私聊注明群里已回；疑似任务不发', async () => {
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

    await step('没定负责人：@ 待补充里点名的外部同事；没点名就 @ 发起人（10-22 Bug-4927 一个都没 @）', async () => {
      resetRepoProfiles()
      register()
      const hooks = []
      const deps = { sendMarkdown: async () => ({ ok: true }), sendWebhookMessage: async (a) => { hooks.push(a); return { ok: true } }, webhookFor: () => ({ url: 'u' }) }
      const result = '已阻塞，需外部材料 / 权限后才能继续。\n1. 缺账号。\n2. 待补充：缺一个嗨聊老账号；要 Ache、Encone 或测试 HTStone.z 给一个能在 pre 用的'
      await deliverRepoOutcome({ task: { id: 'b3', chatId: 'oc_falive', repo: 'falive', summary: '复测 Bug-4927', operator: 'ou_ache' }, status: 'blocked', result, deps })
      assert.match(hooks[0].card.elements[0].content, /^<at id=ou_ache><\/at> <at id=ou_encone><\/at> 「复测 Bug-4927」这边卡住了/)
      const profile = repoProfile('falive')
      assert.deepEqual(blockedAskMentions({ task: { operator: 'ou_william' }, profile, blockers: ['给一个老账号'] }), [{ owner: null, openId: 'ou_william', items: ['给一个老账号'] }])
      assert.equal(buildRepoBlockedGroupText({ task: { summary: 's' }, mentions: [{ owner: null, openId: 'ou_william' }], blockers: ['x'] }), '<at id=ou_william></at> 「s」这边卡住了，需要你们帮忙：\n- x')
      assert.deepEqual(blockedAskMentions({ task: {}, profile, blockers: ['Achelous 接口'] }), [], '名字要整词匹配')
    })
  })
})

describe('待确认清单按主题复用云文档（#13）与兜底话术（#15）', () => {
  afterEach(() => resetRepoProfiles())
  it('同主题第二次走 overwrite 不新建；主题缺省取文件名去日期；守门拦下 → 群里什么都不补（10-21 P5）；登记表 node --test 下没注入目录不落盘、注入 / 环境变量优先', async () => {
    await step('同主题第二次走 overwrite 不新建；主题缺省取文件名去日期；守门拦下 → 群里什么都不补（10-21 P5）', async () => {
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
        assert.deepEqual(calls, [], '守门拦下：群里不补兜底话术，草稿私聊负责人')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    await step('待确认清单登记表：node --test 下没注入目录不落盘（不写真实 runtime）；注入 / 环境变量优先', async () => {
      const { resolveDocRegistryDir } = await import('../lib/lark-repo-delivery.mjs')
      assert.equal(resolveDocRegistryDir({}), null)
      assert.equal(resolveDocRegistryDir({ docRegistryDir: '/tmp/a' }), '/tmp/a')
      const prev = process.env.LARK_FOLLOWUP_DOCS_DIR
      process.env.LARK_FOLLOWUP_DOCS_DIR = '/tmp/b'
      try {
        assert.equal(resolveDocRegistryDir({}), '/tmp/b')
      } finally {
        if (prev == null) delete process.env.LARK_FOLLOWUP_DOCS_DIR
        else process.env.LARK_FOLLOWUP_DOCS_DIR = prev
      }
    })
  })
})

describe('只私聊的群 privateOnlyChats（aven 10-20：融合群全是话题，发一条开一个）', () => {
  afterEach(() => resetRepoProfiles())
  const register = () => registerRepoProfiles({ repos: { falive: { root: '/tmp/f', baseRef: 'main', chatIds: ['oc_php', 'oc_fusion'], chatLabels: { oc_fusion: '融合群' }, privateOnlyChats: ['融合群'], notifyChatId: 'ou_aven', ownerMap: {} } } })
  const deps = (hooks, sent) => ({
    webhookFor: () => ({ url: 'u' }),
    sendWebhookMessage: async (a) => { hooks.push(a); return { ok: true } },
    sendMarkdown: async (a) => { sent.push(a); return { ok: true, messageId: 'om_p' } },
    materializeDoc: () => null,
  })

  it('done 群里不发、私聊带上原本要回群的话；noted 原话私发负责人、ack 只拦不私发、其它群照常发', async () => {
    await step('done：群里不发，私聊结果带上原本要回群的话', async () => {
      register()
      const hooks = []
      const sent = []
      const out = await deliverRepoOutcome({ task: { id: 'f1', chatId: 'oc_fusion', repo: 'falive', summary: 's', groupReply: '可以提测了' }, status: 'done', result: 'x', deps: deps(hooks, sent) })
      assert.equal(hooks.length, 0)
      assert.equal(out.groupOutcome.ok, false)
      assert.match(sent[0].markdown, /群里没发（融合群 只私聊不发群），要回可以转发这段：\n.*可以提测了/)
    })

    await step('noted：原话私发负责人；ack 只拦不私发；其它群照常发', async () => {
      resetRepoProfiles()
      register()
      const hooks = []
      const sent = []
      const noted = await deliverRepoNoted({ task: { id: 'f2', chatId: 'oc_fusion', repo: 'falive', intake: { classification: { summary: '等部署' } } }, deps: deps(hooks, sent) })
      assert.equal(noted.ok, false)
      assert.ok(noted.gated)
      assert.equal(sent[0].chatId, 'ou_aven')
      assert.match(sent[0].markdown, /融合群 只私聊不发群，原本要回群：\n收到，记下了：等部署。/)
      const acked = await deliverRepoAck({ task: { id: 'f3', chatId: 'oc_fusion', repo: 'falive', operator: 'ou_x' }, deps: deps(hooks, sent) })
      assert.ok(acked.gated)
      assert.equal(sent.length, 1)
      assert.equal(hooks.length, 0)
      await deliverRepoNoted({ task: { id: 'f4', chatId: 'oc_php', repo: 'falive', intake: { classification: { summary: '另一个群 f4' } } }, deps: deps(hooks, sent) })
      assert.equal(hooks.length, 1)
    })
  })
})

describe('出口闸拦下 = 没发（第 0 批）', () => {
  it('同内容第二次发返回 ok:false + gated，调用方不得当已发', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { sendGroupCard } = await import('../lib/lark-repo-delivery.mjs')
    const dir = mkdtempSync(join(tmpdir(), 'lark-outbox-gate-'))
    const prev = process.env.LARK_OUTBOX_DIR
    process.env.LARK_OUTBOX_DIR = dir
    try {
      const sent = []
      const sendHook = async () => { sent.push(1); return { ok: true, messageId: 'om_1' } }
      const args = { webhook: { url: 'https://x' }, chatId: 'oc_1', phase: 'done', body: '复测通过', logPrefix: 't', sendHook }
      const first = await sendGroupCard(args)
      assert.equal(first.ok, true)
      const second = await sendGroupCard(args)
      assert.equal(second.ok, false)
      assert.match(second.gated, /同内容/)
      assert.match(second.reason, /出口闸拦下/)
      assert.equal(sent.length, 1)
    } finally {
      if (prev == null) delete process.env.LARK_OUTBOX_DIR
      else process.env.LARK_OUTBOX_DIR = prev
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('回群对着谁说（教训 #41）', () => {
  const profile = { ownership: { meOpenIds: ['ou_aven'] } }
  const relay = { operator: 'ou_aven', fromPrincipal: true, intake: { classification: { decision: 'api_reply' } }, threadSpeakers: ['ou_aven', 'ou_ache', 'ou_aven'] }

  it('负责人转交对接答复 @ 话题里最后发言的非负责人；不是转交 / 不是对接答复 / 话题里没别人时照旧 @ 发消息的人', () => {
    step('负责人转交对接答复：@ 话题里最后发言的非负责人（答复人），不是负责人自己', () => {
      assert.equal(groupAddressee({ task: relay, profile }), 'ou_ache')
      assert.match(addressToForAddressee({ task: relay, body: 'x', openId: groupAddressee({ task: relay, profile }) }), /^<at id=ou_ache><\/at> x/)
    })
    step('不是负责人转交、不是对接答复、话题里没有别人时，照旧 @ 发消息的人', () => {
      assert.equal(groupAddressee({ task: { ...relay, fromPrincipal: false, operator: 'ou_ache' }, profile }), 'ou_ache')
      assert.equal(groupAddressee({ task: { ...relay, intake: { classification: { decision: 'question' } } }, profile }), 'ou_aven')
      assert.equal(groupAddressee({ task: { ...relay, threadSpeakers: ['ou_aven'] }, profile }), 'ou_aven')
      assert.equal(groupAddressee({ task: { ...relay, threadSpeakers: undefined }, profile }), 'ou_aven')
    })
  })
})

describe('群文本不回落原话 / 回复义务 / 没 notifyChatId 不发（aven 2026-10-20 review，10-21 P5）', () => {
  afterEach(() => resetRepoProfiles())
  const mkDeps = (hooks, sent, extra = {}) => ({
    sendMarkdown: async (a) => { sent.push(a); return { ok: true, messageId: 'om_note' } },
    sendWebhookMessage: async (a) => { hooks.push(a); return { ok: true } },
    webhookFor: () => ({ url: 'u' }),
    materializeDoc: () => null,
    ...extra,
  })
  const withOutbox = async (fn) => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'lark-outbox-fallback-'))
    const prev = process.env.LARK_OUTBOX_DIR
    process.env.LARK_OUTBOX_DIR = dir
    try { return await fn() } finally {
      if (prev == null) delete process.env.LARK_OUTBOX_DIR
      else process.env.LARK_OUTBOX_DIR = prev
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('C1 私聊指示任务阻塞时群里引被锚的群消息、done 没写群回复不发群；没配 notifyChatId 结果私聊不发、不回落外部群', async () => {
    await step('C1：私聊指示任务阻塞要材料，群里引的是被锚的群消息，不是 aven 私聊原话', async () => {
      register()
      const hooks = []
      const sent = []
      const task = { id: 'om_p2p', chatId: 'oc_falive', repo: 'falive', operator: 'ou_ache', owner: 'Ache', fromPrincipal: true, summary: 'aven 私聊指示：这个先别理 Ache，内部还没定', text: '【aven 私聊指示】这个先别理 Ache，内部还没定', privateOrigin: { anchorHead: '@Aven.Bot 录播详情接一下' } }
      await deliverRepoOutcome({ task, status: 'blocked', result: '已阻塞，需外部材料 / 权限后才能继续。\n1. 没有详情接口。\n2. 待补充：R2 单条详情接口', deps: mkDeps(hooks, sent) })
      assert.equal(hooks.length, 1)
      const content = hooks[0].card.elements[0].content
      assert.match(content, /「@Aven\.Bot 录播详情接一下」这边卡住了/)
      assert.doesNotMatch(content, /私聊|先别理|内部还没定/)
      assert.equal(buildRepoBlockedGroupText({ task, blockers: ['x'] }).includes('私聊'), false)
      // done 没写群回复：群里什么都不发（原来回落 summary = 私聊原话进群）
      hooks.length = 0
      const done = await deliverRepoOutcome({ task: { ...task, groupReply: null }, status: 'done', result: 'x', deps: mkDeps(hooks, sent) })
      assert.equal(hooks.length, 0)
      assert.match(done.note, /这条没写群回复，群里没发。/)
    })

    await step('没配 notifyChatId：结果私聊不发，不回落外部群', async () => {
      resetRepoProfiles()
      registerRepoProfiles({ repos: { falive: { root: '/tmp/f', baseRef: 'main', chatIds: ['oc_falive'], ownerMap: {} } } })
      const hooks = []
      const sent = []
      const out = await deliverRepoOutcome({ task: { id: 'n1', chatId: 'oc_falive', repo: 'falive', groupReply: '好了' }, status: 'done', result: 'x', deps: mkDeps(hooks, sent) })
      assert.equal(sent.length, 0)
      assert.equal(out.ok, false)
      assert.equal(out.to, null)
      assert.equal(hooks.length, 1, '群里那句照发')
    })
  })

  it('扣下草稿（各自独立发件簿）：C2 / C6 → 10-21 P5（10-23 #79 改）没写回复转草稿私聊、拦下 / 失败不补兜底；#56 → 10-21 P5 草稿存回复义务上、放行读草稿、有更新结论不放旧草稿', async () => {
    await step('C2 / C6 → 10-21 P5（10-23 #79 改）：回过收到后没写回复 → 结论人话化作草稿私聊（就这样回发群）；被闸拦下 / 发送失败 / 失败终态不在群里补兜底', () => withOutbox(async () => {
      register()
      const hooks = []
      const sent = []
      const deps = mkDeps(hooks, sent)
      const base = { chatId: 'oc_falive', repo: 'falive', operator: 'ou_ache', ackedInGroup: true, addressedToBot: true, topic: 't-1', groupReply: '修好了，pre 可以复测' }
      const noReply = await deliverRepoOutcome({ task: { ...base, id: 'c2', summary: 'Ache：直播预告重复了', groupReply: '' }, status: 'done', result: '已完成，待发布。\n1. 去重修好了。', deps })
      assert.equal(hooks.length, 0, '没写群回复：群里不直接贴结论原文（不发「✅ + 对方原话」，也不发兜底）')
      assert.match(noReply.note, /群里没发（执行器没写群回复，补写也没成）。没问题就回「就这样回」，我按原文发群：\n去重修好了。/)
      assert.doesNotMatch(noReply.note, /不会再补话|这条没写群回复/)
      assert.equal(getObligation({ id: 'c2', chatId: 'oc_falive' }).state, 'held')
      await deliverRepoOutcome({ task: { ...base, id: 'g1' }, status: 'done', result: 'x', deps })
      assert.equal(hooks.length, 1, '正常发 done')
      assert.equal(getObligation({ id: 'g1', chatId: 'oc_falive' }).state, 'answered')
      const gated = await deliverRepoOutcome({ task: { ...base, id: 'g2' }, status: 'done', result: 'x', deps })
      assert.equal(gated.groupOutcome.gated, true, '同内容被闸拦下')
      assert.equal(hooks.length, 1, '拦下不补兜底')
      await deliverRepoOutcome({ task: { ...base, id: 'g3', operator: 'ou_william', topic: 't-3', groupReply: null }, status: 'failed', result: '处理失败。', deps })
      assert.equal(hooks.length, 1, '失败终态不补兜底')
    }))

    resetRepoProfiles()
    await step('#56 → 10-21 P5：扣下的草稿存在回复义务上，私聊指示任务（同一条群消息）照发；放行读义务上的草稿，有更新的结论后不放旧草稿', () => withOutbox(async () => {
      register()
      const hooks = []
      const sent = []
      const deps = mkDeps(hooks, sent)
      const base = { chatId: 'oc_falive', repo: 'falive', operator: 'ou_encone', ackedInGroup: true, addressedToBot: true }
      const ok = await deliverRepoOutcome({ task: { ...base, id: 'a1', topic: 't-a1', groupReply: '直播列表第 2 页：都通了\n- ✅ 通了 直播列表翻页：第 2 页不再报错，也没有被限流' }, status: 'done', result: 'x', deps })
      assert.equal(ok.groupOutcome.ok, true)
      const held = await deliverRepoOutcome({ task: { ...base, id: 'h1', topic: 't-h1', groupReply: '都通了，第 3 页没有数据' }, status: 'done', result: 'x', deps })
      assert.equal(held.groupOutcome.held, true)
      assert.match(held.note, /回「就这样回」，我按原文发群/)
      assert.equal(hooks.length, 1, '扣下：群里不补话')
      assert.equal(heldDraftFor({ id: 'h1', chatId: 'oc_falive' }).text, '✅ 都通了，第 3 页没有数据')
      const released = await deliverHeldGroupReply({ task: { ...base, id: 'h1', topic: 't-h1b' }, deps })
      assert.equal(released.ok, true)
      assert.equal(hooks.at(-1).card.elements[0].content, '<at id=ou_encone></at> ✅ 都通了，第 3 页没有数据')
      assert.equal(heldDraftFor({ id: 'h1', chatId: 'oc_falive' }), null, '放完就清')
      // 再扣一份，然后私聊指示任务（锚到 h1）发出了更新的结论 → 旧草稿不再放
      await deliverRepoOutcome({ task: { ...base, id: 'h1', topic: 't-h1c', groupReply: '都通了，第 4 页没有数据' }, status: 'done', result: 'x', deps })
      const instruct = { ...base, id: 'p1', topic: 't-p1', fromPrincipal: true, privateOrigin: { anchorId: 'h1', anchorHead: 'x' } }
      const nc = await deliverRepoOutcome({ task: { ...instruct, groupReply: 'front/lives 复测：通了 1 项\n- ✅ 通了 第 2 页：code 0' }, status: 'no_change_needed', result: 'x', deps })
      assert.equal(nc.groupOutcome.ok, true)
      assert.equal(heldDraftFor({ id: 'h1', chatId: 'oc_falive' }), null, '有更新的结论后不放旧草稿')
      assert.equal((await deliverHeldGroupReply({ task: { ...base, id: 'h2' }, deps })).skipped, true, '没有扣下的不发')
    }))
  })

  it('答应了却 4 小时没结论 → 私聊负责人一次，不发群', async () => withOutbox(async () => {
    register()
    const hooks = []
    const t0 = Date.parse('2026-10-21T08:00:00Z')
    // 回复时间用固定时刻 t0（不能先用真实时钟发「收到」：义务只认第一次回复时间，测试会随当天几点跑而变红——10-21 14:01 排空重启前真机踩到）
    noteAck({ task: { id: 'ov1', chatId: 'oc_falive' }, text: '收到，我去复测签到，结果回群里', now: t0 })
    const dms = []
    const sendPrivate = async (a) => { dms.push(a); return { ok: true } }
    assert.equal(await deliverOverdueObligations({ profiles: [repoProfile('falive')], now: t0 + 60 * 60_000, sendPrivate }), 0, '没到期')
    assert.equal(await deliverOverdueObligations({ profiles: [repoProfile('falive')], now: t0 + OVERDUE_AFTER_MS + 1, sendPrivate }), 1)
    assert.match(dms[0].markdown, /答应过「收到，我去复测签到，结果回群里」.*继续任务 ov1/)
    assert.equal(await deliverOverdueObligations({ profiles: [repoProfile('falive')], now: t0 + OVERDUE_AFTER_MS * 2, sendPrivate }), 0, '只提醒一次')
    assert.equal(hooks.length, 0, '提醒只私聊，不发群')
    // 发件簿里已有结论、出口漏记 noteAnswer（#74 前「记下了」，10-23 Encone 那条误报）→ 补记 answered，不提醒
    noteAck({ task: { id: 'ov2', chatId: 'oc_falive' }, text: '收到，我查一下，稍后回复。', now: t0 })
    recordOutbox({ chatId: 'oc_falive', taskId: 'ov2', phase: 'noted', text: '收到：508 已设为主播。', now: t0 + 90_000 })
    assert.equal(await deliverOverdueObligations({ profiles: [repoProfile('falive')], now: t0 + OVERDUE_AFTER_MS * 3, sendPrivate }), 0, '群里已有结论不提醒')
    assert.equal(getObligation({ id: 'ov2', chatId: 'oc_falive' }).state, 'answered')
    // 负责人已手动结单（externalResolution）→ 不提醒
    noteAck({ task: { id: 'ov3', chatId: 'oc_falive' }, text: '收到', now: t0 })
    const getTask = (id) => (id === 'ov3' ? { id, status: 'superseded', externalResolution: { closureReason: 'completed_elsewhere' } } : null)
    assert.equal(await deliverOverdueObligations({ profiles: [repoProfile('falive')], now: t0 + OVERDUE_AFTER_MS * 3, sendPrivate, getTask }), 0, '手动结单不提醒')
  }))
})

describe('回答发不发群（10-21 P3：闸只管提交）', () => {
  const t = (extra) => ({ id: 'x', groupReply: '结论', ...extra })
  it('done / 不用改 → 发，阻塞没写回复 / groupSilent → 不发；复测 / 回答类只是没提交 → 照发，改代码类没提交 / 任务失败 → 扣下给负责人', () => {
    step('done / 不用改 → 发；阻塞没写回复 → 不发；groupSilent → 不发', () => {
      assert.equal(decideGroupReply({ task: t(), status: 'done' }).mode, 'post')
      assert.equal(decideGroupReply({ task: t(), status: 'no_change_needed' }).mode, 'post')
      assert.equal(decideGroupReply({ task: t({ groupReply: null }), status: 'blocked' }).mode, 'none')
      assert.equal(decideGroupReply({ task: t({ payload: { groupSilent: true } }), status: 'done' }).mode, 'none')
    })
    step('复测 / 回答类只是改动没提交 → 回答照发；改代码类没提交 / 任务失败 → 扣下给负责人', () => {
      const change = { committed: false, gate: 'done.trust', reason: '只改文档' }
      assert.equal(decideGroupReply({ task: t({ contract: { deliverable: 'verification' }, change }), status: 'failed' }).mode, 'post')
      const held = decideGroupReply({ task: t({ contract: { deliverable: 'change' }, change }), status: 'failed' })
      assert.equal(held.mode, 'hold')
      assert.match(held.reason, /改动没提交（done\.trust：只改文档）/)
      assert.match(decideGroupReply({ task: t({ contract: { deliverable: 'verification' } }), status: 'failed' }).reason, /任务没做成（failed）/, '执行器自己报失败：不是只差提交，扣下')
    })
  })
})
