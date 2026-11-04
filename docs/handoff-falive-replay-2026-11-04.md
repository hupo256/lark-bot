# 交接：falive 实战回放验证 lark-bot（2026-11-04）

> 写给接手的新 chat。先读本文，再按「下一步」做。用户是 aven，回复用中文。
> 仓库 / 本机规则以 `AGENTS.md`、`~/.claude/CLAUDE.md` 为准；本文只写这件事本身。

## 1. 这件事是什么

- **目标**：11-01 上下文分层、11-02 对话层重建这两次升级没经过实战。用 falive bot 10-14 → 11-03 的真实运行数据，让**最新 lark-bot** 把 falive-bot 做过的**全部 285 个 case** 读全上下文重跑，和 falive 当时的表现逐条裁判；找出真问题，修，再验，最后合进运行分支。
- **范围**：只回放主链：消息 → 分类 / 接话 → 执行 → 回复。bug 表轮询、邮件转评分、每日报告这些旁路**不回放**。
- **aven 的硬要求**（违反过、被批评过）：
  - 上下文必须读全：截图、话题回复、云文档、bug 单都要有。
  - 跑之前先验输入。一轮作废了先报告，再开下一轮。
  - 不要白跑浪费额度。
  - 断点续跑、分段并行、场景还原是基本功，方案要「好、快、准、省 token」。
- **现状**：还没有一轮有效的完整结果。11-03 跑了 r1–r11，都因数据、环境或跑法问题作废，或被中途停掉（见 §5）。新方案 v2 **11-04 定稿**（`docs/falive-replay-design-v2.md`），从 §8 的 P0-a 开始做。

## 2. 东西都在哪

| 什么 | 位置 |
|---|---|
| **新方案 v2（接手后先读）** | `~/github/lark-bot-latest/docs/falive-replay-design-v2.md` |
| 计划 + 进度流水（第 1–45 条，43 是复盘与防再犯策略） | `docs/falive-replay-plan-2026-11-03.md` |
| case 清单（285 条，含 falive 当时第一句回复） | `replay/falive/cases.md` / `cases.jsonl`，由 `scripts/sim/list-cases.mjs` 生成 |
| case 数据（进版本，144M） | `replay/falive/raw/`：三个群、204 个话题、126 篇云文档、153 条 bug 记录、441 份附件。`replay/falive/dataset/`：`timeline.json` 4152 条、`episodes.json` falive 基线。说明见 `replay/falive/README.md` |
| 回放脚本 | `scripts/sim/`（见 §3） |
| 每轮的预检 / 裁判 / 总账（进版本） | `replay/falive/rounds/<轮>/` |
| 回放产物（不进版本，6.2G，可删可重跑） | `~/github/lark-bot/runtime/falive-replay/sim/<轮>-<段>/`，存档点在 `<段>.ckpt/<日期>/` |
| falive 当时的审计 / 日志（只读存档） | `~/github/lark-bot-falive/runtime/`、`~/Library/Logs/falive-lark/` |

**分支与工作区**：

- `~/github/lark-bot`：运行分支 **fameex-stable**，线上 fameex bot 直接跑这个目录。往这里合代码，几分钟内就会经排空重启上线，合之前必须全量测试过。
- `~/github/lark-bot-latest`：集成分支 **lark/falive-latest**，所有回放和修复都在这里做。它 = 11-03 的修复集合（原 fix4 + fix5–fix17）+ fameex-stable 截至 e66209a 的内容 + 回放脚本，比 fameex-stable 多 150 多个提交，还没合进运行分支。
- 11-04 已把 fameex-stable（含 aven 的 ee0ff6d）合进 latest（04e2c23，全量 640 绿）。以后运行分支有新提交，起跑前同样先合进来，否则预检报「不是最新」。
- 其余 `~/github/lark-bot-fix*`、`lark-bot-r3`…`r6` 等 27 个工作区都是 11-03 的旧分支，内容已经并进 latest，可以清掉，清之前先确认。

## 3. 回放台子（现有能力）

- **模拟器** `run-sim.mjs`：
  - 起一套 lark-bot（网关 + worker），跑工作区里的代码。
  - 假 lark-cli（`fake-lark-cli.mjs` + `lark-cli` 壳）：按虚拟时钟供应群消息、话题、云文档、bug 单、附件；bot 发的话记进 `outbox.jsonl`，**不会真发到飞书**。
  - 虚拟时钟 `virtual-clock.mjs`：bot 忙时按真实速度走，空闲时跳到下一条消息。
  - 业务仓 falive-react 每段按天 clone，钉到当天的提交（`sim-base-<日期>` 分支）。
- **按天 / 分段**：`run-days.sh`（每天存档点、断点续跑、代码指纹不符拒绝续跑）、`run-round.sh <轮> [端口]`（8 段，每段先热身前一个工作日；最多 5 段并行；预检 → 守卫 → 每段跑完自动裁判 → 总账拷进 `rounds/`）。**v2 方案要改成按事件组跑。**
- **闸**：
  - `preflight.mjs`：数据、代码、环境三类预检，不过就不跑。
  - `round-guard.mjs`：止损守卫，只认进程级崩溃、读取缺口、分类失败 ≥3、50 分钟不动；改规则先用 `--once` 拿历史日志验证。
  - `claude-q` / `claude-quota.mjs`：额度闸。撞 5 小时限额就冻住所有段的虚拟时钟，到点重试。lark-bot 的真实时间超时在回放里放大，原超时由闸按真实耗时执行。
