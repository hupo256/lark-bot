#!/usr/bin/env node
/**
 * 自修工单（自愈环 2.2，从 falive 移植，aven 2026-10-24）：开单决策与预算、失败剧本接入（onFail）、工单落盘 / 状态流转、
 * 执行器（临时 git 仓 + 假执行器：ready / 越界 / 测试红 / 变异存活 / 只报不改 / 中断）、主循环调度（空闲才跑、一次一张、
 * 排空重启算在飞）、验收命令输出解析、CLI apply / discard（干净能合、冲突 abort、脏工作区拒绝）。不真调 claude。
 *   node --test __tests__/lark-self-fix.test.mjs
 */

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, it } from 'node:test'

import { execAiExecutor } from '../lib/lark-ai-executor.mjs'
import { planDrainRestart } from '../lib/lark-drain-restart.mjs'
import { fingerprintFailure } from '../lib/lark-failure-fingerprint.mjs'
import { countRecentFingerprint, listFailures, recordFailure } from '../lib/lark-failure-ledger.mjs'
import { handleTaskFailure } from '../lib/lark-failure-playbook.mjs'
import {
  SELF_FIX_ACTION,
  SELF_FIX_DAILY_CAP,
  dayKey,
  isTicketId,
  listTickets,
  maybeOpenSelfFix,
  readTicket,
  selfFixBudget,
  selfFixEnabled,
  selfFixIds,
  shouldOpenSelfFix,
  updateTicket,
  writeTicket,
} from '../lib/lark-self-fix.mjs'
import {
  SELF_FIX_MAX_ATTEMPTS,
  SELF_FIX_TIMEOUT_MS,
  buildSelfFixPrompt,
  buildSelfFixReport,
  createSelfFixRunner,
  defaultRunMutate,
  defaultRunTests,
  killOrphanExec,
  outsideAllowedDirs,
  parseRootCauseLayer,
  runCommand,
  verifySelfFix,
} from '../lib/lark-self-fix-run.mjs'
import { applySelfFix, discardSelfFix, formatTicketList, runSelfFixCli } from '../lib/lark-self-fix-cli.mjs'

const task = { id: 'om_1', epoch: 1, text: '修一下资料页金额', project: 'PR-01947' }
const fp = (text) => fingerprintFailure(new Error(text))
const unknown = fp('something nobody has seen')
const RESULT_MISSING = "Claude 未返回合法结构化结果：ENOENT: no such file or directory, open '/tmp/x/result.json'"
const resultMissing = fp(RESULT_MISSING)
const timeout = fp('claude exec timed out after 1800000ms')
const fail = { action: 'fail', reason: 'x' }
const NOON = new Date(2026, 9, 24, 12).getTime()
const quiet = () => {}

const g = (cwd, args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
// 临时仓：<base>/lark-bot（工单 worktree 落在同级 <base>/lark-bot-sf-…），一次提交 lib/a.mjs。
const makeRepo = () => {
  const base = mkdtempSync(join(tmpdir(), 'lark-selffix-'))
  const root = join(base, 'lark-bot')
  mkdirSync(join(root, 'lib'), { recursive: true })
  writeFileSync(join(root, 'lib/a.mjs'), 'export const a = 1\n')
  g(base, ['init', '-q', '-b', 'main', root])
  g(root, ['config', 'user.email', 't@example.com'])
  g(root, ['config', 'user.name', 't'])
  g(root, ['add', '-A'])
  g(root, ['commit', '-q', '-m', 'init'])
  return { base, root, dir: join(base, 'tickets'), ledgerDir: join(base, 'failures'), cleanup: () => rmSync(base, { recursive: true, force: true }) }
}
const open = (repo, { fingerprint = unknown, now = NOON, taskOverride = {} } = {}) =>
  maybeOpenSelfFix({ task: { ...task, ...taskOverride }, error: new Error('boom'), fingerprint, playbook: fail, ledgerDir: repo.ledgerDir, dir: repo.dir, root: repo.root, workerLogPath: null, now, log: quiet })

// 假执行器：在 cwd（工单 worktree）里写文件，返回结构化结果；calls 收集入参。
const fakeExec = ({ files = {}, summary = '[harness] 结果文件路径拼错', status = 'done', calls = [], throws = null, before = null } = {}) => async (options) => {
  calls.push(options)
  if (before) await before(options)
  if (throws) throw throws
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(options.cwd, file)), { recursive: true })
    writeFileSync(join(options.cwd, file), content)
  }
  return { result: { status, summary, checks: ['node scripts/test-all.mjs 绿'], changedFiles: Object.keys(files), warnings: [], blockers: status === 'blocked' ? ['装 lark-cli'] : null } }
}
const ok = (summary) => async () => ({ ok: true, summary })
const red = (summary) => async () => ({ ok: false, summary })

