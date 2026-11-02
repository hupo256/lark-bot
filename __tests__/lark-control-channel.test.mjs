/**
 * 任务控制通道（lib/lark-control-channel.mjs）走真出口：结单 / 重开 / 续跑补料 / 确认 / 暂停 / 归属不明 的人话回话逐字钉住，
 * 任务落态（closeAsExternallyResolved / reopenClosed / resumeWithSupplement / 疑似追加）与回执 / 发件簿一起核。
 * 出口 sendReply 没有注入口，lark-cli 用假脚本顶替（LARK_CLI_BIN 在 import 前设好，模块加载时读；同 lark-port-batch3.test）：
 * 发出去的话进发件簿（拦下的也记 text），回执登记到任务。运行态整个指到临时目录（LARK_RUNTIME_DIR）。
 * 一个 it，分段跑；每段用自己的群 id（notice 对同一人同主题 2 分钟只发一次，拦下的只进发件簿不登记回执）。
 */
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { runSteps } from './support/steps.mjs'

const dir = mkdtempSync(join(tmpdir(), 'lark-control-'))
const bin = join(dir, 'lark-cli')
const cliLog = join(dir, 'cli.log')
// 假 lark-cli：每次调用记一行参数；发 / 回消息回一个递增的 message_id；拉被引用消息回一条真人原话。
writeFileSync(bin, `#!/bin/sh
printf '%s\\n' "$*" >> "${cliLog}"
n=$(wc -l < "${cliLog}" | tr -d ' ')
case "$*" in
  *+messages-mget*) printf '%s' '{"ok":true,"data":{"messages":[{"message_id":"om_ref","msg_type":"text","content":"原话","sender":{"id":"ou_k","name":"K"},"create_time":"1700000000000"}]}}' ;;
  *) printf '{"ok":true,"data":{"message_id":"om_f%s"}}' "$n" ;;
esac
`)
chmodSync(bin, 0o755)
process.env.LARK_CLI_BIN = bin
process.env.LARK_RUNTIME_DIR = join(dir, 'runtime')
process.env.LARK_OUTBOX_DIR = join(dir, 'outbox')
process.env.LARK_OBLIGATIONS_DIR = join(dir, 'obligations')
const { handleResume, maybeHandleControlChannel, maybeHandleControlDirective } = await import('../lib/lark-control-channel.mjs')
const { fetchReferencedContext } = await import('../lib/lark-cli.mjs')
const { listOutbox } = await import('../lib/lark-outbox.mjs')
const { getObligation, noteAck } = await import('../lib/lark-reply-obligation.mjs')
const { createTaskStore } = await import('../lib/lark-task-store.mjs')

const config = { project: 'PR-9', notifyOpenId: 'ou_aven', chatNames: {} }
const quiet = async (fn) => {
  const spies = ['log', 'warn', 'error'].map((name) => { const original = console[name]; console[name] = () => {}; return () => { console[name] = original } })
  try {
    return await fn()
  } finally {
    for (const restore of spies) restore()
  }
}

