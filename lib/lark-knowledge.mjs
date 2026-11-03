/**
 * 负责人维护的固定知识（aven 11-02「把各环境怎么部署、怎么看版本写成固定知识给 bot」）：runtime/knowledge/*.md（gitignore，
 * 含站点 / 内部流程，同 persona 只留本机），只读答疑 / 实测 / 状态查询的提示里带上，免得每条都去翻仓库重新推一遍（11-02 真机：
 * 「test、pre 代码一样吗」20 次工具调用里 7 次在翻 lark-bot 仓库找部署逻辑，最后还答「确认不了」）。
 * 读不到就没有这块；整块限 maxChars 字，超了截断并注明。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { ENV_VERSION_TOOL, larkKnowledgeDir } from './lark-paths.mjs'

export const KNOWLEDGE_MAX_CHARS = 6000

export const readKnowledge = ({ dir = larkKnowledgeDir, maxChars = KNOWLEDGE_MAX_CHARS } = {}) => {
  if (!existsSync(dir)) return ''
  let text = ''
  try {
    text = readdirSync(dir).filter((name) => name.endsWith('.md')).sort()
      .map((name) => readFileSync(join(dir, name), 'utf8').trim()).filter(Boolean).join('\n\n')
  } catch {
    return ''
  }
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…（固定知识超过 ${maxChars} 字，后面截掉了）` : text
}

// 提示里的数据块：知识原文 + 查版本工具（配了 envSites 才有工具这行）。两样都没有返回 ''。
export const buildEnvKnowledgeBlock = ({ knowledge = '', envSites = null, tool = ENV_VERSION_TOOL } = {}) => {
  const hasSites = Object.values(envSites || {}).some((url) => typeof url === 'string' && url.trim())
  if (!knowledge && !hasSites) return ''
  return [
    '【环境与部署（负责人维护的固定知识）】问环境 / 版本 / 部署 / 两个环境差别时以这里和下面的工具为准，不用去翻 lark-bot 仓库找部署逻辑。',
    // 11-03：群里答案出现过「old site 代码差 129 个文件」——对外统一中文叫法。
    '对外回答里两个站统一叫「老站」「新站」，不写 old site / new site、apps/web、web-next 这类英文或目录名（分支名、提交号照写）。',
    knowledge,
    hasSites ? `查各环境现在跑的是哪个提交：node ${tool} [环境…]（只读，几秒；抓站点上构建时写进去的版本，再核在不在对应分支、落后分支最新几个）。答「X 环境跑的哪个版本 / 两个环境一样吗 / 某改动上没上 X」先跑它，拿结果说话。` : '',
  ].filter(Boolean).join('\n')
}
