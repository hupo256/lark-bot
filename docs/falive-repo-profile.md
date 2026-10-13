# 多仓 profile 与 falive 接入

> Lark Bot 子系统文档之一，索引见 [README.md](./README.md)。
> 本文记录 2026-10-12 起把 lark-bot 从「fameex-web 单仓 bot」改成「按仓库 profile 路由」的设计、falive-react 的接入方式，以及受 Lark 外部群限制而采用的输入 / 输出链路。实现入口 `lib/lark-repo-profile.mjs`。

## 1. 已拍板（aven 2026-10-12）

| 决策 | 结论 |
|---|---|
| 实例形态 | **单实例多仓**：同一套 gateway / worker，按 `repos.<key>` profile 路由；不起第二套 launchd 实例 |
| falive 基线 | `feature/phase-3-api`（aven 的本地集成分支，不 fetch）；bot 分支 `lark/falive-<id>` 只本地 commit，aven 合回 |
| 别人负责的功能 | bot **跳过并 @ 负责人**（功能总表「前端」列），aven 本人点名要做的当次放行 |
| @aven 自动入队 | **打开**（`taskMentionOpenIds`，经只读意图分类） |
| 群消息读取权限 | 用户身份 `im` scope 已提交企业管理员审批，待批 |
| push | **不允许**，与 fameex 一致 |
| 执行器 | 只读分析 / 分诊 **Opus 4.8 `--effort high`**（分析要全面精确）；实施 **Opus 5.5 `--effort medium`**；意图 / 信息分类 **Sonnet 5.5**；鉴权保持 `local`（2026-10-13 从 Fable 5.1 改） |

## 2. 为什么不能直接拉群

- falive 的群是**外部群**（跨租户），Lark 不允许加应用机器人，只能加「自定义机器人」（webhook）。lark-bot 的事件源是应用机器人长连接，在这些群里**收不到事件**。
- 单仓硬编码：`consumerRoot=fameex-web`、临时 worktree 基线 `origin/online`、项目号只认 `PR/TR/PM-xxxx`、规则是 docs_tdd 的 fameex 快照、prompt 写死 `pnpm --filter fameex`。falive 群没有项目号 → 旧逻辑会走 adhoc 在 **fameex-web** 上开分支。

## 3. 链路

```text
falive 群（外部群，无应用机器人）
  │ 用户身份轮询 lark-cli im +chat-messages-list（阶段③，待 im scope 审批）
  ▼
Gateway ingest：chatIds → repo profile → project=FALIVE, task.repo=falive
  │  @aven / @所有人 → Sonnet 只读意图分类 → bug / 需求才入队
  ▼
Worker：profile.root 上 git worktree add（基线 feature/phase-3-api）→ lark/falive-<id>
  │  规则 profile=falive（CLAUDE.md 固定前提 + 硬规则 required，add-module / msw-policy / coding-quality 按信号）
  │  Opus 4.8 high 只读分析（含 ownership 判定）→ Opus 5.5 medium 实施 → biome / 相关测试 / tsc
  │  别人负责 → no_change_needed(other_owner) + @ 负责人
  ▼
结果卡：profile.webhook（自定义机器人）；试运行期无 webhook → 改投 notifyChatId（aven 私聊）
```

webhook 发出的卡片没有 `message_id`，不能作为「回复卡片」的锚点；控制通道改用**回复原任务消息**或显式指令 `继续任务 <id>` / `取消任务 <id>` / `结单 <id>`（已有能力）。

## 4. 配置（`runtime/lark-bot.local.json` → `repos.<key>`）

| 键 | 说明 | falive 当前值 |
|---|---|---|
| `root` | 业务仓绝对路径（必填） | `/Users/aven/github/falive-react` |
| `baseRef` / `fetchBase` | 临时 worktree 基线；远端 ref 才 fetch | `feature/phase-3-api` / `false` |
| `projectKey` | 任务的 `project` 值（大写，缺省 = key 大写） | `FALIVE` |
| `branchPrefix` | 临时分支前缀（缺省 `lark/<key>`） | `lark/falive` |
| `worktreesDir` | 临时 worktree 目录（缺省 `<root>/../.lark-<key>`） | `~/github/.lark-falive` |
| `chatIds` | 属于该仓的群（优先于群名解析项目号；视同白名单） | 待 im scope 批下来后填 |
| `taskMentionOpenIds` | 该仓群里 @ 谁会触发只读意图分类（与全局叠加） | aven |
| `webhook` | `{ file }` 指向 0600 JSON（`webhookUrl` / `secret`）或 inline `{ url, secret }` | 试运行期未配 |
| `notifyChatId` | 无 webhook 时改投（私聊 open_id 或群） | aven 私聊 |
| `docs` | 注入 prompt 的项目文档（仓库相对） | CLAUDE.md、交付路线图、功能总表、对接状态总览 |
| `readableDirs` | `--add-dir` 只读放行的目录 | `x9_web_react` |
| `ruleProfile` | 规则来源表（`fameex` / `falive`） | `falive` |
| `installArgs` / `checksHint` | 依赖安装参数；仓库特有检查提示 | `install --frozen-lockfile --prefer-offline` / msw-audit |
| `scopeBudgets` | 行数上限覆盖 | bugfix 200 / qa_feedback 300 / requirement 1200 |
| `ownership` | `{ me, meOpenIds, table }` 归属规则 | me=aven，表=功能总表 |
| `ownerMap` | 人名 → open_id（结果卡 @ 负责人用） | 待补 |
| `claudeModel` / `claudeEffort` | 实施阶段模型 | opus-5-5 / medium |
| `claudeAnalysisModel` / `claudeAnalysisEffort` | 只读分析 / 分诊阶段模型 | opus-4-8 / high |
| `claudeIntentModel` | 意图 / 信息分类模型 | sonnet-5-5 |
| `aiTimeoutMs` | 该仓 AI 硬超时（必须 < `LARK_TASK_LEASE_MS`，launchd wrapper 已设 75min） | 60min |

