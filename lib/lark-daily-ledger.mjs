/**
 * 日报的确定性部分（aven 2026-10-14）：
 *   · 状态以 origin/pre 真实代码为准、覆盖所有负责人——模型在完整版末尾输出逐功能状态 JSON，脚本校验齐全并据此算总体进度 / 计数，
 *     回写一节表格的状态列，短版与完整版用同一组数字；
 *   · 三节是台账（10-21 起二节是脚本生成的测试 Bug 段，不再是台账）：解决一行删一行，昨天有、今天没、又没在 resolved 里给依据的行 = 无故消失，私信 aven；节标题带「剩 n 行（今日删 m 行）」；
 *   · pre 线上构建时间、直播拉流可达性由脚本实测（模型只读、没网络）；
 *   · 只在工作日发。
 * 全是纯函数（网络部分可注入 fetch），单测见 __tests__/lark-daily-ledger.test.mjs。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
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
// 百分比 = ✅ 数 / 计入项数（10-23 aven「数量对不上」：原来按 🟠 60 / 🟡 30 加权，表格只显示 ✅ / ⬜，99.3% 和 53 / 54 对不上）。
const isCounted = (no, excluded) => !excluded.includes(no)

export const computeProgress = ({ rows = [], statuses, excluded = [54] }) => {
  const counted = rows.filter((row) => isCounted(row.no, excluded) && statuses.get(row.no)?.status !== '—')
  // 不计入的（#54 归后端、状态 — 的一期不做）：一节标题写的是全量项数，要注明哪几项不计，两处数字才对得上。
  const uncounted = rows.filter((row) => !counted.includes(row)).map((row) => ({ no: row.no, feature: row.feature || '', why: excluded.includes(row.no) ? '不归前端' : '一期不做' }))
  const byOwner = {}
  let done = 0
  for (const row of counted) {
    const item = statuses.get(row.no) || { status: '❌' }
    const owner = row.owner || '未定'
    byOwner[owner] ||= { done: 0, total: 0, open: [] }
    byOwner[owner].total += 1
    if (item.status === '✅') {
      done += 1
      byOwner[owner].done += 1
    } else byOwner[owner].open.push(row.no)
  }
  const total = counted.length
  return { total, done, open: total - done, percent: total ? Math.round((done / total) * 1000) / 10 : 0, byOwner, excluded, uncounted }
}

const ownerOrder = (byOwner) => Object.entries(byOwner).sort((a, b) => (a[0] === 'aven' ? -1 : b[0] === 'aven' ? 1 : b[1].open.length - a[1].open.length))

// 一节表后的计数块；「- 名字 n 项：#…」格式是日报清扫（lark-daily-sweep）的读取约定，别改。
export const renderCounts = (progress) => {
  const doneParts = ownerOrder(progress.byOwner).filter(([, item]) => item.done).map(([owner, item]) => `${owner} ${item.done}`)
  const head = `**计数**（不含 #${(progress.uncounted?.length ? progress.uncounted.map((item) => item.no) : progress.excluded).join(' #')}）：✅ ${progress.done} 项${doneParts.length ? `（${doneParts.join('、')}）` : ''}。未完成 ${progress.open} 项：`
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
    const cells = splitCells(line)
    if (cells.every((cell) => cell === '--')) continue // 空表占位行，不是台账行
    out.push({ index, cells })
  }
  return out
}

export const normalizeKey = (text) => String(text || '').replace(/\*\*|`|~~/g, '').replace(/\s+/g, '').replace(/[（(].*?[)）]/g, '').toLowerCase()

// 一节表格的「状态」列按代码状态回写（✅ 原样，其余 ⬜，#54 —）；合并行（如 17–20）全 ✅ 才写 ✅。
// 状态后面的列只写卡点（aven 2026-10-21）：✅ / — 的行没有卡点，一律 --；没打勾的行空格子也写 --。
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
    for (let col = statusCol + 1; col < cells.length; col += 1) if (mark !== '⬜' || !cells[col]) cells[col] = '--'
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
  // 一节标题「（… = 56）」后注明不计的几项和计入数，和总体进度的分母对上。
  const note = progress.uncounted?.length ? `；不计 ${progress.uncounted.map((item) => `#${item.no}（${item.why}）`).join('、')}，计 ${progress.total} 项` : ''
  text = text.replace(/^(## 一、[^\n]*?)(?:；不计 [^\n]*?，计 \d+ 项)?）\s*$/m, (_, head) => `${head}${note}）`)
  const counts = renderCounts(progress)
  const block = /^\*\*计数\*\*.*\n(?:- .*\n?)*/m
  if (block.test(text)) return text.replace(block, `${counts}\n`)
  return text.replace(/\n## 二、/, `\n${counts}\n\n## 二、`)
}

