/**
 * 项目号 ↔ 项目群 chat_id 绑定表（aven 2026-11-01）。
 *
 * 旧口径「发送时按项目号去 bot 所在群里找群名带这个项目号的群」会出问题：群名会改、会不规范，
 * 改名后就投错群 / 找不到群。现在改成：bot 被拉进群时（chat-list 里第一次出现这个群）就把 chat_id 与项目号绑定、
 * 持久化；项目换新群（又被拉进一个同项目号的群）同步改绑；之后回群 / 群操作一律按存下的 chat_id 定位。
 * 群名只在第一次绑定时当线索，绑定后改名不影响。负责人也可以手动绑定 / 改绑 / 解绑（见 parseProjectChatDirective）。
 *
 * 文件：runtime/lark-project-chats.json（gitignore 下的 runtime/）。只有 gateway 写；worker / poller 只读。
 */
import { existsSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

import { writeJsonAtomic } from './lark-fs.mjs'
import { larkRuntimeDir } from './lark-paths.mjs'
import { isProjectId, matchProjectIds } from './lark-project-id.mjs'

export const projectChatsPath = () => join(process.env.LARK_RUNTIME_DIR || larkRuntimeDir, 'lark-project-chats.json')

export const emptyProjectChats = () => ({ version: 1, baselineAt: null, projects: {}, knownChats: {} })

export const loadProjectChats = ({ path = projectChatsPath() } = {}) => {
  if (!existsSync(path)) return emptyProjectChats()
  try {
    const state = JSON.parse(readFileSync(path, 'utf8'))
    return { ...emptyProjectChats(), ...state, projects: state.projects || {}, knownChats: state.knownChats || {} }
  } catch {
    // 损坏不静默清零：改名留证，按空表重建（下次同步会重新做基线、私信负责人）
    try { renameSync(path, `${path}.corrupt-${Date.now()}`) } catch {}
    return emptyProjectChats()
  }
}

export const saveProjectChats = (state, { path = projectChatsPath() } = {}) => writeJsonAtomic(path, state)

export const normalizeProject = (raw) => {
  const value = String(raw || '').trim().toUpperCase()
  return isProjectId(value) ? value : ''
}

export const projectChatFor = (state, project) => state?.projects?.[normalizeProject(project)]?.chatId || ''

export const projectForChat = (state, chatId) => {
  if (!chatId) return ''
  for (const [project, binding] of Object.entries(state?.projects || {})) {
    if (binding.chatId === chatId) return project
  }
  return ''
}

// 群名里恰好一个项目号才算线索；没有或多个（跨项目群）都不自动绑。
const projectFromName = (name) => {
  const ids = [...new Set(matchProjectIds(name).map((id) => id.toUpperCase()))]
  return ids.length === 1 ? ids[0] : ''
}

/**
 * 纯函数：拿 bot 当前所在群（chatId → 群名）同步绑定表。返回 { state, events }，调用方负责落盘与私信。
 *   · 第一次（没有 baselineAt）：现有群里群名能唯一对上项目号、且该项目只有这一个群的，直接绑定（迁移旧口径）；
 *     同一项目号出现在多个群的不绑，记 ambiguous 让负责人手动绑。所有现有群记为已知。
 *   · 之后：新出现的群 = bot 刚被拉进去。群名能对上项目号 → 绑定（该项目已绑别的群 = 换新群，改绑）；
 *     对不上 → unmatched，请负责人手动绑。
 *   · 已绑定的群不在列表里了（bot 被移出 / 群解散）→ left（只提醒一次，不自动解绑）。
 *   · 群改名只更新显示用的 chatName，不动绑定。
 */
export const syncProjectChats = ({ state = emptyProjectChats(), chats, now = Date.now() }) => {
  const next = { ...state, projects: { ...state.projects }, knownChats: { ...state.knownChats } }
  const events = []
  const at = new Date(now).toISOString()
  const entries = [...chats.entries()]

  if (!next.baselineAt) {
    const byProject = new Map()
    for (const [chatId, name] of entries) {
      next.knownChats[chatId] = { name, firstSeenAt: at }
      const project = projectFromName(name)
      if (project) byProject.set(project, [...(byProject.get(project) || []), [chatId, name]])
    }
    for (const [project, list] of byProject) {
      if (next.projects[project]) continue
      if (list.length === 1) {
        const [[chatId, name]] = list
        next.projects[project] = { chatId, chatName: name, boundAt: at, source: 'baseline' }
        events.push({ type: 'bound', project, chatId, chatName: name, source: 'baseline' })
      } else {
        events.push({ type: 'ambiguous', project, chats: list.map(([chatId, chatName]) => ({ chatId, chatName })) })
      }
    }
    next.baselineAt = at
    return { state: next, events }
  }

  const present = new Set(entries.map(([chatId]) => chatId))
  for (const [chatId, name] of entries) {
    const known = next.knownChats[chatId]
    if (known) {
      if (known.name !== name || known.leftAt) next.knownChats[chatId] = { ...known, name, leftAt: undefined }
      const project = projectForChat(next, chatId)
      if (project && next.projects[project].chatName !== name) next.projects[project] = { ...next.projects[project], chatName: name }
      continue
    }
    next.knownChats[chatId] = { name, firstSeenAt: at }
    const project = projectFromName(name)
    if (!project) {
      events.push({ type: 'unmatched', chatId, chatName: name })
      continue
    }
    const prev = next.projects[project]
    next.projects[project] = { chatId, chatName: name, boundAt: at, source: 'joined' }
    events.push(prev && prev.chatId !== chatId
      ? { type: 'rebound', project, chatId, chatName: name, prevChatId: prev.chatId, prevChatName: prev.chatName || '' }
      : { type: 'bound', project, chatId, chatName: name, source: 'joined' })
  }
  for (const [project, binding] of Object.entries(next.projects)) {
    const known = next.knownChats[binding.chatId]
    if (present.has(binding.chatId) || known?.leftAt) continue
    next.knownChats[binding.chatId] = { ...(known || { name: binding.chatName || '' }), leftAt: at }
    events.push({ type: 'left', project, chatId: binding.chatId, chatName: binding.chatName || '' })
  }
  return { state: next, events }
}

export const bindProjectChat = (state, { project, chatId, chatName = '', now = Date.now() }) => {
  const key = normalizeProject(project)
  const prev = state.projects?.[key] || null
  const next = { ...state, projects: { ...state.projects, [key]: { chatId, chatName, boundAt: new Date(now).toISOString(), source: 'manual' } } }
  return { state: next, prev }
}

export const unbindProjectChat = (state, project) => {
  const key = normalizeProject(project)
  const prev = state.projects?.[key] || null
  const projects = { ...state.projects }
  delete projects[key]
  return { state: { ...state, projects }, prev }
}

/**
 * 负责人的绑定指令（私聊 bot 或在群里 @bot）：
 *   「绑定 PR-02233」（在群里：绑当前群）／「绑定 PR-02233 oc_xxx」／「PR-02233 群是 oc_xxx」→ bind
 *   「解绑 PR-02233」→ unbind
 *   「项目群」／「项目群列表」→ list
 * 不是这几种返回 null（放行给原有流程）。
 */
export const parseProjectChatDirective = (text) => {
  const input = String(text || '').trim()
  if (/^项目群(?:列表|绑定)?$/.test(input)) return { action: 'list' }
  let match = input.match(/^(?:解绑|取消绑定)\s*[:：]?\s*((?:PR|PM|TR)-\d{3,})\s*$/i)
  if (match) return { action: 'unbind', project: match[1].toUpperCase() }
  match = input.match(/^(?:绑定|绑)\s*(?:项目群)?\s*[:：]?\s*((?:PR|PM|TR)-\d{3,})(?:\s*(?:到|=|群是|的群是)?\s*(oc_[a-z0-9]+))?\s*$/i)
  if (match) return { action: 'bind', project: match[1].toUpperCase(), chatId: match[2] || '' }
  match = input.match(/^((?:PR|PM|TR)-\d{3,})\s*(?:的)?(?:项目)?群(?:是|为|=)\s*(oc_[a-z0-9]+)\s*$/i)
  if (match) return { action: 'bind', project: match[1].toUpperCase(), chatId: match[2] }
  return null
}

// 群消息 / 私信是给人看的（aven 11-01）：一项一行、段落之间空一行；群 id 只在要照着回指令时才写。
const chatName = (name) => `「${name || '(无群名)'}」`
const chatWithId = (name, chatId) => `${chatName(name)}（${chatId}）`

// 同步事件 → 私信负责人的一段话（events 为空返回 ''）。
export const formatProjectChatEvents = (events) => {
  if (!events.length) return ''
  const blocks = []
  const baseline = events.filter((e) => e.type === 'bound' && e.source === 'baseline')
  if (baseline.length) {
    blocks.push([`项目群绑定表已建立，之后回群一律按群 id，群改名不影响：`, ...baseline.map((e) => `- ${e.project} → ${chatName(e.chatName)}`)].join('\n'))
  }
  for (const e of events) {
    if (e.type === 'bound' && e.source !== 'baseline') blocks.push(`bot 被拉进新群 ${chatName(e.chatName)}，按群名绑定到 ${e.project}。\n不对就回「解绑 ${e.project}」，或在正确的群里 @我「绑定 ${e.project}」。`)
    if (e.type === 'rebound') blocks.push(`${e.project} 换了新群，已改绑：\n- 原来：${chatWithId(e.prevChatName, e.prevChatId)}\n- 现在：${chatName(e.chatName)}\n不对就回「绑定 ${e.project} ${e.prevChatId}」改回。`)
    if (e.type === 'ambiguous') blocks.push([`${e.project} 对上了 ${e.chats.length} 个群，没有自动绑定：`, ...e.chats.map((c) => `- ${chatWithId(c.chatName, c.chatId)}`), `在要用的那个群里 @我「绑定 ${e.project}」。`].join('\n'))
    if (e.type === 'unmatched') blocks.push(`bot 被拉进新群 ${chatName(e.chatName)}，群名里看不出项目号。\n是项目群的话，在群里 @我「绑定 PR-xxxxx」。`)
    if (e.type === 'left') blocks.push(`bot 已不在 ${e.project} 的绑定群 ${chatName(e.chatName)} 里，${e.project} 的结果先私聊发你。\n换了群就在新群 @我「绑定 ${e.project}」。`)
  }
  return blocks.join('\n\n')
}

export const formatProjectChatList = (state) => {
  const rows = Object.entries(state.projects || {}).sort(([a], [b]) => a.localeCompare(b))
  if (!rows.length) return '还没有绑定任何项目群。在项目群里 @我「绑定 PR-xxxxx」即可。'
  return `项目群绑定（${rows.length} 个）：\n${rows.map(([project, b]) => `- ${project} → ${chatName(b.chatName)}（${b.source === 'manual' ? '手动' : b.source === 'baseline' ? '初始' : '入群'}绑定）`).join('\n')}`
}
