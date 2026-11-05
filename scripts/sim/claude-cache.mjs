#!/usr/bin/env node
/**
 * 回放用 claude 调用录放（docs/replay/falive-replay-design-v2.md §4、§8 P0-f）：run-sim --ai-cache 把 LARK_CLAUDE_BIN 指到 scripts/sim/claude（本文件的 sh 壳），
 * SIM_REAL_CLAUDE 指到额度闸 scripts/sim/claude-q——未命中的真调一律经额度闸（撞限额冻时钟、到点重试、按真实耗时执行原超时）。
 *
 * 录：每次可录的调用按「规范化后的完整输入」算指纹（见下「键」），成功的输出连同副作用（结果文件、会话文件、可写调用对工作区的改动）落盘。
 * 放：同指纹再来一次就原样回放，不花 token、立刻出结果。
 *   只读调用（分类 intent、分诊 triage、分析 analysis、只读单趟任务 task-ro、只读续会话 resume-ro）：输入一样就放。
 *   改代码的调用（task-rw、续会话实施 resume-rw）：还要求业务仓状态完全一致（HEAD 树 + 历史 + 工作区内容树），命中时把录下的改动打回工作区，
 *   打完核对工作区内容树与录时一致，不一致就撤回改动、改真调。
 * 不录：失败（退出码非 0、result 事件缺失 / is_error / 非 success、撞限额、被额度闸按超时杀掉）、该写的结果文件 / 会话文件缺失、
 *   可写调用里 HEAD 动了（提交被命令行硬拦，动了说明出了意外）。
 * 直通（bypass，不录）：版本 / 帮助、不认识的参数、--continue / --fork-session / --session-id、带 mcp / settings / 换系统提示、text 输出、
 *   页面工具实测（会起浏览器、落截图、真打环境，副作用补不出来）、可写调用不在业务仓里、续会话找不到会话文件。
 * 每次调用往 SIM_DIR/ai-cache.log 追加一行（时间 outcome kind key 耗时 原因），往 SIM_DIR/ai-cache-calls.jsonl 追加键的分项指纹（核对工具按分项定位
 * 「为什么没命中」），未命中时把规范化后的 prompt 存进 SIM_DIR/ai-cache-prompts/<key 前 12 位>.txt。
 * 缓存目录：SIM_AI_CACHE_DIR || runtime/falive-replay/ai-cache/<key>/。SIM_AI_CACHE=0 全部直通；SIM_AI_CACHE_HIT_DELAY=orig|<ms> 命中时先等（见命中段）。
 *
 * —— 键 ——（CACHE_VERSION 进键；改了规范化规则就加一，旧条目自然不命中）
 *   argv 全量（含模型、强度、工具面、允许 / 禁用工具、输出格式、schema、系统层），每一项先经规范化；stdin；cwd（规范化）；
 *   prompt / argv 里出现的本地文件的内容 hash；业务仓状态（intent 除外）；续会话时被续会话文件的内容 hash；带规则指纹时自动加载的规则文件 hash。
 * 规范化规则（只换「同一份语义输入在两次运行里写法不同」的部分；消息原文、上下文、附件内容、仓库状态一律留在键里）：
 *   R1 SIM_DIR → <<SIM_DIR>>（原样、realpath 两种写法，及 claude 项目目录编码 → <<SIM_DIR_ENC>>）：每轮 / 每组的运行目录不同；
 *      附件副本、临时 worktree（repos/.lark-hotfix/…）、审计、预取文档都在它下面，内容另按文件 hash 进键。
 *   R2 lark-bot 代码根 → <<LARK_BOT>>：--add-dir、工具路径（tools/*.mjs）、intent 的 cwd 随跑在哪个 worktree 变；工具脚本内容按文件 hash 进键。
 *   R3 网关端口 127.0.0.1:<port> / localhost:<port> → <<PORT>>：每个实例一个端口。
 *   R4 临时目录下 mkdtemp 出来的随机目录（lark-claude-result-XXXXXX 等）→ <<TMPn>>（按首次出现编号）：结果文件路径每次都变。
 *   R5 假 lark-cli 发号的 id：simdocNNNNN → <<SIMDOC:内容 hash>>、om_simNNNNN → <<OMSIM:群 + 正文 hash>>：发号器是全局自增，
 *      并发下谁先发谁先拿号，同一份文档 / 同一句话两次跑号可能不同；换成内容 hash 后「是哪份文档 / 哪句话」仍在键里。查不到内容的号保留原样。
 *   R6（只在算键时剔，不进落盘输出）规则版本行「规则指纹：…」「~/.ai-rules@sha · lark-bot@sha」：只是审计用的版本号，lark-bot 每提交一次都变；
 *      规则正文本身仍在 prompt 里进键。
 *   R7（只在算键时剔）上下文里本 bot 自己那几行的发送时刻「（bot，我们自己）（MM-DD HH:MM）」、引用 bot 的话时引用头里的时刻 → <<BOT_TIME>>：bot 的发送时刻 = 收到时刻 + 执行耗时，
 *      冷跑要几分钟、命中是零点几秒，虚拟时钟下两次跑必然不同；行的先后顺序与正文照旧进键。人的消息时刻不动（来自原始时间线，两次一样）。
 *   R8 业务仓状态取内容不取 sha：HEAD 树 hash + 最近 30 个提交的（树、作者、提交说明）+ 工作区内容树（临时索引 add -A 后 write-tree，含未跟踪、
 *      不含 .gitignore 掉的）。worker 在回放里提交的 commit 带真实时间，sha 每次都不同、内容一样；索引里暂存与否（质量闸会 add -N）也不算状态。
 *   R9 续会话（--resume <id>）：会话 id 原样进键（命中回放时 id 与录时相同，冷跑新开的会话 id 不同 → 自然不命中），另加被续会话文件规范化后的内容 hash。
 *   argv 的顺序不重排：由 lark-bot 代码确定性拼出，顺序变了就是代码变了。
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync, copyFileSync, cpSync, existsSync, fstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const larkBotCodeRoot = resolve(here, '..', '..')
const replayRoot = process.env.FALIVE_REPLAY_DIR || join(homedir(), 'github', 'lark-bot', 'runtime', 'falive-replay')
export const cacheRoot = () => process.env.SIM_AI_CACHE_DIR || join(replayRoot, 'ai-cache')
export const CACHE_VERSION = 2
// 只读类（核对工具按这个算命中率）；可写类要业务仓状态一致才放。
export const READONLY_KINDS = new Set(['intent', 'triage', 'analysis', 'task-ro', 'resume-ro'])
export const WRITE_KINDS = new Set(['task-rw', 'resume-rw'])

// —— argv 解析 ——
// lark-bot 拼的 claude 参数（lib/lark-ai-executor.mjs buildAiExecutorCommand / lib/lark-claude-args.mjs）全集；不在表里的参数 → 判不了，直通。
const BOOL_FLAGS = new Set([
  '-p', '--print', '--strict-mcp-config', '--exclude-dynamic-system-prompt-sections', '--no-session-persistence', '--verbose',
  '--include-partial-messages', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--continue', '-c', '--fork-session',
  '--version', '-v', '-h', '--help', '--safe-mode',
])
const VALUE_FLAGS = new Set([
  '--permission-mode', '--tools', '--allowedTools', '--allowed-tools', '--model', '--effort', '--setting-sources', '--append-system-prompt',
  '--system-prompt', '--json-schema', '--output-format', '--input-format', '--resume', '-r', '--session-id', '--mcp-config', '--settings',
  '--fallback-model', '--max-turns',
])
const VARIADIC_FLAGS = new Set(['--add-dir', '--disallowedTools', '--disallowed-tools'])

export const parseClaudeArgv = (argv) => {
  const opts = {}
  const positional = []
  const unknown = []
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--') {
      positional.push(...argv.slice(i + 1))
      break
    }
    if (token.startsWith('-') && token.length > 1) {
      const [name, inline] = token.startsWith('--') && token.includes('=') ? [token.slice(0, token.indexOf('=')), token.slice(token.indexOf('=') + 1)] : [token, null]
      if (BOOL_FLAGS.has(name)) opts[name] = true
      else if (VALUE_FLAGS.has(name)) {
        opts[name] = inline ?? argv[i + 1]
        if (inline == null) i += 1
      } else if (VARIADIC_FLAGS.has(name)) {
        const values = inline != null ? [inline] : []
        while (inline == null && i + 1 < argv.length && !argv[i + 1].startsWith('-')) values.push(argv[(i += 1)])
        opts[name] = [...(opts[name] || []), ...values]
      } else unknown.push(name)
    } else positional.push(token)
  }
  return { opts, positional, unknown }
}

// 只读 Bash 白名单（lib/lark-ai-executor.mjs triageReadOnlyBashRules + extraReadOnlyCommands 里读 bug 记录 / 查环境版本的两个工具）。
// 页面工具（config.verify.pageTool）会起浏览器、落截图——不认，带它的调用直通。
const READONLY_BASH = new Set(['git log', 'git show', 'git diff', 'git status', 'git branch', 'git rev-parse', 'git merge-base', 'git blame', 'rg'])
const READONLY_NODE_TOOLS = new Set(['read-bug-record.mjs', 'env-version.mjs'])
const READONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Bash'])
const isReadOnlyBashRule = (rule) => {
  const match = /^Bash\((.+):\*\)$/.exec(rule.trim())
  if (!match) return false
  const command = match[1].trim()
  if (READONLY_BASH.has(command)) return true
  const node = /^node (\/\S+)$/.exec(command)
  return Boolean(node && READONLY_NODE_TOOLS.has(basename(node[1])) && basename(dirname(node[1])) === 'tools')
}

// 判定（只看 argv，运行时条件另判）：{ cacheable, kind, reason, sessionPersisted, resumeId, prompt }。
// kind：intent / triage / analysis / task-ro / resume-ro（只读）；task-rw / resume-rw（可写，要业务仓状态一致）；直通的 task-page / resume / version / other。
export const classifyClaudeArgv = (argv) => {
  const { opts, positional, unknown } = parseClaudeArgv(argv)
  const prompt = positional.at(-1) ?? null
  const bypass = (kind, reason) => ({ cacheable: false, kind, reason, sessionPersisted: false, resumeId: null, prompt })
  if (opts['--version'] || opts['-v'] || opts['-h'] || opts['--help']) return bypass('version', '版本 / 帮助')
  if (unknown.length) return bypass('other', `不认识的参数 ${unknown.join(' ')}`)
  if (opts['--continue'] || opts['-c'] || opts['--fork-session'] || opts['--session-id']) return bypass('resume', '--continue / --fork-session / --session-id')
  if (!(opts['-p'] || opts['--print'])) return bypass('other', '非 -p 无头调用')
  if (opts['--mcp-config'] || opts['--settings'] || opts['--system-prompt'] || opts['--input-format']) return bypass('other', '带 mcp / settings / 换系统提示 / 输入格式')
  const format = opts['--output-format']
  if (!['json', 'stream-json'].includes(format)) return bypass('other', `输出格式 ${format || 'text'}（拿不到 result 事件判成败）`)
  if (positional.length !== 1) return bypass('other', `位置参数 ${positional.length} 个（预期只有 prompt）`)
  const resumeId = opts['--resume'] || opts['-r'] || null
  const sessionPersisted = !opts['--no-session-persistence']
  const hasSchema = Boolean(opts['--json-schema'])
  const ok = (kind) => ({ cacheable: true, kind, reason: WRITE_KINDS.has(kind) ? 'writable（要业务仓状态一致）' : 'readonly', sessionPersisted, resumeId, prompt })

  // 可写：--dangerously-skip-permissions（改码实施、规范纠正 pass）。录放靠「业务仓状态一致 + 回放改动」，运行时再判 cwd 是不是业务仓。
  if (opts['--dangerously-skip-permissions'] || opts['--allow-dangerously-skip-permissions']) {
    if (hasSchema || format !== 'stream-json') return bypass('other', '可写调用但不是任务模式（stream-json、无 schema）')
    return ok(resumeId ? 'resume-rw' : 'task-rw')
  }
  const permissionMode = opts['--permission-mode'] || 'default'
  if (!['plan', 'default'].includes(permissionMode)) return bypass('other', `permission-mode ${permissionMode}`)
  if (!opts['--tools']) return bypass('other', '没有 --tools 限定也没有 --dangerously-skip-permissions（认不出）')
  const tools = opts['--tools'].split(',').map((t) => t.trim()).filter(Boolean)
  const writable = tools.filter((t) => !READONLY_TOOLS.has(t))
  if (writable.length) return bypass('other', `工具面含 ${writable.join(',')}`)
  if (tools.includes('Bash')) {
    const rules = String(opts['--allowedTools'] || opts['--allowed-tools'] || '').split(',').filter((r) => r.trim())
    if (!rules.length) return bypass('other', 'Bash 没有只读白名单')
    const odd = rules.filter((r) => !isReadOnlyBashRule(r))
    if (odd.length) return bypass('task-page', `Bash 白名单含非只读命令（页面工具会落截图、真打环境）${odd.join(',').slice(0, 100)}`)
  }
  let kind = null
  if (permissionMode === 'plan' && tools.join(',') === 'Read' && hasSchema && format === 'json') kind = 'intent'
  else if (hasSchema && format === 'json' && tools.includes('Bash')) kind = 'triage'
  else if (hasSchema && format === 'stream-json') kind = 'analysis'
  else if (!hasSchema && format === 'stream-json') kind = 'task-ro'
  if (!kind) return bypass('other', '只读但认不出是哪类调用')
  if (resumeId) {
    if (kind !== 'task-ro') return bypass('resume', `${kind} 续会话（lark-bot 没有这种调用）`)
    kind = 'resume-ro'
  }
  return ok(kind)
}

// —— 规范化 ——
// claude 的项目目录名：realpath(cwd) 里非字母数字一律换成 -（实测 /private/tmp/x → -private-tmp-x）。
export const encodeProjectDir = (path) => path.replace(/[^a-zA-Z0-9]/g, '-')
const realpathOr = (path) => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const sha = (data) => createHash('sha256').update(data).digest('hex')
const readJsonOr = (path, fallback) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

// 规范化器：从这次调用的输入里收集「易变值 → 占位符」，同一张表用来规范化输出（落盘）与反规范化（命中时换成这次的值）。规则见文件头 R1–R5。
export const createNormalizer = ({
  simDir = process.env.SIM_DIR || null,
  port = process.env.LARK_GATEWAY_PORT || null,
  larkBotRoot = larkBotCodeRoot,
} = {}) => {
  // boundary：'digits' = 号码类，后面不能紧跟数字；'path' = 路径，后面不能紧跟路径字符（/a/lark-bot 不吃 /a/lark-bot-p0f）
  const pairs = [] // { value, placeholder, boundary }
  const add = (value, placeholder, boundary = null) => {
    if (value && !pairs.some((p) => p.value === value)) pairs.push({ value, placeholder, boundary })
  }
  const addPath = (path, placeholder, encPlaceholder = null) => {
    if (!path) return
    const abs = resolve(path)
    const real = realpathOr(abs)
    add(abs, placeholder, 'path')
    add(real, placeholder, 'path')
    if (!encPlaceholder) return
    add(encodeProjectDir(real), encPlaceholder)
    add(encodeProjectDir(abs), encPlaceholder)
  }
  addPath(simDir, '<<SIM_DIR>>', '<<SIM_DIR_ENC>>') // R1
  // R2（SIM_DIR 在它下面时更长的先换；不换项目目录编码：编码里 - 既是分隔又是字符，分不出边界，cwd 在 lark-bot 根的 intent 也不落会话）
  addPath(larkBotRoot, '<<LARK_BOT>>')
  if (port) { // R3
    add(`127.0.0.1:${port}`, '127.0.0.1:<<PORT>>', 'digits')
    add(`localhost:${port}`, 'localhost:<<PORT>>', 'digits')
  }
  // R4
  const tmpRoots = [...new Set([tmpdir(), realpathOr(tmpdir()), '/tmp', '/private/tmp'].map((p) => p.replace(/\/+$/, '')))]
  const tmpRe = new RegExp(`(?:${tmpRoots.map(escapeRe).join('|')})/[A-Za-z][A-Za-z0-9_.]*(?:-[A-Za-z0-9_.]+)*-[A-Za-z0-9]{6}(?![A-Za-z0-9_.-])`, 'g')
  let tmpCount = 0
  // R5：假 lark-cli 的发号 → 内容 hash（同一 hash 两个号时加序号区分）
  const sent = simDir ? readJsonOr(join(simDir, 'sent.json'), []) : []
  const sentById = new Map((Array.isArray(sent) ? sent : []).map((m) => [m.message_id, m]))
  const contentPlaceholder = (prefix, digest) => {
    const base = `<<${prefix}:${digest.slice(0, 12)}`
    const same = pairs.filter((p) => p.placeholder.startsWith(base)).length
    return `${base}${same ? `#${same + 1}` : ''}>>`
  }
  const collect = (text) => {
    const s = String(text)
    for (const match of s.matchAll(tmpRe)) {
      if (!pairs.some((p) => p.value === match[0])) add(match[0], `<<TMP${(tmpCount += 1)}>>`)
    }
    if (!simDir) return
    for (const match of s.matchAll(/simdoc\d{5,}(?!\d)/g)) {
      if (pairs.some((p) => p.value === match[0])) continue
      const doc = join(simDir, 'docs', `${match[0]}.md`)
      if (existsSync(doc)) add(match[0], contentPlaceholder('SIMDOC', sha(readFileSync(doc))), 'digits')
    }
    for (const match of s.matchAll(/om_sim\d{5,}(?!\d)/g)) {
      if (pairs.some((p) => p.value === match[0])) continue
      const m = sentById.get(match[0])
      if (m) add(match[0], contentPlaceholder('OMSIM', sha(`${m.chat_id}\0${m.content}`)), 'digits')
    }
  }
  const BOUNDARY = { digits: '(?!\\d)', path: '(?![A-Za-z0-9_.-])' }
  const replaceAll = (text, from, to, boundary) => (boundary ? text.replace(new RegExp(`${escapeRe(from)}${BOUNDARY[boundary]}`, 'g'), () => to) : text.split(from).join(to))
  const normalize = (text) => {
    let out = String(text)
    for (const p of [...pairs].sort((a, b) => b.value.length - a.value.length)) out = replaceAll(out, p.value, p.placeholder, p.boundary)
    return out
  }
  // 反规范化：占位符 → 这次的值（同一占位符多个值时取先登记的：SIM_DIR 取原样写法）。
  const denormalize = (text) => {
    let out = String(text)
    const seen = new Set()
    for (const p of pairs) {
      if (seen.has(p.placeholder)) continue
      seen.add(p.placeholder)
      out = out.split(p.placeholder).join(p.value)
    }
    return out
  }
  return { collect, normalize, denormalize, pairs }
}

// R6 + R7：只在算键时剔（单向，不进落盘的输出）。
const RULE_VERSION_RE = /规则指纹：[0-9a-f]{8,64}|(~\/\.ai-rules|lark-bot)@[0-9a-f]{7,40}\b/g
const BOT_TIME_RE = /（bot，我们自己）（\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?）/g
// 引用的是 bot 自己的话时，引用头「【被引用消息】（Aven.Bot 11-03 15:09）」的时刻同理（人回 bot 那句时）。bot 显示名：SIM_BOT_NAMES（逗号分隔），默认 Aven.Bot / Aven.Test。
const botNames = () => String(process.env.SIM_BOT_NAMES || 'Aven.Bot,Aven.Test').split(',').map((n) => n.trim()).filter(Boolean)
const quotedBotTimeRe = () => new RegExp(`(【被引用消息】（(?:${botNames().map(escapeRe).join('|')})) \\d{2}-\\d{2} \\d{2}:\\d{2}）`, 'gi')
export const stripForKey = (text) => String(text)
  .replace(RULE_VERSION_RE, (match, repo) => (repo ? `${repo}@<<REV>>` : '规则指纹：<<RULES_FP>>'))
  .replace(BOT_TIME_RE, '（bot，我们自己）（<<BOT_TIME>>）')
  .replace(quotedBotTimeRe(), '$1 <<BOT_TIME>>）')

// —— 引用文件：prompt / argv 里出现的绝对路径，存在的文件取内容 hash（附件截图、预取的 Lark 文档 / Figma 规格、工具脚本），键随内容变 ——
const PATH_RE = /\/[^\s"'`<>()[\]{},;，。；：、！？“”‘’（）【】|*]+/g
const MAX_HASH_BYTES = 200 * 1024 * 1024
const hashFile = (path) => sha(readFileSync(path))
const hashDir = (dir, limit = 300) => {
  const hash = createHash('sha256')
  let count = 0
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      if (name === '.git' || name === 'node_modules') continue
      const full = join(current, name)
      const st = statSync(full)
      if (st.isDirectory()) walk(full)
      else if (st.isFile() && !name.endsWith('.log')) {
        if ((count += 1) > limit) throw new Error('too many files')
        hash.update(`${relative(dir, full)}\0${hashFile(full)}\0`)
      }
    }
  }
  try {
    walk(dir)
    return hash.digest('hex')
  } catch {
    return `big:${count}`
  }
}
export const referencedFiles = (texts, normalizer, { simDir = process.env.SIM_DIR || null } = {}) => {
  const runtimeRoot = simDir ? join(resolve(simDir), 'runtime') : null
  const seen = new Map()
  for (const text of texts) {
    for (const raw of String(text || '').matchAll(PATH_RE)) {
      const path = raw[0].replace(/[.:]+$/, '')
      if (seen.has(path) || path.length < 4) continue
      let st
      try {
        st = statSync(path)
      } catch {
        continue
      }
      if (st.isFile()) {
        // 审计日志边跑边追加，内容不进键（只记路径）
        seen.set(path, path.endsWith('.log') || st.size > MAX_HASH_BYTES ? `size:${path.endsWith('.log') ? '-' : st.size}` : hashFile(path))
      } else if (st.isDirectory()) {
        // 运行目录下三层以上的子目录（Figma 规格目录这类）取内容；运行目录 / 仓库根这类大目录只记存在（仓库状态另由 cwd 的 git 状态进键）
        const depth = runtimeRoot && path.startsWith(`${runtimeRoot}/`) ? relative(runtimeRoot, path).split('/').length : 0
        seen.set(path, depth >= 3 ? `dir:${hashDir(path)}` : 'dir')
      }
    }
  }
  return [...seen.entries()].map(([path, hash]) => [normalizer.normalize(path), hash]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
}

// —— 业务仓状态（R8）——
const git = (cwd, args, { env = process.env, input } = {}) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024, env, input })
const gitOut = (cwd, args, options) => {
  const r = git(cwd, args, options)
  return r.status === 0 ? r.stdout.toString('utf8').trim() : null
}
// 工作区内容树：拷一份真索引（借它的 stat 缓存，快）到临时文件，在临时索引上 add -A 再 write-tree；真索引不动。
export const worktreeTree = (top) => {
  const indexRel = gitOut(top, ['rev-parse', '--git-path', 'index'])
  if (!indexRel) return null
  const indexPath = isAbsolute(indexRel) ? indexRel : join(top, indexRel)
  const scratch = mkdtempSync(join(tmpdir(), 'claude-cache-idx-'))
  try {
    const tmpIndex = join(scratch, 'index')
    if (existsSync(indexPath)) copyFileSync(indexPath, tmpIndex)
    const env = { ...process.env, GIT_INDEX_FILE: tmpIndex }
    if (git(top, ['add', '-A'], { env }).status !== 0) return null
    return gitOut(top, ['write-tree'], { env })
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
export const repoState = (cwd) => {
  const top = gitOut(cwd, ['rev-parse', '--show-toplevel'])
  if (!top) return null
  const head = gitOut(top, ['rev-parse', 'HEAD'])
  if (!head) return null
  const headTree = gitOut(top, ['rev-parse', 'HEAD^{tree}'])
  const log = git(top, ['log', '-n', '30', '--format=%T%x1f%an%x1f%ae%x1f%B%x1e'])
  const wtTree = worktreeTree(top)
  if (!headTree || log.status !== 0 || !wtTree) return null
  return { top, head, key: { headTree, history: sha(log.stdout), wtTree } }
}

// 规则版本行剔掉后，claude 自动加载、提示里剔掉的那部分（~/.claude/CLAUDE.md → ~/.ai-rules/AGENT.md）另取文件内容进键（业务仓 CLAUDE.md 随仓库状态进键）。
const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
const autoLoadedRulesState = () => [join(claudeHome(), 'CLAUDE.md'), join(homedir(), '.ai-rules', 'AGENT.md')]
  .map((path) => [path, existsSync(path) ? hashFile(realpathOr(path)) : null])

const findSessionFile = (cwd, sessionId) => {
  const projects = join(claudeHome(), 'projects')
  const direct = join(projects, encodeProjectDir(realpathOr(cwd)), `${sessionId}.jsonl`)
  if (existsSync(direct)) return direct
  try {
    for (const dir of readdirSync(projects)) {
      const candidate = join(projects, dir, `${sessionId}.jsonl`)
      if (existsSync(candidate)) return candidate
    }
  } catch {
    // 没有 projects 目录
  }
  return null
}

// 算键：返回 { key, material, normalizedArgv, parts }。parts 是各分项的 hash（核对工具定位「哪一项变了」）。
// repo / session 由调用方先算好传进来（main 里要用它们判 bypass、录改动）；测试可直接传。
export const computeCacheKey = ({ argv, stdinText = '', cwd = process.cwd(), kind, normalizer, simDir = process.env.SIM_DIR || null, repo = null, session = null }) => {
  for (const text of [...argv, stdinText]) normalizer.collect(text)
  const normalizedArgv = argv.map((a) => normalizer.normalize(a))
  const keyArgv = normalizedArgv.map(stripForKey)
  const material = {
    v: CACHE_VERSION,
    kind,
    argv: keyArgv,
    stdin: stripForKey(normalizer.normalize(stdinText)),
    rules: argv.some((a) => a.includes('规则指纹：')) ? autoLoadedRulesState() : null,
    cwd: normalizer.normalize(realpathOr(cwd)),
    files: referencedFiles([...argv, stdinText], normalizer, { simDir }),
    repo,
    session,
  }
  const parts = {
    flags: sha(JSON.stringify(keyArgv.slice(0, -1))),
    prompt: sha(keyArgv.at(-1) || ''),
    files: sha(JSON.stringify(material.files)),
    cwd: sha(material.cwd),
    repo: repo ? sha(JSON.stringify(repo)) : null,
    session: session ? sha(JSON.stringify(session)) : null,
    rules: material.rules ? sha(JSON.stringify(material.rules)) : null,
  }
  return { key: sha(JSON.stringify(material)), material, normalizedArgv, parts }
}

// —— 输出判成败 ——
export const LIMIT_RE = /hit your (?:session |weekly |usage |daily )?limit|usage limit reached|"api_error_status":\s*429|rate_limit_error|\[claude-quota\] killed/i
const lastSessionId = (text) => [...text.matchAll(/"session_id":"([^"]+)"/g)].at(-1)?.[1] || null
const resultEvent = (text, format) => {
  const trimmed = text.trim()
  if (format === 'json') {
    try {
      return JSON.parse(trimmed)
    } catch {
      return null
    }
  }
  const lines = trimmed.split('\n')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].includes('"type":"result"')) continue
    try {
      const event = JSON.parse(lines[i])
      if (event?.type === 'result') return event
    } catch {
      // 下一行
    }
  }
  return null
}
// prompt 里给的结果文件路径：任务模式「结果文件路径：<path>」；结果补写（buildClaudeResultRecoveryInstruction）「覆盖写入 <path>。」
export const resultPathOf = (prompt) => [...String(prompt || '').matchAll(/结果文件路径：(\S+)|覆盖写入 (\S+?)。/g)].map((m) => m[1] || m[2]).at(-1) || null

// —— 真 claude（链到额度闸）——
const cacheWrappers = new Set([join(here, 'claude'), join(here, 'claude-cache.mjs')].map(realpathOr))
const quotaWrappers = new Set([join(here, 'claude-q'), join(here, 'claude-quota.mjs')].map(realpathOr))
const isWrapper = (path) => cacheWrappers.has(realpathOr(path)) || quotaWrappers.has(realpathOr(path))
const firstOnPath = (env) => {
  for (const dir of String(env.PATH || '').split(':').filter(Boolean)) {
    const candidate = join(dir, 'claude')
    if (existsSync(candidate) && !isWrapper(candidate)) return candidate
  }
  return null
}
// 下游：SIM_REAL_CLAUDE（run-sim 设成额度闸 claude-q）；没设就是 PATH 里第一个不是包装壳的 claude。run-sim 拿它打「真 claude」日志（那时还没设 SIM_REAL_CLAUDE）。
export const resolveRealClaude = (env = process.env) => {
  if (env.SIM_REAL_CLAUDE && !cacheWrappers.has(realpathOr(env.SIM_REAL_CLAUDE))) return env.SIM_REAL_CLAUDE
  const found = firstOnPath(env)
  if (!found) throw new Error('找不到真 claude（设 SIM_REAL_CLAUDE）')
  return found
}
// 给下游的环境：下游是额度闸时，它自己也读 SIM_REAL_CLAUDE 找真 claude——这里换成真二进制（SIM_TRUE_CLAUDE || PATH），
// 不然额度闸会把自己当真 claude 无限套娃。SIM_CLAUDE_CACHE_INNER=1：万一又绕回本包装，直接直通。
export const downstreamEnv = (real, env = process.env) => {
  const out = { ...env, SIM_CLAUDE_CACHE_INNER: '1' }
  if (quotaWrappers.has(realpathOr(real))) {
    const trueReal = env.SIM_TRUE_CLAUDE || firstOnPath(env)
    if (!trueReal) throw new Error('下游是额度闸，但 PATH 里找不到真 claude（设 SIM_TRUE_CLAUDE）')
    out.SIM_REAL_CLAUDE = trueReal
  }
  return out
}

// —— 日志 ——
const simDirOr = () => process.env.SIM_DIR || null
const logLine = ({ outcome, kind, key, ms, note = '' }) => {
  const target = simDirOr() ? join(simDirOr(), 'ai-cache.log') : join(cacheRoot(), 'ai-cache.log')
  try {
    mkdirSync(dirname(target), { recursive: true })
    appendFileSync(target, `${new Date().toISOString()} ${outcome} ${kind} ${key ? key.slice(0, 12) : '-'} ${ms}ms${note ? ` ${note.replace(/\s+/g, ' ').slice(0, 160)}` : ''}\n`)
  } catch {
    // 日志失败不影响调用
  }
}
const logCall = (row) => {
  const dir = simDirOr()
  if (!dir) return
  try {
    appendFileSync(join(dir, 'ai-cache-calls.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`)
  } catch {
    // 同上
  }
}
const savePrompt = (key, text) => {
  const dir = simDirOr()
  if (!dir) return
  try {
    mkdirSync(join(dir, 'ai-cache-prompts'), { recursive: true })
    writeFileSync(join(dir, 'ai-cache-prompts', `${key.slice(0, 12)}.txt`), text)
  } catch {
    // 同上
  }
}
export const taskIdOf = (prompt) => /任务 ID：(\S+)/.exec(String(prompt || ''))?.[1] || /om_[0-9a-z]{20,}/.exec(String(prompt || ''))?.[0] || null

// stdin：lark-bot 的 claude 调用全走 argv（stdin 继承 worker 的，sim 里是 /dev/null）。管道 / 文件才读；读 500ms 还没 EOF 就判不了 → 直通。
const readStdin = () =>
  new Promise((resolveStdin) => {
    let st
    try {
      st = fstatSync(0)
    } catch {
      return resolveStdin({ text: '', mode: 'ignore' })
    }
    if (!(st.isFIFO() || st.isFile() || st.isSocket())) return resolveStdin({ text: '', mode: 'ignore' })
    const chunks = []
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveStdin(value)
    }
    const timer = setTimeout(() => {
      process.stdin.pause()
      done({ text: null, mode: 'unknown', chunks })
    }, 500)
    process.stdin.on('data', (chunk) => chunks.push(chunk))
    process.stdin.on('end', () => done({ text: Buffer.concat(chunks).toString('utf8'), mode: 'pipe' }))
    process.stdin.on('error', () => done({ text: null, mode: 'unknown', chunks }))
  })

const forwardSignals = (child) => {
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(sig, () => {
      try {
        child.kill(sig)
      } catch {
        // 已退出
      }
    })
  }
}

// 直通：下游接管 stdio，退出码原样。
const passThrough = async ({ argv, kind, key = null, note, stdin }) => {
  const started = Date.now()
  const real = resolveRealClaude()
  // ignore = 没读过 stdin，下游直接继承；pipe = 已整段读完；unknown = 读了一部分没等到 EOF，已读的先写、剩下的接着管道过去。
  const useStdin = stdin?.mode === 'pipe' || stdin?.mode === 'unknown' ? 'pipe' : 'inherit'
  const child = spawn(real, argv, { stdio: [useStdin, 'inherit', 'inherit'], env: downstreamEnv(real) })
  forwardSignals(child)
  if (useStdin === 'pipe') {
    child.stdin.on('error', () => {})
    if (stdin?.text != null) child.stdin.end(stdin.text)
    else {
      for (const chunk of stdin?.chunks || []) child.stdin.write(chunk)
      process.stdin.resume()
      process.stdin.pipe(child.stdin)
    }
  }
  const code = await new Promise((resolveExit) => {
    child.on('error', (error) => {
      process.stderr.write(`[claude-cache] 起下游 claude 失败：${error.message}\n`)
      resolveExit(127)
    })
    child.on('exit', (exitCode, signal) => resolveExit(exitCode ?? (signal ? 128 + 15 : 1)))
  })
  if (kind !== 'version' && kind !== 'inner') {
    logLine({ outcome: 'bypass', kind, key, ms: Date.now() - started, note })
    logCall({ outcome: 'bypass', kind, key, note })
  }
  process.exitCode = code
}

const writeEntry = (dir, name, content) => writeFileSync(join(dir, name), content, { mode: 0o600 })

// 命中回放。可写调用先把录下的改动打回工作区并核对内容树；打不上 / 对不上就撤回、返回 false 让调用方改真调。
const replayHit = ({ entryDir, normalizer, cwd, repo, verdict, key, started, parts }) => {
  const meta = JSON.parse(readFileSync(join(entryDir, 'meta.json'), 'utf8'))
  if (meta.v !== CACHE_VERSION) throw new Error(`条目版本 ${meta.v} ≠ ${CACHE_VERSION}`)
  let applied = false
  if (meta.patchFile) {
    const patch = readFileSync(join(entryDir, meta.patchFile))
    if (patch.length) {
      const r = git(repo.top, ['apply', '--whitespace=nowarn', '-'], { input: patch })
      if (r.status !== 0) throw new Error(`改动打不上：${r.stderr.toString('utf8').slice(0, 160)}`)
      applied = true
      const after = worktreeTree(repo.top)
      if (after !== meta.postWtTree) {
        git(repo.top, ['apply', '-R', '--whitespace=nowarn', '-'], { input: patch })
        throw new Error(`打完改动内容树 ${after?.slice(0, 10)} ≠ 录时 ${String(meta.postWtTree).slice(0, 10)}，已撤回`)
      }
    }
  }
  try {
    const stdout = normalizer.denormalize(readFileSync(join(entryDir, 'stdout.txt'), 'utf8'))
    const stderr = normalizer.denormalize(readFileSync(join(entryDir, 'stderr.txt'), 'utf8'))
    if (meta.resultPathNorm) {
      const target = normalizer.denormalize(meta.resultPathNorm)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, normalizer.denormalize(readFileSync(join(entryDir, 'result.txt'), 'utf8')))
    }
    if (meta.sessionId) {
      const projectDir = join(claudeHome(), 'projects', encodeProjectDir(realpathOr(cwd)))
      mkdirSync(projectDir, { recursive: true })
      writeFileSync(join(projectDir, `${meta.sessionId}.jsonl`), normalizer.denormalize(readFileSync(join(entryDir, 'session', `${meta.sessionId}.jsonl`), 'utf8')), { mode: 0o600 })
      const sideDir = join(entryDir, 'session', meta.sessionId)
      if (existsSync(sideDir)) cpSync(sideDir, join(projectDir, meta.sessionId), { recursive: true, force: true })
    }
    const note = `原耗时 ${meta.durationMs}ms${applied ? `；改动已打回工作区（${meta.changedFiles ?? '?'} 个文件）` : ''}`
    logLine({ outcome: 'hit', kind: verdict.kind, key, ms: Date.now() - started, note })
    logCall({ outcome: 'hit', kind: verdict.kind, key, taskId: taskIdOf(verdict.prompt), parts, note })
    process.stdout.write(stdout)
    if (stderr) process.stderr.write(stderr)
    process.exitCode = meta.exitCode ?? 0
  } catch (error) {
    if (applied) git(repo.top, ['apply', '-R', '--whitespace=nowarn', '-'], { input: readFileSync(join(entryDir, meta.patchFile)) })
    throw error
  }
}

const main = async () => {
  const argv = process.argv.slice(2)
  if (process.env.SIM_CLAUDE_CACHE_INNER === '1' || process.env.SIM_AI_CACHE === '0') {
    return passThrough({ argv, kind: 'inner', note: '嵌套 / 关闭缓存', stdin: { mode: 'ignore' } })
  }
  const verdict = classifyClaudeArgv(argv)
  if (!verdict.cacheable) return passThrough({ argv, kind: verdict.kind, note: verdict.reason, stdin: { mode: 'ignore' } })
  const stdin = await readStdin()
  if (stdin.mode === 'unknown') return passThrough({ argv, kind: verdict.kind, note: 'stdin 判不了', stdin })
  const started = Date.now()
  const cwd = process.cwd()
  const normalizer = createNormalizer()
  for (const text of [...argv, stdin.text]) normalizer.collect(text)

  // 运行时条件：业务仓状态（intent 跑在 lark-bot 仓根只读附件，不进键）、可写调用必须在业务仓里、续会话要找得到会话文件。
  const repo = verdict.kind === 'intent' ? null : repoState(cwd)
  const isWrite = WRITE_KINDS.has(verdict.kind)
  if (isWrite && (!repo || realpathOr(repo.top) === realpathOr(larkBotCodeRoot))) {
    return passThrough({ argv, kind: verdict.kind, note: repo ? '可写调用跑在 lark-bot 仓里（自修），不录' : '可写调用的 cwd 不是 git 仓', stdin })
  }
  let session = null
  if (verdict.resumeId) {
    const file = findSessionFile(cwd, verdict.resumeId)
    if (!file) return passThrough({ argv, kind: verdict.kind, note: `续会话 ${verdict.resumeId.slice(0, 8)} 找不到会话文件`, stdin })
    session = { id: verdict.resumeId, content: sha(normalizer.normalize(readFileSync(file, 'utf8'))) }
  }
  const { key, material, normalizedArgv, parts } = computeCacheKey({ argv, stdinText: stdin.text, cwd, kind: verdict.kind, normalizer, repo: repo?.key || null, session })
  const entryDir = join(cacheRoot(), key)
  const { opts } = parseClaudeArgv(argv)
  const format = opts['--output-format']
  const resultPathRaw = ['task-ro', 'task-rw', 'resume-ro', 'resume-rw'].includes(verdict.kind) ? resultPathOf(verdict.prompt) : null

  // —— 命中 ——
  if (existsSync(join(entryDir, 'meta.json'))) {
    try {
      // SIM_AI_CACHE_HIT_DELAY=orig：命中也按录时耗时等一下再回放（只省 token 不省时间）。bot 回话的时刻 = 收到 + 耗时，命中零点几秒就回，
      // 会让「bot 的话排在人哪句之前 / 之后」跟冷跑不一样，进而改变后面调用的上下文；做「两遍输出一致」的验收时开它，排除时序这个变量。
      const delay = process.env.SIM_AI_CACHE_HIT_DELAY === 'orig' ? Number(readJsonOr(join(entryDir, 'meta.json'), {}).durationMs || 0) : Number(process.env.SIM_AI_CACHE_HIT_DELAY || 0)
      if (delay > 0) await new Promise((r) => setTimeout(r, Math.min(delay, 3 * 3600_000)))
      return replayHit({ entryDir, normalizer, cwd, repo, verdict, key, started, parts })
    } catch (error) {
      process.stderr.write(`[claude-cache] 回放失败，改真调：${error.message}\n`)
      logLine({ outcome: 'hit-fail', kind: verdict.kind, key, ms: Date.now() - started, note: error.message })
    }
  }

  // —— 未命中：真调（经额度闸）并透传 ——
  savePrompt(key, `${stripForKey(normalizedArgv.at(-1) || '')}`)
  const real = resolveRealClaude()
  const child = spawn(real, argv, { stdio: [stdin.mode === 'pipe' ? 'pipe' : 'inherit', 'pipe', 'pipe'], env: downstreamEnv(real) })
  forwardSignals(child)
  if (stdin.mode === 'pipe') {
    child.stdin.on('error', () => {})
    child.stdin.end(stdin.text)
  }
  const out = []
  const err = []
  child.stdout.on('data', (chunk) => {
    out.push(chunk)
    process.stdout.write(chunk)
  })
  child.stderr.on('data', (chunk) => {
    err.push(chunk)
    process.stderr.write(chunk)
  })
  const { code, signal } = await new Promise((resolveExit) => {
    child.on('error', (error) => {
      process.stderr.write(`[claude-cache] 起下游 claude 失败：${error.message}\n`)
      resolveExit({ code: 127, signal: null })
    })
    // 'exit' 后再等 stdout / stderr 读尽（最多 5 秒：claude 起的后台孙进程可能一直占着管道，别因此挂住 worker）。
    child.on('exit', (exitCode, sig) => {
      const ended = [child.stdout, child.stderr].map((stream) => (stream.readableEnded ? Promise.resolve() : new Promise((r) => stream.once('end', r).once('close', r))))
      Promise.race([Promise.all(ended), new Promise((r) => setTimeout(r, 5000).unref())]).then(() => resolveExit({ code: exitCode, signal: sig }))
    })
  })
  const durationMs = Date.now() - started
  const exitCode = code ?? (signal ? 128 + 15 : 1)
  process.exitCode = exitCode
  const stdoutText = Buffer.concat(out).toString('utf8')
  const stderrText = Buffer.concat(err).toString('utf8')
  const skip = (why) => {
    logLine({ outcome: 'miss', kind: verdict.kind, key, ms: durationMs, note: `不落盘：${why}` })
    logCall({ outcome: 'miss', kind: verdict.kind, key, taskId: taskIdOf(verdict.prompt), parts, stored: false, note: why })
  }
  if (exitCode !== 0) return skip(`退出 ${exitCode}${signal ? ` ${signal}` : ''}`)
  if (LIMIT_RE.test(stdoutText.slice(-20000)) || LIMIT_RE.test(stderrText.slice(-5000))) return skip('输出里有限额 / 限流 / 超时被杀字样')
  const event = resultEvent(stdoutText, format)
  if (!event || event.is_error || (event.subtype && event.subtype !== 'success')) return skip(`result 事件缺失或出错（${event?.subtype || 'none'}）`)
  if (['intent', 'triage', 'analysis'].includes(verdict.kind) && event.structured_output == null) return skip('没有 structured_output')
  let resultText = null
  if (resultPathRaw) {
    if (!existsSync(resultPathRaw)) return skip('结果文件没写（worker 会续会话补写，不缓存）')
    resultText = readFileSync(resultPathRaw, 'utf8')
    if (!resultText.trim()) return skip('结果文件为空')
  }
  const sessionId = verdict.sessionPersisted ? event.session_id || lastSessionId(stdoutText) : null
  let sessionFile = null
  if (verdict.sessionPersisted) {
    sessionFile = sessionId ? findSessionFile(cwd, sessionId) : null
    if (!sessionFile) return skip('会话文件找不到（命中后续会话会续不上）')
  }
  // 可写调用：录下「调用前工作区内容树 → 调用后」的二进制补丁；HEAD 动了不录。
  let patch = null
  let postWtTree = null
  let changedFiles = 0
  if (isWrite) {
    const post = repoState(cwd)
    if (!post) return skip('调用后读不到业务仓状态')
    if (post.head !== repo.head) return skip(`调用里 HEAD 变了（${repo.head.slice(0, 8)} → ${post.head.slice(0, 8)}）`)
    postWtTree = post.key.wtTree
    const diff = git(repo.top, ['diff', '--binary', '--full-index', repo.key.wtTree, postWtTree])
    if (diff.status !== 0) return skip('算不出改动补丁')
    patch = diff.stdout
    changedFiles = gitOut(repo.top, ['diff', '--name-only', repo.key.wtTree, postWtTree])?.split('\n').filter(Boolean).length || 0
  }
  // 落盘：先写临时目录再 rename，并发同键时先到先得。
  const tmpDir = `${entryDir}.tmp-${process.pid}`
  try {
    rmSync(tmpDir, { recursive: true, force: true })
    mkdirSync(tmpDir, { recursive: true })
    writeEntry(tmpDir, 'stdout.txt', normalizer.normalize(stdoutText))
    writeEntry(tmpDir, 'stderr.txt', normalizer.normalize(stderrText))
    writeEntry(tmpDir, 'argv.normalized.json', JSON.stringify(normalizedArgv, null, 2))
    writeEntry(tmpDir, 'prompt.raw.txt', verdict.prompt)
    writeEntry(tmpDir, 'prompt.normalized.txt', normalizedArgv.at(-1))
    if (stdin.text) writeEntry(tmpDir, 'stdin.txt', stdin.text)
    if (resultText != null) writeEntry(tmpDir, 'result.txt', normalizer.normalize(resultText))
    if (patch) writeEntry(tmpDir, 'worktree.patch', patch)
    if (sessionFile) {
      mkdirSync(join(tmpDir, 'session'), { recursive: true })
      writeEntry(join(tmpDir, 'session'), `${sessionId}.jsonl`, normalizer.normalize(readFileSync(sessionFile, 'utf8')))
      const sideDir = join(dirname(sessionFile), sessionId)
      if (existsSync(sideDir)) cpSync(sideDir, join(tmpDir, 'session', sessionId), { recursive: true })
    }
    writeEntry(tmpDir, 'meta.json', JSON.stringify({
      v: CACHE_VERSION,
      key,
      kind: verdict.kind,
      createdAt: new Date().toISOString(),
      sim: simDirOr() ? basename(simDirOr()) : null,
      cwd: material.cwd,
      repo: material.repo,
      session: material.session,
      files: material.files,
      parts,
      exitCode,
      durationMs,
      resultPathNorm: resultPathRaw ? normalizer.normalize(resultPathRaw) : null,
      sessionId,
      patchFile: patch ? 'worktree.patch' : null,
      postWtTree,
      changedFiles,
      placeholders: normalizer.pairs.map((p) => p.placeholder),
    }, null, 2))
    mkdirSync(dirname(entryDir), { recursive: true })
    renameSync(tmpDir, entryDir)
    logLine({ outcome: 'miss', kind: verdict.kind, key, ms: durationMs, note: isWrite ? `已落盘（改动 ${changedFiles} 个文件）` : '已落盘' })
    logCall({ outcome: 'miss', kind: verdict.kind, key, taskId: taskIdOf(verdict.prompt), parts, stored: true })
  } catch (error) {
    rmSync(tmpDir, { recursive: true, force: true })
    logLine({ outcome: 'miss', kind: verdict.kind, key, ms: durationMs, note: `落盘失败：${error.message}` })
    logCall({ outcome: 'miss', kind: verdict.kind, key, taskId: taskIdOf(verdict.prompt), parts, stored: false, note: `落盘失败：${error.message}` })
  }
}

if (process.argv[1] && realpathOr(process.argv[1]) === realpathOr(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`[claude-cache] ${error?.stack || error}\n`)
    process.exitCode = 1
  })
}
