/**
 * 实战反馈记账（aven 11-05，docs/plan/plan-iteration-2026-11-05.md 批 1.2 / 1.3）。不再离线回放，改靠线上反馈驱动修复，
 * 两本账都是 jsonl 追加写（同步、无子进程，gateway 纯度闸放行）：
 *   纠错清单 runtime/lark-corrections.jsonl：负责人私信「纠错 …」/「这条不对：<消息链接或 id> …」一条一行，带当时能对上的任务快照，
 *     攒一批集中分诊修；修过的样本进分类回归集（批 1.4）。
 *   决策日志 runtime/lark-decisions.jsonl：负责人在私信主通道对 bot 的每次拍板（放行草稿 / 改了再发 / 不做 / 续跑 / 指示）一条一行，
 *     是「像不像他」的数据底座（批 4：直接采纳率 = 放行 ÷（放行 + 改了再发））。
 * node --test 下没指定路径就不落盘（同发件簿口径），免得单测写进真实运行态。记账失败只记日志，绝不挡私信处理。
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'

import { larkCorrectionsPath, larkDecisionsPath } from './lark-paths.mjs'

const resolvePath = (path, fallback, envKey) => {
  if (path) return path
  if (process.env[envKey]) return process.env[envKey]
  if (process.env.NODE_TEST_CONTEXT) return null
  return fallback
}

const append = (path, record, log) => {
  if (!path) return false
  try {
    appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 })
    return true
  } catch (error) {
    log(`[lark-feedback] 记账写失败（忽略）：${String(error?.message || error).slice(0, 120)}`)
    return false
  }
}

const readJsonl = (path, sinceMs) => {
  if (!path || !existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try {
      const record = JSON.parse(line)
      return Date.parse(record.at || '') >= sinceMs ? [record] : []
    } catch {
      return []
    }
  })
}

// ── 纠错入口 ───────────────────────────────────────────────

// 只认明说的两种写法（单说「不对，应该是 508 账号」是对上一条通知的补料，照旧走私信主通道）：
//   ①「纠错」开头（纠错：/ 纠错 / 【纠错】）；
//   ②「这条 / 这个 / 那条 / 那个 / 上面那条 不对 / 错了 / 有问题」开头，且带了消息链接或消息 id（om_…）。
const CORRECTION_PREFIX_RE = /^[【\[]?\s*纠错\s*[】\]]?\s*[:：，,\s]*/
const DEICTIC_WRONG_RE = /^(?:这条|这个|那条|那个|上面那条|刚才那条)\s*(?:回复|回答|结论)?\s*(?:不对|错了|有问题|答错了|不准)/
const MESSAGE_ID_RE = /\bom_[A-Za-z0-9]+/g
const LINK_RE = /https?:\/\/[^\s，。,）)】]+/g

export const parseCorrection = (text) => {
  const value = String(text || '').replace(/@[^\s@]+/g, ' ').trim()
  if (!value) return null
  const links = value.match(LINK_RE) || []
  const messageIds = [...new Set(value.match(MESSAGE_ID_RE) || [])]
  if (CORRECTION_PREFIX_RE.test(value)) {
    const body = value.replace(CORRECTION_PREFIX_RE, '').trim()
    return body ? { body, links, messageIds } : null
  }
  if (DEICTIC_WRONG_RE.test(value) && (links.length || messageIds.length)) return { body: value, links, messageIds }
  return null
}

const clip = (text, max) => {
  const value = String(text || '').trim()
  return value.length > max ? `${value.slice(0, max)}…` : value
}

// 纠错当时能对上的任务快照：分诊时任务库早清了（24 小时），这里留够定位的东西。
export const taskSnapshot = (task) => (task ? {
  id: task.id,
  chatId: task.chatId || null,
  chatName: task.chatName || null,
  status: task.status || null,
  deliverable: task.contract?.deliverable || null,
  decision: task.intake?.classification?.decision || null,
  operator: task.operator || null,
  createdAt: task.createdAt || null,
  text: clip(task.text, 1500),
  result: clip(task.outcome?.text || task.result, 1500),
} : null)

export const correctionRecordOf = ({ msg, parsed, task = null, via = null, now = Date.now() }) => ({
  at: new Date(now).toISOString(),
  id: msg.messageId || null,
  from: msg.senderOpenId || null,
  text: clip(msg.text, 2000),
  body: parsed.body,
  links: parsed.links,
  messageIds: parsed.messageIds,
  via, // 任务怎么对上的：message（链接 / id 点名）/ reply（引用了 bot 的私信）/ null（没对上，分诊时按链接再查）
  task: taskSnapshot(task),
  status: 'open',
})

export const appendCorrection = (record, { path = null, log = console.warn } = {}) => append(resolvePath(path, larkCorrectionsPath, 'LARK_CORRECTIONS_PATH'), record, log)
export const readCorrections = ({ path = null, sinceMs = 0 } = {}) => readJsonl(resolvePath(path, larkCorrectionsPath, 'LARK_CORRECTIONS_PATH'), sinceMs)

// ── 决策日志 ───────────────────────────────────────────────

// kind：release（「就这样回」放行草稿 = 直接采纳）/ revise（草稿扣着时给了别的指示 = 改了再发）/ decline（不做 / 归别人，结单）/
// resume（挂起单续跑）/ instruct（对在答 / 答过的单下指示）/ correct（纠错：已发出的结论不对，当场重答）。
export const DECISION_KINDS = Object.freeze(['release', 'revise', 'decline', 'resume', 'instruct', 'correct'])

export const decisionRecordOf = ({ kind, msg, task, draft = null, now = Date.now() }) => ({
  at: new Date(now).toISOString(),
  kind,
  messageId: msg?.messageId || null,
  text: clip(msg?.text, 1000),
  taskId: task?.id || null,
  chatId: task?.chatId || null,
  summary: clip(task?.summary, 120),
  status: task?.status || null,
  ...(draft ? { draft: clip(draft, 1500) } : {}),
})

export const appendDecision = (record, { path = null, log = console.warn } = {}) => append(resolvePath(path, larkDecisionsPath, 'LARK_DECISIONS_PATH'), record, log)
export const readDecisions = ({ path = null, sinceMs = 0 } = {}) => readJsonl(resolvePath(path, larkDecisionsPath, 'LARK_DECISIONS_PATH'), sinceMs)

// 直接采纳率：放行 ÷（放行 + 改了再发）；两样都没有为 null（不编 0%）。
export const adoptionOf = (decisions = []) => {
  const release = decisions.filter((d) => d.kind === 'release').length
  const revise = decisions.filter((d) => d.kind === 'revise').length
  return { release, revise, rate: release + revise ? release / (release + revise) : null }
}
