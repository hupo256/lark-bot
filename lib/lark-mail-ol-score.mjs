/**
 * OL（生产）环境上线申请邮件的规范度打分（aven 11-02：拉 100 封 OL 邮件分析哪些标准 → 打分逻辑落盘、转发审批群时附评分）。
 * 口径与样本分析见 docs/notes/mail-ol-scoring-2026-11-02.md；纯函数，不碰 IO。
 * 16 项 = 主题 3 + 正文 10 + 收件 3，各 1 分；档位 A ≥14 标准 / B 12–13 基本合格 / C 9–11 不完整 / D ≤8 不按模板。
 * 补 K 线申请另按补 K 线格式打 9 项（11-04 Rou「补 K 线按往常模板规格来就算 A 档」「bryn 发的直接作为 A 档范本」；规则从收件箱 23 封 OL 补 K 线首封归纳，见文档 §3），档位按同一比例换算。
 */

// 主题里的 OL 环境标记：【OL】【ONLINE】【OL环境 …】【ol】【Online】【OLINE】，嗨聊的「】OL環境-」也算。
// 前面必须是【 / 】/ 空白 / 开头，后面必须是】/ 空白 / - / 结尾，免得 TOOL、OLD 之类误中。
const OL_SUBJECT = /(^|[【】\s])(OL|ONLINE|OLINE)(环境|環境)?(?=[】\s\-]|$)/i
// 回复 / 转发类主题前缀：打分前从主题上剥掉。
const REPLY_PREFIX = /^\s*(re|fw|fwd|回复|回覆|答复|转发|轉寄)\s*[:：]/i

// 拿到的正文若是回复，去掉「xxx 于…写道：」之前的回复语，只看被引用的原申请（批量分析时首封偶尔是回复）。
const stripReplyLead = (body) => String(body || '').replace(/^[\s\S]{0,80}?(写道|寫道)[：:]\s*/, '')

const has = (text, re) => re.test(text)

export const OL_SCORE_ITEMS = [
  // 主题
  { key: 'subjectEnv', group: '主题', label: '环境标签写成【ONLINE】或【OL】', test: ({ subject }) => /【(ONLINE|OL)(环境)?】/.test(subject) },
  { key: 'subjectDate', group: '主题', label: '结尾 8 位日期【YYYYMMDD】', test: ({ subject }) => /【20\d{2}(0[1-9]|1[0-2])([0-2]\d|3[01])】\s*(【[^】]*】)?\s*$/.test(subject) },
  { key: 'subjectTicket', group: '主题', label: '带需求 / Bug 编号（PR / XBUG / BUG / TR）', test: ({ subject }) => /(PR|XBUG|BUG|TR)-?\d{3,}/.test(subject) },
  // 正文（9 段模板）
  { key: 'bodyEnv', group: '正文', label: '一、环境', test: ({ body }) => has(body, /[一1][、.．]\s*环境|环\s*境[：:]/) },
  { key: 'bodyContent', group: '正文', label: '更新内容（含开发者）', test: ({ body }) => has(body, /更新内容|新增内容/) && has(body, /开发者?|開發/) },
  { key: 'bodyPeople', group: '正文', label: '上线参与人及职责（QA / 研发 / 产品验收人）', test: ({ body }) => has(body, /上线参与人及职责/) && has(body, /QA|研发验收|产品验收|测试验收/) },
  { key: 'bodyOnline', group: '正文', label: '验收人「已确认在线」+ 验收时限', test: ({ body }) => has(body, /已确认在线/) && has(body, /验收结论时限|60 ?分钟/) },
  { key: 'bodyVersion', group: '正文', label: '发布版本 PROD-TAG', test: ({ body }) => has(body, /PROD-[0-9a-f]{8,}/) },
  { key: 'bodySteps', group: '正文', label: '操作步骤 / 服务更新', test: ({ body }) => has(body, /操作步骤|服务更新|更新操作|执行|sql|配置更新|sync/i) },
  { key: 'bodyRollback', group: '正文', label: '回滚方式 / 可回滚版本', test: ({ body }) => has(body, /回滚|回退|可回滚版本/) },
  { key: 'bodyChecklist', group: '正文', label: '线上验收 Checklist', test: ({ body }) => has(body, /线上验收|Checklist/i) },
  { key: 'bodyNotes', group: '正文', label: '注意事项', test: ({ body }) => has(body, /注意事项/) },
  { key: 'bodyAttach', group: '正文', label: '附件清单', test: ({ body }) => has(body, /附件清单/) },
  // 收件
  { key: 'toSysops', group: '收件', label: '收件人是 sysops@hqstech.com', test: ({ to }) => to.includes('sysops@hqstech.com') },
  { key: 'ccCto', group: '收件', label: '抄送 devcto', test: ({ all }) => all.some((address) => address.startsWith('devcto@')) },
  { key: 'ccQa', group: '收件', label: '抄送 qa@globaldev.info', test: ({ all }) => all.includes('qa@globaldev.info') },
]

