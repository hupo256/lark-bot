# 运行时与调度

> Lark Bot 子系统文档之一，索引见 [README.md](./README.md)。
> 本文覆盖当前实现（lark-cli 长连接）、bug 表跨项目路由与按需轮询、Worker 按 worktree 并行调度。

## 1. 当前实现：lark-cli 长连接（替代公网 tunnel）

历史上 Gateway 是独立 Koa 服务，靠公网 cloudflared tunnel 收 Lark 事件回调并做 challenge / 验签。当前推荐实现改为 **lark-cli 官方长连接**，`common/lark-bot/lark-gateway.mjs` 是本地专用 Gateway：

- 事件源：子进程 `lark-cli event consume im.message.receive_v1`（长连接），不再需要公网 tunnel、challenge 端点、手写签名校验。event bus 守护进程实测约 35MB。
- HTTP 契约：`GET /lark/health|tasks`、`POST /lark/tasks|tasks/next|tasks/:id/claim|tasks/:id/intake|tasks/:id/status|tasks/:id/retry|tasks/:id/reopen|tasks/prune`；状态接口接受 done/failed/blocked/waiting_confirmation，触发对应卡片，仅 done 回写 bug 表。状态回写带领取时的 `epoch`（fencing token），与当前不匹配返回 **409**（旧 worker 迟到回写被拒，不覆盖新一代执行）。`intake` 只接受与已存结果一致的幂等重试，不允许二次覆盖分类。`POST /lark/tasks` 缺失/无效项目号一律 `project=null`（与 ingest 口径统一），走 adhoc 临时 worktree，不塞 Gateway 主项目常驻 worktree。`retry` 重置 failed/blocked 为 queued；`reopen` 接收 QA「验退」并保留上一轮历史后换代排队；`prune` 清陈旧终态（默认 done）。
- 发消息、下载图片、读写多维表格统一走 lark-cli 已登录的 bot 身份（keychain）；配置文件里不放 app 级 `appSecret`。图片经 `lark-cli im +messages-resources-download` 落到 `<PROJECT>/agent/lark-attachments/<messageId>/`。
- 上线前置：Lark 后台开启事件订阅 `im.message.receive_v1` 并授 `im:message.p2p_msg:readonly` + 群消息收发 / `im:resource` / bitable 相关 scope；启用 `@负责人` 代理触发还必须授“获取群组中所有消息”只读权限。白名单 `allowedChatIds` / `allowedOpenIds`、`botOpenId` 与 `taskMentionOpenIds` 写入本机配置。
- 相关脚本：接收链路 `common/lark-bot/lark-gateway.mjs`；bug 多维表格链路 `common/lark-bot/lark-bugtable-poller.mjs`（`base +record-list` 拉「负责人=我 且 状态=待处理/验退」→ 投递或重开 Gateway 任务 → done 后 `base +record-batch-update` 回写状态）。
- **健壮性兜底**（无人值守必需）：
  - **领取租约 + AI 超时启动断言**：`claimNext` 领走任务时盖 `claimedAt`，超过 `LARK_TASK_LEASE_MS`（默认 40min）仍 `running` 视为孤儿（worker 崩了），下次领取时自动重入队。worker 启动即断言 `LARK_WORKER_AI_TIMEOUT_MS < LARK_TASK_LEASE_MS`，不满足拒绝启动——焊死「孤儿回收不与活着的 AI 双跑同一 worktree」这条唯一防线。
  - **毒任务死信 cap**：孤儿重投达 `LARK_MAX_REQUEUE`（默认 2）转 `failed` 死信、打 `deadLetterReason`、发一次告警卡，停止自动重投交人工；人工 `retry` 达 `LARK_MAX_RETRY`（默认 5）拒绝并提示 clean。防 crash 型 bug 绕过闭环无限烧钱。
  - **claim epoch / fencing token**：孤儿重投 / 人工 retry 递增 `task.epoch`，claim 返回基线，worker 回写带 `epoch`；`handleStatusUpdate` epoch 不匹配返回 409（缺省不校验，向后兼容）。防旧 worker 迟到回写覆盖新一代执行。
  - **事件摄入同步占位防 TOCTOU**：`ingestLarkEvent` 在任何 await 前用内存 `ingestingMessageIds` Set 同步占位，只有首个能进 ingest，持久化后交去重；堵 lark-cli 重投同一事件时并发双跑同一 messageId。
  - **持久化原子写 + 损坏隔离**：`persist` 走 `writeFileSync(.tmp)+renameSync` 原子替换；启动恢复遇非法 JSON 改名 `.corrupt` 并告警，不静默 continue 丢单。
  - **子进程超时**：所有 `lark-cli` 调用带 `LARK_CLI_TIMEOUT_MS`（默认 60s）超时，到点 SIGTERM→3s 后 SIGKILL，避免卡网/卡登录永久挂起。worker 的 AI 进程超时同样升级到 SIGKILL。
  - **AI 启动预检**：Worker 启动、写首个 heartbeat 前先检查所选执行器 CLI。Codex 额外检查 `codex login status`，并使用 `codexModel` / `codexReasoningEffort` 做只读模型探测；Pi 检查 `piProvider` 的认证状态，并用任务实际的 provider / model / reasoning 做模型探测；Cursor 检查 `cursor-agent status`；Claude 检查 CLI 可用性。探测结果写入 heartbeat 的 `readiness`，`lark-bot start/restart` 必须等到该状态为 `ok` 才成功；任务领取时复用进程内缓存，不重复探测。AI 硬超时用 `LARK_WORKER_AI_TIMEOUT_MS`（默认 30min；兼容旧 `LARK_WORKER_CODEX_TIMEOUT_MS`）。Pi 任务使用 JSON 事件流写审计，连续 `LARK_PI_IDLE_TIMEOUT_MS`（默认 5min）没有任何 provider / tool 事件时会终止假运行并按瞬时错误自动重试，而不是空等到 30min。
  - **重连告警滑动窗口 + 事件静默探活**：退避延迟计数（稳定存活归零）与告警判定（`restartWindow` 滑动窗口，默认 `LARK_RECONNECT_ALERT_WINDOW_MS=10min`）解耦——「每 61s 抖一次」这类持续掉线也能告警。consumer 死亡或事件静默超 `LARK_EVENT_STALE_MS`（默认 30min，仅曾收到事件后判）时 `/lark/health` 返回 **503** 供外部探活。
  - **/lark/health 观测增强**：补 `consumerDetail`（lastEventAt / 窗口抖动数 / alerted / backoff）、`oldestQueuedAgeMs`、`minLeaseRemainingMs`、`deadLetters`、`topRequeued`、`pendingReceipts` 与 Worker `readiness`（各状态计数与卡住任务 id 之外）。**规则指纹**：worker 每次启动 AI 前用 `readRuleFingerprints` 取当前两层发布指纹注入 AI 上下文与审计；常驻必需规则缺失仍按 `VERIFY-RULE-004` fail-closed。发布层 stale 检测（旧 `ruleChainFresh` / `inspectRuleChain`）已下线——规则消费改 pin-based，发布落后于源不影响在飞任务，主动查询走 `docs-tdd rules status`。
  - **结果回执可靠性**：终态卡发送失败时不直接落可清理终态，改为持久化 `pendingReceipt` 并置 `result_pending_receipt`；Gateway 每 5min 用同一幂等键重试，成功后才恢复 `done` / `failed` / `no_change_needed`。达到 `LARK_RECEIPT_MAX_ATTEMPTS`（默认 12）后保持 pending 并在 health 告警；修复 Lark 发送能力后用 `lark-bot receipt-retry <id>` 只重开发卡，不重跑 AI 或重复提交。
  - **本地 API 鉴权（必填，缺则拒绝启动）**：`LARK_GATEWAY_SECRET` 是硬前置——Gateway 启动时断言缺失即 `exit(1)`（同 `isWhitelisted` 的 fail-closed 立场，绝不降级放行）。所有写操作 POST 与 `GET /lark/tasks`（返回工单正文 / 附件路径 / 内部分支名）必须带 `x-lark-gateway-secret`，worker/poller/CLI 从同名环境变量读取（`secretHeaders()`）；只有 `GET /lark/health` 可匿名探活。密钥写 `~/.config/fameex-lark/gateway-secret`（0600，launchd wrapper 与 `lark-bot` 均从该文件注入；**不写 plist**——world-readable 且 `lark-bot restart` 会重写丢键）。`readBody` 有 1MB 上限。另：`runtime/*.json`（含 bug 表 appToken/URL、任务运行态）写入时带 `mode 0o600`，启动时对历史 0644 文件统一 chmod 并告警。
  - **附件文件名 sanitize、状态白名单校验**：`imageKey` 拼本地路径前清路径分隔符；`/status` 只接受合法生命周期状态。
  - **话题上下文合并**：任务位于 thread 时，除被引用父消息外，还读取同话题其他真人回复的文字和图片，按各自 messageId 下载后合并到 task；排除当前消息、已合并父消息和 bot/app 消息，避免重复与卡片回灌。
  - **附件保留期**：`agent/lark-attachments/<messageId>/` 默认保留 7 天（`attachmentRetentionDays` 可调），Gateway 启动即扫、之后每小时按目录 mtime 清理，任务记录已 prune 后留下的孤儿附件也会回收。
  - **命令类型解析 + 只读分流（带来源）**（`classifyCommandType` / `resolveCommandType`）：Gateway 摄入时优先按任务首行显式前缀（`状态/status`、`文档/docs`、`修复/fix`、`自测/test`、`api`、`qa`）落 `task.commandType` 并记 `commandTypeSource='explicit'`；无前缀时对**群消息**做保守自然语言推断（`source='inferred'`，需项目级主题 + 问句信号，且缺陷信号/写操作动词一票否决），**bug 表只认显式前缀、绝不推断**。`resolveCommandType` 是唯一分流判据（worker / 卡片 / 回写共用，回推旧任务来源，无数据迁移）。worker 对 `status` 走严格只读分流：不新建临时 worktree、不运行写式文档同步、不跑会暂存或纠正代码的规范闸、不提交；Codex 用 `read-only` 沙箱。AI 正常返回结构化 `done` 且 `changedFiles=[]` 即发绿色"查询成功"卡，普通修复的"done + 零 diff 不可信"规则不变。**推断来源（`inferred`）的只读判定绝不回写 bug 表完成值**（纵深防御，防误判静默关单），结果卡追加「本条按只读查询处理，如判断有误请回复」。
  - **完成警告与失败分流**（`lark-ai-result.schema.json` / `lark-task-runner.mjs`）：AI 内部结果支持 `done_with_warnings` + `warnings[]`；自动视觉验收默认关闭，只有任务明确要求但现有页面不可用等非阻塞场景才提醒。Worker 仍执行规范闸和 diff 可信度评估，通过后归一为 Gateway `done`。真实 `failed` 才用 `failureKind` 与 `nextStep`。
  - **续任务闭环 + owner @ 落地**：见 [task-boundaries-and-reply.md](./task-boundaries-and-reply.md) §3——补料复用原任务续跑（`resumeWithSupplement`）、`owner` 命中 `config.ownerMap` 则 @ 责任人（`resolveOwnerMention`）。
