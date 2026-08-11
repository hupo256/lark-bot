/**
 * Lark bug 表轮询的纯解析层（零 IO，可 `node --test` 直测）：任务状态分流、人员/状态/项目号
 * 字段读取、bug 正文拼装、列式记录 zip 回对象。轮询器只保留 IO 与编排。
 */

import { parseCommandType } from './lark-message.mjs'

const ACTIVE_TASK_STATUSES = new Set(['received', 'queued', 'running', 'verifying', 'done_pending_writeback'])
const WAITING_TASK_STATUSES = new Set(['blocked', 'waiting_confirmation'])
export const QA_RETURN_REOPENABLE_STATUSES = new Set(['done', 'done_pending_writeback', 'failed', 'no_change_needed'])

// bug 表字段名默认值：config.bugTable 未显式配置时的兜底列名，poller 的列投影与本文件解析共用同一份，
// 避免两处各写一份 `|| '项目ID'` 式字面量、字段改名时只改一处却另一处悄悄读旧名。
export const BUGTABLE_FIELD_DEFAULTS = {
  projectField: '项目ID',
  titleField: '问题标题',
  descField: '问题描述（复现步骤）',
}

// gateway 任务状态 → 轮询去重分流：done / in-flight / waiting / no-change / failed / new。
export const classifyBugTaskStatus = (status) => {
  if (status === 'done') return 'done'
  if (ACTIVE_TASK_STATUSES.has(status)) return 'in-flight'
  if (WAITING_TASK_STATUSES.has(status)) return 'waiting'
  // no_change_needed：本仓无对应改动（转后端/别的仓）。终局，不自动重跑（否则每轮都重判、刷群烧钱），
  // 留在表里待人工重新分派；与 failed 一样仅计数暴露，不入 seen（表格状态未回写完成态）。
  if (status === 'no_change_needed') return 'no-change'
  if (status === 'failed') return 'failed'
  return 'new'
}

// 表格状态 + Gateway 任务状态 → poller 动作。QA 把记录明确改为「验退」时，代表一次新的人工
// 验收结论：即使 record_id 已 seen、旧任务已 done/failed，也要开启新一轮；活动/等待态仍去重。
export const classifyBugPollAction = ({ recordStatus, taskStatus, seen, rejectedValue }) => {
  const isQaReturn = Boolean(rejectedValue) && recordStatus === rejectedValue
  if (!isQaReturn && seen) return 'seen'
  if (isQaReturn && QA_RETURN_REOPENABLE_STATUSES.has(taskStatus)) return 'reopen'

  const disposition = classifyBugTaskStatus(taskStatus)
  if (disposition === 'new') return 'enqueue'
  return disposition
}

// lark-cli Base filter：未配置 rejectedValue 时保持原来的单状态查询；配置后一次查「待处理 OR 验退」。
export const buildBugStatusFilter = ({ statusField, pendingValue, rejectedValue }) => {
  const values = [...new Set([pendingValue, rejectedValue].filter(Boolean))]
  return {
    logic: values.length > 1 ? 'or' : 'and',
    conditions: values.map((value) => [statusField, '==', value]),
  }
}

// 人员字段值形如 [{id/open_id, name}]；判断是否含目标 open_id
export const assigneeHasOpenId = (value, openId) => {
  if (!openId || !Array.isArray(value)) return false
  return value.some((person) => person?.id === openId || person?.open_id === openId)
}

// 单选/文本状态字段取文本值
export const readStatusText = (value) => {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((item) => typeof item === 'string' ? item : item?.text || item?.name || '')
      .join('')
  }
  return value?.text || value?.name || ''
}

// 项目ID 列值形如 "PR-01947" / "PM-1469\n"（探针见过尾部换行），取文本并去空白
export const readProjectId = ({ fields, bug }) => readStatusText(fields[bug.projectField || BUGTABLE_FIELD_DEFAULTS.projectField]).trim()

// bug 表记录只按**显式前缀**（首行「状态：/status:」等）判命令类型，绝不做自然语言兜底：
// 误把一条真 bug 推断成 status，会让它走只读沙箱 + 零改动 done + 回写完成值后离开待处理筛选，
// 整条记录静默关闭且无人再看见（P0-1）。QA 验退始终按 fix 处理。缺陷正文里出现「状态」二字
// 也不会命中——只有 QA/PM 在标题里显式写「状态：xxx」才当只读查询。
export const readBugCommandType = ({ fields, bug }) => {
  const status = readStatusText(fields[bug.statusField])
  if (bug.rejectedValue && status === bug.rejectedValue) return 'fix'
  const title = readStatusText(fields[bug.titleField || BUGTABLE_FIELD_DEFAULTS.titleField])
  const desc = readStatusText(fields[bug.descField || BUGTABLE_FIELD_DEFAULTS.descField])
  return parseCommandType([title, desc].filter(Boolean).join('\n'))
}

// 把记录正文拼成给 AI 的 task 文本
export const buildBugText = ({ record, bug }) => {
  const fields = record.fields || {}
  const title = readStatusText(fields[bug.titleField || BUGTABLE_FIELD_DEFAULTS.titleField]) || '(无标题)'
  const desc = readStatusText(fields[bug.descField || BUGTABLE_FIELD_DEFAULTS.descField]) || ''
  const projectId = readProjectId({ fields, bug })
  const status = readStatusText(fields[bug.statusField])
  const isQaReturn = Boolean(bug.rejectedValue) && status === bug.rejectedValue
  const commandType = readBugCommandType({ fields, bug })
  return [
    commandType === 'status'
      ? `状态：${title}`
      : `修复：Lark bug 表${isQaReturn ? '验退' : '待处理'}项 [${title}]`,
    commandType === 'status' ? '来源：Lark bug 表只读查询项；只返回项目当前状态，不修改代码。' : null,
    isQaReturn
      ? 'QA 验退：上一轮修复已发布到 test，但实际表现仍不符合要求。先对照当前代码、上一轮改动和问题描述深入分析未解决的根因，再继续修复；不要原样重复上一轮方案。'
      : null,
    projectId ? `项目：${projectId}` : '项目：(表格未填项目ID，无法确定目标仓库，请在结果里说明)',
    `记录 ID：${record.record_id}`,
    `描述：${desc || '(表格未填描述，请结合标题与项目文档定位)'}`,
  ].filter(Boolean).join('\n')
}

// base +record-list 返回列式结构：data.fields 是列名字符串数组，data.data 是行（单元格数组），
// data.record_id_list 是并行的 record_id。这里 zip 回 { record_id, fields } 记录对象。
export const parseColumnarRecords = (data) => {
  const cols = data.fields || []
  const rows = data.data || []
  const ids = data.record_id_list || []
  return rows.map((row, rowIndex) => {
    const fields = {}
    cols.forEach((name, colIndex) => {
      fields[name] = row[colIndex]
    })
    return { record_id: ids[rowIndex], fields }
  })
}
