# 多仓 profile 与 falive 接入

> Lark Bot 子系统文档之一，索引见 [README.md](./README.md)。
> 本文记录 2026-10-12 起把 lark-bot 从「fameex-web 单仓 bot」改成「按仓库 profile 路由」的设计、falive-react 的接入方式，以及受 Lark 外部群限制而采用的输入 / 输出链路。实现入口 `lib/lark-repo-profile.mjs`。

## 1. 已拍板（aven 2026-10-12）

| 决策 | 结论 |
|---|---|
| 实例形态 | **单实例多仓**：同一套 gateway / worker，按 `repos.<key>` profile 路由；不起第二套 launchd 实例 |
| falive 基线 | `feature/phase-3-api`（aven 的本地集成分支，不 fetch）；bot 分支 `lark/falive-<id>` 只本地 commit，aven 合回 |
| 别人负责的功能 | bot **跳过并 @ 负责人**（功能总表「前端」列），aven 本人点名要做的当次放行 |
| @aven 自动入队 | **打开**（`taskMentionOpenIds`，经只读意图分类） |
| 群消息读取权限 | 用户身份 `im` scope 已提交企业管理员审批，待批 |
| push | **不允许**，与 fameex 一致 |
| 执行器 | 意图 / 信息分类 **Opus 4.8**；只读分析 / 分诊 **Opus 5.5 `--effort high`**；实施 **Opus 5.5 `--effort medium`**；鉴权保持 `local`（2026-10-13 定） |

## 2. 为什么不能直接拉群

- falive 的群是**外部群**（跨租户），Lark 不允许加应用机器人，只能加「自定义机器人」（webhook）。lark-bot 的事件源是应用机器人长连接，在这些群里**收不到事件**。
- 单仓硬编码：`consumerRoot=fameex-web`、临时 worktree 基线 `origin/online`、项目号只认 `PR/TR/PM-xxxx`、规则是 docs_tdd 的 fameex 快照、prompt 写死 `pnpm --filter fameex`。falive 群没有项目号 → 旧逻辑会走 adhoc 在 **fameex-web** 上开分支。

## 3. 链路

```text
falive 群（外部群，无应用机器人）
  │ 用户身份轮询 lark-cli im +chat-messages-list（阶段③，待 im scope 审批）
  ▼
Gateway ingest：chatIds → repo profile → project=FALIVE, task.repo=falive
  │  @aven / @所有人 → Sonnet 只读意图分类 → bug / 需求才入队
  ▼
Worker：profile.root 上 git worktree add（基线 feature/phase-3-api）→ lark/falive-<id>
  │  规则 profile=falive（CLAUDE.md 固定前提 + 硬规则 required，add-module / msw-policy / coding-quality 按信号）
  │  Opus 5.5 high 只读分析（含 ownership 判定）→ Opus 5.5 medium 实施 → biome / 相关测试 / tsc
  │  别人负责 → no_change_needed(other_owner) + @ 负责人
  ▼
结果卡：先 bot 身份发（进得了群就有 message_id）→ 发不进再 webhook（自定义机器人）→ 再改投 notifyChatId（aven 私聊）；bot 失败记忆 1 小时
```

webhook 发出的卡片没有 `message_id`，不能作为「回复卡片」的锚点；控制通道改用**回复原任务消息**或显式指令 `继续任务 <id>` / `取消任务 <id>` / `结单 <id>`（已有能力）。

## 4. 配置（`runtime/lark-bot.local.json` → `repos.<key>`）