- **规则上下文（多标签 + 分级缺章处理）**（`lib/lark-rule-context.mjs`）：`classifyLarkTask` 由「单一胜出」改**多标签叠加**（如 ui+api 同时命中就都产出 scenario，`refsFor` 按标签并集加载规则）；**有图片附件或 `fix` 命令强制并入 UI+STYLE 信号**（视觉/修复类常只写「字段 / 背景 / 不对」易被误判成纯 API 任务丢样式 token 规则）；缺章按 required 分级处理：**只有常驻硬规则（`BASE_REFS`，标 `required:true`）缺失才 fail-closed 抛 `[VERIFY-RULE-004]`**（任何任务都必须带，缺了等于裸跑）；按信号路由的**辅助章节缺失只降级**——记 `warnings` 并浮现到结果卡与审计（`runAI` 在 claude 分支也返回 `ruleContext`，`lark-task-runner` 把 `warnings` 推进 `warnNotes`），不再让 `~/.ai-rules` 改标题就让所有匹配任务全红，也不让 warnings 变死代码。
- **Figma 规格预取**（`lib/lark-figma.mjs`）：非只读任务正文出现 Figma 链接时，Worker 在启动 AI 前用 `scripts/figma-spec.mjs` 把几何、标注和预览落到本轮审计目录，并把 `spec.md` 路径注入 prompt；链接、node-id、权限或 `FIGMA_TOKEN` / `FIGMA_API_KEY` 有误时直接转 `waiting_confirmation`，停在实施前，不允许凭截图猜设计后报完成。

