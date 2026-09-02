# Task 边界与回复策略

> Lark Bot 子系统文档之一，索引见 [README.md](./README.md)。
> 本文是 Worker 执行任务时**必须遵守的策略层**：生命周期、解析、自动执行 / 必须确认边界、完成汇报与回复格式、阻塞超时。

群里有人 @ 应用后，系统必须先生成 task，再由 Worker 执行；不得让群消息直接驱动无记录的代码修改。

## 1. Task 生命周期

| 状态 | 含义 | 下一步 |
|------|------|--------|
| `received` | Gateway 收到 Lark 事件并通过签名、白名单、幂等校验 | 解析命令 |
| `ignored` | @负责人消息已判定不是 bug / 明确需求 | 静默终止，定期清理 |
| `intake_failed` | @负责人消息的只读分类器异常 | 不执行代码；health 告警、保留审计 |
| `queued` | 已生成 Job 并入队 | Worker 领取 |
| `waiting_confirmation` | 范围、PRD、API、QA、登录账号、权限、环境或其他材料存在需人工确认 / 补充项 | 自动发送待确认 / 补信息通知，尽量 @ 具体责任人，回群等确认 |
| `running` | 已开始改文档 / 代码 / 自测 | 持续记录进展 |
| `verifying` | 已完成修改，正在跑 Biome、测试、type-check | 生成验证摘要 |
| `done` | 完成并回群汇报 | 写通知记录 |
| `done_pending_writeback` | 仅 bug 表来源：改动已提交、群里已发完成卡，但记录状态回写失败 | Gateway 每 5min 重试；到上限（默认 12 次 ≈1h）**停止重试并保持本状态**，发告警请人手动改表格。**不落 `done`**——群里说完成而表格还挂着待处理，这个不一致必须一直可见（`done` 会被每小时的终态清理抹掉、health 计数里也不再点名） |
| `no_change_needed` | **非完成态终局**：经核对确认改动属**后台 API 服务 / 另一个 git 仓库 / 非代码职责**（判据是「不属本 git 仓库」，**不是**「不属本前端 app」——同 monorepo 内另一个 app/package 如 admin/futures-admin 仍是本仓可改，不走此态） | 发独立回执卡（既非绿完成卡也非红失败卡）说明为何本仓无需改动 + 建议的接手方；无 diff、无提交，不进规范闸与「done+空 diff 不可信」评估；bug 表记录不写完成值，留待人工重派 |
| `blocked` | 无法继续，需要外部资料或权限 | 回群说明阻塞 |
| `failed` | 执行异常或命令失败 | 回群说明失败和下一步 |

`done_with_warnings` 是 AI 侧状态而非独立生命周期态：它带着告警清单收敛到 `done`（见 [lark-status-meta.mjs](../lib/lark-status-meta.mjs)）。

**回执卡二选一**：任何一次任务执行最终只发一张结果卡——绿色完成卡（`done`）／红色失败卡（`failed`）／橙色待确认·阻塞卡（`waiting_confirmation`、`blocked`）／灰色无需改动卡（`no_change_needed`）互斥。`no_change_needed` 绝不复用完成卡：那会让群里读到「已修好」，而实际一行代码都没动。

**「显示值/字段名错误」类 bug 的排查铁律**：先定位到出错的**那一列**、它的 `dataIndex` 与渲染器。若前端只是原样透出后端数据（`v || emptyText`、无映射 / 无格式化），显示不对属**后端数据 / 配置问题** → 判 `no_change_needed`，summary 引用 API 响应证据（哪个字段返回了什么）、指向后台。**绝不**因关键词相近就去改「长得像」的邻列常量 / 映射伪造修复，也不改一个没被点名、原本正确的列。反例见 PR-01930：bug 指「体验金名称」列（`trialFeeName`，API 直出且值内含金额 10/20/30USDT），却误改了旁边「类型」列（`trialMode` 映射）——真 bug 没修、还擅改了 PRD-aligned 的列，三重错。「done + 非空 diff」可信度评估只看有没有 diff、看不出 diff 打在无关字段上，故此类误判需靠本铁律在下刀前拦住。

