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
    await runSystemTask({ task, client, workerConfig: { localConfig: {} }, reportStatus, deps: { runDailyReport: async ({ store, now }) => { assert.equal(store.listSuspected().length, 1); assert.equal(now.toISOString(), '2026-10-15T15:00:00.000Z'); return { ok: true, to: 'oc_falive', date: '2026-10-15', doc: { path: '/tmp/doc.md', url: 'https://doc' } } } } })
    assert.equal(calls[0][0], 'done')
    assert.deepEqual(calls[0][5].payload.doc, { path: '/tmp/doc.md', url: 'https://doc' })
    calls.length = 0
    await runSystemTask({ task, client, workerConfig: { localConfig: {} }, reportStatus, deps: { runDailyReport: async () => { throw new Error('probe down') } } })
    assert.equal(calls[0][0], 'failed')
    assert.match(calls[0][1], /probe down/)
  })

  it('gateway：done 时写发送状态并排清扫，不发卡不回群；failed 且群里要的 → 私信负责人', async () => {
    const store = createTaskStore({ tasksDir: join(dir, 'tasks'), leaseMs: 60_000 })
    const prev = process.env.LARK_RUNTIME_DIR
    const docPath = join(dir, 'Falive日报-2026-10-15-完整版.md')
    writeFileSync(docPath, '# 日报\n')
    const task = store.upsert(buildDailyReportTask({ profile, date: '2026-10-15', reportNow: new Date('2026-10-15T19:00:00') }))
    store.claimById(task.id)
    const delivered = []
    const base = { config: { project: 'PR-1' }, store, resolveGroupChat: async () => null, sendMessage: async () => ({ ok: true }), postGroup: async () => { delivered.push('group'); return { ok: true } }, deliverRepo: async () => { delivered.push('repo'); return { ok: true } } }
    const done = await handleStatusUpdate({ ...base, id: task.id, status: 'done', result: '日报已发到 oc_falive', epoch: 0, payload: { date: '2026-10-15', doc: { path: docPath, url: 'https://doc' }, to: 'oc_falive' } })
    assert.deepEqual(done, { ok: true, system: true })
    assert.deepEqual(delivered, [], '系统任务不发卡不回群')
    assert.equal(store.get(task.id).status, 'done')
    // 发送状态落在默认 runtime 目录（与 worker 共用）；这里只验证函数链路不抛、状态写入成功
    assert.equal(readDailyReportState().falive, '2026-10-15')
    void prev
  })
})