- **裁判与报表**：`judge-sim.mjs --sim <名> --all --score-from <ISO>`（Opus 模型裁判，记录 falive / same / lark-bot / both_wrong + larkIssue + idealBehavior）、`round-report.mjs --round <轮> --issues`。
- **L1 分类回放**：`replay-intake.mjs` / `judge-intake.mjs` / `compare-intake.mjs`，产物在 `runtime/falive-replay/l1/`。
- **录放缓存雏形**：`claude-cache.mjs` / `claude-cache-check.mjs`。是早先子代理写的，`--ai-cache` 才启用，**没在整轮里验证过**，v2 要先验命中率和一致性。
- **重建数据**：`build-context-cache.mjs [docs|bugs|expanded|resources|threads]`（aven 身份只读拉取）→ `build-dataset.mjs` → `list-cases.mjs` → `preflight.mjs`。**时间线一变，依赖它的拉取步骤都要重跑**（11-03 就因为顺序错漏了话题回复里的 7 篇文档）。

## 4. 下一步

按 **design-v2 §8 的执行步骤**做，从 P0-a 开始：先改两处 lark-bot 代码，再分组、实测类标注、模拟器按组跑……
分组规则、录放、裁判、验收标准、已定口径分别见 design-v2 §2、§4、§5、§6、§7，这里不重复。

- 每个阶段做完都给 aven 报结果，再进下一阶段。
- P5 合并前按 AGENTS.md 全套验证：
  - `node scripts/test-all.mjs`（当前 640 绿）；
  - `node scripts/mutate.mjs --diff fameex-stable`；
  - `lark-replay-prompts --audits ~/github/lark-bot-falive/runtime/lark-audits`；
  - `lark-replay-intake --live` 和 `--fixture __tests__/fixtures/intake-regression-1102.json --live`（56 条）。

## 5. 11-03 的教训（别再犯）

| 出过的事 | 怎么防 |
|---|---|
| r1–r6 用缺截图（附件路径重复拼接）、缺 1781 条话题回复的数据反复跑了 6 轮 | 起跑必过 `preflight.mjs`；冒烟要核对 bot 实际看到的上下文与原始群聊一致，不能只看「能跑通」 |
| r8 用的代码比运行分支少两个提交 | 预检查「含 fameex-stable 全部提交」 |
| r9 八段全开约 1 小时撞 5 小时额度，之后假失败一片；18:28 还有一次内存紧张杀进程 | 额度闸 + 最多 5 段；v2 改按实际花费调度，给线上留 30% |
| r10 第一次起跑：放大 AI 超时后 worker 启动自检要求「AI 超时 < 租约」，拒绝启动，空转半小时 | 回放环境同时放大 `LARK_TASK_LEASE_MS`（已改）；守卫盯进程崩溃 |
| 线上新功能（应用令牌直铸 1cc516e）在回放里读线上 secret 去请求真飞书 | 回放里 `LARK_OPEN_API_HOST=http://127.0.0.1:9`、`LARK_APP_ID=cli_sim_replay`（已改）；**合进新代码后检查有没有新的外网直连** |
| 守卫第一版把 lark-bot 自己重试的 API 500 当崩溃，误停 r10 | 守卫规则先用历史日志 `--once` 验证 |
| 测断点续跑时范围写错，多跑进一个满消息的工作日 | 测跑法只用空日子（如 10-25） |
| 改跑法脚本时，已在跑的段还装着旧脚本，没有存档点；机器 21:12 重启后只能从头跑 | 跑法改完、测完，再起整轮 |
| `pkill -f` / `pgrep -f` 的匹配串出现在自己的命令里，把自己的 shell 杀了 | 按 pid 杀；匹配串别和命令本身重合 |
| sh 脚本里 `$var` 后面紧跟中文全角字符，被当成变量名一部分（unbound variable） | 一律写 `${var}` |

## 6. 运行配置与环境要点

- 回放用 aven 飞书身份**只读**拉数据；不往飞书写，不发消息。不打印密钥（bug 表 appToken、app secret）。
- **11-04 起 fameex、falive 两个线上 bot 都已停**（aven：集中精力训练 lark-bot），Claude 额度全给回放；线上何时恢复由 aven 定，恢复前别替它启动。
- 机器 8 核 16G；回放产物在 `runtime/falive-replay/sim/`，单轮几个 G，清的时候按目录逐个删（安全检查会拦宽泛的 `rm -rf`）。
- falive-react 主仓里留着 `sim-base-*` 分支 20 个，全部回放结束后清掉。
- 仓库有 GitHub 远端；`replay/falive/` 是公司内部群聊数据，**不要 push**（任何 push 都要 aven 当次明确授权）。
- 不执行 `lark-bot restart|start|stop|poll-on`、`launchctl`，不改 `~/Library/LaunchAgents/*`、`~/.config/fameex-lark/*`。

## 7. 遗留决策

11-04 aven 都已定，口径见 design-v2 §7：复测链路待办；改码按需求边界不超界；实测允许登录用的 POST；打包问题按回答。

## 8. 11-03 已上线 / 已合的

- 热修 `c331067`（已在 fameex-stable 上线）：并进别的任务的消息不算关单，「收到」照发。修的是 3e7e539 带来的线上问题。
- fix17（续跑时 priorConclusion 换成本单刚发出去的结论）在 latest 里，还没上线。
