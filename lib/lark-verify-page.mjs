/**
 * 页面验证工具（tools/verify-page.mjs）在 bot 里的接入点（aven 2026-10-23「确保准确的基础上提速」）。
 * 提示词里给模型的命令、证据核对认的调用都从这里取，工具换路径只改一处。
 * 纯数据：提示词规则会被 gateway 间接引用，这里不能碰子进程（gateway 纯度闸）；收尾停服务在 lark-verify-page-stop（只给 worker）。
 */

import { join } from 'node:path'

import { larkBotRoot } from './lark-paths.mjs'

export const VERIFY_PAGE_TOOL = join(larkBotRoot, 'tools', 'verify-page.mjs')

// 给模型的命令前缀；profile.verify.pageTool 可覆盖（换机器 / 换工具时用）。
export const pageToolOf = (verify) => verify?.pageTool || `node ${VERIFY_PAGE_TOOL}`
