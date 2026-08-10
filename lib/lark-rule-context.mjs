/**
 * 从现有 L1/L3 权威源按任务语义抽取小段规则，避免把整包规则交给无人值守 AI。
 * 本文件只维护“任务信号 -> 现有章节”的路由，不复制规则正文。
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { docsSystemRoot } from '../../engine/agent-scripts/lib/roots.mjs'

const SIGNALS = {
  copy: /(?:文案|标题|按钮|提示|说明|tips?|tooltip|toast|placeholder|label|hover)/i,
  style: /(?:样式|颜色|圆角|间距|尺寸|背景|边框|字号|图标|布局|响应式|class|color|radius|padding|margin)/i,
  ui: /(?:页面|组件|表单|弹窗|浮层|tab|输入框|下拉|switch|hover|UI|UX)/i,
  api: /(?:API|接口|schema|DTO|mapper|字段|请求|响应|契约)/i,
  mapper: /(?:mapper|映射|DTO|schema)/i,
  query: /(?:React Query|query|mutation|hook|请求状态|缓存)/i,
  state: /(?:Zustand|store|状态管理|状态派生|state)/i,
  mock: /(?:MSW|mock|fixture|handler)/i,
}

const sourcePath = (relativePath) => join(docsSystemRoot, relativePath)
const globalPath = (relativePath) => join(homedir(), '.ai-rules', relativePath)

const BASE_REFS = [
  { file: globalPath('AGENT.md'), label: '~/.ai-rules/AGENT.md', heading: '## React / TypeScript Hard Rules' },
  { file: sourcePath('common/rules/rule-router.md'), label: 'common/rules/rule-router.md', heading: '## 2. 常驻硬规则' },
]

const UI_REFS = [
  { file: globalPath('skills/coding-quality/SKILL.md'), label: '~/.ai-rules/skills/coding-quality/SKILL.md', heading: '## 0. Pre-Code Quality Card' },
  { file: globalPath('skills/coding-quality/SKILL.md'), label: '~/.ai-rules/skills/coding-quality/SKILL.md', heading: '## 0.1 Output Quality Gate' },
  { file: globalPath('skills/coding-quality/SKILL.md'), label: '~/.ai-rules/skills/coding-quality/SKILL.md', heading: '## 5. Reuse Before New UI' },
  { file: sourcePath('common/rules/architecture-and-state.md'), label: 'common/rules/architecture-and-state.md', heading: '## 1. 默认分层' },
  { file: sourcePath('common/rules/architecture-and-state.md'), label: 'common/rules/architecture-and-state.md', heading: '## 2. 复用优先级' },
]

const COPY_REFS = [
  { file: globalPath('skills/coding-quality/SKILL.md'), label: '~/.ai-rules/skills/coding-quality/SKILL.md', heading: '## 4. i18n Keys Are What-You-See-In-Source (i18n Ally WYSIWYG)' },
  { file: globalPath('skills/coding-quality/SKILL.md'), label: '~/.ai-rules/skills/coding-quality/SKILL.md', heading: '## 9. Copy Contracts' },
  { file: sourcePath('common/rules/architecture-and-state.md'), label: 'common/rules/architecture-and-state.md', heading: '## 7.1 文案契约：像接口 contract 一样管理' },
]

const STYLE_REFS = [
  { file: globalPath('skills/coding-quality/SKILL.md'), label: '~/.ai-rules/skills/coding-quality/SKILL.md', heading: '## 8. Styling And Visual QA' },
  { file: sourcePath('common/rules/ui-style-token-rules.md'), label: 'common/rules/ui-style-token-rules.md', heading: '## 1. 设计契约' },
  { file: sourcePath('common/rules/ui-style-token-rules.md'), label: 'common/rules/ui-style-token-rules.md', heading: '## 2. 颜色与主题' },
  { file: sourcePath('common/rules/ui-style-token-rules.md'), label: 'common/rules/ui-style-token-rules.md', heading: '## 3. 尺寸、间距、圆角' },
  { file: sourcePath('common/rules/ui-style-token-rules.md'), label: 'common/rules/ui-style-token-rules.md', heading: '## 4. Arbitrary Value 边界' },
]

const API_REFS = [
  { file: sourcePath('common/rules/api-and-mapper.md'), label: 'common/rules/api-and-mapper.md', heading: '## 1. 调用链与数据链' },
  { file: sourcePath('common/rules/api-and-mapper.md'), label: 'common/rules/api-and-mapper.md', heading: '## 2. Mapper 命名' },
  { file: sourcePath('common/rules/api-and-mapper.md'), label: 'common/rules/api-and-mapper.md', heading: '## 3. 字段对账' },
  { file: globalPath('skills/coding-quality/SKILL.md'), label: '~/.ai-rules/skills/coding-quality/SKILL.md', heading: '## 6. API Schema And Mapper Checks' },
]

const STATE_REFS = [
  { file: sourcePath('common/rules/architecture-and-state.md'), label: 'common/rules/architecture-and-state.md', heading: '## 4. 状态管理' },
  { file: sourcePath('common/rules/architecture-and-state.md'), label: 'common/rules/architecture-and-state.md', heading: '## 5. Zustand 使用边界' },
  { file: sourcePath('common/rules/architecture-and-state.md'), label: 'common/rules/architecture-and-state.md', heading: '## 6. 状态推导与查表' },
  { file: globalPath('skills/coding-quality/SKILL.md'), label: '~/.ai-rules/skills/coding-quality/SKILL.md', heading: '## 2. State Derivation And Lookup Resolvers' },
]

const MOCK_REFS = [
  { file: sourcePath('common/rules/architecture-and-state.md'), label: 'common/rules/architecture-and-state.md', heading: '## 8. Mock 策略：默认 MSW 路线 B，临时脚手架、零残留' },
]

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
export const allRuleRefs = () =>
  dedupeRefs([...BASE_REFS, ...UI_REFS, ...COPY_REFS, ...STYLE_REFS, ...API_REFS, ...STATE_REFS, ...MOCK_REFS])

// BASE_REFS 是 React/TS 硬规则与常驻硬规则，任何场景都必须带上：缺了就等于让无人值守 AI 裸跑。
const isBaseRef = (ref) => BASE_REFS.some((base) => base.file === ref.file && base.heading === ref.heading)

const refsFor = ({ scenarios = [], signals = [] }) => {
  const scenarioSet = new Set(scenarios)
  const signalSet = new Set(signals)
  const refs = [...BASE_REFS]
  if (scenarioSet.has('write_ui')) refs.push(...UI_REFS)
  if (signalSet.has('copy')) refs.push(...COPY_REFS)
  if (signalSet.has('style')) refs.push(...STYLE_REFS)
  if (['write_api', 'write_mapper', 'write_query_hook'].some((s) => scenarioSet.has(s))) refs.push(...API_REFS)
  if (['write_state', 'write_query_hook'].some((s) => scenarioSet.has(s))) refs.push(...STATE_REFS)
  if (scenarioSet.has('write_msw')) refs.push(...MOCK_REFS, ...API_REFS)
  return refs
}

export const buildFocusedRuleContext = ({ taskText, hasImage = false, isFix = false } = {}) => {
  const classification = classifyLarkTask(taskText, { hasImage, isFix })
  const sources = []
  const excerpts = []
  const warnings = []
  const missingBaseRefs = []
  const seen = new Set()

  for (const ref of refsFor(classification)) {
    const key = `${ref.file}#${ref.heading}`
    if (seen.has(key)) continue
    seen.add(key)
    if (!existsSync(ref.file)) {
      // 文件不在本机 = 全局规则目录搬家/改名，与「章节缺失」同等严重（此前静默跳过，无人能发现规则已裸跑）。
      const warning = `规则文件缺失：${ref.label}（路径 ${ref.file} 不存在，规则被静默丢弃，需人工核对全局规则目录/软链）`
      warnings.push(warning)
      console.warn(`[lark-rule-context] ⚠ ${warning}`)
      if (isBaseRef(ref)) missingBaseRefs.push(ref.label)
      continue
    }
    const excerpt = extractMarkdownSection(readFileSync(ref.file, 'utf8'), ref.heading)
    if (!excerpt) {
      // 文件在但抽到空段 = 源文档改了标题 → 规则被静默丢弃。记 warn + audit，不静默 continue。
      const warning = `规则章节缺失：${ref.label} 未找到「${ref.heading}」（源文档可能改了标题，规则被静默丢弃，需人工核对路由）`
      warnings.push(warning)
      console.warn(`[lark-rule-context] ⚠ ${warning}`)
      if (isBaseRef(ref)) missingBaseRefs.push(ref.label)
      continue
    }
    const sha256 = createHash('sha256').update(excerpt).digest('hex')
    sources.push({ path: ref.label, section: ref.heading, sha256 })
    excerpts.push(`### Source: ${ref.label} · ${ref.heading}\n\n${excerpt}`)
  }

  // BASE_REFS（React/TS 硬规则 + 常驻硬规则）任何场景都必须注入；缺了等于让无人值守 AI 裸跑，
  // 比章节路由错配更严重，直接拒绝构建上下文（调用方 runAI 未捕获，冒泡到 runTask 判 failed）。
  if (missingBaseRefs.length) {
    throw new Error(`规则上下文构建失败：基线硬规则缺失 ${missingBaseRefs.join('、')}，拒绝无规则裸跑，请先核对全局规则目录/软链是否可达`)
  }

  return {
    ...classification,
    sources,
    warnings,
    fingerprint: createHash('sha256').update(sources.map((item) => `${item.path}#${item.section}:${item.sha256}`).join('\n')).digest('hex').slice(0, 16),
    text: excerpts.join('\n\n'),
  }
}
