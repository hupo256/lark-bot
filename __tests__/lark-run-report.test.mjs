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
const { ANSWER_MODE_BLOCK, DELIVER_NOW_RULE, VERIFICATION_MODE_BLOCK, buildCarryOverBlock, buildEnvProbeRule } = await import('../lib/lark-worker-modes.mjs')
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
      assert.deepEqual(runEvidenceFor({ aiRun, cwd: '/tmp/proj', verify: { probeCommand: 'node scripts/probe.mjs' }, claudeHome: home }), { probeCalls: 2, browserCalls: 1, hosts: [] })
      assert.deepEqual(runEvidenceFor({ aiRun, cwd: '/tmp/proj', verify: null, claudeHome: home }), { probeCalls: 0, browserCalls: 1, hosts: [] }, '没配探针脚本就只认 curl / wget 直连')
      assert.deepEqual(runEvidenceFor({ aiRun, cwd: '/tmp/proj', verify: { probeCommand: 'node scripts/probe.mjs', browserPattern: 'verify-page\\.mjs' }, claudeHome: home }), { probeCalls: 2, browserCalls: 1, hosts: [] })
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
      for (const block of [ANSWER_MODE_BLOCK({}), ANSWER_MODE_BLOCK({}, { persona: '短句' }), VERIFICATION_MODE_BLOCK({}), VERIFICATION_MODE_BLOCK({}, { hasPageTool: true })]) assert.ok(block.endsWith(`\n${DELIVER_NOW_RULE}`))
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
      ], ({ task, verification = false, want }) => {
        assert.equal(buildCarryOverBlock(task, { verification }), want)
        const ctx = { projectId: 'PR-99999', projectName: 't', projectDocs: [], cwd: '/tmp/repo' }
        const full = { id: 't', attachments: [], chatId: 'oc', text: '测试的tid 发出来', ...task }
        for (const [contract, carried] of [[{ v: 1, deliverable: 'answer', readOnly: true, expectsCode: false }, true], [{ v: 1, deliverable: 'verification', readOnly: false, expectsCode: false }, true], [{ v: 1, deliverable: 'change', readOnly: false, expectsCode: true }, false]]) {
          const { user } = buildTaskPromptParts(ctx, { ...full, contract, intake: { ...full.intake, classification: { decision: 'bug', ...full.intake?.classification } } }, 'claude', { ruleContext: { text: '', sources: [] } })
          const block = buildCarryOverBlock(full, { verification: contract.deliverable === 'verification' })
          if (want) assert.equal(user.includes(`\n${block}\n`), carried, `${contract.deliverable}：${carried ? '要带' : '不带'}`)
          assert.equal(['群里已先回了一句', '本条接着任务', '本单上一轮'].some((line) => user.includes(line)), carried && Boolean(want))
          assert.equal(user.includes('curl GET / 登录 POST'), contract.deliverable === 'verification', '只有实测放开登录 POST（aven 11-04）')
        }
      })
    }],
    ['buildEnvProbeRule：只认非空字符串地址；一个都没有就说明没配环境地址；只放开登录 POST（aven 11-04）', () => {
      assert.match(buildEnvProbeRule({ test: 'https://test.example.com', pre: ' ', uat: 5, online: null }), /上下文说哪个环境就测哪个：test https:\/\/test\.example\.com。.*只发 GET，唯一例外是为拿登录态（token \/ cookie）发登录 POST；不注册、不下单、不改任何数据。$/)
      assert.match(buildEnvProbeRule({ test: 'https://t', pre: 'https://p' }), /test https:\/\/t、pre https:\/\/p/)
      for (const sites of [null, {}, { pre: 7 }, { pre: '  ' }]) assert.match(buildEnvProbeRule(sites), /^环境实测：本仓没有配环境地址/)
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
      assert.match(calls[0].promptText, /上下文说哪个环境就测哪个：test https:\/\/test\.example\.com。/)
      assert.match(calls[0].promptText, /没有配页面工具/)
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
