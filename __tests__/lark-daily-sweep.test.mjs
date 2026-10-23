import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import {
  buildSweepTask,
  enqueueDailySweep,
  extractOwnerTodos,
  handlePushPre,
  loadSweepState,
  parsePushPreDirective,
  pendingSweepBranches,
  pushToPre,
  saveSweepState,
  sweepPushHint,
} from '../lib/lark-daily-sweep.mjs'
import { buildRepoNote } from '../lib/lark-repo-delivery.mjs'
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
      baseRef: 'feature/phase-3-api',
      integrationBranch: 'lark/falive-integration',
      chatIds: ['oc_falive'],
      notifyChatId: 'ou_aven',
      ownership: { me: 'aven', meOpenIds: ['ou_aven'] },
      dailyReport: { at: '19:00', sweep: { preSiteUrl: 'https://pre.example.com/', timeoutMinutes: 90 }, ...extra },
    },
  },
})

describe('日报清扫：抽负责人待办', () => {
  afterEach(() => resetRepoProfiles())

  it('第三节只取负责人列含 aven 的行（含共同负责、「aven 跟进」、第二张表），第一节取计数行', () => {
    const todos = extractOwnerTodos({ markdown: REPORT, me: 'aven' })
    assert.deepEqual(todos.followUps.map((item) => item.title), ['发邮件部署 pre', '关注接口改按扁平结构解析', 'live 后端 pre 数据与配置', '设计走查'])
    assert.equal(todos.followUps[1].owners, 'aven / henry')
    assert.match(todos.followUps[2].detail, /推荐主播（LN1）\\\| 标签/)
    assert.equal(todos.unfinished, 'aven 9 项：#2 #4（预约卡在 A5-2）')
  })

  it('二节表格不算待办；没有第三节 → 空', () => {
    const todos = extractOwnerTodos({ markdown: '## 二、API\n| 功能 | 负责人 |\n|---|---|\n| #4 | aven |\n', me: 'aven' })
    assert.deepEqual(todos, { followUps: [], unfinished: null })
  })

  it('清扫任务：私信负责人、docs 类型、自带超时 / 租约 / 强度，id 每天唯一', () => {
    register()
    const task = buildSweepTask({ profile: repoProfile('falive'), date: '2026-10-14', text: 'x', count: 5, now: new Date('2026-10-14T15:20:00Z') })
    assert.equal(task.id, 'sweep-falive-20261014')
    assert.equal(task.source, 'daily-sweep')
    assert.equal(task.chatId, 'ou_aven')
    assert.equal(task.commandType, 'docs')
    assert.equal(task.aiTimeoutMs, 90 * 60_000)
    assert.equal(task.leaseMs, 120 * 60_000)
    assert.equal(task.aiEffort, 'high')
    assert.equal(task.status, 'queued')
  })

  it('enqueueDailySweep：读完整版日报建任务，同一天幂等；没开 sweep 跳过', () => {
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
      const task = store.get(first.taskId)
      assert.match(task.text, /1\. 发邮件部署 pre（负责人：aven）/)
      assert.match(task.text, /5\. aven 名下未完成功能/)
      assert.match(task.text, /日报云文档：https:\/\/lark\/doc/)
      assert.equal(enqueueDailySweep({ store, profile: repoProfile('falive'), outcome }).skipped, '今天已建过')
      resetRepoProfiles()
      register({ sweep: { enabled: false } })
      assert.equal(enqueueDailySweep({ store, profile: repoProfile('falive'), outcome }).ok, false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('任务自带租约：默认租约过期也不当孤儿回收', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lark-sweep-lease-'))
    try {
      const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
      const claimedAt = new Date(Date.now() - 5000).toISOString()
      store.upsert({ id: 'sweep-x', status: 'running', claimedAt, leaseMs: 60_000, epoch: 0, createdAt: claimedAt })
      store.upsert({ id: 'plain-x', status: 'running', claimedAt, epoch: 0, createdAt: claimedAt })
      store.reclaimOrphans()
      assert.equal(store.get('sweep-x').status, 'running')
      assert.notEqual(store.get('plain-x').status, 'running')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('日报清扫：结果私信', () => {
  afterEach(() => resetRepoProfiles())

  it('清单不截成 6 行；有改动且已合进集成分支才提示回「推 pre」', () => {
    register()
    const body = ['2026-10-14 日报 aven 待办 9 条：清掉 6 条，剩 3 条。', '清掉：A、B、C、D、E、F', '- G：等 Encone', '- H：等运维', '- I：你要做：发邮件', '- J：没做完：时间不够', '- K：等产品'].join('\n')
    const task = { id: 'sweep-falive-20261014', source: 'daily-sweep', repo: 'falive', chatId: 'ou_aven', changedFiles: ['a.md'], branch: 'lark/falive-20261014', integration: { mergedBack: true, branch: 'lark/falive-integration' } }
    const note = buildRepoNote({ task, status: 'done', profile: repoProfile('falive'), result: body })
    assert.match(note, /- K：等产品/)
    assert.match(note, /回「推 pre」/)
    assert.doesNotMatch(note, /你合这一条分支就够/)
    assert.equal(sweepPushHint({ ...task, changedFiles: [] }), null)
  })

  it('没合回集成分支：提示推 pre 会带上这条分支，不再叫负责人手动合', () => {
    register()
    const task = { id: 'sweep-falive-20261014', source: 'daily-sweep', repo: 'falive', chatId: 'ou_aven', changedFiles: ['a.md'], branch: 'lark/falive-20261014', integration: { mergedBack: false, branch: 'lark/falive-integration', mergeReason: '冲突' } }
    const note = buildRepoNote({ task, status: 'done', profile: repoProfile('falive'), result: '2026-10-14 日报 aven 待办 1 条：清掉 1 条，剩 0 条。' })
    assert.match(note, /改动在分支 lark\/falive-20261014（没合进集成分支）。回「推 pre」我会把它一起合进 pre/)
    assert.doesNotMatch(note, /要你手动合/)
  })
})

describe('推 pre', () => {
  afterEach(() => resetRepoProfiles())

  it('只认整句「推 pre」', () => {
    assert.equal(parsePushPreDirective('推 pre'), true)
    assert.equal(parsePushPreDirective(' 推PRE '), true)
    assert.equal(parsePushPreDirective('先别推 pre'), false)
    assert.equal(parsePushPreDirective('推 pre 吗'), false)
  })

  const fakeGit = ({ conflictOn = null, headAfter = 'h2' } = {}) => {
    const calls = []
    const git = async (cwd, args) => {
      calls.push(args.join(' '))
      const cmd = args.join(' ')
      if (cmd === 'rev-parse origin/pre') return { ok: true, stdout: 'h1\n', stderr: '' }
      if (cmd === 'rev-parse HEAD') return { ok: true, stdout: `${headAfter}\n`, stderr: '' }
      if (cmd.startsWith('merge --no-ff') && conflictOn && cmd.endsWith(conflictOn)) return { ok: false, stdout: '', stderr: 'CONFLICT' }
      if (cmd.startsWith('diff --name-only')) return { ok: true, stdout: 'docs/a.md\n', stderr: '' }
      if (cmd.startsWith('log --no-merges')) return { ok: true, stdout: 'abc1234 fix: x\ndef5678 docs: y\n', stderr: '' }
      return { ok: true, stdout: '', stderr: '' }
    }
    return { git, calls }
  }

  it('先合 baseRef 再合集成分支，推 HEAD:pre，最后回收临时 worktree', async () => {
    register()
    const { git, calls } = fakeGit()
    const out = await pushToPre({ profile: repoProfile('falive'), git, now: new Date('2026-10-14T16:00:00Z') })
    assert.equal(out.ok, true)
    assert.deepEqual(out.commits, ['abc1234 fix: x', 'def5678 docs: y'])
    const merges = calls.filter((cmd) => cmd.startsWith('merge --no-ff'))
    assert.match(merges[0], /feature\/phase-3-api$/)
    assert.match(merges[1], /lark\/falive-integration$/)
    assert.ok(calls.includes('push origin HEAD:pre'))
    assert.match(calls.at(-1), /^worktree remove --force/)
  })

  it('没合回集成分支的清扫分支：近 48 小时、有改动才带上，并排在 baseRef / 集成分支之后合', async () => {
    register()
    const now = new Date('2026-10-14T20:00:00Z')
    const store = { list: () => [
      { source: 'daily-sweep', repo: 'falive', branch: 'lark/falive-20261014', changedFiles: ['a.md'], integration: { mergedBack: false }, updatedAt: '2026-10-14T19:00:00Z' },
      { source: 'daily-sweep', repo: 'falive', branch: 'lark/falive-20261010', changedFiles: ['a.md'], integration: { mergedBack: false }, updatedAt: '2026-10-10T19:00:00Z' },
      { source: 'daily-sweep', repo: 'falive', branch: 'lark/falive-merged', changedFiles: ['a.md'], integration: { mergedBack: true }, updatedAt: '2026-10-14T19:00:00Z' },
      { source: 'lark', repo: 'falive', branch: 'lark/falive-other', changedFiles: ['a.md'], updatedAt: '2026-10-14T19:00:00Z' },
    ] }
    const extraRefs = pendingSweepBranches({ store, profile: repoProfile('falive'), now })
    assert.deepEqual(extraRefs, ['lark/falive-20261014'])
    const { git, calls } = fakeGit()
    await pushToPre({ profile: repoProfile('falive'), extraRefs, git })
    assert.match(calls.filter((cmd) => cmd.startsWith('merge --no-ff')).at(-1), /lark\/falive-20261014$/)
  })

  it('logFrom（上次部署点）是新头的祖先 → 提交从它算起；不是祖先 → 退回本次推送起点', async () => {
    register()
    const { git, calls } = fakeGit()
    await pushToPre({ profile: repoProfile('falive'), logFrom: 'dep1', git })
    assert.ok(calls.includes('log --no-merges --format=%h %s dep1..h2'), calls.join('\n'))
    const notAncestor = async (cwd, args) => (args[0] === 'merge-base' ? { ok: false, stdout: '', stderr: '' } : git(cwd, args))
    calls.length = 0
    await pushToPre({ profile: repoProfile('falive'), logFrom: 'stale', git: notAncestor })
    assert.ok(calls.includes('log --no-merges --format=%h %s h1..h2'), calls.join('\n'))
  })

  it('冲突 → abort、不推送，告诉负责人冲突文件', async () => {
    register()
    const { git, calls } = fakeGit({ conflictOn: 'lark/falive-integration' })
    const out = await pushToPre({ profile: repoProfile('falive'), git })
    assert.equal(out.ok, false)
    assert.match(out.reason, /有冲突，没推：docs\/a\.md/)
    assert.ok(calls.includes('merge --abort'))
    assert.ok(!calls.some((cmd) => cmd.startsWith('push')))
  })

  it('没有新提交 → 不推送', async () => {
    register()
    const { git, calls } = fakeGit({ headAfter: 'h1' })
    const out = await pushToPre({ profile: repoProfile('falive'), git })
    assert.equal(out.nothingNew, true)
    assert.ok(!calls.some((cmd) => cmd.startsWith('push')))
  })

  it('推完回部署邮件正文；待部署提交从盯部署记下的上次部署点算起（#82：不再记 lastPush）', async () => {
    register()
    const runtimeDir = mkdtempSync(join(tmpdir(), 'lark-sweep-state-'))
    try {
      saveSweepState('falive', { lastDeploy: { buildTime: 1, head: 'deployed1' } }, { runtimeDir })
      let seen = null
      const reply = await handlePushPre({ deps: { runtimeDir, pushToPre: async ({ logFrom }) => { seen = logFrom; return { ok: true, head: 'abcdef1234', base: 'h1', commits: ['abc1234 fix: 关注接口扁平', 'bbb2222 docs: 回填'], pushedAt: '2026-10-14T16:00:00.000Z' } } } })
      assert.equal(seen, 'deployed1')
      assert.match(reply, /已推 pre（abcdef12，待部署 2 个提交）/)
      assert.match(reply, /主题：falive pre 前端部署申请/)
      assert.match(reply, /- fix: 关注接口扁平/)
      assert.equal(loadSweepState('falive', { runtimeDir }).lastPush, undefined, '不再记 lastPush')
    } finally {
      rmSync(runtimeDir, { recursive: true, force: true })
    }
  })
})
