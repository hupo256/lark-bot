/**
 * 日报的确定性部分（aven 2026-10-14）：
 *   · 状态以 origin/pre 真实代码为准、覆盖所有负责人——模型在完整版末尾输出逐功能状态 JSON，脚本校验齐全并据此算总体进度 / 计数，
 *     回写一节表格的状态列，短版与完整版用同一组数字；
 *   · 二、三节是台账：解决一行删一行，昨天有、今天没、又没在 resolved 里给依据的行 = 无故消失，私信 aven；节标题带「剩 n 行（今日删 m 行）」；
 *   · pre 线上构建时间、直播拉流可达性由脚本实测（模型只读、没网络）；
 *   · 只在工作日发。
 * 全是纯函数（网络部分可注入 fetch），单测见 __tests__/lark-daily-ledger.test.mjs。
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// ── 工作日 ────────────────────────────────────────────────
// days：数组（0=周日…6=周六）或 "1-5" / "1,3,5"；缺省 = 周一到周五。
export const parseReportDays = (raw) => {
  if (Array.isArray(raw)) {
    const list = raw.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    return list.length ? [...new Set(list)].sort() : [1, 2, 3, 4, 5]
  }
  const text = String(raw ?? '').trim()
  if (!text) return [1, 2, 3, 4, 5]
  const out = new Set()
  for (const part of text.split(',')) {
    const range = part.trim().match(/^(\d)\s*-\s*(\d)$/)
    if (range) for (let day = Number(range[1]); day <= Number(range[2]); day += 1) out.add(day)
    else if (/^\d$/.test(part.trim())) out.add(Number(part.trim()))
  }
  const list = [...out].filter((day) => day >= 0 && day <= 6).sort()
  if (!list.length) throw new Error(`dailyReport.days 写法不对：${text}（例 "1-5"）`)
  return list
}

export const isReportDay = (date, days = [1, 2, 3, 4, 5]) => days.includes(date.getDay())

// ── 网络实测（可注入 fetch） ────────────────────────────────
const withTimeout = async (fetchImpl, url, init = {}, timeoutMs = 15_000) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

export const findEntryScript = (html) => String(html || '').match(/\/assets\/index-[\w-]+\.js/)?.[0] || null
export const parseBuildTime = (js) => {
  const hit = String(js || '').match(/VITE_BUILD_TIME["']?\s*:\s*["']?(\d{12,14})/)
  return hit ? Number(hit[1]) : null
}

// pre 线上前端是哪次构建：首页入口 JS 里注入的 VITE_BUILD_TIME（毫秒）。
export const fetchSiteBuildTime = async ({ siteUrl, fetchImpl = fetch, timeoutMs = 15_000 }) => {
  if (!siteUrl) return { ok: false, reason: '未配置 siteUrl' }
  try {
    const page = await withTimeout(fetchImpl, siteUrl, {}, timeoutMs)
    const entry = findEntryScript(await page.text())
    if (!entry) return { ok: false, reason: `首页里找不到入口 JS（HTTP ${page.status}）` }
    const script = await withTimeout(fetchImpl, new URL(entry, siteUrl).toString(), {}, timeoutMs)
    const ms = parseBuildTime(await script.text())
    return ms ? { ok: true, buildTime: new Date(ms).toISOString(), ms, entry } : { ok: false, reason: `入口 JS ${entry} 里没有 VITE_BUILD_TIME` }
  } catch (error) {
    return { ok: false, reason: `取不到：${String(error?.message || error).slice(0, 80)}` }
  }
}

// 拉流是否真的能播：flv / mp4 看 200 / 206；m3u8 还要正文是 #EXTM3U。
export const checkStreamUrl = async ({ url, fetchImpl = fetch, timeoutMs = 15_000 }) => {
  if (!url) return { ok: false, detail: '没有拉流地址' }
  try {
    const res = await withTimeout(fetchImpl, url, { headers: { Range: 'bytes=0-2047' } }, timeoutMs)
    if (res.status !== 200 && res.status !== 206) return { ok: false, detail: `拉流 HTTP ${res.status}` }
    if (/\.m3u8(\?|$)/i.test(url)) {
      const body = await res.text()
      return body.trimStart().startsWith('#EXTM3U') ? { ok: true, detail: 'm3u8 可拉' } : { ok: false, detail: 'm3u8 返回的不是播放列表' }
    }
    return { ok: true, detail: `拉流 HTTP ${res.status}` }
  } catch (error) {
    return { ok: false, detail: error?.name === 'AbortError' ? `拉流 ${Math.round(timeoutMs / 1000)} 秒无响应` : `拉流失败：${String(error?.message || error).slice(0, 60)}` }
  }
}

// ── 逐功能状态 JSON（模型在完整版末尾输出，脚本剥离） ────────────
export const STATUS_OPEN = '<!-- STATUS_JSON'
export const STATUS_CLOSE = 'STATUS_JSON -->'
const VALID_STATUS = new Set(['✅', '🟠', '🟡', '❌', '—'])
const VALID_PRE = new Set(['能用', '看不到', '未部署', '未验证'])

export const splitStatusBlock = (text) => {
  const value = String(text || '')
  const start = value.lastIndexOf(STATUS_OPEN)
  if (start < 0) return { doc: value.trim(), data: null, error: '完整版末尾没有逐功能状态 JSON' }
  const end = value.indexOf(STATUS_CLOSE, start)
  const raw = value.slice(start + STATUS_OPEN.length, end < 0 ? undefined : end).trim().replace(/^```(?:json)?\s*|\s*```$/g, '')
  const doc = `${value.slice(0, start)}${end < 0 ? '' : value.slice(end + STATUS_CLOSE.length)}`.trim()
  try {
    return { doc, data: JSON.parse(raw), error: null }
  } catch (error) {
    return { doc, data: null, error: `逐功能状态 JSON 解析失败：${String(error?.message || error).slice(0, 80)}` }
  }
}

// 校验：总表里每个功能都要有一条，状态 / pre 取值合法。返回规范化后的 Map(no → item) 与错误列表。
export const validateStatusData = (data, rows = []) => {
  const errors = []
  const statuses = new Map()
  for (const item of Array.isArray(data?.features) ? data.features : []) {
    const no = Number(item?.no)
    if (!Number.isInteger(no)) continue
    if (!VALID_STATUS.has(item.status)) {
      errors.push(`#${no} 状态「${item.status}」不合法`)
      continue
    }
    const pre = VALID_PRE.has(item.pre) ? item.pre : '未验证'
    statuses.set(no, { no, status: item.status, pre, reason: String(item.reason || '').trim(), evidence: String(item.evidence || '').trim() })
  }
  const missing = rows.map((row) => row.no).filter((no) => !statuses.has(no))
  if (missing.length) errors.push(`缺 ${missing.length} 个功能的状态：#${missing.join(' #')}`)
  const resolved = (Array.isArray(data?.resolved) ? data.resolved : [])
    .map((item) => ({ section: String(item?.section || '').trim(), key: String(item?.key || '').trim(), evidence: String(item?.evidence || '').trim() }))
    .filter((item) => item.key)
  return { statuses, resolved, errors }
}

// ── 进度与计数（按代码状态算，模型不再估） ────────────────────
export const STATUS_WEIGHT = { '✅': 100, '🟠': 60, '🟡': 30, '❌': 0 }
const isCounted = (no, excluded) => !excluded.includes(no)

export const computeProgress = ({ rows = [], statuses, excluded = [54] }) => {
  const counted = rows.filter((row) => isCounted(row.no, excluded) && statuses.get(row.no)?.status !== '—')
  const byOwner = {}
  let score = 0
  let done = 0
  const preHidden = []
  for (const row of counted) {
    const item = statuses.get(row.no) || { status: '❌', pre: '未验证' }
    score += STATUS_WEIGHT[item.status] ?? 0
    const owner = row.owner || '未定'
    byOwner[owner] ||= { done: 0, total: 0, open: [] }
    byOwner[owner].total += 1
    if (item.status === '✅') {
      done += 1
      byOwner[owner].done += 1
      if (item.pre !== '能用') preHidden.push({ no: row.no, owner, feature: row.feature, pre: item.pre, reason: item.reason })
    } else byOwner[owner].open.push(row.no)
  }
  const total = counted.length
  return { total, done, open: total - done, percent: total ? Math.round((score / total) * 10) / 10 : 0, byOwner, preHidden, excluded }
}

const ownerOrder = (byOwner) => Object.entries(byOwner).sort((a, b) => (a[0] === 'aven' ? -1 : b[0] === 'aven' ? 1 : b[1].open.length - a[1].open.length))

// 一节表后的计数块；「- 名字 n 项：#…」格式是日报清扫（lark-daily-sweep）的读取约定，别改。
export const renderCounts = (progress) => {
  const doneParts = ownerOrder(progress.byOwner).filter(([, item]) => item.done).map(([owner, item]) => `${owner} ${item.done}`)
  const head = `**计数**（不含 #${progress.excluded.join(' #')}）：✅ ${progress.done} 项${doneParts.length ? `（${doneParts.join('、')}）` : ''}。未完成 ${progress.open} 项：`
  const lines = ownerOrder(progress.byOwner).filter(([, item]) => item.open.length).map(([owner, item]) => `- ${owner} ${item.open.length} 项：#${item.open.join(' #')}`)
  return [head, ...lines].join('\n')
}

// ── markdown 表格工具 ────────────────────────────────────
const splitCells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((cell) => cell.trim())
const isSeparator = (line) => /^\|?\s*:?-{3,}/.test(line.trim())

const sectionRange = (lines, startPrefix) => {
  const start = lines.findIndex((line) => line.startsWith(startPrefix))
  if (start < 0) return null
  let end = lines.findIndex((line, index) => index > start && /^## /.test(line))
  if (end < 0) end = lines.length
  return { start, end }
}

// 某一节（## 开头）里所有表格的数据行（不含表头 / 分隔行）。
export const sectionTableRows = (markdown, startPrefix) => {
  const lines = String(markdown || '').split('\n')
  const range = sectionRange(lines, startPrefix)
  if (!range) return []
  const out = []
  let inTable = false
  for (let index = range.start + 1; index < range.end; index += 1) {
    const line = lines[index]
    if (!line.trim().startsWith('|')) {
      inTable = false
      continue
    }
    if (!inTable) {
      inTable = true // 表头
      continue
    }
    if (isSeparator(line)) continue
    out.push({ index, cells: splitCells(line) })
  }
  return out
}

export const normalizeKey = (text) => String(text || '').replace(/\*\*|`|~~/g, '').replace(/\s+/g, '').replace(/[（(].*?[)）]/g, '').toLowerCase()

// 一节表格的「状态」列按代码状态回写（✅ 原样，其余 ⬜，#54 —）；合并行（如 17–20）全 ✅ 才写 ✅。
export const applyStatusColumn = (markdown, statuses) => {
  const lines = String(markdown || '').split('\n')
  const range = sectionRange(lines, '## 一、')
  if (!range) return markdown
  let statusCol = -1
  for (let index = range.start + 1; index < range.end; index += 1) {
    const line = lines[index]
    if (!line.trim().startsWith('|')) continue
    const cells = splitCells(line)
    if (statusCol < 0 || cells.includes('状态')) {
      statusCol = cells.indexOf('状态')
      continue
    }
    if (isSeparator(line)) continue
    const nos = expandNos(cells[0])
    if (!nos.length || statusCol < 0 || statusCol >= cells.length) continue
    const items = nos.map((no) => statuses.get(no)).filter(Boolean)
    if (!items.length) continue
    const mark = items.every((item) => item.status === '—') ? '—' : items.every((item) => item.status === '✅' || item.status === '—') ? '✅' : '⬜'
    cells[statusCol] = mark
    lines[index] = `| ${cells.join(' | ')} |`
  }
  return lines.join('\n')
}

export const expandNos = (cell) => {
  const text = String(cell || '').replace(/[#*\s]/g, '')
  const range = text.match(/^(\d+)[–\-~](\d+)$/)
  if (range) {
    const out = []
    for (let no = Number(range[1]); no <= Number(range[2]); no += 1) out.push(no)
    return out
  }
  return /^\d+$/.test(text) ? [Number(text)] : []
}

// 总体进度标题与计数块：有就替换，没有就补上。
export const applyProgress = (markdown, progress) => {
  let text = String(markdown || '')
  const heading = `## 总体进度：${progress.percent.toFixed(1)}%（✅ ${progress.done} / ${progress.total}）`
  text = /^## 总体进度：.*$/m.test(text) ? text.replace(/^## 总体进度：.*$/m, heading) : text.replace(/^(# .*\n)/, `$1\n${heading}\n`)
  const counts = renderCounts(progress)
  const block = /^\*\*计数\*\*.*\n(?:- .*\n?)*/m
  if (block.test(text)) return text.replace(block, `${counts}\n`)
  return text.replace(/\n## 二、/, `\n${counts}\n\n## 二、`)
}

