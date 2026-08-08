/**
 * Lark 无人值守修复的轻量规范闸：只扫「本次 diff 新增行」里几类高置信度违规，
 * 不碰团队 CI、不扫既有存量债（只看 + 行）。给 worker 在回写 done 前拦一道。
 *
 * 覆盖最常被自动修 bug 踩中的红线（对照 ~/.ai-rules/skills/coding-quality 与全局 CLAUDE 硬规则）：
 *  1. Tailwind arbitrary value（如 rounded-[8px]、text-[14px]、w-[336px]）——应改用 preset token。
 *  2. 无 shade 的裸 Tailwind 调色板色类（如 text-green / bg-red）——Tailwind 会静默丢弃，
 *     文字/背景根本不变色也不报错；项目语义色应用 text-sem-g / text-sem-r / text-1..8 等 token。
 *  3. 裸 any（as any / : any / <any>）——外部数据应 unknown + 守卫 / schema 收窄，不用 any 掩盖。
 *  4. i18n 动态 key（t(变量) / t(`ns:${x}`)）——key 必须是源码字面量（i18n Ally WYSIWYG）。
 *  5. JSX 文本硬编码中文——应抽成 t('ns:key') 走 i18n。
 *
 * 降噪：① 只扫代码文件的 + 行；② arbitrary/裸色只在 className 语境（引号内或 @apply）才算，
 * 避开注释/散文/CSS 选择器误报；③ 跳过纯注释行。纯函数 scanDiffForViolations 便于 node --test 覆盖。
 */

// 只检查前端源码文件的改动
const CODE_FILE_RE = /\.(tsx|ts|jsx|js|css)$/
const TS_FILE_RE = /\.(tsx|ts)$/ // any 检测限 TS
const JSX_FILE_RE = /\.(tsx|jsx)$/ // JSX 硬编码中文限 JSX

// Tailwind arbitrary value：<前缀>-[<任意>]。前缀限定为常见工具类，避免误伤 TS 里的 `a - [1]` 等。
// 补齐 ring/outline/aspect/columns/indent/content 等常见前缀。
const ARBITRARY_RE =
  /\b(?:[a-z][\w.]*:)*(?:w|h|size|min-w|max-w|min-h|max-h|p[xytblr]?|m[xytblr]?|gap(?:-[xy])?|space-[xy]|top|bottom|left|right|inset(?:-[xy])?|text|bg|border(?:-[tblrxy])?|rounded(?:-[tblr]|-[tb][lr])?|leading|tracking|z|opacity|shadow|fill|stroke|ring(?:-offset)?|outline|aspect|columns|indent|content|grid-cols|grid-rows|col-span|row-span|basis|flex|order|duration|delay|translate-[xy]|scale|rotate)-\[[^\]]+\]/g

// 无 shade 的裸调色板色（Tailwind v3 默认色必须带 -数字 shade，裸名一定失效）
const BARE_COLOR_RE =
  /\b(?:text|bg|border|fill|stroke|ring|from|to|via|decoration|divide|outline|shadow|caret|accent)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|gray|grey|slate|zinc|neutral|stone)\b(?!-)/g

// 裸 any：as any / : any / <any>（对齐全局 CLAUDE「避免 bare any」硬规则）
const BARE_ANY_RE = /\bas\s+any\b|:\s*any\b|<any>/g

// i18n 动态 key：t(变量) 或 t(`...${}`)。t('literal') / t("literal") 不算（合法）。
const I18N_DYNAMIC_KEY_RE = /\bt\(\s*(?:`[^`]*\$\{|[A-Za-z_$][\w$.]*\s*[,)])/g

// JSX 文本节点里的硬编码中文：>…中文…<（排除含 {} 的表达式节点，如 >{t('x')}<）
const JSX_CJK_RE = />[^<>{}]*[一-鿿][^<>{}]*</g

const isCommentLine = (text) => {
  const trimmed = text.trim()
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
}

