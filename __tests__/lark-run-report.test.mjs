/**
 * worker 侧对话层的纯函数（11-01，变异补测）：结构化 outcome / 契约状态映射（lark-run-report）、群回复补写 pass（lark-group-reply-pass）、
 * 代答 / 实测提示块（lark-worker-modes）、分类提示的数据块与发送人描述（lark-classify-prompt），以及 runAI 单趟分支把 persona / envSites 带进提示。
 * 一个 it 合并全部段（测试棘轮）；每段翻转一处条件，给变异扫描用。
 * persona 从 runtime/persona/aven.md 读，larkRuntimeDir 在模块加载时定，所以 LARK_RUNTIME_DIR 先设、lib 用动态 import（同 lark-port-batch3）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { eachCase, runSteps } from './support/steps.mjs'

const dir = mkdtempSync(join(tmpdir(), 'lark-run-report-'))
mkdirSync(join(dir, 'runtime', 'persona'), { recursive: true })
writeFileSync(join(dir, 'runtime', 'persona', 'aven.md'), '# 口吻\n\n短句、先结论\n')
process.env.LARK_RUNTIME_DIR = join(dir, 'runtime')
const { buildOutcome, detailDocOf, mapStatusForContract, outcomeFromWorkerFailure, outcomeHeadline, runEvidenceFor } = await import('../lib/lark-run-report.mjs')
const { buildGroupReplyPassPrompt, owesGroupReply, runGroupReplyPass } = await import('../lib/lark-group-reply-pass.mjs')
const { buildLateMessagesPrompt, fetchLateMessages, pickLateMessages, resultAsks, runLateMessagesPass } = await import('../lib/lark-late-messages.mjs')
const { buildCosmeticFixPrompt, cosmeticDiff, runCosmeticFixPass } = await import('../lib/lark-cosmetic-diff.mjs')
const { ANSWER_MODE_BLOCK, CLAIM_EVIDENCE_RULE, DELIVER_NOW_RULE, VERIFICATION_MODE_BLOCK, buildAckPromiseBlock, buildAnswerEnvRule, buildApiReplyRetestBlock, buildCarryOverBlock, buildDocAskBlock, buildEnvLoginRule, buildEnvProbeRule, buildTestDataRule } = await import('../lib/lark-worker-modes.mjs')
const { buildTaskPromptParts } = await import('../lib/lark-worker-prompts.mjs')
const { applyEnvCheck, checkEnvTarget, envTargetLine, hostOf, resolveEnvTargets, touchedEnvs } = await import('../lib/lark-env-target.mjs')
const { buildIntentClassificationPrompt, describeSender, formatTaskAttachments, readPersona } = await import('../lib/lark-classify-prompt.mjs')
const { classifyTaskIntent, runAI } = await import('../lib/lark-worker-run.mjs')

const done = (extra = {}) => ({ status: 'done', summary: '查完了', checks: [], changedFiles: [], warnings: [], ...extra })
const pick = (obj, keys) => Object.fromEntries(keys.map((key) => [key, obj?.[key]]))
const item = (name, mark = 'ok') => ({ mark, name, note: '', evidence: 'none' })
const notDone = (name) => ({ mark: 'not_done', name, note: '', evidence: 'none' })
// 补写 pass 的假执行器：记下调用参数，按预置返回
const passExec = (result, { throws = false } = {}) => {
  const calls = []
  const exec = async (options) => {
    calls.push(options)
    if (throws) throw new Error('resume 失败')
    return { executor: 'claude', result }
  }
  return { exec, calls }
}
const ackedRun = (result, extra = {}) => ({ executor: 'claude', sessionId: 'sess-1', result, ...extra })
const owedResult = (extra = {}) => ({ status: 'done', summary: '查清了', groupReply: null, report: null, ...extra })

describe('worker 侧对话层：outcome / 契约映射 / 群回复补写 / 模式提示 / 分类数据块', () => {
  it('buildOutcome / mapStatusForContract / runEvidenceFor / owesGroupReply / runGroupReplyPass / buildEnvProbeRule / 分类提示数据块 / runAI 单趟 persona', () => runSteps([
    ['buildOutcome：文本字段只认非空字符串并去首尾空白；detailDoc 顶层优先于 report 里的；change / groupSilent / aiStatus 逐项', () => {
      const out = buildOutcome({ aiResult: done({ summary: '  修好了  ', nextStep: 5, owner: '   ', groupReply: '\n群里说\n', detailDoc: '  D1 ', report: { items: [], detailDoc: 'D2' }, groupSilent: true, followUps: [{ owner: '后端', items: ['补字段'] }] }), change: { committed: true, gate: 'commit', reason: 'r' }, actualChangedFiles: ['a.ts'] })
      assert.deepEqual(pick(out, ['summary', 'nextStep', 'owner', 'groupReply', 'detailDoc', 'groupSilent', 'aiStatus', 'changedFiles', 'change', 'kind', 'text']), { summary: '修好了', nextStep: null, owner: null, groupReply: '群里说', detailDoc: 'D1', groupSilent: true, aiStatus: 'done', changedFiles: ['a.ts'], change: { committed: true, gate: 'commit', reason: 'r' }, kind: 'ai', text: null })
      assert.deepEqual(out.followUps, [{ owner: '后端', items: ['补字段'] }])
      const bare = buildOutcome({ aiResult: { summary: 'x', groupSilent: 'yes' }, status: 'failed', change: { committed: false } })
      assert.deepEqual(pick(bare, ['groupSilent', 'aiStatus', 'changedFiles', 'change', 'detailDoc', 'followUps', 'warnings', 'blockers']), { groupSilent: false, aiStatus: 'failed', changedFiles: null, change: { committed: false, gate: null, reason: null }, detailDoc: null, followUps: null, warnings: [], blockers: [] })
      assert.equal(buildOutcome({ aiResult: null }).aiStatus, null)
      assert.equal(buildOutcome({ aiResult: { summary: 'x', groupSilent: false } }).groupSilent, false)
      assert.equal(detailDocOf({ detailDoc: null, report: { detailDoc: ' D2 ' } }), 'D2')
      assert.equal(detailDocOf({ detailDoc: 'D1', report: { detailDoc: 'D2' } }), 'D1')
      assert.equal(detailDocOf({ detailDoc: '  ', report: null }), null)
      assert.equal(detailDocOf(null), null)
      assert.deepEqual(outcomeFromWorkerFailure({ summary: ' 闸没过 ', blockers: ['a', '', null], change: { committed: false, gate: 'commit', reason: '冲突' } }), { kind: 'worker', summary: '闸没过', nextStep: null, failureKind: null, owner: null, warnings: [], blockers: ['a'], noChangeReason: null, taskState: null, rootCauseLayer: null, report: null, groupReply: null, detailDoc: null, followUps: null, changedFiles: null, change: { committed: false, gate: 'commit', reason: '冲突' }, groupSilent: false, text: null })
      assert.deepEqual(outcomeFromWorkerFailure({ summary: 'x', change: { committed: true } }).change, { committed: true, gate: null, reason: null })
      assert.equal(outcomeFromWorkerFailure({ summary: 'x' }).change, null)
    }],
    ['mapStatusForContract（plan §4.3）：answer / verification 查不到也是 done、answer 兜底；failed 只留工具 / 环境 / 权限；change / ops / 无契约原样', () => eachCase([
      { name: 'answer done 有 report.answer → 原样 done', contract: 'answer', aiStatus: 'done', outcome: { summary: 'S', report: { subject: null, answer: 'A', items: [] }, groupReply: null }, want: { status: 'done', report: { subject: null, answer: 'A', items: [] } } },
      { name: 'answer done 只有条目没 answer → 不补', contract: 'answer', aiStatus: 'done', outcome: { summary: 'S', report: { subject: 'sub', answer: null, items: [item('x')] }, groupReply: null }, want: { status: 'done', report: { subject: 'sub', answer: null, items: [item('x')] } } },
      { name: 'answer done 只有 groupReply → 不造 report', contract: 'answer', aiStatus: 'done', outcome: { summary: 'S', report: null, groupReply: '群里说' }, want: { status: 'done', report: null } },
      { name: 'answer done 没 report → answer=summary，subject 沿用', contract: 'answer', aiStatus: 'done', outcome: { summary: 'S', report: { subject: 'sub', answer: null, items: [] }, groupReply: null }, want: { status: 'done', report: { subject: 'sub', answer: 'S', items: [] } } },
      { name: 'answer done_with_warnings 没 report 没 summary → 兜底句', contract: 'answer', aiStatus: 'done_with_warnings', outcome: { summary: null, report: null, groupReply: null }, want: { status: 'done', report: { subject: null, answer: '已经看过了，结论见上。', items: [] } } },
      { name: 'answer failed tool → failed 原样', contract: 'answer', aiStatus: 'failed', outcome: { summary: 'S', failureKind: 'tool', blockers: ['b'], report: null }, want: { status: 'failed', report: null, blockers: ['b'] } },
      { name: 'answer failed env / permission → failed', contract: 'verification', aiStatus: 'failed', outcome: { summary: 'S', failureKind: 'permission', report: null }, want: { status: 'failed', report: null } },
      { name: 'answer failed requirement → done，answer=summary，blockers 清空', contract: 'answer', aiStatus: 'failed', outcome: { summary: 'S', failureKind: 'requirement', blockers: ['缺口'], report: null }, want: { status: 'done', report: { subject: null, answer: 'S', items: [notDone('缺口')] }, blockers: [] } },
      { name: 'answer blocked 没 summary → 「查不到：b1；b2」+ not_done 条目', contract: 'answer', aiStatus: 'blocked', outcome: { summary: null, blockers: ['b1', '', 'b2'], report: null }, want: { status: 'done', report: { subject: null, answer: '查不到：b1；b2', items: [notDone('b1'), notDone('b2')] }, blockers: [] } },
      { name: 'answer blocked 没 blockers → 「查不到：缺少必要信息」', contract: 'answer', aiStatus: 'blocked', outcome: { summary: null, blockers: [], report: null }, want: { status: 'done', report: { subject: null, answer: '查不到：缺少必要信息', items: [] } } },
      { name: 'answer waiting_confirmation blockers 缺省 → 同上', contract: 'answer', aiStatus: 'waiting_confirmation', outcome: { summary: null, report: null }, want: { status: 'done', report: { subject: null, answer: '查不到：缺少必要信息', items: [] } } },
      { name: 'verification blocked → 「这次没测通：…」，已有条目保留、subject 沿用', contract: 'verification', aiStatus: 'blocked', outcome: { summary: null, blockers: ['pre 连不上'], report: { subject: 'pre 注册', answer: null, items: [item('登录')] } }, want: { status: 'done', report: { subject: 'pre 注册', answer: '这次没测通：pre 连不上', items: [item('登录'), notDone('pre 连不上')] } } },
      { name: 'verification no_change_needed 有 report.answer → report 原样、仍 done', contract: 'verification', aiStatus: 'no_change_needed', outcome: { summary: 'S', blockers: ['x'], report: { subject: null, answer: '通了', items: [] } }, want: { status: 'done', report: { subject: null, answer: '通了', items: [] }, blockers: [] } },
      { name: 'verification done → done', contract: 'verification', aiStatus: 'done', outcome: { summary: 'S', report: null, groupReply: null }, want: { status: 'done', report: { subject: null, answer: 'S', items: [] } } },
      { name: 'change blocked → 原样 blocked，不碰 report', contract: 'change', aiStatus: 'blocked', outcome: { summary: null, blockers: ['b'], report: null }, want: { status: 'blocked', report: null, blockers: ['b'] } },
      { name: 'change done_with_warnings → done', contract: 'change', aiStatus: 'done_with_warnings', outcome: { summary: 'S', report: null }, want: { status: 'done', report: null } },
      { name: 'ops failed → 原样', contract: 'ops', aiStatus: 'failed', outcome: { summary: 'S', failureKind: 'requirement', report: null }, want: { status: 'failed', report: null } },
      { name: '无契约 waiting_confirmation → 原样', contract: null, aiStatus: 'waiting_confirmation', outcome: { summary: null, blockers: ['b'], report: null }, want: { status: 'waiting_confirmation', report: null, blockers: ['b'] } },
      { name: '未知 status 无契约 → failed（fail-closed）', contract: null, aiStatus: 'nonsense', outcome: { summary: 'S', report: null }, want: { status: 'failed' } },
    ], ({ contract, aiStatus, outcome, want }) => {
      const mapped = mapStatusForContract({ contract: contract ? { deliverable: contract } : null, aiStatus, outcome })
      assert.deepEqual(pick(mapped.outcome, Object.keys(want).filter((key) => key !== 'status')), Object.fromEntries(Object.entries(want).filter(([key]) => key !== 'status')))
      assert.equal(mapped.status, want.status)
      assert.notEqual(mapped.outcome, null)
    })],
    ['runEvidenceFor：没会话 id 或没 cwd 不核（null）；读 claude 会话记录按探针脚本名 / 浏览器计数；outcomeHeadline 取 answer 首个非空行、其次 summary', () => {
      assert.equal(runEvidenceFor({ aiRun: { sessionId: 's1' }, cwd: null }), null)
      assert.equal(runEvidenceFor({ aiRun: { result: {} }, cwd: '/tmp/x' }), null)
      assert.equal(runEvidenceFor({ aiRun: null, cwd: '/tmp/x' }), null)
      const home = join(dir, 'claude-home')
      const project = join(home, 'projects', '-tmp-proj')
      mkdirSync(project, { recursive: true })
      const event = (id, command) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } })
      writeFileSync(join(project, 'sess-a.jsonl'), `${event('t1', 'node scripts/probe.mjs health')}\n${event('t2', 'node tools/verify-page.mjs check /login')}\n`)
      writeFileSync(join(project, 'sess-b.jsonl'), `${event('t3', 'node scripts/probe.mjs users')}\n`)
      const aiRun = { sessionId: 'sess-b', analysisSessionId: 'sess-a', implementation: { analysisSessionId: 'sess-a' } }
      // 真发过的请求随证据带出（collectProbeLog，11-04 回放 ep-1014-d74f19）；没有就不带 probes 字段
      assert.deepEqual(runEvidenceFor({ aiRun, cwd: '/tmp/proj', verify: { probeCommand: 'node scripts/probe.mjs' }, claudeHome: home }), { probeCalls: 2, browserCalls: 1, hosts: [], probes: [{ at: null, command: 'node scripts/probe.mjs health', output: null }, { at: null, command: 'node scripts/probe.mjs users', output: null }] })
      assert.deepEqual(runEvidenceFor({ aiRun, cwd: '/tmp/proj', verify: null, claudeHome: home }), { probeCalls: 0, browserCalls: 1, hosts: [] }, '没配探针脚本就只认 curl / wget 直连')
      assert.deepEqual(runEvidenceFor({ aiRun, cwd: '/tmp/proj', verify: { probeCommand: 'node scripts/probe.mjs', browserPattern: 'verify-page\\.mjs' }, claudeHome: home }).probeCalls, 2)
      assert.equal(runEvidenceFor({ aiRun: { sessionId: 'missing' }, cwd: '/tmp/proj', claudeHome: home }), null, '一份会话记录都读不到 → 不核')
      assert.equal(outcomeHeadline({ report: { answer: '\n  \n 第一行 \n第二行' }, summary: 'S' }), '第一行')
      assert.equal(outcomeHeadline({ report: { answer: '   ' }, summary: ' 摘要 \n次行' }), '摘要')
      assert.equal(outcomeHeadline({ report: null, summary: null }), null)
      assert.equal(outcomeHeadline(null), null)
    }],
    ['owesGroupReply：群里回过「收到」、终态可发群、没判群里无事可说、groupReply 和 report 都没写才欠', () => eachCase([
      { name: '全满足 → 欠', task: { ackedInGroup: true }, result: owedResult(), want: true },
      { name: 'groupReply 只有空白 → 仍欠', task: { ackedInGroup: true }, result: owedResult({ groupReply: '  \n' }), want: true },
      { name: 'no_change_needed 也欠', task: { ackedInGroup: true }, result: owedResult({ status: 'no_change_needed' }), want: true },
      { name: 'done_with_warnings 也欠', task: { ackedInGroup: true }, result: owedResult({ status: 'done_with_warnings' }), want: true },
      { name: '群里没回过 → 不欠', task: { ackedInGroup: false }, result: owedResult(), want: false },
      { name: '没 task → 不欠', task: null, result: owedResult(), want: false },
      { name: '没结果 → 不欠（不抛）', task: { ackedInGroup: true }, result: null, want: false },
      { name: 'blocked 另有出口 → 不欠', task: { ackedInGroup: true }, result: owedResult({ status: 'blocked' }), want: false },
      { name: 'failed → 不欠', task: { ackedInGroup: true }, result: owedResult({ status: 'failed' }), want: false },
      { name: 'groupSilent → 不欠', task: { ackedInGroup: true }, result: owedResult({ groupSilent: true }), want: false },
      { name: '写了 groupReply → 不欠', task: { ackedInGroup: true }, result: owedResult({ groupReply: '通了' }), want: false },
      { name: '写了 report → 不欠', task: { ackedInGroup: true }, result: owedResult({ report: { items: [] } }), want: false },
      { name: 'groupReply 不是字符串 → 当没写（不抛）', task: { ackedInGroup: true }, result: owedResult({ groupReply: 5 }), want: true },
    ], ({ task, result, want }) => assert.equal(owesGroupReply({ task, result }), want))],
    ['runGroupReplyPass：不欠 / 没会话 / 非 claude 不补；补上 groupReply 或 report 并入结果、detailDoc 顶层优先；补不上或异常返回 false', async () => {
      const prompt = buildGroupReplyPassPrompt({ task: { ackReply: '我看下' } })
      assert.match(prompt, /^群里已经回过对方「我看下」/)
      assert.match(buildGroupReplyPassPrompt({ task: {} }), /^群里已经回过对方「收到」/)
      const notOwed = passExec({ groupReply: 'x' })
      assert.equal(await runGroupReplyPass({ task: { id: 't', ackedInGroup: false }, aiRun: ackedRun(owedResult()), exec: notOwed.exec }), false)
      assert.equal(notOwed.calls.length, 0)
      const noSession = passExec({ groupReply: 'x' })
      assert.equal(await runGroupReplyPass({ task: { id: 't', ackedInGroup: true }, aiRun: ackedRun(owedResult(), { sessionId: null }), exec: noSession.exec }), false)
      assert.equal(await runGroupReplyPass({ task: { id: 't', ackedInGroup: true }, aiRun: ackedRun(owedResult(), { executor: 'codex' }), exec: noSession.exec }), false)
      assert.equal(noSession.calls.length, 0, '没会话可续 / 非 claude 不起执行器')
      // 补上 groupReply：原结果其它字段照旧，report 置 null，detailDoc 取顶层
      const run1 = ackedRun(owedResult({ detailDoc: 'D1', report: null }))
      const withReply = passExec({ status: 'done', summary: '改写', groupReply: '  问题在后端，他们改好会同步  ', report: { items: [item('x')] }, detailDoc: 'D2' })
      assert.equal(await runGroupReplyPass({ task: { id: 't', ackedInGroup: true, ackReply: '我看下' }, aiRun: run1, exec: withReply.exec, cwd: '/w', attachments: [{ type: 'image' }], readOnly: true }), true)
      assert.deepEqual(run1.result, { status: 'done', summary: '查清了', groupReply: '问题在后端，他们改好会同步', report: null, detailDoc: 'D1' })
      assert.deepEqual(pick(withReply.calls[0], ['executor', 'resumeSessionId', 'cwd', 'attachments', 'readOnly']), { executor: 'claude', resumeSessionId: 'sess-1', cwd: '/w', attachments: [{ type: 'image' }], readOnly: true })
      assert.match(withReply.calls[0].promptText, /^群里已经回过对方「我看下」/)
      // 只补了 report：并入 report，detailDoc 取 pass 里的（原结果没有）
      const run2 = ackedRun(owedResult())
      const withReport = passExec({ status: 'done', summary: '改写', groupReply: '   ', report: { subject: 'pre', items: [item('登录')] }, detailDoc: 'D2' })
      assert.equal(await runGroupReplyPass({ task: { id: 't', ackedInGroup: true }, aiRun: run2, exec: withReport.exec }), true)
      assert.deepEqual(run2.result, { status: 'done', summary: '查清了', groupReply: null, report: { subject: 'pre', items: [item('登录')] }, detailDoc: 'D2' })
      // 两样都没补 / 执行器异常 → false，原结果不动
      const run3 = ackedRun(owedResult())
      assert.equal(await runGroupReplyPass({ task: { id: 't', ackedInGroup: true }, aiRun: run3, exec: passExec({ status: 'done', summary: 'x', groupReply: null, report: null }).exec }), false)
      assert.equal(await runGroupReplyPass({ task: { id: 't', ackedInGroup: true }, aiRun: run3, exec: passExec(null).exec }), false)
      assert.equal(await runGroupReplyPass({ task: { id: 't', ackedInGroup: true }, aiRun: run3, exec: passExec(null, { throws: true }).exec }), false)
      assert.deepEqual(run3.result, owedResult())
    }],
    ['resultAsks：挂起、blockers 有非空条、待跟进里有非空事项才算在向人要东西；形状不对不抛', () => eachCase([
      { name: '没结果', result: null, want: false },
      { name: 'done 什么都没要', result: done(), want: false },
      { name: 'blocked', result: done({ status: 'blocked' }), want: true },
      { name: 'waiting_confirmation', result: done({ status: 'waiting_confirmation' }), want: true },
      { name: 'blockers 有一条', result: done({ blockers: ['', '要账号'] }), want: true },
      { name: 'blockers 只有空白', result: done({ blockers: ['', '  ', 5] }), want: false },
      { name: 'blockers 不是数组', result: done({ blockers: '要账号' }), want: false },
      { name: '待跟进有事项', result: done({ followUps: [{ owner: 'William', items: ['给个嗨聊老账号'] }] }), want: true },
      { name: '待跟进事项都空', result: done({ followUps: [{ owner: 'William', items: [' '] }, null] }), want: false },
      { name: '待跟进 items 不是数组', result: done({ followUps: [{ owner: 'William', items: '给账号' }] }), want: false },
      { name: 'followUps 不是数组', result: done({ followUps: 'x' }), want: false },
    ], ({ result, want }) => assert.equal(resultAsks(result), want))],
    ['pickLateMessages / fetchLateMessages：本条之后的真人消息，去掉 bot / 重复 / 已并进的 / 寒暄，按时间留最近 N 条；只拉群；群列表只要没删的真人；话题回复一起拉', async () => {
      const at = (min) => String(Date.UTC(2026, 9, 22, 11, min))
      const since = Number(at(19))
      const row = (id, min, text, extra = {}) => ({ messageId: id, sender: 'Encone', createTime: at(min), text, attachments: [], ...extra })
      const items = [
        row('m_old', 19, '在本条同一刻，不算之后'),
        row('m_acct', 21, 'Account：+86 15661234567 PWD：x'),
        row('m_acct', 21, '重复的同一条'),
        row(null, 22, '没 id'),
        row('m_bot', 22, '机器人的话', { bot: true }),
        row('m_self', 22, '已并进本单的'),
        row('m_ack', 23, '收到谢谢！'),
        row('m_num', 23, '508'),
        row('m_img', 24, '![Image](img_1)', { sender: '', attachments: [{ type: 'image' }, { type: 'file', fileName: 'a.md' }, { type: 'file' }] }),
        row('m_empty', 24, '  '),
        row('m_long', 20, 'x'.repeat(600)),
      ]
      const picked = pickLateMessages({ items, sinceMs: since, excludeIds: ['m_self', null] })
      assert.deepEqual(picked.map((item) => item.messageId), ['m_long', 'm_acct', 'm_num', 'm_img'])
      assert.equal(picked[0].text, `${'x'.repeat(500)}…`)
      assert.equal(picked[3].text, '（发了 1 张图） （发了文件：a.md、文件）')
      assert.deepEqual(pickLateMessages({ items, sinceMs: since, excludeIds: ['m_self'], limit: 2 }).map((item) => item.messageId), ['m_num', 'm_img'])
      assert.deepEqual(pickLateMessages({ items: [row('m_4', 21, '好的好的')], sinceMs: since }), [], '4 字寒暄不算')
      assert.equal(pickLateMessages({ items: [row('m_5', 21, '好的好的呀')], sinceMs: since }).length, 1, '5 字就算')
      assert.equal(buildLateMessagesPrompt({ messages: picked.slice(1, 2).concat(picked.slice(3)) }).split('\n').slice(2, 4).join('\n'), `Encone（${picked[1].time}）：Account：+86 15661234567 PWD：x\n某人（${picked[3].time}）：（发了 1 张图） （发了文件：a.md、文件）`)
      // 拉取：群里一页（真人、没删的）+ 话题回复；起点是本条时间（秒），排除本条 / 关联消息 / 并进来的
      const calls = []
      const raw = (id, min, text, type = 'user', extra = {}) => ({ message_id: id, msg_type: 'text', content: text, create_time: at(min), sender: { id: 'ou_e', name: 'Encone', sender_type: type }, ...extra })
      const list = async (args) => (calls.push(args), { ok: true, messages: [raw('c3', 23, '账号 508 已开主播'), raw('c2', 22, '机器人卡', 'app'), raw('c1', 21, '删掉的那条', 'user', { deleted: true }), raw('om_task', 19, '本条')] })
      const fetchThread = async (anchor, options) => (calls.push({ anchor, options }), [row('t1', 22, '话题里给的链接 https://x'), row('om_merged', 22, '并进来的补充'), row('om_link', 22, '记在本单上的消息')])
      const task = { id: 'om_task', messageId: 'om_task', chatId: 'oc_g', threadRootId: 'omt_1', messageCreatedAt: new Date(since).toISOString(), linkedMessageIds: ['om_link'], mergedFrom: ['om_merged'] }
      assert.deepEqual((await fetchLateMessages({ task, list, fetchThread })).map((item) => item.messageId), ['t1', 'c3'])
      assert.deepEqual(calls, [{ chatId: 'oc_g', start: String(since / 1000), pageSize: 50, order: 'desc' }, { anchor: 'omt_1', options: { limit: 50 } }])
      // 没话题不拉话题；只有 createdAt 也能定起点；私信 / 没时间不拉；拉取抛错 / 失败按没有
      calls.length = 0
      assert.deepEqual((await fetchLateMessages({ task: { ...task, threadRootId: null, messageCreatedAt: null, createdAt: new Date(since).toISOString() }, list, fetchThread })).map((item) => item.messageId), ['c3'])
      assert.equal(calls.length, 1)
      assert.deepEqual([await fetchLateMessages({ task: { ...task, chatId: 'ou_aven' }, list, fetchThread }), await fetchLateMessages({ task: { ...task, messageCreatedAt: null }, list, fetchThread })], [[], []])
      assert.equal(calls.length, 1, '私信 / 没时间一次都不拉')
      const broken = async () => { throw new Error('boom') }
      assert.deepEqual(await fetchLateMessages({ task, list: broken, fetchThread: broken }), [])
      assert.deepEqual(await fetchLateMessages({ task: { ...task, threadRootId: null }, list: async () => ({ ok: false, messages: [raw('c9', 23, '不该出现')] }), fetchThread }), [])
    }],
    ['runLateMessagesPass（b3 ep-1021-d4e64d 02953573：跑的期间群里给了账号，结论还在要）：不要东西 / 没会话 / 非 claude / 没新消息不续；续上换成新结果、detailDoc 新的优先；新结果不合法或异常原样', async () => {
      const asking = (extra = {}) => ({ status: 'done', summary: '缺账号', followUps: [{ owner: 'William', items: ['给账号'] }], detailDoc: 'D-old', ...extra })
      const late = [{ messageId: 'm1', sender: 'Encone', time: '10-22 19:21', text: 'Account：x' }]
      const fetchLate = async () => late
      const task = { id: 't', contract: { deliverable: 'verification' } }
      const skip = passExec(done())
      for (const aiRunCase of [ackedRun(done()), ackedRun(asking(), { sessionId: null }), ackedRun(asking(), { executor: 'codex' })]) {
        assert.equal(await runLateMessagesPass({ task, aiRun: aiRunCase, exec: skip.exec, fetchLate }), false)
      }
      assert.equal(await runLateMessagesPass({ task, aiRun: ackedRun(asking()), exec: skip.exec, fetchLate: async () => [] }), false)
      assert.equal(skip.calls.length, 0)
      const run1 = ackedRun(asking())
      const used = passExec({ status: 'done', summary: '用 Encone 给的号测过了', followUps: null, detailDoc: null })
      assert.equal(await runLateMessagesPass({ task, aiRun: run1, exec: used.exec, fetchLate, cwd: '/w', readOnly: false }), true)
      assert.deepEqual(run1.result, { status: 'done', summary: '用 Encone 给的号测过了', followUps: null, detailDoc: 'D-old' })
      assert.deepEqual(pick(used.calls[0], ['executor', 'resumeSessionId', 'cwd', 'readOnly', 'egressScope']), { executor: 'claude', resumeSessionId: 'sess-1', cwd: '/w', readOnly: false, egressScope: 'verification' })
      assert.equal(used.calls[0].promptText, buildLateMessagesPrompt({ messages: late }))
      const run2 = ackedRun(asking({ status: 'blocked' }))
      assert.equal(await runLateMessagesPass({ task, aiRun: run2, exec: passExec({ status: 'done', summary: 's', detailDoc: 'D-new' }).exec, fetchLate }), true)
      assert.equal(run2.result.detailDoc, 'D-new')
      for (const bad of [{ summary: 's' }, { status: 'done', summary: '  ' }, null]) {
        const run = ackedRun(asking())
        assert.equal(await runLateMessagesPass({ task, aiRun: run, exec: passExec(bad).exec, fetchLate }), false)
        assert.deepEqual(run.result, asking())
      }
      const run3 = ackedRun(asking())
      assert.equal(await runLateMessagesPass({ task, aiRun: run3, exec: passExec(null, { throws: true }).exec, fetchLate }), false)
      assert.equal(await runLateMessagesPass({ task, aiRun: run3, exec: skip.exec, fetchLate: async () => { throw new Error('x') } }), false)
      assert.deepEqual(run3.result, asking())
    }],
    ['cosmeticDiff：每个文件都只动了文档 / 整行注释 / 空行才算；配置文件一行就算会运行的；二进制 / 改权限 / 改名算会运行的；空 diff 不算', () => {
      const file = (path, lines, head = '') => `diff --git a/${path} b/${path}\n${head}index 1..2 100644\n--- a/${path}\n+++ b/${path}\n@@ -1,3 +1,3 @@\n ctx\n${lines.join('\n')}\n`
      const comment = file('src/api.ts', ['-// uat/online 暂无 portal 域名', '+// online 已配 golang', '+', ' const a = 1', '\\ No newline at end of file', '@@ -9 +9 @@', '- * 旧说明', '+ * 新说明', '+{/* jsx 注释 */}'])
      const doc = file('docs/migration/dev-scripts.md', ['-| online | bbsv2:false |', '+| online | golang |'])
      assert.deepEqual(cosmeticDiff(`${comment}${doc}`), { cosmetic: true, files: ['src/api.ts', 'docs/migration/dev-scripts.md'] })
      assert.deepEqual(cosmeticDiff(doc).cosmetic, true)
      assert.deepEqual(cosmeticDiff(`${doc}${file('src/a.ts', ['+const b = 2'])}`), { cosmetic: false, files: ['docs/migration/dev-scripts.md', 'src/a.ts'] })
      assert.equal(cosmeticDiff(file('build/hosts.json', ['+// 配置文件里不认注释'])).cosmetic, false)
      assert.equal(cosmeticDiff(file('src/a.ts', ['+  '])).cosmetic, true, '只加空行')
      assert.equal(cosmeticDiff(`diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n`).cosmetic, false)
      assert.equal(cosmeticDiff(file('src/a.ts', ['+// x'], 'old mode 100644\nnew mode 100755\n')).cosmetic, false)
      assert.equal(cosmeticDiff(`diff --git a/a.md b/b.ts\nrename from a.md\nrename to b.ts\n`).cosmetic, false)
      assert.deepEqual([cosmeticDiff(''), cosmeticDiff(null)], [{ cosmetic: false, files: [] }, { cosmetic: false, files: [] }])
      assert.equal(cosmeticDiff('index 1..2\n+const stray = 1\n').cosmetic, false, '没有 diff 头的行不算')
      assert.match(buildCosmeticFixPrompt({ files: ['a.ts', 'b.md'] }), /^这单是报上来的缺陷，但你这轮实际改动只有注释 \/ 文档（a\.ts、b\.md）.*不能说成已修复[\s\S]*git checkout 还原[\s\S]*no_change_needed/)
    }],
    ['runCosmeticFixPass（b3 ep-1029-8aca6e 781b1b74：只改了注释 / 文档说「地址已补好」）：只管缺陷单报完成、claude 有会话、diff 只有注释 / 文档；续上换成新结果；不合法 / 异常原样', async () => {
      const commentOnly = 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-// old\n+// new\n'
      const real = 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n'
      const defect = { id: 't', contract: { deliverable: 'change', defect: true } }
      const claimed = (extra = {}) => done({ summary: '地址已补好', detailDoc: 'D-old', ...extra })
      const skip = passExec(done())
      let diffCalls = 0
      const diffOf = (text) => () => (diffCalls += 1, text)
      for (const [task, aiRun] of [
        [{ id: 't', contract: { deliverable: 'change', defect: false } }, ackedRun(claimed())],
        [{ id: 't' }, ackedRun(claimed())],
        [defect, ackedRun(claimed({ status: 'no_change_needed' }))],
        [defect, ackedRun(claimed(), { sessionId: null })],
        [defect, ackedRun(claimed(), { executor: 'codex' })],
      ]) assert.equal(await runCosmeticFixPass({ task, aiRun, diffOf: diffOf(commentOnly), exec: skip.exec }), false)
      assert.equal(diffCalls, 0, '前置条件不满足不取 diff')
      assert.equal(await runCosmeticFixPass({ task: defect, aiRun: ackedRun(claimed()), diffOf: diffOf(real), exec: skip.exec }), false)
      assert.equal(skip.calls.length, 0)
      const run1 = ackedRun(claimed({ status: 'done_with_warnings', warnings: ['w'] }))
      const fixed = passExec({ status: 'no_change_needed', summary: '代码已有，等 online 重新打包', noChangeReason: '等发布', detailDoc: null })
      assert.equal(await runCosmeticFixPass({ task: defect, aiRun: run1, diffOf: diffOf(commentOnly), exec: fixed.exec, cwd: '/w' }), true)
      assert.deepEqual(run1.result, { status: 'no_change_needed', summary: '代码已有，等 online 重新打包', noChangeReason: '等发布', detailDoc: 'D-old' })
      assert.deepEqual(pick(fixed.calls[0], ['executor', 'resumeSessionId', 'cwd', 'egressScope']), { executor: 'claude', resumeSessionId: 'sess-1', cwd: '/w', egressScope: 'change' })
      assert.equal(fixed.calls[0].promptText, buildCosmeticFixPrompt({ files: ['src/a.ts'] }))
      const run2 = ackedRun(claimed())
      assert.equal(await runCosmeticFixPass({ task: defect, aiRun: run2, diffOf: diffOf(commentOnly), exec: passExec({ status: 'done', summary: '改了运行代码', detailDoc: 'D-new' }).exec }), true)
      assert.equal(run2.result.detailDoc, 'D-new')
      for (const bad of [{ summary: 's' }, { status: 'done', summary: 5 }, { status: 'done', summary: '  ' }, null]) {
        const run = ackedRun(claimed())
        assert.equal(await runCosmeticFixPass({ task: defect, aiRun: run, diffOf: diffOf(commentOnly), exec: passExec(bad).exec }), false)
        assert.deepEqual(run.result, claimed())
      }
      const run3 = ackedRun(claimed())
      assert.equal(await runCosmeticFixPass({ task: defect, aiRun: run3, diffOf: diffOf(commentOnly), exec: passExec(null, { throws: true }).exec }), false)
      assert.deepEqual(run3.result, claimed())
    }],
    ['环境识别与核对（aven 11-02：online 的问题不能拿 pre 复验）：认环境名 / 中文叫法 / 域名；提示点名；本轮打的环境不对就明说、通过的降待验证', async () => {
      const sites = { dev: 'https://www.pfyys.com', test: 'https://www.dvmkgi.vip', pre: 'www.azmgb.com', online: 'https://www.fameex.com', bad: 'http://[' }
      await eachCase([
        { name: '线上', texts: ['线上登录报错，帮我看看'], want: ['online'] },
        { name: 'online 英文', texts: ['online 的充值页白屏'], want: ['online'] },
        { name: 'prod', texts: ['prod 环境挂了'], want: ['online'] },
        { name: '正式环境 / 生产环境 / 现网', texts: ['正式环境', '生产环境', '现网'], want: ['online'] },
        { name: '预发 → pre', texts: ['预发上复测一下'], want: ['pre'] },
        { name: 'pre 与 online 按出现顺序', texts: ['pre 好了，online 还不行'], want: ['pre', 'online'] },
        { name: '测试环境', texts: ['看看测试环境能不能注册'], want: ['test'] },
        { name: 'test 环境', texts: ['test环境的登录'], want: ['test'] },
        { name: 'test、pre 并列', texts: ['test、pre 代码一样吗'], want: ['test', 'pre'] },
        { name: '「测试一下」不是环境', texts: ['帮我测试一下这个按钮'], want: [] },
        { name: 'testing / prefix / devtools 不是环境', texts: ['testing prefix devtools'], want: [] },
        { name: '开发环境 / dev', texts: ['开发环境'], want: ['dev'] },
        { name: 'dev 单词', texts: ['dev 上看下'], want: ['dev'] },
        { name: 'uat', texts: ['uat 通过了'], want: ['uat'] },
        { name: '域名认环境（子域也算）', texts: ['https://cmsadmin.azmgb.com 打不开'], want: ['pre'] },
        { name: '域名和名字指同一环境不重复', texts: ['online www.fameex.com'], want: ['online'] },
        { name: '多段文本合并', texts: [null, '登录报错', '在 test 上'], want: ['test'] },
        { name: '空', texts: [], want: [] },
        { name: '开头就是域名', texts: ['azmgb.com 打不开'], want: ['pre'] },
      ], ({ texts, want }) => assert.deepEqual(resolveEnvTargets({ texts, envSites: sites }), want))
      assert.deepEqual(resolveEnvTargets({ texts: ['www.azmgb.com'] }), [], '没配地址就只认名字')
      assert.deepEqual(resolveEnvTargets(), [])
      assert.equal(hostOf('www.Fameex.com/x'), 'www.fameex.com')
      assert.equal(hostOf('http://['), null)
      assert.equal(envTargetLine({ targets: [], envSites: sites }), '')
      assert.equal(envTargetLine(), '')
      assert.equal(envTargetLine({ targets: ['online', 'uat'], envSites: sites }), '本任务点名的环境：online（https://www.fameex.com）、uat。只在点名的环境测 / 查，结论只说这个环境；别的环境的结果不能顶替，要对比就单列一条写明是哪个环境；report.subject 写明环境名。')
      assert.deepEqual(touchedEnvs({ hosts: ['www.azmgb.com', 'cmsadmin.azmgb.com', 'api.example.com', 'www.fameex.com'], envSites: sites }), ['pre', 'online'])
      assert.deepEqual(touchedEnvs(), [])
      // 几个环境共用主域（falive：pre / uat 都在 fdsser.com 下）只认整个主机名（11-04 b2 ep-1031-35935b：查的 UAT 被认成 pre，结论开头误警告）
      const shared = { pre: 'https://falivepre.fdsser.com', uat: 'https://faliveuat.fdsser.com', online: 'https://www.falive.com' }
      assert.deepEqual(touchedEnvs({ hosts: ['faliveuat.fdsser.com'], envSites: shared }), ['uat'])
      assert.deepEqual(touchedEnvs({ hosts: ['api.falivepre.fdsser.com', 'other.fdsser.com', 'm.falive.com', 'FALIVEUAT.fdsser.com'], envSites: shared }), ['pre', 'online', 'uat'], '共用主域的别的子域不归任何环境；独占主域的子域照旧')
      assert.deepEqual(checkEnvTarget({ targets: ['uat'], envSites: shared, evidence: { hosts: ['faliveuat.fdsser.com', 'www.falive.com'] } }), { ok: true, mismatch: false, targets: ['uat'], touched: ['uat', 'online'] })
      assert.deepEqual(resolveEnvTargets({ texts: ['https://faliveuat.fdsser.com/square 打不开'], envSites: shared }), ['uat'])
      assert.deepEqual(resolveEnvTargets({ texts: ['fdsser.com 上'], envSites: shared }), [], '只写共用主域认不出是哪个环境')
      await eachCase([
        { name: '点名 online 只打了 pre → 不匹配', targets: ['online'], hosts: ['www.azmgb.com'], want: { ok: false, mismatch: true, touched: ['pre'] } },
        { name: '点名 online 打了 online（顺带打 pre 对比）→ 匹配', targets: ['online'], hosts: ['www.azmgb.com', 'www.fameex.com'], want: { ok: true, mismatch: false, touched: ['pre', 'online'] } },
        { name: '没点名 → 不判', targets: [], hosts: ['www.azmgb.com'], want: { ok: true, mismatch: false, touched: ['pre'] } },
        { name: '本轮没打任何环境 → 不判', targets: ['online'], hosts: ['api.example.com'], want: { ok: true, mismatch: false, touched: [] } },
      ], ({ targets, hosts, want }) => assert.deepEqual(checkEnvTarget({ targets, envSites: sites, evidence: { hosts } }), { ...want, targets }))
      assert.deepEqual(checkEnvTarget({ targets: ['online'], envSites: sites, evidence: null }), { ok: true, mismatch: false, targets: ['online'], touched: [] }, '读不到会话不核')
      assert.deepEqual(checkEnvTarget({ targets: ['online'], envSites: sites, evidence: {} }).touched, [])
      assert.deepEqual(checkEnvTarget(), { ok: true, mismatch: false, targets: [], touched: [] })
      const report = { subject: 'pre 登录', answer: null, items: [{ mark: 'ok', name: '登录', note: '200', evidence: 'pre' }, { mark: 'not_done', name: '注册', note: '', evidence: 'none' }] }
      const mismatch = { mismatch: true, targets: ['online'], touched: ['pre'] }
      assert.deepEqual(applyEnvCheck(report, mismatch), { ...report, answer: '⚠ 这次实际测的是 pre，不是你说的 online，下面的结论不代表 online。', items: [{ ...report.items[0], mark: 'unverified' }, report.items[1]] })
      assert.equal(applyEnvCheck({ ...report, answer: '能登录' }, mismatch).answer, '⚠ 这次实际测的是 pre，不是你说的 online，下面的结论不代表 online。\n能登录')
      assert.equal(applyEnvCheck(report, { mismatch: false }), report)
      assert.equal(applyEnvCheck(report, null), report)
      assert.equal(applyEnvCheck(null, mismatch), null)
      // buildOutcome 把核对结果用到 report 上
      const out = buildOutcome({ aiResult: { status: 'done', report }, envCheck: mismatch })
      assert.equal(out.report.items[0].mark, 'unverified')
      assert.equal(buildOutcome({ aiResult: { status: 'done', report } }).report.items[0].mark, 'ok')
      // 提示：点名了才加那一行；代答 / 实测两种都加
      const named = { envTargets: ['online'] }
      assert.ok(VERIFICATION_MODE_BLOCK(named, { envSites: sites }).includes('本任务点名的环境：online（https://www.fameex.com）'))
      assert.ok(ANSWER_MODE_BLOCK(named, { envSites: sites }).includes('本任务点名的环境：online（https://www.fameex.com）'))
      assert.equal(VERIFICATION_MODE_BLOCK({}, { envSites: sites }).includes('本任务点名的环境'), false)
      assert.equal(ANSWER_MODE_BLOCK(null).includes('本任务点名的环境'), false)
    }],
    // 11-03 falive 回放：「测试的tid 发出来」tid 在上一单结论里却回「去翻文档」；「创建最新的帖子」先回「我在 pre 发几条新帖」，实测只读没发。
    ['代答 / 实测：要什么本轮给什么（两种模式都带）；「收到」那句与上一单结论只进单趟提示', () => {
      for (const block of [ANSWER_MODE_BLOCK({}), ANSWER_MODE_BLOCK({}, { persona: '短句' }), VERIFICATION_MODE_BLOCK({}), VERIFICATION_MODE_BLOCK({}, { hasPageTool: true })]) assert.ok(block.endsWith(`\n${DELIVER_NOW_RULE}\n${CLAIM_EVIDENCE_RULE}`))
      // 下结论要有据（11-04 b3）：只依据本轮实测或 bot 自己最近一次带时间的实测；对方说法没核过不附和不反驳；核不了就说核不了、不下结论
      assert.match(CLAIM_EVIDENCE_RULE, /通没通 \/ 修没修 \/ 是不是 bug 只依据本轮实测或 bot 最近一次带时间的实测（写明几点）.*没核过不附和（不说「对上了」）也不反驳.*核不了就说核不了、缺什么，不下结论/)
      assert.match(DELIVER_NOW_RULE, /要事实（tid \/ 账号 \/ 地址 \/ 数据）就查出来直接列.*上一单结论.*只读去环境拉.*不让对方自己去翻.*不允许（发帖 \/ 注册 \/ 下单这类写操作）就直说这边做不了、该找谁.*单趟没有下次.*群里先回的那句答应过的/)
      const prior = { taskId: 'om_prev', summary: '翻译实测', text: '- 标题翻译：18726–18742' }
      const PRIOR_LINE = '本条接着任务 om_prev（翻译实测），那单 bot 的结论（以前的记录，用前对一下）：\n- 标题翻译：18726–18742'
      return eachCase([
        { name: '都没有 → 空', task: {}, want: '' },
        { name: '没任务 → 空', task: null, want: '' },
        { name: '只有「收到」那句（真正发出去的 ackReply）', task: { ackReply: '好，我查下发你' }, want: '群里已先回了一句：「好，我查下发你」' },
        // 11-03 第二次 review #4：分类器写了 reply 却没发（超 45 秒发了固定句 / 私聊指示不发 / 并入目标是 A 当初的分类）→ 不算说过
        { name: '分类器的 reply 没发出去 → 不算', task: { intake: { classification: { reply: '好，我查下发你' } } }, want: '' },
        { name: '只有上一单结论', task: { priorConclusion: prior }, want: PRIOR_LINE },
        { name: '上一单没摘要', task: { priorConclusion: { ...prior, summary: null } }, want: '本条接着任务 om_prev，那单 bot 的结论（以前的记录，用前对一下）：\n- 标题翻译：18726–18742' },
        // 重开 / 在跑时并入跑完重跑：说清是本单已经回过的，这轮只接新补充（11-03 review 遗留：重跑把答过的再答一遍）
        { name: '接着本单自己上一轮 → 说「本单上一轮已经回给对方」、只处理新补充', task: { id: 'om_prev', priorConclusion: prior }, want: '本单上一轮 bot 已经回给对方的结论（这轮只处理之后新追加的【同主题补充】，上一轮答过的不再重复；以前的记录，用前对一下）：\n- 标题翻译：18726–18742' },
        // 11-03 第二次 review #8：环境不相交不并入、continues 仍指上一单（uat 的实测结论）——实测模式里它只作背景，环境事实本轮实测
        { name: '实测模式：上一单结论只作背景，不顶替本轮实测', task: { priorConclusion: prior }, verification: true, want: '本条接着任务 om_prev（翻译实测），那单 bot 的结论（以前的记录，只作背景：环境能不能用 / 有没有数据以本轮实测为准，不拿它顶替）：\n- 标题翻译：18726–18742' },
        { name: '两者都有：「收到」在前', task: { priorConclusion: prior, ackReply: '好' }, want: `群里已先回了一句：「好」\n${PRIOR_LINE}` },
        // 11-05 b3 ep-1027-63a6f3：引用「分享链接为空」那条空 @，分类器读成测 room/271，worker 按引用答了分享链接
        { name: '原话空 @（只引用）：带分类器读出的要做的事，在最前', task: { text: '【被引用消息】（Eric 10-27 14:02）\n分享链接为空\n\n【本条 @】（无附言）\n\n【话题其它回复】\nHTStone：先用 room/271 验證', ackReply: '收到', intake: { classification: { summary: '去 pre 打开 room/271 看能不能播' } } }, want: '本条原话没写要做什么，按上下文读出的是：「去 pre 打开 room/271 看能不能播」——就做这件，引用的旧消息和前文只是背景。\n群里已先回了一句：「收到」' },
        { name: '原话只 @ 了机器人：同上', task: { text: '【本条 @】（无附言，只 @ 了机器人）\n\n【群里这条之前的消息】\nEncone：为啥 404', intake: { classification: { summary: '答 Encone 为啥项目里 404' } } }, want: '本条原话没写要做什么，按上下文读出的是：「答 Encone 为啥项目里 404」——就做这件，引用的旧消息和前文只是背景。' },
        { name: '原话有内容：不带', task: { text: '【本条 @】测一下 room/271', intake: { classification: { summary: '测 271' } } }, want: '' },
        { name: '原话只剩两个字（「看下」）：算没写，带', task: { text: '【本条 @】@Aven.Bot 看下', intake: { classification: { summary: '复测 271' } } }, want: '本条原话没写要做什么，按上下文读出的是：「复测 271」——就做这件，引用的旧消息和前文只是背景。' },
        { name: '原话三个字：不带', task: { text: '【本条 @】测一下', intake: { classification: { summary: '复测 271' } } }, want: '' },
        // 11-05 b3 ep-1029-8aca6e 4abde287：William 问的，结论叫成 Encone
        { name: '记了提问人：最前一行', task: { operatorName: 'William', ackReply: '好' }, want: '本条是 William 说的，回话称呼对他。\n群里已先回了一句：「好」' },
        { name: '原话空但分类没摘要：不带', task: { text: '【本条 @】（无附言）', intake: { classification: { summary: null } } }, want: '' },
        // 11-04 回放 ep-1014-d74f19：引用的 bot 消息出自另一单，「针对这条消息」问的就是那单
        { name: '引用的 bot 消息出自另一单：带那单的结论（在上一单之后）', task: { priorConclusion: prior, quotedConclusion: { taskId: 'om_q', summary: '复测 /go-api', text: '反代通了' } }, want: `${PRIOR_LINE}\n本条引用的 bot 那条消息出自任务 om_q（复测 /go-api），「这条 / 本次」指的就是那单（以前的记录，用前对一下）：\n反代通了` },
      ], ({ task, verification = false, want }) => {
        assert.equal(buildCarryOverBlock(task, { verification }), want)
        const ctx = { projectId: 'PR-99999', projectName: 't', projectDocs: [], cwd: '/tmp/repo' }
        const full = { id: 't', attachments: [], chatId: 'oc', text: '测试的tid 发出来', ...task }
        for (const [contract, carried] of [[{ v: 1, deliverable: 'answer', readOnly: true, expectsCode: false }, true], [{ v: 1, deliverable: 'verification', readOnly: false, expectsCode: false }, true], [{ v: 1, deliverable: 'change', readOnly: false, expectsCode: true }, false]]) {
          const { user } = buildTaskPromptParts(ctx, { ...full, contract, intake: { ...full.intake, classification: { decision: 'bug', ...full.intake?.classification } } }, 'claude', { ruleContext: { text: '', sources: [] } })
          const block = buildCarryOverBlock(full, { verification: contract.deliverable === 'verification' })
          if (want) assert.equal(user.includes(`\n${block}\n`), carried, `${contract.deliverable}：${carried ? '要带' : '不带'}`)
          assert.equal(['本条接着任务', '本单上一轮', '本条引用的 bot'].some((line) => user.includes(line)), carried && Boolean(task?.priorConclusion || task?.quotedConclusion))
          // 改码类不带上一单结论，但「收到」里答应的只读事要兑现（buildAckPromiseBlock，11-04 回放 ep-1031-35935b）
          assert.equal(user.includes('群里已先回了一句'), Boolean(task?.ackReply), `${contract.deliverable}：发过「收到」就带那句`)
          if (!carried) assert.equal(user.includes('单趟没有下次，不写「测完再回你」'), Boolean(task?.ackReply))
          assert.equal(user.includes('curl GET / 登录 POST'), contract.deliverable === 'verification', '只有实测放开登录 POST（aven 11-04）')
        }
      })
    }],
    ['buildDocAskBlock：改码单原话（含并进来的补充）要文档 / 点名找人 → detailDoc + followUps；只进改码类 user 层（11-05 b3 ep-1029-8aca6e c2536e7d）', () => {
      const BLOCK = '原话还要一份给人的文档 / 点名找人：文档正文（缺什么、各找谁、怎么接）写进结果顶层 detailDoc（markdown，bot 建成 Lark 文档、群里附链接）；要谁补什么写进 followUps [{owner, items}]（群里逐人 @）。只改了代码不算交付完。'
      const hits = ['现在进入了发 uat/online 阶段，还需要什么支持，请出一份对接文档，@相关同学', '同步对接一下，并生成反馈文档', '整理一下待办清单', '改完更新下对接文档', '有问题 @ 相关同学']
      const misses = ['按文档改一下登录页', '文档在这，你看下', '把清单里的第 3 项删掉', '@Arthur 看下']
      assert.deepEqual([hits.map((line) => buildDocAskBlock({ text: `【本条 @】${line}` })), misses.map((line) => buildDocAskBlock({ text: `【本条 @】${line}` }))], [hits.map(() => BLOCK), misses.map(() => '')])
      assert.equal(buildDocAskBlock({ text: '【本条 @】改下 SSR 地址\n\n【同主题补充 2026-10-29T04:25 · aven】【本条 @】请出一份对接文档' }), BLOCK, '并进来的补充也看')
      assert.equal(buildDocAskBlock({ text: '【本条 @】改下 SSR 地址\n\n【同主题补充 2026-10-29T04:25】请出一份对接文档，@相关同学' }), BLOCK, '补充是纯正文也看')
      assert.equal(buildDocAskBlock({ text: '【本条 @】改下 SSR 地址\n\n【补料】\n再出一份反馈文档' }), BLOCK, '续跑补料也看')
      assert.equal(buildDocAskBlock({ text: '请出一份对接文档' }), BLOCK, '没有【本条 @】看首行')
      assert.equal(buildDocAskBlock({ text: '【本条 @】改下地址\n\n【群里这条之前的消息】\nEncone：请出一份对接文档' }), '', '前文里别人说的不算')
      assert.equal(buildDocAskBlock(null), '')
      const ctx = { projectId: 'PR-99999', projectName: 't', projectDocs: [], cwd: '/tmp/repo' }
      const task = (deliverable) => ({ id: 't', attachments: [], chatId: 'oc', text: '【本条 @】请出一份对接文档', contract: { v: 1, deliverable, readOnly: deliverable === 'answer', expectsCode: deliverable === 'change' }, intake: { classification: { decision: 'requirement' } } })
      assert.deepEqual(['change', 'answer', 'verification'].map((d) => buildTaskPromptParts(ctx, task(d), 'claude', { ruleContext: { text: '', sources: [] } }).user.includes(BLOCK)), [true, false, false])
    }],
    ['buildEnvProbeRule：只认非空字符串地址；一个都没有就说明没配环境地址；只放开登录 POST（aven 11-04）', () => {
      assert.match(buildEnvProbeRule({ test: 'https://test.example.com', pre: ' ', uat: 5, online: null }), /上下文说哪个环境就测哪个：test https:\/\/test\.example\.com；只打上面这些地址.*只发 GET，唯一例外是为拿登录态（token \/ cookie）登录，含验证码登录（发登录码 \+ 用码登录）；不注册（发注册码也算）、不上传、不下单、不改任何数据，要写数据的那步写明卡在哪、请谁手动做。$/)
      assert.match(buildEnvProbeRule({ test: 'https://t', pre: 'https://p' }), /test https:\/\/t、pre https:\/\/p；只打上面这些地址（含同主域子站），上游 \/ 合作方 \/ 第三方的域名（如 hichat 后端、Google 登录）不打，它们的状态只转述上下文并写明出处和日期；第三方组件看本环境页面怎么引用它 \+ 读代码。命令层会拦范围外地址（报「\[lark-egress\] 已拦截」），拦了就按转述写，不换写法重试。不拿别的环境/)
      for (const sites of [null, {}, { pre: 7 }, { pre: '  ' }]) assert.match(buildEnvProbeRule(sites), /^环境实测：本仓没有配环境地址/)
    }],
    // 11-04 falive 回放 ep-1029-f09207：代答把引用里 10-28 的「实测握手 404」照抄成现状，没复测
    ['buildAnswerEnvRule：代答说环境现状也以本轮实测为准、旧结论不当现状；只放开 GET；进代答块不进实测块', () => {
      const rule = buildAnswerEnvRule({ pre: 'https://p', uat: ' ', online: null })
      assert.match(rule, /^环境现状：.*现在能不能用 \/ 有没有数据 \/ 报不报错.*引用消息.*上一单.*更早的实测结论.*先本轮只读打一下该环境（pre https:\/\/p；只打上面这些地址（含同主域子站），上游 \/ 合作方 \/ 第三方的域名（如 hichat 后端、Google 登录）不打，它们的状态只转述上下文并写明出处和日期；第三方组件看本环境页面怎么引用它 \+ 读代码。命令层会拦范围外地址（报「\[lark-egress\] 已拦截」），拦了就按转述写，不换写法重试），curl GET，WebSocket 看握手，以本轮结果为准；测不了就写明那是哪天谁的结论、这次没复测，不当现状说。$/)
      assert.doesNotMatch(rule, /POST/)
      // 没配环境地址：一个地址都不打，只转述（aven 11-04 出网范围）
      for (const sites of [null, {}, { pre: ' ' }]) assert.equal(buildAnswerEnvRule(sites), '环境现状：answer 里要说某个环境现在能不能用 / 有没有数据 / 报不报错，包括复述引用消息、上下文、文档或上一单里更早的实测结论，本仓没有配环境地址，不去打任何地址；写明那是哪天谁的结论、这次没复测，不当现状说。')
      assert.ok(ANSWER_MODE_BLOCK({}, { envSites: { pre: 'https://p' } }).includes(`\n${rule}\n2. `))
      assert.equal(VERIFICATION_MODE_BLOCK({}, { envSites: { pre: 'https://p' } }).includes('环境现状：'), false)
    }],
    // 11-04 falive 回放 ep-1031-35935b：改码单没兑现「收到」里答应的 pre 复测，还写「测完把结果回你」
    ['buildAckPromiseBlock：只在发过「收到」时出现；答应的只读事本轮做、写进 report、不许「测完再回你」；配了环境列地址、只 GET（登录 POST 除外）、上游不打', () => {
      assert.equal(buildAckPromiseBlock({}), '')
      assert.equal(buildAckPromiseBlock(null), '')
      const block = buildAckPromiseBlock({ ackReply: '评论积分我去 pre 再测一下' }, { envSites: { pre: 'https://p', uat: ' ' } })
      assert.match(block, /^群里已先回了一句：「评论积分我去 pre 再测一下」。里面答应的只读事.*本轮一并做（打 pre https:\/\/p，只发 GET（登录拿态的 POST 除外；下方固定知识里有该环境测试号就用它登录），上游 \/ 合作方域名不打）.*report.*not_done.*单趟没有下次，不写「测完再回你」。\n【环境与部署/)
      assert.match(buildAckPromiseBlock({ ackReply: '好' }), /本仓没配环境地址，测不了就写明.*不写「测完再回你」。$/, '没环境没知识：不带知识块')
      // 11-04 b3：实施阶段要带上测试号（固定知识）才测得了；知识原文接在后面
      const known = buildAckPromiseBlock({ ackReply: '好' }, { knowledge: '生产测试号 uid 484' })
      assert.match(known, /测不了就写明.*不写「测完再回你」。\n【环境与部署（负责人维护的固定知识）】[\s\S]*\n生产测试号 uid 484$/)
      assert.doesNotMatch(known, /查各环境现在跑的是哪个提交/, '没配环境不给查版本工具')
    }],
    // b3 ep-1024-9ebe13：自己写脚本设 PROBE_ALLOW_WRITE 去登录被自动审批拦；「创建最新的帖子 进行测试」拒发帖没测成
    ['测试号登录 / 造测试数据：配了测试号才有登录句（固定工具、不设写开关、被拦也用它）；放开了环境才有造数据句；进代答 / 实测 / 改码块', () => {
      const accounts = { pre: { mail: 'qa@x' } }
      const login = buildEnvLoginRule(accounts)
      assert.match(login, /^要登录态只用 `node \/\S+\/tools\/env-login\.mjs --env <环境>`（配了测试号的：pre；只登录不注册，token 用 `\$\(… --token\)` 取，摘要里列了别的凭证（如 hichat_token）用 `--token <名>` 取，都不打印）；不自己写登录脚本、不设 PROBE_ALLOW_WRITE 之类写开关，被权限拦下也改用它。$/)
      for (const none of [null, {}]) assert.equal(buildEnvLoginRule(none), '')
      const testData = buildTestDataRule(['pre'])
      assert.match(testData, /^本单对方明确要造测试数据（发帖不允许的口径本单例外）：只在 pre 用测试号.*不删、不改、不碰别人的数据、不注册；建了什么把 id（如 tid）列进 report；命令层拦了就照实写拦在哪。$/)
      for (const none of [[], null, undefined]) assert.equal(buildTestDataRule(none), '')
      assert.ok(ANSWER_MODE_BLOCK({}, { envSites: { pre: 'https://p' }, testAccounts: accounts }).includes(`\n${login}\n2. `))
      assert.equal(ANSWER_MODE_BLOCK({}, { envSites: { pre: 'https://p' } }).includes('env-login'), false)
      const verifyBlock = VERIFICATION_MODE_BLOCK({}, { envSites: { pre: 'https://p' }, testAccounts: accounts, testDataEnvs: ['pre'] })
      assert.ok(verifyBlock.includes(`${buildEnvProbeRule({ pre: 'https://p' })}\n${login}\n${testData}\n账号：固定知识`), '登录 / 造数据句在探测规则后、账号规则前')
      assert.equal(VERIFICATION_MODE_BLOCK({}, { envSites: { pre: 'https://p' }, testAccounts: accounts }).includes('造测试数据'), false)
      assert.equal(buildAckPromiseBlock({}, { testAccounts: accounts, testDataEnvs: ['pre'] }), `${testData}${login}`, '改码单没「收到」也给造数据口径')
      assert.ok(buildAckPromiseBlock({ ackReply: '好' }, { testAccounts: accounts, testDataEnvs: ['pre'] }).endsWith(`不写「测完再回你」。\n${testData}${login}`))
      assert.equal(buildAckPromiseBlock({ ackReply: '好' }, { testAccounts: accounts }).includes('env-login'), false)
      const verification = buildTaskPromptParts({ projectId: 'TR-1', projectDocs: [], cwd: '/tmp/repo' }, { id: 't', text: '创建最新的帖子 进行测试', attachments: [], contract: { v: 1, deliverable: 'verification', readOnly: false, testData: true } }, 'claude', { ruleContext: { text: '', sources: [] }, envSites: { pre: 'https://p' }, testAccounts: accounts, testDataEnvs: ['pre'] }).user
      assert.match(verification, /curl GET \/ 登录 POST \/ 本单要求的建测试数据）/)
      const answer = buildTaskPromptParts({ projectId: 'TR-1', projectDocs: [], cwd: '/tmp/repo' }, { id: 't', text: '问', attachments: [], contract: { v: 1, deliverable: 'answer', readOnly: true } }, 'claude', { ruleContext: { text: '', sources: [] }, envSites: { pre: 'https://p' }, testAccounts: accounts, testDataEnvs: ['pre'] }).user
      assert.match(answer, /curl GET \/ env-login 登录）/)
      assert.doesNotMatch(answer, /建测试数据/, '代答永远不造')
    }],
    // 11-04 b3 ep-1019-57332a：对接答复「读一下」判了不用改、没在 pre 复测；「已经上 pre 了」只报了改码
    ['buildApiReplyRetestBlock：只给分类成 api_reply 的单；逐项复测写进 report.items、归别人的写 followUps、不用改也逐项报；配了环境列地址只 GET；进改码 user 层、代答 / 实测不带', () => {
      assert.equal(buildApiReplyRetestBlock({}), '')
      assert.equal(buildApiReplyRetestBlock(null), '')
      assert.equal(buildApiReplyRetestBlock({ intake: { classification: { decision: 'bug' } } }), '')
      const api = { intake: { classification: { decision: 'api_reply', deliverable: 'change' } } }
      const block = buildApiReplyRetestBlock(api, { envSites: { pre: 'https://p', uat: ' ' } })
      assert.match(block, /^本条是对方在答复我方的对接待办.*每一项本轮都去环境复测（打 pre https:\/\/p，只发 GET（登录拿态的 POST 除外））.*report\.items.*not_done.*followUps \[\{owner, items\}\].*不用改代码也逐项报，不只给一句「不用改」。$/)
      assert.match(buildApiReplyRetestBlock(api), /本仓没配环境地址，测不了就写明/)
      const ctx = { projectId: 'PR-99999', projectName: 't', projectDocs: [], cwd: '/tmp/repo' }
      const base = { id: 't', attachments: [], chatId: 'oc', text: '读一下', ...api }
      const user = (contract, extra = {}) => buildTaskPromptParts(ctx, { ...base, contract, ...extra }, 'claude', { ruleContext: { text: '', sources: [] } }).user
      assert.ok(user({ v: 1, deliverable: 'change', readOnly: false, expectsCode: true }).includes(buildApiReplyRetestBlock(api)))
      const both = user({ v: 1, deliverable: 'change', readOnly: false, expectsCode: true }, { ackReply: '我先理出来' })
      assert.ok(both.includes(`${buildAckPromiseBlock({ ackReply: '我先理出来' })}\n${buildApiReplyRetestBlock(api)}`), '和「收到」那块各一段')
      for (const deliverable of ['answer', 'verification']) assert.equal(user({ v: 1, deliverable, readOnly: deliverable === 'answer', expectsCode: false }).includes('本条是对方在答复我方的对接待办'), false)
    }],
    // 11-04 falive 回放 ep-1021-8cca5c：「404 的接口具体是哪两个」把台账里三支硬凑成两支（「两个」其实指同一接口两个号测）
    ['代答块：指着前文问先对上被指的那句，对不上直说、不硬凑；实测块不带', () => {
      // 11-04 b3 同一条：旧示例「记录里是三个」反把答案带偏——从近往远对，最近 bot 那条优先，点明对的是哪条
      assert.match(ANSWER_MODE_BLOCK({}, {}), /对方指着前文问（「那两个」「刚才说的」）：从近往远找被指的那句——先对上下文末尾 bot 自己最近发的结论.*answer 开头点明对的是哪条.*以最近的为准.*不硬凑。/)
      assert.doesNotMatch(ANSWER_MODE_BLOCK({}, {}), /记录里是三个/)
      assert.equal(VERIFICATION_MODE_BLOCK({}, {}).includes('对方指着前文问'), false)
      // 11-05 b3 ep-1020-437502 / ep-1028-ce8964：问现状 / 出反馈对上最近定下的口径，已定的不再写成待拍板
      assert.match(ANSWER_MODE_BLOCK({}, {}), /不硬凑。\n问现状 \/ 缺什么 \/ 能不能提测、出反馈：先对上话题和前文里最近定下的口径.*不一致的列成缺口，已定的不再写成「待谁拍板」。\n/)
      // 11-04 b3 ep-1031-35935b「测生产评论任务」：有测试号就用它只读查基线、写的那步点名请人做、修复上没上该环境先核
      assert.match(VERIFICATION_MODE_BLOCK({}, {}), /\n账号：固定知识有该环境测试号就登录查只读基线（任务状态、余额 \/ 流水），不说没账号；写数据点名请报问题或有号的人做；复测修复先核上没上该环境（后端的问对方）。\n3\. /)
      assert.equal(ANSWER_MODE_BLOCK({}, {}).includes('账号：固定知识'), false, '代答不带')
    }],
    ['分类提示的数据块：附件行、发送人（本人 / ownerMap 反查 + 角色 / 未登记）、persona 文件、锚点 / 活动 / 候选块、正文', () => {
      assert.equal(formatTaskAttachments({ attachments: [{ type: 'image', fileName: 'a.png', width: 10, height: 20, origin: '引用消息' }, { localPath: '/p', width: 10 }, { type: 'file', imageKey: 'img_1', downloadError: '403' }] }), '1. image「a.png」；来源：引用消息；尺寸：10x20\n2. attachment；本地路径：/p\n3. file；Lark image_key：img_1；下载状态：403')
      assert.equal(formatTaskAttachments({ attachments: [] }), '无')
      assert.equal(formatTaskAttachments(null), '无')
      const localConfig = { notifyOpenId: 'ou_aven', allowedOpenIds: ['ou_second'], ownerMap: { alice: 'ou_a', bob: 'ou_b' }, memberRoles: { bob: 'QA' } }
      assert.equal(describeSender({ task: { operator: 'ou_aven' }, localConfig }), 'aven 本人（负责人）')
      assert.equal(describeSender({ task: { operator: 'ou_second' }, localConfig }), 'aven 本人（负责人）')
      assert.equal(describeSender({ task: { operator: 'ou_b' }, localConfig }), 'bob（QA）')
      assert.equal(describeSender({ task: { operator: 'ou_a' }, localConfig }), 'alice')
      assert.equal(describeSender({ task: { operator: 'ou_zzz' }, localConfig }), '未登记成员（ou_zzz）')
      assert.equal(describeSender({ task: { operator: 'ou_b' }, localConfig: { memberRoles: { bob: 'QA' } } }), '未登记成员（ou_b）', '没有 ownerMap 反查不到')
      assert.equal(describeSender({ task: {} }), '未知')
      assert.equal(readPersona(), '# 口吻\n短句、先结论', '默认读 runtime/persona/aven.md，去空行')
      assert.equal(readPersona({ path: join(dir, 'runtime', 'persona', 'aven.md'), maxLines: 1 }), '# 口吻')
      assert.equal(readPersona({ path: join(dir, 'nope.md') }), null)
      writeFileSync(join(dir, 'blank.md'), '\n\n')
      assert.equal(readPersona({ path: join(dir, 'blank.md') }), null)
      const task = { text: '重跑', operator: 'ou_b', conversation: { anchor: { taskId: 'om_prev', at: '2026-11-01T02:00:00.000Z', text: '查完回你' }, activity: { outbox: [{ at: '2026-11-01T01:00:00.000Z', phase: 'ack', text: '收到' }] }, candidates: [{ id: 'om_c', status: 'done', summary: '登录白屏' }] } }
      const prompt = buildIntentClassificationPrompt(task, { localConfig, persona: '短句' })
      assert.match(prompt, /【负责人（aven）的说明，答他能答的、照他的口吻和取舍判断】\n短句/)
      assert.match(prompt, /【默认接着 bot 上一句】bot \d\d:\d\d 对他说（任务 om_prev）：查完回你/)
      assert.match(prompt, /【bob（QA） 正在进行的事[^\n]*】\n- \d\d:\d\d bot 对他说（ack）：收到/)
      assert.match(prompt, /【最近 7 天这个群里已有的任务】[^\n]*\n- id=om_c 状态=done 摘要=登录白屏/)
      assert.match(prompt, /本条发送人：bob（QA）。/)
      assert.match(prompt, /<<<UNTRUSTED_LARK_MESSAGE\n重跑\n/)
      const bare = buildIntentClassificationPrompt({ text: '', conversation: null })
      assert.match(bare, /<<<UNTRUSTED_LARK_MESSAGE\n（无正文）\n/)
      // 规则里会提到「【默认接着 bot 上一句】」这个标签名，数据块本身以「】bot 」/「正在进行的事（任务」/「【最近 7 天」开头
      const DATA_BLOCKS = /【负责人（aven）的说明|【默认接着 bot 上一句】bot |正在进行的事（任务|【最近 7 天这个群里已有的任务】/
      assert.doesNotMatch(bare, DATA_BLOCKS)
      assert.doesNotMatch(buildIntentClassificationPrompt({ text: 'x', conversation: { anchor: null, activity: null, candidates: [] } }), DATA_BLOCKS)
    }],
    ['runAI 单趟（代答 / 实测契约）：persona 文件进代答提示；envSites 进实测提示', async () => {
      const calls = []
      const exec = async (options) => { calls.push(options); return { executor: 'claude', result: done() } }
      const base = { id: 't-answer', source: 'lark', aiExecutor: 'claude', attachments: [] }
      const ctx = { projectId: 'PR-99999', projectName: '测试项目', projectDocs: [], cwd: tmpdir(), readOnly: true }
      await runAI({ localConfig: { envSites: { test: 'https://test.example.com' } } }, { ...base, text: 'test 和 pre 代码一样吗', contract: { deliverable: 'answer', readOnly: true, expectsCode: false } }, ctx, null, undefined, { exec, snapshot: () => ({ status: '', diff: '' }) })
      assert.equal(calls.length, 1, '代答单趟')
      assert.match(calls[0].promptText, /口吻与取舍按负责人的说明：\n# 口吻\n短句、先结论\n4\. status 一律 done/)
      calls.length = 0
      await runAI({ localConfig: { envSites: { test: 'https://test.example.com' } } }, { ...base, text: '看看 test 能不能注册', contract: { deliverable: 'verification', readOnly: true, expectsCode: false } }, ctx, null, undefined, { exec, snapshot: () => ({ status: '', diff: '' }) })
      assert.equal(calls.length, 1, '实测单趟')
      assert.match(calls[0].promptText, /上下文说哪个环境就测哪个：test https:\/\/test\.example\.com；只打上面这些地址/)
      assert.match(calls[0].promptText, /没有配页面工具/)
      // 测试号 / 造测试数据随本机配置进提示，命令层同口径放开（b3 ep-1024-9ebe13）
      calls.length = 0
      const testConfig = { envSites: { pre: 'https://pre.example.com' }, testAccounts: { pre: { mail: 'qa@x', loginModule: '/m.mjs' } }, testData: { envs: ['pre'] } }
      await runAI({ localConfig: testConfig }, { ...base, text: '创建最新的帖子 进行测试', contract: { deliverable: 'verification', readOnly: true, expectsCode: false, testData: true } }, ctx, null, undefined, { exec, snapshot: () => ({ status: '', diff: '' }) })
      assert.match(calls[0].promptText, /要登录态只用 `node \S+env-login\.mjs --env <环境>`（配了测试号的：pre；[\s\S]*本单对方明确要造测试数据/)
      assert.deepEqual(calls[0].egressTestDataEnvs, ['pre'])
      calls.length = 0
      await runAI({ localConfig: testConfig }, { ...base, text: '问', contract: { deliverable: 'answer', readOnly: true, expectsCode: false } }, ctx, null, undefined, { exec, snapshot: () => ({ status: '', diff: '' }) })
      assert.match(calls[0].promptText, /curl GET \/ env-login 登录）/)
      assert.doesNotMatch(calls[0].promptText, /建测试数据/)
      assert.deepEqual(calls[0].egressTestDataEnvs, [])
      calls.length = 0
      const analysis = { status: 'ready', summary: 's', applicableRules: [], requirements: ['r'], scope: { files: [{ path: 'a.ts', reason: 'r' }] }, blockers: [] }
      const execTwo = async (options) => { calls.push(options); return { executor: 'claude', result: options.resultKind === 'analysis' ? analysis : done() } }
      await runAI({ localConfig: testConfig }, { ...base, text: '写脚本在 pre 造帖', contract: { deliverable: 'change', readOnly: false, expectsCode: true, testData: true } }, { ...ctx, readOnly: false }, null, undefined, { exec: execTwo, snapshot: () => ({ status: '', diff: '' }) })
      assert.match(calls.at(-1).promptText, /本单对方明确要造测试数据[\s\S]*要登录态只用 `node \S+env-login\.mjs/, '改码单同样给造数据与登录口径')
    }],
    ['classifyTaskIntent：分类提示带 persona 与本机配置（发送人按 notifyOpenId / ownerMap 识别）；localConfig 缺省不炸', async () => {
      const calls = []
      const exec = async (options) => { calls.push(options); return { executor: 'claude', result: { decision: 'question', confidence: 'high', summary: 's', reason: 'r' } } }
      const task = { id: 't-cls', text: '你能发邮件吗', attachments: [], operator: 'ou_aven', addressedToBot: true }
      await classifyTaskIntent({ localConfig: { notifyOpenId: 'ou_aven' } }, task, null, undefined, { exec })
      assert.equal(calls[0].resultKind, 'intent')
      assert.match(calls[0].promptText, /本条发送人：aven 本人（负责人）/)
      assert.match(calls[0].promptText, /负责人（aven）的说明[\s\S]*短句、先结论/)
      calls.length = 0
      await classifyTaskIntent({}, task, null, undefined, { exec })
      assert.match(calls[0].promptText, /本条发送人：未登记成员（ou_aven）/)
    }],
  ]).finally(() => rmSync(dir, { recursive: true, force: true })))
})
