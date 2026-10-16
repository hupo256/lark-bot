# lark-bot 自愈 / 纠偏策略（2026-10-16 起）

> 起因：10-15 21:24 aven 在群里「今天日报发一下 @Aven.Bot」，bot 回「没做成：Claude 未返回合法结构化结果 ENOENT result.json」。
> 实际上日报已经发到群里了。bot 自己能看见的错（审计里有完整事件流、发件簿里有发群记录），却只会原样贴错误让人去查。
> aven 的要求：这种自己能识别到的 bug、运行中的异常，要能自己解决、自己纠偏。本文是落地方案与进度。
> 配套：出错台账 [falive-lessons.md](./falive-lessons.md)（#31 是本案）；整改清单 [falive-remediation-plan.md](./falive-remediation-plan.md)。

## 0. 本案复盘（当模板用）

| 栏 | 内容 |
|---|---|
| 现象 | 群里回「没做成」+ ENOENT；日报其实 21:24 已发（`runtime/lark-outbox/oc_c2a6….jsonl` phase=daily_report，`state.json` falive=2026-10-15） |
| 根因 | 模型发现 `lark-bot daily-report` 要跑 20+ 分钟、超过 Bash 工具单次上限，就把命令放后台，再调 `ScheduleWakeup` 想「等它」。无头 `-p` 里这个工具一调用本轮就结束、进程退出，result.json 没写。worker 只认结果文件，失败卡不看旁证 |
| 为什么没自愈 | ① 工具箱里本来就不该有 ScheduleWakeup / Cron 这类「交互式会话才合理」的工具；② 结果文件缺失是最常见的失败形态之一，却直接判 failed，没有「续会话补写」这一步；③ 失败卡不附旁证，人看不出是真失败还是假失败 |
| 已落地（10-16） | 机制：日报类指令不喂模型，直接走日报链路（ff339c7）。闸：`--disallowedTools` 摘掉 8 个工具；结果文件缺失 / 不合法 → `--resume` 续会话只补写文件（一次、5 分钟）。规则：结果文件指令加「全程同步、不放后台、跑不完写 blocked + 需要 worker 直接执行 <命令>」 |
| 怎么验 | `node --test __tests__/lark-ai-executor.test.mjs`（假子进程首轮不写 → resume 补写）；线上看审计 `[self-heal]` 行 |

## 1. 原则：三环，机械优先

```text
环 1 执行中自纠   同一趟工单内，秒到分钟级，不打扰人          —— 退避重试 / 补写 / 降级
环 2 失败后自诊   工单失败后，指纹分类 → 已知类按剧本 → 未知类开自修工单  —— 可能改 lark-bot 自己的代码
环 3 运行态体检   定时巡检进程 / 状态 / 台账，先修能修的，再汇报        —— 不等出事
```

每一环都遵守：
- **机制 > 闸 > 规则**（同 lessons 的防膨胀原则）：先问能不能让这类错在结构上不可能发生，再写机械检查，最后才写提示词。
- **有上限**：每种自纠只试一次或有明确次数 / 预算，不许无限循环烧模型。
- **留痕**：审计日志打 `[self-heal]`，失败指纹记台账，改了代码必须补 lessons 一行。
- **三条红线不动**：bot 不自动 restart 自己（除非 §4 的空闲开关打开且条件全满足）、不自动 push、不因自愈多发群消息。自愈的结果只进私信 / 日报私信版。
- **假失败比真失败更危险**：报「没做成」之前先看旁证（发件簿、worktree diff、提交），能证明做成了就不说没做成。

## 2. 环 1：执行中自纠

