/**
 * Figma 预取：Worker 在跑 AI 之前，用 vendored 的 REST 脚本 scripts/figma-spec.mjs 把任务引用的
 * 设计稿几何/标注确定性地落盘，供 AI 必读。纯函数（链接提取、哨兵解析）便于单测；prefetchFigmaSpec
 * 触发子进程。读设计稿这件事全环境（worker / 交互式）收敛到同一个脚本。
 */

import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

import { docsSystemRoot } from '../../engine/agent-scripts/lib/roots.mjs'

// vendored 权威副本（~/.ai-rules 那份无版本控制，生产 worker 不依赖它）。
const figmaSpecScript = join(docsSystemRoot, 'common/lark-bot/scripts/figma-spec.mjs')
const FIGMA_URL_RE = /https?:\/\/(?:www\.)?figma\.com\/(?:design|file|proto|board)\/[^\s)"'`>]+/gi
const defaultPrefetchTimeoutMs = Number(process.env.LARK_FIGMA_PREFETCH_TIMEOUT_MS || 120000)

// 任务正文里去重后的 figma 设计稿链接。与 buildTaskPrompt 的引用判定同口径。纯函数。
export const extractFigmaUrls = (text) => {
  const matches = String(text || '').match(FIGMA_URL_RE) || []
  return [...new Set(matches.map((u) => u.trim()))]
}

// 任务是否引用了 Figma 设计稿。纯函数。
export const taskReferencesFigma = (text) => extractFigmaUrls(text).length > 0

// 从 figma-spec.mjs 的 stdout 里取 `FIGMA_SPEC_WRITTEN: <dir>` 哨兵指向的落盘目录；无则 null。纯函数。
export const parseSpecWrittenDir = (stdout) => {
  const m = String(stdout || '').match(/^FIGMA_SPEC_WRITTEN:\s*(.+)$/m)
  return m ? m[1].trim() : null
}

// 预取任务正文引用的所有 Figma 设计稿到 outDir：逐链接 spawn figma-spec.mjs，解析哨兵拿落盘目录。
// FIGMA_API_KEY 走子进程 env 继承（未注入时脚本自身报错 → ok:false → 上层 fail-closed 转人工，绝不虚报）。
// 返回 { referencesFigma, urls, specs:[{url,dir}], ok, error }。任一链接失败即 ok:false。
export const prefetchFigmaSpec = ({ text, outDir, timeoutMs = defaultPrefetchTimeoutMs } = {}) => {
  const urls = extractFigmaUrls(text)
  if (!urls.length) return { referencesFigma: false, urls: [], specs: [], ok: false, error: null }

  const specs = []
  const failures = []
  for (const url of urls) {
    const run = spawnSync('node', [figmaSpecScript, url, '--out', outDir], {
      encoding: 'utf8',
      timeout: timeoutMs,
      env: process.env,
    })
    const dir = run.status === 0 ? parseSpecWrittenDir(run.stdout) : null
    if (dir) {
      specs.push({ url, dir })
    } else {
      const reason = run.error
        ? run.error.message
        : (run.stderr || run.stdout || `figma-spec exit ${run.status}`).trim().split('\n').slice(-1)[0]
      failures.push(`${url} → ${reason}`)
    }
  }
  const ok = specs.length === urls.length
  return {
    referencesFigma: true,
    urls,
    specs,
    ok,
    error: ok ? null : `Figma 设计稿读取失败：${failures.join('；')}`,
  }
}
