/**
 * 摄入链路（lib/lark-ingest.mjs）+ 上下文包（lib/lark-conversation-bundle.mjs）+ 入群事件（lib/lark-project-chat-sync.mjs），
 * 给变异扫描补齐：每个 `||` / `&&` / `===` 都有翻转行（aven 11-02）。
 *   · ingestLarkEvent 走真 store（临时目录）+ 假 lark-cli（拉引用消息 / 群列表 / 发消息都即时返回，不睡不等网）；
 *   · buildConversationBundle 注入四个拉取桩，钉文本块版式、附件来源标记、更早的文档规则、拉取失败退空；
 *   · parseBotAddedEvent / handleBotAddedEvent 用 send / sync / log 桩。
 * 一个 it，runSteps 分段；LARK_* 环境在 import 前设好（lark-cli / lark-paths 模块加载时读）。
 */
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { eachCase, runSteps } from './support/steps.mjs'

const dir = mkdtempSync(join(tmpdir(), 'lark-ingest-flow-'))
const bin = join(dir, 'lark-cli')
const cliLog = join(dir, 'cli.log')
// 假 lark-cli：记参数；拉引用消息回一条真人原话（带发送人 / 时间）；群列表给两个群（一个群名带项目号）；话题 / 群消息列表为空；
// 下载附件失败（走 downloadError，不碰磁盘）；其余（发 / 回消息）回递增的 message_id。
writeFileSync(bin, `#!/bin/sh
printf '%s\\n' "$*" >> "${cliLog}"
n=$(wc -l < "${cliLog}" | tr -d ' ')
case "$*" in
  *+messages-mget*) printf '%s' '{"ok":true,"data":{"messages":[{"message_id":"om_ref","msg_type":"text","content":"原话","sender":{"id":"ou_k","name":"K"},"create_time":"2026-11-01 09:00"}]}}' ;;
  *+chat-list*) printf '%s' '{"ok":true,"data":{"chats":[{"chat_id":"oc_named","name":"[PR-02306] 项目群"},{"chat_id":"oc_g","name":"测试群"},{"chat_id":"oc_bound","name":"绑定群"},{"chat_id":"oc_auto","name":"自动群"}]}}' ;;
  *+threads-messages-list*|*+chat-messages-list*) printf '%s' '{"ok":true,"data":{"messages":[]}}' ;;
  *+messages-resources-download*file_ok*) printf '%s' '{"ok":true,"data":{}}' ;;
  *+messages-resources-download*) printf '%s' '{"ok":false,"error":{"type":"test","message":"no download"}}' ;;
  *) printf '{"ok":true,"data":{"message_id":"om_f%s"}}' "$n" ;;
esac
`)
chmodSync(bin, 0o755)
process.env.LARK_CLI_BIN = bin
process.env.LARK_CHAT_NAME_TTL_MS = '-1' // 每次都重拉群列表：数 +chat-list 调用次数才稳定
process.env.LARK_RUNTIME_DIR = join(dir, 'runtime')
process.env.LARK_OUTBOX_DIR = join(dir, 'outbox')
process.env.LARK_OBLIGATIONS_DIR = join(dir, 'obligations')
mkdirSync(process.env.LARK_RUNTIME_DIR, { recursive: true })
writeFileSync(join(process.env.LARK_RUNTIME_DIR, 'lark-project-chats.json'), JSON.stringify({ version: 1, baselineAt: null, projects: { 'PR-01111': { chatId: 'oc_bound', chatName: '绑定群' } }, knownChats: {} }))

const { buildConversationBundle } = await import('../lib/lark-conversation-bundle.mjs')
const { downloadAttachments } = await import('../lib/lark-cli.mjs')
const { ingestLarkEvent } = await import('../lib/lark-ingest.mjs')
const { recordOutbox } = await import('../lib/lark-outbox.mjs')
const { handleBotAddedEvent, parseBotAddedEvent } = await import('../lib/lark-project-chat-sync.mjs')
const { createTaskStore } = await import('../lib/lark-task-store.mjs')

const BOT = { id: 'ou_bot', key: '@_user_1', name: 'Aven.Bot' }
const AVEN = { id: 'ou_aven', key: '@_user_2', name: 'aven' }
const config = { project: 'PR-01947', title: '主项目', botOpenId: 'ou_bot', botAppId: 'cli_x', allowedChatIds: ['oc_g', 'oc_named', 'oc_bound'], allowedOpenIds: ['ou_aven'], notifyOpenId: 'ou_aven', taskMentionOpenIds: ['ou_aven'] }
const quiet = async (fn) => {
  const spies = ['log', 'warn', 'error'].map((name) => { const original = console[name]; console[name] = () => {}; return () => { console[name] = original } })
  try {
    return await fn()
  } finally {
    for (const restore of spies) restore()
  }
}
const cliCalls = (needle) => { try { return readFileSync(cliLog, 'utf8').split('\n').filter((line) => line.includes(needle)).length } catch { return 0 } }

