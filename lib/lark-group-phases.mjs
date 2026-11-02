/**
 * 群 / 私信消息出口规则表（从 falive 搬来，aven 2026-10-27 的做法）：每种消息（phase）适用哪些出口规则，只在这里声明。
 *
 * falive 教训（10-26 日报缩水）：给群出口加「超长整段转文档」时规则写死在发送函数里对所有消息生效，没有地方逼人逐类决定。
 * 约束：
 *   · 每种 phase 每一列都必填，没有默认值；加载时校验，缺列 / 值不合法直接抛错（bot 起不来、单测红）。
 *   · 给出口加一条新规则 = 在 POLICY_COLUMNS 加一列，每种 phase 都得填上。
 *   · sendReply 收到表里没有的 phase 拒发；单测扫全部源码里的 `phase: '…'` 字面量，必须都在表里。
 */

// 列 → 合法取值。
//   overflow：正文超过 GROUP_TEXT_MAX 时——to_doc 整段转 Lark 文档、群里留第一行 + 链接；as_is 原样发。
//   dedupe：出口闸——content_24h 同内容 24 小时只发一次；per_person_2min 对同一人同主题 2 分钟一条。
//   anchor：reply_origin 回复原消息（原消息在话题里就回话题，失败回落直发群）；send 直接发到 chatId / 私信。
//   receipt：task 发成功登记成任务回执（回复这条能锚回任务）；none 不登记（日报汇总这类没有任务）。
export const POLICY_COLUMNS = Object.freeze({
  overflow: ['to_doc', 'as_is'],
  dedupe: ['content_24h', 'per_person_2min'],
  anchor: ['reply_origin', 'send'],
  receipt: ['task', 'none'],
})

const TABLE = {
  ack: { overflow: 'to_doc', dedupe: 'per_person_2min', anchor: 'reply_origin', receipt: 'task' },
  noted: { overflow: 'to_doc', dedupe: 'per_person_2min', anchor: 'reply_origin', receipt: 'task' },
  done: { overflow: 'to_doc', dedupe: 'content_24h', anchor: 'reply_origin', receipt: 'task' },
  blocked_ask: { overflow: 'to_doc', dedupe: 'content_24h', anchor: 'reply_origin', receipt: 'task' },
  reminder: { overflow: 'as_is', dedupe: 'per_person_2min', anchor: 'reply_origin', receipt: 'task' },
  held_release: { overflow: 'to_doc', dedupe: 'content_24h', anchor: 'reply_origin', receipt: 'task' },
  // 控制通道回话（结单 / 续跑 / 找不到任务 这类一句话）。
  // 同一个人两分钟内可能连发「取消任务 x」「重开任务 x」，回话不能按人去重，只按内容去重。
  notice: { overflow: 'as_is', dedupe: 'content_24h', anchor: 'reply_origin', receipt: 'task' },
  // 私信负责人：疑似 / 扣下的草稿 / 没做成 / 答应了没结论；直接发到 ou_。
  suspected: { overflow: 'as_is', dedupe: 'content_24h', anchor: 'send', receipt: 'task' },
  private: { overflow: 'as_is', dedupe: 'content_24h', anchor: 'send', receipt: 'task' },
  // 每日「等你决定的 n 条」汇总：没有任务可锚。
  digest: { overflow: 'as_is', dedupe: 'content_24h', anchor: 'send', receipt: 'none' },
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
if (tableErrors.length) throw new Error(`消息出口规则表不完整：${tableErrors.join('；')}`)

export const GROUP_PHASES = Object.freeze(Object.fromEntries(Object.entries(TABLE).map(([phase, policy]) => [phase, Object.freeze({ ...policy })])))

// 表里没有返回 null（调用方拒发）。
export const groupPhasePolicy = (phase) => (Object.hasOwn(GROUP_PHASES, phase) ? GROUP_PHASES[phase] : null)
