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

## 历史数据试跑（2026-10-24）

隔离方式：沙箱 gateway / worker 跑在 3015 端口，`LARK_RUNTIME_DIR=/tmp/lark-sandbox/runtime`（生产配置副本），`LARK_CLI_BIN` 指向一个包装脚本：
读操作透传真实 lark-cli，发消息 / 回写 bug 表 / 建文档一律拦下记账，`event consume` 改成读本地事件文件。AI 真跑（claude-opus-5-5），代码在 fameex-web 的临时 worktree 里改。falive 实例全程未受影响。

输入：10 条真实历史群消息（PR-01930 / PR-02172 / PR-02273，`+messages-mget` 取原文，转成长连接事件格式注入）、1 条直接 @bot、1 条只读状态查询、1 条历史 bug 表记录（BUG-6754，带截图），外加对真实 bug 表轮询一次、对 11 个群模拟一次 3 天 / 40 天的开盖补拉。

| 结果 | 条数 | 说明 |
|---|---|---|
| 判为不用处理 | 2 | 群通知（发版通知 / bug 汇总转发），没开工 |
| 有证据地挂起要材料 | 4 | PR-01930 的 4 条：指出 56 已在 online 落码、截图里的状态码 YAPI 没登记、定位不唯一等，没硬改 |
| 完成并本地提交 | 3 | PR-02273 两条（增强体验金「使用规则」显示 --）、PR-02172 一条（首页 Google 覆盖层缺 clip-path，正好是 page-migration.md 里没勾的待办） |
| 只读回答 | 2 | 测试链接、项目进度；只读工具面只有 Read/Grep/Glob/Bash |
| 判非前端 | 1 | BUG-6754：读截图后判定是后端返回场景码，给出接口和修法 |

移植能力实测生效：实施续上分析会话（3/3，无回退）、无头任务工具面无 ScheduleWakeup / Workflow、规则去重、图片按文件头改名、坏 body 400、按 id 取 / 心跳 / 结单 / 续跑路由、bug 表回写被拦、开盖补拉 3 天 45 条 / 40 天 289 条（识别出 @bot 7 条、@你 27 条）。

试跑当场发现并修掉的问题（都已加测试）：

| # | 问题 | 修法 |
|---|---|---|
| 23 | 路径基座不认 `LARK_RUNTIME_DIR`，运行态没法和生产隔离 | `lib/lark-paths.mjs` 认这个变量；运行态在仓库外时也加进 `--add-dir` |
| 24 | 拉消息接口里 @bot 的 mention id 是应用 id（`cli_…`），开盖补拉会漏掉 @bot | 新配置键 `botAppId`，`resolveMessageTrigger` 两种 id 都认；没配启动告警 |
| 25 | AI 为跑 biome / tsc 执行 `pnpm install --frozen-lockfile`，pnpm 12 仍改 `pnpm-lock.yaml`，范围契约把 3 条实施任务里的 2 条整条拦下 | 只在 bot 自己的临时 worktree 里：没有 package.json 改动、只有锁文件改动 → 判为安装漂移，核对前还原（人的现有 worktree 不碰） |
| 26 | bug 表轮询不投影「问题截图」列，bot 看不到 QA 截图、回「请补截图」 | 轮询器投影截图列（`screenshotField`，缺省「问题截图」），gateway 入队 / 验退重开时下载最多 4 张进附件目录 |

配置发现：生产配置的 `taskMentionOpenIds` 是空数组（10-20 拆实例那天改的），群里 @你 不会触发 bot，只有 @bot 才会。试跑时补成你的 open_id 才跑出上面的结果。

## 怎么上线

1. 代码在分支 `lark/port-falive-generic`（基于 `fameex-stable`，worktree `~/github/lark-bot-port`），全量单测 540 条通过。
2. 合进运行分支：`git -C ~/github/lark-bot merge --ff-only lark/port-falive-generic`。
3. 配置 `runtime/lark-bot.local.json` 补两个键：`taskMentionOpenIds: ["<你的 open_id>"]`（@你 才会触发）、`botAppId: "cli_aabf9468b1789ed4"`（开盖补拉认 @bot）。
4. `lark-bot start`（或 `restart`），看 `lark-bot status` 的 `codeStale` 消失、worker 日志出现 `keep-awake` 一行。
5. 想开独立终检就在配置里加 `finalChecks`；想钉模型加 `claudeModel`。

## 下一次移植时看什么

falive 那边 `docs/falive-lessons.md` 从 #87 往后的新条目，以及 `git log 659f3d6..` 里标 `fix(worker)` / `fix(executor)` / `refactor(batch-*)` 且不含 `repo-delivery` / `daily` / `ledger` / `intake` 字样的提交。通用的标准还是一条：fameex 群里 @bot 修 bug 这条路径用得上、且不需要新配通知通道。

