import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildVerifyPassPrompt, decodeGitPath, interfaceChanges, parseUnifiedDiff, resolveSchemaVerifyGate, runVerifyPass, scopedInterfaceFiles } from '../lib/lark-schema-verify.mjs'
import { buildVerifyRule } from '../lib/lark-completion-rule.mjs'
import { resolveScopeGate } from '../lib/lark-scope-contract.mjs'

// 10-22 新闻详情页（教训 #66）真实 `git diff -U0 HEAD -- schema.ts`：只删了三个响应字段 + 改一行注释。
const NEWS_SCHEMA_DIFF = "diff --git a/src/modules/news/data/schema.ts b/src/modules/news/data/schema.ts\nindex 83f7793..5989702 100644\n--- a/src/modules/news/data/schema.ts\n+++ b/src/modules/news/data/schema.ts\n@@ -22 +22 @@ export const newsDetailSchema = newsItemSchema.extend({\n-  /** 发布人头像 / 签名 / 阅读数 / 评论数（klive avatar / signature / click / comment_count），缺省不渲染。 */\n+  /** 发布人头像（klive avatar，同 x9 HeadlineDetail），缺省走 Avatar 兜底。 */\n@@ -24,3 +23,0 @@ export const newsDetailSchema = newsItemSchema.extend({\n-  signature: z.string().optional(),\n-  click: z.number().optional(),\n-  commentCount: z.number().optional(),\n@@ -105,3 +101,0 @@ export const kliveHeadlineDetailSchema = z.object({\n-      signature: z.string().nullish(),\n-      click: z.number().nullish(),\n-      comment_count: z.number().nullish(),\n"
const VERIFY = { env: 'pre', schemaFiles: '/data/(schema|queries)\\.ts$' }
const UNREACHABLE = [{ endpoint: '/api/Headlines/getInfo', outcome: 'UNREACHABLE：pre 连不上', kind: 'unreachable' }]
const QUERIES_DIFF = [
  'diff --git a/src/modules/news/data/queries.ts b/src/modules/news/data/queries.ts',
  '--- a/src/modules/news/data/queries.ts',
  '+++ b/src/modules/news/data/queries.ts',
  '@@ -70 +70 @@',
  '-        request("x9", "/api/Headlines/getInfo", { id }),',
  '+        request("x9", "/api/Headlines/getDetail", { id, lang }),',
].join('\n')

