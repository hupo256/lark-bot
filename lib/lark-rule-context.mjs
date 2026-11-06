/**
 * 从现有 L1/L3 权威源按任务语义抽取小段规则，避免把整包规则交给无人值守 AI。
 * 本文件只维护“任务信号 -> 现有章节”的路由，不复制规则正文。
 * 必读：业务仓自己的 CLAUDE.md（固定前提 / 硬规则）；可选：~/.ai-rules（个人规则库，有就带）。
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { larkBotRoot } from './lark-paths.mjs'

const SIGNALS = {
  copy: /(?:文案|标题|按钮|提示|说明|tips?|tooltip|toast|placeholder|label|hover)/i,
  style: /(?:样式|颜色|圆角|间距|尺寸|背景|边框|字号|图标|布局|响应式|class|color|radius|padding|margin)/i,
  ui: /(?:页面|组件|表单|弹窗|浮层|tab|输入框|下拉|switch|hover|UI|UX)/i,
  api: /(?:API|接口|schema|DTO|mapper|字段|请求|响应|契约)/i,
  mapper: /(?:mapper|映射|DTO|schema)/i,
  query: /(?:React Query|query|mutation|hook|请求状态|缓存)/i,
  state: /(?:Zustand|store|状态管理|状态派生|state)/i,
  mock: /(?:MSW|mock|fixture|handler)/i,
  // 插槽式基座（falive）：新增模块 / 页面 / 首页区块 / 侧栏入口 / 路由 → 必须按 add-module 向导的骨架来。
  module: /(?:新增(?:一个)?(?:模块|页面|区块|功能|入口|路由)|新(?:模块|页面|区块)|接入(?:一个)?(?:模块|功能)|插槽|slot|registry|manifest)/i,
}

const aiRulesRoot = join(homedir(), '.ai-rules')
const globalPath = (relativePath) => join(aiRulesRoot, relativePath)

// 规则来源版本：~/.ai-rules 与 bot 仓库各自的 git HEAD 短 sha，写进审计与提示词，
// 事后可按 sha 还原当次注入的规则原文。取代拆仓前 docs_tdd 引擎的发布指纹（rule-release / effective-rules）。
// 读不到（非 git 仓 / git 不可用）记 null，不抛——版本信息只用于追溯，不能拦任务。
const gitShortHead = (dir, spawn = spawnSync) => {
  try {
    const result = spawn('git', ['rev-parse', '--short', 'HEAD'], { cwd: dir, encoding: 'utf8', stdio: 'pipe', timeout: 5000 })
    const sha = result.status === 0 ? String(result.stdout || '').trim() : ''
    return sha || null
  } catch {
    return null
  }
}

export const readRuleRevisions = ({ aiRulesDir = aiRulesRoot, larkBotDir = larkBotRoot, spawn = spawnSync } = {}) => ({
  aiRulesRevision: gitShortHead(aiRulesDir, spawn),
  larkBotRevision: gitShortHead(larkBotDir, spawn),
})

// 规则 profile：业务仓读自己的 CLAUDE.md / skills/add-module / msw-policy，外加 ~/.ai-rules 的通用 coding-quality 参考（可选）。
// repoRoot 缺省时由 required（仓内 CLAUDE.md）缺失 fail-closed（不能在不知道仓库在哪时裸跑）。
const repoPath = (repoRoot, relativePath) => join(repoRoot || '/nonexistent', relativePath)
const faliveRefs = (repoRoot) => {
  const faliveLabel = (relativePath) => `falive-react/${relativePath}`
  const claude = (heading, extra = {}) => ({ file: repoPath(repoRoot, 'CLAUDE.md'), label: faliveLabel('CLAUDE.md'), heading, ...extra })
  const addModule = (heading) => ({ file: repoPath(repoRoot, 'skills/add-module/SKILL.md'), label: faliveLabel('skills/add-module/SKILL.md'), heading })
  const mswPolicy = (heading) => ({ file: repoPath(repoRoot, 'docs/migration/msw-policy.md'), label: faliveLabel('docs/migration/msw-policy.md'), heading })
  return {
    base: [
      // ~/.ai-rules 是可选的个人规则库：有就带，没有只降级告警（同事机器上通常没有）。
      { file: globalPath('AGENT.md'), label: '~/.ai-rules/AGENT.md', heading: '## React / TypeScript Hard Rules' },
      claude('## 固定前提（勿偏离）', { required: true }),
      claude('## 硬规则速览（细则见各向导）', { required: true }),
    ],
    ui: [
      { file: globalPath('skills/coding-quality/SKILL.md'), label: '~/.ai-rules/skills/coding-quality/SKILL.md', heading: '## 0. Pre-Code Quality Card' },
      { file: globalPath('skills/coding-quality/SKILL.md'), label: '~/.ai-rules/skills/coding-quality/SKILL.md', heading: '## 0.1 Output Quality Gate' },
      { file: globalPath('skills/coding-quality/references/reuse-before-new-ui.md'), label: '~/.ai-rules/skills/coding-quality/references/reuse-before-new-ui.md', heading: '# Reuse Before New UI' },
      addModule('## 4. 复用什么（别重造）'),
    ],
    copy: [
      { file: globalPath('skills/coding-quality/references/i18n-keys.md'), label: '~/.ai-rules/skills/coding-quality/references/i18n-keys.md', heading: '# i18n Keys Are What-You-See-In-Source (i18n Ally WYSIWYG)' },
      { file: globalPath('skills/coding-quality/references/copy-contracts.md'), label: '~/.ai-rules/skills/coding-quality/references/copy-contracts.md', heading: '# Copy Contracts' },
    ],
    style: [
      { file: globalPath('skills/coding-quality/references/styling-visual-qa.md'), label: '~/.ai-rules/skills/coding-quality/references/styling-visual-qa.md', heading: '# Styling And Visual QA' },
    ],
    api: [
      { file: globalPath('skills/coding-quality/references/api-schema-mapper.md'), label: '~/.ai-rules/skills/coding-quality/references/api-schema-mapper.md', heading: '# API Schema And Mapper Checks' },
      addModule('### 2.2 data（schema + queries + mock）'),
    ],
    state: [
      { file: globalPath('skills/coding-quality/references/state-derivation-lookup.md'), label: '~/.ai-rules/skills/coding-quality/references/state-derivation-lookup.md', heading: '# State Derivation And Lookup Resolvers' },
    ],
    mock: [
      mswPolicy('## 0. 一句话原则'),
      mswPolicy('## 1. 边界：什么是「基建」（留），什么是「业务 mock」（清）'),
      mswPolicy('## 3. 清理清单（接通一个端点时执行）'),
    ],
    module: [
      addModule('## 1. 铁律（先记住，违反会被打回）'),
      addModule('## 2. 普通模块：目录骨架'),
    ],
  }
}
// lark-bot 自修工单（自愈环 2.2）：改的是 bot 自己的 Node 代码，前端规则一条都不适用；
// 常驻硬规则 = 本仓 AGENTS.md（不 push / 不 restart / 本机数据不进仓）+ 出错处理原则 + 自愈三环原则。
const larkBotRefs = (repoRoot) => ({
  base: [
    { file: repoPath(repoRoot, 'AGENTS.md'), label: 'lark-bot/AGENTS.md', heading: '# lark-bot Agent 规则', required: true },
    { file: repoPath(repoRoot, 'AGENTS.md'), label: 'lark-bot/AGENTS.md', heading: '## 出错处理原则（aven 2026-10-14 定，2026-10-17 改为「先分类再动手」）', required: true },
    { file: repoPath(repoRoot, 'docs/falive-self-healing.md'), label: 'lark-bot/docs/falive-self-healing.md', heading: '## 1. 原则：三环，机械优先', required: true },
  ],
  ui: [], copy: [], style: [], api: [], state: [], mock: [], module: [],
})
// falive-bot 只服务前端业务仓：除 bot 自修工单（lark-bot）外一律按业务仓口径（仓内 CLAUDE.md 必读，~/.ai-rules 有就带）。
export const ruleRefsForProfile = (ruleProfile = 'falive', { repoRoot } = {}) =>
  ruleProfile === 'lark-bot' ? larkBotRefs(repoRoot) : faliveRefs(repoRoot)

const headingLevel = (heading) => heading.match(/^#+/)?.[0].length || 2

export const extractMarkdownSection = (text, heading) => {
  const lines = String(text || '').split('\n')
  const start = lines.findIndex((line) => line.trim() === heading)
  if (start < 0) return ''
  const level = headingLevel(heading)
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    const match = lines[index].match(/^(#+)\s+/)
    if (match && match[1].length <= level) {
      end = index
      break
    }
  }
  return lines.slice(start, end).join('\n').trim()
}

export const classifyLarkTask = (taskText, { hasImage = false, isFix = false } = {}) => {
  const text = String(taskText || '')
  const signalSet = new Set(
    Object.entries(SIGNALS)
      .filter(([, pattern]) => pattern.test(text))
      .map(([name]) => name),
  )
  // 图片附件或 fix 命令 → 强制并入 UI+STYLE 信号：视觉/修复类常只写「字段 / 背景 / 不对」等短语，
  // 易被误判成纯 API 任务而丢掉 UI/样式 token 规则（g4 空档）。图片本身就是视觉线索。
  if (hasImage || isFix) {
    signalSet.add('ui')
    signalSet.add('style')
  }
  // 多标签叠加：不再「单一胜出」，命中的语义都产出对应 scenario 标签（如 ui+api 同时给），
  // refsFor 按标签并集加载规则，避免混合任务漏掉某一维度的 token 规则。
  const scenarios = []
  if (signalSet.has('module')) scenarios.push('write_module')
  if (signalSet.has('mock')) scenarios.push('write_msw')
  if (signalSet.has('mapper')) scenarios.push('write_mapper')
  if (signalSet.has('query')) scenarios.push('write_query_hook')
  if (signalSet.has('state')) scenarios.push('write_state')
  if (signalSet.has('api')) scenarios.push('write_api')
  if (signalSet.has('ui') || signalSet.has('copy') || signalSet.has('style')) scenarios.push('write_ui')
  if (!scenarios.length) scenarios.push('g4_coding_worktree')
  // scenario 保留为主标签（首个，供 prompt/audit 单值展示），scenarios 为全量标签集。
  return { scenario: scenarios[0], scenarios, signals: [...signalSet] }
}

const dedupeRefs = (refs) => {
  const seen = new Set()
  return refs.filter((ref) => {
    const key = `${ref.file}#${ref.heading}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// 全量路由章节：供测试锁住「路由表 → 真实文档」的对应关系。任一章节抽不到即测试红，
// 把「docs / 全局规则改标题或搬家 → 规则被静默丢弃」从只有运行时日志提前到 CI 可拦。
export const allRuleRefs = (ruleProfile = 'falive', options = {}) => {
  const groups = ruleRefsForProfile(ruleProfile, options)
  return dedupeRefs([...groups.base, ...groups.ui, ...groups.copy, ...groups.style, ...groups.api, ...groups.state, ...groups.mock, ...groups.module])
}

const refsFor = ({ scenarios = [], signals = [] }, groups) => {
  const scenarioSet = new Set(scenarios)
  const signalSet = new Set(signals)
  const refs = [...groups.base]
  if (scenarioSet.has('write_ui')) refs.push(...groups.ui)
  if (signalSet.has('copy')) refs.push(...groups.copy)
  if (signalSet.has('style')) refs.push(...groups.style)
  if (['write_api', 'write_mapper', 'write_query_hook'].some((s) => scenarioSet.has(s))) refs.push(...groups.api)
  if (['write_state', 'write_query_hook'].some((s) => scenarioSet.has(s))) refs.push(...groups.state)
  if (scenarioSet.has('write_msw')) refs.push(...groups.mock, ...groups.api)
  if (scenarioSet.has('write_module')) refs.push(...groups.module, ...groups.ui)
  return refs
}

export const buildFocusedRuleContext = ({ taskText, hasImage = false, isFix = false, ruleRevisions, ruleRefs, ruleProfile = 'falive', repoRoot } = {}) => {
  const classification = classifyLarkTask(taskText, { hasImage, isFix })
  const groups = ruleRefsForProfile(ruleProfile, { repoRoot })
  const sources = []
  const excerpts = []
  const warnings = []
  const missingRequired = []
  const seen = new Set()

  for (const ref of dedupeRefs(ruleRefs || refsFor(classification, groups))) {
    const key = `${ref.file}#${ref.heading}`
    if (seen.has(key)) continue
    seen.add(key)
    if (!existsSync(ref.file)) {
      // 文件不在本机 = 全局规则目录搬家/改名，与「章节缺失」同等严重（此前静默跳过，无人能发现规则已裸跑）。
      const warning = `规则文件缺失：${ref.label}（路径 ${ref.file} 不存在，规则被静默丢弃，需人工核对全局规则目录/软链）`
      warnings.push(warning)
      console.warn(`[lark-rule-context] ⚠ ${warning}`)
      if (ref.required) missingRequired.push(ref.label)
      continue
    }
    const excerpt = extractMarkdownSection(readFileSync(ref.file, 'utf8'), ref.heading)
    if (!excerpt) {
      // 文件在但抽到空段 = 源文档改了标题 → 规则被静默丢弃。记 warn + audit，不静默 continue。
      const warning = `规则章节缺失：${ref.label} 未找到「${ref.heading}」（源文档可能改了标题，规则被静默丢弃，需人工核对路由）`
      warnings.push(warning)
      console.warn(`[lark-rule-context] ⚠ ${warning}`)
      if (ref.required) missingRequired.push(`${ref.label}#${ref.heading}`)
      continue
    }
    const sha256 = createHash('sha256').update(excerpt).digest('hex')
    sources.push({ path: ref.label, section: ref.heading, sha256 })
    excerpts.push({ label: ref.label, heading: ref.heading, sha256, text: `### Source: ${ref.label} · ${ref.heading}\n\n${excerpt}` })
  }

  // 只有 required（常驻硬规则）章节缺失才 fail-closed：这些是任何任务都必须带的核心规则，缺了等于裸跑。
  // 按信号路由的辅助章节（UI/样式/API 等）缺失只降级——它对本任务未必相关，且改标题不该让所有匹配任务全红；
  // 缺失以 warnings 浮现到结果卡与审计（A2），交人工核对路由，而不是静默丢弃或整体阻断。
  if (missingRequired.length) {
    throw new Error(`[VERIFY-RULE-004] 规则上下文构建失败：缺失常驻硬规则 ${missingRequired.join('、')}，拒绝使用不完整规则执行`)
  }

  // 版本号参与上下文指纹：同一章节内容在规则仓库换版后，指纹也随之变化，审计里能区分。
  const revisionFingerprint = ruleRevisions
    ? `${ruleRevisions.aiRulesRevision}:${ruleRevisions.larkBotRevision}`
    : 'unbound'

  return {
    ...classification,
    ruleProfile,
    sources,
    warnings,
    aiRulesRevision: ruleRevisions?.aiRulesRevision || null,
    larkBotRevision: ruleRevisions?.larkBotRevision || null,
    fingerprint: createHash('sha256').update(`${revisionFingerprint}\n${sources.map((item) => `${item.path}#${item.section}:${item.sha256}`).join('\n')}`).digest('hex').slice(0, 16),
    excerpts,
    text: excerpts.map((item) => item.text).join('\n\n'),
  }
}

// Claude Code 跑 `claude -p` 时会自动加载 cwd 仓库的 CLAUDE.md 和 ~/.claude/CLAUDE.md（本机软链到 ~/.ai-rules/AGENT.md）。
// 这些章节再注入一遍只是重复占上下文（实测 21K 字符里约 1/3 是它们）；对 claude 执行器从提示里剔掉，
// 审计 sources / 指纹照旧记完整，omitted 列出剔掉的，事后能还原当次规则集。
export const AUTO_LOADED_RULE_LABELS = /(^|\/)CLAUDE\.md$|^~\/\.ai-rules\/AGENT\.md$/
export const stripAutoLoadedRules = (ruleContext) => {
  if (!ruleContext?.excerpts?.length) return ruleContext
  const kept = ruleContext.excerpts.filter((item) => !AUTO_LOADED_RULE_LABELS.test(item.label))
  const omitted = ruleContext.excerpts.filter((item) => AUTO_LOADED_RULE_LABELS.test(item.label)).map((item) => `${item.label}#${item.heading}`)
  return { ...ruleContext, text: kept.map((item) => item.text).join('\n\n'), omittedAutoLoaded: omitted }
}
