/**
 * Lark 云文档（docx）小工具：把本地 Markdown 建成文档并设「获得链接的人可阅读」。
 * 外部群发不了文件（自定义机器人 webhook 只能发文本 / 富文本 / 卡片），所以待确认清单、日报完整版
 * 都走「用户身份建云文档 + 群里发链接」。失败只返回 reason，调用方决定降级。
 */

import { formatLarkCliError, larkCallFailed, runLarkCli } from './lark-cli.mjs'

export const createLarkDocFromMarkdown = async ({ title, dir, file, linkReadable = true }) => {
  const result = await runLarkCli(['docs', '+create', '--title', title, '--doc-format', 'markdown', '--content', `@${file}`, '--format', 'json'], { identity: 'user', cwd: dir, timeoutMs: 120_000 })
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
    // 外部同事要能打开：设成「获得链接的人可阅读」（aven 2026-10-13 定）。失败只告警，链接照发。
    const patched = await runLarkCli(['drive', 'permission.public', 'patch', '--yes', '--token', doc.document_id, '--type', 'docx', '--data', JSON.stringify({ external_access: true, link_share_entity: 'anyone_readable' })], { identity: 'user' })
    if (larkCallFailed(patched)) {
      shared = { ok: false, reason: formatLarkCliError(patched) }
      console.warn(`[lark-gateway] 云文档「${title}」设置链接可读失败：${shared.reason}`)
    }
  }
  return { ok: true, url: doc.url, documentId: doc.document_id, linkReadable: shared.ok }
}