describe('摄入链路 / 上下文包 / 入群事件（真 store + 假 lark-cli）', () => {
  let store
  let seq = 0
  const nextId = (prefix = 'om_m') => `${prefix}${++seq}`
  // lark-cli 拍平的消息事件：content 里 @名字 已内联，mentions[].id 是字符串。
  const raw = ({ id = nextId(), chatId = 'oc_g', chatType = 'group', sender = 'ou_qa', senderType = 'user', text = '', mentions = [], ...rest } = {}) =>
    ({ message_id: id, chat_id: chatId, chat_type: chatType, message_type: 'text', sender_type: senderType, sender_id: sender, content: text, mentions, create_time: '1761990000000', ...rest })
  const atBot = (text, extra = {}) => raw({ text: `@Aven.Bot ${text}`, mentions: [BOT], ...extra })
  const dm = (text, extra = {}) => raw({ chatId: 'ou_aven', chatType: 'p2p', sender: 'ou_aven', text, ...extra })
  const ingest = (event) => quiet(() => ingestLarkEvent({ raw: event, config, store }))
  after(() => rmSync(dir, { recursive: true, force: true }))

  it('ingest：触发 / 白名单 / 去抖并入 / 运维 / 控制通道透传 / 续跑；bundle：版式 / 附件来源 / 更早的文档 / 失败退空；bot-added：解析与处理', () => runSteps([
    ['@bot：建 received 任务（bot_mention、addressedToBot、快道、挂「收到」、回复目标不在话题里、群名无项目号 → adhoc）', () => quiet(async () => {
      const event = atBot('看下登录页')
      await ingestLarkEvent({ raw: event, config, store })
      const task = store.get(event.message_id)
      assert.ok(task, '建了任务')
      assert.deepEqual([task.status, task.source, task.chatId, task.chatType, task.operator, task.project, task.projectTitle, task.text, task.summary], ['received', 'lark', 'oc_g', 'group', 'ou_qa', null, undefined, '看下登录页', '看下登录页'])
      assert.deepEqual([task.addressedToBot, task.fromPrincipal, task.quotedOwnCard, task.commandType, task.commandTypeSource], [true, false, false, null, null])
      assert.deepEqual(task.replyTarget, { messageId: event.message_id, inThread: false })
      assert.equal(task.threadRootId, null)
      assert.deepEqual([task.intake.required, task.intake.trigger, task.intake.lane, task.intake.mentionedOpenIds, task.intake.anchorTaskId], [true, 'bot_mention', 'fast', [], null])
      // 快道不等（慢道要等 60 秒）：两个时间戳分别取当前时间，机器忙时相差几百毫秒（11-02 排空重启自检在负载下红过一次），只要远小于慢道等待就算
      assert.ok(Date.parse(task.intake.notBefore) - Date.parse(task.intake.receivedAt) < 5_000, '快道不等')
      assert.ok(task.ackPending?.at && task.ackPending?.deadline, '挂起「收到」')
      assert.deepEqual(task.conversation, { anchor: null, activity: { outbox: [], tasks: [] }, candidates: [] })
      assert.equal('threadSpeakers' in task, false)
      // 幂等：同一条再投一次不动
      const before = JSON.stringify(task)
      await ingestLarkEvent({ raw: event, config, store })
      assert.equal(JSON.stringify(store.get(event.message_id)), before)
    })],
    ['只 @ 负责人 / @所有人（task_mention）不建任务（11-02 关掉）；bot 发的、不在白名单群的、私信非负责人的、空消息都丢', () => quiet(async () => {
      const count = store.list().length
      for (const event of [
        raw({ text: '@aven 登录页白屏了', mentions: [AVEN] }),
        raw({ text: '@所有人 都看下', mentions: [{ id: 'all', key: '@_all', name: '所有人' }] }),
        raw({ text: '@Aven.Bot 机器人自己说的', mentions: [BOT], senderType: 'bot' }),
        raw({ text: '@Aven.Bot 别的群', mentions: [BOT], chatId: 'oc_other' }),
        raw({ chatId: 'ou_qa', chatType: 'p2p', sender: 'ou_qa', text: '私信但不是负责人' }),
        raw({ text: '@Aven.Bot', mentions: [BOT] }),
        raw({ text: '没叫机器人的群消息' }),
      ]) await ingestLarkEvent({ raw: event, config, store })
      assert.equal(store.list().length, count, '一条都没建')
    })],
    ['闲置群记账与指令（lib/lark-chat-retention）：群里 @bot 记活跃（白名单外 / 没叫机器人的不记）；负责人私信「留下 关键字」直接回话标不退、不建任务', () => quiet(async () => {
      const activityFile = join(process.env.LARK_RUNTIME_DIR, 'lark-chat-activity-state.json')
      const chatsOf = () => { try { return JSON.parse(readFileSync(activityFile, 'utf8')).chats } catch { return {} } }
      rmSync(activityFile, { force: true })
      await ingestLarkEvent({ raw: raw({ text: '@Aven.Bot 别的群', mentions: [BOT], chatId: 'oc_other' }), config, store })
      await ingestLarkEvent({ raw: raw({ text: '没叫机器人', chatId: 'oc_named' }), config, store })
      assert.deepEqual(chatsOf(), {})
      await ingestLarkEvent({ raw: atBot('看下资产页'), config, store })
      assert.deepEqual(Object.keys(chatsOf()), ['oc_g'])
      const count = store.list().length
      const keep = dm('留下 测试群')
      await ingestLarkEvent({ raw: keep, config, store })
      assert.equal(store.list().length, count, '指令不建任务')
      assert.equal(chatsOf().oc_g.keep, true)
    })],
    ['负责人私信：dm + fromPrincipal + 快道；explicit「运维：」→ 直接 queued 的 ops 任务（契约 ops、回复目标、话题键取 reply_to）；推断的运维说法 → source=inferred；群里的「运维：」不算运维', () => quiet(async () => {
      const plain = dm('看看测试环境能不能登录')
      await ingestLarkEvent({ raw: plain, config, store })
      const task = store.get(plain.message_id)
      assert.deepEqual([task.status, task.chatType, task.intake.trigger, task.intake.lane, task.addressedToBot, task.fromPrincipal], ['received', 'p2p', 'dm', 'fast', true, true])
      const ops = dm('运维：部署 pre', { reply_to: 'om_prev' })
      await ingestLarkEvent({ raw: ops, config, store })
      const opsTask = store.get(ops.message_id)
      assert.deepEqual([opsTask.status, opsTask.chatType, opsTask.commandType, opsTask.commandTypeSource, opsTask.text, opsTask.summary, opsTask.threadRootId, opsTask.intake, opsTask.project, opsTask.projectTitle], ['queued', 'p2p', 'ops', 'explicit', '运维：部署 pre', '运维：部署 pre', 'om_prev', null, null, null])
      assert.deepEqual(opsTask.replyTarget, { messageId: ops.message_id, inThread: false })
      assert.deepEqual([opsTask.addressedToBot, opsTask.fromPrincipal, opsTask.attachments, opsTask.contract.deliverable, opsTask.contract.source, opsTask.contract.readOnly], [true, true, [], 'ops', 'ops', false])
      const inferred = dm('uat 通过了，帮我部署 online')
      await ingestLarkEvent({ raw: inferred, config, store })
      assert.deepEqual([store.get(inferred.message_id).status, store.get(inferred.message_id).commandTypeSource, store.get(inferred.message_id).threadRootId], ['queued', 'inferred', null])
      const inGroup = raw({ text: '@Aven.Bot 运维：部署 pre', mentions: [BOT], sender: 'ou_aven', chatId: 'oc_named' })
      await ingestLarkEvent({ raw: inGroup, config, store })
      assert.deepEqual([store.get(inGroup.message_id).status, store.get(inGroup.message_id).intake?.trigger], ['received', 'bot_mention'], '群里不走运维')
    })],
    ['去抖并入：同一人安静期内连发（@bot / 没叫机器人 / 只 @ 负责人）都并进还没分类的那条；旧的只 @ 负责人任务被 @bot 补充时升级（addressedToBot / 快道 / 挂「收到」）', () => quiet(async () => {
      const first = atBot('登录页白屏', { sender: 'ou_qb' })
      await ingestLarkEvent({ raw: first, config, store })
      const supplements = [
        raw({ text: '补充：Chrome 也是', sender: 'ou_qb' }),
        raw({ text: '@aven 你也看下', mentions: [AVEN], sender: 'ou_qb' }),
        atBot('再补一句', { sender: 'ou_qb' }),
      ]
      for (const event of supplements) await ingestLarkEvent({ raw: event, config, store })
      const target = store.get(first.message_id)
      assert.ok(supplements.every((event) => !store.has(event.message_id)), '补充不建新任务')
      assert.match(target.text, /^登录页白屏\n\n【话题补充 \d\d:\d\d】补充：Chrome 也是\n\n【话题补充 \d\d:\d\d】你也看下\n\n【话题补充 \d\d:\d\d】再补一句$/)
      assert.deepEqual([target.addressedToBot, target.intake.lane], [true, 'fast'])
      // 11-02 之前落下的「只 @ 负责人」任务（addressedToBot=false、慢道）：同一人紧接着 @bot → 升级
      const now = new Date().toISOString()
      store.upsert({ id: 'om_legacy', source: 'lark', chatId: 'oc_g', operator: 'ou_qc', status: 'received', text: '旧的只 @ 负责人', addressedToBot: false, fromPrincipal: false, intake: { required: true, trigger: 'task_mention', lane: 'slow', receivedAt: now, notBefore: now }, createdAt: now })
      const upgrade = atBot('这个你来修', { sender: 'ou_qc' })
      await ingestLarkEvent({ raw: upgrade, config, store })
      const legacy = store.get('om_legacy')
      assert.equal(store.has(upgrade.message_id), false)
      assert.deepEqual([legacy.addressedToBot, legacy.intake.lane, Boolean(legacy.ackPending)], [true, 'fast', true])
      assert.match(legacy.text, /旧的只 @ 负责人\n\n【话题补充 \d\d:\d\d】这个你来修$/)
      // 负责人在群里 @bot 补充别人的话题任务不成立（主楼只认同一人）；没叫机器人且没可并入的任务 → 直接丢，auto 成员制也不查群成员
      const autoConfig = { ...config, allowedChatIds: 'auto' }
      const listCallsBefore = cliCalls('+chat-list')
      await ingestLarkEvent({ raw: raw({ text: '没人要的一句', sender: 'ou_zz', chatId: 'oc_auto' }), config: autoConfig, store })
      assert.equal(cliCalls('+chat-list'), listCallsBefore, '没拉群列表')
      await ingestLarkEvent({ raw: raw({ text: '@Aven.Bot 机器人说的', mentions: [BOT], senderType: 'bot', sender: 'ou_qb' }), config, store })
      assert.equal(store.get(first.message_id).text, target.text, 'bot 发的不并入')
    })],
    ['回复 bot 的旧卡（回执代次不同）：bot_reply + quotedOwnCard + 控制通道透传 anchorTaskId；被引用消息进正文、refText；本条只有 @ 时摘要取被引用原话', () => quiet(async () => {
      store.upsert({ id: 'om_done1', source: 'lark', chatId: 'oc_g', messageId: 'om_done1', operator: 'ou_qa', status: 'done', epoch: 1, summary: '登录页报错', text: '登录页报错', createdAt: '2026-11-01T00:00:00Z' })
      store.recordReceipt('om_done1', { messageId: 'om_card1', kind: 'done', epoch: 0, chatId: 'oc_g' })
      const reply = raw({ text: '顺便看下注册页样式', reply_to: 'om_card1' })
      await ingestLarkEvent({ raw: reply, config, store })
      const task = store.get(reply.message_id)
      assert.ok(task, '回 bot 旧卡建了新任务')
      assert.deepEqual([task.intake.trigger, task.intake.anchorTaskId, task.quotedOwnCard, task.addressedToBot, task.intake.lane, task.threadRootId], ['bot_reply', 'om_done1', true, true, 'fast', 'om_card1'])
      assert.equal(task.text, '【被引用消息】（K 11-01 09:00）\n原话\n\n【本条 @】顺便看下注册页样式')
      assert.equal(task.summary, '顺便看下注册页样式')
      const empty = atBot('', { reply_to: 'om_ref' })
      await ingestLarkEvent({ raw: empty, config, store })
      const quoted = store.get(empty.message_id)
      assert.deepEqual([quoted.text, quoted.summary, quoted.quotedOwnCard, quoted.intake.anchorTaskId], ['【被引用消息】（K 11-01 09:00）\n原话\n\n【本条 @】（无附言）', '原话', false, null])
      // 11-02 复核：回复「收到」——原任务还没分类 → 并进去一起分类（不建任务、不回第二句）；已排队（同代回执）+ 有内容 → 放行成带锚点的新任务，
      // 不再被续跑路径抓去回「不在等材料，续不了」；只问进度 → 「还在处理中」、不建任务
      const outboxBefore = cliCalls('+messages-reply')
      store.upsert({ id: 'om_fresh', source: 'lark', chatId: 'oc_g', messageId: 'om_fresh', operator: 'ou_qf', status: 'received', epoch: 0, addressedToBot: true, summary: '支付页白屏', text: '支付页白屏', intake: { required: true, trigger: 'bot_mention', lane: 'fast', receivedAt: '2026-11-01T00:00:00Z' }, createdAt: '2026-11-01T00:00:00Z' })
      store.recordReceipt('om_fresh', { messageId: 'om_ack_fresh', kind: 'ack', epoch: 0, chatId: 'oc_g' })
      const supplement = raw({ text: 'Safari 也复现，截图稍后', reply_to: 'om_ack_fresh', root_id: 'om_fresh', sender: 'ou_qg' })
      await ingestLarkEvent({ raw: supplement, config, store })
      assert.equal(store.has(supplement.message_id), false, '并入，不建任务')
      assert.match(store.get('om_fresh').text, /^支付页白屏\n\n【话题补充 \d\d:\d\d】Safari 也复现，截图稍后$/)
      assert.equal(cliCalls('+messages-reply'), outboxBefore, '不回第二句')
      store.upsert({ id: 'om_run', source: 'lark', chatId: 'oc_g', messageId: 'om_run', operator: 'ou_qf', status: 'queued', epoch: 1, addressedToBot: true, summary: '充值页', text: '充值页', intake: { required: false, trigger: 'bot_mention' }, createdAt: '2026-11-01T00:00:00Z' })
      store.recordReceipt('om_run', { messageId: 'om_ack_run', kind: 'ack', epoch: 1, chatId: 'oc_g' })
      const more = raw({ text: '顺便把页脚也改一下', reply_to: 'om_ack_run', root_id: 'om_run', sender: 'ou_qg' })
      await ingestLarkEvent({ raw: more, config, store })
      assert.deepEqual([store.get(more.message_id)?.status, store.get(more.message_id)?.intake.anchorTaskId, store.get('om_run').status, cliCalls('+messages-reply')], ['received', 'om_run', 'queued', outboxBefore], '放行建任务带锚点；没说「续不了」')
      const ping = raw({ text: '怎么样了', reply_to: 'om_ack_run', root_id: 'om_run', sender: 'ou_qg' })
      await ingestLarkEvent({ raw: ping, config, store })
      assert.deepEqual([store.has(ping.message_id), cliCalls('+messages-reply')], [false, outboxBefore + 1], '只问进度：回一句、不建任务')
    })],
    ['话题：thread_id 才回话题流（inThread）、话题键优先 thread_id；只有 root_id 的普通回复不进话题流', () => quiet(async () => {
      const inThread = atBot('话题里 @ 的', { thread_id: 'omt_1', root_id: 'om_root1' })
      await ingestLarkEvent({ raw: inThread, config, store })
      assert.deepEqual([store.get(inThread.message_id).replyTarget, store.get(inThread.message_id).threadRootId], [{ messageId: inThread.message_id, inThread: true }, 'omt_1'])
      const rooted = atBot('普通回复', { root_id: 'om_root2' })
      await ingestLarkEvent({ raw: rooted, config, store })
      assert.deepEqual([store.get(rooted.message_id).replyTarget, store.get(rooted.message_id).threadRootId], [{ messageId: rooted.message_id, inThread: false }, 'om_root2'])
    })],
    ['项目号：正文唯一项目号 > 绑定表 > 群名；projectTitle 只在是配置主项目时有', () => quiet(async () => {
      // 每条换一个发送人：同一人安静期内连发会并进前一条（去抖），不是本段要测的
      const cases = [
        { name: '正文', event: atBot('[PR-02222] 看下', { chatId: 'oc_bound', sender: 'ou_p1' }), project: 'PR-02222' },
        { name: '绑定表', event: atBot('看下', { chatId: 'oc_bound', sender: 'ou_p2' }), project: 'PR-01111' },
        { name: '群名', event: atBot('看下', { chatId: 'oc_named', sender: 'ou_p3' }), project: 'PR-02306' },
        { name: '正文两个项目号 → 回落绑定表', event: atBot('PR-02222 和 PR-03333 都看下', { chatId: 'oc_bound', sender: 'ou_p4' }), project: 'PR-01111' },
        { name: '主项目号 → 带标题', event: atBot('PR-01947 看下', { sender: 'ou_p5' }), project: 'PR-01947', title: '主项目' },
        { name: '正文两个项目号 → 回落群名', event: atBot('PR-02222 和 PR-03333 都看下', { chatId: 'oc_named', sender: 'ou_p6' }), project: 'PR-02306' },
        { name: '正文两个项目号、群名也没有 → 兜底正文首个', event: atBot('PR-02222 和 PR-03333 都看下', { sender: 'ou_p7' }), project: 'PR-02222' },
      ]
      for (const item of cases) await ingestLarkEvent({ raw: item.event, config, store })
      return eachCase(cases, ({ event, project, title }) => assert.deepEqual([store.get(event.message_id).project, store.get(event.message_id).projectTitle], [project, title]))
    })],
    ['auto 成员制：群消息查 bot 在不在群（多拉一次群列表）、私信不查；静态白名单一律不查（群列表只为解析群名拉一次）', () => quiet(async () => {
      const autoConfig = { ...config, allowedChatIds: 'auto' }
      const delta = async (event, cfg) => {
        const before = cliCalls('+chat-list')
        await ingestLarkEvent({ raw: event, config: cfg, store })
        return cliCalls('+chat-list') - before
      }
      const autoGroup = atBot('auto 群里 @', { chatId: 'oc_auto', sender: 'ou_a1' })
      assert.equal(await delta(autoGroup, autoConfig), 2, '查成员 + 解析群名')
      assert.equal(store.get(autoGroup.message_id)?.status, 'received', 'bot 在群里 → 放行')
      const autoDm = dm('auto 下的私信')
      assert.equal(await delta(autoDm, autoConfig), 0, '私信不查成员、也不查群名')
      assert.equal(store.get(autoDm.message_id)?.status, 'received')
      assert.equal(store.get(autoDm.message_id).chatName, null, '私信没有群名')
      const staticGroup = atBot('静态白名单群里 @', { sender: 'ou_a2' })
      assert.equal(await delta(staticGroup, config), 1, '静态白名单不查成员')
      assert.equal(store.get(staticGroup.message_id)?.status, 'received')
      const stranger = atBot('不在的群', { chatId: 'oc_stranger', sender: 'ou_a3' })
      await ingestLarkEvent({ raw: stranger, config: autoConfig, store })
      assert.equal(store.has(stranger.message_id), false, 'bot 不在的群 → 丢')
    })],
    ['续跑：显式「继续任务 <id> 补料」→ 原任务 queued 并追加补料；id 不存在只回话不建任务；回复终态任务且同话题恰好一条挂起 → 并入那条', () => quiet(async () => {
      const parked = store.upsert({ id: 'om_p2', source: 'lark', chatId: 'oc_g', messageId: 'om_p2', operator: 'ou_qa', status: 'blocked', summary: '等字段', text: '等字段', epoch: 0, createdAt: '2026-11-01T00:00:00Z' })
      const resume = atBot(`继续任务 ${parked.id} 字段叫 avatar`)
      await ingestLarkEvent({ raw: resume, config, store })
      assert.equal(store.has(resume.message_id), false)
      assert.deepEqual([store.get('om_p2').status, store.get('om_p2').resumeCount, store.get('om_p2').text], ['queued', 1, '等字段\n\n【补料】\n字段叫 avatar'])
      const missing = atBot('继续任务 om_nope 补料')
      await ingestLarkEvent({ raw: missing, config, store })
      assert.equal(store.has(missing.message_id), false)
      store.upsert({ id: 'om_p3', source: 'lark', chatId: 'oc_g', messageId: 'om_p3', operator: 'ou_qa', status: 'waiting_confirmation', threadRootId: 'omt_p', summary: '等截图', text: '等截图', epoch: 0, createdAt: '2026-11-01T00:00:00Z' })
      store.upsert({ id: 'om_done3', source: 'lark', chatId: 'oc_g', messageId: 'om_done3', operator: 'ou_qa', status: 'done', threadRootId: 'omt_p', summary: '做完的', text: '做完的', epoch: 0, createdAt: '2026-11-01T00:00:00Z' })
      const sibling = atBot('补充：接口字段是 avatar', { thread_id: 'omt_p', reply_to: 'om_done3' })
      await ingestLarkEvent({ raw: sibling, config, store })
      assert.equal(store.has(sibling.message_id), false)
      assert.deepEqual([store.get('om_p3').status, store.get('om_p3').text], ['queued', '等截图\n\n【补料】\n补充：接口字段是 avatar'])
    })],
    ['bundle：引用 + 话题 + 最近消息的版式、附件按来源标记（本条 / 被引用 / 话题回复 / 群里之前的消息）、项目优先取参数、threadSpeakers 取最后 10 个、refText', () => quiet(async () => {
      const calls = []
      const download = async ({ project, messageId, attachments }) => { calls.push({ project, messageId, attachments }); return attachments.map((item) => ({ ...item, localPath: 'stub' })) }
      const threadCtx = [
        { messageId: 'om_t1', sender: 'T', senderOpenId: 'ou_t', text: '话题里说的', attachments: [{ type: 'image', imageKey: 'img_t' }] },
        { messageId: 'om_t2', sender: '', senderOpenId: 'ou_t2', text: '', attachments: [{ type: 'image', imageKey: 'img_t2' }] },
        ...Array.from({ length: 11 }, (_, i) => ({ messageId: `om_s${i}`, sender: `S${i}`, senderOpenId: `ou_s${i}`, text: `第 ${i} 句`, attachments: [] })),
        { messageId: 'om_t3', sender: '', senderOpenId: '', text: '没有发送人', attachments: [] },
      ]
      const recentCtx = [
        { messageId: 'om_r1', sender: 'R', senderOpenId: 'ou_r', time: '11-01 08:00', text: '之前说的', attachments: [{ type: 'image', imageKey: 'img_x' }, { type: 'image', imageKey: 'img_y', origin: '已有来源' }] },
        { messageId: 'om_r2', sender: '', time: '', text: '无名无时', attachments: [] },
        { messageId: 'om_r3', sender: 'S', senderOpenId: 'ou_s', text: '有名无时', attachments: [] },
        { messageId: 'om_r4', time: '11-01 08:30', text: '有时无名', attachments: [] },
      ]
      const fetched = []
      const deps = {
        fetchReferencedContext: async (id) => { fetched.push(['ref', id]); return { text: '桩引用', sender: 'Q', senderOpenId: 'ou_q', createTime: '2026-11-01 07:30', attachments: [{ type: 'image', imageKey: 'img_r' }] } },
        fetchThreadContext: async (id, opts) => { fetched.push(['thread', id, opts]); return threadCtx },
        fetchRecentChatContext: async (opts) => { fetched.push(['recent', opts]); return recentCtx },
        downloadAttachments: download,
      }
      const msg = { messageId: 'om_me', chatId: 'oc_b', chatType: 'group', senderOpenId: 'ou_u', text: 'hi', mentions: [], attachments: [{ type: 'image', imageKey: 'img_o' }], replyTo: 'om_q', createTimeMs: 1761990000000 }
      const store2 = { list: () => [], findTaskByAnyReceipt: () => null, findByReceiptMessageId: () => null }
      const out = await buildConversationBundle({ msg, config, store: store2, project: 'PR-1', deps })
      assert.equal(out.text, [
        '【被引用消息】（Q 11-01 07:30）\n桩引用\n\n【本条 @】hi',
        `【话题其它回复】\nT：话题里说的\n${Array.from({ length: 11 }, (_, i) => `S${i}：第 ${i} 句`).join('\n')}\n没有发送人`,
        '【群里这条之前的消息】\nR（11-01 08:00）：之前说的\n无名无时\nS：有名无时\n（11-01 08:30）：有时无名',
      ].join('\n\n'))
      assert.deepEqual(fetched[0], ['ref', 'om_q'])
      assert.deepEqual(fetched[1], ['thread', 'om_q', { excludeIds: ['om_me', 'om_q'], botOpenIds: ['ou_bot', 'cli_x'] }])
      assert.deepEqual(fetched[2], ['recent', { chatId: 'oc_b', beforeMs: 1761990000000, excludeIds: ['om_me', 'om_q', ...threadCtx.map((item) => item.messageId)], botOpenIds: ['ou_bot', 'cli_x'] }])
      assert.deepEqual(out.attachments, [
        { type: 'image', imageKey: 'img_o', origin: '本条', localPath: 'stub' },
        { type: 'image', imageKey: 'img_r', origin: '被引用消息 · Q 11-01 07:30', localPath: 'stub' },
        { type: 'image', imageKey: 'img_t', origin: '话题回复 · T', localPath: 'stub' },
        { type: 'image', imageKey: 'img_t2', origin: '话题回复 ·', localPath: 'stub' },
        { type: 'image', imageKey: 'img_x', origin: '群里之前的消息 · R 11-01 08:00', localPath: 'stub' },
        { type: 'image', imageKey: 'img_y', origin: '已有来源', localPath: 'stub' },
      ])
      assert.deepEqual(calls.map((call) => [call.project, call.messageId]), [['PR-1', 'om_me'], ['PR-1', 'om_q'], ['PR-1', 'om_t1'], ['PR-1', 'om_t2'], ['PR-1', 'om_r1']], '项目取参数不取配置；被引用的按 replyTo 下载')
      assert.deepEqual(out.threadSpeakers, Array.from({ length: 10 }, (_, i) => `ou_s${i + 1}`), '最后 10 个有 open_id 的（没有发送人的不算）')
      assert.deepEqual([out.refText, out.quotedOwnCard], ['桩引用', false])
      // 没给 project → 用配置的；没引用、没时间 → 只有本条；sender 都空的最近消息不带冒号
      const bare = await buildConversationBundle({ msg: { ...msg, replyTo: null, createTimeMs: null, attachments: [], text: '只有这句' }, config, store: store2, deps })
      assert.deepEqual([bare.text, bare.attachments, bare.threadSpeakers, bare.refText], ['只有这句', [], [], null])
      assert.equal(calls.at(-1).project, 'PR-01947')
      const noText = await buildConversationBundle({ msg: { ...msg, replyTo: null, createTimeMs: null, attachments: [], text: '' }, config, store: store2, deps })
      assert.equal(noText.text, '')
    })],
    ['bundle：更早的文档——本条 / 引用 / 话题都没文档、且没引用时才从群里补最近那份（原话提到文档 / 同一人紧接着）；负责人发的不算；图 8 文件 4 上限', () => quiet(async () => {
      const download = async ({ attachments }) => attachments
      const docMsg = { messageId: 'om_d', sender: 'D', senderOpenId: 'ou_d', time: '11-01 07:00', text: '发了文档', attachments: [], docs: [{ type: 'file', fileName: '1-接口.md', fileKey: 'f1' }] }
      const other = { messageId: 'om_e', sender: 'E', senderOpenId: 'ou_e', time: '11-01 07:10', text: '哈', attachments: [] }
      const base = { messageId: 'om_me', chatId: 'oc_b', senderOpenId: 'ou_c', mentions: [{ name: 'Aven.Bot' }], attachments: [], replyTo: null, createTimeMs: 1761990000000 }
      const store2 = { list: () => [] }
      const run = ({ msg, recentCtx, threadCtx = [], refCtx = null }) => buildConversationBundle({ msg: { ...base, ...msg }, config, store: store2, deps: { fetchReferencedContext: async () => refCtx, fetchThreadContext: async () => threadCtx, fetchRecentChatContext: async () => recentCtx, downloadAttachments: download } })
      const origins = (out) => out.attachments.map((item) => item.origin)
      await eachCase([
        { name: '原话提到文档（别人发的）→ 并入', msg: { text: '@Aven.Bot 按上面的文档来' }, recentCtx: [docMsg, other], want: ['群里之前的消息 · D 11-01 07:00'] },
        { name: '同一人紧接着 @bot → 并入', msg: { text: '@Aven.Bot 看下', senderOpenId: 'ou_d' }, recentCtx: [docMsg], want: ['群里之前的消息 · D 11-01 07:00'] },
        { name: '没有发送人名 / 时间也能标来源', msg: { text: '@Aven.Bot 按文档来' }, recentCtx: [{ ...docMsg, sender: '', time: '' }], want: ['群里之前的消息 ·'] },
        { name: '没时间', msg: { text: '@Aven.Bot 按文档来' }, recentCtx: [{ ...docMsg, time: '' }], want: ['群里之前的消息 · D'] },
        { name: '本条自己带文档 → 不补', msg: { text: '@Aven.Bot 按上面的文档来', attachments: [{ type: 'file', fileName: '需求.md' }] }, recentCtx: [docMsg, other], want: ['本条'] },
        { name: '被引用消息带文档 → 不补', msg: { text: '@Aven.Bot 按上面的文档来', replyTo: 'om_q' }, recentCtx: [docMsg], refCtx: { text: '引用', attachments: [{ type: 'file', fileName: 'prd.pdf' }] }, want: ['被引用消息'] },
        { name: '话题回复带文档 → 不补', msg: { text: '@Aven.Bot 按上面的文档来', replyTo: 'om_q' }, recentCtx: [docMsg], refCtx: { text: '引用', attachments: [] }, threadCtx: [{ messageId: 'om_t', sender: 'T', senderOpenId: 'ou_t', text: 'x', attachments: [{ type: 'file', fileName: 'a.docx' }] }], want: ['话题回复 · T'] },
        { name: '有引用（哪怕引用里没文档）→ 不补', msg: { text: '@Aven.Bot 按上面的文档来', replyTo: 'om_q' }, recentCtx: [docMsg], refCtx: { text: '引用', attachments: [] }, want: [] },
        { name: '没提到、也不是同一人紧接着 → 不补', msg: { text: '@Aven.Bot 开播 500' }, recentCtx: [docMsg, other], want: [] },
        { name: '负责人发的对接文档不算', msg: { text: '@Aven.Bot 看下', senderOpenId: 'ou_aven' }, recentCtx: [{ ...docMsg, senderOpenId: 'ou_aven' }], want: [] },
        { name: '原话为空只剩 @ → 不算提到', msg: { text: '@Aven.Bot' }, recentCtx: [{ ...docMsg, docs: [{ type: 'file', fileName: '1-undefined.md' }] }], want: [] },
      ], async ({ msg, recentCtx, threadCtx, refCtx, want }) => assert.deepEqual(origins(await run({ msg, recentCtx, threadCtx, refCtx })), want))
      const many = Array.from({ length: 6 }, (_, i) => ({ messageId: `om_m${i}`, sender: 'M', time: `11-01 0${i}:00`, text: 'x', attachments: [{ type: 'image', imageKey: `i${i}a` }, { type: 'image', imageKey: `i${i}b` }, { type: 'file', fileKey: `f${i}` }] }))
      const capped = await run({ msg: { text: '@Aven.Bot 看' }, recentCtx: many })
      assert.deepEqual([capped.attachments.filter((a) => a.type === 'image').length, capped.attachments.filter((a) => a.type === 'file').length], [8, 4])
      assert.equal(capped.attachments[0].origin, '群里之前的消息 · M 11-01 05:00', '从新到旧')
    })],
    ['bundle：别人复制 bot 旧话 → 带原消息；引用的是 bot 回执 → quotedOwnCard（只看 findTaskByAnyReceipt 也行；没引用再有回执也不算）；拉取抛错 → 退空不挡建任务', () => quiet(async () => {
      const said = '❌ 没接 开播设置里的『语言』下拉，后端没给字段'
      recordOutbox({ chatId: 'oc_quote', taskId: 'om_old', topic: 'live', phase: 'done', text: said, now: Date.now() - 60_000 })
      const deps = { fetchReferencedContext: async () => null, fetchThreadContext: async () => [], fetchRecentChatContext: async () => [], downloadAttachments: async ({ attachments }) => attachments }
      const msg = { messageId: 'om_me', chatId: 'oc_quote', senderOpenId: 'ou_u', text: `${said}\n这个现在有了`, mentions: [], attachments: [], replyTo: null, createTimeMs: 1761990000000 }
      const out = await buildConversationBundle({ msg, config, store: { list: () => [] }, deps })
      assert.ok(out.text.startsWith(`${said}\n这个现在有了\n\n【复制了 bot 之前说的话】`), out.text)
      assert.ok(out.text.includes(`（任务 om_old，主题 live）：\n${said}`))
      const onlyAny = { list: () => [], findTaskByAnyReceipt: (id) => (id === 'om_card' ? { id: 't' } : null) }
      assert.equal((await buildConversationBundle({ msg: { ...msg, replyTo: 'om_card', text: 'x' }, config, store: onlyAny, deps })).quotedOwnCard, true)
      const onlyEpoch = { list: () => [], findByReceiptMessageId: (id) => (id === 'om_card' ? { id: 't' } : null) }
      assert.equal((await buildConversationBundle({ msg: { ...msg, replyTo: 'om_card', text: 'x' }, config, store: onlyEpoch, deps })).quotedOwnCard, true)
      const always = { list: () => [], findTaskByAnyReceipt: () => ({ id: 't' }), findByReceiptMessageId: () => ({ id: 't' }) }
      assert.equal((await buildConversationBundle({ msg: { ...msg, replyTo: null, text: 'x' }, config, store: always, deps })).quotedOwnCard, false, '没引用就不算')
      assert.equal((await buildConversationBundle({ msg: { ...msg, replyTo: 'om_x', text: 'x' }, config, store: { list: () => [] }, deps })).quotedOwnCard, false, 'store 没有回执索引')
      const boom = async () => { throw new Error('网络坏了') }
      const failed = await buildConversationBundle({ msg: { ...msg, replyTo: 'om_q', text: '只有本条', attachments: [{ type: 'image', imageKey: 'img_o' }] }, config, store: { list: () => [] }, deps: { fetchReferencedContext: boom, fetchThreadContext: boom, fetchRecentChatContext: boom, downloadAttachments: async ({ attachments }) => attachments } })
      assert.deepEqual([failed.text, failed.attachments, failed.threadSpeakers, failed.refText, failed.quotedOwnCard], ['只有本条', [{ type: 'image', imageKey: 'img_o', origin: '本条' }], [], null, false])
    })],
    ['downloadAttachments：文件按 fileKey + --type file + 原文件名（去掉路径字符）下，不按图片改扩展名；图片照旧 .img；缺下载键直接记错不调；失败记 downloadError（11-02：原来一律当图片下）', () => quiet(async () => {
      const out = await downloadAttachments({ project: 'PR-9', messageId: 'om_dl', attachments: [
        { type: 'file', fileKey: 'file_ok1', fileName: '../需求/说明.md' },
        { type: 'file', fileKey: 'file_ok2', fileName: null },
        { type: 'image', imageKey: 'img_x' },
        { type: 'file', fileName: '没键.md' },
      ] })
      const dirOf = join(process.env.LARK_RUNTIME_DIR, 'lark-attachments', 'PR-9', 'om_dl')
      assert.deepEqual(out.map((a) => [a.localPath || null, a.downloadError ? a.downloadError.slice(0, 20) : null]), [
        [join(dirOf, '1-_需求_说明.md'), null],
        [join(dirOf, '2-file_ok2'), null],
        [null, '{"ok":false,"error":'],
        [null, '缺下载键'],
      ])
      const lines = readFileSync(cliLog, 'utf8').split('\n').filter((line) => line.includes('+messages-resources-download') && line.includes('om_dl'))
      assert.equal(lines.length, 3, '缺下载键的不调')
      assert.match(lines[0], /--file-key file_ok1 --type file --output 1-_需求_说明\.md/)
      assert.match(lines[2], /--file-key img_x --type image --output 3-img_x\.img/)
      assert.deepEqual(await downloadAttachments({ project: 'PR-9', messageId: 'om_dl2', attachments: [] }), [])
    })],
    ['parseBotAddedEvent：官方信封 / data.event / 拍平 / 驼峰 chatId / i18n 名 / 操作人三种写法 / external 只认 true；缺 chat_id → null', () => eachCase([
      { name: '官方信封', raw: { event: { chat_id: 'oc_1', name: 'N', external: true, operator_id: { open_id: 'ou_op' } } }, want: { chatId: 'oc_1', name: 'N', operatorOpenId: 'ou_op', external: true } },
      { name: 'data.event', raw: { data: { event: { chat_id: 'oc_2', i18n_names: { zh_cn: '中', en_us: 'En' } } } }, want: { chatId: 'oc_2', name: '中', operatorOpenId: null, external: false } },
      { name: '拍平 + 驼峰 + 英文名 + operator_id.openId', raw: { chatId: 'oc_3', i18n_names: { en_us: 'En' }, operator_id: { openId: 'ou_camel' }, external: 'true' }, want: { chatId: 'oc_3', name: 'En', operatorOpenId: 'ou_camel', external: false } },
      { name: 'operator_open_id 顶层', raw: { chat_id: 'oc_4', operator_open_id: 'ou_top' }, want: { chatId: 'oc_4', name: '', operatorOpenId: 'ou_top', external: false } },
      { name: 'name 优先于 i18n', raw: { chat_id: 'oc_5', name: 'N', i18n_names: { zh_cn: '中', en_us: 'En' } }, want: { chatId: 'oc_5', name: 'N', operatorOpenId: null, external: false } },
      { name: 'zh 优先于 en', raw: { chat_id: 'oc_6', i18n_names: { zh_cn: '中', en_us: 'En' } }, want: { chatId: 'oc_6', name: '中', operatorOpenId: null, external: false } },
      { name: 'open_id 优先于 openId / operator_open_id', raw: { chat_id: 'oc_7', operator_id: { open_id: 'ou_a', openId: 'ou_b' }, operator_open_id: 'ou_c' }, want: { chatId: 'oc_7', name: '', operatorOpenId: 'ou_a', external: false } },
      { name: 'openId 优先于 operator_open_id', raw: { chat_id: 'oc_8', operator_id: { openId: 'ou_b' }, operator_open_id: 'ou_c' }, want: { chatId: 'oc_8', name: '', operatorOpenId: 'ou_b', external: false } },
      { name: '缺 chat_id', raw: { event: { name: 'N' } }, want: null },
      { name: 'null', raw: null, want: null },
    ], ({ raw: input, want }) => assert.deepEqual(parseBotAddedEvent(input), want))],
    ['handleBotAddedEvent：外部群只私信负责人（没配就不发）、不同步不打招呼；内部群先同步，配了非空 joinGreeting 才在群里说一句（去首尾空白）；日志带群名 / 群 id / 外部 / 操作人', () => quiet(async () => {
      const run = async ({ raw: input, config: cfg }) => {
        const sent = []
        const logs = []
        let synced = 0
        const out = await handleBotAddedEvent({ raw: input, config: cfg, sync: async () => { synced += 1 }, send: async (args) => { sent.push(args); return { ok: true } }, log: (line) => logs.push(line) })
        return { out, sent, logs, synced }
      }
      const ext = await run({ raw: { event: { chat_id: 'oc_external_01', name: '外部群', external: true, operator_id: { open_id: 'ou_op' } } }, config: { notifyOpenId: 'ou_aven', joinGreeting: '你好' } })
      assert.deepEqual(ext.out, { chatId: 'oc_external_01', name: '外部群', operatorOpenId: 'ou_op', external: true })
      assert.deepEqual(ext.logs, ['[lark-gateway] 被拉进群「外部群」（oc_external_01，外部群），操作人 ou_op'])
      assert.deepEqual(ext.sent, [{ chatId: 'ou_aven', text: '👋 被拉进了外部群「外部群」，外部群不绑项目，先不处理。', logPrefix: 'bot-added external', idempotencyKey: 'join-_external_01-ext' }])
      assert.equal(ext.synced, 0)
      const extNoName = await run({ raw: { chat_id: 'oc_ext', external: true }, config: { notifyOpenId: 'ou_aven' } })
      assert.deepEqual(extNoName.logs, ['[lark-gateway] 被拉进群「oc_ext」（oc_ext，外部群）'])
      assert.deepEqual(extNoName.sent.map((item) => item.text), ['👋 被拉进了外部群「oc_ext」，外部群不绑项目，先不处理。'])
      const extSilent = await run({ raw: { chat_id: 'oc_ext', external: true }, config: {} })
      assert.deepEqual([extSilent.sent, extSilent.synced], [[], 0])
      const greet = await run({ raw: { chat_id: 'oc_internal_01', name: '内部群' }, config: { notifyOpenId: 'ou_aven', joinGreeting: '  你好，我是 bot  ' } })
      assert.deepEqual(greet.logs, ['[lark-gateway] 被拉进群「内部群」（oc_internal_01）'])
      assert.deepEqual([greet.synced, greet.sent], [1, [{ chatId: 'oc_internal_01', text: '你好，我是 bot', logPrefix: 'join greeting', idempotencyKey: 'join-_internal_01-hi' }]])
      for (const joinGreeting of [undefined, '', '   ', 123, true, ['x']]) {
        const silent = await run({ raw: { chat_id: 'oc_in' }, config: { notifyOpenId: 'ou_aven', joinGreeting } })
        assert.deepEqual([silent.synced, silent.sent, silent.out?.chatId], [1, [], 'oc_in'], `joinGreeting=${JSON.stringify(joinGreeting)} 不说话`)
      }
      const none = await run({ raw: { event: {} }, config: { joinGreeting: 'x' } })
      assert.deepEqual([none.out, none.sent, none.logs, none.synced], [null, [], [], 0])
    })],
  ], {
    before: () => {
      store = createTaskStore({ tasksDir: join(dir, 'tasks', String(++seq)), leaseMs: 1000 })
      process.env.LARK_OUTBOX_DIR = join(dir, 'outbox')
      process.env.LARK_OBLIGATIONS_DIR = join(dir, 'obligations')
    },
  }))
})