// ── 三节台账 ───────────────────────────────────────────
// 二节 10-21 起由脚本按 bug 表生成（aven：测试阶段对接问题不进日报），不参与台账比对，昨天的对接行也不会被当成「无故消失」。
export const LEDGER_SECTIONS = [{ name: '三', prefix: '## 三、' }]

// 整节替换成给定的行（标题行也在 lines 里）；没有这一节就插到下一节（「## 三、」）前面，再没有就追加到末尾。
export const replaceSection = (markdown, prefix, lines) => {
  const all = String(markdown || '').split('\n')
  const range = sectionRange(all, prefix)
  if (range) return [...all.slice(0, range.start), ...lines, '', ...all.slice(range.end)].join('\n')
  const next = all.findIndex((line) => /^## 三、/.test(line))
  return next < 0 ? [...all, '', ...lines].join('\n') : [...all.slice(0, next), ...lines, '', ...all.slice(next)].join('\n')
}

// 昨天的行今天还在吗：以首列（规范化）为键。消失的行要在 resolved 里有依据，否则算无故消失。
export const diffLedger = ({ previous, current, resolved = [] }) => LEDGER_SECTIONS.map(({ name, prefix }) => {
  const before = sectionTableRows(previous, prefix).map((row) => row.cells[0]).filter(Boolean)
  const currentKeys = sectionTableRows(current, prefix).map((row) => row.cells[0]).filter(Boolean)
  const after = new Set(currentKeys.map(normalizeKey))
  const beforeKeys = new Set(before.map(normalizeKey))
  const sectionResolved = resolved.filter((item) => !item.section || item.section === name)
  const removed = before.filter((key) => !after.has(normalizeKey(key)))
  const matches = (item, key) => {
    const hit = normalizeKey(item.key)
    return Boolean(hit) && (hit === normalizeKey(key) || normalizeKey(key).includes(hit) || hit.includes(normalizeKey(key)))
  }
  return {
    name,
    prefix,
    remaining: after.size,
    removed,
    added: currentKeys.filter((key) => !beforeKeys.has(normalizeKey(key))),
    unexplained: removed.filter((key) => !sectionResolved.some((item) => matches(item, key))),
    resolved: sectionResolved,
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

// ── 精简（aven 2026-10-21） ──────────────────────────────
// 高亮框每个负责人一行就够：「运维」「外部阻塞」是对接问题（10-21 起不进日报），模板（昨天的完整版）里还带着，机械删掉。
const CALLOUT_EXTRA = /\s*<p><b>(?:运维|外部阻塞)：<\/b>.*?<\/p>/g
export const stripCalloutExtras = (markdown) => String(markdown || '').split('\n')
  .flatMap((line) => {
    const rest = line.replace(CALLOUT_EXTRA, '')
    return rest === line || rest.trim() ? [rest] : []
  }).join('\n')

// 字数上限：提示要求单元格 ≤ 60 字，这里留余量。超了不截断（会把句子改坏），列进私信核对单。
export const VERBOSE_LIMITS = { cell: 80, callout: 100 }
const visibleLength = (text) => String(text || '').replace(/<[^>]+>|`|\*\*/g, '').length
export const findVerbose = (markdown, limits = VERBOSE_LIMITS) => {
  const out = []
  for (const [, owner, text] of String(markdown || '').matchAll(/<p><b>([^<：]+)：<\/b>(.*?)<\/p>/g)) {
    if (visibleLength(text) > limits.callout) out.push(`高亮框 ${owner}（${visibleLength(text)} 字）`)
  }
  for (const { name, prefix } of [{ name: '一', prefix: '## 一、' }, ...LEDGER_SECTIONS]) {
    for (const row of sectionTableRows(markdown, prefix)) {
      const longest = Math.max(0, ...row.cells.slice(1).map(visibleLength))
      if (longest > limits.cell) out.push(`${name}节 ${name === '一' ? `#${row.cells[0]}` : row.cells[0]}（${longest} 字）`)
    }
  }
  return out
}
export const checkVerbose = (markdown, limits = VERBOSE_LIMITS) => {
  const hits = findVerbose(markdown, limits)
  return hits.length ? [`超过字数上限 ${hits.length} 处（单元格 ${limits.cell} 字、高亮框 ${limits.callout} 字）：${hits.slice(0, 8).join('、')}${hits.length > 8 ? ' 等' : ''}`] : []
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

// 高亮框数字按脚本算的回写（aven 10-16：数字要跟着拍板 / 状态走，不能只私信说对不上）；只换两个数字，句子其它部分不动。
export const applyCalloutCounts = (markdown, progress) => {
  let text = String(markdown || '')
  for (const [owner, item] of Object.entries(progress.byOwner)) {
    const pattern = new RegExp(`(<b>${owner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}：</b>[^<]*?负责\\s*)(\\d+)(\\s*项[^<]*?)(\\d+)(\\s*项\\s*✅)`)
    text = text.replace(pattern, (_, head, _total, middle, _done, tail) => `${head}${item.total}${middle}${item.done}${tail}`)
  }
  return text
}

// 高亮框「；没完成的 #x 卡在…」里只提到已 ✅ 功能的分句删掉（aven 2026-10-21：拍板关闭在模型写完之后，数字回写了、句子还说没完成）。
// 全部 ✅ 的负责人只留「负责 n 项，n 项 ✅」；分句没提编号的保留。
export const pruneCalloutDone = (markdown, statuses) => String(markdown || '').replace(/(<p><b>[^<：]+：<\/b>[^<]*?负责\s*\d+\s*项[^<]*?\d+\s*项\s*✅[^；<]*)([^<]*)(<\/p>)/g, (whole, head, tail, close) => {
  const pieces = tail.split('；').map((piece) => piece.replace(/^没完成的\s*/, '').trim()).filter(Boolean)
  const open = pieces.filter((piece) => {
    const nos = [...piece.matchAll(/#(\d+)(?:[–-](\d+))?/g)].flatMap((hit) => expandNos(hit[2] ? `${hit[1]}–${hit[2]}` : hit[1]))
    return !nos.length || nos.some((no) => statuses.get(no)?.status !== '✅' && statuses.get(no)?.status !== '—')
  })
  return `${head}${open.length ? `；没完成的 ${open.join('；')}` : ''}${close}`
})

// ── 负责人拍板关闭（aven 2026-10-16） ───────────────────────
// runtime/lark-daily-report/<repo>/owner-closures.json：负责人确认已完成的功能、已了结的台账行。
// 拍板优先于模型按代码的判断：功能状态强制回写；台账行（按首列）强制删除，并记为有依据的删除，不会当「无故消失」补回。
export const OWNER_CLOSURES_FILE = 'owner-closures.json'
const EMPTY_CLOSURES = { features: [], rows: [] }

export const loadOwnerClosures = (dir) => {
  if (!dir || !existsSync(join(dir, OWNER_CLOSURES_FILE))) return EMPTY_CLOSURES
  try {
    return normalizeOwnerClosures(JSON.parse(readFileSync(join(dir, OWNER_CLOSURES_FILE), 'utf8')))
  } catch {
    return EMPTY_CLOSURES
  }
}

export const normalizeOwnerClosures = (raw) => ({
  features: (Array.isArray(raw?.features) ? raw.features : [])
    .map((item) => ({
      no: Number(item?.no),
      status: VALID_STATUS.has(item?.status) ? item.status : '✅',
      pre: VALID_PRE.has(item?.pre) ? item.pre : '能用',
      by: String(item?.by || '').trim(),
      at: String(item?.at || '').trim(),
      note: String(item?.note || '').trim(),
    }))
    .filter((item) => Number.isInteger(item.no)),
  rows: (Array.isArray(raw?.rows) ? raw.rows : [])
    .map((item) => ({ section: String(item?.section || '').trim(), key: String(item?.key || '').trim(), by: String(item?.by || '').trim(), at: String(item?.at || '').trim() }))
    .filter((item) => item.key),
})

const closureEvidence = (item) => `${item.by || '负责人'}${item.at ? ` ${item.at}` : ''} 拍板关闭${item.note ? `：${item.note}` : ''}`

// 功能拍板：覆盖模型给的状态（原地改 statuses）。
export const applyFeatureClosures = (statuses, closures = EMPTY_CLOSURES) => {
  for (const item of closures.features) statuses.set(item.no, { no: item.no, status: item.status, pre: item.pre, reason: '', evidence: closureEvidence(item) })
  return statuses
}

// 二、三节的表删空了只留表头不好看（aven 2026-10-21）：补一行 --（sectionTableRows 不把它当台账行）。
export const fillEmptyTables = (markdown) => {
  const lines = String(markdown || '').split('\n')
  const out = []
  let section = ''
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^## /.test(line)) section = line
    out.push(line)
    const inLedger = LEDGER_SECTIONS.some(({ prefix }) => section.startsWith(prefix))
    if (!inLedger || !isSeparator(line) || !lines[index - 1]?.trim().startsWith('|')) continue
    if (!lines[index + 1]?.trim().startsWith('|')) out.push(`| ${splitCells(lines[index - 1]).map(() => '--').join(' | ')} |`)
  }
  return out.join('\n')
}

// 台账拍板：删掉二 / 三节首列命中的行；返回删后的文档和「昨天还在」的那些行的 resolved 依据（只报一次，不天天刷）。
export const applyLedgerClosures = ({ markdown, previous = '', closures = EMPTY_CLOSURES }) => {
  const lines = String(markdown || '').split('\n')
  const drop = new Set()
  const resolved = []
  for (const { name, prefix } of LEDGER_SECTIONS) {
    const closed = closures.rows.filter((item) => !item.section || item.section === name)
    if (!closed.length) continue
    const keys = new Map(closed.map((item) => [normalizeKey(item.key), item]))
    for (const row of sectionTableRows(lines.join('\n'), prefix)) if (keys.has(normalizeKey(row.cells[0]))) drop.add(row.index)
    for (const row of sectionTableRows(previous, prefix)) {
      const item = keys.get(normalizeKey(row.cells[0]))
      if (item) resolved.push({ section: name, key: row.cells[0], evidence: closureEvidence(item) })
    }
  }
  return { doc: lines.filter((_, index) => !drop.has(index)).join('\n'), resolved }
}

// 短版第一行：数字全部来自脚本，和完整版同一组。只留进度和今日增量，不列「其中 k 项 pre 上还看不到效果」
//（aven 2026-10-20：群里的简报不要这段，18 项逐条列出来又长又像待办）。
export const buildHeadline = ({ progress, gained = null }) =>
  `总体进度 **${progress.percent.toFixed(1)}%**，已接通 **${progress.done} / ${progress.total}**${gained === null ? '' : `，今日 ${gained >= 0 ? '+' : ''}${gained}`}。`

// 不是问题的事不进日报：走查（aven 2026-10-20），部署 / 复测 / pre 上看不到效果 / 未合 pre（aven 2026-10-21，部署由 aven 发邮件安排）。
// 表格：第一列就是这类事的整行删（那是一件走查 / 部署事项），其余行只删单元格里提到它的分句；
// 列表 / 正文：删提到它的分句，删完只剩列表符号 / 标签 / 「名字：」就整行删。
const NON_ISSUE = /走查|pre\s*上?\s*还?看不到效果|还?没部署|未部署|待部署|发邮件部署|还?没有?复测|未复测|待复测|还?没回归|pre\s*上?\s*还?没验|pre\s*未验证|[未没]合\s*pre/
const LISTED_WALKTHROUGH = /\s*[/、]\s*(?:设计|UI|视觉|pre\s*)?走查|(?:设计|UI|视觉|pre\s*)?走查\s*[/、]\s*/gi
const LEAD = /^\s*(?:(?:[-*•]|\d+[.、])\s+)?(?:<[^>/]+>\s*)*(?:\*\*[^*]+\*\*\s*[：:]\s*|[^<：:]{1,20}[：:]\s*<\/b>\s*)?/
const TAIL = /(?:<\/[^>]+>\s*)*$/
const scrubClauses = (text) => {
  const value = text.replace(LISTED_WALKTHROUGH, '')
  if (!NON_ISSUE.test(value)) return value
  const lead = value.match(LEAD)[0]
  const tail = value.slice(lead.length).match(TAIL)[0]
  const pieces = value.slice(lead.length, value.length - tail.length).split(/(?<=[；;。，,])/)
  const kept = pieces.filter((piece) => !NON_ISSUE.test(piece)).join('').replace(/[，,、；;\s]+$/, '。')
  return `${lead}${kept}${tail}`
}
const isEmptyAfterLead = (line) => !line.slice(line.match(LEAD)[0].length).replace(/<\/?[^>]+>/g, '').replace(/[。；;，,\s]/g, '')
export const stripNonIssues = (markdown) => String(markdown || '').split('\n').flatMap((line) => {
  if (!NON_ISSUE.test(line)) return [line]
  if (/^\s*\|/.test(line)) {
    const cells = line.split('|')
    if (NON_ISSUE.test(cells[1] || '')) return []
    return [cells.map((cell) => (NON_ISSUE.test(cell) ? ` ${scrubClauses(cell.trim()).replace(/[。；;，,]$/, '')} ` : cell)).join('|')]
  }
  if (NON_ISSUE.test(line.match(LEAD)[0])) return [] // 标签本身就是这类事（「- **aven（本地已做、未合 pre）**：…」）
  const cleaned = scrubClauses(line)
  return isEmptyAfterLead(cleaned) ? [] : [cleaned]
}).join('\n')
