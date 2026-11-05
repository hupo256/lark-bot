# Task 边界与回复策略

> Lark Bot 子系统文档之一，索引见 [README.md](../README.md)。
> 本文是 Worker 执行任务时**必须遵守的策略层**：生命周期、解析、自动执行 / 必须确认边界、完成汇报与回复格式、阻塞超时。

群里有人 @ 应用后，系统必须先生成 task，再由 Worker 执行；不得让群消息直接驱动无记录的代码修改。

## 1. Task 生命周期

| 状态 | 含义 | 下一步 |
|------|------|--------|
| `received` | Gateway 收到 Lark 事件并通过白名单、幂等校验，等 worker 的只读分类器判这条是什么（11-01 起 @bot / 私信 / 回复 bot 都先到这里；只 @ 负责人 / @所有人 的 11-02 起不处理） | 分类后开跑 / 自答 / 追问 / 疑似 / 忽略（见 §7） |
| `answered` | 问 bot 自己的问题，分类器一句就答完（`selfAnswer`），不建执行；负责人以外的人问也走这里（11-03 R9），但要 high / medium，low 照旧落疑似 | 终态，定期清理 |
| `ignored` | 判定不用处理（普通聊天 / 别人的事 / 只记一笔的对接答复），@ 了 bot 的回一句「记下了」 | 静默终止，定期清理 |
| `intake_failed` | 只读分类器异常（瞬时错误会先重试两次） | 不执行代码；挂着的「收到」撤掉不发、私信负责人一句（11-03）；health 告警、保留审计 |
| `queued` | 已生成 Job 并入队 | Worker 领取 |
| `waiting_confirmation` | 范围、PRD、API、QA、登录账号、权限、环境或其他材料存在需人工确认 / 补充项 | 自动发送待确认 / 补信息通知，尽量 @ 具体责任人，回群等确认 |
| `running` | 已开始改文档 / 代码 / 自测 | 持续记录进展 |
| `verifying` | 已完成修改，正在跑 Biome、测试、type-check | 生成验证摘要 |
| `done` | Lark 轻量链已完成、Worker 终检通过且改动已本地提交；这是**候选修复完成**，不是项目正式交付凭证 | 项目正式交付另走人工 review |
| `done_pending_writeback` | 仅 bug 表来源：改动已提交、群里已发完成卡，但记录状态回写失败 | Gateway 每 5min 重试；到上限（默认 12 次 ≈1h）**停止重试并保持本状态**，发告警请人手动改表格。**不落 `done`**——群里说完成而表格还挂着待处理，这个不一致必须一直可见（`done` 会被每小时的终态清理抹掉、health 计数里也不再点名） |
| `no_change_needed` | **非完成态终局**：经核对确认改动属**后台 API 服务 / 另一个 git 仓库 / 非代码职责**（判据是「不属本 git 仓库」，**不是**「不属本前端 app」——同 monorepo 内另一个 app/package 如 admin/futures-admin 仍是本仓可改，不走此态） | 发独立回执卡（既非绿完成卡也非红失败卡）说明为何本仓无需改动 + 建议的接手方；无 diff、无提交，不进规范闸与「done+空 diff 不可信」评估；bug 表记录不写完成值，留待人工重派 |
| `blocked` | 无法继续，需要外部资料或权限 | 回群说明阻塞 |
| `failed` | 执行异常或命令失败 | 回群说明失败和下一步 |

`done_with_warnings` 是 AI 侧状态而非独立生命周期态：它带着告警清单收敛到 `done`（见 [lark-status-meta.mjs](../../lib/lark-status-meta.mjs)）。

**一次执行一个结论**：任何一次任务执行最终只往群里 / 私信发一条结论（人话，见 §4），`done` / `failed` / `waiting_confirmation` / `blocked` / `no_change_needed` 互斥。`no_change_needed` 绝不说成「已修好」：那会让群里读到已修好，而实际一行代码都没动。worker 随状态回写结构化 `outcome`（summary / blockers / report / 分支 / 改了几个文件），出口只读它；文本 `result` 并存给审计与 `lark-bot status`。

**「显示值/字段名错误」类 bug 的排查铁律**：先定位到出错的**那一列**、它的 `dataIndex` 与渲染器。若前端只是原样透出后端数据（`v || emptyText`、无映射 / 无格式化），显示不对属**后端数据 / 配置问题** → 判 `no_change_needed`，summary 引用 API 响应证据（哪个字段返回了什么）、指向后台。**绝不**因关键词相近就去改「长得像」的邻列常量 / 映射伪造修复，也不改一个没被点名、原本正确的列。反例见 PR-01930：bug 指「体验金名称」列（`trialFeeName`，API 直出且值内含金额 10/20/30USDT），却误改了旁边「类型」列（`trialMode` 映射）——真 bug 没修、还擅改了 PRD-aligned 的列，三重错。「done + 非空 diff」可信度评估只看有没有 diff、看不出 diff 打在无关字段上，故此类误判需靠本铁律在下刀前拦住。

## 2. 解析规则

Gateway / Worker 至少提取：

- 任务类型：`docs / fix / test / api / qa / status`。
- 项目范围：优先从消息中的项目名、PR 号、路由、文档路径推断；推断不到则回群询问。
- 目标文件或页面：如 `/tradfi`、`apps/web/src/apps/TradFi`、`packages/ui`。
- 上下文与附件：合并被引用父消息及同话题其他真人回复的文字；父消息、当前消息和兄弟回复中的图片都必须进入 task，并通过 lark-cli bot 身份下载成 `localPath`，让 AI 可以直接看图。下载失败须保留 `imageKey/width/height/downloadError`。上下文包还会把被引用 / 话题 / 群里之前消息里别人发的图和文件挂进附件（`origin` 标来源）；有非「本条」来源时，提示在数据块外注明「标『本条』的才是这条消息自己带的，其余只作前文证据，别说成对方这条发的」（11-03 falive 回放 r3-c：Encone 的消息没带图，结论却说「截图里浏览器直接打开报的非法请求」，图全是群里之前 Kaiser 等人发的）。
- 是否需要确认：群任务和 Bug 表反馈只确认修改范围；安全动作仍按原边界处理，不混成 G2。
- 责任人：优先从 @ 对象、消息上下文、项目文档负责人字段、QA / API / 设计归属推断；无法推断时标记为项目负责人 / 群内负责人。
- 回群线程：使用原消息 thread / message id 作为汇报目标，避免刷屏。Lark 消息发起的任务（私信或群里 @bot）结论只回原会话，正文带了别的项目号也不改投项目群（`deliveryChatIdFor`；11-02 豁免私信，11-03 R4 群里发起的也留在原群——改投后回复失败回落直发，群 A 的答案进了群 B，发件簿 / 回复义务也记错会话）；按项目号改投只给没有来源群的 bug 表任务。

## 3. 自动执行 / 必须确认边界

白名单群 + 白名单用户 + 当前项目范围内，以下可自动执行：

