/**
 * 部署后 SEO 爬虫检查（aven 2026-10-29，教训 #95 / #96）：探到 pre 部署时 bot 自己跑业务仓 scripts/seo-check.mjs，
 * 和上次的 ❌ 比，只在有变化时报——已知卡点（如 pre SSR 内网回源不通）没修好之前不每次都报一遍。
 * 原来是让复测执行器自己跑 `pnpm quality:seo`、每次原样写进 summary，同一批 ❌ 天天重复。
 * gateway 侧：只用异步子进程（gateway 纯度）。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { execAsync } from './lark-daily-sweep.mjs'

const SEO_SCRIPT = 'scripts/seo-check.mjs'

/** 脚本输出里的 ❌ 行（去掉末尾「N 项不通过」汇总）。 */
export const parseSeoFails = (stdout = '') => stdout.split('\n')
  .map((line) => line.trim())
  .filter((line) => line.startsWith('❌ ') && !/^❌ \d+ 项不通过$/.test(line))
  .map((line) => line.slice(2).trim())

// 比对口径：样本页的编号每次抽的不一样（/hc/news/98 → /hc/news/16），路径里的编号抹掉再比；状态码等其它数字照比。
const keyOf = (line) => line.replace(/\/\d+/g, '/#')

/** 和上次比：新增 / 消失（按抹掉编号后的口径）。 */
export const diffSeoFails = ({ prev = [], fails = [] }) => {
  const before = new Set(prev.map(keyOf))
  const after = new Set(fails.map(keyOf))
  return {
    added: fails.filter((line) => !before.has(keyOf(line))),
    resolved: prev.filter((line) => !after.has(keyOf(line))),
  }
}

/** 跑业务仓的检查脚本；业务仓没有这个脚本返回 null，脚本跑挂（不是检查不通过）返回 { error }。 */
export const runSeoCheck = async ({ profile, siteUrl, exec = execAsync }) => {
  if (!profile.root) return null
  const script = join(profile.root, SEO_SCRIPT)
  if (!existsSync(script)) return null
  const out = await exec('node', [script, '--base', siteUrl.replace(/\/+$/, '')], { timeout: 5 * 60_000 })
  const fails = parseSeoFails(out.stdout)
  if (!out.ok && !fails.length) return { error: (out.stderr || out.stdout).trim().slice(0, 200) }
  return { fails }
}

const list = (lines) => lines.slice(0, 8).join('；')

/**
 * 写进复测任务的一段（null = 不用提）。已知卡点不变 → 告诉执行器别再报；有变化 → 要求 summary 写一行。
 */
export const seoRetestNote = ({ seo, prev = [], siteUrl }) => {
  if (!seo) return null
  if (seo.error) return `SEO 爬虫检查 bot 没跑成（${seo.error}）：在业务仓手动跑 \`pnpm quality:seo --base ${siteUrl.replace(/\/+$/, '')}\`，有 ❌ 写进 summary。`
  const { added, resolved } = diffSeoFails({ prev, fails: seo.fails })
  if (!added.length && !resolved.length) {
    return seo.fails.length ? `SEO 爬虫检查 bot 已跑：和上次一样的 ${seo.fails.length} 个已知问题，没变化，不用再查、summary 不写。` : null
  }
  const parts = [added.length ? `新增 ${list(added)}` : '', resolved.length ? `已消失 ${list(resolved)}` : ''].filter(Boolean).join('；')
  return `SEO 爬虫检查 bot 已跑、和上次比有变化：${parts}。summary 写一行「SEO 爬虫检查：…」说清变化${added.length ? '，新增的算一项不通过（503 / 详情页回落默认标题多半是 SSR 回源不通，写进待对接文档找后端 / 运维）' : ''}。`
}

/** 没建复测任务（只改了文档的部署）但 SEO 结果变了：单独私信一句。不变返回 null。 */
export const seoChangeMessage = ({ seo, prev = [], label }) => {
  if (!seo?.fails) return null
  const { added, resolved } = diffSeoFails({ prev, fails: seo.fails })
  if (!added.length && !resolved.length) return null
  if (!seo.fails.length) return `pre（${label}）SEO 爬虫检查已恢复，全部通过。`
  return `pre（${label}）SEO 爬虫检查有变化：${[added.length ? `新增 ${list(added)}` : '', resolved.length ? `已消失 ${list(resolved)}` : ''].filter(Boolean).join('；')}。`
}
