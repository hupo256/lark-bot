/**
 * 本地日期（aven 2026-10-20 review）：日报 / 清扫的「哪天」一律按本机时区算（调度 19:00、workHours 都跟随本机 +04）。
 * 任务的 createdAt / updatedAt、推送时间是 UTC ISO，不能拿前 10 位直接和本地日期比——本地 00:00 到时差那几小时会算成前一天。
 * 无依赖的叶子模块：日报调度 / 生成 / 清扫都从这里取，避免 sweep ↔ schedule ↔ repo-delivery 的循环 import。
 */

const pad = (n) => String(n).padStart(2, '0')

export const localDateKey = (date = new Date()) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`

// 时间戳（Date / ISO 字符串 / 毫秒）→ 本地日期 YYYY-MM-DD；解析不了返回 null。
export const localDateOf = (value) => {
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(String(value || ''))
  return Number.isFinite(ms) ? localDateKey(new Date(ms)) : null
}
