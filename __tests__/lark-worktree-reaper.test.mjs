/**
 * 分支回收的单测：判定口径用纯函数断言，删除副作用用真实 git 临时仓库断言（文件 / 分支 / 补丁是否还在）。
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, describe, it } from 'node:test'

import { createWorktreeReaper, decideReap, reapRepo } from '../lib/lark-worktree-reaper.mjs'

const HOUR = 60 * 60_000
const NOW = Date.parse('2026-10-19T12:00:00Z')
const closedAt = (ms) => new Date(NOW - ms).toISOString()

describe('decideReap', () => {
  const clean = { inTempDir: true, state: 'clean' }
  const dirty = { inTempDir: true, state: 'dirty' }
  const decide = (input) => decideReap({ branch: 'lark/falive-x', merged: true, now: NOW, ...input }).action

  it('回收决策：已合入干净就回收，活动 / 在用 / 未合入 / 脏现场按规则保留', () => {
    const t1 = '已合入 + 干净：不论任务已完成 / 失败 / 找不到，都回收'
    assert.equal(decide({ task: { id: 't', status: 'done' }, worktree: clean }), 'reap', t1)
    assert.equal(decide({ task: { id: 't', status: 'failed' }, worktree: clean }), 'reap', t1)
    assert.equal(decide({ task: null, worktree: clean }), 'reap', t1)
    assert.equal(decide({ task: null, worktree: null }), 'reap', t1)

    // 任务在活动态或状态不认识时不动
    for (const status of ['queued', 'running', 'verifying', 'received', 'done_pending_writeback', 'result_pending_receipt', 'some_new_status']) {
      assert.equal(decide({ task: { id: 't', status }, worktree: clean }), 'keep', status)
    }

    const t3 = 'worker 正在用、在临时目录外、git 不可读、有未合入提交：都保留'
    assert.equal(decide({ task: null, worktree: { ...clean, busy: true } }), 'keep', t3)
    assert.equal(decide({ task: null, worktree: { inTempDir: false, state: 'clean' } }), 'keep', t3)
    assert.equal(decide({ task: null, worktree: { inTempDir: true, state: 'error' } }), 'keep', t3)
    assert.equal(decide({ task: null, worktree: clean, merged: false }), 'keep', t3)

    const t4 = '有未提交改动：失败 / 阻塞 / 待确认留给续跑；已结单满宽限期才存补丁回收'
    for (const status of ['failed', 'blocked', 'waiting_confirmation']) {
      assert.equal(decide({ task: { id: 't', status, updatedAt: closedAt(48 * HOUR) }, worktree: dirty }), 'keep', status)
    }
    assert.equal(decide({ task: null, worktree: dirty }), 'keep', t4)
    assert.equal(decide({ task: { id: 't', status: 'superseded', updatedAt: closedAt(10 * 60_000) }, worktree: dirty }), 'keep', t4)
    const decision = decideReap({ branch: 'b', merged: true, now: NOW, task: { id: 't', status: 'superseded', updatedAt: closedAt(2 * HOUR) }, worktree: dirty })
    assert.equal(decision.action, 'reap', t4)
    assert.equal(decision.backup, true, t4)
  })
})

describe('reapRepo（真实 git）', () => {
  let sandbox
  let repo
  let wtDir
  let backupDir
  const run = (cwd, args) => {
    const res = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
    if (res.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${res.stderr || res.stdout}`)
    return res.stdout.trim()
  }
  const branchExists = (name) => spawnSync('git', ['-C', repo, 'show-ref', '--verify', '--quiet', `refs/heads/${name}`]).status === 0
  const profile = () => ({ key: 'falive', isDefault: false, root: repo, branchPrefix: 'lark/falive', integrationBranch: 'lark/falive-integration', baseRef: 'dev', tempWorktreeDir: wtDir })
  // 在临时目录开一个任务分支 + worktree，提交一个文件；merge=true 时合进集成分支
  const taskBranch = (id, { merge = true } = {}) => {
    const branch = `lark/falive-${id}`
    const path = join(wtDir, `lark-falive-${id}`)
    run(repo, ['worktree', 'add', '-b', branch, path, 'dev'])
    writeFileSync(join(path, `${id}.txt`), `${id}\n`)
    run(path, ['add', '-A'])
    run(path, ['commit', '-m', `task ${id}`])
    if (merge) run(join(wtDir, 'integration'), ['merge', '--no-ff', '-m', `merge ${id}`, branch])
    return { branch, path }
  }

  const setup = () => {
    sandbox = mkdtempSync(join(tmpdir(), 'lark-reaper-'))
    repo = join(sandbox, 'main')
    wtDir = join(sandbox, '.lark-falive')
    backupDir = join(sandbox, 'reaped')
    mkdirSync(repo)
    run(repo, ['init', '-b', 'dev'])
    run(repo, ['config', 'user.email', 't@t'])
    run(repo, ['config', 'user.name', 't'])
    writeFileSync(join(repo, 'base.txt'), 'base\n')
    run(repo, ['add', '-A'])
    run(repo, ['commit', '-m', 'base'])
    run(repo, ['worktree', 'add', '-b', 'lark/falive-integration', join(wtDir, 'integration'), 'dev'])
  }
  beforeEach(setup)
  after(() => {
    if (sandbox) rmSync(sandbox, { recursive: true, force: true })
  })

  it('真实 git 回收：删干净现场、脏现场存补丁、该留的都留、认 baseRef 合入、拉不到任务整轮跳过', async () => {
    {
      const case1 = '已合入的干净现场：删 worktree + 分支，集成分支不动'
      const { branch, path } = taskBranch('aaa')
      const results = reapRepo({ profile: profile(), tasks: [{ id: 't1', branch, status: 'done' }], backupDir, now: NOW })
      assert.deepEqual(results.map((item) => [item.branch, item.done]), [[branch, true]], case1)
      assert.equal(existsSync(path), false, case1)
      assert.equal(branchExists(branch), false, case1)
      assert.equal(branchExists('lark/falive-integration'), true, case1)
    }

    // 每段重建仓库沙箱，等同原 beforeEach
    rmSync(sandbox, { recursive: true, force: true })
    setup()
    {
      const case2 = '已结单的脏现场：补丁存下、可还原内容，再删'
      const { branch, path } = taskBranch('bbb')
      writeFileSync(join(path, 'base.txt'), 'base\nedited\n')
      writeFileSync(join(path, 'new.md'), 'draft\n')
      reapRepo({ profile: profile(), tasks: [{ id: 't2', branch, status: 'superseded', updatedAt: closedAt(2 * HOUR) }], backupDir, now: NOW })
      assert.equal(branchExists(branch), false, case2)
      const [patch] = readdirSync(backupDir)
      const text = readFileSync(join(backupDir, patch), 'utf8')
      assert.match(text, /\+edited/, case2)
      assert.match(text, /new\.md/, case2)
    }

    // 每段重建仓库沙箱，等同原 beforeEach
    rmSync(sandbox, { recursive: true, force: true })
    setup()
    {
      const t3 = '保留：失败任务的脏现场、未合入的分支、活动任务、在飞 cwd、临时目录外的 worktree'
      const failed = taskBranch('c01')
      writeFileSync(join(failed.path, 'base.txt'), 'half done\n')
      const unmerged = taskBranch('c02', { merge: false })
      const running = taskBranch('c03')
      const busy = taskBranch('c04')
      const human = { branch: 'lark/falive-c05', path: join(sandbox, 'human-wt') }
      run(repo, ['branch', human.branch, 'dev'])
      run(repo, ['worktree', 'add', human.path, human.branch])
      const tasks = [
        { id: 'f', branch: failed.branch, status: 'failed', updatedAt: closedAt(48 * HOUR) },
        { id: 'u', branch: unmerged.branch, status: 'done' },
        { id: 'r', branch: running.branch, status: 'running' },
      ]
      const results = reapRepo({ profile: profile(), tasks, backupDir, busyPaths: [busy.path], now: NOW })
      assert.ok(results.every((item) => !item.done), JSON.stringify(results))
      for (const item of [failed, unmerged, running, busy, human]) {
        assert.equal(branchExists(item.branch), true, item.branch)
        assert.equal(existsSync(item.path), true, item.path)
      }
      assert.equal(readFileSync(join(failed.path, 'base.txt'), 'utf8'), 'half done\n', t3)
    }

    // 每段重建仓库沙箱，等同原 beforeEach
    rmSync(sandbox, { recursive: true, force: true })
    setup()
    {
      const case4 = '已合进 baseRef（人类快进合入开发分支）但集成分支没有：也算已合入'
      const { branch } = taskBranch('ddd', { merge: false })
      run(repo, ['merge', '--ff-only', branch])
      reapRepo({ profile: profile(), tasks: [{ id: 't4', branch, status: 'failed' }], backupDir, now: NOW })
      assert.equal(branchExists(branch), false, case4)
    }

    // 每段重建仓库沙箱，等同原 beforeEach
    rmSync(sandbox, { recursive: true, force: true })
    setup()
    {
      const t5 = '拉不到任务列表：整轮跳过，什么都不删'
      const { branch } = taskBranch('eee')
      const quiet = { log() {}, warn() {} }
      const tick = createWorktreeReaper({ profiles: [profile()], listTasks: async () => { throw new Error('ECONNREFUSED') }, busyPaths: () => [], backupDir, log: quiet })
      assert.deepEqual(await tick(), [], t5)
      assert.equal(branchExists(branch), true, t5)
    }
  })
})
