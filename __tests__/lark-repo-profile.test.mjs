import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import {
  DEFAULT_REPO_KEY,
  buildRepoRegistry,
  normalizeRepoProfile,
  registerRepoProfiles,
  repoProfile,
  repoProfileForChat,
  repoProfileForTask,
  resetRepoProfiles,
  resolveRepoDelivery,
  resolveWebhookCredentials,
  tempBranchNameFor,
} from '../lib/lark-repo-profile.mjs'
import { resolveWorkContext, safeProject, tempWorktreeContextFor, validateWorkContextRoute } from '../lib/lark-work-context.mjs'
import { buildWebhookBody, isWebhookSuccess, sendWebhookMessage, signWebhook } from '../lib/lark-webhook.mjs'
import { configTitleFor, validateConfig } from '../lib/lark-config.mjs'
import { resolveAiModelConfig, buildAiExecutorCommand, buildClaudeReadinessCommand } from '../lib/lark-ai-executor.mjs'
import { resolveOwnershipOutcome } from '../lib/lark-worker-run.mjs'

const faliveRaw = {
  root: '/tmp/falive-react',
  baseRef: 'feature/phase-3-api',
  chatIds: ['oc_falive_1'],
  taskMentionOpenIds: ['ou_aven'],
  title: 'Falive Web',
  claudeModel: 'claude-fable-5-1',
  claudeEffort: 'medium',
  claudeAnalysisModel: 'claude-opus-4-8',
  claudeAnalysisEffort: 'high',
  claudeIntentModel: 'claude-sonnet-5-5',
  scopeBudgets: { requirement: 1200 },
  ownership: { me: 'aven', meOpenIds: ['ou_aven'], table: 'docs/table.md' },
  ownerMap: { henry: 'ou_henry' },
  aiTimeoutMs: 3600000,
}

describe('repo profile 归一与注册', () => {
  afterEach(() => resetRepoProfiles())

  it('默认 profile = fameex 单仓原行为（origin/online、hotfix 前缀、.lark-hotfix）', () => {
    const profile = repoProfile(DEFAULT_REPO_KEY)
    assert.equal(profile.isDefault, true)
    assert.equal(profile.baseRef, 'origin/online')
    assert.equal(profile.fetchBase, true)
    assert.equal(tempBranchNameFor(profile, { project: 'PR-00001', suffix: 'abcd1234' }), 'hotfix/PR-00001-abcd1234')
    assert.equal(tempBranchNameFor(profile, { project: null, suffix: 'abcd1234' }), 'hotfix/adhoc-abcd1234')
    assert.ok(profile.tempWorktreeDir.endsWith('/.lark-hotfix'))
  })

  it('非默认仓：projectKey 大写、本地分支不 fetch、临时 worktree 落在同级 .lark-<key>、分支 <prefix>-<后缀>', () => {
    const profile = normalizeRepoProfile('falive', faliveRaw)
    assert.equal(profile.projectKey, 'FALIVE')
    assert.equal(profile.fetchBase, false)
    assert.equal(profile.worktreesDir, '/tmp/.lark-falive')
    assert.equal(profile.tempWorktreeDir, '/tmp/.lark-falive')
    assert.equal(profile.branchPrefix, 'lark/falive')
    assert.equal(tempBranchNameFor(profile, { project: 'FALIVE', suffix: 'abcd1234' }), 'lark/falive-abcd1234')
    assert.equal(profile.ownership.table, '/tmp/falive-react/docs/table.md')
    assert.equal(normalizeRepoProfile('xx', { ...faliveRaw, baseRef: 'origin/main' }).fetchBase, true)
  })

  it('缺 root / baseRef、projectKey 或群重复都在注册期报错', () => {
    assert.throws(() => normalizeRepoProfile('a', { baseRef: 'main' }), /root 必填/)
    assert.throws(() => normalizeRepoProfile('a', { root: '/tmp/a' }), /baseRef 必填/)
    assert.throws(() => buildRepoRegistry({ repos: { a: { ...faliveRaw, projectKey: 'XX' }, b: { ...faliveRaw, projectKey: 'XX', chatIds: ['oc_other'] } } }), /projectKey XX 重复/)
    assert.throws(() => buildRepoRegistry({ repos: { a: { ...faliveRaw, projectKey: 'AA' }, b: { ...faliveRaw, projectKey: 'BB' } } }), /oc_falive_1 同时属于/)
  })

  it('注册后：群 → 仓、任务 → 仓（repo 键或 project 反查）、projectKey 过 safeProject、标题取 profile.title', () => {
    registerRepoProfiles({ repos: { falive: faliveRaw } })
    assert.equal(repoProfileForChat('oc_falive_1').key, 'falive')
    assert.equal(repoProfileForChat('oc_unknown'), null)
    assert.equal(repoProfileForTask({ repo: 'falive' }).key, 'falive')
    assert.equal(repoProfileForTask({ project: 'FALIVE' }).key, 'falive')
    assert.equal(repoProfileForTask({ project: 'PR-00001' }).key, DEFAULT_REPO_KEY)
    assert.equal(safeProject('falive'), 'FALIVE')
    assert.equal(safeProject('../../x'), '')
    assert.equal(configTitleFor('FALIVE', { project: 'PR-01947', title: 'CopyTrading' }), 'Falive Web')
    assert.equal(configTitleFor('PR-01947', { project: 'PR-01947', title: 'CopyTrading' }), 'CopyTrading')
    assert.equal(configTitleFor('PR-09999', { project: 'PR-01947', title: 'CopyTrading' }), undefined)
  })

  it('未注册时 FALIVE 不是合法项目号（不会把陌生大写词当项目路由）', () => {
    assert.equal(safeProject('FALIVE'), '')
  })

  it('validateConfig 对 repos 做存在性校验（root 不存在即 error）', () => {
    const { errors } = validateConfig({ project: 'PR-00001', botOpenId: 'ou_bot', allowedChatIds: 'auto', repos: { falive: faliveRaw } })
    assert.ok(errors.some((line) => /repos\.falive\.root 不存在/.test(line)), errors.join('\n'))
  })
})

