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
| `contextTrigger` / `intakeDebounceMs` | 外部群按上下文判任务：别人发的实质消息都进 Opus 4.8 只读分类（缺省开）；收到后等安静期（缺省 90s）再一次性分类，同话题连发合并 | 开 / 90s |
| `concurrency` | 该仓同时最多跑几条任务；同主题串行、不同主题并行（缺省 3） | 3 |
| `quietQueuedCards` | 外部群排队卡改发 notifyChatId，群里只出结果卡（缺省开） | 开 |
| `commitPrefix` | bot 提交标题前缀，满足仓库 commit-msg 钩子 | `feat(bot)` |
| `poll` / `dailyReport` | 轮询频率 / 日报（见 §6、§7） | 见下 |
| `claudeModel` / `claudeEffort` | 实施阶段模型 | opus-5-5 / medium |
| `claudeAnalysisModel` / `claudeAnalysisEffort` | 只读分析 / 分诊阶段模型 | opus-5-5 / high |
| `claudeIntentModel` | 意图 / 信息分类模型 | opus-4-8 |
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
- **分类去抖**：收到后等 `intakeDebounceMs`（90s）没有新消息再分类，连发的几条合成一次分类，带完整话题上下文（被引用消息 + 话题其它回复 + 附件）给 Opus 4.8。
- **门槛**：分类输出 `decision` / `confidence` / `forMe`。只有 **high 且 forMe≠false** 才自动开跑；判为任务但 medium 或 forMe 不确定 → **疑似**：挂待确认、不催办，只私发 aven 一张卡（`继续任务 <id> 做` 开跑 / `取消任务 <id>` 关掉）；ignore 静默。被代理人自己发的消息不分类。
- **并行**：`concurrency=3`，同主题串行、不同主题并行。
- 试运行期所有卡片只发 aven 私聊（`cardsToNotifyOnly`）。

### 6.2 群回复（aven 2026-10-13 定 A 方案，`lib/lark-group-reply.mjs`）

外部群不发卡片。任务落 done / no_change_needed 时以 **aven 的用户身份**往原群发人话（webhook 已删，用户身份是唯一能发进外部群的通道）：
- 全部对接完：`✅ <groupReply>（分支 …）— 由 aven 的助手整理`。
- 还需对方跟进：执行器把待确认项按负责人分节写成 `docs/delivery/pending/<主题>-待确认-<日期>.md`（随分支提交），gateway 从分支里取出该文件发进群，再发一句 `@负责人 …` + 条目摘要；负责人名字经 `ownerMap`（群成员 open_id）解析。
- failed / blocked / waiting 不进群，只私发 aven。

## 7. 日报（已实现，`lib/lark-daily-report.mjs`）

每天 `profile.dailyReport.at`（19:00）由 gateway 调度，当天只发一次（状态落盘防重启重发）。脚本确定性采集：aven 的工作 = 本地 `feature/phase-3-api` 当天提交 + 工作区未提交数；其他人 = `origin/pre`（先 fetch）当天提交按 `people` 别名归到人名，Merge 只计次；功能总表按状态 / 负责人统计并与上次快照 diff 出「今日升级」；交付路线图「可交付分三档」原文；bot 当天的任务结果。再交给 Opus 5.5（plan 模式、只读、cwd 在仓库可翻文档）按固定模板写：整体 / 今日完成（按人）/ 未完成与卡点 / 今日 pre 无提交 / 需要支持。正文与事实存 `runtime/lark-daily-report/falive/<日期>.md`。投递：用户身份发不进外部群（230027），群走各群自定义机器人 webhook 的富文本（`sendTo`），试运行期以 bot 身份私聊负责人发 Markdown。**云文档版**（`docTemplate`）：按仓库里的交接报告模板写当天完整版（全量功能表 / API 缺什么有问题 / 其它没做的 / 一句话现状），用户身份 `docs +create --doc-format markdown` 建成 Lark 云文档，短消息末尾带链接；完整版 md 也落在 `runtime/lark-daily-report/falive/`。2026-10-13 两种都已跑通。

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