## 第二批：自愈（10-24 下午）

aven 10-24 下午定：「刻意没搬的」里的排空重启和自愈环 2 这次要搬。两件分两条分支并行做，每项有开关、默认开。来源 falive `docs/falive-self-healing.md`。

通知通道：fameex 没有控制台群，新增配置键 `notifyOpenId`（负责人 open_id，`ou_` 开头，`validateConfig` 校验；不是 `ou_` 开头拒绝启动，没配只告警），自愈消息只私信这个人（`sendChatMessage` 对 `ou_` 自动走 `--user-id`）。没配就只写 worker.log。

### 排空重启（分支 `lark/port-drain-restart`）

| # | 能力 | 来源（falive 教训 / 批次） | 落在哪 | 配置 | 怎么验（真机） |
|---|---|---|---|---|---|
| 27 | 排空重启：运行目录的代码 / 配置与进程加载的不一致 → worker 不再领新任务 → 在飞跑完、磁盘稳定 1 分钟 → 自检（代码改了跑全量单测，hermetic 环境去掉全部 `LARK_*`、5 分钟超时；配置改了做启动期同款 `validateConfig`）→ 绿：脱离进程组起 `scripts/lark-bot restart`（`LARK_BOT_ROOT` 钉成本仓）；红：不重启，私信一次失败摘要（只摘「✖ failing tests」节），同一版磁盘不再重跑，再改一版重新来。只在 launchd 托管（plist 注入 `LARK_LOG_FILE`）时开 | 自愈环 3（falive 10-16） | `lib/lark-drain-restart.mjs`；`lark-worker.mjs` 主循环每轮先 `drain.tick`、排空中不领任务；心跳带 `draining`（状态一变立即补写） | `selfHeal.drainRestart=false` 或 `LARK_DRAIN_RESTART=0` 关；`selfHeal.settleMs` 调稳定等待（默认 60000）；`notifyOpenId` | 往 `~/github/lark-bot` 合一个小改动：worker.log 出现「排空重启：磁盘代码已更新…不再领新任务」→「自检绿…已发起 lark-bot restart」，`lark-bot status` 排空期间 worker 行带「排空中（在飞 N 个…）」，几分钟后 `codeStale` 消失 |
| 28 | 只改配置也有「磁盘改动时间」（原来只算源码 mtime，只改配置时排空不等存盘稳定） | 移植时补 | `lib/lark-runtime-version.mjs` `diskChangedAt` | 无 | — |
| 29 | `lark-bot status` / health：worker 排空中时旧代码提示改成「在飞任务跑完、自检绿会自动 restart」，不再叫人手动 restart | 自愈环 3 | `scripts/lark-bot` status、`lib/lark-routes.mjs` | 无 | 同 #27 |

按 fameex 改了的地方（排空重启部分）：

- 通知不走 repo profile 的 `notifyChatId`（fameex 没有 profile / 控制台群），改走 `notifyOpenId` 私信；消息带幂等键 `drain-red-<磁盘指纹>`，重试不重发。
- 去掉 `botCliName()`（fameex 只有 `lark-bot` 一个 CLI 名）、`isRepoOnlyInstance`；`hermeticTestEnv` 放进本模块，去掉全部 `LARK_*` 和 `NODE_TEST_CONTEXT`（falive 只去三个）。
- 单测文件列表与 `scripts/test-all.mjs` 一致（读 `__tests__/*.test.mjs`，不靠 node 的 glob），显式 `--test-reporter=spec`；不卡 18 秒预算（机器忙时变慢不该让 bot 起不来）。
- 配置改动的自检：falive 注释说「校验 JSON」但实际直接放行；这里真做 `loadConfig` + `validateConfig`，坏配置不重启（gateway 启动校验不过会直接起不来）。
- falive 的体检（doctor）、分支回收（reaper）、合盖暂停不带。

上线：

1. 合进运行分支后**第一次仍要手动** `lark-bot restart`（旧进程里没有排空重启的代码）；之后合代码会自动上线。
2. 配置 `runtime/lark-bot.local.json` 加 `"notifyOpenId": "ou_<你的 open_id>"`（不加也能跑，只是自检红只写日志）。想关就加 `"selfHeal": { "drainRestart": false }`。
3. 合进运行目录 = 几分钟内上线：合之前跑 `node scripts/test-all.mjs`；单测红 bot 会拦下不重启，但能过单测的坏改动拦不住。

### 失败指纹 + 已知类剧本 + 失败台账 + 失败卡旁证（分支 `lark/port-failure-playbook`）