- 文档补充、格式修正、状态同步。
- 小范围 bug 修复、UI 偏差修复、测试补充。
- 运行风险分级要求的静态检查和最小测试。
- 输出 QA / PRD / Figma 差异清单。
- 读取 Lark PRD、Wiki、Swagger、QA 用例，读取 PRD 缓存（`~/.prd-cache/<ID>/`，prd-to-commit 落盘）、Figma 记录和当前项目代码。
- 修改当前项目相关前端代码；对触达 JS / TS / JSON 文件运行 Biome。
- 任务明确要求视觉验收时仅复用已运行页面；沙箱内不启动 dev server。
- 回群回复阶段结果、缺信息项和验证摘要。

**测试反馈**：白名单群任务和 Bug 表任务即依据。只确认范围；能由任务、附件和代码定位便实施。G2、历史 gate 不阻断，风险级只决定验证；仅范围不清、越界或扩大公共能力时询问。

以下只生成 task，不自动执行，必须先回群确认：

- 常规任务 scope 不清；群任务 / Bug 表反馈仅在范围不唯一或越界时确认，不受历史清单状态阻断。
- 缺 PRD、Figma、API 样例、QA 用例、登录账号、账号权限、测试环境、后台配置或验收数据。
- 无新指令时 QA / PRD 冲突；API 文档与当前 Mock / PRD 冲突（已有明确修改指令时以最新群反馈为准）。
- 需要新增全局设计 token / Tailwind preset、公共架构调整或跨项目重构。
- 需要读取生产数据、密钥、账号、Cookie 或内网敏感地址。
- 需要安装依赖、push、开 PR、部署、改 CI/CD。（**本地 commit 例外**：bot 提交自己产生的改动是既定行为，口径见 §3.2 与 [lark-commit-policy.mjs](../../lib/lark-commit-policy.mjs)；push / PR 一律不做。）
- 任务影响范围超出当前 `apps/web` 或当前 feature。

进入上述任一场景时，Worker 必须把 task 状态置为 `waiting_confirmation`，并自动发送待确认 / 补信息通知。通知里要写清缺什么、影响哪个阶段、需要谁处理；能识别责任人时必须 @ 具体人，不能识别时 @ 项目负责人 / 群内负责人。**已落地实现**：AI 结构化结果（`lark-ai-result.schema.json`）status 支持 `waiting_confirmation`，并可带 `blockers`（逐条列缺什么）、`owner`（推断责任人 / 角色）；Worker 原样回写该状态（不跑规范闸、不提交改动）并把 `owner` 随状态回写带给 Gateway；Gateway `handleStatusUpdate` 对 `waiting_confirmation` / `blocked` 发**橙色独立回执卡**（区别于绿/红的完成/失败卡）。**责任人 @ 落地**（`resolveOwnerMention`）：AI 自报 `owner`（角色 / 关键词）命中项目配置 `config.ownerMap`（`角色/关键词 → open_id`，可选表）则 `<at>` 对应责任人；未命中则回落 `<at>` 触发人（`task.operator`）并注明「未在责任人表识别，暂 @ 提单人」；bug 表任务由 poller 把负责 RD 写入 `operator`，保证无法识别业务 owner 时仍有人接收。**续任务闭环**（`store.resumeWithSupplement` + `resolveResumeTarget` / `handleResume`）：Gateway 保存待确认卡和催办卡的真实 Lark `message_id → task.id` 关联；只有以下情形算**续跑意图**：① 发送 `继续任务 <taskId> <补充内容>` 显式指令；② 明确回复（`reply_to`）机器人回执卡；③ 明确回复仍处 `waiting_confirmation`/`blocked` 的原任务消息；④ 无 `reply_to`、仅会话线程根 `root_id`，且它命中机器人回执卡**或原任务消息本身**、对应任务仍处 `waiting_confirmation`/`blocked`（话题内直接发补料时 Lark 不带 `reply_to`；收窄点在「仍卡着」，已完成的话题根一律按新任务处理）。②③④ 是隐式续跑，还要过「像是对机器人说的」门槛（`implicitResumeVerdict`，§5 `resume`）：同事在挂起卡下互相 @ / 抄送 / 寒暄不算续跑意图。命中续跑意图即复用**原任务**（append 补料 + 合并附件 + 保存本轮结论到 `waitingHistory` + 复用同一分支/worktree），置回 `queued` 并 bump `epoch`；回执关联持久化且只接受当前 epoch，重启不丢、旧轮次卡片也不能误续跑新一轮。**边界硬规则**：一旦识别出续跑意图，本条消息只走续跑分支——目标不存在 / 不在待确认·阻塞态 / 无补充内容时**显式回执说明并 return，绝不 fall through 新建孤儿任务**（否则补料落空、原任务继续卡着而群里无感知）。**关键约束**：AI 遇缺材料严禁猜测生成文案 / 默认值硬做，也严禁误判成 `failed`；`failed` 只留给工具 / 环境 / 权限等技术性失败。

任务正文引用 Figma 设计稿时还有一层实施前硬边界：Worker 必须先用 `figma-spec.mjs` 预取并落盘设计规格，再把路径交给 AI。若链接不可访问、node-id 无效或缺少 `FIGMA_TOKEN` / `FIGMA_API_KEY`，任务转 `waiting_confirmation`，不得降级为“只看截图继续实现”。

## 3.1 任务性质（workKind）与阻塞四分类

§3 的「自动执行 / 必须确认」不再靠一条正则白名单硬压，而是先判**任务性质**、再对 AI 给出的每条 blocker 做**四分类**。实装在 [lark-work-policy.mjs](../../lib/lark-work-policy.mjs)（纯函数，`node --test __tests__/lark-work-policy.test.mjs` 直测），语义为单一事实源。

**任务性质 `workKind`**（`resolveWorkKind`，优先级从人的显式表达到 AI 分类结论再到文本信号，最后 fail-safe）：

| workKind | 判据 | fastLane | 压制流程 blocker | 需人工放行 |
|---|---|---|---|---|
| `readonly` | 状态查询等只读命令 | 否 | 否 | 否 |
| `docs` | 文档类命令 | 否 | 否 | 否 |
| `bugfix` | fix/test/api 命令、缺陷信号、「改成 X」类增量、截图 | 是 | 是 | 否 |
| `qa_feedback` | bug 表来源、qa 命令 | 是 | 是 | 否 |
| `requirement` | 交办尚不存在的行为（新增…功能/页面/模块），或兜底 | 否 | 否 | **是** |

上述 fastLane / 压制 / 需放行三档还要**与来源资格取交集**（`isFastLaneSource`：仅 `lark` / `lark-bugtable`）：外部系统投递的工单既不因措辞像 bug 就免 G2，也不被「群里一句话不构成规格」拦下——它根本不是群里的一句话。兜底方向刻意选 `requirement`：把 bug 误当需求只多问一句人，把需求误当 bug 会让 bot 凭空发明行为写进仓库。

