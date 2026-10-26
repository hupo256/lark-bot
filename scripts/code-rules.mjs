#!/usr/bin/env node
// 同步副本：来源 ~/.ai-rules/skills/prd-to-commit/scripts/code-rules.mjs（~/.ai-rules@e85e276），除这两行外与权威版本逐字一致。
// 不要在本仓直接改：先改权威版本并提交，再整文件复制到这里、更新上一行的 sha，跑 __tests__/lark-pure.test.mjs。
// 独立代码规则扫描：只扫本次改动，只报 error 级、只看代码与 diff 就能判定、误报低的规则。零依赖，单文件。
// 规则从 docs_tdd 冻结引擎的 verify-code-rules.mjs 抽出，规则 ID 与 message 原意不变，便于追溯。
// - 改动范围与 check.mjs 同口径：merge-base(HEAD, base) 到工作区（含暂存区）+ untracked；--files 显式指定时只看这些文件
// - base 解析不到时降级为 HEAD 到工作区（只剩工作区 + 暂存区 + untracked），JSON 里 baseResolved=false
// - 行级规则只看新增/修改行；文件级规则（300 行）只拦新建或本次新超出的 .tsx，存量超限不归本次
// - 豁免只有一种：该行或上一行写 `// code-rules-ignore <RULE-ID>: <理由>`（JSX 里写 {/* ... */}、.env 里写 #），缺理由不豁免
// - legacy-admin（Vue2/JS）不扫：没有 token/TS 体系，规则不适用
// 丢弃的旧规则：warn-first（ARCH-002/003、COPY-001、MAPPER-002、MOCK-003/006、NAMING-001、QUERY-001/002、STYLE-003）；
// 依赖项目文档（DOC-REUSE-001、STYLE-003 的 visualFidelity）；Biome 已覆盖（TYPE-001 = noExplicitAny）；
// 命中量大、规则本身只是「优先用 token」（STYLE-002 硬编码色，近 3 个月 810 处命中）。
// usage: code-rules.mjs [--json] [--base origin/online] [--files a,b,c] [--self-test]   （在仓库或 worktree 根目录运行）
// 退出码：0 无 error；1 有 error（--json 时 stdout 仍是完整 JSON）；2 工具自身失败（git 失败等）
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------- 文件分类（纯函数） ----------
export const isLegacy = (file) => /\/legacy-admin\//.test(file)
export const isSourceFile = (file) => /\.(js|jsx|ts|tsx)$/.test(file)
export const isTestOrFixtureFile = (file) => /\.(test|spec)\.tsx?$/.test(file) || /__fixtures__\//.test(file) || /\.(test|spec)-/.test(file)
// 纯数据文件（常量/i18n/locale/fixture/生成代码）：不算组件，不受 300 行上限约束
export const isDataFile = (file) => /(^|\/)(constants?|i18n|locales?|fixtures?|generated|__generated__)(\/|\.|$)/i.test(file) || /\.(gen|generated)\.tsx?$/.test(file)
// mock 脚手架：路径含 /mock(s)/ 或 /__mock(s)__/（含 MSW 的 src/mocks/），或 xxx.mock.ts / xxx.fixture.ts / mockXxx.ts
export const isMockFile = (file) => /(^|\/)(mocks?|__mocks?__)\//i.test(file) || /(^|\/)mock[A-Z]\w*\.tsx?$/.test(file) || /\.(mock|fixture)\.tsx?$/.test(file)
// mapper（反腐层）：basename 形如 mapXxx.ts 或路径含 mapper
export const isMapperFile = (file) => /(^|\/)map[A-Za-z0-9]*\.ts$/.test(file) || /mapper/i.test(file)
const isEnvFile = (file) => /^apps\/web\/config\/environments\/\.env/.test(file)
// 只有这些文件需要逐行 diff（.env 也要：CODE-MOCK-004 看新增的 flag 行）
const isTextTarget = (file) => /\.(js|jsx|ts|tsx|json|scss|less)$/.test(file) || isEnvFile(file)

// 剥掉行内注释与字符串，避免注释、字符串里的关键字触发规则；JSDoc/块注释续行整行剥掉
export function stripCommentsAndStrings(text) {
  if (/^\s*\*/.test(text)) return ''
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/g, '').replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '')
}
// 只剥注释、保留字符串（import 路径、parse 实参都在字符串里）
export function stripCommentsOnly(text) {
  if (/^\s*\*/.test(text)) return ''
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/g, '')
}

