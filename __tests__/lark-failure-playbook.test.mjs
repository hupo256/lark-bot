/**
 * 自愈环 2（从 falive 移植，aven 2026-10-24）：失败指纹 / 剧本 / 台账 / 失败卡旁证，以及 task-runner 失败分支的接入层
 *（handleTaskFailure：可重排队的类重领一次、第二次直接失败、失败卡第 3 行归类第 4 行旁证；开关关掉回到原格式）。
 * 指纹分类用 falive worker.log 10-13 ~ 10-15 的真实错误形状回归（报错文本出自本仓同一批模块）。
 *   node --test __tests__/lark-failure-playbook.test.mjs
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  FAILURE_CLASSES,
  NOT_FAILURE_CLASSES,
  REQUEUE_CLASSES,
  buildSelfHealHint,
  decideFailurePlaybook,
  fingerprintFailure,
  formatFingerprintLine,
  normalizeFailureText,
} from '../lib/lark-failure-fingerprint.mjs'
import { FAILURE_LEDGER_KEY, countRecentFingerprint, listFailures, recordFailure, selfHealAttemptsForTask, summarizeFailures } from '../lib/lark-failure-ledger.mjs'
import { collectFailureEvidence, formatFailureEvidence, readFailureEvidence } from '../lib/lark-failure-evidence.mjs'
import { failurePlaybookEnabled, handleTaskFailure, selfHealHintFor } from '../lib/lark-failure-playbook.mjs'
import { buildFailureResult } from '../lib/lark-worker-results.mjs'
import { runAI } from '../lib/lark-worker-run.mjs'

const REAL = {
  resultMissing: "Claude 未返回合法结构化结果：ENOENT: no such file or directory, open '/var/folders/07/f0k63_dx0yb54r7bk3dx0ddr0000gp/T/lark-claude-result-wiD91Q/result.json'",
  ruleContext: '[VERIFY-RULE-004] 规则上下文构建失败：缺失常驻硬规则 common/rules/rule-router.md### 2. 常驻硬规则，拒绝使用不完整规则执行',
  exit1: 'claude exec exited with code 1',
  aborted: 'claude exec aborted（worker 退出或任务已取消/换代）',
  timeout: 'pi exec timed out after 1800000ms',
  cursorTransient: 'cursor exec exited with code 1：pi5.cursor.sh (attempt 5)...',
  staleEpoch: 'POST /lark/tasks/om_x100b62/status failed: 409 {"ok":false,"code":409,"error":"stale epoch: got 2"}',
  resultInvalid: 'Cursor 根因在 cross-boundary（后端/跨层），不能标 taskState=completed 关单：请改用 awaiting_owner_fix，并在 blockers 列出已转交后端的缺陷项',
  toolMissing: 'cursor-agent CLI 不可用：spawnSync cursor-agent ENOENT',
  readonly: 'claude 分析阶段违反只读约束：git status/diff 在分析前后发生变化，已停止实施',
  // fameex 本仓的报错形状
  worktreeIdentity: 'worktree 身份校验失败：当前分支 main 与期望 hotfix/PR-1-x 不一致',
  qualityGate: '终检未通过：tsc 报 3 处错误',
  login: 'Claude 未登录 login required',
}
const tempDir = (prefix) => mkdtempSync(join(tmpdir(), prefix))
const task = { id: 'om_task1', epoch: 1, text: '修一下资料页的金额显示' }

describe('失败指纹', () => {
  it('真实错误各归其类；实例差异归一；未知不重排队；类别常量与规则一致', () => {
    const expected = {
      resultMissing: 'result_missing', ruleContext: 'rule_context', exit1: 'exec_exit', aborted: 'aborted', timeout: 'timeout',
      cursorTransient: 'transient_api', staleEpoch: 'stale_epoch', resultInvalid: 'result_invalid', toolMissing: 'tool_missing', readonly: 'readonly_violation',
      worktreeIdentity: 'git', qualityGate: 'quality_gate', login: 'permission',
    }
    for (const [key, cls] of Object.entries(expected)) {
      const fp = fingerprintFailure(new Error(REAL[key]))
      assert.equal(fp.cls, cls, key)
      assert.equal(fp.requeue, REQUEUE_CLASSES.includes(cls), key)
      assert.match(fp.fingerprint, new RegExp(`^${cls}:[0-9a-f]{8}$`), key)
    }
    assert.deepEqual([...REQUEUE_CLASSES].sort(), ['exec_exit', 'git', 'readonly_violation', 'result_invalid', 'result_missing', 'transient_api'])
    assert.deepEqual(NOT_FAILURE_CLASSES, ['stale_epoch', 'aborted'])
    assert.equal(FAILURE_CLASSES.at(-1), 'unknown')
    assert.equal(FAILURE_CLASSES.length, 14)

    const a = fingerprintFailure(REAL.resultMissing)
    const b = fingerprintFailure(REAL.resultMissing.replace('wiD91Q', 'Ab12Cd').replace('07/f0k63', '99/zzz'))
    assert.equal(a.fingerprint, b.fingerprint)
    assert.equal(normalizeFailureText('timed out after 1800000ms on om_x100b62 at 2026-10-15T13:09:01.123Z'), 'timed out after #ms on <id> at <ts>')
    assert.notEqual(fingerprintFailure('claude exec timed out after 1800000ms').fingerprint, fingerprintFailure('pi exec timed out after 1800000ms').fingerprint)

    const unknown = fingerprintFailure(new Error('something odd happened'))
    assert.deepEqual([unknown.cls, unknown.requeue, unknown.label, unknown.nextStep], ['unknown', false, '未归类的异常', '看审计日志定位'])
    assert.equal(fingerprintFailure(null).cls, 'unknown')
    // 原文与归一后的文本任一命中即可：409 只在原文里（归一后数字变 #）
    assert.equal(fingerprintFailure('POST /lark/tasks/x/status failed: 409 conflict').cls, 'stale_epoch')
  })

  it('非零退出只看前缀：尾巴里的 token / git 不带偏；尾巴或 error.transient 是瞬时错误才改判 transient_api；预算到点按 timeout', () => {
    const tail = 'claude exec exited with code 1：... "inputTokens": 1200 ... git diff --stat'
    assert.equal(fingerprintFailure(new Error(tail)).cls, 'exec_exit')
    assert.equal(fingerprintFailure(new Error(tail)).fingerprint, fingerprintFailure(new Error('claude exec exited with code 1：别的尾巴')).fingerprint)
    assert.equal(fingerprintFailure(new Error('claude exec exited with code 1：API Error: 529 overloaded')).cls, 'transient_api')
    assert.equal(fingerprintFailure(Object.assign(new Error('claude exec exited with code 1：尾巴'), { transient: true })).cls, 'transient_api')
    // 没有尾巴时 error.transient 不改判（前缀就是全部，没有可疑尾巴）
    assert.equal(fingerprintFailure(Object.assign(new Error('claude exec exited with code 1'), { transient: true })).cls, 'exec_exit')
    // 非 exec_exit 的前缀，尾巴有瞬时字样也不改判
    assert.equal(fingerprintFailure(new Error('worktree add 失败 exec exited with code 1：429')).cls, 'git')
    const deadline = fingerprintFailure(new Error(REAL.aborted), { deadlineExceeded: true })
    assert.deepEqual([deadline.cls, deadline.requeue], ['timeout', false])
  })
})

describe('失败剧本与失败卡', () => {
  it('可重排队首次 requeue、再次 fail；不可重排队直接 fail；换代 / 中断 ignore；7 天同指纹算复发、卡上写第几次', () => {
    const rm = fingerprintFailure(REAL.resultMissing)
    assert.deepEqual(decideFailurePlaybook({ fingerprint: rm }), { action: 'requeue', reason: '模型没写结果文件：自动重排队（第 1/1 次）', recurring: false })
    const second = decideFailurePlaybook({ fingerprint: rm, priorAttempts: 1 })
    assert.deepEqual(second, { action: 'fail', reason: '模型没写结果文件：已自动重跑 1 次仍失败', recurring: false })
    assert.equal(formatFingerprintLine({ fingerprint: rm, playbook: second }), `失败归类：模型没写结果文件，已自动重跑 1 次仍失败，指纹 ${rm.fingerprint}`)
    assert.equal(decideFailurePlaybook({ fingerprint: rm, priorAttempts: 1, maxRequeue: 2 }).action, 'requeue')
    assert.deepEqual(decideFailurePlaybook({ fingerprint: fingerprintFailure(REAL.timeout) }), { action: 'fail', reason: '执行超时 / 卡死', recurring: false })
    assert.equal(decideFailurePlaybook({ fingerprint: fingerprintFailure(REAL.staleEpoch) }).action, 'ignore')
    assert.equal(decideFailurePlaybook({ fingerprint: fingerprintFailure(REAL.aborted), recentSameFingerprint: 1 }).recurring, true)

    const fp = fingerprintFailure(REAL.ruleContext)
    const playbook = decideFailurePlaybook({ fingerprint: fp, recentSameFingerprint: 15 })
    assert.equal(playbook.recurring, true)
    assert.equal(formatFingerprintLine({ fingerprint: fp, playbook, recentSameFingerprint: 15 }), `失败归类：规则文件缺失（bot 自己的环境），同一种错 7 天内第 16 次，指纹 ${fp.fingerprint}`)
    assert.equal(formatFingerprintLine({ fingerprint: fp, playbook: decideFailurePlaybook({ fingerprint: fp }) }), `失败归类：规则文件缺失（bot 自己的环境），指纹 ${fp.fingerprint}`)
  })

  it('失败卡：归类固定第 3 行、旁证第 4 行；都不传与原格式一致', () => {
    const error = new Error(REAL.ruleContext)
    const full = buildFailureResult(task, error, { fingerprintLine: '失败归类：X，指纹 y', evidenceLine: '旁证：无' })
    assert.match(full, /^处理失败。\n1\. 任务：修一下资料页的金额显示；\n2\. 失败类型：[^\n]+；\n3\. 失败归类：X，指纹 y；\n4\. 旁证：无；\n5\. 下一步：[^\n]+。\n6\. 错误：\[VERIFY-RULE-004\]/)
    const plain = buildFailureResult(task, error)
    assert.match(plain, /^处理失败。\n1\. 任务：[^\n]+；\n2\. 失败类型：[^\n]+；\n3\. 下一步：[^\n]+。\n4\. 错误：/)
    assert.doesNotMatch(buildFailureResult(task, ''), /错误：/)
  })

  it('重领提示：按上次类别给一句针对性提示；没有记录返回 null', () => {
    assert.equal(buildSelfHealHint([]), null)
    assert.match(buildSelfHealHint([{ cls: 'result_missing', label: '模型没写结果文件' }]), /上一次失败了（模型没写结果文件）[\s\S]*第 2 次执行[\s\S]*不要放后台/)
    assert.match(buildSelfHealHint([{ cls: 'result_invalid', message: 'checks 必须是字符串数组' }]), /上一次失败了（result_invalid）[\s\S]*checks 必须是字符串数组/)
    assert.match(buildSelfHealHint([{ cls: 'readonly_violation' }]), /分析阶段只读/)
    assert.equal(buildSelfHealHint([{ cls: 'git', label: 'git / worktree' }]).split('\n').length, 1)
  })
})

describe('失败台账', () => {
  it('默认一本 fameex.jsonl：本任务重排队次数 / 同指纹 7 天复发计数（只数 fail / requeue）/ 汇总；坏行跳过', () => {
    const dir = tempDir('lark-failures-')
    try {
      const fp = fingerprintFailure(REAL.resultMissing)
      const now = Date.parse('2026-10-24T08:00:00Z')
      const entry = recordFailure({ dir, taskId: 'om_1', epoch: 1, fingerprint: fp, action: 'requeue', reason: 'r', message: 'x'.repeat(400), now })
      assert.deepEqual({ ...entry, message: entry.message.length }, { at: '2026-10-24T08:00:00.000Z', repo: 'fameex', taskId: 'om_1', epoch: 1, cls: 'result_missing', fingerprint: fp.fingerprint, label: '模型没写结果文件', action: 'requeue', reason: 'r', recurring: false, message: 300 })
      assert.equal(FAILURE_LEDGER_KEY, 'fameex')
      assert.ok(existsSync(join(dir, 'fameex.jsonl')))
      recordFailure({ dir, taskId: 'om_1', epoch: 2, fingerprint: fp, action: 'fail', now: now + 60_000 })
      recordFailure({ dir, taskId: 'om_2', fingerprint: fingerprintFailure(REAL.staleEpoch), action: 'ignore', now: now + 120_000 })
      recordFailure({ dir, taskId: 'om_3', fingerprint: fp, action: 'self_fix', now: now + 130_000 })
      recordFailure({ dir, taskId: 'om_4', fingerprint: fp, action: 'fail', now: now - 10 * 24 * 60 * 60_000 })
      recordFailure({ dir, taskId: 'om_5', action: 'fail', now: now + 140_000 })
      writeFileSync(join(dir, 'fameex.jsonl'), `${readFileSync(join(dir, 'fameex.jsonl'), 'utf8')}{坏行\n`)
      assert.equal(recordFailure({ dir, repo: 'other', taskId: 'om_9', fingerprint: fp, action: 'fail', now }).repo, 'other')
      assert.equal(recordFailure({ dir: join(dir, 'x'), repo: null, taskId: 'om_n', action: 'fail', now }).repo, 'fameex')
      assert.ok(existsSync(join(dir, 'x', 'fameex.jsonl')))

      assert.equal(selfHealAttemptsForTask({ dir, taskId: 'om_1', now: now + 200_000 }).length, 1)
      assert.equal(selfHealAttemptsForTask({ dir, taskId: 'om_2', now: now + 200_000 }).length, 0)
      assert.equal(selfHealAttemptsForTask({ dir, taskId: 'om_1', now: now + 31 * 24 * 60 * 60_000 }).length, 0)
      assert.equal(countRecentFingerprint({ dir, repo: 'fameex', fingerprint: fp.fingerprint, now: now + 200_000 }), 2)
      assert.equal(countRecentFingerprint({ dir, fingerprint: fp.fingerprint, now: now + 200_000 }), 3)
      assert.equal(listFailures({ dir, repo: 'fameex' }).length, 6)
      assert.deepEqual(listFailures({ dir }).map((item) => item.taskId), ['om_4', 'om_1', 'om_9', 'om_1', 'om_2', 'om_3', 'om_5'])
      assert.equal(listFailures({ dir, sinceMs: now + 100_000 }).length, 3)
      assert.equal(listFailures({ dir, sinceMs: now + 120_000 }).length, 3)
      const summary = summarizeFailures({ dir, repo: 'fameex', now: now + 200_000 })
      assert.deepEqual(summary, { total: 4, byClass: { result_missing: 3, unknown: 1 }, recurring: [{ fingerprint: fp.fingerprint, count: 3 }], healed: 1 })
      // 同指纹恰好 2 次就算复发
      const rc = fingerprintFailure(REAL.ruleContext)
      recordFailure({ dir, repo: 'pair', taskId: 'p1', fingerprint: rc, action: 'fail', now })
      recordFailure({ dir, repo: 'pair', taskId: 'p2', fingerprint: rc, action: 'fail', now })
      assert.deepEqual(summarizeFailures({ dir, repo: 'pair', now: now + 1000 }).recurring, [{ fingerprint: rc.fingerprint, count: 2 }])
      assert.deepEqual(listFailures({ dir: join(dir, 'nope') }), [])
      assert.deepEqual(summarizeFailures({ dir: join(dir, 'nope') }), { total: 0, byClass: {}, recurring: [], healed: 0 })
      // 写不进去（目录被同名文件占住）不抛，只告警
      const blocked = join(dir, 'blocked')
      writeFileSync(blocked, '')
      assert.equal(recordFailure({ dir: blocked, taskId: 'om_x', action: 'fail' }).taskId, 'om_x')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('失败卡旁证（fameex：阶段 / 工作区 / 本任务新提交，不查发件簿）', () => {
  it('纯函数：各种组合的旁证句；没读到就明说无', () => {
    const cases = [
      [{}, []],
      [{ phase: 'analyzing', changedFiles: [] }, ['失败时还在只读分析阶段（没动代码）', '工作区无改动、无新提交']],
      [{ phase: 'triaging' }, ['失败时还在分诊阶段（没动代码）']],
      [{ phase: 'started', changedFiles: ['a.ts'] }, ['工作区有 1 个文件未提交（a.ts，现场已保留）']],
      [{ phase: 'implementing', changedFiles: ['a.ts', 'b.ts', 'c.ts', 'd.ts'] }, ['失败时已在实施阶段（分析已跑完）', '工作区有 4 个文件未提交（a.ts、b.ts、c.ts 等，现场已保留）']],
      [{ changedFiles: ['a.ts', 'b.ts', 'c.ts'] }, ['工作区有 3 个文件未提交（a.ts、b.ts、c.ts，现场已保留）']],
      [{ changedFiles: [], newCommits: 2, latestCommit: 'fix: x' }, ['本任务开工后分支上多了 2 个提交（最新「fix: x」）']],
    ]
    for (const [input, lines] of cases) assert.deepEqual(collectFailureEvidence(input).lines, lines, JSON.stringify(input))
    assert.equal(formatFailureEvidence({ lines: [] }), '旁证：无（没读到阶段与工作区信息）')
    assert.equal(formatFailureEvidence(null), '旁证：无（没读到阶段与工作区信息）')
    assert.equal(formatFailureEvidence({ lines: ['甲', '乙'] }), '旁证：甲；乙')
  })

  it('读真实 git：未提交改动、开工后新提交；只读任务 / 目录不在不看工作区', () => {
    const repo = tempDir('lark-evidence-')
    const git = (...args) => spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8' })
    try {
      git('init', '-q')
      writeFileSync(join(repo, 'a.txt'), '1\n')
      git('add', '-A')
      git('commit', '-qm', 'base')
      const base = git('rev-parse', 'HEAD').stdout.trim()
      assert.deepEqual(readFailureEvidence({ cwd: repo, sinceHeadSha: base, phase: 'implementing' }).lines, ['失败时已在实施阶段（分析已跑完）', '工作区无改动、无新提交'])
      writeFileSync(join(repo, 'a.txt'), '2\n')
      writeFileSync(join(repo, '新文件.txt'), 'x\n')
      assert.deepEqual(readFailureEvidence({ cwd: repo, sinceHeadSha: base }).lines, ['工作区有 2 个文件未提交（a.txt、新文件.txt，现场已保留）'])
      git('add', '-A')
      git('commit', '-qm', 'AI 自己提交了')
      assert.deepEqual(readFailureEvidence({ cwd: repo, sinceHeadSha: base }).lines, ['本任务开工后分支上多了 1 个提交（最新「AI 自己提交了」）'])
      assert.deepEqual(readFailureEvidence({ cwd: repo }).lines, ['工作区无改动、无新提交'])
      assert.deepEqual(readFailureEvidence({ cwd: repo, sinceHeadSha: 'deadbeef' }).lines, ['工作区无改动、无新提交'])
      writeFileSync(join(repo, 'a.txt'), '3\n')
      assert.deepEqual(readFailureEvidence({ cwd: repo, sinceHeadSha: base, phase: 'analyzing', readOnly: true }).lines, ['失败时还在只读分析阶段（没动代码）'])
      assert.deepEqual(readFailureEvidence({ cwd: join(repo, 'nope'), phase: 'analyzing' }).lines, ['失败时还在只读分析阶段（没动代码）'])
      assert.deepEqual(readFailureEvidence({ cwd: '', phase: 'analyzing' }).lines, ['失败时还在只读分析阶段（没动代码）'])
      assert.deepEqual(readFailureEvidence().lines, [])
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe('接入：handleTaskFailure（task-runner 失败分支）', () => {
  const harness = ({ release = async () => ({ ok: true }) } = {}) => {
    const reports = []
    const releases = []
    return {
      reports,
      releases,
      client: { releaseTask: async (id) => { releases.push(id); return release(id) } },
      reportStatus: async (status, result) => { reports.push({ status, result }) },
    }
  }

  it('可重排队的类：第一次交还队列不发卡、重领带提示；第二次直接失败，卡上第 3 行归类、第 4 行旁证；第二条任务同指纹算复发', async () => {
    const dir = tempDir('lark-playbook-')
    try {
      const h = harness()
      const error = new Error(REAL.resultMissing)
      const auditContext = { jsonPath: join(dir, 'audit.json'), record: {} }
      assert.equal(selfHealHintFor({ task, auditContext, dir }), null)

      const first = await handleTaskFailure({ ...h, task, error, auditContext, dir, collectEvidence: () => assert.fail('重排队不收旁证') })
      assert.equal(first.action, 'requeue')
      assert.deepEqual(h.releases, ['om_task1'])
      assert.deepEqual(h.reports, [])
      assert.deepEqual(listFailures({ dir }).map((item) => item.action), ['requeue'])
      assert.equal(auditContext.record.status, 'self_heal_requeued')
      assert.equal(auditContext.record.failurePlaybook.action, 'requeue')

      const hint = selfHealHintFor({ task, auditContext, dir })
      assert.match(hint, /^【自动重跑】这条任务上一次失败了（模型没写结果文件），这是自动重排队后的第 2 次执行。\n上次没有把结果文件写出来/)
      assert.equal(auditContext.record.selfHealAttempts[0].cls, 'result_missing')
      assert.equal(selfHealHintFor({ task, auditContext, dir, enabled: false }), null)

      const second = await handleTaskFailure({ ...h, task: { ...task, epoch: 2 }, error, auditContext, dir, collectEvidence: () => ({ lines: ['失败时已在实施阶段（分析已跑完）'] }) })
      assert.equal(second.action, 'fail')
      assert.deepEqual(h.releases, ['om_task1'])
      assert.equal(h.reports.length, 1)
      assert.equal(h.reports[0].status, 'failed')
      const lines = h.reports[0].result.split('\n')
      assert.equal(lines[3], `3. 失败归类：模型没写结果文件，已自动重跑 1 次仍失败，同一种错 7 天内第 2 次，指纹 ${second.fingerprint.fingerprint}；`)
      assert.equal(lines[4], '4. 旁证：失败时已在实施阶段（分析已跑完）；')
      assert.deepEqual(auditContext.record.failureEvidence, { lines: ['失败时已在实施阶段（分析已跑完）'] })
      assert.deepEqual(listFailures({ dir }).map((item) => [item.action, item.epoch, item.recurring]), [['requeue', 1, false], ['fail', 2, true]])

      // 另一条任务撞上同一指纹：它自己还没重跑过，照样先重排队一次，但台账记为复发
      const other = await handleTaskFailure({ ...h, task: { id: 'om_task2', epoch: 0 }, error, dir })
      assert.equal(other.action, 'requeue')
      assert.equal(listFailures({ dir }).at(-1).recurring, true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('交还队列失败 / 不可重排队 / 不算失败 / 旁证读失败 / 预算到点 / 开关关掉', async () => {
    const dir = tempDir('lark-playbook-')
    try {
      // 交还失败（返回空 / 抛错）→ 改报失败，台账记 fail
      for (const [index, release] of [async () => undefined, async () => { throw new Error('gateway down') }].entries()) {
        const h = harness({ release })
        const outcome = await handleTaskFailure({ ...h, task: { id: `om_rel${index}` }, error: new Error(REAL.exit1), dir })
        assert.equal(outcome.action, 'fail')
        assert.equal(h.releases.length, 1)
        assert.match(h.reports[0].result, /\n3\. 失败归类：执行器非零退出（原因不明），(?:同一种错 7 天内第 \d 次，)?指纹 exec_exit:/)
      }
      assert.deepEqual(listFailures({ dir }).map((item) => item.action), ['fail', 'fail'])

      // 不可重排队：直接失败，不交还；旁证读失败不阻断发卡
      const h1 = harness()
      await handleTaskFailure({ ...h1, task, error: new Error(REAL.timeout), dir, collectEvidence: () => { throw new Error('git 坏了') } })
      assert.deepEqual(h1.releases, [])
      assert.match(h1.reports[0].result, /\n3\. 失败归类：执行超时 \/ 卡死，指纹 timeout:[0-9a-f]{8}；\n4\. 下一步/)

      // 换代：不算失败，不进台账，卡照发（网关会按 epoch 挡掉）
      const h2 = harness()
      const before = listFailures({ dir }).length
      assert.equal((await handleTaskFailure({ ...h2, task, error: new Error(REAL.staleEpoch), dir })).action, 'ignore')
      assert.equal(listFailures({ dir }).length, before)
      assert.equal(h2.reports.length, 1)

      // 预算到点：执行器报 aborted，但按 timeout 失败记账；退出型中断（非 TimeoutError）仍是 aborted
      const h3 = harness()
      const deadline = AbortSignal.abort(new DOMException('budget', 'TimeoutError'))
      assert.equal((await handleTaskFailure({ ...h3, task, error: new Error(REAL.aborted), signal: deadline, dir })).fingerprint.cls, 'timeout')
      assert.equal(listFailures({ dir }).at(-1).cls, 'timeout')
      assert.equal((await handleTaskFailure({ ...h3, task, error: new Error(REAL.aborted), signal: AbortSignal.abort(), dir })).fingerprint.cls, 'aborted')
      assert.equal((await handleTaskFailure({ ...h3, task, error: new Error(REAL.aborted), signal: new AbortController().signal, dir })).fingerprint.cls, 'aborted')

      // 开关关掉：原格式失败卡，不交还、不记台账
      const h4 = harness()
      const count = listFailures({ dir }).length
      assert.deepEqual(await handleTaskFailure({ ...h4, task, error: new Error(REAL.resultMissing), dir, enabled: false }), { action: 'fail' })
      assert.deepEqual(h4.releases, [])
      assert.equal(h4.reports[0].result, buildFailureResult(task, new Error(REAL.resultMissing)))
      assert.equal(listFailures({ dir }).length, count)

      // 台账读不了（fameex.jsonl 是个目录）→ 按直接失败处理
      const blocked = join(dir, 'blocked')
      mkdirSync(join(blocked, 'fameex.jsonl'), { recursive: true })
      const h5 = harness()
      assert.equal((await handleTaskFailure({ ...h5, task, error: new Error(REAL.resultMissing), dir: blocked })).action, 'fail')
      assert.deepEqual(h5.releases, [])
      assert.equal(selfHealHintFor({ task, dir: blocked }), null)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('开关：selfHeal.playbook=false 或 LARK_FAILURE_PLAYBOOK=0 关，默认开', () => {
    const cases = [
      [{}, true],
      [{ localConfig: {} }, true],
      [{ localConfig: { selfHeal: { playbook: true } }, env: { LARK_FAILURE_PLAYBOOK: '1' } }, true],
      [{ localConfig: { selfHeal: { playbook: false } } }, false],
      [{ localConfig: { selfHeal: {} }, env: { LARK_FAILURE_PLAYBOOK: '0' } }, false],
    ]
    for (const [input, expected] of cases) assert.equal(failurePlaybookEnabled({ env: {}, ...input }), expected, JSON.stringify(input))
    assert.equal(failurePlaybookEnabled(), process.env.LARK_FAILURE_PLAYBOOK !== '0')
  })

  it('runAI：重领提示追加到分析与实施提示末尾；没有提示时提示原样', async () => {
    const calls = []
    const exec = async ({ resultKind = 'task', promptText }) => {
      calls.push(promptText)
      return { executor: 'claude', result: resultKind === 'analysis' ? { status: 'ready', summary: 's', applicableRules: [], requirements: [], blockers: [], scope: { targets: [{ path: 'a.ts', symbols: [], reason: 'r' }], siblings: { searchQueries: ['x'], items: [] } } } : { status: 'done', summary: 'ok', checks: [], changedFiles: ['a.ts'], warnings: [] } }
    }
    const workContext = { projectId: 'PR-99999', projectName: 't', projectDocs: [], cwd: tmpdir() }
    const bugTask = { id: 't1', source: 'lark', text: '修复：金额显示错误', aiExecutor: 'claude', attachments: [] }
    const snapshot = () => ({ status: '', diff: '' })
    await runAI({ localConfig: {} }, { ...bugTask, selfHealHint: '【自动重跑】提示' }, workContext, null, undefined, { exec, snapshot })
    assert.equal(calls.length, 2)
    assert.ok(calls.every((prompt) => prompt.endsWith('\n\n【自动重跑】提示')))
    calls.length = 0
    await runAI({ localConfig: {} }, bugTask, workContext, null, undefined, { exec, snapshot })
    assert.ok(calls.every((prompt) => !prompt.includes('【自动重跑】')))
  })
})
