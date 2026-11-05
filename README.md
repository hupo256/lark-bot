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

完整链路见 [docs/guide/overview-workflow.md](./docs/guide/overview-workflow.md)。

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

launchd 直接运行本仓代码。**往本目录合代码 = 几分钟内上线**：排空重启（默认开，`lib/lark-drain-restart.mjs`）发现磁盘代码 / 配置变了，worker 就不再领新任务，在飞任务跑完后先自检（代码改了跑全量单测，配置改了做启动校验），绿了自动 `lark-bot restart`；红了不重启、私信 `notifyOpenId` 一次，继续跑旧代码。只改文档不触发。排空重启关着（`selfHeal.drainRestart=false` / `LARK_DRAIN_RESTART=0`）或不是 launchd 托管时，仍要手动 `lark-bot restart`。`status` 提示 `codeStale` / `configStale` 说明进程还在跑旧代码或旧配置。

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

## 2026-11-05 更新：falive 实战回放后上线

用 falive bot 10-14 → 11-03 的 285 个真实 case 离线回放、逐条和 falive 当时对比，分六批修完后上线（60c6230）。同一批 125 个 case 上，lark-bot 更好 54 / falive 更好 23；首句中位 12 秒（falive 47 秒），结论中位 1.4 分钟（falive 4.4 分钟）。过程与逐轮成绩见 [docs/replay/falive-replay-plan-2026-11-03.md](./docs/replay/falive-replay-plan-2026-11-03.md) 第 60–65 条。

### 新功能

| 功能 | 说明 |
|---|---|
| 「@bot 没回」巡检 | 群里直接 @bot 的消息一进来就开一条回复义务；30 分钟后仍没任何回话（含并进的单回给同一提问人）、负责人也没为它收到私信、相关单已不在跑 → 私信负责人一次，不发群。挂在网关 15 分钟一次的挂起巡检里 |
| 测试号登录工具 `tools/env-login.mjs` | `node tools/env-login.mjs --env pre [--account <登录名> --password <密码>] [--token [名]] [--fresh]`：只登录（不注册、不改数据），20 分钟内复用登录态，密码 / token 不打印；`--token hichat_token` 取同次登录的具名凭证。对方消息里给的账号也走它。配置 `testAccounts.<环境>` |
| 出网命令层拦截 | 代答 / 实测只许打 `envSites` 里的环境 + 本机；改代码 / 自测另许读 npm / GitHub / PyPI / 业务仓 git 主机。写请求只放登录（含验证码登录）。靠 PATH 里的 curl 壳（`tools/egress-guard/bin`）+ node 预载（`tools/egress-guard/preload.mjs`）在进程层拦，权限档是 auto 还是跳过权限都生效。口径 `lib/lark-egress-policy.mjs` |
| 造测试数据例外 | 原话明确要造测试数据（「生产 / 制造 + 数量 + 数据 / 帖」）且环境在 `testData.envs` 里时，放开用测试号建测试内容，默认不放 |
| 负责人本人交办不再干等 | 负责人自己发的单、分析停下只为请他拍板 → 按建议做完，完成说明写清怎么选的供复核；缺账号 / 凭证 / 环境或不是他发的照旧停 |
| 交付前回看新消息 | 结论在向人要东西时，先看本条之后群里 / 话题里的新消息，要的已经给了就直接用上，不再重复要 |
| 提交前缀 `commitPrefix` | 收尾提交标题前缀读配置，满足业务仓 commit-msg 钩子 |

### 主要修复（按类）

- **该回没回**：续跑回话按「同内容 + 同一条消息」去重（原来按内容 24 小时去重，第二次续跑的回话被吞）；光一条「@bot」不再被丢；回 bot 卡片说「重新接一下」「404 已处理请重新接入」不再被当成结单或同事闲聊；话题里回负责人的照常分类；分类失败不再先发「收到」再永远静默。
- **重复回 / 回错人**：只是催或重复同一请求不再重跑出第二份结论；并入的单这轮结论回给并进来的那条、提问人不换；代答结论行首 @ 提问人，待跟进只 @ 要动手的人；私信续跑后群里不再重复 @ 同一批人。
- **判断不准**：挂起任务话题里同事互相说话不再当补料续跑；「关闭直播间礼物入口」这类带产品宾语的不算结单；问「做完了没」才算问结单；OL 认作 online、多环境共用主域按整个主机名认；botSelf 只认明说要改机器人自己。
- **卡住不交付**：改码不再被模块归属 / 行数上限卡住（改码边界只按需求）；对接答复里「再要文档 / 再确认」不再停机；实测可发登录 POST 拿登录态；零改动闸认本单分支上已有的提交。
- **说的不实**：实测 diff 只有注释 / 文档时不再说「已修复」；代答说环境现状要本轮实测，旧结论不当现状；部署信不再承诺 lark-bot 没有的「部署后自动复测」。

