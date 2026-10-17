/**
 * 原子写文件：先写同目录 .tmp 再 rename（同一文件系统上 rename 是原子替换）。
 * 台账 / 轮询游标 / 日报状态以前都是 writeFileSync 整写，进程在写一半被 kill 就留下半截 JSON，
 * 下次读失败又「返回空」→ 台账清零 / 游标重置漏消息。任务文件早就这么写（lark-task-store），这里统一成一个助手。
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const writeFileAtomic = (path, data, { mode = 0o600 } = {}) => {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, data, { mode })
  renameSync(tmp, path)
}

export const writeJsonAtomic = (path, value, { mode = 0o600, trailingNewline = false } = {}) =>
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}${trailingNewline ? '\n' : ''}`, { mode })
