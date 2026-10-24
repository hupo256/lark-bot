#!/usr/bin/env node
/**
 * bug 修复前只读分诊：判定 → 是否改代码、结果结构、证据采集、执行器只读参数、卡片与回写口径。
 *   node --test common/lark-bot/__tests__/lark-triage.test.mjs
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { runSteps } from './support/steps.mjs'

import { buildAiExecutorCommand, formatStructuredAiResult } from '../lib/lark-ai-executor.mjs'
import { parseStructuredTriageResult } from '../lib/lark-ai-result.mjs'
import { buildBugText, readBugMetaFromText } from '../lib/lark-bugtable-parse.mjs'
import { handleStatusUpdate } from '../lib/lark-status.mjs'
import { createTaskStore } from '../lib/lark-task-store.mjs'
import { collectTriageFacts, formatTriageFacts, resolveTriageOutcome, shouldRunTriage } from '../lib/lark-triage.mjs'

const triage = (overrides = {}) => ({
  verdict: 'frontend_fix',
  summary: '结论',
  evidence: [],
  relatedCommits: [],
  owner: null,
  questions: [],
  nextStep: null,
  ...overrides,
})

describe('resolveTriageOutcome', () => {
  it('四种判定：frontend_fix 放行改代码，already_fixed_in_code / not_frontend / needs_info 各自的不改代码结果', () => runSteps([
    ['frontend_fix 才放行改代码', () => {
      assert.deepEqual(resolveTriageOutcome(triage()), { proceed: true }, 'frontend_fix 才放行改代码')
    }],
    ['already_fixed_in_code → no_change_needed + env_version，owner 缺省 QA，不改任何文件', () => {
      const { proceed, result } = resolveTriageOutcome(triage({
        verdict: 'already_fixed_in_code',
        summary: '当前代码已展示邮箱验证码窗口，Pre 环境未部署该版本',
        evidence: ['LoginVerify.tsx:42 已按绑定方式展示邮箱验证码'],
        relatedCommits: ['9ac4350 2026-10-03 fix(PR-02233): unify security verify modal rules'],
        nextStep: '部署含 9ac4350 的版本到 Pre 后复测',
      }))
      assert.equal(proceed, false, 'already_fixed_in_code 不放行')
      assert.equal(result.status, 'no_change_needed')
      assert.equal(result.noChangeReason, 'env_version')
      assert.equal(result.owner, 'QA', 'owner 缺省 QA')
      assert.deepEqual(result.changedFiles, [], '不改任何文件')
      assert.deepEqual(result.relatedCommits, ['9ac4350 2026-10-03 fix(PR-02233): unify security verify modal rules'])
    }],
    ['not_frontend → no_change_needed + not_frontend，owner 取分诊结论', () => {
      const notFrontend = resolveTriageOutcome(triage({
        verdict: 'not_frontend',
        evidence: ['/v1/user/security 返回 emailEnabled=false，用户实际已绑定邮箱'],
        owner: '后端',
      }))
      assert.equal(notFrontend.proceed, false, 'not_frontend 不放行')
      assert.equal(notFrontend.result.noChangeReason, 'not_frontend')
      assert.equal(notFrontend.result.owner, '后端', 'owner 取分诊结论')
    }],
    ['needs_info → waiting_confirmation，blockers 即待补充问题', () => {
      const needsInfo = resolveTriageOutcome(triage({
        verdict: 'needs_info',
        evidence: ['截图未包含页面路径'],
        questions: ['请补充复现账号的绑定状态'],
      }))
      assert.equal(needsInfo.proceed, false, 'needs_info 不放行')
      assert.equal(needsInfo.result.status, 'waiting_confirmation')
      assert.deepEqual(needsInfo.result.blockers, ['请补充复现账号的绑定状态'], 'blockers 即待补充问题')
      assert.equal(needsInfo.result.noChangeReason, undefined)
    }],
  ]))
})

describe('parseStructuredTriageResult', () => {
  it('接受合法对象与围栏 JSON；没依据 / 没待补充问题 / 非法 verdict 拒绝', () => runSteps([
    ['接受合法对象与 Markdown 围栏包裹的 JSON 字符串', () => {
      assert.equal(parseStructuredTriageResult(triage()).verdict, 'frontend_fix')
      const fenced = `\`\`\`json\n${JSON.stringify(triage({ verdict: 'not_frontend', evidence: ['接口字段错'] }))}\n\`\`\``
      assert.equal(parseStructuredTriageResult(fenced, 'claude').verdict, 'not_frontend')
    }],
    ['不改代码的判定没有依据 → 拒绝', () => {
      assert.throws(() => parseStructuredTriageResult(triage({ verdict: 'already_fixed_in_code' })), /必须给出 evidence/)
    }],
    ['needs_info 没有待补充问题 / 非法 verdict → 拒绝', () => {
      assert.throws(() => parseStructuredTriageResult(triage({ verdict: 'needs_info', evidence: ['x'] })), /必须列出 questions/)
      assert.throws(() => parseStructuredTriageResult(triage({ verdict: 'maybe' })), /verdict/)
    }],
  ]))
})

describe('bug 元信息进入任务正文', () => {
  const bug = { titleField: '问题标题', descField: '问题描述（复现步骤）', projectField: '项目ID', statusField: '处理状态' }
  const record = {
    record_id: 'rec1',
    fields: {
      问题标题: '登录时没有展示邮箱验证码窗口',
      '问题描述（复现步骤）': '复现：\n环境：随手写在描述里的不算',
      项目ID: 'PR-02233',
      bug编号: 'BUG-7561',
      环境: ['Pre', 'Test'],
      涉及端口: ['Web'],
      创建时间: '2026-10-05T10:00:00.000+04:00',
    },
  }

  it('buildBugText 写入元信息，readBugMetaFromText 只读描述之前的行；缺失的列不写行、不报错', () => runSteps([
    ['buildBugText 写入元信息，readBugMetaFromText 只读描述之前的行', () => {
      const text = buildBugText({ record, bug })
      assert.match(text, /环境：Pre、Test/)
      assert.deepEqual(readBugMetaFromText(text), {
        bugNo: 'BUG-7561',
        env: 'Pre、Test',
        ports: 'Web',
        createdAt: '2026-10-05T10:00:00.000+04:00',
      })
    }],
    ['缺失的列不写行、不报错', () => {
      const sparse = buildBugText({ record: { record_id: 'rec2', fields: { 问题标题: 't' } }, bug })
      assert.deepEqual(readBugMetaFromText(sparse), {}, '缺失的列不写行、不报错')
    }],
  ]))
})

describe('shouldRunTriage 与分诊阶段执行器参数只读', () => {
  it('只对 bug 表来源的修复任务分诊（只读查询与群里交办不分诊）；claude 分诊无写工具、Bash 只放行只读 git/rg', () => runSteps([
    ['只对 bug 表来源的修复任务分诊；只读查询与群里交办不分诊', () => {
      const fix = { source: 'lark-bugtable', commandType: 'fix', text: '修复：Lark bug 表待处理项 [x]' }
      assert.equal(shouldRunTriage(fix, {}), true)
      assert.equal(shouldRunTriage(fix, { readOnly: true }), false)
      assert.equal(shouldRunTriage({ ...fix, source: 'lark' }, {}), false)
      assert.equal(shouldRunTriage({ ...fix, commandType: 'status', text: '状态：x' }, {}), false)
    }],
    // 原 describe「分诊阶段执行器参数只读」
    ['claude：无写工具、不跳过权限，Bash 只放行只读 git/rg，结构化结果走 stdout', () => {
      const command = buildAiExecutorCommand({ executor: 'claude', promptText: 'triage', cwd: '/tmp/repo', resultPath: '/tmp/r.json', resultKind: 'triage' })
      const arg = (flag) => command.args[command.args.indexOf(flag) + 1]
      assert.equal(arg('--tools'), 'Read,Grep,Glob,Bash', 'claude：无写工具')
      assert.equal(command.args.includes('--dangerously-skip-permissions'), false, '不跳过权限')
      for (const rule of arg('--allowedTools').split(',')) assert.match(rule, /^Bash\((?:git (?:log|show|diff|status|branch|rev-parse|merge-base|blame)|rg):\*\)$/)
      assert.match(arg('--json-schema'), /already_fixed_in_code/)
      assert.equal(command.resultMode, 'stdout-structured', '结构化结果走 stdout')
    }],
  ]))
})

describe('collectTriageFacts', () => {
  const git = (cwd, ...args) => {
    const out = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: process.env.FAKE_DATE, GIT_COMMITTER_DATE: process.env.FAKE_DATE } })
    assert.equal(out.status, 0, out.stderr)
    return out.stdout.trim()
  }
  const commit = (cwd, message, date) => {
    process.env.FAKE_DATE = date
    writeFileSync(join(cwd, `${message}.txt`), message)
    git(cwd, 'add', '.')
    git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message)
  }

  it('采集未推送提交与 bug 创建之后的提交', () => {
    const root = mkdtempSync(join(tmpdir(), 'lark-triage-'))
    try {
      const remote = join(root, 'remote.git')
      const repo = join(root, 'repo')
      spawnSync('git', ['init', '-q', '--bare', remote])
      spawnSync('git', ['init', '-q', '-b', 'feature/PR-1', repo])
      commit(repo, 'old-fix', '2026-10-01T10:00:00+04:00')
      git(repo, 'remote', 'add', 'origin', remote)
      git(repo, 'push', '-q', '-u', 'origin', 'feature/PR-1')
      commit(repo, 'pushed-later', '2026-10-06T10:00:00+04:00')
      git(repo, 'push', '-q')
      commit(repo, 'local-only', '2026-10-07T10:00:00+04:00')
      delete process.env.FAKE_DATE
      for (const name of ['Login', 'Assets', 'shared']) mkdirSync(join(repo, 'apps/web-next/src/apps', name), { recursive: true })

      const facts = collectTriageFacts({ cwd: repo, task: { text: '修复：x\nbug 创建时间：2026-10-05T10:00:00.000+04:00\n描述：y' } })
      assert.equal(facts.branch, 'feature/PR-1')
      assert.equal(facts.upstream, 'origin/feature/PR-1')
      assert.equal(facts.unpushed.length, 1)
      assert.match(facts.unpushed[0], /local-only/)
      assert.deepEqual(facts.sinceBug.map((line) => line.split(' ').at(-1)), ['local-only', 'pushed-later'])
      const text = formatTriageFacts(facts)
      assert.match(text, /尚未推送到上游的提交/)
      assert.doesNotMatch(text, /old-fix/)
      assert.deepEqual(facts.webNextApps, ['Assets', 'Login']) // shared 不是页面模块
      assert.match(text, /已迁移到 apps\/web-next 的模块（apps\/web-next\/src\/apps）：Assets、Login/)
      assert.match(formatTriageFacts(collectTriageFacts({ cwd: root, task: { text: '' } })), /web-next 的模块.*：未知/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('不改代码的群卡片与回写口径', () => {
  it('卡片写清判定 / 依据 / 相关提交 / 下一步、依据最多 3 条截断；gateway 持久化 noChangeReason，下一轮终态覆盖、非法值丢弃', () => runSteps([
    ['卡片写清判定、依据、相关提交、下一步', () => {
      const { result } = resolveTriageOutcome(triage({
        verdict: 'already_fixed_in_code',
        summary: '当前代码已符合预期',
        evidence: ['LoginVerify.tsx:42'],
        relatedCommits: ['9ac4350 fix'],
        nextStep: '部署含 9ac4350 的版本到 Pre 后复测',
      }))
      const text = formatStructuredAiResult(result)
      assert.match(text, /^无需改动。/)
      assert.match(text, /判定：环境版本未包含修复/)
      assert.match(text, /依据：LoginVerify\.tsx:42/)
      assert.match(text, /相关提交：9ac4350 fix/)
      assert.match(text, /下一步：部署含 9ac4350/)
    }],
    ['卡片依据最多 3 条、单条过长截断，其余指向审计', () => {
      const long = resolveTriageOutcome(triage({
        verdict: 'not_frontend',
        evidence: ['a'.repeat(200), 'b', 'c', 'd', 'e'],
      }))
      const line = formatStructuredAiResult(long.result).split('\n').find((item) => item.includes('依据：'))
      assert.match(line, /a{120}…；b；c（另有 2 条见任务审计）$/, '卡片依据最多 3 条、单条过长截断，其余指向审计')
    }],
    ['gateway 持久化本轮 noChangeReason，下一轮终态覆盖、非法值丢弃', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'lark-triage-gw-'))
      try {
        const store = createTaskStore({ tasksDir: dir, leaseMs: 60_000 })
        store.upsert({ id: 't', status: 'running', epoch: 1, chatId: 'oc_x', createdAt: '2026-01-01T00:00:00Z' })
        const deps = { config: {}, store, resolveGroupChat: async () => null, sendMessage: async () => ({ ok: true, messageId: 'om_x' }) }
        await handleStatusUpdate({ ...deps, id: 't', status: 'no_change_needed', result: '无需改动。', epoch: 1, noChangeReason: 'env_version' })
        assert.equal(store.get('t').noChangeReason, 'env_version', 'gateway 持久化本轮 noChangeReason')
        await handleStatusUpdate({ ...deps, id: 't', status: 'failed', result: '处理失败。', epoch: 1, noChangeReason: 'bogus' })
        assert.equal(store.get('t').noChangeReason, null, '下一轮终态覆盖、非法值丢弃')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }],
  ]))
})
