#!/usr/bin/env node
/**
 * 回放用 claude 调用缓存（docs/falive-replay-plan-2026-11-03.md §6 改法 2）：run-sim 把 LARK_CLAUDE_BIN 指到 scripts/sim/claude（本文件的 sh 壳）。
 * 同一份输入（规范化后的 argv + stdin + 引用文件内容 + cwd 的 git 状态）再跑一次就复用上次的输出；只缓存只读调用：
 *   intent（--permission-mode plan、--tools Read）、triage（--json-schema + json）、analysis（--json-schema + stream-json）、
 *   只读单趟任务（代答 / 实测：--tools Read,Grep,Glob,Bash + 只读 Bash 白名单、无 --dangerously-skip-permissions，结果写 prompt 里的结果文件）。
 * 任何可写调用（--dangerously-skip-permissions、没有 --tools 限定、Bash 白名单里有不认识的命令）、续会话（--resume）、未知参数一律直通真 claude。
 * 命中：原样回放 stdout / stderr / 退出码，结果文件写到这次 prompt 给的新路径；带会话的（analysis / 只读任务，实施 / 补写群回复会 --resume 它）
 * 把会话文件写进这次 cwd 对应的 ~/.claude/projects/<编码后的 cwd>/，续会话照常能续上。
 * 未命中：真跑（stdout / stderr 实时透传，worker 的空闲超时照常），成功（退出 0、result 事件非 is_error、该有的结果文件 / 会话文件都在）才落盘。
 * 缓存目录：SIM_AI_CACHE_DIR || runtime/falive-replay/ai-cache/<key>/；每次调用往 SIM_DIR/ai-cache.log 追加一行。
 * 真 claude：SIM_REAL_CLAUDE || PATH 里第一个不是本包装的 claude。
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync, cpSync, existsSync, fstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const replayRoot = process.env.FALIVE_REPLAY_DIR || join(homedir(), 'github', 'lark-bot', 'runtime', 'falive-replay')
export const cacheRoot = () => process.env.SIM_AI_CACHE_DIR || join(replayRoot, 'ai-cache')
const CACHE_VERSION = 1

// —— argv 解析 ——
// lark-bot 拼的 claude 参数（lib/lark-ai-executor.mjs buildAiExecutorCommand / lib/lark-claude-args.mjs）全集；不在表里的参数 → 判不了，直通。
const BOOL_FLAGS = new Set([
  '-p', '--print', '--strict-mcp-config', '--exclude-dynamic-system-prompt-sections', '--no-session-persistence', '--verbose',
  '--include-partial-messages', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--continue', '-c', '--fork-session',
  '--version', '-v', '-h', '--help',
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

// 判定：{ cacheable, kind, reason, sessionPersisted, prompt }。kind 是 resultKind 推断（intent / triage / analysis / task-ro；直通的 task-rw / resume / version / other）。
export const classifyClaudeArgv = (argv) => {
  const { opts, positional, unknown } = parseClaudeArgv(argv)
  const bypass = (kind, reason) => ({ cacheable: false, kind, reason, sessionPersisted: false, prompt: positional.at(-1) ?? null })
  if (opts['--version'] || opts['-v'] || opts['-h'] || opts['--help']) return bypass('version', '版本 / 帮助')
  if (unknown.length) return bypass('other', `不认识的参数 ${unknown.join(' ')}`)
  if (opts['--resume'] || opts['-r'] || opts['--continue'] || opts['-c'] || opts['--fork-session'] || opts['--session-id']) return bypass('resume', '续会话（--resume）')
  if (opts['--dangerously-skip-permissions'] || opts['--allow-dangerously-skip-permissions']) return bypass('task-rw', '可写任务（--dangerously-skip-permissions）')
  if (!(opts['-p'] || opts['--print'])) return bypass('other', '非 -p 无头调用')
  if (opts['--mcp-config'] || opts['--settings'] || opts['--system-prompt'] || opts['--input-format']) return bypass('other', '带 mcp / settings / 换系统提示 / 输入格式')
  const permissionMode = opts['--permission-mode'] || 'default'
  if (!['plan', 'default'].includes(permissionMode)) return bypass('task-rw', `permission-mode ${permissionMode}`)
  if (!opts['--tools']) return bypass('task-rw', '没有 --tools 限定（默认全工具，含 Edit / Write）')
  const tools = opts['--tools'].split(',').map((t) => t.trim()).filter(Boolean)
  const writable = tools.filter((t) => !READONLY_TOOLS.has(t))
  if (writable.length) return bypass('task-rw', `工具面含 ${writable.join(',')}`)
  if (tools.includes('Bash')) {
    const rules = String(opts['--allowedTools'] || opts['--allowed-tools'] || '').split(',').filter((r) => r.trim())
    if (!rules.length) return bypass('task-rw', 'Bash 没有只读白名单')
    const odd = rules.filter((r) => !isReadOnlyBashRule(r))
    if (odd.length) return bypass('task-rw', `Bash 白名单含非只读命令 ${odd.join(',').slice(0, 120)}`)
  }
  const format = opts['--output-format']
  if (!['json', 'stream-json'].includes(format)) return bypass('other', `输出格式 ${format || 'text'}（拿不到 result 事件判成败）`)
  if (positional.length !== 1) return bypass('other', `位置参数 ${positional.length} 个（预期只有 prompt）`)
  const sessionPersisted = !opts['--no-session-persistence']
  const hasSchema = Boolean(opts['--json-schema'])
  let kind = null
  if (permissionMode === 'plan' && tools.join(',') === 'Read' && hasSchema && format === 'json') kind = 'intent'
  else if (hasSchema && format === 'json' && tools.includes('Bash')) kind = 'triage'
  else if (hasSchema && format === 'stream-json') kind = 'analysis'
  else if (!hasSchema && format === 'stream-json' && /结果文件路径：/.test(positional[0])) kind = 'task-ro'
  if (!kind) return bypass('other', '只读但认不出是哪类调用')
  return { cacheable: true, kind, reason: 'readonly', sessionPersisted, prompt: positional[0] }
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

// 规范化器：从这次调用的输入里收集「易变值 → 占位符」，同一张表用来规范化输出（落盘）与反规范化（命中时换成这次的值）。
// 易变值：SIM_DIR（含各 sim 的 repos/falive-react、.lark-hotfix 临时 worktree、runtime 目录；原样与 realpath 两种写法，以及 claude 项目目录编码）、
// 网关端口（127.0.0.1:<port> / localhost:<port>）、临时目录下 mkdtemp 出来的随机目录（<前缀>-XXXXXX，按首次出现编号）。时间戳不动。
export const createNormalizer = ({ simDir = process.env.SIM_DIR || null, port = process.env.LARK_GATEWAY_PORT || null } = {}) => {
  const pairs = [] // [value, placeholder]，长的先换
  const add = (value, placeholder) => {
    if (value && !pairs.some(([v]) => v === value)) pairs.push([value, placeholder])
  }
  if (simDir) {
    const abs = resolve(simDir)
    const real = realpathOr(abs)
    add(abs, '<<SIM_DIR>>')
    add(real, '<<SIM_DIR>>')
    add(encodeProjectDir(real), '<<SIM_DIR_ENC>>')
    add(encodeProjectDir(abs), '<<SIM_DIR_ENC>>')
  }
  if (port) {
    add(`127.0.0.1:${port}`, '127.0.0.1:<<PORT>>')
    add(`localhost:${port}`, 'localhost:<<PORT>>')
  }
  const tmpRoots = [...new Set([tmpdir(), realpathOr(tmpdir()), '/tmp', '/private/tmp'].map((p) => p.replace(/\/+$/, '')))]
  const tmpRe = new RegExp(`(?:${tmpRoots.map(escapeRe).join('|')})/[A-Za-z][A-Za-z0-9_.]*(?:-[A-Za-z0-9_.]+)*-[A-Za-z0-9]{6}(?![A-Za-z0-9_.-])`, 'g')
  let tmpCount = 0
  // 收集：在原始输入上找临时目录（只在输入里出现过的才进表，输出里的同值随之替换）。
  const collect = (text) => {
    for (const match of String(text).matchAll(tmpRe)) {
      if (!pairs.some(([v]) => v === match[0])) add(match[0], `<<TMP${(tmpCount += 1)}>>`)
    }
  }
  const ordered = () => [...pairs].sort((a, b) => b[0].length - a[0].length)
  const normalize = (text) => {
    let out = String(text)
    for (const [value, placeholder] of ordered()) out = out.split(value).join(placeholder)
    return out
  }
  // 反规范化：占位符 → 这次的值（SIM_DIR 取原样写法；同一占位符多个值时取先登记的）。
  const denormalize = (text) => {
    let out = String(text)
    const seen = new Set()
    for (const [value, placeholder] of pairs) {
      if (seen.has(placeholder)) continue
      seen.add(placeholder)
      out = out.split(placeholder).join(value)
    }
    return out
  }
  return { collect, normalize, denormalize, pairs }
}

// —— 引用文件：prompt / argv 里出现的绝对路径，存在的文件取内容 hash（附件截图、预取的 Lark 文档 / Figma 规格），键随内容变 ——
const PATH_RE = /\/[^\s"'`<>()[\]{},;，。；：、！？“”‘’（）【】|*]+/g
const MAX_HASH_BYTES = 200 * 1024 * 1024
const hashFile = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
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

// cwd 的仓库状态：HEAD + status + diff（triage / analysis / 只读任务在业务仓里读代码、跑 git log，仓库变了输出就该变）。intent 在 lark-bot 仓根只读附件，不进键。
const gitState = (cwd) => {
  const run = (args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 })
  const head = run(['rev-parse', 'HEAD'])
  if (head.status !== 0) return null
  const h = (buf) => createHash('sha256').update(buf || '').digest('hex')
  return { head: head.stdout.toString().trim(), status: h(run(['status', '--porcelain=v1']).stdout), diff: h(run(['diff', 'HEAD']).stdout) }
}

// 规则版本行（lib/lark-worker-prompts.mjs「规则指纹 / 规则来源版本」）：fingerprint = hash(~/.ai-rules 与 lark-bot 的 git 短 sha + 各规则章节内容)，
// 只是给审计还原用的版本号。lark-bot 工作区每次提交都会变（11-03 实测两轮之间 4bc630d → ee82c9c，prompt 其余逐字相同），不剔就每提交一次全部 miss。
// 只在算键时剔（单向，不进落盘的 stdout）；规则正文本身在 prompt 里照常进键，claude 自动加载、提示里剔掉的那部分（~/.claude/CLAUDE.md →
// ~/.ai-rules/AGENT.md；业务仓 CLAUDE.md 随仓库 git 状态进键）另取文件内容进键。
const RULE_VERSION_RE = /规则指纹：[0-9a-f]{8,64}|(~\/\.ai-rules|lark-bot)@[0-9a-f]{7,40}\b/g
const stripRuleVersions = (text) => text.replace(RULE_VERSION_RE, (match, repo) => (repo ? `${repo}@<<REV>>` : '规则指纹：<<RULES_FP>>'))
const autoLoadedRulesState = () => [join(claudeHome(), 'CLAUDE.md'), join(homedir(), '.ai-rules', 'AGENT.md')]
  .map((path) => [path, existsSync(path) ? hashFile(realpathOr(path)) : null])

export const computeCacheKey = ({ argv, stdinText = '', cwd = process.cwd(), kind, normalizer, simDir = process.env.SIM_DIR || null }) => {
  for (const text of [...argv, stdinText]) normalizer.collect(text)
  const normalizedArgv = argv.map((a) => stripRuleVersions(normalizer.normalize(a)))
  const material = {
    v: CACHE_VERSION,
    argv: normalizedArgv,
    stdin: stripRuleVersions(normalizer.normalize(stdinText)),
    rules: argv.some((a) => a.includes('规则指纹：')) ? autoLoadedRulesState() : null,
    cwd: normalizer.normalize(realpathOr(cwd)),
    files: referencedFiles([...argv, stdinText], normalizer, { simDir }),
    repo: kind === 'intent' ? null : gitState(cwd),
  }
  return { key: createHash('sha256').update(JSON.stringify(material)).digest('hex'), material, normalizedArgv }
}

// —— 输出判成败 ——
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

const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
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

// —— 真 claude ——
const selfPaths = new Set([join(here, 'claude'), join(here, 'claude-cache.mjs')].map(realpathOr))
export const resolveRealClaude = (env = process.env) => {
  if (env.SIM_REAL_CLAUDE && !selfPaths.has(realpathOr(env.SIM_REAL_CLAUDE))) return env.SIM_REAL_CLAUDE
  for (const dir of String(env.PATH || '').split(':').filter(Boolean)) {
    const candidate = join(dir, 'claude')
    if (existsSync(candidate) && !selfPaths.has(realpathOr(candidate))) return candidate
  }
  throw new Error('找不到真 claude（设 SIM_REAL_CLAUDE）')
}

// —— 日志 ——
const logLine = ({ outcome, kind, key, ms, note = '' }) => {
  const simDir = process.env.SIM_DIR
  const target = simDir ? join(simDir, 'ai-cache.log') : join(cacheRoot(), 'ai-cache.log')
  try {
    mkdirSync(dirname(target), { recursive: true })
    appendFileSync(target, `${new Date().toISOString()} ${outcome} ${kind} ${key ? key.slice(0, 12) : '-'} ${ms}ms${note ? ` ${note.replace(/\s+/g, ' ').slice(0, 160)}` : ''}\n`)
  } catch {
    // 日志失败不影响调用
  }
}

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

// 直通：真 claude 接管 stdio，退出码原样。
const passThrough = async ({ argv, kind, key = null, note, stdin }) => {
  const started = Date.now()
  const real = resolveRealClaude()
  // ignore = 没读过 stdin，真 claude 直接继承；pipe = 已整段读完；unknown = 读了一部分没等到 EOF，已读的先写、剩下的接着管道过去。
  const useStdin = stdin?.mode === 'pipe' || stdin?.mode === 'unknown' ? 'pipe' : 'inherit'
  const child = spawn(real, argv, { stdio: [useStdin, 'inherit', 'inherit'], env: { ...process.env, SIM_CLAUDE_CACHE_INNER: '1' } })
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
      process.stderr.write(`[claude-cache] 起真 claude 失败：${error.message}\n`)
      resolveExit(127)
    })
    child.on('exit', (exitCode, signal) => resolveExit(exitCode ?? (signal ? 128 + 15 : 1)))
  })
  if (kind !== 'version') logLine({ outcome: 'bypass', kind, key, ms: Date.now() - started, note })
  process.exitCode = code
}

const writeEntry = (dir, name, content) => writeFileSync(join(dir, name), content, { mode: 0o600 })

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
  const normalizer = createNormalizer()
  const { key, material, normalizedArgv } = computeCacheKey({ argv, stdinText: stdin.text, kind: verdict.kind, normalizer })
  const entryDir = join(cacheRoot(), key)
  const cwd = process.cwd()
  const { opts } = parseClaudeArgv(argv)
  const format = opts['--output-format']
  const resultPathRaw = verdict.kind === 'task-ro' ? [...verdict.prompt.matchAll(/结果文件路径：(\S+)/g)].at(-1)?.[1] || null : null

  // —— 命中 ——
  if (existsSync(join(entryDir, 'meta.json'))) {
    try {
      const meta = JSON.parse(readFileSync(join(entryDir, 'meta.json'), 'utf8'))
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
      logLine({ outcome: 'hit', kind: verdict.kind, key, ms: Date.now() - started, note: `原耗时 ${meta.durationMs}ms` })
      process.stdout.write(stdout)
      if (stderr) process.stderr.write(stderr)
      process.exitCode = meta.exitCode ?? 0
      return
    } catch (error) {
      process.stderr.write(`[claude-cache] 缓存条目坏了，改真调：${error.message}\n`)
    }
  }

  // —— 未命中：真调并透传 ——
  const real = resolveRealClaude()
  const child = spawn(real, argv, { stdio: [stdin.mode === 'pipe' ? 'pipe' : 'inherit', 'pipe', 'pipe'], env: { ...process.env, SIM_CLAUDE_CACHE_INNER: '1' } })
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
      process.stderr.write(`[claude-cache] 起真 claude 失败：${error.message}\n`)
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
  const skip = (why) => logLine({ outcome: 'miss', kind: verdict.kind, key, ms: durationMs, note: `不落盘：${why}` })
  if (exitCode !== 0) return skip(`退出 ${exitCode}${signal ? ` ${signal}` : ''}`)
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
      sim: process.env.SIM_DIR ? basename(process.env.SIM_DIR) : null,
      cwd: material.cwd,
      repo: material.repo,
      files: material.files,
      exitCode,
      durationMs,
      resultPathNorm: resultPathRaw ? normalizer.normalize(resultPathRaw) : null,
      sessionId,
      placeholders: normalizer.pairs.map(([, placeholder]) => placeholder),
    }, null, 2))
    mkdirSync(dirname(entryDir), { recursive: true })
    renameSync(tmpDir, entryDir)
    logLine({ outcome: 'miss', kind: verdict.kind, key, ms: durationMs, note: '已落盘' })
  } catch (error) {
    rmSync(tmpDir, { recursive: true, force: true })
    logLine({ outcome: 'miss', kind: verdict.kind, key, ms: durationMs, note: `落盘失败：${error.message}` })
  }
}

if (process.argv[1] && realpathOr(process.argv[1]) === realpathOr(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`[claude-cache] ${error?.stack || error}\n`)
    process.exitCode = 1
  })
}
