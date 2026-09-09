/**
 * 任务性质（workKind）与阻塞分类（blocker taxonomy）的单一事实源。
 *
 * ## 为什么要有这层
 *
 * 从前只有一个布尔判据 `isTestFeedbackTask`（source ∈ {lark,lark-bugtable} 且 commandType ∈
 * {null,fix,test,api,qa}），它同时承担了三件互不相同的事：选 prompt 模式、免 G2、以及——最危险的——
 * 把 AI 自己给出的 `blocked` 结论改写成 `ready`。两个后果：
 *
 *   1. **无前缀的新需求进了 bug 快车道**。`null` 在集合里，所以群里一句「加个导出功能」与「导出点了没反应」
 *      走完全相同的路径。更讽刺的是 @负责人 消息本来就有 AI 前置分类器明确区分 bug / requirement
 *      （见 buildIntentClassificationPrompt），结论却在这里被丢掉。
 *   2. **AI 说停也没用**。旧实现用一条「范围/权限」白名单正则过滤 blockers，**命不中就整条覆写成 ready**——
 *      默认放行。于是「这是新需求，缺 PRD，应先走 G2」这种正确的刹车被静默改成「已确认进入直接实施」。
 *
 * 根因不是这两处写错了，而是**阻塞语义只有二态**（waiting_confirmation / blocked）。二分类逼着系统在
 * 「什么都停」和「什么都不停」里选一个，于是选了后者并用正则硬压。
 *
 * ## 四分类
 *
 * | 类 | 含义 | 处置 |
 * |---|---|---|
 * | `hard`     | 缺权限/凭证/账号/环境，或改动目标无法唯一定位 | **停**。硬做出来必错 |
 * | `soft`     | 外部未就绪（接口未定、后端未上） | **不停**。按契约假设 + Mock 推进，假设登记进 assumptions |
 * | `decision` | 有多个合理取舍需要人拍板 | **不停**。选一个并记录理由，完成卡里汇总给人 |
 * | `process`  | 流程材料缺失（G2 未签、无 PRD/技术方案、历史 gate） | **看 workKind**：bug/QA 反馈可压制，新需求不可 |
 *
 * 关键的默认值反转：**无法归类的 blocker 一律按 `hard`**（旧实现是按可压制）。一条读不懂的 blocker
 * 是真信号，不是噪音。`process` 这一类的存在，正是为了让"压制流程复述"这件事有个精确的作用域，
 * 而不必再靠"默认全放行"来实现。
 *
 * 纯函数、零 IO，可 `node --test` 直测。
 */

import { DEFECT_SIGNAL_RE, isFastLaneSource, isReadOnlyTask, resolveCommandType } from './lark-message.mjs'

export const WORK_KINDS = {
  readonly: 'readonly',
  docs: 'docs',
  bugfix: 'bugfix',
  qaFeedback: 'qa_feedback',
  requirement: 'requirement',
}

/**
 * 每种任务性质的准入策略。
 * - `fastLane`：走「测试反馈直接实施」路径（prompt 模式 + 跳过 Lark 文档同步）。
 * - `suppressProcessBlockers`：允许把 `process` 类 blocker 视作噪音放行。bug / QA 反馈成立的理由是
 *   **反馈本身就是规格**；新需求没有这个前提，缺 PRD 就是真缺。
 * - `requiresHumanGoAhead`：即便 AI 判 ready 也必须先拿到人的一次确认才实施。只对新需求成立——
 *   它是唯一一类「AI 必须凭空发明行为」的任务，而群里一句话不构成规格。人回一句补料即视为放行。
 */
export const WORK_KIND_POLICY = {
  [WORK_KINDS.readonly]: { fastLane: false, suppressProcessBlockers: false, requiresHumanGoAhead: false },
  [WORK_KINDS.docs]: { fastLane: false, suppressProcessBlockers: false, requiresHumanGoAhead: false },
  [WORK_KINDS.bugfix]: { fastLane: true, suppressProcessBlockers: true, requiresHumanGoAhead: false },
  [WORK_KINDS.qaFeedback]: { fastLane: true, suppressProcessBlockers: true, requiresHumanGoAhead: false },
  [WORK_KINDS.requirement]: { fastLane: false, suppressProcessBlockers: false, requiresHumanGoAhead: true },
}

