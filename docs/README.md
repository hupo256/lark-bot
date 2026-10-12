# Lark Bot 子系统文档

> Lark 自动修 bug 常驻服务（网关 / worker / bug 表 / 调度）的**运维手册**，按需查阅。
> 它是 lark-bot 仓库（`/Users/aven/github/lark-bot`，仓库说明见 [../README.md](../README.md)）的配套文档，不是编码规则。
> 2026-10-11 起从 docs_tdd `common/lark-bot/` 带历史拆出为独立仓库；主动发阶段通知的 webhook 规则原在 docs_tdd `common/rules/collaboration-and-notifications.md`、`common/rules/lark-active-notification.md`（随 docs_tdd 冻结，未复制进本仓）。

群内 @ 应用（或 @ 配置的项目负责人）触发开发任务的完整链路，拆为一份入门介绍 + 三份主题文档：

| 文档 | 内容 |
|------|------|
| [overview-workflow.md](./overview-workflow.md) | **入门**：Lark-bot 接入工作流——是什么、架构、一条消息的旅程、信任模型、配置运维 |
| [gateway-and-worker.md](./gateway-and-worker.md) | lark-cli 长连接接入、命令与 Job、项目 scope 文档注入、执行器与审计 |
| [task-boundaries-and-reply.md](./task-boundaries-and-reply.md) | 生命周期、话题文字/图片上下文、自动执行 / 确认边界、Figma 预取、**任务控制通道**（回复卡片=结单/重开/续跑/查状态/确认，绝不新建任务）与回复策略 |
| [falive-repo-profile.md](./falive-repo-profile.md) | **多仓 profile**：按仓库路由（根 / 基线 / 规则 / 模型 / 投递）、falive 接入决策、外部群只能 webhook + 用户身份轮询、日报 |
| [runtime-and-scheduling.md](./runtime-and-scheduling.md) | 长连接健壮性、规则链告警、附件保留期、bug 表项目群路由与按 worktree 并行调度 |