// ── 二、三节台账 ─────────────────────────────────────────
export const LEDGER_SECTIONS = [
  { name: '二', prefix: '## 二、' },
  { name: '三', prefix: '## 三、' },
]

// 昨天的行今天还在吗：以首列（规范化）为键。消失的行要在 resolved 里有依据，否则算无故消失。
export const diffLedger = ({ previous, current, resolved = [] }) => LEDGER_SECTIONS.map(({ name, prefix }) => {
  const before = sectionTableRows(previous, prefix).map((row) => row.cells[0]).filter(Boolean)
  const after = new Set(sectionTableRows(current, prefix).map((row) => normalizeKey(row.cells[0])))
  const resolvedKeys = resolved.filter((item) => !item.section || item.section === name).map((item) => normalizeKey(item.key))
  const removed = before.filter((key) => !after.has(normalizeKey(key)))
  const explained = (key) => resolvedKeys.some((hit) => hit && (hit === normalizeKey(key) || normalizeKey(key).includes(hit) || hit.includes(normalizeKey(key))))
  return {
    name,
    prefix,
    remaining: after.size,
    removed,
    unexplained: removed.filter((key) => !explained(key)),
    resolved: resolved.filter((item) => !item.section || item.section === name),
  }
})

// 节标题追加「剩 n 行，今日删 m 行」（只数有依据的删除），已有的旧计数先去掉。
export const annotateLedgerHeadings = (markdown, diff) => {
  const lines = String(markdown || '').split('\n')
  for (const section of diff) {
    const index = lines.findIndex((line) => line.startsWith(section.prefix))
    if (index < 0) continue
    const base = lines[index].replace(/（剩 \d+ 行[^）]*）\s*$/, '').trimEnd()
    const deleted = section.removed.length - section.unexplained.length
    lines[index] = `${base}（剩 ${section.remaining} 行${deleted ? `，今日删 ${deleted} 行` : ''}${section.remaining ? '' : '，已清零'}）`
  }
  return lines.join('\n')
}

