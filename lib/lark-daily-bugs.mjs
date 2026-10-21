// 测试阶段日报的 Bug 段（aven 2026-10-21：项目进入测试，日报不再列对接问题，改报 bug 表进度）。
// 数字全由脚本从 Lark 多维表格读出来算，不经模型：群简报替换原「卡点 → 等谁」，完整版放在二节。
import { runLarkCli } from './lark-cli.mjs'
import { parseColumnarRecords, readStatusText } from './lark-bugtable-parse.mjs'

// 状态展示顺序：没解决的在前。表里出现了不认识的状态，按出现顺序排在后面，不丢。
const STATUS_ORDER = ['待处理', '修复中', '待推版', '已推版', 'Pre测试通过', '产品后续优化', '非BUG，已关闭']
// 还要有人动手的：待处理、修复中（待推版 / 已推版是修好了等发版、等测试复测，不算欠着）。
const OPEN_STATUSES = new Set(['待处理', '修复中'])
const FIELDS = { status: '状态', owners: '负责RD', created: '创建时间' }

const personNames = (value) => (Array.isArray(value) ? value : [])
  .map((item) => String(item?.name || '').replace(/^[.\s]+/, '').trim())
  .filter(Boolean)

// 纯函数：records = parseColumnarRecords 的结果；date = 日报日期（本地 YYYY-MM-DD）。
export const summarizeBugs = ({ records = [], date }) => {
  const byStatus = new Map()
  const openByOwner = new Map()
  let today = 0
  for (const { fields } of records) {
    const status = readStatusText(fields[FIELDS.status]).trim() || '（没填状态）'
    byStatus.set(status, (byStatus.get(status) || 0) + 1)
    if (String(fields[FIELDS.created] || '').slice(0, 10) === date) today += 1
    if (!OPEN_STATUSES.has(status)) continue
    const owners = personNames(fields[FIELDS.owners])
    for (const owner of owners.length ? owners : ['未分配']) openByOwner.set(owner, (openByOwner.get(owner) || 0) + 1)
  }
  const rank = (status) => (STATUS_ORDER.includes(status) ? STATUS_ORDER.indexOf(status) : STATUS_ORDER.length)
  return {
    total: records.length,
    today,
    byStatus: [...byStatus].sort((a, b) => rank(a[0]) - rank(b[0])),
    openByOwner: [...openByOwner].sort((a, b) => b[1] - a[1]),
  }
}

// 渲染成两行列表（群简报与完整版共用）；没有 bug 写「暂无」。
export const renderBugLines = (summary) => {
  if (!summary.total) return ['- 暂无']
  const lines = [`- 共 ${summary.total} 个，今天新增 ${summary.today}：${summary.byStatus.map(([status, count]) => `${status} ${count}`).join('、')}`]
  lines.push(summary.openByOwner.length ? `- 待处理 / 修复中按负责人：${summary.openByOwner.map(([owner, count]) => `${owner} ${count}`).join('、')}` : '- 待处理 / 修复中：--')
  return lines
}

// 用户身份读视图（aven 已授权读写这张表；bot 身份无权限）。lark-cli 每页最多 200 条，按 offset 翻页（最多 10 页）。
// 读不到返回 { ok: false, reason }，日报照发、私信核对单里说明。lark-cli 的错误 JSON 可能在 stderr。
const PAGE = 200
const parseJson = (text) => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
export const fetchBugRecords = async ({ table, runCli = runLarkCli, maxPages = 10 }) => {
  if (!table?.baseToken || !table?.tableId) return { ok: false, reason: '没配 dailyReport.bugTable' }
  const records = []
  for (let page = 0; page < maxPages; page += 1) {
    const args = ['base', '+record-list', '--base-token', table.baseToken, '--table-id', table.tableId, ...(table.viewId ? ['--view-id', table.viewId] : []), '--format', 'json', '--limit', String(PAGE), '--offset', String(page * PAGE)]
    const result = await runCli(args, { identity: 'user' })
    const parsed = parseJson(result.stdout || '') || parseJson(result.stderr || '')
    if (result.code !== 0 || !parsed?.ok || !parsed?.data) {
      const detail = parsed?.error?.message || String(result.stderr || result.stdout || '').trim()
      return { ok: false, reason: `lark-cli 读 bug 表失败：${detail.slice(0, 160)}` }
    }
    records.push(...parseColumnarRecords(parsed.data))
    if (!parsed.data.has_more) return { ok: true, records }
  }
  return { ok: false, reason: `bug 表超过 ${maxPages * PAGE} 条，没读完` }
}
