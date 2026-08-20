/**
 * Lark 运行时数据保留期清扫（纯 IO，可注入 now/prdsRoot 自测）。
 *
 * 缺口背景：附件下载到 <prds>/<PR>/agent/lark-attachments/<messageId>/，此前**无任何清理**，单调膨胀；
 * 且任务 JSON 被 pruneTerminal 清掉后，其附件目录仍留成孤儿。故这里按**目录 mtime TTL** 清扫（不依赖任务状态，
 * 天然连孤儿一起回收），与 gateway 里既有的 store.pruneTerminal（清任务 JSON）互补。
 */

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { resolveRoots } from '../../engine/agent-scripts/lib/roots.mjs'

const ATTACHMENTS_SUBPATH = 'agent/lark-attachments'

const subDirs = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
  }
}

// prds 根目录：附件按项目落在 <docsSystemRoot>/prds/<PR>/ 下（docsDir=resolveProjectRoot），故清扫根取 docsSystemRoot/prds。
export const prdsRootDir = () => join(resolveRoots().docsSystemRoot, 'prds')

// 删除各项目 agent/lark-attachments 下 mtime 超过 maxAgeMs 的 <messageId> 目录。返回 { removed, freedDirs }。
export const sweepAttachments = ({ prdsRoot, maxAgeMs, now = Date.now() } = {}) => {
  const freedDirs = []
  if (!prdsRoot || !existsSync(prdsRoot) || !(maxAgeMs > 0)) return { removed: 0, freedDirs }
  const cutoff = now - maxAgeMs
  for (const project of subDirs(prdsRoot)) {
    const attachRoot = join(prdsRoot, project, ATTACHMENTS_SUBPATH)
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
