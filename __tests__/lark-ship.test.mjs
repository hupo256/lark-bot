import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { matchDeployNotices, parseBuildNotice, projectForLabel } from '../lib/lark-build-notice.mjs'
import { buildRetestTask, listWatches, pickSourceTask, runDeployWatchTick, writeWatch } from '../lib/lark-deploy-watch.mjs'
import { createGitlabClient, gitlabTargetFromRemote, labelsForPaths, labelsFromText, mergeStateOf, resolveGitlabSettings } from '../lib/lark-gitlab.mjs'
import { runOpsAction } from '../lib/lark-ops-run.mjs'
import { parseOpsAction } from '../lib/lark-ops-task.mjs'
import { buildConflictPrompt, hasConflictMarkers, mergeBranchName, parseShipAction, resolveShipBranch, runShipAction } from '../lib/lark-ship.mjs'
import { runSteps } from './support/steps.mjs'

// aven 11-06：「部署 dev / test」——推分支、按改动打 Labels 合 MR（冲突在 <分支>-to-<环境> 上解）、等建置通知群的 Jenkins 卡、复测、私信。
const KNOWN = ['admin', 'business-system', 'cms', 'futures-admin', 'Review effort 1/5', 'security-admin', 'web', 'web-next']
const dir = mkdtempSync(join(tmpdir(), 'lark-ship-'))
after(() => rmSync(dir, { recursive: true, force: true }))

// 建置通知群里的真卡（11-06 18:46，lark-cli im +chat-messages-list 的 content）
const CARD = (title, branch, commits) => ({
  message_id: `om_${title.length}_${branch}`,
  create_time: '2026-11-06 18:46',
  content: `<card title="${title}">\n**构建信息**\n- 项目名称: x\n- 分支: ${branch}\n- 环境: ${branch.toUpperCase()}\n- 构建地址: [http://34.143.211.254:8080/job/exchange-web-next-test/217/console](http://34.143.211.254:8080/job/exchange-web-next-test/217/console)\n**新增提交**\n${commits.map(([s, h]) => `- ${s} (${h})`).join('\n')}\n**相关开发者**\n@Hurley(ou_9ee2)\n</card>`,
})

// 假 git：按参数串里的关键字给结果，记下调用
const fakeGit = (table) => {
  const calls = []
  const git = (args) => {
    const line = args.join(' ')
    calls.push(line)
    const key = Object.keys(table).find((k) => line.includes(k))
    const value = key ? table[key] : { status: 0, stdout: '', stderr: '' }
    return typeof value === 'function' ? value(line) : value
  }
  return { git, calls }
}
const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' })
const fail = (stderr = 'x', status = 1) => ({ status, stdout: '', stderr })

const fakeGitlab = ({ states = ['mergeable'], existing = null } = {}) => {
  const calls = []
  let n = 0
  return {
    calls,
    listLabels: async () => KNOWN,
    findOpenMr: async (q) => { calls.push(['find', q.source, q.target]); return existing && q.source === existing.source_branch ? existing : null },
    createMr: async (body) => { calls.push(['create', body.source, body.target, body.labels.join(',')]); return { iid: 10 + calls.filter(([kind]) => kind === 'create').length, web_url: `http://g/mr/${body.source}`, labels: body.labels } },
    addLabels: async ({ iid, labels }) => { calls.push(['labels', iid, labels.join(',')]); return { ...existing, labels: [...existing.labels, ...labels] } },
    waitMergeState: async (iid) => { const state = states[Math.min(n, states.length - 1)]; n += 1; calls.push(['wait', iid, state]); return { mr: { iid }, state } },
    mergeMr: async (iid) => { calls.push(['merge', iid]); return { iid, merge_commit_sha: 'abc1234def5678' } },
    getMr: async (iid) => ({ iid, merge_commit_sha: 'abc1234def5678' }),
  }
}

const baseDeps = (over = {}) => {
  const watches = []
  return {
    watches,
    deps: {
      prdText: () => '',
      prepareTools: () => {},
      readFile: () => 'clean',
      resolveConflicts: async () => ({ status: 'done', summary: '两边都保留' }),
      writeWatch: (entry) => watches.push(entry),
      worktreesDir: '/w',
      now: () => Date.parse('2026-11-06T10:00:00Z'),
      ...over,
    },
  }
}
const OPS_TASK = { id: 'om_ops', chatId: 'oc_dm', messageId: 'om_ops', text: '部署 test PR-02463' }

