# OL 上线申请邮件规范度评分 · 2026-11-02

> 来源：aven 11-02「在我的收件箱里拉出 100 封 OL 的邮件，分析出其中哪些比较标准的」→「将评分逻辑形成文档落盘，转发 OL 审批邮件到审批群时附评分」。
> 实现：`lib/lark-mail-ol-score.mjs`（OL 评分器）；11-02 晚泛化成审批邮件转群引擎 `lib/lark-mail-relay*.mjs`（路由 / 预设 / 转发 / 引擎，见 §8），入口 `scripts/lark-mail-relay.mjs`。
> 测试：`__tests__/lark-mail-relay.test.mjs`。

## 1. 样本

- aven 收件箱 INBOX，`mail +triage --query OL / ONLINE` 各翻 6 页（每页 400），主题过滤出带 OL 环境标记的，按 thread 归并，取最近 100 个线程（2026-10-14 ~ 11-02），每个线程取首封申请。
- 其中 3 封是 Falive【PRE环境】/【UAT环境】邮件，标题里只是提到 online，按 §2 判定不算 OL，**实际 OL 申请 97 封**。

## 2. 什么算「OL 上线申请首封」（决定转不转）

全部满足：

1. 主题带 OL 环境标记：`【OL】【ONLINE】【OL环境 …】【ol】【Online】【OLINE】`，或嗨聊的 `】OL環境-`。标记前面必须是 `【` / `】` / 空白 / 开头，后面必须是 `】` / 空白 / `-` / 结尾，免得 `TOOL`、`OLD` 之类误中。
2. 主题不以 `Re: / Fw: / 回复 / 回覆 / 答复 / 转发 / 轉寄` 开头。
3. 邮件头没有 `in_reply_to`。

线程里后续的「进行」「在线」「已完成」「验收通过」都不转。

## 3. 16 项评分（各 1 分）

### 主题（3）

| 项 | 判定 |
|---|---|
| 环境标签规范 | 含 `【ONLINE】`、`【OL】`、`【ONLINE环境】` 或 `【OL环境】`（`【OLINE】`、`【ol】`、`【Online】` 不算） |
| 结尾 8 位日期 | 结尾是 `【YYYYMMDD】`，允许后面再跟一个标签（如 `【自测】`）；`【202601102】`（9 位）、`【2026-10-27】`、`【日期】` 都不算 |
| 需求 / Bug 编号 | 含 `PR- / XBUG- / BUG- / TR-` 加 3 位以上数字 |

### 正文：9 段模板（10）

标准模板是「Hi，尊敬的客户您好：本次已通过测试验收，请安排以下更新」，后接 9 段：

| 项 | 判定 |
|---|---|
| 一、环境 | `一、环境`，或 `环 境：`（Reid 变体） |
| 更新内容 | `更新内容` / `新增内容`，并且有 `开发者` / `开发` 列 |
| 上线参与人及职责 | 有该段，并且列了 QA / 研发验收 / 产品验收 / 测试验收 |
| 在线 + 时限 | `已确认在线`，并且写了 `验收结论时限` 或 `60 分钟` |
| 发布版本 | 有 `PROD-<8 位以上 hash>` |
| 操作步骤 | `操作步骤 / 服务更新 / 更新操作 / 执行 / sql / 配置更新 / sync` 任一 |
| 回滚方式 | `回滚 / 回退 / 可回滚版本` 任一 |
| 线上验收 Checklist | `线上验收` 或 `Checklist` |
| 注意事项 | `注意事项` |
| 附件清单 | `附件清单` |

正文是回复时，会先去掉「xxx 于…写道：」之前的回复语，只看引用的原申请。

### 收件（3）

| 项 | 判定 |
|---|---|
| 收件人 | To 里有 `sysops@hqstech.com` |
| 抄送 CTO | To / Cc 里有 `devcto@…` |
| 抄送 QA | To / Cc 里有 `qa@globaldev.info` |

### 档位

| 档 | 分数 | 含义 |
|---|---|---|
| A 标准 | ≥14 | 9 段基本写全，有发布版本和回滚版本，收件人正确 |
| B 基本合格 | 12–13 | 前 4~6 段齐全，通常缺七~九段（Checklist / 注意事项 / 附件清单） |
| C 不完整 | 9–11 | 缺参与人表、版本 TAG 或回滚方式，主题常不规范 |
| D 不按模板 | ≤8 | 自由格式 / 运维操作单 / 其他项目自有格式 |

### 附加提示（不计分）

