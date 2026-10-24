# lark-bot

to: 人类
用 lark-cli 的能力搭建的 AI Bot，用来自动处理 Lark 群里 @bot 或 @我 的消息，同时也处理 bug 列表里分配到我头上的 bug。拿到信息后会：自动分析 → 生成 task → 调用 AI coding → 更新 bug 状态 → 结果回群。

to: AI
FameEX 本机常驻的 Lark 自动处理服务：群里 @ 机器人（或 bug 多维表格派单）→ 本地 worker 调 AI CLI（claude / codex / pi / cursor）在 fameex-web 的 git worktree 里改代码 → 终检 → **只做本地提交，从不 push、不开 PR** → 结果卡片回群。

2026-10-11 从 docs_tdd `common/lark-bot/` 带历史拆出，不再依赖 docs_tdd 的任何代码。

## 工作方式

三个进程由 macOS launchd 托管，机器级单例，不依赖公网 tunnel：

| 进程 | 角色 | 常驻方式 |
|---|---|---|
| `lark-gateway.mjs` | `lark-cli` 长连接收群事件，白名单 / 幂等 / 入队；本地 HTTP 任务队列 `127.0.0.1:3005`（写接口要共享密钥）；发回执卡片 | 常驻 |
| `lark-worker.mjs` | 认领任务，按 worktree 并行（同一 worktree 串行），spawn AI CLI 执行、终检、本地 commit | 常驻 |
| `lark-bugtable-poller.mjs` | 轮询 bug 多维表格的待处理 / 验退记录并投递；done 后回写表格状态 | QA 期手动开，空闲 4h 自动收工 |

非只读任务都走两阶段：先**只读分析**，产出结构化的修改范围契约（scope contract）；再进入实施。收尾时 worker 按实际改动核对契约，越界、碰禁区或超出行数上限都不提交，任务挂起，等人回复卡片「确认扩大范围」。回复 bot 卡片是任务控制通道（结单 / 重开 / 续跑 / 查状态 / 确认），不会新建任务。

完整链路见 [docs/overview-workflow.md](./docs/overview-workflow.md)。

## 安装与启动

前置条件见下文「依赖」。首次在本机启用：

```sh
# 1. 机器级配置（gitignore，不进仓库）：项目、白名单、执行器与模型、bug 表字段映射
$EDITOR runtime/lark-bot.local.json

# 2. 安装 CLI 薄入口（入口路径或参数契约变了要重装）
cp scripts/lark-bot-shim ~/.local/bin/lark-bot && chmod +x ~/.local/bin/lark-bot

# 3. 启动：安装 launchd plist、生成 gateway 密钥、等待 gateway 与 worker 就绪
lark-bot start
lark-bot status
```

launchd 直接运行本仓代码。**改完代码不会自动生效**，要执行 `lark-bot restart`。如果 `status` 提示 `codeStale` / `configStale`，说明进程还在跑旧代码或旧配置。

## CLI

| 命令 | 作用 |
|---|---|
| `lark-bot start` / `stop` / `restart` | 启停 gateway + worker（`stop` 同时停 poller；`restart` 会恢复 poller 原来的状态） |
| `lark-bot status` | 进程健康、执行器 / 模型就绪、任务积压、挂起任务明细、代码 / 配置是否过期；异常时退出码非零 |
| `lark-bot doctor [--json]` | 运行态体检：gateway / worker / 版本 / bug 表轮询 / 挂起超 24h / failed 积压 / 7 天失败与复发指纹 / 待处理自修工单，每项给等级、一句话和建议动作；有 warn / bad 退出码非零。worker 里每小时自动跑一次，异常私信 `notifyOpenId`（`selfHeal.doctor=false` / `LARK_DOCTOR=0` 只关定时） |
| `lark-bot logs` | tail gateway / worker 日志（`~/Library/Logs/fameex-lark/`） |
| `lark-bot poll-on` / `poll-off` | 开关 bug 表轮询 |
| `lark-bot failed` | 列出 failed / blocked 任务 |
| `lark-bot retry <taskId>` | 把 failed / blocked 任务重置为 queued |
| `lark-bot close <taskId> [reason] ["说明"]` | 终端结单（与群里回复卡片「结单」同一方法，只改状态不发卡；卡片找不到时用） |
| `lark-bot resume <taskId> "<补充>"` | 终端续跑挂起 / 阻塞任务（等价于回复卡片「继续任务 <id> <补充>」） |
| `lark-bot receipt-retry <taskId>` | 重发回执卡片 |
| `lark-bot clean [hours]` / `clean --failed [hours]` | 清理陈旧终态任务（默认只清 done） |
| `lark-bot claude-auth [local\|proxy]` | 切换 claude 执行器鉴权（本机钥匙串 / `claude.env` 网关 key），切换后自动重启 |

## 目录

| 路径 | 内容 |
|---|---|
| `lark-gateway.mjs` / `lark-worker.mjs` / `lark-bugtable-poller.mjs` | 三个进程的装配入口（import 无副作用，调用 `runLark*()` 才启动） |
| `lib/` | 各职责模块；`lib/lark-paths.mjs` 是唯一路径基座，`lib/vendor/` 是从 docs_tdd 复制来的少量函数 |
| `rules/` | docs_tdd 冻结规则快照（只读，见 `rules/README.md`） |
| `schemas/` | AI 结构化输出的 JSON Schema（分析 / 结果 / triage / 意图分类） |
| `runtime/` | launchd 薄包装、plist、`launchd-node.sh`；本机配置与运行态（gitignore）也放在这里 |
| `scripts/` | `lark-bot` CLI、`lark-bot-shim`、`code-rules.mjs`（代码规则扫描器副本）、`figma-spec.mjs`、`test-affected.mjs` / `test-all.mjs`（按 import 关系挑相关测试 / 合并前全量） |
| `docs/` | 运维手册，入口 [docs/README.md](./docs/README.md) |
| `__tests__/` | `node --test` 单测 |