describe('工作上下文按 profile 路由', () => {
  afterEach(() => resetRepoProfiles())

  it('falive 任务：临时 worktree 在 .lark-falive、分支 lark/falive-*、基线为 profile.baseRef 且不 fetch、带仓库字段', () => {
    registerRepoProfiles({ repos: { falive: { ...faliveRaw, docs: ['CLAUDE.md'] } } })
    const task = { id: 'om_xxxxxxxxabcd1234', repo: 'falive', project: 'FALIVE', text: '修复：首页 banner' }
    const ctx = resolveWorkContext({}, task)
    assert.equal(ctx.cwd, '/tmp/.lark-falive/lark-falive-abcd1234')
    assert.equal(ctx.hotfixBranch, 'lark/falive-abcd1234')
    assert.equal(ctx.baseRef, 'feature/phase-3-api')
    assert.equal(ctx.fetchBase, false)
    assert.equal(ctx.repo, 'falive')
    assert.equal(ctx.repoRoot, '/tmp/falive-react')
    assert.equal(ctx.ruleProfile, 'falive')
    assert.deepEqual(ctx.projectDocs, ['/tmp/falive-react/CLAUDE.md'])
    assert.equal(ctx.projectName, 'Falive Web')
    assert.equal(validateWorkContextRoute({ task, workContext: ctx }).ok, true)
    // 人类 WIP 改道：基线换成 sha 时不 fetch
    const rerouted = tempWorktreeContextFor(task, { baseRef: 'deadbeef', sourceBranch: 'feature/x', sourceWorktree: '/tmp/falive-react' })
    assert.equal(rerouted.baseRef, 'deadbeef')
    assert.equal(rerouted.fetchBase, false)
    assert.equal(validateWorkContextRoute({ task, workContext: rerouted }).ok, true)
  })

  it('falive 只读任务在仓库根回答；默认仓任务形状不变', () => {
    registerRepoProfiles({ repos: { falive: faliveRaw } })
    const readOnly = resolveWorkContext({}, { id: 'om_1', repo: 'falive', project: 'FALIVE', text: '状态：进度到哪了', commandType: 'status' })
    assert.equal(readOnly.cwd, '/tmp/falive-react')
    assert.equal(readOnly.readOnly, true)
    assert.equal(validateWorkContextRoute({ task: { id: 'om_1', repo: 'falive', project: 'FALIVE', commandType: 'status' }, workContext: readOnly }).ok, true)
    const fameex = resolveWorkContext({}, { id: 'om_yyyyyyyy12345678', project: 'PR-00001', text: '修复：x' })
    assert.equal(fameex.hotfixBranch, 'hotfix/PR-00001-12345678')
    assert.equal(fameex.baseRef, undefined)
    assert.equal(fameex.repo, DEFAULT_REPO_KEY)
  })

  it('任务仓库与上下文仓库不一致时路由校验失败', () => {
    registerRepoProfiles({ repos: { falive: faliveRaw } })
    const task = { id: 'om_1', repo: 'falive', project: 'FALIVE', text: 'x' }
    const ctx = { ...resolveWorkContext({}, task), repo: 'fameex' }
    assert.equal(validateWorkContextRoute({ task, workContext: ctx }).ok, false)
  })
})

