/**
 * Lark 组件共享的仓库路径出口：主仓根、worktree 同级目录、运行时目录。
 * 路径本身统一在 lark-paths.mjs 解析；这里只做向后兼容的命名转出（repoRoot 等老名字遍布各模块），
 * 外加运行时文件权限收紧。
 */

import { chmodSync, existsSync, statSync } from 'node:fs'

export { consumerRoot as repoRoot, larkRuntimeDir, larkTasksDir, worktreesDir } from './lark-paths.mjs'

// runtime/*.json 里有本机配置（bug 表 appToken/URL）与任务运行态，本机其他用户/进程无需可读。
// 任务文件写入时已带 mode 0o600（lark-task-store），但配置与状态文件多是历史遗留的 0644，
// 且 mode 只在「创建」时生效——已存在的文件改不动权限，故启动时统一收紧一次。
export const hardenRuntimeFiles = (files) => {
  const tightened = []
  for (const file of files) {
    try {
      if (!existsSync(file)) continue
      // eslint-disable-next-line no-bitwise -- 只取权限位
      const mode = statSync(file).mode & 0o777
      if (mode & 0o077) {
        chmodSync(file, 0o600)
        tightened.push(`${file.split('/').pop()}(${mode.toString(8)}→600)`)
      }
    } catch {
      // 权限收紧是尽力而为：读不到/改不动不该拦住启动（真正的边界是共享密钥与白名单）。
    }
  }
  return tightened
}
