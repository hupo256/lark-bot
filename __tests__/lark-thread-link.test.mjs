/**
 * 同话题前一单关联（lib/lark-thread-link.mjs）+ 上下文包接线，11-04 事故：
 * 话题 omt_198f3efd1a0f1851 里 aven 16:40 @bot「obey order of ROU」；
 * Rou 16:38–16:39 三条没 @bot 的指示是这一单的补充要求，前一单（16:08 那条）已人工结单。
 * 一个 it，runSteps 分段；store 用真 store（临时目录），lark-cli 调用全部注入桩，不碰网络。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { runSteps } from './support/steps.mjs'

const dir = mkdtempSync(join(tmpdir(), 'lark-thread-link-'))
process.env.LARK_RUNTIME_DIR = join(dir, 'runtime')
process.env.LARK_OUTBOX_DIR = join(dir, 'outbox')
process.env.LARK_OBLIGATIONS_DIR = join(dir, 'obligations')
mkdirSync(process.env.LARK_RUNTIME_DIR, { recursive: true })

const { buildResumeSupplement, findThreadPredecessor, renderPredecessorBlock, renderSinceBlock, RESUME_SINCE_MAX_CHARS, splitThreadSince } = await import('../lib/lark-thread-link.mjs')
const { buildConversationBundle } = await import('../lib/lark-conversation-bundle.mjs')
const { createTaskStore } = await import('../lib/lark-task-store.mjs')

const BOT_OPEN = 'ou_bot'
const BOT_APP = 'cli_bot'
const config = { botOpenId: BOT_OPEN, botAppId: BOT_APP, project: 'PR-1' }
const quiet = async (fn) => {
  const spies = ['log', 'warn'].map((name) => { const original = console[name]; console[name] = () => {}; return () => { console[name] = original } })
  try {
    return await fn()
  } finally {
    for (const restore of spies) restore()
  }
}
const at = (iso) => Date.parse(iso)
// 话题列表（+threads-messages-list）的形状：update_time 只在编辑过时有；时间只到分钟（本机时区）。

describe('同话题前一单关联（11-04）', () => {
  let store
  let seq = 0
  after(() => rmSync(dir, { recursive: true, force: true }))

  it('前一单查找 / 话题切分 / 渲染 / 续跑补料 / 上下文包', () => runSteps([
    ['findThreadPredecessor：同话题（thread_id / root_id / 话题根就是任务）里本条之前最近的一单，任何状态都算；自己、别的话题、晚于本条的、非 lark 来源不算；没有话题键 → null', () => {
      const tasks = [
        { id: 'om_a', source: 'lark', threadRootId: 'omt_ol', status: 'superseded', closureReason: 'cancelled', messageCreatedAt: '2026-11-04T08:08:00Z' },
        { id: 'om_b', source: 'lark', threadRootId: 'omt_ol', status: 'blocked', createdAt: '2026-11-04T08:20:00Z' },
        { id: 'om_late', source: 'lark', threadRootId: 'omt_ol', status: 'received', createdAt: '2026-11-04T09:00:00Z' },
        { id: 'om_else', source: 'lark', threadRootId: 'omt_else', status: 'done', createdAt: '2026-11-04T08:30:00Z' },
        { id: 'om_bug', source: 'bugtable', threadRootId: 'omt_ol', status: 'done', createdAt: '2026-11-04T08:35:00Z' },
        { id: 'om_root', source: 'lark', threadRootId: null, status: 'done', createdAt: '2026-11-04T07:00:00Z' },
      ]
      const s = { list: () => tasks }
      const msg = { messageId: 'om_me', threadRootId: 'omt_ol', threadId: 'omt_ol', createTimeMs: at('2026-11-04T08:40:00Z') }
      assert.equal(findThreadPredecessor({ msg, store: s })?.id, 'om_b')
      assert.equal(findThreadPredecessor({ msg: { ...msg, createTimeMs: at('2026-11-04T08:10:00Z') }, store: s })?.id, 'om_a', '晚于本条的不算')
      assert.equal(findThreadPredecessor({ msg: { ...msg, messageId: 'om_b' }, store: s })?.id, 'om_a', '排除自己')
      assert.equal(findThreadPredecessor({ msg: { messageId: 'om_x', replyTo: 'om_root', createTimeMs: at('2026-11-04T08:40:00Z') }, store: s })?.id, 'om_root', '话题根就是任务消息')
      assert.equal(findThreadPredecessor({ msg: { messageId: 'om_x' }, store: s }), null)
      assert.equal(findThreadPredecessor({ msg: { messageId: 'om_x', threadRootId: 'omt_none' }, store: s }), null)
      assert.equal(findThreadPredecessor({ msg: { ...msg, createTimeMs: null }, store: s })?.id, 'om_late', '本条没时间：不按时间挡')
      assert.equal(findThreadPredecessor({ msg: { ...msg, createTimeMs: at('2026-11-04T08:20:00Z') }, store: s })?.id, 'om_b', '与本条同一时刻的算之前')
    }],
    ['splitThreadSince：前一单在列表里按位置切；它是话题根 → 全算之后；不在列表按分钟兜底；本条之后的不算；没有前一单 → 全在 before', () => {
      const items = [
        { messageId: 'om_x0', text: '更早', createTime: '2026-11-04 15:24' },
        { messageId: 'om_pred', text: '学习这个邮件', createTime: '2026-11-04 16:08' },
        { messageId: 'om_r1', text: 'bryn 發的可以直接作為a檔的範本', createTime: '2026-11-04 16:38' },
        { messageId: 'om_r2', text: '還有Hurley', createTime: '2026-11-04 16:39' },
        { messageId: 'om_bot', text: '收到你说的范本', createTime: '2026-11-04 16:54' },
        { messageId: 'om_nt', text: '没时间' },
      ]
      const msg = { messageId: 'om_me', createTimeMs: Date.parse('2026-11-04 16:40') }
      const ids = ({ before, since }) => [before.map((item) => item.messageId), since.map((item) => item.messageId)]
      assert.deepEqual(ids(splitThreadSince({ items, predecessor: { id: 'om_pred' }, msg })), [['om_x0', 'om_pred'], ['om_r1', 'om_r2', 'om_nt']])
      assert.deepEqual(ids(splitThreadSince({ items, predecessor: { id: 'om_root' }, msg: { ...msg, replyTo: 'om_root' } })), [[], ['om_x0', 'om_pred', 'om_r1', 'om_r2', 'om_nt']])
      assert.deepEqual(ids(splitThreadSince({ items, predecessor: { id: 'om_gone', messageCreatedAt: new Date(Date.parse('2026-11-04 16:08') + 30_000).toISOString() }, msg })), [['om_x0', 'om_nt'], ['om_pred', 'om_r1', 'om_r2']], '同一分钟算之后；没时间的按兜底留在 before')
      assert.deepEqual(ids(splitThreadSince({ items, predecessor: { id: 'om_pred' }, msg: { messageId: 'om_me' } })), [['om_x0', 'om_pred'], ['om_r1', 'om_r2', 'om_bot', 'om_nt']], '本条没时间：不挡之后的')
      assert.deepEqual(ids(splitThreadSince({ items, predecessor: null, msg })), [items.map((item) => item.messageId), []])
      assert.deepEqual(ids(splitThreadSince({ predecessor: { id: 'om_pred' }, msg })), [[], []])
      const edge = [items[1], { messageId: 'om_eq', text: '同一分钟', createTime: '2026-11-04 16:40' }, { messageId: 'om_next', text: '下一分钟', createTime: '2026-11-04 16:41' }]
      assert.deepEqual(ids(splitThreadSince({ items: edge, predecessor: { id: 'om_pred' }, msg })), [['om_pred'], ['om_eq']], '与本条同一时刻的算之前、要带')
    }],
    ['renderPredecessorBlock / renderSinceBlock / buildResumeSupplement：状态写人话（人工结单 / 已并入 / 原状态）、结果截 200 字、没摘要用正文；续跑补料只带正文里还没有的', () => {
      assert.equal(renderPredecessorBlock(null), '')
      assert.equal(renderPredecessorBlock({ id: 'om_a', status: 'superseded', closureReason: 'cancelled', summary: '学习这个邮件', result: '  卡在\n派错仓  ' }), '【同话题前一单】om_a（已人工结单（cancelled））：学习这个邮件\n上一轮结果：卡在 派错仓\n本条是同一话题里的后续 @：多半是前一单的延续，按前一单的目标 + 下面的补充要求一起处理；如果明显是另一件事，按新问题处理。')
      assert.match(renderPredecessorBlock({ id: 'om_b', status: 'superseded', supersededBy: 'om_c', text: '正文当摘要' }), /^【同话题前一单】om_b（已并入 om_c）：正文当摘要\n本条/)
      assert.match(renderPredecessorBlock({ id: 'om_d', status: 'blocked' }), /（blocked）：（无摘要）/)
      assert.ok(renderPredecessorBlock({ id: 'om_e', status: 'done', summary: 's', result: 'x'.repeat(300) }).includes(`上一轮结果：${'x'.repeat(200)}…`))
      assert.ok(renderPredecessorBlock({ id: 'om_e', status: 'done', summary: 's', result: 'x'.repeat(200) }).includes(`上一轮结果：${'x'.repeat(200)}\n`), '恰好 200 字不截')
      assert.match(renderPredecessorBlock({ id: 'om_f', status: 'superseded', summary: 's' }), /^【同话题前一单】om_f（superseded）：s\n/, 'superseded 但没有 supersededBy / closureReason → 原状态')
      assert.match(renderPredecessorBlock({ id: 'om_g', status: 'blocked', supersededBy: 'om_c', summary: 's' }), /^【同话题前一单】om_g（blocked）：s\n/, '有 supersededBy 但没 superseded → 原状态')
      assert.equal(renderSinceBlock({ since: [{ sender: 'Rou', text: '還有Hurley' }, { text: '' }], predecessor: { id: 'om_a' } }), '【前一单（om_a）之后话题里的消息——当作本单的补充要求】\nRou：還有Hurley\n（附件）')
      assert.deepEqual([renderSinceBlock({ since: [], predecessor: { id: 'om_a' } }), renderSinceBlock({ since: [{ text: 'x' }], predecessor: null })], ['', ''])
      const items = [{ messageId: 'om_a', text: '原话' }, { messageId: 'om_r1', sender: 'Rou', text: 'bryn 發的可以直接作為a檔的範本' }, { messageId: 'om_r2', sender: 'Rou', text: '已经并过的' }]
      const task = { id: 'om_a', text: '原话\n\n【话题补充 16:39】已经并过的' }
      assert.equal(buildResumeSupplement({ msg: { text: ' obey order of ROU ' }, task, items }), 'obey order of ROU\n\n【前一单（om_a）之后话题里的消息——当作本单的补充要求】\nRou：bryn 發的可以直接作為a檔的範本')
      assert.equal(buildResumeSupplement({ msg: { text: 'obey' }, task, items: items.slice(0, 1) }), 'obey', '没有新消息只续原话')
      assert.equal(buildResumeSupplement({ msg: { text: '' }, task, items }), '【前一单（om_a）之后话题里的消息——当作本单的补充要求】\nRou：bryn 發的可以直接作為a檔的範本')
      // 控制通道续跑（11-04 变异补测）：本条及之后按位置切（时间只到分钟挡不住）；这单自己的卡、本条回的那张 bot 卡不带，别的 bot 话照带；本条回的同事消息照带
      const head = '【前一单（om_a）之后话题里的消息——当作本单的补充要求】'
      const bot = (messageId, text) => ({ messageId, sender: 'bot（bot，我们自己）', text, bot: true })
      const thread = [{ messageId: 'om_a', text: '原话' }, bot('om_card', '要字段名'), bot('om_done', '别的单做完了'), bot('om_note', '我去问下'), { messageId: 'om_paste', sender: 'Rou', text: '字段叫 avatar_url' }, { messageId: 'om_me', sender: 'Q', text: '好了你看看' }, { messageId: 'om_late', sender: 'Rou', text: '更晚的' }]
      const parked = { id: 'om_a', text: '原话', receipts: [{ messageId: 'om_card' }] }
      assert.equal(buildResumeSupplement({ msg: { messageId: 'om_me', replyTo: 'om_done', text: '好了你看看' }, task: parked, items: thread }), `好了你看看\n\n${head}\nbot（bot，我们自己）：我去问下\nRou：字段叫 avatar_url`)
      assert.equal(buildResumeSupplement({ msg: { messageId: 'om_me', replyTo: 'om_paste', text: '好了' }, task: parked, items: thread.slice(4) }), `好了\n\n${head}\nRou：字段叫 avatar_url`, '回的是同事贴的材料：照带')
      assert.equal(buildResumeSupplement({ msg: { messageId: 'om_me', replyTo: 'om_a', text: '好了' }, task: parked, items: thread.slice(5) }), '好了', '本条排第一：之后的都不带')
      // 字数上限从最新往前留：恰好填满不截、再早的不带；单条超长截到上限
      const fill = [{ messageId: 'om_c', sender: 'C', text: 'c' }, { messageId: 'om_b', sender: 'B', text: 'b'.repeat(RESUME_SINCE_MAX_CHARS - 1000) }, { messageId: 'om_x', sender: 'X', text: 'x'.repeat(1000) }]
      assert.equal(buildResumeSupplement({ msg: { messageId: 'om_me', replyTo: 'om_a', text: '' }, task: parked, items: fill }), `${head}\nB：${'b'.repeat(RESUME_SINCE_MAX_CHARS - 1000)}\nX：${'x'.repeat(1000)}`)
      assert.equal(buildResumeSupplement({ msg: { messageId: 'om_me', replyTo: 'om_a', text: '' }, task: parked, items: [{ messageId: 'om_y', sender: 'Y', text: 'y'.repeat(RESUME_SINCE_MAX_CHARS + 5) }] }), `${head}\nY：${'y'.repeat(RESUME_SINCE_MAX_CHARS)}…`)
    }],
    ['上下文包：只有 thread_id 也按话题拉；前一单之前的进【话题其它回复】，之后的进补充要求块，排在本条后面', () => quiet(async () => {
      const fetched = []
      const threadCtx = [
        { messageId: 'om_pred', sender: 'Aven', senderOpenId: 'ou_aven', text: '学习这个邮件', attachments: [], createTime: '2026-11-04 16:08' },
        { messageId: 'om_r1', sender: 'Rou', senderOpenId: 'ou_rou', text: 'Key 跟brad 發的可以作為範本建立', attachments: [], createTime: '2026-11-04 16:39' },
      ]
      const deps = { fetchReferencedContext: async () => null, fetchThreadContext: async (id, opts) => { fetched.push([id, opts]); return threadCtx }, fetchRecentChatContext: async () => [], downloadAttachments: async ({ attachments }) => attachments }
      const msg = { messageId: 'om_me', chatId: 'oc_ol', senderOpenId: 'ou_aven', text: 'obey order of ROU', mentions: [], attachments: [], replyTo: null, threadId: 'omt_ol', createTimeMs: Date.parse('2026-11-04 16:40') }
      const predecessor = { id: 'om_pred', status: 'superseded', closureReason: 'cancelled', summary: '学习这个邮件' }
      const out = await buildConversationBundle({ msg, config, store: { list: () => [] }, predecessor, deps })
      assert.deepEqual(fetched, [['omt_ol', { excludeIds: ['om_me'], botOpenIds: [BOT_OPEN, BOT_APP] }]])
      assert.equal(out.text, [
        'obey order of ROU',
        '【同话题前一单】om_pred（已人工结单（cancelled））：学习这个邮件\n本条是同一话题里的后续 @：多半是前一单的延续，按前一单的目标 + 下面的补充要求一起处理；如果明显是另一件事，按新问题处理。',
        '【前一单（om_pred）之后话题里的消息——当作本单的补充要求】\nRou：Key 跟brad 發的可以作為範本建立',
        '【话题其它回复】\nAven：学习这个邮件',
      ].join('\n\n'))
      const plain = await buildConversationBundle({ msg: { ...msg, threadId: null }, config, store: { list: () => [] }, deps })
      assert.deepEqual([plain.text, fetched.length], ['obey order of ROU', 1], '没有话题不拉')
    })],
  ], {
    before: () => {
      store = createTaskStore({ tasksDir: join(dir, 'tasks', String(++seq)), leaseMs: 1000 })
    },
  }))
})
