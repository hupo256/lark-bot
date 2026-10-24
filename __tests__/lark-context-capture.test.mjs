import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { pickRecentAttachments, shortTime } from '../lib/lark-chat-context.mjs'
import { prefetchTaskReferences } from '../lib/lark-task-prefetch.mjs'
import { buildIntentClassificationPrompt, formatTaskAttachments } from '../lib/lark-classify-prompt.mjs'
import { fetchRecentChatContext } from '../lib/lark-cli.mjs'
import { registerRepoProfiles, resetRepoProfiles } from '../lib/lark-repo-profile.mjs'
import { runSteps } from './support/steps.mjs'

// 10-23 起外部群只响应 @bot：没 @ 的讨论只能靠 @bot 时读上下文带进来，要读全。
describe('@bot 时的上下文读取', () => {
  it('前文附件挑选、时间格式化、附件列表标明来源', () => runSteps([
    ['之前群消息里的附件：从新到旧挑，图片 / 文件各有上限，按消息分组', () => {
      const img = (key) => ({ type: 'image', imageKey: key })
      const file = (name) => ({ type: 'file', fileKey: `fk_${name}`, fileName: name })
      const recent = [
        { messageId: 'm1', attachments: [img('a'), img('b'), file('old.zip')] },
        { messageId: 'm2', attachments: [] },
        { messageId: 'm3', attachments: [img('c'), img('d'), img('e')] },
        { messageId: 'm4', attachments: [file('new.pdf')] },
      ]
      const out = pickRecentAttachments(recent, { maxImages: 4, maxFiles: 1 })
      assert.deepEqual(out.map((group) => group.item.messageId), ['m4', 'm3', 'm1'], '离 @bot 越近越先')
      assert.deepEqual(out.find((group) => group.item.messageId === 'm3').attachments.map((item) => item.imageKey), ['c', 'd', 'e'])
      assert.deepEqual(out.find((group) => group.item.messageId === 'm1').attachments, [img('a')], '图片只剩一张名额，文件名额被新的占了')
    }],
    ['时间：lark-cli 的本地时间字符串直接截成「月-日 时:分」，时间戳按本地时间换，拿不到给空', () => {
      assert.equal(shortTime('2026-10-23 13:28'), '10-23 13:28')
      const ms = new Date(2026, 9, 22, 21, 4).getTime()
      assert.equal(shortTime(ms), '10-22 21:04')
      assert.equal(shortTime(String(ms)), '10-22 21:04')
      assert.equal(shortTime(''), '')
    }],
    ['附件列表带文件名和来源，模型分得清哪张图是本条的、哪张是前文的', () => {
      const text = formatTaskAttachments({ attachments: [{ type: 'file', fileName: 'a.md', origin: '本条', localPath: '/x/a.md' }, { type: 'image', origin: '群里之前的消息 · Encone 10-23 13:28', localPath: '/x/b.png' }] })
      assert.match(text, /1\. file「a\.md」；来源：本条；本地路径：\/x\/a\.md/)
      assert.match(text, /2\. image；来源：群里之前的消息 · Encone 10-23 13:28/)
    }],
    ['分类提示写明本条发送人：登记成员带角色、本人标本人、没有发送人写「未知」（变异补测 10-24）', () => {
      registerRepoProfiles({ repos: { falive: { root: '/tmp/lark-ctx-capture-no-such-repo', baseRef: 'main', chatIds: ['oc_ctx'], ownership: { me: 'aven', meOpenIds: ['ou_aven'] }, ownerMap: { henry: 'ou_henry' }, memberRoles: { henry: 'live php 后端' } } } })
      try {
        const prompt = (operator) => buildIntentClassificationPrompt({ id: 't', repo: 'falive', text: '这个按钮不对', attachments: [], ...(operator ? { operator } : {}) }, { ledger: { items: {}, events: [] } })
        assert.match(prompt('ou_henry'), /本条发送人：henry（live php 后端）；/)
        assert.match(prompt('ou_aven'), /本条发送人：aven 本人；/)
        assert.match(prompt(null), /本条发送人：未知；/)
      } finally {
        resetRepoProfiles()
      }
    }],
  ]))
})

