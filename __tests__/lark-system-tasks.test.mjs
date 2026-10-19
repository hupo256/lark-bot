import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { readDailyReportState } from '../lib/lark-daily-schedule.mjs'
import { registerRepoProfiles, resetRepoProfiles } from '../lib/lark-repo-profile.mjs'
import { handleStatusUpdate } from '../lib/lark-status.mjs'
import { runSystemTask } from '../lib/lark-system-runner.mjs'
import { buildDailyReportTask, isDailyReportTask, isSystemTask } from '../lib/lark-system-tasks.mjs'
import { createTaskStore } from '../lib/lark-task-store.mjs'

describe('系统任务：日报由 worker 生成，gateway 记账（第 1 批）', () => {
  let dir
  let profile
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lark-system-'))
    profile = registerRepoProfiles({ repos: { falive: { root: '/tmp/falive-react', baseRef: 'main', chatIds: ['oc_falive'], notifyChatId: 'ou_aven', title: 'Falive', dailyReport: { at: '19:00', to: 'ou_aven' } } } }).get('falive')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); resetRepoProfiles() })

  it('任务形状：只读路径、不经分类、租约够长', () => {
    const task = buildDailyReportTask({ profile, date: '2026-10-15', reportNow: new Date('2026-10-15T19:00:00'), now: new Date('2026-10-15T19:00:30') })
    assert.equal(isSystemTask(task), true)
    assert.equal(isDailyReportTask(task), true)
    assert.equal(task.id, 'daily-falive-2026-10-15')
    assert.equal(task.commandType, 'status')
    assert.equal(task.intake, undefined)
    assert.ok(task.leaseMs > 30 * 60_000)
    assert.equal(buildDailyReportTask({ profile, date: '2026-10-15', reportNow: new Date(), attempt: 3 }).id, 'daily-falive-2026-10-15-r3')
  })

  it('worker：跑 runDailyReport，成功回写 done + payload，失败回写 failed', async () => {
    const task = buildDailyReportTask({ profile, date: '2026-10-15', reportNow: new Date('2026-10-15T19:00:00') })
    const calls = []
    const reportStatus = async (...args) => { calls.push(args) }
    const client = { listTasks: async () => [{ id: 's1', status: 'waiting_confirmation', suspected: true }] }
    await runSystemTask({ task, client, workerConfig: { localConfig: {} }, reportStatus, deps: { runtimeDir: dir, runDailyReport: async ({ store, now }) => { assert.equal(store.listSuspected().length, 1); assert.equal(now.toISOString(), '2026-10-15T15:00:00.000Z'); return { ok: true, to: 'oc_falive', date: '2026-10-15', doc: { path: '/tmp/doc.md', url: 'https://doc' } } } } })
    assert.equal(calls[0][0], 'done')
    assert.deepEqual(calls[0][5].payload.doc, { path: '/tmp/doc.md', url: 'https://doc' })
    assert.equal(readDailyReportState(dir).falive, '2026-10-15', '发出去就先记已发，不等 gateway 回写')
    calls.length = 0
    const retry = buildDailyReportTask({ profile, date: '2026-10-16', reportNow: new Date('2026-10-16T19:00:00') })
    await runSystemTask({ task: retry, client, workerConfig: { localConfig: {} }, reportStatus, deps: { runtimeDir: dir, runDailyReport: async () => { throw new Error('probe down') } } })
    assert.equal(calls[0][0], 'failed')
    assert.match(calls[0][1], /probe down/)
  })

  it('worker：该日报日已发过 → 不再生成（回写失败被重试时不重发，10-19 发了两份）；群里「重发日报」照发', async () => {
    const sent = buildDailyReportTask({ profile, date: '2026-10-15', reportNow: new Date('2026-10-15T19:00:00') })
    const calls = []
    let generated = 0
    const deps = { runtimeDir: dir, runDailyReport: async () => { generated += 1; return { ok: true, to: 'oc_falive', date: '2026-10-15' } } }
    const client = { listTasks: async () => [] }
    await runSystemTask({ task: sent, client, workerConfig: { localConfig: {} }, reportStatus: async (...args) => { calls.push(args) }, deps })
    assert.equal(generated, 1)
    const again = buildDailyReportTask({ profile, date: '2026-10-15', reportNow: new Date('2026-10-15T19:00:00'), attempt: 2 })
    const outcome = await runSystemTask({ task: again, client, workerConfig: { localConfig: {} }, reportStatus: async (...args) => { calls.push(args) }, deps })
    assert.equal(generated, 1, '已发过不再生成')
    assert.equal(outcome.skipped, 'already sent')
    assert.equal(calls.at(-1)[0], 'done')
    const forced = buildDailyReportTask({ profile, date: '2026-10-15', reportNow: new Date('2026-10-15T19:00:00'), attempt: 3, force: true })
    await runSystemTask({ task: forced, client, workerConfig: { localConfig: {} }, reportStatus: async (...args) => { calls.push(args) }, deps })
    assert.equal(generated, 2, 'force 照发')
  })

  it('gateway：done 时写发送状态并排清扫，不发卡不回群；failed 且群里要的 → 私信负责人', async () => {
    const store = createTaskStore({ tasksDir: join(dir, 'tasks'), leaseMs: 60_000 })
    const docPath = join(dir, 'Falive日报-2026-10-15-完整版.md')
    writeFileSync(docPath, '# 日报\n')
    const task = store.upsert(buildDailyReportTask({ profile, date: '2026-10-15', reportNow: new Date('2026-10-15T19:00:00') }))
    store.claimById(task.id)
    const delivered = []
    // runtimeDir 指到临时目录：绝不能写真实 runtime 的日报状态（10-17 真机：这条测试曾把线上 state 改回 10-15）。
    const base = { config: { project: 'PR-1' }, store, runtimeDir: dir, resolveGroupChat: async () => null, sendMessage: async () => ({ ok: true }), postGroup: async () => { delivered.push('group'); return { ok: true } }, deliverRepo: async () => { delivered.push('repo'); return { ok: true } } }
    const done = await handleStatusUpdate({ ...base, id: task.id, status: 'done', result: '日报已发到 oc_falive', epoch: 0, payload: { date: '2026-10-15', doc: { path: docPath, url: 'https://doc' }, to: 'oc_falive' } })
    assert.deepEqual(done, { ok: true, system: true })
    assert.deepEqual(delivered, [], '系统任务不发卡不回群')
    assert.equal(store.get(task.id).status, 'done')
    assert.equal(readDailyReportState(dir).falive, '2026-10-15')
  })
})