## 目录

| 路径 | 内容 |
|---|---|
| `lark-gateway.mjs` / `lark-worker.mjs` / `lark-bugtable-poller.mjs` | 三个进程的装配入口（import 无副作用，调用 `runLark*()` 才启动） |
| `lib/` | 各职责模块；`lib/lark-paths.mjs` 是唯一路径基座，`lib/vendor/` 是从 docs_tdd 复制来的少量函数 |
| `rules/` | docs_tdd 冻结规则快照（只读，见 `rules/README.md`） |
| `schemas/` | AI 结构化输出的 JSON Schema（分析 / 结果 / triage / 意图分类） |
| `runtime/` | launchd 薄包装、plist、`launchd-node.sh`；本机配置与运行态（gitignore）也放在这里 |
| `scripts/` | `lark-bot` CLI、`lark-bot-shim`、`code-rules.mjs`（代码规则扫描器副本）、`figma-spec.mjs`、`test-affected.mjs` / `test-all.mjs`（按 import 关系挑相关测试 / 合并前全量） |
| `scripts/sim/` / `replay/falive/` | falive 实战离线回放台与 285 个 case 数据（11-05 回放已结项，留作历史与将来离线回归；`replay/falive/` 是内部群聊数据，不要 push） |
| `tools/` | 给 worker 里 AI 用的工具：`env-login.mjs`（测试号登录）、`env-version.mjs`（查环境版本）、`verify-page.mjs`（页面验证）、`read-bug-record.mjs`（读 bug 单）、`egress-guard/`（出网拦截） |
| `docs/` | 文档：`guide/` 运维手册、`plan/` 方案与待办、`replay/` falive 回放（已结项）、`notes/` 台账与分析；入口 [docs/README.md](./docs/README.md) |
| `__tests__/` | `node --test` 单测 |

## 路径与配置

路径统一在 `lib/lark-paths.mjs` 解析，优先级 env > `runtime/lark-bot.local.json` > 默认值：

| 名称 | env | local.json 键 | 默认 |
|---|---|---|---|
| 业务主仓 `consumerRoot` | `LARK_BOT_CONSUMER_ROOT` | `consumerRoot` | `/Users/aven/github/fameex-web`（worktree 建在它的同级目录） |
| PRD 缓存 `prdCacheRoot` | `LARK_BOT_PRD_CACHE` | — | `~/.prd-cache`（只读） |

