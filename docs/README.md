# Lark Bot 子系统文档

> Lark 自动修 bug 常驻服务（网关 / worker / bug 表 / 调度）的**运维手册**，按需查阅。
> 它是 lark-bot 仓库（`/Users/aven/github/lark-bot`，仓库说明见 [../README.md](../README.md)）的配套文档，不是编码规则。
> 2026-10-11 起从 docs_tdd `common/lark-bot/` 带历史拆出为独立仓库；主动发阶段通知的 webhook 规则原在 docs_tdd `common/rules/collaboration-and-notifications.md`、`common/rules/lark-active-notification.md`（随 docs_tdd 冻结，未复制进本仓）。

群内 @ 应用（或 @ 配置的项目负责人）触发开发任务的完整链路，拆为一份入门介绍 + 三份主题文档：

| 文档 | 内容 |
|------|------|
| [overview-workflow.md](./overview-workflow.md) | **入门**：Lark-bot 接入工作流——是什么、架构、一条消息的旅程、信任模型、配置运维 |
| [gateway-and-worker.md](./gateway-and-worker.md) | lark-cli 长连接接入、命令与 Job、项目 scope 文档注入、执行器与审计 |
| [task-boundaries-and-reply.md](./task-boundaries-and-reply.md) | 生命周期、话题文字/图片上下文、自动执行 / 确认边界、Figma 预取、**任务控制通道**（回复卡片=结单/重开/续跑/查状态/确认，绝不新建任务）与回复策略；§7 收信与分类（并入 / 延续口径、负责人私信主通道） |
| [runtime-and-scheduling.md](./runtime-and-scheduling.md) | 长连接健壮性、规则链告警、附件保留期、bug 表项目群路由与按 worktree 并行调度 |
| [upgrade-plan-context-layers-2026-11-01.md](./upgrade-plan-context-layers-2026-11-01.md) | **上下文分层升级（11-01）**：宿主隔离（不吃个人设置 / 不连账号 MCP / 硬拦 commit·push）、驾驶规则进系统层、AGENTS.md 遮蔽补救、PRD 缓存标龄、截图先看、度量（`scripts/lark-metrics.mjs`）、提示回放（`scripts/lark-replay-prompts.mjs`）、体检执行层；含真实案例回放结果；§6 记 11-03 回放修复批新规则放在哪一层 |
| [falive-replay-plan-2026-11-03.md](./falive-replay-plan-2026-11-03.md) | **falive 实战数据回放（11-03）**：拿 falive bot 10-20 → 11-02 的真实数据在 lark-bot 现在的代码上先跑基线、再修、再跑（`scripts/sim/`）；这批修复的场景出处（「11-03 falive 回放」「静态 review Rn」）都在这里 |
| [todo-falive-offline.md](./todo-falive-offline.md) | **待办：falive bot 下线**——停服务不删目录，`~/github/lark-bot-falive` 冻结成只读存档；它的审计是 lark-bot 回放 / 度量的样本，怎么用、下线清单、什么时候才能删 |
| [plan-bug-workflow-2026-11-01.md](./plan-bug-workflow-2026-11-01.md) | **方案（待拍板）：bug 工作流整合**——读新 bug 通知 + 15 分钟对账替代整表轮询、按项目号开关测试、断点续读、项目群按群 id 绑定、一条 bug 一个任务、分支策略 / 领单与修改范围 / 回写口径按仓库配置；分 5 批 |
| [agent-context-practices-2026-11-01.md](./agent-context-practices-2026-11-01.md) | 对照《Claude Code 第二阶段 8 个卡点》的六组建议（上一份的来源分析） |
| [port-from-falive-2026-10-24.md](./port-from-falive-2026-10-24.md) | **从 falive 实践移植回来的通用能力**：自纠偏 / 续会话 / 租约心跳 / 独立终检 / 开盖补拉等，每项附来源教训、配置键与真机验法；以及刻意没搬的 |
