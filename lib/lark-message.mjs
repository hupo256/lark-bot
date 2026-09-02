/**
 * Lark 消息归一化 + 信任判定（纯函数层，零副作用，可 `node --test` 直测）。
 *
 * 两种信封需统一：
 *   · lark-cli event consume（本项目采用）吐「拍平顶层」结构——message_id / chat_id /
 *     sender_id 均在顶层，content 是已内联 mention 名的纯文本，mentions[].id 是字符串。
 *   · 官方 webhook im.message.receive_v1 是「嵌套」结构——event.message.* + content 为
 *     JSON 字符串，sender.sender_id.open_id，mentions[].id 为 { open_id }。
 * 实测 lark-cli 形态样例见 apps/web/docs_tdd/prds/PR-01947/agent/lark-integration.md。
 */

export const parseLine = (line) => {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

// mention.id：官方是 { open_id }，lark-cli 拍平结构是字符串
const mentionOpenId = (mention) => (typeof mention?.id === 'string' ? mention.id : mention?.id?.open_id)

// 去掉正文里内联的 @mention 文本（lark-cli 把占位符 @_user_1 替换成了 mention.name）
const stripMentions = (text, mentions) => {
  let out = text || ''
  for (const mention of mentions) {
    if (mention.name) out = out.split(`@${mention.name}`).join(' ')
    if (mention.key) out = out.split(mention.key).join(' ')
  }
  return out.replace(/\s+/g, ' ').trim()
}

// lark-cli 拉取引用消息 / 合并转发时，图片有时不会保留 post 结构，而是降成
// `[Image: img_xxx]` 或 `![Image](img_xxx)` 占位文本。把 image_key 恢复成附件，
// 后续仍由带 messageId 的下载接口取真实二进制；仅接受 image_key 形态并去重。
export const extractInlineImageAttachments = (text) => {
  const input = String(text || '')
  const keys = []
  const patterns = [
    /\[Image:\s*(img_[\w-]+)\]/gi,
    /!\[Image\]\((img_[\w-]+)\)/gi,
  ]
  for (const pattern of patterns) {
    for (const match of input.matchAll(pattern)) keys.push(match[1])
  }
  return [...new Set(keys)].map((imageKey) => ({ type: 'image', imageKey }))
}

export const parseTextAndAttachments = ({ messageType, rawContent, mentions }) => {
  // lark-cli 拍平：content 已是纯文本；官方 webhook：content 是 JSON 字符串
  const looksJson = typeof rawContent === 'string' && rawContent.trim().startsWith('{')
  if (typeof rawContent === 'string' && !looksJson) {
    return { text: stripMentions(rawContent, mentions), attachments: extractInlineImageAttachments(rawContent) }
  }
  try {
    const content = typeof rawContent === 'string' ? JSON.parse(rawContent || '{}') : rawContent || {}
    if (messageType === 'post') {
      const blocks = Object.values(content).flatMap((locale) => locale?.content || [])
      const flat = blocks.flat()
      const text = flat
        .filter((el) => el.tag === 'text' || el.tag === 'a')
        .map((el) => el.text || el.href || '')
        .join(' ')
        .trim()
      const attachments = flat
        .filter((el) => el.tag === 'img')
        .map((el) => ({ type: 'image', imageKey: el.image_key, width: el.width, height: el.height }))
      return { text: stripMentions(text, mentions), attachments }
    }
    return {
      text: stripMentions(content.text || '', mentions),
      attachments: extractInlineImageAttachments(content.text || ''),
    }
  } catch {
    return { text: '', attachments: [] }
  }
}

// 把任意信封归一成 canonical message；非消息事件（无 message_id）返回 null
export const normalizeMessage = (raw) => {
  if (!raw || typeof raw !== 'object') return null
  const nested = raw.event || raw.data?.event
  const message = nested?.message ? nested.message : raw
  const messageId = message.message_id || raw.message_id
  if (!messageId) return null

  const mentions = (message.mentions || raw.mentions || []).map((mention) => ({
    id: mentionOpenId(mention),
    key: mention.key,
    name: mention.name,
  }))
  const messageType = message.message_type || raw.message_type
  const { text, attachments } = parseTextAndAttachments({
    messageType,
    rawContent: message.content ?? raw.content,
    mentions,
  })

  return {
    messageId,
    chatId: message.chat_id || raw.chat_id,
    chatType: message.chat_type || raw.chat_type,
    messageType,
    senderType: nested?.sender?.sender_type || raw.sender_type || raw.sender?.sender_type || 'unknown',
    senderOpenId: nested?.sender?.sender_id?.open_id || raw.sender_id || raw.sender?.sender_id?.open_id || 'unknown',
    mentions,
    text,
    attachments,
    // 回复/引用上下文：用户常在 QA 的原始 bug 消息下回复 + @bot，真正 bug 正文在被引用消息里。
    // replyTo 合并 reply_to 与 root_id 供「引用正文合并 / 是否有上下文」判断；replyToDirect 只取真正的
    // reply_to（明确回复某条消息）。续跑目标解析要区分二者：root_id 只是会话线程根、可能是任意旧消息，
    // 拿它直接 store.get 会误命中，故仅当它命中机器人回执索引时才作续跑锚点（见 lark-ingest 续跑解析）。
    replyTo: message.reply_to || raw.reply_to || message.root_id || raw.root_id,
    replyToDirect: message.reply_to || raw.reply_to || null,
    // 话题(thread)稳定身份：同一话题内的多条消息共享它，用作「同话题任务归并」的对称键。
    // thread_id 是 Lark 话题的稳定 id，优先；root_id 兜底（老事件或非话题回复）。非话题的普通
    // @ 两者皆空 → null，同话题归并逻辑自然退回「按消息/回执卡精确匹配」的既有行为，零回归。
    threadRootId: message.thread_id || raw.thread_id || message.root_id || raw.root_id || null,
  }
}

// 消息触发类型：p2p / @bot 直接入队；@所有人 与只 @ 配置中负责人的消息先走 AI 意图分类。
// taskMentionOpenIds 必须显式配置，避免「任意 @ 某个人」扩大成自动改代码入口。
export const resolveMessageTrigger = ({ msg, config }) => {
  // 开通群全量消息后可能看到 bot 消息；机器人自己发出的含 @负责人卡片
  // 不得回流成新任务。未知 sender_type 仍按旧事件兼容，只拒绝明确的 bot。
  if (msg.senderType === 'bot') return null
  if (msg.chatType === 'p2p') return 'direct'
  const mentions = msg.mentions || []
  if (mentions.some((mention) => mention.id === config.botOpenId)) return 'direct'
  const taskMentionOpenIds = Array.isArray(config.taskMentionOpenIds) ? config.taskMentionOpenIds : []
  // @所有人 不是「找机器人」：群里任何人喊一句全体通知即可直接入队改代码，是明显过宽的入口。
  // 降级走只读意图分类（与 @负责人 同档），仍能接住「@所有人 这个页面报错了」这类真实反馈。
  if (mentions.some((mention) => mention.key === '@_all')) return 'task_mention'
  if (mentions.some((mention) => taskMentionOpenIds.includes(mention.id))) return 'task_mention'
  // 旧配置兼容（未配 botOpenId）同样收紧到只读分类：无法判定「是否在叫机器人」时不该直接入队。
  if (!config.botOpenId && mentions.length > 0) return 'task_mention'
  return null
}

export const isForBot = (options) => resolveMessageTrigger(options) != null

// 白名单校验（纯同步）。信任边界是**白名单群**：群里 QA / PM / 后台 @ 都要能触发，故群消息只按群放行、
// 不再按发送人过滤。硬规则：完全没配任何白名单（群 + 用户皆空）时 fail-closed 拒绝所有事件，
// 避免配置漏填导致任何人 @ 都能触发无监督改代码（曾经是 fail-open）。
// p2p 直发没有群作信任锚点，只放行显式配置的白名单用户（auto 与静态模式一致）。
// 动态成员制（allowedChatIds:'auto'）：白名单 = bot 当前所在的群。「群成员资格」本身即信任边界，
// 由调用方用 lark-cli 解析后把结果作 isMember 注入进来（保持本函数纯同步、可单测）。
export const isWhitelisted = ({ msg, config, isMember = false }) => {
  const users = config.allowedOpenIds || []
  const chats = config.allowedChatIds
  // p2p 无群锚点：任何模式都只放行显式白名单用户（users 为空即 fail-closed）
  if (msg.chatType === 'p2p') return users.includes(msg.senderOpenId)
  if (chats === 'auto') return isMember
  const list = Array.isArray(chats) ? chats : []
  if (!list.length && !users.length) return false // fail-closed：未配置 = 拒绝
  return list.includes(msg.chatId)
}

export const summarize = (text) => (text || '').split('\n').find((line) => line.trim())?.trim().slice(0, 80) || '群内任务'

// 命令类型：任务首行以「类型：…」（中/英前缀 + 冒号）开头时归一为规范命令类型。
// 首个命中规则胜出，都不命中则 null（普通 bug 修复正文）。Gateway 落 task.commandType，
// worker 据此对只读命令走轻量分流（跳过临时 worktree 准备与代码提交）。
const COMMAND_TYPE_RULES = [
  { type: 'status', re: /^\s*(?:状态|status)\s*[:：]/i },
  { type: 'docs', re: /^\s*(?:文档|docs)\s*[:：]/i },
  { type: 'fix', re: /^\s*(?:修复|fix)\s*[:：]/i },
  { type: 'test', re: /^\s*(?:自测|test)\s*[:：]/i },
  { type: 'api', re: /^\s*(?:api)\s*[:：]/i },
  { type: 'qa', re: /^\s*(?:qa)\s*[:：]/i },
]

// 只读命令：不改代码，worker 跳过临时 worktree 准备与代码提交闸，无本地 worktree 时就地在主仓只读回答。
export const READ_ONLY_COMMAND_TYPES = new Set(['status'])

export const parseCommandType = (text) => {
  const firstLine = String(text || '').split('\n').find((line) => line.trim()) || ''
  return COMMAND_TYPE_RULES.find(({ re }) => re.test(firstLine))?.type || null
}

// 自然语言只读查询兜底：显式「状态：」仍优先。误判代价不对称——把一条真 bug 判成 status 会让它
// 走只读沙箱、零改动 done、还把 bug 表记录写成完成态而无人再看见，故这里三重收紧：
//   1. 主题必须是**项目级**问法（项目/需求/任务…的状态·进度·阶段，或「做到哪」「下一步」），
//      单独出现「状态」二字不算（「状态字段不显示」是缺陷描述，不是查询）；
//   2. 必须带问句/查询信号；
//   3. 出现任一缺陷信号或写操作动词即否决（一票veto）。
// 仍有歧义一律返回 null，继续走普通变更任务。
const STATUS_QUERY_TOPIC_RE = /(?:(?:项目|需求|任务|迭代|排期|工单|这边|目前|现在|整体)[^。；\n]{0,8}(?:状态|进度|阶段|情况)|(?:做|进行|完成)到哪|还剩什么|下一步|project\s*status|progress|next\s*step)/i
const STATUS_QUERY_CUE_RE = /(?:[?？]|是什么|怎么样|如何|怎样|到哪|了吗|了没|是否|查询|查看|看看|告诉我|汇总|汇报|报告|说一下|说说|说下|讲一下|讲讲|介绍|what|how|where|show|tell|report)/i
const WRITE_INTENT_RE = /(?:修复|修改|调整|新增|增加|删除|更新|实现|改成|优化|处理|补充|fix|change|update|implement|remove|add)/i
// 缺陷信号：出现即说明这是在报问题，绝不能当只读查询处理（此前「项目状态一直转圈」会被误判成 status）。
export const DEFECT_SIGNAL_RE = /(?:不显示|没显示|没有显示|不见了|没反应|无反应|点不动|报错|错误|异常|失败|空白|白屏|转圈|加载不出|出不来|不对|不一致|不正确|丢失|错位|重复|卡住|不生效|闪退|崩|超时|为空|样式|文案|接口|字段|null|undefined|error|crash|bug)/i

// 命令类型 + 来源。source：'explicit' = 首行显式前缀（权威口径，可据此改写外部系统状态）；
// 'inferred' = 自然语言兜底（可能误判，调用方必须降级处理，不得据此写回 bug 表完成态）。
export const classifyCommandType = (text) => {
  const explicit = parseCommandType(text)
  if (explicit) return { type: explicit, source: 'explicit' }
  const input = String(text || '').trim()
  if (!input || WRITE_INTENT_RE.test(input) || DEFECT_SIGNAL_RE.test(input)) return { type: null, source: null }
  return STATUS_QUERY_TOPIC_RE.test(input) && STATUS_QUERY_CUE_RE.test(input)
    ? { type: 'status', source: 'inferred' }
    : { type: null, source: null }
}

export const inferCommandType = (text) => classifyCommandType(text).type

// 任务级 SSOT：worker / 卡片 / 回写等所有分流点只走这一个入口，避免各处重复
// `task.commandType || inferCommandType(task.text)`（曾有 7 处，口径一漂移就分流不一致）。
// 旧任务无 commandTypeSource 时按正文回推来源，无需数据迁移。
export const resolveCommandType = (task) => {
  const persisted = task?.commandType || null
  if (!persisted) return classifyCommandType(task?.text)
  return {
    type: persisted,
    source: task?.commandTypeSource
      || (parseCommandType(task?.text) === persisted ? 'explicit' : 'inferred'),
  }
}

// 待确认任务除了“回复回执卡”外，还支持显式兜底：@应用 继续任务 <taskId> <补充内容>。
// 返回 null 表示普通新任务，防止正文中随口提到「继续」就误续跑旧任务。
export const parseResumeDirective = (text) => {
  const match = String(text || '').trim().match(
    /^(?:继续|续跑|resume)\s*(?:任务)?\s*[:：#]?\s*([a-z0-9_-]{4,})(?:\s+([\s\S]*))?$/i,
  )
  return match ? { taskId: match[1], supplementText: (match[2] || '').trim() } : null
}

// —— 任务控制通道：回复 Bot 卡片的「结单/取消」语义判定（纯函数，一票否决优先）——
// 破坏性方向（结单）代价高于「多问一句」，故先跑否决门 + 复杂度检查，任一命中即降级为 unclear（去确认），
// 绝不自动结单。只有「干净的整单结单表达 + 无否定/无转折/无残余继续」才给 high 置信直接落终态。

// 结单原因规则（否决门未命中后按优先级匹配，首个命中胜出）：
//   completed_elsewhere = 已由其他人/AI 完成、已解决、已上线、重复工单；
//   cancelled           = 取消/终止/撤销/作废/停止处理/结束/不做了；
//   no_longer_needed    = 不用做了/不需要处理/需求变了/算了/这条忽略。
const CLOSURE_REASON_RULES = [
  {
    reason: 'completed_elsewhere',
    re: /(?:已由[^\n。；]{0,32}(?:ai|同学|其他人|另(?:一)?位|同事|后端|前端)[^\n。；]{0,16}(?:完成|解决|处理好|修复|搞定)|(?:该|此|这个|上述)?\s*(?:问题|任务|事项|缺陷|需求|bug)?\s*(?:(?:已经|现已|已)\s*(?:解决|处理|修复|完成|搞定)(?:了|完毕)?|(?:解决|处理|修复|完成|搞定)(?:好了|完毕|了(?!不)))|已(?:上线|合并|发布|部署|验证通过)|重复(?:了|的)?(?:工单|任务|提交|问题|bug))/i,
  },
  {
    // no_longer_needed 的表达（不用做/需求变了/算了/先不做了）比 cancelled 更具体，优先匹配，
    // 避免「需求变了先不做了」被 cancelled 的通用「不做了」抢先命中。
    reason: 'no_longer_needed',
    re: /不用(?:再)?(?:做|弄|处理|改|管|继续|跟进)(?:了|啦)?|不需要(?:再)?(?:做|处理|改|跟进|了)|无需(?:处理|再做|继续)|(?:先)?不做了|需求(?:变了|取消了?|撤了|没了|改了)|(?:这条|这个|此条)?\s*(?:忽略|作罢)|算了(?:吧|不用)?/i,
  },
  {
    reason: 'cancelled',
    re: /(?:取消|撤销|撤回|作废|终止)(?:任务|吧|这个|它|了|掉)?|停止(?:处理|执行|吧|了|它)?|(?:结束|关闭)(?:任务|吧|这个|它|掉)?|不(?:搞|弄)了|别(?:做|搞|弄)了/i,
  },
]

// 否决门：任一命中即不自动结单（降级为 unclear 去确认）。覆盖——
//   否定关闭（别结束/不要取消）、暂停（先暂停一下）、条件未来时（结束后再通知）、
//   未完成（还没解决）、否定完成（解决不了）、只完成部分、还需继续、转述他人（他说…）。
const CLOSURE_VETO_RE = /(?:别|不要|勿|请勿|不许|先别|莫|暂时?不要?)\s*(?:结束|取消|关闭?|停(?:止|下)?|终止|撤(?:销|回)?|删|做完)|(?:先|暂时?)?(?:暂停|停一?下|缓一?[下会]|等一?[下会]|放一?[下会]|稍等)|(?:结束|完成|解决|做完|处理完|搞定|弄完)[了]?(?:之|以)?后再?(?:通知|告诉|叫|喊|说|回|同步)|(?:未|没|没有|尚未|还没|并未)(?:完全)?(?:解决|完成|处理好|修复|做完)|(?:解决|完成|处理|修复|做)不(?:了|完|好)|(?:只|仅)(?:完成|解决|处理|做)(?:了)?(?:一)?部分|(?:还需|仍需|尚需|还得|需要)(?:继续|接着)|(?:他|她|对方|客户|产品|测试|后端|前端|楼上|上游|老板)说/i

// 复杂度信号：有结单意图但夹带「另一部分/其余要继续」——整单关会误伤，标 scope=partial 去确认。
const CLOSURE_TURN_RE = /(?:但是?|不过|然而|可是|另外|其余|剩[下余]|其它|其他那?几?)/i
const CONTINUE_INTENT_RE = /(?:继续|接着)/i
const NEGATED_CONTINUE_RE = /(?:不用|不需要|无需|别|不必|勿)(?:再)?(?:继续|接着)/i

// 结单语义分类结果：intent=close 才可直接落终态；unclear 去确认；null 表示非结单表达（交由续跑/补料路径）。
// closureReason 供落态与回群文案分流；scope 标注整单/部分。confidence：close=high，其余=low。
export const classifyClosureIntent = (text) => {
  const input = String(text || '').trim()
  const none = { intent: null, closureReason: null, scope: 'unknown', confidence: 'low' }
  if (!input) return none
  const closureReason = CLOSURE_REASON_RULES.find(({ re }) => re.test(input))?.reason || null
  if (!closureReason) return none // 无任何结单信号：不是控制指令，按补料/新任务处理
  if (CLOSURE_VETO_RE.test(input)) return { intent: 'unclear', closureReason, scope: 'unknown', confidence: 'low' }
  const partial = CLOSURE_TURN_RE.test(input) || (CONTINUE_INTENT_RE.test(input) && !NEGATED_CONTINUE_RE.test(input))
  if (partial) return { intent: 'unclear', closureReason, scope: 'partial', confidence: 'low' }
  return { intent: 'close', closureReason, scope: 'whole_task', confidence: 'high' }
}

// 向后兼容旧调用点：仅当被判为「干净整单结单」时为真。
export const isManualResolutionMessage = (text) => classifyClosureIntent(text).intent === 'close'

export const isReadOnlyCommand = (commandType) => READ_ONLY_COMMAND_TYPES.has(commandType)

// 任务是否走只读分流（唯一判据，含来源回推）。
export const isReadOnlyTask = (task) => isReadOnlyCommand(resolveCommandType(task).type)

// 项目群与 bug 表里的产品 / QA 测试反馈本身就是变更依据；其它来源不扩权。
// 注意：本集合只回答「来源是否有资格进快车道」，**不回答「这条消息是 bug 还是新需求」**——
// 后者由 lark-work-policy.mjs 的 resolveWorkKind 判定（曾经两件事挤在一个布尔里，
// 导致群里一句「加个导出功能」与「导出点了没反应」走完全相同的路径）。
export const FAST_LANE_SOURCES = new Set(['lark', 'lark-bugtable'])
export const isFastLaneSource = (task) => FAST_LANE_SOURCES.has(task?.source)