| 键 | 说明 | falive 当前值 |
|---|---|---|
| `root` | 业务仓绝对路径（必填） | `/Users/aven/github/falive-react` |
| `baseRef` / `fetchBase` | 临时 worktree 基线；远端 ref 才 fetch | `feature/phase-3-api` / `false` |
| `projectKey` | 任务的 `project` 值（大写，缺省 = key 大写） | `FALIVE` |
| `branchPrefix` | 临时分支前缀（缺省 `lark/<key>`） | `lark/falive` |
| `worktreesDir` | 临时 worktree 目录（缺省 `<root>/../.lark-<key>`） | `~/github/.lark-falive` |
| `chatIds` / `chatNames` | 属于该仓的群（优先于群名解析项目号；视同白名单）；只填群名时 gateway 启动用用户身份 chat-search 解析成 id | falive后端go天团、Falive PHP后端群 |
| `taskMentionOpenIds` | 该仓群里 @ 谁会触发只读意图分类（与全局叠加） | aven |
| `webhook` / `webhooksByChat` | `{ file }` 指向 0600 JSON（`webhookUrl` / `secret`）或 inline；`webhooksByChat` 按群名各配一个（每个外部群的自定义机器人 webhook 不同）；bot 发不进群时的兜底 | 两个群各一个文件 |
| `notifyChatId` | bot 与 webhook 都不可用时改投（私聊 open_id 或群） | aven 私聊 |
| `docs` | 注入 prompt 的项目文档（仓库相对） | CLAUDE.md、交付路线图、功能总表、对接状态总览 |
| `readableDirs` | `--add-dir` 只读放行的目录 | `x9_web_react` |
| `ruleProfile` | 规则来源表（`fameex` / `falive`） | `falive` |
| `installArgs` / `checksHint` | 依赖安装参数；仓库特有检查提示 | `install --frozen-lockfile --prefer-offline` / msw-audit |
| `scopeBudgets` | 行数上限覆盖 | bugfix 200 / qa_feedback 300 / requirement 1200 |
| `ownership` | `{ me, meOpenIds, table }` 归属规则 | me=aven，表=功能总表 |
| `ownerMap` | 人名 → open_id（结果卡 @ 负责人用） | 待补 |
| `docIntakeDir` | 群里别人发来的对接文档落到仓库的目录；配了即启用文档消息自动进分类 | `docs/delivery/待对接` |
| `contextTrigger` / `intake` | 外部群按上下文判任务：别人发的实质消息都进只读分类（缺省开）；去抖分道（10-15）：快道（@ 机器人 / 回复 bot 的卡 / 负责人本人 / 对接文档 / ≥200 字）等 `fastLaneMs`，慢道最后一条之后安静 `quietGapMs` 再分类、从首条起最多 `maxWaitMs`；旧字段 `intakeDebounceMs` 仍读 = quietGapMs | 开 / 0s · 60s · 180s |
| `concurrency` | 该仓同时最多跑几条任务；同主题串行、不同主题并行（缺省 3） | 3 |
| `quietQueuedCards` | 外部群排队卡改发 notifyChatId，群里只出结果卡（缺省开） | 开 |
| `commitPrefix` | bot 提交标题前缀，满足仓库 commit-msg 钩子 | `feat(bot)` |
| `poll` / `dailyReport` | 轮询频率 / 日报（见 §6、§7） | 见下 |
| `claudeModel` / `claudeEffort` | 实施阶段模型 | opus-5-5 / medium |
| `claudeAnalysisModel` / `claudeAnalysisEffort` | 只读分析 / 分诊阶段模型 | opus-5-5 / high |
| `claudeIntentModel` / `claudeIntentEffort` | 意图 / 信息分类模型与强度（强度缺省同 `claudeEffort`） | opus-5-5 / high（2026-10-14 aven：分类要准） |
| `aiTimeoutMs` | 该仓 AI 硬超时（必须 < `LARK_TASK_LEASE_MS`，launchd wrapper 已设 75min） | 60min |

默认仓 `fameex` 不写也存在，行为与拆仓前一致；`repos.fameex` 只允许覆盖模型 / 预算 / 人员表。

## 5. 改动面（代码）