| # | 能力 | 来源（falive） | 落在哪 | 配置 | 怎么验（真机） |
|---|---|---|---|---|---|
| 30 | 失败指纹：worker 层报错去掉路径 / id / 时间 / 数字后归一成指纹（`<类>:<8 位哈希>`），分到固定 14 类；执行器非零退出只看前缀，尾巴里有瞬时错误才改判 `transient_api`；**任务总预算到点**（报的是 exec aborted）按 `timeout` 归类而不是「被中断」（fameex 补的，falive 会归成不算失败） | 自愈 §3.1，`lib/lark-failure-fingerprint.mjs` | `lib/lark-failure-fingerprint.mjs`（导出 `fingerprintFailure` / `decideFailurePlaybook` / `formatFingerprintLine` / `buildSelfHealHint` / `normalizeFailureText`，类别常量 `FAILURE_CLASSES` / `REQUEUE_CLASSES` / `NOT_FAILURE_CLASSES`） | 无 | 审计 JSON 出现 `failureFingerprint` / `failurePlaybook` |
| 31 | 已知类剧本：`result_missing / result_invalid / transient_api / git / readonly_violation / exec_exit` 每任务最多自动交还队列重领 1 次（`client.releaseTask`，静默、不发失败卡、epoch++）；重领后分诊 / 分析 / 实施提示末尾带「【自动重跑】上次失败类别 + 针对性一句」；`stale_epoch / aborted` 不算失败（不进台账，卡照发、换代的由网关 409 挡）；其余直接失败 | 自愈 §3.1 | `lib/lark-failure-playbook.mjs`（`handleTaskFailure` / `selfHealHintFor` / `failurePlaybookEnabled`）；`lib/lark-task-runner.mjs` 的 catch 与开工处各一处调用；`lib/lark-worker-run.mjs` `runAI` 追加提示 | `selfHeal.playbook=false` 或环境 `LARK_FAILURE_PLAYBOOK=0` 整段关掉（失败卡回到原格式、不记台账、不重排队） | worker.log 出现「自愈：…自动重排队（第 1/1 次），已交还队列重领（指纹 …）」，下一次「自愈重跑第 2 次（上次：…）」 |
| 32 | 失败台账：`runtime/lark-failures/fameex.jsonl`，一行一次处置（at / repo / taskId / epoch / cls / fingerprint / label / action / reason / recurring / message≤300） | 自愈 §3.1，`lib/lark-failure-ledger.mjs` | `lib/lark-failure-ledger.mjs`（`recordFailure` / `listFailures` / `selfHealAttemptsForTask` / `countRecentFingerprint` / `summarizeFailures`，常量 `FAILURE_LEDGER_KEY='fameex'`、`failuresDir`） | 同上开关 | `tail runtime/lark-failures/fameex.jsonl` |
| 33 | 失败卡第 3 行「失败归类：<类>，[已自动重跑 1 次仍失败，][同一种错 7 天内第 N 次，]指纹 <类:哈希>」 | 自愈 §3.1 | `lib/lark-worker-results.mjs` `buildFailureResult(task, error, { fingerprintLine, evidenceLine })` | 同上开关 | 下一张 Worker 层失败卡第 3 行 |
| 34 | 失败卡旁证（第 4 行）：falive 查发件簿；fameex 没有发件簿，只用自己有的——审计里停在哪个阶段（分诊 / 只读分析 / 实施）、工作区未提交改动（列前 3 个）、本任务开工后分支上新增的提交（对比开工时记录的 HEAD）。只给事实，不下「活可能已经干成」的判断；只读任务不看工作区 | 自愈 §2 的 1.6，`lib/lark-failure-evidence.mjs` | `lib/lark-failure-evidence.mjs`（`collectFailureEvidence` / `formatFailureEvidence` / `readFailureEvidence`） | 同上开关 | 失败卡第 4 行「旁证：失败时已在实施阶段（分析已跑完）；工作区有 2 个文件未提交（…，现场已保留）」 |

按 fameex 改掉的 falive 专属依赖（失败剧本部分）：

- 台账不按 repo profile 分本：fameex 一个 worker 跨多个 PR 项目，复发要按整个 bot 数，固定一本 `fameex.jsonl`（参数名仍叫 `repo`，与 falive 同形，方便后续自修工单 / 体检直接用）。
- 旁证不读发件簿（`lark-outbox`）、不判「日报已发群」；失败私信（`lark-repo-delivery.buildRepoNote` 的「⚠ 可能做成了」）不搬——fameex 没有私信失败通知，失败卡走原来的群卡片。
- 失败卡行序：falive 旁证在失败类型前（因为它能说「活可能已经干成」）；fameex 旁证只是事实，排在归类之后，归类固定第 3 行。
- 指纹 `nextStep` 文案去掉 `profile.ruleProfile`、「进自修工单」等 falive 说法；自修工单（§3.2）留给后续步骤。

