# 审批邮件转发 + 评分：拆成独立应用 · 评估与落地 plan · 2026-11-05

> 来源：aven 11-05「评估一下，bot 的这个转邮件 + 评分的功能，可以单独拎出来发布使用吗？出一个可以落地的 plan」。
> 现状实现：`lib/lark-mail-relay*.mjs`、`lib/lark-mail-ol-score.mjs`、独立入口 `scripts/lark-mail-relay.mjs`；评分口径 `docs/notes/mail-ol-scoring-2026-11-02.md`。
> 相关旧 plan：`docs/plan/plan-mail-approval-2026-11-02.md`（领导审批助手，已查明的飞书身份限制在那份 §1，本文直接引用不重查）。

## 1. 结论

**能拆，代码层面成本很低；卡点不在代码，在三件非代码的事：用谁的邮箱、用哪个飞书应用、跑在哪台机器。**

- 代码：引擎 + 路由 + 评分共约 630 行（`lark-mail-relay*.mjs` 423 行 + `lark-mail-ol-score.mjs` 136 行 + 入口 71 行）。11-02 写的时候就预留了「一键拆分」：lark-cli 调用器、台账读写、长连接启动器都可以注入，`scripts/lark-mail-relay.mjs run` 已经能单独跑。
  和 bot 的耦合只有 3 处：`lark-gateway.mjs:219` 网关里启动、`lib/lark-config.mjs:92` 配置校验、`lib/lark-chat-retention.mjs:43` 转发群不自动退群。
  唯一真依赖是 `lib/lark-cli.mjs`（513 行，顺带拉进群上下文 / 项目群等 bot 模块）；转发实际只用其中 5 个函数（`runLarkCli`、`larkCallFailed`、`parseSentMessageId`、`sendMarkdown`、`replyMarkdown`），拆的时候抽一个约 100 行的精简版即可。
- 非代码卡点：
  1. **邮箱身份**：读信、`+share-to-chat` 都只能用 user 身份（bot 身份只能读，且 `accessible_mailboxes` 只有「主邮箱 + 公共邮箱」，见 2026-11-02 plan §1）。现在读的是 aven 本人收件箱，群里的邮件卡片也显示「aven 分享」。给别人用，就得有人用自己的邮箱（或公共邮箱）授权。
  2. **飞书应用**：现在和 bot 共用 `cli_aabf9468b1789ed4`（显示名「Aven.tong的Lark CLI」）。共用应用时不能开 `mail +watch`（会分走 bot 的私信 / @bot 事件，11-02 实测丢 6 条），所以只能 2 分钟轮询一次。独立应用就能改成实时监听，但要新建应用、申请邮件权限（用户级邮件 scope 可能要租户管理员审批）、发布版本、把新 bot 拉进转发群。
  3. **运行机器**：现在跑在 aven 的笔记本上，合盖就停（开盖后会补转，不漏，但晚到）。今天拉取失败 15 次（约 3%），都会自动补上。要给别人用，至少要一台常开的机器（Mac mini 计划 11-01 已暂停）。

**拆出来的实际收益**：
- **爆炸半径**：bot 一天会自修 / 排空重启好几次，任何一次自检失败或配置写坏，转发都会一起停；独立后互不影响。
- **能给别的组 / 别的邮件类型用**：路由、评分器都是配置驱动的。
- **实时性**：独立应用可以用 `+watch` 秒级转发，不用 2 分钟一轮。

**不拆的代价**：现在只服务一个群（Rou 的审批群），用 aven 的邮箱，运行稳定，今天 4 封全转、无漏转。只要没有第二个使用方，继续内置也能用。

**建议**：先做 P1（代码拆成独立目录，lark-bot 照常内置调用，零上线风险），P2–P5 等「有第二个使用方」或「需要脱离 aven 笔记本」时再启动。马上可做、不依赖拆分的两件小事放在 §6。

## 2. 需要 aven 先拍板的 3 件事（P2 之前）

**11-05 aven 已定**：
- D1 = a + 预留 b：目前只给现在这个审批群用，将来开放给别的组——**接口预留好、不写死**（群、路由、评分器、告警收件人、凭证目录、台账都走配置；P1 拆分时按多路由 / 多邮箱实例设计）。
- D2 = a：用 aven 的邮箱授权。
- D3 = b：放到常开的 Mac mini 上（Mac mini 服务器化计划 11-01 暂停过，迁移时参照 `docs/mac-mini-migration-2026-10-29.md`；转发是第一个要搬的独立进程）。

原始选项：

