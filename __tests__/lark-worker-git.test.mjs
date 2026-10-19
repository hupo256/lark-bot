/**
 * lark-worker-git 的真实 git 单测（临时仓库，不碰主仓）。
 *
 * 这一层是整个 bot 里唯一会 `worktree remove --force` / `branch -D` 的代码——一旦它把
 * 「git 读不出来」当成「工作区干净」，或者 retry 时无条件重建上次刻意保留的现场，
 * 人类还没看过的改动就永久消失。故这里全部用真实 git 断言**副作用**（文件/提交/分支是否还在），
 * 而不是断言返回值措辞。setRepoRoot 就是为此存在的注入点。
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'

import {
  finalizeExistingWorktree,
  finalizeTempWorktree,
  inspectWorktreeIdentity,
  prepareTempWorktree,
  setRepoRoot,
} from '../lib/lark-worker-git.mjs'

let sandbox
let repo
const run = (cwd, args) => {
  const res = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${res.stderr || res.stdout}`)
  return res.stdout.trim()
}
const task = { id: 'T1', summary: '修一个 bug' }
const wtPath = () => join(sandbox, 'worktrees', 'T1')
const BRANCH = 'lark/hotfix-T1'

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'lark-git-'))
  const origin = join(sandbox, 'origin.git')
  repo = join(sandbox, 'main')
  spawnSync('git', ['init', '--bare', '-b', 'online', origin], { encoding: 'utf8' })
  mkdirSync(repo, { recursive: true })
  run(repo, ['init', '-b', 'online'])
  run(repo, ['config', 'user.email', 'test@example.com'])
  run(repo, ['config', 'user.name', 'test'])
  run(repo, ['config', 'commit.gpgsign', 'false'])
  writeFileSync(join(repo, 'base.txt'), 'base\n')
  run(repo, ['add', '-A'])
  run(repo, ['commit', '-m', 'base'])
  run(repo, ['remote', 'add', 'origin', origin])
  run(repo, ['push', '-u', 'origin', 'online'])
  setRepoRoot(repo)
})

after(() => {
  setRepoRoot(null)
  if (sandbox) rmSync(sandbox, { recursive: true, force: true })
})

// 每个用例都从「刚建好的干净临时 worktree」起步，互不污染。
beforeEach(() => {
  if (existsSync(wtPath())) spawnSync('git', ['-C', repo, 'worktree', 'remove', '--force', wtPath()], { encoding: 'utf8' })
  spawnSync('git', ['-C', repo, 'worktree', 'prune'], { encoding: 'utf8' })
  spawnSync('git', ['-C', repo, 'branch', '-D', BRANCH], { encoding: 'utf8' })
  rmSync(wtPath(), { recursive: true, force: true })
  prepareTempWorktree({ path: wtPath(), branch: BRANCH })
})

describe('挂起现场跟进新基线（教训 #40）', () => {
  it('现场有 intent-to-add 新文件与已改文件时，基线前移后能跟上，改动原样保留', () => {
    writeFileSync(join(wtPath(), 'base.txt'), 'base\nedited\n')
    writeFileSync(join(wtPath(), 'new-file.md'), 'draft\n')
    run(wtPath(), ['add', '-N', 'new-file.md'])
    writeFileSync(join(repo, 'other.txt'), 'moved\n')
    run(repo, ['add', 'other.txt'])
    run(repo, ['commit', '-m', 'base moves'])
    run(repo, ['push', 'origin', 'online'])
    prepareTempWorktree({ path: wtPath(), branch: BRANCH })
    assert.equal(readFileSync(join(wtPath(), 'other.txt'), 'utf8'), 'moved\n', '已跟上新基线')
    assert.equal(readFileSync(join(wtPath(), 'new-file.md'), 'utf8'), 'draft\n', '新文件还在')
    assert.equal(readFileSync(join(wtPath(), 'base.txt'), 'utf8'), 'base\nedited\n', '已改文件还在')
    assert.equal(run(wtPath(), ['stash', 'list']), '', '不留 stash')
  })
})

describe('inspectWorktreeIdentity（提交链身份锁）', () => {
  it('root / branch / HEAD 全部一致时通过', () => {
    const headSha = run(wtPath(), ['rev-parse', 'HEAD'])
    const identity = inspectWorktreeIdentity({ cwd: wtPath(), expectedBranch: BRANCH, expectedHeadSha: headSha })
    assert.equal(identity.ok, true)
    assert.equal(identity.branch, BRANCH)
    assert.equal(identity.headSha, headSha)
  })

  it('分支不符或任务执行期间 HEAD 改变时 fail-closed', () => {
    const headSha = run(wtPath(), ['rev-parse', 'HEAD'])
    assert.equal(inspectWorktreeIdentity({ cwd: wtPath(), expectedBranch: 'wrong-branch' }).ok, false)
    writeFileSync(join(wtPath(), 'ai-commit.txt'), 'committed outside worker\n')
    run(wtPath(), ['add', '-A'])
    run(wtPath(), ['commit', '-m', 'AI should not commit'])
    const changed = inspectWorktreeIdentity({ cwd: wtPath(), expectedBranch: BRANCH, expectedHeadSha: headSha })
    assert.equal(changed.ok, false)
    assert.ok(changed.problems.some((problem) => problem.includes('HEAD')))
  })
})

describe('prepareTempWorktree（retry/resume 不得摧毁保留的现场）', () => {
  it('新建：worktree 在 origin/online 上、分支已切好', () => {
    assert.equal(run(wtPath(), ['rev-parse', '--abbrev-ref', 'HEAD']), BRANCH)
    assert.equal(run(wtPath(), ['rev-parse', 'HEAD']), run(repo, ['rev-parse', 'origin/online']))
    assert.equal(existsSync(join(wtPath(), 'node_modules')), false, '创建 worktree 不应软链主仓依赖')
  })

  it('只迁移旧 bot 指向主仓的依赖软链，不碰独立安装', () => {
    mkdirSync(join(repo, 'node_modules'))
    writeFileSync(join(wtPath(), 'keep.txt'), 'unfinished\n')
    symlinkSync(join(repo, 'node_modules'), join(wtPath(), 'node_modules'), 'dir')
    prepareTempWorktree({ path: wtPath(), branch: BRANCH })
    assert.equal(existsSync(join(wtPath(), 'node_modules')), false)
    symlinkSync(join(repo, 'node_modules'), join(wtPath(), 'node_modules'), 'dir')
    rmSync(join(repo, 'node_modules'), { recursive: true, force: true })
    prepareTempWorktree({ path: wtPath(), branch: BRANCH })
    assert.equal(existsSync(join(wtPath(), 'node_modules')), false, '失效的旧链接也要移除')
    mkdirSync(join(wtPath(), 'node_modules'))
    prepareTempWorktree({ path: wtPath(), branch: BRANCH })
    assert.equal(existsSync(join(wtPath(), 'node_modules')), true)
  })

  it('项目 worktree 有 WIP 时：隔离分支从项目分支 HEAD 创建，不退回 origin/online', () => {
    const featureBranch = 'feature/PR-TEST'
    const isolatedBranch = 'lark/hotfix-feature-base'
    const isolatedPath = join(sandbox, 'worktrees', 'feature-base')
    run(repo, ['switch', '-c', featureBranch, 'origin/online'])
    writeFileSync(join(repo, 'feature-only.txt'), 'only on active feature\n')
    run(repo, ['add', '-A'])
    run(repo, ['commit', '-m', 'feature baseline'])
    const featureHead = run(repo, ['rev-parse', 'HEAD'])
    run(repo, ['switch', 'online'])
    // 模拟旧版本进程中断后遗留的「基于 online、无独有提交」空 hotfix；新路由必须安全重建到 feature 基线。
    run(repo, ['branch', isolatedBranch, 'origin/online'])

    try {
      prepareTempWorktree({ path: isolatedPath, branch: isolatedBranch, baseRef: featureHead })
      assert.equal(run(isolatedPath, ['rev-parse', 'HEAD']), featureHead)
      assert.ok(existsSync(join(isolatedPath, 'feature-only.txt')), '隔离 worktree 必须看得到 feature 分支已有代码')
      const outcome = finalizeTempWorktree({ path: isolatedPath, branch: isolatedBranch, baseRef: featureHead, task, allowCommit: true })
      assert.equal(outcome.committed, false)
      assert.notEqual(spawnSync('git', ['-C', repo, 'rev-parse', '--verify', isolatedBranch], { encoding: 'utf8' }).status, 0)
    } finally {
      if (existsSync(isolatedPath)) spawnSync('git', ['-C', repo, 'worktree', 'remove', '--force', isolatedPath], { encoding: 'utf8' })
      spawnSync('git', ['-C', repo, 'branch', '-D', isolatedBranch], { encoding: 'utf8' })
      spawnSync('git', ['-C', repo, 'branch', '-D', featureBranch], { encoding: 'utf8' })
    }
  })

  it('有未提交改动 → 原地复用，改动不丢', () => {
    writeFileSync(join(wtPath(), 'wip.txt'), 'half done\n')
    prepareTempWorktree({ path: wtPath(), branch: BRANCH })
    assert.ok(existsSync(join(wtPath(), 'wip.txt')), 'retry 不得删掉上次保留的半成品')
  })

  it('分支已有提交（AI 自行 commit 后失败） → 复用，提交不被 -B 重置', () => {
    writeFileSync(join(wtPath(), 'fix.txt'), 'fixed\n')
    run(wtPath(), ['add', '-A'])
    run(wtPath(), ['commit', '-m', 'ai commit'])
    const head = run(wtPath(), ['rev-parse', 'HEAD'])
    prepareTempWorktree({ path: wtPath(), branch: BRANCH })
    assert.equal(run(wtPath(), ['rev-parse', 'HEAD']), head, 'worktree add -B 会把分支重置回 origin/online，丢掉这笔提交')
  })

  it('上一轮成功收尾后 QA 验退 → 从原 hotfix 分支继续，不丢上一轮提交', () => {
    writeFileSync(join(wtPath(), 'first-fix.txt'), 'first round\n')
    const first = finalizeTempWorktree({ path: wtPath(), branch: BRANCH, task, allowCommit: true })
    assert.equal(first.committed, true)
    const firstHead = run(repo, ['rev-parse', BRANCH])

    prepareTempWorktree({ path: wtPath(), branch: BRANCH })
    assert.equal(run(wtPath(), ['rev-parse', 'HEAD']), firstHead)
    assert.ok(existsSync(join(wtPath(), 'first-fix.txt')))

    writeFileSync(join(wtPath(), 'second-fix.txt'), 'QA return round\n')
    const second = finalizeTempWorktree({ path: wtPath(), branch: BRANCH, task, allowCommit: true })
    assert.equal(second.committed, true)
    assert.equal(run(repo, ['rev-list', '--count', `origin/online..${BRANCH}`]), '2')
  })

  it('残留空壳目录（不是有效 worktree） → 重建', () => {
    const shell = join(sandbox, 'worktrees', 'shell')
    mkdirSync(shell, { recursive: true })
    writeFileSync(join(shell, 'junk.txt'), 'junk\n')
    prepareTempWorktree({ path: shell, branch: 'lark/hotfix-shell' })
    assert.equal(run(shell, ['rev-parse', '--abbrev-ref', 'HEAD']), 'lark/hotfix-shell')
    spawnSync('git', ['-C', repo, 'worktree', 'remove', '--force', shell], { encoding: 'utf8' })
    spawnSync('git', ['-C', repo, 'branch', '-D', 'lark/hotfix-shell'], { encoding: 'utf8' })
  })
})

describe('finalizeTempWorktree（ok=false 即「改动没落盘」，调用方据此不报完成）', () => {
  it('正常运行提交 hook，失败保留 worktree 和改动', () => {
    const hooks = join(sandbox, 'reject-hooks')
    mkdirSync(hooks)
    writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    run(repo, ['config', 'core.hooksPath', hooks])
    try {
      writeFileSync(join(wtPath(), 'fix.txt'), 'fixed\n')
      const outcome = finalizeTempWorktree({ path: wtPath(), branch: BRANCH, task, allowCommit: true })
      assert.equal(outcome.ok, false)
      assert.ok(existsSync(join(wtPath(), 'fix.txt')))
      assert.equal(run(repo, ['rev-list', '--count', `origin/online..${BRANCH}`]), '0')
    } finally {
      run(repo, ['config', '--unset', 'core.hooksPath'])
      rmSync(hooks, { recursive: true, force: true })
    }
  })

  it('有改动 + 允许提交 → 提交进分支并删目录', () => {
    writeFileSync(join(wtPath(), 'fix.txt'), 'fixed\n')
    const outcome = finalizeTempWorktree({ path: wtPath(), branch: BRANCH, task, allowCommit: true })
    assert.deepEqual({ ok: outcome.ok, committed: outcome.committed }, { ok: true, committed: true })
    assert.equal(existsSync(wtPath()), false)
    assert.equal(run(repo, ['rev-list', '--count', `origin/online..${BRANCH}`]), '1')
  })

  // `lark-task:` trailer 是「群里这条反馈 → 哪个提交」的机器可查锚点（D5）。
  it('提交信息带 lark-task trailer，可被 git log --grep 精确捞出', () => {
    writeFileSync(join(wtPath(), 'trailer.txt'), 'x\n')
    finalizeTempWorktree({ path: wtPath(), branch: BRANCH, task, allowCommit: true })
    assert.match(run(repo, ['log', '-1', '--format=%B', BRANCH]), /^lark-task: T1$/m)
    assert.equal(run(repo, ['log', '--grep', '^lark-task: T1$', '--format=%h', BRANCH]).split('\n').filter(Boolean).length, 1)
  })

  it('有改动 + 不允许提交（失败/阻塞） → ok=false，现场完整保留', () => {
    writeFileSync(join(wtPath(), 'half.txt'), 'half\n')
    const outcome = finalizeTempWorktree({ path: wtPath(), branch: BRANCH, task, allowCommit: false })
    assert.equal(outcome.ok, false)
    assert.ok(existsSync(join(wtPath(), 'half.txt')), '未完成的半成品必须留在原地')
  })

  it('无改动且分支无提交 → 目录与空分支一起清掉', () => {
    const outcome = finalizeTempWorktree({ path: wtPath(), branch: BRANCH, task, allowCommit: true })
    assert.deepEqual({ ok: outcome.ok, committed: outcome.committed }, { ok: true, committed: false })
    assert.equal(existsSync(wtPath()), false)
    assert.notEqual(spawnSync('git', ['-C', repo, 'rev-parse', '--verify', BRANCH], { encoding: 'utf8' }).status, 0)
  })

  it('工作区干净但分支已有提交（AI 自行 commit） → 删目录保分支', () => {
    writeFileSync(join(wtPath(), 'fix.txt'), 'fixed\n')
    run(wtPath(), ['add', '-A'])
    run(wtPath(), ['commit', '-m', 'ai commit'])
    const outcome = finalizeTempWorktree({ path: wtPath(), branch: BRANCH, task, allowCommit: true })
    assert.deepEqual({ ok: outcome.ok, committed: outcome.committed }, { ok: true, committed: true })
    assert.equal(spawnSync('git', ['-C', repo, 'rev-parse', '--verify', BRANCH], { encoding: 'utf8' }).status, 0)
  })

  it('git 状态读不出来（非 git 目录） → ok=false 且不做任何删除', () => {
    const alien = mkdtempSync(join(tmpdir(), 'lark-alien-'))
    writeFileSync(join(alien, 'keep.txt'), 'keep\n')
    const outcome = finalizeTempWorktree({ path: alien, branch: BRANCH, task, allowCommit: true })
    assert.equal(outcome.ok, false, 'git 异常绝不能被当成「干净可删」')
    assert.ok(existsSync(join(alien, 'keep.txt')))
    rmSync(alien, { recursive: true, force: true })
  })
})

describe('finalizeExistingWorktree（命中已有 worktree 的定向收尾提交）', () => {
  it('提交 hook 只看到定向文件，已有暂存 WIP 不进入提交', () => {
    const hooks = join(sandbox, 'scope-hooks')
    const observed = join(sandbox, 'hook-staged.txt')
    mkdirSync(hooks)
    writeFileSync(join(hooks, 'pre-commit'), `#!/bin/sh\ngit diff --cached --name-only > "${observed}"\n`, { mode: 0o755 })
    run(repo, ['config', 'core.hooksPath', hooks])
    try {
      writeFileSync(join(wtPath(), 'human-wip.txt'), 'human\n')
      run(wtPath(), ['add', 'human-wip.txt'])
      writeFileSync(join(wtPath(), 'bot.txt'), 'bot\n')
      const outcome = finalizeExistingWorktree({ cwd: wtPath(), task, taskPaths: ['bot.txt'] })
      assert.equal(outcome.ok, true)
      assert.equal(run(wtPath(), ['show', '--format=', '--name-only', 'HEAD']), 'bot.txt')
      assert.equal(readFileSync(observed, 'utf8').trim(), 'bot.txt')
      assert.match(run(wtPath(), ['diff', '--cached', '--name-only']), /human-wip\.txt/)
    } finally {
      run(repo, ['config', '--unset', 'core.hooksPath'])
      rmSync(hooks, { recursive: true, force: true })
    }
  })
  it('改动在本任务实测清单内 → 提交到当前分支', () => {
    writeFileSync(join(wtPath(), 'fix.txt'), 'fixed\n')
    const outcome = finalizeExistingWorktree({ cwd: wtPath(), task, taskPaths: ['fix.txt'] })
    assert.deepEqual({ ok: outcome.ok, committed: outcome.committed }, { ok: true, committed: true })
    assert.equal(run(wtPath(), ['status', '--porcelain']), '')
  })

  it('任务执行期间新出现的改动不进提交，且在 unexpected 里显形', () => {
    writeFileSync(join(wtPath(), 'bot.txt'), 'bot\n')
    writeFileSync(join(wtPath(), 'human-wip.txt'), 'human\n')
    const outcome = finalizeExistingWorktree({ cwd: wtPath(), task, taskPaths: ['bot.txt'] })
    assert.deepEqual({ ok: outcome.ok, committed: outcome.committed }, { ok: true, committed: true })
    assert.deepEqual(outcome.unexpected, ['human-wip.txt'])
    assert.match(run(wtPath(), ['show', '--stat', '--name-only', 'HEAD']), /bot\.txt/)
    assert.doesNotMatch(run(wtPath(), ['show', '--name-only', 'HEAD']), /human-wip\.txt/, '人类 WIP 绝不能被提交')
    assert.match(run(wtPath(), ['status', '--porcelain']), /human-wip\.txt/, 'WIP 应原样留在工作区')
    rmSync(join(wtPath(), 'human-wip.txt'), { force: true })
    run(wtPath(), ['reset'])
  })

  it('实测清单为空（无从证明哪些是本任务的）→ 一个都不提交且 ok=false', () => {
    writeFileSync(join(wtPath(), 'unknown.txt'), 'x\n')
    const outcome = finalizeExistingWorktree({ cwd: wtPath(), task, taskPaths: [] })
    assert.deepEqual({ ok: outcome.ok, committed: outcome.committed }, { ok: false, committed: false })
    assert.match(run(wtPath(), ['status', '--porcelain']), /unknown\.txt/)
    rmSync(join(wtPath(), 'unknown.txt'), { force: true })
    run(wtPath(), ['reset'])
  })

  it('无改动 → 不提交，ok=true', () => {
    const outcome = finalizeExistingWorktree({ cwd: wtPath(), task, taskPaths: ['fix.txt'] })
    assert.deepEqual({ ok: outcome.ok, committed: outcome.committed }, { ok: true, committed: false })
  })

  it('git 状态读不出来 → ok=false（调用方据此不报完成）', () => {
    const alien = mkdtempSync(join(tmpdir(), 'lark-alien-'))
    const outcome = finalizeExistingWorktree({ cwd: alien, task, taskPaths: ['fix.txt'] })
    assert.equal(outcome.ok, false)
    rmSync(alien, { recursive: true, force: true })
  })
})

describe('集成分支（整改 #10）', () => {
  it('建分支 + 常驻 worktree；同步 base；任务分支 no-ff 合回；冲突 abort 并报文件', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { spawnSync } = await import('node:child_process')
    const { ensureIntegrationBranch, mergeIntoIntegration } = await import('../lib/lark-worker-git.mjs')
    const root = mkdtempSync(join(tmpdir(), 'lark-integ-'))
    const g = (args, cwd = root) => { const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim() }
    try {
      g(['init', '-b', 'feature/base']); g(['config', 'user.email', 't@x']); g(['config', 'user.name', 't'])
      writeFileSync(join(root, 'a.txt'), '1\n'); g(['add', '-A']); g(['commit', '-m', 'base'])
      const wt = join(root, '.wt', 'integration')
      const first = ensureIntegrationBranch({ root, integrationBranch: 'lark/integ', baseRef: 'feature/base', worktreePath: wt })
      assert.equal(first.ok, true)
      // base 前进 → 再 ensure 时合进来
      writeFileSync(join(root, 'b.txt'), '2\n'); g(['add', '-A']); g(['commit', '-m', 'base2'])
      const second = ensureIntegrationBranch({ root, integrationBranch: 'lark/integ', baseRef: 'feature/base', worktreePath: wt })
      assert.equal(second.ok, true)
      assert.equal(g(['merge-base', '--is-ancestor', 'feature/base', 'lark/integ']), '')
      // 任务分支从集成分支开、提交、合回
      g(['branch', 'lark/t1', 'lark/integ'])
      const t1 = join(root, '.wt', 't1'); g(['worktree', 'add', t1, 'lark/t1'])
      writeFileSync(join(t1, 'c.txt'), '3\n'); g(['add', '-A'], t1); g(['commit', '-m', 't1'], t1)
      const merged = mergeIntoIntegration({ root, worktreePath: wt, branch: 'lark/t1', integrationBranch: 'lark/integ', message: 'merge t1' })
      assert.equal(merged.ok, true); assert.equal(merged.merged, true)
      assert.equal(g(['merge-base', '--is-ancestor', 'lark/t1', 'lark/integ']), '')
      // 冲突：t2 与集成分支改同一文件
      g(['branch', 'lark/t2', 'feature/base'])
      const t2 = join(root, '.wt', 't2'); g(['worktree', 'add', t2, 'lark/t2'])
      writeFileSync(join(t2, 'c.txt'), 'conflict\n'); g(['add', '-A'], t2); g(['commit', '-m', 't2'], t2)
      const conflict = mergeIntoIntegration({ root, worktreePath: wt, branch: 'lark/t2', integrationBranch: 'lark/integ', message: 'merge t2' })
      assert.equal(conflict.ok, false); assert.deepEqual(conflict.conflicts, ['c.txt'])
      assert.equal(g(['status', '--porcelain'], wt), '', '冲突已 abort，集成 worktree 干净')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('合回集成分支后删任务分支（aven 2026-10-16）', () => {
  it('已被集成分支包含才删；未合入 / 非 lark/ / 集成分支本身 / 仍被检出 都不删', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { spawnSync } = await import('node:child_process')
    const { ensureIntegrationBranch, mergeIntoIntegration, deleteMergedTaskBranch } = await import('../lib/lark-worker-git.mjs')
    const root = mkdtempSync(join(tmpdir(), 'lark-integ-del-'))
    const g = (args, cwd = root) => { const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim() }
    const exists = (b) => spawnSync('git', ['-C', root, 'rev-parse', '--verify', '--quiet', `refs/heads/${b}`]).status === 0
    try {
      g(['init', '-b', 'feature/base']); g(['config', 'user.email', 't@x']); g(['config', 'user.name', 't'])
      writeFileSync(join(root, 'a.txt'), '1\n'); g(['add', '-A']); g(['commit', '-m', 'base'])
      const wt = join(root, '.wt', 'integration')
      assert.equal(ensureIntegrationBranch({ root, integrationBranch: 'lark/integ', baseRef: 'feature/base', worktreePath: wt }).ok, true)
      const commitOn = (branch, file, from = 'lark/integ') => {
        g(['branch', branch, from])
        const dir = join(root, '.wt', branch.replace('/', '-')); g(['worktree', 'add', dir, branch])
        writeFileSync(join(dir, file), `${branch}\n`); g(['add', '-A'], dir); g(['commit', '-m', branch], dir)
        return dir
      }
      // 1. 合回成功 → 删（模拟 finalizeTempWorktree 先删了临时 worktree）
      const t1 = commitOn('lark/t1', 'c.txt')
      g(['worktree', 'remove', '--force', t1])
      assert.equal(mergeIntoIntegration({ root, worktreePath: wt, branch: 'lark/t1', integrationBranch: 'lark/integ', message: 'merge t1' }).ok, true)
      assert.deepEqual(deleteMergedTaskBranch({ root, branch: 'lark/t1', integrationBranch: 'lark/integ' }), { deleted: true })
      assert.equal(exists('lark/t1'), false)
      assert.equal(g(['show', 'lark/integ:c.txt']), 'lark/t1', '改动仍在集成分支里')
      // 2. 有集成分支不包含的提交 → 不删
      const t2 = commitOn('lark/t2', 'd.txt'); g(['worktree', 'remove', '--force', t2])
      assert.equal(deleteMergedTaskBranch({ root, branch: 'lark/t2', integrationBranch: 'lark/integ' }).deleted, false)
      assert.equal(exists('lark/t2'), true)
      // 3. 已合入但仍被 worktree 检出（失败现场）→ branch -D 拒绝，不删
      const t3 = commitOn('lark/t3', 'e.txt')
      mergeIntoIntegration({ root, worktreePath: wt, branch: 'lark/t3', integrationBranch: 'lark/integ', message: 'merge t3' })
      assert.equal(deleteMergedTaskBranch({ root, branch: 'lark/t3', integrationBranch: 'lark/integ' }).deleted, false)
      assert.equal(exists('lark/t3'), true)
      g(['worktree', 'remove', '--force', t3])
      // 4. 非 lark/ 分支、集成分支本身、不存在的分支 → 不删
      assert.equal(deleteMergedTaskBranch({ root, branch: 'feature/base', integrationBranch: 'lark/integ' }).deleted, false)
      assert.equal(exists('feature/base'), true)
      assert.equal(deleteMergedTaskBranch({ root, branch: 'lark/integ', integrationBranch: 'lark/integ' }).deleted, false)
      assert.equal(exists('lark/integ'), true)
      assert.equal(deleteMergedTaskBranch({ root, branch: 'lark/nope', integrationBranch: 'lark/integ' }).reason, '分支已不存在')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