describe('设计稿 / 文档预取口径', () => {
  const docs = (result) => () => ({ referencesLarkDocs: true, urls: ['u'], docs: [], skipped: [], failures: [], ...result })
  const task = (text) => ({ id: 't', text })
  const LINK = 'https://x.larksuite.com/docx/AAAAAAAAAAAAAAAAAAAAAAAAAAA'

  it('预取口径：实施任务读不到就停、只读任务照常答，没引用不预取，Figma 同口径', () => runSteps([
    ['实施任务：主消息里的读不到 → 停在实施前；只读任务（代答）读不到也不拦，记进 skipped 照常答', () => {
      const failing = docs({ ok: false, failures: [{ url: LINK, reason: '403' }], error: `Lark 文档读取失败：${LINK} → 403` })
      const run = prefetchTaskReferences({ task: task(`按这个做 ${LINK}`), readOnly: false, outDir: '/tmp', deps: { prefetchLarkDocs: failing } })
      assert.match(run.block.summary, /Lark 文档/)
      assert.deepEqual(run.block.blockers, [`Lark 文档读取失败：${LINK} → 403`])
      const ask = task(`PRD 里怎么定的？${LINK}`)
      const answer = prefetchTaskReferences({ task: ask, readOnly: true, outDir: '/tmp', deps: { prefetchLarkDocs: failing } })
      assert.equal(answer.block, null)
      assert.equal(ask.larkDocs.ok, true)
      assert.deepEqual(ask.larkDocs.skipped, [{ url: LINK, reason: '403' }])
      assert.match(answer.notes[0], /1 份没读到（不拦）/)
    }],
    ['没引用就不预取；Figma 读不到同样按主消息 / 只读口径', () => {
      const none = prefetchTaskReferences({ task: task('改个按钮颜色'), readOnly: false, outDir: '/tmp', deps: { prefetchLarkDocs: () => { throw new Error('不该调') } } })
      assert.deepEqual(none, { audit: {}, notes: [], block: null })
      const figmaFail = () => ({ referencesFigma: true, urls: ['f'], specs: [], skipped: [], failures: [{ url: 'f', reason: 'x' }], ok: false, error: 'Figma 设计稿读取失败：f → x' })
      const figmaLink = 'https://www.figma.com/design/AbCd1234/Falive?node-id=1-2'
      assert.match(prefetchTaskReferences({ task: task(`照这个稿 ${figmaLink}`), readOnly: false, outDir: '/tmp', deps: { prefetchFigmaSpec: figmaFail } }).block.summary, /Figma/)
      assert.equal(prefetchTaskReferences({ task: task(`照这个稿 ${figmaLink}`), readOnly: true, outDir: '/tmp', deps: { prefetchFigmaSpec: figmaFail } }).block, null)
    }],
  ]))
})

describe('消息正文格式', () => {
  it('整条被 <p>…</p> 包着的转成换行；正文中间零散的 <p>（贴 HTML 代码）不动', async () => {
    const { unwrapParagraphs, parseTextAndAttachments } = await import('../lib/lark-message.mjs')
    assert.equal(unwrapParagraphs('<p>@Kevin web 端已提测</p><p>相关 bug 抛到话题下</p>'), '@Kevin web 端已提测\n相关 bug 抛到话题下')
    assert.equal(unwrapParagraphs('模板里写 <p>标题</p> 就行'), '模板里写 <p>标题</p> 就行')
    assert.equal(parseTextAndAttachments({ messageType: 'text', rawContent: '<p>第一段</p><p>第二段</p>', mentions: [] }).text, '第一段\n第二段')
  })
})

// 10-23 #74：bot 22:46 在结果里 @Encone 要主播号，他第二天 10:36 才 @bot 说给了——按时间窗截就丢了那张卡。
describe('群里这条之前的消息：取紧挨着的最近 N 条，不按时间窗截', () => {
  const at = (iso) => String(Date.parse(iso))
  const human = (id, iso, text) => ({ message_id: id, msg_type: 'text', create_time: at(iso), sender: { sender_type: 'user', id: 'ou_x', name: 'Encone' }, content: JSON.stringify({ text }) })
  const bot = (id, iso, text) => ({ message_id: id, msg_type: 'text', create_time: at(iso), sender: { sender_type: 'app', open_bot_id: 'ou_bot', name: 'Aven.Bot' }, content: JSON.stringify({ text }) })
  const beforeMs = Date.parse('2026-10-23T02:36:00Z')

  it('前文取紧挨的最近 N 条：12 小时前的 bot 卡照带，不够就翻页、最多 maxPages', () => runSteps([
    ['12 小时前 bot 向他要东西的卡、中间没人说话：照样带上', async () => {
      const calls = []
      const list = async (args) => {
        calls.push(args)
        return { ok: true, messages: [bot('om_card', '2026-10-22T14:46:00Z', '@Encone 给一个 pre 主播测试号，用来实测开播写入')], hasMore: false, pageToken: null }
      }
      const out = await fetchRecentChatContext({ chatId: 'oc', beforeMs, botOpenIds: ['ou_bot'], list })
      assert.deepEqual(out.map((item) => item.messageId), ['om_card'])
      assert.match(out[0].sender, /bot，我们自己/)
      assert.equal(calls[0].order, 'desc')
      assert.ok(beforeMs / 1000 - Number(calls[0].start) >= 7 * 24 * 3600 - 1, '兜底拉取范围 7 天')
    }],
    ['一页凑不够 N 条就往前翻页；凑够了就停；最多翻 maxPages 页', async () => {
      const pages = [
        { ok: true, messages: [human('m3', '2026-10-23T02:00:00Z', '三'), { message_id: 'sys', msg_type: 'system', create_time: at('2026-10-23T01:00:00Z'), sender: {} }], hasMore: true, pageToken: 'p2' },
        { ok: true, messages: [human('m2', '2026-10-22T20:00:00Z', '二'), human('m1', '2026-10-21T20:00:00Z', '一')], hasMore: true, pageToken: 'p3' },
        { ok: true, messages: [human('m0', '2026-10-20T20:00:00Z', '零')], hasMore: false, pageToken: null },
      ]
      let index = 0
      const out = await fetchRecentChatContext({ chatId: 'oc', beforeMs, limit: 3, list: async () => pages[index++] })
      assert.deepEqual(out.map((item) => item.messageId), ['m1', 'm2', 'm3'], '按时间正序、最新的在后')
      assert.equal(index, 2, '凑够 3 条就不再翻')
      index = 0
      assert.equal((await fetchRecentChatContext({ chatId: 'oc', beforeMs, limit: 10, maxPages: 2, list: async () => pages[index++] })).length, 3)
      assert.deepEqual(await fetchRecentChatContext({ chatId: 'oc', beforeMs, list: async () => ({ ok: false }) }), [])
    }],
  ]))
})