## 2. bug 表链路：跨项目路由 + 按需轮询

bug 表按 `项目ID` 跨项目路由，与群 @ 共用 `resolveWorkContext`：

- 项目号须通过 `(PR|PM)-\d{3,}` 校验：自由文本提取用带词边界的 `\b(PR|PM)-\d{3,}\b`（`matchProjectId`，`SUPR-01947` 不吞出 `PR-01947`），整串校验用 `isProjectId`；群任务按“群名 > 正文 > adhoc”解析，poller 与群链路共用同一正则，Gateway/Worker 双重拦截非法路径。
- bug 表任务的回执与结果卡优先发送到群名匹配项目号的项目群；找不到项目群时私聊负责 RD，负责人也不可用时才回落默认通知群，避免跨项目卡片全部涌入同一群。
- 已有 worktree 时先隔离既存 WIP，done 后提交本次改动；失败/阻塞不提交，提交失败保留现场。
- 无 worktree 时基于 `origin/online` 建 `hotfix/<项目ID|adhoc>-<id>`；仅 done 提交并清理，失败/阻塞有半成品则保留，无改动可删除。
- 引用消息由 `messages-mget` 合并；`[Image: img_xxx]` / `![Image](img_xxx)` 占位会恢复、去重，并按实际项目下载。
- 仅 bug 表来源的 done 任务回写表格；**回写成功才置 `done`**，回写失败置中间态 `done_pending_writeback`（poller 视作 in-flight，不入队、不 seen），Gateway 每 5min 重试回写直至一致——消除「群报完成 + 表格永卡待处理」。代码修复使用 `doneValue`（当前“待推版”）；只读查询使用 `readOnlyDoneValue`（当前“已完成”）；waiting/blocked 配置 `waitingValue` 时同步为该值（当前复用“暂缓处理”），补料续跑后再次进入“修复中”。活动状态跳过，failed 计入 `stuck-failed`，不自动重跑。
- **QA 验退重开**：配置 `rejectedValue:"验退"` 后，poller 同时查询待处理与验退。验退是明确的人工作业信号，会忽略旧 `seen`，把同一 `record_id` 的 done/done_pending_writeback/failed/no_change_needed 作为新轮次重开；活动态和 waiting/blocked 仍去重。重开会保存上一轮结果到 `executionHistory`、递增 `qaReturnCount` 与 `epoch`、补发领取卡，并在 prompt 中要求先分析上一轮未解决根因。临时 hotfix 复用原分支 tip 继续提交，不从 `origin/online` 重置；审计文件按 epoch 分轮保留。
- **failed 人工重触发闭环**：群 @ 任务可直接重新 @（新 messageId 天然是新任务）；bug 表任务 id=record_id 固定、POST 幂等会命中旧 failed，只能显式重置 —— `lark-bot failed` 列出待处理失败项，`lark-bot retry <id>` 把 failed/blocked 重置为 queued（`retryCount++`、补发「已重新入队」卡片），worker 下一轮重跑。**不做自动重试**（避免对修不动的 bug 无限烧钱）。
- poller 由 `lark-bot poll-on/off` 控制，并使用 `KeepAlive=false` 的 LaunchAgent 托管，避免启动它的终端或 Agent 会话退出时把轮询进程一并清理；空闲 `LARK_BUGTABLE_IDLE_OFF_MS` 后仍会自动停止。G6/G7 提醒开启，G8 提醒关闭。`lark-bot restart` 会记录重启前的 poller 状态，核心服务和 Codex readiness 均恢复后才按原状态重新开启，不会把 QA 轮询窗口静默关掉。
- 运维入口的版本化实现位于 `common/lark-bot/scripts/lark-bot`，`~/.local/bin/lark-bot` 仅为薄入口。`start/restart` 对 plist 安装、Gateway 健康、Worker 心跳和 AI readiness 任一失败均返回非零；`status` 展示 executor/model/reasoning、code/config/rule stale、任务积压与回执/表格回写挂起。
- **status 的挂起盘点**：`status` 的 `tasks:` 行含 `waiting=N`，并在 N>0 时列出每条 `waiting_confirmation` 的 id / 项目 / 已挂起时长 / 已催轮次 / 结论摘要 + 续跑与结单指令。理由：挂起催办满 `LARK_PARKED_REMIND_ROUNDS`（默认 3）轮后 Gateway 就不再提醒，此后这些任务只能靠这里被盘点到。明细走**带鉴权**的 `GET /lark/tasks`（任务正文属业务内容，不塞进可匿名的 `/lark/health`）；取不到时降级为一行提示，不影响其余状态输出，也不改变退出码——挂起是等人的正常业务态，不是不健康。
- **陈旧终态清理**：Gateway 每小时自动清 `updatedAt` 早于 `pruneDoneAfterHours`（默认 24h）的 `done`、`done_with_warnings`、`no_change_needed`、`ignored`、`intake_failed`，`/lark/health` 计数不再单调增长；`lark-bot clean [hours]` 手动立即清已完成任务，`lark-bot clean --failed [hours]` 一并清 failed/blocked。**failed 默认不自动删**：删掉后 bug 表若仍待处理，poller 下一轮会把它当新任务重投 = 变相自动重试，故 failed 只在人工确认后 `clean --failed` 或 `retry`。