| # | 问题 | 选项 | 建议 |
|---|---|---|---|
| D1 | 给谁用 | a. 只服务现在这个审批群，拆出来只为稳定；b. 开放给别的组，每组自己的邮件类型 / 群 / 评分 | 先 a，结构按 b 设计（多路由多邮箱） |
| D2 | 读谁的邮箱 | a. 继续用 aven 的邮箱授权；b. 找 IT 开一个公共邮箱（如 approvals@），把审批邮件抄送进来，用它授权；c. 每个使用方用自己的邮箱授权 | a 起步；开放给别组时用 b 或 c，否则审批群里的卡片都显示「aven 分享」 |
| D3 | 跑在哪 | a. 继续跑 aven 笔记本，独立 launchd 进程；b. 常开机器（Mac mini / 公司服务器） | 只给自己组用选 a；开放给别组必须 b |

## 3. 分阶段 plan

### P1 代码拆成独立目录（约 0.5–1 天，零上线风险）· 11-05 已完成

> 落地结果：本体在 `packages/mail-relay/`（engine / routes / presets / forward / scorers/ol-release / 自带 lark-cli 层 lark.mjs / 长连接 consumer.mjs / 独立入口 bin/mail-relay.mjs，说明见包内 README.md）；
> `lib/lark-mail-*.mjs` 只剩薄转发，内置时注入 lark-bot 的 runLarkCli / 长连接 / 台账路径。
> 验收：`__tests__/mail-relay-package.test.mjs` 钉住包边界（不 import lark-bot）与 lark-cli 层两边参数逐字一致；5 封真邮件（3 OL + 2 B2B）拆前 / 拆后 / 独立入口三方 dry-run 输出逐字相同。
> 与原设想的出入：测试仍放 `__tests__/`（全量测试只扫这个目录），没搬进包内。

目标：转发代码不再依赖 lark-bot 其他模块，lark-bot 照样内置调用它，线上行为不变。

1. 新建 `packages/mail-relay/`（先放本仓，P2 再决定要不要搬去单独的仓库）：
   - `engine.mjs`（现 `lark-mail-relay.mjs`）、`routes.mjs`、`forward.mjs`、`presets.mjs`；
   - `scorers/ol-release.mjs`（现 `lark-mail-ol-score.mjs`）。评分器做成可注册的插件：`{ id, match?, score, render }`，新增一类邮件 = 加一个文件 + 一条配置；
   - `cli.mjs`：从 `lib/lark-cli.mjs` 抽出转发用的 5 个函数，约 100 行，不 import 任何 bot 模块；
   - `paths.mjs`：台账 / 配置路径都从入参或环境变量来，不用 `lib/lark-paths.mjs`。
2. lark-bot 里原来的 `lib/lark-mail-relay*.mjs` 改成薄转发（re-export），网关、配置校验、退群白名单三处调用点不动。
3. 测试：`__tests__/lark-mail-relay.test.mjs` 搬到包内，lark-bot 全量测试照常覆盖它；加一条守卫测试：包内文件不准 import `../../lib/`。
4. 验收：`node scripts/test-all.mjs` 全绿；用 `scripts/lark-mail-relay.mjs forward --message-id <今天那封 BBO> --dry-run` 对比拆分前后的评分 markdown，逐字相同；上线后台账、日志和拆前一致。

### P2 独立飞书应用（约 0.5 天动手 + 等管理员审批）· 11-05 进行中

> 进度：应用「审批邮件助手」`cli_aa663bfff1b89f04` 已建（只加机器人能力），权限按 `engine.mjs` 的 `RELAY_USER_SCOPES`（8 个用户身份只读 / 监听 / 续期）+ 机器人发消息开好，**已提交企业管理员审批，在等**。
> 笔记本上已建独立凭证目录 `~/.config/mail-relay/lark-cli`（0700，`config init` 完成）；邮箱授权试过一次，飞书回「权限审核中」，审批通过后重新 `auth login`。
> 事件订阅（长连接）先不配：要有进程连上才能保存，放到 Mac mini 上开 watch 时再配（见 `packages/mail-relay/deploy/INSTALL.md` §8）。

1. 开发者后台新建自建应用，名字如「审批邮件助手」，配头像；
2. 开通权限：`mail:user_mailbox:readonly`、`mail:user_mailbox.message:readonly`、`mail:event`（用 `+watch` 时）、分享邮件到群需要的 scope、`im:message`（bot 回复评分）；用户级邮件 scope 走租户管理员审批；
3. 可用范围加上授权人，发布版本；把新 bot 拉进审批群（`oc_936db…`）；
4. 新凭证目录（如 `~/.config/mail-relay/lark-cli`，权限 0700）：`LARKSUITE_CLI_CONFIG_DIR=<目录> lark-cli config init` + 授权人 `auth login`；
5. 验收：`node scripts/lark-mail-relay.mjs check --config <新配置>` 通过；对一封历史邮件跑 `forward --dry-run` 成功。

### P3 独立运行 + 灰度切换（约 0.5 天 + 观察 1 个工作日）