**阻塞四分类**（`classifyBlocker`，顺序即优先级，未命中任何类 → `hard` 即 fail-closed）：

| 类 | 含义 | 处置 |
|---|---|---|
| `hard` | 改动目标无法唯一定位，或缺权限/凭证/环境 | **停**。硬做必错 |
| `soft` | 外部依赖未就绪（接口未定、后端未上） | **不停**。按契约/Mock 假设推进，假设登记进 `assumptions` 随实施 prompt 下发 |
| `decision` | 有多个合理取舍需人拍板 | **不停**。选一个并在完成卡记录理由供复核 |
| `process` | 流程材料缺失（G2/PRD/技术方案/历史 gate） | **看 workKind**：bug/QA 反馈可压制，新需求不可 |

关键：`resolveAnalysisGate` **从不覆写 AI 的判断**，只把 blockers 分门别类，再由 workKind 决定哪些类构成停机（`hard` + 非快车道时的 `process`）。这取代了旧的 `SCOPE_OR_ACCESS_BLOCKER_RE`「命不中就整条改写成 ready」的默认放行。

**对接答复类的降级**（`classifyTaskBlockers`，只对契约 `api` / `api:` 前缀的任务）：对方在答复我方的对接问题，答复本身就是材料。blocker 首句（冒号前）是「再要文档 / 契约 / 调用时机 / 再确认」的，从 `hard` 降为 `soft`，转成假设随实施下发、不停机（10-31 falive 回放：Arthur 答「完善资料部分需要前端接入」，bot 反过来要接口文档，四条全判 hard 停机）。两种不降：首句在要账号 / 权限 / 凭证 / token / 授权；整条（首句或细节）提到金额 / 余额 / 手续费 / 费率 / 价格 / 状态 / 枚举 / 权限（含 `fee` / `amount` / `balance` / `price` / `status` / `enum` / `permission` 及 `feeRate` / `orderStatus` 这类驼峰）——这几类取不到证据就该 blocked，不按 Mock 猜着实施（fix10 review：fee 口径、available 是否扣冻结、status 枚举含义原来被降成 soft → ready）。分析提示同时加了一条「答复正文就是材料，能推就推，不把再要文档 / 再确认写成 blocker；前文别的事不并进本条」。

**新需求放行闸（混合兜底）**（`requirementGate`，在 [lark-task-runner.mjs](../../lib/lark-task-runner.mjs) 里于**跑 AI、动 worktree 之前**执行）：判为 `requirement` 且人尚未放行过（无 `resumeCount`/`waitingHistory`/`qaReturnCount`）时——**仅当连自评材料都没有（`requirementHasSpecContext` 为 false：无附件，且正文短于 `REQUIREMENT_SELF_ASSESS_MIN_CHARS`=24 的裸一句话）**——才直接回一张 `waiting_confirmation` 卡、一次 AI 都不跑（这种消息 AI 也只能空手，先问一句比烧一次 AI 省）。**其余新需求（有附件 / 正文有细节）不再盲拦**，一律放行到 AI 由能读上下文的它自评。历史上这里对**每条**新需求盲拦，靠纯正则读不到话题讨论 / 设计稿，把已说清的新需求也退回补料——正是「太烦人」的根因。自评在只读分析阶段做（四种执行器同一阶段，`buildAnalysisPrompt` 的「新需求自评」段）：能从上下文唯一推导规格就 `ready` 直接做，不够再 `blocked` 并**具体**列出缺口，经 `resolveAnalysisGate` 归类。人回复卡片补一句预期行为即视为放行、续跑。

## 3.1.1 只读分析阶段与修改范围契约

实装在 [lark-scope-contract.mjs](../../lib/lark-scope-contract.mjs)（纯函数，`node --test __tests__/lark-scope-contract.test.mjs` 直测），编排在 `runAI` 与 task-runner 收尾。

- **所有执行器先只读分析**：非只读任务不分 `claude` / `codex` / `pi` / `cursor`，一律「只读分析 → 实施」两阶段，分析前后 git status/diff 必须一致；只读查询除 codex 外仍单趟。bug 表任务是「分诊 → 分析 → 实施」三次调用。
- **分析输出 `scope`**：`targets`（必须改的文件 + symbols + 理由）与 `siblings`（同因搜索词 + 全部命中逐项 include/exclude + 理由）。集合型任务（`detectSetOperationCue` 命中「统一 / 全部 / 涉及 N 处」等）提示里点名命中词，`siblings.items` 不得为空。
- **实施只改契约内文件**：契约作为可信输入注入实施提示；实施中发现必须改契约外文件时停下返回 `waiting_confirmation`，在 blockers 写明文件与理由。
- **收尾硬检查**（会改代码的 workKind：bugfix / qa_feedback / requirement，且非 test/docs 命令）：在 `assessDoneResult` 判可信之后、提交之前核对「实测改动 ⊆ targets ∪ include 的 siblings ∪ 自动放行 ∪ 人工批准」，并检查禁区（`FORBIDDEN_PATH_RULES`：package.json、lockfile、pnpm-workspace.yaml、.npmrc、Biome / TS / Turbo 配置、packages/config、.github、.husky）、行数上限（默认 bugfix 120 / qa_feedback 200 / requirement 400，本机 `scopeBudgets` 可覆盖）与集合型兄弟清单。不通过 → **不提交、不回滚**，以 `waiting_confirmation` 挂起；声明纳入但实测没改的兄弟位置只作提醒。审计记 `scopeCheck`。
- **卡片**：完成卡与阻断卡都在结论之后、系统实测之前附「修改范围契约」段落（契约目标、搜索词、纳入 / 排除理由、自动放行、越界、禁区、超行数、人工批准）。
- **放行（确认扩大范围）复用续跑出口**：挂起时 worker 回写 `scopeRequest`（被拦文件 / 超行数 / 缺兄弟清单）。人回复该卡片「确认扩大范围」（可附额外文件路径；裸「确认 / 可以」不算，带「不要 / 只改」等否定不算），续跑时 `resumeWithSupplement` 记入 `task.scopeApprovals: [{ paths, allowOverBudget, waiveSiblings, approvedBy, at }]`，重跑的分析阶段把它们列为可信额外目标、收尾并入允许集合；禁区文件也必须显式出现在批准里。回复的是收窄说明（「不要改 X，只改 Y」）则按普通补料续跑，不放行任何文件。

## 3.2 人类 WIP 隔离与 L2 契约改动的 type-check 闸

