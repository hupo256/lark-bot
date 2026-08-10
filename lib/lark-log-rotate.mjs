/**
 * launchd 日志的进程内轮转（copy-truncate）。gateway / worker 的 stdout+stderr 都被 launchd
 * 重定向到一个固定文件，进程可以连跑数周不重启——worker.log 里还带着 AI 的完整 transcript，
 * 实测一天就能涨到 10MB，没有任何上限。这里在进程内定时做 copy-truncate 把它压回去。
 */

import { copyFileSync, existsSync, renameSync, statSync, truncateSync, unlinkSync } from 'node:fs'

// 默认单文件 8MB、保留 1 个历史代（磁盘占用上界 ≈ 16MB），每 10min 查一次。
const defaultMaxBytes = Math.max(0, Number(process.env.LARK_LOG_MAX_BYTES || 8 * 1024 * 1024))
const defaultKeep = Math.max(0, Number(process.env.LARK_LOG_KEEP || 1))
const defaultIntervalMs = Math.max(60_000, Number(process.env.LARK_LOG_ROTATE_MS || 10 * 60 * 1000))

// 大小判定取 st_size 与「实际占用磁盘块」的**较小值**。
// 为什么要看块数：copy-truncate 之后 launchd 那个 fd 若不是 O_APPEND，就会从旧 offset 继续写，
// 文件变成前面全是空洞的稀疏文件——st_size 依旧巨大，于是每轮都判超限、每轮都 copy 一个巨大文件。
// 为什么不只看块数：文件系统按块分配，100 字节的小文件也占一整块，只看块数会把小日志误判成超限。
// 取 min 后两种情况都正确。
const diskBytes = (file) => {
  const stat = statSync(file)
  const allocated = typeof stat.blocks === 'number' && stat.blocks >= 0 ? stat.blocks * 512 : stat.size
  return Math.min(stat.size, allocated)
}

// 单次轮转：超限则 <file>.1 …… <file>.keep 依次后移，再 copy-truncate 当前文件。
// 必须是 copy-truncate 而非 rename：日志 fd 由 launchd 在 exec 前打开并持有，
// rename 之后进程仍朝着被改名的那个 inode 写，新 file 永远是空的，直到下次重启才恢复。
export const rotateLogIfLarge = ({ file, maxBytes = defaultMaxBytes, keep = defaultKeep } = {}) => {
  if (!file || !maxBytes || !existsSync(file)) return false
  try {
    if (diskBytes(file) < maxBytes) return false
    for (let index = keep; index >= 1; index -= 1) {
      const older = `${file}.${index + 1}`
      const current = `${file}.${index}`
      if (index === keep && existsSync(current)) unlinkSync(current)
      else if (existsSync(current)) renameSync(current, older)
    }
    if (keep >= 1) copyFileSync(file, `${file}.1`)
    truncateSync(file, 0)
    console.log(`[lark-log] 已轮转 ${file}（超过 ${Math.round(maxBytes / 1024 / 1024)}MB）`)
    return true
  } catch (error) {
    // 轮转是运维便利，不是业务：任何失败只记一行，绝不影响 gateway / worker 本职工作。
    console.error(`[lark-log] 轮转 ${file} 失败：${String(error).slice(0, 160)}`)
    return false
  }
}

// 启动定时轮转。file 缺省取 LARK_LOG_FILE（由 plist 注入）；没配就直接返回 null 不做任何事，
// 这样前台手跑（日志在终端里）不会莫名去截断某个文件。
export const startLogRotation = ({
  file = process.env.LARK_LOG_FILE,
  maxBytes = defaultMaxBytes,
  keep = defaultKeep,
  intervalMs = defaultIntervalMs,
} = {}) => {
  if (!file || !maxBytes) return null
  rotateLogIfLarge({ file, maxBytes, keep }) // 启动即查一次：重启前积压的大文件立刻压回去
  const timer = setInterval(() => rotateLogIfLarge({ file, maxBytes, keep }), intervalMs)
  timer.unref?.()
  return timer
}
