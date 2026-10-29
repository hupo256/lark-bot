import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { runSteps } from './support/steps.mjs'

import {
  buildSweepTask,
  enqueueDailySweep,
  extractOwnerTodos,
  handlePushPre,
  loadSweepState,
  parsePushPreDirective,
  pushBaseForMr,
  saveSweepState,
  sweepProfiles,
  sweepPushHint,
} from '../lib/lark-daily-sweep.mjs'
import { buildRepoNote } from '../lib/lark-repo-delivery.mjs'
import { isDocsOnlyConflict, loadMergeBackState, queuePendingMerge, recordConflict } from '../lib/lark-merge-back-state.mjs'
import { handleResolveMerge, parseResolveMergeDirective } from '../lib/lark-merge-resolve.mjs'
import { createTaskStore } from '../lib/lark-task-store.mjs'
import { registerRepoProfiles, repoProfile, resetRepoProfiles } from '../lib/lark-repo-profile.mjs'

const REPORT = `# Falive Web 一期 · 日报（2026-10-14）

## 总体进度：78.6%

## 一、功能进度总览（55 项）

| # | 功能 | 负责人 | 状态 |
|---|---|---|---|
| 2 | 账号 | aven | ⬜ |

**计数**（不含 #54）：✅ 20 项。未完成 9 项：
- **aven** 9 项：#2 #4（预约卡在 A5-2）
- henry 8 项：#1 #32

## 二、API

| 功能 | 缺什么 |
|---|---|
| #4 | reserveMatch（aven） |

## 三、需要再跟进的工作

| 事项 | 说明 | 负责人 |
|---|---|---|
| 发邮件部署 pre | 今天合入 pre 的改动都还没部署 | **aven** |
| 关注接口改按扁平结构解析 | LN10：首页主播卡由 aven 改；个人主页由 henry 改 | **aven** / **henry** |
| pre 登录态回归 | WS 公屏收发 | **henry**（H-1） |
| live 后端 pre 数据与配置 | 推荐主播（LN1）\\| 标签 | live 后端，**aven** 跟进 |

| 事项 | 说明 | 负责人 |
|---|---|---|
| 设计走查 | 搜索页 | 设计 / **aven** 改 |
`

const register = (extra = {}) => registerRepoProfiles({
  repos: {
    falive: {
      root: '/tmp/falive-react',
      baseRef: 'feature/phase-5-test',
      mergeBack: { upstream: 'origin/pre' },
      chatIds: ['oc_falive'],
      notifyChatId: 'ou_aven',
      ownership: { me: 'aven', meOpenIds: ['ou_aven'] },
      dailyReport: { at: '19:00', sweep: { preSiteUrl: 'https://pre.example.com/', timeoutMinutes: 90 }, ...extra },
    },
  },
})

// 每段（= 合并前的一个原 it）结束都清掉注册的仓配置，等价原来各 describe 的 afterEach
const hooks = { after: () => resetRepoProfiles() }

