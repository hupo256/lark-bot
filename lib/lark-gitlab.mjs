/**
 * fameex-web 的 GitLab（mgit.lgroup.co）接口层：建 MR、打 Labels、查能不能合、合并。给「部署 dev / test」用（lib/lark-ship.mjs，aven 11-06）。
 *
 * 令牌：GitLab 个人访问令牌（api 权限），默认 ~/.config/mgit-token（0600，aven 11-06 放的）；config.gitlab.tokenPath 可改。
 * 地址：缺省从业务仓 origin 推（http://mgit.lgroup.co/hqex/web/fameex-web.git → 接口根 http://mgit.lgroup.co/api/v4、项目 hqex/web/fameex-web）；
 * config.gitlab.baseUrl / projectPath 可改。所有网络调用都走注入的 fetchImpl（单测不碰网络）。
 *
 * Labels（aven 11-06 确认）：Label 名 = apps/ 下的目录名（web / web-next / admin / futures-admin / security-admin / cms / business-system），
 * 一个 Label 对应一条 Jenkins 流水线（建置通知里的项目名见 lib/lark-build-notice projectForLabel）。只改了 packages/ 时看需求落在哪个端（关键词见 TEXT_LABEL_HINTS）。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_TOKEN_PATH = join(homedir(), '.config', 'mgit-token')

/** origin 地址 → { apiBase, projectPath }；认不出返回 null。支持 http(s)://host/a/b.git 与 git@host:a/b.git。 */
export const gitlabTargetFromRemote = (remote) => {
  const text = String(remote || '').trim()
  const http = /^(https?):\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(text)
  if (http) return { apiBase: `${http[1]}://${http[2]}/api/v4`, projectPath: http[3] }
  const ssh = /^[^@]+@([^:]+):(.+?)(?:\.git)?$/.exec(text)
  if (ssh) return { apiBase: `http://${ssh[1]}/api/v4`, projectPath: ssh[2] }
  return null
}

/** 解析配置：{ apiBase, projectPath, tokenPath }。缺地址返回 null（调用方报「认不出 GitLab 地址」）。 */
export const resolveGitlabSettings = ({ gitlab = {}, remote = '' } = {}) => {
  const fromRemote = gitlabTargetFromRemote(remote)
  const apiBase = gitlab.baseUrl ? `${String(gitlab.baseUrl).replace(/\/+$/, '')}/api/v4` : fromRemote?.apiBase
  const projectPath = gitlab.projectPath || fromRemote?.projectPath
  if (!apiBase || !projectPath) return null
  return { apiBase, projectPath, tokenPath: gitlab.tokenPath || DEFAULT_TOKEN_PATH }
}

export const readGitlabToken = (tokenPath, read = readFileSync) => {
  try {
    return String(read(tokenPath, 'utf8')).trim() || null
  } catch {
    return null
  }
}

// ── Labels ────────────────────────────────────────────────

const APP_DIR_RE = /^apps\/([^/]+)\//

/** 改动文件 → 按 apps/<目录> 得出的 Labels（只留 GitLab 上真有的）。appDirs 是改到的 app 目录（含没有 Label 的）。 */
export const labelsForPaths = (paths = [], known = []) => {
  const knownSet = new Set(known)
  const appDirs = [...new Set(paths.map((path) => APP_DIR_RE.exec(String(path))?.[1]).filter(Boolean))].sort()
  return { labels: appDirs.filter((dir) => knownSet.has(dir)), appDirs }
}

// 需求落在哪个端的说法（只改 packages/ 时用 PRD / 原话判，aven 11-06：web / web-next / 现货后台 / 合约后台 / 风控后台）。
const TEXT_LABEL_HINTS = [
  ['admin', /现货后台/],
  ['futures-admin', /合约后台/],
  ['security-admin', /风控后台/],
  ['web-next', /新站|web-next/i],
  ['web', /老站|(?<![\w-])apps\/web(?![\w-])/],
]
const escapeRe = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 文字里点名的 Labels：Label 原名（整词）+ 端的中文说法。按 known 过滤、去重、排序。 */
export const labelsFromText = (text = '', known = []) => {
  const input = String(text || '')
  const hits = new Set()
  for (const label of known) {
    if (/^Review effort/i.test(label)) continue
    if (new RegExp(`(?<![\\w-])${escapeRe(label)}(?![\\w-])`, 'i').test(input)) hits.add(label)
  }
  for (const [label, re] of TEXT_LABEL_HINTS) if (re.test(input)) hits.add(label)
  return [...hits].filter((label) => known.includes(label)).sort()
}

