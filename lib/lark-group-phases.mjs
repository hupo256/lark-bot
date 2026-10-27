/**
 * 群消息出口规则表（aven 2026-10-27）：每种群消息（phase）适用哪些出口规则，只在这里声明。
 *
 * 教训（10-26 日报缩水）：10-22 给群出口加「超长整段转文档」时，规则写死在 sendGroupCard 里对所有群消息生效，
 * 没有地方逼人逐类决定；日报本身就是排好版的短版、自带完整版链接，被顺带转成文档，群里只剩标题一行。
 *
 * 约束：
 *   · 每种 phase 每一列都必填，没有默认值；加载时校验，缺列 / 值不合法直接抛错（bot 起不来、单测红）。
 *   · 给出口加一条新规则 = 在 POLICY_COLUMNS 加一列，每种 phase 都得填上——不会再有「改出口时没想到某种消息」。
 *   · sendGroupCard 收到表里没有的 phase 拒发；单测扫全部源码里的 phase 字面量，必须都在表里。
 */

// 列 → 合法取值。
//   overflow：正文超过 GROUP_TEXT_MAX 时——to_doc 整段转 Lark 文档、群里留第一行 + 链接；as_is 原样发（本身已是排好版的短版）。
//   dedupe：出口闸——content_24h 同内容 24 小时只发一次；per_person_2min 对同一人同主题 2 分钟一条。
//   privateOnly：目标是只私聊的群时——caller_reports 由调用方在结果私聊里带出原话；forward_owner 把原话私发负责人。
export const POLICY_COLUMNS = Object.freeze({
  overflow: ['to_doc', 'as_is'],
  dedupe: ['content_24h', 'per_person_2min'],
  privateOnly: ['caller_reports', 'forward_owner'],
})

const TABLE = {
  ack: { overflow: 'to_doc', dedupe: 'per_person_2min', privateOnly: 'caller_reports' },
  noted: { overflow: 'to_doc', dedupe: 'per_person_2min', privateOnly: 'forward_owner' },
  done: { overflow: 'to_doc', dedupe: 'content_24h', privateOnly: 'caller_reports' },
  blocked_ask: { overflow: 'to_doc', dedupe: 'content_24h', privateOnly: 'caller_reports' },
  // 日报群简报：脚本排好的短版，末尾自带完整版云文档链接，超长也原样发（10-26 教训）。
  daily_report: { overflow: 'as_is', dedupe: 'content_24h', privateOnly: 'forward_owner' },
  daily_report_request: { overflow: 'to_doc', dedupe: 'per_person_2min', privateOnly: 'forward_owner' },
  // 只剩发件簿旧记录（10-15 用户身份摘要），不再有发送方；留着让 24h 内容去重仍认得旧记录。
  summary: { overflow: 'to_doc', dedupe: 'content_24h', privateOnly: 'forward_owner' },
}

// 校验整张表：每种 phase 每列都填了合法值，不许多出表外的列。纯函数，单测直接喂坏表。
export const validatePhaseTable = (table) => {
  const errors = []
  for (const [phase, policy] of Object.entries(table)) {
    for (const [column, allowed] of Object.entries(POLICY_COLUMNS)) {
      if (!(column in policy)) errors.push(`${phase} 缺列 ${column}（合法值：${allowed.join(' / ')}）`)
      else if (!allowed.includes(policy[column])) errors.push(`${phase}.${column} = ${policy[column]} 不合法（合法值：${allowed.join(' / ')}）`)
    }
    for (const column of Object.keys(policy)) if (!(column in POLICY_COLUMNS)) errors.push(`${phase} 多了表外的列 ${column}：先在 POLICY_COLUMNS 登记`)
  }
  return errors
}

const tableErrors = validatePhaseTable(TABLE)
if (tableErrors.length) throw new Error(`群消息出口规则表不完整：${tableErrors.join('；')}`)

export const GROUP_PHASES = Object.freeze(Object.fromEntries(Object.entries(TABLE).map(([phase, policy]) => [phase, Object.freeze({ ...policy })])))

// 表里没有返回 null（调用方拒发）。
export const groupPhasePolicy = (phase) => (Object.hasOwn(GROUP_PHASES, phase) ? GROUP_PHASES[phase] : null)
