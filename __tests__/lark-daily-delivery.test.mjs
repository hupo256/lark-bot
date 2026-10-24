import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { CODE_STATUS_SNAPSHOT, FEATURE_TABLE_SNAPSHOT, loadBaselineSnapshot, openDailyDelivery, readSnapshotHistory, recordDailySnapshot, sendDailyToGroups } from '../lib/lark-daily-delivery.mjs'
import { collectDailyFacts, parseFeatureTable, runDailyReport, summarizeFeatureTable } from '../lib/lark-daily-report.mjs'
import { localDateKey, localDateOf } from '../lib/lark-local-date.mjs'
import { normalizeRepoProfile, registerRepoProfiles, resetRepoProfiles } from '../lib/lark-repo-profile.mjs'
import { runSystemTask } from '../lib/lark-system-runner.mjs'
import { DAILY_LEASE_FLOOR_MS, buildDailyReportTask, dailyReportLeaseMs } from '../lib/lark-system-tasks.mjs'
import { LEASE_HEARTBEAT_DIVISOR } from '../lib/lark-task-runner.mjs'
import { runSteps } from './support/steps.mjs'

// aven 2026-10-20 review：日报重试 / 重发（C15）、本地日期、日报租约、私信目标不回落外部群。

const TABLE = `| # | 一级模块 | 功能 | 来源 | 前端 | 服务端 | 状态 | 代码落点 | 备注 |
|---|---|---|---|---|---|---|---|---|
| 1 | 用户与账号 | 用户资料 | h | henry | live | 🟠 | \`modules/user\` | a |
| 2 | 直播预告 | 节目表 | k | aven | live | ✅ | \`modules/upcoming\` | b |
| 28 | 直播 | 直播存档 | h | broker | chat | ❌ | — | c |
`

// 在指定时区里跑（本机是 Asia/Dubai +04；CI 可能是 UTC，日期边界要固定时区才测得出来）。
const withTz = (tz, fn) => {
  const saved = process.env.TZ
  process.env.TZ = tz
  try {
    return fn()
  } finally {
    if (saved === undefined) delete process.env.TZ
    else process.env.TZ = saved
  }
}

