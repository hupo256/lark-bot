import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { checkDeployAndRetest, deployedCommits, findDeployPromises, findPromiseSentence, probePreBuild, runOnDeploy } from '../lib/lark-deploy-watch.mjs'
import { loadSweepState, saveSweepState } from '../lib/lark-daily-sweep.mjs'
import { createTaskStore } from '../lib/lark-task-store.mjs'
import { registerRepoProfiles, repoProfile, resetRepoProfiles } from '../lib/lark-repo-profile.mjs'
import { runSteps } from './support/steps.mjs'
import { diffSeoFails, parseSeoFails, runSeoCheck, seoRetestNote } from '../lib/lark-seo-watch.mjs'

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

const fakeGit = ({ heads = {}, ancestor = true, log = 'abc1234 fix: x\n', codeLog = log } = {}) => {
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
    if (cmd.startsWith('log')) return { ok: true, stdout: cmd.includes(':(exclude)docs') ? codeLog : log, stderr: '' }
    return { ok: true, stdout: '', stderr: '' }
  }
  return { git, calls }
}

describe('等部署的原话', () => {
  // 用例表（测试棘轮：一类判据一条 it）：[原话, 期望]——期望为字符串 = 认出的那句，true = 认得出，null = 不算承诺。
  it('等部署的原话：只认 bot 自己的承诺，发件簿只取窗口内真发出的、同源只留一句', () => runSteps([
    ['只认 bot 自己答应的「部署完再测 / 告诉你」；做完的汇报、状态汇报、让对方做的都不算', () => {
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
    }],
    ['发件簿：只取窗口内真发到群里的（gated 没发出去不算），同一源任务只留一句', () => {
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
    }],
  ]))
})

describe('部署带进去的提交', () => {
  it('提交范围：上次部署点是祖先 → 从它算到构建时 pre 的头；构建机时钟早一点仍取到触发的合并；部署点拿不到 → 退回上次构建那一刻的 pre 头；包里有提交号就用它', async () => {
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
    { // 10-28：包里写了 VITE_BUILD_SHA → 头就是它，不按时间倒推（构建后 5 分钟内又合的 MR 不会被算进来）
      const { git, calls } = fakeGit({ heads: { [Date.parse('2026-10-28T10:46:00Z')]: 'merged-after-build' } })
      const out = await deployedCommits({ root: '/r', prevHead: 'h1', buildTime: Date.parse('2026-10-28T10:45:41Z'), sha: '83403dac', git })
      assert.equal(out.head, '83403dac')
      assert.ok(calls.includes('cat-file -e 83403dac^{commit}'))
      assert.ok(!calls.some((cmd) => cmd.startsWith('rev-list')))
    }
  })
})

