/**
 * bug 发现两档调度的状态文件（runtime/lark-bug-watch.json）读写（aven 2026-11-01，B2）。
 * 只依赖 fs：poller 与 gateway（「开始测试 / 结束测试」私信指令）都用它，不把自修 / 子进程模块带进 gateway。
 */
import { existsSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

import { writeJsonAtomic } from './lark-fs.mjs'
import { larkRuntimeDir } from './lark-paths.mjs'
import { initialWatchState } from './lark-bug-watch.mjs'

export const watchStatePath = () => join(process.env.LARK_RUNTIME_DIR || larkRuntimeDir, 'lark-bug-watch.json')

export const loadWatchState = ({ path = watchStatePath(), now = Date.now() } = {}) => {
  if (!existsSync(path)) return initialWatchState(now)
  try {
    return { ...initialWatchState(now), ...JSON.parse(readFileSync(path, 'utf8')) }
  } catch {
    // 损坏：改名留证，按初始状态重建（断点重建 = 从现在读起，对账重做基线），调用方私信一句
    try { renameSync(path, `${path}.corrupt-${now}`) } catch {}
    return { ...initialWatchState(now), recoveredFromCorrupt: true }
  }
}

export const saveWatchState = (state, { path = watchStatePath() } = {}) => writeJsonAtomic(path, state)