// 判断 index 处是否落在引号（' " `）包裹的字符串里——className 语境判定用（降注释/散文/i18n 文案误报）
const inStringSpan = (text, index) => {
  let quote = null
  for (let i = 0; i < index; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
    }
  }
  return quote !== null
}

// Tailwind 类只在 className 语境（引号字符串内，或 CSS @apply）才判违规
const inClassContext = (text, index) => inStringSpan(text, index) || /@apply\b/.test(text)

const ADVICE = {
  'arbitrary-value':
    '改用 packages/config/tailwind-preset.js 里的 token（如 rounded-[8px]→rounded-m，间距/字号/圆角/颜色都有 token）',
  'invalid-color-class':
    '这是无 shade 的裸调色板色，Tailwind 会静默丢弃、根本不生效；换成项目语义 token（语义绿 text-sem-g、语义红 text-sem-r、正文 text-1/2/3）',
  'bare-any': '禁用裸 any：外部数据用 unknown + 类型守卫、schema 推导类型或既有契约收窄，不要用 any/宽 cast 掩盖不确定性',
  'i18n-dynamic-key':
    "i18n key 必须是源码里的字面量（i18n Ally WYSIWYG）：写全 t('ns:literal.key')；enum→copy 用 reasonMap 形状（map 值是字面 t() 调用、按变量索引），只有无界后端串才可用动态 key + defaultValue",
  'i18n-hardcoded-cjk': "JSX 文本禁硬编码中文：抽成 t('ns:literal.key') 走 i18n",
}

// 在一行新增代码里收集某类违规的所有命中（matchAll，一行多违规全列）
const collectMatches = (added, file, kind, regex, { requireClassContext = false } = {}) => {
  const found = []
  for (const match of added.matchAll(regex)) {
    if (requireClassContext && !inClassContext(added, match.index)) continue
    found.push({ file, kind, token: match[0].trim(), line: added.trim().slice(0, 160) })
  }
  return found
}

// 从 unified diff 抽出违规：只看新增行（+ 开头，排除 +++ 头），按当前所属文件归类
export const scanDiffForViolations = (diffText) => {
  const violations = []
  let currentFile = null
  let isCodeFile = false
  let isTsFile = false
  let isJsxFile = false

  for (const line of String(diffText || '').split('\n')) {
    if (line.startsWith('+++ ')) {
      // 形如 `+++ b/apps/web/src/x.tsx`（或 /dev/null）
      currentFile = line.replace(/^\+\+\+ (?:b\/)?/, '').trim()
      isCodeFile = currentFile !== '/dev/null' && CODE_FILE_RE.test(currentFile)
      isTsFile = TS_FILE_RE.test(currentFile)
      isJsxFile = JSX_FILE_RE.test(currentFile)
      continue
    }
    if (!isCodeFile) continue
    if (!line.startsWith('+') || line.startsWith('+++')) continue

    const added = line.slice(1)
    if (isCommentLine(added)) continue // 注释行不算规范违规（散文里的 token/中文常见）

    violations.push(...collectMatches(added, currentFile, 'arbitrary-value', ARBITRARY_RE, { requireClassContext: true }))
    violations.push(...collectMatches(added, currentFile, 'invalid-color-class', BARE_COLOR_RE, { requireClassContext: true }))
    if (isTsFile) violations.push(...collectMatches(added, currentFile, 'bare-any', BARE_ANY_RE))
    if (isTsFile) violations.push(...collectMatches(added, currentFile, 'i18n-dynamic-key', I18N_DYNAMIC_KEY_RE))
    if (isJsxFile) violations.push(...collectMatches(added, currentFile, 'i18n-hardcoded-cjk', JSX_CJK_RE))
  }
  return violations
}

// 违规清单 → 给 AI 的纠正说明（列出 file/token/建议），供 worker 二次修复 prompt 用
export const formatViolations = (violations) =>
  violations
    .map((v, i) => {
      const advice = ADVICE[v.kind] || '请对照 ~/.ai-rules/skills/coding-quality 修正'
      return `${i + 1}. [${v.kind}] ${v.file}：\`${v.token}\` → ${advice}\n   所在行：${v.line}`
    })
    .join('\n')