后续步骤（自修工单 / 体检）读这里：`listFailures({ sinceMs })`、`summarizeFailures({ days })` → `{ total, byClass, recurring: [{ fingerprint, count }], healed }`、`countRecentFingerprint({ fingerprint })`；`recordFailure` 的 `action` 除 `requeue / fail / ignore` 外可自定义（如 `self_fix`），复发计数只数 `fail / requeue`。

测试：`__tests__/lark-failure-playbook.test.mjs`（真实错误形状回归分类、台账、真实 git 旁证、接入层：可重排队类重领一次 → 第二次直接失败且卡上第 3 行归类第 4 行旁证、交还失败改报失败、预算到点、开关关掉回原格式、runAI 追加提示）。`node scripts/mutate.mjs --diff 66ae872` 61 个变异点全抓到。

### 自修工单（分支 `lark/port-self-fix`）

| # | 能力 | 来源（falive） | 落在哪 | 配置 | 怎么验（真机） |
|---|---|---|---|---|---|
| 35 | 开单决策：失败剧本判为直接失败、失败卡发出后，「未归类」/「同指纹 7 天内复发」/「自动重排队 1 次仍失败」才开；`timeout / exec_exit / transient_api` 只有复发才开；`permission / tool_missing / quality_gate / stale_epoch / aborted` 永不开。预算：每天（本地日期）最多 3 张、同指纹 7 天 1 张，按失败台账 `action=self_fix` 的行数 | 自愈 §3.2，`lib/lark-self-fix.mjs` `shouldOpenSelfFix` | `lib/lark-self-fix.mjs`（`shouldOpenSelfFix` / `selfFixBudget` / `maybeOpenSelfFix`）；接入点 `handleTaskFailure` 新增 `onFail` 钩子（失败卡发出后调，出错只记日志），`lib/lark-task-runner.mjs` 传 `maybeOpenSelfFix` | `selfHeal.selfFix=false` 或环境 `LARK_SELF_FIX=0` 关；依赖失败剧本（剧本关了不开单） | worker.log「om_x 已开自修工单 sf-…（未归类），worker 空闲时执行」；`tail runtime/lark-failures/fameex.jsonl` 多一行 `action: self_fix` |
| 36 | 工单落盘：`runtime/lark-self-fix/<id>.json`（id `sf-<本地日期>-<指纹哈希>`），含错误原文、指纹 / 类别 / 复发次数 / 重跑次数、原任务审计 JSON 与事件流绝对路径、worker.log 路径与尾 150 行、开单时 lark-bot HEAD、分支名、状态与 history。状态 `pending → running → ready / rejected / reported / failed`，人工 `applied / discarded` | 自愈 §3.2（falive 是一条网关任务） | `lib/lark-self-fix.mjs`（`writeTicket` / `readTicket` / `listTickets` / `updateTicket`）；`.gitignore` 加 `runtime/lark-self-fix/` | 同上 | `lark-bot self-fix list` |
| 37 | 执行器：worker 主循环在**没有在飞任务**、不在排空、不在退出时一次跑一张 pending 工单；跑的时候不领新任务；排空重启的在飞数 + 1（不会在自修中途重启）；SIGTERM 时中断并退回 pending（被中断满 2 次置 failed），启动时把上个进程跑到一半的退回 pending 并删现场。临时 worktree 在仓库同级 `<lark-bot>-<id>`，分支 `lark/self-fix-<指纹短>-<日期>`，基于开单时 HEAD（= 出错那版代码）；`execAiExecutor` claude 实施模式，cwd = 临时 worktree，40 分钟（`execAiExecutor` 新增 `timeoutMs` 覆盖，自修不占网关租约） | 自愈 §3.2 流程 1–2（falive 走多仓 profile 任务队列，fameex 没有 profile，改独立执行器） | `lib/lark-self-fix-run.mjs`（`createSelfFixRunner`：`maybeStart` / `busy` / `inFlightCount` / `current`）；`lark-worker.mjs` 一小块：建 runner、`drain.tick` 在飞数加 `inFlightCount()`、领任务条件加 `!busy()`、每轮领完后 `maybeStart`、优雅退出等它收尾 | 同上 | worker.log「自修工单 sf-… 开始执行（…），跑完前不领新任务」；期间 `ls ~/github/lark-bot-sf-*` 有现场 |
| 38 | 提示词（照 falive `buildSelfFixTaskText` 改）：先定根因层写进 summary 开头 `[harness] / [prompt] / [env] / [model] / [external]`；只有 harness / prompt 且有把握才改 `lib/ scripts/ __tests__/ docs/`、补单测、在 `docs/self-fix-log.md` 追加一行教训；env / external / model 只报不改；硬边界：不碰 runtime/、不改 fameex-web、不改 rules/、不 commit（worker 验收过才提交）、不 push、不 restart | 自愈 §3.2 | `lib/lark-self-fix-run.mjs` `buildSelfFixPrompt`；教训台账新建 `docs/self-fix-log.md`（fameex 没有 falive-lessons.md） | 无 | 工单执行审计 `runtime/lark-self-fix/<id>.log`（stream-json） |
| 39 | 机械验收（不信 AI 自报）：AI 自报 done、summary 标了 harness / prompt 层、有改动，才验收——改动（相对开单 HEAD，含新文件）只能在 `lib/ scripts/ __tests__/ docs/`，越界整单作废；临时 worktree 里 `node scripts/test-all.mjs --budget-ms 120000` 全绿（不卡 18 秒，hermetic 环境去掉 `LARK_*`）；`node scripts/mutate.mjs --diff <开单 HEAD> --lanes 1` 存活 0。全过 → 本地提交（不 push），`ready`，保留现场；否则 `rejected`、记原因与卡在哪一闸、删临时 worktree 和分支。没改代码 → `reported`；只报层却改了文件 / 没标层 / 自报没做完却改了文件 → `rejected`；执行器出错 → `failed` | 自愈 §3.2「护栏」（falive 靠终检 `node --test`，fameex 加了变异闸与范围闸） | `lib/lark-self-fix-run.mjs`（`verifySelfFix` / `defaultRunTests` / `defaultRunMutate` / `runCommand` 异步跑，不卡主循环和心跳） | 无 | 工单 JSON 的 `verdict`（`stage: scope / tests / mutate / commit / done`） |
| 40 | 交付：结束态私信 `notifyOpenId` 一条人话（现象 / 根因层 / 改了什么 / 测试与变异结果；ready 时附「执行 `lark-bot self-fix apply <id>` 合进运行分支，合进后排空重启自动上线；不要就 `lark-bot self-fix discard <id>`」），幂等键 `self-fix-<id>-<状态>`；没配 notifyOpenId 只写 worker.log 和 `self-fix list` | 自愈 §3.2 流程 3 | `buildSelfFixReport`；`lark-worker.mjs` 的 notify 闭包（与排空重启同一写法，logPrefix `self-fix`） | `notifyOpenId` | 私信 / worker.log「自修工单 sf-…：验收通过，等 apply」 |
| 41 | CLI：`lark-bot self-fix list`（工单与状态）/ `apply <id>`（只认 ready；运行目录工作区有未提交的已跟踪改动就拒绝；`merge --no-ff` 进当前分支，有冲突 `merge --abort`、运行目录原样、报冲突文件；成功删工单 worktree 与分支、提交在运行分支里、置 applied）/ `discard <id>`（删 worktree 与分支，置 discarded；执行中 / 已合 / 已丢弃不能丢） | 自愈 §3.2 流程 4（falive 是回「上线」） | `scripts/lark-bot` 加 `self-fix)` 一行 → `scripts/lark-self-fix.mjs` → `lib/lark-self-fix-cli.mjs`（shim 透传参数，不用重装） | 无 | `lark-bot self-fix list` |

