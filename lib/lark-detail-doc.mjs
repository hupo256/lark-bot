/**
 * 群消息只放结论，细节放 Lark 文档（aven 2026-10-22）：
 * 「收到」一句话概括任务；汇报先一句结论、说人话；引用上下文只概括；细节（curl、复现步骤、逐项证据、长清单）
 * 写进文档，群里只发链接——这样群消息本来就短，不需要截断。
 *
 * 两处用到：
 *   · 执行器结果里的 detailDoc（markdown）→ 建成文档，群消息末尾附「详细见：<url>」；
 *   · 发群前兜底：正文仍超过 GROUP_TEXT_MAX，不切，全文转成文档，群里留第一行结论 + 链接；建文档失败原样发（宁长不截）。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createLarkDocFromMarkdown } from './lark-docs.mjs'

export const GROUP_TEXT_MAX = 500

// 群消息里的 at 标签进文档没意义，换成空。
const stripAtTags = (text) => String(text || '').replace(/<at id=ou_[^>]*><\/at>\s*/g, '')

// 单测进程里（node --test 设 NODE_TEST_CONTEXT）默认不真建文档：没注入 create 的测试不会在 Lark 上留垃圾文档。
const defaultCreate = (args) => (process.env.NODE_TEST_CONTEXT ? Promise.resolve({ ok: false, reason: 'test' }) : createLarkDocFromMarkdown(args))

// markdown → 链接可读的 Lark 文档，返回 url；失败返回 null（调用方原样发，不丢内容）。
export const publishMarkdownDoc = async ({ title, markdown, create = defaultCreate }) => {
  const dir = mkdtempSync(join(tmpdir(), 'lark-detail-'))
  try {
    writeFileSync(join(dir, 'detail.md'), stripAtTags(markdown))
    const created = await create({ title, dir, file: 'detail.md' })
    if (!created?.ok) console.warn(`[lark-gateway] 细节文档「${title}」没建成：${created?.reason || '未知原因'}`)
    return created?.ok ? created.url : null
  } catch (error) {
    console.warn(`[lark-gateway] 细节文档「${title}」没建成：${String(error?.message || error).slice(0, 160)}`)
    return null
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// 发群前兜底：超长就整段转文档，群里留第一行（结论，含 @）+ 链接。
export const keepGroupTextShort = async ({ text, title, max = GROUP_TEXT_MAX, publish = publishMarkdownDoc }) => {
  const body = String(text || '')
  if (body.length <= max) return { text: body, docUrl: null }
  const url = await publish({ title, markdown: body })
  if (!url) return { text: body, docUrl: null }
  const lead = body.split('\n').find((line) => line.trim()) || ''
  return { text: `${lead}\n完整内容：${url}`, docUrl: url }
}
