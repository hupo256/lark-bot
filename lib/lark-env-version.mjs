/**
 * 各环境当前跑的版本（aven 11-02「把各环境怎么部署、怎么看版本写成固定知识给 bot」）。纯函数；IO 在 tools/env-version.mjs。
 *
 * fameex-web 的两个站点都把构建时的 git 版本带出来了（apps/*\/infra/<ENV>/Jenkinsfile：`GIT_VER=$(git describe --tags --always)`）：
 *   老站 apps/web（Next）：`<站点>/version` 页面打印 `Version: <短 sha>`（apps/web/src/app/version/page.tsx，next.config env.gitVersion）；
 *   新站 apps/web-next：静态资源路径 `cdn.<域名>/wn/<短 sha>/…`（vite base = webAssetBasePath），在页面 HTML 里能看到。
 * 一个环境可能只部署了其中一个（11-02 实测：pre / online 还没有 web-next）。
 */

// 老站 /version：React 会在文本和变量之间插 <!-- -->。
export const parseLegacyVersion = (html) => {
  const match = String(html || '').match(/Version:\s*(?:<!--\s*-->)?\s*([0-9a-f]{7,40})\b/i)
  return match ? match[1].toLowerCase() : null
}

// 新站资源路径 /wn/<sha>/；只认像 sha 的段（7–40 位十六进制）。
export const parseWebNextCommit = (html) => {
  const match = String(html || '').match(/\/wn\/([0-9a-f]{7,40})\//i)
  return match ? match[1].toLowerCase() : null
}

// 环境 → 分支：默认同名，online 对 online；config.envBranches 可覆盖（如 { prod: 'online' }）。
export const branchForEnv = (env, envBranches = {}) => envBranches?.[env] || env

// 一个构建版本对上分支后的人话：在分支最新 / 落后 N 个 / 不在该分支上。
export const describeBuild = ({ label, sha, branch, info }) => {
  if (!sha) return `${label}：没查到`
  if (!info?.found) return `${label} ${sha}：本地仓库里找不到这个提交（先 git fetch，或不是这个仓库构建的）`
  const head = info.onBranch == null
    ? `（没核 origin/${branch}）`
    : info.onBranch
      ? (info.behind === 0 ? `= origin/${branch} 最新` : `比 origin/${branch} 最新落后 ${info.behind} 个提交`)
      : `不在 origin/${branch} 上（手动选了别的分支部署？）`
  return `${label} ${sha} ${head}；这个提交：${info.date} ${info.author}「${info.subject}」`
}
