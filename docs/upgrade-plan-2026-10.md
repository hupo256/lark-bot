# lark-bot 升级与优化计划（2026-10-17 aven 批准）

目标：准确 + 效率 + 防变重。模型统一 `claude-opus-5-5`，费用不是目标。完整评估与基线见本文末尾「基线」；
每批在独立 worktree / 分支（`lark/refactor-<n>`）上做，单测全绿后合进运行分支 `feature/falive-repo-profile`，
合入后跑 `node scripts/lark-metrics.mjs --runtime <运行中的 runtime>` 对照基线。

## 进度

| 批次 | 状态 | 分支 / 提交 |
| --- | --- | --- |
| 第 0 批 止血（正确性） | ✅ 2026-10-17 完成，全量单测绿 | `lark/refactor-0` |
| 第 1 批 效率（延迟与子进程） | ✅ 2026-10-17 完成，全量单测绿（723） | `lark/refactor-1` |
| 第 2 批 结构（变更流 + 核验闸注册表；SQLite / 全量状态机延后） | ✅ 2026-10-17 完成，全量单测绿（729） | `lark/refactor-2` |
| 第 3 批 协议 / 去重 / 被动消息 | 待做 | |
| 第 4 批 治理 | ✅ 2026-10-17 完成（体量预算测试、AGENTS 先分类再动手、lessons 类别列、心跳降噪） | `lark/refactor-3` |

## 第 0 批：止血（已完成）

**worker**
1. 只读任务永远拿不到可写面：`buildAiExecutorCommand` 的 claude 任务模式在 `readOnly` 时用分析同款只读工具面（`--tools Read,Grep,Glob,Bash --allowedTools <只读>`），不带 `--dangerously-skip-permissions`；删掉 `runTask` 末尾的兜底规范闸（只读任务 done 后会在人的主仓里 `git add -N` / 起可写纠正 pass）。
2. 对接文档入库路径只提交文档：`commitScopedPaths = archivedDocs` → `finalizeExistingWorktree` 定向提交，AI 失败那趟的半成品代码不再被 `git add -A` 带进集成分支。
3. 租约续期 + 单一截止：`POST /lark/tasks/:id/heartbeat` + `store.touchLease`（epoch 不符 409）；worker 每 `leaseMs/3` 续一次；`deadline = claimedAt + taskBudgetMs`（默认 150min，`LARK_TASK_BUDGET_MS` / `task.taskBudgetMs`），`AbortSignal.any([deadline, shutdown])` 作为唯一 signal，截止中断按失败处理（`isShutdownAbort` 区分）。规范纠正 pass 也收 signal。
4. 进程组 kill：AI 子进程 `detached: true`，终止时 `process.kill(-pid)`，claude 的 Bash 起的 tsc / dev server 一起死。
5. worker 不再裸崩：`listClaimable` 失败只退避；`unhandledRejection` 记日志不退出；`runTask` 外层 catch。
6. `getTask` 改 `GET /lark/tasks/:id`（鉴权同 `/lark/tasks`）。

**gateway**
7. `readBody` 坏 body / 超限 → `null`，路由统一 400（`readJsonBody`）；`/intake` 不再把 `{}` 落成 ignored。
8. 出口闸拦下返回 `{ ok:false, gated, reason }`，`deliverRepoOutcome` 的 done / blocked_ask 把它当「没发」写进负责人私信；「收到」被按人 2 分钟拦下仍算回过（`ackCoalesced`）。
9. `handleStatusUpdate` 在副本上改，写前核对 epoch / status 是否被别处动过（409 不发卡），只合并本次改过的键。
10. 轮询 `feed()`：ingest 成功才记 seen，失败那条不越过（`cursorFloor`），下轮重叠窗口重喂。
11. ingest：`!msg` 判空提前；仓库群白名单先于话题补充；非仓库群没触发零成本直接丢。
12. 启动序：群名 / 自定义机器人解析 → `listen` → `startConsumer`（`consumerHandle` 代理给 health）。
13. `sendBotMarkdown` 带幂等键（hash 收件人 + 正文）；台账 / 轮询游标 / 日报 / 清扫状态改 `lib/lark-fs.mjs` 原子写。
14. `scripts/lark-metrics.mjs`：基线表那几项，`--runtime` 可指向运行中的 runtime。

