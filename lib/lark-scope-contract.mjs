/**
 * Lark Worker 的修改范围契约层：分析阶段输出结构化 `scope`（targets + 同因搜索的 siblings），
 * 收尾时用实测改动核对它——越界、碰禁区、超行数、集合型任务没给兄弟清单，都不提交、降级人工复核。
 *
 * ## 为什么要有这层
 *
 * 从前修改边界只靠提示词约束（「只改复现并修复该 bug 所必需的文件」），代码层只有
 * crossCheckChangedFiles（AI 自报 vs 实测，不一致只挂 note）。两类历史事故都穿过了它：
 *
 *   1. **越界**（PR-01930）：bug 指的是「名称」列（API 直出），AI 却按关键词就近改了邻列的常量映射。
 *      done + 非空 diff，可信度评估识别不了「diff 打在无关字段」。
 *   2. **漏改**（PR-02273）：「统一改为 X，涉及申请/列表/流水」只改了截图可见的列头，同字段在详情 /
 *      搜索 / 建单的 label 全漏。
 *
 * 根因相同：边界是改完后才「解释」出来的，而不是改之前「声明」并可核对的。故把边界前移到只读分析阶段
 * 结构化输出，收尾用实测 diff 做子集判定（防越界），集合型任务强制给出同因搜索清单（防漏改）。
 * 事后让实施阶段再自报 scope 没有约束力，契约只认分析阶段那一份。
 *
 * 漏改无法靠子集判定发现（少改的文件不会出现在 diff 里），只能靠两件事兜：集合型任务 siblings 不得为空
 * （阻断），以及「声明纳入但实测没改」的兄弟位置（missingIncludedSiblings，提示不阻断——分析阶段可能
 * 多报，阻断会误伤）。
 *
 * 人工放行复用控制通道的「续跑」出口：核对不通过时 worker 以 waiting_confirmation 挂起并回写 scopeRequest，
 * 人回复「确认扩大范围」→ resolveScopeApproval 产出批准记录（task.scopeApprovals）→ 重跑时 applyScopeApprovals
 * 把它们并入契约、checkScopeContract 并入允许集合（禁区文件也须显式出现在批准里）。
 *
 * 全部纯函数、零 IO，可 `node --test` 直测；git diff / numstat 由调用方取好传入。
 */

import { isPrincipalAssigned, WORK_KINDS, WORK_KIND_LABELS } from './lark-work-policy.mjs'
import { taskLine } from './lark-worker-results.mjs'

// ---------------------------------------------------------------------------
// 路径归一化
// ---------------------------------------------------------------------------

// 仓库相对路径归一：去首尾空白、反斜杠转正斜杠、去 `./` 与空段。拒绝绝对路径、`..`、通配符与目录。
// 刻意**不**拒绝 `[]` / `()`：Next.js 路由目录（`app/[lang]/(dashboard)/…`）是合法的真实路径。
// 返回 { path } 或 { error }，不抛。纯函数便于单测。
export const normalizeRepoPath = (raw) => {
  if (typeof raw !== 'string') return { error: `路径不是字符串：${JSON.stringify(raw)}` }
  const input = raw.trim().replace(/\\/g, '/')
  if (!input) return { error: '路径为空' }
  if (input.startsWith('/') || input.startsWith('~') || /^[A-Za-z]:\//.test(input)) return { error: `绝对路径：${raw}` }
  if (input.includes('*')) return { error: `含通配符（须具体到文件）：${raw}` }
  if (input.endsWith('/')) return { error: `是目录而非文件：${raw}` }
  const segments = input.split('/').filter((segment) => segment && segment !== '.')
  if (segments.includes('..')) return { error: `含 .. 越出仓库：${raw}` }
  if (!segments.length) return { error: `路径为空：${raw}` }
  return { path: segments.join('/') }
}

// 实测改动路径（来自 git）只做宽松归一：git 不会给出绝对路径或 `..`，万一给了也保留原样，
// 让它在子集判定里自然落进 outOfScope（fail-closed），而不是被悄悄丢掉。
const normalizeActualPath = (raw) => normalizeRepoPath(raw).path || String(raw || '').trim()
const uniqueActualPaths = (list) => [...new Set((Array.isArray(list) ? list : []).map(normalizeActualPath).filter(Boolean))]

const cleanStrings = (list) =>
  [...new Set((Array.isArray(list) ? list : []).filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean))]
const cleanText = (value) => (typeof value === 'string' ? value.trim() : '')
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

// ---------------------------------------------------------------------------
// scope 归一化
// ---------------------------------------------------------------------------

/**
 * 校验并归一化分析阶段输出的 scope。坏数据（null、结构不对、任一路径非法、没有任何要改的文件）
 * 一律返回 `{ missing: true, reason }`：一个带 `../x` 或绝对路径的契约说明分析阶段已经出错，
 * 整份不可信，而不是剔掉坏项后假装其余可用。
 *
 * 归一规则：路径按 normalizeRepoPath 处理后去重；同一 target 重复声明时合并 symbols、保留首条 reason；
 * 同一 sibling 重复声明时 include 取「或」（只要有一处说要改就纳入）。已是归一结果（missing:false）
 * 再传入是幂等的；已是 `{ missing: true }` 原样返回，保住原因。
 */
