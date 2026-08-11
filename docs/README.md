# Lark Bot 子系统文档

> Lark 自动修 bug 常驻服务（网关 / worker / bug 表 / 调度）的**运维手册**，按需查阅。
> 它是 `common/lark-bot/` 服务本体的配套文档，不是编码规则，因此不参与规则指纹链（见 `rule-release.mjs` 的 `isLarkPlumbing`）。
> 主动发阶段通知的 webhook 规则见 [../../rules/collaboration-and-notifications.md](../../rules/collaboration-and-notifications.md)、[../../rules/lark-active-notification.md](../../rules/lark-active-notification.md)。

群内 @ 应用（或 @ 配置的项目负责人）触发开发任务的完整链路，拆为三份主题文档：

| 文档 | 内容 |
|------|------|
| [gateway-and-worker.md](./gateway-and-worker.md) | 基础链路、Bot Gateway 要求、命令类型、Job 字段、Worker 执行规则、项目级配置要求 |
| [task-boundaries-and-reply.md](./task-boundaries-and-reply.md) | Task 生命周期、解析规则、自动执行 / 必须确认边界、完成后汇报、回复策略、阻塞超时 |
| [runtime-and-scheduling.md](./runtime-and-scheduling.md) | 当前实现（lark-cli 长连接）、bug 表跨项目路由与按需轮询、Worker 按 worktree 并行调度 |