describe('部署 dev / test（lib/lark-ship + lark-gitlab + lark-build-notice + lark-deploy-watch）', () => {
  it('解析 / 定分支 / Labels / MR 状态 / 卡片 / 合并流程 / 冲突 / 部署等待 / 复测任务 / 运维入口', () => runSteps([
    ['原话：部署 dev / test 带分支或项目号 → ship；部署 pre / online 不代办（manual）', () => {
      assert.deepEqual(parseShipAction('部署 test PR-02463'), { action: 'ship', env: 'test', projectId: 'PR-02463' })
      assert.deepEqual(parseShipAction('运维：部署dev feature/PR-02374。'), { action: 'ship', env: 'dev', branch: 'feature/PR-02374', projectId: 'PR-02374' })
      assert.deepEqual(parseShipAction('部署 test'), { action: 'ship', env: 'test' })
      assert.equal(parseShipAction('部署 testing'), null)
      assert.equal(parseShipAction('部署 online'), null)
      assert.deepEqual(parseOpsAction('部署 test fix/TR-02646'), { action: 'ship', env: 'test', branch: 'fix/TR-02646', projectId: 'TR-02646' })
      assert.equal(parseOpsAction('部署 online').action, 'manual')
    }],
    ['定分支：分支名 > 项目号唯一命中 > 回复的那单的分支；环境分支 / 多条命中 / 没说都问', () => {
      const branches = ['online', 'test', 'feature/PR-02463', 'feat/PR-02521-aboutUs', 'feat/2521-aboutUs', 'fix/TR-02646', 'feature/PR-02463-to-test', 'origin']
      assert.deepEqual(resolveShipBranch({ action: { env: 'test', branch: 'fix/TR-02646' }, branches }), { branch: 'fix/TR-02646' })
      assert.match(resolveShipBranch({ action: { env: 'test', branch: 'fix/nope' }, branches }).error, /都没有分支 fix\/nope/)
      assert.match(resolveShipBranch({ action: { env: 'test', branch: 'test' }, branches }).error, /环境分支/)
      assert.deepEqual(resolveShipBranch({ action: { env: 'test', projectId: 'PR-02463' }, branches }), { branch: 'feature/PR-02463' }, '<分支>-to-test 不算候选')
      assert.deepEqual(resolveShipBranch({ action: { env: 'test', projectId: 'PR-02521' }, branches }), { branch: 'feat/PR-02521-aboutUs' })
      assert.match(resolveShipBranch({ action: { env: 'test', projectId: 'PR-09999' }, branches }).error, /没找到 PR-09999/)
      assert.match(resolveShipBranch({ action: { env: 'test', projectId: 'PR-1' }, branches: ['feat/PR-1-a', 'fix/PR-1-b'] }).error, /好几条/)
      assert.deepEqual(resolveShipBranch({ action: { env: 'dev' }, quotedBranch: 'fix/lark-x', branches }), { branch: 'fix/lark-x' })
      assert.match(resolveShipBranch({ action: { env: 'dev' }, branches }).error, /没说部署哪个分支/)
      assert.equal(mergeBranchName('feature/PR-1', 'test'), 'feature/PR-1-to-test')
    }],
    ['GitLab 地址 / 令牌路径 / Labels 推断', () => {
      assert.deepEqual(gitlabTargetFromRemote('http://mgit.lgroup.co/hqex/web/fameex-web.git'), { apiBase: 'http://mgit.lgroup.co/api/v4', projectPath: 'hqex/web/fameex-web' })
      assert.deepEqual(gitlabTargetFromRemote('git@mgit.lgroup.co:hqex/web/fameex-web.git'), { apiBase: 'http://mgit.lgroup.co/api/v4', projectPath: 'hqex/web/fameex-web' })
      assert.equal(gitlabTargetFromRemote(''), null)
      assert.equal(resolveGitlabSettings({ gitlab: { baseUrl: 'http://g/', projectPath: 'a/b', tokenPath: '/t' } }).apiBase, 'http://g/api/v4')
      assert.equal(resolveGitlabSettings({ remote: '' }), null)
      assert.deepEqual(labelsForPaths(['apps/web-next/a.tsx', 'apps/admin/b.ts', 'apps/storybook/c', 'packages/x/y.ts', 'apps/web-next/z'], KNOWN), { labels: ['admin', 'web-next'], appDirs: ['admin', 'storybook', 'web-next'] })
      assert.deepEqual(labelsFromText('部署 test 带上 web-next 和 admin', KNOWN), ['admin', 'web-next'])
      assert.deepEqual(labelsFromText('需求：合约后台、风控后台新增字段；现货后台不动', KNOWN), ['admin', 'futures-admin', 'security-admin'])
      assert.deepEqual(labelsFromText('futures-admin 页面', KNOWN), ['futures-admin'], 'futures-admin 不顺带 admin')
      assert.deepEqual(labelsFromText('Review effort 1/5', KNOWN), [])
    }],
    ['MR 能不能合：merged / checking / mergeable / conflict / blocked', () => {
      assert.equal(mergeStateOf({ state: 'merged' }).state, 'merged')
      assert.equal(mergeStateOf({ state: 'opened', detailed_merge_status: 'checking' }).state, 'checking')
      assert.equal(mergeStateOf({ state: 'opened', detailed_merge_status: 'mergeable' }).state, 'mergeable')
      assert.equal(mergeStateOf({ state: 'opened', has_conflicts: true, detailed_merge_status: 'broken_status' }).state, 'conflict')
      assert.equal(mergeStateOf({ state: 'opened', merge_status: 'cannot_be_merged' }).state, 'conflict')
      assert.equal(mergeStateOf({ state: 'opened', merge_status: 'can_be_merged' }).state, 'mergeable')
      assert.deepEqual(mergeStateOf({ state: 'opened', detailed_merge_status: 'not_approved' }), { state: 'blocked', reason: 'GitLab 说不能合（not_approved）' })
      assert.equal(mergeStateOf({ state: 'closed' }).state, 'blocked')
    }],
    ['GitLab 客户端：带令牌头、报错不带令牌、等能不能合', async () => {
      const seen = []
      const replies = [{ state: 'opened', detailed_merge_status: 'checking' }, { state: 'opened', detailed_merge_status: 'mergeable', iid: 3 }]
      const fetchImpl = async (url, init) => {
        seen.push([url, init.method, init.headers['PRIVATE-TOKEN']])
        if (url.includes('/labels')) return { ok: false, status: 401, json: async () => ({ message: '401 Unauthorized' }) }
        return { ok: true, status: 200, json: async () => replies.shift() }
      }
      const client = createGitlabClient({ apiBase: 'http://g/api/v4', projectPath: 'hqex/web/fameex-web', token: 'glpat-secret', fetchImpl, sleep: async () => {} })
      await assert.rejects(client.listLabels(), (error) => /HTTP 401 401 Unauthorized/.test(error.message) && !error.message.includes('glpat'))
      const verdict = await client.waitMergeState(3)
      assert.equal(verdict.state, 'mergeable')
      assert.equal(seen[1][0], 'http://g/api/v4/projects/hqex%2Fweb%2Ffameex-web/merge_requests/3')
      assert.equal(seen[1][2], 'glpat-secret')
    }],
    ['建置通知卡片：解析成功 / 失败卡，按 Label + 环境 + 合并提交认，失败后重跑以最新为准，没列出就看祖先', () => {
      const card = parseBuildNotice(CARD('FameEX exchange-web-next 部署成功 ✅', 'test', [["Merge branch 'feat/2521-aboutUs' into 'test'", '90401e0'], ['走查问题修复', '2168d32']]))
      assert.deepEqual({ ...card, messageId: null }, { messageId: null, at: '2026-11-06 18:46', project: 'exchange-web-next', stage: 'deploy', ok: true, branch: 'test', env: 'test', url: 'http://34.143.211.254:8080/job/exchange-web-next-test/217/console', commits: [{ subject: "Merge branch 'feat/2521-aboutUs' into 'test'", sha: '90401e0' }, { subject: '走查问题修复', sha: '2168d32' }] })
      assert.equal(parseBuildNotice({ content: '<card title="别的卡">' }), null)
      const failed = parseBuildNotice({ ...CARD('FameEX exchange-web-admin 构建失败 ❌', 'test', [['m', '90401e0']]), create_time: '2026-11-06 18:40' })
      assert.equal(failed.ok, false)
      const later = parseBuildNotice({ ...CARD('FameEX exchange-web-admin 部署成功 ✅', 'test', [['m', '90401e0']]), create_time: '2026-11-06 18:50' })
      const other = parseBuildNotice(CARD('FameEX exchange-web 部署成功 ✅', 'dev', [['m', '90401e0']]))
      const m1 = matchDeployNotices({ env: 'test', mergeSha: '90401e0aaaa', labels: ['web-next', 'admin', 'web'], notices: [failed, card, later, other] })
      assert.equal(m1.done['web-next'], card)
      assert.equal(m1.done.admin, later)
      assert.deepEqual(m1.pending, ['web'], 'dev 的卡不算 test')
      const m2 = matchDeployNotices({ env: 'test', mergeSha: 'fff0000', labels: ['web-next'], notices: [card], isAncestor: (a, b) => a === 'fff0000' && b === '90401e0' })
      assert.equal(m2.done['web-next'], card)
    }],
    ['合并：推分支 → 按改动打 Labels 建 MR → 能合就合 → 登记部署等待', async () => {
      const { git, calls } = fakeGit({
        'for-each-ref': ok('feature/PR-02463\norigin/feature/PR-02463\norigin/test\n'),
        'rev-parse --verify --quiet refs/heads/feature/PR-02463': ok('x'),
        'rev-parse --verify --quiet origin/feature/PR-02463': ok('1111111aaaa\n'),
        'merge-base --is-ancestor': fail(),
        'diff --name-only': ok('apps/web-next/a.tsx\napps/admin/b.ts\n'),
      })
      const gitlab = fakeGitlab()
      const { deps, watches } = baseDeps({ git, gitlab })
      const out = await runShipAction({ task: OPS_TASK, action: { action: 'ship', env: 'test', projectId: 'PR-02463' }, deps })
      assert.equal(out.status, 'done')
      assert.ok(calls.includes('push origin refs/heads/feature/PR-02463:refs/heads/feature/PR-02463'))
      assert.ok(!calls.some((line) => line.includes('--force')))
      assert.deepEqual(gitlab.calls.filter(([kind]) => kind !== 'find'), [['create', 'feature/PR-02463', 'test', 'admin,web-next'], ['wait', 11, 'mergeable'], ['merge', 11]])
      assert.match(out.text, /已合进 test：feature\/PR-02463\n- MR：http:\/\/g\/mr\/feature\/PR-02463（Labels admin、web-next）\n- 合并提交 abc1234d/)
      assert.equal(watches.length, 1)
      assert.deepEqual({ ...watches[0], startedAt: null }, { id: 'om_ops', env: 'test', branch: 'feature/PR-02463', mergeBranch: null, mergeSha: 'abc1234def5678', labels: ['admin', 'web-next'], mr: { iid: 11, url: 'http://g/mr/feature/PR-02463' }, chatId: 'oc_dm', messageId: 'om_ops', sourceTaskId: null, projectId: 'PR-02463', status: 'waiting', startedAt: null })
    }],
    ['合并：已有 MR 补 Labels；已整个在目标分支上不合；推被拒不合；只改公共目录按 PRD 判 / 判不出就问', async () => {
      const table = (over = {}) => fakeGit({ 'for-each-ref': ok('origin/fix/a\n'), 'rev-parse --verify --quiet refs/heads': fail(), 'rev-parse --verify --quiet origin/fix/a': ok('2222222\n'), 'merge-base --is-ancestor': fail(), 'diff --name-only': ok('apps/web/x.ts\n'), ...over })
      const existing = { iid: 7, source_branch: 'fix/a', web_url: 'http://g/7', labels: ['web-next'] }
      const g1 = fakeGitlab({ existing })
      const r1 = await runShipAction({ task: { ...OPS_TASK, text: '部署 dev fix/a' }, action: { action: 'ship', env: 'dev', branch: 'fix/a' }, deps: baseDeps({ git: table().git, gitlab: g1 }).deps })
      assert.equal(r1.status, 'done')
      assert.deepEqual(g1.calls.find(([kind]) => kind === 'labels'), ['labels', 7, 'web'])
      const r2 = await runShipAction({ task: OPS_TASK, action: { action: 'ship', env: 'dev', branch: 'fix/a' }, deps: baseDeps({ git: table({ 'merge-base --is-ancestor': ok() }).git, gitlab: fakeGitlab() }).deps })
      assert.deepEqual(r2, { status: 'done', text: 'fix/a（2222222）已经整个在 dev 上了，不用再合，也不会触发新的部署。' })
      const r3 = await runShipAction({ task: OPS_TASK, action: { action: 'ship', env: 'dev', branch: 'fix/a' }, deps: baseDeps({ git: table({ 'for-each-ref': ok('fix/a\n'), 'rev-parse --verify --quiet refs/heads': ok(), 'push origin': fail('! [rejected] non-fast-forward') }).git, gitlab: fakeGitlab() }).deps })
      assert.equal(r3.status, 'failed')
      assert.match(r3.text, /推 fix\/a 被拒，没合：! \[rejected\]/)
      const pkgOnly = { 'for-each-ref': ok('origin/feat/PR-02012-x\n'), 'rev-parse --verify --quiet origin/feat/PR-02012-x': ok('3333333\n'), 'diff --name-only': ok('packages/ui/a.ts\n') }
      const { deps: d4, watches: w4 } = baseDeps({ git: table(pkgOnly).git, gitlab: fakeGitlab(), prdText: (id) => (id === 'PR-02012' ? '需求：合约后台新增字段' : '') })
      const r4 = await runShipAction({ task: OPS_TASK, action: { action: 'ship', env: 'test', branch: 'feat/PR-02012-x' }, deps: d4 })
      assert.equal(r4.status, 'done')
      assert.deepEqual(w4[0].labels, ['futures-admin'])
      assert.match(r4.text, /按 PR-02012 的需求文档判成 futures-admin/)
      const r5 = await runShipAction({ task: OPS_TASK, action: { action: 'ship', env: 'test', branch: 'feat/PR-02012-x' }, deps: baseDeps({ git: table(pkgOnly).git, gitlab: fakeGitlab() }).deps })
      assert.equal(r5.status, 'blocked')
      assert.match(r5.text, /判断不出该打哪些 Labels，没合/)
    }],
    ['冲突：在 <分支>-to-<环境> 上合目标分支 → 模型解 → 核对标记 → 提交 → 推 → 用它建 MR 合；模型没解 / 留标记就停', async () => {
      const gitTable = { 'for-each-ref': ok('origin/fix/a\n'), 'rev-parse --verify --quiet refs/heads': fail(), 'rev-parse --verify --quiet origin/fix/a-to-test': fail(), 'rev-parse --verify --quiet origin/fix/a': ok('4444444\n'), 'merge-base --is-ancestor': fail(), 'diff --name-only origin': ok('apps/web-next/a.tsx\n') }
      const atCalls = []
      const gitAt = (cwd, args) => {
        const line = args.join(' ')
        atCalls.push(line)
        if (line.startsWith('merge --no-ff')) return fail('CONFLICT')
        if (line.includes('--diff-filter=U')) return ok('apps/web-next/a.tsx\n')
        return ok()
      }
      const gitlab = fakeGitlab({ states: ['conflict', 'mergeable'] })
      const asked = []
      const { git, calls } = fakeGit(gitTable)
      const { deps, watches } = baseDeps({ git, gitAt, gitlab, resolveConflicts: async (input) => { asked.push(input.files); return { status: 'done', summary: '两边都保留' } } })
      const out = await runShipAction({ task: OPS_TASK, action: { action: 'ship', env: 'test', branch: 'fix/a' }, deps })
      assert.equal(out.status, 'done')
      assert.ok(calls.includes('worktree add -B fix/a-to-test /w/lark-merge-fix-a-test origin/fix/a'))
      assert.deepEqual(atCalls, ['merge --no-ff --no-edit origin/test', 'diff --name-only --diff-filter=U', 'add -A', 'commit --no-edit', 'push origin HEAD:refs/heads/fix/a-to-test'])
      assert.deepEqual(asked, [['apps/web-next/a.tsx']])
      assert.deepEqual(gitlab.calls.filter(([kind]) => kind === 'create').map((c) => c[1]), ['fix/a', 'fix/a-to-test'])
      assert.equal(watches[0].mergeBranch, 'fix/a-to-test')
      assert.match(out.text, /有冲突，在 fix\/a-to-test 上解的：两边都保留/)
      const blocked = await runShipAction({ task: OPS_TASK, action: { action: 'ship', env: 'test', branch: 'fix/a' }, deps: baseDeps({ git: fakeGit(gitTable).git, gitAt, gitlab: fakeGitlab({ states: ['conflict'] }), resolveConflicts: async () => ({ status: 'blocked', blockers: ['金额判断两边都改了'] }) }).deps })
      assert.equal(blocked.status, 'blocked')
      assert.match(blocked.text, /我没解（金额判断两边都改了）。冲突文件：apps\/web-next\/a.tsx。现场留在 \/w\/lark-merge-fix-a-test/)
      const marked = await runShipAction({ task: OPS_TASK, action: { action: 'ship', env: 'test', branch: 'fix/a' }, deps: baseDeps({ git: fakeGit(gitTable).git, gitAt, gitlab: fakeGitlab({ states: ['conflict'] }), readFile: () => 'a\n<<<<<<< HEAD\nb\n' }).deps })
      assert.match(marked.text, /解完还留着冲突标记：apps\/web-next\/a.tsx/)
      assert.equal(hasConflictMarkers('x\n=======\ny'), true)
      assert.equal(hasConflictMarkers('// ======== 分隔'), false)
      const prompt = buildConflictPrompt({ branch: 'fix/a', env: 'test', files: ['a.ts'], cwd: '/w/x' })
      assert.match(prompt, /不 git add \/ commit \/ push/)
      assert.match(prompt, /status 用 blocked/)
    }],
    ['部署等待：全部部署成功 → 开复测任务（实测契约、回在原私信下）+ 私信；失败卡 → 私信不复测；超时 → 私信；没有等待不读群', async () => {
      const wdir = join(dir, 'watch')
      const watch = { id: 'om_ops', env: 'test', branch: 'feat/2521-aboutUs', mergeSha: '90401e0aaaa', labels: ['web-next'], mr: { url: 'http://g/1' }, chatId: 'oc_dm', messageId: 'om_ops', sourceTaskId: 'om_src', status: 'waiting', startedAt: '2026-11-06T10:00:00.000Z' }
      writeWatch({ dir: wdir, entry: watch })
      const tasks = new Map([['om_src', { id: 'om_src', project: 'PR-02521', text: '关于我们页改版', result: '已改完 4 个区块', branch: 'feat/2521-aboutUs' }]])
      const sent = []
      let reads = 0
      const card = parseBuildNotice(CARD('FameEX exchange-web-next 部署成功 ✅', 'test', [["Merge branch 'feat/2521-aboutUs' into 'test'", '90401e0']]))
      const deps = (notices, nowIso = '2026-11-06T10:10:00Z') => ({
        dir: wdir, config: { notifyOpenId: 'ou_owner', envSites: { test: 'https://www.dvmkgi.vip' } }, now: () => Date.parse(nowIso),
        readNotices: async () => { reads += 1; return notices },
        send: async (msg) => sent.push(msg),
        store: { list: () => [...tasks.values()], get: (id) => tasks.get(id) || null, upsert: (task) => { tasks.set(task.id, task); return task } },
      })
      assert.deepEqual(await runDeployWatchTick({ deps: deps([]) }), [])
      assert.equal(sent.length, 0)
      assert.deepEqual(await runDeployWatchTick({ deps: deps([card]) }), [{ id: 'om_ops', outcome: 'deployed' }])
      const retest = tasks.get('retest-om_ops')
      assert.equal(retest.contract.deliverable, 'verification')
      assert.equal(retest.project, 'PR-02521')
      assert.deepEqual(retest.replyTarget, { messageId: 'om_ops', inThread: false })
      assert.match(retest.text, /复测 test 环境：feat\/2521-aboutUs 已合进 test（合并提交 90401e0a/)
      assert.match(retest.text, /https:\/\/www.dvmkgi.vip/)
      assert.match(retest.text, /原话：\n<<<SOURCE\n关于我们页改版\nSOURCE\n当时的结论：已改完 4 个区块/)
      assert.deepEqual(sent.pop(), { chatId: 'oc_dm', messageId: 'om_ops', text: 'test 部署好了（exchange-web-next），开始复测，结果随后私信你。' })
      assert.equal(projectForLabel('admin'), 'exchange-web-admin')
      assert.equal(projectForLabel('web'), 'exchange-web')
      assert.equal(projectForLabel('web-next'), 'exchange-web-next')
      assert.equal(listWatches({ dir: wdir })[0].status, 'deployed')
      const readsBefore = reads
      assert.deepEqual(await runDeployWatchTick({ deps: deps([card]) }), [], '收口了不再读群')
      assert.equal(reads, readsBefore)
      writeWatch({ dir: wdir, entry: { ...watch, id: 'om_f', labels: ['web-next', 'admin'] } })
      const bad = parseBuildNotice(CARD('FameEX exchange-web-admin 部署失败 ❌', 'test', [['m', '90401e0']]))
      assert.deepEqual(await runDeployWatchTick({ deps: deps([card, bad]) }), [{ id: 'om_f', outcome: 'failed' }])
      assert.match(sent.pop().text, /⛔ feat\/2521-aboutUs 合进 test 后 Jenkins 没过，没复测：\n- exchange-web-admin：部署失败 http/)
      writeWatch({ dir: wdir, entry: { ...watch, id: 'om_t' } })
      assert.deepEqual(await runDeployWatchTick({ deps: deps([], '2026-11-06T10:30:00Z') }), [])
      assert.deepEqual(await runDeployWatchTick({ deps: deps([], '2026-11-06T10:41:00Z') }), [{ id: 'om_t', outcome: 'timeout' }])
      assert.match(sent.pop().text, /已经 40 分钟，建置通知里还没等到 exchange-web-next 的部署卡/)
      assert.deepEqual(await runDeployWatchTick({ deps: deps([], '2026-11-14T10:41:00Z') }), [])
      assert.equal(listWatches({ dir: wdir }).length, 0, '收口 7 天后清掉')
    }],
    ['复测任务：没有原任务按分支提交测；原任务按登记点名 > 同分支最近一单', () => {
      const watch = { id: 'w', env: 'dev', branch: 'fix/a', mergeSha: 'abc', labels: ['web'], chatId: 'oc_dm', messageId: null, projectId: 'TR-1' }
      const task = buildRetestTask({ watch, config: { notifyOpenId: 'ou_owner' }, now: 0 })
      assert.equal(task.contract.deliverable, 'verification')
      assert.equal(task.replyTarget, null)
      assert.match(task.text, /没有对应的 bot 任务：按 `git log origin\/dev` 里 fix\/a 的提交.*需求是 TR-1/)
      const list = [{ id: 'a', branch: 'fix/a', updatedAt: '1' }, { id: 'b', branch: 'fix/a', updatedAt: '2' }, { id: 'c', branch: 'fix/a', updatedAt: '3', deployRetest: {} }]
      assert.equal(pickSourceTask({ watch, tasks: list }).id, 'b')
      assert.equal(pickSourceTask({ watch: { ...watch, sourceTaskId: 'a' }, tasks: list, get: (id) => list.find((t) => t.id === id) }).id, 'a')
    }],
    ['运维入口：负责人私信「部署 test」走 ship；别人说不做', async () => {
      const reports = []
      const shipped = []
      const reportStatus = async (status, text) => reports.push([status, text])
      const config = { notifyOpenId: 'ou_owner' }
      const out = await runOpsAction({ task: { id: 't', operator: 'ou_owner', text: '部署 test PR-1', project: null }, workerConfig: { localConfig: config }, reportStatus, ship: async (input) => { shipped.push(input.action); return { status: 'done', text: '已合进 test' } } })
      assert.deepEqual(out, { status: 'done' })
      assert.deepEqual(shipped, [{ action: 'ship', env: 'test', projectId: 'PR-1' }])
      assert.deepEqual(reports, [['running', undefined], ['done', '已合进 test']])
      reports.length = 0
      await runOpsAction({ task: { id: 't', operator: 'ou_x', text: '部署 test PR-1' }, workerConfig: { localConfig: config }, reportStatus, ship: async () => assert.fail('不该跑') })
      assert.equal(reports[0][0], 'failed')
    }],
  ]))
})
