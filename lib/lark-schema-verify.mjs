/**
 * 接口实测闸的触发判定（整改 #6 → 教训 #66）。
 * 原来按文件名触发：改到 `/data/(schema|queries).ts` 就要求本轮在 pre 实测通过。10-22 新闻详情页只是删了三个响应字段
 * （schema 删字段、mapper 不再映射、页面不显示），请求一个字没动，也被挂成「接口改动没在 pre 实测通过」、改动没提交。
 * 现在只看工作区真实 diff（`git diff -U0 HEAD`），不看文件名、不读模型散文：
 * - 请求侧（queries 等 schemaFiles 里非 schema 的文件）：任何代码行增删都算（路径 / 方法 / 参数 / 请求体 / 签名 / queryFn 换接口）；
 * - 响应 schema（schema.ts）：只有新增 / 改动的代码行算（加字段、改类型可能与真实响应对不上）；只删字段不算——
 *   z.object 默认丢弃未声明的键，删字段不会让解析失败（本仓没有 .strict()），也不改请求；
 * - 注释 / 空行、只是挪位置或补逗号的行不算；改了范围内的文件却读不到它的 diff → 按改了算（fail-closed）。
 * 范围（教训 #68）：文件名命中 verify.schemaFiles，或文件内容（改前 / 改后任一版）命中 verify.requestMarker（引用请求入口，
 * 如 `@/kernel/http`）都算请求侧——mutations.ts / api.ts / feedbacks.ts 这类写在别处的接口不再漏测；纯逻辑工具文件不引用请求入口，不进范围。
 */
import { execAiExecutor } from './lark-ai-executor.mjs'
import { pageToolOf } from './lark-verify-page.mjs'
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

const MARKER_SOURCE_RE = /\.(ts|mts|js|mjs)$/
const TEST_FILE_RE = /\.(test|spec)\.[a-z]+$/

/** 实测范围内的改动文件：文件名命中 schemaFiles，或源码（readSources(path) 给出改前 / 改后各版内容）命中 requestMarker。 */
export const scopedInterfaceFiles = ({ verify, changedFiles = [], readSources = () => [] }) => {
  const byName = verify?.schemaFiles ? new RegExp(verify.schemaFiles) : null
  const marker = verify?.requestMarker ? new RegExp(verify.requestMarker) : null
  return changedFiles.filter((path) => byName?.test(path)
    || Boolean(marker && MARKER_SOURCE_RE.test(path) && !TEST_FILE_RE.test(path) && readSources(path).some((text) => marker.test(text || ''))))
}

