/**
 * bug 防撞车（aven 2026-11-01，docs/plan/plan-bug-workflow-2026-11-01.md B3，从 falive bugpoll 的 hotfix.sh 搬来的两件）：
 *   · 占用标记：负责人在会话里手动修某单时私信「我在修 BUG-7561」，bot 遇到这单就跳过；「修完了 / 放手 BUG-7561」解除，
 *     「认领列表」查看。标记 7 天自动过期（忘了解除也不会永远挡住）。文件 runtime/lark-bug-claims.json，gateway 写、poller 读。
 *   · 查重在 lark-bug-dedupe.mjs（要跑 git，只给 poller 用，不进 gateway 闭包）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { writeJsonAtomic } from './lark-fs.mjs'
import { larkRuntimeDir } from './lark-paths.mjs'

export const CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const claimsPath = () => join(process.env.LARK_RUNTIME_DIR || larkRuntimeDir, 'lark-bug-claims.json')

export const loadClaims = ({ path = claimsPath() } = {}) => {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).claims || {} : {}
  } catch {
    return {}
  }
}
export const saveClaims = (claims, { path = claimsPath() } = {}) => writeJsonAtomic(path, { claims })

const BUG_NO_RE = /\bBUG-\d+\b/i
export const normalizeBugNo = (text) => (BUG_NO_RE.exec(String(text || ''))?.[0] || '').toUpperCase()

/** 「我在修 / 我来修 BUG-x」→ claim；「修完了 / 放手 / 不修了 BUG-x」→ release；「认领列表」→ list。 */
export const parseClaimDirective = (text) => {
  const input = String(text || '').trim()
  if (/^(?:认领列表|我在修的|占用列表)$/.test(input)) return { action: 'list' }
  const bugNo = normalizeBugNo(input)
  if (!bugNo) return null
  const rest = input.replace(BUG_NO_RE, '').trim()
  if (/^(?:我在修|我来修|我修|认领)$/.test(rest)) return { action: 'claim', bugNo }
  if (/^(?:修完了|修好了|放手|不修了|取消认领)$/.test(rest)) return { action: 'release', bugNo }
  return null
}

export const activeClaims = (claims, now = Date.now()) =>
  Object.fromEntries(Object.entries(claims).filter(([, c]) => now - Date.parse(c.at || 0) < CLAIM_TTL_MS))

export const isClaimed = (claims, bugNo, now = Date.now()) => Boolean(bugNo && activeClaims(claims, now)[normalizeBugNo(bugNo)])

export const formatClaimList = (claims, now = Date.now()) => {
  const rows = Object.entries(activeClaims(claims, now)).sort(([a], [b]) => a.localeCompare(b))
  if (!rows.length) return '现在没有你在手动修的单。私信「我在修 BUG-xxxx」我就跳过它。'
  return [`你在手动修的单（${rows.length} 条，bot 会跳过；7 天后自动失效）：`, ...rows.map(([bugNo, c]) => `- ${bugNo}（自 ${String(c.at).slice(5, 16).replace('T', ' ')}）`)].join('\n')
}