// ── 总表 vs pre 代码 ─────────────────────────────────────
// 功能总表（人维护）和 pre 代码推出的状态不一致的行，私信 aven 去改总表；日报本身以代码为准。
export const tableMismatches = (rows = [], statuses) => rows
  .map((row) => ({ row, item: statuses.get(row.no) }))
  .filter(({ row, item }) => item && item.status !== '—' && item.status !== row.status)
  .map(({ row, item }) => ({ no: row.no, feature: row.feature, owner: row.owner, table: row.status, code: item.status, evidence: item.evidence }))

// 前一天（或更早）生成的完整版：作为今天的模板，让台账逐日延续。
export const findPreviousFullReport = ({ dir, date }) => {
  if (!dir || !existsSync(dir)) return null
  const candidates = readdirSync(dir)
    .map((name) => ({ name, day: name.match(/(\d{4}-\d{2}-\d{2})-完整版\.md$/)?.[1] }))
    .filter((item) => item.day && item.day < date)
    .sort((a, b) => (a.day < b.day ? 1 : -1))
  return candidates.length ? { path: join(dir, candidates[0].name), date: candidates[0].day } : null
}

// 高亮框里「<b>名字：</b>负责 n 项，m 项 ✅」要和脚本算的一致；对不上的私信 aven（不改正文，避免把句子改坏）。
export const checkCalloutCounts = (markdown, progress) => {
  const out = []
  for (const [owner, item] of Object.entries(progress.byOwner)) {
    const hit = String(markdown || '').match(new RegExp(`<b>${owner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}：</b>[^<]*?负责\\s*(\\d+)\\s*项[^<]*?(\\d+)\\s*项\\s*✅`))
    if (!hit) continue
    if (Number(hit[1]) !== item.total || Number(hit[2]) !== item.done) out.push(`${owner}：高亮框写「负责 ${hit[1]} 项，${hit[2]} 项 ✅」，按状态算是 ${item.total} 项、${item.done} 项 ✅`)
  }
  return out
}