- **绝不自动提交人类 WIP**：命中的已有 worktree 在任务开始前若已有未提交改动，任务会**改路由到隔离的临时 worktree**（`tempWorktreeContextFor`）；hotfix 从该项目 worktree 当前分支当时的已提交 HEAD 创建（不退回 `origin/online`），未提交 WIP 不会复制进来，原工作区也完全不被触碰。
- **自动提交口径的唯一事实源**是 [lark-commit-policy.mjs](../../lib/lark-commit-policy.mjs)（`resolveCommitMode`，纯函数直测）：

  | 场景 | 模式 | 行为 |
  |---|---|---|
  | 只读任务 | `none` | 不产生改动，任何写都是越界 |
  | 任务未完成（failed / blocked / 异常） | `none` | 半成品不入库，保留现场待人工 |
  | 隔离临时 worktree（默认 `origin/online`；WIP 改路由时基于项目分支 HEAD） | `auto` | 分支是 bot 自己开的，全量 `git add -A` 提交 |
  | 命中人类已有 worktree 的当前分支 | `scoped` | **只**提交本任务实测改动清单里的路径 |

  `scoped` 存在的理由：上面那条路由检查只发生在**任务开始前**，而 AI 可以跑 30 分钟——这期间人在同一 worktree 新写的 WIP 会被 `git add -A` 一并扫走。改成按实测清单定向 `git commit -- <pathspec>` 后，收尾时才出现的路径既不入库也不被静默忽略：它们进 `unexpected`，写进完成卡请人确认。三种模式**都不 push、不开 PR**。
- **L2 契约/共享改动缺 type-check 证据 → 降级人工复核**（`assessDoneResult`）：改动触达 schema / mapper / api / `.d.ts` / `packages/` 时，若 AI 自报的 `checks` 里没有 type-check 证据，则**不按 done 处理**（这类改动最易静默改坏调用方；实施 prompt 已明确要求 L2/L3 在触达包跑一次 `tsc`）。注意这与「我们自己按整包 `tsc` exit code 硬判」不同——那会被历史基线红误伤，我们从不那么做；这里只校验 AI 是否给出了它本应产出的 type-check 证据。
- **修复类任务「只动了测试文件」→ 与空 diff 同等不可信、降级人工复核**（`assessDoneResult` 的 `expectsCodeFix` + `isTestOnlyDiff`）：bug / QA 反馈 / 需求类任务（`workKind ∈ bugfix/qa_feedback/requirement`，且命令类型非 `test`/`docs`）报 `done`，但本次实测改动**全是** `*.test.*`/`*.spec.*`/`__tests__/` 文件时，判不可信降级。理由：一个回归测试不构成对已上报缺陷的修复——这正是「done+空 diff 不可信」那道闸**反向逼出来的敷衍**（加个 `index.test.ts` 凑非空 diff 冒充完成）。此时正确出口只有两条：① 根因在后端/数据/别的仓 → `no_change_needed` + 证据；② 确属前端 → 改真正出错的业务代码。**能不动代码就不动代码，但绝不能拿测试凑数走过场。**（沿革：PR-02172「Telegram 绑定重复关联」被 Pi 误判前端、只加一个测试文件报完成——重复关联记录是后端数据/去重问题，应判 `no_change_needed` 回群说明，而非在前端凑 diff。）

## 3.3 Lark lightweight 与 v3.3 的边界

Lark 保留自己的任务生命周期、AI 分析、质量闸和本地提交链，**不接入 v3.3 状态机**，避免群内小修复被项目级流程绑死，也避免两套状态互相映射后产生双重真值。

- Lark 审计固定写 `assuranceMode: lark-lightweight`、`deliveryAuthority: false`；`done` 只表示候选修复已通过 Lark 本地闭环并落到本地分支。
- Worker 在 AI 实施和规范纠正全部结束后，对**最终工作树**亲自执行 `git diff --check` 与触达文件 Biome，回执绑定当时的 `HEAD + diffHash + changedFiles`；AI 自报的 `checks` 只作补充说明，不能替代 Worker 回执。
- 开工、终检、提交前分别核对任务项目、cwd、真实 git root、branch 与开工 HEAD。任务期间若切分支或绕过 Worker 自行 commit，自动提交 fail-closed，现场保留。
- schema / mapper / API / `.d.ts` / `packages/` 等 L2 高风险改动仍需在正式交付前另取 v3.3 authoritative PASS；该内部交付口径只写审计，不展示在普通群结果卡中，也不把 Lark 状态同步进 `work-item.json`。
- 只有项目级 v3.3 结果满足 `mode=enforced,status=passed,ok=true,assuranceMode=autonomous,evidenceTrust=cli-attested`，才具有正式交付权。

## 4. 人话出口（2026-11-01 起；卡片退役）

任务相关的所有回复都是 **markdown 文本、回复原消息**（原消息在话题里就回话题流），由代码按结构化结果渲染（`lib/lark-human-text.mjs`），不再有「任务 ID / 执行器 / 等待轮次 / 如何继续」这类模板行。卡片只剩网关告警（死信 / 长连接掉线 / bug 表回写失败）。

一条 @bot / 私信有且只有一个下文（falive 不变量 I1）：先一句「收到」（分类器按上下文写的，到点 45s 没分类才用固定句），再一条结论；私聊指示、续跑、重跑都记在同一份**回复义务**上（`runtime/lark-obligations/`），答应了 4h 没结论私信负责人一次，群里不补话。终态重开并入的来源（`task.answerFor`，见 §7）这轮结论发出时，它的义务一并记 answered（只补开过、还没答的）。

「收到」挂着时任务先了结（人工结单 / 取消、判不处理、自答、分类失败）就只撤不发（11-03 R2：@bot 后 20 秒内回「算了不用了」，结单回执之后 45s 巡检又补一句「稍后回你」）：`closeAsExternallyResolved` 清掉 `ackPending`，巡检对非活动态到点的也只撤不发。

每种消息（phase）走 `lib/lark-group-phases.mjs` 的出口规则表（超长转文档 / 去重 / 回复还是直发 / 要不要登记回执），`lib/lark-group-exit.mjs sendReply` 是唯一出口：过出口闸（同内容 24h 不重发、固定话术同人 2 分钟一条、自答 / 追问按消息 24h 一次——两个人问同样的问题各自要得到答复）、记发件簿（`runtime/lark-outbox/`）、发成功登记回执（回复 bot 任何一句都能锚回任务）。

按交付物（`task.contract.deliverable`）与状态，群里 / 负责人各说什么：

