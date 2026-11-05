# Lark Bot 子系统文档

> Lark 自动修 bug 常驻服务（网关 / worker / bug 表 / 调度）的**运维手册**，按需查阅。
> 它是 lark-bot 仓库（`/Users/aven/github/lark-bot`，仓库说明见 [../README.md](../README.md)）的配套文档，不是编码规则。
> 2026-10-11 起从 docs_tdd `common/lark-bot/` 带历史拆出为独立仓库；主动发阶段通知的 webhook 规则原在 docs_tdd `common/rules/collaboration-and-notifications.md`、`common/rules/lark-active-notification.md`（随 docs_tdd 冻结，未复制进本仓）。

文档按用途分四个子目录（文件名不变，2026-11-05 起）：

| 目录 | 放什么 |
|------|--------|
| [guide/](./guide/) | 运维手册：架构、链路、边界与回复策略、运行与调度、变异测试——长期有效，按需查 |
| [plan/](./plan/) | 方案与待办：升级方案、待拍板 / 已定稿的分批计划、下线待办 |
| [replay/](./replay/) | falive 实战回放（11-03 → 11-05，已结项）：方案、执行记录、交接 |
| [notes/](./notes/) | 台账与分析：移植台账、自修教训台账、评分口径、外部文章对照 |

## guide/ 运维手册

群内 @ 应用（或 @ 配置的项目负责人）触发开发任务的完整链路，拆为一份入门介绍 + 三份主题文档：

| 文档 | 内容 |
|------|------|
| [overview-workflow.md](./guide/overview-workflow.md) | **入门**：Lark-bot 接入工作流——是什么、架构、一条消息的旅程、信任模型、配置运维 |
| [gateway-and-worker.md](./guide/gateway-and-worker.md) | lark-cli 长连接接入、命令与 Job、项目 scope 文档注入、执行器与审计 |
| [task-boundaries-and-reply.md](./guide/task-boundaries-and-reply.md) | 生命周期、话题文字/图片上下文、自动执行 / 确认边界、Figma 预取、**任务控制通道**（回复卡片=结单/重开/续跑/查状态/确认，绝不新建任务）与回复策略；§7 收信与分类（并入 / 延续口径、负责人私信主通道） |
| [runtime-and-scheduling.md](./guide/runtime-and-scheduling.md) | 长连接健壮性、规则链告警、附件保留期、bug 表项目群路由与按 worktree 并行调度 |
| [mutation-testing.md](./guide/mutation-testing.md) | 变异测试：把代码故意改坏看测试能不能发现；`scripts/mutate.mjs` 的用法与存活处理 |

## plan/ 方案与待办

| 文档 | 内容 |
|------|------|
| [plan-iteration-2026-11-05.md](./plan/plan-iteration-2026-11-05.md) | **方案（11-05 定稿）：上线后实战迭代**——不再离线回放，改用线上指标 + aven 纠错驱动；线上验收线、现状核对、批 1 衡量与纠错入口 / 批 2 准 / 批 3 省 / 批 4 数字分身 / 批 5 收尾，八项拍板结果 |
| [upgrade-plan-context-layers-2026-11-01.md](./plan/upgrade-plan-context-layers-2026-11-01.md) | **上下文分层升级（11-01）**：宿主隔离（不吃个人设置 / 不连账号 MCP / 硬拦 commit·push）、驾驶规则进系统层、AGENTS.md 遮蔽补救、PRD 缓存标龄、截图先看、度量（`scripts/lark-metrics.mjs`）、提示回放（`scripts/lark-replay-prompts.mjs`）、体检执行层；含真实案例回放结果；§6 记 11-03 回放修复批新规则放在哪一层 |
| [plan-bug-workflow-2026-11-01.md](./plan/plan-bug-workflow-2026-11-01.md) | **方案（待拍板）：bug 工作流整合**——读新 bug 通知 + 15 分钟对账替代整表轮询、按项目号开关测试、断点续读、项目群按群 id 绑定、一条 bug 一个任务、分支策略 / 领单与修改范围 / 回写口径按仓库配置；分 5 批 |
| [plan-mail-approval-2026-11-02.md](./plan/plan-mail-approval-2026-11-02.md) | **方案稿：自动审批邮件**——bot 替领导处理审批邮件，重要 / 敏感的私信确认，其余自动回「进行」 |
| [todo-falive-offline.md](./plan/todo-falive-offline.md) | **待办：falive bot 下线**——停服务不删目录，`~/github/lark-bot-falive` 冻结成只读存档；它的审计是 lark-bot 回放 / 度量的样本，怎么用、下线清单、什么时候才能删 |

## replay/ falive 实战回放（已结项）

| 文档 | 内容 |
|------|------|
| [falive-replay-plan-2026-11-03.md](./replay/falive-replay-plan-2026-11-03.md) | **falive 实战数据回放（11-03）**：拿 falive bot 10-20 → 11-02 的真实数据在 lark-bot 现在的代码上先跑基线、再修、再跑（`scripts/sim/`）；这批修复的场景出处（「11-03 falive 回放」「静态 review Rn」）都在这里 |
| [falive-replay-design-v2.md](./replay/falive-replay-design-v2.md) | 回放方案 v2（11-04 定稿）：285 个 case 读全上下文实跑、逐条和 falive 比；§6 验收标准、§7 出网范围与改码边界 |
| [handoff-falive-replay-2026-11-04.md](./replay/handoff-falive-replay-2026-11-04.md) | 交接说明（11-05 已结束） |

## notes/ 台账与分析

| 文档 | 内容 |
|------|------|
| [port-from-falive-2026-10-24.md](./notes/port-from-falive-2026-10-24.md) | **从 falive 实践移植回来的通用能力**：自纠偏 / 续会话 / 租约心跳 / 独立终检 / 开盖补拉等，每项附来源教训、配置键与真机验法；以及刻意没搬的 |
| [self-fix-log.md](./notes/self-fix-log.md) | 自修工单教训台账：bot 自修好一个自身缺陷就在表末追加一行（自修工单按 `lib/lark-self-fix-run.mjs` 的 `SELF_FIX_LESSONS_DOC` 写这里） |
| [mail-ol-scoring-2026-11-02.md](./notes/mail-ol-scoring-2026-11-02.md) | OL 上线申请邮件规范度评分口径（`lib/lark-mail-ol-score.mjs`）与样本分析 |
| [agent-context-practices-2026-11-01.md](./notes/agent-context-practices-2026-11-01.md) | 对照《Claude Code 第二阶段 8 个卡点》的六组建议（上一份的来源分析） |