测试：`lark-task-store`（touchLease）、`lark-ai-executor`（readonly 工具面、detached + `-pid`）、`lark-chat-poller`（失败不入 seen）、`lark-repo-delivery` / `lark-outbox`（gated = 没发）、新 `lark-task-runner`（预算 / 心跳）、`lark-http`、`lark-status-epoch`、`lark-routes`。

真机待看：只读复测任务的 claude 进程参数里无 `--dangerously-skip-permissions`、主仓 `git status` 不变；杀 worker 后无存活 tsc / claude 孙进程；gateway 重启 1s 内 worker 不退出；长任务审计里 `leaseTouchedAt` 在推进。

## 第 1 批：效率——延迟与子进程（已完成 2026-10-17）

实际落地与计划的差异：
- 实施续分析会话：`execAiExecutor` 新增 `resumeSessionId / fallbackPromptText`，分析分支不再 `--no-session-persistence`，json 模式从 envelope 取 `session_id`；续不上回退完整提示一次并记审计 `resumeFallback`。实施提示有 `followUp` 增量版（不重复任务正文 / 规则块，预算 11000 字符）。
- 规则去重：`stripAutoLoadedRules` 只剔掉 Claude Code 自动加载的 `CLAUDE.md` / `~/.ai-rules/AGENT.md` 章节（约占注入文本 1/3），coding-quality 等向导章节仍注入；审计记 `omittedAutoLoaded`。
- `docs/task-boundaries-and-reply.md` 改按需读小节（不再列入必读文档）；删 `requirementSelfAssessment`；预算测试加分析 / 续会话两档并断言提示里无 `PR-0xxxx`。
- Lark IO 没有另起 `lark-io.mjs`：限流（user / bot 各 2 并发、send 优先）直接做在 `runLarkCli`；群名缓存 10 分钟 + 外部群负缓存；成员事件订阅没做（靠 TTL）。
- 话题补抓：上限 30→5，只补 2h 内活跃或仍有未了结任务的，其余 30 分钟轮转；6 小时回看仍 2 分钟一次但只翻 3 页（老 host 新话题的 @ 要尽快看到）。
- 日报：调度 / 状态 / 群触发搬到 `lib/lark-daily-schedule.mjs`（gateway），生成留在 `lib/lark-daily-report.mjs`（worker-only）；系统任务 `lib/lark-system-tasks.mjs`（source `daily-report`，`commandType status` 走只读路径不建 worktree），worker 由 `lib/lark-system-runner.mjs` 跑 `runDailyReport`，done 带 `payload`，gateway 在 `handleStatusUpdate` 里记发送状态 + 排清扫；失败重试 / 上限私信由调度器按任务状态做。`startDeployWatch` 仍在 gateway（已是异步 fetch）。
- gateway 残余：`materializeDoc` 改异步 `lib/lark-git-read.mjs`（两处共用）；`composeContextualAck` 删除，「收到」用固定句；`resolveAiExecutor` 抽到 `lib/lark-ai-executor-select.mjs`。
- `lib/lark-power.mjs` 单采样点（30s 缓存），keep-awake / 轮询 / 补拉 / 日报调度共用。
- `lark-runtime-version` 先比 mtime 再算哈希。
- 纯度闸 `__tests__/lark-gateway-purity.test.mjs`：闭包无同步子进程 / 模型调用，`child_process` 只许 6 个模块，worker 专属模块不进闭包。

真机待看：一条实施任务审计 `implementation.resumedSession` 非空且第二趟时长明显下降；gateway.log 一轮轮询的 lark-cli 行数；19:00 `daily-falive-<date>` 任务出现在 worker.log 并 done；`/lark/health` 在日报期间响应 < 100ms。