| 交付物 · 状态 | 群里（回复原消息） | 负责人私信 |
|---|---|---|
| 收到 | 分类器写的那句（≤40 字口语，不许诺发帖 / 造数这类写操作、前文说清的环境不反问，11-03 falive 回放）；无则「收到，我看一下，稍后回你。」；分类前任务已了结的只撤不发 | — |
| 开跑 | — | `🛠 开始做：<标题>（<群>）`（负责人自己私信发起的不发） |
| 代答 done | report 原样（答案首行 + 保留项符号），不加 ✅；行首 @ 提问人（他不是负责人、也不在待跟进里时；11-03 falive 回放 wrong_target：原来只 @ 待跟进的人，像在催别人）；待跟进只列要动手的、每人一行，不 @ 负责人本人；材料超长转文档附链接 | 提单人不是他、或待跟进里有他的事项时 `💬 替你答了（群）：首行`（去掉行首 @）+ 末行 `你这边：…` |
| 实测 done | `<对象>：都通了 / 通了 a 项，没通 b 项` + `- ✅/⚠️/❌ 条目：证据`；会话里没真跑过探针 / 页面工具的条目标「待验证」 | 同上 |
| 改码 done | 摘要首句 / `分支 X · 改了 N 个文件` / 待跟进每人一行（不 @ 负责人本人，11-03 falive 回放 10-30：「找 aven」把他 @ 出来讲内部限制）/ `详细见：链接` | `✅ 标题（群）· 分支 · 改了 N 个文件` + `群里已回「…」`；待跟进里写给他的事项进末行 `你这边：…`（他私信发起的照常列在结论里） |
| 改码 no_change | `看过了，这个不用改前端：…要 X 看下。` | `ℹ️ 看过了，不用改（群）：…` |
| 改码 blocked / waiting | 有外部可要的材料且有人可 @（责任人 / 待补充里点名的 ownerMap 同事 / 待补充里点名、在本条上下文里说过话的人 `task.contextPeople`，11-05 起）：`@人 「标题」需要你们帮忙：- …`（查到根因在对方：`请处理：`）；否则不发群 | `⏸ 停下来了（群）：标题 / 要：…`；写了群回复却没发的作草稿：`没问题就回「就这样回」，我把下面这段原样发群：` |
| 改码 failed | 不发群 | `⛔ 没做成（群）：…` + 下一步；有完成旁证 `⚠ 可能做成了、但没拿到结果` |
| 运维 | — | 结果原文（`online 已经是 9f3c2a1，没有新内容，不发。`）；失败前加 ⛔。部署信发出后只提示「部署好后要复测就私信我「<env> 复测」」，不承诺自动探测复测（lark-bot 没有这条链路，falive 靠 bugpoll 部署钩子、没移植；11-03 falive 回放发现） |
| 判不用处理但 @ 了 bot | `收到，记下了。` 或分类器的礼貌一句（不承诺后续） | forMe≠true 时 `🤔 …判断不用我处理…判错了回「继续任务 id 做」` |
| 分类失败（非瞬时） | —（挂着的「收到」撤掉，不先承诺再静默） | `⛔ 这条我没分出来是什么事，你看下（群）：标题`；「收到」已发过固定句的义务记 owed，不当了结 |
| 疑似（没叫 bot 的提问 / 拿不准） | — | `❓ 可能是你的事（群）：标题 / 是 → 回「继续任务 id 做」；不是 → 回「取消任务 id」。不回也不催，48 小时后自动关。` |
| 催办 | 改码类等材料 4h：`@提单人 「标题」还在等你补：…补上回我一句就继续。` | 8h：`⏰ …等了 8 小时没人补材料，我不再催群里了。要关掉回「取消任务 id」。` |
| 每天 09:30 | — | `等你决定的 n 条`（疑似 / 扣下的群回复 / 答应了没结论 / 等材料超 24h）；n=0 不发 |
| 并入了别人的补充（done / no_change_needed） | 结论末行 `@并入人 你（们）的补充也一起处理了。`（见 §7） | — |

规则：

- 群消息先一句结论、说人话、写短；不贴 diff、路径、sha、内部状态名；细节（curl / 复现步骤 / 清单）写进 `detailDoc`，bot 建成 Lark 文档、群里只放链接；文档链接按「任务 + 代次 + 状态」记在 `task.publishedDoc`，回执重试复用、不重复建（11-03 R12）。
- 交付前续同一会话各一次（只 claude）：缺陷单报完成、实测 diff 只有注释 / 文档 → 改口（还原后按 `no_change_needed` 说原因，不说已修复；`lib/lark-cosmetic-diff.mjs`）；结论在向人要东西（挂起 / blockers / 待跟进）且本条之后群里 / 话题里有真人新消息（≤ 8 条）→ 回看一次，给了的用上或接住、不再重复要（`lib/lark-late-messages.mjs`）。11-05 b3。
- 闸只管改动能不能提交，不吞对提问人的回答（I3）：代答 / 实测即便 AI 判 blocked 也是 done，答案里说「查不到 / 没测通」；改码类做砸了草稿扣下私信负责人，回「就这样回」才发群。
- 群里能不说就不说（I6）：开跑知会、失败、疑似、过期、催办第二轮都只私信负责人；同话题挂起兄弟被收尾也不在群里知会。
- 任务 ID、触达文件、规则扫描、完整命令输出只写审计；`lark-bot status` 与旧任务回落仍用文本 `result`。
- 失败必须说明是工具失败、环境失败、权限失败还是需求不清；**AI 退出但未显式回写 done/failed 时一律判 `failed`**（无回写 = 无验证 = 不可信）。
- 图片 / 视觉任务不能因为文字简短就快速失败；只有 Lark 图片下载凭证缺失、图片下载失败、代码不可访问等技术原因才能回写 failed，并明确说明具体技术卡点。

## 5. 回复策略

### 5.0 任务控制通道（回复 Bot 卡片 ≠ 新任务入口）

能锚定到 Bot 卡片 / 原任务消息的回复进入**任务控制通道**：结单、残余请求确认、暂停、重开、补料、查状态或意图确认，**绝不 fall through 新建 task**。实现位于 [lark-ingest.mjs](../../lib/lark-ingest.mjs) 与 [lark-message.mjs](../../lib/lark-message.mjs)，路由决策为纯函数。