describe('开单决策与预算', () => {
  it('复发 / 未归类 / 重跑也没救才开；硬条件；预算；开关', () => {
    const base = { task, fingerprint: unknown, playbook: fail }
    const cases = [
      [{ task, fingerprint: resultMissing, playbook: fail }, false, /先记台账/],
      [{ task, fingerprint: resultMissing, playbook: fail, recentSameFingerprint: 1 }, true, /^同指纹 7 天内第 2 次$/],
      [{ task, fingerprint: resultMissing, playbook: fail, priorAttempts: 1 }, true, /^自动重跑 1 次仍失败$/],
      [base, true, /^未归类$/],
      [{ ...base, recentSameFingerprint: 2, priorAttempts: 1 }, true, /^同指纹 7 天内第 3 次，未归类，自动重跑 1 次仍失败$/],
      [{ ...base, enabled: false }, false, /关闭/],
      [{ ...base, task: { ...task, source: 'self-fix' } }, false, /不套娃/],
      [{ ...base, playbook: { action: 'requeue' } }, false, /剧本是 requeue/],
      [{ ...base, playbook: undefined }, false, /剧本是 \?/],
      [{ ...base, fingerprint: undefined }, false, /不是失败/],
      [{ ...base, fingerprint: fp('cursor-agent CLI 不可用：spawnSync cursor-agent ENOENT') }, false, /不是 bot 代码能修的/],
      [{ ...base, fingerprint: fp('Claude 未登录 login required') }, false, /不是 bot 代码能修的/],
      [{ task, fingerprint: timeout, playbook: fail }, false, /单次不查/],
      [{ task, fingerprint: timeout, playbook: fail, priorAttempts: 1 }, false, /单次不查/],
      [{ task, fingerprint: timeout, playbook: fail, recentSameFingerprint: 1, priorAttempts: 1 }, true, /^同指纹 7 天内第 2 次$/],
      [{ ...base, openedForFingerprint: 1 }, false, /已开过/],
      [{ ...base, openedToday: SELF_FIX_DAILY_CAP - 1 }, true, /未归类/],
      [{ ...base, openedToday: SELF_FIX_DAILY_CAP }, false, /达上限 3/],
    ]
    for (const [input, open, reason] of cases) {
      const out = shouldOpenSelfFix(input)
      assert.equal(out.open, open, JSON.stringify(out))
      assert.match(out.reason, reason)
    }
    assert.equal(selfFixEnabled({ localConfig: {}, env: {} }), true)
    assert.equal(selfFixEnabled({ localConfig: { selfHeal: { selfFix: false } }, env: {} }), false)
    assert.equal(selfFixEnabled({ localConfig: {}, env: { LARK_SELF_FIX: '0' } }), false)
    assert.equal(dayKey(new Date(2026, 0, 5, 23, 59).getTime()), '20260105')
  })

  it('maybeOpenSelfFix：落 pending 工单 + 台账记 self_fix；同指纹 7 天不再开；每天最多 3 张；复发计数不算 self_fix 行', () => {
    const repo = makeRepo()
    try {
      const logFile = join(repo.base, 'worker.log')
      writeFileSync(logFile, `${Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n')}`)
      const auditContext = { jsonPath: '/a/om_1-e1.json', logPath: '/a/om_1-e1.log' }
      const first = maybeOpenSelfFix({ task, error: new Error('boom at /tmp/x'), fingerprint: unknown, playbook: fail, priorAttempts: 1, recentSameFingerprint: 0, auditContext, ledgerDir: repo.ledgerDir, dir: repo.dir, root: repo.root, workerLogPath: logFile, now: NOON, log: quiet })
      const { id, branch } = selfFixIds({ fingerprint: unknown, now: NOON })
      assert.deepEqual(first, { opened: true, reason: '未归类，自动重跑 1 次仍失败', id })
      assert.match(id, /^sf-20261024-[0-9a-f]{8}$/)
      assert.equal(branch, `lark/self-fix-${unknown.fingerprint.split(':')[1]}-20261024`)
      assert.equal(isTicketId(id), true)
      const ticket = readTicket({ dir: repo.dir, id })
      assert.equal(ticket.status, 'pending')
      assert.equal(ticket.baseHead, g(repo.root, ['rev-parse', 'HEAD']).stdout.trim())
      assert.equal(ticket.worktreePath, join(repo.base, `lark-bot-${id}`))
      assert.equal(ticket.error, 'boom at /tmp/x')
      assert.equal(ticket.auditJsonPath, '/a/om_1-e1.json')
      assert.equal(ticket.auditLogPath, '/a/om_1-e1.log')
      assert.equal(ticket.workerLogPath, logFile)
      assert.equal(ticket.workerLogTail.split('\n').length, 150)
      assert.match(ticket.workerLogTail, /^line 50\n[\s\S]*line 199$/)
      assert.deepEqual(ticket.task, { id: 'om_1', epoch: 1, project: 'PR-01947', text: '修一下资料页金额' })
      assert.deepEqual(listFailures({ dir: repo.ledgerDir }).map((entry) => [entry.action, entry.taskId]), [[SELF_FIX_ACTION, 'om_1']])

      const again = open(repo, { now: NOON + 3600_000, taskOverride: { id: 'om_2' } })
      assert.equal(again.opened, false)
      assert.match(again.reason, /已开过/)
      assert.deepEqual(selfFixBudget({ dir: repo.ledgerDir, fingerprint: unknown.fingerprint, now: NOON }), { openedToday: 1, openedForFingerprint: 1 })
      // 第二天不算「今天」，但同指纹仍在 7 天窗口里；8 天后同指纹可再开
      assert.deepEqual(selfFixBudget({ dir: repo.ledgerDir, fingerprint: unknown.fingerprint, now: NOON + 24 * 3600_000 }), { openedToday: 0, openedForFingerprint: 1 })
      assert.equal(open(repo, { now: NOON + 8 * 24 * 3600_000 }).opened, true)

      for (const n of [2, 3]) assert.equal(open(repo, { fingerprint: fp(`odd failure ${'x'.repeat(n)}`) }).opened, true)
      const capped = open(repo, { fingerprint: fp('another odd failure') })
      assert.deepEqual([capped.opened, capped.id], [false, null])
      assert.match(capped.reason, /今天已开 3 张/)
      // self_fix 行不算复发
      recordFailure({ dir: repo.ledgerDir, taskId: 'om_9', fingerprint: resultMissing, action: SELF_FIX_ACTION, now: NOON })
      assert.equal(countRecentFingerprint({ dir: repo.ledgerDir, fingerprint: resultMissing.fingerprint, now: NOON }), 0)
      // 取不到 HEAD（不是 git 仓）→ 不开
      const noGit = maybeOpenSelfFix({ task, error: 'x', fingerprint: fp('odd failure in no git'), playbook: fail, ledgerDir: join(repo.base, 'l2'), dir: repo.dir, root: join(repo.base, 'nogit'), workerLogPath: null, now: NOON, log: quiet })
      assert.deepEqual([noGit.opened, noGit.id], [false, null])
      assert.match(noGit.reason, /取不到/)
      // 不传 workerLogPath 取 LARK_LOG_FILE（launchd 注入）；error 可以是字符串；没有审计 / 日志就记 null / 空串
      const savedLog = process.env.LARK_LOG_FILE
      process.env.LARK_LOG_FILE = logFile
      try {
        const viaEnv = maybeOpenSelfFix({ task, error: 'plain text error', fingerprint: fp('odd failure via env'), playbook: fail, ledgerDir: join(repo.base, 'l3'), dir: repo.dir, root: repo.root, now: NOON, log: quiet })
        const saved = readTicket({ dir: repo.dir, id: viaEnv.id })
        assert.deepEqual([saved.workerLogPath, saved.error, saved.auditJsonPath, saved.auditLogPath, saved.workerLogTail.split('\n').length], [logFile, 'plain text error', null, null, 150])
      } finally {
        if (savedLog === undefined) delete process.env.LARK_LOG_FILE
        else process.env.LARK_LOG_FILE = savedLog
      }
      const noLog = maybeOpenSelfFix({ task, error: undefined, fingerprint: fp('odd failure no log'), playbook: fail, ledgerDir: join(repo.base, 'l4'), dir: repo.dir, root: repo.root, workerLogPath: join(repo.base, 'missing.log'), now: NOON, log: quiet })
      assert.deepEqual([readTicket({ dir: repo.dir, id: noLog.id }).workerLogTail, readTicket({ dir: repo.dir, id: noLog.id }).error], ['', ''])
    } finally {
      repo.cleanup()
    }
  })

  it('失败剧本接入：直接失败、失败卡发出后才调 onFail（带复发次数与重跑次数）；重排队不调；onFail 抛错不影响', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lark-selffix-ledger-'))
    try {
      const reports = []
      const calls = []
      const client = { releaseTask: async () => true }
      const reportStatus = async (status) => { reports.push(status) }
      const onFail = async (info) => { calls.push({ ...info, reportsBefore: reports.length }) }
      recordFailure({ dir, taskId: 'om_0', fingerprint: unknown, action: 'fail' })
      const out = await handleTaskFailure({ client, task, error: new Error('something nobody has seen'), reportStatus, auditContext: null, dir, onFail })
      assert.equal(out.action, 'fail')
      assert.equal(calls.length, 1)
      assert.deepEqual([calls[0].recentSameFingerprint, calls[0].priorAttempts, calls[0].reportsBefore, calls[0].fingerprint.cls, calls[0].playbook.action], [1, 0, 1, 'unknown', 'fail'])

      const requeued = await handleTaskFailure({ client, task: { ...task, id: 'om_r' }, error: new Error(RESULT_MISSING), reportStatus, auditContext: null, dir, onFail })
      assert.equal(requeued.action, 'requeue')
      assert.equal(calls.length, 1)
      const second = await handleTaskFailure({ client, task: { ...task, id: 'om_r' }, error: new Error(RESULT_MISSING), reportStatus, auditContext: null, dir, onFail })
      assert.equal(second.action, 'fail')
      assert.equal(calls.at(-1).priorAttempts, 1)

      const ignored = await handleTaskFailure({ client, task, error: new Error('claude exec aborted（worker 退出或任务已取消/换代）'), reportStatus, auditContext: null, dir, onFail })
      assert.equal(ignored.action, 'ignore')
      assert.equal(calls.length, 2)

      const thrown = await handleTaskFailure({ client, task, error: new Error('odd'), reportStatus, auditContext: null, dir, onFail: async () => { throw new Error('hook down') } })
      assert.equal(thrown.action, 'fail')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('工单落盘与文案', () => {
  it('状态流转记 history；列表按开单时间；非法 id 读不到；提示词与私信文案', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lark-selffix-store-'))
    try {
      writeTicket({ dir, ticket: { id: 'sf-20261024-bbbbbbbb', status: 'pending', createdAt: '2026-10-24T02:00:00Z', history: [] } })
      writeTicket({ dir, ticket: { id: 'sf-20261024-aaaaaaaa', status: 'pending', createdAt: '2026-10-24T03:00:00Z', history: [] } })
      writeFileSync(join(dir, 'junk.json'), '{bad')
      assert.deepEqual(listTickets({ dir }).map((ticket) => ticket.id), ['sf-20261024-bbbbbbbb', 'sf-20261024-aaaaaaaa'])
      const moved = updateTicket({ dir, id: 'sf-20261024-bbbbbbbb', patch: { status: 'running', attempts: 1 }, note: '第 1 次执行', now: NOON })
      assert.deepEqual(moved.history, [{ at: new Date(NOON).toISOString(), status: 'running', note: '第 1 次执行' }])
      assert.equal(updateTicket({ dir, id: 'sf-20261024-bbbbbbbb', patch: { attempts: 2 }, now: NOON }).history.length, 1)
      assert.equal(updateTicket({ dir, id: 'sf-20261024-cccccccc', patch: { status: 'x' } }), null)
      assert.equal(readTicket({ dir, id: '../etc/passwd' }), null)
      assert.equal(isTicketId('sf-2026-x'), false)
      assert.deepEqual(listTickets({ dir: join(dir, 'missing') }), [])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }

    const ticket = {
      id: 'sf-20261024-abcdef12', branch: 'lark/self-fix-abcdef12-20261024', worktreePath: '/w/lark-bot-sf', baseHead: '0123456789abcdef', trigger: '未归类',
      task: { id: 'om_1', epoch: 1, text: '第一行\n第二行' }, error: 'boom', fingerprint: { cls: 'unknown', fingerprint: 'unknown:abcdef12', label: '未归类的异常' },
      recentSameFingerprint: 1, priorAttempts: 1, auditJsonPath: '/a/x.json', auditLogPath: '/a/x.log', workerLogPath: '/l/worker.log', workerLogTail: 'tail-line',
    }
    const prompt = buildSelfFixPrompt(ticket, { root: '/r/lark-bot', ledgerDir: '/r/failures' })
    assert.match(prompt, /^修复：lark-bot 自身缺陷——未归类的异常（指纹 unknown:abcdef12）\n/)
    assert.match(prompt, /第 2 代/)
    assert.match(prompt, /错误原文：\n```\nboom\n```\n/)
    assert.match(prompt, /7 天内同指纹 2 次；自动重排队 1 次仍失败/)
    assert.match(prompt, /第一行 第二行/)
    assert.match(prompt, /原任务审计 JSON：\/a\/x\.json[\s\S]*事件流：\/a\/x\.log[\s\S]*worker\.log：\/l\/worker\.log[\s\S]*失败台账：\/r\/failures/)
    assert.match(prompt, /\[harness\][\s\S]*\[prompt\][\s\S]*\[env\][\s\S]*\[model\][\s\S]*\[external\]/)
    assert.match(prompt, /docs\/self-fix-log\.md/)
    assert.match(prompt, /mutate\.mjs --diff 0123456789abcdef --lanes 1/)
    assert.match(prompt, /不碰 runtime\/[\s\S]*\/r\/lark-bot\/runtime[\s\S]*不改 rules\/；不 git commit[\s\S]*不 push、不 restart/)
    assert.match(prompt, /tail-line/)
    const bare = buildSelfFixPrompt({ ...ticket, auditJsonPath: null, auditLogPath: null, workerLogPath: null, workerLogTail: '', priorAttempts: 0, task: { id: 'om_1' } })
    assert.doesNotMatch(bare, /审计 JSON|worker\.log：|仍失败|尾部/)
    assert.match(bare, /第 1 代/)

    const ready = buildSelfFixReport({ ...ticket, status: 'ready', layer: 'harness', ai: { summary: '[harness] 路径拼错' }, changedFiles: ['lib/a.mjs', '__tests__/a.test.mjs'], verdict: { tests: { summary: '测试 9 个：通过 9' }, mutate: { summary: '变异 3 个：抓到 3' } }, commit: 'deadbeefcafe' })
    assert.match(ready, /^lark-bot 自修工单 sf-20261024-abcdef12：验收通过，等 apply\n现象：未归类的异常（指纹 unknown:abcdef12；未归类），原任务 om_1\n根因层：harness（bot 自己的代码）。\[harness\] 路径拼错\n改了什么：lib\/a\.mjs、__tests__\/a\.test\.mjs\n测试：测试 9 个：通过 9；变异：变异 3 个：抓到 3\n执行 `lark-bot self-fix apply sf-20261024-abcdef12` 合进运行分支，合进后排空重启自动上线；不要就 `lark-bot self-fix discard sf-20261024-abcdef12`。（分支 lark\/self-fix-abcdef12-20261024，提交 deadbeef）$/)
    const reported = buildSelfFixReport({ ...ticket, status: 'reported', layer: 'env', ai: { summary: '[env] 没装', blockers: ['装 lark-cli'] }, reason: '根因层 env，不改代码' })
    assert.match(reported, /根因层：env（本机环境）[\s\S]*只报不改：根因层 env，不改代码；要人做：装 lark-cli$/)
    assert.match(buildSelfFixReport({ ...ticket, status: 'rejected', reason: '全量单测没过', verdict: { tests: { summary: '红' } } }), /测试：红\n作废原因：全量单测没过。现场与分支已删。$/)
    assert.match(buildSelfFixReport({ ...ticket, status: 'failed', reason: '执行器出错：x' }), /\n出错：执行器出错：x。现场与分支已删。$/)
    assert.match(buildSelfFixReport({ ...ticket, status: 'reported', ai: { summary: '没标层' }, reason: 'r' }), /根因层：未标。没标层\n只报不改：r$/)
    assert.equal(buildSelfFixReport({ ...ticket, status: 'pending' }).split('\n').length, 2)
    const many = buildSelfFixReport({ ...ticket, status: 'rejected', changedFiles: Array.from({ length: 9 }, (_, i) => `lib/${i}.mjs`) })
    assert.match(many, /lib\/7\.mjs 等$/)
    assert.doesNotMatch(many, /lib\/8\.mjs/)
    assert.doesNotMatch(buildSelfFixReport({ ...ticket, status: 'rejected', changedFiles: Array.from({ length: 8 }, (_, i) => `lib/${i}.mjs`) }), / 等/)
  })

  it('根因层解析与改动范围', () => {
    assert.equal(parseRootCauseLayer('[harness] x'), 'harness')
    assert.equal(parseRootCauseLayer('  [Prompt] x'), 'prompt')
    assert.equal(parseRootCauseLayer('x [env]'), null)
    assert.equal(parseRootCauseLayer(undefined), null)
    assert.deepEqual(outsideAllowedDirs(['lib/a.mjs', 'scripts/x', '__tests__/a.test.mjs', 'docs/a.md', 'rules/x.md', 'runtime/a.json', 'lark-worker.mjs', 'libx/a']), ['rules/x.md', 'runtime/a.json', 'lark-worker.mjs', 'libx/a'])
  })
})

describe('执行器（临时 git 仓 + 假执行器）', () => {
  const MUTATE_OK = { ok: true, checked: true, summary: '变异存活 0（2 个变异点：抓到 2，豁免 0）' }
  const runner = (repo, extra = {}) => createSelfFixRunner({ dir: repo.dir, root: repo.root, runTests: ok('测试 3 个：通过 3'), runMutate: async () => MUTATE_OK, log: quiet, now: () => NOON, ...extra })

  it('验收全过 → 本地提交、ready、现场保留、私信带 apply 指令；执行器拿到 worktree / claude 实施模式 / 40 分钟', async () => {
    const repo = makeRepo()
    try {
      const { id } = open(repo)
      const calls = []
      const notes = []
      const r = runner(repo, { exec: fakeExec({ calls, files: { 'lib/a.mjs': 'export const a = 2\n', '__tests__/a.test.mjs': '// t\n', 'docs/self-fix-log.md': '| x |\n' } }), notify: async (text, opts) => { notes.push({ text, opts }) } })
      const ticket = await r.runTicket(readTicket({ dir: repo.dir, id }))
      const path = join(repo.base, `lark-bot-${id}`)
      assert.equal(ticket.status, 'ready')
      assert.equal(ticket.layer, 'harness')
      assert.deepEqual(ticket.ai, { status: 'done', summary: '[harness] 结果文件路径拼错', blockers: [], checks: ['node scripts/test-all.mjs 绿'] })
      assert.deepEqual(ticket.changedFiles, ['__tests__/a.test.mjs', 'docs/self-fix-log.md', 'lib/a.mjs'])
      assert.deepEqual(ticket.verdict, { stage: 'done', tests: { ok: true, summary: '测试 3 个：通过 3' }, mutate: MUTATE_OK })
      assert.deepEqual(ticket.history.map((item) => item.status), ['pending', 'running', 'ready'])
      assert.equal(ticket.attempts, 1)
      assert.equal(calls[0].cwd, path)
      assert.deepEqual([calls[0].executor, calls[0].resultKind, calls[0].timeoutMs, calls[0].readOnly], ['claude', 'task', SELF_FIX_TIMEOUT_MS, undefined])
      assert.equal(SELF_FIX_TIMEOUT_MS, 40 * 60_000)
      assert.equal(calls[0].auditLogPath, join(repo.dir, `${id}.log`))
      // 执行器每起一个子进程就把 pid 记进工单（worker 被 SIGKILL 后 recover 靠它杀孤儿）
      calls[0].onSpawn({ pid: 4242, cmd: 'claude' })
      calls[0].onSpawn({ pid: undefined, cmd: 'claude' })
      assert.equal(readTicket({ dir: repo.dir, id }).execPid, 4242)
      assert.match(calls[0].promptText, new RegExp(`当前目录 ${path}`))
      assert.equal(g(path, ['status', '--porcelain']).stdout, '')
      assert.equal(g(path, ['rev-parse', 'HEAD']).stdout.trim(), ticket.commit)
      assert.match(g(path, ['log', '-1', '--format=%s']).stdout.trim(), /^fix\(self-fix\): \[harness\] 结果文件路径拼错（自修工单 sf-.*，worker 验收：全量单测绿、变异存活 0）$/)
      assert.equal(g(repo.root, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim(), 'main')
      assert.equal(notes.length, 1)
      assert.equal(notes[0].opts.idempotencyKey, `self-fix-${id}-ready`)
      assert.match(notes[0].text, new RegExp(`lark-bot self-fix apply ${id}`))
      assert.match(notes[0].text, /变异：变异存活 0（2 个变异点/)

      // 10-24 沙箱试跑：改动行一个可变异点都没有也算过，私信却写「变异存活 0」。如实写没做变异检查。
      const { id: id2 } = open(repo, { fingerprint: fp('odd failure without operators') })
      const unchecked = { ok: true, checked: false, summary: '改动行没有可变异的运算符（未做变异检查）' }
      const notes2 = []
      const t2 = await runner(repo, { exec: fakeExec({ files: { 'docs/self-fix-log.md': '| y |\n' } }), runMutate: async () => unchecked, notify: async (text) => { notes2.push(text) } }).runTicket(readTicket({ dir: repo.dir, id: id2 }))
      assert.equal(t2.status, 'ready')
      assert.match(g(join(repo.base, `lark-bot-${id2}`), ['log', '-1', '--format=%s']).stdout.trim(), /worker 验收：全量单测绿、改动行没有可变异的运算符，未做变异检查）$/)
      assert.match(notes2[0], /变异：改动行没有可变异的运算符（未做变异检查）/)
      assert.doesNotMatch(notes2[0], /存活 0/)
    } finally {
      repo.cleanup()
    }
  })

  it('验收各闸：越界 / 测试红（不跑变异）/ 变异存活 / 没标层 / 只报层改了文件 / 自报没做完 → rejected，删现场与分支；只报层没改 → reported；执行器出错 → failed', async () => {
    const cases = [
      ['越界', { files: { 'lib/a.mjs': '1\n', 'rules/x.md': 'x\n' } }, {}, 'rejected', /允许范围外的文件：rules\/x\.md/, 'scope'],
      ['测试红', { files: { 'lib/a.mjs': '1\n' } }, { runTests: red('测试 3 个：通过 2，失败 1'), runMutate: async () => assert.fail('测试红不该跑变异') }, 'rejected', /全量单测没过：测试 3 个：通过 2，失败 1/, 'tests'],
      ['变异存活', { files: { 'lib/a.mjs': '1\n' } }, { runMutate: red('变异 2 个：抓到 1，存活 1') }, 'rejected', /变异测试没过：变异 2 个：抓到 1，存活 1/, 'mutate'],
      ['没标层', { files: { 'lib/a.mjs': '1\n' }, summary: '改了一下' }, {}, 'rejected', /没标根因层/, null],
      ['只报层改了文件', { files: { 'lib/a.mjs': '1\n' }, summary: '[env] 没装 CLI' }, {}, 'rejected', /根因层 env 只报不改，却改了文件/, null],
      ['自报没做完', { files: { 'lib/a.mjs': '1\n' }, status: 'blocked' }, {}, 'rejected', /AI 自报 blocked/, null],
      ['只报层没改', { summary: '[external] Lark 接口 500', status: 'blocked' }, {}, 'reported', /根因层 external，不改代码/, null],
      ['可修层没改', { summary: '[prompt] 提示词歧义', status: 'blocked' }, {}, 'reported', /定为 prompt 层但没改代码/, null],
      ['没标层没改', { summary: '看不出来', status: 'blocked' }, {}, 'reported', /根因层 未标/, null],
      ['执行器出错', { throws: new Error('claude exec exited with code 1') }, {}, 'failed', /执行器出错：claude exec exited with code 1/, null],
    ]
    for (const [name, execOptions, extra, status, reason, stage] of cases) {
      const repo = makeRepo()
      try {
        const { id } = open(repo)
        const notes = []
        const ticket = await runner(repo, { exec: fakeExec(execOptions), notify: async (text, opts) => { notes.push(opts.idempotencyKey) }, ...extra }).runTicket(readTicket({ dir: repo.dir, id }))
        assert.equal(ticket.status, status, name)
        assert.match(ticket.reason, reason, name)
        assert.equal(ticket.verdict?.stage ?? null, stage, name)
        assert.equal(existsSync(join(repo.base, `lark-bot-${id}`)), false, name)
        assert.equal(g(repo.root, ['branch', '--list', ticket.branch]).stdout, '', name)
        assert.deepEqual(notes, [`self-fix-${id}-${status}`], name)
        assert.equal(ticket.history.at(-1).note, ticket.reason, name)
        if (status === 'reported' && execOptions.status === 'blocked') assert.deepEqual(ticket.ai.blockers, ['装 lark-cli'], name)
      } finally {
        repo.cleanup()
      }
    }
  })

  it('建 worktree 失败 → failed 带 git 原文；本地提交失败（钩子拒绝）→ rejected 带钩子输出，删现场', async () => {
    const repo = makeRepo()
    try {
      const { id } = open(repo)
      updateTicket({ dir: repo.dir, id, patch: { baseHead: 'f'.repeat(40) } })
      const badBase = await runner(repo, { exec: async () => assert.fail('建不了 worktree 不该调执行器') }).runTicket(readTicket({ dir: repo.dir, id }))
      assert.equal(badBase.status, 'failed')
      assert.match(badBase.reason, /执行器出错：建自修 worktree 失败：fatal: /)

      const { id: id2 } = open(repo, { fingerprint: fp('odd failure at commit') })
      const hook = join(repo.root, '.git', 'hooks', 'pre-commit')
      writeFileSync(hook, '#!/bin/sh\necho "hook says no" >&2\nexit 1\n', { mode: 0o755 })
      const rejected = await runner(repo, { exec: fakeExec({ files: { 'lib/a.mjs': '1\n' } }) }).runTicket(readTicket({ dir: repo.dir, id: id2 }))
      assert.deepEqual([rejected.status, rejected.reason, rejected.verdict.stage], ['rejected', '本地提交失败：hook says no', 'commit'])
      assert.equal(existsSync(join(repo.base, `lark-bot-${id2}`)), false)
    } finally {
      repo.cleanup()
    }
  })

  it('中断：worker 退出 → 退回 pending（不私信）；中断满上限 → failed；启动时把上次跑到一半的退回 pending 并删现场；私信失败不抛', async () => {
    const repo = makeRepo()
    try {
      const { id } = open(repo)
      const controller = new AbortController()
      const notes = []
      const exec = fakeExec({ before: () => controller.abort(), throws: new Error('claude exec aborted') })
      const r = runner(repo, { exec, signal: controller.signal, notify: async (text) => { notes.push(text) } })
      const first = await r.runTicket(readTicket({ dir: repo.dir, id }))
      assert.equal(first, null)
      assert.deepEqual([readTicket({ dir: repo.dir, id }).status, readTicket({ dir: repo.dir, id }).attempts], ['pending', 1])
      assert.equal(notes.length, 0)
      assert.equal(r.maybeStart({}), null) // 已在退出：不再开新的
      const second = await r.runTicket(readTicket({ dir: repo.dir, id }))
      assert.equal(second.status, 'failed')
      assert.match(second.reason, new RegExp(`已中断 ${SELF_FIX_MAX_ATTEMPTS} 次`))
      assert.equal(notes.length, 1)

      // 验收阶段被中断
      const { id: id2 } = open(repo, { fingerprint: fp('odd failure during verify') })
      const c2 = new AbortController()
      const verifyAborted = await runner(repo, { exec: fakeExec({ files: { 'lib/a.mjs': '1\n' } }), signal: c2.signal, runTests: async () => { c2.abort(); return { ok: false, summary: 'killed' } } }).runTicket(readTicket({ dir: repo.dir, id: id2 }))
      assert.equal(verifyAborted, null)
      assert.equal(readTicket({ dir: repo.dir, id: id2 }).status, 'pending')
      assert.equal(existsSync(join(repo.base, `lark-bot-${id2}`)), false)

      // 上个进程跑到一半（worker 被 SIGKILL）：留下 running 工单、现场，和还活着的执行器进程组（10-24 沙箱试跑：成了孤儿）
      const orphanPath = join(repo.base, `lark-bot-${id2}`)
      const orphan = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', `当前目录 ${orphanPath}`], { detached: true, stdio: 'ignore' })
      const decoy = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', 'not-the-ticket'], { detached: true, stdio: 'ignore' })
      const exited = (child) => new Promise((resolve) => child.once('exit', (code, sig) => resolve(sig)))
      const orphanExit = exited(orphan)
      try {
        // 防 pid 复用误杀：进程组里没有命令行含工单 worktree 路径的进程就不杀
        assert.equal(killOrphanExec({ pid: decoy.pid, worktreePath: orphanPath }), false)
        assert.equal(killOrphanExec({ pid: 1, worktreePath: orphanPath }), false)
        assert.equal(killOrphanExec({ pid: undefined, worktreePath: orphanPath }), false)
        assert.equal(killOrphanExec({ pid: orphan.pid, worktreePath: '' }), false)
        assert.equal(killOrphanExec({ pid: orphan.pid, worktreePath: orphanPath, kill: () => { throw new Error('ESRCH') } }), false)
        // pid 守卫独立于 ps 核对：pid 1（kill(-1) = 杀全部）/ 非整数，哪怕 ps 报出了匹配的进程也绝不发信号
        const kills = []
        const spy = (pid, sig) => { kills.push([pid, sig]) }
        const fakePs = (pgid) => () => [{ pid: 7, pgid, command: `claude ${orphanPath}` }]
        assert.equal(killOrphanExec({ pid: 1, worktreePath: orphanPath, ps: fakePs(1), kill: spy }), false)
        assert.equal(killOrphanExec({ pid: undefined, worktreePath: orphanPath, ps: fakePs(undefined), kill: spy }), false)
        assert.equal(killOrphanExec({ pid: 2, worktreePath: orphanPath, ps: fakePs(2), kill: spy }), true)
        assert.deepEqual(kills, [[-2, 'SIGKILL']])
        updateTicket({ dir: repo.dir, id: id2, patch: { status: 'running', attempts: 1, execPid: orphan.pid } })
        g(repo.root, ['worktree', 'add', '-q', '-b', readTicket({ dir: repo.dir, id: id2 }).branch, orphanPath])
        const recoverLogs = []
        runner(repo, { exec: fakeExec(), log: (line) => recoverLogs.push(line), notify: async () => { throw new Error('lark down') } })
        assert.equal(await orphanExit, 'SIGKILL')
        assert.ok(recoverLogs.some((line) => line.includes(`杀掉上次遗留的执行器进程组 ${orphan.pid}`)), recoverLogs.join('\n'))
        assert.equal(decoy.exitCode, null, '无关进程不能被杀')
        assert.equal(decoy.signalCode, null)
      } finally {
        for (const child of [orphan, decoy]) {
          try { process.kill(-child.pid, 'SIGKILL') } catch { /* 已退出 */ }
        }
      }
      assert.equal(readTicket({ dir: repo.dir, id: id2 }).status, 'pending')
      assert.equal(existsSync(join(repo.base, `lark-bot-${id2}`)), false)
      assert.equal(g(repo.root, ['branch', '--list', readTicket({ dir: repo.dir, id: id2 }).branch]).stdout, '')
      updateTicket({ dir: repo.dir, id: id2, patch: { status: 'running', attempts: 2 } })
      createSelfFixRunner({ dir: repo.dir, root: repo.root, enabled: false, log: quiet })
      assert.equal(readTicket({ dir: repo.dir, id: id2 }).status, 'running') // 关着不碰
      runner(repo, { notify: async () => { throw new Error('lark down') } })
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(readTicket({ dir: repo.dir, id: id2 }).status, 'failed')
    } finally {
      repo.cleanup()
    }
  })

  it('主循环调度：有在飞 / 排空中 / 退出中 / 关闭不跑；空闲时一次一张，跑的时候 busy（不领任务）且排空重启算一个在飞', async () => {
    const repo = makeRepo()
    try {
      const a = open(repo)
      const b = open(repo, { fingerprint: fp('second odd failure'), now: NOON + 1000 })
      let release
      const gate = new Promise((resolve) => { release = resolve })
      const calls = []
      const r = runner(repo, { exec: fakeExec({ calls, before: () => gate, summary: '[external] 接口 500', status: 'blocked' }) })
      assert.equal(runner(repo, { enabled: false }).maybeStart({}), null)
      assert.equal(r.maybeStart({ inFlight: 1 }), null)
      assert.equal(r.maybeStart({ draining: true }), null)
      assert.equal(r.maybeStart({ shuttingDown: true }), null)
      assert.deepEqual([r.busy(), r.inFlightCount(), r.current(), r.status()], [false, 0, null, null])
      assert.equal(r.maybeStart({ inFlight: 0 }), a.id)
      assert.deepEqual([r.busy(), r.inFlightCount()], [true, 1])
      // 心跳带上自修状态（10-24 沙箱试跑：自修中 status / doctor 只看到「在飞 0」）
      assert.deepEqual(r.status(), { id: a.id, since: new Date(NOON).toISOString() })
      assert.equal(r.maybeStart({}), null)
      const version = { codeStale: true, diskCodeHash: 'd', diskConfigHash: 'c' }
      assert.equal(planDrainRestart({ version, inFlight: 0 + r.inFlightCount(), state: { draining: true }, now: NOON }).action, 'wait-inflight')
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(calls.length, 1)
      release()
      await r.current()
      assert.deepEqual([r.busy(), r.inFlightCount(), r.status()], [false, 0, null])
      assert.equal(readTicket({ dir: repo.dir, id: a.id }).status, 'reported')
      assert.equal(planDrainRestart({ version, inFlight: 0 + r.inFlightCount(), state: { draining: true }, now: NOON }).action, 'verify')
      assert.equal(r.maybeStart({}), b.id)
      await r.current()
      assert.equal(r.maybeStart({}), null) // 没有待执行的了
      // 未捕获异常不卡住执行器
      const c = open(repo, { fingerprint: fp('third odd failure') })
      const logs = []
      const broken = runner(repo, { exec: fakeExec(), log: (line) => logs.push(line), notify: async () => {} })
      assert.equal(broken.maybeStart({}), c.id)
      rmSync(join(repo.dir, `${c.id}.json`)) // 跑到一半工单文件没了 → 收尾读不到、抛错
      await broken.current()
      assert.equal(broken.busy(), false)
      assert.ok(logs.some((line) => /未捕获异常/.test(line)), logs.join('\n'))
    } finally {
      repo.cleanup()
    }
  })
})

describe('验收命令', () => {
  it('runCommand：退出码、超时杀进程、启动失败；默认测试 / 变异命令摘要行', async () => {
    const node = process.execPath
    assert.deepEqual(await runCommand({ args: ['-e', 'console.log("hi")'], cwd: tmpdir() }), { ok: true, code: 0, timedOut: false, tail: 'hi\n' })
    const failed = await runCommand({ args: ['-e', 'console.error("bad"); process.exit(3)'], cwd: tmpdir() })
    assert.deepEqual([failed.ok, failed.code, failed.tail], [false, 3, 'bad\n'])
    const slow = await runCommand({ args: ['-e', 'setTimeout(() => {}, 60000)'], cwd: tmpdir(), timeoutMs: 100 })
    assert.deepEqual([slow.ok, slow.timedOut], [false, true])
    const controller = new AbortController()
    const aborted = runCommand({ args: ['-e', 'setTimeout(() => {}, 60000)'], cwd: tmpdir(), signal: controller.signal })
    controller.abort()
    assert.equal((await aborted).ok, false)
    const missing = await runCommand({ cmd: '/nonexistent/bin', cwd: tmpdir() })
    assert.equal(missing.ok, false)
    assert.equal(missing.tail, 'spawn /nonexistent/bin ENOENT')
    const big = await runCommand({ args: ['-e', 'process.stdout.write("x".repeat(5000) + "END")'], cwd: tmpdir() })
    assert.equal(big.tail.length, 4000)
    assert.match(big.tail, /END$/)

    const dir = mkdtempSync(join(tmpdir(), 'lark-selffix-cmd-'))
    try {
      mkdirSync(join(dir, 'scripts'))
      const script = (name, body) => writeFileSync(join(dir, 'scripts', name), body)
      script('test-all.mjs', 'console.log(process.argv.slice(2).join(" ")); console.log("测试 3 个：通过 3，失败 0；全量用时 1.0 秒")')
      assert.deepEqual(await defaultRunTests({ cwd: dir }), { ok: true, summary: '测试 3 个：通过 3，失败 0；全量用时 1.0 秒' })
      script('test-all.mjs', 'console.log("✖ a 挂了\\n✖ b 挂了\\n✖ c\\n✖ d\\n测试 4 个：通过 0，失败 4"); process.exit(1)')
      assert.deepEqual(await defaultRunTests({ cwd: dir }), { ok: false, summary: '测试 4 个：通过 0，失败 4；红：✖ a 挂了 / ✖ b 挂了 / ✖ c' })
      script('test-all.mjs', 'process.exit(2)')
      assert.deepEqual(await defaultRunTests({ cwd: dir }), { ok: false, summary: 'exit 2' })
      script('mutate.mjs', 'console.log(process.argv.slice(2).join(" ")); console.log("\\n变异 2 个：抓到 1，豁免 0，存活 1；用时 3 秒\\n  存活 lib/a.mjs:1:1  === → !==  x"); process.exit(1)')
      assert.deepEqual(await defaultRunMutate({ cwd: dir, base: 'abc123' }), { ok: false, checked: true, summary: '变异存活 1（2 个变异点：抓到 1，豁免 0）；存活 lib/a.mjs:1:1  === → !==  x' })
      script('mutate.mjs', 'console.log("\\n变异 3 个：抓到 2，豁免 1，存活 0；用时 3 秒")')
      assert.deepEqual(await defaultRunMutate({ cwd: dir, base: 'abc123' }), { ok: true, checked: true, summary: '变异存活 0（3 个变异点：抓到 2，豁免 1）' })
      script('mutate.mjs', 'console.log(process.argv.slice(2).join(" ") === "--diff abc123 --lanes 1" ? "没有可变异的改动行" : "bad args")')
      assert.deepEqual(await defaultRunMutate({ cwd: dir, base: 'abc123' }), { ok: true, checked: false, summary: '改动行没有可变异的运算符（未做变异检查）' })
      script('mutate.mjs', 'process.exit(2)')
      assert.deepEqual(await defaultRunMutate({ cwd: dir, base: 'abc123' }), { ok: false, checked: false, summary: 'exit 2' })
      // 只有「退出 0 且明说没有可变异的改动行」才算未做变异检查；别的都如实报退出码
      script('mutate.mjs', 'console.log("没有可变异的改动行"); process.exit(2)')
      assert.deepEqual(await defaultRunMutate({ cwd: dir, base: 'abc123' }), { ok: false, checked: false, summary: 'exit 2' })
      script('mutate.mjs', '')
      assert.deepEqual(await defaultRunMutate({ cwd: dir, base: 'abc123' }), { ok: true, checked: false, summary: 'exit 0' })
      // 测试命令带宽松预算参数（不卡 18 秒）
      script('test-all.mjs', 'console.log(process.argv.slice(2).join(" ") === "--budget-ms 120000" ? "测试 1 个：通过 1" : "bad args")')
      assert.equal((await defaultRunTests({ cwd: dir })).summary, '测试 1 个：通过 1')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    assert.deepEqual(await verifySelfFix({ cwd: tmpdir(), base: 'x', changedFiles: ['docs/a.md'], runTests: ok('t'), runMutate: ok('m') }), { ok: true, stage: 'done', reason: '', changedFiles: ['docs/a.md'], tests: { ok: true, summary: 't' }, mutate: { ok: true, summary: 'm' } })
  })

  it('execAiExecutor 的 timeoutMs 覆盖默认超时', async () => {
    const spawnImpl = () => {
      const child = new EventEmitter()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = () => setImmediate(() => child.emit('exit', null))
      return child
    }
    await assert.rejects(execAiExecutor({ executor: 'claude', promptText: 'x', cwd: tmpdir(), localConfig: {}, spawnImpl, timeoutMs: 30 }), /timed out after 30ms/)
  })
})

describe('CLI：lark-bot self-fix', () => {
  // 造一张 ready 工单：在工单 worktree 里提交一处改动（等同执行器验收通过后的状态）。
  const readyTicket = async (repo, files = { 'lib/a.mjs': 'export const a = 2\n' }) => {
    const { id } = open(repo)
    const ticket = await createSelfFixRunner({ dir: repo.dir, root: repo.root, exec: fakeExec({ files }), runTests: ok('t'), runMutate: ok('m'), log: quiet, now: () => NOON }).runTicket(readTicket({ dir: repo.dir, id }))
    assert.equal(ticket.status, 'ready')
    return ticket
  }

  it('apply：干净工作区能合（no-ff、删 worktree 与分支、置 applied）；有冲突 abort 运行目录原样；脏工作区拒绝；非 ready / 非法 id 拒绝', async () => {
    const repo = makeRepo()
    try {
      const ticket = await readyTicket(repo)
      const path = join(repo.base, `lark-bot-${ticket.id}`)
      assert.match(formatTicketList(listTickets({ dir: repo.dir })), new RegExp(`${ticket.id}  验收通过，等 apply  [\\d-]+T[\\d:]+  未归类的异常（unknown:[0-9a-f]{8}）\\n    分支 ${ticket.branch}，执行 lark-bot self-fix apply ${ticket.id}`))

      writeFileSync(join(repo.root, 'lib/a.mjs'), 'dirty\n')
      const dirty = applySelfFix({ dir: repo.dir, root: repo.root, id: ticket.id })
      assert.equal(dirty.ok, false)
      assert.match(dirty.message, /有未提交改动[\s\S]*lib\/a\.mjs/)
      g(repo.root, ['checkout', '--', 'lib/a.mjs'])
      writeFileSync(join(repo.root, 'untracked.txt'), 'x') // 未跟踪文件不算脏

      const merged = applySelfFix({ dir: repo.dir, root: repo.root, id: ticket.id, now: NOON })
      assert.equal(merged.ok, true, merged.message)
      assert.match(merged.message, /合进 main/)
      assert.equal(readFileSync(join(repo.root, 'lib/a.mjs'), 'utf8'), 'export const a = 2\n')
      assert.equal(g(repo.root, ['rev-list', '--parents', '-1', 'HEAD']).stdout.trim().split(' ').length, 3) // no-ff 合并提交
      assert.match(g(repo.root, ['log', '-1', '--format=%s']).stdout, new RegExp(`merge: 自修工单 ${ticket.id}`))
      assert.equal(existsSync(path), false)
      assert.equal(g(repo.root, ['branch', '--list', ticket.branch]).stdout, '')
      const applied = readTicket({ dir: repo.dir, id: ticket.id })
      assert.deepEqual([applied.status, applied.mergedInto, applied.mergedAs], ['applied', 'main', g(repo.root, ['rev-parse', 'HEAD']).stdout.trim()])
      assert.match(applySelfFix({ dir: repo.dir, root: repo.root, id: ticket.id }).message, /已合进运行分支」，只有验收通过的能 apply/)
      assert.match(applySelfFix({ dir: repo.dir, root: repo.root, id: '../x' }).message, /工单 id 不对：\.\.\/x/)
      assert.match(applySelfFix({ dir: repo.dir, root: repo.root, id: undefined }).message, /工单 id 不对：\(空\)/)
      assert.match(applySelfFix({ dir: repo.dir, root: repo.root, id: 'sf-20261024-00000000' }).message, /没有工单/)
    } finally {
      repo.cleanup()
    }

    const conflictRepo = makeRepo()
    try {
      const ticket = await readyTicket(conflictRepo)
      writeFileSync(join(conflictRepo.root, 'lib/a.mjs'), 'export const a = 3\n')
      g(conflictRepo.root, ['commit', '-qam', 'main 也改了'])
      const head = g(conflictRepo.root, ['rev-parse', 'HEAD']).stdout.trim()
      const out = applySelfFix({ dir: conflictRepo.dir, root: conflictRepo.root, id: ticket.id })
      assert.equal(out.ok, false)
      assert.match(out.message, /合并失败，已 abort，运行目录保持原样。冲突文件：lib\/a\.mjs\n工单仍是 ready/)
      assert.equal(g(conflictRepo.root, ['rev-parse', 'HEAD']).stdout.trim(), head)
      assert.equal(g(conflictRepo.root, ['status', '--porcelain']).stdout, '')
      assert.equal(readTicket({ dir: conflictRepo.dir, id: ticket.id }).status, 'ready')
      assert.equal(existsSync(join(conflictRepo.base, `lark-bot-${ticket.id}`)), true)
      // 分支没了（非冲突的合并失败）也 abort 并报原文
      g(conflictRepo.root, ['worktree', 'remove', '--force', join(conflictRepo.base, `lark-bot-${ticket.id}`)])
      g(conflictRepo.root, ['branch', '-D', ticket.branch])
      const gone = applySelfFix({ dir: conflictRepo.dir, root: conflictRepo.root, id: ticket.id })
      assert.equal(gone.ok, false)
      assert.match(gone.message, /合并失败，已 abort[\s\S]*(not something we can merge|merge)/i)
    } finally {
      conflictRepo.cleanup()
    }
  })

  it('discard 与命令行入口：删 worktree 与分支、置 discarded；执行中 / 已合 / 已丢弃不能 discard；list / usage', async () => {
    const repo = makeRepo()
    try {
      const ticket = await readyTicket(repo)
      const out = runSelfFixCli(['discard', ticket.id], { dir: repo.dir, root: repo.root })
      assert.equal(out.code, 0, out.out)
      assert.match(out.out, /已丢弃/)
      assert.equal(existsSync(join(repo.base, `lark-bot-${ticket.id}`)), false)
      assert.equal(g(repo.root, ['branch', '--list', ticket.branch]).stdout, '')
      assert.equal(readTicket({ dir: repo.dir, id: ticket.id }).status, 'discarded')
      for (const status of ['discarded', 'running', 'applied']) {
        updateTicket({ dir: repo.dir, id: ticket.id, patch: { status } })
        const refused = discardSelfFix({ dir: repo.dir, root: repo.root, id: ticket.id })
        assert.equal(refused.ok, false, status)
        assert.match(refused.message, /不能 discard/)
      }
      assert.match(discardSelfFix({ dir: repo.dir, root: repo.root, id: 'nope' }).message, /工单 id 不对/)
      updateTicket({ dir: repo.dir, id: ticket.id, patch: { status: 'rejected', reason: '全量单测没过' } })
      const list = runSelfFixCli(['list'], { dir: repo.dir, root: repo.root })
      assert.equal(list.code, 0)
      assert.match(list.out, /验收不过，已作废[\s\S]*\n    全量单测没过$/)
      assert.equal(runSelfFixCli(['apply', ticket.id], { dir: repo.dir, root: repo.root }).code, 1)
      assert.deepEqual(runSelfFixCli(['list'], { dir: join(repo.base, 'none'), root: repo.root }), { code: 0, out: '没有自修工单' })
      assert.deepEqual(runSelfFixCli([], { dir: repo.dir, root: repo.root }), { code: 1, out: 'usage: lark-bot self-fix {list|apply <id>|discard <id>}' })
      updateTicket({ dir: repo.dir, id: ticket.id, patch: { status: 'pending', reason: null } })
      assert.match(formatTicketList(listTickets({ dir: repo.dir })), /待执行  [\d-]+T[\d:]+  未归类的异常（unknown:[0-9a-f]{8}）$/)
    } finally {
      repo.cleanup()
    }
  })
})