describe('盯所有部署', () => {
  let runtimeDir
  let outboxDir
  let store
  const setup = () => {
    register()
    runtimeDir = mkdtempSync(join(tmpdir(), 'lark-deploy-watch-'))
    outboxDir = join(runtimeDir, 'outbox')
    mkdirSync(outboxDir, { recursive: true })
    store = createTaskStore({ tasksDir: join(runtimeDir, 'tasks'), leaseMs: 1000 })
  }
  const teardown = () => {
    resetRepoProfiles()
    rmSync(runtimeDir, { recursive: true, force: true })
  }
  const hooks = { before: setup, after: teardown }
  const check = ({ buildTime, sha = null, now, git = fakeGit({ heads: { 0: 'h1', [buildTime - 1]: 'h2' } }).git, profile = repoProfile('falive'), runOnDeploy: hook, seo, send }) =>
    checkDeployAndRetest({ store, profile, now: new Date(now), deps: { runtimeDir, outboxDir, git, probePreBuild: async () => ({ buildTime, sha }), ...(hook ? { runOnDeploy: hook } : {}), ...(seo ? { runSeoCheck: async () => seo } : {}), ...(send ? { send } : {}) } })

  it('盯部署：首次只记基线不补建，构建变新按提交建复测与承诺单，无新提交只记部署点', () => runSteps([
    ['今天的形状：state 只有旧 lastPush、发件簿有 10:28 的承诺 → 合入后首次只记基线，14:37 这次不补建；之后的部署也不再捡这句', async () => {
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
    }],
    ['构建时间变新 = 一次部署（不管谁发的）：按提交建整体复测只私信负责人；承诺各建一条挂原群；同一构建只建一次', async () => {
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
    }],
    ['只改 docs/ 的提交（bot 回填文档 / 复测结论）不建整体复测、复测正文只列改了代码的提交；全是文档提交时承诺单照建（10-27）', async () => {
      saveSweepState('falive', { lastDeploy: { buildTime: 1000, head: 'h1' } }, { runtimeDir })
      const mixed = fakeGit({ heads: { 0: 'h1', 4999: 'h2' }, log: 'abc1234 fix: x\nddd0001 feat(bot): 复测结论\n', codeLog: 'abc1234\n' }).git
      const out = await check({ buildTime: 5000, now: 6000, git: mixed })
      assert.match(store.get(out.taskId).text, /abc1234 fix: x/)
      assert.doesNotMatch(store.get(out.taskId).text, /ddd0001/)
      appendFileSync(join(outboxDir, `${GROUP}.jsonl`), `${JSON.stringify({ at: new Date(5500).toISOString(), chatId: GROUP, taskId: 'om_docs', phase: 'done', to: ENCONE, text: PROMISE_1023 })}\n`)
      const docsOnly = fakeGit({ heads: { 0: 'h2', 8999: 'h3' }, log: 'ddd0002 feat(bot): 回填\n', codeLog: '' }).git
      const second = await check({ buildTime: 9000, now: 9500, git: docsOnly })
      assert.equal(second.taskId, null, '全是文档提交 → 不建整体复测')
      assert.equal(second.promiseTaskIds.length, 1, '答应过的复测照建')
    }],
    ['SEO 爬虫检查（10-29 #96）：bot 先跑、和上次比；已知卡点不变不让复测再报，有变化才写；只改文档的部署有变化单独私信；跑挂不更新基准', async () => {
      // 纯函数：取 ❌ 行（去汇总行）；比对时抹掉路径里的样本编号、状态码照比
      assert.deepEqual(parseSeoFails('SEO 检查 x\n❌ /hc：状态码 503\n⚠️ /sitemap.xml：没有文章\n\n❌ 1 项不通过\n'), ['/hc：状态码 503'])
      assert.deepEqual(diffSeoFails({ prev: ['/sitemap.xml：/hc/news/98 访问是 503'], fails: ['/sitemap.xml：/hc/news/16 访问是 503'] }), { added: [], resolved: [] })
      assert.deepEqual(diffSeoFails({ prev: ['/hc：状态码 503'], fails: ['/hc：状态码 500'] }).added, ['/hc：状态码 500'])
      assert.equal(await runSeoCheck({ profile: { root: runtimeDir }, siteUrl: 'https://pre.example.com/' }), null, '业务仓没有检查脚本 → 不跑')
      assert.equal(await runSeoCheck({ profile: {}, siteUrl: 'https://pre.example.com/' }), null, '没配业务仓 → 不跑')
      mkdirSync(join(runtimeDir, 'scripts'), { recursive: true }); writeFileSync(join(runtimeDir, 'scripts', 'seo-check.mjs'), '')
      const run = (out) => runSeoCheck({ profile: { root: runtimeDir }, siteUrl: 'https://pre.example.com/', exec: async (_f, args) => ({ args, ...out }) })
      assert.deepEqual(await run({ ok: false, stdout: '❌ /hc：x\n', stderr: '' }), { fails: ['/hc：x'] }, '有 ❌ 退出码 1 = 检查不通过，不是跑挂')
      assert.deepEqual(await run({ ok: false, stdout: '', stderr: 'boom' }), { error: 'boom' })
      assert.deepEqual(await run({ ok: true, stdout: '✅ 全部通过', stderr: '' }), { fails: [] })
      assert.match(seoRetestNote({ seo: { fails: ['a'] }, prev: ['a', 'b'], siteUrl: 'https://x/' }), /有变化：已消失 b。summary 写一行/, '只有消失也算变化')
      const known = ['/hc：503：SSR 取不到正文', '/hc/news/99：状态码 503']
      const sent = []
      const send = async (msg) => sent.push(msg.markdown)
      const H = 3600_000
      const deployAt = (n) => ({ buildTime: n * H, now: n * H + 60_000, git: fakeGit({ heads: { 0: `h${n - 1}`, [n * H - 1]: `h${n}` } }).git })
      saveSweepState('falive', { lastDeploy: { buildTime: H, head: 'h1' }, lastSeo: { fails: known, buildTime: H } }, { runtimeDir })
      const same = await check({ ...deployAt(2), seo: { fails: ['/hc：503：SSR 取不到正文', '/hc/news/16：状态码 503'] }, send })
      assert.match(store.get(same.taskId).text, /和上次一样的 2 个已知问题，没变化，不用再查、summary 不写/)
      const changed = await check({ ...deployAt(3), seo: { fails: ['/hc/help：个人 / 功能页没有 noindex'] }, send })
      const text = store.get(changed.taskId).text
      assert.match(text, /有变化：新增 \/hc\/help：个人 \/ 功能页没有 noindex；已消失 \/hc：503/)
      assert.match(text, /新增的算一项不通过/)
      assert.deepEqual(loadSweepState('falive', { runtimeDir }).lastSeo.fails, ['/hc/help：个人 / 功能页没有 noindex'], '基准换成这次')
      await check({ ...deployAt(4), seo: { error: 'node 崩了' }, send })
      assert.match(store.list().find((t) => t.text.includes('node 崩了')).text, /bot 没跑成（node 崩了）：在业务仓手动跑 `pnpm quality:seo --base https:\/\/pre.example.com`/)
      assert.deepEqual(loadSweepState('falive', { runtimeDir }).lastSeo.fails, ['/hc/help：个人 / 功能页没有 noindex'], '跑挂不更新基准')
      const docsOnly = (n) => ({ ...deployAt(n), git: fakeGit({ heads: { 0: `h${n - 1}`, [n * H - 1]: `h${n}` }, log: 'ddd0002 feat(bot): 回填\n', codeLog: '' }).git })
      const quiet = await check({ ...docsOnly(5), seo: { fails: [] }, send })
      assert.equal(quiet.taskId, null)
      assert.deepEqual(sent.length, 1); assert.match(sent[0], /SEO 爬虫检查已恢复，全部通过/)
      await check({ ...docsOnly(6), seo: { fails: [] }, send })
      assert.equal(sent.length, 1, '没变化不私信')
    }],
    ['没有新提交（同一份代码重新构建）：不建整体复测，只记部署点', async () => {
      saveSweepState('falive', { lastDeploy: { buildTime: 1000, head: 'h2' } }, { runtimeDir })
      const out = await check({ buildTime: 5000, now: 6000, git: fakeGit({ heads: { 0: 'h2' } }).git })
      assert.deepEqual([out.deployed, out.taskId, out.promiseTaskIds], [true, null, []])
      assert.equal(loadSweepState('falive', { runtimeDir }).lastDeploy.buildTime, 5000)
    }],
    ['配了 onDeploy（bugpoll 改 bug 表）：部署后带 --sha / --build-time 跑一次、输出私信负责人；失败也私信并给补跑命令；首次基线不跑（10-28）', async () => {
      const calls = []
      const sentTo = []
      const exec = async (file, args) => { calls.push([file, ...args].join(' ')); return calls.length === 1 ? { ok: true, stdout: 'pre 已部署：Bug-4987 → 已推版\n', stderr: '' } : { ok: false, stdout: '', stderr: '读 bug 表失败' } }
      const send = async (msg) => { sentTo.push(msg); return { ok: true } }
      const profile = { ...repoProfile('falive'), dailyReport: { sweep: { preSiteUrl: 'https://pre.example.com/', onDeploy: ['python3', '-I', '/b/deployed.py'] } } }
      const hook = (args) => runOnDeploy({ ...args, exec, send })
      assert.equal((await check({ buildTime: 1000, now: 1500, profile, runOnDeploy: hook })).baseline, true)
      assert.deepEqual(calls, [], '首次只记基线，不改表')
      const out = await check({ buildTime: 5000, sha: 'abc1234', now: 6000, profile, runOnDeploy: hook, git: fakeGit({ heads: { 0: 'h1' } }).git })
      assert.deepEqual(calls, ['python3 -I /b/deployed.py --sha abc1234 --build-time 5000'])
      assert.deepEqual([sentTo[0].chatId, sentTo[0].markdown], ['oc_console', 'pre 已部署：Bug-4987 → 已推版'])
      assert.equal(out.onDeploy.ok, true)
      await check({ buildTime: 9000, sha: 'def5678', now: 9500, profile, runOnDeploy: hook, git: fakeGit({ heads: { 0: 'h1' } }).git })
      assert.match(sentTo[1].markdown, /没跑成[\s\S]*读 bug 表失败[\s\S]*python3 -I \/b\/deployed\.py --sha def5678/)
      assert.equal(await runOnDeploy({ profile: repoProfile('falive'), deploy: { head: 'x', buildTime: 1 }, exec }), null, '没配 onDeploy 不跑')
      assert.equal(calls.length, 2)
      await runOnDeploy({ profile, deploy: { head: 'y', buildTime: 2 }, exec: async () => ({ ok: true, stdout: '\n', stderr: '' }), send })
      assert.equal(sentTo.length, 2, '没有待推版要改（输出为空）不打扰')
    }],
    ['探站：首页引用的入口脚本名没变就不再下载入口 JS；变了才重读构建时间和提交号（2 分钟一探，10-28）', async () => {
      const fetched = []
      let entry = 'index-CIHMmVN9'
      const fetchImpl = async (url) => {
        fetched.push(String(url).replace('https://pre.example.com', ''))
        const body = String(url).endsWith('/') ? `<script src="/assets/${entry}.js"></script><link href="/assets/index-a.js">` : String(url).includes(entry) ? `{VITE_BUILD_TIME:${entry === 'index-CIHMmVN9' ? 1793184341589 : 1793191932983},VITE_BUILD_SHA:"83403dac81cd9ab4"}` : 'x'
        return { text: async () => body }
      }
      const cache = new Map()
      const probe = () => probePreBuild({ siteUrl: 'https://pre.example.com/', fetchImpl, cache })
      assert.deepEqual(await probe(), { buildTime: 1793184341589, sha: '83403dac81cd9ab4' })
      fetched.length = 0
      assert.deepEqual(await probe(), { buildTime: 1793184341589, sha: '83403dac81cd9ab4' })
      assert.deepEqual(fetched, ['/'], '同一个包只拉首页')
      entry = 'index-BqqoR1A1'
      assert.equal((await probe()).buildTime, 1793191932983)
    }],
  ], hooks))
})
