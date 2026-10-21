#!/usr/bin/env node
/**
 * aven 2026-10-20 review 修复的纯逻辑回归（提示词矩阵另见 lark-prompt-budget.test.mjs）。
 *   LARK_CLI_BIN=/usr/bin/false node --test __tests__/lark-review-20261020.test.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { isDefectCandidate } from '../lib/lark-defect-rules.mjs'
import { QUESTION_REPLY_FORMAT, findCompletionContradiction, findUnverifiedPreClaim, schemaVerifyVerdict } from '../lib/lark-completion-rule.mjs'
import { buildValidationRequirements } from '../lib/lark-worker-prompts.mjs'
import { buildDocIntakeText, changedDocPaths, docArchiveDirs, planDocIntakeCommit, restoreKeptDocs } from '../lib/lark-doc-archive.mjs'
import { integrationReport, readableBranchAfterMerge, shouldUseIntegrationBranch } from '../lib/lark-task-finish.mjs'
import { resolveScopeGate } from '../lib/lark-scope-contract.mjs'
import { allowsDocsOnlyDone, assessDoneResult, buildLintFixPrompt, isDocsOnlyDiff } from '../lib/lark-quality-gate.mjs'
import { requestsPreCheck } from '../lib/lark-message.mjs'
import { formatViolations } from '../lib/lark-lint-diff.mjs'
import { fingerprintFailure } from '../lib/lark-failure-fingerprint.mjs'
import { countRecentFingerprint, recordFailure } from '../lib/lark-failure-ledger.mjs'
import { classifyWorkerFailure, failureHead } from '../lib/lark-worker-results.mjs'
import { GROUP_REPLY_MAX_CHARS, parseStructuredAiResult, parseStructuredAnalysisValue, parseStructuredIntentResult, parseStructuredTriageResult } from '../lib/lark-ai-result.mjs'
import { classifyBlockers } from '../lib/lark-work-policy.mjs'
import { gitTail } from '../lib/lark-worker-git.mjs'
import { NO_CHANGE_REASONS } from '../lib/lark-triage.mjs'

const root = new URL('..', import.meta.url).pathname
const git = (cwd, args) => {
  const res = spawnSync('git', ['-C', cwd, '-c', 'core.quotepath=off', ...args], { encoding: 'utf8' })
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`)
  return res.stdout
}
const tempRepo = () => {
  const dir = mkdtempSync(join(tmpdir(), 'lark-review-'))
  git(dir, ['init', '-q', '-b', 'main'])
  git(dir, ['config', 'user.email', 't@t'])
  git(dir, ['config', 'user.name', 't'])
  mkdirSync(join(dir, 'docs/pending'), { recursive: true })
  writeFileSync(join(dir, 'docs/pending/old.md'), 'repo version\n')
  writeFileSync(join(dir, 'docs/pending/same.md'), 'same\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'init'])
  return dir
}

describe('B1 缺陷分诊按任务性质', () => {
  it('requirement 分类但是「改成 X」→ 缺陷；对接答复 / 代答 / 只读 / 清扫 → 不是', () => {
    const lark = (extra) => ({ source: 'lark', chatId: 'oc', attachments: [], ...extra })
    assert.equal(isDefectCandidate({ task: lark({ text: '把预约按钮颜色改成红色', intake: { classification: { decision: 'requirement' } } }) }), true)
    assert.equal(isDefectCandidate({ task: lark({ text: '加一个导出功能页面', intake: { classification: { decision: 'requirement' } } }) }), false)
    assert.equal(isDefectCandidate({ task: lark({ text: '列表报错了', intake: { classification: { decision: 'bug' } } }) }), true)
    assert.equal(isDefectCandidate({ task: lark({ text: '字段已补', commandType: 'api', intake: { classification: { decision: 'api_reply' } } }) }), false)
    assert.equal(isDefectCandidate({ task: lark({ text: '报错', intake: { classification: { decision: 'bug' } } }), isSweep: true }), false)
    assert.equal(isDefectCandidate({ task: lark({ text: '报错', intake: { classification: { decision: 'bug' } } }), isReadOnly: true }), false)
  })
})

describe('B2 / #14 / C13 完成口径', () => {
  it('代答格式指向结果契约里的完成口径', () => {
    assert.doesNotMatch(QUESTION_REPLY_FORMAT, /上面的三档口径/)
    assert.match(QUESTION_REPLY_FORMAT, /结果契约里的完成口径/)
  })
  it('pre 结论自检不误伤 prepare / preview；「缺省」不算问题', () => {
    assert.equal(findUnverifiedPreClaim({ text: 'prepare 阶段没有数据', preChecks: null }), null)
    assert.equal(findUnverifiedPreClaim({ text: 'preview 图还没出', preChecks: null }), null)
    assert.ok(findUnverifiedPreClaim({ text: 'pre 上没有数据', preChecks: null }))
    assert.ok(findUnverifiedPreClaim({ text: '在pre环境还没回归', preChecks: [] }))
    assert.equal(findCompletionContradiction('都完成了，缺省值保持不变'), null)
    assert.ok(findCompletionContradiction('都完成了，还缺少 anchor 字段'))
  })
  it('schema 实测闸：全是连不上 / 只测静态资源 = 没实测；有 issues = broken；至少一条 ok = ok', () => {
    assert.equal(schemaVerifyVerdict([{ endpoint: '/api/a', outcome: 'UNREACHABLE', kind: 'unreachable' }]).verdict, 'unverified')
    assert.equal(schemaVerifyVerdict([]).verdict, 'unverified')
    assert.equal(schemaVerifyVerdict(null).verdict, 'unverified')
    assert.equal(schemaVerifyVerdict([{ endpoint: '/upload/x.apk', outcome: 'ok', kind: 'ok' }]).verdict, 'unverified')
    assert.equal(schemaVerifyVerdict([{ endpoint: '/api/a', outcome: 'UNREACHABLE', kind: 'unreachable' }, { endpoint: '/api/b', outcome: 'ok 3 条', kind: 'ok' }]).verdict, 'ok')
    assert.equal(schemaVerifyVerdict([{ endpoint: '/api/b', outcome: 'ok: code 0' }]).verdict, 'ok', '老格式没填 kind 退回看 outcome')
    const broken = schemaVerifyVerdict([{ endpoint: '/api/a', outcome: 'issues: x', kind: 'issues' }, { endpoint: '/api/b', kind: 'ok', outcome: 'ok' }])
    assert.equal(broken.verdict, 'broken')
    assert.equal(broken.broken.length, 1)
  })
})

describe('#15 日报清扫的验证策略', () => {
  it('清扫不渲染「视觉验收默认关闭」，编号连续', () => {
    const sweep = buildValidationRequirements(null, { isSweep: true })
    assert.doesNotMatch(sweep, /不要启动 dev server/)
    assert.match(sweep, /\n4\. 必需检查完成后/)
    assert.doesNotMatch(sweep, /\n5\. /)
    const normal = buildValidationRequirements(null)
    assert.match(normal, /4\. Lark Bot 自动视觉验收默认关闭/)
    assert.match(normal, /\n5\. 必需检查完成后/)
  })
})

describe('C5 / C8 / C9 文档存档', () => {
  const profile = { docIntakeDir: 'docs/delivery/pending/', docReplyDir: './docs/delivery/reply' }
  it('收件 + 答复目录同一份清单，范围契约两处都豁免（含 pdf）', () => {
    assert.deepEqual(docArchiveDirs(profile), ['docs/delivery/pending', 'docs/delivery/reply'])
    assert.deepEqual(docArchiveDirs({ docIntakeDir: 'docs/p', docReplyDir: 'docs/p' }), ['docs/p'])
    assert.deepEqual(docArchiveDirs(null), [])
    const gate = resolveScopeGate({
      task: { text: '按答复改', scopeApprovals: [] },
      scope: { targets: [{ path: 'src/a.ts', symbols: [], reason: 'r' }], siblings: { searchQueries: [], items: [] } },
      actualChangedFiles: ['src/a.ts', 'docs/delivery/reply/对接-答复.pdf', 'docs/delivery/pending/对接.docx'],
      exemptPrefixes: docArchiveDirs(profile),
    })
    assert.equal(gate.check.ok, true, JSON.stringify(gate.check.outOfScope))
  })
  it('入库计划：#kept 永不提交，#same 没改过不算，全是已有版本 → 无需提交（文案无空括号）', () => {
    assert.deepEqual(planDocIntakeCommit({ archived: ['a.md#same', 'b.md#kept'], changedPaths: [] }), { commit: [], same: ['a.md'], kept: ['b.md'] })
    assert.deepEqual(planDocIntakeCommit({ archived: ['n.md', 'a.md#same', 'b.md#kept'], changedPaths: ['n.md', 'b.md'] }).commit, ['n.md'])
    assert.deepEqual(planDocIntakeCommit({ archived: ['n.md', 'a.md#same'], changedPaths: null }).commit, ['n.md'], 'git 读不到退回新拷贝的文件')
    const none = buildDocIntakeText({ commit: [], same: ['docs/a.md'], kept: ['docs/b.md'], owners: ['henry'], summary: 's' })
    assert.doesNotMatch(none, /（）/)
    assert.match(none, /^文档无需提交：a\.md 和仓里已有版本逐字节相同；b\.md 仓里已有不同版本，没覆盖。内容归 henry 负责/)
    const some = buildDocIntakeText({ commit: ['docs/n.md'], same: [], kept: [], mine: true, summary: 's', blockers: ['缺 x'] })
    assert.match(some, /^文档已存进仓库（docs\/n\.md）。是我负责的部分，这次没开工。\ns\n还缺：缺 x$/)
  })
  it('真实 git：只算真有改动的文档；#kept 被改过的恢复成 HEAD 版本', () => {
    const dir = tempRepo()
    try {
      writeFileSync(join(dir, 'docs/pending/new.md'), 'new\n')
      writeFileSync(join(dir, 'docs/pending/old.md'), 'AI 覆盖了\n')
      const archived = ['docs/pending/new.md', 'docs/pending/same.md#same', 'docs/pending/old.md#kept']
      assert.deepEqual(changedDocPaths({ cwd: dir, paths: ['docs/pending/new.md', 'docs/pending/same.md'] }), ['docs/pending/new.md'])
      assert.deepEqual(restoreKeptDocs({ cwd: dir, archived }), ['docs/pending/old.md'])
      assert.equal(readFileSync(join(dir, 'docs/pending/old.md'), 'utf8'), 'repo version\n')
      assert.deepEqual(restoreKeptDocs({ cwd: dir, archived }), [], '没改过的 #kept 不动')
      assert.deepEqual(changedDocPaths({ cwd: join(dir, 'nope'), paths: ['x.md'] }), null)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('C6 / #19 集成分支', () => {
  it('合回且任务分支已删 → task.branch 改指集成分支；摘要带 mergedSha', () => {
    const merged = { branch: 'lark/falive-integration', ok: true, mergeBack: { ok: true, merged: true, head: 'abc123' }, branchCleanup: { deleted: true } }
    assert.equal(readableBranchAfterMerge(merged), 'lark/falive-integration')
    assert.deepEqual(integrationReport(merged, { taskBranch: 'lark/falive-t1' }), {
      branch: 'lark/falive-integration', synced: true, syncReason: null, mergedBack: true, mergeReason: null, mergedSha: 'abc123', taskBranch: 'lark/falive-t1', taskBranchDeleted: true,
    })
    assert.equal(readableBranchAfterMerge({ ...merged, branchCleanup: { deleted: false } }), undefined, '分支没删就不改')
    assert.equal(readableBranchAfterMerge({ ...merged, mergeBack: { ok: false, reason: '冲突' }, branchCleanup: null }), undefined)
    assert.equal(integrationReport({ branch: 'i', ok: false, reason: '冲突' }).mergedSha, null)
    assert.equal(integrationReport(null), null)
  })
  it('WIP 改道后不走集成分支（不覆盖改道基线）', () => {
    const profile = { integrationBranch: 'lark/falive-integration' }
    assert.equal(shouldUseIntegrationBranch({ workContext: { hotfixBranch: 'lark/falive-t1' }, profile }), true)
    assert.equal(shouldUseIntegrationBranch({ workContext: { hotfixBranch: 'lark/falive-t1' }, profile, reroutedWip: { hotfixBranch: 'x' } }), false)
    assert.equal(shouldUseIntegrationBranch({ workContext: {}, profile }), false)
    assert.equal(shouldUseIntegrationBranch({ workContext: { hotfixBranch: 'x' }, profile: {} }), false)
  })
  it('gitTail 超长时首尾各留一半，结论行不丢', () => {
    const text = `error: start ${'x'.repeat(400)} Automatic merge failed`
    const tail = gitTail({ stderr: text }, 60)
    assert.ok(tail.length <= 63)
    assert.match(tail, /^error: start/)
    assert.match(tail, /merge failed$/)
    assert.equal(gitTail({ stderr: '', stdout: ' short ' }), 'short')
  })
})

describe('A9 只改文档不算修复', () => {
  it('预期改代码的任务只改 md → 不可信；对接 / 入库 / 清扫 / 等材料 / 落了待确认清单的放行', () => {
    assert.equal(isDocsOnlyDiff(['docs/a.md', 'src/x.test.ts']), true)
    assert.equal(isDocsOnlyDiff(['src/x.test.ts']), false, '只测试由 test-only 那条管')
    assert.equal(isDocsOnlyDiff(['docs/a.md', 'src/x.ts']), false)
    const docsOnly = { reportedChangedFiles: ['docs/a.md'], actualChangedFiles: ['docs/a.md'], checks: [], expectsCodeFix: true }
    assert.equal(assessDoneResult(docsOnly).trustworthy, false)
    assert.equal(assessDoneResult({ ...docsOnly, docsOnlyAllowed: true }).trustworthy, true)
    assert.equal(assessDoneResult({ ...docsOnly, expectsCodeFix: false }).trustworthy, true)
    const bug = { source: 'lark', text: '列表报错', intake: { classification: { decision: 'bug' } }, attachments: [] }
    assert.equal(allowsDocsOnlyDone({ task: bug, result: { followUpDoc: null } }), false)
    assert.equal(allowsDocsOnlyDone({ task: bug, result: { followUpDoc: 'docs/p/x-待确认.md' } }), true)
    assert.equal(allowsDocsOnlyDone({ task: { ...bug, commandType: 'api' } }), true)
    assert.equal(allowsDocsOnlyDone({ task: { ...bug, attachments: [{ type: 'file', localPath: '/tmp/a.md' }] } }), true)
    assert.equal(allowsDocsOnlyDone({ task: { ...bug, source: 'daily-sweep' } }), true)
    assert.equal(allowsDocsOnlyDone({ task: { ...bug, waitsFor: '新域名' } }), true)
    // 教训 #58 → 任务契约（10-21 P2）：只改文档放行看 task.contract.docsOnlyOk，契约的判定见 lark-task-contract.test。
    assert.equal(allowsDocsOnlyDone({ task: { ...bug, contract: { docsOnlyOk: true } } }), true)
    assert.equal(allowsDocsOnlyDone({ task: { ...bug, contract: { docsOnlyOk: false } } }), false)
    for (const line of ['去 pre 上复测一下', '在浏览器里看一下滚到底', '看完报告结果']) assert.equal(requestsPreCheck({ text: `【本条 @】@Aven.Bot ${line}` }), true, line)
    for (const line of ['prepare 一下文档', '预告重复了']) assert.equal(requestsPreCheck({ text: `【本条 @】@Aven.Bot ${line}` }), false, line)
    assert.equal(requestsPreCheck({ text: '【aven 私聊指示】去 pre 看一下\n\n【指示针对的群消息】x' }), true)
    assert.equal(requestsPreCheck({ text: '列表报错' }), false)
  })
})

describe('#18 规范纠正按 ruleProfile 给 token 出处', () => {
  it('falive 用 src/theme.css，fameex 仍是 tailwind-preset', () => {
    const violations = [{ kind: 'arbitrary-value', file: 'src/a.tsx', token: 'rounded-[8px]', line: 'x' }, { kind: 'invalid-color-class', file: 'src/a.tsx', token: 'text-green', line: 'x' }]
    const falive = formatViolations(violations, { ruleProfile: 'falive' })
    assert.match(falive, /src\/theme\.css/)
    assert.doesNotMatch(falive, /tailwind-preset|text-sem-g/)
    assert.match(formatViolations(violations), /packages\/config\/tailwind-preset\.js/)
    assert.doesNotMatch(buildLintFixPrompt('/w', violations, 'falive'), /tailwind-preset/)
    assert.match(buildLintFixPrompt('/w', violations), /tailwind-preset/)
  })
})

describe('A7 / A8 失败归类与指纹', () => {
  it('非零退出只看尾部之前的前缀：尾部 inputTokens / git diff / tsc 不带偏，尾部不同指纹相同', () => {
    const exit = (tail) => new Error(`claude exec exited with code 1：${tail}`)
    for (const tail of ['{"usage":{"inputTokens":123}}', 'ran git diff --stat', 'tsc --noEmit ok', 'permission denied in output']) {
      assert.equal(fingerprintFailure(exit(tail)).cls, 'exec_exit', tail)
      assert.notEqual(classifyWorkerFailure(exit(tail)).failureKind, 'permission', tail)
    }
    assert.equal(fingerprintFailure(exit('a')).fingerprint, fingerprintFailure(exit('b')).fingerprint)
    const transient = exit('model said ok')
    transient.transient = true
    assert.equal(fingerprintFailure(transient).cls, 'transient_api')
    assert.equal(failureHead('pre 文字 claude exec exited with code 137：尾巴'), 'pre 文字 claude exec exited with code 137')
    assert.equal(classifyWorkerFailure(new Error('token expired')).failureKind, 'permission')
  })

  it('lark-ai-result 的每条报错原文都归到 result_missing / result_invalid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lark-ai-result-'))
    const file = (value) => {
      const path = join(dir, `${Math.random().toString(36).slice(2)}.json`)
      writeFileSync(path, JSON.stringify(value))
      return path
    }
    const ok = { status: 'done', summary: 's', checks: [], changedFiles: [], warnings: [] }
    const evidence = { userSeenValue: 'a', apiActualValue: 'b', contractExpectedValue: 'c', dataFlowFirstErrorLocation: 'd' }
    const okAnalysis = { status: 'ready', summary: 's', applicableRules: [], requirements: [], blockers: [] }
    const cases = [
      () => parseStructuredAiResult(join(dir, 'missing.json')),
      () => parseStructuredAiResult(file({ status: 'x' })),
      () => parseStructuredAiResult(file({ ...ok, checks: 'x' })),
      () => parseStructuredAiResult(file({ ...ok, changedFiles: 'x' })),
      () => parseStructuredAiResult(file({ ...ok, warnings: 'x' })),
      () => parseStructuredAiResult(file({ ...ok, status: 'done_with_warnings' })),
      () => parseStructuredAiResult(file({ ...ok, warnings: ['w'] })),
      () => parseStructuredAiResult(file({ ...ok, blockers: 'x' })),
      () => parseStructuredAiResult(file({ ...ok, status: 'blocked' })),
      () => parseStructuredAiResult(file({ ...ok, owner: 1 })),
      () => parseStructuredAiResult(file({ ...ok, failureKind: 'zz' })),
      () => parseStructuredAiResult(file({ ...ok, nextStep: 1 })),
      () => parseStructuredAiResult(file({ ...ok, taskState: 'zz' })),
      () => parseStructuredAiResult(file({ ...ok, rootCauseLayer: 'zz' })),
      () => parseStructuredAiResult(file({ ...ok, rootCauseLayer: 'backend-data', evidence: null })),
      () => parseStructuredAiResult(file({ ...ok, rootCauseLayer: 'backend-data', evidence: {} })),
      () => parseStructuredAiResult(file({ ...ok, rootCauseLayer: 'backend-data', evidence, taskState: 'completed', blockers: [] })),
      () => parseStructuredAnalysisValue('not json'),
      () => parseStructuredAnalysisValue([]),
      () => parseStructuredAnalysisValue({ ...okAnalysis, scope: 'x' }),
      () => parseStructuredAnalysisValue({ ...okAnalysis, status: 'x' }),
      () => parseStructuredAnalysisValue({ ...okAnalysis, applicableRules: [{}] }),
      () => parseStructuredAnalysisValue({ ...okAnalysis, requirements: 'x' }),
      () => parseStructuredAnalysisValue({ ...okAnalysis, blockers: 'x' }),
      () => parseStructuredAnalysisValue({ ...okAnalysis, status: 'blocked' }),
      () => parseStructuredIntentResult('not json'),
      () => parseStructuredIntentResult({ decision: 'x' }),
      () => parseStructuredIntentResult({ decision: 'bug', confidence: 'x' }),
      () => parseStructuredIntentResult({ decision: 'bug', confidence: 'high' }),
      () => parseStructuredIntentResult({ decision: 'bug', confidence: 'high', summary: 's' }),
      () => parseStructuredTriageResult('not json'),
      () => parseStructuredTriageResult({ verdict: 'x' }),
      () => parseStructuredTriageResult({ verdict: 'frontend_fix' }),
      () => parseStructuredTriageResult({ verdict: 'frontend_fix', summary: 's', evidence: 'x' }),
      () => parseStructuredTriageResult({ verdict: 'not_frontend', summary: 's', evidence: [], relatedCommits: [], questions: [] }),
      () => parseStructuredTriageResult({ verdict: 'needs_info', summary: 's', evidence: ['e'], relatedCommits: [], questions: [] }),
    ]
    try {
      const messages = cases.map((run, index) => {
        try {
          run()
        } catch (error) {
          return error.message
        }
        throw new Error(`第 ${index} 条没抛错`)
      })
      // 防漏：每个 throw 点至少一条样例（源码里新增报错就得往这张表里加）。
      const throwSites = (readFileSync(join(root, 'lib/lark-ai-result.mjs'), 'utf8').match(/throw new Error\(/g) || []).length
      assert.ok(messages.length >= throwSites, `样例 ${messages.length} 条 < 报错点 ${throwSites} 处`)
      for (const message of messages) {
        const { cls } = fingerprintFailure(new Error(message))
        assert.ok(['result_missing', 'result_invalid'].includes(cls), `${message} → ${cls}`)
      }
      assert.equal(fingerprintFailure(new Error(messages[2])).cls, 'result_invalid', '「结构化结果 checks 必须是…」')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('复发计数只数 fail / requeue（自修工单记录不算）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lark-ledger-'))
    try {
      const fingerprint = { cls: 'exec_exit', fingerprint: 'exec_exit:00000000' }
      recordFailure({ dir, repo: 'falive', taskId: 't1', fingerprint, action: 'fail' })
      recordFailure({ dir, repo: 'falive', taskId: 't1', fingerprint, action: 'self_fix_opened' })
      recordFailure({ dir, repo: 'falive', taskId: 't2', fingerprint, action: 'ignore' })
      recordFailure({ dir, repo: 'falive', taskId: 't3', fingerprint, action: 'requeue' })
      assert.equal(countRecentFingerprint({ dir, repo: 'falive', fingerprint: fingerprint.fingerprint }), 2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('#13 blockerClasses 只许收紧', () => {
  it('正则明确判 hard 的，模型标 soft 也按 hard；正则兜底的听模型；模型收紧照收', () => {
    const [explicit, fallback, tighten] = classifyBlockers(
      ['没有测试环境账号权限，进不去', '等 Encone 给新域名', '接口字段未定'],
      { blockerClasses: [{ text: '没有测试环境账号权限，进不去', class: 'soft' }, { text: '等 Encone 给新域名', class: 'soft' }, { text: '接口字段未定', class: 'hard' }] },
    )
    assert.equal(explicit.class, 'hard')
    assert.equal(fallback.class, 'soft')
    assert.equal(tighten.class, 'hard')
  })
})

describe('#20 结果 schema 与代码对齐', () => {
  const schema = JSON.parse(readFileSync(join(root, 'schemas/lark-ai-result.schema.json'), 'utf8'))
  it('有 noChangeReason（取值与分诊口径一致），groupReply 说明与 Worker 截断上限一致', () => {
    assert.deepEqual(schema.properties.noChangeReason.enum.filter(Boolean).sort(), Object.values(NO_CHANGE_REASONS).sort())
    assert.match(schema.properties.groupReply.description, new RegExp(`${GROUP_REPLY_MAX_CHARS} 字截断`))
    assert.doesNotMatch(schema.properties.groupReply.description, /60 字/)
  })
  it('Worker 读的 AI 结果字段 schema 里都有（additionalProperties:false 不能挡掉）', () => {
    const runner = readFileSync(join(root, 'lib/lark-task-runner.mjs'), 'utf8')
    const read = new Set([...runner.matchAll(/aiRun\.result\.([a-zA-Z]+)/g)].map((match) => match[1]))
    const workerOwned = new Set(['groupSilent']) // worker 自己写的，不是模型字段
    const missing = [...read].filter((key) => !workerOwned.has(key) && !schema.properties[key])
    assert.deepEqual(missing, [])
  })
})
