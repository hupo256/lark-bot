/**
 * 「sim 目录」抽象（docs/falive-replay-design-v2.md §2、§5）：裁判 / 规则预判 / 金标准 / 验收都只认这一层，不关心布局。
 * 一个 sim 目录 = 一个 lark-bot 实例跑完的产物：fed.json（喂了哪些消息）、outbox.jsonl（bot 发了什么）、
 * runtime/lark-tasks/*.json（任务）、runtime/lark-audits/<项目>/<任务>-e<代>.json（审计）；另读 meta.json、egress.log（模拟局限旗标、裁判的出网证据）。
 * 两种布局都认：
 *   旧：runtime/falive-replay/sim/<名>/            （按天 / 分段，r11-a、full-a …）
 *   新：runtime/falive-replay/sim/<轮>/<事件组 id>/  （按事件组，ep-1014-c631b0 …）
 * 选目录：--dir <路径>（本身是 sim 目录，或它下面一层是）/ --sim <名>（sim/<名>；不是 sim 目录就取下一层，即新布局的一轮）/
 *   --round <轮>（新布局 sim/<轮>/* 加旧布局 sim/<轮>-*）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'

import { replayRoot } from './falive-data.mjs'

export const simRoot = () => join(replayRoot, 'sim')
export const isSimDir = (dir) => existsSync(join(dir, 'fed.json'))
const subdirs = (dir) => (existsSync(dir) ? readdirSync(dir).filter((n) => !n.startsWith('.')).map((n) => join(dir, n)).filter((p) => { try { return statSync(p).isDirectory() } catch { return false } }).sort() : [])

const entryOf = (dir) => {
  const root = simRoot()
  const rel = relative(root, dir)
  const label = rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : dir
  const name = basename(dir)
  const parts = label.split('/')
  // 新布局：<轮>/<事件组>；事件组 id 以 ep- 开头（scripts/sim/episodes.mjs）
  const episodeId = /^ep-/.test(name) ? name : null
  const round = episodeId && parts.length >= 2 ? parts[parts.length - 2] : (name.match(/^(r\d+[a-z]*|[a-z]+)-/)?.[1] || null)
  return { dir, label, round, episodeId }
}

const expand = (dir) => (isSimDir(dir) ? [dir] : subdirs(dir).filter(isSimDir))

/** 按命令行选 sim 目录；返回 [{ dir, label, round, episodeId }]，按 label 排序、去重。 */
export const listSimDirs = ({ dir = null, sim = null, round = null } = {}) => {
  const root = simRoot()
  const dirs = []
  if (dir) dirs.push(...expand(resolve(dir)))
  if (sim) dirs.push(...expand(join(root, sim)))
  if (round) {
    dirs.push(...expand(join(root, round)).filter((d) => d !== join(root, round)))
    dirs.push(...subdirs(root).filter((d) => basename(d).startsWith(`${round}-`) && !basename(d).includes('.') && isSimDir(d)))
  }
  const seen = new Set()
  return dirs.filter((d) => !seen.has(d) && seen.add(d)).map(entryOf).sort((a, b) => a.label.localeCompare(b.label))
}

/** 命令行三选一的公共解析：--dir / --sim / --round。 */
export const simSelectorFromArgs = (args) => {
  const value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null)
  return { dir: value('--dir'), sim: value('--sim'), round: value('--round') }
}

export const readJsonl = (path) => (existsSync(path)
  ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  : [])
const readJsonOr = (path, fallback) => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return fallback } }

/** 读一个 sim 目录的产物（只读）。 */
export const loadSim = (entry) => {
  const { dir } = entry
  const fed = readJsonOr(join(dir, 'fed.json'), [])
  const outbox = readJsonl(join(dir, 'outbox.jsonl')).sort((a, b) => (a.at || 0) - (b.at || 0))
  const tasks = new Map()
  const tasksDir = join(dir, 'runtime', 'lark-tasks')
  if (existsSync(tasksDir)) for (const f of readdirSync(tasksDir)) {
    if (!f.endsWith('.json')) continue
    const t = readJsonOr(join(tasksDir, f), null)
    if (t?.id) tasks.set(t.id, t)
  }
  // 并入别的任务的消息：对方 task.mergedFrom 里有它的 id（或本单 superseded 且记了 supersededBy）。
  const mergedInto = new Map()
  for (const t of tasks.values()) for (const from of t.mergedFrom || []) mergedInto.set(from, t.id)
  for (const t of tasks.values()) if (t.status === 'superseded' && t.supersededBy && !mergedInto.has(t.id)) mergedInto.set(t.id, t.supersededBy)
  // 审计：每个任务取最后一代里带 final 的（最新一代常是 done 后的空壳，final 为 null），没有就取最新一代。
  const audits = new Map()
  const auditsDir = join(dir, 'runtime', 'lark-audits')
  for (const projectDir of subdirs(auditsDir)) for (const f of readdirSync(projectDir)) {
    const m = f.match(/^(.*)-e(\d+)\.json$/)
    if (!m) continue
    const a = readJsonOr(join(projectDir, f), null)
    if (!a) continue
    const epoch = Number(m[2])
    const prev = audits.get(m[1])
    if (!prev || (a.final && !prev.final) || (Boolean(a.final) === Boolean(prev.final) && epoch > prev.epoch)) audits.set(m[1], { epoch, status: a.status || null, final: a.final || null })
  }
  // meta.hideBotIds：按事件组跑时藏起来的 falive 原话（模拟里由模拟 bot 自己说）
  const meta = readJsonOr(join(dir, 'meta.json'), {})
  // egress.log（scripts/sim/egress-hook.mjs）：整组的出网请求，extra=blocked 是回放拦下的
  const egress = readJsonl(join(dir, 'egress.log'))
  return { ...entry, fed, outbox, tasks, mergedInto, audits, meta, egress, egressBlocked: egress.filter((e) => e.extra === 'blocked') }
}
