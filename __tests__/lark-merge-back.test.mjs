/**
 * 合回负责人工作分支（aven 2026-10-27，取代集成分支）的真实 git 单测：每段自建临时仓库，不碰主仓。
 * 从 lark-worker-git.test.mjs 拆出来单独成文件，和它并行跑（那个文件本身已经是全量测试里最慢的一条）。
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { runSteps } from './support/steps.mjs'

describe('合回负责人工作分支（aven 2026-10-27，取代集成分支）：主目录三道检查、上游同步、排队重试、删任务分支', () => {
  // 每段自建一个真实仓库：root 检出 feature/base（= 负责人的主目录），bare origin 上有 pre。
  const makeRepo = () => {
    const root = mkdtempSync(join(tmpdir(), 'lark-mergeback-'))
    const g = (args, cwd = root) => { const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(`git ${args.join(' ')}：${r.stderr}`); return r.stdout.trim() }
    g(['init', '-b', 'feature/base']); g(['config', 'user.email', 't@x']); g(['config', 'user.name', 't'])
    writeFileSync(join(root, 'a.txt'), '1\n'); g(['add', '-A']); g(['commit', '-m', 'base'])
    const rootCommit = g(['rev-parse', 'HEAD'])
    // 给 branch 造一个「在 from 上改 / 加一个文件」的提交（模拟 bot 任务分支）：用独立索引 + commit-tree，不建 worktree、不碰主目录（省时）。
    const commitOn = (branch, file, content, from = 'feature/base') => {
      const env = { ...process.env, GIT_INDEX_FILE: join(root, '.git', 'lark-test-index') }
      const p = (args, input) => { const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', env, input }); if (r.status !== 0) throw new Error(`git ${args.join(' ')}：${r.stderr}`); return r.stdout.trim() }
      p(['read-tree', from])
      p(['update-index', '--add', '--cacheinfo', `100644,${p(['hash-object', '-w', '--stdin'], content)},${file}`])
      g(['branch', branch, p(['commit-tree', p(['write-tree']), '-p', from, '-m', branch])])
    }
    const exists = (branch) => spawnSync('git', ['-C', root, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0
    const parents = (ref) => g(['rev-list', '--parents', '-n', '1', ref]).split(' ').length - 1
    return { root, g, rootCommit, commitOn, exists, parents, cleanup: () => rmSync(root, { recursive: true, force: true }) }
  }

  it('主目录合并、上游同步、删任务分支、排队重试与私信，合并提交信息以 Merge branch 开头', () => runSteps([
    ['主目录合并：干净 --no-ff 合上 / 已包含 / 暂存区有内容排队 / 改动不重叠照合且原样 / 重叠（含未跟踪）排队 / 冲突不留现场 / 不在 baseRef 排队', async () => {
      const { mergeIntoMainWorktree, mergeBackMessage } = await import('../lib/lark-worker-git.mjs')
      const { root, g, rootCommit, commitOn, parents } = makeRepo()
      const m = (ref) => mergeIntoMainWorktree({ root, baseRef: 'feature/base', ref, message: mergeBackMessage({ branch: ref, into: 'feature/base' }) })
      try {
        commitOn('lark/t1', 'c.txt', 't1\n')
        const first = m('lark/t1')
        assert.equal(first.ok, true); assert.equal(first.merged, true)
        assert.equal(parents('feature/base'), 2, '--no-ff 留合并提交')
        assert.equal(readFileSync(join(root, 'c.txt'), 'utf8'), 't1\n', '主目录工作区跟着更新')
        assert.equal(m('lark/t1').merged, false, '已包含不重复合')
        // 暂存区有内容：不动手，暂存区原样
        commitOn('lark/t2', 'd.txt', 't2\n')
        writeFileSync(join(root, 'staged.txt'), 's\n'); g(['add', 'staged.txt'])
        const staged = m('lark/t2')
        assert.equal(staged.pending, true); assert.match(staged.reason, /暂存区/)
        assert.equal(g(['diff', '--cached', '--name-only']), 'staged.txt'); assert.equal(existsSync(join(root, 'd.txt')), false)
        g(['reset', '-q', 'staged.txt'])
        // 未提交改动（已跟踪 + 未跟踪）与要合的文件不重叠：照合，改动原样
        writeFileSync(join(root, 'a.txt'), 'local edit\n')
        const disjoint = m('lark/t2')
        assert.equal(disjoint.ok, true)
        assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'local edit\n'); assert.equal(readFileSync(join(root, 'staged.txt'), 'utf8'), 's\n')
        // 重叠：已跟踪改动 a.txt、未跟踪 e.txt 都排队，改动原样
        commitOn('lark/t3', 'a.txt', 't3\n')
        const tracked = m('lark/t3')
        assert.equal(tracked.pending, true); assert.match(tracked.reason, /重叠：a\.txt/)
        assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'local edit\n')
        writeFileSync(join(root, 'e.txt'), 'mine\n'); commitOn('lark/t5', 'e.txt', 't5\n')
        assert.match(m('lark/t5').reason, /重叠：e\.txt/)
        assert.equal(readFileSync(join(root, 'e.txt'), 'utf8'), 'mine\n')
        g(['checkout', '--', 'a.txt']); rmSync(join(root, 'e.txt')); rmSync(join(root, 'staged.txt'))
        // 冲突：从根提交另起一支改 c.txt → 返回冲突文件，工作区干净、没有进行中的合并
        commitOn('lark/t4', 'c.txt', 't4\n', rootCommit)
        const conflict = m('lark/t4')
        assert.equal(conflict.ok, false); assert.equal(conflict.pending, undefined); assert.deepEqual(conflict.conflicts, ['c.txt'])
        assert.equal(g(['status', '--porcelain']), ''); assert.equal(spawnSync('git', ['-C', root, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD']).status, 1)
        // 主目录不在 baseRef 上
        g(['switch', '-q', '-c', 'other'])
        assert.match(m('lark/t3').reason, /不在 feature\/base 上（在 other）/)
        g(['switch', '-q', 'feature/base'])
        assert.equal(m('lark/nope').ok, false, '不存在的分支')
        // 试合干净但 commit-msg 钩子拒绝：合到一半退回，主目录不留进行中的合并
        commitOn('lark/t6', 'h.txt', 't6\n')
        const hooksDir = join(root, '.reject-hooks'); mkdirSync(hooksDir)
        writeFileSync(join(hooksDir, 'commit-msg'), '#!/bin/sh\nexit 1\n', { mode: 0o755 }); g(['config', 'core.hooksPath', hooksDir])
        const rejected = m('lark/t6')
        assert.equal(rejected.pending, true); assert.match(rejected.reason, /^git merge 失败/)
        assert.equal(spawnSync('git', ['-C', root, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD']).status, 1, '不留 MERGE_HEAD')
        assert.equal(g(['status', '--porcelain', '--untracked-files=no']), ''); assert.equal(existsSync(join(root, 'h.txt')), false)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }],
    ['上游同步：能快进就快进；分叉时生成以 Merge branch 开头的合并提交；冲突返回 conflicts 与上游 sha', async () => {
      const { syncBaseFromUpstream } = await import('../lib/lark-worker-git.mjs')
      const { root, g, commitOn, parents, cleanup } = makeRepo()
      const origin = `${root}-origin.git`
      try {
        g(['init', '--bare', '-q', origin], root); g(['remote', 'add', 'origin', origin]); g(['push', '-q', 'origin', 'feature/base:pre'])
        const sync = () => syncBaseFromUpstream({ root, baseRef: 'feature/base', upstream: 'origin/pre' })
        commitOn('up1', 'u.txt', 'u1\n'); g(['push', '-q', 'origin', 'up1:pre'])
        const ff = sync()
        assert.equal(ff.ok, true); assert.equal(g(['rev-parse', 'feature/base']), g(['rev-parse', 'origin/pre']), '快进')
        assert.equal(ff.upstreamSha, g(['rev-parse', 'origin/pre']))
        writeFileSync(join(root, 'f.txt'), 'local\n'); g(['add', '-A']); g(['commit', '-q', '-m', 'local'])
        commitOn('up2', 'g.txt', 'u2\n', 'origin/pre'); g(['push', '-q', 'origin', 'up2:pre'])
        assert.equal(sync().merged, true)
        assert.equal(parents('feature/base'), 2)
        assert.match(g(['log', '-1', '--format=%s', 'feature/base']), /^Merge branch 'origin\/pre' into feature\/base/)
        writeFileSync(join(root, 'g.txt'), 'local g\n'); g(['add', '-A']); g(['commit', '-q', '-m', 'local g'])
        commitOn('up3', 'g.txt', 'u3\n', 'origin/pre'); g(['push', '-q', 'origin', 'up3:pre'])
        const conflict = sync()
        assert.deepEqual(conflict.conflicts, ['g.txt']); assert.equal(conflict.upstreamSha, g(['rev-parse', 'origin/pre']))
        assert.equal(g(['status', '--porcelain']), '')
      } finally {
        cleanup(); rmSync(origin, { recursive: true, force: true })
      }
    }],
    ['删任务分支：已被合入目标包含才删；未合入 / 非本仓前缀 / 合入目标本身 / 仍被检出 / 不存在 都不删', async () => {
      const { deleteMergedTaskBranch, mergeIntoMainWorktree } = await import('../lib/lark-worker-git.mjs')
      const { root, g, commitOn, exists, cleanup } = makeRepo()
      const del = (branch, branchPrefix = null) => deleteMergedTaskBranch({ root, branch, into: 'feature/base', branchPrefix })
      try {
        commitOn('lark/t1', 'c.txt', 't1\n')
        mergeIntoMainWorktree({ root, baseRef: 'feature/base', ref: 'lark/t1', message: 'Merge branch lark/t1' })
        assert.deepEqual(del('lark/t1'), { deleted: true }); assert.equal(exists('lark/t1'), false)
        assert.equal(g(['show', 'feature/base:c.txt']), 't1', '改动仍在合入目标里')
        commitOn('lark/t2', 'd.txt', 't2\n')
        assert.match(del('lark/t2').reason, /未完整包含/); assert.equal(exists('lark/t2'), true)
        g(['worktree', 'add', join(root, '.wt', 'busy'), 'lark/t2'])
        mergeIntoMainWorktree({ root, baseRef: 'feature/base', ref: 'lark/t2', message: 'Merge branch lark/t2' })
        assert.equal(del('lark/t2').deleted, false, '仍被 worktree 检出'); assert.equal(exists('lark/t2'), true)
        assert.equal(del('feature/base').deleted, false); assert.equal(del('lark/nope').reason, '分支已不存在')
        commitOn('lark/falive-t3', 'f.txt', 't3\n')
        mergeIntoMainWorktree({ root, baseRef: 'feature/base', ref: 'lark/falive-t3', message: 'Merge branch lark/falive-t3' })
        assert.equal(del('lark/falive-t3', 'lark/other').deleted, false); assert.equal(exists('lark/falive-t3'), true)
        assert.deepEqual(del('lark/falive-t3', 'lark/falive'), { deleted: true })
      } finally {
        cleanup()
      }
    }],
    ['排队重试：暂不能合排队并只提醒一次、条件满足自动合并删分支、冲突移出队列交人、上游冲突同一 sha 只报一次、私信聚合成一条', async () => {
      const { mergeBackAfterTask, retryMergeBack, createMergeBackRetrier, syncBeforeTask } = await import('../lib/lark-merge-back.mjs')
      const { loadMergeBackState, queuePendingMerge, recordSyncResult } = await import('../lib/lark-merge-back-state.mjs')
      const { root, g, rootCommit, commitOn, exists, cleanup } = makeRepo()
      const runtimeDir = mkdtempSync(join(tmpdir(), 'lark-mergeback-rt-'))
      const deps = { runtimeDir }
      const profile = { key: 'falive', isDefault: false, title: 'Falive Web', root, baseRef: 'feature/base', branchPrefix: 'lark/falive', mergeBack: { upstream: 'origin/pre' } }
      try {
        commitOn('lark/falive-r1', 'r1.txt', 'r1\n')
        writeFileSync(join(root, 'staged.txt'), 's\n'); g(['add', 'staged.txt'])
        const queued = mergeBackAfterTask({ profile, task: { id: 'r1', summary: '改 r1' }, branch: 'lark/falive-r1', deps })
        assert.equal(queued.pending, true)
        assert.deepEqual(loadMergeBackState('falive', deps).pending.map((item) => [item.taskId, item.notified]), [['r1', false]])
        const firstLines = retryMergeBack({ profile, deps })
        assert.equal(firstLines.length, 1); assert.match(firstLines[0], /^⏸ 等合进 feature\/base：改 r1（主目录暂存区有内容/)
        assert.deepEqual(retryMergeBack({ profile, deps }), [], '同一条只提醒一次')
        g(['reset', '-q', 'staged.txt']); rmSync(join(root, 'staged.txt'))
        assert.deepEqual(retryMergeBack({ profile, deps }), ['✅ 已合进 feature/base：改 r1'])
        assert.equal(exists('lark/falive-r1'), false); assert.deepEqual(loadMergeBackState('falive', deps).pending, [])
        // 冲突：移出队列、分支保留
        commitOn('lark/falive-r2', 'r1.txt', 'other\n', rootCommit)
        queuePendingMerge('falive', { taskId: 'r2', branch: 'lark/falive-r2', summary: '改 r2' }, deps)
        assert.match(retryMergeBack({ profile, deps })[0], /^⚠ 没合进 feature\/base：改 r2（合进 feature\/base 有冲突：r1\.txt）。分支 lark\/falive-r2 保留/)
        assert.equal(exists('lark/falive-r2'), true); assert.deepEqual(loadMergeBackState('falive', deps).pending, [])
        // 分支已被手动处理掉：静默移出队列
        queuePendingMerge('falive', { taskId: 'gone', branch: 'lark/falive-gone', summary: 'x' }, deps)
        assert.deepEqual(retryMergeBack({ profile, deps }), []); assert.deepEqual(loadMergeBackState('falive', deps).pending, [])
        // 上游冲突：同一个上游 sha 只报一次；换了 sha 再报；同步成功清掉
        recordSyncResult('falive', { conflict: '合进 feature/base 有冲突：u.txt', upstreamSha: 'sha1' }, deps)
        assert.match(retryMergeBack({ profile, deps })[0], /^⚠ origin\/pre 同步进 feature\/base 时有冲突：u\.txt。/)
        recordSyncResult('falive', { conflict: '合进 feature/base 有冲突：u.txt', upstreamSha: 'sha1' }, deps)
        assert.deepEqual(retryMergeBack({ profile, deps }), [])
        recordSyncResult('falive', { conflict: '合进 feature/base 有冲突：u.txt', upstreamSha: 'sha2' }, deps)
        assert.equal(retryMergeBack({ profile, deps }).length, 1)
        recordSyncResult('falive', {}, deps)
        assert.equal(loadMergeBackState('falive', deps).syncConflict, null)
        // 开任务前的同步：冲突记账（等重试器私信）、成功清账、没配上游不同步
        const stubbed = (result) => syncBeforeTask({ profile, deps: { ...deps, syncBaseFromUpstream: () => result } })
        stubbed({ ok: false, conflicts: ['u.txt'], reason: '合进 feature/base 有冲突：u.txt', upstreamSha: 'sha3' })
        assert.deepEqual(loadMergeBackState('falive', deps).syncConflict, { upstreamSha: 'sha3', reason: '合进 feature/base 有冲突：u.txt', notified: false })
        stubbed({ ok: false, pending: true, reason: '主目录暂存区有内容（你正在提交）' })
        assert.equal(loadMergeBackState('falive', deps).syncConflict.upstreamSha, 'sha3', '暂不能合不算冲突、不清账')
        stubbed({ ok: true, merged: true })
        assert.equal(loadMergeBackState('falive', deps).syncConflict, null)
        assert.deepEqual(syncBeforeTask({ profile: { ...profile, mergeBack: {} }, deps }), { ok: true, skipped: true })
        // 定时入口：一轮的几行聚合成一条私信；没配 mergeBack 的仓不碰
        commitOn('lark/falive-r3', 'r3.txt', 'r3\n'); commitOn('lark/falive-r4', 'r4.txt', 'r4\n')
        queuePendingMerge('falive', { taskId: 'r3', branch: 'lark/falive-r3', summary: '改 r3' }, deps)
        queuePendingMerge('falive', { taskId: 'r4', branch: 'lark/falive-r4', summary: '改 r4' }, deps)
        commitOn('lark/falive-r5', 'r5.txt', 'r5\n')
        queuePendingMerge('other', { taskId: 'r5', branch: 'lark/falive-r5', summary: '改 r5' }, deps)
        const sent = []
        await createMergeBackRetrier({ profiles: [profile, { ...profile, key: 'other', mergeBack: null }], notify: async (text) => sent.push(text), log: { log() {}, warn() {} }, deps })()
        assert.equal(sent.length, 1); assert.match(sent[0], /^\*\*Falive Web · 合回 feature\/base\*\*\n✅ 已合进 feature\/base：改 r3\n✅ 已合进 feature\/base：改 r4$/)
        assert.equal(exists('lark/falive-r5'), true, '没配 mergeBack 的仓不碰')
      } finally {
        cleanup(); rmSync(runtimeDir, { recursive: true, force: true })
      }
    }],
    ['合并提交信息以「Merge branch」开头（falive-react verify-commit-msg 只放行 <type>: … 或 Merge / Revert 开头）', async () => {
      const { mergeBackMessage } = await import('../lib/lark-worker-git.mjs')
      for (const message of [mergeBackMessage({ branch: 'origin/pre', into: 'feature/phase-5-test' }), mergeBackMessage({ branch: 'lark/falive-cb475c79', into: 'feature/phase-5-test', summary: 'aven 交办：新闻详情页按新稿改版' })]) {
        assert.match(message, /^(Merge |Revert |fixup!|squash!)/, message)
      }
    }],
  ]))
})