按 fameex 改掉的 falive 专属依赖（自修工单部分）：

- 不走任务队列：去掉 `repoProfile('lark-bot')` / `profileExists`、`client.enqueueTask`、`source=self-heal` 的网关任务、`lark/lark-bot-integration` 集成分支与「回『上线』我就合」——改成 runtime 里的工单文件 + worker 空闲时的独立执行器 + `lark-bot self-fix apply`。「不套娃」：工单不是网关任务、执行失败不进失败剧本，天然不会再开单；`shouldOpenSelfFix` 仍认 `task.source === 'self-fix'` 兜底。
- 台账动作用 `self_fix`（falive 是 `self_fix_opened`）；复发计数只数 `fail / requeue`，开单行不算复发。
- 验收由 worker 机械做（范围 / 全量单测 / 变异 / 提交），AI 不提交；falive 是 AI 自己跑终检后提交。
- 教训记 `docs/self-fix-log.md`（fameex 没有 `falive-lessons.md`）；`model` 层不写「规则候选」节，只在私信里报。
- 可改目录去掉 `rules/`（fameex 的 rules/ 是冻结快照）。
- 每天的预算按本地日期（falive 按 UTC）。

上线：

1. 合进运行分支后要一次手动 `lark-bot restart`（或由已上线的排空重启自动 restart）。
2. 默认开；关：`runtime/lark-bot.local.json` 加 `"selfHeal": { "selfFix": false }`（或 launchd 环境 `LARK_SELF_FIX=0`）。私信要配 `notifyOpenId`（见排空重启一节）。
3. 每张工单最多占 worker 约 40 分钟（AI）+ 全量单测 + 变异测试，期间不领新任务；只在没有在飞任务时开跑。
4. 工单 worktree 落在仓库同级（`~/github/lark-bot-sf-<日期>-<哈希>`），ready 的要 apply 或 discard 才会删。

