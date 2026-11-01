import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { splitTaskTextByOrigin } from '../lib/lark-doc.mjs'
import { prefetchTaskReferences } from '../lib/lark-task-prefetch.mjs'
import { prefetchFigmaSpec } from '../lib/lark-figma.mjs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildTaskPrompt } from '../lib/lark-worker-prompts.mjs'
import { runSteps } from './support/steps.mjs'

const LINK = 'https://qfglxo2m3dc.sg.larksuite.com/docx/LWj1dpDVToJLzTxcLs8ltUtqgvc'
const CONTEXT_LINK = 'https://qfglxo2m3dc.sg.larksuite.com/docx/AAAAdpDVToJLzTxcLs8ltUtqgvc'
const FIGMA = 'https://www.figma.com/design/AbCd1234/Web?node-id=1-2'
const task = (text) => ({ id: 't', text, attachments: [] })
const docs = (result) => () => ({ referencesLarkDocs: true, urls: [LINK], docs: [], skipped: [], failures: [], ok: true, error: null, ...result })

describe('预取口径（从 falive 移植 10-22 / 10-23）：主消息引用读不到才拦，上下文 / 只读任务读不到只记 skipped', () => {
  it('正文按来源拆分；实施任务主消息读不到 → 停在实施前；上下文里的、只读任务的读不到 → skipped 照常跑并写进提示；没引用不预取', () => runSteps([
    ['【话题其它回复】之后的算上下文，【本条 @】算主消息', () => {
      const split = splitTaskTextByOrigin(`【被引用消息】\n看 ${LINK}\n\n【本条 @】照做\n\n【话题其它回复】\nEncone：之前的 ${CONTEXT_LINK}`)
      assert.match(split.primary, new RegExp(LINK))
      assert.doesNotMatch(split.primary, new RegExp(CONTEXT_LINK))
      assert.match(split.context, new RegExp(CONTEXT_LINK))
    }],
    ['实施任务：主消息里的读不到 → block；只读任务（代答）读不到也不拦，记进 skipped 照常答', () => {
      const failing = docs({ ok: false, failures: [{ url: LINK, reason: '403' }], error: `Lark 文档读取失败：${LINK} → 403` })
      const run = prefetchTaskReferences({ task: task(`按这个做 ${LINK}`), readOnly: false, outDir: '/tmp', deps: { prefetchLarkDocs: failing } })
      assert.match(run.block.summary, /Lark 文档/)
      assert.deepEqual(run.block.blockers, [`Lark 文档读取失败：${LINK} → 403`])
      assert.deepEqual(run.audit.larkDocs.urls, [LINK])
      const ask = task(`PRD 里怎么定的？${LINK}`)
      const answer = prefetchTaskReferences({ task: ask, readOnly: true, outDir: '/tmp', deps: { prefetchLarkDocs: failing } })
      assert.equal(answer.block, null)
      assert.equal(ask.larkDocs.ok, true)
      assert.deepEqual(ask.larkDocs.skipped, [{ url: LINK, reason: '403' }])
      assert.match(answer.notes[0], /^Lark 文档 1 份没读到（不拦）/)
      // 老格式结果没有 skipped 字段：只读软化后 skipped 就是 failures
      const bare = task(`看 ${LINK}`)
      prefetchTaskReferences({ task: bare, readOnly: true, outDir: '/tmp', deps: { prefetchLarkDocs: () => ({ referencesLarkDocs: true, urls: [LINK], docs: [], failures: [{ url: LINK, reason: '403' }], ok: false, error: 'x' }) } })
      assert.deepEqual(bare.larkDocs.skipped, [{ url: LINK, reason: '403' }])
      // 提示里列出没读到的，让 AI 说明而不是硬猜
      const prompt = buildTaskPrompt({ projectId: 'PR-00001', projectName: 'test', projectDocs: [], cwd: '/tmp/repo' }, ask, 'claude')
      assert.match(prompt, /这些链接没读到.*403.*照常用手上的材料做/)
    }],
    ['上下文里的读不到：ok 仍为 true、skipped 记下、不 block', () => {
      const partial = docs({ ok: true, docs: [{ url: LINK, path: '/tmp/a.md' }], skipped: [{ url: CONTEXT_LINK, reason: '链接不完整（被截断）' }] })
      const t = task(`照 ${LINK}\n【话题其它回复】\n${CONTEXT_LINK}`)
      const run = prefetchTaskReferences({ task: t, readOnly: false, outDir: '/tmp', deps: { prefetchLarkDocs: partial } })
      assert.equal(run.block, null)
      assert.deepEqual(run.audit.larkDocs.skipped.map((s) => s.url), [CONTEXT_LINK])
      assert.deepEqual(run.audit.larkDocs.docs, ['/tmp/a.md'])
      assert.equal(run.notes.length, 1)
    }],
    ['真跑 figma-spec（没配 token 必失败）：主消息里的设计稿读不到 → ok:false；只在【话题其它回复】里的 → ok:true 记 skipped', () => {
      const saved = { FIGMA_API_KEY: process.env.FIGMA_API_KEY, FIGMA_TOKEN: process.env.FIGMA_TOKEN }
      delete process.env.FIGMA_API_KEY
      delete process.env.FIGMA_TOKEN
      const outDir = mkdtempSync(join(tmpdir(), 'lark-figma-prefetch-'))
      try {
        const primary = prefetchFigmaSpec({ text: `照这个稿 ${FIGMA}`, outDir })
        assert.deepEqual([primary.ok, primary.specs.length, primary.failures.length, primary.skipped.length], [false, 0, 1, 0])
        assert.match(primary.error, /Figma 设计稿读取失败/)
        const contextOnly = prefetchFigmaSpec({ text: `改个颜色\n【话题其它回复】\nEncone：参考 ${FIGMA}`, outDir })
        assert.deepEqual([contextOnly.ok, contextOnly.error, contextOnly.skipped.length, contextOnly.failures.length], [true, null, 1, 0])
      } finally {
        for (const [key, value] of Object.entries(saved)) if (value !== undefined) process.env[key] = value
        rmSync(outDir, { recursive: true, force: true })
      }
    }],
    ['没引用就不预取；Figma 读不到同样按主消息 / 只读口径', () => {
      const none = prefetchTaskReferences({ task: task('改个按钮颜色'), readOnly: false, outDir: '/tmp', deps: { prefetchLarkDocs: () => { throw new Error('不该调') }, prefetchFigmaSpec: () => { throw new Error('不该调') } } })
      assert.deepEqual(none, { audit: {}, notes: [], block: null })
      const figmaFail = () => ({ referencesFigma: true, urls: [FIGMA], specs: [], skipped: [], failures: [{ url: FIGMA, reason: 'x' }], ok: false, error: `Figma 设计稿读取失败：${FIGMA} → x` })
      const blocked = prefetchTaskReferences({ task: task(`照这个稿 ${FIGMA}`), readOnly: false, outDir: '/tmp', deps: { prefetchFigmaSpec: figmaFail } })
      assert.match(blocked.block.summary, /Figma/)
      assert.match(blocked.block.nextStep, /FIGMA_API_KEY/)
      assert.equal(prefetchTaskReferences({ task: task(`照这个稿 ${FIGMA}`), readOnly: true, outDir: '/tmp', deps: { prefetchFigmaSpec: figmaFail } }).block, null)
      // 注入的 Figma 预取成功 → 审计记落盘目录；上下文里读不到的记 skipped、note 标 Figma
      const figmaOk = () => ({ referencesFigma: true, urls: [FIGMA], specs: [{ url: FIGMA, dir: '/tmp/spec-1' }], skipped: [{ url: 'https://www.figma.com/design/Zz/Ctx?node-id=3-4', reason: '403' }], failures: [], ok: true, error: null })
      const ok = prefetchTaskReferences({ task: task(`照这个稿 ${FIGMA}`), readOnly: false, outDir: '/tmp', deps: { prefetchFigmaSpec: figmaOk } })
      assert.equal(ok.block, null)
      assert.deepEqual(ok.audit.figma.specs, ['/tmp/spec-1'])
      assert.match(ok.notes[0], /^Figma 设计稿 1 份没读到（不拦）/)
    }],
  ]))
})
