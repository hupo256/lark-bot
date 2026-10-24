# 从 falive 实践移植回来的通用能力（2026-10-24）

> 背景：falive-bot（`~/github/lark-bot-falive`，分支 `feature/falive-repo-profile`）是 lark-bot 为临时项目 falive 跑的一条独立线，
> 两周里沉淀了 87 条教训（`docs/falive-lessons.md`）。falive 月底上线后那套会关停，lark-bot 还是主力：响应群里 @ 的需求、修 bug 表里分到自己头上的 bug。
> aven 2026-10-24 定：**不把 bot 做重**，只把通用的搬回来；falive 专属的（外部群轮询 / webhook 出口 / 台账 / 日报 / 清扫 / 部署盯梢 / 归属表 / 自修工单）一律不搬。
> 接下来几天 falive 还会沉淀新东西，到时再 check 一次、再搬一批——本文是台账，下次按同一格式续。

## 搬了什么

| # | 能力 | 来源（falive 教训 / 批次） | 落在哪 | 配置 | 怎么验（真机） |
|---|---|---|---|---|---|
| 1 | Claude 无头任务摘掉会断会话的工具（ScheduleWakeup / Cron* / Workflow / RemoteTrigger / Enter·ExitWorktree），结果文件指令要求全程同步、跑不完写 blocked | #31（日报发成了却报「没做成」） | `lib/lark-ai-executor.mjs` `CLAUDE_HEADLESS_DISALLOWED_TOOLS`；`lib/lark-ai-result.mjs` | 无 | 审计 `.log` 里 claude 命令行含 `--disallowedTools` |
| 2 | 结果文件缺失 / 不合法 → `--resume` 续同一会话只补写 result.json（一次、5 分钟） | #31 | `execAiExecutor.recoverResultFile` | `LARK_CLAUDE_RESULT_RECOVERY_TIMEOUT_MS` | 审计里出现 `[self-heal] … 补写成功` 而不是直接 failed |
| 3 | 实施续分析阶段的同一会话（增量提示，续不上回退完整提示） | 升级计划第 1 批 | `lib/lark-worker-run.mjs`、`buildTaskPrompt({ followUp })`；分析命令不再带 `--no-session-persistence` | 无（分析与实施模型不同时不续） | 审计 `implementation.resumedSession` 非空，第二趟耗时明显下降 |
| 4 | 只读任务（状态查询）拿只读工具面，不带 `--dangerously-skip-permissions` | 第 0 批 #1（只读任务跑在人的主仓里） | `buildAiExecutorCommand` 任务模式 `readOnly` 分支 | 无 | 状态查询任务的审计命令行无 `--dangerously-skip-permissions`，主仓 `git status` 不变 |
| 5 | AI 子进程进程组 kill（detached + `kill(-pid)`） | 第 0 批 #4 | `execAiExecutor.killTree` | 无 | 杀 worker 后 `pgrep -f "tsc\|claude"` 无存活孙进程 |
| 6 | 租约心跳 + 单一截止时间（每 leaseMs/3 续租，`taskBudgetMs` 到点统一中断，退出中断不写 failed） | 第 0 批 #3（长任务被当孤儿重跑） | `lib/lark-task-runner-support.mjs`；`POST /lark/tasks/:id/heartbeat`、`GET /lark/tasks/:id`；`store.touchLease` | `LARK_TASK_BUDGET_MS`（默认 150min） | 长任务审计 `leaseTouchedAt` 在推进；`lark-bot status` 不再出现 40 分钟后被重投 |
| 7 | worker 不裸崩：`listClaimable` 失败只退避、`unhandledRejection` 记日志、`runTask` 外层 catch；版本落后告警去重 | 第 0 批 #5 | `lark-worker.mjs` | 无 | gateway 重启 1s 内 worker 不退出 |
| 8 | gateway 坏 body / 超限回 400（原来当 `{}`，/intake 会把任务静默落 ignored） | 第 0 批 #7 | `lib/lark-http.mjs` `readJsonBody` | 无 | `curl -d 'x' …/status` 得 400 |
| 9 | 独立终检：改了 `.ts/.tsx` 跑 typecheck、改到的 `*.test.*` 用配置命令跑，AI 自报的 checks 不算数；只改 markdown 不做 `diff --check` | #8（改了 schema 类型错也判完成） | `lib/lark-final-verification.mjs` `finalChecks` | `finalChecks: { typecheck: ["node_modules/.bin/tsc","--noEmit","-p","apps/web"], tests: ["node_modules/.bin/vitest","run"], timeoutMs: 600000 }`（不配 = 行为不变） | 完成卡的终检行出现 `typecheck ✓` |
| 10 | bot 的 worktree 与主仓共用 Claude 项目记忆（软链 `~/.claude/projects/<worktree>/memory` → 主仓的） | #18 | `ensureSharedClaudeMemory`（task-runner 跑 AI 前） | `claudeMemoryDir`（缺省按 consumerRoot 推导，目录不存在就不做） | `ls -la ~/.claude/projects/-Users-aven-github-PR-xxxx/memory` 是软链 |
| 11 | 文档 / Figma 链接遇 `[ ] ( ) \` 即止、末尾编码括号剥掉；wiki 里的多维表格（bug 表）链接不按文档读、不拦；半截链接明说「链接不完整」 | #21、Bug-4927 | `lib/lark-doc.mjs`、`lib/lark-figma.mjs` | 无 | 卡片里 `[URL](URL)` 形式的 PRD 链接能读；带 bug 表链接的任务不再停在实施前 |
| 12 | 图片附件按文件头改真实扩展名（`.img` 会被 Claude Read 当文本） | #27 | `lib/lark-cli.mjs` `imageExtFromBytes` | 无 | `runtime/lark-attachments/<PR>/<msg>/1-xxx.jpg` |
| 13 | git 一律 `core.quotepath=off`（中文路径不再被转义成另一个文件） | 7f3e52f | `lib/lark-worker-git.mjs`、终检 | 无 | 改中文路径文件时范围核对不误判 |
| 14 | 开盖不空闲睡眠（`caffeinate -i -w <gateway pid>`，合盖照常睡） | 10-17 lid 系列 | `lib/lark-keep-awake.mjs`、`lib/lark-power.mjs` | `LARK_KEEP_AWAKE=0` 关 | `pmset -g assertions` 有 gateway 的 PreventUserIdleSystemSleep |
| 15 | 开盖补拉：睡过 / 合过盖 → 开盖后用 bot 身份把 bot 所在群睡眠期间的消息拉一遍送进同一条 ingest（飞书事件重推只覆盖约 7 小时的几个时间点） | 10-17 b259144 | `lib/lark-wake-catchup.mjs`（`listChatMessages` / `listBotChatIds` 在 lark-cli） | `LARK_WAKE_CATCHUP=0` 关 | 合盖一夜后 gateway.log 出现「开盖补拉群消息：N 个群…补送 M 条」。**前提**：应用机器人有读群消息权限；没有会连续 3 次失败后放弃并告警一次 |
| 16 | `lark-bot stop` 先停 worker 等它交还任务再停 gateway；新增 `lark-bot close <id>` / `lark-bot resume <id> "<补充>"` | #7、6502824 | `scripts/lark-bot`；`POST /lark/tasks/:id/close`、`/resume` | 无 | `lark-bot stop` 后任务停在 queued 而不是 running |
| 17 | 失败归类只看报错固定前缀（模型输出尾部的 inputTokens / git diff 不再把归类带偏） | 10-20 review A7 | `lib/lark-worker-results.mjs` `failureHead` | 无 | 失败卡「失败类型」不再被尾巴带成 permission |
| 18 | 规则去重：Claude Code 自动加载的 CLAUDE.md / `~/.ai-rules/AGENT.md` 章节不再注入提示（审计仍记完整 sources） | 第 1 批 | `lib/lark-rule-context.mjs` `stripAutoLoadedRules` | 无 | 审计 `rules.omittedAutoLoaded` 非空 |
| 19 | 代码版本观测先比 mtime 再算哈希；`runtime/` 下所有子目录不算源码 | 第 1 批、950267d | `lib/lark-runtime-version.mjs` | 无 | health 不再因运行态文件写入误报 codeStale |
| 20 | bug 表 poller 状态文件原子写 | 第 0 批 #13 | `lib/lark-fs.mjs` | 无 | — |
| 21 | 测试三层：`scripts/test-affected.mjs`（按 import 反查相关测试）/ `scripts/test-all.mjs`（全量 + 18 秒预算） | 10-23 | `scripts/` | 无 | `node scripts/test-affected.mjs --list` |
| 22 | 审计日志 0600 | 3837f56 | `lib/lark-ai-executor.mjs` | 无 | — |

可选模型键：`claudeModel` / `claudeEffort`（实施）、`claudeAnalysisModel` / `claudeAnalysisEffort`（只读分析 / 分诊）。不配时和以前一样由 `claude.env` 的 `ANTHROPIC_MODEL` 或账号默认决定；配了启动探针会真探那个模型。

## 刻意没搬的（falive 专属，或会把 bot 做重）

- 外部群链路：用户身份轮询器、自定义机器人 webhook 出口、负责人控制台群、repo-only 实例模式。
- 对接台账 / 回复义务 / 任务契约 / 结构化群回复渲染：围绕外部群「人话回复」设计，fameex 内部群用卡片 + 回复卡片控制通道，口径不同。
- 日报 / 清扫 / 部署盯梢 / 功能总表归属判定 / 对接文档入库 / 集成分支合回：falive 项目管理用。
- 自愈环 2（失败指纹 → 自动重排队 → 自修工单）、体检（doctor）、排空重启、分支回收：每个都要再配一个通知通道和状态目录，收益对 fameex 的用量不成比例；真要就单独评估。
- 变更流长轮询 + 核验闸注册表：结构性重构，fameex 的并发量用不上。
- 多仓 profile：fameex 仍是单仓；下一个项目真来了再把它接成 profile。
- 挂起现场自动 rebase 到新基线：#51 明确说过它波及过 fameex 的 hotfix 现场，不要。

## 怎么上线

1. 代码在分支 `lark/port-falive-generic`（基于 `fameex-stable`，worktree `~/github/lark-bot-port`），全量单测 536 条通过。
2. 合进运行分支：`git -C ~/github/lark-bot merge --ff-only lark/port-falive-generic`。
3. `lark-bot restart`，看 `lark-bot status` 的 `codeStale` 消失、worker 日志出现 `keep-awake` 一行。
4. 想开独立终检就在 `runtime/lark-bot.local.json` 加 `finalChecks`；想钉模型加 `claudeModel`。

## 下一次移植时看什么

falive 那边 `docs/falive-lessons.md` 从 #87 往后的新条目，以及 `git log 659f3d6..` 里标 `fix(worker)` / `fix(executor)` / `refactor(batch-*)` 且不含 `repo-delivery` / `daily` / `ledger` / `intake` 字样的提交。通用的标准还是一条：fameex 群里 @bot 修 bug 这条路径用得上、且不需要新配通知通道。
