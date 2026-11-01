/**
 * 任务收尾停掉工作区的页面验证服务（只给 worker 用，gateway 不能引用：这里有同步子进程）。
 */

import { spawnSync } from 'node:child_process'

import { VERIFY_PAGE_TOOL } from './lark-verify-page.mjs'

// 没起过服务就什么都不做。必须在提交、删临时工作区之前：服务边跑边删会删不干净
//（10-23 实测：依赖目录被删后 vite 在工作区根上另建 .vite 缓存，git worktree remove 报目录非空）。
export const stopVerifyServer = (cwd, { spawn = spawnSync, log = console.log } = {}) => {
  if (!cwd) return
  try {
    const result = spawn(process.execPath, [VERIFY_PAGE_TOOL, 'stop', '--cwd', cwd], { encoding: 'utf8', timeout: 20_000 })
    const out = String(result?.stdout || '').trim()
    if (out && !out.startsWith('这个工作区没有')) log(`[lark-worker] ${out}`)
  } catch (error) {
    log(`[lark-worker] 停验证服务失败（不影响收尾，3 小时后工具自动回收）：${String(error?.message || error).slice(0, 120)}`)
  }
}
