import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { buildEnvRetestText, enqueueEnvRetest } from '../lib/lark-deploy-watch.mjs'
import { createTaskStore } from '../lib/lark-task-store.mjs'
import { runSteps } from './support/steps.mjs'

// uat / online 发信后探到部署 → 在那个环境只读复测（aven 2026-10-31，lessons #101）
const PROFILE = { key: 'falive', root: '/repo', projectKey: 'falive', notifyChatId: 'oc_console', ownership: { me: 'aven', meOpenIds: ['ou_aven'] }, dailyReport: { sweep: { timeoutMs: 60_000, effort: 'high' } } }
const SITE = 'https://faliveuat.fdsser.com/hc'
const fakeGit = ({ known = ['f5f0033c', 'd8af97f3'], log = '', code = '' } = {}) => {
  const calls = []
  const git = async (_root, args) => {
    calls.push(args.join(' '))
    if (args[0] === 'cat-file') return { ok: known.includes(args[2].replace('^{commit}', '')), stdout: '' }
    if (args[0] === 'log') return { ok: true, stdout: args.includes(':(exclude)docs') ? code : log }
    return { ok: true, stdout: '' }
  }
  return { git, calls }
}

describe('uat / online 部署后只读复测', () => {
  let dir; let store
  const hooks = {
    before: () => { dir = mkdtempSync(join(tmpdir(), 'env-retest-')); store = createTaskStore({ tasksDir: join(dir, 'tasks'), leaseMs: 1000 }) },
    after: () => rmSync(dir, { recursive: true, force: true }),
  }

  it('按部署前后的提交建只读复测、幂等；只改 docs 不建；取不到目标提交不建', () => runSteps([
    ['有改代码的提交 → 建任务：只列代码提交，写明在 uat 站点测、不登录不写、pre 探针不算', async () => {
      const { git, calls } = fakeGit({ log: '73725b5a fix(task-center): 评论\n88bdfb9b docs(task-center): 记录', code: '73725b5a' })
      const out = await enqueueEnvRetest({ store, profile: PROFILE, env: 'uat', head: 'f5f0033c', from: 'd8af97f3', siteUrl: SITE, git })
      assert.deepEqual(out, { ok: true, taskId: 'retest-falive-uat-f5f0033c', commits: 1 })
      assert.ok(calls.includes('fetch origin uat'))
      const task = store.get(out.taskId)
      assert.equal(task.chatId, 'oc_console')
      assert.match(task.text, /uat 已部署 f5f0033c，在 uat 上只读复测/)
      assert.match(task.text, /- 73725b5a fix/)
      assert.doesNotMatch(task.text, /88bdfb9b/)
      assert.match(task.text, /页面工具 check --base https:\/\/faliveuat\.fdsser\.com\/hc/)
      assert.match(task.text, /pre 探针只连 pre，结果不能当 uat 的现状/)
      assert.match(task.text, /不登录、不做任何写操作/)
      const again = await enqueueEnvRetest({ store, profile: PROFILE, env: 'uat', head: 'f5f0033c', from: 'd8af97f3', siteUrl: SITE, git })
      assert.equal(again.existed, true)
    }],
    ['只改 docs 的部署不复测', async () => {
      const { git } = fakeGit({ known: ['aaaaaaaa', 'd8af97f3'], log: 'aaaaaaaa docs: x', code: '' })
      assert.deepEqual(await enqueueEnvRetest({ store, profile: PROFILE, env: 'uat', head: 'aaaaaaaa', from: 'd8af97f3', siteUrl: SITE, git }), { ok: true, skipped: 'docs-only' })
    }],
    ['本地取不到目标提交 → 不建；没有起点 → 照常建、按页面复测', async () => {
      const { git } = fakeGit({ known: ['c1a40982'] })
      assert.equal((await enqueueEnvRetest({ store, profile: PROFILE, env: 'online', head: 'deadbeef', siteUrl: SITE, git })).ok, false)
      const out = await enqueueEnvRetest({ store, profile: PROFILE, env: 'online', head: 'c1a40982', from: null, siteUrl: 'https://www.falive.com/hc', git })
      assert.equal(out.ok, true)
      assert.match(store.get(out.taskId).text, /没取到提交列表，按 online 实际页面复测/)
      assert.match(buildEnvRetestText({ me: 'aven', env: 'online', head: 'c1a40982', commits: [], siteUrl: 'x' }), /而且是生产/)
    }],
  ], hooks))
})
