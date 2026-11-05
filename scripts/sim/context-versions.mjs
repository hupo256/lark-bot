/**
 * 回放上下文「按当时的版本供数」的纯函数（docs/replay/falive-replay-plan-2026-11-03.md §6-1 补：消除未来信息）。
 * build-context-cache.mjs 拉修订 / 记录历史时用它算统计，fake-lark-cli.mjs 按虚拟时钟用它还原。
 *
 * 云文档：raw/docs/<token>/revisions.json（docs +history-list 的全部条目，升序）+ raw/docs/<token>/<revision_id>.json
 *   （docs +fetch --revision-id 的原始 stdout）。取「edit_time ≤ now 的最后一条」：history 的 edit_time 是该修订形成的时刻，
 *   只取不晚于 now 的，不会给出未来内容（同一窗口里合并的中间修订可能偏旧一点，不会偏新）。
 * bug 记录：raw/bug-records/history/<record_id>.json（同一时刻拉的 +record-get 快照 + +record-history-list 全部条目）。
 *   从快照出发，把 create_time > now 的变更按 rev 从新到旧逐条撤回（字段值改回 before）；before 是历史接口的原始形
 *   （单选给选项 id、人员给名字、日期给毫秒），按字段元数据转成 +record-get 的形（选项名数组、[{id,name}]、带时区的 ISO）。
 *   历史接口不记的字段（lookup / formula / 自动编号 / 创建时间）保持快照值，列进 unpinnedFields。
 */

export const parseJsonSafe = (text) => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// —— 云文档 ——
// index.entries：[{ revisionId, editMs, file, ok }] 升序。返回 { status:'pinned', entry } | { status:'not-created', createdMs } | { status:'no-revision' }。
export const docRevisionAt = (index, nowMs, { revisionId = null } = {}) => {
  const entries = (index?.entries || []).filter((e) => e.ok && e.file)
  if (!entries.length) return { status: 'no-revision' }
  if (revisionId != null && Number(revisionId) !== -1) {
    const entry = entries.find((e) => Number(e.revisionId) === Number(revisionId) && e.editMs <= nowMs)
    return entry ? { status: 'pinned', entry } : { status: 'no-revision' }
  }
  const createdMs = Number.isFinite(index.createdMs) ? index.createdMs : entries[0].editMs
  if (nowMs < createdMs) return { status: 'not-created', createdMs }
  let hit = null
  for (const e of entries) if (e.editMs <= nowMs) hit = e
  return hit ? { status: 'pinned', entry: hit } : { status: 'no-revision' }
}

// —— bug 记录 ——
// 历史接口不记的字段类型（lark-base 历史协议：计算字段、系统字段）
const UNTRACKED_TYPES = new Set(['lookup', 'formula', 'auto_number', 'created_at', 'created_by'])
const SYSTEM_TIME = 'updated_at'
const SYSTEM_USER = 'updated_by'

// 毫秒 → 「2026-10-28T00:00:00.000+04:00」（+record-get 的形，按表的 timezone）
export const formatInZone = (ms, timeZone) => {
  const date = new Date(ms)
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(date).map((p) => [p.type, p.value]))
  const local = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second))
  const offsetMin = Math.round((local - Math.floor(ms / 1000) * 1000) / 60000)
  const sign = offsetMin >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMin)
  const ms3 = String(((ms % 1000) + 1000) % 1000).padStart(3, '0')
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${ms3}${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
}

const isEmpty = (v) => v == null || v === '' || (Array.isArray(v) && v.length === 0)
const asList = (v) => (isEmpty(v) ? [] : Array.isArray(v) ? v : [v])

// 历史接口的值 → +record-get 的值。meta：{ options: { [fieldId]: { [optId]: name } }, userIds: { [name]: open_id } }。
// 返回 { value, unresolved: [说明] }。
export const historyValueToRecordValue = ({ value, type, fieldId, meta, timeZone }) => {
  const unresolved = []
  if (isEmpty(value)) return { value: null, unresolved }
  if (type === 'select') {
    const names = asList(value).map((id) => {
      const name = meta.options?.[fieldId]?.[id]
      if (name == null) unresolved.push(`选项 ${id} 不在字段定义里`)
      return name ?? id
    })
    return { value: names, unresolved }
  }
  if (type === 'user' || type === SYSTEM_USER) {
    const users = asList(value).map((u) => {
      if (u && typeof u === 'object') return { id: u.id ?? meta.userIds?.[u.name] ?? null, name: u.name }
      const id = meta.userIds?.[u]
      if (!id) unresolved.push(`人员「${u}」没有 open_id`)
      return { id: id ?? null, name: u }
    })
    return { value: users, unresolved }
  }
  if (type === 'attachment') return { value: asList(value).map(({ file_token, name, size }) => ({ file_token, name, size })), unresolved }
  if (type === 'datetime' || type === SYSTEM_TIME) {
    const ms = typeof value === 'number' ? value : Number.isFinite(Number(value)) ? Number(value) : Date.parse(value)
    if (!Number.isFinite(ms)) return { value, unresolved: [`日期值 ${JSON.stringify(value)} 认不出`] }
    return { value: formatInZone(ms, timeZone), unresolved }
  }
  if (type === 'text') {
    if (Array.isArray(value)) return { value: value.map((seg) => (typeof seg === 'string' ? seg : seg?.text ?? '')).join(''), unresolved }
    return { value: String(value), unresolved }
  }
  return { value, unresolved: [`字段类型 ${type} 未适配，按历史原值`] }
}

