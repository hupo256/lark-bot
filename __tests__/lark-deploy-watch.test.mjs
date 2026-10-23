import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { checkDeployAndRetest, deployedCommits, findDeployPromises, findPromiseSentence } from '../lib/lark-deploy-watch.mjs'
import { loadSweepState, saveSweepState } from '../lib/lark-daily-sweep.mjs'
import { createTaskStore } from '../lib/lark-task-store.mjs'
import { registerRepoProfiles, repoProfile, resetRepoProfiles } from '../lib/lark-repo-profile.mjs'

const GROUP = 'oc_falive'
const ENCONE = 'ou_encone'
// 10-23 10:28 真机原话（发件簿 runtime/lark-outbox/oc_c2a6….jsonl）
const PROMISE_1023 = '<at id=ou_encone></at> 查到了：pre 上的 web 还是旧版本，开播提交时把 tag_ids 也算进了签名，后端验签不过（407），所以弹「请求失败」，跟 lang / intro 无关。修复已经在开发分支上，合进 pre 部署后就好，部署完我再测一遍告诉你。'

const register = () => registerRepoProfiles({
  repos: {
    falive: {
      root: '/tmp/falive-react', baseRef: 'feature/phase-4-api', chatIds: [GROUP], notifyChatId: 'oc_console',
      ownership: { me: 'aven', meOpenIds: ['ou_aven'] }, ownerMap: { aven: 'ou_aven', Encone: ENCONE }, chatLabels: { [GROUP]: 'Falive PHP后端群' },
      dailyReport: { at: '19:00', sweep: { preSiteUrl: 'https://pre.example.com/', timeoutMinutes: 90 } },
    },
  },
})

const fakeGit = ({ heads = {}, ancestor = true, log = 'abc1234 fix: x\n' } = {}) => {
  const calls = []
  const git = async (_cwd, args) => {
    const cmd = args.join(' ')
    calls.push(cmd)
    if (cmd.startsWith('rev-list')) {
      const before = Date.parse(cmd.match(/--before=(\S+)/)[1])
      const hit = Object.entries(heads).sort((a, b) => b[0] - a[0]).find(([at]) => Number(at) <= before)
      return { ok: true, stdout: hit ? `${hit[1]}\n` : '', stderr: '' }
    }
    if (cmd.startsWith('merge-base')) return { ok: ancestor, stdout: '', stderr: '' }
    if (cmd.startsWith('log')) return { ok: true, stdout: log, stderr: '' }
    return { ok: true, stdout: '', stderr: '' }
  }
  return { git, calls }
}

