# Lark Bot 子系统文档

> Lark 自动修 bug 常驻服务（网关 / worker / bug 表 / 调度）的**运维手册**，按需查阅。
> 它是 `common/lark-bot/` 服务本体的配套文档，不是编码规则，因此不参与规则指纹链（见 `rule-release.mjs` 的 `isLarkPlumbing`）。
> 主动发阶段通知的 webhook 规则见 [../../rules/collaboration-and-notifications.md](../../rules/collaboration-and-notifications.md)、[../../rules/lark-active-notification.md](../../rules/lark-active-notification.md)。

群内 @ 应用（或 @ 配置的项目负责人）触发开发任务的完整链路，拆为一份入门介绍 + 三份主题文档：

| 文档 | 内容 |
|------|------|
| [overview-workflow.md](./overview-workflow.md) | **入门**：Lark-bot 接入工作流——是什么、架构、一条消息的旅程、信任模型、配置运维 |
| [gateway-and-worker.md](./gateway-and-worker.md) | lark-cli 长连接接入、命令与 Job、项目 scope 文档注入、执行器与审计 |
| [task-boundaries-and-reply.md](./task-boundaries-and-reply.md) | 生命周期、话题文字/图片上下文、自动执行 / 确认边界、Figma 预取、**任务控制通道**（回复卡片=结单/重开/续跑/查状态/确认，绝不新建任务）与回复策略 |
| [runtime-and-scheduling.md](./runtime-and-scheduling.md) | 长连接健壮性、规则链告警、附件保留期、bug 表项目群路由与按 worktree 并行调度 |