- **类别**：主题含 `Falive` → falive 简版；含 `嗨聊` → 嗨聊自有格式；含 `补K线` / `撮合 重启` → 运维操作单。这三类会注明「9 段模板不完全适用」，分数只作参考。
- **⚠️ 高风险无回滚**：正文出现 `insert / update / delete / truncate / drop / alter / sql / redis / 重启 / 删除 / raft`，但没有回滚项时单列提醒。

## 4. 97 封的分布（按本模块口径）

| A | B | C | D |
|---|---|---|---|
| 15 | 38 | 17 | 27 |

- **A 档的范本**：Alec（6 封，如 `TR-02647 Banner图删除修改为软删除`，SQL 走附件并写进附件清单，回滚写明「用可回滚版本 TAG 重新发布」）；Tina（`PR-02056/PR-02057`，16 个服务各列发布 TAG 和回滚 TAG）；Hurley（7 封，正文 9 段全，但主题日期写成 9 位、常缺需求号）。
- **最常缺的项**（HQEX 70 封）：附件清单 56、Checklist 53、注意事项 51，因为大多数人用只到第四~六段的精简模板；其次是版本 TAG 26、参与人表 24、需求号 20、日期 17、环境标签 7。
- **风险最高、却最不规范的**：撮合重启、冲销 SQL、审计 trigger，基本只有几行文字或直接贴 SQL，没有回滚，也没有验收人。

## 5. 转发到审批群

```
aven 收件箱 ──(user) mail +message──▶ 打分 ──(user) mail +share-to-chat──▶ 群里一张邮件卡片（以 aven 名义）
                                                     └──(bot) im +messages-reply──▶ 卡片下回评分说明
```

- `+share-to-chat` 只支持 user 身份，所以卡片以 aven 的名义发。返回的是 `data.im_message_id`，不是 `message_id`（11-02 真发核对过）。
- 评分由 bot 回复在卡片下。bot 不在群里、回复失败时，回落为 bot 直发；还失败就用 aven 身份直发，保证评分能到群。
- 手动触发：`node scripts/lark-mail-relay.mjs forward --message-id <id> [--route ol-release] [--dry-run] [--force]`（按路由表转，见 §8）。
- 目标群：「fe審批更新bot/人工群（测试中）」`oc_936db0947fefddc46ee6ac1f30528b7b`。**11-02 时 bot 还不在这个群**，正式转发前要先拉 bot 进群，否则评分会以 aven 身份发出。测试群：「lark-bot 测试群」`oc_da69155c32afd9b0b3efe679e638ce5e`。

## 6. 自动触发：不加轮询，用邮件事件

> **11-02 晚改口：默认改回定时拉（`mailRelay.mode` 缺省 poll，每 2 分钟 `mail +triage`）。** 同一应用里常驻 `+watch` 的代价比下面估计的大：飞书把 im 消息事件分给 +watch 那条连接后，它报「not found handler」丢掉，靠飞书重投——4 小时丢了 6 条 `im.message.receive_v1`，aven 一条私信「test 和 pre 一样吗」连投两次都落到 +watch，晚了 5 分钟才到网关。`mode: "watch"` 只留给拆成独立应用之后用。下面是当时的分析，留作记录。

### 可用的事件

`mail.user_mailbox.event.message_received_v1`（新邮件到达）。lark-cli 的入口是 `mail +watch`（WebSocket 长连接），`--msg-format metadata` 直接带主题、发件人、收件人、folder，可以先按主题过滤，命中后再 `+message` 读正文。它是推送，不是轮询。

### 现状缺什么（11-02 实测 `mail +watch --dry-run`）

1. **user 授权缺 3 个 scope**：`mail:event`、`mail:user_mailbox.event.mail_address:read`、`mail:user_mailbox:readonly`。需要 aven 扫码补授权：`lark-cli auth login --scope "mail:event mail:user_mailbox.event.mail_address:read mail:user_mailbox:readonly"`。读信、分享已有的 scope 够用。
2. **开发者后台**：应用 `cli_aabf9468b1789ed4` 的「事件与回调」要添加 `mail.user_mailbox.event.message_received_v1`，并发布版本。用户级邮件权限可能需要租户管理员审批。
3. **要实测的一处风险**：网关现在通过 lark-cli 的本机 event bus（一条 WebSocket，多个 `event consume` 共用）收 `im.message.receive_v1`。`mail` 事件不在 `event list` 里，`+watch` **可能自己再开一条长连接**。飞书长连接在同一应用有多条连接时，每个事件只推给其中一条。如果 +watch 另开了连接，就可能**抢走网关的群消息事件**。验证方法：网关运行时起 `+watch`，看 `lark-cli event status` 里它是不是挂在同一个 bus 下，同时在测试群 @bot 几次，看网关有没有漏收。
   - 如果走同一个 bus，或者不抢事件：直接用网关现有的 `startConsumer` 思路，再挂一个常驻 `mail +watch` 子进程（自愈重连），不需要新进程或新轮询。
   - 如果会抢：改由网关进程统一持有长连接（等 lark-cli 把 mail 事件并进 event bus），或者单独起进程（见 docs/plan-mail-approval-2026-11-02.md）。
