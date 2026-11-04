/**
 * Claude 记忆「当时的样子」（11-04 校准查出的模拟偏差）：run-sim-falive 原来只拷窗口起点之前改过的记忆文件，之后改过的整篇不带——
 * 可文件当时是在的（只是内容后来又改了），falive 当时的会话读得到、模拟里读不到（ep-1024 C1：当时先读 bug-sheet-workflow.md 才知道去哪查 Bug-4942，
 * 模拟里没这篇，直接报「拿不到 bug 内容」卡住）。
 * 记忆没有版本库，但 Claude Code 的会话记录（~/.claude/projects/<目录>/<会话>.jsonl）里每次 Write / Edit / Read 都带着 toolUseResult：
 *   Write → content（写进去的全文）；Edit → originalFile + oldString / newString（改前全文和替换）；Read（整篇读）→ file.content。
 * 按时间重放到窗口起点就是当时的全文。中间有 Bash 改过（python / sed -i / 重定向 …）的，到下一次 Write / 整篇 Read 之前都算「不知道」，不猜。
 * 纯函数 replayMemoryEvents 可单测；IO 在 loadMemoryEvents（扫会话记录，按记忆目录过滤）。
 */
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

const WRITEY_BASH = /\b(?:python3?|node|perl|ruby)\b|sed\s+-i|\btee\b|\bmv\s|\bcp\s|\brm\s|(?:^|[^0-9&])>{1,2}\s*\S/

const applyEdit = (original, { oldString, newString, replaceAll }) => {
  if (typeof original !== 'string' || typeof oldString !== 'string' || !original.includes(oldString)) return null
  return replaceAll ? original.split(oldString).join(newString ?? '') : original.replace(oldString, () => newString ?? '')
}

/**
 * events: [{ atMs, kind: 'write' | 'edit' | 'read' | 'bash', content?, originalFile?, oldString?, newString?, replaceAll? }]（同一个文件）
 * 返回窗口起点 atMs 时这篇的状态：{ known: true, content } / { known: false, reason }（没出现过 / 之前被 Bash 改过 / Edit 对不上）。
 */
export const replayMemoryEvents = (events, atMs) => {
  let state = { known: false, reason: '窗口前会话记录里没出现过这篇' }
  for (const e of [...events].filter((x) => x.atMs < atMs).sort((a, b) => a.atMs - b.atMs)) {
    if (e.kind === 'write' || e.kind === 'read') state = typeof e.content === 'string' ? { known: true, content: e.content } : state
    else if (e.kind === 'edit') {
      const base = typeof e.originalFile === 'string' ? e.originalFile : state.known ? state.content : null
      const next = applyEdit(base, e)
      state = next == null ? { known: false, reason: 'Edit 对不上改前内容' } : { known: true, content: next }
    } else if (e.kind === 'bash') state = { known: false, reason: '窗口前被 Bash 改过，之后没有整篇读写' }
  }
  return state
}

/** 扫会话记录里落在 memoryDir 下的 Write / Edit / 整篇 Read，以及可能改了它的 Bash；返回 Map<文件名, events[]>。 */
export const loadMemoryEvents = ({ memoryDir, projectsDir = join(homedir(), '.claude', 'projects') }) => {
  const out = new Map()
  const push = (file, e) => { if (!out.has(file)) out.set(file, []); out.get(file).push(e) }
  if (!existsSync(projectsDir) || !existsSync(memoryDir)) return out
  // falive 的临时 worktree 会话把项目记忆软链到主仓 memory（「项目记忆已软链到主仓 memory」）：那些会话里的路径是 <worktree 项目>/memory/…，同一批文件
  const real = realpathSync(memoryDir)
  const tags = [memoryDir.replace(/\/+$/, '')]
  for (const project of readdirSync(projectsDir)) {
    const link = join(projectsDir, project, 'memory')
    try { if (lstatSync(link).isSymbolicLink() && realpathSync(link) === real) tags.push(link) } catch { /* 没有 / 断链 */ }
  }
  const tagOf = (s) => tags.find((t) => s.includes(t)) || null
  for (const project of readdirSync(projectsDir)) {
    const pdir = join(projectsDir, project)
    let files = []
    try { files = readdirSync(pdir).filter((f) => f.endsWith('.jsonl')) } catch { continue }
    for (const f of files) {
      let text
      try { text = readFileSync(join(pdir, f), 'utf8') } catch { continue }
      if (!tagOf(text)) continue
      for (const line of text.split('\n')) {
        const dirTag = tagOf(line)
        if (!dirTag) continue
        let x
        try { x = JSON.parse(line) } catch { continue }
        const atMs = Date.parse(x.timestamp || '')
        if (!Number.isFinite(atMs)) continue
        const r = x.toolUseResult
        if (r && typeof r === 'object') {
          const path = r.filePath || r.file?.filePath
          if (typeof path === 'string' && path.startsWith(`${dirTag}/`) && path.endsWith('.md')) {
            const name = basename(path)
            if (typeof r.oldString === 'string') push(name, { atMs, kind: 'edit', originalFile: typeof r.originalFile === 'string' ? r.originalFile : null, oldString: r.oldString, newString: r.newString, replaceAll: Boolean(r.replaceAll) })
            else if (typeof r.content === 'string' && (r.type === 'create' || r.type === 'update')) push(name, { atMs, kind: 'write', content: r.content })
            else if (r.file && typeof r.file.content === 'string' && (r.file.startLine ?? 1) === 1 && (r.file.numLines == null || r.file.totalLines == null || r.file.numLines >= r.file.totalLines)) push(name, { atMs, kind: 'read', content: r.file.content })
          }
        }
        if (x.type === 'assistant') {
          for (const c of x.message?.content || []) {
            if (c?.type !== 'tool_use' || c.name !== 'Bash') continue
            const cmd = String(c.input?.command || '')
            if (!cmd.includes(dirTag) && !/\/memory\b/.test(cmd)) continue
            if (!WRITEY_BASH.test(cmd)) continue
            for (const name of new Set(cmd.match(/[\w.-]+\.md/g) || [])) push(name, { atMs, kind: 'bash', cmd })
          }
        }
      }
    }
  }
  return out
}

/**
 * 按段落里写的日期近似「当时的样子」（会话记录重放不出来时用；lark-bot 回放给固定知识用，11-04）：段落（空行分隔）里出现的
 * 「MM-DD」/「YYYY-MM-DD」取最晚的那个，晚于窗口起点那天的整段去掉；没写日期的段落保留。年份没写的按 year 补。纯函数。
 */
export const keepParagraphsAsOf = (text, atMs, { year = new Date(atMs).getUTCFullYear() } = {}) => {
  const day = new Date(atMs).toISOString().slice(0, 10)
  return String(text || '').split(/\n\s*\n/).filter((para) => {
    const dates = [...para.matchAll(/(?<![\d.])(?:(\d{4})-)?(1[0-2]|0?[1-9])-(3[01]|[12]\d|0[1-9])(?![\d])/g)]
      .map(([, y, m, d]) => `${y || year}-${m.padStart(2, '0')}-${d}`)
    return !dates.length || dates.sort().at(-1) <= day
  }).join('\n\n')
}