describe('claude 模型 / 推理强度按 profile', () => {
  it('resolveAiModelConfig：profile > claudeModel > 旧键 model；intent 模型单独', () => {
    const profile = normalizeRepoProfile('falive', faliveRaw)
    assert.deepEqual(resolveAiModelConfig({ model: 'old' }, 'claude'), { model: 'old', reasoningEffort: null, provider: null, intentModel: 'old', analysisModel: 'old', analysisEffort: null })
    assert.deepEqual(resolveAiModelConfig({ claudeModel: 'opus', claudeEffort: 'high' }, 'claude'), { model: 'opus', reasoningEffort: 'high', provider: null, intentModel: 'opus', analysisModel: 'opus', analysisEffort: 'high' })
    assert.deepEqual(resolveAiModelConfig({ claudeModel: 'opus' }, 'claude', profile), { model: 'claude-fable-5-1', reasoningEffort: 'medium', provider: null, intentModel: 'claude-sonnet-5-5', analysisModel: 'claude-opus-4-8', analysisEffort: 'high' })
    assert.equal(resolveAiModelConfig({ codexModel: 'gpt' }, 'codex').model, 'gpt')
  })

  it('claude 四种命令都带 --model / --effort，任务模式把 profile.readableDirs 放进 --add-dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lark-readable-'))
    try {
      for (const resultKind of ['intent', 'triage', 'analysis', 'task']) {
        const { args } = buildAiExecutorCommand({ executor: 'claude', promptText: 'p', cwd: '/tmp', resultPath: '/tmp/r.json', model: 'claude-fable-5-1', reasoningEffort: 'medium', resultKind, readableDirs: [dir] })
        assert.ok(args.includes('--model') && args[args.indexOf('--model') + 1] === 'claude-fable-5-1', resultKind)
        assert.ok(args.includes('--effort') && args[args.indexOf('--effort') + 1] === 'medium', resultKind)
        assert.ok(args.includes('--add-dir'), resultKind)
        assert.equal(args.at(-1), 'p')
      }
      const { args: plain } = buildAiExecutorCommand({ executor: 'claude', promptText: 'p', cwd: '/tmp', resultPath: '/tmp/r.json', resultKind: 'task' })
      assert.ok(!plain.includes('--model') && !plain.includes('--add-dir'))
      assert.deepEqual(buildClaudeReadinessCommand({ model: 'claude-fable-5-1', effort: 'medium' }).args.slice(5, 9), ['--model', 'claude-fable-5-1', '--effort', 'medium'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('webhook 发卡', () => {
  it('签名与 body：有 secret 带 timestamp/sign，卡片 JSON 原样内嵌', () => {
    assert.equal(signWebhook({ secret: 's', timestamp: '1' }), signWebhook({ secret: 's', timestamp: '1' }))
    const body = buildWebhookBody({ card: JSON.stringify({ header: { title: 'x' } }), secret: 's', now: 1700000000123 })
    assert.equal(body.msg_type, 'interactive')
    assert.equal(body.timestamp, '1700000000')
    assert.equal(body.sign, signWebhook({ secret: 's', timestamp: '1700000000' }))
    assert.deepEqual(body.card, { header: { title: 'x' } })
    assert.deepEqual(buildWebhookBody({ text: 'hi' }), { msg_type: 'text', content: { text: 'hi' } })
    assert.equal(isWebhookSuccess({ code: 0 }), true)
    assert.equal(isWebhookSuccess({ StatusCode: 0 }), true)
    assert.equal(isWebhookSuccess({ code: 19001 }), false)
  })

  it('sendWebhookMessage：成功无 messageId；4xx 带 code 不重试；5xx 重试', async () => {
    const calls = []
    const ok = await sendWebhookMessage({ url: 'https://x', secret: 's', card: '{"a":1}', fetchImpl: async (url, init) => { calls.push(JSON.parse(init.body)); return { ok: true, status: 200, text: async () => '{"code":0}' } } })
    assert.deepEqual(ok, { ok: true, messageId: null })
    assert.equal(calls[0].card.a, 1)
    let attempts = 0
    const bad = await sendWebhookMessage({ url: 'https://x', card: '{}', retries: 3, sleepImpl: async () => {}, fetchImpl: async () => { attempts += 1; return { ok: false, status: 400, text: async () => '{"code":19001,"msg":"param invalid"}' } } })
    assert.equal(bad.ok, false)
    assert.equal(attempts, 1)
    attempts = 0
    const flaky = await sendWebhookMessage({ url: 'https://x', card: '{}', retries: 3, sleepImpl: async () => {}, fetchImpl: async () => { attempts += 1; return attempts < 3 ? { ok: false, status: 502, text: async () => 'bad gateway' } : { ok: true, status: 200, text: async () => '{"code":0}' } } })
    assert.equal(flaky.ok, true)
    assert.equal(attempts, 3)
  })

  it('投递决策：有 webhook 走 webhook，无 webhook 有 notifyChatId 改投，默认仓的群不改', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lark-webhook-'))
    try {
      const file = join(dir, 'hook.json')
      writeFileSync(file, JSON.stringify({ webhookUrl: 'https://hook', secret: 'sec' }))
      registerRepoProfiles({ repos: { falive: { ...faliveRaw, webhook: { file } } } })
      assert.deepEqual(resolveRepoDelivery('oc_falive_1'), { repo: 'falive', webhook: { url: 'https://hook', secret: 'sec' }, redirectTo: null })
      assert.equal(resolveRepoDelivery('oc_other'), null)
      registerRepoProfiles({ repos: { falive: { ...faliveRaw, notifyChatId: 'ou_aven' } } })
      assert.deepEqual(resolveRepoDelivery('oc_falive_1'), { repo: 'falive', webhook: null, redirectTo: 'ou_aven' })
      registerRepoProfiles({ repos: { falive: faliveRaw } })
      assert.equal(resolveRepoDelivery('oc_falive_1'), null)
      assert.equal(resolveWebhookCredentials(normalizeRepoProfile('xx', { ...faliveRaw, webhook: { file: join(dir, 'missing.json') } })), null)
    } finally {
      resetRepoProfiles()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('归属闸', () => {
  const profile = normalizeRepoProfile('falive', faliveRaw)
  it('mine=false 且触发人不是本人 → no_change_needed(other_owner) 带 owner；本人触发放行；无判定放行', () => {
    const skipped = resolveOwnershipOutcome({ profile, task: { operator: 'ou_henry' }, analysis: { summary: 's', ownership: { mine: false, owner: 'henry', featureIds: ['#32'] } } })
    assert.equal(skipped.proceed, false)
    assert.equal(skipped.result.status, 'no_change_needed')
    assert.equal(skipped.result.noChangeReason, 'other_owner')
    assert.equal(skipped.result.owner, 'henry')
    assert.match(skipped.result.summary, /#32/)
    assert.equal(resolveOwnershipOutcome({ profile, task: { operator: 'ou_aven' }, analysis: { ownership: { mine: false, owner: 'henry', featureIds: [] } } }).proceed, true)
    assert.equal(resolveOwnershipOutcome({ profile, task: {}, analysis: { ownership: { mine: true, owner: null, featureIds: [] } } }).proceed, true)
    assert.equal(resolveOwnershipOutcome({ profile, task: {}, analysis: { ownership: null } }).proceed, true)
    assert.equal(resolveOwnershipOutcome({ profile: repoProfile(DEFAULT_REPO_KEY), task: {}, analysis: { ownership: { mine: false, owner: 'x', featureIds: [] } } }).proceed, true)
  })
})