4. **user token 续期**：当前 refresh token 到 2026-11-09 过期（有 `offline_access`，lark-cli 刷新时会续）。常驻 `+watch` 持续使用 user 身份，要确认它会自动刷新；过期时私信 aven 重新授权。

### 11-02 实测结论（授权、事件订阅都已完成后）

- 3 个邮件 scope 已授权，`mail +watch --dry-run` 通过；应用 1.0.9 / 收信通知事件已发布。
- **`+watch` 自己另开一条 WebSocket**，不走网关在用的 event bus：起 `+watch` 后 `lark-cli event status` 的消费者仍是原来 2 个，`+watch` 日志里是自己的 `connected to wss://msg-frontier-sg…`。
- **飞书会在同一应用的两条连接之间分流事件**：+watch 运行时在测试群连发 4 条 @bot，+watch 那条连接收到其中 1 条 `im.message.receive_v1`（报 `not found handler` 丢弃）；网关最终 4 条都收到，但第 3 条晚于第 4 条才到，是 +watch 处理失败后飞书重投过来的。
- 所以**不能在同一个应用下常驻 `+watch`**：群消息会时不时被延迟（靠重投），重投次数用完、或每次都落到 +watch 那条连接上，就会丢；bot 进群、表情回复等事件同理。
- 可行方案：
  1. **单独建一个应用专收邮件事件（推荐）**：新应用只开邮件权限和收信通知事件，aven 在新应用上授权一次。它有自己的长连接，和网关互不抢；凭证用独立目录（`LARKSUITE_CLI_CONFIG_DIR`），也顺带满足 docs/plan-mail-approval 里「领导凭证和 worker 隔离」的要求。转发进群仍由 bot（现应用）回评分。
  2. 网关自己实现一条 WebSocket，同时处理 im 和 mail 事件，替掉 lark-cli event bus：改动大，碰群消息主链路，不推荐。
  3. 等 lark-cli 把 mail 事件并入 event bus（1.0.98 的 `event list` 里还没有）。

### 停机补漏（一次性，不是轮询）

和群消息一样，停机期间的邮件事件飞书不会补推。网关启动时做**一次** `mail +triage --query OL --filter '{"folder":"INBOX"}'`，补转「上次存活时间」之后到达的申请首封。按 message_id 记账去重，已转过的不再转。这只在重启时跑一次，不是定时轮询。

### 零代码的替代方案（不带评分）

在邮箱建一条收信规则（`mail +rule-create`）：主题包含 OL 标记时，转发到审批群的群邮箱地址。邮件会以原生邮件卡片出现在群里。缺点是没有评分，规则的正则能力也弱，`【OL` 和 `TOOL` 分不清。适合在事件方案落地前先顶上。

## 7. 现状（11-02 晚）

- aven 选择先和 bot 共用应用试跑几天（接受 §6 的分流代价）；bot 已进「fe審批更新bot/人工群（测试中）」，网关常驻 `mail +watch`。
- 待定：运维操作单（补 K 线 / 撮合重启）是否另立一套「运维模板」评分——现在统一按 9 段模板打分，并注明不适用。

## 8. 审批邮件转群引擎：路由、预设、拆分

aven 11-02：「如果好用，后面可能做成单独的应用，现在预留好接口，方便一键拆分」「领导用的时候不止 online 上线审批，还有加白名单等，要封装好方便配置」。

### 分层

| 文件 | 职责 |
|---|---|
| `lib/lark-mail-relay-presets.mjs` | 评分器注册表 `MAIL_SCORERS` 和预设 `MAIL_PRESETS`（一类审批的默认「怎么认 + 怎么评」） |
| `lib/lark-mail-relay-routes.mjs` | 路由归一 / 匹配 / 配置校验（纯函数） |
| `lib/lark-mail-relay-forward.mjs` | 一封邮件按路由转：读信 → 复核 → 分享卡片 → bot 回评分或类别 |
| `lib/lark-mail-relay.mjs` | 引擎：常驻 +watch、台账、启动补转、`createRelayCli`（凭证切换） |
| `lib/lark-mail-ol-score.mjs` | OL 上线评分器（§2–§3） |
| `scripts/lark-mail-relay.mjs` | 独立入口：`check` / `forward` / `run` |