- **两条入口**：① **L3 显式指令**（`maybeHandleControlDirective`，最强意图，先于回复锚定）——`结单 <id>` / `取消任务 <id>` / `重开任务 <id>`（`parseControlDirective`，与 `parseResumeDirective` 对称，带显式 taskId、不依赖回复）；目标缺失也显式回话并 return，绝不建孤儿任务。指令词后面必须是本仓真实 id 形状（`om_…` / `rec…`（≥6 位）/ `daily-…` / `sf-…`，`isTaskIdShape`），否则整句按普通消息走分类（11-03 R5：「@bot 关闭 Google 登录入口」原来把 Google 当 taskId、回「没找到任务」，需求丢了；「继续 debug 一下」同理）。② **回复锚定**（`resolveControlTarget`）：直接回复**已登记的 Bot 回执卡**时无需再次 @bot；普通用户消息的回复仍要求 @bot。回执反查忽略代次，任务续跑过 epoch++ 后回复旧卡也能命中；direct 精确锚定失败再回落同话题唯一活动任务，话题内 ≥2 条活动任务则列候选让人指定，绝不猜测或新建。
- **结单语义（`classifyClosureIntent`）**：先按语族正则给出结构化判定 `{ intent, closureReason, scope, confidence }`。三种 `closureReason`：`completed_elsewhere`（已解决 / 已由其他人·AI 完成 / 已上线 / 重复工单）、`cancelled`（取消 / 终止 / 撤销 / 停止处理 / 结束）、`no_longer_needed`（不用做了 / 不需要处理 / 需求变了 / 算了）。**一票否决**（降级为 unclear 去确认，绝不自动结单）：疑问句（修复了吗 / 解决了没 / 是不是已上线）、否定关闭、条件未来时、未完成、只完成部分、还需继续、转述他人。独立暂停表达走 `pause`，保持状态且不续跑、不新建。若明确结单后仍有缺陷/修改请求（如“上个已解决，现在下拉框还是空的”），先结原任务，再把残余正文显式展示并询问是否另发新任务，绝不静默吞请求或自动扩张执行范围。
- **弱信号轻量仲裁（不引 AI）**：高置信语族没命中、但形状**疑似结单**（收工 / 到此为止 / 先放着 / 就这样吧 / 这事到这了 / 不弄这个了…`SUSPECTED_CLOSURE_RE`）的锚定消息，不再默认当补料续跑或忽略，而是升级为 `unclear`（`scope=suspected` + 猜测 `closureReason=cancelled`）去 `confirm`——零 AI、零新异步流程，只是把「疑似」交人一键裁决。仍受弱信号专用否决门 `SUSPECTED_VETO_RE` 约束（否定 / 继续 / 未完成词出现即退回，「先别收工，继续做」= 继续，不问「要结单吗」）。confirm 文案据 `scope` 分流：`partial` 问「整单关还是只取消一部分」，`suspected` 直接摆出猜测方向 + **带真实 taskId 的一键指令**（回复 `取消任务 <id>` / `结单 <id>` 结束，或补充说明继续）。
- **重开语义（`classifyReopenIntent`）**：误结单可逆。窄语族——只认明确的重开 / 恢复 / 纠错措辞（重开 / 重新做 / 恢复执行 / 其实还要做 / 关错了 / 误关 / 不该取消），避免把「继续下一步」这类正常补料误判成重开。仅当回复的目标是一条**人工结单**任务（`superseded` 且带 `externalResolution`）时才生效。
- **路由决策（`decideControlAction`）硬不变量**：锚定到的任务为**活动态**（`received/queued/running/verifying/waiting_confirmation/blocked/failed`）时，任何意图都不返回 `passthrough` —— 即**回复活动任务卡的消息永远不会新建任务**。纯确认 / 寒暄（如 `OK`、`收到`、`👌`）和仅要求他人稍后补充的协调话术属于 `ignore`：无论原任务处于活动态还是终态，都在控制通道内静默消费，不续跑、不发提示卡、不创建 `[OK]` 一类任务；带附件或方案、字段、样例等实质内容不忽略。仅「终态任务 + 有实质内容的非结单/非重开表达」放行老路径，允许在已了结话题里发起真正的新请求；11-02 起排队 / 在跑 / 没做成 + 有实质内容、11-04 起挂起任务 + 不像对机器人说的（见下 `resume` 的隐式续跑门槛）也放行，都带锚点 `anchorTaskId` 交分类器判并入，不会变孤儿任务。
  - `close`：`closeAsExternallyResolved` 落终态 `superseded` + `epoch++`（拦截已领取 worker 的迟到回写）+ 清排队/催办/待发回执与挂着的「收到」；`closureReason` 写入落态存档——**取消类绝不记成「已完成」**。**running 中取消**除 AI 前和提交前检查外，还在 AI 执行期间轮询 Gateway；检出 `superseded`/换代立即用独立 `AbortController` 终止 AI 子进程。所有 prompt 都禁止 AI 自行 commit，提交只由 Worker 在最终状态与 epoch 闸通过后执行，因此已取消任务零 commit；半成品由既有收尾策略保留并写入审计供人工检查。
  - `reopen`：`reopenClosed` 把人工结单的任务复活回 `queued` + `epoch++`，把本次结单存档进 `closureHistory` 留痕后清 `closureReason`/`externalResolution`；显式指令保存去掉指令前缀后的补充正文，回复式重开保存真实正文、附件与操作消息 ID 到任务历史。复用原 `task.id` → 复用原分支/worktree。兄弟归并 `supersede`（有 `supersededBy` 无 `externalResolution`）与 `done` 一律不可重开。
  - `pause`：仅确认暂停表达，不改变任务状态、不触发 parked 任务续跑、不新建任务，并明确回执当前状态。
  - `confirm`：意图不明，回一句让用户澄清「结束整个任务 or 只取消一部分」，原任务不变、不新建。
  - `resume`：活动态(parked) + 无结单信号 → 复用原任务补料续跑（见 5.1）。**隐式续跑门槛**（`implicitResumeVerdict`，11-04 falive 回放 P4a）：没写「继续任务 <id>」的续跑（回复挂起卡 / 原消息、话题根命中、同话题唯一挂起归并；控制通道和 `lark-ingest` 两处同一道门槛）只在本条像是对机器人说的时候才续——私信、@ 了机器人（`botOpenId` / `botAppId`）、带附件或链接（材料）、或没 @ 任何人且发送人是提单人 / 负责人 / bot 为这条任务在群里 @ 过的人（发件簿里这条任务没被拦下的 `mentions`，如 blocked_ask「需要你们帮忙」）。在问问题（`asksQuestion`）或是逐项清单（`isItemList`，≥ 3 行条目，11-05：被等的人逐项答复的是另一份待办）的，@ 了机器人也先过分类（带锚点，是补料的照样并进去）。否则不续跑：抄送 / 寒暄 / 表情（`cc`、`收到`、`好的`、`谢谢`、`[赞]`、`👍`，`isSocialChatter`）静默丢，不回话、不建任务；@ 了别人没 @ 机器人（「@Arthur 麻烦在这里补信息吧」）或旁人没 @ 谁的搭话放行到分类（建 `received` 带锚点，真是补料的由分类器判 `continues` 照样并进挂起任务，§7）。原先这些话当场被当补料续跑、连分类器都不过。显式「继续任务 <id>」不受影响。
  - `supplement`：目标还没分类（`received`，或正在分类）→ 并进原任务一起分类，不回第二句。正在分类的（worker 拿的是旧正文）标 `intake.reclassify`，这轮分类结果作废、放回 `received` 带补充重分类一次，不换代、不计瞬时重试（11-03 R7：原来判 ignore / 疑似时补的内容无声丢失）。
  - `notice`：其它活动态 + 无结单信号 → 记录并引导，不新建。`failed` 也在活动态，但回的是「上次没做成，已经告诉 aven 了，不是还在处理；要关掉回「取消任务 id」，要重做直接 @我 再发一条」（11-03 R13），不说「还在处理中」。
  - `ignore`：锚定回复只有确认、寒暄或协调话术且没有附件 → 仅写本地日志，任务状态保持不变，不发群消息、不续跑、不新建。

