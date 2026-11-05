/**
 * 上线后实战迭代批 1（aven 11-05，docs/plan/plan-iteration-2026-11-05.md）：线上指标（lib/lark-live-scorecard）、纠错入口与决策日志
 * （lib/lark-feedback-log + 私信主通道）、日报指标节、分类器自答 / 追问的时延记账、审计花费（lib/lark-audit-cost）。
 * 一个 it 合并全部段（测试棘轮）；表驱动，每行翻转一处条件给变异扫描用。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { eachCase, runSteps } from './support/steps.mjs'

import { auditCalls, parseCostLog, sessionIncrements } from '../lib/lark-audit-cost.mjs'
import { appendCorrection, appendDecision, adoptionOf, correctionRecordOf, decisionRecordOf, parseCorrection, readCorrections, readDecisions, taskSnapshot } from '../lib/lark-feedback-log.mjs'
import { LIVE_LINES, buildScorecard, collectLiveFacts, formatDuration, renderScorecard, summarizeAccuracy, summarizeCost, summarizeFeedback, summarizeSpeed } from '../lib/lark-live-scorecard.mjs'
import { CORRECTION_DIRECTIVE_HEAD, correctionAckText, correctionDirectiveText, maybeHandlePrincipalChannel, resolveCorrectionTask } from '../lib/lark-principal-channel.mjs'
import { selfReplyLatencyRecord } from '../lib/lark-routes-intake.mjs'
import { renderDailyReport, scorecardSection } from '../lib/lark-daily-report.mjs'

const root = mkdtempSync(join(tmpdir(), 'lark-live-feedback-'))
after(() => rmSync(root, { recursive: true, force: true }))

const T0 = Date.parse('2026-11-05T02:00:00.000Z')
const iso = (ms) => new Date(ms).toISOString()
const RANGE = { fromMs: T0, toMs: T0 + 86_400_000 }

describe('实战迭代批 1：线上指标 / 纠错 / 决策日志', () => {
  it('feedback-log / live-scorecard / principal-channel 纠错 / daily-report 指标节 / 自答时延 / audit-cost', () => runSteps([
    ['parseCorrection：只认「纠错」开头，或「这条不对」+ 链接 / 消息 id；单说「不对，应该是…」是补料', () => eachCase([
      { name: '纠错：前缀', text: '纠错：上午那条答错了，pre 没部署新站', want: { body: '上午那条答错了，pre 没部署新站', links: [], messageIds: [] } },
      { name: '【纠错】括号', text: '【纠错】 om_abc12 测错环境了', want: { body: 'om_abc12 测错环境了', links: [], messageIds: ['om_abc12'] } },
      { name: '纠错 空格', text: '纠错 应该测 hichat', want: { body: '应该测 hichat', links: [], messageIds: [] } },
      { name: '只写纠错没内容', text: '纠错：', want: null },
      { name: '这条不对 + 链接', text: '这条不对：https://x.larksuite.com/msg?id=1，应该先问环境', want: { body: '这条不对：https://x.larksuite.com/msg?id=1，应该先问环境', links: ['https://x.larksuite.com/msg?id=1'], messageIds: [] } },
      { name: '那条答错了 + 消息 id（去重）', text: '那条答错了 om_q1 om_q1', want: { body: '那条答错了 om_q1 om_q1', links: [], messageIds: ['om_q1'] } },
      { name: '这条不对 没链接 = 对上一条通知的指示', text: '这条不对，再看看', want: null },
      { name: '不对，应该是 508 账号（补料）', text: '不对，应该是 508 账号', want: null },
      { name: '中间出现纠错不算', text: '帮我纠错一下这个文案', want: null },
      { name: '空', text: '', want: null },
      { name: '@ 名字被去掉', text: '@bot 纠错：重复回了', want: { body: '重复回了', links: [], messageIds: [] } },
    ], ({ text, want }) => assert.deepEqual(parseCorrection(text), want))],

    ['纠错记录：带任务快照（截断长文本），没对上任务也照记', () => {
      const msg = { messageId: 'om_c1', senderOpenId: 'ou_aven', text: '纠错：答错了' }
      const task = { id: 'om_t', chatId: 'oc_g', chatName: 'G', status: 'done', contract: { deliverable: 'answer' }, intake: { classification: { decision: 'answer' } }, operator: 'ou_qa', createdAt: iso(T0), text: 'x'.repeat(1600), outcome: { text: '结论' } }
      const record = correctionRecordOf({ msg, parsed: parseCorrection(msg.text), task, via: 'message', now: T0 })
      assert.deepEqual({ ...record, task: { ...record.task, text: record.task.text.length } }, {
        at: iso(T0), id: 'om_c1', from: 'ou_aven', text: '纠错：答错了', body: '答错了', links: [], messageIds: [], via: 'message', status: 'open',
        task: { id: 'om_t', chatId: 'oc_g', chatName: 'G', status: 'done', deliverable: 'answer', decision: 'answer', operator: 'ou_qa', createdAt: iso(T0), text: 1501, result: '结论' },
      })
      assert.equal(taskSnapshot({ id: 'om_r', result: 'r' }).result, 'r', '没 outcome 退到 result')
      assert.equal(taskSnapshot({ id: 'om_e', text: 'y'.repeat(1500) }).text, 'y'.repeat(1500), '正好 1500 字不截')
      assert.equal(correctionRecordOf({ msg, parsed: parseCorrection(msg.text), now: T0 }).task, null)
    }],

    ['两本账：jsonl 追加 / 按时间读；node --test 下没给路径不落盘；写失败返回 false 不抛', () => {
      const path = join(root, 'corrections.jsonl')
      assert.equal(appendCorrection({ at: iso(T0), id: 'a', status: 'open' }, { path }), true)
      assert.equal(appendCorrection({ at: iso(T0 + 1000), id: 'b', status: 'open' }, { path }), true)
      writeFileSync(path, `${readFileSync(path, 'utf8')}坏行\n`)
      assert.deepEqual(readCorrections({ path }).map((r) => r.id), ['a', 'b'], '坏行跳过')
      assert.deepEqual(readCorrections({ path, sinceMs: T0 + 1 }).map((r) => r.id), ['b'])
      assert.deepEqual(readCorrections({ path: join(root, 'none.jsonl') }), [])
      assert.equal(appendDecision({ at: iso(T0), kind: 'release' }), false, '测试下没路径：不碰真实运行态')
      assert.deepEqual(readDecisions(), [])
      const logs = []
      assert.equal(appendDecision({ kind: 'x' }, { path: join(root, 'no-such-dir', 'd.jsonl'), log: (line) => logs.push(line) }), false)
      assert.match(logs[0], /^\[lark-feedback\] 记账写失败（忽略）/)
      const dpath = join(root, 'decisions.jsonl')
      appendDecision(decisionRecordOf({ kind: 'revise', msg: { messageId: 'om_m', text: '改一下' }, task: { id: 'om_t', chatId: 'oc_g', summary: 'S', status: 'done' }, draft: '草稿', now: T0 }), { path: dpath })
      assert.deepEqual(readDecisions({ path: dpath }), [{ at: iso(T0), kind: 'revise', messageId: 'om_m', text: '改一下', taskId: 'om_t', chatId: 'oc_g', summary: 'S', status: 'done', draft: '草稿' }])
      assert.equal('draft' in decisionRecordOf({ kind: 'resume', msg: {}, task: {}, now: T0 }), false, '没草稿不写 draft 键')
    }],

    ['直接采纳率：放行 ÷（放行 + 改了再发），两样都没有为 null', () => eachCase([
      { name: '空', kinds: [], want: { release: 0, revise: 0, rate: null } },
      { name: '只有指示 / 续跑', kinds: ['instruct', 'resume', 'decline'], want: { release: 0, revise: 0, rate: null } },
      { name: '2 放 1 改', kinds: ['release', 'revise', 'release'], want: { release: 2, revise: 1, rate: 2 / 3 } },
      { name: '只改', kinds: ['revise'], want: { release: 0, revise: 1, rate: 0 } },
    ], ({ kinds, want }) => assert.deepEqual(adoptionOf(kinds.map((kind) => ({ kind }))), want))],

    ['纠错点名对单：消息 id（任务 / 回执 / 说过的话，跟并入）> 引用的私信；都对不上 null（不猜最近一条）', () => {
      const tasks = [
        { id: 'om_t1', status: 'done', linkedMessageIds: ['om_said'] },
        { id: 'om_t2', status: 'superseded', supersededBy: 'om_t3' },
        { id: 'om_t3', status: 'done' },
        { id: 'om_t4', status: 'done', messageId: 'om_orig4' },
      ]
      const store = { get: (id) => tasks.find((t) => t.id === id) || null, list: () => tasks, findTaskByAnyReceipt: (id) => (id === 'om_rcpt' ? tasks[0] : null) }
      const resolve = (text, extra = {}) => resolveCorrectionTask({ msg: { ...extra }, parsed: parseCorrection(text), store })
      assert.deepEqual(resolve('纠错 om_t1'), { task: tasks[0], via: 'message' })
      assert.deepEqual(resolve('纠错 om_rcpt'), { task: tasks[0], via: 'message' }, 'bot 发出去的那条（回执）')
      assert.deepEqual(resolve('纠错 om_said'), { task: tasks[0], via: 'message' }, '对这单说过的话')
      assert.deepEqual(resolve('纠错 om_orig4'), { task: tasks[3], via: 'message' }, '任务原消息 id')
      assert.deepEqual(resolve('纠错 om_t2'), { task: tasks[2], via: 'message' }, '并进别的单：认并入的那单')
      assert.deepEqual(resolve('纠错 om_nope 答错了', { replyToDirect: 'om_rcpt' }), { task: tasks[0], via: 'reply' }, '点名的对不上 → 看引用')
      assert.equal(resolve('纠错 答错了'), null)
      const t = { id: 'x', summary: '【PR】导出按钮没反应' }
      const opened = { opened: true, id: 'sf-20261105-fixom_in' }
      const FIX = '根因：开了修复单 sf-20261105-fixom_in，空闲就查根因修，测过自动上线，修好私信你。'
      assert.equal(correctionAckText({ saved: true, task: t, count: 3, action: 'rerun', ticket: opened }), `「导出按钮没反应」已按你的纠正重新答，更正后回原消息。\n${FIX}（纠错第 3 条）`)
      assert.equal(correctionAckText({ saved: true, task: tasks[2], count: 1, action: 'resume', ticket: opened }), `「om_t3」带着你的纠正接着做，做完回原消息。\n${FIX}（纠错第 1 条）`)
      assert.equal(correctionAckText({ saved: false, task: t, count: 0, action: 'dm', ticket: { opened: false, reason: '今天已开 10 张' } }), '「导出按钮没反应」是你私信里发起的，要我重答直接接着说就行。\n根因修复单没开（今天已开 10 张），这类错还会再犯，要人看一下。（纠错清单没写上）')
      assert.equal(correctionAckText({ saved: true, task: null, count: 2, candidates: [t, { id: 'om_y' }], ticket: opened }), `没对上是哪一单，先没重答。要更正的话回「继续任务 <id> <正确的说法>」：\n- 「导出按钮没反应」：继续任务 x\n- 「om_y」：继续任务 om_y\n${FIX}（纠错第 2 条）`)
      assert.equal(correctionAckText({ saved: true, task: null, count: 2 }), '没对上是哪一单，先没重答。要更正的话回复那条 bot 消息再发一次纠错，或贴上消息链接。\n根因修复单没开（原因不明），这类错还会再犯，要人看一下。（纠错第 2 条）')
      assert.equal(correctionDirectiveText('pre 没部署新站'), `${CORRECTION_DIRECTIVE_HEAD}pre 没部署新站`)
    }],

    ['私信主通道：纠错先于锚定——记账 + 对上的群任务当场重答（建指示任务 / 挂起的续跑）；私信单、没对上的只记；群里 / 别人说的不认', async () => {
      const config = { notifyOpenId: 'ou_aven', opsOwnerOpenIds: ['ou_aven'], ownerMap: { aven: 'ou_aven' }, project: 'PR-1' }
      const notes = []
      const saved = []
      const upserts = []
      const resumes = []
      const decisions = []
      const downloads = []
      const tickets = []
      let anchored = 0
      const tasks = [
        { id: 'om_t0', status: 'done', chatId: 'oc_g', messageId: 'om_t0', operator: 'ou_qa', summary: '没项目号' },
        { id: 'om_t1', status: 'done', chatId: 'oc_g', messageId: 'om_t1', operator: 'ou_qa', summary: '导出按钮', text: '导出按钮没反应', project: 'PR-X' },
        { id: 'om_w', status: 'waiting_confirmation', chatId: 'oc_g', messageId: 'om_w', operator: 'ou_qa', summary: '充值页', text: '充值页' },
        { id: 'om_dm', status: 'answered', chatId: 'oc_p2p', chatType: 'p2p', summary: '私信问题', text: '私信问题' },
        { id: 'om_c', status: 'done', chatId: 'oc_g', summary: '最近私信过的', receipts: [{ chatId: 'ou_aven', kind: 'done', createdAt: iso(T0 - 60_000) }] },
      ]
      const store = { get: (id) => tasks.find((t) => t.id === id) || upserts.find((t) => t.id === id) || null, list: () => tasks, upsert: (task) => (upserts.push(task), task) }
      const deps = {
        now: () => T0,
        sendPrincipalNote: async (args) => { notes.push(args); return { ok: true } },
        appendCorrection: (record) => { saved.push(record); return true },
        readCorrections: () => saved,
        openCorrectionTicket: (args) => { tickets.push(args); return { opened: true, id: `sf-fix-${args.record.id}-${tickets.length}` } },
        appendDecision: (record) => { decisions.push(record); return true },
        handleResume: async (args) => { resumes.push(args) },
        downloadAttachments: async (args) => (downloads.push(args), [{ type: 'image', imageKey: `dl-${args.attachments.length}` }]),
        resolveAnchor: () => { anchored += 1; return null },
      }
      const msg = (text, extra = {}) => ({ messageId: 'om_in', chatId: 'oc_p2p', chatType: 'p2p', senderOpenId: 'ou_aven', text, mentions: [], attachments: [], ...extra })
      // 答过的群任务：建私聊指示任务当场重答（回原消息 / 原提问人），记账 + 决策 correct
      assert.equal(await maybeHandlePrincipalChannel({ msg: msg('纠错：om_t1 pre 没部署新站', { attachments: [{ type: 'image', imageKey: 'k' }] }), config, store, deps }), true)
      assert.deepEqual([saved.length, saved[0].via, saved[0].task.id, saved[0].action, saved[0].at, anchored], [1, 'message', 'om_t1', 'rerun', iso(T0), 0])
      const rerun = upserts.at(-1)
      assert.deepEqual([rerun.id, rerun.chatId, rerun.operator, rerun.privateOrigin.anchorId, rerun.replyTarget, rerun.attachments.map((a) => a.imageKey)], ['om_in', 'oc_g', 'ou_qa', 'om_t1', { messageId: 'om_t1', inThread: false }, ['dl-1']])
      assert.deepEqual(downloads.pop(), { project: 'PR-X', messageId: 'om_in', attachments: [{ type: 'image', imageKey: 'k' }] }, '纠错里带的截图按那单的项目下载')
      assert.ok(rerun.text.startsWith(`【aven 私聊指示】${CORRECTION_DIRECTIVE_HEAD}om_t1 pre 没部署新站`), '执行器看到的是要更正的指示')
      assert.deepEqual(tasks[1].linkedMessageIds, ['om_in'])
      assert.deepEqual([decisions.at(-1).kind, decisions.at(-1).taskId], ['correct', 'om_t1'])
      assert.deepEqual([tickets.length, tickets[0].record.action, tickets[0].record.id, tickets[0].record.body, tickets[0].task.id, tickets[0].config, tickets[0].now], [1, 'rerun', 'om_in', 'om_t1 pre 没部署新站', 'om_t1', config, T0], '每条纠错都当场开修复单（带重答动作、那单、配置）')
      assert.deepEqual(notes.pop(), { config, store, text: '「导出按钮」已按你的纠正重新答，更正后回原消息。\n根因：开了修复单 sf-fix-om_in-1，空闲就查根因修，测过自动上线，修好私信你。（纠错第 1 条）', taskId: 'om_in', kind: 'ack', idempotencyKey: 'om_in-pn' })
      assert.equal(await maybeHandlePrincipalChannel({ msg: msg('纠错 om_t0 答错了', { attachments: undefined }), config, store, deps }), true)
      assert.deepEqual([downloads.pop(), upserts.at(-1).attachments.map((a) => a.imageKey)], [{ project: 'PR-1', messageId: 'om_in', attachments: [] }, ['dl-0']], '那单没项目号退到配置；没附件传空')
      saved.pop()
      notes.pop()
      // 挂起的单：带着纠正续跑（显式补料），不另建任务
      const created = () => upserts.filter((t) => t.intake?.trigger === 'principal_private').length
      const upsertsBefore = created()
      assert.equal(await maybeHandlePrincipalChannel({ msg: msg('纠错 om_w 用 508 账号'), config, store, deps }), true)
      assert.deepEqual([resumes.length, resumes[0].parentTask, resumes[0].resumeDirective, resumes[0].msg.text, created()], [1, { taskId: 'om_w', task: tasks[2], explicit: true }, { taskId: 'om_w', supplementText: `${CORRECTION_DIRECTIVE_HEAD}om_w 用 508 账号` }, `${CORRECTION_DIRECTIVE_HEAD}om_w 用 508 账号`, upsertsBefore])
      assert.deepEqual([saved.at(-1).action, decisions.at(-1).kind, notes.pop().text], ['resume', 'correct', '「充值页」带着你的纠正接着做，做完回原消息。\n根因：开了修复单 sf-fix-om_in-3，空闲就查根因修，测过自动上线，修好私信你。（纠错第 2 条）'])
      // 他自己私信发起的单 / 没对上：只记，不重答
      const decisionsBefore = decisions.length
      assert.equal(await maybeHandlePrincipalChannel({ msg: msg('纠错 om_dm 答错了'), config, store, deps }), true)
      assert.deepEqual([saved.at(-1).action, notes.pop().taskId, created(), resumes.length, decisions.length], ['dm', 'om_dm', upsertsBefore, 1, decisionsBefore])
      assert.equal(await maybeHandlePrincipalChannel({ msg: msg('纠错 漏回了'), config, store, deps }), true)
      const none = notes.pop()
      assert.deepEqual([saved.at(-1).action, none.taskId, created(), decisions.length], ['none', null, upsertsBefore, decisionsBefore])
      assert.match(none.text, /没对上是哪一单，先没重答。要更正的话回「继续任务 <id> <正确的说法>」：\n- 「最近私信过的」：继续任务 om_c\n根因：开了修复单 /, '列最近私信过他的群任务')
      deps.appendCorrection = () => false
      assert.equal(await maybeHandlePrincipalChannel({ msg: msg('纠错 om_t1 漏回了'), config, store, deps }), true)
      assert.match(notes.pop().text, /已按你的纠正重新答.*\n根因：开了修复单 .*（纠错清单没写上）$/, '没记上也照样当场重答、开修复单')
      assert.equal(await maybeHandlePrincipalChannel({ msg: msg('纠错 漏回了', { chatType: 'group', chatId: 'oc_g' }), config, store, deps }), false, '群里不认')
      assert.equal(await maybeHandlePrincipalChannel({ msg: msg('纠错 漏回了', { senderOpenId: 'ou_qa' }), config, store, deps }), false, '不是负责人')
      assert.equal(await maybeHandlePrincipalChannel({ msg: msg('不对，应该是 508 账号'), config, store, deps }), false, '补料照旧走锚定（这里锚不到 → 放行）')
      assert.equal(anchored, 1)
    }],

    ['准：漏回 / 重复回 / 回错人 / 回了收到没结论，只算范围内', () => {
      const obligations = [
        { chatId: 'oc_g', id: 'om_a', asker: 'ou_qa', state: 'answered', addressedAt: iso(T0 + 1000) },
        { chatId: 'oc_g', id: 'om_b', asker: 'ou_qa', state: 'unanswered', settledAs: 'notified', addressedAt: iso(T0 + 2000), text: '在吗' },
        { chatId: 'oc_g', id: 'om_c', asker: 'ou_qa', state: 'unanswered', settledAs: 'informed', addressedAt: iso(T0 + 3000) },
        { chatId: 'oc_g', id: 'om_old', asker: 'ou_qa', state: 'unanswered', settledAs: 'notified', addressedAt: iso(T0 - 1000) },
        { chatId: 'oc_g', id: 'om_owed', asker: 'ou_qa', state: 'owed', owedAt: iso(T0 + 5000) },
        { chatId: 'oc_g', id: 'om_late', asker: 'ou_qa', state: 'acked', overdueNotifiedAt: iso(T0 + 6000) },
        { chatId: 'oc_g', id: 'om_fixed', asker: 'ou_qa', state: 'answered', owedAt: iso(T0 + 7000) },
        { chatId: 'oc_g', id: 'om_x', asker: 'ou_x', state: 'answered' },
      ]
      const entry = (extra) => ({ chatId: 'oc_g', at: iso(T0 + 10_000), phase: 'done', hash: 'h1', taskId: 'om_a', anchor: 'om_a', to: 'ou_qa', ...extra })
      const outbox = [
        entry({}), entry({}), entry({}),
        entry({ hash: 'h2' }),
        entry({ phase: 'ack' }), entry({ phase: 'ack' }),
        entry({ at: iso(T0 - 5000) }),
        entry({ anchor: 'om_x', taskId: 'om_x2', hash: 'h3', to: 'ou_qa' }),
        entry({ anchor: null, taskId: 'om_y', hash: 'h4', to: 'ou_z' }),
        entry({ anchor: 'om_x', taskId: 'om_x3', hash: 'h5', to: null }),
        entry({ anchor: null, taskId: 'om_y', hash: 'h6' }), entry({ anchor: null, taskId: 'om_y', hash: 'h6', phase: 'self_answer' }),
        entry({ anchor: null, taskId: 'om_p1', hash: 'h7' }), entry({ anchor: null, taskId: 'om_p2', hash: 'h7' }),
        entry({ anchor: 'om_q', taskId: 'om_q1', hash: 'h8', to: null, at: iso(T0) }), entry({ anchor: 'om_q', taskId: 'om_q2', hash: 'h8', to: null, at: iso(RANGE.toMs - 1) }),
        entry({ anchor: 'om_q', taskId: 'om_q3', hash: 'h8', to: null, at: iso(RANGE.toMs) }),
      ]
      const a = summarizeAccuracy({ obligations, outbox, range: RANGE })
      assert.deepEqual(a.duplicates, [
        { chatId: 'oc_g', taskId: 'om_a', anchor: 'om_a', extra: 2 },
        { chatId: 'oc_g', taskId: 'om_y', anchor: null, extra: 1 },
        { chatId: 'oc_g', taskId: 'om_q1', anchor: 'om_q', extra: 1 },
      ], '没 anchor 按任务分组（不同任务同一句不算重复）；同一 anchor 换了任务也算；范围左闭右开')
      assert.deepEqual({ ...a, duplicates: a.duplicates.map((d) => `${d.anchor || d.taskId}+${d.extra}`) }, {
        addressed: 3,
        unanswered: [{ chatId: 'oc_g', id: 'om_b', text: '在吗' }],
        owed: [{ chatId: 'oc_g', id: 'om_owed' }, { chatId: 'oc_g', id: 'om_late' }],
        duplicates: ['om_a+2', 'om_y+1', 'om_q+1'],
        duplicateCount: 4,
        wrongPerson: [{ chatId: 'oc_g', taskId: 'om_x2', anchor: 'om_x', to: 'ou_qa' }],
      })
    }],

    ['快：系统任务不算；首句看 ackMs；答疑类（含自答）看结论；改码单列', () => {
      const rec = (extra) => ({ at: iso(T0 + 1000), id: 'om_r', deliverable: 'answer', ackMs: 10_000, totalMs: 60_000, ...extra })
      const s = summarizeSpeed({ range: RANGE, latency: [
        rec({}), rec({ ackMs: 30_000, totalMs: 120_000, deliverable: 'self_answer' }), rec({ deliverable: 'verification', ackMs: null, totalMs: 500_000 }),
        rec({ deliverable: 'change', ackMs: 20_000, totalMs: 900_000 }), rec({ deliverable: 'ask_back', ackMs: 5000, totalMs: 5000 }),
        rec({ deliverable: 'daily', ackMs: 1, totalMs: 1 }), rec({ id: 'daily-20261105-a1', deliverable: null, ackMs: 1 }), rec({ deliverable: 'ops', ackMs: 1 }),
        rec({ at: iso(T0 - 1), ackMs: 1 }),
      ] })
      assert.deepEqual(s, { ack: { n: 4, p50: 10_000, p90: 30_000 }, answer: { n: 3, p50: 120_000, p90: 500_000 }, change: { n: 1, p50: 900_000, p90: 900_000 } })
    }],

    ['省：按任务归花费，日报 / 汇总任务与范围外的不算；最贵那单带标题', () => {
      const calls = [
        { taskId: 'om_a', at: T0 + 1, usd: 0.5 }, { taskId: 'om_a', at: T0 + 2, usd: 0.25 },
        { taskId: 'om_b', at: T0 + 3, usd: 0.1 }, { taskId: 'om_c', at: T0 + 4, usd: 1 },
        { taskId: 'om_b', at: T0, usd: 0.05 }, { taskId: 'daily-20261105-a1', at: T0 + 5, usd: 9 }, { taskId: 'digest-20261105', at: T0 + 5, usd: 9 }, { taskId: 'om_d', at: T0 - 1, usd: 9 }, { taskId: 'om_e', at: RANGE.toMs, usd: 9 },
      ]
      assert.deepEqual(summarizeCost({ calls, range: RANGE, summaryOf: (id) => (id === 'om_c' ? '导出' : null) }), { tasks: 3, totalUsd: 1.9, p50Usd: 0.75, top: { taskId: 'om_c', usd: 1, summary: '导出' } })
      assert.deepEqual(summarizeCost({ calls: [], range: RANGE }), { tasks: 0, totalUsd: 0, p50Usd: null, top: null })
    }],

    ['反馈：范围内纠错条数、没处理的总数、拍板分类与采纳率', () => {
      const f = summarizeFeedback({ range: RANGE,
        corrections: [{ at: iso(T0 + 1), status: 'open', action: 'rerun' }, { at: iso(T0 - 1), status: 'open', action: 'rerun' }, { at: iso(T0 + 2), status: 'fixed', action: 'resume' }, { at: iso(T0 + 3), status: 'fixed', action: 'none' }, { at: iso(T0 + 4), status: 'open', action: 'dm' }],
        decisions: [{ at: iso(T0 + 1), kind: 'release' }, { at: iso(T0 + 2), kind: 'revise' }, { at: iso(T0 + 3), kind: 'instruct' }, { at: iso(T0 - 1), kind: 'release' }] })
      assert.deepEqual(f, { corrections: 4, correctedLive: 2, openCorrections: 3, decisions: 3, counts: { release: 1, revise: 1, decline: 0, resume: 0, instruct: 1 }, adoption: { release: 1, revise: 1, rate: 0.5 } })
    }],

    ['渲染：达线 ✅ / 不达线 ⚠️ / 没数据不标；缺值写 --；明细最多 3 条', () => {
      assert.deepEqual([formatDuration(12_400), formatDuration(59_999), formatDuration(90_000), formatDuration(3_599_999), formatDuration(3_600_000), formatDuration(null)], ['12 秒', '60 秒', '1.5 分', '60.0 分', '1.0 小时', '--'])
      assert.deepEqual(LIVE_LINES, { ackP50Ms: 47_000, answerP90Ms: 420_000 })
      const empty = buildScorecard({ range: RANGE, latency: [], obligations: [], outbox: [], calls: [], corrections: [], decisions: [] })
      assert.deepEqual(renderScorecard(empty), [
        '线上指标（今天）',
        '- 准：群里 @bot 0 条，漏回 0、重复回 0、回错人 0；回了「收到」没给结论 0',
        '- 快：没有交付记录',
        '- 省：没有模型花费',
        '- 反馈：纠错 0 条（当场重答 0，根因没处理的共 0）；你没拍板过',
      ])
      const card = buildScorecard({
        range: RANGE,
        latency: [{ at: iso(T0 + 1), id: 'a', deliverable: 'answer', ackMs: 50_000, totalMs: 300_000 }, { at: iso(T0 + 1), id: 'c', deliverable: 'change', ackMs: 10_000, totalMs: 600_000 }],
        obligations: [1, 2, 3, 4].map((i) => ({ chatId: 'oc_g', id: `om_${i}`, asker: 'ou_qa', settledAs: 'notified', addressedAt: iso(T0 + i), text: `问${i}` })),
        outbox: [],
        calls: [{ taskId: 'a', at: T0 + 1, usd: 0.3 }],
        corrections: [],
        decisions: [{ at: iso(T0 + 1), kind: 'release' }, { at: iso(T0 + 2), kind: 'revise' }, { at: iso(T0 + 3), kind: 'revise' }],
        taskCounts: { total: 5, failed: 1 },
        summaryOf: () => '登录页',
      })
      assert.deepEqual(renderScorecard(card, { title: 'T' }), [
        'T',
        '- 准：群里 @bot 4 条，漏回 4、重复回 0、回错人 0 ⚠️；回了「收到」没给结论 0；没做成 1/5',
        '- 快：首句中位 10 秒（线 ≤47 秒） ✅；答疑 / 实测结论中位 5.0 分、P90 5.0 分（线 P90 ≤7 分） ✅；改码结论中位 10.0 分',
        '- 省：1 单共 $0.30，每单中位 $0.30，最贵 $0.30（登录页）',
        '- 反馈：纠错 0 条（当场重答 0，根因没处理的共 0）；你拍板 3 次（放行 1、改了再发 2、不做 0、续跑 0、指示 0），直接采纳率 33%',
        '  · 漏回：问1', '  · 漏回：问2', '  · 漏回：问3',
      ])
      const edge = renderScorecard(buildScorecard({ range: RANGE, latency: [{ at: iso(T0 + 1), id: 'a', deliverable: 'answer', ackMs: 47_000, totalMs: 420_000 }], obligations: [], outbox: [], calls: [], corrections: [], decisions: [] }))
      assert.equal(edge[2], '- 快：首句中位 47 秒（线 ≤47 秒） ✅；答疑 / 实测结论中位 7.0 分、P90 7.0 分（线 P90 ≤7 分） ✅', '正好压线算达标')
      const onlyAsk = renderScorecard(buildScorecard({ range: RANGE, latency: [{ at: iso(T0 + 1), id: 'q', deliverable: 'ask_back', ackMs: 5000, totalMs: 5000 }], obligations: [], outbox: [], calls: [], corrections: [], decisions: [] }))
      assert.equal(onlyAsk[2], '- 快：首句中位 5 秒（线 ≤47 秒） ✅；答疑 / 实测结论中位 --、P90 --（线 P90 ≤7 分）', '只有追问：有首句、没结论')
      const dupOnly = renderScorecard(buildScorecard({ range: RANGE, latency: [], obligations: [], outbox: [
        { chatId: 'oc_g', at: iso(T0 + 1), phase: 'done', hash: 'h', taskId: 'om_t', anchor: null, to: null }, { chatId: 'oc_g', at: iso(T0 + 2), phase: 'done', hash: 'h', taskId: 'om_t', anchor: null, to: null },
      ], calls: [], corrections: [], decisions: [] }))
      assert.equal(dupOnly[1], '- 准：群里 @bot 0 条，漏回 0、重复回 1、回错人 0 ⚠️；回了「收到」没给结论 0', '没 @bot 也要标重复回')
      const slow = buildScorecard({ range: RANGE, latency: [{ at: iso(T0 + 1), id: 'a', deliverable: 'answer', ackMs: 48_000, totalMs: 421_000 }], obligations: [{ chatId: 'oc_g', id: 'om_1', asker: 'ou_qa', state: 'answered', addressedAt: iso(T0 + 1) }], outbox: [], calls: [], corrections: [], decisions: [] })
      const lines = renderScorecard(slow)
      assert.equal(lines[1], '- 准：群里 @bot 1 条，漏回 0、重复回 0、回错人 0 ✅；回了「收到」没给结论 0')
      assert.equal(lines[2], '- 快：首句中位 48 秒（线 ≤47 秒） ⚠️；答疑 / 实测结论中位 7.0 分、P90 7.0 分（线 P90 ≤7 分） ⚠️')
      const onlyChange = renderScorecard(buildScorecard({ range: RANGE, latency: [{ at: iso(T0 + 1), id: 'c', deliverable: 'change', ackMs: null, totalMs: 60_000 }], obligations: [], outbox: [], calls: [], corrections: [], decisions: [] }))
      assert.equal(onlyChange[2], '- 快：首句中位 --（线 ≤47 秒）；答疑 / 实测结论中位 --、P90 --（线 P90 ≤7 分）；改码结论中位 1.0 分')
      const dup = renderScorecard(buildScorecard({ range: RANGE, latency: [], obligations: [{ chatId: 'oc_g', id: 'om_a', asker: 'ou_qa' }], outbox: [
        { chatId: 'oc_g', at: iso(T0 + 1), phase: 'done', hash: 'h', taskId: 'om_t', anchor: 'om_a', to: 'ou_z' }, { chatId: 'oc_g', at: iso(T0 + 2), phase: 'done', hash: 'h', taskId: 'om_t', anchor: 'om_a', to: 'ou_z' },
      ], calls: [], corrections: [], decisions: [] }))
      assert.deepEqual([dup[1], ...dup.slice(5)], ['- 准：群里 @bot 0 条，漏回 0、重复回 1、回错人 2 ⚠️；回了「收到」没给结论 0', '  · 重复回：任务 om_t（多发 1 次）', '  · 回错人：任务 om_t', '  · 回错人：任务 om_t'])
    }],

    ['取数：node --test 下不指目录返回空；指到目录读义务 / 发件簿 / 时延 / 审计 / 两本账', () => {
      assert.deepEqual(collectLiveFacts(), { latency: [], obligations: [], outbox: [], calls: [], corrections: [], decisions: [] })
      const rt = join(root, 'rt')
      for (const dir of ['lark-obligations', 'lark-outbox', 'lark-audits/PR-1']) mkdirSync(join(rt, dir), { recursive: true })
      writeFileSync(join(rt, 'lark-obligations', 'oc_g.json'), JSON.stringify({ om_a: { chatId: 'oc_g', id: 'om_a' } }))
      writeFileSync(join(rt, 'lark-obligations', 'bad.json'), '{坏')
      writeFileSync(join(rt, 'lark-outbox', 'oc_g.jsonl'), `${JSON.stringify({ chatId: 'oc_g', phase: 'done' })}\n坏\n`)
      writeFileSync(join(rt, 'lark-latency.jsonl'), `${JSON.stringify({ at: iso(T0), id: 'om_a' })}\n${JSON.stringify({ at: iso(T0 - 10), id: 'om_old' })}\n`)
      writeFileSync(join(rt, 'lark-audits/PR-1', 'om_a-e0.log'), `=== ${iso(T0 + 5)} claude implement ===\n{"type":"result","session_id":"s1","total_cost_usd":0.5}\n`)
      writeFileSync(join(rt, 'lark-corrections.jsonl'), `${JSON.stringify({ at: iso(T0), id: 'c' })}\n`)
      writeFileSync(join(rt, 'lark-decisions.jsonl'), `${JSON.stringify({ at: iso(T0), kind: 'release' })}\n`)
      const facts = collectLiveFacts({ runtimeDir: rt, sinceMs: T0 })
      assert.deepEqual(facts, {
        latency: [{ at: iso(T0), id: 'om_a' }],
        obligations: [{ chatId: 'oc_g', id: 'om_a' }],
        outbox: [{ chatId: 'oc_g', phase: 'done' }],
        calls: [{ at: T0 + 5, order: 0, kind: 'implement', session: 's1', total: 0.5, taskId: 'om_a', epoch: 0, fileOrder: 1, usd: 0.5 }],
        corrections: [{ at: iso(T0), id: 'c' }],
        decisions: [{ at: iso(T0), kind: 'release' }],
      })
      assert.deepEqual([collectLiveFacts({ runtimeDir: rt, sinceMs: T0 + 5 }).calls.length, collectLiveFacts({ runtimeDir: rt, sinceMs: T0 + 6 }).calls.length], [1, 0])
    }],

    ['审计花费：同一会话累计值取增量；同一结果写两遍只算一次；没有时间头的算 0 时刻', () => {
      const log = [`=== ${iso(T0)} claude analysis ===`, '{"total_cost_usd":0.2,"session_id":"s"}', '{"total_cost_usd":0.2,"session_id":"s"}', `=== ${iso(T0 + 60_000)} claude implement ===`, '{"total_cost_usd":0.5,"session_id":"s"}', '{"total_cost_usd":"x"}', '坏 {', '{"type":"result"}'].join('\n')
      const events = parseCostLog(log)
      assert.deepEqual(events.map((e) => [e.at, e.kind, e.total]), [[T0, 'analysis', 0.2], [T0 + 60_000, 'implement', 0.5]])
      assert.deepEqual(sessionIncrements(events.map((e) => ({ ...e, fileOrder: 0 }))).map((e) => Number(e.usd.toFixed(2))), [0.2, 0.3])
      assert.deepEqual(sessionIncrements([{ at: 1, order: 0, fileOrder: 0, session: null, total: 0.4 }, { at: 2, order: 1, fileOrder: 0, session: null, total: 0.1 }]).map((e) => e.usd), [0.4, 0.1], '没会话 id 各算各的')
      assert.deepEqual(parseCostLog('{"total_cost_usd":1}').map((e) => e.at), [0])
      const inc = (events) => sessionIncrements(events).map((e) => [e.id, Number(e.usd.toFixed(2))])
      assert.deepEqual(inc([{ id: 'b', at: 1, fileOrder: 2, order: 0, session: 's', total: 0.5 }, { id: 'a', at: 1, fileOrder: 1, order: 0, session: 's', total: 0.2 }]), [['a', 0.2], ['b', 0.3]], '同一时刻按文件先后')
      assert.deepEqual(inc([{ id: 'b', at: 1, fileOrder: 1, order: 1, session: 's', total: 0.5 }, { id: 'a', at: 1, fileOrder: 1, order: 0, session: 's', total: 0.2 }]), [['a', 0.2], ['b', 0.3]], '同一文件按行先后')
      assert.deepEqual(inc([{ id: 'a', at: 1, fileOrder: 0, order: 0, session: 's', total: 0.5 }, { id: 'b', at: 2, fileOrder: 0, order: 0, session: 's', total: 0.1 }]), [['a', 0.5], ['b', 0.1]], '累计值变小（会话重开）：这次整算，不出负数')
      assert.deepEqual(inc([{ id: 'a', at: 1, fileOrder: 1, order: 0, session: 's', total: 0.5 }, { id: 'b', at: 2, fileOrder: 2, order: 0, session: 's', total: 0.5 }]), [['a', 0.5], ['b', 0]], '跨文件同一累计值：这次 0')
      assert.deepEqual(auditCalls(join(root, 'no-audits')), [])
    }],

    ['日报：私发那份末尾带线上指标节（taskCounts 用任务节口径），回群那份不带；算不出来只说一句', () => {
      const groups = [{ label: 'G', counts: { done: 2, failed: 1 }, items: [] }]
      const facts = () => ({ latency: [], obligations: [], outbox: [], calls: [{ taskId: 'om_t', at: new Date(2026, 10, 5, 12, 0).getTime(), usd: 0.2 }], corrections: [], decisions: [] })
      const lines = scorecardSection({ date: '2026-11-05', groups, tasks: [{ id: 'om_t', summary: '导出按钮' }], facts })
      assert.deepEqual([lines[0], lines[1], lines[3]], ['线上指标（今天）', '- 准：群里 @bot 0 条，漏回 0、重复回 0、回错人 0；回了「收到」没给结论 0；没做成 1/3', '- 省：1 单共 $0.20，每单中位 $0.20，最贵 $0.20（导出按钮）'])
      assert.deepEqual(scorecardSection({ date: '2026-11-05', groups, tasks: [], facts: () => { throw new Error('读坏了\n第二行') } }), ['线上指标这次没算出来：读坏了'])
      const base = { date: '2026-11-05', groups: [], bugs: { ok: false, reason: 'x' }, git: { ok: false, reason: 'y' }, digestText: '等你决定的：没有' }
      assert.match(renderDailyReport({ ...base, scorecardLines: ['线上指标（今天）', '- 准'] }), /等你决定的：没有\n\n线上指标（今天）\n- 准$/)
      assert.doesNotMatch(renderDailyReport({ ...base, withDigest: false, scorecardLines: ['线上指标（今天）'] }), /线上指标/)
      assert.match(renderDailyReport({ ...base, scorecardLines: [] }), /等你决定的：没有$/)
    }],

    ['分类器自答 / 追问记时延：deliverable 用 kind；没记「收到」时间的首句 = 这句', () => {
      const task = { id: 'om_s', messageCreatedAt: iso(T0), createdAt: iso(T0 + 1000), intake: { resolvedAt: iso(T0 + 4000) }, epoch: 0 }
      const now = iso(T0 + 6000)
      assert.deepEqual(selfReplyLatencyRecord({ task, kind: 'self_answer', now }), { at: now, id: 'om_s', deliverable: 'self_answer', status: 'answered', epoch: 0, ingestMs: 1000, classifyMs: 3000, ackMs: 6000, waitMs: null, runMs: null, deliverMs: 0, docMs: null, totalMs: 6000 })
      const acked = selfReplyLatencyRecord({ task: { ...task, ackedAt: iso(T0 + 2000) }, kind: 'ask_back', now })
      assert.deepEqual([acked.deliverable, acked.status, acked.ackMs, acked.totalMs], ['ask_back', 'waiting_confirmation', 2000, 6000])
    }],
  ]))
})
