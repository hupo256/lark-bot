import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import {
  buildDailyDocPrompt,
  buildDailyReportPrompt,
  buildDocsView,
  collectApiGapSources,
  collectDailyFacts,
  diffFeatureTables,
  groupCommitsByPerson,
  judgeFeatureCheck,
  runFeatureChecks,
  parseMockUsages,
  parseFeatureTable,
  resolvePerson,
  runDailyReport,
  summarizeFeatureTable,
} from '../lib/lark-daily-report.mjs'
import { normalizeRepoProfile, registerRepoProfiles, resetRepoProfiles } from '../lib/lark-repo-profile.mjs'

const TABLE = `## 总表（3 项）

| # | 一级模块 | 功能 | 来源 | 前端 | 服务端 | 状态 | 代码落点 | 备注 |
|---|---|---|---|---|---|---|---|---|
| 1 | 用户与账号 | 用户资料 | h有K有 | henry | live+chat | 🟠 | \`modules/user\` | 备注 a |
| 2 | 直播预告 | 节目表-全部 | k有 | aven | live | ✅ | \`modules/upcoming\` | 备注 b |
| 28 | 直播 | 直播存档 🆕 | h有 | broker | chat | ❌ | — | spec |
`

describe('功能总表解析与 diff', () => {
  it('只认首列为数字的行，状态取 emoji，按负责人统计', () => {
    const rows = parseFeatureTable(TABLE)
    assert.equal(rows.length, 3)
    assert.deepEqual(rows[1], { no: 2, module: '直播预告', feature: '节目表-全部', owner: 'aven', server: 'live', status: '✅', location: '`modules/upcoming`', note: '备注 b' })
    assert.deepEqual(summarizeFeatureTable(rows), { total: 3, byStatus: { '🟠': 1, '✅': 1, '❌': 1 }, byOwner: { henry: { total: 1, done: 0 }, aven: { total: 1, done: 1 }, broker: { total: 1, done: 0 } } })
    const changed = diffFeatureTables(rows, rows.map((row) => (row.no === 1 ? { ...row, status: '✅' } : row)))
    assert.deepEqual(changed, [{ no: 1, feature: '用户资料', owner: 'henry', from: '🟠', to: '✅' }])
  })
})

describe('提交按人归并', () => {
  it('作者 / 邮箱别名匹配到人名，Merge 提交只计次数', () => {
    const people = { aven: ['aven.tong'], henry: ['henry'] }
    assert.equal(resolvePerson(people, { author: 'aven.tong', email: 'aven.tong@globaldev.info' }), 'aven')
    assert.equal(resolvePerson(people, { author: 'Henry Li', email: 'henry@x.com' }), 'henry')
    assert.equal(resolvePerson(people, { author: 'someone', email: 's@x.com' }), 'someone')
    const groups = groupCommitsByPerson([
      { sha: 'a', author: 'aven', email: 'aven@x', subject: "Merge branch 'feature/x' into 'pre'" },
      { sha: 'b', author: 'henry', email: 'h@x', subject: 'feat: 群组聊天接真实接口' },
    ], people)
    assert.equal(groups.aven.merges, 1)
    assert.equal(groups.aven.commits.length, 0)
    assert.equal(groups.henry.commits[0].sha, 'b')
  })
})