export const normalizeScope = (raw) => {
  if (raw == null) return { missing: true, reason: '分析阶段未给出 scope' }
  if (!isPlainObject(raw)) return { missing: true, reason: 'scope 不是对象' }
  if (raw.missing === true) return { missing: true, reason: cleanText(raw.reason) || 'scope 缺失' }
  if (!Array.isArray(raw.targets)) return { missing: true, reason: 'scope.targets 不是数组' }
  if (raw.siblings != null && !isPlainObject(raw.siblings)) return { missing: true, reason: 'scope.siblings 不是对象' }
  const rawSiblingItems = raw.siblings?.items ?? []
  if (!Array.isArray(rawSiblingItems)) return { missing: true, reason: 'scope.siblings.items 不是数组' }

  const badPaths = []
  const targets = new Map()
  for (const item of raw.targets) {
    if (!isPlainObject(item)) {
      badPaths.push('targets 中有非对象项')
      continue
    }
    const { path, error } = normalizeRepoPath(item.path)
    if (error) {
      badPaths.push(error)
      continue
    }
    const existing = targets.get(path)
    if (existing) {
      existing.symbols = cleanStrings([...existing.symbols, ...(item.symbols || [])])
      if (!existing.reason) existing.reason = cleanText(item.reason)
    } else {
      targets.set(path, { path, symbols: cleanStrings(item.symbols), reason: cleanText(item.reason) })
    }
  }

  const siblingItems = new Map()
  for (const item of rawSiblingItems) {
    if (!isPlainObject(item)) {
      badPaths.push('siblings.items 中有非对象项')
      continue
    }
    const { path, error } = normalizeRepoPath(item.path)
    if (error) {
      badPaths.push(error)
      continue
    }
    const include = item.include === true
    const existing = siblingItems.get(path)
    if (existing) {
      existing.include = existing.include || include
      if (!existing.reason) existing.reason = cleanText(item.reason)
    } else {
      siblingItems.set(path, { path, include, reason: cleanText(item.reason) })
    }
  }

  if (badPaths.length) return { missing: true, reason: `scope 含非法路径：${[...new Set(badPaths)].join('；')}` }
  const items = [...siblingItems.values()]
  if (!targets.size && !items.some((item) => item.include)) {
    return { missing: true, reason: 'scope 没有声明任何要改的文件（targets 为空且无 include=true 的兄弟位置）' }
  }
  return {
    missing: false,
    targets: [...targets.values()],
    siblings: { searchQueries: cleanStrings(raw.siblings?.searchQueries), items },
  }
}

// 契约内显式声明要改的文件 = targets ∪ include=true 的 siblings。
const declaredPaths = (scope) => [
  ...scope.targets.map((target) => target.path),
  ...scope.siblings.items.filter((item) => item.include).map((item) => item.path),
]

// ---------------------------------------------------------------------------
// 集合型任务判定
// ---------------------------------------------------------------------------

// 集合型任务 cue 词表。lark-bot 里原本没有可复用的一份：lark-work-policy 的 MODIFY_INTENT_RE 虽含「统一」，
// 但它判的是「改已有东西 vs 造新东西」，口径不同；docs_tdd 冻结引擎里的 COLLECTION_WORDS 用 `\b` 包中文，
// 中文与中文之间没有 ASCII 词边界，实际匹配不到，且拆仓后不能再 import docs_tdd。
//
// 设计原则：量词必须带「分配」语义才算集合操作，光是名词里带量词不算。FameEX 里「全部订单 / 全部委托」
// 是 tab 名、「统一账户」「统一下单」是业务名词、「批量审核」是按钮名，这些都不能触发。
// 误判代价不对称但都不大：误判为集合型只是让分析阶段多做一次同因搜索；漏判则回到 PR-02273 的漏改。
const SMALL_COUNT = '(?:[2-9]|\\d{2,}|[两二三四五六七八九十几多])'
const DISTRIBUTIVE_QUANTIFIER = '(?:所有|每个|每一个|每一处|各个|各处|这些|那些)(?!人|用户|账号|账户|客户|会员)'
const SET_OPERATION_CUES = [
  // 「统一」须带动作：统一改 / 统一为 / 统一一下 / 保持统一。「统一账户」「统一下单」不算。
  { cue: '统一', re: /统一(?:一下|起来|地?(?:改|换|调|修|替换|成|为|处理|使用|用|显示|展示|去掉|删|加|补|对齐|规范))|保持统一|(?:都|要|需要)统一/ },
  // 「全部」常是 tab 名（全部订单），只认紧跟动作 / 都 / 的。
  { cue: '全部', re: /全部(?:都|的|改|换|替换|统一|调整|修改|去掉|删|加)/ },
  // 处置式「把所有 X 改成 Y」。
  { cue: '把所有…', re: new RegExp(`(?:把|将)\\s*${DISTRIBUTIVE_QUANTIFIER}`) },
  // 「所有 / 每个 … 都 / 一律 / 改成」：量词后同一分句内出现分配标记。主语是人（所有用户都看不到）是缺陷描述，不算。
  { cue: '所有…都', re: new RegExp(`${DISTRIBUTIVE_QUANTIFIER}[^。；;\\n]{0,24}?(?:都|均|一律|全都|一并|一起|改成|改为|换成|替换)`) },
  // 「全局搜索框」是组件名，只认全局 + 动作。
  { cue: '全局', re: /全局(?:替换|修改|统一|改|生效|调整|处理)/ },
  // 「批量修改按钮点了没反应」是按钮名，排除动作后紧跟控件名词的情况。
  { cue: '批量', re: /批量(?:替换|修改|改|调整|更新)(?![^。；;\n，,]{0,4}(?:按钮|弹窗|功能|页面?|入口|接口|操作))/ },
  { cue: '涉及 N 处', re: new RegExp(`涉及[^。；;\\n]{0,6}?${SMALL_COUNT}\\s*(?:个|处|页|块|项)`) },
  // 「涉及体验金申请/列表/流水」：涉及后跟并列枚举。
  { cue: '涉及 A/B/C', re: /涉及[^。；;\n]{1,40}?[、/／]/ },
  // 「多处 / 两处 / 3 处」；「此处 / 一处」是单点，「处理 / 处置 / 处罚」不是量词。
  { cue: 'N 处', re: new RegExp(`(?:${SMALL_COUNT}|各)\\s*处(?![理置罚分])`) },
  { cue: 'N 个页面', re: new RegExp(`${SMALL_COUNT}\\s*个\\s*(?:页面|地方|位置|入口|模块|组件|tab|标签页?|列表|弹窗)`, 'i') },
  // 「其它页面也要改」：显式点名本处之外还有同类位置。
  { cue: '其它…也', re: /(?:其他|其它|别的|另外的?)[^。；;\n]{0,12}(?:也|同样|一样)/ },
]