> 沿革：早期只识别「已解决 / 已完成」窄语族且判定散在 ingest 线性 if 链里，取消 / 不用做了 / 已结束等表达全部漏判、fall through 建新任务；且回复旧代次卡因 epoch 不匹配锚定失败；误结单只能人工改文件。现收敛为统一控制通道 + 忽略代次锚定 + closureReason 分流 + 显式指令 + 误结单可逆。

### 5.1 续任务与结单的关联锚定

用户回复原任务消息或机器人回执卡，并明确表示“已由其他人 / AI 完成”、“该问题已解决”时，必须将关联原任务直接结单，停止排队、执行和催办；该回复本身绝不得生成新 task。未找到关联任务时按新请求处理（终态）或引导（活动态），不得静默丢。“未解决”、“只完成部分”、“还需继续处理”不属于结单信号。排队卡、续跑卡和待确认卡均必须保存 Lark `message_id → task.id` 关联，确保回复任一卡片都能精确锚定。

收到任务后先回群确认已接收：

```text
标题：[项目名] 已收到 Lark 任务
内容：@应用消息摘要
状态：已收到，正在排队处理
```

硬规则：入队回执和完成 / 失败回执必须是两条独立群消息。Gateway 入队成功后立即发送「已收到 Lark 任务」；Worker 回写 `done` / `failed` 后再发送「Lark 任务完成 / 失败」。不得只在任务完成后发一条消息，也不得用完成消息替代收到回执。

防复发要求：

- Gateway 运行环境必须带有可发送群消息的 webhook 配置，或能读取项目级 Lark 配置文件；否则不能标记为真实群接入完成。
- 入队回执、完成回执的 webhook 发送结果必须写日志；`skipped`、非 0 code、网络失败都要记录原因。
- 验收群内 @ 自动任务时，必须检查日志里同时出现 queued sent 和 result sent，或在群里确认收到两条消息。
- 两条回群卡片底部都必须带时间 note(时间行格式见 [../../rules/lark-active-notification.md](../../rules/lark-active-notification.md) §5)。
- 回群文案必须说人话：收到任务时把原始 @ 消息归纳成项目成员能理解的任务摘要；完成任务时写实际结果，不把原始命令、技术 fallback 或内部状态直接丢给群成员。
- 内容简单时一句话即可；有多项说明时在同一字段内拆成 `1.`、`2.` 编号。

完成后回群：

```text
标题：[项目名] Lark 任务完成
任务：<原始任务摘要>
结果：已完成。
1. <完成项>；
2. <当前效果>
```

## 6. 阻塞超时处理

门禁等待确认期间，Worker 应做到：

- G2 等待产品确认超过 1 个工作日：回群标记"仍在等待 G2 确认，阻塞编码"，不自动推进。
- G5 API 联调阻塞：挂起当前任务，输出阻塞原因，等待负责人重新触发。
- 任何需要等待确认的事项：保留当前文档状态，不猜测继续写代码。

催办（`lib/lark-parked-reminder.mjs`，11-01 起）只对**群里发起的改码类**挂起任务：4h 在群里对提单人说一句，8h 私信负责人一次，之后不催。代答 / 实测 / 运维 / 只记一笔、负责人私信发起的、负责人私聊指示、疑似 / 追问中的任务永不催；疑似 48h 没人认领自动关并合并私信一条。

## 7. 收信与分类（11-01 对话层）

每条 **@bot / 负责人私信 / 回复 bot 消息** 都先建 `received` 任务（只 @ 负责人本人或 @所有人、没叫 bot 的消息 11-02 起不处理：判「是不是负责人的活」太复杂、准确性低，aven 决定先关掉，这些消息只作为后续 @bot 时的上下文），由 worker 的只读分类器（`lib/lark-classify-prompt.mjs`，五类 `bug / requirement / api_reply / question / ignore` + `deliverable` + `reply` + `forMe` + `continues` + `selfAnswer`）决定怎么落（`lib/lark-intake-resolve.mjs`）：开跑 / 自答（问 bot 自己的问题，分类器一句答完，不建执行）/ 追问（负责人的话拿不准）/ 疑似（私信负责人放行）/ 只记一笔 / 忽略。只有显式控制指令（取消 / 结单 / 重开 / 继续任务 `<id>`、绑定 PR-x）和负责人的运维指令（「运维：」或原话里的部署 / 发推）不过模型。

群里光一条「@bot」（没正文、没附件、没引用）也进分类（11-03 falive 回放 10-26：两条这样的催 / 接话被摄入层直接丢了）：上下文包标「【本条 @】（无附言，只 @ 了机器人）」，分类提示按本人上一条在说的事判；私信里的空消息照旧丢。别人问 bot 自己的问题也能自答（R9，原来只对负责人生效，别人问「bot 能做什么」照样开跑、答两遍），要 high / medium。分类非瞬时失败（`intake_failed`）不发「收到」、私信负责人一句（R6，见 §4 出口表）。

分类器看得到的上下文（`lib/lark-conversation-bundle.mjs`）：被引用消息、话题其它回复、本群紧挨着的最近 20 条（含 bot 自己说的）、这个人 2h 内的任务与 bot 对他说过的话、本群 7 天候选任务、别人贴 bot 以前说过的话；15 分钟内的短指代句默认接 bot 上一句。分类出的 `continues` 命中已有任务 → 并入原任务（`lib/lark-task-merge.mjs`：未开跑追加、在跑完成后再跑一轮、挂起的当补料续跑、已了结重开续答），本条落 superseded。

并入要交付物兼容（`compatibleContinuation`，`lib/lark-routes-intake.mjs`）：

- 目标在等补料（`waiting_confirmation` / `blocked`）的，什么都能并。
- 其它状态（排队 / 在跑 / 已了结）只有同一种交付物才算延续（追问 → 原答疑，补料 → 改码单），不同就另起任务（11-03 falive 回放 smoke：「portal 不用带头，更新清单」「你写脚本造测试帖」都并进答完的清单答疑重跑，整份清单连发三遍）。排队中也不例外（fix-a 回放：「检查下 preload」实测并进排队中的「写脚本造帖」改码单，一个任务干两件事、结论混发）。
- 实测 / 答疑点名的环境与目标不相交（uat 那条答完，又要「复测 OL」）不算延续，另起；改码不看环境——「pre 也有这个问题」改的是同一处代码，照交付物规则并入（11-03 合入前 review）。
- 没有契约的老任务照旧并。

并入后谁说了算：