## 2. 解析规则

Gateway / Worker 至少提取：

- 任务类型：`docs / fix / test / api / qa / status`。
- 项目范围：优先从消息中的项目名、PR 号、路由、文档路径推断；推断不到则回群询问。
- 目标文件或页面：如 `/tradfi`、`apps/web/src/apps/TradFi`、`docs_tdd/common`。
- 上下文与附件：合并被引用父消息及同话题其他真人回复的文字；父消息、当前消息和兄弟回复中的图片都必须进入 task，并通过 lark-cli bot 身份下载成 `localPath`，让 AI 可以直接看图。下载失败须保留 `imageKey/width/height/downloadError`。
- 是否需要确认：群任务和 Bug 表反馈只确认修改范围；安全动作仍按原边界处理，不混成 G2。
- 责任人：优先从 @ 对象、消息上下文、项目文档负责人字段、QA / API / 设计归属推断；无法推断时标记为项目负责人 / 群内负责人。
- 回群线程：使用原消息 thread / message id 作为汇报目标，避免刷屏。

## 3. 自动执行 / 必须确认边界

白名单群 + 白名单用户 + 当前项目范围内，以下可自动执行：

- 文档补充、格式修正、状态同步。
- 小范围 bug 修复、UI 偏差修复、测试补充。
- 运行风险分级要求的静态检查和最小测试。
- 输出 QA / PRD / Figma 差异清单。
- 读取 Lark PRD、Wiki、Swagger、QA 用例，读取 `apps/web/docs_tdd/**`、Figma 记录和当前项目代码。
- 当前项目已有文档时，把 `product/00-feature-inventory.md` 和 `product/04-frontend-tasks.md` 注入 Worker；以 `00` 的责任模块与「做 / 不做 / 延期」裁决判断任务是否属于本仓，不凭项目名称臆断。
- 修改 `apps/web/docs_tdd/**` 文档、当前项目相关前端代码；对触达 JS / TS / JSON 文件运行 Biome。
- 任务明确要求视觉验收时仅复用已运行页面；沙箱内不启动 dev server。
- 回群回复阶段结果、缺信息项和验证摘要。

**测试反馈**：白名单群任务和 Bug 表任务即依据。只确认范围；能由任务、附件和代码定位便实施。G2、历史 gate 不阻断，风险级只决定验证；仅范围不清、越界或扩大公共能力时询问。

以下只生成 task，不自动执行，必须先回群确认：

- 常规任务 scope 不清；群任务 / Bug 表反馈仅在范围不唯一或越界时确认，不受历史清单状态阻断。
- 缺 PRD、Figma、API 样例、QA 用例、登录账号、账号权限、测试环境、后台配置或验收数据。
- 无新指令时 QA / PRD 冲突；API 文档与当前 Mock / PRD 冲突（已有明确修改指令时以最新群反馈为准）。
- 需要新增全局设计 token / Tailwind preset、公共架构调整或跨项目重构。
- 需要读取生产数据、密钥、账号、Cookie 或内网敏感地址。
- 需要安装依赖、push、开 PR、部署、改 CI/CD。（**本地 commit 例外**：bot 提交自己产生的改动是既定行为，口径见 §3.2 与 [lark-commit-policy.mjs](../lib/lark-commit-policy.mjs)；push / PR 一律不做。）
- 任务影响范围超出当前 `apps/web` 或当前 feature。