测试：`__tests__/lark-self-fix.test.mjs`（开单决策表与预算、失败剧本 `onFail` 接入、工单落盘与 history、临时 git 仓 + 假执行器跑 ready / 越界 / 测试红 / 变异存活 / 只报不改 / 执行器出错 / 提交被钩子拒 / 中断与启动恢复、主循环调度与排空在飞数、验收命令输出解析、`execAiExecutor` 的 `timeoutMs`、CLI apply 干净能合 / 冲突 abort / 脏工作区拒绝 / discard）。`node scripts/mutate.mjs --diff a2f4fbc` 88 个变异点全抓到。

### 体检（分支 `lark/port-doctor`）

| # | 能力 | 来源（falive） | 落在哪 | 配置 | 怎么验（真机） |
|---|---|---|---|---|---|
| 45 | 体检判定（纯函数）：gateway 在线 / 长连接；worker 心跳新鲜 / 就绪 / 排空中；代码 / 配置落后磁盘（排空中只算 info，否则 warn 提示看排空重启）；gateway 自己的 warnings（已归并的跳过，夜间静默 / 「正在重试」info，意图分类失败 / 回写放弃 / 回执放弃 / 死信 warn）；bug 表轮询；挂起（waiting_confirmation / blocked）超 24 小时；failed 积压（取不到任务列表看 health.counts）；失败台账 7 天汇总与复发指纹（`summarizeFailures`）；有 `runtime/lark-self-fix/` 时数 ready 的自修工单（超 24 小时 warn）。每项 ok / info / warn / bad + 一句话 + 建议动作 | 自愈 §4，`lib/lark-doctor.mjs` | `lib/lark-doctor.mjs`（`buildDoctorReport` / `formatDoctorReport` / `collectDoctorInputs`） | 无 | `lark-bot doctor` |
| 46 | `lark-bot doctor [--json]`：取 health（503 也解析，区分「不可达」和「长连接掉线」）+ 带密钥的任务列表 + 心跳兜底 + 台账 + 轮询状态，有 warn / bad 退出 1 | 自愈 §4 | `scripts/lark-doctor.mjs`、`scripts/lark-bot` 新子命令 `doctor`（shim 透传，不用重装） | 无 | `lark-bot doctor; echo $?` |
| 47 | 定时体检：worker 启动 3 分钟后一次、之后每小时；warn / bad 私信 `notifyOpenId`（没配只写 worker.log），同一条（检查项 + 去掉数字后的内容指纹）24 小时只报一次，发送失败不记已报、下轮照报；消息带幂等键。合盖不跑，刚醒 10 分钟内不跑（睡眠期间心跳 / 事件 / 轮询本就停着） | 自愈 §4 | `startDoctorSchedule` / `createDoctorMonitor`；`lark-worker.mjs` 一行装配；状态 `runtime/lark-doctor-state.json`（原子写，只留 24 小时内的记录） | `selfHeal.doctor=false` 或 `LARK_DOCTOR=0` 关（只关定时）；`LARK_DOCTOR_FIRST_MS` / `LARK_DOCTOR_EVERY_MS` 调间隔 | worker.log 有「体检：开（3 分钟后首次…）」；人为停掉 gateway 几分钟后收到「lark-bot 体检（HH:MM）发现 N 条异常」私信，一小时后同样的异常不再重复 |
| 48 | bug 表轮询状态落盘：poller 每轮写 `runtime/lark-bugtable-poller-state.json`（pid / pollMs / lastRoundAt / lastOkAt / consecutiveErrors / lastError），空闲收工写 stoppedAt。体检判定：没在跑 = info（QA 期才 poll-on，空闲 4h 自动收工是常态）；连续失败 ≥3 次 warn（与 poller 自己的群告警同阈值）；进程在但超过 max(3×pollMs, 10 分钟) 没跑完一轮 warn（卡住） | fameex 补（falive 没有 bug 表 poller，原状态文件只有 seen） | `lark-bugtable-poller.mjs`（`--once` 不写）；读写在 `lib/lark-doctor.mjs` `writePollerStatus` / `readPollerStatus`（pid 探活，EPERM 也算活） | 无 | `lark-bot poll-on` 后 `cat runtime/lark-bugtable-poller-state.json`；`lark-bot doctor` 出现「bug 表轮询在跑（上一轮 N 分钟前）」 |

按 fameex 改掉的 falive 专属依赖（体检部分）：

