# 校准保真度：falive 代码在模拟器里 vs falive 当时（P1，11-04）

数据：`node scripts/sim/calibration-fidelity.mjs`（`--gist` 才调模型）→ 同目录 `fidelity.json`（汇总 + 逐 case）、`fidelity-cases.md`（逐 case 对照表与明细）。
人工归因在 `fidelity-labels.json`（逐条看过日志 / 会话记录后写的，脚本按它出类别）。20 组、54 条 case，待办 6 条不计分，计分 48 条。

## 结论（先说）

- **模拟器在「能还原的输入」上是忠实的**：拿掉模拟偏差、还原不了、说不清三类格子，剩下 259 个可比格子里 236 个对得上（**91%**）——这就是 falive 代码同输入自己跟自己的一致度（抽样噪声底）。
  看到的人话上下文 29 条可比里 27 条一致（93%），两条差异都是模拟偏差、已修。
- **原始口径**：321 个可比格子对上 236（73.5%）、部分对上 9；8 个字段全对的 case 14 / 48（29%）。上一版 33% 全对的低数主要是 falive 一侧缺数据，补齐后差异有了真实归因：
  模拟偏差 32 格（12 条 case）、还原不了 26 格（14 条）、模型抽样 23 格（12 条）、说不清 4 格（3 条，都是 falive 一侧消息归属歧义，结论大意都一致）。
- **可以用它判 lark-bot 基线**，前提：（1）用本分支修过的模拟器（下表 8 处偏差修了 7 处，复跑已验证 4 组）；（2）下面「判的时候标模拟局限」的 6 类 case 不按结论对错判；
  （3）单条 case 上 lark-bot 和 falive 的差异要大过约 1 成的抽样噪声才算数——分类、回不回、终态这些单格指标，单条一次跑出的差异有 1 成概率只是抽样。

## falive 那一侧怎么补的

| 字段 | 来源 | 覆盖 |
|---|---|---|
| 群里 / 私信 aven 说了什么、几句、首句时延 | 时间线里自家 bot 的消息（`text`，人看到的样子），用同一个归属函数归到触发消息上（`attributeMessages`，两边共用）；只取到模拟收尾时刻（clock.json） | 48 / 48 |
| 分类、路径（ack / 挂待确认 / 开始 / 续跑 / 并入 / 锚不到 / 出口闸）、终态 | falive 网关日志按 id 取行（`routeState`，两边同一套代码同一种日志）；私聊续跑行不带本条 id 的按原话对回（`matchTextLines`） | 终态 48 / 48，分类 35 / 35（其余两边都不走分类） |
| 看到的上下文 | 两边 worker.log 的领单正文（`claimed <id> via claude:` 后整段）；只比人说的行（bot 的话和「正在进行的事」块是上游 bot 输出的派生，不比） | 29（其余没建执行任务） |
| 当时会话做了什么（归因用） | falive 当时的 Claude 会话记录 `~/.claude/projects/-Users-aven-github--lark-falive-lark-falive-<id 尾 8 位>/`（10-27 前审计没有，这里有） | 28 条 case 有 |
| 结论大意 | 模型比（opus effort low，共 57 次）：第一轮按归属两两比；不是 same 的第二轮把 falive 那段时间全部消息给模型自己找对这条的回复（不靠启发式归属） | 30 |

归属函数在模拟一侧有真值（发件簿 taskId）可量：群消息 59 条对 54 条（**91.5%**）；错的都是同一个人 2 分钟内连发几条、ack 顺序和到达顺序不一致。说不清的 4 格就出在这里。

## 逐字段