// ---------- 豁免 ----------
// 该行或上一行有 `code-rules-ignore <RULE-ID>: <理由>` 才豁免；理由剥掉 `*/`、`}` 等注释尾巴后必须非空
export function isIgnored(lines, lineNo, ruleId) {
  for (const text of [lines[lineNo - 1], lines[lineNo - 2]]) {
    const match = /code-rules-ignore\s+([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)\s*:(.*)$/.exec(text ?? '')
    if (match && match[1] === ruleId && match[2].replace(/\*\/|\}|-->/g, '').trim()) return true
  }
  return false
}

// ---------- 行级规则（纯函数：同 (file, text) 恒产出同结果，不碰 git/磁盘） ----------
// CODE-MOCK-005 的放行：MSW 基建入口（Providers 调 useMockWorker，只在 development + NEXT_PUBLIC_ENABLE_MSW 下生效，见 references/fameex.md）
const MSW_ENTRY_RE = /(^|\/)mocks\/useMockWorker$/
function mockImportPath(text) {
  const importPath = /from\s+['"]([^'"]+)['"]/.exec(stripCommentsOnly(text))?.[1] ?? ''
  const isMockPath = /(^|\/)(mocks?|__mocks?__)\//i.test(importPath) || /(^|\/)mock[A-Z]\w*$/.test(importPath) || /\.mock$/.test(importPath) || /mockapi$/i.test(importPath)
  return isMockPath && !MSW_ENTRY_RE.test(importPath) ? importPath : ''
}

// 返回 [[ruleId, message], ...]
export function lineRules(file, text) {
  const hits = []
  // CODE-ARCH-001：组件里直连 fetch；请求应收进 service/query 层。剥注释与字符串，`refetch(`/`prefetch(` 不命中
  if (/\.tsx$/.test(file) && /\bfetch\s*\(/.test(stripCommentsAndStrings(text))) {
    hits.push(['CODE-ARCH-001', 'Added component line calls fetch directly; move request logic to service/query layer.'])
  }
  // CODE-TYPE-002：`schema.parse(x) as T`（含 safeParse）。.parse() 静默剥离 schema 未声明字段、as 又蒙蔽 type，
  // 字段全程消失且编译无报错（PR-01685 根因）。放行 `as const`、`as unknown`（都不蒙蔽字段结构）与 `JSON.parse`
  if (isSourceFile(file) && /(?<!JSON)\.(?:safeParse|parse)\s*\(.*\)\s+as\s+(?!const\b|unknown\b)/.test(stripCommentsOnly(text))) {
    hits.push(['CODE-TYPE-002', '`schema.parse(x) as T` 组合：.parse() 会静默剥离 schema 未声明字段、as 又蒙蔽 type，字段将全程消失且编译无报错（PR-01685 根因）。删 as 让 type 从 schema 推导（z.infer），或补齐 schema 字段。'])
  }
  // CODE-E2E-001：monorepo 不引入 Playwright/Puppeteer 依赖（浏览器验证走系统 Chrome）
  if (/(^|\/)package\.json$/.test(file) && /"(playwright|playwright-core|puppeteer)"/.test(text)) {
    hits.push(['CODE-E2E-001', 'Do not add Playwright/Puppeteer dependencies to the monorepo; use MCP/system Chrome workflow.'])
  }
  // CODE-MOCK-004：env 新增 mock 开关（设 false 也不行，防静默重启用）。旧版全量扫 env，这里只看本次新增行，存量残留不归本次
  const flag = isEnvFile(file) && /^\s*(?:#\s*)?(NEXT_PUBLIC_\w*USE_MOCK)\s*=/.exec(text)
  if (flag) {
    hits.push(['CODE-MOCK-004', `env 新增 mock 开关 \`${flag[1]}\`；mock 拆除时该删掉 flag（设 false 也不行，防静默重启用）。本地 mock 走 MSW（NEXT_PUBLIC_ENABLE_MSW），业务代码不写 mock 分支。`])
  }
  // CODE-MOCK-005：非测试生产代码 import mock 脚手架 = mock 泄漏进生产路径。旧版全量 git grep，这里只看本次新增的 import 行
  if (/^(apps\/web\/src|packages)\//.test(file) && isSourceFile(file) && !isMockFile(file) && !isTestOrFixtureFile(file)) {
    const importPath = mockImportPath(text)
    if (importPath) {
      hits.push(['CODE-MOCK-005', `非测试生产代码 import mock 脚手架（\`${importPath}\`）：mock 已泄漏进生产路径。真实接口就绪应删此 import 与对应 mock 分支；未就绪时 mock 只放 src/mocks/<功能>/ 的 MSW handler，不在业务文件里直接引 mock。`])
    }
  }
  return hits
}

// CODE-MAPPER-001：mapper 中多个语义字段兜底到同一契约字段（`a: dto.a ?? dto.x` + `b: dto.b ?? dto.x`），
// 通常是 mock 臆造字段或契约缺口。返回 [{ line, message }]
export function mapperRules(file, added) {
  if (!isMapperFile(file)) return []
  const sources = new Map()
  const sourceRe = /(?:\?\?|\|\|)\s*([a-z_$][\w$]*)\??\.(\w+)\b/gi
  for (const { line, text } of added) {
    const outMatch = /^\s*(\w+):/.exec(text)
    if (!outMatch || /\/\/\s*API:/.test(text) || /@mock-only/.test(text)) continue
    for (const match of text.matchAll(sourceRe)) {
      const key = `${match[1]}.${match[2]}`
      const entries = sources.get(key) ?? []
      if (!entries.some((entry) => entry.outKey === outMatch[1])) entries.push({ outKey: outMatch[1], line })
      sources.set(key, entries)
    }
  }
  return [...sources].filter(([, entries]) => entries.length >= 2).map(([key, entries]) => ({
    line: entries[0].line,
    message: `mapper 中多个语义字段（${entries.map((entry) => `\`${entry.outKey}\``).join(', ')}）兜底到同一契约字段 \`${key}\`；这通常是 mock 臆造字段或契约缺口。请删除/合并字段，或补 API 契约后再映射。`,
  }))
}

