/**
 * 环境识别与核对（aven 11-02：「online 的问题却在 pre 复验」不能再出现）。纯函数，网关 / worker 都可用。
 *
 * 1. resolveEnvTargets：从「这条要做什么」的原话（本条消息 + 分类器的一句话概括）里认出点名的环境，按出现顺序；
 *    认法 = 环境名 / 中文叫法（线上 / 正式 / 生产 = online，预发 = pre，测试环境 = test，开发环境 = dev）/ 该环境的域名。
 *    不看上下文包里别人说过的话（最近 20 条里常有别的环境，会串）。
 * 2. envTargetLine：给执行提示的一行硬约束——点名了就只在那个环境测 / 查。
 * 3. checkEnvTarget：拿本轮会话里真打过的地址（collectRunEvidence 的 hosts）核对：点名的环境一个都没打、却打了别的环境 →
 *    mismatch，出口在结论前面明说「这次测的是 X，不是你说的 Y」，并把自称实测通过的条目降成待验证。
 */

const ENV_ORDER = ['online', 'pre', 'uat', 'test', 'dev']

// ASCII 名字两边不能是字母数字（避免 prefix / testing / devtools）；中文叫法直接认。
const ENV_PATTERNS = {
  online: /(?<![A-Za-z0-9])(?:online|prod|production)(?![A-Za-z0-9])|线上|正式环境|正式服|正式站|生产环境|现网/i,
  pre: /(?<![A-Za-z0-9])pre(?![A-Za-z0-9])|预发|预生产|预上线/i,
  uat: /(?<![A-Za-z0-9])uat(?![A-Za-z0-9])/i,
  test: /(?<![A-Za-z0-9])test(?![A-Za-z0-9])\s*(?:环境|服|站)|(?<![A-Za-z0-9])test(?![A-Za-z0-9])(?=\s*(?:、|和|跟|与|\/|,|，|上|里|的|$))|测试环境|测试服|测试站/i,
  dev: /(?<![A-Za-z0-9])dev(?![A-Za-z0-9])\s*(?:环境|服|站)?|开发环境/i,
}

export const hostOf = (url) => {
  try {
    return new URL(/^https?:\/\//i.test(String(url)) ? String(url) : `https://${url}`).hostname.toLowerCase()
  } catch {
    return null
  }
}

// 同一主域的不同子域（www / cmsadmin / futuresadmin …）都算这个环境。
const baseDomain = (host) => String(host || '').split('.').slice(-2).join('.')

// 认环境用的域：主域只归一个环境时用主域（fameex 的 azmgb.com 底下 www / cmsadmin 都是 pre）；几个环境共用主域时只认整个主机名
//（falive 的 falivepre.fdsser.com / faliveuat.fdsser.com 同在 fdsser.com 下，按主域认会把 uat 一律认成排在前面的 pre：
// 11-04 falive 回放 b2 ep-1031-35935b，查的明明是 UAT 前端包，结论开头却警告「这次实际测的是 pre，不是你说的 uat」，后面几条跟着说错）。
const sitesOf = (envSites) => {
  const sites = Object.entries(envSites || {})
    .map(([env, url]) => ({ env, host: hostOf(url), url }))
    .filter((site) => site.host)
  const owners = new Map()
  for (const site of sites) owners.set(baseDomain(site.host), new Set([...(owners.get(baseDomain(site.host)) || []), site.env]))
  return sites.map((site) => ({ ...site, domain: owners.get(baseDomain(site.host)).size > 1 ? site.host : baseDomain(site.host) }))
}
const onDomain = (host, domain) => host === domain || host.endsWith(`.${domain}`)

export const resolveEnvTargets = ({ texts = [], envSites = null } = {}) => {
  const text = texts.filter(Boolean).join('\n')
  if (!text) return []
  const hits = []
  for (const env of ENV_ORDER) {
    const match = ENV_PATTERNS[env].exec(text)
    if (match) hits.push({ env, at: match.index })
  }
  for (const { env, domain } of sitesOf(envSites)) {
    const at = text.toLowerCase().indexOf(domain)
    if (at >= 0 && !hits.some((hit) => hit.env === env)) hits.push({ env, at })
  }
  return hits.sort((a, b) => a.at - b.at).map((hit) => hit.env)
}

export const envTargetLine = ({ targets = [], envSites = null } = {}) => {
  if (!targets.length) return ''
  const url = (env) => envSites?.[env] ? `（${envSites[env]}）` : ''
  const named = targets.map((env) => `${env}${url(env)}`).join('、')
  return `本任务点名的环境：${named}。只在点名的环境测 / 查，结论只说这个环境；别的环境的结果不能顶替，要对比就单列一条写明是哪个环境；report.subject 写明环境名。`
}

// 本轮真打过的环境：hosts 里命中哪个环境的主域。
export const touchedEnvs = ({ hosts = [], envSites = null } = {}) => {
  const sites = sitesOf(envSites)
  const found = []
  for (const host of hosts) {
    const site = sites.find((item) => onDomain(String(host || '').toLowerCase(), item.domain))
    if (site && !found.includes(site.env)) found.push(site.env)
  }
  return found
}

// { ok, mismatch, targets, touched }。没点名 / 没配地址 / 读不到会话（evidence 为 null）/ 本轮没打任何环境 → 不判 mismatch。
export const checkEnvTarget = ({ targets = [], envSites = null, evidence = null } = {}) => {
  const touched = evidence ? touchedEnvs({ hosts: evidence.hosts || [], envSites }) : []
  const mismatch = targets.length > 0 && touched.length > 0 && !touched.some((env) => targets.includes(env))
  return { ok: !mismatch, mismatch, targets, touched }
}

// 不匹配时改写 report：结论前加一句实话，自称实测通过的条目降成待验证（不靠模型自觉）。
export const applyEnvCheck = (report, check) => {
  if (!report || !check?.mismatch) return report
  const warn = `⚠ 这次实际测的是 ${check.touched.join(' / ')}，不是你说的 ${check.targets.join(' / ')}，下面的结论不代表 ${check.targets.join(' / ')}。`
  return {
    ...report,
    answer: report.answer ? `${warn}\n${report.answer}` : warn,
    items: report.items.map((item) => (item.mark === 'ok' ? { ...item, mark: 'unverified' } : item)),
  }
}