### 原计划

**worker：会话复用 + prompt 瘦身**
1. 分析 → 实施续同一会话：analysis 分支去掉 `--no-session-persistence`，`execAiExecutor` 返回 `sessionId`；实施调用传 `resumeSessionId`（`ai-executor.mjs:324` 已支持），prompt 改增量版 `buildImplementationFollowUp`（只含契约 / 假设 / 结果文件指令）；resume 失败回退完整 prompt 新会话一次并记审计 `resumeFallback`。工具面由新命令决定，不继承分析的只读面。
2. 规则不再重复注入：`lib/lark-worker-run.mjs:103` 对 falive 不注入 `buildFocusedRuleContext` 正文（CLAUDE.md 自动加载），只记 `sources/revision` 进审计；`required` 缺失改为文件存在性检查。
3. `docs/task-boundaries-and-reply.md`（31KB）改按需读 + 拆 ≤3KB 摘要；事故段落（PR-02172 / 01644 / lessons #31 / #33）迁入对应 gate 的 reason 文案与测试；删 `requirementSelfAssessment`。
4. `__tests__/lark-prompt-budget.test.mjs`：`TASK_PROMPT_BUDGET` 12000→7000，新增 `ANALYSIS_PROMPT_BUDGET=8000`、`IMPLEMENTATION_FOLLOWUP_BUDGET=3000`，断言 prompt 不含 `PR-0\d+`。
5. 显式 @Aven.Bot 的消息走 fastLane 立即分类（核实 `intake.fastLaneMs` 是否已覆盖 @bot；被动消息保留 60s 去抖）。

**gateway：Lark IO 收口 + 重活出 gateway**
6. `lib/lark-io.mjs`：吸收 `runLarkCli`，user/bot 身份各并发 2、send 优先；每轮配额 `withBudget(n)`；`chat-list` TTL 10min + 外部群**负缓存**（现 `lark-cli.mjs:340-343` 恒 miss）+ 订阅 `im.chat.member.bot.added/deleted` 事件失效。`lark-cli` 不吐 token（keychain），直连 HTTP 不可行，子进程仍是 IO 单位。
7. 轮询降频：`THREAD_POLL_LIMIT` 30→5，只补「2h 内有活动或有未了结任务」的话题，其余 30min 轮转；6h 回看仅在本轮 `fresh>0` 或距上次 ≥15min；目标每群每轮 ≤1 次 list + ≤5 次 thread。
8. `lib/lark-power.mjs`：`isLidClosed / lastSystemSleepAt` 单采样 30s 缓存，keep-awake / poller / wake-catchup / 日报调度共用。
9. 日报改 worker 任务：`lib/lark-system-tasks.mjs buildDailyReportTask`，调度器 tick 只入队（保留到点 / 合盖推迟 / 当日已发判断）；`lark-worker-run.mjs` 加 `isDailyReportTask → runAndRecordDailyReport`；`lark-daily-report.mjs` / `lark-doc.mjs` 变 worker-only；`startDeployWatch` 移到 worker doctor tick。
10. gateway 内残余同步 / LLM 清除：`materializeDoc` 两处删除（worker 在 status body 带 `followUpDocText`）；`composeContextualAck`（gateway 里唯一的 Claude 调用，40s）删除——即时 ack 用固定 `ACK_TEXT`，场景化一句由 worker 分类结果新增 `ack` 字段带回、`deliverRepoNoted` 发出；`resolveAiExecutor` 抽成纯模块。
11. health 便宜化：`lib/lark-runtime-version.mjs` 改后台 60s 先比 mtime，变了才重算 hash；`observe()` 纯读内存。
12. 纯度闸 `__tests__/lark-gateway-purity.test.mjs`：递归解析 `lark-gateway.mjs` 的 import 闭包，断言不含 `spawnSync|execSync|execFileSync|spawn('claude')`；`node:child_process` 只允许 `lark-io / lark-consumer / lark-keep-awake / lark-power`；闭包不含 `lark-daily-report / lark-ai-executor / lark-doc / lark-worker-*`。

