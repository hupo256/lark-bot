/**
 * 项目号原语（PR-/PM- id）:整串校验与自由文本提取的**唯一正则来源**,零副作用、可 `node --test` 直测。
 *
 * 独立成模块的原因:这些是通用的项目号工具,原先寄居在 lark-message.mjs(消息解析功能),
 * 却被非消息模块(bugtable-poller / work-context)依赖——让无关功能为了拿共享真相去耦合消息模块。
 * 抽到中性模块后,谁需要项目号判定都从这里取,消除「功能文件owning共享原语」的耦合。
 */

// 项目号词边界匹配:`\b(PR|PM)-\d{3,}\b`。词边界避免吞子串——`SUPR-01947` 里 `U`/`P` 同为词字符,
// `\bPR` 不会命中(否则会把 `SUPR-01947` 误路由成 `PR-01947`)。大写归一。整串校验与自由文本提取共用同一正则,
// 消除「poller 用锚定 `^…$`、群消息用无锚定」两链路对同一字符串解析出不同项目号的误路由。
export const PROJECT_ID_RE = /\b(PR|PM)-\d{3,}\b/i

// 从自由文本(群名 / 正文)提取首个项目号,无则 null。
export const matchProjectId = (text) => {
  const match = String(text || '').match(PROJECT_ID_RE)
  return match ? match[0].toUpperCase() : null
}

// 提取文本里**全部**项目号(去重、保持出现顺序)。调用方据「恰好一个」判断这段文本是否在明确指向
// 一个项目:一条正文里出现两个以上项目号时,多半是在引用别的工单,拿首个去路由会路由到错项目。
export const matchProjectIds = (text) => {
  const matches = String(text || '').match(new RegExp(PROJECT_ID_RE.source, 'gi')) || []
  return [...new Set(matches.map((item) => item.toUpperCase()))]
}

// 整串校验单个值是否恰为合法项目号(bug 表「项目ID」单元格用):trim 后必须整串匹配,
// 不接受「值里夹带项目号」这类脏单元格(如 `../../PR-01947`),交 worker 走 adhoc。
export const isProjectId = (value) => {
  const trimmed = String(value || '').trim()
  return trimmed !== '' && new RegExp(`^${PROJECT_ID_RE.source}$`, 'i').test(trimmed)
}
