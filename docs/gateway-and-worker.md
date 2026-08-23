# Gateway 与 Worker

> Lark Bot 子系统文档之一，索引见 [README.md](./README.md)。
> 本文覆盖群内 @ 应用触发任务的基础链路、Gateway 契约、命令类型、Job 字段、Worker 执行规则与项目级配置。

## 1. 基础链路

```text
Lark 群 @应用，或 @配置的项目负责人
  ↓
Lark 事件订阅 im.message.receive_v1
  ↓
Bot Gateway 校验、解析、幂等入队
  ↓
Codex / Claude Worker 领取任务
  ↓
读取 docs_tdd 与当前项目代码
  ↓
按任务类型改文档 / 改代码 / 自测 / 输出差异
  ↓
回群通知结果并记录通知日志
```

## 2. Bot Gateway 要求

Bot Gateway 是独立的本机常驻服务，不放进 `apps/web` 运行时。当前由 `lark-cli event consume im.message.receive_v1` 长连接接收事件，不需要公网 tunnel 或自建 challenge / 验签端点。它负责：

- 只接受白名单群和白名单用户。信任边界是**白名单群**：群内 QA / PM / 后台 @ 都能触发，群消息只按群放行、不按发送人过滤；p2p 直发才按白名单用户放行。**推荐动态成员制 `allowedChatIds:"auto"`**：白名单 = bot 当前所在的群（`im +chat-list`），新群拉进去即时响应、无需改配置或重启（未知 chat 首次 @ 自动刷新再判）。**fail-closed 硬规则**：完全没配任何白名单（`allowedChatIds` 非 `"auto"` 且群 + 用户皆空）时拒绝所有事件，绝不因配置漏填而放行所有人。
- 群内 `@应用` 直接入队；**`@所有人` 与 `@taskMentionOpenIds` 中负责人同档**，先走严格只读意图分类，只有中高置信度的 bug / 明确需求才正式入队，其余静默忽略（喊一句全体通知不该等于「授权改代码」）。未配 `botOpenId` 的旧配置同样收紧到只读分类。普通群聊永远不调用 AI。
- `@负责人` 代理触发依赖 Lark 应用的“获取群组中所有消息”只读权限（申请项为 `im:message.group_msg:readonly`；当前应用 scope API 展示 tenant `im:message:readonly`）及 `im.message.receive_v1` 事件订阅；未获该权限时 Lark 不会投递未 @bot 的群消息，代码侧无法补救。
- 前置分类必须持久化 `received` 后由 Worker 执行；Claude 仅开放 Read + plan 权限，Codex 使用 read-only + network off。分类失败落 `intake_failed`、不改代码、不发群失败卡；分类结论与 CLI 输出进入执行审计。全量消息中的 `sender_type=bot` 必须在触发判定前丢弃，防自身卡片回流。
- 使用 `message_id` 做幂等，避免重复执行。
- 将消息解析为 Job，写入任务队列。
- 提供任务领取、任务状态回写和群通知能力。

上下文与图片读取要求：

- 收发消息、读取话题和下载图片统一使用 `lark-cli` 已登录的 bot 身份（keychain）；自定义机器人 `webhookUrl/secret` 只能作为发消息通道，不能读取上下文或图片。
- 当 @ 消息位于话题内，Gateway 会合并被引用消息和同话题其他真人回复，并下载父消息、当前消息及兄弟回复中的图片；机器人卡片不回灌给 AI。读取话题需群消息历史权限。
- 图片按实际任务项目保存到 `<PROJECT-ID>/agent/lark-attachments/<messageId>/`，`localPath` 写入 task；下载失败时保留 `imageKey/width/height/downloadError`，明确报告技术原因，不泛化成“任务信息不足”。
- 附件目录默认保留 7 天，Gateway 启动时及此后每小时按目录 mtime 清扫；可用 `attachmentRetentionDays` 调整。

## 3. 推荐命令类型

群内 @ 应用时，建议把意图写清楚：

```text
@Codex 文档：整理 docs_tdd，补充 QA 用例流程
@Codex 修复：/xxx 页面 light 模式背景色不对
@Codex 自测：跑页面桌面和 390px 移动端
@Codex API：根据 Swagger 校准 service 和 mock
@Codex QA：比对 QA 用例与 PRD 差异
@Codex 状态：汇总当前分支、未提交变更、验证结果
```

支持的通用类型：

- `文档 / docs`：只改文档或补规则。
- `修复 / fix`：修 bug 或 UI 偏差。
- `自测 / test`：运行验证并汇总结果。
- `API / api`：校准接口、schema、mapper、mock。
- `QA / qa`：比对 QA 用例、执行回归。
- `状态 / status`：只读状态并回群。

命令类型判定分两条来源，`classifyCommandType` 统一返回 `{type, source}`：

