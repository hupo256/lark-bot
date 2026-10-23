/**
 * 读 bug 表记录分享链接（https://<租户>.larksuite.com/record/<token>）（aven 2026-10-23）。
 *
 * 群里贴 bug 常用这种链接（10-22 Encone「请协助看下这个问题 https://…/record/Q6S5…  Bug-4944 …」），
 * 原来按文档读不了，bot 只看得到标题。lark-cli 没有「分享 token → 记录」的接口，但分享 token 对每条记录是固定的：
 * 对表里的记录批量生成分享链接（+record-share-link-create，每次 100 条）反查出 record_id，结果落盘缓存，
 * 再 +record-get 读整条（标题 / 复现步骤 / 状态 / 负责 RD / 备注）落成 markdown，问题截图最多下 4 张。
 * 只是补充材料：读不到一律记 skipped，从不拦任务（标题已在正文里）。表配置用仓库 profile 的 dailyReport.bugTable。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { larkRuntimeDir } from './lark-paths.mjs'

const RECORD_URL_RE = /https?:\/\/[^\s/]*(?:larksuite\.com|feishu\.cn)\/record\/([A-Za-z0-9]{20,})/gi
const SHARE_BATCH = 100
const MAX_SCREENSHOTS = 4
const cachePath = () => join(larkRuntimeDir, 'lark-bug-record-links.json')

// 正文里的记录分享链接（去重，保持出现顺序）。纯函数。
export const extractBugRecordLinks = (text) => [...new Map([...String(text || '').matchAll(RECORD_URL_RE)].map((m) => [m[1], { url: m[0], token: m[1] }])).values()]
export const taskReferencesBugRecords = (text) => extractBugRecordLinks(text).length > 0

// 分享链接 → token。纯函数。
export const shareTokenOf = (url) => String(url || '').match(/\/record\/([A-Za-z0-9]{20,})/)?.[1] || null

const parseJson = (text) => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
const cli = (args, { cwd, timeoutMs = 60_000 } = {}) => {
  const run = spawnSync('lark-cli', [...args, '--as', 'user'], { encoding: 'utf8', timeout: timeoutMs, cwd, env: process.env })
  return { code: run.error ? -1 : run.status, stdout: run.stdout || '', stderr: run.error ? String(run.error.message) : run.stderr || '' }
}

// 列出表（有视图就按视图）里所有 record_id。
const listRecordIds = ({ table, run }) => {
  const ids = []
  for (let page = 0; page < 10; page += 1) {
    const result = run(['base', '+record-list', '--base-token', table.baseToken, '--table-id', table.tableId, ...(table.viewId ? ['--view-id', table.viewId] : []), '--field-id', '问题标题', '--format', 'json', '--limit', '200', '--offset', String(page * 200)])
    const data = parseJson(result.stdout)?.data
    if (result.code !== 0 || !data) return ids
    ids.push(...(data.record_id_list || []))
    if (!data.has_more) return ids
  }
  return ids
}

// 反查：给表里还没缓存过的记录生成分享链接，token → record_id 并进缓存（分享 token 不变，缓存长期有效）。
const resolveTokens = ({ tokens, table, run, cache }) => {
  const missing = tokens.filter((token) => !cache[token])
  if (!missing.length) return cache
  const known = new Set(Object.values(cache).map((item) => item.recordId))
  const ids = listRecordIds({ table, run }).filter((id) => !known.has(id))
  for (let i = 0; i < ids.length && missing.some((token) => !cache[token]); i += SHARE_BATCH) {
    const result = run(['base', '+record-share-link-create', '--base-token', table.baseToken, '--table-id', table.tableId, '--record-ids', ids.slice(i, i + SHARE_BATCH).join(',')])
    const links = parseJson(result.stdout)?.data?.record_share_links || {}
    for (const [recordId, url] of Object.entries(links)) {
      const token = shareTokenOf(url)
      if (token) cache[token] = { recordId, tableId: table.tableId }
    }
  }
  return cache
}

// 问题截图的 file_token（record-get 的 markdown 里「`问题截图`: [...]」一行）。纯函数。
export const screenshotTokensOf = (markdown) => {
  const line = String(markdown || '').split('\n').find((item) => item.startsWith('- `问题截图`:'))
  const list = parseJson(line?.slice(line.indexOf(':') + 1).trim() || '')
  return Array.isArray(list) ? list.map((item) => item?.file_token).filter(Boolean).slice(0, MAX_SCREENSHOTS) : []
}

// 返回 { urls, records:[{url, bug, path, shots}], skipped:[{url, reason}], ok:true }（永远 ok：不拦任务）。deps.run 供单测注入。
export const prefetchBugRecords = ({ text, outDir, table, deps = {} }) => {
  const links = extractBugRecordLinks(text)
  const base = { urls: links.map((link) => link.url), records: [], skipped: [], ok: true, error: null }
  if (!links.length) return base
  if (!table?.baseToken || !table?.tableId) return { ...base, skipped: links.map(({ url }) => ({ url, reason: '没配 bug 表（dailyReport.bugTable）' })) }
  const run = deps.run || cli
  const file = deps.cachePath || cachePath()
  const cache = resolveTokens({ tokens: links.map((link) => link.token), table, run, cache: (existsSync(file) && parseJson(readFileSync(file, 'utf8'))) || {} })
  writeFileSync(file, `${JSON.stringify(cache, null, 2)}\n`)
  mkdirSync(outDir, { recursive: true })
  for (const { url, token } of links) {
    const hit = cache[token]
    if (!hit) {
      base.skipped.push({ url, reason: '不是这张 bug 表的记录，或没有权限' })
      continue
    }
    const got = run(['base', '+record-get', '--base-token', table.baseToken, '--table-id', hit.tableId || table.tableId, '--record-id', hit.recordId])
    if (got.code !== 0 || !got.stdout.includes('_record_id')) {
      base.skipped.push({ url, reason: `读记录失败：${(got.stderr || got.stdout).trim().split('\n').pop()?.slice(0, 120) || got.code}` })
      continue
    }
    const bug = got.stdout.match(/- `Bug编号`: (\S+)/)?.[1] || hit.recordId
    const path = join(outDir, `bug-record-${bug}.md`)
    writeFileSync(path, got.stdout)
    const shotTokens = screenshotTokensOf(got.stdout)
    let shots = []
    if (shotTokens.length) {
      // --output 只收当前目录下的相对路径、且目录要先建好
      const shotDir = `bug-record-${bug}-shots`
      mkdirSync(join(outDir, shotDir), { recursive: true })
      const down = run(['base', '+record-download-attachment', '--base-token', table.baseToken, '--table-id', hit.tableId || table.tableId, '--record-id', hit.recordId, ...shotTokens.flatMap((t) => ['--file-token', t]), '--output', `./${shotDir}`, '--overwrite'], { cwd: outDir })
      if (down.code === 0) shots = [join(outDir, shotDir)]
    }
    base.records.push({ url, bug, path, shots })
  }
  return base
}
