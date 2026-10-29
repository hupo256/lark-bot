# Mac mini 服务器化迁移 + 团队化交接（2026-10-29）

> Lark Bot 子系统文档之一，索引见 [README.md](./README.md)。
> **读者**：在 Mac mini 上 clone 本仓后接着干的人或 agent（aven + Claude Code）。本文是交接：笔记本上现在跑着什么、这段时间的数据说明了什么、
> 要搬成什么样、分几步、哪些要 aven 拍板、每一步怎么验。读完本文再读 §9「在 mini 上怎么继续」。
> **基线**：本文写于分支 `feature/falive-repo-profile`（falive 线运行分支），全量单测 341 / 341 绿（12.2s）。fameex 线运行分支是 `fameex-stable`。
> **本文不改任何运行行为**；本次只落文档 + `.gitignore` 两行，代码改动都在 mini 上按 §6 分阶段做。

## 0. 一句话结论

1. 笔记本（M3 16G）上跑着 **两条 bot 线 + 一套仓库外脚本**，都用 aven 的身份、aven 的本地分支、aven 的路径。
2. 这段时间的故障分布里，**能归到「笔记本」这个环境的只会在服务器上消失**（睡眠 / 合盖 / 长连接重连），**绑死 aven 的那部分不会**——那是配置与设计，要在 mini 上分四批改成「负责人（principal）可配多人」。
3. 迁移分 **四个阶段**：① 原样搬（身份与行为一字不改，当天切换，可回滚）→ ② 服务器化（去掉笔记本假设、路径可移植、备份 / 监控）→ ③ 团队化（多负责人、路由、投递、bug 表、日报）→ ④ 两条线合一套代码（可选）。
4. **有 8 个决策要 aven 拍板**（§7），其中 D1（mini 用户名叫 `aven`）决定了阶段 ① 是「一天」还是「一周」，D3（bot 分支能不能 push）决定了团队能不能看到 bot 的产出。

## 1. 现状盘点：笔记本上跑着什么

### 1.1 三样东西

| 线 | 代码位置（worktree / 分支） | 进程（launchd label） | 端口 / 模式 | 服务对象 | 日志 | 业务仓 |
|---|---|---|---|---|---|---|
| **fameex 线**（"lark-bot"） | `~/github/lark-bot` @ `fameex-stable`（7781c10） | `com.fameex.lark-gateway` / `lark-worker` / `lark-poller` | 3005 / 完整模式：应用机器人长连接 `lark-cli event consume` + bug 表轮询 | fameex 内部群 @bot、bug 表「负责人=aven」 | `~/Library/Logs/fameex-lark/` | `~/github/fameex-web`（16 GB 含 node_modules） |
| **falive 线**（"falive-bot"） | `~/github/lark-bot-falive` @ `feature/falive-repo-profile`（c68d6fd） | `com.fameex.lark-falive-gateway` / `lark-falive-worker` | 3006 / `LARK_INSTANCE_MODE=repo-only`：**不建长连接**，用 **aven 用户身份**轮询外部群（`lark-cli --as user im +chat-messages-list`），出口走各群自定义机器人 webhook（"Aven.Bot"） | falive 两个外部群 + 「falive 控制台」群（bot 把它当 aven 私聊） | `~/Library/Logs/falive-lark/` | `~/github/falive-react`（544 MB）+ 只读 `~/github/x9_web_react` |
| **bugpoll**（仓库外） | `~/.lark-bugpoll/`（python + bash + `claude -p`，68 MB，**不在任何 git 仓库里**） | `com.aven.falive-bugpoll`（每 10 分钟，09:45–19:05） | 无端口；结果 POST 到 falive 线的 `/lark/notify` 代发控制台群 | falive bug 多维表格「负责人=aven」的待处理项 | `~/.lark-bugpoll/logs/` | 长期 worktree `~/github/falive-hotfix`（detached）、`~/github/falive-react-hotfix` |

另有 worktree `~/github/lark-bot-port` @ `lark/port-falive-generic`（10-24 从 falive 往 fameex 搬通用能力的分支，已快进合进 `fameex-stable`，可删）。

两条线共用同一个 Lark 应用（`botOpenId` 相同）、同一份 `~/.config/fameex-lark/`、同一个 `gateway-secret`。
fameex 线今天（10-29 06:44 UTC）刚被重启，10 月只有 2 条审计——**实际业务量几乎全在 falive 线**。

### 1.2 仓库外的东西（随迁清单，缺一样 bot 起不来或行为变）

