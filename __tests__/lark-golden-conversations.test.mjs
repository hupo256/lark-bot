/**
 * 黄金对话（10-21 架构加固 P1）：把真实出过事的群对话从头到尾重放一遍——消息进 ingest → 桩分类走真实 /intake 路由 →
 * 桩执行器结果过真实核验闸（采证据那道换成桩）→ 真实 /status 回写与投递 → 断言群里 / 控制台收到的完整消息序列。
 * 单函数测试测不出补丁之间的交互（10-20 #56→#57→#58 连环），这里测的是「整条链路对人说了什么」。
 * 按新口径还没做到的场景标 todo（注明哪个阶段转绿），做到了就去掉 todo。
 * 不碰网络 / git / 模型：lark-cli 换成假程序，webhook 走 fetch 桩，运行态整个指到临时目录。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const { expectsCodeChange, resolveWorkKind } = await import('../lib/lark-work-policy.mjs')
const { assembleRunReport } = await import('../lib/lark-run-report.mjs')
const { sweepPendingAcks, DEFAULT_ACK_TIMEOUT_MS } = await import('../lib/lark-repo-intake.mjs')
const { isReadOnlyTask } = await import('../lib/lark-message.mjs')
const { resolveSchemaVerifyGate } = await import('../lib/lark-schema-verify.mjs')
const { repoProfileForTask, repoProfile } = await import('../lib/lark-repo-profile.mjs')
const { loadLedger, saveLedger } = await import('../lib/lark-ledger.mjs')
const { runGroupReplyPass } = await import('../lib/lark-group-reply-pass.mjs')

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
// replyPass：群里答应过下文、结果没写群回复时，runner 续会话补写那一趟的桩结果（null = 补写没成，#79）。
const work = async (id, aiResult, { changedFiles = [], gates = null, runEvidence = null, ownerNotes = [], scope = null, schemaDiff = null, numstat = '', replyPass = null } = {}) => {
  const task = claim(id)
  const evidence = { name: 'evidence', applies: () => true, check: (ctx) => { ctx.evidence.changedFiles = changedFiles; ctx.evidence.numstat = numstat; ctx.outputs.actualChangedFiles = changedFiles; return { ok: true } } }
  const realGates = gates || VERIFY_GATES.filter((gate) => ['done.trust'].includes(gate.name))
  const workContext = { readOnly: isReadOnlyTask(task), cwd: PROFILE.root }
  let result = { checks: [], changedFiles, summary: '', ...aiResult }
  // 与 runner 同一个纯函数：AI 跑完、进核验闸之前补写群回复（#79）
  const aiRun = { result, sessionId: 'golden-session', executor: 'claude' }
  if (await runGroupReplyPass({ task, aiRun, exec: async () => ({ result: replyPass }) })) result = aiRun.result
  const verify = ['done', 'done_with_warnings'].includes(result.status)
    ? await runVerifyGates({ task, workContext, aiRun: { result, scope }, workerConfig: { localConfig: {} }, expectsCode: expectsCodeChange({ task, readOnly: workContext.readOnly }), gates: [evidence, ...realGates] })
    : null
  const report = assembleRunReport({ aiResult: result, verify, resultText: [result.summary || '已完成。', ...(verify?.warnNotes?.length ? [`⚠ ${verify.warnNotes.join('；')}`] : [])].join('\n'), actualChangedFiles: changedFiles, evidence: runEvidence, ownerNotes })
  // 接口实测闸：与 runner 收尾同一个纯函数，diff 由场景给（#66）
  const schemaGate = schemaDiff != null && report.status === 'done' ? resolveSchemaVerifyGate({ verify: repoProfileForTask(task)?.verify, changedFiles, preChecks: result.preChecks, taskId: id, readDiff: () => schemaDiff }) : null
  // 没测通（runner 已补测过一轮）：照常交付，结论带一句原因（aven 2026-10-22）
  if (schemaGate?.unverified) report.result = `${report.result}\n${schemaGate.note}`
  else if (schemaGate?.status) Object.assign(report, { status: schemaGate.status, result: `${report.result}\n${schemaGate.note}`, extras: { ...report.extras, change: schemaGate.change } })
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
  delete process.env.LARK_GOLDEN_CHAT_FILE
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
    await classify(id, { decision: 'api_reply', deliverable: 'verification', reply: '收到，front/lives 已更新，这就复测第 2 页，结果发群里' })
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
    await classify(id, { decision: 'api_reply', deliverable: 'verification', reply: '收到，这就复测，结果发群里' })
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
    await classify(id, { decision: 'api_reply', deliverable: 'verification', reply: '收到，这就复测，结果发群里' })
    await work(id, { status: 'done', completionClaim: 'all_done', preChecks: PRE_OK, groupReply: '都通了，第 3 页没有数据' }, { changedFiles: ['docs/a.md'] })
    const instructId = await dm('再测一下，看清楚第 3 页')
    assert.equal(store.get(instructId).privateOrigin.anchorId, id, '私聊指示挂在 Encone 那条上')
    await classify(instructId, { decision: 'api_reply', deliverable: 'verification', reply: '收到，再测一遍' })
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

  it('S9 外部群里没 @bot 的消息（主楼 + 话题里「可以了，结单吧」）→ 不建任务、不分类、不回任何话（10-23 起外部群只响应 @bot）', async () => {
    const before = sent.length
    const id = await say({ from: ENCONE, text: '已贴到新闻头条模块里', mention: false })
    await say({ from: ENCONE, text: '好了，这个可以结单了，可以改成真实发送验证码了是不', mention: false, root: id })
    await say({ from: AVEN, text: '可以了，结单吧', mention: false, root: id })
    assert.equal(store.get(id), undefined, '没 @bot 不建任务')
    assert.equal(store.list().filter((task) => task.chatId === GROUP && !task.addressedToBot).length, 0, transcript().join('\n'))
    assert.deepEqual(sent.slice(before), [], transcript().join('\n'))
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
    await classify(id, { decision: 'api_reply', confidence: 'medium', forMe: null, deliverable: 'change', reply: '收到，我看下分享卡片图的解密' })
    assert.equal(store.get(id).status, 'waiting_confirmation')
    assert.equal(store.get(id).suspected, true)
    await dm(`继续任务 ${id}`)
    assert.equal(store.get(id).status, 'queued', transcript().join('\n'))
    assert.doesNotMatch(consoleTexts().join('\n'), /没有可用的补充内容/)
  })

  it('S14 aven 私聊「继续任务 <id> 确认扩大范围」把 id 抄错一位 → 回「找不到任务」并给出改好的整句，原任务不动（10-22 #65：回的是「12 小时内没有任务通知」）', async () => {
    const id = await say({ from: ENCONE, text: '分享卡片图 picture[0] 是 HCIMG1 密文，按文档 1.10 解密' })
    await classify(id, { decision: 'api_reply', confidence: 'medium', forMe: null, deliverable: 'change', reply: '收到，我看下分享卡片图的解密' })
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

  it('S15 只删几个响应字段（schema / mapper / 页面 / 文案 / mock / 对接文档）+ pre 连不上 → 照常交付、改动提交，不挂「接口没实测」，改过的中文路径对接文档不报疑似漏改（10-22 #66 #67）', async () => {
    registerRepoProfiles({ repos: { falive: { ...PROFILE, docIntakeDir: 'docs/delivery/pending' } } })
    const id = await say({ from: AVEN, text: '新闻详情页照 x9 收口，签名、阅读、评论不显示' })
    await classify(id, { decision: 'requirement', reply: '收到，照 x9 收口新闻详情页' })
    const doc = 'docs/delivery/pending/新闻详情页-待确认-2026-10-21.md'
    const changedFiles = ['src/modules/news/NewsDetailPage.tsx', 'src/modules/news/data/mappers.ts', 'src/modules/news/data/schema.ts', 'src/modules/news/data/mock.ts', doc]
    const scope = { targets: changedFiles.slice(0, 4).map((path) => ({ path, symbols: [], reason: '收口' })), siblings: { searchQueries: [], items: [{ path: doc, include: true, reason: '追加答复' }] } }
    const schemaDiff = 'diff --git a/src/modules/news/data/schema.ts b/src/modules/news/data/schema.ts\n--- a/src/modules/news/data/schema.ts\n+++ b/src/modules/news/data/schema.ts\n@@ -22 +22 @@\n-  /** 发布人头像 / 签名 / 阅读数 / 评论数 */\n+  /** 发布人头像（同 x9） */\n@@ -105,3 +101,0 @@\n-      signature: z.string().nullish(),\n-      click: z.number().nullish(),\n-      comment_count: z.number().nullish(),'
    const preChecks = [{ endpoint: '/api/Headlines/getInfo', outcome: 'UNREACHABLE：pre 连不上', kind: 'unreachable' }]
    const gates = VERIFY_GATES.filter((gate) => ['done.trust', 'scope'].includes(gate.name))
    const { report } = await work(id, { status: 'done', preChecks, checks: ['pnpm exec tsc --noEmit 通过', 'vitest run 通过'], summary: '新闻详情页已照 x9 收口，接口没改' }, { changedFiles, gates, scope, schemaDiff })
    assert.equal(report.status, 'done', report.result)
    assert.equal(store.get(id).status, 'done')
    assert.equal(store.get(id).change?.committed, true)
    const all = transcript().join('\n')
    assert.doesNotMatch(all, /实测通过|重跑并实测/, all)
    assert.doesNotMatch(all, /兄弟位置实测未改/, all)
    // 同一形状换成真改了请求 + pre 连不上 → 也照常交付、改动提交（没验证不是待确认的理由，aven 2026-10-22），结论如实说改了哪、为什么没测
    const id2 = await say({ from: AVEN, text: '新闻详情换成 getDetail 接口' })
    await classify(id2, { decision: 'requirement', reply: '收到' })
    const queriesDiff = 'diff --git a/src/modules/news/data/queries.ts b/src/modules/news/data/queries.ts\n--- a/src/modules/news/data/queries.ts\n+++ b/src/modules/news/data/queries.ts\n@@ -70 +70 @@\n-        request("x9", "/api/Headlines/getInfo", { id }),\n+        request("x9", "/api/Headlines/getDetail", { id }),'
    const r2 = await work(id2, { status: 'done', preChecks, summary: '换好了' }, { changedFiles: ['src/modules/news/data/queries.ts'], schemaDiff: queriesDiff })
    assert.equal(store.get(id2).status, 'done', r2.report.result)
    assert.equal(store.get(id2).change?.committed, true)
    assert.match(store.get(id2).result, /改了对后端的请求（src\/modules\/news\/data\/queries\.ts/)
    assert.match(store.get(id2).result, /pre 连不上.*代码照常提交/)
  })

  // ── 10-23 真机：bot 向 Encone 要主播号，第二天他给了，bot 没接上；群里先下结论、私聊又问（#74 / #77）──────────────
  const HOURS = 60 * 60_000
  // 把「昨天」挪到 20 小时前：任务、发件簿都出「正在进行的事」的 2 小时窗口——能接上只靠「群里这条之前的消息」和台账。
  const ageEverything = (ids, ms) => {
    for (const id of ids) store.upsert({ ...store.get(id), createdAt: new Date(Date.now() - ms).toISOString() })
    const file = join(process.env.LARK_OUTBOX_DIR, `${GROUP}.jsonl`)
    if (!existsSync(file)) return
    const shifted = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)).map((entry) => ({ ...entry, at: new Date(Date.parse(entry.at) - ms).toISOString() }))
    writeFileSync(file, `${shifted.map((entry) => JSON.stringify(entry)).join('\n')}\n`)
  }
  // 群里的历史消息（假 lark-cli 按 --end 回给 fetchRecentChatContext）
  const chatHistory = (messages) => {
    const file = join(dir, 'chat.json')
    writeFileSync(file, JSON.stringify(messages))
    process.env.LARK_GOLDEN_CHAT_FILE = file
  }
  const botCard = (id, text, atMs) => ({ message_id: id, msg_type: 'text', create_time: String(atMs), sender: { sender_type: 'app', open_bot_id: BOT, name: 'Aven.Bot' }, content: JSON.stringify({ text }) })

  it('S16 bot 结果里 @Encone 要主播号；20 小时后他 @bot 说「已经将 uid 508 设成主播」→ 上下文里有那张卡、有他提的台账条目，接回源工单开跑，先行回复接住他这句（10-23 #74 / #77）', async () => {
    const src = await say({ from: ENCONE, text: 'intro 接口上线了：createRoom / updateLive 加了可选参数 intro，getRoomInfo 返回 info.intro' })
    await classify(src, { decision: 'api_reply', deliverable: 'change', reply: '收到 intro 接口变更说明，开播表单加介绍输入框这就接上',
      items: [{ id: 'new', transition: 'new', note: 'Bug-4944 直播间介绍 intro' }] })
    await work(src, {
      status: 'done', preChecks: PRE_OK,
      report: { subject: '直播间介绍 intro 对接', answer: null, items: [
        { mark: 'ok', name: '直播间页介绍卡改读 intro', note: 'pre 上 getRoomInfo 已返回 intro', evidence: 'pre' },
        { mark: 'not_usable', name: '开播设置加直播间介绍', note: '代码已接好；测试号不是主播，开播写入测不了', evidence: 'pre' },
      ] },
      followUps: [{ owner: 'Encone', items: ['给一个 pre 主播测试号（或把 uid 508 设成主播），用来实测开播设置里直播间介绍的写入、回填和展示'] }],
    }, { changedFiles: ['src/modules/live/data/schema.ts', 'src/modules/live/components/Stream/StreamSettingsForm.tsx'], runEvidence: { probeCalls: 1, browserCalls: 0 } })
    const card = groupTexts().at(-1)
    assert.match(card, /主播测试号/, '结果里向 Encone 要了主播号')
    const itemId = store.get(src).ledgerItems[0].id
    ageEverything([src], 20 * HOURS)
    chatHistory([botCard('om_golden_card', card, Date.now() - 20 * HOURS)])

    const before = sent.length
    const id = await say({ from: ENCONE, text: '已经将uid 508 设成主播' })
    const text = store.get(id).text
    assert.match(text, /【群里这条之前的消息】\nAven\.Bot（bot，我们自己）（\d\d-\d\d \d\d:\d\d）：[\s\S]*主播测试号/, text)
    assert.ok(text.includes(`台账 ${itemId}（applied）`) && text.includes(`工单 ${src}`), `他提的条目被 bot 推进后仍在他的上下文里，带着工单 id：\n${text}`)
    assert.doesNotMatch(text, /id=om_golden/, '昨天的任务确实出了 2 小时窗口')
    await classify(id, { decision: 'api_reply', confidence: 'medium', deliverable: 'verification', continues: src,
      items: [{ id: itemId, transition: 'answer', note: '508 已设成主播' }], reply: '好的感谢，我继续实测后面的逻辑' })
    const task = store.get(id)
    assert.equal(task.status, 'queued', transcript().join('\n'))
    assert.equal(task.continues, src)
    assert.equal(task.topic, itemId, '同一条目的工单')
    assert.doesNotMatch(consoleTexts().join('\n'), /可能是你的事/, '判得出是我的事：不私聊问')
    await work(id, {
      status: 'done', preChecks: PRE_OK,
      report: { subject: '开播写入直播间介绍', answer: null, items: [{ mark: 'ok', name: '开播设置写入 / 回填 / 展示 intro', note: 'pre 用 508 开播，intro 写入、回填、直播间页展示都对', evidence: 'pre' }] },
    }, { changedFiles: [], runEvidence: { probeCalls: 1, browserCalls: 0 } })
    const group = sent.slice(before).filter((item) => item.to === 'group').map((item) => item.text)
    assert.equal(group.length, 2, transcript().join('\n'))
    assert.match(group[0], /好的感谢，我继续实测后面的逻辑/)
    assert.match(group[1], /开播写入直播间介绍/)
  })

  it('S17 外部同事的通知（forMe、medium、前端不用做）→ 只记台账 + 群里一句、直接结单；不私聊、不开 worktree、契约不算改代码；要改代码的 forMe medium 直接开跑（10-23 #74）', async () => {
    const id = await say({ from: ENCONE, text: '现在pre 还不能发帖、评论' })
    await classify(id, { decision: 'api_reply', confidence: 'medium', forMe: true, deliverable: null,
      summary: 'Encone 说 pre 上 web 还不能发帖、评论', reply: '好的，web 端发帖、评论这块我记下了',
      items: [{ id: 'new', transition: 'notify', note: 'pre 上 web 还不能发帖、评论' }] })
    const task = store.get(id)
    assert.equal(task.status, 'ignored', transcript().join('\n'))
    assert.equal(task.recordOnly, true)
    assert.equal(task.contract.expectsCode, false, '没要做的事：契约不算改代码')
    assert.deepEqual(consoleTexts(), [], '不私聊负责人')
    assert.deepEqual(groupTexts().map((text) => text.replace(/^<at [^>]+><\/at> /, '')), ['好的，web 端发帖、评论这块我记下了。'])
    assert.ok(Object.values(loadLedger('falive').items).some((item) => item.lastEvent?.messageId === id), '台账记了')

    const id2 = await say({ from: ENCONE, text: '直播间介绍超长会报 LIVE_ROOM_INTRO_TOO_LONG，前端提示一下' })
    await classify(id2, { decision: 'api_reply', confidence: 'medium', forMe: true, deliverable: 'change', reply: '好的，开播表单加超长提示' })
    assert.equal(store.get(id2).status, 'queued', transcript().join('\n'))
    assert.doesNotMatch(consoleTexts().join('\n'), /可能是你的事/)
  })

  it('S18 归属拿不准（forMe 未给、medium）才挂疑似私聊负责人；@bot 的纯通知判得出是我的事（forMe=true、ignore）→ 群里一句，不私聊（10-23 #74）', async () => {
    const id = await say({ from: ENCONE, text: '首页那个按钮是不是有点问题' })
    await classify(id, { decision: 'bug', confidence: 'medium', forMe: null, reply: '好的，我看下首页那个按钮' })
    assert.equal(store.get(id).status, 'waiting_confirmation')
    assert.equal(groupTexts().length, 1, transcript().join('\n'))
    assert.match(consoleTexts().join('\n'), /可能是你的事/)

    const before = sent.length
    const id2 = await say({ from: ENCONE, text: '今晚 pre 发版，21 点前别测' })
    await classify(id2, { decision: 'ignore', confidence: 'high', forMe: true, reply: '好的，21 点后再测',
      items: [{ id: 'new', transition: 'notify', note: '今晚 pre 发版' }] })
    assert.deepEqual(sent.slice(before).map((item) => item.to), ['group'], transcript().join('\n'))
  })

  it('S19 aven @bot 交办「社区发帖、评论从 x9 迁过来，api 已 ready」+ 带对接文档 → 按新需求的行数上限核对，不套缺陷修复的 200 行（10-23 #78）', async () => {
    registerRepoProfiles({ repos: { falive: { ...PROFILE, scopeBudgets: { bugfix: 200, qa_feedback: 300, requirement: 1200 } } } })
    const id = await say({ from: AVEN, text: '社区还有 发帖、评论 两个功能没有从 x9 项目迁移过来。现在要完成这两个功能的迁移，api 已经 ready 了，如上。' })
    store.upsert({ ...store.get(id), attachments: [{ type: 'file', fileName: 'PM-2954-App对接文档.md' }] })
    await classify(id, { decision: 'requirement', deliverable: 'change', reply: '收到，按 PM-2954 把 x9 的发帖、评论迁到 web' })
    const task = store.get(id)
    assert.deepEqual([task.commandType, task.contract.deliverable], ['api', 'doc_intake'], '带对接文档：网关补 api、契约按文档入库（真机取值链）')
    assert.equal(resolveWorkKind(task), 'requirement', '分类器判的新需求不因网关补的 api 变成缺陷修复')
    const files = ['src/modules/square/data/schema.ts', 'src/modules/square/data/mutations.ts', 'src/modules/square/PublishPage.tsx']
    const { verify } = await work(id, { status: 'done', completionClaim: 'all_done', preChecks: PRE_OK, summary: '发帖、评论迁移完成' }, {
      changedFiles: files,
      scope: { targets: files.map((path) => ({ path, reason: '发帖 / 评论迁移' })), siblings: { searchQueries: [], items: [] } },
      numstat: files.map((path) => `300\t0\t${path}`).join('\n'),
      gates: VERIFY_GATES.filter((gate) => ['done.trust', 'scope'].includes(gate.name)),
    })
    assert.equal(verify.ok, true, `核验闸拦下：${verify.reason}\n${transcript().join('\n')}`)
    assert.equal(verify.outputs.scopeGate.check.lineLimit, 1200, '上限取新需求的 1200')
    assert.doesNotMatch(transcript().join('\n'), /缺陷修复上限/)
  })

  // aven 2026-10-23 亲自确认：我本人交办的任务不设行数上限（#78）；别人发起的新需求仍按上限核对。
  for (const [label, from, expectOk] of [['S20 aven 本人交办', AVEN, true], ['S21 Encone 发起', ENCONE, false]]) {
    it(`${label}的新需求改动 1553 行 → ${expectOk ? '不拦' : '仍按 1200 上限拦'}（10-23 #78）`, async () => {
      registerRepoProfiles({ repos: { falive: { ...PROFILE, scopeBudgets: { bugfix: 200, qa_feedback: 300, requirement: 1200 } } } })
      const id = await say({ from, text: '社区还有 发帖、评论 两个功能没有从 x9 项目迁移过来，现在要完成迁移。' })
      await classify(id, { decision: 'requirement', confidence: 'high', forMe: true, deliverable: 'change', reply: '好的，我把发帖、评论迁过来' })
      const files = ['src/modules/square/data/schema.ts', 'src/modules/square/PublishPage.tsx']
      const { verify } = await work(id, { status: 'done', completionClaim: 'all_done', preChecks: PRE_OK, summary: '发帖、评论迁移完成' }, {
        changedFiles: files,
        scope: { targets: files.map((path) => ({ path, reason: '发帖 / 评论迁移' })), siblings: { searchQueries: [], items: [] } },
        numstat: `1000\t0\t${files[0]}\n553\t0\t${files[1]}`,
        gates: VERIFY_GATES.filter((gate) => ['done.trust', 'scope'].includes(gate.name)),
      })
      assert.equal(verify.ok, expectOk, `${verify.reason || ''}\n${transcript().join('\n')}`)
      assert.equal(Boolean(verify.outputs?.scopeGate?.check?.overBudget), !expectOk)
    })
  }

  // ── 10-23 14:06 真机：Encone 只发截图「我测试API 开播正常，但是界面web 开播 500」（#79 / #80）──────────────
  const fileMsg = (id, name, from, atMs) => ({ message_id: id, msg_type: 'file', create_time: String(atMs), sender: { id: from.id, sender_type: 'user', name: from.name }, content: JSON.stringify({ file_key: `fk_${id}`, file_name: name }) })
  const textMsg = (id, text, from, atMs) => ({ message_id: id, msg_type: 'text', create_time: String(atMs), sender: { id: from.id, sender_type: 'user', name: from.name }, content: JSON.stringify({ text }) })
  const ARTHUR = { id: 'ou_golden_arthur', name: 'Arthur.a' }
  const STONE = { id: 'ou_golden_stone', name: 'HTStone.z' }
  const MIN = 60_000
  const createRoomResult = (extra = {}) => ({
    // 真机是 done + 只改了对接文档（契约被 #80 判成文档入库才过了 done.trust）；按正确契约，这是「测试环境版本旧、代码已修」
    status: 'no_change_needed', noChangeReason: 'env_version', groupReply: null, report: null, preChecks: PRE_OK,
    summary: 'Encone 看到的 web 开播失败不是 lang、intro、tag_ids 引起的。OPS pre 上跑的还是 407 修复之前的旧前端，它把 tag_ids 数组拼进了签名串，后端回 407 验签失败。修复（5df6b03、ba493a9）已在 feature/phase-4-api 上，还没合进 pre；分支 lark/falive-78f6c6cc。',
    ...extra,
  })

  it('S22 群里回过「…查完回你」、执行器没写群回复 → 续会话补写一段人话发群；私聊如实说群里回了什么，不再说「不会再补话」（10-23 #79）', async () => {
    const id = await say({ from: ENCONE, text: '我测试API 开播正常，但是界面web 开播 500' })
    await classify(id, { decision: 'bug', deliverable: 'change', reply: '收到截图，我对比下 web 发出的 createRoom 和你直接调的参数差在哪，查完回你' })
    await work(id, createRoomResult(), {
      replyPass: { groupReply: '查到了：web 开播 500 是 pre 上的前端还是旧版本，签名把 tag_ids 算进去了，后端验签不过；前端已经修好，等 pre 更新后你再点一次开播就行，后端不用改。' },
    })
    const group = groupTexts()
    assert.equal(group.length, 2, transcript().join('\n'))
    assert.match(group[0], /查完回你/)
    assert.match(group[1], /旧版本/)
    assert.doesNotMatch(group[1], /5df6b03|lark\/falive|feature\//, '群里不贴提交号 / 分支名')
    assert.doesNotMatch(consoleTexts().join('\n'), /不会再补话|这条没写群回复/)
    assert.match(consoleTexts().join('\n'), /群里已回：「/)
  })

  it('S22b 补写也没成 → 结论人话化作草稿私聊负责人，回「就这样回」发群；群里不会只剩那句收到（10-23 #79）', async () => {
    const id = await say({ from: ENCONE, text: '我测试API 开播正常，但是界面web 开播 500' })
    await classify(id, { decision: 'bug', deliverable: 'change', reply: '收到截图，我对比下 web 发出的 createRoom 和你直接调的参数差在哪，查完回你' })
    await work(id, createRoomResult(), { replyPass: null })
    assert.equal(groupTexts().length, 1, transcript().join('\n'))
    const note = consoleTexts().join('\n')
    assert.match(note, /执行器没写群回复，补写也没成[\s\S]*就这样回[\s\S]*旧前端/, note)
    assert.doesNotMatch(note, /不会再补话/)
    await dm('就这样回')
    assert.equal(groupTexts().length, 2, transcript().join('\n'))
    assert.match(groupTexts()[1], /旧前端/)
  })

  it('S23 @bot 只发截图，群里一小时前 Arthur 发过不相干的对接文档 → 文档只留在上下文文字里，不并成本条附件，契约不判文档入库（10-23 #80）', async () => {
    const now = Date.now()
    chatHistory([
      fileMsg('om_golden_avatar_doc', '修改头像接口文档.md', ARTHUR, now - 60 * MIN),
      textMsg('om_golden_avatar_txt', '修改头像的接口文档 @Aven.tong', ARTHUR, now - 60 * MIN + 1000),
      textMsg('om_golden_stone', '你進的是機器人直播間，有時長是對的', STONE, now - 20 * MIN),
    ])
    const id = await say({ from: ENCONE, text: '我测试API 开播正常，但是界面web 开播 500' })
    const task = store.get(id)
    assert.match(task.text, /（发了文件：修改头像接口文档\.md）/, '上下文里看得到有人发过这份文档')
    assert.deepEqual((task.attachments || []).filter((item) => item.type === 'file'), [], '不并成本条附件')
    await classify(id, { decision: 'bug', deliverable: 'change', reply: '收到截图，我对比下 web 发出的 createRoom 和你直接调的参数差在哪，查完回你' })
    assert.deepEqual([store.get(id).contract.deliverable, store.get(id).contract.source], ['change', 'classifier'])
  })

  it('S23b 同一人发完文档紧接着 @bot、或原话说「上面那份文档」→ 照常并入，按文档入库（#54 不回退）', async () => {
    const now = Date.now()
    chatHistory([fileMsg('om_golden_enc_doc', 'intro 对接.md', { id: ENCONE, name: 'HQUCEncone' }, now - 2 * MIN)])
    const id = await say({ from: ENCONE, text: '看下' })
    assert.deepEqual(store.get(id).attachments.filter((item) => item.type === 'file').map((item) => item.fileName), ['intro 对接.md'])
    chatHistory([
      fileMsg('om_golden_avatar_doc2', '修改头像接口文档.md', ARTHUR, now - 60 * MIN),
      textMsg('om_golden_stone2', '你進的是機器人直播間', STONE, now - 20 * MIN),
    ])
    const id2 = await say({ from: AVEN, text: '把上面 Arthur 发的头像接口文档接一下' })
    assert.deepEqual(store.get(id2).attachments.filter((item) => item.type === 'file').map((item) => item.fileName), ['修改头像接口文档.md'])
  })

  it('S24 bot 在群里答应「部署完我再测一遍告诉你」，pre 由 MR 合入后部署（bot 没推过）→ 自动建复测挂在原群，结论对原来的人回；同一次部署不重复建（10-23 #84）', async () => {
    const { checkDeployAndRetest } = await import('../lib/lark-deploy-watch.mjs')
    const runtimeDir = join(dir, 'state')
    const profile = { ...repoProfile('falive'), dailyReport: { sweep: { preSiteUrl: 'https://pre.example/', timeoutMs: 60 * MIN, effort: 'high' } } }
    const git = async (_cwd, args) => {
      const cmd = args.join(' ')
      if (cmd.startsWith('rev-list')) return { ok: true, stdout: deployed ? 'h2\n' : 'h1\n', stderr: '' }
      if (cmd.startsWith('log')) return { ok: true, stdout: '5df6b03 fix(live): 开播设置提交 407——JSON body 的数组不进验签串\n', stderr: '' }
      return { ok: true, stdout: '', stderr: '' }
    }
    let deployed = false
    let buildTime = Date.now() - 60 * MIN
    const check = (now = new Date()) => checkDeployAndRetest({ store, profile, now, deps: { runtimeDir, git, probePreBuildTime: async () => buildTime } })
    // bot 第一次启动：只记基线，不建复测（不会对上线前的旧承诺补测）
    assert.equal((await check()).baseline, true)
    assert.equal(store.list().filter((task) => task.id.startsWith('retest-')).length, 0)

    const id = await say({ from: ENCONE, text: 'web 开播点提交弹「请求失败」' })
    await classify(id, { decision: 'bug', deliverable: 'change', reply: '收到，我对比下 web 提交的参数，查完回你' })
    await work(id, createRoomResult(), { replyPass: { groupReply: '查到了：pre 上的 web 还是旧版本，开播提交时把 tag_ids 也算进了签名，后端验签不过（407）。修复已经在开发分支上，合进 pre 部署后就好，部署完我再测一遍告诉你。' } })
    assert.equal(groupTexts().length, 2, transcript().join('\n'))

    // 开发分支走 GitLab MR 合进 pre、运维部署：bot 没推过 pre，照样认出这次部署
    deployed = true
    buildTime = Date.now() + 1000
    const out = await check(new Date(Date.now() + 5 * MIN))
    assert.equal(out.deployed, true)
    assert.equal(out.promiseTaskIds.length, 1, JSON.stringify(out))
    const retest = store.get(out.promiseTaskIds[0])
    assert.deepEqual([retest.chatId, retest.operator, retest.ackedInGroup], [GROUP, ENCONE, true], '挂在原群、对着原来的人')
    assert.match(retest.text, /部署完我再测一遍告诉你/)
    assert.match(retest.text, new RegExp(id))
    assert.match(retest.text, /5df6b03/)
    assert.ok(out.taskId && store.get(out.taskId).chatId === CONSOLE, '按提交的整体复测仍只私信负责人')

    await work(retest.id, {
      status: 'done', completionClaim: 'all_done', preChecks: PRE_OK,
      groupReply: 'pre 已经更新，我刚在 pre 上重新提交了开播设置：通过，不再弹「请求失败」，你那边再点一次就行。',
    })
    const group = groupTexts()
    assert.equal(group.length, 3, transcript().join('\n'))
    assert.match(group[2], new RegExp(`<at id=${ENCONE}></at>[\\s\\S]*不再弹「请求失败」`))

    // 同一次部署再探一次 / 下一次部署：承诺已接过，不再建
    assert.equal((await check(new Date(Date.now() + 10 * MIN))).deployed, false)
    buildTime += 60 * MIN
    assert.deepEqual((await check(new Date(Date.now() + 70 * MIN))).promiseTaskIds, [])
  })
})