// 历史条目（rev ≤ 快照 rev 的，升序）
const itemsOf = (history) => {
  const snapRev = Number(history.snapshotRev)
  return (history.items || []).filter((it) => !Number.isFinite(snapRev) || Number(it.rev) <= snapRev).sort((a, b) => Number(a.rev) - Number(b.rev))
}
export const recordCreatedMs = (history) => {
  const created = itemsOf(history).find((it) => it.activity_type === 'create')
  return created ? Number(created.create_time) * 1000 : null
}

// 还原 nowMs 时刻的 +record-get 输出。history：{ recordId, snapshot（+record-get 原始 stdout）, snapshotRev, items }。
// 返回 { status:'pinned'|'not-created'|'before-history'|'bad-snapshot', payload, reverted, changedFields, unpinnedFields, unresolved }
export const reconstructRecordAt = ({ history, meta, nowMs }) => {
  const snap = parseJsonSafe(history.snapshot)
  const data = snap?.data
  if (!data?.fields || !data.data?.[0]) return { status: 'bad-snapshot', payload: null, reverted: 0, changedFields: [], unpinnedFields: [], unresolved: [] }
  const ids = data.field_id_list || []
  const types = data.field_type_list || []
  const timeZone = data.timezone || 'UTC'
  const items = itemsOf(history)
  const createdMs = recordCreatedMs(history)
  const unpinnedFields = data.fields.filter((_, i) => UNTRACKED_TYPES.has(types[i]))
  if (createdMs != null && nowMs < createdMs) {
    // 记录当时还不存在：真 CLI 对不存在的 id 回 ok、整行 null、record_not_found（11-03 实测）
    const payload = { ok: true, identity: snap.identity || 'user', data: { ...data, data: [data.fields.map(() => null)], record_not_found: [history.recordId], rev: data.rev } }
    return { status: 'not-created', payload, reverted: 0, changedFields: [], unpinnedFields: [], unresolved: [] }
  }
  const row = [...data.data[0]]
  const col = Object.fromEntries(ids.map((id, i) => [id, i]))
  const changed = new Set()
  const unresolved = []
  let reverted = 0
  for (const it of [...items].reverse()) {
    if (Number(it.create_time) * 1000 <= nowMs) continue
    reverted += 1
    for (const fc of it.field_changes || []) {
      const i = col[fc.field_id]
      if (i == null) {
        unresolved.push(`字段 ${fc.field_name || fc.field_id} 不在快照里`)
        continue
      }
      const conv = historyValueToRecordValue({ value: fc.before, type: types[i], fieldId: fc.field_id, meta, timeZone })
      row[i] = conv.value
      changed.add(data.fields[i])
      unresolved.push(...conv.unresolved.map((u) => `${data.fields[i]}：${u}`))
    }
  }
  // 系统字段：最后更新时间 / 记录最后修改人 = now 之前最后一条变更（含创建）
  const last = [...items].reverse().find((it) => Number(it.create_time) * 1000 <= nowMs)
  if (reverted && last) {
    types.forEach((t, i) => {
      if (t === SYSTEM_TIME) {
        row[i] = formatInZone(Number(last.create_time) * 1000, timeZone)
        changed.add(data.fields[i])
      } else if (t === SYSTEM_USER) {
        const conv = historyValueToRecordValue({ value: last.operator, type: SYSTEM_USER, fieldId: ids[i], meta, timeZone })
        row[i] = conv.value
        changed.add(data.fields[i])
        unresolved.push(...conv.unresolved.map((u) => `${data.fields[i]}：${u}`))
      }
    })
  }
  const oldestMs = items.length ? Number(items[0].create_time) * 1000 : null
  const status = createdMs == null && (oldestMs == null || nowMs < oldestMs) ? 'before-history' : 'pinned'
  const payload = { ok: true, identity: snap.identity || 'user', data: { ...data, data: [row], ...(reverted && last ? { rev: Number(last.rev) } : {}) } }
  return { status, payload, reverted, changedFields: [...changed], unpinnedFields, unresolved: [...new Set(unresolved)] }
}

// 还原后的某一列（按字段名）
export const recordCell = (payload, fieldName) => {
  const data = payload?.data
  const i = (data?.fields || []).indexOf(fieldName)
  return i >= 0 ? data.data?.[0]?.[i] ?? null : null
}