// 返回命中的第一个 cue 标签（用于卡片说明「为什么被判集合型」），未命中返回 null。纯函数便于单测。
export const detectSetOperationCue = (text) => {
  const input = String(text || '')
  return SET_OPERATION_CUES.find((item) => item.re.test(input))?.cue || null
}

export const isSetOperationTask = (text) => detectSetOperationCue(text) !== null

// ---------------------------------------------------------------------------
// 自动放行 / 禁区 / 行数口径
// ---------------------------------------------------------------------------

// markdown 文档（对接文档 / 功能总表 / 答复存档 / 对接状态总览）：不是范围契约要防的越界对象——契约防的是
// 「改错业务代码」（PR-01930 / PR-02273），文档同步是仓库约定里每次改动的收尾动作。故文档一律自动放行、
// 不计行数（答复原文动辄几百行）。例外：AI 工作规则文件（CLAUDE.md / AGENTS.md / AGENT.md / SKILL.md、
// `.cursor/` 下的 rules）改了会换 bot 自己的口径，仍须显式声明在契约里。
const DOC_FILE_RE = /\.(?:md|mdx)$/i
const RULE_DOC_RE = /(?:^|\/)(?:CLAUDE|AGENTS?|SKILL)\.md$|(?:^|\/)\.cursor\//i
export const isDocFile = (path) => DOC_FILE_RE.test(String(path || '')) && !RULE_DOC_RE.test(String(path || ''))
const DOC_AUTO_ALLOW_REASON = '文档（markdown），不受范围契约约束'

// locale 文件：`<root>/(locales|resources)/<lang>/<ns>.json`。fameex-web 的真实布局：
// apps/{web,admin,futures-admin,security-admin}/src/i18n/locales/<lang>/<ns>.json，
// apps/web-next/src/i18n/resources/<lang>/<ns>.json；lang 形如 zh-CN / en-US / id-ID。
const LOCALE_FILE_RE = /^(.*\/)?(locales|resources)\/([a-z]{2,3}(?:[-_][A-Za-z0-9]{2,4})?)\/(.+\.json)$/
const parseLocalePath = (path) => {
  const match = LOCALE_FILE_RE.exec(path)
  return match ? { root: `${match[1] || ''}${match[2]}`, lang: match[3], ns: match[4] } : null
}
const isLocaleJson = (path) => LOCALE_FILE_RE.test(path)

// 测试文件 ↔ 源文件：`x.test.ts` / `x.spec.tsx` / `__tests__/x.test.ts` 都对应同目录的 `x.<任意 js/ts 扩展名>`。
// 扩展名不要求一致：`useColumns.tsx` 的测试按约定是 `useColumns.test.ts`（不写 .tsx 测试）。
const SOURCE_FILE_RE = /^(.*?)\.[cm]?[jt]sx?$/
const TEST_FILE_RE = /^(.*?\/)?(?:__tests__\/)?([^/]+)\.(?:test|spec)\.[cm]?[jt]sx?$/
const isTestFile = (path) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) || /(?:^|\/)__tests__\//.test(path)
const testFileSourceStem = (path) => {
  const match = TEST_FILE_RE.exec(path)
  return match ? `${match[1] || ''}${match[2]}` : null
}

/**
 * 自动放行：不必在契约里逐个声明、但显然属于同一改动的文件。只从实测改动里挑，返回 `[{ path, reason }]`。
 * - 已声明 locale 文件同 root、同 namespace 的其它语言文件（改一个 key 要同步九种语言是常态）；
 * - 已声明源文件的同名测试文件（x.ts → x.test.ts / x.spec.ts / __tests__/x.test.ts）。
 * scope 缺失时返回 []。纯函数便于单测。
 */
export const autoAllowedPaths = (scope, actualFiles = []) => {
  const normalized = normalizeScope(scope)
  // 契约缺失时只放文档：复测 / 答复类任务「不改代码」常被分析阶段填成 scope=null，实施阶段却按约定同步了
  // 对接文档 / 功能总表 / 答复存档（lessons #33）——文档不是契约要防的越界对象，不该为它挂起整条任务。
  if (normalized.missing) {
    return uniqueActualPaths(actualFiles).filter(isDocFile).map((path) => ({ path, reason: DOC_AUTO_ALLOW_REASON }))
  }
  const declared = new Set(declaredPaths(normalized))
  const localeKeys = new Set()
  const sourceStems = new Set()
  for (const path of declared) {
    const locale = parseLocalePath(path)
    if (locale) localeKeys.add(`${locale.root}|${locale.ns}`)
    const source = SOURCE_FILE_RE.exec(path)
    if (source && !isTestFile(path)) sourceStems.add(source[1])
  }
  const allowed = []
  for (const path of uniqueActualPaths(actualFiles)) {
    if (declared.has(path)) continue
    const locale = parseLocalePath(path)
    if (locale && localeKeys.has(`${locale.root}|${locale.ns}`)) {
      allowed.push({ path, reason: `已声明 ${locale.ns} 的其它语言（${locale.lang}）` })
      continue
    }
    const stem = testFileSourceStem(path)
    if (stem && sourceStems.has(stem)) {
      allowed.push({ path, reason: '已声明源文件的同名测试' })
      continue
    }
    if (isDocFile(path)) allowed.push({ path, reason: DOC_AUTO_ALLOW_REASON })
  }
  return allowed
}