| 文件 | 变化 |
|---|---|
| `lib/lark-repo-profile.mjs`（新） | profile 归一 / 注册表 / 群→仓 / projectKey 放行 / 投递决策 / webhook 凭据 |
| `lib/lark-webhook.mjs`（新） | 自定义机器人 webhook：签名、body、重试 |
| `lib/lark-cli.mjs` | `sendChatMessage` 先问 `resolveRepoDelivery`：webhook / 改投 / 原 bot 发送 |
| `lib/lark-work-context.mjs` | 路由全部按 profile；`safeProject` 放行已注册 projectKey；上下文带 `repo / repoRoot / ruleProfile / baseRef / fetchBase` |
| `lib/lark-worker-git.mjs` | `prepareTempWorktree` / `finalizeTempWorktree` 接 `repoRoot` / `fetchBase`；fetch 按 `<remote>/<branch>` 拆 |
| `lib/lark-ai-executor.mjs` | claude 四种命令带 `--model` / `--effort`；`claudeIntentModel`；profile.readableDirs 进 `--add-dir`；按仓超时 |
| `lib/lark-rule-context.mjs` | `ruleProfile` 路由表（falive 读仓内 CLAUDE.md / add-module / msw-policy）；新增 `module` 信号 |
| `lib/lark-worker-prompts.mjs` | 安装 / 检查 / 红线 / 基线说明按 profile；归属判定段；分析输出含 `ownership` |
| `lib/lark-worker-run.mjs` | 规则 profile、模型、预算按仓；**归属闸** `resolveOwnershipOutcome` |
| `lib/lark-task-runner.mjs` | 透传 repoRoot / fetchBase / installArgs / 预算 / profile |
| `lib/lark-ingest.mjs` / `lib/lark-routes.mjs` | profile 群 → `project=projectKey, task.repo`；`POST /lark/tasks` 接受 `repo` |
| `lib/lark-status.mjs` / `lib/lark-cards.mjs` | `other_owner` 结果卡 @ 负责人；ownerMap 叠加 profile |
| `lib/lark-config.mjs` | `configTitleFor` 认 projectKey；`validateConfig` 校验 repos |
| `schemas/lark-ai-analysis.schema.json` | 可选 `ownership` |
| `lark-gateway.mjs` / `lark-worker.mjs` | 启动注册 profile；worker 对各仓模型做就绪探针；租约断言取各仓最大超时 |
| `runtime/launchd-node.sh` | `LARK_TASK_LEASE_MS` 默认 75min |

## 6. 群消息轮询器（已实现，`lib/lark-chat-poller.mjs`；待 im scope + chatIds）

gateway 内置：对每个配了 `chatIds` 的非默认仓，用用户身份 `lark-cli --as user im +chat-messages-list --chat-id <oc> --start <游标-2min>` 拉新消息，message_id 去重后转成与长连接同形的事件喂 `ingestLarkEvent`。首次启动游标从「现在」起，不回灌历史；只喂 `sender_type=user` 的消息（自家 webhook 卡 / 系统消息 / 已撤回一律丢）。频率（`profile.poll`，aven 定）：08:00–19:00 活跃（30 分钟内有新消息）30s、空闲 120s；19:00–08:00 15min；出错按 2 倍退避到 15min，连续失败 10 次给负责人发一次告警、恢复再发一次。状态落 `runtime/lark-chat-poller-state.json`；`/lark/health` 的 `chatPoller` 字段可观测。

**对接文档自动接入**：外部群里直接发 `.md / .pdf / .docx …` 文件（无需 @）→ 文件消息进只读意图分类（`docAttachmentsTrigger`）→ 判为需求即入队为 `api` 任务，附件用用户身份下载到 `runtime/lark-attachments/FALIVE/<messageId>/`；实施 prompt 要求先把文件原样拷到 `profile.docIntakeDir`（falive：`docs/delivery/待对接/`），再按归属接 schema / queries / mapper，缺字段写进 summary「待后端支持」。

### 6.1 入口规则（aven 2026-10-13 定：准确分类、同话题一个任务、少开 worktree、确实是 aven 的才建任务）

- **按主题归并、按主题并行**（aven 2026-10-13「并行处理，尽快落实」）：分类器输出 `topic`（短的稳定标识）和 `relatedTaskId`（提示里给了最近 7 天同群任务列表，让它判断本条是哪条的延续）。判为延续 → `store.mergeIntoTask` 并入那条（未开跑追加、在跑完成后再跑一轮、挂起当补料续跑、已了结重开同分支），本条落 superseded；新主题 → 新任务。话题 id 只是提示（同话题默认同主题，但话题里夹的无关内容不硬归）。worker 调度：同主题串行、不同主题并行，`concurrency` 缺省 3。
- **分类去抖（分道）**：@ 机器人 / 回复 bot 的卡 / 负责人本人 / 完整件不等，下一个 worker 周期就分类；其余等 `intake.quietGapMs`（60s）安静、从首条起最多 `intake.maxWaitMs`（180s），补充不再无限顺延。分类带完整上下文（被引用消息 + 话题其它回复 + 群里之前的消息含 Aven.Bot 自己的卡 + 附件）。「收到」同人同群 2 分钟内只回一次。
- **门槛**：分类输出 `decision` / `confidence` / `forMe`。只有 **high 且 forMe≠false** 才自动开跑；判为任务但 medium 或 forMe 不确定 → **疑似**：挂待确认、不催办，只私发 aven 一张卡（`继续任务 <id> 做` 开跑 / `取消任务 <id>` 关掉）；ignore 静默。被代理人自己发的消息不分类。
- **并行**：`concurrency=3`，同主题串行、不同主题并行。
- 试运行期所有卡片只发 aven 私聊（`cardsToNotifyOnly`）。