| 类别 | 位置 | 内容 | 迁法 |
|---|---|---|---|
| 凭据 | `~/.config/fameex-lark/`（全部 0600） | `gateway-secret`（两实例共用）、`claude.env`（第三方网关 `ANTHROPIC_*` + `FIGMA_API_KEY`）、`claude-auth`（当前 `local`）、`falive-webhook-{php,fusion,console}.json`（三个群的自定义机器人 webhook） | `scp` 整目录，保持 0600；**不要**进仓库 |
| lark-cli 登录态 | macOS 钥匙串（profile = 应用 `cli_aabf…`，`defaultAs: auto`） | ① 应用机器人身份（app_id + app_secret，长连接 / 发卡 / 下载附件 / bug 表读写）② **aven 用户身份**（device-flow 登录的 user token，外部群轮询、建云文档、读 bug 表记录；`whoami` 显示 `onBehalfOf: Aven.tong`） | mini 上 `lark-cli config init` 填同一个 app_id / app_secret（secret 走 stdin，向 aven 要），再 `lark-cli auth login --domain im,docs,drive,base,wiki,contact` 做用户登录；`lark-cli whoami` 看齐；用户身份的 `im` scope 已批 |
| Claude 登录态 | 钥匙串（`claude-auth=local`） | aven 个人账号 OAuth；`proxy` 模式才用 `claude.env` 的 key | mini 上 `claude` 登录一次（需要一次 GUI/屏幕共享）；或切 `proxy`（见 D4） |
| 规则 L1 | `~/.ai-rules`（GitHub `hupo256/ai-rules`） | worker 每次起 AI 前读 `~/.ai-rules` 的 HEAD sha 与规则章节；缺了按 `VERIFY-RULE-004` fail-closed | `git clone`；版本号进审计 |
| bugpoll | `~/.lark-bugpoll/` | `run.sh` / `poll.py` / `deployed.py`（falive 线 deploy-watch 的 `onDeploy` 调它）/ `hotfix.sh` / `prompt.md` / `*.json` 状态（`handled.json` `state.json` `snapshot.json` `deployed-state.json`） | 阶段 ① `rsync` 原样；阶段 ③ 进仓（见 D8） |
| Claude 项目记忆 | `~/.claude/projects/-Users-aven-github-falive-react/memory/`（配置 `claudeMemoryDir`） | bot 的临时 worktree 软链到这里共用记忆 | 拷贝；路径随用户名变 |
| 业务仓 | `~/github/fameex-web` `~/github/falive-react` `~/github/x9_web_react`（GitLab `mgit.lgroup.co`） | bot 在它们旁边建临时 worktree（`.lark-falive/`、`PR-xxxx/`） | mini 上重新 clone；**aven 本地未推的分支不会跟过去**（见 §1.5 C1） |
| 运行态 | 本仓 `runtime/`（全部 gitignore） | 见附录 A 的 keep / drop 表 | 切换当天选择性拷贝 |
| 工具链 | `/opt/homebrew/bin/node`（launchd 用，v26）、nvm `v24.7.0`（shell / codex / pi）、pnpm 12、lark-cli 1.0.70、claude 2.1.289、codex 0.162、`/usr/bin/python3` 3.9（bugpoll，只用标准库）、git 2.50 | 见 §8.1 |

### 1.3 写死的本机假设

| 位置 | 写死了什么 | 影响 |
|---|---|---|
| `lib/lark-paths.mjs` | `DEFAULT_CONSUMER_ROOT=/Users/aven/github/fameex-web` | env `LARK_BOT_CONSUMER_ROOT` 或 local.json `consumerRoot` 可覆盖 |
| `scripts/lark-bot`（falive 线） | `REPO=/Users/aven/github/falive-react`、`LARK_BOT_ROOT=/Users/aven/github/lark-bot-falive`（`FALIVE_BOT_ROOT` 可覆盖）、`LOGDIR`、端口 3006、label | 用户名不同就要改脚本或 env |
| `scripts/lark-bot`（fameex 线）/ `scripts/lark-bot-shim` | `LARK_BOT_ROOT=/Users/aven/github/lark-bot` | 同上 |
| `runtime/*.plist`（两套各 2–3 个） | 每个 6 处 `/Users/aven/...`（wrapper、入口、WorkingDirectory、日志） | `lark-bot start` 把它们原样装进 `~/Library/LaunchAgents/` |
| `runtime/lark-bot.local.json`（两份，gitignore） | falive：`root` / `readableDirs` / `webhooksByChat[*].file` / `claudeMemoryDir` / `dailyReport.sweep.onDeploy`（`/Users/aven/.lark-bugpoll/deployed.py`）/ `repos.lark-bot.root` 与 `readableDirs`；fameex：`bugTable.myOpenId` 等 | 用户名不同要逐键改 |
| `~/.lark-bugpoll/*.py / *.sh` | `~/github/falive-hotfix`、bug 表 base/table/view、aven 的 open_id、控制台群 id | 用 `$HOME` 但分支 / 群写死 |

**结论**：如果 mini 上的用户也叫 `aven`，1.3 整表在阶段 ① 不用动；否则阶段 ① 要先做阶段 ② 的「路径可移植」。这就是 D1。

### 1.4 笔记本特有机制（服务器上要关或自然失效）

| 机制 | 文件 | 服务器上 |
|---|---|---|
| 开盖不空闲睡眠 `caffeinate -i -w <gateway pid>` | `lib/lark-keep-awake.mjs` | `LARK_KEEP_AWAKE=0`（mini 用 `pmset` 禁睡眠即可，不要再挂断言） |
| 合盖检测 `ioreg AppleClamshellState`、轮询 / 领任务暂停 | `lib/lark-power.mjs`、`lib/lark-chat-poller.mjs` `pausedByLid` | mini 没有盖，自然恒为「开盖」；保留代码无害 |
| 开盖补拉群消息 | `lib/lark-wake-catchup.mjs` | 不会触发；`LARK_WAKE_CATCHUP=0` 显式关掉减少日志 |
| 「本轮期间系统睡眠过，失败不计数」 | `lib/lark-chat-poller.mjs` | 不会触发 |
| bugpoll「launchd 合盖后唤醒会补跑错过的点」 | `~/.lark-bugpoll/run.sh` 时间窗 | 可以收窄为纯定时 |

### 1.5 搬到服务器后**必然变化**的三件事（不是 bug，是前提变了）

