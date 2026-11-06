// 测试用的最小业务仓：按 falive 规则路由表造出仓内规则文件（CLAUDE.md 必读两节、add-module、msw-policy），
// 让依赖规则上下文的测试不依赖本机真有某个业务仓。返回目录，用完自己删。
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { allRuleRefs } from '../../lib/lark-rule-context.mjs'

export const makeRuleRepo = () => {
  const dir = mkdtempSync(join(tmpdir(), 'lark-rule-repo-'))
  const byFile = new Map()
  for (const ref of allRuleRefs('falive', { repoRoot: dir })) {
    if (!ref.file.startsWith(dir)) continue
    if (!byFile.has(ref.file)) byFile.set(ref.file, [])
    byFile.get(ref.file).push(ref.heading)
  }
  for (const [file, headings] of byFile) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `# Doc\n\n${headings.map((heading) => `${heading}\n\n${heading} 的正文\n`).join('\n')}`)
  }
  return dir
}
