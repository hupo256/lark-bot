#!/usr/bin/env node
/**
 * 回放上下文缓存（docs/falive-replay-plan-2026-11-03.md §6-1）：用 aven 的用户身份**只读**补拉模拟里 bot 读不到的上下文，
 * 落到 runtime/falive-replay/raw/ 下，由 scripts/sim/fake-lark-cli.mjs 原样回放。只调 lark-cli 的读命令
 * （docs +fetch / base +record-list / +record-get / +record-download-attachment / im +messages-mget / +messages-resources-download），不发消息、不写任何东西。
 *
 *   raw/docs/<token>.json            时间线里出现的云文档 / 知识库链接：docs +fetch 的原始 stdout（fetchedAt 是「现在」的版本，不是当时的）
 *   raw/bug-records/index.json       bug 表：全表 / 视图的 record_id 列表、Bug编号 → record_id、分享 token → record_id（falive 的链接缓存 + 同行 Bug 号推断）
 *   raw/bug-records/<record_id>.json +record-get --format json 的原始 stdout（同样是「现在」的状态）
 *   raw/bug-records/shots/<record_id>/<file_token>   记录链接对应记录的问题截图（前 4 张，与 lib/lark-bug-record 同口径）
 *   raw/expanded/<message_id>.json   合并转发 / 渲染版缺失的消息：+messages-mget 原始 stdout
 *   raw/resources-extra.json         「<message_id>/<key>」→ 附件绝对路径（时间线全部附件 + 补拉成功的）；fake CLI 的 +messages-resources-download 先查它
 *   raw/context-cache-report.json    每类拉取数 / 失败数及原因
 *
 *   raw/threads/<thread_id>.json     话题内的回复（群历史按群拉不到）：raw API 版 + 渲染版原始 stdout
 * 用法：node scripts/sim/build-context-cache.mjs [docs|bugs|expanded|threads|resources|all]（默认 all；已缓存成功的跳过，--refresh 重拉）
 * bug 表配置读 ~/github/lark-bot-falive/runtime/lark-bot.local.json（repos.falive.dailyReport.bugTable），appToken 不打到输出里。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import { extractLarkDocUrls, isBitableUrl, isCompleteLarkDocUrl } from '../../lib/lark-doc.mjs'
import { faliveRuntimeDir, rawDir, replayRoot } from './falive-data.mjs'

const REAL_CLI = process.env.REAL_LARK_CLI || 'lark-cli' // 不认 LARK_CLI_BIN：那是假 CLI
const step = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'all'
const refresh = process.argv.includes('--refresh')
const timeline = JSON.parse(readFileSync(join(replayRoot, 'dataset', 'timeline.json'), 'utf8'))
const reportPath = join(rawDir, 'context-cache-report.json')
const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : {}
const now = () => new Date().toISOString()

const runCli = (args, { cwd = rawDir, timeoutMs = 120_000 } = {}) => new Promise((resolve) => {
  const child = spawn(REAL_CLI, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
  child.stdout.on('data', (c) => { stdout += c })
  child.stderr.on('data', (c) => { stderr += c })
  child.on('close', (code) => {
    clearTimeout(timer)
    resolve({ code, stdout, stderr })
  })
  child.on('error', (error) => {
    clearTimeout(timer)
    resolve({ code: -1, stdout, stderr: String(error.message) })
  })
})
const parse = (text) => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
const errOf = (r) => {
  const p = parse(r.stdout) || parse(r.stderr)
  return (p?.error?.message || r.stderr || r.stdout || `exit ${r.code}`).trim().split('\n').filter((l) => l.trim() && l.trim() !== '}').pop()?.slice(0, 200) || `exit ${r.code}`
}
const pool = async (items, n, fn) => {
  const queue = [...items]
  await Promise.all(Array.from({ length: n }, async () => {
    while (queue.length) await fn(queue.shift())
  }))
}
const textOf = (m) => `${m.text || ''}\n${m.rawContent || ''}`
const tokenOfUrl = (url) => String(url).split(/[?#]/)[0].replace(/(?:%5[BD]|%2[89])+$/i, '').split('/').filter(Boolean).pop()

// —— 云文档 / 知识库 ——
const buildDocs = async () => {
  const dir = join(rawDir, 'docs')
  mkdirSync(dir, { recursive: true })
  const urls = new Map() // token → url（第一次出现的）
  const skipped = []
  for (const m of timeline) {
    for (const url of extractLarkDocUrls(textOf(m))) {
      if (isBitableUrl(url)) {
        skipped.push({ url, reason: '多维表格（wiki?table=），lib 不按文档读' })
        continue
      }
      if (!isCompleteLarkDocUrl(url)) {
        skipped.push({ url, reason: '链接被截断，lib 不抓' })
        continue
      }
      const token = tokenOfUrl(url)
      if (!urls.has(token)) urls.set(token, url)
    }
  }
  // 时间线里还有 sheets / base 链接的话也拉一次（lib 目前不读，留着备用）
  for (const m of timeline) for (const x of textOf(m).matchAll(/https?:\/\/[^\s/]*(?:larksuite\.com|feishu\.cn)\/(?:sheets|base)\/([A-Za-z0-9]{20,})/g)) if (!urls.has(x[1])) urls.set(x[1], x[0])
  const result = { at: now(), urls: urls.size, fetched: 0, cached: 0, failed: [], skipped: [...new Map(skipped.map((s) => [s.url, s])).values()] }
  await pool([...urls], 3, async ([token, url]) => {
    const file = join(dir, `${token}.json`)
    if (!refresh && existsSync(file) && parse(readFileSync(file, 'utf8'))?.ok) {
      result.cached += 1
      return
    }
    const args = ['docs', '+fetch', '--api-version', 'v2', '--doc', url, '--doc-format', 'markdown', '--as', 'user', '--format', 'json']
    const r = await runCli(args)
    const ok = r.code === 0 && parse(r.stdout)?.ok === true
    writeFileSync(file, `${JSON.stringify({ token, url, fetchedAt: now(), version: 'now', note: '拉取时的最新版，不是消息当时的版本', ok, exitCode: r.code, command: ['lark-cli', ...args], stdout: r.stdout, stderr: r.stderr }, null, 2)}\n`)
    if (ok) result.fetched += 1
    else result.failed.push({ token, url, reason: errOf(r) })
  })
  report.docs = result
  console.log(`docs：${urls.size} 个 token，新拉 ${result.fetched}，已有 ${result.cached}，失败 ${result.failed.length}，跳过 ${result.skipped.length}`)
}

// —— bug 表 ——
const BUG_TABLE = (() => {
  try {
    const t = JSON.parse(readFileSync(join(faliveRuntimeDir, 'lark-bot.local.json'), 'utf8')).repos.falive.dailyReport.bugTable
    return { baseToken: t.baseToken, tableId: t.tableId, viewId: t.viewId || null }
  } catch {
    return null
  }
})()
const listAll = async ({ viewId = null }) => {
  const ids = []
  const bugIds = {}
  for (let offset = 0; offset < 40_000; offset += 200) {
    const r = await runCli(['base', '+record-list', '--as', 'user', '--base-token', BUG_TABLE.baseToken, '--table-id', BUG_TABLE.tableId, ...(viewId ? ['--view-id', viewId] : []), '--field-id', 'Bug编号', '--field-id', '问题标题', '--format', 'json', '--limit', '200', '--offset', String(offset)])
    const data = parse(r.stdout)?.data
    if (r.code !== 0 || !data) throw new Error(`record-list 失败（offset ${offset}）：${errOf(r)}`)
    const list = data.record_id_list || []
    list.forEach((id, i) => { bugIds[id] = { bugId: data.data?.[i]?.[0] ?? null, title: data.data?.[i]?.[1] ?? null } })
    ids.push(...list)
    if (!data.has_more) break
  }
  return { ids, bugIds }
}
const buildBugs = async () => {
  if (!BUG_TABLE) throw new Error('读不到 falive bugTable 配置')
  const dir = join(rawDir, 'bug-records')
  mkdirSync(join(dir, 'shots'), { recursive: true })
  const all = await listAll({})
  const view = BUG_TABLE.viewId ? await listAll({ viewId: BUG_TABLE.viewId }) : null
  const byBugId = {}
  for (const [rid, v] of Object.entries(all.bugIds)) if (v.bugId) byBugId[String(v.bugId).toLowerCase()] = rid
  // 分享 token → record_id：falive 当时的缓存；没有的按同一行里唯一的 Bug 号推断（标 inferred）
  const linkCache = parse(readFileSync(join(faliveRuntimeDir, 'lark-bug-record-links.json'), 'utf8')) || {}
  const shareTokens = {}
  for (const [token, v] of Object.entries(linkCache)) shareTokens[token] = { recordId: v.recordId, source: 'falive lark-bug-record-links.json' }
  const mentioned = new Set()
  const linkTokens = new Set()
  for (const m of timeline) {
    const text = m.text || ''
    for (const x of text.matchAll(/bug[-_ ]?(\d{4})\b/gi)) mentioned.add(`bug-${x[1]}`)
    for (const line of text.split('\n')) {
      const tokens = [...line.matchAll(/\/record\/([A-Za-z0-9]{20,})/g)].map((x) => x[1])
      tokens.forEach((t) => linkTokens.add(t))
      const nums = [...new Set([...line.matchAll(/bug[-_ ]?(\d{4})\b/gi)].map((x) => x[1]))]
      if (tokens.length === 1 && nums.length === 1 && !shareTokens[tokens[0]] && byBugId[`bug-${nums[0]}`]) shareTokens[tokens[0]] = { recordId: byBugId[`bug-${nums[0]}`], source: `同行 Bug-${nums[0]} 推断`, inferred: true }
    }
  }
  const unresolvedTokens = [...linkTokens].filter((t) => !shareTokens[t])
  const wanted = new Map() // recordId → why
  const missingBugIds = []
  for (const b of mentioned) {
    const rid = byBugId[b]
    if (rid) wanted.set(rid, b)
    else missingBugIds.push(b)
  }
  const linked = new Set([...linkTokens].map((t) => shareTokens[t]?.recordId).filter(Boolean))
  for (const rid of linked) if (!wanted.has(rid)) wanted.set(rid, 'record link')
  const result = { at: now(), tableRecords: all.ids.length, viewRecords: view?.ids.length ?? null, mentionedBugIds: mentioned.size, missingBugIds, linkTokens: linkTokens.size, unresolvedTokens, records: wanted.size, fetched: 0, cached: 0, failed: [], shots: { records: 0, files: 0, failed: [] } }
  await pool([...wanted.keys()], 3, async (rid) => {
    const file = join(dir, `${rid}.json`)
    let stdout = null
    if (!refresh && existsSync(file) && parse(readFileSync(file, 'utf8'))?.ok) {
      result.cached += 1
      stdout = parse(readFileSync(file, 'utf8')).stdout
    } else {
      const args = ['base', '+record-get', '--as', 'user', '--base-token', '<bugTable.appToken>', '--table-id', BUG_TABLE.tableId, '--record-id', rid, '--format', 'json']
      const r = await runCli(args.map((a) => (a === '<bugTable.appToken>' ? BUG_TABLE.baseToken : a)))
      const ok = r.code === 0 && (parse(r.stdout)?.data?.record_id_list || []).includes(rid)
      writeFileSync(file, `${JSON.stringify({ recordId: rid, why: wanted.get(rid), fetchedAt: now(), version: 'now', note: '拉取时的最新状态（状态 / 备注 / 测试结果可能晚于消息当时）', ok, exitCode: r.code, command: ['lark-cli', ...args], stdout: r.stdout, stderr: r.stderr }, null, 2)}\n`)
      if (!ok) {
        result.failed.push({ recordId: rid, reason: errOf(r) })
        return
      }
      result.fetched += 1
      stdout = r.stdout
    }
    if (!linked.has(rid)) return
    // 记录链接能点到的记录：问题截图前 4 张（lib/lark-bug-record MAX_SCREENSHOTS）
    const data = parse(stdout)?.data
    const col = (data?.fields || []).indexOf('问题截图')
    const shots = (col >= 0 ? data.data?.[0]?.[col] || [] : []).filter((s) => s?.file_token).slice(0, 4)
    if (!shots.length) return
    result.shots.records += 1
    const shotDir = join(dir, 'shots', rid)
    mkdirSync(shotDir, { recursive: true })
    for (const s of shots) {
      if (!refresh && existsSync(join(shotDir, s.file_token))) {
        result.shots.files += 1
        continue
      }
      const r = await runCli(['base', '+record-download-attachment', '--as', 'user', '--base-token', BUG_TABLE.baseToken, '--table-id', BUG_TABLE.tableId, '--record-id', rid, '--file-token', s.file_token, '--output', `./${s.file_token}`, '--overwrite'], { cwd: shotDir })
      if (r.code === 0 && existsSync(join(shotDir, s.file_token))) result.shots.files += 1
      else result.shots.failed.push({ recordId: rid, fileToken: s.file_token, reason: errOf(r) })
    }
  })
  const cachedRecords = readdirSync(dir).filter((f) => /^rec\w+\.json$/.test(f)).map((f) => f.replace(/\.json$/, ''))
  writeFileSync(join(dir, 'index.json'), `${JSON.stringify({
    fetchedAt: now(),
    note: '全表 / 视图 record_id 列表与记录内容都是拉取时的版本；baseToken 不落盘，假 CLI 不校验 --base-token',
    tableId: BUG_TABLE.tableId,
    viewId: BUG_TABLE.viewId,
    allRecordIds: all.ids,
    viewRecordIds: view?.ids || null,
    titles: all.bugIds,
    byBugId,
    shareTokens,
    cachedRecords,
  }, null, 2)}\n`)
  report.bugs = result
  console.log(`bugs：全表 ${all.ids.length} 条（视图 ${view?.ids.length ?? '-'}），时间线提到 ${mentioned.size} 个 Bug 号（表里没有 ${missingBugIds.length}），记录链接 ${linkTokens.size} 个（解析不了 ${unresolvedTokens.length}）；记录 ${wanted.size}：新拉 ${result.fetched}，已有 ${result.cached}，失败 ${result.failed.length}；截图 ${result.shots.files} 张（失败 ${result.shots.failed.length}）`)
}

// —— 合并转发 / 渲染版缺失 ——
const buildExpanded = async () => {
  const dir = join(rawDir, 'expanded')
  mkdirSync(dir, { recursive: true })
  const ids = timeline.filter((m) => m.msgType === 'merge_forward' || (!m.deleted && !String(m.text || '').trim() && m.senderType === 'user')).map((m) => m.id)
  // 渲染版拉不到、靠 raw 版粗渲染的（falive-data.loadTimeline 的回落）：rendered 里没有的
  const rendered = new Set()
  for (const g of ['php-group', 'tech-group', 'webhook-group']) {
    const p = join(rawDir, `${g}.json`)
    if (existsSync(p)) for (const m of parse(readFileSync(p, 'utf8'))?.data?.messages || []) rendered.add(m.message_id)
  }
  for (const m of timeline) if (!rendered.has(m.id) && !m.deleted && m.senderType !== 'system') ids.push(m.id)
  const unique = [...new Set(ids)]
  const result = { at: now(), messages: unique.length, fetched: 0, cached: 0, failed: [] }
  await pool(unique, 3, async (id) => {
    const file = join(dir, `${id}.json`)
    if (!refresh && existsSync(file) && parse(readFileSync(file, 'utf8'))?.ok) {
      result.cached += 1
      return
    }
    const args = ['im', '+messages-mget', '--as', 'user', '--message-ids', id, '--no-reactions', '--format', 'json']
    const r = await runCli(args)
    const msg = parse(r.stdout)?.data?.messages?.[0]
    const ok = r.code === 0 && Boolean(msg)
    writeFileSync(file, `${JSON.stringify({ messageId: id, fetchedAt: now(), ok, exitCode: r.code, command: ['lark-cli', ...args], stdout: r.stdout, stderr: r.stderr }, null, 2)}\n`)
    if (ok) result.fetched += 1
    else result.failed.push({ id, reason: errOf(r) })
  })
  report.expanded = result
  console.log(`expanded：${unique.length} 条，新拉 ${result.fetched}，已有 ${result.cached}，失败 ${result.failed.length}`)
}

// —— 话题回复 ——
// 群历史是按群拉的（container_id_type=chat），话题群里话题内的回复不在里面（11-03 实测：204 个话题根各自只有一条）。
// 每个话题按 thread 再拉一次：raw API 版（毫秒时间 / parent_id / root_id / mentions）+ 渲染版（内联 @名字、附件落 raw/lark-im-resources/）。
const buildThreads = async () => {
  const dir = join(rawDir, 'threads')
  mkdirSync(dir, { recursive: true })
  const threads = [...new Set(timeline.map((m) => m.threadId).filter(Boolean))]
  const result = { at: now(), threads: threads.length, fetched: 0, cached: 0, failed: [], replies: 0 }
  await pool(threads, 3, async (threadId) => {
    const file = join(dir, `${threadId}.json`)
    const prev = existsSync(file) ? parse(readFileSync(file, 'utf8')) : null
    if (!refresh && prev?.ok) {
      result.cached += 1
      result.replies += (parse(prev.api)?.data?.items || []).length
      return
    }
    const apiArgs = ['api', 'GET', '/open-apis/im/v1/messages', '--as', 'user', '--params', JSON.stringify({ container_id_type: 'thread', container_id: threadId, page_size: 50, sort_type: 'ByCreateTimeAsc' }), '--page-all', '--page-limit', '0', '--format', 'json']
    const api = await runCli(apiArgs)
    const listArgs = ['im', '+threads-messages-list', '--as', 'user', '--thread', threadId, '--order', 'asc', '--page-size', '50', '--page-all', '--page-limit', '100', '--no-reactions', '--download-resources', '--format', 'json']
    const rendered = await runCli(listArgs)
    const ok = api.code === 0 && parse(api.stdout)?.data != null && rendered.code === 0 && parse(rendered.stdout)?.ok === true
    writeFileSync(file, `${JSON.stringify({ threadId, fetchedAt: now(), ok, commands: [['lark-cli', ...apiArgs], ['lark-cli', ...listArgs]], api: api.stdout, apiStderr: api.stderr.slice(-2000), rendered: rendered.stdout, renderedStderr: rendered.stderr.slice(-2000) }, null, 2)}\n`)
    if (ok) {
      result.fetched += 1
      result.replies += (parse(api.stdout)?.data?.items || []).length
    } else result.failed.push({ threadId, reason: api.code !== 0 ? errOf(api) : errOf(rendered) })
  })
  report.threads = result
  console.log(`threads：${threads.length} 个话题，新拉 ${result.fetched}，已有 ${result.cached}，失败 ${result.failed.length}；话题内消息 ${result.replies} 条`)
}

// —— 附件 ——
const buildResources = async () => {
  const resDir = join(rawDir, 'lark-im-resources')
  const files = readdirSync(resDir)
  const onDisk = (key) => files.find((f) => f === key || f.startsWith(`${key}.`)) || null
  const extra = {}
  const want = []
  for (const m of timeline) {
    const keys = new Map((m.resources || []).map((r) => [r.key, r.type]))
    for (const x of String(m.text || '').matchAll(/\b(img_v\d_[\w-]+|file_v\d_[\w-]+)/g)) if (!keys.has(x[1])) keys.set(x[1], x[1].startsWith('img_') ? 'image' : 'file')
    for (const [key, type] of keys) {
      const hit = onDisk(key)
      if (hit) extra[`${m.id}/${key}`] = join(resDir, hit)
      else want.push({ id: m.id, key, type, msgType: m.msgType, ownBot: m.ownBot, atMs: m.atMs })
    }
  }
  // 话题回复（buildThreads 渲染版 --download-resources 落的）
  const threadDir = join(rawDir, 'threads')
  if (existsSync(threadDir)) {
    for (const file of readdirSync(threadDir)) {
      for (const m of parse(parse(readFileSync(join(threadDir, file), 'utf8'))?.rendered || '')?.data?.messages || []) {
        for (const r of m.resources || []) {
          const path = r.local_path ? (isAbsolute(r.local_path) ? r.local_path : join(rawDir, r.local_path)) : null
          if (path && existsSync(path)) extra[`${m.message_id}/${r.key}`] = path
          else if (r.key) want.push({ id: m.message_id, key: r.key, type: r.type, msgType: m.msg_type, ownBot: m.sender?.sender_type === 'app', atMs: 0 })
        }
      }
    }
  }
  const result = { at: now(), mapped: Object.keys(extra).length, retried: want.length, fetched: 0, failed: [] }
  for (const w of want) {
    // 不带扩展名：lark-cli 按 Content-Disposition / Content-Type 补
    const r = await runCli(['im', '+messages-resources-download', '--as', 'user', '--message-id', w.id, '--file-key', w.key, '--type', w.type === 'image' ? 'image' : 'file', '--output', w.key, '--format', 'json'], { cwd: resDir })
    const hit = readdirSync(resDir).find((f) => f === w.key || f.startsWith(`${w.key}.`))
    if (r.code === 0 && hit) {
      extra[`${w.id}/${w.key}`] = join(resDir, hit)
      result.fetched += 1
    } else result.failed.push({ ...w, at: new Date(w.atMs).toISOString(), reason: errOf(r) })
  }
  writeFileSync(join(rawDir, 'resources-extra.json'), `${JSON.stringify({ builtAt: now(), note: '「<message_id>/<key>」→ 绝对路径；时间线全部附件（修 run-sim resources.json 的路径重复拼接）+ 补拉成功的', resources: extra }, null, 2)}\n`)
  report.resources = result
  console.log(`resources：映射 ${result.mapped + result.fetched} 份，补拉 ${want.length}：成功 ${result.fetched}，失败 ${result.failed.length}`)
}

const steps = { docs: buildDocs, bugs: buildBugs, expanded: buildExpanded, threads: buildThreads, resources: buildResources }
for (const [name, fn] of Object.entries(steps)) {
  if (step !== 'all' && step !== name) continue
  try {
    await fn()
  } catch (error) {
    report[name] = { at: now(), error: String(error.message || error) }
    console.error(`${name} 失败：${error.message || error}`)
  }
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
}