## 3. Worker 并行调度（按 worktree）

worker 不再是单串行循环，而是**按目标 worktree 并行**的调度器：

- **调度键 = `resolveWorkContext(task).cwd`**。同一 worktree（同项目、或同 adhoc 分支）的任务**串行**（并发 AI 在同目录改文件会打架）；不同 worktree 的任务**并行**。
- **并发上限** `LARK_WORKER_CONCURRENCY`（默认 3）。调度循环：`inFlight`（Map，key=cwd）未满时，`GET /lark/tasks` 列出 queued/received 按 createdAt 升序，挑第一个「cwd 未在飞」的任务，`POST /lark/tasks/:id/claim` 原子领取（返回 null 表示被并发领走/状态已变，下一轮重来），启动 `runTask` 并在 `finally` 里 `inFlight.delete(cwd)`。
- **`--once`** 保持旧单次语义（领一个最老 pending 跑完退出）。
- **临时 worktree 提速**：`prepareTempWorktree` 建好后 `linkNodeModules` 把主仓的 node_modules（根 + `apps/*` + `packages/*`，pnpm monorepo 每包各一份）**软链**进临时目录，免 `pnpm install`（重建整棵符号链接树很慢）。临时 worktree 基于 `origin/online`、依赖集与主仓一致，Node 经目录软链 realpath 解析进主仓 store。软链失败只 warn（claude 可自行装依赖兜底）。
- **验证分级**：L1 样式/文案只跑 diff-check、触达文件 Biome 和已有直接测试，不跑 type-check；L2 逻辑/类型、L3 契约/共享改动才跑触达包 type-check。临时 worktree 用已软链的 `.bin`，Vitest 加 `--no-cache`；同一检查最多一次，必需项完成即收尾。
- **编码规范双保险**：① prompt 里让 claude 先读 `~/.ai-rules/skills/coding-quality/SKILL.md` + 按 `rule-router.md` 加载 L3，并内联最易踩红线（禁 arbitrary value、颜色必须用真实 preset token）；② **无人值守规范闸**（`lib/lark-lint-diff.mjs` + worker `enforceCodeQuality`）：任务成功、提交前扫本次 **diff 新增行**的违规，命中先让 AI **定向纠正一次**，仍残留则写进 commit message（`⚠ N 处未修正规范问题`）供人工 review。覆盖：arbitrary value（`rounded-[8px]`…含 `ring/outline/aspect/columns/indent/content` 前缀）、失效裸色类（`text-green` 等 Tailwind 静默丢弃的未知类）、裸 `any`（`as any`/`: any`/`<any>`，限 TS）、i18n 动态 key（`t(变量)`/模板插值）、JSX 文本硬编码中文。降噪：Tailwind 类只在 className 语境（引号内/`@apply`）判、跳过纯注释行、一行多违规经 `matchAll` 全列。只扫 `+` 行、不碰存量债。
- **done 可信度交叉校验**（`lark-worker.mjs` `detectChangeTier`/`crossCheckChangedFiles`/`assessDoneResult`）：AI 回写 done 后，用真实 `git diff --name-only HEAD` 交叉校验 AI 自报 `changedFiles`——**done 但工作区零改动直接降级 failed 需人工复核**（无改动=无修复=不可信；状态/status 只读任务豁免）；**修复/缺陷/需求类任务本次改动全是测试文件（`isTestOnlyDiff`）时同样降级**（拿加测试凑 diff 冒充完成，正确出口是 `no_change_needed`+证据 或改真正的业务代码）；命中 `*.schema.*`/`mapper`/`/api/`/`*.d.ts`/跨包 `packages/` 即 L2+，AI 自报 checks 不含 type-check、或漏报/虚报改动文件 → 挂人工可见 `⚠` note（非阻塞）。

> git `worktree add/remove` 走 spawnSync 同步执行、本就互不交错，无需额外锁；并行的是各任务的 AI executor 运行。
> 规范闸是**代码级兜底**（不依赖哪个 AI 写的），补 prompt 自律之不足；团队级全局 lint 仍按项目节奏另议。