describe('日报清扫：抽负责人待办', () => {
  it('extractOwnerTodos：第三节按负责人取行、第一节取计数行；二节表格不算、没有第三节为空', () => runSteps([
    ['第三节只取负责人列含 aven 的行（含共同负责、「aven 跟进」、第二张表），第一节取计数行', () => {
      const todos = extractOwnerTodos({ markdown: REPORT, me: 'aven' })
      assert.deepEqual(todos.followUps.map((item) => item.title), ['发邮件部署 pre', '关注接口改按扁平结构解析', 'live 后端 pre 数据与配置', '设计走查'], '第三节只取负责人列含 aven 的行（含共同负责、「aven 跟进」、第二张表）')
      assert.equal(todos.followUps[1].owners, 'aven / henry')
      assert.match(todos.followUps[2].detail, /推荐主播（LN1）\\\| 标签/)
      assert.equal(todos.unfinished, 'aven 9 项：#2 #4（预约卡在 A5-2）', '第一节取计数行')
    }],
    ['二节表格不算待办；没有第三节 → 空', () => {
      const empty = extractOwnerTodos({ markdown: '## 二、API\n| 功能 | 负责人 |\n|---|---|\n| #4 | aven |\n', me: 'aven' })
      assert.deepEqual(empty, { followUps: [], unfinished: null }, '二节表格不算待办；没有第三节 → 空')
    }],
  ], hooks))

  it('清扫任务构造、按完整版日报建任务（同一天幂等 / 没开 sweep 跳过）、自带租约不被当孤儿回收', () => runSteps([
    ['清扫任务：私信负责人、docs 类型、自带超时 / 租约 / 强度，id 每天唯一', () => {
      register()
      const task = buildSweepTask({ profile: repoProfile('falive'), date: '2026-10-14', text: 'x', count: 5, now: new Date('2026-10-14T15:20:00Z') })
      assert.equal(task.id, 'sweep-falive-20261014', 'id 每天唯一')
      assert.equal(task.source, 'daily-sweep')
      assert.equal(task.chatId, 'ou_aven', '私信负责人')
      assert.equal(task.commandType, 'docs')
      assert.equal(task.aiTimeoutMs, 90 * 60_000)
      assert.equal(task.leaseMs, 120 * 60_000)
      assert.equal(task.aiEffort, 'high')
      assert.equal(task.status, 'queued')
    }],
    ['enqueueDailySweep：读完整版日报建任务，同一天幂等；没开 sweep 跳过', () => {
      register()
      const dir = mkdtempSync(join(tmpdir(), 'lark-sweep-'))
      try {
        const docPath = join(dir, 'FaliveWeb日报-2026-10-14-完整版.md')
        writeFileSync(docPath, REPORT)
        const store = createTaskStore({ tasksDir: join(dir, 'tasks'), leaseMs: 1000 })
        const outcome = { ok: true, date: '2026-10-14', doc: { path: docPath, url: 'https://lark/doc' } }
        const first = enqueueDailySweep({ store, profile: repoProfile('falive'), outcome })
        assert.equal(first.taskId, 'sweep-falive-20261014')
        assert.equal(first.count, 5)
        const queued = store.get(first.taskId)
        assert.match(queued.text, /1\. 发邮件部署 pre（负责人：aven）/)
        assert.match(queued.text, /5\. aven 名下未完成功能/)
        assert.match(queued.text, /日报云文档：https:\/\/lark\/doc/)
        assert.equal(enqueueDailySweep({ store, profile: repoProfile('falive'), outcome }).skipped, '今天已建过', '同一天幂等')
        resetRepoProfiles()
        register({ sweep: { enabled: false } })
        assert.equal(enqueueDailySweep({ store, profile: repoProfile('falive'), outcome }).ok, false, '没开 sweep 跳过')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }],
    ['任务自带租约：默认租约过期也不当孤儿回收', () => {
      const leaseDir = mkdtempSync(join(tmpdir(), 'lark-sweep-lease-'))
      try {
        const store = createTaskStore({ tasksDir: leaseDir, leaseMs: 1000 })
        const claimedAt = new Date(Date.now() - 5000).toISOString()
        store.upsert({ id: 'sweep-x', status: 'running', claimedAt, leaseMs: 60_000, epoch: 0, createdAt: claimedAt })
        store.upsert({ id: 'plain-x', status: 'running', claimedAt, epoch: 0, createdAt: claimedAt })
        store.reclaimOrphans()
        assert.equal(store.get('sweep-x').status, 'running', '任务自带租约：默认租约过期也不当孤儿回收')
        assert.notEqual(store.get('plain-x').status, 'running')
      } finally {
        rmSync(leaseDir, { recursive: true, force: true })
      }
    }],
  ], hooks))
})

describe('日报清扫：结果私信', () => {
  it('清单不截成 6 行、合进工作分支才提示「推 pre」；还没合进提示合上后再推', () => runSteps([
    ['清单不截成 6 行；有改动且已合进工作分支才提示回「推 pre」（推工作分支、发 pre 的 MR）', () => {
      register()
      const body = ['2026-10-14 日报 aven 待办 9 条：清掉 6 条，剩 3 条。', '清掉：A、B、C、D、E、F', '- G：等 Encone', '- H：等运维', '- I：你要做：发邮件', '- J：没做完：时间不够', '- K：等产品'].join('\n')
      const task = { id: 'sweep-falive-20261014', source: 'daily-sweep', repo: 'falive', chatId: 'ou_aven', changedFiles: ['a.md'], branch: 'feature/phase-5-test', integration: { mergedBack: true, branch: 'feature/phase-5-test' } }
      const note = buildRepoNote({ task, status: 'done', profile: repoProfile('falive'), result: body })
      assert.match(note, /- K：等产品/, '清单不截成 6 行')
      assert.match(note, /改动已合进 feature\/phase-5-test。回「推 pre」我就推 feature\/phase-5-test 并发 pre 的 MR/)
      assert.equal(sweepPushHint({ ...task, changedFiles: [] }), null)
    }],
    ['还没合进工作分支（排队 / 冲突）：提示合上后再推，不说推 pre 会带上它', () => {
      register()
      const unmerged = { id: 'sweep-falive-20261014', source: 'daily-sweep', repo: 'falive', chatId: 'ou_aven', changedFiles: ['a.md'], branch: 'lark/falive-20261014', integration: { mergedBack: null, pending: true, branch: 'feature/phase-5-test', mergeReason: '主目录暂存区有内容（你正在提交）' } }
      const unmergedNote = buildRepoNote({ task: unmerged, status: 'done', profile: repoProfile('falive'), result: '2026-10-14 日报 aven 待办 1 条：清掉 1 条，剩 0 条。' })
      assert.match(unmergedNote, /改动在分支 lark\/falive-20261014，还没合进你的工作分支（合上了我会私信你）。合上后回「推 pre」/)
      assert.doesNotMatch(unmergedNote, /一起合进 pre/)
    }],
    ['非清扫任务的完成卡：合上 / 排队 / 冲突三种写法', () => {
      register()
      const note = (integration) => buildRepoNote({ task: { id: 't', repo: 'falive', chatId: 'oc_falive', changedFiles: ['a.md'], branch: integration.mergedBack ? 'feature/phase-5-test' : 'lark/falive-t', integration }, status: 'done', profile: repoProfile('falive'), result: '改好了' })
      assert.match(note({ mergedBack: true, branch: 'feature/phase-5-test' }), /已合进 feature\/phase-5-test/)
      assert.match(note({ mergedBack: null, pending: true, branch: 'feature/phase-5-test', mergeReason: '主目录不在 feature/phase-5-test 上（在 x）' }), /改动在分支 lark\/falive-t，等合进 feature\/phase-5-test（主目录不在/)
      assert.match(note({ mergedBack: false, branch: 'feature/phase-5-test', mergeReason: '合进 feature/phase-5-test 有冲突：a.md' }), /⚠ 没合进 feature\/phase-5-test：合进 feature\/phase-5-test 有冲突：a\.md。分支 lark\/falive-t 要你手动合/)
      assert.match(note({ mergedBack: false, resolvable: true, branch: 'feature/phase-5-test', mergeReason: '合进 feature/phase-5-test 有冲突：docs/a.md' }), /。分支 lark\/falive-t 保留，只冲突在文档，回「帮我合」我按意思合/)
    }],
  ], hooks))
})

describe('推 pre', () => {
  const fakeGit = ({ ahead = 'abc1234 fix: x\ndef5678 docs: y\n', pushOk = true, fetchOk = true } = {}) => {
    const calls = []
    const git = async (cwd, args) => {
      calls.push(args.join(' '))
      const cmd = args.join(' ')
      if (cmd === 'fetch origin pre') return { ok: fetchOk, stdout: '', stderr: fetchOk ? '' : 'network down' }
      if (cmd.startsWith('log --no-merges')) return { ok: true, stdout: ahead, stderr: '' }
      if (cmd.startsWith('push')) return pushOk
        ? { ok: true, stdout: '', stderr: 'remote:\nremote: View merge request for feature/phase-5-test:\nremote:   http://mgit.example.com/web/falive-react/-/merge_requests/131\nremote:\n' }
        : { ok: false, stdout: '', stderr: '! [rejected] feature/phase-5-test -> feature/phase-5-test (non-fast-forward)' }
      return { ok: true, stdout: '', stderr: '' }
    }
    return { git, calls }
  }

  it('只认整句「推 pre」；回复带 MR 链接，还排队没合进工作分支的 bot 改动一并说明；「帮我合」建合并任务', () => runSteps([
    ['只认整句「推 pre」', () => {
      assert.equal(parsePushPreDirective('推 pre'), true)
      assert.equal(parsePushPreDirective(' 推PRE '), true)
      assert.equal(parsePushPreDirective('先别推 pre'), false)
      assert.equal(parsePushPreDirective('推 pre 吗'), false)
    }],
    ['推完回 MR 链接与提交数；排队中的 bot 改动写明这次没带上；失败 / 没新提交各有说法', async () => {
      register()
      const runtimeDir = mkdtempSync(join(tmpdir(), 'lark-sweep-state-'))
      try {
        const push = (result) => handlePushPre({ deps: { runtimeDir, pushBaseForMr: async () => result } })
        const ok = await push({ ok: true, commits: ['abc1234 fix: 关注接口扁平', 'bbb2222 docs: 回填'], mrUrl: 'http://mgit/x/-/merge_requests/131' })
        assert.match(ok, /^✅ 已推 feature\/phase-5-test（2 个提交），发往 pre 的 MR：http:\/\/mgit\/x\/-\/merge_requests\/131。/)
        assert.doesNotMatch(ok, /没带上/)
        assert.match(await push({ ok: true, commits: ['a b'], mrUrl: null }), /推送输出里没拿到链接，去 GitLab 看/)
        queuePendingMerge('falive', { taskId: 't1', branch: 'lark/falive-t1', summary: '改 t1' }, { runtimeDir })
        assert.match(await push({ ok: true, commits: ['a b'], mrUrl: 'u' }), /还有 1 个 bot 改动没合进 feature\/phase-5-test，这次没带上：改 t1$/)
        assert.match(await push({ ok: false, reason: '推送 feature/phase-5-test 失败：rejected' }), /^⛔ 没推：推送 feature\/phase-5-test 失败：rejected/)
        assert.match(await push({ ok: true, nothingNew: true }), /^feature\/phase-5-test 没有 pre 之外的提交，不用推。/)
        assert.equal(loadSweepState('falive', { runtimeDir }).lastPush, undefined, '不再记 lastPush')
      } finally {
        rmSync(runtimeDir, { recursive: true, force: true })
      }
    }],
    ['「帮我合」（10-29 #94）：只认整句；只冲突在文档的各建合并任务（带 supersedes、说清怎么取舍），代码冲突留给人；重复回不重复建', () => {
      registerRepoProfiles({ repos: { other: { root: '/tmp/other', baseRef: 'main' } } })
      assert.deepEqual(sweepProfiles(), [], '没开清扫的仓不算')
      register()
      assert.equal(parseResolveMergeDirective(' 帮我合 '), true); assert.equal(parseResolveMergeDirective('帮我合一下吗'), false)
      const dir = mkdtempSync(join(tmpdir(), 'lark-resolve-'))
      const deps = { runtimeDir: dir }
      try {
        const store = createTaskStore({ tasksDir: join(dir, 'tasks'), leaseMs: 1000 })
        assert.match(handleResolveMerge({ store, deps }), /^没有只冲突在文档、等我合的分支。/)
        recordConflict('falive', { taskId: 'd1', branch: 'lark/falive-d1', summary: '复测 d1', files: ['"docs/delivery/pending/对接.md"', 'docs/README.md'], supersedes: ['lark/falive-d0'] }, deps)
        recordConflict('falive', { taskId: 'c1', branch: 'lark/falive-c1', summary: '改 c1', files: ['docs/a.md', 'src/a.ts'] }, deps)
        const reply = handleResolveMerge({ store, deps })
        assert.match(reply, /^好，1 条开始合：复测 d1。合进 feature\/phase-5-test 后私信你取舍。\n\n有代码冲突的还要你手动合：lark\/falive-c1$/)
        const task = store.get('resolve-falive-d1')
        assert.deepEqual([task.source, task.summary, task.supersedes], ['daily-sweep', '合回冲突：复测 d1', ['lark/falive-d1', 'lark/falive-d0']])
        assert.match(task.text, /aven 回了「帮我合」/); assert.equal(isDocsOnlyConflict([]), false, '没有冲突文件不算')
        assert.match(task.text, /以当前文件（HEAD）的结构、编号和口径为准/); assert.match(task.text, /git diff \$\(git merge-base HEAD lark\/falive-d1\) lark\/falive-d1/)
        assert.deepEqual(loadMergeBackState('falive', deps).conflicts.map((item) => item.branch), ['lark/falive-c1'], '只取走文档冲突')
        assert.match(handleResolveMerge({ store, deps }), /^没有只冲突在文档、等我合的分支。\n\n有代码冲突的还要你手动合：lark\/falive-c1$/)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }],
  ], hooks))

  it('pushBaseForMr 正常路径：先 fetch，推工作分支并带 MR push option，从推送输出取 MR 链接', () => runSteps([
    ['推 feature/phase-5-test，push option 建发往 pre 的 MR，不碰 pre 分支本身', async () => {
      register()
      const { git, calls } = fakeGit()
      const out = await pushBaseForMr({ profile: repoProfile('falive'), git })
      assert.deepEqual(out, { ok: true, commits: ['abc1234 fix: x', 'def5678 docs: y'], mrUrl: 'http://mgit.example.com/web/falive-react/-/merge_requests/131' })
      assert.equal(calls[0], 'fetch origin pre')
      assert.ok(calls.includes('log --no-merges --format=%h %s origin/pre..feature/phase-5-test'))
      assert.ok(calls.includes('push -o merge_request.create -o merge_request.target=pre origin feature/phase-5-test'), calls.join('\n'))
      assert.ok(!calls.some((cmd) => /HEAD:pre|worktree|merge /.test(cmd)), '不直接推 pre、不建临时 worktree、不合并')
    }],
  ], hooks))

  it('pushBaseForMr 不推送：fetch 失败、没有 pre 之外的提交；推送被拒报原因', () => runSteps([
    ['fetch 失败 → 不推', async () => {
      register()
      const { git, calls } = fakeGit({ fetchOk: false })
      const out = await pushBaseForMr({ profile: repoProfile('falive'), git })
      assert.equal(out.ok, false); assert.match(out.reason, /fetch origin pre 失败：network down/)
      assert.ok(!calls.some((cmd) => cmd.startsWith('push')))
    }],
    ['没有 pre 之外的提交 → 不推', async () => {
      register()
      const { git, calls } = fakeGit({ ahead: '' })
      assert.deepEqual(await pushBaseForMr({ profile: repoProfile('falive'), git }), { ok: true, nothingNew: true })
      assert.ok(!calls.some((cmd) => cmd.startsWith('push')))
    }],
    ['推送被拒（远端分支分叉）→ ok=false 带 git 原因', async () => {
      register()
      const out = await pushBaseForMr({ profile: repoProfile('falive'), git: fakeGit({ pushOk: false }).git })
      assert.equal(out.ok, false); assert.match(out.reason, /推送 feature\/phase-5-test 失败：! \[rejected\]/)
    }],
  ], hooks))
})