// 群里看的原因：去掉提交号 / 路径 / schema 名，截到第一个分句、不超过 24 字（aven：短版说人话）。
export const shortReason = (item) => {
  const raw = String(item?.reason || '').replace(/`/g, '').replace(/\b[0-9a-f]{7,40}\b/g, '').replace(/\b[\w./-]*(?:Schema|\.tsx?|\.mjs)\b/g, '').replace(/origin\/pre/g, 'pre')
  const first = raw.split(/[；;。\n]/)[0].replace(/[，,、\s]+$/, '').trim()
  if (!first) return item?.pre === '未部署' ? '待部署' : '原因待补'
  return first.length > 24 ? `${first.slice(0, 24)}…` : first
}

// 短版第一行：数字全部来自脚本，和完整版同一组。
export const buildHeadline = ({ progress, gained = null }) => {
  const hidden = progress.preHidden
  const hiddenText = hidden.length ? `其中 ${hidden.length} 项在 pre 上还看不到效果：${hidden.map((item) => `#${item.no} ${shortReason(item)}`).join('；')}。` : ''
  return `总体进度 **${progress.percent.toFixed(1)}%**，已接通 **${progress.done} / ${progress.total}**${gained === null ? '' : `，今日 ${gained >= 0 ? '+' : ''}${gained}`}。${hiddenText}`
}
