/**
 * 对接文档机械存档（不靠 AI 记得做）：task.attachments 里的文档类文件 → worktree 的仓库约定目录，
 * 文件名去掉下载时加的 "N-" 前缀；AI 之后只做判断与接入。从 lark-task-runner 拆出（体量预算）。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const DOC_FILE_RE = /\.(?:md|markdown|pdf|docx?|txt|json|ya?ml|xlsx?|csv)$/i
// 对方的答复原文（文件名带「回复 / 答复 / reply」）按仓库约定进答复目录（docReplyDir），不进收件目录（教训 #43）。
const REPLY_NAME_RE = /回复|答复|reply/i

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
