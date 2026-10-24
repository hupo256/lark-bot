import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { DEFAULT_TASK_BUDGET_MS, isShutdownAbort, remainingTaskBudgetMs, startLeaseHeartbeat } from '../lib/lark-task-runner.mjs'
import { runSteps } from './support/steps.mjs'

// 对接文档入库端到端：在干净子进程里跑真 createTaskRunner（运行态目录在模块加载时定，只能整个进程指到临时目录）。
// PATH 前插假 claude：--version 通过、只读分析吐 ready、实施阶段把给定结果写进结果文件；业务仓是临时 git 仓。
const DOC = 'docs/delivery/pending/对接-用户接口.md'
const runDocIntakeTask = ({ aiStatus, docAlreadyInRepo = false }) => {
  const tmp = mkdtempSync(join(tmpdir(), 'lark-doc-intake-'))
  try {
    const bin = join(tmp, 'bin')
    const repo = join(tmp, 'repo')
    mkdirSync(bin)
    mkdirSync(repo)
    const git = (args) => spawnSync('git', ['-C', repo, '-c', 'core.quotepath=off', ...args], { encoding: 'utf8' }).stdout.trim()
    git(['init', '-q', '-b', 'main'])
    git(['config', 'user.email', 't@t'])
    git(['config', 'user.name', 't'])
    // 规则上下文要求仓库 CLAUDE.md 的常驻硬规则章节在，缺了 runAI 会 fail-closed。
    writeFileSync(join(repo, 'CLAUDE.md'), '# rules\n\n## 固定前提（勿偏离）\n\n- 只做前端\n\n## 硬规则速览（细则见各向导）\n\n- 数据只用 zod\n')
    if (docAlreadyInRepo) {
      mkdirSync(join(repo, 'docs/delivery/pending'), { recursive: true })
      writeFileSync(join(repo, DOC), '# 用户接口\n')
    }
    git(['add', '-A'])
    git(['commit', '-q', '-m', 'init'])
    const attachment = join(tmp, '123-对接-用户接口.md')
    writeFileSync(attachment, '# 用户接口\n')
    const analysis = { status: 'ready', summary: '对接文档', applicableRules: [], requirements: [], blockers: [], scope: null }
    const result = { status: aiStatus, summary: '文档缺字段，等后端补', checks: [], changedFiles: [], warnings: [], blockers: aiStatus === 'blocked' ? ['缺 total 字段'] : null }
    writeFileSync(join(bin, 'claude'), [
      `#!${process.execPath}`,
      "const args = process.argv.slice(2)",
      "if (args[0] === '--version') { console.log('9.9.9 (fake)'); process.exit(0) }",
      `if (args.includes('--json-schema')) { process.stdout.write(JSON.stringify({ session_id: 'sess-a', structured_output: ${JSON.stringify(analysis)} })); process.exit(0) }`,
      "process.stdout.write('{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"sess-t\"}\\n')",
      "const resultPath = args.at(-1).match(/结果文件路径：(\\S+)/)?.[1]",
      `if (resultPath) require('node:fs').writeFileSync(resultPath, ${JSON.stringify(JSON.stringify(result))})`,
      '',
    ].join('\n'))
    chmodSync(join(bin, 'claude'), 0o755)
    const lib = (name) => JSON.stringify(new URL(`../lib/${name}`, import.meta.url).href)
    const script = `
      const { registerRepoProfiles } = await import(${lib('lark-repo-profile.mjs')})
      const { createTaskRunner } = await import(${lib('lark-task-runner.mjs')})
      registerRepoProfiles({ repos: { falive: { root: ${JSON.stringify(repo)}, baseRef: 'main', chatIds: ['oc'], ownership: { me: 'aven' }, docIntakeDir: 'docs/delivery/pending' } } })
      const now = new Date().toISOString()
      const task = { id: 'doc-1', epoch: 1, status: 'running', repo: 'falive', chatId: 'oc', text: '对接文档，看下要改什么', addressedToBot: true, createdAt: now, claimedAt: now,
        attachments: [{ type: 'file', fileName: '123-对接-用户接口.md', localPath: ${JSON.stringify(attachment)} }] }
      const reports = []
      let current = { ...task }
      const client = {
        updateTask: async (id, status, result) => { reports.push({ status, result: result || '' }); current = { ...current, status, result }; return { ok: true } },
        getTask: async () => current,
        resolveIntake: async () => ({}),
        listTasks: async () => [],
        heartbeatTask: async () => ({ ok: true }),
        releaseTask: async () => false,
      }
      await createTaskRunner({ client, workerConfig: { localConfig: {} } })(task, { repo: 'falive', projectId: null, projectName: 'Falive', cwd: ${JSON.stringify(repo)}, projectDocs: [], readOnly: false })
      process.stdout.write('\\nREPORTS=' + JSON.stringify(reports) + '\\n')
    `
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, LARK_RUNTIME_DIR: join(tmp, 'runtime'), LARK_CLI_BIN: '/usr/bin/false' }
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, cwd: tmp, encoding: 'utf8', timeout: 60_000 })
    const reports = JSON.parse(res.stdout.match(/\nREPORTS=(.*)\n/)?.[1] || 'null')
    assert.ok(reports, `子进程没跑完：${res.stderr.slice(-800)}`)
    return { reports, final: reports.at(-1), commits: git(['log', '--format=%s']).split('\n'), lastCommitFiles: git(['show', '--name-only', '--format=', 'HEAD']).split('\n') }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