引擎只依赖三个可注入件：lark-cli 调用器、台账 io、长连接启动器。不碰网关的任务链路和群消息链路。

### 配置（`runtime/lark-bot.local.json` 的 `mailRelay`）

```json
"mailRelay": {
  "enabled": true,
  "cliConfigDir": null,
  "stateFile": null,
  "routes": [
    { "id": "ol-release", "preset": "ol-release", "chatId": "oc_936db0947fefddc46ee6ac1f30528b7b" },
    { "id": "whitelist", "enabled": false, "label": "加白名单审批", "chatId": "oc_…",
      "match": { "subject": ["白名单"], "subjectNot": ["撤销"], "from": ["@hqstech.com"], "to": ["sysops@hqstech.com"] },
      "scorer": null }
  ]
}
```

- **路由字段**：`id`（唯一，记进台账）、`enabled`（默认 true）、`preset`、`label`（群里显示的类别名）、`chatId`、`scorer`（评分器 id；写 `null` 表示只转发不评分）、`reply`（默认 true；false 表示只分享卡片、bot 不回）、`match`。
- **match**：`subject` 正则任一命中、`subjectNot` 正则都不中、`from` 地址或 `@域名` 任一命中、`to`（收件 + 抄送）任一命中；没写的条件不限制。`firstOnly` 默认 true，只转申请首封。正则不区分大小写。
- **预设**：写了 `preset` 就继承预设的 label / scorer / 主题判定，路由里自己写的字段覆盖预设。`ol-release` 的主题判定是函数（§2 的 OL 标记边界），它和配置里写的 `match.subject` 是「且」的关系。
- **多条路由都命中**：按顺序取第一条，一封邮件只转一次。
- **校验**：网关启动时校验，`check` 命令也会校验。正则写错、id 重复、chatId 不是群、预设或评分器名不认识，都会报错。没有预设也没写任何 match 条件的路由也会被拒收，因为它会把所有邮件都转出去。
- **闲置自动退群**：启用路由的目标群一律豁免。

### 新增一类审批

1. **只转发、不评分**（比如加白名单）：在 `routes` 里加一条，写 `label` 和 `match`，`scorer: null`，不用改代码。先用 `node scripts/lark-mail-relay.mjs check` 校验，再用 `forward --message-id <一封真邮件> --route whitelist --dry-run` 看命中情况。
2. **要评分**：在 `lark-mail-relay-presets.mjs` 加一个评分器 `{ score(mail) → { score, max, tier, tierLabel, items }, render(result, { sender, subject, label }) → markdown }`，再加一个引用它的预设，然后在路由里写 `preset`。

### 拆成独立应用（一键拆分）

1. 新建飞书应用：开邮件权限（§6 列的那几个）、im 发消息 / 回复权限、「收信通知」事件，发布版本。
2. 准备新应用的 lark-cli 凭证目录：`LARKSUITE_CLI_CONFIG_DIR=<目录> lark-cli config init`（填新应用的 app id / secret），再用同一个环境变量 `auth login` 让邮箱主人授权。
3. 写一份独立配置 `{ "mailRelay": { "enabled": true, "cliConfigDir": "<目录>", "stateFile": "<新台账路径>", "routes": [...] } }`。
4. `node scripts/lark-mail-relay.mjs check --config <独立配置>` → `run --config <独立配置>`（正式上线时给它一个 launchd plist）。
5. 网关这边把 `mailRelay.enabled` 改成 false。

`cliConfigDir` 会让引擎里所有 lark-cli 调用（读信、分享、bot 回复）以及 `+watch` 子进程都带上 `LARKSUITE_CLI_CONFIG_DIR`，整条链路换成新应用。新应用有自己的长连接，§6 的分流问题也就没有了。

### 以后接领导邮箱（自动审批）

路由的匹配和评分可以直接复用。差别在两处：邮箱主人换成领导（独立凭证目录，正好用 `cliConfigDir`）；动作从「转群」变成「私信确认 / 回复进行」，届时在 forward 这一层加一种动作，方案见 docs/plan-mail-approval-2026-11-02.md。
