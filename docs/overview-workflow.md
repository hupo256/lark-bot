# Lark-bot 接入工作流

> Lark Bot 子系统文档之一，索引见 [README.md](./README.md)。
> 本文是**入门介绍**：这个系统是什么、怎么跑起来的、一条群消息如何变成一次代码修复。深入细节请按 README 路由到三份专题文档。

## 1. 这是什么

lark-bot 是跑在**本机**的一套常驻服务：群里 @ 一下机器人（或在 bug 多维表格里派一条记录），它就自动领取任务、调 AI CLI（Claude / Codex / Pi / Cursor）在 git worktree 里修代码、跑校验、本地提交，然后把结果卡片发回群里。

它是**机器级全局单例**（一个 gateway + 一个 worker + 按需的 poller），代码集中在 `common/lark-bot/`，由 macOS launchd 托管，不依赖公网 tunnel。

## 2. 整体架构

```text
┌─ Lark 侧 ──────────────────────────────┐
│ 群消息 @bot / @负责人                    │
│ bug 多维表格（负责人=我 且 待处理/验退）    │
└──────┬───────────────────┬─────────────┘
       │ 长连接事件          │ 定时轮询
       ▼                   ▼
┌─ lark-gateway.mjs ──┐  ┌─ lark-bugtable-poller.mjs ─┐
│ lark-cli event       │  │ base +record-list → 投递   │
│ consume 收事件        │◄─┤ POST /lark/tasks           │
│ 白名单/幂等/入队       │  │ done 后回写表格状态          │
│ HTTP 任务队列 :3005   │  └────────────────────────────┘
│ 发回执卡片/通知        │
└──────┬──────────────┘
       │ claim / status 回写（本地 HTTP + 共享密钥）
       ▼
┌─ lark-worker.mjs ───────────────────────┐
│ 按 worktree 并行调度（同 worktree 串行）    │
│ → spawn AI CLI 执行                     │
│ → 规范闸 / 终检 / 可信度交叉校验            │
│ → git 本地 commit（不 push、不开 PR）       │
└─────────────────────────────────────────┘
```

三个进程，三种来源，一条统一链路：

| 进程 | 角色 | 常驻方式 |
|------|------|----------|
| `lark-gateway.mjs` | 事件接入 + 任务队列 + 群通知 | launchd `KeepAlive` |
| `lark-worker.mjs` | 领任务、跑 AI、提交、回写 | launchd `KeepAlive` |
| `lark-bugtable-poller.mjs` | bug 表 → 投递任务 → 回写状态 | launchd，按需开关、空闲自动收工 |

## 3. 一条消息的旅程

```text
群里 @Codex 修复：/xxx 页面 light 模式背景色不对
  ↓ ① lark-cli 长连接投递 im.message.receive_v1 事件
  ↓ ② Gateway：白名单校验（fail-closed）→ message_id 幂等 → 解析命令类型/项目号
  ↓ ③ 合并话题上下文 + 下载图片附件 → 落盘为 task（文件队列）
  ↓ ④ 立即回群「已收到」排队卡
  ↓ ⑤ Worker 按 workContext 领取（同 worktree 串行，不同并行，上限 3）
  ↓ ⑥ 准备/复用 worktree（有人类 WIP 则改路由到隔离 hotfix 分支）
  ↓ ⑦ 注入规则上下文 + 项目文档 → spawn AI CLI 执行（默认 30min 硬超时）
  ↓ ⑧ Worker 亲自跑终检：git diff --check + 触达文件 Biome + done 可信度评估
  ↓ ⑨ 通过 → 本地 commit（带 lark-task: <id> trailer）；不通过 → failed
  ↓ ⑩ 回写 Gateway → 发结果卡（绿完成 / 红失败 / 橙待确认 / 灰无需改动）
  ↓ ⑪ bug 表来源额外回写记录状态（回写成功才落 done）
```

关键边界：**bot 只本地 commit，从不 push、不开 PR、不合并**——产出的是「候选修复」，留人工 review；正式交付仍走项目级 v3.3 verify。

## 4. 信任与安全模型（为什么是这样做）

- **fail-closed 白名单**：信任边界是白名单群（推荐 `allowedChatIds:"auto"` = bot 所在群动态成员制）；没配任何白名单就拒绝所有事件。`@所有人`/`@负责人` 触发先经只读 AI 意图分类，中高置信度才入队。
- **本地 API 鉴权**：Gateway 写接口必须带 `LARK_GATEWAY_SECRET`（0600 文件注入，不落 plist）；缺失即拒绝启动——「只绑 127.0.0.1」不构成边界。
- **身份复用 lark-cli**：收发消息、读话题、下图、读写多维表格全走 lark-cli 已登录的 bot 身份（keychain），配置里不放 appSecret。
- **人类 WIP 不可侵犯**：目标 worktree 已有未提交改动时，任务改道隔离 hotfix worktree；命中人类分支时只 scoped 提交本任务实测文件。
- **无人值守防线**：任务租约回收孤儿（40min）+ claim epoch fencing（迟到回写 409）+ 死信 cap + AI 超时 < 租约的启动断言。
- **不谎报完成**：done 但零 diff、修复类只动测试文件、L2 契约改动缺 type-check 证据 → 一律降级人工复核，不发绿卡。

## 5. 配置与运维

- **单例配置**（gitignore）：`runtime/lark-bot.local.json` —— 项目、白名单、执行器与模型、bug 表字段映射。
- **执行器切换**：任务 `[claude]`/`[codex]`/`[pi]`/`[cursor]` 标签 > 配置 `aiExecutor` > 内置默认 `pi`；入队时锁定，卡片上可见。
- **运维入口**：`lark-bot {start|stop|restart|status|logs|poll-on|poll-off|failed|retry|clean}`（`scripts/lark-bot`，`~/.local/bin/lark-bot` 为薄入口）。
- **观测**：`lark-bot status` 汇总 gateway/worker/poller 健康、执行器与模型 readiness、任务积压、挂起盘点、代码/配置 stale。
- **审计**：`<PROJECT>/agent/lark-audits/<taskId>.json/.log`，标记 `assuranceMode=lark-lightweight`、`deliveryAuthority=false`。

## 6. 进一步阅读

| 想了解 | 看 |
|--------|-----|
| 入队契约、命令类型、执行器细节 | [gateway-and-worker.md](./gateway-and-worker.md) |
| 生命周期、确认边界、回复卡片控制通道 | [task-boundaries-and-reply.md](./task-boundaries-and-reply.md) |
| 长连接健壮性、bug 表路由、并行调度 | [runtime-and-scheduling.md](./runtime-and-scheduling.md) |
</content>