`runtime/lark-bot.local.json` 的常用键：`project` / `title`、`botOpenId`、`taskMentionOpenIds`、`allowedChatIds` / `allowedOpenIds`、`aiExecutor`、各执行器的模型键（`codexModel`、`piModel` 等）、`scopeBudgets`、`bugTable`、`verify`（页面验证工具：本地 dev 命令 / 已部署站点 / 登录模块，见 `tools/verify-page.mjs` 文件头与 `docs/notes/port-from-falive-2026-10-24.md` #61）。字段含义见 [docs/guide/gateway-and-worker.md](./docs/guide/gateway-and-worker.md) §6。
2026-10-24 从 falive 实践移植回来的可选键（都可不配，见 [docs/notes/port-from-falive-2026-10-24.md](./docs/notes/port-from-falive-2026-10-24.md)）：`claudeModel` / `claudeEffort`（实施模型与强度）、`claudeAnalysisModel` / `claudeAnalysisEffort`（只读分析 / 分诊阶段单独指定）、`claudeIntentModel` / `claudeIntentEffort`（前置意图分类单独指定，11-02 起；fameex 配 Opus + low：53 条回归集实测比 high 中位快 40%、无新增误判，换 Sonnet / Haiku 不更快还漏判，换前先跑 `node scripts/lark-replay-intake.mjs --fixture __tests__/fixtures/intake-regression-1102.json --live`）、`finalChecks`（worker 独立终检：`{ typecheck: [cmd, ...args], tests: [cmd, ...args], timeoutMs }`）、`claudeMemoryDir`（bot 的 worktree 与主仓共用的 Claude 项目记忆目录，缺省按业务主仓推导）。
对应的环境开关：`LARK_KEEP_AWAKE=0`（关掉开盖防空闲睡眠）、`LARK_WAKE_CATCHUP=0`（关掉开盖补拉）、`LARK_TASK_BUDGET_MS`（单任务总预算，默认 150 分钟）。
2026-11-01 对话层（人话出口、五类分类、任务契约、负责人私信主通道）的可选键：`ownerMap` / `memberRoles` / `internalNames`、`intake`、`envSites`、`docIdentity`、`joinGreeting`、`digest`、`personaPath`，见 [docs/guide/gateway-and-worker.md](./docs/guide/gateway-and-worker.md) §6 末尾；运行态多了 `runtime/lark-outbox/`（发件簿）、`runtime/lark-obligations/`（回复义务）、`runtime/persona/aven.md`（负责人 persona，手写）、`runtime/people.json`。分类回放：`node scripts/lark-replay-intake.mjs [--live]`。
2026-11-02 上下文与环境知识的可选键：`recentContextHours`（「群里这条之前的消息」近几小时全留，默认 4；更早的只留 bot 自己最近 3 条和本人最近 2 条；配 0 = 不截，旧行为）、`envBranches`（环境 → 分支，默认同名，如 `{ "prod": "online" }`）。负责人维护的固定知识放 `runtime/knowledge/*.md`（gitignore，每条任务现读、改了不用重启），只读答疑 / 实测 / 状态查询的提示里带上；查各环境当前跑的提交：`node tools/env-version.mjs [环境…] [--no-fetch] [--json]`（读 `envSites`，抓站点 `/version` 与新站资源路径 `/wn/<sha>/`，再核在不在对应分支、落后几个）。
2026-11-02 fameex 日报的可选键 `dailyReport`（`{ enabled, at: "19:00", days: [1, 2, 3, 4, 5] }`，默认开、工作日 19:00）：只私发负责人（`notifyOpenId`），私信「发日报 / 重发日报」随时要，见 [docs/guide/gateway-and-worker.md](./docs/guide/gateway-and-worker.md) §6 末尾；记账 `runtime/lark-daily-report-state.json`。
2026-11-02 闲置群自动退出的可选键 `chatRetention`（`{ enabled, idleDays: 14, graceHours: 48, at: "09:35", keep: [chat_id] }`，默认开）：14 天没人 @bot 的群先私信负责人，48 小时后还没人找就退群；bug 表群、`keep` 里的、私信「留下 关键字」标过的永远不退，私信「退群列表」查看。退群要应用开通 `im:chat`、`im:chat.members:write_only`。见 [docs/guide/gateway-and-worker.md](./docs/guide/gateway-and-worker.md) §6 末尾；记账 `runtime/lark-chat-activity-state.json`。
2026-11-05 的可选键：`testAccounts.<环境>`（测试号与登录方式，`tools/env-login.mjs` 用，口径见 `lib/lark-env-login.mjs` 文件头）、`testData`（`{ envs: ['pre'], account? }`，原话明确要造测试数据时放开的环境）、`egress.loginCodeTypes`（算作登录的验证码类型）、`commitPrefix`（收尾提交标题前缀）。运行态多了 `runtime/lark-env-login/<环境>.json`（登录态，0600）。

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
| [docs/guide/overview-workflow.md](./docs/guide/overview-workflow.md) | 入门：架构、一条消息的旅程、信任模型、配置运维 |
| [docs/guide/gateway-and-worker.md](./docs/guide/gateway-and-worker.md) | 长连接接入、命令与 Job、执行器与审计 |
| [docs/guide/task-boundaries-and-reply.md](./docs/guide/task-boundaries-and-reply.md) | 生命周期、自动执行 / 确认边界、范围契约、任务控制通道与回复策略 |
| [docs/guide/runtime-and-scheduling.md](./docs/guide/runtime-and-scheduling.md) | 长连接健壮性、附件保留期、bug 表路由、并行调度 |
| [docs/notes/port-from-falive-2026-10-24.md](./docs/notes/port-from-falive-2026-10-24.md) | 从 falive 实践移植回来的通用能力台账：每项的来源教训、配置键、真机验法；以及刻意没搬的 |
| [docs/plan/plan-iteration-2026-11-05.md](./docs/plan/plan-iteration-2026-11-05.md) | 上线后实战迭代（11-05 定稿）：线上验收线、批 1 衡量与纠错 → 准 → 省 → 数字分身 |
| [AGENTS.md](./AGENTS.md) | 在本仓改代码的 agent 规则 |

## 开发与测试

三层，别每改一处就跑全量：

```sh
node --check lib/<file>.mjs            # 改动的文件
node scripts/test-affected.mjs         # 改的过程中：按 import 关系反查，只跑相关测试（--list 只看挑了哪些）
node scripts/test-all.mjs              # 合并进运行分支前：全量 + 运行时间预算（18 秒）
```

本仓没有 Biome / tsc。`rules/` 是只读快照；`scripts/code-rules.mjs` 不要直接改，要从权威版本同步（见 `AGENTS.md`）。
