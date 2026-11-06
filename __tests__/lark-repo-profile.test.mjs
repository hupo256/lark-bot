import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { eachCase, runSteps } from './support/steps.mjs'

import {
  DEFAULT_POLL,
  DEFAULT_REPO_KEY,
  addRepoChatIds,
  buildRepoRegistry,
  normalizeRepoProfile,
  registerRepoProfiles,
  repoProfile,
  repoProfileForChat,
  repoProfileForTask,
  resetRepoProfiles,
  resolveRepoDelivery,
  resolveWebhookCredentials,
  resolveWebhookForChat,
  tempBranchNameFor,
  validateRepoProfiles,
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

// 每段（= 合并前的一个原 it）结束都清掉注册的仓配置，等价原来各 describe 的 afterEach
const hooks = { after: () => resetRepoProfiles() }

describe('repo profile 归一与注册', () => {
  it('归一：默认 profile 沿用 fameex 单仓行为、非默认仓的路径 / 分支 / fetch 规则、缺字段或重复在注册期报错', () => runSteps([
    ['默认 profile = fameex 单仓原行为（origin/online、hotfix 前缀、.lark-hotfix）', () => {
      const profile = repoProfile(DEFAULT_REPO_KEY)
      assert.equal(profile.isDefault, true)
      assert.equal(profile.baseRef, 'origin/online')
      assert.equal(profile.fetchBase, true)
      assert.equal(tempBranchNameFor(profile, { project: 'PR-00001', suffix: 'abcd1234' }), 'hotfix/PR-00001-abcd1234')
      assert.equal(tempBranchNameFor(profile, { project: null, suffix: 'abcd1234' }), 'hotfix/adhoc-abcd1234')
      assert.ok(profile.tempWorktreeDir.endsWith('/.lark-hotfix'), '默认 profile 临时 worktree 在 .lark-hotfix')
    }],
    ['非默认仓：projectKey 大写、本地分支不 fetch、临时 worktree 落在同级 .lark-<key>、分支 <prefix>-<后缀>', () => {
      const falive = normalizeRepoProfile('falive', faliveRaw)
      assert.equal(falive.projectKey, 'FALIVE', '非默认仓 projectKey 大写')
      assert.equal(falive.fetchBase, false, '非默认仓本地分支不 fetch')
      assert.equal(falive.worktreesDir, '/tmp/.lark-falive')
      assert.equal(falive.tempWorktreeDir, '/tmp/.lark-falive')
      assert.equal(falive.branchPrefix, 'lark/falive')
      assert.equal(tempBranchNameFor(falive, { project: 'FALIVE', suffix: 'abcd1234' }), 'lark/falive-abcd1234')
      assert.equal(falive.ownership.table, '/tmp/falive-react/docs/table.md')
      assert.equal(normalizeRepoProfile('xx', { ...faliveRaw, baseRef: 'origin/main' }).fetchBase, true)
      // 合回负责人工作分支（10-27）：只认对象；没配 / 配成别的类型 = 不合回
      const mergeBackOf = (mergeBack) => normalizeRepoProfile('xx', { ...faliveRaw, mergeBack }).mergeBack
      assert.deepEqual(mergeBackOf({ upstream: 'origin/pre' }), { upstream: 'origin/pre' })
      assert.deepEqual(mergeBackOf({}), { upstream: null })
      assert.equal(mergeBackOf(undefined), null)
      assert.equal(mergeBackOf('origin/pre'), null)
    }],
    ['缺 root / baseRef、projectKey 或群重复都在注册期报错', () => {
      assert.throws(() => normalizeRepoProfile('a', { baseRef: 'main' }), /root 必填/)
      assert.throws(() => normalizeRepoProfile('a', { root: '/tmp/a' }), /baseRef 必填/)
      assert.throws(() => buildRepoRegistry({ repos: { a: { ...faliveRaw, projectKey: 'XX' }, b: { ...faliveRaw, projectKey: 'XX', chatIds: ['oc_other'] } } }), /projectKey XX 重复/)
      assert.throws(() => buildRepoRegistry({ repos: { a: { ...faliveRaw, projectKey: 'AA' }, b: { ...faliveRaw, projectKey: 'BB' } } }), /oc_falive_1 同时属于/)
    }],
    ['外部群分类去抖按 intake 配置分道（旧 intakeDebounceMs 只兜 quietGapMs）；排队卡缺省只发私聊、显式 false 才回群（变异补测 10-24）', () => {
      const tuned = normalizeRepoProfile('falive', { ...faliveRaw, intake: { fastLaneMs: 5000, quietGapMs: 30_000, maxWaitMs: 90_000 }, intakeDebounceMs: 120_000 })
      assert.deepEqual(tuned.intake, { fastLaneMs: 5000, quietGapMs: 30_000, maxWaitMs: 90_000 }, '配了 intake 就照读，不被旧字段盖掉')
      assert.equal(tuned.intakeDebounceMs, 30_000, '旧引用 = quietGapMs')
      const legacy = normalizeRepoProfile('falive', { ...faliveRaw, intakeDebounceMs: 120_000 })
      assert.deepEqual(legacy.intake, { fastLaneMs: 0, quietGapMs: 120_000, maxWaitMs: 180_000 }, '只有旧字段：当 quietGapMs，其余缺省')
      assert.deepEqual(normalizeRepoProfile('falive', faliveRaw).intake, { fastLaneMs: 0, quietGapMs: 60_000, maxWaitMs: 180_000 })
      assert.equal(normalizeRepoProfile('falive', faliveRaw).quietQueuedCards, true, '缺省排队卡只发负责人私聊')
      assert.equal(normalizeRepoProfile('falive', { ...faliveRaw, quietQueuedCards: false }).quietQueuedCards, false, '显式 false 才发回群')
    }],
    ['仓配置字段归一：配了照读（trim）、缺省 / 空串 / 非法类型回落缺省值，null 不让启动崩（变异补测 10-24）', () => eachCase([
      { name: '默认仓允许覆盖标题 / 人员表 / 模型 / 超时', actual: () => {
        const p = normalizeRepoProfile('fameex', { title: ' FameEX ', ownerMap: { henry: 'ou_henry' }, claudeModel: 'm1', claudeEffort: 'e1', claudeAnalysisModel: 'm2', claudeAnalysisEffort: 'e2', claudeIntentModel: 'm3', claudeIntentEffort: 'e3', aiTimeoutMs: 1000 })
        return [p.title, p.ownerMap, p.claudeModel, p.claudeEffort, p.claudeAnalysisModel, p.claudeAnalysisEffort, p.claudeIntentModel, p.claudeIntentEffort, p.aiTimeoutMs]
      }, expect: ['FameEX', { henry: 'ou_henry' }, 'm1', 'e1', 'm2', 'e2', 'm3', 'e3', 1000] },
      { name: '默认仓：空标题 / ownerMap null / ownerMap 非对象 / 超时 0 回落缺省', actual: () => {
        const p = normalizeRepoProfile('fameex', { title: '  ', ownerMap: null, aiTimeoutMs: 0 })
        return [p.title, p.ownerMap, normalizeRepoProfile('fameex', { ownerMap: 'x' }).ownerMap, p.aiTimeoutMs, p.claudeModel]
      }, expect: [null, {}, {}, null, null] },
      { name: 'root 写 ~ / ~/x 展开到 home 目录', actual: () => [normalizeRepoProfile('falive', { ...faliveRaw, root: '~/falive-react' }).root, normalizeRepoProfile('falive', { ...faliveRaw, root: '~' }).root], expect: [join(homedir(), 'falive-react'), homedir()] },
      { name: 'memberRoles 只留键值都非空的字符串并 trim；字符串 / null 视为没配', actual: () => [
        normalizeRepoProfile('falive', { ...faliveRaw, memberRoles: { henry: ' 后端 ', blank: '  ', num: 3 } }).memberRoles,
        normalizeRepoProfile('falive', { ...faliveRaw, memberRoles: 'abc' }).memberRoles,
        normalizeRepoProfile('falive', { ...faliveRaw, memberRoles: null }).memberRoles,
      ], expect: [{ henry: '后端' }, {}, {}] },
      { name: 'intake null → 缺省；fastLaneMs 负数 / 无穷大 → 0', actual: () => [
        normalizeRepoProfile('falive', { ...faliveRaw, intake: null }).intake,
        normalizeRepoProfile('falive', { ...faliveRaw, intake: { fastLaneMs: -5 } }).intake.fastLaneMs,
        normalizeRepoProfile('falive', { ...faliveRaw, intake: { fastLaneMs: Infinity } }).intake.fastLaneMs,
      ], expect: [{ fastLaneMs: 0, quietGapMs: 60_000, maxWaitMs: 180_000 }, 0, 0] },
      { name: '非默认仓字符串字段配了照读', actual: () => {
        const p = normalizeRepoProfile('falive', { ...faliveRaw, ledgerDocPattern: '^待', checksHint: 'pnpm check', commitPrefix: 'feat(bot)', docReplyDir: 'docs/answers' })
        return [p.ledgerDocPattern, p.checksHint, p.commitPrefix, p.docReplyDir]
      }, expect: ['^待', 'pnpm check', 'feat(bot)', 'docs/answers'] },
      { name: '非默认仓：超时 0 → null、ownerMap null → {}、并发 1 照读 / 缺省 3', actual: () => {
        const p = normalizeRepoProfile('falive', { ...faliveRaw, aiTimeoutMs: 0, ownerMap: null, concurrency: 1 })
        return [p.aiTimeoutMs, p.ownerMap, p.concurrency, normalizeRepoProfile('falive', faliveRaw).concurrency]
      }, expect: [null, {}, 1, 3] },
      { name: 'docReplyDir 缺省 = 收件目录的兄弟 reply；收件目录只有一层 → ./reply；都没配 → null', actual: () => [
        normalizeRepoProfile('falive', { ...faliveRaw, docIntakeDir: 'docs/delivery/pending/' }).docReplyDir,
        normalizeRepoProfile('falive', { ...faliveRaw, docIntakeDir: 'pending' }).docReplyDir,
        normalizeRepoProfile('falive', faliveRaw).docReplyDir,
      ], expect: ['docs/delivery/reply', './reply', null] },
      { name: 'botMentionOpenIds / chatLabels：null → {}，值为空或非字符串的项丢掉', actual: () => {
        const map = { oc_a: 'ou_bot', oc_b: '', oc_c: 5 }
        const p = normalizeRepoProfile('falive', { ...faliveRaw, botMentionOpenIds: map, chatLabels: map })
        const empty = normalizeRepoProfile('falive', { ...faliveRaw, botMentionOpenIds: null, chatLabels: null })
        return [p.botMentionOpenIds, p.chatNameById, empty.botMentionOpenIds, empty.chatNameById]
      }, expect: [{ oc_a: 'ou_bot' }, { oc_a: 'ou_bot' }, {}, {}] },
      { name: 'webhooksByChat：null → {}，配置无效的群丢掉；webhook 只写 webhookUrl 也认、secret 照读、null → null', actual: () => {
        const p = normalizeRepoProfile('falive', { ...faliveRaw, webhooksByChat: { G1: { url: 'https://g1' }, G2: {} }, webhook: { webhookUrl: 'https://w', secret: 's' } })
        const empty = normalizeRepoProfile('falive', { ...faliveRaw, webhooksByChat: null, webhook: null })
        return [p.webhooksByChat, p.webhook, empty.webhooksByChat, empty.webhook]
      }, expect: [{ G1: { file: null, url: 'https://g1', secret: null } }, { file: null, url: 'https://w', secret: 's' }, {}, null] },
      { name: 'ownership null → null；principalReplyWindowMs 0 → 缺省 12 小时', actual: () => {
        const p = normalizeRepoProfile('falive', { ...faliveRaw, ownership: null, principalReplyWindowMs: 0 })
        return [p.ownership, p.principalReplyWindowMs]
      }, expect: [null, 12 * 60 * 60 * 1000] },
      { name: 'finalChecks：null → null；配了照读，timeoutMs 缺省 10 分钟', actual: () => [
        normalizeRepoProfile('falive', { ...faliveRaw, finalChecks: null }).finalChecks,
        normalizeRepoProfile('falive', { ...faliveRaw, finalChecks: { typecheck: ['pnpm', 'typecheck'], timeoutMs: 5000 } }).finalChecks,
        normalizeRepoProfile('falive', { ...faliveRaw, finalChecks: {} }).finalChecks,
      ], expect: [null, { typecheck: ['pnpm', 'typecheck'], tests: null, timeoutMs: 5000 }, { typecheck: null, tests: null, timeoutMs: 10 * 60_000 }] },
      { name: 'verify：配齐照读；只配 probeCommand → env pre、localDev 随 env、其余空串 / 缺省正则', actual: () => {
        const full = { probeCommand: ' probe ', env: 'uat', usage: 'u', schemaCheck: 'sc', schemaFiles: 'sf', requestMarker: 'rm', writeMail: 'wm', localDev: 'ld', siteUrl: 'https://s', pageTool: 'pt' }
        return [
          normalizeRepoProfile('falive', { ...faliveRaw, verify: full }).verify,
          normalizeRepoProfile('falive', { ...faliveRaw, verify: { probeCommand: 'probe' } }).verify,
          normalizeRepoProfile('falive', { ...faliveRaw, verify: { probeCommand: 'probe', env: 'uat' } }).verify.localDev,
        ]
      }, expect: [
        { probeCommand: 'probe', env: 'uat', usage: 'u', schemaCheck: 'sc', schemaFiles: 'sf', requestMarker: 'rm', writeMail: 'wm', localDev: 'ld', siteUrl: 'https://s', pageTool: 'pt' },
        { probeCommand: 'probe', env: 'pre', usage: '', schemaCheck: '', schemaFiles: '/data/(schema|queries)\\.ts$', requestMarker: '', writeMail: '', localDev: 'pnpm dev:pre', siteUrl: '', pageTool: '' },
        'pnpm dev:uat',
      ] },
    ], ({ actual, expect }) => assert.deepEqual(actual(), expect))],
    ['轮询参数归一：null / false / 非法工作时段回落缺省，0 与 24 是合法边界（变异补测 10-24）', () => eachCase([
      { name: 'poll null → 全缺省', poll: null, pick: (p) => p, expect: { ...DEFAULT_POLL } },
      { name: '缺 enabled 即启用', poll: {}, pick: (p) => p.enabled, expect: true },
      { name: 'enabled:false 只配不跑', poll: { enabled: false }, pick: (p) => p.enabled, expect: false },
      { name: '配了间隔照读', poll: { activeMs: 5000 }, pick: (p) => p.activeMs, expect: 5000 },
      { name: '间隔 0 回落缺省', poll: { activeMs: 0 }, pick: (p) => p.activeMs, expect: DEFAULT_POLL.activeMs },
      { name: '工作时段两项合法照读', poll: { workHours: [9, 18] }, pick: (p) => p.workHours, expect: [9, 18] },
      { name: '工作时段 0 与 24 是合法边界', poll: { workHours: [0, 24] }, pick: (p) => p.workHours, expect: [0, 24] },
      { name: '工作时段不是两项 → 缺省', poll: { workHours: [9, 18, 20] }, pick: (p) => p.workHours, expect: [8, 19] },
      { name: '工作时段非整数 → 缺省', poll: { workHours: [8.5, 18] }, pick: (p) => p.workHours, expect: [8, 19] },
      { name: '工作时段负数 → 缺省', poll: { workHours: [-1, 18] }, pick: (p) => p.workHours, expect: [8, 19] },
      { name: '工作时段超过 24 → 缺省', poll: { workHours: [8, 30] }, pick: (p) => p.workHours, expect: [8, 19] },
    ], ({ poll, pick, expect }) => assert.deepEqual(pick(normalizeRepoProfile('falive', { ...faliveRaw, poll }).poll), expect))],
    ['日报配置归一：缺 at 报错带「(空)」、字段照读或回落缺省、清扫超时非正回落 90 分钟、检查项过滤不完整的（变异补测 10-24）', () => {
      const report = (dailyReport) => normalizeRepoProfile('falive', { ...faliveRaw, dailyReport }).dailyReport
      assert.equal(report(null), null)
      assert.throws(() => report({ at: '' }), /实际：\(空\)/)
      const minimal = report({ at: '19:00' })
      assert.deepEqual([minimal.to, minimal.othersRef, minimal.fetch, minimal.people, minimal.model, minimal.effort, minimal.docEffort, minimal.siteUrl, minimal.schemaCheckCommand, minimal.probeMail, minimal.sweep, minimal.featureChecks, minimal.schemaChecks, minimal.streamCheck],
        [null, 'origin/pre', true, {}, null, null, null, null, null, null, null, [], [], null])
      const full = report({ at: '19:00', to: 'ou_aven', othersRef: 'origin/main', fetch: false, people: { aven: ['aven'] }, model: 'm', effort: 'e', docEffort: 'de', siteUrl: 'https://pre', schemaCheckCommand: 'pnpm sc', probeMail: 'a@b.c' })
      assert.deepEqual([full.to, full.othersRef, full.fetch, full.people, full.model, full.effort, full.docEffort, full.siteUrl, full.schemaCheckCommand, full.probeMail],
        ['ou_aven', 'origin/main', false, { aven: ['aven'] }, 'm', 'e', 'de', 'https://pre', 'pnpm sc', 'a@b.c'])
      assert.deepEqual(report({ at: '19:00', people: null }).people, {})
      const sweep = (value) => report({ at: '19:00', sweep: value }).sweep
      assert.equal(sweep(null), null)
      assert.deepEqual(sweep({}), { preSiteUrl: null, timeoutMs: 90 * 60_000, effort: 'high' })
      assert.equal(sweep({ timeoutMinutes: -5 }).timeoutMs, 90 * 60_000, '负数回落 90 分钟')
      assert.equal(sweep({ timeoutMinutes: 0 }).timeoutMs, 90 * 60_000, '0 回落 90 分钟')
      assert.equal(sweep({ timeoutMinutes: 30 }).timeoutMs, 30 * 60_000)
      const checks = report({ at: '19:00',
        featureChecks: [{ path: ' /api/a ', label: 'A', params: { x: 1 }, pick: 'list', expect: 'ok', host: 'go', features: [36, 'x'] }, { path: '/api/b' }, { label: '没 path' }, { path: '/api/c', params: null }],
        streamCheck: { path: '/s', params: { id: 1 }, features: [1] },
        schemaChecks: [{ module: 'm', export: 'e', path: 'p' }, { module: 'm' }, { export: 'e', path: 'p' }, { path: 'p' }, { module: 'm', export: 'e' }] })
      assert.deepEqual(checks.featureChecks, [
        { features: [36], label: 'A', path: '/api/a', params: { x: 1 }, pick: 'list', expect: 'ok', host: 'go' },
        { features: [], label: '/api/b', path: '/api/b', params: {}, pick: null, expect: 'nonEmpty', host: null },
        { features: [], label: '/api/c', path: '/api/c', params: {}, pick: null, expect: 'nonEmpty', host: null },
      ])
      assert.deepEqual(checks.streamCheck, { features: [1], path: '/s', params: { id: 1 } })
      assert.deepEqual(report({ at: '19:00', streamCheck: { path: '/s', params: null } }).streamCheck.params, {})
      assert.deepEqual(checks.schemaChecks, [{ module: 'm', export: 'e', path: 'p' }], 'module / export / path 缺一不收')
    }],
  ], hooks))

  it('注册前 FALIVE 不是合法项目号、validateConfig 校验 root 存在；注册后群 / 任务 → 仓、safeProject、标题取 profile.title', () => runSteps([
    ['注册后：群 → 仓、任务 → 仓（repo 键或 project 反查）、projectKey 过 safeProject、标题取 profile.title', () => {
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
    }],
    ['未注册时 FALIVE 不是合法项目号（不会把陌生大写词当项目路由）', () => {
      assert.equal(safeProject('FALIVE'), '', '未注册时 FALIVE 不是合法项目号')
    }],
    ['validateConfig 对 repos 做存在性校验（root 不存在即 error）', () => {
      const { errors } = validateConfig({ project: 'PR-00001', botOpenId: 'ou_bot', allowedChatIds: 'auto', repos: { falive: faliveRaw } })
      assert.ok(errors.some((line) => /repos\.falive\.root 不存在/.test(line)), errors.join('\n'))
    }],
    ['注册表：repos 为 null 只有默认仓、repos.fameex 的覆盖生效；运行期并入群 id 不丢已有群名；归属表存在 / 未配不报错（变异补测 10-24）', () => {
      assert.deepEqual([...buildRepoRegistry({ repos: null }).keys()], [DEFAULT_REPO_KEY])
      assert.equal(buildRepoRegistry({ repos: { fameex: { claudeModel: 'm' } } }).get(DEFAULT_REPO_KEY).claudeModel, 'm')
      registerRepoProfiles({ repos: { falive: { ...faliveRaw, chatLabels: { oc_falive_1: 'Falive 群' } } } })
      assert.deepEqual(addRepoChatIds('falive', ['oc_2', 'oc_falive_1'], { oc_2: 'G2' }), ['oc_falive_1', 'oc_2'])
      assert.deepEqual(repoProfile('falive').chatNameById, { oc_falive_1: 'Falive 群', oc_2: 'G2' })
      const root = mkdtempSync(join(tmpdir(), 'lark-repo-root-'))
      try {
        mkdirSync(join(root, '.git'))
        mkdirSync(join(root, 'docs'))
        writeFileSync(join(root, 'docs', 'table.md'), '')
        assert.deepEqual(validateRepoProfiles({ repos: { falive: { ...faliveRaw, root } } }), [], '归属表存在不报错')
        assert.deepEqual(validateRepoProfiles({ repos: { falive: { ...faliveRaw, root, ownership: null } } }), [], '没配归属不报错')
        assert.ok(validateRepoProfiles({ repos: { falive: { ...faliveRaw, root, ownership: { me: 'aven', table: 'docs/none.md' } } } }).some((line) => /ownership\.table 不存在/.test(line)))
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }],
  ], hooks))
})

describe('工作上下文按 profile 路由', () => {
  it('falive 改动任务 / 只读任务 / 默认仓任务的上下文形状，仓库不一致时路由校验失败', () => runSteps([
    ['falive 任务：临时 worktree 在 .lark-falive、分支 lark/falive-*、基线为 profile.baseRef 且不 fetch、带仓库字段', () => {
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
    }],
    ['falive 只读任务在仓库根回答；默认仓任务形状不变', () => {
      registerRepoProfiles({ repos: { falive: faliveRaw } })
      const readOnly = resolveWorkContext({}, { id: 'om_1', repo: 'falive', project: 'FALIVE', text: '状态：进度到哪了', commandType: 'status' })
      assert.equal(readOnly.cwd, '/tmp/falive-react', 'falive 只读任务在仓库根回答')
      assert.equal(readOnly.readOnly, true)
      assert.equal(validateWorkContextRoute({ task: { id: 'om_1', repo: 'falive', project: 'FALIVE', commandType: 'status' }, workContext: readOnly }).ok, true)
      const fameex = resolveWorkContext({}, { id: 'om_yyyyyyyy12345678', project: 'PR-00001', text: '修复：x' })
      assert.equal(fameex.hotfixBranch, 'hotfix/PR-00001-12345678', '默认仓任务形状不变')
      assert.equal(fameex.baseRef, undefined)
      assert.equal(fameex.repo, DEFAULT_REPO_KEY)
    }],
    ['任务仓库与上下文仓库不一致时路由校验失败', () => {
      registerRepoProfiles({ repos: { falive: faliveRaw } })
      const mismatchTask = { id: 'om_1', repo: 'falive', project: 'FALIVE', text: 'x' }
      const mismatch = { ...resolveWorkContext({}, mismatchTask), repo: 'fameex' }
      assert.equal(validateWorkContextRoute({ task: mismatchTask, workContext: mismatch }).ok, false, '任务仓库与上下文仓库不一致时路由校验失败')
    }],
  ], hooks))
})

describe('claude 模型 / 推理强度按 profile', () => {
  it('resolveAiModelConfig 优先级（profile > claudeModel > 旧键 model，intent 单独）；claude 四种命令带 --model / --effort 与 --add-dir', () => runSteps([
    ['resolveAiModelConfig：profile > claudeModel > 旧键 model；intent 模型 / 强度单独', () => {
      const profile = normalizeRepoProfile('falive', faliveRaw)
      assert.deepEqual(resolveAiModelConfig({ model: 'old' }, 'claude'), { model: 'old', reasoningEffort: null, provider: null, intentModel: 'old', intentEffort: null, analysisModel: 'old', analysisEffort: null })
      assert.deepEqual(resolveAiModelConfig({ claudeModel: 'opus', claudeEffort: 'high' }, 'claude'), { model: 'opus', reasoningEffort: 'high', provider: null, intentModel: 'opus', intentEffort: 'high', analysisModel: 'opus', analysisEffort: 'high' })
      assert.deepEqual(resolveAiModelConfig({ claudeModel: 'opus' }, 'claude', profile), { model: 'claude-fable-5-1', reasoningEffort: 'medium', provider: null, intentModel: 'claude-sonnet-5-5', intentEffort: 'medium', analysisModel: 'claude-opus-4-8', analysisEffort: 'high' })
      assert.equal(resolveAiModelConfig({}, 'claude', normalizeRepoProfile('falive', { ...faliveRaw, claudeIntentEffort: 'high' })).intentEffort, 'high', 'intent 强度单独')
    }],
    ['claude 四种命令都带 --model / --effort，任务模式把 profile.readableDirs 放进 --add-dir', () => {
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
    }],
  ]))
})

describe('webhook 发卡', () => {
  it('签名与 body、sendWebhookMessage 重试策略、投递决策（webhook / notifyChatId 改投 / 默认仓不改）', () => runSteps([
    ['签名与 body：有 secret 带 timestamp/sign，卡片 JSON 原样内嵌', () => {
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
    }],
    ['sendWebhookMessage：成功无 messageId；4xx 带 code 不重试；5xx 重试', async () => {
      const calls = []
      const ok = await sendWebhookMessage({ url: 'https://x', secret: 's', card: '{"a":1}', fetchImpl: async (url, init) => { calls.push(JSON.parse(init.body)); return { ok: true, status: 200, text: async () => '{"code":0}' } } })
      assert.deepEqual(ok, { ok: true, messageId: null }, 'sendWebhookMessage：成功无 messageId')
      assert.equal(calls[0].card.a, 1)
      let attempts = 0
      const bad = await sendWebhookMessage({ url: 'https://x', card: '{}', retries: 3, sleepImpl: async () => {}, fetchImpl: async () => { attempts += 1; return { ok: false, status: 400, text: async () => '{"code":19001,"msg":"param invalid"}' } } })
      assert.equal(bad.ok, false)
      assert.equal(attempts, 1, '4xx 带 code 不重试')
      attempts = 0
      const flaky = await sendWebhookMessage({ url: 'https://x', card: '{}', retries: 3, sleepImpl: async () => {}, fetchImpl: async () => { attempts += 1; return attempts < 3 ? { ok: false, status: 502, text: async () => 'bad gateway' } : { ok: true, status: 200, text: async () => '{"code":0}' } } })
      assert.equal(flaky.ok, true)
      assert.equal(attempts, 3, '5xx 重试')
    }],
    ['投递决策：有 webhook 走 webhook，无 webhook 有 notifyChatId 改投，默认仓的群不改', () => {
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
    }],
    ['按群名配的 webhook：chat_id 经 chatLabels 反查群名命中，没配的群回落 profile.webhook；notifyChatId 就是本群时不改投（变异补测 10-24）', () => {
      const raw = { ...faliveRaw, chatIds: ['oc_falive_1', 'oc_9'], chatLabels: { oc_9: 'G9' }, webhooksByChat: { G9: { url: 'https://g9', secret: 's9' } } }
      const profile = normalizeRepoProfile('falive', { ...raw, webhook: { url: 'https://fallback' } })
      assert.deepEqual(resolveWebhookCredentials(profile, 'oc_9'), { url: 'https://g9', secret: 's9' })
      assert.deepEqual(resolveWebhookCredentials(profile, 'oc_unknown'), { url: 'https://fallback', secret: null })
      try {
        registerRepoProfiles({ repos: { falive: raw } })
        assert.deepEqual(resolveWebhookForChat('oc_9'), { url: 'https://g9', secret: 's9' })
        assert.equal(resolveWebhookForChat('oc_falive_1'), null)
        registerRepoProfiles({ repos: { falive: { ...faliveRaw, notifyChatId: 'oc_falive_1' } } })
        assert.equal(resolveRepoDelivery('oc_falive_1'), null, '不改投回同一个群')
      } finally {
        resetRepoProfiles()
      }
    }],
  ]))
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
    assert.equal(resolveOwnershipOutcome({ profile, task: { contract: { expectsCode: false } }, analysis: { ownership: { mine: false, owner: 'henry', featureIds: [] } } }).proceed, true, '复测 / 查找不改代码：不按归属跳过（10-24）')
    assert.equal(resolveOwnershipOutcome({ profile: repoProfile(DEFAULT_REPO_KEY), task: {}, analysis: { ownership: { mine: false, owner: 'x', featureIds: [] } } }).proceed, true)
  })
})