// ---------- 文件级规则 ----------
export function countLines(content) {
  if (!content) return 0
  const lines = content.split(/\r?\n/).length
  return /\r?\n$/.test(content) ? lines - 1 : lines
}
// CODE-FILE-001：超 300 行且 base 不超（新建 / 本次新超出）才算 error；base 本来就超的存量不归本次（旧版是 warn，这里不报）
export const isNewlyOversized = (currentLines, baseLines) => currentLines > 300 && baseLines <= 300

// 单文件扫描（纯函数）：content=当前内容，added=[{line,text}] 新增/修改行，baseContent=base 版本（不存在为 ''），changed=相对 base 有改动
export function scanFile({ file, content, added, baseContent, changed }) {
  const findings = []
  const lines = content.split('\n')
  const add = (ruleId, line, message) => {
    if (!isIgnored(lines, line, ruleId)) findings.push({ severity: 'error', ruleId, file, line, message })
  }
  if (/\.tsx$/.test(file) && !isTestOrFixtureFile(file) && !isDataFile(file)) {
    const current = countLines(content)
    const base = countLines(baseContent)
    if (isNewlyOversized(current, base)) add('CODE-FILE-001', 1, `.tsx file has ${current} lines (base=${base || 'new'}); new or newly oversized TSX files must stay within 300 lines.`)
  }
  // CODE-STYLE-001：apps/web 新增或修改 .scss/.less（一次性页面样式用 Tailwind/token）
  if (changed && /\.(scss|less)$/.test(file) && file.startsWith('apps/web/src/')) {
    add('CODE-STYLE-001', 1, 'Changed apps/web source adds or modifies .scss/.less; use Tailwind/token rules instead.')
  }
  for (const { line, text } of added) for (const [ruleId, message] of lineRules(file, text)) add(ruleId, line, message)
  for (const { line, message } of mapperRules(file, added)) add('CODE-MAPPER-001', line, message)
  return findings
}

// ---------- git 读取（只读） ----------
// -U0 diff 解析：第一个 hunk 之前是文件头（+++/---）；hunk 内只有 +/- 行和 `\ No newline` 标记（不占行号）
export function parseAddedLines(diff) {
  const added = []
  let newLine = 0
  let inHunk = false
  for (const line of diff.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      newLine = Number(hunk[1])
      inHunk = true
    } else if (inHunk && line.startsWith('+')) added.push({ line: newLine++ || 1, text: line.slice(1) })
  }
  return added
}

