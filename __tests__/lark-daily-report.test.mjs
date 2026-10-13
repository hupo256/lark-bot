import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import {
  buildDailyReportPrompt,
  collectDailyFacts,
  diffFeatureTables,
  groupCommitsByPerson,
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
      const prompt = buildDailyReportPrompt(facts)
      assert.match(prompt, /今天在 origin\/pre 上没有提交的人：eric/)
      assert.match(prompt, /# Falive Web 日报 2026-10-13/)
      assert.match(prompt, /henry：1 个提交/)
      assert.match(prompt, /\[blocked\] 主播公告/)

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
          generateText: async ({ prompt: p }) => { assert.match(p, /日报撰写者/); return '【Falive Web 日报 2026-10-13】\n整体：3 项里 1 项可用\n今日完成\n- aven：搜索' },
          sendUserMarkdown: async (args) => { sent.push(args); return { ok: true } },
        },
      })
      assert.equal(outcome.ok, true)
      assert.equal(outcome.to, 'ou_aven')
      assert.equal(sent[0].chatId, 'ou_aven')
      assert.match(sent[0].markdown, /日报 2026-10-13/)
      assert.ok(outcome.reportPath.endsWith('/lark-daily-report/falive/FaliveWeb日报-2026-10-13.md'))
      // 第二次采集：快照已落盘，diff 应能比出状态变化
      const facts2 = collectDailyFacts({ profile, store, now, git, readFile: (path) => (path.endsWith('table.md') ? TABLE.replace('| 🟠 |', '| ✅ |') : files[path] ?? ''), snapshotDir: join(dir, 'lark-daily-report', 'falive'), checkout })
      assert.deepEqual(facts2.table.changes, [{ no: 1, feature: '用户资料', owner: 'henry', from: '🟠', to: '✅' }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