// 补 K 线申请的往常格式（11-04 从收件箱 23 封 OL 补 K 线首封归纳：bryn 合约直接命令版 10、合约批处理脚本版 7、现货 3，Brad 3）：
// 主题带「(数据源 …)」；正文 执行位置 → 编号执行步骤 → 执行说明（耗时 / 成功判据）。合约在服务器上跑 git 仓库里的 kline-migrate
// （服务器名称 + 仓库 + 分支 / tag），现货在 Spot-kline-online 的 terminal 里跑，没有服务器 / 仓库，两种都算写清执行位置。
// 正文不单列「执行环境」：主题已有环境标签，正文是否再写一遍 23 封不统一。不要求需求号、9 段上线模板、PROD-TAG。
// Rou 指定 bryn / Brad 的补 K 线为 A 档范本：23 封全部 ≥8/9（只贴 curl 的现货缺执行说明、4 月 Brad 日期写成 2026-04-13，各缺 1 项仍 A）。
const sharedItem = (key) => OL_SCORE_ITEMS.find((item) => item.key === key)
export const KLINE_SCORE_ITEMS = [
  sharedItem('subjectEnv'),
  sharedItem('subjectDate'),
  { key: 'klineSource', group: '主题', label: '写明数据源（数据源 …）', test: ({ subject }) => /数据源/.test(subject) },
  { key: 'klineTarget', group: '正文', label: '执行位置（服务器 + git 仓库 / 分支 tag，或服务 terminal）', test: ({ body }) => (has(body, /服务器(名称)?[：:]/) && has(body, /仓库|分支|tag[：:]/i)) || has(body, /terminal|容器|pod/i) },
  { key: 'klineSteps', group: '正文', label: '执行步骤（命令）', test: ({ body }) => has(body, /执行操作|操作步骤|执行步骤|执行如下|操作如下/) || has(body, /(^|\s)1[.．、]\s*\S[\s\S]*?(nohup|curl|\.\/|chmod)/) },
  { key: 'klineNotes', group: '正文', label: '执行说明（耗时 / 成功判据）', test: ({ body }) => has(body, /耗时|执行成功|确认.{0,8}(成功|完成|执行完)|成功判断|exit_code=0|SUMMARY/) },
  sharedItem('toSysops'),
  sharedItem('ccCto'),
  sharedItem('ccQa'),
]

// 档位按得分比例：16 项时正好是 A ≥14 / B 12–13 / C 9–11 / D ≤8；9 项补 K 线是 A ≥8 / B 7 / C 6 / D ≤5。
const TIERS = [
  { ratio: 14 / 16, tier: 'A', label: '标准' },
  { ratio: 12 / 16, tier: 'B', label: '基本合格' },
  { ratio: 9 / 16, tier: 'C', label: '不完整' },
  { ratio: 0, tier: 'D', label: '不按模板' },
]
const tierFor = (score, max) => TIERS.find(({ ratio }) => score >= Math.ceil(ratio * max - 1e-9))

// 邮件类别：hqex 上线模板适用；kline（补 K 线）有自己的格式与打分项；ops（撮合重启）、falive、hichat 自成一套，模板只作参考。
export const classifyOlKind = (subject) => {
  if (/Falive/i.test(subject)) return 'falive'
  if (/嗨聊/.test(subject)) return 'hichat'
  if (/补.{0,6}K\s*线/i.test(subject)) return 'kline' // 「补K线」「修补所有币对K线」
  if (/撮合\s*重启/i.test(subject)) return 'ops'
  return 'hqex'
}

