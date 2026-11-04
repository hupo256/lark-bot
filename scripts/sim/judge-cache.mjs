/**
 * 裁判结论缓存（docs/falive-replay-design-v2.md §5「裁判」2：模型只判有变化的）。
 * 键 = case id + lark-bot 输出指纹（judge-rules.mjs）+ 裁判提示版本 + 参照（none / gold:<金标准条目指纹>；v3 起有模拟局限旗标的再接 |lim:<旗标指纹>，
 * 旗标规则（sim-limits.mjs）改了、这条的旗标 / 原因跟着变，喂给裁判的提示就变了，旧结论不复用）。
 * 落盘：runtime/falive-replay/judge-cache/<提示版本>/<case id>.jsonl，每判一次追加一行（中途断了不丢）。
 * 复用：同键、且缓存那次的 effort 不低于这次要求的（max 判过的 high 能用；high 判过的 max 要重判）；同键多行取最后一行。
 */
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { replayRoot } from './falive-data.mjs'
import { readJsonl } from './sim-dir.mjs'

export const EFFORT_RANK = { low: 1, medium: 2, high: 3, xhigh: 4, max: 5 }
export const cacheDir = (promptVersion, root = replayRoot) => join(root, 'judge-cache', promptVersion)
const fileOf = (promptVersion, id, root) => join(cacheDir(promptVersion, root), `${id}.jsonl`)

/** 金标准条目的指纹：金标准改了（aven 改判 / 改理想做法），带金标准参照的结论就不再复用。 */
export const goldRefOf = (gold) => (gold ? `gold:${createHash('sha256').update(JSON.stringify([gold.better, gold.ideal || '', gold.reviewedFingerprint || ''])).digest('hex').slice(0, 10)}` : 'none')

/** 参照接上模拟局限旗标指纹（没有旗标不变，v2 的缓存键照旧）。 */
export const withLimitsRef = (ref, simLimits = []) => (simLimits.length ? `${ref}|lim:${createHash('sha256').update(JSON.stringify(simLimits.map((x) => [x.flag, x.why]))).digest('hex').slice(0, 10)}` : ref)

export const lookupVerdict = ({ id, fingerprint, promptVersion, ref = 'none', effort = 'high', root = replayRoot }) => {
  const want = EFFORT_RANK[effort] || EFFORT_RANK.high
  const rows = readJsonl(fileOf(promptVersion, id, root)).filter((r) => r.fingerprint === fingerprint && (r.ref || 'none') === ref && (EFFORT_RANK[r.effort] || 0) >= want)
  return rows.length ? rows[rows.length - 1] : null
}

export const storeVerdict = ({ id, fingerprint, promptVersion, ref = 'none', effort, model, verdict, sim, root = replayRoot }) => {
  mkdirSync(cacheDir(promptVersion, root), { recursive: true })
  const row = { id, fingerprint, promptVersion, ref, effort, model, sim, judgedAt: new Date().toISOString(), verdict }
  appendFileSync(fileOf(promptVersion, id, root), `${JSON.stringify(row)}\n`)
  return row
}