- 契约、对话包跟新消息走；点名环境也跟新消息走——重开 / 续跑取新消息的，在跑 / 没开跑取并集（11-03 falive 回放 r3-c：「复测 OL」并进 uat 那条，结论开头警告「测的不是你说的 uat」）。
- 终态重开（reopened）把回复目标、提单人、话题根（`replyTarget` / `operator` / `threadRootId`）换成新消息的，结论回到后来问的人（R8：A 问「test / pre 是否一样」答完，B「有哪些差别」并入重开，结论原来回到 A、B 的义务停在 acked）；`messageId` 不换（是任务自己那条消息，重试按它重下原附件）。来源记进 `task.answerFor`，结论发出时它的回复义务一并记 answered。
- 挂起续跑（resumed）是补料，不换回复目标（A 报 bug 挂着等文档，William「@bot 文档在这」并入，换了 A 就收不到结论）；在跑 / 没开跑的并入同样只记 `mergedFrom`、结论仍回原消息。
- 这些结论仍回原消息的，并入人靠结论末行 `@并入人 你（们）的补充也一起处理了`：只在 done / no_change_needed 加（代答类 blocked / failed 也发群，但不是结论；改码没做成扣下的草稿也不带）；还欠一轮重跑时留给重跑那轮；发出后整份 `mergedFrom` 记进 `mergedNotified`，下一轮（换了提单人的重开）不再 @。

开跑的任务分类时 `continues` / `relatedTaskId` 指着别的任务、又没并进去的（交付物不同另起，或只是相关），带上那条的结论 `task.priorConclusion`（答案 + 条目 + 细节文档，截到 2000 字，`lib/lark-intake-resolve.mjs`）；代答 / 实测提示里连同「收到」那句一起给 worker，并要求要什么本轮给什么：要事实（tid / 账号 / 地址）就查出来直接列，要写操作（发帖 / 注册 / 下单）本模式做不了就直说找谁，不写「回头再发你」，「收到」里答应过的要兑现（11-03 falive 回放：William「测试的tid 发出来」，tid 就在上一单结论里，却回「去翻文档」；「创建最新的帖子 进行测试」先回了「我在 pre 发几条新帖」，实测只读发不了）。

任务契约 `task.contract.deliverable ∈ change / verification / answer / record / ops` 只在分类回写时算一次（`lib/lark-task-contract.mjs`），任务性质、是否建 worktree、提示模式、出口都只读它。

负责人私信 = 控制通道（`lib/lark-principal-channel.mjs`）：显式「继续任务 id」> 回复了某条私信 > 12h 内最近一条「在问他」的通知（或本条是短指代句）→ 挂着的续跑、「就这样回」放行草稿、其它建「私聊指示」任务（群 / 发送人沿用被指示的群消息，私信原话不进群）；锚错了回「取消任务 id」。没锚到的私信是独立任务。

- 对挂起任务（疑似 / 追问 / blocked / waiting）的回复先判是不是否定（`classifyPrincipalReply`，11-03 R1：bot 私信「是 → 继续；不是 → 取消」，aven 回「不是」原来被当补料开跑）：整句就是否定（不是 / 不对 / 不用 / 算了 / 不做了 / 取消…）或否定 + 归属方（「不对，这是后端的」「不归我们」，归属方只认后端 / 服务端 / App / 客户端 / 原生 / 运维）→ 关掉，回结单那句；结单语族拿不准（「别做了？」「不用改了，复测一下」）→ 问一句、不动；其余是补料照旧续跑（「不对，应该是 508 账号」「不是，这个是 B 页面」「不，找 William 要账号」都是补料）。显式「继续任务 id」看后面的补充，单发是放行。
- 「就这样回」只在锚点是「最近一条」通知、且锚点从没扣过草稿（义务没到过 held / answered）时，改找窗口内最近有草稿的任务（11-03 falive 回放 10-20：放行 lives 卡的草稿，锚到了刚私信过的 preload 任务，回「没有草稿」）。引用回复 / 显式点名的就是说那条；锚点扣过草稿已放行 / 已发过更新结论的，「没草稿」是对的——改找会把别的任务的草稿发进别的群，撤不回。
- 纠错（11-05 批 1.2）：「纠错 …」开头，或「这条 / 那条不对 …」带了消息链接 / om_ 消息 id 的，先于一切锚定处理——按点名的消息 id（任务 / 回执 / 对它说过的话，跟并入）> 引用的私信对单，对不上也照记（不猜「最近一条」），追加进 `runtime/lark-corrections.jsonl`；对上的群任务当场按纠正重答（aven 11-05：群里的人还在等正确回答）——答过 / 没做成的建私聊指示任务（原话前加「【纠错·要更正】…回群开头说明是更正」，回原消息、对原提问人），挂起的带着纠正显式续跑；他自己私信发起的单、没对上的只记（没对上列最近私信过他的群任务让他点名）。主通道里的每次拍板（放行 / 草稿扣着时下指示 = 改了再发 / 否定结单 / 续跑 / 指示）同时追加进决策日志 `runtime/lark-decisions.jsonl`（`lib/lark-feedback-log.mjs`）。
- 私聊指示判 ignore 时，锚点还在活动态（在跑 / 排队 / 挂起 / 没做成）且是**明确拒绝**才一并结掉（no_longer_needed，换代挡掉迟到回写，私信加「原来在跑的那条也关掉了，不再回群结论」；11-03 R3：对在跑的锚点说「不做，这是后端的」，原来锚点照跑到 done，群里先「不归我们」后「改好了」）。明确拒绝 = 分类器 `forMe === false`，或写了 reply 且 `forMe !== true`；reason 说是寒暄 / 知会、或负责人原话整句就是「收到 / 知道了 / 好的」的不算——在跑的锚点不动、私信回「那条照常在做，没动它」；原话整句是寒暄的，分类器写的 reply 也不回群。

回放：`node scripts/lark-replay-intake.mjs --fixture __tests__/fixtures/intake-replay-1101.json [--live]` 用 11-01 的 6 条真实消息核分类 → 契约 → 可执行性。
「群里这条之前的消息」时间窗（11-02，`lib/lark-chat-context.mjs` `applyRecentWindow`）：近 `recentContextHours`（默认 4）小时全留，更早的只留本 bot 最近 3 条（对方隔夜接 bot 的话，falive 10-23 #74 的教训）和本条发送人最近 2 条，别人的旧闲聊、别家机器人的旧通知、隔天的长卡片不再进上下文，也不再下它们的图。回归集按 4 小时截后 22 条受影响、全部通过（另 3 条波动与截断无关）。
分类回归集（11-02）：`node scripts/lark-replay-intake.mjs --fixture __tests__/fixtures/intake-regression-1102.json --live [--model m] [--effort e] [--conc 8]`，56 条（fameex 真实消息 23 条 + falive 存档按类别 / 交付分层 33 条，11-03 falive 回放补了 3 条「对方说已办好我们在等的事 → 复测」），按运行配置的分类模型（`claudeIntentModel` / `claudeIntentEffort`）真跑、带 persona，逐条比 decision / deliverable / selfAnswer / continues（expected 是可接受值集合），并报耗时中位 / P90。换分类模型 / 强度、改分类提示前先跑；11-02 的对比：Opus high 中位 8.6s、Opus low 5.2s（都 0 处明确误判），Sonnet high 8.2s（漏 2 条负责人私聊指示），Haiku high 11.4s（漏 8 条，含「online 异常，修掉」判 ignore）。