测试：`lark-ai-executor`（resume 参数、fallback）、`lark-worker-run`（收到 resumeSessionId、followUp prompt、daily-report 分支）、`lark-prompt-budget`、新 `lark-io.test.mjs`（并发上限、配额、负缓存与失效）、`lark-chat-poller`（话题上限）、`lark-daily-report-schedule`（tick 入队）、`lark-keep-awake` / `lark-wake-catchup` 改注入 `lark-power`、`lark-gateway-purity`。

---

## 第 2 批：结构（已完成 2026-10-17，范围有调整）

**取舍**：SQLite 迁移与 runTask 全量状态机**延后**——当前 63 条任务 / 444KB，文件存储已是原子写，索引与事务对这个量级没有收益，换存储引擎只增加风险与代码；状态机全量重写 920 行 runTask 风险过高。按「不变重」原则，本批落地的是去掉真正的浪费、并把最容易膨胀的那一段收成注册表：
- 任务变更流：`store.persist` 发 `{ seq, id, status, epoch }`（留 500 条），`GET /lark/tasks/changes?since&wait` 长轮询（≤ 25s）；worker 一条长轮询（`lib/lark-change-watch.mjs`）盯全部在飞任务的取消 / 换代，原来每任务每秒 `getTask` 一次改为 30s 兜底。
- `GET /lark/tasks?status=&repo=&limit=`：worker 领取只拉 queued / received。
- `store.updateIfEpoch`（CAS）备好；状态回写第 0 批已做写前核对。
- 完成态核验闸注册表 `lib/lark-task-gates.mjs`：lint / evidence / identity.stable / env.verify / code-rules / done.trust / scope 七道按表顺序跑，证据（改动文件 / diff 规模 / numstat）只采一次；runTask 里原 120 行内联核验换成 15 行；`__tests__/lark-task-gates.test.mjs` 锁死注册表 ≤ 16 道且元数据齐全。
- 无界增长：发件簿每 6 小时清一次（原每进程一次）；台账 `new#` 条目 14 天没动自动清（`pruneLedger`）。

仍待做（放到第 3 / 4 批或之后）：SQLite（任务量上千再做）、INTAKE / PREPARE / COMMIT 阶段的状态机化、`task.text` 只增不减。

### 原计划

**2a gateway：`node:sqlite` 单库 + 变更流**
1. `lib/lark-db.mjs`：WAL + busy_timeout，`kv.schema_version` 迁移。表：`tasks`（索引列 status / chat_id / thread_root_id / topic / repo / epoch / claimed_at / updated_at / has_pending_receipt，业务字段仍在 `json`）、`task_receipts`、`task_changes(seq)`、`outbox`、`ledger_items` / `ledger_events`、`poller_seen`、`kv`（游标 / 日报 / 清扫状态）。
2. `lib/lark-task-store.mjs` 公共 API 不变；内存 Map 只做身份缓存，条件查询走 SQL；新增 `updateIfEpoch(id, epoch, mutator)`（事务内 CAS）与 `transaction(fn)`。`findByReceiptMessageId / listActiveByThread / listSuspected / pruneTerminal / claimNext / stats` 等变成一句查询。
3. `outbox / ledger / poller state / daily / sweep` 改 db 读写（签名加 `{ db }` 注入）；outbox 7 天清理、ledger `new#` 无事件 14 天清理、events 30 天。
4. `scripts/lark-migrate-sqlite.mjs` 一笔事务导入现有 JSON / jsonl，源目录改名 `*.migrated`；gateway 启动库空且旧目录在则自动迁。
5. 路由：`GET /lark/tasks?status=&repo=&limit=`、`GET /lark/tasks/changes?since=<seq>&wait=<ms>`（长轮询，`persist` 时 emit）；worker 一条共享的 changes 长轮询分发取消到各 in-flight `AbortController`，删每任务 1s 的 `monitorExecutionCancellation`；兜底 30s `getTask`。
6. `handleStatusUpdate` 全部落盘改 `updateIfEpoch`。