- **C1 bot 不能再合进 aven 的本地分支。** falive 现在的基线 / 合回目标是 aven 主目录里的本地分支 `feature/phase-5-test`（`fetchBase:false`、`mergeBack.upstream: origin/pre`，做完 no-ff 合进主目录分支）。mini 上是另一份 clone，主目录不在那里。阶段 ① 必须改成：`baseRef` 跟远端（aven 把 `feature/phase-5-test` 推上去，`fetchBase:true`），`mergeBack` **先关**（任务停在 `lark/falive-<id>` 分支上），aven 用 SSH 把 mini 加成 git remote 来 fetch bot 分支（§8.6）。长期走 D3。
- **C2 日报里「aven 的工作」也不能读本地分支。** `lark-daily-report.mjs` 现在用「本地 `feature/phase-5-test` 当天提交 + 工作区未提交数」算 aven，其他人用 `origin/pre`。mini 上统一改读远端 ref（阶段 ③ 的日报项顺手做；阶段 ① 接受「aven 当天未推的工作不进日报」）。
- **C3 bugpoll 的 `falive-hotfix` worktree 要在 mini 上重建**（`deployed.py` 要在它里面 fetch `origin/pre` 和 MR ref）。

## 2. 这段时间的运行数据（2026-10-11 → 10-29）

### 2.1 开发节奏

| 指标 | 值 |
|---|---|
| falive 线提交（10-11 起） | 345（W41 6 / W42 142 / W43 170 / W44 27） |
| 教训台账 `docs/falive-lessons.md` | 97 条（#1–#96 + 1 条附加）；不变量 I1–I9 |
| 测试 | 341 个全绿，12.2 s（预算 18 s）；提示词三档预算 / 闸注册表 ≤ 16 / 体量预算 / 测试条数棘轮都由测试锁死 |
| 代码体量 | `lib/` 109 个模块 19.1k 行；`__tests__/` 17.9k 行 |
| 与 fameex 线分叉点 | `465cfd8`；fameex-stable 独有 14 个提交全是「从 falive 搬回去」+ 2 个 fameex 侧修复，**两个修复 falive 线都已有**（`launchctl enable`、bug 表人工结单不被清理） |

### 2.2 业务量与结果（falive 线）

| 数据源 | 窗口 | 数字 |
|---|---|---|
| 审计 `runtime/lark-audits/FALIVE/*.json` | 10-22 → 10-29（更早的已被保留期清掉） | 197 条工单终态：**done 69 / no_change_needed 9 / waiting_confirmation 10 / blocked 5 / failed 1 / ignored 44**（其余 56 是入库中间态）。按日 107 / 58 / 34 / 94 / 60 / 54 / 19 个审计文件 |
| 对接台账 `runtime/lark-ledger/falive.json` | 10-14 → 10-29 | 137 条目（applied 78 / answered 14 / asked 11 / open 14 / noted 18 / verified 2）、201 次事件；高峰 10-21/10-22 各 32/37 次 |
| 发件簿 `runtime/lark-outbox/`（7 天保留） | 10-22 → 10-29 | 群里发出 **123 条**：ack 58 / done 50 / blocked_ask 19 / noted 5 / daily_report 5；出口闸拦下 15 |
| 入口指标 `lark-bot intake-stats falive 30` | 近 30 天（任务库只剩 24h） | 收到 → 第一条群里可见输出 **中位 21 s**；收到 → 分类完成中位 20 s |
| 日报 | 10-13 → 10-28 | 12 份（短版 + 完整版云文档），每份带 facts |
| 任务库 `runtime/lark-tasks/`（24h 自动清） | 10-28/29 | 11 条：日报 1、日清扫 1、部署复测 8、群 @ 2 |

解读：**做成的占终态的 ~75%**（69+9 / 94 非 ignored 终态），挂起等材料 ~16%，真失败 1 条；44 条 ignored 是「没 @bot / 不是任务」的正确静默。延迟瓶颈不在机器，在分类 + 轮询间隔（20 s）。

### 2.3 故障分类（台账 + 日志）

| 来源 | 数字 | 说明 |
|---|---|---|
| 台账 97 条按类别 | 逻辑 35 / bot 逻辑错 10 / 机制 7 / 闸 2 / 规则组合 6 / **噪音 1** / 待分类 35 | 台账里**只有 1 条**明确标「环境」类根因（#35 夜里合盖 Power Nap 半醒导致轮询超时告警）；绝大多数是 bot 判断 / 流程问题，**搬机器解决不了** |
| falive gateway.log（10-20 起 1.4 MB） | `keep-awake` 91 行；「本轮期间系统睡眠过」**5 次（10-27 → 10-29 三天）** | 笔记本睡眠直接打断轮询 |
| fameex gateway.log（8 月起 15 MB） | `feishu-websocket: reconnecting` **1,559 次**（attempt 1 1,227 / 2 199 / 3 56 / 4 35 / 5 24 / 6 18） | 长连接随网络 / 睡眠频繁重连；服务器 + 有线网后这类应趋近 0 |
| `pmset -g` | `sleep 1 (sleep prevented by caffeinate ×4)` | 现在靠四个 caffeinate 顶着 |

### 2.4 资源占用（给 M1 16G 定并发）

| 进程 | RSS |
|---|---|
| falive gateway / worker | 42 MB / 41 MB |
| fameex gateway / worker | 24 MB / 33 MB |
| `lark-cli event` 守护 | 11 MB |
| 每条在跑的 `claude -p` 会话 | 经验值 0.5–1.5 GB（含 Bash 里起的 tsc / vitest 再 +1–2 GB） |
| 磁盘 | fameex-web 16 GB、falive-react 0.5 GB、审计 104 MB、附件 17 MB |

**建议**：mini 上两实例合计同时在跑的 AI 会话 ≤ 3（falive `concurrency: 2`、fameex `LARK_WORKER_CONCURRENCY=1`，bugpoll 单锁），磁盘预留 ≥ 100 GB。