进入上述任一场景时，Worker 必须把 task 状态置为 `waiting_confirmation`，并自动发送待确认 / 补信息通知。通知里要写清缺什么、影响哪个阶段、需要谁处理；能识别责任人时必须 @ 具体人，不能识别时 @ 项目负责人 / 群内负责人。**已落地实现**：AI 结构化结果（`lark-ai-result.schema.json`）status 支持 `waiting_confirmation`，并可带 `blockers`（逐条列缺什么）、`owner`（推断责任人 / 角色）；Worker 原样回写该状态（不跑规范闸、不提交改动）并把 `owner` 随状态回写带给 Gateway；Gateway `handleStatusUpdate` 对 `waiting_confirmation` / `blocked` 发**橙色独立回执卡**（区别于绿/红的完成/失败卡）。**责任人 @ 落地**（`resolveOwnerMention`）：AI 自报 `owner`（角色 / 关键词）命中项目配置 `config.ownerMap`（`角色/关键词 → open_id`，可选表）则 `<at>` 对应责任人；未命中则回落 `<at>` 触发人（`task.operator`）并注明「未在责任人表识别，暂 @ 提单人」；bug 表任务由 poller 把负责 RD 写入 `operator`，保证无法识别业务 owner 时仍有人接收。**续任务闭环**（`store.resumeWithSupplement` + `resolveResumeTarget` / `handleResume`）：Gateway 保存待确认卡和催办卡的真实 Lark `message_id → task.id` 关联；只有以下情形算**续跑意图**：① 发送 `继续任务 <taskId> <补充内容>` 显式指令；② 明确回复（`reply_to`）机器人回执卡；③ 明确回复仍处 `waiting_confirmation`/`blocked` 的原任务消息；④ 无 `reply_to`、仅会话线程根 `root_id`，且它命中机器人回执卡**或原任务消息本身**、对应任务仍处 `waiting_confirmation`/`blocked`（话题内直接发补料时 Lark 不带 `reply_to`；收窄点在「仍卡着」，已完成的话题根一律按新任务处理）。命中续跑意图即复用**原任务**（append 补料 + 合并附件 + 保存本轮结论到 `waitingHistory` + 复用同一分支/worktree），置回 `queued` 并 bump `epoch`；回执关联持久化且只接受当前 epoch，重启不丢、旧轮次卡片也不能误续跑新一轮。**边界硬规则**：一旦识别出续跑意图，本条消息只走续跑分支——目标不存在 / 不在待确认·阻塞态 / 无补充内容时**显式回执说明并 return，绝不 fall through 新建孤儿任务**（否则补料落空、原任务继续卡着而群里无感知）。**关键约束**：AI 遇缺材料严禁猜测生成文案 / 默认值硬做，也严禁误判成 `failed`；`failed` 只留给工具 / 环境 / 权限等技术性失败。

任务正文引用 Figma 设计稿时还有一层实施前硬边界：Worker 必须先用 `figma-spec.mjs` 预取并落盘设计规格，再把路径交给 AI。若链接不可访问、node-id 无效或缺少 `FIGMA_TOKEN` / `FIGMA_API_KEY`，任务转 `waiting_confirmation`，不得降级为“只看截图继续实现”。

## 3.1 任务性质（workKind）与阻塞四分类

§3 的「自动执行 / 必须确认」不再靠一条正则白名单硬压，而是先判**任务性质**、再对 AI 给出的每条 blocker 做**四分类**。实装在 [lark-work-policy.mjs](../lib/lark-work-policy.mjs)（纯函数，`node --test __tests__/lark-work-policy.test.mjs` 直测），语义为单一事实源。

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

**新需求放行闸（混合兜底）**（`requirementGate`，在 [lark-task-runner.mjs](../lib/lark-task-runner.mjs) 里于**跑 AI、动 worktree 之前**执行）：判为 `requirement` 且人尚未放行过（无 `resumeCount`/`waitingHistory`/`qaReturnCount`）时——**仅当连自评材料都没有（`requirementHasSpecContext` 为 false：无附件，且正文短于 `REQUIREMENT_SELF_ASSESS_MIN_CHARS`=24 的裸一句话）**——才直接回一张 `waiting_confirmation` 卡、一次 AI 都不跑（这种消息 AI 也只能空手，先问一句比烧一次 AI 省）。**其余新需求（有附件 / 正文有细节）不再盲拦**，一律放行到 AI 由能读上下文的它自评。历史上这里对**每条**新需求盲拦，靠纯正则读不到话题讨论 / 设计稿，把已说清的新需求也退回补料——正是「太烦人」的根因。自评落地在两处执行器：`claude` 单趟无独立只读分析阶段，故 `buildTaskPrompt` 给未放行新需求内置「开工前只读自评」段（能从上下文唯一推导规格就直接做，不够再 `waiting_confirmation` 并**具体**列出缺口）；`codex` 沿用其只读分析阶段 + `resolveAnalysisGate` 自评。人回复卡片补一句预期行为即视为放行、续跑。