**2b worker：阶段状态机 + 证据对象 + 闸门注册表**
7. `lib/lark-task-stages.mjs`：`INTAKE → PREPARE → ANALYZE → IMPLEMENT → VERIFY → COMMIT → REPORT → CLEANUP`，每 stage `async (ctx) → { next, result? }`；`workspace.kind` 决定链（readonly 链没有 VERIFY / COMMIT 节点）；`deliverable ∈ code | doc-archive | answer` 在 PREPARE 决定。`runTask` 退化成 ≈120 行驱动器。
8. `lib/lark-task-result.mjs`：统一 `TaskResult { status, reasons[{code,gate,severity,detail}], ai, commit, evidenceRef }`；REPORT 只调一次 `reportStatus`，文案由 `renderResult` 从 reasons 渲染。
9. `lib/lark-task-evidence.mjs`：IMPLEMENT 后一次 `collectEvidence`（diff / name-only / numstat / 身份 / 指纹 / run 元数据）；4 处身份检查变 PREPARE 记 `identity0`、COMMIT 前比一次。
10. `lib/lark-task-gates.mjs`：`{ name, stage, owner, addedAt, applies, check }`，`runGates(stage, ctx)` hard 即短路。目标 13 worker + 3 delivery：`input.present / workspace.route / input.prefetch / work.kind / ai.readonly-invariant / ai.blockers / done.trust / lint / scope / env.verify / identity.stable / cancel.epoch / commit.policy / delivery.claims / delivery.dedupe / delivery.address`（合并来源见设计稿，lint 吃同一份 `evidence.diff`、AI 修正最多一轮带 signal）。`__tests__/lark-task-gates.test.mjs` 断言注册表 ≤ 16 且每个 gate 有 owner / addedAt / 用例。

测试：新 `lark-db.test.mjs`（建表幂等、迁移 fixture、事务回滚）、`lark-task-store`（dbPath、updateIfEpoch 冲突）、`lark-routes`（`?status`、changes 被 upsert 唤醒）、`lark-outbox / lark-ledger / lark-chat-poller / lark-daily-*` 改 db 注入、新 `lark-task-gates`、`lark-task-runner`（阶段转移表）、沿用 `lark-final-verification / lark-scope-contract / lark-work-policy`。

---

## 第 3 批（已完成 2026-10-17，范围有调整）

- **回放集**：`scripts/lark-replay-export.mjs` 把运行中 runtime 里带分类结果的任务导成固定回放集（现 48 条，9 条 forMe；线上判定搬到 `intake.classification_at_capture` 作基线）；`scripts/lark-replay-classify.mjs --report [--gate]` 出 forMe 召回 / decision 一致率 / medium 占比，`--gate` 不达标非零退出。全量回放一次约 48 次 Opus 调用（~15 分钟），改提示词 / schema 前跑。
- **模型边界枚举**（都是可选字段，老结果照常解析）：分析 schema 加 `blockerClasses[{text,class}]`，`classifyBlockers` 优先用模型自报、没有再退回正则；结果 schema 加 `completionClaim`（all_done / partial / blocked_external / none）与 `preChecks[].kind`（ok / issues / unreachable），`findGroupReplyContradiction` 先查结构化口径再查文字，runner 的 schema 实测判定先看 kind；对接文档归属优先用分析阶段的 `ownership`；`INTERNAL_BLOCKER` 人名改从 `profile.memberRoles` 取（角色含「前端」+ 负责人本人），不再写死。
- **threadKey**：仓库任务的 topic 只由 routes 按台账条目 / 消息 id 定，分类器的自由文本只给默认仓用。
- **删执行器**：codex / pi / cursor 的命令构造、就绪探测、模型配置、二进制映射全部删除，`AI_EXECUTORS` 只剩 claude（ai-executor 从 849 行降到 ~700）。
- 延后：ingest 9 处 notice 收口、6 套归并统一、被动消息不建任务（依赖 messages 表 / SQLite）。

