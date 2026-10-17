/**
 * 只读 git（异步 execFile）：gateway 里取分支上的文件内容用。以前 lark-repo-delivery / lark-group-reply 各有一份
 * spawnSync 版 materializeDoc，会把整个 gateway 事件循环卡住（第 1 批：gateway 内禁 spawnSync）。
 */

import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

export const gitShowFile = ({ root, ref, path, timeoutMs = 15_000 }) =>
  new Promise((resolve) => {
    if (!root || !ref || !path) return resolve(null)
    execFile('git', ['-C', root, '-c', 'core.quotepath=off', 'show', `${ref}:${path}`], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) =>
      resolve(error ? null : stdout))
  })

// 从分支里取出文件落到临时目录（worktree 已回收，文件只在提交里）。取不到返回 null；调用方用完删 dir。
export const materializeDoc = async ({ root, branch, path }) => {
  const content = await gitShowFile({ root, ref: branch, path })
  if (content == null) return null
  const dir = mkdtempSync(join(tmpdir(), 'lark-followup-'))
  const file = basename(path)
  writeFileSync(join(dir, file), content)
  return { dir, file }
}