| # | 失败形态 | 处理 | 状态 | 落点 |
|---|---|---|---|---|
| 1.1 | AI API 瞬时错误（断连 / 限流 / 5xx） | 退避重试，最多 3 次 | 已有 | `execAiExecutor` `isTransientAiError` |
| 1.2 | 外部命令卡死（10 分钟无事件） | idle 超时杀掉并转瞬时重试 | 已有 | `claudeIdleTimeoutMs` |
| 1.3 | 结果文件缺失 / 不合法 | 取 stream 的 session_id，`--resume` 续会话只补写 result.json；一次、5 分钟；仍失败才上抛 | **已落地 10-16** | `recoverResultFile`、`buildClaudeResultRecoveryInstruction` |
| 1.4 | 模型调用会断会话的工具 | `--disallowedTools` 摘掉 ScheduleWakeup / Cron* / Workflow / RemoteTrigger / Enter·ExitWorktree | **已落地 10-16** | `CLAUDE_HEADLESS_DISALLOWED_TOOLS` |
| 1.5 | 命令超过工具单次上限跑不完 | 规则：不放后台硬等，写 blocked + `需要 worker 直接执行 <命令>`；**待做**：worker 识别这类 blocker，命令在 profile 白名单（`lark-bot daily-report` / `intake-stats` / 复测探针）就自己跑、把输出回填结果，不再二次喂模型 | 规则已落地，闸待做 | `lark-task-runner` 收尾处新增 `runWorkerDirectives` |
| 1.6 | 假失败（活干成了却报失败） | 失败卡发出前查旁证：发件簿里同 taskId 已发出的 done / daily_report 记录、worktree diff、本地提交。有旁证 → 降级为 `done_with_warnings`，warnings 写「结果文件缺失，按旁证判完成」；无旁证 → 失败卡附「旁证：无」 | 待做 | `lark-task-runner` catch 分支 + `lark-outbox.findByTask` |

验收：1.5 / 1.6 各补单测；线上用一次真实「日报发一下」和一次故意不写结果的工单（`LARK_FAKE_NO_RESULT=1`）验。

## 3. 环 2：失败后自诊

### 3.1 失败指纹（确定性，不用模型）

新文件 `lib/lark-failure-fingerprint.mjs`：把 error 文本去掉路径 / id / 时间后归一成指纹，并分到固定类：

| 类 | 识别 | 剧本（确定性） |
|---|---|---|
| `result_missing` | 未返回合法结构化结果 | 环 1.3 已补写过；仍失败 → 重排队一次，提示里加「上次没写结果文件，这次先写再做别的」 |
| `tool_missing` | `spawnSync <cli> ENOENT`（10-14 cursor-agent / pi 各连报 12 次） | 该执行器标为不可用 1 小时，回落 claude；私信一条 |
| `transient_api` | 环 1.1 三次都没过 | 5 分钟后重排队一次 |
| `timeout` / `idle` | exec timed out / no events | 不重跑；私信附审计里最后一个工具调用（人一眼能看出卡在哪） |
| `git` | 冲突 / worktree 脏 / 分支不存在 | 合一次 `lark/falive-integration` 后重排队一次；再失败私信 |
| `quality_gate` | 规范硬闸 / tsc / 测试红 | 不重跑（已经是定向纠正后的结果），私信附清单 |
| `unknown` | 其余 | 进 3.2 |

落盘 `runtime/lark-failures/<repo>.jsonl`：taskId、指纹、类、时间、是否自愈成功。同一指纹 7 天内第 2 次出现，不管哪一类都进 3.2（对应 lessons 的「只有规则没有闸的再出一次就补闸」，但变成机械触发）。

### 3.2 自修工单（会改 lark-bot 自己的代码）

触发：`unknown`，或同指纹 7 天内重复，或环 1 自纠失败。预算：每天最多 3 个；同指纹 7 天 1 个。

流程（仓库 = `~/github/lark-bot`，走现有多仓 profile 机制，新增 `lark-bot` 自己的 profile）：
1. **分诊**（只读分析模式，Opus 5.5 high）：输入 = 失败工单的审计 `e*.json` + `e*.log` 尾部 + worker.log 该任务前后 200 行 + lessons 表 + 本文。输出结构化：`rootCauseLayer: harness | prompt | env | model | external`、现象 / 根因一句话、建议落点（机制 / 闸 / 规则）、改哪些文件、怎么验、`confidence`。
2. **实施**（仅 `rootCauseLayer ∈ {harness, prompt}` 且 confidence=high）：临时 worktree、分支 `lark/self-fix-<指纹>`；改代码 + 补单测 + lessons 追加一行；跑 `node --test '__tests__/*.test.mjs'` 必须全绿；本地提交，不 push。
3. **交付**：只私信 aven 一条人话：现象 / 根因 / 改了什么 / 测试结果 / 「回『上线』我就 restart」。`env` / `external` 层只报不改；`model` 层（模型瞎编、判断错）落成规则候选写进 lessons「只有规则」节，不自动改提示词。
4. **上线**：aven 回「上线」→ 合到 `feature/falive-repo-profile`（或当前工作分支）→ `lark-bot restart`。bot 不自己 restart。