## 第 4 批（已完成 2026-10-17）

- `__tests__/lark-size-budget.test.mjs`：lib 新文件 ≤ 600 行，7 个超线老文件按快照只许变小。
- `AGENTS.md` 出错处理原则改为「先分类再动手」（逻辑 / 环境 / 噪音），加一道闸必须合并或删一道，改提示词前跑回放门槛。
- `docs/falive-lessons.md` 加「类别」列（老条目标待分类）与「分类与有效期」节（90 天零命中复查）。
- worker 心跳的「代码已落后磁盘」只在内容变化时打一行（原每分钟一行）。

### 原计划第 3 批

**准确性前置：回放集扩容**（本批任何提示词 / schema 改动的门槛）
1. 把 164 条历史分类（审计 e0 日志 + 任务文件）导出为固定回放集 `__tests__/fixtures/falive-intake/`（现 6 条），aven 的纠正（lessons #24 / #26 / #34 等）作标注；`scripts/lark-replay-classify.mjs` 加 `--report`：forMe 召回、decision 一致率、medium 占比。门槛：forMe 召回 100%、一致率 ≥ 95% 才能合入。

**worker：模型边界用枚举**
2. `lib/lark-ai-schemas.mjs` 集中枚举 + `schemas/*.json` 对等测试：analysis `blockers[{text, class: hard|soft|decision|process}]`（删 `work-policy.mjs:161-183` 正则）；result `completionClaim: all_done|partial|blocked_external|none`、`remainingItems[{item, state, owner}]`（替换 BLANKET / ISSUE / LEAD_COUNT / PRE_CLAIM）、`preChecks[].outcome`、`ownership{verdict, ownerKey}`（替换 `new RegExp(name)` 与 `INTERNAL_BLOCKER` 人名正则）、`blockers[].audience`。
3. `humanizeResult` 改按结构化字段渲染，不再回解析自家文案（`repo-delivery.mjs:37-55`）。
4. `topic` → `threadKey = rootMessageId ?? ledgerItemId ?? task.id`，删 intent schema 的自由文本 `topic`；串行 / 并入全部按 `threadKey`。
5. 删除：codex / pi / cursor 执行器分支与 readiness、`AI_EXECUTORS` 收敛为 `['claude']`、`normalizeAnalysisForTask`、completion-rule 正则。

**gateway：去重 + 被动消息不建任务**
6. `lib/lark-notice.mjs notice()` 替换 ingest 9 处 + routes / status / gateway 各 1 处；`lib/lark-merge-target.mjs resolveMergeTarget()` 统一 6 套归并（话题补充 / resume / parked sibling / 同 topic / relatedTaskId）；删 `reopenForThread / listRecentForChat / ackedRecently / materializeDoc×2 / SIGNATURE 副本 / 三个进程内 Set`。
7. `messages` 表（message_id PK、chat、thread_root、sender、created_ms、text ≤4k、classification、task_id NULL，7 天清理）：ingest 对每条先 `INSERT OR IGNORE`（即幂等 / 重推去重）；被动消息不建 task，写 `classify_jobs`，worker 经 `GET /lark/classify/next` 跑同一分类器（去抖 `notBefore` 不变），上下文从 `GET /lark/messages?chat=&before=` 取（替代 `fetchRecentChatContext` 子进程与 3h 文本复制进 `task.text`）；`lib/lark-ledger-apply.mjs applyClassification()` 把 `/intake` 里「记台账 → 待命指令 → 工单键」抽出，@ 与被动共用，仅 actionable / suspected 时 `promoteToTask`。`task.text` 改存 `contextMessageIds`。

