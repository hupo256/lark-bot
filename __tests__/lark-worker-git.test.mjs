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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