describe('事实采集与日报生成（IO 注入）', () => {
  afterEach(() => resetRepoProfiles())

  it('采集 git / 总表 / 路线图 / bot 任务，prompt 含模板与无提交名单；runDailyReport 落盘快照并发卡', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lark-daily-'))
    try {
      const profile = normalizeRepoProfile('falive', {
        root: dir,
        baseRef: 'feature/phase-3-api',
        title: 'Falive Web',
        notifyChatId: 'ou_aven',
        ownership: { me: 'aven' },
        dailyReport: { at: '19:00', othersRef: 'origin/pre', featureTable: 'table.md', roadmap: 'README.md', people: { aven: ['aven.tong'], henry: ['henry'], eric: ['eric'] }, fetch: false },
      })
      const git = (root, args) => {
        if (args[0] === 'log') return { ok: true, stdout: 'b2|henry|h@x|feat: 群组\nm3|aven|aven@x|Merge branch x into pre\na1|aven|aven@x|feat: 搜索\n' }
        if (args[0] === 'rev-parse') return { ok: true, stdout: '2a074a7\n' }
        return { ok: true, stdout: '' }
      }
      const files = { [join(dir, 'table.md')]: TABLE, [join(dir, 'README.md')]: '# x\n\n## 一、分档\n\n| L1 | … | 卡运维 O11 | 运维 |\n\n## 三、对接文档\n' }
      const store = { list: () => [{ id: 't1', repo: 'falive', status: 'blocked', summary: '主播公告', result: '已阻塞。\n1. 字段确认不了', updatedAt: '2026-10-13T05:00:00.000Z' }] }
      const now = new Date(2026, 9, 13, 19, 0, 0)
      const checkout = { dir, note: '' }
      const facts = collectDailyFacts({ profile, store, now, git, readFile: (path) => files[path] ?? '', snapshotDir: join(dir, 'snap'), checkout })
      assert.equal(facts.date, '2026-10-13')
      assert.equal(facts.reviewHead, '2a074a7')
      assert.deepEqual(Object.keys(facts.others), ['henry', 'aven'])
      assert.equal(facts.others.aven.commits.length, 1)
      assert.equal(facts.others.aven.merges, 1)
      assert.equal(facts.table.summary.total, 3)
      assert.equal(facts.botTasks.length, 1)
      assert.match(facts.roadmapSection, /卡运维 O11/)
      const prompt = buildDailyReportPrompt(facts, { headline: '总体进度 **50.0%**，已接通 **1 / 3**。', fullDoc: '# 完整版正文' })
      assert.match(prompt, /今天在 origin\/pre 上没有提交的人：eric/)
      assert.match(prompt, /henry：1 个提交/)
      assert.match(prompt, /脚本定的数字（只能引用，不能改）：总体进度 \*\*50\.0%\*\*/)
      assert.match(prompt, /# 完整版正文/)
      const docPrompt = buildDailyDocPrompt(facts, profile.dailyReport)
      assert.match(docPrompt, /<callout emoji="📝"/)
      assert.match(docPrompt, /## 总体进度：待脚本填/)
      assert.match(docPrompt, /所有状态以 origin\/pre（2a074a7）的真实代码为准/)
      assert.match(docPrompt, /它的状态列是人手维护的、经常落后，不作数/)
      assert.match(docPrompt, /每个负责人都一样/)
      assert.match(docPrompt, /已经解决的整行删掉/)
      assert.match(docPrompt, /\| 事项 \| 说明 \| 负责人 \|/)
      assert.match(docPrompt, /aven 的在最前/)
      assert.match(docPrompt, /<!-- STATUS_JSON/)
      assert.match(docPrompt, /覆盖总表全部 3 个功能（#1 #2 #28）/)
      assert.match(docPrompt, /全项目接口缺口线索/)
      assert.match(docPrompt, /### 2\.1 缺接口`/)
      assert.match(docPrompt, /### 2\.2 缺数据 \/ 缺配置`/)
      assert.match(docPrompt, /### 2\.3 接过但有问题的接口`/)
      assert.doesNotMatch(docPrompt, /两小节：2\.1 缺接口 \/ 缺数据 \/ 缺配置/)
      assert.match(docPrompt, /以「10-13：」开头/)
      assert.doesNotMatch(docPrompt, /状态列以功能总表（人维护）为准/)

      registerRepoProfiles({})
      const sent = []
      const outcome = await runDailyReport({
        config: { project: 'PR-0', title: 't' },
        store,
        profile,
        now,
        deps: {
          runtimeDir: dir,
          collectFacts: () => facts,
          generateText: async ({ prompt: p }) => { assert.match(p, /日报撰写者/); return '## 今天\n- **aven**：搜索' },
          sendUserMarkdown: async (args) => { sent.push(args); return { ok: true } },
        },
      })
      assert.equal(outcome.ok, true)
      assert.equal(outcome.to, 'ou_aven')
      // 没配完整版：短版数字回落总表，私信核对单说明
      assert.match(sent.find((item) => /日报核对/.test(item.markdown)).markdown, /完整版没生成，短版数字回落功能总表/)
      const short = sent.find((item) => /^# Falive Web 日报 2026-10-13/.test(item.markdown)).markdown
      assert.match(short, /已接通 \*\*1 \/ 3\*\*/)
      assert.match(short, /## 今天\n- \*\*aven\*\*：搜索/)
      assert.ok(outcome.reportPath.endsWith('/lark-daily-report/falive/FaliveWeb日报-2026-10-13.md'))
      // 第二次采集：快照已落盘，diff 应能比出状态变化
      const facts2 = collectDailyFacts({ profile, store, now, git, readFile: (path) => (path.endsWith('table.md') ? TABLE.replace('| 🟠 |', '| ✅ |') : files[path] ?? ''), snapshotDir: join(dir, 'lark-daily-report', 'falive'), checkout })
      assert.deepEqual(facts2.table.changes, [{ no: 1, feature: '用户资料', owner: 'henry', from: '🟠', to: '✅' }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('全项目接口缺口线索', () => {
  it('mock 引用按文件计数，排除测试与 mock.ts 本身', () => {
    const out = parseMockUsages([
      "src/modules/download/data/queries.ts:3:import { mockChannels } from './mock'",
      'src/modules/download/data/queries.ts:9:  queryFn: () => mockChannels,',
      "src/modules/live/data/mock.ts:1:export const mock = 1",
      "src/modules/news/data/seo.test.ts:2:mock",
      "src/modules/help/data/mutations.ts:8: * Phase 1：mock",
    ].join('\n'))
    assert.deepEqual(out, [{ file: 'src/modules/download/data/queries.ts', hits: 2 }, { file: 'src/modules/help/data/mutations.ts', hits: 1 }])
  })
  it('未打 ✅ 的功能、未 ready 的 MSW 登记、mock 文件三路汇总；grep 无命中不报错', () => {
    const rows = [{ no: 1, feature: '用户资料', owner: 'henry', status: '🟠', location: 'user', note: 'mock' }, { no: 2, feature: '登录', owner: 'aven', status: '✅' }]
    const files = { '/r/src/mocks/pending-endpoints.json': JSON.stringify({ pending: [{ path: '*/api/a', owner: 'henry', reason: 'r', ready: false }, { path: '*/api/b', ready: true }] }) }
    const sources = collectApiGapSources({ dir: '/r', rows, git: () => ({ ok: false, stdout: '' }), readFile: (path) => files[path] })
    assert.deepEqual(sources.unfinished.map((row) => row.no), [1])
    assert.deepEqual(sources.msw.map((item) => item.path), ['*/api/a'])
    assert.deepEqual(sources.mockUsages, [])
    assert.deepEqual(collectApiGapSources({ dir: '/none', rows: [], git: () => ({ ok: false }), readFile: () => { throw new Error('x') } }).msw, [])
  })
})

describe('日报实测（#17）与本地领先（#11）', () => {
  afterEach(() => resetRepoProfiles())
  it('摘要行 → 可用 / 没数据 / 不可用；pick / field 口径', () => {
    const nonEmpty = { label: '礼物', path: '/api/Gift/getList', params: {}, pick: null, expect: 'nonEmpty', features: [38] }
    assert.equal(judgeFeatureCheck(nonEmpty, '### SUMMARY GET /api/Gift/getList {} -> 0 {"type":"array","len":2}').status, '可用')
    assert.equal(judgeFeatureCheck(nonEmpty, '### SUMMARY GET /api/Gift/getList {} -> 0 {"type":"array","len":0}').status, '没数据')
    assert.equal(judgeFeatureCheck(nonEmpty, '### SUMMARY GET /api/Gift/getList {} -> UNREACHABLE {"type":"null"}').status, '不可用')
    assert.equal(judgeFeatureCheck(nonEmpty, '### SUMMARY GET /api/Gift/getList {} -> -1 {"type":"null"}').status, '不可用')
    assert.equal(judgeFeatureCheck({ ...nonEmpty, pick: 'data' }, '### SUMMARY GET /x {} -> 0 {"type":"object","keys":{"total":{"type":"number","value":0},"data":{"type":"array","len":0}}}').status, '没数据')
    assert.equal(judgeFeatureCheck({ ...nonEmpty, pick: 'list.data' }, '### SUMMARY GET /x {} -> 0 {"type":"object","keys":{"list":{"type":"object","keys":{"data":{"type":"array","len":1}}}}}').status, '可用')
    assert.equal(judgeFeatureCheck({ ...nonEmpty, pick: 'info', expect: 'field:pull' }, '### SUMMARY GET /x {} -> 0 {"type":"object","keys":{"info":{"type":"object","keys":{"pull":{"type":"string","len":85,"empty":false}}}}}').status, '可用')
    const profile = normalizeRepoProfile('falive', { root: '/tmp/f', baseRef: 'main', verify: { probeCommand: 'node scripts/pre-probe.mjs' }, dailyReport: { at: '19:00', featureChecks: [{ features: [41], label: '举报分类', path: '/api/report/classifyList' }, { features: [36], label: '话痨榜', path: '/api/ranking/speaking', params: { type: 'daily' } }] } })
    const out = runFeatureChecks({ profile, checks: profile.dailyReport.featureChecks, probe: () => '### GET /api/report/classifyList {} -> 0 ok [ {\n### SUMMARY GET /api/report/classifyList {} -> 0 {"type":"array","len":1}\n### SUMMARY GET /api/ranking/speaking {"type":"daily"} -> 0 {"type":"array","len":0}\n' })
    assert.deepEqual(out.map((c) => c.status), ['可用', '没数据'])
  })
})

describe('完整版：状态以 pre 代码为准 + 台账', () => {
  it('剥 JSON、按代码状态回写与计数、比对前一天台账、私信核对单、短版数字与完整版一致', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lark-daily-full-'))
    try {
      const profile = normalizeRepoProfile('falive', {
        root: dir,
        baseRef: 'feature/phase-3-api',
        title: 'Falive Web',
        notifyChatId: 'ou_aven',
        dailyReport: { at: '19:00', featureTable: 'table.md', people: { aven: ['aven'], henry: ['henry'] }, fetch: false, docTemplate: 'tpl.md' },
      })
      const reportDir = join(dir, 'lark-daily-report', 'falive')
      mkdirSync(reportDir, { recursive: true })
      const previous = `# 日报\n\n## 三、需要再跟进的工作\n\n| 事项 | 说明 | 负责人 |\n|---|---|---|\n| help 改名「聊天」 | x | **henry** |\n| 分支流程 | x | 待确认 |\n| 发邮件部署 | x | **aven** |\n`
      writeFileSync(join(reportDir, 'FaliveWeb日报-2026-10-13-完整版.md'), previous)
      const rows = parseFeatureTable(TABLE)
      const facts = {
        date: '2026-10-14', title: 'Falive Web', othersRef: 'origin/pre', reviewHead: 'abc', reviewDir: dir, fetchNote: '', others: {}, people: ['aven', 'henry'],
        table: { rows, summary: summarizeFeatureTable(rows), changes: [], hadSnapshot: false }, botTasks: [], docPaths: { featureTable: 't', pendingDir: 'p', roadmap: 'r', docTemplate: 'tpl.md' },
        previousReport: { path: join(reportDir, 'FaliveWeb日报-2026-10-13-完整版.md'), date: '2026-10-13' }, apiGapSources: null,
      }
      const full = `# Falive Web 一期 · 日报（2026-10-14）\n\n## 总体进度：待脚本填\n\n<callout><p><b>henry：</b>负责 1 项，0 项 ✅。</p></callout>\n\n## 一、功能进度总览\n\n| # | 功能 | 负责人 | 状态 | 还剩什么 | 需要谁支持 |\n|---|---|---|---|---|---|\n| 1 | 用户资料 | henry | ⬜ | x | y |\n| 2 | 节目表 | aven | ⬜ | x | y |\n| 28 | 直播存档 | broker | ⬜ | x | y |\n\n**计数**\n\n## 二、API：还缺什么、哪些有问题\n\n| 功能 | 缺什么 | 现状 | 找谁 | 文档 |\n|---|---|---|---|---|\n| #28 | anchorRecordList | 没 UI | broker | B3 |\n\n## 三、需要再跟进的工作\n\n| 事项 | 说明 | 负责人 |\n|---|---|---|\n| 发邮件部署 | x | **aven** |\n\n<!-- STATUS_JSON\n${JSON.stringify({ features: [{ no: 1, status: '✅', pre: '能用', evidence: 'pre 已接' }, { no: 2, status: '✅', pre: '看不到', reason: '没数据' }, { no: 28, status: '❌' }], resolved: [{ section: '三', key: 'help 改名「聊天」', evidence: 'pre a58b92b' }] })}\nSTATUS_JSON -->`
      const sent = []
      const prompts = []
      const outcome = await runDailyReport({
        config: {}, store: null, profile, now: new Date(2026, 9, 14, 19, 0),
        deps: {
          runtimeDir: dir,
          collectFacts: () => facts,
          generateText: async ({ prompt }) => { prompts.push(prompt); return /完整版日报（云文档）/.test(prompt) ? full : '## 今天\n- **henry**：资料' },
          createLarkDoc: async () => ({ ok: true, url: 'https://doc/x', documentId: 'x' }),
          sendUserMarkdown: async (args) => { sent.push(args); return { ok: true } },
        },
      })
      assert.equal(outcome.ok, true)
      assert.equal(outcome.doc.path, join(reportDir, 'FaliveWeb日报-2026-10-14-完整版.md'))
      const doc = readFileSync(outcome.doc.path, 'utf8')
      assert.doesNotMatch(doc, /STATUS_JSON/)
      assert.match(doc, /^## 总体进度：66\.7%（✅ 2 \/ 3）$/m)
      assert.match(doc, /\| 1 \| 用户资料 \| henry \| ✅ \|/)
      assert.match(doc, /\*\*计数\*\*（不含 #54）：✅ 2 项（aven 1、henry 1）。未完成 1 项：\n- broker 1 项：#28/)
      assert.match(doc, /^## 三、需要再跟进的工作（剩 1 行，今日删 1 行）$/m)
      // 短版：数字行来自脚本，和完整版一致；短版提示里带完整版正文
      const short = sent.find((item) => /^# Falive Web 日报/.test(item.markdown)).markdown
      assert.match(short, /总体进度 \*\*66\.7%\*\*，已接通 \*\*2 \/ 3\*\*。其中 1 项在 pre 上还看不到效果：#2 没数据。/)
      assert.match(short, /完整版（云文档）：https:\/\/doc\/x/)
      assert.match(prompts[1], /\| 1 \| 用户资料 \| henry \| ✅ \|/)
      // 私信核对单：无依据消失的行、今天删的行、总表要改的状态、高亮框数字不一致
      const note = sent.find((item) => /日报核对/.test(item.markdown)).markdown
      assert.match(note, /三节：分支流程/)
      assert.match(note, /三节：help 改名「聊天」——pre a58b92b/)
      assert.match(note, /#1 用户资料（henry）：总表 🟠 → pre 代码 ✅/)
      assert.match(note, /henry：高亮框写「负责 1 项，0 项 ✅」，按状态算是 1 项、1 项 ✅/)
      // 第二天：今日 +n 以代码状态快照为基线
      assert.equal(JSON.parse(readFileSync(join(reportDir, 'code-status.json'), 'utf8')).done, 2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('待对接文档最新视图', () => {
  // 真 git：三个分支各改同一份文件的不同行（隔开至少一行；相邻行的修改 git 会判冲突，那种走回落） → 视图里三处都在；同一行各改各的 → 冲突回落取较新、标 conflict。
  const realRepo = () => {
    const dir = mkdtempSync(join(tmpdir(), 'lark-docs-merge-'))
    const run = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', ...(run.at ? { GIT_COMMITTER_DATE: run.at } : {}) } })
    const write = (file, text) => { mkdirSync(join(dir, 'docs/p'), { recursive: true }); writeFileSync(join(dir, file), text) }
    // 「较新」按提交时间（%ct）判，提交时间也要固定。
    const commit = (msg, at) => { run('add', '-A'); run.at = at; run('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', msg, '--date', at); run.at = null }
    run('init', '-q', '-b', 'base')
    write('docs/p/a.md', 'E1 待答复\n-\nE2 待答复\n-\nE3 待答复\n')
    write('docs/p/c.md', 'X 待答复\n')
    commit('base', '2026-10-14T10:00:00')
    run('checkout', '-q', '-b', 'pre'); write('docs/p/a.md', 'E1 待答复\n-\nE2 待答复\n-\nE3 已复测\n'); write('docs/p/c.md', 'X pre 版\n'); write('docs/p/sweep.md', '清扫结论\n'); commit('pre', '2026-10-14T12:00:00')
    run('checkout', '-q', 'base'); run('checkout', '-q', '-b', 'work'); write('docs/p/a.md', 'E1 待答复\n-\nE2 已实测\n-\nE3 待答复\n'); write('docs/p/c.md', 'X 工作分支版\n'); commit('work', '2026-10-14T13:00:00')
    run('checkout', '-q', 'base'); run('checkout', '-q', '-b', 'integ'); write('docs/p/a.md', 'E1 已答复\n-\nE2 待答复\n-\nE3 待答复\n'); commit('integ', '2026-10-14T11:00:00')
    return dir
  }

  it('三分支合并：各改的行都保留，只在一边有的文件也带上；真冲突回落取较新并标 conflict', () => {
    const dir = realRepo()
    try {
      const out = buildDocsView({ root: dir, refs: ['pre', 'work', 'integ'], relDir: 'docs/p', outDir: join(dir, 'view') })
      assert.equal(out.merged, true)
      assert.equal(readFileSync(join(dir, 'view', 'a.md'), 'utf8'), 'E1 已答复\n-\nE2 已实测\n-\nE3 已复测\n')
      assert.equal(readFileSync(join(dir, 'view', 'sweep.md'), 'utf8'), '清扫结论\n')
      // c.md 在 pre 与工作分支同一行冲突 → 取最后提交较新的工作分支版，不写冲突标记
      assert.equal(readFileSync(join(dir, 'view', 'c.md'), 'utf8'), 'X 工作分支版\n')
      assert.deepEqual(out.picked, [
        { file: 'docs/p/a.md', ref: 'merged' },
        { file: 'docs/p/c.md', ref: 'work', conflict: true },
        { file: 'docs/p/sweep.md', ref: 'merged' },
      ])
      // 不动分支、不动工作区
      assert.equal(execFileSync('git', ['-C', dir, 'branch', '--show-current'], { encoding: 'utf8' }).trim(), 'integ')
      assert.equal(execFileSync('git', ['-C', dir, 'status', '--porcelain', '--', 'docs'], { encoding: 'utf8' }).trim(), '')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('集成分支不存在：照样合并其余分支', () => {
    const dir = realRepo()
    try {
      const out = buildDocsView({ root: dir, refs: ['pre', 'work', 'no-such-branch'], relDir: 'docs/p', outDir: join(dir, 'view') })
      assert.equal(out.merged, true)
      assert.equal(readFileSync(join(dir, 'view', 'a.md'), 'utf8'), 'E1 待答复\n-\nE2 已实测\n-\nE3 已复测\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('同一份文件取 pre 与工作分支里提交较新的那版，只在一边有的也带上', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lark-docs-view-'))
    try {
      const tree = { 'origin/pre': ['docs/p/a.md', 'docs/p/sweep.md'], 'feature/x': ['docs/p/a.md', 'docs/p/b.md'] }
      const times = { 'origin/pre:docs/p/a.md': 200, 'feature/x:docs/p/a.md': 100, 'origin/pre:docs/p/sweep.md': 300, 'feature/x:docs/p/b.md': 50 }
      const git = (root, args) => {
        if (args.includes('ls-tree')) return { ok: true, stdout: tree[args[args.indexOf('--name-only') + 1]].join('\n') }
        if (args[0] === 'log') return { ok: true, stdout: String(times[`${args[3]}:${args[5]}`] || '') }
        return { ok: false, stdout: '' }
      }
      const out = buildDocsView({ root: dir, refs: ['origin/pre', 'feature/x'], relDir: 'docs/p', outDir: join(dir, 'view'), git, readBlob: (ref, path) => Buffer.from(`${ref}|${path}`) })
      assert.deepEqual(out.picked, [{ file: 'docs/p/a.md', ref: 'origin/pre' }, { file: 'docs/p/b.md', ref: 'feature/x' }, { file: 'docs/p/sweep.md', ref: 'origin/pre' }])
      assert.equal(readFileSync(join(dir, 'view', 'a.md'), 'utf8'), 'origin/pre|docs/p/a.md')
      assert.equal(readFileSync(join(dir, 'view', 'b.md'), 'utf8'), 'feature/x|docs/p/b.md')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