// lockfile 单列：既是禁区，也不计入行数（生成文件，行数没有意义）。
const LOCKFILE_RE = /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?)$/

// 禁区：即使写进 targets 也必须人工确认。这些文件影响整个 monorepo 的依赖、构建、类型和门禁，
// 一个缺陷修复几乎不可能正当地需要动它们；真需要时也该由人拍板，而不是 bot 无人值守地改完提交。
export const FORBIDDEN_PATH_RULES = [
  { re: /(?:^|\/)package\.json$/, reason: '依赖清单 package.json' },
  { re: LOCKFILE_RE, reason: '依赖锁文件' },
  { re: /(?:^|\/)biome\.jsonc?$/, reason: 'Biome 配置' },
  { re: /(?:^|\/)tsconfig[^/]*\.json$/, reason: 'TypeScript 配置' },
  { re: /(?:^|\/)turbo\.json$/, reason: 'Turborepo 配置' },
  { re: /^packages\/config\//, reason: '共享配置包 packages/config' },
  { re: /(?:^|\/)\.github\//, reason: 'CI 配置 .github' },
  { re: /(?:^|\/)\.husky\//, reason: 'Git 钩子 .husky' },
  // workspace 成员清单与 npm/pnpm 源配置：改了会让整个 monorepo 的依赖解析换口径，与 package.json 同级风险。
  { re: /(?:^|\/)pnpm-workspace\.yaml$/, reason: 'pnpm workspace 配置' },
  { re: /(?:^|\/)\.npmrc$/, reason: 'npm / pnpm 源配置 .npmrc' },
]

// 命中禁区返回原因，否则 null。纯函数便于单测。
export const matchForbiddenPath = (path) => {
  const input = normalizeActualPath(path)
  return FORBIDDEN_PATH_RULES.find((rule) => rule.re.test(input))?.reason || null
}

// 改动行数上限（added + deleted），按 workKind 的**取值**（如 qa_feedback）索引。其它种类不设上限。
export const DEFAULT_LINE_BUDGETS = Object.freeze({
  [WORK_KINDS.bugfix]: 120,
  [WORK_KINDS.qaFeedback]: 200,
  [WORK_KINDS.requirement]: 400,
})

/**
 * 解析某 workKind 的生效上限。budgets 覆盖默认值，键既可用取值（qa_feedback）也可用 WORK_KINDS 键名
 * （qaFeedback，计划文档与人手写配置的习惯写法）；覆盖为 null / 0 / 非数 = 不设上限。返回数字或 null。
 */
export const resolveLineBudget = (workKind, budgets = {}) => {
  const overrides = {}
  for (const [key, value] of Object.entries(isPlainObject(budgets) ? budgets : {})) {
    overrides[WORK_KINDS[key] || key] = value
  }
  const limit = { ...DEFAULT_LINE_BUDGETS, ...overrides }[workKind]
  return Number.isFinite(limit) && limit > 0 ? limit : null
}

// rename 记法还原成新路径：`src/{a => b}/x.ts` → `src/b/x.ts`，`old.ts => new.ts` → `new.ts`。
const resolveRenamedPath = (raw) => {
  const unquoted = raw.replace(/^"(.*)"$/, '$1')
  if (/\{[^{}]* => [^{}]*\}/.test(unquoted)) return unquoted.replace(/\{[^{}]* => ([^{}]*)\}/g, '$1').replace(/\/{2,}/g, '/')
  const arrow = unquoted.indexOf(' => ')
  return arrow >= 0 ? unquoted.slice(arrow + 4) : unquoted
}

/**
 * 解析 `git diff --numstat` 文本 → `[{ path, added, deleted, binary }]`。二进制文件（`-\t-\t`）记 0 行、
 * binary:true；rename 记法还原为新路径；无法识别的行跳过。纯函数便于单测。
 */
export const parseNumstat = (text) => {
  const entries = []
  for (const line of String(text || '').split('\n')) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.replace(/\r$/, ''))
    if (!match) continue
    const binary = match[1] === '-' || match[2] === '-'
    entries.push({
      path: normalizeActualPath(resolveRenamedPath(match[3])),
      added: binary ? 0 : Number(match[1]),
      deleted: binary ? 0 : Number(match[2]),
      binary,
    })
  }
  return entries
}

// 计入上限的行数：lockfile、locale json、markdown 文档不计（生成物 / 改一个 key 就是九种语言 × N 行 / 答复原文几百行）。
export const countBudgetLines = (entries = []) =>
  entries
    .filter((entry) => !LOCKFILE_RE.test(entry.path) && !isLocaleJson(entry.path) && !isDocFile(entry.path))
    .reduce((sum, entry) => sum + entry.added + entry.deleted, 0)

// ---------------------------------------------------------------------------
// 人工放行（确认扩大范围）
// ---------------------------------------------------------------------------

// 一条人工批准记录（持久化在 task.scopeApprovals）：`{ paths, allowOverBudget, waiveSiblings, approvedBy, at, note }`。
// 多次续跑的批准取并集；非法路径静默丢弃（批准来自群消息文本，不因一条手误让整份批准失效）。
const summarizeApprovals = (approvals) => {
  const list = (Array.isArray(approvals) ? approvals : []).filter(isPlainObject)
  const paths = []
  for (const approval of list) {
    for (const raw of Array.isArray(approval.paths) ? approval.paths : []) {
      const { path } = normalizeRepoPath(raw)
      if (path && !paths.includes(path)) paths.push(path)
    }
  }
  return {
    paths,
    allowOverBudget: list.some((approval) => approval.allowOverBudget === true),
    waiveSiblings: list.some((approval) => approval.waiveSiblings === true),
  }
}

// 已批准扩大的文件清单（去重、已归一），供分析提示注入「人工已确认的额外目标」。
export const approvedScopePaths = (approvals = []) => summarizeApprovals(approvals).paths

/**
 * 把人工批准的文件并入契约 targets（理由注明「人工确认扩大范围」），供实施提示与收尾核对共用同一份有效契约。
 * 原契约缺失但有批准时，以批准清单为全部 targets——人已逐个看过这些文件，比空契约更可信。
 * 无批准时原样返回。纯函数便于单测。
 */
export const applyScopeApprovals = (scope, approvals = []) => {
  const { paths } = summarizeApprovals(approvals)
  if (!paths.length) return scope
  const normalized = normalizeScope(scope)
  const base = normalized.missing ? { targets: [], siblings: { searchQueries: [], items: [] } } : normalized
  const declared = new Set(declaredPaths(base))
  return {
    targets: [
      ...base.targets,
      ...paths.filter((path) => !declared.has(path)).map((path) => ({ path, symbols: [], reason: '人工确认扩大范围' })),
    ],
    siblings: base.siblings,
  }
}

/**
 * 范围核对不通过时，worker 随 waiting_confirmation 回写给 gateway 的「待批准请求」（task.scopeRequest）。
 * 人回复确认后由 resolveScopeApproval 转成一条批准记录。missingScope 时没有越界清单可列，
 * 就把全部实测改动作为待批准对象——人确认即表示「这些改动我看过、可以提交」。
 */
export const buildScopeRequest = ({ check, actualChangedFiles = [], now = new Date().toISOString() } = {}) => {
  if (!check || check.ok) return null
  const paths = check.missingScope
    ? uniqueActualPaths(actualChangedFiles)
    : [...(check.outOfScope || []), ...(check.forbiddenTouched || []).map((item) => item.path)]
  return {
    paths: [...new Set(paths)].filter((path) => !normalizeRepoPath(path).error),
    overBudget: Boolean(check.overBudget),
    siblingsRequired: Boolean(check.siblingsRequired),
    missingScope: Boolean(check.missingScope),
    requestedAt: now,
  }
}

/**
 * 实施阶段自己停下（waiting_confirmation）请求追加文件时，从 blockers 里提取契约外的文件路径，转成同形的待批准请求，
 * 让人回复「确认扩大范围」也能一键放行（而不只是把路径当普通补料文本）。没有契约外路径时返回 null。
 */
export const scopeRequestFromBlockers = ({ scope, approvals = [], blockers = [], now = new Date().toISOString() } = {}) => {
  const normalized = normalizeScope(applyScopeApprovals(scope, approvals))
  const declared = new Set(normalized.missing ? [] : declaredPaths(normalized))
  const paths = extractRepoPaths((Array.isArray(blockers) ? blockers : []).join('\n')).filter((path) => !declared.has(path))
  if (!paths.length) return null
  return { paths, overBudget: false, siblingsRequired: false, missingScope: false, requestedAt: now, source: 'implementation' }
}

// gateway 落盘前对 worker 回写的待批准请求做一次清洗（来自 HTTP body，不信任其形状）：路径归一、上限 50 条。
export const normalizeScopeRequest = (raw) => {
  if (!isPlainObject(raw)) return null
  const paths = [...new Set((Array.isArray(raw.paths) ? raw.paths : []).map((item) => normalizeRepoPath(item).path).filter(Boolean))].slice(0, 50)
  const request = {
    paths,
    overBudget: raw.overBudget === true,
    siblingsRequired: raw.siblingsRequired === true,
    missingScope: raw.missingScope === true,
    requestedAt: cleanText(raw.requestedAt) || null,
    source: raw.source === 'implementation' ? 'implementation' : 'scope_check',
  }
  return paths.length || request.overBudget || request.siblingsRequired ? request : null
}

// 「确认扩大范围」话术：必须点明扩大 / 放行 / 允许改，裸「确认 / 可以 / ok」不算——那些在控制通道里是
// 纯确认话术（isNonSupplementalReply 会静默消费），且在越界卡下语义不足以代表「同意提交越界文件」。
const SCOPE_APPROVAL_RE = /确认扩大|扩大范围|同意扩大|批准|放行|(?:允许|同意|确认|可以)(?:一并|一起|都)?(?:改|修改|提交)/
// 否决：出现否定 / 撤回 / 收窄措辞就不当批准，按普通补充说明续跑（宁可多跑一轮，也不误放越界改动）。
const SCOPE_APPROVAL_VETO_RE = /不(?:要|用|能|可以|行|同意|允许|批准|该|应)|别|勿|禁止|撤回|回滚|还原|只(?:改|动|保留)/

// 回复是否构成「确认扩大范围」。纯函数便于单测。
export const isScopeApprovalReply = (text) => {
  const input = String(text || '')
  return SCOPE_APPROVAL_RE.test(input) && !SCOPE_APPROVAL_VETO_RE.test(input)
}

// 从人的回复里提取额外放行的仓库相对文件路径（带扩展名、可无目录；含 Next.js 路由的 [] / ()）。
const REPO_PATH_IN_TEXT_RE = /(?:^|[\s`'"“”‘’，,、：:（(；;])((?:[\w.@()[\]-]+\/)*[\w.@()[\]-]*\.(?:tsx?|jsx?|mjs|cjs|json|jsonc|css|scss|less|ya?ml|md|html|svg|npmrc))(?=$|[\s`'"“”‘’，,、。；;：:）)])/g
export const extractRepoPaths = (text) => {
  const paths = []
  for (const match of String(text || '').matchAll(REPO_PATH_IN_TEXT_RE)) {
    const { path } = normalizeRepoPath(match[1])
    if (path && !paths.includes(path)) paths.push(path)
  }
  return paths
}

/**
 * 续跑补料 → 批准记录。只有存在待批准请求、且回复是「确认扩大范围」话术时才产出；回复里点名的额外文件一并放行。
 * 返回 null 表示本次续跑只是普通补充说明（不放行任何文件）。纯函数便于单测。
 */
export const resolveScopeApproval = ({ request, supplementText = '', approvedBy = null, at = new Date().toISOString() } = {}) => {
  if (!isPlainObject(request) || !isScopeApprovalReply(supplementText)) return null
  const requested = (Array.isArray(request.paths) ? request.paths : []).map((raw) => normalizeRepoPath(raw).path).filter(Boolean)
  const paths = [...new Set([...requested, ...extractRepoPaths(supplementText)])]
  const allowOverBudget = request.overBudget === true
  const waiveSiblings = request.siblingsRequired === true
  if (!paths.length && !allowOverBudget && !waiveSiblings) return null
  return { paths, allowOverBudget, waiveSiblings, approvedBy, at, note: clip(String(supplementText).trim(), 200) }
}

// ---------------------------------------------------------------------------
// 收尾判定
// ---------------------------------------------------------------------------

/**
 * 用实测改动核对范围契约。返回：
 * {
 *   ok, workKind,
 *   missingScope, missingScopeReason,      // 会改代码的任务没给出可用 scope → 不 ok
 *   docsOnly,                              // scope 缺失但实测只改了 markdown 文档 → 照样 ok（文档不受契约约束）
 *   outOfScope: string[],                  // 不在 targets ∪ include siblings ∪ 自动放行内（禁区文件只进 forbiddenTouched，不重复列）
 *   forbiddenTouched: [{ path, reason }],  // 碰禁区，声明了也不算数 → 不 ok
 *   overBudget: { limit, actual } | null,  // 超行数 → 不 ok；numstat 未传入时不判
 *   lineCount, lineLimit,
 *   setOperation, setOperationCue,
 *   siblingsRequired,                      // 集合型任务但 siblings.items 为空 → 不 ok
 *   missingIncludedSiblings: string[],     // 声明纳入但实测没改（疑似漏改），只提示不阻断
 *   autoAllowed: [{ path, reason }],
 *   approved: string[],                    // 实测改动中经人工确认扩大范围放行的文件（含已批准的禁区文件）
 * }
 * approvals 是 task.scopeApprovals：批准的文件并入允许集合（禁区文件同样要显式出现在批准里才放行），
 * 批准里带 allowOverBudget / waiveSiblings 时对应的行数上限 / 集合型兄弟清单要求不再阻断。
 * actualChangedFiles 为空直接 ok：零改动的可信度由 assessDoneResult 判，这里不重复。
 * 调用方只对「会改代码」的任务调用；只读任务不该走到这里。
 */
export const checkScopeContract = ({ scope, actualChangedFiles = [], numstat = null, workKind = null, taskText = '', budgets = {}, approvals = [] } = {}) => {
  const actual = uniqueActualPaths(actualChangedFiles)
  const setOperationCue = detectSetOperationCue(taskText)
  const approval = summarizeApprovals(approvals)
  const approvedSet = new Set(approval.paths)
  const base = {
    ok: true,
    workKind,
    missingScope: false,
    missingScopeReason: null,
    docsOnly: false,
    outOfScope: [],
    forbiddenTouched: [],
    overBudget: null,
    lineCount: null,
    lineLimit: null,
    setOperation: setOperationCue !== null,
    setOperationCue,
    siblingsRequired: false,
    missingIncludedSiblings: [],
    autoAllowed: [],
    approved: [],
  }
  if (!actual.length) return base

  const normalized = normalizeScope(applyScopeApprovals(scope, approvals))
  const approved = actual.filter((path) => approvedSet.has(path))
  const forbiddenTouched = actual
    .filter((path) => !approvedSet.has(path))
    .map((path) => ({ path, reason: matchForbiddenPath(path) }))
    .filter((item) => item.reason)
  const forbiddenSet = new Set(forbiddenTouched.map((item) => item.path))

  const entries = numstat == null ? null : Array.isArray(numstat) ? numstat : parseNumstat(numstat)
  const lineCount = entries ? countBudgetLines(entries) : null
  const lineLimit = resolveLineBudget(workKind, budgets)
  const overBudget = !approval.allowOverBudget && lineCount !== null && lineLimit !== null && lineCount > lineLimit
    ? { limit: lineLimit, actual: lineCount }
    : null

  const result = { ...base, forbiddenTouched, overBudget, lineCount, lineLimit, approved }
  if (normalized.missing) {
    // 无契约可比：越界无从判定，不把全部改动堆进 outOfScope 制造噪音；禁区与行数照判。
    // 实测只改了文档（且不碰禁区 / 不超行数）→ 放行：没有代码改动就没有越界可言，契约缺失只是事实、不是违规
    // （docsOnly 标记供文案层跳过「未给出 scope」这条不通过项；lessons #33）。
    const autoAllowed = autoAllowedPaths(normalized, actual)
    const docsOnly = actual.every((path) => approvedSet.has(path) || autoAllowed.some((item) => item.path === path))
    return {
      ...result,
      ok: docsOnly && !forbiddenTouched.length && !overBudget,
      missingScope: true,
      missingScopeReason: normalized.reason,
      docsOnly,
      autoAllowed,
    }
  }

  const declared = new Set(declaredPaths(normalized))
  const autoAllowed = autoAllowedPaths(normalized, actual)
  const allowed = new Set([...declared, ...autoAllowed.map((item) => item.path)])
  const outOfScope = actual.filter((path) => !allowed.has(path) && !forbiddenSet.has(path))
  const actualSet = new Set(actual)
  const missingIncludedSiblings = normalized.siblings.items
    .filter((item) => item.include && !actualSet.has(item.path))
    .map((item) => item.path)
  const siblingsRequired = result.setOperation && normalized.siblings.items.length === 0 && !approval.waiveSiblings

  return {
    ...result,
    ok: !outOfScope.length && !forbiddenTouched.length && !overBudget && !siblingsRequired,
    outOfScope,
    siblingsRequired,
    missingIncludedSiblings,
    autoAllowed,
  }
}

// ---------------------------------------------------------------------------
// 卡片 / 结果文案
// ---------------------------------------------------------------------------

const MAX_LIST_ITEMS = 8
const MAX_REASON_CHARS = 60
const clip = (text, max = MAX_REASON_CHARS) => (text.length > max ? `${text.slice(0, max)}…` : text)

// 列表超过 8 项截断，末行注明「另 N 项」，控制卡片长度。
const listLines = (items, render) => {
  const lines = items.slice(0, MAX_LIST_ITEMS).map((item) => `  - ${render(item)}`)
  if (items.length > MAX_LIST_ITEMS) lines.push(`  - …另 ${items.length - MAX_LIST_ITEMS} 项`)
  return lines
}
const withReason = (path, reason) => (reason ? `${path}：${clip(reason)}` : path)
const kindLabel = (workKind) => WORK_KIND_LABELS[workKind] || workKind || '本类任务'

/**
 * 卡片用的范围契约段落（纯文本）：契约目标、同因搜索词、纳入 / 排除的兄弟位置（附理由），
 * 以及核对结果（自动放行、实测越界、禁区、超行数、集合型缺清单、疑似漏改）。check 可省略
 * （只展示契约本身）。纯函数便于单测。
 */
export const formatScopeSection = ({ scope, check = null } = {}) => {
  const normalized = normalizeScope(scope)
  const lines = []
  if (normalized.missing) {
    lines.push(`修改范围契约：未给出（${normalized.reason}）`)
  } else {
    const { targets, siblings } = normalized
    lines.push('修改范围契约：')
    lines.push(`· 契约目标（${targets.length}）：${targets.length ? '' : '无'}`)
    lines.push(...listLines(targets, (target) => withReason(
      target.symbols.length ? `${target.path}〔${clip(target.symbols.join('、'), 40)}〕` : target.path,
      target.reason,
    )))
    lines.push(`· 同因搜索词：${siblings.searchQueries.length ? clip(siblings.searchQueries.map((query) => `\`${query}\``).join('、'), 160) : '未给出'}`)
    const included = siblings.items.filter((item) => item.include)
    const excluded = siblings.items.filter((item) => !item.include)
    if (!siblings.items.length) lines.push('· 兄弟位置：未给出')
    if (included.length) {
      lines.push(`· 纳入的兄弟位置（${included.length}）：`)
      lines.push(...listLines(included, (item) => withReason(item.path, item.reason)))
    }
    if (excluded.length) {
      lines.push(`· 排除的兄弟位置（${excluded.length}）：`)
      lines.push(...listLines(excluded, (item) => withReason(item.path, item.reason)))
    }
  }
  if (!check) return lines.join('\n')

  if (check.autoAllowed?.length) {
    lines.push(`· 自动放行（${check.autoAllowed.length}）：`)
    lines.push(...listLines(check.autoAllowed, (item) => withReason(item.path, item.reason)))
  }
  if (check.approved?.length) {
    lines.push(`· 人工确认扩大范围（${check.approved.length}）：`)
    lines.push(...listLines(check.approved, (path) => path))
  }
  if (check.outOfScope?.length) {
    lines.push(`· 实测越界（${check.outOfScope.length}）：`)
    lines.push(...listLines(check.outOfScope, (path) => path))
  }
  if (check.forbiddenTouched?.length) {
    lines.push(`· 禁区改动（${check.forbiddenTouched.length}，须人工确认）：`)
    lines.push(...listLines(check.forbiddenTouched, (item) => withReason(item.path, item.reason)))
  }
  if (check.overBudget) {
    lines.push(`· 改动行数：${check.overBudget.actual} 行，超出${kindLabel(check.workKind)}上限 ${check.overBudget.limit} 行`)
  }
  if (check.siblingsRequired) {
    lines.push(`· 集合型任务（命中「${check.setOperationCue}」）但未给出同因搜索的兄弟位置清单`)
  }
  if (check.missingIncludedSiblings?.length) {
    lines.push(`· 声明纳入但实测未改（${check.missingIncludedSiblings.length}，疑似漏改，请复核）：`)
    lines.push(...listLines(check.missingIncludedSiblings, (path) => path))
  }
  return lines.join('\n')
}

// 不通过项逐条成句，供阻断文案复用。
const describeViolations = (check) => {
  const items = []
  if (check.missingScope && !check.docsOnly) items.push(`分析阶段没有给出可用的修改范围（${check.missingScopeReason || 'scope 缺失'}），改动无从核对`)
  if (check.outOfScope?.length) {
    const shown = check.outOfScope.slice(0, MAX_LIST_ITEMS).join('、')
    const more = check.outOfScope.length > MAX_LIST_ITEMS ? ` 等 ${check.outOfScope.length} 个` : ''
    items.push(`改了契约外的文件：${shown}${more}`)
  }
  if (check.forbiddenTouched?.length) {
    items.push(`改了禁区文件（即使已声明也须人工确认）：${check.forbiddenTouched.map((item) => `${item.path}（${item.reason}）`).join('、')}`)
  }
  if (check.overBudget) {
    items.push(`改动 ${check.overBudget.actual} 行，超出${kindLabel(check.workKind)}上限 ${check.overBudget.limit} 行（不含 lockfile 与 locale json）`)
  }
  if (check.siblingsRequired) {
    items.push(`这是集合型任务（命中「${check.setOperationCue}」），但分析阶段没有给出同因搜索的兄弟位置清单，无法确认是否漏改`)
  }
  return items
}

/**
 * 范围契约不通过 → 降级人工复核的结果文案。风格对齐 buildQualityBlockedResult：先给结论，再逐条列事实与出口。
 * 出口复用控制通道的「续跑」：任务以 waiting_confirmation 挂起，人回复本卡片即续跑原任务（复用原分支 / 现场）；
 * 回复含「确认扩大范围」话术时，gateway 把上面的越界 / 禁区文件（及回复里点名的文件）记入 task.scopeApprovals，
 * 重跑的分析阶段与收尾核对都把它们并入允许集合（见 resolveScopeApproval / applyScopeApprovals）。
 */
export const buildScopeBlockedResult = (task, check) => {
  const violations = describeViolations(check || {})
  const resumeHint = task?.id ? `；若关联失败，发送 \`继续任务 ${task.id} 确认扩大范围\`` : ''
  return [
    '需人工复核：改动超出修改范围契约，未提交。',
    `1. 任务：${taskLine(task?.summary || task?.text || '', '群内反馈的问题')}；`,
    `2. 不通过项：\n${violations.map((item) => `   - ${item}`).join('\n') || '   - （无明细）'}`,
    '3. 改动保留在任务工作区，未提交、未回滚；',
    `4. 处理方式：
   - 确属本次范围 → 回复本卡片「确认扩大范围」（可附上还要一并放行的文件路径），Bot 会把上面列出的文件并入修改范围后续跑原任务${resumeHint}；
   - 不该改 → 回复本卡片说明正确范围（如「不要改 X，只改 Y」），Bot 按补充说明续跑并撤回契约外改动；
   - 不再需要 → 回复「取消任务」。`,
  ].join('\n')
}

/**
 * task-runner 收尾用的一站式判定：核对契约 → 产出卡片段落、阻断文案、待批准请求与非阻断提醒。
 * 返回 { check, section, blockedText, scopeRequest, warnNotes }；check.ok 时 blockedText / scopeRequest 为 null。
 * 纯函数（now 可注入），供 node --test 直测「越界 → 阻断」「批准后 → 放行」。
 */
export const resolveScopeGate = ({ task, scope, actualChangedFiles = [], numstat = null, workKind = null, budgets = {}, now, exemptPrefixes = [] } = {}) => {
  // 豁免目录（仓库 profile 的对接文档落点）：群里发来的文档原样落档、答复原文存档，不在契约里、也不计行数（整改 2026-10-14）。
  const prefixes = (exemptPrefixes || []).map((prefix) => String(prefix).replace(/^\.\//, '').replace(/\/+$/, '') + '/').filter((prefix) => prefix !== '/')
  const exempt = (path) => prefixes.some((prefix) => String(path).replace(/^\.\//, '').startsWith(prefix))
  const files = actualChangedFiles.filter((path) => !exempt(path))
  const stats = numstat == null ? null : (Array.isArray(numstat) ? numstat : parseNumstat(numstat)).filter((entry) => !exempt(entry?.path))
  const check = checkScopeContract({
    scope,
    actualChangedFiles: files,
    numstat: stats,
    workKind,
    taskText: task?.text || '',
    budgets,
    approvals: [...(task?.scopeApprovals || []), ...(isPrincipalAssigned(task) ? [{ paths: [], allowOverBudget: true }] : [])], // 负责人本人交办只免行数上限（#76）
  })
  // 「声明纳入但没改」对全部实测改动核，不对豁免后的子集（#67：对接文档目录里的兄弟位置改了，被豁免过滤后误报疑似漏改）。
  const touched = new Set(actualChangedFiles.map(normalizeActualPath))
  check.missingIncludedSiblings = check.missingIncludedSiblings.filter((path) => !touched.has(path))
  const section = formatScopeSection({ scope, check })
  const warnNotes = check.missingIncludedSiblings.length
    ? [`范围契约声明纳入的 ${check.missingIncludedSiblings.length} 处兄弟位置实测未改（疑似漏改，请复核）：${check.missingIncludedSiblings.slice(0, MAX_LIST_ITEMS).join('、')}`]
    : []
  if (check.ok) return { check, section, blockedText: null, scopeRequest: null, warnNotes }
  return {
    check,
    section,
    blockedText: `${buildScopeBlockedResult(task, check)}\n${section}`,
    scopeRequest: buildScopeRequest({ check, actualChangedFiles, ...(now ? { now } : {}) }),
    warnNotes,
  }
}