export const workKindPolicy = (workKind) => WORK_KIND_POLICY[workKind] || WORK_KIND_POLICY[WORK_KINDS.requirement]

export const WORK_KIND_LABELS = {
  [WORK_KINDS.readonly]: '只读查询',
  [WORK_KINDS.docs]: '文档任务',
  [WORK_KINDS.bugfix]: '缺陷修复',
  [WORK_KINDS.qaFeedback]: 'QA / 测试反馈',
  [WORK_KINDS.requirement]: '新需求',
}

// 只有明确在「交办一个尚不存在的行为」时才算新需求。刻意不含「改成 / 换成 / 调整为」——那类是
// 增量已被说清的反馈（「颜色改成 #fff」），进快车道是对的，把它拦下来只会让 bot 变得难用。
const REQUIREMENT_SIGNAL_RE = /(?:新需求|需求\s*[:：]|立项|走(?:一遍)?(?:流程|G2)|从零|(?:新增|增加|添加|加|做|开发|实现|上|接入|支持)\s*(?:一)?\s*(?:个|套|版|块)?\s*[^。；\n]{0,12}(?:功能|页面|模块|流程|入口|能力|弹窗|抽屉|表单|列表|图表|tab|标签页|菜单)|新(?:页面|模块|功能|流程))/i

const isBugTableSource = (task) => task?.source === 'lark-bugtable'
const hasImageAttachment = (task) => (task?.attachments || []).some((item) => item?.type === 'image')

// 「把已存在的东西改掉」类动词。这类消息自带增量规格（「颜色改成 #1F2329」已经把预期行为说完了），
// 拦下来问人只是白跑一趟；与 REQUIREMENT_SIGNAL_RE 的分工是：那边是「造一个还不存在的东西」。
// 刻意不含 新增 / 增加 / 添加 / 做 / 开发 / 实现 / 支持 / 接入——那些属于创造，走新需求闸。
//
// 词表补过一轮（D3.1）：测试阶段最常见的自带规格改动里，「重命名 / 移到 / 排序 / 置顶 / 加一列」这类
// 原本一条都没命中，被 fail-safe 兜成 requirement 退回让人补 PRD——而「把 A 列移到 B 列后面」已经把
// 预期行为说完了。「加字段 / 加列」按改动而非创造归类：它作用在**已存在的表单/表格**上，增量边界明确。
const MODIFY_INTENT_RE = /(?:改成|改为|换成|调成|调整|修改|修一下|修下|去掉|移除|删掉|挪|移到|移动|放到|换位置|重命名|改名|排序|置顶|上移|下移|对齐|统一|优化|收窄|放大|缩小|置灰|禁用|隐藏|显示|补上|(?:加|补)(?:一)?(?:个|列|条)?(?:字段|列|项)|加上文案|改文案|改样式|改间距|改颜色)/i

/**
 * 任务性质判定（唯一入口）。优先级从"人的显式表达"到"AI 的分类结论"再到"文本信号"，最后 fail-safe。
 *
 * 兜底方向刻意选 `requirement`：误判代价不对称——把 bug 当需求只是多问一句人（人回一句就续跑），
 * 把需求当 bug 会让 bot 凭空发明行为并写进仓库。
 */