/** 真正动到对后端契约的改动：[{ path, side: request | response | unknown, line }]。传 schemaFiles 时先按文件名筛，不传则 changedFiles 视为已筛好的范围。 */
export const interfaceChanges = ({ changedFiles = [], diffText = '', schemaFiles = '' }) => {
  const scoped = schemaFiles ? new RegExp(schemaFiles) : null
  const parsed = new Map(parseUnifiedDiff(diffText).map((file) => [file.path, file]))
  return changedFiles.filter((path) => !scoped || scoped.test(path)).flatMap((path) => {
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
 * 返回 null = 不用实测（没配 verify / 没动接口文件 / 只删响应字段、改注释）；否则 { status, change, note, changes, unverified? }，
 * status 为 null 表示照常交付（unverified=true 时是没测通，runner 先补测一轮，还不通就带 note 交付）。readDiff(files) 只在动到范围内文件时才调用；readSources(path) 返回该文件改前 / 改后的源码（读不到的版本省略）。
 */
export const resolveSchemaVerifyGate = ({ verify, changedFiles = [], preChecks = null, taskId = '', readDiff = () => '', readSources = () => [] }) => {
  if (!verify?.schemaFiles && !verify?.requestMarker) return null
  const files = scopedInterfaceFiles({ verify, changedFiles, readSources })
  if (!files.length) return null
  const changes = interfaceChanges({ changedFiles: files, diffText: readDiff(files) })
  if (!changes.length) return null
  const { verdict, broken } = schemaVerifyVerdict(preChecks)
  if (verdict === 'ok') return { status: null, change: null, note: null, changes }
  const env = verify.env
  if (verdict === 'broken') {
    const detail = broken.map((item) => `${item.endpoint} → ${String(item?.outcome ?? item?.result ?? '').slice(0, 120)}`).join('；')
    return { status: 'failed', changes, change: { committed: false, gate: 'schema', reason: `schema 与 ${env} 真实响应对不上` }, note: `⛔ schema 与 ${env} 真实响应对不上，未按完成处理：${detail}` }
  }
  // 真改了接口但没测通（aven 2026-10-22：没验证不是待确认的理由）：不挂起、不扣改动。runner 先续会话补测一轮
  //（buildVerifyPassPrompt），补完再判；还是没测通（${env} 连不上）就照常提交，结论里如实带一句没测的原因。
  const list = Array.isArray(preChecks) ? preChecks : []
  const why = list.length ? `${env} 连不上（${list.length} 条实测都没通）` : `这轮没在 ${env} 实测`
  return {
    status: null,
    unverified: true,
    changes,
    change: null,
    note: `⚠️ ${describeChanges(changes)}，${why}；代码照常提交，${env} 能连上后实测一次（任务 ${taskId}）`,
  }
}

// 补测一轮的提示（续实施会话，上下文都在）：只测不改；测完按原结果格式整份重写，preChecks 写本轮实测。
export const buildVerifyPassPrompt = ({ verify, changes = [] }) => `你刚完成的改动动了对后端的接口（${describeChanges(changes)}），但结果里没有一条 ${verify.env} 实测通过的记录。验证是你的活，现在补上：
1. 只测不改：不改任何代码 / 文档（改了提交会被拦下）。
2. 接口：用 \`${verify.probeCommand}\` 把这次动到的接口一次测完${verify.schemaCheck ? '，改了响应 schema 的再跑 schema 校验' : ''}；写接口按「环境实测」里的规则用测试号。
3. 页面：动到页面的，用 \`${pageToolOf(verify)} check --cwd <当前工作区> [--login] <页面路径>\` 看动到的那块（会自动起本地服务、查回落 mock / 报错 / 失败请求，并和已部署的同一页比对），标「本地新出现」的要处理。
4. 按原来的结果格式整份重写结果文件：preChecks 写本轮实测（endpoint + 一句结果 + kind），report / summary 按实测结果更新，其余字段照旧。${verify.env} 实在连不上就如实写进 preChecks（kind 填 unreachable），不要反复重试。`

// 结果里自称实测（pre / 浏览器）、但本轮会话里找不到对应调用的条目：补测提示（aven 2026-10-28：没测过的不提交、不算完成）。
export const buildClaimPassPrompt = ({ verify, items = [] }) => `你的结果里这几项写了已实测，但本轮会话里找不到对应的实测调用：${items.map((item) => `「${item.name}」（${item.evidence === 'pre' ? `${verify.env} 接口` : '页面'}）`).join('、')}。没测过的改动不能提交，现在真测一遍：
1. 只测不改：不改任何代码 / 文档（改了提交会被拦下）。
2. 接口用 \`${verify.probeCommand}\`；页面用 \`${pageToolOf(verify)} check --cwd <当前工作区> [--login] [--expect 应出现的文字]… <页面路径>\`。命令里直接写工具路径，不要先赋给变量。
3. 按原来的结果格式整份重写结果文件：report 按实测结果更新（真测过的才写 evidence=pre / browser），preChecks 写本轮接口实测，其余字段照旧。实在测不了就如实写原因，不要标「通了」。`

// 补测后仍自称实测却没跑：改了代码的不提交、按失败交负责人（没测过的不算完成）；只读任务 / 没改文件的照常交付（条目已降成「待验证」）。
// 返回 null = 放行；否则 { status, change, note }。
export const claimGateVerdict = ({ claims = [], readOnly = false, changedFiles = [], taskId }) => {
  if (!claims.length || readOnly || !changedFiles.length) return null
  const reason = `${claims.map((item) => `「${item.name}」`).join('、')}自称实测，补测后会话里仍没有实测调用，改动没提交`
  return { status: 'failed', change: { committed: false, gate: 'unverified-claim', reason }, note: `⚠️ ${reason}（任务 ${taskId}，回「继续任务」重跑）` }
}

// 续实施会话补测一轮（只 claude 有会话可续）：把新的 preChecks / report / summary 并回 aiRun.result，记下补测会话供核实测证据。
// 返回 true = 补测跑完、要重判；false = 没跑（不是 claude / 没会话）或跑挂了（照常交付，带没测通的 note）。exec 供单测注入。
// promptText / why：别的「没测」也走同一个补测（如自称实测但会话里没跑，buildClaimPassPrompt）。
export const runVerifyPass = async ({ task, aiRun, verify, changes, promptText = null, why = '接口改动没测通', exec = execAiExecutor, ...execOptions }) => {
  if (!aiRun?.sessionId || aiRun.executor !== 'claude') return false
  console.warn(`[lark-worker] ${task.id} ${why}，续会话补测一轮`)
  try {
    const pass = await exec({ ...execOptions, executor: aiRun.executor, promptText: promptText || buildVerifyPassPrompt({ verify, changes }), resumeSessionId: aiRun.sessionId })
    if (!pass?.result) return false
    aiRun.result = { ...aiRun.result, preChecks: pass.result.preChecks ?? aiRun.result.preChecks, report: pass.result.report ?? aiRun.result.report, summary: pass.result.summary || aiRun.result.summary }
    aiRun.verifySessionId = pass.sessionId || null
    return true
  } catch (error) {
    console.warn(`[lark-worker] ${task.id} 补测一轮执行异常（照常交付）：${String(error?.message || error).slice(0, 160)}`)
    return false
  }
}
