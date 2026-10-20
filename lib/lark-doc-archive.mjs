/**
 * 对接文档机械存档（不靠 AI 记得做）：task.attachments 里的文档类文件 → worktree 的仓库约定目录，
 * 文件名去掉下载时加的 "N-" 前缀；AI 之后只做判断与接入。从 lark-task-runner 拆出（体量预算）。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { gitAt } from './lark-worker-git.mjs'

const DOC_FILE_RE = /\.(?:md|markdown|pdf|docx?|txt|json|ya?ml|xlsx?|csv)$/i
// 对方的答复原文（文件名带「回复 / 答复 / reply」）按仓库约定进答复目录（docReplyDir），不进收件目录（教训 #43）。
const REPLY_NAME_RE = /回复|答复|reply/i

/**
 * 文档落点目录（收件 + 答复）：范围契约豁免与存档共用这一份，别处不再各写一遍（aven 2026-10-20 review C8：
 * 范围契约原来只豁免 docIntakeDir，答复目录里的 pdf / docx 被当成越界）。
 */
export const docArchiveDirs = (profile) =>
  [...new Set([profile?.docIntakeDir, profile?.docReplyDir].filter(Boolean).map((dir) => String(dir).replace(/^\.\//, '').replace(/\/+$/, '')).filter(Boolean))]

/** 文档该存到哪个目录：答复进 docReplyDir（缺省回落收件目录），其余进 docIntakeDir。 */
export const archiveDirFor = ({ name, profile }) =>
  REPLY_NAME_RE.test(name) && profile?.docReplyDir ? profile.docReplyDir : profile?.docIntakeDir

/**
 * 返回存档的相对路径列表（`#same` = 与仓里逐字节相同；`#kept` = 仓里已有不同版本，没覆盖）。失败只记日志不抛。
 * 仓里已有同名但内容不同的文件不覆盖：群里转发的常是旧版（教训 #43：Ache 附件带回 S1 结清前的待办，覆盖了仓里新版），
 * 新旧取舍交给 AI（附件原件仍在 item.localPath）。
 */
export const archiveDocAttachments = ({ task, cwd, profile }) => {
  if (!profile?.docIntakeDir || !cwd) return []
  const out = []
  for (const item of task.attachments || []) {
    if (!item || item.type !== 'file' || !item.localPath || !DOC_FILE_RE.test(String(item.fileName || ''))) continue
    const name = String(item.fileName || basename(item.localPath)).replace(/^\d+-/, '').replace(/[\\/:*?"<>|]/g, '_')
    const dirRel = archiveDirFor({ name, profile })
    try {
      const target = join(cwd, dirRel, name)
      mkdirSync(dirname(target), { recursive: true })
      if (existsSync(target)) {
        const same = readFileSync(target).equals(readFileSync(item.localPath))
        out.push(`${join(dirRel, name)}${same ? '#same' : '#kept'}`)
        continue
      }
      copyFileSync(item.localPath, target)
      out.push(join(dirRel, name))
    } catch (error) {
      console.warn(`[lark-worker] ${task.id} 存档 ${item.fileName} 失败：${String(error?.message || error).slice(0, 120)}`)
    }
  }
  return out
}

// ---------- 存档之后（aven 2026-10-20 review C5 / C9） ----------
const MARK_RE = /#(same|kept)$/
export const parseArchivedEntry = (entry) => {
  const value = String(entry || '')
  const mark = value.match(MARK_RE)?.[1] || null
  return { path: mark ? value.slice(0, -(mark.length + 1)) : value, mark }
}

// 存档清单里实际有改动的路径（git 实测，含新增未跟踪）；git 读不到返回 null。
export const changedDocPaths = ({ cwd, paths = [], git = gitAt }) => {
  if (!paths.length) return []
  const res = git(cwd, ['status', '--porcelain', '--untracked-files=all', '--', ...paths])
  if (res.status !== 0) return null
  return (res.stdout || '').split('\n').filter((line) => line.trim()).map((line) => line.slice(3).trim().split(' -> ').pop())
}

/**
 * 存档清单 → 入库计划：commit 只含真有改动的文件（#kept 永不进提交；#same 只有被改过才算）；same / kept 给文案用。
 * changedPaths 为 null（git 读不到）时退回「本次新拷进去的文件」。
 */
export const planDocIntakeCommit = ({ archived = [], changedPaths = null }) => {
  const entries = archived.map(parseArchivedEntry)
  const pick = (mark) => entries.filter((item) => item.mark === mark).map((item) => item.path)
  const candidates = entries.filter((item) => item.mark !== 'kept')
  const commit = Array.isArray(changedPaths)
    ? candidates.map((item) => item.path).filter((path) => changedPaths.includes(path))
    : candidates.filter((item) => !item.mark).map((item) => item.path)
  return { commit, same: pick('same'), kept: pick('kept') }
}

/**
 * #kept 的文件（仓里已有不同版本、worker 故意没覆盖）若被 AI 改了，提交前恢复成 HEAD 版本：覆盖规则只认存档这一处。
 * 只在临时 worktree（auto 全量提交）里调用；HEAD 里没有的文件不动。返回恢复了的路径。
 */
export const restoreKeptDocs = ({ cwd, archived = [], git = gitAt }) => {
  const restored = []
  for (const { path, mark } of archived.map(parseArchivedEntry)) {
    if (mark !== 'kept') continue
    if (git(cwd, ['cat-file', '-e', `HEAD:${path}`]).status !== 0) continue
    if (git(cwd, ['diff', '--quiet', 'HEAD', '--', path]).status === 0) continue
    if (git(cwd, ['checkout', 'HEAD', '--', path]).status === 0) restored.push(path)
  }
  return restored
}

/** 文档入库收尾的私聊文案：没有真实改动时说「无需提交」，不再出现「文档已存进仓库（）」空括号。 */
export const buildDocIntakeText = ({ commit = [], same = [], kept = [], owners = [], mine = false, summary = '', blockers = [] }) => {
  const names = (list) => list.map((path) => basename(path)).join('、')
  const notes = [
    same.length ? `${names(same)} 和仓里已有版本逐字节相同` : null,
    kept.length ? `${names(kept)} 仓里已有不同版本，没覆盖` : null,
  ].filter(Boolean)
  const head = commit.length
    ? `文档已存进仓库（${commit.join('、')}）${notes.length ? `；${notes.join('；')}` : ''}。`
    : `文档无需提交${notes.length ? `：${notes.join('；')}` : ''}。`
  const who = owners.length ? `内容归 ${owners.join('、')} 负责，不归我，没接、没回群。` : mine ? '是我负责的部分，这次没开工。' : ''
  return `${head}${who}\n${String(summary || '').trim()}${blockers.length ? `\n还缺：${blockers.join('；')}` : ''}`
}
