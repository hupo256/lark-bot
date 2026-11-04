# 校准逐 case 对照（54 条，计分 48）

由 `node scripts/sim/calibration-fidelity.mjs` 生成，别手改；结论见 fidelity.md。✓ 对得上 ✗ 对不上 ½ 部分 · 不可比。

| 组 | case | 类型 | 原话 | 回 | 群 | 私 | 时延 | 分类 | 终态 | 大意 | 上下文 | 归因 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ep-1023-08e243 | C1 | principal_dm | 推 pre | ✗ | 0→0 | 1→0 | 115s→—s · | —→— | none→none | · | · | 模拟偏差（能修）：配置：sweep 整段删掉 |
| ep-1023-98f8fa | C1 | at_bot | 我记得 2 已经有定论了，帮忙解答一下 @Aven.Bot | ✓ | 1→2 | 2→2 | 185s→26s ✗ | question→question | done→done | ✓ | 100%+0 | 还原不了（模拟局限）：当时发送失败 |
| ep-1024-9ebe13 | C1 | at_bot | @Aven.Bot Bug-4942 再复测下 ！ | ✓ | 2→2 | 2→3 | 154s→30s ✗ | api_reply→bug | no_change_needed→blocked | ✗ | 100%+0 | 模拟偏差（能修）：Claude 记忆缺篇 |
| ep-1024-9ebe13 | C2 | principal_dm | 继续任务 om_x100b62fc7a2060a4eed44f2ab9ebe13 | ✓ | 0→0 | 0→0 | —s→—s · | —→— | resumed→resumed | · | · | — |
| ep-1024-9ebe13 | C3 | at_bot | 存「I'm QA.」读回来还是「I'm QA.」 有什么问题 ？ @Aven.B | ✓ | 2→1 | 2→2 | 53s→46s ✓ | api_reply→api_reply | no_change_needed→waiting_confirmation | ½ | · | 模拟偏差（能修）：连带（C1 偏差） |
| ep-1024-9ebe13 | C4 | at_bot | @Aven.Bot 测试 帖子多语言翻译 以及 AI识图 功能 ！ | ✓ | 2→1 | 3→2 | 69s→27s ✓ | api_reply→api_reply | done→waiting_confirmation | ✗ | · | 模型抽样（同输入不同输出）：分类 forMe 抽样 |
| ep-1024-9ebe13 | C5 | at_bot | @Aven.Bot 所以不是Bug ? | ✓ | 1→2 | 2→2 | 132s→22s ✗ | question→question | done→done | ✓ | 100%+0 | 模拟偏差（能修）：时序（时钟压缩） |
| ep-1024-9ebe13 | C6 | at_bot | <p>测试的tid 发出来 @Aven.Bot</p> | ✗ | 0→2 | 0→2 | —s→36s · | unknown→question | none→waiting_confirmation | · | · | 还原不了（模拟局限）：被编辑的消息 |
| ep-1024-9ebe13 | C7 | at_bot | @Aven.Bot | ✓ | 2→2 | 1→1 | 30s→27s ✓ | question→requirement | done→done | ✗ | 100%+0 | 还原不了（模拟局限）：连带（C6 被编辑） |
| ep-1024-9ebe13 | C8 | at_bot | @Aven.Bot 创建最新的帖子 进行测试 | ✓ | 2→2 | 1→1 | 62s→33s ✓ | requirement→api_reply | done→no_change_needed | ✓ | 92%+0 | 模型抽样（同输入不同输出）：分类 / 终态措辞抽样 |
| ep-1024-b22368 | C1 | at_bot | https://qfglxo2m3dc.sg.larksuite.com/rec | ✗ | 0→1 | 1→1 | 51s→35s ✓ | bug→bug | started→started | · | 100%+0 | 还原不了（模拟局限）：当时发送失败 |
| ep-1024-f34b24 | C1 | principal_dm | @Aven.Test 空单直接忽略、跳过也行 | ✓ | 0→0 | 1→1 | 100s→12s ✓ | —→— | unanchored→unanchored | · | · | — |
| ep-1026-350ff1 | C1 | at_bot | ![Image](img_v3_0216r_c9207012-b1fe-4410 | ✓ | 2→2 | 2→2 | 49s→38s ✓ | bug→bug | no_change_needed→no_change_needed | ✓ | 100%+0 | — |
| ep-1026-350ff1 | C2 | at_bot | https://falivepre.fdsser.com/bbsv2/membe | ✗ | 0→1 | 2→2 | 46s→106s ✓ | api_reply→api_reply | no_change_needed→no_change_needed | ✓ | 100%+0 | 模型抽样（同输入不同输出）：出口闸去重（连带抽样） |
| ep-1026-350ff1 | C3 | at_bot | @Aven.Bot 测试一下pre环境真实验证码接入 | ✓ | 2→2 | 2→2 | 52s→31s ✓ | api_reply→api_reply | done→no_change_needed | ½ | 100%+0 | 模型抽样（同输入不同输出）：实测范围抽样 |
| ep-1026-4f9abc | C1（待办） | principal_dm | 已部署 | ✓ | 0→0 | 2→1 | 21s→0s ✓ | requirement→— | done→unanchored | · | · | 还原不了（模拟局限）：窗口前任务库（无审计） |
| ep-1026-9769e5 | C1 | at_bot | https://falivepre.fdsser.com/hc-api/api/ | ✓ | 2→2 | 2→2 | 34s→27s ✓ | ignore→ignore | done→no_change_needed | ✗ | 96%+1 | 还原不了（模拟局限）：环境漂移（实测打今天的 pre） |
| ep-1026-9769e5 | C2 | at_bot | @Aven.Bot | ✓ | 2→2 | 2→2 | 33s→35s ✓ | api_reply→question | done→done | ✗ | 100%+3 | 还原不了（模拟局限）：环境漂移（实测打今天的 pre） |
| ep-1027-63a6f3 | C1（待办） | principal_dm | 已发布 | ✗ | 0→0 | 0→1 | —s→7s · | ignore→— | noted→unanchored | · | · | 还原不了（模拟局限）：窗口前任务库（无审计） |
| ep-1027-63a6f3 | C2（待办） | principal_dm | 已部署 | ✓ | 0→0 | 2→1 | 41s→18s ✓ | requirement→— | done→unanchored | · | · | 还原不了（模拟局限）：窗口前任务库（无审计） |
| ep-1027-63a6f3 | C3 | at_bot | @Aven.Bot | ✓ | 2→2 | 2→2 | 92s→33s ✓ | api_reply→api_reply | done→done | ½ | 97%+6 | 还原不了（模拟局限）：环境漂移（实测打今天的 pre） |
| ep-1027-63a6f3 | C4 | at_bot | @Aven.Bot 已關閉沒推流的直播間 | ✓ | 2→2 | 1→2 | 55s→31s ✓ | api_reply→api_reply | done→done | ½ | 95%+4 | 还原不了（模拟局限）：环境漂移（实测打今天的 pre） |
| ep-1027-63a6f3 | C5 | principal_dm | 就这样回 | ✓ | 0→0 | 1→1 | 21s→1s ✓ | —→— | none→none | · | · | — |
| ep-1027-6e06d2 | C1 | at_bot | 508 主播这条，我已经加过了，现在前端还不对吗？ @Aven.Bot | ✓ | 2→2 | 2→2 | 510s→48s ✗ | api_reply→api_reply | done→done | ✓ | 100%+0 | 说不清：falive 一侧归属歧义 |
| ep-1027-6e06d2 | C2 | at_bot | \| C1 \| 某账号发帖回 HTTP 500（Bug-4994） \| 10-26 | ✓ | 2→1 | 2→2 | 18s→131s ✗ | question→question | done→done | ✓ | 97%+0 | 说不清：falive 一侧归属歧义 |
| ep-1027-6e06d2 | C3 | at_bot | https://falivepre.fdsser.com/bbsv2/membe | ✓ | 2→1 | 2→2 | 44s→26s ✓ | api_reply→api_reply | done→done | ½ | 96%+0 | 模型抽样（同输入不同输出）：群回复取舍抽样 |
| ep-1027-6e06d2 | C4 | at_bot | \| Q5 \| 帖子「AI 识图」在哪个页面、哪支接口、哪个字段（10-24 起） | ✓ | 1→1 | 0→0 | 94s→18s ✓ | api_reply→api_reply | noted→noted | · | · | — |
| ep-1027-c4346b | C1 | at_bot | @Aven.Bot 请根据 @Mateo 给的信息，同步更新 web 端的相应逻 | ✗ | 0→2 | 2→2 | 65s→19s ✓ | requirement→requirement | done→done | ½ | 100%+0 | 模拟偏差（能修）：配置：只私聊的群 |
| ep-1027-d756ea | C1 | at_bot | <p>@Aven.Bot 请给我提供一下bug-4970的curl信息</p> | ✓ | 2→2 | 2→2 | 47s→23s ✓ | question→question | done→done | ✓ | 100%+0 | — |
| ep-1027-d756ea | C2 | at_bot | <p>@Aven.Bot 文档在哪里</p> | ✗ | 2→0 | 2→0 | 52s→—s · | question→— | done→none | · | · | 模拟偏差（能修）：话题根被藏 |
| ep-1028-03cd66 | C1（待办） | principal_dm | 已部署 | ✓ | 0→0 | 2→1 | 30s→7s ✓ | requirement→— | done→unanchored | · | · | 模拟偏差（能修）：任务库没还原 |
| ep-1028-03cd66 | C2（待办） | principal_dm | 已部署 | ✓ | 0→0 | 1→1 | 36s→2s ✓ | requirement→— | done→unanchored | · | · | 模拟偏差（能修）：任务库没还原（连带） |
| ep-1028-ee9885 | C1 | at_bot | @Aven.tong @Aven.Bot 请帮我核实一下现在web端调用权益兑换 | ✓ | 2→2 | 2→3 | 43s→33s ✓ | question→question | done→done | ✓ | 93%+1 | 说不清：私信归属歧义 |
| ep-1028-ee9885 | C2（待办） | principal_dm | 已部署 | ✓ | 0→1 | 2→2 | 16s→10s ✓ | question→question | done→done | ✓ | 100%+0 | 说不清：群回复归属歧义 |
| ep-1029-f09207 | C1 | at_bot | @Aven.Bot 帮忙解答一下，说详细点 | ✓ | 2→2 | 2→2 | 47s→24s ✓ | question→question | done→done | ✓ | 100%+0 | — |
| ep-1029-f09207 | C2 | reply_to_bot | cc @HQUCEncone | ✓ | 0→0 | 0→0 | —s→—s · | —→— | none→none | · | · | — |
| ep-1030-167d28 | C1 | at_bot | @Aven.Bot 这个是 online 环境的异常，看看是什么原因，修掉 | ✓ | 2→3 | 2→6 | 105s→17s ✓ | bug→bug | blocked→blocked | ½ | 97%+1 | 模拟偏差（能修）：时序（时钟压缩） |
| ep-1030-167d28 | C2 | at_bot | 这有更多点的信息，请整体看看 @Aven.Bot | ✗ | 4→0 | 4→0 | 140s→—s · | bug→— | blocked→merged | · | · | 模拟偏差（能修）：时序（时钟压缩） |
| ep-1030-167d28 | C3 | principal_dm | 自己登录进去看看，这个是账号： [734343862@qq.com](mailt | ✓ | 0→0 | 0→0 | —s→—s · | —→— | none→none | · | · | — |
| ep-1030-167d28 | C4 | reply_to_bot | 麻烦后台同学看看这个上面提到的接口呢 @Arthur.a cc @Kaiser | ✓ | 0→0 | 0→0 | —s→—s · | —→— | none→none | · | · | — |
| ep-1030-167d28 | C5 | at_bot | bug 列表还需要 web 端修的 bug ，确认一下，请马上修掉 @Aven. | ✗ | 2→0 | 2→0 | 313s→—s · | bug→— | no_change_needed→none | · | · | 模拟偏差（能修）：话题回复等待太短 |
| ep-1030-337e3d | C1 | at_bot | @Aven.Bot OL 个人主页 帮忙看下api 返回资料 https://w | ✓ | 3→2 | 2→2 | 29s→29s ✓ | question→bug | blocked→blocked | ✓ | 100%+0 | 模型抽样（同输入不同输出）：分类抽样 |
| ep-1030-337e3d | C2 | reply_to_bot | ![Image](img_v3_0216v_91843cae-335a-438d | ✓ | 0→0 | 0→0 | —s→—s · | —→— | none→none | · | · | — |
| ep-1030-337e3d | C3 | at_bot | 个人资料必须要登陆才行，请aven 给你一个账户 @Aven.Bot 帮忙看下  | ✓ | 2→1 | 2→2 | 47s→36s ✓ | api_reply→api_reply | blocked→blocked | ✓ | 100%+1 | 模型抽样（同输入不同输出）：群回复句数抽样 |
| ep-1030-337e3d | C4 | reply_to_bot | [Image: img_v3_0216v_c34eb065-1c58-435f- | ✓ | 0→0 | 0→0 | —s→—s · | —→— | none→none | · | · | — |
| ep-1030-337e3d | C5 | reply_to_bot | @Arthur.a cc @Kaiser @HQUCEncone | ✓ | 0→0 | 0→0 | —s→—s · | —→— | none→none | · | · | — |
| ep-1030-83e8e3 | C1 | principal_dm | 帮我合 | ✓ | 0→0 | 3→1 | 7s→4s ✓ | —→— | none→unanchored | · | · | 还原不了（模拟局限）：合回状态 / 任务分支还原不了 |
| ep-1030-b864a1 | C1 | at_bot | @Aven.Bot 能不能将全部功能先打包到 uat OL 这样后端可以明显的排 | ✓ | 2→1 | 2→2 | 34s→29s ✓ | requirement→requirement | no_change_needed→blocked | ✗ | 100%+0 | 还原不了（模拟局限）：环境漂移（实测打今天的 uat） |
| ep-1030-b864a1 | C2 | at_bot | ### U2 前台 nginx 没转发 `/hc-ws`（行情推送） - **现 | ✓ | 2→2 | 2→2 | 32s→27s ✓ | api_reply→api_reply | done→done | ✗ | 100%+1 | 还原不了（模拟局限）：环境漂移（实测打今天的 uat） |
| ep-1030-b864a1 | C3 | at_bot | @Aven.Bot ### U2 前台 nginx 没转发 `/hc-ws`（行 | ✓ | 2→2 | 3→2 | 41s→24s ✓ | api_reply→api_reply | done→done | ✗ | 100%+3 | 还原不了（模拟局限）：环境漂移（实测打今天的 uat） |
| ep-1030-b864a1 | C4 | at_bot | @Aven.Bot 再测试一下 | ✓ | 2→2 | 2→2 | 38s→34s ✓ | api_reply→api_reply | done→done | ½ | 100%+0 | 还原不了（模拟局限）：环境漂移（实测打今天的 online） |
| ep-1030-b864a1 | C5 | at_bot | check 一下这个问题，根据现有信息，同步相关逻辑，做好回群汇报 @Aven. | ✓ | 1→2 | 2→2 | 156s→58s ✗ | bug→api_reply | failed→blocked | ½ | 98%+1 | 模型抽样（同输入不同输出）：做法抽样 |
| ep-1030-b864a1 | C6 | at_bot | @Aven.Bot OL 再复测下 | ✓ | 2→2 | 2→2 | 59s→18s ✓ | api_reply→api_reply | done→done | ✓ | 67%+0 | 模拟偏差（能修）：组外 case 从历史里藏了 |
| ep-1102-c63787 | C1 | reply_to_bot | 对，总之代码修了，技术文档: https://ojp3our9ofog.jp.l | ✓ | 0→0 | 0→0 | —s→—s · | —→— | none→none | · | · | — |

## 有差异的 case 明细

### ep-1023-08e243 C1 om_x100b6282265658a0fe17f790908e243（webhook-group，principal_dm）

> Aven.tong：推 pre

- 差异：replied、dmCount；归因：模拟偏差（能修）（配置：sweep 整段删掉）——run-sim-falive 删了 dailyReport.sweep，「推 pre」的负责人判定要求开了清扫，被当成「不是负责人」忽略、一句没回。已修（sweepForSim，只去 preSiteUrl/onDeploy），复跑 fix2 回了「pre 已经是最新」；falive 当时是「合 lark/falive-integration 有冲突」——任务分支 / 集成分支的 git 状态还原不了，交付物仍不同。
- 路径 falive：—/none（无日志）；模拟：—/none（无日志）
  - falive 私 +115s：⛔ 没推 pre：合 lark/falive-integration 进 pre 有冲突，没推：src/modules/square/PostDetailPage.tsx

### ep-1023-98f8fa C1 om_x100b6283e1512ca0eed52b48098f8fa（php-group，at_bot）

> Aven.tong：我记得 2 已经有定论了，帮忙解答一下 @Aven.Bot

- 差异：groupCount、latency；归因：还原不了（模拟局限）（当时发送失败）——falive 的 ack webhook 当时 ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR 没发出去（网关日志），群里少一句、首句变成结论（185s）；模拟的 ack 正常发出。
- 路径 falive：question/done（received ack started）；模拟：question/done（received ack started）（模拟任务 done）
- 大意：same——两次回复的结论一致：第 2 条已有定论（10-23 定为打开帖子详情且页面在前台即算读完，不设停留时长），前端已合进 pre，不用再等产品口径，pre 上积分到账都没测通；B 只是多给了任务配置排查的细节。
  - falive 群 +185s：@Aven.tong 第 2 条已经定了：10-23 定的口径是「打开一篇广场帖子、详情显示出来、页面在前台，就算读完一次」，不设停留时长，和嗨聊 App 进帖子即上报一致，不用再等产品。前端已经按这个接上任务中心并合进 pre，这条 bug 不用再挂在等口径上。 - ⚠️ 接了但还不能用 pre 上读帖任务是否到账：这次探针没能带登录态打 Go 任务接口，
  - falive 私 +60s：🛠 开始做：aven 让 bot 回答 Arthur 列的第 2 点：「广场读帖是前端的，读帖门槛还在等产品口径」。aven 记得读帖门槛已经有定论，让 bot 说明前端现（Falive PHP后端群）
  - falive 私 +185s：✅ 第 2 条（广场读帖）已有定论：aven 10-23 定口径「打开并显示一篇真实帖子详情、页面在前台即算读完一次，不设停留时长」，对齐嗨聊 App 进入即上报，不再等产品；前端已接（发 square:postReadConfirmed → 任务中心申报 SQUARE_POST_READ），提交 ea1a0b6 已在 origin/pre（以本地最近一次 
  - 模拟 群 +26s：@Aven.tong 好的，我翻下读帖那条的定论和前端现在的判法，整理好回 Arthur。
  - 模拟 群 +93s：@Aven.tong 第 2 条有定论了：10-23 定的口径是打开并显示一篇帖子详情、页面在前台就算读完一次，不设停留时长（和嗨聊 App 进帖即上报一致），前端已经接好并合进 pre。读完由广场发事件，任务中心去申报「广场帖子阅读」。这个 bug 不用再等产品口径，可以按已修复转测试复测。 - ⚠️ 接了但还不能用 pre 上积分到账这次没测通：探针只能
  - 模拟 私 +27s：🛠 开始做：aven 让 bot 回复 Arthur 列的第 2 条：广场读帖积分任务是前端的，读帖门槛还在等产品口径。aven 记得这条已经有定论，让 bot 查清楚现状（Falive PHP后端群）
  - 模拟 私 +93s：✅ 第 2 条（广场读帖门槛）10-23 已定并已接：aven 定口径为「打开并显示一篇真实帖子详情、页面可见即算读完一次，不设停留时长」（对齐嗨聊 App 进入即上报），前端发 square:postReadConfirmed、任务中心申报 SQUARE_POST_READ，提交 ea1a0b6b 已在 origin/pre（以本地最近一次 fetch 为

### ep-1024-9ebe13 C1 om_x100b62fc7a2060a4eed44f2ab9ebe13（php-group，at_bot）

> HQUCWilliam.m：@Aven.Bot Bug-4942 再复测下 ！

- 差异：dmCount、latency、decision、endState、gist；归因：模拟偏差（能修）（Claude 记忆缺篇）——falive 当时会话先 cat 了记忆 bug-sheet-workflow.md（bug 表怎么查）再读 ~/.lark-bugpoll 快照和 bug 表；模拟只拷窗口前改过的记忆，这篇 11-02 改过被整篇丢掉，会话不知道去哪查 Bug-4942，直接 blocked。已修（memory-asof：会话记录重放，重放不出来就用现在版本近似）。分类 api_reply→bug 是抽样；首句 154s→30s 是 falive 当时在排空重启跑单测（⚠ 卡 10:09 / 10:10），不领新单。
- 路径 falive：api_reply/no_change_needed（received ack suspected started resumed dmResume）；模拟：bug/blocked（received ack suspected started resumed dmResume）（模拟任务 blocked）
- 大意：different——A 对这条在 pre 上做完了复测，结论是后端没修好，Member/info 还是把「I'm QA.」存成转义后的值，bug 保持验退；B 说拿不到 Bug-4942 的内容，没法复测，直接卡住了，一边做成一边卡住，所以结论不同。
  - falive 群 +154s：@HQUCWilliam.m 好的，我先看下 Bug-4942 的记录，在 pre 复测完回你。
  - falive 群 +471s：@HQUCWilliam.m Bug-4942 复测：通了 0 项，没通 2 项 - ⚠️ 接了但还不能用 后端存简介（php Member/info）：存「I'm QA.」读回来还是「I'm QA.」，后端还在转义，需要 William 改成存原文 - ⚠️ 待验证 个人主页简介显示：登录后个人主页显示「I'm QA.」正常（前端显示前还原了转义）；这次没
  - falive 私 +157s：❓ 可能是你的事（Falive PHP后端群）：William（live php 后端）@bot 让再复测 Bug-4942，意思应该是后端那边处理过了，要我们在 pre 上复测一下，然后报结果。 是 → 回「继续任务 om_x100b62fc7a2060a4eed44f2ab9ebe13 做」；不是 → 回「取消任务 om_x100b62fc7a2060a
  - falive 私 +728s：ℹ️ 看过了，不用改（Falive PHP后端群）：William 看到两句一样，是因为 Lark 把 `'` 显示成了单引号。我刚在 pre 上用测试号重新抓了 Member/info，signature 原文还是 `I'm QA.`，后端存的仍是转义后的值。Web 个人主页显示「I'm QA.」正常（前端已经还原），前端不用改；后端要么改成存原文，要么和
  - 模拟 群 +30s：@HQUCWilliam.m 收到，我先看下 Bug-4942 的记录，再去 pre 复测，测完回你。
  - 模拟 群 +270s：@HQUCWilliam.m 「William（live php 后端）@bot 让再复测一次 Bug-4942，看样子他那边已经处理过，等前端在 pre 上复测给结论」这边卡住了，需要你们帮忙： - 拿不到 Bug-4942 的内容：本地台账、lark-chat-poller-state、lark-followup-docs、仓库 docs 都没有这个编号
  - 模拟 私 +30s：❓ 可能是你的事（Falive PHP后端群）：William（live php 后端）@bot 让再复测一次 Bug-4942，看样子他那边已经处理过，等前端在 pre 上复测给结论。 是 → 回「继续任务 om_x100b62fc7a2060a4eed44f2ab9ebe13 做」；不是 → 回「取消任务 om_x100b62fc7a2060a4eed4
  - 模拟 私 +187s：🛠 开始做（续）：William（live php 后端）@bot 让再复测一次 Bug-4942，看样子他那边已经处理过，等前端在 pre 上复测给结论。（Falive PHP后端群）
  - 模拟 私 +270s：⏸ 停下来了（Falive PHP后端群）：William（live php 后端）让在 pre 复测 Bug-4942，但本地拿不到这条 bug 的内容：台账、poller 状态、followup 文档、仓库 docs 都只有「让复测 Bug-4942」这一句，没有标题、现象和复现步骤。所以现在定不了测哪个功能、归谁负责、怎样算通过。这是纯复测，不改代码，

### ep-1024-9ebe13 C3 om_x100b62fc1a1084a0ed416521b0dee2d（php-group，at_bot）

> HQUCWilliam.m：存「I'm QA.」读回来还是「I'm QA.」 有什么问题 ？ @Aven.Bot

- 差异：groupCount、endState、gist；归因：模拟偏差（能修）（连带（C1 偏差））——William 回的是 C1 的复测结论卡；模拟的 C1 卡住了，群里 bot 的话、台账和「正在进行的事」都不同，分类器给了 forMe=null 挂待确认（falive 直接开做）。上游修好后应复现；单看本条是分类抽样。
- 路径 falive：api_reply/no_change_needed（received ack started）；模拟：api_reply/waiting_confirmation（received ack suspected）（模拟任务 waiting_confirmation）
- 大意：partial——A 在 10:19 的回复里说：在 pre 重新抓了 Member/info，signature 原文还是 I&#039;m QA.，群里看着两句一样是因为 Lark 把实体渲染成了单引号；后端要么改成存原文，要么和产品确认保留转义。B 的主结论和 A 一致（后端返回的是转义值，Lark 渲染造成看起来一样，改不改由后端和产品定），还多说了一句 Web 端不算 bug。实质分歧在于：B 这一轮探针登录失败、没能重新抓到原始值，只能引用 10-24 的旧记录，而 A 是当场实测出来的。
  - falive 群 +53s：@HQUCWilliam.m 收到，我在 pre 重抓一次 Member/info 的原始返回核对下，看完回你。
  - falive 群 +216s：@HQUCWilliam.m Bug-4942 简介转义：通了 0 项，没通 2 项 - ⚠️ 接了但还不能用 后端存简介（Member/info）：刚在 pre 重抓了一次，signature 原文是 I&#039;m QA.，单引号还是被转义了。Lark 会把这个实体显示成 '，所以看起来两句一样；Network 面板里看原始响应就能看到。需要改成存原文
  - falive 私 +53s：🛠 开始做：William（live php 后端）不同意 bot 的 Bug-4942 复测结论。bot 说后端存「I'm QA.」读回来是「I'm QA.」（（Falive PHP后端群）
  - falive 私 +18445s：✅ Web 端不算 bug：pre 本轮实测 Member/info 的 signature 仍是 "I'm QA."（后端 htmlspecialchars 转义存储），Web 在 src/modules/user/data/schema.ts:193 用 decodeHtmlEntities 还原后显示「I'm QA.」；剩下只是后端存转义是否算 bug
  - 模拟 群 +46s：@HQUCWilliam.m 好的感谢，我去 pre 看下前端显示「I'm QA.」这块，测完回你。
  - 模拟 私 +46s：❓ 可能是你的事（Falive PHP后端群）：William（live php 后端）接着回 bot 对 Bug-4942 的追问：他那边存「I'm QA.」，读回来也是「I'm QA.」，问还有什么问题。 是 → 回「继续任务 om_x100b62fc1a1084a0ed416521b0dee2d 做」；不是 → 回「取消任务 om_x100b62fc1
  - 模拟 私 +18422s：✅ 答案：Web 这边不是 bug，前端显示「I'm QA.」前已经把实体还原（src/modules/user/data/schema.ts:194、:260 用 decodeHtmlEntities，schema.test.ts:65 覆盖 I&#039;m）；但后端 Member/info 返回的原始值是 I&#039;m QA.（10-24 实测记录

### ep-1024-9ebe13 C4 om_x100b62f88b4ba4a0ed62c6f7002bd76（php-group，at_bot）

> HQUCWilliam.m：@Aven.Bot 测试 帖子多语言翻译 以及 AI识图 功能 ！

- 差异：groupCount、dmCount、endState、gist；归因：模型抽样（同输入不同输出）（分类 forMe 抽样）——同样 api_reply，模拟给 forMe=null 挂待确认，falive 当时直接开做；领单正文两边一致（看不到差异输入），上游 C1/C3 的状态不同可能有影响。
- 路径 falive：api_reply/done（received ack started）；模拟：api_reply/waiting_confirmation（received ack suspected）（模拟任务 waiting_confirmation）
- 大意：different——A 对这条的结论：A 在 pre 上用已有的帖子（18608/18596）把翻译测完了，结论是后端返回的仍是中文原文、content_locale=zh-cn，问题在社区后端；AI 识图则没有入口和接口，要提问人说明。B 发不了测试帖，拿不到 tid，翻译根本没测，只能停下来找 William 要账号或 tid。两边一个测完给了结论，一个卡住没测成，所以判为不同。
  - falive 群 +69s：@HQUCWilliam.m 收到，我先查下 web 端帖子翻译和 AI 识图有没有接，再去 pre 测完回你。
  - falive 群 +532s：@HQUCWilliam.m @HQUCEncone @提问人 / 产品 帖子多语言翻译 / AI 识图测试：通了 1 项，没通 2 项 完整内容：[https://qfglxo2m3dc.sg.larksuite.com/docx/Ol3KdLNiQoR2tdxVE3mlbal8gTf](https://qfglxo2m3dc.sg.larksuite.c
  - falive 私 +74s：🛠 开始做：William（live php 后端）@bot，让测试帖子多语言翻译和 AI 识图两个功能，意思是他那边做好了，让我们去测。（Falive PHP后端群）
  - falive 私 +533s：✅ 在 pre 上测了帖子翻译：web 已经按语言请求（英文请求时后端回的提示已是英文），但后端返回的帖子标题、正文和评论还是中文原文，content_locale 都是 zh-cn，所以英文页面上帖子仍显示中文，问题在社区后端（Encone），已写进待确认清单。「AI 识图」在 PRD、功能表和接口文档里都没有，web 也没有这个功能，已请提问人说明是哪个
  - falive 私 +1496s：✅ William 要翻译测试用的 tid：19:27 那轮测的是 18608（主测，帖子详情 + 评论 26900/26901/26903）和 18596（10-20 发的帖），依据是上一轮任务 om_x100b62f88b4ba4a0ed62c6f7002bd76 结果里的 preChecks / detailDoc；本轮用探针（PROBE_HOST=s
  - 模拟 群 +27s：@HQUCWilliam.m 收到，我先看下帖子翻译和 AI 识图前端这边接没接，到 pre 上测完回你。
  - 模拟 私 +27s：❓ 可能是你的事（Falive PHP后端群）：William（live php 后端）@bot，让测试「帖子多语言翻译」和「AI 识图」两个功能。看语气是后端那边已经做好，等前端测试或验收。 是 → 回「继续任务 om_x100b62f88b4ba4a0ed62c6f7002bd76 做」；不是 → 回「取消任务 om_x100b62f88b4ba4a0e
  - 模拟 私 +1332s：⏸ 停下来了（Falive PHP后端群）：本来要在 pre 上用测试号发一条带图的新帖，拿 tid 去测翻译和 AI 识图，但两条路都没发出去：页面工具用测试号登录时被拒（403「参数错误」）；探针连的 pre 入口不转发社区接口，上传图片和发帖都回 405。所以没有 tid，翻译也没测成。AI 识图前端没有入口，接口文档里也没有对应字段。需要 Willi

### ep-1024-9ebe13 C5 om_x100b62f883ab54a0eedc53d11baac66（php-group，at_bot）

> HQUCWilliam.m：@Aven.Bot 所以不是Bug ?

- 差异：groupCount、latency；归因：模拟偏差（能修）（时序（时钟压缩））——falive 当时 C4 的 ack 在 15:19:57、C5 在 15:20:54，C5 的 ack 被出口闸「2 分钟内已对同一人发过 ack」拦下，首句变成结论（132s）；模拟里 C4 的 ack 更早（27s vs 69s），C5 的 ack 刚过 2 分钟没被拦。根因是模拟首句普遍更快（见时延）。结论一致。
- 路径 falive：question/done（received ack started gated）；模拟：question/done（received ack started）（模拟任务 done）
- 大意：same——两次回复结论一致：Web 不算 bug，后端返回的 signature 是转义值，算不算 bug 要后端和产品定口径；B 没能重新抓取、用了 10-24 的旧值，但结论没变。
  - falive 群 +132s：@HQUCWilliam.m Web 这边不算 bug：页面显示是对的。后端这边也可以不算，就看口径。本轮在 pre 重抓了 Member/info，原始响应里 signature 是 I'm QA.，也就是单引号被转成了 HTML 实体。你在群里看到两句一样，是因为 Lark 把实体渲染成了 '，用 Postman 或 Network 看原始响应就能看出来
  - falive 私 +48s：🛠 开始做：William（live php 后端）引用 bot 的 Bug-4942 复测卡片问：「所以不是 Bug？」。bot 之前说 pre 上 Member/inf（Falive PHP后端群）
  - falive 私 +1949s：✅ 用测试号在 pre 新发了一篇中文带图帖 18610 和一条评论 26908，都不用审核、直接可见。分别用中文和英文请求了帖子详情和评论，发帖后 3.5 分钟内英文请求返回的还是中文原文、content_locale=zh-cn，source_locale 是空的；英文页面上帖子也显示中文，和接口返回一致。翻译还卡在 William 那边开机翻，AI 识
  - 模拟 群 +22s：@HQUCWilliam.m 收到，我对一下原始响应和页面上的实际显示，给你个明确结论。
  - 模拟 群 +110s：@HQUCWilliam.m 对 Web 来说不是 bug：前端显示前已经把 &#039; 还原成单引号，页面上显示的是「I'm QA.」。不过后端接口原始返回的确实是「I&#039;m QA.」（Lark 消息会把这个实体显示成单引号，所以群里看起来两句一样），存进去和读出来不是同一串。App 等端如果直接显示这个字段，就会看到 &#039;。要不要当 b
  - 模拟 私 +22s：🛠 开始做：William（live php 后端）引用 bot 10-24 14:19 的 Bug-4942 简介转义复测卡片，追问「所以不是 Bug？」。他想要一个明确（Falive PHP后端群）
  - 模拟 私 +1617s：✅ 用测试号在 pre 发了一篇带图的中文测试帖（tid 18802），换成英文请求读回来就是英文译文，翻译能用，Web 不用改。AI 识图在接口和文档里都没有字段，前端看不到，只能请 William 按 tid 在后端查。另外后端把正文里的「今天」打成了「」，译文里还带着这串符号和一个多余的问号，已整理成待确认清单交给 William。 验证提醒：英文界面

### ep-1024-9ebe13 C6 om_x100b62f94d494ca0ed461fca3e5b201（php-group，at_bot）

> HQUCWilliam.m：<p>测试的tid 发出来 @Aven.Bot</p>

- 差异：replied、groupCount、dmCount、endState；归因：还原不了（模拟局限）（被编辑的消息）——原始数据 updated=true（发出 8 秒后编辑过）：falive 当时轮询到的是编辑前的版本、没 @ 到 bot，网关一行都没记；模拟拿的是编辑后的版本（带 @），接成了任务。
- 路径 falive：—/none（无日志）；模拟：question/waiting_confirmation（received ack started anchored）（模拟任务 superseded）
  - 模拟 群 +36s：@HQUCWilliam.m 好的，我在 pre 发帖测完翻译和识图，把 tid 和结果一起发你。
  - 模拟 群 +340s：@HQUCWilliam.m 「帖子翻译 / AI 识图测试」这边卡住了，需要你们帮忙： - 探针那条线路的 bbsv2 上传和发帖都回 405。所以拿不到 tid，需要 William 给一个能用的测试账号，或者直接给一个 11-01 之后发的测试帖 tid - AI 识图没有接口契约：前端没有识图入口，bbsv2 文档里也没有识图字段，需要 Willia
  - 模拟 私 +36s：🛠 开始做：William（live php 后端）接着他之前让测的「帖子多语言翻译 + AI 识图」，要 bot 把测试用的帖子 tid 发出来，方便他在后端查。（Falive PHP后端群）
  - 模拟 私 +1079s：ℹ️ 看过了，不用改（Falive PHP后端群）：用测试号在 pre 发了新帖 tid 18803（中文帖，加一条中文评论 pid 27190）。发帖后约半分钟用英文请求，帖子标题、正文和评论都返回英文，content_locale=en-us；中文请求返回原文，content_locale=zh-cn。翻译已经能用，前端不用改。之前测的 18608 是翻

### ep-1024-9ebe13 C7 om_x100b62f9593808a0ed42e0a526186a4（php-group，at_bot）

> HQUCWilliam.m：@Aven.Bot

- 差异：decision、gist；归因：还原不了（模拟局限）（连带（C6 被编辑））——falive 没收到 C6，把只 @ 的 C7 当成「要 tid」答了 tid；模拟收到了 C6（挂待确认）、C7 判 requirement 重新发帖测。
- 路径 falive：question/done（received ack started）；模拟：requirement/done（received ack started anchored）（模拟任务 done）
- 大意：different——A 对 C7 的结论是把上一轮翻译测试用过的 tid（18608、18596）发给 William，并说明英文请求返回的仍是中文原文；B 则新发帖 18802 重跑了一轮翻译 / AI 识图测试，给出「通了 0 项，没通 4 项」。一个是交出旧 tid，一个是重新测试出结果，答的不是一回事。
  - falive 群 +30s：@HQUCWilliam.m 好的，我把这次翻译和识图测试用的帖子 tid 整理出来发你。
  - falive 群 +176s：@HQUCWilliam.m 测翻译用的是 tid 18608（主测，帖子详情加它下面的评论）和 tid 18596（10-20 发的帖），两个帖子现在在 pre 上都能正常打开。19:27 那轮用英文请求（X-Accept-Language: en-us）拿到的都还是中文原文，content_locale 是 zh-cn。请求明细在文档里。
  - falive 私 +32s：🛠 开始做：William（live php 后端）接着 bot 19:27 发的帖子多语言翻译 / AI 识图测试结果（通了 1 项，没通 2 项），让 bot 把测试时（Falive PHP后端群）
  - 模拟 群 +27s：@HQUCWilliam.m 在测了，测完把 tid 和翻译、识图的结果一起发你。
  - 模拟 群 +425s：@HQUCWilliam.m 帖子翻译 / AI 识图测试（tid 18802）：通了 0 项，没通 4 项 完整内容：https://sim.local/docx/simdoc00026
  - 模拟 私 +27s：🛠 开始做：William（live php 后端）只 @ 了 bot、没写别的，是在催 19:35 那件事：在 pre 上实测帖子多语言翻译和 AI 识图，并把测试用的帖（Falive PHP后端群）

### ep-1024-9ebe13 C8 om_x100b62f96be7f8a4ed44dbc6f75d5a1（php-group，at_bot）

> HQUCWilliam.m：@Aven.Bot 创建最新的帖子 进行测试

- 差异：decision、endState；归因：模型抽样（同输入不同输出）（分类 / 终态措辞抽样）——requirement→api_reply、done→no_change_needed：两边都新发帖测了翻译，结论一致（大意 same），只是判成「做了」还是「不用改」。
- 路径 falive：requirement/done（received ack started anchored）；模拟：api_reply/no_change_needed（received ack started anchored）（模拟任务 no_change_needed）
- 大意：same——两次都新建了帖子并跑了翻译 / AI 识图测试，结论都是「通了 1 项，没通 3 项」；帖子号不同（18610 和 18803）是因为每次重跑都会新建帖子，B 只是多列了各项明细，结论没有分歧。
- 上下文：只 falive 「Broker（10-23 18:46）：@Arthur.a 播放器观看时长有冲突是join哪个接口重复了么？」；只模拟 
  - falive 群 +62s：@HQUCWilliam.m 好的，我在 pre 新发一条帖子，再测翻译和 AI 识图，完了把 tid 和结果发你。
  - falive 群 +545s：@HQUCWilliam.m 新帖 18610 翻译 / AI 识图测试：通了 1 项，没通 3 项 完整内容：[https://qfglxo2m3dc.sg.larksuite.com/docx/A3dddDQ6DoCe7FxUfPxlUaNogsn](https://qfglxo2m3dc.sg.larksuite.com/docx/A3dddDQ6Do
  - falive 私 +62s：🛠 开始做：William（live php 后端）看了 bot 给的 tid 18608 / 18596 之后，要求在 pre 新发一条帖子，重新测帖子多语言翻译和 AI（Falive PHP后端群）
  - 模拟 群 +33s：@HQUCWilliam.m 好的，我在 pre 发一条新帖重测翻译，测完把 tid 和结果发你。
  - 模拟 群 +541s：@HQUCWilliam.m 帖子翻译 / AI 识图测试：通了 1 项，没通 3 项 - ⚠️ 接了但还不能用 旧帖 18608 翻译：翻译上线前发的帖，用英文请求仍是中文原文，content_locale=zh-cn；要不要给旧帖补翻译请后端定 - ⚠️ 待验证 帖子多语言翻译（新帖 tid 18803）：新发中文帖 18803 和评论 27190，发帖
  - 模拟 私 +33s：🛠 开始做：William（live php 后端）回复 bot 的帖子翻译测试结果：bot 用老帖 tid 18608 / 18596 请求英文，拿到的还是中文原文。Wi（Falive PHP后端群）

### ep-1024-b22368 C1 om_x100b62f35ff42ca4ed3f669c7b22368（php-group，at_bot）

> HQUCEncone：https://qfglxo2m3dc.sg.larksuite.com/record/H6oZrTxWMeZZGbcj31SlyGregNf @Aven.Bot bbsv2/member/otherInfo?uid=19675&channel_code=hc 数据已经正常返回， 页面显示还是不正常 ，请协助查看

- 差异：replied、groupCount；归因：还原不了（模拟局限）（当时发送失败）——falive 的 ack webhook 当时 SSL 报错没发出去；两边之后都按「不归 aven（henry）」静默忽略。
- 路径 falive：bug/started（received ack started）；模拟：bug/started（received ack started）（模拟任务 ignored）
  - falive 私 +51s：🛠 开始做：Encone（portal 后端）附了一条 bug 表记录：bbsv2/member/otherInfo?uid=19675&channel_code=hc 现（Falive PHP后端群）
  - 模拟 群 +35s：@HQUCEncone 收到，我按这条记录查下 uid 19675 的主页渲染哪里不对，查完回你。
  - 模拟 私 +35s：🛠 开始做：Encone（portal 后端）直接 @ 机器人：他说 bbsv2/member/otherInfo?uid=19675&channel_code=hc 已经（Falive PHP后端群）

### ep-1026-350ff1 C2 om_x100b62c5fe29d0a0ed6ce9393d15b6e（php-group，at_bot）

> HQUCEncone：https://falivepre.fdsser.com/bbsv2/member/threadsCursor?type=posts&last_id=0&per_page=20&channel_code=hc @Aven.Bot 更新下是这个 APi

- 差异：replied、groupCount；归因：模型抽样（同输入不同输出）（出口闸去重（连带抽样））——falive 当时 C2 的群回复和 C1 同内容，被出口闸「同内容已发过」拦下；模拟两条措辞不同，照发。结论一致。
- 路径 falive：api_reply/no_change_needed（received ack started anchored gated）；模拟：api_reply/no_change_needed（received ack started anchored gated）（模拟任务 no_change_needed）
- 大意：same——两次回复的结论一致：这条归 henry 负责的前端部分，bot 不动、转交 henry。A 多写了接口不用改、要修的是封面解密，还被出口闸拦下没发到群里，这些只是细节和发送状态上的差别。
  - falive 私 +46s：🛠 开始做：Encone（portal 后端）补充 13:17 报的帖子列表封面图解密问题：涉及的接口要改成 bbsv2/member/threadsCursor?type（Falive PHP后端群）
  - falive 私 +150s：ℹ️ 看过了，不用改（Falive PHP后端群）：这项功能（功能总表 #46、#1）的前端负责人是 henry，不归 aven 负责，bot 按分工跳过、未改代码；Encone 更正：个人中心帖子列表接口是 bbsv2 member/threadsCursor（代码已在用，地址不用改），要修的是列表卡片 ThreadCard 的配图 / 视频封面没走 HC
  - 模拟 群 +106s：@HQUCEncone @Henry 看过了，这条要改的在前端 henry 负责的部分（功能总表 #46），麻烦 henry 看下，我这边不动。
  - 模拟 私 +18s：🛠 开始做：Encone（portal 后端）补充 new#350ff1：个人中心帖子列表要用的接口改成 bbsv2/member/threadsCursor（参数 typ（Falive PHP后端群）
  - 模拟 私 +106s：ℹ️ 看过了，不用改（Falive PHP后端群）：这项功能（功能总表 #46）的前端负责人是 henry，不归 aven 负责，bot 按分工跳过、未改代码；Encone 更正接口为 bbsv2 member/threadsCursor，前端已在调这个接口（channel_code 由签名层自动加），不用改接口；缺陷出在前端：个人中心帖子卡 ThreadC

### ep-1026-350ff1 C3 om_x100b62c5b37208a4ed4f70429e7ed15（php-group，at_bot）

> Arthur.a：@Aven.Bot 测试一下pre环境真实验证码接入

- 差异：endState、gist；归因：模型抽样（同输入不同输出）（实测范围抽样）——主结论一致；falive 多测了手机号验证码（+84 不支持该国家），模拟没测。done/no_change_needed 是同一交付的两种判法。
- 路径 falive：api_reply/done（received ack started）；模拟：api_reply/no_change_needed（received ack started）（模拟任务 no_change_needed）
- 大意：partial——A 的结论：pre 上真实验证码邮箱发码通了，123456 已失效，前端不用改；但缺能收码的账号，正向流程没走完，而且 +84 手机号发短信回「不支持该国家」。B 的主结论和 A 一样（发码通、123456 被拒、缺收码账号），但手机号验证码 B 没测，所以少了 A 发现的「短信不支持该国家」这个后端问题，属于有实质分歧。
  - falive 群 +52s：@Arthur.a 好的，我在 pre 上把 web 端邮箱和手机验证码流程走一遍，测完回你结果。
  - falive 群 +411s：@Arthur.a pre 真实验证码复测：通了 2 项，没通 2 项 完整内容：[https://qfglxo2m3dc.sg.larksuite.com/docx/PnABdFVTsonqe0x2ouYllMRlg8c](https://qfglxo2m3dc.sg.larksuite.com/docx/PnABdFVTsonqe0x2ouYllMRlg
  - falive 私 +53s：🛠 开始做：Arthur（账号后端）通知 pre 环境的邮箱、手机号验证码已改成真实接入，并 @ bot 要 web 端在 pre 上测一下验证码流程。（Falive PHP后端群）
  - falive 私 +412s：✅ 在 pre 上直接测了 Arthur 接的真实验证码：邮箱发码通了，登录、注册、找回密码三个场景都发得出去；以前的万能码 123456 已经失效，会被拒，前端会把后端的报错正常提示出来。还差两件要找 Arthur：测试号是假邮箱收不到码，「收码 → 登录 / 注册 / 改密成功」这一圈没走完，要他给个能收码的账号；越南 +84 手机号发短信回「不支持该国
  - 模拟 群 +31s：@Arthur.a 好的，收到。我去 pre 实测 web 端的邮箱和手机号验证码，看完把结果回你。
  - 模拟 群 +217s：@Arthur.a pre 真实验证码 web 端实测：通了 3 项，没通 2 项 - ⚠️ 接了但还不能用 收真码走完邮箱注册 → 登录：我们没有能收信的 pre 测试邮箱，拿不到真码，正向流程没走完 - ⚠️ 接了但还不能用 手机号验证码：手机号未测（无可用号码），只确认了号码格式不对会回 invalid phone - ✅ 通了 邮箱发验证码：发码成功
  - 模拟 私 +31s：🛠 开始做：Arthur（hichat / 账号后端）通知：pre 环境验证码已真实接入，后端已实测邮箱和手机号验证码，没发现问题。他 @ 机器人，要 web 端在 pre（Falive PHP后端群）
  - 模拟 私 +217s：ℹ️ 看过了，不用改（Falive PHP后端群）：在 pre 上实测了 web 端实际调用的 portal 验证码接口：邮箱发码成功，重复发码会被拦（前端会转成中文提示）。注册、验证码登录、找回密码和修改密码现在都不再接受旧的 123456（php 那条也一样），说明真实验证码已经生效，前端不用改。没测完的有两项：我们没有能收信的邮箱或手机号，所以拿真码走

### ep-1026-4f9abc C1 om_x100b62c785b43ca4fe0ac414c4f9abc（webhook-group，principal_dm）

> Aven.tong：已部署

- 差异：dmCount、decision、endState；归因：还原不了（模拟局限）（窗口前任务库（无审计））——「已部署」要锚到窗口前的复测任务；10-26 还没有审计（10-27 08:32Z 起才有），任务库补不出来，模拟回「这句没对上任务」。
- 路径 falive：requirement/done（started anchored）；模拟：—/unanchored（unanchored）
  - falive 私 +21s：🛠 开始做：aven 私聊在 pre 部署复测任务（retest-falive-20261026-1527，pre @ f8ff4bb1）下说「已部署」，意思是重新部署好了（falive 控制台）
  - falive 私 +2041s：✅ 文档无需提交：对接-后端-2026-10-26.md 和仓里已有版本逐字节相同。是我负责的部分，这次没开工。 已查清 uid 271 头像的来源，可以回 Arthur：Web 有两处显示这个头像，用的都是 live php 返回的 avatar 字段，前端拿到原样加载。一处是登录返回和 Member/info（顶栏头像），另一处是群聊 chat/hist
  - 模拟 私 +0s：这句没对上任务：12 小时内没有我发给你的任务通知。要续跑或补充，请写「继续任务 <任务 id> 补充内容」；要结单写「结单 <任务 id>」。

### ep-1026-9769e5 C1 om_x100b62c12ca584a0ed60b40549769e5（php-group，at_bot）

> HQUCEncone：https://falivepre.fdsser.com/hc-api/api/fameEx/market/symbol/list @Aven.Bot 测试这个api 能不能请求通

- 差异：endState、gist；归因：还原不了（模拟局限）（环境漂移（实测打今天的 pre））——falive 当时实测 symbol/list 不通（401/404），模拟今天打 pre 已经通了（200）——探针转发到的是今天的 pre。终态 done→no_change_needed 跟着结论变。
- 路径 falive：ignore/done（received ack started noted）；模拟：ignore/no_change_needed（received ack started noted）（模拟任务 no_change_needed）
- 大意：different——A 对这条的结论是接口不通（网关回 401/404，直连上游正常，要运维查转发）；B 的结论是接口都通了（返回 200 且有数据），两边判断相反。
- 上下文：只 falive 「World（10-26 13:49）：<calendar_share open_calendar_id="feishu.」；只模拟 「World（10-26 13:49）：<calendar_share open_calendar_id="feishu.」
  - falive 群 +34s：@HQUCEncone 收到，我查一下，稍后回复。
  - falive 群 +274s：@运维 @Arthur.a @HQUCEncone 行情列表接口测试：通了 0 项，没通 4 项 完整内容：[https://qfglxo2m3dc.sg.larksuite.com/docx/KlRvd6McmoBRyaxqb43lok5agUb](https://qfglxo2m3dc.sg.larksuite.com/docx/KlRvd6McmoBR
  - falive 私 +36s：🛠 开始做：Encone（portal 后端）@bot，让测一下 pre 的 /hc-api/api/fameEx/market/symbol/list 能不能请求通。前文（Falive PHP后端群）
  - falive 私 +274s：✅ 测了群里问的行情列表接口：现在还不通。经 pre 站点的 /hc-api 网关请求，不登录回 401，带测试号 508 的 token 回 404，在浏览器里打开首页也是 404，行情跑马灯不显示。同一个 token 直接请求 hichat pre 上游能拿到行情数据，所以问题在网关 /hc-api 转发的上游，要运维或 Arthur 查。另外免登录（E
  - 模拟 群 +27s：@HQUCEncone 收到，我查一下，稍后回复。
  - 模拟 群 +160s：@HQUCEncone ✅ 行情接口 pre 实测：都通了 - ✅ 通了 行情列表 symbol/list：不登录、带登录 token 都回 code 200，有 1 条 BNB/USDT；经网关和直连 hichat 结果一样，登录校验已去掉 - ✅ 通了 行情开关 getStatus：不登录也回 code 0，开关 cryptocurrencyMarket
  - 模拟 私 +27s：🛠 开始做：Encone（portal 后端）@ bot，让我们测一下 pre 上 hc-api/api/fameEx/market/symbol/list 能不能请求通（（Falive PHP后端群）
  - 模拟 私 +160s：ℹ️ 看过了，不用改（Falive PHP后端群）：测过了，行情列表接口在 pre 上能通：不登录和带登录 token 都回 code 200，有 1 条 BNB/USDT。经网关和直连 hichat 结果一样，说明后端已经去掉了登录校验。跑马灯开关接口 getStatus 不登录也回 code 0、开关为 true。前端现在仍然只在登录后才请求和展示跑马灯

### ep-1026-9769e5 C2 om_x100b62c1ec5ee0a4ed6ade7eaab85db（php-group，at_bot）

> HQUCEncone：@Aven.Bot

- 差异：decision、gist；归因：还原不了（模拟局限）（环境漂移（实测打今天的 pre））——同 C1：当时仍 404、今天 200。分类 api_reply→question 是抽样。
- 路径 falive：api_reply/done（received ack started anchored）；模拟：question/done（received ack started anchored）（模拟任务 done）
- 大意：different——A 复测后说接口还是不通：经网关请求仍然 404，0 项通、4 项没通，要运维查网关转发；B 复测后说已经通了，带不带 token 都回 200，之前的 404 已不再出现。两边的判断正好相反。
- 上下文：只 falive ；只模拟 「HQUCEncone（10-26 17:48）：https://falivepre.fdsser.com/hc-api/」 「直接访问都可以正常，为啥你们的项目里面访问会 404」 「如果nginx 配置有问题，直连应该也是 404 才对」
  - falive 群 +33s：@HQUCEncone 收到，我再测一遍 symbol/list 能不能请求通，结果稍后回你。
  - falive 群 +278s：@运维 @Arthur.a @HQUCEncone 行情列表接口复测：通了 0 项，没通 4 项 完整内容：[https://qfglxo2m3dc.sg.larksuite.com/docx/W17sdx93po1nW5xN1hQlCRK9gde](https://qfglxo2m3dc.sg.larksuite.com/docx/W17sdx93po1n
  - falive 私 +35s：🛠 开始做：Encone（portal 后端）只 @ 了 bot，没写别的内容。他刚才（17:31）让测 pre 的 /hc-api/api/fameEx/market/s（Falive PHP后端群）
  - falive 私 +279s：✅ Arthur 说恢复后，17:50 用测试号 508 重测了行情接口，结果和 17:32 完全一样：经 pre 网关带 token 请求 symbol/list 还是 404，直连 hichat 上游正常有数据；pre 首页登录后跑马灯仍不显示。symbol/list 和 getStatus 的免登录也都还没生效。还差运维查网关转发，Arthur、Enc
  - 模拟 群 +35s：@HQUCEncone 收到，我查下项目里 hc-api 的代理转发配置，看 404 出在哪再回你。
  - 模拟 群 +199s：@HQUCEncone 刚才复测，项目里实际发的请求现在不会 404 了：经 falivepre 网关 /hc-api 和直连 hichat，带不带登录 token 都回 200，有 1 条 BNB/USDT。之前的 404 是 10-20 那次网关 /hc-api 带有效 hichat token 时被转到错误的上游（直连是好的，所以两边表现不一样），现在
  - 模拟 私 +35s：🛠 开始做：Encone（portal 后端）@ 机器人追问：pre 上直接访问 hc-api/api/fameEx/market/symbol/list 是正常的，为什么（Falive PHP后端群）
  - 模拟 私 +199s：✅ symbol/list 的 404 我刚才复现不出来：经 falivepre 网关 /hc-api 和直连 hichat，带不带 token、带前端同样的请求头，都回 HTTP 200、code 200、1 条 BNB/USDT。之前的 404 是 10-20 记的「网关 /hc-api 带有效 hichat_token 时被转到错误的 Spring 上

### ep-1027-63a6f3 C1 om_x100b613162deaca4ffca709b163a6f3（webhook-group，principal_dm）

> Aven.tong：已发布

- 差异：replied、dmCount、decision、endState；归因：还原不了（模拟局限）（窗口前任务库（无审计））——「已发布」当时 falive 判 ignore 只记下；模拟锚不到任务回「这句没对上任务」。窗口在 10-27 早上，审计还没开始记，补不出来。
- 路径 falive：—/noted（anchored noted dmRelease）；模拟：—/unanchored（unanchored dmRelease）
  - 模拟 私 +7s：这句没对上任务：12 小时内没有我发给你的任务通知。要续跑或补充，请写「继续任务 <任务 id> 补充内容」；要结单写「结单 <任务 id>」。

### ep-1027-63a6f3 C2 om_x100b61317d91a8a8ffaf85949d657d4（webhook-group，principal_dm）

> Aven.tong：已部署

- 差异：dmCount、decision、endState；归因：还原不了（模拟局限）（窗口前任务库（无审计））——「已部署」要锚到窗口前的复测任务，同上补不出来。
- 路径 falive：requirement/done（started anchored）；模拟：—/unanchored（unanchored）
  - falive 私 +41s：🛠 开始做：aven 私聊确认 pre 已部署（340b8487），要对已结单的部署后复测任务 retest-falive-20261027-0413 照做：在 pre 上（falive 控制台）
  - falive 私 +8699s：✅ 按 Mateo 的决定，web 端把主播等级和用户等级都隐藏了，涉及四处：搜索结果里主播卡的等级徽章、直播间公屏的等级徽章（Lv.7 以上发言变色也去掉了）、本人和他人主页昵称旁的直播 Lv、本人主页右栏的直播等级卡。社区等级和勋章没动，接口字段也都保留。类型检查和相关测试都通过了；按工单规则这次没开页面看，页面效果交给测试在测试环境验收。改动在本地分支
  - 模拟 私 +18s：这句没对上任务：12 小时内没有我发给你的任务通知。要续跑或补充，请写「继续任务 <任务 id> 补充内容」；要结单写「结单 <任务 id>」。

### ep-1027-63a6f3 C3 om_x100b613ddef190b0ed4f8d2a408e026（php-group，at_bot）

> HQUCEncone：@Aven.Bot

- 差异：gist；归因：还原不了（模拟局限）（环境漂移（实测打今天的 pre））——主结论一致（271 能播、要关房），模拟今天多测出 uat / 分享等其它项的状态——在播房间、推流是今天的。
- 路径 falive：api_reply/done（received ack started）；模拟：api_reply/done（received ack started）（模拟任务 done）（falive 审计 done）
- 大意：partial——A 的结论：房间 271 在 pre 能正常播；列表里抽查的其它在播房间拉不到流，需要 HTStone 关房；分享链接为空是 APP 的问题，已配好，网页端不用这个字段。B 的主结论一致：271 能播、要关没推流的房间、share_domain 已配好、前端不改代码。但 B 多了关键发现：uat / online 也要配 share_domain，以及 pre 首屏 SSR 回 503。B 的统计是「通了 1 项，没通 3 项」，A 是「通了 1 项，没通 1 项」，有实质差别。
- 上下文：只 falive 「Arthur.a（10-27 14:27）：@Aven.Bot 请给我提供一下bug-4970的curl信息」；只模拟 「Williamwang HT（10-27 09:44）：falive ws 返還的 uid 都是falive的 不是hi」 「HQUCEncone（10-27 09:46）：[https://falivepre.fdsser.com/go-api」 「@Arthur.a 这个资料返回的是hichat uid （发了 1 张图）」 「Arthur.a（10-27 09:47）：我加一下就行」 「Arthur.a（10-27 09:47）：在加」 「Arthur.a（10-27 09:47）：把两个都给回来吧」
  - falive 群 +92s：@HQUCEncone 收到，我查一下，稍后回复。
  - falive 群 +510s：@HQUCEncone @HTStone 直播间 271 拉流复测：通了 1 项，没通 1 项 - ⚠️ 接了但还不能用 列表里其它在播房间：抽查 128、133、414、19645、19675 还是 8 秒拉不到数据，麻烦 @HTStone 把这些没推流的房间关掉 - ✅ 通了 房间 271（HTStone 开的验证房）：网页打开有画面，m3u8 返回 2
  - falive 私 +237s：🛠 开始做：Encone 在话题里 @bot，转来运营 HTStone 对「直播列表里拉不到流的房间」的答复：先用 pre room/271（HTStone 开的、有推流）（Falive PHP后端群）
  - falive 私 +4133s：✅ HTStone 关房后，我在 pre 复测了直播列表。现在只剩 4 个在播房间（271、19668、65、96），每个都实际拉到了流或视频文件，pre 站点直播列表只有这 4 张卡，271 有画面。直播列表拉不到流的问题已经结了，结果已同步到对接文档和答复存档，没改代码。 分支 feature/phase-5-test · 改了 2 个文件 已合进 fe
  - 模拟 群 +33s：@HQUCEncone 好的感谢，我先在 pre 用 room 271 验证拉流和列表展示，看完回报结果。
  - 模拟 群 +215s：@HQUCEncone @HTStone 分享链接与 room 271 验证：通了 1 项，没通 3 项 完整内容：https://sim.local/docx/simdoc00007
  - 模拟 私 +33s：🛠 开始做：Encone 在话题里转达 web 端反馈的「直播间推流地址坏了」，请 HTStone 处理。HTStone 回复：pre 先用 room/271 验证，其他没（Falive PHP后端群）
  - 模拟 私 +215s：✅ App 分享链接为空是 php 后台没配 share_domain，HTStone 已配好，pre 实测 getHot 已返回 https://falivepre.fdsser.com/；web 分享用本站域名不读这个字段，前端没改代码，只存档了答复、补了待跟进清单。room 271 在 pre 实测能播、也在直播列表里。还差 HTStone 在 uat

### ep-1027-63a6f3 C4 om_x100b613e317a7ca8ed433e4cdf4c0a9（php-group，at_bot）

> HTStone.z：@Aven.Bot 已關閉沒推流的直播間

- 差异：dmCount、gist、seen；归因：还原不了（模拟局限）（环境漂移（实测打今天的 pre））——falive 当时 4 个在播房间都能拉流、判已结；模拟今天 258、19674 拉不到流。上下文差是模拟把组外 case 从历史里藏了（另记一条模拟偏差，已修 hiddenAsHistory）。
- 路径 falive：api_reply/done（received ack started dmRelease）；模拟：api_reply/done（received ack started dmRelease）（模拟任务 done）（falive 审计 done）
- 大意：partial——A 的结论是：HTStone 关房后在 pre 复测，只剩 4 个在播房间且都能拉到流，直播列表拉不到流的问题已经结了。B 也确认点名的房间都关了、271 等能播，但还发现 258、19674 两个房间拉不到流，要 HTStone 继续关。主结论一致，但 A 判已解决、B 判还有遗留，有实质分歧。
- 上下文：只 falive 「Arthur.a（10-27 14:27）：@Aven.Bot 请给我提供一下bug-4970的curl信息」；只模拟 「Arthur.a（10-27 09:47）：在加」 「Arthur.a（10-27 09:47）：把两个都给回来吧」 「Williamwang HT（10-27 09:50）：okok 感謝大大 總而言之 我需要 id == klive i」 「Arthur.a（10-27 10:12）：@HTStone.z 这个问题请让Max处理一下 （发了 1 张图）」
  - falive 群 +55s：@HTStone.z 好的感谢，我再去 pre 看下直播列表，还有拉不到流的房间再跟你说。
  - falive 群 +1284s：@HTStone.z HTStone 关房后，我在 pre 复测了直播列表。现在只剩 4 个在播房间（271、19668、65、96），每个都实际拉到了流或视频文件，pre 站点直播列表只有这 4 张卡，271 有画面。直播列表拉不到流的问题已经结了，结果已同步到对接文档和答复存档，没改代码。
  - falive 私 +58s：🛠 开始做：HTStone 回复 bot 的直播间 271 拉流复测卡片，说已经把没推流的直播间关掉了（bot 之前列了 128、133、414、19645、19675）。（Falive PHP后端群）
  - 模拟 群 +31s：@ou_76eea7f1089ccfb66678300fe4bc4a40 好的感谢，我再去 pre 看一遍正在直播列表的拉流情况，看完回报。
  - 模拟 群 +1265s：@ou_76eea7f1089ccfb66678300fe4bc4a40 HTStone 说已经关掉没推流的房间，我在 pre 上重新测了一遍：列表从 20 条降到 10 条，点名的 128、133、414、19645、19675 都已关掉；271、282 和 6 个 mp4 房间网页都有画面。还剩 258、19674 两个房间标着在播，但 8 秒拉不到数据
  - 模拟 私 +31s：🛠 开始做：HTStone 回复 bot 的 room 271 拉流复测卡片，说已经把没推流的直播间关掉了。（Falive PHP后端群）
  - 模拟 私 +391s：✅ HTStone 说已经关掉没推流的房间，我在 pre 上重新测了一遍：列表从 20 条降到 10 条，点名的 128、133、414、19645、19675 都已关掉；271、282 和 6 个 mp4 房间网页都有画面。还剩 258、19674 两个房间标着在播，但 8 秒拉不到数据，已写进待确认文档，继续请 HTStone 关掉。另外这次 pre 站

### ep-1027-6e06d2 C1 om_x100b613d351128a0ff6f5e3c76e06d2（tech-group，at_bot）

> HQUCEncone：508 主播这条，我已经加过了，现在前端还不对吗？ @Aven.Bot

- 差异：latency；归因：说不清（falive 一侧归属歧义）——falive 对 C1 的 ack 发在 C2 到达之后（+87s），启发式归属把它给了 C2，C1 的首句成了 510s 的结论；按网关日志 C2 的 ack 其实被出口闸拦了。大意一致。实际时延 87s vs 48s。
- 路径 falive：api_reply/done（received ack started）；模拟：api_reply/done（received ack started）（模拟任务 done）
- 大意：same——A 的结论是：508 已经是主播（is_anchor=1），开播记录和「我要直播」入口都正常，前端不用改，写操作没测。B 的主结论也是 508 已是主播、前端不用改，开播记录正常，开播 / 关播还没测；B 多测通了取推流地址，标题写成「没通 1 项」其实指的是没测，不是失败，所以整体判断一致。
  - falive 群 +510s：@HQUCEncone 好的感谢，AI 识图这条 web 端就不对接了，我在台账里记下结掉。
  - falive 群 +554s：@HQUCEncone @Arthur.a 游客看他人主页复测：通了 1 项，没通 1 项 - ⚠️ 接了但还不能用 他人主页页面（游客）：页面还是显示「资料加载失败」：主资料 Go 接口 influencers 对游客回 -700「未授权」，要 Arthur 也开放只读 - ✅ 通了 社区资料 otherInfo / threadsCount（游客）：游客
  - falive 私 +138s：🛠 开始做：Encone（portal 后端）引用了今天对接文档 C1 那一行（Bug-4994：live uid 19650 带附件 aid 8630 / 8631 调 （Falive产研技术沟通群）
  - falive 私 +492s：✅ Encone 把 508 设成主播后已经生效，前端不用改代码。我在 pre 上用测试号实测：接口返回已是主播，本人页出现了「我要直播」入口，进去能看到 7 条开播记录。对接文档里「要主播测试号」这条已经结掉；开播、关播、取推流地址这些写操作这次没在 pre 上点。 ⚠ AI 自报改了但实际未改：docs/delivery/pending/对接-后端-20
  - 模拟 群 +48s：@HQUCEncone 好的感谢，我用 508 在 pre 把主播侧流程实测一遍，测完回你。
  - 模拟 群 +344s：@HQUCEncone 508 主播号复测：通了 3 项，没通 1 项 - ❌ 没接 开播 / 关播：还没测：开播会让空流房间出现在公开直播列表，先和 aven 确认再测 - ✅ 通了 508 主播身份：Member/info 已回 is_anchor=1，前端的「我要直播」入口就是读这个字段，前端不用改 - ✅ 通了 开播记录 / 直播间介绍回填：getR
  - 模拟 私 +48s：🛠 开始做：Encone（portal 后端）答复对接文档 L8：508 已经设成主播了（附后台截图，508 那一行操作栏显示「取消主播」），问前端现在是不是还不对。（Falive产研技术沟通群）
  - 模拟 私 +199s：✅ C1 发帖 500 的账号是 live uid 19650（hiChatUid 129236 / discuz_uid 20120，昵称 shellyhsu+klive1，看着是测试 Shelly 的号）；依据：docs/delivery/pending/对接-后端-2026-10-27.md C1 行 + 本轮 pre getRoomInfo?uid=

### ep-1027-6e06d2 C2 om_x100b613dceea2cacff9a53996da700f（tech-group，at_bot）

> HQUCEncone：| C1 | 某账号发帖回 HTTP 500（Bug-4994） | 10-26 核对：live uid 19650 的 `member/info` / `member/groups` / `publishRule` 都正常（中级会员，允许发帖发图），该账号 + 附件 aid 8630 / 8631 `thread/c

- 差异：groupCount、latency；归因：说不清（falive 一侧归属歧义）——同 C1：C1 的 ack 被归到 C2。网关日志里 C2 的 ack 被出口闸拦下，falive 实际也只发了 1 句结论，和模拟一样。
- 路径 falive：question/done（received ack started gated）；模拟：question/done（received ack started gated）（模拟任务 done）
- 大意：same——A 的结论：出 500 的是 Shelly 的测试号 shellyhsu+klive1（live uid 19650），只有这个账号带附件 8630/8631 调 thread/create 会回 500，用 508 发帖正常，需要后端按 10-26 11:55 前后的日志排查。B 认出的是同一个账号，判断和请求也一样。两边只在密码怎么拿上说法不同（A 说在 Bug-4994 描述里，B 说去找 Shelly 要），主结论一致。
- 上下文：只 falive 「Mateo（10-27 12:09）：是要做统一的，之前的 hichat uid 统一换到 falive 的 UID」；只模拟 
  - falive 群 +18s：@HQUCEncone 好的感谢，我用 508 去 pre 实测一下主播相关的流程，测完回报结果。
  - falive 群 +478s：@HQUCEncone 发帖回 500 的是测试同学 Shelly 在 Bug-4994 里给的账号：shellyhsu+klive1@htsoftware.co（live uid 19650），密码写在 Bug-4994 的描述里。出错那次请求带的是图片 aid 8630、视频 aid 8631、标签 9，时间大约是 10-26 11:55（+04）。 -
  - falive 私 +21s：🛠 开始做：Encone（portal 后端）答复今天对接文档里的 L8「要一个 pre 主播测试号」：他说已经把 uid 508 设成主播（后台截图里 508 那一行显示（Falive产研技术沟通群）
  - falive 私 +478s：✅ Encone 要的发帖 500 账号是测试同学 Shelly 在 Bug-4994 单里给的 pre 邮箱账号 shellyhsu+klive1@htsoftware.co（live uid 19650，密码在 bug 单描述里，Encone 是该单处理人能看到）；依据：~/.lark-bugpoll/snapshot.json 的 Bug-4994 记
  - 模拟 群 +131s：@HQUCEncone 发帖回 500 的是 live uid 19650（对应 Hichat uid 129236、社区 discuz_uid 20120，昵称 shellyhsu+klive1，应该是测试 Shelly 的号），出错的那次请求是 10-26 11:55（+04）左右带附件 aid 8630 / 8631 调 thread/create；这
  - 模拟 私 +21s：🛠 开始做：Encone（portal 后端）引用了 aven 对接文档里的 C1 那一行（Bug-4994：live uid 19650 带附件 8630/8631 调 （Falive产研技术沟通群）
  - 模拟 私 +275s：✅ 用测试号 508 在 pre 复测：Encone 已经把 508 设成主播，现在 Member/info 回 is_anchor=1，开播记录（7 场，介绍和语言都在）、推流地址都能拿到，前端用的 schema 解析全部通过。前端的「我要直播」入口就是读这个字段，所以前端不用改，只把对接文档里的 L8、我要直播第 1 条、对接状态总览和功能表同步成已处理

### ep-1027-6e06d2 C3 om_x100b613dc6a61ca0fe2e062023c63ab（tech-group，at_bot）

> HQUCEncone：https://falivepre.fdsser.com/bbsv2/member/otherInfo?uid=19694&channel_code=hc | C3 | 游客看他人主页资料回 -700（Bug-4905 / 4908） | 10-22 起：游客调 `member/otherInfo`、`member/t

- 差异：groupCount、gist；归因：模型抽样（同输入不同输出）（群回复取舍抽样）——模拟 done 但没发群结论（网关无 group reply，只私信），falive 发了；结论大意部分一致（都说接口已修，falive 多指出页面仍「资料加载失败」）。
- 路径 falive：api_reply/done（received ack started）；模拟：api_reply/done（received ack started）（模拟任务 done）
- 大意：partial——A 的结论是：两支社区接口 otherInfo/threadsCount 游客调用已正常，C3 算修好；但用游客身份打开他人主页，页面仍显示「资料加载失败」，原因是 Go 接口 influencers 对游客回 -700，需要 Arthur 开放只读，新记为 G6。B 也认定接口已修好，这一点和 A 一致；但 B 说页面已正常显示、没有要别人跟进的事。所以主结论一致，B 漏掉了 A 发现的页面仍然报错这个阻塞点。
- 上下文：只 falive 「Williamwang HT（10-27 12:12）：這兩個平台的uid 不會是同一個數字」；只模拟 
  - falive 群 +44s：@HQUCEncone 好的感谢，我用游客身份去 pre 打开他人主页再核实一下，测完回报。
  - falive 群 +290s：@HQUCEncone ✅ 508 主播号复测：都通了 - ✅ 通了 主播身份（Member/info）：测试号 508 现在返回 is_anchor=1，已经是主播 - ✅ 通了 我的开播记录（getRoomList）：返回 7 条场次，页面上 7 条都正常显示 - ✅ 通了 本人页「我要直播」入口：登录 508 后入口已出现，点进去不再被打回本人页 详细
  - falive 私 +44s：🛠 开始做：Encone（portal 后端）答复对接文档 C3（游客看他人主页资料回 -700，Bug-4905 / 4908）：后端已处理，otherInfo?uid=（Falive产研技术沟通群）
  - falive 私 +354s：✅ Encone 说的那两支社区接口确实修好了：游客调他人资料和帖子计数都正常返回。但我用游客身份在 pre 打开他人主页 /user/19694，页面还是显示「资料加载失败」，因为主资料走的 Go 接口 influencers 对游客回「未授权」，要 Arthur 也对游客开放只读。对接文档里已把 C3 挪到「已修」，Go 这条新记为 G6；前端代码没改（
  - 模拟 群 +26s：@HQUCEncone 好的感谢，我用游客身份在 pre 复测 otherInfo 和他人主页，测完回你。
  - 模拟 私 +26s：🛠 开始做：Encone（portal 后端）答复对接文档里的 C3（游客调 member/otherInfo、threadsCount 回 -700，Bug-4905 /（Falive产研技术沟通群）
  - 模拟 私 +220s：✅ 后端修好的游客看他人主页已复测：游客调 otherInfo 和 threadsCount 都回正常数据（uid 19694 和 260），pre 站点没登录打开这两个人的主页，资料、关注、粉丝、帖子数和直播存档都正常显示，不再报「资料加载失败」。对接文档里的 C3 已改成已修好，Bug-4905 / 4908 可以关。前端代码没改，也没有要别人跟进的事。

### ep-1027-c4346b C1 om_x100b61337a64f8a0ff5f5a718c4346b（tech-group，at_bot）

> Aven.tong：@Aven.Bot 请根据 @Mateo 给的信息，同步更新 web 端的相应逻辑

- 差异：replied、groupCount、gist；归因：模拟偏差（能修）（配置：只私聊的群）——falive 当时融合群配置成「只私聊不发群」（网关日志 10-21→10-27 10:27Z 都是这样），10-27 10:27Z–11:00Z 之间改掉了但没留备份；模拟按 mtime 取到 10-28 的备份（[]），照发群。已修（privateOnlyAt 按日志行为取）。结论大意 partial 是汇总措辞抽样。
- 路径 falive：requirement/done（received ack started）；模拟：requirement/done（received ack started）（模拟任务 done）
- 大意：partial——A 的结论是：已按 Mateo 的决定把 web 端用户和主播等级全部隐藏（搜索主播卡、公屏、主页 Lv、右栏等级卡），全部打通并合进 feature/phase-5-test。B 的主结论相同，也是全部隐藏并已合入，但 B 发到群里的汇总写成「通了 1 项、没通 3 项」，其中 3 项标为待验证，另外还提出社区等级要不要一起隐藏，由 aven 来定。两边报告的完成状态有实质分歧。
  - falive 私 +65s：🛠 开始做：aven 交办：按 Mateo（产品）在话题里的定论——第一期不做用户等级和主播等级，前端把等级图标和等级显示都隐藏——同步改 web 端（【专项】Falive融合技术讨论群）
  - falive 私 +486s：✅ 按 Mateo 的决定，web 端把主播等级和用户等级都隐藏了，涉及四处：搜索结果里主播卡的等级徽章、直播间公屏的等级徽章（Lv.7 以上发言变色也去掉了）、本人和他人主页昵称旁的直播 Lv、本人主页右栏的直播等级卡。社区等级和勋章没动，接口字段也都保留。类型检查和相关测试都通过了；按工单规则这次没开页面看，页面效果交给测试在测试环境验收。改动在本地分支
  - 模拟 群 +19s：@Aven.tong 收到，按 Mateo 说的，web 端的等级图标和等级显示先全部隐藏。
  - 模拟 群 +285s：@Aven.tong web 端等级隐藏：通了 1 项，没通 3 项 - ⚠️ 待验证 他人主页昵称旁的等级胶囊：已隐藏，本地连 pre 打开 /user/260 看过，没有 Lv 胶囊；这次没实测 - ⚠️ 待验证 直播间公屏等级徽章（含 Lv.7 以上绿字）：已隐藏，本地连 pre 打开直播间公屏看过，欢迎条和消息里都没有等级；这次没实测 - ⚠️ 待验
  - 模拟 私 +19s：🛠 开始做：aven 交办：Mateo 在话题里定了第一期不做用户等级和主播等级，要求前端把等级图标和等级显示都隐藏。aven 让 bot 照这个口径，把 web 端相应的（Falive产研技术沟通群）
  - 模拟 私 +285s：✅ 按 Mateo 的决定，web 端的用户等级和主播等级已经全部隐藏，共 5 处：本人主页资料头的「直播 Lv.N」、本人主页右栏的直播等级卡（含等级图标）、他人主页昵称旁的 Lv 胶囊、直播间公屏里的等级徽章（Lv.7 以上绿字高亮也一起去掉了）、搜索结果主播卡上的等级徽章。数据层没动，二期要恢复时直接接回。本地连 pre 后端看了他人主页、直播间公屏和

### ep-1027-d756ea C2 om_x100b6133904a8ca0eedb2ac2b7bcc4c（php-group，at_bot）

> Arthur.a：<p>@Aven.Bot 文档在哪里</p>

- 差异：replied、groupCount、dmCount、decision、endState；归因：模拟偏差（能修）（话题根被藏）——「文档在哪里」是挂在 falive 当时那张 C1 结论卡下的话题回复；组内 falive 的卡不供，轮询发现不了这个话题，2 分钟没收到就往下走了。已修（ownRootsToKeep 照供话题根）。
- 路径 falive：question/done（received ack started anchored）；模拟：—/none（无日志）
  - falive 群 +52s：@Arthur.a 抱歉刚才漏了链接，我马上把 Bug-4970 的 curl 文档链接补发给你。
  - falive 群 +169s：@Arthur.a 抱歉，刚才那条漏了链接，Bug-4970 的复现 curl 和返回都在下面这份文档里。刚又测了一遍，结果没变：旧号 16517528005 / shellyPre5 登录回「用户不存在」，测试号输错密码回「密码错误」。 - ⚠️ 接了但还不能用 旧 Hichat 账号在 portal 登录：手机号（带不带区号 86）和用户名都回「用户不存
  - falive 私 +52s：🛠 开始做：Arthur 引用了 bot 刚发的 Bug-4970 复现结果卡片，问卡片里说的「整理在文档里」的那份文档在哪。卡片里没有附文档链接，需要补发文档链接，或把 （Falive PHP后端群）
  - falive 私 +170s：✅ 上次回 Arthur 时 Bug-4970 的 curl 文档内容写了，但 detailDoc 被放进了 report 里，worker 只读顶层 detailDoc（lark-bot lib/lark-run-report.mjs:27），所以卡片没带链接；本轮 10-27 14:35（+4）在 pre 重测 portal 登录结果不变，已把完整 cu

### ep-1028-03cd66 C1 om_x100b612f9e03f8a0fe2bf3f6e03cd66（webhook-group，principal_dm）

> Aven.tong：已部署

- 差异：dmCount、decision、endState；归因：模拟偏差（能修）（任务库没还原）——「已部署」要锚到窗口前 07:01Z 了结的 retest-falive-20261028-1047；模拟没还原任务库，回「这句没对上任务」。已修（taskStubsFromAudits），复跑 fix 已锚到同一条任务、开做。
- 路径 falive：requirement/done（started anchored）；模拟：—/unanchored（unanchored）（falive 审计 done）
  - falive 私 +30s：🛠 开始做：aven 在私聊里说 pre「已部署」，让 bot 重跑 pre 复测任务 retest-falive-20261028-1047：逐条复测这次部署带进去的 1（falive 控制台）
  - falive 私 +6419s：✅ 有带。web 调权益兑换（Go：POST /go-api/api/mallRights/exchange/{id}）走 pointsRequest，请求头固定带 X-Hc-Uid；但它的值是浏览器本地生成并存在 localStorage(falive__hc_uid) 的随机 UUID（设备标识，照 hichat 的 X-Hc-Uid 用法），不是 hi
  - 模拟 私 +7s：这句没对上任务：12 小时内没有我发给你的任务通知。要续跑或补充，请写「继续任务 <任务 id> 补充内容」；要结单写「结单 <任务 id>」。

### ep-1028-03cd66 C2 om_x100b6128e240eca0ffd8360fc5e55ec（webhook-group，principal_dm）

> Aven.tong：已部署

- 差异：decision、endState；归因：模拟偏差（能修）（任务库没还原（连带））——第二句「已部署」falive 锚到 C1；C1 在模拟里没建成，跟着锚不到。
- 路径 falive：requirement/done（started anchored）；模拟：—/unanchored（unanchored）（falive 审计 done）
  - falive 私 +36s：🛠 开始做：aven 在私聊里对一张已结单的 pre 复测工单说「已部署」，意思是让 bot 在新部署的 pre（c026afb6）上重新复测两个提交：1255f68 直播（falive 控制台）
  - 模拟 私 +2s：这句没对上任务：12 小时内没有我发给你的任务通知。要续跑或补充，请写「继续任务 <任务 id> 补充内容」；要结单写「结单 <任务 id>」。

### ep-1028-ee9885 C1 om_x100b612916b3c8a0ed3b215e1ee9885（php-group，at_bot）

> Arthur.a：@Aven.tong @Aven.Bot 请帮我核实一下现在web端调用权益兑换接口，请求头是否有传X-Hc-Uid字段呢

- 差异：dmCount；归因：说不清（私信归属歧义）——模拟里 C2（aven 私聊「已部署」）的开始卡写的是 Arthur 那条问题，启发式归属把它算到了 C1，C1 多 1 条私信；结论 same。
- 路径 falive：question/done（received ack started）；模拟：question/done（received ack started）（模拟任务 done）（falive 审计 done）
- 大意：same——A 的结论是：web 调权益兑换接口时请求头确实带了 X-Hc-Uid，值是浏览器本地持久化的设备 UUID，不是用户 id，用户身份靠 Authorization: hiApp 传；B 给的判断和取值说明都一样。B 多说了一句 pre 上没能抓到真实兑换请求，A 在私信里也提到 Go 接口没法实测、没有真实调用，这一点不算实质分歧。
- 上下文：只 falive 「Arthur.a（10-28 14:56）：@Williamwang HT 这个API你这边现在通了吗，我记得好像另外一」；只模拟 「Arthur.a（10-28 14:56）：@Williamwang HT 这个API你这边现在通了吗，我记得好像另外一」
  - falive 群 +43s：@Arthur.a 收到，我去代码里查下权益兑换请求有没有带 X-Hc-Uid，查完回你。
  - falive 群 +151s：@Arthur.a 有带。web 调权益兑换（POST /api/mallRights/exchange/{id}，走 Go）时请求头里每次都带 X-Hc-Uid，但它的值是浏览器第一次访问时生成并存在本地的随机 UUID，相当于设备标识，不是 hichat 的用户 id；用户身份是靠 Authorization: hiApp 传的。如果后端要的是用户 id
  - falive 私 +44s：🛠 开始做：Arthur（hichat / 账号后端）直接 @ aven 和 bot，请他们核实：web 端现在调权益兑换接口时，请求头里有没有带 X-Hc-Uid 字段。（Falive PHP后端群）
  - falive 私 +152s：✅ 有带。web 调权益兑换（Go：POST /go-api/api/mallRights/exchange/{id}）走 pointsRequest，请求头固定带 X-Hc-Uid；但它的值是浏览器本地生成并存在 localStorage(falive__hc_uid) 的随机 UUID（设备标识，照 hichat 的 X-Hc-Uid 用法），不是 hi
  - 模拟 群 +33s：@Arthur.a 收到，我查下 web 调权益兑换接口时请求头有没有带 X-Hc-Uid，查完回你。
  - 模拟 群 +117s：@Arthur.a 有带。web 点兑换调 POST /api/mallRights/exchange/{id}（Go）时，请求头会带 X-Hc-Uid，值是浏览器本地持久化的设备 UUID（不是会员 ID），同时带 X-Device-Type: 1、X-Version: 3.12.0、Accept-Language 和 Authorization: hiA
  - 模拟 私 +33s：🛠 开始做：Arthur（账号后端）在群里 @aven 和 bot，请我们核实一下：web 端调权益兑换接口时，请求头里有没有传 X-Hc-Uid。（Falive PHP后端群）
  - 模拟 私 +117s：✅ 有带。web 调权益兑换 POST /go-api/api/mallRights/exchange/{id} 走 task-center 的 pointsRequest（src/modules/task-center/hichat/mall.ts exchangeMallRight → requests.ts pointsRequest），统一加 X-H
  - 模拟 私 +208s：🛠 开始做：Arthur（账号后端）问 web 调权益兑换接口时，请求头里有没有带 X-Hc-Uid。aven 私聊指示回他「已部署」：web 端相关版本已经部署，请 Ar（Falive PHP后端群）

### ep-1028-ee9885 C2 om_x100b61292d1cb0a0fe10cefbcde0e47（webhook-group，principal_dm）

> Aven.tong：已部署

- 差异：groupCount；归因：说不清（群回复归属歧义）——C2 是 aven 的私聊指示，falive 当时的指示任务结论只私信（群里那句没发 / 归到了别处），模拟发了群；两边结论 same，差在哪条群消息归给谁。
- 路径 falive：question/done（started anchored）；模拟：question/done（started anchored）（模拟任务 done）（falive 审计 done）
- 大意：same——A 在 11:12:27 对这条的回复是：web 端调权益兑换接口时请求头带了 X-Hc-Uid，值是浏览器本地的设备 UUID，不是用户 id，同时带登录 token、X-Device-Type、X-Version，pre 线上包也是这样。B 的判断和结果跟 A 一致。
  - falive 私 +16s：收到，当作对「Arthur（hichat / 账号后端）直接 @ aven 和 bot，请他们核实：web 端现在」（Falive PHP后端群）这条的指示处理。不是这条就回「取消任务 om_x100b61292d1cb0a0fe10cefbcde0e47」。
  - falive 私 +710s：✅ 把 Henry 那份 Bug 问题文档收进待对接目录，按群里已有的答复写了反馈文档：勋章已定，一期不做，等 Henry 隐藏 tab；Bug-4997 群头像、用户头像归「群同步」，等后端 Max / mainly；Bug-4952 搜索助理昵称还在等产品 Mateo 定。本轮在 pre 上测了：勋章路径返回的是网页，不是接口；测试号的会话列表只有私聊，
  - 模拟 群 +496s：@Arthur.a 有传。web 端调权益兑换接口（POST /go-api/api/mallRights/exchange/{id}）时请求头里带了 X-Hc-Uid，值是浏览器本地保存的设备 UUID（不是会员 ID），同时带 X-Device-Type: 1、X-Version、Accept-Language 和登录 token；pre 现在部署的前端
  - 模拟 私 +10s：收到，当作对「Arthur（账号后端）在群里 @aven 和 bot，请我们核实一下：web 端调权益兑换接口时，」（Falive PHP后端群）这条的指示处理。不是这条就回「取消任务 om_x100b61292d1cb0a0fe10cefbcde0e47」。
  - 模拟 私 +496s：✅ 有传。web 端权益兑换 POST /api/mallRights/exchange/{id} 走 Go（task-center-routes 把 mallRights 路由到 golang），统一经 pointsRequest 发出，浏览器端固定带 X-Hc-Uid（localStorage falive__hc_uid 持久化的设备 UUID，不是会

### ep-1030-167d28 C1 om_x100b61790d52a4a0ff5fecf60167d28（tech-group，at_bot）

> Aven.tong：@Aven.Bot 这个是 online 环境的异常，看看是什么原因，修掉

- 差异：groupCount、dmCount、gist；归因：模拟偏差（能修）（时序（时钟压缩））——模拟 C1 17s 就开做、很快 blocked，C2「这有更多点的信息」到时 C1 已挂起 → 同话题并入 C1 续跑（C1 多了群 / 私信）；falive 当时 C1 首句 105s，C2 到时没并入、另起一单。结论大意 partial。
- 路径 falive：bug/blocked（received ack started resumed closed dmResume）；模拟：bug/blocked（received ack started resumed dmResume）（模拟任务 blocked）（falive 审计 blocked）
- 大意：partial——A 对这条先是判卡住、缺 online 接口证据，后来用补来的账号查到「社区帖子评论」(task 8) 在 Go 端一直回 taskStatus 0，定为后端根因、前端不用改，转给 Arthur。B 也判卡住、前端不改，但评论问题仍停在缺 online 证据、没能定性（读取权限被拦），又多给了 FameEX oneTimeToken 的后端根因。两边主结论都是不改前端、交后端，但 A 拿到了关键的定性证据，B 没有。
- 上下文：只 falive 「Arthur.a（10-30 19:56）：是」；只模拟 「Charlie（10-30 21:30）：@HQUCEncone 预计还有多久可以完成？」
  - falive 群 +105s：@Aven.tong 收到，我先查社区帖子评论完成后没置灰的原因，查清后修掉。
  - falive 群 +536s：「aven 转发 Kaiser 报的 online 问题并交给 bot」这边卡住了，需要你们帮忙： - 缺 online 接口实际返回：评论后 post/create 的 pending、有没有调 points/task/complete 和它的返回、刷新后 points/task/list 里评论任务的 taskStatus 都还没拿到，分不清根因在后端任
  - falive 私 +106s：🛠 开始做：aven 转发 Kaiser 报的 online 问题并交给 bot：falive.com/hc/tasks 任务中心「新手任务-社区帖子评论」已经完成，但按钮（Falive产研技术沟通群）
  - falive 私 +536s：⏸ 停下来了（Falive产研技术沟通群）：截图里的问题出在 online /hc/tasks：「社区帖子评论」任务已经做完，按钮还是「去完成」、没有置灰。按钮只看 Go points/task/list 返回的 taskStatus，评论后上报完成的代码（850345cb / 18325ca7）也已经在 origin/online 上。现在没有 Kaise
  - 模拟 群 +17s：@Aven.tong 收到，我先查「社区帖子评论」完成后没置灰的原因，再修。
  - 模拟 群 +123s：@Arthur.a 「aven 转来 Kaiser 报的 online 问题」这边卡住了，需要你们帮忙： 完整内容：https://sim.local/docx/simdoc00003
  - 模拟 群 +581s：@Arthur.a 「aven 转来 Kaiser 报的 online 问题」这边卡住了，需要你们帮忙： - Go `/go-api/api/fameEx/oneTimeToken/v2` 在 online 回 code -1「外部服务调用失败」（hc-api 同一接口正常），后端根因，要 Go 后端（Arthur）修好取票。前端按契约走 Go，不改选路。 
  - 模拟 私 +17s：🛠 开始做：aven 转来 Kaiser 报的 online 问题：falive.com/hc/tasks 新手任务「社区帖子评论」已经完成，按钮还是「去完成」，没有置灰。（Falive产研技术沟通群）
  - 模拟 私 +123s：⏸ 停下来了（Falive产研技术沟通群）：在 online 上评论帖子后，「社区帖子评论」任务仍显示「去完成」且没有置灰。前端只是如实显示 Go `points/task/list` 返回的 `taskStatus`，评论成功后的申报链路也已接好；pre 上 10-28 两次复现过同样的问题（`complete` 返回 code 0，但任务仍是 `task
  - 模拟 私 +468s：🛠 开始做（续）：aven 转来 Kaiser 报的 online 问题：falive.com/hc/tasks 新手任务「社区帖子评论」已经完成，按钮还是「去完成」，没有置灰。（Falive产研技术沟通群）
  - 模拟 私 +581s：⏸ 停下来了（Falive产研技术沟通群）：online `/hc/tasks` 的两处异常：①「点击FameEX入口」报错，是 Go `/go-api/api/fameEx/oneTimeToken/v2` 自己回了 code -1「外部服务调用失败」。同一账号走 hichat `/hc-api` 取票正常，前端按 10-19 的 Go 契约选路，没有错。
  - 模拟 私 +714s：🛠 开始做（续）：aven 转来 Kaiser 报的 online 问题：falive.com/hc/tasks 新手任务「社区帖子评论」已经完成，按钮还是「去完成」，没有置灰。（Falive产研技术沟通群）
  - 模拟 私 +889s：⏸ 停下来了（Falive产研技术沟通群）：online 任务中心有两个问题：一是「社区帖子评论」做完后按钮没置灰，二是 FameEX 跳转报错。两处的前端代码都只是把接口返回的数据照样显示，online 包里评论成功后申报任务的提交也都已合入。第一个问题要 online 接口实际返回的 taskStatus 才能定根因，本次只读探测被生产读取权限拦下；第二

### ep-1030-167d28 C2 om_x100b6179153170a0fff1b7b426297ed（tech-group，at_bot）

> Aven.tong：这有更多点的信息，请整体看看 @Aven.Bot

- 差异：replied、groupCount、dmCount、decision、endState；归因：模拟偏差（能修）（时序（时钟压缩））——同 C1：模拟里并进了 C1，falive 当时另起任务（bug/blocked，群 4 句）。
- 路径 falive：bug/blocked（received ack started anchored closed）；模拟：—/merged（merged）（falive 审计 blocked）
  - falive 群 +140s：@Aven.tong 收到，完善资料没拿到积分我和评论任务一起查，查清原因后修掉。
  - falive 群 +587s：@Arthur.a 「aven 把 Kaiser 在话题里补充的信息转给 bot，让 bot 结合起来看 OL falive.com/hc/tasks 任务中心新手任务的问题」这边卡住了，需要你们帮忙： 完整内容：[https://qfglxo2m3dc.sg.larksuite.com/docx/Zf19db7LDoLBzTxcZDulVJdagTc](h
  - falive 群 +987s：@Arthur.a 「aven 转发 Kaiser 报的 online 问题并交给 bot」这边卡住了，需要你们帮忙： - 后端根因：online Go points/task/list 对 uid 484 的「社区帖子评论」（DISCUZ/reply，task id 8）一直回 taskStatus 0。积分流水里没有 reply +20、只有一笔 rep
  - falive 群 +1336s：@Arthur.a 汇总一下 Kaiser 21:22 报的 online 任务中心问题（替代 bot 刚才那三条）：「社区帖子评论」任务评论后一直不算完成，根因在后端，前端不用改。 - 用 Kaiser 的号（uid 484）查 online：Go `points/task/list` 里这项（DISCUZ / reply，task id 8）一直是未完成
  - falive 私 +140s：🛠 开始做：aven 把 Kaiser 在话题里补充的信息转给 bot，让 bot 结合起来看 OL falive.com/hc/tasks 任务中心新手任务的问题：「社区（Falive产研技术沟通群）
  - falive 私 +334s：🛠 开始做（续）：aven 转发 Kaiser 报的 online 问题并交给 bot：falive.com/hc/tasks 任务中心「新手任务-社区帖子评论」已经完成，但按钮（Falive产研技术沟通群）
  - falive 私 +588s：⏸ 停下来了（Falive产研技术沟通群）：online 任务中心「社区帖子评论」「完善资料（头像+昵称）」做完后仍显示「去完成」。前端是直接按 Go `points/task/list` 返回的 taskStatus 画按钮的，没有本地状态。按后端给的《前端完成任务接入说明》，这两类任务都不归前端申报：「社区帖子评论」（PRD N008，新手 +20，对应
  - falive 私 +987s：⏸ 停下来了（Falive产研技术沟通群）：用补的账号登录 online 查了接口：「社区帖子评论」这项在 Go 的 points/task/list 里本来就回未完成，问题在后端，前端没有要改的。这项的 taskType 是 DISCUZ，taskCode 是 reply（id 8），按契约该由社区服务端回调 Go 来标完成，不归前端申报。这个账号的积分流

### ep-1030-167d28 C5 om_x100b617a6af430a4ffdcddda4e9e86e（tech-group，at_bot）

> Aven.tong：bug 列表还需要 web 端修的 bug ，确认一下，请马上修掉 @Aven.Bot

- 差异：replied、groupCount、dmCount、decision、endState；归因：模拟偏差（能修）（话题回复等待太短）——话题回复靠话题轮询（每轮最多 5 个话题），模拟每条 case 只等 2 分钟就往下推、随后收尾，没收到；falive 当时收到并答了。已修（话题回复等 6 分钟）。falive 当时还读了记忆 bug-sheet-workflow.md（同 ep-1024 C1，已修）。
- 路径 falive：bug/no_change_needed（received ack started anchored）；模拟：—/none（无日志）（falive 审计 no_change_needed）
  - falive 群 +313s：@Aven.tong 收到，我逐条确认 5139/5140/5141 哪些要 web 改，要改的马上修。
  - falive 群 +752s：@Aven.tong 逐条核对过了，这 3 个都不用 web 改；bug 表 PM-3254 目前也没有要 web 修的待处理单。 完整内容：[https://qfglxo2m3dc.sg.larksuite.com/docx/L9NTd9ZHgoKPB9xac7MlrLq4g2c](https://qfglxo2m3dc.sg.larksuite.com/
  - falive 私 +314s：🛠 开始做：aven 引用 Kaiser 22:25 的任务中心 bug 列表（OL 环境：Bug-5139 完成任务后「去完成」没置灰、Bug-5141 改头像和备注没拿（Falive产研技术沟通群）
  - falive 私 +752s：ℹ️ 看过了，不用改（Falive产研技术沟通群）：核对了 bug 表：Kaiser 点名的任务中心 3 个问题和 PM-3254 其余待处理单都标的后端，目前没有要 Web 端修的单，前端不用改代码。评论任务不置灰、改资料没积分，卡在 Go / 社区回调发奖；fameex 跳转卡在交易所加白审批，明天 Will 跟。这次 pre 连不上，没能补测接口，结论

### ep-1030-337e3d C1 om_x100b617ee9cc04a4eeef84e99337e3d（php-group，at_bot）

> HQUCEncone：@Aven.Bot OL 个人主页 帮忙看下api 返回资料 https://www.falive.com/bbsv2/member/info?channel_code=hc

- 差异：groupCount、decision；归因：模型抽样（同输入不同输出）（分类抽样）——question→bug，两边都卡在要 OL 登录态 / 说明，结论 same；falive 多发了一句。
- 路径 falive：question/blocked（received ack started closed）；模拟：bug/blocked（received ack started）（模拟任务 blocked）（falive 审计 blocked）
- 大意：same——两次都因为拿不到登录态下的真实返回、问题描述又不清楚而卡住，要的东西也一样：Response 或测试账号，外加说明哪一项不对。报错码一个写 -700、一个写 407/-800，这只是细节不同，结论一致。
  - falive 群 +29s：@HQUCEncone 收到，我去 OL 个人主页看下 member/info 的返回，看完回你。
  - falive 群 +90s：@.Ache.l @HQUCWilliam.m online 直播间两个问题麻烦看下： 1. 直播播不了：直播 CDN 播放域名 play2zz.sysiyu11.com 的 Referer 防盗链白名单里没有 www.falive.com。同一个播放地址带 www.falive.com 回 403，带 pre / uat 域名或不带 Referer 都是 
  - falive 群 +203s：@HQUCEncone 「Encone（portal 后端）@bot，请看一下 OL（www.falive.com）个人主页调 bbsv2/member/info?channel_cod」这边卡住了，需要你们帮忙： - 没有 OL 登录态：/bbsv2/member/info 只返回本人资料，游客调用一律 -700。需要以下二选一：提问人在 OL 个人主页打
  - falive 私 +30s：🛠 开始做：Encone（portal 后端）@bot，请看一下 OL（www.falive.com）个人主页调 bbsv2/member/info?channel_cod（Falive PHP后端群）
  - falive 私 +203s：⏸ 停下来了（Falive PHP后端群）：我在 OL 上带签名请求了这个接口（只读）：游客调用 `/bbsv2/member/info` 返回 HTTP 200 + code -700「登陆状态失效，无TOKEN」，这是正常的登录门槛。公开接口 otherInfo 和 threadsCount 在 OL 上都能正常返回资料。但「个人主页资料」必须带登录 t
  - 模拟 群 +29s：@HQUCEncone 收到，我去 OL 对一下 member/info 的返回和个人主页显示，看完回你。
  - 模拟 群 +98s：@HQUCEncone 「Encone（portal 后端）@bot，请我们查一下 OL 个人主页调 bbsv2/member/info?channel_code=hc 返回的资料，并核」这边卡住了，需要你们帮忙： - 拿不到 OL 上 bbsv2/member/info 的真实返回：没签名直接请求回 HTTP 407、{code:-800,msg:'非法请
  - 模拟 私 +29s：🛠 开始做：Encone（portal 后端）@bot，请我们查一下 OL 个人主页调 bbsv2/member/info?channel_code=hc 返回的资料，并核（Falive PHP后端群）
  - 模拟 私 +98s：⏸ 停下来了（Falive PHP后端群）：任务是查看 OL bbsv2 member/info 的返回资料，但请求要 vn-sign 签名和 OL 登录 token。没签名直接请求回 -800 非法请求，任务和附件里也没有这个接口的真实返回或页面截图，没法判断异常在哪一层，需要补材料。 要：拿不到 OL 上 bbsv2/member/info 的真实返回：

### ep-1030-337e3d C3 om_x100b617ef5885ca0ed87e0a531e4598（php-group，at_bot）

> HQUCEncone：个人资料必须要登陆才行，请aven 给你一个账户 @Aven.Bot 帮忙看下 api 返回资料」

- 差异：groupCount；归因：模型抽样（同输入不同输出）（群回复句数抽样）——结论 same（都停下等 aven 给 OL 账号），falive 多一句 ack。
- 路径 falive：api_reply/blocked（received ack started anchored closed）；模拟：api_reply/blocked（received ack started anchored）（模拟任务 blocked）（falive 审计 blocked）
- 大意：same——A 对这条的结论是：这是只读查接口的活，但 bot 没有 OL 账号，正式环境也不能注册，所以先停下等 aven 给账号或 token；B 的结论也是没有登录态、停下等 aven 给账号。两边判断一致，游客调用返回的错误码不同（-700 和 407/-800）只是细节差异。
- 上下文：只 falive ；只模拟 「Arthur.a（10-30 17:29）：我用邮箱也是正常注册了」
  - falive 群 +47s：@HQUCEncone 好的，我跟 aven 要个 OL 账号，登录后看 member/info 返回再回你。
  - falive 群 +1738s：@Arthur.a @HQUCEncone online 任务中心两个 Go 接口回 500，麻烦看下：生产测试账号 734343862@qq.com 登录后，GET /go-api/api/points/task/myPoints?pageNum=1&pageSize=20 和 GET /go-api/api/mallRights/getList 都回 H
  - falive 私 +48s：🛠 开始做：Encone 答复 bot 18:35 的卡点：OL 个人资料接口必须登录才能看，请 aven 给 bot 一个账号，再登录看 bbsv2/member/inf（Falive PHP后端群）
  - falive 私 +94s：⏸ 停下来了（Falive PHP后端群）：这是只读查接口的活：用 OL 登录态调 www.falive.com/bbsv2/member/info?channel_code=hc，把返回的资料给 Encone。这个接口只返回本人资料，游客调用一律 -700，必须登录。bot 现在没有 OL 账号，正式环境也不能自己注册，得等 aven 给一个 OL 账号（
  - 模拟 群 +36s：@HQUCEncone 好的，我找 aven 要个 OL 账号，登录后抓 member/info 返回再回你。
  - 模拟 私 +36s：🛠 开始做：Encone（portal 后端）接着回了 bot 18:33 卡住时提的问题：OL 个人主页的 bbsv2/member/info 要登录后才能拿到资料，让 （Falive PHP后端群）
  - 模拟 私 +81s：⏸ 停下来了（Falive PHP后端群）：这是只读排查：要在 OL 登录状态下抓 bbsv2/member/info?channel_code=hc 的真实返回，再和个人主页显示对一遍。Encone 已说明这个接口要登录才能调，并请 aven 给 bot 一个账号，但目前本地没有 OL 测试账号或登录 token，进不去，只能等 aven 给账号。 要：没

### ep-1030-83e8e3 C1 om_x100b6177ab8c8ca8fffa5c17283e8e3（webhook-group，principal_dm）

> Aven.tong：帮我合

- 差异：dmCount、endState；归因：还原不了（模拟局限）（合回状态 / 任务分支还原不了）——「帮我合」要窗口前的合回冲突记录（runtime/lark-merge-back，存档里今天是空的）和任务分支；还原不了，模拟回「这句没对上任务」，falive 当时开合了 2 条（随后因基线问题没做成）。
- 路径 falive：—/none（无日志）；模拟：—/unanchored（unanchored）
  - falive 私 +7s：好，2 条开始合：pre 部署后复测（pre @ 11a5c6c6，构建于 10-30 08:53）；William（live php 后端）引用 aven 上线清单里的 U2「uat 前台 nginx 没转发 /hc-w。合进 feature/phase-5-test 后私信你取舍。
  - falive 私 +10s：⛔ 没做成（falive 控制台）：项目 FALIVE 需要准备隔离临时 worktree； 临时分支 lark/falive-10300853 已有提交但不包含本次项目基线 d3b079ef5abd；为避免把旧基线提交混入当前需求，请人工 rebase/cherry-pick 后重试
  - falive 私 +13s：⛔ 没做成（falive 控制台）：项目 FALIVE 需要准备隔离临时 worktree； 临时分支 lark/falive-90e4c409 已有提交但不包含本次项目基线 d3b079ef5abd；为避免把旧基线提交混入当前需求，请人工 rebase/cherry-pick 后重试
  - 模拟 私 +4s：这句没对上任务：12 小时内没有我发给你的任务通知。要续跑或补充，请写「继续任务 <任务 id> 补充内容」；要结单写「结单 <任务 id>」。

### ep-1030-b864a1 C1 om_x100b6177d8a13cacff5fc67ecb864a1（tech-group，at_bot）

> HQUCEncone：@Aven.Bot 能不能将全部功能先打包到 uat OL 这样后端可以明显的排查缺哪些配置？

- 差异：groupCount、endState、gist；归因：还原不了（模拟局限）（环境漂移（实测打今天的 uat））——falive 当时判 uat 已在跑全量最新包、不用再打包；模拟判还要部署、停下等 aven。看的是今天的 uat（推断）。
- 路径 falive：requirement/no_change_needed（received ack started）；模拟：requirement/blocked（received ack started）（模拟任务 blocked）（falive 审计 no_change_needed）
- 大意：different——A 的结论是前端不用再打包：uat 已经跑着全部功能的最新包，和 pre 表现不同的地方都是环境配置问题（限频 503、/hc-ws 没转发、用户没同步），OL 等部署信审批。B 虽然也认为代码已合、不用改代码，但它判断 uat/OL 还需要部署，所以停下来等 aven 发部署信并决定 O1 怎么取舍，群里也没给结论。两边一个做完了，一个卡住了，判断也相反（uat 已部署 vs 待部署）。
  - falive 群 +34s：@HQUCEncone 收到，我先核对 uat / OL 现在的前端版本，再请 aven 定全量打包的安排。
  - falive 群 +189s：@HQUCEncone ✅ 前端不用再打包了：uat 现在跑的就是全部功能的最新包，和 pre 用的是同一套代码，前端也没有按环境关功能的开关，所以 uat 上和 pre 表现不一样的地方，都是环境配置的差别。已知的有三处：网关按 IP 限频（页面约一半 503）、/hc-ws 没转发，还有 uat 没同步用户，嗨聊老用户在 go 登录会提示用户不存在。OL
  - falive 私 +35s：🛠 开始做：Encone（portal 后端）@bot 问能不能先把前端全部功能打包部署到 uat 和 OL，方便后端看出各环境还缺哪些配置。（Falive产研技术沟通群）
  - falive 私 +189s：ℹ️ 看过了，不用改（Falive产研技术沟通群）：前端这边不用再打包：uat 上现在的包就是 uat 分支的最新代码，pre 和开发分支上的功能都已经在里面。online 分支也已经合入同一份代码，但 www.falive.com 还是旧包，要等今早发的 OL 部署信审批通过、运维部署。uat 上剩下的问题是后端和运维的配置：网关按 IP 限频导致服务端渲
  - 模拟 群 +29s：@HQUCEncone 收到，全量打包到 uat / OL 的事我先和 aven 对一下范围再安排。
  - 模拟 私 +29s：🛠 开始做：Encone（portal 后端）想让 web 前端先把全部功能打包发到 uat 和 OL，这样后端能直接看出各环境还缺哪些配置。（Falive产研技术沟通群）
  - 模拟 私 +79s：⏸ 停下来了（Falive产研技术沟通群）：代码已经全部合进 uat 和 online 分支了：origin/online 和 origin/pre 的提交都是 9841d8f2（10-30 04:55 UTC 合入，pre→uat 4795c208、uat→online 9841d8f2，含 feature/phase-5-test 全部提交，比如邀请好友

### ep-1030-b864a1 C2 om_x100b617786100ca0ff6b1db92350c34（tech-group，at_bot）

> HQUCEncone：### U2 前台 nginx 没转发 `/hc-ws`（行情推送） - **现象**：WebSocket 握手 `wss://[faliveuat.fdsser.com/hc-ws](http://faliveuat.fdsser.com/hc-ws)` 回 503。 - **要什么**：`/hc-ws` 转 hic

- 差异：gist；归因：还原不了（模拟局限）（环境漂移（实测打今天的 uat））——falive 当时 uat /hc-ws 还不通（301 / 409），模拟今天握手 101 通了。
- 路径 falive：api_reply/done（received ack started）；模拟：api_reply/done（received ack started）（模拟任务 done）（falive 审计 done）
- 大意：different——A 对这条（06:48 回 Encone）的结论是：uat 的 /hc-ws 复测还是不通，不带斜杠回 301、带斜杠回 409，需要运维改 nginx 配置；B 的结论是 uat 握手回 101、运维已经配好，online 也通了。两边的判断正好相反。
- 上下文：只 falive ；只模拟 「HTStone.z（10-29 17:27）：@HQUCEncone 請問UAT環境 嗨聊既有用戶有同步到B2B後端嗎?」
  - falive 群 +32s：@HQUCEncone 好的感谢，我这就去 uat 复测 /hc-ws 握手和行情推送，测完回你。
  - falive 群 +297s：@HQUCEncone @.Ache.l uat /hc-ws recheck 完整内容：[https://qfglxo2m3dc.sg.larksuite.com/docx/LX2cdtWUsokp91xEVX0lsOwygud](https://qfglxo2m3dc.sg.larksuite.com/docx/LX2cdtWUsokp91xEVX0ls
  - falive 私 +63s：🛠 开始做：William（live php 后端）引用 aven 上线清单里的 U2「uat 前台 nginx 没转发 /hc-ws」，让 bot 再测一下。台账里 En（Falive产研技术沟通群）
  - falive 私 +297s：✅ Ops said the uat /hc-ws forward is done, but my recheck shows it still doesn't work: without the trailing slash it gets a 301 redirect, which a browser WebSocket won't follow, an
  - 模拟 群 +27s：@HQUCEncone 好的感谢，我这就去 uat 复测 /hc-ws 握手和行情实时推送。
  - 模拟 群 +257s：@HQUCEncone @Eric.ea uat /hc-ws 行情推送复测：通了 2 项，没通 1 项 - ❌ 没接 登录后行情实时刷新：要用 uat 登录账号确认顶栏 / 首页行情实时刷新，这次没验，交给 eric 或测试同学 - ✅ 通了 uat /hc-ws 握手：wss://faliveuat.fdsser.com/hc-ws 回 101，收到 h
  - 模拟 私 +44s：🛠 开始做：William（live php 后端）引用 aven 提的 U2（uat 前台 nginx 没转发 /hc-ws），让 bot 再测一次。前面 Encone （Falive产研技术沟通群）
  - 模拟 私 +257s：✅ 复测了 uat 和 online 的行情推送通道 /hc-ws，握手都正常（101），uat 也收到了 hichat 的认证帧，说明运维已经配好，对接文档里这一项已标为已结。登录后的行情实时刷新还要 eric 或测试同学用 uat 账号确认，这次没验。 分支 feature/phase-5-test · 改了 4 个文件 已合进 feature/phas

### ep-1030-b864a1 C3 om_x100b617784d30ca0ffcef5a90e4c409（tech-group，at_bot）

> HQUCWilliam.m：@Aven.Bot ### U2 前台 nginx 没转发 `/hc-ws`（行情推送） - **现象**：WebSocket 握手 `wss://[faliveuat.fdsser.com/hc-ws](http://faliveuat.fdsser.com/hc-ws)` 回 503。 - **要什么**：`/hc

- 差异：dmCount、gist；归因：还原不了（模拟局限）（环境漂移（实测打今天的 uat））——同 C2。
- 路径 falive：api_reply/done（received ack started）；模拟：api_reply/done（received ack started）（模拟任务 done）（falive 审计 done）
- 大意：different——A 对这条的结论（06:48:58 回 William 的那条）是 uat /hc-ws 复测还是不通：不带斜杠的请求被 301 跳转，带斜杠的被 Cloudflare 回 409，要运维改 nginx 配置；B 的结论是 uat 已经通了（回 101），online 也通了，这条可以结。两边判断正好相反。
- 上下文：只 falive ；只模拟 「HQUCEncone（10-30 10:43）：### U2 前台 nginx 没转发 `/hc-ws`（行情推送）」 「- **影响**：顶栏 / 首页行情不实时刷新（打开页面时的行情数据正常）」 「@Aven.Bot 已经补充了」
  - falive 群 +41s：@HQUCWilliam.m 好的，我这就在 uat 复测 /hc-ws 握手和行情实时刷新，测完回结果。
  - falive 群 +313s：@HQUCWilliam.m @.Ache.l uat /hc-ws 行情推送复测 完整内容：[https://qfglxo2m3dc.sg.larksuite.com/docx/I7vqd3t7yovkWtxkx7xl72blgbh](https://qfglxo2m3dc.sg.larksuite.com/docx/I7vqd3t7yovkWtxkx7x
  - falive 私 +13s：🛠 开始做：Encone（portal 后端）答复 aven 10-30 提的 U2：uat 前台 nginx 已经补上 /hc-ws 转发（转 hichat /ws/im（Falive产研技术沟通群）
  - falive 私 +313s：✅ uat 的 /hc-ws 复测还是不通，但和早上不一样了：运维已经加了转发，只是没配对。不带斜杠的 /hc-ws 会 301 跳到 /hc-ws/，浏览器的 WebSocket 不跟跳转；带斜杠的 /hc-ws/ 又被 Cloudflare 回 409。hichat 上游直连和 pre 的同一路径握手都正常，所以前端不用改。已把现象和给运维的配置要求更新
  - falive 私 +441s：好，2 条开始合：pre 部署后复测（pre @ 11a5c6c6，构建于 10-30 08:53）；William（live php 后端）引用 aven 上线清单里的 U2「uat 前台 nginx 没转发 /hc-w。合进 feature/phase-5-test 后私信你取舍。
  - 模拟 群 +24s：@HQUCWilliam.m 收到，我这就去 uat 复测 /hc-ws 握手和行情推送，测完回结果。
  - 模拟 群 +247s：@HQUCWilliam.m ✅ @HQUCEncone U2 已复测通过：uat 的 /hc-ws 现在能正常握手并连到 hichat，online 也通了，这条可以结了。登录后行情实时刷新的端到端验收请 eric 用有效账号在 uat 再看一下。 - ✅ 通了 uat /hc-ws 转发：握手已回 101，连上后收到 hichat 的认证提示，说明已经转
  - 模拟 私 +7s：🛠 开始做：Encone（portal 后端）回复了 aven 10-30 10:08 列出的 U2：uat 前台 nginx 原来没转发 /hc-ws（wss 握手回 5（Falive产研技术沟通群）
  - 模拟 私 +247s：✅ 复测了 uat 的 /hc-ws，现在已经通了：握手回 101，连上后收到 hichat 发来的认证提示，说明确实转到了行情推送服务。online 也一样通了。对接文档里这一条已标成已结，前端代码没改。登录后行情实时刷新的端到端验收归 eric 的跑马灯功能，这次没测。 分支 lark/falive-90e4c409 · 改了 1 个文件 ⚠ 没合进 f

### ep-1030-b864a1 C4 om_x100b61701eb704a4fe09213dfc12889（tech-group，at_bot）

> HQUCWilliam.m：@Aven.Bot 再测试一下

- 差异：gist；归因：还原不了（模拟局限）（环境漂移（实测打今天的 online））——uat 一致；falive 当时 online 还没转发，模拟今天 online 也 101。
- 路径 falive：api_reply/done（received ack started anchored）；模拟：api_reply/done（received ack started anchored）（模拟任务 done）（falive 审计 done）
- 大意：partial——A 的结论是：uat 的 /hc-ws 复测通过（带不带斜杠都回 101，有鉴权帧），U2 结案；登录后的行情推送没验；online 还没转发，要 Ache 补上。B 的主结论一样，也是 uat 转发通了、登录后的推送没验，但 B 说 online 握手也是 101、转发是通的，这和 A 判断的「online 没通」是实质分歧。
  - falive 群 +38s：@HQUCWilliam.m 好的，我再去 uat 测一次 /hc-ws 握手和行情推送，测完回你。
  - falive 群 +392s：@.Ache.l @HQUCWilliam.m Encone 问的 OL 行情 ws：浏览器连 wss://www.falive.com/hc-ws，nginx 转到 [https://www.4ees1.xyz/ws/im/echo](https://www.4ees1.xyz/ws/im/echo) 完整内容：[https://qfglxo2m3dc.s
  - falive 私 +40s：🛠 开始做：William（live php 后端）引用 bot 10:48 发的「uat /hc-ws 行情推送复测」卡片，让 bot 再测一次 uat 前台 nginx（Falive产研技术沟通群）
  - falive 私 +392s：✅ 复测了 uat 的 /hc-ws：带不带斜杠都回 101，连上后 hichat 回了鉴权帧，运维这次的转发配置是对的，U2 可以结案。登录后的行情推送要 uat 登录态，这次没有 uat 账号，还没走到。online 的 /hc-ws 还没转发，现在回的是首页，要 Ache 照 uat 的配置补上。答复已存档，对接文档也更新了（分支 lark/faliv
  - 模拟 群 +34s：@HQUCWilliam.m 好的，我再复测一遍 uat 和 online 的 /hc-ws 握手，测完回结果。
  - 模拟 群 +224s：@HQUCWilliam.m @Eric.ea uat /hc-ws 行情推送复测：通了 2 项，没通 1 项 完整内容：https://sim.local/docx/simdoc00021
  - 模拟 私 +34s：🛠 开始做：William（live php 后端）引用 bot 10:48 的「uat /hc-ws 行情推送复测」卡片，让 bot 再测一次 /hc-ws（U2：uat（Falive产研技术沟通群）
  - 模拟 私 +224s：✅ 按 William 的要求又测了一遍 /hc-ws：uat、online、pre 握手都回 101，首帧都是 hichat 的 SRV_NEED_AUTH，说明运维的转发是通的。登录后行情实时刷新这一步还没验（bot 没有 uat 登录账号，游客也不连推送），交给 eric 或测试同学用 uat 账号确认。没改代码，只把答复存了档、在对接文档的 O3 上

### ep-1030-b864a1 C5 om_x100b6170168a64a8ff72d6226351f74（tech-group，at_bot）

> Aven.tong：check 一下这个问题，根据现有信息，同步相关逻辑，做好回群汇报 @Aven.Bot

- 差异：groupCount、latency、decision、endState、gist；归因：模型抽样（同输入不同输出）（做法抽样）——falive 改了前端（终检超时没提交，failed），模拟只报卡点找 Arthur（blocked）；分类 bug→api_reply。首句 156s→58s 归时序。
- 路径 falive：bug/failed（received ack started closed）；模拟：api_reply/blocked（received ack started）（模拟任务 blocked）（falive 审计 failed）
- 大意：partial——A 对这条的结论（07:49 私信 aven，终检没过，没提交）是：确认是前端把 live uid 当成 hichat_id 传了，已改成他人主页不再用 live uid 调这支接口，hichat_id 从哪拿还要 Arthur 定。B 判断一样，也是找 Go 后端要 ID 换算口径，但 B 停下来什么都没改。所以主判断一致，但 A 部分做成、B 没动手，是实质分歧。
- 上下文：只 falive 「Arthur.a：没有文档，当时有过沟通」；只模拟 「HQUCEncone（10-30 09:51）：（发了 1 张图）」
  - falive 群 +156s：@Aven.tong 收到，我去查 influencers 路径参数的取值，改成传 hichat_id，改完回群汇报。
  - falive 私 +156s：🛠 开始做：aven 转发 Arthur（Go 后端）的反馈：uat 上前端调 /go-api/api/b2b/influencers/{id} 时，路径参数用的是 liv（Falive产研技术沟通群）
  - falive 私 +1685s：⛔ 没做成（Falive产研技术沟通群）：任务：【被引用消息】（Arthur.a 10-30 11:09）； Worker 对最终内容的独立终检未通过，未提交、未按完成处理； 失败项：typecheck: spawnSync /Users/aven/github/.lark-falive/lark-falive-26351f74/node_modules/.
  - 模拟 群 +58s：@Aven.tong 收到，我先核对 influencers 现在传 id 的逻辑，改成 hichat_id 后回群汇报。
  - 模拟 群 +194s：@Arthur.a 「Arthur（Go 后端）答复」这边卡住了，需要你们帮忙： - 他人 hichat_id 没有来源：他人主页的入口（社区帖子 author.uid、搜索结果、首页推荐 anchor_id、关注列表、节目卡）都只有 live uid。bbsv2 `member/otherInfo` 的返回里没有 hichat_id 字段 - php Me
  - 模拟 私 +58s：🛠 开始做：Arthur（Go 后端）答复：uat 上 go-api /api/b2b/influencers/{id} 的路径参数应传 hichat_id（例：登录回 u（Falive产研技术沟通群）
  - 模拟 私 +194s：⏸ 停下来了（Falive产研技术沟通群）：问题属实：他人主页把路由 `/user/<live uid>` 直接当成 Go `GET /api/b2b/influencers/{memberId}` 的 memberId（src/modules/user/data/queries.ts 的 requestInfluencerProfile / fetchOt

### ep-1030-b864a1 C6 om_x100b61709e7ea8a0fff406216b67dde（tech-group，at_bot）

> HQUCWilliam.m：@Aven.Bot OL 再复测下

- 差异：seen；归因：模拟偏差（能修）（组外 case 从历史里藏了）——falive 看到的「群里之前的消息」里有 aven 10:08 那条长消息（别组的 case），模拟把组外 case 整条藏了、窗口往前多吃。已修（hiddenAsHistory：组外触发照列当历史、轮询预先记 seen）。结论 same。
- 路径 falive：api_reply/done（received ack started anchored）；模拟：api_reply/done（received ack started anchored）（模拟任务 done）（falive 审计 done）
- 大意：same——A 对这条的结论是 OL 的 /hc-ws 复测通过：握手回 101，hichat 回了鉴权帧，转发已经通了；登录后的行情推送这次没测到。B 的结论也是 OL 握手 101、收到认证帧、转发已通，登录后的推送同样没验证。群里写的「没通 1 项」指的就是这项没验证的登录后推送，两边判断一致。
- 上下文：只 falive 「Aven.tong（10-30 10:08）：## 一、uat 的问题」 「### U1【阻塞】服务端渲染回源被前台网关按 IP 限频，页面约一半回 503」 「- **现象**：uat 连续请求 `/hc`、`/hc/news`、`/hc/lives`，约一半回 503（服务端渲」 「- **原因（已实测）**：前台网关按来源 IP 限频——同一 IP 并发 6–8 个请求就开始回 HTTP 429 `」 「- **要什么**（二选一）：」 「1. 给 uat 部署机的出口 IP 在前台网关免限频（或单独放宽）；」 「2. 给 uat 的服务端内网回源地址（php 与社区 bbsv2 都要），前端在 `build/service-hos」 「- **影响**：直播间、新闻、帖子、首页的服务端首屏时有时无——分享出去没有标题和卡片图，搜索引擎看到 503 不收录」；只模拟 
  - falive 群 +59s：@HQUCWilliam.m 好的，我这就去 OL 测 wss://www.falive.com/hc-ws 握手和行情推送，测完回你。
  - falive 群 +280s：@HQUCWilliam.m ✅ @William @Ache OL 的 /hc-ws 复测通过：11:55 握手成功，hichat 回了鉴权帧，转发已经通了。 - ✅ 通了 OL /hc-ws 握手：带不带斜杠都回 101，hichat 回了鉴权帧，和直连 hichat 一样，转发已经通了 详细见：[https://qfglxo2m3dc.sg.larks
  - falive 私 +61s：🛠 开始做：William（live php 后端）引用 bot 11:26 的 OL 行情 ws 说明卡片（wss://www.falive.com/hc-ws → ng（Falive产研技术沟通群）
  - falive 私 +281s：✅ 按 William 的要求复测了 OL 的行情 ws：11:55 连 www.falive.com/hc-ws，带不带结尾斜杠都握手成功，hichat 回了鉴权帧，结果和直连 hichat 上游一样，转发已经通了（11:23 那次还落在首页）。答复已存档，对接文档里 N2 标成已通；改动在本地分支 lark/falive-16b67dde。登录后的行情推
  - 模拟 群 +18s：@HQUCWilliam.m 好的，我这就去 online 复测 /hc-ws 握手和行情推送，测完回结果。
  - 模拟 群 +167s：@HQUCWilliam.m @Eric.ea OL 行情 ws（/hc-ws）复测：通了 2 项，没通 1 项 完整内容：https://sim.local/docx/simdoc00029
  - 模拟 私 +18s：🛠 开始做：William（live php 后端）引用了 bot 那张「OL 行情 ws 走 wss://www.falive.com/hc-ws，再由 nginx 转到（Falive产研技术沟通群）
  - 模拟 私 +167s：✅ OL 的行情 WS 又测了一遍：wss://www.falive.com/hc-ws 握手回 101，连上后收到 hichat 的认证帧，说明 nginx 已经转到 4ees1.xyz 的行情推送服务；uat 对照测也一样通。登录后行情实时跳动这次还是没验，bot 没有登录账号，要 eric 或测试同学用登录账号确认。前端代码没改，只补了复测记录。 分支