## 3. 目标架构（mini 上）

```text
Mac mini M1 16G · macOS · 用户 aven（自动登录，解锁钥匙串）· 有线网 · pmset 永不睡
├─ ~/github/lark-bot            @ <运行分支>   ── 实例 fameex ── gateway:3005 + worker + poller（长连接 + bug 表）
├─ ~/github/lark-bot-falive     @ <运行分支>   ── 实例 falive ── gateway:3006 + worker（repo-only：用户身份轮询 + webhook 出口）
│     两实例互不可见（不变量 I8），只有一条应用机器人长连接
├─ ~/github/fameex-web · falive-react · x9_web_react（bot 自己的 clone，只读基线来自 origin/*）
├─ ~/.config/fameex-lark/（凭据）· ~/.ai-rules · ~/.lark-bugpoll（阶段 ③ 进仓）
├─ 远程访问：SSH（Tailscale 或局域网）→ `lark-bot status` / `lark-bot logs` / `git fetch mini`
└─ 身份：阶段 ①② 仍是「应用机器人 + aven 用户 token + Aven.Bot webhook」；阶段 ③ 按 D2 换成团队身份
```

团队化后（阶段 ③）的消息走向：

```text
群里 @bot（内部群：长连接；外部群：用户身份轮询）
  → 定负责人 principal：显式 @ 的人 > 归属表（功能 / 模块 → 人）> 发送人本人是团队成员 > 团队默认人
  → 该人的 DM（应用机器人 p2p）收「疑似 / 开始 / 结果 / 要材料」，DM 里回话 = 对上一条通知说的（现有 principal-channel 机制按 senderOpenId 已经能区分）
  → bot 分支 lark/<repo>-<id>（基线 origin/<该人的 baseRef>）→ 终检 → 本地提交 → 按 D3 推到 bot 命名空间 + 开 MR 给该人
  → 群里一句「✅ 结论 / 分支 / 要谁跟进」（现有出口规则表 lib/lark-group-phases.mjs 不变）
bug 表「负责人 ∈ 团队」→ 按负责人分发同上；日报按人从 origin/* 统计
```

## 4. 团队化设计：从「aven 的 bot」到「前端团队的 bot」

### 4.1 现在哪里绑死了 aven

| 位置 | 现值 | 作用 | 团队化后 |
|---|---|---|---|
| falive `repos.falive.ownership.{me,meOpenIds,meAliases}` | aven / 1 个 open_id / 3 个别名 | 归属判定：功能总表「前端」列是不是 me → 不是就 `other_owner` 跳过并 @ 负责人 | `principals[]`：每人 name / openIds / aliases / 归属表里的写法；判定变「属于团队里的谁」而不是「是不是我」 |
| falive `notifyChatId`（控制台群） | 一个群 = aven 的私聊替身 | 疑似 / 开始 / 结果 / 要材料 / 自愈私信 | 每个 principal 一个 DM（应用机器人 p2p；外部群成员若是本公司员工也能 p2p）；控制台群保留给运维告警 |
| falive `principal-channel` 锚定 | `ownership.meOpenIds` 命中 | DM 里的回话归到上一条通知 | 已按 `senderOpenId` 设计，改成在 `principals[*].openIds` 里查即可 |
| falive `dailyReport.people` + 「aven 的工作读本地分支」 | 5 个人名→别名；aven 特殊 | 日报按人 | 全员读 `origin/*`，无特殊人（C2） |
| falive `groupPostAsUser` / 云文档 `--as user` / 署名「aven 的助手」/ `botName: Aven.Bot` | aven 的用户 token | 复测结论、日报文档以 aven 身份发 | 团队身份（D2）；署名「前端 bot」 |
| falive `mergeBack.upstream` + `baseRef` 本地分支 | aven 的 `feature/phase-5-test` | 做完合回 aven 的分支 | 每个 principal 自己的 `baseRef`（远端），合回 = MR（D3） |
| fameex `allowedOpenIds` / `taskMentionOpenIds` | 只有 aven | 白名单；@aven 触发 | 团队名册；@团队任何人都触发、归那个人 |
| fameex `bugTable.myOpenId` + `notifyOpenId` | aven | 「负责人=我」才领；结果私聊 aven | `bugTable.assignees: { <open_id>: principal }`；按负责人私聊 |
| bugpoll `poll.py` 的负责人过滤、`dm()` 的 open_id | aven | 只拉 aven 的 bug | 同上，或并入 lark-bot poller（D8） |
| `repos.lark-bot`（自修工单） | 私信 aven、合进 aven 的运行分支 | bot 修自己 | 保留给 bot 维护者（aven），不团队化 |

### 4.2 配置草案（阶段 ③ 第一批落地时以此为蓝本，键名可改）

```jsonc
"team": {
  "name": "前端",
  "defaultPrincipal": "aven",                 // 归属判不出来时归谁（falive 现规则：总表没写清归 aven）
  "principals": {
    "aven":   { "openIds": ["ou_9186…"], "aliases": ["Aven", "Aven.tong", "aven.tong"], "dm": true },
    "henry":  { "openIds": ["ou_f429…"], "aliases": ["Henry"], "dm": true },
    "adrian": { "openIds": ["ou_36e7…"], "aliases": ["Adrian", "Justin"], "dm": true },
    "eric":   { "openIds": ["ou_e2fe…"], "aliases": ["Eric"], "dm": true },
    "broker": { "openIds": ["ou_f6e9…"], "aliases": ["Broker"], "dm": true }
  }
},
"repos": {
  "falive": {
    "baseRefs": { "aven": "origin/feature/phase-5-test", "henry": "origin/feature/…", "*": "origin/pre" },
    "ownership": { "table": "docs/…/phase1-feature-table.md", "column": "前端" },   // 表里的名字 → principals.*.aliases
    "delivery": { "push": "bot-namespace", "branchPrefix": "lark/falive", "mergeRequestTo": "principal.baseRef" }  // D3
  }
},
"bugTable": { "assignees": { "ou_9186…": "aven", "ou_f429…": "henry" } }
```