describe('本地日期（aven 2026-10-20 review）', () => {
  it('UTC ISO 转本地日期，日报 bot 任务按本地日期取', () => runSteps([
    ['UTC ISO → 本地日期：+04 本地凌晨 01:30 是当天，不是 UTC 的前一天', () => {
      withTz('Asia/Dubai', () => {
        assert.equal(localDateOf('2026-10-19T21:30:00.000Z'), '2026-10-20')
        assert.equal(localDateOf('2026-10-19T19:59:00.000Z'), '2026-10-19')
        assert.equal(localDateOf(new Date(2026, 9, 20, 0, 5)), '2026-10-20')
        assert.equal(localDateKey(new Date(2026, 9, 20, 0, 5)), '2026-10-20')
        assert.equal(localDateOf(''), null)
        assert.equal(localDateOf('not a date'), null)
      })
    }],
    ['日报 bot 任务按本地日期取：本地凌晨更新的任务进当天日报，前一天本地 23 点的不进', () => {
      withTz('Asia/Dubai', () => {
        const dir = mkdtempSync(join(tmpdir(), 'lark-daily-tz-'))
        try {
          const profile = normalizeRepoProfile('falive', { root: dir, baseRef: 'main', title: 'Falive', notifyChatId: 'oc_console', dailyReport: { at: '19:00', featureTable: 'table.md', fetch: false } })
          const store = { list: () => [
            { id: 'early', repo: 'falive', status: 'done', summary: '凌晨', updatedAt: new Date(2026, 9, 20, 1, 30).toISOString() },
            { id: 'yesterday', repo: 'falive', status: 'done', summary: '昨晚', updatedAt: new Date(2026, 9, 19, 23, 0).toISOString() },
          ] }
          const git = (root, args) => (args[0] === 'rev-parse' ? { ok: true, stdout: 'abc\n' } : { ok: true, stdout: '' })
          const facts = collectDailyFacts({ profile, store, now: new Date(2026, 9, 20, 19, 0), git, readFile: (path) => (path.endsWith('table.md') ? TABLE : ''), snapshotDir: join(dir, 'snap'), checkout: { dir, note: '' } })
          assert.equal(facts.date, '2026-10-20')
          assert.deepEqual(facts.botTasks.map((task) => task.id), ['early'])
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      })
    }],
  ]))
})

describe('C15 快照按日期（aven 2026-10-20 review）', () => {
  let dir
  const hooks = { before: () => { dir = mkdtempSync(join(tmpdir(), 'lark-daily-snap-')) }, after: () => rmSync(dir, { recursive: true, force: true }) }

  it('快照按日期归档与基线、投递记账、发群跳过与出口闸记账', () => runSteps([
    ['旧格式单份快照按日期归档；基线只取早于今天的；当天写入不影响当天基线；只留 14 天', () => {
      writeFileSync(join(dir, CODE_STATUS_SNAPSHOT), JSON.stringify({ date: '2026-10-19', done: 30 }))
      writeFileSync(join(dir, FEATURE_TABLE_SNAPSHOT), JSON.stringify({ savedAt: new Date(2026, 9, 19, 19, 20).toISOString(), rows: [{ no: 1 }] }))
      assert.deepEqual(Object.keys(readSnapshotHistory(join(dir, FEATURE_TABLE_SNAPSHOT))), [localDateKey(new Date(2026, 9, 19))])
      assert.equal(loadBaselineSnapshot({ dir, file: CODE_STATUS_SNAPSHOT, today: '2026-10-20' }).done, 30)
      assert.equal(loadBaselineSnapshot({ dir, file: CODE_STATUS_SNAPSHOT, today: '2026-10-19' }), null, '当天的快照不当当天基线')
      recordDailySnapshot({ dir, file: CODE_STATUS_SNAPSHOT, date: '2026-10-20', payload: { done: 33 } })
      assert.equal(loadBaselineSnapshot({ dir, file: CODE_STATUS_SNAPSHOT, today: '2026-10-20' }).done, 30, '重试时基线仍是昨天')
      assert.equal(loadBaselineSnapshot({ dir, file: CODE_STATUS_SNAPSHOT, today: '2026-10-21' }).done, 33)
      for (let day = 1; day <= 20; day += 1) recordDailySnapshot({ dir, file: CODE_STATUS_SNAPSHOT, date: `2026-11-${String(day).padStart(2, '0')}`, payload: { done: day } })
      const days = Object.keys(readSnapshotHistory(join(dir, CODE_STATUS_SNAPSHOT)))
      assert.equal(days.length, 14)
      assert.equal(days[0], '2026-11-07')
      assert.equal(loadBaselineSnapshot({ dir: null, file: CODE_STATUS_SNAPSHOT, today: '2026-10-20' }), null)
    }],
    ['投递记账：resume 接着当天记录；fresh 清零；mode 为空不读不写；按日期互不影响', () => {
      const first = openDailyDelivery({ dir, date: '2026-10-20', mode: 'resume' })
      first.mark('oc_a')
      first.setDoc({ url: 'https://doc/1', documentId: 'd1' })
      const retry = openDailyDelivery({ dir, date: '2026-10-20', mode: 'resume' })
      assert.equal(retry.isSent('oc_a'), true)
      assert.equal(retry.doc().url, 'https://doc/1')
      assert.equal(openDailyDelivery({ dir, date: '2026-10-21', mode: 'resume' }).isSent('oc_a'), false)
      const manual = openDailyDelivery({ dir, date: '2026-10-20', mode: null })
      assert.equal(manual.isSent('oc_a'), false)
      manual.mark('oc_b')
      assert.equal(openDailyDelivery({ dir, date: '2026-10-20', mode: 'resume' }).isSent('oc_b'), false)
      openDailyDelivery({ dir, date: '2026-10-20', mode: 'fresh' })
      const after = openDailyDelivery({ dir, date: '2026-10-20', mode: 'resume' })
      assert.equal(after.isSent('oc_a'), false)
      assert.equal(after.doc(), null)
    }],
    ['发群：已发的跳过；出口闸 / 只私聊拦下的记账、算终态，重试不再触发私发', async () => {
      const delivery = openDailyDelivery({ dir, date: '2026-10-20', mode: 'resume' })
      const calls = []
      const sendCard = async ({ chatId }) => {
        calls.push(chatId)
        if (chatId === 'oc_private') return { ok: false, gated: '只私聊不发群', reason: '只私聊不发群' }
        return chatId === 'oc_bad' ? { ok: false, reason: 'webhook 19001' } : { ok: true }
      }
      const args = { profile: { key: 'falive' }, targets: ['oc_a', 'oc_private', 'oc_bad', 'oc_none'], text: 't', delivery, sendCard, webhookFor: (profile, chatId) => (chatId === 'oc_none' ? null : { url: `https://hook/${chatId}` }) }
      const first = await sendDailyToGroups(args)
      assert.deepEqual(first.map((item) => item.ok), [true, true, false, false])
      assert.equal(first[1].gated, '只私聊不发群')
      const second = await sendDailyToGroups(args)
      assert.deepEqual(calls, ['oc_a', 'oc_private', 'oc_bad', 'oc_bad'])
      assert.deepEqual(second.map((item) => item.skipped || null), ['already sent', 'already sent', null, null])
    }],
  ], hooks))
})

describe('C15 重试 / 重发：runDailyReport 端到端（aven 2026-10-20 review）', () => {
  let dir
  const hooks = { before: () => { dir = mkdtempSync(join(tmpdir(), 'lark-daily-retry-')) }, after: () => { rmSync(dir, { recursive: true, force: true }); resetRepoProfiles() } }

  const setup = () => {
    const profile = normalizeRepoProfile('falive', {
      root: dir,
      baseRef: 'main',
      title: 'Falive Web',
      notifyChatId: 'oc_console',
      chatIds: ['oc_a', 'oc_b'],
      webhooksByChat: { oc_a: { url: 'https://hook/oc_a' }, oc_b: { url: 'https://hook/oc_b' } },
      dailyReport: { at: '19:00', featureTable: 'table.md', fetch: false, docTemplate: 'tpl.md', sendTo: ['oc_a', 'oc_b'] },
    })
    const reportDir = join(dir, 'lark-daily-report', 'falive')
    mkdirSync(reportDir, { recursive: true })
    // 昨天的快照是旧格式（升级前落的）：基线照样认。
    writeFileSync(join(reportDir, CODE_STATUS_SNAPSHOT), JSON.stringify({ date: '2026-10-19', done: 1 }))
    const rows = parseFeatureTable(TABLE)
    const facts = () => ({
      date: '2026-10-20', title: 'Falive Web', othersRef: 'origin/pre', reviewHead: 'abc', reviewDir: dir, fetchNote: '', others: {}, people: ['aven', 'henry'],
      table: { rows, summary: summarizeFeatureTable(rows), changes: [], hadSnapshot: false }, botTasks: [], docPaths: { featureTable: 't', pendingDir: 'p', roadmap: 'r', docTemplate: 'tpl.md' },
      previousReport: null, apiGapSources: null,
    })
    const full = `# 日报\n\n## 总体进度：待脚本填\n\n## 一、功能进度总览\n\n| # | 功能 | 负责人 | 状态 |\n|---|---|---|---|\n| 1 | 用户资料 | henry | ⬜ |\n\n**计数**\n\n<!-- STATUS_JSON\n${JSON.stringify({ features: [{ no: 1, status: '✅', pre: '能用', evidence: 'x' }, { no: 2, status: '✅', pre: '能用', evidence: 'y' }, { no: 28, status: '❌', evidence: 'z' }], resolved: [] })}\nSTATUS_JSON -->`
    const log = { full: 0, docs: 0, hooks: [], privates: [] }
    let failB = true
    const deps = {
      runtimeDir: dir,
      collectFacts: facts,
      generateText: async ({ prompt }) => {
        if (/完整版日报（云文档）/.test(prompt)) {
          log.full += 1
          return full
        }
        return '## 今天\n- **henry**：资料'
      },
      createLarkDoc: async () => {
        log.docs += 1
        return { ok: true, url: `https://doc/${log.docs}`, documentId: `d${log.docs}` }
      },
      sendWebhookMessage: async ({ url, card }) => {
        log.hooks.push({ url, body: JSON.stringify(card) })
        return url.endsWith('oc_b') && failB ? { ok: false, reason: 'webhook 19001' } : { ok: true }
      },
      sendUserMarkdown: async (args) => {
        log.privates.push(args)
        return { ok: true }
      },
    }
    registerRepoProfiles({ repos: {} })
    return { profile, reportDir, deps, log, recover: () => { failB = false } }
  }

  it('runDailyReport 端到端：失败自动重试 / 重发、全失败不落快照、无私信目标不回落外部群', () => runSteps([
    ['第一次 oc_b 失败 → 自动重试：不再发 oc_a、核对单不重复、云文档与完整版复用、今日 +N 仍以昨天为基线；快照发出后才落', async () => {
      const { profile, reportDir, deps, log, recover } = setup()
      const now = new Date(2026, 9, 20, 19, 0)
      const first = await runDailyReport({ config: {}, store: null, profile, now, deliveryMode: 'resume', deps })
      assert.equal(first.ok, false)
      assert.match(first.text, /今日 \+1/)
      assert.equal(log.hooks.filter((hook) => hook.url.endsWith('oc_a')).length, 1)
      assert.equal(log.privates.filter((item) => /日报核对/.test(item.markdown)).length, 1)
      // oc_a 已收到今天的数字 → 今天的快照落了，但不当今天的基线
      assert.equal(JSON.parse(readFileSync(join(reportDir, CODE_STATUS_SNAPSHOT), 'utf8')).history['2026-10-20'].done, 2)

      recover()
      const retry = await runDailyReport({ config: {}, store: null, profile, now: new Date(2026, 9, 20, 19, 40), deliveryMode: 'resume', deps })
      assert.equal(retry.ok, true)
      assert.match(retry.text, /今日 \+1/, '重试不拿当天第一次的快照当昨天')
      assert.equal(log.hooks.filter((hook) => hook.url.endsWith('oc_a')).length, 1, '已成功的群不再发')
      assert.equal(log.hooks.filter((hook) => hook.url.endsWith('oc_b')).length, 2)
      assert.equal(log.docs, 1, '不再新建公开云文档')
      assert.equal(log.full, 1, '复用完整版原文，不再跑模型')
      assert.equal(retry.doc.url, 'https://doc/1')
      assert.match(retry.text, /完整版（云文档）：https:\/\/doc\/1/)
      assert.equal(log.privates.filter((item) => /日报核对/.test(item.markdown)).length, 1, '核对单不重复私发')

      // 群里「重发日报」（fresh）：从头发、新建文档，数字仍以昨天为基线
      const forced = await runDailyReport({ config: {}, store: null, profile, now: new Date(2026, 9, 20, 21, 0), deliveryMode: 'fresh', deps })
      assert.equal(forced.ok, true)
      assert.match(forced.text, /今日 \+1/)
      assert.equal(log.hooks.filter((hook) => hook.url.endsWith('oc_a')).length, 2)
      assert.equal(log.docs, 2)
      assert.equal(log.full, 2)
    }],
    ['发群全部失败：不落今天的快照', async () => {
      const { profile, reportDir, deps } = setup()
      deps.sendWebhookMessage = async () => ({ ok: false, reason: 'down' })
      const outcome = await runDailyReport({ config: {}, store: null, profile, now: new Date(2026, 9, 20, 19, 0), deliveryMode: 'resume', deps })
      assert.equal(outcome.ok, false)
      assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(reportDir, CODE_STATUS_SNAPSHOT), 'utf8'))), ['date', 'done'], '快照文件没被改写')
    }],
    ['私信版：没有私信目标时不回落外部群 chatIds[0]，生成前就停', async () => {
      const profile = normalizeRepoProfile('falive', { root: dir, baseRef: 'main', title: 'Falive', chatIds: ['oc_external'], dailyReport: { at: '19:00', featureTable: 'table.md', fetch: false } })
      let collected = 0
      const sent = []
      const outcome = await runDailyReport({ config: {}, store: null, profile, now: new Date(2026, 9, 20, 19, 0), deps: { runtimeDir: dir, collectFacts: () => { collected += 1 }, sendUserMarkdown: async (args) => { sent.push(args); return { ok: true } } } })
      assert.equal(outcome.ok, false)
      assert.match(outcome.reason, /不回落外部群/)
      assert.equal(collected, 0)
      assert.deepEqual(sent, [])
    }],
  ], hooks))
})