export const resolveWorkKind = (task) => {
  if (isReadOnlyTask(task)) return WORK_KINDS.readonly
  const { type } = resolveCommandType(task)
  if (type === 'docs') return WORK_KINDS.docs
  // bug 表每一条都是 QA 立的缺陷单 / 验退单，来源本身即性质，不看正文措辞。
  if (isBugTableSource(task)) return WORK_KINDS.qaFeedback
  if (type === 'qa') return WORK_KINDS.qaFeedback
  if (type === 'fix' || type === 'test' || type === 'api') return WORK_KINDS.bugfix
  const text = task?.text || ''
  // 自带规格的显式改动（「改成 / 改为 X」+ 明确目标，且无「新增功能 / 立项」这类创造信号）本身就是
  // 增量反馈：预期行为已写在消息里。测试阶段 PM / QA 提的这类在边界内的小改动应直接实施——不该退回让人补 PRD。
  // 它可以越过一次上游 requirement 误判：intake 是 medium-confidence 的语义猜测，「改成 X」却是确定性的
  // 自带规格信号，后者更强。只有当消息同时含显式新需求信号（REQUIREMENT_SIGNAL_RE：新增功能 / 立项 / 走 G2）
  // 才交回 requirement。
  const isSelfContainedModify = MODIFY_INTENT_RE.test(text) && !REQUIREMENT_SIGNAL_RE.test(text)
  // @负责人 消息已由只读分类器判过 bug / requirement，那是比正则更强的证据，必须尊重——
  // 唯一的例外是上面的「自带规格改动」，它是更强的确定性证据，只越过 requirement 误判、不越过 bug 判定。
  const intake = task?.intake?.classification?.decision
  if (intake === 'bug') return WORK_KINDS.bugfix
  if (intake === 'requirement' && !isSelfContainedModify) return WORK_KINDS.requirement
  if (DEFECT_SIGNAL_RE.test(text)) return WORK_KINDS.bugfix
  if (REQUIREMENT_SIGNAL_RE.test(text)) return WORK_KINDS.requirement
  if (MODIFY_INTENT_RE.test(text)) return WORK_KINDS.bugfix
  // 截图本身就是缺陷证据（与 intake 分类器口径一致：短文字 + 图片按 bug 处理）。
  if (hasImageAttachment(task)) return WORK_KINDS.bugfix
  return WORK_KINDS.requirement
}

// 快车道判据（取代旧 isTestFeedbackTask）：由 workKind 派生，保证 prompt 模式、文档同步跳过、
// 流程 blocker 压制三处永远同口径。
export const isFastLaneTask = (task) => resolveTaskPolicy(task).fastLane

/**
 * 任务的生效策略 = workKind 策略 ∩ 来源资格。
 *
 * 来源白名单只管一件事：**只有 Lark 群 / bug 表这类"人在对话里提出的"任务才享受这套快车道与
 * 放行闸**。外部系统 POST 进来的工单既不该因措辞像 bug 就免掉 G2（旧口径「其它来源不扩权」），
 * 也不该被"群里一句话不构成规格"这条理由拦下——它根本不是群里的一句话。故两个方向都收窄。
 */
export const resolveTaskPolicy = (task, workKind = resolveWorkKind(task)) => {
  const policy = workKindPolicy(workKind)
  const eligible = isFastLaneSource(task)
  return {
    workKind,
    fastLane: policy.fastLane && eligible,
    suppressProcessBlockers: policy.suppressProcessBlockers && eligible,
    requiresHumanGoAhead: policy.requiresHumanGoAhead && eligible,
  }
}

// 人是否已经放行过：走过一轮 waiting_confirmation 并收到补料（resumeWithSupplement）即视为已确认。
export const hasHumanGoAhead = (task) =>
  Boolean(task?.resumeCount) || Boolean(task?.waitingHistory?.length) || Boolean(task?.qaReturnCount)

export const BLOCKER_CLASSES = { hard: 'hard', soft: 'soft', decision: 'decision', process: 'process' }

// hard：动不了。要么改动目标无法唯一确定（硬做等于猜），要么根本进不去（权限/凭证/环境）。
// 「哪个」刻意限定在**指代物**上（哪个页面 / 哪个组件…）：光是「用哪个」多半是在问方案取舍，那是 decision。
const HARD_RE = /范围|scope|目标(?:页面|组件|模块|文件)|无法定位|不能定位|定位不到|找不到(?:对应|相关)|多个候选|哪(?:个|一)[^。；\n]{0,6}(?:页面|组件|模块|文件|入口|位置|地方|项目|分支|仓库)|跨项目|(?:越出|超出|不属于)[^。；\n]{0,12}(?:当前项目|feature)|(?:扩大|新增|修改)[^。；\n]{0,12}(?:公共|全局|共享)|访问|权限|凭证|登录|账号|密钥|token|下载失败|代码不存在|工作目录|附件[^。；\n]{0,10}(?:失败|不可用)|测试环境|后台配置|无法读取|不可访问/i