## 3.2 人类 WIP 隔离与 L2 契约改动的 type-check 闸

- **绝不自动提交人类 WIP**：命中的已有 worktree 在任务开始前若已有未提交改动，任务会**改路由到隔离的临时 worktree**（`tempWorktreeContextFor`），bot 的改动落 `origin/online` 上的 hotfix 分支、完全不碰人类工作区。
- **自动提交口径的唯一事实源**是 [lark-commit-policy.mjs](../lib/lark-commit-policy.mjs)（`resolveCommitMode`，纯函数直测）：

  | 场景 | 模式 | 行为 |
  |---|---|---|
  | 只读任务 | `none` | 不产生改动，任何写都是越界 |
  | 任务未完成（failed / blocked / 异常） | `none` | 半成品不入库，保留现场待人工 |
  | 隔离临时 worktree（`origin/online` 上的 hotfix 分支） | `auto` | 分支是 bot 自己开的，全量 `git add -A` 提交 |
  | 命中人类已有 worktree 的当前分支 | `scoped` | **只**提交本任务实测改动清单里的路径 |

  `scoped` 存在的理由：上面那条路由检查只发生在**任务开始前**，而 AI 可以跑 30 分钟——这期间人在同一 worktree 新写的 WIP 会被 `git add -A` 一并扫走。改成按实测清单定向 `git commit -- <pathspec>` 后，收尾时才出现的路径既不入库也不被静默忽略：它们进 `unexpected`，写进完成卡请人确认。三种模式**都不 push、不开 PR**。
- **L2 契约/共享改动缺 type-check 证据 → 降级人工复核**（`assessDoneResult`）：改动触达 schema / mapper / api / `.d.ts` / `packages/` 时，若 AI 自报的 `checks` 里没有 type-check 证据，则**不按 done 处理**（这类改动最易静默改坏调用方；实施 prompt 已明确要求 L2/L3 在触达包跑一次 `tsc`）。注意这与「我们自己按整包 `tsc` exit code 硬判」不同——那会被历史基线红误伤，我们从不那么做；这里只校验 AI 是否给出了它本应产出的 type-check 证据。

## 4. 完成后汇报策略

Worker 完成后必须回群，并写入项目通知记录。回群内容固定为：

```text
标题：[<项目>] Lark 任务完成 / 阻塞 / 失败
任务：@应用消息摘要
结果：已完成。
1. 大众能直接理解的完成项；
2. 现在产生的效果。
```

规则：

- 群消息字段不要编号，例如不要写 `1. 任务`、`2. 结果`。
- `结果` 字段内先写完成状态，再用数字小结列出“做了什么、现在是什么效果”。
- 不贴 diff 全文和长日志。
- 任务 ID、触达文件、验证命令、失败命令输出写入项目文档或任务记录，不放进普通完成消息。
- 如果失败，群消息只说明失败类型和下一步；详细错误写入任务记录。
- 如果失败，必须说明是工具失败、环境失败、权限失败还是需求不清。
- 未明确要求时跳过 Browser / Playwright，不启动 dev server，也不把缺少视觉验收列为 warning；必需检查通过即完成回群。
- **AI 退出但未显式回写 done/failed 时，一律判 `failed`（待人工复核），不分任务类型都不得兜底谎报「已完成」**——无回写 = 无验证 = 不可信（AI 可能中途放弃/崩溃/未按要求回调 Gateway）。
- 图片 / 视觉任务不能因为文字简短就快速失败；项目配置已经提供项目编号和标题，Worker 必须结合当前项目文档、代码、PRD / Figma 资料和图片附件自动定位。只有 Lark 图片下载凭证缺失、图片下载失败、代码不可访问等技术原因，才能回写 failed，并明确说明具体技术卡点。

## 5. 回复策略

### 5.0 任务控制通道（回复 Bot 卡片 ≠ 新任务入口）

