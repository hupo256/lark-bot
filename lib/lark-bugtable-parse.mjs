/**
 * Lark bug 表轮询的纯解析层（零 IO，可 `node --test` 直测）：任务状态分流、人员/状态/项目号
 * 字段读取、bug 正文拼装、列式记录 zip 回对象。轮询器只保留 IO 与编排。
 */

const ACTIVE_TASK_STATUSES = new Set(['received', 'queued', 'running', 'verifying', 'done_pending_writeback'])
const WAITING_TASK_STATUSES = new Set(['blocked', 'waiting_confirmation'])

// gateway 任务状态 → 轮询去重分流：done / in-flight / waiting / failed / new。
export const classifyBugTaskStatus = (status) => {
  if (status === 'done') return 'done'
  if (ACTIVE_TASK_STATUSES.has(status)) return 'in-flight'
  if (WAITING_TASK_STATUSES.has(status)) return 'waiting'
  if (status === 'failed') return 'failed'
  return 'new'
}

// 人员字段值形如 [{id/open_id, name}]；判断是否含目标 open_id
export const assigneeHasOpenId = (value, openId) => {
  if (!openId || !Array.isArray(value)) return false
  return value.some((person) => person?.id === openId || person?.open_id === openId)
}

// 单选/文本状态字段取文本值
export const readStatusText = (value) => {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map((v) => v?.text || v?.name || '').join('')
  return value?.text || value?.name || ''
}

// 项目ID 列值形如 "PR-01947" / "PM-1469\n"（探针见过尾部换行），取文本并去空白
export const readProjectId = ({ fields, bug }) => readStatusText(fields[bug.projectField || '项目ID']).trim()

// 把记录正文拼成给 AI 的 task 文本
export const buildBugText = ({ record, bug }) => {
  const fields = record.fields || {}
  const title = readStatusText(fields[bug.titleField || '问题标题']) || '(无标题)'
  const desc = readStatusText(fields[bug.descField || '问题描述（复现步骤）']) || ''
  const projectId = readProjectId({ fields, bug })
  return [
    `修复：Lark bug 表待处理项 [${title}]`,
    projectId ? `项目：${projectId}` : '项目：(表格未填项目ID，无法确定目标仓库，请在结果里说明)',
    `记录 ID：${record.record_id}`,
    `描述：${desc || '(表格未填描述，请结合标题与项目文档定位)'}`,
  ].join('\n')
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