// soft：外部依赖未就绪。前端能靠契约假设 + Mock 先推进到等待点（这正是 G3 MSW 的用途）。
const SOFT_RE = /(?:接口|api|swagger|字段|schema|后端|服务端|联调|数据源)[^。；\n]{0,16}(?:未|没有|尚未|待|不确定|未定|未提供|未上线|未就绪|未返回)|(?:未|尚未|待)(?:定|确定|提供|上线|就绪|联调)[^。；\n]{0,10}(?:接口|api|字段|schema)|mock|等(?:后端|接口|api|联调)/i

// decision：需要人拍板，但不妨碍先做一版。选一个 + 记录理由，在完成卡里请人复核。
const DECISION_RE = /(?:两|多|几)种(?:方案|实现|做法|选择)|(?:用|选|走)哪(?:个|一种?)|(?:方案|实现方式|交互|样式|文案)[^。；\n]{0,8}(?:待|需|需要)(?:定|确认|选择|拍板|决定)|需要?(?:产品|设计|PM|UX)[^。；\n]{0,10}(?:确认|拍板|决定|给)|二者|取舍/i

// process：流程材料/门禁。bug 与 QA 反馈里这是噪音（反馈本身就是规格）；新需求里这是真阻塞。
const PROCESS_RE = /G[0-8]\b|门禁|gate|立项|评审|签字|签核|rule[-\s]?session|kickoff|feature-inventory|(?:缺(?:少)?|未|没有|尚无|不存在)[^。；\n]{0,8}(?:PRD|prd|技术方案|需求文档|需求说明|设计稿|Figma|figma|QA\s*用例|验收标准|README|readme|清单|inventory|历史记录)|(?:文档|README|清单)[^。；\n]{0,6}(?:未|没)(?:更新|同步|建立)|历史(?:清单|证据|状态|流程)|流程材料/i

/**
 * 单条 blocker 归类。顺序即优先级：hard 最先（一条同时提到「范围不清」和「缺 PRD」的 blocker
 * 必须按 hard 处理），process 最后（它的措辞最容易与其它类共现）。**未命中任何类 → hard**。
 */
export const classifyBlocker = (text) => {
  const input = String(text || '')
  if (HARD_RE.test(input)) return BLOCKER_CLASSES.hard
  if (SOFT_RE.test(input)) return BLOCKER_CLASSES.soft
  if (DECISION_RE.test(input)) return BLOCKER_CLASSES.decision
  if (PROCESS_RE.test(input)) return BLOCKER_CLASSES.process
  return BLOCKER_CLASSES.hard
}

export const classifyBlockers = (blockers = []) =>
  blockers.map((text) => ({ text: String(text), class: classifyBlocker(text) }))

/**
 * 把 AI 的 `blocked` 分析结论按分类结果收敛成「真停 / 带假设推进」。
 *
 * 与旧 normalizeAnalysisForTask 的本质差别：这里**从不覆写 AI 的判断**，只是把它的 blockers 分门别类，
 * 然后按 workKind 决定哪些类构成停机理由。停 = 至少一条 hard，或（非快车道时）至少一条 process。
 * 放行时 soft / decision 不会被丢弃——它们变成 `assumptions` 进 prompt 与完成卡，人事后能看到
 * 「它是在什么假设下把活干完的」。
 *
 * 返回 { analysis, workKind, classified, assumptions, decisionLog, suppressed, changed }。
 */