describe('接口实测闸只按真实 diff 触发（#66）', () => {
  it('只删响应字段、改注释 → 不算接口改动，不要求 pre 实测', () => {
    const files = ['src/modules/news/data/schema.ts', 'src/modules/news/data/mappers.ts', 'src/modules/news/data/mock.ts']
    assert.deepEqual(interfaceChanges({ changedFiles: files, diffText: NEWS_SCHEMA_DIFF, schemaFiles: VERIFY.schemaFiles }), [])
    assert.equal(resolveSchemaVerifyGate({ verify: VERIFY, changedFiles: files, preChecks: UNREACHABLE, taskId: 't', readDiff: () => NEWS_SCHEMA_DIFF }), null)
  })

  it('没动范围内文件 → 不读 diff、不触发', () => {
    let read = 0
    assert.equal(resolveSchemaVerifyGate({ verify: VERIFY, changedFiles: ['src/modules/news/NewsDetailPage.tsx'], readDiff: () => { read += 1; return '' } }), null)
    assert.equal(read, 0)
  })

  it('请求换接口 / 改参数 + pre 连不上 → 不挂待确认、不扣改动（aven 2026-10-22），如实说改了哪、为什么没测', () => {
    const gate = resolveSchemaVerifyGate({ verify: VERIFY, changedFiles: ['src/modules/news/data/queries.ts'], preChecks: UNREACHABLE, taskId: 'om_x', readDiff: () => QUERIES_DIFF })
    assert.equal(gate.status, null)
    assert.equal(gate.unverified, true)
    assert.equal(gate.change, null)
    assert.match(gate.note, /改了对后端的请求（src\/modules\/news\/data\/queries\.ts：request\("x9", "\/api\/Headlines\/getDetail"/)
    assert.match(gate.note, /pre 连不上（1 条实测都没通）/)
    assert.match(gate.note, /代码照常提交/)
    assert.doesNotMatch(gate.note, /待补充|取消任务|没提交/)
  })

  it('没测通先续会话补测一轮：只测不改、本地起 dev 连 pre 后端；新 preChecks 并回结果；非 claude / 没会话不跑', async () => {
    const verify = { env: 'pre', probeCommand: 'node scripts/pre-probe.mjs', localDev: 'pnpm dev:pre' }
    const prompt = buildVerifyPassPrompt({ verify, changes: [{ path: 'a/queries.ts', side: 'request', line: 'x' }] })
    assert.match(prompt, /只测不改/)
    assert.match(prompt, /pnpm dev:pre/)
    assert.match(prompt, /node scripts\/pre-probe\.mjs/)
    const calls = []
    const aiRun = { executor: 'claude', sessionId: 's1', result: { status: 'done', summary: 'old', preChecks: [], report: null } }
    const exec = async (opts) => { calls.push(opts); return { sessionId: 's2', result: { summary: 'new', preChecks: [{ endpoint: '/api/x', outcome: 'code 0', kind: 'ok' }], report: { subject: 's', answer: null, items: [] } } } }
    assert.equal(await runVerifyPass({ task: { id: 't' }, aiRun, verify, changes: [], exec }), true)
    assert.equal(calls[0].resumeSessionId, 's1')
    assert.equal(aiRun.result.status, 'done', '其余字段照旧')
    assert.equal(aiRun.result.preChecks[0].kind, 'ok')
    assert.equal(aiRun.verifySessionId, 's2')
    assert.equal(await runVerifyPass({ task: { id: 't' }, aiRun: { executor: 'codex', sessionId: 's' }, verify, changes: [], exec }), false)
    assert.equal(await runVerifyPass({ task: { id: 't' }, aiRun: { executor: 'claude', result: {} }, verify, changes: [], exec }), false)
    assert.equal(await runVerifyPass({ task: { id: 't' }, aiRun: { executor: 'claude', sessionId: 's', result: {} }, verify, changes: [], exec: async () => { throw new Error('boom') } }), false, '跑挂了照常交付')
  })

  it('请求侧只删一个参数也算；没跑实测和连不上分开说', () => {
    const diff = 'diff --git a/x/data/queries.ts b/x/data/queries.ts\n--- a/x/data/queries.ts\n+++ b/x/data/queries.ts\n@@ -3 +2,0 @@\n-      uid: params.uid,'
    const gate = resolveSchemaVerifyGate({ verify: VERIFY, changedFiles: ['x/data/queries.ts'], preChecks: [], taskId: 't', readDiff: () => diff })
    assert.match(gate.note, /这轮没在 pre 实测/)
  })

  it('响应 schema 加字段 → 算；实测通过照常交付，有 issues 降级 failed', () => {
    const diff = 'diff --git a/x/data/schema.ts b/x/data/schema.ts\n--- a/x/data/schema.ts\n+++ b/x/data/schema.ts\n@@ -3,0 +4 @@\n+  click: z.number(),'
    const args = { verify: VERIFY, changedFiles: ['x/data/schema.ts'], taskId: 't', readDiff: () => diff }
    assert.equal(resolveSchemaVerifyGate({ ...args, preChecks: [{ endpoint: '/api/a', outcome: 'ok', kind: 'ok' }] }).status, null)
    const broken = resolveSchemaVerifyGate({ ...args, preChecks: [{ endpoint: '/api/a', outcome: 'issues: click 期望 number', kind: 'issues' }] })
    assert.equal(broken.status, 'failed')
    assert.equal(broken.change.gate, 'schema')
    assert.equal(resolveSchemaVerifyGate({ ...args, preChecks: UNREACHABLE }).changes[0].side, 'response')
  })

  it('挪位置 / 补逗号 / 只改注释不算；读不到 diff 按改了算（fail-closed）', () => {
    const moved = 'diff --git a/x/data/queries.ts b/x/data/queries.ts\n--- a/x/data/queries.ts\n+++ b/x/data/queries.ts\n@@ -3,2 +3,2 @@\n-  a: 1,\n-  // 旧注释\n+  a: 1\n+  // 新注释'
    assert.deepEqual(interfaceChanges({ changedFiles: ['x/data/queries.ts'], diffText: moved, schemaFiles: VERIFY.schemaFiles }), [])
    assert.equal(interfaceChanges({ changedFiles: ['x/data/queries.ts'], diffText: '', schemaFiles: VERIFY.schemaFiles })[0].side, 'unknown')
  })

  it('正文里 --- / +++ 开头的行不当文件头；quotepath 没关的中文路径能还原', () => {
    const diff = 'diff --git a/x/data/queries.ts b/x/data/queries.ts\n--- a/x/data/queries.ts\n+++ b/x/data/queries.ts\n@@ -1 +1 @@\n--- old\n+++ new'
    assert.equal(parseUnifiedDiff(diff)[0].path, 'x/data/queries.ts')
    assert.equal(decodeGitPath('"b/docs/delivery/pending/\\346\\226\\260\\351\\227\\273.md"'), 'docs/delivery/pending/新闻.md')
    assert.equal(decodeGitPath('/dev/null'), null)
  })
})

describe('请求侧按源码是否引用请求入口判，不只认 schema / queries 文件名（#68）', () => {
  const MARKED = { ...VERIFY, requestMarker: "['\"]@/kernel/http(/index\\.ts)?['\"]" }
  const HTTP_SRC = 'import { request } from "@/kernel/http/index.ts";\nexport const reserve = (id) => request("live", "/api/live/reserveMatch", { live_id: id }, "POST");'
  const sources = { 'src/modules/live/data/mutations.ts': [HTTP_SRC, HTTP_SRC], 'src/modules/live/data/format.ts': ['export const pad = (n) => n;'], 'src/modules/live/data/mutations.test.ts': [HTTP_SRC] }
  const readSources = (path) => sources[path] || []
  const MUTATION_DIFF = [
    'diff --git a/src/modules/live/data/mutations.ts b/src/modules/live/data/mutations.ts',
    '--- a/src/modules/live/data/mutations.ts',
    '+++ b/src/modules/live/data/mutations.ts',
    '@@ -2 +2 @@',
    '-export const reserve = (id) => request("live", "/api/live/reserveMatch", { live_id: id }, "POST");',
    '+export const reserve = (id) => request("live", "/api/live/reserveMatch", { match_id: id }, "POST");',
  ].join('\n')

  it('mutations.ts 引用 @/kernel/http → 进范围；纯逻辑文件、测试文件不进', () => {
    const files = ['src/modules/live/data/mutations.ts', 'src/modules/live/data/format.ts', 'src/modules/live/data/mutations.test.ts']
    assert.deepEqual(scopedInterfaceFiles({ verify: MARKED, changedFiles: files, readSources }), ['src/modules/live/data/mutations.ts'])
    assert.deepEqual(scopedInterfaceFiles({ verify: VERIFY, changedFiles: files, readSources }), [])
  })

  it('改了写接口参数 + 没测 → 判没测通（runner 补测），点名 mutations.ts', () => {
    const gate = resolveSchemaVerifyGate({ verify: MARKED, changedFiles: ['src/modules/live/data/mutations.ts'], preChecks: [], taskId: 't', readDiff: () => MUTATION_DIFF, readSources })
    assert.equal(gate.unverified, true)
    assert.match(gate.note, /改了对后端的请求（src\/modules\/live\/data\/mutations\.ts：.*reserveMatch/)
  })

  it('改动把 request 引用删掉（改前版本有）也算范围内', () => {
    const files = ['src/modules/user/data/feedbacks.ts']
    assert.deepEqual(scopedInterfaceFiles({ verify: MARKED, changedFiles: files, readSources: () => [HTTP_SRC, 'export const x = 1'] }), files)
  })

  it('后端报错（权限不足 / 5xx / 业务错误码）归 backend，不算我方 schema 问题、不拦提交（10-22 清扫被社区库 -10501 权限错误判成 schema 对不上）', () => {
    const rule = buildVerifyRule({ env: 'pre', probeCommand: 'node p.mjs' })
    assert.match(rule, /后端报错（权限不足、5xx、业务错误码），kind 填 backend/)
    const gate = resolveSchemaVerifyGate({ verify: VERIFY, changedFiles: ['x/data/queries.ts'], preChecks: [{ endpoint: '/bbsv2/thread/listCursor', outcome: 'code -10501 SELECT command denied', kind: 'backend' }, { endpoint: '/api/x', outcome: 'code 0', kind: 'ok' }], taskId: 't', readDiff: () => 'diff --git a/x/data/queries.ts b/x/data/queries.ts\n--- a/x/data/queries.ts\n+++ b/x/data/queries.ts\n@@ -1 +1 @@\n-a()\n+b()' })
    assert.equal(gate.status, null)
  })

  it('实施任务且配了 writeMail 才给写接口实测口径，且只许测试号', () => {
    const verify = { ...VERIFY, probeCommand: 'node p.mjs', writeMail: 't@probe.test' }
    assert.doesNotMatch(buildVerifyRule({ ...verify, writeMail: '' }, { allowWrite: true }), /PROBE_ALLOW_WRITE/)
    assert.doesNotMatch(buildVerifyRule(verify), /PROBE_ALLOW_WRITE/) // 只读 / 代答不给
    const rule = buildVerifyRule(verify, { allowWrite: true })
    assert.match(rule, /PROBE_ALLOW_WRITE=1 PROBE_MAIL=t@probe\.test/)
    assert.match(rule, /破坏性写接口没实测/)
  })
})

describe('声明纳入的兄弟位置在豁免目录里改了 → 不报疑似漏改（#67）', () => {
  const doc = 'docs/delivery/pending/新闻详情页-待确认-2026-10-21.md'
  const scope = { targets: [{ path: 'src/modules/news/NewsDetailPage.tsx', symbols: [], reason: '版式' }], siblings: { searchQueries: [], items: [{ path: doc, include: true, reason: '追加答复' }] } }
  it('对接文档目录被豁免，但改了就不算漏改；真没改照报', () => {
    const changed = ['src/modules/news/NewsDetailPage.tsx', doc]
    const gate = resolveScopeGate({ task: { text: '' }, scope, actualChangedFiles: changed, exemptPrefixes: ['docs/delivery/pending'] })
    assert.deepEqual(gate.check.missingIncludedSiblings, [])
    assert.deepEqual(gate.warnNotes, [])
    const missed = resolveScopeGate({ task: { text: '' }, scope, actualChangedFiles: changed.slice(0, 1), exemptPrefixes: ['docs/delivery/pending'] })
    assert.match(missed.warnNotes[0], /兄弟位置实测未改/)
  })
})
