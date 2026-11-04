/**
 * Lark 云文档（docx）小工具（falive lark-docs + lark-detail-doc 合并，对话层 11-01）：
 * 群消息只放结论，细节放文档（aven 2026-10-22）——执行器结果里的 detailDoc 建成文档、群消息末尾附链接；
 * 发群前兜底：正文仍超过 GROUP_TEXT_MAX，不切，全文转成文档，群里留第一行结论 + 链接；建文档失败原样发（宁长不截）。
 * 建文档走用户身份（bot 没有 docs scope），可用 config.docIdentity 改；失败只返回 reason，调用方决定降级。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { formatLarkCliError, larkCallFailed, runLarkCli } from './lark-cli.mjs'

export const GROUP_TEXT_MAX = 500

// 本地 Markdown 文件 → 云文档，设「获得链接的人可阅读」（外部同事要能打开；失败只告警，链接照发）。
export const createLarkDocFromMarkdown = async ({ title, dir, file, identity = 'user', linkReadable = true, run = runLarkCli }) => {
  const result = await run(['docs', '+create', '--title', title, '--doc-format', 'markdown', '--content', `@${file}`, '--format', 'json'], { identity, cwd: dir, timeoutMs: 120_000 })
  if (larkCallFailed(result)) return { ok: false, reason: formatLarkCliError(result) }
  let doc
  try {
    doc = JSON.parse(result.stdout).data?.document || {}
  } catch (error) {
    return { ok: false, reason: `解析失败：${error.message}` }
  }
  if (!doc.url) return { ok: false, reason: '未返回文档 url' }
  let shared = { ok: true }
  if (linkReadable) {
    const patched = await run(['drive', 'permission.public', 'patch', '--yes', '--token', doc.document_id, '--type', 'docx', '--data', JSON.stringify({ external_access: true, link_share_entity: 'anyone_readable' })], { identity })
    if (larkCallFailed(patched)) {
      shared = { ok: false, reason: formatLarkCliError(patched) }
      console.warn(`[lark-gateway] 云文档「${title}」设置链接可读失败：${shared.reason}`)
    }
  }
  return { ok: true, url: doc.url, documentId: doc.document_id, linkReadable: shared.ok }
}

// 群消息里的 at 标签进文档没意义，换成名字（post-md 写法 <at user_id="ou_x">名</at>）；旧卡片写法 <at id=ou_x></at> 直接去掉。
const stripAtTags = (text) => String(text || '').replace(/<at user_id="[^"]*">([^<]*)<\/at>/g, '$1').replace(/<at id=ou_[^>]*><\/at>\s*/g, '')

// 单测进程里（node --test 设 NODE_TEST_CONTEXT）默认不真建文档：没注入 create 的测试不会在 Lark 上留垃圾文档。
const defaultCreate = (args) => (process.env.NODE_TEST_CONTEXT ? Promise.resolve({ ok: false, reason: 'test' }) : createLarkDocFromMarkdown(args))

// markdown → 链接可读的云文档，返回 { ok, url, reason }；失败不抛（调用方原样发，不丢内容）。
export const publishMarkdownDoc = async ({ title, markdown, create = defaultCreate, identity = 'user' }) => {
  const dir = mkdtempSync(join(tmpdir(), 'lark-detail-'))
  try {
    writeFileSync(join(dir, 'detail.md'), stripAtTags(markdown))
    const created = await create({ title, dir, file: 'detail.md', identity })
    if (!created?.ok) {
      console.warn(`[lark-gateway] 细节文档「${title}」没建成：${created?.reason || '未知原因'}`)
      return { ok: false, url: null, reason: created?.reason || '未知原因' }
    }
    return { ok: true, url: created.url, reason: null }
  } catch (error) {
    const reason = String(error?.message || error).slice(0, 160)
    console.warn(`[lark-gateway] 细节文档「${title}」没建成：${reason}`)
    return { ok: false, url: null, reason }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// 发群前兜底：超长就整段转文档，群里留第一行（结论，含 @）+ 链接；建不成原文不动（never truncate）。
// keepLeading：群里多留开头几行（整行，放得下为止，链接留出 LINK_ROOM）。改码 done 带复测条目时用（lark-delivery）：
// 11-04 b3 ep-1031-35935b「收到」答应了 pre 复测，结论超长只留第一行（改码摘要），复测没做这条只在文档里，群里看着像没兑现。
const LINK_ROOM = 120
const leadOf = (body, { keepLeading = false, max = GROUP_TEXT_MAX } = {}) => {
  const lines = body.split('\n').filter((line) => line.trim())
  const kept = [lines[0] || '']
  for (const line of keepLeading ? lines.slice(1) : []) {
    if ([...kept, line].join('\n').length > max - LINK_ROOM) break
    kept.push(line)
  }
  return kept.join('\n')
}
export const keepGroupTextShort = async ({ text, title, max = GROUP_TEXT_MAX, publish = publishMarkdownDoc, keepLeading = false }) => {
  const body = String(text || '')
  if (body.length <= max) return { text: body, docUrl: null, overflowed: false }
  const published = await publish({ title, markdown: body })
  if (!published?.ok || !published.url) return { text: body, docUrl: null, overflowed: true }
  return { text: `${leadOf(body, { keepLeading, max })}\n完整内容：${published.url}`, docUrl: published.url, overflowed: true }
}