| 字段 | 可比 | 对上 | 部分 | 差异归因（格） |
|---|---|---|---|---|
| 回没回 | 48 | 40 | – | 模拟偏差 5、还原不了 2、抽样 1 |
| 群里几句 | 48 | 30 | – | 模拟偏差 7、抽样 6、还原不了 4、说不清 1 |
| 私信 aven 几句 | 48 | 36 | – | 模拟偏差 6、还原不了 4、抽样 1、说不清 1 |
| 首句时延（2 分钟内或差 ≤60s 或不到一倍算对上） | 35 | 29 | – | 模拟偏差 2、还原不了 2、说不清 2 |
| 分类 | 35 | 26 | – | 抽样 5、模拟偏差 3、还原不了 1 |
| 终态 | 48 | 35 | – | 模拟偏差 5、抽样 4、还原不了 4 |
| 结论大意 | 30 | 13 | 9 | 还原不了 9（几乎全是环境漂移）、抽样 6、模拟偏差 2 |
| 看到的人话上下文 | 29 | 27 | – | 模拟偏差 2 |

首句时延整体模拟更快：中位 falive 47s、模拟 27s（见下「时序」）。

## 模拟偏差（能修的）与修法

| # | 偏差 | 影响的 case | 根因（代码） | 修法 | 状态 |
|---|---|---|---|---|---|
| 1 | 任务库没还原：私聊「已部署」锚不到「12 小时内发给你的任务通知」，回「这句没对上任务」 | ep-1028-03cd66 C1/C2（待办）；同类共 6 条私聊 | `run-sim-falive.mjs` 还原了发件簿 / 台账 / 义务 / 待确认文档，没还原 `lark-tasks`；falive 锚定看任务回执（`lark-principal-channel.mjs resolvePrincipalAnchor`） | `falive-restore.mjs taskStubsFromAudits`：按审计补窗口前 24h 内了结、72h 内挂起的任务（带 start / 结果回执时刻）；窗口前在飞的列进 `task-restore.json` | 已修；复跑 fix-ep-1028-03cd66：C1 锚到 retest-falive-20261028-1047、C2 锚到 C1，路由与 falive 当时逐行一致，两条都 done |
| 2 | 「推 pre」被当成「不是负责人」忽略，一句不回 | ep-1023-08e243 C1 | 关部署盯梢时整段删了 `dailyReport.sweep`，而 `isPushPrePrincipal` 要求开了清扫 | `sweepForSim` 只去 preSiteUrl / onDeploy；origin 换成模拟目录里的裸仓快照（窗口时的 pre / online / 基线，对象借主仓），fetch / push 都在本机 | 已修；复跑 fix2：回「pre 已经是最新」。falive 当时是「合 lark/falive-integration 有冲突」——任务分支 git 状态还原不了（见局限 2） |
| 3 | 融合群照发群，falive 当时只私聊 | ep-1027-c4346b C1 | 配置备份按 mtime 取（`pickConfigBackup`），10-27 10:27Z–11:00Z 之间 `privateOnlyChats` 改过却没留备份 | `privateOnlyEvidence / privateOnlyAt`：按 falive 网关日志里的实际行为（「只私聊不发群」 vs 「ok via webhook」）取窗口那一刻每个群的状态 | 已修；复跑 fix：群里不发、只私聊，同 falive |
| 4 | 挂在 falive 当时那张卡下的话题回复收不到 | ep-1027-d756ea C2「文档在哪里」 | 组内 falive 的话一律不供（模拟 bot 自己回），话题根不在列表里，轮询发现不了话题 | `ownRootsToKeep`：组内话题回复的话题根（falive 的卡）照供 | 已修；复跑见下 |
| 5 | 话题回复等 2 分钟没收到就往下推、随即收尾 | ep-1030-167d28 C5 | 话题轮询每轮最多 5 个、冷话题 30 分钟一次，比主列表慢；推时钟每条只等 2 分钟 | 话题回复（有 threadId + parentId）等 6 分钟 | 已修，未复跑 |
| 6 | Claude 记忆缺篇：会话不知道 bug 表怎么查，直接 blocked | ep-1024-9ebe13 C1（连带 C3）；falive 当时会话还读过缺的篇：ep-1024-b22368、ep-1030-167d28 C5 | 只拷窗口前改过的记忆，之后改过的整篇丢（bug-sheet-workflow.md 11-02 改过，10-24 当时是在的） | `memory-asof.mjs`：按 Claude 会话记录的 Write / Edit / 整篇 Read 重放到窗口起点；重放不出（中间被 Bash 改过）但窗口前就有的，用现在版本近似（名单进 `memory-restore.json`）；`--memory-strict` 恢复旧做法 | 已修（近似）；10-24 的窗口 32 篇后改过的：重放出 3–4 篇、近似 11–16 篇 |
| 7 | 组外 case 从历史里整条藏了，「群里之前的消息」窗口往前多吃几条 | ep-1027-63a6f3 C4、ep-1030-b864a1 C6（上下文差） | `meta.hiddenIds` 在假 CLI 里哪儿都不供（怕轮询当新消息接走）；run-sim（lark-bot）是照供的 | `meta.hiddenAsHistory`：组外触发照列当历史，轮询状态预先记成 seen；falive 对它们的原话也照供，只藏本组的（`hideBotIds = faliveBotIds`，同 run-sim 口径）；`--hide-triggers` 恢复旧做法 | 已修；复跑 d756ea 是第一组用新口径的。代价：episodes.mjs 没归到本组的 falive 原话（归属是启发式）会被当历史供出去 |
| 8 | 时序压缩：模拟首句更快，2 分钟 ack 去重、并入挂起任务的结果跟着变 | ep-1024 C5（ack 没被去重）、ep-1030-167d28 C1/C2（模拟 C1 先挂起，C2 并进来；falive 当时另起一单）、ep-1030-b864a1 C5 时延 | 推时钟跳到消息时刻时，轮询定时器是真实时间、按跳表前「刚有新消息」选的活跃间隔（30s），falive 当时多是安静后的空闲间隔（120s）且相位随机；另有当时组外任务的负载 | 建议：跳表跨过长空档时，先跳到「消息时刻 − 空闲间隔 × 随机相位」让轮询选空闲间隔，或直接在假 CLI 里让消息晚 U(0, 间隔) 出现；没做（相位本身没法知道当时的值，只能拿分布对齐） | 未修 |

