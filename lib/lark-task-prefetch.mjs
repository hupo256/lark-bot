/**
 * 跑 AI 前预取任务引用的 Figma 设计稿与 Lark 文档（从 lark-task-runner 拆出，体量预算）。
 *
 * 口径（10-22 / 10-23）：
 *   · 主消息（本条 / 被引用 / 负责人指示）里引用的读不到 → 实施任务 fail-closed 停在实施前（PR-02172 / PR-01644：不凭截图、不缺 PRD 硬做）；
 *   · 上下文（之前的群消息、话题其它回复）里的读不到 → 记 skipped，照常跑，提示里告诉 AI 哪些没读到；
 *   · 只读任务（代答提问）也预取（原来不预取，别人问「PRD 里怎么定的」bot 看不到 PRD），但永远不拦：
 *     读不到的一律记 skipped，照常回答并说明没读到。
 */

import { prefetchLarkDocs, taskReferencesLarkDocs } from './lark-doc.mjs'
import { prefetchFigmaSpec, taskReferencesFigma } from './lark-figma.mjs'

const BLOCKS = {
  figma: {
    summary: '任务引用了 Figma 设计稿，但 Worker 无法读取设计稿规格，已停在实施之前等待处理（避免凭截图硬做）。',
    nextStep: '确认 Figma 链接可访问、node-id 正确，且 Worker 已配置有效的 FIGMA_API_KEY 后重试。',
  },
  larkDocs: {
    summary: '任务引用了 Lark 文档（PRD / Wiki），但 Worker 无法读取文档正文，已停在实施之前等待处理（避免缺 PRD 硬做）。',
    nextStep: '确认文档链接可访问、且 Worker 的 lark-cli 已授权（--as user）后重试。',
  },
}

// 只读任务读不到也不拦：失败并进 skipped，按「读到了」交给提示（提示里列出 skipped）。
const softenForReadOnly = (result) => ({ ...result, ok: true, error: null, skipped: [...(result.skipped || []), ...(result.failures || [])], failures: [] })

// 返回 { audit, notes, block }：audit 并进任务审计；notes 是要打的日志；block 非空 = 实施任务要停在实施前（{ summary, blockers, nextStep }）。
// 结果挂在 task.figmaSpec / task.larkDocs 上（buildTaskPrompt 读）。deps 供单测注入。
export const prefetchTaskReferences = ({ task, readOnly, outDir, deps = {} }) => {
  const fetchFigma = deps.prefetchFigmaSpec || prefetchFigmaSpec
  const fetchDocs = deps.prefetchLarkDocs || prefetchLarkDocs
  const audit = {}
  const notes = []
  const steps = [
    ['figma', 'figmaSpec', taskReferencesFigma, fetchFigma, (r) => ({ urls: r.urls, specs: r.specs.map((s) => s.dir), skipped: r.skipped, ok: r.ok })],
    ['larkDocs', 'larkDocs', taskReferencesLarkDocs, fetchDocs, (r) => ({ urls: r.urls, docs: r.docs.map((d) => d.path), skipped: r.skipped, ok: r.ok })],
  ]
  for (const [kind, slot, references, fetch, toAudit] of steps) {
    if (!references(task.text)) continue
    let result = fetch({ text: task.text, outDir })
    if (!result.ok && readOnly) result = softenForReadOnly(result)
    task[slot] = result
    audit[kind === 'figma' ? 'figma' : 'larkDocs'] = toAudit(result)
    if (result.skipped?.length) notes.push(`${kind === 'figma' ? 'Figma 设计稿' : 'Lark 文档'} ${result.skipped.length} 份没读到（不拦）：${result.skipped.map((item) => item.url).join('、')}`)
    if (!result.ok) return { audit, notes, block: { ...BLOCKS[kind], blockers: [result.error] } }
  }
  return { audit, notes, block: null }
}
