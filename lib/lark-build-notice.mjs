/**
 * 「建置通知」群里 Jenkins Bot 卡片的解析与匹配（纯函数，aven 11-06「部署 dev / test」）。
 *
 * 卡片长这样（lark-cli im +chat-messages-list 的 content）：
 *   <card title="FameEX exchange-web-next 部署成功 ✅">
 *   - 项目名称: exchange-web-next
 *   - 分支: test
 *   - 环境: TEST
 *   - 构建地址: [http://…/job/exchange-web-next-test/217/console](…)
 *   **新增提交**
 *   - Merge branch 'feat/2521-aboutUs' into 'test' (90401e0)
 *   </card>
 * dev / test 合进分支就自动构建并部署，标题是「部署成功 / 失败」；pre / online 是「构建成功」（要人发邮件给 OPS 才部署，这里不管）。
 * 项目名：前台 exchange-web / exchange-web-next，后台 exchange-web-<Label>（projectForLabel；Label 见 lib/lark-gitlab.mjs）。
 */

const field = (text, name) => new RegExp(`^\\s*-\\s*${name}\\s*[:：]\\s*(.+?)\\s*$`, 'm').exec(text)?.[1] || null

/** 一条消息 → 卡片对象；不是 Jenkins 构建卡返回 null。 */
export const parseBuildNotice = (message) => {
  const content = String(message?.content || '')
  const title = /<card title="([^"]*)"/.exec(content)?.[1] || ''
  const head = /^FameEX\s+(\S+)\s+(构建|部署)(成功|失败)/.exec(title)
  if (!head) return null
  const commitsBlock = content.split(/\*\*新增提交\*\*/)[1]?.split(/\*\*相关开发者\*\*|<\/card>/)[0] || ''
  const commits = [...commitsBlock.matchAll(/^\s*-\s*(.+?)\s*\(([0-9a-f]{7,40})\)\s*$/gm)].map((m) => ({ subject: m[1], sha: m[2] }))
  const url = /构建地址\s*[:：]\s*\[?(https?:\/\/[^\]\s)]+)/.exec(content)?.[1] || null
  return {
    messageId: message.message_id || null,
    at: message.create_time || null,
    project: head[1],
    stage: head[2] === '部署' ? 'deploy' : 'build',
    ok: head[3] === '成功',
    branch: field(content, '分支'),
    env: (field(content, '环境') || '').toLowerCase() || null,
    url,
    commits,
  }
}

// 建置通知里的项目名：前台 web / web-next → exchange-web / exchange-web-next，后台 → exchange-web-<Label>
//（11-06 群里实见 exchange-web、exchange-web-next、exchange-web-admin / -futures-admin / -security-admin / -business-system）。
export const projectForLabel = (label) => (/^web(?:-|$)/.test(label) ? `exchange-${label}` : `exchange-web-${label}`)

/**
 * 这次部署（env、合并提交 mergeSha、要等的 Labels）在卡片里的结果：每个 Label 取最新一张「同环境、提交里有 mergeSha」的卡（失败后有人重跑成功，以重跑为准）；
 * isAncestor(sha, cardTopSha) 可选：卡片没列出 mergeSha（被后面的合并一起构建、列表截断）时，按「卡片最新提交包含 mergeSha」认。
 * 返回 { done: { label → card }, pending: [label] }。
 */
export const matchDeployNotices = ({ env, mergeSha, labels, notices, isAncestor = null }) => {
  const short = String(mergeSha || '').slice(0, 7)
  const done = {}
  const sorted = [...notices].filter(Boolean).sort((a, b) => String(a.at).localeCompare(String(b.at)))
  for (const label of labels) {
    const project = projectForLabel(label)
    const card = sorted.findLast((notice) =>
      notice.project === project &&
      notice.branch === env &&
      (notice.commits.some((commit) => commit.sha.startsWith(short) || String(mergeSha).startsWith(commit.sha)) ||
        Boolean(isAncestor && notice.commits[0] && isAncestor(mergeSha, notice.commits[0].sha))))
    if (card) done[label] = card
  }
  return { done, pending: labels.filter((label) => !done[label]) }
}
