/**
 * 黄金对话（10-21 架构加固 P1）：把真实出过事的群对话从头到尾重放一遍——消息进 ingest → 桩分类走真实 /intake 路由 →
 * 桩执行器结果过真实核验闸（采证据那道换成桩）→ 真实 /status 回写与投递 → 断言群里 / 控制台收到的完整消息序列。
 * 单函数测试测不出补丁之间的交互（10-20 #56→#57→#58 连环），这里测的是「整条链路对人说了什么」。
 * 按新口径还没做到的场景标 todo（注明哪个阶段转绿），做到了就去掉 todo。
 * 不碰网络 / git / 模型：lark-cli 换成假程序，webhook 走 fetch 桩，运行态整个指到临时目录。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, before, beforeEach, describe, it } from 'node:test'

const tmpRoot = mkdtempSync(join(tmpdir(), 'lark-golden-'))
const saved = Object.fromEntries(['LARK_RUNTIME_DIR', 'LARK_OUTBOX_DIR', 'LARK_CLI_BIN', 'LARK_INSTANCE_MODE', 'LARK_GATEWAY_SECRET'].map((key) => [key, process.env[key]]))
process.env.LARK_RUNTIME_DIR = join(tmpRoot, 'runtime')
process.env.LARK_CLI_BIN = new URL('./fixtures/golden/fake-lark-cli.mjs', import.meta.url).pathname
process.env.LARK_INSTANCE_MODE = 'repo-only'
process.env.LARK_GATEWAY_SECRET = 'golden'

const { ingestLarkEvent } = await import('../lib/lark-ingest.mjs')
const { createRequestHandler } = await import('../lib/lark-routes.mjs')
const { createTaskStore } = await import('../lib/lark-task-store.mjs')
const { registerRepoProfiles, resetRepoProfiles } = await import('../lib/lark-repo-profile.mjs')
const { VERIFY_GATES, runVerifyGates } = await import('../lib/lark-task-gates.mjs')
const { expectsCodeChange } = await import('../lib/lark-work-policy.mjs')
const { assembleRunReport } = await import('../lib/lark-run-report.mjs')
const { sweepPendingAcks, DEFAULT_ACK_TIMEOUT_MS } = await import('../lib/lark-repo-intake.mjs')
const { isReadOnlyTask } = await import('../lib/lark-message.mjs')

const GROUP = 'oc_golden_php'
const CONSOLE = 'oc_golden_console'
const AVEN = 'ou_golden_aven'
const ENCONE = 'ou_golden_encone'
const BOT = 'ou_golden_bot'
const config = { allowedChatIds: [GROUP], allowedOpenIds: [AVEN, ENCONE], botOpenId: 'ou_golden_appbot', project: 'PR-1' }
const PROFILE = {
  root: join(tmpRoot, 'falive-react'), baseRef: 'main', chatIds: [GROUP], notifyChatId: CONSOLE,
  chatLabels: { [GROUP]: 'Falive PHP后端群' }, passiveMode: 'ledger', contextTrigger: true,
  ownership: { me: 'aven', meOpenIds: [AVEN], meAliases: ['Aven'] }, ownerMap: { aven: AVEN, Encone: ENCONE },
  botMentionOpenIds: { [GROUP]: BOT }, memberRoles: { Encone: 'portal 后端' },
  verify: { probeCommand: 'node scripts/pre-probe.mjs', env: 'pre' },
  intake: { fastLaneMs: 0, quietGapMs: 60_000, maxWaitMs: 180_000 },
  webhooksByChat: { [GROUP]: { url: 'https://hook/group' }, [CONSOLE]: { url: 'https://hook/console' } },
}
const headers = { 'x-lark-gateway-secret': 'golden', 'Content-Type': 'application/json' }
const PRE_OK = [{ endpoint: '/api/front/lives?type=-1&page=2&limit=20', outcome: 'code 0，5 条', kind: 'ok' }]

// ── 场景驱动 ─────────────────────────────────────────────────────────────
let savedFetch
let sent
let dir
let store
let server
let base
let seq = 0

const textOf = (body) => body?.card?.elements?.find((el) => el.tag === 'markdown')?.content ?? body?.content?.text ?? JSON.stringify(body)
const transcript = () => sent.map((item) => `${item.to}: ${item.text}`)
const groupTexts = () => sent.filter((item) => item.to === 'group').map((item) => item.text)
const consoleTexts = () => sent.filter((item) => item.to === 'console').map((item) => item.text)

const post = async (path, body) => {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
  return res.json()
}
const startServer = async () => {
  server = createServer(createRequestHandler({ config, store, consumer: { observe: () => ({ alive: true }) }, port: 0, runtimeVersion: { observe: () => ({}) } }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
}

// 群里有人说话（默认 @ 了 Aven.Bot）
const say = async ({ from, text, mention = true }) => {
  const id = `om_golden_${(seq += 1)}`
  const content = mention ? `@_user_1 ${text}` : text
  await ingestLarkEvent({
    raw: { message_id: id, chat_id: GROUP, chat_type: 'group', message_type: 'text', content, sender_type: 'user', sender_id: from,
      mentions: mention ? [{ id: BOT, key: '@_user_1', name: 'Aven.Bot' }] : [], create_time: String(Date.now()) },
    config, store,
  })
  return id
}
// aven 在控制台（私聊）说话
const dm = async (text) => {
  const id = `om_golden_dm_${(seq += 1)}`
  await ingestLarkEvent({ raw: { message_id: id, chat_id: CONSOLE, chat_type: 'p2p', message_type: 'text', content: text, sender_type: 'user', sender_id: AVEN, create_time: String(Date.now()) }, config, store })
  return id
}
const claim = (id) => {
  const task = store.get(id)
  assert.ok(task, `任务 ${id} 不存在`)
  if (task.intake?.notBefore) store.upsert({ ...task, intake: { ...task.intake, notBefore: null } })
  const claimed = store.claimById(id)
  assert.ok(claimed, `任务 ${id} 领不到（${task.status}）`)
  return claimed
}
// 分类器给出结论（走真实 /intake 路由）
const classify = async (id, classification) => {
  const task = claim(id)
  const out = await post(`/lark/tasks/${encodeURIComponent(id)}/intake`, { epoch: task.epoch, classification: { confidence: 'high', forMe: true, items: [], summary: '', reason: '', ...classification } })
  assert.equal(out.ok, true, `intake 回写失败：${JSON.stringify(out)}`)
  return out
}
// 执行器跑完：changedFiles = 工作区实测改动；闸用真实 done.trust（采证据那道换成桩）
const work = async (id, aiResult, { changedFiles = [], gates = null } = {}) => {
  const task = claim(id)
  const evidence = { name: 'evidence', applies: () => true, check: (ctx) => { ctx.evidence.changedFiles = changedFiles; ctx.outputs.actualChangedFiles = changedFiles; return { ok: true } } }
  const realGates = gates || VERIFY_GATES.filter((gate) => ['done.trust'].includes(gate.name))
  const workContext = { readOnly: isReadOnlyTask(task), cwd: PROFILE.root }
  const result = { checks: [], changedFiles, summary: '', ...aiResult }
  const verify = ['done', 'done_with_warnings'].includes(result.status)
    ? await runVerifyGates({ task, workContext, aiRun: { result }, expectsCode: expectsCodeChange({ task, readOnly: workContext.readOnly }), gates: [evidence, ...realGates] })
    : null
  const report = assembleRunReport({ aiResult: result, verify, resultText: result.summary || '已完成。', actualChangedFiles: changedFiles })
  const out = await post(`/lark/tasks/${encodeURIComponent(id)}/status`, { status: report.status, result: report.result, epoch: task.epoch, ...report.extras })
  assert.equal(out.ok, true, `status 回写失败：${JSON.stringify(out)}`)
  return { report, verify }
}

before(() => {
  savedFetch = globalThis.fetch
})
beforeEach(async () => {
  sent = []
  globalThis.fetch = async (url, init) => {
    const href = String(url)
    if (href.startsWith('https://hook/')) {
      sent.push({ to: href.endsWith('/group') ? 'group' : 'console', text: textOf(JSON.parse(init.body)) })
      return { ok: true, status: 200, text: async () => '{"code":0}', json: async () => ({ code: 0 }) }
    }
    return savedFetch(url, init)
  }
  registerRepoProfiles({ repos: { falive: PROFILE } })
  dir = mkdtempSync(join(tmpRoot, 'case-'))
  process.env.LARK_OUTBOX_DIR = join(dir, 'outbox')
  store = createTaskStore({ tasksDir: join(dir, 'tasks'), leaseMs: 60_000 })
  await startServer()
})
afterEach(() => {
  server.close()
  globalThis.fetch = savedFetch
  resetRepoProfiles()
  rmSync(join(tmpRoot, 'runtime'), { recursive: true, force: true })
})
after(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

// ── 场景（10-20 真机事故重放 + 新口径）────────────────────────────────────
describe('黄金对话', () => {
  it('S1 外部同事答复「接口更新了」→ 贴上下文的收到 + 一条结论；结论里「不再报错」不算问题（#56 / #57）', async () => {
    const id = await say({ from: ENCONE, text: 'front/lives 更新了，再试试' })
    assert.deepEqual(groupTexts(), [], '分类前不发固定句')
    await classify(id, { decision: 'api_reply', reply: '收到，front/lives 已更新，这就复测第 2 页，结果发群里' })
    await work(id, {
      status: 'done', completionClaim: 'all_done', preChecks: PRE_OK,
      groupReply: '直播列表第 2 页：都通了\n- ✅ 通了 直播列表翻页：pre 按顺序拉第 1、2、3 页都正常，第 2 页不再报错，也没有被限流',
    }, { changedFiles: ['docs/delivery/pending/对接-收尾-后台-2026-10-20.md'] })
    const group = groupTexts()
    assert.equal(group.length, 2, transcript().join('\n'))
    assert.match(group[0], /这就复测第 2 页/)
    assert.match(group[1], /都通了/)
    assert.doesNotMatch(group.join('\n'), /拿不准|稍后回复/)
  })

  it('S3 aven「你自己在 pre 看，看完报告」→ 复测只回填文档不判失败，结论发群（#58）', async () => {
    const id = await say({ from: AVEN, text: '你自己在 pre 环境看，看完报告结果' })
    await classify(id, { decision: 'requirement', reply: '收到，我去 pre 的 /lives 滚到底，看第 2 页有没有接上，看完报结果' })
    const { verify } = await work(id, {
      status: 'done', completionClaim: 'all_done', preChecks: PRE_OK,
      groupReply: '/lives 滚到底续拉：都通了\n- ✅ 通了 /lives 滚到底续拉：pre 浏览器实际滚到底，卡片从 20 张变成 25 张',
    }, { changedFiles: ['docs/delivery/pending/README.md'] })
    assert.equal(verify.ok, true, `核验闸拦下：${verify.reason}`)
    assert.deepEqual(['verification', true, false], [store.get(id).contract.deliverable, store.get(id).contract.browser, store.get(id).contract.readOnly], '任务契约：复测、给浏览器、在 worktree 里跑')
    const group = groupTexts()
    assert.equal(group.length, 2, transcript().join('\n'))
    assert.match(group[0], /滚到底/)
    assert.match(group[1], /都通了/)
  })

  it('S3c 复测一个文件都没改（空 diff）→ 不判失败，结论照发（10-20 前空 diff 一律判不可信）', async () => {
    const id = await say({ from: AVEN, text: '去 pre 上复测一下签到' })
    await classify(id, { decision: 'requirement', reply: '收到，我去 pre 复测签到，测完报结果' })
    const { verify } = await work(id, { status: 'done', completionClaim: 'all_done', preChecks: PRE_OK, groupReply: '签到复测：都通了\n- ✅ 通了 签到：pre 实测 code 0' }, { changedFiles: [] })
    assert.equal(verify.ok, true, `核验闸拦下：${verify.reason}`)
    assert.equal(groupTexts().length, 2, transcript().join('\n'))
  })

  it('S4 结论里「第 3 页为空说明到底了」不算问题（#58 重跑）', async () => {
    const id = await say({ from: AVEN, text: '你自己在 pre 环境看，看完报告结果' })
    await classify(id, { decision: 'requirement', reply: '收到，我去 pre 滚到底看，看完报结果' })
    await work(id, {
      status: 'done', completionClaim: 'all_done', preChecks: PRE_OK,
      groupReply: '/lives 滚到底续拉：都通了\n- ✅ 通了 front/lives 分页接口：第 1、2 页 code 0 有数据，第 3 页为空说明到底了',
    }, { changedFiles: ['docs/delivery/pending/README.md'] })
    assert.equal(groupTexts().length, 2, transcript().join('\n'))
    assert.doesNotMatch(groupTexts().join('\n'), /拿不准/)
  })

  it('S6 收到与分类之间网关重启 → 到点照发固定句一次，分类晚到不再补第二句（#57 隐患）', async () => {
    const id = await say({ from: ENCONE, text: '帮忙看下签到接口' })
    store = createTaskStore({ tasksDir: join(dir, 'tasks'), leaseMs: 60_000 }) // 重启：同目录新 store
    server.close()
    await startServer()
    await sweepPendingAcks({ store, now: Date.now() + DEFAULT_ACK_TIMEOUT_MS + 1 })
    await classify(id, { decision: 'question', reply: '收到，我查下签到接口，结果回群里' })
    const acks = groupTexts()
    assert.equal(acks.length, 1, transcript().join('\n'))
    assert.match(acks[0], /稍后回复/)
  })

  it('S2 外部同事的结论被扣下 → 群里只有那句收到，草稿私聊 aven；私聊「就这样回」才发群', { todo: 'P5 回复义务：被扣下时不再补「拿不准」' }, async () => {
    const id = await say({ from: ENCONE, text: 'front/lives 更新了，再试试' })
    await classify(id, { decision: 'api_reply', reply: '收到，这就复测，结果发群里' })
    await work(id, { status: 'done', completionClaim: 'all_done', preChecks: PRE_OK, groupReply: '都通了，第 3 页没有数据' }, { changedFiles: ['docs/a.md'] })
    assert.equal(groupTexts().length, 1, transcript().join('\n'))
    assert.match(consoleTexts().join('\n'), /就这样回/)
    await dm('就这样回')
    assert.equal(groupTexts().length, 2, transcript().join('\n'))
    assert.match(groupTexts()[1], /第 3 页没有数据/)
  })

  it('S5 外部同事的问题执行失败 → 群里只有那句收到，私聊 aven（不发「拿不准」）', { todo: 'P5 回复义务' }, async () => {
    const id = await say({ from: ENCONE, text: '头像是哪个接口' })
    await classify(id, { decision: 'question', reply: '收到，我查下头像用的接口，结果回群里' })
    await work(id, { status: 'failed', summary: '执行器超时' })
    assert.equal(groupTexts().length, 1, transcript().join('\n'))
    assert.equal(consoleTexts().length >= 1, true)
  })

  it('S3b aven 交代的改动没过核验闸 → 执行器写好的回答不丢，私聊里带草稿可放行', { todo: 'P3 闸只管提交' }, async () => {
    const id = await say({ from: AVEN, text: '把预约按钮文案改成「立即预约」' })
    await classify(id, { decision: 'requirement', reply: '收到，我去改预约按钮文案，改完说一声' })
    await work(id, { status: 'done', completionClaim: 'all_done', groupReply: '预约按钮文案改好了：「立即预约」' }, { changedFiles: ['docs/a.md'] })
    assert.equal(groupTexts().length, 1, transcript().join('\n'))
    assert.match(consoleTexts().join('\n'), /预约按钮文案改好了/, '私聊里要带执行器写好的回答草稿')
  })
})