护栏：自修工单只能改 `lib/ scripts/ __tests__/ docs/ rules/`，不碰 `runtime/`（配置、凭据、状态）、不碰 falive-react 业务代码；测试不绿不交付；一个自修工单改坏了别的测试就整单作废。

### 3.3 本案走这套流程会怎样

10-15 21:09 失败 → 指纹 `result_missing` → 环 1.3 补写（session 还在，模型知道后台任务已起）→ 模型按补写指令如实写 `blocked：需要 worker 直接执行 lark-bot daily-report falive` → 环 1.5 worker 看到白名单命令自己跑（或发现 21:24 已发、发件簿有记录）→ 回 aven「日报已发」。全程不需要人看错误。

## 4. 环 3：运行态体检

新命令 `lark-bot doctor [repo]` + worker 每小时一次同样的检查（结果只私信，走出口闸去重，同一异常 24 小时只报一次）：

| 检查 | 现在 | 自动动作 |
|---|---|---|
| 运行中代码 / 配置落后磁盘 | 每次工单后警告一行，没人看（10-15 连打 8 条） | 开关 `selfHeal.autoRestartWhenIdle`（默认关）：0 在飞、磁盘版本测试全绿、worktree 干净、08:00–23:00 → 自动 restart 并私信一句；开关关着就只在日报私信版加一行 |
| 执行器探针失败 | 启动时探一次 | 每小时探；失败 → 回落备用执行器 + 私信 |
| 日报：到点没发 / 状态与发件簿不一致 | 10-15 已改为到点后补发、失败隔 10 分钟最多 3 次 | 体检再核一次「state.json 当天 = 发件簿当天有 daily_report」，不一致私信 |
| 挂起任务：waiting_confirmation 超 24h、`已催 99/3 轮` 这种显示异常 | status 里能看到，没人汇总 | 日报私信版一行「挂起 N 条，最久 X 小时」；显示异常先当 lessons 候选 |
| 发件簿连续发送失败（230027 / 19002） | 已有降级 webhook | 连续 3 次同错 → 私信一次，附要发的话 |
| 轮询：连续失败 / poller stopped | 已有退避与 10 次告警 | 纳入 doctor 输出，说明 `poller` 是 fameex bug 表轮询、停着是预期 |
| 审计 / 日志体积 | 已有 log-rotate、附件保留期 | 纳入 doctor 输出 |

## 5. 交付顺序

| 批 | 内容 | 预计 | 验收 |
|---|---|---|---|
| 0 ✅ 10-16 | 环 1.3 / 1.4 + 规则 + lessons #31 | 已提交（待 restart 生效） | 640 单测全绿；下次 `[self-heal]` 行 |
| 1 | 环 1.5 worker 直接执行白名单命令；环 1.6 失败卡旁证 / 假失败降级 | 半天 | 单测 + 故意不写结果的工单 |
| 2 | 环 2 失败指纹 + 已知类剧本 + 失败台账 | 半天 | 回放 10-14 / 10-15 的 worker.log 全部失败能分到类 |
| 3 | 环 2.2 自修工单（lark-bot 自己的 profile、分诊 → 实施 → 私信等「上线」） | 1 天 | 用 lessons #21（链接正则）做一次人工注入回归：bot 能自己定位并给出改法 |
| 4 | 环 3 doctor + 每小时体检 + 日报自检行 + 空闲自动重启开关 | 半天 | `lark-bot doctor falive` 输出；故意改一行代码不重启看是否自动处理 |

## 6. 需要 aven 拍板的

1. `selfHeal.autoRestartWhenIdle` 默认开还是关（本文默认关；建议开，条件已经很保守）。
2. 自修工单的实施是否允许在 aven 不在线时直接跑（本文：允许跑，但只私信、不上线）。
3. 环 1.5 白名单命令清单（本文初稿：`lark-bot daily-report <repo>`、`lark-bot intake-stats`、profile 里的 `verify.probeCommand`）。
