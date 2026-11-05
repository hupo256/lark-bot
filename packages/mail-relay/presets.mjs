/**
 * 邮件转发的预设与评分器注册表（aven 11-02：审批邮件不止 OL 上线，还有加白名单等，要封装好方便配置）。
 *
 * 预设 = 一类审批邮件的默认「怎么认 + 怎么评」：{ label, match, scorer }。路由（config.mailRelay.routes[]）写 preset 就继承这些默认，
 * 自己写的字段覆盖预设。新增一类审批：
 *   · 只转发、不评分：配置里加一条路由，写 label + match（主题正则等），不用改代码；
 *   · 要评分：在这里加一个评分器 { score(mail) → result, render(result, ctx) → markdown }，再加一个预设引用它。
 * 评分器结果约定：{ score, max, tier, tierLabel, items: [{ key, group, label, ok }], ... }，render 出群里那条说明。
 */

import { hasOlSubject, renderOlScore, scoreOlMail } from './scorers/ol-release.mjs'

export const MAIL_SCORERS = {
  // OL（生产）上线申请规范度：主题 3 + 9 段正文 10 + 收件 3，口径见 docs/notes/mail-ol-scoring-2026-11-02.md。
  'ol-release': {
    score: ({ subject, body, to, cc }) => scoreOlMail({ subject, body, to, cc }),
    render: (result, { sender, subject }) => renderOlScore(result, { sender, subject }),
  },
}

export const MAIL_PRESETS = {
  'ol-release': {
    label: 'OL 上线申请',
    // 主题 OL 标记的判定比普通正则严（前后边界），所以用函数；配置里写的 match.subject 会和它「且」起来。
    match: { subjectTest: hasOlSubject },
    scorer: 'ol-release',
  },
}

export const getScorer = (id) => (id ? MAIL_SCORERS[id] || null : null)
