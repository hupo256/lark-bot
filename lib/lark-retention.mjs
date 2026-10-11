/**
 * Lark 运行时数据保留期清扫（纯 IO，可注入 now/attachmentsRoot 自测）。
 *
 * 缺口背景：附件下载到 runtime/lark-attachments/<PR>/<messageId>/，此前**无任何清理**，单调膨胀；
 * 且任务 JSON 被 pruneTerminal 清掉后，其附件目录仍留成孤儿。故这里按**目录 mtime TTL** 清扫（不依赖任务状态，
 * 天然连孤儿一起回收），与 gateway 里既有的 store.pruneTerminal（清任务 JSON）互补。
 */

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

const subDirs = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
  }
}

// 清扫根必须与下载落盘口径一致：lark-cli.downloadAttachments 写 attachmentsDirFor(project, messageId)
// = <larkAttachmentsRoot>/<PR>/<messageId>/（见 lark-paths），这里扫同一个根的 <PR>/<messageId>。
// 两边一旦分叉，下载的附件就永远清不掉。
// 删除各项目目录下 mtime 超过 maxAgeMs 的 <messageId> 目录。返回 { removed, freedDirs }。
export const sweepAttachments = ({ attachmentsRoot, maxAgeMs, now = Date.now() } = {}) => {
  const freedDirs = []
  if (!attachmentsRoot || !existsSync(attachmentsRoot) || !(maxAgeMs > 0)) return { removed: 0, freedDirs }
  const cutoff = now - maxAgeMs
  for (const project of subDirs(attachmentsRoot)) {
    const attachRoot = join(attachmentsRoot, project)
    if (!existsSync(attachRoot)) continue
    for (const msgDir of subDirs(attachRoot)) {
      const full = join(attachRoot, msgDir)
      let mtimeMs
      try {
        mtimeMs = statSync(full).mtimeMs
      } catch {
        continue
      }
      if (mtimeMs >= cutoff) continue
      try {
        rmSync(full, { recursive: true, force: true })
        freedDirs.push(full)
      } catch {
        // 删除失败（权限/占用）不阻塞，下轮再试
      }
    }
  }
  return { removed: freedDirs.length, freedDirs }
}