- **显式前缀（`source:'explicit'`）优先**：首行以上述前缀开头即为权威口径，可据此改写外部系统状态（如 bug 表回写完成值）。
- **自然语言兜底（`source:'inferred'`，仅群消息）**：无显式前缀时，只在文本**同时**满足「项目级主题（项目/需求/任务…的状态·进度·阶段，或"做到哪""下一步"）」+「明确问句/查询信号」，且**不含任一缺陷信号或写操作动词**时才推断为 `status`。缺陷信号（如"转圈""白屏""报错""不显示""字段""接口"…）或写操作动词（修复/修改/更新/实现…）**一票否决**。例："这个项目现在做到哪了？"→ 只读查询；"项目状态一直转圈"「状态字段不显示」"修复项目状态显示错误"→ 均按变更任务处理。
- **bug 表只认显式前缀**（`readBugCommandType` 走 `parseCommandType`，不做自然语言兜底）：把一条真 bug 误判成 status 会让它走只读沙箱、零改动 done、并把记录回写成完成值离开待处理筛选而无人再复核，代价不对称，故 bug 表记录只有标题显式写「状态：…」才当只读查询；QA「验退」恒按 `fix` 处理。
- **推断来源绝不写回完成值**（纵深防御）：`source:'inferred'` 的只读判定不回写 bug 表 `readOnlyDoneValue`，保留原状态待人工复核；结果卡追加「本条按只读查询处理，如判断有误请回复」，可纠偏。

不清晰的消息只回复需要补充的信息，不自动猜测执行。

## 4. Job 字段

Job 至少包含：

| 字段 | 说明 |
|------|------|
| `jobId` | 任务 id |
| `source` | 固定为 `lark` |
| `chatId` | 来源群 |
| `messageId` | Lark 消息 id，用于幂等 |
| `operator` | 触发人 |
| `project` | 项目名 / 当前需求 |
| `commandType` | `docs / fix / test / api / qa / status` |
| `rawText` | 原始消息摘要 |
| `scope` | 影响范围 |
| `approvalRequired` | 是否需要人工确认 |
| `createdAt` | 创建时间 |

## 5. Worker 执行规则

Codex / Claude Worker 领取任务后：

1. 先读取 `apps/web/docs_tdd/AGENTS.md`、`CONTEXT.md`、`common/README.md` 和当前项目文档；项目输入至少包含 `product/00-feature-inventory.md`、`product/04-frontend-tasks.md`、`agent/lark-integration.md`、`agent/README.md` 中实际存在的文件，其中 `00` 是 scope 裁决真值源。
2. 按命令类型决定只改文档、改代码、跑自测或输出差异；任务正文含 Figma 链接时，非只读任务先用 `figma-spec.mjs` 把规格落到本轮审计目录并注入 prompt。
3. 改代码前先更新必要文档或任务说明。
4. 代码变更后运行触达文件 Biome。
5. UI / 交互变更后验证桌面、390px H5、dark / light。
6. 输出 diff 摘要、验证结果、风险和待确认项。
7. 完成后回群通知结果，并写入通知记录。
8. 完成后 bot 会把**自己产生的改动**本地提交（临时 worktree 提交到其 hotfix 分支；命中已有 worktree 提交到其当前分支），但**从不 push、不开 PR、不合并**，留待人工 review。绝不自动提交人类的既存 WIP：命中的已有 worktree 在任务开始前若已有未提交改动，任务会改路由到隔离的临时 worktree，bot 的改动落隔离分支、完全不碰人类工作区。

任务生命周期、自动执行 / 必须确认的具体边界与回复格式见 [task-boundaries-and-reply.md](./task-boundaries-and-reply.md)。

## 6. 项目级配置要求

需要群内 @ 应用触发任务的项目，`<PROJECT-ID>/agent/` 下必须包含：

- 事件订阅配置说明。
- Bot Gateway 白名单（群 id、用户 id）。
- 任务队列接入方式。
- Worker 处理边界（可处理哪些命令类型、哪些需确认）。
- 通知记录位置（`agent/notification-log.md`）。

该 bot 是**机器级全局单例**（一个 gateway + 一个 worker，launchd 常驻），代码与运行时集中在 `common/lark-bot/`：启动薄包装 `common/lark-bot/runtime/lark-worker.mjs` 只调用 `common/lark-bot/lark-worker.mjs` 并传入项目编号、项目名称和需要读取的项目文档。Gateway 轮询、任务领取、Codex prompt、状态回写、空任务失败处理和兜底完成消息都由公共 Worker 维护；不得在项目目录复制完整 Worker 实现。单例配置（webhook/appToken/bug 表等，gitignore）为 `common/lark-bot/runtime/lark-bot.local.json`。

AI 执行器只允许 `claude` / `codex`，优先级为：task > `LARK_AI_EXECUTOR` > `lark-bot.local.json.aiExecutor` > wrapper > `claude`。群消息首个文本位置的 `[codex]` / `[claude]` 可单次覆盖，标签后可直接接正文；消息最前面的连续图片占位符不算正文，因此“图片 + `[codex]` + 正文”仍由 Codex 执行。正文已经开始后出现的标签不触发切换。外部投递可传 `aiExecutor`。未知值拒绝，入队即解析，排队/结果卡均显示实际执行器。可用 `codexModel` / `codexReasoningEffort` 固定本 Worker 的 Codex 模型/推理强度，不影响其它会话。

Codex 两阶段均为 `ephemeral + approval never + 工具网络关闭`：先把按任务抽取的现有 L1/L3 规则交给 `read-only` 分析，前后校验 git 状态；`blocked` 直接回群，只有 `ready` 才把规则原文和分析结论交给 `workspace-write` 实现。图片走 `--image`，结构化结果由 Worker 回写；Claude 保持 callback，但同样接收精准规则上下文。

审计写入 `<PROJECT>/agent/lark-audits/<taskId>.json/.log`：记录附件、规则来源/指纹、分析/最终结果、Gateway 状态和 CLI 输出；该目录已 gitignore。
