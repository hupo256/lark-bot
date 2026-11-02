#!/usr/bin/env node
/**
 * 查各环境当前跑的是哪个提交（只读）：给 worker 里的 AI 答「pre 现在跑的哪个版本 / test 和 pre 一样吗」用，也可以手动跑。
 *
 * 用法：node tools/env-version.mjs [环境…] [--no-fetch] [--json]
 *   环境缺省 = runtime/lark-bot.local.json 的 envSites 全部（dev / test / pre / online …）。
 *   每个环境：抓 <站点>/version（老站 apps/web 的构建版本）和首页 HTML 里的 /wn/<sha>/（新站 web-next 的构建版本），
 *   再到 fameex-web 主仓（lark-paths consumerRoot）里核这个提交在不在对应分支上、落后分支最新几个。
 *   --no-fetch 不 git fetch（离线 / 赶时间）；环境 → 分支默认同名，config.envBranches 可覆盖。
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

import { branchForEnv, describeBuild, parseLegacyVersion, parseWebNextCommit } from '../lib/lark-env-version.mjs'
import { consumerRoot, larkLocalConfigPath } from '../lib/lark-paths.mjs'

const args = process.argv.slice(2)
let config = {}
try {
  config = JSON.parse(readFileSync(larkLocalConfigPath, 'utf8'))
} catch {
  config = {}
}
const sites = config.envSites || {}
const wanted = args.filter((arg) => !arg.startsWith('--'))
const envs = (wanted.length ? wanted : Object.keys(sites)).filter((env) => sites[env])
if (!envs.length) {
  console.error(`没有可查的环境：runtime/lark-bot.local.json 的 envSites 里有 ${Object.keys(sites).join(' / ') || '（空）'}`)
  process.exit(1)
}

const get = async (url) => {
  try {
    const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (lark-bot env-version)' }, redirect: 'follow', signal: AbortSignal.timeout(10_000) })
    return response.ok ? await response.text() : ''
  } catch {
    return ''
  }
}
const git = (gitArgs) => {
  const result = spawnSync('git', ['-C', consumerRoot, ...gitArgs], { encoding: 'utf8', timeout: 60_000 })
  return { ok: result.status === 0, out: (result.stdout || '').trim() }
}
const branches = [...new Set(envs.map((env) => branchForEnv(env, config.envBranches)))]
if (!args.includes('--no-fetch')) git(['fetch', '--quiet', 'origin', ...branches])
const commitInfo = (sha, branch) => {
  const log = git(['log', '-1', '--date=format-local:%m-%d %H:%M', '--format=%h|%cd|%an|%s', sha])
  if (!log.ok || !log.out) return { found: false }
  const [, date, author, subject] = log.out.split('|')
  const onBranch = git(['merge-base', '--is-ancestor', sha, `origin/${branch}`]).ok
  const behind = onBranch ? Number(git(['rev-list', '--count', `${sha}..origin/${branch}`]).out) : null
  return { found: true, date, author, subject: subject?.slice(0, 80), onBranch, behind }
}

const rows = []
for (const env of envs) {
  const site = String(sites[env]).replace(/\/+$/, '')
  const branch = branchForEnv(env, config.envBranches)
  const [versionPage, homePage] = await Promise.all([get(`${site}/version`), get(`${site}/zh-CN/login`)])
  const legacy = parseLegacyVersion(versionPage)
  const webNext = parseWebNextCommit(homePage)
  rows.push({
    env, site, branch,
    legacy: { sha: legacy, ...(legacy ? { info: commitInfo(legacy, branch) } : {}) },
    webNext: { sha: webNext, ...(webNext ? { info: commitInfo(webNext, branch) } : {}) },
  })
}

if (args.includes('--json')) console.log(JSON.stringify(rows, null, 2))
else {
  for (const row of rows) {
    console.log(`${row.env}（${row.site}，对应分支 ${row.branch}）`)
    console.log(`  - ${describeBuild({ label: '老站 apps/web', sha: row.legacy.sha, branch: row.branch, info: row.legacy.info })}`)
    console.log(`  - ${describeBuild({ label: '新站 web-next', sha: row.webNext.sha, branch: row.branch, info: row.webNext.info })}`)
  }
  const offset = -new Date().getTimezoneOffset() / 60
  console.log(`说明：时间是本机时区（UTC${offset >= 0 ? '+' : ''}${offset}）；版本取自构建时写进站点的 git describe（老站 /version 页、新站静态资源路径 /wn/<sha>/）；一个环境可能只部署了其中一个站。`)
}
