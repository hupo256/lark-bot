/**
 * 缺陷单只改了注释 / 文档却报「已修复」（11-05 b3 ep-1029-8aca6e 781b1b74）：空 @ 带截图问「OL 为什么没有 bbsv2 请求」判成 bug·change，
 * 执行器查清了根因（HEAD 里配置早就有，要等 online 重新打包发布），却顺手改了一处注释和部署文档，群里说「地址我们已经补好」。
 * 注释 / 文档改动修不了缺陷：done 前看一眼实测 diff，只有注释 / 文档的就续同一会话一次，让它二选一——
 * 代码本来就对 / 根因不在能改的代码 → 还原、按 no_change_needed 说清原因和要谁做什么；真有会运行的代码要改 → 改了再交。
 * 只管缺陷单（契约 defect）：需求单可能就是要改文案注释 / 文档，不拦。只 claude 有会话可续；续失败按原结果走（原有闸照旧）。
 */

import { execAiExecutor } from './lark-ai-executor.mjs'
import { egressScopeOf } from './lark-egress-policy.mjs'
import { detailDocOf } from './lark-run-report.mjs'
import { isCompletedAiStatus } from './lark-status-meta.mjs'

const DOC_PATH_RE = /\.(?:md|mdx|markdown|txt|rst|adoc)$/i
// 认得出整行注释的源码（其余类型——json / yaml / 配置——一行改动就算会运行的）。
const COMMENTABLE_RE = /\.(?:[cm]?[jt]sx?|vue|svelte|css|scss|less|html)$/i
const COMMENT_LINE_RE = /^(?:\/\/|\/\*|\*|<!--|-->|\{\s*\/\*)/

// git diff 文本 → 每个文件是不是只动了文档 / 整行注释 / 空行。二进制、改权限、改名都算会运行的。纯函数。
export const cosmeticDiff = (diffText) => {
  const files = []
  let current = null
  for (const line of String(diffText || '').split('\n')) {
    const header = line.match(/^diff --git a\/.+? b\/(.+)$/)
    if (header) {
      current = { path: header[1], functional: false, inHunk: false }
      files.push(current)
      continue
    }
    if (!current) continue
    if (!current.inHunk) {
      if (line.startsWith('@@')) current.inHunk = true
      else if (/^(?:Binary files |old mode |new mode |rename from |copy from )/.test(line)) current.functional = true
      continue
    }
    if (!/^[+-]/.test(line) || DOC_PATH_RE.test(current.path)) continue // 后面的 @@ 头、上下文行、「\ No newline」都不以 +/- 开头
    const body = line.slice(1).trim()
    if (body && !(COMMENTABLE_RE.test(current.path) && COMMENT_LINE_RE.test(body))) current.functional = true
  }
  return { cosmetic: files.length > 0 && files.every((file) => !file.functional), files: files.map((file) => file.path) }
}

export const buildCosmeticFixPrompt = ({ files }) => `这单是报上来的缺陷，但你这轮实际改动只有注释 / 文档（${files.join('、')}），没改任何会运行的代码——这样修不了它，不能说成已修复 / 已补好 / 改好了。二选一，整份重写结果文件：
1. 查下来代码本来就对、或根因不在这次能改的代码（等发布 / 部署、配置、后端）：用 git checkout 还原这些改动，status 写 no_change_needed，noChangeReason 和 groupReply 说清查到的原因、要谁做什么（如「代码已有，要重新打包发布才生效」），不说修好了。
2. 确实还有会运行的代码要改：只改原任务范围内的，改完照常写 done。`

// 返回 true = 续过会话、结果已换成改过的；false = 不是缺陷单 / 没报完成 / 有会运行的改动 / 没会话可续 / 续失败。diffOf 现取 diff（git diff HEAD）。
export const runCosmeticFixPass = async ({ task, aiRun, diffOf, exec = execAiExecutor, ...execOptions }) => {
  if (task?.contract?.defect !== true || !isCompletedAiStatus(aiRun?.result?.status) || !aiRun.sessionId || aiRun.executor !== 'claude') return false
  const diff = cosmeticDiff(diffOf())
  if (!diff.cosmetic) return false
  console.warn(`[lark-worker] ${task.id} 缺陷单只改了注释 / 文档（${diff.files.join('、')}），续会话改口一次`)
  try {
    const pass = await exec({ ...execOptions, executor: aiRun.executor, promptText: buildCosmeticFixPrompt(diff), resumeSessionId: aiRun.sessionId, egressScope: egressScopeOf(task) })
    if (typeof pass?.result?.status !== 'string' || typeof pass.result.summary !== 'string' || !pass.result.summary.trim()) return false
    aiRun.result = { ...pass.result, detailDoc: detailDocOf(pass.result) || detailDocOf(aiRun.result) }
    return true
  } catch (error) {
    console.warn(`[lark-worker] ${task.id} 只改注释 / 文档的改口失败（按原结果走）：${String(error?.message || error).slice(0, 160)}`)
    return false
  }
}