> 11-05 已备好（等 P2 审批 + Mac mini）：影子模式 `mailRelay.shadow`、对账命令 `bin/mail-relay.mjs compare`、授权过期告警附重新授权命令、部署包 `packages/mail-relay/deploy/`（配置模板、launchd 模板与渲染脚本、INSTALL.md 全流程含切换顺序与回滚）。
> 切换顺序按 INSTALL.md §6：先关笔记本内置转发 → compare 找出空档手动补转 → Mac mini 去掉 shadow。

1. 新配置 `~/.config/mail-relay/config.json`：`cliConfigDir` 指向 P2 的凭证目录，`stateFile` 用自己的台账，`mode: "watch"`（独立应用才能开），路由沿用现在的两条；
2. 新 launchd `com.fameex.mail-relay.plist` 跑 `scripts/lark-mail-relay.mjs run --config …`；
3. **影子期（1 个工作日）**：新进程加 `dryRun` 开关，只记录「本该转哪封、评几分」，不真发；第二天和 lark-bot 台账逐封对，转发集合和分数都一致才切；
4. **切换**：lark-bot 配置 `mailRelay.enabled=false`（排空重启自动生效），新进程关掉 dryRun；退群白名单改用 `chatRetention.keep` 写死审批群（不然 bot 关了转发会把这个群判成 14 天不活跃）；
5. **回滚**：停新的 launchd，把 lark-bot 的 `mailRelay.enabled` 改回 true。台账互不干扰，最多重复转几封，靠台账去重；
6. 验收：切换后 3 个工作日，收件箱首封和转发记录逐封对账，无漏转、无重复。

### P4 运维补强（约 0.5 天，P3 同时做）

1. **失败告警**：连续 N 次（如 5 次 = 10 分钟）拉取失败、授权过期、分享失败，私信负责人一次，恢复后再报一次；
2. **日志带真实错误**：现在大部分失败日志只有 lark-cli 那行「确认邮箱身份」的提示，真正的错误信息被截掉了，改成跳过 tip 行、保留错误主体；
3. **每日对账**：每天固定时间把收件箱首封和台账对一遍，有漏转的自动补转并报告；
4. **授权续期**：user token 过期 / 刷新失败时告警，附重新授权的命令。

### P5 开放给其他组（等 D1 选 b 才做，约每组 0.5 天）

1. 接入一个组 = 一条或几条路由（主题规则、目标群）+ 可选评分器 + 邮箱授权（D2 的 b 或 c）；
2. 新评分器按既定流程定：收件箱集齐 ≥10 封同类首封 → 归纳评分项 → 范本全 A 回放 → 回群汇报 → 上线；
3. 写一页接入说明：要准备什么、谁授权、怎么验收；
4. 多邮箱：每个授权邮箱一个凭证目录、一份台账，同一个进程里多实例跑（引擎本来就是按 relay 配置实例化的）。

## 4. 工作量汇总

| 阶段 | 动手 | 外部等待 | 风险 |
|---|---|---|---|
| P1 代码拆分 | 0.5–1 天 | 无 | 极低（行为不变，有逐字对比） |
| P2 独立应用 | 0.5 天 | 管理员审批邮件 scope | 中：审批卡住就停在 P1 |
| P3 灰度切换 | 0.5 天 | 1 个工作日影子期 | 低（随时回滚） |
| P4 运维补强 | 0.5 天 | 无 | 低 |
| P5 每接一组 | 0.5 天 | 对方授权 + 集样本 | 取决于评分规则 |

## 5. 风险

| 风险 | 对策 |
|---|---|
| 用户级邮件 scope 管理员不批 | 停在 P1，继续内置在 bot 里；或改走 D2-b 公共邮箱，看能不能少要权限 |
| user token 过期没人发现，转发静默停掉 | P4 告警 + 每日对账 |
| 笔记本合盖导致晚到 | 补转兜底（不漏）；要实时就上常开机器（D3-b） |
| 卡片显示「aven 分享」，别的组不认 | D2-b / c |
| 拆分后两边逻辑分叉 | P1 lark-bot 只 re-export，代码只有一份 |

## 6. 不依赖拆分、可以马上做的（11-05 已做）

1. P4 第 2 条：日志保留真实错误。根因：原来记 `stderr || stdout`，lark-cli 每次都在 stderr 打「tip: … confirm your email identity」，stdout 里的 JSON error 从没记下来。现在 `relayFailureText`：结构化 error 优先、stderr 去掉 tip 行、带退出码。
2. P4 第 1 条的简版：poll 模式连续 `mailRelay.alert.afterFailures`（默认 5）轮读收件箱失败，私信 `mailRelay.alert.openId`（没配用 `notifyOpenId`）一次，带最近错误；恢复后再报一次。发信走引擎自己的 lark-cli 调用器（bot 身份），拆成独立应用后自动换成新应用的 bot，不依赖网关的私信通道。