const KIND_NOTES = {
  kline: '补 K 线申请，按补 K 线格式打分（数据源 / 执行位置 / 执行步骤 / 执行说明），不套 9 段上线模板',
  ops: '运维操作单（撮合重启），9 段上线模板不完全适用，重点看操作步骤和回滚',
  falive: 'Falive 直播站简版申请（拉取代码 / 打包启动），不走 HQEX 9 段模板',
  hichat: '嗨聊自有格式（发 Dracula 审批），不走 HQEX 9 段模板',
}

const addresses = (list) => (Array.isArray(list) ? list : []).map((item) => String(item?.mail_address || '').toLowerCase()).filter(Boolean)

// 主题是否带 OL 环境标记（转发路由 ol-release 预设用它认邮件；是不是首封由路由的 firstOnly 判）。
export const hasOlSubject = (subject) => OL_SUBJECT.test(String(subject || ''))

// 高风险操作却没写回滚：SQL / redis / 重启 / 删数据。打分之外单列提醒。
const RISKY_OPS = /\b(insert|update|delete|truncate|drop|alter)\b|\bsql\b|redis|重启|删除|raft/i

export const scoreOlMail = ({ subject, body, to, cc } = {}) => {
  const cleanSubject = String(subject || '').replace(REPLY_PREFIX, '').trim()
  const toList = addresses(to)
  const ctx = { subject: cleanSubject, body: stripReplyLead(body), to: toList, all: [...toList, ...addresses(cc)] }
  const kind = classifyOlKind(cleanSubject)
  const template = kind === 'kline' ? KLINE_SCORE_ITEMS : OL_SCORE_ITEMS
  const items = template.map(({ key, group, label, test }) => ({ key, group, label, ok: Boolean(test(ctx)) }))
  const score = items.filter((item) => item.ok).length
  const { tier, label } = tierFor(score, items.length)
  const rollbackOk = has(ctx.body, /回滚|回退|可回滚版本/)
  return {
    score,
    max: items.length,
    tier,
    tierLabel: label,
    kind,
    kindNote: KIND_NOTES[kind] || null,
    riskNoRollback: !rollbackOk && RISKY_OPS.test(ctx.body),
    items,
  }
}

// 主题结尾的日期标签写成了什么（9 位 / 带横线 / 占位符），评分说明里直接点出来。
const subjectDateHint = (subject) => {
  const tags = String(subject || '').match(/【[^】]*】/g) || []
  const tail = tags.reverse().find((tag) => /\d{4,}|日期/.test(tag))
  return tail ? `（现在写的是${tail}）` : '（没写日期）'
}

// 群里那条评分说明（Markdown，bot 回在邮件卡片下）：总分 + 档位，再按「主题 / 正文 / 收件」各给得分和缺项。
export const renderOlScore = (result, { sender, subject } = {}) => {
  const lines = [`**OL 上线申请规范度：${result.score}/${result.max}（${result.tier} 档 · ${result.tierLabel}）**${sender ? ` · 发件人 ${sender}` : ''}`]
  if (result.kindNote) lines.push(`类别：${result.kindNote}`)
  if (result.riskNoRollback) lines.push('⚠️ 含 SQL / redis / 重启 / 删数据类操作，但没写回滚方式')
  for (const group of ['主题', '正文', '收件']) {
    const items = result.items.filter((item) => item.group === group)
    const got = items.filter((item) => item.ok).length
    const missing = items.filter((item) => !item.ok).map((item) => (item.key === 'subjectDate' ? `${item.label}${subjectDateHint(subject)}` : item.label))
    lines.push(`- ${group} ${got}/${items.length}${missing.length ? `，缺：${missing.join('；')}` : ' ✓'}`)
  }
  lines.push(result.kind === 'kline'
    ? '评分口径：补 K 线格式 主题 3 + 正文 3 + 收件 3，共 9 项；≥8 标准，7 基本合格，6 不完整，≤5 不按模板。'
    : '评分口径：主题 3 + 正文 9 段模板 10 + 收件 3，共 16 项；≥14 标准，12–13 基本合格，9–11 不完整，≤8 不按模板。')
  return lines.join('\n')
}
