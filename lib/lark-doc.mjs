/**
 * Lark 文档预取：Worker 在跑 AI 之前，把任务正文引用的 Lark 文档（PRD / Wiki）用 lark-cli 抓成本地
 * markdown 落盘，供 AI 必读。跑 AI 的 worktree 沙箱没有 lark-cli 凭证读不到，宿主机（Worker）有 user
 * 凭证读得到——这段把差距补上，与 Figma 预取（lark-figma.mjs）完全同构。
 *
 * 纯函数（链接提取、类型判定、文件名）便于单测；prefetchLarkDocs 触发子进程 + 落盘。抓取只走
 * validateSource 的只读安全闸（+fetch/+read/+search，禁写），凭证是 --as user、只能读该用户可访问的文档。
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { validateSource } from '../../engine/agent-scripts/lib/lark-command.mjs'
import { parseLarkDocumentPayload } from '../../engine/agent-scripts/lib/lark-prd-drift.mjs'

// 仅正文类文档：wiki / docx / docs / doc。刻意不含 /sheets/——PRD 内嵌的 <sheet> 是文档内引用而非正文
// URL，表格结构化抓取另议。host 段用 [^\s/]* 吃掉子域（如 qfglxo2m3dc.sg.larksuite.com），收尾照抄
// Figma 的 [^\s)"'`>] 排除尾随空白 / 括号 / 引号。同时覆盖 larksuite.com 与 feishu.cn。
const LARK_DOC_URL_RE = /https?:\/\/[^\s/]*(?:larksuite\.com|feishu\.cn)\/(?:wiki|docx|docs|doc)\/[^\s)"'`>]+/gi
const defaultPrefetchTimeoutMs = Number(process.env.LARK_DOC_PREFETCH_TIMEOUT_MS || 120000)

// 任务正文里去重后的 Lark 文档链接。与 buildTaskPrompt 的引用判定同口径。纯函数。
export const extractLarkDocUrls = (text) => {
  const matches = String(text || '').match(LARK_DOC_URL_RE) || []
  return [...new Set(matches.map((u) => u.trim()))]
}

// 任务是否引用了 Lark 文档。纯函数。
export const taskReferencesLarkDocs = (text) => extractLarkDocUrls(text).length > 0

// 链接类型判定（与 project-scaffold::sourceTypeFromPrd 同口径）：/wiki/ → wiki，其余（docx/docs/doc）→ doc。
// validateSource 内部会把 wiki/doc 都归一到 docs 服务的 +fetch，此处只需给出它接受的 type。纯函数。
export const sourceTypeFromLarkUrl = (url) => (/\/wiki\//i.test(String(url || '')) ? 'wiki' : 'doc')

// 从链接末段 token 生成安全落盘文件名（lark-doc-<token>.md）。非法字符替换为下划线，防路径穿越。纯函数。
export const larkDocSlug = (url) => {
  const token = String(url || '').split(/[?#]/)[0].split('/').filter(Boolean).pop() || 'doc'
  return `lark-doc-${token.replace(/[^\w.-]/g, '_')}.md`
}

// 预取任务正文引用的所有 Lark 文档到 outDir：逐链接走 validateSource 的只读闸构造命令、spawn lark-cli、
// 解析 JSON envelope 拿 markdown 正文落盘。任一链接失败即 ok:false → 上层 fail-closed 转人工（绝不让 AI
// 缺 PRD 硬做）。返回 { referencesLarkDocs, urls, docs:[{url,path}], ok, error }。
export const prefetchLarkDocs = ({ text, outDir, timeoutMs = defaultPrefetchTimeoutMs } = {}) => {
  const urls = extractLarkDocUrls(text)
  if (!urls.length) return { referencesLarkDocs: false, urls: [], docs: [], ok: false, error: null }

  mkdirSync(outDir, { recursive: true })
  const docs = []
  const failures = []
  for (const url of urls) {
    try {
      const command = validateSource({ type: sourceTypeFromLarkUrl(url), url })
      if (!command) throw new Error('未构造出远程抓取命令（疑似被判为本地 markdown）')
      const run = spawnSync(command[0], command.slice(1), { encoding: 'utf8', timeout: timeoutMs, env: process.env })
      if (run.error) throw run.error
      if (run.status !== 0) {
        throw new Error((run.stderr || run.stdout || `lark-cli exit ${run.status}`).trim().split('\n').slice(-1)[0])
      }
      const { content } = parseLarkDocumentPayload(run.stdout)
      const path = join(outDir, larkDocSlug(url))
      writeFileSync(path, content)
      docs.push({ url, path })
    } catch (error) {
      failures.push(`${url} → ${error.message || error}`)
    }
  }
  const ok = docs.length === urls.length
  return {
    referencesLarkDocs: true,
    urls,
    docs,
    ok,
    error: ok ? null : `Lark 文档读取失败：${failures.join('；')}`,
  }
}