## 路径与配置

路径统一在 `lib/lark-paths.mjs` 解析，优先级 env > `runtime/lark-bot.local.json` > 默认值：

| 名称 | env | local.json 键 | 默认 |
|---|---|---|---|
| 业务主仓 `consumerRoot` | `LARK_BOT_CONSUMER_ROOT` | `consumerRoot` | `/Users/aven/github/fameex-web`（worktree 建在它的同级目录） |
| PRD 缓存 `prdCacheRoot` | `LARK_BOT_PRD_CACHE` | — | `~/.prd-cache`（只读） |

`runtime/lark-bot.local.json` 的常用键：`project` / `title`、`botOpenId`、`taskMentionOpenIds`、`allowedChatIds` / `allowedOpenIds`、`aiExecutor`、各执行器的模型键（`codexModel`、`piModel` 等）、`scopeBudgets`、`bugTable`。字段含义见 [docs/gateway-and-worker.md](./docs/gateway-and-worker.md) §6。
2026-10-24 从 falive 实践移植回来的可选键（都可不配，见 [docs/port-from-falive-2026-10-24.md](./docs/port-from-falive-2026-10-24.md)）：`claudeModel` / `claudeEffort`（实施模型与强度）、`claudeAnalysisModel` / `claudeAnalysisEffort`（只读分析 / 分诊阶段单独指定）、`finalChecks`（worker 独立终检：`{ typecheck: [cmd, ...args], tests: [cmd, ...args], timeoutMs }`）、`claudeMemoryDir`（bot 的 worktree 与主仓共用的 Claude 项目记忆目录，缺省按业务主仓推导）。
对应的环境开关：`LARK_KEEP_AWAKE=0`（关掉开盖防空闲睡眠）、`LARK_WAKE_CATCHUP=0`（关掉开盖补拉）、`LARK_TASK_BUDGET_MS`（单任务总预算，默认 150 分钟）。

执行器的选择优先级：任务里的 `[claude]` / `[codex]` / `[pi]` / `[cursor]` 标签 > 配置 `aiExecutor` > 内置默认 `claude`。执行器在入队时锁定。

运行态（均 gitignore）：任务队列 `runtime/lark-tasks/`，附件 `runtime/lark-attachments/<PR>/<messageId>/`，审计 `runtime/lark-audits/<PR>/`。

> CLI、plist 和 shim 里写死了 `/Users/aven/...`，本仓目前只面向这一台机器。换机器或换路径时，要同步改 `scripts/lark-bot`、`scripts/lark-bot-shim`、`runtime/*.plist`，或者用 `LARK_BOT_ROOT` 覆盖。

## 依赖

- Node（launchd 用 `/opt/homebrew/bin/node`），无 npm 依赖。
- 已登录的 `lark-cli`（bot 身份存在 keychain）；用到的 AI CLI 已登录。
- `~/.ai-rules`（只读规则，L1）；`~/.config/fameex-lark/`：`gateway-secret`（`lark-bot start` 自动生成）、`claude.env`、`claude-auth`。凭据只放在这些 0600 文件里，不写进 plist。
- 内置 `scripts/code-rules.mjs` 代码规则扫描器：`~/.ai-rules` prd-to-commit 权威版本的钉版副本，零依赖，同步方法见 `AGENTS.md`。只报 error 级问题；豁免方式只有一种，即在行内或上一行写 `code-rules-ignore <RULE-ID>: <理由>`。脚本缺失或运行失败时记为 `ran:false`，不阻断。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/overview-workflow.md](./docs/overview-workflow.md) | 入门：架构、一条消息的旅程、信任模型、配置运维 |
| [docs/gateway-and-worker.md](./docs/gateway-and-worker.md) | 长连接接入、命令与 Job、执行器与审计 |
| [docs/task-boundaries-and-reply.md](./docs/task-boundaries-and-reply.md) | 生命周期、自动执行 / 确认边界、范围契约、任务控制通道与回复策略 |
| [docs/runtime-and-scheduling.md](./docs/runtime-and-scheduling.md) | 长连接健壮性、附件保留期、bug 表路由、并行调度 |
| [docs/port-from-falive-2026-10-24.md](./docs/port-from-falive-2026-10-24.md) | 从 falive 实践移植回来的通用能力台账：每项的来源教训、配置键、真机验法；以及刻意没搬的 |
| [AGENTS.md](./AGENTS.md) | 在本仓改代码的 agent 规则 |

## 开发与测试

三层，别每改一处就跑全量：

```sh
node --check lib/<file>.mjs            # 改动的文件
node scripts/test-affected.mjs         # 改的过程中：按 import 关系反查，只跑相关测试（--list 只看挑了哪些）
node scripts/test-all.mjs              # 合并进运行分支前：全量 + 运行时间预算（18 秒）
```

本仓没有 Biome / tsc。`rules/` 是只读快照；`scripts/code-rules.mjs` 不要直接改，要从权威版本同步（见 `AGENTS.md`）。