默认仓 `fameex` 不写也存在，行为与拆仓前一致；`repos.fameex` 只允许覆盖模型 / 预算 / 人员表。

## 5. 改动面（代码）

| 文件 | 变化 |
|---|---|
| `lib/lark-repo-profile.mjs`（新） | profile 归一 / 注册表 / 群→仓 / projectKey 放行 / 投递决策 / webhook 凭据 |
| `lib/lark-webhook.mjs`（新） | 自定义机器人 webhook：签名、body、重试 |
| `lib/lark-cli.mjs` | `sendChatMessage` 先问 `resolveRepoDelivery`：webhook / 改投 / 原 bot 发送 |
| `lib/lark-work-context.mjs` | 路由全部按 profile；`safeProject` 放行已注册 projectKey；上下文带 `repo / repoRoot / ruleProfile / baseRef / fetchBase` |
| `lib/lark-worker-git.mjs` | `prepareTempWorktree` / `finalizeTempWorktree` 接 `repoRoot` / `fetchBase`；fetch 按 `<remote>/<branch>` 拆 |
| `lib/lark-ai-executor.mjs` | claude 四种命令带 `--model` / `--effort`；`claudeIntentModel`；profile.readableDirs 进 `--add-dir`；按仓超时 |
| `lib/lark-rule-context.mjs` | `ruleProfile` 路由表（falive 读仓内 CLAUDE.md / add-module / msw-policy）；新增 `module` 信号 |
| `lib/lark-worker-prompts.mjs` | 安装 / 检查 / 红线 / 基线说明按 profile；归属判定段；分析输出含 `ownership` |
| `lib/lark-worker-run.mjs` | 规则 profile、模型、预算按仓；**归属闸** `resolveOwnershipOutcome` |
| `lib/lark-task-runner.mjs` | 透传 repoRoot / fetchBase / installArgs / 预算 / profile |
| `lib/lark-ingest.mjs` / `lib/lark-routes.mjs` | profile 群 → `project=projectKey, task.repo`；`POST /lark/tasks` 接受 `repo` |
| `lib/lark-status.mjs` / `lib/lark-cards.mjs` | `other_owner` 结果卡 @ 负责人；ownerMap 叠加 profile |
| `lib/lark-config.mjs` | `configTitleFor` 认 projectKey；`validateConfig` 校验 repos |
| `schemas/lark-ai-analysis.schema.json` | 可选 `ownership` |
| `lark-gateway.mjs` / `lark-worker.mjs` | 启动注册 profile；worker 对各仓模型做就绪探针；租约断言取各仓最大超时 |
| `runtime/launchd-node.sh` | `LARK_TASK_LEASE_MS` 默认 75min |

## 6. 群消息轮询器（阶段③，待 im scope）

用户身份 `lark-cli im +chat-messages-list --as user --chat-id <oc> --start <上次时间>`，按 message_id 幂等后喂给 `ingestLarkEvent`。频率（aven 定）：08:00–19:00 活跃（30 分钟内有新消息）30s、空闲 120s；19:00–08:00 15min；拉取出错退避到 15min，连续失败 10 次发告警给 aven。bot 自己的 webhook 卡片 `sender_type` 非 `user`，摄入前丢弃。

## 7. 日报（阶段②）

每天 19:00。aven 的工作看本地 `feature/phase-3-api`，其他人看 `origin/pre`（aven 要求每人每天至少 MR 一次到 pre）。脚本确定性采集（当天提交按作者、功能总表状态与昨日快照 diff、交付路线图的「还差什么 / 卡在谁」、inbox），再由 Fable 按固定模板写：整体进度 / 今日完成（按人）/ 未完成与卡点 / 今日 pre 无提交的人 / 需要支持。试运行一周只私发 aven。

## 8. 试跑与运维

```sh
lark-bot restart && lark-bot status           # worker 日志应出现 repo falive: claude model=claude-opus-5-5 … analysis model=claude-opus-4-8 probe=passed
# 手工投一条 falive 任务（group 未接入前的试跑入口）
curl -s -X POST http://127.0.0.1:3005/lark/tasks \
  -H "x-lark-gateway-secret: $(cat ~/.config/fameex-lark/gateway-secret)" -H 'Content-Type: application/json' \
  -d '{"id":"manual-falive-001","source":"lark","repo":"falive","operator":"ou_91861d6da6cf6822e08045ba1868241e","text":"修复：…"}'
git -C ~/github/falive-react branch --list 'lark/falive-*'   # bot 产出的分支
```

审计在 `runtime/lark-audits/FALIVE/`，附件在 `runtime/lark-attachments/FALIVE/`。
