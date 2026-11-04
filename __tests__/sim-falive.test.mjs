/**
 * 回放台子里 falive 校准用的纯函数（scripts/sim/falive-code-pin.mjs、falive-calibration.mjs、calibration-fidelity.mjs、falive-restore.mjs、memory-asof.mjs；design-v2 §8 P0-h / P1）。
 * 一个 it 合并全部段（测试棘轮）。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { attributeMessages, latencyClose, matchTextLines, routeState } from '../scripts/sim/calibration-fidelity.mjs'
import { normalizeRouting, routingLines } from '../scripts/sim/falive-calibration.mjs'
import { ownRootsToKeep, privateOnlyAt, privateOnlyEvidence, sweepForSim, taskStubsFromAudits } from '../scripts/sim/falive-restore.mjs'
import { keepParagraphsAsOf, replayMemoryEvents } from '../scripts/sim/memory-asof.mjs'
import { parseCodeStarts, pickConfigBackup, runningCodeAt } from '../scripts/sim/falive-code-pin.mjs'
import { pickRemapTarget } from '../scripts/sim/falive-data.mjs'
import { runSteps } from './support/steps.mjs'

const LOG = [
  '[lark-gateway] listening on http://127.0.0.1:3006 for PR-01947',
  '[lark-gateway] code=a301f6c04d91 startedAt=2026-10-28T07:57:50.168Z（health.version 会在磁盘代码变更后报 codeStale）',
  '[lark-gateway] code=0089d20f061b startedAt=2026-10-28T10:24:25.027Z（health.version 会在磁盘代码变更后报 codeStale）',
  '[lark-gateway] code=zzz startedAt=坏的（不认）',
  '[lark-gateway] code=9ffb7ff103f2 startedAt=2026-10-28T11:24:34.663Z（health.version 会在磁盘代码变更后报 codeStale）',
].join('\n')

describe('falive 校准：代码 / 配置钉版与路由比对', () => {
  it('按启动指纹取当时的代码、按备份 mtime 取当时的配置、路由行归一后可逐行比', () => runSteps([
    ['启动指纹：只认 12 位十六进制 + 合法时刻，按时间排序', () => {
      const starts = parseCodeStarts(LOG)
      assert.deepEqual(starts.map((s) => s.codeHash), ['a301f6c04d91', '0089d20f061b', '9ffb7ff103f2'])
      assert.deepEqual(parseCodeStarts(''), [])
    }],
    ['某时刻在跑的 = 之前最后一次启动；启动前没有记录回 null；恰好在启动时刻算新的', () => {
      const starts = parseCodeStarts(LOG)
      assert.equal(runningCodeAt(starts, Date.parse('2026-10-28T10:59:20Z')).codeHash, '0089d20f061b')
      assert.equal(runningCodeAt(starts, Date.parse('2026-10-28T10:24:25.027Z')).codeHash, '0089d20f061b')
      assert.equal(runningCodeAt(starts, Date.parse('2026-10-28T07:00:00Z')), null)
    }],
    ['生效配置 = mtime 晚于该时刻的最早备份；都早于它 → null（用现行配置）', () => {
      const backups = [
        { path: 'bak-1031', mtimeMs: Date.parse('2026-10-31T12:19:00Z') },
        { path: 'bak-1027', mtimeMs: Date.parse('2026-10-27T04:02:00Z') },
        { path: 'bak-1028', mtimeMs: Date.parse('2026-10-28T13:09:00Z') },
      ]
      assert.equal(pickConfigBackup(backups, Date.parse('2026-10-28T10:59:20Z')).path, 'bak-1028')
      assert.equal(pickConfigBackup(backups, Date.parse('2026-10-20T00:00:00Z')).path, 'bak-1027')
      assert.equal(pickConfigBackup(backups, Date.parse('2026-11-03T00:00:00Z')), null)
    }],
    ['路由行：case id → C1/C2、群 id → 群名、原话尾巴与工单键不比；只挑提到组内 case 的路由行', () => {
      const ids = ['om_aaa', 'om_bbb']
      assert.equal(normalizeRouting('[lark-gateway] repo start om_aaa -> oc_21a29d687ecfcd6d6776cac669a4c5d3 ok via webhook', ids), 'repo start C1 -> webhook-group ok via webhook')
      assert.equal(normalizeRouting('received task-mention om_bbb，等待意图分类: @Aven.Bot 请帮我核实一下', ids), 'received task-mention C2，等待意图分类…')
      assert.equal(normalizeRouting('台账：om_aaa question 触及 new#ee9885 → 工单键 q:om_aaa', ids), '台账：C1 question 触及 new#ee9885 → 工单键 …')
      const log = ['[lark-gateway] repo ack om_aaa ok via webhook', '[lark-gateway] repo ack om_zzz ok via webhook', '[lark-worker] om_aaa 开始跑', '[lark-gateway] task-mention om_bbb classified=question/high，正式入队'].join('\n')
      assert.deepEqual(routingLines(log, ids), ['repo ack C1 ok via webhook', 'task-mention C2 classified=question/high，正式入队'])
    }],
    ['保真度归属：群里 ack 归还没 ack 的最近一条、实质回复归已 ack 未答的最早一条；私信开始 / 结果卡按（群名）排队；回执归 10 分钟内的控制台私聊', () => {
      const CON = 'oc_con'
      const triggers = [
        { id: 'A', chatId: 'oc_g', atMs: 0, senderName: 'Will', dm: false, text: '测下帖子翻译' },
        { id: 'B', chatId: 'oc_g', atMs: 10_000, senderName: 'Will', dm: false, text: '再看下 AI 识图' },
        { id: 'D', chatId: CON, atMs: 50_000, senderName: 'aven', dm: true, text: '已部署' },
      ]
      const msgs = [
        { id: 'm1', chatId: 'oc_g', atMs: 5_000, text: '@Will 收到，我查一下，稍后回复。' },
        { id: 'm2', chatId: CON, atMs: 6_000, text: '<card>\n🛠 开始做：Will 让测翻译（Falive PHP后端群）\n</card>' },
        { id: 'm3', chatId: 'oc_g', atMs: 12_000, text: '@Will 收到，我查一下，稍后回复。' },
        { id: 'm4', chatId: 'oc_g', atMs: 30_000, text: '@Will 结论：通了 1 项，没通 2 项' },
        { id: 'm5', chatId: CON, atMs: 31_000, text: '<card>\n✅ 测完了（Falive PHP后端群）：…\n</card>' },
        { id: 'm6', chatId: CON, atMs: 51_000, text: '<card>\n这句没对上任务：12 小时内没有我发给你的任务通知。\n</card>' },
        { id: 'm7', chatId: CON, atMs: 52_000, text: '<card>\n[bugpoll] 10-24 本轮结果\n</card>' },
      ]
      const owner = attributeMessages({ triggers: triggers.map((t) => ({ ...t, chatId: t.chatId === 'oc_g' ? 'oc_c2a63ac7c217235e14407ed1bba69d06' : t.chatId })), msgs: msgs.map((m) => ({ ...m, chatId: m.chatId === 'oc_g' ? 'oc_c2a63ac7c217235e14407ed1bba69d06' : m.chatId })), consoleChat: CON })
      assert.deepEqual(Object.fromEntries(owner), { m1: 'A', m2: 'A', m3: 'B', m4: 'A', m5: 'A', m6: 'D' })
    }],
    ['保真度路径 / 终态：outcome 取最后一个；挂待确认、并入、锚不到、整段日志没提到（none）各自成态；私聊续跑行按原话对回 case', () => {
      const id = 'om_x1'
      assert.equal(routeState([`repo start ${id} -> oc ok`, `repo outcome ${id} blocked -> oc ok`, `repo outcome ${id} done -> oc ok`], id).state, 'done')
      assert.equal(routeState([`received task-mention ${id}，等待意图分类`, `task-mention ${id} classified=api_reply/medium forMe=null，疑似任务挂待确认`], id).state, 'waiting_confirmation')
      assert.equal(routeState([`task-mention ${id} classified=api_reply/medium forMe=null，疑似任务挂待确认`], id).decision, 'api_reply')
      assert.equal(routeState([`repo-only 控制台消息 ${id} 锚不到仓库任务：已部署`], id).state, 'unanchored')
      assert.equal(routeState([], id).state, 'none')
      const log = ['[lark-gateway] 负责人私聊（explicit）→ 续跑 om_x9：继续任务 om_x9 做', '[lark-gateway] resumed task om_x9 with supplement（第 1 次续跑）: 继续任务 om_x9 做', '[lark-gateway] 同话题归并：本条 @ 并入挂起任务 om_x9（thread=om_r）', '[lark-gateway] resumed task om_x9 with supplement（第 2 次续跑）: 这有更多点的信息，请整体看看 @Aven.Bot'].join('\n')
      const got = matchTextLines({ logText: log, cases: [{ id: 'dm1', kind: 'principal_dm', text: '继续任务 om_x9 做' }, { id: 'g2', kind: 'at_bot', text: '这有更多点的信息，请整体看看 @Aven.Bot' }] })
      assert.equal(routeState(got.get('dm1'), 'dm1').state, 'resumed')
      assert.equal(routeState(got.get('g2'), 'g2').state, 'merged')
      assert.ok(latencyClose(30, 110) && latencyClose(300, 200) && !latencyClose(30, 400))
    }],
    ['还原：审计补任务库（窗口前 24h 了结 / 72h 挂起，在飞的列出来）；sweep 只去部署盯梢；只私聊按日志行为；组内话题根照供', () => {
      const from = Date.parse('2026-10-28T08:44:52Z')
      const audits = [
        { taskId: 'retest-1047', epoch: 0, audit: { startedAt: '2026-10-28T06:53:47Z', completedAt: '2026-10-28T07:01:24Z', status: 'done', task: { source: 'daily-sweep', chatId: 'oc_con', text: 'pre 已部署' } } },
        { taskId: 'om_old', epoch: 1, audit: { startedAt: '2026-10-26T06:00:00Z', completedAt: '2026-10-26T07:00:00Z', status: 'done', task: {} } },
        { taskId: 'om_park', epoch: 1, audit: { startedAt: '2026-10-26T06:00:00Z', completedAt: '2026-10-26T07:00:00Z', status: 'blocked', task: {} } },
        { taskId: 'om_fly', epoch: 0, audit: { startedAt: '2026-10-28T08:40:00Z', completedAt: '2026-10-28T09:00:00Z', status: 'done', task: {} } },
        { taskId: 'om_future', epoch: 0, audit: { startedAt: '2026-10-28T09:00:00Z', completedAt: '2026-10-28T09:10:00Z', status: 'done', task: {} } },
      ]
      const { stubs, inFlight } = taskStubsFromAudits({ audits, fromMs: from, owner: 'ou_aven' })
      assert.deepEqual(stubs.map((t) => t.id).sort(), ['om_park', 'retest-1047'])
      assert.deepEqual(inFlight, ['om_fly'])
      const retest = stubs.find((t) => t.id === 'retest-1047')
      assert.equal(retest.operator, 'ou_aven')
      assert.deepEqual(retest.receipts.map((r) => r.createdAt), ['2026-10-28T06:53:47Z', '2026-10-28T07:01:24Z'])
      assert.deepEqual(sweepForSim({ preSiteUrl: 'https://x/', onDeploy: ['a'], deployWatchHours: 48, timeoutMinutes: 90, effort: 'high' }), { timeoutMinutes: 90, effort: 'high' })
      const at = { a: { chatId: 'oc_t', atMs: 100 }, b: { chatId: 'oc_t', atMs: 300 }, c: { chatId: 'oc_p', atMs: 200 } }
      const evidence = privateOnlyEvidence({ logLines: ['repo ack om_xa：【专项】融合群 只私聊不发群', 'repo group reply om_xb ok via webhook', 'repo ack om_xc ok via webhook'], chatOfId: (id) => at[id.slice(4)] || null })
      assert.deepEqual(privateOnlyAt({ evidence, atMs: 150, chatIds: ['oc_t', 'oc_p', 'oc_q'], configured: ['oc_q'] }), ['oc_t', 'oc_q'])
      assert.deepEqual(privateOnlyAt({ evidence, atMs: 400, chatIds: ['oc_t', 'oc_p'] }), [])
      const timeline = [
        { id: 'card', ownBot: true, atMs: 10, threadId: 'omt_1' },
        { id: 'reply', ownBot: false, atMs: 20, threadId: 'omt_1', rootId: 'card', parentId: 'card' },
        { id: 'card2', ownBot: true, atMs: 30 },
        { id: 'quote', ownBot: false, atMs: 40, parentId: 'card2' },
        { id: 'oldcard', ownBot: true, atMs: 1, threadId: 'omt_2' },
        { id: 'reply2', ownBot: false, atMs: 50, threadId: 'omt_2', rootId: 'oldcard' },
      ]
      assert.deepEqual(ownRootsToKeep({ timeline, fromMs: 5, untilMs: 100 }), ['card'])
    }],
    ['记忆按会话记录重放：Write / Edit / 整篇 Read 定内容；之后被 Bash 改过就不知道，直到下一次整篇读写；窗口后的事件不算', () => {
      const ev = [
        { atMs: 1, kind: 'write', content: 'a=1\n' },
        { atMs: 2, kind: 'edit', originalFile: 'a=1\n', oldString: 'a=1', newString: 'a=2' },
        { atMs: 5, kind: 'bash' },
        { atMs: 7, kind: 'read', content: 'a=3\n' },
        { atMs: 9, kind: 'edit', originalFile: null, oldString: 'nope', newString: 'x' },
      ]
      assert.deepEqual(replayMemoryEvents(ev, 3), { known: true, content: 'a=2\n' })
      assert.equal(replayMemoryEvents(ev, 6).known, false)
      assert.deepEqual(replayMemoryEvents(ev, 8), { known: true, content: 'a=3\n' })
      // 按段落日期近似（lark-bot 回放的测试号知识，11-04）：段里最晚的日期晚于窗口那天就去掉；没日期的留；年份可写可不写
      const memo = '508（2026-10-15 注册）\n10-16 起用 hichat\n\n19710（10-29 注册）\n\n没日期的说明\n\n生产 484（aven 10-30 给）\n\n10-31 更正：uat 能建号'
      assert.equal(keepParagraphsAsOf(memo, Date.parse('2026-10-21T08:00:00Z')), '508（2026-10-15 注册）\n10-16 起用 hichat\n\n没日期的说明')
      assert.equal(keepParagraphsAsOf(memo, Date.parse('2026-10-30T00:00:00Z')), '508（2026-10-15 注册）\n10-16 起用 hichat\n\n19710（10-29 注册）\n\n没日期的说明\n\n生产 484（aven 10-30 给）', '窗口当天写的算')
      assert.equal(keepParagraphsAsOf('手机 +86 9000887951 / v1.10-3 版本', Date.parse('2026-10-01T00:00:00Z')), '手机 +86 9000887951 / v1.10-3 版本', '号码 / 版本号里的数字不当日期')
      assert.equal(keepParagraphsAsOf(null, 0), '')
      assert.equal(replayMemoryEvents(ev, 10).known, false)
      assert.equal(replayMemoryEvents([], 10).known, false)
    }],
  ]))
})

describe('回放喂事件：回复 falive 卡改接模拟 bot 的哪一句', () => {
  it('认出 case 只接对它 / 它并进的单 / 同话题说的，不退到全群最近一句（b4 ep-1023-9f0fd7 6ed961e2）', () => {
    const caseSet = new Set(['c_avatar', 'c_host', 'c_redeem'])
    const visible = [
      { message_id: 's1', parent_id: 'c_host', thread_id: 't_avatar' },
      { message_id: 's2', parent_id: 'c_redeem', thread_id: null },
      { message_id: 's3', parent_id: null, thread_id: null },
    ]
    const pick = (extra) => pickRemapTarget({ visible, caseSet, ...extra })?.message_id ?? null
    assert.equal(pick({ ownCase: 'c_avatar', caseIds: ['c_host'] }), 's1', '并进的那单')
    assert.equal(pick({ ownCase: 'c_avatar', caseThread: 't_avatar' }), 's1', '同话题')
    assert.equal(pick({ ownCase: 'c_avatar' }), null, '对它没说过话：原样喂，不接兑换那张')
    assert.equal(pick({ ownCase: 'c_redeem' }), 's2')
    assert.equal(pick({ ownCase: null }), 's2', '认不出 case、没 @：接最近一句')
    assert.equal(pick({ ownCase: null, atBot: true }), null, '认不出 case、@ 了 bot：原样喂')
    assert.equal(pick({ isP2p: true }), 's3', '私信接最近一句')
    assert.equal(pickRemapTarget({}), null)
  })
})