- 删掉日报到点 / 合盖推迟日报、发件簿、外部群轮询、repo profile 的检查与 `buildDailySelfCheckLine`（fameex 没有日报）；`lark-bot doctor` 不收 `[repo]` 参数。
- 通知不走 `notifyChatId` / webhook，走 `notifyOpenId` 私信（`sendChatMessage` 由 worker 注入，体检模块不直接依赖 lark-cli）；falive 「没配通知群就整个关掉」改成没配也跑、只写日志。
- 去重指纹去掉数字（falive 按原文哈希，「心跳已停 10 分钟」→「70 分钟」会每小时重报）；状态文件改用 `lib/lark-fs.mjs` 原子写，并修剪 24 小时外的记录。
- 合盖跳过之外加了「刚醒 10 分钟内跳过」（`lastSystemSleepAt`），避免开盖第一轮把睡眠期间的停摆报成故障。
- 每项加「建议动作」（falive 只有一句现象），命令都是 fameex 现有的：`lark-bot restart / poll-on / failed / retry / resume / close / clean --failed / claude-auth / self-fix`。
- 自修工单只按目录约定读 `runtime/lark-self-fix/<id>.json` 的 `status=ready`（就绪时间取 `readyAt || updatedAt || createdAt`），不 import `lib/lark-self-fix.mjs`。

上线：合进运行分支后由排空重启自动生效（或手动 `lark-bot restart`）；不用改配置，想关定时私信加 `"selfHeal": { "doctor": false }`。`scripts/lark-bot` 的 usage 行没加 `doctor`（避免和自修工单分支同一行冲突），合并两条分支时一起补。

测试：`__tests__/lark-doctor.test.mjs`（各检查项表格化判定、轮询 / 自修工单状态文件读写、去重 24 小时与数字归一、发送失败不记已报、合盖 / 刚醒跳过、定时装配与私信出口、取数兜底、真走 `scripts/lark-bot doctor` 起假 health 服务验退出码）。`node scripts/mutate.mjs --diff a2f4fbc` 59 个变异点全抓到。

### 沙箱试跑（10-24）

编号沿用试跑报告；本节两个修复分支各写各的行。

- 分支 `lark/sh-fix-ledger`（问题 1、2、3、4，10 的两项）：
  - 1 复发误算：`countRecentFingerprint` 加 `taskId`，排除本任务自己的行，并按不同任务计数；任务自己第一次 requeue 后第二次失败不再写「同一种错 7 天内第 2 次」、台账 recurring 不再为 true，自修开单原因 / 提示词随之正确（`lib/lark-failure-ledger.mjs`、`lib/lark-failure-playbook.mjs`）。
  - 2 体检汇总：`summarizeFailures` 只数 fail（requeue 单列「自动重跑 N 次」，self_fix / ignore 不算），复发 = 不同任务 ≥2，count 是任务数；体检文案改成「指纹（N 个任务）」，只有自动重跑没有失败时 ok 行带重跑次数（`lib/lark-doctor.mjs`）。
  - 3 `spawn claude ENOENT / EACCES`（异步 spawn）归 tool_missing（原来只认 `spawnSync`，落成 unknown 去开「未归类」自修工单）；自修执行器起不来 AI（`isSpawnFailure`）直接 failed，写明不重试，即便恰好赶上退出也不退回待执行（`lib/lark-failure-fingerprint.mjs`、`lib/lark-self-fix-run.mjs` 的 catch）。
  - 4 体检空档误报：`diskChangedAt` 之后 2 分钟（`DRAIN_PICKUP_GRACE_MS`：settleMs 60s + 2 个轮询周期 + 版本观测缓存，留余量）内 worker 还没排空只算 info，超过才 warn；info 不私信、不进 24h 去重，后面真没接手照报。
  - 10（部分）：自愈重排队那次的「执行异常」只打一行 info（类别 + 报错首行），不带堆栈（`logTaskException`，`lib/lark-task-runner.mjs` 调）；不开自修工单时打一行原因（同指纹已开过 / 预算满 / 取不到 HEAD 等，`lib/lark-self-fix.mjs`）。
  - 测试：`__tests__/lark-failure-playbook.test.mjs`、`__tests__/lark-doctor.test.mjs`、`__tests__/lark-self-fix.test.mjs` 各在已有 it 里加断言（真实异步 spawn 造 ENOENT / EACCES，不调真 claude）；修复前均红。

- 分支 `lark/sh-fix-worker`：沙箱端到端试跑发现的问题，编号沿用试跑报告。下面是这条分支修的（5–9、11、12 和 10 的四处）；1–4 和 10 的另两处在另一条分支。每条先写了失败的测试，确认修复前红。

