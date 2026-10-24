/**
 * `lark-bot self-fix list | apply <id> | discard <id>`（自修工单的人工出口，aven 2026-10-24）。
 * apply：在运行目录（LARK_BOT_ROOT）把工单分支 merge 进当前分支——工作区有未提交改动就拒绝；有冲突就 abort、
 * 运行目录保持原样；合进后删工单 worktree 与分支（提交已在运行分支里）。合进运行目录 = 磁盘代码变了，
 * 排空重启开着时几分钟内自动上线。discard：删 worktree 与分支，工单置 discarded。
 */

import { spawnSync } from 'node:child_process'

import { larkBotRoot } from './lark-paths.mjs'
import { isTicketId, listTickets, readTicket, selfFixDir, selfFixWorktreePath, updateTicket } from './lark-self-fix.mjs'
import { SELF_FIX_STATUS_LABELS, removeSelfFixWorktree } from './lark-self-fix-run.mjs'

const git = (cwd, args) => spawnSync('git', ['-C', cwd, '-c', 'core.quotepath=off', ...args], { encoding: 'utf8' })
const lines = (text) => String(text || '').split('\n').map((line) => line.trim()).filter(Boolean)

export const formatTicketList = (tickets) => {
  if (!tickets.length) return '没有自修工单'
  return tickets
    .map((ticket) => {
      const head = `${ticket.id}  ${SELF_FIX_STATUS_LABELS[ticket.status] || ticket.status}  ${ticket.createdAt?.slice(0, 16) || '--'}  ${ticket.fingerprint?.label}（${ticket.fingerprint?.fingerprint}）`
      const detail = ticket.status === 'ready' ? `分支 ${ticket.branch}，执行 lark-bot self-fix apply ${ticket.id}` : ticket.reason
      return detail ? `${head}\n    ${String(detail).slice(0, 160)}` : head
    })
    .join('\n')
}

const loadTicket = (dir, id) => {
  if (!isTicketId(id)) return { error: `工单 id 不对：${id || '(空)'}（lark-bot self-fix list 看）` }
  const ticket = readTicket({ dir, id })
  return ticket ? { ticket } : { error: `没有工单 ${id}` }
}

export const applySelfFix = ({ dir = selfFixDir, root = larkBotRoot, id, now = Date.now() }) => {
  const { ticket, error } = loadTicket(dir, id)
  if (error) return { ok: false, message: error }
  if (ticket.status !== 'ready') return { ok: false, message: `工单 ${id} 是「${SELF_FIX_STATUS_LABELS[ticket.status] || ticket.status}」，只有验收通过的能 apply` }
  const dirty = lines(git(root, ['status', '--porcelain', '--untracked-files=no']).stdout)
  if (dirty.length) return { ok: false, message: `运行目录 ${root} 有未提交改动，先处理干净再 apply：\n  ${dirty.slice(0, 10).join('\n  ')}` }
  const target = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim()
  const merge = git(root, ['merge', '--no-ff', '--no-edit', '-m', `merge: 自修工单 ${id}（lark-bot self-fix apply）`, ticket.branch])
  if (merge.status !== 0) {
    const conflicts = lines(git(root, ['diff', '--name-only', '--diff-filter=U']).stdout)
    git(root, ['merge', '--abort'])
    const detail = conflicts.length ? `冲突文件：${conflicts.join('、')}` : lines(`${merge.stderr}\n${merge.stdout}`).slice(0, 3).join(' ')
    return { ok: false, message: `合并失败，已 abort，运行目录保持原样。${detail}\n工单仍是 ready：可在 ${selfFixWorktreePath({ root, id })} 里 rebase 到 ${target} 后再 apply，或 discard` }
  }
  const head = git(root, ['rev-parse', 'HEAD']).stdout.trim()
  removeSelfFixWorktree({ root, path: selfFixWorktreePath({ root, id }) })
  git(root, ['branch', '-d', ticket.branch])
  updateTicket({ dir, id, patch: { status: 'applied', mergedAs: head, mergedInto: target }, note: `合进 ${target}`, now })
  return { ok: true, message: `已把 ${ticket.branch} 合进 ${target}（${head.slice(0, 8)}），工单 worktree 已删。排空重启开着时，worker 在飞任务跑完、自检绿会自动 restart 上线；没开就手动 lark-bot restart。` }
}

export const discardSelfFix = ({ dir = selfFixDir, root = larkBotRoot, id, now = Date.now() }) => {
  const { ticket, error } = loadTicket(dir, id)
  if (error) return { ok: false, message: error }
  if (['running', 'applied', 'discarded'].includes(ticket.status)) {
    return { ok: false, message: `工单 ${id} 是「${SELF_FIX_STATUS_LABELS[ticket.status]}」，不能 discard` }
  }
  removeSelfFixWorktree({ root, path: selfFixWorktreePath({ root, id }), branch: ticket.branch })
  updateTicket({ dir, id, patch: { status: 'discarded' }, note: '人工 discard', now })
  return { ok: true, message: `工单 ${id} 已丢弃，worktree 与分支 ${ticket.branch} 已删` }
}

// 命令行入口（scripts/lark-self-fix.mjs 调）：返回 { code, out }，不直接 process.exit，便于直测。
export const runSelfFixCli = (argv, { dir = selfFixDir, root = larkBotRoot } = {}) => {
  const [command, id] = argv
  if (command === 'list') return { code: 0, out: formatTicketList(listTickets({ dir })) }
  if (command === 'apply' || command === 'discard') {
    const outcome = (command === 'apply' ? applySelfFix : discardSelfFix)({ dir, root, id })
    return { code: outcome.ok ? 0 : 1, out: outcome.message }
  }
  return { code: 1, out: 'usage: lark-bot self-fix {list|apply <id>|discard <id>}' }
}