现有的 `ownerMap` / `memberRoles` / `dailyReport.people` 三张人表合并进 `team.principals`，避免四处维护。

### 4.3 行为变更清单（每条对应阶段 ③ 的一批）

| # | 变更 | 现状 | 改法 | 验法 |
|---|---|---|---|---|
| T1 | 触发：@团队任何成员都触发，归那个人 | fameex 只 @aven；falive 只 @bot | `resolveMessageTrigger` 认 `team.principals[*].openIds`；falive 仍只认 @bot（外部群规则不变） | 回放集 `__tests__/fixtures/falive-intake` + 新增「@Henry」用例 |
| T2 | 归属：判「属于谁」 | `resolveOwnershipOutcome` 判 me / other_owner | 输出 `principal`；不在团队里的才 `other_owner` | 黄金对话加 S（Henry 的功能被 @bot）→ 归 henry、DM henry |
| T3 | 通知：按 principal 发 DM | 全发控制台群 | `deliverRepoOutcome` 取 `principal.dm`；控制台群只留运维告警 | `lark-repo-delivery` 测试：两个人的任务互不串 DM |
| T4 | 控制通道：谁的 DM 谁说了算 | aven 一人 | `resolvePrincipalProfiles` 按 senderOpenId → principal；Henry 在自己 DM 回「继续」只续自己的任务 | `lark-principal-channel` 加多人用例 |
| T5 | 交付：bot 分支可见 | 只本地提交 | 按 D3：推 `lark/*` 到 bot 命名空间 + MR 给 principal 的 baseRef；protected 分支永不推 | 真机：MR 出现在 GitLab；`git push` 目标分支白名单测试 |
| T6 | bug 表：按负责人分发 | 负责人=aven | `bugTable.assignees`；回写逻辑不变；结果 DM 该负责人 | poller 单测 + 真机一条 Henry 的 bug |
| T7 | 日报：全员读远端 | aven 读本地 | 删「本地分支 + 工作区」特例 | `lark-daily-report` 测试改口径 |
| T8 | 身份：团队身份发群 / 建文档 | aven 的用户 token | 按 D2 换账号；在 mini 上用新账号重做 `lark-cli auth login`，代码不用改 | `lark-cli whoami` 的 `onBehalfOf` 变成团队账号 |

**不变量影响**：I1–I9 全部保留；新增 **I10：不同 principal 的任务、DM、分支互不可见、互不串**（谁的事只进谁的 DM，分支名带 principal 或 MR 指向他的 baseRef），由 T3/T4/T5 的测试钉住。按 AGENTS.md「加一道闸合并或删一道旧闸」，T2 合并进现有归属闸，不新开。

## 5. 为什么不建议「直接把两条线合成一个实例」

- 不变量 I8（教训 #51）：两条线靠 profile 互相保护漏一处就波及内部群。**同一套代码、两个实例、两份配置**是对的；要合的是代码（阶段 ④），不是实例。
- falive 线是功能超集（多仓 profile、repo-only、台账、日报、清扫、部署盯梢、自愈），fameex-stable 独有的 2 个修复 falive 线都有。所以阶段 ④ 的方向是「falive 线代码跑 fameex 实例」，但要先用 10-24 那套沙箱回放法（3015 端口 + `LARK_RUNTIME_DIR` + 拦写的假 lark-cli，见 `lark/port-falive-generic` 分支 `docs/port-from-falive-2026-10-24.md`）验过 fameex 路径。
- 阶段 ① **不**做这件事：原样搬，fameex 实例继续跑 `fameex-stable`。

## 6. 分阶段计划

### 阶段 0 · 交接落盘（10-29，本次，已完成）

本文 + `docs/README.md` / `README.md` 指针 + `.gitignore` 补 `runtime/lark-merge-back/`、`runtime/lark-failures/`；推到 `origin/feature/falive-repo-profile`。

### 阶段 1 · 原样搬迁（目标：1 天；身份、行为、配置值一字不改，除 C1/C3）