### 6.2 出口：人话消息，不发卡（aven 2026-10-13 晚定，`lib/lark-repo-delivery.mjs`）

仓库 profile 的任务**不走**默认仓那套卡片 / 回执 / 催办 / 收尾知会（`isHumanDeliveryTask` 分流，fameex 原逻辑一字不动）。出口只有两条：

- **负责人私聊**（bot 身份 Markdown）：开始一行 `🛠 开始做：…（群名）`；结束一条：`✅ 人话结论 / 分支 · 改了 n 个文件 / 要谁跟进：云文档链接 / 群里已回「…」或「群里没发（没配 webhook），要回可以转发这段」`；停下来 `⏸ … 要：… 回复这条消息把材料补上就会继续`；不用改 `ℹ️`；失败 `⛔`；疑似 `❓ 可能是你的事 … 是 → 回「继续任务 id 做」`。结果正文里的范围契约、系统实测、终检明细只进审计不上消息（`humanizeResult`）。不催办。
- **外部群**：只在 done 时发一句（`✅ groupReply`）；有待跟进 → 执行器落盘的 `docs/delivery/pending/<主题>-待确认-<日期>.md` 从分支取出、以 aven 身份建成 Lark 云文档（链接可读），群里发 `@负责人 一句话 + 链接 + 每人要点`。走该群自定义机器人 webhook（`webhooksByChat`）；没配就不发，私聊里附上要发的话。回群消息走 webhook 没有 message_id，续跑靠回复私聊那条。

### 6.3 代答提问 + 收尾口径

- 分类多一类 `question`：群里向 aven 提的问题（接口怎么调、前端现在怎么处理、某字段用不用、做没做、能不能复测），靠仓库代码 / 文档能答的才算。走只读 `status` 命令（不开 worktree），执行器把答案写进 `groupReply`（≤150 字）直接回群，署名「aven 的助手」；找不到依据就不回群只私聊。
- 分类上下文除被引用消息、话题回复外，再并上这条之前 3 小时内最近 8 条真人消息（`【群里这条之前的消息】`），一句话消息不再脱离前文判断。
- 后端答复类 / 缺材料的任务：先把不依赖那份材料的部分做完，缺什么写进待确认清单（`followUpDoc` / `followUps`）后按 done 收尾；只有整条一步都做不了才 blocked / waiting。不再因为「还有条目没答」就挂起刷消息。

### 6.4 并行

`concurrency=3`：同主题串行（同一份对接文档 / 功能一次只跑一条，后来的消息并入原任务、复用原分支），不同主题并行；临时 worktree 跑完即回收，分支保留给人 review。
### 6.5 负责人私聊 = 仓库控制通道（2026-10-14，`lib/lark-principal-channel.mjs`）

仓库的疑似 / 开始 / 结果 / 判不处理通知都发到 aven 和 bot 的私聊；aven 在那里回一句，是对**上一条通知**说的，不是给 fameex 主仓下 hotfix。私聊消息先锚定：回复了哪条通知就是哪条任务；没回复就取 bot 最近一条私聊通知所属的仓库任务（`principalReplyWindowMs` 内，缺省 12h，且比同一会话里最近的 fameex 回执新）。锚到了只走仓库通道：任务还挂着 → 当补料续跑；其它状态 → 建「私聊指示」任务（身份是私聊消息，群 / 发送人 / 话题沿用原群消息，`privateOrigin`），和群里 @Aven.Bot 走同一条分类 → 台账 → 派工 / 回群路径，回群对着原发送人说；私聊里只回一句「当作对「…」的指示处理，不是就回取消任务」。锚不到 → 放行老路径，fameex 私聊 hotfix 行为不变。