describe('任务截止时间与续租心跳（第 0 批）', () => {
  it('剩余预算从领取时刻起算，退出型中断不写 failed、截止超时要写', () => runSteps([
    ['剩余预算从领取时刻起算；任务自带 taskBudgetMs 优先；超预算也留 60s 写失败', () => {
      const now = Date.parse('2026-10-17T10:00:00Z')
      assert.equal(remainingTaskBudgetMs({ claimedAt: '2026-10-17T09:50:00Z' }, now), DEFAULT_TASK_BUDGET_MS - 10 * 60_000)
      assert.equal(remainingTaskBudgetMs({ claimedAt: '2026-10-17T09:00:00Z', taskBudgetMs: 30 * 60_000 }, now), 60_000)
      assert.equal(remainingTaskBudgetMs({}, now), DEFAULT_TASK_BUDGET_MS)
    }],
    ['退出型中断不写 failed，截止时间（TimeoutError）要写 failed', () => {
      const shutdown = new AbortController()
      shutdown.abort()
      assert.equal(isShutdownAbort(shutdown.signal), true)
      const timeout = AbortSignal.timeout(1)
      return new Promise((resolve) => setTimeout(() => {
        assert.equal(timeout.aborted, true)
        assert.equal(isShutdownAbort(timeout), false)
        assert.equal(isShutdownAbort(undefined), false)
        resolve()
      }, 20))
    }],
    ['对接文档入库：AI 判 blocked（没完成）时文档照样入库提交，任务按 done 收尾、结论写「已存进仓库」+ 还缺什么（变异补测 10-24）', () => {
      const { final, commits, lastCommitFiles } = runDocIntakeTask({ aiStatus: 'blocked' })
      assert.equal(final.status, 'done', final.result)
      assert.match(final.result, /^文档已存进仓库（docs\/delivery\/pending\/对接-用户接口\.md）。/)
      assert.match(final.result, /还缺：缺 total 字段/)
      assert.equal(commits.length, 2, '入库提交了一次')
      assert.deepEqual(lastCommitFiles, [DOC], '只提交文档本身')
    }],
    ['对接文档入库：AI 判 done 但文档和仓里已有版本逐字节相同、工作区没动（无需改动）→ 也走入库收尾：done、「无需提交」、不提交（变异补测 10-24）', () => {
      const { final, commits } = runDocIntakeTask({ aiStatus: 'done', docAlreadyInRepo: true })
      assert.equal(final.status, 'done', final.result)
      assert.match(final.result, /^文档无需提交：对接-用户接口\.md 和仓里已有版本逐字节相同/)
      assert.deepEqual(commits, ['init'], '没有要提交的')
    }],
  ]))

  it('心跳每 leaseMs/3 续一次；gateway 回 ok:false（epoch 变了）就停；stop 后不再调', async () => {
    const calls = []
    let tick = null
    let cleared = 0
    const client = { heartbeatTask: async (id, epoch) => { calls.push([id, epoch]); return calls.length >= 2 ? { ok: false, code: 409 } : { ok: true } } }
    const stop = startLeaseHeartbeat({
      client,
      task: { id: 't1', epoch: 3 },
      leaseMs: 90_000,
      setIntervalImpl: (fn, ms) => { tick = fn; assert.equal(ms, 30_000); return { unref() {} } },
      clearIntervalImpl: () => { cleared += 1 },
    })
    await tick()
    assert.deepEqual(calls, [['t1', 3]])
    await tick()
    assert.equal(cleared, 1, '409 后停心跳')
    await tick()
    assert.equal(calls.length, 2, '停了就不再调')
    stop()
    assert.equal(startLeaseHeartbeat({ client: {}, task: { id: 'x' } })(), undefined, '没有 heartbeatTask 的 client 直接 no-op')
  })
})