| 步 | 内容 | 验收 |
|---|---|---|
| 1.1 | mini 初始化（§8.1）：用户 `aven`（D1）、自动登录、FileVault 关、`pmset` 永不睡、远程登录 + 屏幕共享、Homebrew、node、pnpm、lark-cli、claude、git | `node -v` `pnpm -v` `lark-cli --version` `claude --version` 都有；`pmset -g` 无 sleep |
| 1.2 | clone：`lark-bot`（两个 worktree，分支同笔记本）、`fameex-web`、`falive-react`、`x9_web_react`、`~/.ai-rules`；`pnpm install` 各业务仓一次 | `git -C ~/github/lark-bot-falive status` 干净；`node scripts/test-all.mjs` 341 绿 |
| 1.3 | 凭据：`scp ~/.config/fameex-lark` → mini；`lark-cli config init`（应用）+ `lark-cli auth login`（用户）；`claude` 登录 | `lark-cli whoami` 的 `appId` 与笔记本一致且 `onBehalfOf` 是 Aven.tong；`lark-cli auth check --scope im:message`（或 `lark-cli doctor`）通过；`claude -p "ok"` 能答 |
| 1.4 | 配置：拷两份 `runtime/lark-bot.local.json`；按 C1 改 falive `baseRef`→`feature/phase-5-test` + `fetchBase:true`、删 `mergeBack`；aven 先把本地 `feature/phase-5-test` 推上 origin | `node -e 'import("./lib/lark-config.mjs")'` 校验无 error（gateway 启动会跑） |
| 1.5 | bugpoll：`rsync -a ~/.lark-bugpoll mini:~/`；重建 `~/github/falive-hotfix` worktree（C3）；`launchctl bootstrap` 它的 plist | `bash ~/.lark-bugpoll/run.sh` 手跑一轮日志无 error |
| 1.6 | **切换**（§8.5，必须在无在跑任务时）：笔记本 `lark-bot stop` ×2 + bootout bugpoll → 拷运行态 keep 表 → mini `lark-bot start` ×2 → `lark-bot status` 两边 ok | 两实例 `/lark/health` ok；falive `chatPoller.*.lastError` 为 null；fameex `consumer.alive` |
| 1.7 | 观察 24h：日报 19:00 发出、部署盯梢探到 pre、群里 @bot 有回应、`lark-bot doctor` 绿 | 发件簿有当天 `daily_report`；`runtime/lark-daily-sweep/falive.json` 更新 |
| 回滚 | mini `lark-bot stop` ×2 → 笔记本 `lark-bot start` ×2（配置未删）；运行态双向拷贝即可 | — |

### 阶段 2 · 服务器化（目标：2 天，可与阶段 1 观察期并行）

- **路径可移植**：`scripts/lark-bot` 两份改为按脚本位置推导 `LARK_BOT_ROOT`、`REPO` 读配置；`runtime/*.plist` 改模板 + `lark-bot start` 时渲染 `$HOME`；`lib/lark-paths.mjs` 默认 consumer root 改读配置、无配置报错而不是指向 `/Users/aven`。shim 同步并提醒重装（AGENTS.md CLI 契约）。
- **笔记本机制关掉**：launchd wrapper 里 `LARK_KEEP_AWAKE=0`、`LARK_WAKE_CATCHUP=0`；bugpoll 时间窗改纯定时。
- **运维**：日志轮转已有（start 时 10 MiB）；加 `runtime/` + `~/.config/fameex-lark/` + `~/.lark-bugpoll/*.json` 每日 `rsync` 到笔记本或 NAS（备份不进仓库）；Time Machine 关（会扫 node_modules）。
- **监控**：`lark-bot doctor` 已每小时体检并私信；从笔记本 cron `curl mini:3005/lark/health` 作为机器级探活（gateway 自己挂了 doctor 也挂）。
- **安全**：gateway 只听 `127.0.0.1`（已是）；SSH 只开密钥；`~/.config/fameex-lark` 保持 0600。

### 阶段 3 · 团队化（目标：每批 2–3 天，一批一次重启、观察一天）

| 批 | 内容（对应 §4.3） | 前置决策 |
|---|---|---|
| 3a | `team.principals` 配置 + 校验；三张人表合并；T2 归属输出 principal；T1 fameex 触发名册 | D5 名册 |
| 3b | T3 DM 投递 + T4 控制通道多人；控制台群只留运维；I10 黄金对话 | — |
| 3c | T5 交付（push 白名单 + MR）；T6 bug 表按负责人；bugpoll 进仓或并入 poller | **D3、D8** |
| 3d | T7 日报全员远端；T8 团队身份 | D2、D4 |

每批照 AGENTS.md：先对不变量、加黄金对话、改提示词先跑回放集（`node scripts/lark-replay-classify.mjs falive --dir __tests__/fixtures/falive-intake --report --gate`）、合并前 `test-all` + `mutate --diff`。

### 阶段 4 · 一套代码（可选，团队化稳定后）

fameex 实例切到 falive 线代码（默认仓 = fameex、完整模式）；先沙箱回放 fameex 历史消息（§5），再 `lark-bot restart` fameex 实例；`fameex-stable` 归档。笔记本上四个 launchd plist `bootout` + 删除，worktree `lark-bot-port` 删除。

## 7. 待 aven 拍板的决策

| # | 决策 | 建议 | 不选建议的代价 |
|---|---|---|---|
| D1 | mini 的 macOS 用户名 | **`aven`**，所有路径与笔记本一致，阶段 ① 零改代码 | 用别的名：阶段 ② 的路径可移植要提前到阶段 ①，多 1–3 天 |
| D2 | 外部群轮询 / 发文档用谁的 Lark 身份 | 向管理员申请一个专用账号（如「前端 Bot」），拉进外部群和控制台群；申请前**先沿用 aven 的 token** | 一直是 aven：bot 说的每句话法律上都是 aven 说的；aven 换密码 / 离线 bot 就断 |
| D3 | bot 分支能不能 push | **允许 push 到 bot 命名空间 `lark/*`**（永不推 protected 分支）+ 自动开 MR 给负责人；在此之前团队用 `git remote add mini ssh://…` fetch bot 分支 | 不许：团队成员看不到 bot 产出，只有能 SSH 上 mini 的人能拿；merge-back 永远做不了 |
| D4 | Claude 鉴权 | 阶段 ①② 维持 `local`（aven 账号，需屏幕共享登录一次）；阶段 ③ 团队用量上来后切 `proxy`（`claude.env` 网关 key）或团队账号 | 多人用量压在 aven 个人额度上，429 变多 |
| D5 | 团队名册与归属来源 | 名册写在配置 `team.principals`（5 人：aven / Henry / Adrian / Eric / Broker；fameex 侧再加 Kai.b / hurley / noodles / grace 等活跃提交者）；归属 falive 读功能总表「前端」列，fameex 读 bug 表负责人字段 | 不定名册：T1–T4 没法做 |
| D6 | 代码线 | 阶段 ① 两条线原样；阶段 ④ 合成 falive 线一套代码（见 §5） | 一直两套：每个通用修复要搬两次 |
| D7 | 远程访问 | Tailscale（笔记本、mini 各装一个），SSH 密钥；屏幕共享只在要 GUI 登录时开 | 局域网 IP：出门修不了 |
| D8 | bugpoll 去向 | 阶段 ① 原样 rsync；阶段 3c 把 `poll.py`/`deployed.py` 收进本仓 `tools/falive-bugpoll/`（状态仍在 `~/.lark-bugpoll`），或直接用本仓 `lark-bugtable-poller` 的 profile 接 falive bug 表 | 永远在仓库外：换机器就丢、无测试、无版本 |