describe('任务控制通道（真出口 + 假 lark-cli）', () => {
  let store
  let seq = 0
  const msg = (chatId, text, extra = {}) => ({ messageId: `om_m${++seq}`, chatId, chatType: 'group', senderOpenId: 'ou_qa', text, attachments: [], mentions: [], replyTo: null, replyToDirect: null, threadRootId: null, threadId: null, ...extra })
  const task = (chatId, extra = {}) => store.upsert({ id: `om_t${++seq}`, epoch: 2, chatId, messageId: `om_t${seq}`, operator: 'ou_qa', topic: 'login', summary: '登录页报错', status: 'running', createdAt: '2026-11-01T00:00:00Z', ...extra })
  const said = (chatId) => listOutbox({ chatId }).map((entry) => entry.text)
  const dms = () => listOutbox({ chatId: 'ou_aven' }).map((entry) => entry.text)
  after(() => rmSync(dir, { recursive: true, force: true }))

  it('显式指令 / 回复锚定 → 结单、重开、续跑补料、疑似追加、确认、暂停、归属不明、忽略、放行；回话逐字、落态与回执', () => runSteps([
    ['显式指令：没找到任务 → 回话（结单 / 重开措辞不同）并接管；不是指令 → 不接管、不说话', () => quiet(async () => {
      const chatId = 'oc_d1'
      assert.equal(await maybeHandleControlDirective({ msg: msg(chatId, '取消任务 om_nope'), config, store }), true)
      assert.equal(await maybeHandleControlDirective({ msg: msg(chatId, '重开任务 om_nope', { senderOpenId: 'ou_qb' }), config, store }), true)
      assert.deepEqual(said(chatId), [
        '没找到任务 om_nope，结单不了。看下 id 是不是对的，或者直接 @我 重新说。',
        '没找到任务 om_nope，重开不了。看下 id 是不是对的，或者直接 @我 重新说。',
      ])
      assert.equal(listOutbox({ chatId })[0].taskId, null)
      assert.equal(await maybeHandleControlDirective({ msg: msg(chatId, '随便聊两句'), config, store }), false)
      assert.equal(said(chatId).length, 2)
    })],
    ['显式指令结单：running → superseded（cancelled），回话带标题、回执登记在任务上（代次 / 群）、发件簿带任务与主题；再结一次幂等回「早就结束」；没标题的任务回 id', () => quiet(async () => {
      const chatId = 'oc_d2'
      const t = task(chatId)
      assert.equal(await maybeHandleControlDirective({ msg: msg(chatId, `取消任务 ${t.id}`), config, store }), true)
      const closed = store.get(t.id)
      assert.deepEqual([closed.status, closed.closureReason, closed.epoch, closed.externalResolution.previousStatus, closed.externalResolution.operator], ['superseded', 'cancelled', 3, 'running', 'ou_qa'])
      assert.deepEqual(said(chatId), ['好，「登录页报错」取消了，不再做。'])
      const entry = listOutbox({ chatId })[0]
      assert.deepEqual([entry.taskId, entry.topic, entry.to, entry.phase, entry.gated], [t.id, 'login', 'ou_qa', 'notice', undefined])
      assert.deepEqual(closed.receipts.map((r) => [r.kind, r.epoch, r.chatId]), [['notice', 3, chatId]])
      assert.equal(await maybeHandleControlDirective({ msg: msg(chatId, `取消任务 ${t.id}`, { senderOpenId: 'ou_qb' }), config, store }), true)
      assert.equal(said(chatId)[1], '「登录页报错」早就结束了，不用再结单；这句我没当成新任务。')
      assert.equal(store.get(t.id).epoch, 3, '幂等：不再换代')
      const bare = task(chatId, { summary: null, text: null, topic: null })
      await maybeHandleControlDirective({ msg: msg(chatId, `结单 ${bare.id}`, { senderOpenId: 'ou_qc' }), config, store })
      assert.equal(said(chatId)[2], `好，「${bare.id}」按已经处理掉结了。`)
      assert.deepEqual([store.get(bare.id).status, store.get(bare.id).closureReason], ['superseded', 'completed_elsewhere'])
    })],
    ['显式指令重开：人工结单的任务复活回 queued（带重开补充、附件下载目录按任务项目）、回话 + 私信负责人开跑；不是我结掉的（done）重开不了', () => quiet(async () => {
      const chatId = 'oc_d3'
      const t = task(chatId, { project: 'PR-1' })
      await maybeHandleControlDirective({ msg: msg(chatId, `取消任务 ${t.id}`), config, store })
      const reopenMsg = msg(chatId, `重开任务 ${t.id} 其实还要做`, { senderOpenId: 'ou_qb', attachments: [{ type: 'image', imageKey: 'img_1' }] })
      assert.equal(await maybeHandleControlDirective({ msg: reopenMsg, config, store }), true)
      const reopened = store.get(t.id)
      assert.deepEqual([reopened.status, reopened.epoch, reopened.closureReason, reopened.closureHistory.length, reopened.reopenHistory[0].operator], ['queued', 4, undefined, 1, 'ou_qb'])
      assert.match(reopened.text, /【重开补充】\n其实还要做$/)
      assert.equal(reopened.attachments.length, 1)
      assert.ok(existsSync(join(dir, 'runtime', 'lark-attachments', 'PR-1', reopenMsg.messageId)), '附件按任务自己的项目号落目录')
      assert.equal(existsSync(join(dir, 'runtime', 'lark-attachments', 'PR-9')), false)
      assert.equal(said(chatId)[1], '好，「登录页报错」重开了，接着原来的分支做。')
      assert.deepEqual(dms().at(-1), '🛠 开始做：登录页报错（PR-1）')
      const done = task(chatId, { status: 'done' })
      await maybeHandleControlDirective({ msg: msg(chatId, `重开任务 ${done.id}`, { senderOpenId: 'ou_qc' }), config, store })
      assert.equal(said(chatId)[2], '「登录页报错」现在是「done」，不是我结掉的那种，重开不了；这句没当成新任务。')
      assert.equal(store.get(done.id).status, 'done')
    })],
    ['回复锚定：同话题 ≥2 条活动任务归属不明 → 列出来、接管、不新建；恰好 1 条 → 锚定并提示「还在处理中」；无关话（好的）→ 静默消费；终态 + 新请求 → 放行带锚点', () => quiet(async () => {
      const chatId = 'oc_c1'
      const a = task(chatId, { threadRootId: 'om_root', status: 'queued' })
      const b = task(chatId, { threadRootId: 'om_root', status: 'running', summary: '充值页' })
      assert.deepEqual(await maybeHandleControlChannel({ msg: msg(chatId, '这个也看下', { threadRootId: 'om_root' }), config, store }), { handled: true, anchorTaskId: null })
      assert.equal(said(chatId)[0], `这个话题里有 2 条没结束的任务，我拿不准你说的是哪条，这句先没当成新任务：\n- ${a.id}：登录页报错\n- ${b.id}：充值页\n回「取消任务 <id>」「重开任务 <id>」，或直接回复对应那条。`)
      assert.deepEqual(await maybeHandleControlChannel({ msg: msg(chatId, '这个也看下', { replyTo: 'om_root', senderOpenId: 'ou_qb' }), config, store }), { handled: true, anchorTaskId: null }, '只有话题根（reply_to）也数得出来')
      assert.equal(said(chatId).length, 2)
      store.closeAsExternallyResolved({ id: b.id, operator: 'x', messageId: 'y', closureReason: 'cancelled' })
      assert.deepEqual(await maybeHandleControlChannel({ msg: msg(chatId, '顺便把页脚也改一下', { threadRootId: 'om_root', senderOpenId: 'ou_qc' }), config, store }), { handled: true, anchorTaskId: a.id })
      assert.equal(said(chatId)[2], `「登录页报错」还在处理中，这句我记下了、没当成新任务。要停回「取消任务 ${a.id}」。`)
      assert.equal(store.get(a.id).status, 'queued')
      assert.deepEqual(await maybeHandleControlChannel({ msg: msg(chatId, '好的', { replyToDirect: a.id, senderOpenId: 'ou_qd' }), config, store }), { handled: true, anchorTaskId: a.id })
      assert.equal(said(chatId).length, 3, '纯确认不说话')
      const done = task(chatId, { status: 'done' })
      assert.deepEqual(await maybeHandleControlChannel({ msg: msg(chatId, '再帮我看下注册页白屏', { replyToDirect: done.id, senderOpenId: 'ou_qe' }), config, store }), { handled: false, anchorTaskId: done.id })
      assert.equal(said(chatId).length, 3)
      assert.deepEqual(await maybeHandleControlChannel({ msg: msg(chatId, '新话题'), config, store }), { handled: false, anchorTaskId: null })
    })],
    ['回复锚定：结单（含残余请求）、意图不明去确认（弱信号 / 部分范围措辞不同）、暂停', () => quiet(async () => {
      const chatId = 'oc_c2'
      const t = task(chatId)
      await maybeHandleControlChannel({ msg: msg(chatId, '上个问题已解决，现在这个下拉框还是空的', { replyToDirect: t.id }), config, store })
      assert.deepEqual([store.get(t.id).status, store.get(t.id).closureReason], ['superseded', 'completed_elsewhere'])
      assert.deepEqual(said(chatId), ['好，「登录页报错」按已经处理掉结了。', '「登录页报错」结了。你后半段说的「这个下拉框还是空的」我没单独开任务，要做的话另发一条 @我。'])
      const w = task(chatId, { status: 'waiting_confirmation', summary: '支付页' })
      await maybeHandleControlChannel({ msg: msg(chatId, '收工', { replyToDirect: w.id, senderOpenId: 'ou_qb' }), config, store })
      assert.equal(said(chatId)[2], `这句像是想「取消该任务」，我拿不准，先没动「支付页」。确认结束回「取消任务 ${w.id}」；要继续直接补充说明。`)
      await maybeHandleControlChannel({ msg: msg(chatId, 'A 不用做了，B 继续', { replyToDirect: w.id, senderOpenId: 'ou_qc' }), config, store })
      assert.equal(said(chatId)[3], `你是要结束整个「支付页」，还是只取消其中一部分？整个结束回「取消任务 ${w.id}」；只处理一部分直接补充说明就行。`)
      await maybeHandleControlChannel({ msg: msg(chatId, '先暂停一下', { replyToDirect: w.id, senderOpenId: 'ou_qd' }), config, store })
      assert.equal(said(chatId)[4], `好，「支付页」先搁着，我不动；要取消回「取消任务 ${w.id}」。`)
      assert.equal(store.get(w.id).status, 'waiting_confirmation', '确认 / 暂停都不动任务')
    })],
    ['续跑补料（回复待确认卡）：别人补料 → 回 queued、正文追加、附件按任务项目落目录、回话「收到补充」、私信开跑；已有范围批准不算新放行；负责人补料按原话、不当放行', () => quiet(async () => {
      const chatId = 'oc_r1'
      const t = task(chatId, { status: 'waiting_confirmation', text: '原文', project: 'PR-1', attachments: [{ type: 'image', imageKey: 'k0' }], scopeApprovals: [{ paths: ['old.ts'] }] })
      const supplement = msg(chatId, '补充：用方案 A', { replyToDirect: t.id, attachments: [{ type: 'image', imageKey: 'img_2' }] })
      assert.deepEqual(await maybeHandleControlChannel({ msg: supplement, config, store }), { handled: true, anchorTaskId: t.id })
      const resumed = store.get(t.id)
      assert.deepEqual([resumed.status, resumed.resumeCount, resumed.epoch, resumed.attachments.length, resumed.scopeApprovals.length], ['queued', 1, 3, 2, 1])
      assert.equal(resumed.text, '原文\n\n【补料】\n补充：用方案 A')
      assert.ok(existsSync(join(dir, 'runtime', 'lark-attachments', 'PR-1', supplement.messageId)))
      assert.deepEqual(said(chatId), ['好，收到补充，接着做「登录页报错」。'])
      assert.equal(dms().at(-1), '🛠 接着做（第 1 次续跑）：登录页报错')
      const mine = task(chatId, { status: 'blocked', text: '原文二' })
      await maybeHandleControlChannel({ msg: msg(chatId, '按方案 B', { replyToDirect: mine.id, senderOpenId: 'ou_aven' }), config, store })
      assert.deepEqual([store.get(mine.id).status, store.get(mine.id).text], ['queued', '原文二\n\n【补料】\n按方案 B'])
      assert.equal(said(chatId)[1], '好，收到补充，接着做「登录页报错」。')
    })],
    ['显式「继续任务 <id>」：负责人单发 = 放行；带补充按补充；别人不带补充 → 要材料；不在等材料 / 没这条 → 回话不动；确认扩大范围 → 回话带放行的文件', () => quiet(async () => {
      const chatId = 'oc_r2'
      const resume = (t, supplementText, extra = {}) => handleResume({ msg: msg(chatId, `继续任务 ${t?.id || 'om_zz'} ${supplementText}`.trim(), extra), config, store, resumeDirective: { taskId: t?.id || 'om_zz', supplementText }, parentTask: { taskId: t?.id || 'om_zz', task: t, explicit: true } })
      const a = task(chatId, { status: 'waiting_confirmation', text: '原文' })
      await resume(a, '', { senderOpenId: 'ou_aven' })
      assert.deepEqual([store.get(a.id).status, store.get(a.id).text], ['queued', '原文\n\n【补料】\n负责人放行：按原消息开工'])
      assert.equal(said(chatId)[0], '好，收到补充，接着做「登录页报错」。')
      const b = task(chatId, { status: 'waiting_confirmation', text: '原文二' })
      await resume(b, '做 x', { senderOpenId: 'ou_aven' })
      assert.equal(store.get(b.id).text, '原文二\n\n【补料】\n做 x')
      const c = task(chatId, { status: 'waiting_confirmation', text: '原文三' })
      await resume(c, '', { senderOpenId: 'ou_qb' })
      assert.equal(store.get(c.id).status, 'waiting_confirmation')
      assert.equal(said(chatId)[2], '「登录页报错」还在等材料，但这条没看到可用的补充。回我具体说明或截图就行。')
      const running = task(chatId, { status: 'running' })
      await resume(running, '补一句', { senderOpenId: 'ou_qc' })
      assert.equal(store.get(running.id).status, 'running')
      assert.equal(said(chatId)[3], '「登录页报错」现在是「running」，不在等材料，续不了；要新处理直接 @我 另说。')
      await resume(undefined, '', { senderOpenId: 'ou_qd' })
      assert.equal(said(chatId)[4], '没找到任务 om_zz，续不了。看下 id，或直接 @我 重新发。')
      const scoped = task(chatId, { status: 'waiting_confirmation', text: '名称列', scopeRequest: { paths: ['apps/web/src/a.ts', 'package.json'], overBudget: false, siblingsRequired: false, missingScope: false } })
      await resume(scoped, '确认扩大范围', { senderOpenId: 'ou_qe' })
      assert.deepEqual([store.get(scoped.id).status, store.get(scoped.id).scopeApprovals.length, store.get(scoped.id).scopeRequest], ['queued', 1, null])
      assert.equal(said(chatId)[5], '好，确认可以改 apps/web/src/a.ts、package.json，接着做「登录页报错」。')
    })],
    ['疑似单：别人的补充只追加正文（带时刻、附件保留、记操作人，累计）、任务继续等、回「还得 aven 确认」；负责人放行才开工', () => quiet(async () => {
      const chatId = 'oc_s1'
      const t = task(chatId, { status: 'waiting_confirmation', suspected: true, text: '疑似原文', attachments: [{ type: 'image', imageKey: 'k1' }] })
      await maybeHandleControlChannel({ msg: msg(chatId, '这是补充', { replyToDirect: t.id }), config, store })
      const once = store.get(t.id)
      assert.equal(once.status, 'waiting_confirmation')
      assert.match(once.text, /^疑似原文\n\n【补充 \d{2}:\d{2}，待负责人放行】这是补充$/)
      assert.equal(once.attachments.length, 1)
      assert.deepEqual(once.suspectedSupplements.map((s) => s.operator), ['ou_qa'])
      assert.deepEqual(said(chatId), ['记下了，这条还得 aven 确认一下再做。'])
      await maybeHandleControlChannel({ msg: msg(chatId, '再补一句', { replyToDirect: t.id, senderOpenId: 'ou_qb' }), config, store })
      const twice = store.get(t.id)
      assert.deepEqual(twice.suspectedSupplements.map((s) => s.operator), ['ou_qa', 'ou_qb'])
      assert.match(twice.text, /这是补充\n\n【补充 \d{2}:\d{2}，待负责人放行】再补一句$/)
      assert.equal(twice.status, 'waiting_confirmation')
      await handleResume({ msg: msg(chatId, `继续任务 ${t.id}`, { senderOpenId: 'ou_aven' }), config, store, resumeDirective: { taskId: t.id, supplementText: '' }, parentTask: { taskId: t.id, task: store.get(t.id), explicit: true } })
      assert.deepEqual([store.get(t.id).status, store.get(t.id).resumeCount], ['queued', 1])
      assert.match(store.get(t.id).text, /【补料】\n负责人放行：按原消息开工$/)
    })],
    ['假 lark-cli 顺带钉两处无注入口的 IO：拉被引用消息带发送人；回复义务没指定目录时落在运行态目录（不是只在内存）', async () => {
      assert.deepEqual(await fetchReferencedContext('om_ref'), { text: '原话', attachments: [], sender: 'K', senderOpenId: 'ou_k', createTime: '1700000000000' })
      assert.equal(await fetchReferencedContext(''), null)
      delete process.env.LARK_OBLIGATIONS_DIR
      try {
        const t = { id: 'om_ob', chatId: 'oc_ob', operator: 'ou_u' }
        noteAck({ task: t, text: '收到' })
        assert.ok(existsSync(join(dir, 'runtime', 'lark-obligations', 'oc_ob.json')))
        assert.equal(getObligation(t).state, 'acked')
      } finally {
        process.env.LARK_OBLIGATIONS_DIR = join(dir, 'obligations')
      }
    }],
  ], {
    before: () => {
      store = createTaskStore({ tasksDir: join(dir, 'tasks') })
    },
  }))
})