describe('日报系统任务：租约与投递模式（aven 2026-10-20 review）', () => {
  it('日报租约下限与 worker 投递模式', () => runSteps([
    ['租约 = max(默认租约, 40min)：生产默认 75min 时不短于默认，至少容忍连续两次续租失败', () => {
      assert.equal(dailyReportLeaseMs(75 * 60_000), 75 * 60_000)
      assert.equal(dailyReportLeaseMs(10 * 60_000), DAILY_LEASE_FLOOR_MS)
      const profile = normalizeRepoProfile('falive', { root: '/tmp/x', baseRef: 'main', notifyChatId: 'oc_console', dailyReport: { at: '19:00' } })
      for (const defaultLeaseMs of [40 * 60_000, 75 * 60_000, 120 * 60_000]) {
        const task = buildDailyReportTask({ profile, date: '2026-10-20', reportNow: new Date(), defaultLeaseMs })
        const heartbeatMs = Math.floor(defaultLeaseMs / LEASE_HEARTBEAT_DIVISOR)
        assert.ok(task.leaseMs >= defaultLeaseMs)
        assert.ok(task.leaseMs / heartbeatMs >= 3, `${defaultLeaseMs}: 租约内至少 3 次续租`)
      }
    }],
    ['worker：自动重试走 resume，群里「重发日报」走 fresh', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'lark-daily-mode-'))
      try {
        registerRepoProfiles({ repos: { falive: { root: '/tmp/falive-react', baseRef: 'main', chatIds: ['oc_a'], notifyChatId: 'oc_console', dailyReport: { at: '19:00' } } } })
        const modes = []
        const deps = { runtimeDir: dir, runDailyReport: async ({ deliveryMode }) => { modes.push(deliveryMode); return { ok: false, reason: 'x' } } }
        const client = { listTasks: async () => [] }
        const profile = { key: 'falive', title: 'Falive' }
        await runSystemTask({ task: buildDailyReportTask({ profile, date: '2026-10-20', reportNow: new Date(), attempt: 2 }), client, workerConfig: { localConfig: {} }, reportStatus: async () => {}, deps })
        await runSystemTask({ task: buildDailyReportTask({ profile, date: '2026-10-20', reportNow: new Date(), attempt: 3, force: true }), client, workerConfig: { localConfig: {} }, reportStatus: async () => {}, deps })
        assert.deepEqual(modes, ['resume', 'fresh'])
      } finally {
        rmSync(dir, { recursive: true, force: true })
        resetRepoProfiles()
      }
    }],
  ]))
})