export const resolveAnalysisGate = ({ task, analysis, workKind = resolveWorkKind(task) }) => {
  const base = { workKind, classified: [], assumptions: [], suppressed: [], changed: false }
  if (analysis?.status !== 'blocked') return { ...base, analysis }

  const policy = resolveTaskPolicy(task, workKind)
  const classified = classifyBlockers(analysis.blockers)
  const pick = (kind) => classified.filter((item) => item.class === kind).map((item) => item.text)
  const hard = pick(BLOCKER_CLASSES.hard)
  const soft = pick(BLOCKER_CLASSES.soft)
  const decision = pick(BLOCKER_CLASSES.decision)
  const process = pick(BLOCKER_CLASSES.process)

  const blockingProcess = policy.suppressProcessBlockers ? [] : process
  const suppressed = policy.suppressProcessBlockers ? process : []
  const blocking = [...hard, ...blockingProcess]

  if (blocking.length) {
    // 一条都没被归为非阻塞 → 原样透传（含对象身份），"没变"就该真的没变。
    if (blocking.length === classified.length) return { ...base, classified, analysis }
    return {
      ...base,
      classified,
      suppressed,
      changed: true,
      // 停机时也不带走 soft/decision：它们不是停的理由，混进群卡会让人误以为要先去催接口。
      analysis: { ...analysis, blockers: blocking },
    }
  }

  // 无 hard、无生效的 process → 可以动手。soft/decision 转成显式假设随实施 prompt 下发。
  const assumptions = [
    ...soft.map((text) => `外部依赖未就绪：${text} → 按现有契约/Mock 假设推进，不等待，实施后在完成说明里标注该假设`),
    ...decision.map((text) => `需人工拍板：${text} → 选一个最贴合现状的方案实现，并在完成说明里写清选择与理由，供人复核`),
  ]
  return {
    ...base,
    classified,
    suppressed,
    assumptions,
    changed: true,
    analysis: {
      ...analysis,
      status: 'ready',
      summary: `${analysis.summary}；已按阻塞分类判定可推进（无硬阻塞${suppressed.length ? `，${suppressed.length} 条流程材料类阻塞按 ${WORK_KIND_LABELS[workKind]} 免除` : ''}${assumptions.length ? `，${assumptions.length} 条待定项转为显式假设` : ''}）。`,
      requirements: [
        ...(analysis.requirements || []),
        '严格限定在反馈可定位的修改范围内，不扩大到相邻功能',
        ...assumptions,
      ],
      blockers: [],
      assumptions,
    },
  }
}

// 新需求是否带着「够 AI 自评的上下文」：有附件（设计稿 / 截图 / 文件本身即规格），或正文已带一定细节
// （测试阶段话题里 @bot 会把兄弟回复并入正文，讨论越充分正文越长），就认为有料可自评。阈值是个便宜的
// 下限，不是精判——真正判「够不够唯一推导规格」的是能读代码/上下文的 AI（见 buildTaskPrompt 自评段）。
export const REQUIREMENT_SELF_ASSESS_MIN_CHARS = 24
export const requirementHasSpecContext = (task) =>
  Boolean((task?.attachments || []).length) || (task?.text || '').trim().length >= REQUIREMENT_SELF_ASSESS_MIN_CHARS

/**
 * 新需求放行闸（混合兜底）：撤掉「AI 前纯正则盲拦每条新需求」——那把尺子读不到上下文，会把
 * 「话题里讨论清楚 / 带了设计稿」的新需求也一并退回让人补料，正是「太烦人」的根因。
 *
 * 现在只在**连自评材料都没有**时才在跑 AI 之前拦：未放行的新需求 + 无附件 + 正文是裸一句话。
 * 这种消息 AI 也只能空手，先问一句比烧一次 AI 更省。其余（有附件 / 正文有细节）一律放行到 AI，
 * 由 buildTaskPrompt 的「开工前只读自评」判断：能从上下文唯一推导规格就直接做，不够再 waiting_confirmation
 * 并列出具体缺口。codex 执行器另有独立只读分析阶段自评，此闸对四种执行器都只做这层裸一句话兜底。
 * 返回 null 表示可以继续执行。
 */
export const requirementGate = (task) => {
  const workKind = resolveWorkKind(task)
  if (!resolveTaskPolicy(task, workKind).requiresHumanGoAhead) return null
  if (hasHumanGoAhead(task)) return null
  // 有可自评上下文 → 不盲拦，交给能读代码/上下文的 AI 自评（少烦人）。
  if (requirementHasSpecContext(task)) return null
  // 只剩「裸一句话、无附件、无上下文」：先问一句预期行为再开工。
  return {
    workKind,
    status: 'waiting_confirmation',
    blockers: [
      '这条被判定为**新需求**，但只有一句话、没有附件也没有可参考的上下文，还不够唯一推导实现规格',
      '补一句可验收的预期行为即可开工：说清预期行为 / 边界 / 异常态，或附 PRD / 设计稿 / 截图',
    ],
    nextStep: `直接回复本卡片补一句预期行为即可续跑开发（也可用「继续任务 ${task.id} <补充内容>」）——无需回去改 PRD；仅当是与本项目无关的独立大功能，才建议走 docs-tdd kickoff 立项。`,
  }
}
