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
const { createGatewayClient } = await import('../lib/lark-gateway-client.mjs')
const { sendChatMessage } = await import('../lib/lark-cli.mjs')
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
  botMentionOpenIds: { [GROUP]: BOT }, botName: 'Aven.Bot', memberRoles: { Encone: 'portal 后端' },
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
const say = async ({ from, text, mention = true, root = null }) => {
  const id = `om_golden_${(seq += 1)}`
  const content = mention ? `@_user_1 ${text}` : text
  await ingestLarkEvent({
    raw: { message_id: id, chat_id: GROUP, chat_type: 'group', message_type: 'text', content, sender_type: 'user', sender_id: from,
      mentions: mention ? [{ id: BOT, key: '@_user_1', name: 'Aven.Bot' }] : [], create_time: String(Date.now()), ...(root ? { root_id: root, reply_to: root } : {}) },
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
const work = async (id, aiResult, { changedFiles = [], gates = null, runEvidence = null, ownerNotes = [] } = {}) => {
  const task = claim(id)
  const evidence = { name: 'evidence', applies: () => true, check: (ctx) => { ctx.evidence.changedFiles = changedFiles; ctx.outputs.actualChangedFiles = changedFiles; return { ok: true } } }
  const realGates = gates || VERIFY_GATES.filter((gate) => ['done.trust'].includes(gate.name))
  const workContext = { readOnly: isReadOnlyTask(task), cwd: PROFILE.root }
  const result = { checks: [], changedFiles, summary: '', ...aiResult }
  const verify = ['done', 'done_with_warnings'].includes(result.status)
    ? await runVerifyGates({ task, workContext, aiRun: { result }, expectsCode: expectsCodeChange({ task, readOnly: workContext.readOnly }), gates: [evidence, ...realGates] })
    : null
  const report = assembleRunReport({ aiResult: result, verify, resultText: result.summary || '已完成。', actualChangedFiles: changedFiles, evidence: runEvidence, ownerNotes })
  // 走 worker 真实用的网关客户端回写（10-21：客户端字段白名单丢了 change / report，直接 POST 的测试测不出来）
  const out = await createGatewayClient(base).updateTask(id, report.status, report.result, 'claude', task.epoch, null, null, report.extras)
  assert.equal(out?.ok, true, `status 回写失败：${JSON.stringify(out)}`)
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

  it('S2 外部同事的结论被扣下 → 群里只有那句收到，草稿私聊 aven；私聊「就这样回」才发群', async () => {
    const id = await say({ from: ENCONE, text: 'front/lives 更新了，再试试' })
    await classify(id, { decision: 'api_reply', reply: '收到，这就复测，结果发群里' })
    await work(id, { status: 'done', completionClaim: 'all_done', preChecks: PRE_OK, groupReply: '都通了，第 3 页没有数据' }, { changedFiles: ['docs/a.md'] })
    assert.equal(groupTexts().length, 1, transcript().join('\n'))
    assert.match(consoleTexts().join('\n'), /就这样回/)
    await dm('就这样回')
    assert.equal(groupTexts().length, 2, transcript().join('\n'))
    assert.match(groupTexts()[1], /第 3 页没有数据/)
  })

  it('S5 外部同事的问题执行失败 → 群里只有那句收到，私聊 aven（不发「拿不准」）', async () => {
    const id = await say({ from: ENCONE, text: '头像是哪个接口' })
    await classify(id, { decision: 'question', reply: '收到，我查下头像用的接口，结果回群里' })
    await work(id, { status: 'failed', summary: '执行器超时' })
    assert.equal(groupTexts().length, 1, transcript().join('\n'))
    assert.equal(consoleTexts().length >= 1, true)
  })

  it('S7 外部同事的结论被扣下 → aven 私聊让再测 → 指示任务的新结论发一次，旧草稿作废，群里从头到尾没有兜底话术（10-20 原序列）', async () => {
    const id = await say({ from: ENCONE, text: 'front/lives 更新了，再试试' })
    await classify(id, { decision: 'api_reply', reply: '收到，这就复测，结果发群里' })
    await work(id, { status: 'done', completionClaim: 'all_done', preChecks: PRE_OK, groupReply: '都通了，第 3 页没有数据' }, { changedFiles: ['docs/a.md'] })
    const instructId = await dm('再测一下，看清楚第 3 页')
    assert.equal(store.get(instructId).privateOrigin.anchorId, id, '私聊指示挂在 Encone 那条上')
    await classify(instructId, { decision: 'api_reply', reply: '收到，再测一遍' })
    await work(instructId, { status: 'no_change_needed', preChecks: PRE_OK, groupReply: 'front/lives 复测：都通了\n- ✅ 通了 第 2 页：code 0，第 3 页为空说明到底了' })
    const group = groupTexts()
    assert.equal(group.length, 2, transcript().join('\n'))
    assert.match(group[1], /front\/lives 复测：都通了/)
    assert.doesNotMatch(group.join('\n'), /拿不准/)
    const tasksBefore = store.list().length
    await dm('就这样回')
    assert.equal(groupTexts().length, 2, '旧草稿已作废，不再放出')
    assert.equal(store.list().length, tasksBefore, '不建新的指示任务')
    assert.match(consoleTexts().at(-1), /已经发过更新的结论了，没有待放行的草稿/)
  })

  it('S8 结构化回复：代码渲染第一行，「不再报错」「为空说明到底了」随便写；声称浏览器看过但没跑 → 那项显示待验证（P6）', async () => {
    const id = await say({ from: ENCONE, text: 'front/lives 更新了，再试试' })
    await classify(id, { decision: 'api_reply', deliverable: 'verification', reply: '收到，这就复测，结果发群里' })
    await work(id, {
      status: 'done', groupReply: null, preChecks: PRE_OK,
      report: { subject: 'front/lives 复测', answer: null, items: [
        { mark: 'ok', name: '第 2 页接口', note: '不再报错，第 3 页为空说明到底了', evidence: 'pre' },
        { mark: 'ok', name: '/lives 滚到底续拉', note: '20 张变 25 张', evidence: 'browser' },
      ] },
    }, { changedFiles: [], runEvidence: { probeCalls: 1, browserCalls: 0 } })
    const group = groupTexts()
    assert.equal(group.length, 2, transcript().join('\n'))
    assert.match(group[1], /front\/lives 复测：通了 1 项，没通 1 项\n- ⚠️ 待验证 \/lives 滚到底续拉：20 张变 25 张；这次没实测\n- ✅ 通了 第 2 页接口/)
  })

  it('S9 外部群里没 @bot 的话题回复（「可以了，结单吧」）→ 不结单、不回任何卡片（10-21：控制通道在外部群发了旧样式「请确认」卡）', async () => {
    // 真机序列：话题第一条没 @bot（只记台账 → ignored），后面同一话题里的回复被控制通道当成「对已结束任务结单」
    const id = await say({ from: ENCONE, text: '已贴到新闻头条模块里', mention: false })
    await classify(id, { decision: 'api_reply' })
    assert.equal(store.get(id).status, 'ignored')
    store.recordReceipt(id, { messageId: 'om_golden_receipt', kind: 'ignored', epoch: 0 }) // 控制通道靠回执锚定任务
    const before = sent.length
    await say({ from: ENCONE, text: '好了，这个可以结单了，可以改成真实发送验证码了是不', mention: false, root: 'om_golden_receipt' })
    await say({ from: ENCONE, text: '可以了，结单吧', mention: false, root: 'om_golden_receipt' })
    assert.deepEqual(sent.slice(before), [], transcript().join('\n'))
    assert.notEqual(store.get(id).status, 'superseded', '没 @bot 的话不结单')
  })

  it('S10 旧卡片通道（sendChatMessage）发往外部群 → 一律改发控制台，外部群收不到（10-21：融合群只私聊仍收到旧卡片）', async () => {
    const out = await sendChatMessage({ chatId: GROUP, card: { elements: [{ tag: 'markdown', content: '**任务**：旧卡片' }] }, logPrefix: 'golden legacy' })
    assert.equal(out.ok, true)
    assert.deepEqual(sent.map((item) => item.to), ['console'])
  })

  it('S11 自定义机器人移出群再拉回来（新的 open_id）→ 按名字认出 @Aven.Bot，照常开任务，不用重启（10-21）', async () => {
    const id = `om_golden_${(seq += 1)}`
    await ingestLarkEvent({ raw: { message_id: id, chat_id: GROUP, chat_type: 'group', message_type: 'text', content: '@_user_1 按 Figma 把新闻详情页做出来', sender_type: 'user', sender_id: AVEN,
      mentions: [{ id: 'ou_golden_bot_readded', key: '@_user_1', name: 'Aven.Bot' }], create_time: String(Date.now()) }, config, store })
    assert.equal(store.get(id)?.addressedToBot, true, transcript().join('\n'))
    const other = `om_golden_${(seq += 1)}`
    await ingestLarkEvent({ raw: { message_id: other, chat_id: GROUP, chat_type: 'group', message_type: 'text', content: '@_user_1 看下', sender_type: 'user', sender_id: ENCONE,
      mentions: [{ id: 'ou_someone', key: '@_user_1', name: 'Aven' }], create_time: String(Date.now()) }, config, store })
    assert.notEqual(store.get(other)?.addressedToBot, true, '@ 别人（名字不是 Aven.Bot）不算')
  })

  it('S12 外部同事的疑似单 → aven 私聊单发「继续任务 <id>」（不带补充）就放行开跑（10-21：被当成没补充内容，只回了提示卡）', async () => {
    const id = await say({ from: ENCONE, text: '分享卡片图 picture[0] 是 HCIMG1 密文，按文档 1.10 解密' })
    await classify(id, { decision: 'api_reply', confidence: 'medium', reply: '收到，我看下分享卡片图的解密' })
    assert.equal(store.get(id).status, 'waiting_confirmation')
    assert.equal(store.get(id).suspected, true)
    await dm(`继续任务 ${id}`)
    assert.equal(store.get(id).status, 'queued', transcript().join('\n'))
    assert.doesNotMatch(consoleTexts().join('\n'), /没有可用的补充内容/)
  })

  it('S14 aven 私聊「继续任务 <id> 确认扩大范围」把 id 抄错一位 → 回「找不到任务」并给出改好的整句，原任务不动（10-22 #65：回的是「12 小时内没有任务通知」）', async () => {
    const id = await say({ from: ENCONE, text: '分享卡片图 picture[0] 是 HCIMG1 密文，按文档 1.10 解密' })
    await classify(id, { decision: 'api_reply', confidence: 'medium', reply: '收到，我看下分享卡片图的解密' })
    const typo = `${id.slice(0, -1)}x`
    await dm(`继续任务 ${typo} 确认扩大范围`)
    assert.equal(store.get(id).status, 'waiting_confirmation')
    const last = consoleTexts().at(-1)
    assert.match(last, new RegExp(`找不到任务 ${typo}`), transcript().join('\n'))
    assert.ok(last.includes(`继续任务 ${id} 确认扩大范围`), last)
    assert.doesNotMatch(last, /12 小时内/)
  })

  it('S13 任务带了截图、执行器一张没打开 → 私聊里固定提示「截图没看」（10-21 #62：漏看原型，回头问产品做不做）', async () => {
    const { unopenedImagesNote } = await import('../lib/lark-run-report.mjs')
    const id = await say({ from: AVEN, text: '新的 UI 来了，请同步更新一下' })
    await classify(id, { decision: 'requirement', reply: '收到，按新稿改新闻详情页' })
    const note = unopenedImagesNote({ evidence: { unopenedFiles: ['/a.jpg', '/b.jpg'] }, total: 2 })
    await work(id, { status: 'done', report: { subject: '新闻详情页新稿', answer: null, items: [{ mark: 'not_usable', name: '作者行', note: '还没部署', evidence: 'code' }] } }, { changedFiles: ['src/modules/news/NewsDetailPage.tsx'], ownerNotes: [note] })
    assert.match(consoleTexts().join('\n'), /⚠ 任务带的 2 张截图执行器一张都没打开看/, transcript().join('\n'))
  })

  it('S3b aven 交代的改动没过核验闸 → 执行器写好的回答不丢，私聊里带草稿可放行', async () => {
    const id = await say({ from: AVEN, text: '把预约按钮文案改成「立即预约」' })
    await classify(id, { decision: 'requirement', reply: '收到，我去改预约按钮文案，改完说一声' })
    await work(id, { status: 'done', completionClaim: 'all_done', groupReply: '预约按钮文案改好了：「立即预约」' }, { changedFiles: ['docs/a.md'] })
    assert.equal(groupTexts().length, 1, transcript().join('\n'))
    assert.match(consoleTexts().join('\n'), /预约按钮文案改好了/, '私聊里要带执行器写好的回答草稿')
    assert.match(consoleTexts().join('\n'), /就这样回/)
    await dm('就这样回')
    assert.equal(groupTexts().length, 2, transcript().join('\n'))
    assert.match(groupTexts()[1], /预约按钮文案改好了/)
  })

  it('S3d 复测任务被核验闸拦下（比如顺手动了代码没过规则扫描）→ 改动不提交，但实测结论照发', async () => {
    const id = await say({ from: AVEN, text: '去 pre 上复测一下签到' })
    await classify(id, { decision: 'requirement', reply: '收到，我去 pre 复测签到，测完报结果' })
    const failing = { name: 'code-rules', applies: () => true, check: () => ({ ok: false, status: 'failed', text: '规则扫描 error 1 处', reason: '规则扫描 error 1 处' }) }
    const { verify } = await work(id, { status: 'done', preChecks: PRE_OK, groupReply: '签到复测：都通了\n- ✅ 通了 签到：pre 实测 code 0' }, { changedFiles: ['src/x.ts'], gates: [failing] })
    assert.equal(verify.ok, false)
    assert.equal(store.get(id).change.committed, false)
    assert.equal(groupTexts().length, 2, transcript().join('\n'))
    assert.match(groupTexts()[1], /签到复测/)
  })
})