测试：`lark-work-policy / lark-repo-delivery` 改枚举驱动、`lark-task-store / lark-thread-intake` threadKey 并入、schema 对等测试、新 `lark-ledger-apply / lark-notice / lark-merge-target`、`lark-thread-intake`（被动 → 仅 message 行；actionable → 晋升）、`lark-conversation` 改从 messages 表取上下文、回放集报告。

---

### 原计划第 4 批

1. 增长预算进测试（已有 `lark-prompt-budget` 模式）：闸门注册表 ≤ 16；prompt 三档预算；gateway 纯度；`lib/` 单文件 ≤ 600 行；`scripts/lark-metrics.mjs` 输出的「每任务 Claude 调用次数 ≤ 3（不含 resume 回退）」「每群每轮子进程 ≤ 6」。
2. `docs/falive-lessons.md` 表加「有效期 / 命中次数」列（失败台账已按指纹计数），90 天零命中进复查清单；只出过一次的归档到附录。
3. `AGENTS.md` 「出错处理原则」改为：**先分类再动手**——bot 逻辑错 → 改代码 + 闸（必须合并或删一道旧闸）；环境问题 → 改环境或运维文档；噪音 → 只调阈值。lessons 每行必填分类。
4. 删除 worker.log 里刷屏的「运行中的代码已落后磁盘」逐任务告警（排空重启已接管，只在 drain 发起时打一行）。

---

## 验证

- 每批：`node --check` 改动文件；`node --test __tests__/*.test.mjs` 全绿（现 685 个 / 24s，新增见各批）；`scripts/lark-metrics.mjs` 对照基线表。
- 第 0 批真机：发一条只读复测任务，确认 `pmset`/`ps` 里 claude 进程无 `--dangerously-skip-permissions`、主仓 `git status` 不变；杀 worker 后 `ps` 无存活 tsc / claude 孙进程；gateway 重启 1s 内 worker 不退出。
- 第 1 批真机：一条实施任务审计里出现 `resumeSessionId` 与第二趟时长；`gateway.log` 一轮轮询的 lark-cli 行数 ≤ 6；19:00 日报在 worker.log 出现而 gateway `/lark/health` 期间响应 < 100ms。
- 第 2 批：迁移脚本在 `runtime/*.migrated` 备份上可重复跑；`GET /lark/tasks/changes` 在 upsert 后 100ms 内返回；一次 `继续任务` 续跑走状态机且审计含 `stages[]`。
- 第 3 批：回放集报告达门槛；群里一条被动消息后 `runtime` 里无新任务文件、`messages` 表有行、台账有事件；`@Aven.Bot` 消息仍建任务并回「收到」。
- 回归：真机跑一遍 lessons #26 / #28 / #33 / #34 的场景（话题补充、老 host 新话题、只改文档的复测、`继续任务 <id>`）。

## 基线（改前，2026-10-17）


| 指标 | 现值 | 目标 |
| --- | --- | --- |
| 消息 → 分类完成 | p50 74s / p90 124s | 显式 @bot：≤ 30s；被动消息保留去抖 |
| 任务 wall（领取 → 完成） | p50 78s / p90 346s / max 1139s | p90 ≤ 200s |
| 分析 + 实施两次冷启动 | p50 57s + 98s | 实施续会话后第二趟 ≤ 60s |
| forMe 12 条里需 aven 确认 | 7 条（疑似私信 10 次） | 回放集上 forMe 召回 100%、decision 一致率 ≥ 95% |
| 外部群每 30s 子进程 | ≈ 35 | ≤ 6 |
| worker 拉全量 dump | ≈ 3 次/秒 | 0（按 id 查 + 变更流） |
| 日报期间 gateway 冻结 | 最长数分钟 | 0（gateway 内禁 spawnSync / LLM，由测试保证） |
| 闸门数 | 27 + 12 | ≤ 16，注册表长度由测试锁死 |
| 实施 prompt 预算 | 12000 字符 | 7000；分析 8000；续会话增量 3000 |