另一个顺带查到、影响 lark-bot 基线的泄漏：模拟里的 Claude 会话能读 `~/.lark-bugpoll/snapshot.json`（今天的 bug 表快照，含窗口之后的备注）。
全量会话记录里 full-a/b/c、fix-a/b/c、smoke、r6 共 64 个会话读过，校准里 1 个（cal-ep-1027-d756ea）；b1 / b2 目前没有。
另外 Claude Code 给会话的「今天日期」是真实日期（复跑 03cd66 的 C2 写了「和 11-04 那轮一致」）。建议在 `claude-quota.mjs` 起会话时加 `--settings` 的 deny 规则挡 `~/.lark-bugpoll`，日期没有好办法，判的时候注意。

## 还原不了的（模拟局限）

| 类 | case | 说明 |
|---|---|---|
| 环境漂移：实测打的是今天的 pre / uat / online | 8 条（ep-1026-9769e5 C1/C2、ep-1027-63a6f3 C3/C4、ep-1030-b864a1 C1–C4） | 结论大意差异 17 格里 9 格是它：当时 404 / 301 / 拉不到流，今天 200 / 101 / 能拉 |
| 窗口前任务库（审计 10-27 08:32Z 才开始记） | 3 条待办私聊（「已部署」「已发布」） | 10-27 早上之前的私聊指示锚不到任务；之后的按修 1 能还原 |
| 合回状态 / 任务分支 | ep-1030-83e8e3「帮我合」；ep-1023-08e243 交付物 | `runtime/lark-merge-back` 存档里今天是空的、任务分支（lark/falive-*）不在快照里 |
| 被编辑的消息 | ep-1024-9ebe13 C6（连带 C7） | 原始数据 update_time 比 create_time 晚 8 秒：falive 当时轮询到的是编辑前、没 @ 的版本，没接；模拟拿编辑后的。原始 API 有记录的 160 条 case 里 15 条编辑过（≥2 秒） |
| 当时发送失败 | ep-1023-98f8fa、ep-1024-b22368 | falive 的 ack webhook 当时 ERR_SSL 没发出去 |
| 当时 falive 自身状态 | ep-1024-9ebe13 C1 时延 | 当时在排空重启跑单测（不领新单），首句 154s |

