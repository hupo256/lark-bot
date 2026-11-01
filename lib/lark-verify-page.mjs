/**
 * 页面验证工具（tools/verify-page.mjs）在 bot 里的接入点（从 falive 移植，aven 2026-10-23「确保准确的基础上提速」）。
 * 提示词里给模型的命令、放行的只读命令都从这里取，工具换路径只改一处。
 * 纯数据：提示词规则会被 gateway 间接引用，这里不能碰子进程（gateway 纯度闸）；收尾停服务在 lark-verify-page-stop（只给 worker）。
 * 配置：runtime/lark-bot.local.json 顶层 `verify`（localDev / compareBase / compareLabel / appHosts / loginModule / pageTool …，见工具文件头）。
 * 不配 `verify` = 行为与以前一样：提示里仍写「不要启动 dev server」。
 */

import { join } from 'node:path'

import { larkBotRoot } from './lark-paths.mjs'

export const VERIFY_PAGE_TOOL = join(larkBotRoot, 'tools', 'verify-page.mjs')

// 给模型的命令前缀；verify.pageTool 可覆盖（换机器 / 换工具时用）。
export const pageToolOf = (verify) => verify?.pageTool || `node ${VERIFY_PAGE_TOOL}`

// 配了 verify 才有的「自己验证」硬规则：改了页面 / 交互要自己在浏览器里看，只用页面工具，不现写 Playwright 脚本。
export const buildPageVerifyRule = (verify) => {
  if (!verify) return ''
  const label = verify.compareLabel || 'pre'
  const compare = verify.compareBase
    ? `，还会和已部署的 ${label}（${verify.compareBase}）同一页比对：「本地新出现」的要处理；「${label} 上也有」的不是本次改动带来的，但要修的正是它就说明没修好`
    : ''
  return `自己验证（硬规则）：
- 改了页面 / 交互，说能不能用前先自己在浏览器里看，不推给 QA 去点。看页面只用页面工具 \`${pageToolOf(verify)}\`，不要自己写 Playwright 脚本：要看页面就先 \`页面工具 start --cwd <当前工作区>\`（后台起本地 dev 服务 \`${(verify.localDev || ['pnpm', 'dev']).join(' ')}\`，和改代码并行）；改完 \`页面工具 check --cwd <当前工作区> [--login] [--expect 应出现的文字]… [--click-sweep] <页面路径>…\`${verify.loginModule ? '（--login 用配置的测试号）' : ''}。已部署的用 \`页面工具 check --base <站点> …\`。收尾由 Worker 自动停服务，不用自己 stop。
- check 会查回落 mock / 页面报错 / 失败请求 / 死控件（--click-sweep）并截图${compare}。看样式就 Read 截图。
- 确实验不了（本地起不来、要的账号 / 数据没有）才在 warnings 里写清卡在哪、找谁；代码写完了照常按完成交付，不因为没验证挂待确认。`
}