一条消息只要**能锚定到一条 Bot 卡片 / 原任务消息**，它就进入**任务控制通道**，出口被约束为五类，**绝不 fall through 新建 task**：结单 / 重开 / 续跑补料 / 查状态 / 意图不明去确认。实装在 [lark-ingest.mjs](../lib/lark-ingest.mjs)（`resolveControlTarget` + `decideControlAction` + `maybeHandleControlChannel` + `maybeHandleControlDirective`）与 [lark-message.mjs](../lib/lark-message.mjs)（`classifyClosureIntent` / `classifyReopenIntent` / `parseControlDirective`），路由决策为纯函数、可直测。

- **两条入口**：① **L3 显式指令**（`maybeHandleControlDirective`，最强意图，先于回复锚定）——`结单 <id>` / `取消任务 <id>` / `重开任务 <id>`（`parseControlDirective`，与 `parseResumeDirective` 对称，带显式 taskId、不依赖回复）；目标缺失也显式回话并 return，绝不建孤儿任务。② **回复锚定**（`resolveControlTarget`）：明确回复回执卡 / 原任务消息（用**忽略代次**的 `findTaskByAnyReceipt` 反查——任务续跑过 epoch++ 后回复旧卡也要能命中），或无直接锚点时同话题**恰好一条活动任务**才归并（0 或 ≥2 条归属不明，退回新任务，绝不误关）。
- **结单语义（`classifyClosureIntent`）**：先按语族正则给出结构化判定 `{ intent, closureReason, scope, confidence }`。三种 `closureReason`：`completed_elsewhere`（已解决 / 已由其他人·AI 完成 / 已上线 / 重复工单）、`cancelled`（取消 / 终止 / 撤销 / 停止处理 / 结束）、`no_longer_needed`（不用做了 / 不需要处理 / 需求变了 / 算了）。**一票否决**（降级为 unclear 去确认，绝不自动结单）：否定关闭（别结束）、暂停（先暂停一下）、条件未来时（结束后再通知）、未完成（还没解决）、只完成部分、还需继续、转述他人（他说…）。夹带「另一部分要继续」判 `scope=partial` → 同样去确认（混合意图不自动整单关，交人裁决残余段）。
- **重开语义（`classifyReopenIntent`）**：误结单可逆。窄语族——只认明确的重开 / 恢复 / 纠错措辞（重开 / 重新做 / 恢复执行 / 其实还要做 / 关错了 / 误关 / 不该取消），避免把「继续下一步」这类正常补料误判成重开。仅当回复的目标是一条**人工结单**任务（`superseded` 且带 `externalResolution`）时才生效。
- **路由决策（`decideControlAction`）硬不变量**：锚定到的任务为**活动态**（`received/queued/running/verifying/waiting_confirmation/blocked/failed`）时，任何意图都不返回 `passthrough` —— 即**回复活动任务卡的消息永远不会新建任务**。仅「终态任务 + 非结单/非重开表达」放行老路径，允许在已了结话题里发起真正的新请求。
  - `close`：`closeAsExternallyResolved` 落终态 `superseded` + `epoch++`（拦截已领取 worker 的迟到回写）+ 清排队/催办/待发回执；`closureReason` 写入落态存档与通知日志——**取消类绝不记成「已完成」**（通知日志状态列 `已取消` / `外部完成`，见记忆铁律：inferred/取消不得写完成态）。终态任务再次结单则幂等回「已结束」，不重复操作。
  - `reopen`：`reopenClosed` 把人工结单的任务复活回 `queued` + `epoch++`，把本次结单存档进 `closureHistory` 留痕后清 `closureReason`/`externalResolution`；复用原 `task.id` → 复用原分支/worktree。兄弟归并 `supersede`（有 `supersededBy` 无 `externalResolution`）与 `done` 一律不可重开（复活会与已完成的兄弟重复劳动）。
  - `confirm`：意图不明，回一句让用户澄清「结束整个任务 or 只取消一部分」，原任务不变、不新建。
  - `resume`：活动态(parked) + 无结单信号 → 复用原任务补料续跑（见 5.1）。
  - `notice`：其它活动态 + 无结单信号 → 记录并引导，不新建。

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