## 判 lark-bot 基线时要标「模拟局限」的 case 类型（判法：只看过程，不按结论对错）

1. **实测类**（复测 / 「接口通不通」/ 拉流 / 部署状态）：结论按今天环境，和 falive 当时结论相反不算错；对照 `verification-evidence.jsonl` 看测法和报告是否如实。
2. **控制台私聊指示锚窗口前的任务**（已部署 / 已发布 / 推 pre / 帮我合 / 继续任务 <窗口前 id>）：lark-bot 当时根本没有这些任务；10-27 08:32Z 前 falive 校准也还原不了。
3. **被编辑的触发消息**（原始 API update_time − create_time ≥ 2s）：falive 当时可能没看到 @，「falive 没回」不能当基线。
4. **时序敏感**：同一人 2 分钟内连发（ack 去重）、话题里接连补充（并入挂起任务 vs 另起一单）——分单方式不同不算错，按整件事判。
5. **falive 当时发送失败 / 自身在排空重启**：falive 一侧「没回 / 回得慢」不作数。
6. **依赖记忆或 bug 表快照的**（bug 号复测、bug 表认领）：记忆是近似版本；会话若读了 `~/.lark-bugpoll` 是拿到了未来的数据，判的时候把这类 case 单列。

## 方法本身的局限

- 每组只跑了一次，抽样噪声底（91%）是 48 条 case 上的粗估；要更准得同组多跑几次（本次复跑 ep-1027-c4346b 一次就从 done 变成 waiting_confirmation：分析阶段没给范围，正是抽样）。
- falive 一侧群消息归属是启发式（模拟真值上 91.5%），说不清的 4 格都出在这里；结论大意第二轮已绕开归属。
- 结论大意靠模型判（57 次），partial / different 的边界有主观成分；逐条理由在 `fidelity-cases.md`。

## 复跑验证（本分支修过的模拟器，sim 目录 `fix-<组>` / `fix2-<组>`）

| 组 | 修了什么 | 结果 |
|---|---|---|
| ep-1028-03cd66 | 任务库还原 | 两句「已部署」都锚上（C1→retest-falive-20261028-1047、C2→C1），各自 done，路由行与 falive 当时一致 |
| ep-1023-08e243 | sweep 保留 + origin 快照 | 「推 pre」有回复（「pre 已经是最新」）；falive 当时「合冲突」，差在任务分支 |
| ep-1027-c4346b | 只私聊按日志 | 群里不发、只私聊，同 falive；终态 waiting_confirmation（抽样，上一跑是 done） |
| ep-1027-d756ea | 话题根照供 + 组外照列 | C2「文档在哪里」这次收到了（轮询 10s）、锚到 C1、done，同 falive；代价也看到了：模拟 bot 看到的是 falive 当时那张「整理在文档里」的卡，回了句「那张卡片当时没把文档建出来」。C1 这次 blocked（找不到 Bug-4970 描述）——第一跑是读了 `~/.lark-bugpoll` 快照才答上的（泄漏），falive 当时靠记忆 → bugpoll 快照，抽样 + 记忆近似 |

## 复现

```
node scripts/sim/calibration-fidelity.mjs            # 用缓存的模型结论重算
node scripts/sim/calibration-fidelity.mjs --gist     # 缺的结论大意才调模型（上限 --max-gist，默认 60）
node scripts/sim/run-sim-falive.mjs --episode <组> --sim fix-<组> --reset [--memory-strict] [--hide-triggers]
```