// ── MR 状态 ───────────────────────────────────────────────

const CHECKING = new Set(['checking', 'unchecked', 'preparing', 'approvals_syncing', 'cannot_be_merged_recheck'])
/** MR → 'merged' | 'checking' | 'mergeable' | 'conflict' | 'blocked'（blocked 带 reason）。兼容老版本只有 merge_status 的。 */
export const mergeStateOf = (mr) => {
  if (!mr) return { state: 'blocked', reason: '取不到 MR' }
  if (mr.state === 'merged') return { state: 'merged' }
  if (mr.state !== 'opened') return { state: 'blocked', reason: `MR 状态是 ${mr.state}` }
  const detailed = mr.detailed_merge_status || null
  if (mr.has_conflicts || detailed === 'conflict' || detailed === 'need_rebase') return { state: 'conflict' }
  if (detailed ? CHECKING.has(detailed) : CHECKING.has(mr.merge_status)) return { state: 'checking' }
  if (detailed ? detailed === 'mergeable' : mr.merge_status === 'can_be_merged') return { state: 'mergeable' }
  if (!detailed && mr.merge_status === 'cannot_be_merged') return { state: 'conflict' }
  return { state: 'blocked', reason: `GitLab 说不能合（${detailed || mr.merge_status}）` }
}

// ── 接口 ──────────────────────────────────────────────────

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 客户端。fetchImpl / sleep 可注入。每个方法失败抛 Error（消息带 HTTP 码与 GitLab 的 message，不带令牌）。
 */
export const createGitlabClient = ({ apiBase, projectPath, token, fetchImpl = fetch, sleep = sleepMs }) => {
  const project = encodeURIComponent(projectPath)
  const call = async (method, path, body) => {
    const response = await fetchImpl(`${apiBase}/projects/${project}${path}`, {
      method,
      headers: { 'PRIVATE-TOKEN': token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    let data = null
    try {
      data = await response.json()
    } catch {
      data = null
    }
    if (!response.ok) {
      const detail = data?.message ? (typeof data.message === 'string' ? data.message : JSON.stringify(data.message)) : data?.error || ''
      throw new Error(`GitLab ${method} ${path.split('?')[0]} 失败：HTTP ${response.status}${detail ? ` ${String(detail).slice(0, 200)}` : ''}`)
    }
    return data
  }
  const client = {
    listLabels: async () => (await call('GET', '/labels?per_page=100')).map((label) => label.name),
    findOpenMr: async ({ source, target }) =>
      (await call('GET', `/merge_requests?state=opened&source_branch=${encodeURIComponent(source)}&target_branch=${encodeURIComponent(target)}`))[0] || null,
    createMr: ({ source, target, title, labels }) =>
      call('POST', '/merge_requests', { source_branch: source, target_branch: target, title, labels: labels.join(','), remove_source_branch: false }),
    addLabels: ({ iid, labels }) => call('PUT', `/merge_requests/${iid}`, { add_labels: labels.join(',') }),
    getMr: (iid) => call('GET', `/merge_requests/${iid}`),
    closeMr: (iid) => call('PUT', `/merge_requests/${iid}`, { state_event: 'close' }),
    mergeMr: (iid) => call('PUT', `/merge_requests/${iid}/merge`, { should_remove_source_branch: false, squash: false }),
    /** 等 GitLab 算完能不能合（新建 / 刚推的 MR 先是 checking）。返回 { mr, state, reason }。 */
    waitMergeState: async (iid, { tries = 20, intervalMs = 3000 } = {}) => {
      let mr = null
      let verdict = { state: 'checking' }
      for (let attempt = 0; attempt < tries; attempt += 1) {
        mr = await client.getMr(iid)
        verdict = mergeStateOf(mr)
        if (verdict.state !== 'checking') return { mr, ...verdict }
        await sleep(intervalMs)
      }
      return { mr, state: 'blocked', reason: `GitLab ${Math.round((tries * intervalMs) / 1000)} 秒还没算完能不能合` }
    },
  }
  return client
}