describe('等部署的原话', () => {
  // 用例表（测试棘轮：一类判据一条 it）：[原话, 期望]——期望为字符串 = 认出的那句，true = 认得出，null = 不算承诺。
  it('只认 bot 自己答应的「部署完再测 / 告诉你」；做完的汇报、状态汇报、让对方做的都不算', () => {
    const cases = [
      [PROMISE_1023, '修复已经在开发分支上，合进 pre 部署后就好，部署完我再测一遍告诉你'],
      ['前端已修好，发布后我复测一下再回你', true],
      ['等 pre 更新后我再看一眼', true],
      ['<at id=ou_encone></at> pre 部署后复测了：web 开播提交已经正常，不再「请求失败」，修改场次时介绍、语言、标签都能写进去。', null], // 10-23 发给 Encone 的复测结论
      ['部署后再测过了，没问题', null],
      ['其中 18 项在 pre 上还看不到效果：#1 Go 资料改动待部署；#12 部署版还没复测', null], // 10-20 状态汇报
      ['前端已经修好，等 pre 更新后你再点一次开播就行，后端不用改。', null],
      ['- ⚠️ 接了但还不能用 开播记录列表：接口在 pre 实测正常；页面还没部署', null],
      ['部署后你再看看', null],
      ['收到，我对比下参数，查完回你', null],
    ]
    for (const [text, expected] of cases) {
      const hit = findPromiseSentence(text)
      if (expected === true) assert.ok(hit, text)
      else assert.equal(hit, expected, text)
    }
  })
  it('发件簿：只取窗口内真发到群里的（gated 没发出去不算），同一源任务只留一句', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lark-deploy-outbox-'))
    try {
      mkdirSync(dir, { recursive: true })
      const line = (at, taskId, text, extra = {}) => appendFileSync(join(dir, `${GROUP}.jsonl`), `${JSON.stringify({ at, chatId: GROUP, taskId, phase: 'done', to: ENCONE, text, ...extra })}\n`)
      line('2026-10-23T06:28:36.870Z', 'om_a', PROMISE_1023)
      line('2026-10-23T06:30:00.000Z', 'om_b', '部署完我再测一遍告诉你', { gated: '只私聊不发群' })
      line('2026-10-23T02:00:00.000Z', 'om_c', '部署完我再测一遍告诉你')
      const out = findDeployPromises({ chatIds: [GROUP], sinceMs: Date.parse('2026-10-23T05:00:00Z'), untilMs: Date.parse('2026-10-23T10:37:00Z'), dir })
      assert.deepEqual(out.map((item) => [item.taskId, item.to]), [['om_a', ENCONE]])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('部署带进去的提交', () => {
  it('提交范围：上次部署点是祖先 → 从它算到构建时 pre 的头；构建机时钟早一点仍取到触发的合并；部署点拿不到 → 退回上次构建那一刻的 pre 头', async () => {
    {
      const { git, calls } = fakeGit({ heads: { [Date.parse('2026-10-23T09:00:00Z')]: 'h2' } })
      const out = await deployedCommits({ root: '/r', prevHead: 'h1', prevBuildTime: 1, buildTime: Date.parse('2026-10-23T10:37:00Z'), git })
      assert.equal(out.head, 'h2')
      assert.deepEqual(out.commits, ['abc1234 fix: x'])
      assert.equal(calls[0], 'fetch origin pre')
      assert.ok(calls.includes('log --no-merges --format=%h %s h1..h2'))
    }
    { // 10-23：构建 10:37:04Z、合并提交 10:37:05Z
      const buildTime = Date.parse('2026-10-23T10:37:04.293Z')
      const { git } = fakeGit({ heads: { [Date.parse('2026-10-23T10:00:00Z')]: 'h1', [Date.parse('2026-10-23T10:37:05Z')]: '4bcbea9' } })
      assert.equal((await deployedCommits({ root: '/r', prevHead: 'h1', buildTime, git })).head, '4bcbea9')
    }
    {
      const t1 = Date.parse('2026-10-22T10:00:00Z')
      const { git, calls } = fakeGit({ ancestor: false, heads: { [t1 - 1000]: 'h0', [Date.parse('2026-10-23T09:00:00Z')]: 'h2' } })
      const out = await deployedCommits({ root: '/r', prevHead: 'gone', prevBuildTime: t1, buildTime: Date.parse('2026-10-23T10:37:00Z'), git })
      assert.equal(out.from, 'h0')
      assert.ok(calls.includes('log --no-merges --format=%h %s h0..h2'))
    }
  })
})

describe('盯所有部署', () => {
  let runtimeDir
  let outboxDir
  let store
  beforeEach(() => {
    register()
    runtimeDir = mkdtempSync(join(tmpdir(), 'lark-deploy-watch-'))
    outboxDir = join(runtimeDir, 'outbox')
    mkdirSync(outboxDir, { recursive: true })
    store = createTaskStore({ tasksDir: join(runtimeDir, 'tasks'), leaseMs: 1000 })
  })
  afterEach(() => {
    resetRepoProfiles()
    rmSync(runtimeDir, { recursive: true, force: true })
  })
  const check = ({ buildTime, now, git = fakeGit({ heads: { 0: 'h1', [buildTime - 1]: 'h2' } }).git }) =>
    checkDeployAndRetest({ store, profile: repoProfile('falive'), now: new Date(now), deps: { runtimeDir, outboxDir, git, probePreBuildTime: async () => buildTime } })

  it('今天的形状：state 只有旧 lastPush、发件簿有 10:28 的承诺 → 合入后首次只记基线，14:37 这次不补建；之后的部署也不再捡这句', async () => {
    saveSweepState('falive', { lastPush: { head: 'e3374a43', pushedAt: '2026-10-19T17:29:37.487Z', commits: [], deployedAt: null, retestTaskId: null } }, { runtimeDir })
    appendFileSync(join(outboxDir, `${GROUP}.jsonl`), `${JSON.stringify({ at: '2026-10-23T06:28:36.870Z', chatId: GROUP, taskId: 'om_x100b628755fb14a4ed5b0e078f6c6cc', phase: 'done', to: ENCONE, text: PROMISE_1023 })}\n`)
    const deployed1437 = Date.parse('2026-10-23T10:37:00Z')
    const first = await check({ buildTime: deployed1437, now: '2026-10-23T12:00:00Z' })
    assert.equal(first.baseline, true)
    assert.equal(store.list().length, 0)
    const state = loadSweepState('falive', { runtimeDir })
    assert.equal(state.lastPush, undefined, '旧 lastPush 记录清掉')
    assert.equal(state.lastDeploy.buildTime, deployed1437)
    const next = await check({ buildTime: Date.parse('2026-10-24T08:00:00Z'), now: '2026-10-24T08:10:00Z' })
    assert.equal(next.deployed, true)
    assert.deepEqual(next.promiseTaskIds, [])
  })

  it('构建时间变新 = 一次部署（不管谁发的）：按提交建整体复测只私信负责人；承诺各建一条挂原群；同一构建只建一次', async () => {
    saveSweepState('falive', { lastDeploy: { buildTime: Date.parse('2026-10-23T02:00:00Z'), head: 'h1' } }, { runtimeDir })
    appendFileSync(join(outboxDir, `${GROUP}.jsonl`), `${JSON.stringify({ at: '2026-10-23T06:28:36.870Z', chatId: GROUP, taskId: 'om_src', phase: 'done', to: ENCONE, text: PROMISE_1023 })}\n`)
    const buildTime = Date.parse('2026-10-23T10:37:00Z')
    const out = await check({ buildTime, now: '2026-10-23T10:45:00Z' })
    const whole = store.get(out.taskId)
    assert.equal(whole.chatId, 'oc_console')
    assert.match(whole.text, /abc1234 fix: x/)
    assert.match(whole.text, /只复测 aven 负责的功能，别人的只记录/)
    assert.match(whole.text, /已各建复测任务、结论回原群/)
    const promise = store.get(out.promiseTaskIds[0])
    assert.deepEqual([promise.chatId, promise.operator, promise.ackedInGroup, promise.contract.deliverable, promise.source], [GROUP, ENCONE, true, 'verification', 'daily-sweep'])
    assert.match(promise.text, /对 Encone 说过[\s\S]*源任务 om_src）：「[^」]*部署完我再测一遍告诉你」/)
    assert.equal((await check({ buildTime, now: '2026-10-23T10:55:00Z' })).deployed, false)
    assert.equal(store.list().length, 2)
  })

  it('没有新提交（同一份代码重新构建）：不建整体复测，只记部署点', async () => {
    saveSweepState('falive', { lastDeploy: { buildTime: 1000, head: 'h2' } }, { runtimeDir })
    const out = await check({ buildTime: 5000, now: 6000, git: fakeGit({ heads: { 0: 'h2' } }).git })
    assert.deepEqual([out.deployed, out.taskId, out.promiseTaskIds], [true, null, []])
    assert.equal(loadSweepState('falive', { runtimeDir }).lastDeploy.buildTime, 5000)
  })
})