## 7. 日报（已实现，`lib/lark-daily-report.mjs`）

每天 `profile.dailyReport.at`（19:00）由 gateway 调度，当天只发一次（状态落盘防重启重发）。脚本确定性采集：aven 的工作 = 本地 `feature/phase-3-api` 当天提交 + 工作区未提交数；其他人 = `origin/pre`（先 fetch）当天提交按 `people` 别名归到人名，Merge 只计次；功能总表按状态 / 负责人统计并与上次快照 diff 出「今日升级」；交付路线图「可交付分三档」原文；bot 当天的任务结果。再交给 Opus 5.5（plan 模式、只读、cwd 在仓库可翻文档）按固定模板写：整体 / 今日完成（按人）/ 未完成与卡点 / 今日 pre 无提交 / 需要支持。正文与事实存 `runtime/lark-daily-report/falive/<日期>.md`。投递：用户身份发不进外部群（230027），群走各群自定义机器人 webhook 的富文本（`sendTo`），试运行期以 bot 身份私聊负责人发 Markdown。**云文档版**（`docTemplate`）：按仓库里的交接报告模板写当天完整版（全量功能表 / API 缺什么有问题 / 其它没做的 / 一句话现状），用户身份 `docs +create --doc-format markdown` 建成 Lark 云文档，短消息末尾带链接；完整版 md 也落在 `runtime/lark-daily-report/falive/`。2026-10-13 两种都已跑通。手动补跑 `lark-bot daily-report falive`（照 profile 投递，会发群）；试跑加 `--private`（或 `--to <id>`）只私聊、不发群。

## 8. 试跑与运维

```sh
lark-bot restart && lark-bot status           # worker 日志应出现 repo falive: claude model=claude-opus-5-5 effort=medium probe=passed
# 手工投一条 falive 任务（group 未接入前的试跑入口）
curl -s -X POST http://127.0.0.1:3005/lark/tasks \
  -H "x-lark-gateway-secret: $(cat ~/.config/fameex-lark/gateway-secret)" -H 'Content-Type: application/json' \
  -d '{"id":"manual-falive-001","source":"lark","repo":"falive","operator":"ou_91861d6da6cf6822e08045ba1868241e","text":"修复：…"}'
git -C ~/github/falive-react branch --list 'lark/falive-*'   # bot 产出的分支
```

审计在 `runtime/lark-audits/FALIVE/`，附件在 `runtime/lark-attachments/FALIVE/`。

- **发件簿**（10-15）：bot 往群里发的每条（收到 / 记下了 / 完成 / 兜底 / 要材料 / 待确认清单 / 日报）记进 `runtime/lark-outbox/<chatId>.jsonl`（对着谁、主题、阶段、正文、哈希），保留 7 天；统一出口 `sendGroupCard`（lib/lark-repo-delivery.mjs）。
- **对话包 + 锚定**（10-15）：每条群消息建任务前拼上「这个人正在进行的事」（他 2 小时内的任务、bot 最近对他说的话、他参与的台账条目）；同一个人、bot 对他最后一张卡 15 分钟内、本条 ≤ 20 字短指代句且无引用 → 默认接那条（`task.anchor`，「收到」里点明「接着 HH:MM 那条」），分类器用 `continues` 确认后同话题键、工单主题沿用。`lib/lark-conversation.mjs`。
- **出口闸**（10-15）：群发前查发件簿——同群同主题同阶段 120 秒内只发 1 条、同内容 24 小时不重发、「收到」同人 2 分钟 1 次；拦下的不发群、记一条 `gated`（`sendGroupCard` 返回 `{ ok: true, gated }`，调用方当已发处理）。日志 `出口闸拦下 …`。
- **入口指标**（10-15）：`lark-bot intake-stats falive [days] [--json]`——分道占比、收到→第一条群里可见输出 / 分类完成的中位数、话题补充并入数、默认锚点命中 / 分类器确认数、群发与出口闸拦截数（`scripts/lark-intake-stats.mjs`，读任务库 + 发件簿）。
