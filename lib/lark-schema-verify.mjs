/**
 * 接口实测闸的触发判定（整改 #6 → 教训 #66）。
 * 原来按文件名触发：改到 `/data/(schema|queries).ts` 就要求本轮在 pre 实测通过。10-22 新闻详情页只是删了三个响应字段
 * （schema 删字段、mapper 不再映射、页面不显示），请求一个字没动，也被挂成「接口改动没在 pre 实测通过」、改动没提交。
 * 现在只看工作区真实 diff（`git diff -U0 HEAD`），不看文件名、不读模型散文：
 * - 请求侧（queries 等 schemaFiles 里非 schema 的文件）：任何代码行增删都算（路径 / 方法 / 参数 / 请求体 / 签名 / queryFn 换接口）；
 * - 响应 schema（schema.ts）：只有新增 / 改动的代码行算（加字段、改类型可能与真实响应对不上）；只删字段不算——
 *   z.object 默认丢弃未声明的键，删字段不会让解析失败（本仓没有 .strict()），也不改请求；
 * - 注释 / 空行、只是挪位置或补逗号的行不算；改了范围内的文件却读不到它的 diff → 按改了算（fail-closed）。
 */
import { schemaVerifyVerdict } from './lark-completion-rule.mjs'

const RESPONSE_SCHEMA_RE = /(^|\/)schema\.ts$/
const COMMENT_RE = /^(\/\/|\/\*|\*)/

// git 路径：core.quotepath 没关时中文路径会被引号 + 八进制转义（"b/docs/\346\226\260…"），这里还原；/dev/null → null。
export const decodeGitPath = (raw) => {
  let path = String(raw || '').replace(/\t.*$/, '').trim()
  if (path.startsWith('"') && path.endsWith('"')) {
    const bytes = []
    const body = path.slice(1, -1)
    for (let i = 0; i < body.length; i += 1) {
      if (body[i] !== '\\') { bytes.push(...Buffer.from(body[i])); continue }
      const octal = /^[0-7]{3}/.exec(body.slice(i + 1))
      if (octal) { bytes.push(parseInt(octal[0], 8)); i += 3; continue }
      const next = body[(i += 1)]
      bytes.push(...Buffer.from({ n: '\n', t: '\t' }[next] ?? next))
    }
    path = Buffer.from(bytes).toString('utf8')
  }
  if (path === '/dev/null') return null
  return path.replace(/^[ab]\//, '')
}

// 统一 diff → [{ path, added, removed }]；文件头只在第一个 @@ 之前认，正文里以 +++ / --- 开头的行不会被当成文件头。
export const parseUnifiedDiff = (text) => {
  const files = []
  let current = null
  let inHunk = false
  for (const line of String(text || '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = { path: '', added: [], removed: [] }
      files.push(current)
      inHunk = false
    } else if (!current) {
      continue
    } else if (!inHunk && (line.startsWith('+++ ') || line.startsWith('--- '))) {
      const path = decodeGitPath(line.slice(4))
      if (path) current.path = path
    } else if (line.startsWith('@@')) {
      inHunk = true
    } else if (inHunk && line.startsWith('+')) {
      current.added.push(line.slice(1))
    } else if (inHunk && line.startsWith('-')) {
      current.removed.push(line.slice(1))
    }
  }
  return files.filter((file) => file.path)
}

const normalizeLine = (line) => line.trim().replace(/[,;]+$/, '').replace(/\s+/g, ' ')
const isCodeLine = (line) => Boolean(line) && !COMMENT_RE.test(line)
// 一侧有、另一侧没有的代码行（挪位置 / 补逗号 / 改缩进两侧都有，不算）。
const netCodeLines = (lines, other) => {
  const otherSet = new Set(other.map(normalizeLine))
  return lines.map(normalizeLine).filter((line) => isCodeLine(line) && !otherSet.has(line))
}

/** 范围内（verify.schemaFiles）真正动到对后端契约的改动：[{ path, side: request | response | unknown, line }]。 */
export const interfaceChanges = ({ changedFiles = [], diffText = '', schemaFiles }) => {
  const scoped = new RegExp(schemaFiles)
  const parsed = new Map(parseUnifiedDiff(diffText).map((file) => [file.path, file]))
  return changedFiles.filter((path) => scoped.test(path)).flatMap((path) => {
    const file = parsed.get(path)
    if (!file) return [{ path, side: 'unknown', line: '读不到这个文件的 diff' }]
    const response = RESPONSE_SCHEMA_RE.test(path)
    const lines = response ? netCodeLines(file.added, file.removed) : [...netCodeLines(file.added, file.removed), ...netCodeLines(file.removed, file.added)]
    return lines.length ? [{ path, side: response ? 'response' : 'request', line: lines[0].slice(0, 80) }] : []
  })
}

const SIDE_LABEL = { request: '改了对后端的请求', response: '响应 schema 加 / 改了字段', unknown: '改了接口文件' }
const describeChanges = (changes) => changes.slice(0, 3).map((item) => `${SIDE_LABEL[item.side]}（${item.path}：${item.line}）`).join('；')

/**
 * runner 收尾用：仓库 profile 配了 verify、且 diff 里真有接口改动时，按本轮 preChecks 给结论。
 * 返回 null = 不用实测（没配 verify / 没动接口文件 / 只删响应字段、改注释）；否则 { status, change, note, changes }，
 * status 为 null 表示实测通过、照常交付。readDiff(files) 只在动到范围内文件时才调用。
 */
export const resolveSchemaVerifyGate = ({ verify, changedFiles = [], preChecks = null, taskId = '', readDiff = () => '' }) => {
  if (!verify?.schemaFiles) return null
  const scoped = new RegExp(verify.schemaFiles)
  const files = changedFiles.filter((path) => scoped.test(path))
  if (!files.length) return null
  const changes = interfaceChanges({ changedFiles: files, diffText: readDiff(files), schemaFiles: verify.schemaFiles })
  if (!changes.length) return null
  const { verdict, broken } = schemaVerifyVerdict(preChecks)
  if (verdict === 'ok') return { status: null, change: null, note: null, changes }
  const env = verify.env
  if (verdict === 'broken') {
    const detail = broken.map((item) => `${item.endpoint} → ${String(item?.outcome ?? item?.result ?? '').slice(0, 120)}`).join('；')
    return { status: 'failed', changes, change: { committed: false, gate: 'schema', reason: `schema 与 ${env} 真实响应对不上` }, note: `⛔ schema 与 ${env} 真实响应对不上，未按完成处理：${detail}` }
  }
  // 真改了接口但没测通：如实说清改了什么、为什么没测，改动留在工作区不提交，交负责人决定重跑还是取消。
  const list = Array.isArray(preChecks) ? preChecks : []
  const why = list.length ? `${env} 连不上（${list.length} 条实测都没通）` : `这轮没在 ${env} 实测`
  return {
    status: 'waiting_confirmation',
    changes,
    change: { committed: false, gate: 'schema-unverified', reason: `接口改动没有在 ${env} 实测通过` },
    note: `待补充：${describeChanges(changes)}，${why}，改动留在工作区没提交；${env} 可用后回复「继续任务 ${taskId} 重跑并实测」，不做了回复「取消任务」`,
  }
}