## 8. 迁移手册（可复制；`<mini>` 换成主机名或 Tailscale IP）

### 8.1 mini 初始化（在 mini 上，一次）

```sh
# 系统：系统设置 → 用户与群组 → 自动登录 aven；FileVault 关；共享 → 远程登录 / 屏幕共享 开
sudo pmset -a sleep 0 disksleep 0 displaysleep 10 autorestart 1 womp 1 powernap 0
sudo systemsetup -setcomputersleep Never 2>/dev/null || true
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"   # 装到 /opt/homebrew
brew install node git pnpm                       # launchd wrapper 用 /opt/homebrew/bin/node
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash && nvm install 24.7.0   # 可选：codex / pi 用
npm i -g @larksuite/cli                          # lark-cli（笔记本 1.0.70）
curl -fsSL https://claude.ai/install.sh | bash   # claude（笔记本 2.1.289）
mkdir -p ~/github ~/.local/bin ~/Library/Logs/fameex-lark ~/Library/Logs/falive-lark
```

### 8.2 clone

```sh
cd ~/github
git clone https://github.com/hupo256/lark-bot.git lark-bot && cd lark-bot && git checkout fameex-stable
git worktree add ../lark-bot-falive feature/falive-repo-profile
git clone https://github.com/hupo256/ai-rules.git ~/.ai-rules
git clone http://mgit.lgroup.co/hqex/web/fameex-web.git ~/github/fameex-web      && (cd ~/github/fameex-web  && pnpm install --frozen-lockfile)
git clone http://mgit.lgroup.co/hqoi/web/falive-react.git ~/github/falive-react  && (cd ~/github/falive-react && git checkout feature/phase-5-test && pnpm install --frozen-lockfile)
git clone http://mgit.lgroup.co/hqtftd/x9_web_react.git ~/github/x9_web_react
git -C ~/github/falive-react worktree add ~/github/falive-hotfix origin/pre        # bugpoll 用（C3）
cd ~/github/lark-bot-falive && node scripts/test-all.mjs                          # 期望 341 绿
cp scripts/lark-bot-shim ~/.local/bin/lark-bot && chmod +x ~/.local/bin/lark-bot  # fameex 实例 CLI；falive 实例用 ~/github/lark-bot-falive/scripts/lark-bot
```

### 8.3 凭据与登录（笔记本 → mini）

```sh
# 笔记本
scp -rp ~/.config/fameex-lark <mini>:~/.config/ && ssh <mini> 'chmod 700 ~/.config/fameex-lark && chmod 600 ~/.config/fameex-lark/*'
scp -rp ~/.claude/projects/-Users-aven-github-falive-react <mini>:~/.claude/projects/
rsync -a ~/.lark-bugpoll/ <mini>:~/.lark-bugpoll/
# mini（屏幕共享里做，钥匙串要在 GUI 会话）
lark-cli config init           # 应用机器人身份：app_id 同笔记本（lark-cli whoami 的 appId），app_secret 走 stdin，向 aven 要
lark-cli auth login --domain im,docs,drive,base,wiki,contact   # aven 用户身份 device-flow（D2 前沿用）；浏览器里完成授权
lark-cli whoami && lark-cli doctor
claude                         # 走一次 OAuth 登录；claude-auth 文件为 local
```

### 8.4 配置

```sh
# 笔记本
scp ~/github/lark-bot/runtime/lark-bot.local.json        <mini>:~/github/lark-bot/runtime/
scp ~/github/lark-bot-falive/runtime/lark-bot.local.json <mini>:~/github/lark-bot-falive/runtime/
git -C ~/github/falive-react push -u origin feature/phase-5-test     # C1：基线上远端
# mini：falive 配置改两处（C1）—— repos.falive.fetchBase: true；删 repos.falive.mergeBack
```

### 8.5 切换日（选无在跑任务的时段，如 19:30 日报之后）

