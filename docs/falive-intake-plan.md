# falive 外部群入口改造计划（2026-10-15）

> 目标：@ 机器人的消息**快**（有上下文地在一分钟内给下文）、**准**（知道是谁、接的哪句话、属于哪个条目）、**不吵**（同一件事群里不重复说）。
> 背景：180 秒去抖是为了压噪音，但数据显示它对 @ 机器人的消息几乎没合并到东西（15 条里 1 条），只是纯等；而「不知道任务内容」的根因是分类器拿不到上下文（三个 bug，见阶段 1）。
> 执行原则：一个阶段一次重启、观察一天再进下一阶段；每阶段有单测 + 回放用例；只改仓库 profile 分支，不碰 fameex 路径。

## 度量（每阶段结束对一次）

| 指标 | 现状 | 目标 |
|---|---|---|
| @ 机器人 → 第一条有内容的回应（不含固定「收到」） | ≥ 轮询 + 180s + 分类 | 中位 ≤ 60s |
| 回放集判对率（阶段 0 建） | 今天 5 条里 2 条错 | 全对 |
| 群里同主题同阶段 2 分钟内的 bot 消息数 | 无限制 | ≤ 1 |
| 任务正文带「群里之前的消息」块的比例 | 0 / 37 | 100% |

## 阶段 0 · 回放基线（半小时）✅ 10-15 `08b2c70`

- `scripts/lark-replay-classify.mjs` 加 `--ids om_a,om_b`，并把结果（decision / confidence / forMe / topic / continues / reply）打成一行一条。
- 固定回放集（从 `runtime/lark-tasks` 抄到 `__tests__/fixtures/falive-intake/`，脱敏 open_id 以外的内容不改）：
  1. Ache 预约改版（只 @ Aven.tong）+ aven 补「@Aven.Bot 帮记录提醒下」→ 期望 api_reply / 派工单
  2. Arthur「@Aven.Bot 把本次请求时间…提供一下」（引用 bot 卡）→ question
  3. Arthur「@Aven.Bot 重跑一次」（无引用，1 分钟前 bot 说过「需要的话我重跑一次」）→ 接上一条
  4. Arthur「@Aven.Bot 这个重跑一次」（引用卡）→ 接上一条
  5. Arthur「@Aven.Bot 直接发群里」（引用 bot「私发给你」的卡）→ 发送人是 Arthur、接上一条，不是 aven 的指示
  6. 10-13 Ache 连发 5 条（历史事故）→ 一个条目
- 跑一次记下现状，作为每阶段的对照。

## 阶段 1 · 把上下文真正送到分类器（小，1–2 小时）✅ 10-15 `08b2c70`（回放 5 条全部好转，见 fixtures README）

三个 bug，修完今天的 5 条里至少 3 条直接判对，与去抖无关。

| # | 改哪里 | 改什么 |
|---|---|---|
| 1.1 | `lib/lark-message.mjs` `createTimeMs` | 轮询拉到的 `create_time` 是 `"2026-10-15 13:21"` 字符串，`Number()` 成 NaN → 从没拉过「群里之前的消息」。改用 `lark-chat-poller.mjs` 里已有的 `toEpochMs`（抽到 `lark-message.mjs` 共用） |
| 1.2 | `lib/lark-cli.mjs` `fetchRecentChatContext` | 只留 `sender_type=user`，bot 自己的卡片全丢。改为：放行本群自定义机器人（`listChatCustomBots` 已能识别 Aven.Bot），卡片正文剥 `<card>` 与署名，发送人标成 `bot→<被 @ 的人>`；条数 8 → 10；窗口 3h 不变 |
| 1.3 | `lib/lark-worker-prompts.mjs` 分类提示；`runtime/lark-bot.local.json` | 加「发送人」块：名字（ownerMap 反查）、角色（新增 `memberRoles`：Ache/Encone/William=live php、Arthur=portal、Adrian/Eric=hichat、Broker=QA…）、是否本人。规则只加一句、合并掉现有「本人 @ 机器人」那句，守住 `lark-prompt-budget`（该测试现已超标 5740/4800，本阶段顺手把分类器规则压回预算内） |

验证：`lark-message.test.mjs`（时间解析三种形态）、`lark-pure.test.mjs`（上下文含 bot 卡）、回放集 2 / 5 判对、`lark-prompt-budget` 转绿。重启后看新任务正文都带「群里这条之前的消息」块。

## 阶段 2 · 分道去抖（小，半天）✅ 10-15

| # | 改哪里 | 改什么 |
|---|---|---|
| 2.1 | `lib/lark-repo-profile.mjs` | `intakeDebounceMs` 拆成 `intake: { fastLaneMs: 0, quietGapMs: 60000, maxWaitMs: 180000 }`；旧字段仍读、当 `quietGapMs` |
| 2.2 | `lib/lark-ingest.mjs` | 抽纯函数 `resolveIntakeNotBefore({ lane, firstReceivedAt, now, intake })`：快道 = now；慢道 = min(now + quietGap, firstReceivedAt + maxWait)。入库与「话题补充」两处都用它（补充不再无限顺延） |
| 2.3 | 同上 | 分道：`resolveRepoAddressing` 已算出 toBot / fromPrincipal；快道 = @ 机器人、回复 bot 卡片（`isRegisteredBotReceiptReply`）、本人私聊、@ 本人；其余慢道 |
| 2.4 | 同上 | 完整件直接放行：带文档附件、卡片、正文 ≥ 200 字 → 不等 |
| 2.5 | `lib/lark-repo-delivery.mjs` `deliverRepoAck` | 最小防重：同发送人同群 2 分钟内只回一次「收到」（快道会让一个人连发两行变成两条任务；完整出口闸在阶段 4） |