| # | 问题 | 修法 | 测试 |
|---|---|---|---|
| 12 | 执行器没有 claude 路径开关，只能靠 PATH 遮挡；假 claude 一失效就落到真 claude（这次试跑的事故原因） | `LARK_CLAUDE_BIN` 覆盖（与 `LARK_CLI_BIN` 同风格，调用时读 env）；node --test 进程里（`NODE_TEST_CONTEXT`）没显式指定就用不存在的 `/nonexistent/lark-bot-test-no-claude`。任务四种模式、就绪探针、`--version` 预检全走 `resolveAiExecutorBinary('claude')` | `lark-ai-executor.test.mjs`：各模式 cmd、预检 ENOENT、真 spawn 起不来；另用一个会记账的假 `claude` 放在 PATH 最前跑全量 604 条，一次也没被调到 |
| 5 | `scripts/lark-bot` 的 status / failed / retry / clean / close / resume / receipt-retry 写死 3005，status 写死 `port=3005` | 统一 `GATEWAY_URL="${LARK_GATEWAY_URL:-http://127.0.0.1:3005}"`，status 的 port 从地址解析（没有端口显示 url） | `lark-bot-control.test.mjs`：自定义地址下 6 个 curl 全打到新端口、脚本里 3005 只剩缺省值一处 |
| 6 | 心跳 `inFlight` 不含自修工单：自修中排空显示「在飞 0」，status 看不出有自修在跑 | 心跳改用 `heartbeatActivity({ tasks, selfFix, draining })`：自修算一个在飞，带 `selfFix: { id, since }`；自修开跑 / 跑完立即补写心跳。status 行尾「自修中 <id>（自 …）」，doctor「worker 在线（在飞 1，自修中 <id>）」 | `lark-runtime-version` / `lark-self-fix`（`runner.status()`）/ `lark-bot-control` / `lark-doctor` |
| 7 | 排空中 gateway 的版本提示仍写「需 lark-bot restart」；worker.log 发起重启后又打一次；status 把排空中的 worker 标 unhealthy、退出 1 | `versionWarnings(version, { draining })` 排空中改口「worker 已在排空…会自动 restart」，health（`workerDraining(worker)`：心跳活着才算）与 worker 日志都传；status 排空中 worker 算 running，旧代码 / 旧配置不计入退出码 | `lark-runtime-version` / `lark-bot-control`（排空 exit 0；心跳停 / pid 对不上仍 unhealthy、exit 1） |
| 8 | worker 被 SIGKILL 时在跑的自修 claude 成孤儿（recover 只删现场） | `execAiExecutor` 新增 `onSpawn({ pid, cmd })`，自修把执行器 pid（= 进程组号）记进工单 `execPid`；recover 先 `killOrphanExec`：`ps -A -ww` 里这个进程组有命令行含工单 worktree 路径的进程才 `kill(-pid)`，防 pid 复用误杀 | `lark-self-fix.test.mjs` 起真进程：命令行带 worktree 路径的被 SIGKILL，无关进程不动 |
| 9 | 改动行没有可变异点时变异闸也算过，私信 / 提交说明写「变异存活 0」 | `defaultRunMutate` 返回 `checked`：有变异点写「变异存活 S（N 个变异点：抓到 K，豁免 A）」，没有写「改动行没有可变异的运算符（未做变异检查）」；提交说明同样区分 | `lark-self-fix.test.mjs` |
| 11 | 排空自检用 `spawnSync` 跑全量单测，卡住 worker 事件循环 8–11 秒、心跳不更新 | `runSelfTests` 改异步（复用自修验收的 `runCommand`，挪进 `lib/lark-drain-restart.mjs`，self-fix-run re-export），自检期间定时器照走；超时显示「超时（Nms）」 | `lark-drain-restart.test.mjs`：跑测试期间 20ms 定时器照常走 |
| 10 | spawn 报错把带完整提示词的 `spawnargs`（约 13KB）倒进 worker.log | `trimSpawnArgs`：参数只留前 200 字（命令名在 `error.path` / message 里） | `lark-ai-executor.test.mjs` |
| 10 | 只改配置时排空日志打的是代码哈希「a2ec… → a2ec…」 | 改了什么打什么：「代码 a → b」「配置 c → c2」，两样都改两样都打 | `lark-drain-restart.test.mjs` |
| 10 | `LARK_DOCTOR_FIRST_MS=20000` 显示「0 分钟后首次」 | 不足 1 分钟按秒（向上取整） | `lark-doctor.test.mjs` |
| 10 | worker 发私信的日志前缀是 `[lark-gateway]` | `sendChatMessage` / `runLarkCliWithRetry` 加 `logTag`（缺省不变），worker 的排空 / 自修 / 体检私信传 `[lark-worker]` | `lark-pure.test.mjs` |
