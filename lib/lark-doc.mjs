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

import { validateSource } from './vendor/lark-command.mjs'
import { parseLarkDocumentPayload } from './vendor/lark-prd-drift.mjs'

// 仅正文类文档：wiki / docx / docs / doc。刻意不含 /sheets/——PRD 内嵌的 <sheet> 是文档内引用而非正文
// URL，表格结构化抓取另议。host 段用 [^\s/]* 吃掉子域（如 qfglxo2m3dc.sg.larksuite.com），收尾与 Figma
// 同口径：遇空白 / 方括号 / 圆括号 / 反斜杠 / 引号 / 尖括号即止——markdown 链接 [URL](URL) 与转义的 \]
// 不能被吞进地址（10-14 把 `URL](URL` 当一个链接去抓，读失败）。同时覆盖 larksuite.com 与 feishu.cn。
const LARK_DOC_URL_RE = /https?:\/\/[^\s/]*(?:larksuite\.com|feishu\.cn)\/(?:wiki|docx|docs|doc)\/[^\s()[\]\\"'`<>]+/gi
const defaultPrefetchTimeoutMs = Number(process.env.LARK_DOC_PREFETCH_TIMEOUT_MS || 120000)

// 任务正文里去重后的 Lark 文档链接。与 buildTaskPrompt 的引用判定同口径。纯函数。
// 末尾 URL 编码的括号（%5B %5D %28 %29）一并剥掉：Lark 渲染坏 markdown 链接时会把 ] 编码进地址。
export const extractLarkDocUrls = (text) => {
  const matches = String(text || '').match(LARK_DOC_URL_RE) || []
  return [...new Set(matches.map((u) => u.trim().replace(/(?:%5[BD]|%2[89])+$/i, '')))]
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

// 任务正文按来源分两份（10-22 Bug-4944：上下文里 bot 自己发过的云文档链接被截成半截，读不到就把整条任务停了，还去群里要）。
// primary = 本条 / 被引用消息 / 附件说明 / 负责人指示，这里引用的文档才是必读材料；
// context = 话题其它回复、群里之前的消息、默认锚点、「正在进行的事」，只是前文，里面的文档尽量读、读不到不拦。纯函数。
const CONTEXT_HEADER_RE = /^【(?:话题其它回复|群里这条之前的消息|默认接着 bot 上一句)】|^【[^】\n]*正在进行的事/
export const splitTaskTextByOrigin = (text) => {
  const primary = []
  const context = []
  let inContext = false
  for (const line of String(text || '').split('\n')) {
    if (line.startsWith('【')) inContext = CONTEXT_HEADER_RE.test(line)
    ;(inContext ? context : primary).push(line)
  }
  return { primary: primary.join('\n'), context: context.join('\n') }
}

// Lark 文档 token 是 20 位以上的字母数字（docx / wiki 都是 27 位）；更短的是被截断的半截链接，抓了必失败，不去抓。纯函数。
export const isCompleteLarkDocUrl = (url) => /^[A-Za-z0-9]{20,}$/.test(String(url || '').split(/[?#]/)[0].split('/').filter(Boolean).pop() || '')

// 预取任务正文引用的 Lark 文档到 outDir：逐链接走 validateSource 的只读闸构造命令、spawn lark-cli、
// 解析 JSON envelope 拿 markdown 正文落盘。主消息里的链接读不到 → ok:false，上层 fail-closed 转负责人（绝不让 AI
// 缺 PRD 硬做）；上下文里的读不到、或残缺的半截链接只记进 skipped，照常跑，提示里告诉 AI 哪些没读到。
// 返回 { referencesLarkDocs, urls, docs:[{url,path}], skipped:[{url,reason}], ok, error }。
export const prefetchLarkDocs = ({ text, outDir, timeoutMs = defaultPrefetchTimeoutMs } = {}) => {
  const urls = extractLarkDocUrls(text)
  if (!urls.length) return { referencesLarkDocs: false, urls: [], docs: [], skipped: [], ok: false, error: null }
  const primaryUrls = new Set(extractLarkDocUrls(splitTaskTextByOrigin(text).primary))

  mkdirSync(outDir, { recursive: true })
  const docs = []
  const failures = []
  const skipped = []
  for (const url of urls) {
    // 嵌在 wiki 里的多维表格（bug 表链接 wiki/…?table=…&view=…）不是文档，按文档读必失败；bug 内容已在任务正文里，跳过不拦（10-22 Bug-4927）。
    if (/[?&]table=/.test(url)) {
      skipped.push({ url, reason: '多维表格，不是文档' })
      continue
    }
    if (!isCompleteLarkDocUrl(url)) {
      ;(primaryUrls.has(url) ? failures : skipped).push(primaryUrls.has(url) ? `${url} → 链接不完整` : { url, reason: '链接不完整（被截断）' })
      continue
    }
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
      if (primaryUrls.has(url)) failures.push(`${url} → ${error.message || error}`)
      else skipped.push({ url, reason: String(error.message || error).slice(0, 120) })
    }
  }
  const ok = failures.length === 0
  return {
    referencesLarkDocs: true,
    urls,
    docs,
    skipped,
    ok,
    error: ok ? null : `Lark 文档读取失败：${failures.join('；')}`,
  }
}