```sh
# 笔记本：确认空闲再停
lark-bot status && ~/github/lark-bot-falive/scripts/lark-bot status      # tasks 行 running=0
lark-bot stop; ~/github/lark-bot-falive/scripts/lark-bot stop
launchctl bootout gui/$(id -u)/com.aven.falive-bugpoll
# 运行态（附录 A 的 keep 项）
for d in lark-ledger lark-outbox lark-obligations lark-daily-report lark-daily-sweep lark-merge-back lark-followup-docs; do rsync -a ~/github/lark-bot-falive/runtime/$d/ <mini>:~/github/lark-bot-falive/runtime/$d/; done
scp ~/github/lark-bot-falive/runtime/{lark-chat-poller-state,lark-doctor-state,lark-bug-record-links}.json <mini>:~/github/lark-bot-falive/runtime/
scp ~/github/lark-bot/runtime/lark-bugtable-state.json <mini>:~/github/lark-bot/runtime/
rsync -a ~/.lark-bugpoll/*.json <mini>:~/.lark-bugpoll/
# mini：起
lark-bot start && lark-bot status                                        # fameex 3005
~/github/lark-bot-falive/scripts/lark-bot start && ~/github/lark-bot-falive/scripts/lark-bot status   # falive 3006
cp ~/.lark-bugpoll/com.aven.falive-bugpoll.plist ~/Library/LaunchAgents/ && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.aven.falive-bugpoll.plist
curl -s 127.0.0.1:3005/lark/health | head -c 300; curl -s 127.0.0.1:3006/lark/health | head -c 300
```

### 8.6 团队怎么拿 bot 分支（D3 定前的过渡）

```sh
git remote add mini ssh://aven@<mini>/Users/aven/github/falive-react
git fetch mini 'refs/heads/lark/*:refs/remotes/mini/lark/*'
```

## 9. 在 mini 上怎么继续（给下一个 agent）

1. 先读：本文 → `AGENTS.md` → `docs/falive-repo-profile.md` §4（配置键）→ `docs/falive-lessons.md`「不变量」。
2. 先确认 D1–D8 里 aven 已答的；没答的按「建议」列执行，并在本文 §7 标注日期。
3. 阶段 ① 按 §8 做，**不改代码**（除 C1 的两处配置）；切换完成后在本文 §6 阶段 1 表格里逐行填验收结果。
4. 阶段 ② 的代码改动开分支 `lark/server-portable`，合并前 `node scripts/test-all.mjs` + `node scripts/mutate.mjs --diff feature/falive-repo-profile`；CLI 契约变了同步 shim（AGENTS.md）。
5. 阶段 ③ 每批一个分支 `lark/team-3a` … `lark/team-3d`，先写黄金对话再改代码；新教训继续记 `docs/falive-lessons.md`（类别列用「环境 / 逻辑 / 噪音」）。
6. **不要做**：在 mini 上 `git push` 任何业务仓（D3 定前）；把 `runtime/*.local.json`、凭据、`~/.lark-bugpoll` 的 json 进仓；两实例同时跑在同一端口 / 同一 `runtime/`；在笔记本和 mini 同时起同一条线（长连接会双收、轮询会双发）。

## 附录 A · 运行态 keep / drop

| 路径（相对 `runtime/`） | 是什么 | 切换时 |
|---|---|---|
| `lark-chat-poller-state.json` | 外部群轮询游标 + 失败计数 | **keep**（切换空窗期的消息靠它补拉） |
| `lark-ledger/falive.json` | 对接台账 137 条 | **keep** |
| `lark-outbox/*.jsonl` | 发件簿（去重 24h、deploy-watch 回看「部署后再测」承诺） | **keep** |
| `lark-obligations/*.json` | 回复义务（I1） | **keep** |
| `lark-daily-report/`（`state.json` + 历史 md） | 日报防重发 + 历史 | **keep** |
| `lark-daily-sweep/falive.json` | pre 部署基线（VITE_BUILD_TIME / SHA） | **keep**（丢了会把下一次探测当首次只记基线，不复测） |
| `lark-merge-back/falive.json` | 排队等合的任务 | keep（阶段 ① 关 mergeBack 后只做记录） |
| `lark-followup-docs/`、`lark-bug-record-links.json`、`lark-doctor-state.json` | 待确认文档、bug 记录链接缓存、体检去重 | keep |
| `lark-bugtable-state.json`（fameex） | bug 表 seen | **keep**（丢了会把已处理 bug 当新的） |
| `~/.lark-bugpoll/{handled,state,snapshot,deployed-state}.json` | bugpoll 台账 | **keep**（`deployed-state` 丢了会重复改表） |
| `lark-tasks/` | 24h 内任务 | **drop**：停机前排空（running=0），queued 的留在笔记本也会被 prune；要的话手工重投 |
| `lark-worker-state.json` | 心跳 | drop |
| `lark-audits/`（104 MB）、`lark-attachments/`（17 MB，7 天） | 历史证据 | 可选归档到笔记本；不拷也不影响运行 |
| `reaped/` | 回收分支 patch | 可选归档 |
| `~/Library/Logs/{fameex,falive}-lark/` | 日志 | 不拷 |

## 附录 B · 验证时看的日志关键词

- falive gateway：`chat-poller … lastError`、`出口闸拦下`、`不在出口规则表`、`repo-only：… 不是仓库群`、`deploy-watch`
- falive worker：`repo falive: claude model=… probe=passed`、`[self-heal]`、`终检`
- fameex gateway：`feishu-websocket: reconnecting`（服务器上应接近 0）、`listening on http://127.0.0.1:3005`
- 两实例 `/lark/health`：`codeStale` / `configStale` 为 false；`worker.readiness.ok` true

## 附录 C · 相关文档

`docs/overview-workflow.md`（架构）· `docs/runtime-and-scheduling.md`（健壮性兜底）· `docs/falive-repo-profile.md`（多仓 profile 全部配置键）· `docs/falive-lessons.md`（97 条教训 + 不变量）· `docs/falive-self-healing.md`（自愈三环）· `docs/mutation-testing.md` · 分支 `lark/port-falive-generic` 的 `docs/port-from-falive-2026-10-24.md`（沙箱回放法）· 本机记忆 `~/.claude/projects/-Users-aven-github-lark-bot/memory/`