function run({ base, files }) {
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' })
  if (top.status !== 0) throw new Error(`not a git repository: ${top.stderr.trim()}`)
  const root = top.stdout.trim()
  const git = (gitArgs, { allowFailure = false } = {}) => {
    const result = spawnSync('git', ['-c', 'core.quotePath=false', ...gitArgs], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    if (result.status !== 0 && !allowFailure) throw new Error(`git ${gitArgs.join(' ')} failed: ${result.stderr.trim()}`)
    return result.status === 0 ? result.stdout : null
  }
  const split = (value) => (value ?? '').split('\n').map((line) => line.trim()).filter(Boolean)

  // base 解析：base 可解析且有 merge-base 才算 resolved；否则降级到 HEAD
  let diffBase = 'HEAD'
  let baseResolved = false
  if (git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`], { allowFailure: true }) !== null) {
    const mergeBase = git(['merge-base', 'HEAD', base], { allowFailure: true })
    if (mergeBase) {
      diffBase = mergeBase.trim()
      baseResolved = true
    }
  }
  const untracked = new Set(split(git(['ls-files', '--others', '--exclude-standard'])))
  const candidates = files
    ? files.map((file) => relative(root, resolve(realpathSync(process.cwd()), file))).filter((file) => file && !file.startsWith('..'))
    : [...split(git(['diff', '--name-only', '--diff-filter=ACMR', diffBase])), ...untracked]
  const changedFiles = [...new Set(candidates)]
    .filter((file) => (file.startsWith('apps/') || file.startsWith('packages/') || file === 'package.json') && !isLegacy(file))
    .filter((file) => existsSync(resolve(root, file)) && statSync(resolve(root, file)).isFile())
    .sort()

  // 新路径 → 旧路径：移动/改名的文件按旧路径比对，否则整份被当成新增
  const renames = new Map(split(git(['diff', '--name-status', '-M', diffBase]))
    .filter((line) => line.startsWith('R')).map((line) => line.split('\t')).map(([, from, to]) => [to, from]))
  const findings = []
  for (const file of changedFiles) {
    const content = readFileSync(resolve(root, file), 'utf8')
    const isNew = untracked.has(file)
    const from = renames.get(file)
    const diffPaths = from ? ['-M', diffBase, '--', from, file] : [diffBase, '--', file]
    const diff = isNew || !isTextTarget(file) ? '' : git(['diff', '-U0', '--no-ext-diff', ...diffPaths])
    const added = !isTextTarget(file) ? [] : isNew ? content.split('\n').map((text, index) => ({ line: index + 1, text })) : parseAddedLines(diff)
    // base 版本只有 300 行规则要用
    const baseContent = isNew || !/\.tsx$/.test(file) ? '' : (git(['show', `${diffBase}:${from ?? file}`], { allowFailure: true }) ?? '')
    findings.push(...scanFile({ file, content, added, baseContent, changed: isNew || diff.trim() !== '' }))
  }
  return { ok: findings.length === 0, base, baseResolved, changedFiles, findings }
}

// ---------- 自测：每条保留规则至少一正一反，外加豁免与 300 行三种情况 ----------
function selfTest() {
  const failures = []
  let cases = 0
  const eq = (label, actual, expected) => {
    cases += 1
    if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
  const ids = (file, text) => lineRules(file, text).map(([ruleId]) => ruleId)
  const scan = (file, content, opts = {}) => scanFile({
    file,
    content,
    added: opts.added ?? content.split('\n').map((text, index) => ({ line: index + 1, text })),
    baseContent: opts.baseContent ?? '',
    changed: opts.changed ?? true,
  }).map((finding) => `${finding.ruleId}@${finding.line}`)
  const tsx = (count) => Array.from({ length: count }, (_, index) => `const a${index} = ${index}`).join('\n')

  eq('ARCH-001 pos', ids('a.tsx', 'const r = fetch("/x")'), ['CODE-ARCH-001'])
  eq('ARCH-001 neg ts', ids('a.ts', 'const r = fetch("/x")'), [])
  eq('ARCH-001 neg refetch', ids('a.tsx', 'refetch()'), [])
  eq('ARCH-001 neg comment', ids('a.tsx', 'const n = 1 // fetch(url) later'), [])
  eq('TYPE-002 pos', ids('a.ts', 'const v = userSchema.parse(x) as User'), ['CODE-TYPE-002'])
  eq('TYPE-002 pos safeParse', ids('a.ts', 'const v = s.safeParse(toCamel(data)) as R'), ['CODE-TYPE-002'])
  eq('TYPE-002 neg plain', ids('a.ts', 'const v = userSchema.parse(x)'), [])
  eq('TYPE-002 neg as const', ids('a.ts', 'const v = schema.parse(x) as const'), [])
  eq('TYPE-002 neg as unknown', ids('a.ts', 'const v = Yaml.parse(src) as unknown'), [])
  eq('TYPE-002 neg JSON', ids('a.ts', 'const v = JSON.parse(x) as User'), [])
  eq('E2E-001 pos', ids('package.json', '    "playwright": "^1.0.0",'), ['CODE-E2E-001'])
  eq('E2E-001 pos app', ids('apps/web/package.json', '    "puppeteer": "^22.0.0",'), ['CODE-E2E-001'])
  eq('E2E-001 neg', ids('package.json', '    "playnice": "^1.0.0",'), [])
  eq('MOCK-004 pos', ids('apps/web/config/environments/.env.dev', 'NEXT_PUBLIC_LAUNCHPOOL_USE_MOCK=false'), ['CODE-MOCK-004'])
  eq('MOCK-004 pos commented', ids('apps/web/config/environments/.env.dev', '# NEXT_PUBLIC_USE_MOCK=true'), ['CODE-MOCK-004'])
  eq('MOCK-004 neg msw switch', ids('apps/web/config/environments/.env.dev', 'NEXT_PUBLIC_ENABLE_MSW=false'), [])
  eq('MOCK-004 neg other file', ids('apps/web/src/a.ts', 'NEXT_PUBLIC_USE_MOCK=true'), [])
  eq('MOCK-005 pos handler', ids('apps/web/src/apps/Pool/index.tsx', "import { poolFixture } from '@/mocks/pool/fixtures'"), ['CODE-MOCK-005'])
  eq('MOCK-005 pos mockApi', ids('packages/ui/src/a.ts', "import { list } from './mockApi'"), ['CODE-MOCK-005'])
  eq('MOCK-005 neg msw entry', ids('apps/web/src/app/[lang]/Providers.tsx', "import { useMockWorker } from '@/mocks/useMockWorker'"), [])
  eq('MOCK-005 neg mock file', ids('apps/web/src/mocks/handlers.ts', "import { poolHandlers } from './pool/handlers'"), [])
  eq('MOCK-005 neg test', ids('apps/web/src/apps/Pool/a.test.ts', "import { f } from '@/mocks/pool/fixtures'"), [])
  eq('MOCK-005 neg package name', ids('apps/web/src/utils/a.ts', "import { generateMock } from '@anatine/zod-mock'"), [])
  eq('MOCK-005 neg admin scope', ids('apps/admin/src/apps/a.ts', "import { x } from '@/mocks/x'"), [])
  eq('MAPPER-001 pos', scan('apps/web/src/services/mapUser.ts', 'createdAt: dto.createdAt ?? dto.displayTime,\nfilledAt: dto.filledAt ?? dto.displayTime,'), ['CODE-MAPPER-001@1'])
  eq('MAPPER-001 neg distinct', scan('apps/web/src/services/mapUser.ts', 'createdAt: dto.createdAt ?? dto.createdTime,\nfilledAt: dto.filledAt ?? dto.filledTime,'), [])
  eq('MAPPER-001 neg not mapper', scan('apps/web/src/services/user.ts', 'a: d.a ?? d.x,\nb: d.b ?? d.x,'), [])
  eq('STYLE-001 pos', scan('apps/web/src/apps/A/a.module.scss', '.a { color: red; }'), ['CODE-STYLE-001@1'])
  eq('STYLE-001 neg unchanged', scan('apps/web/src/apps/A/a.module.scss', '.a {}', { added: [], changed: false }), [])
  eq('STYLE-001 neg admin', scan('apps/admin/src/a.scss', '.a {}'), [])
  // 300 行三种情况：新建超限 → error；本次新超出 → error；存量超限 → 不报；另加未超限与豁免对象
  eq('FILE-001 new oversized', scan('apps/web/src/apps/A/Big.tsx', tsx(301)), ['CODE-FILE-001@1'])
  eq('FILE-001 newly oversized', scan('apps/web/src/apps/A/Big.tsx', tsx(305), { added: [], baseContent: tsx(299) }), ['CODE-FILE-001@1'])
  eq('FILE-001 legacy oversized', scan('apps/web/src/apps/A/Big.tsx', tsx(990), { added: [], baseContent: tsx(975) }), [])
  eq('FILE-001 under limit', scan('apps/web/src/apps/A/Big.tsx', tsx(300)), [])
  eq('FILE-001 data file', scan('apps/web/src/constants/big.tsx', tsx(400)), [])
  eq('FILE-001 test file', scan('apps/web/src/apps/A/Big.test.tsx', tsx(400)), [])
  eq('countLines trailing newline', countLines('a\nb\n'), 2)
  // 豁免：同行 / 上一行 / JSX 注释生效；缺理由、规则 ID 不符不生效
  eq('ignore same line', scan('apps/web/src/a.tsx', 'fetch(url) // code-rules-ignore CODE-ARCH-001: 下载海报 blob'), [])
  eq('ignore prev line', scan('apps/web/src/a.tsx', '// code-rules-ignore CODE-ARCH-001: 下载海报 blob\nfetch(url)'), [])
  eq('ignore jsx comment', scan('apps/web/src/a.tsx', '{/* code-rules-ignore CODE-ARCH-001: 下载海报 */}\nfetch(url)'), [])
  eq('ignore file-level line 1', scan('apps/web/src/apps/A/Big.tsx', `// code-rules-ignore CODE-FILE-001: 生成的路由表\n${tsx(300)}`), [])
  eq('ignore missing reason', scan('apps/web/src/a.tsx', '// code-rules-ignore CODE-ARCH-001:\nfetch(url)'), ['CODE-ARCH-001@2'])
  eq('ignore jsx missing reason', scan('apps/web/src/a.tsx', '{/* code-rules-ignore CODE-ARCH-001: */}\nfetch(url)'), ['CODE-ARCH-001@2'])
  eq('ignore wrong rule', scan('apps/web/src/a.tsx', '// code-rules-ignore CODE-TYPE-002: x\nfetch(url)'), ['CODE-ARCH-001@2'])
  eq('ignore two lines up', scan('apps/web/src/a.tsx', '// code-rules-ignore CODE-ARCH-001: x\nconst a = 1\nfetch(url)'), ['CODE-ARCH-001@3'])
  eq('parseAddedLines', parseAddedLines('--- a/f\n+++ b/f\n@@ -1,0 +2,2 @@\n+a\n++b\n@@ -9 +11 @@\n-x\n\\ No newline at end of file\n+y'), [{ line: 2, text: 'a' }, { line: 3, text: '+b' }, { line: 11, text: 'y' }])

  if (failures.length) {
    console.error(`code-rules self-test FAILED (${failures.length}/${cases}):\n  ${failures.join('\n  ')}`)
    return 1
  }
  console.log(`code-rules self-test passed (${cases} cases).`)
  return 0
}

// ---------- CLI ----------
function main() {
  const args = process.argv.slice(2)
  const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
  if (args.includes('--self-test')) process.exit(selfTest())
  const base = option('--base') ?? 'origin/online'
  const files = option('--files')?.split(',').map((file) => file.trim()).filter(Boolean)
  let result
  try {
    result = run({ base, files })
  } catch (error) {
    console.error(`code-rules: tool failure: ${error.message}`)
    process.exit(2)
  }
  if (args.includes('--json')) console.log(JSON.stringify(result, null, 2))
  else {
    console.log(`code-rules: ${result.changedFiles.length} file(s), base=${base}${result.baseResolved ? '' : '（未解析，降级为只看工作区 + 暂存区改动）'}`)
    for (const finding of result.findings) console.log(`ERROR ${finding.ruleId} ${finding.file}:${finding.line} ${finding.message}`)
    if (result.ok) console.log('OK: no error findings.')
  }
  process.exit(result.ok ? 0 : 1)
}

// 被 import 时只导出纯函数，不跑 CLI（argv[1] 可能经软链，比较 realpath）
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main()