验证：`lark-thread-intake.test.mjs` 加快道不等 / 慢道封顶 / 补充不顺延 / 完整件放行四组；回放集 6 仍并成一个条目（靠台账归并，不靠去抖）。重启后一天内看 @ 机器人的响应时间。

## 阶段 3 · 发件簿（出口持久化，为 4 和 5 打底，小，2 小时）✅ 10-15

webhook 发出去的卡片没有 message_id，bot 现在不记得自己对谁说过什么。

- `runtime/lark-outbox/<chatId>.jsonl`：每条群发记 `{ at, taskId, topic, phase(ack|start|done|noted|suspected|summary), to(openId), text, hash }`。
- 所有群发统一经 `lib/lark-outbox.mjs` 的 `recordAndSend`（`deliverRepo*`、`postGroupSummary`、`deliverRepoNoted`、日报都走它）。
- 保留 7 天，启动时清理。

验证：单测写读；真实发一条看文件。

## 阶段 4 · 对话包 + 锚定（中，1 天）

@ 机器人时机械地把「它在接谁的哪句话」拉齐，再让 Fable 判。

| # | 改哪里 | 改什么 |
|---|---|---|
| 4.1 | `lib/lark-ingest.mjs` / 新 `lib/lark-conversation.mjs` | 组对话包 `buildConversationBundle({ msg, repo, store })`：① 发送人（阶段 1.3）② 被引用 / 话题 / 最近 10 条（阶段 1.1–1.2）③ **这个人正在进行的事**：他 2 小时内的任务（id、主题、状态、bot 最后对他说的话——来自发件簿）、台账里和他相关且在等答复的条目 ④ 台账（已有） |
| 4.2 | `schemas/lark-intent-classification.schema.json`、提示词 | 新字段 `continues: { taskId \| ledgerId \| null, reason }`：接的是哪条，还是新事 |
| 4.3 | `lib/lark-conversation.mjs` `defaultAnchor` | 机械默认锚点：同一发送人 + 发件簿里 bot 对他最后一张卡 ≤ 15 分钟 + 本条短（≤ 20 字）且带指代（重跑 / 这个 / 再试 / 还是不行 / 好了 / 可以了）且无引用 → 预填 `continues`，分类器只确认或否决 |
| 4.4 | `lib/lark-routes.mjs` | `continues` 命中任务 → 走现有续跑路径（`handleResume` / 「继续任务」），不新建；命中台账条目 → 现有按条目派工单 |
| 4.5 | `deliverRepoAck` | 「收到」里点明接的是哪条（「收到，接着 17:48 那条重跑」），错了对方一句话能纠正 |
| 4.6 | 多人多线 | 锚点查找顺序固定：同发送人的对话 → 引用 → 话题 → 时间最近；不同人各自一条线，互不串 |

验证：`lark-conversation.test.mjs`（锚点正反例各 5）；回放集 3 / 4 / 5 判对；真实群观察一天，错锚率记进 lessons。

## 阶段 5 · 出口闸（小，半天）

把「不吵」从入口搬到出口，之后入口再也不用为噪音拖时间。

- `lib/lark-outbox.mjs` `shouldSend({ chatId, topic, phase, to, hash })`：同群同主题同阶段 120 秒内只发 1 条（后到的合并进下一条或丢弃并记日志）；同内容哈希 24 小时不重发；「收到」每人每主题 2 分钟 1 次（替换阶段 2.5 的临时版）。
- 被拦的写进 `docs/falive-lessons.md` 的闸列表，拦截日志进日报私信版。

验证：单测；重启后数一天群里 bot 消息条数。

## 阶段 6 · 指标与调参（小，持续）

- 任务上记 `receivedAt / classifiedAt / firstOutputAt`，台账事件带上。
- `lark-bot intake-stats falive [days]`：中位响应、分道占比、合并率、出口拦截数、锚点命中 / 纠正数。
- 日报私信版加一行；一周后按数据调 `quietGapMs / maxWaitMs / 15 分钟锚点窗`。

## 顺序与依赖

```
0 基线 → 1 上下文 → 2 分道去抖 → 3 发件簿 → 4 对话包+锚定 → 5 出口闸 → 6 指标
```

- 1 和 2 互不依赖，但 2 要在 1 之后验（快道没有上下文等于更快地判错）。
- 4 依赖 3（bot 要记得自己说过什么）；5 依赖 3（去重靠发件簿）。
- 每阶段一次 `lark-bot restart`，先观察一天再进下一阶段；回放集每阶段都跑。

## 风险与兜底

- 快道误判变多：有阶段 1 的上下文和阶段 4 的锚点兜；medium 仍走疑似私信，不会直接动手。
- 锚点锚错：窗口只有 15 分钟、只对短指代句生效、收到里点明接的是哪条；对方说「不是这条」走现有控制通道改锚。
- 出口闸拦掉该发的：拦截全部落日志 + 日报可见；只拦同主题同阶段的重复，不拦不同阶段。
- 提示词预算：阶段 1 加发送人块时同步压规则；`lark-prompt-budget` 作为闸。
